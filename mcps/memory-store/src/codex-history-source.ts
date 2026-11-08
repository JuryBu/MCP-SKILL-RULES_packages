import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeCodexHistoryArchive, materializeCodexHistoryArchiveSync, resolveCodexHistoryArchiveStreamLimits, streamCodexHistoryArchive, type CodexHistoryArchiveOptions, type CodexHistoryArchiveView, type CodexHistoryArchiveStreamIdentity } from "./codex-history-archive.js";
import { CodexHistorySourceMismatchError, CodexOrdinalValidator, hashCodexPrefix, hashCodexPrefixSync, throwIfCodexReadCancelled, type CodexOrdinalMode } from "./codex-history-integrity.js";
import { codexJsonlRecordByteLimit, codexJsonlRecordExceedsLimit } from "./codex-jsonl-record-limit.js";
export { CodexHistorySourceMismatchError } from "./codex-history-integrity.js";

const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const HEADER_READ_CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 8 * 1024;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROLLOUT_FILENAME = new RegExp(`^rollout-.*-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, "i");

export interface CodexHistorySegment {
    path: string;
    readPath?: string;
    archive?: CodexHistoryArchiveView;
    replicas?: CodexHistoryReplica[];
    rolloutId: string;
    threadId: string;
    startOrdinal: number;
    endOrdinalExclusive?: number;
    endByte: number;
    size: number;
    mtimeMs: number;
    headerSha256: string;
    anchorStartByte: number;
    anchorSha256: string;
    prefixSha256?: string;
    ordinalMode?: CodexOrdinalMode;
    unterminatedLeaf?: boolean;
}

export interface CodexHistoryReplica {
    path: string;
    size: number;
    sha256: string;
    archive?: CodexHistoryArchiveView;
}

export function codexHistorySegmentReadPath(segment: CodexHistorySegment): string {
    if (segment.archive) {
        if (segment.path !== segment.archive.sourcePath || segment.readPath !== segment.archive.viewPath || segment.size !== segment.archive.logicalSize) {
            throw new CodexHistorySourceMismatchError("Codex history archive/view identity mismatch");
        }
        return segment.archive.viewPath;
    }
    if (segment.readPath && segment.readPath !== segment.path) throw new CodexHistorySourceMismatchError("Unexpected Codex history read view");
    return segment.path;
}

export interface CodexHistorySource {
    version: 1;
    leafPath: string;
    segments: CodexHistorySegment[];
    revision: string;
    totalBytes: number;
}

const verifiedHistorySources = new WeakMap<CodexHistorySource, { revision: string; identities: Array<{ path: string; identity: string }> }>();
const locateVerifiedHistorySources = new Map<string, CodexHistorySource>();

export interface CodexLocateWindowOptions {
    maxBytes: number;
    direction?: "head" | "tail";
    deadlineAt?: number;
    isCancelled?: () => boolean;
    verifiedSource?: CodexHistorySource;
}

export interface CodexLocateWindowSummary {
    sourcePath: string;
    readPath?: string;
    totalBytes: number;
    totalBytesExact: boolean;
    readEndByte?: number;
    physicalReadBytes: number;
    sourceReadBytes: number;
    viewReadBytes: number;
    readCalls: number;
    searchedBytes: number;
    partial: boolean;
    cancelled: boolean;
    scope: "physical_file" | "logical_history";
    sourceRevision?: string;
    physical?: CodexHistoryPhysicalIdentity;
    headerSha256?: string;
    startOrdinal?: number;
    ordinalMode?: CodexOrdinalMode;
    ranges: Array<{ startByte: number; endByte: number; sha256: string }>;
    warnings: string[];
}

export interface CodexLocateWindowChunk {
    bytes: Buffer;
    startByte: number;
}

export function createCodexLocateWindow(
    rolloutPath: string,
    options: CodexLocateWindowOptions,
): { chunks: Generator<CodexLocateWindowChunk, void>; summary: CodexLocateWindowSummary } {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error("Codex locate maxBytes must be a non-negative safe integer");
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new Error("Codex locate deadlineAt must be finite");
    const summary: CodexLocateWindowSummary = {
        sourcePath: normalizeCodexHistoryPath(rolloutPath), totalBytes: 0, totalBytesExact: false, physicalReadBytes: 0,
        sourceReadBytes: 0, viewReadBytes: 0, readCalls: 0, searchedBytes: 0,
        partial: true, cancelled: false, scope: "physical_file", ranges: [], warnings: [],
    };
    const warn = (reason: string) => { if (!summary.warnings.includes(reason)) summary.warnings.push(reason); };
    const stopped = () => {
        if (options.isCancelled?.()) { summary.cancelled = true; warn("cancelled"); return true; }
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) { warn("deadline_exhausted"); return true; }
        return false;
    };
    function* chunks(): Generator<CodexLocateWindowChunk, void> {
        if (stopped()) return;
        const matches = existingHistoryFiles(summary.sourcePath);
        summary.sourcePath = matches[0]!;
        const sourcePhysical = codexHistoryPhysicalIdentity(fs.statSync(summary.sourcePath));
        summary.physical = sourcePhysical;
        summary.totalBytes = sourcePhysical.size;
        summary.totalBytesExact = !parseCodexRolloutFilename(summary.sourcePath);
        const cached = options.verifiedSource ?? locateVerifiedHistorySources.get(summary.sourcePath);
        let verified: { source: CodexHistorySource; identities: Array<{ path: string; identity: string }> } | undefined;
        if (cached) {
            const proof = verifiedHistorySources.get(cached);
            let unchanged = Boolean(proof && proof.revision === cached.revision && cached.leafPath === summary.sourcePath
                && buildRevision(cached.leafPath, cached.segments) === proof.revision);
            for (const entry of proof?.identities || []) {
                if (stopped()) return;
                try { unchanged &&= entry.identity === JSON.stringify(codexHistoryPhysicalIdentity(fs.statSync(entry.path))); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; unchanged = false; }
            }
            const knownPaths = cached.segments.at(-1);
            unchanged &&= matches.every(candidate => candidate === knownPaths?.path || knownPaths?.replicas?.some(replica => replica.path === candidate));
            if (unchanged && proof) verified = { source: cached, identities: proof.identities };
            else {
                locateVerifiedHistorySources.delete(summary.sourcePath);
                if (options.verifiedSource) throw new CodexHistorySourceMismatchError("Codex locate verified source is stale or was not fully verified");
            }
        }
        const segment = verified?.source.segments.at(-1);
        if (/\.zst$/iu.test(summary.sourcePath) && !segment) { warn("compressed_source_requires_verified_view"); return; }
        const readPath = segment ? codexHistorySegmentReadPath(segment) : summary.sourcePath;
        const readPhysical = codexHistoryPhysicalIdentity(fs.statSync(readPath));
        if (verified && verified.identities.find(entry => entry.path === readPath)?.identity !== JSON.stringify(readPhysical)) {
            throw new CodexHistorySourceMismatchError("Codex locate verified view changed before window read");
        }
        summary.readPath = readPath;
        const endByte = segment?.endByte ?? readPhysical.size;
        summary.readEndByte = endByte;
        summary.headerSha256 = segment?.headerSha256;
        summary.startOrdinal = segment?.startOrdinal;
        summary.ordinalMode = segment?.ordinalMode;
        summary.totalBytes = verified?.source.totalBytes ?? endByte;
        if (verified) {
            summary.totalBytesExact = true;
            summary.scope = "logical_history";
            summary.sourceRevision = verified.source.revision;
            if (verified.source.segments.length > 1) warn("history_base_not_scanned");
        } else if (matches.length > 1) warn("replicas_not_verified");
        if (stopped()) return;
        const descriptor = fs.openSync(readPath, "r");
        let reachedEnd = false;
        let range: { startByte: number; endByte: number; hash: ReturnType<typeof crypto.createHash> } | undefined;
        const finishRange = () => {
            if (!range) return;
            summary.ranges.push({ startByte: range.startByte, endByte: range.endByte, sha256: range.hash.digest("hex") });
            range = undefined;
        };
        const read = (position: number, length: number): Buffer => {
            const buffer = Buffer.allocUnsafe(Math.min(length, 16 * 1024, options.maxBytes - summary.physicalReadBytes));
            if (!buffer.length) return buffer;
            const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
            summary.readCalls += 1;
            summary.physicalReadBytes += count;
            if (readPath === summary.sourcePath) summary.sourceReadBytes += count;
            else summary.viewReadBytes += count;
            const bytes = buffer.subarray(0, count);
            if (count) {
                if (range && range.endByte !== position) finishRange();
                range ??= { startByte: position, endByte: position, hash: crypto.createHash("sha256") };
                range.hash.update(bytes);
                range.endByte += count;
            }
            return bytes;
        };
        try {
            if (JSON.stringify(readPhysical) !== JSON.stringify(codexHistoryPhysicalIdentity(fs.fstatSync(descriptor)))) throw new CodexHistorySourceMismatchError("Codex locate source changed before opening");
            const headerChunks: Buffer[] = [];
            let position = 0;
            if (!verified && parseCodexRolloutFilename(summary.sourcePath)) {
                let headerEnd = -1;
                while (position < endByte && summary.physicalReadBytes < options.maxBytes && headerEnd < 0) {
                    if (stopped()) return;
                    const bytes = read(position, Math.min(4096, endByte - position));
                    if (!bytes.length) throw new CodexHistorySourceMismatchError("Codex locate source shortened while reading its header");
                    headerChunks.push(bytes);
                    const newline = bytes.indexOf(0x0a);
                    if (newline >= 0) headerEnd = position + newline;
                    position += bytes.length;
                    if (position > MAX_HEADER_BYTES) throw new Error("Codex locate header exceeds the safe read limit");
                    yield { bytes: Buffer.alloc(0), startByte: position };
                }
                if (headerEnd < 0 && position < endByte) { warn("header_not_covered"); return; }
                const headerBytes = Buffer.concat(headerChunks);
                const header = parseHeader(summary.sourcePath, headerEnd < 0 ? headerBytes : headerBytes.subarray(0, headerEnd));
                summary.headerSha256 = sha256(header.header);
                summary.startOrdinal = header.historyBase?.endOrdinalExclusive || 0;
                summary.ordinalMode = header.ordinalMode;
                if (header.historyBase?.endByte) warn("history_base_not_scanned");
                else if (matches.length === 1) { summary.scope = "logical_history"; summary.totalBytesExact = true; }
            }
            const tail = options.direction === "tail" && endByte > options.maxBytes;
            if (tail) {
                position = Math.max(position, endByte - (options.maxBytes - summary.physicalReadBytes));
                warn("window_not_full");
            } else {
                let headerPosition = 0;
                for (const bytes of headerChunks) {
                    if (stopped()) return;
                    summary.searchedBytes += bytes.length;
                    yield { bytes, startByte: headerPosition };
                    headerPosition += bytes.length;
                }
            }
            while (position < endByte && summary.physicalReadBytes < options.maxBytes) {
                if (stopped()) return;
                const bytes = read(position, endByte - position);
                if (!bytes.length) throw new CodexHistorySourceMismatchError("Codex locate source shortened while reading its window");
                summary.searchedBytes += bytes.length;
                yield { bytes, startByte: position };
                position += bytes.length;
            }
            reachedEnd = position === endByte;
            if (!reachedEnd) warn("byte_budget_exhausted");
            stopped();
        } finally {
            finishRange();
            let openedAfter: CodexHistoryPhysicalIdentity;
            try { openedAfter = codexHistoryPhysicalIdentity(fs.fstatSync(descriptor)); }
            finally { fs.closeSync(descriptor); }
            const assertUnchanged = (filePath: string, expected: string) => {
                try {
                    if (JSON.stringify(codexHistoryPhysicalIdentity(fs.statSync(filePath))) === expected) return;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
                throw new CodexHistorySourceMismatchError("Codex locate source changed during window read");
            };
            if (JSON.stringify(openedAfter) !== JSON.stringify(readPhysical)) throw new CodexHistorySourceMismatchError("Codex locate opened source changed during window read");
            assertUnchanged(readPath, JSON.stringify(readPhysical));
            assertUnchanged(summary.sourcePath, JSON.stringify(sourcePhysical));
            stopped();
            if (verified) {
                for (const entry of verified.identities) {
                    if (stopped()) break;
                    assertUnchanged(entry.path, entry.identity);
                }
            }
            if (!reachedEnd && !summary.warnings.length) warn("window_consumer_stopped");
            summary.partial = !reachedEnd || summary.warnings.length > 0;
        }
    }
    return { chunks: chunks(), summary };
}

async function historyValidationIdentities(source: { segments: Array<Pick<CodexHistorySegment, "path" | "readPath" | "replicas">> }): Promise<Array<{ path: string; identity: string }>> {
    const paths = [...new Set(source.segments.flatMap(segment => [segment.path, ...(segment.readPath ? [segment.readPath] : []), ...(segment.replicas || []).flatMap(replica => [replica.path, ...(replica.archive ? [replica.archive.viewPath] : [])])]))].sort();
    const identities = [];
    for (const filePath of paths) identities.push({ path: filePath, identity: JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(filePath))) });
    return identities;
}

export function parseCodexRolloutFilename(filePath: string): { threadId: string; rolloutId: string } | null {
    const match = ROLLOUT_FILENAME.exec(path.basename(filePath));
    if (!match) return null;
    const threadId = match[1]!.toLowerCase();
    return { threadId, rolloutId: (match[2] || threadId).toLowerCase() };
}

export function normalizeCodexHistoryPath(filePath: string): string {
    const nativePath = process.platform === "win32"
        ? filePath.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "")
        : filePath;
    return path.resolve(nativePath);
}

function historyFileCandidates(filePath: string): string[] {
    const normalized = normalizeCodexHistoryPath(filePath);
    if (!parseCodexRolloutFilename(normalized)) return [normalized];
    return [normalized, /\.zst$/i.test(normalized) ? normalized.slice(0, -4) : `${normalized}.zst`];
}

function existingHistoryFiles(filePath: string): string[] {
    const candidates = historyFileCandidates(filePath);
    const existing: string[] = [];
    let missing: unknown;
    for (const candidate of candidates) {
        try {
            if (!fs.statSync(candidate).isFile()) throw new Error(`Codex rollout source is not a file: ${candidate}`);
            existing.push(candidate);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing ??= error;
        }
    }
    if (existing.length === 0) throw missing;
    return existing;
}

async function existingHistoryFilesAsync(filePath: string): Promise<string[]> {
    const candidates = historyFileCandidates(filePath);
    const existing: string[] = [];
    let missing: unknown;
    for (const candidate of candidates) {
        try {
            if (!(await fsPromises.stat(candidate)).isFile()) throw new Error(`Codex rollout source is not a file: ${candidate}`);
            existing.push(candidate);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing ??= error;
        }
    }
    if (existing.length === 0) throw missing;
    return existing;
}

export function resolveCodexHistoryFilePath(filePath: string): string {
    return existingHistoryFiles(filePath)[0]!;
}

export async function resolveCodexHistoryFilePathAsync(filePath: string): Promise<string> {
    return (await existingHistoryFilesAsync(filePath))[0]!;
}

interface HistoryBase {
    rolloutId: string;
    endOrdinalExclusive: number;
    endByte: number;
}

interface RolloutHeader {
    identity: { threadId: string; rolloutId: string };
    historyBase?: HistoryBase;
    header: Buffer;
    ordinalMode: CodexOrdinalMode;
}

interface LoadedRollout {
    path: string;
    readPath: string;
    archive?: CodexHistoryArchiveView;
    replicas?: CodexHistoryReplica[];
    size: number;
    mtimeMs: number;
    physical?: CodexHistoryPhysicalIdentity;
    header: RolloutHeader;
}

const streamingHeaderCache = new Map<string, { header: RolloutHeader; physical: CodexHistoryPhysicalIdentity }>();
let streamingHeaderCacheBytes = 0;

function sha256(value: Buffer | string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultRoots(): string[] {
    const codexHome = path.join(os.homedir(), ".codex");
    return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

function finiteInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Codex history ${name} must be a non-negative safe integer`);
    }
    return value;
}

function parseHeader(filePath: string, firstLine: Buffer): RolloutHeader {
    const identity = parseCodexRolloutFilename(filePath);
    if (!identity) throw new Error(`Unrecognized Codex rollout filename: ${filePath}`);

    let record: unknown;
    try {
        record = JSON.parse(firstLine.toString("utf8").replace(/^\uFEFF/u, ""));
    } catch {
        throw new Error(`Invalid first JSONL record in Codex rollout: ${filePath}`);
    }
    if (!record || typeof record !== "object") throw new Error(`Missing session_meta header in Codex rollout: ${filePath}`);
    const candidate = record as { type?: unknown; payload?: unknown };
    if (candidate.type !== "session_meta" || !candidate.payload || typeof candidate.payload !== "object") {
        throw new Error(`First JSONL record must be session_meta in Codex rollout: ${filePath}`);
    }
    const payload = candidate.payload as { id?: unknown; history_base?: unknown };
    if (typeof payload.id !== "string" || payload.id.toLowerCase() !== identity.threadId) {
        throw new Error(`session_meta.payload.id does not match rollout filename: ${filePath}`);
    }

    let historyBase: HistoryBase | undefined;
    if (payload.history_base !== undefined && payload.history_base !== null) {
        if (typeof payload.history_base !== "object") throw new Error(`Invalid history_base in Codex rollout: ${filePath}`);
        const base = payload.history_base as { thread_id?: unknown; end_ordinal_exclusive?: unknown; end_byte_offset?: unknown };
        if (typeof base.thread_id !== "string" || !new RegExp(`^${UUID}$`, "i").test(base.thread_id)) {
            throw new Error(`history_base.thread_id must be a UUID in Codex rollout: ${filePath}`);
        }
        historyBase = {
            rolloutId: base.thread_id.toLowerCase(),
            endOrdinalExclusive: finiteInteger(base.end_ordinal_exclusive, "history_base.end_ordinal_exclusive"),
            endByte: finiteInteger(base.end_byte_offset, "history_base.end_byte_offset"),
        };
        if ((historyBase.endOrdinalExclusive === 0) !== (historyBase.endByte === 0)) {
            throw new Error(`Zero-length history_base must have both ordinal and byte offset zero: ${filePath}`);
        }
    }
    return { identity, historyBase, header: firstLine, ordinalMode: Object.hasOwn(record, "ordinal") ? "explicit" : "legacy" };
}

function readFirstLineSync(filePath: string): Buffer {
    const descriptor = fs.openSync(filePath, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    try {
        while (position <= MAX_HEADER_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(HEADER_READ_CHUNK_BYTES, MAX_HEADER_BYTES + 1 - position));
            const read = fs.readSync(descriptor, chunk, 0, chunk.length, position);
            if (read === 0) break;
            const used = chunk.subarray(0, read);
            const newline = used.indexOf(0x0a);
            if (newline >= 0) {
                chunks.push(used.subarray(0, newline));
                return Buffer.concat(chunks);
            }
            chunks.push(used);
            position += read;
        }
    } finally {
        fs.closeSync(descriptor);
    }
    if (position <= MAX_HEADER_BYTES && chunks.length > 0) return Buffer.concat(chunks);
    throw new Error(`Codex rollout header exceeds ${MAX_HEADER_BYTES} bytes: ${filePath}`);
}

async function readFirstLine(filePath: string): Promise<Buffer> {
    const handle = await fsPromises.open(filePath, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    try {
        while (position <= MAX_HEADER_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(HEADER_READ_CHUNK_BYTES, MAX_HEADER_BYTES + 1 - position));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            const used = chunk.subarray(0, bytesRead);
            const newline = used.indexOf(0x0a);
            if (newline >= 0) {
                chunks.push(used.subarray(0, newline));
                return Buffer.concat(chunks);
            }
            chunks.push(used);
            position += bytesRead;
        }
    } finally {
        await handle.close();
    }
    if (position <= MAX_HEADER_BYTES && chunks.length > 0) return Buffer.concat(chunks);
    throw new Error(`Codex rollout header exceeds ${MAX_HEADER_BYTES} bytes: ${filePath}`);
}

function readAnchorSync(filePath: string, endByte: number): { start: number; value: Buffer } {
    const start = Math.max(0, endByte - ANCHOR_BYTES);
    const value = Buffer.alloc(endByte - start);
    const descriptor = fs.openSync(filePath, "r");
    try {
        const bytesRead = fs.readSync(descriptor, value, 0, value.length, start);
        if (bytesRead !== value.length) throw new Error(`Codex history source became shorter while reading: ${filePath}`);
    } finally {
        fs.closeSync(descriptor);
    }
    return { start, value };
}

async function readAnchor(filePath: string, endByte: number): Promise<{ start: number; value: Buffer }> {
    const start = Math.max(0, endByte - ANCHOR_BYTES);
    const value = Buffer.alloc(endByte - start);
    const handle = await fsPromises.open(filePath, "r");
    try {
        const { bytesRead } = await handle.read(value, 0, value.length, start);
        if (bytesRead !== value.length) throw new Error(`Codex history source became shorter while reading: ${filePath}`);
    } finally {
        await handle.close();
    }
    return { start, value };
}

function assertLineBoundarySync(filePath: string, endByte: number, size: number): void {
    if (endByte > size) throw new CodexHistorySourceMismatchError(`Codex history byte boundary exceeds source size: ${filePath}`);
    if (endByte === 0) return;
    const byte = Buffer.alloc(1);
    const descriptor = fs.openSync(filePath, "r");
    try {
        if (fs.readSync(descriptor, byte, 0, 1, endByte - 1) !== 1 || byte[0] !== 0x0a) {
            throw new CodexHistorySourceMismatchError(`Codex history byte boundary is not a complete JSONL line: ${filePath}`);
        }
    } finally {
        fs.closeSync(descriptor);
    }
}

async function assertLineBoundary(filePath: string, endByte: number, size: number): Promise<void> {
    if (endByte > size) throw new CodexHistorySourceMismatchError(`Codex history byte boundary exceeds source size: ${filePath}`);
    if (endByte === 0) return;
    const byte = Buffer.alloc(1);
    const handle = await fsPromises.open(filePath, "r");
    try {
        const { bytesRead } = await handle.read(byte, 0, 1, endByte - 1);
        if (bytesRead !== 1 || byte[0] !== 0x0a) throw new CodexHistorySourceMismatchError(`Codex history byte boundary is not a complete JSONL line: ${filePath}`);
    } finally {
        await handle.close();
    }
}

function lastCompleteLineEndSync(filePath: string, size: number): number {
    const descriptor = fs.openSync(filePath, "r");
    const suffix: Buffer[] = [];
    try {
        for (let end = size; end > 0;) {
            const start = Math.max(0, end - HEADER_READ_CHUNK_BYTES);
            const value = Buffer.alloc(end - start);
            if (fs.readSync(descriptor, value, 0, value.length, start) !== value.length) {
                throw new Error(`Codex history source became shorter while reading: ${filePath}`);
            }
            const newline = value.lastIndexOf(0x0a);
            if (newline >= 0) {
                suffix.unshift(value.subarray(newline + 1));
                return completeJsonSuffix(suffix) ? size : start + newline + 1;
            }
            if (size - start <= MAX_HEADER_BYTES) suffix.unshift(value);
            end = start;
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return completeJsonSuffix(suffix) ? size : 0;
}

async function lastCompleteLineEnd(filePath: string, size: number): Promise<number> {
    const handle = await fsPromises.open(filePath, "r");
    const suffix: Buffer[] = [];
    try {
        for (let end = size; end > 0;) {
            const start = Math.max(0, end - HEADER_READ_CHUNK_BYTES);
            const value = Buffer.alloc(end - start);
            const { bytesRead } = await handle.read(value, 0, value.length, start);
            if (bytesRead !== value.length) throw new Error(`Codex history source became shorter while reading: ${filePath}`);
            const newline = value.lastIndexOf(0x0a);
            if (newline >= 0) {
                suffix.unshift(value.subarray(newline + 1));
                return completeJsonSuffix(suffix) ? size : start + newline + 1;
            }
            if (size - start <= MAX_HEADER_BYTES) suffix.unshift(value);
            end = start;
        }
    } finally {
        await handle.close();
    }
    return completeJsonSuffix(suffix) ? size : 0;
}

function completeJsonSuffix(chunks: Buffer[]): boolean {
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return value !== null && typeof value === "object";
    } catch {
        return false;
    }
}

function indexRootsSync(roots: string[], isCancelled?: () => boolean): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const add = (filePath: string) => {
        const parsed = parseCodexRolloutFilename(filePath);
        if (!parsed) return;
        const paths = index.get(parsed.rolloutId) || [];
        paths.push(filePath);
        index.set(parsed.rolloutId, paths);
    };
    const visit = (directory: string) => {
        throwIfCodexReadCancelled(isCancelled);
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            throwIfCodexReadCancelled(isCancelled);
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile()) add(child);
        }
    };
    for (const root of roots) visit(root);
    return index;
}

export async function indexCodexHistorySourcePaths(roots: string[], isCancelled?: () => boolean): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    const add = (filePath: string) => {
        const parsed = parseCodexRolloutFilename(filePath);
        if (!parsed) return;
        const paths = index.get(parsed.rolloutId) || [];
        paths.push(filePath);
        index.set(parsed.rolloutId, paths);
    };
    const visit = async (directory: string): Promise<void> => {
        throwIfCodexReadCancelled(isCancelled);
        let entries: fs.Dirent[];
        try { entries = await fsPromises.readdir(directory, { withFileTypes: true }); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            throwIfCodexReadCancelled(isCancelled);
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(child);
            else if (entry.isFile()) add(child);
        }
    };
    for (const root of roots) await visit(root);
    return index;
}

const indexRoots = indexCodexHistorySourcePaths;

function uniqueRoots(rolloutPath: string, roots?: string[]): string[] {
    const selectedRoots = roots === undefined ? [...defaultRoots(), path.dirname(rolloutPath)] : roots;
    const normalized = [...new Map(selectedRoots.map(root => {
        const absolute = normalizeCodexHistoryPath(root);
        return [process.platform === "win32" ? absolute.toLowerCase() : absolute, absolute];
    })).values()];
    return normalized.filter(root => !normalized.some(parent => {
        if (root === parent) return false;
        const relative = path.relative(parent, root);
        return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }));
}

function loadSync(filePath: string, options?: CodexHistoryArchiveOptions): LoadedRollout {
    if (/\.jsonl\.zst$/i.test(filePath)) {
        const archive = materializeCodexHistoryArchiveSync(filePath, options);
        return { path: filePath, readPath: archive.viewPath, archive, size: archive.logicalSize, mtimeMs: archive.sourceMtimeMs, header: parseHeader(filePath, readFirstLineSync(archive.viewPath)) };
    }
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error(`Codex rollout source is not a file: ${filePath}`);
    return { path: filePath, readPath: filePath, size: stats.size, mtimeMs: stats.mtimeMs, header: parseHeader(filePath, readFirstLineSync(filePath)) };
}

async function load(filePath: string, options?: CodexHistoryArchiveOptions): Promise<LoadedRollout> {
    if (/\.jsonl\.zst$/i.test(filePath)) {
        const archive = await materializeCodexHistoryArchive(filePath, options);
        return { path: filePath, readPath: archive.viewPath, archive, size: archive.logicalSize, mtimeMs: archive.sourceMtimeMs, header: parseHeader(filePath, await readFirstLine(archive.viewPath)) };
    }
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile()) throw new Error(`Codex rollout source is not a file: ${filePath}`);
    return { path: filePath, readPath: filePath, size: stats.size, mtimeMs: stats.mtimeMs, physical: codexHistoryPhysicalIdentity(stats), header: parseHeader(filePath, await readFirstLine(filePath)) };
}

function assertReplicaPair(matches: string[]): void {
    if (matches.length === 1) return;
    if (matches.length !== 2 || matches.filter(file => /\.zst$/i.test(file)).length !== 1) throw new Error(`Ambiguous Codex history_base rollout: ${matches.join(", ")}`);
}

function selectRolloutSync(matches: string[], options?: CodexHistoryArchiveOptions, preferred?: string): LoadedRollout {
    assertReplicaPair(matches);
    const ordered = [...matches].sort((left, right) => preferred ? Number(right === preferred) - Number(left === preferred) : Number(/\.zst$/i.test(left)) - Number(/\.zst$/i.test(right)) || left.localeCompare(right));
    const selected = loadSync(ordered[0]!, options);
    if (ordered.length === 1) return selected;
    const replica = loadSync(ordered[1]!, options);
    const selectedHash = hashCodexPrefixSync(selected.readPath, selected.size);
    const replicaHash = hashCodexPrefixSync(replica.readPath, replica.size);
    if (selected.size !== replica.size || selectedHash !== replicaHash || selected.header.identity.threadId !== replica.header.identity.threadId) throw new CodexHistorySourceMismatchError("Conflicting plaintext/compressed Codex history replicas");
    selected.replicas = [{ path: replica.path, size: replica.size, sha256: replicaHash, ...(replica.archive ? { archive: replica.archive } : {}) }];
    return selected;
}

async function selectRollout(matches: string[], options?: CodexHistoryArchiveOptions, preferred?: string): Promise<LoadedRollout> {
    assertReplicaPair(matches);
    const ordered = [...matches].sort((left, right) => preferred ? Number(right === preferred) - Number(left === preferred) : Number(/\.zst$/i.test(left)) - Number(/\.zst$/i.test(right)) || left.localeCompare(right));
    const selected = await load(ordered[0]!, options);
    if (ordered.length === 1) return selected;
    const replica = await load(ordered[1]!, options);
    const selectedHash = await hashCodexPrefix(selected.readPath, selected.size, options?.isCancelled);
    const replicaHash = await hashCodexPrefix(replica.readPath, replica.size, options?.isCancelled);
    if (selected.size !== replica.size || selectedHash !== replicaHash || selected.header.identity.threadId !== replica.header.identity.threadId) throw new CodexHistorySourceMismatchError("Conflicting plaintext/compressed Codex history replicas");
    selected.replicas = [{ path: replica.path, size: replica.size, sha256: replicaHash, ...(replica.archive ? { archive: replica.archive } : {}) }];
    return selected;
}

function segmentForSync(rollout: LoadedRollout, startOrdinal: number, endOrdinalExclusive: number | undefined, endByte: number, allowUnterminatedLeaf = false): CodexHistorySegment {
    if (endByte > rollout.size) throw new Error(`Codex history byte boundary exceeds source size: ${rollout.path}`);
    const anchor = readAnchorSync(rollout.readPath, endByte);
    const unterminatedLeaf = allowUnterminatedLeaf && endByte === rollout.size && endByte > 0 && anchor.value.at(-1) !== 0x0a;
    if (!unterminatedLeaf) assertLineBoundarySync(rollout.readPath, endByte, rollout.size);
    return {
        path: rollout.path,
        ...(rollout.archive ? { readPath: rollout.readPath, archive: rollout.archive } : {}),
        ...(rollout.replicas ? { replicas: rollout.replicas } : {}),
        rolloutId: rollout.header.identity.rolloutId,
        threadId: rollout.header.identity.threadId,
        startOrdinal,
        ...(endOrdinalExclusive === undefined ? {} : { endOrdinalExclusive }),
        endByte,
        size: rollout.size,
        mtimeMs: rollout.mtimeMs,
        headerSha256: sha256(rollout.header.header),
        anchorStartByte: anchor.start,
        anchorSha256: sha256(anchor.value),
        prefixSha256: hashCodexPrefixSync(rollout.readPath, endByte, { headerSha256: sha256(rollout.header.header), anchorStartByte: anchor.start, anchorSha256: sha256(anchor.value), unterminatedLeaf }),
        ordinalMode: rollout.header.ordinalMode,
        ...(unterminatedLeaf ? { unterminatedLeaf: true } : {}),
    };
}

async function segmentFor(rollout: LoadedRollout, startOrdinal: number, endOrdinalExclusive: number | undefined, endByte: number, allowUnterminatedLeaf = false, isCancelled?: () => boolean, metadataOnly = false): Promise<CodexHistorySegment> {
    if (endByte > rollout.size) throw new Error(`Codex history byte boundary exceeds source size: ${rollout.path}`);
    const anchor = await readAnchor(rollout.readPath, endByte);
    const unterminatedLeaf = allowUnterminatedLeaf && endByte === rollout.size && endByte > 0 && anchor.value.at(-1) !== 0x0a;
    if (!unterminatedLeaf) await assertLineBoundary(rollout.readPath, endByte, rollout.size);
    return {
        path: rollout.path,
        ...(rollout.archive ? { readPath: rollout.readPath, archive: rollout.archive } : {}),
        ...(rollout.replicas ? { replicas: rollout.replicas } : {}),
        rolloutId: rollout.header.identity.rolloutId,
        threadId: rollout.header.identity.threadId,
        startOrdinal,
        ...(endOrdinalExclusive === undefined ? {} : { endOrdinalExclusive }),
        endByte,
        size: rollout.size,
        mtimeMs: rollout.mtimeMs,
        headerSha256: sha256(rollout.header.header),
        anchorStartByte: anchor.start,
        anchorSha256: sha256(anchor.value),
        ...(metadataOnly ? {} : { prefixSha256: await hashCodexPrefix(rollout.readPath, endByte, isCancelled, { headerSha256: sha256(rollout.header.header), anchorStartByte: anchor.start, anchorSha256: sha256(anchor.value), unterminatedLeaf }) }),
        ordinalMode: rollout.header.ordinalMode,
        ...(unterminatedLeaf ? { unterminatedLeaf: true } : {}),
    };
}

function buildRevision(leafPath: string, segments: CodexHistorySegment[]): string {
    const leaf = segments[segments.length - 1]!;
    const manifest = {
        version: 1,
        leafPath,
        leafSize: leaf.size,
        leafMtimeMs: leaf.mtimeMs,
        segments: segments.map(segment => ({
            path: segment.path,
            ...(segment.archive ? { archive: archiveIdentity(segment.archive) } : {}),
            ...(segment.replicas ? { replicas: segment.replicas.map(replica => ({ path: replica.path, size: replica.size, sha256: replica.sha256, ...(replica.archive ? { archive: archiveIdentity(replica.archive) } : {}) })) } : {}),
            rolloutId: segment.rolloutId,
            threadId: segment.threadId,
            startOrdinal: segment.startOrdinal,
            endOrdinalExclusive: segment.endOrdinalExclusive ?? null,
            endByte: segment.endByte,
            headerSha256: segment.headerSha256,
            anchorStartByte: segment.anchorStartByte,
            anchorSha256: segment.anchorSha256,
            prefixSha256: segment.prefixSha256,
            ordinalMode: segment.ordinalMode,
            unterminatedLeaf: segment.unterminatedLeaf || false,
        })),
    };
    return sha256(JSON.stringify(manifest));
}

function archiveIdentity(archive: CodexHistoryArchiveView) {
    return { format: archive.format, sourcePath: archive.sourcePath, sourceSize: archive.sourceSize, sourceSha256: archive.sourceSha256, logicalSize: archive.logicalSize, logicalSha256: archive.logicalSha256 };
}

function sourceFromSegments(leafPath: string, segments: CodexHistorySegment[]): CodexHistorySource {
    return {
        version: 1,
        leafPath,
        segments,
        revision: buildRevision(leafPath, segments),
        totalBytes: segments.reduce((total, segment) => total + segment.endByte, 0),
    };
}

export function resolveCodexHistorySource(rolloutPath: string, options: { roots?: string[]; endByte?: number; archive?: CodexHistoryArchiveOptions } = {}): CodexHistorySource {
    throwIfCodexReadCancelled(options.archive?.isCancelled);
    const requestedPath = normalizeCodexHistoryPath(rolloutPath);
    let index: Map<string, string[]> | undefined;
    const seen = new Set<string>();
    const reverseSegments: CodexHistorySegment[] = [];
    let current = selectRolloutSync(existingHistoryFiles(requestedPath), options.archive, requestedPath);
    const leafPath = current.path;
    let currentEndByte = options.endByte === undefined ? lastCompleteLineEndSync(current.readPath, current.size) : finiteInteger(options.endByte, "endByte");
    let currentEndOrdinal: number | undefined;
    while (true) {
        const currentKey = current.header.identity.rolloutId;
        if (seen.has(currentKey)) throw new Error(`Circular Codex history_base reference for rollout: ${currentKey}`);
        seen.add(currentKey);
        const startOrdinal = current.header.historyBase?.endOrdinalExclusive || 0;
        reverseSegments.push(segmentForSync(current, startOrdinal, currentEndOrdinal, currentEndByte, reverseSegments.length === 0 && options.endByte === undefined));
        const base = current.header.historyBase;
        if (!base || base.endByte === 0) break;
        index ??= indexRootsSync(uniqueRoots(leafPath, options.roots), options.archive?.isCancelled);
        const matches = [...new Set(index.get(base.rolloutId) || [])];
        if (matches.length === 0) throw new Error(`Missing Codex history_base rollout: ${base.rolloutId}`);
        current = selectRolloutSync(matches, options.archive);
        currentEndByte = base.endByte;
        currentEndOrdinal = base.endOrdinalExclusive;
    }
    return sourceFromSegments(leafPath, reverseSegments.reverse());
}

export async function resolveCodexHistorySourceAsync(rolloutPath: string, options: { roots?: string[]; endByte?: number; isCancelled?: () => boolean; metadataOnly?: boolean; archive?: CodexHistoryArchiveOptions } = {}): Promise<CodexHistorySource> {
    throwIfCodexReadCancelled(options.isCancelled ?? options.archive?.isCancelled);
    const requestedPath = normalizeCodexHistoryPath(rolloutPath);
    let index: Map<string, string[]> | undefined;
    const seen = new Set<string>();
    const reverseSegments: CodexHistorySegment[] = [];
    const validatedIdentities: Array<{ path: string; identity: string }> = [];
    const archiveOptions = { ...options.archive, isCancelled: options.isCancelled ?? options.archive?.isCancelled };
    let current = await selectRollout(await existingHistoryFilesAsync(requestedPath), archiveOptions, requestedPath);
    const leafPath = current.path;
    let currentEndByte = options.endByte === undefined ? await lastCompleteLineEnd(current.readPath, current.size) : finiteInteger(options.endByte, "endByte");
    let currentEndOrdinal: number | undefined;
    while (true) {
        throwIfCodexReadCancelled(options.isCancelled);
        const currentKey = current.header.identity.rolloutId;
        if (seen.has(currentKey)) throw new Error(`Circular Codex history_base reference for rollout: ${currentKey}`);
        seen.add(currentKey);
        const startOrdinal = current.header.historyBase?.endOrdinalExclusive || 0;
        const proofSource = { segments: [{ path: current.path, readPath: current.readPath, replicas: current.replicas }] };
        const before = options.metadataOnly ? [] : await historyValidationIdentities(proofSource);
        if (current.physical) {
            const original = before.find(entry => entry.path === current.path);
            if (original) original.identity = JSON.stringify(current.physical);
        }
        reverseSegments.push(await segmentFor(current, startOrdinal, currentEndOrdinal, currentEndByte, reverseSegments.length === 0 && options.endByte === undefined, options.isCancelled, options.metadataOnly));
        if (!options.metadataOnly) {
            const after = await historyValidationIdentities(proofSource);
            if (JSON.stringify(before) !== JSON.stringify(after) && !(reverseSegments.length === 1 && pinnedLeafAppend(current, before, after))) throw new CodexHistorySourceMismatchError("Codex history changed during source capture");
            validatedIdentities.push(...before);
        }
        const base = current.header.historyBase;
        if (!base || base.endByte === 0) break;
        index ??= await indexRoots(uniqueRoots(leafPath, options.roots), archiveOptions.isCancelled);
        const matches = [...new Set(index.get(base.rolloutId) || [])];
        if (matches.length === 0) throw new Error(`Missing Codex history_base rollout: ${base.rolloutId}`);
        current = await selectRollout(matches, archiveOptions);
        currentEndByte = base.endByte;
        currentEndOrdinal = base.endOrdinalExclusive;
    }
    const source = sourceFromSegments(leafPath, reverseSegments.reverse());
    if (!options.metadataOnly) await verifyCapturedHistorySource(source, validatedIdentities, archiveOptions.isCancelled);
    return source;
}

function pinnedLeafAppend(leaf: Pick<CodexHistorySegment, "path" | "archive" | "replicas">, before: Array<{ path: string; identity: string }>, after: Array<{ path: string; identity: string }>): boolean {
    if (leaf.archive || leaf.replicas?.length || before.length !== after.length) return false;
    const beforeLeaf = before.find(entry => entry.path === leaf.path);
    const afterLeaf = after.find(entry => entry.path === leaf.path);
    return Boolean(beforeLeaf && afterLeaf && before.every(entry => entry.path === leaf.path || after.some(current => current.path === entry.path && current.identity === entry.identity)) && plainAppend(JSON.parse(beforeLeaf.identity), JSON.parse(afterLeaf.identity)));
}

async function verifyCapturedHistorySource(source: CodexHistorySource, identities: Array<{ path: string; identity: string }>, isCancelled?: () => boolean): Promise<void> {
    let before = [...new Map(identities.map(entry => [entry.path, entry])).values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const leaf = source.segments.at(-1)!;
    for (let attempt = 0; ; attempt += 1) {
        throwIfCodexReadCancelled(isCancelled);
        const after = await historyValidationIdentities(source);
        if (JSON.stringify(before) === JSON.stringify(after)) {
            throwIfCodexReadCancelled(isCancelled);
            verifiedHistorySources.set(source, { revision: source.revision, identities: after });
            locateVerifiedHistorySources.delete(source.leafPath);
            locateVerifiedHistorySources.set(source.leafPath, source);
            while (locateVerifiedHistorySources.size > 32) locateVerifiedHistorySources.delete(locateVerifiedHistorySources.keys().next().value!);
            return;
        }
        if (attempt >= 2 || !pinnedLeafAppend(leaf, before, after)) throw new CodexHistorySourceMismatchError("Codex history changed during source capture");
        if (await hashCodexPrefix(codexHistorySegmentReadPath(leaf), leaf.endByte, isCancelled, leaf) !== leaf.prefixSha256) throw new CodexHistorySourceMismatchError(`Codex history source content changed during source capture: ${leaf.path}`);
        before = after;
    }
}

export function assertCodexHistoryManifest(source: CodexHistorySource): void {
    if (source.version !== 1 || !path.isAbsolute(source.leafPath) || source.segments.length === 0) {
        throw new Error("Invalid Codex history source shape");
    }
    for (const segment of source.segments) {
        codexHistorySegmentReadPath(segment);
        if (!segment.prefixSha256 || !/^[a-f0-9]{64}$/u.test(segment.prefixSha256) || (segment.ordinalMode !== "legacy" && segment.ordinalMode !== "explicit")) {
            throw new CodexHistorySourceMismatchError("Codex history source requires a content-verified cache rebuild");
        }
        finiteInteger(segment.endByte, "segment.endByte");
        finiteInteger(segment.startOrdinal, "segment.startOrdinal");
        if (segment.endOrdinalExclusive !== undefined) finiteInteger(segment.endOrdinalExclusive, "segment.endOrdinalExclusive");
    }
    if (source.segments.reduce((sum, segment) => sum + segment.endByte, 0) !== source.totalBytes || buildRevision(source.leafPath, source.segments) !== source.revision) {
        throw new CodexHistorySourceMismatchError("Codex history source manifest changed");
    }
}

export function assertCodexHistorySource(source: CodexHistorySource): void {
    assertCodexHistoryManifest(source);
    for (const segment of source.segments) {
        const loaded = loadSync(segment.path, archiveOptionsForSegment(segment));
        assertArchiveIdentity(segment.archive, loaded.archive);
        const readPath = loaded.readPath;
        const stats = fs.statSync(readPath);
        if (!stats.isFile() || stats.size < segment.endByte) throw new CodexHistorySourceMismatchError(`Codex history source is shorter or unavailable: ${segment.path}`);
        const header = loaded.header;
        if (header.identity.rolloutId !== segment.rolloutId || header.identity.threadId !== segment.threadId || sha256(header.header) !== segment.headerSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source header changed: ${segment.path}`);
        }
        if (segment.unterminatedLeaf) {
            if (segment !== source.segments.at(-1) || segment.endOrdinalExclusive !== undefined || segment.endByte !== segment.size) {
                throw new Error("Invalid unterminated Codex leaf boundary");
            }
        } else {
            assertLineBoundarySync(readPath, segment.endByte, stats.size);
        }
        const anchor = readAnchorSync(readPath, segment.endByte);
        if (anchor.start !== segment.anchorStartByte || sha256(anchor.value) !== segment.anchorSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source boundary changed: ${segment.path}`);
        }
        if (hashCodexPrefixSync(readPath, segment.endByte, segment) !== segment.prefixSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source content changed: ${segment.path}`);
        }
        for (const replica of segment.replicas ?? []) {
            const current = loadSync(replica.path, archiveOptionsForSegment({ archive: replica.archive }));
            assertArchiveIdentity(replica.archive, current.archive);
            if (current.size !== replica.size || hashCodexPrefixSync(current.readPath, current.size) !== replica.sha256) throw new CodexHistorySourceMismatchError("Codex history replica changed");
        }
    }
}

export async function assertCodexHistorySourceAsync(source: CodexHistorySource, isCancelled?: () => boolean): Promise<void> {
    return assertCodexHistorySourceAttempt(source, isCancelled, 0);
}

async function assertCodexHistorySourceAttempt(source: CodexHistorySource, isCancelled: (() => boolean) | undefined, attempt: number): Promise<void> {
    assertCodexHistoryManifest(source);
    throwIfCodexReadCancelled(isCancelled);
    const identities = await historyValidationIdentities(source).catch(() => undefined);
    throwIfCodexReadCancelled(isCancelled);
    const previous = verifiedHistorySources.get(source);
    if (identities && previous?.revision === source.revision && JSON.stringify(previous.identities) === JSON.stringify(identities)) return;
    for (const segment of source.segments) {
        throwIfCodexReadCancelled(isCancelled);
        const loaded = await load(segment.path, { ...archiveOptionsForSegment(segment), isCancelled });
        assertArchiveIdentity(segment.archive, loaded.archive);
        const readPath = loaded.readPath;
        const stats = await fsPromises.stat(readPath);
        if (!stats.isFile() || stats.size < segment.endByte) throw new CodexHistorySourceMismatchError(`Codex history source is shorter or unavailable: ${segment.path}`);
        if (segment.endByte === 0) {
            const header = loaded.header;
            if (sha256(header.header) !== segment.headerSha256) throw new CodexHistorySourceMismatchError(`Codex history source header changed: ${segment.path}`);
        }
        if (segment.unterminatedLeaf) {
            if (segment !== source.segments.at(-1) || segment.endOrdinalExclusive !== undefined || segment.endByte !== segment.size) throw new Error("Invalid unterminated Codex leaf boundary");
        } else {
            await assertLineBoundary(readPath, segment.endByte, stats.size);
        }
        if (await hashCodexPrefix(readPath, segment.endByte, isCancelled, segment) !== segment.prefixSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source content changed: ${segment.path}`);
        }
        for (const replica of segment.replicas ?? []) {
            const current = await load(replica.path, { ...archiveOptionsForSegment({ archive: replica.archive }), isCancelled });
            assertArchiveIdentity(replica.archive, current.archive);
            if (current.size !== replica.size || await hashCodexPrefix(current.readPath, current.size, isCancelled) !== replica.sha256) throw new CodexHistorySourceMismatchError("Codex history replica changed");
        }
    }
    const after = await historyValidationIdentities(source).catch(() => undefined);
    if (identities && after && JSON.stringify(identities) !== JSON.stringify(after)) {
        const leaf = source.segments.at(-1)!;
        if (attempt < 2 && pinnedLeafAppend(leaf, identities, after)) {
            return assertCodexHistorySourceAttempt(source, isCancelled, attempt + 1);
        }
        throw new CodexHistorySourceMismatchError("Codex history changed during source validation");
    }
    throwIfCodexReadCancelled(isCancelled);
    if (after) verifiedHistorySources.set(source, { revision: source.revision, identities: after });
}

function archiveOptionsForSegment(segment: { archive?: CodexHistoryArchiveView }): CodexHistoryArchiveOptions | undefined {
    if (!segment.archive) return undefined;
    return { cacheRoot: path.dirname(path.dirname(path.dirname(segment.archive.viewPath))), ownerId: segment.archive.ownerId };
}

function assertArchiveIdentity(expected?: CodexHistoryArchiveView, actual?: CodexHistoryArchiveView): void {
    if (JSON.stringify(expected && archiveIdentity(expected)) !== JSON.stringify(actual && archiveIdentity(actual))) throw new CodexHistorySourceMismatchError("Codex history physical archive changed");
}

export interface CodexHistoryPhysicalIdentity {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    ino: number;
    dev: number;
}

export interface CodexStreamingHistorySegment {
    path: string;
    replicas: string[];
    rolloutId: string;
    threadId: string;
    startOrdinal: number;
    endOrdinalExclusive?: number;
    endByte?: number;
    headerSha256: string;
    ordinalMode: CodexOrdinalMode;
    physical: CodexHistoryPhysicalIdentity;
}

export interface CodexStreamingHistorySource {
    leafPath: string;
    segments: CodexStreamingHistorySegment[];
    unverifiedHistoryBase?: HistoryBase;
    sourceRangeVerified?: boolean;
}

export interface CodexStreamingHistoryPosition {
    path: string;
    startByte: number;
    endByte: number;
    ordinal: number;
}

export interface CodexStreamingHistoryVerification {
    revision: string;
    sourceBytes: number;
    segments: Array<CodexStreamingHistorySegment & {
        endByte: number;
        prefixSha256: string;
        physicalSha256?: string;
        adoptedPrefixCache?: { generation: string; sourceRevision: string };
        nextOrdinal: number;
        replicaIdentities: Array<{ path: string; physical: CodexHistoryPhysicalIdentity; sha256: string }>;
    }>;
}

export interface CodexStreamingPrefixProof {
    path: string;
    endByte: number;
    sha256: string;
    replicasVerified?: boolean;
}

function plainAppend(before: CodexHistoryPhysicalIdentity, after: CodexHistoryPhysicalIdentity): boolean {
    return after.size > before.size && after.dev === before.dev && after.ino === before.ino && after.birthtimeMs === before.birthtimeMs;
}

export async function assertCodexStreamingRangeSource(source: CodexStreamingHistorySource, proofs: CodexStreamingPrefixProof[], isCancelled?: () => boolean, archive: CodexHistoryArchiveOptions = {}): Promise<void> {
    for (const segment of source.segments) {
        throwIfCodexReadCancelled(isCancelled);
        const expected = [segment.path, ...segment.replicas].map(candidate => path.resolve(candidate).toLowerCase()).sort();
        const currentPaths = [...new Set((await Promise.all([segment.path, ...segment.replicas].map(existingHistoryFilesAsync))).flat().map(candidate => path.resolve(candidate).toLowerCase()))].sort();
        if (JSON.stringify(expected) !== JSON.stringify(currentPaths)) throw new CodexHistorySourceMismatchError("Codex history replica set changed during fast range read");
        const current = codexHistoryPhysicalIdentity(await fsPromises.stat(segment.path));
        const proof = proofs.find(candidate => candidate.path === segment.path);
        if (JSON.stringify(current) !== JSON.stringify(segment.physical)) {
            if (/\.zst$/iu.test(segment.path) || !plainAppend(segment.physical, current) || sha256(await readFirstLine(segment.path)) !== segment.headerSha256) throw new CodexHistorySourceMismatchError("Codex history changed during fast range read");
            if (proof && await hashCodexPrefix(segment.path, proof.endByte, isCancelled) !== proof.sha256) throw new CodexHistorySourceMismatchError("Codex history prefix changed during fast range read");
            const after = codexHistoryPhysicalIdentity(await fsPromises.stat(segment.path));
            if (JSON.stringify(current) !== JSON.stringify(after) && !plainAppend(current, after)) throw new CodexHistorySourceMismatchError("Codex history changed during range prefix verification");
        }
        if (!proof || proof.replicasVerified) continue;
        for (const replica of segment.replicas) {
            const before = codexHistoryPhysicalIdentity(await fsPromises.stat(replica));
            const hash = crypto.createHash("sha256");
            let bytes = 0;
            for await (const chunk of streamingHistoryBytes(replica, before, { ...archive, isCancelled: () => Boolean(isCancelled?.() || archive.isCancelled?.()), plainEndByte: proof.endByte })) {
                const selected = chunk.subarray(0, proof.endByte - bytes);
                hash.update(selected);
                bytes += selected.length;
                if (bytes === proof.endByte) break;
            }
            if (bytes !== proof.endByte || hash.digest("hex") !== proof.sha256 || JSON.stringify(before) !== JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(replica)))) throw new CodexHistorySourceMismatchError("Conflicting plaintext/compressed Codex history replicas in requested range");
        }
    }
}

export async function assertCodexStreamingHistoryVerification(verification: CodexStreamingHistoryVerification, conversationId: string, isCancelled?: () => boolean, archive: CodexHistoryArchiveOptions = {}, startingOrdinal = 0): Promise<void> {
    if (!verification.segments.length || verification.segments.at(-1)!.threadId !== conversationId || verification.revision !== sha256(JSON.stringify(verification.segments))) throw new CodexHistorySourceMismatchError("Codex pinned history verification is invalid");
    let nextOrdinal = startingOrdinal;
    for (const segment of verification.segments) {
        throwIfCodexReadCancelled(isCancelled);
        const identity = parseCodexRolloutFilename(segment.path);
        if (!identity || identity.threadId !== segment.threadId || identity.rolloutId !== segment.rolloutId
            || segment.startOrdinal !== nextOrdinal || !Number.isSafeInteger(segment.nextOrdinal) || segment.nextOrdinal <= segment.startOrdinal
            || segment.endOrdinalExclusive !== undefined && segment.endOrdinalExclusive !== segment.nextOrdinal
            || !Number.isSafeInteger(segment.endByte) || segment.endByte < 1 || !/^[a-f0-9]{64}$/u.test(segment.prefixSha256)
            || !/^[a-f0-9]{64}$/u.test(segment.headerSha256)) throw new CodexHistorySourceMismatchError("Codex pinned history identity or ordinal coverage is invalid");
        nextOrdinal = segment.nextOrdinal;
        for (const replica of segment.replicaIdentities) {
            if (JSON.stringify(replica.physical) !== JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(replica.path)))) throw new CodexHistorySourceMismatchError("Codex pinned history replica changed");
        }
    }
    await assertCodexStreamingRangeSource({ leafPath: verification.segments.at(-1)!.path, segments: verification.segments },
        verification.segments.map(segment => ({ path: segment.path, endByte: segment.endByte, sha256: segment.prefixSha256, replicasVerified: true })), isCancelled, archive);
}

export function codexHistoryPhysicalIdentity(stats: fs.Stats): CodexHistoryPhysicalIdentity {
    if (!stats.isFile()) throw new CodexHistorySourceMismatchError("Codex history requires a regular file");
    return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, birthtimeMs: stats.birthtimeMs, ino: stats.ino, dev: stats.dev };
}

async function* streamingHistoryBytes(filePath: string, physical: CodexHistoryPhysicalIdentity, options: CodexHistoryArchiveOptions & { onComplete?: (identity: CodexHistoryArchiveStreamIdentity) => void; plainEndByte?: number }): AsyncGenerator<Buffer> {
    if (/\.zst$/iu.test(filePath)) {
        yield* streamCodexHistoryArchive(filePath, { ...options, calculateLogicalSha256: false });
        return;
    }
    const endByte = Math.min(physical.size, options.plainEndByte ?? physical.size);
    if (endByte === 0) return;
    const input = fs.createReadStream(filePath, { start: 0, end: endByte - 1, highWaterMark: 1024 * 1024 });
    try {
        for await (const chunk of input) {
            throwIfCodexReadCancelled(options.isCancelled);
            yield chunk as Buffer;
        }
    } finally { input.destroy(); }
}

async function streamingHeader(filePath: string, options: CodexHistoryArchiveOptions): Promise<{ header: RolloutHeader; physical: CodexHistoryPhysicalIdentity }> {
    options = { ...options, streamChunkBytes: 64 * 1024 };
    throwIfCodexReadCancelled(options.isCancelled);
    const physical = codexHistoryPhysicalIdentity(await fsPromises.stat(filePath));
    const cacheKey = `${filePath}\0${JSON.stringify(resolveCodexHistoryArchiveStreamLimits(options))}\0${options.decoder ?? "auto"}`;
    const previous = streamingHeaderCache.get(cacheKey);
    if (previous && JSON.stringify(previous.physical) === JSON.stringify(physical)) return previous;
    if (previous) { streamingHeaderCacheBytes -= previous.header.header.length; streamingHeaderCache.delete(cacheKey); }
    const remember = async (header: RolloutHeader) => {
        throwIfCodexReadCancelled(options.isCancelled);
        if (JSON.stringify(physical) !== JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(filePath)))) throw new CodexHistorySourceMismatchError("Codex history changed while reading its session header");
        const entry = { header, physical };
        if (header.header.length <= 1024 * 1024) {
            while (streamingHeaderCacheBytes + header.header.length > 8 * 1024 * 1024 || streamingHeaderCache.size >= 128) {
                const oldest = streamingHeaderCache.entries().next().value;
                if (!oldest) break;
                streamingHeaderCacheBytes -= oldest[1].header.header.length;
                streamingHeaderCache.delete(oldest[0]);
            }
            streamingHeaderCache.set(cacheKey, entry);
            streamingHeaderCacheBytes += header.header.length;
        }
        return entry;
    };
    if (!/\.zst$/iu.test(filePath)) return remember(parseHeader(filePath, await readFirstLine(filePath)));
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of streamingHistoryBytes(filePath, physical, options)) {
        const newline = chunk.indexOf(0x0a);
        const selected = newline < 0 ? chunk : chunk.subarray(0, newline);
        chunks.push(selected);
        bytes += selected.length;
        if (bytes > MAX_HEADER_BYTES) throw new Error("Codex session header exceeds the safe read limit");
        if (newline >= 0) return remember(parseHeader(filePath, Buffer.concat(chunks)));
    }
    throw new Error("Codex compressed history has no complete session header");
}

export async function readCodexStreamingSessionMeta(filePath: string, options: CodexHistoryArchiveOptions = {}): Promise<Record<string, unknown>> {
    const sourcePath = await resolveCodexHistoryFilePathAsync(filePath);
    const { header } = await streamingHeader(sourcePath, options);
    return JSON.parse(header.header.toString("utf8").replace(/^\uFEFF/u, "")).payload;
}

export async function resolveCodexStreamingHistorySource(
    rolloutPath: string,
    options: { roots?: string[]; pathsByRolloutId?: Map<string, string[]>; archive?: CodexHistoryArchiveOptions; isCancelled?: () => boolean; deferAncestors?: boolean } = {},
): Promise<CodexStreamingHistorySource> {
    const archive = { ...options.archive, isCancelled: options.isCancelled ?? options.archive?.isCancelled };
    const requestedPath = normalizeCodexHistoryPath(rolloutPath);
    let index = options.pathsByRolloutId ?? await indexRoots(uniqueRoots(requestedPath, options.roots), archive.isCancelled);
    const requestedIdentity = parseCodexRolloutFilename(requestedPath);
    let matches = [...new Set([...await existingHistoryFilesAsync(requestedPath), ...(requestedIdentity ? index.get(requestedIdentity.rolloutId) || [] : [])])];
    const seen = new Set<string>();
    const reverse: CodexStreamingHistorySegment[] = [];
    let endByte: number | undefined;
    let endOrdinalExclusive: number | undefined;
    let leafPath = "";
    for (;;) {
        throwIfCodexReadCancelled(archive.isCancelled);
        const currentMatches = await Promise.all(matches.map(async candidate => {
            try { return await existingHistoryFilesAsync(candidate); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
        }));
        matches = [...new Set(currentMatches.flat())];
        assertReplicaPair(matches);
        const selectedPath = matches.includes(requestedPath) ? requestedPath : [...matches].sort((left, right) => Number(/\.zst$/iu.test(left)) - Number(/\.zst$/iu.test(right)) || left.localeCompare(right))[0]!;
        const { header, physical } = await streamingHeader(selectedPath, archive);
        if (!leafPath) leafPath = selectedPath;
        if (seen.has(header.identity.rolloutId)) throw new Error("Circular Codex history_base reference");
        seen.add(header.identity.rolloutId);
        reverse.push({ path: selectedPath, replicas: matches.filter(candidate => candidate !== selectedPath), ...header.identity, startOrdinal: header.historyBase?.endOrdinalExclusive || 0, endOrdinalExclusive, endByte, headerSha256: sha256(header.header), ordinalMode: header.ordinalMode, physical });
        const base = header.historyBase;
        if (!base || base.endByte === 0) break;
        if (seen.has(base.rolloutId)) throw new Error("Circular Codex history_base reference");
        if (options.deferAncestors && reverse.length === 1 && header.ordinalMode === "explicit" && !/\.zst$/iu.test(selectedPath)) {
            return { leafPath, segments: reverse, unverifiedHistoryBase: base, sourceRangeVerified: false };
        }
        index ??= await indexRoots(uniqueRoots(leafPath, options.roots), archive.isCancelled);
        matches = [...new Set(index.get(base.rolloutId) || [])];
        if (!matches.length && options.pathsByRolloutId) {
            index = await indexRoots(uniqueRoots(leafPath, options.roots), archive.isCancelled);
            for (const [rolloutId, paths] of index) options.pathsByRolloutId.set(rolloutId, paths);
            matches = [...new Set(index.get(base.rolloutId) || [])];
        }
        if (!matches.length) throw new Error(`Missing Codex history_base rollout: ${base.rolloutId}`);
        endByte = base.endByte;
        endOrdinalExclusive = base.endOrdinalExclusive;
    }
    return { leafPath, segments: reverse.reverse() };
}

type CodexStreamingScanOptions = { archive?: CodexHistoryArchiveOptions; isCancelled?: () => boolean; onProgress?: (bytes: number) => void; replayFrom?: CodexStreamingHistoryPosition; previousVerification?: CodexStreamingHistoryVerification; onPrefixProof?: (proof: CodexStreamingPrefixProof) => void };

export interface CodexStreamingReadableVerification extends CodexStreamingHistoryVerification {
    readableRangeVerified: true;
    fullSourceComplete: boolean;
}

export async function scanCodexStreamingHistory(
    source: CodexStreamingHistorySource,
    onEvent: (event: any, position: CodexStreamingHistoryPosition) => void | Promise<void>,
    options: CodexStreamingScanOptions = {},
): Promise<CodexStreamingHistoryVerification> {
    if (source.unverifiedHistoryBase !== undefined || source.sourceRangeVerified === false) throw new CodexHistorySourceMismatchError("Full Codex history scan requires verified ancestry");
    return scanCodexStreamingSegments(source, onEvent, options);
}

export async function scanCodexStreamingReadableRange(
    source: CodexStreamingHistorySource,
    onEvent: (event: any, position: CodexStreamingHistoryPosition) => void | Promise<void>,
    options: Pick<CodexStreamingScanOptions, "archive" | "isCancelled" | "onProgress" | "onPrefixProof"> = {},
): Promise<CodexStreamingReadableVerification> {
    if (!source.segments.length) throw new CodexHistorySourceMismatchError("Codex readable range requires a source segment");
    if (source.unverifiedHistoryBase && (source.segments.length !== 1 || source.segments[0]!.ordinalMode !== "explicit")) throw new CodexHistorySourceMismatchError("Codex readable range requires an explicit local ordinal window");
    const verification = await scanCodexStreamingSegments(source, onEvent, options, source.segments[0]!.startOrdinal);
    return { ...verification, readableRangeVerified: true, fullSourceComplete: source.segments[0]!.startOrdinal === 0 && source.unverifiedHistoryBase === undefined && source.sourceRangeVerified !== false };
}

async function scanCodexStreamingSegments(
    source: CodexStreamingHistorySource,
    onEvent: (event: any, position: CodexStreamingHistoryPosition) => void | Promise<void>,
    options: CodexStreamingScanOptions,
    firstOrdinal = 0,
): Promise<CodexStreamingHistoryVerification> {
    const verified: CodexStreamingHistoryVerification["segments"] = [];
    const archive = { ...options.archive, isCancelled: options.isCancelled ?? options.archive?.isCancelled };
    let previousMode: CodexOrdinalMode | undefined;
    let nextOrdinal = firstOrdinal;
    let sourceBytes = 0;
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    for (const segment of source.segments) {
        throwIfCodexReadCancelled(archive.isCancelled);
        if (segment.startOrdinal !== nextOrdinal) throw new CodexHistorySourceMismatchError("Codex history prefix ordinal mismatch");
        const currentPhysical = codexHistoryPhysicalIdentity(await fsPromises.stat(segment.path));
        if (JSON.stringify(currentPhysical) !== JSON.stringify(segment.physical) && (/\.zst$/iu.test(segment.path) || !plainAppend(segment.physical, currentPhysical) || sha256(await readFirstLine(segment.path)) !== segment.headerSha256)) throw new CodexHistorySourceMismatchError("Codex history changed after discovery");
        const previous = options.previousVerification?.segments.find(candidate => candidate.path === segment.path);
        const replay = options.replayFrom?.path === segment.path ? options.replayFrom : undefined;
        if (options.replayFrom && !replay && previous && previous.endByte === segment.endByte && previous.endOrdinalExclusive === segment.endOrdinalExclusive && previous.headerSha256 === segment.headerSha256 && JSON.stringify(previous.physical) === JSON.stringify(segment.physical)) {
            const replicaPaths = (replicas: string[]) => replicas.map(replica => normalizeCodexHistoryPath(replica).replace(/\\/gu, "/").toLowerCase()).sort();
            if (JSON.stringify(replicaPaths(segment.replicas)) !== JSON.stringify(replicaPaths(previous.replicaIdentities.map(replica => replica.path)))) throw new CodexHistorySourceMismatchError("Codex history replica inventory changed before incremental replay");
            for (const replica of previous.replicaIdentities) {
                if (JSON.stringify(replica.physical) !== JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(replica.path)))) throw new CodexHistorySourceMismatchError("Codex history replica changed before incremental replay");
            }
            verified.push(previous);
            nextOrdinal = previous.nextOrdinal;
            previousMode = previous.ordinalMode;
            continue;
        }
        if (options.replayFrom && !replay) throw new CodexHistorySourceMismatchError("Codex incremental replay requires unchanged adopted prefixes");
        const validator = new CodexOrdinalValidator(replay?.ordinal ?? segment.startOrdinal, segment.ordinalMode, previousMode);
        const contentHash = crypto.createHash("sha256");
        const previousPrefixHash = replay && previous ? crypto.createHash("sha256") : undefined;
        const compressed = /\.zst$/iu.test(segment.path);
        const logicalHash = segment.replicas.length ? crypto.createHash("sha256") : undefined;
        const physicalHash = compressed ? undefined : crypto.createHash("sha256");
        let archivePhysicalSha256 = "";
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let pendingPrefix = Buffer.alloc(0);
        let position = 0;
        let consumed = 0;
        let adopted = 0;
        let first = true;
        const emit = (raw: Buffer, terminated: boolean): boolean | Promise<boolean> => {
            throwIfCodexReadCancelled(archive.isCancelled);
            const end = position + raw.length;
            const line = raw.subarray(0, raw.length - (terminated ? 1 : 0));
            if ((first && line.length > MAX_HEADER_BYTES) || codexJsonlRecordExceedsLimit(line)) throw new Error("Codex history contains a JSONL line exceeding the safe read limit");
            if (first) {
                if (sha256(line) !== segment.headerSha256) throw new CodexHistorySourceMismatchError("Codex history header changed during parsing");
                first = false;
            }
            if (replay && position < replay.startByte) {
                if (end > replay.startByte) throw new CodexHistorySourceMismatchError("Codex replay byte is not a record boundary");
                contentHash.update(raw);
                position = end;
                adopted = end;
                return true;
            }
            let event: any;
            try { event = JSON.parse(utf8.decode(line).replace(/^\uFEFF/u, "")); }
            catch (error) {
                if (!terminated && segment.endByte === undefined) return false;
                throw new CodexHistorySourceMismatchError(`Invalid Codex history JSON at byte ${position}: ${String(error)}`);
            }
            if (line.length > MAX_HEADER_BYTES && event?.type !== "compacted") throw new Error("Codex history contains a JSONL line exceeding the safe read limit");
            const ordinal = validator.nextOrdinal;
            validator.add(event);
            contentHash.update(raw);
            try {
                const completion = onEvent(event, { path: segment.path, startByte: position, endByte: end, ordinal: typeof event.ordinal === "number" ? event.ordinal : ordinal });
                if (completion && typeof completion.then === "function") return Promise.resolve(completion).then(() => {
                    throwIfCodexReadCancelled(archive.isCancelled);
                    position = end;
                    adopted = end;
                    return true;
                }, error => { options.onPrefixProof?.({ path: segment.path, endByte: end, sha256: contentHash.copy().digest("hex") }); throw error; });
            }
            catch (error) { options.onPrefixProof?.({ path: segment.path, endByte: end, sha256: contentHash.copy().digest("hex") }); throw error; }
            position = end;
            adopted = end;
            return true;
        };
        const plainEndByte = !segment.replicas.length ? segment.endByte : undefined;
        for await (const raw of streamingHistoryBytes(segment.path, segment.physical, { ...archive, plainEndByte, onComplete: identity => { archivePhysicalSha256 = identity.sourceSha256; } })) {
            sourceBytes += raw.length;
            options.onProgress?.(sourceBytes);
            logicalHash?.update(raw);
            physicalHash?.update(raw);
            let selected = segment.endByte === undefined ? raw : raw.subarray(0, Math.max(0, Math.min(raw.length, segment.endByte - consumed)));
            if (previousPrefixHash && previous && consumed < previous.endByte) previousPrefixHash.update(raw.subarray(0, Math.min(raw.length, previous.endByte - consumed)));
            consumed += raw.length;
            if (replay && !first && position < replay.startByte) {
                if (pendingBytes) {
                    if (position + pendingBytes > replay.startByte) throw new CodexHistorySourceMismatchError("Codex replay byte is not a record boundary");
                    for (const part of pending) contentHash.update(part);
                    position += pendingBytes;
                    pending = [];
                    pendingBytes = 0;
                    pendingPrefix = Buffer.alloc(0);
                }
                const skipped = Math.min(selected.length, replay.startByte - position);
                contentHash.update(selected.subarray(0, skipped));
                position += skipped;
                adopted = position;
                if (position === replay.startByte && skipped > 0 && selected[skipped - 1] !== 0x0a) throw new CodexHistorySourceMismatchError("Codex replay byte is not a record boundary");
                selected = selected.subarray(skipped);
            }
            let offset = 0;
            for (let newline = selected.indexOf(0x0a); newline >= 0; newline = selected.indexOf(0x0a, offset)) {
                const part = selected.subarray(offset, newline + 1);
                const line = pending.length ? Buffer.concat([...pending, part], pendingBytes + part.length) : part;
                const completion = emit(line, true);
                if (typeof completion !== "boolean") await completion;
                pending = [];
                pendingBytes = 0;
                pendingPrefix = Buffer.alloc(0);
                offset = newline + 1;
            }
            if (offset < selected.length) {
                const part = selected.subarray(offset);
                pending.push(Buffer.from(part));
                pendingBytes += selected.length - offset;
                if (pendingPrefix.length < 4096) pendingPrefix = Buffer.concat([pendingPrefix, part.subarray(0, 4096 - pendingPrefix.length)]);
                if (pendingBytes > MAX_HEADER_BYTES && (first || pendingBytes > codexJsonlRecordByteLimit(pendingPrefix))) throw new Error("Codex history contains a JSONL line exceeding the safe read limit");
            }
        }
        if (pendingBytes && segment.endByte !== undefined) throw new CodexHistorySourceMismatchError("Codex history adopted prefix is not a complete line");
        if (pendingBytes) {
            const completion = emit(Buffer.concat(pending, pendingBytes), false);
            if (typeof completion !== "boolean") await completion;
        }
        if (segment.endByte !== undefined && adopted !== segment.endByte) throw new CodexHistorySourceMismatchError("Codex history byte boundary exceeds source size");
        if (previousPrefixHash && previousPrefixHash.digest("hex") !== previous!.prefixSha256) throw new CodexHistorySourceMismatchError("Codex cached prefix changed during incremental replay");
        validator.finish(segment.endOrdinalExclusive);
        nextOrdinal = validator.nextOrdinal;
        previousMode = validator.mode ?? previousMode;
        const physicalSha256 = compressed ? archivePhysicalSha256 : physicalHash!.digest("hex");
        const after = codexHistoryPhysicalIdentity(await fsPromises.stat(segment.path));
        if (JSON.stringify(after) !== JSON.stringify(segment.physical)) {
            const appended = !/\.zst$/iu.test(segment.path) && plainAppend(segment.physical, after);
            if (!appended || await hashCodexPrefix(segment.path, Math.min(segment.physical.size, plainEndByte ?? segment.physical.size), archive.isCancelled) !== physicalSha256) throw new CodexHistorySourceMismatchError("Codex history changed during parsing");
        }
        const fullHash = logicalHash?.digest("hex");
        const replicaIdentities: CodexStreamingHistoryVerification["segments"][number]["replicaIdentities"] = [];
        for (const replica of segment.replicas) {
            const physical = codexHistoryPhysicalIdentity(await fsPromises.stat(replica));
            const hash = crypto.createHash("sha256");
            for await (const chunk of streamingHistoryBytes(replica, physical, archive)) hash.update(chunk);
            if (hash.digest("hex") !== fullHash || JSON.stringify(physical) !== JSON.stringify(codexHistoryPhysicalIdentity(await fsPromises.stat(replica)))) throw new CodexHistorySourceMismatchError("Conflicting plaintext/compressed Codex history replicas");
            replicaIdentities.push({ path: replica, physical, sha256: await hashCodexPrefix(replica, physical.size, archive.isCancelled) });
        }
        const prefixSha256 = contentHash.digest("hex");
        verified.push({ ...segment, endByte: adopted, prefixSha256, physicalSha256, nextOrdinal, replicaIdentities });
        options.onPrefixProof?.({ path: segment.path, endByte: adopted, sha256: prefixSha256, replicasVerified: true });
    }
    throwIfCodexReadCancelled(archive.isCancelled);
    return { revision: sha256(JSON.stringify(verified)), sourceBytes, segments: verified };
}
