import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ProviderLease } from "../src/provider-control-contracts.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-"));
const baseNow = 1_760_000_000_000;
const store = await import("../src/provider-control-store.ts");

function options(dataRoot = root) {
    return { dataRoot };
}

async function bootstrap(dataRoot = root) {
    return store.bootstrapProviderControlStore({
        ...options(dataRoot),
        initialization: "exclusive-install",
        bootstrap: { token: `bootstrap-token:${path.basename(dataRoot)}`, identity: `bootstrap-identity:${path.resolve(dataRoot)}` },
        nowMs: baseNow,
    });
}

async function expectReject(action: () => Promise<unknown>, matcher: RegExp): Promise<void> {
    await assert.rejects(action, matcher);
}

async function runEval(script: string, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    const [code] = await once(child, "close") as [number | null];
    return { code, stdout, stderr };
}

async function runClaimWorker(dataRoot: string, expectedRevision: number, label: string) {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "provider-control-store.ts")).href;
    return runEval(`
const store = await import(${JSON.stringify(moduleUrl)});
try {
  await store.claimProviderControlOwner({
    dataRoot: process.env.PROVIDER_CONTROL_TEST_ROOT,
    ownerId: ${JSON.stringify(label)},
    ownerLeaseId: ${JSON.stringify(`${label}-lease`)},
    leaseDurationMs: 60000,
    nowMs: ${baseNow + 1},
    expectedRevision: ${expectedRevision},
  });
  console.log("winner");
} catch (error) {
  console.error(error && error.code ? error.code : error);
  process.exitCode = error && error.code === "REVISION_CONFLICT" ? 2 : 1;
}
`, { PROVIDER_CONTROL_TEST_ROOT: dataRoot });
}

async function readInWorker(dataRoot: string) {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "provider-control-store.ts")).href;
    return runEval(`
const store = await import(${JSON.stringify(moduleUrl)});
const read = await store.readProviderControlStore({ dataRoot: process.env.PROVIDER_CONTROL_TEST_ROOT });
if (read.kind !== "current") throw new Error(read.repair.reason);
console.log(JSON.stringify({
  active: read.state.pools.agy.activeLeases.length,
  uncertain: read.state.pools.agy.uncertainLeases.length,
  firstLane: read.state.agy.admission.firstRunOverflowLeaseIds,
}));
`, { PROVIDER_CONTROL_TEST_ROOT: dataRoot });
}

function lockMetadata(token: string, ownerPid: number) {
    return JSON.stringify({ token, ownerPid, createdAtMs: 1, heartbeatAtMs: 1 });
}

try {
    const invalidBootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-invalid-bootstrap-"));
    await expectReject(() => store.bootstrapProviderControlStore({
        ...options(invalidBootstrapRoot), initialization: "exclusive-install",
        bootstrap: { token: "", identity: "explicit-bootstrap-identity" }, nowMs: baseNow,
    }), /bootstrap.token/u);
    await fs.promises.rm(invalidBootstrapRoot, { recursive: true, force: true });

    const absent = await store.readProviderControlStore(options());
    assert.equal(absent.kind, "repair-required");
    if (absent.kind === "repair-required") {
        assert.equal(absent.repair.reason, "first_install_required");
        assert.match(absent.repair.detail, /整个 DATA_ROOT/u);
    }

    const initialized = await bootstrap();
    assert.equal(initialized.state.controlRevision, 1);
    assert.equal(await store.verifyProviderControlDurabilityReceipt(initialized.receipt, { ...options(), nowMs: baseNow }), true);
    assert.equal(initialized.receipt.durability.suddenPowerLossGuaranteed, false);
    assert.equal(initialized.receipt.durability.wholeDataRootErasureDetectable, false);
    assert.equal(initialized.receipt.durability.openAtProtection, "unavailable-in-node-path-api");

    const dualDeleteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-dual-delete-"));
    await bootstrap(dualDeleteRoot);
    const dualPaths = store.resolveProviderControlPaths(options(dualDeleteRoot));
    await fs.promises.rm(dualPaths.controlPath);
    await fs.promises.rm(dualPaths.initializationMarkerPath);
    const dualDeleted = await store.readProviderControlStore(options(dualDeleteRoot));
    assert.equal(dualDeleted.kind, "repair-required");
    if (dualDeleted.kind === "repair-required") assert.equal(dualDeleted.repair.reason, "control_file_missing");
    assert.equal(fs.existsSync(dualPaths.installManifestPath), true);
    await fs.promises.rm(dualDeleteRoot, { recursive: true, force: true });
    const wholeRootDeleted = await store.readProviderControlStore(options(dualDeleteRoot));
    assert.equal(wholeRootDeleted.kind, "repair-required");
    if (wholeRootDeleted.kind === "repair-required") {
        assert.equal(wholeRootDeleted.repair.reason, "first_install_required");
        assert.match(wholeRootDeleted.repair.detail, /无法区分全盘擦除/u);
    }
    await fs.promises.rm(dualDeleteRoot, { recursive: true, force: true });

    const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-corrupt-"));
    await bootstrap(corruptRoot);
    await fs.promises.writeFile(store.providerControlPath(options(corruptRoot)), "{not-json", "utf8");
    const corrupt = await store.readProviderControlStore(options(corruptRoot));
    assert.equal(corrupt.kind, "repair-required");
    if (corrupt.kind === "repair-required") assert.equal(corrupt.repair.reason, "control_file_corrupt");
    await fs.promises.rm(corruptRoot, { recursive: true, force: true });

    const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-cas-"));
    const casInitial = await bootstrap(casRoot);
    const casWorkers = await Promise.all([
        runClaimWorker(casRoot, casInitial.state.controlRevision, "cas-owner-a"),
        runClaimWorker(casRoot, casInitial.state.controlRevision, "cas-owner-b"),
    ]);
    assert.deepEqual(casWorkers.map(worker => worker.code).sort(), [0, 2], `cross-process CAS 失败：${JSON.stringify(casWorkers)}`);
    const casState = await store.readProviderControlStore(options(casRoot));
    assert.equal(casState.kind, "current");
    if (casState.kind === "current") assert.equal(casState.state.controlRevision, 2);
    await fs.promises.rm(casRoot, { recursive: true, force: true });

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-stale-"));
    const staleInitial = await bootstrap(staleRoot);
    const staleLockPath = store.providerControlLockPath(options(staleRoot));
    const oldDate = new Date(Date.now() - 60_000);
    await fs.promises.writeFile(staleLockPath, lockMetadata("stale-owner", 999_999), "utf8");
    await fs.promises.utimes(staleLockPath, oldDate, oldDate);
    let observedBarrier = false;
    store.setProviderControlLockTestHookForTest(async context => {
        if (context.phase === "stale-observed" && !observedBarrier) {
            observedBarrier = true;
            await fs.promises.writeFile(staleLockPath, lockMetadata("live-owner", process.pid), "utf8");
        }
    });
    await expectReject(() => store.claimProviderControlOwner({
        ...options(staleRoot), ownerId: "blocked", leaseDurationMs: 60_000, nowMs: baseNow + 1,
        expectedRevision: staleInitial.state.controlRevision, lock: { staleMs: 1, timeoutMs: 80, retryMs: 5 },
    }), /文件锁/u);
    assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "live-owner");
    await fs.promises.rm(staleLockPath, { force: true });

    await fs.promises.writeFile(staleLockPath, lockMetadata("snapshot-stale-owner", 999_999), "utf8");
    await fs.promises.utimes(staleLockPath, oldDate, oldDate);
    const displacedSnapshotLockPath = `${staleLockPath}.snapshot-race`;
    let snapshotBarrier = false;
    store.setProviderControlLockTestHookForTest(async context => {
        if (context.phase === "snapshot-before-open" && !snapshotBarrier) {
            snapshotBarrier = true;
            await fs.promises.rename(staleLockPath, displacedSnapshotLockPath);
            await fs.promises.writeFile(staleLockPath, lockMetadata("snapshot-live-owner", process.pid), "utf8");
        }
    });
    await assert.rejects(() => store.claimProviderControlOwner({
        ...options(staleRoot), ownerId: "blocked-snapshot-race", leaseDurationMs: 60_000, nowMs: baseNow + 1,
        expectedRevision: staleInitial.state.controlRevision, lock: { staleMs: 1, timeoutMs: 80, retryMs: 5 },
    }), error => {
        assert.equal((error as { code?: string }).code, "LOCK_TIMEOUT");
        return true;
    });
    assert.equal(snapshotBarrier, true);
    assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "snapshot-live-owner");
    await fs.promises.rm(staleLockPath, { force: true });
    await fs.promises.rm(displacedSnapshotLockPath, { force: true });

    await fs.promises.writeFile(staleLockPath, lockMetadata("stale-claim", 999_999), "utf8");
    await fs.promises.utimes(staleLockPath, oldDate, oldDate);
    let claimBarrier = false;
    store.setProviderControlLockTestHookForTest(async context => {
        if (context.phase === "stale-claim-acquired" && !claimBarrier) {
            claimBarrier = true;
            await fs.promises.writeFile(staleLockPath, lockMetadata("claim-race-owner", process.pid), "utf8");
        }
    });
    await expectReject(() => store.claimProviderControlOwner({
        ...options(staleRoot), ownerId: "blocked-claim", leaseDurationMs: 60_000, nowMs: baseNow + 1,
        expectedRevision: staleInitial.state.controlRevision, lock: { staleMs: 1, timeoutMs: 80, retryMs: 5 },
    }), /文件锁/u);
    assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "claim-race-owner");
    await fs.promises.rm(staleLockPath, { force: true });

    await fs.promises.writeFile(staleLockPath, lockMetadata("stale-quarantine", 999_999), "utf8");
    await fs.promises.utimes(staleLockPath, oldDate, oldDate);
    let quarantineBarrier = false;
    store.setProviderControlLockTestHookForTest(async context => {
        if (context.phase === "stale-quarantined" && !quarantineBarrier) {
            quarantineBarrier = true;
            await fs.promises.writeFile(staleLockPath, lockMetadata("replacement-owner", process.pid), "utf8");
        }
    });
    await expectReject(() => store.claimProviderControlOwner({
        ...options(staleRoot), ownerId: "blocked-quarantine", leaseDurationMs: 60_000, nowMs: baseNow + 1,
        expectedRevision: staleInitial.state.controlRevision, lock: { staleMs: 1, timeoutMs: 80, retryMs: 5 },
    }), /文件锁/u);
    assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "replacement-owner");
    const evidenceNames = (await fs.promises.readdir(staleRoot)).filter(name => name.includes("stale-evidence"));
    assert.equal(evidenceNames.length, 1);
    await fs.promises.rm(staleLockPath, { force: true });

    await store.withProviderControlFileLock(async () => {
        store.setProviderControlLockTestHookForTest(async context => {
            if (context.phase !== "before-release-unlink") return;
            await fs.promises.rm(staleLockPath, { force: true });
            await fs.promises.writeFile(staleLockPath, lockMetadata("release-race-owner", process.pid), "utf8");
        });
    }, options(staleRoot));
    assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "release-race-owner");
    store.setProviderControlLockTestHookForTest(undefined);
    await fs.promises.rm(staleLockPath, { force: true });
    await fs.promises.writeFile(staleLockPath, "{\"token\":", "utf8");
    await fs.promises.utimes(staleLockPath, oldDate, oldDate);
    await expectReject(() => store.claimProviderControlOwner({
        ...options(staleRoot), ownerId: "half-write", leaseDurationMs: 60_000, nowMs: baseNow + 1,
        expectedRevision: staleInitial.state.controlRevision, lock: { staleMs: 1, timeoutMs: 40, retryMs: 5 },
    }), /半写或损坏/u);
    await fs.promises.rm(staleRoot, { recursive: true, force: true });

    const receiptRootA = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-receipt-a-"));
    const receiptRootB = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-receipt-b-"));
    const receiptA = await bootstrap(receiptRootA);
    await bootstrap(receiptRootB);
    assert.equal(await store.verifyProviderControlDurabilityReceipt(receiptA.receipt, { ...options(receiptRootA), nowMs: baseNow }), true);
    assert.equal(await store.verifyProviderControlDurabilityReceipt(receiptA.receipt, { ...options(receiptRootB), nowMs: baseNow }), false);
    const receiptOwnerA = await store.claimProviderControlOwner({
        ...options(receiptRootA), ownerId: "receipt-owner-a", ownerLeaseId: "receipt-lease-a",
        leaseDurationMs: 100, nowMs: baseNow + 1, expectedRevision: 1,
    });
    assert.equal(await store.verifyProviderControlDurabilityReceipt(receiptOwnerA.receipt, { ...options(receiptRootA), nowMs: baseNow + 2 }), true);
    const receiptOwnerB = await store.claimProviderControlOwner({
        ...options(receiptRootA), ownerId: "receipt-owner-b", ownerLeaseId: "receipt-lease-b",
        leaseDurationMs: 100, nowMs: baseNow + 2, expectedRevision: receiptOwnerA.state.controlRevision,
    });
    assert.equal(await store.verifyProviderControlDurabilityReceipt(receiptOwnerA.receipt, { ...options(receiptRootA), nowMs: baseNow + 3 }), false);
    assert.equal(await store.verifyProviderControlDurabilityReceipt(receiptOwnerB.receipt, { ...options(receiptRootA), nowMs: baseNow + 102 }), false);
    await fs.promises.rm(receiptRootA, { recursive: true, force: true });
    await fs.promises.rm(receiptRootB, { recursive: true, force: true });

    const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-junction-target-"));
    const junctionPath = `${junctionTarget}-link`;
    await fs.promises.symlink(junctionTarget, junctionPath, "junction");
    const junctionRead = await store.readProviderControlStore(options(junctionPath));
    assert.equal(junctionRead.kind, "repair-required");
    if (junctionRead.kind === "repair-required") assert.equal(junctionRead.repair.reason, "control_file_unsafe");
    await fs.promises.rm(junctionPath, { recursive: true, force: true });
    await fs.promises.rm(junctionTarget, { recursive: true, force: true });

    const safetyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-safety-"));
    await bootstrap(safetyRoot);
    const safetyPath = store.providerControlPath(options(safetyRoot));
    let swapped = false;
    store.setProviderControlPathSafetyTestHookForTest(async context => {
        if (context.phase !== "before-publish" || swapped) return;
        swapped = true;
        await fs.promises.rm(safetyPath, { force: true });
        try {
            await fs.promises.symlink(path.join(os.tmpdir(), "provider-control-evil-target"), safetyPath, "file");
        } catch {
            await fs.promises.mkdir(safetyPath);
        }
    });
    await expectReject(() => store.claimProviderControlOwner({
        ...options(safetyRoot), ownerId: "safety-owner", leaseDurationMs: 60_000, nowMs: baseNow + 1, expectedRevision: 1,
    }), /安全|symlink|普通文件/u);
    store.setProviderControlPathSafetyTestHookForTest(undefined);
    await fs.promises.rm(safetyRoot, { recursive: true, force: true });

    const renameRetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-rename-retry-"));
    try {
        const renameInitial = await bootstrap(renameRetryRoot);
        const transientRenameAttempts: number[] = [];
        store.setProviderControlPathSafetyTestHookForTest(context => {
            if (context.phase !== "before-publish-rename-attempt") return;
            transientRenameAttempts.push(context.renameAttempt!);
            if (context.renameAttempt! > 2) return;
            const error = new Error(`injected rename ${context.renameAttempt === 1 ? "EPERM" : "EBUSY"}`) as NodeJS.ErrnoException;
            error.code = context.renameAttempt === 1 ? "EPERM" : "EBUSY";
            throw error;
        });
        const renameOwner = await store.claimProviderControlOwner({
            ...options(renameRetryRoot), ownerId: "rename-owner", ownerLeaseId: "rename-owner-lease",
            leaseDurationMs: 60_000, nowMs: baseNow + 1, expectedRevision: renameInitial.state.controlRevision,
        });
        assert.deepEqual(transientRenameAttempts, [1, 2, 3]);
        assert.equal(renameOwner.state.ownerEpoch, 1);

        let boundedRenameAttempts = 0;
        store.setProviderControlPathSafetyTestHookForTest(context => {
            if (context.phase !== "before-publish-rename-attempt") return;
            boundedRenameAttempts += 1;
            const error = new Error("injected persistent rename EBUSY") as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
        });
        await assert.rejects(() => store.claimProviderControlOwner({
            ...options(renameRetryRoot), ownerId: "rename-owner-replacement", ownerLeaseId: "rename-owner-replacement-lease",
            leaseDurationMs: 60_000, nowMs: baseNow + 2,
        }), error => {
            assert.equal((error as { code?: string }).code, "ATOMIC_PUBLISH_FAILED");
            return true;
        });
        assert.equal(boundedRenameAttempts, 5);
        store.setProviderControlPathSafetyTestHookForTest(undefined);
        const afterRenameFailure = await store.readProviderControlStore(options(renameRetryRoot));
        assert.equal(afterRenameFailure.kind, "current");
        if (afterRenameFailure.kind === "current") {
            assert.equal(afterRenameFailure.state.ownerEpoch, 1);
            assert.equal(afterRenameFailure.state.ownerLease?.leaseId, "rename-owner-lease");
        }
    } finally {
        store.setProviderControlPathSafetyTestHookForTest(undefined);
        await fs.promises.rm(renameRetryRoot, { recursive: true, force: true });
    }

    const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-owner-"));
    await bootstrap(ownerRoot);
    const ownerOne = await store.claimProviderControlOwner({
        ...options(ownerRoot), ownerId: "owner-one", ownerLeaseId: "lease-one", leaseDurationMs: 200,
        nowMs: baseNow + 10, expectedRevision: 1,
    });
    const ownerTwo = await store.claimProviderControlOwner({
        ...options(ownerRoot), ownerId: "owner-two", ownerLeaseId: "lease-two", leaseDurationMs: 200,
        nowMs: baseNow + 20, expectedRevision: ownerOne.state.controlRevision,
    });
    await expectReject(() => store.mutateProviderControlState({
        ...options(ownerRoot), expectedRevision: ownerTwo.state.controlRevision,
        mutate(state) { state.pools.grok.currentLimit = 8; },
    }), /通用 maintenance mutation/u);
    await expectReject(() => store.mutateProviderControlAsOwner({
        ...options(ownerRoot), ownerEpoch: ownerOne.state.ownerEpoch, ownerLeaseId: "lease-one",
        expectedRevision: ownerTwo.state.controlRevision, nowMs: baseNow + 21,
        mutate(state) { state.pools.grok.successCredits += 1; },
    }), /fence/u);
    await expectReject(() => store.mutateProviderControlAsOwner({
        ...options(ownerRoot), ownerEpoch: ownerTwo.state.ownerEpoch, ownerLeaseId: "wrong-current-lease",
        expectedRevision: ownerTwo.state.controlRevision, nowMs: baseNow + 21,
        mutate(state) { state.pools.grok.successCredits += 1; },
    }), /fence/u);
    await expectReject(() => store.mutateProviderControlAsOwner({
        ...options(ownerRoot), ownerEpoch: ownerTwo.state.ownerEpoch, ownerLeaseId: "lease-two",
        nowMs: baseNow + 19,
        mutate(state) { state.pools.grok.successCredits += 1; },
    }), /倒退/u);

    const losses = await Promise.all(Array.from({ length: 8 }, (_, index) => store.applyProviderCongestionLoss({
        ...options(ownerRoot), ownerEpoch: ownerTwo.state.ownerEpoch, ownerLeaseId: "lease-two",
        provider: "grok", attemptId: `loss-${index}`, capacityGeneration: 1, nowMs: baseNow + 30,
    })));
    assert.equal(losses.filter(loss => loss.applied).length, 1);
    const afterLosses = await store.readProviderControlStore(options(ownerRoot));
    assert.equal(afterLosses.kind, "current");
    if (afterLosses.kind === "current") {
        assert.equal(afterLosses.state.pools.grok.currentLimit, 1);
        assert.equal(afterLosses.state.pools.grok.capacityGeneration, 2);
        assert.equal(afterLosses.state.pools.grok.lossEpoch, 1);
    }

    const activeLease: ProviderLease = {
        leaseId: "unknown-restart-lease", attemptId: "unknown-restart-attempt", provider: "agy",
        trafficClass: "agy-first-run-overflow", ownerEpoch: ownerTwo.state.ownerEpoch, capacityGeneration: 1,
        acquiredAtMs: baseNow + 40, expiresAtMs: baseNow + 150,
    };
    const grant = await store.mutateProviderControlAsOwner({
        ...options(ownerRoot), ownerEpoch: ownerTwo.state.ownerEpoch, ownerLeaseId: "lease-two", nowMs: baseNow + 40,
        mutate(state) { state.pools.agy.activeLeases.push(activeLease); },
    });
    assert.equal(await store.verifyProviderControlDurabilityReceipt(grant.receipt, { ...options(ownerRoot), nowMs: baseNow + 41 }), true);
    await store.mutateProviderControlAsOwner({
        ...options(ownerRoot), ownerEpoch: ownerTwo.state.ownerEpoch, ownerLeaseId: "lease-two", nowMs: baseNow + 41,
        mutate(state) {
            state.pools.agy.activeLeases = [];
            state.pools.agy.uncertainLeases.push({ ...activeLease, unknownOutcomeAtMs: baseNow + 41, graceExpiresAtMs: baseNow + 160 });
        },
    });
    assert.equal(await store.verifyProviderControlDurabilityReceipt(grant.receipt, { ...options(ownerRoot), nowMs: baseNow + 42 }), false);
    const restartedProjection = await readInWorker(ownerRoot);
    assert.equal(restartedProjection.code, 0, restartedProjection.stderr);
    const restartState = JSON.parse(restartedProjection.stdout.trim()) as { active: number; uncertain: number; firstLane: string[] };
    assert.deepEqual(restartState, { active: 0, uncertain: 1, firstLane: [activeLease.leaseId] });

    const ownerThree = await store.claimProviderControlOwner({
        ...options(ownerRoot), ownerId: "owner-three", ownerLeaseId: "lease-three", leaseDurationMs: 200,
        nowMs: baseNow + 50,
    });
    assert.equal(ownerThree.state.pools.agy.uncertainLeases.length, 1);
    await store.observeProviderControlTime({ ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", observedNowMs: baseNow + 60 });
    await store.observeProviderControlTime({ ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", observedNowMs: baseNow + 59 });
    const frozen = await store.readProviderControlStore(options(ownerRoot));
    assert.equal(frozen.kind, "current");
    if (frozen.kind !== "current") throw new Error("expected current frozen state");
    const firstFreeze = frozen.state.pools.grok.timeFrozen.freezeEvidence;
    assert.ok(firstFreeze);
    await expectReject(() => store.clearProviderTimeFrozen({
        ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", provider: "grok", nowMs: baseNow + 70,
        recoveryEvidence: {
            freezeEvidenceId: firstFreeze.evidenceId,
            freezeEvidenceHash: "0".repeat(64),
            acknowledgedBy: "operator-a",
            acknowledgedAtMs: baseNow + 65,
            correctedNowMs: baseNow + 70,
        },
    }), /不匹配/u);
    await store.clearProviderTimeFrozen({
        ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", provider: "grok", nowMs: baseNow + 70,
        recoveryEvidence: {
            freezeEvidenceId: firstFreeze.evidenceId,
            freezeEvidenceHash: firstFreeze.evidenceHash,
            acknowledgedBy: "operator-a",
            acknowledgedAtMs: baseNow + 65,
            correctedNowMs: baseNow + 70,
        },
    });
    await store.observeProviderControlTime({ ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", observedNowMs: baseNow + 80 });
    await store.observeProviderControlTime({ ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", observedNowMs: baseNow + 79 });
    await expectReject(() => store.clearProviderTimeFrozen({
        ...options(ownerRoot), ownerEpoch: ownerThree.state.ownerEpoch, ownerLeaseId: "lease-three", provider: "grok", nowMs: baseNow + 90,
        recoveryEvidence: {
            freezeEvidenceId: firstFreeze.evidenceId,
            freezeEvidenceHash: firstFreeze.evidenceHash,
            acknowledgedBy: "operator-a",
            acknowledgedAtMs: baseNow + 85,
            correctedNowMs: baseNow + 90,
        },
    }), /不匹配/u);
    await fs.promises.rm(ownerRoot, { recursive: true, force: true });

    const expiryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-expiry-"));
    await bootstrap(expiryRoot);
    const expiringOwner = await store.claimProviderControlOwner({
        ...options(expiryRoot), ownerId: "expiring-owner", ownerLeaseId: "expiring-lease",
        leaseDurationMs: 10, nowMs: baseNow + 1, expectedRevision: 1,
    });
    await expectReject(() => store.mutateProviderControlAsOwner({
        ...options(expiryRoot), ownerEpoch: expiringOwner.state.ownerEpoch, ownerLeaseId: "expiring-lease", nowMs: baseNow + 11,
        mutate(state) { state.pools.grok.successCredits += 1; },
    }), /已过期/u);
    assert.equal(await store.verifyProviderControlDurabilityReceipt(expiringOwner.receipt, { ...options(expiryRoot), nowMs: baseNow + 11 }), false);
    await fs.promises.rm(expiryRoot, { recursive: true, force: true });

    const renewalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-renewal-"));
    try {
        await bootstrap(renewalRoot);
        const renewableOwner = await store.claimProviderControlOwner({
            ...options(renewalRoot), ownerId: "renew-owner-a", ownerLeaseId: "renew-owner-a-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 100, expectedRevision: 1,
        });
        const initialRevision = renewableOwner.state.controlRevision;
        const concurrentRenewals = await Promise.all(Array.from({ length: 8 }, () => store.renewProviderControlOwner({
            ...options(renewalRoot), ownerEpoch: renewableOwner.state.ownerEpoch, ownerLeaseId: "renew-owner-a-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 800, expectedRevision: initialRevision,
        })));
        assert.equal(concurrentRenewals.every(result => result.state.ownerEpoch === 1), true);
        assert.equal(concurrentRenewals.every(result => result.value.leaseId === "renew-owner-a-lease"), true);
        assert.equal(concurrentRenewals.every(result => result.value.expiresAtMs === baseNow + 1_800), true);
        assert.equal(await Promise.all(concurrentRenewals.map(result => store.verifyProviderControlDurabilityReceipt(
            result.receipt,
            { ...options(renewalRoot), nowMs: baseNow + 800 },
        ))).then(results => results.every(Boolean)), true);
        const afterConcurrentRenew = await store.readProviderControlStore(options(renewalRoot));
        assert.equal(afterConcurrentRenew.kind, "current");
        if (afterConcurrentRenew.kind !== "current") throw new Error("expected current renewal state");
        assert.equal(afterConcurrentRenew.state.controlRevision, initialRevision + 1);
        assert.equal(afterConcurrentRenew.state.ownerEpoch, 1);
        assert.equal(afterConcurrentRenew.state.ownerLease?.ownerId, "renew-owner-a");
        assert.equal(afterConcurrentRenew.state.ownerLease?.acquiredAtMs, baseNow + 100);
        assert.equal(afterConcurrentRenew.state.lastObservedWallClockMs, baseNow + 100);
        assert.deepEqual(afterConcurrentRenew.state.pools, renewableOwner.state.pools);

        await expectReject(() => store.renewProviderControlOwner({
            ...options(renewalRoot), ownerEpoch: 1, ownerLeaseId: "wrong-renew-token",
            leaseDurationMs: 1_000, nowMs: baseNow + 900,
        }), /fence/u);
        await expectReject(() => store.renewProviderControlOwner({
            ...options(renewalRoot), ownerEpoch: 2, ownerLeaseId: "renew-owner-a-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 900,
        }), /fence/u);

        const [renewedAlongsideLoss, concurrentLoss] = await Promise.all([
            store.renewProviderControlOwner({
                ...options(renewalRoot), ownerEpoch: 1, ownerLeaseId: "renew-owner-a-lease",
                leaseDurationMs: 1_000, nowMs: baseNow + 1_400,
            }),
            store.applyProviderCongestionLoss({
                ...options(renewalRoot), ownerEpoch: 1, ownerLeaseId: "renew-owner-a-lease",
                provider: "grok", attemptId: "renew-loss-race", capacityGeneration: 1, nowMs: baseNow + 1_400,
            }),
        ]);
        assert.equal(renewedAlongsideLoss.value.expiresAtMs, baseNow + 2_400);
        assert.equal(concurrentLoss.applied, true);
        const afterRenewLoss = await store.readProviderControlStore(options(renewalRoot));
        assert.equal(afterRenewLoss.kind, "current");
        if (afterRenewLoss.kind !== "current") throw new Error("expected current renew/loss state");
        assert.equal(afterRenewLoss.state.ownerEpoch, 1);
        assert.equal(afterRenewLoss.state.ownerLease?.expiresAtMs, baseNow + 2_400);
        assert.equal(afterRenewLoss.state.pools.grok.lossEpoch, 1);
        assert.equal(afterRenewLoss.state.pools.grok.capacityGeneration, 2);

        await expectReject(() => store.renewProviderControlOwner({
            ...options(renewalRoot), ownerEpoch: 1, ownerLeaseId: "renew-owner-a-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 2_400,
        }), /已过期/u);
        const replacementOwner = await store.claimProviderControlOwner({
            ...options(renewalRoot), ownerId: "renew-owner-b", ownerLeaseId: "renew-owner-b-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 2_400,
        });
        assert.equal(replacementOwner.state.ownerEpoch, 2);
        await expectReject(() => store.renewProviderControlOwner({
            ...options(renewalRoot), ownerEpoch: 1, ownerLeaseId: "renew-owner-a-lease",
            leaseDurationMs: 1_000, nowMs: baseNow + 2_401,
        }), /fence/u);
    } finally {
        await fs.promises.rm(renewalRoot, { recursive: true, force: true });
    }

    const stressRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-provider-control-lock-stress-"));
    try {
        await bootstrap(stressRoot);
        const stressOwner = await store.claimProviderControlOwner({
            ...options(stressRoot), ownerId: "stress-owner", ownerLeaseId: "stress-owner-lease",
            leaseDurationMs: 60_000, nowMs: baseNow + 1_000, expectedRevision: 1,
        });
        let stressGeneration = 1;
        for (let round = 0; round < 50; round += 1) {
            const losses = await Promise.all(Array.from({ length: 8 }, (_, index) => store.applyProviderCongestionLoss({
                ...options(stressRoot), ownerEpoch: stressOwner.state.ownerEpoch, ownerLeaseId: "stress-owner-lease",
                provider: "grok", attemptId: `stress-loss-${round}-${index}`, capacityGeneration: stressGeneration,
                nowMs: baseNow + 2_000 + round,
            })));
            assert.equal(losses.filter(loss => loss.applied).length, 1, `stress round ${round} 同 generation loss 必须只生效一次`);
            stressGeneration += 1;
        }
        const stressRead = await store.readProviderControlStore(options(stressRoot));
        assert.equal(stressRead.kind, "current");
        if (stressRead.kind === "current") {
            assert.equal(stressRead.state.pools.grok.capacityGeneration, 51);
            assert.equal(stressRead.state.pools.grok.lossEpoch, 50);
        }
        const stressPaths = store.resolveProviderControlPaths(options(stressRoot));
        assert.equal(fs.existsSync(stressPaths.lockPath), false, "高并发结束后不得残留 provider control lock");
        assert.deepEqual(
            (await fs.promises.readdir(stressRoot)).filter(name => name.startsWith(`${path.basename(stressPaths.lockPath)}.stale-claim-`)),
            [],
            "高并发结束后不得残留 stale claim 目录",
        );
    } finally {
        await fs.promises.rm(stressRoot, { recursive: true, force: true });
    }

    console.log("provider-control-store tests passed");
} finally {
    store.setProviderControlLockTestHookForTest(undefined);
    store.setProviderControlPathSafetyTestHookForTest(undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
}
