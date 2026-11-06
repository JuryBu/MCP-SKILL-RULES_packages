import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan63-agy-budget-"));
const originalHome = os.homedir;
const environment = { ...process.env };
os.homedir = () => root;
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = path.join(root, "active");
process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = path.join(root, "implicit");
process.env.MEMORY_STORE_LOCAL_PB_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("hex");
fs.mkdirSync(path.join(root, "active"));
fs.mkdirSync(path.join(root, "implicit"));
const key = Buffer.from(process.env.MEMORY_STORE_LOCAL_PB_KEY, "hex");
const bridge = await import("../src/conversation-bridge.js");
const adapters = await import("../src/conversation-source-adapters.js");
const binary = await import("../src/conversation-host-binary.js");
const ls = await import("../src/ls-client.js");
const registry = await import("../src/ls-registry.js");
registry.__setRegistryPathForTest(path.join(root, "synthetic-ls-registry.json"));
ls.__disableLsForTest();
ls.__setConvCacheDirForTest(path.join(root, "ls-cache"));

function varint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do {
        const octet = remaining % 128;
        remaining = Math.floor(remaining / 128);
        bytes.push(remaining ? octet | 128 : octet);
    } while (remaining);
    return Buffer.from(bytes);
}

function field(fieldNumber: number, content: Buffer | string): Buffer {
    const bytes = Buffer.from(content);
    return Buffer.concat([varint(fieldNumber * 8 + 2), varint(bytes.length), bytes]);
}

function writePb(id: string, count = 48, kind: "active" | "implicit" = "active", changedStep = -1): string {
    const trajectory = Buffer.concat([field(1, id), ...Array.from({ length: count }, (_, index) => field(2, Buffer.concat([
        field(19, field(1, `Synthetic question ${index}`)),
        field(20, field(1, `${index === changedStep ? "changed" : "initial"} answer ${index}`)),
    ])))]);
    const plaintext = kind === "implicit" ? field(1, trajectory) : trajectory;
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const filename = path.join(root, kind, `${id}.pb`);
    fs.writeFileSync(filename, encrypted);
    return filename;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), "synthetic server should observe the client socket being closed");
}

async function withServer(run: (context: { calls: string[]; sockets: Set<Socket>; respond: (method: string, payload: any, response: http.ServerResponse) => void }) => Promise<void>): Promise<void> {
    const calls: string[] = [];
    const sockets = new Set<Socket>();
    const context = { calls, sockets, respond: (_method: string, _payload: any, response: http.ServerResponse) => { response.end("{}"); } };
    const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const method = request.url!.split("/").at(-1)!;
        calls.push(method);
        context.respond(method, JSON.parse(Buffer.concat(chunks).toString("utf8")), response);
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    ls.__setParentLsForTest({ info: { pid: 63063, csrfToken: "synthetic-csrf", workspaceId: "synthetic-workspace", ports: [port] }, port });
    try { await run(context); }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        ls.__disableLsForTest();
    }
}

function summary(response: http.ServerResponse, id: string, count: number, version = "v1"): void {
    response.end(JSON.stringify({ trajectorySummaries: { [id]: { stepCount: count, lastModifiedTime: version } } }));
}

function hang(response: http.ServerResponse): void {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"steps":[');
    const timer = setInterval(() => response.write(" "), 10);
    response.on("close", () => clearInterval(timer));
}

test("auto locate returns an authenticated PB window without starting a hanging LS or publishing a full cache", async () => {
    const id = "synthetic-pb-window";
    const filename = writePb(id);
    const local = adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 4 } })!;
    assert.equal(local.selected.metrics?.decodedSteps, 4);
    assert.equal(local.selected.metrics?.authenticatedBytes, fs.statSync(filename).size);
    await withServer(async context => {
        context.respond = (_method, _payload, response) => hang(response);
        const started = performance.now();
        const loaded = await bridge.loadConversationData("antigravity", id, { source: "auto", includeRounds: false,
            locateWindow: { tailSteps: 4 }, sourceReadBudget: { maxBytes: 64 * 1024, deadlineMs: Date.now() + 1000 } });
        assert.ok(loaded);
        assert.equal(loaded.rounds.length, 4);
        assert.equal(loaded.rounds[0].userMessage, "Synthetic question 44");
        assert.equal(loaded.totalSteps, 48);
        assert.equal(loaded.cacheGeneration, undefined);
        assert.equal(loaded.sourcePartial, true);
        assert.deepEqual(loaded.sourceCoverage, { unit: "step", startStep: 44, endStepExclusive: 48, totalSteps: 48,
            complete: false, encryptedEnvelopeVerified: true, source: "local", roundNumbering: "relative", comparison: "deferred" });
        assert.ok(loaded.sourceRevision?.revision);
        assert.ok(loaded.cacheFingerprint?.revision);
        assert.deepEqual(context.calls, []);
        console.log(`PB_WINDOW_METRICS ${JSON.stringify({ elapsedMs: performance.now() - started, rounds: loaded.rounds.length,
            decodedSteps: local.selected.metrics?.decodedSteps, authenticatedBytes: local.selected.metrics?.authenticatedBytes, coverage: loaded.sourceCoverage })}`);
    });
});

test("PB byte preflight rejects before opening encrypted contents", () => {
    const id = "synthetic-preflight";
    const filename = writePb(id);
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === filename) reads++;
        return originalRead(...args);
    }) as typeof fs.readFileSync;
    try {
        assert.throws(() => adapters.loadLocalPbConversation("antigravity", id, { maxBytes: fs.statSync(filename).size - 1, stepRange: { tailSteps: 1 } }), /exceeds maxBytes/u);
        assert.equal(reads, 0);
    } finally { fs.readFileSync = originalRead; }
});

test("PB cancellation and deadline stop before and within prepared projection", () => {
    const id = "synthetic-pb-cancel";
    writePb(id);
    assert.throws(() => adapters.loadLocalPbConversation("antigravity", id, { deadlineMs: Date.now() - 1 }), error => (error as { code?: string }).code === "DEADLINE_EXCEEDED");
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => adapters.loadLocalPbConversation("antigravity", id, { signal: controller.signal }), error => (error as { code?: string }).code === "CANCELLED");
    let checks = 0;
    assert.throws(() => adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 32 }, isCancelled: () => ++checks > 12 }), error => (error as { code?: string }).code === "CANCELLED");
    assert.ok(checks > 12);
});

test("PB window preserves conflicts outside the requested tail", () => {
    const id = "synthetic-pb-conflict";
    writePb(id);
    writePb(id, 48, "implicit", 0);
    assert.throws(() => adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 2 } }), /contents conflict/u);
});

test("PB window revisions change for same-size rewritten sources and equal candidates retain a valid window", () => {
    const id = "synthetic-pb-version";
    const filename = writePb(id);
    const before = adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 2 } })!;
    const stat = fs.statSync(filename);
    writePb(id, 48, "active", 47);
    fs.utimesSync(filename, stat.atime, stat.mtime);
    const afterRead = adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 2 } })!;
    assert.equal(fs.statSync(filename).size, stat.size);
    assert.notEqual(before.fingerprint.revision, afterRead.fingerprint.revision);
    writePb(id, 48, "implicit", 47);
    const equal = adapters.loadLocalPbConversation("antigravity", id, { stepRange: { tailSteps: 2 } })!;
    assert.equal(equal.rounds.length, 2);
    assert.equal(equal.coverage?.startStep, 46);
    const changingId = "synthetic-pb-changing-during-read";
    writePb(changingId);
    let checks = 0;
    assert.throws(() => adapters.loadLocalPbConversation("antigravity", changingId, { stepRange: { tailSteps: 16 }, isCancelled: () => {
        if (++checks === 10) writePb(changingId, 48, "active", 47);
        return false;
    } }), /source changed during projection/u);
});

test("default local bridge remains a complete cached fetch without a locate window", async () => {
    const id = "synthetic-default-full";
    writePb(id);
    const loaded = await bridge.loadConversationData("antigravity", id, { source: "local", refresh: true });
    assert.ok(loaded);
    assert.equal(loaded.rounds.length, 48);
    assert.equal(loaded.sourceCoverage, undefined);
    assert.equal(loaded.sourcePartial, false);
    assert.ok(loaded.cacheGeneration);
});

test("locate windows cannot be published through cache or unrelated host paths", async () => {
    await assert.rejects(bridge.loadConversationData("antigravity", "synthetic-default-full", { source: "cache", locateWindow: { tailSteps: 1 } }), /locateWindow requires/u);
    await assert.rejects(bridge.loadConversationData("codex", "synthetic-no-codex-read", { source: "local", locateWindow: { tailSteps: 1 } }), /locateWindow requires/u);
});

test("full budgeted auto still compares PB and LS and rejects conflicting content", async () => {
    const id = "synthetic-full-comparison";
    writePb(id, 1);
    for (const conflict of [false, true]) {
        await withServer(async context => {
            context.respond = (method, _payload, response) => method === "GetAllCascadeTrajectories" ? summary(response, id, 2)
                : response.end(JSON.stringify({ steps: [
                    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: conflict ? "Conflicting synthetic question" : "Synthetic question 0" } },
                    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "initial answer 0" } },
                ] }));
            const request = bridge.loadConversationData("antigravity", id, { source: "auto", sourceReadBudget: { maxBytes: 8192, deadlineMs: Date.now() + 1000 } });
            if (conflict) await assert.rejects(request, /内容冲突/u);
            else {
                const loaded = await request;
                assert.equal(loaded?.sourcePartial, false);
                assert.equal(loaded?.sourceCoverage?.comparison, "complete");
                assert.equal(loaded?.sourceCoverage?.complete, true);
                assert.ok(loaded?.sourceDiagnostics?.some(value => value.includes("来源比较: equal")));
            }
        });
    }
});

test("failed PB authentication reserves its bytes before the LS fallback", async () => {
    const id = "synthetic-shared-byte-budget";
    const filename = writePb(id, 4);
    const damaged = fs.readFileSync(filename);
    damaged[damaged.length - 1] ^= 1;
    fs.writeFileSync(filename, damaged);
    await withServer(async context => {
        context.respond = (method, _payload, response) => method === "GetAllCascadeTrajectories" ? summary(response, id, 2)
            : response.end(JSON.stringify({ steps: [{ type: "STEP", text: "x".repeat(600) }, { type: "STEP" }] }));
        await assert.rejects(bridge.loadConversationData("antigravity", id, { source: "auto", locateWindow: { tailSteps: 2 },
            sourceReadBudget: { maxBytes: damaged.length + 350, deadlineMs: Date.now() + 1000 } }), error => (error as { code?: string }).code === "PAYLOAD_TOO_LARGE");
        assert.equal(context.calls.length, 2);
    });
});

test("binary reader rejects stat-confirmed oversize candidates before hashing", async () => {
    const filename = writePb("synthetic-binary-preflight");
    const originalOpen = fsPromises.open;
    let opens = 0;
    fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
        if (String(args[0]) === filename) opens++;
        return originalOpen(...args);
    }) as typeof fsPromises.open;
    try {
        const reader = binary.createBinaryHostReader("antigravity", { maxSourceBytes: 8, pbCandidates: () => [{ kind: "active", filePath: filename }] });
        await assert.rejects(reader.read({ source: "antigravity", id: "synthetic-binary-preflight", title: "synthetic", workspace: "" }, { lastRounds: 1 }, {}), /exceeds maxSourceBytes/u);
        assert.equal(opens, 0);
    } finally { fsPromises.open = originalOpen; }
});

test("LS deadline destroys an actively streaming request rather than only ignoring its result", async () => {
    await withServer(async context => {
        context.respond = (method, _payload, response) => method === "GetAllCascadeTrajectories" ? summary(response, "synthetic-ls-deadline", 4) : hang(response);
        const started = performance.now();
        await assert.rejects(ls.fetchTrajectory("synthetic-ls-deadline", false, { deadlineMs: Date.now() + 120 }), error => (error as { code?: string }).code === "DEADLINE_EXCEEDED");
        await waitUntil(() => context.sockets.size === 0);
        assert.ok(context.calls.includes("GetCascadeTrajectorySteps"));
        assert.equal(context.calls.length, 2);
        console.log(`LS_DEADLINE_METRICS ${JSON.stringify({ elapsedMs: performance.now() - started, calls: context.calls, remainingSockets: context.sockets.size })}`);
    });
});

test("LS AbortSignal and callback cancellation close actual requests and allow the next request", async () => {
    for (const mode of ["signal", "callback"] as const) {
        await withServer(async context => {
            const controller = new AbortController();
            let cancelled = false;
            context.respond = (method, _payload, response) => {
                if (method === "GetAllCascadeTrajectories") summary(response, "synthetic-ls-cancel", 2);
                else { hang(response); setTimeout(() => { cancelled = true; controller.abort(); }, 20); }
            };
            await assert.rejects(ls.fetchTrajectory("synthetic-ls-cancel", false, { deadlineMs: Date.now() + 1000,
                ...(mode === "signal" ? { signal: controller.signal } : { isCancelled: () => cancelled }) }), error => (error as { code?: string }).code === "CANCELLED");
            await waitUntil(() => context.sockets.size === 0);
            context.respond = (method, _payload, response) => method === "GetAllCascadeTrajectories"
                ? summary(response, "synthetic-ls-cancel", 2) : response.end(JSON.stringify({ steps: [{ type: "STEP", label: "first" }, { type: "STEP", label: "second" }] }));
            const next = await ls.fetchTrajectory("synthetic-ls-cancel", true, { deadlineMs: Date.now() + 1000 });
            assert.equal(next?.trajectory.steps.length, 2);
            assert.equal(next?.coverage?.complete, true);
            console.log(`LS_CANCEL_METRICS ${JSON.stringify({ mode, nextRequestComplete: next?.coverage?.complete })}`);
        });
    }
});

test("bridge retains both cancellation callbacks while an LS request is active", async () => {
    await withServer(async context => {
        let cancelled = false;
        context.respond = (method, _payload, response) => {
            if (method === "GetAllCascadeTrajectories") summary(response, "synthetic-bridge-cancel", 2);
            else { hang(response); setTimeout(() => { cancelled = true; }, 20); }
        };
        await assert.rejects(bridge.loadConversationData("antigravity", "synthetic-bridge-cancel", { source: "ls", isCancelled: () => false,
            sourceReadBudget: { isCancelled: () => cancelled, deadlineMs: Date.now() + 1000 } }), error => (error as { code?: string }).code === "CANCELLED");
        await waitUntil(() => context.sockets.size === 0);
    });
});

test("LS window uses the requested offset, validates its version and never writes a complete cache", async () => {
    await withServer(async context => {
        const offsets: number[] = [];
        context.respond = (method, payload, response) => {
            if (method === "GetAllCascadeTrajectories") summary(response, "synthetic-ls-window", 100);
            else { offsets.push(payload.stepOffset); response.end(JSON.stringify({ steps: Array.from({ length: 100 - payload.stepOffset }, (_, index) => ({ type: "STEP", ordinal: payload.stepOffset + index })) })); }
        };
        const loaded = await ls.fetchTrajectory("synthetic-ls-window", true, { stepRange: { tailSteps: 3 }, deadlineMs: Date.now() + 1000, maxBytes: 4096 });
        assert.deepEqual(offsets, [97]);
        assert.equal(loaded?.trajectory.steps.length, 3);
        assert.deepEqual(loaded?.coverage, { unit: "step", startStep: 97, endStepExclusive: 100, totalSteps: 100, complete: false });
        assert.ok(loaded?.sourceRevision);
        assert.equal(fs.existsSync(path.join(root, "ls-cache", "conv_synthetic-ls-window.json")), false);
    });
});

test("LS rejects a changed version, incomplete pages and response-byte exhaustion", async () => {
    for (const mode of ["version", "incomplete", "bytes"] as const) {
        await withServer(async context => {
            let summaries = 0;
            context.respond = (method, _payload, response) => {
                if (method === "GetAllCascadeTrajectories") summary(response, "synthetic-ls-invalid", 2, ++summaries > 1 && mode === "version" ? "v2" : "v1");
                else response.end(JSON.stringify({ steps: mode === "incomplete" ? [] : [{ type: "STEP", text: mode === "bytes" ? "x".repeat(4096) : "a" }, { type: "STEP", text: "b" }] }));
            };
            await assert.rejects(ls.fetchTrajectory("synthetic-ls-invalid", true, { deadlineMs: Date.now() + 1000, maxBytes: mode === "bytes" ? 512 : 8192 }),
                mode === "version" ? /LS_SOURCE_CHANGED/u : mode === "incomplete" ? /LS_INCOMPLETE/u : error => (error as { code?: string }).code === "PAYLOAD_TOO_LARGE");
        });
    }
});

test("LS discovery deadline stops a real synthetic child process", async () => {
    const originalExecFile = childProcess.execFile;
    let child: childProcess.ChildProcess | undefined;
    let childClosed = false;
    ls.__resetLsTestOverridesForTest();
    childProcess.execFile = ((command: string, _args: string[], options: any, callback: any) => {
        assert.equal(command, "powershell");
        assert.ok(options.signal instanceof AbortSignal);
        child = originalExecFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, callback);
        child.on("close", () => { childClosed = true; });
        return child;
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    try {
        await assert.rejects(ls.fetchTrajectory("synthetic-discovery-deadline", false, { deadlineMs: Date.now() + 150 }), error => (error as { code?: string }).code === "DEADLINE_EXCEEDED");
        await waitUntil(() => childClosed);
        assert.equal(child?.killed, true);
        console.log(`LS_DISCOVERY_CANCEL_METRICS ${JSON.stringify({ childClosed, killed: child?.killed })}`);
    } finally {
        childProcess.execFile = originalExecFile;
        syncBuiltinESMExports();
        ls.__disableLsForTest();
    }
});

after(() => {
    ls.__resetLsTestOverridesForTest();
    os.homedir = originalHome;
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
    console.log("CLEANED_SYNTHETIC_FIXTURE");
});
