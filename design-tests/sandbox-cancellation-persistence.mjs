import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cancellation-persistence-"));
const councilRoot = path.join(dataRoot, "council-tasks");
const launchRoot = path.join(dataRoot, "launches");

process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_COUNCIL_TASK_ROOT = councilRoot;
process.env.SANDBOX_LAUNCH_DIR = launchRoot;
process.env.SANDBOX_ADMISSION_MIN_RESERVATION_MB = "64";
process.env.SANDBOX_ADMISSION_LIMIT_MB = "64";
process.env.SANDBOX_ADMISSION_HARD_LIMIT_MB = "128";
process.env.SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB = "0";
process.env.SANDBOX_ADMISSION_WAIT_MIN_MS = "1000";
process.env.SANDBOX_ADMISSION_WAIT_MAX_MS = "1000";

const { execute } = await import("../mcps/sandbox/dist/executor.js");
const { getResourceAdmissionState, resourceAdmission } = await import("../mcps/sandbox/dist/resource-admission-runtime.js");
const {
    scanCouncilTasksOnStartup,
    validateCouncilWorkerIdentity,
    waitForPersistentCouncilTask,
} = await import("../mcps/sandbox/dist/council/background.js");
const {
    reapLaunchTasksOnce,
    registerLaunch,
    validateLaunchProcessIdentity,
} = await import("../mcps/sandbox/dist/tools/launch.js");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
        await delay(5);
    }
}

test("late cancellation after resource admission does not start executor command", async () => {
    const holder = await resourceAdmission.acquire({ ownerId: "late-cancel-holder", reservationMB: 64 });
    const markerPath = path.join(dataRoot, "late-cancel-marker.txt");
    const controller = new AbortController();
    try {
        const pending = execute({
            code: `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");`,
            language: "node",
            reservationMB: 64,
            signal: controller.signal,
        });
        await waitFor(() => getResourceAdmissionState().queued === 1);
        holder.release();
        controller.abort();

        const result = await pending;
        assert.equal(result.killed, true);
        assert.equal(result.killReason, "cancelled");
        assert.equal(fs.existsSync(markerPath), false);
        assert.equal(getResourceAdmissionState().activeLeases, 0);
    } finally {
        holder.release();
    }
});

test("Council identity mismatch is neither adopted nor reported as running", async () => {
    const expected = { pid: process.pid, startId: "persisted-start-id" };
    assert.equal(
        validateCouncilWorkerIdentity(expected, {
            observeIdentity: () => ({ pid: process.pid, startId: "different-start-id" }),
        }),
        "identity_mismatch",
    );

    const taskId = "council-pid-mismatch";
    const taskDir = path.join(councilRoot, taskId);
    const startedAt = new Date().toISOString();
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "spec.json"), JSON.stringify({
        taskId,
        runId: "legacy",
        artifactManifestPath: "",
        ownerId: "global",
        startedAt,
        workerIdentity: expected,
        params: {},
        reservationMB: 64,
    }), "utf8");
    fs.writeFileSync(path.join(taskDir, "progress.json"), JSON.stringify({
        status: "running",
        taskId,
        runId: "legacy",
        artifactManifestPath: "",
        ownerId: "global",
        pid: process.pid,
        workerIdentity: expected,
        startedAt,
        updatedAt: startedAt,
    }), "utf8");

    const activeBefore = getResourceAdmissionState().activeLeases;
    const messages = [];
    const summary = scanCouncilTasksOnStartup((message) => messages.push(message));
    assert.equal(summary.running, 0);
    assert.equal(summary.interrupted, 1);
    assert.equal(getResourceAdmissionState().activeLeases, activeBefore);

    const result = await waitForPersistentCouncilTask(taskId, 0, "global");
    assert.equal(result.status, "interrupted");
    assert.match(result.error, /未继续报告为运行中/u);
    assert.ok(messages.some((message) => message.includes("已标记中断")));
});

test("launch PID reuse fails closed even when command line is unreadable", async () => {
    const taskId = "launch-pid-mismatch";
    const taskDir = path.join(launchRoot, "tasks");
    const createdAtMs = Date.now();
    const expectedIdentity = { pid: process.pid, startId: "persisted-start-id" };
    assert.equal(
        validateLaunchProcessIdentity(expectedIdentity, {
            observeIdentity: () => ({ pid: process.pid, startId: "newer-reused-start-id" }),
        }),
        "identity_mismatch",
    );
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
        id: taskId,
        pid: process.pid,
        command: "node -e never-runs",
        commandHash: "persisted-command-hash",
        processIdentity: expectedIdentity,
        ownerId: "global",
        cwd: dataRoot,
        stdoutLog: path.join(launchRoot, `${taskId}.stdout.log`),
        stderrLog: path.join(launchRoot, `${taskId}.stderr.log`),
        exitMarkerPath: path.join(launchRoot, `${taskId}.done.json`),
        createdAtMs,
        startTime: createdAtMs,
        status: "running",
        exitCode: null,
        reservationMB: 64,
    }), "utf8");

    let handler;
    registerLaunch({
        tool(name, description, schema, registeredHandler) {
            assert.equal(name, "sandbox_launch");
            assert.equal(typeof description, "string");
            assert.ok(schema);
            handler = registeredHandler;
        },
    });
    assert.equal(typeof handler, "function");
    assert.equal(getResourceAdmissionState().activeLeases, 0);

    const response = await handler({ action: "status", taskId }, {});
    assert.match(response.content[0].text, /已失败/u);
    assert.match(response.content[0].text, /无法确认任务 PID 身份/u);
    assert.doesNotMatch(response.content[0].text, /运行中/u);
    const persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.equal(persisted.status, "failed");
    assert.match(persisted.statusReason, /PID/u);
});

test("launch reaper releases adopted lease after identity mismatch", async () => {
    const taskId = "launch-adopted-reaper";
    const taskDir = path.join(launchRoot, "tasks");
    const createdAtMs = Date.now();
    const expectedIdentity = { pid: process.pid, startId: "adopted-start-id" };
    fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
        id: taskId,
        pid: process.pid,
        command: "node -e persistent-launch",
        commandHash: "persistent-launch-hash",
        processIdentity: expectedIdentity,
        ownerId: "global",
        cwd: dataRoot,
        stdoutLog: path.join(launchRoot, `${taskId}.stdout.log`),
        stderrLog: path.join(launchRoot, `${taskId}.stderr.log`),
        exitMarkerPath: path.join(launchRoot, `${taskId}.done.json`),
        createdAtMs,
        startTime: createdAtMs,
        status: "running",
        exitCode: null,
        reservationMB: 64,
    }), "utf8");

    const activeBefore = getResourceAdmissionState().activeLeases;
    const adopted = reapLaunchTasksOnce({ observeIdentity: () => expectedIdentity });
    assert.equal(adopted.adopted, 1);
    assert.equal(getResourceAdmissionState().activeLeases, activeBefore + 1);

    const reaped = reapLaunchTasksOnce({
        observeIdentity: () => ({ pid: process.pid, startId: "reused-after-adoption" }),
    });
    assert.equal(reaped.running, 0);
    assert.equal(getResourceAdmissionState().activeLeases, activeBefore);
    const persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.equal(persisted.status, "failed");
    assert.match(persisted.statusReason, /启动标识/u);
});

test("legacy launch registry migrates only with matching process evidence", async () => {
    const taskId = "launch-legacy-migration";
    const taskDir = path.join(launchRoot, "tasks");
    const createdAtMs = Date.now();
    const commandHash = "legacy-command-hash";
    const exitMarkerPath = path.join(launchRoot, `${taskId}.done.json`);
    fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
        id: taskId,
        pid: process.pid,
        command: "node -e legacy-launch",
        commandHash,
        ownerId: "global",
        cwd: dataRoot,
        stdoutLog: path.join(launchRoot, `${taskId}.stdout.log`),
        stderrLog: path.join(launchRoot, `${taskId}.stderr.log`),
        exitMarkerPath,
        createdAtMs,
        startTime: createdAtMs,
        status: "running",
        exitCode: null,
        reservationMB: 64,
    }), "utf8");

    const activeBefore = getResourceAdmissionState().activeLeases;
    const migrated = reapLaunchTasksOnce({
        observeProcessInfo: () => ({
            commandLine: `node launch-wrapper.cjs ${exitMarkerPath} ${commandHash}`,
            createdAtMs,
            startId: "legacy-migrated-start-id",
        }),
    });
    assert.equal(migrated.adopted, 1);
    assert.equal(getResourceAdmissionState().activeLeases, activeBefore + 1);
    let persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.deepEqual(persisted.processIdentity, {
        pid: process.pid,
        startId: "legacy-migrated-start-id",
    });

    reapLaunchTasksOnce({
        observeIdentity: () => ({ pid: process.pid, startId: "legacy-now-reused" }),
    });
    assert.equal(getResourceAdmissionState().activeLeases, activeBefore);
    persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.equal(persisted.status, "failed");
});

test("launch waits for a real process identity before persisting the task", async () => {
    let handler;
    registerLaunch({
        tool(name, description, schema, registeredHandler) {
            assert.equal(name, "sandbox_launch");
            assert.equal(typeof description, "string");
            assert.ok(schema);
            handler = registeredHandler;
        },
    });
    assert.equal(typeof handler, "function");

    const ownerId = "launch-real-identity-test";
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('launch-identity-ok'), 1500)"`;
    const started = await handler({
        command,
        cwd: dataRoot,
        ownerId,
        memoryRequestMB: 64,
        maxMemoryMB: 256,
    }, {});
    const startText = started.content[0].text;
    assert.match(startText, /任务已启动/u);
    const taskId = startText.match(/ID:\s*([a-z0-9-]+)/iu)?.[1];
    assert.ok(taskId, startText);

    await new Promise(resolve => setTimeout(resolve, 2_000));
    const completed = await handler({ action: "status", taskId, ownerId, tailLines: 20 }, {});
    assert.match(completed.content[0].text, /已完成/u);
    assert.match(completed.content[0].text, /launch-identity-ok/u);
});

test("launch reports an immediate Windows Job Object limit as memory pressure", async () => {
    if (process.platform !== "win32") return;
    let handler;
    registerLaunch({
        tool(name, description, schema, registeredHandler) {
            assert.equal(name, "sandbox_launch");
            assert.equal(typeof description, "string");
            assert.ok(schema);
            handler = registeredHandler;
        },
    });

    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 1500)"`;
    const response = await handler({
        command,
        cwd: dataRoot,
        ownerId: "launch-immediate-memory-limit",
        memoryRequestMB: 16,
        maxMemoryMB: 16,
    }, {});
    assert.match(response.content[0].text, /启动阶段触发 16MB 进程树内存硬上限/u);
});

test("launch waits for an atomic exit marker before declaring a missing PID failed", async () => {
    const taskId = "launch-exit-marker-grace";
    const taskDir = path.join(launchRoot, "tasks");
    const exitMarkerPath = path.join(launchRoot, `${taskId}.done.json`);
    const deadPid = 2147483000;
    fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
        id: taskId,
        pid: deadPid,
        command: "node -e marker-grace",
        commandHash: "marker-grace-hash",
        processIdentity: { pid: deadPid, startId: "marker-grace-start" },
        ownerId: "global",
        cwd: dataRoot,
        stdoutLog: path.join(launchRoot, `${taskId}.stdout.log`),
        stderrLog: path.join(launchRoot, `${taskId}.stderr.log`),
        exitMarkerPath,
        createdAtMs: Date.now(),
        startTime: Date.now(),
        status: "running",
        exitCode: null,
        reservationMB: 64,
    }), "utf8");

    const first = reapLaunchTasksOnce({}, false);
    assert.ok(first.running >= 1);
    let persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.equal(persisted.status, "running");
    assert.match(persisted.statusReason, /等待完成标记/u);

    fs.writeFileSync(exitMarkerPath, JSON.stringify({
        done: true,
        exitCode: 0,
        signal: null,
        startedAtMs: Date.now() - 100,
        finishedAtMs: Date.now(),
    }), "utf8");
    reapLaunchTasksOnce({}, false);
    persisted = JSON.parse(fs.readFileSync(path.join(taskDir, `${taskId}.json`), "utf8"));
    assert.equal(persisted.status, "done");
    assert.equal(persisted.exitCode, 0);
});

let passed = 0;
try {
    for (const { name, run } of tests) {
        await run();
        passed += 1;
        console.log(`ok ${passed} - ${name}`);
    }
    console.log(`\n${passed}/${tests.length} sandbox cancellation/persistence tests passed`);
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
