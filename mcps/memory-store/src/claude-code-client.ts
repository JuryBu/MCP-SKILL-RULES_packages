import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { StringDecoder } from "string_decoder";
import type { CompactionSummaryInfo, ConversationRound } from "./trajectory.js";
import type { ConversationAttachment } from "./conversation-attachments.js";
import type { ConversationLogicalChainMode } from "./chain.js";

export interface ClaudeCodeThreadInfo {
    id: string;
    jsonlPath: string;
    cwd: string;
    title: string;
    source: "claude-code";
    model?: string | null;
    entrypoint?: string | null;
    updatedAtMs?: number | null;
    lastPrompt?: string | null;
    accountId?: string | null;
    organizationId?: string | null;
    desktopIndexPath?: string | null;
    desktopIndexRoot?: string | null;
    isArchived?: boolean | null;
}

export interface ClaudeCodeConversationData {
    thread: ClaudeCodeThreadInfo;
    rounds: ConversationRound[];
    totalSteps: number;
    logicalChain?: ClaudeCodeLogicalChainInfo;
}

export interface ClaudeCodeLogicalChainSegment {
    thread: ClaudeCodeThreadInfo;
    role: "target" | "predecessor-candidate" | "predecessor-merged";
    score: number;
    evidence: string[];
    negativeEvidence: string[];
}

export interface ClaudeCodeLogicalChainInfo {
    mode: ConversationLogicalChainMode;
    merged: boolean;
    segments: ClaudeCodeLogicalChainSegment[];
    warnings: string[];
}

interface ClaudeCodeLogicalSignals {
    firstUserText: string;
    lastUserText: string;
    lastAssistantText: string;
    compactSummaryText: string;
    hasCompactSummary: boolean;
    lines: number;
}

export interface ClaudeCodeContextProbeHit {
    roundIndex: number;
    role: "user" | "assistant" | "tool_args" | "tool_result" | "item" | "reasoning";
    snippet: string;
}

export interface ClaudeCodeContextProbeThreadMatch {
    thread: ClaudeCodeThreadInfo;
    hits: ClaudeCodeContextProbeHit[];
}

export interface ClaudeCodeDeepLocateHit {
    conversationId: string;
    title?: string;
    workspace?: string;
    source: "message_body_hit";
    mode: "exact" | "fuzzy";
    roundIndex: number;
    role: ClaudeCodeContextProbeHit["role"];
    filePath: string;
    byteOffset: number;
    snippet: string;
    freshness: "fresh" | "unknown";
}

export interface ClaudeCodeDeepLocateResult {
    status: "found" | "partial_found_scanning" | "no_hit_after_full_scan" | "budget_exhausted" | "cancelled";
    scannedFiles: number;
    totalFiles: number;
    scannedBytes: number;
    totalBytes: number;
    hits: ClaudeCodeDeepLocateHit[];
    truncated: boolean;
    reason?: string;
}

export interface ClaudeCodeDeepLocateOptions {
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

const CLAUDE_JSONL_READ_CHUNK_BYTES = Number(process.env.MEMORY_STORE_CC_JSONL_READ_CHUNK_BYTES || 1024 * 1024);
const CLAUDE_JSONL_MAX_LINE_CHARS = Number(process.env.MEMORY_STORE_CC_JSONL_MAX_LINE_CHARS || 16 * 1024 * 1024);
const CLAUDE_TEXT_FIELD_MAX_CHARS = Number(process.env.MEMORY_STORE_CC_TEXT_FIELD_MAX_CHARS || 200_000);
const CLAUDE_CONTEXT_PROBE_MAX_BYTES = Number(process.env.MEMORY_STORE_CC_CONTEXT_PROBE_MAX_BYTES || 16 * 1024 * 1024);
const CLAUDE_CONTEXT_PROBE_DEADLINE_MS = Number(process.env.MEMORY_STORE_CC_CONTEXT_PROBE_DEADLINE_MS || 12_000);
const CLAUDE_CODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLAUDE_COMPACT_FOLDED_MARKER = "[Claude Code compact summary folded";
const CLAUDE_LOGICAL_CHAIN_MAX_CANDIDATES = Number(process.env.MEMORY_STORE_CC_LOGICAL_CHAIN_MAX_CANDIDATES || 80);
const CLAUDE_LOGICAL_CHAIN_AUTO_THRESHOLD = Number(process.env.MEMORY_STORE_CC_LOGICAL_CHAIN_AUTO_THRESHOLD || 85);
const CLAUDE_LOGICAL_CHAIN_STRICT_THRESHOLD = Number(process.env.MEMORY_STORE_CC_LOGICAL_CHAIN_STRICT_THRESHOLD || 65);

interface ClaudeCodeDesktopIndexEntry {
    conversationId: string;
    title?: string;
    cwd?: string;
    updatedAtMs?: number | null;
    isArchived?: boolean | null;
    accountId?: string | null;
    organizationId?: string | null;
    indexPath: string;
    indexRoot: string;
}

function claudeHome(): string {
    return process.env.MEMORY_STORE_CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function claudeProjectsDir(): string {
    return path.join(claudeHome(), "projects");
}

function claudeDesktopIndexRoots(): string[] {
    const envRoots = process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS;
    if (envRoots) {
        return envRoots
            .split(path.delimiter)
            .map(item => item.trim())
            .filter(Boolean);
    }
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return [
        path.join(roaming, "Claude", "claude-code-sessions"),
        path.join(roaming, "Claude", "local-agent-mode-sessions"),
    ];
}

function safeStat(filePath: string): fs.Stats | null {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
}

function listJsonlFiles(root: string, limit = 1000): string[] {
    if (!fs.existsSync(root)) return [];
    const result: string[] = [];
    const stack = [root];
    while (stack.length && result.length < limit) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) result.push(full);
            if (result.length >= limit) break;
        }
    }
    return result;
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

function parseTimestampMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    return null;
}

function deriveDesktopIndexAccount(root: string, filePath: string): { accountId?: string | null; organizationId?: string | null } {
    const relative = path.relative(root, filePath);
    const parts = relative.split(/[\\/]+/u).filter(Boolean);
    return {
        accountId: parts.length >= 3 ? parts[0] : null,
        organizationId: parts.length >= 3 ? parts[1] : null,
    };
}

function parseClaudeCodeDesktopIndexFile(root: string, filePath: string): ClaudeCodeDesktopIndexEntry | null {
    let raw = "";
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch {
        return null;
    }
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }
    const conversationId = firstString(
        data?.cliSessionId,
        data?.sessionId,
        data?.conversationId,
        data?.id,
        data?.transcriptId,
    );
    if (!conversationId || !CLAUDE_CODE_ID_RE.test(conversationId)) return null;
    const derived = deriveDesktopIndexAccount(root, filePath);
    return {
        conversationId,
        title: firstString(data?.title, data?.customTitle, data?.aiTitle, data?.name),
        cwd: firstString(data?.cwd, data?.workspace, data?.projectPath, data?.projectRoot),
        updatedAtMs: parseTimestampMs(data?.lastActivityAt ?? data?.updatedAt ?? data?.mtime ?? data?.createdAt),
        isArchived: typeof data?.isArchived === "boolean" ? data.isArchived : null,
        accountId: firstString(data?.accountId, data?.userId) || derived.accountId || null,
        organizationId: firstString(data?.organizationId, data?.orgId, data?.workspaceId) || derived.organizationId || null,
        indexPath: filePath,
        indexRoot: root,
    };
}

function listClaudeCodeDesktopIndexFiles(root: string, limit: number): string[] {
    if (!fs.existsSync(root)) return [];
    const result: string[] = [];
    const stack = [root];
    while (stack.length && result.length < limit) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && /^local_.*\.json$/iu.test(entry.name)) result.push(full);
            if (result.length >= limit) break;
        }
    }
    return result;
}

function readClaudeCodeDesktopIndexMap(): Map<string, ClaudeCodeDesktopIndexEntry> {
    const maxFiles = Math.max(Number(process.env.MEMORY_STORE_CC_DESKTOP_INDEX_MAX_FILES || 5000), 1);
    const map = new Map<string, ClaudeCodeDesktopIndexEntry>();
    for (const root of claudeDesktopIndexRoots()) {
        const remaining = maxFiles - map.size;
        if (remaining <= 0) break;
        for (const filePath of listClaudeCodeDesktopIndexFiles(root, remaining)) {
            const entry = parseClaudeCodeDesktopIndexFile(root, filePath);
            if (!entry) continue;
            const key = entry.conversationId.toLowerCase();
            const existing = map.get(key);
            if (!existing || (entry.updatedAtMs || 0) > (existing.updatedAtMs || 0)) map.set(key, entry);
        }
    }
    return map;
}

function isLikelyClaudeCodeIdLookup(query: string): boolean {
    return /^[0-9a-f-]{8,36}$/iu.test(query);
}

function findClaudeCodeThreadsByIdLookup(query: string): ClaudeCodeThreadInfo[] {
    const normalized = query.trim().toLowerCase();
    if (!isLikelyClaudeCodeIdLookup(normalized)) return [];
    const root = claudeProjectsDir();
    if (!fs.existsSync(root)) return [];
    const desktopIndex = readClaudeCodeDesktopIndexMap();
    const matches: ClaudeCodeThreadInfo[] = [];
    const stack = [root];
    while (stack.length && matches.length < 2) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) continue;
            const id = path.basename(entry.name, ".jsonl").toLowerCase();
            if (!CLAUDE_CODE_ID_RE.test(id) || !id.startsWith(normalized)) continue;
            const thread = readThreadMetadata(full, desktopIndex);
            if (thread) matches.push(thread);
            if (id === normalized) return matches;
            if (matches.length >= 2) return matches;
        }
    }
    return matches;
}

function parseJsonLine(line: string): any | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function readJsonlLines(
    filePath: string,
    onLine: (line: string, lineNo: number, byteOffset: number) => boolean | void,
    options: { maxBytes?: number; tailOnly?: boolean; maxLineChars?: number } = {},
): { scannedBytes: number; lines: number } {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) return { scannedBytes: 0, lines: 0 };
    const maxBytes = options.maxBytes && options.maxBytes > 0 ? Math.min(options.maxBytes, stat.size) : stat.size;
    const startOffset = options.tailOnly && stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.max(64 * 1024, CLAUDE_JSONL_READ_CHUNK_BYTES));
    const decoder = new StringDecoder("utf8");
    let position = startOffset;
    let pending = "";
    let lineNo = 0;
    let lineOffset = startOffset;
    let scannedBytes = 0;
    let keepGoing = true;

    try {
        while (keepGoing && scannedBytes < maxBytes) {
            const toRead = Math.min(buffer.length, maxBytes - scannedBytes);
            const bytesRead = fs.readSync(fd, buffer, 0, toRead, position);
            if (bytesRead <= 0) break;
            const chunk = decoder.write(buffer.subarray(0, bytesRead));
            pending += chunk;
            position += bytesRead;
            scannedBytes += bytesRead;

            let newlineIndex = pending.indexOf("\n");
            while (newlineIndex >= 0) {
                let rawLine = pending.slice(0, newlineIndex);
                if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
                const rawWithNl = pending.slice(0, newlineIndex + 1);
                const currentOffset = lineOffset;
                lineOffset += Buffer.byteLength(rawWithNl, "utf8");
                pending = pending.slice(newlineIndex + 1);
                lineNo += 1;
                if (rawLine.length <= (options.maxLineChars || CLAUDE_JSONL_MAX_LINE_CHARS)) {
                    keepGoing = onLine(rawLine, lineNo, currentOffset) !== false;
                    if (!keepGoing) break;
                }
                newlineIndex = pending.indexOf("\n");
            }
            if (pending.length > (options.maxLineChars || CLAUDE_JSONL_MAX_LINE_CHARS)) {
                lineOffset += Buffer.byteLength(pending, "utf8");
                pending = "";
            }
        }
        const tail = decoder.end();
        if (keepGoing && tail) pending += tail;
        if (keepGoing && pending.trim()) {
            lineNo += 1;
            onLine(pending.replace(/\r$/u, ""), lineNo, lineOffset);
        }
    } finally {
        fs.closeSync(fd);
    }

    return { scannedBytes, lines: lineNo };
}

function normalizeProbeText(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/\s+/gu, "")
        .toLowerCase();
}

function truncate(text: string, maxLen: number): string {
    if (!text) return "";
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + `... [truncated ${text.length - maxLen} chars]`;
}

function stringifyCompact(value: any, maxLen = 500): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return truncate(value, maxLen);
    if (Array.isArray(value)) {
        return truncate(value.map(item => stringifyCompact(item, Math.ceil(maxLen / Math.max(value.length, 1)))).filter(Boolean).join("\n"), maxLen);
    }
    if (typeof value === "object") {
        const copy: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key === "signature") continue;
            if (key === "data" && typeof entry === "string" && entry.length > 1000) {
                copy[key] = `[base64/data omitted chars=${entry.length} sha256=${createHash("sha256").update(entry).digest("hex").slice(0, 12)}]`;
            } else {
                copy[key] = entry;
            }
        }
        try {
            return truncate(JSON.stringify(copy), maxLen);
        } catch {
            return truncate(String(value), maxLen);
        }
    }
    return truncate(String(value), maxLen);
}

function summarizeToolResult(event: any, content: any): string {
    const result = event?.toolUseResult;
    if (result !== undefined) {
        if (typeof result === "string") return truncate(result, 500);
        if (Array.isArray(result)) return truncate(result.map(item => stringifyCompact(item, 200)).join("\n"), 500);
        if (typeof result === "object" && result) {
            const preferred = [result.stdout, result.stderr, result.formatted_output, result.output, result.error]
                .filter(item => typeof item === "string" && item.trim())
                .join("\n");
            if (preferred) return truncate(preferred, 500);
            if (result.isImage) return "工具返回图片结果（内容未内联到文本）";
            return stringifyCompact(result, 500);
        }
    }
    return stringifyCompact(content, 500);
}

function estimateBase64Bytes(base64: string): number {
    const clean = base64.replace(/\s+/gu, "");
    if (!clean) return 0;
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function isLikelyPath(input: string): boolean {
    return /^[a-zA-Z]:[\\/]/u.test(input) || /^\\\\/u.test(input) || /^[./~]/u.test(input);
}

interface ExtractMessageContentOptions {
    includeEncryptedThinkingPlaceholders?: boolean;
    stepIndex?: number;
}

function encryptedThinkingPlaceholder(stepIndex?: number): string {
    const stepLabel = typeof stepIndex === "number" ? ` step ${stepIndex}` : "";
    return `🔒 加密思考块${stepLabel}：thinking 为空，signature 存在，明文不可读`;
}

function extractMessageContent(content: any, cwd?: string, options: ExtractMessageContentOptions = {}): { text: string; thinking: string; toolUses: any[]; toolResults: any[]; attachments: ConversationAttachment[] } {
    if (typeof content === "string") {
        return { text: truncate(content, CLAUDE_TEXT_FIELD_MAX_CHARS), thinking: "", toolUses: [], toolResults: [], attachments: [] };
    }
    const parts: string[] = [];
    const thinking: string[] = [];
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const attachments: ConversationAttachment[] = [];
    if (!Array.isArray(content)) return { text: "", thinking: "", toolUses, toolResults, attachments };

    for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
            parts.push(item.text);
        } else if (item.type === "thinking" && typeof item.thinking === "string") {
            if (item.thinking.trim()) {
                thinking.push(item.thinking);
            } else if (options.includeEncryptedThinkingPlaceholders && typeof item.signature === "string" && item.signature.length > 0) {
                thinking.push(encryptedThinkingPlaceholder(options.stepIndex));
            }
        } else if (item.type === "tool_use") {
            toolUses.push(item);
        } else if (item.type === "tool_result") {
            toolResults.push(item);
        } else if (item.type === "image") {
            const source = item.source || {};
            if (source.type === "base64" && typeof source.data === "string") {
                const mimeType = source.media_type || source.mimeType || "image/png";
                attachments.push({
                    kind: "image",
                    source: "claude-code-data-url",
                    mimeType,
                    dataUrl: `data:${mimeType};base64,${source.data}`,
                    sizeBytes: estimateBase64Bytes(source.data),
                });
            } else if (typeof source.path === "string" || typeof item.path === "string") {
                const rawPath = source.path || item.path;
                const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd || process.cwd(), rawPath);
                attachments.push({
                    kind: "image",
                    source: "claude-code-local-file",
                    name: path.basename(resolved),
                    originalPath: resolved,
                    exists: fs.existsSync(resolved),
                });
            }
        } else if ((item.type === "file" || item.type === "document") && (typeof item.path === "string" || typeof item.name === "string")) {
            const raw = item.path || item.name;
            const resolved = isLikelyPath(raw) ? (path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw)) : "";
            attachments.push({
                kind: "file",
                source: resolved ? "claude-code-local-file" : "files-mentioned",
                name: item.name || (resolved ? path.basename(resolved) : raw),
                originalPath: resolved || undefined,
                exists: resolved ? fs.existsSync(resolved) : undefined,
                mimeType: item.mime_type || item.mimeType,
            });
        }
    }

    return {
        text: truncate(parts.join("\n"), CLAUDE_TEXT_FIELD_MAX_CHARS),
        thinking: truncate(thinking.join("\n\n"), CLAUDE_TEXT_FIELD_MAX_CHARS),
        toolUses,
        toolResults,
        attachments,
    };
}

interface PendingCompactBoundary {
    uuid?: string;
    lineNo?: number;
    byteOffset?: number;
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
}

function isClaudeCodeCompactBoundary(event: any): boolean {
    return event?.type === "system" && event?.subtype === "compact_boundary";
}

function compactBoundaryFromEvent(event: any, lineNo?: number, byteOffset?: number): PendingCompactBoundary {
    const metadata = event?.compactMetadata || {};
    return {
        uuid: typeof event?.uuid === "string" ? event.uuid : undefined,
        lineNo,
        byteOffset,
        trigger: typeof metadata.trigger === "string" ? metadata.trigger : undefined,
        preTokens: typeof metadata.preTokens === "number" ? metadata.preTokens : undefined,
        postTokens: typeof metadata.postTokens === "number" ? metadata.postTokens : undefined,
        durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
    };
}

function isClaudeCodeCompactSummaryEvent(event: any, pending?: PendingCompactBoundary | null): boolean {
    if (event?.type !== "user") return false;
    if (event?.isCompactSummary === true) return true;
    if (!pending?.uuid) return false;
    const parentUuid = typeof event?.parentUuid === "string" ? event.parentUuid : "";
    const logicalParentUuid = typeof event?.logicalParentUuid === "string" ? event.logicalParentUuid : "";
    if (parentUuid !== pending.uuid && logicalParentUuid !== pending.uuid) return false;
    const text = typeof event?.message?.content === "string"
        ? event.message.content
        : "";
    return text.startsWith("This session is being continued from a previous conversation that ran out of context.");
}

function buildCompactionSummaryInfo(
    event: any,
    text: string,
    pending: PendingCompactBoundary | null,
    jsonlPath: string,
    lineNo?: number,
    byteOffset?: number,
): CompactionSummaryInfo {
    const summarySha256 = createHash("sha256").update(text, "utf8").digest("hex");
    return {
        provider: "claude-code",
        kind: "compact_summary",
        text,
        summaryChars: text.length,
        summarySha256,
        eventLineNo: lineNo,
        eventByteOffset: byteOffset,
        boundaryLineNo: pending?.lineNo,
        boundaryByteOffset: pending?.byteOffset,
        boundaryUuid: pending?.uuid,
        trigger: pending?.trigger,
        preTokens: pending?.preTokens,
        postTokens: pending?.postTokens,
        durationMs: pending?.durationMs,
        jsonlPath,
        conversationId: typeof event?.sessionId === "string" ? event.sessionId : path.basename(jsonlPath, ".jsonl"),
        createdAt: typeof event?.timestamp === "string" ? event.timestamp : undefined,
    };
}

function compactSummaryPlaceholder(info: CompactionSummaryInfo): string {
    return `${CLAUDE_COMPACT_FOLDED_MARKER}: chars=${info.summaryChars}, sha256=${info.summarySha256.slice(0, 12)}, line=${info.eventLineNo ?? "?"}]`;
}

function readThreadMetadata(jsonlPath: string, desktopIndex?: Map<string, ClaudeCodeDesktopIndexEntry>): ClaudeCodeThreadInfo | null {
    const id = path.basename(jsonlPath, ".jsonl");
    const stat = safeStat(jsonlPath);
    if (!stat?.isFile()) return null;
    const desktop = desktopIndex?.get(id.toLowerCase());
    let cwd = "";
    let title = "";
    let aiTitle = "";
    let customTitle = "";
    let lastPrompt = "";
    let model: string | null = null;
    let entrypoint: string | null = null;

    readJsonlLines(jsonlPath, (line) => {
        const event = parseJsonLine(line);
        if (!event) return;
        if (!cwd && typeof event.cwd === "string") cwd = event.cwd;
        if (!entrypoint && typeof event.entrypoint === "string") entrypoint = event.entrypoint;
        if (event.type === "ai-title" && typeof event.aiTitle === "string") aiTitle = event.aiTitle;
        if (event.type === "custom-title" && typeof event.customTitle === "string") customTitle = event.customTitle;
        if (event.type === "last-prompt" && typeof event.lastPrompt === "string") lastPrompt = event.lastPrompt;
        if (!model && typeof event?.message?.model === "string") model = event.message.model;
        if (!title && event.type === "user") {
            const extracted = extractMessageContent(event.message?.content, cwd);
            if (extracted.text) title = extracted.text.slice(0, 80);
        }
    }, { maxLineChars: CLAUDE_JSONL_MAX_LINE_CHARS });

    return {
        id,
        jsonlPath,
        cwd: cwd || desktop?.cwd || "",
        title: customTitle || aiTitle || desktop?.title || title || lastPrompt || id,
        source: "claude-code",
        model,
        entrypoint,
        updatedAtMs: desktop?.updatedAtMs || stat.mtimeMs,
        lastPrompt,
        accountId: desktop?.accountId || null,
        organizationId: desktop?.organizationId || null,
        desktopIndexPath: desktop?.indexPath || null,
        desktopIndexRoot: desktop?.indexRoot || null,
        isArchived: desktop?.isArchived ?? null,
    };
}

export function isClaudeCodeStoreAvailable(): boolean {
    return fs.existsSync(claudeProjectsDir());
}

export function listRecentClaudeCodeThreads(limit = 50): ClaudeCodeThreadInfo[] {
    const desktopIndex = readClaudeCodeDesktopIndexMap();
    return listJsonlFiles(claudeProjectsDir(), Math.max(limit * 10, 100))
        .map(filePath => ({ filePath, stat: safeStat(filePath) }))
        .filter((item): item is { filePath: string; stat: fs.Stats } => Boolean(item.stat?.isFile()))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        .slice(0, limit)
        .map(item => readThreadMetadata(item.filePath, desktopIndex))
        .filter((item): item is ClaudeCodeThreadInfo => Boolean(item));
}

export function resolveClaudeCodeThreadId(input: string): string | null {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();
    const exactByFile = findClaudeCodeThreadsByIdLookup(queryLower);
    if (exactByFile.length === 1 && exactByFile[0].id.toLowerCase() === queryLower) return exactByFile[0].id;
    if (exactByFile.length === 1 && isLikelyClaudeCodeIdLookup(queryLower)) return exactByFile[0].id;
    const threads = listRecentClaudeCodeThreads(1000);
    const exact = threads.find(thread => thread.id === query);
    if (exact) return exact.id;
    const prefixMatches = threads.filter(thread => thread.id.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].id;
    const titleMatches = threads.filter(thread => (thread.title || "").toLowerCase() === queryLower);
    if (titleMatches.length === 1) return titleMatches[0].id;
    return null;
}

export function getClaudeCodeThread(conversationId: string): ClaudeCodeThreadInfo | null {
    const resolved = resolveClaudeCodeThreadId(conversationId);
    if (!resolved) return null;
    const desktopIndex = readClaudeCodeDesktopIndexMap();
    const exactByFile = findClaudeCodeThreadsByIdLookup(resolved);
    if (exactByFile.length === 1) return exactByFile[0];
    const root = claudeProjectsDir();
    const directMatches = listJsonlFiles(root, 5000).filter(filePath => path.basename(filePath, ".jsonl").toLowerCase() === resolved.toLowerCase());
    if (directMatches.length === 1) return readThreadMetadata(directMatches[0], desktopIndex);
    return listRecentClaudeCodeThreads(1000).find(thread => thread.id === resolved) || null;
}

function normalizeLogicalChainPath(input?: string): string {
    return (input || "")
        .trim()
        .replace(/^\\\\\?\\/u, "")
        .replace(/[\\/]+$/u, "")
        .toLowerCase();
}

function normalizeLogicalChainTitle(input?: string): string {
    return (input || "")
        .normalize("NFKC")
        .replace(/^(继续|接力|续聊|承接|重开|新对话|卡住|断了|恢复)+/gu, "")
        .replace(/(对话|聊天|conversation|session)$/giu, "")
        .replace(/\s+/gu, "")
        .toLowerCase();
}

function isLikelyClaudeCodeSubagentJsonl(jsonlPath: string): boolean {
    const normalized = jsonlPath.replace(/\\/gu, "/").toLowerCase();
    return normalized.includes("/subagents/") || path.basename(jsonlPath).toLowerCase().startsWith("agent-");
}

function containsContinuationIntent(text: string): boolean {
    return /(继续|接着|接上|接力|续聊|续上|上个对话|前一个对话|之前那个|卡住|崩了|断了|新对话继续|换个新对话继续)/u.test(text);
}

function containsNegativeContinuationIntent(text: string): boolean {
    return /(从\s*0\s*开始|从零开始|重新开始|全新开始|不要继承|不继承|清理污染|干净状态|clean state|fresh start|不要带旧上下文|独立新对话)/iu.test(text);
}

function importantTextTokens(text: string): string[] {
    const normalized = text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ");
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const token of normalized.split(/\s+/u)) {
        if (token.length < 2 || seen.has(token)) continue;
        seen.add(token);
        tokens.push(token);
    }
    return tokens.slice(0, 80);
}

function textOverlapRatio(a: string, b: string): number {
    const tokensA = importantTextTokens(a);
    const tokensB = new Set(importantTextTokens(b));
    if (tokensA.length === 0 || tokensB.size === 0) return 0;
    const hits = tokensA.filter(token => tokensB.has(token)).length;
    return hits / Math.min(tokensA.length, tokensB.size);
}

function readClaudeCodeLogicalSignals(thread: ClaudeCodeThreadInfo): ClaudeCodeLogicalSignals {
    const signals: ClaudeCodeLogicalSignals = {
        firstUserText: "",
        lastUserText: "",
        lastAssistantText: "",
        compactSummaryText: "",
        hasCompactSummary: false,
        lines: 0,
    };
    let pendingCompactBoundary: PendingCompactBoundary | null = null;
    readJsonlLines(thread.jsonlPath, (line, lineNo, byteOffset) => {
        signals.lines = lineNo;
        const event = parseJsonLine(line);
        if (!event) return;
        if (isClaudeCodeCompactBoundary(event)) {
            pendingCompactBoundary = compactBoundaryFromEvent(event, lineNo, byteOffset);
            return;
        }
        const extracted = extractMessageContent(event.message?.content, event.cwd || thread.cwd);
        if (event.type === "user") {
            const isCompact = isClaudeCodeCompactSummaryEvent(event, pendingCompactBoundary);
            if (isCompact) {
                signals.hasCompactSummary = true;
                signals.compactSummaryText = truncate([signals.compactSummaryText, extracted.text].filter(Boolean).join("\n\n"), 80_000);
                pendingCompactBoundary = null;
                return;
            }
            if (extracted.toolResults.length > 0 && !extracted.text) return;
            if (extracted.text) {
                if (!signals.firstUserText) signals.firstUserText = truncate(extracted.text, 4000);
                signals.lastUserText = truncate(extracted.text, 4000);
            }
            return;
        }
        if (event.type === "assistant" && extracted.text) {
            signals.lastAssistantText = truncate(extracted.text, 4000);
        }
    }, { maxLineChars: CLAUDE_JSONL_MAX_LINE_CHARS });
    return signals;
}

function scoreClaudeCodePredecessor(
    target: ClaudeCodeThreadInfo,
    candidate: ClaudeCodeThreadInfo,
    targetSignals: ClaudeCodeLogicalSignals,
    candidateSignals: ClaudeCodeLogicalSignals,
): ClaudeCodeLogicalChainSegment | null {
    if (target.id === candidate.id) return null;
    if (isLikelyClaudeCodeSubagentJsonl(candidate.jsonlPath)) return null;
    const targetCwd = normalizeLogicalChainPath(target.cwd);
    const candidateCwd = normalizeLogicalChainPath(candidate.cwd);
    if (!targetCwd || !candidateCwd || targetCwd !== candidateCwd) return null;

    const targetTime = target.updatedAtMs || safeStat(target.jsonlPath)?.mtimeMs || 0;
    const candidateTime = candidate.updatedAtMs || safeStat(candidate.jsonlPath)?.mtimeMs || 0;
    if (targetTime && candidateTime && candidateTime > targetTime + 1000) return null;

    const evidence: string[] = ["同一 Claude Code 工作区"];
    const negativeEvidence: string[] = [];
    let score = 30;

    const targetText = [targetSignals.firstUserText, targetSignals.compactSummaryText].filter(Boolean).join("\n");
    const candidateText = [candidate.title, candidateSignals.lastUserText, candidateSignals.lastAssistantText].filter(Boolean).join("\n");
    const targetTitle = normalizeLogicalChainTitle(target.title);
    const candidateTitle = normalizeLogicalChainTitle(candidate.title);
    if (targetTitle && candidateTitle && targetTitle === candidateTitle) {
        score += 12;
        evidence.push("标题归一化后相同");
    }
    if (target.accountId && candidate.accountId && target.accountId === candidate.accountId) {
        score += 3;
        evidence.push("同一 Claude 账号索引");
    }
    if (target.organizationId && candidate.organizationId && target.organizationId === candidate.organizationId) {
        score += 2;
        evidence.push("同一 Claude 组织索引");
    }
    if (targetTime && candidateTime) {
        const gap = Math.abs(targetTime - candidateTime);
        if (gap < 2 * 60 * 60_000) {
            score += 12;
            evidence.push("更新时间间隔小于 2 小时");
        } else if (gap < 24 * 60 * 60_000) {
            score += 8;
            evidence.push("更新时间间隔小于 24 小时");
        } else if (gap < 7 * 24 * 60 * 60_000) {
            score += 4;
            evidence.push("更新时间间隔小于 7 天");
        }
    }

    const candidateShortId = candidate.id.slice(0, 8);
    if (targetText.includes(candidate.id) || targetText.includes(candidateShortId)) {
        score += 90;
        evidence.push("目标开头或压缩摘要明确引用候选 ID");
    }
    if (candidate.title && candidate.title.length >= 4 && targetText.includes(candidate.title)) {
        score += 28;
        evidence.push("目标开头或压缩摘要明确引用候选标题");
    }
    if (containsContinuationIntent(targetSignals.firstUserText)) {
        score += 16;
        evidence.push("目标首条用户消息带续聊意图");
    }
    if (/(中断|卡住|失败|崩|断|开新对话|换新对话)/u.test(candidateSignals.lastUserText + candidateSignals.lastAssistantText)) {
        score += 8;
        evidence.push("候选尾部像被中断或要求换新对话");
    }
    const overlap = textOverlapRatio(targetText, candidateText);
    if (overlap >= 0.25) {
        score += Math.round(overlap * 40);
        evidence.push(`首尾内容重叠 ${(overlap * 100).toFixed(0)}%`);
    }
    if (targetSignals.hasCompactSummary && overlap >= 0.12) {
        score += 15;
        evidence.push("压缩摘要与候选尾部存在重叠");
    }
    if (containsNegativeContinuationIntent(targetSignals.firstUserText)) {
        score -= 90;
        negativeEvidence.push("目标首条用户消息声明从零/干净状态开始");
    }
    if (containsNegativeContinuationIntent(candidateSignals.firstUserText)) {
        score -= 80;
        negativeEvidence.push("候选首条用户消息声明从零/干净状态开始");
    }
    if (score < 0) score = 0;

    return {
        thread: candidate,
        role: "predecessor-candidate",
        score,
        evidence,
        negativeEvidence,
    };
}

export function discoverClaudeCodeLogicalChain(
    conversationId: string,
    mode: ConversationLogicalChainMode = "explain",
): ClaudeCodeLogicalChainInfo | null {
    const target = getClaudeCodeThread(conversationId);
    if (!target) return null;
    const targetSignals = readClaudeCodeLogicalSignals(target);
    const candidates = listRecentClaudeCodeThreads(Math.max(CLAUDE_LOGICAL_CHAIN_MAX_CANDIDATES * 4, 200))
        .filter(thread => thread.id !== target.id)
        .filter(thread => !isLikelyClaudeCodeSubagentJsonl(thread.jsonlPath))
        .filter(thread => normalizeLogicalChainPath(thread.cwd) === normalizeLogicalChainPath(target.cwd))
        .slice(0, CLAUDE_LOGICAL_CHAIN_MAX_CANDIDATES);
    const scored: ClaudeCodeLogicalChainSegment[] = [];
    for (const candidate of candidates) {
        const segment = scoreClaudeCodePredecessor(target, candidate, targetSignals, readClaudeCodeLogicalSignals(candidate));
        if (segment && segment.score > 0) scored.push(segment);
    }
    scored.sort((a, b) => b.score - a.score);

    const warnings: string[] = [];
    const threshold = mode === "strict" ? CLAUDE_LOGICAL_CHAIN_STRICT_THRESHOLD : CLAUDE_LOGICAL_CHAIN_AUTO_THRESHOLD;
    const hasStrongEvidence = (segment: ClaudeCodeLogicalChainSegment) =>
        segment.evidence.some(item => /明确引用|首尾内容重叠|压缩摘要/u.test(item));
    const selected = scored
        .filter(segment => segment.score >= threshold && segment.negativeEvidence.length === 0 && hasStrongEvidence(segment))
        .sort((a, b) => (a.thread.updatedAtMs || 0) - (b.thread.updatedAtMs || 0))
        .slice(0, 3)
        .map(segment => ({ ...segment, role: "predecessor-merged" as const }));
    if ((mode === "auto" || mode === "strict") && selected.length === 0) {
        warnings.push(mode === "strict"
            ? "strict 模式未找到足够强的续聊证据，未合并。"
            : "auto 模式未找到足够强的续聊证据，保持物理对话。");
    }
    const targetSegment: ClaudeCodeLogicalChainSegment = {
        thread: target,
        role: "target",
        score: 100,
        evidence: ["目标物理对话"],
        negativeEvidence: [],
    };
    return {
        mode,
        merged: (mode === "auto" || mode === "strict") && selected.length > 0,
        segments: [
            ...selected,
            targetSegment,
            ...scored
                .filter(segment => !selected.some(item => item.thread.id === segment.thread.id))
                .slice(0, 5),
        ],
        warnings,
    };
}

function buildClaudeCodeRounds(jsonlPath: string, cwd?: string): { rounds: ConversationRound[]; totalSteps: number } {
    const rounds: ConversationRound[] = [];
    const toolCallMap = new Map<string, { round: ConversationRound; index: number }>();
    let currentRound: ConversationRound | null = null;
    let roundIndex = 0;
    let stepIndex = 0;
    let pendingThinking = "";
    let pendingCompactBoundary: PendingCompactBoundary | null = null;

    const pushCurrent = () => {
        if (!currentRound) return;
        currentRound.endStep = stepIndex;
        rounds.push(currentRound);
        currentRound = null;
    };

    const ensureRound = (): ConversationRound => {
        if (!currentRound) {
            roundIndex += 1;
            currentRound = {
                roundIndex,
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
                fileViews: [],
            };
        }
        return currentRound;
    };

    const applyToolResult = (event: any, toolResult: any) => {
        const toolUseId = toolResult?.tool_use_id || toolResult?.toolUseId || event?.toolUseResult?.tool_use_id;
        const summary = summarizeToolResult(event, toolResult?.content);
        const slot = toolUseId ? toolCallMap.get(toolUseId) : null;
        if (slot) {
            slot.round.toolCalls[slot.index].resultSummary = summary;
        } else {
            const round = ensureRound();
            round.toolCalls.push({
                stepIndex,
                name: "tool_result",
                argsSummary: toolUseId ? `tool_use_id=${toolUseId}` : "",
                resultSummary: summary,
            });
        }
    };

    readJsonlLines(jsonlPath, (line, lineNo, byteOffset) => {
        stepIndex += 1;
        const event = parseJsonLine(line);
        if (!event) return;
        const type = event.type;
        const message = event.message || {};
        const extracted = extractMessageContent(message.content, event.cwd || cwd, {
            includeEncryptedThinkingPlaceholders: true,
            stepIndex,
        });

        if (type === "user") {
            if (extracted.toolResults.length > 0 && !extracted.text) {
                for (const toolResult of extracted.toolResults) applyToolResult(event, toolResult);
                return;
            }
            pushCurrent();
            roundIndex += 1;
            const isCompactSummary = isClaudeCodeCompactSummaryEvent(event, pendingCompactBoundary);
            const compactionInfo = isCompactSummary
                ? buildCompactionSummaryInfo(event, extracted.text, pendingCompactBoundary, jsonlPath, lineNo, byteOffset)
                : null;
            currentRound = {
                roundIndex,
                startStep: stepIndex,
                endStep: stepIndex,
                userMessage: compactionInfo
                    ? compactSummaryPlaceholder(compactionInfo)
                    : (extracted.text || "(无显式用户消息)"),
                mediaAttachments: [],
                attachments: compactionInfo ? [] : extracted.attachments,
                aiResponses: [],
                toolCalls: [],
                taskBoundaries: [],
                codeActions: [],
                subagentSummaries: [],
                fileViews: [],
                compactionSummaries: compactionInfo ? [compactionInfo] : undefined,
            };
            if (compactionInfo) pendingCompactBoundary = null;
            for (const toolResult of extracted.toolResults) applyToolResult(event, toolResult);
            return;
        }

        if (type === "assistant") {
            const round = ensureRound();
            if (extracted.thinking && !extracted.text && extracted.toolUses.length === 0) {
                pendingThinking = [pendingThinking, extracted.thinking].filter(Boolean).join("\n\n");
                return;
            }

            const aiToolCalls = extracted.toolUses.map(toolUse => ({
                name: toolUse.name || "tool_use",
                args: stringifyCompact(toolUse.input || {}, 120),
            }));
            for (const toolUse of extracted.toolUses) {
                const index = round.toolCalls.push({
                    stepIndex,
                    name: toolUse.name || "tool_use",
                    argsSummary: stringifyCompact(toolUse.input || {}, 120),
                    resultSummary: "",
                }) - 1;
                if (toolUse.id) toolCallMap.set(toolUse.id, { round, index });
            }
            const response = extracted.text || (aiToolCalls.length ? `（调用工具：${aiToolCalls.map(item => item.name).join(", ")}）` : "");
            if (response || pendingThinking || extracted.thinking) {
                round.aiResponses.push({
                    stepIndex,
                    response,
                    thinking: [pendingThinking, extracted.thinking].filter(Boolean).join("\n\n"),
                    toolCalls: aiToolCalls,
                });
                pendingThinking = "";
            }
            return;
        }

        if (type === "attachment") {
            const round = currentRound;
            if (!round) return;
            const attachment = event.attachment || {};
            round.fileViews = round.fileViews || [];
            if (attachment.type && ["skill_listing", "deferred_tools_delta", "budget_usd"].includes(attachment.type)) return;
            round.fileViews.push({
                stepIndex,
                kind: `claude-code-attachment:${attachment.type || "unknown"}`,
                title: attachment.name || attachment.type,
                textSummary: stringifyCompact(attachment, 500),
            });
            return;
        }

        if (type === "system") {
            if (isClaudeCodeCompactBoundary(event)) {
                pendingCompactBoundary = compactBoundaryFromEvent(event, lineNo, byteOffset);
                const round = currentRound;
                if (!round) return;
                round.fileViews = round.fileViews || [];
                round.fileViews.push({
                    stepIndex,
                    kind: "claude-code-compact-boundary",
                    title: "Conversation compacted",
                    textSummary: stringifyCompact({
                        subtype: event.subtype,
                        compactMetadata: event.compactMetadata,
                    }, 500),
                });
                return;
            }
            const round = currentRound;
            if (!round) return;
            round.fileViews = round.fileViews || [];
            round.fileViews.push({
                stepIndex,
                kind: "claude-code-system",
                title: event.subtype || "system",
                textSummary: stringifyCompact(event, 500),
            });
        }
    });

    pushCurrent();
    return { rounds, totalSteps: stepIndex };
}

function cloneRoundWithLogicalOffsets(
    round: ConversationRound,
    roundOffset: number,
    stepOffset: number,
): ConversationRound {
    const cloned: ConversationRound = JSON.parse(JSON.stringify(round));
    cloned.roundIndex = round.roundIndex + roundOffset;
    cloned.startStep = round.startStep + stepOffset;
    cloned.endStep = round.endStep + stepOffset;
    cloned.aiResponses = (cloned.aiResponses || []).map((item: any) => ({ ...item, stepIndex: item.stepIndex + stepOffset }));
    cloned.toolCalls = (cloned.toolCalls || []).map((item: any) => ({ ...item, stepIndex: item.stepIndex + stepOffset }));
    cloned.taskBoundaries = (cloned.taskBoundaries || []).map((item: any) => ({ ...item, stepIndex: item.stepIndex + stepOffset }));
    cloned.codeActions = (cloned.codeActions || []).map((item: any) => ({ ...item, stepIndex: item.stepIndex + stepOffset }));
    cloned.fileViews = (cloned.fileViews || []).map((item: any) => ({ ...item, stepIndex: item.stepIndex + stepOffset }));
    cloned.subagentSummaries = cloned.subagentSummaries || [];
    return cloned;
}

function buildClaudeCodeLogicalConversation(
    target: ClaudeCodeThreadInfo,
    info: ClaudeCodeLogicalChainInfo,
): { rounds: ConversationRound[]; totalSteps: number } {
    const mergedSegments = info.segments.filter(segment => segment.role === "predecessor-merged");
    const orderedThreads = [
        ...mergedSegments
            .sort((a, b) => (a.thread.updatedAtMs || 0) - (b.thread.updatedAtMs || 0))
            .map(segment => segment.thread),
        target,
    ];
    const rounds: ConversationRound[] = [];
    let totalSteps = 0;
    let roundOffset = 0;
    let stepOffset = 0;
    for (const thread of orderedThreads) {
        const built = buildClaudeCodeRounds(thread.jsonlPath, thread.cwd);
        const segmentLabel = thread.id === target.id
            ? `目标物理对话 ${thread.id}`
            : `前序续聊候选 ${thread.id}`;
        const startRound = roundOffset + 1;
        for (const [index, round] of built.rounds.entries()) {
            const cloned = cloneRoundWithLogicalOffsets(round, roundOffset, stepOffset);
            if (index === 0) {
                cloned.fileViews = [
                    {
                        stepIndex: cloned.startStep,
                        kind: "claude-code-logical-chain-segment",
                        title: segmentLabel,
                        textSummary: [
                            `title=${thread.title || "(无标题)"}`,
                            `cwd=${thread.cwd || "(未知)"}`,
                        ].join(" | "),
                    },
                    ...(cloned.fileViews || []),
                ];
            }
            rounds.push(cloned);
        }
        roundOffset += built.rounds.length;
        stepOffset += built.totalSteps;
        totalSteps += built.totalSteps;
        if (built.rounds.length === 0) {
            rounds.push({
                roundIndex: startRound,
                startStep: stepOffset,
                endStep: stepOffset,
                userMessage: `（逻辑续聊片段无可解析轮次：${thread.id}）`,
                mediaAttachments: [],
                attachments: [],
                aiResponses: [],
                toolCalls: [],
                taskBoundaries: [],
                codeActions: [],
                subagentSummaries: [],
                fileViews: [{
                    stepIndex: stepOffset,
                    kind: "claude-code-logical-chain-segment-empty",
                    title: segmentLabel,
                    textSummary: thread.jsonlPath,
                }],
            });
            roundOffset += 1;
        }
    }
    return { rounds, totalSteps };
}

export function loadClaudeCodeConversation(
    conversationId: string,
    options: { logicalChain?: ConversationLogicalChainMode } = {},
): ClaudeCodeConversationData | null {
    const thread = getClaudeCodeThread(conversationId);
    if (!thread?.jsonlPath) return null;
    const logicalMode = options.logicalChain || "off";
    const logicalChain = logicalMode === "off"
        ? undefined
        : discoverClaudeCodeLogicalChain(thread.id, logicalMode);
    const built = logicalChain?.merged
        ? buildClaudeCodeLogicalConversation(thread, logicalChain)
        : buildClaudeCodeRounds(thread.jsonlPath, thread.cwd);
    return {
        thread,
        rounds: built.rounds,
        totalSteps: built.totalSteps,
        logicalChain: logicalChain || undefined,
    };
}

function searchableTextsFromEvent(event: any): Array<{ role: ClaudeCodeContextProbeHit["role"]; text: string }> {
    if (event?.type === "user" && event?.isCompactSummary === true) {
        return [];
    }
    const message = event?.message || {};
    const extracted = extractMessageContent(message.content, event.cwd);
    const result: Array<{ role: ClaudeCodeContextProbeHit["role"]; text: string }> = [];
    if (event.type === "user" && extracted.text) result.push({ role: "user", text: extracted.text });
    if (event.type === "assistant") {
        if (extracted.text) result.push({ role: "assistant", text: extracted.text });
        if (extracted.thinking) result.push({ role: "reasoning", text: extracted.thinking });
        for (const toolUse of extracted.toolUses) {
            result.push({ role: "tool_args", text: `${toolUse.name || "tool_use"} ${stringifyCompact(toolUse.input || {}, 1000)}` });
        }
    }
    for (const toolResult of extracted.toolResults) {
        result.push({ role: "tool_result", text: summarizeToolResult(event, toolResult.content) });
    }
    if (event.type === "last-prompt" && typeof event.lastPrompt === "string") {
        result.push({ role: "item", text: event.lastPrompt });
    }
    return result;
}

function fuzzyContains(haystack: string, needle: string): boolean {
    const tokens = normalizeProbeText(needle).match(/[\p{L}\p{N}]{2,}/gu) || [];
    if (tokens.length === 0) return false;
    const normalizedHaystack = normalizeProbeText(haystack);
    const hits = tokens.filter(token => normalizedHaystack.includes(token)).length;
    return hits >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function makeSnippet(text: string, query: string): string {
    const normalized = normalizeProbeText(text);
    const normalizedQuery = normalizeProbeText(query);
    const index = normalizedQuery ? normalized.indexOf(normalizedQuery.slice(0, Math.min(normalizedQuery.length, 30))) : -1;
    const rawIndex = index >= 0 ? Math.max(0, index - 80) : 0;
    return truncate(text.slice(rawIndex, rawIndex + 220).replace(/\s+/gu, " ").trim(), 240);
}

export function matchClaudeCodeContextProbeInJsonl(
    jsonlPath: string,
    probe: string,
    options: { maxBytes?: number } = {},
): ClaudeCodeContextProbeHit[] {
    const normalizedProbe = normalizeProbeText(probe);
    if (normalizedProbe.length < 12) return [];
    const hits: ClaudeCodeContextProbeHit[] = [];
    let roundIndex = 0;
    readJsonlLines(jsonlPath, (line) => {
        const event = parseJsonLine(line);
        if (!event) return;
        if (event.type === "user") {
            const extracted = extractMessageContent(event.message?.content, event.cwd);
            if (extracted.toolResults.length === 0 || extracted.text) roundIndex += 1;
        }
        for (const item of searchableTextsFromEvent(event)) {
            if (!normalizeProbeText(item.text).includes(normalizedProbe)) continue;
            hits.push({
                roundIndex: Math.max(roundIndex, 1),
                role: item.role,
                snippet: makeSnippet(item.text, probe),
            });
            if (hits.length >= 5) return false;
        }
    }, { maxBytes: options.maxBytes || CLAUDE_CONTEXT_PROBE_MAX_BYTES, tailOnly: true });
    return hits;
}

export function findClaudeCodeContextProbeMatches(
    threads: ClaudeCodeThreadInfo[],
    probe: string,
    options: { maxThreads?: number; deadlineMs?: number; maxBytes?: number } = {},
): ClaudeCodeContextProbeThreadMatch[] {
    const normalizedProbe = normalizeProbeText(probe);
    if (normalizedProbe.length < 12) return [];
    const startedAt = Date.now();
    const deadlineMs = Math.max(500, options.deadlineMs || CLAUDE_CONTEXT_PROBE_DEADLINE_MS);
    const maxThreads = Math.min(Math.max(options.maxThreads || Number(process.env.MEMORY_STORE_CC_CONTEXT_PROBE_SCAN_LIMIT || 50), 1), threads.length);
    const matches: ClaudeCodeContextProbeThreadMatch[] = [];

    for (const thread of threads.slice(0, maxThreads)) {
        if (Date.now() - startedAt > deadlineMs) break;
        const hits = matchClaudeCodeContextProbeInJsonl(thread.jsonlPath, normalizedProbe, { maxBytes: options.maxBytes });
        if (hits.length > 0) matches.push({ thread, hits });
    }
    return matches;
}

export function deepLocateClaudeCodeConversations(
    query: string,
    threads: ClaudeCodeThreadInfo[],
    options: ClaudeCodeDeepLocateOptions = {},
): ClaudeCodeDeepLocateResult {
    const mode = options.mode || "exact";
    const maxFiles = Math.max(1, options.maxFiles || 20);
    const maxBytes = Math.max(64 * 1024, options.maxBytes || 512 * 1024 * 1024);
    const maxHits = Math.max(1, options.maxHits || 20);
    const deadlineMs = Math.max(1000, options.deadlineMs || 5 * 60 * 1000);
    const startedAt = Date.now();
    const selected = threads.slice(0, maxFiles);
    const totalBytes = selected.reduce((sum, thread) => sum + (safeStat(thread.jsonlPath)?.size || 0), 0);
    const hits: ClaudeCodeDeepLocateHit[] = [];
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
        let roundIndex = 0;
        const result = readJsonlLines(thread.jsonlPath, (line, _lineNo, byteOffset) => {
            if (options.isCancelled?.()) {
                cancelled = true;
                return false;
            }
            if (Date.now() - startedAt > deadlineMs || hits.length >= maxHits) {
                budgetExhausted = true;
                return false;
            }
            const event = parseJsonLine(line);
            if (!event) return;
            if (event.type === "user") {
                const extracted = extractMessageContent(event.message?.content, event.cwd);
                if (extracted.toolResults.length === 0 || extracted.text) roundIndex += 1;
            }
            for (const item of searchableTextsFromEvent(event)) {
                const matched = mode === "exact"
                    ? normalizeProbeText(item.text).includes(normalizeProbeText(query))
                    : fuzzyContains(item.text, query);
                if (!matched) continue;
                hits.push({
                    conversationId: thread.id,
                    title: thread.title,
                    workspace: thread.cwd,
                    source: "message_body_hit",
                    mode,
                    roundIndex: Math.max(roundIndex, 1),
                    role: item.role,
                    filePath: thread.jsonlPath,
                    byteOffset,
                    snippet: makeSnippet(item.text, query),
                    freshness: "fresh",
                });
                if (hits.length >= maxHits) {
                    budgetExhausted = true;
                    return false;
                }
            }
        }, { maxBytes: Math.max(0, maxBytes - scannedBytes) });
        scannedBytes += result.scannedBytes;
        scannedFiles += 1;
        if (cancelled || budgetExhausted || scannedBytes >= maxBytes || Date.now() - startedAt > deadlineMs) {
            budgetExhausted = budgetExhausted || !cancelled;
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

    const status: ClaudeCodeDeepLocateResult["status"] = cancelled
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
