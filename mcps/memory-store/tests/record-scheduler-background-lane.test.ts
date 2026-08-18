import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-background-lane-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_UPDATE_BACKGROUND_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY = "1";

const { PROVIDER_CONTROL_PHYSICAL_MAX } = await import("../src/provider-control-contracts.ts");
const {
    getBackgroundTask,
    getBackgroundTaskQueueLaneStatsForTest,
    resetBackgroundTaskQueueForTest,
    startBackgroundTask,
    startRecordSchedulerBackgroundTask,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");
const schedulerContracts = await import("../src/record-scheduler-contracts.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");

type RecordSchedulerTaskKind = "record-update" | "record-batch-update";
type RecordSchedulerLane = "recordUpdate" | "recordBatchUpdate";

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
    }
    assert.fail(`等待超时: ${label}`);
}

function makeSchedulerLedger(taskId: string, taskKind: RecordSchedulerTaskKind) {
    const timestamp = new Date().toISOString();
    const requestSummary = { source: "record-scheduler-background-lane", taskId, taskKind };
    const backgroundProjection = {};
    const admissionIdentity = {
        requestKey: `record-scheduler-background-lane:${taskKind}:${taskId}`,
        requestHash: schedulerStore.calculateRecordSchedulerAdmissionRequestHash(taskKind, requestSummary, backgroundProjection),
    };
    return {
        schemaVersion: schedulerContracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger" as const,
        revision: 1,
        persistedHash: "placeholder",
        task: {
            taskId,
            schedulerEpoch: 1,
            state: "Accepted" as const,
            requestMode: taskKind === "record-update" ? "update" as const : "batch_update" as const,
            candidateSnapshotId: `${taskId}-candidate`,
            candidateSnapshotRevision: 1,
            admissionIdentity,
            admission: { state: "LedgerCreated" as const },
            createdAt: timestamp,
            updatedAt: timestamp,
            repairState: "None" as const,
            recordItems: { total: 0, succeeded: 0, failed: 0, unresolved: 0 },
            units: { materialized: 0, eligible: 0, running: 0, done: 0, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot: {
            schemaVersion: schedulerContracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            snapshotId: `${taskId}-candidate`,
            snapshotRevision: 1,
            snapshotHash: `${taskId}-candidate-hash`,
            snapshotRef: { path: `record-scheduler-background-lane/${taskId}/candidate.json`, hash: `${taskId}-candidate-hash`, byteLength: 0 },
            createdAt: timestamp,
            requestMode: "normal" as const,
            filters: {},
            enumerations: [{ chain: "codex" as const, complete: true, paginationExhausted: true, truncated: false }],
            candidates: [],
        },
        sourceSnapshots: [],
        recordWork: [],
        units: [],
        attempts: [],
        commits: [],
    };
}

async function createSchedulerAdmission(taskId: string, taskKind: RecordSchedulerTaskKind) {
    const initialLedger = makeSchedulerLedger(taskId, taskKind);
    const stored = await schedulerStore.createRecordSchedulerLedger(initialLedger);
    const ledgerAnchor = schedulerStore.createSchedulerLedgerAnchor(stored);
    const capsule = await schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId,
        taskKind,
        admissionIdentity: initialLedger.task.admissionIdentity,
        ledgerAnchor,
        requestSummary: { source: "record-scheduler-background-lane", taskId, taskKind },
        backgroundProjection: {},
    });
    await schedulerStore.bindRecordSchedulerAdmission(taskId, stored.revision, ledgerAnchor, capsule.ref);
    const verified = await schedulerStore.verifyOrRecoverTaskAdmission(taskId);
    assert.equal(verified.kind, "verified", `scheduler admission 应可验证: ${taskId}`);
    if (verified.kind !== "verified") throw new Error(`scheduler admission verification failed: ${taskId}`);
    return verified.receipt;
}

async function assertRecordSchedulerLaneWindow(taskKind: RecordSchedulerTaskKind, lane: RecordSchedulerLane): Promise<void> {
    resetBackgroundTaskQueueForTest();
    const gates = Array.from({ length: PROVIDER_CONTROL_PHYSICAL_MAX + 1 }, () => deferred());
    const started: number[] = [];
    const tasks = await Promise.all(gates.map(async (gate, index) => {
        const taskId = `record-scheduler-background-lane-${taskKind}-${index}`;
        const admissionReceipt = await createSchedulerAdmission(taskId, taskKind);
        return startRecordSchedulerBackgroundTask(taskKind, async () => {
            started.push(index);
            await gate.promise;
            return `${taskKind}-${index}`;
        }, { admissionReceipt });
    }));

    await waitUntil(`${taskKind} 前 ${PROVIDER_CONTROL_PHYSICAL_MAX} 个 callback 进入`, () => started.length === PROVIDER_CONTROL_PHYSICAL_MAX);
    assert.equal(started.length, PROVIDER_CONTROL_PHYSICAL_MAX, `${taskKind} 的第 ${PROVIDER_CONTROL_PHYSICAL_MAX + 1} 个 callback 必须仍等待`);
    assert.deepEqual(
        getBackgroundTaskQueueLaneStatsForTest(),
        {
            default: { active: 0, pending: 0 },
            recordUpdate: lane === "recordUpdate"
                ? { active: PROVIDER_CONTROL_PHYSICAL_MAX, pending: 1 }
                : { active: 0, pending: 0 },
            recordBatchUpdate: lane === "recordBatchUpdate"
                ? { active: PROVIDER_CONTROL_PHYSICAL_MAX, pending: 1 }
                : { active: 0, pending: 0 },
        },
        `${taskKind} 必须只占用 ${lane} 的有界窗口`,
    );

    const queuedTask = tasks.find((_task, index) => !started.includes(index));
    assert.equal(queuedTask?.status, "running", "第 9 个任务在排队时仍必须可由 task_status 查询");
    assert.equal(queuedTask?.progress?.stage, "queued", "第 9 个任务不能在未获 lane 时误报 running callback");

    const releasedIndex = started[0];
    gates[releasedIndex].resolve();
    await waitUntil(`${taskKind} 第 9 个 callback 在释放后继续`, () => started.length === PROVIDER_CONTROL_PHYSICAL_MAX + 1);

    for (const gate of gates) gate.resolve();
    const settled = await Promise.all(tasks.map(task => waitForBackgroundTask(task.id, 3)));
    assert.deepEqual(
        settled.map(task => task?.status),
        Array.from({ length: PROVIDER_CONTROL_PHYSICAL_MAX + 1 }, () => "done"),
        `${taskKind} 释放 gate 后应正常结算，不能影响 task_status/control plane`,
    );
}

try {
    await assertRecordSchedulerLaneWindow("record-update", "recordUpdate");
    await assertRecordSchedulerLaneWindow("record-batch-update", "recordBatchUpdate");

    resetBackgroundTaskQueueForTest();
    const defaultGates = [deferred(), deferred()];
    const defaultStarted: number[] = [];
    const defaultTasks = defaultGates.map((gate, index) => startBackgroundTask("ordinary-background-task", async () => {
        defaultStarted.push(index);
        await gate.promise;
        return `ordinary-${index}`;
    }, { maxRunMs: 5_000 }));
    await waitUntil("非 Record default lane 仍只启动一个任务", () => defaultStarted.length === 1);
    assert.deepEqual(
        getBackgroundTaskQueueLaneStatsForTest(),
        {
            default: { active: 1, pending: 1 },
            recordUpdate: { active: 0, pending: 0 },
            recordBatchUpdate: { active: 0, pending: 0 },
        },
        "MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY=1 仍只限制非 Record default lane",
    );
    defaultGates[0].resolve();
    await waitUntil("释放 default lane 后第二个任务继续", () => defaultStarted.length === 2);
    defaultGates[1].resolve();
    const defaultSettled = await Promise.all(defaultTasks.map(task => waitForBackgroundTask(task.id, 3)));
    assert.deepEqual(defaultSettled.map(task => task?.status), ["done", "done"]);

    console.log("✅ record scheduler background lanes keep an 8-task bounded window without becoming provider model permits");
} finally {
    resetBackgroundTaskQueueForTest();
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    delete process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY;
    delete process.env.MEMORY_STORE_RECORD_UPDATE_BACKGROUND_CONCURRENCY;
    delete process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY;
}
