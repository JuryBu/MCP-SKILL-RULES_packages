import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { codexHistoryPhysicalIdentity, parseCodexRolloutFilename, type CodexStreamingHistoryPosition, type CodexStreamingHistoryVerification, type CodexHistoryPhysicalIdentity } from "./codex-history-source.js";
import { throwIfCodexReadCancelled } from "./codex-history-integrity.js";
import type { CorpusProjection, CorpusReadControl } from "./conversation-corpus-types.js";

export const CODEX_CORPUS_CACHE_FORMAT = "codex-corpus-body/v4";
export const CODEX_ROLE_PROOF_CACHE_FORMAT = "codex-role-exclusion-cache/v1";

export interface CodexCorpusCacheEntry {
    format: typeof CODEX_CORPUS_CACHE_FORMAT | typeof CODEX_ROLE_PROOF_CACHE_FORMAT;
    projection: CorpusProjection;
    publishedProjectionVersion?: 2;
    verification?: CodexStreamingHistoryVerification;
    replay?: { round: number; position: CodexStreamingHistoryPosition };
    sourceIdentities: Array<{ path: string; physical: CodexHistoryPhysicalIdentity }>;
}

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_REUSED_ENTRY_BYTES = 64 * 1024 * 1024;
interface ReusedCorpusEntry {
    entry: CodexCorpusCacheEntry;
    manifestPath: string;
    contentPath: string;
    manifestPhysical: string;
    contentPhysical: string;
    bytes: number;
}
const reusedEntries = new Map<string, ReusedCorpusEntry>();
let reusedEntryBytes = 0;
export class CodexCorpusCacheSizeLimitError extends Error {}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const reuseKey = (root: string, conversationId: string, format: CodexCorpusCacheEntry["format"]): string => JSON.stringify([path.resolve(root), conversationId, format]);

function forgetReusedEntry(key: string): void {
    const previous = reusedEntries.get(key);
    if (!previous) return;
    reusedEntryBytes -= previous.bytes;
    reusedEntries.delete(key);
}

function rememberReusedEntry(key: string, value: ReusedCorpusEntry): void {
    forgetReusedEntry(key);
    if (value.bytes > MAX_REUSED_ENTRY_BYTES) return;
    while (reusedEntries.size >= 16 || reusedEntryBytes + value.bytes > MAX_REUSED_ENTRY_BYTES) {
        forgetReusedEntry(reusedEntries.keys().next().value!);
    }
    reusedEntries.set(key, value);
    reusedEntryBytes += value.bytes;
}

function invalidateReusedEntries(root: string, conversationId: string): void {
    forgetReusedEntry(reuseKey(root, conversationId, CODEX_CORPUS_CACHE_FORMAT));
    forgetReusedEntry(reuseKey(root, conversationId, CODEX_ROLE_PROOF_CACHE_FORMAT));
}

async function cacheFileIdentity(filename: string): Promise<string> {
    return JSON.stringify(codexHistoryPhysicalIdentity(await fs.stat(filename)));
}

function directory(root: string, conversationId: string): string {
    return path.join(root, digest(conversationId));
}

async function publicationLock(entryDirectory: string, control: CorpusReadControl): Promise<() => Promise<void>> {
    const lockPath = path.join(entryDirectory, ".publish.lock");
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
        throwIfCodexReadCancelled(control.isCancelled);
        try {
            const handle = await fs.open(lockPath, "wx", 0o600);
            try { await handle.writeFile(JSON.stringify({ format: "codex-corpus-lock/v1", token, pid: process.pid })); }
            catch (error) { await fs.unlink(lockPath).catch(() => {}); throw error; }
            finally { await handle.close(); }
            return async () => {
                try { if (JSON.parse(await fs.readFile(lockPath, "utf8")).token === token) await fs.unlink(lockPath); } catch {}
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        try {
            const raw = await fs.readFile(lockPath, "utf8");
            const lock = JSON.parse(raw);
            if (lock.format === "codex-corpus-lock/v1" && Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.token === "string") {
                let alive = true;
                try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
                if (!alive && await fs.readFile(lockPath, "utf8") === raw) { await fs.unlink(lockPath).catch(() => {}); continue; }
            }
        } catch {}
        if (Date.now() - started >= 20000) throw new Error("Codex corpus cache publication is busy; the previous generation is preserved");
        await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
}

export async function codexCorpusSourceIdentitiesMatch(entry: CodexCorpusCacheEntry, pathsByRolloutId?: ReadonlyMap<string, string[]>): Promise<boolean> {
    if (!entry.sourceIdentities.length || !pathsByRolloutId) return false;
    if (entry.projection.warnings.includes("published_cache_snapshot") && entry.publishedProjectionVersion !== 2) return false;
    const comparable = (value: string) => path.resolve(value).replace(/\\/gu, "/").toLowerCase();
    const expected = new Set(entry.sourceIdentities.map(source => comparable(source.path)));
    for (const source of entry.sourceIdentities) {
        try {
            const physical = codexHistoryPhysicalIdentity(await fs.stat(source.path));
            if (JSON.stringify(physical) !== JSON.stringify(source.physical)) return false;
            const rollout = parseCodexRolloutFilename(source.path);
            const discovered = rollout && pathsByRolloutId.get(rollout.rolloutId);
            if (!discovered?.length || discovered.some(candidate => !expected.has(comparable(candidate)))) return false;
            const companion = /\.zst$/iu.test(source.path) ? source.path.slice(0, -4) : `${source.path}.zst`;
            if (!expected.has(comparable(companion))) {
                try { await fs.stat(companion); return false; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
            }
        } catch { return false; }
    }
    return true;
}

export async function readCodexCorpusCache(root: string, conversationId: string, control: CorpusReadControl, format: CodexCorpusCacheEntry["format"] = CODEX_CORPUS_CACHE_FORMAT): Promise<CodexCorpusCacheEntry | null> {
    throwIfCodexReadCancelled(control.isCancelled);
    const key = reuseKey(root, conversationId, format);
    const previous = reusedEntries.get(key);
    if (previous) {
        try {
            const [manifestPhysical, contentPhysical] = await Promise.all([cacheFileIdentity(previous.manifestPath), cacheFileIdentity(previous.contentPath)]);
            throwIfCodexReadCancelled(control.isCancelled);
            if (!control.forceRefresh && manifestPhysical === previous.manifestPhysical && contentPhysical === previous.contentPhysical) {
                reusedEntries.delete(key);
                reusedEntries.set(key, previous);
                return previous.entry;
            }
        } catch (error) { if ((error as Error).name === "AbortError") throw error; }
        forgetReusedEntry(key);
    }
    try {
        const entryDirectory = directory(root, conversationId);
        const manifestPath = path.join(entryDirectory, "manifest.json");
        const manifestStats = await fs.stat(manifestPath);
        if (manifestStats.size > 4096) return null;
        const manifestPhysical = JSON.stringify(codexHistoryPhysicalIdentity(manifestStats));
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        throwIfCodexReadCancelled(control.isCancelled);
        if (manifest.format !== "codex-corpus-pointer/v1" || typeof manifest.file !== "string" || !/^[a-f0-9]{64}\.json$/u.test(manifest.file) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > MAX_BYTES) return null;
        const contentPath = path.join(entryDirectory, manifest.file);
        const contentStats = await fs.stat(contentPath);
        if (contentStats.size !== manifest.bytes) return null;
        const contentPhysical = JSON.stringify(codexHistoryPhysicalIdentity(contentStats));
        const bytes = await fs.readFile(contentPath);
        throwIfCodexReadCancelled(control.isCancelled);
        if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.sha256) return null;
        const entry = JSON.parse(bytes.toString("utf8")) as CodexCorpusCacheEntry;
        if (entry.format !== format || entry.projection.conversation.id !== conversationId || !entry.projection.complete || !Array.isArray(entry.sourceIdentities)) return null;
        throwIfCodexReadCancelled(control.isCancelled);
        rememberReusedEntry(key, { entry, manifestPath, contentPath, manifestPhysical, contentPhysical, bytes: bytes.length });
        return entry;
    } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        return null;
    }
}

export async function publishCodexCorpusCache(root: string, entry: CodexCorpusCacheEntry, control: CorpusReadControl, maxBytes = MAX_BYTES): Promise<void> {
    throwIfCodexReadCancelled(control.isCancelled);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error("Codex corpus cache limit must be a positive safe integer within the supported bound");
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new CodexCorpusCacheSizeLimitError(`Codex body projection exceeds its ${maxBytes}-byte cache limit`);
    const bytes = Buffer.from(serialized, "utf8");
    const entryDirectory = directory(root, entry.projection.conversation.id);
    await fs.mkdir(entryDirectory, { recursive: true });
    const release = await publicationLock(entryDirectory, control);
    invalidateReusedEntries(root, entry.projection.conversation.id);
    const sha256 = digest(bytes);
    const filename = `${sha256}.json`;
    const temporary = path.join(entryDirectory, `.partial-${randomUUID()}`);
    const pointerTemporary = `${temporary}.pointer`;
    let previous: string | undefined;
    try {
        try { previous = JSON.parse(await fs.readFile(path.join(entryDirectory, "manifest.json"), "utf8")).file; } catch {}
        const output = await fs.open(temporary, "wx", 0o600);
        try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
        throwIfCodexReadCancelled(control.isCancelled);
        await fs.rename(temporary, path.join(entryDirectory, filename));
        const pointer = await fs.open(pointerTemporary, "wx", 0o600);
        try { await pointer.writeFile(JSON.stringify({ format: "codex-corpus-pointer/v1", file: filename, bytes: bytes.length, sha256 })); await pointer.sync(); } finally { await pointer.close(); }
        throwIfCodexReadCancelled(control.isCancelled);
        await fs.rename(pointerTemporary, path.join(entryDirectory, "manifest.json"));
        for (const candidate of await fs.readdir(entryDirectory)) {
            if (/^[a-f0-9]{64}\.json$/u.test(candidate) && candidate !== filename && candidate !== previous) await fs.unlink(path.join(entryDirectory, candidate)).catch(() => {});
        }
    } finally {
        invalidateReusedEntries(root, entry.projection.conversation.id);
        await fs.unlink(temporary).catch(() => {});
        await fs.unlink(pointerTemporary).catch(() => {});
        await release();
    }
}
