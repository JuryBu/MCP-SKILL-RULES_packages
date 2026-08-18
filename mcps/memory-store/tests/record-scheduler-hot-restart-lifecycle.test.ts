import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const childFixture = path.resolve("tests/fixtures/record-scheduler-hot-restart-lifecycle-child.mjs");
const workerTimeoutMs = 15_000;

type ChildResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    elapsedMs: number;
};

type ReadyMessage = {
    type: "ready";
    taskId: string;
    oldOwnerLease: Record<string, unknown>;
    oldOwnerEpoch: number;
    routeContractAccepted: boolean;
};

type SpawnedChild = {
    child: ReturnType<typeof spawn>;
    stdout: { value: string };
    stderr: { value: string };
    startedAt: number;
};

function findJsonLine<Value extends { type: string }>(stdout: string, type: Value["type"]): Value {
    const line = stdout.split(/\r?\n/u).find(candidate => {
        try {
            return (JSON.parse(candidate) as { type?: string }).type === type;
        } catch {
            return false;
        }
    });
    assert.ok(line, `missing child message type=${type}: ${stdout}`);
    return JSON.parse(line) as Value;
}

function waitForMessage<Message extends { type: string }>(
    child: ReturnType<typeof spawn>,
    stdout: { value: string },
    stderr: { value: string },
    type: Message["type"],
): Promise<Message> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`lifecycle child did not emit ${type}\nstdout=${stdout.value}\nstderr=${stderr.value}`));
        }, workerTimeoutMs);
        const inspect = () => {
            try {
                const message = findJsonLine<Message>(stdout.value, type);
                clearTimeout(timeout);
                resolve(message);
            } catch {
                // Child output can arrive in arbitrary chunks; wait for the complete JSON line.
            }
        };
        child.stdout?.on("data", inspect);
        child.once("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("exit", () => {
            clearTimeout(timeout);
            try {
                resolve(findJsonLine<Message>(stdout.value, type));
            } catch {
                reject(new Error(`lifecycle child exited before ${type}\nstdout=${stdout.value}\nstderr=${stderr.value}`));
            }
        });
    });
}

function waitForReady(child: ReturnType<typeof spawn>, stdout: { value: string }, stderr: { value: string }): Promise<ReadyMessage> {
    return waitForMessage<ReadyMessage>(child, stdout, stderr, "ready");
}

function waitForExit(child: ReturnType<typeof spawn>, startedAt: number, stdout: { value: string }, stderr: { value: string }): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`lifecycle child exceeded ${workerTimeoutMs}ms\nstdout=${stdout.value}\nstderr=${stderr.value}`));
        }, workerTimeoutMs);
        child.once("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout: stdout.value, stderr: stderr.value, elapsedMs: Date.now() - startedAt });
        });
    });
}

function startRecoveryChild(dataRoot: string, ready: ReadyMessage): SpawnedChild {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", childFixture, "recover", JSON.stringify(ready)], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MEMORY_STORE_DATA_ROOT: dataRoot,
            MEMORY_STORE_RECORD_SCHEDULER_RECOVERY_WATCH_POLL_MS: "25",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = { value: "" };
    const stderr = { value: "" };
    child.stdout?.on("data", chunk => { stdout.value += String(chunk); });
    child.stderr?.on("data", chunk => { stderr.value += String(chunk); });
    return { child, stdout, stderr, startedAt };
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-hot-restart-lifecycle-"));
let ownerChild: ReturnType<typeof spawn> | undefined;
let recoveryChild: SpawnedChild | undefined;
try {
    ownerChild = spawn(process.execPath, ["--import", "tsx", childFixture, "hold"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MEMORY_STORE_DATA_ROOT: dataRoot,
            MEMORY_STORE_SHUTDOWN_TIMEOUT_MS: "1000",
            MEMORY_STORE_SCHEDULER_SHUTDOWN_TIMEOUT_MS: "400",
            MEMORY_STORE_PROVIDER_SHUTDOWN_TIMEOUT_MS: "120",
            MEMORY_STORE_LEGACY_CLEANUP_TIMEOUT_MS: "80",
            MEMORY_STORE_RECORD_SCHEDULER_RECOVERY_WATCH_POLL_MS: "25",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = { value: "" };
    const stderr = { value: "" };
    ownerChild.stdout?.on("data", chunk => { stdout.value += String(chunk); });
    ownerChild.stderr?.on("data", chunk => { stderr.value += String(chunk); });
    const ready = await waitForReady(ownerChild, stdout, stderr);
    assert.ok(Number.isSafeInteger(ready.oldOwnerEpoch) && ready.oldOwnerEpoch > 0, "holder child must publish a valid scheduler owner epoch");
    assert.equal(ready.routeContractAccepted, true, "holder child must pass the full current production-pump route call contract");

    recoveryChild = startRecoveryChild(dataRoot, ready);
    const watching = await waitForMessage<{
        type: "watching";
        taskId: string;
        startupOutcome: string | null;
        startupReason: string | null;
        controlTaskId: string | null;
        controlStatus: string | null;
        watchTaskIds: string[];
        handlerCalls: number;
        runCalls: number;
    }>(recoveryChild.child, recoveryChild.stdout, recoveryChild.stderr, "watching");
    assert.equal(watching.taskId, ready.taskId, "recovery child must observe the original taskId");
    assert.equal(watching.startupOutcome, "loaded", `startup recovery must only observe the live foreign owner: ${recoveryChild.stdout.value}\n${recoveryChild.stderr.value}`);
    assert.match(watching.startupReason || "", /watch\/rescan/u, "startup recovery must register watch/rescan instead of competing for the owner lease");
    assert.equal(watching.controlTaskId, ready.taskId, "control plane must expose the watched task while the old child is alive");
    assert.equal(watching.controlStatus, "running", "control plane must remain readable during the foreign-owner wait");
    assert.deepEqual(watching.watchTaskIds, [ready.taskId], "recovery child must register exactly one same-task watch");
    assert.equal(watching.handlerCalls, 0, "watch registration must not begin recovery before the old owner exits");
    assert.equal(watching.runCalls, 0, "watch registration must not execute the recovery callback before takeover");

    const terminationStartedAt = Date.now();
    ownerChild.kill("SIGKILL");
    const result = await waitForExit(ownerChild, terminationStartedAt, stdout, stderr);
    assert.ok(result.elapsedMs < 4_000, `abrupt old-owner termination must not delay watcher takeover: ${result.elapsedMs}ms\n${result.stderr}`);

    const recovery = await waitForExit(recoveryChild.child, recoveryChild.startedAt, recoveryChild.stdout, recoveryChild.stderr);
    assert.equal(recovery.code, 0, `recovery child must finish the watcher-driven handoff: ${recovery.stderr}`);
    const recovered = findJsonLine<{
        type: "recovered";
        taskId: string;
        persistedKind: string;
        taskState: string | null;
        recoveryOwnerId: string | null;
        recoveryEpoch: number | null;
        controlStatus: string | null;
        watchTaskIds: string[];
        handlerCalls: number;
        runCalls: number;
        staleRejected: boolean;
        staleMutatorRan: boolean;
    }>(recovery.stdout, "recovered");
    assert.equal(recovered.taskId, ready.taskId, "watcher-driven recovery must retain the original taskId");
    assert.equal(recovered.persistedKind, "current", "recovery must retain a readable durable ledger");
    assert.equal(recovered.taskState, "Cancelled", "watcher-driven recovery must terminally cancel the unprovable provider invocation without claiming success");
    assert.equal(recovered.recoveryOwnerId, "lifecycle-hot-restart-recovery-owner", "recovery child must become the new scheduler owner");
    assert.equal(recovered.recoveryEpoch, ready.oldOwnerEpoch + 1, "takeover must advance the scheduler epoch exactly once");
    assert.equal(recovered.controlStatus, "done", "recovery child must expose the terminal task through the control plane");
    assert.deepEqual(recovered.watchTaskIds, [], "watch must clear after the automatic terminal handoff");
    assert.equal(recovered.handlerCalls, 1, "old child termination must trigger exactly one recovery handler");
    assert.equal(recovered.runCalls, 1, "old child termination must run exactly one automatic recovery callback");
    assert.equal(recovered.staleRejected, true, "old owner fence mutation must be rejected after recovery");
    assert.equal(recovered.staleMutatorRan, false, "old owner must not reach a mutation callback after recovery");
    console.log("record scheduler hot restart lifecycle tests passed");
} finally {
    if (recoveryChild?.child.exitCode === null) recoveryChild.child.kill("SIGKILL");
    if (ownerChild?.exitCode === null) ownerChild.kill("SIGKILL");
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
