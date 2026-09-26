import assert from "node:assert/strict";
import { renderGuardPromptForProvider, type GuardPromptInput } from "../src/guard-engine.ts";

const input: GuardPromptInput = {
    planContent: "PLAN ".repeat(20_000),
    taskContent: "TASK ".repeat(20_000),
    executionRecord: "EXECUTION ".repeat(20_000),
    coverageText: "COVERAGE ".repeat(10_000),
    evidenceText: "EVIDENCE ".repeat(10_000),
    evidenceIndexText: "INDEX ".repeat(10_000),
    appealNote: "APPEAL ".repeat(5_000),
    evidence: "MANUAL ".repeat(5_000),
    stageId: "Stage provider budget fixture",
    scopeSelectors: ["provider budget"],
};

const grok = renderGuardPromptForProvider(input, "grok");
assert.equal(grok.budget.inputBudgetChars, 200_000, "Grok 默认输入预算为 200K chars");
assert.equal(grok.budget.outputReserveChars > 0, true, "Grok 必须预留模型输出空间");
assert.equal(grok.prompt.length <= grok.budget.inputBudgetChars, true, "Grok prompt 必须落在其输入预算内");
assert.equal(grok.budget.sections.some(section => section.compressedChars > 0), true, "超长 Grok fixture 应返回分段压缩占用");

const agy = renderGuardPromptForProvider(input, "agy");
assert.equal(agy.budget.inputBudgetChars, 24_000, "agy 默认输入预算为 24K chars");
assert.equal(agy.budget.outputReserveChars > 0, true, "agy 必须预留模型输出空间");
assert.equal(agy.prompt.length <= agy.budget.inputBudgetChars, true, "agy prompt 必须落在其输入预算内");
assert.equal(agy.budget.sections.some(section => section.compressedChars > 0), true, "agy 应返回分段压缩占用");

assert.notEqual(grok.prompt, agy.prompt, "provider fallback 必须重渲染 prompt，不能复用 Grok 的大输入");
assert.equal(agy.prompt.length < grok.prompt.length, true, "agy fallback 应按较小预算重建输入");
assert.equal(agy.budget.compressionReasons.some(reason => reason.includes("provider=agy")), true, "agy 返回必须说明压缩原因");
assert.equal(agy.budget.sections.length, 8, "返回必须包含各输入部分的占用");

const previousAgyBudget = process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET;
const previousGrokBudget = process.env.MEMORY_STORE_GUARD_GROK_PROMPT_BUDGET;
const previousAgyReserve = process.env.MEMORY_STORE_GUARD_AGY_OUTPUT_RESERVE;
try {
    process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET = "12000";
    process.env.MEMORY_STORE_GUARD_GROK_PROMPT_BUDGET = "220000";
    process.env.MEMORY_STORE_GUARD_AGY_OUTPUT_RESERVE = "1000";
    const smaller = renderGuardPromptForProvider(input, "agy");
    const larger = renderGuardPromptForProvider(input, "grok");
    assert.equal(smaller.budget.inputBudgetChars, 12_000, "显式配置可下调");
    assert.equal(larger.budget.inputBudgetChars, 220_000, "显式配置可上调");
    assert.equal(smaller.budget.outputReserveChars, 1_000, "输出预留估计可下调");
    assert.equal(smaller.prompt.length <= 12_000, true);

    for (const invalid of ["", "0", "-1", "1.5", "1e3", "0x10", "NaN", "9007199254740992"]) {
        process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET = invalid;
        assert.equal(renderGuardPromptForProvider(input, "agy").budget.inputBudgetChars, 24_000, `非法配置 ${invalid} 回退默认值`);
    }
    const emptyInput: GuardPromptInput = {
        planContent: "", taskContent: "", executionRecord: "", coverageText: "",
        evidenceText: "", evidenceIndexText: "",
    };
    delete process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET;
    const templateChars = renderGuardPromptForProvider(emptyInput, "agy").prompt.length;
    process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET = String(templateChars);
    assert.equal(renderGuardPromptForProvider(emptyInput, "agy").prompt.length, templateChars, "恰好容纳必需模板");
    process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET = String(templateChars - 1);
    assert.throws(() => renderGuardPromptForProvider(emptyInput, "agy"), /小于必需模板.*模型调用已阻止/u);
} finally {
    if (previousAgyBudget === undefined) delete process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET;
    else process.env.MEMORY_STORE_GUARD_AGY_PROMPT_BUDGET = previousAgyBudget;
    if (previousGrokBudget === undefined) delete process.env.MEMORY_STORE_GUARD_GROK_PROMPT_BUDGET;
    else process.env.MEMORY_STORE_GUARD_GROK_PROMPT_BUDGET = previousGrokBudget;
    if (previousAgyReserve === undefined) delete process.env.MEMORY_STORE_GUARD_AGY_OUTPUT_RESERVE;
    else process.env.MEMORY_STORE_GUARD_AGY_OUTPUT_RESERVE = previousAgyReserve;
}

console.log("✅ guard-provider-budget 通过：默认、上下调、非法回退、模板边界与分段压缩");
