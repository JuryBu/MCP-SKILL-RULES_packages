import crypto from "crypto";
import fs from "fs";
import { StringDecoder } from "string_decoder";
import { Writable } from "stream";
import {
    createOutputArtifactRun,
    OUTPUT_ARTIFACT_ROOT,
    OutputArtifactChannel,
    OutputArtifactChannelStats,
    OutputArtifactManifest,
    OutputArtifactRun,
    OutputArtifactStatus,
} from "./output-artifact-store.js";

export const DEFAULT_INLINE_ESTIMATED_TOKEN_LIMIT = 100_000;
export const DEFAULT_INLINE_COMBINED_LINE_LIMIT = 2_000;
const configuredHardResponseByteLimit = Number(process.env.SANDBOX_OUTPUT_HARD_RESPONSE_BYTES);
export const HARD_RESPONSE_BYTE_LIMIT = Number.isFinite(configuredHardResponseByteLimit) && configuredHardResponseByteLimit >= 64 * 1024
    ? Math.floor(configuredHardResponseByteLimit)
    : 1024 * 1024;
export const DEFAULT_METADATA_RESERVE_BYTES = 16 * 1024;

export type OutputDeliveryMode = "auto" | "inline" | "file" | "manifest";
export type DeliveredOutputMode = Exclude<OutputDeliveryMode, "auto">;

export interface OutputDeliveryOptions {
    mode?: OutputDeliveryMode;
    estimatedTokenLimit?: number;
    combinedLineLimit?: number;
    responseByteLimit?: number;
    metadataReserveBytes?: number;
    previewHeadBytes?: number;
    previewTailBytes?: number;
    artifactTtlMs?: number;
    writeHighWaterMarkBytes?: number;
    inputHighWaterMarkBytes?: number;
}

export interface FinalizeOutputDeliveryOptions {
    mode?: OutputDeliveryMode;
    status?: Exclude<OutputArtifactStatus, "running">;
    readHint?: string;
    error?: string;
}

export interface OutputDeliveryStats {
    stdout: OutputArtifactChannelStats;
    stderr: OutputArtifactChannelStats;
    combined: {
        rawBytes: number;
        lines: number;
        estimatedTokens: number;
    };
}

export interface OutputArtifactReference {
    artifactId: string;
    root: string;
    manifestPath: string;
    stdoutPath: string;
    stderrPath: string;
    expiresAt: string;
}

export interface OutputPreview {
    stdout: { head: string; tail: string };
    stderr: { head: string; tail: string };
}

export interface OutputDeliveryResult {
    requestedMode: OutputDeliveryMode;
    mode: DeliveredOutputMode;
    status: OutputArtifactStatus;
    complete: boolean;
    stdout?: string;
    stderr?: string;
    preview?: OutputPreview;
    stats: OutputDeliveryStats;
    artifact: OutputArtifactReference;
    readHint: string;
    reasons: string[];
    error: string | null;
}

interface FinalChannelSummary extends OutputArtifactChannelStats {
    headBuffer: Buffer;
    tailBuffer: Buffer;
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function boundedText(value: string | undefined, maxBytes = 4096): string {
    if (!value) return "";
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length <= maxBytes) return value;
    return new StringDecoder("utf8").write(buffer.subarray(0, maxBytes));
}

function toBuffer(chunk: string | Buffer | Uint8Array, encoding: BufferEncoding = "utf8"): Buffer {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === "string") return Buffer.from(chunk, encoding);
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function estimateTokenUnits(text: string): number {
    let units = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint > 0x7f) units += 12;
        else if (
            (codePoint >= 0x30 && codePoint <= 0x39)
            || (codePoint >= 0x41 && codePoint <= 0x5a)
            || (codePoint >= 0x61 && codePoint <= 0x7a)
            || codePoint === 0x20
            || (codePoint >= 0x09 && codePoint <= 0x0d)
        ) units += 3;
        else units += 4;
    }
    return units;
}

class ChannelAccumulator {
    private readonly hash = crypto.createHash("sha256");
    private readonly decoder = new StringDecoder("utf8");
    private readonly headLimit: number;
    private readonly tailLimit: number;
    private tokenUnits = 0;
    private lineBreaks = 0;
    private pendingCarriageReturn = false;
    private endsWithLineBreak = false;
    private head = Buffer.alloc(0);
    private tail = Buffer.alloc(0);
    private finalized = false;
    private bytes = 0;

    constructor(headLimit: number, tailLimit: number) {
        this.headLimit = headLimit;
        this.tailLimit = tailLimit;
    }

    update(chunk: Buffer): void {
        if (this.finalized) throw new Error("output channel is already finalized");
        if (chunk.length === 0) return;
        this.hash.update(chunk);
        this.bytes += chunk.length;
        this.tokenUnits += estimateTokenUnits(this.decoder.write(chunk));
        this.updateLines(chunk);
        this.updatePreview(chunk);
    }

    finish(): FinalChannelSummary {
        if (this.finalized) throw new Error("output channel summary was requested twice");
        this.finalized = true;
        this.tokenUnits += estimateTokenUnits(this.decoder.end());
        if (this.pendingCarriageReturn) {
            this.lineBreaks += 1;
            this.pendingCarriageReturn = false;
        }
        return {
            rawBytes: this.bytes,
            lines: this.lineBreaks + (this.bytes > 0 && !this.endsWithLineBreak ? 1 : 0),
            sha256: this.hash.digest("hex"),
            estimatedTokens: Math.ceil(this.tokenUnits / 12),
            headBuffer: this.head,
            tailBuffer: this.tail,
        };
    }

    private updateLines(chunk: Buffer): void {
        for (const byte of chunk) {
            if (this.pendingCarriageReturn) {
                this.lineBreaks += 1;
                this.pendingCarriageReturn = false;
                if (byte === 0x0a) {
                    this.endsWithLineBreak = true;
                    continue;
                }
            }
            if (byte === 0x0d) {
                this.pendingCarriageReturn = true;
                this.endsWithLineBreak = true;
            } else if (byte === 0x0a) {
                this.lineBreaks += 1;
                this.endsWithLineBreak = true;
            } else {
                this.endsWithLineBreak = false;
            }
        }
    }

    private updatePreview(chunk: Buffer): void {
        if (this.head.length < this.headLimit) {
            const needed = this.headLimit - this.head.length;
            this.head = Buffer.concat([this.head, chunk.subarray(0, needed)]);
        }
        if (this.tailLimit === 0) return;
        if (chunk.length >= this.tailLimit) {
            this.tail = Buffer.from(chunk.subarray(chunk.length - this.tailLimit));
            return;
        }
        const combined = Buffer.concat([this.tail, chunk]);
        this.tail = combined.length > this.tailLimit
            ? Buffer.from(combined.subarray(combined.length - this.tailLimit))
            : combined;
    }
}

function finishWritable(stream: Writable, error: () => Error | null): Promise<void> {
    if (stream.writableFinished) return Promise.resolve();
    const existingError = error();
    if (existingError) return Promise.reject(existingError);
    return new Promise((resolve, reject) => {
        const onFinish = () => {
            cleanup();
            const finalError = error();
            if (finalError) reject(finalError);
            else resolve();
        };
        const onError = (streamError: Error) => {
            cleanup();
            reject(streamError);
        };
        const cleanup = () => {
            stream.off("finish", onFinish);
            stream.off("error", onError);
        };
        stream.once("finish", onFinish);
        stream.once("error", onError);
        if (!stream.writableEnded) stream.end();
    });
}

function decodeHead(buffer: Buffer, includesEnd: boolean): string {
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(buffer);
    return includesEnd ? text + decoder.end() : text;
}

function decodeTail(buffer: Buffer): string {
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString("utf8");
}

function previewFor(summary: FinalChannelSummary): { head: string; tail: string } {
    const headCoversAll = summary.headBuffer.length >= summary.rawBytes;
    if (headCoversAll) return { head: decodeHead(summary.headBuffer, true), tail: "" };
    const overlap = Math.max(0, summary.headBuffer.length + summary.tailBuffer.length - summary.rawBytes);
    return {
        head: decodeHead(summary.headBuffer, false),
        tail: decodeTail(summary.tailBuffer.subarray(overlap)),
    };
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class OutputDeliveryCollector {
    readonly stdout: Writable;
    readonly stderr: Writable;

    private readonly artifactRun: OutputArtifactRun;
    private readonly options: Required<Pick<OutputDeliveryOptions,
        "mode" | "estimatedTokenLimit" | "combinedLineLimit" | "responseByteLimit" |
        "metadataReserveBytes" | "previewHeadBytes" | "previewTailBytes" | "inputHighWaterMarkBytes">>;
    private readonly accumulators: Record<OutputArtifactChannel, ChannelAccumulator>;
    private readonly inputErrors: Record<OutputArtifactChannel, Error | null> = { stdout: null, stderr: null };
    private finalizePromise: Promise<OutputDeliveryResult> | null = null;

    private constructor(artifactRun: OutputArtifactRun, options: OutputDeliveryOptions) {
        const responseByteLimit = Math.max(
            100,
            Math.min(HARD_RESPONSE_BYTE_LIMIT, positiveInteger(options.responseByteLimit, HARD_RESPONSE_BYTE_LIMIT)),
        );
        const metadataReserveBytes = Math.min(
            Math.max(1024, positiveInteger(options.metadataReserveBytes, DEFAULT_METADATA_RESERVE_BYTES)),
            Math.max(1024, responseByteLimit - 1024),
        );
        this.artifactRun = artifactRun;
        this.options = {
            mode: options.mode || "auto",
            estimatedTokenLimit: positiveInteger(options.estimatedTokenLimit, DEFAULT_INLINE_ESTIMATED_TOKEN_LIMIT),
            combinedLineLimit: positiveInteger(options.combinedLineLimit, DEFAULT_INLINE_COMBINED_LINE_LIMIT),
            responseByteLimit,
            metadataReserveBytes,
            previewHeadBytes: positiveInteger(options.previewHeadBytes, 4096),
            previewTailBytes: positiveInteger(options.previewTailBytes, 4096),
            inputHighWaterMarkBytes: positiveInteger(options.inputHighWaterMarkBytes, 64 * 1024),
        };
        this.accumulators = {
            stdout: new ChannelAccumulator(this.options.previewHeadBytes, this.options.previewTailBytes),
            stderr: new ChannelAccumulator(this.options.previewHeadBytes, this.options.previewTailBytes),
        };
        this.stdout = this.createSink("stdout");
        this.stderr = this.createSink("stderr");
    }

    static async create(options: OutputDeliveryOptions = {}): Promise<OutputDeliveryCollector> {
        const artifactRun = await createOutputArtifactRun({
            ttlMs: options.artifactTtlMs,
            writeHighWaterMarkBytes: options.writeHighWaterMarkBytes,
        });
        return new OutputDeliveryCollector(artifactRun, options);
    }

    write(channel: OutputArtifactChannel, chunk: string | Buffer | Uint8Array, encoding: BufferEncoding = "utf8"): Promise<void> {
        const sink = channel === "stdout" ? this.stdout : this.stderr;
        if (sink.writableEnded || sink.destroyed) return Promise.reject(new Error(`${channel} output stream is closed`));
        return new Promise((resolve, reject) => {
            sink.write(toBuffer(chunk, encoding), (error) => error ? reject(error) : resolve());
        });
    }

    finalize(options: FinalizeOutputDeliveryOptions = {}): Promise<OutputDeliveryResult> {
        if (!this.finalizePromise) this.finalizePromise = this.finalizeInternal(options);
        return this.finalizePromise;
    }

    private createSink(channel: OutputArtifactChannel): Writable {
        const sink = new Writable({
            highWaterMark: this.options?.inputHighWaterMarkBytes || 64 * 1024,
            write: (chunk: Buffer | string | Uint8Array, encoding, callback) => {
                const buffer = toBuffer(chunk, encoding as BufferEncoding);
                this.artifactRun.write(channel, buffer).then(() => {
                    this.accumulators[channel].update(buffer);
                    callback();
                }, (error) => callback(error instanceof Error ? error : new Error(String(error))));
            },
        });
        sink.on("error", (error) => {
            this.inputErrors[channel] = error;
        });
        return sink;
    }

    private async finalizeInternal(options: FinalizeOutputDeliveryOptions): Promise<OutputDeliveryResult> {
        const sinkResults = await Promise.allSettled([
            finishWritable(this.stdout, () => this.inputErrors.stdout),
            finishWritable(this.stderr, () => this.inputErrors.stderr),
        ]);
        const sinkFailure = sinkResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
        const stdoutSummary = this.accumulators.stdout.finish();
        const stderrSummary = this.accumulators.stderr.finish();
        const stats: OutputDeliveryStats = {
            stdout: this.publicStats(stdoutSummary),
            stderr: this.publicStats(stderrSummary),
            combined: {
                rawBytes: stdoutSummary.rawBytes + stderrSummary.rawBytes,
                lines: stdoutSummary.lines + stderrSummary.lines,
                estimatedTokens: stdoutSummary.estimatedTokens + stderrSummary.estimatedTokens,
            },
        };
        const requestedMode = options.mode || this.options.mode;
        const readHint = boundedText(options.readHint || `Read ${this.artifactRun.manifestPath}, then inspect stdout.bin or stderr.bin in bounded chunks.`);
        const error = boundedText(sinkFailure ? String(sinkFailure.reason) : options.error);
        const manifest = await this.artifactRun.finalize({
            status: sinkFailure ? "error" : options.status || "done",
            stats: { stdout: stats.stdout, stderr: stats.stderr },
            readHint,
            error,
        });
        return this.deliver(requestedMode, manifest, stats, stdoutSummary, stderrSummary);
    }

    private publicStats(summary: FinalChannelSummary): OutputArtifactChannelStats {
        return {
            rawBytes: summary.rawBytes,
            lines: summary.lines,
            sha256: summary.sha256,
            estimatedTokens: summary.estimatedTokens,
        };
    }

    private async deliver(
        requestedMode: OutputDeliveryMode,
        manifest: OutputArtifactManifest,
        stats: OutputDeliveryStats,
        stdoutSummary: FinalChannelSummary,
        stderrSummary: FinalChannelSummary,
    ): Promise<OutputDeliveryResult> {
        const artifact: OutputArtifactReference = {
            artifactId: manifest.artifactId,
            root: OUTPUT_ARTIFACT_ROOT,
            manifestPath: this.artifactRun.manifestPath,
            stdoutPath: this.artifactRun.stdoutPath,
            stderrPath: this.artifactRun.stderrPath,
            expiresAt: manifest.expiresAt,
        };
        const reasons: string[] = [];
        const base = {
            requestedMode,
            status: manifest.status,
            complete: manifest.complete,
            stats,
            artifact,
            readHint: manifest.readHint,
            reasons,
            error: manifest.error,
        };
        if (requestedMode === "manifest") return { ...base, mode: "manifest" };

        const autoWithinTokenLimit = stats.combined.estimatedTokens <= this.options.estimatedTokenLimit;
        const autoWithinLineLimit = stats.combined.lines <= this.options.combinedLineLimit;
        if (requestedMode === "auto" && !autoWithinTokenLimit) reasons.push("estimated_token_limit_exceeded");
        if (requestedMode === "auto" && !autoWithinLineLimit) reasons.push("combined_line_limit_exceeded");
        const shouldTryInline = requestedMode === "inline"
            || (requestedMode === "auto" && autoWithinTokenLimit && autoWithinLineLimit);

        if (shouldTryInline) {
            const contentBudget = this.options.responseByteLimit - this.options.metadataReserveBytes;
            if (stats.combined.rawBytes <= contentBudget) {
                const stdout = (await fs.promises.readFile(this.artifactRun.stdoutPath)).toString("utf8");
                const stderr = (await fs.promises.readFile(this.artifactRun.stderrPath)).toString("utf8");
                if (serializedBytes({ stdout, stderr }) <= contentBudget) {
                    const inlineResult: OutputDeliveryResult = { ...base, mode: "inline", stdout, stderr };
                    if (serializedBytes(inlineResult) <= this.options.responseByteLimit) return inlineResult;
                }
            }
            reasons.push("response_byte_limit_exceeded");
        }

        const fileResult: OutputDeliveryResult = {
            ...base,
            mode: "file",
            preview: {
                stdout: previewFor(stdoutSummary),
                stderr: previewFor(stderrSummary),
            },
        };
        if (serializedBytes(fileResult) <= this.options.responseByteLimit) return fileResult;
        reasons.push("file_preview_response_limit_exceeded");
        return { ...base, mode: "manifest" };
    }
}

export async function createOutputDeliveryCollector(options: OutputDeliveryOptions = {}): Promise<OutputDeliveryCollector> {
    return OutputDeliveryCollector.create(options);
}
