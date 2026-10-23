import fs from "node:fs/promises";
import path from "node:path";
import { maintainExpiredUncertainProviderLease, type ProviderLeaseMaintenanceInput } from "../src/provider-control-store.ts";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
        console.log("node --import tsx scripts/provider-lease-maintenance.ts --request <absolute.json> [--apply --confirm-lease <leaseId>]\nDefault: dry-run. Request: dataRoot, identity (8 fields), expectedRevision, expectedStateSha256 (raw file SHA256), acknowledgedBy, evidenceReference. No model dispatch; apply preserves UNKNOWN/no-replay and backup before claiming its own maintenance owner.");
        return;
    }
    let requestPath: string | undefined;
    let apply = false;
    let confirmedLease: string | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
        seen.add(flag);
        if (flag === "--apply") apply = true;
        else if (flag === "--request" || flag === "--confirm-lease") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error(`missing value: ${flag}`);
            if (flag === "--request") requestPath = value;
            else confirmedLease = value;
        } else throw new Error(`unsupported argument: ${flag}`);
    }
    if (!requestPath || !path.isAbsolute(requestPath)) throw new Error("--request requires an absolute JSON path");
    const stat = await fs.lstat(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("request must be a regular JSON file <=64KiB");
    const request = JSON.parse((await fs.readFile(requestPath, "utf8")).replace(/^\uFEFF/u, "")) as ProviderLeaseMaintenanceInput;
    const allowed = new Set(["dataRoot", "identity", "expectedRevision", "expectedStateSha256", "acknowledgedBy", "evidenceReference"]);
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some(key => !allowed.has(key))) throw new Error("unsupported request fields");
    if (apply && (!confirmedLease || confirmedLease !== request.identity?.leaseId)) throw new Error("--apply requires matching --confirm-lease");
    if (!apply && confirmedLease !== undefined) throw new Error("--confirm-lease requires --apply");
    console.log(JSON.stringify(await maintainExpiredUncertainProviderLease({ ...request, dryRun: !apply }), null, 2));
}

await main().catch(error => {
    console.error(JSON.stringify({
        completed: false, error: error instanceof Error ? error.message : String(error),
        operationId: error?.operationId,
        code: error?.code, phase: error?.phase, stateMayHaveChanged: error?.stateMayHaveChanged,
        evidencePrefix: error?.evidencePrefix, preservationError: error?.preservationError,
        receipt: error?.receipt, maintenanceResult: error?.maintenanceResult,
        primaryError: error?.primaryError, lockReleaseError: error?.lockReleaseError,
        externalOutcome: "UNKNOWN", noReplay: true,
    }));
    process.exitCode = 1;
});
