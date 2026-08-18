import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cache = await import("../src/conversation-source-cache.ts");

interface WorkerResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

interface WorkerProcess {
    child: ReturnType<typeof spawn>;
    completed: Promise<WorkerResult>;
}

interface CacheWorkerMessage {
    event: "result";
    pid: number;
    builderRan: boolean;
    cacheState: "hit" | "built" | "stale";
    generation: string;
    snapshot: { builtBy: number };
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-source-cache-process-"));
const dataRoot = path.join(testRoot, "data");
const workerPath = path.join(testRoot, "conversation-source-cache-process-worker.mts");
const cacheModuleUrl = pathToFileURL(path.resolve(process.cwd(), "src", "conversation-source-cache.ts")).href;

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForPath(filePath: string, description: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(10);
    }
}

async function waitForPaths(filePaths: Array<{ path: string; description: string }>): Promise<void> {
    await Promise.all(filePaths.map(item => waitForPath(item.path, item.description)));
}

function writeSignal(directory: string, name: string): void {
    fs.writeFileSync(path.join(directory, name), "", { flag: "wx" });
}

function ensureSignal(directory: string, name: string): void {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
}

function parseWorkerMessage(result: WorkerResult): CacheWorkerMessage {
    assert.equal(result.code, 0, `worker exited unexpectedly: signal=${result.signal}; stderr=${result.stderr}`);
    const line = result.stdout.trim().split(/\r?\n/u).at(-1);
    assert.ok(line, `worker did not report a result: ${result.stderr}`);
    const message = JSON.parse(line) as CacheWorkerMessage;
    assert.equal(message.event, "result");
    return message;
}

function spawnWorker(controlDirectory: string, action: "build" | "crash", workerId: string, key: { source: string; conversationId: string }): WorkerProcess {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, dataRoot, controlDirectory, action, workerId, cacheModuleUrl, JSON.stringify(key)], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const completed = once(child, "close").then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null, stdout, stderr }));
    return { child, completed };
}

function stopWorker(worker: WorkerProcess | undefined): void {
    if (worker?.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
}

function writeWorker(): void {
    fs.writeFileSync(workerPath, `
import fs from "node:fs";
import path from "node:path";

const [dataRoot, controlDirectory, action, workerId, cacheModuleUrl, serializedKey] = process.argv.slice(2);
const cache = await import(cacheModuleUrl);
const key = JSON.parse(serializedKey);
const fingerprint = { path: "process-cache-source.jsonl", size: 1, mtime: "2026-08-04T00:00:00.000Z", revision: "process-v1" };

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const signalPath = name => path.join(controlDirectory, name);
const signal = name => fs.writeFileSync(signalPath(name), "", { flag: "wx" });
const waitFor = async name => {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(signalPath(name))) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for " + name);
        await pause(10);
    }
};

cache.setConversationSourceCacheDataRootForTests(dataRoot);
signal(workerId + ".ready");
await waitFor("start");
signal(workerId + ".requested");
let builderRan = false;
const pending = cache.readOrBuild({
    key,
    fingerprint,
    build: async () => {
        builderRan = true;
        fs.writeFileSync(signalPath("builder.claim"), String(process.pid), { flag: "wx" });
        signal("build-started");
        if (action === "crash") process.exit(86);
        await waitFor("release-build");
        return {
            snapshot: { builtBy: process.pid },
            rounds: [{ roundIndex: 1, text: "built by " + process.pid }],
        };
    },
    getRoundNumber: round => round.roundIndex,
});
signal(workerId + ".pending");
const result = await pending;
console.log(JSON.stringify({
    event: "result",
    pid: process.pid,
    builderRan,
    cacheState: result.cacheState,
    generation: result.generation,
    snapshot: result.snapshot,
}));
`, "utf8");
}

async function testConcurrentProcessesBuildOnce(): Promise<void> {
    const controlDirectory = path.join(testRoot, "concurrent");
    fs.mkdirSync(controlDirectory, { recursive: true });
    const key = { source: "codex", conversationId: "cross-process-build-once" };
    const first = spawnWorker(controlDirectory, "build", "first", key);
    const second = spawnWorker(controlDirectory, "build", "second", key);
    try {
        await waitForPaths([
            { path: path.join(controlDirectory, "first.ready"), description: "first worker readiness" },
            { path: path.join(controlDirectory, "second.ready"), description: "second worker readiness" },
        ]);
        writeSignal(controlDirectory, "start");
        await waitForPaths([
            { path: path.join(controlDirectory, "first.requested"), description: "first cache request" },
            { path: path.join(controlDirectory, "second.requested"), description: "second cache request" },
            { path: path.join(controlDirectory, "first.pending"), description: "first in-flight cache request" },
            { path: path.join(controlDirectory, "second.pending"), description: "second in-flight cache request" },
            { path: path.join(controlDirectory, "build-started"), description: "leased cache build" },
        ]);
        const entryDirectory = cache.getConversationSourceCacheEntryDirectory(key);
        const lockPath = path.join(entryDirectory, "build.lock");
        const staleTime = new Date(Date.now() - 2 * 60_000);
        fs.utimesSync(lockPath, staleTime, staleTime);
        await sleep(250);
        assert.equal(fs.existsSync(lockPath), true, "仍存活的 lease owner 即使心跳时间陈旧也不得被接管");
        writeSignal(controlDirectory, "release-build");
        const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
        const messages = [parseWorkerMessage(firstResult), parseWorkerMessage(secondResult)];
        const builder = messages.find(message => message.builderRan);
        const reuser = messages.find(message => !message.builderRan);
        assert.ok(builder, "exactly one process must enter the cache builder");
        assert.ok(reuser, "the other process must not enter the cache builder");
        assert.equal(messages.filter(message => message.builderRan).length, 1, "cross-process build lease must allow only one builder");
        assert.equal(builder.cacheState, "built");
        assert.equal(reuser.cacheState, "hit", "the losing process must reuse the published cache generation");
        assert.equal(reuser.generation, builder.generation, "both processes must observe the same published generation");
        assert.equal(reuser.snapshot.builtBy, builder.pid, "the reused snapshot must come from the lease holder");
        assert.equal(fs.readFileSync(path.join(controlDirectory, "builder.claim"), "utf8"), String(builder.pid), "only the lease holder may claim the build side effect");
    } finally {
        ensureSignal(controlDirectory, "release-build");
        stopWorker(first);
        stopWorker(second);
    }
}

async function testHardExitStaleLeaseRecovery(): Promise<void> {
    const controlDirectory = path.join(testRoot, "recovery");
    fs.mkdirSync(controlDirectory, { recursive: true });
    const key = { source: "codex", conversationId: "cross-process-stale-lease-recovery" };
    const crashed = spawnWorker(controlDirectory, "crash", "crashed", key);
    try {
        await waitForPath(path.join(controlDirectory, "crashed.ready"), "crash worker readiness");
        writeSignal(controlDirectory, "start");
        const crashedResult = await crashed.completed;
        assert.equal(crashedResult.code, 86, `crash worker should leave its build lease behind: ${crashedResult.stderr}`);
        const entryDirectory = cache.getConversationSourceCacheEntryDirectory(key);
        const lockPath = path.join(entryDirectory, "build.lock");
        assert.ok(fs.existsSync(lockPath), "hard exit during build must leave a durable lease for recovery");
        assert.ok(fs.existsSync(path.join(controlDirectory, "builder.claim")), "crash worker must have entered the builder before exiting");
        const crashedPid = Number(fs.readFileSync(path.join(controlDirectory, "builder.claim"), "utf8"));
        const crashedLease = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token: string };
        const orphanTemporaryPaths = [
            path.join(entryDirectory, `.rounds-build-${crashedPid}-orphan.tmp`),
            path.join(entryDirectory, `.record-projection-build-${crashedPid}-orphan.tmp`),
            path.join(entryDirectory, `.build-lock-${crashedPid}-${crashedLease.token}.tmp`),
            path.join(entryDirectory, `manifest.json.tmp-${crashedPid}-orphan`),
        ];
        const unrelatedTemporaryPath = path.join(entryDirectory, `.rounds-build-${process.pid}-must-remain.tmp`);
        for (const filePath of [...orphanTemporaryPaths, unrelatedTemporaryPath]) fs.writeFileSync(filePath, "orphan");
        fs.rmSync(path.join(controlDirectory, "builder.claim"));
        fs.rmSync(path.join(controlDirectory, "build-started"));
        writeSignal(controlDirectory, "release-build");
        const recoveryStartedAt = Date.now();
        const recovery = spawnWorker(controlDirectory, "build", "recovery", key);
        try {
            await waitForPath(path.join(controlDirectory, "recovery.ready"), "recovery worker readiness");
            const recovered = parseWorkerMessage(await recovery.completed);
            assert.equal(recovered.builderRan, true, "a stale crash lease must be reclaimed by the next builder");
            assert.equal(recovered.cacheState, "built");
            assert.ok(Date.now() - recoveryStartedAt < 5_000, "已确认 owner 进程退出后不应再等待陈旧阈值或请求超时");
            assert.ok(recovered.generation.length > 0, "recovery must publish a generation");
            assert.equal(fs.existsSync(lockPath), false, "recovered builder must release the replacement lease");
            assert.ok(orphanTemporaryPaths.every(filePath => !fs.existsSync(filePath)), "dead lease owner 的缓存构建临时文件必须被定向清理");
            assert.equal(fs.existsSync(unrelatedTemporaryPath), true, "不得清理其他 PID 的临时文件");
            const cached = cache.readCacheOnly<{ builtBy: number }>({ key, expectedFingerprint: { path: "process-cache-source.jsonl", size: 1, mtime: "2026-08-04T00:00:00.000Z", revision: "process-v1" } });
            assert.equal(cached?.generation, recovered.generation, "recovered generation must be readable from another process context");
        } finally {
            stopWorker(recovery);
        }
    } finally {
        ensureSignal(controlDirectory, "release-build");
        stopWorker(crashed);
    }
}

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);
    writeWorker();
    await testConcurrentProcessesBuildOnce();
    await testHardExitStaleLeaseRecovery();
    console.log("✅ conversation-source-cache-process 通过：两 Node 进程仅构建一次、活 owner 陈旧不接管、硬退出 lease 可即时恢复");
} finally {
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(testRoot, { recursive: true, force: true });
}
