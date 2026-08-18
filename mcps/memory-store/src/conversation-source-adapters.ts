import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationAttachment } from "./conversation-attachments.js";
import {
    LocalPbReaderError,
    readLocalPbFileCandidate,
    type LocalPbCandidateKind,
    type LocalPbErrorCode,
    type LocalPbFileCandidate,
    type LocalPbPlannerResponse,
    type LocalPbReadResult,
    type LocalPbStep,
    type LocalPbSourceFlavor,
} from "./local-pb-reader.js";
import { mergeConsecutiveHumanRounds, type ConversationRound } from "./trajectory.js";
import { readFiniteIntegerEnv, type ConversationSourceFingerprint } from "./conversation-source-cache.js";

export type ConversationRawSource = "auto" | "local" | "ls" | "cache";

export interface LocalPbCandidateDiagnostic {
    kind: LocalPbCandidateKind;
    status: "success" | "failed";
    message: string;
    stepCount?: number;
    errorCode?: LocalPbErrorCode | "UNKNOWN";
}

export interface LocalPbConversationResult {
    selected: LocalPbReadResult;
    rounds: ConversationRound[];
    totalSteps: number;
    fingerprint: ConversationSourceFingerprint;
    candidateKinds: Array<"active" | "implicit">;
    partial: boolean;
    diagnostics: LocalPbCandidateDiagnostic[];
}

interface LocalPbDiscoveredCandidate extends LocalPbFileCandidate {
    size: number;
    mtimeMs: number;
}

function safeConversationFileName(conversationId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(conversationId)) throw new Error("conversationId cannot be mapped to a safe PB filename");
    return `${conversationId}.pb`;
}

function hostRoots(host: LocalPbSourceFlavor): Array<{ kind: "active" | "implicit"; root: string }> {
    const home = os.homedir();
    if (host === "windsurf") {
        return [
            { kind: "active", root: process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT || path.join(home, ".codeium", "windsurf", "cascade") },
            { kind: "implicit", root: process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT || path.join(home, ".codeium", "windsurf", "implicit") },
        ];
    }
    return [
        { kind: "active", root: process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT || path.join(home, ".gemini", "antigravity", "conversations") },
        { kind: "implicit", root: process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT || path.join(home, ".gemini", "antigravity", "implicit") },
    ];
}

function resolveContainedCandidate(root: string, fileName: string, kind: "active" | "implicit"): LocalPbDiscoveredCandidate | null {
    if (!fs.existsSync(root)) return null;
    const realRoot = fs.realpathSync(root);
    const candidatePath = path.join(realRoot, fileName);
    if (!fs.existsSync(candidatePath)) return null;
    const realCandidate = fs.realpathSync(candidatePath);
    const relative = path.relative(realRoot, realCandidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("local PB candidate escaped its configured root");
    const stat = fs.lstatSync(realCandidate);
    if (!stat.isFile()) return null;
    const maxBytes = readFiniteIntegerEnv("MEMORY_STORE_LOCAL_PB_MAX_ENCRYPTED_BYTES", 96 * 1024 * 1024);
    if (stat.size > maxBytes) throw new Error(`local PB candidate exceeds encrypted byte limit ${maxBytes}`);
    return { kind, filePath: realCandidate, label: kind, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function discoverLocalPbCandidates(host: LocalPbSourceFlavor, conversationId: string): LocalPbDiscoveredCandidate[] {
    const fileName = safeConversationFileName(conversationId);
    return hostRoots(host)
        .map(({ kind, root }) => resolveContainedCandidate(root, fileName, kind))
        .filter((candidate): candidate is LocalPbDiscoveredCandidate => Boolean(candidate));
}

export function fingerprintLocalPbCandidates(candidates: LocalPbDiscoveredCandidate[]): ConversationSourceFingerprint {
    const revision = createHash("sha256")
        .update(JSON.stringify(candidates.map(candidate => ({ kind: candidate.kind, size: candidate.size, mtimeMs: candidate.mtimeMs }))))
        .digest("hex");
    return {
        size: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
        mtime: candidates.reduce((latest, candidate) => Math.max(latest, candidate.mtimeMs), 0),
        revision,
    };
}

function canonicalLocalPbStep(step: LocalPbStep): string {
    return JSON.stringify({
        timestamp: step.timestamp,
        contextTokens: step.contextTokens,
        user: step.user,
        planner: step.planner,
        system: step.system,
        toolVariants: step.toolVariants,
        diagnostics: step.diagnostics,
    });
}

function selectCompleteLocalPbResult(results: LocalPbReadResult[]): LocalPbReadResult {
    if (results.length === 0) throw new Error("no readable local PB candidate");
    if (results.length === 1) return results[0];
    const sorted = [...results].sort((left, right) => right.trajectory.steps.length - left.trajectory.steps.length);
    const longer = sorted[0];
    const shorter = sorted[1];
    if (longer.trajectory.id && shorter.trajectory.id && longer.trajectory.id !== shorter.trajectory.id) {
        throw new Error("active and implicit PB trajectory identities conflict");
    }
    const longerSteps = longer.trajectory.steps.map(canonicalLocalPbStep);
    const shorterSteps = shorter.trajectory.steps.map(canonicalLocalPbStep);
    const strictPrefix = shorterSteps.every((value, index) => value === longerSteps[index]);
    if (!strictPrefix) throw new Error("active and implicit PB contents conflict; refusing to merge incomparable histories");
    return longer;
}

function toolVariantText(step: LocalPbStep): string {
    return step.toolVariants.map(variant => JSON.stringify({
        variant: variant.variantName,
        fields: variant.rawSubfields,
    })).join("\n");
}

function estimateLocalPbBase64Bytes(base64: string): number {
    const clean = base64.replace(/\s+/gu, "");
    return Math.max(0, Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
}

function localPbImageMimeFromBase64(base64: string): string | null {
    const clean = base64.replace(/\s+/gu, "");
    if (clean.startsWith("iVBORw0KGgo")) return "image/png";
    if (clean.startsWith("/9j/")) return "image/jpeg";
    if (clean.startsWith("R0lGOD")) return "image/gif";
    if (clean.startsWith("UklGR")) return "image/webp";
    return null;
}

function localPbAttachmentExtension(mimeType: string): string {
    switch (mimeType) {
        case "image/jpeg": return ".jpg";
        case "image/gif": return ".gif";
        case "image/webp": return ".webp";
        case "image/png":
        default: return ".png";
    }
}

function projectLocalPbUserText(text: string, stepIndex: number): { text: string; attachments: ConversationAttachment[] } {
    const trimmed = text.trim();
    const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/isu.exec(trimmed);
    const encoded = dataUrlMatch ? dataUrlMatch[2] : trimmed;
    const compact = encoded.replace(/\s+/gu, "");
    const mimeType = dataUrlMatch?.[1]?.toLowerCase() || localPbImageMimeFromBase64(compact);
    if (!mimeType || compact.length < 512) return { text, attachments: [] };
    const sizeBytes = estimateLocalPbBase64Bytes(compact);
    const sha256 = createHash("sha256").update(compact, "utf8").digest("hex");
    const name = `local-pb-step-${stepIndex}-inline-image${localPbAttachmentExtension(mimeType)}`;
    const placeholder = `[WSF/Antigravity local PB inline image base64 omitted: ${mimeType}, ${sizeBytes} bytes, sha256=${sha256.slice(0, 12)}…]`;
    return {
        text: placeholder,
        attachments: [{
            kind: "image",
            source: "local-pb-inline-base64",
            name,
            mimeType,
            sizeBytes,
            sha256,
            stepIndex,
            warning: "Inline image base64 was omitted from conversation text to avoid context pollution",
        }],
    };
}

export function localPbResultToRounds(result: LocalPbReadResult): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let current: ConversationRound | null = null;
    const pushCurrent = () => {
        if (!current) return;
        rounds.push(current);
        current = null;
    };
    const ensureCurrent = (stepIndex: number): ConversationRound => {
        if (current) return current;
        current = {
            roundIndex: rounds.length + 1,
            startStep: stepIndex,
            endStep: stepIndex,
            userMessage: "(无显式用户消息)",
            mediaAttachments: [],
            attachments: [],
            aiResponses: [],
            toolCalls: [],
            taskBoundaries: [],
            codeActions: [],
            subagentSummaries: [],
            userMessages: [],
            legacyRoundIndices: [rounds.length + 1],
            semanticEvents: [],
        };
        return current;
    };
    for (const step of result.trajectory.steps) {
        const stepIndex = step.index;
        if (step.user) {
            const activeRound = current as ConversationRound | null;
            const hasModelActivity = Boolean(activeRound && (activeRound.aiResponses.length || activeRound.toolCalls.length || activeRound.semanticEvents?.some(event => event.semanticRole !== "user")));
            if (hasModelActivity) pushCurrent();
            const round = ensureCurrent(stepIndex);
            const projectedUser = projectLocalPbUserText(step.user, stepIndex);
            const message = { stepIndex, text: projectedUser.text, rawRole: "local_pb.field_19", semanticRole: "user" as const, mediaAttachments: [], attachments: projectedUser.attachments };
            if (projectedUser.attachments.length) {
                round.attachments = [...(round.attachments || []), ...projectedUser.attachments];
            }
            round.userMessages = [...(round.userMessages || []), message];
            round.userMessage = round.userMessages.map(item => item.text).join("\n\n");
            round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_19", semanticRole: "user", kind: "message", text: projectedUser.text, attachments: projectedUser.attachments });
            round.endStep = stepIndex;
        }
        const round = ensureCurrent(stepIndex);
        if (step.contextTokens !== undefined) {
            round.semanticEvents?.push({
                stepIndex,
                rawRole: "local_pb.field_25",
                semanticRole: "system",
                kind: "context_tokens",
                contextTokens: step.contextTokens,
            });
        }
        if (step.system) round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_114", semanticRole: "system", kind: "system", text: step.system });
        if (step.timestamp?.iso) round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.timestamp", semanticRole: "system", kind: "timestamp", text: step.timestamp.iso });
        if (step.planner) {
            const projected = projectLocalPbPlanner(step.planner);
            round.aiResponses.push({ stepIndex, response: projected.response, thinking: projected.thinking, toolCalls: [] });
            if (projected.draftResponse) {
                round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_20", semanticRole: "model", kind: "draft_response", text: projected.draftResponse });
            }
            if (projected.thinking) {
                round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_20", semanticRole: "model", kind: "thinking", text: projected.thinking });
            }
            round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_20", semanticRole: "model", kind: "response", text: projected.response });
        }
        if (step.toolVariants.length) {
            for (const variant of step.toolVariants) {
                round.semanticEvents?.push({
                    stepIndex,
                    rawRole: variant.variantName,
                    semanticRole: "system",
                    kind: "pb_wire_variant",
                    name: variant.variantName,
                    resultSummary: toolVariantText(step),
                    text: "wire-level PB variant retained without cross-host semantic guessing",
                });
            }
        }
        round.endStep = stepIndex;
    }
    pushCurrent();
    return mergeConsecutiveHumanRounds(rounds);
}

function projectLocalPbPlanner(planner: LocalPbPlannerResponse): {
    response: string;
    thinking: string;
    draftResponse?: string;
} {
    const response = planner.response || "";
    const thinking = planner.thinking || "";
    const modified = planner.modifiedResponse || "";
    const responseLooksLikeThinking = Boolean(response && looksLikeLocalPbReasoningOnly(response));
    const modifiedLooksLikeThinking = Boolean(modified && looksLikeLocalPbReasoningOnly(modified));
    const visibleResponse = response && !responseLooksLikeThinking
        ? response
        : (modified && !modifiedLooksLikeThinking ? modified : "");
    const thinkingParts = [thinking]
        .concat(response && response !== visibleResponse && responseLooksLikeThinking ? [response] : [])
        .concat(modified && modified !== visibleResponse && (modifiedLooksLikeThinking || !thinking) ? [modified] : [])
        .filter(Boolean);
    const uniqueThinking = [...new Set(thinkingParts)];
    return {
        response: visibleResponse,
        thinking: uniqueThinking.join("\n\n"),
        ...(response && modified && visibleResponse && response !== visibleResponse ? { draftResponse: response } : {}),
    };
}

function looksLikeLocalPbReasoningOnly(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    const reasoningPrefixes = [
        "The user",
        "User",
        "I need",
        "I should",
        "Let me",
        "Now I",
        "We need",
        "用户想",
        "用户要求",
        "用户问",
        "用户让我",
        "让我",
        "我需要",
        "我先",
        "我来",
        "我应该",
    ];
    return reasoningPrefixes.some(prefix => normalized.startsWith(prefix));
}

function localPbCandidateFailure(candidate: LocalPbDiscoveredCandidate, error: unknown): LocalPbCandidateDiagnostic {
    return {
        kind: candidate.kind,
        status: "failed",
        errorCode: error instanceof LocalPbReaderError ? error.code : "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
    };
}

export function loadLocalPbConversation(host: LocalPbSourceFlavor, conversationId: string): LocalPbConversationResult | null {
    const candidates = discoverLocalPbCandidates(host, conversationId);
    if (candidates.length === 0) return null;
    const successfulCandidates: Array<{ candidate: LocalPbDiscoveredCandidate; result: LocalPbReadResult }> = [];
    const diagnostics: LocalPbCandidateDiagnostic[] = [];
    for (const candidate of candidates) {
        try {
            const result = readLocalPbFileCandidate(candidate, { sourceFlavor: host });
            successfulCandidates.push({ candidate, result });
            diagnostics.push({
                kind: candidate.kind,
                status: "success",
                message: "Local PB candidate decoded",
                stepCount: result.trajectory.steps.length,
            });
        } catch (error) {
            diagnostics.push(localPbCandidateFailure(candidate, error));
        }
    }
    if (successfulCandidates.length === 0) {
        const errors = diagnostics
            .filter((diagnostic): diagnostic is LocalPbCandidateDiagnostic & { status: "failed"; errorCode: LocalPbErrorCode | "UNKNOWN" } => diagnostic.status === "failed")
            .map(diagnostic => `${diagnostic.kind} (${diagnostic.errorCode}): ${diagnostic.message}`);
        throw new Error(`local PB candidates could not be decoded: ${errors.join("; ")}`);
    }
    const selected = selectCompleteLocalPbResult(successfulCandidates.map(candidate => candidate.result));
    const rounds = localPbResultToRounds(selected);
    return {
        selected,
        rounds,
        totalSteps: selected.trajectory.steps.length,
        fingerprint: fingerprintLocalPbCandidates(candidates),
        candidateKinds: successfulCandidates.map(candidate => candidate.candidate.kind),
        partial: diagnostics.some(diagnostic => diagnostic.status === "failed"),
        diagnostics,
    };
}

type ConversationCompletenessRelation = "equal" | "local_contains_live" | "live_contains_local" | "conflict";

function canonicalRound(round: ConversationRound): { userMessages: string[]; modelMessages: string[]; hasAttachments: boolean } {
    return {
        userMessages: (round.userMessages?.length ? round.userMessages.map(message => message.text) : [round.userMessage])
            .map(canonicalComparableText)
            .filter(Boolean),
        modelMessages: round.aiResponses
            .map(response => [response.response, response.thinking]
                .map(canonicalComparableText)
                .filter(Boolean)
                .join(" "))
            .filter(Boolean),
        hasAttachments: Boolean(
            round.attachments?.length
            || round.mediaAttachments?.length
            || round.userMessages?.some(message => message.attachments?.length || message.mediaAttachments?.length),
        ),
    };
}

function canonicalComparableText(text: string): string {
    const trimmed = text.trim();
    if (/^\[WSF\/Antigravity local PB inline image base64 omitted:[^\]\n]+\]$/u.test(trimmed)) {
        return "";
    }
    return trimmed
        .replace(/\[([^\]\n]+)\]\(cci:[^)]+\)/gu, "$1")
        .replace(/`([^`\n]+)`/gu, "$1")
        .replace(/@([a-zA-Z]:[\\/][^\s，。；、)）\]]+)/gu, "$1")
        .replace(/[\\/]+/gu, "/")
        .replace(/\s+/gu, " ")
        .trim();
}

export function compareConversationRoundCompleteness(
    localRounds: ConversationRound[],
    liveRounds: ConversationRound[],
): ConversationCompletenessRelation {
    const local = localRounds.map(canonicalRound);
    const live = liveRounds.map(canonicalRound);
    let relation: ConversationCompletenessRelation = "equal";
    for (let index = 0; index < Math.min(local.length, live.length); index += 1) {
        const roundRelation = compareCanonicalRounds(local[index], live[index]);
        relation = mergeCompletenessRelation(relation, roundRelation);
        if (relation === "conflict") return "conflict";
    }
    if (local.length > live.length) return mergeCompletenessRelation(relation, "local_contains_live");
    if (live.length > local.length) return mergeCompletenessRelation(relation, "live_contains_local");
    return relation;
}

function compareCanonicalRounds(
    local: { userMessages: string[]; modelMessages: string[]; hasAttachments: boolean },
    live: { userMessages: string[]; modelMessages: string[]; hasAttachments: boolean },
): ConversationCompletenessRelation {
    if (!equivalentUserMessages(local, live)) return "conflict";
    if (sameSequence(local.modelMessages, live.modelMessages)) return "equal";
    if (isMessageSubsequence(local.modelMessages, live.modelMessages)) return "live_contains_local";
    if (isMessageSubsequence(live.modelMessages, local.modelMessages)) return "local_contains_live";
    const localModelText = local.modelMessages.join(" ");
    const liveModelText = live.modelMessages.join(" ");
    if (localModelText === liveModelText) return "equal";
    if (!localModelText && liveModelText) return "live_contains_local";
    if (!liveModelText && localModelText) return "local_contains_live";
    if (liveModelText.includes(localModelText)) return "live_contains_local";
    if (localModelText.includes(liveModelText)) return "local_contains_live";
    return "conflict";
}

function sameSequence(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equivalentUserMessages(
    local: { userMessages: string[]; hasAttachments: boolean },
    live: { userMessages: string[]; hasAttachments: boolean },
): boolean {
    if (sameSequence(local.userMessages, live.userMessages)) return true;
    if (isAttachmentSentinelOnly(local.userMessages) && live.userMessages.length === 0 && live.hasAttachments) return true;
    if (isAttachmentSentinelOnly(live.userMessages) && local.userMessages.length === 0 && local.hasAttachments) return true;
    return false;
}

function isAttachmentSentinelOnly(messages: string[]): boolean {
    return messages.length === 1 && messages[0] === "markdown";
}

function isMessageSubsequence(shorter: string[], longer: string[]): boolean {
    if (shorter.length === 0) return true;
    let cursor = 0;
    for (const value of shorter) {
        while (cursor < longer.length && longer[cursor] !== value && !longer[cursor].includes(value)) {
            cursor += 1;
        }
        if (cursor >= longer.length) return false;
        cursor += 1;
    }
    return true;
}

function mergeCompletenessRelation(
    current: ConversationCompletenessRelation,
    next: ConversationCompletenessRelation,
): ConversationCompletenessRelation {
    if (current === "conflict" || next === "conflict") return "conflict";
    if (current === "equal") return next;
    if (next === "equal" || current === next) return current;
    return "conflict";
}
