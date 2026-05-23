import Fuse, { type IFuseOptions } from "fuse.js";
import fs from "fs";
import path from "path";
import { type MemoryIndexEntry } from "./cache.js";
import { WORKSPACES_DIR, GENERAL_DIR, readWorkspaceIndex, readGeneralIndex } from "./store.js";

/**
 * MCP Memory Store 搜索引擎 v2
 * 
 * 智能混合搜索策略：
 * 1. 单词查询 → fuse.js 整体模糊匹配（擅长容错）
 * 2. 多词查询 → 逐词 fuse.js 模糊匹配 + 子串精确匹配，综合评分
 * 3. grep 全文搜索（精确匹配记忆正文）
 * 
 * 评分维度：
 * - 覆盖率（命中了多少比例的查询词）× 0.7
 * - 匹配质量（每个命中词的模糊匹配精度）× 0.3
 * - 前缀匹配加分（"power" 匹配 "powershell"）
 */

// ============= CJK 检测 =============

/** 检测字符串是否包含 CJK 字符 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
function hasCJK(text: string): boolean {
    return CJK_REGEX.test(text);
}

// ============= Fuse.js 配置 =============

/** Fuse.js 搜索选项（整体查询用） */
const FUSE_OPTIONS: IFuseOptions<MemoryIndexEntry> = {
    keys: [
        { name: "title", weight: 0.3 },
        { name: "searchSummary", weight: 0.3 },
        { name: "autoSummary", weight: 0.25 },  // v1.5: Flash 自动生成
        { name: "tags", weight: 0.15 },
    ],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 2,
};

/** 去重检测的 Fuse.js 选项（更宽松） */
const DEDUP_OPTIONS: IFuseOptions<MemoryIndexEntry> = {
    keys: [
        { name: "title", weight: 0.4 },
        { name: "searchSummary", weight: 0.35 },
        { name: "autoSummary", weight: 0.25 },
    ],
    threshold: 0.3,
    includeScore: true,
};

/** 逐词模糊匹配的 Fuse.js 选项（单token, 更宽松阈值） */
const PER_TOKEN_FUSE_OPTIONS: IFuseOptions<MemoryIndexEntry> = {
    keys: [
        { name: "title", weight: 0.3 },
        { name: "searchSummary", weight: 0.3 },
        { name: "autoSummary", weight: 0.25 },
        { name: "tags", weight: 0.15 },
    ],
    threshold: 0.45,  // 逐词匹配时略宽松，允许更多容错
    includeScore: true,
    minMatchCharLength: 2,
};

// ============= 分词工具 =============

/** 将查询字符串分词（按空格/逗号/顿号） */
function tokenize(query: string): string[] {
    return query.split(/[\s,，、]+/).filter(t => t.length > 0);
}

/** 判断是否为多词查询 */
function isMultiWord(query: string): boolean {
    return tokenize(query).length > 1;
}

// ============= 子串+前缀匹配 =============

/**
 * 在 entry 的索引字段中检查 token 的匹配情况
 * 返回: 0 = 精确子串命中, 0.15 = 前缀命中, 1 = 未命中
 */
function substringMatchScore(entry: MemoryIndexEntry, token: string): number {
    const lowerToken = token.toLowerCase();
    const searchPool = [
        entry.title,
        entry.searchSummary,
        entry.autoSummary || "",  // v1.5: 包含 autoSummary
        ...entry.tags,
    ].join(" ").toLowerCase();

    // 精确子串匹配
    if (searchPool.includes(lowerToken)) {
        return 0; // 完美命中
    }

    // 前缀匹配 —— "power" 匹配 "powershell", "memo" 匹配 "memory"
    // 只对 >= 3 字符的 token 启用，避免太短的前缀产生噪音
    if (lowerToken.length >= 3) {
        const words = searchPool.split(/[\s\/\-_,.;:!?()[\]{}]+/);
        for (const word of words) {
            if (word.startsWith(lowerToken)) {
                return 0.15; // 前缀命中，略低于精确匹配
            }
        }
    }

    return 1; // 未命中
}

// ============= 核心搜索函数 =============

/**
 * 智能混合搜索
 * 
 * 单词查询: fuse.js 整体模糊匹配
 * 多词查询: 逐词 fuse.js + 子串/前缀匹配，覆盖率+质量双维度评分
 */
export function fuseSearch(
    entries: MemoryIndexEntry[],
    query: string,
    limit: number = 10
): Array<{ entry: MemoryIndexEntry; score: number }> {
    if (entries.length === 0) return [];

    // === 单词查询：直接走 fuse.js ===
    if (!isMultiWord(query)) {
        return singleTokenSearch(entries, query, limit);
    }

    // === 多词查询：逐词匹配 + 综合评分 ===
    return multiTokenSearch(entries, query, limit);
}

/**
 * 单词查询搜索
 * fuse.js 模糊匹配 + 子串/前缀匹配，取最好成绩
 */
function singleTokenSearch(
    entries: MemoryIndexEntry[],
    query: string,
    limit: number
): Array<{ entry: MemoryIndexEntry; score: number }> {
    const resultMap = new Map<string, { entry: MemoryIndexEntry; score: number }>();

    // fuse.js 模糊匹配
    const fuse = new Fuse(entries, FUSE_OPTIONS);
    const fuseResults = fuse.search(query, { limit: limit * 2 });
    for (const r of fuseResults) {
        resultMap.set(r.item.id, { entry: r.item, score: r.score ?? 1 });
    }

    // 子串 + 前缀匹配补充（尤其帮助 CJK 和精确匹配）
    for (const entry of entries) {
        const subScore = substringMatchScore(entry, query);
        if (subScore < 1) {
            const existing = resultMap.get(entry.id);
            if (!existing || subScore < existing.score) {
                resultMap.set(entry.id, { entry, score: subScore });
            }
        }
    }

    return Array.from(resultMap.values())
        .sort((a, b) => a.score - b.score)
        .slice(0, limit);
}

/**
 * 多词查询搜索（核心增强）
 * 
 * 策略：
 * 1. 对每个 token 分别执行 fuse.js 模糊匹配 + 子串/前缀匹配
 * 2. 收集每个 entry 被哪些 token 命中、每次命中的质量
 * 3. 综合评分 = 覆盖率(0.7) + 平均匹配质量(0.3)
 */
function multiTokenSearch(
    entries: MemoryIndexEntry[],
    query: string,
    limit: number
): Array<{ entry: MemoryIndexEntry; score: number }> {
    const tokens = tokenize(query);
    const totalTokens = tokens.length;

    // 每个 entry 的命中信息: entryId → { entry, tokenScores[] }
    const hitMap = new Map<string, {
        entry: MemoryIndexEntry;
        tokenScores: number[];  // 每个命中 token 的最佳分数（0=完美, 1=未命中）
    }>();

    // 初始化所有 entry 的 tokenScores 为全未命中
    for (const entry of entries) {
        hitMap.set(entry.id, {
            entry,
            tokenScores: new Array(totalTokens).fill(1),
        });
    }

    // 构建一次 Fuse 实例供所有 token 复用
    const fuse = new Fuse(entries, PER_TOKEN_FUSE_OPTIONS);

    // 对每个 token 做两种匹配
    for (let ti = 0; ti < tokens.length; ti++) {
        const token = tokens[ti];

        // A. fuse.js 模糊匹配单个 token（复用同一实例）
        const fuseResults = fuse.search(token);
        for (const r of fuseResults) {
            const hit = hitMap.get(r.item.id)!;
            const fuseScore = r.score ?? 1;
            hit.tokenScores[ti] = Math.min(hit.tokenScores[ti], fuseScore);
        }

        // B. 子串 + 前缀匹配
        for (const entry of entries) {
            const subScore = substringMatchScore(entry, token);
            if (subScore < 1) {
                const hit = hitMap.get(entry.id)!;
                hit.tokenScores[ti] = Math.min(hit.tokenScores[ti], subScore);
            }
        }
    }

    // 综合评分
    const scored: Array<{ entry: MemoryIndexEntry; score: number }> = [];

    for (const [, hit] of hitMap) {
        // 统计命中的 token 数量和质量
        const matchedTokenIndices = hit.tokenScores
            .map((s, i) => ({ score: s, index: i }))
            .filter(x => x.score < 0.8);  // score < 0.8 视为命中

        const matchedCount = matchedTokenIndices.length;
        if (matchedCount === 0) continue; // 一个词都没命中，跳过

        // 覆盖率：命中了多少比例的查询词（等权重）
        const coverageScore = matchedCount / totalTokens; // 0~1, 越高越好

        // 匹配质量：命中词的平均 fuse score（0=完美匹配）
        const avgMatchQuality = matchedTokenIndices.reduce((sum, x) => sum + x.score, 0) / matchedCount;
        const qualityScore = 1 - avgMatchQuality; // 0~1, 越高越好

        // 综合分 = 覆盖率 70% + 质量 30%
        const combinedScore = coverageScore * 0.7 + qualityScore * 0.3;

        // 转换为 fuse 兼容的 score（0=最好, 1=最差）
        const finalScore = 1 - combinedScore;

        // 过滤：至少命中 1 个 token 且综合分 > 0.15（即 finalScore < 0.85）
        if (finalScore < 0.85) {
            scored.push({ entry: hit.entry, score: finalScore });
        }
    }

    return scored
        .sort((a, b) => a.score - b.score)
        .slice(0, limit);
}

// ============= 去重检测 =============

/**
 * 去重相似度检测（也使用混合策略）
 */
export function checkDuplicates(
    entries: MemoryIndexEntry[],
    title: string,
    searchSummary: string,
    threshold: number = 0.2
): Array<{ entry: MemoryIndexEntry; score: number }> {
    if (entries.length === 0) return [];

    const resultMap = new Map<string, { entry: MemoryIndexEntry; fuseScore: number; subScore: number }>();
    const searchQuery = `${title} ${searchSummary}`;

    // Fuse.js 检测
    const fuse = new Fuse(entries, DEDUP_OPTIONS);
    const fuseResults = fuse.search(searchQuery);
    for (const r of fuseResults) {
        resultMap.set(r.item.id, { entry: r.item, fuseScore: r.score ?? 1, subScore: 1 });
    }

    // 子串检测（对所有查询，不限 CJK）
    const tokens = tokenize(searchQuery);
    if (tokens.length > 0) {
        for (const entry of entries) {
            let matchedCount = 0;
            for (const token of tokens) {
                const s = substringMatchScore(entry, token);
                if (s < 0.5) matchedCount++;
            }
            const subScore = 1 - (matchedCount / tokens.length);

            const existing = resultMap.get(entry.id);
            if (existing) {
                existing.subScore = subScore;
            } else {
                resultMap.set(entry.id, { entry, fuseScore: 1, subScore });
            }
        }
    }

    // 取两种算法中更好的 score
    return Array.from(resultMap.values())
        .map(r => {
            const bestScore = Math.min(r.fuseScore, r.subScore);
            return { entry: r.entry, score: 1 - bestScore }; // 转化为相似度
        })
        .filter(r => r.score > (1 - threshold)) // 过滤高相似度
        .sort((a, b) => b.score - a.score);
}

// ============= Grep 全文搜索 =============

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
export function grepInEntries(
    hash: string,
    pattern: string,
    limit: number = 20
): GrepResult[] {
    const entriesDir = hash === "general"
        ? path.join(GENERAL_DIR, "entries")
        : path.join(WORKSPACES_DIR, hash, "entries");

    if (!fs.existsSync(entriesDir)) return [];

    const results: GrepResult[] = [];
    const index = hash === "general" ? readGeneralIndex() : readWorkspaceIndex(hash);

    // 创建 ID → title 的映射
    const titleMap = new Map<string, string>();
    for (const entry of index.entries) {
        titleMap.set(entry.id, entry.title);
    }

    const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));

    for (const file of files) {
        if (results.length >= limit) break;

        const filePath = path.join(entriesDir, file);
        const memoryId = file.replace(/\.md$/, "");

        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split(/\r?\n/);

            // 跳过 frontmatter 区域
            let inFrontmatter = false;
            let frontmatterEnd = 0;

            for (let i = 0; i < lines.length; i++) {
                if (i === 0 && lines[i].trim() === "---") {
                    inFrontmatter = true;
                    continue;
                }
                if (inFrontmatter && lines[i].trim() === "---") {
                    inFrontmatter = false;
                    frontmatterEnd = i;
                    continue;
                }
            }

            // 在正文中搜索
            for (let i = frontmatterEnd + 1; i < lines.length; i++) {
                if (results.length >= limit) break;

                if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
                    results.push({
                        memoryId,
                        title: titleMap.get(memoryId) || memoryId,
                        lineNumber: i + 1, // 1-indexed
                        lineContent: lines[i],
                        contextBefore: i > frontmatterEnd + 1 ? lines[i - 1] : undefined,
                        contextAfter: i < lines.length - 1 ? lines[i + 1] : undefined,
                    });
                }
            }
        } catch { /* 忽略单个文件读取错误 */ }
    }

    return results;
}

/**
 * 在所有工作区的 entries 目录中进行全文搜索
 */
export function grepGlobal(pattern: string, limit: number = 20): Array<{ hash: string; results: GrepResult[] }> {
    const allResults: Array<{ hash: string; results: GrepResult[] }> = [];
    let totalCount = 0;

    // 先搜 general
    const generalResults = grepInEntries("general", pattern, limit);
    if (generalResults.length > 0) {
        allResults.push({ hash: "general", results: generalResults });
        totalCount += generalResults.length;
    }

    // 再搜各工作区
    if (fs.existsSync(WORKSPACES_DIR) && totalCount < limit) {
        const hashes = fs.readdirSync(WORKSPACES_DIR).filter(entry => {
            return fs.statSync(path.join(WORKSPACES_DIR, entry)).isDirectory();
        });

        for (const hash of hashes) {
            if (totalCount >= limit) break;
            const wsResults = grepInEntries(hash, pattern, limit - totalCount);
            if (wsResults.length > 0) {
                allResults.push({ hash, results: wsResults });
                totalCount += wsResults.length;
            }
        }
    }

    return allResults;
}
