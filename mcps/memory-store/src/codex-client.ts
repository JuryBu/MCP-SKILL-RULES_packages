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
    extractCodexEventUserAttachments,
    extractCodexMessageAttachments,
    mergeRoundAttachments,
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
}

export interface CodexConversationData {
    thread: CodexThreadInfo;
    parentThread?: CodexThreadInfo | null;
    rounds: ConversationRound[];
    totalSteps: number;
    childThreads: CodexSubagentSummary[];
    expandedChildren?: Array<{ thread: CodexThreadInfo; rounds: ConversationRound[] }>;
    childDiagnostics?: CodexChildThreadDiagnostic[];
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
const CODEX_TEXT_FIELD_MAX_CHARS = Number(process.env.MEMORY_STORE_CODEX_TEXT_FIELD_MAX_CHARS || 200_000);
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
    onLine: (line: string) => void | Promise<void>,
    options: {
        maxLineChars?: number;
        onOversizedLine?: (chars: number, isTail: boolean) => void | Promise<void>;
    } = {},
): Promise<void> {
    const handle = await fs.promises.open(filePath, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.max(64 * 1024, CODEX_JSONL_READ_CHUNK_BYTES));
    const maxLineChars = options.maxLineChars || CODEX_JSONL_MAX_LINE_CHARS;
    let pending = "";
    let skippingOversizedLine = false;
    let skippedChars = 0;
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
    const processLine = async (line: string) => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (trimmed.trim()) await onLine(trimmed);
        await yieldAfterLine();
    };

    try {
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            let chunk = decoder.write(buffer.subarray(0, bytesRead));

            if (skippingOversizedLine) {
                const newlineIndex = chunk.indexOf("\n");
                if (newlineIndex < 0) {
                    skippedChars += chunk.length;
                    await yieldAfterChunk();
                    continue;
                }
                skippedChars += newlineIndex;
                await options.onOversizedLine?.(skippedChars, false);
                chunk = chunk.slice(newlineIndex + 1);
                skippingOversizedLine = false;
                skippedChars = 0;
            }

            pending += chunk;
            let newlineIndex = pending.indexOf("\n");
            while (newlineIndex >= 0) {
                await processLine(pending.slice(0, newlineIndex));
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf("\n");
            }

            if (pending.length > maxLineChars) {
                skippingOversizedLine = true;
                skippedChars = pending.length;
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
            await processLine(pending);
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
        .filter((item: any) => typeof item?.text === "string")
        .map((item: any) => item.text)
        .join("");
}

function extractTextFromCodexContentItem(item: any): string {
    return typeof item?.text === "string" ? item.text : "";
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

function truncateCodexTextField(text: string, label: string): string {
    if (!text || text.length <= CODEX_TEXT_FIELD_MAX_CHARS) return text;
    return `${text.slice(0, CODEX_TEXT_FIELD_MAX_CHARS)}\n\n[... Codex ${label} 过长，读取层已截断 ${text.length - CODEX_TEXT_FIELD_MAX_CHARS} 字；可用更小轮次范围或原始文件定点查看 ...]`;
}

function stringifyCompact(value: any, maxLen: number): string {
    if (typeof value === "string") return truncate(value, maxLen);
    if (value === undefined || value === null) return "";
    try {
        return truncate(JSON.stringify(value), maxLen);
    } catch {
        return truncate(String(value), maxLen);
    }
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
            .map((item: any) => item?.text || item?.type || "")
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
            const text = truncateCodexTextField(extractCodexMessageText(payload, { events, eventIndex }), "message");
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
            const text = truncateCodexTextField(extractEventMessageText(payload), "user_message");
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
            const text = truncateCodexTextField(extractEventMessageText(payload), "agent_message");
            const normalized = normalizeProbeText(text);
            if (normalized && normalized !== lastAssistantMessage) {
                lastAssistantMessage = normalized;
                addHit("assistant", text);
            }
            continue;
        }

        if (type === "response_item" && payload.type === "reasoning") {
            addHit("reasoning", truncateCodexTextField(extractReasoningText(payload), "reasoning"));
            continue;
        }

        if (type === "event_msg" && payload.type === "agent_reasoning") {
            addHit("reasoning", truncateCodexTextField(extractReasoningText(payload), "agent_reasoning"));
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
        const text = truncateCodexTextField(
            options.foldAgents === false ? extractText(payload.content || []) : extractCodexMessageText(payload, {
                events: options.events,
                eventIndex: options.eventIndex,
            }),
            "message",
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
        const text = truncateCodexTextField(extractEventMessageText(payload), "user_message");
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
        const text = truncateCodexTextField(extractEventMessageText(payload), "agent_message");
        const normalized = normalizeProbeText(text);
        if (normalized && normalized !== state.lastAssistantMessage) {
            state.lastAssistantMessage = normalized;
            add("assistant", text);
        }
        return entries;
    }

    if (type === "response_item" && payload.type === "reasoning") {
        add("reasoning", truncateCodexTextField(extractReasoningText(payload), "reasoning"));
        return entries;
    }
    if (type === "event_msg" && payload.type === "agent_reasoning") {
        add("reasoning", truncateCodexTextField(extractReasoningText(payload), "agent_reasoning"));
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

export function buildCodexRoundsForTest(
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
            const text = truncateCodexTextField(extractCodexMessageText(payload, { events, eventIndex }), "message");
            if (payload.role === "user") {
                pushCurrent();
                roundIndex += 1;
                const attachments = extractCodexMessageAttachments(payload.content || [], text, { cwd: options.cwd, stepIndex: syntheticStep });
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
            const text = truncateCodexTextField(extractEventMessageText(payload), "user_message");
            const attachments = extractCodexEventUserAttachments(payload, { cwd: options.cwd, stepIndex: syntheticStep });
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
            const text = truncateCodexTextField(extractReasoningText(payload), "reasoning");
            if (!appendThinking(round, text) && text.trim()) {
                const clean = text.trim();
                if (!pendingThinking.includes(clean)) {
                    pendingThinking = [pendingThinking, clean].filter(Boolean).join("\n\n");
                }
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "agent_reasoning") {
            const text = truncateCodexTextField(extractReasoningText(payload), "agent_reasoning");
            if (!appendThinking(round, text) && text.trim()) {
                const clean = text.trim();
                if (!pendingThinking.includes(clean)) {
                    pendingThinking = [pendingThinking, clean].filter(Boolean).join("\n\n");
                }
            }
            continue;
        }

        if (type === "response_item" && payload.type === "function_call") {
            const index = round.toolCalls.push({
                stepIndex: syntheticStep,
                name: payload.name || "unknown",
                argsSummary: truncate(payload.arguments || "", 120),
                resultSummary: "",
            }) - 1;
            if (payload.call_id) {
                toolCallMap.set(payload.call_id, { round, index });
            }
            continue;
        }

        if (type === "response_item" && payload.type === "custom_tool_call") {
            const index = round.toolCalls.push({
                stepIndex: syntheticStep,
                name: payload.name || "custom_tool",
                argsSummary: stringifyCompact(payload.input || payload.arguments || "", 120),
                resultSummary: "",
            }) - 1;
            if (payload.call_id) {
                toolCallMap.set(payload.call_id, { round, index });
            }
            continue;
        }

        if (type === "response_item" && payload.type === "function_call_output") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot) {
                const current = slot.round.toolCalls[slot.index].resultSummary;
                if (!current) {
                    slot.round.toolCalls[slot.index].resultSummary = truncate(payload.output || "", 500);
                }
            }
            continue;
        }

        if (type === "response_item" && payload.type === "custom_tool_call_output") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            if (slot) {
                const current = slot.round.toolCalls[slot.index].resultSummary;
                if (!current) {
                    slot.round.toolCalls[slot.index].resultSummary = stringifyCompact(payload.output || "", 500);
                }
            }
            continue;
        }

        if (type === "event_msg" && payload.type === "exec_command_end") {
            const slot = payload.call_id ? toolCallMap.get(payload.call_id) : null;
            const result = payload.aggregated_output || payload.stdout || payload.stderr || payload.formatted_output || "";
            if (slot) {
                slot.round.toolCalls[slot.index].resultSummary = truncate(result, 500);
            } else {
                round.toolCalls.push({
                    stepIndex: syntheticStep,
                    name: "exec_command",
                    argsSummary: truncate(summarizeCommand(payload.command), 120),
                    resultSummary: truncate(result, 500),
                });
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
                slot.round.toolCalls[slot.index].resultSummary = truncate(result, 500);
            } else {
                round.toolCalls.push({
                    stepIndex: syntheticStep,
                    name,
                    argsSummary: stringifyCompact(invocation.arguments || {}, 120),
                    resultSummary: truncate(result, 500),
                });
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
                slot.round.toolCalls[slot.index].resultSummary = truncate(payload.stdout || payload.stderr || payload.status || "", 500);
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
    const [parentThread, events, edgeChildren] = await Promise.all([
        getCodexParentThreadAsync(thread.id),
        readRolloutEventsAsync(thread.rolloutPath),
        readSpawnChildrenAsync(thread.id),
    ]);
    const built = buildCodexRoundsForTest(events, link, { cwd: thread.cwd });
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
        totalSteps: events.length,
        childThreads: built.childThreads,
        expandedChildren,
        childDiagnostics,
    };
}
