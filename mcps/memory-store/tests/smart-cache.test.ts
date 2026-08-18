import assert from "node:assert/strict";

const { getSmartCache, setSmartCache, clearSmartCache } = await import("../src/smart-cache.ts");
const { buildSmartCacheKey } = await import("../src/search-engine.ts");

function block(id: string, updatedAt?: string) {
    return { id, title: id, content: id, tags: [] as string[], metadata: updatedAt ? { updatedAt } : undefined };
}

const defaultScope = { modelChain: "grok", modelName: "grok-4.20-0309-non-reasoning", grokContext: "default" as const };

try {
    const b1 = [block("a", "t1"), block("b", "t2")];

    // ① 同候选集（顺序无关）+ 同 query/limit → 同 key
    const k1 = buildSmartCacheKey(b1, "q", 5, defaultScope);
    const k1reordered = buildSmartCacheKey([block("b", "t2"), block("a", "t1")], "q", 5, defaultScope);
    assert.ok(k1, "有 updatedAt 应得到 key");
    assert.equal(k1, k1reordered, "候选集相同（顺序无关）应得同一 key");

    // ② 任一条目版本变化 → key 变（防脏读核心）
    assert.notEqual(k1, buildSmartCacheKey([block("a", "t1"), block("b", "t9")], "q", 5, defaultScope), "updatedAt 变化必须使 key 变（防脏读）");

    // ③ query / limit 变 → key 变
    assert.notEqual(k1, buildSmartCacheKey(b1, "q2", 5, defaultScope), "query 变应换 key");
    assert.notEqual(k1, buildSmartCacheKey(b1, "q", 10, defaultScope), "limit 变应换 key");

    // ④ 任一 block 缺 updatedAt → null（不缓存，宁可慢不脏读）
    assert.equal(buildSmartCacheKey([block("a", "t1"), block("b")], "q", 5, defaultScope), null, "缺 updatedAt 应返回 null 不缓存");
    assert.equal(buildSmartCacheKey(b1, "q", 5, null), null, "未确定实际模型链路时应禁用缓存");

    // ⑤ 实际链路 / 模型 / grokContext 变 → key 变，避免 auto→grok 与 auto→fallback 串用缓存
    assert.notEqual(k1, buildSmartCacheKey(b1, "q", 5, { ...defaultScope, modelChain: "antigravity" }), "实际模型链路变应换 key");
    assert.notEqual(k1, buildSmartCacheKey(b1, "q", 5, { ...defaultScope, modelName: "MODEL_PLACEHOLDER_M132" }), "实际模型名变应换 key");
    assert.notEqual(k1, buildSmartCacheKey(b1, "q", 5, { ...defaultScope, grokContext: "guard" }), "grokContext 变应换 key");

    // ⑥ get/set 命中
    clearSmartCache();
    const fakeResults = [{ id: "a", title: "A", score: 1, matchType: "smart" as const, matches: [] }];
    assert.equal(getSmartCache(k1!), null, "未写入应 miss");
    setSmartCache(k1!, fakeResults);
    assert.deepEqual(getSmartCache(k1!), fakeResults, "写入后应命中");
    // 版本变后的 key 不应命中旧结果（脏读防线）
    const k2 = buildSmartCacheKey([block("a", "t1"), block("b", "t9")], "q", 5, defaultScope);
    assert.equal(getSmartCache(k2!), null, "版本变化后的新 key 不应命中旧缓存");

    console.log("✅ smart-cache 通过：指纹含版本防脏读、模型链路/模型名/grokContext 隔离、缺版本/未定链路不缓存、get/set 命中");
} finally {
    clearSmartCache();
}
