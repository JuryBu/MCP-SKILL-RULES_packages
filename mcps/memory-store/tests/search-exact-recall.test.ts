/**
 * B4 exact 召回改造回归测试（确定性、纯函数级，不需模型）
 *
 * 验证 searchExact 的四项改造：
 *  1. 切词统一（buildQueryTokens）→ 跨字命中：改前漏、改后召回
 *  2. AND → 覆盖率打分 → 长查询部分命中（≥门槛）可召回（改前 AND 为 0）
 *  3. 短查询保护（关键）：单字/双字 query 仍要求全命中、score 恒 1.00、不会突然召回一大片
 *  4. 真实 score：按覆盖率排序、score 有区分度（不再恒 1.00）
 * 另含英文 query 回归、完全不命中（覆盖率 < 门槛不召回）、env 门槛可调。
 */
import assert from "node:assert/strict";

const { searchExact } = await import("../src/search-engine.ts");

type Block = { id: string; title: string; content: string; tags?: string[]; metadata?: Record<string, any> };
function block(id: string, content: string): Block {
    return { id, title: id, content, tags: [] };
}

/**
 * 复刻「改造前」的 exact 切词逻辑（空格分 + CJK 长 token 按 2 字不重叠窗口切分），
 * 用于证明跨字组合在旧逻辑下严格 AND 命中为 0（改前漏），而新 searchExact 能召回（改后召回）。
 */
function oldTokenize(query: string): string[] {
    const rawTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const tokens: string[] = [];
    const CJK = /[一-鿿㐀-䶿豈-﫿]/;
    for (const t of rawTokens) {
        if (t.length > 2 && CJK.test(t)) {
            for (let i = 0; i < t.length - 1; i += 2) tokens.push(t.slice(i, i + 2));
            if (t.length % 2 === 1) tokens.push(t.slice(-2));
        } else {
            tokens.push(t);
        }
    }
    return tokens;
}
function oldExactAndHit(content: string, query: string): boolean {
    const tokens = oldTokenize(query);
    if (tokens.length === 0) return false;
    const full = content.toLowerCase();
    return tokens.every(t => full.includes(t));
}

let passed = 0;
function ok(cond: boolean, msg: string) {
    assert.ok(cond, msg);
    passed++;
}

try {
    // 干净 env，确保用默认门槛 0.5
    delete process.env.MEMORY_STORE_EXACT_MIN_COVERAGE;

    // ───────────────────────────────────────────────────────────
    // ① 跨字命中：改前漏、改后召回
    //   query「记忆系统优化」旧切分（不重叠）= [记忆, 系统, 优化]，新切分（buildQueryTokens）
    //   还含跨边界 bigram [忆系, 统优]。block 内容「记忆系统优部门」含连续的「系统优」
    //   → 命中新独有的跨边界 bigram「统优」，但不含旧切分要求的完整词「优化」。
    //   旧逻辑：严格 AND 要求 优化 命中 → 一票否决为 0（跨字漏匹配 + AND 双重漏）；
    //   新逻辑：命中 [记忆, 忆系, 系统, 统优] = 4/6 ≈ 0.667 ≥ 门槛 → 召回。
    {
        const q = "记忆系统优化";
        const cross = block("cross", "记忆系统优部门");
        // 改前：旧 AND 命中为 0（缺「优化」）
        ok(oldExactAndHit(cross.content, q) === false, "改前：跨字内容旧 AND 应命中为 0（漏）");
        // 改后：新 searchExact 应能召回（命中跨边界 bigram「统优」，覆盖率达门槛）
        const r = searchExact([cross], q, {});
        ok(r.length === 1 && r[0].id === "cross", "改后：跨字内容应被召回（切词统一消除跨字漏匹配）");
        ok(Math.abs(r[0].score - (4 / 6 * 0.7 + 4 / 6 * 0.3)) < 1e-9, `跨字单行命中 score 应 ≈0.667，实得 ${r[0].score}`);
    }

    // ───────────────────────────────────────────────────────────
    // ② 部分命中召回：长查询命中 ≥50% 词应召回（改前 AND 为 0）
    {
        const q = "user auth login"; // 3 tokens，门槛 0.5 → 命中 ≥2 即可
        const partial = block("partial", "the auth and login flow"); // 命中 auth+login = 2/3 ≈ 0.667
        // 改前：旧 AND 要求 user 也命中 → 0
        ok(oldExactAndHit(partial.content, q) === false, "改前：缺 user 的长查询旧 AND 应为 0");
        const r = searchExact([partial], q, {});
        ok(r.length === 1 && r[0].id === "partial", "改后：命中 ≥50% 词的长查询应召回");
        ok(Math.abs(r[0].score - (2 / 3)) < 1e-9, `部分命中 score 应 ≈0.667，实得 ${r[0].score}`);
    }

    // 中文长查询部分命中（恰好等于门槛 0.5 应召回——用 < 严格小于判定）
    {
        const q = "记忆系统优化"; // 6 tokens；命中 [记忆,忆系,系统] = 3/6 = 0.5
        const half = block("half", "记忆系统的设计文档");
        const r = searchExact([half], q, {});
        ok(r.length === 1, "覆盖率恰好等于门槛 0.5 应召回（严格小于才丢弃）");
        ok(Math.abs(r[0].score - 0.5) < 1e-9, `覆盖率 0.5 全散落 score 应 ≈0.5，实得 ${r[0].score}`);
    }

    // ───────────────────────────────────────────────────────────
    // ③ 短查询保护（关键）：单字/双字 query 仍严格全命中、score 恒 1.00、不召回一大片
    {
        // 单字 query：命中即召回，score=1.0
        const blocks = [
            block("m1", "记忆管理模块"),
            block("m2", "系统运行日志"),
            block("m3", "我的记忆很好"),
        ];
        const r = searchExact(blocks, "记忆", {});
        ok(r.length === 2, `单字 query 应只召回含「记忆」的 2 条，实得 ${r.length}`);
        ok(r.every(x => x.score === 1.0), "单字 query 命中 score 必须恒 1.00");
        ok(r.every(x => x.id === "m1" || x.id === "m3"), "单字 query 不应召回不含该字的条目");

        // 双字 query（2 tokens）：严格 AND，两词都得有才召回 → 不会因一个词命中就放一大片
        const blocks2 = [
            block("a", "auth login page"),   // 两词都含 → 召回
            block("b", "only auth section"),  // 仅 auth → 不召回
            block("c", "login screen only"),  // 仅 login → 不召回
        ];
        const r2 = searchExact(blocks2, "auth login", {});
        ok(r2.length === 1 && r2[0].id === "a", `双字 query 应严格 AND 只召回全含的 1 条，实得 ${r2.length}`);
        ok(r2[0].score === 1.0, "双字 query 全命中 score 必须恒 1.00");

        // ⚠️ 回归（medium 修复 #2）：单个短中文词「记忆库」是 1 个原始词、3 字（<= 短词字符上限）。
        //   但 buildQueryTokens 会 bigram 膨胀成 ["记忆库","记忆","忆库"]（3 个 token）。
        //   修复前 isShortQuery 按膨胀后 tokens.length(=3 > 2) 判定 → 误判长查询 → 丢失严格全命中 + score 1.0 保护，
        //   导致仅含 bigram 子串「记忆」「忆库」的无关文档被覆盖率门槛(命中 2/3≈0.67)召回。
        //   修复后按「原始词」判定（1 词且字符数 3 <= 上限）→ 走短查询特判：必须整词全命中、score 恒 1.0、不召回 bigram 半命中项。
        const cjkBlocks = [
            block("c1", "记忆库的设计与实现"),    // 含完整「记忆库」 → 召回
            block("c2", "记忆管理与忆库无关"),     // 仅含 bigram 子串「记忆」「忆库」但无连续「记忆库」 → 修复后不召回
            block("c3", "完全无关的笔记内容"),     // 0 命中 → 不召回
        ];
        const rCjk = searchExact(cjkBlocks, "记忆库", {});
        ok(rCjk.length === 1 && rCjk[0].id === "c1",
            `单个 3 字中文词应只召回含完整词的 1 条、不被 bigram 召回无关项，实得 ${rCjk.length}:[${rCjk.map(x => x.id).join(",")}]`);
        ok(rCjk[0].score === 1.0, "单个 3 字中文词严格全命中 score 必须恒 1.00（短查询保护未被 bigram 膨胀绕过）");

        // 直接固化「修复前会误召回 c2」这一点：c2 含 bigram「记忆」「忆库」共 2/3 覆盖率，
        // 若错走长查询门槛(0.5) 会被召回——断言它「未被召回」即证明短查询保护已生效。
        ok(!rCjk.some(x => x.id === "c2"),
            "短词「记忆库」不应召回仅含 bigram 子串、无完整词的 c2（短查询保护，非覆盖率门槛）");

        // 边界确认：4 字及以上的单中文词（如「记忆系统优化」6 字、「知识图谱」4 字 > 短词字符上限 3）
        //   仍按长查询走覆盖率（与既有测试 ④「记忆系统优化」一致）——短词保护只覆盖 <=3 字的单词，不误吞长短语。
        //   「知识图谱」长查询 tokens=[知识图谱,知识,识图,图谱]：d2 含[知识,图谱]=2/4=0.5≥门槛 → 覆盖率召回（非严格 AND）。
        const r4 = searchExact(
            [block("d1", "知识图谱构建流程"), block("d2", "知识管理与图谱分离")],
            "知识图谱",
            {},
        );
        ok(r4.some(x => x.id === "d2"),
            "单个 4 字中文词应走长查询覆盖率（部分命中 0.5 可召回 d2），不退化为严格 AND");

        // 反向保险：真正的「多词长查询」（2 个以上原始词）仍走覆盖率打分、不退化为严格 AND
        const rMulti = searchExact(
            [block("m1", "记忆库 与 系统设计"), block("m2", "只提到记忆库三个字")],
            "记忆库 系统 设计", // 3 个原始词 → 长查询
            {},
        );
        ok(rMulti.some(x => x.id === "m2"),
            "多词长查询应仍走覆盖率（部分命中可召回），不因短查询修复误退化为严格 AND");
    }

    // ───────────────────────────────────────────────────────────
    // ④ 覆盖率排序 + score 区分度：命中更多词的排前、score 不再恒 1.00
    {
        const q = "记忆系统优化"; // 6 tokens
        const blocks = [
            block("full", "记忆系统优化方案全文"),  // 6/6 全含且同一行 → score 1.0
            block("half", "记忆系统的简单说明"),     // 命中 记忆,忆系,系统 = 3/6 = 0.5
            block("most", "记忆系统统优部分内容"),    // 命中 记忆,忆系,系统,统优 = 4/6 ≈ 0.667
        ];
        const r = searchExact(blocks, q, {});
        ok(r.length === 3, `三条都过门槛应全召回，实得 ${r.length}`);
        // 排序：full > most > half
        ok(r[0].id === "full" && r[1].id === "most" && r[2].id === "half",
            `应按 score 降序排列 full>most>half，实得 ${r.map(x => x.id).join(",")}`);
        // score 有区分度：不全相等
        const scores = r.map(x => x.score);
        ok(new Set(scores).size === 3, `score 应有区分度（3 个不同值），实得 ${JSON.stringify(scores)}`);
        ok(scores[0] === 1.0 && scores[1] < 1.0 && scores[2] < scores[1], "score 应严格递减且非恒 1.00");
    }

    // ───────────────────────────────────────────────────────────
    // ⑤ 英文 query 回归：英文分词查询仍正常
    {
        // 多词英文长查询（3 tokens）走覆盖率
        const blocks = [
            block("e1", "database index concurrency"), // 命中 database+index = 2/3
            block("e2", "unrelated text here"),          // 0 命中
        ];
        const r = searchExact(blocks, "database index lock", {});
        ok(r.length === 1 && r[0].id === "e1", "英文长查询部分命中应正常召回");

        // 单词英文（短查询）严格命中
        const r2 = searchExact([block("x", "the login screen"), block("y", "logout flow")], "login", {});
        ok(r2.length === 1 && r2[0].id === "x" && r2[0].score === 1.0, "英文单词短查询命中 score 恒 1.0");
    }

    // ───────────────────────────────────────────────────────────
    // ⑥ 完全不命中：覆盖率 < 门槛应不召回
    {
        const q = "记忆系统优化"; // 6 tokens，门槛 3
        const r = searchExact([block("none", "性能优化的零散笔记")], q, {});
        // 仅命中「优化」= 1/6 ≈ 0.167 < 0.5 → 不召回
        ok(r.length === 0, `覆盖率 <门槛 应不召回，实得 ${r.length}`);

        // 长查询一个词都不命中
        const r2 = searchExact([block("z", "完全无关的内容")], "user auth login", {});
        ok(r2.length === 0, "长查询零命中应不召回");
    }

    // ───────────────────────────────────────────────────────────
    // ⑦ env 门槛可调：MEMORY_STORE_EXACT_MIN_COVERAGE 生效
    {
        const q = "user auth login"; // 3 tokens
        const partial = block("p", "the auth and login flow"); // 命中 2/3 ≈ 0.667
        // 调高门槛到 0.7 → 0.667 < 0.7 → 不召回
        process.env.MEMORY_STORE_EXACT_MIN_COVERAGE = "0.7";
        const rHigh = searchExact([partial], q, {});
        ok(rHigh.length === 0, "门槛调高到 0.7 后 0.667 覆盖率应不召回");
        // 调低门槛到 0.3 → 0.667 ≥ 0.3 → 召回
        process.env.MEMORY_STORE_EXACT_MIN_COVERAGE = "0.3";
        const rLow = searchExact([partial], q, {});
        ok(rLow.length === 1, "门槛调低到 0.3 后应召回");
        // 无效值回退默认 0.5
        process.env.MEMORY_STORE_EXACT_MIN_COVERAGE = "abc";
        const rBad = searchExact([partial], q, {});
        ok(rBad.length === 1, "无效门槛回退默认 0.5，0.667 应召回");
        delete process.env.MEMORY_STORE_EXACT_MIN_COVERAGE;
    }

    // ───────────────────────────────────────────────────────────
    // ⑧ 空 query 防御
    {
        ok(searchExact([block("a", "anything")], "   ", {}).length === 0, "空白 query 应返回空");
    }

    console.log(`✅ search-exact-recall 通过（${passed} 断言）：跨字命中/部分召回/短查询保护(score=1.00)/覆盖率排序/英文回归/不命中/env门槛/空query`);
} finally {
    delete process.env.MEMORY_STORE_EXACT_MIN_COVERAGE;
}
