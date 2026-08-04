import { createHash } from "node:crypto";
import fs from "node:fs";
import { createTempFilePathAsync } from "./temp-store.js";
import type { ConversationRound, ConversationUserMessage } from "./trajectory.js";

export const CONVERSATION_RECALL_METADATA_VERSION = 1 as const;
export const ANTIGRAVITY_RECALL_FALLBACK_TOKENS = 150_000;
export const ANTIGRAVITY_RECALL_FALLBACK_CHARS = 450_000;
const APPROX_CHARS_PER_TOKEN = 4;
const TEMP_ARTIFACT_TTL_MS = 60 * 60 * 1000;

export type ConversationRecallMode = "auto" | "manual" | "full";
export type ConversationRecallHost = "antigravity" | "codex" | "claude-code" | "windsurf";

export interface ConversationCompactionEvent {
    kind: "windsurf_token_drop" | "codex_agents_reinjection" | "claude_code_compact_summary";
    roundIndex: number;
    stepIndex: number;
    preContextChars: number;
    postContextChars: number;
    preTokens?: number;
    postTokens?: number;
    ratio?: number;
    reason?: string;
}

export interface ConversationCompactionMetadata {
    version: typeof CONVERSATION_RECALL_METADATA_VERSION;
    host: ConversationRecallHost;
    strategy: "detected" | "recent_context_fallback";
    roundCount: number;
    contextChars: number;
    roundContextChars: Array<{ roundIndex: number; chars: number }>;
    events: ConversationCompactionEvent[];
    latestObservedTokens?: number;
    fallbackChars?: number;
    fallbackTokens?: number;
}

export interface ConversationRecallSelection {
    startRound: number;
    endRound: number;
    targetContextChars: number;
    selectedContextChars: number;
    reason: string;
    event?: ConversationCompactionEvent;
}

export interface ConversationRecallArtifact {
    path: string;
    sha256: string;
    bytes: number;
    rounds: number;
    startRound: number;
    endRound: number;
    expiresAt: string;
}

function getUserMessages(round: ConversationRound): ConversationUserMessage[] {
    if (round.userMessages?.length) return round.userMessages;
    return [{
        stepIndex: round.startStep,
        text: round.userMessage || "",
        mediaAttachments: round.mediaAttachments,
        attachments: round.attachments,
    }];
}

function stripCodexRulesInjection(text: string): string {
    return text.replace(/^\[Codex AGENTS\/RULES 注入已折叠[^\n]*\]\s*/u, "").trim();
}

function stripResponseAnnotationsEnvelope(text: string, message: ConversationUserMessage): string {
    if (!message.annotations?.length || !text.includes("# Response annotations:")) return text;
    const marker = "## My request for Codex:";
    const markerIndex = text.indexOf(marker);
    return markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : "";
}

function safeAttachmentTarget(attachment: NonNullable<ConversationUserMessage["attachments"]>[number]): string {
    if (attachment.tempPath) return attachment.tempPath;
    if (attachment.originalPath) return attachment.originalPath;
    if (attachment.name) return attachment.name;
    return attachment.kind === "image" ? "内联图片（二进制已省略）" : "内联文件（二进制已省略）";
}

function renderRecallUserMessage(lines: string[], message: ConversationUserMessage, fallbackStep: number): void {
    let text = stripCodexRulesInjection(message.text || "");
    text = stripResponseAnnotationsEnvelope(text, message);
    const hasContent = Boolean(text || message.annotations?.length || message.attachments?.length || message.mediaAttachments?.length);
    if (!hasContent) return;
    lines.push(`### 👤 用户 (step ${message.stepIndex ?? fallbackStep})`);
    if (text) lines.push(text);
    for (const annotation of message.annotations || []) {
        lines.push("", "#### 📝 批注", `- 被批注文本: ${annotation.selectedText || "（空）"}`);
        lines.push(`- 用户评论: ${annotation.comment || "（评论为空）"}`);
    }
    for (const attachment of message.attachments || []) {
        lines.push(`📎 ${attachment.kind === "image" ? "图片" : "文件"}: ${safeAttachmentTarget(attachment)}`);
    }
    for (const media of message.mediaAttachments || []) {
        lines.push(`📎 图片: ${media.startsWith("data:") ? "内联图片（二进制已省略）" : media}`);
    }
    lines.push("");
}

export function formatConversationRecallRound(round: ConversationRound): string {
    const lines = [`## 轮次 ${round.roundIndex} (steps ${round.startStep}-${round.endStep})`];
    if (!round.compactionSummaries?.length) {
        for (const message of getUserMessages(round)) renderRecallUserMessage(lines, message, round.startStep);
    }
    for (const response of round.aiResponses) {
        const text = response.response?.trim();
        if (!text) continue;
        lines.push(`### 🤖 模型 (step ${response.stepIndex})`, text, "");
    }
    if (lines.length === 1) return "";
    lines.push("---");
    return lines.join("\n");
}

export function projectConversationRoundForRecallMetadata(round: ConversationRound): ConversationRound {
    return {
        roundIndex: round.roundIndex,
        startStep: round.startStep,
        endStep: round.endStep,
        userMessage: round.userMessage,
        mediaAttachments: [...round.mediaAttachments],
        attachments: round.attachments?.map(attachment => ({ ...attachment })),
        aiResponses: round.aiResponses.map(response => ({
            stepIndex: response.stepIndex,
            response: response.response,
            thinking: "",
            toolCalls: [],
        })),
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
        userMessages: round.userMessages?.map(message => ({
            ...message,
            mediaAttachments: message.mediaAttachments ? [...message.mediaAttachments] : undefined,
            attachments: message.attachments?.map(attachment => ({ ...attachment })),
            annotations: message.annotations?.map(annotation => ({ ...annotation })),
        })),
        legacyRoundIndices: round.legacyRoundIndices ? [...round.legacyRoundIndices] : undefined,
        semanticEvents: round.semanticEvents
            ?.filter(event => event.kind === "context_tokens")
            .map(event => ({
                stepIndex: event.stepIndex,
                rawRole: event.rawRole,
                semanticRole: event.semanticRole,
                kind: event.kind,
                contextTokens: event.contextTokens,
            })),
        compactionSummaries: round.compactionSummaries?.map(summary => ({ ...summary, text: "" })),
    };
}

function contextChars(round: ConversationRound): number {
    return formatConversationRecallRound(round).length;
}

function codexInjectionInfo(round: ConversationRound): { detected: boolean; reason?: string } {
    const messages = getUserMessages(round);
    for (const message of messages) {
        const match = (message.text || "").match(/^\[Codex AGENTS\/RULES 注入已折叠[^\n]*reason=([^\]\n]+)\]/u);
        if (match) return { detected: true, reason: match[1].trim() };
    }
    return { detected: false };
}

function contextTokenObservations(round: ConversationRound): Array<{ stepIndex: number; value: number }> {
    return (round.semanticEvents || [])
        .filter(event => event.kind === "context_tokens" && Number.isFinite(event.contextTokens) && Number(event.contextTokens) > 0)
        .map(event => ({ stepIndex: event.stepIndex ?? round.startStep, value: Number(event.contextTokens) }));
}

export function buildConversationCompactionMetadata(
    host: ConversationRecallHost,
    rounds: Iterable<ConversationRound>,
): ConversationCompactionMetadata {
    const roundContextChars: Array<{ roundIndex: number; chars: number }> = [];
    const pendingEvents: Array<Omit<ConversationCompactionEvent, "postContextChars"> & { boundaryChars: number }> = [];
    let totalContextChars = 0;
    let rulesInjectionCount = 0;
    let previousWindsurfTokens: { value: number; stepIndex: number; roundIndex: number } | null = null;
    let latestObservedTokens: number | undefined;
    const maxDropRatio = Math.min(0.95, Math.max(0.05, Number(process.env.MEMORY_STORE_WSF_COMPACTION_MAX_RATIO || 0.7)));
    const minimumDrop = Math.max(1, Number(process.env.MEMORY_STORE_WSF_COMPACTION_MIN_DROP_TOKENS || 20_000));

    for (const round of rounds) {
        const chars = contextChars(round);
        const charsBeforeRound = totalContextChars;
        roundContextChars.push({ roundIndex: round.roundIndex, chars });

        if (host === "codex") {
            const injection = codexInjectionInfo(round);
            if (injection.detected) {
                rulesInjectionCount += 1;
                if (rulesInjectionCount >= 2) {
                    pendingEvents.push({
                        kind: "codex_agents_reinjection",
                        roundIndex: round.roundIndex,
                        stepIndex: round.startStep,
                        preContextChars: charsBeforeRound,
                        boundaryChars: charsBeforeRound + chars,
                        reason: injection.reason || "codex_agents_injection",
                    });
                }
            }
        } else if (host === "claude-code" && round.compactionSummaries?.length) {
            const summary = round.compactionSummaries.at(-1);
            pendingEvents.push({
                kind: "claude_code_compact_summary",
                roundIndex: round.roundIndex,
                stepIndex: round.startStep,
                preContextChars: charsBeforeRound,
                boundaryChars: charsBeforeRound + chars,
                ...(summary?.preTokens !== undefined ? { preTokens: summary.preTokens } : {}),
                ...(summary?.postTokens !== undefined ? { postTokens: summary.postTokens } : {}),
                reason: summary?.trigger || "isCompactSummary",
            });
        } else if (host === "windsurf") {
            for (const observation of contextTokenObservations(round)) {
                latestObservedTokens = observation.value;
                if (previousWindsurfTokens) {
                    const drop = previousWindsurfTokens.value - observation.value;
                    const ratio = observation.value / previousWindsurfTokens.value;
                    if (drop >= minimumDrop && ratio <= maxDropRatio) {
                        pendingEvents.push({
                            kind: "windsurf_token_drop",
                            roundIndex: round.roundIndex,
                            stepIndex: observation.stepIndex,
                            preContextChars: charsBeforeRound,
                            boundaryChars: charsBeforeRound + chars,
                            preTokens: previousWindsurfTokens.value,
                            postTokens: observation.value,
                            ratio,
                            reason: `context token count dropped by ${drop}`,
                        });
                    }
                }
                previousWindsurfTokens = { value: observation.value, stepIndex: observation.stepIndex, roundIndex: round.roundIndex };
            }
        }

        totalContextChars += chars;
    }

    return {
        version: CONVERSATION_RECALL_METADATA_VERSION,
        host,
        strategy: host === "antigravity" ? "recent_context_fallback" : "detected",
        roundCount: roundContextChars.length,
        contextChars: totalContextChars,
        roundContextChars,
        events: pendingEvents.map(({ boundaryChars, ...event }) => ({
            ...event,
            postContextChars: Math.max(0, totalContextChars - boundaryChars),
        })),
        ...(latestObservedTokens !== undefined ? { latestObservedTokens } : {}),
        ...(host === "antigravity" ? { fallbackChars: ANTIGRAVITY_RECALL_FALLBACK_CHARS } : {}),
        ...(host === "antigravity" ? { fallbackTokens: ANTIGRAVITY_RECALL_FALLBACK_TOKENS } : {}),
    };
}

function selectBackward(
    metadata: ConversationCompactionMetadata,
    endRound: number,
    targetChars: number,
): { startRound: number; selectedChars: number } {
    let selectedChars = 0;
    let startRound = Math.max(1, endRound);
    for (let index = metadata.roundContextChars.length - 1; index >= 0; index -= 1) {
        const item = metadata.roundContextChars[index];
        if (item.roundIndex > endRound) continue;
        startRound = item.roundIndex;
        selectedChars += item.chars;
        if (selectedChars >= targetChars) break;
    }
    return { startRound, selectedChars };
}

export function selectConversationRecallRange(
    metadata: ConversationCompactionMetadata,
    mode: ConversationRecallMode,
    startRound?: number,
    endRound?: number,
): ConversationRecallSelection | null {
    if (metadata.roundCount <= 0) return null;
    if (mode === "manual") {
        const start = startRound ?? 1;
        const end = endRound ?? metadata.roundCount;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > metadata.roundCount) {
            throw new Error(`manual recall round range must satisfy 1 <= startRound <= endRound <= ${metadata.roundCount}`);
        }
        const selected = metadata.roundContextChars.filter(item => item.roundIndex >= start && item.roundIndex <= end);
        return {
            startRound: start,
            endRound: end,
            targetContextChars: selected.reduce((sum, item) => sum + item.chars, 0),
            selectedContextChars: selected.reduce((sum, item) => sum + item.chars, 0),
            reason: "manual human-round range",
        };
    }
    if (mode === "full") {
        return {
            startRound: 1,
            endRound: metadata.roundCount,
            targetContextChars: metadata.contextChars,
            selectedContextChars: metadata.contextChars,
            reason: "full context-only recall",
        };
    }
    if (metadata.host === "antigravity") {
        const target = metadata.fallbackChars || ANTIGRAVITY_RECALL_FALLBACK_CHARS;
        const selected = selectBackward(metadata, metadata.roundCount, target);
        return {
            startRound: selected.startRound,
            endRound: metadata.roundCount,
            targetContextChars: target,
            selectedContextChars: selected.selectedChars,
            reason: `Antigravity has no reliable compaction marker; return about ${metadata.fallbackTokens || ANTIGRAVITY_RECALL_FALLBACK_TOKENS} recent tokens (${target} context characters)`,
        };
    }
    const event = metadata.events.at(-1);
    if (!event) return null;
    let targetChars: number;
    if (metadata.host === "windsurf" && event.preTokens !== undefined) {
        const currentTokens = metadata.latestObservedTokens ?? event.postTokens ?? 0;
        const targetTokens = Math.max(0, Math.floor(event.preTokens * 0.6) - currentTokens);
        const observedCharsPerToken = event.preContextChars > 0
            ? event.preContextChars / event.preTokens
            : APPROX_CHARS_PER_TOKEN;
        targetChars = Math.ceil(targetTokens * Math.max(1, observedCharsPerToken));
    } else {
        targetChars = Math.max(0, Math.floor(event.preContextChars * 0.6) - event.postContextChars);
    }
    if (targetChars <= 0 || event.roundIndex <= 1) {
        return {
            startRound: Math.max(1, event.roundIndex - 1),
            endRound: Math.max(1, event.roundIndex - 1),
            targetContextChars: 0,
            selectedContextChars: 0,
            reason: "post-compaction visible context already reaches 60% of the pre-compaction scale",
            event,
        };
    }
    const end = event.roundIndex - 1;
    const selected = selectBackward(metadata, end, targetChars);
    return {
        startRound: selected.startRound,
        endRound: end,
        targetContextChars: targetChars,
        selectedContextChars: selected.selectedChars,
        reason: `restore visible context to about 60% of the pre-compaction scale after ${event.kind}`,
        event,
    };
}

export async function writeConversationRecallArtifact(input: {
    conversationId: string;
    dataChain: ConversationRecallHost;
    cacheGeneration: string;
    selection: ConversationRecallSelection;
    rounds: Iterable<ConversationRound>;
}): Promise<ConversationRecallArtifact> {
    const outputPath = await createTempFilePathAsync("recall", input.conversationId.slice(0, 12));
    const handle = await fs.promises.open(outputPath, "w");
    const hash = createHash("sha256");
    let bytes = 0;
    let rounds = 0;
    const write = async (text: string): Promise<void> => {
        const chunk = Buffer.from(text, "utf8");
        hash.update(chunk);
        bytes += chunk.byteLength;
        await handle.write(chunk);
    };
    try {
        await write([
            "# Conversation Recall",
            "",
            `- conversationId: ${input.conversationId}`,
            `- dataChain: ${input.dataChain}`,
            `- cacheGeneration: ${input.cacheGeneration}`,
            `- rounds: ${input.selection.startRound}-${input.selection.endRound}`,
            "- projection: context-only",
            `- createdAt: ${new Date().toISOString()}`,
            "",
        ].join("\n"));
        for (const round of input.rounds) {
            const formatted = formatConversationRecallRound(round);
            if (!formatted) continue;
            await write(`${formatted}\n\n`);
            rounds += 1;
        }
    } catch (error) {
        await handle.close();
        fs.rmSync(outputPath, { force: true });
        throw error;
    }
    await handle.close();
    return {
        path: outputPath,
        sha256: hash.digest("hex"),
        bytes,
        rounds,
        startRound: input.selection.startRound,
        endRound: input.selection.endRound,
        expiresAt: new Date(Date.now() + TEMP_ARTIFACT_TTL_MS).toISOString(),
    };
}
