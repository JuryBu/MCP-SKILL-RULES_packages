import { readMemoryFile, withMemoryLock } from "./store.js";
import { captureAutoSummaryFileSnapshot, type AutoSummarySnapshot } from "./auto-summary-snapshot.js";
import { autoSummaryRecoveryInfo, recoverAutoSummaryWriteback, writeAutoSummaryIfUnchanged, type AutoSummaryWritebackResult } from "./auto-summary-storage.js";
import { generateAutoSummaryResult } from "./auto-summary.js";
import type { AutoSummaryGenerationResult } from "./auto-summary-types.js";
import type { Chain } from "./chain.js";

export interface AutoSummaryRepairTarget {
    hash: string;
    memoryId: string;
    expectedSummary: string;
    expectedFingerprint: string;
    expectedSourceFingerprint: string;
}

export interface ConfirmedAutoSummaryRepairTarget extends AutoSummaryRepairTarget {
    confirmed: true;
    reason: string;
}

export interface AutoSummaryRepairOutcome {
    hash: string;
    memoryId: string;
    status: AutoSummaryWritebackResult | "unconfirmed" | "generation-failed" | "not-started";
    generation?: AutoSummaryGenerationResult["provenance"];
    recovery?: ReturnType<typeof autoSummaryRecoveryInfo>;
}

function validTargetIdentity(hash: string, memoryId: string): boolean {
    return /^(?:general|[a-f0-9]{8})$/u.test(hash)
        && !!memoryId && memoryId !== "." && memoryId !== ".." && !/[\\/\x00-\x1f:]/u.test(memoryId);
}

export function inspectAutoSummaryRepairTarget(hash: string, memoryId: string): AutoSummaryRepairTarget | null {
    if (!validTargetIdentity(hash, memoryId)) return null;
    const content = readMemoryFile(hash, memoryId);
    const snapshot = content === null ? null : captureAutoSummaryFileSnapshot(content);
    if (!snapshot?.sourceFingerprint || !snapshot.expectedSummary?.trim()) return null;
    return { hash, memoryId, expectedSummary: snapshot.expectedSummary, expectedFingerprint: snapshot.fingerprint, expectedSourceFingerprint: snapshot.sourceFingerprint };
}

function matchesTarget(snapshot: AutoSummarySnapshot | null, target: AutoSummaryRepairTarget): snapshot is AutoSummarySnapshot {
    return !!snapshot && snapshot.expectedSummary === target.expectedSummary
        && snapshot.fingerprint === target.expectedFingerprint
        && snapshot.sourceFingerprint === target.expectedSourceFingerprint;
}

export async function repairConfirmedAutoSummaries(
    targets: readonly ConfirmedAutoSummaryRepairTarget[],
    options: {
        chain?: Chain;
        signal?: AbortSignal;
        generate?: (snapshot: AutoSummarySnapshot, chain: Chain, signal?: AbortSignal) => Promise<AutoSummaryGenerationResult>;
    } = {},
): Promise<AutoSummaryRepairOutcome[]> {
    const outcomes: AutoSummaryRepairOutcome[] = [];
    let stopped = false;
    for (const target of targets) {
        const base = { hash: target.hash, memoryId: target.memoryId };
        if (stopped || options.signal?.aborted) {
            outcomes.push({ ...base, status: "not-started" });
            continue;
        }
        if (!validTargetIdentity(target.hash, target.memoryId) || target.confirmed !== true || !target.reason?.trim()
            || !target.expectedSummary?.trim() || !/^[a-f0-9]{64}$/u.test(target.expectedFingerprint) || !/^[a-f0-9]{64}$/u.test(target.expectedSourceFingerprint)) {
            outcomes.push({ ...base, status: "unconfirmed" });
            continue;
        }
        const recovery = autoSummaryRecoveryInfo(target.hash, target.memoryId);
        if (recovery && recovery.phase !== "complete" && recovery.phase !== "restored") {
            const status = await recoverAutoSummaryWriteback(target.hash, target.memoryId, target);
            outcomes.push({ ...base, status, recovery: autoSummaryRecoveryInfo(target.hash, target.memoryId) });
            continue;
        }
        const snapshot = await withMemoryLock(target.hash, target.memoryId, () => {
            const content = readMemoryFile(target.hash, target.memoryId);
            return content === null ? null : captureAutoSummaryFileSnapshot(content);
        });
        if (!matchesTarget(snapshot, target)) {
            outcomes.push({ ...base, status: "stale" });
            continue;
        }
        let generated: AutoSummaryGenerationResult;
        try {
            generated = options.generate
                ? await options.generate(snapshot, options.chain || "auto", options.signal)
                : await generateAutoSummaryResult(snapshot.title, snapshot.tags, snapshot.body, options.chain || "auto", { signal: options.signal });
        } catch (error) {
            generated = {
                summary: null,
                provenance: { version: 1, status: "failed", provider: null, model: null, generatedAt: new Date().toISOString(), failureClass: "UnknownOutcome", failures: [{ provider: null, model: null, reason: error instanceof Error ? error.message : String(error), occurredAt: new Date().toISOString(), kind: "provider", failureClass: "UnknownOutcome" }] },
            };
        }
        const terminal = generated.provenance.cancelled || generated.provenance.safetyStopped || generated.provenance.timedOut || generated.provenance.failureClass === "UnknownOutcome";
        if (terminal && generated.summary) generated = { summary: null, provenance: { ...generated.provenance, status: "failed" } };
        const status = await writeAutoSummaryIfUnchanged({
            hash: target.hash, memoryId: target.memoryId, summary: generated.summary ?? undefined,
            expectedFingerprint: target.expectedFingerprint, expectedSummary: target.expectedSummary, expectedSourceFingerprint: target.expectedSourceFingerprint,
            fallbackTitle: snapshot.title, fallbackTags: snapshot.tags, provenance: generated.provenance,
        });
        outcomes.push({ ...base, status: status === "written" && !generated.summary ? "generation-failed" : status, generation: generated.provenance, recovery: autoSummaryRecoveryInfo(target.hash, target.memoryId) });
        stopped = !!terminal;
    }
    return outcomes;
}
