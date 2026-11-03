import fs from "node:fs";
import path from "node:path";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BackgroundTaskContext } from "./background-tasks.js";
import type { ProgressiveTaskPayload } from "./conversation-progressive-task-types.js";

async function terminateProgressiveWorkerTree(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
        if (child.exitCode != null || child.signalCode != null) throw new Error("owned worker exited before tree termination; descendants are unverified");
        await new Promise<void>((resolve, reject) => {
            execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL" }, error => {
                if (error) reject(error);
                else resolve();
            });
        });
    } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
}

export interface ProgressiveWorkerRunOptions {
    target?: { file: string; execArgv?: string[] };
    cancelGraceMs?: number;
}

export async function runProgressiveWorker(payload: ProgressiveTaskPayload, context: BackgroundTaskContext, options: ProgressiveWorkerRunOptions = {}): Promise<string> {
    if (context.isCancelled() || context.isSettled()) throw new Error("Progressive task cancelled before start");
    const javascript = fileURLToPath(new URL("./conversation-progressive-worker.js", import.meta.url));
    const target = options.target?.file || (fs.existsSync(javascript) ? javascript : fileURLToPath(new URL("./conversation-progressive-worker.ts", import.meta.url)));
    return new Promise((resolve, reject) => {
        const child = fork(target, [], {
            cwd: path.dirname(target), env: process.env,
            execArgv: options.target?.execArgv ?? (target.endsWith(".ts") ? ["--import", "tsx"] : []),
            detached: process.platform !== "win32",
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let cancelled = false;
        let result: string | undefined;
        let failure: Error | undefined;
        let stderr = "";
        let forceTimer: NodeJS.Timeout | undefined;
        let settled = false;
        let termination: Promise<void> | undefined;
        let cleanupFailure: Error | undefined;
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            if (forceTimer) clearTimeout(forceTimer);
            if (error) reject(error);
            else resolve(result!);
        };
        const forceStop = (): void => {
            termination ??= terminateProgressiveWorkerTree(child).catch(error => {
                cleanupFailure = new Error(`Progressive worker process-tree cleanup unconfirmed: ${String(error)}`);
                try { context.updateProgress({ stage: "cleanup_failed", detail: cleanupFailure.message }); } catch {}
            });
        };
        const fail = (error: Error): void => {
            if (settled) return;
            failure ??= error;
            forceStop();
        };
        const poll = setInterval(() => {
            if (cancelled || (!context.isCancelled() && !context.isSettled())) return;
            cancelled = true;
            try { if (child.connected) child.send({ type: "cancel" }, error => { if (error) fail(error); }); }
            catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
            const configured = options.cancelGraceMs ?? 10_000;
            const graceMs = Number.isFinite(configured) && configured >= 0 ? configured : 10_000;
            forceTimer = setTimeout(forceStop, graceMs);
            forceTimer.unref();
        }, 100);
        poll.unref();
        child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
        child.on("message", message => {
            if (!message || typeof message !== "object") return;
            const event = message as { type?: string; stage?: string; detail?: string; current?: number; result?: string; error?: string };
            if (event.type === "progress") context.updateProgress({ stage: event.stage, detail: event.detail, current: event.current, unit: "轮" });
            if (event.type === "result") result = event.result;
            if (event.type === "error") failure = new Error(event.error || "Progressive worker failed");
        });
        child.on("error", fail);
        child.on("close", async (code, signal) => {
            const stopped = cancelled || context.isCancelled() || context.isSettled();
            await termination;
            if (cleanupFailure) finish(cleanupFailure);
            else if (stopped) {
                finish(new Error("Progressive task cancelled; published ranges remain readable"));
            } else if (failure) finish(failure);
            else if (code !== 0 || result === undefined) finish(new Error("Progressive worker exit " + code + "/" + signal + ": " + stderr));
            else finish();
        });
        try { child.send({ type: "run", payload }, error => { if (error) fail(error); }); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
}

