/**
 * 三级搜索引擎 v1.10
 * 
 * exact:  多词分词 AND 匹配（grep 增强版）
 * fuzzy:  Fuse.js 模糊匹配
 * smart:  Flash 语义搜索
 * auto:   exact → fuzzy fallback
 */

import Fuse from "fuse.js";
import { callModelResponse } from "./model-bridge.js";
import { resolveChainSplit, type Chain, type ChainInput, type DataChainInput } from "./chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";

// ============= 类型定义 =============

export type SearchMode = "exact" | "fuzzy" | "smart" | "auto";

export interface TextBlock {
    id: string;          // 唯一标识
    title: string;       // 标题（用于 fuzzy keys）
    content: string;     // 正文
    tags?: string[];     // 标签
    metadata?: Record<string, any>;
}

export interface SearchResult {
    id: string;
    title: string;
    score: number;         // 0-1, 1=最佳匹配
    matchType: SearchMode; // 实际匹配到的模式
    matches: MatchDetail[];
    metadata?: Record<string, any>;
}

export interface MatchDetail {
    lineNum?: number;
    line: string;
    context?: string;
}

export interface SearchOptions {
    mode?: SearchMode;      // 默认 auto
    limit?: number;         // 默认 10
    contextLines?: number;  // exact 模式上下文行数，默认 2
    threshold?: number;     // fuzzy 阈值，默认 0.4
    chain?: ChainInput;     // 兼容旧参数：未指定 modelChain 时作为模型链路
    dataChain?: DataChainInput; // 入口兼容字段；通用搜索引擎本身不读取外部数据
    modelChain?: ChainInput;// smart 模式模型链路
}

// ============= exact 模式 =============

/**
 * 多词分词 AND 匹配
 * 空格分割 query，CJK 连续字符按 2 字切分，每个词独立 includes() 检查
 */
function searchExact(
    blocks: TextBlock[],
    query: string,
    opts: { limit?: number; contextLines?: number },
): SearchResult[] {
    // 先按空格分
    const rawTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    // 对含 CJK 的长 token 做二次切分（按 2 字符窗口）
    const tokens: string[] = [];
    const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/;
    for (const t of rawTokens) {
        if (t.length > 2 && CJK.test(t)) {
            // CJK token → 按 2 字符切分
            for (let i = 0; i < t.length - 1; i += 2) {
                tokens.push(t.slice(i, i + 2));
            }
            if (t.length % 2 === 1) tokens.push(t.slice(-2)); // 奇数长度补最后 2 字
        } else {
            tokens.push(t);
        }
    }
    if (tokens.length === 0) return [];

    const results: SearchResult[] = [];
    const ctx = opts.contextLines ?? 2;

    for (const block of blocks) {
        const lines = block.content.split(/\r?\n/);
        const matches: MatchDetail[] = [];

        for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            // 所有 token 都在这一行中出现
            if (tokens.every(t => lineLower.includes(t))) {
                const ctxStart = Math.max(0, i - ctx);
                const ctxEnd = Math.min(lines.length - 1, i + ctx);
                matches.push({
                    lineNum: i + 1,
                    line: lines[i],
                    context: lines.slice(ctxStart, ctxEnd + 1).join("\n"),
                });
            }
        }

        // 如果单行 AND 没命中，尝试整块内容 AND（所有词在全文中出现）
        if (matches.length === 0) {
            const fullLower = block.content.toLowerCase();
            if (tokens.every(t => fullLower.includes(t))) {
                // 找到每个 token 首次出现的行
                for (const token of tokens) {
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(token)) {
                            const ctxStart = Math.max(0, i - ctx);
                            const ctxEnd = Math.min(lines.length - 1, i + ctx);
                            matches.push({
                                lineNum: i + 1,
                                line: lines[i],
                                context: lines.slice(ctxStart, ctxEnd + 1).join("\n"),
                            });
                            break;
                        }
                    }
                }
            }
        }

        if (matches.length > 0) {
            results.push({
                id: block.id,
                title: block.title,
                score: 1.0,
                matchType: "exact",
                matches,
                metadata: block.metadata,
            });
        }
    }

    results.sort((a, b) => b.matches.length - a.matches.length);
    return results.slice(0, opts.limit ?? 10);
}

// ============= fuzzy 模式 =============

function searchFuzzy(
    blocks: TextBlock[],
    query: string,
    opts: { limit?: number; threshold?: number },
): SearchResult[] {
    if (blocks.length === 0) return [];

    const entries = blocks.map(b => ({
        id: b.id,
        title: b.title,
        tagsStr: (b.tags || []).join(" "),
        preview: b.content.slice(0, 1000),
        metadata: b.metadata,
    }));

    const fuse = new Fuse(entries, {
        keys: [
            { name: "title", weight: 0.35 },
            { name: "tagsStr", weight: 0.3 },
            { name: "preview", weight: 0.35 },
        ],
        threshold: opts.threshold ?? 0.4,
        distance: 200,
        includeScore: true,
    });

    const fuseResults = fuse.search(query, { limit: opts.limit ?? 10 });
    return fuseResults.map((r: any) => ({
        id: r.item.id,
        title: r.item.title,
        score: 1 - (r.score ?? 1),
        matchType: "fuzzy" as SearchMode,
        matches: [{
            line: r.item.preview.slice(0, 200),
        }],
        metadata: r.item.metadata,
    }));
}

// ============= smart 模式 =============

function buildQueryTokens(query: string): string[] {
    const rawTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const tokens = new Set<string>();
    const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/;

    for (const token of rawTokens) {
        tokens.add(token);
        if (token.length > 2 && cjk.test(token)) {
            for (let i = 0; i < token.length - 1; i++) {
                tokens.add(token.slice(i, i + 2));
            }
        }
    }

    return [...tokens].slice(0, 32);
}

function buildSmartSnippet(block: TextBlock, query: string, maxChars = 900): string {
    const tokens = buildQueryTokens(query);
    const lines = block.content.split(/\r?\n/);
    const scored = lines
        .map((line, idx) => {
            const lower = line.toLowerCase();
            const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
            return { line, idx, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.idx - b.idx)
        .slice(0, 8)
        .sort((a, b) => a.idx - b.idx);

    const parts: string[] = [];
    const head = block.content.slice(0, 220);
    if (head.trim()) parts.push(head);
    if (scored.length > 0) {
        parts.push("匹配片段:");
        for (const item of scored) {
            parts.push(`L${item.idx + 1}: ${item.line.slice(0, 260)}`);
        }
    } else {
        parts.push(block.content.slice(0, maxChars));
    }

    return parts.join("\n").slice(0, maxChars);
}

async function searchSmart(
    blocks: TextBlock[],
    query: string,
    opts: { limit?: number; chain?: ChainInput | DataChainInput; dataChain?: DataChainInput; modelChain?: ChainInput },
): Promise<SearchResult[]> {
    if (blocks.length === 0) return [];

    // 构建候选摘要（每块最多 500 字，总量控制 100K）
    const candidates: string[] = [];
    let totalChars = 0;
    const maxTotal = 100_000;

    for (const block of blocks) {
        const snippet = `[${block.id}] ${block.title}\n${buildSmartSnippet(block, query)}`;
        if (totalChars + snippet.length > maxTotal) break;
        candidates.push(snippet);
        totalChars += snippet.length;
    }

    const prompt = `你是一个搜索排序助手。

用户搜索: "${query}"

以下是 ${candidates.length} 个候选文档，每个以 [ID] 开头：

${candidates.join("\n---\n")}

请返回与搜索最相关的文档 ID 列表（最多 ${opts.limit ?? 5} 个），按相关度降序。
格式：每行一个 ID，不要其他内容。如果没有相关文档，返回空。`;

    try {
        const chains = resolveChainSplit({ chain: opts.chain, modelChain: opts.modelChain });
        const response = await callModelResponse(
            process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL,
            prompt,
            chains.modelChain,
            30_000,
            { allowClaudeCodeFallback: resolveChainSplit({ chain: opts.chain, dataChain: opts.dataChain, modelChain: opts.modelChain }).dataChain === "claude-code" },
        );
        if (!response.text) {
            return searchFuzzy(blocks, query, {
                limit: opts.limit,
                threshold: 0.55,
            });
        }

        const candidateIds = new Set(blocks.map(b => b.id));
        const ids: string[] = [];

        for (const line of response.text.split("\n")) {
            const normalized = line
                .trim()
                .replace(/^[-*]\s*/, "")
                .replace(/^`|`$/g, "")
                .replace(/^\[|\]$/g, "")
                .trim();
            if (candidateIds.has(normalized) && !ids.includes(normalized)) {
                ids.push(normalized);
                continue;
            }
            for (const id of candidateIds) {
                if (line.includes(id) && !ids.includes(id)) {
                    ids.push(id);
                }
            }
        }

        if (ids.length === 0) {
            for (const id of candidateIds) {
                if (response.text.includes(id)) ids.push(id);
            }
        }

        if (ids.length === 0) {
            return searchFuzzy(blocks, query, {
                limit: opts.limit,
                threshold: 0.55,
            });
        }

        const results: SearchResult[] = [];
        for (let i = 0; i < ids.length && i < (opts.limit ?? 5); i++) {
            const block = blocks.find(b => b.id === ids[i]);
            if (block) {
                results.push({
                    id: block.id,
                    title: block.title,
                    score: 1 - i * 0.1,
                    matchType: "smart",
                    matches: [{ line: block.content.slice(0, 200) }],
                    metadata: block.metadata,
                });
            }
        }
        if (results.length === 0) {
            return searchFuzzy(blocks, query, {
                limit: opts.limit,
                threshold: 0.55,
            });
        }
        return results;
    } catch {
        return searchFuzzy(blocks, query, {
            limit: opts.limit,
            threshold: 0.55,
        });
    }
}

// ============= auto 模式 + 统一入口 =============

/**
 * 三级搜索统一入口
 * auto 模式：exact → fuzzy fallback（不自动走 smart，因 smart 有延迟）
 */
export async function search(
    blocks: TextBlock[],
    query: string,
    opts: SearchOptions = {},
): Promise<SearchResult[]> {
    const mode = opts.mode ?? "auto";
    const limit = opts.limit ?? 10;

    switch (mode) {
        case "exact":
            return searchExact(blocks, query, { limit, contextLines: opts.contextLines });
        case "fuzzy":
            return searchFuzzy(blocks, query, { limit, threshold: opts.threshold });
        case "smart":
            return await searchSmart(blocks, query, { limit, chain: opts.chain, dataChain: opts.dataChain, modelChain: opts.modelChain });
        case "auto": {
            // 先 exact
            const exactResults = searchExact(blocks, query, { limit, contextLines: opts.contextLines });
            if (exactResults.length > 0) return exactResults;
            // exact 无结果 → fuzzy
            const fuzzyResults = searchFuzzy(blocks, query, { limit, threshold: opts.threshold });
            return fuzzyResults;
        }
        default:
            return searchExact(blocks, query, { limit, contextLines: opts.contextLines });
    }
}
