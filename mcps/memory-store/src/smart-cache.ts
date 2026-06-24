import type { SearchResult } from "./search-engine.js";

// smart 搜索结果缓存：同一 query + 候选集（含版本指纹）短期内复用，省掉重复的冷模型调用（默认 ~30s/次）。
// 缓存键的指纹必须含每条候选的 updatedAt（见 buildSmartCacheKey），库一变指纹变、自然失效，再叠短 TTL 兜底。
const TTL_MS = Number(process.env.MEMORY_STORE_SMART_CACHE_TTL_MS || 300_000); // 5 分钟
const MAX_ENTRIES = Number(process.env.MEMORY_STORE_SMART_CACHE_MAX || 200);

interface CacheEntry {
    results: SearchResult[];
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getSmartCache(key: string): SearchResult[] | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    // LRU 触摸：删后重插到末尾，使最近用的最后被驱逐
    cache.delete(key);
    cache.set(key, entry);
    return entry.results;
}

export function setSmartCache(key: string, results: SearchResult[]): void {
    cache.delete(key);
    cache.set(key, { results, expiresAt: Date.now() + TTL_MS });
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** 测试/手动失效用 */
export function clearSmartCache(): void {
    cache.clear();
}
