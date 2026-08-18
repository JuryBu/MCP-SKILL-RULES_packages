import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { SchedulerLedgerFileLock } from "../src/record-scheduler-store.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-scheduler-ledger-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const contracts = await import("../src/record-scheduler-contracts.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");

const now = () => new Date().toISOString();

function admissionRequestSummary(taskId: string): Record<string, unknown> {
    return { source: "record-scheduler-store-test", taskId };
}

function admissionBackgroundProjection() {
    return {};
}

function admissionIdentity(taskId: string) {
    const requestSummary = admissionRequestSummary(taskId);
    const backgroundProjection = admissionBackgroundProjection();
    return {
        requestKey: `record-scheduler-store:${taskId}`,
        requestHash: schedulerStore.calculateRecordSchedulerAdmissionRequestHash(
            "record-batch-update",
            requestSummary,
            backgroundProjection,
        ),
    };
}

function makeLedger(taskId: string) {
    const timestamp = now();
    const leaseExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    return {
        schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger" as const,
        revision: 1,
        persistedHash: "placeholder",
        task: {
            taskId,
            schedulerEpoch: 1,
            state: "Running" as const,
            requestMode: "batch_update" as const,
            candidateSnapshotId: `${taskId}-candidate`,
            candidateSnapshotRevision: 1,
            admissionIdentity: admissionIdentity(taskId),
            admission: { state: "LedgerCreated" as const },
            createdAt: timestamp,
            updatedAt: timestamp,
            repairState: "None" as const,
            recordItems: { total: 1, succeeded: 0, failed: 0, unresolved: 0 },
            units: { materialized: 1, eligible: 0, running: 1, done: 0, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot: {
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            snapshotId: `${taskId}-candidate`,
            snapshotRevision: 1,
            snapshotHash: `${taskId}-candidate-hash`,
            snapshotRef: { path: `record-recovery/${taskId}/candidate.json`, hash: `${taskId}-candidate-hash`, byteLength: 32 },
            createdAt: timestamp,
            requestMode: "normal" as const,
            filters: {},
            enumerations: [{ chain: "codex" as const, complete: true, paginationExhausted: true, truncated: false }],
            candidates: [{
                conversationId: `${taskId}-conversation`,
                chain: "codex" as const,
                workspaceHash: "workspace-hash",
                state: "Missing" as const,
                evidence: ["exact-read"],
                evidenceHash: `${taskId}-candidate-evidence`,
            }],
        },
        sourceSnapshots: [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            sourceSnapshotId: `${taskId}-source`,
            snapshotRevision: 1,
            snapshotHash: `${taskId}-source-metadata`,
            snapshotRef: { path: `record-recovery/${taskId}/source.json`, hash: `${taskId}-source-metadata`, byteLength: 32 },
            conversationId: `${taskId}-conversation`,
            chain: "codex" as const,
            workspaceHash: "workspace-hash",
            sourceRevision: "source-revision-1",
            desiredRevision: "source-revision-1",
            contentHash: `${taskId}-source-content`,
            contentRef: { path: `record-recovery/${taskId}/source.spool`, hash: `${taskId}-source-content`, byteLength: 64 },
            formatterVersion: "test-v1",
            readRange: { startRound: 1, endRound: 1, totalRounds: 1 },
            complete: true,
            gaps: [],
            parseWarnings: [],
        }],
        recordWork: [{
            recordWorkKey: `${taskId}-work`,
            conversationId: `${taskId}-conversation`,
            chain: "codex" as const,
            workspaceHash: "workspace-hash",
            desiredRevision: "source-revision-1",
            recordCommitEpoch: 1,
            registryRevision: 1,
            registryRef: { path: `record-recovery/record-work/${taskId}.json`, hash: `${taskId}-registry`, byteLength: 64 },
            schedulerEpoch: 1,
            workLeaseId: `${taskId}-work-lease`,
            leaseOwnerId: "scheduler-owner",
            leaseExpiresAt: leaseExpiry,
            activeTaskIds: [taskId],
            currentFencingToken: 1,
        }],
        units: [{
            unitId: `${taskId}-unit`,
            taskId,
            recordId: `${taskId}-conversation`,
            state: "Running" as const,
            layer: "record",
            splitDepth: 0,
            recordWorkKey: `${taskId}-work`,
            recordCommitEpoch: 1,
            dependencies: [],
            composeOrder: 0,
            sourceSnapshotId: `${taskId}-source`,
            inputHash: `${taskId}-input`,
            estimatedCost: 1,
            routePlan: ["grok" as const],
            attemptedProviders: ["grok" as const],
            retryBudget: 1,
            enqueueTime: timestamp,
            layerEnterTime: timestamp,
        }],
        attempts: [{
            attemptId: `${taskId}-attempt`,
            unitId: `${taskId}-unit`,
            recordWorkKey: `${taskId}-work`,
            originTaskIds: [taskId],
            activeTaskIds: [taskId],
            state: "DispatchIntentPersisted" as const,
            provider: "grok" as const,
            model: "grok-4.5",
            dispatchIntentAt: timestamp,
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: `record-recovery/${taskId}/attempt.json`, hash: `${taskId}-attempt-intent`, byteLength: 64 },
            inputHash: `${taskId}-input`,
            fence: {
                schedulerEpoch: 1,
                recordCommitEpoch: 1,
                fencingToken: 1,
                workLeaseId: `${taskId}-work-lease`,
            },
        }],
        commits: [],
    };
}

async function expectReject(fn: () => Promise<unknown>, matcher: RegExp): Promise<void> {
    await assert.rejects(fn, matcher);
}

async function bindTestAdmission(taskId: string, stored: Awaited<ReturnType<typeof schedulerStore.createRecordSchedulerLedger>>) {
    const ledgerAnchor = schedulerStore.createSchedulerLedgerAnchor(stored);
    const capsule = await schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId,
        taskKind: "record-batch-update",
        admissionIdentity: admissionIdentity(taskId),
        ledgerAnchor,
        requestSummary: admissionRequestSummary(taskId),
        backgroundProjection: admissionBackgroundProjection(),
    });
    return schedulerStore.bindRecordSchedulerAdmission(taskId, stored.revision, ledgerAnchor, capsule.ref);
}

async function createBoundTestLedger(taskId: string) {
    const created = await schedulerStore.createRecordSchedulerLedger(makeLedger(taskId));
    const bound = await bindTestAdmission(taskId, created);
    return { created, bound };
}

async function runWorker(workerPath: string, taskId: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, workerPath, taskId], {
        cwd: process.cwd(),
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: dataRoot },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "close") as [number | null];
    return { code, stdout, stderr };
}

try {
    const taskId = "task-create";
    const created = await schedulerStore.createRecordSchedulerLedger(makeLedger(taskId));
    assert.equal(created.path, path.join(dataRoot, "record-recovery", `record-scheduler-${taskId}.json`));
    assert.equal(created.revision, 1);
    assert.equal(created.hash, schedulerStore.calculateRecordSchedulerLedgerHash(created.ledger));
    assert.equal(created.durability.scope, "process-crash-hot-restart");
    assert.equal(created.durability.temporaryFileSynced, true);
    assert.equal(created.durability.atomicReplaceCompleted, true);
    assert.equal(created.durability.targetFileSynced, true);
    assert.equal(
        created.durability.parentDirectory.method,
        process.platform === "win32" ? "windows-target-file-flush" : "directory-fsync",
    );
    assert.equal(created.durability.parentDirectory.directoryFsyncSupported, process.platform !== "win32");
    const read = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
    assert.equal(read.kind, "current");
    if (read.kind === "current") assert.equal(read.ledger.persistedHash, created.hash);
    const boundInitial = await bindTestAdmission(taskId, created);
    assert.equal(boundInitial.revision, 2, "L1 绑定 immutable capsule 后必须 CAS 到 L2");
    const capsuleReadBack = await schedulerStore.readRecordSchedulerAdmissionCapsule(taskId);
    assert.equal(capsuleReadBack.kind, "current");
    if (capsuleReadBack.kind === "current") {
        const capsuleBytes = await fs.promises.readFile(capsuleReadBack.path);
        assert.equal(capsuleReadBack.ref.byteLength, capsuleBytes.byteLength, "capsule ref 必须使用真实序列化字节长度");
        assert.equal(
            capsuleReadBack.ref.hash,
            crypto.createHash("sha256").update(capsuleBytes).digest("hex"),
            "capsule ref 必须使用真实序列化字节 sha256",
        );
    }

    const hashCorruptTask = "task-hash-corrupt";
    await schedulerStore.createRecordSchedulerLedger(makeLedger(hashCorruptTask));
    const hashCorruptPath = schedulerStore.recordSchedulerLedgerPath(hashCorruptTask);
    const hashCorruptLedger = JSON.parse(await fs.promises.readFile(hashCorruptPath, "utf8"));
    hashCorruptLedger.task.aheadTaskCount = 99;
    await fs.promises.writeFile(hashCorruptPath, JSON.stringify(hashCorruptLedger), "utf8");
    const hashCorrupt = await schedulerStore.readRecordSchedulerLedgerStore(hashCorruptTask, { expectPublished: true });
    assert.deepEqual(hashCorrupt.kind === "repair_required" ? hashCorrupt.reason : undefined, "ledger_hash_mismatch");

    const missingTask = "task-missing";
    assert.equal((await schedulerStore.readRecordSchedulerLedgerStore(missingTask)).kind, "missing");
    const publishedMissing = await schedulerStore.readRecordSchedulerLedgerStore(missingTask, { expectPublished: true });
    assert.deepEqual(publishedMissing.kind === "repair_required" ? publishedMissing.reason : undefined, "missing_published_ledger");
    await expectReject(
        () => schedulerStore.mutateRecordSchedulerLedger(missingTask, 1, ledger => { ledger.task.aheadTaskCount += 1; }),
        /缺失|RepairRequired/u,
    );

    const brokenTask = "task-broken";
    const brokenPath = schedulerStore.recordSchedulerLedgerPath(brokenTask);
    await fs.promises.mkdir(path.dirname(brokenPath), { recursive: true });
    await fs.promises.writeFile(brokenPath, "{broken-json", "utf8");
    const broken = await schedulerStore.readRecordSchedulerLedgerStore(brokenTask, { expectPublished: true });
    assert.deepEqual(broken.kind === "repair_required" ? broken.reason : undefined, "invalid_json");
    await expectReject(
        () => schedulerStore.mutateRecordSchedulerLedger(brokenTask, 1, ledger => { ledger.task.aheadTaskCount += 1; }),
        /需要修复/u,
    );

    const raced = await Promise.allSettled([
        schedulerStore.mutateRecordSchedulerLedger(taskId, 2, ledger => { ledger.task.aheadTaskCount = 1; }),
        schedulerStore.mutateRecordSchedulerLedger(taskId, 2, ledger => { ledger.task.aheadTaskCount = 2; }),
    ]);
    assert.equal(raced.filter(entry => entry.status === "fulfilled").length, 1, "同 revision 的并发 CAS 只能成功一次");
    assert.equal(raced.filter(entry => entry.status === "rejected").length, 1, "另一写入必须明确冲突而不是覆盖");
    assert.ok(raced.some(entry => entry.status === "rejected" && entry.reason instanceof schedulerStore.SchedulerLedgerConflictError));
    const afterRace = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
    assert.equal(afterRace.kind, "current");
    if (afterRace.kind === "current") assert.equal(afterRace.ledger.revision, 3);

    const receipt = await schedulerStore.createAttemptDispatchDurabilityReceipt(taskId, `${taskId}-attempt`, { expectedRevision: 3 });
    assert.equal(receipt.ledgerRevision, 3);
    assert.equal(receipt.ledgerHash, afterRace.kind === "current" ? afterRace.ledger.persistedHash : "");
    assert.equal(receipt.storeDurability.parentDirectory.method, created.durability.parentDirectory.method);
    if (afterRace.kind === "current") {
        assert.equal(contracts.isAttemptDispatchAllowed({ ledger: afterRace.ledger, attemptId: `${taskId}-attempt`, durabilityReceipt: receipt }), true);
    }
    const updated = await schedulerStore.mutateRecordSchedulerLedger(taskId, 3, ledger => { ledger.task.aheadTaskCount += 1; });
    assert.equal(updated.revision, 4);
    assert.equal(contracts.isAttemptDispatchAllowed({ ledger: updated.ledger, attemptId: `${taskId}-attempt`, durabilityReceipt: receipt }), false, "旧 receipt 不得跨 revision 复用");
    const staleLockPath = schedulerStore.recordSchedulerLedgerLockPath(taskId);
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadOwnerPid = deadOwner.pid;
    assert.ok(deadOwnerPid, "stale lock 测试必须取得真实 child PID");
    await once(deadOwner, "close");
    await fs.promises.writeFile(staleLockPath, JSON.stringify({
        taskId,
        token: "abandoned-lock",
        ownerPid: deadOwnerPid,
        acquiredAt: new Date().toISOString(),
    }), "utf8");
    const afterStaleLock = await schedulerStore.mutateRecordSchedulerLedger(taskId, 4, ledger => { ledger.task.aheadTaskCount += 1; }, {
        lock: { staleMs: 60_000, timeoutMs: 2_000 },
    });
    assert.equal(afterStaleLock.revision, 5, "已确认死亡进程的新鲜遗留 lock 应立即恢复，但不能影响 revision CAS");

    await fs.promises.writeFile(staleLockPath, "", "utf8");
    const opaqueStaleAt = new Date(Date.now() - 60_000);
    await fs.promises.utimes(staleLockPath, opaqueStaleAt, opaqueStaleAt);
    const afterOpaqueStaleLock = await schedulerStore.mutateRecordSchedulerLedger(taskId, 5, ledger => { ledger.task.aheadTaskCount += 1; }, {
        lock: { staleMs: 20, timeoutMs: 2_000 },
    });
    assert.equal(afterOpaqueStaleLock.revision, 6, "崩溃窗口遗留的稳定 0 字节 lock 超过安全阈值后必须恢复");

    await fs.promises.writeFile(staleLockPath, "", "utf8");
    await assert.rejects(
        () => schedulerStore.mutateRecordSchedulerLedger(taskId, 6, ledger => { ledger.task.aheadTaskCount += 1; }, {
            lock: { staleMs: 60_000, timeoutMs: 120 },
        }),
        schedulerStore.SchedulerLedgerLockTimeoutError,
    );
    await fs.promises.rm(staleLockPath, { force: true });
    let holderEntered: (() => void) | undefined;
    let releaseHolder: (() => void) | undefined;
    const holderEnteredPromise = new Promise<void>(resolve => { holderEntered = resolve; });
    const releaseHolderPromise = new Promise<void>(resolve => { releaseHolder = resolve; });
    let holderLock: SchedulerLedgerFileLock | undefined;
    const heldLock = schedulerStore.withSchedulerLedgerFileLock(taskId, async lock => {
        holderLock = lock;
        holderEntered?.();
        await releaseHolderPromise;
    }, { staleMs: 60_000, timeoutMs: 2_000 });
    await holderEnteredPromise;
    const holderMetadata = JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")) as {
        ownerPid: number;
        ownerStartedAtMs: number;
    };
    let simulateDeadHolder = true;
    schedulerStore.setSchedulerOwnerProcessProbeForTest(pid => (
        pid === holderMetadata.ownerPid && !simulateDeadHolder
            ? { kind: "alive", startedAtMs: holderMetadata.ownerStartedAtMs }
            : { kind: "dead" }
    ));
    const forcedStaleAt = new Date(Date.now() - 60_000);
    await fs.promises.utimes(staleLockPath, forcedStaleAt, forcedStaleAt);
    let staleObserved = 0;
    let contenderEntered = false;
    schedulerStore.setRecordSchedulerLockTestHookForTest(async context => {
        if (context.phase !== "stale-observed" || staleObserved > 0) return;
        staleObserved += 1;
        simulateDeadHolder = false;
        await holderLock!.heartbeat();
    });
    try {
        await assert.rejects(
            () => schedulerStore.withSchedulerLedgerFileLock(taskId, async () => {
                contenderEntered = true;
            }, { staleMs: 20, timeoutMs: 120 }),
            schedulerStore.SchedulerLedgerLockTimeoutError,
        );
        assert.equal(staleObserved, 1, "测试必须确定性插入 holder heartbeat 到 stale observation 之后");
        assert.equal(contenderEntered, false, "holder heartbeat 后 contender 不能进入临界区");
        await holderLock!.assertHeld();
        const ledgerWhileHeld = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        assert.equal(ledgerWhileHeld.kind === "current" ? ledgerWhileHeld.ledger.revision : -1, 6, "失败的 contender 不能改写 CAS revision");
    } finally {
        schedulerStore.setRecordSchedulerLockTestHookForTest();
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
        releaseHolder?.();
        await heldLock;
    }
    const afterHeartbeatLock = await schedulerStore.mutateRecordSchedulerLedger(taskId, 6, ledger => { ledger.task.aheadTaskCount += 1; });
    assert.equal(afterHeartbeatLock.revision, 7);

    const pidReuseLockTask = "task-pid-reuse-lock";
    await schedulerStore.createRecordSchedulerLedger(makeLedger(pidReuseLockTask));
    const pidReuseLockPath = schedulerStore.recordSchedulerLedgerLockPath(pidReuseLockTask);
    await fs.promises.writeFile(pidReuseLockPath, JSON.stringify({
        taskId: pidReuseLockTask,
        token: "pid-reuse-lock",
        ownerPid: 4242,
        ownerStartedAtMs: 1_000,
        acquiredAt: new Date().toISOString(),
    }), "utf8");
    schedulerStore.setSchedulerOwnerProcessProbeForTest(pid => (
        pid === 4242 ? { kind: "alive", startedAtMs: 61_000 } : { kind: "dead" }
    ));
    try {
        const afterPidReuse = await schedulerStore.mutateRecordSchedulerLedger(
            pidReuseLockTask,
            1,
            ledger => { ledger.task.aheadTaskCount += 1; },
        );
        assert.equal(afterPidReuse.revision, 2, "PID 被系统复用但进程启动时间不符时，旧 lock 必须回收");
    } finally {
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
    }

    if (process.platform === "win32") {
        const transientLockTask = "task-transient-windows-lock";
        const transientCreated = await schedulerStore.createRecordSchedulerLedger(makeLedger(transientLockTask));
        let transientOpenFailures = 0;
        schedulerStore.setRecordSchedulerLockTestHookForTest(context => {
            if (context.phase !== "before-acquire" || context.taskId !== transientLockTask || transientOpenFailures > 0) return;
            transientOpenFailures += 1;
            throw Object.assign(new Error("forced transient Windows scheduler lock race"), { code: "EPERM" });
        });
        try {
            const afterTransientLock = await schedulerStore.mutateRecordSchedulerLedger(
                transientLockTask,
                transientCreated.revision,
                ledger => { ledger.task.aheadTaskCount += 1; },
                { lock: { timeoutMs: 500 } },
            );
            assert.equal(afterTransientLock.revision, transientCreated.revision + 1);
            assert.equal(transientOpenFailures, 1, "Windows 瞬时 EPERM 必须等待后重试，不能把 Task 结算成失败");
        } finally {
            schedulerStore.setRecordSchedulerLockTestHookForTest();
        }

        const transientWriteTask = "task-transient-windows-lock-write";
        const transientWriteCreated = await schedulerStore.createRecordSchedulerLedger(makeLedger(transientWriteTask));
        let transientWriteFailures = 0;
        schedulerStore.setRecordSchedulerLockTestHookForTest(context => {
            if (context.phase !== "before-lock-write" || context.taskId !== transientWriteTask || transientWriteFailures > 0) return;
            transientWriteFailures += 1;
            throw Object.assign(new Error("forced transient Windows scheduler lock write race"), { code: "EPERM" });
        });
        try {
            const afterTransientWrite = await schedulerStore.mutateRecordSchedulerLedger(
                transientWriteTask,
                transientWriteCreated.revision,
                ledger => { ledger.task.aheadTaskCount += 1; },
                { lock: { timeoutMs: 500 } },
            );
            assert.equal(afterTransientWrite.revision, transientWriteCreated.revision + 1);
            assert.equal(transientWriteFailures, 1, "Windows 瞬时 lock write EPERM 必须在同一 owned handle 内重试");
        } finally {
            schedulerStore.setRecordSchedulerLockTestHookForTest();
        }

        const transientStaleTask = "task-transient-windows-stale-read";
        const transientStaleCreated = await schedulerStore.createRecordSchedulerLedger(makeLedger(transientStaleTask));
        const transientStaleLockPath = schedulerStore.recordSchedulerLedgerLockPath(transientStaleTask);
        await fs.promises.writeFile(transientStaleLockPath, JSON.stringify({
            taskId: transientStaleTask,
            token: "transient-stale-lock",
            ownerPid: deadOwnerPid,
            acquiredAt: new Date().toISOString(),
        }), "utf8");
        let transientStaleReadFailures = 0;
        schedulerStore.setRecordSchedulerLockTestHookForTest(context => {
            if (context.phase !== "before-stale-read" || context.taskId !== transientStaleTask || transientStaleReadFailures > 0) return;
            transientStaleReadFailures += 1;
            throw Object.assign(new Error("forced transient Windows stale lock read race"), { code: "EPERM" });
        });
        try {
            const afterTransientStaleRead = await schedulerStore.mutateRecordSchedulerLedger(
                transientStaleTask,
                transientStaleCreated.revision,
                ledger => { ledger.task.aheadTaskCount += 1; },
                { lock: { staleMs: 60_000, timeoutMs: 1_000 } },
            );
            assert.equal(afterTransientStaleRead.revision, transientStaleCreated.revision + 1);
            assert.equal(transientStaleReadFailures, 1, "Windows 瞬时 stale lock read EPERM 必须回到 acquisition loop 重试");
        } finally {
            schedulerStore.setRecordSchedulerLockTestHookForTest();
        }
    }

    const ownerTask = "task-owner";
    const ownerCreated = await schedulerStore.createRecordSchedulerLedger(makeLedger(ownerTask));
    await bindTestAdmission(ownerTask, ownerCreated);
    const oldOwnerReceipt = await schedulerStore.createAttemptDispatchDurabilityReceipt(
        ownerTask,
        `${ownerTask}-attempt`,
        { expectedRevision: 2 },
    );
    const ownerStart = Date.now();
    const firstOwner = await schedulerStore.claimSchedulerOwnerLease(ownerTask, 2, "owner-a", { nowMs: ownerStart, leaseMs: 2_000 });
    assert.equal(firstOwner.ownerLease.schedulerEpoch, 2);
    assert.equal(firstOwner.ownerLease.ownerPid, process.pid, "新 owner lease 必须持久化当前进程 PID");
    assert.ok(firstOwner.ownerLease.ownerStartedAtMs && firstOwner.ownerLease.ownerStartedAtMs > 0, "新 owner lease 必须持久化当前进程启动时间");
    assert.equal(firstOwner.ledger.task.schedulerEpoch, firstOwner.ownerLease.schedulerEpoch, "owner claim 必须在同一 CAS 推进 task epoch");
    assert.equal(firstOwner.ledger.task.state, "Preparing", "未重新取得 registry lease 前 Task 必须停在不可派发恢复态");
    assert.equal(firstOwner.ledger.task.repairState, "Blocked");
    assert.equal(firstOwner.ledger.schedulerOwnerRecovery?.reason, "registry-lease-reacquire");
    assert.equal(firstOwner.ledger.recordWork[0].schedulerEpoch, 1, "owner claim 不得洗白旧 recordWork lease epoch");
    assert.equal(firstOwner.ledger.recordWork[0].currentFencingToken, 1, "owner claim 不得替旧 registry lease 推进 work fencing token");
    assert.equal(firstOwner.ledger.attempts[0].fence.schedulerEpoch, 1, "旧 Attempt fence 必须原样保留");
    assert.equal(firstOwner.ledger.attempts[0].state, "DispatchIntentPersisted", "owner claim 不得伪造新的 Attempt 状态");
    assert.equal(contracts.readRecordSchedulerLedger(firstOwner.ledger).kind, "current", "owner 恢复中间态必须保持 contracts graph 可读");
    assert.equal(contracts.isAttemptDispatchAllowed({
        ledger: firstOwner.ledger,
        attemptId: `${ownerTask}-attempt`,
        durabilityReceipt: oldOwnerReceipt,
        nowMs: ownerStart,
    }), false, "旧 dispatch receipt 必须随 task epoch/CAS 前进而失效");
    schedulerStore.setSchedulerOwnerProcessProbeForTest(async pid => {
        assert.equal(pid, firstOwner.ownerLease.ownerPid);
        return { kind: "alive", startedAtMs: firstOwner.ownerLease.ownerStartedAtMs! };
    });
    try {
        await expectReject(
            () => schedulerStore.claimSchedulerOwnerLease(ownerTask, 3, "owner-b", { nowMs: ownerStart + 1, leaseMs: 2_000 }),
            /仍有效/u,
        );
    } finally {
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
    }
    const heartbeat = await schedulerStore.heartbeatSchedulerOwnerLease(ownerTask, 3, firstOwner.ownerLease, {
        nowMs: ownerStart + 10,
        leaseMs: 2_000,
    });
    assert.equal(heartbeat.ownerLease.schedulerEpoch, firstOwner.ownerLease.schedulerEpoch, "heartbeat 只能续租，不能重置或推进 epoch");
    assert.equal(heartbeat.ownerLease.fencingToken, firstOwner.ownerLease.fencingToken, "heartbeat 不能重置 fencing token");
    assert.equal(heartbeat.ownerLease.ownerPid, firstOwner.ownerLease.ownerPid, "heartbeat 必须保留 owner PID");
    assert.equal(heartbeat.ownerLease.ownerStartedAtMs, firstOwner.ownerLease.ownerStartedAtMs, "heartbeat 必须保留 owner 启动时间");
    const ownerMutation = await schedulerStore.mutateRecordSchedulerLedgerAsOwner(
        ownerTask,
        heartbeat.revision,
        heartbeat.ownerLease,
        ledger => { ledger.task.aheadTaskCount = 7; },
        { nowMs: ownerStart + 11 },
    );
    const secondOwner = await schedulerStore.claimSchedulerOwnerLease(ownerTask, ownerMutation.revision, "owner-b", { nowMs: ownerStart + 2_100, leaseMs: 2_000 });
    assert.equal(secondOwner.ownerLease.schedulerEpoch, 3);
    assert.equal(secondOwner.ledger.task.schedulerEpoch, secondOwner.ownerLease.schedulerEpoch);
    assert.equal(secondOwner.ledger.recordWork[0].schedulerEpoch, 1, "二次接管仍不能替 registry lease 自动升级");
    assert.equal(secondOwner.ledger.attempts[0].fence.schedulerEpoch, 1);
    await expectReject(
        () => schedulerStore.heartbeatSchedulerOwnerLease(
            ownerTask,
            secondOwner.revision,
            firstOwner.ownerLease,
            { nowMs: ownerStart + 2_101, leaseMs: 2_000 },
        ),
        /fencing|过期/u,
    );
    await expectReject(
        () => schedulerStore.mutateRecordSchedulerLedgerAsOwner(
            ownerTask,
            secondOwner.revision,
            firstOwner.ownerLease,
            ledger => { ledger.task.aheadTaskCount = 8; },
            { nowMs: ownerStart + 2_101 },
        ),
        /fencing|过期/u,
    );
    await expectReject(
        () => schedulerStore.mutateRecordSchedulerLedger(
            ownerTask,
            secondOwner.revision,
            ledger => { ledger.task.aheadTaskCount = 9; },
        ),
        /owner|lease/u,
    );
    await expectReject(
        () => schedulerStore.createAttemptDispatchDurabilityReceipt(
            ownerTask,
            `${ownerTask}-attempt`,
            { expectedRevision: secondOwner.revision },
        ),
        /owner|lease/u,
    );
    const afterOwnerFence = await schedulerStore.readRecordSchedulerLedgerStore(ownerTask, { expectPublished: true });
    assert.equal(afterOwnerFence.kind === "current" ? afterOwnerFence.ledger.task.aheadTaskCount : -1, 7);

    const pidReuseTask = "task-owner-pid-reuse";
    const pidReuseBound = await createBoundTestLedger(pidReuseTask);
    const pidReuseFirstOwner = await schedulerStore.claimSchedulerOwnerLease(pidReuseTask, pidReuseBound.bound.revision, "owner-before-reuse", {
        nowMs: ownerStart,
        leaseMs: 60_000,
    });
    schedulerStore.setSchedulerOwnerProcessProbeForTest(() => ({
        kind: "alive",
        startedAtMs: pidReuseFirstOwner.ownerLease.ownerStartedAtMs! + 60_000,
    }));
    let pidReuseTakeover;
    try {
        pidReuseTakeover = await schedulerStore.claimSchedulerOwnerLease(
            pidReuseTask,
            pidReuseFirstOwner.revision,
            "owner-after-reuse",
            { nowMs: ownerStart + 1, leaseMs: 60_000 },
        );
    } finally {
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
    }
    assert.equal(pidReuseTakeover.ownerLease.schedulerEpoch, pidReuseFirstOwner.ownerLease.schedulerEpoch + 1, "PID 被复用时接管必须继续推进 epoch");
    assert.equal(pidReuseTakeover.ownerLease.fencingToken, pidReuseFirstOwner.ownerLease.fencingToken + 1, "PID 被复用时接管必须继续推进 fencing token");

    const unknownOwnerTask = "task-owner-probe-unknown";
    const unknownOwnerBound = await createBoundTestLedger(unknownOwnerTask);
    const unknownOwner = await schedulerStore.claimSchedulerOwnerLease(unknownOwnerTask, unknownOwnerBound.bound.revision, "owner-unknown", {
        nowMs: ownerStart,
        leaseMs: 60_000,
    });
    schedulerStore.setSchedulerOwnerProcessProbeForTest(() => ({ kind: "unknown" }));
    try {
        await expectReject(
            () => schedulerStore.claimSchedulerOwnerLease(unknownOwnerTask, unknownOwner.revision, "owner-contender", { nowMs: ownerStart + 1, leaseMs: 60_000 }),
            /仍有效/u,
        );
    } finally {
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
    }

    const legacyOwnerTask = "task-owner-legacy-identity";
    const legacyOwnerBound = await createBoundTestLedger(legacyOwnerTask);
    const legacyOwner = await schedulerStore.claimSchedulerOwnerLease(legacyOwnerTask, legacyOwnerBound.bound.revision, "owner-legacy", {
        nowMs: ownerStart,
        leaseMs: 60_000,
    });
    const legacyOwnerLedger = structuredClone(legacyOwner.ledger);
    delete legacyOwnerLedger.schedulerOwner?.ownerPid;
    delete legacyOwnerLedger.schedulerOwner?.ownerStartedAtMs;
    legacyOwnerLedger.persistedHash = schedulerStore.calculateRecordSchedulerLedgerHash(legacyOwnerLedger);
    await fs.promises.writeFile(schedulerStore.recordSchedulerLedgerPath(legacyOwnerTask), `${JSON.stringify(legacyOwnerLedger, null, 2)}\n`, "utf8");
    const legacyOwnerRead = await schedulerStore.readRecordSchedulerLedgerStore(legacyOwnerTask, { expectPublished: true });
    assert.equal(legacyOwnerRead.kind, "current", "旧 lease 缺少进程身份字段仍须兼容读取");
    let legacyIdentityProbeCalled = false;
    schedulerStore.setSchedulerOwnerProcessProbeForTest(() => {
        legacyIdentityProbeCalled = true;
        return { kind: "dead" };
    });
    try {
        await expectReject(
            () => schedulerStore.claimSchedulerOwnerLease(legacyOwnerTask, legacyOwner.revision, "owner-contender", { nowMs: ownerStart + 1, leaseMs: 60_000 }),
            /仍有效/u,
        );
    } finally {
        schedulerStore.setSchedulerOwnerProcessProbeForTest();
    }
    assert.equal(legacyIdentityProbeCalled, false, "旧 lease 缺少身份字段必须 fail closed，不能尝试猜测进程状态");

    const childOwnerTask = "task-owner-child-exit";
    const childOwnerBound = await createBoundTestLedger(childOwnerTask);
    const childOwnerWorkerPath = path.join(dataRoot, "scheduler-owner-child-worker.mts");
    const childOwnerStoreImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-store.ts")).href;
    await fs.promises.writeFile(childOwnerWorkerPath, [
        `const taskId = process.argv[2];`,
        `const store = await import(${JSON.stringify(childOwnerStoreImport)});`,
        `const claimed = await store.claimSchedulerOwnerLease(taskId, ${childOwnerBound.bound.revision}, "child-owner", { leaseMs: 60_000 });`,
        `process.stdout.write(JSON.stringify(claimed.ownerLease));`,
    ].join("\n"), "utf8");
    const childOwnerWorker = await runWorker(childOwnerWorkerPath, childOwnerTask);
    assert.equal(childOwnerWorker.code, 0, JSON.stringify(childOwnerWorker));
    const childOwnerLease = JSON.parse(childOwnerWorker.stdout) as { ownerPid: number; ownerStartedAtMs: number };
    assert.notEqual(childOwnerLease.ownerPid, process.pid, "真实 child 必须持久化自己的 PID");
    const childOwnerBeforeTakeover = await schedulerStore.readRecordSchedulerLedgerStore(childOwnerTask, { expectPublished: true });
    assert.equal(childOwnerBeforeTakeover.kind, "current");
    const childOwnerTakeover = await schedulerStore.claimSchedulerOwnerLease(
        childOwnerTask,
        childOwnerBound.bound.revision + 1,
        "owner-after-child-exit",
        { leaseMs: 60_000 },
    );
    assert.equal(childOwnerTakeover.ownerLease.schedulerEpoch, 3, "child 死亡后的未过期 lease 必须立即接管");
    assert.equal(childOwnerTakeover.ownerLease.fencingToken, 2, "child 死亡后的接管必须推进 fencing token");

    const faultTask = "task-fault";
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "before-task-ledger-write") throw new Error("injected before persist");
    });
    await expectReject(() => schedulerStore.createRecordSchedulerLedger(makeLedger(faultTask)), /injected before persist/u);
    assert.equal(fs.existsSync(schedulerStore.recordSchedulerLedgerPath(faultTask)), false, "before persist 故障不得留下半份 ledger");
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    await schedulerStore.createRecordSchedulerLedger(makeLedger(faultTask));
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "after-task-ledger-write") throw new Error("injected after persist");
    });
    await expectReject(
        () => schedulerStore.mutateRecordSchedulerLedger(faultTask, 1, ledger => { ledger.task.aheadTaskCount = 3; }),
        /injected after persist/u,
    );
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    const afterFault = await schedulerStore.readRecordSchedulerLedgerStore(faultTask, { expectPublished: true });
    assert.equal(afterFault.kind, "current");
    if (afterFault.kind === "current") assert.equal(afterFault.ledger.revision, 2, "after persist 故障必须暴露，但已落盘 revision 可恢复读取");

    const legacyTask = "task-legacy";
    await fs.promises.writeFile(schedulerStore.recordSchedulerLedgerPath(legacyTask), JSON.stringify({
        version: 2,
        resumeKey: legacyTask,
        candidates: [],
        completed: [],
        skipped: [],
        failed: [],
        inFlight: [],
    }), "utf8");
    const legacy = await schedulerStore.readRecordSchedulerLedgerStore(legacyTask, { expectPublished: true });
    assert.equal(legacy.kind, "legacy", "旧账本必须只读区分，不能伪装 current 或自动重建");

    const hardExitTask = "task-hard-exit";
    await schedulerStore.createRecordSchedulerLedger(makeLedger(hardExitTask));
    const hardExitWorkerPath = path.join(dataRoot, "scheduler-hard-exit-worker.mts");
    const hardExitStoreImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-store.ts")).href;
    await fs.promises.writeFile(hardExitWorkerPath, [
        `const taskId = process.argv[2];`,
        `const store = await import(${JSON.stringify(hardExitStoreImport)});`,
        `store.setRecordSchedulerStoreFaultInjectorForTest(context => {`,
        `  if (context.point === "after-task-ledger-write") process.exit(73);`,
        `});`,
        `await store.mutateRecordSchedulerLedger(taskId, 1, ledger => { ledger.task.aheadTaskCount = 73; });`,
        `process.exit(74);`,
    ].join("\n"), "utf8");
    const hardExitWorker = await runWorker(hardExitWorkerPath, hardExitTask);
    assert.equal(hardExitWorker.code, 73, JSON.stringify(hardExitWorker));
    const afterHardExit = await schedulerStore.readRecordSchedulerLedgerStore(hardExitTask, { expectPublished: true });
    assert.equal(afterHardExit.kind, "current");
    if (afterHardExit.kind === "current") {
        assert.equal(afterHardExit.ledger.revision, 2, "child hard-exit 后原子替换、target fsync 与 readback 结果必须可恢复");
        assert.equal(afterHardExit.ledger.task.aheadTaskCount, 73);
    }
    const hardExitLockPath = schedulerStore.recordSchedulerLedgerLockPath(hardExitTask);
    assert.equal(fs.existsSync(hardExitLockPath), true, "hard-exit 应留下供恢复协议接管的 lock 证据");
    const hardExitStaleAt = new Date(Date.now() - 60_000);
    await fs.promises.utimes(hardExitLockPath, hardExitStaleAt, hardExitStaleAt);
    const afterHardExitRecovery = await schedulerStore.mutateRecordSchedulerLedger(
        hardExitTask,
        2,
        ledger => { ledger.task.aheadTaskCount = 74; },
        { lock: { staleMs: 20, timeoutMs: 2_000 } },
    );
    assert.equal(afterHardExitRecovery.revision, 3, "dead child 的 lock 必须经原子 claim/quarantine 后恢复 CAS");

    const multiProcessTask = "task-cross-process";
    await schedulerStore.createRecordSchedulerLedger(makeLedger(multiProcessTask));
    const workerPath = path.join(dataRoot, "scheduler-cas-worker.mts");
    const storeImport = pathToFileURL(path.resolve(process.cwd(), "src", "record-scheduler-store.ts")).href;
    await fs.promises.writeFile(workerPath, [
        `const taskId = process.argv[2];`,
        `const store = await import(${JSON.stringify(storeImport)});`,
        `try {`,
        `  await store.mutateRecordSchedulerLedger(taskId, 1, ledger => { ledger.task.aheadTaskCount += 1; });`,
        `  process.stdout.write("CAS_OK");`,
        `} catch (error) {`,
        `  process.stdout.write(error && error.code === "REVISION_CONFLICT" ? "CAS_CONFLICT" : "CAS_ERROR:" + (error instanceof Error ? error.message : String(error)));`,
        `  process.exitCode = error && error.code === "REVISION_CONFLICT" ? 0 : 1;`,
        `}`,
    ].join("\n"), "utf8");
    const workers = await Promise.all([runWorker(workerPath, multiProcessTask), runWorker(workerPath, multiProcessTask)]);
    assert.equal(workers.filter(worker => worker.code === 0 && worker.stdout.includes("CAS_OK")).length, 1, JSON.stringify(workers));
    assert.equal(workers.filter(worker => worker.code === 0 && worker.stdout.includes("CAS_CONFLICT")).length, 1, JSON.stringify(workers));
    const afterCrossProcess = await schedulerStore.readRecordSchedulerLedgerStore(multiProcessTask, { expectPublished: true });
    assert.equal(afterCrossProcess.kind, "current");
    if (afterCrossProcess.kind === "current") assert.equal(afterCrossProcess.ledger.revision, 2);

    const s0Task = "admission-s0";
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "before-task-ledger-write") throw new Error("s0 before l1");
    });
    await expectReject(() => schedulerStore.createRecordSchedulerLedger(makeLedger(s0Task)), /s0 before l1/u);
    assert.equal((await schedulerStore.readRecordSchedulerLedgerStore(s0Task)).kind, "missing", "S0 前不得留下 L1");
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();

    const s1Task = "admission-s1";
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "after-task-ledger-write") throw new Error("s1 after l1");
    });
    await expectReject(() => schedulerStore.createRecordSchedulerLedger(makeLedger(s1Task)), /s1 after l1/u);
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    const s1Recovery = await schedulerStore.verifyOrRecoverTaskAdmission(s1Task);
    assert.equal(s1Recovery.kind, "unadmitted", "S1 只有 L1 且无 capsule 时必须保持未接纳");

    const s2TempTask = "admission-s2-temp";
    const s2TempCreated = await schedulerStore.createRecordSchedulerLedger(makeLedger(s2TempTask));
    const s2TempAnchor = schedulerStore.createSchedulerLedgerAnchor(s2TempCreated);
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "after-admission-capsule-temp-sync") throw new Error("s2 after capsule temp sync");
    });
    await expectReject(() => schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId: s2TempTask,
        taskKind: "record-batch-update",
        admissionIdentity: admissionIdentity(s2TempTask),
        ledgerAnchor: s2TempAnchor,
        requestSummary: admissionRequestSummary(s2TempTask),
        backgroundProjection: admissionBackgroundProjection(),
    }), /s2 after capsule temp sync/u);
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    assert.equal(fs.existsSync(schedulerStore.recordSchedulerAdmissionCapsulePath(s2TempTask)), false, "临时 capsule 未发布时不得形成 admission 事实");
    const s2TempRecovery = await schedulerStore.verifyOrRecoverTaskAdmission(s2TempTask);
    assert.equal(s2TempRecovery.kind, "unadmitted", "capsule temp 崩溃窗只能保留 L1 未接纳状态");

    const s2Task = "admission-s2";
    const s2Created = await schedulerStore.createRecordSchedulerLedger(makeLedger(s2Task));
    const s2Anchor = schedulerStore.createSchedulerLedgerAnchor(s2Created);
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "after-admission-capsule-publish") throw new Error("s2 after capsule publish");
    });
    await expectReject(() => schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId: s2Task,
        taskKind: "record-batch-update",
        admissionIdentity: admissionIdentity(s2Task),
        ledgerAnchor: s2Anchor,
        requestSummary: admissionRequestSummary(s2Task),
        backgroundProjection: admissionBackgroundProjection(),
    }), /s2 after capsule publish/u);
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    const s2Recovery = await schedulerStore.verifyOrRecoverTaskAdmission(s2Task);
    assert.equal(s2Recovery.kind, "verified", "S2 capsule 已发布时重启必须前滚到 L2");
    if (s2Recovery.kind === "verified") assert.equal(s2Recovery.ledger.revision, 2);

    const s3Task = "admission-s3";
    const s3Created = await schedulerStore.createRecordSchedulerLedger(makeLedger(s3Task));
    const s3Anchor = schedulerStore.createSchedulerLedgerAnchor(s3Created);
    const s3Capsule = await schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId: s3Task,
        taskKind: "record-batch-update",
        admissionIdentity: admissionIdentity(s3Task),
        ledgerAnchor: s3Anchor,
        requestSummary: admissionRequestSummary(s3Task),
        backgroundProjection: admissionBackgroundProjection(),
    });
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest(context => {
        if (context.point === "after-task-ledger-write") throw new Error("s3 after l2");
    });
    await expectReject(
        () => schedulerStore.bindRecordSchedulerAdmission(s3Task, 1, s3Anchor, s3Capsule.ref),
        /s3 after l2/u,
    );
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    const s3Recovery = await schedulerStore.verifyOrRecoverTaskAdmission(s3Task);
    assert.equal(s3Recovery.kind, "verified", "S3 L2 已落盘时重启必须读到已绑定 admission");

    const l3Task = "admission-l3-anchor";
    const l3 = await createBoundTestLedger(l3Task);
    const l3Advanced = await schedulerStore.mutateRecordSchedulerLedger(l3Task, l3.bound.revision, ledger => {
        ledger.task.aheadTaskCount += 1;
    });
    const l3Verification = await schedulerStore.verifyOrRecoverTaskAdmission(l3Task);
    assert.equal(l3Verification.kind, "verified", "L3+ 不得把合法 L1 anchor 误判为陈旧");
    if (l3Verification.kind === "verified") {
        assert.equal(l3Verification.ledger.revision, l3Advanced.revision);
        assert.equal(l3Verification.receipt.ledgerAnchor.revision, 1);
        assert.equal(l3Verification.receipt.ledgerAnchor.hash, l3.created.hash);
    }

    for (const tamper of ["capsule-task-id", "capsule-kind", "capsule-bytes", "ledger-path", "ledger-hash"] as const) {
        const tamperTask = `admission-${tamper}`;
        const bound = await createBoundTestLedger(tamperTask);
        if (tamper === "capsule-task-id" || tamper === "capsule-kind" || tamper === "capsule-bytes") {
            const capsulePath = schedulerStore.recordSchedulerAdmissionCapsulePath(tamperTask);
            const capsule = JSON.parse(await fs.promises.readFile(capsulePath, "utf8"));
            if (tamper === "capsule-task-id") capsule.taskId = "different-task";
            if (tamper === "capsule-kind") capsule.taskKind = "record-update";
            if (tamper === "capsule-bytes") capsule.requestSummary = { tampered: true };
            await fs.promises.writeFile(capsulePath, JSON.stringify(capsule), "utf8");
        } else {
            await schedulerStore.mutateRecordSchedulerLedger(tamperTask, bound.bound.revision, ledger => {
                if (ledger.task.admission.state !== "EnvelopeBound") throw new Error("expected L2");
                if (tamper === "ledger-path") ledger.task.admission.capsuleRef.path = path.join(dataRoot, "elsewhere.json");
                if (tamper === "ledger-hash") ledger.task.admission.capsuleRef.hash = "f".repeat(64);
            });
        }
        const verification = await schedulerStore.verifyOrRecoverTaskAdmission(tamperTask);
        assert.equal(verification.kind, "repair_required", `${tamper} 必须进入 RepairRequired`);
        await expectReject(
            () => schedulerStore.createAttemptDispatchDurabilityReceipt(tamperTask, `${tamperTask}-attempt`),
            /capsule|admission|RepairRequired/u,
        );
    }

    console.log("✅ record-scheduler-store 通过：严格 create/repair 区分、跨进程 CAS、hash/receipt、owner fencing、故障注入与 legacy 只读边界");
} finally {
    schedulerStore.setRecordSchedulerStoreFaultInjectorForTest();
    schedulerStore.setRecordSchedulerLockTestHookForTest();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
