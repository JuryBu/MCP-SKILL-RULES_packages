import { type MemoryIndexEntry } from "./cache.js";
/**
 * 智能混合搜索
 *
 * 单词查询: fuse.js 整体模糊匹配
 * 多词查询: 逐词 fuse.js + 子串/前缀匹配，覆盖率+质量双维度评分
 */
export declare function fuseSearch(entries: MemoryIndexEntry[], query: string, limit?: number): Array<{
    entry: MemoryIndexEntry;
    score: number;
}>;
/**
 * 去重相似度检测（也使用混合策略）
 */
export declare function checkDuplicates(entries: MemoryIndexEntry[], title: string, searchSummary: string, threshold?: number): Array<{
    entry: MemoryIndexEntry;
    score: number;
}>;
/** grep 搜索结果 */
export interface GrepResult {
    memoryId: string;
    title: string;
    lineNumber: number;
    lineContent: string;
    contextBefore?: string;
    contextAfter?: string;
}
/**
 * 在工作区的 entries 目录中进行全文搜索
 */
export declare function grepInEntries(hash: string, pattern: string, limit?: number): GrepResult[];
/**
 * 在所有工作区的 entries 目录中进行全文搜索
 */
export declare function grepGlobal(pattern: string, limit?: number): Array<{
    hash: string;
    results: GrepResult[];
}>;
//# sourceMappingURL=search.d.ts.map