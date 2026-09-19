import assert from "node:assert/strict";
import test, { after } from "node:test";
import { SessionManager, sessionManager } from "../src/session.ts";
import { runWithRequestContext } from "../src/request-context.ts";
import { browserManager } from "../src/browser.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function page() {
    return { closed: false, closes: 0, url: () => "https://fixture.invalid", isClosed() { return this.closed; }, async close() { this.closes++; this.closed = true; } };
}
after(() => sessionManager.closeAll());

test("different pages run concurrently; aliases of one actual page serialize", async () => {
    const manager = new SessionManager();
    const shared = page();
    const first = manager.registerPage(shared, "owner");
    const alias = manager.registerPage(shared, "owner");
    const second = manager.registerPage(page(), "owner");
    const gate = deferred();
    const events = [];
    const firstRun = manager.withOperation(first, "owner", async () => { events.push("first"); await gate.promise; });
    await tick();
    const aliasRun = manager.withOperation(alias, "owner", async () => { events.push("alias"); });
    await manager.withOperation(second, "owner", async () => { events.push("second"); });
    assert.deepEqual(events, ["first", "second"]);
    assert.equal(manager.getOperationStats().queued, 1);
    gate.resolve();
    await Promise.all([firstRun, aliasRun]);
    assert.deepEqual(events, ["first", "second", "alias"]);
    assert.equal(manager.hasBusySessions(), false);
    await manager.closeAll();
    assert.equal(shared.closes, 1);
});

test("owner cannot acquire, get, close or alias another owner's page", async () => {
    const manager = new SessionManager();
    const shared = page();
    const id = manager.registerPage(shared, "owner-a");
    assert.equal(manager.get(id, "owner-b"), null);
    assert.equal(await manager.close(id, "owner-b"), false);
    await assert.rejects(manager.withOperation(id, "owner-b", async () => assert.fail()), /ownerId/);
    assert.throws(() => manager.registerPage(shared, "owner-b"), /owner/);
    await manager.closeAll();
});

test("close waits for real in-flight action and rejects queued actions", async () => {
    const manager = new SessionManager();
    const target = page();
    const id = manager.registerPage(target, "owner");
    const gate = deferred();
    const active = manager.withOperation(id, "owner", async () => gate.promise);
    await tick();
    const queued = assert.rejects(manager.withOperation(id, "owner", async () => assert.fail()), /已关闭/);
    let closed = false;
    const close = manager.close(id, "owner").then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    assert.equal(target.closes, 0);
    gate.resolve();
    await Promise.all([active, queued, close]);
    assert.equal(target.closes, 1);
    assert.equal(manager.list("owner").length, 0);
    await manager.closeAll();
});

test("TTL preserves active and waiting operations then expires an idle page", async () => {
    const manager = new SessionManager({ sessionTimeoutMs: 10 });
    const target = page();
    const id = manager.registerPage(target, "owner");
    const gate = deferred();
    const active = manager.withOperation(id, "owner", async () => gate.promise);
    await tick();
    manager.sessions.get(id).lastAccess = Date.now() - 1000;
    manager.cleanup();
    assert.equal(target.closes, 0);
    gate.resolve();
    await active;
    manager.sessions.get(id).lastAccess = Date.now() - 1000;
    manager.cleanup();
    await tick();
    assert.equal(target.closes, 1);
    await manager.closeAll();
});

test("cancelling a queued operation removes it without touching the running page", async () => {
    const manager = new SessionManager();
    const target = page();
    const id = manager.registerPage(target, "owner");
    const gate = deferred();
    const active = manager.withOperation(id, "owner", async () => gate.promise);
    await tick();
    const controller = new AbortController();
    const queued = assert.rejects(manager.withOperation(id, "owner", async () => assert.fail(), { signal: controller.signal }), /request_cancelled/);
    controller.abort();
    await queued;
    assert.equal(manager.getOperationStats().queued, 0);
    assert.equal(manager.hasBusySessions(), true);
    assert.equal(target.closes, 0);
    gate.resolve();
    await active;
    await manager.closeAll();
});

test("self-close in a pipeline is deferred until action completion without deadlock", async () => {
    const manager = new SessionManager();
    const target = page();
    const id = manager.registerPage(target, "owner");
    await manager.withOperation(id, "owner", async () => {
        assert.equal(await manager.close(id, "owner"), true);
        assert.equal(target.closes, 0);
    });
    assert.equal(target.closes, 1);
    await manager.closeAll();
});

test("newly created session remains leased until its creating request really ends", async () => {
    const manager = new SessionManager();
    const target = page();
    const originalNavigate = browserManager.navigateTo;
    const ready = deferred();
    const finish = deferred();
    let id;
    browserManager.navigateTo = async (_url, options) => {
        assert.deepEqual(options.viewport, { width: 360, height: 720 });
        return target;
    };
    try {
        const creating = runWithRequestContext({ ownerId: "owner" }, async () => {
            id = await manager.create("https://fixture.invalid", { ownerId: "owner", viewport: { width: 360, height: 720 } });
            ready.resolve();
            await finish.promise;
        });
        await ready.promise;
        let used = false;
        const next = manager.withOperation(id, "owner", async () => { used = true; });
        await tick();
        assert.equal(used, false);
        assert.equal(manager.hasBusySessions(), true);
        finish.resolve();
        await Promise.all([creating, next]);
        assert.equal(used, true);
        assert.equal(manager.hasBusySessions(), false);
    } finally {
        browserManager.navigateTo = originalNavigate;
        await manager.closeAll();
    }
});

test("abort immediately after admission still prevents a page action", async () => {
    const manager = new SessionManager();
    const id = manager.registerPage(page(), "owner");
    const controller = new AbortController();
    const pending = assert.rejects(manager.withOperation(id, "owner", async () => assert.fail(), { signal: controller.signal }), /取消/);
    controller.abort();
    await pending;
    assert.equal(manager.getOperationStats().active, 0);
    await manager.closeAll();
});

test("externally closed pages leave no idle lock-state references", async () => {
    const manager = new SessionManager();
    const target = page();
    const id = manager.registerPage(target, "owner");
    await manager.withOperation(id, "owner", async () => {});
    target.closed = true;
    assert.equal(manager.get(id, "owner"), null);
    assert.equal(manager.pageOperations.size, 0);
    await manager.closeAll();
});

test("request-owned pipeline cleanup failure is not reported as success", async () => {
    const manager = new SessionManager();
    const target = page();
    const originalClose = target.close;
    const originalNavigate = browserManager.navigateTo;
    browserManager.navigateTo = async () => target;
    target.close = async () => { throw new Error("synthetic cleanup failure"); };
    try {
        await assert.rejects(runWithRequestContext({ ownerId: "owner" }, async () => {
            const id = await manager.create("https://fixture.invalid", { ownerId: "owner" });
            await manager.close(id, "owner");
        }), /synthetic cleanup failure/);
        assert.equal(manager.list("owner").length, 1);
        assert.equal(manager.hasBusySessions(), false);
    } finally {
        browserManager.navigateTo = originalNavigate;
        target.close = originalClose;
        await manager.closeAll();
    }
});

test("borrowed disconnect/noop sessions never close the user's page", async () => {
    for (const closePolicy of ["disconnect-only", "noop"]) {
        const manager = new SessionManager();
        const target = page();
        const id = manager.registerPage(target, "owner", { ownership: "borrowed", closePolicy });
        const gate = deferred();
        const active = manager.withOperation(id, "owner", async () => gate.promise);
        await tick();
        const closing = manager.closeAllForOwner("owner");
        assert.equal(target.closes, 0);
        gate.resolve();
        await Promise.all([active, closing]);
        assert.equal(target.closes, 0);
        assert.equal(manager.list("owner").length, 0);
        await manager.closeAll();
    }
});

test("close failure preserves the owned session for a later safe retry", async () => {
    const manager = new SessionManager();
    const target = page();
    const originalClose = target.close;
    target.close = async () => { throw new Error("synthetic close failure"); };
    const id = manager.registerPage(target, "owner");
    await assert.rejects(manager.close(id, "owner"), /synthetic/);
    assert.equal(manager.get(id, "owner"), target);
    assert.equal(manager.list("owner").length, 1);
    target.close = originalClose;
    assert.equal(await manager.close(id, "owner"), true);
    await manager.closeAll();
});
