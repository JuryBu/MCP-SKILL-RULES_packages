import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { RecordSchedulerCoordinatorSnapshot } from "../src/record-scheduler-coordinator.ts";

const store = await import("../src/record-scheduler-coordinator-store.ts");
const baseNow = 1_760_000_000_000;

function makeSnapshot(dispatchSeq = 0, activeClaims: readonly Record<string, unknown>[] = []): RecordSchedulerCoordinatorSnapshot {
    return {
        version: 4,
        fairness: {
            dispatchSeq,
            records: [{ taskId: "task-1", recordId: "record-1", dispatchSeq }],
        },
        ledgerBindings: [{ taskId: "task-1", recordId: "record-1", revision: 1, persistedHash: "a".repeat(64) }],
        activeClaims,
        repairRequired: false,
        recoveryIssues: [],
        logicalUnitCount: 1,
        activeClaimCount: activeClaims.length,
        materializedPromptCount: 1,
        waitingReasons: [],
    } as unknown as RecordSchedulerCoordinatorSnapshot;
}

function createRoot(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `memory-store-coordinator-${label}-`));
}

function options(dataRoot: string) {
    return { dataRoot };
}

function timedOptions(dataRoot: string, nowMs: number) {
    return { dataRoot, testClock: store.createRecordSchedulerCoordinatorTestClockForTest(() => nowMs) };
}

function startEval(script: string, environment: NodeJS.ProcessEnv) {
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, "--eval", `(async () => {${script}})();`], {
        cwd: process.cwd(),
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const result = (async () => {
        const [code] = await once(child, "close") as [number | null];
        return { code, stdout, stderr };
    })();
    return { child, result };
}

async function runEval(script: string, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return startEval(script, environment).result;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) return;
        await sleep(10);
    }
    throw new Error(`timed out waiting for ${filePath}`);
}

async function assertDisappearingObservedLockRetries(
    label: string,
    rawLock: string,
    reader: "structured" | "opaque",
    phase: "after-lock-lstat-before-open" | "after-lock-read-before-lstat",
): Promise<void> {
    const dataRoot = createRoot(label);
    const paths = store.resolveRecordSchedulerCoordinatorStorePaths(options(dataRoot));
    let hookTriggered = false;
    try {
        await fs.promises.writeFile(paths.lockPath, rawLock, "utf8");
        store.setRecordSchedulerCoordinatorLockTestHookForTest(async context => {
            if (hookTriggered || context.phase !== phase || context.reader !== reader || context.lockPath !== paths.lockPath) return;
            hookTriggered = true;
            await fs.promises.unlink(paths.lockPath);
        });
        let acquired = false;
        await store.withRecordSchedulerCoordinatorFileLock(async () => {
            acquired = true;
        }, { dataRoot, lock: { timeoutMs: 1_000, staleMs: 10, retryMs: 1 } });
        assert.equal(hookTriggered, true, `${reader} lock reader 必须命中 ${phase} 竞态屏障`);
        assert.equal(acquired, true, `${reader} lock 在观察后正常消失时必须重试获取，而不是泄漏 ENOENT`);
    } finally {
        store.setRecordSchedulerCoordinatorLockTestHookForTest(undefined);
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
}

async function createAndOwn(dataRoot: string, ownerId = "owner-a") {
    const created = await store.createRecordSchedulerCoordinatorStore({ ...timedOptions(dataRoot, baseNow), snapshot: makeSnapshot() });
    const owner = await store.acquireRecordSchedulerCoordinatorOwner({
        ...timedOptions(dataRoot, baseNow + 1), ownerId, ownerLeaseId: `${ownerId}-lease`, leaseDurationMs: 1_000,
        expectedRevision: created.envelope.revision,
    });
    if (owner.lease === null) throw new Error("expected owner lease");
    return { created, owner };
}

try {
    const initialRoot = createRoot("initial");
    const missing = await store.readRecordSchedulerCoordinatorStore(options(initialRoot));
    assert.equal(missing.kind, "missing");
    const initialized = await store.initializeRecordSchedulerCoordinatorStore({ ...timedOptions(initialRoot, baseNow), snapshot: makeSnapshot(7) });
    const idempotent = await store.initializeRecordSchedulerCoordinatorStore({ ...timedOptions(initialRoot, baseNow + 1), snapshot: makeSnapshot(999) });
    assert.equal(initialized.envelope.revision, 1);
    assert.equal(idempotent.snapshot.fairness.dispatchSeq, 7);
    await fs.promises.rm(initialRoot, { recursive: true, force: true });

    const repairRoot = createRoot("repair");
    const { owner: repairOwner } = await createAndOwn(repairRoot, "repair-owner");
    if (repairOwner.lease === null) throw new Error("expected repair owner lease");
    await store.mutateRecordSchedulerCoordinatorSnapshot({
        ...timedOptions(repairRoot, baseNow + 2), ownerEpoch: repairOwner.lease.epoch, ownerLeaseId: repairOwner.lease.leaseId,
        expectedRevision: repairOwner.envelope.revision,
        mutate(snapshot) { snapshot.repairRequired = true; },
    });
    const repairRead = await store.readRecordSchedulerCoordinatorStore(options(repairRoot));
    assert.equal(repairRead.kind, "repair_required", "repair evidence 必须先持久化，再由读取方进入修复分型");
    await fs.promises.rm(repairRoot, { recursive: true, force: true });

    const casRoot = createRoot("cas");
    const { owner: casOwner } = await createAndOwn(casRoot);
    if (casOwner.lease === null) throw new Error("expected lease");
    const casRevision = casOwner.envelope.revision;
    const casResults = await Promise.allSettled([
        store.mutateRecordSchedulerCoordinatorSnapshot({
            ...timedOptions(casRoot, baseNow + 2), ownerEpoch: casOwner.lease.epoch, ownerLeaseId: casOwner.lease.leaseId,
            expectedRevision: casRevision,
            mutate(snapshot) { (snapshot.fairness as { dispatchSeq: number }).dispatchSeq = 11; return "left"; },
        }),
        store.mutateRecordSchedulerCoordinatorSnapshot({
            ...timedOptions(casRoot, baseNow + 2), ownerEpoch: casOwner.lease.epoch, ownerLeaseId: casOwner.lease.leaseId,
            expectedRevision: casRevision,
            mutate(snapshot) { (snapshot.fairness as { dispatchSeq: number }).dispatchSeq = 12; return "right"; },
        }),
    ]);
    assert.equal(casResults.filter(result => result.status === "fulfilled").length, 1, "并发同 revision CAS 只能成功一个");
    assert.equal(casResults.filter(result => result.status === "rejected").length, 1);
    const casRead = await store.readRecordSchedulerCoordinatorStore(options(casRoot));
    assert.equal(casRead.kind, "current");
    if (casRead.kind === "current") assert.ok([11, 12].includes((casRead.snapshot.fairness as { dispatchSeq: number }).dispatchSeq));
    await fs.promises.rm(casRoot, { recursive: true, force: true });

    const fenceRoot = createRoot("fence");
    const { owner: firstOwner } = await createAndOwn(fenceRoot, "owner-old");
    if (firstOwner.lease === null) throw new Error("expected first owner lease");
    const recovered = await store.recoverRecordSchedulerCoordinatorOwner({
        ...timedOptions(fenceRoot, baseNow + 1_001), ownerId: "owner-new", ownerLeaseId: "owner-new-lease", leaseDurationMs: 1_000,
        expectedRevision: firstOwner.envelope.revision,
    });
    assert.ok(recovered.lease);
    assert.equal(recovered.lease!.epoch, firstOwner.lease.epoch + 1, "过期 owner 必须提升 epoch");
    await assert.rejects(
        () => store.mutateRecordSchedulerCoordinatorSnapshot({
            ...timedOptions(fenceRoot, baseNow + 1_002), ownerEpoch: firstOwner.lease!.epoch, ownerLeaseId: firstOwner.lease!.leaseId,
            expectedRevision: recovered.envelope.revision,
            mutate() { return undefined; },
        }),
        /fenc|epoch|lease/u,
    );
    await fs.promises.rm(fenceRoot, { recursive: true, force: true });

    const clockRoot = createRoot("clock");
    const { owner: clockOwner } = await createAndOwn(clockRoot, "clock-owner");
    if (clockOwner.lease === null) throw new Error("expected clock owner lease");
    await assert.rejects(
        () => store.mutateRecordSchedulerCoordinatorSnapshot({
            ...timedOptions(clockRoot, baseNow), ownerEpoch: clockOwner.lease!.epoch, ownerLeaseId: clockOwner.lease!.leaseId,
            expectedRevision: clockOwner.envelope.revision, mutate() { return undefined; },
        }),
        (error: unknown) => (error as { code?: string }).code === "CLOCK_ROLLBACK",
        "显式 test clock 也不得回拨到 envelope 单调下界之前",
    );
    const legacyNowInput = {
        ...options(clockRoot), nowMs: baseNow + 2, ownerEpoch: clockOwner.lease.epoch, ownerLeaseId: clockOwner.lease.leaseId,
        expectedRevision: clockOwner.envelope.revision, mutate() { return undefined; },
    } as unknown as Parameters<typeof store.mutateRecordSchedulerCoordinatorSnapshot>[0];
    await assert.rejects(
        () => store.mutateRecordSchedulerCoordinatorSnapshot(legacyNowInput),
        (error: unknown) => (error as { code?: string }).code === "LEGACY_NOW_MS_FORBIDDEN",
        "普通调用不得继续依赖公开 nowMs",
    );
    await fs.promises.rm(clockRoot, { recursive: true, force: true });

    const crashRoot = createRoot("crash");
    const crashCreated = await store.createRecordSchedulerCoordinatorStore({ ...timedOptions(crashRoot, baseNow), snapshot: makeSnapshot(21) });
    const crashPaths = store.resolveRecordSchedulerCoordinatorStorePaths(options(crashRoot));
    const currentRaw = await fs.promises.readFile(crashPaths.snapshotPath, "utf8");
    await fs.promises.writeFile(`${crashPaths.snapshotPath}.tmp.dead-process`, JSON.stringify({ revision: 999, snapshot: makeSnapshot(999) }), "utf8");
    const afterTemp = await store.readRecordSchedulerCoordinatorStore(options(crashRoot));
    assert.equal(afterTemp.kind, "current", "遗留 temp 文件不能冒充 current snapshot");
    if (afterTemp.kind === "current") assert.equal(afterTemp.envelope.revision, crashCreated.envelope.revision);
    await fs.promises.writeFile(crashPaths.snapshotPath, "{broken-json", "utf8");
    const corrupt = await store.readRecordSchedulerCoordinatorStore(options(crashRoot));
    assert.equal(corrupt.kind, "corrupt");
    await assert.rejects(
        () => store.initializeRecordSchedulerCoordinatorStore({ ...timedOptions(crashRoot, baseNow + 1), snapshot: makeSnapshot() }),
        /修复|repair/u,
    );
    assert.equal(await fs.promises.readFile(crashPaths.snapshotPath, "utf8"), "{broken-json", "损坏证据不得被初始化覆盖");
    await fs.promises.writeFile(crashPaths.snapshotPath, currentRaw, "utf8");
    await fs.promises.rm(crashRoot, { recursive: true, force: true });

    const roundtripRoot = createRoot("roundtrip");
    const activeClaim = { claimId: "claim-1", taskId: "task-1", recordId: "record-1", unitId: "unit-1", dispatchSeq: 43 };
    const roundtripSnapshot = makeSnapshot(43, [activeClaim]);
    await store.createRecordSchedulerCoordinatorStore({ ...timedOptions(roundtripRoot, baseNow), snapshot: roundtripSnapshot });
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "record-scheduler-coordinator-store.ts")).href;
    const roundtripWorker = await runEval(`
      const store = await import(${JSON.stringify(moduleUrl)});
      const read = await store.readRecordSchedulerCoordinatorStore({ dataRoot: process.env.COORDINATOR_STORE_TEST_ROOT });
      if (read.kind !== "current") throw new Error(read.kind);
      console.log(JSON.stringify({ dispatchSeq: read.snapshot.fairness.dispatchSeq, activeClaims: read.snapshot.activeClaims, fairness: read.snapshot.fairness }));
    `, { COORDINATOR_STORE_TEST_ROOT: roundtripRoot });
    assert.equal(roundtripWorker.code, 0, roundtripWorker.stderr);
    const roundtrip = JSON.parse(roundtripWorker.stdout.trim()) as { dispatchSeq: number; activeClaims: unknown[]; fairness: { records: unknown[] } };
    assert.equal(roundtrip.dispatchSeq, 43, "重启读取必须保留 dispatchSeq");
    assert.deepEqual(roundtrip.activeClaims, [activeClaim], "重启读取必须保留 active claims");
    assert.equal(roundtrip.fairness.records.length, 1, "重启读取必须保留 fairness 状态");
    await fs.promises.rm(roundtripRoot, { recursive: true, force: true });

    const releaseRetryRoot = createRoot("release-retry");
    let releaseFailureInjected = false;
    try {
        store.setRecordSchedulerCoordinatorLockTestHookForTest(context => {
            if (context.phase === "before-release-unlink" && !releaseFailureInjected) {
                releaseFailureInjected = true;
                throw new Error("injected release failure");
            }
        });
        await store.withRecordSchedulerCoordinatorFileLock(async lock => {
            await assert.rejects(() => lock.release(), /injected release failure/u);
            assert.equal(fs.existsSync(lock.path), true, "首次 release 失败后 lock 证据必须仍在");
            await lock.release();
            assert.equal(fs.existsSync(lock.path), false, "同一 lock 对象必须允许幂等重试 release");
        }, options(releaseRetryRoot));
        assert.equal(releaseFailureInjected, true);
    } finally {
        store.setRecordSchedulerCoordinatorLockTestHookForTest(undefined);
        await fs.promises.rm(releaseRetryRoot, { recursive: true, force: true });
    }

    const disappearingLockMetadata = JSON.stringify({
        schemaVersion: 1,
        token: "disappearing-structured-lock",
        ownerPid: process.pid,
        processInstanceId: "different-process-instance",
        processStartedAtMs: Date.now() - 60_001,
        createdAtMs: Date.now() - 60_000,
        heartbeatAtMs: Date.now() - 60_000,
    });
    await assertDisappearingObservedLockRetries(
        "disappearing-structured-open",
        disappearingLockMetadata,
        "structured",
        "after-lock-lstat-before-open",
    );
    await assertDisappearingObservedLockRetries(
        "disappearing-opaque-revalidate",
        "{opaque-lock",
        "opaque",
        "after-lock-read-before-lstat",
    );

    const reusedPidRoot = createRoot("reused-pid");
    const reusedPidPaths = store.resolveRecordSchedulerCoordinatorStorePaths(options(reusedPidRoot));
    const staleAtMs = Date.now() - 60_000;
    await fs.promises.writeFile(reusedPidPaths.lockPath, JSON.stringify({
        schemaVersion: 1,
        token: "stale-same-pid-token",
        ownerPid: process.pid,
        processInstanceId: "different-process-instance",
        processStartedAtMs: staleAtMs - 1_000,
        createdAtMs: staleAtMs,
        heartbeatAtMs: staleAtMs,
    }), "utf8");
    const staleDate = new Date(staleAtMs);
    await fs.promises.utimes(reusedPidPaths.lockPath, staleDate, staleDate);
    let reusedPidAcquired = false;
    await store.withRecordSchedulerCoordinatorFileLock(async lock => {
        reusedPidAcquired = true;
        await lock.assertHeld();
    }, { ...options(reusedPidRoot), lock: { staleMs: 5, timeoutMs: 2_000, retryMs: 5 } });
    assert.equal(reusedPidAcquired, true, "同 PID 但不同 processInstanceId 的 stale lock 不得永久阻塞");
    await fs.promises.rm(reusedPidRoot, { recursive: true, force: true });

    const junctionTargetRoot = createRoot("junction-target");
    const junctionHostRoot = createRoot("junction-host");
    const junctionPath = path.join(junctionHostRoot, "redirect");
    const nestedDataRoot = path.join(junctionTargetRoot, "nested", "data");
    await fs.promises.mkdir(nestedDataRoot, { recursive: true });
    await fs.promises.symlink(junctionTargetRoot, junctionPath, process.platform === "win32" ? "junction" : "dir");
    const junctionDataRoot = path.join(junctionPath, "nested", "data");
    const junctionRead = await store.readRecordSchedulerCoordinatorStore(options(junctionDataRoot));
    assert.equal(junctionRead.kind, "repair_required", "junction 祖先必须 fail closed");
    if (junctionRead.kind === "repair_required") assert.equal(junctionRead.reason, "unsafe_path");
    await assert.rejects(
        () => store.createRecordSchedulerCoordinatorStore({ ...timedOptions(junctionDataRoot, baseNow), snapshot: makeSnapshot() }),
        /junction|realpath|安全/u,
    );
    await fs.promises.rm(junctionHostRoot, { recursive: true, force: true });
    await fs.promises.rm(junctionTargetRoot, { recursive: true, force: true });

    const liveLockRoot = createRoot("live-lock");
    const liveLockPaths = store.resolveRecordSchedulerCoordinatorStorePaths(options(liveLockRoot));
    const holderReadyPath = path.join(liveLockRoot, "holder.ready");
    const holderScript = `
      const fs = await import("node:fs");
      const { setTimeout: sleep } = await import("node:timers/promises");
      const store = await import(${JSON.stringify(moduleUrl)});
      await store.withRecordSchedulerCoordinatorFileLock(async lock => {
        await fs.promises.writeFile(process.env.COORDINATOR_HOLDER_READY, "ready", "utf8");
        for (let index = 0; index < 60; index += 1) {
          await Promise.all([lock.heartbeat(), lock.assertHeld(), lock.heartbeat()]);
          const raw = await fs.promises.readFile(lock.path, "utf8");
          if (raw.includes("\\u0000")) throw new Error("lock contains NUL");
          JSON.parse(raw);
          await sleep(10);
        }
      }, { dataRoot: process.env.COORDINATOR_STORE_TEST_ROOT, lock: { staleMs: 1, timeoutMs: 2000, retryMs: 1 } });
      console.log("holder-done");
    `;
    const holder = startEval(holderScript, {
        COORDINATOR_STORE_TEST_ROOT: liveLockRoot,
        COORDINATOR_HOLDER_READY: holderReadyPath,
    });
    await waitForFile(holderReadyPath);
    const contenderScript = `
      const store = await import(${JSON.stringify(moduleUrl)});
      try {
        await store.withRecordSchedulerCoordinatorFileLock(async () => {
          console.log("unexpected-acquire");
        }, { dataRoot: process.env.COORDINATOR_STORE_TEST_ROOT, lock: { staleMs: 1, timeoutMs: 150, retryMs: 1 } });
        process.exitCode = 1;
      } catch (error) {
        console.error(error && error.code ? error.code : error);
        process.exitCode = error && error.code === "LOCK_TIMEOUT" ? 2 : 1;
      }
    `;
    const contenderPromise = runEval(contenderScript, { COORDINATOR_STORE_TEST_ROOT: liveLockRoot });
    for (let sample = 0; sample < 40; sample += 1) {
        const raw = await fs.promises.readFile(liveLockPaths.lockPath, "utf8");
        assert.equal(raw.includes("\u0000"), false, "heartbeat 期间 lock 文件不得出现 NUL");
        JSON.parse(raw);
        await sleep(3);
    }
    const contender = await contenderPromise;
    const holderResult = await holder.result;
    assert.equal(contender.code, 2, `live holder 未结束时 contender 必须 LOCK_TIMEOUT：${contender.stderr}`);
    assert.equal(contender.stdout.includes("unexpected-acquire"), false);
    assert.equal(holderResult.code, 0, holderResult.stderr);
    assert.match(holderResult.stdout, /holder-done/u);
    await fs.promises.rm(liveLockRoot, { recursive: true, force: true });

    const processRoot = createRoot("process-owner");
    const processCreated = await store.createRecordSchedulerCoordinatorStore({ ...timedOptions(processRoot, baseNow), snapshot: makeSnapshot() });
    const claimScript = `
      const store = await import(${JSON.stringify(moduleUrl)});
      try {
        const result = await store.acquireRecordSchedulerCoordinatorOwner({
          dataRoot: process.env.COORDINATOR_STORE_TEST_ROOT,
          ownerId: process.env.COORDINATOR_OWNER_ID,
          ownerLeaseId: process.env.COORDINATOR_OWNER_ID + "-lease",
          leaseDurationMs: 60000,
          expectedRevision: ${processCreated.envelope.revision},
          testClock: store.createRecordSchedulerCoordinatorTestClockForTest(() => ${baseNow + 1}),
        });
        console.log("winner:" + result.lease.ownerId);
      } catch (error) {
        console.error(error && error.code ? error.code : error);
        process.exitCode = error && error.code === "REVISION_CONFLICT" ? 2 : 1;
      }
    `;
    const [workerA, workerB] = await Promise.all([
        runEval(claimScript, { COORDINATOR_STORE_TEST_ROOT: processRoot, COORDINATOR_OWNER_ID: "worker-a" }),
        runEval(claimScript, { COORDINATOR_STORE_TEST_ROOT: processRoot, COORDINATOR_OWNER_ID: "worker-b" }),
    ]);
    const workerEvidence = JSON.stringify({ workerA, workerB });
    assert.equal([workerA, workerB].filter(worker => worker.code === 0).length, 1, `双进程只有一个能争到 owner：${workerEvidence}`);
    assert.equal([workerA, workerB].filter(worker => worker.code === 2).length, 1, `另一个进程必须明确得到 revision CAS 冲突：${workerEvidence}`);
    await fs.promises.rm(processRoot, { recursive: true, force: true });

    console.log("✅ record-scheduler-coordinator-store 通过：CAS、clock fencing、heartbeat 活锁保护、实例身份、junction、重启与双进程竞争");
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
