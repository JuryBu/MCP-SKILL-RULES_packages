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
assert.equal(grok.budget.inputBudgetChars >= 200_000, true, "Grok 输入预算不得低于 200K chars");
assert.equal(grok.budget.outputReserveChars > 0, true, "Grok 必须预留模型输出空间");
assert.equal(grok.prompt.length <= grok.budget.inputBudgetChars, true, "Grok prompt 必须落在其输入预算内");
assert.equal(grok.budget.sections.some(section => section.compressedChars > 0), true, "超长 Grok fixture 应返回分段压缩占用");

const agy = renderGuardPromptForProvider(input, "agy");
assert.equal(agy.budget.inputBudgetChars >= 24_000, true, "agy 输入预算不得低于 24K chars");
assert.equal(agy.budget.outputReserveChars > 0, true, "agy 必须预留模型输出空间");
assert.equal(agy.prompt.length <= agy.budget.inputBudgetChars, true, "agy prompt 必须落在其输入预算内");
assert.equal(agy.budget.sections.some(section => section.compressedChars > 0), true, "agy 应返回分段压缩占用");

assert.notEqual(grok.prompt, agy.prompt, "provider fallback 必须重渲染 prompt，不能复用 Grok 的大输入");
assert.equal(agy.prompt.length < grok.prompt.length, true, "agy fallback 应按较小预算重建输入");
assert.equal(agy.budget.compressionReasons.some(reason => reason.includes("provider=agy")), true, "agy 返回必须说明压缩原因");
assert.equal(agy.budget.sections.length, 8, "返回必须包含各输入部分的占用");

console.log("✅ guard-provider-budget 通过：Grok/agy 预算、输出预留、fallback 重渲染与分段压缩原因均可观测");
