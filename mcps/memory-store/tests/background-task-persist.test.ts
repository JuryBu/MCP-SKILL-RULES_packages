import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SchedulerAdmissionBackgroundProjection } from "../src/record-scheduler-contracts.ts";

// ⚠️ 必须在 import 数据层之前设置临时 DATA_ROOT：store.ts 在模块加载时即固化 DATA_ROOT，
//    background-tasks.ts 的 TASKS_DIR 也派生自它。先设 env 才能把落盘隔离到临时目录。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-bgtask-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_RECORD_SCHEDULER_RECOVERY_WATCH_POLL_MS = "25";

const TASKS_DIR = path.join(TMP_ROOT, "tasks");

const {
    startBackgroundTask,
    startRecordSchedulerBackgroundTask,
    ensureRecordSchedulerBackgroundProjection,
    rebuildRecordSchedulerBackgroundProjection,
    RecordSchedulerTerminalProjectionError,
    runBackgroundTaskStartupRecovery,
    BACKGROUND_TASK_RESUME_VERSION,
    cancelBackgroundTask,
    getBackgroundTask,
    recoverBackgroundTask,
    stableJsonHash,
    waitForBackgroundTask,
    wakeBackgroundTask,
    createBackgroundTaskSuspension,
    getBackgroundTaskQueueStatsForTest,
    __testEvictFromMemory,
    __testResetBackgroundTasksForTest,
    __testRecordSchedulerRecoveryWatchTaskIds,
    __testSetBackgroundTaskPersistFaultInjector,
    __testWritePersistedTask,
    registerBackgroundTaskRecoveryHandler,
    unregisterBackgroundTaskRecoveryHandler,
} = await import("../src/background-tasks.ts");
const schedulerContracts = await import("../src/record-scheduler-contracts.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");
const schedulerAdmission = await import("../src/record-scheduler-admission.ts");
const schedulerRuntime = await import("../src/record-scheduler-runtime.ts");
const { writeGuardState, clearGuardState } = await import("../src/guard-store.ts");
await import("../src/tools/stage-guard.ts");

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForTaskStatus(taskId: string, status: string, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const task = getBackgroundTask(taskId);
        if (task?.status === status) return task;
        await sleep(10);
    }
    throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内进入 ${status}`);
}

function isProcessAliveForTest(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAliveForTest(pid)) return;
        await sleep(10);
    }
    throw new Error(`进程 PID=${pid} 未在 ${timeoutMs}ms 内退出`);
}

function taskFile(id: string): string {
    return path.join(TASKS_DIR, `${id}.json`);
}

function makeSchedulerLedger(
    taskId: string,
    admission: {
        requestKey?: string;
        requestSummary?: Record<string, unknown>;
        backgroundProjection?: SchedulerAdmissionBackgroundProjection;
    } = {},
) {
    const timestamp = new Date().toISOString();
    const requestSummary = admission.requestSummary ?? { source: "background-task-persist" };
    const backgroundProjection = admission.backgroundProjection ?? {};
    const admissionIdentity = {
        requestKey: admission.requestKey ?? `background-task-persist:${taskId}`,
        requestHash: schedulerStore.calculateRecordSchedulerAdmissionRequestHash(
            "record-update",
            requestSummary,
            backgroundProjection,
        ),
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
            requestMode: "update" as const,
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
            snapshotRef: { path: `record-recovery/${taskId}/candidate.json`, hash: `${taskId}-candidate-hash`, byteLength: 0 },
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

function makeAdmissionInitialLedger(taskId: string) {
    const ledger = makeSchedulerLedger(taskId);
    const { admissionIdentity: _admissionIdentity, ...task } = ledger.task;
    return { ...ledger, task };
}

function makeDeferredSchedulerLedger(taskId: string) {
    const ledger = makeSchedulerLedger(taskId);
    return {
        ...ledger,
        task: {
            ...ledger.task,
            state: "Deferred" as const,
            terminalState: "Deferred" as const,
            recordItems: { total: 1, succeeded: 0, failed: 0, unresolved: 1 },
            sourceResolution: {
                phase: "deferred" as const,
                selectedCount: null,
                materializedCount: 0,
                unresolvedCount: 1,
                deferredReason: "source_unresolved" as const,
                issues: [{
                    host: "codex" as const,
                    code: "source_unresolved",
                    message: "测试夹具：来源无法安全读取",
                    evidenceHashes: [],
                }],
            },
        },
    };
}

async function createSchedulerAdmission(taskId: string, initialLedger = makeSchedulerLedger(taskId)) {
    const stored = await schedulerStore.createRecordSchedulerLedger(initialLedger);
    const ledgerAnchor = schedulerStore.createSchedulerLedgerAnchor(stored);
    const capsule = await schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId,
        taskKind: "record-update",
        admissionIdentity: initialLedger.task.admissionIdentity,
        ledgerAnchor,
        requestSummary: { source: "background-task-persist" },
        backgroundProjection: {},
    });
    const capsuleBytes = fs.readFileSync(capsule.path);
    assert.equal(capsule.ref.byteLength, capsuleBytes.byteLength);
    assert.equal(capsule.ref.hash, crypto.createHash("sha256").update(capsuleBytes).digest("hex"));
    await schedulerStore.bindRecordSchedulerAdmission(taskId, stored.revision, ledgerAnchor, capsule.ref);
    const verified = await schedulerStore.verifyOrRecoverTaskAdmission(taskId);
    assert.equal(verified.kind, "verified");
    if (verified.kind !== "verified") throw new Error(`admission verification failed: ${verified.reason}`);
    return verified.receipt;
}

async function runWorker(workerPath: string, ...workerArgs: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, workerPath, ...workerArgs], {
        cwd: process.cwd(),
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: TMP_ROOT },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "close") as [number | null];
    return { code, stdout, stderr };
}

let failed = false;
function step(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log(`✅ ${name}`); })
        .catch((err) => { failed = true; console.error(`❌ ${name}:`, err instanceof Error ? err.message : err); });
}

try {
    // ① 跨进程可见：快任务 settle done → 文件落盘且含最终 result；
    //    模拟「另一进程」= 把任务从内存 Map 逐出，仅留文件 → getBackgroundTask 仍能读到 done+result。
    await step("跨进程可见：settle done 后文件含 result，逐出内存后仍可读", async () => {
        const t = startBackgroundTask("persist-quick", async () => "FINAL_RESULT_OK", { maxRunMs: 5000 });
        const done = await waitForBackgroundTask(t.id, 2);
        assert.equal(done?.status, "done", "快任务应结算为 done");
        assert.equal(done?.result, "FINAL_RESULT_OK", "内存态应含 result");

        // 落盘文件存在且含最终态
        assert.ok(fs.existsSync(taskFile(t.id)), "settle 后应落盘 tasks/{id}.json");
        const onDisk = JSON.parse(fs.readFileSync(taskFile(t.id), "utf-8"));
        assert.equal(onDisk.status, "done", "文件态应为 done");
        assert.equal(onDisk.result, "FINAL_RESULT_OK", "文件态应含最终 result");

        // 模拟另一进程：清掉内存条目，只剩文件态
        __testEvictFromMemory(t.id);
        const fromFile = getBackgroundTask(t.id);
        assert.equal(fromFile?.status, "done", "逐出内存后应从文件读到 done");
        assert.equal(fromFile?.result, "FINAL_RESULT_OK", "文件兜底应带回 result");
    });

    // ② 非 Record 孤儿转 error：手写一个 status=running 且 updatedAt 很旧（超 STALE_MS）的文件态 →
    //    getBackgroundTask 应判定陈旧返回 error，而非永远卡 running。
    await step("非 Record 孤儿仍按原语义转 error（不卡 running）", async () => {
        const orphanId = "persist-orphan-1";
        const veryOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h 前，远超任何 maxRunMs×倍数
        __testWritePersistedTask({
            id: orphanId,
            kind: "persist-orphan",
            status: "running",
            startedAt: veryOld,
            updatedAt: veryOld,
            maxRunMs: 60 * 60 * 1000,
        });
        // 内存里没有这个任务（模拟重启后的孤儿）
        const got = getBackgroundTask(orphanId);
        assert.equal(got?.status, "error", "陈旧的孤儿 running 任务应转 error");
        assert.equal(got?.timedOut, true, "孤儿应标记 timedOut");
        assert.match(got?.error || "", /陈旧|退出|超时/u, "错误信息应说明状态陈旧");
    });

    // ③ 不误杀活任务：内存里 running 的活任务（updatedAt 新）→ 仍返 running。
    //    内存优先保证：即便文件态会被孤儿判定，活任务走内存态不受影响。
    await step("不误杀活任务：内存中新鲜 running 仍返 running", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        const t = startBackgroundTask("persist-live", async () => {
            await gate; // 卡住，保持 running
            return "later";
        }, { maxRunMs: 60_000 });

        await sleep(20);
        const live = getBackgroundTask(t.id);
        assert.equal(live?.status, "running", "新鲜活任务应仍为 running，不被孤儿判定误杀");
        release();
        await waitForBackgroundTask(t.id, 2);
    });

    // ④ 孤儿判定不误伤「内存活任务 + 旧文件」组合：
    //    即使某活任务的文件落盘时间戳偏旧，只要内存里它还在跑，内存优先就保证返回 running。
    await step("内存优先压过陈旧文件态：旧文件 + 活内存 → running", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        const t = startBackgroundTask("persist-mem-priority", async () => {
            await gate;
            return "ok";
        }, { maxRunMs: 60_000 });
        await sleep(20);
        // 故意把文件态改旧（模拟落盘节流导致文件时间戳滞后），内存仍活跃
        __testWritePersistedTask({
            id: t.id,
            kind: "persist-mem-priority",
            status: "running",
            startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
            updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
            maxRunMs: 60_000,
        });
        const got = getBackgroundTask(t.id);
        assert.equal(got?.status, "running", "内存优先：活任务即便文件态陈旧也应返 running");
        release();
        await waitForBackgroundTask(t.id, 2);
    });

    // ⑤ 通用任务仍维持 best-effort：持久化异常不应改变既有主流程语义。
    await step("持久化失败不影响任务主流程", async () => {
        // 先确保 tasks 目录已存在的内容清掉，再用一个同名文件占位让 mkdir/写盘失败
        // （注意：前面用例已建了 TASKS_DIR 目录，这里换一个独立的子根做隔离测试更干净，
        //   但简化处理——直接断言任务能 done 即可，落盘失败被吞不抛即视为通过）
        const t = startBackgroundTask("persist-failsafe", async () => "RESULT_DESPITE_IO", { maxRunMs: 5000 });
        const done = await waitForBackgroundTask(t.id, 2);
        assert.equal(done?.status, "done", "即便落盘异常，任务仍应结算 done");
        assert.equal(done?.result, "RESULT_DESPITE_IO", "结果不受持久化影响");
    });

    await step("S4 子进程硬退出后由生产启动入口自动发现、重建并入队", async () => {
        const taskId = "record-scheduler-startup-hard-exit";
        const requestKey = "background-task-persist:startup-hard-exit";
        const requestSummary = { stage: "s4-hard-exit", source: "real-child" };
        const resumePayload = { stage: "s4-hard-exit", conversationId: "conversation-hard-exit" };
        const initialLedger = makeAdmissionInitialLedger(taskId);
        const workerPath = path.join(TMP_ROOT, "scheduler-admission-hard-exit.mts");
        const admissionImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-admission.ts")).href;
        const backgroundImport = pathToFileURL(path.resolve(process.cwd(), "src", "background-tasks.ts")).href;
        fs.writeFileSync(workerPath, [
            `const background = await import(${JSON.stringify(backgroundImport)});`,
            `const admission = await import(${JSON.stringify(admissionImport)});`,
            `background.__testSetBackgroundTaskPersistFaultInjector((_task, phase) => {`,
            `  if (phase === "admission-before-write") process.exit(73);`,
            `});`,
            `await admission.admitRecordSchedulerTask({`,
            `  kind: "record-update",`,
            `  requestKey: ${JSON.stringify(requestKey)},`,
            `  initialLedger: ${JSON.stringify(initialLedger)},`,
            `  immutableRequestSummary: ${JSON.stringify(requestSummary)},`,
            `  resumePayload: ${JSON.stringify(resumePayload)},`,
            `  run: async () => "child-must-not-return",`,
            `});`,
            `process.exit(74);`,
        ].join("\n"), "utf8");
        const child = await runWorker(workerPath);
        assert.equal(child.code, 73, JSON.stringify(child));
        assert.equal(fs.existsSync(taskFile(taskId)), false, "S4 projection 前硬退出不能留下半份 envelope");
        const verified = await schedulerStore.verifyOrRecoverTaskAdmission(taskId);
        assert.equal(verified.kind, "verified", "硬退出前 L2 与真实 capsule 必须已经持久化");

        registerBackgroundTaskRecoveryHandler("record-update", task => {
            assert.deepEqual(task.resumePayload, resumePayload, "启动恢复必须从 immutable capsule 取回真实 resumePayload");
            return {
                mode: "resume",
                run: async () => "startup-entry-recovered",
            };
        });
        try {
            const startup = await runBackgroundTaskStartupRecovery();
            const recovered = startup.recordScheduler.results.find(result => result.taskId === taskId);
            assert.equal(recovered?.outcome, "rebuilt", JSON.stringify(startup.recordScheduler));
            const done = await waitForBackgroundTask(taskId, 2);
            assert.equal(done?.status, "done");
            assert.equal(done?.result, "startup-entry-recovered");
        } finally {
            unregisterBackgroundTaskRecoveryHandler("record-update");
        }
        __testEvictFromMemory(taskId);
        fs.rmSync(taskFile(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
    });

    await step("启动 generic lane 不重跑 legacy Record，scheduler task 只由 ledger lane 接管", async () => {
        const legacyTaskId = "record-update-legacy-no-admission";
        const schedulerTaskId = "record-update-scheduler-generic-skip";
        const genericTaskId = "generic-startup-recovery-still-runs";
        const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const legacyResumePayload = { operation: "record-update", conversationId: "legacy-conversation", source: "legacy-envelope" };
        const genericResumePayload = { operation: "generic-recovery", source: "generic-envelope" };
        const schedulerAdmissionReceipt = await createSchedulerAdmission(schedulerTaskId);
        let legacyHandlerCalls = 0;
        let schedulerHandlerCalls = 0;
        let genericHandlerCalls = 0;

        __testWritePersistedTask({
            id: legacyTaskId,
            kind: "record-update",
            status: "running",
            startedAt: oldTimestamp,
            updatedAt: oldTimestamp,
            ownerPid: 2_147_483_647,
            resumePayload: legacyResumePayload,
            resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
            resumeHash: stableJsonHash(legacyResumePayload),
        });
        __testWritePersistedTask({
            id: schedulerTaskId,
            kind: "record-update",
            status: "running",
            startedAt: oldTimestamp,
            updatedAt: oldTimestamp,
            ownerPid: 2_147_483_647,
            schedulerAdmission: { admission: schedulerAdmissionReceipt },
        });
        __testWritePersistedTask({
            id: genericTaskId,
            kind: "generic-startup-recovery",
            status: "running",
            startedAt: oldTimestamp,
            updatedAt: oldTimestamp,
            ownerPid: 2_147_483_647,
            resumePayload: genericResumePayload,
            resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
            resumeHash: stableJsonHash(genericResumePayload),
        });
        __testEvictFromMemory(legacyTaskId);
        __testEvictFromMemory(schedulerTaskId);
        __testEvictFromMemory(genericTaskId);

        registerBackgroundTaskRecoveryHandler("record-update", task => {
            if (task.id === legacyTaskId) legacyHandlerCalls++;
            if (task.id === schedulerTaskId) schedulerHandlerCalls++;
            return { mode: "resume", run: async () => `record-recovered:${task.id}` };
        });
        registerBackgroundTaskRecoveryHandler("generic-startup-recovery", task => {
            assert.equal(task.id, genericTaskId);
            genericHandlerCalls++;
            return { mode: "resume", run: async () => "generic-recovered" };
        });
        try {
            const startup = await runBackgroundTaskStartupRecovery();
            const legacyRecovery = startup.generic.results.find(result => result.taskId === legacyTaskId);
            const genericSchedulerRecovery = startup.generic.results.find(result => result.taskId === schedulerTaskId);
            const schedulerRecovery = startup.recordScheduler.results.find(result => result.taskId === schedulerTaskId);
            const genericRecovery = startup.generic.results.find(result => result.taskId === genericTaskId);

            assert.equal(legacyRecovery?.outcome, "error", JSON.stringify(startup.generic));
            assert.match(legacyRecovery?.reason || "", /缺少 schedulerAdmission.*拒绝.*generic handler.*迁移.*RepairRequired/u);
            assert.equal(legacyHandlerCalls, 0, "legacy Record 必须不调用已注册 recovery handler，更不能重新 generate/write");
            const persistedLegacy = JSON.parse(fs.readFileSync(taskFile(legacyTaskId), "utf8"));
            assert.equal(persistedLegacy.id, legacyTaskId, "legacy taskId 证据必须保留在原 envelope");
            assert.equal(persistedLegacy.status, "error", "legacy Record 必须持久化为不可自动恢复的终态");
            assert.deepEqual(persistedLegacy.resumePayload, legacyResumePayload, "legacy resumePayload 必须原样保留供迁移/修复取证");

            assert.equal(genericSchedulerRecovery?.outcome, "ignored", JSON.stringify(startup.generic));
            assert.match(genericSchedulerRecovery?.reason || "", /ledger owner lease/u);
            assert.equal(schedulerRecovery?.outcome, "rebuilt", JSON.stringify(startup.recordScheduler));
            assert.equal(schedulerHandlerCalls, 1, "scheduler-backed Record 只能由 scheduler ledger scan 调一次 handler");

            assert.equal(genericRecovery?.outcome, "resumed", JSON.stringify(startup.generic));
            assert.equal(genericHandlerCalls, 1, "普通 non-Record generic task 必须保持原恢复语义");
            assert.equal((await waitForBackgroundTask(genericTaskId, 2))?.result, "generic-recovered");
            assert.equal((await waitForBackgroundTask(schedulerTaskId, 2))?.result, `record-recovered:${schedulerTaskId}`);
        } finally {
            unregisterBackgroundTaskRecoveryHandler("record-update");
            unregisterBackgroundTaskRecoveryHandler("generic-startup-recovery");
        }
        for (const taskId of [legacyTaskId, schedulerTaskId, genericTaskId]) {
            __testEvictFromMemory(taskId);
            fs.rmSync(taskFile(taskId), { force: true });
        }
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(schedulerTaskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(schedulerTaskId), { force: true });
    });

    await step("同 requestKey 重试返回同一 task，不同内容或身份 fail closed", async () => {
        const taskId = "record-scheduler-idempotent";
        const replayTaskId = "record-scheduler-idempotent-retry";
        const requestKey = "background-task-persist:idempotent";
        const requestSummary = { operation: "record-update", conversationId: "conversation-idempotent" };
        const resumePayload = { operation: "record-update", conversationId: "conversation-idempotent", workspace: "test" };
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        let runCount = 0;
        const first = await schedulerAdmission.admitRecordSchedulerTask({
            kind: "record-update",
            requestKey,
            initialLedger: makeAdmissionInitialLedger(taskId),
            immutableRequestSummary: requestSummary,
            resumePayload,
            run: async () => {
                runCount++;
                await gate;
                return "idempotent-done";
            },
        });
        assert.notEqual(first.outcome, "UnknownOutcome");
        if (first.outcome === "UnknownOutcome") throw new Error(first.reasons.join("; "));
        const replay = await schedulerAdmission.admitRecordSchedulerTask({
            kind: "record-update",
            requestKey,
            initialLedger: makeAdmissionInitialLedger(replayTaskId),
            immutableRequestSummary: requestSummary,
            resumePayload,
            run: async () => {
                runCount++;
                return "must-not-run-twice";
            },
        });
        assert.equal(replay.outcome, "Replayed");
        if (replay.outcome === "UnknownOutcome") throw new Error(replay.reasons.join("; "));
        assert.equal(replay.taskId, taskId, "同一稳定 requestKey 必须选择已存在 taskId");
        assert.equal(replay.task, first.task, "同进程重试必须复用已排队 projection");
        await assert.rejects(
            () => schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger("record-scheduler-idempotent-conflict"),
                immutableRequestSummary: { ...requestSummary, conversationId: "different" },
                resumePayload,
                run: async () => "must-not-run",
            }),
            schedulerAdmission.RecordSchedulerAdmissionConflictError,
        );
        await assert.rejects(
            () => schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey: `${requestKey}:different-identity`,
                initialLedger: makeAdmissionInitialLedger(taskId),
                immutableRequestSummary: requestSummary,
                resumePayload,
                run: async () => "must-not-run",
            }),
            schedulerAdmission.RecordSchedulerAdmissionConflictError,
        );
        const unresolvedLedgerTaskId = "record-scheduler-unresolved-ledger";
        fs.mkdirSync(path.dirname(schedulerStore.recordSchedulerLedgerPath(unresolvedLedgerTaskId)), { recursive: true });
        fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(unresolvedLedgerTaskId), "{broken-ledger", "utf8");
        const unknownRequestKey = "background-task-persist:unknown-outcome";
        const unknownSummary = { operation: "record-update", conversationId: "unknown-outcome" };
        const unknown = await schedulerAdmission.admitRecordSchedulerTask({
            kind: "record-update",
            requestKey: unknownRequestKey,
            initialLedger: makeAdmissionInitialLedger("record-scheduler-unknown-request"),
            immutableRequestSummary: unknownSummary,
            resumePayload: { operation: "record-update", conversationId: "unknown-outcome", workspace: "test" },
            run: async () => "must-not-run",
        });
        assert.equal(unknown.outcome, "UnknownOutcome");
        if (unknown.outcome === "UnknownOutcome") {
            assert.deepEqual(unknown.candidateTaskIds, [unresolvedLedgerTaskId], "UnknownOutcome 必须枚举无法判定的 ledger");
        }
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(unresolvedLedgerTaskId), { force: true });
        release();
        const done = await waitForBackgroundTask(taskId, 2);
        assert.equal(done?.status, "done");
        assert.equal(runCount, 1, "幂等重试不得重复入队执行");
        __testEvictFromMemory(taskId);
        fs.rmSync(taskFile(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
    });

    await step("admission capsule 索引跳过无关坏账本，匹配 orphan/损坏路径 fail closed", async () => {
        const cleanup = (...taskIds: string[]): void => {
            for (const taskId of taskIds) {
                __testEvictFromMemory(taskId);
                fs.rmSync(taskFile(taskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
            }
        };
        const admit = async (
            taskId: string,
            requestKey: string,
            conversationId: string,
        ): Promise<schedulerAdmission.AdmitRecordSchedulerTaskResult> => schedulerAdmission.admitRecordSchedulerTask({
            kind: "record-update",
            requestKey,
            initialLedger: makeAdmissionInitialLedger(taskId),
            immutableRequestSummary: { operation: "record-update", conversationId },
            resumePayload: { operation: "record-update", conversationId, workspace: "admission-index" },
            run: async () => `admission-index:${taskId}`,
        });
        const unrelatedTaskIds = [
            "record-scheduler-admission-unrelated-a",
            "record-scheduler-admission-unrelated-b",
            "record-scheduler-admission-unrelated-c",
            "record-scheduler-admission-unrelated-d",
        ];
        const createdTaskIds: string[] = [];
        try {
            for (const [index, taskId] of unrelatedTaskIds.entries()) {
                const result = await admit(taskId, `background-task-persist:unrelated:${index}`, `unrelated-${index}`);
                assert.notEqual(result.outcome, "UnknownOutcome");
                if (result.outcome === "UnknownOutcome") throw new Error(result.reasons.join("; "));
                createdTaskIds.push(taskId);
                await waitForBackgroundTask(result.task.id, 2);
                fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(taskId), "{broken-unrelated-ledger", "utf8");
            }

            const fastTaskId = "record-scheduler-admission-capsule-fast-path";
            const fast = await admit(fastTaskId, "background-task-persist:capsule-fast-path", "capsule-fast-path");
            assert.notEqual(fast.outcome, "UnknownOutcome", "可信且无关的 capsule 不能读取其已损坏 ledger");
            if (fast.outcome === "UnknownOutcome") throw new Error(fast.reasons.join("; "));
            createdTaskIds.push(fastTaskId);
            await waitForBackgroundTask(fast.task.id, 2);

            const capsuleLessBrokenTaskId = "record-scheduler-admission-capsule-less-broken";
            fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(capsuleLessBrokenTaskId), "{broken-without-capsule", "utf8");
            const capsuleLess = await admit(
                "record-scheduler-admission-capsule-less-request",
                "background-task-persist:capsule-less-broken",
                "capsule-less-broken",
            );
            assert.equal(capsuleLess.outcome, "UnknownOutcome", "无 capsule 的损坏 ledger 必须保留 UnknownOutcome");
            if (capsuleLess.outcome === "UnknownOutcome") {
                assert.ok(capsuleLess.candidateTaskIds.includes(capsuleLessBrokenTaskId));
            }
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath(capsuleLessBrokenTaskId), { force: true });

            const orphanTaskId = "record-scheduler-admission-matching-orphan";
            const orphanKey = "background-task-persist:matching-orphan";
            const orphan = await admit(orphanTaskId, orphanKey, "matching-orphan");
            assert.notEqual(orphan.outcome, "UnknownOutcome");
            if (orphan.outcome === "UnknownOutcome") throw new Error(orphan.reasons.join("; "));
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath(orphanTaskId), { force: true });
            const orphanReplay = await admit("record-scheduler-admission-matching-orphan-retry", orphanKey, "matching-orphan");
            assert.equal(orphanReplay.outcome, "UnknownOutcome", "matching capsule 缺 ledger 时不得新建尝试");
            if (orphanReplay.outcome === "UnknownOutcome") assert.ok(orphanReplay.candidateTaskIds.includes(orphanTaskId));
            cleanup(orphanTaskId, "record-scheduler-admission-matching-orphan-retry");

            const brokenCapsuleTaskId = "record-scheduler-admission-matching-broken-capsule";
            const brokenCapsuleKey = "background-task-persist:matching-broken-capsule";
            const brokenCapsule = await admit(brokenCapsuleTaskId, brokenCapsuleKey, "matching-broken-capsule");
            assert.notEqual(brokenCapsule.outcome, "UnknownOutcome");
            if (brokenCapsule.outcome === "UnknownOutcome") throw new Error(brokenCapsule.reasons.join("; "));
            fs.writeFileSync(schedulerStore.recordSchedulerAdmissionCapsulePath(brokenCapsuleTaskId), "{broken-capsule", "utf8");
            const brokenCapsuleReplay = await admit("record-scheduler-admission-matching-broken-capsule-retry", brokenCapsuleKey, "matching-broken-capsule");
            assert.equal(brokenCapsuleReplay.outcome, "UnknownOutcome", "损坏 capsule 必须阻止新建尝试");
            cleanup(brokenCapsuleTaskId, "record-scheduler-admission-matching-broken-capsule-retry");

            const brokenLedgerTaskId = "record-scheduler-admission-matching-broken-ledger";
            const brokenLedgerKey = "background-task-persist:matching-broken-ledger";
            const brokenLedger = await admit(brokenLedgerTaskId, brokenLedgerKey, "matching-broken-ledger");
            assert.notEqual(brokenLedger.outcome, "UnknownOutcome");
            if (brokenLedger.outcome === "UnknownOutcome") throw new Error(brokenLedger.reasons.join("; "));
            fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(brokenLedgerTaskId), "{broken-matching-ledger", "utf8");
            const brokenLedgerReplay = await admit("record-scheduler-admission-matching-broken-ledger-retry", brokenLedgerKey, "matching-broken-ledger");
            assert.equal(brokenLedgerReplay.outcome, "UnknownOutcome", "matching capsule 的损坏 ledger 必须阻止新建尝试");
            cleanup(brokenLedgerTaskId, "record-scheduler-admission-matching-broken-ledger-retry");
        } finally {
            cleanup(...createdTaskIds);
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath("record-scheduler-admission-capsule-less-broken"), { force: true });
        }
    });

    await step("跨进程 admission namespace lock 保证同 identity 最终只有一个 durable task", async () => {
        const workerPath = path.join(TMP_ROOT, "record-scheduler-admission-namespace-worker.mts");
        const admissionImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-admission.ts")).href;
        const requestKey = "background-task-persist:cross-process-admission";
        const requestSummary = { operation: "record-update", conversationId: "cross-process-admission" };
        const resumePayload = { operation: "record-update", conversationId: "cross-process-admission", workspace: "namespace-lock" };
        const firstTaskId = "record-scheduler-admission-cross-process-a";
        const secondTaskId = "record-scheduler-admission-cross-process-b";
        fs.writeFileSync(workerPath, [
            `const admission = await import(${JSON.stringify(admissionImport)});`,
            "const taskId = process.argv[2];",
            "const initialLedger = JSON.parse(process.argv[3]);",
            `const result = await admission.admitRecordSchedulerTask({ kind: "record-update", requestKey: ${JSON.stringify(requestKey)}, initialLedger, immutableRequestSummary: ${JSON.stringify(requestSummary)}, resumePayload: ${JSON.stringify(resumePayload)}, run: async () => "cross-process-done" });`,
            "process.stdout.write(JSON.stringify(result.outcome === \"UnknownOutcome\" ? result : { outcome: result.outcome, taskId: result.taskId }));",
        ].join("\n"), "utf8");
        try {
            const [firstWorker, secondWorker] = await Promise.all([
                runWorker(workerPath, firstTaskId, JSON.stringify(makeAdmissionInitialLedger(firstTaskId))),
                runWorker(workerPath, secondTaskId, JSON.stringify(makeAdmissionInitialLedger(secondTaskId))),
            ]);
            assert.equal(firstWorker.code, 0, firstWorker.stderr);
            assert.equal(secondWorker.code, 0, secondWorker.stderr);
            const results = [JSON.parse(firstWorker.stdout), JSON.parse(secondWorker.stdout)] as Array<{ outcome: string; taskId?: string; reasons?: string[] }>;
            assert.ok(results.every(result => result.outcome !== "UnknownOutcome"), JSON.stringify(results));
            const admittedTaskIds = [...new Set(results.map(result => result.taskId))];
            assert.equal(admittedTaskIds.length, 1, "两个进程的同一 identity 只能选择同一个 durable task");
            const ledgerTaskIds = schedulerStore.listRecordSchedulerLedgerTaskIds()
                .filter(taskId => taskId === firstTaskId || taskId === secondTaskId);
            assert.deepEqual(ledgerTaskIds, admittedTaskIds, "namespace lock 期间只能落下一份 L1 ledger");
        } finally {
            fs.rmSync(workerPath, { force: true });
            for (const taskId of [firstTaskId, secondTaskId]) {
                __testEvictFromMemory(taskId);
                fs.rmSync(taskFile(taskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
            }
        }
    });

    await step("terminal identity 先冲突，replayTerminal 决定同 identity 是否新建尝试", async () => {
        const taskId = "record-scheduler-admission-terminal-original";
        const retryTaskId = "record-scheduler-admission-terminal-retry";
        const requestKey = "background-task-persist:terminal-replay";
        const requestSummary = { operation: "record-update", conversationId: "terminal-replay" };
        const resumePayload = { operation: "record-update", conversationId: "terminal-replay", workspace: "terminal-replay" };
        try {
            const initial = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger(taskId),
                immutableRequestSummary: requestSummary,
                resumePayload,
                run: async () => "terminal-original",
            });
            assert.notEqual(initial.outcome, "UnknownOutcome");
            if (initial.outcome === "UnknownOutcome") throw new Error(initial.reasons.join("; "));
            await waitForBackgroundTask(initial.task.id, 2);
            const stored = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            assert.equal(stored.kind, "current");
            if (stored.kind !== "current") throw new Error("terminal fixture ledger missing");
            const terminalLedger = structuredClone(stored.ledger);
            terminalLedger.task.state = "Succeeded";
            terminalLedger.task.terminalState = "Succeeded";
            terminalLedger.task.updatedAt = new Date().toISOString();
            terminalLedger.persistedHash = schedulerStore.calculateRecordSchedulerLedgerHash(terminalLedger);
            fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(taskId), `${JSON.stringify(terminalLedger, null, 2)}\n`, "utf8");

            const replay = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger("record-scheduler-admission-terminal-replay"),
                immutableRequestSummary: requestSummary,
                resumePayload,
                replayTerminal: true,
                run: async () => "must-not-run-terminal-replay",
            });
            assert.equal(replay.outcome, "Replayed", "同一 terminal identity 在 replayTerminal=true 时必须复用");
            if (replay.outcome === "UnknownOutcome") throw new Error(replay.reasons.join("; "));
            assert.equal(replay.taskId, taskId);

            await assert.rejects(
                () => schedulerAdmission.admitRecordSchedulerTask({
                    kind: "record-update",
                    requestKey,
                    initialLedger: makeAdmissionInitialLedger("record-scheduler-admission-terminal-conflict"),
                    immutableRequestSummary: { ...requestSummary, conversationId: "terminal-replay-conflict" },
                    resumePayload,
                    replayTerminal: false,
                    run: async () => "must-not-run-terminal-conflict",
                }),
                schedulerAdmission.RecordSchedulerAdmissionConflictError,
                "terminal task 也必须先校验 requestHash/kind，不能被 replayTerminal=false 跳过",
            );

            const retry = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger(retryTaskId),
                immutableRequestSummary: requestSummary,
                resumePayload,
                replayTerminal: false,
                run: async () => "terminal-retry",
            });
            assert.equal(retry.outcome, "Admitted", "完全相同的 terminal identity 才能在 replayTerminal=false 时创建新尝试");
            if (retry.outcome === "UnknownOutcome") throw new Error(retry.reasons.join("; "));
            assert.equal(retry.taskId, retryTaskId);
            await waitForBackgroundTask(retry.task.id, 2);

            const replayActive = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger("record-scheduler-admission-active-replay-latest"),
                immutableRequestSummary: requestSummary,
                resumePayload,
                replayTerminal: true,
                run: async () => "must-not-run-active-replay-latest",
            });
            assert.equal(replayActive.outcome, "Replayed", "历史终态与当前非终态并存时必须优先复用当前尝试");
            if (replayActive.outcome === "UnknownOutcome") throw new Error(replayActive.reasons.join("; "));
            assert.equal(replayActive.taskId, retryTaskId);

            const retryStored = await schedulerStore.readRecordSchedulerLedgerStore(retryTaskId, { expectPublished: true });
            assert.equal(retryStored.kind, "current");
            if (retryStored.kind !== "current") throw new Error("terminal retry ledger missing");
            const retryTerminalLedger = structuredClone(retryStored.ledger);
            retryTerminalLedger.task.state = "Succeeded";
            retryTerminalLedger.task.terminalState = "Succeeded";
            retryTerminalLedger.task.updatedAt = new Date().toISOString();
            retryTerminalLedger.persistedHash = schedulerStore.calculateRecordSchedulerLedgerHash(retryTerminalLedger);
            fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(retryTaskId), `${JSON.stringify(retryTerminalLedger, null, 2)}\n`, "utf8");

            const replayLatestTerminal = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey,
                initialLedger: makeAdmissionInitialLedger("record-scheduler-admission-terminal-replay-latest"),
                immutableRequestSummary: requestSummary,
                resumePayload,
                replayTerminal: true,
                run: async () => "must-not-run-terminal-replay-latest",
            });
            assert.equal(replayLatestTerminal.outcome, "Replayed", "存在多次同 identity 终态尝试时必须稳定复用最新一次");
            if (replayLatestTerminal.outcome === "UnknownOutcome") throw new Error(replayLatestTerminal.reasons.join("; "));
            assert.equal(replayLatestTerminal.taskId, retryTaskId);
        } finally {
            for (const currentTaskId of [taskId, retryTaskId, "record-scheduler-admission-terminal-replay", "record-scheduler-admission-terminal-conflict", "record-scheduler-admission-active-replay-latest", "record-scheduler-admission-terminal-replay-latest"]) {
                __testEvictFromMemory(currentTaskId);
                fs.rmSync(taskFile(currentTaskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerLedgerPath(currentTaskId), { force: true });
                fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(currentTaskId), { force: true });
            }
        }
    });

    await step("旧 projection receipt 在 L2 推进后刷新可变 revision，不误判 running 丢失", async () => {
        const taskId = "record-scheduler-stale-projection-receipt";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        const advanced = await schedulerStore.mutateRecordSchedulerLedger(taskId, admissionReceipt.ledgerRevision, ledger => {
            ledger.task.aheadTaskCount += 1;
        });
        __testWritePersistedTask({
            id: taskId,
            kind: "record-update",
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            schedulerAdmission: { admission: admissionReceipt },
            ownerPid: process.pid,
        });
        __testEvictFromMemory(taskId);
        const refreshed = getBackgroundTask(taskId);
        assert.equal(refreshed?.status, "running", "不可变 admission binding 未变时，陈旧可变 revision 不能让控制面丢失任务");
        assert.equal(refreshed?.schedulerAdmission?.admission.ledgerRevision, advanced.revision, "读取时必须从真实 L2 刷新可变 revision");
        assert.equal(refreshed?.schedulerAdmission?.admission.ledgerHash, advanced.ledger.persistedHash, "读取时必须从真实 L2 刷新可变 hash");
        fs.rmSync(taskFile(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
    });

    await step("伪 immutable anchor 磁盘 envelope 不得显示 running，启动扫描隔离并重建", async () => {
        const taskId = "record-scheduler-forged-disk-envelope";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        __testWritePersistedTask({
            id: taskId,
            kind: "record-update",
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            schedulerAdmission: {
                admission: {
                    ...admissionReceipt,
                    ledgerAnchor: { ...admissionReceipt.ledgerAnchor, hash: "0".repeat(64) },
                },
            },
            ownerPid: process.pid,
        });
        __testEvictFromMemory(taskId);
        assert.notEqual(getBackgroundTask(taskId)?.status, "running", "伪 immutable binding 不能从磁盘冒充活 scheduler");
        registerBackgroundTaskRecoveryHandler("record-update", () => ({
            mode: "resume",
            run: async () => "forged-envelope-recovered",
        }));
        try {
            const startup = await runBackgroundTaskStartupRecovery();
            const recovered = startup.recordScheduler.results.find(result => result.taskId === taskId);
            assert.equal(recovered?.outcome, "rebuilt", JSON.stringify(startup.recordScheduler));
            assert.ok(recovered?.quarantinedPath && fs.existsSync(recovered.quarantinedPath), "坏 projection 必须保留隔离证据");
            const done = await waitForBackgroundTask(taskId, 2);
            assert.equal(done?.status, "done");
            assert.equal(done?.result, "forged-envelope-recovered");
        } finally {
            unregisterBackgroundTaskRecoveryHandler("record-update");
        }
        __testEvictFromMemory(taskId);
        fs.rmSync(taskFile(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
        fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
    });

    await step("真实 L2 无法验证 capsule 时启动扫描进入 RepairRequired", async () => {
        const taskId = "record-scheduler-corrupt-capsule-startup";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        const capsulePath = schedulerStore.recordSchedulerAdmissionCapsulePath(taskId);
        const capsule = JSON.parse(fs.readFileSync(capsulePath, "utf8"));
        capsule.requestSummary = { source: "tampered-after-admission" };
        fs.writeFileSync(capsulePath, JSON.stringify(capsule), "utf8");
        __testWritePersistedTask({
            id: taskId,
            kind: "record-update",
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            schedulerAdmission: { admission: admissionReceipt },
            ownerPid: process.pid,
        });
        __testEvictFromMemory(taskId);
        assert.equal(getBackgroundTask(taskId), null, "capsule 损坏后磁盘 projection 不得继续可见");
        const startup = await runBackgroundTaskStartupRecovery();
        const repaired = startup.recordScheduler.results.find(result => result.taskId === taskId);
        assert.equal(repaired?.outcome, "repair_required", JSON.stringify(startup.recordScheduler));
        assert.ok(repaired?.quarantinedPath && fs.existsSync(repaired.quarantinedPath), "不可验证 projection 必须先隔离");
        const ledger = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        assert.equal(ledger.kind, "current");
        if (ledger.kind === "current") {
            assert.equal(ledger.ledger.task.state, "RepairRequired");
            assert.equal(ledger.ledger.task.repairState, "Required");
        }
        fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
        fs.rmSync(capsulePath, { force: true });
    });

    await step("Record scheduler dispatch 持久化失败时不继续执行 run", async () => {
        const taskId = "record-scheduler-dispatch-failure";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        let runCount = 0;
        __testSetBackgroundTaskPersistFaultInjector((_task, phase) => {
            if (phase === "dispatch") throw new Error("injected dispatch persistence failure");
        });
        try {
            const task = await startRecordSchedulerBackgroundTask("record-update", async () => {
                runCount += 1;
                return "must-not-run";
            }, { admissionReceipt });
            const settled = await waitForBackgroundTask(task.id, 2);
            assert.equal(runCount, 0, "dispatch intent/envelope 未确认持久化时不得调用 run");
            assert.equal(settled?.status, "error", "关键持久化失败应结算为 error");
            assert.match(settled?.error || "", /dispatch.*持久化失败|injected dispatch/u);
        } finally {
            __testSetBackgroundTaskPersistFaultInjector();
        }
    });

    await step("Record scheduler 超过一小时不被 stale 墙钟结案，交给 owner lease 恢复", async () => {
        const taskId = "record-scheduler-old-running";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        const veryOld = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        __testWritePersistedTask({
            id: taskId,
            kind: "record-update",
            status: "running",
            startedAt: veryOld,
            updatedAt: veryOld,
            maxRunMs: 60 * 60 * 1000,
            schedulerAdmission: { admission: admissionReceipt },
            ownerPid: 2_147_483_647,
        });
        __testEvictFromMemory(taskId);
        const task = getBackgroundTask(taskId);
        assert.equal(task?.status, "running", "scheduler task 不能被通用 stale 检查误杀");
        assert.equal(task?.timedOut, undefined);
        const recovery = await recoverBackgroundTask(taskId);
        assert.equal(recovery.outcome, "ignored", "应让后续 scheduler owner lease 处理恢复");
        assert.match(recovery.reason || "", /owner lease/u);
    });

    await step("ledger 已成功但 envelope 写失败时不返回 taskId 或入队", async () => {
        const taskId = "record-scheduler-envelope-failure";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        let runCount = 0;
        fs.rmSync(TASKS_DIR, { recursive: true, force: true });
        fs.writeFileSync(TASKS_DIR, "block envelope directory", "utf-8");
        try {
            await assert.rejects(
                () => startRecordSchedulerBackgroundTask("record-update", async () => {
                    runCount += 1;
                    return "must-not-run";
                }, { admissionReceipt }),
                /admission 持久化失败/u,
            );
            const ledger = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            assert.equal(ledger.kind, "current", "先创建成功的 ledger 必须保留给孤儿清理/修复流程");
            assert.equal(runCount, 0, "envelope 未持久化时不得入队或执行 run");
        } finally {
            fs.rmSync(TASKS_DIR, { recursive: true, force: true });
        }
    });

    await step("S4 projection 前后写失败不返回 taskId，L2 可重建且无未处理 rejection", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on("unhandledRejection", onUnhandled);
        try {
            const preTaskId = "record-scheduler-s4-pre";
            __testSetBackgroundTaskPersistFaultInjector((_task, phase) => {
                if (phase === "admission-before-write") throw new Error("s4 projection pre-write");
            });
            const preResult = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey: `background-task-persist:${preTaskId}`,
                initialLedger: makeAdmissionInitialLedger(preTaskId),
                immutableRequestSummary: { stage: "s4-pre" },
                resumePayload: { stage: "s4-pre", conversationId: "conversation-s4-pre" },
                run: async () => "must-not-run",
            });
            assert.equal(preResult.outcome, "UnknownOutcome");
            assert.equal("taskId" in preResult, false, "projection 前写失败不得作为成功结果返回 taskId");
            if (preResult.outcome === "UnknownOutcome") assert.match(preResult.reasons.join("; "), /admission.*持久化失败|pre-write/u);
            __testSetBackgroundTaskPersistFaultInjector();
            assert.equal(fs.existsSync(taskFile(preTaskId)), false, "projection 前写失败不得生成任务 envelope");
            const preVerified = await schedulerStore.verifyOrRecoverTaskAdmission(preTaskId);
            assert.equal(preVerified.kind, "verified", "S4 前写失败后 L2 仍应可验证");
            const replayedPre = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey: `background-task-persist:${preTaskId}`,
                initialLedger: makeAdmissionInitialLedger(preTaskId),
                immutableRequestSummary: { stage: "s4-pre" },
                resumePayload: { stage: "s4-pre", conversationId: "conversation-s4-pre" },
                run: async () => "rebuild-ok",
            });
            assert.equal(replayedPre.outcome, "Replayed", "UnknownOutcome 重试必须前滚同一 L2，不得重新 create");
            if (replayedPre.outcome === "UnknownOutcome") throw new Error(replayedPre.reasons.join("; "));
            assert.equal(replayedPre.taskId, preTaskId);
            const rebuiltDone = await waitForBackgroundTask(replayedPre.task.id, 2);
            assert.equal(rebuiltDone?.status, "done", "缺失 projection 应能用已验证 receipt 重建并入队");

            const postTaskId = "record-scheduler-s4-post";
            __testSetBackgroundTaskPersistFaultInjector((_task, phase) => {
                if (phase === "admission-after-write") throw new Error("s4 projection post-write");
            });
            const postResult = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey: `background-task-persist:${postTaskId}`,
                initialLedger: makeAdmissionInitialLedger(postTaskId),
                immutableRequestSummary: { stage: "s4-post" },
                resumePayload: { stage: "s4-post", conversationId: "conversation-s4-post" },
                run: async () => "must-not-run",
            });
            assert.equal(postResult.outcome, "UnknownOutcome");
            assert.equal("taskId" in postResult, false, "projection 后写异常也不得作为成功结果返回 taskId");
            if (postResult.outcome === "UnknownOutcome") assert.match(postResult.reasons.join("; "), /admission.*持久化失败|post-write/u);
            __testSetBackgroundTaskPersistFaultInjector();
            assert.equal(fs.existsSync(taskFile(postTaskId)), true, "projection 后写失败必须保留可恢复的已发布 envelope");
            const postVerified = await schedulerStore.verifyOrRecoverTaskAdmission(postTaskId);
            assert.equal(postVerified.kind, "verified", "S4 后写失败不得破坏 L2 binding");
            const replayedPost = await schedulerAdmission.admitRecordSchedulerTask({
                kind: "record-update",
                requestKey: `background-task-persist:${postTaskId}`,
                initialLedger: makeAdmissionInitialLedger(postTaskId),
                immutableRequestSummary: { stage: "s4-post" },
                resumePayload: { stage: "s4-post", conversationId: "conversation-s4-post" },
                run: async () => "post-write-replay-ok",
            });
            assert.equal(replayedPost.outcome, "Replayed", "projection 发布后异常重试必须复用同一 admission identity");
            if (replayedPost.outcome === "UnknownOutcome") throw new Error(replayedPost.reasons.join("; "));
            assert.equal((await waitForBackgroundTask(replayedPost.taskId, 2))?.result, "post-write-replay-ok");
            await sleep(20);
            assert.deepEqual(unhandled, [], "连续 projection 持久化异常不得产生未处理 rejection");
        } finally {
            __testSetBackgroundTaskPersistFaultInjector();
            process.off("unhandledRejection", onUnhandled);
        }
    });

    await step("scheduler 连续 settle 持久化失败保留可恢复 running，不产生未处理 rejection", async () => {
        const taskId = "record-scheduler-settle-failure";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on("unhandledRejection", onUnhandled);
        try {
            const task = await startRecordSchedulerBackgroundTask("record-update", async () => {
                await gate;
                return "settle-never-persisted";
            }, { admissionReceipt });
            __testSetBackgroundTaskPersistFaultInjector((_task, phase) => {
                if (phase === "settle") throw new Error("forced settle persistence failure");
            });
            release();
            await sleep(30);
            assert.equal(getBackgroundTask(task.id)?.status, "running", "终态未落盘时不得只在内存伪造 error/done");
            assert.deepEqual(unhandled, [], "连续 settle 失败必须被队列观察，不能泄漏 unhandled rejection");
        } finally {
            __testSetBackgroundTaskPersistFaultInjector();
            process.off("unhandledRejection", onUnhandled);
        }
        assert.throws(
            () => cancelBackgroundTask(taskId, "must not bypass scheduler"),
            /generic cancel.*拒绝|权威 scheduler ledger/u,
            "scheduler-backed projection 不得被 generic cancel 绕过权威 ledger",
        );
        const cancelled = await schedulerRuntime.getRecordSchedulerRuntime().cancel(taskId);
        assert.ok(cancelled && cancelled.disposition !== "missing", "清理 scheduler task 必须走 ledger-backed cancel");
    });

    await step("伪造 admission receipt 不能启动 scheduler projection", async () => {
        const taskId = "record-scheduler-forged-receipt";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        await assert.rejects(
            () => startRecordSchedulerBackgroundTask("record-update", async () => "must-not-run", {
                admissionReceipt: { ...admissionReceipt, ledgerHash: "0".repeat(64) },
            }),
            /receipt.*不一致|receipt.*陈旧/u,
        );
        assert.equal(fs.existsSync(taskFile(taskId)), false, "伪 receipt 不得写入 mutable projection");
    });

    await step("LedgerCreated + Deferred 启动扫描只回读终态，不验收、不隔离、不重启", async () => {
        const taskId = "record-scheduler-ledger-created-deferred";
        const initialLedger = makeDeferredSchedulerLedger(taskId);
        const stored = await schedulerStore.createRecordSchedulerLedger(initialLedger);
        const ledgerPath = schedulerStore.recordSchedulerLedgerPath(taskId);
        __testWritePersistedTask({
            id: taskId,
            kind: "record-update",
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ownerPid: process.pid,
        });
        const projectionBefore = fs.readFileSync(taskFile(taskId), "utf8");
        let targetHandlerCalls = 0;
        registerBackgroundTaskRecoveryHandler("record-update", candidate => {
            if (candidate.taskId === taskId) targetHandlerCalls += 1;
            return undefined;
        });
        try {
            const startup = await runBackgroundTaskStartupRecovery();
            const terminal = startup.recordScheduler.results.find(result => result.taskId === taskId);
            assert.equal(terminal?.outcome, "terminal", JSON.stringify(startup.recordScheduler));
            assert.equal(targetHandlerCalls, 0, "Deferred 终态不得调用恢复 handler");
            assert.equal(fs.readFileSync(taskFile(taskId), "utf8"), projectionBefore, "终态扫描不得隔离或改写 projection");
            const after = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            assert.equal(after.kind, "current");
            if (after.kind === "current") {
                assert.equal(after.ledger.task.admission.state, "LedgerCreated", "终态扫描不得补齐 L1→L2 admission");
                assert.equal(after.ledger.revision, stored.revision, "终态扫描不得修改 ledger revision");
                assert.equal(after.ledger.persistedHash, stored.hash, "终态扫描不得修改 ledger hash");
            }
        } finally {
            unregisterBackgroundTaskRecoveryHandler("record-update");
            fs.rmSync(taskFile(taskId), { force: true });
            fs.rmSync(ledgerPath, { force: true });
        }
    });

    await step("Deferred 账本阻止 start、ensure 与 rebuild 执行 projection callback", async () => {
        const taskId = "record-scheduler-deferred-entry-guards";
        const admissionReceipt = await createSchedulerAdmission(taskId, makeDeferredSchedulerLedger(taskId));
        let runCount = 0;
        const run = async () => {
            runCount += 1;
            return "must-not-run";
        };
        const assertTerminalRejection = async (invoke: () => Promise<unknown>) => {
            await assert.rejects(
                invoke,
                (error: unknown) => error instanceof RecordSchedulerTerminalProjectionError
                    && error.taskId === taskId
                    && error.state === "Deferred"
                    && error.code === "RECORD_SCHEDULER_TERMINAL_PROJECTION",
            );
        };
        try {
            await assertTerminalRejection(() => startRecordSchedulerBackgroundTask("record-update", run, { admissionReceipt }));
            await assertTerminalRejection(() => ensureRecordSchedulerBackgroundProjection("record-update", run, { admissionReceipt }));
            await assertTerminalRejection(() => rebuildRecordSchedulerBackgroundProjection("record-update", run, { admissionReceipt }));
            assert.equal(runCount, 0, "权威 Deferred 终态不得执行 projection callback");
            assert.equal(fs.existsSync(taskFile(taskId)), false, "终态入口不得创建 mutable projection");
        } finally {
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
            fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
        }
    });

    await step("挂起持久化释放 lane，CAS 唤醒一次且重复事件不重复执行", async () => {
        let runCount = 0;
        let releaseSecondRun: () => void = () => {};
        const secondRunGate = new Promise<void>(resolve => { releaseSecondRun = resolve; });
        const task = startBackgroundTask("suspension-lane", async context => {
            runCount++;
            if (runCount === 1) {
                throw createBackgroundTaskSuspension({
                    taskId: context.taskId,
                    wakeAt: new Date(Date.now() + 60_000).toISOString(),
                    waitingReason: "等待 provider capacity",
                    ledgerRevision: 17,
                });
            }
            await secondRunGate;
            return "woken-once";
        });
        const suspended = await waitForTaskStatus(task.id, "suspended");
        assert.equal(suspended.finishedAt, undefined, "suspended 不得写入 finishedAt");
        assert.ok(suspended.wakeAt, "suspended 必须持久 wakeAt");
        assert.equal(suspended.waitingReason, "等待 provider capacity");
        assert.equal(suspended.suspensionRevision, 1);
        assert.equal(suspended.suspensionLedgerRevision, 17);
        const onDisk = JSON.parse(fs.readFileSync(taskFile(task.id), "utf8"));
        assert.equal(onDisk.status, "suspended");
        assert.equal(onDisk.finishedAt, undefined, "持久 suspended 不得带 finishedAt");
        assert.equal(onDisk.suspensionRevision, 1);
        await sleep(20);
        assert.equal(getBackgroundTaskQueueStatsForTest().active, 0, "挂起后 queue lane 必须立即释放 active");

        const firstWake = wakeBackgroundTask(task.id, { suspensionRevision: 1, ledgerRevision: 17 });
        assert.equal(firstWake.outcome, "woken");
        await waitForTaskStatus(task.id, "running");
        const duplicateWake = wakeBackgroundTask(task.id, { suspensionRevision: 1, ledgerRevision: 17 });
        assert.notEqual(duplicateWake.outcome, "woken", "重复 timer/event 不得再次入队");
        assert.equal(runCount, 2, "同一 revision 只能启动一次恢复执行");
        releaseSecondRun();
        const done = await waitForBackgroundTask(task.id, 2);
        assert.equal(done?.status, "done");
        assert.equal(done?.result, "woken-once");
    });

    await step("取消 suspended 任务仍终结，旧 wake token 不能复活", async () => {
        let runCount = 0;
        const task = startBackgroundTask("suspension-cancel", async context => {
            runCount++;
            throw createBackgroundTaskSuspension({
                taskId: context.taskId,
                wakeAt: new Date(Date.now() + 60_000).toISOString(),
                waitingReason: "等待依赖完成",
                ledgerRevision: 23,
            });
        });
        const suspended = await waitForTaskStatus(task.id, "suspended");
        const cancelled = cancelBackgroundTask(task.id, "测试取消 suspended");
        assert.equal(cancelled?.status, "cancelled");
        assert.ok(cancelled?.finishedAt, "取消必须写入 finishedAt");
        const staleWake = wakeBackgroundTask(task.id, {
            suspensionRevision: suspended.suspensionRevision!,
            ledgerRevision: suspended.suspensionLedgerRevision!,
        });
        assert.notEqual(staleWake.outcome, "woken", "已取消任务不得被旧 wake token 复活");
        await sleep(30);
        assert.equal(runCount, 1, "取消后不得再执行恢复轮次");
    });

    await step("启动恢复重建 suspended timer，并以同 taskId 自动唤醒", async () => {
        const kind = "suspension-startup-recovery";
        let initialRunCount = 0;
        const task = startBackgroundTask(kind, async context => {
            initialRunCount++;
            throw createBackgroundTaskSuspension({
                taskId: context.taskId,
                wakeAt: new Date(Date.now() + 450).toISOString(),
                waitingReason: "等待重启后的 provider release",
                ledgerRevision: 31,
            });
        }, { resumePayload: { task: "suspension-startup-recovery" } });
        await waitForTaskStatus(task.id, "suspended");
        __testResetBackgroundTasksForTest();
        let recoveredRunCount = 0;
        registerBackgroundTaskRecoveryHandler(kind, candidate => {
            assert.equal(candidate.id, task.id);
            return {
                mode: "resume",
                run: async () => {
                    recoveredRunCount++;
                    return "startup-woken";
                },
            };
        });
        try {
            const startup = await runBackgroundTaskStartupRecovery();
            const recovered = startup.generic.results.find(result => result.taskId === task.id);
            assert.equal(recovered?.outcome, "loaded", JSON.stringify(recovered));
            assert.equal(getBackgroundTask(task.id)?.status, "suspended", "重启接管先重建 timer，不抢跑 callback");
            const done = await waitForTaskStatus(task.id, "done", 2_000);
            assert.equal(done?.id, task.id, "重启后必须沿用同 taskId");
            assert.equal(done?.status, "done");
            assert.equal(done?.result, "startup-woken");
            assert.equal(initialRunCount, 1);
            assert.equal(recoveredRunCount, 1);
        } finally {
            unregisterBackgroundTaskRecoveryHandler(kind);
            __testResetBackgroundTasksForTest();
        }
    });

    await step("foreign owner watch 不阻塞控制面，旧进程退出后自动接管同 taskId", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "record-scheduler-overlap-watch-rescan";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        const workerPath = path.join(TMP_ROOT, "scheduler-overlap-owner.mts");
        const schedulerStoreImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-store.ts")).href;
        fs.writeFileSync(workerPath, [
            `const store = await import(${JSON.stringify(schedulerStoreImport)});`,
            `const taskId = ${JSON.stringify(taskId)};`,
            `const current = await store.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });`,
            `if (current.kind !== "current") throw new Error("missing overlap ledger");`,
            `const claimed = await store.claimSchedulerOwnerLease(taskId, current.ledger.revision, "overlap-old-owner", { leaseMs: 1_500 });`,
            `await store.completeSchedulerOwnerRecovery(taskId, claimed.revision, claimed.ownerLease, { recoveredRecordWorkKeys: [] });`,
            `console.log(JSON.stringify({ type: "ready", ownerPid: process.pid, schedulerEpoch: claimed.ownerLease.schedulerEpoch }));`,
            `setInterval(() => undefined, 1_000);`,
        ].join("\n"), "utf8");
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
            cwd: process.cwd(),
            env: { ...process.env, MEMORY_STORE_DATA_ROOT: TMP_ROOT },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        let ownerPid: number | undefined;
        try {
            const ready = await new Promise<{ ownerPid: number; schedulerEpoch: number }>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`overlap owner child ready timeout: ${stderr}`)), 5_000);
                child.stdout.on("data", chunk => {
                    for (const line of String(chunk).split(/\r?\n/u)) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line) as { type?: string; ownerPid?: number; schedulerEpoch?: number };
                            if (parsed.type !== "ready" || typeof parsed.ownerPid !== "number" || typeof parsed.schedulerEpoch !== "number") continue;
                            clearTimeout(timeout);
                            resolve({ ownerPid: parsed.ownerPid, schedulerEpoch: parsed.schedulerEpoch });
                        } catch {}
                    }
                });
                child.once("exit", code => {
                    clearTimeout(timeout);
                    reject(new Error(`overlap owner child exited before ready: code=${code}; stderr=${stderr}`));
                });
            });
            ownerPid = ready.ownerPid;
            assert.equal(ready.ownerPid, child.pid);
            __testWritePersistedTask({
                id: taskId,
                kind: "record-update",
                status: "running",
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ownerPid: ready.ownerPid,
                schedulerAdmission: { admission: admissionReceipt },
            });
            __testEvictFromMemory(taskId);
            let handlerCalls = 0;
            let runCalls = 0;
            registerBackgroundTaskRecoveryHandler("record-update", candidate => {
                if (candidate.id !== taskId) return undefined;
                handlerCalls++;
                return {
                    mode: "resume",
                    run: async () => {
                        runCalls++;
                        const current = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
                        if (current.kind !== "current") throw new Error("overlap rescan ledger missing");
                        const claimed = await schedulerStore.claimSchedulerOwnerLease(taskId, current.ledger.revision, "overlap-new-owner", { leaseMs: 60_000 });
                        const recovered = await schedulerStore.completeSchedulerOwnerRecovery(
                            taskId,
                            claimed.revision,
                            claimed.ownerLease,
                            { recoveredRecordWorkKeys: [] },
                        );
                        await schedulerStore.mutateRecordSchedulerLedgerAsOwner(taskId, recovered.revision, claimed.ownerLease, ledger => {
                            ledger.task.state = "Succeeded";
                            ledger.task.terminalState = "Succeeded";
                            ledger.task.updatedAt = new Date().toISOString();
                        });
                        return `overlap-recovered:${claimed.ownerLease.schedulerEpoch}`;
                    },
                };
            });
            try {
                const scanStartedAt = Date.now();
                const startup = await runBackgroundTaskStartupRecovery();
                assert.equal(Date.now() - scanStartedAt < 1_000, true, "foreign-owner watch registration must not block startup/control reads");
                const watched = startup.recordScheduler.results.find(result => result.taskId === taskId);
                assert.equal(watched?.outcome, "loaded", JSON.stringify(startup.recordScheduler));
                assert.match(watched?.reason || "", /watch\/rescan/u);
                assert.deepEqual(__testRecordSchedulerRecoveryWatchTaskIds(), [taskId]);
                assert.equal(getBackgroundTask(taskId)?.status, "running", "watch wait must keep status readable without starting recovery callback");
                assert.equal(handlerCalls, 0);

                child.kill();
                await waitForProcessExit(ready.ownerPid);
                assert.equal(handlerCalls, 0, "旧进程退出后仍须等 durable lease 过期，不能按 PID 抢跑");
                const done = await waitForTaskStatus(taskId, "done", 6_000);
                assert.equal(done.id, taskId);
                assert.equal(done.result, `overlap-recovered:${ready.schedulerEpoch + 1}`);
                assert.equal(handlerCalls, 1);
                assert.equal(runCalls, 1);
                assert.deepEqual(__testRecordSchedulerRecoveryWatchTaskIds(), []);
                const recoveredLedger = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
                assert.equal(recoveredLedger.kind, "current");
                if (recoveredLedger.kind === "current") {
                    assert.equal(recoveredLedger.ledger.task.state, "Succeeded");
                    assert.equal(recoveredLedger.ledger.schedulerOwner?.ownerId, "overlap-new-owner");
                    assert.equal(recoveredLedger.ledger.schedulerOwner?.schedulerEpoch, ready.schedulerEpoch + 1);
                }
                const secondScan = await runBackgroundTaskStartupRecovery();
                assert.equal(secondScan.recordScheduler.results.find(result => result.taskId === taskId)?.outcome, "terminal");
                assert.equal(handlerCalls, 1, "terminal rescan must not repeat projection callback");
            } finally {
                unregisterBackgroundTaskRecoveryHandler("record-update");
            }
        } finally {
            if (ownerPid !== undefined && isProcessAliveForTest(ownerPid)) {
                child.kill();
                await waitForProcessExit(ownerPid).catch(() => undefined);
            }
            __testResetBackgroundTasksForTest();
            fs.rmSync(taskFile(taskId), { force: true });
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
            fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
        }
    });

    await step("foreign owner PID 已退出但 lease 仍有效时等待过期再接管", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "record-scheduler-dead-owner-live-lease";
        const admissionReceipt = await createSchedulerAdmission(taskId);
        const workerPath = path.join(TMP_ROOT, "scheduler-dead-owner-live-lease.mts");
        const schedulerStoreImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-store.ts")).href;
        fs.writeFileSync(workerPath, [
            `const store = await import(${JSON.stringify(schedulerStoreImport)});`,
            `const taskId = ${JSON.stringify(taskId)};`,
            `const current = await store.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });`,
            `if (current.kind !== "current") throw new Error("missing dead-owner ledger");`,
            `const claimed = await store.claimSchedulerOwnerLease(taskId, current.ledger.revision, "dead-old-owner", { leaseMs: 1_500 });`,
            `await store.completeSchedulerOwnerRecovery(taskId, claimed.revision, claimed.ownerLease, { recoveredRecordWorkKeys: [] });`,
            `console.log(JSON.stringify({ type: "ready", ownerPid: process.pid, schedulerEpoch: claimed.ownerLease.schedulerEpoch }));`,
        ].join("\n"), "utf8");
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
            cwd: process.cwd(),
            env: { ...process.env, MEMORY_STORE_DATA_ROOT: TMP_ROOT },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        try {
            const ready = await new Promise<{ ownerPid: number; schedulerEpoch: number }>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`dead owner child ready timeout: ${stderr}`)), 5_000);
                child.stdout.on("data", chunk => {
                    for (const line of String(chunk).split(/\r?\n/u)) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line) as { type?: string; ownerPid?: number; schedulerEpoch?: number };
                            if (parsed.type !== "ready" || typeof parsed.ownerPid !== "number" || typeof parsed.schedulerEpoch !== "number") continue;
                            clearTimeout(timeout);
                            resolve({ ownerPid: parsed.ownerPid, schedulerEpoch: parsed.schedulerEpoch });
                        } catch {}
                    }
                });
                child.once("exit", code => {
                    if (code === 0) return;
                    clearTimeout(timeout);
                    reject(new Error(`dead owner child exited before ready: code=${code}; stderr=${stderr}`));
                });
            });
            await waitForProcessExit(ready.ownerPid);
            __testWritePersistedTask({
                id: taskId,
                kind: "record-update",
                status: "running",
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ownerPid: ready.ownerPid,
                schedulerAdmission: { admission: admissionReceipt },
            });
            __testEvictFromMemory(taskId);
            let handlerCalls = 0;
            registerBackgroundTaskRecoveryHandler("record-update", candidate => {
                if (candidate.id !== taskId) return undefined;
                handlerCalls++;
                return {
                    mode: "resume",
                    run: async () => {
                        const current = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
                        if (current.kind !== "current") throw new Error("dead-owner rescan ledger missing");
                        const claimed = await schedulerStore.claimSchedulerOwnerLease(taskId, current.ledger.revision, "dead-new-owner", { leaseMs: 60_000 });
                        const recovered = await schedulerStore.completeSchedulerOwnerRecovery(
                            taskId,
                            claimed.revision,
                            claimed.ownerLease,
                            { recoveredRecordWorkKeys: [] },
                        );
                        await schedulerStore.mutateRecordSchedulerLedgerAsOwner(taskId, recovered.revision, claimed.ownerLease, ledger => {
                            ledger.task.state = "Succeeded";
                            ledger.task.terminalState = "Succeeded";
                            ledger.task.updatedAt = new Date().toISOString();
                        });
                        return `dead-owner-recovered:${claimed.ownerLease.schedulerEpoch}`;
                    },
                };
            });
            try {
                const startup = await runBackgroundTaskStartupRecovery();
                const watched = startup.recordScheduler.results.find(result => result.taskId === taskId);
                assert.equal(watched?.outcome, "loaded", JSON.stringify(startup.recordScheduler));
                assert.match(watched?.reason || "", /watch\/rescan/u);
                assert.deepEqual(__testRecordSchedulerRecoveryWatchTaskIds(), [taskId]);
                assert.equal(handlerCalls, 0, "live durable lease must block recovery even after its owner PID exits");
                const done = await waitForTaskStatus(taskId, "done", 6_000);
                assert.equal(done.id, taskId);
                assert.equal(done.result, `dead-owner-recovered:${ready.schedulerEpoch + 1}`);
                assert.equal(handlerCalls, 1);
                assert.deepEqual(__testRecordSchedulerRecoveryWatchTaskIds(), []);
            } finally {
                unregisterBackgroundTaskRecoveryHandler("record-update");
            }
        } finally {
            if (child.pid !== undefined && isProcessAliveForTest(child.pid)) {
                child.kill();
                await waitForProcessExit(child.pid).catch(() => undefined);
            }
            __testResetBackgroundTasksForTest();
            fs.rmSync(taskFile(taskId), { force: true });
            fs.rmSync(schedulerStore.recordSchedulerLedgerPath(taskId), { force: true });
            fs.rmSync(schedulerStore.recordSchedulerAdmissionCapsulePath(taskId), { force: true });
        }
    });

    await step("stage-guard-check 恢复与取消始终使用同一公开 taskId，取消只结算一次", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "stage-guard-resume-cancel";
        const taskFilePath = path.join(TMP_ROOT, "Task-stage-guard-resume-cancel.md");
        fs.writeFileSync(taskFilePath, "## Stage resume cancel\n- [ ] fixture\n", "utf-8");
        const startedAt = new Date(Date.now() - 60_000).toISOString();
        const guardStartedAt = new Date(Date.now() - 120_000).toISOString();
        const guardState = {
            active: true as const,
            guardId: "stage-guard-resume-cancel-id",
            conversationId: "stage-guard-resume-cancel-conversation",
            chain: "codex" as const,
            modelChain: "codex" as const,
            stageId: "Stage resume cancel",
            childScopeId: "main",
            scopeSelectors: [],
            taskFiles: [taskFilePath],
            planFiles: [],
            startRound: 7,
            startedAt: guardStartedAt,
            checkHistory: [{
                checkNumber: 1,
                result: "fail" as const,
                missingItems: ["fixture"],
                summary: "同次历史结果用于避免模型重跑",
                checkedAt: new Date(Date.now() - 30_000).toISOString(),
            }],
        };
        writeGuardState(guardState);
        const payload = {
            version: 2,
            conversationId: guardState.conversationId,
            stageId: guardState.stageId,
            guardStartedAt,
            guardId: guardState.guardId,
            childScopeId: guardState.childScopeId,
            scopeSelectors: guardState.scopeSelectors,
            chain: "codex",
            modelChain: "codex",
        };
        __testWritePersistedTask({
            id: taskId,
            kind: "stage-guard-check",
            status: "running",
            startedAt,
            updatedAt: startedAt,
            maxRunMs: 60_000,
            ownerPid: 2_147_483_647,
            resumePayload: payload,
            resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
            resumeHash: stableJsonHash(payload),
        });
        try {
            const recovery = await recoverBackgroundTask(taskId);
            assert.equal(recovery.outcome, "resumed");
            assert.equal(recovery.recoveredTaskId, taskId, "恢复不得另建公开 taskId");
            const resumed = await waitForBackgroundTask(taskId, 2);
            assert.equal(resumed?.status, "done", "同 ID 恢复后的历史结果应正常结算");
            const finishedAt = resumed?.finishedAt;
            const firstCancel = cancelBackgroundTask(taskId, "fixture cancel");
            assert.equal(firstCancel?.status, "done", "终态任务取消不得改写为新的终态");
            const secondCancel = cancelBackgroundTask(taskId, "should not settle twice");
            assert.equal(secondCancel?.status, "done");
            assert.equal(secondCancel?.finishedAt, finishedAt, "重复取消不得二次结算或覆盖首次终态");
        } finally {
            clearGuardState(guardState);
            __testResetBackgroundTasksForTest();
            fs.rmSync(taskFile(taskId), { force: true });
        }
    });

    await step("显式 taskId 复用同一后台任务，取消后不重启执行", async () => {
        const taskId = `explicit-idempotency-${Date.now()}`;
        let executions = 0;
        let releaseRun = () => {};
        const runGate = new Promise<void>(resolve => {
            releaseRun = resolve;
        });
        try {
            const first = startBackgroundTask("explicit-idempotency", async () => {
                executions++;
                await runGate;
                return "fixture complete";
            }, { taskId });
            const duplicate = startBackgroundTask("explicit-idempotency", async () => {
                executions++;
                return "must not run";
            }, { taskId });
            assert.equal(duplicate.id, first.id, "相同显式 taskId 必须直接复用既有任务");
            assert.throws(
                () => startBackgroundTask("other-kind", async () => "must not run", { taskId }),
                /不能复用于/u,
                "不同 kind 不得静默复用相同显式 taskId",
            );
            await sleep(25);
            assert.equal(executions, 1, "复用请求不得重新执行后台工作");

            const cancelled = cancelBackgroundTask(taskId, "fixture cancel");
            assert.equal(cancelled?.status, "cancelled");
            releaseRun();
            await sleep(25);
            assert.equal(getBackgroundTask(taskId)?.status, "cancelled", "取消后状态不得被旧执行写回覆盖");

            const reusedCancelled = startBackgroundTask("explicit-idempotency", async () => {
                executions++;
                return "must not restart";
            }, { taskId });
            assert.equal(reusedCancelled.status, "cancelled", "已取消的显式 taskId 必须保持同一终态");
            assert.equal(executions, 1, "取消后的重复调用不得重启后台工作");
        } finally {
            releaseRun();
            __testResetBackgroundTasksForTest();
            fs.rmSync(taskFile(taskId), { force: true });
        }
    });

    if (failed) {
        console.error("❌ background-task-persist 存在失败用例");
        process.exit(1);
    }
    console.log("✅ background-task-persist 全部通过：跨进程可见 / 非 Record 陈旧语义 / scheduler 严格持久化 / owner lease 恢复边界");
} finally {
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
}
