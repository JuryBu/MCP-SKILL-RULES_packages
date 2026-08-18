/**
 * EP-S relevance-scoring 测试（切片2，确定性纯函数）
 *
 * 覆盖蓝图 9.1.B：
 *  - 数学锚点：全 med + USE_IDF=0 + BIGRAM_FACTOR=1 → weightedCoverage ≡ 原均权（逐字节）
 *  - high 词命中 coverage 显著高于等量 med
 *  - IDF 压高频词：无关高频蹭词不再拉高 coverage
 *  - weightedTotal=0 退回均权不空
 *  - bigram 子 token 降权；FACTOR=1 零偏移
 *  - dynamicCutoff：候选<5 跳过、断崖截断、ABS_FLOOR 兜底
 */
import assert from "node:assert/strict";

// 锁定相关 env 到 default 一致状态
function resetEnv() {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("MEMORY_STORE_SCORE_") || k.startsWith("MEMORY_STORE_BIGRAM") ||
            k.startsWith("MEMORY_STORE_CUTOFF") || k.startsWith("MEMORY_STORE_DYNAMIC") ||
            k.startsWith("MEMORY_STORE_TIER_WEIGHT") || k.startsWith("MEMORY_STORE_FUZZY_M")) {
            delete process.env[k];
        }
    }
}
resetEnv();

const rs = await import("../src/relevance-scoring.ts");
const { parseQuery } = await import("../src/query-parser.ts");

let passed = 0;
function ok(cond: boolean, msg: string) {
    assert.ok(cond, msg);
    passed++;
}
function near(a: number, b: number, msg: string, eps = 1e-9) {
    assert.ok(Math.abs(a - b) < eps, `${msg}（期望≈${b}，实得 ${a}）`);
    passed++;
}

try {
    // ───────────────────────────────────────────
    // ① 数学锚点：USE_IDF=0 + BIGRAM_FACTOR=1 + 全 med → weightedCoverage ≡ 命中数/总数
    {
        process.env.MEMORY_STORE_SCORE_USE_IDF = "0";
        process.env.MEMORY_STORE_BIGRAM_WEIGHT_FACTOR = "1";
        const parsed = parseQuery("user auth login"); // 3 should/med，全英文整词不膨胀
        const doc = "the auth and login flow"; // 命中 auth+login = 2/3
        const r = rs.weightedCoverage(parsed.should, null, tok => doc.includes(tok));
        near(r.coverage, 2 / 3, "退化锚点：全 med+USE_IDF=0 应 = 命中数/总数 (2/3)");
        // 全命中 = 1.0
        const r2 = rs.weightedCoverage(parsed.should, null, () => true);
        near(r2.coverage, 1.0, "全命中应 coverage=1.0");
        // 零命中 = 0
        const r3 = rs.weightedCoverage(parsed.should, null, () => false);
        near(r3.coverage, 0, "零命中应 coverage=0");
        resetEnv();
    }

    // ② high 词命中 coverage 显著高于等量 med
    {
        process.env.MEMORY_STORE_SCORE_USE_IDF = "0"; // 隔离 idf，只看分层
        const parsed = parseQuery("alpha^high beta"); // alpha=high(2.0), beta=med(1.0)
        // 命中 alpha → weightedHit=2.0, total=3.0 → 0.667
        const onlyHigh = rs.weightedCoverage(parsed.should, null, t => t === "alpha");
        // 命中 beta → weightedHit=1.0, total=3.0 → 0.333
        const onlyMed = rs.weightedCoverage(parsed.should, null, t => t === "beta");
        ok(onlyHigh.coverage > onlyMed.coverage, `命中 high 词 coverage 应高于命中 med 词（${onlyHigh.coverage} vs ${onlyMed.coverage}）`);
        near(onlyHigh.coverage, 2 / 3, "命中 high(2.0)/total(3.0)=0.667");
        near(onlyMed.coverage, 1 / 3, "命中 med(1.0)/total(3.0)=0.333");
        resetEnv();
    }

    // ③ IDF 压高频词：无关高频蹭词不再拉高 coverage
    {
        // USE_IDF 默认开。构造文档集：rare 词只在 1 篇出现，common 词在全部出现。
        const docs = [
            "rare special unique term here",
            "common common common common one",
            "common common common common two",
            "common common common common three",
            "common common common common four",
        ].map(d => d.toLowerCase());
        const parsed = parseQuery("rare common"); // 两个 med 词
        const table = rs.buildIdfTable(docs, parsed.should.flatMap(t => t.tokens));
        const idfRare = rs.idfOf("rare", table);
        const idfCommon = rs.idfOf("common", table);
        ok(idfRare > idfCommon, `rare 的 idf 应大于 common（${idfRare} vs ${idfCommon}）`);
        // 一个只命中 common（高频蹭词）的文档 coverage 应被压低
        const covCommonOnly = rs.weightedCoverage(parsed.should, table, t => t === "common").coverage;
        const covRareOnly = rs.weightedCoverage(parsed.should, table, t => t === "rare").coverage;
        ok(covRareOnly > covCommonOnly, `命中 rare 的 coverage 应高于只命中高频 common（${covRareOnly} vs ${covCommonOnly}）`);
        ok(covCommonOnly < 0.5, `只命中高频蹭词 coverage 应被 idf 压到 <0.5，实得 ${covCommonOnly}`);
    }

    // ④ USE_IDF=0 时 idf 恒 1（一键回退）
    {
        process.env.MEMORY_STORE_SCORE_USE_IDF = "0";
        const docs = ["a a a a a", "b only"].map(d => d.toLowerCase());
        const table = rs.buildIdfTable(docs, ["a", "b"]);
        near(rs.idfOf("a", table), 1, "USE_IDF=0 时 idf 恒 1（高频 a）");
        near(rs.idfOf("b", table), 1, "USE_IDF=0 时 idf 恒 1（罕见 b）");
        resetEnv();
    }

    // ⑤ weightedTotal=0（should 空）退回均权不空/不 NaN
    {
        const r = rs.weightedCoverage([], null, () => true);
        ok(Number.isFinite(r.coverage) && r.coverage === 0, "should 空时 coverage=0 不 NaN");
    }

    // ⑥ bigram 子 token 降权；FACTOR=1 零偏移
    {
        process.env.MEMORY_STORE_SCORE_USE_IDF = "0";
        // 中文长词「记忆库」膨胀 ["记忆库","记忆","忆库"]：整词 + 2 个 bigram 子 token
        const parsed = parseQuery("记忆库");
        const term = parsed.should[0];
        // FACTOR=0.5（default）：命中所有 token vs 只命中整词
        process.env.MEMORY_STORE_BIGRAM_WEIGHT_FACTOR = "0.5";
        const wWhole = rs.tokenEffWeight("记忆库", term.weight, null, false);
        const wBigram = rs.tokenEffWeight("记忆", term.weight, null, rs.isBigramSubtokenOf("记忆", term));
        near(wWhole, 1.0, "整词 effWeight=tierWeight×1×1=1.0");
        near(wBigram, 0.5, "bigram 子 token 降权 0.5（FACTOR=0.5）");
        // FACTOR=1 零偏移
        process.env.MEMORY_STORE_BIGRAM_WEIGHT_FACTOR = "1";
        const wBigram1 = rs.tokenEffWeight("记忆", term.weight, null, rs.isBigramSubtokenOf("记忆", term));
        near(wBigram1, 1.0, "FACTOR=1 时 bigram 子 token 零偏移=1.0");
        resetEnv();
    }

    // ⑦ isBigramSubtokenOf 判定
    {
        const parsed = parseQuery("记忆库");
        const term = parsed.should[0];
        ok(rs.isBigramSubtokenOf("记忆", term) === true, "「记忆」是「记忆库」的 bigram 子 token");
        ok(rs.isBigramSubtokenOf("记忆库", term) === false, "整词「记忆库」不是 bigram 子 token");
        ok(rs.isBigramSubtokenOf("ab", term) === false, "非 CJK 2 字不算 CJK bigram");
    }

    // ⑧ dynamicCutoff：候选<5 跳过
    {
        resetEnv();
        const scores = [0.9, 0.1, 0.05]; // 3 个 < MIN_SAMPLES(5)
        ok(rs.dynamicCutoffCount(scores) === 3, "候选<5 应跳过闸二，全保留");
    }

    // ⑨ dynamicCutoff：断崖截断
    {
        resetEnv();
        // 5 个：前两个高分，第三个断崖式跌落
        const scores = [0.9, 0.85, 0.2, 0.18, 0.15];
        const keep = rs.dynamicCutoffCount(scores);
        ok(keep <= 2, `断崖处应截断到前 2（0.85→0.2 跌幅>0.4），实得保留 ${keep}`);
    }

    // ⑩ dynamicCutoff：ABS_FLOOR 兜底（全高分不误杀）
    {
        resetEnv();
        const scores = [0.9, 0.88, 0.86, 0.85, 0.84]; // 全高分、无断崖
        const keep = rs.dynamicCutoffCount(scores);
        ok(keep === 5, `全高分无断崖应全保留，实得 ${keep}`);
    }

    // ⑪ dynamicCutoff：DYNAMIC_CUTOFF=0 禁用
    {
        resetEnv();
        process.env.MEMORY_STORE_DYNAMIC_CUTOFF = "0";
        const scores = [0.9, 0.85, 0.01, 0.005, 0.001];
        ok(rs.dynamicCutoffCount(scores) === 5, "DYNAMIC_CUTOFF=0 应禁用，全保留");
        resetEnv();
    }

    // ⑫ tfSaturate 默认关
    {
        resetEnv();
        near(rs.tfSaturate(2.0, 5), 2.0, "USE_TF 默认关，tfSaturate 返回原值");
        process.env.MEMORY_STORE_SCORE_USE_TF = "1";
        ok(rs.tfSaturate(2.0, Math.E) > 2.0, "USE_TF=1 时 tf>1 应加成");
        resetEnv();
    }

    // ⑬ S-MID-2：跨 term 同 token 去重取最大 effWeight → 打分对书写顺序无关
    {
        resetEnv();
        process.env.MEMORY_STORE_SCORE_USE_IDF = "0"; // 隔离 idf，只看分层权重
        // 同一 token "foo" 同属短语 "foo bar"(med) 与裸词 foo^high(high=2.0)。
        const fwd = parseQuery('"foo bar" foo^high');
        const rev = parseQuery('foo^high "foo bar"');
        // 命中全部 token：两种书写顺序 coverage 必须完全相等（顺序无关）。
        const covFwd = rs.weightedCoverage(fwd.should, null, () => true).coverage;
        const covRev = rs.weightedCoverage(rev.should, null, () => true).coverage;
        near(covFwd, covRev, "S-MID-2：同语义 query 不同书写顺序 coverage 应相等（全命中）");
        // 只命中 "foo"（共享 token）：取 max effWeight(=high 2.0) 而非先到先得，两序也应相等。
        const fooFwd = rs.weightedCoverage(fwd.should, null, t => t === "foo").coverage;
        const fooRev = rs.weightedCoverage(rev.should, null, t => t === "foo").coverage;
        near(fooFwd, fooRev, "S-MID-2：仅命中共享 token 时两序 coverage 相等（取 max 权重）");

        // 直接构造验「取最大」：term1(weight 1) 与 term2(weight 3) 共享 token "x"。
        const term1: any = { raw: "x", tokens: ["x"], occur: "should", tier: "med", weight: 1, isPhrase: false };
        const term2: any = { raw: "y", tokens: ["x"], occur: "should", tier: "high", weight: 3, isPhrase: false };
        // 命中共享 token x：weightedTotal 应只计一次且 = max(1,3)=3 → 全命中 coverage=1.0。
        const r12 = rs.weightedCoverage([term1, term2], null, () => true);
        near(r12.weightedTotal, 3, "S-MID-2：共享 token 去重后 weightedTotal=max 权重(3)，不累加成 4");
        const r21 = rs.weightedCoverage([term2, term1], null, () => true);
        near(r21.weightedTotal, 3, "S-MID-2：反序同样取 max(3)，顺序无关");
        resetEnv();
    }

    console.log(`✅ relevance-scoring 通过（${passed} 断言）：退化数学锚点/分层/IDF压制/weightedTotal=0退化/bigram降权/动态截断/tf/跨term取max顺序无关`);
} finally {
    resetEnv();
}
