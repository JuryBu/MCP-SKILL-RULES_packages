import process from "node:process";
import fs from "node:fs";
import { loadConversationData } from "./conversation-bridge.js";
import { writeFetchedConversationArtifact } from "./conversation-fetch-artifact.js";
import {
    createCodexFetchWorkerLinkDiagnostics,
    isCodexFetchWorkerPayload,
    resolveCodexFetchWorkerLink,
    type CodexFetchWorkerCommand,
    type CodexFetchWorkerMessage,
    type CodexFetchWorkerPayload,
    type CodexFetchWorkerResult,
} from "./conversation-fetch-worker-types.js";

function send(message: CodexFetchWorkerMessage): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!process.send || !process.connected) {
            reject(new Error("conversation fetch worker IPC channel is closed"));
            return;
        }
        process.send(message, error => error ? reject(error) : resolve());
    });
}

async function execute(payload: CodexFetchWorkerPayload): Promise<CodexFetchWorkerResult> {
    const assertSourceCurrent = async (stage: string): Promise<void> => {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(payload.sourcePath);
        } catch {
            throw new Error(`Codex source changed ${stage}; start a fresh fetch`);
        }
        if (
            !stat.isFile()
            || stat.size !== payload.sourceSize
            || Math.trunc(stat.mtimeMs) !== Math.trunc(payload.sourceMtimeMs)
        ) {
            throw new Error(`Codex source changed ${stage}; start a fresh fetch`);
        }
    };
    if (cancellationRequested) throw new Error("conversation fetch worker cancelled");
    await assertSourceCurrent("before cache build");
    const startedAt = Date.now();
    const linkResolution = resolveCodexFetchWorkerLink(payload.link);
    await send({ type: "progress", stage: "cache", detail: "独立进程正在构建或复用 Codex fetch 缓存" });
    const cacheStartedAt = Date.now();
    const loaded = await loadConversationData("codex", payload.conversationId, {
        refresh: true,
        link: linkResolution.effectiveLink,
        source: payload.source,
        includeRounds: false,
        requestClass: "background",
        isCancelled: () => cancellationRequested,
        expectedCodexSource: {
            sourcePath: payload.sourcePath,
            sourceSize: payload.sourceSize,
            sourceMtimeMs: payload.sourceMtimeMs,
        },
    });
    if (cancellationRequested) throw new Error("conversation fetch worker cancelled");
    await assertSourceCurrent("after cache build");
    if (!loaded || loaded.chainUsed !== "codex" || !loaded.codexData) {
        throw new Error("Codex fetch worker 无法读取目标对话");
    }
    if (loaded.cacheState === "stale" && loaded.cacheBuildFailure) {
        throw new Error(`fetch cache rebuild failed: ${loaded.cacheBuildFailure.name}: ${loaded.cacheBuildFailure.message}`);
    }
    const cacheMs = Date.now() - cacheStartedAt;
    await send({ type: "progress", stage: "artifact", detail: "fetch 缓存已就绪，正在生成可读 Markdown 文件" });
    const artifactStartedAt = Date.now();
    const artifact = await writeFetchedConversationArtifact(
        loaded,
        loaded.codexData.expandedChildren || [],
        loaded.codexData.childDiagnostics || [],
        {
            isCancelled: () => cancellationRequested,
            onArtifactPath: path => send({ type: "artifact_path", path }),
        },
    );
    const artifactMs = Date.now() - artifactStartedAt;
    const thread = loaded.codexData.thread;
    const linkDiagnostics = createCodexFetchWorkerLinkDiagnostics(linkResolution, loaded.codexData.childThreads);
    return {
        artifact,
        chainUsed: "codex",
        conversationId: loaded.conversationId,
        totalSteps: loaded.totalSteps,
        roundCount: loaded.roundCount ?? artifact.roundCount,
        requestedLink: linkResolution.requestedLink,
        effectiveLink: linkResolution.effectiveLink,
        linkDiagnostics,
        cacheKey: loaded.cacheKey,
        cacheGeneration: loaded.cacheGeneration,
        cacheState: loaded.cacheState,
        cacheBuildFailure: loaded.cacheBuildFailure,
        cacheFingerprint: loaded.cacheFingerprint,
        sourceMode: loaded.sourceMode,
        sourceDiagnostics: [
            ...(loaded.sourceDiagnostics || []),
            ...linkDiagnostics.map(diagnostic => `Codex 后台 fetch: ${diagnostic.message}`),
        ],
        thread: {
            id: thread.id,
            title: thread.title || "",
            cwd: thread.cwd || "",
            parentConversationId: thread.parentConversationId || undefined,
            agentRole: thread.agentRole || undefined,
            agentNickname: thread.agentNickname || undefined,
        },
        parentThread: loaded.codexData.parentThread
            ? { id: loaded.codexData.parentThread.id, title: loaded.codexData.parentThread.title }
            : null,
        timings: {
            cacheMs,
            artifactMs,
            totalMs: Date.now() - startedAt,
        },
    };
}

let running = false;
let cancellationRequested = false;

process.on("message", message => {
    if (!message || typeof message !== "object") return;
    const command = message as Partial<CodexFetchWorkerCommand>;
    if (command.type === "cancel") {
        cancellationRequested = true;
        return;
    }
    if (running || command.type !== "run") return;
    const payload = command.payload;
    running = true;
    void (async () => {
        try {
            if (!isCodexFetchWorkerPayload(payload)) throw new Error("conversation fetch worker payload is invalid");
            const result = await execute(payload);
            await send({ type: "result", result });
            process.disconnect?.();
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            await send({
                type: "error",
                name: normalized.name,
                message: normalized.message,
                stack: normalized.stack,
            }).catch(() => undefined);
            process.disconnect?.();
            process.exitCode = 1;
        }
    })();
});

process.on("disconnect", () => {
    if (running) process.exit(process.exitCode || 0);
});
