import fs from "node:fs";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { streamCodexHistoryArchive, type CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import { codexHistoryPhysicalIdentity, readCodexStreamingSessionMeta, resolveCodexStreamingHistorySource, type CodexStreamingHistorySource, type CodexStreamingHistorySegment, type CodexStreamingHistoryPosition } from "./codex-history-source.js";
import { createCodexCorpusCollector, codexCorpusThreadOrigin, type CodexCorpusThreadOrigin } from "./conversation-corpus-reader-projection.js";
import type { CorpusMessage, CorpusMessageRole } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";

export type CodexHistoryWindowRound = ConversationRound;
export interface CodexHistoryWindowRow { round: number; canonical: ConversationRound; messages: CorpusMessage[] }
export interface CodexHistoryWindowProgress { phase: "reading" | "ready" | "complete"; bytesRead: number; recordsRead: number; segmentsRead: number; roundsReady: number }
export interface CodexHistoryWindowRange {
    source: { conversationId: string; host: "codex"; revision: string; snapshot: CodexStreamingHistorySource };
    rangeId: string;
    publication: "replace" | "append";
    deduplicateBy: "message.id";
    direction: "latest" | "oldest";
    rounds: CodexHistoryWindowRound[];
    rows: CodexHistoryWindowRow[];
    messages: CorpusMessage[];
    anchor: { first?: CodexStreamingHistoryPosition; last?: CodexStreamingHistoryPosition };
    coverage: { kind: "chunk-local"; startRound: number; endRound: number; requestedRounds: number; requestedRangeComplete: boolean; historyStartReached: boolean; snapshotEndReached: boolean; openAtSnapshot: boolean };
    canonicalSha256: string;
    progress: CodexHistoryWindowProgress;
}
export interface CodexHistoryWindowOptions {
    conversationId: string;
    sourcePath?: string;
    source?: CodexStreamingHistorySource;
    roots?: string[];
    pathsByRolloutId?: Map<string, string[]>;
    cwd?: string;
    direction?: "latest" | "oldest";
    maxRounds?: number;
    rangeRounds?: number;
    continueHistory?: boolean;
    messageRoles?: CorpusMessageRole[];
    archive?: CodexHistoryArchiveOptions;
    maxRecordBytes?: number;
    maxReadBytes?: number;
    isCancelled?: () => boolean;
    onRange?: (range: CodexHistoryWindowRange) => void | Promise<void>;
    onProgress?: (progress: CodexHistoryWindowProgress) => void | Promise<void>;
}

interface WindowEntry { event: any; position: CodexStreamingHistoryPosition }
interface RecordSlice { raw: Buffer; startByte: number; endByte: number; terminated: boolean }
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function canonicalJson(value: unknown): string {
    const order = (input: any): any => Array.isArray(input) ? input.map(order) : input && typeof input === "object" ? Object.fromEntries(Object.keys(input).sort().map(key => [key, order(input[key])])) : input;
    return JSON.stringify(order(JSON.parse(JSON.stringify(value))));
}

export function hashCodexHistoryWindowCanonical(messages: readonly CorpusMessage[]): string {
    return sha256(canonicalJson(messages));
}

function cancelled(options: CodexHistoryWindowOptions): void {
    if (options.isCancelled?.() || options.archive?.isCancelled?.()) throw new Error("Codex window read cancelled");
}

function assertSource(source: CodexStreamingHistorySource): void {
    for (const segment of source.segments) {
        const current = codexHistoryPhysicalIdentity(fs.statSync(segment.path));
        if (JSON.stringify(current) !== JSON.stringify(segment.physical)) throw new Error(`Codex window source changed: ${segment.path}`);
    }
}

function parse(record: RecordSlice): any {
    let text: string;
    try { text = utf8.decode(record.raw).replace(/^\uFEFF/u, ""); }
    catch (error) { throw new Error(`Invalid Codex window UTF-8 at byte ${record.startByte}`, { cause: error }); }
    try { return JSON.parse(text); }
    catch (error) { throw new Error(`Invalid Codex window JSON at byte ${record.startByte}`, { cause: error }); }
}

async function headerMetadata(segment: CodexStreamingHistorySegment, options: CodexHistoryWindowOptions): Promise<Record<string, unknown>> {
    if (/\.zst$/iu.test(segment.path)) return readCodexStreamingSessionMeta(segment.path, options.archive);
    const descriptor = fs.openSync(segment.path, "r");
    const pieces: Buffer[] = [];
    let length = 0;
    try {
        while (length < Math.min(segment.physical.size, 4 * 1024 ** 2)) {
            cancelled(options);
            const block = Buffer.allocUnsafe(Math.min(65536, segment.physical.size - length));
            const count = fs.readSync(descriptor, block, 0, block.length, length);
            if (!count) break;
            const newline = block.subarray(0, count).indexOf(10);
            const piece = block.subarray(0, newline < 0 ? count : newline);
            pieces.push(piece); length += piece.length;
            if (newline >= 0) {
                const raw = Buffer.concat(pieces, length);
                const event = parse({ raw, startByte: 0, endByte: length + 1, terminated: true });
                if (event.type !== "session_meta" || event.payload?.id !== options.conversationId || sha256(raw) !== segment.headerSha256 || event.ordinal !== undefined && event.ordinal !== segment.startOrdinal) throw new Error("Codex window header mismatch");
                return event.payload;
            }
        }
        throw new Error("Codex window has no complete bounded header");
    } finally { fs.closeSync(descriptor); }
}

function slim(event: any, roles: readonly CorpusMessageRole[]): any {
    if (roles.includes("tool")) return event;
    const payload = event.payload || {};
    if (event.type === "compacted") return { ...event, payload: { ...payload, replacement_history: undefined } };
    const responseActivity = event.type === "response_item" && ["reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(payload.type);
    const eventActivity = event.type === "event_msg" && ["agent_reasoning", "mcp_tool_call_end", "exec_command_end", "patch_apply_end", "token_count"].includes(payload.type);
    if (responseActivity || eventActivity) return { ...event, payload: { type: payload.type, ...(payload.changes && Object.keys(payload.changes).length ? { changes: { activity: {} } } : {}) } };
    return event;
}

function* reverseRecords(segment: CodexStreamingHistorySegment, progress: CodexHistoryWindowProgress, options: CodexHistoryWindowOptions): Generator<RecordSlice> {
    const descriptor = fs.openSync(segment.path, "r");
    let cursor = segment.endByte ?? segment.physical.size;
    let endByte = cursor;
    let terminated = false;
    let parts: Buffer[] = [];
    let length = 0;
    try {
        while (cursor > 0) {
            cancelled(options);
            const start = Math.max(0, cursor - 1024 * 1024);
            const block = Buffer.allocUnsafe(cursor - start);
            if (fs.readSync(descriptor, block, 0, block.length, start) !== block.length) throw new Error("Codex window short read");
            progress.bytesRead += block.length;
            if (progress.bytesRead > (options.maxReadBytes ?? 8 * 1024 ** 3)) throw new Error("Codex window read byte limit");
            let right = block.length;
            for (let index = block.length - 1; index >= 0; index -= 1) {
                if (block[index] !== 10) continue;
                const piece = block.subarray(index + 1, right);
                if (piece.length) { parts.push(Buffer.from(piece)); length += piece.length; }
                if (length > (options.maxRecordBytes ?? 256 * 1024 ** 2)) throw new Error("Codex window record byte limit");
                if (length) yield { raw: Buffer.concat(parts.reverse(), length), startByte: start + index + 1, endByte, terminated };
                parts = []; length = 0;
                endByte = start + index + 1;
                terminated = true;
                right = index;
            }
            if (right > 0) { parts.push(Buffer.from(block.subarray(0, right))); length += right; }
            if (length > (options.maxRecordBytes ?? 256 * 1024 ** 2)) throw new Error("Codex window record byte limit");
            cursor = start;
        }
        if (length) yield { raw: Buffer.concat(parts.reverse(), length), startByte: 0, endByte, terminated };
    } finally { fs.closeSync(descriptor); }
}

async function* forwardRecords(segment: CodexStreamingHistorySegment, progress: CodexHistoryWindowProgress, options: CodexHistoryWindowOptions): AsyncGenerator<RecordSlice> {
    const compressed = /\.zst$/iu.test(segment.path);
    let archiveComplete = false;
    const end = segment.endByte ?? segment.physical.size;
    const input = compressed ? streamCodexHistoryArchive(segment.path, { ...options.archive, isCancelled: () => Boolean(options.isCancelled?.() || options.archive?.isCancelled?.()), onComplete: () => { archiveComplete = true; } }) : fs.createReadStream(segment.path, { start: 0, end: Math.max(0, end - 1), highWaterMark: 1024 * 1024 });
    let parts: Buffer[] = [];
    let length = 0;
    let byte = 0;
    let consumed = 0;
    try {
        for await (const value of input) {
            cancelled(options);
            const block = value as Buffer;
            progress.bytesRead += block.length;
            if (progress.bytesRead > (options.maxReadBytes ?? 8 * 1024 ** 3)) throw new Error("Codex window read byte limit");
            const selected = segment.endByte === undefined ? block : block.subarray(0, Math.max(0, segment.endByte - consumed));
            consumed += block.length;
            let cursor = 0;
            for (let index = 0; index < selected.length; index += 1) {
                if (selected[index] !== 10) continue;
                const piece = selected.subarray(cursor, index);
                const raw = length ? Buffer.concat([...parts, piece], length + piece.length) : piece;
                if (raw.length > (options.maxRecordBytes ?? 256 * 1024 ** 2)) throw new Error("Codex window record byte limit");
                if (raw.length) yield { raw, startByte: byte, endByte: byte + raw.length + 1, terminated: true };
                byte += raw.length + 1;
                parts = []; length = 0; cursor = index + 1;
            }
            if (cursor < selected.length) { const piece = Buffer.from(selected.subarray(cursor)); parts.push(piece); length += piece.length; }
            if (length > (options.maxRecordBytes ?? 256 * 1024 ** 2)) throw new Error("Codex window record byte limit");
        }
        if (length) yield { raw: Buffer.concat(parts, length), startByte: byte, endByte: byte + length, terminated: false };
        if (compressed && !archiveComplete) throw new Error("Codex window archive verification missing");
        if (segment.endByte !== undefined && byte + length !== segment.endByte) throw new Error("Codex window adopted byte boundary mismatch");
    } finally { if (!compressed) (input as fs.ReadStream).destroy(); }
}

function project(entries: WindowEntry[], options: CodexHistoryWindowOptions, origins: Map<string, CodexCorpusThreadOrigin>): CodexHistoryWindowRow[] {
    const rounds: CodexHistoryWindowRow[] = [];
    const collector = createCodexCorpusCollector({ conversationId: options.conversationId, cwd: options.cwd, roles: options.messageRoles, originsByPath: origins, retainPositions: true, onCanonicalRound: (canonical, messages) => { rounds.push({ round: canonical.roundIndex, canonical, messages }); } });
    for (const entry of entries) collector.addEvent(entry.event, entry.position);
    collector.finish();
    return rounds;
}

export async function readCodexHistoryWindow(options: CodexHistoryWindowOptions): Promise<CodexHistoryWindowRange> {
    const maximum = options.maxRounds ?? 100;
    const batch = options.rangeRounds ?? 25;
    const direction = options.direction ?? "latest";
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(batch) || batch < 1) throw new Error("Invalid Codex window round count");
    cancelled(options);
    let sourcePath = options.sourcePath;
    if (!options.source && !sourcePath) sourcePath = (await (await import("./codex-client.js")).getCodexThreadAsync(options.conversationId))?.rolloutPath;
    if (!options.source && !sourcePath) throw new Error("Codex window source not found");
    const snapshot = structuredClone(options.source ?? await resolveCodexStreamingHistorySource(sourcePath!, { roots: options.roots, pathsByRolloutId: options.pathsByRolloutId, archive: options.archive, isCancelled: options.isCancelled }));
    if (!snapshot.segments.length || snapshot.segments.some(segment => segment.threadId !== options.conversationId)) throw new Error("Codex window source conversation mismatch");
    if (snapshot.segments.some(segment => segment.replicas.length)) throw new Error("Codex window replica verification required; use full canonical reader");
    for (const segment of snapshot.segments) { Object.freeze(segment.physical); Object.freeze(segment.replicas); Object.freeze(segment); }
    Object.freeze(snapshot.segments); Object.freeze(snapshot);
    assertSource(snapshot);
    const revision = sha256(canonicalJson(snapshot));
    const source = { conversationId: options.conversationId, host: "codex" as const, revision, snapshot };
    const progress: CodexHistoryWindowProgress = { phase: "reading", bytesRead: 0, recordsRead: 0, segmentsRead: 0, roundsReady: 0 };
    const origins = new Map<string, CodexCorpusThreadOrigin>();
    let entries: WindowEntry[] = [];
    let historyStartReached = false;
    let snapshotEndReached = direction === "latest";
    let published = 0;
    let result: CodexHistoryWindowRange | undefined;
    let priorityResult: CodexHistoryWindowRange | undefined;
    let priorityRounds: CodexHistoryWindowRow[] = [];
    const publishedIds = new Set<string>();
    let retainedAfterEmit: WindowEntry[] | undefined;
    let totalPublished = 0;
    const emit = async (final: boolean, activeEntries = entries): Promise<boolean> => {
        const all = project(activeEntries, options, origins);
        const eligible = direction === "latest" && !historyStartReached ? all.slice(1) : direction === "oldest" && !snapshotEndReached ? all.slice(0, -1) : all;
        const available = options.continueHistory ? eligible.filter(round => round.messages.some(message => !publishedIds.has(message.id))) : eligible;
        const selected = direction === "latest" ? available.slice(-maximum) : available.slice(0, maximum);
        const count = selected.length;
        progress.roundsReady = options.continueHistory ? totalPublished + count : count;
        if (options.continueHistory && !count && (!final || result)) return false;
        if (!final && count < Math.min(maximum, options.continueHistory ? batch : published + batch)) return count >= maximum;
        const rows = selected.map((row, index) => ({ round: index + 1, canonical: { ...row.canonical, roundIndex: index + 1 }, messages: row.messages.map(message => ({ ...message, round: index + 1 })) }));
        const rounds = rows.map(row => row.canonical);
        const messages = rows.flatMap(row => row.messages);
        const terminal = [...activeEntries].reverse().find(entry => entry.event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(entry.event.payload?.type));
        const human = [...activeEntries].reverse().find(entry => entry.event.type === "response_item" && entry.event.payload?.role === "user" || entry.event.type === "event_msg" && entry.event.payload?.type === "user_message");
        const rangeStartsHistory = historyStartReached && selected[0] === all[0] && (!options.continueHistory || direction === "latest" || totalPublished === 0);
        const rangeEndsSnapshot = snapshotEndReached && selected.at(-1) === all.at(-1) && (!options.continueHistory || direction === "oldest" || totalPublished === 0);
        const openAtSnapshot = rangeEndsSnapshot && (!terminal || Boolean(human && activeEntries.indexOf(terminal) < activeEntries.indexOf(human)));
        const anchor = (message?: CorpusMessage): CodexStreamingHistoryPosition | undefined => message?.position.path && message.position.startByte !== undefined && message.position.endByte !== undefined && message.position.ordinal !== undefined ? message.position as CodexStreamingHistoryPosition : undefined;
        assertSource(snapshot);
        cancelled(options);
        result = { source, rangeId: sha256(`${revision}:${direction}:${options.continueHistory ? canonicalJson([messages[0]?.position, messages.at(-1)?.position]) : "cumulative"}`), publication: options.continueHistory ? "append" : "replace", deduplicateBy: "message.id", direction, rounds, rows, messages, anchor: { first: anchor(messages[0]), last: anchor(messages.at(-1)) }, coverage: { kind: "chunk-local", startRound: count ? 1 : 0, endRound: count, requestedRounds: maximum, requestedRangeComplete: count >= maximum, historyStartReached: rangeStartsHistory, snapshotEndReached: rangeEndsSnapshot, openAtSnapshot }, canonicalSha256: hashCodexHistoryWindowCanonical(messages), progress: { ...progress, phase: "ready" } };
        if (options.continueHistory && count > 0 || !options.continueHistory && (count > published || final && !published)) {
            await options.onRange?.(result); assertSource(snapshot); published = count;
            if (options.continueHistory) {
                for (const message of messages) publishedIds.add(message.id);
                totalPublished += count;
                priorityRounds = (direction === "latest" ? selected.concat(priorityRounds) : priorityRounds.concat(selected));
                priorityRounds = direction === "latest" ? priorityRounds.slice(-maximum) : priorityRounds.slice(0, maximum);
                const retainedRounds = priorityRounds.map((row, index) => ({ round: index + 1, canonical: { ...row.canonical, roundIndex: index + 1 }, messages: row.messages.map(message => ({ ...message, round: index + 1 })) }));
                const retainedMessages = retainedRounds.flatMap(round => round.messages);
                priorityResult = { ...result, rangeId: sha256(`${revision}:${direction}:priority`), publication: "replace", rounds: retainedRounds.map(row => row.canonical), rows: retainedRounds, messages: retainedMessages, anchor: { first: anchor(retainedMessages[0]), last: anchor(retainedMessages.at(-1)) }, canonicalSha256: hashCodexHistoryWindowCanonical(retainedMessages), coverage: { ...result.coverage, endRound: retainedRounds.length, requestedRangeComplete: retainedRounds.length >= maximum, historyStartReached: direction === "oldest" || totalPublished <= maximum && historyStartReached, snapshotEndReached: direction === "latest" || totalPublished <= maximum && snapshotEndReached, openAtSnapshot: direction === "latest" ? priorityResult?.coverage.openAtSnapshot ?? result.coverage.openAtSnapshot : result.coverage.openAtSnapshot && totalPublished <= maximum } };
                const boundaryRound = direction === "latest" ? selected[0] : all[all.indexOf(selected.at(-1)!) + 1];
                const boundary = boundaryRound?.messages.find(message => message.role === "user")?.position ?? boundaryRound?.messages[0]?.position;
                const boundaryIndex = boundary ? activeEntries.findIndex(entry => entry.position.path === boundary.path && entry.position.startByte === boundary.startByte) : -1;
                retainedAfterEmit = direction === "latest" ? boundaryIndex >= 0 ? activeEntries.slice(0, boundaryIndex) : [] : boundaryIndex >= 0 ? activeEntries.slice(boundaryIndex) : [];
            }
        }
        await options.onProgress?.({ ...progress });
        assertSource(snapshot);
        cancelled(options);
        return count >= maximum;
    };
    const publishAvailable = async (final: boolean, activeEntries: WindowEntry[]): Promise<{ remaining: WindowEntry[]; complete: boolean }> => {
        let remaining = activeEntries;
        for (;;) {
            retainedAfterEmit = undefined;
            const complete = await emit(final, remaining);
            if (!options.continueHistory || !retainedAfterEmit) return { remaining, complete };
            remaining = retainedAfterEmit;
        }
    };
    const ordered = direction === "latest" ? [...snapshot.segments].reverse() : snapshot.segments;
    for (const segment of ordered) {
        cancelled(options);
        const metadata = await headerMetadata(segment, options);
        const segmentIndex = snapshot.segments.indexOf(segment);
        const base = metadata.history_base as { thread_id?: string; end_byte_offset?: number; end_ordinal_exclusive?: number } | undefined;
        if (segmentIndex > 0) {
            const parent = snapshot.segments[segmentIndex - 1]!;
            if (!base || base.thread_id !== parent.rolloutId || base.end_byte_offset !== parent.endByte || base.end_ordinal_exclusive !== parent.endOrdinalExclusive || base.end_ordinal_exclusive !== segment.startOrdinal) throw new Error("Codex window adopted declaration mismatch");
        } else if (base && base.end_byte_offset !== 0) throw new Error("Codex window adopted prefix missing");
        origins.set(segment.path, codexCorpusThreadOrigin(metadata, options.conversationId));
        options = { ...options, cwd: options.cwd ?? metadata.cwd as string | undefined };
        const reverse = direction === "latest" && !/\.zst$/iu.test(segment.path) && segment.ordinalMode === "explicit";
        const compressed = /\.zst$/iu.test(segment.path);
        const records = reverse ? reverseRecords(segment, progress, options) : forwardRecords(segment, progress, options);
        const segmentEntries: WindowEntry[] = [];
        let previousOrdinal: number | undefined;
        let forwardOrdinal = segment.startOrdinal;
        let boundaryChecked = false;
        let reachedStart = false;
        let users = 0;
        let nextProjection = 10;
        let stoppedEarly = false;
        for await (const record of records) {
            const event = parse(record);
            const ordinal = event.ordinal ?? forwardOrdinal;
            if (segment.ordinalMode === "explicit" && event.ordinal === undefined || !Number.isSafeInteger(ordinal) || ordinal < 0 || previousOrdinal !== undefined && (reverse ? ordinal >= previousOrdinal : ordinal <= previousOrdinal)) throw new Error("Codex window ordinal ordering mismatch");
            if (!boundaryChecked && reverse && segment.endOrdinalExclusive !== undefined && ordinal !== segment.endOrdinalExclusive - 1) throw new Error("Codex window adopted ordinal boundary mismatch");
            previousOrdinal = ordinal; forwardOrdinal = ordinal + 1; boundaryChecked = true;
            if (record.startByte === 0) {
                reachedStart = true;
                if (event.type !== "session_meta" || event.payload?.id !== options.conversationId || sha256(record.raw) !== segment.headerSha256) throw new Error("Codex window header mismatch");
                origins.set(segment.path, codexCorpusThreadOrigin(event.payload, options.conversationId));
                options = { ...options, cwd: options.cwd ?? event.payload.cwd };
            }
            segmentEntries.push({ event: slim(event, options.messageRoles ?? ["user", "assistant"]), position: { path: segment.path, startByte: record.startByte, endByte: record.endByte, ordinal } });
            progress.recordsRead += 1;
            if (event.type === "response_item" && event.payload?.role === "user" || event.type === "event_msg" && event.payload?.type === "user_message") users += 1;
            if (!compressed && (reverse || direction === "oldest") && users >= nextProjection) {
                nextProjection += 10;
                const candidate = reverse ? [...segmentEntries].reverse().concat(entries) : entries.concat(segmentEntries);
                const count = project(candidate, options, origins).length;
                if (direction === "oldest") { historyStartReached = true; snapshotEndReached = false; }
                if (count >= Math.min(maximum, options.continueHistory ? batch : published + batch) + 2) {
                    const publication = await publishAvailable(false, candidate);
                    if (options.continueHistory) {
                        segmentEntries.length = 0;
                        const retained = reverse ? [...publication.remaining].reverse() : publication.remaining;
                        for (const entry of retained) segmentEntries.push(entry);
                        entries = [];
                    }
                }
                if (!options.continueHistory && count >= maximum + 2) { stoppedEarly = true; break; }
            }
            if (progress.recordsRead % 1024 === 0) { await options.onProgress?.({ ...progress }); await setImmediate(); cancelled(options); }
        }
        if (!reverse && !stoppedEarly && segment.endOrdinalExclusive !== undefined && forwardOrdinal !== segment.endOrdinalExclusive) throw new Error("Codex window adopted ordinal boundary mismatch");
        const chronological = reverse ? segmentEntries.reverse() : segmentEntries;
        entries = direction === "latest" ? chronological.concat(entries) : entries.concat(chronological);
        historyStartReached = direction === "oldest" || reachedStart && segment === snapshot.segments[0];
        snapshotEndReached = direction === "latest" || !stoppedEarly && segment === snapshot.segments.at(-1);
        progress.segmentsRead += 1;
        const publication = await publishAvailable(false, entries);
        if (publication.complete && !options.continueHistory) break;
        if (options.continueHistory) entries = publication.remaining;
    }
    await publishAvailable(true, entries);
    await options.onProgress?.({ ...progress, phase: "complete", roundsReady: options.continueHistory ? totalPublished : result?.rounds.length ?? 0 });
    assertSource(snapshot);
    cancelled(options);
    return priorityResult ?? result!;
}
