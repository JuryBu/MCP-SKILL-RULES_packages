import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    LocalPbReaderError,
    readLocalPbFileCandidate,
    type LocalPbCandidateKind,
    type LocalPbErrorCode,
    type LocalPbFileCandidate,
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
            const message = { stepIndex, text: step.user, rawRole: "local_pb.field_19", semanticRole: "user" as const, mediaAttachments: [] };
            round.userMessages = [...(round.userMessages || []), message];
            round.userMessage = round.userMessages.map(item => item.text).join("\n\n");
            round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_19", semanticRole: "user", kind: "message", text: step.user });
            round.endStep = stepIndex;
        }
        const round = ensureCurrent(stepIndex);
        if (step.system) round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_114", semanticRole: "system", kind: "system", text: step.system });
        if (step.timestamp?.iso) round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.timestamp", semanticRole: "system", kind: "timestamp", text: step.timestamp.iso });
        if (step.planner) {
            const response = step.planner.modifiedResponse || step.planner.response || "";
            round.aiResponses.push({ stepIndex, response, thinking: step.planner.thinking || "", toolCalls: [] });
            if (step.planner.response && step.planner.modifiedResponse && step.planner.response !== step.planner.modifiedResponse) {
                round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_20", semanticRole: "model", kind: "draft_response", text: step.planner.response });
            }
            round.semanticEvents?.push({ stepIndex, rawRole: "local_pb.field_20", semanticRole: "model", kind: "response", text: response });
        }
        if (step.toolVariants.length) {
            for (const variant of step.toolVariants) {
                round.toolCalls.push({
                    stepIndex,
                    name: `local_pb.${variant.variantName}`,
                    argsSummary: JSON.stringify(variant.rawSubfields).slice(0, 120),
                    resultSummary: "wire-level PB variant retained without cross-host semantic guessing",
                });
                round.semanticEvents?.push({ stepIndex, rawRole: variant.variantName, semanticRole: "tool", kind: "tool", name: variant.variantName, resultSummary: toolVariantText(step) });
            }
        }
        round.endStep = stepIndex;
    }
    pushCurrent();
    return mergeConsecutiveHumanRounds(rounds);
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

function canonicalRound(round: ConversationRound): string {
    return JSON.stringify({
        userMessages: (round.userMessages?.length ? round.userMessages.map(message => message.text) : [round.userMessage])
            .map(text => text.trim())
            .filter(Boolean),
        modelResponses: round.aiResponses
            .map(response => ({ response: response.response.trim(), thinking: response.thinking.trim() }))
            .filter(response => response.response || response.thinking),
    });
}

export function compareConversationRoundCompleteness(
    localRounds: ConversationRound[],
    liveRounds: ConversationRound[],
): "equal" | "local_contains_live" | "live_contains_local" | "conflict" {
    const local = localRounds.map(canonicalRound);
    const live = liveRounds.map(canonicalRound);
    const prefix = (shorter: string[], longer: string[]) => shorter.every((value, index) => value === longer[index]);
    if (local.length === live.length && prefix(local, live)) return "equal";
    if (live.length < local.length && prefix(live, local)) return "local_contains_live";
    if (local.length < live.length && prefix(local, live)) return "live_contains_local";
    return "conflict";
}
