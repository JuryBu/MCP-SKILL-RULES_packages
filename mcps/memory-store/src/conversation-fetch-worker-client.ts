import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCodexSourceVersionSync, captureCodexSourceVersion, getCodexThread } from "./codex-client.js";
import { stableJsonHash, type BackgroundTaskContext } from "./background-tasks.js";
import type { Chain } from "./chain.js";
import type { CodexFetchWorkerMessage, CodexFetchWorkerPayload, CodexFetchWorkerResult } from "./conversation-fetch-worker-types.js";

const DEFAULT_GIANT_FETCH_BYTES = 256 * 1024 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
export const CODEX_FETCH_ARTIFACT_BUCKET_MS = 60 * 60 * 1000;

function readThreshold(): number {
    const parsed = Number(process.env.MEMORY_STORE_CODEX_FETCH_BACKGROUND_THRESHOLD_BYTES || DEFAULT_GIANT_FETCH_BYTES);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_GIANT_FETCH_BYTES;
}

export interface CodexFetchWorkEstimate {
    sourcePath: string;
    sourceSize: number;
    sourceMtimeMs: number;
    anchorStartByte: number;
    anchorSha256: string;
    thresholdBytes: number;
    shouldBackground: boolean;
}

export function estimateCodexFetchWork(conversationId: string): CodexFetchWorkEstimate | null {
    const thread = getCodexThread(conversationId);
    if (!thread?.rolloutPath) return null;
    try {
        const sourceVersion = captureCodexSourceVersion(thread.rolloutPath);
        const thresholdBytes = readThreshold();
        return {
            ...sourceVersion,
            thresholdBytes,
            shouldBackground: sourceVersion.sourceSize >= thresholdBytes,
        };
    } catch {
        return null;
    }
}

export function createCodexFetchWorkerPayload(input: {
    conversationId: string;
    link: CodexFetchWorkerPayload["link"];
    source: CodexFetchWorkerPayload["source"];
    estimate: CodexFetchWorkEstimate;
    modelChain: Chain;
    now?: number;
}): CodexFetchWorkerPayload {
    return {
        version: 1,
        conversationId: input.conversationId,
        link: input.link,
        source: input.source,
        sourcePath: input.estimate.sourcePath,
        sourceSize: input.estimate.sourceSize,
        sourceMtimeMs: input.estimate.sourceMtimeMs,
        anchorStartByte: input.estimate.anchorStartByte,
        anchorSha256: input.estimate.anchorSha256,
        artifactBucket: Math.floor((input.now ?? Date.now()) / CODEX_FETCH_ARTIFACT_BUCKET_MS),
        modelChain: input.modelChain,
    };
}

export function buildCodexFetchTaskId(payload: CodexFetchWorkerPayload): string {
    return `conversation-fetch-${stableJsonHash(payload).slice(0, 32)}`;
}

function workerTarget(): { file: string; execArgv: string[] } {
    const javascript = fileURLToPath(new URL("./conversation-fetch-worker.js", import.meta.url));
    if (fs.existsSync(javascript)) return { file: javascript, execArgv: [] };
    const typescript = fileURLToPath(new URL("./conversation-fetch-worker.ts", import.meta.url));
    return { file: typescript, execArgv: ["--import", "tsx"] };
}

export interface CodexFetchWorkerRunOptions {
    target?: { file: string; execArgv?: string[] };
    cancelGraceMs?: number;
}

export function runCodexFetchWorker(
    payload: CodexFetchWorkerPayload,
    taskContext: Pick<BackgroundTaskContext, "updateProgress" | "isCancelled" | "isSettled">,
    options: CodexFetchWorkerRunOptions = {},
): Promise<CodexFetchWorkerResult> {
    if (taskContext.isCancelled() || taskContext.isSettled()) {
        return Promise.reject(new Error(taskContext.isCancelled()
            ? "conversation fetch worker cancelled before start"
            : "conversation fetch worker stopped before start after task settlement"));
    }
    try {
        assertCodexSourceVersionSync(payload.sourcePath, payload, "before worker start");
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
        const target = options.target || workerTarget();
        const child = fork(target.file, [], {
            cwd: path.dirname(target.file),
            env: process.env,
            execArgv: target.execArgv || [],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let settled = false;
        let cancellationRequested = false;
        let artifactPath: string | undefined;
        let hardKillTimer: NodeJS.Timeout | undefined;
        let stderrTail = "";
        const clearTimers = (): void => {
            clearInterval(cancellationTimer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
        };
        const finishResolve = (result: CodexFetchWorkerResult): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            resolve(result);
        };
        const finishReject = (error: Error, cleanupArtifact = false): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            void (async () => {
                if (cleanupArtifact && artifactPath) {
                    await fs.promises.rm(artifactPath, { force: true }).catch(() => undefined);
                }
                reject(error);
            })();
        };
        const cancellationError = (): Error => new Error(taskContext.isCancelled()
            ? "conversation fetch worker cancelled"
            : "conversation fetch worker stopped after task settlement");
        const requestCancellation = (): void => {
            if (cancellationRequested || settled) return;
            cancellationRequested = true;
            if (child.connected) {
                child.send({ type: "cancel" }, error => {
                    if (error && !child.killed) child.kill();
                });
            }
            const configured = options.cancelGraceMs
                ?? Number(process.env.MEMORY_STORE_CODEX_FETCH_CANCEL_GRACE_MS || DEFAULT_CANCEL_GRACE_MS);
            const graceMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CANCEL_GRACE_MS;
            hardKillTimer = setTimeout(() => {
                if (!settled && !child.killed) child.kill();
            }, graceMs);
            hardKillTimer.unref?.();
        };
        const cancellationTimer = setInterval(() => {
            if (!taskContext.isCancelled() && !taskContext.isSettled()) return;
            requestCancellation();
        }, 100);
        cancellationTimer.unref?.();
        child.stderr?.on("data", chunk => {
            stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
        });
        child.on("message", rawMessage => {
            const message = rawMessage as CodexFetchWorkerMessage;
            if (message.type === "progress") {
                taskContext.updateProgress({ stage: message.stage, detail: message.detail });
                return;
            }
            if (message.type === "artifact_path") {
                artifactPath = message.path;
                return;
            }
            if (message.type === "result") {
                artifactPath = message.result.artifact.tempPath;
                if (cancellationRequested || taskContext.isCancelled() || taskContext.isSettled()) {
                    requestCancellation();
                    finishReject(cancellationError(), true);
                    return;
                }
                finishResolve(message.result);
                return;
            }
            if (message.type === "error") {
                const stderr = stderrTail.trim() ? `\nstderr tail:\n${stderrTail.trim()}` : "";
                const error = new Error(`${message.name}: ${message.message}${stderr}`);
                error.name = message.name || "Error";
                if (message.stack) error.stack = `${message.stack}${stderr}`;
                finishReject(cancellationRequested ? cancellationError() : error, cancellationRequested);
            }
        });
        child.on("error", error => finishReject(cancellationRequested ? cancellationError() : error, cancellationRequested));
        child.on("exit", (code, signal) => {
            if (settled) return;
            if (cancellationRequested) {
                finishReject(cancellationError(), true);
                return;
            }
            const detail = stderrTail.trim() ? `; stderr=${stderrTail.trim()}` : "";
            finishReject(new Error(`conversation fetch worker exited before result (code=${code}, signal=${signal})${detail}`));
        });
        if (taskContext.isCancelled() || taskContext.isSettled()) {
            requestCancellation();
            finishReject(cancellationError(), true);
            return;
        }
        child.send({ type: "run", payload }, error => {
            if (error) finishReject(error);
        });
    });
}
