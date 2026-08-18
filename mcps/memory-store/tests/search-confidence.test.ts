/**
 * EP-S search-engine 接入测试（切片3/4，确定性，exact 纯函数 + fuzzy/smart 不调真模型）
 *
 * 覆盖蓝图 9.1.C/D/F + 8.2 边界：
 *  - exact 硬过滤(must/mustNot)、纯 must score=1.0、weightedCoverage 门槛挡蹭高频词
 *  - fuzzy must 模糊交集 / mustNot 差集 / must 空交集返回空(不放宽)
 *  - smart 预筛继承 must/mustNot 硬过滤（违反项不进候选）；模型不可用走预筛兜底
 *  - 向后兼容：纯字符串 query 经 search() 与 searchExact 直调一致
 *  - 边界：连字符词、纯 -排除、parseInline=false
 */
import assert from "node:assert/strict";

function resetEnv() {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("MEMORY_STORE_")) delete process.env[k];
    }
}
resetEnv();

const { searchExact, search } = await import("../src/search-engine.ts");

type Block = { id: string; title: string; content: string; tags?: string[]; metadata?: Record<string, any> };
function block(id: string, content: string, tags: string[] = []): Block {
    return { id, title: id, content, tags, metadata: { updatedAt: "2026-01-01T00:00:00Z" } };
}

let passed = 0;
function ok(cond: boolean, msg: string) {
    assert.ok(cond, msg);
    passed++;
}
const ids = (rs: { id: string }[]) => rs.map(r => r.id).sort();

try {
    // ───────────────────────────────────────────
    // ① exact 硬过滤 must：缺 must 词淘汰
    {
        const blocks = [
            block("a", "auth login and session handling"),
            block("b", "login and session only, no signin here"),
            block("c", "session management module"),
        ];
        // +auth login：必须含 auth，login 软排序
        const r = searchExact(blocks, "+auth login");
        ok(ids(r).join() === "a", `+auth 应只召回含 auth 的 a，实得 [${ids(r)}]`);
    }

    // ② exact mustNot 排除：命中排除词淘汰
    {
        const blocks = [
            block("a", "memory optimization design"),
            block("b", "memory optimization but temporary draft"),
        ];
        const r = searchExact(blocks, "memory optimization -temporary");
        ok(ids(r).join() === "a", `-temporary 应排除含 temporary 的 b，实得 [${ids(r)}]`);
    }

    // ③ 纯 must（should 空）score 恒 1.0
    {
        const blocks = [
            block("a", "alpha beta gamma together"),
            block("b", "alpha only"),
            block("c", "beta only"),
        ];
        const r = searchExact(blocks, "+alpha +beta");
        ok(ids(r).join() === "a", `+alpha +beta 应只召回同含两者的 a，实得 [${ids(r)}]`);
        ok(r[0].score === 1.0, `纯 must 全命中 score 应恒 1.0，实得 ${r[0].score}`);
    }

    // ④ weightedCoverage 门槛 + IDF 挡掉蹭高频词的伪命中
    {
        // common 高频（每篇都有），rare 罕见。query "rare common"。
        const blocks = [
            block("hit", "rare topic with common word"),     // 含 rare → 高 coverage
            block("n1", "common common common filler one"),  // 只蹭 common → 被 idf 压低
            block("n2", "common common common filler two"),
            block("n3", "common common common filler three"),
            block("n4", "common common common filler four"),
        ];
        const r = searchExact(blocks, "rare^high common^low");
        ok(r.length >= 1 && r[0].id === "hit", `含 rare 的 hit 应排首位，实得 [${ids(r)}] 首=${r[0]?.id}`);
        // 蹭高频 common 的 n* 应被压到门槛下或排在 hit 之后
        const hitScore = r.find(x => x.id === "hit")?.score ?? 0;
        const noiseMax = Math.max(0, ...r.filter(x => x.id !== "hit").map(x => x.score));
        ok(hitScore > noiseMax, `hit 分应高于所有蹭高频噪声项（${hitScore} vs ${noiseMax}）`);
    }

    // ⑤ 连字符真实 term 不被当操作符
    {
        const blocks = [
            block("a", "the claude-code cli tool"),
            block("b", "unrelated note"),
        ];
        const r = searchExact(blocks, "claude-code");
        ok(ids(r).join() === "a", `claude-code 应作整词召回 a（连字符非操作符），实得 [${ids(r)}]`);
    }

    // ⑥ 纯 -排除（must/should 空，mustNot 非空）：返回不含排除词的全部
    {
        const blocks = [
            block("a", "normal content here"),
            block("b", "this has spam word"),
            block("c", "another clean doc"),
        ];
        const r = searchExact(blocks, "-spam");
        ok(!ids(r).includes("b"), `纯 -spam 应排除含 spam 的 b，实得 [${ids(r)}]`);
        ok(ids(r).includes("a") && ids(r).includes("c"), "纯排除应保留其余全部（非空非错）");
    }

    // ⑦ fuzzy must 模糊交集 / 空交集返回空（不放宽）
    {
        const blocks = [
            block("a", "kubernetes orchestration platform"),
            block("b", "docker container runtime"),
        ];
        // must 词在库中根本不存在 → 交集空 → 返回空（不退化为 OR）
        const r = await search(blocks, "+zzzznonexistent orchestration", { mode: "fuzzy" });
        ok(r.length === 0, `must 词召不到应返回空（不放宽为 OR），实得 ${r.length}:[${ids(r)}]`);
        // must 词存在 → 正常召回
        const r2 = await search(blocks, "+kubernetes platform", { mode: "fuzzy" });
        ok(r2.some(x => x.id === "a"), `+kubernetes 应召回含它的 a，实得 [${ids(r2)}]`);
        ok(!r2.some(x => x.id === "b"), "不含 kubernetes 的 b 不应被召回（must 硬过滤）");
    }

    // ⑧ smart 预筛继承 must/mustNot 硬过滤（模型不可用→走预筛兜底，候选已过滤）
    {
        // 把模型桥超时压到最小，让模型调用秒失败→走 catch→prefilterAsResults（不拖慢测试、不留长进程）。
        process.env.MEMORY_STORE_CODEX_TIMEOUT = "1";
        process.env.MEMORY_STORE_CC_MODEL_TIMEOUT_MS = "1";
        // smart 会在 callModelResponse 失败后走 catch→prefilterAsResults。
        const blocks = [
            block("a", "graphql api schema design", ["api"]),
            block("b", "rest api spam advertisement", ["api"]),
            block("c", "unrelated cooking recipe"),
        ];
        // +api -spam：候选必须含 api 且不含 spam → 只剩 a
        const r = await search(blocks, "+api -spam", { mode: "smart", limit: 5 });
        ok(!r.some(x => x.id === "b"), `smart 预筛应排除含 spam 的 b（mustNot 硬过滤），实得 [${ids(r)}]`);
        ok(!r.some(x => x.id === "c"), `smart 预筛应排除不含 api 的 c（must 硬过滤），实得 [${ids(r)}]`);
    }

    // ⑨ 向后兼容：纯字符串 query 经 search(mode=exact) 与 searchExact 直调结果一致
    {
        const blocks = [
            block("a", "记忆系统优化方案全文"),
            block("b", "记忆系统的简单说明"),
            block("c", "完全无关内容"),
        ];
        const viaSearch = await search(blocks, "记忆系统优化", { mode: "exact" });
        const viaDirect = searchExact(blocks, "记忆系统优化");
        ok(JSON.stringify(ids(viaSearch)) === JSON.stringify(ids(viaDirect)),
            `纯字符串 query 经 search 与直调应一致，实得 search=[${ids(viaSearch)}] direct=[${ids(viaDirect)}]`);
        ok(viaDirect.length >= 1 && viaDirect[0].id === "a", "纯字符串 query 仍正确召回排序");
    }

    // ⑩ parseInline=false：+a 当字面量，不触发硬过滤
    {
        const blocks = [
            block("a", "literal +token in text"),
            block("b", "no special chars"),
        ];
        // parseInline=false → "+token" 整串当字面 should，匹配含 "+token" 的 a
        const r = await search(blocks, "+token", { mode: "exact", parseInline: false });
        ok(r.some(x => x.id === "a"), `parseInline=false 时 +token 当字面量匹配 a，实得 [${ids(r)}]`);
    }

    // ⑪ tiers 结构化输入：required/exclude 等价 +/-
    {
        const blocks = [
            block("a", "security audit report clean"),
            block("b", "security audit but draft version"),
        ];
        const r = searchExact(blocks, "security audit", {
            tiers: { required: ["security"], exclude: ["draft"] },
        });
        ok(ids(r).join() === "a", `tiers.required=security + exclude=draft 应只留 a，实得 [${ids(r)}]`);
    }

    console.log(`✅ search-confidence 通过（${passed} 断言）：exact硬过滤/纯must/IDF门槛/连字符/纯排除/fuzzy交集空/smart预筛过滤/向后兼容/parseInline/tiers`);
} finally {
    resetEnv();
}
