import { execFile, execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { StringDecoder } from "string_decoder";
import { promisify } from "util";
import type { ConversationRound } from "./trajectory.js";
import type { ConversationLinkMode } from "./chain.js";
import {
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildRecordSourceSnapshot,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type RecordSourceSnapshot,
    type SourceConversationIdentity,
    type SourceEvidenceIssue,
    type SourceEnumerationEvidence,
    type SourceRevision,
} from "./source-evidence-contracts.js";
import {
    extractCodexEventUserAttachments,
    extractCodexMessageAttachments,
    mergeRoundAttachments,
    type ConversationAttachment,
} from "./conversation-attachments.js";

export interface CodexThreadInfo {
    id: string;
    rolloutPath: string;
    cwd: string;
    title: string;
    sqliteTitle?: string;
    appTitle?: string;
    titleSource?: "session_index" | "sqlite" | "session_meta" | "rollout";
    source: string;
    model?: string | null;
    reasoningEffort?: string | null;
    agentNickname?: string | null;
    agentRole?: string | null;
    parentConversationId?: string | null;
    rootConversationId?: string | null;
    isChildThread?: boolean;
    updatedAtMs?: number | null;
}

export interface CodexSubagentSummary {
    threadId: string;
    nickname: string;
    role?: string;
    prompt?: string;
    summary?: string;
    status?: string;
    rawRole?: string;
    semanticRole?: "subagent";
    attachments?: ConversationAttachment[];
}

export interface CodexConversationData {
    thread: CodexThreadInfo;
    parentThread?: CodexThreadInfo | null;
    rounds: ConversationRound[];
    totalSteps: number;
    childThreads: CodexSubagentSummary[];
    expandedChildren?: Array<{ thread: CodexThreadInfo; rounds: ConversationRound[] }>;
    childDiagnostics?: CodexChildThreadDiagnostic[];
    sourceCheckpoints?: CodexSourceByteCheckpoint[];
    sourceCheckpoint?: CodexRoundTailCheckpoint;
}

export interface CodexChildThreadDiagnostic {
    threadId: string;
    nickname?: string;
    reason: "thread_not_found" | "rollout_missing" | "load_failed";
    detail: string;
}

export interface CodexContextProbeHit {
    roundIndex: number;
    role: "user" | "assistant" | "tool_args" | "tool_result" | "item" | "reasoning";
    snippet: string;
}

export interface CodexContextProbeThreadMatch {
    thread: CodexThreadInfo;
    parentThread?: CodexThreadInfo | null;
    rootThread?: CodexThreadInfo | null;
    hits: CodexContextProbeHit[];
}

export interface CodexDeepLocateHit {
    conversationId: string;
    title?: string;
    workspace?: string;
    source: "message_body_hit";
    mode: "exact" | "fuzzy";
    roundIndex: number;
    role: CodexContextProbeHit["role"];
    filePath: string;
    byteOffset: number;
    snippet: string;
    freshness: "fresh" | "unknown";
}

export interface CodexDeepLocateResult {
    status: "found" | "partial_found_scanning" | "no_hit_after_full_scan" | "budget_exhausted" | "cancelled";
    scannedFiles: number;
    totalFiles: number;
    scannedBytes: number;
    totalBytes: number;
    hits: CodexDeepLocateHit[];
    truncated: boolean;
    reason?: string;
}

export interface CodexDeepLocateOptions {
    mode?: "exact" | "fuzzy";
    maxFiles?: number;
    maxBytes?: number;
    maxHits?: number;
    deadlineMs?: number;
    onProgress?: (progress: {
        stage?: string;
        detail?: string;
        current?: number;
        total?: number;
        scannedBytes?: number;
        hits?: number;
    }) => void;
    isCancelled?: () => boolean;
}

const CODEX_HOME = path.join(os.homedir(), ".codex");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const CODEX_ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME, "archived_sessions");
const CODEX_JSONL_READ_CHUNK_BYTES = Number(process.env.MEMORY_STORE_CODEX_JSONL_READ_CHUNK_BYTES || 1024 * 1024);
const CODEX_JSONL_MAX_LINE_CHARS = Number(process.env.MEMORY_STORE_CODEX_JSONL_MAX_LINE_CHARS || 64 * 1024 * 1024);
const CODEX_CONTEXT_PROBE_MAX_BYTES = Number(process.env.MEMORY_STORE_CODEX_CONTEXT_PROBE_MAX_BYTES || 16 * 1024 * 1024);
const CODEX_CONTEXT_PROBE_DEADLINE_MS = Number(process.env.MEMORY_STORE_CODEX_CONTEXT_PROBE_DEADLINE_MS || 12_000);
const CODEX_AGENTS_HEADER_PREFIX = "# AGENTS.md instructions";
const CODEX_AGENTS_HEADER_LEGACY = "# AGENTS.md instructions for ";
const CODEX_RECOMMENDED_PLUGINS_OPEN = "<recommended_plugins>";
const CODEX_RECOMMENDED_PLUGINS_CLOSE = "</recommended_plugins>";
const CODEX_AGENTS_FOLDED_MARKER = "[Codex AGENTS/RULES 注入已折叠";
const CODEX_ROLLOUT_ID_RE = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const execFileAsync = promisify(execFile);

function readPositiveIntEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const CODEX_JSONL_ASYNC_YIELD_INTERVAL = readPositiveIntEnv("MEMORY_STORE_CODEX_JSONL_YIELD_INTERVAL", 128);
const CODEX_JSONL_ASYNC_CHUNK_YIELD_INTERVAL = readPositiveIntEnv("MEMORY_STORE_CODEX_JSONL_CHUNK_YIELD_INTERVAL", 4);

function normalizePath(input: string): string {
    return input.replace(/^\\\\\?\\/u, "").replace(/\\/g, "/").toLowerCase();
}

function eventLoopYield(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function pathExistsAsync(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function execPythonJson(script: string, args: string[]): any {
    const stdout = execFileSync("python", ["-c", script, ...args], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: Number(process.env.MEMORY_STORE_CODEX_PYTHON_JSON_MAX_BUFFER || 64 * 1024 * 1024),
        env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}

async function execPythonJsonAsync(script: string, args: string[]): Promise<any> {
    const { stdout } = await execFileAsync("python", ["-c", script, ...args], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: Number(process.env.MEMORY_STORE_CODEX_PYTHON_JSON_MAX_BUFFER || 64 * 1024 * 1024),
        env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}

interface CodexSessionIndexEntry {
    threadName: string;
    updatedAtMs?: number | null;
}

let sessionIndexCache: {
    mtimeMs: number;
    size: number;
    entries: Map<string, CodexSessionIndexEntry>;
} | null = null;

function parseTimestampMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseCodexSessionIndexLine(line: string): [string, CodexSessionIndexEntry] | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        const row = JSON.parse(trimmed);
        const id = typeof row?.id === "string"
            ? row.id
            : typeof row?.thread_id === "string"
                ? row.thread_id
                : typeof row?.session_id === "string"
                    ? row.session_id
                    : "";
        const threadName = typeof row?.thread_name === "string"
            ? row.thread_name.trim()
            : typeof row?.title === "string"
                ? row.title.trim()
                : "";
        if (!id || !threadName) return null;
        return [id, {
            threadName,
            updatedAtMs: parseTimestampMs(row.updated_at ?? row.updatedAt ?? row.last_active_at ?? row.lastActivityAt),
        }];
    } catch {
        return null;
    }
}

async function forEachCodexJsonlLineAsync(
    filePath: string,
    onLine: (line: string, byteOffset: number) => void | Promise<void>,
    options: {
        startByte?: number;
        endByte?: number;
        maxLineChars?: number;
        onOversizedLine?: (chars: number, isTail: boolean) => void | Promise<void>;
        isCancelled?: () => boolean;
    } = {},
): Promise<void> {
    const throwIfCancelled = (): void => {
        if (!options.isCancelled?.()) return;
        const error = new Error("Codex conversation read cancelled");
        error.name = "AbortError";
        throw error;
    };
    throwIfCancelled();
    const requiresFixedRange = options.startByte !== undefined || options.endByte !== undefined;
    const stat = requiresFixedRange ? await fs.promises.stat(filePath) : null;
    throwIfCancelled();
    const handle = await fs.promises.open(filePath, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.max(64 * 1024, CODEX_JSONL_READ_CHUNK_BYTES));
    const maxLineChars = options.maxLineChars || CODEX_JSONL_MAX_LINE_CHARS;
    const startByte = options.startByte ?? 0;
    const endByte = options.endByte;
    if (!Number.isSafeInteger(startByte) || startByte < 0 || (endByte !== undefined && (!Number.isSafeInteger(endByte) || endByte < startByte || endByte > (stat?.size ?? 0)))) {
        throw new Error("Codex JSONL byte range is invalid");
    }
    let pending = "";
    let position = startByte;
    let lineOffset = startByte;
    let skippingOversizedLine = false;
    let skippedChars = 0;
    let skippedBytes = 0;
    let linesSinceYield = 0;
    let chunksSinceYield = 0;

    const yieldAfterLine = async () => {
        linesSinceYield += 1;
        if (linesSinceYield >= CODEX_JSONL_ASYNC_YIELD_INTERVAL) {
            linesSinceYield = 0;
            await eventLoopYield();
        }
    };
    const yieldAfterChunk = async () => {
        chunksSinceYield += 1;
        if (chunksSinceYield >= CODEX_JSONL_ASYNC_CHUNK_YIELD_INTERVAL) {
            chunksSinceYield = 0;
            await eventLoopYield();
        }
    };
    const processLine = async (line: string, terminated: boolean) => {
        throwIfCancelled();
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        const byteOffset = lineOffset;
        lineOffset += Buffer.byteLength(line, "utf8") + (terminated ? 1 : 0);
        if (trimmed.trim()) await onLine(trimmed, byteOffset);
        throwIfCancelled();
        await yieldAfterLine();
    };

    try {
        while (endByte === undefined || position < endByte) {
            throwIfCancelled();
            const { bytesRead } = await handle.read(buffer, 0, endByte === undefined ? buffer.length : Math.min(buffer.length, endByte - position), position);
            throwIfCancelled();
            if (bytesRead === 0) break;
            position += bytesRead;
            let chunk = decoder.write(buffer.subarray(0, bytesRead));

            if (skippingOversizedLine) {
                const newlineIndex = chunk.indexOf("\n");
                if (newlineIndex < 0) {
                    skippedChars += chunk.length;
                    skippedBytes += Buffer.byteLength(chunk, "utf8");
                    await yieldAfterChunk();
                    continue;
                }
                skippedChars += newlineIndex;
                skippedBytes += Buffer.byteLength(chunk.slice(0, newlineIndex), "utf8");
                await options.onOversizedLine?.(skippedChars, false);
                chunk = chunk.slice(newlineIndex + 1);
                lineOffset += skippedBytes + 1;
                skippingOversizedLine = false;
                skippedChars = 0;
                skippedBytes = 0;
            }

            pending += chunk;
            let newlineIndex = pending.indexOf("\n");
            while (newlineIndex >= 0) {
                await processLine(pending.slice(0, newlineIndex), true);
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf("\n");
            }

            if (pending.length > maxLineChars) {
                skippingOversizedLine = true;
                skippedChars = pending.length;
                skippedBytes = Buffer.byteLength(pending, "utf8");
                pending = "";
            }
            await yieldAfterChunk();
        }

        const tail = decoder.end();
        if (tail) pending += tail;
        if (skippingOversizedLine) {
            skippedChars += pending.length;
            await options.onOversizedLine?.(skippedChars, true);
        } else if (pending) {
            await processLine(pending, false);
        }
    } finally {
        await handle.close();
    }
}

function readCodexSessionIndexMap(): Map<string, CodexSessionIndexEntry> {
    try {
        if (!fs.existsSync(SESSION_INDEX)) return new Map();
        const stat = fs.statSync(SESSION_INDEX);
        if (sessionIndexCache && sessionIndexCache.mtimeMs === stat.mtimeMs && sessionIndexCache.size === stat.size) {
            return sessionIndexCache.entries;
        }
        const entries = new Map<string, CodexSessionIndexEntry>();
        const text = fs.readFileSync(SESSION_INDEX, "utf8");
        for (const line of text.split(/\r?\n/u)) {
            const parsed = parseCodexSessionIndexLine(line);
            if (parsed) entries.set(parsed[0], parsed[1]);
        }
        sessionIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
        return entries;
    } catch {
        return new Map();
    }
}

async function readCodexSessionIndexMapAsync(): Promise<Map<string, CodexSessionIndexEntry>> {
    try {
        const stat = await fs.promises.stat(SESSION_INDEX);
        if (sessionIndexCache && sessionIndexCache.mtimeMs === stat.mtimeMs && sessionIndexCache.size === stat.size) {
            return sessionIndexCache.entries;
        }
        const entries = new Map<string, CodexSessionIndexEntry>();
        await forEachCodexJsonlLineAsync(SESSION_INDEX, (line) => {
            const parsed = parseCodexSessionIndexLine(line);
            if (parsed) entries.set(parsed[0], parsed[1]);
        });
        sessionIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
        return entries;
    } catch {
        return new Map();
    }
}

function applyCodexSessionIndexTitle(thread: CodexThreadInfo, index = readCodexSessionIndexMap()): CodexThreadInfo {
    const entry = index.get(thread.id);
    if (!entry?.threadName) {
        return {
            ...thread,
            sqliteTitle: thread.sqliteTitle ?? (thread.titleSource === "sqlite" || !thread.titleSource ? thread.title : thread.sqliteTitle),
            titleSource: thread.titleSource || "sqlite",
        };
    }
    return {
        ...thread,
        title: entry.threadName,
        appTitle: entry.threadName,
        sqliteTitle: thread.sqliteTitle ?? (thread.titleSource === "sqlite" || !thread.titleSource ? thread.title : thread.sqliteTitle),
        titleSource: "session_index",
        updatedAtMs: thread.updatedAtMs ?? entry.updatedAtMs ?? null,
    };
}

export function applyCodexSessionIndexTitleForTest(
    thread: CodexThreadInfo,
    rows: string[],
): CodexThreadInfo {
    const index = new Map<string, CodexSessionIndexEntry>();
    for (const row of rows) {
        const parsed = parseCodexSessionIndexLine(row);
        if (parsed) index.set(parsed[0], parsed[1]);
    }
    return applyCodexSessionIndexTitle(thread, index);
}

function threadFromSqliteRow(
    row: any,
    sessionIndex?: Map<string, CodexSessionIndexEntry>,
): CodexThreadInfo {
    return applyCodexSessionIndexTitle({
        id: row.id,
        rolloutPath: row.rollout_path,
        cwd: row.cwd,
        title: row.title,
        sqliteTitle: row.title,
        titleSource: "sqlite",
        source: row.source,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        agentNickname: row.agent_nickname,
        agentRole: row.agent_role,
        updatedAtMs: row.updated_at_ms,
    }, sessionIndex);
}

function readThreads(limit = 200, includeArchived = false): CodexThreadInfo[] {
    if (!fs.existsSync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
limit = int(sys.argv[2])
include_archived = sys.argv[3] == "1"
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
where = "" if include_archived else "where archived=0"
rows = conn.execute(
    f"select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads {where} order by updated_at_ms desc limit ?",
    (limit,)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const rows = execPythonJson(script, [STATE_DB, String(limit), includeArchived ? "1" : "0"]) as any[] || [];
    return rows.map(row => threadFromSqliteRow(row));
}

async function readThreadsAsync(limit = 200, includeArchived = false): Promise<CodexThreadInfo[]> {
    if (!await pathExistsAsync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
limit = int(sys.argv[2])
include_archived = sys.argv[3] == "1"
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
where = "" if include_archived else "where archived=0"
rows = conn.execute(
    f"select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads {where} order by updated_at_ms desc limit ?",
    (limit,)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const [rows, sessionIndex] = await Promise.all([
        execPythonJsonAsync(script, [STATE_DB, String(limit), includeArchived ? "1" : "0"]),
        readCodexSessionIndexMapAsync(),
    ]);
    return (rows as any[] || []).map(row => threadFromSqliteRow(row, sessionIndex));
}

function readThreadById(id: string): CodexThreadInfo | null {
    if (!fs.existsSync(STATE_DB)) return null;
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
thread_id = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
row = conn.execute(
    "select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads where id = ? limit 1",
    (thread_id,)
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "")
`;
    const row = execPythonJson(script, [STATE_DB, id]) as any | null;
    return row ? threadFromSqliteRow(row) : null;
}

async function readThreadByIdAsync(id: string): Promise<CodexThreadInfo | null> {
    if (!await pathExistsAsync(STATE_DB)) return null;
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
thread_id = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
row = conn.execute(
    "select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads where id = ? limit 1",
    (thread_id,)
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "")
`;
    const row = await execPythonJsonAsync(script, [STATE_DB, id]) as any | null;
    return row ? threadFromSqliteRow(row, await readCodexSessionIndexMapAsync()) : null;
}

function readThreadsByIdPrefix(prefix: string, limit = 2): CodexThreadInfo[] {
    if (!fs.existsSync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
prefix = sys.argv[2]
limit = int(sys.argv[3])
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads where id like ? order by updated_at_ms desc limit ?",
    (prefix + "%", limit)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const rows = execPythonJson(script, [STATE_DB, prefix, String(limit)]) as any[] || [];
    return rows.map(row => threadFromSqliteRow(row));
}

async function readThreadsByIdPrefixAsync(prefix: string, limit = 2): Promise<CodexThreadInfo[]> {
    if (!await pathExistsAsync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
prefix = sys.argv[2]
limit = int(sys.argv[3])
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads where id like ? order by updated_at_ms desc limit ?",
    (prefix + "%", limit)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const [rows, sessionIndex] = await Promise.all([
        execPythonJsonAsync(script, [STATE_DB, prefix, String(limit)]),
        readCodexSessionIndexMapAsync(),
    ]);
    return (rows as any[] || []).map(row => threadFromSqliteRow(row, sessionIndex));
}

function isLikelyCodexIdLookup(query: string): boolean {
    return /^[0-9a-f-]{8,36}$/iu.test(query);
}

function readSessionMetaFromRollout(rolloutPath: string): any | null {
    try {
        const fd = fs.openSync(rolloutPath, "r");
        try {
            const buffer = Buffer.alloc(1024 * 1024);
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
            const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] || "";
            if (!firstLine.trim()) return null;
            const event = JSON.parse(firstLine);
            return event?.type === "session_meta" ? event.payload || null : null;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

async function readSessionMetaFromRolloutAsync(rolloutPath: string): Promise<any | null> {
    try {
        const handle = await fs.promises.open(rolloutPath, "r");
        try {
            const buffer = Buffer.alloc(1024 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] || "";
            if (!firstLine.trim()) return null;
            const event = JSON.parse(firstLine);
            return event?.type === "session_meta" ? event.payload || null : null;
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

function threadFromRolloutPath(rolloutPath: string): CodexThreadInfo | null {
    const match = path.basename(rolloutPath).match(CODEX_ROLLOUT_ID_RE);
    if (!match) return null;
    const meta = readSessionMetaFromRollout(rolloutPath);
    const stat = fs.statSync(rolloutPath);
    const id = String(meta?.id || match[1]);
    return applyCodexSessionIndexTitle({
        id,
        rolloutPath,
        cwd: typeof meta?.cwd === "string" ? meta.cwd : "",
        title: typeof meta?.title === "string" ? meta.title : "",
        titleSource: typeof meta?.title === "string" ? "session_meta" : "rollout",
        source: typeof meta?.source === "string" ? meta.source : typeof meta?.originator === "string" ? meta.originator : "rollout",
        model: typeof meta?.model === "string" ? meta.model : null,
        reasoningEffort: typeof meta?.reasoning_effort === "string" ? meta.reasoning_effort : null,
        agentNickname: null,
        agentRole: null,
        updatedAtMs: stat.mtimeMs,
    });
}

async function threadFromRolloutPathAsync(rolloutPath: string): Promise<CodexThreadInfo | null> {
    const match = path.basename(rolloutPath).match(CODEX_ROLLOUT_ID_RE);
    if (!match) return null;
    const [meta, stat, sessionIndex] = await Promise.all([
        readSessionMetaFromRolloutAsync(rolloutPath),
        fs.promises.stat(rolloutPath),
        readCodexSessionIndexMapAsync(),
    ]);
    const id = String(meta?.id || match[1]);
    return applyCodexSessionIndexTitle({
        id,
        rolloutPath,
        cwd: typeof meta?.cwd === "string" ? meta.cwd : "",
        title: typeof meta?.title === "string" ? meta.title : "",
        titleSource: typeof meta?.title === "string" ? "session_meta" : "rollout",
        source: typeof meta?.source === "string" ? meta.source : typeof meta?.originator === "string" ? meta.originator : "rollout",
        model: typeof meta?.model === "string" ? meta.model : null,
        reasoningEffort: typeof meta?.reasoning_effort === "string" ? meta.reasoning_effort : null,
        agentNickname: null,
        agentRole: null,
        updatedAtMs: stat.mtimeMs,
    }, sessionIndex);
}

function findRolloutThreadByIdLookup(query: string): CodexThreadInfo[] {
    const normalized = query.trim().toLowerCase();
    if (!isLikelyCodexIdLookup(normalized)) return [];
    const roots = [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR].filter(root => fs.existsSync(root));
    const matches: CodexThreadInfo[] = [];
    const visit = (dir: string): boolean => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (visit(fullPath)) return true;
                continue;
            }
            if (!entry.isFile()) continue;
            const match = entry.name.match(CODEX_ROLLOUT_ID_RE);
            if (!match) continue;
            const id = match[1].toLowerCase();
            if (!id.startsWith(normalized)) continue;
            const thread = threadFromRolloutPath(fullPath);
            if (thread) matches.push(thread);
            if (id === normalized || matches.length >= 2) return true;
        }
        return false;
    };
    for (const root of roots) {
        if (visit(root)) break;
    }
    return matches;
}

async function findRolloutThreadByIdLookupAsync(query: string): Promise<CodexThreadInfo[]> {
    const normalized = query.trim().toLowerCase();
    if (!isLikelyCodexIdLookup(normalized)) return [];
    const roots = [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR];
    const matches: CodexThreadInfo[] = [];
    let entriesSinceYield = 0;

    const visit = async (dir: string): Promise<boolean> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (await visit(fullPath)) return true;
            } else if (entry.isFile()) {
                const match = entry.name.match(CODEX_ROLLOUT_ID_RE);
                if (match) {
                    const id = match[1].toLowerCase();
                    if (id.startsWith(normalized)) {
                        const thread = await threadFromRolloutPathAsync(fullPath);
                        if (thread) matches.push(thread);
                        if (id === normalized || matches.length >= 2) return true;
                    }
                }
            }
            entriesSinceYield += 1;
            if (entriesSinceYield >= CODEX_JSONL_ASYNC_YIELD_INTERVAL) {
                entriesSinceYield = 0;
                await eventLoopYield();
            }
        }
        return false;
    };

    for (const root of roots) {
        if (!await pathExistsAsync(root)) continue;
        if (await visit(root)) break;
    }
    return matches;
}

export function isCodexSessionStoreAvailable(): boolean {
    return fs.existsSync(STATE_DB);
}

export function listRecentCodexThreads(limit = 50): CodexThreadInfo[] {
    return readThreads(limit);
}

export async function listRecentCodexThreadsAsync(limit = 50): Promise<CodexThreadInfo[]> {
    return readThreadsAsync(limit);
}

export function listCodexThreadsForMetadata(
    limit = Number(process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT || 20_000),
    includeArchived = false,
): CodexThreadInfo[] {
    const parentMap = readCodexThreadParentMap();
    return readThreads(Math.max(Math.floor(limit), 1), includeArchived).map(thread => applyCodexThreadRelations(thread, parentMap));
}

export async function listCodexThreadsForMetadataAsync(
    limit = Number(process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT || 20_000),
    includeArchived = false,
): Promise<CodexThreadInfo[]> {
    const [parentMap, threads] = await Promise.all([
        readCodexThreadParentMapAsync(),
        readThreadsAsync(Math.max(Math.floor(limit), 1), includeArchived),
    ]);
    return threads.map(thread => applyCodexThreadRelations(thread, parentMap));
}

export function readCodexThreadParentMap(): Map<string, string> {
    if (!fs.existsSync(STATE_DB)) return new Map();
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
exists = conn.execute("select name from sqlite_master where type='table' and name='thread_spawn_edges'").fetchone()
if not exists:
    print("[]")
else:
    rows = conn.execute("select child_thread_id, parent_thread_id from thread_spawn_edges").fetchall()
    print(json.dumps([{"child": r[0], "parent": r[1]} for r in rows if r[0] and r[1]], ensure_ascii=False))
`;
    const rows = execPythonJson(script, [STATE_DB]) as Array<{ child: string; parent: string }> || [];
    return new Map(rows.map(row => [row.child, row.parent]));
}

export async function readCodexThreadParentMapAsync(): Promise<Map<string, string>> {
    if (!await pathExistsAsync(STATE_DB)) return new Map();
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
exists = conn.execute("select name from sqlite_master where type='table' and name='thread_spawn_edges'").fetchone()
if not exists:
    print("[]")
else:
    rows = conn.execute("select child_thread_id, parent_thread_id from thread_spawn_edges").fetchall()
    print(json.dumps([{\"child\": r[0], \"parent\": r[1]} for r in rows if r[0] and r[1]], ensure_ascii=False))
`;
    const rows = await execPythonJsonAsync(script, [STATE_DB]) as Array<{ child: string; parent: string }> || [];
    return new Map(rows.map(row => [row.child, row.parent]));
}

function applyCodexThreadRelations(thread: CodexThreadInfo, parentMap: Map<string, string>): CodexThreadInfo {
    const parentConversationId = thread.parentConversationId || parentMap.get(thread.id) || null;
    if (!parentConversationId) {
        return { ...thread, parentConversationId: null, rootConversationId: null, isChildThread: false };
    }
    let current = parentConversationId;
    let rootConversationId = parentConversationId;
    const seen = new Set<string>([thread.id]);
    for (let depth = 0; depth < 16; depth++) {
        if (seen.has(current)) break;
        seen.add(current);
        const parent = parentMap.get(current);
        if (!parent) break;
        rootConversationId = parent;
        current = parent;
    }
    return { ...thread, parentConversationId, rootConversationId, isChildThread: true };
}

export function resolveCodexThreadId(input: string): string | null {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();

    const exactById = isLikelyCodexIdLookup(queryLower) && queryLower.length === 36
        ? readThreadById(queryLower)
        : null;
    if (exactById) return exactById.id;

    if (isLikelyCodexIdLookup(queryLower)) {
        const sqlitePrefixMatches = readThreadsByIdPrefix(queryLower, 2);
        if (sqlitePrefixMatches.length === 1) return sqlitePrefixMatches[0].id;
    }

    const threads = listCodexThreadsForMetadata(undefined, true);

    const exact = threads.find((thread) => thread.id === query);
    if (exact) return exact.id;

    const prefixMatches = threads.filter((thread) => thread.id.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].id;

    const titleMatches = threads.filter((thread) => (thread.title || "").toLowerCase() === queryLower);
    if (titleMatches.length === 1) return titleMatches[0].id;

    const rolloutMatches = findRolloutThreadByIdLookup(queryLower);
    if (rolloutMatches.length === 1) return rolloutMatches[0].id;

    return null;
}

export async function resolveCodexThreadIdAsync(input: string): Promise<string | null> {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();

    const exactById = isLikelyCodexIdLookup(queryLower) && queryLower.length === 36
        ? await readThreadByIdAsync(queryLower)
        : null;
    if (exactById) return exactById.id;

    if (isLikelyCodexIdLookup(queryLower)) {
        const sqlitePrefixMatches = await readThreadsByIdPrefixAsync(queryLower, 2);
        if (sqlitePrefixMatches.length === 1) return sqlitePrefixMatches[0].id;
    }

    const threads = await listCodexThreadsForMetadataAsync(undefined, true);

    const exact = threads.find((thread) => thread.id === query);
    if (exact) return exact.id;

    const prefixMatches = threads.filter((thread) => thread.id.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].id;

    const titleMatches = threads.filter((thread) => (thread.title || "").toLowerCase() === queryLower);
    if (titleMatches.length === 1) return titleMatches[0].id;

    const rolloutMatches = await findRolloutThreadByIdLookupAsync(queryLower);
    if (rolloutMatches.length === 1) return rolloutMatches[0].id;

    return null;
}

export function getCodexThread(conversationId: string): CodexThreadInfo | null {
    const resolvedId = resolveCodexThreadId(conversationId);
    if (!resolvedId) return null;
    const exactById = readThreadById(resolvedId);
    if (exactById) return exactById;
    const threads = listCodexThreadsForMetadata(undefined, true);
    const recent = threads.find((thread) => thread.id === resolvedId);
    if (recent) return recent;
    const rolloutMatches = findRolloutThreadByIdLookup(resolvedId);
    return rolloutMatches.length === 1 ? rolloutMatches[0] : null;
}

export async function getCodexThreadAsync(conversationId: string): Promise<CodexThreadInfo | null> {
    const resolvedId = await resolveCodexThreadIdAsync(conversationId);
    if (!resolvedId) return null;
    const exactById = await readThreadByIdAsync(resolvedId);
    if (exactById) return exactById;
    const threads = await listCodexThreadsForMetadataAsync(undefined, true);
    const recent = threads.find((thread) => thread.id === resolvedId);
    if (recent) return recent;
    const rolloutMatches = await findRolloutThreadByIdLookupAsync(resolvedId);
    return rolloutMatches.length === 1 ? rolloutMatches[0] : null;
}

export function resolveCurrentCodexThreadId(cwd: string = process.cwd()): string | null {
    const threads = readThreads(200);
    if (threads.length === 0) return null;

    const target = normalizePath(cwd);
    const exact = threads.find((thread) => normalizePath(thread.cwd || "") === target);
    if (exact) return exact.id;

    const nested = threads.find((thread) => {
        const threadCwd = normalizePath(thread.cwd || "");
        return target.startsWith(threadCwd) || threadCwd.startsWith(target);
    });
    return nested?.id || threads[0]?.id || null;
}

export async function resolveCurrentCodexThreadIdAsync(cwd: string = process.cwd()): Promise<string | null> {
    const threads = await listRecentCodexThreadsAsync(200);
    if (threads.length === 0) return null;

    const target = normalizePath(cwd);
    const exact = threads.find((thread) => normalizePath(thread.cwd || "") === target);
    if (exact) return exact.id;

    const nested = threads.find((thread) => {
        const threadCwd = normalizePath(thread.cwd || "");
        return target.startsWith(threadCwd) || threadCwd.startsWith(target);
    });
    return nested?.id || threads[0]?.id || null;
}

function extractText(items: any[]): string {
    return (items || [])
        .map((item: any) => extractTextFromCodexContentItem(item))
        .join("");
}

function extractTextFromCodexContentItem(item: any): string {
    if (typeof item?.text === "string") return item.text;
    const itemType = typeof item?.type === "string" ? item.type.trim() : "";
    const imageUrl = typeof item?.image_url === "string"
        ? item.image_url
        : typeof item?.imageUrl === "string"
            ? item.imageUrl
            : typeof item?.url === "string"
                ? item.url
                : "";
    if (itemType === "input_image" && imageUrl) return "";
    return `[Codex 未识别内容块：type=${(itemType || "untyped").slice(0, 120)}]`;
}

function sha256Short(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function getCodexAgentsHeaderStart(text: string): number | null {
    if (text.startsWith(CODEX_AGENTS_HEADER_PREFIX)) return 0;
    if (!text.startsWith(CODEX_RECOMMENDED_PLUGINS_OPEN)) return null;
    const pluginsEnd = text.indexOf(CODEX_RECOMMENDED_PLUGINS_CLOSE, CODEX_RECOMMENDED_PLUGINS_OPEN.length);
    if (pluginsEnd < 0) return null;
    const prefixEnd = pluginsEnd + CODEX_RECOMMENDED_PLUGINS_CLOSE.length;
    const separatorLength = text.slice(prefixEnd).match(/^\s*/u)?.[0].length || 0;
    const agentsStart = prefixEnd + separatorLength;
    return text.startsWith(CODEX_AGENTS_HEADER_PREFIX, agentsStart) ? agentsStart : null;
}

function getCodexAgentsInstructionsBlock(text: string): { block: string; rest: string; agentsPath: string } | null {
    const agentsStart = getCodexAgentsHeaderStart(text);
    if (agentsStart === null) return null;
    const endMarker = "</INSTRUCTIONS>";
    const endIndex = text.indexOf(endMarker, agentsStart + CODEX_AGENTS_HEADER_PREFIX.length);
    if (endIndex < 0) return null;
    const beforeEnd = text.slice(agentsStart, endIndex);
    if (!beforeEnd.includes("<INSTRUCTIONS>")) return null;
    const firstLine = text.slice(agentsStart).split(/\r?\n/u, 1)[0] || "";
    const agentsPath = firstLine.startsWith(CODEX_AGENTS_HEADER_LEGACY)
        ? firstLine.slice(CODEX_AGENTS_HEADER_LEGACY.length).trim() || "(unknown)"
        : "(unknown)";
    const blockEnd = endIndex + endMarker.length;
    return {
        block: text.slice(0, blockEnd),
        rest: text.slice(blockEnd),
        agentsPath,
    };
}

function foldCodexAgentsInstructionsText(text: string): string {
    const parsed = getCodexAgentsInstructionsBlock(text);
    if (!parsed) return text;
    const placeholder = `${CODEX_AGENTS_FOLDED_MARKER}：path=${parsed.agentsPath}, chars=${parsed.block.length}, sha256=${sha256Short(parsed.block)}, reason=codex_agents_injection]`;
    const rest = parsed.rest.trimStart();
    return rest ? `${placeholder}\n\n${rest}` : placeholder;
}

function eventUserMessageText(event: any): string {
    const payload = event?.payload || {};
    if (event?.type !== "event_msg" || payload.type !== "user_message") return "";
    return extractEventMessageText(payload);
}

function hasNearbyUserMessageMirror(events: any[], index: number, text: string): boolean {
    const normalizedText = normalizeProbeText(text);
    if (!normalizedText) return false;
    const maxIndex = Math.min(events.length - 1, index + 5);
    for (let i = index + 1; i <= maxIndex; i += 1) {
        const event = events[i];
        const payload = event?.payload || {};
        if (event?.type === "event_msg" && payload.type === "user_message") {
            return normalizeProbeText(eventUserMessageText(event)) === normalizedText;
        }
        if (event?.type === "response_item" && payload.type === "message" && payload.role === "user") {
            return false;
        }
    }
    return false;
}

function shouldFoldCodexAgentsMessage(events: any[] | undefined, eventIndex: number | undefined, text: string): boolean {
    if (!getCodexAgentsInstructionsBlock(text)) return false;
    if (!events || eventIndex === undefined || eventIndex < 0) return true;
    return !hasNearbyUserMessageMirror(events, eventIndex, text);
}

function isCodexAgentsUserMessageEvent(event: any): boolean {
    const payload = event?.payload || {};
    if (event?.type !== "response_item" || payload.type !== "message" || payload.role !== "user") return false;
    return Boolean(getCodexAgentsInstructionsBlock(extractRawCodexMessageText(payload)));
}

type CodexUserSemanticRole = "user" | "system" | "subagent";

interface CodexUserSemanticSegment {
    role: CodexUserSemanticRole;
    kind: string;
    text: string;
    subagent?: CodexSubagentSummary;
}

const CODEX_SYSTEM_USER_ENVELOPES = [
    ["<codex_delegation>", "</codex_delegation>", "delegation"],
    ["<environment_context>", "</environment_context>", "environment_context"],
    ["<developer_instructions>", "</developer_instructions>", "developer_instructions"],
    ["<permissions instructions>", "</permissions instructions>", "permissions"],
    ["<collaboration_mode>", "</collaboration_mode>", "collaboration_mode"],
    ["<apps_instructions>", "</apps_instructions>", "apps_instructions"],
    ["<plugins_instructions>", "</plugins_instructions>", "plugins_instructions"],
    ["<skills_instructions>", "</skills_instructions>", "skills_instructions"],
    ["<app-context>", "</app-context>", "app_context"],
    ["<turn_aborted>", "</turn_aborted>", "turn_aborted"],
] as const;

function codexSubagentNotificationSummary(block: string): CodexSubagentSummary {
    const open = "<subagent_notification>";
    const close = "</subagent_notification>";
    const jsonText = block.slice(open.length, block.length - close.length).trim();
    try {
        const parsed = JSON.parse(jsonText) as Record<string, any>;
        const statusValue = parsed.status;
        const statusKey = typeof statusValue === "string"
            ? statusValue
            : statusValue && typeof statusValue === "object"
                ? ["completed", "errored", "failed", "cancelled", "shutdown", "running"]
                    .find(key => statusValue[key] !== undefined) || "updated"
                : "updated";
        const summaryValue = typeof statusValue === "string"
            ? statusValue
            : statusValue && typeof statusValue === "object"
                ? statusValue[statusKey]
                : "";
        return {
            threadId: typeof parsed.agent_path === "string" ? parsed.agent_path : "",
            nickname: typeof parsed.agent_nickname === "string" ? parsed.agent_nickname : "subagent",
            role: typeof parsed.agent_role === "string" ? parsed.agent_role : undefined,
            summary: typeof summaryValue === "string" ? summaryValue : stringifyCompact(summaryValue, 2_000),
            status: statusKey,
            rawRole: "response_item.message.user.subagent_notification",
            semanticRole: "subagent",
        };
    } catch {
        return {
            threadId: "",
            nickname: "subagent",
            summary: block,
            status: "unparsed",
            rawRole: "response_item.message.user.subagent_notification",
            semanticRole: "subagent",
        };
    }
}

function splitCodexUserSemanticSegments(text: string): CodexUserSemanticSegment[] {
    const segments: CodexUserSemanticSegment[] = [];
    let remaining = text.trim();
    while (remaining) {
        if (remaining.startsWith(CODEX_AGENTS_FOLDED_MARKER)) {
            const lineEnd = remaining.indexOf("\n");
            const end = lineEnd < 0 ? remaining.length : lineEnd;
            segments.push({ role: "system", kind: "agents_instructions", text: remaining.slice(0, end).trim() });
            remaining = remaining.slice(end).trimStart();
            continue;
        }
        if (remaining.startsWith("<subagent_notification>")) {
            const close = "</subagent_notification>";
            const closeIndex = remaining.indexOf(close);
            if (closeIndex >= 0) {
                const end = closeIndex + close.length;
                const block = remaining.slice(0, end);
                segments.push({
                    role: "subagent",
                    kind: "subagent_notification",
                    text: block,
                    subagent: codexSubagentNotificationSummary(block),
                });
                remaining = remaining.slice(end).trimStart();
                continue;
            }
        }
        let matchedSystemEnvelope = false;
        for (const [open, close, kind] of CODEX_SYSTEM_USER_ENVELOPES) {
            if (!remaining.startsWith(open)) continue;
            const closeIndex = remaining.indexOf(close, open.length);
            if (closeIndex < 0) continue;
            const end = closeIndex + close.length;
            segments.push({ role: "system", kind, text: remaining.slice(0, end) });
            remaining = remaining.slice(end).trimStart();
            matchedSystemEnvelope = true;
            break;
        }
        if (matchedSystemEnvelope) continue;
        segments.push({ role: "user", kind: "message", text: remaining });
        break;
    }
    return segments;
}

interface CodexMessageStableId {
    namespace: "message" | "item" | "id" | "client";
    value: string;
}

function codexStableIdValue(namespace: CodexMessageStableId["namespace"], ...candidates: unknown[]): CodexMessageStableId | null {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return { namespace, value: candidate };
    }
    return null;
}

function codexMessageStableId(event: unknown, payload: Record<string, unknown>): CodexMessageStableId | null {
    const eventFields = event && typeof event === "object" && !Array.isArray(event)
        ? event as Record<string, unknown>
        : {};
    return codexStableIdValue("message", payload.message_id, payload.messageId, eventFields.message_id, eventFields.messageId)
        || codexStableIdValue("item", payload.item_id, payload.itemId, eventFields.item_id, eventFields.itemId)
        || codexStableIdValue("id", payload.id, eventFields.id)
        || codexStableIdValue("client", payload.client_id, payload.clientId, eventFields.client_id, eventFields.clientId);
}

function normalizeCodexMirrorText(text: string): string {
    return normalizeProbeText(text.replace(
        /<image\s+name=\[Image\s+#[^\]]+\]\s+path=(?:"[^"]*"|'[^']*')\s*><\/image>/giu,
        " ",
    ));
}

function extractRawCodexMessageText(payload: any): string {
    return extractText(Array.isArray(payload?.content) ? payload.content : []);
}

function extractCodexMessageText(
    payload: any,
    options: { events?: any[]; eventIndex?: number } = {},
): string {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    const text = content.map((item: any) => extractTextFromCodexContentItem(item)).join("");
    if (
        payload?.role === "user" &&
        shouldFoldCodexAgentsMessage(options.events, options.eventIndex, text)
    ) {
        return foldCodexAgentsInstructionsText(text);
    }
    return text;
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

function codexBinaryReference(value: string, mimeType?: string): string {
    return `[binary omitted${mimeType ? ` mime=${mimeType}` : ""} chars=${value.length} sha256=${sha256Short(value)}]`;
}

function looksLikeBase64(value: string): boolean {
    return value.length >= 128 && /^[A-Za-z0-9+/=\s]+$/u.test(value);
}

function sanitizeCodexCacheText(text: string): string {
    return text.replace(/data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)/giu, (dataUrl, mimeType) => codexBinaryReference(dataUrl, mimeType));
}

function sanitizeCodexCacheAttachments(attachments: any[]): any[] {
    return attachments.map((attachment) => {
        if (typeof attachment?.dataUrl !== "string") return attachment;
        const dataUrl = attachment.dataUrl;
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/\s+/gu, "");
        const sizeBytes = Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
        const { dataUrl: _dataUrl, ...safeAttachment } = attachment;
        return {
            ...safeAttachment,
            sha256: safeAttachment.sha256 || `sha256:${createHash("sha256").update(dataUrl).digest("hex")}`,
            sizeBytes: safeAttachment.sizeBytes ?? sizeBytes,
            warning: [safeAttachment.warning, "Codex attachment data URL omitted from cache; hash retained"].filter(Boolean).join("; "),
        };
    });
}

function sanitizeCodexCacheValue(value: any, key = "", seen = new WeakSet<object>()): any {
    if (typeof value === "string") {
        if ((key === "signature" || /(?:^|_)(?:data|base64|bytes|blob|binary)$/iu.test(key)) && looksLikeBase64(value)) {
            return codexBinaryReference(value);
        }
        return sanitizeCodexCacheText(value);
    }
    if (value === undefined || value === null || typeof value !== "object") return value;
    if (Buffer.isBuffer(value)) return codexBinaryReference(value.toString("base64"));
    if (seen.has(value)) return "[circular reference omitted]";
    seen.add(value);
    if (Array.isArray(value)) {
        const items = value.map((item) => sanitizeCodexCacheValue(item, "", seen));
        seen.delete(value);
        return items;
    }
    const copy: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
        copy[entryKey] = sanitizeCodexCacheValue(entry, entryKey, seen);
    }
    seen.delete(value);
    return copy;
}

function serializeCodexCacheValue(value: any): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") {
        const trimmed = value.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            try {
                return JSON.stringify(sanitizeCodexCacheValue(JSON.parse(value)));
            } catch {
                return sanitizeCodexCacheText(value);
            }
        }
        return sanitizeCodexCacheText(value);
    }
    try {
        return JSON.stringify(sanitizeCodexCacheValue(value));
    } catch {
        return sanitizeCodexCacheText(String(value));
    }
}

function stringifyCompact(value: any, maxLen: number): string {
    if (value === undefined || value === null) return "";
    return truncate(serializeCodexCacheValue(value), maxLen);
}

function makeCodexToolCall(stepIndex: number, name: string, args: any): ConversationRound["toolCalls"][number] {
    const argsFull = serializeCodexCacheValue(args);
    return { stepIndex, name, argsSummary: truncate(argsFull, 120), argsFull, resultSummary: "" };
}

function setCodexToolCallResult(
    toolCall: ConversationRound["toolCalls"][number],
    result: any,
    summary: any = result,
    overwrite = false,
): void {
    const resultFull = serializeCodexCacheValue(result);
    if (overwrite || !toolCall.resultSummary) toolCall.resultSummary = truncate(serializeCodexCacheValue(summary), 500);
    if (overwrite || !toolCall.resultFull) toolCall.resultFull = resultFull;
}

function extractReasoningText(payload: any): string {
    if (typeof payload?.text === "string") return payload.text;
    if (typeof payload?.content === "string") return payload.content;
    if (Array.isArray(payload?.content)) return extractText(payload.content);
    if (Array.isArray(payload?.summary)) {
        const text = payload.summary
            .map((item: any) => typeof item?.text === "string" ? item.text : "")
            .filter(Boolean)
            .join("\n");
        if (text) return text;
    }
    return "";
}

function normalizeProbeText(input: string): string {
    return input
        .normalize("NFKC")
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
}

function snippet(text: string, maxLen = 160): string {
    const clean = text.replace(/\s+/gu, " ").trim();
    return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}...`;
}

function extractEventMessageText(payload: any): string {
    if (typeof payload?.message === "string") return payload.message;
    if (typeof payload?.text === "string") return payload.text;
    if (typeof payload?.content === "string") return payload.content;
    if (Array.isArray(payload?.content)) return extractText(payload.content);
    if (typeof payload?.item?.text === "string") return payload.item.text;
    return "";
}

function appendThinking(round: ConversationRound, text: string): boolean {
    const clean = text.trim();
    if (!clean) return true;
    const last = round.aiResponses[round.aiResponses.length - 1];
    if (last) {
        if (last.thinking.includes(clean)) return true;
        last.thinking = [last.thinking, clean].filter(Boolean).join("\n\n");
        return true;
    }
    return false;
}

function summarizeCommand(command: any): string {
    if (Array.isArray(command)) return command.map((part) => String(part)).join(" ");
    return String(command || "");
}

function summarizeMcpResult(result: any): string {
    const ok = result?.Ok ?? result?.ok ?? result;
    if (Array.isArray(ok?.content)) {
        return ok.content
            .map((item: any) => typeof item?.text === "string" ? sanitizeCodexCacheText(item.text) : item?.type || "")
            .filter(Boolean)
            .join("\n");
    }
    return stringifyCompact(ok, 500);
}

function unifiedDiffFromContent(file: string, change: any): string {
    const clean = (text: string) => text.replace(/\r/g, "");
    if (typeof change?.unified_diff === "string" && change.unified_diff.trim()) {
        const header = change.move_path
            ? `rename from ${file}\nrename to ${change.move_path}\n`
            : "";
        return header + clean(change.unified_diff);
    }
    if (typeof change?.content === "string") {
        const prefix = change?.type === "delete" ? "-" : "+";
        return clean(change.content).split("\n").map((line) => `${prefix}${line}`).join("\n");
    }
    return stringifyCompact(change, 2000);
}

function sanitizeCodexEvent(event: any): any {
    if (!event || typeof event !== "object") return event;
    const payload = event.payload;
    if (payload && typeof payload === "object") {
        delete payload.encrypted_content;
        if (event.type === "session_meta") {
            event.payload = {
                id: payload.id,
                timestamp: payload.timestamp,
                cwd: payload.cwd,
                originator: payload.originator,
                cli_version: payload.cli_version,
                source: payload.source,
                model_provider: payload.model_provider,
            };
        }
    }
    return event;
}

function makeSkippedRolloutLineEvent(reason: string, chars: number): any {
    return {
        type: "event_msg",
        payload: {
            type: "item_completed",
            item: {
                type: "codex_rollout_line_skipped",
                title: "Codex rollout oversized line skipped",
                text: `${reason}，约 ${chars} 字；为避免超大 JSONL 读取触发 V8 字符串上限，已跳过该单行事件。`,
            },
        },
    };
}

export function readRolloutEvents(rolloutPath: string): any[] {
    if (!fs.existsSync(rolloutPath)) return [];
    const events: any[] = [];

    const processLine = (line: string) => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.trim()) return;
        try {
            events.push(sanitizeCodexEvent(JSON.parse(trimmed)));
        } catch {
            // skip malformed lines
        }
    };

    const fd = fs.openSync(rolloutPath, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.max(64 * 1024, CODEX_JSONL_READ_CHUNK_BYTES));
    let pending = "";
    let skippingOversizedLine = false;
    let skippedChars = 0;
    try {
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            let chunk = decoder.write(buffer.subarray(0, bytesRead));

            if (skippingOversizedLine) {
                const newlineIndex = chunk.indexOf("\n");
                if (newlineIndex < 0) {
                    skippedChars += chunk.length;
                    continue;
                }
                skippedChars += newlineIndex;
                events.push(makeSkippedRolloutLineEvent("Codex rollout 单行超过安全上限", skippedChars));
                chunk = chunk.slice(newlineIndex + 1);
                skippingOversizedLine = false;
                skippedChars = 0;
            }

            pending += chunk;
            let newlineIndex = pending.indexOf("\n");
            while (newlineIndex >= 0) {
                processLine(pending.slice(0, newlineIndex));
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf("\n");
            }

            if (pending.length > CODEX_JSONL_MAX_LINE_CHARS) {
                skippingOversizedLine = true;
                skippedChars = pending.length;
                pending = "";
            }
        }

        const tail = decoder.end();
        if (tail) pending += tail;
        if (skippingOversizedLine) {
            skippedChars += pending.length;
            events.push(makeSkippedRolloutLineEvent("Codex rollout 尾部单行超过安全上限", skippedChars));
        } else {
            processLine(pending);
        }
    } finally {
        fs.closeSync(fd);
    }

    return events;
}

export async function readRolloutEventsAsync(rolloutPath: string): Promise<any[]> {
    const events: any[] = [];
    try {
        await forEachCodexJsonlLineAsync(
            rolloutPath,
            (line) => {
                try {
                    events.push(sanitizeCodexEvent(JSON.parse(line)));
                } catch {
                }
            },
            {
                onOversizedLine: (chars, isTail) => {
                    events.push(makeSkippedRolloutLineEvent(
                        isTail ? "Codex rollout 尾部单行超过安全上限" : "Codex rollout 单行超过安全上限",
                        chars,
                    ));
                },
            },
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw error;
    }
    return events;
}

function readRolloutTailEvents(rolloutPath: string, maxBytes: number): any[] {
    if (!fs.existsSync(rolloutPath)) return [];
    const stat = fs.statSync(rolloutPath);
    const bytesToRead = Math.min(Math.max(maxBytes, 64 * 1024), stat.size);
    const start = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(rolloutPath, "r");
    const buffer = Buffer.allocUnsafe(bytesToRead);
    try {
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (start > 0) {
            const firstNewline = text.indexOf("\n");
            text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
        }
        const events: any[] = [];
        for (const line of text.split(/\n/u)) {
            const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
            if (!trimmed.trim()) continue;
            if (trimmed.length > CODEX_JSONL_MAX_LINE_CHARS) {
                events.push(makeSkippedRolloutLineEvent("Codex rollout 尾部窗口单行超过安全上限", trimmed.length));
                continue;
            }
            try {
                events.push(sanitizeCodexEvent(JSON.parse(trimmed)));
            } catch {
                // ignore partial/malformed tail line
            }
        }
        return events;
    } finally {
        fs.closeSync(fd);
    }
}

export function matchCodexContextProbeInEvents(events: any[], probe: string): CodexContextProbeHit[] {
    const normalizedProbe = normalizeProbeText(probe);
    if (normalizedProbe.length < 12) return [];

    const hits: CodexContextProbeHit[] = [];
    let roundIndex = 0;
    let activeRound = 0;
    let lastUserMessage = "";
    let lastAssistantMessage = "";

    const addHit = (role: CodexContextProbeHit["role"], text: string) => {
        if (!text) return;
        const normalizedText = normalizeProbeText(text);
        if (!normalizedText.includes(normalizedProbe)) return;
        hits.push({
            roundIndex: activeRound || Math.max(roundIndex, 1),
            role,
            snippet: snippet(text),
        });
    };

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex];
        const type = event?.type;
        const payload = event?.payload || {};

        if (type === "response_item" && payload.type === "message") {
            const text = sanitizeCodexCacheText(extractCodexMessageText(payload, { events, eventIndex }));
            if (payload.role === "user") {
                roundIndex += 1;
                activeRound = roundIndex;
                lastUserMessage = normalizeProbeText(text);
                addHit("user", text);
            } else if (payload.role === "assistant") {
                if (!activeRound) activeRound = Math.max(roundIndex, 1);
                lastAssistantMessage = normalizeProbeText(text);
                addHit("assistant", text);
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "user_message") {
            const text = sanitizeCodexCacheText(extractEventMessageText(payload));
            const normalized = normalizeProbeText(text);
            if (normalized && normalized !== lastUserMessage) {
                roundIndex += 1;
                activeRound = roundIndex;
                lastUserMessage = normalized;
                addHit("user", text);
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "agent_message") {
            if (!activeRound) activeRound = Math.max(roundIndex, 1);
            const text = sanitizeCodexCacheText(extractEventMessageText(payload));
            const normalized = normalizeProbeText(text);
            if (normalized && normalized !== lastAssistantMessage) {
                lastAssistantMessage = normalized;
                addHit("assistant", text);
            }
            continue;
        }

        if (type === "response_item" && payload.type === "reasoning") {
            addHit("reasoning", sanitizeCodexCacheText(extractReasoningText(payload)));
            continue;
        }

        if (type === "event_msg" && payload.type === "agent_reasoning") {
            addHit("reasoning", sanitizeCodexCacheText(extractReasoningText(payload)));
            continue;
        }

        if (type === "event_msg" && payload.type === "item_completed") {
            const item = payload.item || {};
            addHit("item", typeof item.text === "string" ? item.text : stringifyCompact(item, 2000));
            continue;
        }

        if (type === "event_msg" && payload.type === "mcp_tool_call_end") {
            addHit("tool_args", stringifyCompact(payload.invocation?.arguments || {}, 1000));
            addHit("tool_result", summarizeMcpResult(payload.result));
            continue;
        }

        if (type === "event_msg" && payload.type === "exec_command_end") {
            addHit("tool_result", [
                stringifyCompact(payload.command || "", 500),
                payload.aggregated_output || payload.stdout || payload.stderr || payload.formatted_output || "",
            ].filter(Boolean).join("\n"));
            continue;
        }

        if (type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
            addHit("tool_args", stringifyCompact(payload.input || payload.arguments || "", 1000));
            continue;
        }

        if (type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
            addHit("tool_result", stringifyCompact(payload.output || payload.result || "", 2000));
            continue;
        }

        if (type === "event_msg" && payload.type === "patch_apply_end") {
            addHit("tool_result", [
                payload.stdout || "",
                payload.stderr || "",
                payload.status || "",
                stringifyCompact(payload.changes || {}, 2000),
            ].filter(Boolean).join("\n"));
            continue;
        }
    }

    return hits.slice(0, 5);
}

function makeCodexTextEntriesFromEvent(
    event: any,
    state: { roundIndex: number; activeRound: number; lastUserMessage: string; lastAssistantMessage: string },
    options: { events?: any[]; eventIndex?: number; foldAgents?: boolean } = {},
): Array<{ role: CodexContextProbeHit["role"]; text: string; roundIndex: number }> {
    const type = event?.type;
    const payload = event?.payload || {};
    const entries: Array<{ role: CodexContextProbeHit["role"]; text: string; roundIndex: number }> = [];
    const add = (role: CodexContextProbeHit["role"], text: string) => {
        if (!text) return;
        entries.push({
            role,
            text,
            roundIndex: state.activeRound || Math.max(state.roundIndex, 1),
        });
    };

    if (type === "response_item" && payload.type === "message") {
        const text = sanitizeCodexCacheText(
            options.foldAgents === false ? extractText(payload.content || []) : extractCodexMessageText(payload, {
                events: options.events,
                eventIndex: options.eventIndex,
            }),
        );
        if (payload.role === "user") {
            state.roundIndex += 1;
            state.activeRound = state.roundIndex;
            state.lastUserMessage = normalizeProbeText(text);
            add("user", text);
        } else if (payload.role === "assistant") {
            if (!state.activeRound) state.activeRound = Math.max(state.roundIndex, 1);
            state.lastAssistantMessage = normalizeProbeText(text);
            add("assistant", text);
        }
        return entries;
    }

    if (type === "event_msg" && payload.type === "user_message") {
        const text = sanitizeCodexCacheText(extractEventMessageText(payload));
        const normalized = normalizeProbeText(text);
        if (normalized && normalized !== state.lastUserMessage) {
            state.roundIndex += 1;
            state.activeRound = state.roundIndex;
            state.lastUserMessage = normalized;
            add("user", text);
        }
        return entries;
    }

    if (type === "event_msg" && payload.type === "agent_message") {
        if (!state.activeRound) state.activeRound = Math.max(state.roundIndex, 1);
        const text = sanitizeCodexCacheText(extractEventMessageText(payload));
        const normalized = normalizeProbeText(text);
        if (normalized && normalized !== state.lastAssistantMessage) {
            state.lastAssistantMessage = normalized;
            add("assistant", text);
        }
        return entries;
    }

    if (type === "response_item" && payload.type === "reasoning") {
        add("reasoning", sanitizeCodexCacheText(extractReasoningText(payload)));
        return entries;
    }
    if (type === "event_msg" && payload.type === "agent_reasoning") {
        add("reasoning", sanitizeCodexCacheText(extractReasoningText(payload)));
        return entries;
    }
    if (type === "event_msg" && payload.type === "item_completed") {
        const item = payload.item || {};
        add("item", typeof item.text === "string" ? item.text : stringifyCompact(item, 2000));
        return entries;
    }
    if (type === "event_msg" && payload.type === "mcp_tool_call_end") {
        add("tool_args", stringifyCompact(payload.invocation?.arguments || {}, 1000));
        add("tool_result", summarizeMcpResult(payload.result));
        return entries;
    }
    if (type === "event_msg" && payload.type === "exec_command_end") {
        add("tool_result", [
            stringifyCompact(payload.command || "", 500),
            payload.aggregated_output || payload.stdout || payload.stderr || payload.formatted_output || "",
        ].filter(Boolean).join("\n"));
        return entries;
    }
    if (type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
        add("tool_args", stringifyCompact(payload.input || payload.arguments || "", 1000));
        return entries;
    }
    if (type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
        add("tool_result", stringifyCompact(payload.output || payload.result || "", 2000));
        return entries;
    }
    if (type === "event_msg" && payload.type === "patch_apply_end") {
        add("tool_result", [
            payload.stdout || "",
            payload.stderr || "",
            payload.status || "",
            stringifyCompact(payload.changes || {}, 2000),
        ].filter(Boolean).join("\n"));
    }
    return entries;
}

function deepLocateTokens(query: string): string[] {
    const normalized = normalizeProbeText(query).toLowerCase();
    const raw = normalized.split(/\s+/u).filter(Boolean);
    if (raw.length > 1) return raw.slice(0, 16);
    if (normalized.length <= 3) return normalized ? [normalized] : [];
    const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/u;
    if (cjk.test(normalized)) {
        const tokens = new Set<string>();
        for (let i = 0; i < normalized.length - 1; i++) tokens.add(normalized.slice(i, i + 2));
        return [...tokens].slice(0, 16);
    }
    return [normalized];
}

function codexDeepLocateMatched(text: string, query: string, mode: "exact" | "fuzzy", tokens: string[]): boolean {
    const normalizedText = normalizeProbeText(text).toLowerCase();
    const normalizedQuery = normalizeProbeText(query).toLowerCase();
    if (!normalizedText || !normalizedQuery) return false;
    if (mode === "exact") return normalizedText.includes(normalizedQuery);
    if (tokens.length === 0) return false;
    const hits = tokens.reduce((sum, token) => sum + (normalizedText.includes(token) ? 1 : 0), 0);
    return hits >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function scanCodexRolloutForQuery(
    thread: CodexThreadInfo,
    query: string,
    options: Required<Pick<CodexDeepLocateOptions, "mode" | "maxBytes" | "maxHits">> & {
        deadlineMs: number;
        startedAt: number;
        isCancelled: () => boolean;
    },
): { hits: CodexDeepLocateHit[]; scannedBytes: number; budgetExhausted: boolean; cancelled: boolean } {
    if (!thread.rolloutPath || !fs.existsSync(thread.rolloutPath)) {
        return { hits: [], scannedBytes: 0, budgetExhausted: false, cancelled: false };
    }
    const fd = fs.openSync(thread.rolloutPath, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.max(64 * 1024, CODEX_JSONL_READ_CHUNK_BYTES));
    const tokens = deepLocateTokens(query);
    const hits: CodexDeepLocateHit[] = [];
    const state = { roundIndex: 0, activeRound: 0, lastUserMessage: "", lastAssistantMessage: "" };
    let pending = "";
    let scannedBytes = 0;
    let lineOffset = 0;
    let budgetExhausted = false;
    let cancelled = false;
    let pendingAgentsEvent: { event: any; offset: number; text: string } | null = null;

    const processEvent = (event: any, offset: number, textOptions: { foldAgents?: boolean } = {}) => {
        for (const entry of makeCodexTextEntriesFromEvent(event, state, textOptions)) {
            if (!codexDeepLocateMatched(entry.text, query, options.mode, tokens)) continue;
            hits.push({
                conversationId: thread.id,
                title: thread.title,
                workspace: thread.cwd,
                source: "message_body_hit",
                mode: options.mode,
                roundIndex: entry.roundIndex,
                role: entry.role,
                filePath: thread.rolloutPath,
                byteOffset: offset,
                snippet: snippet(entry.text),
                freshness: "fresh",
            });
            if (hits.length >= options.maxHits) {
                budgetExhausted = true;
                return;
            }
        }
    };

    const flushPendingAgentsEvent = (foldAgents: boolean) => {
        if (!pendingAgentsEvent) return;
        processEvent(pendingAgentsEvent.event, pendingAgentsEvent.offset, { foldAgents });
        pendingAgentsEvent = null;
    };

    const processLine = (line: string, offset: number) => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.trim()) return;
        try {
            const event = sanitizeCodexEvent(JSON.parse(trimmed));
            if (pendingAgentsEvent) {
                const mirrorText = eventUserMessageText(event);
                if (mirrorText && normalizeProbeText(mirrorText) === normalizeProbeText(pendingAgentsEvent.text)) {
                    flushPendingAgentsEvent(false);
                    processEvent(event, offset);
                    return;
                }
                flushPendingAgentsEvent(true);
                if (budgetExhausted) return;
            }
            if (isCodexAgentsUserMessageEvent(event)) {
                pendingAgentsEvent = {
                    event,
                    offset,
                    text: extractRawCodexMessageText(event.payload || {}),
                };
                return;
            }
            processEvent(event, offset);
        } catch {
            // skip malformed lines
        }
    };

    try {
        while (true) {
            if (options.isCancelled()) {
                cancelled = true;
                break;
            }
            if (Date.now() - options.startedAt > options.deadlineMs || scannedBytes >= options.maxBytes) {
                budgetExhausted = true;
                break;
            }
            const remainingBudget = options.maxBytes - scannedBytes;
            const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remainingBudget), null);
            if (bytesRead === 0) break;
            scannedBytes += bytesRead;
            pending += decoder.write(buffer.subarray(0, bytesRead));
            let newlineIndex = pending.indexOf("\n");
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex);
                processLine(line, lineOffset);
                lineOffset += Buffer.byteLength(line) + 1;
                pending = pending.slice(newlineIndex + 1);
                if (budgetExhausted || options.isCancelled()) break;
                newlineIndex = pending.indexOf("\n");
            }
            if (pending.length > CODEX_JSONL_MAX_LINE_CHARS) {
                lineOffset += Buffer.byteLength(pending);
                pending = "";
            }
            if (budgetExhausted || options.isCancelled()) {
                cancelled = options.isCancelled();
                break;
            }
        }
        const tail = decoder.end();
        if (!budgetExhausted && !cancelled && tail) pending += tail;
        if (!budgetExhausted && !cancelled && pending) processLine(pending, lineOffset);
        if (!budgetExhausted && !cancelled) flushPendingAgentsEvent(true);
    } finally {
        fs.closeSync(fd);
    }

    return { hits, scannedBytes, budgetExhausted, cancelled };
}

export function deepLocateCodexConversations(
    query: string,
    threads: CodexThreadInfo[],
    options: CodexDeepLocateOptions = {},
): CodexDeepLocateResult {
    const mode = options.mode || "exact";
    const maxFiles = Math.max(1, options.maxFiles || 20);
    const maxBytes = Math.max(64 * 1024, options.maxBytes || 512 * 1024 * 1024);
    const maxHits = Math.max(1, options.maxHits || 20);
    const deadlineMs = Math.max(1000, options.deadlineMs || 5 * 60 * 1000);
    const startedAt = Date.now();
    const selected = threads.slice(0, maxFiles);
    const totalBytes = selected.reduce((sum, thread) => {
        try {
            return sum + (thread.rolloutPath && fs.existsSync(thread.rolloutPath) ? fs.statSync(thread.rolloutPath).size : 0);
        } catch {
            return sum;
        }
    }, 0);
    const hits: CodexDeepLocateHit[] = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let budgetExhausted = false;
    let cancelled = false;

    for (const thread of selected) {
        if (options.isCancelled?.()) {
            cancelled = true;
            break;
        }
        options.onProgress?.({
            stage: "raw_scan",
            detail: `${thread.title || thread.id} (${thread.id.slice(0, 8)})`,
            current: scannedFiles,
            total: selected.length,
            scannedBytes,
            hits: hits.length,
        });
        const remainingHits = maxHits - hits.length;
        if (remainingHits <= 0) {
            budgetExhausted = true;
            break;
        }
        const result = scanCodexRolloutForQuery(thread, query, {
            mode,
            maxBytes: Math.max(0, maxBytes - scannedBytes),
            maxHits: remainingHits,
            deadlineMs,
            startedAt,
            isCancelled: () => Boolean(options.isCancelled?.()),
        });
        scannedBytes += result.scannedBytes;
        hits.push(...result.hits);
        scannedFiles += 1;
        if (result.cancelled) {
            cancelled = true;
            break;
        }
        if (result.budgetExhausted || scannedBytes >= maxBytes || Date.now() - startedAt > deadlineMs || hits.length >= maxHits) {
            budgetExhausted = true;
            break;
        }
    }

    options.onProgress?.({
        stage: cancelled ? "cancelled" : "done",
        detail: hits.length > 0 ? `命中 ${hits.length} 条` : "未命中",
        current: scannedFiles,
        total: selected.length,
        scannedBytes,
        hits: hits.length,
    });

    const status: CodexDeepLocateResult["status"] = cancelled
        ? "cancelled"
        : (budgetExhausted
            ? (hits.length > 0 ? "partial_found_scanning" : "budget_exhausted")
            : (hits.length > 0 ? "found" : "no_hit_after_full_scan"));

    return {
        status,
        scannedFiles,
        totalFiles: selected.length,
        scannedBytes,
        totalBytes,
        hits,
        truncated: budgetExhausted,
        reason: budgetExhausted ? "budget_exhausted" : undefined,
    };
}

export function matchCodexContextProbeInRollout(
    rolloutPath: string,
    probe: string,
    options: { maxBytes?: number } = {},
): CodexContextProbeHit[] {
    if (!fs.existsSync(rolloutPath)) return [];
    const maxBytes = Math.max(64 * 1024, options.maxBytes || CODEX_CONTEXT_PROBE_MAX_BYTES);
    const stat = fs.statSync(rolloutPath);
    const events = stat.size <= maxBytes
        ? readRolloutEvents(rolloutPath)
        : readRolloutTailEvents(rolloutPath, maxBytes);
    return matchCodexContextProbeInEvents(events, probe);
}

export function findCodexContextProbeMatches(
    threads: CodexThreadInfo[],
    probe: string,
    options: { maxThreads?: number; deadlineMs?: number; maxBytes?: number } = {},
): CodexContextProbeThreadMatch[] {
    const normalizedProbe = normalizeProbeText(probe);
    if (normalizedProbe.length < 12) return [];
    const startedAt = Date.now();
    const deadlineMs = Math.max(500, options.deadlineMs || CODEX_CONTEXT_PROBE_DEADLINE_MS);

    const maxThreads = Math.min(
        Math.max(options.maxThreads || Number(process.env.MEMORY_STORE_CODEX_CONTEXT_PROBE_SCAN_LIMIT || 50), 1),
        threads.length,
    );
    const matches: CodexContextProbeThreadMatch[] = [];

    for (const thread of threads.slice(0, maxThreads)) {
        if (Date.now() - startedAt > deadlineMs) break;
        if (!thread.rolloutPath || !fs.existsSync(thread.rolloutPath)) continue;
        const hits = matchCodexContextProbeInRollout(thread.rolloutPath, normalizedProbe, { maxBytes: options.maxBytes });
        if (hits.length === 0) continue;
        const parentThread = getCodexParentThread(thread.id);
        matches.push({
            thread,
            parentThread,
            rootThread: parentThread ? getCodexRootThread(thread.id) : null,
            hits,
        });
    }

    return matches;
}

function readSpawnChildren(parentThreadId: string): CodexSubagentSummary[] {
    if (!fs.existsSync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
parent = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    select e.child_thread_id, e.status, t.agent_nickname, t.agent_role, t.title
    from thread_spawn_edges e
    left join threads t on t.id = e.child_thread_id
    where e.parent_thread_id = ?
    order by coalesce(t.updated_at_ms, t.updated_at, 0) desc
    """,
    (parent,)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const rows = execPythonJson(script, [STATE_DB, parentThreadId]) as any[] || [];
    return rows.map((row) => ({
        threadId: row.child_thread_id,
        nickname: row.agent_nickname || row.title || "subagent",
        role: row.agent_role || "",
        summary: row.status ? `数据库边状态: ${row.status}` : undefined,
    })).filter((item) => item.threadId);
}

async function readSpawnChildrenAsync(parentThreadId: string): Promise<CodexSubagentSummary[]> {
    if (!await pathExistsAsync(STATE_DB)) return [];
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
parent = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    select e.child_thread_id, e.status, t.agent_nickname, t.agent_role, t.title
    from thread_spawn_edges e
    left join threads t on t.id = e.child_thread_id
    where e.parent_thread_id = ?
    order by coalesce(t.updated_at_ms, t.updated_at, 0) desc
    """,
    (parent,)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
    const rows = await execPythonJsonAsync(script, [STATE_DB, parentThreadId]) as any[] || [];
    return rows.map((row) => ({
        threadId: row.child_thread_id,
        nickname: row.agent_nickname || row.title || "subagent",
        role: row.agent_role || "",
        summary: row.status ? `数据库边状态: ${row.status}` : undefined,
    })).filter((item) => item.threadId);
}

export function getCodexParentThread(threadId: string): CodexThreadInfo | null {
    const resolvedId = resolveCodexThreadId(threadId);
    if (!resolvedId || !fs.existsSync(STATE_DB)) return null;
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
child = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
row = conn.execute(
    """
    select t.id, t.rollout_path, t.cwd, t.title, t.source, t.model, t.reasoning_effort,
           t.agent_nickname, t.agent_role, t.updated_at_ms
    from thread_spawn_edges e
    join threads t on t.id = e.parent_thread_id
    where e.child_thread_id = ?
    order by coalesce(t.updated_at_ms, t.updated_at, 0) desc
    limit 1
    """,
    (child,)
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "null")
`;
    const row = execPythonJson(script, [STATE_DB, resolvedId]) as any | null;
    if (!row) return null;
    return threadFromSqliteRow(row);
}

export async function getCodexParentThreadAsync(threadId: string): Promise<CodexThreadInfo | null> {
    const resolvedId = await resolveCodexThreadIdAsync(threadId);
    if (!resolvedId || !await pathExistsAsync(STATE_DB)) return null;
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
child = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
row = conn.execute(
    """
    select t.id, t.rollout_path, t.cwd, t.title, t.source, t.model, t.reasoning_effort,
           t.agent_nickname, t.agent_role, t.updated_at_ms
    from thread_spawn_edges e
    join threads t on t.id = e.parent_thread_id
    where e.child_thread_id = ?
    order by coalesce(t.updated_at_ms, t.updated_at, 0) desc
    limit 1
    """,
    (child,)
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "null")
`;
    const row = await execPythonJsonAsync(script, [STATE_DB, resolvedId]) as any | null;
    if (!row) return null;
    return threadFromSqliteRow(row, await readCodexSessionIndexMapAsync());
}

export function getCodexRootThread(threadId: string): CodexThreadInfo | null {
    let current = getCodexThread(threadId);
    if (!current) return null;

    const seen = new Set<string>();
    for (let depth = 0; depth < 12; depth++) {
        if (seen.has(current.id)) return current;
        seen.add(current.id);
        const parent = getCodexParentThread(current.id);
        if (!parent) return current.id === threadId ? null : current;
        current = parent;
    }

    return current.id === threadId ? null : current;
}

function buildCodexRoundsLegacy(
    events: any[],
    link: ConversationLinkMode,
    options: { cwd?: string } = {},
): { rounds: ConversationRound[]; childThreads: CodexSubagentSummary[] } {
    const rounds: ConversationRound[] = [];
    const childMap = new Map<string, CodexSubagentSummary>();
    const toolCallMap = new Map<string, { round: ConversationRound; index: number }>();
    let currentRound: ConversationRound | null = null;
    let roundIndex = 0;
    let syntheticStep = 0;
    let pendingThinking = "";

    const ensureRound = (): ConversationRound => {
        if (!currentRound) {
            roundIndex += 1;
            currentRound = {
                roundIndex,
                startStep: syntheticStep,
                endStep: syntheticStep,
                userMessage: "(无显式用户消息)",
                mediaAttachments: [],
                aiResponses: [],
                toolCalls: [],
                taskBoundaries: [],
                codeActions: [],
                subagentSummaries: [],
                fileViews: [],
            };
        }
        return currentRound;
    };

    const pushCurrent = () => {
        if (!currentRound) return;
        currentRound.endStep = syntheticStep;
        rounds.push(currentRound);
        currentRound = null;
    };

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex];
        syntheticStep += 1;
        const type = event?.type;
        const payload = event?.payload || {};

        if (type === "response_item" && payload.type === "message") {
            const text = sanitizeCodexCacheText(extractCodexMessageText(payload, { events, eventIndex }));
            if (payload.role === "user") {
                pushCurrent();
                roundIndex += 1;
            const attachments = sanitizeCodexCacheAttachments(extractCodexMessageAttachments(payload.content || [], text, { cwd: options.cwd, stepIndex: syntheticStep }));
                currentRound = {
                    roundIndex,
                    startStep: syntheticStep,
                    endStep: syntheticStep,
                    userMessage: text,
                    mediaAttachments: [],
                    attachments,
                    aiResponses: [],
                    toolCalls: [],
                    taskBoundaries: [],
                    codeActions: [],
                    subagentSummaries: [],
                    fileViews: [],
                };
            } else if (payload.role === "assistant") {
                const round = ensureRound();
                round.aiResponses.push({
                    stepIndex: syntheticStep,
                    response: text,
                    thinking: pendingThinking,
                    toolCalls: [],
                });
                pendingThinking = "";
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "user_message") {
            const text = sanitizeCodexCacheText(extractEventMessageText(payload));
            const attachments = sanitizeCodexCacheAttachments(extractCodexEventUserAttachments(payload, { cwd: options.cwd, stepIndex: syntheticStep }));
            const normalized = normalizeProbeText(text);
            const currentNormalized = currentRound ? normalizeProbeText(currentRound.userMessage) : "";
            if (
                currentRound &&
                (
                    !normalized ||
                    normalized === currentNormalized ||
                    (currentRound.aiResponses.length === 0 && currentRound.toolCalls.length === 0)
                )
            ) {
                mergeRoundAttachments(currentRound, attachments);
                if (currentRound.userMessage === "(无显式用户消息)" && text) {
                    currentRound.userMessage = text;
                }
            } else {
                pushCurrent();
                roundIndex += 1;
                currentRound = {
                    roundIndex,
                    startStep: syntheticStep,
                    endStep: syntheticStep,
                    userMessage: text || "(无显式用户消息)",
                    mediaAttachments: [],
                    attachments,
                    aiResponses: [],
                    toolCalls: [],
                    taskBoundaries: [],
                    codeActions: [],
                    subagentSummaries: [],
                    fileViews: [],
                };
            }
            continue;
        }

        const round = ensureRound();

        if (type === "response_item" && payload.type === "reasoning") {
            const text = sanitizeCodexCacheText(extractReasoningText(payload));
            if (!appendThinking(round, text) && text.trim()) {
                const clean = text.trim();
                if (!pendingThinking.includes(clean)) {
                    pendingThinking = [pendingThinking, clean].filter(Boolean).join("\n\n");
                }
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "agent_reasoning") {
            const text = sanitizeCodexCacheText(extractReasoningText(payload));
            if (!appendThinking(round, text) && text.trim()) {
                const clean = text.trim();
                if (!pendingThinking.includes(clean)) {
                    pendingThinking = [pendingThinking, clean].filter(Boolean).join("\n\n");
                }
            }
            continue;
        }

        if (type === "response_item" && payload.type === "function_call") {
            const index = round.toolCalls.push(makeCodexToolCall(
                syntheticStep,
                payload.name || "unknown",
                payload.arguments || "",
            )) - 1;
            if (payload.call_id) {
                toolCallMap.set(payload.call_id, { round, index });
            }
            continue;
        }

        if (type === "response_item" && payload.type === "custom_tool_call") {
            const index = round.toolCalls.push(makeCodexToolCall(
                syntheticStep,
                payload.name || "custom_tool",
                payload.input || payload.arguments || "",
            )) - 1;
            if (payload.call_id) {
                toolCallMap.set(payload.call_id, { round, index });
            }
            continue;
        }

        if (type === "response_item" && payload.type === "function_call_output") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot && !slot.round.toolCalls[slot.index].resultFull) setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.output || "");
            continue;
        }

        if (type === "response_item" && payload.type === "custom_tool_call_output") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot && !slot.round.toolCalls[slot.index].resultFull) setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.output || "");
            continue;
        }

        if (type === "event_msg" && payload.type === "exec_command_end") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            const result = payload.aggregated_output || payload.stdout || payload.stderr || payload.formatted_output || "";
            if (slot) {
                setCodexToolCallResult(slot.round.toolCalls[slot.index], result, result, true);
            } else {
                const toolCall = makeCodexToolCall(syntheticStep, "exec_command", summarizeCommand(payload.command));
                setCodexToolCallResult(toolCall, result);
                round.toolCalls.push(toolCall);
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "mcp_tool_call_end") {
            const invocation = payload.invocation || {};
            const name = invocation.tool
                ? `${invocation.server || "mcp"}/${invocation.tool}`
                : "mcp_tool";
            const result = summarizeMcpResult(payload.result);
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot) {
                slot.round.toolCalls[slot.index].name = slot.round.toolCalls[slot.index].name || name;
                setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.result, result, true);
            } else {
                const toolCall = makeCodexToolCall(syntheticStep, name, invocation.arguments || {});
                setCodexToolCallResult(toolCall, payload.result, result);
                round.toolCalls.push(toolCall);
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "patch_apply_end") {
            const changes = payload.changes || {};
            for (const [file, change] of Object.entries(changes)) {
                const changeObj = change as any;
                round.codeActions.push({
                    stepIndex: syntheticStep,
                    description: `Codex patch_apply_end: ${changeObj?.type || "change"}`,
                    targetFile: String(file),
                    instruction: truncate(payload.stdout || payload.stderr || payload.status || "", 500),
                    diffs: [{
                        targetContent: "",
                        replacementContent: "",
                        unifiedDiff: unifiedDiffFromContent(String(file), changeObj),
                    }],
                });
            }
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot) {
                setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.stdout || payload.stderr || payload.status || "", undefined, true);
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "item_completed") {
            const item = payload.item || {};
            const text = typeof item.text === "string" ? item.text : "";
            round.fileViews = round.fileViews || [];
            round.fileViews.push({
                stepIndex: syntheticStep,
                kind: item.type || "item",
                id: item.id,
                title: item.title || item.name,
                textSummary: truncate(text || stringifyCompact(item, 500), 500),
            });
            continue;
        }

        if (type === "event_msg" && payload.type === "collab_agent_spawn_end") {
            const child = {
                threadId: payload.new_thread_id || "",
                nickname: payload.new_agent_nickname || "subagent",
                role: payload.new_agent_role || "",
                prompt: truncate(payload.prompt || "", 200),
                summary: link === "reference" ? undefined : "运行中",
            };
            if (child.threadId) childMap.set(child.threadId, child);
            round.subagentSummaries.push(child);
            continue;
        }

        if (type === "event_msg" && payload.type === "collab_waiting_end" && Array.isArray(payload.agent_statuses)) {
            for (const item of payload.agent_statuses) {
                const child: CodexSubagentSummary = childMap.get(item.thread_id) || {
                    threadId: item.thread_id || "",
                    nickname: item.agent_nickname || "subagent",
                    role: item.agent_role || "",
                };
                if (link !== "reference") {
                    child.summary = truncate(
                        item.status?.completed ||
                        item.status?.errored ||
                        item.status?.failed ||
                        item.status?.cancelled ||
                        "已完成",
                        300,
                    );
                }
                childMap.set(child.threadId, child);
                if (!round.subagentSummaries.find((existing) => existing.threadId === child.threadId)) {
                    round.subagentSummaries.push(child);
                }
            }
        }
    }

    pushCurrent();

    return {
        rounds,
        childThreads: [...childMap.values()],
    };
}

export type CodexSourceCheckpointKind = "round_start" | "thinking" | "tool_call" | "tool_result" | "agents";

export interface CodexSourceByteCheckpoint {
    kind: CodexSourceCheckpointKind;
    roundIndex: number;
    sourceByte: number;
}

export interface CodexRoundBuildResult {
    rounds: ConversationRound[];
    childThreads: CodexSubagentSummary[];
    totalSteps: number;
    peakBufferedEvents: number;
    sourceCheckpoints: CodexSourceByteCheckpoint[];
    lastRound?: ConversationRound;
}

class CodexRoundBuilder {
    private readonly rounds: ConversationRound[] = [];
    private readonly childMap = new Map<string, CodexSubagentSummary>();
    private readonly toolCallMap = new Map<string, { round: ConversationRound; index: number }>();
    private currentRound: ConversationRound | null = null;
    private currentRoundHasModelOutput = false;
    private roundIndex = 0;
    private syntheticStep = 0;
    private pendingThinking = "";
    private currentRoundStartByte: number | null = null;
    private readonly sourceCheckpoints: CodexSourceByteCheckpoint[] = [];
    private lastRound: ConversationRound | undefined;
    private readonly pendingLeadingSemanticSegments: Array<{
        segment: CodexUserSemanticSegment;
        attachments: ConversationAttachment[];
        rawRole: string;
        stepIndex: number;
        sourceByte?: number;
    }> = [];
    private messageMirrorCandidate: {
        source: "response_item" | "event_msg";
        semanticRole: "user" | "system" | "model" | "subagent";
        normalizedText: string;
        stableId: CodexMessageStableId | null;
        hasAttachments: boolean;
        stepIndex: number;
    } | null = null;

    constructor(
        private readonly link: ConversationLinkMode,
        private readonly options: {
            cwd?: string;
            onRound?: (round: ConversationRound) => void;
            retainRounds?: boolean;
        },
    ) {}

    private flushPendingLeadingSemanticSegments(): void {
        const pending = this.pendingLeadingSemanticSegments.splice(0);
        for (const item of pending) {
            if (item.segment.role === "system") {
                this.addSystemMessage(item.segment.text, item.rawRole, item.segment.kind, item.sourceByte, item.attachments, item.stepIndex);
            } else if (item.segment.role === "subagent") {
                this.addSubagentMessage(item.segment, item.attachments, item.rawRole, item.sourceByte, item.stepIndex);
            }
        }
    }

    private recordSourceCheckpoint(kind: Exclude<CodexSourceCheckpointKind, "round_start">, round: ConversationRound, sourceByte?: number): void {
        if (!Number.isSafeInteger(sourceByte)) return;
        this.sourceCheckpoints.push({ kind, roundIndex: round.roundIndex, sourceByte: sourceByte! });
    }

    private shouldSkipMessageMirror(
        event: any,
        payload: Record<string, unknown>,
        source: "response_item" | "event_msg",
        semanticRole: "user" | "system" | "model" | "subagent",
        text: string,
        hasAttachments = false,
    ): boolean {
        const normalizedText = normalizeCodexMirrorText(text);
        const stableId = codexMessageStableId(event, payload);
        const candidate = this.messageMirrorCandidate;
        const stableIdsConflict = Boolean(
            candidate?.stableId
            && stableId
            && candidate.stableId.namespace === stableId.namespace
            && candidate.stableId.value !== stableId.value,
        );
        const sameStableId = Boolean(
            candidate?.stableId
            && stableId
            && candidate.stableId.namespace === stableId.namespace
            && candidate.stableId.value === stableId.value,
        );
        const samePayload = Boolean(
            candidate
            && candidate.normalizedText === normalizedText
            && (normalizedText || (candidate.hasAttachments && hasAttachments)),
        );
        const stepDistance = candidate ? this.syntheticStep - candidate.stepIndex : Number.POSITIVE_INFINITY;
        if (
            candidate
            && candidate.source !== source
            && candidate.semanticRole === semanticRole
            && !stableIdsConflict
            && samePayload
            && (stepDistance === 1 || (sameStableId && stepDistance <= 5))
        ) {
            this.messageMirrorCandidate = null;
            return true;
        }
        this.messageMirrorCandidate = normalizedText || hasAttachments
            ? { source, semanticRole, normalizedText, stableId, hasAttachments, stepIndex: this.syntheticStep }
            : null;
        return false;
    }

    private mergeMirroredAttachments(
        attachments: ConversationAttachment[],
        semanticRole: "user" | "system" | "model" | "subagent",
    ): void {
        if (!this.currentRound || attachments.length === 0) return;
        mergeRoundAttachments(this.currentRound, attachments);
        if (semanticRole === "user") {
            const lastMessage = this.currentRound.userMessages?.at(-1);
            if (lastMessage) lastMessage.attachments = mergeCodexEvidenceAttachments(lastMessage.attachments, attachments);
            return;
        }
        const lastEvent = [...(this.currentRound.semanticEvents || [])].reverse().find(event => event.semanticRole === semanticRole);
        if (!lastEvent) return;
        lastEvent.attachments = mergeCodexEvidenceAttachments(lastEvent.attachments, attachments);
        if (lastEvent.subagent) {
            lastEvent.subagent.attachments = mergeCodexEvidenceAttachments(lastEvent.subagent.attachments, attachments);
        }
    }

    private addSystemMessage(
        text: string,
        rawRole: string,
        kind: string,
        sourceByte?: number,
        attachments: ConversationAttachment[] = [],
        stepIndex = this.syntheticStep,
    ): void {
        if (!text.trim()) return;
        if (!this.currentRound) {
            this.pendingLeadingSemanticSegments.push({
                segment: { role: "system", kind, text },
                attachments,
                rawRole,
                stepIndex: this.syntheticStep,
                sourceByte,
            });
            return;
        }
        const round = this.currentRound;
        mergeRoundAttachments(round, attachments);
        round.semanticEvents = [
            ...(round.semanticEvents || []),
            {
                stepIndex,
                rawRole,
                semanticRole: "system",
                kind,
                text,
                ...(attachments.length > 0 ? { attachments } : {}),
            },
        ];
        if (kind === "agents_instructions") this.recordSourceCheckpoint("agents", round, sourceByte);
        if (kind === "turn_aborted" && round.userMessages?.length) this.currentRoundHasModelOutput = true;
    }

    private addSubagentMessage(
        segment: CodexUserSemanticSegment,
        attachments: ConversationAttachment[],
        rawRole: string,
        sourceByte?: number,
        stepIndex = this.syntheticStep,
    ): void {
        if (!this.currentRound) {
            this.pendingLeadingSemanticSegments.push({ segment, attachments, rawRole, stepIndex: this.syntheticStep, sourceByte });
            return;
        }
        const round = this.currentRound;
        const parsed = segment.subagent || {
            threadId: "",
            nickname: "subagent",
            summary: segment.text,
            status: "updated",
            rawRole,
            semanticRole: "subagent" as const,
        };
        const compact: CodexSubagentSummary = {
            ...parsed,
            rawRole,
            semanticRole: "subagent",
            summary: this.link === "reference" ? undefined : truncate(parsed.summary || "", 300),
            attachments: mergeCodexEvidenceAttachments(
                this.childMap.get(parsed.threadId || "")?.attachments,
                attachments,
            ),
        };
        mergeRoundAttachments(round, attachments);
        if (compact.threadId) this.childMap.set(compact.threadId, compact);
        const existing = round.subagentSummaries.find(item => compact.threadId && item.threadId === compact.threadId);
        if (existing) {
            compact.attachments = mergeCodexEvidenceAttachments(existing.attachments, compact.attachments || []);
            Object.assign(existing, compact);
        }
        else round.subagentSummaries.push(compact);
        round.semanticEvents = [
            ...(round.semanticEvents || []),
            {
                stepIndex,
                rawRole,
                semanticRole: "subagent",
                kind: segment.kind,
                text: segment.text,
                name: compact.nickname,
                subagent: compact,
                attachments,
            },
        ];
        this.currentRoundHasModelOutput = true;
    }

    private addAssistantMessage(text: string, rawRole: string, sourceByte?: number): void {
        const round = this.currentRound;
        if (!round) return;
        if (text.trim()) {
            round.aiResponses.push({
                stepIndex: this.syntheticStep,
                response: text,
                thinking: this.pendingThinking,
                toolCalls: [],
            });
            round.semanticEvents = [
                ...(round.semanticEvents || []),
                { stepIndex: this.syntheticStep, rawRole, semanticRole: "model", kind: "response" },
            ];
            this.pendingThinking = "";
        }
        this.currentRoundHasModelOutput = true;
    }

    private addUserSemanticSegments(
        segments: CodexUserSemanticSegment[],
        attachments: ConversationAttachment[],
        rawRole: string,
        sourceByte?: number,
    ): void {
        if (segments.length === 0 && attachments.length > 0) {
            this.addUserMessage("", attachments, rawRole, sourceByte);
            return;
        }
        let attachmentsAssigned = false;
        for (const segment of segments) {
            if (segment.role === "system") {
                this.addSystemMessage(segment.text, rawRole, segment.kind, sourceByte, attachmentsAssigned ? [] : attachments);
                attachmentsAssigned = true;
            } else if (segment.role === "subagent") {
                this.addSubagentMessage(segment, attachmentsAssigned ? [] : attachments, rawRole, sourceByte);
                attachmentsAssigned = true;
            } else {
                this.addUserMessage(segment.text, attachmentsAssigned ? [] : attachments, rawRole, sourceByte);
                attachmentsAssigned = true;
            }
        }
        if (!attachmentsAssigned && attachments.length > 0) this.mergeMirroredAttachments(attachments, "system");
    }

    private pushCurrent(): void {
        if (!this.currentRound) return;
        const completedRound = this.currentRound;
        completedRound.endStep = this.syntheticStep;
        if (this.currentRoundStartByte !== null) {
            this.sourceCheckpoints.push({
                kind: "round_start",
                roundIndex: completedRound.roundIndex,
                sourceByte: this.currentRoundStartByte,
            });
        }
        this.options.onRound?.(completedRound);
        if (this.options.retainRounds !== false) this.rounds.push(completedRound);
        this.lastRound = completedRound;
        for (const [callId, slot] of this.toolCallMap) {
            if (slot.round === completedRound && slot.round.toolCalls[slot.index]?.resultFull) {
                this.toolCallMap.delete(callId);
            }
        }
        this.currentRound = null;
        this.currentRoundHasModelOutput = false;
        this.currentRoundStartByte = null;
    }

    private addUserMessage(text: string, attachments: ConversationAttachment[], rawRole: string, sourceByte?: number): void {
        const hasUserContent = Boolean(text) || attachments.length > 0;
        if (!hasUserContent) return;
        const userMessage = {
            stepIndex: this.syntheticStep,
            text,
            rawRole,
            semanticRole: "user" as const,
            attachments,
            mediaAttachments: [] as string[],
        };
        if (this.currentRound && !this.currentRoundHasModelOutput) {
            mergeRoundAttachments(this.currentRound, attachments);
            const existingMessages = this.currentRound.userMessages || (this.currentRound.userMessage === "(无显式用户消息)"
                ? []
                : [{ stepIndex: this.currentRound.startStep, text: this.currentRound.userMessage }]);
            if (this.currentRound.userMessage === "(无显式用户消息)") {
                this.currentRound.userMessage = text || "(仅附件)";
                this.currentRound.userMessages = [userMessage];
                this.currentRound.semanticEvents = [
                    ...(this.currentRound.semanticEvents || []),
                    { stepIndex: this.syntheticStep, rawRole, semanticRole: "user", kind: "message", text },
                ];
            } else {
                this.currentRound.userMessages = [...existingMessages, userMessage];
                this.currentRound.userMessage = this.currentRound.userMessages.map((message) => message.text).filter(Boolean).join("\n\n");
                this.currentRound.semanticEvents = [
                    ...(this.currentRound.semanticEvents || []),
                    { stepIndex: this.syntheticStep, rawRole, semanticRole: "user", kind: "message", text },
                ];
            }
            return;
        }
        this.pushCurrent();
        this.roundIndex += 1;
        this.currentRound = {
            roundIndex: this.roundIndex,
            startStep: this.syntheticStep,
            endStep: this.syntheticStep,
            userMessage: text || "(仅附件)",
            mediaAttachments: [],
            attachments,
            aiResponses: [],
            toolCalls: [],
            taskBoundaries: [],
            codeActions: [],
            subagentSummaries: [],
            fileViews: [],
            userMessages: [userMessage],
            semanticEvents: [],
        };
        this.flushPendingLeadingSemanticSegments();
        this.currentRound.semanticEvents = [
            ...(this.currentRound.semanticEvents || []),
            { stepIndex: this.syntheticStep, rawRole, semanticRole: "user", kind: "message", text },
        ];
        this.currentRoundHasModelOutput = false;
        this.currentRoundStartByte = Number.isSafeInteger(sourceByte) ? sourceByte! : null;
    }

    addEvent(event: any, options: { foldAgents?: boolean; sourceByte?: number; agentsInstructions?: boolean } = {}): void {
        this.syntheticStep += 1;
        const type = event?.type;
        const payload = event?.payload || {};
        const sourceByte = options.sourceByte;
        if (type === "response_item" && payload.type === "message") {
            const content = Array.isArray(payload.content) ? payload.content : [];
            if (codexEvidenceToolOnlyContent(content)) return;
            const rawText = extractRawCodexMessageText(payload);
            if (payload.role === "user") {
                const parsedAgents = options.agentsInstructions ? getCodexAgentsInstructionsBlock(rawText) : null;
                const displayText = sanitizeCodexCacheText(options.foldAgents === false ? rawText : extractCodexMessageText(payload));
                const segments = parsedAgents
                    ? [
                        { role: "system" as const, kind: "agents_instructions", text: foldCodexAgentsInstructionsText(parsedAgents.block) },
                        ...splitCodexUserSemanticSegments(sanitizeCodexCacheText(parsedAgents.rest)),
                    ]
                    : splitCodexUserSemanticSegments(displayText);
                const semanticRole = segments.some(segment => segment.role === "user")
                    ? "user"
                    : segments.some(segment => segment.role === "subagent")
                        ? "subagent"
                        : "system";
                const attachments = sanitizeCodexCacheAttachments(extractCodexMessageAttachments(payload.content || [], rawText, {
                    cwd: this.options.cwd,
                    stepIndex: this.syntheticStep,
                }));
                if (this.shouldSkipMessageMirror(event, payload, "response_item", semanticRole, displayText, attachments.length > 0)) {
                    this.mergeMirroredAttachments(attachments, semanticRole);
                    return;
                }
                this.addUserSemanticSegments(segments, attachments, "response_item.message.user", sourceByte);
            } else if (payload.role === "assistant") {
                const text = sanitizeCodexCacheText(extractCodexMessageText(payload));
                if (!this.shouldSkipMessageMirror(event, payload, "response_item", "model", text)) {
                    this.addAssistantMessage(text, "response_item.message.assistant", sourceByte);
                }
            }
            return;
        }
        if (type === "event_msg" && payload.type === "user_message") {
            const text = sanitizeCodexCacheText(extractEventMessageText(payload));
            const segments = splitCodexUserSemanticSegments(text);
            const semanticRole = segments.some(segment => segment.role === "user")
                ? "user"
                : segments.some(segment => segment.role === "subagent")
                    ? "subagent"
                    : "system";
            const attachments = sanitizeCodexCacheAttachments(extractCodexEventUserAttachments(payload, { cwd: this.options.cwd, stepIndex: this.syntheticStep }));
            if (this.shouldSkipMessageMirror(event, payload, "event_msg", semanticRole, text, attachments.length > 0)) {
                this.mergeMirroredAttachments(attachments, semanticRole);
                return;
            }
            this.addUserSemanticSegments(segments, attachments, "event_msg.user_message", sourceByte);
            return;
        }
        if (type === "event_msg" && payload.type === "agent_message") {
            const text = sanitizeCodexCacheText(extractEventMessageText(payload));
            if (!this.shouldSkipMessageMirror(event, payload, "event_msg", "model", text)) {
                this.addAssistantMessage(text, "event_msg.agent_message", sourceByte);
            }
            return;
        }
        if (type === "event_msg" && payload.type === "turn_aborted") {
            if (this.currentRound?.userMessages?.length) this.currentRoundHasModelOutput = true;
            return;
        }

        const round = this.currentRound;
        if (!round) return;
        if (type === "response_item" && payload.type === "reasoning") {
            this.appendThinking(round, sanitizeCodexCacheText(extractReasoningText(payload)));
            this.recordSourceCheckpoint("thinking", round, sourceByte);
            return;
        }
        if (type === "event_msg" && payload.type === "agent_reasoning") {
            this.appendThinking(round, sanitizeCodexCacheText(extractReasoningText(payload)));
            this.recordSourceCheckpoint("thinking", round, sourceByte);
            return;
        }
        if (type === "response_item" && payload.type === "function_call") {
            const index = round.toolCalls.push(makeCodexToolCall(
                this.syntheticStep,
                payload.name || "unknown",
                payload.arguments || "",
            )) - 1;
            if (payload.call_id) this.toolCallMap.set(payload.call_id, { round, index });
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_call", round, sourceByte);
            return;
        }
        if (type === "response_item" && payload.type === "custom_tool_call") {
            const index = round.toolCalls.push(makeCodexToolCall(
                this.syntheticStep,
                payload.name || "custom_tool",
                payload.input || payload.arguments || "",
            )) - 1;
            if (payload.call_id) this.toolCallMap.set(payload.call_id, { round, index });
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_call", round, sourceByte);
            return;
        }
        if (type === "response_item" && payload.type === "function_call_output") {
            const slot = payload.call_id ? this.toolCallMap.get(payload.call_id) : null;
            if (slot && !slot.round.toolCalls[slot.index].resultFull) setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.output || "");
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_result", round, sourceByte);
            return;
        }
        if (type === "response_item" && payload.type === "custom_tool_call_output") {
            const slot = payload.call_id ? this.toolCallMap.get(payload.call_id) : null;
            if (slot && !slot.round.toolCalls[slot.index].resultFull) setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.output || "");
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_result", round, sourceByte);
            return;
        }
        if (type === "event_msg" && payload.type === "exec_command_end") {
            const slot = payload.call_id ? this.toolCallMap.get(payload.call_id) : null;
            const result = payload.aggregated_output || payload.stdout || payload.stderr || payload.formatted_output || "";
            if (slot) {
                setCodexToolCallResult(slot.round.toolCalls[slot.index], result, result, true);
            } else {
                const toolCall = makeCodexToolCall(this.syntheticStep, "exec_command", summarizeCommand(payload.command));
                setCodexToolCallResult(toolCall, result);
                round.toolCalls.push(toolCall);
            }
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_result", round, sourceByte);
            return;
        }
        if (type === "event_msg" && payload.type === "mcp_tool_call_end") {
            const invocation = payload.invocation || {};
            const name = invocation.tool ? [invocation.server || "mcp", invocation.tool].join("/") : "mcp_tool";
            const result = summarizeMcpResult(payload.result);
            const slot = payload.call_id ? this.toolCallMap.get(payload.call_id) : null;
            if (slot) {
                slot.round.toolCalls[slot.index].name = slot.round.toolCalls[slot.index].name || name;
                setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.result, result, true);
            } else {
                const toolCall = makeCodexToolCall(this.syntheticStep, name, invocation.arguments || {});
                setCodexToolCallResult(toolCall, payload.result, result);
                round.toolCalls.push(toolCall);
            }
            this.currentRoundHasModelOutput = true;
            this.recordSourceCheckpoint("tool_result", round, sourceByte);
            return;
        }
        if (type === "event_msg" && payload.type === "patch_apply_end") {
            for (const [file, change] of Object.entries(payload.changes || {})) {
                const changeObj = change as any;
                round.codeActions.push({
                    stepIndex: this.syntheticStep,
                    description: "Codex patch_apply_end: " + (changeObj?.type || "change"),
                    targetFile: String(file),
                    instruction: truncate(payload.stdout || payload.stderr || payload.status || "", 500),
                    diffs: [{
                        targetContent: "",
                        replacementContent: "",
                        unifiedDiff: unifiedDiffFromContent(String(file), changeObj),
                    }],
                });
            }
            const slot = payload.call_id ? this.toolCallMap.get(payload.call_id) : null;
            if (slot) setCodexToolCallResult(slot.round.toolCalls[slot.index], payload.stdout || payload.stderr || payload.status || "", undefined, true);
            this.currentRoundHasModelOutput = true;
            return;
        }
        if (type === "event_msg" && payload.type === "item_completed") {
            const item = payload.item || {};
            const text = typeof item.text === "string" ? item.text : "";
            round.fileViews = round.fileViews || [];
            round.fileViews.push({
                stepIndex: this.syntheticStep,
                kind: item.type || "item",
                id: item.id,
                title: item.title || item.name,
                textSummary: truncate(text || stringifyCompact(item, 500), 500),
            });
            this.currentRoundHasModelOutput = true;
            return;
        }
        if (type === "event_msg" && payload.type === "collab_agent_spawn_end") {
            const child = {
                threadId: payload.new_thread_id || "",
                nickname: payload.new_agent_nickname || "subagent",
                role: payload.new_agent_role || "",
                prompt: truncate(payload.prompt || "", 200),
                summary: this.link === "reference" ? undefined : "运行中",
            };
            if (child.threadId) this.childMap.set(child.threadId, child);
            round.subagentSummaries.push(child);
            this.currentRoundHasModelOutput = true;
            return;
        }
        if (type === "event_msg" && payload.type === "collab_waiting_end" && Array.isArray(payload.agent_statuses)) {
            for (const item of payload.agent_statuses) {
                const child: CodexSubagentSummary = this.childMap.get(item.thread_id) || {
                    threadId: item.thread_id || "",
                    nickname: item.agent_nickname || "subagent",
                    role: item.agent_role || "",
                };
                if (this.link !== "reference") {
                    child.summary = truncate(
                        item.status?.completed ||
                        item.status?.errored ||
                        item.status?.failed ||
                        item.status?.cancelled ||
                        "已完成",
                        300,
                    );
                }
                this.childMap.set(child.threadId, child);
                if (!round.subagentSummaries.find((existing) => existing.threadId === child.threadId)) {
                    round.subagentSummaries.push(child);
                }
            }
            this.currentRoundHasModelOutput = true;
        }
    }

    private appendThinking(round: ConversationRound, text: string): void {
        if (!appendThinking(round, text) && text.trim()) {
            const clean = text.trim();
            if (!this.pendingThinking.includes(clean)) {
                this.pendingThinking = [this.pendingThinking, clean].filter(Boolean).join("\n\n");
            }
        }
        this.currentRoundHasModelOutput = true;
    }

    finish(): { rounds: ConversationRound[]; childThreads: CodexSubagentSummary[]; sourceCheckpoints: CodexSourceByteCheckpoint[]; lastRound?: ConversationRound } {
        this.pushCurrent();
        return {
            rounds: this.rounds,
            childThreads: [...this.childMap.values()],
            sourceCheckpoints: this.sourceCheckpoints,
            lastRound: this.lastRound,
        };
    }
}

class CodexRoundEventCollector {
    private readonly builder: CodexRoundBuilder;
    private readonly bufferedEvents: Array<{ event: any; sourceByte?: number }> = [];
    private totalSteps = 0;
    private peakBufferedEvents = 0;

    constructor(link: ConversationLinkMode, options: { cwd?: string; onRound?: (round: ConversationRound) => void; retainRounds?: boolean }) {
        this.builder = new CodexRoundBuilder(link, options);
    }

    addEvent(event: any, sourceByte?: number): void {
        this.totalSteps += 1;
        this.bufferedEvents.push({ event, sourceByte });
        this.peakBufferedEvents = Math.max(this.peakBufferedEvents, this.bufferedEvents.length);
        this.drain(false);
    }

    private agentsFoldDecision(): boolean | null {
        const candidateText = extractRawCodexMessageText(this.bufferedEvents[0]?.event?.payload || {});
        for (let index = 1; index < this.bufferedEvents.length && index <= 5; index += 1) {
            const event = this.bufferedEvents[index].event;
            const mirrorText = eventUserMessageText(event);
            if (mirrorText) return normalizeProbeText(mirrorText) !== normalizeProbeText(candidateText);
            const payload = event?.payload || {};
            if (event?.type === "response_item" && payload.type === "message" && payload.role === "user") return true;
        }
        return this.bufferedEvents.length > 5 ? true : null;
    }

    private drain(forceFoldPendingAgents: boolean): void {
        while (this.bufferedEvents.length > 0) {
            const entry = this.bufferedEvents[0];
            const event = entry.event;
            if (!isCodexAgentsUserMessageEvent(event)) {
                this.builder.addEvent(event, { sourceByte: entry.sourceByte });
                this.bufferedEvents.shift();
                continue;
            }
            const foldAgents = this.agentsFoldDecision();
            if (foldAgents === null && !forceFoldPendingAgents) return;
            this.builder.addEvent(event, {
                ...(foldAgents === false ? { foldAgents: false } : {}),
                sourceByte: entry.sourceByte,
                agentsInstructions: foldAgents !== false,
            });
            this.bufferedEvents.shift();
        }
    }

    finish(): CodexRoundBuildResult {
        this.drain(true);
        return { ...this.builder.finish(), totalSteps: this.totalSteps, peakBufferedEvents: this.peakBufferedEvents };
    }
}

function buildCodexRoundsFromEvents(events: any[], link: ConversationLinkMode, options: { cwd?: string } = {}): CodexRoundBuildResult {
    const collector = new CodexRoundEventCollector(link, options);
    for (const event of events) collector.addEvent(event);
    return collector.finish();
}

async function buildCodexRoundsFromRolloutAsync(
    rolloutPath: string,
    link: ConversationLinkMode,
    options: {
        cwd?: string;
        startByte?: number;
        endByte?: number;
        onRound?: (round: ConversationRound) => void;
        retainRounds?: boolean;
        isCancelled?: () => boolean;
    } = {},
): Promise<CodexRoundBuildResult> {
    const collector = new CodexRoundEventCollector(link, options);
    try {
        await forEachCodexJsonlLineAsync(rolloutPath, (line, sourceByte) => {
            try {
                collector.addEvent(sanitizeCodexEvent(JSON.parse(line)), sourceByte);
            } catch {
            }
        }, {
            startByte: options.startByte,
            endByte: options.endByte,
            onOversizedLine: (chars, isTail) => {
                collector.addEvent(makeSkippedRolloutLineEvent(
                    isTail ? "Codex rollout 尾部单行超过安全上限" : "Codex rollout 单行超过安全上限",
                    chars,
                ));
            },
            isCancelled: options.isCancelled,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return collector.finish();
}

export function buildCodexRoundsForTest(
    events: any[],
    link: ConversationLinkMode,
    options: { cwd?: string } = {},
): { rounds: ConversationRound[]; childThreads: CodexSubagentSummary[] } {
    const built = buildCodexRoundsFromEvents(events, link, options);
    return { rounds: built.rounds, childThreads: built.childThreads };
}

export async function buildCodexRoundsFromRolloutForTest(
    rolloutPath: string,
    link: ConversationLinkMode,
    options: { cwd?: string; onRound?: (round: ConversationRound) => void; retainRounds?: boolean; isCancelled?: () => boolean } = {},
): Promise<CodexRoundBuildResult> {
    return buildCodexRoundsFromRolloutAsync(rolloutPath, link, options);
}

const CODEX_INCREMENTAL_CHECKPOINT_ANCHOR_BYTES = 8 * 1024;

export interface CodexRoundTailCheckpoint {
    version: 1;
    sourceSize: number;
    sourceMtimeMs: number;
    anchorStartByte: number;
    anchorSha256: string;
    replayStartByte: number;
    replayStartStep: number;
    replaceFromRound: number;
}

export interface CodexRoundTailReadOptions {
    cwd?: string;
    startByte?: number;
    checkpoint?: CodexRoundTailCheckpoint;
    sourceChange?: "append" | "replace";
}

export interface CodexRoundTailReadResult {
    status: "ok" | "unchanged" | "rebuild_required";
    reason?: "checkpoint_required" | "checkpoint_mismatch" | "source_truncated" | "source_replaced" | "source_changed_during_read" | "source_unavailable";
    replaceFromRound: number;
    startByte: number;
    sourceSize: number;
    roundIndexOffset: number;
    rounds: ConversationRound[];
    childThreads: CodexSubagentSummary[];
    totalSteps: number;
    sourceCheckpoints: CodexSourceByteCheckpoint[];
    checkpoint?: CodexRoundTailCheckpoint;
}

async function codexCheckpointAnchor(filePath: string, sourceSize: number): Promise<{ anchorStartByte: number; anchorSha256: string }> {
    const anchorStartByte = Math.max(0, sourceSize - CODEX_INCREMENTAL_CHECKPOINT_ANCHOR_BYTES);
    const length = sourceSize - anchorStartByte;
    const handle = await fs.promises.open(filePath, "r");
    try {
        const bytes = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(bytes, 0, length, anchorStartByte);
        if (bytesRead !== length) throw new Error("short Codex checkpoint anchor read");
        return {
            anchorStartByte,
            anchorSha256: createHash("sha256").update(bytes).digest("hex"),
        };
    } finally {
        await handle.close();
    }
}

function rebaseCodexRoundTail(rounds: ConversationRound[], roundIndexOffset: number, stepIndexOffset: number): void {
    const stepCollections = ["aiResponses", "toolCalls", "taskBoundaries", "codeActions", "fileViews", "userMessages", "semanticEvents", "attachments"];
    for (const round of rounds) {
        round.roundIndex += roundIndexOffset;
        round.startStep += stepIndexOffset;
        round.endStep += stepIndexOffset;
        for (const collection of stepCollections) {
            for (const item of (round as any)[collection] || []) {
                if (typeof item?.stepIndex === "number") item.stepIndex += stepIndexOffset;
            }
        }
    }
}

function codexTailRebuildRequired(
    reason: NonNullable<CodexRoundTailReadResult["reason"]>,
    startByte: number,
    sourceSize: number,
): CodexRoundTailReadResult {
    return {
        status: "rebuild_required",
        reason,
        replaceFromRound: 1,
        startByte,
        sourceSize,
        roundIndexOffset: 0,
        rounds: [],
        childThreads: [],
        totalSteps: 0,
        sourceCheckpoints: [],
    };
}

export async function readCodexRoundTail(
    rolloutPath: string,
    link: ConversationLinkMode,
    options: CodexRoundTailReadOptions = {},
): Promise<CodexRoundTailReadResult> {
    let before: fs.Stats;
    try {
        before = await fs.promises.stat(rolloutPath);
    } catch {
        return codexTailRebuildRequired("source_unavailable", options.startByte || 0, 0);
    }
    if (!before.isFile()) return codexTailRebuildRequired("source_unavailable", options.startByte || 0, before.size);

    const checkpoint = options.checkpoint;
    if (!checkpoint && (options.startByte || 0) > 0) {
        return codexTailRebuildRequired("checkpoint_required", options.startByte!, before.size);
    }

    const startByte = checkpoint ? checkpoint.replayStartByte : (options.startByte || 0);
    if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > before.size) {
        return codexTailRebuildRequired(checkpoint ? "source_truncated" : "checkpoint_mismatch", startByte, before.size);
    }
    if (checkpoint) {
        if (options.sourceChange === "replace") {
            return codexTailRebuildRequired("source_replaced", startByte, before.size);
        }
        if (options.startByte !== undefined && options.startByte !== checkpoint.replayStartByte) {
            return codexTailRebuildRequired("checkpoint_mismatch", startByte, before.size);
        }
        if (before.size < checkpoint.sourceSize) {
            return codexTailRebuildRequired("source_truncated", startByte, before.size);
        }
        if (before.size === checkpoint.sourceSize && before.mtimeMs !== checkpoint.sourceMtimeMs) {
            return codexTailRebuildRequired("source_replaced", startByte, before.size);
        }
        try {
            const anchor = await codexCheckpointAnchor(rolloutPath, checkpoint.sourceSize);
            if (anchor.anchorStartByte !== checkpoint.anchorStartByte || anchor.anchorSha256 !== checkpoint.anchorSha256) {
                return codexTailRebuildRequired("source_replaced", startByte, before.size);
            }
        } catch {
            return codexTailRebuildRequired("source_unavailable", startByte, before.size);
        }
        if (before.size === checkpoint.sourceSize && before.mtimeMs === checkpoint.sourceMtimeMs) {
            return {
                status: "unchanged",
                replaceFromRound: checkpoint.replaceFromRound,
                startByte,
                sourceSize: before.size,
                roundIndexOffset: checkpoint.replaceFromRound - 1,
                rounds: [],
                childThreads: [],
                totalSteps: 0,
                sourceCheckpoints: [],
                checkpoint,
            };
        }
    }

    const built = await buildCodexRoundsFromRolloutAsync(rolloutPath, link, {
        cwd: options.cwd,
        startByte,
        endByte: before.size,
    });
    let after: fs.Stats;
    try {
        after = await fs.promises.stat(rolloutPath);
    } catch {
        return codexTailRebuildRequired("source_unavailable", startByte, before.size);
    }
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return codexTailRebuildRequired("source_changed_during_read", startByte, after.size);
    }

    const replaceFromRound = checkpoint?.replaceFromRound || 1;
    const roundIndexOffset = replaceFromRound - 1;
    const stepIndexOffset = checkpoint ? checkpoint.replayStartStep - 1 : 0;
    rebaseCodexRoundTail(built.rounds, roundIndexOffset, stepIndexOffset);
    const sourceCheckpoints = built.sourceCheckpoints.map(item => ({ ...item, roundIndex: item.roundIndex + roundIndexOffset }));
    const lastRoundCheckpoint = sourceCheckpoints.filter(item => item.kind === "round_start").at(-1);
    const lastRound = lastRoundCheckpoint
        ? built.rounds.find(round => round.roundIndex === lastRoundCheckpoint.roundIndex)
        : undefined;
    const anchor = await codexCheckpointAnchor(rolloutPath, before.size);
    return {
        status: "ok",
        replaceFromRound,
        startByte,
        sourceSize: before.size,
        roundIndexOffset,
        rounds: built.rounds,
        childThreads: built.childThreads,
        totalSteps: built.totalSteps,
        sourceCheckpoints,
        checkpoint: {
            version: 1,
            sourceSize: before.size,
            sourceMtimeMs: before.mtimeMs,
            anchorStartByte: anchor.anchorStartByte,
            anchorSha256: anchor.anchorSha256,
            replayStartByte: lastRoundCheckpoint?.sourceByte ?? startByte,
            replayStartStep: lastRound?.startStep ?? (stepIndexOffset + 1),
            replaceFromRound: lastRoundCheckpoint?.roundIndex ?? replaceFromRound,
        },
    };
}

async function codexRoundTailCheckpointFromBuild(
    rolloutPath: string,
    built: CodexRoundBuildResult,
): Promise<CodexRoundTailCheckpoint | undefined> {
    const stat = await fs.promises.stat(rolloutPath);
    if (!stat.isFile()) return undefined;
    const lastRoundCheckpoint = built.sourceCheckpoints.filter(item => item.kind === "round_start").at(-1);
    const lastRound = built.lastRound || (lastRoundCheckpoint
        ? built.rounds.find(round => round.roundIndex === lastRoundCheckpoint.roundIndex)
        : undefined);
    const anchor = await codexCheckpointAnchor(rolloutPath, stat.size);
    return {
        version: 1,
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
        anchorStartByte: anchor.anchorStartByte,
        anchorSha256: anchor.anchorSha256,
        replayStartByte: lastRoundCheckpoint?.sourceByte ?? 0,
        replayStartStep: lastRound?.startStep ?? 1,
        replaceFromRound: lastRoundCheckpoint?.roundIndex ?? 1,
    };
}

export function loadCodexConversation(
    conversationId: string,
    link: ConversationLinkMode = "summary",
    depth = 0,
): CodexConversationData | null {
    const thread = getCodexThread(conversationId);
    if (!thread || !thread.rolloutPath) return null;
    const parentThread = getCodexParentThread(thread.id);

    const events = readRolloutEvents(thread.rolloutPath);
    const built = buildCodexRoundsForTest(events, link, { cwd: thread.cwd });
    const edgeChildren = readSpawnChildren(thread.id);
    for (const child of edgeChildren) {
        if (!built.childThreads.find((existing) => existing.threadId === child.threadId)) {
            built.childThreads.push(child);
        }
    }

    const expandedChildren: Array<{ thread: CodexThreadInfo; rounds: ConversationRound[] }> = [];
    const childDiagnostics: CodexChildThreadDiagnostic[] = [];

    if (link === "expand_children" && depth < 1) {
        for (const child of built.childThreads) {
            const childThread = getCodexThread(child.threadId);
            if (!childThread) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "thread_not_found",
                    detail: "子线程不在 Codex 线程索引中，可能已被清理",
                });
                continue;
            }
            if (!childThread.rolloutPath || !fs.existsSync(childThread.rolloutPath)) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "rollout_missing",
                    detail: "子线程索引存在，但 rollout 事件文件不存在",
                });
                continue;
            }
            const childConv = loadCodexConversation(child.threadId, "summary", depth + 1);
            if (!childConv) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "load_failed",
                    detail: "子线程 rollout 存在，但解析失败",
                });
                continue;
            }
            expandedChildren.push({ thread: childThread, rounds: childConv.rounds });
        }
    }

    return {
        thread,
        parentThread,
        rounds: built.rounds,
        totalSteps: events.length,
        childThreads: built.childThreads,
        expandedChildren,
        childDiagnostics,
    };
}

export async function loadCodexConversationAsync(
    conversationId: string,
    link: ConversationLinkMode = "summary",
    depth = 0,
): Promise<CodexConversationData | null> {
    const thread = await getCodexThreadAsync(conversationId);
    if (!thread || !thread.rolloutPath) return null;
    const [parentThread, built, edgeChildren] = await Promise.all([
        getCodexParentThreadAsync(thread.id),
        buildCodexRoundsFromRolloutAsync(thread.rolloutPath, link, { cwd: thread.cwd }),
        readSpawnChildrenAsync(thread.id),
    ]);
    const sourceCheckpoint = await codexRoundTailCheckpointFromBuild(thread.rolloutPath, built);
    for (const child of edgeChildren) {
        if (!built.childThreads.find((existing) => existing.threadId === child.threadId)) {
            built.childThreads.push(child);
        }
    }

    const expandedChildren: Array<{ thread: CodexThreadInfo; rounds: ConversationRound[] }> = [];
    const childDiagnostics: CodexChildThreadDiagnostic[] = [];

    if (link === "expand_children" && depth < 1) {
        for (const [index, child] of built.childThreads.entries()) {
            if (index > 0 && index % CODEX_JSONL_ASYNC_YIELD_INTERVAL === 0) await eventLoopYield();
            const childThread = await getCodexThreadAsync(child.threadId);
            if (!childThread) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "thread_not_found",
                    detail: "子线程不在 Codex 线程索引中，可能已被清理",
                });
                continue;
            }
            if (!childThread.rolloutPath || !await pathExistsAsync(childThread.rolloutPath)) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "rollout_missing",
                    detail: "子线程索引存在，但 rollout 事件文件不存在",
                });
                continue;
            }
            const childConv = await loadCodexConversationAsync(child.threadId, "summary", depth + 1);
            if (!childConv) {
                childDiagnostics.push({
                    threadId: child.threadId,
                    nickname: child.nickname,
                    reason: "load_failed",
                    detail: "子线程 rollout 存在，但解析失败",
                });
                continue;
            }
            expandedChildren.push({ thread: childThread, rounds: childConv.rounds });
        }
    }

    return {
        thread,
        parentThread,
        rounds: built.rounds,
        totalSteps: built.totalSteps,
        childThreads: built.childThreads,
        expandedChildren,
        childDiagnostics,
        sourceCheckpoints: built.sourceCheckpoints,
        sourceCheckpoint,
    };
}

export async function loadCodexConversationToRoundSinkAsync(
    conversationId: string,
    onRound: (round: ConversationRound) => void,
    link: Exclude<ConversationLinkMode, "expand_children"> = "summary",
    control: {
        isCancelled?: () => boolean;
        expectedSource?: CodexSourceVersionExpectation;
    } = {},
): Promise<CodexConversationData | null> {
    const throwIfCancelled = (): void => {
        if (!control.isCancelled?.()) return;
        const error = new Error("Codex conversation read cancelled");
        error.name = "AbortError";
        throw error;
    };
    throwIfCancelled();
    const thread = await getCodexThreadAsync(conversationId);
    if (!thread || !thread.rolloutPath) return null;
    await assertCodexSourceVersion(thread.rolloutPath, control.expectedSource, "before read");
    const [parentThread, built, edgeChildren] = await Promise.all([
        getCodexParentThreadAsync(thread.id),
        buildCodexRoundsFromRolloutAsync(thread.rolloutPath, link, {
            cwd: thread.cwd,
            onRound,
            retainRounds: false,
            isCancelled: control.isCancelled,
        }),
        readSpawnChildrenAsync(thread.id),
    ]);
    throwIfCancelled();
    await assertCodexSourceVersion(thread.rolloutPath, control.expectedSource, "after read");
    const sourceCheckpoint = await codexRoundTailCheckpointFromBuild(thread.rolloutPath, built);
    await assertCodexSourceVersion(thread.rolloutPath, control.expectedSource, "after checkpoint");
    for (const child of edgeChildren) {
        if (!built.childThreads.find((existing) => existing.threadId === child.threadId)) {
            built.childThreads.push(child);
        }
    }
    return {
        thread,
        parentThread,
        rounds: [],
        totalSteps: built.totalSteps,
        childThreads: built.childThreads,
        expandedChildren: [],
        childDiagnostics: [],
        sourceCheckpoints: built.sourceCheckpoints,
        sourceCheckpoint,
    };
}

export interface CodexSourceVersionExpectation {
    sourcePath: string;
    sourceSize: number;
    sourceMtimeMs: number;
}

function canonicalCodexSourcePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function assertCodexSourceVersion(
    rolloutPath: string,
    expected: CodexSourceVersionExpectation | undefined,
    stage: string,
): Promise<void> {
    if (!expected) return;
    const actualPath = canonicalCodexSourcePath(rolloutPath);
    const expectedPath = canonicalCodexSourcePath(expected.sourcePath);
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(rolloutPath);
    } catch {
        throw new Error(`Codex source changed ${stage}; start a fresh fetch`);
    }
    if (
        actualPath !== expectedPath
        || !stat.isFile()
        || stat.size !== expected.sourceSize
        || Math.trunc(stat.mtimeMs) !== Math.trunc(expected.sourceMtimeMs)
    ) {
        throw new Error(`Codex source changed ${stage}; start a fresh fetch`);
    }
}

export interface CodexSourceEvidencePaths {
    stateDbPath?: string;
    rolloutRoots?: string[];
}

export interface CodexSourceEvidenceOptions {
    conversationId: string;
    workspace: {
        workspaceId: string;
        canonicalPath: string | null;
    };
    scanId: string;
    sequence: number;
    cacheBypassed?: boolean;
    enumerationLimit?: number;
    paths?: CodexSourceEvidencePaths;
    now?: () => Date;
}

export interface CodexSourceEnumerationResult {
    evidence: SourceEnumerationEvidence;
    threads: CodexThreadInfo[];
}

export interface CodexSourceExactFetchResult {
    evidence: ExactFetchEvidence;
    thread: CodexThreadInfo | null;
    parentThread: CodexThreadInfo | null;
}

export interface CodexSourceContentMessage {
    role: "user" | "assistant";
    text: string;
    attachments?: ConversationAttachment[];
}

export interface CodexSourceFullReadResult extends CodexSourceExactFetchResult {
    fullSourceRead?: FullSourceReadEvidence;
    sourceSnapshot?: RecordSourceSnapshot;
    sourceMessages?: CodexSourceContentMessage[];
}

export interface CodexSourceEvidenceResult extends CodexSourceFullReadResult {
    enumeration: SourceEnumerationEvidence;
}

interface CodexEvidenceDatabaseResult {
    threads: CodexThreadInfo[];
    parentMap: Map<string, string>;
    errors: SourceEvidenceIssue[];
    limitReached: boolean;
}

interface CodexEvidenceRollout {
    rolloutPath: string;
    conversationId: string | null;
    sessionMeta: Record<string, unknown> | null;
    byteLength: number;
    revisionSequence: number | null;
    contentCursor: string | null;
    contentHash: string;
    roundEnd: number;
    messages: CodexSourceContentMessage[];
    errors: SourceEvidenceIssue[];
}

interface CodexEvidenceScan {
    stateDbPath: string;
    rolloutRoots: string[];
    allowedRolloutRoots: CodexEvidenceRolloutRoot[];
    threads: CodexThreadInfo[];
    parentMap: Map<string, string>;
    rolloutsByPath: Map<string, CodexEvidenceRollout>;
    rolloutsByConversationId: Map<string, CodexEvidenceRollout>;
    errors: SourceEvidenceIssue[];
    pagination: {
        cursor: null;
        pages: number;
        limit: number | null;
        truncated: boolean;
    };
    enumerationComplete: boolean;
}

interface CodexEvidenceRolloutRoot {
    configuredPath: string;
    realPath: string;
}

interface CodexEvidenceExactLookup {
    thread: CodexThreadInfo | null;
    parentThread: CodexThreadInfo | null;
    errors: SourceEvidenceIssue[];
}

interface CodexEvidenceContext {
    scan: CodexEvidenceScan;
    exact: CodexEvidenceExactLookup;
    exactFetchResult: "present" | "not_found" | "unresolved";
    identity: SourceConversationIdentity;
    sourceRevision: SourceRevision;
    observedAt: {
        scanId: string;
        sequence: number;
        startedAt: string;
        completedAt: string;
    };
    cacheBypassed: boolean;
}

interface CodexEvidenceMessages {
    messages: CodexSourceContentMessage[];
    roundEnd: number;
}

interface CodexProjectedEvidenceMessages extends CodexEvidenceMessages {
    messageCount: number;
    contentHash: string;
}

function codexEvidenceSha256(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex")}`;
}

function codexEvidenceIssue(code: SourceEvidenceIssue["code"], message: string): SourceEvidenceIssue {
    return { code, message };
}

function codexEvidenceIoIssue(error: unknown, context: string): SourceEvidenceIssue {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return codexEvidenceIssue(
        code === "EACCES" || code === "EPERM" ? "permission_denied" : "source_unavailable",
        `${context}无法读取`,
    );
}

function dedupeCodexEvidenceIssues(issues: SourceEvidenceIssue[]): SourceEvidenceIssue[] {
    const byKey = new Map<string, SourceEvidenceIssue>();
    for (const issue of issues) byKey.set(`${issue.code}\u0000${issue.message}`, issue);
    return [...byKey.values()].sort((left, right) => left.code === right.code
        ? left.message.localeCompare(right.message, "en")
        : left.code.localeCompare(right.code, "en"));
}

function resolveCodexEvidencePaths(options: CodexSourceEvidenceOptions): { stateDbPath: string; rolloutRoots: string[]; rootsExplicit: boolean } {
    const stateDbPath = path.resolve(options.paths?.stateDbPath || STATE_DB);
    const rootsExplicit = options.paths?.rolloutRoots !== undefined;
    const rolloutRoots = (options.paths?.rolloutRoots || [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR])
        .map(root => path.resolve(root));
    return {
        stateDbPath,
        rolloutRoots: [...new Set(rolloutRoots)],
        rootsExplicit,
    };
}

export function resolveCodexSourceEvidenceIdentity(
    options: Pick<CodexSourceEvidenceOptions, "conversationId" | "workspace" | "paths">,
): SourceConversationIdentity {
    const paths = resolveCodexEvidencePaths(options as CodexSourceEvidenceOptions);
    const authoritativeRoot = paths.rolloutRoots[0] || path.dirname(paths.stateDbPath);
    return {
        workspace: options.workspace,
        source: {
            kind: "hybrid",
            authority: "codex-local-state-db-rollout-jsonl",
            authoritativeRoot,
            canonicalPath: authoritativeRoot,
        },
        conversationId: options.conversationId,
    };
}

function codexEvidencePathIsWithinRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (
        relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
}

async function resolveCodexEvidenceRolloutRoots(
    rolloutRoots: string[],
    rootsExplicit: boolean,
    issues: SourceEvidenceIssue[],
): Promise<CodexEvidenceRolloutRoot[]> {
    const allowedRoots: CodexEvidenceRolloutRoot[] = [];
    if (rootsExplicit && rolloutRoots.length === 0) {
        issues.push(codexEvidenceIssue("source_unavailable", "Codex rollout 未配置允许根目录"));
    }
    for (const configuredPath of rolloutRoots) {
        try {
            const stat = await fs.promises.stat(configuredPath);
            if (!stat.isDirectory()) {
                if (rootsExplicit) issues.push(codexEvidenceIssue("source_unavailable", "Codex rollout 根路径不是目录"));
                continue;
            }
            const realPath = await fs.promises.realpath(configuredPath);
            if (!allowedRoots.some(root => root.configuredPath === configuredPath && root.realPath === realPath)) {
                allowedRoots.push({ configuredPath, realPath });
            }
        } catch (error) {
            if (rootsExplicit) issues.push(codexEvidenceIoIssue(error, "Codex rollout 根目录"));
        }
    }
    return allowedRoots;
}

async function authorizeCodexEvidenceRolloutPath(
    rolloutPath: string,
    allowedRoots: CodexEvidenceRolloutRoot[],
): Promise<{ rolloutPath: string | null; errors: SourceEvidenceIssue[] }> {
    const resolvedPath = path.resolve(rolloutPath);
    const lexicalRoots = allowedRoots.filter(root => codexEvidencePathIsWithinRoot(root.configuredPath, resolvedPath));
    if (lexicalRoots.length === 0) {
        return {
            rolloutPath: null,
            errors: [codexEvidenceIssue("source_unavailable", "Codex state SQLite rollout 路径不在配置的允许根目录内")],
        };
    }
    let realPath: string;
    try {
        realPath = await fs.promises.realpath(resolvedPath);
    } catch (error) {
        return {
            rolloutPath: null,
            errors: [codexEvidenceIoIssue(error, "Codex state SQLite rollout 文件")],
        };
    }
    if (!lexicalRoots.some(root => codexEvidencePathIsWithinRoot(root.realPath, realPath))) {
        return {
            rolloutPath: null,
            errors: [codexEvidenceIssue("source_unavailable", "Codex state SQLite rollout 实路径越出配置的允许根目录")],
        };
    }
    try {
        const stat = await fs.promises.stat(realPath);
        if (!stat.isFile()) {
            return {
                rolloutPath: null,
                errors: [codexEvidenceIssue("source_unavailable", "Codex state SQLite rollout 路径不是文件")],
            };
        }
    } catch (error) {
        return {
            rolloutPath: null,
            errors: [codexEvidenceIoIssue(error, "Codex state SQLite rollout 文件")],
        };
    }
    return { rolloutPath: realPath, errors: [] };
}

async function authorizeCodexEvidenceThread(
    thread: CodexThreadInfo | null,
    allowedRoots: CodexEvidenceRolloutRoot[],
): Promise<{ thread: CodexThreadInfo | null; errors: SourceEvidenceIssue[] }> {
    if (!thread) return { thread: null, errors: [] };
    const authorizedPath = await authorizeCodexEvidenceRolloutPath(thread.rolloutPath, allowedRoots);
    return {
        thread: authorizedPath.rolloutPath ? { ...thread, rolloutPath: authorizedPath.rolloutPath } : null,
        errors: authorizedPath.errors,
    };
}

function codexEvidenceThreadFromRow(row: unknown, parentMap: Map<string, string>): CodexThreadInfo | null {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const fields = row as Record<string, unknown>;
    const id = typeof fields.id === "string" ? fields.id : "";
    const rolloutPath = typeof fields.rollout_path === "string" ? fields.rollout_path : "";
    if (!id || !rolloutPath) return null;
    const updatedAtMs = typeof fields.updated_at_ms === "number" && Number.isFinite(fields.updated_at_ms)
        ? fields.updated_at_ms
        : null;
    return applyCodexThreadRelations({
        id,
        rolloutPath,
        cwd: typeof fields.cwd === "string" ? fields.cwd : "",
        title: typeof fields.title === "string" ? fields.title : "",
        sqliteTitle: typeof fields.title === "string" ? fields.title : "",
        titleSource: "sqlite",
        source: typeof fields.source === "string" && fields.source.trim() ? fields.source : "sqlite",
        model: typeof fields.model === "string" ? fields.model : null,
        reasoningEffort: typeof fields.reasoning_effort === "string" ? fields.reasoning_effort : null,
        agentNickname: typeof fields.agent_nickname === "string" ? fields.agent_nickname : null,
        agentRole: typeof fields.agent_role === "string" ? fields.agent_role : null,
        updatedAtMs,
    }, parentMap);
}

async function readCodexEvidenceDatabase(
    stateDbPath: string,
    enumerationLimit: number | undefined,
): Promise<CodexEvidenceDatabaseResult> {
    try {
        await fs.promises.stat(stateDbPath);
    } catch (error) {
        return {
            threads: [],
            parentMap: new Map(),
            errors: [codexEvidenceIoIssue(error, "Codex state SQLite")],
            limitReached: false,
        };
    }
    const requestedLimit = enumerationLimit && enumerationLimit > 0 ? Math.floor(enumerationLimit) : null;
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
limit = int(sys.argv[2])
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
exists = conn.execute("select name from sqlite_master where type='table' and name='threads'").fetchone()
if not exists:
    raise RuntimeError("threads table is missing")
query = "select id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms from threads order by updated_at_ms desc"
if limit >= 0:
    query += " limit ?"
    thread_rows = conn.execute(query, (limit + 1,)).fetchall()
else:
    thread_rows = conn.execute(query).fetchall()
edge_exists = conn.execute("select name from sqlite_master where type='table' and name='thread_spawn_edges'").fetchone()
edge_rows = conn.execute("select child_thread_id, parent_thread_id from thread_spawn_edges").fetchall() if edge_exists else []
print(json.dumps({"threads": [dict(row) for row in thread_rows], "edges": [{"child": row[0], "parent": row[1]} for row in edge_rows if row[0] and row[1]]}, ensure_ascii=False))
`;
    try {
        const data = await execPythonJsonAsync(script, [stateDbPath, String(requestedLimit ?? -1)]) as unknown;
        const fields = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
        const rawEdges = Array.isArray(fields.edges) ? fields.edges : [];
        const parentMap = new Map<string, string>();
        for (const edge of rawEdges) {
            if (!edge || typeof edge !== "object" || Array.isArray(edge)) continue;
            const edgeFields = edge as Record<string, unknown>;
            if (typeof edgeFields.child === "string" && typeof edgeFields.parent === "string") {
                parentMap.set(edgeFields.child, edgeFields.parent);
            }
        }
        const rawThreads = Array.isArray(fields.threads) ? fields.threads : [];
        const limitReached = requestedLimit !== null && rawThreads.length > requestedLimit;
        const errors: SourceEvidenceIssue[] = [];
        const threads: CodexThreadInfo[] = [];
        for (const row of rawThreads.slice(0, requestedLimit ?? rawThreads.length)) {
            const thread = codexEvidenceThreadFromRow(row, parentMap);
            if (thread) {
                threads.push(thread);
            } else {
                errors.push(codexEvidenceIssue("parse_error", "Codex state SQLite thread 记录缺少 id 或 rollout 路径"));
            }
        }
        return { threads, parentMap, errors, limitReached };
    } catch (error) {
        return {
            threads: [],
            parentMap: new Map(),
            errors: [codexEvidenceIoIssue(error, "Codex state SQLite")],
            limitReached: false,
        };
    }
}

async function readCodexEvidenceExactThread(
    stateDbPath: string,
    conversationId: string,
    allowedRoots: CodexEvidenceRolloutRoot[],
): Promise<CodexEvidenceExactLookup> {
    try {
        await fs.promises.stat(stateDbPath);
    } catch (error) {
        return {
            thread: null,
            parentThread: null,
            errors: [codexEvidenceIoIssue(error, "Codex state SQLite")],
        };
    }
    const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
thread_id = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
exists = conn.execute("select name from sqlite_master where type='table' and name='threads'").fetchone()
if not exists:
    raise RuntimeError("threads table is missing")
columns = "id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms"
thread = conn.execute(f"select {columns} from threads where id = ? limit 1", (thread_id,)).fetchone()
edge_exists = conn.execute("select name from sqlite_master where type='table' and name='thread_spawn_edges'").fetchone()
edges = conn.execute("select child_thread_id, parent_thread_id from thread_spawn_edges").fetchall() if edge_exists else []
parent = None
if edge_exists:
    parent = conn.execute(f"select t.{columns.replace(', ', ', t.')} from thread_spawn_edges e join threads t on t.id = e.parent_thread_id where e.child_thread_id = ? limit 1", (thread_id,)).fetchone()
print(json.dumps({"thread": dict(thread) if thread else None, "parent": dict(parent) if parent else None, "edges": [{"child": row[0], "parent": row[1]} for row in edges if row[0] and row[1]]}, ensure_ascii=False))
`;
    try {
        const data = await execPythonJsonAsync(script, [stateDbPath, conversationId]) as unknown;
        const fields = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
        const parentMap = new Map<string, string>();
        const rawEdges = Array.isArray(fields.edges) ? fields.edges : [];
        for (const edge of rawEdges) {
            if (!edge || typeof edge !== "object" || Array.isArray(edge)) continue;
            const edgeFields = edge as Record<string, unknown>;
            if (typeof edgeFields.child === "string" && typeof edgeFields.parent === "string") {
                parentMap.set(edgeFields.child, edgeFields.parent);
            }
        }
        const [thread, parentThread] = await Promise.all([
            authorizeCodexEvidenceThread(codexEvidenceThreadFromRow(fields.thread, parentMap), allowedRoots),
            authorizeCodexEvidenceThread(codexEvidenceThreadFromRow(fields.parent, parentMap), allowedRoots),
        ]);
        return {
            thread: thread.thread,
            parentThread: parentThread.thread,
            errors: dedupeCodexEvidenceIssues([...thread.errors, ...parentThread.errors]),
        };
    } catch (error) {
        return {
            thread: null,
            parentThread: null,
            errors: [codexEvidenceIoIssue(error, "Codex exact SQLite 查询")],
        };
    }
}

function codexEvidenceMessageMirrorId(event: unknown, payload: Record<string, unknown>): string | null {
    const eventFields = event && typeof event === "object" && !Array.isArray(event)
        ? event as Record<string, unknown>
        : {};
    for (const candidate of [
        payload.message_id,
        payload.messageId,
        payload.item_id,
        payload.itemId,
        payload.id,
        eventFields.message_id,
        eventFields.messageId,
        eventFields.item_id,
        eventFields.itemId,
    ]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return null;
}

function codexEvidenceToolOnlyContent(content: unknown[]): boolean {
    if (content.length === 0) return false;
    const toolOnlyTypes = new Set([
        "function_call",
        "function_call_output",
        "tool_result",
        "custom_tool_call",
        "custom_tool_call_output",
        "computer_call",
        "computer_call_output",
    ]);
    return content.every((item) => item && typeof item === "object" && toolOnlyTypes.has(String((item as Record<string, unknown>).type || "")));
}

function mergeCodexEvidenceAttachments(
    current: ConversationAttachment[] | undefined,
    incoming: ConversationAttachment[],
): ConversationAttachment[] | undefined {
    if (incoming.length === 0) return current;
    const merged = [...(current || [])];
    const keys = new Set(merged.map(attachment => `${attachment.kind}\u0000${attachment.source}\u0000${attachment.sha256 || attachment.dataUrl || attachment.originalPath || attachment.name || ""}`));
    for (const attachment of incoming) {
        const key = `${attachment.kind}\u0000${attachment.source}\u0000${attachment.sha256 || attachment.dataUrl || attachment.originalPath || attachment.name || ""}`;
        if (keys.has(key)) continue;
        keys.add(key);
        merged.push(attachment);
    }
    return merged.length > 0 ? merged : undefined;
}

function codexEvidenceAttachments(attachments: ConversationAttachment[]): ConversationAttachment[] {
    return attachments.map(attachment => Object.fromEntries(
        Object.entries(attachment).filter(([, value]) => value !== undefined),
    ) as ConversationAttachment);
}

function collectCodexEvidenceMessagesLegacy(events: unknown[]): CodexEvidenceMessages {
    const messages: CodexSourceContentMessage[] = [];
    const sourceIndexesByMirrorId = new Map<string, number[]>();
    const mirrorIdOccurrences = new Map<string, number>();
    const ambiguousMirrorIds = new Set<string>();
    let roundEnd = 0;
    const add = (
        role: "user" | "assistant",
        rawText: string,
        attachments: ConversationAttachment[],
        source: "response_item" | "event_msg",
        mirrorId: string | null,
    ) => {
        const text = rawText.normalize("NFC");
        const sourceMirrorKey = mirrorId ? `${source}\u0000${role}\u0000${mirrorId}` : null;
        const mirrorIdentity = mirrorId ? `${role}\u0000${mirrorId}` : null;
        if (sourceMirrorKey && mirrorIdentity) {
            const occurrenceCount = (mirrorIdOccurrences.get(sourceMirrorKey) || 0) + 1;
            mirrorIdOccurrences.set(sourceMirrorKey, occurrenceCount);
            if (occurrenceCount > 1) ambiguousMirrorIds.add(mirrorIdentity);
        }
        const counterpartMirrorKey = mirrorId ? `${source === "response_item" ? "event_msg" : "response_item"}\u0000${role}\u0000${mirrorId}` : null;
        const mirroredIndexes = counterpartMirrorKey === null ? [] : sourceIndexesByMirrorId.get(counterpartMirrorKey) || [];
        if (mirrorIdentity && !ambiguousMirrorIds.has(mirrorIdentity) && mirroredIndexes.length === 1) {
            const mirrored = messages[mirroredIndexes[0]];
            if (mirrored && mirrored.text === text) {
                mirrored.attachments = mergeCodexEvidenceAttachments(mirrored.attachments, attachments);
                sourceIndexesByMirrorId.delete(counterpartMirrorKey!);
                return;
            }
        }
        if (role === "user") roundEnd += 1;
        if (role === "assistant" && roundEnd === 0) roundEnd = 1;
        messages.push({ role, text, ...(attachments.length > 0 ? { attachments } : {}) });
        if (sourceMirrorKey) {
            const indexes = sourceIndexesByMirrorId.get(sourceMirrorKey) || [];
            indexes.push(messages.length - 1);
            sourceIndexesByMirrorId.set(sourceMirrorKey, indexes);
        }
    };
    for (const event of events) {
        const payload = event && typeof event === "object" && !Array.isArray(event)
            ? (event as Record<string, unknown>).payload
            : undefined;
        const eventType = event && typeof event === "object" && !Array.isArray(event)
            ? (event as Record<string, unknown>).type
            : undefined;
        const payloadFields = payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : {};
        if (eventType === "response_item" && payloadFields.type === "message") {
            const role = payloadFields.role === "user" || payloadFields.role === "assistant" ? payloadFields.role : null;
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            const text = extractText(content);
            const attachments = codexEvidenceAttachments(extractCodexMessageAttachments(content, text));
            if (role && !codexEvidenceToolOnlyContent(content)) {
                add(role, text, attachments, "response_item", codexEvidenceMessageMirrorId(event, payloadFields));
            }
            continue;
        }
        if (eventType === "event_msg" && payloadFields.type === "user_message") {
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            if (!codexEvidenceToolOnlyContent(content)) {
                add(
                    "user",
                    extractEventMessageText(payloadFields),
                    codexEvidenceAttachments(extractCodexEventUserAttachments(payloadFields)),
                    "event_msg",
                    codexEvidenceMessageMirrorId(event, payloadFields),
                );
            }
            continue;
        }
        if (eventType === "event_msg" && payloadFields.type === "agent_message") {
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            if (!codexEvidenceToolOnlyContent(content)) {
                add(
                    "assistant",
                    extractEventMessageText(payloadFields),
                    [],
                    "event_msg",
                    codexEvidenceMessageMirrorId(event, payloadFields),
                );
            }
        }
    }
    return { messages, roundEnd: Math.max(roundEnd, 1) };
}

class CodexEvidenceRoundProjector {
    private readonly messages: CodexSourceContentMessage[] = [];
    private readonly contentHash = createHash("sha256").update('{"messages":[', "utf8");
    private readonly retainMessages: boolean;
    private messageCount = 0;
    private roundEnd = 0;

    constructor(options: { retainMessages?: boolean } = {}) {
        this.retainMessages = options.retainMessages !== false;
    }

    private addProjectedMessage(message: CodexSourceContentMessage): void {
        if (this.messageCount > 0) this.contentHash.update(",", "utf8");
        this.contentHash.update(canonicalSerialize(message), "utf8");
        this.messageCount += 1;
        if (this.retainMessages) this.messages.push(message);
    }

    addRound(round: ConversationRound): void {
        const ordered: Array<{ stepIndex: number; sequence: number; message: CodexSourceContentMessage }> = [];
        let sequence = 0;
        const userMessages = round.userMessages?.length
            ? round.userMessages
            : round.userMessage && round.userMessage !== "(无显式用户消息)"
                ? [{ stepIndex: round.startStep, text: round.userMessage, attachments: round.attachments }]
                : [];
        if (userMessages.length > 0) this.roundEnd += 1;
        for (const message of userMessages) {
            ordered.push({
                stepIndex: message.stepIndex ?? round.startStep,
                sequence: sequence += 1,
                message: {
                    role: "user",
                    text: message.text.normalize("NFC"),
                    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
                },
            });
        }
        for (const response of round.aiResponses) {
            if (!response.response.trim()) continue;
            ordered.push({
                stepIndex: response.stepIndex,
                sequence: sequence += 1,
                message: { role: "assistant", text: response.response.normalize("NFC") },
            });
        }
        for (const event of round.semanticEvents || []) {
            if (event.semanticRole !== "subagent" || !event.text?.trim()) continue;
            const parsed = codexSubagentNotificationSummary(event.text);
            const shortId = parsed.threadId ? parsed.threadId.slice(0, 8) : "unknown";
            const label = `Subagent-${parsed.nickname || "subagent"} (${shortId})`;
            const detail = parsed.summary || event.text;
            ordered.push({
                stepIndex: event.stepIndex ?? round.endStep,
                sequence: sequence += 1,
                message: {
                    role: "assistant",
                    text: `${label}\n${detail}`.normalize("NFC"),
                    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                },
            });
        }
        ordered.sort((left, right) => left.stepIndex - right.stepIndex || left.sequence - right.sequence);
        for (const entry of ordered) this.addProjectedMessage(entry.message);
    }

    finish(): CodexProjectedEvidenceMessages {
        const digest = this.contentHash.copy().update("]}", "utf8").digest("hex");
        return {
            messages: this.messages,
            messageCount: this.messageCount,
            contentHash: `sha256:${digest}`,
            roundEnd: Math.max(this.roundEnd, 1),
        };
    }
}

export interface CodexSourceRevisionAccumulator {
    addRound(round: ConversationRound): void;
    finish(sequence?: number | null): SourceRevision;
}

export function createCodexSourceRevisionAccumulator(): CodexSourceRevisionAccumulator {
    const projector = new CodexEvidenceRoundProjector({ retainMessages: false });
    return {
        addRound(round): void {
            projector.addRound(round);
        },
        finish(sequence = null): SourceRevision {
            const content = projector.finish();
            const contentCursor = content.messageCount > 0 ? content.contentHash : null;
            const revision = content.contentHash;
            return {
                revision,
                contentCursor,
                eventWatermark: contentCursor,
                sequence: Number.isSafeInteger(sequence) && (sequence ?? -1) >= 0 ? sequence! : null,
            };
        },
    };
}

export function codexSourceRevisionFromRounds(
    rounds: Iterable<ConversationRound>,
    sequence: number | null = null,
): SourceRevision {
    const accumulator = createCodexSourceRevisionAccumulator();
    for (const round of rounds) accumulator.addRound(round);
    return accumulator.finish(sequence);
}

class CodexEvidenceMessageCollector {
    private readonly messages: CodexSourceContentMessage[] = [];
    private readonly sourceIndexesByMirrorId = new Map<string, number[]>();
    private readonly mirrorIdOccurrences = new Map<string, number>();
    private readonly ambiguousMirrorIds = new Set<string>();
    private roundEnd = 0;

    private add(
        role: "user" | "assistant",
        rawText: string,
        attachments: ConversationAttachment[],
        source: "response_item" | "event_msg",
        mirrorId: string | null,
    ): void {
        const text = rawText.normalize("NFC");
        const sourceMirrorKey = mirrorId ? [source, role, mirrorId].join("\u0000") : null;
        const mirrorIdentity = mirrorId ? [role, mirrorId].join("\u0000") : null;
        if (sourceMirrorKey && mirrorIdentity) {
            const occurrenceCount = (this.mirrorIdOccurrences.get(sourceMirrorKey) || 0) + 1;
            this.mirrorIdOccurrences.set(sourceMirrorKey, occurrenceCount);
            if (occurrenceCount > 1) this.ambiguousMirrorIds.add(mirrorIdentity);
        }
        const counterpartSource = source === "response_item" ? "event_msg" : "response_item";
        const counterpartMirrorKey = mirrorId ? [counterpartSource, role, mirrorId].join("\u0000") : null;
        const mirroredIndexes = counterpartMirrorKey === null ? [] : this.sourceIndexesByMirrorId.get(counterpartMirrorKey) || [];
        if (mirrorIdentity && !this.ambiguousMirrorIds.has(mirrorIdentity) && mirroredIndexes.length === 1) {
            const mirrored = this.messages[mirroredIndexes[0]];
            if (mirrored && mirrored.text === text) {
                const mergedAttachments = mergeCodexEvidenceAttachments(mirrored.attachments, attachments);
                if (mergedAttachments) {
                    mirrored.attachments = mergedAttachments;
                } else {
                    delete mirrored.attachments;
                }
                this.sourceIndexesByMirrorId.delete(counterpartMirrorKey!);
                return;
            }
        }
        if (role === "user") this.roundEnd += 1;
        if (role === "assistant" && this.roundEnd === 0) this.roundEnd = 1;
        this.messages.push({ role, text, ...(attachments.length > 0 ? { attachments } : {}) });
        if (sourceMirrorKey) {
            const indexes = this.sourceIndexesByMirrorId.get(sourceMirrorKey) || [];
            indexes.push(this.messages.length - 1);
            this.sourceIndexesByMirrorId.set(sourceMirrorKey, indexes);
        }
    }

    addEvent(event: unknown): void {
        const eventFields = event && typeof event === "object" && !Array.isArray(event)
            ? event as Record<string, unknown>
            : {};
        const payloadFields = eventFields.payload && typeof eventFields.payload === "object" && !Array.isArray(eventFields.payload)
            ? eventFields.payload as Record<string, unknown>
            : {};
        if (eventFields.type === "response_item" && payloadFields.type === "message") {
            const role = payloadFields.role === "user" || payloadFields.role === "assistant" ? payloadFields.role : null;
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            const text = extractText(content);
            if (role && !codexEvidenceToolOnlyContent(content)) {
                this.add(
                    role,
                    text,
                    codexEvidenceAttachments(extractCodexMessageAttachments(content, text)),
                    "response_item",
                    codexEvidenceMessageMirrorId(event, payloadFields),
                );
            }
            return;
        }
        if (eventFields.type === "event_msg" && payloadFields.type === "user_message") {
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            if (!codexEvidenceToolOnlyContent(content)) {
                this.add(
                    "user",
                    extractEventMessageText(payloadFields),
                    codexEvidenceAttachments(extractCodexEventUserAttachments(payloadFields)),
                    "event_msg",
                    codexEvidenceMessageMirrorId(event, payloadFields),
                );
            }
            return;
        }
        if (eventFields.type === "event_msg" && payloadFields.type === "agent_message") {
            const content = Array.isArray(payloadFields.content) ? payloadFields.content : [];
            if (!codexEvidenceToolOnlyContent(content)) {
                this.add(
                    "assistant",
                    extractEventMessageText(payloadFields),
                    [],
                    "event_msg",
                    codexEvidenceMessageMirrorId(event, payloadFields),
                );
            }
        }
    }

    finish(): CodexEvidenceMessages {
        return { messages: this.messages, roundEnd: Math.max(this.roundEnd, 1) };
    }
}

function collectCodexEvidenceMessages(events: unknown[]): CodexEvidenceMessages {
    const projector = new CodexEvidenceRoundProjector();
    const collector = new CodexRoundEventCollector("reference", {
        retainRounds: false,
        onRound: round => projector.addRound(round),
    });
    for (const event of events) collector.addEvent(event);
    collector.finish();
    return projector.finish();
}

export function collectCodexEvidenceMessagesForTest(
    events: unknown[],
): { messages: CodexSourceContentMessage[]; roundEnd: number } {
    return collectCodexEvidenceMessages(events);
}

function codexEvidenceRolloutId(filePath: string, sessionMeta: Record<string, unknown> | null): string | null {
    if (typeof sessionMeta?.id === "string" && sessionMeta.id.trim()) return sessionMeta.id;
    return path.basename(filePath).match(CODEX_ROLLOUT_ID_RE)?.[1] || null;
}

async function readCodexEvidenceRollout(rolloutPath: string): Promise<CodexEvidenceRollout> {
    const errors: SourceEvidenceIssue[] = [];
    const projector = new CodexEvidenceRoundProjector();
    const collector = new CodexRoundEventCollector("reference", {
        retainRounds: false,
        onRound: round => projector.addRound(round),
    });
    let sessionMeta: Record<string, unknown> | null = null;
    let sawSessionMeta = false;
    let byteLength = 0;
    let revisionSequence: number | null = null;
    let before: fs.Stats | null = null;
    try {
        before = await fs.promises.stat(rolloutPath);
        byteLength = before.size;
        revisionSequence = Number.isFinite(before.mtimeMs) && before.mtimeMs >= 0
            ? Math.floor(before.mtimeMs)
            : null;
    } catch (error) {
        return {
            rolloutPath,
            conversationId: null,
            sessionMeta: null,
            byteLength,
            revisionSequence,
            contentCursor: null,
            contentHash: codexEvidenceSha256({ messages: [] }),
            roundEnd: 1,
            messages: [],
            errors: [codexEvidenceIoIssue(error, "Codex rollout 文件")],
        };
    }
    let lineNumber = 0;
    try {
        await forEachCodexJsonlLineAsync(
            rolloutPath,
            (line) => {
                lineNumber += 1;
                try {
                    const event = JSON.parse(line) as unknown;
                    const eventFields = event && typeof event === "object" && !Array.isArray(event)
                        ? event as Record<string, unknown>
                        : {};
                    if (!sawSessionMeta && eventFields.type === "session_meta") {
                        sawSessionMeta = true;
                        const payload = eventFields.payload;
                        sessionMeta = payload && typeof payload === "object" && !Array.isArray(payload)
                            ? payload as Record<string, unknown>
                            : null;
                    }
                    collector.addEvent(sanitizeCodexEvent(event));
                } catch {
                    errors.push(codexEvidenceIssue("parse_error", `Codex rollout 第 ${lineNumber} 个非空 JSONL 行无法解析`));
                }
            },
            {
                onOversizedLine: () => {
                    errors.push(codexEvidenceIssue("limit_reached", "Codex rollout 存在超过安全上限的 JSONL 行"));
                },
            },
        );
    } catch (error) {
        errors.push(codexEvidenceIoIssue(error, "Codex rollout 文件"));
    }
    try {
        const after = await fs.promises.stat(rolloutPath);
        if (!before || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            errors.push(codexEvidenceIssue("revision_drift", "Codex rollout 在扫描期间发生变化"));
        }
    } catch (error) {
        errors.push(codexEvidenceIoIssue(error, "Codex rollout 文件"));
    }
    collector.finish();
    const content = projector.finish();
    const contentHash = content.contentHash;
    return {
        rolloutPath,
        conversationId: codexEvidenceRolloutId(rolloutPath, sessionMeta),
        sessionMeta,
        byteLength,
        revisionSequence,
        contentCursor: content.messages.length > 0 ? contentHash : null,
        contentHash,
        roundEnd: content.roundEnd,
        messages: content.messages,
        errors: dedupeCodexEvidenceIssues(errors),
    };
}

export async function readCodexEvidenceRolloutForTest(rolloutPath: string): Promise<{
    conversationId: string | null;
    sessionMeta: Record<string, unknown> | null;
    contentHash: string;
    roundEnd: number;
    messages: CodexSourceContentMessage[];
    errors: SourceEvidenceIssue[];
}> {
    const rollout = await readCodexEvidenceRollout(rolloutPath);
    return {
        conversationId: rollout.conversationId,
        sessionMeta: rollout.sessionMeta,
        contentHash: rollout.contentHash,
        roundEnd: rollout.roundEnd,
        messages: rollout.messages,
        errors: rollout.errors,
    };
}

async function listCodexEvidenceRolloutPaths(
    root: string,
    issues: SourceEvidenceIssue[],
): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
            issues.push(codexEvidenceIoIssue(error, "Codex rollout 目录"));
            return;
        }
        for (const entry of entries) {
            const targetPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(targetPath);
            } else if (entry.isFile() && CODEX_ROLLOUT_ID_RE.test(entry.name)) {
                files.push(targetPath);
            }
        }
    };
    await visit(root);
    return files;
}

function codexEvidenceThreadFromRollout(rollout: CodexEvidenceRollout, parentMap: Map<string, string>): CodexThreadInfo | null {
    if (!rollout.conversationId) return null;
    const meta = rollout.sessionMeta || {};
    return applyCodexThreadRelations({
        id: rollout.conversationId,
        rolloutPath: rollout.rolloutPath,
        cwd: typeof meta.cwd === "string" ? meta.cwd : "",
        title: typeof meta.title === "string" ? meta.title : "",
        titleSource: typeof meta.title === "string" ? "session_meta" : "rollout",
        source: typeof meta.source === "string" && meta.source.trim()
            ? meta.source
            : typeof meta.originator === "string" && meta.originator.trim()
                ? meta.originator
                : "rollout",
        model: typeof meta.model === "string" ? meta.model : null,
        reasoningEffort: typeof meta.reasoning_effort === "string" ? meta.reasoning_effort : null,
        agentNickname: null,
        agentRole: null,
        updatedAtMs: null,
    }, parentMap);
}

async function scanCodexSourceEvidence(options: CodexSourceEvidenceOptions): Promise<CodexEvidenceScan> {
    const paths = resolveCodexEvidencePaths(options);
    const database = await readCodexEvidenceDatabase(paths.stateDbPath, options.enumerationLimit);
    const issues = [...database.errors];
    const allowedRolloutRoots = await resolveCodexEvidenceRolloutRoots(paths.rolloutRoots, paths.rootsExplicit, issues);
    const rolloutPaths = new Set<string>();
    for (const root of allowedRolloutRoots) {
        for (const rolloutPath of await listCodexEvidenceRolloutPaths(root.configuredPath, issues)) {
            const authorizedPath = await authorizeCodexEvidenceRolloutPath(rolloutPath, allowedRolloutRoots);
            issues.push(...authorizedPath.errors);
            if (authorizedPath.rolloutPath) rolloutPaths.add(authorizedPath.rolloutPath);
        }
    }
    const threads: CodexThreadInfo[] = [];
    for (const thread of database.threads) {
        const authorizedThread = await authorizeCodexEvidenceThread(thread, allowedRolloutRoots);
        issues.push(...authorizedThread.errors);
        if (authorizedThread.thread) {
            threads.push(authorizedThread.thread);
            rolloutPaths.add(authorizedThread.thread.rolloutPath);
        }
    }
    const sortedRolloutPaths = [...rolloutPaths].sort((left, right) => left.localeCompare(right, "en"));
    const requestedLimit = options.enumerationLimit && options.enumerationLimit > 0 ? Math.floor(options.enumerationLimit) : null;
    const rolloutLimitReached = requestedLimit !== null && sortedRolloutPaths.length > requestedLimit;
    if (database.limitReached || rolloutLimitReached) {
        issues.push(codexEvidenceIssue("limit_reached", "Codex rollout 枚举达到调用方限制"));
    }
    const selectedPaths = requestedLimit === null ? sortedRolloutPaths : sortedRolloutPaths.slice(0, requestedLimit);
    const rolloutsByPath = new Map<string, CodexEvidenceRollout>();
    const rolloutsByConversationId = new Map<string, CodexEvidenceRollout>();
    for (const rolloutPath of selectedPaths) {
        const rollout = await readCodexEvidenceRollout(rolloutPath);
        rolloutsByPath.set(path.resolve(rolloutPath), rollout);
        if (rollout.conversationId) rolloutsByConversationId.set(rollout.conversationId, rollout);
        issues.push(...rollout.errors);
    }
    for (const rollout of rolloutsByPath.values()) {
        const fallbackThread = codexEvidenceThreadFromRollout(rollout, database.parentMap);
        if (fallbackThread && !threads.some(thread => thread.id === fallbackThread.id)) threads.push(fallbackThread);
    }
    const complete = issues.length === 0 && !database.limitReached && !rolloutLimitReached;
    return {
        stateDbPath: paths.stateDbPath,
        rolloutRoots: paths.rolloutRoots,
        allowedRolloutRoots,
        threads,
        parentMap: database.parentMap,
        rolloutsByPath,
        rolloutsByConversationId,
        errors: dedupeCodexEvidenceIssues(issues),
        pagination: {
            cursor: null,
            pages: complete || threads.length > 0 ? 1 : 0,
            limit: requestedLimit,
            truncated: database.limitReached || rolloutLimitReached,
        },
        enumerationComplete: complete,
    };
}

function codexEvidenceRevision(
    scan: CodexEvidenceScan,
    conversationId: string,
    thread: CodexThreadInfo | null,
): SourceRevision {
    const targetRollout = thread
        ? scan.rolloutsByPath.get(path.resolve(thread.rolloutPath)) || scan.rolloutsByConversationId.get(conversationId)
        : scan.rolloutsByConversationId.get(conversationId);
    if (targetRollout) {
        const contentCursor = targetRollout.contentCursor;
        const revision = contentCursor || codexEvidenceSha256({ conversationId, emptyContent: true });
        return { revision, contentCursor, eventWatermark: contentCursor, sequence: targetRollout.revisionSequence };
    }
    const watermark = codexEvidenceSha256({
        conversationId,
        rollouts: [...scan.rolloutsByConversationId.values()]
            .map(rollout => ({ conversationId: rollout.conversationId, contentCursor: rollout.contentCursor }))
            .sort((left, right) => String(left.conversationId).localeCompare(String(right.conversationId), "en")),
    });
    return { revision: watermark, contentCursor: null, eventWatermark: watermark };
}

function codexEvidenceIdentity(options: CodexSourceEvidenceOptions, _scan: CodexEvidenceScan): SourceConversationIdentity {
    return resolveCodexSourceEvidenceIdentity(options);
}

async function collectCodexEvidenceContext(options: CodexSourceEvidenceOptions): Promise<CodexEvidenceContext> {
    const startedAt = (options.now || (() => new Date()))().toISOString();
    const scan = await scanCodexSourceEvidence(options);
    const directExact = await readCodexEvidenceExactThread(
        scan.stateDbPath,
        options.conversationId,
        scan.allowedRolloutRoots,
    );
    const fallbackThread = scan.threads.find(thread => thread.id === options.conversationId)
        || codexEvidenceThreadFromRollout(scan.rolloutsByConversationId.get(options.conversationId) || {
            rolloutPath: "",
            conversationId: null,
            sessionMeta: null,
            byteLength: 0,
            revisionSequence: null,
            contentCursor: null,
            contentHash: codexEvidenceSha256({ messages: [] }),
            roundEnd: 1,
            messages: [],
            errors: [],
        }, scan.parentMap);
    const thread = directExact.thread || fallbackThread || null;
    const parentThread = directExact.parentThread || (thread?.parentConversationId
        ? scan.threads.find(candidate => candidate.id === thread.parentConversationId) || null
        : null);
    const errors = dedupeCodexEvidenceIssues([...scan.errors, ...directExact.errors]);
    const exactFetchResult = thread
        ? "present"
        : errors.length > 0 || !scan.enumerationComplete
            ? "unresolved"
            : "not_found";
    return {
        scan,
        exact: { thread, parentThread, errors },
        exactFetchResult,
        identity: codexEvidenceIdentity(options, scan),
        sourceRevision: codexEvidenceRevision(scan, options.conversationId, thread),
        observedAt: {
            scanId: options.scanId,
            sequence: options.sequence,
            startedAt,
            completedAt: (options.now || (() => new Date()))().toISOString(),
        },
        cacheBypassed: options.cacheBypassed ?? true,
    };
}

export async function enumerateCodexSourceEvidence(options: CodexSourceEvidenceOptions): Promise<CodexSourceEnumerationResult> {
    const context = await collectCodexEvidenceContext(options);
    const targetStatus = context.exactFetchResult === "present"
        ? "present"
        : context.exactFetchResult === "not_found" && context.scan.enumerationComplete
            ? "absent"
            : "unknown";
    return {
        evidence: buildSourceEnumerationEvidence({
            adapterVersion: "source-evidence/v1",
            host: "codex",
            identity: context.identity,
            sourceRevision: context.sourceRevision,
            pagination: context.scan.pagination,
            enumerationComplete: context.scan.enumerationComplete,
            cacheBypassed: context.cacheBypassed,
            exactFetchResult: context.exactFetchResult,
            errors: context.exact.errors,
            warnings: [],
            observedAt: context.observedAt,
            targetStatus,
        }),
        threads: context.scan.threads,
    };
}

export async function fetchCodexSourceEvidence(options: CodexSourceEvidenceOptions): Promise<CodexSourceExactFetchResult> {
    const context = await collectCodexEvidenceContext(options);
    return {
        evidence: buildExactFetchEvidence({
            adapterVersion: "source-evidence/v1",
            host: "codex",
            identity: context.identity,
            sourceRevision: context.sourceRevision,
            pagination: context.scan.pagination,
            enumerationComplete: context.scan.enumerationComplete,
            cacheBypassed: context.cacheBypassed,
            exactFetchResult: context.exactFetchResult,
            errors: context.exact.errors,
            warnings: [],
            observedAt: context.observedAt,
        }),
        thread: context.exact.thread,
        parentThread: context.exact.parentThread,
    };
}

export async function readCodexFullSourceEvidence(options: CodexSourceEvidenceOptions): Promise<CodexSourceFullReadResult> {
    const context = await collectCodexEvidenceContext(options);
    const exactFetch = buildExactFetchEvidence({
        adapterVersion: "source-evidence/v1",
        host: "codex",
        identity: context.identity,
        sourceRevision: context.sourceRevision,
        pagination: context.scan.pagination,
        enumerationComplete: context.scan.enumerationComplete,
        cacheBypassed: context.cacheBypassed,
        exactFetchResult: context.exactFetchResult,
        errors: context.exact.errors,
        warnings: [],
        observedAt: context.observedAt,
    });
    if (context.exactFetchResult !== "present" || !context.exact.thread) {
        return { evidence: exactFetch, thread: context.exact.thread, parentThread: context.exact.parentThread };
    }
    const rollout = await readCodexEvidenceRollout(context.exact.thread.rolloutPath);
    const fullErrors = dedupeCodexEvidenceIssues([...context.exact.errors, ...rollout.errors]);
    const fullRevision = rollout.contentCursor || codexEvidenceSha256({
        conversationId: options.conversationId,
        emptyContent: true,
    });
    const sourceRevision: SourceRevision = {
        revision: fullRevision,
        contentCursor: rollout.contentCursor,
        eventWatermark: rollout.contentCursor,
        sequence: rollout.revisionSequence,
    };
    if (canonicalSerialize(sourceRevision) !== canonicalSerialize(context.sourceRevision)) {
        fullErrors.push(codexEvidenceIssue("revision_drift", "Codex rollout 在精确定位与完整读取之间发生内容变化"));
    }
    const fullSourceRead = buildFullSourceReadEvidence({
        adapterVersion: "source-evidence/v1",
        host: "codex",
        identity: context.identity,
        sourceRevision,
        pagination: context.scan.pagination,
        enumerationComplete: context.scan.enumerationComplete && fullErrors.length === 0,
        cacheBypassed: context.cacheBypassed,
        exactFetchResult: "present",
        errors: dedupeCodexEvidenceIssues(fullErrors),
        warnings: [],
        observedAt: context.observedAt,
        content: {
            mode: "full",
            byteLength: rollout.byteLength,
            contentHash: rollout.contentHash,
            roundRange: { start: 1, end: rollout.roundEnd },
            truncated: false,
            staleCache: false,
        },
    });
    let sourceSnapshot: RecordSourceSnapshot | undefined;
    if (
        fullSourceRead.errors.length === 0
        && exactFetch.errors.length === 0
        && context.scan.enumerationComplete
        && canonicalSerialize(fullSourceRead.sourceRevision) === canonicalSerialize(exactFetch.sourceRevision)
    ) {
        sourceSnapshot = buildRecordSourceSnapshot({
            snapshotId: `codex:${options.conversationId}:${fullSourceRead.sourceRevision.revision}`,
            fullSourceRead,
        });
    }
    return {
        evidence: exactFetch,
        thread: context.exact.thread,
        parentThread: context.exact.parentThread,
        fullSourceRead,
        sourceSnapshot,
        sourceMessages: rollout.messages,
    };
}

export async function collectCodexSourceEvidence(options: CodexSourceEvidenceOptions): Promise<CodexSourceEvidenceResult> {
    const enumeration = await enumerateCodexSourceEvidence(options);
    const fullRead = await readCodexFullSourceEvidence(options);
    if (
        canonicalSerialize(enumeration.evidence.sourceRevision) !== canonicalSerialize(fullRead.evidence.sourceRevision)
        || enumeration.evidence.exactFetchResult !== fullRead.evidence.exactFetchResult
    ) {
        return {
            ...fullRead,
            enumeration: enumeration.evidence,
            sourceSnapshot: undefined,
        };
    }
    return { ...fullRead, enumeration: enumeration.evidence };
}
