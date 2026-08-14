import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const sandboxRoot = path.join(repoRoot, "mcps", "sandbox");
process.env.SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB = "0";
const distRoot = path.join(sandboxRoot, "dist");
const sessionModuleUrl = pathToFileURL(path.join(distRoot, "session-manager.js")).href;
const codexModuleUrl = pathToFileURL(path.join(distRoot, "tools", "codex.js")).href;
const sessionToolModuleUrl = pathToFileURL(path.join(distRoot, "tools", "session.js")).href;
const mcpServerModuleUrl = pathToFileURL(path.join(
    sandboxRoot,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
    "server",
    "mcp.js",
)).href;

const SESSION_ENV_KEYS = [
    "SANDBOX_SESSION_MAX_COUNT",
    "SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB",
    "SANDBOX_SESSION_DEFAULT_MEMORY_MB",
    "SANDBOX_SESSION_IDLE_TIMEOUT_MS",
];

let cleanupSessions = () => undefined;
let cleanupCodex = () => undefined;

function resultText(result) {
    return result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}

function extra(signal = new AbortController().signal) {
    return { signal };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSessionId(text) {
    const match = text.match(/ID:\s*([^\s]+)/u);
    assert.ok(match, `未找到 sessionId: ${text}`);
    return match[1];
}

function parseTaskId(text) {
    const match = text.match(/taskId:\s*([0-9a-f-]+)/iu);
    assert.ok(match, `未找到 taskId: ${text}`);
    return match[1];
}

function probeDefaultSessionLimits() {
    const env = { ...process.env };
    for (const key of SESSION_ENV_KEYS) delete env[key];
    const probe = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `const module = await import(${JSON.stringify(sessionModuleUrl)}); console.log(JSON.stringify(module.getSessionLimits()));`,
        ],
        { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
        maxSessions: 5,
        maxTotalMemoryMB: 1536,
        defaultMemoryMB: 256,
        idleTimeoutMs: 300000,
    });
}

function probeConcurrentSessionAdmission({ maxSessions, maxTotalMemoryMB, maxMemoryMB, requestCount }) {
    const env = {
        ...process.env,
        SANDBOX_SESSION_MAX_COUNT: String(maxSessions),
        SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB: String(maxTotalMemoryMB),
        SANDBOX_SESSION_DEFAULT_MEMORY_MB: String(maxMemoryMB),
        SANDBOX_ADMISSION_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_HARD_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB: "0",
    };
    const probe = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
const sessionManager = await import(${JSON.stringify(sessionModuleUrl)});
try {
    const results = await Promise.all(Array.from(
        { length: ${requestCount} },
        () => sessionManager.createSession("node", process.cwd(), ${maxMemoryMB}, undefined, "concurrent-session-test"),
    ));
    console.log(JSON.stringify({
        successful: results.filter((result) => "session" in result).length,
        errors: results.filter((result) => "error" in result).map((result) => result.error),
        active: sessionManager.getActiveSessionCount(),
    }));
} finally {
    sessionManager.closeAllSessions();
}
`,
        ],
        { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    return JSON.parse(probe.stdout.trim());
}

function testConcurrentSessionAdmission() {
    const countLimited = probeConcurrentSessionAdmission({
        maxSessions: 5,
        maxTotalMemoryMB: 4096,
        maxMemoryMB: 256,
        requestCount: 6,
    });
    assert.equal(countLimited.successful, 5);
    assert.equal(countLimited.active, 5);
    assert.equal(countLimited.errors.length, 1);
    assert.match(countLimited.errors[0], /最大会话数量限制 \(5\)/u);

    const memoryLimited = probeConcurrentSessionAdmission({
        maxSessions: 8,
        maxTotalMemoryMB: 256,
        maxMemoryMB: 256,
        requestCount: 6,
    });
    assert.equal(memoryLimited.successful, 4);
    assert.equal(memoryLimited.active, 4);
    assert.equal(memoryLimited.errors.length, 2);
    for (const error of memoryLimited.errors) {
        assert.match(error, /总内存请求量将超限/u);
    }
    console.log("PASS concurrent session admission: count=5/6, memory=4/6");
}

function testSessionSpawnFailureRecovery() {
    const env = {
        ...process.env,
        SANDBOX_SESSION_MAX_COUNT: "1",
        SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB: "256",
        SANDBOX_ADMISSION_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_HARD_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB: "0",
    };
    const probe = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
const sessionManager = await import(${JSON.stringify(sessionModuleUrl)});
try {
    const failed = await sessionManager.createSession("definitely_missing_interpreter_xyz", process.cwd(), 64, undefined, "spawn-failure-test");
    const recovered = await sessionManager.createSession("node", process.cwd(), 64, undefined, "spawn-failure-test");
    console.log(JSON.stringify({
        failed: "error" in failed && /进程启动失败/u.test(failed.error),
        recovered: "session" in recovered,
        active: sessionManager.getActiveSessionCount(),
    }));
} finally {
    sessionManager.closeAllSessions();
}
`,
        ],
        { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
        failed: true,
        recovered: true,
        active: 1,
    });
    console.log("PASS session spawn failure is handled and reservation recovers");
}

function testIdleSessionRecovery() {
    const resourceModuleUrl = pathToFileURL(path.join(distRoot, "resource-admission-runtime.js")).href;
    const env = {
        ...process.env,
        SANDBOX_SESSION_MAX_COUNT: "1",
        SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB: "256",
        SANDBOX_SESSION_IDLE_TIMEOUT_MS: "1000",
        SANDBOX_ADMISSION_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_HARD_LIMIT_MB: "4096",
        SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB: "0",
    };
    const probe = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
const sessionManager = await import(${JSON.stringify(sessionModuleUrl)});
const resourceAdmission = await import(${JSON.stringify(resourceModuleUrl)});
try {
    const created = await sessionManager.createSession("node", process.cwd(), 64, undefined, "idle-session-test");
    const before = resourceAdmission.getResourceAdmissionState();
    const activeBefore = sessionManager.getActiveSessionCount();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const after = resourceAdmission.getResourceAdmissionState();
    console.log(JSON.stringify({
        created: "session" in created,
        activeBefore,
        reservedBefore: before.activeReservedMB,
        activeAfter: sessionManager.getActiveSessionCount(),
        reservedAfter: after.activeReservedMB,
    }));
} finally {
    sessionManager.closeAllSessions();
}
`,
        ],
        { cwd: repoRoot, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
        created: true,
        activeBefore: 1,
        reservedBefore: 64,
        activeAfter: 0,
        reservedAfter: 0,
    });
    console.log("PASS idle session is reaped and releases its global reservation");
}

async function testSessionLifecycle(McpServer) {
    process.env.SANDBOX_SESSION_MAX_COUNT = "3";
    process.env.SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB = "1024";
    process.env.SANDBOX_SESSION_DEFAULT_MEMORY_MB = "320";
    process.env.SANDBOX_SESSION_IDLE_TIMEOUT_MS = "600000";

    const sessionManager = await import(sessionModuleUrl);
    cleanupSessions = sessionManager.closeAllSessions;
    const { registerSession } = await import(`${sessionToolModuleUrl}?test=${Date.now()}`);
    assert.deepEqual(sessionManager.getSessionLimits(), {
        maxSessions: 3,
        maxTotalMemoryMB: 1024,
        defaultMemoryMB: 320,
        idleTimeoutMs: 600000,
    });

    const server = new McpServer({ name: "session-lifecycle-test", version: "1.0.0" });
    registerSession(server);
    const tool = server._registeredTools.sandbox_session;
    assert.ok(tool);
    assert.equal(tool.inputSchema.safeParse({ action: "exec", timeout: 120000, maxMemoryMB: 1536 }).success, true);
    assert.equal(tool.inputSchema.safeParse({ action: "exec", maxMemoryMB: 2048 }).success, true);
    assert.equal(tool.inputSchema.safeParse({ action: "exec", maxMemoryMB: 4097 }).success, false);

    const ownerId = "session-lifecycle-test";
    const started = await tool.handler({ action: "start", language: "node", ownerId }, extra());
    const startedText = resultText(started);
    const sessionId = parseSessionId(startedText);
    assert.match(startedText, /调度请求: 80MB/u);
    assert.match(startedText, /内存硬上限: 320MB/u);

    const overTotal = await sessionManager.createSession("node", process.cwd(), 1024, undefined, ownerId, undefined, 1024);
    assert.ok("error" in overTotal);
    assert.match(overTotal.error, /总内存请求量将超限/u);
    const secondSession = await sessionManager.createSession("node", process.cwd(), undefined, undefined, ownerId);
    const thirdSession = await sessionManager.createSession("node", process.cwd(), undefined, undefined, ownerId);
    assert.ok("session" in secondSession);
    assert.ok("session" in thirdSession);
    const overCount = await sessionManager.createSession("node", process.cwd(), 16, undefined, ownerId);
    assert.ok("error" in overCount);
    assert.match(overCount.error, /最大会话数量限制 \(3\)/u);
    sessionManager.closeSession(secondSession.session.id);
    sessionManager.closeSession(thirdSession.session.id);

    const firstRun = tool.handler({
        action: "exec",
        sessionId,
        ownerId,
        timeout: 2000,
        code: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350); console.log('first-done')",
    }, extra());
    await delay(30);

    const queuedController = new AbortController();
    const queuedStart = Date.now();
    const queuedRun = tool.handler({
        action: "exec",
        sessionId,
        ownerId,
        timeout: 2000,
        code: "globalThis.__queuedCancelled = true",
    }, extra(queuedController.signal));
    queuedController.abort();
    const queuedText = resultText(await queuedRun);
    assert.ok(Date.now() - queuedStart < 250, `排队取消返回过慢: ${Date.now() - queuedStart}ms`);
    assert.match(queuedText, /排队执行已取消/u);
    await firstRun;

    const queuedProbe = await tool.handler({
        action: "exec",
        sessionId,
        ownerId,
        timeout: 2000,
        code: "console.log(globalThis.__queuedCancelled === undefined)",
    }, extra());
    assert.match(resultText(queuedProbe), /true/u);

    const beforeTiming = await sessionManager.getSessionStatus(sessionId);
    assert.ok(beforeTiming);
    const timingBlocker = sessionManager.execInSession(
        sessionId,
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); console.log('timing-blocker')",
        1000,
        ownerId,
    );
    await delay(20);
    const queuedWithShortExecutionTimeout = sessionManager.execInSession(
        sessionId,
        "globalThis.__startedAfterQueue = true",
        100,
        ownerId,
    );
    await timingBlocker;
    const timingResult = await queuedWithShortExecutionTimeout;
    assert.equal(timingResult.killed, false, JSON.stringify(timingResult));
    const afterTiming = await sessionManager.getSessionStatus(sessionId);
    assert.equal(afterTiming?.execCount, beforeTiming.execCount + 2);

    const runningController = new AbortController();
    const runningStart = Date.now();
    const runningCall = tool.handler({
        action: "exec",
        sessionId,
        ownerId,
        timeout: 10000,
        code: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)",
    }, extra(runningController.signal));
    await delay(50);
    runningController.abort();
    const runningText = resultText(await runningCall);
    assert.ok(Date.now() - runningStart < 2500, `运行中取消返回过慢: ${Date.now() - runningStart}ms`);
    assert.match(runningText, /cancelled/u);
    const status = await sessionManager.getSessionStatus(sessionId);
    assert.equal(status?.alive, false);

    sessionManager.closeAllSessions();
}

async function testCodexLifecycle(McpServer, helperPath) {
    process.env.SANDBOX_CODEX_BIN = process.execPath;
    process.env.SANDBOX_CODEX_BIN_ARGS = JSON.stringify([helperPath]);

    const codexModule = await import(`${codexModuleUrl}?test=${Date.now()}`);
    cleanupCodex = codexModule.cleanupCodexTasks;
    const server = new McpServer({ name: "codex-lifecycle-test", version: "1.0.0" });
    codexModule.registerCodex(server);
    const tool = server._registeredTools.sandbox_codex;
    assert.ok(tool);
    assert.equal(tool.inputSchema.safeParse({ prompt: "ok", timeout: 31 * 60 * 1000 }).success, true);

    const ownerId = "codex-lifecycle-test";
    const call = (params, signal) => tool.handler(params, extra(signal));
    const startBackground = async (durationMs) => {
        const response = await call({ prompt: `sleep:${durationMs}`, background: true, ownerId });
        return parseTaskId(resultText(response));
    };
    const assertRunning = async (taskId) => {
        const response = await call({ action: "check", taskId, ownerId });
        assert.match(resultText(response), /运行中/u);
    };
    const killTask = async (taskId) => {
        await call({ action: "kill", taskId, ownerId });
        await call({ action: "check", taskId, ownerId, waitSeconds: 3 });
    };

    const detachedController = new AbortController();
    const detachedResponse = await call({ prompt: "sleep:2000", background: true, ownerId }, detachedController.signal);
    const detachedTaskId = parseTaskId(resultText(detachedResponse));
    detachedController.abort();
    await delay(100);
    await assertRunning(detachedTaskId);
    await killTask(detachedTaskId);

    const checkTaskId = await startBackground(2000);
    const checkController = new AbortController();
    const checkStart = Date.now();
    const checking = call({ action: "check", taskId: checkTaskId, ownerId, waitSeconds: 5 }, checkController.signal);
    await delay(50);
    checkController.abort();
    assert.match(resultText(await checking), /未被终止/u);
    assert.ok(Date.now() - checkStart < 1000);
    await assertRunning(checkTaskId);
    await killTask(checkTaskId);

    const waitTaskId = await startBackground(2000);
    const waitController = new AbortController();
    const waiting = call({ action: "wait", taskId: waitTaskId, ownerId }, waitController.signal);
    await delay(50);
    waitController.abort();
    assert.match(resultText(await waiting), /后台任务继续运行/u);
    await assertRunning(waitTaskId);
    await killTask(waitTaskId);

    const syncController = new AbortController();
    const syncStart = Date.now();
    const synchronous = call({ prompt: "sleep:5000", ownerId }, syncController.signal);
    await delay(50);
    syncController.abort();
    const synchronousText = resultText(await synchronous);
    assert.ok(Date.now() - syncStart < 2500, `同步取消未被有界唤醒: ${Date.now() - syncStart}ms`);
    assert.match(synchronousText, /Codex 被终止 \(cancelled\)/u);

    codexModule.cleanupCodexTasks();
}

probeDefaultSessionLimits();
testConcurrentSessionAdmission();
testSessionSpawnFailureRecovery();
testIdleSessionRecovery();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sandbox-lifecycle-test-"));
const helperPath = path.join(tempRoot, "fake-codex.mjs");
await writeFile(helperPath, `
const prompt = process.argv.at(-1) || "";
const duration = Number(prompt.match(/sleep:(\\d+)/u)?.[1] || 0);
setTimeout(() => {
    console.log("fake-codex-done");
    process.exit(0);
}, duration);
`, "utf8");

try {
    const { McpServer } = await import(mcpServerModuleUrl);
    await testSessionLifecycle(McpServer);
    await testCodexLifecycle(McpServer, helperPath);

    const sessionSource = await readFile(path.join(sandboxRoot, "src", "tools", "session.ts"), "utf8");
    const codexSource = await readFile(path.join(sandboxRoot, "src", "tools", "codex.ts"), "utf8");
    assert.doesNotMatch(sessionSource, /max\(60000\)|max\(512\)/u);
    assert.doesNotMatch(codexSource, /max\(1800000\)/u);
    assert.match(sessionSource, /extra\.signal/u);
    assert.match(codexSource, /extra\.signal/u);

    console.log("PASS sandbox session/codex lifecycle design tests");
} finally {
    cleanupCodex();
    cleanupSessions();
    await rm(tempRoot, { recursive: true, force: true });
}
