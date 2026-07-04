/**
 * EP-S 相关性打分核（痛点 b 置信度科学化）
 *
 * 把「命中即拉满」的计数式 coverage 升级为「加权覆盖率 + IDF 压制 + 双闸截断」：
 *   - buildIdfTable：查询时现算 df→idf，罕见词权重大、高频无关词压到趋近 1。
 *   - effWeight：tierWeight × idf × bigramFactor，主观分层与客观统计正交相乘。
 *   - weightedCoverage：Σ命中 effWeight / Σ全部 effWeight，替换原均权 coverage。
 *   - dynamicCutoff：mean-k·std + 断崖检测，砍掉低分噪声尾巴。
 *
 * 向后兼容：USE_IDF=0（idf≡1）+ 全 med（tierWeight≡1）+ BIGRAM_FACTOR=1 → effWeight≡1
 * → weightedCoverage ≡ 原 hitCount/allCount，逐字节退回旧均权公式（有数学证明，见测试）。
 *
 * 纯计算模块；类型从 query-parser 仅 import type，无运行时循环依赖。
 */

import type { QueryTerm } from "./query-parser.js";
import { CJK_RE } from "./query-parser.js";

// ============= 可调常量（env，default 保证零行为变化） =============

function numEnv(key: string, def: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
}
function boolEnv(key: string, def: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return def;
    return raw === "1" || raw.toLowerCase() === "true";
}

/** IDF 总开关：关闭则 idf≡1，effWeight 退回纯分层。读取为函数以便测试中改 env 即时生效。 */
export function useIdf(): boolean { return boolEnv("MEMORY_STORE_SCORE_USE_IDF", true); }
/** tf 饱和总开关：默认关，留 BM25 收益不背复杂度。 */
export function useTf(): boolean { return boolEnv("MEMORY_STORE_SCORE_USE_TF", false); }
/** CJK bigram 子 token 降权因子；=1.0 则零偏移，与旧均权完全一致。 */
export function bigramFactor(): number { return numEnv("MEMORY_STORE_BIGRAM_WEIGHT_FACTOR", 0.5); }

/** 动态阈值闸二总开关。 */
export function dynamicCutoffEnabled(): boolean { return boolEnv("MEMORY_STORE_DYNAMIC_CUTOFF", true); }
function cutoffDropK(): number { return numEnv("MEMORY_STORE_CUTOFF_DROP_K", 0.5); }
function cutoffGapRatio(): number { return numEnv("MEMORY_STORE_CUTOFF_GAP_RATIO", 0.4); }
function cutoffAbsFloor(): number { return numEnv("MEMORY_STORE_CUTOFF_ABS_FLOOR", 0.15); }
function cutoffMinSamples(): number { return Math.max(1, Math.round(numEnv("MEMORY_STORE_CUTOFF_MIN_SAMPLES", 5))); }

/** fuzzy 新增最低分阈值（对标 SMART_MIN_SCORE），砍掉无阈值输出尾巴。 */
export function fuzzyMinScore(): number { return numEnv("MEMORY_STORE_FUZZY_MIN_SCORE", 0.1); }
/** fuzzy 下 must 的收紧相似度阈值。 */
export function fuzzyMustSim(): number { return numEnv("MEMORY_STORE_FUZZY_MUST_SIM", 0.6); }

// ============= IDF 表 =============

export interface IdfTable {
    /** token → idf 值；缺失 token 视为最罕见（按 N 计算的上界），由 idfOf 兜底。 */
    map: Map<string, number>;
    /** 文档总数。 */
    n: number;
    /** 缺失 token 的兜底 idf（df=0 即最罕见）。 */
    defaultIdf: number;
}

/**
 * 构建 IDF 表：一遍扫候选文档，统计每个 token 的文档频率 df，算平滑 idf。
 *   idf(t) = ln((N+1)/(df+1)) + 1   // 恒 > 0；罕见词大、高频词趋近 1
 * docTexts 为已 toLowerCase 的文档全文数组（调用方负责拼接 title+summary+body 并小写）。
 * tokens 为需要计 idf 的候选 token 集合（通常是 query 的全部 should/must tokens）。
 */
export function buildIdfTable(docTextsLower: string[], tokens: string[]): IdfTable {
    const n = docTextsLower.length;
    const map = new Map<string, number>();
    const uniqTokens = [...new Set(tokens)];
    for (const t of uniqTokens) {
        if (t.length === 0) continue;
        let df = 0;
        for (const doc of docTextsLower) {
            if (doc.includes(t)) df++;
        }
        map.set(t, idfFromDf(df, n));
    }
    return { map, n, defaultIdf: idfFromDf(0, n) };
}

function idfFromDf(df: number, n: number): number {
    return Math.log((n + 1) / (df + 1)) + 1;
}

/** 查 token 的 idf；USE_IDF 关时恒 1；表缺失走 defaultIdf。 */
export function idfOf(token: string, table: IdfTable | null): number {
    if (!useIdf() || !table) return 1;
    return table.map.get(token) ?? table.defaultIdf;
}

// ============= 有效权重 effWeight =============

/**
 * 单个 token 的有效权重 = tierWeight × idf × bigramFactor。
 *   - tierWeight：来自 term.weight（high/med/low default 或显式覆盖）。
 *   - idf：客观统计区分度（USE_IDF=0 时 ≡1）。
 *   - bigramFactor：仅 CJK bigram 子 token（非整词）降权；整词恒 1。
 * isBigramSubtoken 由调用方判定（token !== term.raw 且是 2 字 CJK）。
 */
export function tokenEffWeight(
    token: string,
    tierWeight: number,
    table: IdfTable | null,
    isBigramSubtoken: boolean,
): number {
    const idf = idfOf(token, table);
    const bf = isBigramSubtoken ? bigramFactor() : 1;
    return tierWeight * idf * bf;
}

/** 判定 token 是否为某 term 的 CJK bigram 子 token（应降权）：2 字、含 CJK、且不等于该 term 整词。 */
export function isBigramSubtokenOf(token: string, term: QueryTerm): boolean {
    return token.length === 2 && token !== term.raw && CJK_RE.test(token);
}

// ============= 加权覆盖率 =============

export interface WeightedCoverageResult {
    coverage: number;       // weightedHit / weightedTotal，0-1
    weightedHit: number;
    weightedTotal: number;
    /** 实际命中的整词 term 数（用于行内共现/排序二级信号，可选用）。 */
    hitTermCount: number;
    matchedTermCount: number;
}

/**
 * 计算 should 桶对单个文档的加权覆盖率。
 *   weightedTotal = Σ_{t ∈ all should tokens} effWeight(t)
 *   weightedHit   = Σ_{t ∈ hit  should tokens} effWeight(t)
 *   coverage      = weightedHit / weightedTotal
 * hitToken(token) 由调用方提供：返回该 token 是否命中该文档。
 *
 * 退化保证：全 med(tierWeight=1) + USE_IDF=0 + BIGRAM_FACTOR=1 → 每 token effWeight=1
 *   → coverage = 命中 token 数 / 全部 token 数 = 旧均权 coverage（逐字节）。
 * weightedTotal=0（极端：should 为空或全被压没）→ coverage 退回均权（命中数/总数），不返回 NaN。
 *
 * 跨 term 去重（S-MID-2）：同一 token 可能归属多个 term（如短语 med 与裸词 high 都产 "foo"），
 *   各 term 的 effWeight 不同。去重时取**所有归属 term 的最大 effWeight**（与「高权词应主导」
 *   设计意图一致），消除对书写顺序的依赖——否则「先遍历到的 weight 胜出」会让同语义 query
 *   仅因词的书写顺序得到不同打分。
 */
export function weightedCoverage(
    shouldTerms: QueryTerm[],
    table: IdfTable | null,
    hitToken: (token: string) => boolean,
): WeightedCoverageResult {
    let hitTermCount = 0;
    const matchedTermCount = shouldTerms.length;

    // 第一遍：对每个唯一 token 求跨所有归属 term 的最大 effWeight（消除顺序依赖）。
    //   tokenOrder 保留首次出现顺序，便于稳定遍历；termHasHit 同步判定每个 term 是否命中。
    const maxWeight = new Map<string, number>();
    const tokenOrder: string[] = [];
    for (const term of shouldTerms) {
        let termHasHit = false;
        for (const token of term.tokens) {
            const w = tokenEffWeight(token, term.weight, table, isBigramSubtokenOf(token, term));
            const prev = maxWeight.get(token);
            if (prev === undefined) {
                maxWeight.set(token, w);
                tokenOrder.push(token);
            } else if (w > prev) {
                maxWeight.set(token, w);
            }
            if (hitToken(token)) termHasHit = true;
        }
        if (termHasHit) hitTermCount++;
    }

    // 第二遍：用每个 token 的最大 effWeight 累加（每 token 只计一次）。
    let weightedTotal = 0;
    let weightedHit = 0;
    let totalTokenCount = 0;
    let hitTokenCount = 0;
    for (const token of tokenOrder) {
        const w = maxWeight.get(token)!;
        weightedTotal += w;
        totalTokenCount++;
        if (hitToken(token)) {
            weightedHit += w;
            hitTokenCount++;
        }
    }

    let coverage: number;
    if (weightedTotal <= 0) {
        // 退回均权，绝不返回 NaN/空。
        coverage = totalTokenCount > 0 ? hitTokenCount / totalTokenCount : 0;
    } else {
        coverage = weightedHit / weightedTotal;
    }
    return { coverage, weightedHit, weightedTotal, hitTermCount, matchedTermCount };
}

// ============= 动态截断（闸二） =============

/**
 * 对已降序排列的 score 数组，计算保留的截断索引（含），返回 cutoffCount=保留个数。
 * 双策略取更靠前者：
 *   - 统计阈值：cutoff = max(ABS_FLOOR, mean - k·std)，保留 score ≥ cutoff 的。
 *   - 断崖检测：相邻 score 相对跌幅 > GAP_RATIO 处截断。
 * 候选数 < MIN_SAMPLES 时跳过（统计不稳，宁可多放），返回全部。
 * DYNAMIC_CUTOFF=0 时禁用，返回全部。
 */
export function dynamicCutoffCount(sortedScoresDesc: number[]): number {
    const m = sortedScoresDesc.length;
    if (!dynamicCutoffEnabled()) return m;
    if (m < cutoffMinSamples()) return m;

    const mean = sortedScoresDesc.reduce((a, b) => a + b, 0) / m;
    const variance = sortedScoresDesc.reduce((a, b) => a + (b - mean) ** 2, 0) / m;
    const std = Math.sqrt(variance);

    // 统计阈值保留数。
    // ⚠️ 关键防误杀：分布紧凑（变异系数 std/mean 小）时根本没有「噪声尾」，
    //    此时 mean-k·std 会贴近 mean、误砍掉略低于均值的好结果。
    //    故仅当分布足够分散（std/mean ≥ DISPERSION_GATE）才启用统计闸；否则只靠断崖与绝对地板。
    const DISPERSION_GATE = 0.35; // 经验值：紧凑高分簇 std/mean 远低于此，长尾分布远高于此
    let statKeep = m;
    if (mean > 0 && std / mean >= DISPERSION_GATE) {
        const statCutoff = Math.max(cutoffAbsFloor(), mean - cutoffDropK() * std);
        for (let i = 0; i < m; i++) {
            if (sortedScoresDesc[i] < statCutoff) { statKeep = i; break; }
        }
    } else {
        // 紧凑分布：仅用绝对地板砍掉低于 ABS_FLOOR 的（防全低分时全留）。
        const floor = cutoffAbsFloor();
        for (let i = 0; i < m; i++) {
            if (sortedScoresDesc[i] < floor) { statKeep = i; break; }
        }
    }

    // 断崖检测保留数：首个相对跌幅 > GAP_RATIO 的断点（在该点之前截断）。
    let gapKeep = m;
    const gap = cutoffGapRatio();
    for (let i = 0; i < m - 1; i++) {
        const hi = sortedScoresDesc[i];
        const lo = sortedScoresDesc[i + 1];
        if (hi > 0 && (hi - lo) / hi > gap) { gapKeep = i + 1; break; }
    }

    // 取更靠前（保留更少）者，但至少保留 1 条（避免全砍）。
    return Math.max(1, Math.min(statKeep, gapKeep));
}

/** tf 饱和加成（默认关）：effWeight × (1 + ln(tfRaw))，log 边际递减。tfRaw<1 视为 1。 */
export function tfSaturate(effW: number, tfRaw: number): number {
    if (!useTf()) return effW;
    const tf = Math.max(1, tfRaw);
    return effW * (1 + Math.log(tf));
}
