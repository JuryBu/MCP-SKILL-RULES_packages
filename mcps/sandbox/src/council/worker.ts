#!/usr/bin/env node
import fs from "fs";
import { runCouncil } from "./engine.js";
import { finalizeCouncilTask, writeCouncilTaskProgress } from "./background.js";
import type { CouncilRunParams } from "./types.js";

interface WorkerSpec {
    taskId: string;
    ownerId: string;
    startedAt: string;
    deadlineAt?: string;
    transcriptPath?: string;
    outputDir?: string;
    params: Omit<CouncilRunParams, "onProgress">;
}

function formatCouncilResult(result: Awaited<ReturnType<typeof runCouncil>>): string {
    const lastRound = result.rounds.at(-1);
    const toolCalls = result.rounds.reduce((total, round) => total + (round.toolResults?.length ?? (round.toolResult ? 1 : 0)), 0);
    const participants = result.participants.map((p) => `${p.id}(${p.provider}${p.model ? `:${p.model}` : ""})`).join(", ");
    return [
        "✅ sandbox_council 完成",
        `🆔 id: ${result.id}`,
        `📌 mode: ${result.mode}`,
        `👥 participants: ${participants}`,
        `🔁 rounds: ${result.rounds.length}`,
        `🧰 toolCalls: ${toolCalls}`,
        `🛑 terminationReason: ${result.terminationReason}`,
        result.markdownPath ? `📄 markdown: ${result.markdownPath}` : "",
        result.jsonPath ? `📄 json: ${result.jsonPath}` : "",
        "",
        "## 最终结论",
        result.finalAnswer,
        lastRound?.moderator.summary ? `\n## 最后一轮主持摘要\n${lastRound.moderator.summary}` : "",
    ].filter(Boolean).join("\n");
}

async function main(): Promise<void> {
    const specPath = process.argv[2];
    if (!specPath) throw new Error("缺少 spec.json 路径");
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as WorkerSpec;
    const pid = process.pid;
    let finalized = false;
    const deadlineMs = spec.deadlineAt ? new Date(spec.deadlineAt).getTime() - Date.now() : 0;
    const deadlineTimer = deadlineMs > 0 ? setTimeout(() => {
        if (finalized) return;
        finalized = true;
        finalizeCouncilTask(spec.taskId, spec.ownerId, {
            status: "interrupted",
            error: `后台 worker 超过 deadline (${spec.deadlineAt})，已强制中断`,
            pid,
            startedAt: spec.startedAt,
        });
        process.exit(1);
    }, deadlineMs) : null;
    deadlineTimer?.unref?.();
    try {
        writeCouncilTaskProgress(spec.taskId, spec.ownerId, "worker 已接管任务，准备进入 council 主循环。", pid, spec.startedAt);
        const result = await runCouncil({
            ...spec.params,
            ownerId: spec.ownerId,
            transcriptPath: spec.transcriptPath || spec.params.transcriptPath,
            outputDir: spec.outputDir || spec.params.outputDir,
            onProgress: (progress) => writeCouncilTaskProgress(spec.taskId, spec.ownerId, progress, pid, spec.startedAt),
        });
        if (finalized) return;
        finalized = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        finalizeCouncilTask(spec.taskId, spec.ownerId, {
            status: "done",
            transcript: result,
            resultText: formatCouncilResult(result),
            pid,
            startedAt: spec.startedAt,
        });
    } catch (err) {
        if (finalized) return;
        finalized = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        finalizeCouncilTask(spec.taskId, spec.ownerId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            pid,
            startedAt: spec.startedAt,
        });
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
});
