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
/**
 * LRU 工作区索引缓存
 */
export class IndexCache {
    cache = new Map();
    maxSize;
    constructor(maxSize = 5) {
        this.maxSize = maxSize;
    }
    /**
     * 获取工作区索引（命中时更新 LRU 时间戳）
     */
    get(hash) {
        const item = this.cache.get(hash);
        if (!item)
            return null;
        // 更新访问时间（LRU）
        item.lastAccessed = Date.now();
        return item.index;
    }
    /**
     * 设置工作区索引（超出容量时驱逐最旧）
     */
    set(hash, index) {
        // 如果已存在，直接更新
        if (this.cache.has(hash)) {
            this.cache.set(hash, { index, lastAccessed: Date.now() });
            return;
        }
        // 如果达到上限，驱逐最久未访问的
        if (this.cache.size >= this.maxSize) {
            let oldestKey = null;
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
    evict(hash) {
        this.cache.delete(hash);
    }
    /**
     * 清空全部缓存
     */
    clear() {
        this.cache.clear();
    }
    /**
     * 判断某工作区索引是否在缓存中（"热"状态）
     */
    has(hash) {
        return this.cache.has(hash);
    }
    /**
     * 获取缓存状态（用于 memory_stats）
     */
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            keys: Array.from(this.cache.keys()),
        };
    }
}
// 全局单例
export const indexCache = new IndexCache(5);
//# sourceMappingURL=cache.js.map