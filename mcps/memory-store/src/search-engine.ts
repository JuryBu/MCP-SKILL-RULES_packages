/**
 * 三级搜索引擎 v1.10
 *
 * exact:  多词分词 AND 匹配（grep 增强版）
 * fuzzy:  Fuse.js 模糊匹配
 * smart:  Flash 语义搜索
 * auto:   exact → fuzzy fallback
 */

import Fuse from "fuse.js";
import crypto from "node:crypto";
import { callModelResponse } from "./model-bridge.js";
import { resolveChainSplit, type Chain, type ChainInput, type DataChainInput } from "./chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";
import { getSmartCache, setSmartCache } from "./smart-cache.js";

// ============= 召回/排序可调常量（E2-B1） =============
// 影响召回松紧与排序的硬编码数集中提成 env 可调常量。
// ⚠️ 默认值必须 byte-for-byte 等于改造前的原字面量——只放开调参口子，不改变默认行为。
// （EXACT_MIN_COVERAGE 已由 exactMinCoverage() 单独处理，带 NaN/越界防御，不在此重复提取。）

/** exact 长查询融合权重：score = coverage*W_COV + bestLineCoverage*W_LINE（原字面量 0.7 / 0.3）。 */
const EXACT_SCORE_COVERAGE_WEIGHT = Number(process.env.MEMORY_STORE_EXACT_SCORE_COVERAGE_WEIGHT || 0.7);
const EXACT_SCORE_LINE_WEIGHT = Number(process.env.MEMORY_STORE_EXACT_SCORE_LINE_WEIGHT || 0.3);

/** fuzzy 聚合融合权重：score = coverage*W_COV + best*W_BEST（原字面量 0.7 / 0.3）。 */
const FUZZY_SCORE_COVERAGE_WEIGHT = Number(process.env.MEMORY_STORE_FUZZY_SCORE_COVERAGE_WEIGHT || 0.7);
const FUZZY_SCORE_BEST_WEIGHT = Number(process.env.MEMORY_STORE_FUZZY_SCORE_BEST_WEIGHT || 0.3);

/** fuzzy Fuse.js 默认阈值（越小越严，原字面量 0.4）；opts.threshold 显式传入时优先。 */
const FUZZY_DEFAULT_THRESHOLD = Number(process.env.MEMORY_STORE_FUZZY_THRESHOLD || 0.4);

/** fuzzy 逐词检索的 perTermLimit 下限（原字面量 50）：避免小 limit 时覆盖率采样不足导致排序抖动。 */
const FUZZY_PER_TERM_LIMIT_MIN = Number(process.env.MEMORY_STORE_FUZZY_PER_TERM_LIMIT_MIN || 50);

/** smart 选中结果的最低相关度阈值（原字面量 0.1），砍掉勉强相关项。 */
const SMART_MIN_SCORE = Number(process.env.MEMORY_STORE_SMART_MIN_SCORE || 0.1);

/** smart 候选预筛数量下限（原字面量 40）：fuzzy Top-N 候选喂给模型，提速+降噪。 */
const SMART_PREFILTER_MIN = Number(process.env.MEMORY_STORE_SMART_PREFILTER_MIN || 40);

/** smart 真分融合权重：score = W_RANK*模型名次分 + W_FUZZY*fuzzy 预筛分（原字面量 0.55 / 0.45）。 */
const SMART_SCORE_RANK_WEIGHT = Number(process.env.MEMORY_STORE_SMART_SCORE_RANK_WEIGHT || 0.55);
const SMART_SCORE_FUZZY_WEIGHT = Number(process.env.MEMORY_STORE_SMART_SCORE_FUZZY_WEIGHT || 0.45);

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
 * exact 召回门槛：长查询（token 数 > 短查询阈值）下，命中词数 / 总词数 >= 该覆盖率才算命中。
 * 默认 0.5；可经 env MEMORY_STORE_EXACT_MIN_COVERAGE 调整，无效值（NaN / <=0 / >1）回退默认。
 */
function exactMinCoverage(): number {
    const raw = process.env.MEMORY_STORE_EXACT_MIN_COVERAGE;
    if (raw === undefined || raw === "") return 0.5;
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.5;
    return v;
}

/**
 * 短查询阈值：原始词数（bigram 膨胀前）<= 此值时维持严格 AND 全命中（保护单字/双字 query 召回面不失控）。
 * 固定为 2（设计要求「<=2 词」），不放开为 env 以免短查询保护被误关。
 */
const EXACT_SHORT_QUERY_MAX = 2;

/**
 * 单个原始词的「短词」字符上限：仅当 query 只有 1 个原始词时用于区分
 *  「短词」（如「记忆库」3 字 → 应受严格全命中保护）与「长词/短语」（如「记忆系统优化」6 字 → 应走覆盖率召回）。
 * 单个 CJK 词被 buildQueryTokens 的 bigram 膨胀成多 token 后，无法只靠 token 数区分二者，故对单词补一道字符长度判据。
 * 取 3：与任务点名的边界「记忆库」(3 字) 对齐——<=3 字的单 CJK 词受保护，>=4 字（如「记忆系统优化」）走覆盖率。
 * 多词 query（>=2 原始词，含英文）只看词数、不受此字符上限约束，保持英文/多词既有行为不变。
 */
const EXACT_SHORT_SINGLE_WORD_MAX_CHARS = 3;

/**
 * exact 匹配（v2：与 fuzzy 共用 buildQueryTokens 切词 + 覆盖率打分）
 *
 * 改造要点（仅限本函数内部，不影响 fuzzy/smart/auto 结构）：
 * 1. 切词统一：改用 buildQueryTokens（整词 + CJK 重叠 bigram），消除 exact/fuzzy 切分不一致导致的跨字漏匹配。
 * 2. AND -> 覆盖率打分：长查询不再要求所有词全命中，按「命中词数 / 总词数」覆盖率打分，
 *    覆盖率 >= 门槛（默认 0.5，env 可调）才召回。
 * 3. 真实 score：score = coverage*0.7 + bestLineCoverage*0.3（对齐 fuzzy 全库口径），
 *    bestLineCoverage = 单行内命中 token 数最大值 / 总词数（行内共现质量信号），让排序有区分度、不再恒 1.00。
 * 4. 短查询特判：⚠️ 基于「原始词」（bigram 膨胀前用户实际敲入的词）判定，而非膨胀后 tokens.length——
 *    否则单个短中文词（如「记忆库」→["记忆库","记忆","忆库"]）会被 bigram 膨胀成 >2 个 token、
 *    误判为长查询、丢失「严格全命中 + score 恒 1.0」保护，被 bigram 召回一堆无关文档。
 *    判据：原始词数 <= EXACT_SHORT_QUERY_MAX(2)，且单词时字符数 <= EXACT_SHORT_SINGLE_WORD_MAX_CHARS(3)
 *    （把「记忆库」3 字短词与「记忆系统优化」6 字短语区分开）。命中特判后维持严格 AND 全命中、score 恒 1.0；
 *    打分分母 denom 仍用膨胀后 tokens.length 不变。
 */
export function searchExact(
    blocks: TextBlock[],
    query: string,
    opts: { limit?: number; contextLines?: number },
): SearchResult[] {
    // 切词与 fuzzy 共用一套（整词 + CJK 重叠 bigram，已去重并上限 32）
    const tokens = buildQueryTokens(query);
    if (tokens.length === 0) return [];

    const results: SearchResult[] = [];
    const ctx = opts.contextLines ?? 2;
    // 短查询判定基于「原始词」（与 buildQueryTokens 的 rawTokens 同口径切分），不受 CJK bigram 膨胀影响：
    //  - 多词（>=2 原始词）：词数 <= EXACT_SHORT_QUERY_MAX 即为短查询（保留英文/多词既有行为）。
    //  - 单词：额外要求字符数 <= EXACT_SHORT_SINGLE_WORD_MAX_CHARS，把「记忆库」(3 字,短词,受保护) 与
    //    「记忆系统优化」(6 字,短语,走覆盖率) 区分开——否则单 CJK 长词会因 bigram 膨胀误判，且无法只靠词数区分。
    const rawWords = splitRawQueryWords(query);
    const isShortQuery = rawWords.length > 0
        && rawWords.length <= EXACT_SHORT_QUERY_MAX
        && (rawWords.length >= 2 || rawWords[0].length <= EXACT_SHORT_SINGLE_WORD_MAX_CHARS);
    const minCoverage = exactMinCoverage();

    // 为给定 token 收集匹配行（每个 token 取首次出现行，按行号去重并保序）。
    const collectMatches = (lines: string[], hitTokens: string[]): MatchDetail[] => {
        const seenLine = new Set<number>();
        const out: MatchDetail[] = [];
        for (const token of hitTokens) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(token)) {
                    if (!seenLine.has(i)) {
                        seenLine.add(i);
                        const ctxStart = Math.max(0, i - ctx);
                        const ctxEnd = Math.min(lines.length - 1, i + ctx);
                        out.push({
                            lineNum: i + 1,
                            line: lines[i],
                            context: lines.slice(ctxStart, ctxEnd + 1).join("\n"),
                        });
                    }
                    break;
                }
            }
        }
        out.sort((a, b) => (a.lineNum ?? 0) - (b.lineNum ?? 0));
        return out;
    };

    for (const block of blocks) {
        const lines = block.content.split(/\r?\n/);
        const fullLower = block.content.toLowerCase();

        // 命中的 token（在全文任意位置出现即算命中该 token）
        const hitTokens = tokens.filter(t => fullLower.includes(t));
        const coverage = hitTokens.length / tokens.length;

        if (isShortQuery) {
            // 短查询特判：严格 AND，所有 token 全命中才召回，score 恒 1.0
            if (hitTokens.length !== tokens.length) continue;
            const matches = collectMatches(lines, tokens);
            if (matches.length === 0) continue;
            results.push({
                id: block.id,
                title: block.title,
                score: 1.0,
                matchType: "exact",
                matches,
                metadata: block.metadata,
            });
            continue;
        }

        // 长查询：覆盖率打分，低于门槛不召回
        if (coverage < minCoverage) continue;

        // 行内共现质量：单行命中 token 数最大值 / 总词数
        let maxLineHits = 0;
        for (const line of lines) {
            const lineLower = line.toLowerCase();
            let hits = 0;
            for (const t of hitTokens) if (lineLower.includes(t)) hits++;
            if (hits > maxLineHits) maxLineHits = hits;
        }
        const bestLineCoverage = maxLineHits / tokens.length;
        const score = Math.min(1, coverage * EXACT_SCORE_COVERAGE_WEIGHT + bestLineCoverage * EXACT_SCORE_LINE_WEIGHT);

        const matches = collectMatches(lines, hitTokens);
        if (matches.length === 0) continue; // coverage>0 必有匹配行，防御性保留

        results.push({
            id: block.id,
            title: block.title,
            score,
            matchType: "exact",
            matches,
            metadata: block.metadata,
        });
    }

    results.sort((a, b) => b.score - a.score || b.matches.length - a.matches.length);
    return results.slice(0, opts.limit ?? 10);
}

// ============= fuzzy 模式 =============

/**
 * fuzzy 模糊匹配（v2：逐词覆盖率聚合）
 * 把 query 拆成「空格词 + CJK 重叠 bigram + 整句」逐个 fuse 检索，
 * 按命中覆盖率(0.7) + 最佳匹配质量(0.3) 聚合打分，解决「整句中文直接
 * fuse 招不到自然语言」的问题。开启 ignoreLocation 取消位置惩罚。score 越大越匹配。
 */
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
        preview: b.content.slice(0, 2000),
        metadata: b.metadata,
    }));

    const fuse = new Fuse(entries, {
        keys: [
            { name: "title", weight: 0.35 },
            { name: "tagsStr", weight: 0.3 },
            { name: "preview", weight: 0.35 },
        ],
        threshold: opts.threshold ?? FUZZY_DEFAULT_THRESHOLD,
        ignoreLocation: true,
        includeScore: true,
    });

    const limit = opts.limit ?? 10;
    const tokens = buildQueryTokens(query); // 整词 + CJK 重叠 bigram，已去重并上限 32

    // 逐 token 检索，按命中覆盖率聚合；整句再兜一发作为额外质量信号
    const agg = new Map<string, { item: any; matched: number; best: number }>();
    const consider = (item: any, quality: number) => {
        const cur = agg.get(item.id);
        if (cur) {
            cur.matched += 1;
            if (quality > cur.best) cur.best = quality;
        } else {
            agg.set(item.id, { item, matched: 1, best: quality });
        }
    };
    const perTermLimit = Math.max(FUZZY_PER_TERM_LIMIT_MIN, limit * 4); // 下限默认 50：避免小 limit 时覆盖率采样不足导致排序抖动
    for (const term of [...tokens, query]) {
        for (const r of fuse.search(term, { limit: perTermLimit }) as any[]) {
            consider(r.item, 1 - (r.score ?? 1));
        }
    }

    const denom = Math.max(1, tokens.length);
    const scored = [...agg.values()].map(a => ({
        item: a.item,
        score: Math.min(1, a.matched / denom) * FUZZY_SCORE_COVERAGE_WEIGHT + a.best * FUZZY_SCORE_BEST_WEIGHT,
    }));
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(a => ({
        id: a.item.id,
        title: a.item.title,
        score: a.score,
        matchType: "fuzzy" as SearchMode,
        matches: [{ line: buildFuzzyMatchLine(a.item.preview, query) }],
        metadata: a.item.metadata,
    }));
}

// ============= smart 模式 =============

/**
 * 切出用户原始查询词（bigram 膨胀前）：与 buildQueryTokens 的 rawTokens 同口径
 * （toLowerCase + 按空白切 + 去空），供 exact 短查询保护判定使用，避免 CJK bigram 膨胀虚增词数。
 */
function splitRawQueryWords(query: string): string[] {
    return query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
}

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

/** 为 fuzzy 结果生成一条指向真实命中位置的片段：找首个命中的查询 token，截其上下文；找不到退回 preview 头部。 */
function buildFuzzyMatchLine(preview: string, query: string): string {
    const tokens = buildQueryTokens(query);
    const lower = preview.toLowerCase();
    for (const t of tokens) {
        const idx = lower.indexOf(t.toLowerCase());
        if (idx >= 0) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(preview.length, idx + 140);
            const snippet = preview.slice(start, end).replace(/\s+/g, " ").trim();
            return `${start > 0 ? "…" : ""}${snippet}${end < preview.length ? "…" : ""}`;
        }
    }
    return preview.slice(0, 200);
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

/** smart 缓存键：query + limit + 候选集指纹。指纹按 id:updatedAt 排序聚合——任一条目版本变化即失效（防脏读）；
 *  任一 block 缺 updatedAt 则返回 null（不缓存，宁可慢也不脏读）。 */
export function buildSmartCacheKey(blocks: TextBlock[], query: string, limit: number): string | null {
    const parts: string[] = [];
    for (const b of blocks) {
        const v = b.metadata?.updatedAt;
        if (!v) return null;
        parts.push(`${b.id}:${v}`);
    }
    parts.sort();
    const fingerprint = crypto.createHash("sha1").update(parts.join("|")).digest("hex");
    return `${query} ${limit} ${fingerprint}`;
}

async function searchSmart(
    blocks: TextBlock[],
    query: string,
    opts: { limit?: number; chain?: ChainInput | DataChainInput; dataChain?: DataChainInput; modelChain?: ChainInput },
): Promise<SearchResult[]> {
    if (blocks.length === 0) return [];

    const limit = opts.limit ?? 5;

    // 命中缓存即跳过冷模型调用（指纹含版本，库变自然失效）
    const cacheKey = buildSmartCacheKey(blocks, query, limit);
    if (cacheKey) {
        const cached = getSmartCache(cacheKey);
        if (cached) return cached;
    }

    // 候选预筛：先用 fuzzy 取 Top-N 相关候选，只把这批喂给模型
    // —— 提速（prompt 从最多 100K 字缩到几十条候选）+ 降噪（不再把全库无关项塞给模型）
    const prefilterN = Math.max(SMART_PREFILTER_MIN, limit * 6);
    const prefiltered = searchFuzzy(blocks, query, { limit: prefilterN });
    // 预筛兜底：fuzzy 零命中时不直接放弃（否则 smart 的纯语义召回被 fuzzy 完全封顶），
    // 退化为把前 N 条全库候选喂给模型做语义匹配。
    const fuzzyScore = new Map(prefiltered.map(r => [r.id, r.score]));
    const candidateBlocks = prefiltered.length > 0
        ? prefiltered.map(r => blocks.find(b => b.id === r.id)).filter((b): b is TextBlock => !!b)
        : blocks.slice(0, prefilterN);
    const candidateIds = new Set(candidateBlocks.map(b => b.id));

    const candidates = candidateBlocks.map(b => `[${b.id}] ${b.title}\n${buildSmartSnippet(b, query)}`);

    const prompt = `你是一个搜索排序助手。

用户搜索: "${query}"

以下是 ${candidates.length} 个候选文档，每个以 [ID] 开头：

${candidates.join("\n---\n")}

请返回与搜索最相关的文档 ID 列表（最多 ${limit} 个），按相关度降序。
格式：每行一个 ID，不要其他内容。如果没有相关文档，返回空。`;

    // 真分：模型名次分(默认 0.55) + fuzzy 预筛分(默认 0.45) 融合，并按阈值截断；空则回退预筛结果
    const finalize = (orderedIds: string[]): SearchResult[] => {
        const out: SearchResult[] = [];
        orderedIds.forEach((id, rank) => {
            const block = blocks.find(b => b.id === id);
            if (!block) return;
            const rankScore = Math.max(0, 1 - rank * 0.1);
            const fz = fuzzyScore.get(id) ?? 0;
            const score = Math.min(1, Math.max(0, SMART_SCORE_RANK_WEIGHT * rankScore + SMART_SCORE_FUZZY_WEIGHT * fz));
            if (score < SMART_MIN_SCORE) return;
            out.push({
                id: block.id,
                title: block.title,
                score,
                matchType: "smart",
                matches: [{ line: block.content.slice(0, 200) }],
                metadata: block.metadata,
            });
        });
        return out.slice(0, limit);
    };
    const prefilterAsResults = (): SearchResult[] =>
        prefiltered.slice(0, limit).map(r => ({ ...r, matchType: "fuzzy" as SearchMode }));

    try {
        const chains = resolveChainSplit({ chain: opts.chain, modelChain: opts.modelChain });
        const response = await callModelResponse(
            process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL,
            prompt,
            chains.modelChain,
            30_000,
            { allowClaudeCodeFallback: resolveChainSplit({ chain: opts.chain, dataChain: opts.dataChain, modelChain: opts.modelChain }).dataChain === "claude-code" },
        );
        if (!response.text) return prefilterAsResults();

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
        if (ids.length === 0) return prefilterAsResults();

        const results = finalize(ids);
        if (results.length > 0) {
            if (cacheKey) setSmartCache(cacheKey, results); // 只缓存真走了模型且非空的结果
            return results;
        }
        return prefilterAsResults();
    } catch {
        return prefilterAsResults();
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
