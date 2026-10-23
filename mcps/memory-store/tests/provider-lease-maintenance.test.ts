import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as store from "../src/provider-control-store.ts";
import { providerLeaseIdentity, type ProviderControlState } from "../src/provider-control-contracts.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-lease-maintenance-test-"));
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
let passed = 0;

async function fixture(change?: (state: ProviderControlState) => void) {
    const dataRoot = path.join(root, crypto.randomUUID());
    await fs.mkdir(dataRoot);
    const baseNow = Date.now() - 120_000;
    const initial = await store.initializeProviderControlStore({ dataRoot, initialization: "exclusive-install", nowMs: baseNow });
    const state = structuredClone(initial.state);
    state.ownerEpoch = 191;
    state.ownerLease = { ownerId: "expired-business-owner", leaseId: "expired-owner-fence", acquiredAtMs: baseNow, expiresAtMs: baseNow + 10_000 };
    state.lastObservedWallClockMs = baseNow + 500;
    const target = {
        leaseId: "expired-target", attemptId: "target-attempt", provider: "agy" as const,
        trafficClass: "foreground" as const, ownerEpoch: 191, capacityGeneration: 1,
        acquiredAtMs: baseNow + 10, expiresAtMs: baseNow + 9000,
        unknownOutcomeAtMs: baseNow + 100, graceExpiresAtMs: baseNow + 1000,
    };
    state.pools.agy.currentLimit = 4;
    state.pools.agy.uncertainLeases = [target, { ...target, leaseId: "other-expired", attemptId: "other-expired-attempt" }];
    const otherActive = { ...target, leaseId: "other-active", attemptId: "other-active-attempt", expiresAtMs: baseNow + 9000 };
    const { unknownOutcomeAtMs: ignoredUnknown, graceExpiresAtMs: ignoredGrace, ...active } = otherActive;
    state.pools.agy.activeLeases = [active];
    state.pools.agy.breaker.openUntilMs = baseNow + 600;
    state.pools.agy.breaker.probeLease = {
        leaseId: active.leaseId, attemptId: active.attemptId, ownerEpoch: active.ownerEpoch,
        capacityGeneration: active.capacityGeneration, acquiredAtMs: active.acquiredAtMs, expiresAtMs: active.expiresAtMs,
    };
    change?.(state);
    state.persistedHash = store.calculateProviderControlHash(state);
    const controlPath = path.join(dataRoot, "record-provider-control.json");
    await fs.writeFile(controlPath, JSON.stringify(state, null, 2) + "\n");
    const before = await fs.readFile(controlPath);
    const request: store.ProviderLeaseMaintenanceInput = {
        dataRoot, identity: providerLeaseIdentity(target), expectedRevision: state.controlRevision,
        expectedStateSha256: digest(before), acknowledgedBy: "isolated-test-operator",
        evidenceReference: "fixture:original-unknown-no-replay", dryRun: false,
    };
    return { dataRoot, controlPath, state, before, request };
}

async function test(name: string, action: () => Promise<void>) {
    try { await action(); passed++; console.log(`PASS ${name}`); }
    finally {
        store.setProviderControlPathSafetyTestHookForTest(undefined);
        store.setProviderControlLockTestHookForTest(undefined);
    }
}

async function cli(args: string[], prelude?: string) {
    const preload = prelude ? ["--import", `data:text/javascript,${encodeURIComponent(prelude)}`] : [];
    const processHandle = spawn(process.execPath, ["--import", "tsx", ...preload, "scripts/provider-lease-maintenance.ts", ...args], {
        cwd: process.cwd(), env: { ...process.env, MEMORY_STORE_DATA_ROOT: path.join(root, "unused-default-root") },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    processHandle.stdout.on("data", chunk => { stdout += chunk; });
    processHandle.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
        processHandle.once("error", reject);
        processHandle.once("close", resolve);
    });
    return { code, stdout, stderr };
}

try {
    await test("default dry-run leaves state, owner and evidence unchanged", async () => {
        const setup = await fixture();
        const entries = await fs.readdir(setup.dataRoot);
        const result = await store.maintainExpiredUncertainProviderLease({ ...setup.request, dryRun: undefined });
        assert.equal(result.kind, "dry-run");
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
        assert.deepEqual(await fs.readdir(setup.dataRoot), entries);
    });
    await test("own owner, UNKNOWN durability first, target-only delta and zero dispatch", async () => {
        const setup = await fixture();
        let publications = 0;
        store.setProviderControlPathSafetyTestHookForTest(async context => {
            if (context.phase !== "after-publish") return;
            publications++;
            const entries = await fs.readdir(setup.dataRoot);
            const unknownFile = entries.find(entry => entry.endsWith(".unknown-no-replay.json"));
            assert.ok(unknownFile);
            const unknown = JSON.parse(await fs.readFile(path.join(setup.dataRoot, unknownFile), "utf8"));
            assert.equal(unknown.externalOutcome, "UNKNOWN");
            assert.equal(unknown.noReplay, true);
            if (publications === 1) {
                const claimed = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
                assert.match(claimed.ownerLease.ownerId, /^lease-maintenance:/u);
                assert.notEqual(claimed.ownerLease.leaseId, setup.state.ownerLease!.leaseId);
                assert.equal(claimed.ownerEpoch, 192);
                assert.equal(claimed.pools.agy.uncertainLeases.length, 2);
            }
        });
        let dispatched = 0;
        const originalFetch = globalThis.fetch;
        const originals = new Map<string, unknown>();
        const denied = () => { dispatched++; throw new Error("model/process dispatch forbidden"); };
        globalThis.fetch = denied as typeof fetch;
        for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
            originals.set(method, (childProcess as any)[method]);
            (childProcess as any)[method] = denied;
        }
        syncBuiltinESMExports();
        let result: store.ProviderLeaseMaintenanceResult;
        try { result = await store.maintainExpiredUncertainProviderLease(setup.request); }
        finally {
            globalThis.fetch = originalFetch;
            for (const [method, original] of originals) (childProcess as any)[method] = original;
            syncBuiltinESMExports();
        }
        assert.equal(dispatched, 0);
        assert.equal(publications, 2);
        assert.equal(result.kind, "reclaimed");
        const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.equal(after.ownerLease, null);
        assert.equal(after.controlRevision, setup.state.controlRevision + 2);
        const expected = structuredClone(setup.state);
        expected.pools.agy.uncertainLeases = expected.pools.agy.uncertainLeases.filter(lease => lease.leaseId !== setup.request.identity.leaseId);
        for (const key of ["ownerEpoch", "ownerLease", "controlRevision", "updatedAtMs", "lastObservedWallClockMs", "publicationId", "persistedHash"]) {
            (expected as any)[key] = after[key];
        }
        assert.deepEqual(after, expected);
        assert.deepEqual(await fs.readFile(`${result.evidencePrefix}.before.json`), setup.before);
        const receipt = JSON.parse(await fs.readFile(`${result.evidencePrefix}.receipt.json`, "utf8"));
        assert.equal(receipt.afterSha256, digest(await fs.readFile(setup.controlPath)));
        assert.equal(receipt.receipt.readBackHash, after.persistedHash);
        assert.equal(receipt.noReplay, true);
        const maintenanceVerification = { dataRoot: setup.dataRoot, nowMs: Date.now(), allowOwnerlessMaintenanceReceipt: true };
        assert.equal(await store.verifyProviderControlDurabilityReceipt(result.receipt!, { dataRoot: setup.dataRoot, nowMs: Date.now() }), false);
        assert.equal(await store.verifyProviderControlDurabilityReceipt(result.receipt!, maintenanceVerification), true);
        const current = await store.readProviderControlStore({ dataRoot: setup.dataRoot });
        assert.equal(current.kind, "current");
        if (current.kind === "current") {
            assert.equal(await store.verifyProviderControlDurabilityReceipt(current.receipt, { dataRoot: setup.dataRoot }), false);
        }
        assert.equal(await store.verifyProviderControlDurabilityReceipt(receipt.maintenanceOwnerReceipt, { dataRoot: setup.dataRoot, nowMs: Date.now() }), false);
        store.setProviderControlPathSafetyTestHookForTest(undefined);
        await store.claimProviderControlOwner({ dataRoot: setup.dataRoot, ownerId: "next-fixture-owner", leaseDurationMs: 60_000, nowMs: Date.now() });
        assert.equal(await store.verifyProviderControlDurabilityReceipt(result.receipt!, { ...maintenanceVerification, nowMs: Date.now() }), false);
    });
    await test("borrowed lane reclamation recalculates only the affected lane", async () => {
        for (const lane of ["agy-first-run-overflow", "agy-fallback"] as const) {
            const setup = await fixture(state => {
                const target = state.pools.agy.uncertainLeases[0];
                target.trafficClass = lane;
                const opposite: typeof lane = lane === "agy-fallback" ? "agy-first-run-overflow" : "agy-fallback";
                const additional = Array.from({ length: 4 }, (_, index) => ({
                    ...target, leaseId: `same-lane-${index}`, attemptId: `same-lane-attempt-${index}`,
                }));
                const otherLane = Array.from({ length: 1 }, (_, index) => ({
                    ...target, leaseId: `other-lane-${index}`, attemptId: `other-lane-attempt-${index}`, trafficClass: opposite,
                }));
                state.pools.agy.uncertainLeases.push(...additional, ...otherLane);
                for (const [trafficClass, idsKey, borrowedKey] of [
                    ["agy-first-run-overflow", "firstRunOverflowLeaseIds", "firstRunOverflowBorrowedSlots"],
                    ["agy-fallback", "fallbackLeaseIds", "fallbackBorrowedSlots"],
                ] as const) {
                    state.agy.admission[idsKey] = state.pools.agy.uncertainLeases.filter(lease => lease.trafficClass === trafficClass).map(lease => lease.leaseId);
                    state.agy.admission[borrowedKey] = Math.max(0, state.agy.admission[idsKey].length - 4);
                }
            });
            const result = await store.maintainExpiredUncertainProviderLease(setup.request);
            assert.equal(result.kind, "reclaimed");
            const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
            const expected = structuredClone(setup.state);
            expected.pools.agy.uncertainLeases = expected.pools.agy.uncertainLeases.filter(lease => lease.leaseId !== setup.request.identity.leaseId);
            const idsKey = lane === "agy-fallback" ? "fallbackLeaseIds" : "firstRunOverflowLeaseIds";
            const borrowedKey = lane === "agy-fallback" ? "fallbackBorrowedSlots" : "firstRunOverflowBorrowedSlots";
            expected.agy.admission[idsKey] = expected.agy.admission[idsKey].filter(leaseId => leaseId !== setup.request.identity.leaseId);
            expected.agy.admission[borrowedKey] = 0;
            for (const key of ["ownerEpoch", "ownerLease", "controlRevision", "updatedAtMs", "publicationId", "persistedHash"] as const) {
                (expected as any)[key] = after[key];
            }
            assert.deepEqual(after, expected);
        }
    });
    await test("live owner rejected, including matching supplied operator name", async () => {
        const setup = await fixture(state => { state.ownerLease!.expiresAtMs = Date.now() + 60_000; });
        setup.request.acknowledgedBy = setup.state.ownerLease!.ownerId;
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /活跃 owner/u);
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
    });
    await test("unexpired grace rejected with no state write", async () => {
        const setup = await fixture(state => { state.pools.agy.uncertainLeases[0].graceExpiresAtMs = Date.now() + 60_000; });
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /grace 尚未到期/u);
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
    });
    await test("all eight identity mismatches rejected", async () => {
        const setup = await fixture();
        for (const key of Object.keys(setup.request.identity)) {
            const identity = structuredClone(setup.request.identity) as any;
            identity[key] = typeof identity[key] === "number" ? identity[key] + 1
                : key === "provider" ? "grok" : key === "trafficClass" ? "record" : identity[key] + "-wrong";
            await assert.rejects(() => store.maintainExpiredUncertainProviderLease({ ...setup.request, identity }));
        }
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
    });
    await test("revision and raw SHA drift independently rejected", async () => {
        const setup = await fixture();
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease({ ...setup.request, expectedRevision: setup.request.expectedRevision + 1 }), /revision 冲突/u);
        await fs.appendFile(setup.controlPath, " ");
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /SHA256 漂移/u);
        assert.deepEqual(await fs.readFile(setup.controlPath), Buffer.concat([setup.before, Buffer.from(" ")]));
    });
    await test("UNKNOWN record failure prevents owner claim and retains failure evidence", async () => {
        const setup = await fixture();
        const originalOpen = fs.open;
        (fs as any).open = async (file: any, ...args: any[]) => {
            if (String(file).endsWith(".unknown-no-replay.json")) throw new Error("injected evidence fsync/open failure");
            return (originalOpen as any)(file, ...args);
        };
        try { await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /injected evidence/u); }
        finally { (fs as any).open = originalOpen; }
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
        assert.ok((await fs.readdir(setup.dataRoot)).some(entry => entry.endsWith(".failure.json")));
    });
    await test("last-moment raw drift at each atomic publish is rejected", async () => {
        for (const changedPublication of [1, 2]) {
            const setup = await fixture();
            let publications = 0;
            store.setProviderControlPathSafetyTestHookForTest(async context => {
                if (context.phase === "before-publish" && ++publications === changedPublication) {
                    await fs.appendFile(setup.controlPath, " ");
                }
            });
            await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /发布前 state SHA256 漂移/u);
            const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
            assert.equal(after.controlRevision, setup.state.controlRevision + changedPublication - 1);
            assert.deepEqual(after.pools.agy.uncertainLeases, setup.state.pools.agy.uncertainLeases);
            assert.ok((await fs.readdir(setup.dataRoot)).some(entry => entry.endsWith(".unknown-no-replay.json")));
            store.setProviderControlPathSafetyTestHookForTest(undefined);
        }
    });
    await test("UNKNOWN record fsync failure rejects before state publication", async () => {
        const setup = await fixture();
        const originalOpen = fs.open;
        (fs as any).open = async (file: any, ...args: any[]) => {
            const handle = await (originalOpen as any)(file, ...args);
            if (String(file).endsWith(".unknown-no-replay.json")) {
                handle.sync = async () => { throw new Error("injected UNKNOWN fsync failure"); };
            }
            return handle;
        };
        try { await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /UNKNOWN fsync failure/u); }
        finally { (fs as any).open = originalOpen; }
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
    });
    await test("each claim and commit rename attempt rejects raw drift, including EPERM retry", async () => {
        for (const publication of [1, 2]) for (const driftAttempt of [1, 2]) {
            const setup = await fixture();
            let publications = 0;
            let changedBytes: Buffer | undefined;
            const attempts: number[] = [];
            store.setProviderControlPathSafetyTestHookForTest(async context => {
                if (context.phase === "before-publish") publications++;
                if (context.phase !== "before-publish-rename-attempt" || publications !== publication) return;
                attempts.push(context.renameAttempt!);
                if (context.renameAttempt === driftAttempt) {
                    await fs.appendFile(setup.controlPath, " ");
                    changedBytes = await fs.readFile(setup.controlPath);
                } else {
                    throw Object.assign(new Error("injected rename EPERM"), { code: "EPERM" });
                }
            });
            await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request),
                (error: any) => error.code === "MAINTENANCE_STATE_DRIFT");
            assert.ok(changedBytes);
            assert.deepEqual(await fs.readFile(setup.controlPath), changedBytes);
            assert.deepEqual(attempts, driftAttempt === 1 ? [1] : [1, 2]);
            assert.equal(JSON.parse(changedBytes.toString()).controlRevision, setup.state.controlRevision + publication - 1);
            store.setProviderControlPathSafetyTestHookForTest(undefined);
        }
    });
    await test("each rename attempt rechecks lock ownership and root identity", async () => {
        for (const fault of ["lock", "root"] as const) for (const faultAttempt of [1, 2]) {
            const setup = await fixture();
            const originalLstat = fs.lstat;
            let rootChanged = false;
            (fs as any).lstat = async (...args: any[]) => {
                const stat = await (originalLstat as any)(...args);
                if (rootChanged && String(args[0]) === setup.dataRoot) return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
                return stat;
            };
            store.setProviderControlPathSafetyTestHookForTest(async context => {
                if (context.phase !== "before-publish-rename-attempt") return;
                if (context.renameAttempt !== faultAttempt) throw Object.assign(new Error("injected retry EBUSY"), { code: "EBUSY" });
                if (fault === "root") rootChanged = true;
                else {
                    const metadata = JSON.parse(await fs.readFile(context.paths.lockPath, "utf8"));
                    await fs.writeFile(context.paths.lockPath, JSON.stringify({ ...metadata, token: "replacement-test-owner" }));
                }
            });
            try {
                await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request),
                    (error: any) => fault === "lock" ? error.code === "LOCK_LOST" : /parent\/root identity/u.test(error.message));
            } finally { (fs as any).lstat = originalLstat; }
            assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
            store.setProviderControlPathSafetyTestHookForTest(undefined);
        }
    });
    await test("post-claim failure retains own expiring fence and UNKNOWN, without rollback", async () => {
        const setup = await fixture();
        store.setProviderControlPathSafetyTestHookForTest(async context => {
            if (context.phase === "after-publish") throw new Error("injected post-claim failure");
        });
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), /post-claim/u);
        const state = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.match(state.ownerLease.ownerId, /^lease-maintenance:/u);
        assert.equal(state.pools.agy.uncertainLeases.length, 2);
        const entries = await fs.readdir(setup.dataRoot);
        assert.ok(entries.some(entry => entry.endsWith(".unknown-no-replay.json")));
        assert.ok(entries.some(entry => entry.endsWith(".failure-state.json")));
    });
    await test("post-commit failure reports possible change and preserves absent target", async () => {
        const setup = await fixture();
        let publications = 0;
        store.setProviderControlPathSafetyTestHookForTest(async context => {
            if (context.phase === "after-publish" && ++publications === 2) throw new Error("injected committed failure");
        });
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), (error: any) => error.stateMayHaveChanged === true);
        const state = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.equal(state.ownerLease, null);
        assert.equal(state.pools.agy.uncertainLeases.length, 1);
        const failureFile = (await fs.readdir(setup.dataRoot)).find(entry => entry.endsWith(".failure.json"))!;
        assert.equal(JSON.parse(await fs.readFile(path.join(setup.dataRoot, failureFile), "utf8")).noReplay, true);
    });
    await test("release failure retains committed receipt and maintenance context", async () => {
        const setup = await fixture();
        store.setProviderControlLockTestHookForTest(context => {
            if (context.phase === "before-release-unlink") throw new Error("injected release failure");
        });
        let failure: any;
        await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), (error: any) => {
            failure = error;
            assert.equal(error.code, "LOCK_RELEASE_FAILED");
            assert.equal(error.stateMayHaveChanged, true);
            assert.equal(error.phase, "preserve-receipt");
            assert.equal(error.noReplay, true);
            assert.equal(error.maintenanceResult.kind, "reclaimed");
            assert.equal(error.operationId, error.maintenanceResult.operationId);
            assert.deepEqual(error.receipt, error.maintenanceResult.receipt);
            assert.match(error.lockReleaseError.message, /injected release failure/u);
            return true;
        });
        const saved = JSON.parse(await fs.readFile(`${failure.evidencePrefix}.receipt.json`, "utf8"));
        assert.deepEqual(failure.receipt, saved.receipt);
        const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.equal(after.ownerLease, null);
        assert.equal(after.pools.agy.uncertainLeases.length, 1);
    });
    await test("release failure preserves primary failure and preservation error", async () => {
        for (const failEvidence of [false, true]) {
            const setup = await fixture();
            const originalOpen = fs.open;
            (fs as any).open = async (file: any, ...args: any[]) => {
                if (failEvidence && String(file).endsWith(".failure-state.json")) throw new Error("injected failure preservation error");
                return (originalOpen as any)(file, ...args);
            };
            let publications = 0;
            store.setProviderControlPathSafetyTestHookForTest(context => {
                if (context.phase === "after-publish" && ++publications === 2) {
                    throw Object.assign(new Error("injected primary commit failure"), { code: "PRIMARY_COMMIT_FAILURE" });
                }
            });
            store.setProviderControlLockTestHookForTest(context => {
                if (context.phase === "before-release-unlink") throw new Error("injected secondary release failure");
            });
            try {
                await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), (error: any) => {
                    assert.equal(error.code, "PRIMARY_COMMIT_FAILURE");
                    assert.equal(error.primaryError.message, "injected primary commit failure");
                    assert.equal(error.primaryError.code, error.code);
                    assert.equal(error.lockReleaseError.code, "LOCK_RELEASE_FAILED");
                    assert.equal(error.stateMayHaveChanged, true);
                    assert.ok(error.operationId && error.evidencePrefix);
                    if (failEvidence) assert.match(error.preservationError, /failure preservation error/u);
                    return true;
                });
            } finally { (fs as any).open = originalOpen; }
            const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
            assert.equal(after.ownerLease, null);
            assert.equal(after.pools.agy.uncertainLeases.length, 1);
            store.setProviderControlPathSafetyTestHookForTest(undefined);
            store.setProviderControlLockTestHookForTest(undefined);
        }
    });
    await test("receipt preservation failure and release failure retain obtained receipt", async () => {
        const setup = await fixture();
        const originalOpen = fs.open;
        (fs as any).open = async (file: any, ...args: any[]) => {
            if (String(file).endsWith(".receipt.json")) {
                throw Object.assign(new Error("injected receipt evidence failure"), { code: "RECEIPT_EVIDENCE_FAILURE" });
            }
            return (originalOpen as any)(file, ...args);
        };
        store.setProviderControlLockTestHookForTest(context => {
            if (context.phase === "before-release-unlink") throw new Error("injected release failure after receipt error");
        });
        try {
            await assert.rejects(() => store.maintainExpiredUncertainProviderLease(setup.request), (error: any) => {
                assert.equal(error.code, "RECEIPT_EVIDENCE_FAILURE");
                assert.equal(error.primaryError.code, error.code);
                assert.equal(error.lockReleaseError.code, "LOCK_RELEASE_FAILED");
                assert.equal(error.phase, "preserve-receipt");
                assert.ok(error.receipt.publicationId);
                assert.equal(error.receipt.ownerLeaseId, null);
                assert.equal(error.maintenanceResult, undefined);
                return true;
            });
        } finally { (fs as any).open = originalOpen; }
        const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.equal(after.ownerLease, null);
        assert.equal(after.pools.agy.uncertainLeases.length, 1);
    });
    await test("CLI release error serializes receipt and primary error context", async () => {
        for (const failCommit of [false, true]) {
            const setup = await fixture();
            const { dryRun: ignoredDryRun, ...request } = setup.request;
            const requestPath = path.join(setup.dataRoot, "request.json");
            await fs.writeFile(requestPath, JSON.stringify(request));
            const prelude = `const store = await import(${JSON.stringify(new URL("../src/provider-control-store.ts", import.meta.url).href)});
                store.setProviderControlLockTestHookForTest(context => { if (context.phase === "before-release-unlink") throw new Error("CLI release failure"); });
                ${failCommit ? 'let publications = 0; store.setProviderControlPathSafetyTestHookForTest(context => { if (context.phase === "after-publish" && ++publications === 2) throw Object.assign(new Error("CLI primary failure"), { code: "CLI_PRIMARY_FAILURE" }); });' : ""}`;
            const result = await cli(["--request", requestPath, "--apply", "--confirm-lease", request.identity.leaseId], prelude);
            assert.equal(result.code, 1, result.stderr);
            const failure = JSON.parse(result.stderr.trim());
            assert.equal(failure.stateMayHaveChanged, true);
            assert.ok(failure.operationId && failure.evidencePrefix);
            assert.equal(failure.lockReleaseError.code, "LOCK_RELEASE_FAILED");
            if (failCommit) {
                assert.equal(failure.code, "CLI_PRIMARY_FAILURE");
                assert.equal(failure.primaryError.message, "CLI primary failure");
            } else {
                assert.equal(failure.code, "LOCK_RELEASE_FAILED");
                assert.equal(failure.maintenanceResult.kind, "reclaimed");
                assert.ok(failure.receipt.publicationId);
            }
        }
    });
    await test("real CLI defaults dry-run and requires explicit lease confirmation", async () => {
        const setup = await fixture();
        const { dryRun: ignoredDryRun, ...request } = setup.request;
        const requestPath = path.join(setup.dataRoot, "request.json");
        await fs.writeFile(requestPath, JSON.stringify(request));
        const dry = await cli(["--request", requestPath]);
        assert.equal(dry.code, 0, dry.stderr);
        assert.equal(JSON.parse(dry.stdout).kind, "dry-run");
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
        const denied = await cli(["--request", requestPath, "--apply"]);
        assert.equal(denied.code, 1);
        assert.match(denied.stderr, /matching --confirm-lease/u);
        assert.deepEqual(await fs.readFile(setup.controlPath), setup.before);
    });
    await test("two real CLI processes serialize; stale revision loses without replay", async () => {
        const setup = await fixture();
        const { dryRun: ignoredDryRun, ...request } = setup.request;
        const requestPath = path.join(setup.dataRoot, "request.json");
        await fs.writeFile(requestPath, JSON.stringify(request));
        const args = ["--request", requestPath, "--apply", "--confirm-lease", request.identity.leaseId];
        const results = await Promise.all([cli(args), cli(args)]);
        assert.deepEqual(results.map(result => result.code).sort(), [0, 1], JSON.stringify(results));
        assert.match(results.find(result => result.code === 1)!.stderr, /REVISION_CONFLICT/u);
        const after = JSON.parse(await fs.readFile(setup.controlPath, "utf8"));
        assert.equal(after.controlRevision, setup.state.controlRevision + 2);
        assert.deepEqual(after.pools.agy.uncertainLeases.map((lease: any) => lease.leaseId), ["other-expired"]);
    });
    await test("maintenance CLI/store have no admission, transport or model imports", async () => {
        for (const filename of ["src/provider-control-store.ts", "scripts/provider-lease-maintenance.ts"]) {
            const source = await fs.readFile(filename, "utf8");
            const imports = source.match(/(?:import|export)\s[^;]*?from\s+["'][^"']+["']/gu) || [];
            assert.ok(imports.every(statement => !/provider-admission|transport-adapter|agy-client|grok-client|child_process/u.test(statement)));
        }
    });
    console.log(JSON.stringify({ passed, productionExecuted: false, modelCalls: 0, temporaryRoot: root }));
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
} catch (error) {
    console.error(`FAILED; isolated evidence retained: ${root}`);
    throw error;
}
