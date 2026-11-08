import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncSemaphore, currentToolRequestControl } from "./tool-concurrency.js";
import type { DevinConversationSummary } from "./devin-types.js";
import { DevinReadError } from "./devin-sqlite-store.js";

export type IsolatedSourceOperation = "candidates" | "devin-discover" | "devin-list" | "devin-identities" | "devin-resolve" | "devin-raw" | "devin-read" | "devin-fingerprint" | "host-list" | "host-read" | "host-cached" | "guard-record" | "conversation-export" | "corpus-action";
export interface IsolatedSourceControl {
    deadlineAt?: number;
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    onProgress?: (progress: { phase: string; bytes?: number; totalBytes?: number }) => void;
    onCheckpoint?: (checkpoint: unknown) => void;
}
export interface IsolatedSourceOptions {
    target?: { file: string; execArgv?: string[] };
    timeoutMs?: number;
    terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}
export interface SourcePatch {
    type: "set" | "append" | "text";
    path: (string | number)[];
    value: any;
}

const marker = "--memory-store-isolated-source";
let permits: AsyncSemaphore | undefined;
const execFileAsync = promisify(execFile);
const identityHints = new Map<string, DevinConversationSummary>();
const activeWorkers = new Map<number, () => Promise<void>>();
let closing = false;

export function rememberIsolatedSourceIdentity(summary: DevinConversationSummary): void {
    if (!summary.identityEvidence || !summary.uuid || summary.aliases.length < 2) return;
    const key = JSON.stringify([summary.sourcePath, summary.canonicalId]);
    identityHints.delete(key); identityHints.set(key, summary);
    while (identityHints.size > 64) identityHints.delete(identityHints.keys().next().value!);
}

export async function closeIsolatedSourceWorkers(): Promise<void> {
    closing = true;
    await Promise.all([...activeWorkers.values()].map(close => close()));
}

export async function waitForIsolatedSourceExit(child: ChildProcess, timeoutMs = 250): Promise<boolean> {
    const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    if (exited()) return true;
    return new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (confirmed: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            resolve(confirmed);
        };
        const onExit = (): void => finish(exited());
        const timer = setTimeout(() => finish(exited()), timeoutMs);
        child.once("exit", onExit);
        if (exited()) finish(true);
    });
}

export function isIsolatedSourceWorker(): boolean {
    return typeof process.send === "function" && (process.argv.includes(marker)
        || /conversation-(?:progressive|fetch)-worker\.(?:js|ts)$/u.test(process.argv[1] || ""));
}

export function canIsolateSourceOptions(value: unknown): boolean {
    if (typeof value === "function") return false;
    if (!value || typeof value !== "object") return true;
    if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return false;
    return Object.values(value).every(canIsolateSourceOptions);
}

function sourceError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function pool(): AsyncSemaphore {
    const configured = Number(process.env.MEMORY_STORE_SOURCE_WORKERS || 2);
    permits ??= new AsyncSemaphore(Number.isSafeInteger(configured) && configured > 0 ? configured : 2);
    return permits;
}

function target(): { file: string; execArgv: string[] } {
    const javascript = fileURLToPath(new URL("./conversation-isolated-source-worker.js", import.meta.url));
    return fs.existsSync(javascript) ? { file: javascript, execArgv: [] }
        : { file: fileURLToPath(new URL("./conversation-isolated-source-worker.ts", import.meta.url)), execArgv: ["--import", "tsx"] };
}

export function applySourcePatch(root: any, patch: SourcePatch): any {
    if (!patch.path.length) {
        if (patch.type === "set") return patch.value;
        if (patch.type === "text") return root + patch.value;
        for (const value of patch.value) root.push(value);
        return root;
    }
    let parent = root;
    for (const key of patch.path.slice(0, -1)) parent = parent[key];
    const key = patch.path.at(-1)!;
    if (patch.type === "set") Object.defineProperty(parent, key, { value: patch.value, configurable: true, enumerable: true, writable: true });
    else if (patch.type === "text") parent[key] += patch.value;
    else for (const value of patch.value) parent[key].push(value);
    return root;
}

export async function runIsolatedSource<Result>(operation: IsolatedSourceOperation, payload: unknown,
    control: IsolatedSourceControl = {}, options: IsolatedSourceOptions = {}): Promise<Result> {
    const request = currentToolRequestControl();
    control = { ...request, ...control, signal: control.signal ?? request.signal };
    const devin = operation.startsWith("devin-");
    const deadlineAt = Math.min(control.deadlineAt ?? Infinity, request.deadlineAt ?? Infinity, Date.now() + (options.timeoutMs ?? (devin ? 30_000 : 120_000)));
    if (!Number.isFinite(deadlineAt)) throw sourceError("SOURCE_WORKER_BUDGET", "Source worker requires a finite deadline");
    const aborted = (): Error => devin ? new DevinReadError("DEVIN_ABORTED", "Devin SQLite reading was cancelled.")
        : Object.assign(sourceError("SOURCE_WORKER_CANCELLED", "History source reading was cancelled"), { name: "AbortError" });
    const stopped = (): Error | undefined => closing ? sourceError("SOURCE_WORKER_SHUTDOWN", "History source execution is shutting down") : control.signal?.aborted || control.isCancelled?.()
        ? aborted() : Date.now() >= deadlineAt ? devin ? new DevinReadError("DEVIN_DEADLINE", "Devin SQLite reading exceeded its deadline; no complete result was returned.")
        : sourceError("SOURCE_WORKER_DEADLINE", "History source reading deadline exceeded; no complete result was returned") : undefined;
    let release: (() => void) | null = null;
    while (!release) {
        const error = stopped();
        if (error) throw error;
        release = await pool().acquire(Math.min(100, Math.max(1, deadlineAt - Date.now())));
    }
    try {
        const beforeStart = stopped();
        if (beforeStart) throw beforeStart;
        return await new Promise<Result>((resolve, reject) => {
            const entry = options.target || target();
            const heap = Number(process.env.MEMORY_STORE_SOURCE_WORKER_HEAP_MB || 512);
            const child = fork(entry.file, [marker], {
                cwd: path.dirname(entry.file), env: process.env,
                detached: process.platform !== "win32",
                execArgv: [...(entry.execArgv || []), `--max-old-space-size=${Number.isSafeInteger(heap) && heap >= 64 ? heap : 512}`],
                serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            let failure: Error | undefined;
            let result: any;
            let checkpoint: any;
            let complete = false;
            let settled = false;
            let stderr = "";
            let termination: Promise<void> | undefined;
            let releaseClosed!: () => void;
            const closed = new Promise<void>(resolve => { releaseClosed = resolve; });
            const stop = (error: Error): void => {
                failure ??= error;
                if (termination || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
                termination = (async () => {
                    if (options.terminateProcessTree) await options.terminateProcessTree(child);
                    else if (process.platform === "win32") await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
                    else process.kill(-child.pid!, "SIGKILL");
                })().catch(async error => {
                    if (!await waitForIsolatedSourceExit(child)) {
                        const originalFailure = failure;
                        const originalCode = (originalFailure as NodeJS.ErrnoException | undefined)?.code || originalFailure?.name || "unknown";
                        failure = Object.assign(sourceError("SOURCE_WORKER_CLEANUP", `History source process-tree cleanup failed: ${String(error)}; original failure: ${originalCode}: ${originalFailure?.message || "unknown"}`), { cause: originalFailure, cleanupCause: error });
                        child.kill("SIGKILL");
                    }
                });
            };
            const timer = setInterval(() => {
                const error = stopped();
                if (error) stop(error);
            }, 25);
            timer.unref();
            const abort = (): void => stop(aborted());
            control.signal?.addEventListener("abort", abort, { once: true });
            child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
            child.on("message", (message: any) => {
                if (failure || settled || !message || typeof message !== "object") return;
                try {
                    if (message.type === "patch") result = applySourcePatch(result, message.patch);
                    else if (message.type === "checkpoint-patch") checkpoint = applySourcePatch(checkpoint, message.patch);
                    else if (message.type === "checkpoint-complete") {
                        control.onCheckpoint?.(checkpoint);
                        checkpoint = undefined;
                    }
                    else if (message.type === "identity-hints") {
                        for (const summary of message.summaries as DevinConversationSummary[]) rememberIsolatedSourceIdentity(summary);
                    }
                    else if (message.type === "progress") control.onProgress?.(message.progress);
                    else if (message.type === "complete") complete = true;
                    else if (message.type === "error") failure = message.name === "DevinReadError" && typeof message.code === "string"
                        ? new DevinReadError(message.code, message.message)
                        : Object.assign(new Error(message.message), { name: message.name || "Error", code: message.code });
                } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
            });
            child.on("error", stop);
            child.on("close", async (code, signal) => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                control.signal?.removeEventListener("abort", abort);
                await termination;
                if (child.pid !== undefined) activeWorkers.delete(child.pid);
                releaseClosed();
                failure ??= stopped();
                if (failure) reject(failure);
                else if (!complete || code !== 0) reject(sourceError("SOURCE_WORKER_EXIT", `History source worker exited ${code}/${signal}: ${stderr}`));
                else resolve(result as Result);
            });
            if (child.pid !== undefined) activeWorkers.set(child.pid, async () => {
                stop(sourceError("SOURCE_WORKER_SHUTDOWN", "History source execution was stopped for shutdown"));
                await closed;
            });
            const workDeadlineAt = operation === "candidates" ? deadlineAt - Math.min(250, Math.max(0, Math.floor((deadlineAt - Date.now()) / 5))) : deadlineAt;
            try { child.send({ type: "run", operation, payload, deadlineAt: workDeadlineAt, identityHints: [...identityHints.values()] }, error => { if (error) stop(error); }); }
            catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
        });
    } finally { release(); }
}
