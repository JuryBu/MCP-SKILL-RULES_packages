import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sandboxRoot = path.join(repoRoot, "mcps", "sandbox");
const require = createRequire(path.join(sandboxRoot, "package.json"));
const typescript = require("typescript");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-launch-owned-feedback-"));
const launchRoot = path.join(dataRoot, "launches");
const taskRoot = path.join(launchRoot, "tasks");
process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_LAUNCH_DIR = launchRoot;
const sourcePath = path.join(sandboxRoot, "src", "tools", "launch.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ES2022 },
    reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length || 0, 0);
const modulePath = path.join(dataRoot, "launch.mjs");
const runtimeSource = compiled.outputText.replace(/from "([.][.]?\/[^"]+)"/gu, (_match, relativePath) => (
    `from ${JSON.stringify(pathToFileURL(path.resolve(sandboxRoot, "dist", "tools", relativePath)).href)}`
)).replace(/from "(zod|@modelcontextprotocol\/sdk\/server\/mcp.js)"/gu, (_match, packageName) => (
    `from ${JSON.stringify(pathToFileURL(require.resolve(packageName)).href)}`
));
fs.writeFileSync(modulePath, runtimeSource, "utf8");
const originalExecFile = childProcess.execFile;
const originalRenameSync = fs.renameSync;
let failRegistryWrites = false;
fs.renameSync = function(sourcePath, targetPath) {
    if (failRegistryWrites && path.dirname(String(targetPath)) === taskRoot) {
        throw Object.assign(new Error("injected registry EACCES"), { code: "EACCES" });
    }
    return originalRenameSync.call(this, sourcePath, targetPath);
};
let queryMode = "real";
let processQueries = 0;
childProcess.execFile = function(executable, args, options, callback) {
    if (queryMode !== "real" && String(executable).toLowerCase() === "powershell.exe"
        && args.some(argument => String(argument).includes("Get-CimInstance Win32_Process"))) {
        processQueries += 1;
        const output = queryMode === "mismatch" ? JSON.stringify({ StartId: "different-process-start", CreationDate: new Date().toISOString() }) : "";
        const timer = setTimeout(() => callback(null, output, ""), queryMode === "slow" ? 700 : 100);
        return { kill() { clearTimeout(timer); return true; } };
    }
    return originalExecFile.call(this, executable, args, options, callback);
};
childProcess.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    childProcess.execFile(...args, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
    });
});
syncBuiltinESMExports();
const keepAlive = setInterval(() => {}, 1000);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const readTask = id => JSON.parse(fs.readFileSync(path.join(taskRoot, `${id}.json`), "utf8"));
const writeTask = task => fs.writeFileSync(path.join(taskRoot, `${task.id}.json`), JSON.stringify(task), "utf8");
let handler;
let foreignSnapshot;
const results = [];
try {
    const { registerLaunch, validateLaunchProcessIdentity } = await import(pathToFileURL(modulePath).href);
    const { getResourceAdmissionState } = await import(pathToFileURL(path.join(sandboxRoot, "dist", "resource-admission-runtime.js")).href);
    registerLaunch({ tool(_name, _description, _schema, callback) { handler = callback; } });
    const deadline = Date.now() + 10_000;
    while (getResourceAdmissionState().recoveryPending && Date.now() < deadline) await delay(10);
    assert.equal(getResourceAdmissionState().recoveryPending, false);
    fs.mkdirSync(taskRoot, { recursive: true });
    if (!process.argv.includes("--registry-failure-only")) {
    const baseTask = {
        id: "owned-terminal", pid: process.pid, command: "isolated test record", ownerId: "owner-alpha",
        cwd: dataRoot, stdoutLog: path.join(dataRoot, "stdout.log"), stderrLog: path.join(dataRoot, "stderr.log"),
        startTime: Date.now(), status: "done", exitCode: 0,
    };
    writeTask(baseTask);
    const foreign = { ...baseTask, id: "foreign-slow", ownerId: "owner-beta", status: "running", exitCode: null };
    writeTask(foreign);
    foreignSnapshot = fs.readFileSync(path.join(taskRoot, "foreign-slow.json"), "utf8");
    writeTask({ ...baseTask, id: "global-terminal", ownerId: undefined });
    queryMode = "slow";
    const listStarted = Date.now();
    const ownList = await handler({ action: "list", ownerId: "owner-alpha", tailLines: 1 }, {});
    const listMs = Date.now() - listStarted;
    assert.match(ownList.content[0].text, /owned-terminal/u);
    assert.doesNotMatch(ownList.content[0].text, /foreign-slow|global-terminal/u);
    assert.equal(processQueries, 0, "owner-filtered list queried another owner's PID");
    assert.ok(listMs < 500, `owner-filtered list waited ${listMs}ms`);
    assert.equal(fs.readFileSync(path.join(taskRoot, "foreign-slow.json"), "utf8"), foreignSnapshot);
    const globalList = await handler({ action: "list", tailLines: 1 }, {});
    assert.match(globalList.content[0].text, /global-terminal/u);
    assert.doesNotMatch(globalList.content[0].text, /owned-terminal|foreign-slow/u);
    for (const action of ["status", "kill"]) {
        const denied = await handler({ action, taskId: "foreign-slow", ownerId: "owner-alpha", tailLines: 1 }, {});
        assert.match(denied.content[0].text, /不属于当前 owner/u);
    }
    assert.equal(processQueries, 0);
    results.push({ test: "owned-list-no-foreign-refresh-and-owner-gates", passed: true, listMs, foreignQueries: processQueries });
    writeTask({ ...foreign, status: "done", exitCode: 0 });

    assert.equal(validateLaunchProcessIdentity({ pid: process.pid, startId: "original" }, {
        observeIdentity: () => ({ pid: process.pid, startId: "reused" }),
    }), "identity_mismatch");
    assert.equal(validateLaunchProcessIdentity({ pid: process.pid, startId: "original" }, {
        observeIdentity: () => undefined,
    }), "identity_missing");
    queryMode = "mismatch";
    writeTask({ ...baseTask, id: "pid-reuse-kill", status: "running", exitCode: null,
        processIdentity: { pid: process.pid, startId: "original" } });
    const deniedReusedKill = await handler({ action: "kill", taskId: "pid-reuse-kill", ownerId: "owner-alpha" }, {});
    assert.match(deniedReusedKill.content[0].text, /已结束|校验失败/u);
    assert.equal(readTask("pid-reuse-kill").status, "failed");
    assert.equal(process.kill(process.pid, 0), true);
    results.push({ test: "pid-reuse-and-unknown-identity-gates", passed: true });

    const forgedTask = { ...baseTask, id: "marker-integrity", status: "running", exitCode: null,
        launchToken: "per-launch-instance", createdAtMs: Date.now(), exitMarkerPath: path.join(dataRoot, "integrity.done.json") };
    const validMarker = { done: true, exitCode: 0, signal: null, pid: process.pid,
        launchToken: forgedTask.launchToken, startedAtMs: forgedTask.createdAtMs, finishedAtMs: Date.now() };
    queryMode = "missing";
    for (const marker of [undefined, { done: true, exitCode: 0 }, { ...validMarker, launchToken: "forged" },
        { ...validMarker, pid: process.pid + 1 }, { ...validMarker, startedAtMs: forgedTask.createdAtMs - 1 },
        { ...validMarker, exitCode: 0, error: "forged success" }]) {
        writeTask(forgedTask);
        if (marker) fs.writeFileSync(forgedTask.exitMarkerPath, JSON.stringify(marker));
        else if (fs.existsSync(forgedTask.exitMarkerPath)) fs.unlinkSync(forgedTask.exitMarkerPath);
        await handler({ action: "status", taskId: forgedTask.id, ownerId: "owner-alpha", tailLines: 1 }, {});
        assert.equal(readTask(forgedTask.id).status, "running");
    }
    writeTask(forgedTask);
    const deniedUnknownKill = await handler({ action: "kill", taskId: forgedTask.id, ownerId: "owner-alpha" }, {});
    assert.match(deniedUnknownKill.content[0].text, /仍保留运行/u);
    assert.equal(readTask(forgedTask.id).status, "running");
    fs.writeFileSync(forgedTask.exitMarkerPath, JSON.stringify(validMarker));
    await handler({ action: "status", taskId: forgedTask.id, ownerId: "owner-alpha", tailLines: 1 }, {});
    assert.equal(readTask(forgedTask.id).status, "done");
    results.push({ test: "missing-forged-mismatched-markers-rejected-valid-marker-accepted", passed: true, invalidCases: 6 });

    queryMode = "real";
    const beforeLaunchLeases = getResourceAdmissionState().activeLeases;
    const launchStarted = Date.now();
    const command = `"${process.env.SANDBOX_LAUNCH_TEST_PYTHON || "python"}" -c "print('owned-short-complete')"`;
    const launched = await handler({ command, cwd: dataRoot, ownerId: "owner-alpha", maxMemoryMB: 256, memoryRequestMB: 64 }, {});
    const launchText = launched.content[0].text;
    const taskId = /taskId: ([a-f0-9-]+)/u.exec(launchText)?.[1];
    assert.ok(taskId, launchText);
    assert.doesNotMatch(launchText, /启动失败|已停止任务|启动状态待确认/u);
    await handler({ action: "status", taskId, ownerId: "owner-alpha", tailLines: 1, waitSeconds: 1 }, {});
    const completed = readTask(taskId);
    assert.equal(completed.status, "done", launchText);
    assert.equal(completed.exitCode, 0);
    assert.match(fs.readFileSync(completed.stdoutLog, "utf8"), /owned-short-complete/u);
    const marker = JSON.parse(fs.readFileSync(completed.exitMarkerPath, "utf8"));
    assert.equal(marker.launchToken, completed.launchToken);
    assert.equal(marker.pid, completed.pid);
    assert.equal(getResourceAdmissionState().activeLeases, beforeLaunchLeases);
    results.push({ test: "real-python-short-command", passed: true, launchMs: Date.now() - launchStarted,
        status: completed.status, exitCode: completed.exitCode, completionMs: marker.finishedAtMs - marker.startedAtMs,
        response: launchText.split("\n")[0], interpreter: process.env.SANDBOX_LAUNCH_TEST_PYTHON || "python" });
    queryMode = "missing";
    const unknownStarted = Date.now();
    const unknownLaunch = await handler({ command: `"${process.env.SANDBOX_LAUNCH_TEST_PYTHON || "python"}" -c "import time; time.sleep(4); print('owned-unknown-complete')"`,
        cwd: dataRoot, ownerId: "owner-alpha", maxMemoryMB: 256, memoryRequestMB: 64 }, {});
    const unknownText = unknownLaunch.content[0].text;
    const unknownTaskId = /taskId: ([a-f0-9-]+)/u.exec(unknownText)?.[1];
    assert.ok(unknownTaskId, unknownText);
    assert.match(unknownText, /启动状态待确认/u);
    const unknownTask = readTask(unknownTaskId);
    assert.equal(unknownTask.status, "running");
    assert.equal(unknownTask.processIdentity, undefined);
    assert.equal(process.kill(unknownTask.pid, 0), true);
    assert.equal(getResourceAdmissionState().activeLeases, beforeLaunchLeases + 1);
    await handler({ action: "status", taskId: unknownTaskId, ownerId: "owner-alpha", tailLines: 1, waitSeconds: 3 }, {});
    assert.equal(readTask(unknownTaskId).status, "done");
    assert.equal(getResourceAdmissionState().activeLeases, beforeLaunchLeases);
    results.push({ test: "real-command-unknown-start-retains-process-and-lease-until-marker", passed: true,
        elapsedMs: Date.now() - unknownStarted, unknownWasRunning: true, resourceReleasedAfterMarker: true });
    queryMode = "real";
    const failedLaunch = await handler({ command: `"${process.env.SANDBOX_LAUNCH_TEST_PYTHON || "python"}" -c "raise SystemExit(7)"`,
        cwd: dataRoot, ownerId: "owner-alpha", maxMemoryMB: 256, memoryRequestMB: 64 }, {});
    const failedText = failedLaunch.content[0].text;
    const failedTaskId = /taskId: ([a-f0-9-]+)/u.exec(failedText)?.[1];
    assert.ok(failedTaskId, failedText);
    await handler({ action: "status", taskId: failedTaskId, ownerId: "owner-alpha", tailLines: 1, waitSeconds: 1 }, {});
    assert.equal(readTask(failedTaskId).status, "failed");
    assert.equal(readTask(failedTaskId).exitCode, 7);
    assert.equal(getResourceAdmissionState().activeLeases, beforeLaunchLeases);
    results.push({ test: "real-python-nonzero-is-failed-not-success", passed: true, exitCode: 7 });
    }
    const beforeFaultLeases = getResourceAdmissionState().activeLeases;
    queryMode = "missing";
    failRegistryWrites = true;
    const faultStarted = Date.now();
    const faultLaunch = await handler({ command: `"${process.env.SANDBOX_LAUNCH_TEST_PYTHON || "python"}" -c "import time; time.sleep(4); print('registry-failure-complete')"`,
        cwd: dataRoot, ownerId: "owner-registry-fault", maxMemoryMB: 256, memoryRequestMB: 64 }, {});
    const faultText = faultLaunch.content[0].text;
    const faultTaskId = /taskId: ([a-f0-9-]+)/u.exec(faultText)?.[1];
    assert.ok(faultTaskId, faultText);
    assert.match(faultText, /任务登记尚未落盘/u);
    assert.equal(fs.existsSync(path.join(taskRoot, `${faultTaskId}.json`)), false);
    assert.equal(getResourceAdmissionState().activeLeases, beforeFaultLeases + 1);
    const faultList = await handler({ action: "list", ownerId: "owner-registry-fault", tailLines: 1 }, {});
    assert.match(faultList.content[0].text, new RegExp(faultTaskId, "u"));
    const faultRunning = await handler({ action: "status", taskId: faultTaskId, ownerId: "owner-registry-fault", tailLines: 1 }, {});
    assert.match(faultRunning.content[0].text, /运行中/u);
    assert.match(faultRunning.content[0].text, /任务登记尚未落盘/u);
    assert.equal(getResourceAdmissionState().activeLeases, beforeFaultLeases + 1);
    for (const action of ["status", "kill"]) {
        const denied = await handler({ action, taskId: faultTaskId, ownerId: "owner-other", tailLines: 1 }, {});
        assert.match(denied.content[0].text, /不属于当前 owner/u);
    }
    const hidden = await handler({ action: "list", ownerId: "owner-other", tailLines: 1 }, {});
    assert.doesNotMatch(hidden.content[0].text, new RegExp(faultTaskId, "u"));
    const faultDone = await handler({ action: "status", taskId: faultTaskId, ownerId: "owner-registry-fault", tailLines: 1, waitSeconds: 3 }, {});
    assert.match(faultDone.content[0].text, /已完成/u);
    assert.match(faultDone.content[0].text, /任务登记尚未落盘/u);
    assert.equal(fs.existsSync(path.join(taskRoot, `${faultTaskId}.json`)), false);
    assert.equal(getResourceAdmissionState().activeLeases, beforeFaultLeases);
    const faultClean = await handler({ action: "clean", taskId: faultTaskId, ownerId: "owner-registry-fault" }, {});
    assert.match(faultClean.content[0].text, /清理了 0 个/u);
    assert.equal(fs.existsSync(path.join(launchRoot, `${faultTaskId}.stdout.log`)), true);
    failRegistryWrites = false;
    const restored = await handler({ action: "status", taskId: faultTaskId, ownerId: "owner-registry-fault", tailLines: 1 }, {});
    assert.doesNotMatch(restored.content[0].text, /任务登记尚未落盘/u);
    const recoveredTask = readTask(faultTaskId);
    assert.equal(recoveredTask.status, "done");
    assert.equal(recoveredTask.exitCode, 0);
    assert.equal(recoveredTask.ownerId, "owner-registry-fault");
    assert.equal(recoveredTask.registryWriteError, undefined);
    const recoveredMarker = JSON.parse(fs.readFileSync(recoveredTask.exitMarkerPath, "utf8"));
    assert.equal(recoveredMarker.launchToken, recoveredTask.launchToken);
    assert.equal(recoveredMarker.pid, recoveredTask.pid);
    assert.match(fs.readFileSync(recoveredTask.stdoutLog, "utf8"), /registry-failure-complete/u);
    results.push({ test: "registry-write-failure-keeps-owned-task-queryable-and-recovers", passed: true,
        elapsedMs: Date.now() - faultStarted, runningLeaseRetained: true, ownerGatesPreserved: true,
        terminalReleasedAfterMarker: true, restoredRegistryStatus: recoveredTask.status });
    console.log(JSON.stringify({ passed: true, node: process.version, platform: process.platform, sourcePath, results }, null, 2));
} finally {
    childProcess.execFile = originalExecFile;
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    clearInterval(keepAlive);
    let recoveryFailed = false;
    if (handler) {
        try { await handler({ action: "list", ownerId: "owner-registry-fault", tailLines: 1 }, {}); }
        catch { recoveryFailed = true; }
    }
    const runningTasks = fs.existsSync(taskRoot) ? fs.readdirSync(taskRoot).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(fs.readFileSync(path.join(taskRoot, name), "utf8"))).filter(task => task.status === "running") : [];
    if (runningTasks.length === 0 && !recoveryFailed) fs.rmSync(dataRoot, { recursive: true, force: true });
    else console.error(`Preserved isolated test state with running tasks: ${dataRoot}`);
}
