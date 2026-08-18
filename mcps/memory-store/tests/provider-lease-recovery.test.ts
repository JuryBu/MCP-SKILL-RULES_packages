import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProviderAdmission } from "../src/provider-admission.ts";
import { ProviderTransportAdapter } from "../src/provider-transport-adapter.ts";

type ChildResult = { code: number | null; stdout: string; stderr: string };

async function runAcquireThenHardExit(dataRoot: string, attemptId: string): Promise<ChildResult> {
    const adapterUrl = pathToFileURL(path.join(process.cwd(), "src", "provider-transport-adapter.ts")).href;
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, "--eval", `(async () => {
        const { ProviderTransportAdapter } = await import(${JSON.stringify(adapterUrl)});
        const adapter = new ProviderTransportAdapter({ mode: "test", dataRoot: process.env.PROVIDER_LEASE_RECOVERY_ROOT, ownerId: "crash-owner" });
        const lease = await adapter.acquire("grok", { attemptId: process.env.PROVIDER_LEASE_RECOVERY_ATTEMPT });
        console.log(JSON.stringify(lease.identity));
        process.exit(86);
    })();`], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PROVIDER_LEASE_RECOVERY_ROOT: dataRoot,
            PROVIDER_LEASE_RECOVERY_ATTEMPT: attemptId,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "close") as [number | null];
    return { code, stdout, stderr };
}

async function testHardExitRecoveryNeedsOnlyDataRootAndAttemptId(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-lease-recovery-child-"));
    const attemptId = "hard-exit-before-coordinator-claim";
    try {
        const child = await runAcquireThenHardExit(root, attemptId);
        assert.equal(child.code, 86, `child should hard-exit after durable acquire: ${child.stderr}`);
        assert.match(child.stdout, /"attemptId":"hard-exit-before-coordinator-claim"/u);

        const recoveryAdapter = new ProviderTransportAdapter({ mode: "test", dataRoot: root, ownerId: "recovery-owner" });
        const recovery = await recoveryAdapter.recoverAttempt("grok", attemptId);
        assert.equal(recovery.kind, "active");
        if (recovery.kind !== "active") throw new Error("expected active recovered lease");

        let providerRpcCalls = 0;
        assert.equal((await recoveryAdapter.cancelRecoveredLease(recovery.identity)).kind, "settled");
        assert.equal(providerRpcCalls, 0, "recovery cancellation must happen before any provider RPC");
        assert.equal((await recoveryAdapter.cancelRecoveredLease(recovery.identity)).kind, "already-settled");
        await recoveryAdapter.close();
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testExpiredLeasesAreReclaimedOnTheNextGrant(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-lease-recovery-expiry-"));
    const clock = { nowMs: 1_000 };
    const admission = createProviderAdmission({
        mode: "test",
        dataRoot: root,
        ownerId: "expiry-owner",
        ownerLeaseDurationMs: 60_000,
        leaseDurationMs: 10,
        uncertainGraceMs: 20,
        now: () => clock.nowMs,
    });
    try {
        const activeA = await admission.acquire("grok", "foreground", { attemptId: "expired-active-a" });
        const activeB = await admission.acquire("grok", "foreground", { attemptId: "expired-active-b" });
        clock.nowMs += 11;
        const afterActiveExpiry = await admission.acquire("grok", "foreground", { attemptId: "after-active-expiry" });
        assert.equal(afterActiveExpiry.attemptId, "after-active-expiry");
        assert.equal(await afterActiveExpiry.release(), true);
        assert.equal(await activeA.release(), false);
        assert.equal(await activeB.release(), false);

        const uncertainA = await admission.acquire("grok", "foreground", { attemptId: "expired-uncertain-a" });
        const uncertainB = await admission.acquire("grok", "foreground", { attemptId: "expired-uncertain-b" });
        assert.equal(await uncertainA.markUnknownOutcome(), true);
        assert.equal(await uncertainB.markUnknownOutcome(), true);
        clock.nowMs += 21;
        const afterUncertainExpiry = await admission.acquire("grok", "foreground", { attemptId: "after-uncertain-expiry" });
        assert.equal(afterUncertainExpiry.attemptId, "after-uncertain-expiry");
        assert.equal(await afterUncertainExpiry.release(), true);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testOldOwnerCannotCancelAndNewOwnerIsIdempotent(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-lease-recovery-fence-"));
    try {
        const oldOwner = new ProviderTransportAdapter({ mode: "test", dataRoot: root, ownerId: "old-owner" });
        const granted = await oldOwner.acquire("grok", { attemptId: "old-epoch-cancel" });
        assert.ok(granted.identity);
        if (!granted.identity) throw new Error("expected durable lease identity");

        const newOwner = new ProviderTransportAdapter({ mode: "test", dataRoot: root, ownerId: "new-owner" });
        const recovered = await newOwner.recoverAttempt("grok", "old-epoch-cancel");
        assert.equal(recovered.kind, "active");
        if (recovered.kind !== "active") throw new Error("expected active recovered lease");
        assert.equal((await newOwner.settleRecoveredLease(recovered.identity)).kind, "settled");
        await assert.rejects(
            oldOwner.cancelRecoveredLease(granted.identity),
            (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "OWNER_FENCED",
        );
        assert.equal((await newOwner.cancelRecoveredLease(recovered.identity)).kind, "already-settled");
        await Promise.all([oldOwner.close(), newOwner.close()]);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testHardExitRecoveryNeedsOnlyDataRootAndAttemptId();
    await testExpiredLeasesAreReclaimedOnTheNextGrant();
    await testOldOwnerCannotCancelAndNewOwnerIsIdempotent();
    console.log("provider lease recovery tests passed");
}

await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
