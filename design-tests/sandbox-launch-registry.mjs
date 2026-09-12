import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-launch-registry-"));
const launchRoot = path.join(dataRoot, "launches");
const taskDir = path.join(launchRoot, "tasks");
process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_LAUNCH_DIR = launchRoot;
process.env.SANDBOX_ADMISSION_MIN_RESERVATION_MB = "16";
process.env.SANDBOX_ADMISSION_LIMIT_MB = "512";
process.env.SANDBOX_ADMISSION_HARD_LIMIT_MB = "1024";

const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await delay(25);
    }
}

function taskPath(id) {
    return path.join(taskDir, `${id}.json`);
}

function writeTask(id, overrides = {}) {
    const startedAt = Date.now() - 60_000;
    const task = {
        id,
        pid: 1,
        command: "node synthetic-launch-task",
        ownerId: "owner-alpha",
        cwd: dataRoot,
        stdoutLog: path.join(launchRoot, `${id}.stdout.log`),
        stderrLog: path.join(launchRoot, `${id}.stderr.log`),
        exitMarkerPath: path.join(launchRoot, `${id}.done.json`),
        createdAtMs: startedAt,
        startTime: startedAt,
        status: "done",
        exitCode: 0,
        reservationMB: 16,
        ...overrides,
    };
    fs.writeFileSync(taskPath(id), JSON.stringify(task), "utf8");
    return task;
}

function fingerprint(filePath) {
    return {
        sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        mtimeMs: fs.statSync(filePath).mtimeMs,
    };
}

fs.mkdirSync(taskDir, { recursive: true });
const terminalFiles = [];
for (let index = 0; index < 1500; index += 1) {
    const id = `terminal-${String(index).padStart(4, "0")}`;
    writeTask(id);
    terminalFiles.push(taskPath(id));
}

const targetId = "terminal-target";
let historicalZeroPath;
if (process.platform === "win32") {
    historicalZeroPath = taskPath("historical-zero-record");
    fs.writeFileSync(historicalZeroPath, Buffer.alloc(1024));
    const oldDate = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(historicalZeroPath, oldDate, oldDate);
    const creation = spawnSync("powershell.exe", ["-NoProfile", "-Command",
        `[IO.File]::SetCreationTimeUtc('${historicalZeroPath.replace(/'/gu, "''")}', [DateTime]::Parse('2000-01-01T00:00:00Z').ToUniversalTime())`,
    ], { windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(creation.status, 0, creation.stderr);
    terminalFiles.push(historicalZeroPath);
}
const target = writeTask(targetId);
const largeLog = `${Array.from({ length: 600_000 }, (_, index) => `tail-${index}`).join("\n")}\n`;
const unicodeTail = "日志🙂".repeat(5000);
fs.writeFileSync(target.stdoutLog, `${largeLog}${unicodeTail}\n`, "utf8");
const tombstonedLegacyId = "legacy-tombstone";
fs.writeFileSync(path.join(launchRoot, "registry.json"), JSON.stringify([
    ...(historicalZeroPath ? [{ ...target, id: "historical-zero-record" }] : []),
    {
        ...writeTask(tombstonedLegacyId),
        id: tombstonedLegacyId,
    },
]), "utf8");
fs.writeFileSync(taskPath(tombstonedLegacyId), JSON.stringify({ id: tombstonedLegacyId, deleted: true, deletedAtMs: Date.now() }), "utf8");

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
});
child.unref();
const testKeepAlive = setInterval(() => {}, 1000);

try {
    const { getResourceAdmissionState } = await import("../mcps/sandbox/dist/resource-admission-runtime.js");
    const { readLaunchProcessIdentity, registerLaunch, getLaunchRecoveryState } = await import("../mcps/sandbox/dist/tools/launch.js");
    await waitFor(() => Boolean(readLaunchProcessIdentity(process.pid)), 10_000, "current-process identity unavailable");
    await waitFor(() => Boolean(readLaunchProcessIdentity(child.pid)), 10_000, "child identity unavailable");

    const currentIdentity = readLaunchProcessIdentity(process.pid);
    const childIdentity = readLaunchProcessIdentity(child.pid);
    const cleanId = "running-clean";
    const runningA = "running-a";
    const killId = "running-kill";
    const unknownId = "running-legacy-unknown";
    writeTask(cleanId, { pid: process.pid, processIdentity: currentIdentity, status: "running", exitCode: null });
    writeTask(runningA, { pid: process.pid, processIdentity: currentIdentity, status: "running", exitCode: null });
    writeTask(killId, { pid: child.pid, processIdentity: childIdentity, status: "running", exitCode: null });
    writeTask(unknownId, {
        pid: process.pid,
        command: "node intentionally-unverifiable-legacy-task",
        commandHash: "intentionally-unverifiable",
        processIdentity: undefined,
        status: "running",
        exitCode: null,
    });

    const terminalSnapshots = terminalFiles.map(filePath => ({ filePath, ...fingerprint(filePath) }));
    const recoveryStartedAt = Date.now();
    let previousTick = Date.now();
    let recoveryLoopDelayMs = 0;
    const recoveryPulse = setInterval(() => {
        recoveryLoopDelayMs = Math.max(recoveryLoopDelayMs, Date.now() - previousTick - 20);
        previousTick = Date.now();
    }, 20);
    recoveryPulse.unref();
    let handler;
    registerLaunch({
        tool(name, _description, _schema, registeredHandler) {
            assert.equal(name, "sandbox_launch");
            handler = registeredHandler;
        },
    });
    assert.equal(typeof handler, "function");
    assert.equal(getResourceAdmissionState().recoveryPending, true);
    await waitFor(
        () => getResourceAdmissionState().recoveryPending === false && getResourceAdmissionState().activeLeases >= 4,
        120_000,
        "launch recovery did not adopt all running leases",
    );
    clearInterval(recoveryPulse);
    assert.equal(getLaunchRecoveryState().ignoredHistoricalRecords, historicalZeroPath ? 1 : 0);
    console.log(JSON.stringify({ recoveryMs: Date.now() - recoveryStartedAt, recoveryLoopDelayMs }));

    const deniedStatus = await handler({ action: "status", taskId: targetId, ownerId: "owner-beta" }, {});
    const deniedKill = await handler({ action: "kill", taskId: targetId, ownerId: "owner-beta" }, {});
    const deniedClean = await handler({ action: "clean", taskId: targetId, ownerId: "owner-beta" }, {});
    assert.match(deniedStatus.content[0].text, /不属于当前 owner/u);
    assert.match(deniedKill.content[0].text, /不属于当前 owner/u);
    assert.match(deniedClean.content[0].text, /清理了 0 个/u);
    assert.equal(JSON.parse(fs.readFileSync(taskPath(targetId), "utf8")).status, "done");
    const tombstonedLegacy = await handler({ action: "status", taskId: tombstonedLegacyId, ownerId: "owner-alpha" }, {});
    assert.match(tombstonedLegacy.content[0].text, /未找到任务/u);
    if (historicalZeroPath) {
        const historicalClean = await handler({ action: "clean", taskId: "historical-zero-record", ownerId: "owner-alpha" }, {});
        assert.match(historicalClean.content[0].text, /清理了 0 个/u);
    }

    const unknownKill = await handler({ action: "kill", taskId: unknownId, ownerId: "owner-alpha" }, {});
    assert.match(unknownKill.content[0].text, /仍保留运行/u);
    const unknownPersisted = JSON.parse(fs.readFileSync(taskPath(unknownId), "utf8"));
    assert.equal(unknownPersisted.status, "running");
    assert.match(unknownPersisted.statusReason, /保留任务以便重试/u);

    const concurrentStatuses = await Promise.all(Array.from({ length: 20 }, () => (
        handler({ action: "status", taskId: runningA, ownerId: "owner-alpha" }, {})
    )));
    assert.equal(concurrentStatuses.length, 20);
    assert.ok(concurrentStatuses.every(response => /运行中/u.test(response.content[0].text)));

    const originalReadFileSync = fs.readFileSync;
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    let taskReads = 0;
    let tailReadBytes = 0;
    const trackedDescriptors = new Set();
    fs.readFileSync = function(filePath, ...args) {
        const text = String(filePath);
        if (text.startsWith(taskDir) && text.endsWith(".json")) taskReads += 1;
        return originalReadFileSync.call(this, filePath, ...args);
    };
    fs.openSync = function(filePath, ...args) {
        const descriptor = originalOpenSync.call(this, filePath, ...args);
        if (String(filePath) === target.stdoutLog) trackedDescriptors.add(descriptor);
        return descriptor;
    };
    fs.readSync = function(descriptor, buffer, offset, length, position) {
        if (trackedDescriptors.has(descriptor)) tailReadBytes += length;
        return originalReadSync.call(this, descriptor, buffer, offset, length, position);
    };
    try {
        const response = await handler({ action: "status", taskId: targetId, ownerId: "owner-alpha", tailLines: 5 }, {});
        assert.match(response.content[0].text, /tail-599999/u);
        assert.ok(response.content[0].text.includes(unicodeTail), "bounded tail corrupted multibyte UTF-8 across read chunks");
        assert.ok(taskReads <= 1, `status synchronously read ${taskReads} task files`);
        assert.ok(tailReadBytes <= 512 * 1024, `tailFile read ${tailReadBytes} bytes`);
    } finally {
        fs.readFileSync = originalReadFileSync;
        fs.openSync = originalOpenSync;
        fs.readSync = originalReadSync;
    }

    fs.writeFileSync(path.join(launchRoot, `${cleanId}.done.json`), JSON.stringify({ done: true, exitCode: 0, finishedAtMs: Date.now() }), "utf8");
    await handler({ action: "status", taskId: cleanId, ownerId: "owner-alpha" }, {});
    await handler({ action: "clean", taskId: cleanId, ownerId: "owner-alpha" }, {});
    await delay(16_000);
    const cleaned = JSON.parse(fs.readFileSync(taskPath(cleanId), "utf8"));
    assert.equal(cleaned.deleted, true, "tracked terminal task was resurrected after clean");

    await Promise.all([
        handler({ action: "status", taskId: killId, ownerId: "owner-alpha", waitSeconds: 1 }, {}),
        handler({ action: "kill", taskId: killId, ownerId: "owner-alpha" }, {}),
    ]);
    const killed = JSON.parse(fs.readFileSync(taskPath(killId), "utf8"));
    assert.equal(killed.status, "failed", "concurrent status overwrote kill terminal state");
    assert.equal(killed.exitCode, -1);

    await handler({ action: "clean", taskId: targetId, ownerId: "owner-alpha" }, {});
    const targetTombstone = JSON.parse(fs.readFileSync(taskPath(targetId), "utf8"));
    assert.equal(targetTombstone.deleted, true);
    for (const id of [runningA, unknownId]) {
        fs.writeFileSync(path.join(launchRoot, `${id}.done.json`), JSON.stringify({ done: true, exitCode: 0, finishedAtMs: Date.now() }), "utf8");
        await handler({ action: "status", taskId: id, ownerId: "owner-alpha" }, {});
        await handler({ action: "clean", taskId: id, ownerId: "owner-alpha" }, {});
    }
    await delay(16_000);
    for (const id of [runningA, unknownId]) {
        assert.equal(JSON.parse(fs.readFileSync(taskPath(id), "utf8")).deleted, true);
    }
    for (const snapshot of terminalSnapshots) {
        assert.deepEqual(fingerprint(snapshot.filePath), { sha256: snapshot.sha256, mtimeMs: snapshot.mtimeMs });
    }
    console.log("launch registry: 1500 terminal files unchanged; recovery leases, owner isolation, bounded tail, clean and kill races passed");
} finally {
    clearInterval(testKeepAlive);
    try { child.kill(); } catch { }
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
