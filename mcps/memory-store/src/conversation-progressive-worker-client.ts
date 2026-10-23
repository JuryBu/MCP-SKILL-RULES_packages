import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BackgroundTaskContext } from "./background-tasks.js";
import type { ProgressiveTaskPayload } from "./conversation-progressive-task-types.js";

export async function runProgressiveWorker(payload: ProgressiveTaskPayload, context: BackgroundTaskContext): Promise<string> {
    if (context.isCancelled() || context.isSettled()) throw new Error("Progressive task cancelled before start");
    const javascript = fileURLToPath(new URL("./conversation-progressive-worker.js", import.meta.url));
    const target = fs.existsSync(javascript) ? javascript : fileURLToPath(new URL("./conversation-progressive-worker.ts", import.meta.url));
    return new Promise((resolve, reject) => {
        const child = fork(target, [], {
            cwd: path.dirname(target), env: process.env,
            execArgv: target.endsWith(".ts") ? ["--import", "tsx"] : [],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let cancelled = false;
        let result: string | undefined;
        let failure: Error | undefined;
        let stderr = "";
        let forceTimer: NodeJS.Timeout | undefined;
        let settled = false;
        let killRequested = false;
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            if (forceTimer) clearTimeout(forceTimer);
            if (error) reject(error);
            else resolve(result!);
        };
        const fail = (error: Error): void => {
            if (settled) return;
            failure ??= error;
            if (child.pid === undefined) finish(failure);
            else if (!killRequested) { killRequested = true; child.kill(); }
        };
        const poll = setInterval(() => {
            if (cancelled || (!context.isCancelled() && !context.isSettled())) return;
            cancelled = true;
            try { if (child.connected) child.send({ type: "cancel" }, error => { if (error) fail(error); }); }
            catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
            forceTimer = setTimeout(() => child.kill(), 10000);
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
        child.on("close", (code, signal) => {
            if (cancelled || context.isCancelled() || context.isSettled()) {
                finish(new Error("Progressive task cancelled; published ranges remain readable"));
            } else if (failure) finish(failure);
            else if (code !== 0 || result === undefined) finish(new Error("Progressive worker exit " + code + "/" + signal + ": " + stderr));
            else finish();
        });
        try { child.send({ type: "run", payload }, error => { if (error) fail(error); }); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
}

