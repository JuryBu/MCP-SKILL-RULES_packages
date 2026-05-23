import path from "path";
import fs from "fs";
import Fuse from "fuse.js";
import {
    DATA_ROOT, WORKSPACES_DIR, GENERAL_DIR,
    writeJsonAtomic, writeTextAtomic,
    workspaceHash, findWorkspaceHash, listWorkspaceHashes,
    withIndexLock,
} from "./store.js";

/**
 * Record 存储层
 *
 * 管理 records/ 子目录下的对话记录文件：
 * - {workspaceHash}/records/{conversationId}.md
 * - {workspaceHash}/records/_records_index.json
 *
 * v1.8 新增
 */

// ============= 类型定义 =============

/** Record 索引条目 */
export interface RecordIndexEntry {
    conversationId: string;
    title: string;
    timeSpan: string;         // "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"
    totalRounds: number;
    totalSteps: number;
    lastUpdatedRound: number; // Record 覆盖到了第几轮
    lastUpdatedAt: string;    // ISO 时间
    phases: number;           // Phase 数量
    sizeBytes: number;
    tags?: string[];          // v1.8.1: 自动提取的标签
}

/** Record 索引文件 */
export interface RecordsIndex {
    version: number;
    records: Record<string, RecordIndexEntry>;
}

// ============= 路径工具 =============

/** 获取某工作区的 records/ 目录路径 */
function getRecordsDir(hash: string): string {
    const base = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    return path.join(base, "records");
}

/** 获取 Record 索引文件路径 */
function getRecordsIndexPath(hash: string): string {
    return path.join(getRecordsDir(hash), "_records_index.json");
}

/** 获取单个 Record 文件路径 */
function getRecordPath(hash: string, conversationId: string): string {
    return path.join(getRecordsDir(hash), `${conversationId}.md`);
}

// ============= 目录初始化 =============

/**
 * 确保指定工作区的 records/ 目录存在
 */
export function ensureRecordsDir(hash: string): void {
    const dir = getRecordsDir(hash);
    fs.mkdirSync(dir, { recursive: true });
}

// ============= 索引操作 =============

/**
 * 读取 Record 索引
 */
export function readRecordsIndex(hash: string): RecordsIndex {
    const indexPath = getRecordsIndexPath(hash);
    if (!fs.existsSync(indexPath)) {
        return { version: 1, records: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch {
        return { version: 1, records: {} };
    }
}

/**
 * 写入 Record 索引（原子写入，带锁）
 */
export async function writeRecordsIndex(hash: string, index: RecordsIndex): Promise<void> {
    await withIndexLock(`records_${hash}`, () => {
        ensureRecordsDir(hash);
        writeJsonAtomic(getRecordsIndexPath(hash), index);
    });
}

// ============= Record 文件操作 =============

/**
 * 读取 Record 内容
 * @returns Record markdown 内容，不存在返回 null
 */
export function readRecord(hash: string, conversationId: string): string | null {
    const filePath = getRecordPath(hash, conversationId);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
}

function getRecordSidecarPath(hash: string, conversationId: string, suffix: string): string {
    return path.join(getRecordsDir(hash), `${conversationId}.${suffix}`);
}

export function readRecordSidecar<T = unknown>(hash: string, conversationId: string, suffix: string): T | null {
    const filePath = getRecordSidecarPath(hash, conversationId, suffix);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return null;
    }
}

export async function writeRecordSidecar(hash: string, conversationId: string, suffix: string, data: unknown): Promise<void> {
    await withIndexLock(`record_sidecar_${hash}_${conversationId}_${suffix}`, () => {
        ensureRecordsDir(hash);
        writeJsonAtomic(getRecordSidecarPath(hash, conversationId, suffix), data);
    });
}

export async function deleteRecordSidecar(hash: string, conversationId: string, suffix: string): Promise<boolean> {
    const filePath = getRecordSidecarPath(hash, conversationId, suffix);
    if (!fs.existsSync(filePath)) return false;
    await withIndexLock(`record_sidecar_${hash}_${conversationId}_${suffix}`, () => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    return true;
}

/**
 * 写入 Record 文件 + 更新索引
 */
export async function writeRecord(
    hash: string,
    conversationId: string,
    content: string,
    meta: Partial<RecordIndexEntry>,
): Promise<void> {
    ensureRecordsDir(hash);
    const filePath = getRecordPath(hash, conversationId);
    writeTextAtomic(filePath, content);

    // 更新索引
    const index = readRecordsIndex(hash);
    const existing = index.records[conversationId] || {};
    index.records[conversationId] = {
        conversationId,
        title: meta.title || existing.title || "Untitled",
        timeSpan: meta.timeSpan || existing.timeSpan || "",
        totalRounds: meta.totalRounds ?? existing.totalRounds ?? 0,
        totalSteps: meta.totalSteps ?? existing.totalSteps ?? 0,
        lastUpdatedRound: meta.lastUpdatedRound ?? existing.lastUpdatedRound ?? 0,
        lastUpdatedAt: new Date().toISOString(),
        phases: meta.phases ?? existing.phases ?? 0,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
        tags: meta.tags || (existing as RecordIndexEntry).tags || [],
    };
    await writeRecordsIndex(hash, index);
}

/**
 * 复制 Record 到另一个 hash，尽量保留原索引元数据。
 * 用于归属修复的非破坏 copy/upsert；不会删除来源副本。
 */
export async function copyRecordToHash(
    sourceHash: string,
    targetHash: string,
    conversationId: string,
    metaPatch: Partial<RecordIndexEntry> = {},
    options: { backup?: boolean } = {},
): Promise<boolean> {
    const content = readRecord(sourceHash, conversationId);
    if (!content) return false;

    if (options.backup !== false) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.join(DATA_ROOT, "record-ownership-backups", `${stamp}_${conversationId.slice(0, 8)}_${sourceHash}_to_${targetHash}`);
        fs.mkdirSync(backupDir, { recursive: true });
        const sourcePath = getRecordPath(sourceHash, conversationId);
        const targetPath = getRecordPath(targetHash, conversationId);
        if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, path.join(backupDir, `${sourceHash}_${conversationId}.md`));
        if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, path.join(backupDir, `${targetHash}_${conversationId}.md`));
        const sourceIndexPath = getRecordsIndexPath(sourceHash);
        const targetIndexPath = getRecordsIndexPath(targetHash);
        if (fs.existsSync(sourceIndexPath)) fs.copyFileSync(sourceIndexPath, path.join(backupDir, `${sourceHash}_records_index.json`));
        if (fs.existsSync(targetIndexPath)) fs.copyFileSync(targetIndexPath, path.join(backupDir, `${targetHash}_records_index.json`));
    }

    ensureRecordsDir(targetHash);
    writeTextAtomic(getRecordPath(targetHash, conversationId), content);

    const sourceEntry = readRecordsIndex(sourceHash).records[conversationId];
    const targetIndex = readRecordsIndex(targetHash);
    const existing = targetIndex.records[conversationId] || {};
    const entry: RecordIndexEntry = {
        conversationId,
        title: metaPatch.title || sourceEntry?.title || existing.title || "Untitled",
        timeSpan: metaPatch.timeSpan || sourceEntry?.timeSpan || existing.timeSpan || "",
        totalRounds: metaPatch.totalRounds ?? sourceEntry?.totalRounds ?? existing.totalRounds ?? 0,
        totalSteps: metaPatch.totalSteps ?? sourceEntry?.totalSteps ?? existing.totalSteps ?? 0,
        lastUpdatedRound: metaPatch.lastUpdatedRound ?? sourceEntry?.lastUpdatedRound ?? existing.lastUpdatedRound ?? 0,
        lastUpdatedAt: metaPatch.lastUpdatedAt || sourceEntry?.lastUpdatedAt || existing.lastUpdatedAt || new Date().toISOString(),
        phases: metaPatch.phases ?? sourceEntry?.phases ?? existing.phases ?? 0,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
        tags: metaPatch.tags || sourceEntry?.tags || existing.tags || [],
    };
    targetIndex.records[conversationId] = entry;
    await writeRecordsIndex(targetHash, targetIndex);
    return true;
}

/**
 * 删除 Record 文件 + 更新索引
 */
export async function deleteRecord(hash: string, conversationId: string): Promise<boolean> {
    const filePath = getRecordPath(hash, conversationId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    const sidecarPrefix = path.join(getRecordsDir(hash), `${conversationId}.`);
    for (const item of fs.readdirSync(getRecordsDir(hash))) {
        const itemPath = path.join(getRecordsDir(hash), item);
        if (itemPath.startsWith(sidecarPrefix) && itemPath !== filePath) {
            try { fs.unlinkSync(itemPath); } catch { /* best effort */ }
        }
    }

    // 更新索引
    const index = readRecordsIndex(hash);
    delete index.records[conversationId];
    await writeRecordsIndex(hash, index);
    return true;
}

/**
 * 列出工作区下所有 Record 概览
 */
export function listRecords(hash: string): RecordIndexEntry[] {
    const index = readRecordsIndex(hash);
    return Object.values(index.records).sort(
        (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );
}

/**
 * 在 Record 中搜索关键词（grep 模式）
 * @returns 匹配结果数组
 */
export function searchRecords(
    query: string,
    hash: string,
): { conversationId: string; title: string; matches: { lineNum: number; line: string; context: string }[] }[] {
    const index = readRecordsIndex(hash);
    const results: ReturnType<typeof searchRecords> = [];
    const queryLower = query.toLowerCase();

    for (const [convId, entry] of Object.entries(index.records)) {
        const content = readRecord(hash, convId);
        if (!content) continue;

        const lines = content.split(/\r?\n/);
        const matches: { lineNum: number; line: string; context: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
                // 前后各 2 行上下文
                const ctxStart = Math.max(0, i - 2);
                const ctxEnd = Math.min(lines.length - 1, i + 2);
                const context = lines.slice(ctxStart, ctxEnd + 1).join("\n");
                matches.push({ lineNum: i + 1, line: lines[i], context });
            }
        }

        if (matches.length > 0) {
            results.push({ conversationId: convId, title: entry.title, matches });
        }
    }

    // 按匹配数降序
    results.sort((a, b) => b.matches.length - a.matches.length);
    return results;
}

/**
 * 搜索所有工作区的 Record（全局搜索）
 */
export function searchRecordsGlobal(
    query: string,
): { hash: string; conversationId: string; title: string; matchCount: number }[] {
    const results: ReturnType<typeof searchRecordsGlobal> = [];

    // general
    const generalResults = searchRecords(query, "general");
    for (const r of generalResults) {
        results.push({ hash: "general", conversationId: r.conversationId, title: r.title, matchCount: r.matches.length });
    }

    // 所有工作区
    const wsDir = WORKSPACES_DIR;
    if (fs.existsSync(wsDir)) {
        for (const h of fs.readdirSync(wsDir)) {
            if (!fs.statSync(path.join(wsDir, h)).isDirectory()) continue;
            const wsResults = searchRecords(query, h);
            for (const r of wsResults) {
                results.push({ hash: h, conversationId: r.conversationId, title: r.title, matchCount: r.matches.length });
            }
        }
    }

    results.sort((a, b) => b.matchCount - a.matchCount);
    return results;
}

/**
 * 统计工作区 Record 数量
 */
export function countRecords(hash: string): number {
    const index = readRecordsIndex(hash);
    return Object.keys(index.records).length;
}

/**
 * 解析工作区路径得到 hash（兼容 workspace 参数）
 * 如果传入的是已有工作区路径，返回 hash；否则返回 null
 */
export function resolveWorkspaceHashForRecord(workspace?: string): string {
    if (!workspace) return "general";
    return findWorkspaceHash(workspace) || workspaceHash(workspace);
}

/**
 * 查找某个 conversationId 的 Record 存在于哪个 hash 下
 * 遍历所有工作区+general 的 records 索引；同一对话多处存在时返回最新版本。
 */
export function findRecordHash(conversationId: string): string | null {
    let best: { hash: string; updatedAt: number; coveredRounds: number; sizeBytes: number } | null = null;
    const hashes = ["general", ...listWorkspaceHashes()];

    for (const hash of hashes) {
        const idx = readRecordsIndex(hash);
        const entry = idx.records[conversationId];
        if (!entry) continue;
        const updatedAt = Date.parse(entry.lastUpdatedAt || "") || 0;
        const coveredRounds = entry.lastUpdatedRound || entry.totalRounds || 0;
        const sizeBytes = entry.sizeBytes || 0;
        if (
            !best ||
            coveredRounds > best.coveredRounds ||
            (coveredRounds === best.coveredRounds && updatedAt > best.updatedAt) ||
            (coveredRounds === best.coveredRounds && updatedAt === best.updatedAt && sizeBytes > best.sizeBytes)
        ) {
            best = { hash, updatedAt, coveredRounds, sizeBytes };
        }
    }

    return best?.hash || null;
}

/**
 * 解析 Record conversationId。支持完整 ID、唯一前缀，以及标题精确匹配。
 */
export function resolveRecordConversationId(input: string, preferredHash?: string): string | null {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();
    const hashes = [
        ...(preferredHash ? [preferredHash] : []),
        "general",
        ...listWorkspaceHashes(),
    ].filter((hash, index, arr) => hash && arr.indexOf(hash) === index);

    const entries: RecordIndexEntry[] = [];
    for (const hash of hashes) {
        const idx = readRecordsIndex(hash);
        entries.push(...Object.values(idx.records));
    }

    const exact = entries.find((entry) => entry.conversationId === query);
    if (exact) return exact.conversationId;

    const prefixMatches = entries.filter((entry) => entry.conversationId.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].conversationId;

    const titleMatches = entries.filter((entry) => entry.title.toLowerCase() === queryLower);
    if (titleMatches.length === 1) return titleMatches[0].conversationId;

    return null;
}

/**
 * 模糊搜索 Record（Fuse.js）
 * 搜索字段：conversationId 前8位、title、tags、正文前500字
 */
export function fuzzySearchRecords(
    query: string,
    hash: string,
    limit = 10,
): { conversationId: string; title: string; tags: string[]; score: number; preview: string }[] {
    const index = readRecordsIndex(hash);
    const entries = Object.values(index.records).map(rec => {
        const content = readRecord(hash, rec.conversationId);
        return {
            id: rec.conversationId,
            shortId: rec.conversationId.slice(0, 8),
            title: rec.title,
            tagsStr: (rec.tags || []).join(" "),
            preview: (content || "").slice(0, 500),
            tags: rec.tags || [],
        };
    });

    if (entries.length === 0) return [];

    const fuse = new Fuse(entries, {
        keys: [
            { name: "shortId", weight: 0.1 },
            { name: "title", weight: 0.3 },
            { name: "tagsStr", weight: 0.4 },
            { name: "preview", weight: 0.2 },
        ],
        threshold: 0.4,
        includeScore: true,
    });

    const results = fuse.search(query, { limit });
    return results.map((r: any) => ({
        conversationId: r.item.id,
        title: r.item.title,
        tags: r.item.tags,
        score: r.score ?? 1,
        preview: r.item.preview.slice(0, 100),
    }));
}
