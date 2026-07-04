/**
 * EP-S 查询解析器（痛点 a 分层权重 + 痛点 c AND/OR）
 *
 * 把 query 解析成「三桶带权解析树」ParsedQuery：
 *   - must[]    硬过滤 AND（+ 前缀 / AND 保留字 / tiers.required）
 *   - should[]  软排序桶（裸词 / ^tier / ^数值 / OR）
 *   - mustNot[] 硬排除（- 前缀 / NOT 保留字 / tiers.exclude）
 * 每个 QueryTerm 同时携带 occur（桶归属，痛点 c）和 tier/weight（软排序权重，痛点 a）。
 *
 * 纯函数模块，零检索依赖，便于单测。CJK bigram 膨胀逻辑与 search-engine.buildQueryTokens 口径一致。
 *
 * 向后兼容铁律：纯空格、无操作符、无结构化输入的 query → isPlain=true，
 * 调用方据此走旧逻辑快路径，行为字节级等价于改造前。
 */

// ============= 类型定义 =============

/**
 * NUL 哨兵字符（U+0000）。故意用 NUL 当转义字面量标记 / 内部分隔符——它不可能出现在用户
 * query 中，比空格更防碰撞。务必用 String.fromCharCode 显式构造，不在源码里写裸 NUL 字节：
 * 裸 NUL 会让 git/grep 把文件判为 binary，且 formatter 可能把它静默换成空格导致解析错乱。
 */
const NUL_SENTINEL = String.fromCharCode(0);

export type ConfidenceTier = "high" | "med" | "low";
export type Occur = "must" | "should" | "mustNot";

export interface QueryTerm {
    /** 用户原词（bigram 膨胀前，已 toLowerCase）；短查询保护 + mustNot/短语整串判定用。 */
    raw: string;
    /** 膨胀后 token（整词 + CJK 重叠 bigram），实际匹配用。 */
    tokens: string[];
    /** 桶归属（痛点 c）。 */
    occur: Occur;
    /** 置信层（痛点 a）；must/mustNot 不参与软排序但仍标记。 */
    tier: ConfidenceTier;
    /** 软排序权重（痛点 a）；显式数值 > tier default；must/mustNot 不用于软排序。 */
    weight: number;
    /** 短语：tokens 须按序相邻命中（关闭 bigram 软命中回退）。 */
    isPhrase: boolean;
}

export interface ParsedQuery {
    must: QueryTerm[];
    should: QueryTerm[];
    mustNot: QueryTerm[];
    /** true=纯空格无操作符无结构化输入 → 兼容快路径锚点。 */
    isPlain: boolean;
    /** 兼容现有短查询保护判定（splitRawQueryWords 口径：toLowerCase + 按空白切）。 */
    rawWords: string[];
    /** 同词跨桶/跨档冲突提示，不静默吞。 */
    tierConflict?: string[];
}

export interface TierInput {
    high?: string[];
    med?: string[];
    low?: string[];
    required?: string[];
    exclude?: string[];
}

export interface TierWeightsInput {
    high?: number;
    med?: number;
    low?: number;
}

export interface ParseOptions {
    tiers?: TierInput;
    tierWeights?: TierWeightsInput;
    // S-SEV-1：defaultLogic 开关已移除。裸词逻辑恒为 OR（软排序覆盖率打分），
    // 硬 AND 由显式 +term（must 桶）/ tiers.required 表达，语义清晰、不再有「接受参数但行为反转」的口子。
    /** 默认 true：解析行内 +/-/^/AND/OR/NOT/短语 操作符。false=整串按纯字符串处理。 */
    parseInline?: boolean;
}

// ============= 可调权重常量（env，default 保证零行为变化） =============

/** high 层权重：命中 1 高置信词 ≈ 2 普通词；不设 3+ 防一手遮天。 */
export const TIER_WEIGHT_HIGH = numEnv("MEMORY_STORE_TIER_WEIGHT_HIGH", 2.0);
/** med 层权重：基准锚点（=现有均权），纯字符串全落此层。 */
export const TIER_WEIGHT_MED = numEnv("MEMORY_STORE_TIER_WEIGHT_MED", 1.0);
/** low 层权重：微弱加分，单靠 low 凑不够门槛（压噪）。 */
export const TIER_WEIGHT_LOW = numEnv("MEMORY_STORE_TIER_WEIGHT_LOW", 0.3);

function numEnv(key: string, def: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
}

/** tier → default 权重（tierWeights 覆盖优先）。 */
export function tierDefaultWeight(tier: ConfidenceTier, overrides?: TierWeightsInput): number {
    if (tier === "high") return overrides?.high ?? TIER_WEIGHT_HIGH;
    if (tier === "low") return overrides?.low ?? TIER_WEIGHT_LOW;
    return overrides?.med ?? TIER_WEIGHT_MED;
}

// ============= CJK bigram 膨胀（与 buildQueryTokens 同口径） =============

/**
 * CJK 字符判定正则（单一权威定义，供本模块与 relevance-scoring 复用，消除重复/漂移）。
 * 三段：基本汉字 U+4E00-U+9FFF、扩展 A U+3400-U+4DBF、兼容表意 U+F900-U+FAFF。
 */
export const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;

/**
 * 单个原始词膨胀为 token 集合（整词 + CJK 重叠 bigram），保序去重。
 * 与 search-engine.buildQueryTokens 内层逻辑字节一致：len>2 且含 CJK 才加 bigram。
 * 注意：不在此处做 32 全局上限切断（上限由调用方/投影统一处理），保证各 term 独立膨胀不互相挤占配额。
 */
export function expandWordTokens(rawWord: string): string[] {
    const word = rawWord.toLowerCase();
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => {
        if (t.length > 0 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    };
    push(word);
    if (word.length > 2 && CJK_RE.test(word)) {
        for (let i = 0; i < word.length - 1; i++) {
            push(word.slice(i, i + 2));
        }
    }
    return out;
}

/** 短语膨胀：phrase 内部多个空格词各自整词 + bigram，但匹配语义由调用方按相邻判定。 */
function expandPhraseTokens(phrase: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const w of phrase.toLowerCase().split(/\s+/).filter(t => t.length > 0)) {
        for (const t of expandWordTokens(w)) {
            if (!seen.has(t)) {
                seen.add(t);
                out.push(t);
            }
        }
    }
    return out;
}

// ============= 行内 token 切分（尊重引号短语 + 转义） =============

interface RawToken {
    text: string;     // 已去掉外层引号、已处理转义的可见文本
    quoted: boolean;  // 是否原本被双引号包裹（短语）
    /** 短语前缀（S-MID-1）：`+"短语"`/`-"短语"` 的 +/- 携带的桶归属；非短语或无前缀时不设。 */
    phraseOccur?: Occur;
    /** 短语 ^ 权重串（S-MID-1）：`^"短语"`（前缀）或 `"短语"^high`（后缀）里 ^ 后的权重串，留待 parseCaretSuffix。 */
    phraseCaret?: string;
}

/** 读取一段双引号短语（含转义），返回去引号文本与结束位置（指向闭合引号之后）。 */
function readQuotedPhrase(query: string, start: number): { text: string; end: number } {
    let i = start + 1; // 跳过开引号
    const n = query.length;
    let buf = "";
    while (i < n && query[i] !== '"') {
        if (query[i] === "\\" && i + 1 < n) {
            buf += query[i + 1];
            i += 2;
        } else {
            buf += query[i];
            i++;
        }
    }
    if (i < n && query[i] === '"') i++; // 吃掉闭合引号
    return { text: buf, end: i };
}

/**
 * 把原始 query 切成 RawToken 序列：
 *  - 双引号包裹的整段视为一个 phrase token（内部空格保留）。
 *  - 词首 +/- 紧跟引号（`+"短语"`/`-"短语"`）：前缀携带桶归属，短语整体作为一个 phrase token（S-MID-1）。
 *  - 词首 ^ 紧跟引号（`^"短语"`）或短语后紧跟 `^权重`（`"短语"^high`）：^ 权重串挂到该短语（S-MID-1）。
 *  - 转义 \" \+ \- \^ \\ 还原为字面量字符，且被转义的首字符不再当操作符。
 *  - 其余按空白切。
 */
function tokenizeRaw(query: string): RawToken[] {
    const out: RawToken[] = [];
    let i = 0;
    const n = query.length;
    while (i < n) {
        // 跳过空白
        while (i < n && /\s/.test(query[i])) i++;
        if (i >= n) break;

        // 词首前缀 + 引号短语：`+"短语"` / `-"短语"` / `^"短语"`（S-MID-1）。
        // 仅当前缀字符后紧跟开引号时才识别，否则照常走普通词分支（不误吞普通 +/-/^）。
        const c0 = query[i];
        if ((c0 === "+" || c0 === "-" || c0 === "^") && i + 1 < n && query[i + 1] === '"') {
            const { text, end } = readQuotedPhrase(query, i + 1);
            const token: RawToken = { text, quoted: true };
            if (c0 === "+") token.phraseOccur = "must";
            else if (c0 === "-") token.phraseOccur = "mustNot";
            i = end;
            if (c0 === "^") {
                // `^"短语"`：^ 在前缀位，但 ^ 本身需要权重串。这种形态无权重串 → 当普通短语（^ 视为字面无效前缀，忽略）。
                // 真正有意义的是 `"短语"^high`（后缀），下面统一在闭引号后探测 ^权重。
            }
            // 闭引号后若紧跟 `^权重` → 作为该短语的 ^ 后缀。
            i = attachPhraseCaret(query, i, token);
            out.push(token);
            continue;
        }

        if (c0 === '"') {
            // 短语：读到下一个未转义的引号
            const { text, end } = readQuotedPhrase(query, i);
            i = end;
            const token: RawToken = { text, quoted: true };
            // 闭引号后若紧跟 `^权重`（`"短语"^high`）→ 挂到该短语。
            i = attachPhraseCaret(query, i, token);
            out.push(token);
            continue;
        }

        // 普通词：读到空白；处理转义
        let buf = "";
        while (i < n && !/\s/.test(query[i])) {
            if (query[i] === "\\" && i + 1 < n) {
                buf += NUL_SENTINEL + query[i + 1]; // 用哨兵标记「此字符是转义来的字面量」
                i += 2;
            } else {
                buf += query[i];
                i++;
            }
        }
        out.push({ text: buf, quoted: false });
    }
    return out;
}

/** 闭引号后若紧跟 `^权重串`（直到空白/引号），把权重串挂到短语 token，返回新位置；否则原样返回。 */
function attachPhraseCaret(query: string, i: number, token: RawToken): number {
    const n = query.length;
    if (i < n && query[i] === "^") {
        let j = i + 1;
        let suffix = "";
        while (j < n && !/\s/.test(query[j]) && query[j] !== '"') {
            suffix += query[j];
            j++;
        }
        if (suffix.length > 0) {
            token.phraseCaret = suffix;
            return j;
        }
    }
    return i;
}

/** 解析单个非短语 raw token 的前缀操作符 + 后缀 ^ 权重；哨兵 NUL 标记的首字符不当操作符。 */
function parseInlineToken(raw: string): {
    occur: Occur;
    tier: ConfidenceTier;
    explicitWeight?: number;
    explicitNumeric: boolean;
    body: string;
} {
    let occur: Occur = "should";
    let tier: ConfidenceTier = "med";
    let explicitWeight: number | undefined;
    let explicitNumeric = false;

    // 前缀操作符：仅词首 + / - 生效，且不能是转义来的字面量（哨兵开头）。
    let s = raw;
    const firstEscaped = s.startsWith(NUL_SENTINEL);
    if (!firstEscaped) {
        if (s.startsWith("+")) { occur = "must"; s = s.slice(1); }
        else if (s.startsWith("-")) { occur = "mustNot"; s = s.slice(1); }
    }

    // 后缀 ^ 权重/层级：^high/^h/^low/^l/^数值；需找到「未转义」的 ^。
    // 从右往左找最后一个非哨兵转义的 ^。
    const caretIdx = findLastUnescapedCaret(s);
    if (caretIdx >= 0 && occur !== "must" && occur !== "mustNot") {
        const suffix = stripSentinels(s.slice(caretIdx + 1));
        const bodyBefore = stripSentinels(s.slice(0, caretIdx));
        const parsed = parseCaretSuffix(suffix);
        // S-LOW-1：^ 权重生效条件收紧，避免把数学式 / 坐标记法（如 3^5、2^10）误当权重、破坏 isPlain 兼容。
        //   - ^ 前 body 非空；
        //   - 词内仅一个未转义 ^（多 ^ 形如 a^b^c 不当权重）；
        //   - 数值后缀（parsed.numeric）额外要求：body 非纯数字 + suffix 严格匹配 \d+(\.\d+)? （Number() 太宽，拒 1e5/0x10/前后空白）。
        //   tier 后缀（^high/^low/^med 等非数值）不受「body 非纯数字」约束，保持既有行为。
        const onlyOneCaret = countUnescapedCaret(s) === 1;
        const numericOk =
            !parsed?.numeric ||
            (!/^\d+(?:\.\d+)?$/.test(bodyBefore) && /^\d+(?:\.\d+)?$/.test(suffix));
        const caretValid = !!parsed && bodyBefore.length > 0 && onlyOneCaret && numericOk;
        if (caretValid) {
            s = s.slice(0, caretIdx);
            tier = parsed!.tier;
            explicitWeight = parsed!.weight;
            explicitNumeric = parsed!.numeric;
        }
    }

    return { occur, tier, explicitWeight, explicitNumeric, body: stripSentinels(s) };
}

/** 统计字符串里「未转义」（前一位非哨兵）的 ^ 数量，用于 S-LOW-1 多 ^ 收紧。 */
function countUnescapedCaret(s: string): number {
    let count = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "^" && !(i > 0 && s[i - 1] === NUL_SENTINEL)) count++;
    }
    return count;
}

/** 找最后一个「非转义」的 ^ 位置（哨兵 NUL 后一位的 ^ 是字面量，跳过）。 */
function findLastUnescapedCaret(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === "^") {
            if (i > 0 && s[i - 1] === NUL_SENTINEL) continue; // 转义来的字面 ^
            return i;
        }
    }
    return -1;
}

/** 解析 ^ 后缀：返回 tier + weight + 是否绝对数值，无法识别返回 null（此时 ^ 当字面量）。 */
function parseCaretSuffix(suffix: string): { tier: ConfidenceTier; weight: number; numeric: boolean } | null {
    const low = suffix.toLowerCase();
    if (low === "high" || low === "h") return { tier: "high", weight: TIER_WEIGHT_HIGH, numeric: false };
    if (low === "low" || low === "l") return { tier: "low", weight: TIER_WEIGHT_LOW, numeric: false };
    if (low === "med" || low === "m") return { tier: "med", weight: TIER_WEIGHT_MED, numeric: false };
    const num = Number(suffix);
    if (suffix !== "" && Number.isFinite(num) && num >= 0) return { tier: "med", weight: num, numeric: true };
    return null;
}

/** 去掉哨兵字符，还原字面量正文。 */
function stripSentinels(s: string): string {
    return s.split(NUL_SENTINEL).join("");
}

// ============= 主入口 parseQuery =============

/**
 * 解析 query 为三桶带权 ParsedQuery。
 *
 * 三轨合流：
 *   轨道一 纯字符串 → 全 should/med，isPlain=true（无结构化输入时）。
 *   轨道二 行内操作符 +/-/^/AND/OR/NOT/短语 → 对应桶（parseInline=true，默认）。
 *   轨道三 结构化 tiers/tierWeights → 与行内结果并集合流，同词取高优先档。
 *
 * 同词冲突优先级：required(must) > exclude(mustNot) > high > med > low；
 * must↔mustNot 同词矛盾时 must 胜出并记 tierConflict。
 */
export function parseQuery(query: string, opts: ParseOptions = {}): ParsedQuery {
    const rawWords = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const parseInline = opts.parseInline !== false; // 默认 true
    const hasStructured =
        !!opts.tiers && Object.values(opts.tiers).some(arr => Array.isArray(arr) && arr.length > 0);
    const hasTierWeights = !!opts.tierWeights && Object.keys(opts.tierWeights).length > 0;

    // 收集器：key=raw 词（lowercased），值为已确定桶/层的 term 草稿。
    interface Draft { occur: Occur; tier: ConfidenceTier; weight?: number; numeric?: boolean; isPhrase: boolean; }
    const drafts = new Map<string, Draft>();
    const tierConflict: string[] = [];

    // 桶/档优先级数值（越大越优先）。
    const occurRank = (o: Occur): number => (o === "must" ? 4 : o === "mustNot" ? 3 : 0);
    const tierRank = (t: ConfidenceTier): number => (t === "high" ? 2 : t === "med" ? 1 : 0);

    const merge = (key: string, d: Draft) => {
        const cur = drafts.get(key);
        if (!cur) { drafts.set(key, d); return; }
        // 桶冲突
        if (cur.occur !== d.occur) {
            // must↔mustNot 矛盾 → must 胜出
            const winner = occurRank(d.occur) > occurRank(cur.occur) ? d : cur;
            if ((cur.occur === "must" && d.occur === "mustNot") || (cur.occur === "mustNot" && d.occur === "must")) {
                tierConflict.push(`"${key}" 同时被标为 must 和 mustNot，以 must 为准`);
            } else {
                tierConflict.push(`"${key}" 桶归属冲突（${cur.occur} vs ${d.occur}），取 ${winner.occur}`);
            }
            drafts.set(key, { ...winner });
            return;
        }
        // 同桶取更优。优先级（蓝图 2.3）：绝对数值 ^2.5 > tier 档位(high>med>low) > 默认。
        //   - 绝对数值绕过 tier，最权威（用户精确指定）；多个绝对数值取大者。
        //   - 均非绝对数值时按 tier 档位（^low 派生的 0.3 不应压过 tiers.high）。
        const better = (() => {
            if (d.numeric && cur.numeric) return (d.weight ?? 0) >= (cur.weight ?? 0) ? d : cur;
            if (d.numeric) return d;
            if (cur.numeric) return cur;
            const rd = tierRank(d.tier);
            const rc = tierRank(cur.tier);
            if (rd !== rc) return rd > rc ? d : cur;
            return (d.weight ?? -1) >= (cur.weight ?? -1) ? d : cur;
        })();
        drafts.set(key, { ...better });
    };

    // ---- 轨道二：行内 ----
    if (parseInline) {
        const rawTokens = tokenizeRaw(query);
        for (let idx = 0; idx < rawTokens.length; idx++) {
            const rt = rawTokens[idx];
            if (rt.quoted) {
                const body = rt.text.trim();
                if (body.length === 0) continue;
                // S-MID-1：短语可携带前缀桶（+"短语"/-"短语"）与 ^ 权重（"短语"^high）。
                const occur: Occur = rt.phraseOccur ?? "should";
                let tier: ConfidenceTier = "med";
                let weight: number | undefined;
                let numeric = false;
                // ^ 权重仅对 should 桶短语生效（与非短语一致：must/mustNot 不参与软排序）。
                if (occur === "should" && rt.phraseCaret) {
                    const parsedCaret = parseCaretSuffix(rt.phraseCaret);
                    if (parsedCaret) {
                        tier = parsedCaret.tier;
                        if (parsedCaret.numeric) { weight = parsedCaret.weight; numeric = true; }
                    }
                }
                merge(body.toLowerCase(), { occur, tier, weight, numeric, isPhrase: true });
                continue;
            }
            // 保留字 AND/OR/NOT（仅全大写、未转义）：rt.text 原文是否纯大写关键字。
            const visible = stripSentinels(rt.text);
            if (visible === "AND" || visible === "OR" || visible === "NOT") {
                // AND：把相邻两侧词都升级为 must；NOT：把右侧词降为 mustNot；OR：保持 should。
                // 简化实现：AND 让前后裸词进 must；NOT 让后一个词进 mustNot。
                applyReservedWord(visible, rawTokens, idx, merge);
                continue;
            }
            const parsed = parseInlineToken(rt.text);
            const body = parsed.body.trim();
            if (body.length === 0) continue;
            // 仅「绝对数值 ^2.5」固化 weight（绕过 tier）；tier 后缀(^high/^low)不固化，
            // 留待最终按 tierDefaultWeight(tier, tierWeights) 计算，让 tierWeights 覆盖层 default 生效。
            merge(body.toLowerCase(), {
                occur: parsed.occur,
                tier: parsed.tier,
                weight: parsed.explicitNumeric ? parsed.explicitWeight : undefined,
                numeric: parsed.explicitNumeric,
                isPhrase: false,
            });
        }
    } else {
        // parseInline=false：整串按纯字符串，每个空白词都是字面 should/med（含 +/- 当字面量）。
        for (const w of rawWords) {
            merge(w, { occur: "should", tier: "med", isPhrase: false });
        }
    }

    // ---- 轨道三：结构化 tiers ----
    if (opts.tiers) {
        const t = opts.tiers;
        for (const w of t.required ?? []) addStructured(w, "must", "high", merge);
        for (const w of t.exclude ?? []) addStructured(w, "mustNot", "high", merge);
        for (const w of t.high ?? []) addStructured(w, "should", "high", merge);
        for (const w of t.med ?? []) addStructured(w, "should", "med", merge);
        for (const w of t.low ?? []) addStructured(w, "should", "low", merge);
    }

    // ---- 草稿 → QueryTerm 三桶 ----
    const must: QueryTerm[] = [];
    const should: QueryTerm[] = [];
    const mustNot: QueryTerm[] = [];
    for (const [key, d] of drafts) {
        const weight = d.weight ?? tierDefaultWeight(d.tier, opts.tierWeights);
        const tokens = d.isPhrase ? expandPhraseTokens(key) : expandWordTokens(key);
        const term: QueryTerm = {
            raw: key,
            tokens,
            occur: d.occur,
            tier: d.tier,
            weight,
            isPhrase: d.isPhrase,
        };
        if (d.occur === "must") must.push(term);
        else if (d.occur === "mustNot") mustNot.push(term);
        else should.push(term);
    }

    // ---- isPlain 判定：等价于旧纯字符串语义才为 true ----
    // 条件：无硬过滤桶、无短语、所有 should 都是默认 med 权重、无结构化输入。
    // parseInline=false 时仍可能 isPlain（每词都是字面 should/med），故不把它算进破坏条件。
    // S-SEV-1：defaultLogic 已移除，isPlain 只看显式操作符（+/-/^/AND/OR/NOT/短语/tiers），不再受逻辑开关影响。
    const hasOperators =
        must.length > 0 ||
        mustNot.length > 0 ||
        should.some(t => t.isPhrase || t.weight !== TIER_WEIGHT_MED || t.tier !== "med");
    const isPlain =
        !hasStructured &&
        !hasTierWeights &&
        !hasOperators &&
        should.length > 0;

    // 纯操作符 query（三桶全空）→ 降级当 plain 处理（不返回空、不抛错）。
    if (must.length === 0 && should.length === 0 && mustNot.length === 0) {
        const fallbackShould = rawWords.map<QueryTerm>(w => ({
            raw: w,
            tokens: expandWordTokens(w),
            occur: "should",
            tier: "med",
            weight: tierDefaultWeight("med", opts.tierWeights),
            isPhrase: false,
        }));
        return {
            must: [],
            should: fallbackShould,
            mustNot: [],
            isPlain: fallbackShould.length > 0 && !hasStructured && !hasTierWeights,
            rawWords,
            tierConflict: tierConflict.length > 0 ? tierConflict : undefined,
        };
    }

    return {
        must,
        should,
        mustNot,
        isPlain,
        rawWords,
        tierConflict: tierConflict.length > 0 ? tierConflict : undefined,
    };
}

/** AND/OR/NOT 保留字处理（仅全大写）。 */
function applyReservedWord(
    word: "AND" | "OR" | "NOT",
    rawTokens: RawToken[],
    idx: number,
    merge: (key: string, d: { occur: Occur; tier: ConfidenceTier; weight?: number; isPhrase: boolean }) => void,
): void {
    const bodyOf = (rt: RawToken | undefined): string | null => {
        if (!rt) return null;
        if (rt.quoted) return rt.text.trim().toLowerCase() || null;
        const p = parseInlineToken(rt.text);
        const b = p.body.trim().toLowerCase();
        return b || null;
    };
    const prev = bodyOf(rawTokens[idx - 1]);
    const next = bodyOf(rawTokens[idx + 1]);
    if (word === "AND") {
        if (prev) merge(prev, { occur: "must", tier: "high", isPhrase: false });
        if (next) merge(next, { occur: "must", tier: "high", isPhrase: false });
    } else if (word === "NOT") {
        if (next) merge(next, { occur: "mustNot", tier: "high", isPhrase: false });
    }
    // OR：两侧保持 should，无需额外处理（裸词已各自入 should）。
}

/** 结构化 tiers 词加入（词本身可能含空格→当短语 token 膨胀）。 */
function addStructured(
    word: string,
    occur: Occur,
    tier: ConfidenceTier,
    merge: (key: string, d: { occur: Occur; tier: ConfidenceTier; weight?: number; isPhrase: boolean }) => void,
): void {
    const key = word.trim().toLowerCase();
    if (key.length === 0) return;
    const isPhrase = /\s/.test(key);
    merge(key, { occur, tier, isPhrase });
}

/**
 * 投影别名：取 should 桶全部 tokens（兼容旧 buildQueryTokens 语义的「软排序 token 列表」）。
 * 全局 32 上限在 search-engine 投影处统一施加，此处不切。
 */
export function shouldTokens(parsed: ParsedQuery): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of parsed.should) {
        for (const tok of t.tokens) {
            if (!seen.has(tok)) {
                seen.add(tok);
                out.push(tok);
            }
        }
    }
    return out;
}
