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
import {
    parseQuery,
    type ParsedQuery,
    type QueryTerm,
    type TierInput,
    type TierWeightsInput,
} from "./query-parser.js";
import {
    buildIdfTable,
    weightedCoverage,
    dynamicCutoffCount,
    fuzzyMinScore,
    fuzzyMustSim,
    type IdfTable,
} from "./relevance-scoring.js";

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
    // ===== EP-S 新增（全 optional，纯字符串调用零感知）=====
    tiers?: TierInput;            // 分层/必含/排除（痛点 a+c）
    tierWeights?: TierWeightsInput; // 覆盖各层 default 权重
    parseInline?: boolean;       // 是否解析行内 +/-/^/AND/OR/NOT 操作符，默认 true
}

/** 把 SearchOptions 的 EP-S 字段收敛成 parseQuery 的入参。 */
function epsParseOpts(opts: {
    tiers?: TierInput;
    tierWeights?: TierWeightsInput;
    parseInline?: boolean;
}) {
    return {
        tiers: opts.tiers,
        tierWeights: opts.tierWeights,
        parseInline: opts.parseInline,
    };
}

/** must term 对单文档的命中判定（CJK 两档：整串子串命中；整串召不到回退 bigram 覆盖率≥0.7 软命中）。
 *  短语强制整串相邻（即整 raw 子串），关 bigram 回退。 */
function mustTermHits(term: QueryTerm, fullLower: string): boolean {
    // 整串（raw）命中：最稳妥，短语只走这一档。
    if (fullLower.includes(term.raw)) return true;
    if (term.isPhrase) return false;
    // 非短语回退：bigram 子 token 覆盖率 ≥ 0.7 视为软命中（容错局部错字/语序）。
    const subs = term.tokens.filter(t => t !== term.raw);
    if (subs.length === 0) return false; // 无 bigram（英文整词）→ 整串没中就是没中
    let hit = 0;
    for (const s of subs) if (fullLower.includes(s)) hit++;
    return hit / subs.length >= 0.7;
}

/** mustNot 命中判定（从严：仅整串 raw 子串命中即排除，不用 bigram 回退避免误伤）。 */
function mustNotTermHits(term: QueryTerm, fullLower: string): boolean {
    return fullLower.includes(term.raw);
}

/** 该 ParsedQuery 是否带任何硬过滤/结构化输入（决定是否走新加权 pipeline）。 */
function hasAdvancedQuery(parsed: ParsedQuery): boolean {
    return !parsed.isPlain;
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
    opts: {
        limit?: number;
        contextLines?: number;
        tiers?: TierInput;
        tierWeights?: TierWeightsInput;
        parseInline?: boolean;
    } = {},
): SearchResult[] {
    // EP-S：先解析。isPlain（纯空格、无操作符、无结构化输入）→ 走旧逻辑快路径，行为字节级等价。
    const parsed = parseQuery(query, epsParseOpts(opts));
    // 三桶全空（纯空白 query 或纯无效操作符）→ 对齐旧 `tokens.length===0` 返回空。
    if (parsed.must.length === 0 && parsed.should.length === 0 && parsed.mustNot.length === 0) return [];
    if (hasAdvancedQuery(parsed)) {
        return searchExactAdvanced(blocks, query, parsed, opts);
    }

    // ===== 以下为改造前的 exact 逻辑，isPlain 时一字不改（兼容锚点）=====
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

/**
 * EP-S exact 三阶段管线（含操作符/结构化输入时走此路径）。
 *   阶段① 硬过滤：must 全命中（CJK 两档）且不含任何 mustNot。
 *   阶段② 软排序：should-only 加权覆盖率 + 加权行内共现，融合 0.7/0.3（系数不动）。
 *   阶段③ 双闸截断：加权覆盖率 ≥ minCoverage（加权语义）+ 动态阈值砍噪声尾。
 * should 为空（纯 +A +B）：score 恒 1.0，按 matches.length 二级排序。
 */
function searchExactAdvanced(
    blocks: TextBlock[],
    query: string,
    parsed: ParsedQuery,
    opts: { limit?: number; contextLines?: number },
): SearchResult[] {
    const ctx = opts.contextLines ?? 2;
    const minCoverage = exactMinCoverage();
    const limit = opts.limit ?? 10;

    // should token 全集（构 IDF 表用）
    const shouldTokensAll = parsed.should.flatMap(t => t.tokens);
    const docTextsLower = blocks.map(b => b.content.toLowerCase());
    const idfTable: IdfTable | null =
        shouldTokensAll.length > 0 ? buildIdfTable(docTextsLower, shouldTokensAll) : null;

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

    const scored: SearchResult[] = [];
    for (const block of blocks) {
        const lines = block.content.split(/\r?\n/);
        const fullLower = block.content.toLowerCase();

        // ── 阶段① 硬过滤 ──
        let pass = true;
        for (const m of parsed.must) {
            if (!mustTermHits(m, fullLower)) { pass = false; break; }
        }
        if (!pass) continue;
        for (const x of parsed.mustNot) {
            if (mustNotTermHits(x, fullLower)) { pass = false; break; }
        }
        if (!pass) continue;

        // ── 阶段② 软排序 ──
        // should 为空（纯 must）：恒 1.0，仅用 must token 收集匹配行。
        if (parsed.should.length === 0) {
            const mustTokens = parsed.must.flatMap(t => t.tokens).filter(t => fullLower.includes(t));
            const matches = collectMatches(lines, mustTokens.length > 0 ? mustTokens : parsed.must.map(t => t.raw));
            scored.push({
                id: block.id, title: block.title, score: 1.0,
                matchType: "exact", matches, metadata: block.metadata,
            });
            continue;
        }

        const wc = weightedCoverage(parsed.should, idfTable, tok => fullLower.includes(tok));
        // 阶段③ 闸一：加权覆盖率门槛（加权语义复用 minCoverage）
        if (wc.coverage < minCoverage) continue;

        // 加权行内共现：单行内命中 should token 的加权和 / weightedTotal（行内挤占质量信号）
        let bestLineCoverage = 0;
        if (wc.weightedTotal > 0) {
            for (const line of lines) {
                const lineLower = line.toLowerCase();
                const lc = weightedCoverage(parsed.should, idfTable, tok => lineLower.includes(tok));
                if (lc.coverage > bestLineCoverage) bestLineCoverage = lc.coverage;
            }
        }
        const score = Math.min(1, wc.coverage * EXACT_SCORE_COVERAGE_WEIGHT + bestLineCoverage * EXACT_SCORE_LINE_WEIGHT);

        const hitShouldTokens = shouldTokensAll.filter(t => fullLower.includes(t));
        const matches = collectMatches(lines, hitShouldTokens);
        if (matches.length === 0 && parsed.must.length === 0) continue; // 纯 should 但零匹配行
        scored.push({
            id: block.id, title: block.title, score,
            matchType: "exact", matches, metadata: block.metadata,
        });
    }

    scored.sort((a, b) => b.score - a.score || b.matches.length - a.matches.length);

    // 阶段③ 闸二：动态截断（对最终 score 砍噪声尾）
    const cutoff = dynamicCutoffCount(scored.map(r => r.score));
    return scored.slice(0, Math.min(cutoff, limit));
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
    opts: {
        limit?: number;
        threshold?: number;
        tiers?: TierInput;
        tierWeights?: TierWeightsInput;
        parseInline?: boolean;
    } = {},
): SearchResult[] {
    if (blocks.length === 0) return [];

    // EP-S：isPlain → 旧逻辑快路径（一字不改）；advanced → 三阶段。
    const parsed = parseQuery(query, epsParseOpts(opts));
    if (parsed.must.length === 0 && parsed.should.length === 0 && parsed.mustNot.length === 0) return [];
    if (hasAdvancedQuery(parsed)) {
        return searchFuzzyAdvanced(blocks, query, parsed, opts);
    }

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

/**
 * EP-S fuzzy 三阶段（含操作符/结构化输入时）。
 *   阶段① must/mustNot 是「模糊硬约束」：
 *     - must term 须有 fuse 命中且相似度 ≥ 收紧阈值(fuzzyMustSim)；多 must 取交集（AND）。
 *     - mustNot 模糊命中超阈 → 差集淘汰。
 *   阶段② should 逐 token fuse，按 effWeight 加权累加（非计数）：
 *       score = min(1, matchedWeight/weightedTotal)*0.7 + best*0.3
 *   阶段③ FUZZY_MIN_SCORE 砍尾 + 动态截断。
 *   must 交集为空 → 返回空（必含召不到就是空，不放宽不退化）。
 */
function searchFuzzyAdvanced(
    blocks: TextBlock[],
    query: string,
    parsed: ParsedQuery,
    opts: { limit?: number; threshold?: number },
): SearchResult[] {
    const limit = opts.limit ?? 10;
    const entries = blocks.map(b => ({
        id: b.id,
        title: b.title,
        tagsStr: (b.tags || []).join(" "),
        preview: b.content.slice(0, 2000),
        metadata: b.metadata,
        block: b,
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
    const perTermLimit = Math.max(FUZZY_PER_TERM_LIMIT_MIN, limit * 4);
    const byId = new Map(entries.map(e => [e.id, e]));

    /** 一个 term（按其整 raw）模糊命中的文档 id → 最佳相似度。 */
    const fuzzyHitsFor = (raw: string): Map<string, number> => {
        const out = new Map<string, number>();
        for (const r of fuse.search(raw, { limit: perTermLimit }) as any[]) {
            const sim = 1 - (r.score ?? 1);
            const prev = out.get(r.item.id);
            if (prev === undefined || sim > prev) out.set(r.item.id, sim);
        }
        return out;
    };

    // ── 阶段① must 交集（相似度 ≥ fuzzyMustSim）──
    const mustSim = fuzzyMustSim();
    let candidateIds: Set<string> | null = null;
    for (const m of parsed.must) {
        const hits = fuzzyHitsFor(m.raw);
        const passing = new Set<string>();
        for (const [id, sim] of hits) if (sim >= mustSim) passing.add(id);
        if (candidateIds === null) {
            candidateIds = passing;
        } else {
            const prev: Set<string> = candidateIds;
            candidateIds = new Set([...prev].filter((id: string) => passing.has(id)));
        }
        if (candidateIds.size === 0) return []; // must 交集空 → 明确返回空，不放宽
    }
    // 无 must：候选为全集
    if (candidateIds === null) candidateIds = new Set<string>(entries.map(e => e.id));

    // ── 阶段① mustNot 差集 ──
    for (const x of parsed.mustNot) {
        const hits = fuzzyHitsFor(x.raw);
        for (const [id, sim] of hits) if (sim >= mustSim) candidateIds.delete(id);
    }
    if (candidateIds.size === 0) return [];

    // ── 阶段② should 加权聚合 ──
    // should 为空（纯 must）：候选都恒 1.0，按 must 命中质量无差别，保留候选。
    const docTextsLower = blocks.map(b => b.content.toLowerCase());
    const shouldTokensAll = parsed.should.flatMap(t => t.tokens);
    const idfTable: IdfTable | null =
        shouldTokensAll.length > 0 ? buildIdfTable(docTextsLower, shouldTokensAll) : null;

    // 每个 should token 的模糊命中 id→best 质量
    const tokenHitQuality = new Map<string, Map<string, number>>();
    if (parsed.should.length > 0) {
        for (const tok of new Set(shouldTokensAll)) {
            tokenHitQuality.set(tok, fuzzyHitsFor(tok));
        }
    }

    const scoredAll: { id: string; item: any; score: number }[] = [];
    for (const id of candidateIds) {
        const item = byId.get(id)!;
        if (parsed.should.length === 0) {
            scoredAll.push({ id, item, score: 1.0 });
            continue;
        }
        // 加权覆盖率：token 命中 = 该 token 的模糊命中集含此 id
        let best = 0;
        const wc = weightedCoverage(parsed.should, idfTable, tok => {
            const hits = tokenHitQuality.get(tok);
            if (hits && hits.has(id)) {
                const q = hits.get(id)!;
                if (q > best) best = q;
                return true;
            }
            return false;
        });
        const score = Math.min(1, wc.coverage * FUZZY_SCORE_COVERAGE_WEIGHT + best * FUZZY_SCORE_BEST_WEIGHT);
        scoredAll.push({ id, item, score });
    }

    // ── 阶段③ FUZZY_MIN_SCORE 砍尾 + 排序 + 动态截断 ──
    const minScore = fuzzyMinScore();
    const filtered = scoredAll.filter(s => s.score >= minScore);
    filtered.sort((a, b) => b.score - a.score);
    const cutoff = dynamicCutoffCount(filtered.map(s => s.score));

    return filtered.slice(0, Math.min(cutoff, limit)).map(a => ({
        id: a.id,
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

/**
 * smart 缓存键内部字段分隔符：故意用 NUL 哨兵（U+0000）——它不可能出现在 query/limit/指纹里，
 * 比空格更防字段拼接碰撞。务必用 String.fromCharCode 显式构造，不在源码写裸 NUL 字节
 * （裸 NUL 会让 git/grep 把文件判为 binary，且 formatter 可能把它静默换成空格、破坏缓存键分隔）。
 */
const SMART_CACHE_KEY_SEP = String.fromCharCode(0);

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
    return `${query}${SMART_CACHE_KEY_SEP}${limit}${SMART_CACHE_KEY_SEP}${fingerprint}`;
}

async function searchSmart(
    blocks: TextBlock[],
    query: string,
    opts: {
        limit?: number; chain?: ChainInput | DataChainInput; dataChain?: DataChainInput; modelChain?: ChainInput;
        tiers?: TierInput; tierWeights?: TierWeightsInput; parseInline?: boolean;
    },
): Promise<SearchResult[]> {
    if (blocks.length === 0) return [];

    const limit = opts.limit ?? 5;

    // 命中缓存即跳过冷模型调用（指纹含版本，库变自然失效）
    const cacheKey = buildSmartCacheKey(blocks, query, limit);
    if (cacheKey) {
        const cached = getSmartCache(cacheKey);
        if (cached) return cached;
    }

    // EP-S：解析以便预筛带操作符（must/mustNot 在预筛即硬过滤）+ prompt 增强。
    const parsed = parseQuery(query, epsParseOpts(opts));

    // 候选预筛：先用 fuzzy 取 Top-N 相关候选，只把这批喂给模型
    // —— 提速（prompt 从最多 100K 字缩到几十条候选）+ 降噪（不再把全库无关项塞给模型）
    //    EP-S：透传 EP-S 字段 → advanced fuzzy 让候选已满足 must/mustNot 布尔约束。
    const prefilterN = Math.max(SMART_PREFILTER_MIN, limit * 6);
    const prefiltered = searchFuzzy(blocks, query, {
        limit: prefilterN,
        tiers: opts.tiers, tierWeights: opts.tierWeights,
        parseInline: opts.parseInline,
    });
    // 预筛兜底：fuzzy 零命中时不直接放弃（否则 smart 的纯语义召回被 fuzzy 完全封顶），
    // 退化为把前 N 条全库候选喂给模型做语义匹配。
    //   ⚠️ EP-S：有 must/mustNot 硬约束时，零命中是「确实没有满足约束的」→ 不退化为全库（否则会喂入违反约束的项）。
    const hasHardConstraint = parsed.must.length > 0 || parsed.mustNot.length > 0;
    const fuzzyScore = new Map(prefiltered.map(r => [r.id, r.score]));
    const candidateBlocks = prefiltered.length > 0
        ? prefiltered.map(r => blocks.find(b => b.id === r.id)).filter((b): b is TextBlock => !!b)
        : (hasHardConstraint ? [] : blocks.slice(0, prefilterN));
    if (candidateBlocks.length === 0) return [];
    const candidateIds = new Set(candidateBlocks.map(b => b.id));

    const candidates = candidateBlocks.map(b => `[${b.id}] ${b.title}\n${buildSmartSnippet(b, query)}`);

    // EP-S prompt 增强：显式告知模型必含/排除/高置信词，提升语义排序贴合度。
    const mustWords = parsed.must.map(t => t.raw).join("、");
    const mustNotWords = parsed.mustNot.map(t => t.raw).join("、");
    const highWords = parsed.should.filter(t => t.tier === "high").map(t => t.raw).join("、");
    const constraintHints = [
        mustWords ? `结果必须涉及: ${mustWords}` : "",
        mustNotWords ? `结果绝不涉及: ${mustNotWords}` : "",
        highWords ? `优先关注（高置信）: ${highWords}` : "",
    ].filter(Boolean).join("\n");

    const prompt = `你是一个搜索排序助手。

用户搜索: "${query}"
${constraintHints ? `\n约束:\n${constraintHints}\n` : ""}
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
    // EP-S 字段统一透传（纯字符串调用方不传 → 子函数 parseQuery 出 isPlain → 旧逻辑）。
    const eps = {
        tiers: opts.tiers,
        tierWeights: opts.tierWeights,
        parseInline: opts.parseInline,
    };

    switch (mode) {
        case "exact":
            return searchExact(blocks, query, { limit, contextLines: opts.contextLines, ...eps });
        case "fuzzy":
            return searchFuzzy(blocks, query, { limit, threshold: opts.threshold, ...eps });
        case "smart":
            return await searchSmart(blocks, query, { limit, chain: opts.chain, dataChain: opts.dataChain, modelChain: opts.modelChain, ...eps });
        case "auto": {
            // 先 exact
            const exactResults = searchExact(blocks, query, { limit, contextLines: opts.contextLines, ...eps });
            if (exactResults.length > 0) return exactResults;
            // exact 无结果 → fuzzy（带同样 must 约束，不放宽）
            const fuzzyResults = searchFuzzy(blocks, query, { limit, threshold: opts.threshold, ...eps });
            return fuzzyResults;
        }
        default:
            return searchExact(blocks, query, { limit, contextLines: opts.contextLines, ...eps });
    }
}
