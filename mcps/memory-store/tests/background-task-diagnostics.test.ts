import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-task-diagnostics-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
const tasks = await import("../src/background-tasks.js");
const identity = { guardId: "synthetic-guard", conversationId: "synthetic-conversation", stageId: "synthetic-stage", childScopeId: "integration" };
const releases: Array<() => void> = [];
const taskIds: string[] = [];
let completed = false;

function makeReference(taskId: string, guardId = identity.guardId) {
    const callId = crypto.randomUUID();
    const directory = path.join(fixtureRoot, "model-bridge-diagnostics", "codex", callId);
    fs.mkdirSync(directory, { recursive: true });
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.stringify({ callId, metadata: { context: { backgroundTaskId: taskId, guardId } }, outcome: { cancelled: true } });
    fs.writeFileSync(manifestPath, manifest, "utf8");
    return { callId, manifestPath, manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), eventCoverage: "partial" as const, rejectedCommandCount: 0 };
}

async function runTerminalCase(kind: "cancelled" | "error") {
    const taskId = `synthetic-guard-diagnostics-${kind}`;
    taskIds.push(taskId);
    let release = () => {};
    let finished = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    tasks.startBackgroundTask("stage-guard-check", async () => {
        await gate;
        finished = true;
        return "late success must not replace terminal result";
    }, { taskId, maxRunMs: kind === "error" ? 100 : 10000, resumePayload: { version: 2, ...identity } });
    assert.equal(tasks.bindBackgroundTaskDiagnostics(taskId, { ...identity, guardId: "wrong-guard" }), false);
    assert.equal(tasks.bindBackgroundTaskDiagnostics(taskId, identity), true);
    assert.equal(tasks.readBackgroundTaskDiagnostics(taskId)?.references.length, 0);
    const file = path.join(fixtureRoot, "tasks", `${taskId}.json`);
    if (kind === "cancelled") tasks.cancelBackgroundTask(taskId, "synthetic cancellation");
    else await tasks.waitForBackgroundTask(taskId, 2);
    assert.equal(tasks.getBackgroundTask(taskId)?.status, kind);
    const terminalFile = fs.readFileSync(file, "utf8");
    const terminal = JSON.parse(terminalFile);
    assert.ok(terminal.finishedAt);
    assert.ok(terminal.error);
    if (kind === "error") assert.equal(terminal.timedOut, true);
    const reference = makeReference(taskId);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, "wrong-guard", reference), false);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, { ...reference, manifestPath: path.join(fixtureRoot, "outside.json") }), false);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, { ...reference, manifestSha256: "0".repeat(64) }), false);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, makeReference("wrong-task")), false);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, { ...reference, callId: "../escape" }), false);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, { ...reference, command: "synthetic-field-must-not-be-stored", captureError: "x".repeat(900) } as any), true);
    assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, reference), true);
    assert.equal(tasks.readBackgroundTaskDiagnostics(taskId)?.references.length, 1);
    assert.equal(tasks.readBackgroundTaskDiagnostics(taskId)?.references[0].captureError?.length, 512);
    const diagnosticFile = path.join(fixtureRoot, "task-diagnostics", `${taskId}.json`);
    assert.doesNotMatch(fs.readFileSync(diagnosticFile, "utf8"), /synthetic-field-must-not-be-stored/u);
    for (let referenceIndex = 1; referenceIndex < 9; referenceIndex++) {
        assert.equal(tasks.appendBackgroundTaskDiagnostic(taskId, identity.guardId, makeReference(taskId)), true);
    }
    assert.equal(tasks.readBackgroundTaskDiagnostics(taskId)?.references.length, 8);
    assert.equal(tasks.readBackgroundTaskDiagnostics(taskId)?.omittedReferences, 1);
    assert.equal(fs.readFileSync(file, "utf8"), terminalFile);
    tasks.__testEvictFromMemory(taskId);
    const reloaded = tasks.getBackgroundTask(taskId)!;
    assert.equal(reloaded.status, terminal.status);
    assert.equal(reloaded.finishedAt, terminal.finishedAt);
    assert.equal(reloaded.error, terminal.error);
    assert.ok(tasks.formatBackgroundTask(reloaded).includes(reference.manifestPath));
    assert.ok(tasks.formatBackgroundTask(reloaded).includes(`taskId=${taskId}`));
    assert.match(tasks.formatBackgroundTask(reloaded), /另有 1 项诊断引用超出展示上限/u);
    release();
    for (let attempt = 0; attempt < 100 && !finished; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(finished, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.readFileSync(file, "utf8"), terminalFile);
    console.log(`PASS ${kind}: identity bound before work, late restricted diagnostic persisted independently, original task bytes/status/finishedAt/error unchanged, duplicate idempotent, disk reload and formatted original task expose manifest`);
}

try {
    await runTerminalCase("cancelled");
    await runTerminalCase("error");
    assert.equal(tasks.readBackgroundTaskDiagnostics("../invalid"), null);
    assert.equal(tasks.bindBackgroundTaskDiagnostics("../invalid", identity), false);
    console.log("PASS background task diagnostics: cross-task/guard/path/hash rejection, bounded metadata and no arbitrary model text persisted");
    completed = true;
} finally {
    for (const release of releases) release();
    for (const taskId of taskIds) tasks.cancelBackgroundTask(taskId);
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()));
    const assertNoLinks = (directory: string) => {
        assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filePath = path.resolve(directory, entry.name);
            assert.ok(filePath.startsWith(path.resolve(fixtureRoot) + path.sep));
            assert.equal(fs.lstatSync(filePath).isSymbolicLink(), false);
            if (entry.isDirectory()) assertNoLinks(filePath);
        }
    };
    if (completed) {
        assertNoLinks(fixtureRoot);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        assert.equal(fs.existsSync(fixtureRoot), false);
    } else {
        console.error(`FAILED fixture preserved for evidence: ${fixtureRoot}`);
    }
}
