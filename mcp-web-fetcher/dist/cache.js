/**
 * 简单内存缓存
 * 避免短时间内重复抓取同一页面
 */
const CACHE_TTL = 60 * 1000; // 60 秒过期
class PageCache {
    cache = new Map();
    /**
     * 获取缓存内容
     */
    get(url) {
        const entry = this.cache.get(url);
        if (!entry)
            return null;
        if (Date.now() - entry.timestamp > CACHE_TTL) {
            this.cache.delete(url);
            return null;
        }
        console.error(`[web-fetcher] 缓存命中: ${url}`);
        return entry.content;
    }
    /**
     * 设置缓存
     */
    set(url, content) {
        this.cache.set(url, {
            content,
            timestamp: Date.now(),
        });
        // 限制缓存大小
        if (this.cache.size > 50) {
            const oldest = this.cache.keys().next().value;
            if (oldest)
                this.cache.delete(oldest);
        }
    }
    /**
     * 检查是否有有效缓存
     */
    has(url) {
        return this.get(url) !== null;
    }
    /**
     * 清空缓存
     */
    clear() {
        this.cache.clear();
    }
}
export const pageCache = new PageCache();
//# sourceMappingURL=cache.js.map