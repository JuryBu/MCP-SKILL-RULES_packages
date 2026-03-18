/**
 * 简单内存缓存
 * 避免短时间内重复抓取同一页面
 */
declare class PageCache {
    private cache;
    /**
     * 获取缓存内容
     */
    get(url: string): string | null;
    /**
     * 设置缓存
     */
    set(url: string, content: string): void;
    /**
     * 检查是否有有效缓存
     */
    has(url: string): boolean;
    /**
     * 清空缓存
     */
    clear(): void;
}
export declare const pageCache: PageCache;
export {};
//# sourceMappingURL=cache.d.ts.map