import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, writeJsonAtomic, writeJsonAtomicAsync } from "./store.js";

export const CONVERSATION_SOURCE_CACHE_FORMAT = "conversation-source-cache/v3" as const;

export interface ConversationSourceCacheKey {
    source: string;
    conversationId: string;
}

export interface ConversationSourceFingerprint {
    path?: string;
    size?: number;
    mtime?: number | string;
    revision?: string;
}

export interface ConversationSourceCachePreparedRounds {
    temporaryPath: string;
    roundCount: number;
    bytes: number;
    sha256: string;
    index: {
        version: 1;
        entries: Array<{
            round: number;
            startByte: number;
            endByte: number;
            sha256: string;
        }>;
    };
    recordProjection?: {
        temporaryPath: string;
        bytes: number;
        sha256: string;
        index: {
            version: 1;
            entries: Array<{
                round: number;
                startByte: number;
                endByte: number;
                sha256: string;
            }>;
        };
    };
}

export type ConversationSourceCacheBuildResult<TSnapshot, TRound> =
    | { snapshot: TSnapshot; rounds: readonly TRound[]; preparedRounds?: never }
    | { snapshot: TSnapshot; rounds?: never; preparedRounds: ConversationSourceCachePreparedRounds };

export interface ConversationSourceCacheRoundSpool<TRound> {
    append(round: TRound): void;
    finish(): ConversationSourceCachePreparedRounds;
    abort(): void;
}

export interface ConversationSourceCacheReadOrBuildOptions<TSnapshot, TRound> {
    key: ConversationSourceCacheKey;
    fingerprint: ConversationSourceFingerprint | null;
    refresh?: boolean;
    assertPublishable?: () => Promise<void> | void;
    build: () => Promise<ConversationSourceCacheBuildResult<TSnapshot, TRound>> | ConversationSourceCacheBuildResult<TSnapshot, TRound>;
    getRoundNumber?: (round: TRound, index: number) => number;
    projectRecordRound?: (round: TRound, index: number) => unknown;
}

export interface ConversationSourceCacheReadOptions {
    key: ConversationSourceCacheKey;
    expectedFingerprint?: ConversationSourceFingerprint | null;
    generation?: string;
}

export interface ConversationSourceCacheRoundRange extends ConversationSourceCacheReadOptions {
    startRound?: number;
    endRound?: number;
}

export interface ConversationSourceCacheBuildFailure {
    name: string;
    message: string;
}

export interface ConversationSourceCacheReadResult<TSnapshot> {
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
    snapshot: TSnapshot;
    roundCount: number;
    createdAt: string;
    cacheState: "hit" | "built" | "stale";
    buildFailure?: ConversationSourceCacheBuildFailure;
}

export interface ConversationSourceCacheRoundsResult<TRound> {
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
    roundCount: number;
    rounds: TRound[];
}

export interface ConversationSourceCacheRoundIterable<TRound> {
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
    roundCount: number;
    roundsBytes: number;
    roundsSha256: string;
    recordProjection?: {
        bytes: number;
        sha256: string;
    };
    rounds: Iterable<TRound>;
}

export interface ConversationSourceCacheRecordProjectionResult<TProjection> {
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
    roundCount: number;
    bytes: number;
    sha256: string;
    materializedStartRound: number;
    materializedEndRound: number;
    projections: TProjection[];
}

export interface ConversationSourceCacheDiagnostics {
    cacheDirectory: string;
    inFlight: number;
    reads: number;
    cacheOnlyReads: number;
    hits: number;
    misses: number;
    buildsStarted: number;
    buildsCompleted: number;
    buildsFailed: number;
    staleFallbacks: number;
    rangeReads: number;
    corruptions: number;
    cleanupFailures: number;
    pinsCreated: number;
    pinsReleased: number;
}

export interface ConversationSourceCacheGenerationRef {
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
}

export interface ConversationSourceCachePin extends ConversationSourceCacheGenerationRef {
    ownerId: string;
}

interface CacheFileDescriptor {
    file: string;
    bytes: number;
    sha256: string;
}

interface RoundOffset {
    round: number;
    startByte: number;
    endByte: number;
    sha256: string;
}

interface RoundOffsetIndex {
    version: 1;
    entries: RoundOffset[];
}

function hasUniquePositiveRoundNumbers(index: RoundOffsetIndex, expectedCount: number): boolean {
    if (index.version !== 1 || !Array.isArray(index.entries) || index.entries.length !== expectedCount) return false;
    const roundNumbers = new Set<number>();
    for (const entry of index.entries) {
        if (!Number.isInteger(entry.round) || entry.round < 1 || roundNumbers.has(entry.round)) return false;
        roundNumbers.add(entry.round);
    }
    return true;
}

interface ConversationSourceCacheManifest {
    format: typeof CONVERSATION_SOURCE_CACHE_FORMAT;
    key: ConversationSourceCacheKey;
    generation: string;
    fingerprint: ConversationSourceFingerprint | null;
    createdAt: string;
    roundCount: number;
    files: {
        snapshot: CacheFileDescriptor;
        rounds: CacheFileDescriptor;
        roundIndex: CacheFileDescriptor;
        recordProjection?: CacheFileDescriptor;
        recordProjectionIndex?: CacheFileDescriptor;
    };
}

type CacheState = Omit<ConversationSourceCacheReadResult<unknown>, "snapshot" | "cacheState" | "buildFailure">;

const inFlightBuilds = new Map<string, Promise<ConversationSourceCacheReadResult<unknown>>>();

export function readFiniteIntegerEnv(name: string, fallback: number, minimum = 1): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && Number.isInteger(value) && value >= minimum ? value : fallback;
}

const CACHE_BUILD_LEASE_TIMEOUT_MS = Math.max(30_000, readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_CACHE_BUILD_LEASE_TIMEOUT_MS", 180_000));
const CACHE_BUILD_LEASE_STALE_MS = Math.max(60_000, readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_CACHE_BUILD_LEASE_STALE_MS", 300_000));
const CACHE_BUILD_LEASE_HEARTBEAT_MS = Math.max(1_000, Math.min(10_000, Math.floor(CACHE_BUILD_LEASE_STALE_MS / 4)));
const CACHE_BUILD_PROCESS_STARTED_AT_MS = Math.max(1, Math.round(performance.timeOrigin));
const diagnostics: Omit<ConversationSourceCacheDiagnostics, "cacheDirectory" | "inFlight"> = {
    reads: 0,
    cacheOnlyReads: 0,
    hits: 0,
    misses: 0,
    buildsStarted: 0,
    buildsCompleted: 0,
    buildsFailed: 0,
    staleFallbacks: 0,
    rangeReads: 0,
    corruptions: 0,
    cleanupFailures: 0,
    pinsCreated: 0,
    pinsReleased: 0,
};

let dataRootOverrideForTests: string | undefined;

function cacheRoot(): string {
    return path.join(dataRootOverrideForTests || DATA_ROOT, "conversation-cache", "v1");
}

function stableKey(key: ConversationSourceCacheKey): string {
    if (!key.source.trim() || !key.conversationId.trim()) {
        throw new Error("conversation source cache requires non-empty source and conversationId");
    }
    return `${key.source}\u0000${key.conversationId}`;
}

function entryDirectory(key: ConversationSourceCacheKey): string {
    const digest = createHash("sha256").update(stableKey(key), "utf8").digest("hex");
    return path.join(cacheRoot(), digest);
}

function manifestPath(key: ConversationSourceCacheKey): string {
    return path.join(entryDirectory(key), "manifest.json");
}

function buildLeasePath(key: ConversationSourceCacheKey): string {
    return path.join(entryDirectory(key), "build.lock");
}

function assertGeneration(generation: string): string {
    if (!/^[a-z0-9-]+$/iu.test(generation)) throw new Error("invalid conversation cache generation");
    return generation;
}

function generationManifestPath(key: ConversationSourceCacheKey, generation: string): string {
    return path.join(entryDirectory(key), `manifest.${assertGeneration(generation)}.json`);
}

function pinDirectory(key: ConversationSourceCacheKey): string {
    return path.join(entryDirectory(key), "pins");
}

function pinPath(key: ConversationSourceCacheKey, ownerId: string): string {
    if (!ownerId.trim()) throw new Error("conversation cache pin requires a non-empty ownerId");
    const digest = createHash("sha256").update(ownerId, "utf8").digest("hex");
    return path.join(pinDirectory(key), `${digest}.json`);
}

function normalizeFingerprint(fingerprint: ConversationSourceFingerprint | null): ConversationSourceFingerprint | null {
    if (fingerprint === null) return null;
    const normalized: ConversationSourceFingerprint = {};
    if (fingerprint.path !== undefined) normalized.path = fingerprint.path;
    if (fingerprint.size !== undefined) normalized.size = fingerprint.size;
    if (fingerprint.mtime !== undefined) normalized.mtime = fingerprint.mtime;
    if (fingerprint.revision !== undefined) normalized.revision = fingerprint.revision;
    return normalized;
}

function fingerprintsMatch(left: ConversationSourceFingerprint | null, right: ConversationSourceFingerprint | null): boolean {
    return JSON.stringify(normalizeFingerprint(left)) === JSON.stringify(normalizeFingerprint(right));
}

function sha256(value: Buffer | string): string {
    return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): string {
    const hash = createHash("sha256");
    const fileDescriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest("hex");
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

async function sha256FileAsync(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

function describeFailure(error: unknown): ConversationSourceCacheBuildFailure {
    if (error instanceof Error) return { name: error.name, message: error.message };
    return { name: "Error", message: String(error) };
}

function isCacheFileDescriptor(value: unknown): value is CacheFileDescriptor {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<CacheFileDescriptor>;
    return typeof candidate.file === "string"
        && typeof candidate.bytes === "number"
        && Number.isInteger(candidate.bytes)
        && candidate.bytes >= 0
        && typeof candidate.sha256 === "string"
        && /^[a-f0-9]{64}$/u.test(candidate.sha256);
}

function isManifest(value: unknown, key: ConversationSourceCacheKey): value is ConversationSourceCacheManifest {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<ConversationSourceCacheManifest>;
    return candidate.format === CONVERSATION_SOURCE_CACHE_FORMAT
        && candidate.key?.source === key.source
        && candidate.key?.conversationId === key.conversationId
        && typeof candidate.generation === "string"
        && typeof candidate.createdAt === "string"
        && typeof candidate.roundCount === "number"
        && Number.isInteger(candidate.roundCount)
        && candidate.roundCount >= 0
        && isCacheFileDescriptor(candidate.files?.snapshot)
        && isCacheFileDescriptor(candidate.files?.rounds)
        && isCacheFileDescriptor(candidate.files?.roundIndex)
        && (candidate.files?.recordProjection === undefined || isCacheFileDescriptor(candidate.files.recordProjection))
        && (candidate.files?.recordProjectionIndex === undefined || isCacheFileDescriptor(candidate.files.recordProjectionIndex));
}

function readManifest(key: ConversationSourceCacheKey, generation?: string): ConversationSourceCacheManifest | null {
    const filePath = generation ? generationManifestPath(key, generation) : manifestPath(key);
    if (!fs.existsSync(filePath)) return null;
    try {
        const manifest = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (!isManifest(manifest, key)) throw new Error("invalid cache manifest");
        return manifest;
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }
}

function readVerifiedFile(directory: string, descriptor: CacheFileDescriptor): Buffer | null {
    const filePath = path.join(directory, descriptor.file);
    try {
        const content = fs.readFileSync(filePath);
        if (content.byteLength !== descriptor.bytes || sha256(content) !== descriptor.sha256) {
            diagnostics.corruptions += 1;
            return null;
        }
        return content;
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }
}

function verifyFileDescriptor(directory: string, descriptor: CacheFileDescriptor): boolean {
    try {
        const filePath = path.join(directory, descriptor.file);
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size === descriptor.bytes && sha256File(filePath) === descriptor.sha256;
    } catch {
        diagnostics.corruptions += 1;
        return false;
    }
}

function verifyFileDescriptorSize(directory: string, descriptor: CacheFileDescriptor): boolean {
    try {
        const stat = fs.statSync(path.join(directory, descriptor.file));
        return stat.isFile() && stat.size === descriptor.bytes;
    } catch {
        diagnostics.corruptions += 1;
        return false;
    }
}

function cacheState(manifest: ConversationSourceCacheManifest): CacheState {
    return {
        key: { ...manifest.key },
        generation: manifest.generation,
        fingerprint: normalizeFingerprint(manifest.fingerprint),
        roundCount: manifest.roundCount,
        createdAt: manifest.createdAt,
    };
}

function readCachedInternal<TSnapshot>(
    options: ConversationSourceCacheReadOptions,
    cacheStateValue: "hit" | "built" | "stale" = "hit",
): ConversationSourceCacheReadResult<TSnapshot> | null {
    const manifest = readManifest(options.key, options.generation);
    if (!manifest) return null;
    if (options.expectedFingerprint !== undefined && !fingerprintsMatch(manifest.fingerprint, options.expectedFingerprint)) return null;

    const directory = entryDirectory(options.key);
    const snapshotBytes = readVerifiedFile(directory, manifest.files.snapshot);
    const indexBytes = readVerifiedFile(directory, manifest.files.roundIndex);
    if (!snapshotBytes || !indexBytes || !verifyFileDescriptorSize(directory, manifest.files.rounds)) return null;

    try {
        const index = JSON.parse(indexBytes.toString("utf8")) as RoundOffsetIndex;
        if (!hasUniquePositiveRoundNumbers(index, manifest.roundCount)) throw new Error("invalid round offset index");
        return {
            ...cacheState(manifest),
            snapshot: JSON.parse(snapshotBytes.toString("utf8")) as TSnapshot,
            cacheState: cacheStateValue,
        };
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }
}

function cacheFileName(kind: "snapshot" | "rounds" | "round-index" | "record-projection" | "record-projection-index", generation: string): string {
    if (kind === "snapshot") return `snapshot.${generation}.json`;
    if (kind === "rounds") return `rounds.${generation}.jsonl`;
    if (kind === "record-projection") return `record-projection.${generation}.jsonl`;
    if (kind === "record-projection-index") return `record-projection-index.${generation}.json`;
    return `round-index.${generation}.json`;
}

function serializeJson(value: unknown, description: string): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`${description} is not JSON serializable`);
    return serialized;
}

async function renameCacheArtifactWithRetry(source: string, target: string): Promise<void> {
    const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
    for (let attempt = 1; ; attempt += 1) {
        try {
            await fs.promises.rename(source, target);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (!code || !transient.has(code) || attempt >= 5) throw error;
            await sleep(10 * (2 ** (attempt - 1)));
        }
    }
}

async function writeGenerationFile(directory: string, file: string, content: string): Promise<CacheFileDescriptor> {
    const target = path.join(directory, file);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const expected = Buffer.from(content, "utf8");
    const expectedHash = sha256(expected);
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
        handle = await fs.promises.open(temporary, "wx");
        await handle.writeFile(expected);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await renameCacheArtifactWithRetry(temporary, target);
        const stat = await fs.promises.stat(target);
        const actualHash = await sha256FileAsync(target);
        if (!stat.isFile() || stat.size !== expected.byteLength || actualHash !== expectedHash) {
            throw new Error(`cache artifact verification failed: ${file}`);
        }
        return { file, bytes: stat.size, sha256: actualHash };
    } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function createConversationSourceCacheRoundSpool<TRound>(options: {
    key: ConversationSourceCacheKey;
    getRoundNumber?: (round: TRound, index: number) => number;
    projectRecordRound?: (round: TRound, index: number) => unknown;
}): ConversationSourceCacheRoundSpool<TRound> {
    const directory = entryDirectory(options.key);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.rounds-build-${process.pid}-${randomUUID()}.tmp`);
    const fileDescriptor = fs.openSync(temporaryPath, "wx");
    const contentHash = createHash("sha256");
    const recordProjectionTemporaryPath = options.projectRecordRound
        ? path.join(directory, `.record-projection-build-${process.pid}-${randomUUID()}.tmp`)
        : undefined;
    let recordProjectionFileDescriptor: number | undefined;
    try {
        recordProjectionFileDescriptor = recordProjectionTemporaryPath
            ? fs.openSync(recordProjectionTemporaryPath, "wx")
            : undefined;
    } catch (error) {
        fs.closeSync(fileDescriptor);
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
    const recordProjectionHash = recordProjectionFileDescriptor === undefined ? undefined : createHash("sha256");
    const entries: RoundOffset[] = [];
    const recordProjectionEntries: RoundOffset[] = [];
    const roundNumbers = new Set<number>();
    let byteOffset = 0;
    let recordProjectionByteOffset = 0;
    let roundCount = 0;
    let closed = false;

    const close = (): void => {
        if (closed) return;
        closed = true;
        let closeError: unknown;
        for (const descriptor of [fileDescriptor, recordProjectionFileDescriptor]) {
            if (descriptor === undefined) continue;
            try {
                fs.fsyncSync(descriptor);
            } catch (error) {
                closeError ??= error;
            }
            try {
                fs.closeSync(descriptor);
            } catch (error) {
                closeError ??= error;
            }
        }
        if (closeError) throw closeError;
    };

    return {
        append(round: TRound): void {
            if (closed) throw new Error("conversation cache round spool is already closed");
            const roundNumber = options.getRoundNumber ? options.getRoundNumber(round, roundCount) : roundCount + 1;
            if (!Number.isInteger(roundNumber) || roundNumber < 1) {
                throw new Error(`round number at index ${roundCount} must be a positive integer`);
            }
            if (roundNumbers.has(roundNumber)) {
                throw new Error(`round number ${roundNumber} is duplicated at index ${roundCount}`);
            }
            roundNumbers.add(roundNumber);
            const line = Buffer.from(`${serializeJson(round, `round at index ${roundCount}`)}\n`, "utf8");
            let written = 0;
            while (written < line.length) {
                written += fs.writeSync(fileDescriptor, line, written, line.length - written, byteOffset + written);
            }
            entries.push({
                round: roundNumber,
                startByte: byteOffset,
                endByte: byteOffset + line.length,
                sha256: sha256(line),
            });
            contentHash.update(line);
            byteOffset += line.length;
            if (options.projectRecordRound && recordProjectionFileDescriptor !== undefined && recordProjectionHash) {
                const projection = options.projectRecordRound(round, roundCount);
                const projectionLine = Buffer.from(`${serializeJson(projection, `record projection at index ${roundCount}`)}\n`, "utf8");
                let projectionWritten = 0;
                while (projectionWritten < projectionLine.length) {
                    projectionWritten += fs.writeSync(
                        recordProjectionFileDescriptor,
                        projectionLine,
                        projectionWritten,
                        projectionLine.length - projectionWritten,
                        recordProjectionByteOffset + projectionWritten,
                    );
                }
                recordProjectionHash.update(projectionLine);
                recordProjectionEntries.push({
                    round: roundNumber,
                    startByte: recordProjectionByteOffset,
                    endByte: recordProjectionByteOffset + projectionLine.length,
                    sha256: sha256(projectionLine),
                });
                recordProjectionByteOffset += projectionLine.length;
            }
            roundCount += 1;
        },
        finish(): ConversationSourceCachePreparedRounds {
            close();
            return {
                temporaryPath,
                roundCount,
                bytes: byteOffset,
                sha256: contentHash.digest("hex"),
                index: { version: 1, entries },
                recordProjection: recordProjectionTemporaryPath && recordProjectionHash
                    ? {
                        temporaryPath: recordProjectionTemporaryPath,
                        bytes: recordProjectionByteOffset,
                        sha256: recordProjectionHash.digest("hex"),
                        index: { version: 1, entries: recordProjectionEntries },
                    }
                    : undefined,
            };
        },
        abort(): void {
            try {
                close();
            } finally {
                fs.rmSync(temporaryPath, { force: true });
                if (recordProjectionTemporaryPath) fs.rmSync(recordProjectionTemporaryPath, { force: true });
            }
        },
    };
}

function removeGenerationArtifacts(directory: string, generation: string): void {
    for (const kind of ["snapshot", "rounds", "round-index", "record-projection", "record-projection-index"] as const) {
        fs.rmSync(path.join(directory, cacheFileName(kind, generation)), { force: true });
    }
    fs.rmSync(path.join(directory, `manifest.${assertGeneration(generation)}.json`), { force: true });
}

async function copyPreparedFileAcrossDevices(
    source: string,
    staging: string,
    expected: { bytes: number; sha256: string },
): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
        handle = await fs.promises.open(staging, "wx");
        for await (const chunk of fs.createReadStream(source, { highWaterMark: 1024 * 1024 })) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            let written = 0;
            while (written < buffer.length) {
                const result = await handle.write(buffer, written, buffer.length - written, null);
                written += result.bytesWritten;
            }
            hash.update(buffer);
            bytes += buffer.length;
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        const copiedHash = hash.digest("hex");
        if (bytes !== expected.bytes || copiedHash !== expected.sha256) {
            throw new Error("cross-device cache artifact copy verification failed");
        }
    } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.promises.rm(staging, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function publishPreparedFile(
    directory: string,
    file: string,
    prepared: { temporaryPath: string; bytes: number; sha256: string },
): Promise<CacheFileDescriptor> {
    const target = path.join(directory, file);
    try {
        await renameCacheArtifactWithRetry(prepared.temporaryPath, target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
        const staging = path.join(directory, `.publish-${file}-${process.pid}-${randomUUID()}.tmp`);
        await copyPreparedFileAcrossDevices(prepared.temporaryPath, staging, prepared);
        try {
            await renameCacheArtifactWithRetry(staging, target);
        } catch (renameError) {
            await fs.promises.rm(staging, { force: true }).catch(() => undefined);
            throw renameError;
        }
        await fs.promises.rm(prepared.temporaryPath, { force: true });
    }
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size !== prepared.bytes || await sha256FileAsync(target) !== prepared.sha256) {
        throw new Error(`cache artifact verification failed: ${file}`);
    }
    return { file, bytes: stat.size, sha256: prepared.sha256 };
}

function readPinnedGenerations(key: ConversationSourceCacheKey): Set<string> {
    const generations = new Set<string>();
    const directory = pinDirectory(key);
    if (!fs.existsSync(directory)) return generations;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
            const value = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")) as { generation?: unknown };
            if (typeof value.generation === "string") generations.add(assertGeneration(value.generation));
        } catch {
            diagnostics.corruptions += 1;
        }
    }
    return generations;
}

function cleanupOldGenerations(key: ConversationSourceCacheKey, directory: string, currentGeneration: string): void {
    try {
        const generations = new Map<string, number>();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith("snapshot.") || !entry.name.endsWith(".json")) continue;
            const generation = entry.name.slice("snapshot.".length, -".json".length);
            const requiredFiles = [
                cacheFileName("snapshot", generation),
                cacheFileName("rounds", generation),
                cacheFileName("round-index", generation),
            ];
            if (!requiredFiles.every((file) => fs.existsSync(path.join(directory, file)))) continue;
            generations.set(generation, fs.statSync(path.join(directory, entry.name)).mtimeMs);
        }
        const retained = new Set<string>([currentGeneration, ...readPinnedGenerations(key)]);
        const previousGeneration = Array.from(generations)
            .filter(([generation]) => generation !== currentGeneration)
            .sort((left, right) => right[1] - left[1])[0]?.[0];
        if (previousGeneration) retained.add(previousGeneration);
        for (const generation of generations.keys()) {
            if (!retained.has(generation)) removeGenerationArtifacts(directory, generation);
        }
    } catch {
        diagnostics.cleanupFailures += 1;
    }
}

async function publishGeneration<TSnapshot, TRound>(
    options: ConversationSourceCacheReadOrBuildOptions<TSnapshot, TRound>,
    built: ConversationSourceCacheBuildResult<TSnapshot, TRound>,
    assertLeaseHeld?: () => Promise<void>,
): Promise<ConversationSourceCacheReadResult<TSnapshot>> {
    const directory = entryDirectory(options.key);
    await fs.promises.mkdir(directory, { recursive: true });
    const generation = `${Date.now().toString(36)}-${randomUUID()}`;
    let preparedRounds = built.preparedRounds;
    try {
        const snapshot = await writeGenerationFile(directory, cacheFileName("snapshot", generation), serializeJson(built.snapshot, "snapshot"));
        if (!preparedRounds) {
            if (!built.rounds) throw new Error("conversation cache build result is missing rounds");
            const spool = createConversationSourceCacheRoundSpool<TRound>({
                key: options.key,
                getRoundNumber: options.getRoundNumber,
                projectRecordRound: options.projectRecordRound,
            });
            try {
                for (const round of built.rounds) spool.append(round);
                preparedRounds = spool.finish();
            } catch (error) {
                spool.abort();
                throw error;
            }
        }
        if (options.projectRecordRound && !preparedRounds.recordProjection) {
            throw new Error("prepared conversation cache rounds are missing the required Record projection");
        }
        const roundsFile = await publishPreparedFile(directory, cacheFileName("rounds", generation), preparedRounds);
        const roundIndex = await writeGenerationFile(
            directory,
            cacheFileName("round-index", generation),
            serializeJson(preparedRounds.index, "round offset index"),
        );
        const recordProjection = preparedRounds.recordProjection
            ? await publishPreparedFile(
                directory,
                cacheFileName("record-projection", generation),
                preparedRounds.recordProjection,
            )
            : undefined;
        const recordProjectionIndex = preparedRounds.recordProjection
            ? await writeGenerationFile(
                directory,
                cacheFileName("record-projection-index", generation),
                serializeJson(preparedRounds.recordProjection.index, "Record projection offset index"),
            )
            : undefined;
        const manifest: ConversationSourceCacheManifest = {
            format: CONVERSATION_SOURCE_CACHE_FORMAT,
            key: { ...options.key },
            generation,
            fingerprint: normalizeFingerprint(options.fingerprint),
            createdAt: new Date().toISOString(),
            roundCount: preparedRounds.roundCount,
            files: { snapshot, rounds: roundsFile, roundIndex, recordProjection, recordProjectionIndex },
        };
        await writeJsonAtomicAsync(generationManifestPath(options.key, generation), manifest);
        const assertPublicationAllowed = async (): Promise<void> => {
            await assertLeaseHeld?.();
            await options.assertPublishable?.();
        };
        await writeJsonAtomicAsync(manifestPath(options.key), manifest, {
            beforeCommit: assertPublicationAllowed,
            afterCommit: assertPublicationAllowed,
            rollbackOnAfterCommitFailure: true,
        });
        cleanupOldGenerations(options.key, directory, generation);
        return {
            ...cacheState(manifest),
            snapshot: built.snapshot,
            cacheState: "built",
        };
    } catch (error) {
        if (preparedRounds) {
            fs.rmSync(preparedRounds.temporaryPath, { force: true });
            if (preparedRounds.recordProjection) fs.rmSync(preparedRounds.recordProjection.temporaryPath, { force: true });
        }
        try {
            removeGenerationArtifacts(directory, generation);
        } catch {
            diagnostics.cleanupFailures += 1;
        }
        throw error;
    }
}

export function readCachedConversationSourceCache<TSnapshot = unknown>(
    options: ConversationSourceCacheReadOptions,
): ConversationSourceCacheReadResult<TSnapshot> | null {
    diagnostics.reads += 1;
    const cached = readCachedInternal<TSnapshot>(options);
    if (cached) diagnostics.hits += 1;
    else diagnostics.misses += 1;
    return cached;
}

export function readConversationSourceCacheOnly<TSnapshot = unknown>(
    options: ConversationSourceCacheReadOptions,
): ConversationSourceCacheReadResult<TSnapshot> | null {
    diagnostics.cacheOnlyReads += 1;
    return readCachedConversationSourceCache<TSnapshot>(options);
}

export function iterateCachedConversationSourceCacheRounds<TRound = unknown>(
    options: ConversationSourceCacheRoundRange,
): ConversationSourceCacheRoundIterable<TRound> | null {
    diagnostics.rangeReads += 1;
    const manifest = readManifest(options.key, options.generation);
    if (!manifest) return null;
    if (options.expectedFingerprint !== undefined && !fingerprintsMatch(manifest.fingerprint, options.expectedFingerprint)) return null;

    const directory = entryDirectory(options.key);
    const indexBytes = readVerifiedFile(directory, manifest.files.roundIndex);
    if (!indexBytes) return null;

    let index: RoundOffsetIndex;
    try {
        index = JSON.parse(indexBytes.toString("utf8")) as RoundOffsetIndex;
        if (!hasUniquePositiveRoundNumbers(index, manifest.roundCount)) throw new Error("invalid round offset index");
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }

    const startRound = options.startRound ?? 1;
    const endRound = options.endRound ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(startRound) || startRound < 1 || (Number.isFinite(endRound) && (!Number.isInteger(endRound) || endRound < startRound))) {
        throw new Error("round range must use positive integer bounds with endRound >= startRound");
    }

    const selected = index.entries.filter((entry) => entry.round >= startRound && entry.round <= endRound);
    const roundsPath = path.join(directory, manifest.files.rounds.file);
    try {
        const stat = fs.statSync(roundsPath);
        if (!stat.isFile() || stat.size !== manifest.files.rounds.bytes) throw new Error("round data file size mismatch");
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }

    return {
        ...cacheState(manifest),
        roundsBytes: manifest.files.rounds.bytes,
        roundsSha256: manifest.files.rounds.sha256,
        recordProjection: manifest.files.recordProjection
            ? {
                bytes: manifest.files.recordProjection.bytes,
                sha256: manifest.files.recordProjection.sha256,
            }
            : undefined,
        rounds: {
            *[Symbol.iterator](): Iterator<TRound> {
                let fileDescriptor: number | undefined;
                try {
                    fileDescriptor = fs.openSync(roundsPath, "r");
                    for (const entry of selected) {
                        if (!Number.isInteger(entry.startByte) || !Number.isInteger(entry.endByte) || entry.startByte < 0 || entry.endByte <= entry.startByte) {
                            throw new Error("invalid round byte offset");
                        }
                        const content = Buffer.alloc(entry.endByte - entry.startByte);
                        const bytesRead = fs.readSync(fileDescriptor, content, 0, content.byteLength, entry.startByte);
                        if (bytesRead !== content.byteLength || sha256(content) !== entry.sha256) throw new Error("round data checksum mismatch");
                        yield JSON.parse(content.toString("utf8")) as TRound;
                    }
                } catch (error) {
                    diagnostics.corruptions += 1;
                    throw error;
                } finally {
                    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
                }
            },
        },
    };
}

export function readCachedConversationSourceCacheRounds<TRound = unknown>(
    options: ConversationSourceCacheRoundRange,
): ConversationSourceCacheRoundsResult<TRound> | null {
    const iterable = iterateCachedConversationSourceCacheRounds<TRound>(options);
    if (!iterable) return null;
    try {
        return { ...iterable, rounds: Array.from(iterable.rounds) };
    } catch {
        return null;
    }
}

export function readConversationSourceCacheRecordProjection<TProjection = unknown>(
    options: ConversationSourceCacheRoundRange,
): ConversationSourceCacheRecordProjectionResult<TProjection> | null {
    const manifest = readManifest(options.key, options.generation);
    if (!manifest?.files.recordProjection) return null;
    if (options.expectedFingerprint !== undefined && !fingerprintsMatch(manifest.fingerprint, options.expectedFingerprint)) return null;
    const startRound = options.startRound ?? 1;
    const endRound = options.endRound ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(startRound) || startRound < 1 || (Number.isFinite(endRound) && (!Number.isInteger(endRound) || endRound < startRound))) {
        throw new Error("Record projection round range must use positive integer bounds with endRound >= startRound");
    }
    const directory = entryDirectory(options.key);
    try {
        let projections: TProjection[];
        let materializedStartRound = startRound;
        let materializedEndRound = Math.min(manifest.roundCount, Number.isFinite(endRound) ? endRound : manifest.roundCount);
        if (manifest.files.recordProjectionIndex) {
            const indexBytes = readVerifiedFile(directory, manifest.files.recordProjectionIndex);
            if (!indexBytes) return null;
            const index = JSON.parse(indexBytes.toString("utf8")) as RoundOffsetIndex;
            if (!hasUniquePositiveRoundNumbers(index, manifest.roundCount)) {
                throw new Error("Record projection offset index is invalid");
            }
            const selected = index.entries.filter(entry => entry.round >= startRound && entry.round <= endRound);
            const projectionPath = path.join(directory, manifest.files.recordProjection.file);
            const stat = fs.statSync(projectionPath);
            if (!stat.isFile() || stat.size !== manifest.files.recordProjection.bytes) throw new Error("Record projection file size mismatch");
            const fileDescriptor = fs.openSync(projectionPath, "r");
            try {
                projections = selected.map(entry => {
                    const content = Buffer.alloc(entry.endByte - entry.startByte);
                    const bytesRead = fs.readSync(fileDescriptor, content, 0, content.byteLength, entry.startByte);
                    if (bytesRead !== content.byteLength || sha256(content) !== entry.sha256) {
                        throw new Error("Record projection line checksum mismatch");
                    }
                    return JSON.parse(content.toString("utf8")) as TProjection;
                });
            } finally {
                fs.closeSync(fileDescriptor);
            }
            materializedStartRound = selected[0]?.round ?? startRound;
            materializedEndRound = selected[selected.length - 1]?.round ?? Math.min(startRound - 1, manifest.roundCount);
        } else {
            const content = readVerifiedFile(directory, manifest.files.recordProjection);
            if (!content) return null;
            const text = content.toString("utf8");
            const all = text.length === 0
                ? []
                : text.split("\n").filter(line => line.length > 0).map(line => JSON.parse(line) as TProjection);
            if (all.length !== manifest.roundCount) throw new Error("Record projection round count mismatch");
            projections = all.slice(startRound - 1, Number.isFinite(endRound) ? endRound : undefined);
        }
        return {
            ...cacheState(manifest),
            bytes: manifest.files.recordProjection.bytes,
            sha256: manifest.files.recordProjection.sha256,
            materializedStartRound,
            materializedEndRound,
            projections,
        };
    } catch {
        diagnostics.corruptions += 1;
        return null;
    }
}

export function getConversationSourceCacheGenerationKind(
    input: ConversationSourceCacheGenerationRef,
): "missing" | "legacy" | "projection" {
    const manifest = readManifest(input.key, input.generation);
    if (!manifest || !fingerprintsMatch(manifest.fingerprint, input.fingerprint)) return "missing";
    return manifest.files.recordProjection && manifest.files.recordProjectionIndex
        ? "projection"
        : "legacy";
}

interface ConversationCacheBuildLeaseMetadata {
    version: 1;
    key: ConversationSourceCacheKey;
    token: string;
    ownerPid: number;
    ownerStartedAtMs: number;
    acquiredAt: string;
}

interface ConversationCacheBuildLeaseSnapshot {
    metadata: ConversationCacheBuildLeaseMetadata | null;
    raw: string;
    mtimeMs: number;
    size: number;
}

interface ConversationCacheBuildLease {
    assertHeld(): Promise<void>;
    release(): Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseConversationCacheBuildLease(raw: string, key: ConversationSourceCacheKey): ConversationCacheBuildLeaseMetadata | null {
    try {
        const value = JSON.parse(raw) as Partial<ConversationCacheBuildLeaseMetadata>;
        if (value.version !== 1
            || value.key?.source !== key.source
            || value.key?.conversationId !== key.conversationId
            || typeof value.token !== "string"
            || value.token.length === 0
            || !Number.isSafeInteger(value.ownerPid)
            || (value.ownerPid || 0) < 1
            || !Number.isSafeInteger(value.ownerStartedAtMs)
            || (value.ownerStartedAtMs || 0) < 1
            || typeof value.acquiredAt !== "string") return null;
        return value as ConversationCacheBuildLeaseMetadata;
    } catch {
        return null;
    }
}

async function readConversationCacheBuildLeaseSnapshot(
    key: ConversationSourceCacheKey,
): Promise<ConversationCacheBuildLeaseSnapshot | null> {
    const lockPath = buildLeasePath(key);
    try {
        const [raw, stat] = await Promise.all([
            fs.promises.readFile(lockPath, "utf8"),
            fs.promises.stat(lockPath),
        ]);
        return {
            metadata: parseConversationCacheBuildLease(raw, key),
            raw,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        };
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
}

function sameConversationCacheBuildLeaseSnapshot(
    left: ConversationCacheBuildLeaseSnapshot,
    right: ConversationCacheBuildLeaseSnapshot,
): boolean {
    return left.raw === right.raw && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function isConversationCacheBuildLeaseOwnerDefinitelyDead(metadata: ConversationCacheBuildLeaseMetadata | null): boolean {
    if (!metadata) return false;
    if (metadata.ownerPid === process.pid) {
        return Math.abs(metadata.ownerStartedAtMs - CACHE_BUILD_PROCESS_STARTED_AT_MS) > 2_000;
    }
    try {
        process.kill(metadata.ownerPid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "ESRCH";
    }
}

async function breakStaleConversationCacheBuildLease(key: ConversationSourceCacheKey): Promise<void> {
    const observed = await readConversationCacheBuildLeaseSnapshot(key);
    if (!observed) return;
    const observedOwnerDead = isConversationCacheBuildLeaseOwnerDefinitelyDead(observed.metadata);
    if (!observedOwnerDead) return;
    await sleep(25);
    const confirmed = await readConversationCacheBuildLeaseSnapshot(key);
    const confirmedOwnerDead = isConversationCacheBuildLeaseOwnerDefinitelyDead(confirmed?.metadata || null);
    if (!confirmed
        || !sameConversationCacheBuildLeaseSnapshot(observed, confirmed)
        || !confirmedOwnerDead) return;
    const lockPath = buildLeasePath(key);
    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    const cleanupCutoffMs = Date.now();
    try {
        await fs.promises.rename(lockPath, quarantinePath);
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST") || isErrno(error, "EPERM") || isErrno(error, "EACCES")) return;
        throw error;
    }
    const quarantined = await (async () => {
        try {
            const [raw, stat] = await Promise.all([
                fs.promises.readFile(quarantinePath, "utf8"),
                fs.promises.stat(quarantinePath),
            ]);
            return { metadata: parseConversationCacheBuildLease(raw, key), raw, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
            return null;
        }
    })();
    if (!quarantined || !sameConversationCacheBuildLeaseSnapshot(confirmed, quarantined)) {
        let restoredOrSuperseded = false;
        try {
            await fs.promises.link(quarantinePath, lockPath);
            restoredOrSuperseded = true;
        } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
            restoredOrSuperseded = true;
        }
        if (restoredOrSuperseded) await fs.promises.rm(quarantinePath, { force: true });
        return;
    }
    const deadOwner = confirmedOwnerDead ? quarantined.metadata : null;
    if (deadOwner) await removeConversationCacheBuildTemporaryFiles(key, deadOwner, cleanupCutoffMs);
    await fs.promises.rm(quarantinePath, { force: true });
}

async function removeOwnedConversationCacheBuildLease(
    key: ConversationSourceCacheKey,
    token: string,
): Promise<void> {
    const lockPath = buildLeasePath(key);
    const snapshot = await readConversationCacheBuildLeaseSnapshot(key);
    if (!snapshot?.metadata || snapshot.metadata.token !== token) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await fs.promises.rm(lockPath, { force: true });
            return;
        } catch (error) {
            if (isErrno(error, "ENOENT")) return;
            lastError = error;
            if (attempt < 2) await sleep(10 * (attempt + 1));
        }
    }
    const confirmed = await readConversationCacheBuildLeaseSnapshot(key);
    if (!confirmed?.metadata || confirmed.metadata.token !== token) return;
    const quarantinePath = `${lockPath}.released-${token}-${randomUUID()}`;
    try {
        await fs.promises.rename(lockPath, quarantinePath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw lastError || error;
    }
    try {
        await fs.promises.rm(quarantinePath, { force: true });
    } catch {
        diagnostics.cleanupFailures += 1;
    }
}

async function removeConversationCacheBuildTemporaryFiles(
    key: ConversationSourceCacheKey,
    owner: ConversationCacheBuildLeaseMetadata,
    cleanupCutoffMs: number,
): Promise<void> {
    const directory = entryDirectory(key);
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
    }
    const exactBuildLock = `.build-lock-${owner.ownerPid}-${owner.token}.tmp`;
    const atomicWriteMarker = `.tmp-${owner.ownerPid}-`;
    const prefixes = [
        `.rounds-build-${owner.ownerPid}-`,
        `.record-projection-build-${owner.ownerPid}-`,
    ];
    await Promise.all(entries.map(async entry => {
        if (!entry.isFile()
            || (entry.name !== exactBuildLock
                && !prefixes.some(prefix => entry.name.startsWith(prefix))
                && !entry.name.includes(atomicWriteMarker))) return;
        const filePath = path.join(directory, entry.name);
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return;
            throw error;
        }
        if (stat.mtimeMs > cleanupCutoffMs || (stat.birthtimeMs > 0 && stat.birthtimeMs > cleanupCutoffMs)) return;
        await fs.promises.rm(filePath, { force: true });
    }));
}

async function tryAcquireConversationCacheBuildLease(
    key: ConversationSourceCacheKey,
): Promise<ConversationCacheBuildLease | null> {
    const directory = entryDirectory(key);
    const lockPath = buildLeasePath(key);
    const token = randomUUID();
    const temporaryPath = path.join(directory, `.build-lock-${process.pid}-${token}.tmp`);
    const metadata: ConversationCacheBuildLeaseMetadata = {
        version: 1,
        key: { ...key },
        token,
        ownerPid: process.pid,
        ownerStartedAtMs: CACHE_BUILD_PROCESS_STARTED_AT_MS,
        acquiredAt: new Date().toISOString(),
    };
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryHandle = await fs.promises.open(temporaryPath, "wx");
    let temporaryPreparationError: unknown;
    try {
        await temporaryHandle.writeFile(JSON.stringify(metadata), "utf8");
        await temporaryHandle.sync();
    } catch (error) {
        temporaryPreparationError = error;
    }
    try {
        await temporaryHandle.close();
    } catch (error) {
        temporaryPreparationError ||= error;
    }
    if (temporaryPreparationError) {
        try {
            await fs.promises.rm(temporaryPath, { force: true });
        } catch {
            diagnostics.cleanupFailures += 1;
        }
        throw temporaryPreparationError;
    }
    try {
        await fs.promises.link(temporaryPath, lockPath);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true });
        if (isErrno(error, "EEXIST")) return null;
        throw error;
    }
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
        await fs.promises.rm(temporaryPath, { force: true });
        handle = await fs.promises.open(lockPath, "r+");
        await handle.close();
        handle = undefined;
    } catch (error) {
        if (handle) {
            try {
                await handle.close();
            } catch {
                diagnostics.cleanupFailures += 1;
            }
        }
        await fs.promises.rm(temporaryPath, { force: true });
        await removeOwnedConversationCacheBuildLease(key, token);
        throw error;
    }
    let released = false;
    let heartbeatFailure: unknown;
    let heartbeatInFlight = false;
    const assertHeld = async (): Promise<void> => {
        if (released) throw new Error("conversation cache build lease has been released");
        const snapshot = await readConversationCacheBuildLeaseSnapshot(key);
        if (!snapshot?.metadata || snapshot.metadata.token !== token) {
            throw new Error(`conversation cache build lease lost for ${key.source}/${key.conversationId}`);
        }
    };
    const timer = setInterval(() => {
        if (heartbeatInFlight || heartbeatFailure || released) return;
        heartbeatInFlight = true;
        const now = new Date();
        void fs.promises.utimes(lockPath, now, now)
            .then(assertHeld)
            .catch(error => { heartbeatFailure = error; })
            .finally(() => { heartbeatInFlight = false; });
    }, CACHE_BUILD_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return {
        async assertHeld(): Promise<void> {
            if (heartbeatFailure) throw heartbeatFailure;
            await assertHeld();
        },
        async release(): Promise<void> {
            if (released) return;
            released = true;
            clearInterval(timer);
            await removeOwnedConversationCacheBuildLease(key, token);
        },
    };
}

async function acquireConversationCacheBuildLease(key: ConversationSourceCacheKey): Promise<ConversationCacheBuildLease> {
    const deadline = Date.now() + CACHE_BUILD_LEASE_TIMEOUT_MS;
    for (;;) {
        const lease = await tryAcquireConversationCacheBuildLease(key);
        if (lease) return lease;
        await breakStaleConversationCacheBuildLease(key);
        if (Date.now() >= deadline) throw new Error(`conversation cache build lease timed out for ${key.source}/${key.conversationId}`);
        await sleep(50);
    }
}

async function buildConversationSourceCacheWithLease<TSnapshot, TRound>(
    options: ConversationSourceCacheReadOrBuildOptions<TSnapshot, TRound>,
    baselineGeneration: string | undefined,
): Promise<ConversationSourceCacheReadResult<TSnapshot>> {
    const deadline = Date.now() + CACHE_BUILD_LEASE_TIMEOUT_MS;
    for (;;) {
        const lease = await tryAcquireConversationCacheBuildLease(options.key);
        if (lease) {
            try {
                await lease.assertHeld();
                const reused = readCachedInternal<TSnapshot>({ key: options.key, expectedFingerprint: options.fingerprint });
                if (reused && (!options.refresh || reused.generation !== baselineGeneration)) {
                    diagnostics.hits += 1;
                    return reused;
                }
                diagnostics.buildsStarted += 1;
                const built = await options.build();
                await lease.assertHeld();
                const published = await publishGeneration(options, built, lease.assertHeld);
                await lease.assertHeld();
                diagnostics.buildsCompleted += 1;
                return published;
            } catch (error) {
                diagnostics.buildsFailed += 1;
                throw error;
            } finally {
                await lease.release();
            }
        }
        const completed = readCachedInternal<TSnapshot>({ key: options.key, expectedFingerprint: options.fingerprint });
        if (completed && (!options.refresh || completed.generation !== baselineGeneration)) {
            diagnostics.hits += 1;
            return completed;
        }
        await breakStaleConversationCacheBuildLease(options.key);
        if (Date.now() >= deadline) throw new Error(`conversation cache build lease timed out for ${options.key.source}/${options.key.conversationId}`);
        await sleep(50);
    }
}

export function readOrBuildConversationSourceCache<TSnapshot, TRound>(
    options: ConversationSourceCacheReadOrBuildOptions<TSnapshot, TRound>,
): Promise<ConversationSourceCacheReadResult<TSnapshot>> {
    const baselineGeneration = readCachedInternal<TSnapshot>({ key: options.key })?.generation;
    if (!options.refresh) {
        const existing = readCachedConversationSourceCache<TSnapshot>({
            key: options.key,
            expectedFingerprint: options.fingerprint,
        });
        if (existing) return Promise.resolve(existing);
    }

    const flightKey = stableKey(options.key);
    const running = inFlightBuilds.get(flightKey);
    if (running) {
        return running.then((result) => {
            if (fingerprintsMatch(result.fingerprint, options.fingerprint)) {
                return result as ConversationSourceCacheReadResult<TSnapshot>;
            }
            return readOrBuildConversationSourceCache(options);
        });
    }

    let resolveFlight!: (value: ConversationSourceCacheReadResult<unknown>) => void;
    let rejectFlight!: (reason?: unknown) => void;
    const flight = new Promise<ConversationSourceCacheReadResult<unknown>>((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
    });
    inFlightBuilds.set(flightKey, flight);

    void (async () => {
        try {
            resolveFlight(await buildConversationSourceCacheWithLease(options, baselineGeneration));
        } catch (error) {
            const fallback = readCachedInternal<TSnapshot>({ key: options.key });
            if (fallback) {
                diagnostics.staleFallbacks += 1;
                resolveFlight({ ...fallback, cacheState: "stale", buildFailure: describeFailure(error) });
                return;
            }
            rejectFlight(error);
        } finally {
            inFlightBuilds.delete(flightKey);
        }
    })();

    return flight as Promise<ConversationSourceCacheReadResult<TSnapshot>>;
}

export async function pinConversationSourceCacheGeneration(input: ConversationSourceCachePin): Promise<ConversationSourceCacheGenerationRef> {
    const lease = await acquireConversationCacheBuildLease(input.key);
    try {
        const manifest = readManifest(input.key, input.generation);
        if (!manifest || !fingerprintsMatch(manifest.fingerprint, input.fingerprint)) {
            throw new Error("conversation cache generation is missing or its fingerprint changed");
        }
        const directory = entryDirectory(input.key);
        const complete = [manifest.files.rounds, manifest.files.snapshot, manifest.files.roundIndex, manifest.files.recordProjection, manifest.files.recordProjectionIndex]
            .filter((descriptor): descriptor is CacheFileDescriptor => descriptor !== undefined)
            .every((descriptor) => verifyFileDescriptorSize(directory, descriptor));
        if (!complete) throw new Error("conversation cache generation is incomplete or corrupted");
        fs.mkdirSync(pinDirectory(input.key), { recursive: true });
        writeJsonAtomic(pinPath(input.key, input.ownerId), {
            version: 1,
            generation: manifest.generation,
            createdAt: new Date().toISOString(),
        });
        diagnostics.pinsCreated += 1;
        return { key: { ...manifest.key }, generation: manifest.generation, fingerprint: normalizeFingerprint(manifest.fingerprint) };
    } finally {
        await lease.release();
    }
}

export async function releaseConversationSourceCacheGenerationPin(input: { key: ConversationSourceCacheKey; ownerId: string }): Promise<void> {
    const lease = await acquireConversationCacheBuildLease(input.key);
    try {
        const filePath = pinPath(input.key, input.ownerId);
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { force: true });
            diagnostics.pinsReleased += 1;
        }
        const current = readManifest(input.key);
        if (current) cleanupOldGenerations(input.key, entryDirectory(input.key), current.generation);
    } finally {
        await lease.release();
    }
}

export async function releaseConversationSourceCacheGenerationPinsForOwner(ownerId: string): Promise<number> {
    if (!ownerId.trim()) throw new Error("conversation cache pin requires a non-empty ownerId");
    const root = cacheRoot();
    if (!fs.existsSync(root)) return 0;
    const pinName = `${createHash("sha256").update(ownerId, "utf8").digest("hex")}.json`;
    let released = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(root, entry.name);
        const filePath = path.join(directory, "pins", pinName);
        if (!fs.existsSync(filePath)) continue;
        let key: ConversationSourceCacheKey | undefined;
        try {
            const rawManifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as Partial<ConversationSourceCacheManifest>;
            const candidate = rawManifest.key;
            if (candidate && typeof candidate.source === "string" && typeof candidate.conversationId === "string" && entryDirectory(candidate) === directory) key = candidate;
        } catch {
            diagnostics.corruptions += 1;
        }
        if (key) {
            await releaseConversationSourceCacheGenerationPin({ key, ownerId });
        } else {
            fs.rmSync(filePath, { force: true });
            diagnostics.pinsReleased += 1;
        }
        released += 1;
    }
    return released;
}

export function getConversationSourceCacheDiagnostics(): ConversationSourceCacheDiagnostics {
    return {
        cacheDirectory: cacheRoot(),
        inFlight: inFlightBuilds.size,
        ...diagnostics,
    };
}

export function getConversationSourceCacheEntryDirectory(key: ConversationSourceCacheKey): string {
    return entryDirectory(key);
}

export function setConversationSourceCacheDataRootForTests(dataRoot: string | undefined): void {
    dataRootOverrideForTests = dataRoot;
}

export function resetConversationSourceCacheForTests(): void {
    inFlightBuilds.clear();
    for (const key of Object.keys(diagnostics) as Array<keyof typeof diagnostics>) diagnostics[key] = 0;
    dataRootOverrideForTests = undefined;
}

export const readOrBuild = readOrBuildConversationSourceCache;
export const readCached = readCachedConversationSourceCache;
export const readCachedRounds = readCachedConversationSourceCacheRounds;
export const readCacheOnly = readConversationSourceCacheOnly;
