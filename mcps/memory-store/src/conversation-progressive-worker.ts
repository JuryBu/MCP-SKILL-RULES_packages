import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { readCodexHistoryWindow, type CodexHistoryWindowRange } from "./codex-history-window.js";
import { getCodexThreadAsync } from "./codex-client.js";
import { openProgressiveCache } from "./conversation-progressive-cache.js";
import { writeProgressiveState } from "./conversation-progressive-task.js";
import { isProgressiveTaskPayload, normalizeProgressiveProjection, type ProgressiveReadyState, type ProgressiveTaskPayload } from "./conversation-progressive-task-types.js";
import { projectProgressiveInput, projectProgressiveRound, projectProgressiveSource, publishProgressiveBlocks } from "./conversation-progressive-projection.js";
import type { ProgressiveCache, ProgressiveSource, ProgressiveWriter } from "./conversation-progressive-types.js";
import type { ConversationRound } from "./trajectory.js";

let cancelled = false;
let started = false;
let active: { cache: ProgressiveCache; writer: ProgressiveWriter } | undefined;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let initialDeadlineAt: number | undefined;
const check = (): void => {
    if (cancelled) throw new Error("Progressive preparation cancelled");
    if (initialDeadlineAt !== undefined && Date.now() >= initialDeadlineAt) throw new Error("Initial progressive range deadline exceeded; published ranges remain readable");
};
const send = (message: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error("Progressive worker IPC disconnected")); return; }
    process.send(message, error => error ? reject(error) : resolve());
});

async function execute(payload: ProgressiveTaskPayload): Promise<string> {
    initialDeadlineAt = payload.phase === "full" ? undefined : payload.initialDeadlineAt;
    if (payload.request.dataChain !== "codex") {
        const { executeHostProgressivePreparation } = await import("./conversation-progressive-worker-hosts.js");
        return executeHostProgressivePreparation(payload, { isCancelled: () => cancelled, onProgress: send,
            onActive: value => { active = value; } });
    }
    const { request, directory } = payload;
    let projection = normalizeProgressiveProjection(request.messageRoles, request.depth);
    let ready: ProgressiveReadyState = { version: 1, phase: "source", previous: [], requestedRangeComplete: false,
        updatedAt: new Date().toISOString(), warnings: [] };
    try { ready = JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const writeReady = async (): Promise<void> => {
        check();
        ready.updatedAt = new Date().toISOString();
        await writeProgressiveState(path.join(directory, "ready.json"), ready);
    };
    const select = async (cacheDirectory: string, source: ProgressiveSource): Promise<void> => {
        if (ready.current?.directory !== cacheDirectory) {
            if (ready.current && !ready.previous.some(item => item.directory === ready.current!.directory)) ready.previous.push(ready.current);
            ready.current = { directory: cacheDirectory, source };
        }
        await writeReady();
    };
    let publicationOrder = 0;
    const ancestryWarning = "CODEX_HISTORY_ANCESTRY_PENDING: 当前明文窗口已发布为相对轮号，声明的祖先尚未认证，完整范围仍未完成";
    const publishRaw = async (range: CodexHistoryWindowRange): Promise<void> => {
        check();
        const source = projectProgressiveSource(range.source, request);
        const sourceRangeVerified = (source.snapshot as { source?: { sourceRangeVerified?: boolean } })?.source?.sourceRangeVerified !== false;
        if (!sourceRangeVerified && !ready.warnings.includes(ancestryWarning)) ready.warnings.push(ancestryWarning);
        if (sourceRangeVerified) ready.warnings = ready.warnings.filter(warning => warning !== ancestryWarning);
        const cacheDirectory = range.publication === "append" && ready.current?.source.revision === source.revision
            ? ready.current.directory : path.join(directory, "ranges", hash([source.revision, range.rangeId]));
        const cache = await openProgressiveCache({ root: cacheDirectory, source });
        if (ready.current?.source.revision !== source.revision) {
            if (ready.current) ready.warnings.push("Source revision changed; previous references remain tied to their original snapshot");
            ready.preferredBlockIds = [];
            ready.requestedRangeComplete = false;
        }
        const writer = await cache.beginWrite();
        active = { cache, writer };
        const blockIds: string[] = [];
        const order = publicationOrder++ * (request.direction === "latest" ? -100000 : 100000);
        for (let offset = 0; offset < range.rounds.length; offset += 25) {
            check();
            const batch = range.rounds.slice(offset, offset + 25);
            const selectedIndices = new Set(batch.map(round => round.roundIndex));
            const blocks = await publishProgressiveBlocks(cache, writer, projectProgressiveInput({
                coverage: { kind: "relative", startRound: batch[0].roundIndex, endRound: batch.at(-1)!.roundIndex },
                anchor: { ...range.anchor, rangeId: range.rangeId, batchStart: batch[0].roundIndex },
                sourceSnapshot: source.snapshot,
                order: order + offset,
                rounds: batch,
                messages: range.messages.filter(message => selectedIndices.has(message.round)),
            }, request, source.conversation?.isChildThread), check);
            blockIds.push(...blocks.map(block => block.blockId));
        }
        ready.phase = "range-ready";
        const status = await cache.status();
        if (range.publication === "replace") ready.preferredBlockIds = blockIds;
        else {
            const preferred = new Set(ready.preferredBlockIds || []);
            let preferredRounds = status.blocks.filter(block => preferred.has(block.blockId)).reduce((sum, block) => sum + block.roundCount, 0);
            for (const block of status.blocks.filter(block => blockIds.includes(block.blockId))) {
                if (!preferred.has(block.blockId) && preferredRounds < request.initialRounds) {
                    preferred.add(block.blockId);
                    preferredRounds += block.roundCount;
                }
            }
            ready.preferredBlockIds = status.blocks.filter(block => preferred.has(block.blockId))
                .sort((first, second) => (first.order ?? 0) - (second.order ?? 0)).map(block => block.blockId);
        }
        ready.requestedRangeComplete = sourceRangeVerified && (status.relativeReadyRounds >= request.initialRounds
            || range.coverage.requestedRangeComplete
            || (request.direction === "latest" ? range.coverage.historyStartReached : range.coverage.snapshotEndReached));
        await select(cacheDirectory, source);
        await send({ type: "progress", stage: ready.phase, current: status.relativeReadyRounds,
            detail: "已就绪 " + status.relativeReadyRounds + " 轮，可立即读、搜、定位；其余内容继续准备" });
        await cache.release(writer);
        active = undefined;
    };
    const thread = await getCodexThreadAsync(request.conversationId);
    if (!thread?.rolloutPath) throw new Error("Codex conversation source is unavailable");
    if (thread.isChildThread && request.messageRolesExplicit === false) {
        request.messageRoles = ["subagent"];
        projection = normalizeProgressiveProjection(request.messageRoles, request.depth);
    }
    let lastProgress = 0;
    if (payload.phase !== "full") {
        try { await readCodexHistoryWindow({
            conversationId: request.conversationId, sourcePath: thread.rolloutPath,
            direction: request.direction, maxRounds: request.initialRounds,
            continueHistory: false,
            fillRequestedRange: true,
            rangeRounds: Math.min(25, request.initialRounds), messageRoles: projection.messageRoles,
            isCancelled: () => { check(); return false; },
            onRange: publishRaw,
            onProgress: async progress => {
                if (Date.now() - lastProgress < 250) return;
                lastProgress = Date.now();
                await send({ type: "progress", stage: "range:" + progress.phase, current: progress.roundsReady,
                    detail: "已读取 " + progress.bytesRead + " 字节、" + progress.segmentsRead + " 个来源片段" });
            },
        }); } catch (error) {
            if (!request.buildFull || !(error instanceof Error) || !error.message.includes("window replica verification required")) throw error;
            ready.warnings.push("Replicated source requires full canonical verification before ranges become available");
            await writeReady();
        }
        check();
        if (!request.buildFull) {
            if (!ready.requestedRangeComplete) ready.warnings.push("CODEX_WINDOW_RECOVERY: 当前局部范围或祖先认证尚未完成，可用以下请求继续完整准备；仍保留原资源上限：" + JSON.stringify({
                action: "prepare", conversationId: request.ownerId, conversationIds: [request.conversationId], dataChain: "codex",
                lastRounds: request.initialRounds, prepareCache: true, buildOrder: request.direction, waitSeconds: 0,
                messageRoles: request.messageRoles, depth: request.depth,
            }));
            ready.phase = "requested-range-ready";
            await writeReady();
            return JSON.stringify({ taskId: payload.taskId, ready });
        }
        ready.phase = "full-cache";
        await writeReady();
        return JSON.stringify({ taskId: payload.taskId, ready, continueFull: true });
    }
    await send({ type: "progress", stage: ready.phase, detail: "所需范围可继续使用，后台正在准备完整历史" });
    const { loadConversationData, getConversationRoundIndexBounds } = await import("./conversation-bridge.js");
    const { iterateCachedConversationSourceCacheRounds } = await import("./conversation-source-cache.js");
    const { projectCodexCorpusRound } = await import("./conversation-corpus-reader-projection.js");
    const loaded = await loadConversationData("codex", request.conversationId, {
        source: "local", refresh: true, link: request.link || "reference", includeRounds: false, requestClass: "background", isCancelled: () => cancelled,
    }).catch(async error => {
        ready.warnings.push("CODEX_FULL_CACHE_PENDING: 完整历史准备失败，已发布范围及原引用继续保留；" + (error instanceof Error ? error.message : String(error)));
        await writeReady();
        throw error;
    });
    check();
    if (!loaded?.cacheKey || !loaded.cacheGeneration || loaded.sourcePartial || loaded.cacheBuildFailure) {
        ready.warnings.push("CODEX_FULL_CACHE_PENDING: 完整历史未通过全部来源验证，已发布局部范围继续可读");
        await writeReady();
        throw new Error("Full history cache is not completely verified; ready ranges remain available");
    }
    const bounds = getConversationRoundIndexBounds(loaded);
    const total = loaded.roundCount ?? 0;
    const source = projectProgressiveSource({
        conversationId: request.conversationId, host: "codex", revision: hash([loaded.cacheGeneration, loaded.cacheFingerprint]),
        snapshot: { cacheKey: loaded.cacheKey, generation: loaded.cacheGeneration, fingerprint: loaded.cacheFingerprint },
        totalRounds: total,
        conversation: { id: request.conversationId, title: thread.title || "", workspace: thread.cwd || "", source: "codex",
            isChildThread: thread.isChildThread, parentConversationId: thread.parentConversationId || undefined,
            agentNickname: thread.agentNickname || undefined, agentRole: thread.agentRole || undefined },
    }, request);
    const cacheDirectory = path.join(directory, "ranges", hash(source.revision));
    const cache = await openProgressiveCache({ root: cacheDirectory, source });
    const writer = await cache.beginWrite();
    active = { cache, writer };
    ready.phase = "publishing-full-ranges";
    const maximum = bounds.last ?? total;
    const minimum = bounds.first ?? 1;
    let published = 0;
    for (let offset = 0; offset < maximum - minimum + 1; offset += 25) {
        check();
        const endRound = request.direction === "latest" ? maximum - offset : Math.min(maximum, minimum + offset + 24);
        const startRound = request.direction === "latest" ? Math.max(minimum, endRound - 24) : minimum + offset;
        const selected = iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: loaded.cacheKey, generation: loaded.cacheGeneration, startRound, endRound,
        });
        if (!selected) throw new Error("Full-cache range is unavailable");
        const rounds = Array.from(selected.rounds, round => projectProgressiveRound(round, projection, thread.isChildThread));
        if (!rounds.length) continue;
        await publishProgressiveBlocks(cache, writer, {
            coverage: { kind: "absolute", startRound, endRound },
            anchor: { generation: loaded.cacheGeneration, startRound, endRound },
            rounds, messages: rounds.flatMap(round => projectCodexCorpusRound(request.conversationId, round, new Map(),
                projection.messageRoles, thread.rolloutPath)),
        }, check);
        published += rounds.length;
        await send({ type: "progress", stage: ready.phase, current: published, detail: "完整轮号已准备 " + published + "/" + total + " 轮；已发布范围继续可用" });
        await setImmediate();
    }
    await cache.finish(writer);
    active = undefined;
    ready.phase = "complete";
    ready.warnings = ready.warnings.filter(warning => !warning.startsWith("CODEX_HISTORY_ANCESTRY_PENDING:") && !warning.startsWith("CODEX_WINDOW_RECOVERY:") && !warning.startsWith("CODEX_FULL_CACHE_PENDING:"));
    ready.preferredBlockIds = undefined;
    ready.fullCacheGeneration = loaded.cacheGeneration;
    ready.requestedRangeComplete = true;
    await select(cacheDirectory, source);
    return JSON.stringify({ taskId: payload.taskId, ready });
}

if (process.send) {
    process.on("disconnect", () => { cancelled = true; });
    process.on("message", async (message: { type?: string; payload?: unknown }) => {
        if (message.type === "cancel") { cancelled = true; return; }
        if (message.type !== "run" || started) return;
        started = true;
        try {
            if (!isProgressiveTaskPayload(message.payload)) throw new Error("Invalid progressive worker payload");
            const result = await execute(message.payload);
            await send({ type: "result", result });
        } catch (error) {
            if (active) await active.cache.cancel(active.writer).catch(() => undefined);
            if (process.connected) await send({ type: "error", error: error instanceof Error ? error.message : String(error) });
            process.exitCode = 1;
        } finally { if (process.connected) process.disconnect(); }
    });
}

