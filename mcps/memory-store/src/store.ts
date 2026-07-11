import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { indexCache, type WorkspaceIndex, type MemoryIndexEntry } from "./cache.js";

/**
 * MCP Memory Store 存储引擎
 * 
 * 核心职责：
 * - 数据目录的初始化和管理
 * - 工作区路径 → SHA256 hash 映射
 * - _global_index.json / _meta.json / _index.json 读写
 * - 记忆文件的 CRUD（YAML frontmatter + markdown）
 * - 并发安全（tmp + rename 原子写入）
 * - 与 LRU 缓存协同工作
 */

// ============= 路径常量 =============

const TOOLKIT_DATA_ROOT = process.env.CODEX_TOOLKIT_DATA_ROOT
    || path.join(os.homedir(), ".codex-toolkit");
const DATA_ROOT = process.env.MEMORY_STORE_DATA_ROOT
    || path.join(TOOLKIT_DATA_ROOT, "memory-store");
const WORKSPACES_DIR = path.join(DATA_ROOT, "workspaces");
const GENERAL_DIR = path.join(DATA_ROOT, "general");
const GLOBAL_INDEX_PATH = path.join(DATA_ROOT, "_global_index.json");
const CONFIG_PATH = path.join(DATA_ROOT, "config.json");

export { DATA_ROOT, WORKSPACES_DIR, GENERAL_DIR, GLOBAL_INDEX_PATH };

// ============= 类型定义 =============

/** 全局索引中的工作区摘要 */
export interface WorkspaceSummary {
    name: string;
    originalPath: string;
    canonicalPath?: string;
    aliases?: string[];
    memoryCount: number;
    totalSizeBytes: number;
    lastAccessed: string;
    isArchived: boolean;
    topTags: string[];
}

/** 全局索引 (_global_index.json) */
export interface GlobalIndex {
    version: number;
    lastUpdated: string;
    workspaces: Record<string, WorkspaceSummary>;
    generalCount: number;
}

/** 工作区元信息 (_meta.json) */
export interface WorkspaceMeta {
    hash: string;
    originalPath: string;
    canonicalPath?: string;
    aliases?: string[];
    name: string;
    createdAt: string;
    lastAccessed: string;
    isArchived: boolean;
}

/** 记忆文件的 frontmatter 数据 */
export interface MemoryFrontmatter {
    id: string;
    title: string;
    tags: string[];
    category: string;
    created: string;
    updated: string;
    workspace: string;
    conversationId?: string;
    searchSummary: string;
    autoSummary?: string;  // v1.5: Flash 自动生成的搜索摘要
    pinned?: boolean;
}

/** 默认配置 */
export interface StoreConfig {
    version: number;
    defaultWorkspace: string | null;
    lruCacheSize: number;
    maxEntrySize: number;        // 字节，默认 15KB
    tempTTL: number;             // 毫秒
    archiveAfterDays: number;
}

const DEFAULT_CONFIG: StoreConfig = {
    version: 1,
    defaultWorkspace: null,
    lruCacheSize: 5,
    maxEntrySize: 15360,         // 15KB
    tempTTL: 3600000,            // 1 小时
    archiveAfterDays: 90,
};

// ============= 工作区 Hash =============

/**
 * 将工作区路径转换为 SHA256 前 8 位 hash
 * 规范化：Windows long-path 前缀、分隔符、盘符大小写、尾部分隔符等路径表示差异不应生成不同 workspace。
 */
export function workspaceHash(workspacePath: string): string {
    const normalized = canonicalWorkspacePath(workspacePath);
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/**
 * 生成用于 workspace 身份判断的保守规范化路径。
 * 只处理确定安全的词法别名；symlink/junction/subst 等真实对象身份留给后续 resolver 扩展。
 */
export function canonicalWorkspacePath(workspacePath: string): string {
    let value = workspacePath.trim();
    if (!value) return "";

    try {
        if (/^file:\/\//iu.test(value)) value = fileURLToPath(value);
    } catch {
        // 保守降级：不是合法 file URL 时继续按普通路径处理
    }

    value = value.replace(/\//g, "\\");
    if (/^\\\\\?\\UNC\\/iu.test(value)) {
        value = `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
    } else if (/^\\\\\?\\/u.test(value)) {
        value = value.slice("\\\\?\\".length);
    }

    value = path.win32.normalize(value);
    value = value.replace(/\\/g, "/").replace(/\/+$/u, "");
    value = value.replace(/^([A-Z]):/u, (_, drive: string) => `${drive.toLowerCase()}:`);
    return value.toLowerCase();
}

function legacyWorkspaceHashCandidates(workspacePath: string): string[] {
    const legacy = workspacePath
        .toLowerCase()
        .replace(/\\/g, "/")
        .replace(/\/+$/u, "");
    const legacyHash = crypto.createHash("sha256").update(legacy).digest("hex").slice(0, 8);
    const canonicalHash = workspaceHash(workspacePath);
    return [canonicalHash, legacyHash].filter((hash, index, arr) => hash && arr.indexOf(hash) === index);
}

function rememberWorkspaceAlias(hash: string, workspacePath: string): void {
    const meta = readWorkspaceMeta(hash);
    if (meta) {
        const aliases = new Set([...(meta.aliases || []), workspacePath]);
        meta.canonicalPath = meta.canonicalPath || canonicalWorkspacePath(meta.originalPath);
        meta.aliases = Array.from(aliases);
        writeWorkspaceMeta(hash, meta);
    }

    const globalIndex = readGlobalIndex();
    const summary = globalIndex.workspaces[hash];
    if (summary) {
        const aliases = new Set([...(summary.aliases || []), workspacePath]);
        summary.canonicalPath = summary.canonicalPath || canonicalWorkspacePath(summary.originalPath);
        summary.aliases = Array.from(aliases);
        summary.lastAccessed = new Date().toISOString();
        writeGlobalIndex(globalIndex);
    }
}

/**
 * 从 title 生成 ID 中的 slug 部分
 * 取前 2-3 个中文字或英文单词，去特殊字符
 */
function generateSlug(title: string): string {
    // 提取中文字符
    const chineseChars = title.match(/[\u4e00-\u9fff]/g);
    if (chineseChars && chineseChars.length >= 2) {
        return chineseChars.slice(0, 4).join("");
    }

    // 提取英文单词
    const words = title.match(/[a-zA-Z0-9]+/g);
    if (words && words.length > 0) {
        return words.slice(0, 3).join("-").toLowerCase();
    }

    // 兜底：用时间戳后 4 位
    return String(Date.now()).slice(-4);
}

/**
 * 生成记忆 ID
 * 格式：YYYYMMDD-HHmmssSSS-slug（含毫秒防碰撞）
 */
export function generateMemoryId(title: string, now?: Date): string {
    const d = now || new Date();
    const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const timePart = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}${String(d.getMilliseconds()).padStart(3, "0")}`;
    const slug = generateSlug(title);
    return `${datePart}-${timePart}-${slug}`;
}

// ============= 数据目录初始化 =============

/**
 * 确保数据目录完整存在
 * MCP 启动时调用，首次使用时自动创建
 */
export function ensureDataDirs(): void {
    // 创建根目录
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    fs.mkdirSync(path.join(DATA_ROOT, "temp"), { recursive: true });

    // general 目录
    fs.mkdirSync(GENERAL_DIR, { recursive: true });
    fs.mkdirSync(path.join(GENERAL_DIR, "entries"), { recursive: true });
    fs.mkdirSync(path.join(GENERAL_DIR, "records"), { recursive: true });

    // 初始化 _global_index.json
    if (!fs.existsSync(GLOBAL_INDEX_PATH)) {
        const initialIndex: GlobalIndex = {
            version: 1,
            lastUpdated: new Date().toISOString(),
            workspaces: {},
            generalCount: 0,
        };
        writeJsonAtomic(GLOBAL_INDEX_PATH, initialIndex);
    }

    // 初始化 config.json
    if (!fs.existsSync(CONFIG_PATH)) {
        writeJsonAtomic(CONFIG_PATH, DEFAULT_CONFIG);
    }

    // 初始化 general/_index.json
    const generalIndexPath = path.join(GENERAL_DIR, "_index.json");
    if (!fs.existsSync(generalIndexPath)) {
        const initialWsIndex: WorkspaceIndex = { version: 1, entries: [] };
        writeJsonAtomic(generalIndexPath, initialWsIndex);
    }

    console.error(`[memory-store] 数据目录已就绪: ${DATA_ROOT}`);
}

// ============= 原子写入 =============

/** 唯一临时文件名：带 pid + 随机后缀，防两个进程（四源）的临时文件互相覆盖。 */
function uniqueTmpPath(filePath: string): string {
    return `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
}

/** 同步阻塞睡眠（不空转 CPU）；用于 rename 重试的指数退避。写路径本就是同步调用，短暂阻塞可接受。 */
function sleepSyncMs(ms: number): void {
    if (ms <= 0) return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const until = Date.now() + ms;
        while (Date.now() < until) { /* fallback spin */ }
    }
}

/** rename 重试：Windows 上目标被另一进程短暂占用（读取/杀软扫描）时 renameSync 偶发 EPERM/EACCES/EBUSY，
 *  指数退避重试几次（总时长 ~150ms，远低于任何超时）；只对这几类瞬时错误重试，其它错误立即抛。
 *  终态失败时尽量清掉临时文件、不留垃圾。 */
function renameWithRetry(tmpPath: string, filePath: string): void {
    const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(tmpPath, filePath);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (!code || !transient.has(code) || attempt >= maxAttempts) {
                try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
                throw err;
            }
            sleepSyncMs(10 * Math.pow(2, attempt - 1)); // 10/20/40/80ms
        }
    }
}

export async function renameWithRetryAsync(tmpPath: string, filePath: string): Promise<void> {
    const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
        try {
            await fs.promises.rename(tmpPath, filePath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (!code || !transient.has(code) || attempt >= maxAttempts) {
                try { await fs.promises.rm(tmpPath, { force: true }); } catch {}
                throw error;
            }
            await sleep(10 * Math.pow(2, attempt - 1));
        }
    }
}

function atomicWrite(filePath: string, content: string): void {
    const tmpPath = uniqueTmpPath(filePath);
    fs.writeFileSync(tmpPath, content, "utf-8");
    renameWithRetry(tmpPath, filePath);
}

async function atomicWriteAsync(filePath: string, content: string): Promise<void> {
    const tmpPath = uniqueTmpPath(filePath);
    await fs.promises.writeFile(tmpPath, content, "utf-8");
    await renameWithRetryAsync(tmpPath, filePath);
}

/**
 * 原子写入 JSON 文件（唯一 tmp + rename 重试）
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
    atomicWrite(filePath, JSON.stringify(data, null, 2));
}

export async function writeJsonAtomicAsync(filePath: string, data: unknown): Promise<void> {
    await atomicWriteAsync(filePath, JSON.stringify(data, null, 2));
}

/**
 * 原子写入文本文件（唯一 tmp + rename 重试）
 */
export function writeTextAtomic(filePath: string, content: string): void {
    atomicWrite(filePath, content);
}

export async function writeTextAtomicAsync(filePath: string, content: string): Promise<void> {
    await atomicWriteAsync(filePath, content);
}

// ============= 进程内索引锁 =============
// 防止同一工作区的索引 read-modify-write 被并发破坏

const indexLocks = new Map<string, Promise<void>>();

/**
 * 对指定 key（hash 或 "global"）串行化 async 回调
 * 保证同一 key 的索引操作不会交叉执行
 */
export async function withIndexLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = indexLocks.get(key) || Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    indexLocks.set(key, next);
    try {
        await prev;
        return await fn();
    } finally {
        resolve!();
        // 清理已完成的锁避免内存泄漏
        if (indexLocks.get(key) === next) indexLocks.delete(key);
    }
}

/** 全局索引专用锁 */
export async function withGlobalIndexLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return withIndexLock("__global__", fn);
}

// ============= 全局索引操作 =============

/**
 * 读取全局索引
 */
export function readGlobalIndex(): GlobalIndex {
    if (!fs.existsSync(GLOBAL_INDEX_PATH)) {
        return { version: 1, lastUpdated: new Date().toISOString(), workspaces: {}, generalCount: 0 };
    }
    return JSON.parse(fs.readFileSync(GLOBAL_INDEX_PATH, "utf-8"));
}

/**
 * 写入全局索引（原子写入）
 */
export function writeGlobalIndex(index: GlobalIndex): void {
    index.lastUpdated = new Date().toISOString();
    writeJsonAtomic(GLOBAL_INDEX_PATH, index);
}

async function readGlobalIndexAsync(): Promise<GlobalIndex> {
    try {
        return JSON.parse(await fs.promises.readFile(GLOBAL_INDEX_PATH, "utf-8")) as GlobalIndex;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return { version: 1, lastUpdated: new Date().toISOString(), workspaces: {}, generalCount: 0 };
        }
        throw error;
    }
}

async function writeGlobalIndexAsync(index: GlobalIndex): Promise<void> {
    index.lastUpdated = new Date().toISOString();
    await writeJsonAtomicAsync(GLOBAL_INDEX_PATH, index);
}

async function pathExistsAsync(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
    }
}

async function readWorkspaceMetaAsync(hash: string): Promise<WorkspaceMeta | null> {
    const metaPath = path.join(WORKSPACES_DIR, hash, "_meta.json");
    try {
        return JSON.parse(await fs.promises.readFile(metaPath, "utf-8")) as WorkspaceMeta;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
    }
}

// ============= 工作区操作 =============

/**
 * 确保工作区目录存在，不存在则创建
 * @returns 工作区目录路径
 */
export function ensureWorkspace(workspacePath: string): { hash: string; dir: string } {
    const hash = workspaceHash(workspacePath);
    const wsDir = path.join(WORKSPACES_DIR, hash);
    const entriesDir = path.join(wsDir, "entries");
    const indexPath = path.join(wsDir, "_index.json");
    const metaPath = path.join(wsDir, "_meta.json");

    // 创建目录
    fs.mkdirSync(entriesDir, { recursive: true });

    // 初始化 _meta.json
    if (!fs.existsSync(metaPath)) {
        const meta: WorkspaceMeta = {
            hash,
            originalPath: workspacePath,
            canonicalPath: canonicalWorkspacePath(workspacePath),
            aliases: [workspacePath],
            name: path.basename(workspacePath),
            createdAt: new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
            isArchived: false,
        };
        writeJsonAtomic(metaPath, meta);
    }

    // 初始化 _index.json
    if (!fs.existsSync(indexPath)) {
        const wsIndex: WorkspaceIndex = { version: 1, entries: [] };
        writeJsonAtomic(indexPath, wsIndex);
    }

    // 更新全局索引
    const globalIndex = readGlobalIndex();
    if (!globalIndex.workspaces[hash]) {
        globalIndex.workspaces[hash] = {
            name: path.basename(workspacePath),
            originalPath: workspacePath,
            canonicalPath: canonicalWorkspacePath(workspacePath),
            aliases: [workspacePath],
            memoryCount: 0,
            totalSizeBytes: 0,
            lastAccessed: new Date().toISOString(),
            isArchived: false,
            topTags: [],
        };
        writeGlobalIndex(globalIndex);
    } else {
        rememberWorkspaceAlias(hash, workspacePath);
    }

    return { hash, dir: wsDir };
}

export async function ensureWorkspaceAsync(workspacePath: string): Promise<{ hash: string; dir: string }> {
    const hash = workspaceHash(workspacePath);
    const wsDir = path.join(WORKSPACES_DIR, hash);
    const entriesDir = path.join(wsDir, "entries");
    const indexPath = path.join(wsDir, "_index.json");
    const metaPath = path.join(wsDir, "_meta.json");

    await withIndexLock(`workspace_setup_${hash}`, async () => {
        await fs.promises.mkdir(entriesDir, { recursive: true });
        const meta = await readWorkspaceMetaAsync(hash);
        if (!meta) {
            await writeJsonAtomicAsync(metaPath, {
                hash,
                originalPath: workspacePath,
                canonicalPath: canonicalWorkspacePath(workspacePath),
                aliases: [workspacePath],
                name: path.basename(workspacePath),
                createdAt: new Date().toISOString(),
                lastAccessed: new Date().toISOString(),
                isArchived: false,
            } satisfies WorkspaceMeta);
        } else {
            const aliases = new Set([...(meta.aliases || []), workspacePath]);
            const nextAliases = Array.from(aliases);
            if (nextAliases.length !== (meta.aliases || []).length || !meta.canonicalPath) {
                meta.canonicalPath = meta.canonicalPath || canonicalWorkspacePath(meta.originalPath);
                meta.aliases = nextAliases;
                await writeJsonAtomicAsync(metaPath, meta);
            }
        }
        if (!await pathExistsAsync(indexPath)) {
            await writeJsonAtomicAsync(indexPath, { version: 1, entries: [] } satisfies WorkspaceIndex);
        }
    });

    await withGlobalIndexLock(async () => {
        const globalIndex = await readGlobalIndexAsync();
        const summary = globalIndex.workspaces[hash];
        if (!summary) {
            globalIndex.workspaces[hash] = {
                name: path.basename(workspacePath),
                originalPath: workspacePath,
                canonicalPath: canonicalWorkspacePath(workspacePath),
                aliases: [workspacePath],
                memoryCount: 0,
                totalSizeBytes: 0,
                lastAccessed: new Date().toISOString(),
                isArchived: false,
                topTags: [],
            };
        } else {
            const aliases = new Set([...(summary.aliases || []), workspacePath]);
            summary.canonicalPath = summary.canonicalPath || canonicalWorkspacePath(summary.originalPath);
            summary.aliases = Array.from(aliases);
            summary.lastAccessed = new Date().toISOString();
        }
        await writeGlobalIndexAsync(globalIndex);
    });

    return { hash, dir: wsDir };
}

/**
 * 读取工作区索引（优先从 LRU 缓存获取）
 */
export function readWorkspaceIndex(hash: string): WorkspaceIndex {
    // general 区域有独立路径，统一走 readGeneralIndex 避免路径错误
    if (hash === "general") return readGeneralIndex();

    // 先查缓存
    const cached = indexCache.get(hash);
    if (cached) return cached;

    // 缓存未命中，从文件加载
    const indexPath = path.join(WORKSPACES_DIR, hash, "_index.json");
    if (!fs.existsSync(indexPath)) {
        return { version: 1, entries: [] };
    }

    const index: WorkspaceIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    indexCache.set(hash, index); // 放入缓存
    return index;
}

/**
 * 读取 general 区域的索引
 */
export function readGeneralIndex(): WorkspaceIndex {
    const cached = indexCache.get("general");
    if (cached) return cached;

    const indexPath = path.join(GENERAL_DIR, "_index.json");
    if (!fs.existsSync(indexPath)) {
        return { version: 1, entries: [] };
    }

    const index: WorkspaceIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    indexCache.set("general", index);
    return index;
}

/**
 * 写入工作区索引（原子写入 + 更新缓存）
 */
export function writeWorkspaceIndex(hash: string, index: WorkspaceIndex): void {
    const dir = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    const indexPath = path.join(dir, "_index.json");
    writeJsonAtomic(indexPath, index);
    indexCache.set(hash, index); // 更新缓存
}

/**
 * 串行化的索引「读→改→写」：把读取、修改、写回整段塞进同一把 per-hash 锁，杜绝并发 read-modify-write
 * 互相覆盖导致的静默丢条目（write/update/delete/batch 的裸奔读改写都应改走这里）。
 * mutator 拿到的是深拷贝草稿——不碰缓存里的 ref，并发只读者看到的快照始终完整；改完由 writeWorkspaceIndex
 * 原子替换缓存并落盘。⚠️ 只取 per-hash 一把锁，mutator 内部不得再抢全局/别的索引锁，避免锁嵌套死锁。
 */
export async function mutateWorkspaceIndex(
    hash: string,
    mutator: (index: WorkspaceIndex) => void | Promise<void>,
): Promise<void> {
    await withIndexLock(hash, async () => {
        const current = hash === "general" ? readGeneralIndex() : readWorkspaceIndex(hash);
        const draft: WorkspaceIndex = structuredClone(current);
        await mutator(draft);
        writeWorkspaceIndex(hash, draft);
    });
}

/**
 * 读取工作区元信息
 */
export function readWorkspaceMeta(hash: string): WorkspaceMeta | null {
    const metaPath = path.join(WORKSPACES_DIR, hash, "_meta.json");
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
}

/**
 * 写入工作区元信息
 */
export function writeWorkspaceMeta(hash: string, meta: WorkspaceMeta): void {
    const metaPath = path.join(WORKSPACES_DIR, hash, "_meta.json");
    writeJsonAtomic(metaPath, meta);
}

/**
 * 通过原始路径查找工作区 hash
 */
export function findWorkspaceHash(workspacePath: string): string | null {
    const targetCanonical = canonicalWorkspacePath(workspacePath);
    for (const hash of legacyWorkspaceHashCandidates(workspacePath)) {
        const wsDir = path.join(WORKSPACES_DIR, hash);
        if (fs.existsSync(wsDir)) return hash;
    }
    for (const hash of listWorkspaceHashes()) {
        const meta = readWorkspaceMeta(hash);
        if (!meta) continue;
        const candidates = [meta.originalPath, meta.canonicalPath || "", ...(meta.aliases || [])].filter(Boolean);
        if (candidates.some(candidate => canonicalWorkspacePath(candidate) === targetCanonical)) return hash;
    }
    return null;
}

/**
 * 获取所有工作区 hash 列表
 */
export function listWorkspaceHashes(): string[] {
    if (!fs.existsSync(WORKSPACES_DIR)) return [];
    return fs.readdirSync(WORKSPACES_DIR).filter(entry => {
        return fs.statSync(path.join(WORKSPACES_DIR, entry)).isDirectory();
    });
}

export async function listWorkspaceHashesAsync(): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
        return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw error;
    }
}

// ============= 记忆文件操作 =============

/**
 * 获取记忆文件路径
 */
export function getEntryPath(hash: string, memoryId: string): string {
    const dir = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    return path.join(dir, "entries", `${memoryId}.md`);
}

/**
 * 构建 YAML frontmatter + markdown 内容
 */
export function buildMemoryFile(frontmatter: MemoryFrontmatter, body: string): string {
    const yamlLines = [
        "---",
        `id: ${frontmatter.id}`,
        `title: "${frontmatter.title.replace(/"/g, '\\"')}"`,
        `tags: [${frontmatter.tags.map(t => `"${t}"`).join(", ")}]`,
        `category: ${frontmatter.category}`,
        `created: ${frontmatter.created}`,
        `updated: ${frontmatter.updated}`,
        `workspace: ${frontmatter.workspace}`,
    ];

    if (frontmatter.conversationId) {
        yamlLines.push(`conversationId: ${frontmatter.conversationId}`);
    }
    if (frontmatter.pinned) {
        yamlLines.push(`pinned: true`);
    }

    yamlLines.push(`searchSummary: >`);
    const summaryLines = frontmatter.searchSummary.split("\n").map(l => `  ${l}`);
    yamlLines.push(...summaryLines);

    // v1.5: autoSummary（Flash 自动生成）
    if (frontmatter.autoSummary) {
        yamlLines.push(`autoSummary: >`);
        const autoLines = frontmatter.autoSummary.split("\n").map(l => `  ${l}`);
        yamlLines.push(...autoLines);
    }

    yamlLines.push("---");
    yamlLines.push("");
    yamlLines.push(body);

    return yamlLines.join("\n");
}

/**
 * 解析记忆文件的 frontmatter 和正文
 */
export function parseMemoryFile(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return null;

    const yamlBlock = match[1];
    const body = match[2];

    // 简单 YAML 解析（不引入额外依赖）
    const frontmatter: Record<string, unknown> = {};
    const lines = yamlBlock.split(/\r?\n/);
    let currentKey = "";
    let currentMultiline = "";

    for (const line of lines) {
        // 多行值继续（缩进的行）
        if (currentKey && line.startsWith("  ")) {
            currentMultiline += (currentMultiline ? "\n" : "") + line.slice(2);
            continue;
        }

        // 保存之前的多行值
        if (currentKey && currentMultiline) {
            frontmatter[currentKey] = currentMultiline;
            currentKey = "";
            currentMultiline = "";
        }

        const kvMatch = line.match(/^(\w+):\s*(.*)$/);
        if (!kvMatch) continue;

        const [, key, rawValue] = kvMatch;
        const value = rawValue.trim();

        if (value === ">" || value === "|") {
            // 多行值开始
            currentKey = key;
            currentMultiline = "";
        } else if (value.startsWith("[") && value.endsWith("]")) {
            // 数组值：[tag1, tag2]
            const inner = value.slice(1, -1);
            frontmatter[key] = inner
                .split(",")
                .map(s => s.trim().replace(/^["']|["']$/g, ""))
                .filter(s => s.length > 0);
        } else if (value.startsWith('"') && value.endsWith('"')) {
            // 引号字符串
            frontmatter[key] = value.slice(1, -1).replace(/\\"/g, '"');
        } else if (value === "true") {
            frontmatter[key] = true;
        } else if (value === "false") {
            frontmatter[key] = false;
        } else {
            frontmatter[key] = value;
        }
    }

    // 保存最后的多行值
    if (currentKey && currentMultiline) {
        frontmatter[currentKey] = currentMultiline;
    }

    return { frontmatter, body };
}

/**
 * 读取记忆文件原始内容
 */
export function readMemoryFile(hash: string, memoryId: string): string | null {
    const filePath = getEntryPath(hash, memoryId);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
}

/**
 * 写入记忆文件（原子写入）
 */
export function writeMemoryFile(hash: string, memoryId: string, content: string): void {
    const filePath = getEntryPath(hash, memoryId);
    // 确保 entries 目录存在
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextAtomic(filePath, content);
}

/**
 * 删除记忆文件
 */
export function deleteMemoryFile(hash: string, memoryId: string): boolean {
    const filePath = getEntryPath(hash, memoryId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
}

/**
 * 在索引中查找记忆，跨所有工作区
 * @returns { hash, entry } 或 null
 */
export function findMemoryById(memoryId: string): { hash: string; entry: MemoryIndexEntry } | null {
    // 先查 general
    const generalIndex = readGeneralIndex();
    const generalEntry = generalIndex.entries.find(e => e.id === memoryId);
    if (generalEntry) return { hash: "general", entry: generalEntry };

    // 再查所有工作区
    const hashes = listWorkspaceHashes();
    for (const hash of hashes) {
        const wsIndex = readWorkspaceIndex(hash);
        const entry = wsIndex.entries.find(e => e.id === memoryId);
        if (entry) return { hash, entry };
    }

    return null;
}

/**
 * 更新全局索引中某工作区的统计信息
 *
 * 并发安全：整段「读全局索引 → 改 → 写」塞进 withGlobalIndexLock（独立 key "__global__"）串行化，
 * 杜绝多个写操作并发 read-modify-write 互相覆盖导致的全局统计静默错乱。
 * ⚠️ 死锁约束：本函数必须在 per-hash 锁（mutateWorkspaceIndex）返回**之后**调用——
 * 二者用不同 key（per-hash vs "__global__"），无锁嵌套、无 ABBA 死锁。
 */
export async function syncGlobalIndexForWorkspace(hash: string): Promise<void> {
    await withGlobalIndexLock(() => {
        const globalIndex = readGlobalIndex();
        const wsIndex = readWorkspaceIndex(hash);
        const meta = hash === "general" ? null : readWorkspaceMeta(hash);

        if (hash === "general") {
            globalIndex.generalCount = wsIndex.entries.length;
        } else if (globalIndex.workspaces[hash]) {
            const ws = globalIndex.workspaces[hash];
            ws.memoryCount = wsIndex.entries.length;
            ws.totalSizeBytes = wsIndex.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
            ws.lastAccessed = new Date().toISOString();
            ws.isArchived = meta?.isArchived ?? false;

            // 统计 topTags
            const tagCount = new Map<string, number>();
            for (const entry of wsIndex.entries) {
                for (const tag of entry.tags) {
                    tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
                }
            }
            ws.topTags = Array.from(tagCount.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([tag]) => tag);
        }

        writeGlobalIndex(globalIndex);
    });
}

/**
 * 获取记忆文件的行数
 */
export function countLines(content: string): number {
    return content.split(/\r?\n/).length;
}

/**
 * 读取配置
 */
export function readConfig(): StoreConfig {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}
