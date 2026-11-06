import { createHash } from "node:crypto";
import { open, opendir, lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Decompress as ZstdDecompress } from "fzstd";
import xxhash from "xxhash-wasm";
import { assertHostFileActive, assertHostFileUnchanged, captureHostFile, readHostTextWindow, type HostFileRevision } from "./conversation-host-files.js";

export interface DshReaderOptions {
    sessionsRoot?: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    maxStabilityAttempts?: number;
    maxDecompressedBytes?: number;
    maxDecompressedFrameBytes?: number;
    maxCompressedFrameBytes?: number;
    maxLineBytes?: number;
    isCancelled?: () => boolean;
    onProgress?: (progress: { bytes: number; totalBytes: number; phase: string }) => void;
}

export interface DshSessionHeader {
    type: "session";
    version: 0;
    id: string;
    [key: string]: unknown;
}

export interface DshEventBase {
    type: string;
    seq: number;
    time: string | number;
    data: Record<string, unknown> | unknown[];
}

export interface DshTextChunk {
    index: number;
    text: string;
}

export interface DshReasoningChunk {
    index: number;
    text: string;
}

export interface DshToolCallChunk {
    index: number;
    id: string;
    name: string;
    args: string | Record<string, unknown>;
}

export interface DshChunkEvent<TChunk> extends DshEventBase {
    type: "text-chunks" | "reasoning-chunks" | "tool-call-chunks";
    turn: number;
    step: number;
    data: TChunk[];
}

export type DshSessionEvent = DshEventBase | DshChunkEvent<DshTextChunk> | DshChunkEvent<DshReasoningChunk> | DshChunkEvent<DshToolCallChunk>;

export interface DshSessionProvenance {
    source: "dsh";
    sessionsRoot: string;
    projectDirectory: string;
    sessionDirectory: string;
    sourcePath: string;
    format: "jsonl" | "jsonl.zstd";
    sourceSizeBytes: number;
    sourceMtimeMs: number;
    ignoredTrailingTextRecord: boolean;
    ignoredTrailingZstdFrame: boolean;
}

export interface DshSessionSnapshot {
    id: string;
    titleBestEffort?: string;
    header: DshSessionHeader;
    fingerprint: string;
    provenance: DshSessionProvenance;
    eventCount: number;
}

export interface DshSessionReadResult {
    header: DshSessionHeader;
    events: DshSessionEvent[];
    snapshot: DshSessionSnapshot;
    fingerprint: string;
    provenance: DshSessionProvenance;
}

export interface DshSessionReadOptions extends DshReaderOptions {
    id?: string;
    sessionId?: string;
}

export interface DshSessionSource {
    id: string;
    header: DshSessionHeader;
    provenance: DshSessionProvenance;
}

export interface DshMetadataDiscoveryOptions extends DshReaderOptions {
    conversationIds?: string[];
    workspaces?: string[];
    workspaceMode?: "contains" | "exact" | "under" | "any" | "all";
    limit?: number;
    maxEntries?: number;
    maxBytes?: number;
    maxCandidateBytes?: number;
    maxCandidateMs?: number;
    deadlineAt?: number;
    deadlineMs?: number;
}

export interface DshMetadataDiscoveryResult {
    sources: DshSessionSource[];
    partial: boolean;
    warnings: string[];
    scannedCandidates: number;
    scannedEntries: number;
    scannedBytes: number;
}

export interface DshSessionCheckpoint {
    version: 1;
    source: HostFileRevision;
    header: DshSessionHeader;
    resumeByte: number;
    resumeEventCount: number;
    resumeLineNo: number;
    resumeExpectedSeq?: number;
    resumeDecodedBytes: number;
    eventCount: number;
    fingerprint: string;
}

export interface DshIncrementalReadResult extends DshSessionReadResult {
    status: "ok" | "unchanged";
    replaceFromEvent: number;
    checkpoint: DshSessionCheckpoint;
    readBytes: number;
    decodedBytes: number;
}

interface DshSessionCandidate {
    sessionsRoot: string;
    projectDirectory: string;
    sessionDirectory: string;
    sourcePath: string;
    format: "jsonl" | "jsonl.zstd";
}

interface StableSource {
    bytes: Buffer;
    size: number;
    mtimeMs: number;
}

interface DecodedSource {
    text: string;
    ignoredTrailingZstdFrame: boolean;
}

interface ZstdFrameInfo {
    end: number;
    checksum?: number;
}

type ReaderInput = DshReaderOptions | string | undefined;
type ReadInput = DshSessionSnapshot | DshSessionReadOptions | string;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const DSH_READER_REVISION = "3";
const DSH_DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES = 16 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const xxhashApi = xxhash();

export class DshSessionReaderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DshSessionReaderError";
    }
}

class DshMetadataBudgetError extends DshSessionReaderError {
    constructor(readonly reason: string, readonly global: boolean) {
        super(`DSH metadata discovery ${reason}`);
    }
}

class IncompleteZstdFrameError extends DshSessionReaderError {
    constructor() {
        super("incomplete trailing zstd frame");
        this.name = "IncompleteZstdFrameError";
    }
}

export function resolveDshSessionsRoot(input: ReaderInput = {}): string {
    const options = normalizeReaderOptions(input);
    const env = options.env ?? process.env;
    const home = options.homeDir ?? homedir();
    const explicitRoot = options.sessionsRoot ?? options.root;
    const root = explicitRoot
        ?? env.MEMORY_STORE_DSH_SESSIONS_ROOT
        ?? (env.DSH_HOME ? path.join(env.DSH_HOME, "sessions") : undefined)
        ?? path.join(home, ".dsh", "sessions");
    return path.resolve(root);
}

export async function listDshSessionSnapshots(input: ReaderInput = {}): Promise<DshSessionSnapshot[]> {
    const options = normalizeReaderOptions(input);
    const sources = await listDshSessionSources(options);
    const results: DshSessionReadResult[] = [];
    for (const source of sources) results.push(await readDshSessionIncremental(source, options));
    return results.map(result => result.snapshot);
}

export async function readDshSession(input: ReadInput, options: DshReaderOptions = {}): Promise<DshSessionReadResult> {
    const normalized = normalizeReadInput(input, options);
    const discovery = await discoverDshSessionSources({ ...normalized.options, conversationIds: [normalized.id] });
    const source = discovery.sources.find(item => item.id === normalized.id);
    if (!source) throw new DshSessionReaderError(`DSH session not found: ${normalized.id}${discovery.partial ? `; metadata coverage partial: ${discovery.warnings.join("; ")}` : ""}`);
    return readDshSessionIncremental(source, normalized.options);
}

function normalizeReaderOptions(input: ReaderInput): DshReaderOptions {
    if (typeof input === "string") return { sessionsRoot: input };
    return input ?? {};
}

function normalizeReadInput(input: ReadInput, options: DshReaderOptions): { id: string; options: DshReaderOptions } {
    if (typeof input === "string") return { id: requireNonEmptyString(input, "session id"), options };
    if (isSnapshot(input)) return { id: requireNonEmptyString(input.id, "session id"), options };
    const id = input.id ?? input.sessionId;
    if (!id) throw new DshSessionReaderError("readDshSession requires a session id or snapshot");
    return { id: requireNonEmptyString(id, "session id"), options: input };
}

function isSnapshot(value: ReadInput): value is DshSessionSnapshot {
    return typeof value === "object" && value !== null && "header" in value && "fingerprint" in value && "provenance" in value;
}

async function readAllDshSessions(options: DshReaderOptions): Promise<DshSessionReadResult[]> {
    const candidates = await discoverDshSessionCandidates(options);
    const results: DshSessionReadResult[] = [];
    const ids = new Map<string, DshSessionCandidate>();
    for (const candidate of candidates) {
        const result = await readCandidate(candidate, options);
        const previous = ids.get(result.header.id);
        if (previous) {
            throw new DshSessionReaderError(`duplicate DSH session id ${result.header.id} at ${previous.sourcePath} and ${candidate.sourcePath}`);
        }
        ids.set(result.header.id, candidate);
        results.push(result);
    }
    return results;
}

async function discoverDshSessionCandidates(options: DshReaderOptions): Promise<DshSessionCandidate[]> {
    const configuredRoot = resolveDshSessionsRoot(options);
    const sessionsRoot = await realDirectory(configuredRoot, configuredRoot);
    if (!sessionsRoot) return [];
    const candidates: DshSessionCandidate[] = [];
    for (const projectName of await childNames(sessionsRoot)) {
        const projectDirectory = await realDirectory(path.join(sessionsRoot, projectName), sessionsRoot);
        if (!projectDirectory) continue;
        for (const sessionName of await childNames(projectDirectory)) {
            const sessionDirectory = await realDirectory(path.join(projectDirectory, sessionName), sessionsRoot);
            if (!sessionDirectory) continue;
            const compressed = await realFile(path.join(sessionDirectory, "session.jsonl.zstd"), sessionsRoot);
            const raw = await realFile(path.join(sessionDirectory, "session.jsonl"), sessionsRoot);
            if (compressed && raw) {
                throw new DshSessionReaderError(`ambiguous DSH session source in ${sessionDirectory}`);
            }
            if (!compressed && !raw) continue;
            candidates.push({
                sessionsRoot,
                projectDirectory,
                sessionDirectory,
                sourcePath: compressed ?? raw as string,
                format: compressed ? "jsonl.zstd" : "jsonl",
            });
        }
    }
    return candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

async function childNames(directory: string): Promise<string[]> {
    try {
        return (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    } catch (error) {
        if (isMissing(error)) return [];
        throw new DshSessionReaderError(`cannot enumerate DSH directory ${directory}: ${errorMessage(error)}`);
    }
}

async function realDirectory(candidate: string, sessionsRoot: string): Promise<string | null> {
    const resolved = await realEntry(candidate, sessionsRoot);
    if (!resolved) return null;
    try {
        return (await stat(resolved)).isDirectory() ? resolved : null;
    } catch (error) {
        if (isMissing(error)) return null;
        throw new DshSessionReaderError(`cannot stat DSH directory ${candidate}: ${errorMessage(error)}`);
    }
}

async function realFile(candidate: string, sessionsRoot: string): Promise<string | null> {
    const resolved = await realEntry(candidate, sessionsRoot);
    if (!resolved) return null;
    try {
        return (await stat(resolved)).isFile() ? resolved : null;
    } catch (error) {
        if (isMissing(error)) return null;
        throw new DshSessionReaderError(`cannot stat DSH source ${candidate}: ${errorMessage(error)}`);
    }
}

async function realEntry(candidate: string, sessionsRoot: string): Promise<string | null> {
    try {
        await lstat(candidate);
        const resolved = await realpath(candidate);
        return isWithin(sessionsRoot, resolved) ? resolved : null;
    } catch (error) {
        if (isMissing(error)) return null;
        throw new DshSessionReaderError(`cannot resolve DSH path ${candidate}: ${errorMessage(error)}`);
    }
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface DshByteReadControl {
    beforeRead: (bytes: number) => void;
    onRead: (bytes: number) => void;
}

async function readDshBytes(handle: Awaited<ReturnType<typeof open>>, position: number, length: number, size: number, control?: DshByteReadControl): Promise<Buffer> {
    if (position + length > size) throw new IncompleteZstdFrameError();
    const bytes = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
        control?.beforeRead(length - filled);
        const result = await handle.read(bytes, filled, length - filled, position + filled);
        if (!result.bytesRead) throw new IncompleteZstdFrameError();
        filled += result.bytesRead;
        control?.onRead(result.bytesRead);
    }
    return bytes;
}

async function readDshFrame(handle: Awaited<ReturnType<typeof open>>, start: number, size: number, limit: number, isCancelled?: () => boolean, control?: DshByteReadControl): Promise<{ bytes: Buffer; end: number; checksum?: number }> {
    const magic = await readDshBytes(handle, start, 4, size, control);
    if (!ZSTD_MAGIC.every((value, index) => magic[index] === value)) throw new DshSessionReaderError("invalid zstd frame magic");
    const descriptor = (await readDshBytes(handle, start + 4, 1, size, control))[0];
    if ((descriptor & 0x08) !== 0) throw new DshSessionReaderError("reserved zstd frame descriptor bit is set");
    const single = (descriptor & 0x20) !== 0;
    const flag = descriptor >>> 6;
    let offset = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (flag === 0 ? single ? 1 : 0 : 1 << flag);
    for (;;) {
        assertHostFileActive(isCancelled);
        if (offset - start > limit) throw new DshSessionReaderError("DSH compressed frame exceeds maxCompressedFrameBytes");
        const bytes = await readDshBytes(handle, offset, 3, size, control);
        const header = bytes[0] | bytes[1] << 8 | bytes[2] << 16;
        const type = header >>> 1 & 3;
        if (type === 3) throw new DshSessionReaderError("reserved zstd block type");
        offset += 3 + (type === 1 ? 1 : header >>> 3);
        if (offset > size) throw new IncompleteZstdFrameError();
        if (header & 1) break;
    }
    let checksum: number | undefined;
    if (descriptor & 4) {
        checksum = (await readDshBytes(handle, offset, 4, size, control)).readUInt32LE();
        offset += 4;
    }
    if (offset - start > limit) throw new DshSessionReaderError("DSH compressed frame exceeds maxCompressedFrameBytes");
    return { bytes: await readDshBytes(handle, start, offset - start, size, control), end: offset, checksum };
}

export async function discoverDshSessionSources(options: DshMetadataDiscoveryOptions = {}): Promise<DshMetadataDiscoveryResult> {
    const result: DshMetadataDiscoveryResult = { sources: [], partial: false, warnings: [], scannedCandidates: 0, scannedEntries: 0, scannedBytes: 0 };
    const limit = Math.max(0, options.limit ?? 10_000);
    const maxEntries = Math.max(0, options.maxEntries ?? 100_000);
    const maxBytes = Math.max(0, options.maxBytes ?? 16 * 1024 * 1024);
    const candidateBytes = Math.max(0, options.maxCandidateBytes ?? 1024 * 1024);
    const headerBytes = Math.max(1, options.maxLineBytes ?? 64 * 1024);
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + Math.max(0, options.deadlineMs ?? 12_000));
    const requested = options.conversationIds?.length ? new Set(options.conversationIds) : undefined;
    const duplicated = new Set<string>();
    const seenIds = new Set<string>();
    const sources = new Map<string, DshSessionSource>();
    const warn = (message: string): void => { result.partial = true; if (result.warnings.length < 64) result.warnings.push(message); };
    const check = (): void => {
        assertHostFileActive(options.isCancelled);
        if (Date.now() >= deadlineAt) throw new DshMetadataBudgetError("deadline_exceeded", true);
    };
    const normalize = (value: string): string => path.resolve(value).replace(/\\/gu, "/").replace(/\/$/u, "").toLowerCase();
    const matchesWorkspace = (source: DshSessionSource): boolean => {
        if (!options.workspaces?.length) return true;
        const workspace = normalize(typeof source.header.cwd === "string" ? source.header.cwd
            : typeof source.header.workspace === "string" ? source.header.workspace : source.provenance.projectDirectory);
        const matches = options.workspaces.map(value => {
            const selected = normalize(value);
            return options.workspaceMode === "exact" ? workspace === selected
                : options.workspaceMode === "under" ? workspace === selected || workspace.startsWith(`${selected}/`)
                    : workspace.includes(selected);
        });
        return options.workspaceMode === "all" ? matches.every(Boolean) : matches.some(Boolean);
    };
    const entries = async function* (directory: string) {
        check();
        let handle: Awaited<ReturnType<typeof opendir>>;
        try { handle = await opendir(directory); }
        catch (error) { if (isMissing(error)) return; throw error; }
        for await (const entry of handle) {
            check();
            if (result.scannedEntries >= maxEntries) throw new DshMetadataBudgetError("entry_budget_exhausted", true);
            result.scannedEntries += 1;
            yield entry;
        }
    };
    try {
        check();
        if (!limit) throw new DshMetadataBudgetError("candidate_limit", true);
        const configuredRoot = resolveDshSessionsRoot(options);
        const sessionsRoot = await realDirectory(configuredRoot, configuredRoot);
        if (!sessionsRoot) return result;
        for await (const project of entries(sessionsRoot)) {
            if (!project.isDirectory() && !project.isSymbolicLink()) continue;
            let projectDirectory: string | null;
            try { projectDirectory = await realDirectory(path.join(sessionsRoot, project.name), sessionsRoot); }
            catch (error) { warn(`dsh_metadata_project_error:${project.name}:${errorMessage(error)}`); continue; }
            if (!projectDirectory) continue;
            try {
                for await (const session of entries(projectDirectory)) {
                    if (!session.isDirectory() && !session.isSymbolicLink()) continue;
                    check();
                    result.scannedCandidates += 1;
                    const candidateDeadline = Math.min(deadlineAt, Date.now() + Math.max(0, options.maxCandidateMs ?? 1000));
                    let consumed = 0;
                    const checkCandidate = (): void => {
                        check();
                        if (Date.now() >= candidateDeadline) throw new DshMetadataBudgetError("candidate_deadline_exceeded", false);
                    };
                    const byteControl: DshByteReadControl = {
                        beforeRead: bytes => {
                            checkCandidate();
                            if (result.scannedBytes + bytes > maxBytes) throw new DshMetadataBudgetError("byte_budget_exhausted", true);
                            if (consumed + bytes > candidateBytes) throw new DshMetadataBudgetError("candidate_byte_budget_exhausted", false);
                        },
                        onRead: bytes => {
                            consumed += bytes;
                            result.scannedBytes += bytes;
                            options.onProgress?.({ bytes: result.scannedBytes, totalBytes: maxBytes, phase: "metadata" });
                            checkCandidate();
                        },
                    };
                    try {
                        const sessionDirectory = await realDirectory(path.join(projectDirectory, session.name), sessionsRoot);
                        if (!sessionDirectory) continue;
                        const compressed = await realFile(path.join(sessionDirectory, "session.jsonl.zstd"), sessionsRoot);
                        const raw = await realFile(path.join(sessionDirectory, "session.jsonl"), sessionsRoot);
                        if (compressed && raw) throw new DshSessionReaderError("ambiguous DSH session source");
                        if (!compressed && !raw) continue;
                        const sourcePath = compressed || raw!;
                        const handle = await open(sourcePath, "r");
                        let source: DshSessionSource;
                        try {
                            checkCandidate();
                            const before = await handle.stat();
                            const decoder = new TextDecoder("utf-8", { fatal: true });
                            let text = "";
                            let position = 0;
                            let decodedBytes = 0;
                            while (!text.includes("\n") && position < before.size) {
                                checkCandidate();
                                if (compressed) {
                                    const frame = await readDshFrame(handle, position, before.size, Math.min(options.maxCompressedFrameBytes ?? 32 * 1024 * 1024, candidateBytes),
                                        () => { checkCandidate(); return false; }, byteControl);
                                    const parts: string[] = [];
                                    decodedBytes += await decompressZstdFrame(frame.bytes, decoder, parts,
                                        (options.maxDecompressedBytes ?? DSH_DEFAULT_MAX_DECOMPRESSED_BYTES) - decodedBytes,
                                        options.maxDecompressedFrameBytes ?? DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES, frame.checksum, undefined, checkCandidate);
                                    text += parts.join("");
                                    position = frame.end;
                                } else {
                                    const length = Math.min(16 * 1024, before.size - position, headerBytes - position, maxBytes - result.scannedBytes, candidateBytes - consumed);
                                    if (length <= 0) {
                                        if (result.scannedBytes >= maxBytes) throw new DshMetadataBudgetError("byte_budget_exhausted", true);
                                        throw new DshMetadataBudgetError("candidate_header_budget_exhausted", false);
                                    }
                                    const bytes = await readDshBytes(handle, position, length, before.size, byteControl);
                                    text += decoder.decode(bytes, { stream: true });
                                    position += bytes.length;
                                }
                                const newline = text.indexOf("\n");
                                if (Buffer.byteLength(newline < 0 ? text : text.slice(0, newline)) > headerBytes) throw new DshMetadataBudgetError("candidate_header_budget_exhausted", false);
                            }
                            const newline = text.indexOf("\n");
                            if (newline < 0) throw new DshSessionReaderError("DSH session has no complete header record");
                            const header = validateHeader(parseJsonRecord(text.slice(0, newline).replace(/\r$/u, ""), 1));
                            const after = await handle.stat();
                            if (!sameRevision(before, after) || before.ctimeMs !== after.ctimeMs) throw new DshSessionReaderError("DSH source changed during metadata discovery");
                            checkCandidate();
                            source = { id: header.id, header, provenance: { source: "dsh", sessionsRoot, projectDirectory, sessionDirectory,
                                sourcePath, format: compressed ? "jsonl.zstd" : "jsonl", sourceSizeBytes: before.size, sourceMtimeMs: before.mtimeMs,
                                ignoredTrailingTextRecord: false, ignoredTrailingZstdFrame: false } };
                        } finally { await handle.close(); }
                        if (requested && !requested.has(source.id)) continue;
                        if (duplicated.has(source.id)) continue;
                        if (seenIds.has(source.id)) {
                            sources.delete(source.id);
                            duplicated.add(source.id);
                            warn(`dsh_metadata_duplicate_id:${source.id}`);
                            continue;
                        }
                        seenIds.add(source.id);
                        if (options.workspaces?.length && typeof source.header.cwd !== "string" && typeof source.header.workspace !== "string") warn("dsh_metadata_workspace_unknown");
                        if (!matchesWorkspace(source)) continue;
                        sources.set(source.id, source);
                        if (sources.size >= limit) throw new DshMetadataBudgetError("candidate_limit", true);
                    } catch (error) {
                        assertHostFileActive(options.isCancelled);
                        if (error instanceof DshMetadataBudgetError && error.global) throw error;
                        warn(`dsh_metadata_candidate_error:${session.name}:${errorMessage(error)}`);
                    }
                }
            } catch (error) {
                assertHostFileActive(options.isCancelled);
                if (error instanceof DshMetadataBudgetError) throw error;
                warn(`dsh_metadata_project_error:${project.name}:${errorMessage(error)}`);
            }
        }
    } catch (error) {
        assertHostFileActive(options.isCancelled);
        if (!(error instanceof DshMetadataBudgetError)) throw error;
        warn(`dsh_metadata_${error.reason}`);
    }
    assertHostFileActive(options.isCancelled);
    result.sources = [...sources.values()].sort((left, right) => right.provenance.sourceMtimeMs - left.provenance.sourceMtimeMs || left.id.localeCompare(right.id));
    return result;
}

export async function listDshSessionSources(input: ReaderInput = {}): Promise<DshSessionSource[]> {
    const options = normalizeReaderOptions(input);
    const candidates = await discoverDshSessionCandidates(options);
    const result: DshSessionSource[] = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
        assertHostFileActive(options.isCancelled);
        const handle = await open(candidate.sourcePath, "r");
        try {
            const before = await handle.stat();
            let text = "";
            if (candidate.format === "jsonl.zstd") {
                const decoder = new TextDecoder("utf-8", { fatal: true });
                let position = 0;
                let decodedBytes = 0;
                while (!text.includes("\n") && position < before.size) {
                    const frame = await readDshFrame(handle, position, before.size, options.maxCompressedFrameBytes || 32 * 1024 * 1024, options.isCancelled);
                    const parts: string[] = [];
                    decodedBytes += await decompressZstdFrame(frame.bytes, decoder, parts, (options.maxDecompressedBytes || DSH_DEFAULT_MAX_DECOMPRESSED_BYTES) - decodedBytes, options.maxDecompressedFrameBytes || DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES, frame.checksum);
                    text += parts.join("");
                    position = frame.end;
                    if (Buffer.byteLength(text) > (options.maxLineBytes || 16 * 1024 * 1024)) throw new DshSessionReaderError("DSH header exceeds maxLineBytes");
                }
            } else {
                const decoder = new TextDecoder("utf-8", { fatal: true });
                let position = 0;
                while (!text.includes("\n") && position < before.size) {
                    const bytes = await readDshBytes(handle, position, Math.min(16 * 1024, before.size - position), before.size);
                    text += decoder.decode(bytes, { stream: true });
                    position += bytes.length;
                    if (Buffer.byteLength(text) > (options.maxLineBytes || 16 * 1024 * 1024)) throw new DshSessionReaderError("DSH header exceeds maxLineBytes");
                    assertHostFileActive(options.isCancelled);
                }
            }
            const newline = text.indexOf("\n");
            if (newline < 0) throw new DshSessionReaderError("DSH session has no complete header record");
            const header = validateHeader(parseJsonRecord(text.slice(0, newline).replace(/\r$/u, ""), 1));
            if (ids.has(header.id)) throw new DshSessionReaderError(`duplicate DSH session id ${header.id}`);
            ids.add(header.id);
            const after = await handle.stat();
            if (!sameRevision(before, after) || before.ctimeMs !== after.ctimeMs) throw new DshSessionReaderError("DSH source changed during metadata discovery");
            result.push({ id: header.id, header, provenance: {
                source: "dsh", ...candidate, sourceSizeBytes: before.size, sourceMtimeMs: before.mtimeMs,
                ignoredTrailingTextRecord: false, ignoredTrailingZstdFrame: false,
            } });
        } finally {
            await handle.close();
        }
    }
    return result;
}

export async function readDshSessionColdWindow(source: DshSessionSource, revision: HostFileRevision, direction: "head" | "tail", maxBytes: number, options: DshReaderOptions = {}): Promise<{ events: DshSessionEvent[]; prefixOmitted: boolean; suffixOmitted: boolean; warnings: string[]; parsedBytes: number; readBytes: number; decodedBytes: number }> {
    assertHostFileActive(options.isCancelled);
    const allowedRoot = await realDirectory(resolveDshSessionsRoot(options), resolveDshSessionsRoot(options));
    const sourcePath = allowedRoot && await realFile(source.provenance.sourcePath, allowedRoot);
    if (sourcePath !== revision.path) throw new DshSessionReaderError("DSH window source identity changed or is outside the configured root");
    let text = "";
    let prefixOmitted = false;
    let suffixOmitted = false;
    let readBytes = 0;
    let decodedBytes = 0;
    const warnings: string[] = [];
    if (source.provenance.format === "jsonl") {
        const window = await readHostTextWindow(revision, direction, maxBytes, options.isCancelled);
        text = window.text;
        prefixOmitted = window.prefixOmitted;
        suffixOmitted = window.suffixOmitted;
        readBytes = window.readBytes;
        decodedBytes = window.readBytes;
        if (window.incompleteTrailingRecord) warnings.push("dsh_incomplete_trailing_record");
    } else {
        warnings.push("dsh_window_sequential_frame_checksum_utf8_verification");
        options.onProgress?.({ bytes: 0, totalBytes: revision.size, phase: "window-wait-frame-verification" });
        const handle = await open(revision.path, "r");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let position = 0;
        let frames = 0;
        const retained: Buffer[] = [];
        let retainedBytes = 0;
        try {
            while (position < revision.size) {
                assertHostFileActive(options.isCancelled);
                let frame: Awaited<ReturnType<typeof readDshFrame>>;
                try { frame = await readDshFrame(handle, position, revision.size, options.maxCompressedFrameBytes || 32 * 1024 * 1024, options.isCancelled); }
                catch (error) {
                    if (error instanceof IncompleteZstdFrameError && frames > 0) { warnings.push("dsh_incomplete_trailing_frame"); break; }
                    throw error;
                }
                const parts: string[] = [];
                decodedBytes += await decompressZstdFrame(frame.bytes, decoder, parts,
                    (options.maxDecompressedBytes || DSH_DEFAULT_MAX_DECOMPRESSED_BYTES) - decodedBytes,
                    options.maxDecompressedFrameBytes || DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES, frame.checksum);
                const candidate = Buffer.from(parts.join(""));
                if (direction === "tail") {
                    retained.push(candidate);
                    retainedBytes += candidate.length;
                    while (retainedBytes > maxBytes) {
                        const excess = retainedBytes - maxBytes;
                        const first = retained[0];
                        if (first.length <= excess) { retained.shift(); retainedBytes -= first.length; }
                        else { retained[0] = first.subarray(excess); retainedBytes -= excess; }
                        prefixOmitted = true;
                    }
                } else {
                    const available = Math.max(0, maxBytes - retainedBytes);
                    if (candidate.length > available) suffixOmitted = true;
                    if (available) { const selected = candidate.subarray(0, available); retained.push(selected); retainedBytes += selected.length; }
                }
                position = frame.end;
                frames++;
                options.onProgress?.({ bytes: position, totalBytes: revision.size, phase: "window-frame-checksum-utf8" });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            decoder.decode();
            readBytes = position;
            const bytes = Buffer.concat(retained, retainedBytes);
            const first = prefixOmitted ? bytes.indexOf(10) + 1 : 0;
            const last = bytes.lastIndexOf(10) + 1;
            if (!suffixOmitted && last < bytes.length) warnings.push("dsh_incomplete_trailing_record");
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(first, Math.max(first, last)));
        } finally { await handle.close(); }
        if (!text.endsWith("\n")) {
            if (!suffixOmitted) warnings.push("dsh_incomplete_trailing_record");
            text = text.slice(0, text.lastIndexOf("\n") + 1);
        }
    }
    const events: DshSessionEvent[] = [];
    let expectedSeq: number | undefined;
    let lineNo = 0;
    options.onProgress?.({ bytes: 0, totalBytes: Buffer.byteLength(text), phase: "window-record-parse" });
    for (const line of text.split("\n")) {
        if (!line) continue;
        assertHostFileActive(options.isCancelled);
        if (Buffer.byteLength(line) > (options.maxLineBytes || 16 * 1024 * 1024)) throw new DshSessionReaderError("DSH record exceeds maxLineBytes");
        const stored = parseJsonRecord(line.replace(/\r$/u, ""), ++lineNo);
        if (!prefixOmitted && lineNo === 1) {
            if (validateHeader(stored).id !== source.id) throw new DshSessionReaderError("DSH source header identity changed");
            continue;
        }
        for (const value of decodeStorageRecord(stored)) {
            const event = validateEvent(value);
            if (expectedSeq !== undefined && event.seq !== expectedSeq) throw new DshSessionReaderError(`non-contiguous DSH window event sequence: expected ${expectedSeq}, got ${event.seq}`);
            expectedSeq = event.seq + 1;
            events.push(event);
        }
        if (lineNo % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await assertHostFileUnchanged(revision, options.isCancelled);
    options.onProgress?.({ bytes: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), phase: "window-record-parse" });
    assertHostFileActive(options.isCancelled);
    return { events, prefixOmitted, suffixOmitted, warnings, parsedBytes: Buffer.byteLength(text), readBytes, decodedBytes };
}

export async function readDshSessionIncremental(source: DshSessionSource, options: DshReaderOptions & { checkpoint?: DshSessionCheckpoint } = {}): Promise<DshIncrementalReadResult> {
    assertHostFileActive(options.isCancelled);
    const allowedRoot = await realDirectory(resolveDshSessionsRoot(options), resolveDshSessionsRoot(options));
    const sourcePath = allowedRoot && await realFile(source.provenance.sourcePath, allowedRoot);
    if (!sourcePath) throw new DshSessionReaderError("DSH source is outside the configured sessions root or unavailable");
    const previous = options.checkpoint;
    const revision = await captureHostFile(sourcePath, { prefixSize: previous?.source.size, isCancelled: options.isCancelled, onProgress: (bytes, totalBytes) => options.onProgress?.({ bytes, totalBytes, phase: "verify" }) });
    const fingerprint = createHash("sha256").update(`dsh-reader:${DSH_READER_REVISION}:stream1\0${revision.path}\0${revision.sha256}`).digest("hex");
    const append = previous?.version === 1 && previous.header.id === source.id && previous.source.path === revision.path && previous.source.dev === revision.dev && previous.source.ino === revision.ino && revision.size >= previous.source.size && revision.prefixSha256 === previous.source.sha256;
    const provenance = { ...source.provenance, sourcePath: revision.path, sourceSizeBytes: revision.size, sourceMtimeMs: revision.mtimeMs };
    if (append && previous.fingerprint === fingerprint) return {
        status: "unchanged", header: previous.header, events: [], fingerprint, provenance,
        snapshot: { id: source.id, header: previous.header, fingerprint, provenance, eventCount: previous.eventCount },
        checkpoint: { ...previous, source: revision }, replaceFromEvent: previous.eventCount, readBytes: 0, decodedBytes: 0,
    };
    let header: DshSessionHeader | undefined = append ? previous.header : undefined;
    const start = append ? previous.resumeByte : 0;
    let position = start;
    let lineNo = append ? previous.resumeLineNo : 0;
    let expectedSeq = append ? previous.resumeExpectedSeq : undefined;
    const replaceFromEvent = append ? previous.resumeEventCount : 0;
    const events: DshSessionEvent[] = [];
    let pending = "";
    let decodedBytes = 0;
    let totalDecodedBytes = append ? previous.resumeDecodedBytes : 0;
    let resumeByte = start;
    let resumeEventCount = replaceFromEvent;
    let resumeLineNo = lineNo;
    let resumeExpectedSeq = expectedSeq;
    let resumeDecodedBytes = totalDecodedBytes;
    let ignoredTrailingZstdFrame = false;
    let completeFrames = append ? 1 : 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const limit = requirePositiveInteger(options.maxDecompressedBytes ?? DSH_DEFAULT_MAX_DECOMPRESSED_BYTES, "maxDecompressedBytes");
    const consume = (text: string) => {
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
            assertHostFileActive(options.isCancelled);
            const line = pending.slice(0, newline).replace(/\r$/u, "");
            if (Buffer.byteLength(line) > (options.maxLineBytes || 16 * 1024 * 1024)) throw new DshSessionReaderError("DSH record exceeds maxLineBytes");
            pending = pending.slice(newline + 1);
            lineNo++;
            if (!header) header = validateHeader(parseJsonRecord(line, lineNo));
            else for (const stored of decodeStorageRecord(parseJsonRecord(line, lineNo))) {
                const event = validateEvent(stored);
                if (expectedSeq !== undefined && event.seq !== expectedSeq) throw new DshSessionReaderError(`non-contiguous DSH event sequence at line ${lineNo}: expected ${expectedSeq}, got ${event.seq}`);
                expectedSeq = event.seq + 1;
                events.push(event);
            }
            newline = pending.indexOf("\n");
        }
        if (Buffer.byteLength(pending) > (options.maxLineBytes || 16 * 1024 * 1024)) throw new DshSessionReaderError("DSH record exceeds maxLineBytes");
    };
    const markBoundary = () => {
        resumeByte = position;
        resumeEventCount = replaceFromEvent + events.length;
        resumeLineNo = lineNo;
        resumeExpectedSeq = expectedSeq;
        resumeDecodedBytes = totalDecodedBytes;
    };
    const handle = await open(sourcePath, "r");
    try {
        while (position < revision.size) {
            assertHostFileActive(options.isCancelled);
            if (source.provenance.format === "jsonl.zstd") {
                let frame: Awaited<ReturnType<typeof readDshFrame>>;
                try { frame = await readDshFrame(handle, position, revision.size, options.maxCompressedFrameBytes || 32 * 1024 * 1024, options.isCancelled); }
                catch (error) {
                    if (error instanceof IncompleteZstdFrameError && completeFrames > 0) { ignoredTrailingZstdFrame = true; break; }
                    throw error;
                }
                const text: string[] = [];
                let lastByte: number | undefined;
                const onOutput = (bytes: Uint8Array): void => { if (bytes.length) lastByte = bytes.at(-1); };
                const count = await decompressZstdFrame(frame.bytes, decoder, text, limit - totalDecodedBytes,
                    options.maxDecompressedFrameBytes || DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES, frame.checksum, onOutput,
                    options.isCancelled ? () => assertHostFileActive(options.isCancelled) : undefined);
                totalDecodedBytes += count;
                decodedBytes += count;
                consume(text.join(""));
                position = frame.end;
                completeFrames++;
                if (!pending && lastByte === 10) markBoundary();
            } else {
                const bytes = await readDshBytes(handle, position, Math.min(256 * 1024, revision.size - position), revision.size);
                totalDecodedBytes += bytes.length;
                decodedBytes += bytes.length;
                if (totalDecodedBytes > limit) throw new DshSessionReaderError("DSH decompressed output exceeds maxDecompressedBytes");
                consume(decoder.decode(bytes, { stream: true }));
                position += bytes.length;
                if (!pending && bytes.at(-1) === 10) markBoundary();
            }
            options.onProgress?.({ bytes: position, totalBytes: revision.size, phase: "decode" });
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        consume(decoder.decode());
    } finally {
        await handle.close();
    }
    if (!header) throw new DshSessionReaderError("DSH session has no complete header record");
    if (header.id !== source.id) throw new DshSessionReaderError("DSH source header identity changed");
    await assertHostFileUnchanged(revision, options.isCancelled);
    provenance.ignoredTrailingTextRecord = pending.length > 0;
    provenance.ignoredTrailingZstdFrame = ignoredTrailingZstdFrame;
    const checkpoint: DshSessionCheckpoint = { version: 1, source: revision, header, resumeByte, resumeEventCount, resumeLineNo, resumeExpectedSeq, resumeDecodedBytes, eventCount: replaceFromEvent + events.length, fingerprint };
    const snapshot: DshSessionSnapshot = { id: header.id, header, fingerprint, provenance, titleBestEffort: latestSessionTitle(events), eventCount: checkpoint.eventCount };
    return { status: "ok", header, events, snapshot, fingerprint, provenance, checkpoint, replaceFromEvent, readBytes: position - start, decodedBytes };
}

async function readCandidate(candidate: DshSessionCandidate, options: DshReaderOptions): Promise<DshSessionReadResult> {
    const source = await readStableSource(candidate.sourcePath, options.maxStabilityAttempts ?? 3);
    const decoded = candidate.format === "jsonl.zstd"
        ? await decodeZstdSource(
            source.bytes,
            options.maxDecompressedBytes ?? DSH_DEFAULT_MAX_DECOMPRESSED_BYTES,
            options.maxDecompressedFrameBytes ?? DSH_DEFAULT_MAX_DECOMPRESSED_FRAME_BYTES,
        )
        : { text: decodeUtf8(source.bytes, "raw DSH JSONL"), ignoredTrailingZstdFrame: false };
    const parsed = parseDshJsonl(decoded.text);
    const fingerprint = createHash("sha256")
        .update(`dsh-reader:${DSH_READER_REVISION}\0`)
        .update(source.bytes)
        .digest("hex");
    const provenance: DshSessionProvenance = {
        source: "dsh",
        sessionsRoot: candidate.sessionsRoot,
        projectDirectory: candidate.projectDirectory,
        sessionDirectory: candidate.sessionDirectory,
        sourcePath: candidate.sourcePath,
        format: candidate.format,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        ignoredTrailingTextRecord: parsed.ignoredTrailingTextRecord,
        ignoredTrailingZstdFrame: decoded.ignoredTrailingZstdFrame,
    };
    const snapshot: DshSessionSnapshot = {
        id: parsed.header.id,
        titleBestEffort: latestSessionTitle(parsed.events),
        header: parsed.header,
        fingerprint,
        provenance,
        eventCount: parsed.events.length,
    };
    return { header: parsed.header, events: parsed.events, snapshot, fingerprint, provenance };
}

function latestSessionTitle(events: readonly DshSessionEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (event.type !== "session/title" || Array.isArray(event.data) || !event.data) continue;
        const title = event.data.title;
        if (typeof title === "string" && title.trim()) return title.trim();
    }
    return undefined;
}

async function readStableSource(sourcePath: string, maxAttempts: number): Promise<StableSource> {
    const attempts = requirePositiveInteger(maxAttempts, "maxStabilityAttempts");
    for (let attempt = 0; attempt < attempts; attempt++) {
        let before;
        try {
            before = await stat(sourcePath);
        } catch (error) {
            if (isMissing(error)) throw new DshSessionReaderError(`DSH source disappeared: ${sourcePath}`);
            throw new DshSessionReaderError(`cannot stat DSH source ${sourcePath}: ${errorMessage(error)}`);
        }
        if (!before.isFile()) throw new DshSessionReaderError(`DSH source is not a file: ${sourcePath}`);
        const handle = await open(sourcePath, "r");
        try {
            const opened = await handle.stat();
            if (!sameRevision(before, opened)) continue;
            const bytes = await handle.readFile();
            const after = await handle.stat();
            if (sameRevision(opened, after)) {
                return { bytes, size: after.size, mtimeMs: after.mtimeMs };
            }
        } finally {
            await handle.close();
        }
    }
    throw new DshSessionReaderError(`DSH source changed while reading after ${attempts} attempts: ${sourcePath}`);
}

function sameRevision(left: { dev: number; ino: number; size: number; mtimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number }): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function decodeZstdSource(
    source: Buffer,
    maxDecompressedBytes: number,
    maxDecompressedFrameBytes: number,
): Promise<DecodedSource> {
    const limit = requirePositiveInteger(maxDecompressedBytes, "maxDecompressedBytes");
    const frameLimit = requirePositiveInteger(maxDecompressedFrameBytes, "maxDecompressedFrameBytes");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const textParts: string[] = [];
    let decompressedBytes = 0;
    let completeFrames = 0;
    let offset = 0;
    let ignoredTrailingZstdFrame = false;
    while (offset < source.length) {
        let frameInfo: ZstdFrameInfo;
        try {
            frameInfo = zstdFrameInfo(source, offset);
        } catch (error) {
            if (error instanceof IncompleteZstdFrameError && completeFrames > 0) {
                ignoredTrailingZstdFrame = true;
                break;
            }
            throw error;
        }
        const frame = source.subarray(offset, frameInfo.end);
        try {
            decompressedBytes += await decompressZstdFrame(
                frame,
                decoder,
                textParts,
                limit - decompressedBytes,
                frameLimit,
                frameInfo.checksum,
            );
        } catch (error) {
            if (error instanceof DshSessionReaderError) throw error;
            throw new DshSessionReaderError(`invalid complete zstd frame: ${errorMessage(error)}`);
        }
        completeFrames += 1;
        offset = frameInfo.end;
    }
    if (!completeFrames) throw new DshSessionReaderError("DSH zstd source has no complete frame");
    try {
        const finalText = decoder.decode();
        if (finalText) textParts.push(finalText);
    } catch (error) {
        throw new DshSessionReaderError(`invalid UTF-8 in DSH zstd JSONL: ${errorMessage(error)}`);
    }
    return { text: textParts.join(""), ignoredTrailingZstdFrame };
}

function zstdFrameInfo(source: Buffer, start: number): ZstdFrameInfo {
    requireBytes(source, start, 4);
    for (let index = 0; index < ZSTD_MAGIC.length; index++) {
        if (source[start + index] !== ZSTD_MAGIC[index]) throw new DshSessionReaderError("invalid zstd frame magic");
    }
    let offset = start + 4;
    requireBytes(source, offset, 1);
    const descriptor = source[offset++];
    if ((descriptor & 0x08) !== 0) throw new DshSessionReaderError("reserved zstd frame descriptor bit is set");
    const singleSegment = (descriptor & 0x20) !== 0;
    if (!singleSegment) {
        requireBytes(source, offset, 1);
        offset++;
    }
    const dictionaryIdSize = [0, 1, 2, 4][descriptor & 0x03];
    requireBytes(source, offset, dictionaryIdSize);
    offset += dictionaryIdSize;
    const contentSizeFlag = descriptor >>> 6;
    const contentSizeLength = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    requireBytes(source, offset, contentSizeLength);
    offset += contentSizeLength;
    for (;;) {
        requireBytes(source, offset, 3);
        const blockHeader = source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16);
        offset += 3;
        const lastBlock = (blockHeader & 1) !== 0;
        const blockType = (blockHeader >>> 1) & 0x03;
        const blockSize = blockHeader >>> 3;
        if (blockType === 3) throw new DshSessionReaderError("reserved zstd block type");
        const payloadSize = blockType === 1 ? 1 : blockSize;
        requireBytes(source, offset, payloadSize);
        offset += payloadSize;
        if (lastBlock) break;
    }
    let checksum: number | undefined;
    if ((descriptor & 0x04) !== 0) {
        requireBytes(source, offset, 4);
        checksum = source.readUInt32LE(offset);
        offset += 4;
    }
    return { end: offset, checksum };
}

function requireBytes(source: Buffer, offset: number, length: number): void {
    if (offset + length > source.length) throw new IncompleteZstdFrameError();
}

async function decompressZstdFrame(
    frame: Buffer,
    decoder: typeof utf8Decoder,
    textParts: string[],
    remainingBytes: number,
    maxFrameBytes: number,
    expectedChecksum?: number,
    onOutput?: (bytes: Uint8Array) => void,
    check?: () => void,
): Promise<number> {
    if (remainingBytes <= 0) {
        throw new DshSessionReaderError("DSH zstd decompressed output exceeds maxDecompressedBytes");
    }
    const outputLimit = Math.min(remainingBytes, maxFrameBytes);
    let frameBytes = 0;
    const checksum = expectedChecksum === undefined ? undefined : (await xxhashApi).create64();
    const decompressor = new ZstdDecompress(chunk => {
        onOutput?.(chunk);
        check?.();
        frameBytes += chunk.length;
        if (frameBytes > outputLimit) {
            const limitName = remainingBytes <= maxFrameBytes ? "maxDecompressedBytes" : "maxDecompressedFrameBytes";
            throw new DshSessionReaderError(`DSH zstd decompressed output exceeds ${limitName}`);
        }
        checksum?.update(chunk);
        const text = decoder.decode(chunk, { stream: true });
        if (text) textParts.push(text);
    });
    if (check) {
        for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
            check();
            decompressor.push(frame.subarray(offset, Math.min(frame.length, offset + 64 * 1024)), offset + 64 * 1024 >= frame.length);
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        check();
    } else decompressor.push(frame, true);
    if (checksum) {
        const actualChecksum = Number(checksum.digest() & 0xffff_ffffn) >>> 0;
        if (actualChecksum !== expectedChecksum) {
            throw new DshSessionReaderError("invalid complete zstd frame checksum");
        }
    }
    return frameBytes;
}

function decodeUtf8(source: Buffer, label: string): string {
    try {
        return utf8Decoder.decode(source);
    } catch (error) {
        throw new DshSessionReaderError(`invalid UTF-8 in ${label}: ${errorMessage(error)}`);
    }
}

function parseDshJsonl(text: string): { header: DshSessionHeader; events: DshSessionEvent[]; ignoredTrailingTextRecord: boolean } {
    const hasTrailingNewline = text.endsWith("\n");
    const complete = hasTrailingNewline ? text : text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1));
    const records = complete.length ? complete.slice(0, -1).split("\n") : [];
    if (!records.length) throw new DshSessionReaderError("DSH session has no complete header record");
    const header = validateHeader(parseJsonRecord(records[0], 1));
    const events: DshSessionEvent[] = [];
    let expectedSeq: number | undefined;
    for (let index = 1; index < records.length; index++) {
        const storedEvents = decodeStorageRecord(parseJsonRecord(records[index], index + 1));
        for (const storedEvent of storedEvents) {
            const event = validateEvent(storedEvent);
            if (expectedSeq !== undefined && event.seq !== expectedSeq) {
                throw new DshSessionReaderError("non-contiguous DSH event sequence at line " + (index + 1) + ": expected " + expectedSeq + ", got " + event.seq);
            }
            expectedSeq = event.seq + 1;
            events.push(event);
        }
    }
    return { header, events, ignoredTrailingTextRecord: !hasTrailingNewline };
}

function decodeStorageRecord(value: Record<string, unknown>): Record<string, unknown>[] {
    const tag = value.type;
    if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") return [value];
    if (!hasExactKeys(value, ["type", "seq0", "time0", "data"])) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: envelope must be exactly {type, seq0, time0, data}");
    }
    const seq0 = requireNonNegativeInteger(value.seq0, "DSH " + tag + " seq0");
    const time0 = requireSafeInteger(value.time0, "DSH " + tag + " time0");
    if (!isRecord(value.data)) throw new DshSessionReaderError("malformed " + tag + " storage row: data must be an object");
    const data = value.data;
    const turn = requireNonNegativeInteger(data.turn, "DSH " + tag + " turn");
    const step = requireNonNegativeInteger(data.step, "DSH " + tag + " step");
    const blockIndex = requireNonNegativeInteger(data.index, "DSH " + tag + " index");
    const payloadKey = tag === "tool-call-chunks" ? "args" : "texts";
    const allowedKeys = tag === "tool-call-chunks"
        ? (Object.hasOwn(data, "name") ? ["turn", "step", "index", "id", "name", "dt", "args"] : ["turn", "step", "index", "id", "dt", "args"])
        : ["turn", "step", "index", "dt", "texts"];
    if (!hasExactKeys(data, allowedKeys)) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: unexpected data fields");
    }
    const payload = data[payloadKey];
    if (!Array.isArray(payload) || payload.length === 0 || payload.some(item => typeof item !== "string")) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: " + payloadKey + " must be a non-empty string array");
    }
    if (!Array.isArray(data.dt) || data.dt.some(item => typeof item !== "number" || !Number.isSafeInteger(item))) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: dt must be an array of safe integers");
    }
    if (data.dt.length !== payload.length - 1) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: dt length does not match member count");
    }
    if (!Number.isSafeInteger(seq0 + payload.length - 1)) {
        throw new DshSessionReaderError("malformed " + tag + " storage row: member seqs leave safe integer range");
    }
    const toolCallId = tag === "tool-call-chunks" ? requireNonEmptyString(data.id, "DSH tool-call chunk id") : "";
    const toolName = tag === "tool-call-chunks" && Object.hasOwn(data, "name") ? requireString(data.name, "DSH tool-call chunk name") : undefined;
    const events: Record<string, unknown>[] = [];
    let time = time0;
    for (let memberIndex = 0; memberIndex < payload.length; memberIndex++) {
        if (memberIndex > 0) {
            time += data.dt[memberIndex - 1] as number;
            if (!Number.isSafeInteger(time)) throw new DshSessionReaderError("malformed " + tag + " storage row: member times leave safe integer range");
        }
        const chunk = tag === "text-chunks"
            ? { type: "text-delta", index: blockIndex, text: payload[memberIndex] }
            : tag === "reasoning-chunks"
                ? { type: "reasoning-delta", index: blockIndex, text: payload[memberIndex] }
                : {
                    type: "tool-call-delta",
                    index: blockIndex,
                    id: toolCallId,
                    ...(toolName !== undefined ? { name: toolName } : {}),
                    argumentsDelta: payload[memberIndex],
                };
        events.push({
            type: "assistant/chunk",
            seq: seq0 + memberIndex,
            time,
            data: { turn, step, chunk },
        });
    }
    return events;
}

function parseJsonRecord(line: string, lineNumber: number): Record<string, unknown> {
    if (!line.trim()) throw new DshSessionReaderError(`empty DSH JSONL record at line ${lineNumber}`);
    try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) throw new DshSessionReaderError(`DSH JSONL record at line ${lineNumber} is not an object`);
        return value;
    } catch (error) {
        if (error instanceof DshSessionReaderError) throw error;
        throw new DshSessionReaderError(`invalid DSH JSON at line ${lineNumber}: ${errorMessage(error)}`);
    }
}

function validateHeader(value: Record<string, unknown>): DshSessionHeader {
    if (value.type !== "session") throw new DshSessionReaderError("DSH header type must be session");
    if (value.version !== 0) throw new DshSessionReaderError("unsupported DSH session version");
    const id = requireNonEmptyString(value.id, "DSH header id");
    return { ...value, type: "session", version: 0, id };
}

function validateEvent(value: Record<string, unknown>): DshSessionEvent {
    const type = requireNonEmptyString(value.type, "DSH event type");
    if (type === "session") throw new DshSessionReaderError("DSH session header may only appear as the first record");
    const seq = requireNonNegativeInteger(value.seq, "DSH event seq");
    const time = validateTime(value.time);
    if (!("data" in value) || !isRecordOrArray(value.data)) throw new DshSessionReaderError("DSH event data must be an object or array");
    if (type === "text-chunks" || type === "reasoning-chunks" || type === "tool-call-chunks") {
        return validateChunkEvent(value, type, seq, time);
    }
    if (!isRecord(value.data)) throw new DshSessionReaderError(`DSH event ${type} data must be an object`);
    return { ...value, type, seq, time, data: value.data };
}

function validateChunkEvent(value: Record<string, unknown>, type: DshChunkEvent<never>["type"], seq: number, time: string | number): DshSessionEvent {
    const envelope = unpackChunks(value.data as Record<string, unknown> | unknown[]);
    const turn = requireMatchingCoordinate(value.turn, envelope.turn, "turn");
    const step = requireMatchingCoordinate(value.step, envelope.step, "step");
    const chunks = envelope.chunks.map((chunk, index) => validateChunk(chunk, type, turn, step, index));
    return { type, seq, time, turn, step, data: chunks } as DshSessionEvent;
}

function unpackChunks(data: Record<string, unknown> | unknown[]): { turn: unknown; step: unknown; chunks: unknown[] } {
    if (Array.isArray(data)) return { turn: undefined, step: undefined, chunks: data };
    if (Array.isArray(data.chunks)) return { turn: data.turn, step: data.step, chunks: data.chunks };
    if (isRecord(data) && "index" in data) return { turn: data.turn, step: data.step, chunks: [data] };
    throw new DshSessionReaderError("DSH chunk event data must contain a chunk array");
}

function requireMatchingCoordinate(eventValue: unknown, packedValue: unknown, name: "turn" | "step"): number {
    const eventCoordinate = eventValue === undefined ? undefined : requireNonNegativeInteger(eventValue, `DSH chunk ${name}`);
    const packedCoordinate = packedValue === undefined ? undefined : requireNonNegativeInteger(packedValue, `DSH packed chunk ${name}`);
    if (eventCoordinate === undefined && packedCoordinate === undefined) throw new DshSessionReaderError(`DSH chunk event requires ${name}`);
    if (eventCoordinate !== undefined && packedCoordinate !== undefined && eventCoordinate !== packedCoordinate) {
        throw new DshSessionReaderError(`DSH chunk event has conflicting ${name}`);
    }
    return eventCoordinate ?? packedCoordinate as number;
}

function validateChunk(value: unknown, type: DshChunkEvent<never>["type"], turn: number, step: number, position: number): DshTextChunk | DshReasoningChunk | DshToolCallChunk {
    if (!isRecord(value)) throw new DshSessionReaderError(`DSH ${type} item ${position} is not an object`);
    if (value.turn !== undefined && requireNonNegativeInteger(value.turn, `DSH ${type} item turn`) !== turn) throw new DshSessionReaderError(`DSH ${type} item has conflicting turn`);
    if (value.step !== undefined && requireNonNegativeInteger(value.step, `DSH ${type} item step`) !== step) throw new DshSessionReaderError(`DSH ${type} item has conflicting step`);
    const index = requireNonNegativeInteger(value.index, `DSH ${type} item index`);
    if (type === "tool-call-chunks") {
        const id = requireNonEmptyString(value.id, "DSH tool-call chunk id");
        const name = requireNonEmptyString(value.name, "DSH tool-call chunk name");
        if (!(typeof value.args === "string" || isRecord(value.args))) throw new DshSessionReaderError("DSH tool-call chunk args must be a string or object");
        return { index, id, name, args: value.args };
    }
    return { index, text: requireString(value.text, `DSH ${type} item text`) };
}

function validateTime(value: unknown): string | number {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw new DshSessionReaderError("DSH event time must be a non-empty string or finite number");
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") throw new DshSessionReaderError(`${label} must be a string`);
    return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
    const text = requireString(value, label);
    if (!text.trim()) throw new DshSessionReaderError(`${label} must not be empty`);
    return text;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DshSessionReaderError(`${label} must be a non-negative integer`);
    return value;
}

function requireSafeInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DshSessionReaderError(label + " must be a safe integer");
    return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new DshSessionReaderError(`${label} must be a positive integer`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
    return isRecord(value) || Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
