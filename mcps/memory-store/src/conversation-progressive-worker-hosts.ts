import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createMultiCorpusProvider } from "./conversation-corpus-reader-multi.js";
import { corpusProjectionIdentityMatches } from "./conversation-host-binary.js";
import { openProgressiveCache } from "./conversation-progressive-cache.js";
import { projectProgressiveInput, projectProgressiveSource, publishProgressiveBlocks } from "./conversation-progressive-projection.js";
import { writeProgressiveState } from "./conversation-progressive-task.js";
import { normalizeProgressiveProjection, type ProgressiveReadyState, type ProgressiveTaskPayload } from "./conversation-progressive-task-types.js";
import type { CorpusMessage, CorpusProjection, CorpusRangeProvider } from "./conversation-corpus-types.js";
import type { ProgressiveCache, ProgressiveSource, ProgressiveWriter } from "./conversation-progressive-types.js";
import type { ConversationRound } from "./trajectory.js";

export interface HostProgressiveControl {
    isCancelled: () => boolean;
    onProgress: (message: unknown) => Promise<void>;
    onActive: (active?: { cache: ProgressiveCache; writer: ProgressiveWriter }) => void;
    provider?: CorpusRangeProvider;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function hostProjectionRounds(projection: CorpusProjection): ConversationRound[] {
    if (projection.rounds) return projection.rounds;
    const grouped = new Map<number, CorpusMessage[]>();
    for (const message of projection.messages) {
        const messages = grouped.get(message.round) ?? [];
        messages.push(message);
        grouped.set(message.round, messages);
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right).map(([roundIndex, messages]) => {
        const step = (message: CorpusMessage, index: number): number => message.position.ordinal ?? index;
        const users = messages.filter(message => message.role === "user");
        return {
            roundIndex, startStep: messages.reduce((minimum, message, index) => Math.min(minimum, step(message, index)), Number.MAX_SAFE_INTEGER),
            endStep: messages.reduce((maximum, message, index) => Math.max(maximum, step(message, index)), 0),
            createdAt: users[0]?.timestamp ?? messages[0]?.timestamp,
            userMessage: users.map(message => message.text).join("\n\n"),
            userMessages: users.map((message, index) => ({ text: message.text, stepIndex: step(message, index),
                createdAt: message.timestamp, semanticRole: "user" as const, annotations: message.annotations,
                attachments: message.attachments, mediaAttachments: message.mediaAttachments })),
            mediaAttachments: users.flatMap(message => message.mediaAttachments ?? []),
            attachments: users.flatMap(message => message.attachments ?? []),
            aiResponses: messages.filter(message => message.role === "assistant").map((message, index) => ({
                stepIndex: step(message, index), response: message.text, thinking: "", toolCalls: [],
            })),
            toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
            semanticEvents: messages.map((message, index) => ({ text: message.text, stepIndex: step(message, index),
                createdAt: message.timestamp, semanticRole: message.role === "assistant" ? "model" as const : message.role,
                attachments: message.attachments })),
        };
    });
}

export async function executeHostProgressivePreparation(payload: ProgressiveTaskPayload, control: HostProgressiveControl): Promise<string> {
    const { request, directory } = payload;
    const provider = control.provider ?? createMultiCorpusProvider();
    const projection = normalizeProgressiveProjection(request.messageRoles, request.depth);
    const check = (): void => { if (control.isCancelled()) throw new Error("Progressive preparation cancelled"); };
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
    const candidates = await provider.list({ conversationIds: [request.conversationId], dataChains: [request.dataChain],
        sourceFailureMode: "fail" }, { isCancelled: control.isCancelled });
    const conversation = candidates.find(candidate => candidate.source === request.dataChain
        && (candidate.id === request.conversationId || candidate.canonicalId === request.conversationId || candidate.aliases?.includes(request.conversationId)));
    if (!conversation) throw new Error("Conversation is unavailable in the explicitly selected source");
    let initialWindow: { revision: string; kind: string; endRound: number } | undefined;
    const publish = async (input: CorpusProjection, initial: boolean, final: boolean): Promise<void> => {
        check();
        if (!corpusProjectionIdentityMatches(input.conversation, conversation)) {
            throw new Error("Conversation projection source identity changed");
        }
        if (/^pending(?:[:/-]|$)/u.test(input.revision)) throw new Error("Unverified source revisions cannot publish ready ranges");
        const rounds = hostProjectionRounds(input);
        if (rounds.some(round => !Number.isSafeInteger(round.roundIndex) || round.roundIndex < 1)) throw new Error("Source returned invalid round numbers");
        const kind = input.roundNumbering ?? "absolute";
        if (initial) initialWindow = { revision: input.revision, kind,
            endRound: rounds.reduce((maximum, round) => Math.max(maximum, round.roundIndex), 0) };
        const totalRounds = input.totalRounds ?? (input.complete && kind === "absolute"
            ? rounds.reduce((maximum, round) => Math.max(maximum, round.roundIndex), 0) : undefined);
        const sourceRangeVerified = input.partial !== true && input.requestedRangeComplete !== false;
        const source = projectProgressiveSource({ conversationId: request.conversationId, host: request.dataChain,
            revision: input.revision, snapshot: { source: request.dataChain, conversationId: input.conversation.id, revision: input.revision, sourceRangeVerified },
            totalRounds, conversation: input.conversation }, request);
        const cacheDirectory = path.join(directory, "ranges", hash([source.revision, kind, initial ? "window" : "full", totalRounds ?? null, sourceRangeVerified]));
        const cache = await openProgressiveCache({ root: cacheDirectory, source });
        const before = await cache.status();
        if (before.complete) {
            ready.phase = "complete";
            ready.requestedRangeComplete = true;
            await select(cacheDirectory, source);
            return;
        }
        const covered = before.completeRanges.filter(range => range.kind === kind);
        const pending = rounds.filter(round => !covered.some(range => round.roundIndex >= range.startRound && round.roundIndex <= range.endRound))
            .sort((left, right) => left.roundIndex - right.roundIndex);
        const writer = await cache.beginWrite();
        control.onActive({ cache, writer });
        try {
            const batches: ConversationRound[][] = [];
            for (let offset = 0; offset < pending.length; offset += 25) batches.push(pending.slice(offset, offset + 25));
            if (request.direction === "latest") batches.reverse();
            for (const batch of batches) {
                check();
                const indices = new Set(batch.map(round => round.roundIndex));
                await publishProgressiveBlocks(cache, writer, projectProgressiveInput({
                    coverage: { kind, startRound: batch[0]!.roundIndex, endRound: batch.at(-1)!.roundIndex },
                    anchor: { source: request.dataChain, revision: input.revision, first: batch[0]!.roundIndex, last: batch.at(-1)!.roundIndex },
                    rounds: batch, messages: input.messages.filter(message => indices.has(message.round)),
                }, request), check);
                const status = await cache.status();
                const count = kind === "relative" ? status.relativeReadyRounds : status.coveredAbsoluteRounds;
                ready.warnings = [...new Set([...ready.warnings, ...input.warnings, ...(conversation.sourceWarnings ?? [])])];
                ready.phase = initial ? "range-ready" : "publishing-full-ranges";
                const requestedEnd = request.direction === "oldest" ? Math.min(request.initialRounds, totalRounds ?? request.initialRounds)
                    : totalRounds ?? (initialWindow?.kind === "absolute" && initialWindow.revision === input.revision ? initialWindow.endRound : undefined);
                const requestedStart = request.direction === "oldest" ? 1
                    : requestedEnd === undefined ? undefined : Math.max(1, requestedEnd - request.initialRounds + 1);
                let nextRound = requestedStart;
                if (kind === "absolute" && nextRound !== undefined && requestedEnd !== undefined) {
                    for (const range of status.completeRanges.filter(range => range.kind === kind).sort((left, right) => left.startRound - right.startRound)) {
                        if (range.startRound > nextRound) break;
                        if (range.endRound >= nextRound) nextRound = range.endRound + 1;
                    }
                }
                const requestedWindowCovered = kind === "absolute" && nextRound !== undefined && requestedEnd !== undefined && nextRound > requestedEnd;
                if (!ready.current || initial || requestedWindowCovered || (final && input.complete && sourceRangeVerified)) {
                    ready.requestedRangeComplete = sourceRangeVerified && (input.requestedRangeComplete === true
                        || (input.complete && final) || requestedWindowCovered);
                    await select(cacheDirectory, source);
                } else await writeReady();
                await control.onProgress({ type: "progress", stage: ready.phase, current: count,
                    detail: "已验证并发布 " + count + " 轮，已就绪范围可继续读、搜与定位" });
                await setImmediate();
            }
            if (final && input.complete && kind === "absolute" && sourceRangeVerified) {
                await cache.finish(writer);
                ready.phase = "complete";
                ready.requestedRangeComplete = true;
                ready.preferredBlockIds = undefined;
                ready.fullCacheGeneration = input.cacheGeneration;
                await select(cacheDirectory, source);
            } else {
                await cache.release(writer);
                if (!ready.current && !rounds.length) await select(cacheDirectory, source);
            }
        } catch (error) {
            await cache.cancel(writer).catch(() => undefined);
            throw error;
        } finally { control.onActive(); }
    };
    const readInitialWindow = async (): Promise<CorpusProjection> => {
        let acceptingProgress = true;
        let progressPending = false;
        let progressFailed = false;
        let progressError: unknown;
        let progressPublication = Promise.resolve();
        let lastProgress = 0;
        let window: CorpusProjection | undefined;
        let readFailed = false;
        let readError: unknown;
        try {
            window = await provider.readFast(conversation, request.direction === "latest"
                ? { lastRounds: request.initialRounds } : { startRound: 1, endRound: request.initialRounds }, {
                messageRoles: projection.messageRoles, isCancelled: control.isCancelled,
                onProgress: progress => {
                    if (!acceptingProgress || progressPending || progressFailed || control.isCancelled()) return;
                    if (Date.now() - lastProgress < 250) return;
                    lastProgress = Date.now();
                    progressPending = true;
                    progressPublication = progressPublication.then(() => control.onProgress({ type: "progress", stage: "source:" + progress.phase,
                        current: progress.bytes, total: progress.totalBytes, detail: "来源处理 " + (progress.bytes ?? 0) + " 字节" }))
                        .catch(error => { progressFailed = true; progressError = error; })
                        .finally(() => { progressPending = false; });
                },
            });
        } catch (error) { readFailed = true; readError = error; }
        finally { acceptingProgress = false; await progressPublication; }
        if (readFailed) throw readError;
        if (progressFailed) throw progressError;
        if (!window) throw new Error("Conversation source did not return an initial projection");
        return window;
    };
    const window = await readInitialWindow();
    const windowRounds = hostProjectionRounds(window);
    const windowContainsFull = window.complete && window.partial !== true && window.requestedRangeComplete !== false
        && window.roundNumbering !== "relative" && window.totalRounds !== undefined
        && windowRounds.length === window.totalRounds
        && (window.totalRounds === 0 || (windowRounds[0]?.roundIndex === 1 && windowRounds.at(-1)?.roundIndex === window.totalRounds));
    await publish(window, true, windowContainsFull);
    if (!request.buildFull || windowContainsFull) {
        if (!windowContainsFull) { ready.phase = "requested-range-ready"; await writeReady(); }
        return JSON.stringify({ taskId: payload.taskId, ready });
    }
    ready.phase = "full-cache";
    await writeReady();
    await control.onProgress({ type: "progress", stage: ready.phase, detail: "已就绪范围继续可用，其余历史正在后台准备" });
    let publication = Promise.resolve();
    let publicationError: unknown;
    let acceptingPublication = true;
    const enqueuePublication = (work: () => Promise<void>): Promise<void> => {
        if (!acceptingPublication) return Promise.resolve();
        const next = publication.then(async () => { if (!publicationError) await work(); });
        publication = next.catch(error => { publicationError ??= error; });
        return next;
    };
    let lastProgress = 0;
    let complete: CorpusProjection | undefined;
    let readError: unknown;
    try { complete = await provider.read(conversation, {
        messageRoles: projection.messageRoles, isCancelled: control.isCancelled,
        onProgress: progress => {
            if (!acceptingPublication) return;
            check();
            if (Date.now() - lastProgress < 250) return;
            lastProgress = Date.now();
            void enqueuePublication(() => control.onProgress({ type: "progress", stage: "source:" + progress.phase,
                current: progress.bytes, detail: "来源处理 " + (progress.bytes ?? 0) + " 字节" }));
        },
        onChunk: chunk => {
            if (!acceptingPublication) return;
            if (!chunk.verified || /^pending(?:[:/-]|$)/u.test(chunk.revision) || chunk.replaceFromRound !== undefined) return;
            return enqueuePublication(() => publish({ ...chunk, complete: false }, false, false));
        },
    }); } catch (error) { readError = error; }
    finally { acceptingPublication = false; await publication; }
    if (readError) throw readError;
    if (publicationError) throw publicationError;
    if (!complete) throw new Error("Conversation source did not return a final projection");
    await publish(complete, false, true);
    if (!complete.complete) {
        ready.phase = "partial";
        ready.warnings = [...new Set([...ready.warnings, "Source coverage remains partial; only the published verified ranges are available"] )];
        await writeReady();
    }
    return JSON.stringify({ taskId: payload.taskId, ready });
}
