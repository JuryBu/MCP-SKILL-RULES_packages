import crypto from "crypto";
import fs from "fs";
import path from "path";
import { StringDecoder } from "string_decoder";
import { DATA_ROOT } from "./temp-store.js";

export const DEFAULT_OUTPUT_ARTIFACT_TTL_MS = 6 * 60 * 60 * 1000;
export const OUTPUT_ARTIFACT_ROOT = path.join(DATA_ROOT, "output-artifacts");

export type OutputArtifactChannel = "stdout" | "stderr";
export type OutputArtifactStatus = "running" | "done" | "error" | "interrupted";

export interface OutputArtifactChannelStats {
    rawBytes: number;
    lines: number;
    sha256: string;
    estimatedTokens: number;
}

export interface OutputArtifactFile extends OutputArtifactChannelStats {
    path: string;
}

export interface OutputArtifactManifest {
    version: 1;
    artifactId: string;
    status: OutputArtifactStatus;
    complete: boolean;
    createdAt: string;
    completedAt: string | null;
    expiresAt: string;
    files: Record<OutputArtifactChannel, OutputArtifactFile>;
    readHint: string;
    error: string | null;
}

export interface CreateOutputArtifactOptions {
    artifactId?: string;
    ttlMs?: number;
    writeHighWaterMarkBytes?: number;
    readHint?: string;
}

export interface FinalizeOutputArtifactOptions {
    status?: Exclude<OutputArtifactStatus, "running">;
    stats: Record<OutputArtifactChannel, OutputArtifactChannelStats>;
    readHint?: string;
    error?: string;
}

export interface OutputArtifactCleanupResult {
    removed: number;
    retained: number;
    invalid: number;
}

export interface OutputArtifactStats {
    runs: number;
    complete: number;
    incomplete: number;
    invalid: number;
    payloadBytes: number;
}

function safeArtifactId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
        throw new Error("artifactId must be a safe 1-128 character file name");
    }
    return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function configuredTtlMs(): number {
    const configured = Number(process.env.SANDBOX_OUTPUT_ARTIFACT_TTL_MS);
    return positiveInteger(configured, DEFAULT_OUTPUT_ARTIFACT_TTL_MS);
}

function expiresFrom(timestamp: string, ttlMs: number): string {
    return new Date(Date.parse(timestamp) + ttlMs).toISOString();
}

function boundedText(value: string | undefined, maxBytes = 4096): string {
    if (!value) return "";
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length <= maxBytes) return value;
    return new StringDecoder("utf8").write(buffer.subarray(0, maxBytes));
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: fs.promises.FileHandle | null = null;
    try {
        handle = await fs.promises.open(temporary, "wx");
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, filePath);
    } finally {
        if (handle) await handle.close().catch(() => undefined);
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
}

function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        stream.write(chunk, (error) => error ? reject(error) : resolve());
    });
}

function endAndWaitForClose(stream: fs.WriteStream, streamError: () => Error | null): Promise<void> {
    if (stream.closed) {
        const error = streamError();
        return error ? Promise.reject(error) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const onClose = () => {
            const error = streamError();
            if (error) reject(error);
            else resolve();
        };
        stream.once("close", onClose);
        if (!stream.writableEnded) stream.end();
    });
}

export class OutputArtifactRun {
    readonly artifactId: string;
    readonly directory: string;
    readonly manifestPath: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly createdAt: string;

    private readonly ttlMs: number;
    private readonly streams: Record<OutputArtifactChannel, fs.WriteStream>;
    private readonly streamErrors: Record<OutputArtifactChannel, Error | null> = { stdout: null, stderr: null };
    private readonly pendingWrites: Record<OutputArtifactChannel, Promise<void>> = {
        stdout: Promise.resolve(),
        stderr: Promise.resolve(),
    };
    private initialReadHint: string;
    private finalizePromise: Promise<OutputArtifactManifest> | null = null;

    constructor(
        artifactId: string,
        directory: string,
        ttlMs: number,
        writeHighWaterMarkBytes: number,
        readHint: string,
    ) {
        this.artifactId = artifactId;
        this.directory = directory;
        this.manifestPath = path.join(directory, "manifest.json");
        this.stdoutPath = path.join(directory, "stdout.bin");
        this.stderrPath = path.join(directory, "stderr.bin");
        this.createdAt = new Date().toISOString();
        this.ttlMs = ttlMs;
        this.initialReadHint = boundedText(readHint);
        this.streams = {
            stdout: fs.createWriteStream(this.stdoutPath, { flags: "wx", highWaterMark: writeHighWaterMarkBytes }),
            stderr: fs.createWriteStream(this.stderrPath, { flags: "wx", highWaterMark: writeHighWaterMarkBytes }),
        };
        for (const channel of ["stdout", "stderr"] as const) {
            this.streams[channel].on("error", (error) => {
                this.streamErrors[channel] = error;
            });
        }
    }

    async initialize(): Promise<void> {
        const emptyHash = crypto.createHash("sha256").digest("hex");
        const emptyStats: OutputArtifactChannelStats = { rawBytes: 0, lines: 0, sha256: emptyHash, estimatedTokens: 0 };
        await atomicWriteJson(this.manifestPath, {
            version: 1,
            artifactId: this.artifactId,
            status: "running",
            complete: false,
            createdAt: this.createdAt,
            completedAt: null,
            expiresAt: expiresFrom(this.createdAt, this.ttlMs),
            files: {
                stdout: { path: this.stdoutPath, ...emptyStats },
                stderr: { path: this.stderrPath, ...emptyStats },
            },
            readHint: this.initialReadHint,
            error: null,
        } satisfies OutputArtifactManifest);
    }

    write(channel: OutputArtifactChannel, chunk: Buffer): Promise<void> {
        if (this.finalizePromise) return Promise.reject(new Error("output artifact is already finalizing"));
        const next = this.pendingWrites[channel].then(() => writeChunk(this.streams[channel], chunk));
        this.pendingWrites[channel] = next;
        return next;
    }

    finalize(options: FinalizeOutputArtifactOptions): Promise<OutputArtifactManifest> {
        if (!this.finalizePromise) this.finalizePromise = this.finalizeInternal(options);
        return this.finalizePromise;
    }

    async discard(): Promise<void> {
        if (!this.finalizePromise) throw new Error("output artifact must be finalized before discard");
        await this.finalizePromise;
        await fs.promises.rm(this.directory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
        });
    }

    private async finalizeInternal(options: FinalizeOutputArtifactOptions): Promise<OutputArtifactManifest> {
        const writeResults = await Promise.allSettled([this.pendingWrites.stdout, this.pendingWrites.stderr]);
        const closeResults = await Promise.allSettled([
            endAndWaitForClose(this.streams.stdout, () => this.streamErrors.stdout),
            endAndWaitForClose(this.streams.stderr, () => this.streamErrors.stderr),
        ]);
        const failure = [...writeResults, ...closeResults].find((result): result is PromiseRejectedResult => result.status === "rejected");
        const completedAt = new Date().toISOString();
        const error = boundedText(failure ? String(failure.reason) : options.error);
        const status = failure ? "error" : options.status || "done";
        const readHint = boundedText(options.readHint || this.initialReadHint || `Read ${this.manifestPath} for output file metadata.`);
        const manifest: OutputArtifactManifest = {
            version: 1,
            artifactId: this.artifactId,
            status,
            complete: true,
            createdAt: this.createdAt,
            completedAt,
            expiresAt: expiresFrom(completedAt, this.ttlMs),
            files: {
                stdout: { path: this.stdoutPath, ...options.stats.stdout },
                stderr: { path: this.stderrPath, ...options.stats.stderr },
            },
            readHint,
            error: error || null,
        };
        await atomicWriteJson(this.manifestPath, manifest);
        if (failure) throw failure.reason;
        return manifest;
    }
}

export async function createOutputArtifactRun(options: CreateOutputArtifactOptions = {}): Promise<OutputArtifactRun> {
    const artifactId = safeArtifactId(options.artifactId || crypto.randomUUID());
    const directory = path.join(OUTPUT_ARTIFACT_ROOT, artifactId);
    await fs.promises.mkdir(OUTPUT_ARTIFACT_ROOT, { recursive: true });
    await fs.promises.mkdir(directory, { recursive: false });
    const run = new OutputArtifactRun(
        artifactId,
        directory,
        positiveInteger(options.ttlMs, configuredTtlMs()),
        positiveInteger(options.writeHighWaterMarkBytes, 64 * 1024),
        options.readHint || "",
    );
    try {
        await run.initialize();
        return run;
    } catch (error) {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function cleanExpiredOutputArtifacts(nowMs = Date.now(), removeIncomplete = false): Promise<OutputArtifactCleanupResult> {
    const result: OutputArtifactCleanupResult = { removed: 0, retained: 0, invalid: 0 };
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(OUTPUT_ARTIFACT_ROOT, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(OUTPUT_ARTIFACT_ROOT, entry.name);
        const manifestPath = path.join(directory, "manifest.json");
        try {
            const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as Partial<OutputArtifactManifest>;
            const expiresAt = typeof manifest.expiresAt === "string" ? Date.parse(manifest.expiresAt) : Number.NaN;
            if ((manifest.complete === true || removeIncomplete) && Number.isFinite(expiresAt) && expiresAt <= nowMs) {
                await fs.promises.rm(directory, { recursive: true, force: true });
                result.removed += 1;
            } else {
                result.retained += 1;
            }
        } catch {
            result.invalid += 1;
        }
    }
    return result;
}

export async function getOutputArtifactStats(): Promise<OutputArtifactStats> {
    const result: OutputArtifactStats = { runs: 0, complete: 0, incomplete: 0, invalid: 0, payloadBytes: 0 };
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(OUTPUT_ARTIFACT_ROOT, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        result.runs += 1;
        try {
            const manifestPath = path.join(OUTPUT_ARTIFACT_ROOT, entry.name, "manifest.json");
            const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as Partial<OutputArtifactManifest>;
            if (manifest.complete === true) result.complete += 1;
            else result.incomplete += 1;
            const stdoutBytes = Number(manifest.files?.stdout?.rawBytes);
            const stderrBytes = Number(manifest.files?.stderr?.rawBytes);
            if (Number.isFinite(stdoutBytes) && stdoutBytes > 0) result.payloadBytes += stdoutBytes;
            if (Number.isFinite(stderrBytes) && stderrBytes > 0) result.payloadBytes += stderrBytes;
        } catch {
            result.invalid += 1;
        }
    }
    return result;
}
