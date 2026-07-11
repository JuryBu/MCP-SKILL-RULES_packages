#!/usr/bin/env node
import fs from "fs";
import { resumeCouncil, runCouncil } from "./engine.js";
import { finalizeCouncilTask, readCouncilWorkerIdentity, writeCouncilTaskProgress } from "./background.js";
import { formatCouncilArtifactSummary } from "./transcript.js";
import type { CouncilCheckpoint, CouncilRunParams, CouncilTranscript } from "./types.js";

interface WorkerSpec {
    taskId: string;
    runId: string;
    artifactManifestPath: string;
    ownerId: string;
    startedAt: string;
    deadlineAt?: string;
    checkpointPath?: string;
    transcriptPath?: string;
    outputDir?: string;
    resume?: {
        sourceTaskId: string;
        sourceRunId?: string;
        checkpointPath: string;
        transcriptJsonPath: string;
    };
    params: Omit<CouncilRunParams, "onProgress" | "signal">;
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
        "",
        formatCouncilArtifactSummary(result.runId),
        "",
        "## 最终结论",
        result.finalAnswer,
        lastRound?.moderator.summary ? `\n## 最后一轮主持摘要\n${lastRound.moderator.summary}` : "",
    ].filter(Boolean).join("\n");
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

async function main(): Promise<void> {
    const specPath = process.argv[2];
    if (!specPath) throw new Error("缺少 spec.json 路径");
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as WorkerSpec;
    const pid = process.pid;
    const workerIdentity = readCouncilWorkerIdentity(pid);
    let finalized = false;
    const controller = new AbortController();
    const deadlineMs = spec.deadlineAt ? new Date(spec.deadlineAt).getTime() - Date.now() : Number.NaN;
    const deadlineTimer = Number.isFinite(deadlineMs) ? setTimeout(() => {
        if (finalized) return;
        const error = `后台 worker 超过 deadline (${spec.deadlineAt})，已请求中止`;
        controller.abort(new Error(error));
        finalized = true;
        finalizeCouncilTask(spec.taskId, spec.ownerId, {
            status: "interrupted",
            error,
            pid,
            startedAt: spec.startedAt,
        });
    }, Math.max(0, deadlineMs)) : null;
    deadlineTimer?.unref?.();
    try {
        writeCouncilTaskProgress(spec.taskId, spec.ownerId, spec.resume ? "worker 已接管 resume 任务，准备恢复 council。" : "worker 已接管任务，准备进入 council 主循环。", pid, spec.startedAt, undefined, workerIdentity);
        const runParams: CouncilRunParams = {
            ...spec.params,
            ownerId: spec.ownerId,
            taskId: spec.taskId,
            runId: spec.runId,
            artifactManifestPath: spec.artifactManifestPath,
            checkpointPath: spec.checkpointPath || spec.params.checkpointPath,
            transcriptPath: spec.params.transcriptPath,
            outputDir: spec.params.outputDir,
            signal: controller.signal,
            onProgress: (progress) => writeCouncilTaskProgress(spec.taskId, spec.ownerId, progress, pid, spec.startedAt, undefined, workerIdentity),
        };
        const result = spec.resume
            ? await resumeCouncil({
                ...runParams,
                resumeState: {
                    sourceTaskId: spec.resume.sourceTaskId,
                    sourceRunId: spec.resume.sourceRunId,
                    checkpoint: readJson<CouncilCheckpoint>(spec.resume.checkpointPath),
                    transcript: readJson<CouncilTranscript>(spec.resume.transcriptJsonPath),
                },
            })
            : await runCouncil(runParams);
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
        if (controller.signal.aborted) {
            finalizeCouncilTask(spec.taskId, spec.ownerId, {
                status: "interrupted",
                error: err instanceof Error ? err.message : String(err),
                pid,
                startedAt: spec.startedAt,
            });
            return;
        }
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
