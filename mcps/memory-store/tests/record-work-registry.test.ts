import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const registry = await import("../src/record-work-registry.ts");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-work-registry-"));
const identity = {
    chain: "codex" as const,
    workspaceHash: "workspace-hash",
    conversationId: "conversation-id",
};
const location = {
    dataRoot,
    identity,
    lockOptions: { leaseMs: 2_000, heartbeatMs: 250, waitMs: 10_000 },
};
const firstPublicationToken = "first-publication-token-record-work-registry";
const wrongPublicationToken = "wrong-publication-token-record-work-registry";
const startMs = Date.parse("2026-07-13T00:00:00.000Z");
const registryLockTestHooksKey = Symbol.for("memory-store.record-work-registry.lock-test-hooks");

type RegistryLockTestHooks = {
    afterReclaimValidated?: (details: { lockPath: string; reclaimPath: string }) => void | Promise<void>;
    afterReclaimBarrierRetireValidated?: (details: { reclaimPath: string; observedToken?: string }) => void | Promise<void>;
    beforeInitialLockStateWrite?: (details: { lockPath: string; token: string }) => void | Promise<void>;
    beforeFailedAcquireLockCleanup?: (details: { lockPath: string; token: string }) => void | Promise<void>;
    beforeFailedAcquireLockDelete?: (details: { lockPath: string; token: string }) => void | Promise<void>;
};

type WorkFence = {
    recordWorkKey: string;
    recordCommitEpoch: number;
    fencingToken: number;
    workLeaseId: string;
    schedulerEpoch: number;
};

function deferred<Value = void>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function within<Value>(promise: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} 在 ${timeoutMs}ms 内未完成`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function waitForCondition(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`${label} 在 ${timeoutMs}ms 内未满足`);
        await sleep(1);
    }
}

async function readReady() {
    const result = await registry.readRecordWorkRegistry(location);
    assert.equal(result.kind, "ready", "registry 应可严格读取");
    return result;
}

async function attachWithRetry(taskId: string, desiredRevision: string): Promise<Extract<Awaited<ReturnType<typeof registry.startOrAttachRecordWork>>, { kind: "started" }>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await readReady();
        const result = await registry.startOrAttachRecordWork({
            ...location,
            taskId,
            desiredRevision,
            expectedRegistryRevision: current.registry.registryRevision,
            nowMs: startMs + attempt,
        });
        if (result.kind === "started") return result;
        if (result.kind !== "cas_conflict") assert.fail(`并发 attach 不应失败: ${JSON.stringify(result)}`);
    }
    assert.fail(`task ${taskId} 在重试后仍无法 attach`);
}

async function attachFromChildProcess(taskId: string): Promise<void> {
    const workerPath = path.join(dataRoot, `${taskId}.mjs`);
    const moduleUrl = pathToFileURL(path.resolve("src/record-work-registry.ts")).href;
    fs.writeFileSync(workerPath, `
import { readRecordWorkRegistry, startOrAttachRecordWork } from ${JSON.stringify(moduleUrl)};
const location = ${JSON.stringify(location)};
for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readRecordWorkRegistry(location);
    if (current.kind !== "ready") throw new Error("child 读取 registry 失败: " + JSON.stringify(current));
    const result = await startOrAttachRecordWork({ ...location, taskId: ${JSON.stringify(taskId)}, desiredRevision: "revision-1", expectedRegistryRevision: current.registry.registryRevision });
    if (result.kind === "started") process.exit(0);
    if (result.kind !== "cas_conflict") throw new Error(JSON.stringify(result));
}

throw new Error("child CAS 重试耗尽");
`, "utf8");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", chunk => { output += String(chunk); });
        child.stderr.on("data", chunk => { output += String(chunk); });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`child ${taskId} 退出 ${code}: ${output}`)));
    });
}

async function renewLeaseWithRetry(recordWorkKey: string, fence: WorkFence): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await readReady();
        const result = await registry.acquireRecordWorkLease({
            ...location,
            recordWorkKey,
            taskId: "task-01",
            ownerId: "owner-a",
            schedulerEpoch: 7,
            workLeaseId: fence.workLeaseId,
            expectedRegistryRevision: current.registry.registryRevision,
            leaseDurationMs: 500,
            nowMs: startMs + 270,
        });
        if (result.kind === "acquired") return;
        if (result.kind !== "cas_conflict") assert.fail(`并发 lease 不应失败: ${JSON.stringify(result)}`);
    }
    assert.fail("并发 lease 在重试后仍未取得锁");
}

async function stageAndPublish(recordWorkKey: string, fence: WorkFence, round: number, worker: number): Promise<void> {
    const staged = await registry.withAuthorizedRecordWorkCommit({
        ...location,
        recordWorkKey,
        taskId: "task-01",
        ownerId: "owner-a",
        fence,
        nowMs: startMs + 280,
    }, () => `pressure-stage-${round}-${worker}`);
    assert.equal(staged.kind, "staged", "并发 commit 必须保留 staged 语义");
    if (staged.kind !== "staged") return;
    const published = await registry.publishRecordWorkCommit(location, staged.commitToken, () => `pressure-publish-${round}-${worker}`, { nowMs: startMs + 280 });
    assert.equal(published.kind, "committed", "并发 staged token 应能在短锁内 publish");
}

async function testAdvanceRecordWorkFence(): Promise<void> {
    const fenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-work-fence-advance-"));
    const fenceLocation = {
        dataRoot: fenceRoot,
        identity: { chain: "codex" as const, workspaceHash: "fence-workspace", conversationId: "fence-conversation" },
    };
    const fenceToken = "first-publication-token-fence-advance";
    const fenceStartMs = startMs + 10_000;
    try {
        assert.equal((await registry.initializeRecordWorkRegistryIdentity(fenceLocation, { firstPublicationToken: fenceToken, nowMs: fenceStartMs })).kind, "prepared");
        const created = await registry.createRecordWorkRegistry(fenceLocation, { firstPublicationToken: fenceToken, nowMs: fenceStartMs });
        assert.equal(created.kind, "created");
        if (created.kind !== "created") throw new Error("fence advance registry 创建失败");
        const started = await registry.startOrAttachRecordWork({
            ...fenceLocation,
            desiredRevision: "revision-1",
            taskId: "task-fence",
            expectedRegistryRevision: created.registry.registryRevision,
            nowMs: fenceStartMs + 1,
        });
        assert.equal(started.kind, "started");
        if (started.kind !== "started") throw new Error("fence advance work 创建失败");
        const firstLease = await registry.acquireRecordWorkLease({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            schedulerEpoch: 7,
            expectedRegistryRevision: started.registry.registryRevision,
            leaseDurationMs: 20,
            nowMs: fenceStartMs + 2,
        });
        assert.equal(firstLease.kind, "acquired");
        if (firstLease.kind !== "acquired") throw new Error("fence advance 初始 lease 失败");

        const advanced = await registry.advanceRecordWorkFence({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: firstLease.fence,
            expectedRegistryRevision: firstLease.registry.registryRevision,
            leaseDurationMs: 20,
            nowMs: fenceStartMs + 10,
        });
        assert.equal(advanced.kind, "advanced", "完整旧 fence 应原子轮换");
        if (advanced.kind !== "advanced") throw new Error(`fence advance 失败: ${JSON.stringify(advanced)}`);
        assert.equal(advanced.registryRevision, firstLease.registry.registryRevision + 1);
        assert.equal(advanced.registry.registryRevision, advanced.registryRevision, "返回的完整 registry 必须对应新 revision");
        assert.equal(advanced.registry.fencingTokenCursor, firstLease.fence.fencingToken + 1, "全局 token cursor 必须递增");
        assert.equal(advanced.work.currentFencingToken, firstLease.fence.fencingToken + 1);
        assert.notEqual(advanced.lease.workLeaseId, firstLease.lease.workLeaseId, "轮换必须生成不可复用的新 leaseId");
        assert.equal(advanced.lease.ownerId, firstLease.lease.ownerId, "轮换不得更换 owner");
        assert.equal(advanced.lease.schedulerEpoch, firstLease.lease.schedulerEpoch, "轮换不得更换 scheduler epoch");
        assert.deepEqual(advanced.fence, {
            schedulerEpoch: firstLease.fence.schedulerEpoch,
            recordCommitEpoch: firstLease.fence.recordCommitEpoch,
            fencingToken: firstLease.fence.fencingToken + 1,
            workLeaseId: advanced.lease.workLeaseId,
        }, "返回 fence 必须完整绑定新的 lease");
        assert.equal(advanced.work.ownerLease?.workLeaseId, advanced.lease.workLeaseId, "返回 work/lease 必须来自同一次 registry mutation");

        const replay = await registry.advanceRecordWorkFence({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: firstLease.fence,
            expectedRegistryRevision: advanced.registryRevision,
            nowMs: fenceStartMs + 11,
        });
        assert.equal(replay.kind, "rejected", "同一份旧 fence 不得重放");
        if (replay.kind === "rejected") assert.equal(replay.reason, "lease_mismatch");

        const expiredAdvance = await registry.advanceRecordWorkFence({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: advanced.fence,
            expectedRegistryRevision: advanced.registryRevision,
            leaseDurationMs: 20,
            nowMs: fenceStartMs + 31,
        });
        assert.equal(expiredAdvance.kind, "advanced", "旧 lease 即使恰好过期，只要完整 fence 未漂移仍可轮换");
        if (expiredAdvance.kind !== "advanced") throw new Error(`过期 lease fence advance 失败: ${JSON.stringify(expiredAdvance)}`);

        const driftCases = [
            { label: "owner", input: { ownerId: "owner-drift" }, reason: "owner_mismatch" },
            { label: "scheduler epoch", input: { fence: { ...expiredAdvance.fence, schedulerEpoch: expiredAdvance.fence.schedulerEpoch + 1 } }, reason: "scheduler_epoch_mismatch" },
            { label: "record commit epoch", input: { fence: { ...expiredAdvance.fence, recordCommitEpoch: expiredAdvance.fence.recordCommitEpoch + 1 } }, reason: "record_commit_epoch_mismatch" },
            { label: "lease", input: { fence: { ...expiredAdvance.fence, workLeaseId: "drifted-lease-id" } }, reason: "lease_mismatch" },
            { label: "token", input: { fence: { ...expiredAdvance.fence, fencingToken: expiredAdvance.fence.fencingToken + 1 } }, reason: "fencing_token_mismatch" },
        ] as const;
        for (const drift of driftCases) {
            const result = await registry.advanceRecordWorkFence({
                ...fenceLocation,
                recordWorkKey: started.work.recordWorkKey,
                taskId: "task-fence",
                ownerId: "owner-fence",
                fence: expiredAdvance.fence,
                expectedRegistryRevision: expiredAdvance.registryRevision,
                nowMs: fenceStartMs + 32,
                ...drift.input,
            });
            assert.equal(result.kind, "rejected", `${drift.label} 漂移必须拒绝`);
            if (result.kind === "rejected") assert.equal(result.reason, drift.reason);
        }

        const claimed = await registry.claimRecordWorkPublication({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: expiredAdvance.fence,
            expectedRegistryRevision: expiredAdvance.registryRevision,
            commitId: "commit-fence",
            inputHash: "input-fence",
            bodyHash: "body-fence",
            coveredRevision: "revision-1",
            metadataHash: "metadata-fence",
            metadataSnapshot: { title: "fence" },
            nowMs: fenceStartMs + 33,
        });
        assert.equal(claimed.kind, "claimed");
        if (claimed.kind !== "claimed") throw new Error("fence advance publication claim 失败");
        const publicationClaimed = await registry.advanceRecordWorkFence({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: expiredAdvance.fence,
            expectedRegistryRevision: claimed.registry.registryRevision,
            nowMs: fenceStartMs + 34,
        });
        assert.equal(publicationClaimed.kind, "rejected", "已有 publicationClaim 时不得轮换 fence");
        if (publicationClaimed.kind === "rejected") assert.equal(publicationClaimed.reason, "publication_claimed");

        const casConflict = await registry.advanceRecordWorkFence({
            ...fenceLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-fence",
            ownerId: "owner-fence",
            fence: expiredAdvance.fence,
            expectedRegistryRevision: expiredAdvance.registry.registryRevision,
            nowMs: fenceStartMs + 35,
        });
        assert.equal(casConflict.kind, "cas_conflict", "旧 registry revision 必须以现有 CAS 风格拒绝");
        if (casConflict.kind === "cas_conflict") {
            assert.equal(casConflict.expectedRegistryRevision, expiredAdvance.registry.registryRevision);
            assert.equal(casConflict.actualRegistryRevision, claimed.registry.registryRevision);
        }
    } finally {
        fs.rmSync(fenceRoot, { recursive: true, force: true });
    }
}

async function testPublicationWinnerClaimAndInitialCreationWalRecovery(): Promise<void> {
    const claimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-work-claim-"));
    const claimIdentity = { chain: "codex" as const, workspaceHash: "winner-workspace", conversationId: "winner-conversation" };
    const claimLocation = { dataRoot: claimRoot, identity: claimIdentity };
    const token = "first-publication-token-publication-winner";
    try {
        assert.equal((await registry.initializeRecordWorkRegistryIdentity(claimLocation, { firstPublicationToken: token, nowMs: startMs })).kind, "prepared");
        assert.equal((await registry.createRecordWorkRegistry(claimLocation, { firstPublicationToken: token, nowMs: startMs })).kind, "created");
        const initialPath = registry.recordWorkRegistryPath(claimLocation);
        fs.rmSync(initialPath, { force: true });
        const recoveredInitial = await registry.createRecordWorkRegistry(claimLocation, { firstPublicationToken: token, nowMs: startMs + 1 });
        assert.equal(recoveredInitial.kind, "created", "仅首次 Published→registry 缺失窗口必须由精确 WAL 自动补齐");
        if (recoveredInitial.kind !== "created") throw new Error("首次 creation WAL 自动补齐失败");
        assert.equal((await registry.readRecordWorkRegistry(claimLocation)).kind, "ready");

        const startedA = await registry.startOrAttachRecordWork({
            ...claimLocation,
            desiredRevision: "revision-1",
            taskId: "task-A",
            expectedRegistryRevision: recoveredInitial.registry.registryRevision,
            nowMs: startMs + 10,
        });
        assert.equal(startedA.kind, "started");
        if (startedA.kind !== "started") throw new Error("task A 创建 winner work 失败");
        const startedB = await registry.startOrAttachRecordWork({
            ...claimLocation,
            desiredRevision: "revision-1",
            taskId: "task-B",
            expectedRegistryRevision: startedA.registry.registryRevision,
            nowMs: startMs + 11,
        });
        assert.equal(startedB.kind, "started");
        if (startedB.kind !== "started") throw new Error("task B 挂接 winner work 失败");
        const leaseA = await registry.acquireRecordWorkLease({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-A",
            ownerId: "owner-A",
            schedulerEpoch: 1,
            expectedRegistryRevision: startedB.registry.registryRevision,
            leaseDurationMs: 20,
            nowMs: startMs + 12,
        });
        assert.equal(leaseA.kind, "acquired");
        if (leaseA.kind !== "acquired") throw new Error("task A winner lease 失败");
        const claimA = await registry.claimRecordWorkPublication({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-A",
            ownerId: "owner-A",
            fence: leaseA.fence,
            expectedRegistryRevision: leaseA.registry.registryRevision,
            commitId: "commit-A",
            inputHash: "input-A",
            bodyHash: "body-A",
            coveredRevision: "revision-1",
            metadataHash: "meta-A",
            metadataSnapshot: { title: "A" },
            nowMs: startMs + 13,
        });
        assert.equal(claimA.kind, "claimed", "第一个 commit 必须取得不可覆写 winner claim");
        if (claimA.kind !== "claimed") throw new Error("winner claim 未落盘");
        const leaseB = await registry.acquireRecordWorkLease({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-B",
            ownerId: "owner-B",
            schedulerEpoch: 2,
            expectedRegistryRevision: claimA.registry.registryRevision,
            leaseDurationMs: 500,
            nowMs: startMs + 40,
        });
        assert.equal(leaseB.kind, "acquired", "A lease 到期后 B 必须能取得更高 fence");
        if (leaseB.kind !== "acquired") throw new Error("B takeover lease 失败");
        assert.ok(leaseB.fence.fencingToken > leaseA.fence.fencingToken);
        const conflict = await registry.claimRecordWorkPublication({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-B",
            ownerId: "owner-B",
            fence: leaseB.fence,
            expectedRegistryRevision: leaseB.registry.registryRevision,
            commitId: "commit-B-different",
            inputHash: "input-B",
            bodyHash: "body-B",
            coveredRevision: "revision-1",
            metadataHash: "meta-B",
            metadataSnapshot: { title: "B" },
            nowMs: startMs + 41,
        });
        assert.equal(conflict.kind, "conflict", "更高 fence 不得覆盖同 revision 已发布的 winner");
        let crossTaskSameCommitOperationRan = false;
        const sameCommitAuthority = await registry.withRecordWorkPublicationAuthority({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-B",
            ownerId: "owner-B",
            fence: leaseB.fence,
            expectedRegistryRevision: leaseB.registry.registryRevision,
            commitId: "commit-A",
            inputHash: "input-A",
            bodyHash: "body-A",
            coveredRevision: "revision-1",
            metadataHash: "meta-A",
            metadataSnapshot: { title: "A" },
            nowMs: startMs + 41,
        }, async () => {
            crossTaskSameCommitOperationRan = true;
        });
        assert.equal(sameCommitAuthority.kind, "conflict", "另一个 task 即使伪造相同 commitId 也不得进入 winner authority");
        assert.equal(crossTaskSameCommitOperationRan, false);
        const reusable = await registry.claimRecordWorkPublication({
            ...claimLocation,
            recordWorkKey: startedA.work.recordWorkKey,
            taskId: "task-B",
            ownerId: "owner-B",
            fence: leaseB.fence,
            expectedRegistryRevision: leaseB.registry.registryRevision,
            commitId: "commit-B-same",
            inputHash: "input-A",
            bodyHash: "body-A",
            coveredRevision: "revision-1",
            metadataHash: "meta-B-snapshot-ignored",
            metadataSnapshot: { title: "B" },
            nowMs: startMs + 42,
        });
        assert.equal(reusable.kind, "reused", "相同 input/body/revision 的后续 task 必须复用 winner 而非再发布");
        const afterReuse = await registry.readRecordWorkRegistry(claimLocation);
        assert.equal(afterReuse.kind, "ready");
        if (afterReuse.kind !== "ready") throw new Error("winner registry 读取失败");
        const winner = afterReuse.registry.works.find(work => work.recordWorkKey === startedA.work.recordWorkKey)?.publicationClaim;
        assert.deepEqual(winner && { commitId: winner.commitId, inputHash: winner.inputHash, bodyHash: winner.bodyHash, coveredRevision: winner.coveredRevision }, {
            commitId: "commit-A", inputHash: "input-A", bodyHash: "body-A", coveredRevision: "revision-1",
        });

        const successor = await registry.startOrAttachRecordWork({
            ...claimLocation,
            desiredRevision: "revision-2",
            taskId: "task-C",
            expectedRegistryRevision: afterReuse.registry.registryRevision,
            nowMs: startMs + 50,
        });
        assert.equal(successor.kind, "started");
        if (successor.kind !== "started") throw new Error("新 desiredRevision work 创建失败");
        const historicalWinner = successor.registry.works.find(work => work.recordWorkKey === startedA.work.recordWorkKey)?.publicationClaim;
        assert.equal(historicalWinner?.commitId, "commit-A", "supersede 不得清掉旧 work 的 winner receipt");
        const successorLease = await registry.acquireRecordWorkLease({
            ...claimLocation,
            recordWorkKey: successor.work.recordWorkKey,
            taskId: "task-C",
            ownerId: "owner-C",
            schedulerEpoch: 3,
            expectedRegistryRevision: successor.registry.registryRevision,
            leaseDurationMs: 500,
            nowMs: startMs + 51,
        });
        assert.equal(successorLease.kind, "acquired");
        if (successorLease.kind !== "acquired") throw new Error("新 work lease 失败");
        const successorClaim = await registry.claimRecordWorkPublication({
            ...claimLocation,
            recordWorkKey: successor.work.recordWorkKey,
            taskId: "task-C",
            ownerId: "owner-C",
            fence: successorLease.fence,
            expectedRegistryRevision: successorLease.registry.registryRevision,
            commitId: "commit-C",
            inputHash: "input-C",
            bodyHash: "body-C",
            coveredRevision: "revision-2",
            metadataHash: "meta-C",
            metadataSnapshot: { title: "C" },
            nowMs: startMs + 52,
        });
        assert.equal(successorClaim.kind, "claimed", "新 desiredRevision / work epoch 必须可合法发布新 winner");
    } finally {
        fs.rmSync(claimRoot, { recursive: true, force: true });
    }
}

async function testPublicationGenerationRollover(): Promise<void> {
    const rolloverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-work-rollover-"));
    const rolloverLocation = {
        dataRoot: rolloverRoot,
        identity: { chain: "codex" as const, workspaceHash: "workspace-rollover", conversationId: "conversation-rollover" },
    };
    try {
        const token = "first-publication-token-rollover";
        await registry.initializeRecordWorkRegistryIdentity(rolloverLocation, { firstPublicationToken: token, nowMs: startMs });
        const created = await registry.createRecordWorkRegistry(rolloverLocation, { firstPublicationToken: token, nowMs: startMs + 1 });
        assert.equal(created.kind, "created");
        if (created.kind !== "created") throw new Error("rollover registry 创建失败");
        const oldTask = await registry.startOrAttachRecordWork({
            ...rolloverLocation,
            desiredRevision: "revision-rollover",
            taskId: "task-rollover-old",
            expectedRegistryRevision: created.registry.registryRevision,
            nowMs: startMs + 2,
        });
        assert.equal(oldTask.kind, "started");
        if (oldTask.kind !== "started") throw new Error("rollover old task 创建失败");
        const oldLease = await registry.acquireRecordWorkLease({
            ...rolloverLocation,
            recordWorkKey: oldTask.work.recordWorkKey,
            taskId: "task-rollover-old",
            ownerId: "owner-rollover-old",
            schedulerEpoch: 1,
            expectedRegistryRevision: oldTask.registry.registryRevision,
            leaseDurationMs: 10,
            nowMs: startMs + 3,
        });
        assert.equal(oldLease.kind, "acquired");
        if (oldLease.kind !== "acquired") throw new Error("rollover old lease 失败");
        const oldClaim = await registry.claimRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: oldTask.work.recordWorkKey,
            taskId: "task-rollover-old",
            ownerId: "owner-rollover-old",
            fence: oldLease.fence,
            expectedRegistryRevision: oldLease.registry.registryRevision,
            commitId: "commit-rollover-old",
            inputHash: "input-rollover-old",
            bodyHash: "body-rollover-old",
            coveredRevision: "revision-rollover",
            metadataHash: "metadata-rollover-old",
            metadataSnapshot: { title: "old" },
            nowMs: startMs + 4,
        });
        assert.equal(oldClaim.kind, "claimed");
        if (oldClaim.kind !== "claimed") throw new Error("rollover old claim 失败");
        const newTask = await registry.startOrAttachRecordWork({
            ...rolloverLocation,
            desiredRevision: "revision-rollover",
            taskId: "task-rollover-new",
            expectedRegistryRevision: oldClaim.registry.registryRevision,
            nowMs: startMs + 20,
        });
        assert.equal(newTask.kind, "started");
        if (newTask.kind !== "started") throw new Error("rollover new task attach 失败");
        const newLease = await registry.acquireRecordWorkLease({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            schedulerEpoch: 2,
            expectedRegistryRevision: newTask.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 20,
        });
        assert.equal(newLease.kind, "acquired");
        if (newLease.kind !== "acquired") throw new Error("rollover new lease 失败");
        const rolled = await registry.rolloverRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            fence: newLease.fence,
            expectedRegistryRevision: newLease.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 21,
            withArtifactVerification: async (_claim, apply) => await apply({ kind: "diverged", artifactStateHash: "a".repeat(64) }),
        });
        assert.equal(rolled.kind, "rolled_over");
        if (rolled.kind !== "rolled_over") throw new Error("publication rollover 应成功");
        assert.ok(rolled.work.recordCommitEpoch > oldLease.work.recordCommitEpoch);
        assert.ok(rolled.fence.fencingToken > newLease.fence.fencingToken);
        assert.notEqual(rolled.fence.workLeaseId, newLease.fence.workLeaseId);
        assert.equal(rolled.work.publicationClaim, undefined);
        assert.equal(rolled.work.publicationHistory?.at(-1)?.claim.commitId, "commit-rollover-old");
        assert.equal(rolled.work.publicationHistory?.at(-1)?.supersededByTaskId, "task-rollover-new");

        const oldAuthority = await registry.authorizeRecordWorkCommit({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-old",
            ownerId: "owner-rollover-old",
            fence: oldLease.fence,
            nowMs: startMs + 22,
        });
        assert.equal(oldAuthority.kind, "rejected", "rollover 后旧 epoch/fence 必须失权");
        const newClaim = await registry.claimRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            fence: rolled.fence,
            expectedRegistryRevision: rolled.registry.registryRevision,
            commitId: "commit-rollover-new",
            inputHash: "input-rollover-new",
            bodyHash: "body-rollover-new",
            coveredRevision: "revision-rollover",
            metadataHash: "metadata-rollover-new",
            metadataSnapshot: { title: "new" },
            nowMs: startMs + 22,
        });
        assert.equal(newClaim.kind, "claimed", "新发布代际必须可建立新 winner claim");
        if (newClaim.kind !== "claimed") throw new Error("rollover new claim 失败");
        const consistent = await registry.rolloverRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            fence: rolled.fence,
            expectedRegistryRevision: newClaim.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 23,
            withArtifactVerification: async (_claim, apply) => await apply({ kind: "consistent" }),
        });
        assert.equal(consistent.kind, "not_required");
        if (consistent.kind === "not_required") {
            assert.equal(consistent.reason, "artifacts_match_claim");
            assert.equal(consistent.work.recordCommitEpoch, rolled.work.recordCommitEpoch);
        }
        const forcedDiverged = await registry.rolloverRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            fence: rolled.fence,
            expectedRegistryRevision: newClaim.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 24,
            rolloverMode: "force_refresh",
            withArtifactVerification: async (_claim, apply) => await apply({
                kind: "diverged",
                artifactStateHash: "c".repeat(64),
            }),
        });
        assert.equal(forcedDiverged.kind, "rejected", "force refresh 不得把缺失或 ownerless 的可见 artifact 当作安全发布换代");
        if (forcedDiverged.kind === "rejected") {
            assert.equal(forcedDiverged.reason, "force_refresh_artifacts_not_consistent");
            assert.equal(forcedDiverged.work?.recordCommitEpoch, rolled.work.recordCommitEpoch);
            assert.equal(forcedDiverged.work?.publicationClaim?.commitId, "commit-rollover-new");
        }
        const forcedConsistent = await registry.rolloverRecordWorkPublication({
            ...rolloverLocation,
            recordWorkKey: newTask.work.recordWorkKey,
            taskId: "task-rollover-new",
            ownerId: "owner-rollover-new",
            fence: rolled.fence,
            expectedRegistryRevision: newClaim.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 25,
            rolloverMode: "force_refresh",
            withArtifactVerification: async (_claim, apply) => await apply({
                kind: "consistent",
                artifactStateHash: "b".repeat(64),
            }),
        });
        assert.equal(forcedConsistent.kind, "rolled_over", "显式 force refresh 必须在完整旧 winner 上推进发布代际");
        if (forcedConsistent.kind === "rolled_over") {
            assert.equal(forcedConsistent.history.reason, "visible_artifacts_diverged");
            assert.equal(forcedConsistent.history.rolloverTrigger, "force_refresh");
            assert.ok(forcedConsistent.work.recordCommitEpoch > rolled.work.recordCommitEpoch);
            assert.equal(forcedConsistent.work.publicationClaim, undefined);
        }
    } finally {
        fs.rmSync(rolloverRoot, { recursive: true, force: true });
    }
}

async function testManualMutationFence(): Promise<void> {
    const manualRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-work-manual-mutation-"));
    const manualLocation = {
        dataRoot: manualRoot,
        identity: { chain: "codex" as const, workspaceHash: "manual-workspace", conversationId: "manual-conversation" },
    };
    const token = "first-publication-token-manual-mutation";
    try {
        await registry.initializeRecordWorkRegistryIdentity(manualLocation, { firstPublicationToken: token, nowMs: startMs });
        const created = await registry.createRecordWorkRegistry(manualLocation, { firstPublicationToken: token, nowMs: startMs + 1 });
        assert.equal(created.kind, "created");
        if (created.kind !== "created") throw new Error("manual mutation registry 创建失败");
        const started = await registry.startOrAttachRecordWork({
            ...manualLocation,
            desiredRevision: "revision-manual",
            taskId: "task-manual-old",
            expectedRegistryRevision: created.registry.registryRevision,
            nowMs: startMs + 2,
        });
        assert.equal(started.kind, "started");
        if (started.kind !== "started") throw new Error("manual mutation work 创建失败");
        const peer = await registry.startOrAttachRecordWork({
            ...manualLocation,
            desiredRevision: "revision-manual",
            taskId: "task-manual-peer",
            expectedRegistryRevision: started.registry.registryRevision,
            nowMs: startMs + 3,
        });
        assert.equal(peer.kind, "started");
        if (peer.kind !== "started") throw new Error("manual mutation peer work 挂接失败");
        const leased = await registry.acquireRecordWorkLease({
            ...manualLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-manual-old",
            ownerId: "owner-manual-old",
            schedulerEpoch: 1,
            expectedRegistryRevision: peer.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 4,
        });
        assert.equal(leased.kind, "acquired");
        if (leased.kind !== "acquired") throw new Error("manual mutation lease 失败");
        const claimed = await registry.claimRecordWorkPublication({
            ...manualLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-manual-old",
            ownerId: "owner-manual-old",
            fence: leased.fence,
            expectedRegistryRevision: leased.registry.registryRevision,
            commitId: "commit-manual-old",
            inputHash: "input-manual-old",
            bodyHash: "body-manual-old",
            coveredRevision: "revision-manual",
            metadataHash: "metadata-manual-old",
            metadataSnapshot: { title: "manual old" },
            nowMs: startMs + 5,
        });
        assert.equal(claimed.kind, "claimed");
        if (claimed.kind !== "claimed") throw new Error("manual mutation claim 失败");

        const mutation = await registry.withRecordWorkManualMutationAuthority({
            ...manualLocation,
            mutationKind: "manual_edit",
            artifactLockHeld: true,
            mutationId: "record-manage-manual-edit-test",
            nowMs: startMs + 6,
        }, async () => {
            const persisted = JSON.parse(fs.readFileSync(registry.recordWorkRegistryPath(manualLocation), "utf8")) as typeof claimed.registry;
            const active = persisted.works.find(work => work.state === "Active");
            assert.ok(active, "artifact mutation 前必须已持久化 active work fence");
            assert.equal(active.publicationClaim, undefined);
            assert.equal(active.ownerLease, null);
            assert.deepEqual(active.activeTaskIds, []);
            return "manual-edit-applied";
        });
        assert.equal(mutation.kind, "mutated");
        if (mutation.kind !== "mutated" || !mutation.registry) throw new Error("manual mutation 应成功并返回 registry");
        assert.equal(mutation.value, "manual-edit-applied");
        assert.deepEqual(mutation.fencedRecordWorkKeys, [started.work.recordWorkKey]);
        const active = mutation.registry.works.find(work => work.state === "Active");
        assert.ok(active);
        assert.ok(active.recordCommitEpoch > leased.fence.recordCommitEpoch);
        assert.ok(active.currentFencingToken > leased.fence.fencingToken);
        assert.equal(active.publicationHistory?.at(-1)?.reason, "manual_record_mutation");
        assert.equal(active.publicationHistory?.at(-1)?.rolloverTrigger, "manual_edit");
        assert.deepEqual(active.retiredTaskIds, ["task-manual-old", "task-manual-peer"], "手动修改必须持久化旧 Task 墓碑");

        const oldAuthority = await registry.authorizeRecordWorkCommit({
            ...manualLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-manual-old",
            ownerId: "owner-manual-old",
            fence: leased.fence,
            nowMs: startMs + 7,
        });
        assert.equal(oldAuthority.kind, "rejected", "手动修改后旧 Task/lease/fence 必须失权");
        const oldReattach = await registry.startOrAttachRecordWork({
            ...manualLocation,
            desiredRevision: "revision-manual",
            taskId: "task-manual-old",
            expectedRegistryRevision: mutation.registry.registryRevision,
            nowMs: startMs + 8,
        });
        assert.equal(oldReattach.kind, "superseded", "被手动修改围栏的旧 owner Task 不得复活");
        if (oldReattach.kind === "superseded") {
            assert.equal(oldReattach.registry.registryRevision, mutation.registry.registryRevision, "拒绝旧 Task 不得推进 registry revision");
        }
        const peerReattach = await registry.startOrAttachRecordWork({
            ...manualLocation,
            desiredRevision: "revision-manual",
            taskId: "task-manual-peer",
            expectedRegistryRevision: mutation.registry.registryRevision,
            nowMs: startMs + 9,
        });
        assert.equal(peerReattach.kind, "superseded", "被手动修改围栏的 peer Task 不得复活");
        const oldLeaseAgain = await registry.acquireRecordWorkLease({
            ...manualLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: "task-manual-old",
            ownerId: "owner-manual-old",
            schedulerEpoch: 2,
            expectedRegistryRevision: mutation.registry.registryRevision,
            leaseDurationMs: 1_000,
            nowMs: startMs + 10,
        });
        assert.equal(oldLeaseAgain.kind, "task_not_attached", "旧 Task 被拒绝挂接后不得重新取得 lease");
        const reattached = await registry.startOrAttachRecordWork({
            ...manualLocation,
            desiredRevision: "revision-manual",
            taskId: "task-manual-new",
            expectedRegistryRevision: mutation.registry.registryRevision,
            nowMs: startMs + 11,
        });
        assert.equal(reattached.kind, "started", "同 revision 必须能重新挂接到已围栏的 active work");
        if (reattached.kind === "started") {
            assert.equal(reattached.disposition, "attached");
            assert.deepEqual(reattached.work.activeTaskIds, ["task-manual-new"]);
        }

        const legacyLocation = {
            dataRoot: manualRoot,
            identity: { chain: "codex" as const, workspaceHash: "legacy-workspace", conversationId: "legacy-conversation" },
        };
        const legacyMutation = await registry.withRecordWorkManualMutationAuthority({
            ...legacyLocation,
            mutationKind: "manual_delete",
            artifactLockHeld: true,
        }, async () => "legacy-delete-applied");
        assert.equal(legacyMutation.kind, "mutated");
        if (legacyMutation.kind === "mutated") {
            assert.equal(legacyMutation.registry, null, "无 registry 的旧 Record 不应被手动修改路径强行初始化");
            assert.equal(legacyMutation.value, "legacy-delete-applied");
        }
    } finally {
        fs.rmSync(manualRoot, { recursive: true, force: true });
    }
}

try {
    await testAdvanceRecordWorkFence();
    await testPublicationWinnerClaimAndInitialCreationWalRecovery();
    await testPublicationGenerationRollover();
    await testManualMutationFence();
    const beforeInitialization = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeInitialization.kind, "repair_required", "manifest 缺失时严格读取必须 RepairRequired");
    if (beforeInitialization.kind === "repair_required") assert.equal(beforeInitialization.reason, "manifest_missing");

    const createWithoutManifest = await registry.createRecordWorkRegistry(location, { firstPublicationToken, nowMs: startMs });
    assert.equal(createWithoutManifest.kind, "repair_required", "公开 create 不得自行初始化 identity manifest");
    if (createWithoutManifest.kind === "repair_required") assert.equal(createWithoutManifest.reason, "manifest_missing");

    const initialized = await registry.initializeRecordWorkRegistryIdentity(location, { firstPublicationToken, nowMs: startMs });
    assert.equal(initialized.kind, "prepared", "首次发布必须先持久化 identity manifest");
    if (initialized.kind !== "prepared") assert.fail("identity manifest 初始化应成功");
    assert.equal(initialized.manifest.state, "Prepared");

    const wrongTokenCreate = await registry.createRecordWorkRegistry(location, { firstPublicationToken: wrongPublicationToken, nowMs: startMs });
    assert.equal(wrongTokenCreate.kind, "publication_rejected", "create 必须验证 first-publication token");

    const created = await registry.createRecordWorkRegistry(location, { firstPublicationToken, nowMs: startMs });
    assert.equal(created.kind, "created", "带有效 manifest/token 才能首次创建 registry");
    if (created.kind !== "created") assert.fail("create 应成功");
    assert.equal(created.registry.registryRevision, 1);
    assert.equal(created.manifest.state, "Published");
    assert.equal(created.manifest.publishedRegistryHash, created.registry.persistedHash);
    assert.equal(created.manifest.durability.temporaryFileSynced, true);
    assert.equal(created.manifest.durability.targetFileSynced, true);
    assert.equal(created.manifest.durability.targetReadBackVerified, true);
    assert.equal(created.manifest.durability.atomicReplace, true);
    if (process.platform === "win32") {
        assert.equal(created.manifest.durability.mode, "windows_process_crash_atomic_replace");
        assert.equal(created.manifest.durability.parentDirectoryFsync, false);
        assert.equal(created.manifest.durability.suddenPowerLossDurabilityClaimed, false);
    } else {
        assert.equal(created.manifest.durability.mode, "posix_file_and_directory_fsync");
        assert.equal(created.manifest.durability.parentDirectoryFsync, true);
        assert.equal(created.manifest.durability.suddenPowerLossDurabilityClaimed, true);
    }

    const duplicateCreate = await registry.createRecordWorkRegistry(location, { firstPublicationToken });
    assert.equal(duplicateCreate.kind, "already_exists", "重复 create 不能覆盖已发布 registry");

    const acquireCleanupLocation = {
        dataRoot,
        identity: { ...identity, conversationId: "lock-acquire-cleanup" },
        lockOptions: { leaseMs: 2_000, heartbeatMs: 250, waitMs: 2_000 },
    };
    const acquireCleanupInitialized = await registry.initializeRecordWorkRegistryIdentity(acquireCleanupLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(acquireCleanupInitialized.kind, "prepared");
    const acquireCleanupCreated = await registry.createRecordWorkRegistry(acquireCleanupLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(acquireCleanupCreated.kind, "created");
    const acquireCleanupLockPath = registry.recordWorkRegistryPath(acquireCleanupLocation).replace(/\.json$/u, ".lock");
    const lockTestHooks = globalThis as { [key: symbol]: RegistryLockTestHooks | undefined };
    lockTestHooks[registryLockTestHooksKey] = {
        beforeInitialLockStateWrite: ({ lockPath }) => {
            if (lockPath === acquireCleanupLockPath) throw new Error("injected initial lock metadata write failure");
        },
    };
    try {
        await assert.rejects(
            registry.readRecordWorkRegistry(acquireCleanupLocation),
            /injected initial lock metadata write failure/u,
            "首次 lock metadata 写入失败必须返回原始失败",
        );
        assert.equal(fs.existsSync(acquireCleanupLockPath), false, "首次 metadata 写失败后不得遗留空 lock 文件");
    } finally {
        delete lockTestHooks[registryLockTestHooksKey];
    }
    const acquiredImmediatelyAfterCleanup = await within(
        registry.readRecordWorkRegistry(acquireCleanupLocation),
        250,
        "清理空 lock 后下一次获取",
    );
    assert.equal(acquiredImmediatelyAfterCleanup.kind, "ready", "清理空 lock 后下一次读取必须立即重新获取锁");

    const replacementCleanupLocation = {
        dataRoot,
        identity: { ...identity, conversationId: "lock-acquire-cleanup-replacement" },
        lockOptions: { leaseMs: 2_000, heartbeatMs: 250, waitMs: 2_000 },
    };
    const replacementCleanupInitialized = await registry.initializeRecordWorkRegistryIdentity(replacementCleanupLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(replacementCleanupInitialized.kind, "prepared");
    const replacementCleanupCreated = await registry.createRecordWorkRegistry(replacementCleanupLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(replacementCleanupCreated.kind, "created");
    const replacementCleanupLockPath = registry.recordWorkRegistryPath(replacementCleanupLocation).replace(/\.json$/u, ".lock");
    const successorLockToken = "replacement-owner-token";
    lockTestHooks[registryLockTestHooksKey] = {
        beforeInitialLockStateWrite: ({ lockPath }) => {
            if (lockPath === replacementCleanupLockPath) throw new Error("injected replacement cleanup failure");
        },
        beforeFailedAcquireLockCleanup: ({ lockPath }) => {
            if (lockPath !== replacementCleanupLockPath) return;
            fs.rmSync(lockPath, { force: true });
            fs.writeFileSync(lockPath, JSON.stringify({
                token: successorLockToken,
                acquiredAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 10_000).toISOString(),
                heartbeatMs: 250,
            }), "utf8");
        },
    };
    try {
        await assert.rejects(
            registry.readRecordWorkRegistry(replacementCleanupLocation),
            /injected replacement cleanup failure/u,
            "初始失败仍必须保留给调用方",
        );
        const successorLock = JSON.parse(fs.readFileSync(replacementCleanupLockPath, "utf8")) as { token?: string };
        assert.equal(successorLock.token, successorLockToken, "清理失败获取时绝不能删除路径已替换的新 owner lock");
    } finally {
        delete lockTestHooks[registryLockTestHooksKey];
        fs.rmSync(replacementCleanupLockPath, { force: true });
    }

    const cleanupErrorLocation = {
        dataRoot,
        identity: { ...identity, conversationId: "lock-acquire-cleanup-error" },
        lockOptions: { leaseMs: 2_000, heartbeatMs: 250, waitMs: 2_000 },
    };
    const cleanupErrorInitialized = await registry.initializeRecordWorkRegistryIdentity(cleanupErrorLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(cleanupErrorInitialized.kind, "prepared");
    const cleanupErrorCreated = await registry.createRecordWorkRegistry(cleanupErrorLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(cleanupErrorCreated.kind, "created");
    const cleanupErrorLockPath = registry.recordWorkRegistryPath(cleanupErrorLocation).replace(/\.json$/u, ".lock");
    lockTestHooks[registryLockTestHooksKey] = {
        beforeInitialLockStateWrite: ({ lockPath }) => {
            if (lockPath === cleanupErrorLockPath) throw new Error("injected initial failure with cleanup failure");
        },
        beforeFailedAcquireLockDelete: ({ lockPath }) => {
            if (lockPath === cleanupErrorLockPath) throw new Error("injected lock cleanup delete failure");
        },
    };
    try {
        await assert.rejects(
            registry.readRecordWorkRegistry(cleanupErrorLocation),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /injected initial failure with cleanup failure/u);
                assert.ok(error.cause instanceof Error);
                assert.match(error.cause.message, /injected initial failure with cleanup failure/u);
                const cleanupError = (error as Error & { cleanupError?: AggregateError }).cleanupError;
                assert.ok(cleanupError instanceof AggregateError);
                assert.match(cleanupError.message, /清理也失败/u);
                assert.ok(cleanupError.errors.some(cleanupIssue => cleanupIssue instanceof Error && /injected lock cleanup delete failure/u.test(cleanupIssue.message)));
                return true;
            },
            "删除失败不得吞掉原始获取错误或 cleanup I/O 错误",
        );
        assert.equal(fs.existsSync(cleanupErrorLockPath), true, "删除失败时保留 lock 供后续重试或诊断");
    } finally {
        delete lockTestHooks[registryLockTestHooksKey];
        fs.rmSync(cleanupErrorLockPath, { force: true });
    }

    await Promise.all(Array.from({ length: 4 }, (_, index) => attachFromChildProcess(`task-process-${index}`)));
    const concurrentAttachments = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        attachWithRetry(`task-${String(index).padStart(2, "0")}`, "revision-1")));
    const sharedWorkKey = concurrentAttachments[0].work.recordWorkKey;
    assert.ok(concurrentAttachments.every(result => result.work.recordWorkKey === sharedWorkKey), "相同 revision 必须合并为同一 work");
    const afterConcurrentAttach = await readReady();
    assert.equal(afterConcurrentAttach.registry.works.length, 1, "并发 attach 不得生成重复 work");
    assert.deepEqual(afterConcurrentAttach.registry.works[0].activeTaskIds, [
        ...Array.from({ length: 24 }, (_, index) => `task-${String(index).padStart(2, "0")}`),
        ...Array.from({ length: 4 }, (_, index) => `task-process-${index}`),
    ].sort(), "所有进程与进程内并发 Task 都必须持久挂接");
    assert.equal(afterConcurrentAttach.manifest.publishedRegistryRevision, afterConcurrentAttach.registry.registryRevision);
    assert.equal(afterConcurrentAttach.manifest.publishedRegistryHash, afterConcurrentAttach.registry.persistedHash);

    const detached = await registry.detachRecordWorkTask({
        ...location,
        recordWorkKey: sharedWorkKey,
        taskId: "task-00",
        expectedRegistryRevision: afterConcurrentAttach.registry.registryRevision,
        nowMs: startMs + 100,
    });
    assert.equal(detached.kind, "detached", "取消单个 Task 只应解除自身挂接");
    if (detached.kind !== "detached") assert.fail("detach 应成功");
    assert.equal(detached.remainingActiveTaskIds.includes("task-00"), false);
    assert.equal(detached.remainingActiveTaskIds.length, 27, "共享 work 必须保留其余 Task");

    const firstLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: sharedWorkKey,
        taskId: "task-01",
        ownerId: "owner-a",
        schedulerEpoch: 7,
        expectedRegistryRevision: detached.registry.registryRevision,
        leaseDurationMs: 500,
        nowMs: startMs + 200,
    });
    assert.equal(firstLease.kind, "acquired", "已挂接 Task 应能取得 work lease");
    if (firstLease.kind !== "acquired") assert.fail("首次 lease 应成功");
    assert.equal(firstLease.fence.fencingToken, 1);

    const crossEpochRenew = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: sharedWorkKey,
        taskId: "task-01",
        ownerId: "owner-a",
        schedulerEpoch: 8,
        workLeaseId: firstLease.lease.workLeaseId,
        expectedRegistryRevision: firstLease.registry.registryRevision,
        leaseDurationMs: 500,
        nowMs: startMs + 250,
    });
    assert.equal(crossEpochRenew.kind, "lease_held", "旧 scheduler 不得跨 epoch 续租同一 leaseId");
    if (crossEpochRenew.kind !== "lease_held") assert.fail("跨 epoch 续租必须拒绝");
    assert.equal(crossEpochRenew.registry.registryRevision, firstLease.registry.registryRevision, "拒绝续租不得推进 CAS revision");

    const renewedLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: sharedWorkKey,
        taskId: "task-01",
        ownerId: "owner-a",
        schedulerEpoch: 7,
        workLeaseId: firstLease.lease.workLeaseId,
        expectedRegistryRevision: firstLease.registry.registryRevision,
        leaseDurationMs: 500,
        nowMs: startMs + 260,
    });
    assert.equal(renewedLease.kind, "acquired", "同 owner/lease/schedulerEpoch 才能续租");
    if (renewedLease.kind !== "acquired") assert.fail("合法续租应成功");
    assert.equal(renewedLease.disposition, "renewed");
    assert.deepEqual(renewedLease.fence, firstLease.fence, "续租不生成新 fence");

    const pressureTaskIds: string[] = [];
    let previousPressureRevision = renewedLease.registry.registryRevision;
    for (let round = 0; round < 50; round += 1) {
        const roundTaskIds = Array.from({ length: 4 }, (_, worker) => `pressure-${String(round).padStart(2, "0")}-${worker}`);
        pressureTaskIds.push(...roundTaskIds);
        const operations = [
            ...roundTaskIds.map(taskId => ({ label: `attach:${taskId}`, promise: attachWithRetry(taskId, "revision-1") })),
            ...Array.from({ length: 3 }, (_, worker) => ({ label: `read:${worker}`, promise: readReady() })),
            ...Array.from({ length: 2 }, (_, worker) => ({ label: `lease:${worker}`, promise: renewLeaseWithRetry(sharedWorkKey, renewedLease.fence) })),
            ...Array.from({ length: 3 }, (_, worker) => ({ label: `commit:${worker}`, promise: stageAndPublish(sharedWorkKey, renewedLease.fence, round, worker) })),
        ];
        const settled = await Promise.allSettled(operations.map(operation => operation.promise));
        const rejected = settled.flatMap((result, index) => result.status === "rejected"
            ? [`${operations[index].label}: ${result.reason instanceof Error ? result.reason.stack ?? result.reason.message : String(result.reason)}`]
            : []);
        assert.equal(rejected.length, 0, `第 ${round} 轮 12 并发 attach/read/lease/commit 不得出现未处理错误: ${rejected.join(" | ")}`);
        const afterRound = await readReady();
        assert.ok(afterRound.registry.registryRevision > previousPressureRevision, "每轮有新增 attach 时 registryRevision 必须严格递增");
        assert.equal(afterRound.manifest.publishedRegistryRevision, afterRound.registry.registryRevision, "并发写后 manifest revision 必须跟随 registry");
        previousPressureRevision = afterRound.registry.registryRevision;
    }
    const afterPressure = await readReady();
    assert.ok(pressureTaskIds.every(taskId => afterPressure.registry.works.find(work => work.recordWorkKey === sharedWorkKey)?.activeTaskIds.includes(taskId)), "50 轮并发 attach 不能丢失任何 Task 更新");

    const barrierLocation = {
        dataRoot,
        identity: { ...identity, conversationId: "lock-barrier-race" },
        lockOptions: { leaseMs: 120, heartbeatMs: 30, waitMs: 2_000 },
    };
    const barrierInitialized = await registry.initializeRecordWorkRegistryIdentity(barrierLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(barrierInitialized.kind, "prepared");
    const barrierCreated = await registry.createRecordWorkRegistry(barrierLocation, { firstPublicationToken, nowMs: startMs });
    assert.equal(barrierCreated.kind, "created");
    const barrierLockPath = registry.recordWorkRegistryPath(barrierLocation).replace(/\.json$/u, ".lock");
    const oldOwnerToken = "live-owner-token";
    const writeBarrierLock = (expiresAt: number, releasedAt?: string) => fs.writeFileSync(barrierLockPath, JSON.stringify({
        token: oldOwnerToken,
        acquiredAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        heartbeatMs: 30,
        ...(releasedAt === undefined ? {} : { releasedAt }),
    }), "utf8");
    writeBarrierLock(Date.now() - 1_000);
    const reclaimValidated = deferred();
    const continueReclaim = deferred();
    lockTestHooks[registryLockTestHooksKey] = {
        afterReclaimValidated: async ({ lockPath }) => {
            assert.equal(lockPath, barrierLockPath, "barrier 反例必须命中目标 lock");
            reclaimValidated.resolve();
            await continueReclaim.promise;
        },
    };
    try {
        const recoveringRead = registry.readRecordWorkRegistry(barrierLocation);
        await within(reclaimValidated.promise, 1_000, "stale breaker 完成 token 校验");
        const competingRead = registry.readRecordWorkRegistry(barrierLocation);
        writeBarrierLock(Date.now() + 10_000);
        continueReclaim.resolve();
        await waitForCondition(() => {
            try {
                const state = JSON.parse(fs.readFileSync(barrierLockPath, "utf8")) as { token?: string; expiresAt?: string; releasedAt?: string };
                return state.token === oldOwnerToken && state.releasedAt === undefined && Date.parse(state.expiresAt ?? "") > Date.now();
            } catch {
                return false;
            }
        }, 1_000, "live owner token 经 barrier 回写");
        writeBarrierLock(Date.now() + 10_000, new Date().toISOString());
        const [recovered, contender] = await Promise.all([
            within(recoveringRead, 2_000, "恢复后的旧 owner 释放再获取"),
            within(competingRead, 2_000, "barrier 期间的竞争 reader"),
        ]);
        assert.equal(recovered.kind, "ready", "正常 release/reacquire 后成功读取不得误报 ownership error");
        assert.equal(contender.kind, "ready", "barrier 不得让竞争 reader 穿透为双 owner");
    } finally {
        delete lockTestHooks[registryLockTestHooksKey];
    }

    const barrierReclaimPath = `${barrierLockPath}.reclaim`;
    const retiredBarrierToken = "retired-barrier-token";
    const successorBarrierToken = "successor-barrier-token";
    fs.writeFileSync(barrierReclaimPath, JSON.stringify({
        token: retiredBarrierToken,
        acquiredAt: new Date(Date.now() - 2_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        releasedAt: new Date(Date.now() - 1_000).toISOString(),
    }), "utf8");
    const retireValidated = deferred();
    const continueBarrierRetire = deferred();
    lockTestHooks[registryLockTestHooksKey] = {
        afterReclaimBarrierRetireValidated: async ({ reclaimPath, observedToken }) => {
            assert.equal(reclaimPath, barrierReclaimPath, "barrier retirement 反例必须命中目标 reclaim path");
            assert.equal(observedToken, retiredBarrierToken, "清理者必须先观察到旧 barrier token");
            retireValidated.resolve();
            await continueBarrierRetire.promise;
        },
    };
    try {
        let barrierRaceReadSettled = false;
        const barrierRaceRead = registry.readRecordWorkRegistry(barrierLocation);
        void barrierRaceRead.then(
            () => { barrierRaceReadSettled = true; },
            () => { barrierRaceReadSettled = true; },
        );
        await within(retireValidated.promise, 1_000, "旧 barrier 完成 retirement 校验");
        fs.rmSync(barrierReclaimPath, { force: true });
        fs.writeFileSync(barrierReclaimPath, JSON.stringify({
            token: successorBarrierToken,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
        }), "utf8");
        continueBarrierRetire.resolve();
        await waitForCondition(() => {
            try {
                const state = JSON.parse(fs.readFileSync(barrierReclaimPath, "utf8")) as { token?: string };
                return state.token === successorBarrierToken;
            } catch {
                return false;
            }
        }, 1_000, "身份变化后的新 barrier 恢复");
        await sleep(20);
        assert.equal(barrierRaceReadSettled, false, "新 barrier 存活时竞争 reader 不得穿透获取 registry lock");
        fs.rmSync(barrierReclaimPath, { force: true });
        const barrierRaceResult = await within(barrierRaceRead, 2_000, "新 barrier 正常释放后的 reader");
        assert.equal(barrierRaceResult.kind, "ready", "新 barrier 释放后 reader 应正常完成且不误报 ownership error");
    } finally {
        continueBarrierRetire.resolve();
        delete lockTestHooks[registryLockTestHooksKey];
        fs.rmSync(barrierReclaimPath, { force: true });
    }

    const newRevision = await registry.startOrAttachRecordWork({
        ...location,
        taskId: "task-new",
        desiredRevision: "revision-2",
        expectedRegistryRevision: afterPressure.registry.registryRevision,
        nowMs: startMs + 300,
    });
    assert.equal(newRevision.kind, "started", "新 revision 应创建新 work");
    if (newRevision.kind !== "started") assert.fail("新 revision 应成功");
    assert.equal(newRevision.work.recordCommitEpoch, 2);
    assert.equal(newRevision.registry.works.find(work => work.recordWorkKey === sharedWorkKey)?.state, "Superseded");

    const oldEpochAuthorization = await registry.authorizeRecordWorkCommit({
        ...location,
        recordWorkKey: sharedWorkKey,
        taskId: "task-01",
        ownerId: "owner-a",
        fence: firstLease.fence,
        nowMs: startMs + 350,
    });
    assert.equal(oldEpochAuthorization.kind, "rejected");
    if (oldEpochAuthorization.kind === "rejected") assert.equal(oldEpochAuthorization.reason, "work_superseded");

    const secondLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: newRevision.work.recordWorkKey,
        taskId: "task-new",
        ownerId: "owner-b",
        schedulerEpoch: 8,
        expectedRegistryRevision: newRevision.registry.registryRevision,
        leaseDurationMs: 50,
        nowMs: startMs + 400,
    });
    assert.equal(secondLease.kind, "acquired");
    if (secondLease.kind !== "acquired") assert.fail("第二 lease 应成功");
    assert.equal(secondLease.fence.fencingToken, 2);

    const replacementLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: newRevision.work.recordWorkKey,
        taskId: "task-new",
        ownerId: "owner-c",
        schedulerEpoch: 9,
        expectedRegistryRevision: secondLease.registry.registryRevision,
        leaseDurationMs: 500,
        nowMs: startMs + 500,
    });
    assert.equal(replacementLease.kind, "acquired");
    if (replacementLease.kind !== "acquired") assert.fail("替换 lease 应成功");
    assert.equal(replacementLease.fence.fencingToken, 3);

    const oldLeaseAuthorization = await registry.authorizeRecordWorkCommit({
        ...location,
        recordWorkKey: newRevision.work.recordWorkKey,
        taskId: "task-new",
        ownerId: "owner-b",
        fence: secondLease.fence,
        nowMs: startMs + 510,
    });
    assert.equal(oldLeaseAuthorization.kind, "rejected");
    if (oldLeaseAuthorization.kind === "rejected") assert.equal(oldLeaseAuthorization.reason, "lease_mismatch");

    const staged = await registry.withAuthorizedRecordWorkCommit({
        ...location,
        recordWorkKey: newRevision.work.recordWorkKey,
        taskId: "task-new",
        ownerId: "owner-c",
        fence: replacementLease.fence,
        expectedRegistryRevision: replacementLease.registry.registryRevision,
        nowMs: startMs + 520,
    }, authorization => `staging:${authorization.recordWorkKey}:${authorization.fence.fencingToken}`);
    assert.equal(staged.kind, "staged", "长 callback API 只能产出 staging/token，不能直接冒充 committed");
    if (staged.kind !== "staged") assert.fail("合法 staging 应成功");

    const published = await registry.publishRecordWorkCommit(location, staged.commitToken, authorization => `published:${authorization.recordWorkKey}`, { nowMs: startMs + 530 });
    assert.equal(published.kind, "committed", "最终 publish 必须在新短锁内完成写前/写后授权");

    const stageEntered = deferred();
    const releaseStage = deferred();
    const longStagePromise = registry.withAuthorizedRecordWorkCommit({
        ...location,
        recordWorkKey: newRevision.work.recordWorkKey,
        taskId: "task-new",
        ownerId: "owner-c",
        fence: replacementLease.fence,
        nowMs: startMs + 540,
    }, async () => {
        stageEntered.resolve();
        await releaseStage.promise;
        return "late-staging-output";
    });
    await stageEntered.promise;
    const beforeThirdRevision = await readReady();
    const thirdRevisionPromise = registry.startOrAttachRecordWork({
        ...location,
        taskId: "task-third",
        desiredRevision: "revision-3",
        expectedRegistryRevision: beforeThirdRevision.registry.registryRevision,
        nowMs: startMs + 550,
    });
    const thirdRevision = await within(thirdRevisionPromise, 1_000, "长 staging callback 期间的新 revision 接管");
    assert.equal(thirdRevision.kind, "started", "staging callback 不得长期占用 registry lock");
    if (thirdRevision.kind !== "started") assert.fail("第三 revision 应成功接管");
    releaseStage.resolve();
    const longStageResult = await longStagePromise;
    assert.equal(longStageResult.kind, "rejected", "callback 结束后必须在新锁中复核 supersede");
    if (longStageResult.kind === "rejected") assert.equal(longStageResult.reason, "work_superseded");

    let stalePublishCalled = false;
    const stalePublish = await registry.publishRecordWorkCommit(location, staged.commitToken, () => {
        stalePublishCalled = true;
        return "must-not-publish";
    }, { nowMs: startMs + 560 });
    assert.equal(stalePublish.kind, "rejected", "旧 commit token 在 supersede 后必须拒绝");
    assert.equal(stalePublishCalled, false, "写前授权失败时不得调用最终 publish callback");

    const thirdLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: thirdRevision.work.recordWorkKey,
        taskId: "task-third",
        ownerId: "owner-d",
        schedulerEpoch: 10,
        expectedRegistryRevision: thirdRevision.registry.registryRevision,
        leaseDurationMs: 500,
        nowMs: startMs + 570,
    });
    assert.equal(thirdLease.kind, "acquired");
    if (thirdLease.kind !== "acquired") assert.fail("第三 revision lease 应成功");
    const thirdStage = await registry.withAuthorizedRecordWorkCommit({
        ...location,
        recordWorkKey: thirdRevision.work.recordWorkKey,
        taskId: "task-third",
        ownerId: "owner-d",
        fence: thirdLease.fence,
        expectedRegistryRevision: thirdLease.registry.registryRevision,
        nowMs: startMs + 580,
    }, () => "third-staging");
    assert.equal(thirdStage.kind, "staged");
    if (thirdStage.kind !== "staged") assert.fail("第三 revision staging 应成功");
    const registryLockPath = registry.recordWorkRegistryPath(location).replace(/\.json$/u, ".lock");
    let ownershipLossPublishRan = false;
    await assert.rejects(
        registry.publishRecordWorkCommit(location, thirdStage.commitToken, () => {
            ownershipLossPublishRan = true;
            fs.writeFileSync(registryLockPath, JSON.stringify({
                token: "replacement-owner-token",
                acquiredAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 10_000).toISOString(),
                heartbeatMs: 250,
            }), "utf8");
            return "must-not-report-committed";
        }, { nowMs: startMs + 590 }),
        (error: unknown) => error instanceof registry.RecordWorkRegistryLockOwnershipError,
        "最终 publish 后若锁所有权改变，必须抛出 ownership error，不能返回 committed",
    );
    assert.equal(ownershipLossPublishRan, true, "测试应穿过实际 publish callback 再触发写后 ownership assert");
    fs.rmSync(registryLockPath, { force: true });

    const recoveryLocation = {
        dataRoot,
        identity: {
            chain: "codex" as const,
            workspaceHash: "workspace-hash-owner-recovery",
            conversationId: "conversation-owner-recovery",
        },
        lockOptions: location.lockOptions,
    };
    const recoveryPublicationToken = "first-publication-token-owner-recovery";
    const preparedRecovery = await registry.initializeRecordWorkRegistryIdentity(recoveryLocation, {
        firstPublicationToken: recoveryPublicationToken,
        nowMs: startMs + 700,
    });
    assert.equal(preparedRecovery.kind, "prepared");
    const createdRecovery = await registry.createRecordWorkRegistry(recoveryLocation, {
        firstPublicationToken: recoveryPublicationToken,
        nowMs: startMs + 701,
    });
    assert.equal(createdRecovery.kind, "created");
    if (createdRecovery.kind !== "created") assert.fail("owner recovery registry 应成功创建");
    const startedRecovery = await registry.startOrAttachRecordWork({
        ...recoveryLocation,
        desiredRevision: "revision-owner-recovery",
        taskId: "task-owner-recovery",
        expectedRegistryRevision: createdRecovery.registry.registryRevision,
        nowMs: startMs + 702,
    });
    assert.equal(startedRecovery.kind, "started");
    if (startedRecovery.kind !== "started") assert.fail("owner recovery work 应成功创建");
    const originalRecoveryLease = await registry.acquireRecordWorkLease({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-a",
        schedulerEpoch: 1,
        expectedRegistryRevision: startedRecovery.registry.registryRevision,
        leaseDurationMs: 60_000,
        nowMs: startMs + 703,
    });
    assert.equal(originalRecoveryLease.kind, "acquired");
    if (originalRecoveryLease.kind !== "acquired") assert.fail("owner recovery 初始 lease 应成功");
    const claimedRecoveryPublication = await registry.claimRecordWorkPublication({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-a",
        fence: originalRecoveryLease.fence,
        expectedRegistryRevision: originalRecoveryLease.registry.registryRevision,
        nowMs: startMs + 704,
        commitId: "commit-owner-recovery",
        inputHash: "input-owner-recovery",
        bodyHash: "body-owner-recovery",
        coveredRevision: "revision-owner-recovery",
        metadataHash: "metadata-owner-recovery",
        metadataSnapshot: { schemaVersion: 1, marker: "owner-recovery" },
    });
    assert.equal(claimedRecoveryPublication.kind, "claimed");
    if (claimedRecoveryPublication.kind !== "claimed") assert.fail("owner recovery publication claim 应成功");
    const recoveredLease = await registry.recoverRecordWorkLease({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-b",
        schedulerEpoch: 2,
        expectedFence: originalRecoveryLease.fence,
        expectedRegistryRevision: claimedRecoveryPublication.registry.registryRevision,
        leaseDurationMs: 60_000,
        nowMs: startMs + 705,
    });
    assert.equal(recoveredLease.kind, "recovered");
    if (recoveredLease.kind !== "recovered") assert.fail("owner recovery handoff 应成功");
    assert.equal(recoveredLease.disposition, "transferred");
    assert.equal(recoveredLease.fence.workLeaseId, originalRecoveryLease.fence.workLeaseId, "handoff 必须保留 logical workLeaseId");
    assert.equal(recoveredLease.fence.fencingToken, originalRecoveryLease.fence.fencingToken, "handoff 必须保留 logical fencingToken");
    assert.equal(recoveredLease.fence.recordCommitEpoch, originalRecoveryLease.fence.recordCommitEpoch, "handoff 必须保留 recordCommitEpoch");
    assert.equal(recoveredLease.fence.schedulerEpoch, 2, "handoff 只推进 schedulerEpoch");
    assert.equal(recoveredLease.work.publicationClaim?.ownerId, "owner-recovery-b", "publication claim holder 必须随 owner handoff 迁移");
    assert.equal(recoveredLease.work.publicationClaim?.schedulerEpoch, 2, "publication claim schedulerEpoch 必须随 handoff 迁移");
    const oldOwnerAuthorization = await registry.authorizeRecordWorkCommit({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-a",
        fence: originalRecoveryLease.fence,
        nowMs: startMs + 706,
    });
    assert.equal(oldOwnerAuthorization.kind, "rejected", "handoff 后旧 owner 必须立即失权");
    const newOwnerAuthorization = await registry.authorizeRecordWorkCommit({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-b",
        fence: recoveredLease.fence,
        nowMs: startMs + 706,
    });
    assert.equal(newOwnerAuthorization.kind, "authorized", "handoff 后新 owner 必须可继续同一 commit lineage");
    const repeatedRecovery = await registry.recoverRecordWorkLease({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-c",
        schedulerEpoch: 3,
        expectedFence: originalRecoveryLease.fence,
        expectedRegistryRevision: recoveredLease.registry.registryRevision,
        leaseDurationMs: 60_000,
        nowMs: startMs + 707,
    });
    assert.equal(repeatedRecovery.kind, "recovered", "registry 已迁移但 scheduler 尚未同步时，后续 owner 应可沿同一 logical fence 再接管");
    if (repeatedRecovery.kind !== "recovered") assert.fail("重复 owner recovery handoff 应成功");
    assert.equal(repeatedRecovery.fence.workLeaseId, originalRecoveryLease.fence.workLeaseId);
    assert.equal(repeatedRecovery.fence.fencingToken, originalRecoveryLease.fence.fencingToken);
    const mismatchedRecovery = await registry.recoverRecordWorkLease({
        ...recoveryLocation,
        recordWorkKey: startedRecovery.work.recordWorkKey,
        taskId: "task-owner-recovery",
        ownerId: "owner-recovery-d",
        schedulerEpoch: 4,
        expectedFence: { ...originalRecoveryLease.fence, fencingToken: originalRecoveryLease.fence.fencingToken + 1 },
        expectedRegistryRevision: repeatedRecovery.registry.registryRevision,
        leaseDurationMs: 60_000,
        nowMs: startMs + 708,
    });
    assert.equal(mismatchedRecovery.kind, "rejected", "handoff 不得跨越不匹配的 logical fence");
    if (mismatchedRecovery.kind === "rejected") assert.equal(mismatchedRecovery.reason, "fencing_token_mismatch");

    const registryPath = registry.recordWorkRegistryPath(location);
    const manifestPath = registry.recordWorkIdentityManifestPath(location);
    const registryBackup = fs.readFileSync(registryPath);
    const manifestBackup = fs.readFileSync(manifestPath);

    fs.writeFileSync(registryPath, "{not-json", "utf8");
    const corruptRegistry = await registry.readRecordWorkRegistry(location);
    assert.equal(corruptRegistry.kind, "repair_required");
    if (corruptRegistry.kind === "repair_required") assert.equal(corruptRegistry.reason, "registry_invalid_json");
    fs.writeFileSync(registryPath, registryBackup);

    fs.writeFileSync(manifestPath, "{not-json", "utf8");
    const corruptManifest = await registry.readRecordWorkRegistry(location);
    assert.equal(corruptManifest.kind, "repair_required");
    if (corruptManifest.kind === "repair_required") assert.equal(corruptManifest.reason, "manifest_invalid_json");
    fs.writeFileSync(manifestPath, manifestBackup);

    fs.rmSync(manifestPath, { force: true });
    const missingManifest = await registry.readRecordWorkRegistry(location);
    assert.equal(missingManifest.kind, "repair_required");
    if (missingManifest.kind === "repair_required") assert.equal(missingManifest.reason, "manifest_missing");
    fs.writeFileSync(manifestPath, manifestBackup);

    fs.rmSync(registryPath, { force: true });
    const missingPublishedRegistry = await registry.readRecordWorkRegistry(location);
    assert.equal(missingPublishedRegistry.kind, "repair_required");
    if (missingPublishedRegistry.kind === "repair_required") assert.equal(missingPublishedRegistry.reason, "registry_missing");

    const forbiddenRecreate = await registry.createRecordWorkRegistry(location, { firstPublicationToken, nowMs: startMs + 600 });
    assert.equal(forbiddenRecreate.kind, "repair_required", "已发布 registry 删除后公开 create 不得重置 epoch/fence");
    if (forbiddenRecreate.kind === "repair_required") assert.equal(forbiddenRecreate.reason, "registry_missing");
    assert.equal(fs.existsSync(registryPath), false, "拒绝重建后 registry 仍应保持缺失，等待 repair");

    const reinitialize = await registry.initializeRecordWorkRegistryIdentity(location, { firstPublicationToken, nowMs: startMs + 610 });
    assert.equal(reinitialize.kind, "already_published", "初始化 API 也不得把 Published manifest 降回 Prepared");

    console.log("✅ record-work-registry 全部通过：manifest 首次发布、耐久回执、heartbeat/CAS 多进程、严格续租、UnknownOutcome fence 原子轮换、阶段式提交、supersede 栅栏、删除后拒绝重建");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
