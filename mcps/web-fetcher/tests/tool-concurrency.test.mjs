import assert from "node:assert/strict";
import test, { after } from "node:test";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolConcurrency, installToolConcurrency, classifyToolRequest } from "../src/tool-concurrency.ts";
import { SessionManager, sessionManager } from "../src/session.ts";
import { OperationGate, getRequestContext, getActiveRequestCount, remainingRequestMs, runWithRequestContext, withRequestStage, withSuspendedRequestDeadline, throwIfRequestExpired } from "../src/request-context.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const imageResult = { content: [{ type: "text", text: "ok" }, { type: "image", mimeType: "image/png", data: "fixture" }] };
const fakePage = () => ({ closed: false, url: () => "https://fixture.invalid", isClosed() { return this.closed; }, async close() { this.closed = true; } });
after(() => sessionManager.closeAll());

test("request owner, viewport, monotonic deadline and phase timings are isolated", async () => {
    await Promise.all(["first", "second"].map(ownerId => runWithRequestContext({ ownerId, timeoutMs: 1000, viewport: { width: 390, height: 844 } }, async () => {
        await withRequestStage("fixture", tick);
        assert.equal(getRequestContext().ownerId, ownerId);
        assert.deepEqual(getRequestContext().viewport, { width: 390, height: 844 });
        assert.ok(getRequestContext().deadline > performance.now());
        assert.equal(getRequestContext().timings[0].stage, "fixture");
    })));
    assert.equal(getRequestContext(), undefined);
    assert.equal(getActiveRequestCount(), 0);
});

test("manual waiting suspends ordinary deadline; login receives at least 600 seconds", async () => {
    await runWithRequestContext({ timeoutMs: 40 }, async () => {
        await withSuspendedRequestDeadline(async () => { await sleep(65); assert.ok(remainingRequestMs() > 500_000); });
        throwIfRequestExpired();
        assert.ok(remainingRequestMs() <= 40);
    });
    const controller = new ToolConcurrency();
    await controller.run("web_login_browser", { timeout: 1 }, async () => { assert.ok(remainingRequestMs() >= 600_000); return imageResult; });
});

test("ordinary bound and image bound hold while control and polling remain available", async () => {
    const controller = new ToolConcurrency({ maxActive: 2, maxHeavy: 1 });
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const action = async () => { peak = Math.max(peak, ++running); await gate.promise; running--; return imageResult; };
    const first = controller.run("web_fetch_screenshot", {}, action);
    const second = controller.run("web_fetch_screenshot", {}, action);
    const third = controller.run("web_fetch_page", {}, action);
    await tick();
    assert.equal(controller.getStats().normal.active, 2);
    assert.equal(controller.getStats().heavy.active, 1);
    assert.equal(controller.getStats().heavy.queued, 1);
    assert.equal(await controller.run("web_list_sessions", {}, async () => "control"), "control");
    assert.equal(await controller.run("web_inspect", { taskId: "existing" }, async () => "poll"), "poll");
    gate.resolve();
    await Promise.all([first, second, third]);
    assert.equal(peak, 2);
    assert.equal(controller.getStats().normal.active, 0);
});

test("same-page waiting happens before operation permits, leaving other pages runnable", async () => {
    const manager = new SessionManager();
    const shared = fakePage();
    const first = manager.registerPage(shared, "owner");
    const alias = manager.registerPage(shared, "owner");
    const other = manager.registerPage(fakePage(), "owner");
    const controller = new ToolConcurrency({ maxActive: 2, sessions: manager });
    const gate = deferred();
    const events = [];
    const active = controller.run("web_pipeline", { sessionId: first, ownerId: "owner" }, async () => { events.push("active"); await gate.promise; return imageResult; });
    await tick();
    const queued = [1, 2, 3].map(() => controller.run("web_interact", { sessionId: alias, ownerId: "owner", action: "click" }, async () => { events.push("queued"); return imageResult; }));
    await controller.run("web_interact", { sessionId: other, ownerId: "owner", action: "click" }, async () => { events.push("other"); return imageResult; });
    assert.deepEqual(events, ["active", "other"]);
    assert.equal(controller.getStats().normal.active, 1);
    gate.resolve();
    await Promise.all([active, ...queued]);
    await manager.closeAll();
});

test("deadline/abort during handler do not release capacity until actual settlement; image survives", async () => {
    for (const cancel of [false, true]) {
        const controller = new ToolConcurrency({ maxActive: 1, defaultTimeoutMs: cancel ? 1000 : 20 });
        const gate = deferred();
        const abort = new AbortController();
        let nextStarted = false;
        const active = controller.run("web_fetch_page", { timeout: cancel ? 1000 : 20 }, async () => { await gate.promise; return imageResult; }, { signal: abort.signal });
        await tick();
        const queued = controller.run("web_fetch_page", { timeout: 1000 }, async () => { nextStarted = true; return imageResult; });
        if (cancel) abort.abort(); else await sleep(30);
        assert.equal(nextStarted, false);
        assert.equal(controller.getStats().normal.active, 1);
        gate.resolve();
        const result = await active;
        await queued;
        assert.equal(result.isError, true);
        assert.equal(result._meta.webFetcherConcurrency.outcome, "unknown");
        assert.deepEqual(result.content[1], imageResult.content[1]);
        assert.equal(controller.getStats().normal.active, 0);
    }
});

test("queue cancellation, length and deadline reject before starting", async () => {
    const controller = new ToolConcurrency({ maxActive: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    const gate = deferred();
    const active = controller.run("web_fetch_page", {}, async () => { await gate.promise; return imageResult; });
    await tick();
    const abort = new AbortController();
    const queued = controller.run("web_fetch_page", {}, async () => assert.fail(), { signal: abort.signal });
    await tick();
    const full = await controller.run("web_fetch_page", {}, async () => assert.fail());
    assert.equal(full._meta.webFetcherConcurrency.code, "queue_full");
    abort.abort();
    assert.equal((await queued)._meta.webFetcherConcurrency.mayHaveStarted, false);
    const timed = await controller.run("web_fetch_page", { timeout: 10 }, async () => assert.fail());
    assert.equal(timed._meta.webFetcherConcurrency.code, "admission_timeout");
    assert.equal(controller.getStats().normal.queued, 0);
    gate.resolve();
    await active;
});

test('legacy navigation timeout does not truncate successful recording or post-navigation work', async () => {
    const controller = new ToolConcurrency();
    for (const name of ['web_record_video', 'web_fetch_screenshot']) {
        const result = await controller.run(name, { timeout: 10, duration: 2 }, async () => {
            const budget = getRequestContext().deadline - performance.now();
            assert.ok(budget > 3000);
            await sleep(20);
            return imageResult;
        });
        assert.equal(result.isError, undefined);
        assert.deepEqual(result.content, imageResult.content);
    }
});

test("gate rechecks an absolute deadline when delayed timer has not fired", async () => {
    const gate = new OperationGate(1, 2);
    const release = await gate.acquire();
    const queued = assert.rejects(gate.acquire({ deadline: performance.now() + 5 }), /admission_timeout/);
    const until = performance.now() + 15;
    while (performance.now() < until) { }
    release();
    release();
    await queued;
    assert.equal(gate.getStats().active, 0);
    assert.equal(gate.getStats().queued, 0);
});

test("registerTool and legacy tool wrappers preserve schema, annotations, chain and native content", async () => {
    const registrations = new Map();
    const server = {
        registerTool(name, config, handler) { registrations.set(name, { config, handler }); },
        tool(name, description, schema, handler) { registrations.set(name, { config: { description, inputSchema: schema }, handler }); },
    };
    const controller = installToolConcurrency(server);
    assert.equal(installToolConcurrency(server), controller);
    const existingOwner = z.string().optional();
    server.registerTool("web_fetch_screenshot", { inputSchema: { chain: z.string().optional(), ownerId: existingOwner }, annotations: { readOnlyHint: true } }, async args => {
        assert.equal(args.chain, "codex");
        assert.equal(getRequestContext().ownerId, "owner");
        assert.deepEqual(getRequestContext().viewport, { width: 320, height: 640 });
        return imageResult;
    });
    const current = registrations.get("web_fetch_screenshot");
    assert.equal(current.config.inputSchema.ownerId, existingOwner);
    assert.equal(current.config.annotations.readOnlyHint, true);
    const currentResult = await current.handler({ chain: "codex", ownerId: "owner", viewport: { width: 320, height: 640 } });
    assert.deepEqual(currentResult.content, imageResult.content);
    assert.ok(currentResult._meta.webFetcherTiming.stages.some(stage => stage.stage === 'handler'));
    server.tool("legacy", "description", {}, async () => imageResult);
    const legacy = registrations.get("legacy");
    assert.ok(legacy.config.inputSchema.ownerId);
    assert.deepEqual((await legacy.handler({})).content, imageResult.content);
    assert.equal(classifyToolRequest("web_inspect", { taskId: "x" }), "poll");
});

test("real SDK accepts wrapped legacy and registerTool definitions without starting a transport", async () => {
    const server = new McpServer({ name: "isolated-concurrency-test", version: "1" });
    installToolConcurrency(server);
    server.registerTool("current", { inputSchema: { mode: z.string().optional() } }, async () => imageResult);
    server.tool("legacy", "description", { mode: z.string().optional() }, async () => imageResult);
    assert.ok(server._registeredTools.current.inputSchema.shape.ownerId);
    assert.ok(server._registeredTools.legacy.inputSchema.shape.ownerId);
    assert.deepEqual((await server._registeredTools.current.handler({}, {})).content, imageResult.content);
    assert.deepEqual((await server._registeredTools.legacy.handler({}, {})).content, imageResult.content);
    await server.close();
});

test("owner queue rotates instead of letting one owner take each released permit", async () => {
    const gate = new OperationGate(1, 4);
    const first = await gate.acquire({ ownerId: "busy" });
    const order = [];
    const waiting = ["busy", "busy", "other"].map(async ownerId => {
        const release = await gate.acquire({ ownerId });
        order.push(ownerId);
        release();
    });
    first();
    await Promise.all(waiting);
    assert.deepEqual(order, ["other", "busy", "busy"]);
});

test("mixed multi-owner burst stays bounded and completely drains after failures", async () => {
    const controller = new ToolConcurrency({ maxActive: 6, maxHeavy: 2, maxQueue: 128 });
    let active = 0;
    let heavyActive = 0;
    let peak = 0;
    let heavyPeak = 0;
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, index) => {
        const heavy = index % 3 === 0;
        return controller.run(heavy ? "web_fetch_screenshot" : "web_fetch_page", { ownerId: `owner-${index % 5}` }, async () => {
            active++;
            if (heavy) heavyActive++;
            peak = Math.max(peak, active);
            heavyPeak = Math.max(heavyPeak, heavyActive);
            try {
                await tick();
                if (index % 7 === 0) throw new Error("synthetic handler failure");
                return imageResult;
            } finally {
                active--;
                if (heavy) heavyActive--;
            }
        });
    }));
    assert.ok(peak <= 6 && peak >= 2);
    assert.ok(heavyPeak <= 2);
    assert.equal(results.filter(result => result.status === "rejected").length, 9);
    for (const gate of Object.values(controller.getStats())) {
        assert.equal(gate.active, 0);
        assert.equal(gate.queued, 0);
    }
    assert.equal(getActiveRequestCount(), 0);
});

test("status/cancel remain usable when long polling capacity is full", async () => {
    const controller = new ToolConcurrency({ maxPoll: 1 });
    const gate = deferred();
    const polling = controller.run("web_inspect", { taskId: "existing" }, async () => { await gate.promise; return imageResult; });
    await tick();
    assert.equal(await controller.run("web_close_sessions", {}, async () => "closed"), "closed");
    assert.equal(await controller.run("background_task_cancel", { taskId: "existing" }, async () => "cancelled"), "cancelled");
    assert.equal(await controller.run("web_list_sessions", {}, async () => "listed"), "listed");
    gate.resolve();
    await polling;
});

test("control close bypasses a saturated same-page queue and drains without deadlock", async () => {
    const manager = new SessionManager();
    const target = fakePage();
    const id = manager.registerPage(target, "owner");
    const controller = new ToolConcurrency({ maxActive: 1, sessions: manager });
    const gate = deferred();
    const active = controller.run("web_pipeline", { sessionId: id, ownerId: "owner" }, async () => { await gate.promise; return imageResult; });
    await tick();
    const waiting = Array.from({ length: 4 }, () => controller.run("web_interact", { sessionId: id, ownerId: "owner", action: "click" }, async () => assert.fail()));
    await tick();
    const closing = controller.run("web_interact", { sessionId: id, ownerId: "owner", action: "close" }, async () => manager.close(id, "owner"));
    await tick();
    assert.equal(controller.getStats().normal.active, 1);
    assert.equal(controller.getStats().control.active, 1);
    assert.equal(manager.getOperationStats().queued, 4);
    assert.equal(target.closed, false);
    gate.resolve();
    await active;
    assert.equal(await closing, true);
    const results = await Promise.all(waiting);
    assert.ok(results.every(result => result.isError && result._meta.webFetcherConcurrency.mayHaveStarted === false));
    assert.equal(target.closed, true);
    assert.equal(manager.getOperationStats().active, 0);
    assert.equal(manager.getOperationStats().queued, 0);
    await manager.closeAll();
});
