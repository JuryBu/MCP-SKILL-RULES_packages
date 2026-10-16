import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TEMP_DIR } from "./temp-store.js";

export interface CodexDiagnosticContext {
    conversationId?: string;
    guardId?: string;
    childScopeId?: string;
    stageId?: string;
}

export interface CodexDiagnosticMetadata {
    command: string;
    args: string[];
    cwd: string;
    model: string;
    reasoningEffort: string;
    requestedServiceTier: string;
    requestedFastMode: boolean;
    timeoutMs: number;
    promptSha256: string;
    context?: CodexDiagnosticContext;
}

export interface CodexDiagnosticArtifact {
    path?: string;
    sha256: string;
    streamSha256: string;
    bytes: number;
    capturedBytes: number;
    truncated: boolean;
}

export interface CodexBridgeDiagnostics {
    callId: string;
    manifestPath?: string;
    manifestSha256?: string;
    manifestBytes?: number;
    stdout: CodexDiagnosticArtifact;
    stderr: CodexDiagnosticArtifact;
    commandCount: number;
    rejectedCommandCount: number;
    failedCommandCount: number;
    runningCommandCount: number;
    eventCount: number;
    eventCoverage: "complete" | "partial";
    modelReportedRefusal: boolean;
    captureError?: string;
    retention: "private-until-explicit-archive-or-removal";
}

interface CommandObservation {
    id: string;
    type: string;
    command: string;
    commandTruncated: boolean;
    status: string;
    exitCode?: number | null;
    rejectionEvidence?: "structured-status" | "structured-error-code";
}

interface CaptureStream {
    filePath: string;
    descriptor?: number;
    hash: crypto.Hash;
    capturedHash: crypto.Hash;
    bytes: number;
    capturedBytes: number;
    limit: number;
}

interface DiagnosticOutcome {
    exitCode: number | null;
    timedOut: boolean;
    cancelled?: boolean;
    childPid?: number;
    lastText?: string | null;
    error?: string;
    killTree?: string;
}

const MAX_EVENT_LINE_CHARS = 256 * 1024;
const MAX_COMMANDS = 128;
const MAX_COMMAND_CHARS = 8192;
const REJECTION_STATUSES = new Set(["declined", "rejected", "denied"]);
const REJECTION_CODES = new Set(["permission_denied", "approval_denied", "approval_rejected", "command_rejected", "exec_policy_denied", "sandbox_denied", "policy_denied"]);

export function hasCodexModelRefusalClaim(text: string): boolean {
    const affirmative = text.replace(/(?:没有|并未|未曾|从未|未)\s*(?:被|遭)?\s*(?:策略)?\s*拒绝|\bno\s+(?:command|tool|read)\b[^\n.;]{0,40}\b(?:rejected|denied)\b|\b(?:not|never)\s+(?:been\s+)?(?:rejected|denied)\b/giu, "");
    return /(?:命令|读取|工具|补读|访问).{0,48}(?:被.{0,8}拒绝|策略拒绝|遭.{0,8}拒绝)|(?:command|tool|read).{0,48}(?:was rejected|denied by policy|rejected by policy)/iu.test(affirmative);
}

export class CodexDiagnosticRecorder {
    readonly callId = crypto.randomUUID();
    private readonly directory: string;
    private readonly stdout: CaptureStream;
    private readonly stderr: CaptureStream;
    private readonly decoder = new StringDecoder("utf8");
    private readonly commands = new Map<string, CommandObservation>();
    private readonly startedAt = new Date().toISOString();
    private pendingLine = "";
    private skippingLine = false;
    private eventCount = 0;
    private observedRejection = false;
    private eventCoverage: "complete" | "partial" = "complete";
    private captureError?: string;
    private completed?: CodexBridgeDiagnostics;

    constructor(private readonly metadata: CodexDiagnosticMetadata, limits: { stdoutBytes?: number; stderrBytes?: number } = {}) {
        this.directory = path.join(path.dirname(TEMP_DIR), "model-bridge-diagnostics", "codex", this.callId);
        const limit = (value: number | undefined, fallback: number) => Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
        this.stdout = this.createStream("stdout.jsonl", limit(limits.stdoutBytes, 4 * 1024 * 1024));
        this.stderr = this.createStream("stderr.log", limit(limits.stderrBytes, 1024 * 1024));
        try {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            this.stdout.descriptor = fs.openSync(this.stdout.filePath, "wx", 0o600);
            this.stderr.descriptor = fs.openSync(this.stderr.filePath, "wx", 0o600);
            fs.writeFileSync(path.join(this.directory, "pending.json"), JSON.stringify({
                version: 1, callId: this.callId, state: "running-or-unknown", startedAt: this.startedAt,
                recorderPid: process.pid, metadata, retention: "private-until-explicit-archive-or-removal",
            }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        } catch (error) {
            this.captureError = error instanceof Error ? error.message : String(error);
            this.eventCoverage = "partial";
        }
    }

    private createStream(name: string, limit: number): CaptureStream {
        return { filePath: path.join(this.directory, name), hash: crypto.createHash("sha256"), capturedHash: crypto.createHash("sha256"), bytes: 0, capturedBytes: 0, limit };
    }

    private capture(stream: CaptureStream, chunk: Buffer | string): Buffer {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        stream.hash.update(bytes);
        stream.bytes += bytes.length;
        const remaining = Math.max(0, stream.limit - stream.capturedBytes);
        if (stream.descriptor !== undefined && remaining > 0) {
            try {
                const retained = bytes.subarray(0, remaining);
                let written = 0;
                while (written < retained.length) {
                    const count = fs.writeSync(stream.descriptor, retained, written, retained.length - written);
                    if (count === 0) throw new Error("Codex diagnostic write made no progress");
                    stream.capturedHash.update(retained.subarray(written, written + count));
                    stream.capturedBytes += count;
                    written += count;
                }
            } catch (error) {
                this.captureError ||= error instanceof Error ? error.message : String(error);
                this.eventCoverage = "partial";
            }
        }
        return bytes;
    }

    recordStdout(chunk: Buffer | string): void {
        if (this.completed) return;
        const bytes = this.capture(this.stdout, chunk);
        this.consumeText(this.decoder.write(bytes));
    }

    recordStderr(chunk: Buffer | string): void {
        if (!this.completed) this.capture(this.stderr, chunk);
    }

    hasObservedRejection(): boolean {
        return this.observedRejection;
    }

    private consumeText(text: string): void {
        for (const fragment of text.split(/(?<=\n)/u)) {
            const finishedLine = fragment.endsWith("\n");
            if (!this.skippingLine) {
                this.pendingLine += fragment;
                if (this.pendingLine.length > MAX_EVENT_LINE_CHARS) {
                    this.pendingLine = "";
                    this.skippingLine = true;
                    this.eventCoverage = "partial";
                }
            }
            if (finishedLine) {
                if (!this.skippingLine) this.consumeEvent(this.pendingLine);
                this.pendingLine = "";
                this.skippingLine = false;
            }
        }
    }

    private consumeEvent(line: string): void {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { this.eventCoverage = "partial"; return; }
        if (!event || typeof event !== "object") { this.eventCoverage = "partial"; return; }
        this.eventCount++;
        const item = event.item as Record<string, unknown> | undefined;
        if (!item || !["command_execution", "mcp_tool_call"].includes(String(item.type))) return;
        const identifier = typeof item.id === "string" ? item.id : `event-${this.eventCount}`;
        const previous = this.commands.get(identifier);
        const command = typeof item.command === "string" ? item.command : typeof item.tool === "string" ? item.tool : previous?.command || "";
        const status = typeof item.status === "string" ? item.status : previous?.status || "unknown";
        const error = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : undefined;
        const errorCode = String(error?.code || error?.type || "").toLowerCase();
        const rejectionEvidence = REJECTION_STATUSES.has(status.toLowerCase()) ? "structured-status"
            : REJECTION_CODES.has(errorCode) ? "structured-error-code" : previous?.rejectionEvidence;
        this.observedRejection ||= Boolean(rejectionEvidence);
        if (!previous && this.commands.size >= MAX_COMMANDS) { this.eventCoverage = "partial"; return; }
        this.commands.set(identifier, {
            id: identifier, type: String(item.type), command: command.slice(0, MAX_COMMAND_CHARS),
            commandTruncated: command.length > MAX_COMMAND_CHARS || previous?.commandTruncated === true,
            status, ...(typeof item.exit_code === "number" || item.exit_code === null ? { exitCode: item.exit_code } : previous?.exitCode !== undefined ? { exitCode: previous.exitCode } : {}),
            ...(rejectionEvidence ? { rejectionEvidence } : {}),
        });
    }

    finish(outcome: DiagnosticOutcome): CodexBridgeDiagnostics {
        if (this.completed) return this.completed;
        if (outcome.timedOut || outcome.cancelled || outcome.exitCode === null) this.eventCoverage = "partial";
        this.consumeText(this.decoder.end());
        if (this.pendingLine && !this.skippingLine) this.consumeEvent(this.pendingLine);
        const closeStream = (stream: CaptureStream): CodexDiagnosticArtifact => {
            if (stream.descriptor !== undefined) {
                try { fs.closeSync(stream.descriptor); } catch (error) {
                    this.captureError ||= String(error);
                    this.eventCoverage = "partial";
                }
            }
            return {
                ...(stream.descriptor !== undefined ? { path: stream.filePath } : {}),
                sha256: stream.capturedHash.digest("hex"), streamSha256: stream.hash.digest("hex"), bytes: stream.bytes, capturedBytes: stream.capturedBytes,
                truncated: stream.capturedBytes < stream.bytes,
            };
        };
        const commands = [...this.commands.values()];
        const result: CodexBridgeDiagnostics = {
            callId: this.callId, stdout: closeStream(this.stdout), stderr: closeStream(this.stderr),
            commandCount: commands.length,
            rejectedCommandCount: Math.max(this.observedRejection ? 1 : 0, commands.filter(command => command.rejectionEvidence).length),
            failedCommandCount: commands.filter(command => command.status === "failed" || typeof command.exitCode === "number" && command.exitCode !== 0).length,
            runningCommandCount: commands.filter(command => ["in_progress", "running"].includes(command.status)).length,
            eventCount: this.eventCount, eventCoverage: this.eventCoverage,
            modelReportedRefusal: hasCodexModelRefusalClaim(outcome.lastText || ""),
            ...(this.captureError ? { captureError: this.captureError } : {}),
            retention: "private-until-explicit-archive-or-removal",
        };
        try {
            const manifestPath = path.join(this.directory, "manifest.json");
            const partialPath = path.join(this.directory, "manifest.partial.json");
            const manifestText = JSON.stringify({
                version: 1, state: "finished", startedAt: this.startedAt, finishedAt: new Date().toISOString(),
                recorderPid: process.pid, metadata: this.metadata, outcome: { ...outcome, lastText: undefined },
                ...result, commands,
            }, null, 2);
            fs.writeFileSync(partialPath, manifestText, { encoding: "utf8", flag: "wx", mode: 0o600 });
            fs.renameSync(partialPath, manifestPath);
            result.manifestPath = manifestPath;
            result.manifestSha256 = crypto.createHash("sha256").update(manifestText, "utf8").digest("hex");
            result.manifestBytes = Buffer.byteLength(manifestText, "utf8");
            if (fs.existsSync(path.join(this.directory, "pending.json"))) fs.unlinkSync(path.join(this.directory, "pending.json"));
        } catch (error) {
            result.captureError ||= error instanceof Error ? error.message : String(error);
            result.eventCoverage = "partial";
        }
        this.completed = result;
        return result;
    }
}
