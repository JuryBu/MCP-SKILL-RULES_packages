/**
 * MCP Memory Store LRU 索引缓存
 *
 * 设计：
 * - 启动时只加载 _global_index.json（极小）
 * - 首次查询某工作区时加载其 _index.json 到缓存
 * - LRU 保留最近 N 个工作区索引
 * - 超出容量时驱逐最久未访问的
 *
 * 与 web-fetcher 的 cache.ts 的区别：
 * - web-fetcher 缓存的是页面内容（60秒TTL）
 * - 这里缓存的是工作区索引（无TTL，由 LRU 驱逐控制）
 */
/** 工作区索引中的单条记忆索引项 */
export interface MemoryIndexEntry {
    id: string;
    title: string;
    searchSummary: string;
    autoSummary?: string;
    tags: string[];
    category: string;
    createdAt: string;
    updatedAt: string;
    lastAccessed: string;
    sizeBytes: number;
    lineCount: number;
    conversationId?: string;
    pinned?: boolean;
}
/** 工作区索引文件 (_index.json) 的内存表示 */
export interface WorkspaceIndex {
    version: number;
    entries: MemoryIndexEntry[];
}
/**
 * LRU 工作区索引缓存
 */
export declare class IndexCache {
    private cache;
    private maxSize;
    constructor(maxSize?: number);
    /**
     * 获取工作区索引（命中时更新 LRU 时间戳）
     */
    get(hash: string): WorkspaceIndex | null;
    /**
     * 设置工作区索引（超出容量时驱逐最旧）
     */
    set(hash: string, index: WorkspaceIndex): void;
    /**
     * 手动驱逐某工作区的索引缓存
     */
    evict(hash: string): void;
    /**
     * 清空全部缓存
     */
    clear(): void;
    /**
     * 判断某工作区索引是否在缓存中（"热"状态）
     */
    has(hash: string): boolean;
    /**
     * 获取缓存状态（用于 memory_stats）
     */
    getStats(): {
        size: number;
        maxSize: number;
        keys: string[];
    };
}
export declare const indexCache: IndexCache;
//# sourceMappingURL=cache.d.ts.map