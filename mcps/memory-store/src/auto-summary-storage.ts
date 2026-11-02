import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    DATA_ROOT, countLines, mutateWorkspaceIndex, parseMemoryFile, readMemoryFile,
    syncGlobalIndexForWorkspace, withMemoryLock, writeMemoryFile, writeTextAtomic,
} from "./store.js";
import { autoSummarySourceFingerprint, captureAutoSummaryFileSnapshot, splitAutoSummaryFile, stripAutoSummaryFields } from "./auto-summary-snapshot.js";
import type { AutoSummaryProvenance } from "./auto-summary-types.js";
import { validateAutoSummaryCandidate } from "./auto-summary-validation.js";
import { parseAutoSummaryProvenance } from "./auto-summary-provenance.js";

export type AutoSummaryWritebackResult = "written" | "stale" | "missing" | "invalid" | "existing" | "index-pending";

export interface AutoSummaryWritebackParams {
    hash: string;
    memoryId: string;
    summary?: string;
    expectedFingerprint: string;
    fallbackTitle: string;
    fallbackTags: string[];
    expectedSummary?: string;
    expectedSourceFingerprint?: string;
    provenance?: AutoSummaryProvenance;
}

interface SummaryJournal {
    version: 1;
    hash: string;
    memoryId: string;
    operationId: string;
    phase: "prepared" | "file-written" | "complete" | "restoring" | "restored" | "superseded";
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    createdAt: string;
    error?: string;
    supersededAt?: string;
    supersededBySha256?: string;
}

function digest(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function journalPaths(hash: string, memoryId: string): { directory: string; active: string } {
    const directory = path.join(DATA_ROOT, "auto-summary-transactions", digest(JSON.stringify([hash, memoryId])));
    return { directory, active: path.join(directory, "active.json") };
}

function saveJournal(journal: SummaryJournal): void {
    const paths = journalPaths(journal.hash, journal.memoryId);
    fs.mkdirSync(paths.directory, { recursive: true });
    writeTextAtomic(path.join(paths.directory, `${journal.operationId}.json`), JSON.stringify(journal));
    writeTextAtomic(paths.active, JSON.stringify({ version: 1, operationId: journal.operationId }));
}

function loadJournal(hash: string, memoryId: string, operationId?: string): SummaryJournal | null {
    const paths = journalPaths(hash, memoryId);
    if (!operationId && !fs.existsSync(paths.active)) return null;
    const id: unknown = operationId || JSON.parse(fs.readFileSync(paths.active, "utf-8")).operationId;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid auto-summary transaction identity");
    const journal = JSON.parse(fs.readFileSync(path.join(paths.directory, `${id}.json`), "utf-8")) as SummaryJournal;
    if (journal.version !== 1 || journal.hash !== hash || journal.memoryId !== memoryId || journal.operationId !== id
        || !["prepared", "file-written", "complete", "restoring", "restored", "superseded"].includes(journal.phase)
        || digest(journal.before) !== journal.beforeSha256 || digest(journal.after) !== journal.afterSha256
        || autoSummarySourceFingerprint(journal.before) !== autoSummarySourceFingerprint(journal.after)) throw new Error("Invalid auto-summary transaction backup");
    if (!operationId && journal.phase === "superseded") return null;
    return journal;
}

function supersedeJournal(journal: SummaryJournal, current: string): void {
    journal.phase = "superseded";
    journal.supersededAt = new Date().toISOString();
    journal.supersededBySha256 = digest(current);
    saveJournal(journal);
    const active = journalPaths(journal.hash, journal.memoryId).active;
    const pointer = JSON.parse(fs.readFileSync(active, "utf-8")) as { operationId?: string };
    if (pointer.operationId === journal.operationId) fs.unlinkSync(active);
}

function patchSummary(content: string, summary: string | undefined, provenance: AutoSummaryProvenance): string {
    const parts = splitAutoSummaryFile(content);
    if (!parts) throw new Error("Invalid memory frontmatter");
    const newline = parts.prefix.endsWith("\r\n") ? "\r\n" : "\n";
    let metadata = summary === undefined
        ? parts.metadata.replace(/^autoSummaryProvenance:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gmu, "")
        : stripAutoSummaryFields(parts.metadata);
    if (summary !== undefined) metadata += `autoSummary: >${newline}${summary.split(/\r?\n/u).map(line => `  ${line}`).join(newline)}${newline}`;
    metadata += `autoSummaryProvenance: ${JSON.stringify(provenance)}${newline}`;
    return parts.prefix + metadata + parts.suffix;
}

async function synchronizeSummaryIndexes(hash: string, memoryId: string, expectedContent: string): Promise<void> {
    await mutateWorkspaceIndex(hash, index => {
        const current = readMemoryFile(hash, memoryId);
        if (current !== expectedContent) throw new Error("Memory changed before summary index synchronization");
        const parsed = parseMemoryFile(current);
        const entry = index.entries.find(candidate => candidate.id === memoryId);
        if (!parsed || !entry) throw new Error("Memory index entry missing during summary synchronization");
        entry.autoSummary = typeof parsed.frontmatter.autoSummary === "string" ? parsed.frontmatter.autoSummary : undefined;
        entry.autoSummaryProvenance = typeof parsed.frontmatter.autoSummaryProvenance === "string" ? parsed.frontmatter.autoSummaryProvenance : undefined;
        entry.sizeBytes = Buffer.byteLength(current, "utf-8");
        entry.lineCount = countLines(current);
    });
    await syncGlobalIndexForWorkspace(hash);
}

async function recoverJournal(journal: SummaryJournal): Promise<AutoSummaryWritebackResult> {
    if (journal.phase === "superseded") return "stale";
    if (journal.phase === "complete" || journal.phase === "restored") return "existing";
    const current = readMemoryFile(journal.hash, journal.memoryId);
    if (current === null) return "missing";
    if (current !== journal.before && current !== journal.after) return "stale";
    const restoring = journal.phase === "restoring";
    const desired = restoring ? journal.before : journal.after;
    try {
        if (current !== desired) writeMemoryFile(journal.hash, journal.memoryId, desired);
        journal.phase = restoring ? "restoring" : "file-written";
        saveJournal(journal);
        await synchronizeSummaryIndexes(journal.hash, journal.memoryId, desired);
        journal.phase = restoring ? "restored" : "complete";
        delete journal.error;
        saveJournal(journal);
        return "written";
    } catch (error) {
        journal.error = error instanceof Error ? error.message : String(error);
        saveJournal(journal);
        return "index-pending";
    }
}

export async function recoverAutoSummaryWriteback(hash: string, memoryId: string, expected?: { expectedSummary: string; expectedFingerprint: string; expectedSourceFingerprint: string }): Promise<AutoSummaryWritebackResult> {
    return withMemoryLock(hash, memoryId, async () => {
        const journal = loadJournal(hash, memoryId);
        if (journal && expected) {
            const snapshot = captureAutoSummaryFileSnapshot(journal.before);
            if (!snapshot || snapshot.expectedSummary !== expected.expectedSummary || snapshot.fingerprint !== expected.expectedFingerprint || snapshot.sourceFingerprint !== expected.expectedSourceFingerprint) return "stale";
        }
        return journal ? recoverJournal(journal) : "missing";
    });
}

export async function restoreAutoSummaryWriteback(hash: string, memoryId: string, operationId: string): Promise<AutoSummaryWritebackResult> {
    return withMemoryLock(hash, memoryId, async () => {
        const journal = loadJournal(hash, memoryId, operationId);
        if (!journal) return "missing";
        const current = readMemoryFile(hash, memoryId);
        if (current === null) return "missing";
        if (current !== journal.after && current !== journal.before) return "stale";
        journal.phase = "restoring";
        saveJournal(journal);
        return recoverJournal(journal);
    });
}

export function autoSummaryRecoveryInfo(hash: string, memoryId: string): { operationId: string; backupPath: string; phase: string; error?: string } | null {
    const journal = loadJournal(hash, memoryId);
    if (journal && journal.phase !== "complete" && journal.phase !== "restored") {
        const current = readMemoryFile(hash, memoryId);
        if (current !== null && current !== journal.before && current !== journal.after) return null;
    }
    return journal ? { operationId: journal.operationId, backupPath: path.join(journalPaths(hash, memoryId).directory, `${journal.operationId}.json`), phase: journal.phase, error: journal.error } : null;
}

export async function writeAutoSummaryIfUnchanged(params: AutoSummaryWritebackParams): Promise<AutoSummaryWritebackResult> {
    if (params.summary !== undefined && validateAutoSummaryCandidate(params.summary)) return "invalid";
    if (params.summary === undefined && (!params.provenance || params.provenance.status !== "failed")) return "invalid";
    if (params.summary !== undefined && params.provenance && params.provenance.status !== "generated") return "invalid";
    if (params.summary !== undefined && (params.provenance?.cancelled || params.provenance?.safetyStopped || params.provenance?.timedOut || params.provenance?.failureClass === "UnknownOutcome")) return "invalid";
    return withMemoryLock(params.hash, params.memoryId, async () => {
        const pending = loadJournal(params.hash, params.memoryId);
        let superseded: SummaryJournal | undefined;
        if (pending && pending.phase !== "complete" && pending.phase !== "restored") {
            const recovered = await recoverJournal(pending);
            if (recovered === "stale") superseded = pending;
            else if (recovered !== "written" && recovered !== "existing") return recovered;
        }
        const content = readMemoryFile(params.hash, params.memoryId);
        if (content === null) return "missing";
        const snapshot = captureAutoSummaryFileSnapshot(content, params.fallbackTitle, params.fallbackTags);
        if (!snapshot) return "invalid";
        if (snapshot.fingerprint !== params.expectedFingerprint || (params.expectedSourceFingerprint && snapshot.sourceFingerprint !== params.expectedSourceFingerprint)) return "stale";
        const exactSummary = Object.hasOwn(params, "expectedSummary");
        if (exactSummary && snapshot.expectedSummary?.trim() && !params.expectedSourceFingerprint) return "invalid";
        if (exactSummary && snapshot.expectedSummary !== params.expectedSummary) return "stale";
        if (!exactSummary && snapshot.expectedSummary?.trim()) return "existing";
        if (superseded) {
            if (!params.expectedSourceFingerprint || readMemoryFile(params.hash, params.memoryId) !== content) return "stale";
            supersedeJournal(superseded, content);
        }
        const provenance: AutoSummaryProvenance = structuredClone(params.provenance || {
            version: 1, status: "generated", provider: null, model: null, generatedAt: new Date().toISOString(), failures: [],
        });
        if (params.summary !== undefined) {
            provenance.summarySource = { provider: provenance.provider, model: provenance.model, generatedAt: provenance.generatedAt, sourceFingerprint: snapshot.sourceFingerprint };
        } else {
            {
                const previous = parseAutoSummaryProvenance(parseMemoryFile(content)?.frontmatter.autoSummaryProvenance);
                const previousSource = previous?.summarySource || (previous?.status === "generated" ? { provider: previous.provider, model: previous.model, generatedAt: previous.generatedAt } : undefined);
                if (previousSource) provenance.summarySource = previousSource;
            }
        }
        const after = patchSummary(content, params.summary, provenance);
        if (autoSummarySourceFingerprint(content) !== autoSummarySourceFingerprint(after)) return "invalid";
        const operationId = digest(JSON.stringify([params.hash, params.memoryId, digest(content), digest(after)]));
        const journal: SummaryJournal = {
            version: 1, hash: params.hash, memoryId: params.memoryId, operationId, phase: "prepared",
            before: content, after, beforeSha256: digest(content), afterSha256: digest(after), createdAt: new Date().toISOString(),
        };
        saveJournal(journal);
        return recoverJournal(journal);
    });
}
