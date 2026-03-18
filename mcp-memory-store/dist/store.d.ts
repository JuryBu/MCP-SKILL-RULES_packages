import { type WorkspaceIndex, type MemoryIndexEntry } from "./cache.js";
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
declare const DATA_ROOT: string;
declare const WORKSPACES_DIR: string;
declare const GENERAL_DIR: string;
declare const GLOBAL_INDEX_PATH: string;
export { DATA_ROOT, WORKSPACES_DIR, GENERAL_DIR, GLOBAL_INDEX_PATH };
/** 全局索引中的工作区摘要 */
export interface WorkspaceSummary {
    name: string;
    originalPath: string;
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
    autoSummary?: string;
    pinned?: boolean;
}
/** 默认配置 */
export interface StoreConfig {
    version: number;
    defaultWorkspace: string | null;
    lruCacheSize: number;
    maxEntrySize: number;
    tempTTL: number;
    archiveAfterDays: number;
}
/**
 * 将工作区路径转换为 SHA256 前 8 位 hash
 * 规范化：小写 + 正斜杠 + 去尾部斜杠
 */
export declare function workspaceHash(workspacePath: string): string;
/**
 * 生成记忆 ID
 * 格式：YYYYMMDD-HHmmssSSS-slug（含毫秒防碰撞）
 */
export declare function generateMemoryId(title: string, now?: Date): string;
/**
 * 确保数据目录完整存在
 * MCP 启动时调用，首次使用时自动创建
 */
export declare function ensureDataDirs(): void;
/**
 * 原子写入 JSON 文件（tmp + rename）
 */
export declare function writeJsonAtomic(filePath: string, data: unknown): void;
/**
 * 原子写入文本文件（tmp + rename）
 */
export declare function writeTextAtomic(filePath: string, content: string): void;
/**
 * 对指定 key（hash 或 "global"）串行化 async 回调
 * 保证同一 key 的索引操作不会交叉执行
 */
export declare function withIndexLock<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
/** 全局索引专用锁 */
export declare function withGlobalIndexLock<T>(fn: () => T | Promise<T>): Promise<T>;
/**
 * 读取全局索引
 */
export declare function readGlobalIndex(): GlobalIndex;
/**
 * 写入全局索引（原子写入）
 */
export declare function writeGlobalIndex(index: GlobalIndex): void;
/**
 * 确保工作区目录存在，不存在则创建
 * @returns 工作区目录路径
 */
export declare function ensureWorkspace(workspacePath: string): {
    hash: string;
    dir: string;
};
/**
 * 读取工作区索引（优先从 LRU 缓存获取）
 */
export declare function readWorkspaceIndex(hash: string): WorkspaceIndex;
/**
 * 读取 general 区域的索引
 */
export declare function readGeneralIndex(): WorkspaceIndex;
/**
 * 写入工作区索引（原子写入 + 更新缓存）
 */
export declare function writeWorkspaceIndex(hash: string, index: WorkspaceIndex): void;
/**
 * 读取工作区元信息
 */
export declare function readWorkspaceMeta(hash: string): WorkspaceMeta | null;
/**
 * 写入工作区元信息
 */
export declare function writeWorkspaceMeta(hash: string, meta: WorkspaceMeta): void;
/**
 * 通过原始路径查找工作区 hash
 */
export declare function findWorkspaceHash(workspacePath: string): string | null;
/**
 * 获取所有工作区 hash 列表
 */
export declare function listWorkspaceHashes(): string[];
/**
 * 获取记忆文件路径
 */
export declare function getEntryPath(hash: string, memoryId: string): string;
/**
 * 构建 YAML frontmatter + markdown 内容
 */
export declare function buildMemoryFile(frontmatter: MemoryFrontmatter, body: string): string;
/**
 * 解析记忆文件的 frontmatter 和正文
 */
export declare function parseMemoryFile(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
} | null;
/**
 * 读取记忆文件原始内容
 */
export declare function readMemoryFile(hash: string, memoryId: string): string | null;
/**
 * 写入记忆文件（原子写入）
 */
export declare function writeMemoryFile(hash: string, memoryId: string, content: string): void;
/**
 * 删除记忆文件
 */
export declare function deleteMemoryFile(hash: string, memoryId: string): boolean;
/**
 * 在索引中查找记忆，跨所有工作区
 * @returns { hash, entry } 或 null
 */
export declare function findMemoryById(memoryId: string): {
    hash: string;
    entry: MemoryIndexEntry;
} | null;
/**
 * 更新全局索引中某工作区的统计信息
 */
export declare function syncGlobalIndexForWorkspace(hash: string): void;
/**
 * 获取记忆文件的行数
 */
export declare function countLines(content: string): number;
/**
 * 读取配置
 */
export declare function readConfig(): StoreConfig;
//# sourceMappingURL=store.d.ts.map