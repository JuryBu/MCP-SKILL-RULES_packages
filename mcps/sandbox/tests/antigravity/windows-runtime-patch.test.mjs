import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = new URL("../../src/", import.meta.url).href;
const sandboxRoot = fileURLToPath(new URL("../../", import.meta.url));
const pressure = { physicalAvailableMB: 8192, commitAvailableMB: 32768, highMemory: true, lowMemory: false };

function bootstrap({ monitor = "sample", processReplies, live = false } = {}) {
    const monitorSource = `
        export function hasWindowsJobRunner() { return ${monitor !== "fallback"}; }
        export function startWindowsSystemMemoryMonitor(onSample, onStop) {
            ${monitor === "sample" ? `setTimeout(() => onSample(${JSON.stringify(pressure)}), 60).unref();` : ""}
            ${monitor === "stopped" ? "onStop();" : ""}
            return { unref() {} };
        }
    `;
    const childSource = `
        const replies = ${JSON.stringify(processReplies ?? [])};
        globalThis.processProbeCalls = [];
        function materialize(reply) {
            if (!Array.isArray(reply)) return reply;
            const identities = { CURRENT: process.pid, PARENT: process.ppid, LOWER: process.pid - 1, HIGHER: process.pid + 1 };
            const commandPrefix = [process.execPath, ...process.execArgv].map((argument) => '"' + argument + '"').join(" ");
            return reply.map((entry) => ({ ...entry,
                pid: identities[entry.pid] ?? entry.pid,
                parentPid: identities[entry.parentPid] ?? entry.parentPid,
                executablePath: entry.executablePath === "EXECUTABLE" ? process.execPath : entry.executablePath,
                commandLine: entry.commandLine === "COMMAND" ? commandPrefix + ' "' + process.argv[1] + '"'
                    : entry.commandLine === "OTHER_COMMAND" ? commandPrefix + ' "C:\\\\other.js" "' + process.argv[1] + '"' : entry.commandLine,
            }));
        }
        export function execFile(command, args, options, callback) {
            globalThis.processProbeCalls.push({ command, args, options });
            const reply = replies.shift();
            queueMicrotask(() => reply?.error
                ? callback(new Error(reply.error), "")
                : callback(null, typeof reply === "string" ? reply : JSON.stringify(materialize(reply ?? []))));
            return {};
        }
        export function exec() { throw new Error("Legacy shell process query must not run"); }
    `;
    return `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        import { existsSync } from "node:fs";
        const sourceRoot = ${JSON.stringify(sourceRoot)};
        const mockSources = new Map([
            ["fixture:memory-monitor", ${JSON.stringify(monitorSource)}],
            ["fixture:child-process", ${JSON.stringify(childSource)}],
        ]);
        registerHooks({
            resolve(specifier, context, nextResolve) {
                if (specifier === "./windows-job-runner.js") return { url: "fixture:memory-monitor", shortCircuit: true };
                if (${!live} && specifier === "child_process") return { url: "fixture:child-process", shortCircuit: true };
                if (specifier.startsWith(".") && specifier.endsWith(".js")) {
                    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
                    if (existsSync(candidate)) return nextResolve(candidate.href, context);
                }
                return nextResolve(specifier, context);
            },
            load(url, context, nextLoad) {
                if (mockSources.has(url)) return { format: "module", source: mockSources.get(url), shortCircuit: true };
                return nextLoad(url, context);
            },
        });
        ${!live ? 'Object.defineProperty(process, "platform", { value: "win32" });' : ""}
    `;
}

function runSample(source, options = {}) {
    return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", bootstrap(options) + source], {
        cwd: sandboxRoot,
        encoding: "utf8",
        timeout: options.live ? 12000 : 8000,
        windowsHide: true,
    });
}

function assertSuccessful(result) {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("controller top-level await reaches its own admission deadline without external handles", () => {
    const result = runSample(`
        const { ResourceAdmissionController } = await import(sourceRoot + "resource-admission.ts");
        const controller = new ResourceAdmissionController();
        controller.updateSystemAvailableMemoryMB(0);
        await assert.rejects(controller.acquire({ reservationMB: 64, admissionBudgetMs: 50 }), { code: "admission_timeout" });
        assert.equal(controller.getState().queued, 0);
        console.log("DIRECT_CONTROLLER_TIMEOUT_SETTLED");
    `, { monitor: "none" });
    assertSuccessful(result);
    assert.match(result.stdout, /DIRECT_CONTROLLER_TIMEOUT_SETTLED/u);
});

test("top-level await survives the first pressure sample without a caller keepalive", () => {
    const result = runSample(`
        const { acquireResourceLease, getResourceAdmissionState } = await import(sourceRoot + "resource-admission-runtime.ts");
        const lease = await acquireResourceLease({ reservationMB: 64, admissionBudgetMs: 500 });
        assert.equal(lease.reservedMB, 64);
        lease.release();
        assert.equal(getResourceAdmissionState().queued, 0);
        console.log("FIRST_SAMPLE_ACQUIRED");
    `);
    assertSuccessful(result);
    assert.match(result.stdout, /FIRST_SAMPLE_ACQUIRED/u);
});

for (const monitor of ["sample", "fallback", "stopped"]) {
    test(`an imported idle sampler (${monitor}) does not keep an otherwise idle process alive`, () => {
        const result = runSample(`
            await import(sourceRoot + "resource-admission-runtime.ts");
            console.log("IDLE_IMPORT_EXIT");
        `, { monitor });
        assertSuccessful(result);
        assert.match(result.stdout, /IDLE_IMPORT_EXIT/u);
    });
}

test("a completed acquisition no longer pins the process while its lease is held", () => {
    const result = runSample(`
        const { acquireResourceLease } = await import(sourceRoot + "resource-admission-runtime.ts");
        const lease = await acquireResourceLease({ reservationMB: 64, admissionBudgetMs: 500 });
        assert.equal(lease.reservedMB, 64);
        console.log("HELD_LEASE_CAN_EXIT");
    `);
    assertSuccessful(result);
    assert.match(result.stdout, /HELD_LEASE_CAN_EXIT/u);
});

test("admission timeout settles and releases its temporary keepalive", () => {
    const result = runSample(`
        const { acquireResourceLease, getResourceAdmissionState } = await import(sourceRoot + "resource-admission-runtime.ts");
        await assert.rejects(acquireResourceLease({ reservationMB: 64, admissionBudgetMs: 50 }), { code: "admission_timeout" });
        assert.equal(getResourceAdmissionState().queued, 0);
        console.log("TIMEOUT_SETTLED");
    `, { monitor: "none" });
    assertSuccessful(result);
    assert.match(result.stdout, /TIMEOUT_SETTLED/u);
});

test("one cancelled wait leaves another wait alive until its own deadline", () => {
    const result = runSample(`
        const { acquireResourceLease, getResourceAdmissionState } = await import(sourceRoot + "resource-admission-runtime.ts");
        const cancellation = new AbortController();
        setTimeout(() => cancellation.abort(), 25).unref();
        const first = assert.rejects(acquireResourceLease({ signal: cancellation.signal, admissionBudgetMs: 200 }), { code: "admission_aborted" });
        const second = assert.rejects(acquireResourceLease({ admissionBudgetMs: 70 }), { code: "admission_timeout" });
        await Promise.all([first, second]);
        assert.equal(getResourceAdmissionState().queued, 0);
        console.log("CANCEL_AND_TIMEOUT_SETTLED");
    `, { monitor: "none" });
    assertSuccessful(result);
    assert.match(result.stdout, /CANCEL_AND_TIMEOUT_SETTLED/u);
});

test("invalid and already-aborted requests do not leak keepalive handles", () => {
    const result = runSample(`
        const { acquireResourceLease } = await import(sourceRoot + "resource-admission-runtime.ts");
        await assert.rejects(acquireResourceLease({ reservationMB: -1 }), RangeError);
        await assert.rejects(acquireResourceLease({ signal: AbortSignal.abort() }), { code: "admission_aborted" });
        const lease = await acquireResourceLease({ control: true });
        lease.release();
        console.log("IMMEDIATE_PATHS_SETTLED");
    `, { monitor: "none" });
    assertSuccessful(result);
    assert.match(result.stdout, /IMMEDIATE_PATHS_SETTLED/u);
});

function lifecycleFixture(source, rows, additionalReplies = []) {
    return runSample(`
        process.argv[1] = "C:\\fixture dir\\中文,entry's.js";
        process.execArgv = [];
        const lifecycle = await import(sourceRoot + "lifecycle.ts");
        ${source}
    `, { processReplies: [rows, ...additionalReplies] });
}

function processRows(extra = {}) {
    return [
        { pid: "CURRENT", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "COMMAND", startedAt: "2026-01-01T00:00:01.000Z" },
        { pid: "PARENT", parentPid: 1, name: "language_server_windows_x64.exe", executablePath: "C:\\fixture\\language_server_windows_x64.exe", commandLine: "language_server", startedAt: "2026-01-01T00:00:00.000Z", ...extra },
    ];
}

function materializeRows(source, rows, additionalReplies = []) {
    const replacements = `
        for (const call of globalThis.processProbeCalls ?? []) assert.equal(call.options.timeout, 5000);
    `;
    return lifecycleFixture(source + replacements, rows, additionalReplies);
}

test("Windows process probes use bounded shellless CIM with legacy PowerShell fallback", () => {
    const result = materializeRows(`
        const status = await lifecycle.isAntigravityLS();
        assert.equal(status, true);
        const call = globalThis.processProbeCalls[0];
        assert.match(call.command, /powershell\.exe$/iu);
        assert.ok(!call.command.toLowerCase().includes("wmic"));
        assert.ok(call.args.includes("-NoProfile") && call.args.includes("-NonInteractive"));
        const script = Buffer.from(call.args.at(-1), "base64").toString("utf16le");
        assert.match(script, /Get-CimInstance/u);
        assert.match(script, /Get-WmiObject/u);
        assert.match(script, /CreationDate/u);
        assert.ok(call.options.maxBuffer <= 256 * 1024);
    `, processRows());
    assertSuccessful(result);
});

test("failed parent probes remain unknown and are retried instead of cached as non-LS", () => {
    const result = materializeRows(`
        assert.equal(await lifecycle.isAntigravityLS(), true);
        assert.equal(await lifecycle.isAntigravityLS(), false);
        assert.equal(globalThis.processProbeCalls.length, 2);
        assert.equal(await lifecycle.isAntigravityLS(), false);
        assert.equal(globalThis.processProbeCalls.length, 2);
    `, { error: "CIM query failed" }, [processRows({ name: "app-server.exe" })]);
    assertSuccessful(result);
});

test("PID reuse does not identify a replacement parent as the original LS", () => {
    const result = materializeRows(`
        assert.equal(await lifecycle.isAntigravityLS(), true);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
    `, processRows({ startedAt: "2026-01-01T00:00:02.000Z" }), [{ error: "unavailable" }]);
    assertSuccessful(result);
});

test("sibling retirement uses creation time and exact executable and entry script identity", () => {
    const result = materializeRows(`
        assert.equal(await lifecycle.hasNewerSiblingInstance(), true);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
    `, [...processRows(), { pid: "LOWER", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "COMMAND", startedAt: "2026-01-01T00:00:02.000Z" }], [
        [...processRows(), { pid: "HIGHER", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "COMMAND", startedAt: "2026-01-01T00:00:00.500Z" }],
        [...processRows(), { pid: "HIGHER", parentPid: "PARENT", name: "node.exe", executablePath: "C:\\other\\node.exe", commandLine: "COMMAND", startedAt: "2026-01-01T00:00:02.000Z" }],
        [...processRows(), { pid: "HIGHER", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "OTHER_COMMAND", startedAt: "2026-01-01T00:00:02.000Z" }],
        { error: "CIM unavailable" },
    ]);
    assertSuccessful(result);
});

test("malformed or incomplete process snapshots cannot trigger sibling retirement", () => {
    const result = materializeRows(`
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
    `, "invalid JSON", [[], [{ pid: 1234, parentPid: 1, name: "node.exe" }]]);
    assertSuccessful(result);
});

test("a matching preload or ordinary argument does not replace entry-script identity", () => {
    const result = materializeRows(`
        process.execArgv = ["--require", process.argv[1]];
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
    `, [...processRows(), { pid: "HIGHER", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "OTHER_COMMAND", startedAt: "2026-01-01T00:00:02.000Z" }]);
    assertSuccessful(result);
});

test("different parents and missing or equal creation times cannot retire an instance", () => {
    const candidate = { pid: "HIGHER", parentPid: "PARENT", name: "node.exe", executablePath: "EXECUTABLE", commandLine: "COMMAND", startedAt: "2026-01-01T00:00:02.000Z" };
    const result = materializeRows(`
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
    `, [...processRows(), { ...candidate, parentPid: 1 }], [
        [...processRows(), { ...candidate, startedAt: null }],
        [...processRows(), { ...candidate, startedAt: "2026-01-01T00:00:01.000Z" }],
    ]);
    assertSuccessful(result);
});

test("non-Windows lifecycle probes keep their existing no-query behavior", () => {
    const result = lifecycleFixture(`
        Object.defineProperty(process, "platform", { value: "linux" });
        assert.equal(await lifecycle.isAntigravityLS(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        assert.equal(globalThis.processProbeCalls.length, 0);
    `, []);
    assertSuccessful(result);
});

test("real Windows parent and sibling probes are read-only", { skip: process.platform !== "win32" }, () => {
    const result = runSample(`
        process.argv[1] = "C:\\fixture\\nonexistent-entry.mjs";
        const lifecycle = await import(sourceRoot + "lifecycle.ts");
        assert.equal(await lifecycle.isAntigravityLS(), false);
        assert.equal(await lifecycle.hasNewerSiblingInstance(), false);
        console.log("LIVE_WINDOWS_READ_ONLY_OK");
    `, { live: true });
    assertSuccessful(result);
    assert.match(result.stdout, /LIVE_WINDOWS_READ_ONLY_OK/u);
});
