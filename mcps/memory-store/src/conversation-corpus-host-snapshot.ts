import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT } from "./store.js";
import { readHostCache, writeHostCache } from "./conversation-host-files.js";
import { readHostSnapshotRound, writeHostSnapshotRound, type HostSnapshotRound } from "./conversation-corpus-host-snapshot-rounds.js";
import { projectCodexCorpusRound } from "./conversation-corpus-reader-projection.js";
import type { CorpusConversation, CorpusMessageRole, CorpusProjection, CorpusReadControl, CorpusRoundReadRequest } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";

interface SnapshotOptions { cacheRoot?: string; cacheMaxBytes?: number; canonicalRounds?: boolean }
interface StoredSnapshot {
    format: "host-corpus-snapshot/v1";
    capturedAt: string;
    messageRoles: CorpusMessageRole[];
    roundIndices: number[];
    projection: CorpusProjection;
}

interface StoredCanonicalSnapshot {
    format: "host-corpus-snapshot/v2";
    capturedAt: string;
    canonicalRoundRoles: CorpusMessageRole[];
    roundIndices: number[];
    projection: Omit<CorpusProjection, "messages" | "rounds">;
    rounds: HostSnapshotRound[];
}

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_REVISION_SNAPSHOTS = 32;
const MAX_CANONICAL_BYTES = MAX_SNAPSHOT_BYTES * MAX_REVISION_SNAPSHOTS;
const ALL_ROLES: CorpusMessageRole[] = ["user", "assistant", "tool", "subagent"];
const CACHE_NAME = /^[a-f0-9]{64}(?:\.rounds)?\.json$/u;

function key(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function active(control: CorpusReadControl): boolean {
    return !control.isCancelled?.() && (control.deadlineAt === undefined || Date.now() < control.deadlineAt);
}

function maximumBytes(options: SnapshotOptions): number {
    return options.cacheMaxBytes === undefined ? MAX_SNAPSHOT_BYTES
        : Number.isSafeInteger(options.cacheMaxBytes) && options.cacheMaxBytes > 0
            ? Math.min(MAX_SNAPSHOT_BYTES, options.cacheMaxBytes) : 0;
}

function roles(values: CorpusMessageRole[] | undefined): CorpusMessageRole[] {
    return [...new Set<CorpusMessageRole>(values ?? ["user", "assistant"])].sort();
}

function roundIndices(projection: CorpusProjection): number[] {
    if (!Array.isArray(projection.rounds)) return [];
    return [...new Set(projection.rounds.map(round => round.roundIndex))]
        .filter(index => Number.isSafeInteger(index) && index > 0).sort((left, right) => left - right);
}

function directory(conversation: CorpusConversation, revision: string, options: SnapshotOptions): string {
    return path.join(options.cacheRoot ?? DATA_ROOT, "corpus-range-snapshots", key(conversation.source),
        key(conversation.canonicalId || conversation.id), key(revision));
}

function matches(snapshot: StoredSnapshot, conversation: CorpusConversation, revision: string): boolean {
    const origin = snapshot?.projection?.conversation;
    return snapshot?.format === "host-corpus-snapshot/v1" && typeof snapshot.capturedAt === "string"
        && Number.isFinite(Date.parse(snapshot.capturedAt)) && origin?.source === conversation.source
        && (origin.canonicalId || origin.id) === (conversation.canonicalId || conversation.id)
        && snapshot.projection.revision === revision && Array.isArray(snapshot.messageRoles)
        && snapshot.messageRoles.every(role => ALL_ROLES.includes(role))
        && Array.isArray(snapshot.projection.messages) && Array.isArray(snapshot.projection.rounds)
        && JSON.stringify(roundIndices(snapshot.projection)) === JSON.stringify(snapshot.roundIndices);
}

function selectedRange(projection: Pick<CorpusProjection, "roundNumbering" | "totalRounds">, request: CorpusRoundReadRequest): { start: number; end: number } | null {
    const valid = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! > 0;
    if (request.lastRounds !== undefined) {
        if (!valid(request.lastRounds) || request.startRound !== undefined || request.endRound !== undefined
            || projection.roundNumbering === "relative" || !valid(projection.totalRounds)) return null;
        return { start: Math.max(1, projection.totalRounds - request.lastRounds + 1), end: projection.totalRounds };
    }
    const end = request.endRound ?? projection.totalRounds;
    if (!valid(request.startRound) || !valid(end) || end < request.startRound) return null;
    return { start: request.startRound, end };
}

function canonicalRound(round: ConversationRound): boolean {
    return typeof round?.userMessage === "string" && Array.isArray(round.aiResponses)
        && Array.isArray(round.toolCalls) && Array.isArray(round.taskBoundaries)
        && Array.isArray(round.codeActions) && Array.isArray(round.subagentSummaries);
}

function projectSnapshot(original: Omit<CorpusProjection, "messages" | "rounds">, rounds: ConversationRound[],
    conversation: CorpusConversation, request: CorpusRoundReadRequest, requested: CorpusMessageRole[],
    capturedAt: string, allRoundCount: number, started: number, readBytes: number): CorpusProjection | null {
    const range = selectedRange(original, request);
    if (!range || rounds.length !== range.end - range.start + 1
        || !rounds.every((round, index) => canonicalRound(round) && round.roundIndex === range.start + index)) return null;
    const origin = { ...original.conversation, ...conversation };
    const origins = origin.rolloutPath ? new Map([[origin.rolloutPath, { sourceThreadId: origin.canonicalId || origin.id, isChildThread: Boolean(origin.isChildThread) }]]) : undefined;
    const messages = rounds.flatMap(round => projectCodexCorpusRound(`${origin.source}:${origin.canonicalId || origin.id}`,
        { ...round, semanticEvents: round.semanticEvents?.map(event => event.semanticRole === "assistant" ? { ...event, semanticRole: "model" as const } : event) },
        new Map(), requested, origin.rolloutPath, origins).map(message => ({ ...message, sourceThreadId: origin.canonicalId || origin.id })));
    const result = {
        ...original, conversation: origin, messages, rounds: rounds.map(round => selectRound(round, requested, origin.isChildThread)),
        complete: original.complete && rounds.length === allRoundCount,
        sourceRevalidatedThisCall: false as const, snapshotCapturedAt: capturedAt, snapshotSourceRevision: original.revision,
        timings: { totalMs: performance.now() - started, snapshotReadMs: performance.now() - started,
            snapshotReadBytes: readBytes, snapshotVerifiedBytes: readBytes, knownSourceReadBytes: 0, verificationBytes: 0,
            parsedBytes: readBytes, cacheHit: 1 },
    };
    return result;
}

async function readCanonicalSnapshot(snapshot: StoredCanonicalSnapshot, folder: string, conversation: CorpusConversation,
    request: CorpusRoundReadRequest, requested: CorpusMessageRole[], maximum: number, control: CorpusReadControl,
    started: number): Promise<CorpusProjection | null> {
    const origin = snapshot?.projection?.conversation;
    if (snapshot?.format !== "host-corpus-snapshot/v2" || !optionsCanonicalRoles(snapshot.canonicalRoundRoles)
        || !Number.isFinite(Date.parse(snapshot.capturedAt)) || origin?.source !== conversation.source
        || (origin.canonicalId || origin.id) !== (conversation.canonicalId || conversation.id)
        || snapshot.projection.revision !== request.revision || !Array.isArray(snapshot.rounds)
        || !Array.isArray(snapshot.roundIndices) || snapshot.rounds.length !== snapshot.roundIndices.length
        || !snapshot.rounds.every((round, index) => round.roundIndex === snapshot.roundIndices[index]
            && Number.isSafeInteger(round.roundIndex) && round.roundIndex > 0
            && (index === 0 || round.roundIndex > snapshot.rounds[index - 1].roundIndex))) return null;
    const range = selectedRange(snapshot.projection, request);
    if (!range) return null;
    const selected = snapshot.rounds.filter(round => round.roundIndex >= range.start && round.roundIndex <= range.end);
    if (selected.length !== range.end - range.start + 1
        || !selected.every((round, index) => round.roundIndex === range.start + index
            && Number.isSafeInteger(round.bytes) && round.bytes > 0)
        || selected.reduce((total, round) => total + round.bytes, 0) > MAX_CANONICAL_BYTES) return null;
    const rounds: ConversationRound[] = [];
    let readBytes = 0;
    for (const stored of selected) {
        if (!active(control)) return null;
        const round = await readHostSnapshotRound(folder, stored, maximum, control);
        if (!round || !canonicalRound(round)) return null;
        rounds.push(round);
        readBytes += stored.bytes;
    }
    return projectSnapshot(snapshot.projection, rounds, conversation, request, requested, snapshot.capturedAt,
        snapshot.rounds.length, started, readBytes);
}

function optionsCanonicalRoles(values: CorpusMessageRole[]): boolean {
    return Array.isArray(values) && values.length === ALL_ROLES.length && ALL_ROLES.every(role => values.includes(role));
}

function selectRound(round: ConversationRound, requested: CorpusMessageRole[], subagentSource = false): ConversationRound {
    if (ALL_ROLES.every(role => requested.includes(role))) return round;
    const user = subagentSource ? requested.includes("subagent") : requested.includes("user");
    const assistant = subagentSource ? requested.includes("subagent") : requested.includes("assistant");
    const tool = requested.includes("tool");
    return {
        ...round, roundIndex: round.roundIndex, startStep: round.startStep, endStep: round.endStep, createdAt: round.createdAt,
        legacyRoundIndices: round.legacyRoundIndices,
        userMessage: user ? round.userMessage : "", userMessages: user ? round.userMessages : undefined,
        mediaAttachments: user ? round.mediaAttachments : [], attachments: user ? round.attachments : undefined,
        aiResponses: assistant ? round.aiResponses : [], toolCalls: tool ? round.toolCalls : [],
        taskBoundaries: tool ? round.taskBoundaries : [], codeActions: tool ? round.codeActions : [],
        fileViews: tool ? round.fileViews : undefined,
        compactionSummaries: assistant ? round.compactionSummaries : undefined,
        subagentSummaries: requested.includes("subagent") ? round.subagentSummaries : [],
        semanticEvents: round.semanticEvents?.filter(event => {
            const role = event.semanticRole === "model" ? "assistant" : event.semanticRole;
            return requested.includes(subagentSource && ["user", "assistant"].includes(role) ? "subagent" : role as CorpusMessageRole);
        }),
    };
}

export function selectHostCorpusProjectionRoles(projection: CorpusProjection, messageRoles?: CorpusMessageRole[]): CorpusProjection {
    const requested = roles(messageRoles);
    return {
        ...projection,
        messages: projection.messages.filter(message => requested.includes(message.role)),
        rounds: projection.rounds?.map(round => selectRound(round, requested, projection.conversation.isChildThread)),
    };
}

export async function rememberHostCorpusProjection(projection: CorpusProjection, control: CorpusReadControl,
    options: SnapshotOptions = {}): Promise<void> {
    let lock: string | undefined;
    try {
        const maximum = maximumBytes(options);
        if (!maximum || !active(control) || !projection.revision || /^pending(?:$|:)/u.test(projection.revision)) return;
        const indices = roundIndices(projection);
        const capturedRoles = roles(control.messageRoles);
        if (!indices.length || capturedRoles.some(role => !ALL_ROLES.includes(role))) return;
        const folder = directory(projection.conversation, projection.revision, options);
        await fs.mkdir(folder, { recursive: true });
        const candidateLock = path.join(folder, "write-lock");
        try { await fs.mkdir(candidateLock); lock = candidateLock; } catch { return; }
        const canonical = options.canonicalRounds === true && projection.rounds!.every(canonicalRound);
        const filename = path.join(folder, `${key([canonical ? "canonical-rounds/v2" : "messages/v1", projection.roundNumbering ?? "absolute", indices, canonical ? ALL_ROLES : capturedRoles, canonical ? maximum : undefined])}${canonical ? ".rounds" : ""}.json`);
        const existing = await fs.readdir(folder);
        if (existing.includes(path.basename(filename)) || existing.filter(name => CACHE_NAME.test(name)).length >= MAX_REVISION_SNAPSHOTS) return;
        if (!active(control)) return;
        if (canonical) {
            const rounds: HostSnapshotRound[] = [];
            let bytes = 0;
            for (const round of projection.rounds!) {
                if (!active(control)) return;
                const stored = await writeHostSnapshotRound(folder, round, maximum, control);
                if (!stored) return;
                bytes += stored.bytes;
                if (bytes > MAX_CANONICAL_BYTES) return;
                rounds.push(stored);
            }
            const { messages: _messages, rounds: _rounds, ...metadata } = projection;
            const snapshot: StoredCanonicalSnapshot = { format: "host-corpus-snapshot/v2", capturedAt: new Date().toISOString(),
                canonicalRoundRoles: [...ALL_ROLES], roundIndices: indices, projection: metadata, rounds };
            await writeHostCache(filename, snapshot, maximum, () => !active(control));
        } else {
            const snapshot: StoredSnapshot = { format: "host-corpus-snapshot/v1", capturedAt: new Date().toISOString(),
                messageRoles: capturedRoles, roundIndices: indices, projection };
            await writeHostCache(filename, snapshot, maximum, () => !active(control));
        }
    } catch {
        return;
    } finally {
        if (lock) await fs.rmdir(lock).catch(() => undefined);
    }
}

export async function readHostCorpusSnapshot(conversation: CorpusConversation, request: CorpusRoundReadRequest,
    control: CorpusReadControl, options: SnapshotOptions = {}): Promise<CorpusProjection | null> {
    const started = performance.now();
    try {
        const maximum = maximumBytes(options);
        if (!maximum || !active(control) || !request.revision) return null;
        const requested = roles(request.messageRoles ?? control.messageRoles);
        if (requested.some(role => !ALL_ROLES.includes(role))) return null;
        const folder = directory(conversation, request.revision, options);
        const filenames = (await fs.readdir(folder)).filter(name => CACHE_NAME.test(name))
            .sort((left, right) => Number(right.endsWith(".rounds.json")) - Number(left.endsWith(".rounds.json")) || left.localeCompare(right))
            .slice(0, MAX_REVISION_SNAPSHOTS);
        for (const filename of filenames) {
            if (!active(control)) return null;
            const snapshot = await readHostCache<StoredSnapshot | StoredCanonicalSnapshot>(path.join(folder, filename), maximum);
            if (snapshot?.format === "host-corpus-snapshot/v2") {
                const projected = await readCanonicalSnapshot(snapshot, folder, conversation, request, requested, maximum, control, started);
                if (projected && active(control)) return projected;
                continue;
            }
            if (!snapshot || !matches(snapshot, conversation, request.revision)) continue;
            const canonical = options.canonicalRounds === true && snapshot.projection.rounds!.every(canonicalRound);
            if (!canonical && requested.some(role => !snapshot.messageRoles.includes(role))) continue;
            const range = selectedRange(snapshot.projection, request);
            if (!range || range.end - range.start + 1 > snapshot.roundIndices.length) continue;
            const available = new Set(snapshot.roundIndices);
            let covered = true;
            for (let index = range.start; index <= range.end; index++) {
                if (!available.has(index)) { covered = false; break; }
            }
            if (!covered) continue;
            const original = snapshot.projection;
            if (canonical) {
                const selected = original.rounds!.filter(round => round.roundIndex >= range.start && round.roundIndex <= range.end);
                const projected = projectSnapshot(original, selected, conversation, request, requested, snapshot.capturedAt,
                    snapshot.roundIndices.length, started, (await fs.stat(path.join(folder, filename))).size);
                if (projected && active(control)) return projected;
                continue;
            }
            const result: CorpusProjection & { sourceRevalidatedThisCall: false; snapshotCapturedAt: string; snapshotSourceRevision: string } = {
                ...original,
                complete: original.complete && range.end - range.start + 1 === snapshot.roundIndices.length,
                messages: original.messages.filter(message => message.round >= range.start && message.round <= range.end && requested.includes(message.role)),
                rounds: original.rounds!.filter(round => round.roundIndex >= range.start && round.roundIndex <= range.end).map(round => selectRound(round, requested, conversation.isChildThread || original.conversation.isChildThread)),
                sourceRevalidatedThisCall: false, snapshotCapturedAt: snapshot.capturedAt, snapshotSourceRevision: original.revision,
            };
            if (!active(control)) return null;
            return result;
        }
    } catch {
        return null;
    }
    return null;
}
