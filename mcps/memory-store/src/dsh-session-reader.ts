import { createHash } from "node:crypto";
import { open, lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

export interface DshReaderOptions {
    sessionsRoot?: string;
    root?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    maxStabilityAttempts?: number;
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

type ReaderInput = DshReaderOptions | string | undefined;
type ReadInput = DshSessionSnapshot | DshSessionReadOptions | string;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class DshSessionReaderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DshSessionReaderError";
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
    const results = await readAllDshSessions(options);
    return results.map(result => result.snapshot);
}

export async function readDshSession(input: ReadInput, options: DshReaderOptions = {}): Promise<DshSessionReadResult> {
    const normalized = normalizeReadInput(input, options);
    const results = await readAllDshSessions(normalized.options);
    const result = results.find(item => item.header.id === normalized.id);
    if (!result) throw new DshSessionReaderError(`DSH session not found: ${normalized.id}`);
    return result;
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

async function readCandidate(candidate: DshSessionCandidate, options: DshReaderOptions): Promise<DshSessionReadResult> {
    const source = await readStableSource(candidate.sourcePath, options.maxStabilityAttempts ?? 3);
    const decoded = candidate.format === "jsonl.zstd"
        ? decodeZstdSource(source.bytes)
        : { text: decodeUtf8(source.bytes, "raw DSH JSONL"), ignoredTrailingZstdFrame: false };
    const parsed = parseDshJsonl(decoded.text);
    const fingerprint = createHash("sha256").update(source.bytes).digest("hex");
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
        header: parsed.header,
        fingerprint,
        provenance,
        eventCount: parsed.events.length,
    };
    return { header: parsed.header, events: parsed.events, snapshot, fingerprint, provenance };
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

function decodeZstdSource(source: Buffer): DecodedSource {
    const frames: Buffer[] = [];
    let offset = 0;
    let ignoredTrailingZstdFrame = false;
    while (offset < source.length) {
        let end: number;
        try {
            end = zstdFrameEnd(source, offset);
        } catch (error) {
            if (error instanceof IncompleteZstdFrameError && frames.length > 0) {
                ignoredTrailingZstdFrame = true;
                break;
            }
            throw error;
        }
        const frame = source.subarray(offset, end);
        try {
            frames.push(decompressZstdFrame(frame));
        } catch (error) {
            throw new DshSessionReaderError(`invalid complete zstd frame: ${errorMessage(error)}`);
        }
        offset = end;
    }
    if (!frames.length) throw new DshSessionReaderError("DSH zstd source has no complete frame");
    return { text: decodeUtf8(Buffer.concat(frames), "DSH zstd JSONL"), ignoredTrailingZstdFrame };
}

function zstdFrameEnd(source: Buffer, start: number): number {
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
    if ((descriptor & 0x04) !== 0) {
        requireBytes(source, offset, 4);
        offset += 4;
    }
    return offset;
}

function requireBytes(source: Buffer, offset: number, length: number): void {
    if (offset + length > source.length) throw new IncompleteZstdFrameError();
}

function decompressZstdFrame(frame: Buffer): Buffer {
    const zstd = zlib as unknown as { zstdDecompressSync?: (input: Uint8Array) => Uint8Array };
    if (typeof zstd.zstdDecompressSync !== "function") throw new DshSessionReaderError("this Node runtime does not provide zstdDecompressSync");
    return Buffer.from(zstd.zstdDecompressSync(frame));
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
