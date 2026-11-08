import fs from "node:fs";
import { type MemoryIndexEntry } from "./cache.js";
import { parseAutoSummaryProvenance } from "./auto-summary-provenance.js";
import { autoSummarySourceFingerprint } from "./auto-summary-snapshot.js";
import { findMemoryById, getEntryPath, parseMemoryFile } from "./store.js";

export interface AutoSummaryCurrentness {
    status: "current" | "stale" | "unverified" | "missing" | "pending" | "failed" | "unavailable";
    summary: string;
    retained: boolean;
    retryBlocked: boolean;
    sourceGeneratedAt?: string;
}

export function inspectAutoSummaryCurrentness(content: string | null): AutoSummaryCurrentness {
    const parsed = content === null ? null : parseMemoryFile(content);
    if (!parsed) return { status: "unavailable", summary: "", retained: false, retryBlocked: true };
    const summary = typeof parsed.frontmatter.autoSummary === "string" ? parsed.frontmatter.autoSummary : "";
    const provenance = parseAutoSummaryProvenance(parsed.frontmatter.autoSummaryProvenance);
    const retryBlocked = provenance?.status === "pending" || provenance?.cancelled === true
        || provenance?.safetyStopped === true || provenance?.failureClass === "UnknownOutcome";
    const common = { summary: "", retained: Boolean(summary), retryBlocked, sourceGeneratedAt: provenance?.summarySource?.generatedAt };
    if (provenance?.status === "pending" || provenance?.status === "failed") return { ...common, status: provenance.status };
    if (!summary.trim()) return { ...common, status: "missing" };
    const fingerprint = provenance?.summarySource?.sourceFingerprint;
    if (provenance?.status !== "generated" || !fingerprint) return { ...common, status: "unverified", retryBlocked: true };
    if (autoSummarySourceFingerprint(content!) !== fingerprint) return { ...common, status: "stale" };
    return { ...common, status: "current", summary };
}

const SOURCE_READ_BUDGET = 128 * 1024;
const CACHE_LIMIT = 256;
const CACHED_SUMMARY_LIMIT = 4096;
type SourceIdentity = Pick<fs.BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;
interface CachedCurrentness {
    identity: SourceIdentity;
    fingerprint: string;
    state: AutoSummaryCurrentness;
}
const currentnessCache = new Map<string, CachedCurrentness>();

function indexedMetadata(entry: MemoryIndexEntry): { state: AutoSummaryCurrentness; fingerprint?: string } {
    const summary = typeof entry.autoSummary === "string" ? entry.autoSummary : "";
    const raw = entry.autoSummaryProvenance;
    if (typeof raw === "string" && raw.length > SOURCE_READ_BUDGET) {
        return { state: { status: "unverified", summary: "", retained: Boolean(summary), retryBlocked: true } };
    }
    const provenance = parseAutoSummaryProvenance(raw);
    const state: AutoSummaryCurrentness = {
        status: "unverified", summary: "", retained: Boolean(summary),
        retryBlocked: provenance?.status === "pending" || provenance?.cancelled === true
            || provenance?.safetyStopped === true || provenance?.failureClass === "UnknownOutcome",
        sourceGeneratedAt: provenance?.summarySource?.generatedAt,
    };
    if (provenance?.status === "failed" || provenance?.status === "pending") {
        state.status = provenance.status;
        return { state };
    }
    if (!summary.trim()) return { state: { ...state, status: "missing" } };
    const fingerprint = provenance?.summarySource?.sourceFingerprint;
    if (provenance?.status !== "generated" || typeof fingerprint !== "string" || !/^[a-f\d]{64}$/iu.test(fingerprint)) return { state: { ...state, retryBlocked: true } };
    return { state, fingerprint };
}

function sourcePath(entry: MemoryIndexEntry, hash?: string): string | null {
    const sourceHash = (entry as MemoryIndexEntry & { _sourceHash?: string })._sourceHash || hash || findMemoryById(entry.id)?.hash;
    return sourceHash ? getEntryPath(sourceHash, entry.id) : null;
}

function sameIdentity(first: SourceIdentity, second: SourceIdentity): boolean {
    return first.dev === second.dev && first.ino === second.ino && first.size === second.size
        && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function cachedState(filePath: string, identity: SourceIdentity, fingerprint: string): AutoSummaryCurrentness | undefined {
    const cached = currentnessCache.get(filePath);
    if (!cached || cached.fingerprint !== fingerprint || !sameIdentity(cached.identity, identity)) {
        currentnessCache.delete(filePath);
        return undefined;
    }
    return { ...cached.state };
}

function rememberState(filePath: string, identity: SourceIdentity, fingerprint: string, state: AutoSummaryCurrentness): void {
    currentnessCache.delete(filePath);
    if (state.summary.length > CACHED_SUMMARY_LIMIT || (state.sourceGeneratedAt !== undefined
        && (typeof state.sourceGeneratedAt !== "string" || state.sourceGeneratedAt.length > 128))) return;
    const snapshot = { dev: identity.dev, ino: identity.ino, size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs };
    currentnessCache.set(filePath, { identity: snapshot, fingerprint, state: { ...state } });
    while (currentnessCache.size > CACHE_LIMIT) currentnessCache.delete(currentnessCache.keys().next().value!);
}

function checkedContent(content: string, fingerprint: string): AutoSummaryCurrentness {
    const state = inspectAutoSummaryCurrentness(content);
    if (state.status === "current" && autoSummarySourceFingerprint(content) !== fingerprint) return { ...state, status: "stale", summary: "" };
    return state;
}

export function inspectIndexedAutoSummaryCurrentness(entry: MemoryIndexEntry, hash?: string): AutoSummaryCurrentness {
    const { state, fingerprint } = indexedMetadata(entry);
    if (!fingerprint) return state;
    let filePath: string | null = null;
    let descriptor: number | undefined;
    try {
        filePath = sourcePath(entry, hash);
        if (!filePath) return { ...state, status: "unavailable", retryBlocked: true };
        descriptor = fs.openSync(filePath, "r");
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile()) return { ...state, status: "unavailable", retryBlocked: true };
        let result = cachedState(filePath, before, fingerprint);
        if (!result) {
            if (before.size > BigInt(SOURCE_READ_BUDGET)) result = { ...state, status: "unverified", retryBlocked: true };
            else {
                const buffer = Buffer.alloc(Number(before.size));
                let offset = 0;
                while (offset < buffer.length) {
                    const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
                    if (count === 0) break;
                    offset += count;
                }
                result = offset === buffer.length ? checkedContent(buffer.toString("utf8"), fingerprint)
                    : { ...state, status: "unverified", retryBlocked: true };
            }
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        const atPath = fs.statSync(filePath, { bigint: true });
        if (!sameIdentity(before, after) || !sameIdentity(after, atPath)) {
            currentnessCache.delete(filePath);
            return { ...state, status: "unverified", retryBlocked: true };
        }
        rememberState(filePath, after, fingerprint, result);
        return result;
    } catch {
        if (filePath) currentnessCache.delete(filePath);
        return { ...state, status: "unavailable", retryBlocked: true };
    } finally {
        if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    }
}

export async function inspectIndexedAutoSummaryCurrentnessAsync(entry: MemoryIndexEntry, hash?: string): Promise<AutoSummaryCurrentness> {
    const { state, fingerprint } = indexedMetadata(entry);
    if (!fingerprint) return state;
    let filePath: string | null = null;
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
        filePath = sourcePath(entry, hash);
        if (!filePath) return { ...state, status: "unavailable", retryBlocked: true };
        handle = await fs.promises.open(filePath, "r");
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) return { ...state, status: "unavailable", retryBlocked: true };
        let result = cachedState(filePath, before, fingerprint);
        if (!result) {
            if (before.size > BigInt(SOURCE_READ_BUDGET)) result = { ...state, status: "unverified", retryBlocked: true };
            else {
                const buffer = Buffer.alloc(Number(before.size));
                let offset = 0;
                while (offset < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
                    if (bytesRead === 0) break;
                    offset += bytesRead;
                }
                result = offset === buffer.length ? checkedContent(buffer.toString("utf8"), fingerprint)
                    : { ...state, status: "unverified", retryBlocked: true };
            }
        }
        const after = await handle.stat({ bigint: true });
        const atPath = await fs.promises.stat(filePath, { bigint: true });
        if (!sameIdentity(before, after) || !sameIdentity(after, atPath)) {
            currentnessCache.delete(filePath);
            return { ...state, status: "unverified", retryBlocked: true };
        }
        rememberState(filePath, after, fingerprint, result);
        return result;
    } catch {
        if (filePath) currentnessCache.delete(filePath);
        return { ...state, status: "unavailable", retryBlocked: true };
    } finally {
        if (handle) { try { await handle.close(); } catch {} }
    }
}

export function projectCurrentAutoSummary<Entry extends MemoryIndexEntry>(entry: Entry, hash?: string): Entry {
    const state = inspectIndexedAutoSummaryCurrentness(entry, hash);
    return { ...entry, autoSummary: state.status === "unverified" ? entry.autoSummary : state.summary };
}

export async function projectCurrentAutoSummaryAsync<Entry extends MemoryIndexEntry>(entry: Entry, hash?: string): Promise<Entry> {
    const state = await inspectIndexedAutoSummaryCurrentnessAsync(entry, hash);
    return { ...entry, autoSummary: state.status === "unverified" ? entry.autoSummary : state.summary };
}

export function autoSummaryCurrentnessNotice(state: AutoSummaryCurrentness): string {
    if (state.status === "current" || state.status === "missing") return "";
    if (state.status === "unverified" && state.retained) return "自动摘要：来源尚未核实；旧摘要仅作检索线索，请按正文核对";
    const label = { stale: "来源已变化", unverified: "来源尚未核实", pending: "正在重新生成", failed: "最新生成失败", unavailable: "来源暂不可读" }[state.status];
    const retained = state.retained ? `；保留的旧摘要未用于检索${state.sourceGeneratedAt ? `，原生成时间 ${state.sourceGeneratedAt}` : ""}` : "";
    return `自动摘要：${label}${retained}`;
}
