import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "mcps/sandbox/src");
const localRequire = createRequire(path.join(root, "mcps/sandbox/package.json"));
const typescript = localRequire("typescript");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-launch-async-text-"));
const taskDirectory = path.join(fixture, "tasks");
fs.mkdirSync(taskDirectory);
let trackChunkReads = false;
let chunkReads = 0;
const readBursts = [];
const isolatedFs = { ...fs, readFileSync(filename, ...args) {
    if (trackChunkReads && path.dirname(String(filename)) === taskDirectory) chunkReads += 1;
    return fs.readFileSync(filename, ...args);
} };
const observedImmediate = (callback, ...args) => {
    if (trackChunkReads && chunkReads > 0) {
        readBursts.push(chunkReads);
        chunkReads = 0;
    }
    return setImmediate(callback, ...args);
};
const forbidden = () => { throw new Error("unexpected process/resource operation in isolated test"); };
const stubs = new Map([
    ["../lifecycle.js", { touchActivity() {}, formatElapsed: String, ensureModelVisibleToolResult: value => value }],
    ["../executor.js", { killProcessTree: forbidden }],
    ["../resource-admission-runtime.js", { acquireResourceLease: forbidden, adoptResourceLease: forbidden,
        resourceAdmission: { setRecoveryPending: forbidden }, serializeResourceAdmissionError: forbidden }],
    ["../windows-job-runner.js", { getWindowsJobRunnerPath: forbidden, hasWindowsJobRunner: () => false }],
    ["../memory-limits.js", { inferMemoryRequestMB: forbidden, PROCESS_TREE_MAX_MEMORY_MB: 4096, validateProcessTreeMemory: forbidden }],
]);
const cache = new Map();
const context = vm.createContext({ Buffer, TextDecoder, console, setTimeout, clearTimeout, setImmediate: observedImmediate,
    setInterval, clearInterval, process: { ...process, env: { SANDBOX_LAUNCH_DIR: fixture } } });
function loadSource(filename, extraExports = "") {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = fs.readFileSync(filename, "utf8") + extraExports;
    const compiled = typescript.transpileModule(source, { compilerOptions: {
        target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const importSource = specifier => {
        if (filename.endsWith(`${path.sep}tools${path.sep}launch.ts`) && stubs.has(specifier)) return stubs.get(specifier);
        if (specifier === "fs") return isolatedFs;
        if (specifier.startsWith(".")) return loadSource(path.resolve(path.dirname(filename), specifier.replace(/\.js$/u, ".ts")));
        return localRequire(specifier);
    };
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(importSource, module, module.exports);
    return module.exports;
}
const task = (id, overrides = {}) => ({ id, pid: 1, command: `fixture ${id}`, ownerId: "owner-alpha",
    cwd: fixture, stdoutLog: path.join(fixture, `${id}.stdout`), stderrLog: path.join(fixture, `${id}.stderr`),
    startTime: 1, status: "done", exitCode: 0, ...overrides });
const fingerprint = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
try {
    fs.writeFileSync(path.join(taskDirectory, "current.json"), JSON.stringify(task("current")));
    fs.writeFileSync(path.join(taskDirectory, "foreign.json"), JSON.stringify(task("foreign", { ownerId: "owner-beta" })));
    fs.writeFileSync(path.join(taskDirectory, "broken.json"), "{");
    fs.writeFileSync(path.join(taskDirectory, "gone.json"), JSON.stringify({ id: "gone", deleted: true }));
    for (let index = 0; index < 128; index += 1) {
        const id = `chunk-${String(index).padStart(3, "0")}`;
        fs.writeFileSync(path.join(taskDirectory, `${id}.json`), JSON.stringify(task(id, { ownerId: "owner-beta" })));
    }
    fs.writeFileSync(path.join(fixture, "registry.json"), JSON.stringify([
        task("current", { command: "obsolete" }), task("broken"), task("gone"), task("legacy"),
    ]));
    const tracked = [path.join(fixture, "registry.json"), ...fs.readdirSync(taskDirectory).map(name => path.join(taskDirectory, name))];
    const before = tracked.map(fingerprint);
    const launchFilename = path.join(sourceRoot, "tools/launch.ts");
    const launch = loadSource(launchFilename, "\nexport { readAllTasks, readAllTasksAsync, decodeLaunchLog, tailFile, pendingTaskWrites, writeTaskIfUnchanged, formatLaunchTaskElapsed };\n");
    launch.pendingTaskWrites.set("current", task("current", { command: "pending wins" }));
    const expected = JSON.stringify(launch.readAllTasks());
    const startedAt = performance.now();
    let actual;
    trackChunkReads = true;
    try { actual = await launch.readAllTasksAsync(); } finally { trackChunkReads = false; }
    const queryMs = performance.now() - startedAt;
    assert.equal(JSON.stringify(actual), expected);
    assert.equal(actual.length, 131);
    assert.deepEqual(Array.from(actual.filter(value => !value.id.startsWith("chunk-")), value => value.id), ["current", "foreign", "legacy"]);
    const owner = loadSource(path.join(sourceRoot, "owner.ts"));
    assert.deepEqual(Array.from(actual.filter(value => owner.hasOwnerAccess(value.ownerId, "owner-alpha")), value => value.id), ["current", "legacy"]);
    assert.deepEqual(readBursts, [64, 64, 4]);
    assert.equal(chunkReads, 0);
    assert.deepEqual(tracked.map(fingerprint), before);
    assert.match(fs.readFileSync(launchFilename, "utf8"), /\(await readAllTasksAsync\(\)\)\.filter/u);
    const stale = task("stale", { status: "running", exitCode: null });
    const stalePath = path.join(taskDirectory, "stale.json");
    fs.writeFileSync(stalePath, JSON.stringify(stale));
    const staleSnapshot = (await launch.readAllTasksAsync()).find(value => value.id === "stale");
    const deleted = { id: "stale", deleted: true, deletedAtMs: 1 };
    fs.writeFileSync(stalePath, JSON.stringify(deleted));
    assert.equal(launch.writeTaskIfUnchanged({ ...staleSnapshot, status: "done", exitCode: 0 }, JSON.stringify(staleSnapshot)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(stalePath, "utf8")), deleted);
    assert.ok(fs.readFileSync(launchFilename, "utf8").includes("if (await refreshTaskStatusAsync(task) || task.registryWriteError) writeTaskIfUnchanged(task, beforeRefresh);"));
    const fixedNow = 10_000;
    for (const status of ["done", "failed"]) {
        const completed = task(`elapsed-${status}`, { status, startTime: 1_000, finishedAtMs: 3_000 });
        const completedBefore = JSON.stringify(completed);
        assert.equal(launch.formatLaunchTaskElapsed(completed, fixedNow), "2000");
        assert.equal(launch.formatLaunchTaskElapsed(completed, fixedNow + 60_000), "2000");
        assert.equal(JSON.stringify(completed), completedBefore);
        for (const finishedAtMs of [undefined, null, "3000", NaN, Infinity, -Infinity, 999]) {
            const invalid = task(`elapsed-invalid-${status}`, { status, startTime: 1_000, finishedAtMs });
            assert.equal(launch.formatLaunchTaskElapsed(invalid, fixedNow), "结束时间未知");
            assert.equal(launch.formatLaunchTaskElapsed(invalid, fixedNow + 60_000), "结束时间未知");
        }
    }
    const running = task("elapsed-running", { status: "running", startTime: 1_000, finishedAtMs: 3_000 });
    assert.equal(launch.formatLaunchTaskElapsed(running, fixedNow), "9000");
    assert.equal(launch.formatLaunchTaskElapsed(running, fixedNow + 1_000), "10000");
    assert.equal(launch.formatLaunchTaskElapsed(task("elapsed-zero", { startTime: 1_000, finishedAtMs: 1_000 }), fixedNow), "0");
    assert.equal(launch.formatLaunchTaskElapsed(task("elapsed-invalid-start", { startTime: NaN, finishedAtMs: 3_000 }), fixedNow), "结束时间未知");
    assert.equal(launch.formatLaunchTaskElapsed(task("elapsed-overflow", { startTime: -Number.MAX_VALUE, finishedAtMs: Number.MAX_VALUE }), fixedNow), "结束时间未知");
    const launchSource = fs.readFileSync(launchFilename, "utf8");
    assert.match(launchSource, /const lines = visibleTasks\.map\(t => \{\s+const elapsed = formatLaunchTaskElapsed\(t\);/u);
    assert.match(launchSource, /const elapsed = formatLaunchTaskElapsed\(task\);\s+const logTail = tailFile/u);
    const utf8 = Buffer.from("正常 UTF-8 中文执行 😀\r\n", "utf8");
    assert.equal(launch.decodeLaunchLog(utf8).text, utf8.toString("utf8"));
    const colored = Buffer.from("\u001b[32m正常中文\u001b[0m\u001b]0;title\u0007\r\n", "utf8");
    assert.equal(launch.decodeLaunchLog(colored).text, "正常中文\r\n");
    const partialUtf8 = Buffer.concat([Buffer.from("完整中文\n", "utf8"), Buffer.from([0xe4, 0xb8])]);
    assert.equal(launch.decodeLaunchLog(partialUtf8).text, "完整中文\n");
    assert.match(launch.decodeLaunchLog(partialUtf8).notice, /UTF-8.*完整前缀/u);
    assert.equal(launch.decodeLaunchLog(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0xe4, 0xb8])).text, "A");
    assert.equal(launch.decodeLaunchLog(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0xff, 0x42])).text, null);
    const original = Buffer.from("545241494e494e475f313139395f53484f52545f5441534b5f4f4b20d6d0cec4d6b4d0d00d0a", "hex");
    assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(original));
    const decoded = launch.decodeLaunchLog(original);
    assert.equal(decoded.text, "TRAINING_1199_SHORT_TASK_OK 中文执行\r\n");
    assert.match(decoded.notice, /GB18030.*推测/u);
    const coloredOriginal = Buffer.concat([Buffer.from("\u001b[32m"), original, Buffer.from("\u001b[0m")]);
    assert.equal(launch.decodeLaunchLog(coloredOriginal).text, decoded.text);
    assert.equal(launch.decodeLaunchLog(Buffer.from([0, 255, 1])).text, null);
    assert.equal(launch.decodeLaunchLog(Buffer.from([0x81])).text, null);
    const logPath = path.join(fixture, "original.stdout");
    fs.writeFileSync(logPath, original);
    const logHash = fingerprint(logPath);
    assert.match(launch.tailFile(logPath, 10), /TRAINING_1199_SHORT_TASK_OK 中文执行/u);
    assert.equal(fingerprint(logPath), logHash);
    console.log(JSON.stringify({ ok: true, node: process.version, queryMs: Number(queryMs.toFixed(1)), readBursts,
        fixtureFiles: tracked.length, originalBytes: original.length, originalSha256: logHash,
        coverage: "registry parity/authoritative-corruption/tombstone/pending/owner/timer/terminal-elapsed/running-elapsed/unknown-end/list-status-elapsed-wiring/utf8/gb18030/binary/unchanged-log" }));
} finally {
    const resolved = fs.realpathSync(fixture);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("sandbox-launch-async-text-"));
    for (const name of fs.readdirSync(taskDirectory)) fs.unlinkSync(path.join(taskDirectory, name));
    fs.rmdirSync(taskDirectory);
    for (const name of fs.readdirSync(fixture)) fs.unlinkSync(path.join(fixture, name));
    fs.rmdirSync(fixture);
}
