/**
 * EP-S query-parser 纯函数测试（切片1，不接检索，确定性）
 *
 * 覆盖蓝图 9.1.A：三轨解析、+/-/^/AND/OR/NOT、短语、转义、连字符、纯操作符降级、
 * parseInline 开关、tiers 结构化合流、同词冲突、must↔mustNot 矛盾。
 */
import assert from "node:assert/strict";

// 干净 env：用 default 权重 high=2 / med=1 / low=0.3，defaultLogic=or
for (const k of Object.keys(process.env)) {
    if (k.startsWith("MEMORY_STORE_TIER_WEIGHT") || k === "MEMORY_STORE_DEFAULT_LOGIC") delete process.env[k];
}

const { parseQuery, expandWordTokens, shouldTokens } = await import("../src/query-parser.ts");

let passed = 0;
function ok(cond: boolean, msg: string) {
    assert.ok(cond, msg);
    passed++;
}
const raws = (terms: { raw: string }[]) => terms.map(t => t.raw).sort();

try {
    // ① 纯空格 → isPlain，全 should/med/1.0
    {
        const p = parseQuery("a b c");
        ok(p.isPlain === true, "纯空格 query 应 isPlain=true");
        ok(p.must.length === 0 && p.mustNot.length === 0, "纯空格无 must/mustNot");
        ok(p.should.length === 3, `应 3 个 should，实得 ${p.should.length}`);
        ok(p.should.every(t => t.tier === "med" && t.weight === 1.0 && t.occur === "should"), "全 med/1.0/should");
        // S-SEV-1：defaultLogic 字段已从 ParsedQuery 移除（恒 OR 软排序，硬 AND 由 +term 表达）
        ok(!("defaultLogic" in p), "ParsedQuery 不再含 defaultLogic 字段（已移除）");
    }

    // ② +a b -c → must/should/mustNot
    {
        const p = parseQuery("+a b -c");
        ok(raws(p.must).join() === "a", `must=[a]，实得 [${raws(p.must)}]`);
        ok(raws(p.should).join() === "b", `should=[b]，实得 [${raws(p.should)}]`);
        ok(raws(p.mustNot).join() === "c", `mustNot=[c]，实得 [${raws(p.mustNot)}]`);
        ok(p.isPlain === false, "含操作符应 isPlain=false");
    }

    // ③ ^high / ^数值 / ^low 三档权重
    {
        const p = parseQuery("a^high b^2.5 c^low");
        const byRaw = Object.fromEntries(p.should.map(t => [t.raw, t]));
        ok(byRaw["a"].tier === "high" && byRaw["a"].weight === 2.0, `a^high weight=2.0，实得 ${byRaw["a"]?.weight}`);
        ok(byRaw["b"].weight === 2.5, `b^2.5 weight=2.5，实得 ${byRaw["b"]?.weight}`);
        ok(byRaw["c"].tier === "low" && byRaw["c"].weight === 0.3, `c^low weight=0.3，实得 ${byRaw["c"]?.weight}`);
        ok(p.isPlain === false, "带权 query isPlain=false");
        // ^h / ^l 简写
        const p2 = parseQuery("x^h y^l");
        const b2 = Object.fromEntries(p2.should.map(t => [t.raw, t]));
        ok(b2["x"].tier === "high" && b2["y"].tier === "low", "^h/^l 简写应等价 high/low");
    }

    // ④ AND / OR / NOT 保留字（仅全大写）
    {
        const pAnd = parseQuery("a AND b");
        ok(raws(pAnd.must).join() === "a,b", `a AND b → must=[a,b]，实得 [${raws(pAnd.must)}]`);
        const pOr = parseQuery("a OR b");
        ok(raws(pOr.should).join() === "a,b" && pOr.must.length === 0, `a OR b → should=[a,b]，实得 [${raws(pOr.should)}]`);
        const pNot = parseQuery("a NOT b");
        ok(raws(pNot.mustNot).join() === "b", `a NOT b → mustNot=[b]，实得 [${raws(pNot.mustNot)}]`);
        ok(raws(pNot.should).join() === "a", `a NOT b → should=[a]，实得 [${raws(pNot.should)}]`);
        // 小写 and 当普通 should 词
        const pLower = parseQuery("a and b");
        ok(pLower.should.some(t => t.raw === "and"), "小写 and 应当普通 should 词");
        ok(pLower.must.length === 0, "小写 and 不触发 must");
    }

    // ⑤ 连字符真实 term 不当操作符
    {
        const p = parseQuery("claude-code gpt-5.4 co-worker");
        ok(raws(p.should).join() === "claude-code,co-worker,gpt-5.4", `连字符词应原样 should，实得 [${raws(p.should)}]`);
        ok(p.must.length === 0 && p.mustNot.length === 0, "词内连字符不当 + / - 操作符");
    }

    // ⑤b S-LOW-1：^数值 裸词（数学式/坐标）不当权重，保持 isPlain 字节兼容
    {
        // 3^5 / 2^10：body 纯数字 + 数值后缀 → ^ 当字面量，整词字面 should，isPlain 不破
        const p1 = parseQuery("3^5");
        ok(p1.isPlain === true, `"3^5" 应 isPlain=true（^ 当字面量），实得 ${p1.isPlain}`);
        ok(p1.should.length === 1 && p1.should[0].raw === "3^5", `"3^5" 应整串字面 should，实得 ${p1.should[0]?.raw}`);

        const p2 = parseQuery("2^10");
        ok(p2.isPlain === true, `"2^10" 应 isPlain=true，实得 ${p2.isPlain}`);
        ok(p2.should[0].raw === "2^10", `"2^10" 整串字面，实得 ${p2.should[0]?.raw}`);

        // 多 ^（a^b^c）→ 不当权重，isPlain
        const p3 = parseQuery("a^b^c");
        ok(p3.isPlain === true && p3.should[0].raw === "a^b^c", `"a^b^c" 多 ^ 不当权重，应字面 isPlain，实得 raw=${p3.should[0]?.raw} isPlain=${p3.isPlain}`);

        // ^ 前 body 为空（^5）→ 不当权重
        const p4 = parseQuery("^5");
        ok(p4.should.some(t => t.raw === "^5"), `"^5"（^前无 body）应字面 should，实得 [${raws(p4.should)}]`);

        // 反例：正常带权词不受影响
        const pHigh = parseQuery("auth^high");
        ok(pHigh.should[0].tier === "high" && pHigh.should[0].raw === "auth", "auth^high 仍正常 high 权重");
        const pNum = parseQuery("auth^2.5");
        ok(pNum.should[0].weight === 2.5 && pNum.should[0].raw === "auth", "auth^2.5 仍正常绝对权重 2.5");
        ok(pHigh.isPlain === false, "带 tier 权重词 isPlain=false（操作符确实存在）");
    }

    // ⑥ 转义字面量
    {
        const p = parseQuery("\\+literal \\-dash \\^caret");
        const r = raws(p.should);
        ok(r.includes("+literal"), `\\+literal 应字面量 should，实得 [${r}]`);
        ok(r.includes("-dash"), `\\-dash 应字面量 should，实得 [${r}]`);
        ok(r.includes("^caret"), `\\^caret 应字面量 should，实得 [${r}]`);
        ok(p.must.length === 0 && p.mustNot.length === 0, "转义后无硬过滤桶");
    }

    // ⑦ 短语
    {
        const p = parseQuery('"记忆 优化" 其他');
        const phrase = p.should.find(t => t.isPhrase);
        ok(!!phrase && phrase.raw === "记忆 优化", `应有一个 phrase should，实得 ${phrase?.raw}`);
        ok(p.should.some(t => t.raw === "其他" && !t.isPhrase), "短语外的词正常 should");
        ok(p.isPlain === false, "含短语 isPlain=false");
    }

    // ⑦b S-MID-1：前缀/后缀 + 短语组合（+"短语" / -"短语" / "短语"^high）
    {
        // +"短语" → must 桶的短语
        const pPlus = parseQuery('+"记忆 优化" 其他');
        const mustPhrase = pPlus.must.find(t => t.isPhrase);
        ok(!!mustPhrase && mustPhrase.raw === "记忆 优化", `+"短语" 应进 must 且 raw 完整无残引号，实得 ${mustPhrase?.raw}`);
        ok(pPlus.must.length === 1 && !pPlus.should.some(t => t.raw.includes('"')), "前缀短语不应残留引号污染 should");

        // -"短语" → mustNot 桶的短语
        const pMinus = parseQuery('-"记忆 优化"');
        const notPhrase = pMinus.mustNot.find(t => t.isPhrase);
        ok(!!notPhrase && notPhrase.raw === "记忆 优化", `-"短语" 应进 mustNot 且 raw 完整，实得 ${notPhrase?.raw}`);

        // "短语"^high → should 短语带 high 权重
        const pCaret = parseQuery('"记忆 优化"^high');
        const wPhrase = pCaret.should.find(t => t.isPhrase);
        ok(!!wPhrase && wPhrase.tier === "high" && wPhrase.weight === 2.0, `"短语"^high 应 tier=high/weight=2.0，实得 tier=${wPhrase?.tier} w=${wPhrase?.weight}`);
        ok(wPhrase!.raw === "记忆 优化", `"短语"^high 的 raw 不含 ^high 残留，实得 ${wPhrase?.raw}`);

        // "短语"^2.5 → 绝对数值权重
        const pNum = parseQuery('"a b"^2.5');
        const wNum = pNum.should.find(t => t.isPhrase);
        ok(!!wNum && wNum.weight === 2.5, `"短语"^2.5 绝对权重 2.5，实得 ${wNum?.weight}`);

        // 退化保护：普通 +词（非短语）仍正常进 must，没被新分支误伤
        const pWord = parseQuery("+普通词");
        ok(pWord.must.length === 1 && pWord.must[0].raw === "普通词" && !pWord.must[0].isPhrase, "普通 +词 仍正常进 must（非短语）");
    }

    // ⑧ 纯操作符 query → 降级 plain，不空不抛
    {
        for (const q of ["+", "-", "AND", '""', "^high"]) {
            const p = parseQuery(q);
            ok(!!p, `纯操作符 "${q}" 不应抛错`);
            // 不要求非空（"+ " 这种 body 为空），但不抛错、结构合法即可
            ok(Array.isArray(p.should), `"${q}" 应返回合法结构`);
        }
        // "+ " 单独 + 号无 body → 三桶空 → fallback
        const pp = parseQuery("+");
        ok(pp.must.length === 0, "孤立 + 不产生空 must term");
    }

    // ⑨ parseInline=false + "+a" → should=[+a] 整串字面量
    {
        const p = parseQuery("+a -b", { parseInline: false });
        ok(p.must.length === 0 && p.mustNot.length === 0, "parseInline=false 不解析 +/-");
        ok(raws(p.should).join() === "+a,-b", `parseInline=false 应整串 should，实得 [${raws(p.should)}]`);
    }

    // ⑩ tiers 结构化合流
    {
        const p = parseQuery("base", { tiers: { high: ["核心"], low: ["杂项"], required: ["必须"], exclude: ["排除"] } });
        ok(raws(p.must).join() === "必须", `tiers.required → must，实得 [${raws(p.must)}]`);
        ok(raws(p.mustNot).join() === "排除", `tiers.exclude → mustNot，实得 [${raws(p.mustNot)}]`);
        const high = p.should.find(t => t.raw === "核心");
        const low = p.should.find(t => t.raw === "杂项");
        ok(high?.tier === "high" && low?.tier === "low", "tiers.high/low 进 should 对应档");
        ok(p.should.some(t => t.raw === "base"), "query 裸词与 tiers 合流");
        ok(p.isPlain === false, "有 tiers 结构化输入 isPlain=false");
    }

    // ⑪ 同词冲突取高档 + tierConflict（query ^low 与 tiers.high 同词）
    {
        const p = parseQuery("词^low", { tiers: { high: ["词"] } });
        const t = p.should.find(x => x.raw === "词");
        ok(t?.tier === "high", `同词 ^low vs tiers.high 应取 high，实得 ${t?.tier}`);
    }

    // ⑫ must↔mustNot 同词矛盾 → must 胜 + tierConflict
    {
        const p = parseQuery("+词 -词");
        ok(raws(p.must).join() === "词", `must↔mustNot 矛盾应 must 胜，实得 must=[${raws(p.must)}] mustNot=[${raws(p.mustNot)}]`);
        ok(p.mustNot.length === 0, "矛盾词不应同时留在 mustNot");
        ok(!!p.tierConflict && p.tierConflict.length > 0, "矛盾应记 tierConflict");
    }

    // ⑬ expandWordTokens：CJK bigram 膨胀口径
    {
        ok(expandWordTokens("记忆库").join() === "记忆库,记忆,忆库", `记忆库膨胀，实得 ${expandWordTokens("记忆库")}`);
        ok(expandWordTokens("ab").join() === "ab", "短英文词不膨胀");
        ok(expandWordTokens("AB").join() === "ab", "膨胀应 toLowerCase");
        ok(expandWordTokens("记忆").join() === "记忆", "2 字 CJK 词不膨胀（len 须 >2）");
    }

    // ⑭ 多 must term 各自子膨胀不互相挤占（32 上限隐藏 bug 防护）
    {
        const p = parseQuery("+记忆系统优化 +知识图谱构建");
        ok(p.must.length === 2, "两个 must term 都应保留");
        // 各自有完整 bigram 膨胀，不因全局配额耗尽丢 token
        ok(p.must[0].tokens.includes("记忆系统优化") || p.must[0].tokens.length >= 5, "must term1 膨胀完整");
        ok(p.must[1].tokens.length >= 5, "must term2 膨胀完整，未被 term1 挤占");
    }

    // ⑮ shouldTokens 投影去重保序
    {
        const p = parseQuery("记忆库 记忆");
        const toks = shouldTokens(p);
        ok(toks[0] === "记忆库", "投影保序：首词整词在前");
        ok(new Set(toks).size === toks.length, "投影去重无重复");
    }

    // ⑯ S-SEV-1：defaultLogic 开关已移除——即便外部塞 defaultLogic，也被忽略（不改 isPlain、不改桶）
    {
        // 用 as any 模拟旧调用方仍传 defaultLogic（类型上已不接受）：应被静默忽略。
        const p = parseQuery("a b", { defaultLogic: "and" } as any);
        ok(p.isPlain === true, "传入已废弃的 defaultLogic 不应破坏 isPlain（开关已移除，恒 OR）");
        ok(!("defaultLogic" in p), "ParsedQuery 不再回传 defaultLogic 字段");
        ok(p.must.length === 0, "defaultLogic=and 不再把裸词提升为 must（语义反转开关已删）");
        // 硬 AND 仍可用：显式 +term 进 must 桶
        const pAnd = parseQuery("+a +b");
        ok(pAnd.must.length === 2, "显式 +term 仍提供硬 AND（must 桶），不依赖 defaultLogic");
    }

    console.log(`✅ query-parser 通过（${passed} 断言）：三轨解析/+-^/AND-OR-NOT/短语/转义/连字符/纯操作符降级/parseInline/tiers合流/同词冲突/子膨胀`);
} finally {
    // 无 env 残留需清
}
