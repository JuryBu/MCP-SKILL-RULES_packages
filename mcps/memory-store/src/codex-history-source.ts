import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexHistorySourceMismatchError, hashCodexPrefix, hashCodexPrefixSync, throwIfCodexReadCancelled, type CodexOrdinalMode } from "./codex-history-integrity.js";
export { CodexHistorySourceMismatchError } from "./codex-history-integrity.js";

const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const HEADER_READ_CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 8 * 1024;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROLLOUT_FILENAME = new RegExp(`^rollout-.*-(${UUID})(?:_(${UUID}))?\\.jsonl$`, "i");

export interface CodexHistorySegment {
    path: string;
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

export interface CodexHistorySource {
    version: 1;
    leafPath: string;
    segments: CodexHistorySegment[];
    revision: string;
    totalBytes: number;
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
    size: number;
    mtimeMs: number;
    header: RolloutHeader;
}

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

function indexRootsSync(roots: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const add = (filePath: string) => {
        const parsed = parseCodexRolloutFilename(filePath);
        if (!parsed) return;
        const paths = index.get(parsed.rolloutId) || [];
        paths.push(filePath);
        index.set(parsed.rolloutId, paths);
    };
    const visit = (directory: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile()) add(child);
        }
    };
    for (const root of roots) visit(root);
    return index;
}

async function indexRoots(roots: string[]): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    const add = (filePath: string) => {
        const parsed = parseCodexRolloutFilename(filePath);
        if (!parsed) return;
        const paths = index.get(parsed.rolloutId) || [];
        paths.push(filePath);
        index.set(parsed.rolloutId, paths);
    };
    const visit = async (directory: string): Promise<void> => {
        let entries: fs.Dirent[];
        try { entries = await fsPromises.readdir(directory, { withFileTypes: true }); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(child);
            else if (entry.isFile()) add(child);
        }
    };
    for (const root of roots) await visit(root);
    return index;
}

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

function loadSync(filePath: string): LoadedRollout {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error(`Codex rollout source is not a file: ${filePath}`);
    return { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs, header: parseHeader(filePath, readFirstLineSync(filePath)) };
}

async function load(filePath: string): Promise<LoadedRollout> {
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile()) throw new Error(`Codex rollout source is not a file: ${filePath}`);
    return { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs, header: parseHeader(filePath, await readFirstLine(filePath)) };
}

function segmentForSync(rollout: LoadedRollout, startOrdinal: number, endOrdinalExclusive: number | undefined, endByte: number, allowUnterminatedLeaf = false): CodexHistorySegment {
    if (endByte > rollout.size) throw new Error(`Codex history byte boundary exceeds source size: ${rollout.path}`);
    const anchor = readAnchorSync(rollout.path, endByte);
    const unterminatedLeaf = allowUnterminatedLeaf && endByte === rollout.size && endByte > 0 && anchor.value.at(-1) !== 0x0a;
    if (!unterminatedLeaf) assertLineBoundarySync(rollout.path, endByte, rollout.size);
    return {
        path: rollout.path,
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
        prefixSha256: hashCodexPrefixSync(rollout.path, endByte, { headerSha256: sha256(rollout.header.header), anchorStartByte: anchor.start, anchorSha256: sha256(anchor.value), unterminatedLeaf }),
        ordinalMode: rollout.header.ordinalMode,
        ...(unterminatedLeaf ? { unterminatedLeaf: true } : {}),
    };
}

async function segmentFor(rollout: LoadedRollout, startOrdinal: number, endOrdinalExclusive: number | undefined, endByte: number, allowUnterminatedLeaf = false, isCancelled?: () => boolean): Promise<CodexHistorySegment> {
    if (endByte > rollout.size) throw new Error(`Codex history byte boundary exceeds source size: ${rollout.path}`);
    const anchor = await readAnchor(rollout.path, endByte);
    const unterminatedLeaf = allowUnterminatedLeaf && endByte === rollout.size && endByte > 0 && anchor.value.at(-1) !== 0x0a;
    if (!unterminatedLeaf) await assertLineBoundary(rollout.path, endByte, rollout.size);
    return {
        path: rollout.path,
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
        prefixSha256: await hashCodexPrefix(rollout.path, endByte, isCancelled, { headerSha256: sha256(rollout.header.header), anchorStartByte: anchor.start, anchorSha256: sha256(anchor.value), unterminatedLeaf }),
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

function sourceFromSegments(leafPath: string, segments: CodexHistorySegment[]): CodexHistorySource {
    return {
        version: 1,
        leafPath,
        segments,
        revision: buildRevision(leafPath, segments),
        totalBytes: segments.reduce((total, segment) => total + segment.endByte, 0),
    };
}

export function resolveCodexHistorySource(rolloutPath: string, options: { roots?: string[]; endByte?: number } = {}): CodexHistorySource {
    const leafPath = normalizeCodexHistoryPath(rolloutPath);
    let index: Map<string, string[]> | undefined;
    const seen = new Set<string>();
    const reverseSegments: CodexHistorySegment[] = [];
    let current = loadSync(leafPath);
    let currentEndByte = options.endByte === undefined ? lastCompleteLineEndSync(current.path, current.size) : finiteInteger(options.endByte, "endByte");
    let currentEndOrdinal: number | undefined;
    while (true) {
        const currentKey = current.header.identity.rolloutId;
        if (seen.has(currentKey)) throw new Error(`Circular Codex history_base reference for rollout: ${currentKey}`);
        seen.add(currentKey);
        const startOrdinal = current.header.historyBase?.endOrdinalExclusive || 0;
        reverseSegments.push(segmentForSync(current, startOrdinal, currentEndOrdinal, currentEndByte, reverseSegments.length === 0 && options.endByte === undefined));
        const base = current.header.historyBase;
        if (!base || base.endByte === 0) break;
        index ??= indexRootsSync(uniqueRoots(leafPath, options.roots));
        const matches = [...new Set(index.get(base.rolloutId) || [])];
        if (matches.length === 0) throw new Error(`Missing Codex history_base rollout: ${base.rolloutId}`);
        if (matches.length !== 1) throw new Error(`Ambiguous Codex history_base rollout ${base.rolloutId}: ${matches.join(", ")}`);
        current = loadSync(matches[0]!);
        currentEndByte = base.endByte;
        currentEndOrdinal = base.endOrdinalExclusive;
    }
    return sourceFromSegments(leafPath, reverseSegments.reverse());
}

export async function resolveCodexHistorySourceAsync(rolloutPath: string, options: { roots?: string[]; endByte?: number; isCancelled?: () => boolean } = {}): Promise<CodexHistorySource> {
    const leafPath = normalizeCodexHistoryPath(rolloutPath);
    let index: Map<string, string[]> | undefined;
    const seen = new Set<string>();
    const reverseSegments: CodexHistorySegment[] = [];
    let current = await load(leafPath);
    let currentEndByte = options.endByte === undefined ? await lastCompleteLineEnd(current.path, current.size) : finiteInteger(options.endByte, "endByte");
    let currentEndOrdinal: number | undefined;
    while (true) {
        throwIfCodexReadCancelled(options.isCancelled);
        const currentKey = current.header.identity.rolloutId;
        if (seen.has(currentKey)) throw new Error(`Circular Codex history_base reference for rollout: ${currentKey}`);
        seen.add(currentKey);
        const startOrdinal = current.header.historyBase?.endOrdinalExclusive || 0;
        reverseSegments.push(await segmentFor(current, startOrdinal, currentEndOrdinal, currentEndByte, reverseSegments.length === 0 && options.endByte === undefined, options.isCancelled));
        const base = current.header.historyBase;
        if (!base || base.endByte === 0) break;
        index ??= await indexRoots(uniqueRoots(leafPath, options.roots));
        const matches = [...new Set(index.get(base.rolloutId) || [])];
        if (matches.length === 0) throw new Error(`Missing Codex history_base rollout: ${base.rolloutId}`);
        if (matches.length !== 1) throw new Error(`Ambiguous Codex history_base rollout ${base.rolloutId}: ${matches.join(", ")}`);
        current = await load(matches[0]!);
        currentEndByte = base.endByte;
        currentEndOrdinal = base.endOrdinalExclusive;
    }
    return sourceFromSegments(leafPath, reverseSegments.reverse());
}

export function assertCodexHistoryManifest(source: CodexHistorySource): void {
    if (source.version !== 1 || !path.isAbsolute(source.leafPath) || source.segments.length === 0) {
        throw new Error("Invalid Codex history source shape");
    }
    for (const segment of source.segments) {
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
        const stats = fs.statSync(segment.path);
        if (!stats.isFile() || stats.size < segment.endByte) throw new CodexHistorySourceMismatchError(`Codex history source is shorter or unavailable: ${segment.path}`);
        const header = parseHeader(segment.path, readFirstLineSync(segment.path));
        if (header.identity.rolloutId !== segment.rolloutId || header.identity.threadId !== segment.threadId || sha256(header.header) !== segment.headerSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source header changed: ${segment.path}`);
        }
        if (segment.unterminatedLeaf) {
            if (segment !== source.segments.at(-1) || segment.endOrdinalExclusive !== undefined || segment.endByte !== segment.size) {
                throw new Error("Invalid unterminated Codex leaf boundary");
            }
        } else {
            assertLineBoundarySync(segment.path, segment.endByte, stats.size);
        }
        const anchor = readAnchorSync(segment.path, segment.endByte);
        if (anchor.start !== segment.anchorStartByte || sha256(anchor.value) !== segment.anchorSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source boundary changed: ${segment.path}`);
        }
        if (hashCodexPrefixSync(segment.path, segment.endByte, segment) !== segment.prefixSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source content changed: ${segment.path}`);
        }
    }
}

export async function assertCodexHistorySourceAsync(source: CodexHistorySource, isCancelled?: () => boolean): Promise<void> {
    assertCodexHistoryManifest(source);
    for (const segment of source.segments) {
        throwIfCodexReadCancelled(isCancelled);
        const stats = await fsPromises.stat(segment.path);
        if (!stats.isFile() || stats.size < segment.endByte) throw new CodexHistorySourceMismatchError(`Codex history source is shorter or unavailable: ${segment.path}`);
        if (segment.endByte === 0) {
            const header = parseHeader(segment.path, await readFirstLine(segment.path));
            if (sha256(header.header) !== segment.headerSha256) throw new CodexHistorySourceMismatchError(`Codex history source header changed: ${segment.path}`);
        }
        if (segment.unterminatedLeaf) {
            if (segment !== source.segments.at(-1) || segment.endOrdinalExclusive !== undefined || segment.endByte !== segment.size) throw new Error("Invalid unterminated Codex leaf boundary");
        } else {
            await assertLineBoundary(segment.path, segment.endByte, stats.size);
        }
        if (await hashCodexPrefix(segment.path, segment.endByte, isCancelled, segment) !== segment.prefixSha256) {
            throw new CodexHistorySourceMismatchError(`Codex history source content changed: ${segment.path}`);
        }
    }
}
