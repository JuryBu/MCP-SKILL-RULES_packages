import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const implementation = name => {
    const compiled = new URL(`../dist/${name}.js`, import.meta.url);
    return fs.existsSync(compiled) ? compiled.href : new URL(`../src/${name}.ts`, import.meta.url).href;
};

const args = process.argv.slice(2);
const value = flag => {
    const position = args.indexOf(flag);
    return position < 0 ? undefined : args[position + 1];
};
if (args.includes("--help")) {
    console.log("node scripts/repair-auto-summaries.mjs --data-root DIR --manifest FILE [--apply|--recover|--restore --confirm-sha256 SHA256] [--chain auto|grok|agy|antigravity|codex|claude-code]");
    console.log("Default: read-only inspection. Manifest: {version:1,targets:[{hash,memoryId,expectedSummary,expectedFingerprint,expectedSourceFingerprint,confirmed:true,reason}]}. Apply requires the exact manifest SHA256. No old summaries are cleared.");
    process.exit(0);
}
const root = value("--data-root");
const manifestPath = value("--manifest");
if (!root || !manifestPath) throw new Error("Explicit --data-root and --manifest are required");
const raw = fs.readFileSync(path.resolve(manifestPath), "utf-8");
const manifest = JSON.parse(raw);
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
if (manifest.version !== 1 || !Array.isArray(manifest.targets)) throw new Error("Expected version=1 confirmation manifest with targets array");
const chain = value("--chain") || "auto";
if (!["auto", "grok", "agy", "antigravity", "codex", "claude-code"].includes(chain)) throw new Error("Unsupported explicit model chain");
const modes = ["--apply", "--recover", "--restore"].filter(flag => args.includes(flag));
if (modes.length > 1) throw new Error("Choose only one mutation mode");
process.env.MEMORY_STORE_DATA_ROOT = path.resolve(root);
const { inspectAutoSummaryRepairTarget, repairConfirmedAutoSummaries } = await import(implementation("auto-summary-repair"));
if (!modes.length) {
    const targets = manifest.targets.map(target => {
        const current = inspectAutoSummaryRepairTarget(target.hash, target.memoryId);
        const matches = !!current && current.expectedSummary === target.expectedSummary
            && current.expectedFingerprint === target.expectedFingerprint && current.expectedSourceFingerprint === target.expectedSourceFingerprint;
        return { hash: target.hash, memoryId: target.memoryId, confirmed: target.confirmed === true, matches, current };
    });
    console.log(JSON.stringify({ mode: "inspection", modelRequests: 0, manifestSha256: sha256, targets }, null, 2));
} else {
    if (value("--confirm-sha256") !== sha256) throw new Error("Exact --confirm-sha256 is required before any repair request");
    if (modes[0] !== "--apply") {
        const { recoverAutoSummaryWriteback, restoreAutoSummaryWriteback, autoSummaryRecoveryInfo } = await import(implementation("auto-summary-storage"));
        const outcomes = [];
        for (const target of manifest.targets) {
            const identity = inspectAutoSummaryRepairTarget(target.hash, target.memoryId);
            if (!identity || target.confirmed !== true || !target.reason?.trim() || (modes[0] === "--restore" && !/^[a-f0-9]{64}$/u.test(target.operationId || ""))) {
                outcomes.push({ hash: target.hash, memoryId: target.memoryId, status: "unconfirmed" });
                continue;
            }
            const status = modes[0] === "--restore"
                ? await restoreAutoSummaryWriteback(target.hash, target.memoryId, target.operationId)
                : await recoverAutoSummaryWriteback(target.hash, target.memoryId, target);
            outcomes.push({ hash: target.hash, memoryId: target.memoryId, status, recovery: autoSummaryRecoveryInfo(target.hash, target.memoryId) });
        }
        console.log(JSON.stringify({ mode: modes[0].slice(2), modelRequests: 0, manifestSha256: sha256, outcomes }, null, 2));
        if (outcomes.some(outcome => !["written", "existing"].includes(outcome.status))) process.exitCode = 1;
    } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        const outcomes = await repairConfirmedAutoSummaries(manifest.targets, { chain, signal: controller.signal });
        console.log(JSON.stringify({ mode: "apply", manifestSha256: sha256, outcomes }, null, 2));
        if (outcomes.some(outcome => !["written", "existing"].includes(outcome.status))) process.exitCode = 1;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
    }
}
