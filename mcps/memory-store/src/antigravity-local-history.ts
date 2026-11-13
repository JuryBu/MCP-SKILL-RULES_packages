import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { prepareLocalPbFileCandidates, type LocalPbReadResult } from "./local-pb-reader.js";
import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";
import type { ConversationRound } from "./trajectory.js";
import { antigravityConversationFiles, assertAntigravityReadActive, listAntigravityLocalConversations,
    type AntigravityLocalCandidate, type AntigravityLocalDiagnostic, type AntigravityLocalFile, type AntigravityLocalOptions } from "./antigravity-local-sources.js";
import { antigravityEventsToRounds, antigravityPbEvents, mergeAntigravityEventSequences, type AntigravityLocalEvent } from "./antigravity-local-projection.js";
import { readAntigravitySqliteBody, readAntigravitySqliteIndices } from "./antigravity-local-sqlite.js";
import { withAntigravitySqliteSnapshot } from "./antigravity-sqlite-snapshot.js";

export { listAntigravityLocalConversations, antigravityDataRoots, splitAntigravityId } from "./antigravity-local-sources.js";
export type { AntigravityDataRoot, AntigravityLocalCandidate, AntigravityLocalDiagnostic, AntigravityLocalOptions } from "./antigravity-local-sources.js";
export const ANTIGRAVITY_LOCAL_NORMALIZATION_VERSION = 4;

export interface AntigravityLocalConversationResult {
    rounds: ConversationRound[];
    totalSteps: number;
    fingerprint: ConversationSourceFingerprint;
    partial: boolean;
    sourceComplete: boolean;
    sourceKind: string;
    sourceDiagnostics: AntigravityLocalDiagnostic[];
    rawSourceDiagnostics: AntigravityLocalDiagnostic[];
    metadata: AntigravityLocalCandidate;
    internalTrajectoryIds: string[];
    sourceFiles: Array<AntigravityLocalFile & { sha256?: string }>;
    pbResults: LocalPbReadResult[];
    toolOutputReferences: Array<{ stepIndex: number; relativePath: string; sourcePath: string; line: number }>;
    coverage: { unit: "step"; startStep: number; endStepExclusive: number; totalSteps: number; complete: boolean };
    timings: Record<string, number>;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`${name} must be a positive integer`);
    return selected;
}

async function readJsonl(file: AntigravityLocalFile, options: AntigravityLocalOptions, diagnose: (code: string, message: string, sourcePath?: string) => void): Promise<{ events: AntigravityLocalEvent[]; sha256: string }> {
    const maximumLine = positiveLimit(options.maxLineBytes, 16 * 1024 * 1024, "maxLineBytes");
    const maximumRecords = positiveLimit(options.maxRecords, 100_000, "maxRecords");
    const events: AntigravityLocalEvent[] = [];
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let remaining = Buffer.alloc(0);
    let line = 0;
    const consume = (bytes: Buffer, trailing: boolean) => {
        line += 1;
        const content = decoder.decode(bytes).replace(/^\uFEFF/u, "").trim();
        if (!content) return;
        if (bytes.byteLength > maximumLine) throw new Error("ANTIGRAVITY_JSONL_LINE_BUDGET");
        let raw: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(content);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSONL record must be an object");
            raw = parsed as Record<string, unknown>;
        } catch (error) {
            diagnose(trailing ? "ANTIGRAVITY_INCOMPLETE_FINAL_RECORD" : "ANTIGRAVITY_INVALID_JSONL_RECORD", `line ${line}: ${String(error)}`, file.path);
            return;
        }
        if (events.length >= maximumRecords) throw new Error("ANTIGRAVITY_JSONL_RECORD_BUDGET");
        const index = raw.step_index;
        if (!Number.isSafeInteger(index) || Number(index) < 0 || typeof raw.type !== "string") {
            diagnose("ANTIGRAVITY_UNRECOGNIZED_JSONL_RECORD", `line ${line} has no safe step_index/type`, file.path);
            return;
        }
        events.push({ stepIndex: Number(index), type: raw.type.replace(/^CORTEX_STEP_TYPE_/u, ""), createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined, raw, sourcePath: file.path, line });
    };
    const stream = fs.createReadStream(file.path, { highWaterMark: 64 * 1024 });
    let readBytes = 0;
    try {
        for await (const chunk of stream) {
            assertAntigravityReadActive(options);
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            readBytes += bytes.byteLength;
            if (readBytes > file.size) throw new Error("Antigravity JSONL grew during projection");
            hash.update(bytes);
            const buffer = remaining.length ? Buffer.concat([remaining, bytes]) : bytes;
            let start = 0;
            for (let end = buffer.indexOf(10, start); end >= 0; end = buffer.indexOf(10, start)) {
                consume(buffer.subarray(start, end), false);
                start = end + 1;
            }
            remaining = Buffer.from(buffer.subarray(start));
            if (remaining.byteLength > maximumLine) throw new Error("ANTIGRAVITY_JSONL_LINE_BUDGET");
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (remaining.length) consume(remaining, true);
        if (readBytes !== file.size) throw new Error("Antigravity JSONL shrank during projection");
    } finally { stream.destroy(); }
    return { events, sha256: hash.digest("hex") };
}

async function hashFile(file: AntigravityLocalFile, options: AntigravityLocalOptions): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file.path, { highWaterMark: 64 * 1024 })) {
        assertAntigravityReadActive(options);
        hash.update(chunk);
    }
    return hash.digest("hex");
}

function sourceRevision(metadata: AntigravityLocalCandidate, files: Array<AntigravityLocalFile & { sha256?: string }>): ConversationSourceFingerprint {
    const revision = createHash("sha256").update(JSON.stringify(["antigravity-local", ANTIGRAVITY_LOCAL_NORMALIZATION_VERSION,
        metadata.id, metadata.root, metadata.title, metadata.workspace, metadata.parentConversationId, metadata.agentName,
        files.map(file => [file.path, file.kind, file.size, file.mtimeMs, file.ctimeMs, file.ino, file.sha256])])).digest("hex");
    return { size: files.reduce((sum, file) => sum + file.size, 0), mtime: Math.max(0, ...files.map(file => file.mtimeMs)), revision };
}

async function assertSourcesUnchanged(metadata: AntigravityLocalCandidate, options: AntigravityLocalOptions): Promise<void> {
    const current = await antigravityConversationFiles(metadata.root, metadata.nativeId, options);
    if (JSON.stringify(current) !== JSON.stringify(metadata.files)) throw new Error("Antigravity local source set changed during projection");
    assertAntigravityReadActive(options);
}

export async function fingerprintAntigravityLocalConversation(conversationId: string, options: AntigravityLocalOptions = {}): Promise<ConversationSourceFingerprint | null> {
    const metadata = (await listAntigravityLocalConversations({ ...options, conversationIds: [conversationId], limit: 1 }))[0];
    if (!metadata) return null;
    const maximum = positiveLimit(options.maxBytes, 128 * 1024 * 1024, "maxBytes");
    if (metadata.files.filter(file => file.kind !== "db").reduce((sum, file) => sum + file.size, 0) > maximum) throw new Error("ANTIGRAVITY_LOCAL_BYTE_BUDGET");
    const files: Array<AntigravityLocalFile & { sha256?: string }> = [];
    for (const file of metadata.files) files.push({ ...file, ...(file.kind !== "db" ? { sha256: await hashFile(file, options) } : {}) });
    await assertSourcesUnchanged(metadata, options);
    return sourceRevision(metadata, files);
}

export async function loadAntigravityLocalConversation(conversationId: string, options: AntigravityLocalOptions = {}): Promise<AntigravityLocalConversationResult | null> {
    const started = performance.now();
    assertAntigravityReadActive(options);
    const sourceDiagnostics: AntigravityLocalDiagnostic[] = [];
    const rawSourceDiagnostics: AntigravityLocalDiagnostic[] = [];
    const diagnosticGroups = new Map<string, AntigravityLocalDiagnostic>();
    const diagnose = (code: string, message: string, sourcePath?: string) => {
        const diagnostic = { code, message, sourcePath, conversationId };
        rawSourceDiagnostics.push(diagnostic);
        const key = JSON.stringify([code, message, sourcePath, conversationId]);
        const existing = diagnosticGroups.get(key);
        if (existing) existing.occurrences = (existing.occurrences || 1) + 1;
        else {
            const visible = { ...diagnostic, occurrences: 1 };
            diagnosticGroups.set(key, visible);
            sourceDiagnostics.push(visible);
            options.onDiagnostic?.(visible);
        }
    };
    const metadata = (await listAntigravityLocalConversations({ ...options, conversationIds: [conversationId], limit: 1, onDiagnostic: item => diagnose(item.code, item.message, item.sourcePath) }))[0];
    if (!metadata) return null;
    if (!metadata.files.length) throw new Error(`ANTIGRAVITY_BODY_UNAVAILABLE: ${conversationId} has directory metadata only; no local PB, JSONL or conversation SQLite body. GUI and CLI identities remain separate; select a candidate with a readable source.`);
    const maximum = positiveLimit(options.maxBytes, 128 * 1024 * 1024, "maxBytes");
    if (metadata.files.filter(file => file.kind !== "db").reduce((sum, file) => sum + file.size, 0) > maximum) throw new Error("ANTIGRAVITY_LOCAL_BYTE_BUDGET");
    let events: AntigravityLocalEvent[] = [];
    const files: Array<AntigravityLocalFile & { sha256?: string }> = [];
    for (const file of metadata.files) {
        assertAntigravityReadActive(options);
        if (file.kind === "jsonl") {
            const parsed = await readJsonl(file, options, diagnose);
            const merged = mergeAntigravityEventSequences(events, parsed.events);
            events = merged.events;
            files.push({ ...file, sha256: parsed.sha256 });
        } else files.push({ ...file, ...(file.kind === "pb" ? { sha256: await hashFile(file, options) } : {}) });
    }
    const jsonlEvents = events.length;
    const pbResults: LocalPbReadResult[] = [];
    let actualSourceKind = metadata.sourceKind;
    let persistedIndices: number[] | undefined;
    const candidates = metadata.files.filter(file => file.kind === "pb").map(file => ({ kind: file.pbKind!, filePath: file.path }));
    if (candidates.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const prepared = prepareLocalPbFileCandidates(candidates, { ...options.pbReaderOptions, sourceFlavor: "antigravity", deadlineMs: options.deadlineMs, isCancelled: options.isCancelled, signal: options.signal });
        for (const candidate of prepared.candidates) {
            assertAntigravityReadActive(options);
            if (!candidate.reader) {
                diagnose("ANTIGRAVITY_PB_UNREADABLE", candidate.error?.message || "PB candidate cannot be decoded");
                continue;
            }
            const result = candidate.reader.read(undefined, { deadlineMs: options.deadlineMs, isCancelled: options.isCancelled, signal: options.signal });
            pbResults.push(result);
            for (const diagnostic of result.diagnostics) if (diagnostic.kind === "partial" || diagnostic.kind === "unknown_variant") diagnose(`ANTIGRAVITY_PB_${diagnostic.kind.toUpperCase()}`, diagnostic.message);
        }
        const sorted = pbResults.filter(result => result.label !== "sqlite-step-format-0").map(result => ({ result, sourcePath: candidates.find(candidate => candidate.kind === result.candidate)?.filePath || candidates[0].filePath })).sort((left, right) => right.result.trajectory.steps.length - left.result.trajectory.steps.length);
        let pbEvents: AntigravityLocalEvent[] = [];
        for (const candidate of sorted) {
            const incoming = antigravityPbEvents(candidate.result, candidate.sourcePath);
            const merged = mergeAntigravityEventSequences(pbEvents, incoming);
            if (pbEvents.length && merged.matches < Math.min(pbEvents.length, incoming.length)) diagnose("ANTIGRAVITY_PB_OVERLAP_UNVERIFIED", "PB candidates retain incomparable records");
            pbEvents = merged.events;
        }
        if (pbEvents.length) {
            const merged = mergeAntigravityEventSequences(pbEvents, events);
            if (events.length && !merged.matches && events[0].stepIndex <= pbEvents[pbEvents.length - 1].stepIndex) diagnose("ANTIGRAVITY_CROSS_GENERATION_OVERLAP_UNVERIFIED", "No compatible PB/JSONL anchor; both source sequences were retained");
            events = merged.events;
        }
    }
    if (metadata.files.some(file => file.kind === "db" && file.path.endsWith(".db"))) {
        try {
            await withAntigravitySqliteSnapshot(metadata, options, async database => {
                persistedIndices = await readAntigravitySqliteIndices(metadata, options, database);
                const available = new Set(events.map(event => event.stepIndex));
                const missing = persistedIndices?.filter(index => !available.has(index)) || [];
                if (events.length && missing.length > 256) diagnose("ANTIGRAVITY_SQLITE_SUPPLEMENT_BUDGET", `${missing.length} DB-only positions exceed the 256-position supplement budget`);
                else if (missing.length) {
                    const sqlite = await readAntigravitySqliteBody(metadata, options, events.length ? missing : undefined, database);
                    for (const diagnostic of sqlite.diagnostics) diagnose(diagnostic.code, diagnostic.message, diagnostic.sourcePath);
                    if (sqlite.result) {
                        pbResults.push(sqlite.result);
                        const sourcePath = metadata.files.find(file => file.path.endsWith(".db"))!.path;
                        for (const event of antigravityPbEvents(sqlite.result, sourcePath)) {
                            const position = events.findIndex(item => item.stepIndex > event.stepIndex);
                            events.splice(position < 0 ? events.length : position, 0, { ...event, raw: { ...event.raw, sqlite: true } });
                        }
                        actualSourceKind = `antigravity-${metadata.root.kind}-${metadata.files.some(file => file.kind === "pb") ? "pb+" : ""}${jsonlEvents ? "jsonl+" : ""}sqlite`;
                    }
                }
            });
        } catch (error) {
            assertAntigravityReadActive(options);
            diagnose("ANTIGRAVITY_SQLITE_COVERAGE_UNAVAILABLE", String(error));
        }
    }
    if (!events.length) diagnose("ANTIGRAVITY_BODY_UNAVAILABLE", "No readable PB, JSONL or conversation SQLite body");
    for (const event of events) if (event.raw.truncated_fields) diagnose("ANTIGRAVITY_TRUNCATED_FIELDS", `step ${event.stepIndex} retains truncated_fields`, event.sourcePath);
    const indices = new Set(events.map(event => event.stepIndex));
    const maximumIndex = events.reduce((maximumIndex, event) => Math.max(maximumIndex, event.stepIndex), -1);
    const totalSteps = Math.max(maximumIndex + 1, metadata.stepCount || 0);
    const startStep = events.length ? Math.min(...events.map(event => event.stepIndex)) : 0;
    const coverageComplete = persistedIndices ? persistedIndices.length > 0 && persistedIndices.every(index => indices.has(index))
        : indices.size === totalSteps && startStep === 0;
    if (!coverageComplete) diagnose("ANTIGRAVITY_STEP_COVERAGE_PARTIAL", `Available ${indices.size} distinct step positions in [${startStep}, ${maximumIndex + 1}); metadata total ${totalSteps}${persistedIndices ? `; authoritative DB positions ${persistedIndices.length}` : ""}`);
    const internalTrajectoryIds = [...new Set(pbResults.map(result => result.trajectory.id).filter((id): id is string => Boolean(id)))];
    const rounds = antigravityEventsToRounds(events.map(event => ({ ...event, raw: { ...event.raw, memoryStoreHostKind: metadata.root.kind } })));
    const toolOutputReferences = events.flatMap(event => [...String(event.raw.content || "").matchAll(/\bsteps[\\/]\d+[\\/]output\.txt\b/gu)]
        .map(match => ({ stepIndex: event.stepIndex, relativePath: match[0].replace(/\\/gu, "/"), sourcePath: event.sourcePath, line: event.line })));
    await assertSourcesUnchanged(metadata, options);
    const partial = sourceDiagnostics.length > 0 || pbResults.some(result => result.partial);
    return { rounds, totalSteps, fingerprint: sourceRevision(metadata, files), partial, sourceComplete: !partial,
        sourceKind: actualSourceKind, sourceDiagnostics: sourceDiagnostics.map(diagnostic => ({ ...diagnostic,
            message: (diagnostic.occurrences || 1) > 1 ? `${diagnostic.message} (repeated ${diagnostic.occurrences} times; full entries retained in rawSourceDiagnostics and PB diagnostics)` : diagnostic.message })),
        rawSourceDiagnostics, metadata, internalTrajectoryIds, sourceFiles: files, pbResults, toolOutputReferences,
        coverage: { unit: "step", startStep, endStepExclusive: maximumIndex + 1, totalSteps, complete: coverageComplete },
        timings: { totalMs: performance.now() - started, records: events.length, jsonlRecords: jsonlEvents, pbSteps: pbResults.reduce((sum, result) => sum + result.trajectory.steps.length, 0),
            projectionDigestVersion: ANTIGRAVITY_LOCAL_NORMALIZATION_VERSION, sourceBytes: files.filter(file => file.kind !== "db").reduce((sum, file) => sum + file.size, 0)
                + pbResults.filter(result => result.label === "sqlite-step-format-0").reduce((sum, result) => sum + result.decryptedBytes, 0) } };
}
