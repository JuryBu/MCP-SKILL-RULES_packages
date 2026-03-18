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
    autoSummary?: string;  // v1.5: Flash 自动生成的搜索摘要
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

/** 缓存条目 */
interface CacheItem {
    index: WorkspaceIndex;
    lastAccessed: number; // Date.now() 用于 LRU
}

/**
 * LRU 工作区索引缓存
 */
export class IndexCache {
    private cache = new Map<string, CacheItem>();
    private maxSize: number;

    constructor(maxSize: number = 5) {
        this.maxSize = maxSize;
    }

    /**
     * 获取工作区索引（命中时更新 LRU 时间戳）
     */
    get(hash: string): WorkspaceIndex | null {
        const item = this.cache.get(hash);
        if (!item) return null;

        // 更新访问时间（LRU）
        item.lastAccessed = Date.now();
        return item.index;
    }

    /**
     * 设置工作区索引（超出容量时驱逐最旧）
     */
    set(hash: string, index: WorkspaceIndex): void {
        // 如果已存在，直接更新
        if (this.cache.has(hash)) {
            this.cache.set(hash, { index, lastAccessed: Date.now() });
            return;
        }

        // 如果达到上限，驱逐最久未访问的
        if (this.cache.size >= this.maxSize) {
            let oldestKey: string | null = null;
            let oldestTime = Infinity;

            for (const [key, item] of this.cache) {
                if (item.lastAccessed < oldestTime) {
                    oldestTime = item.lastAccessed;
                    oldestKey = key;
                }
            }

            if (oldestKey) {
                this.cache.delete(oldestKey);
                console.error(`[memory-store] LRU 驱逐工作区索引缓存: ${oldestKey}`);
            }
        }

        this.cache.set(hash, { index, lastAccessed: Date.now() });
    }

    /**
     * 手动驱逐某工作区的索引缓存
     */
    evict(hash: string): void {
        this.cache.delete(hash);
    }

    /**
     * 清空全部缓存
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * 判断某工作区索引是否在缓存中（"热"状态）
     */
    has(hash: string): boolean {
        return this.cache.has(hash);
    }

    /**
     * 获取缓存状态（用于 memory_stats）
     */
    getStats(): { size: number; maxSize: number; keys: string[] } {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            keys: Array.from(this.cache.keys()),
        };
    }
}

// 全局单例
export const indexCache = new IndexCache(5);
