import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateAutoSummaryCandidate } from "../src/auto-summary-validation.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-validation-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { generateAutoSummaryResult } = await import("../src/auto-summary.ts");

try {
    for (const invalid of [
        "", "  \n ",
        "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.",
        "Example Model has been retired. Please select a different model.",
        '{"error":{"code":503,"message":"Service unavailable"}}',
        "HTTP 503: Service unavailable", "服务错误：请稍后重试",
        "服务错误：请修复配置后重试", '{"status":"error","message":"unavailable"}',
        '{"response":"Synthetic Model is no longer available. Please switch to another model."}',
        "Service unavailable",
    ]) assert.ok(validateAutoSummaryCandidate(invalid), invalid);
    for (const valid of [
        "短摘要", "记录 Gemini 服务停用通知的排查过程，并修复把非空错误文本保存为摘要的问题。",
        "HTTP 503: 修复代理配置后已通过测试，保留原请求供复核。",
        '分析返回中的 {"error":"service unavailable"}，改为总期限内回退并记录实际模型。',
        "调查 Example Model is no longer available 提示，确认服务迁移后重新生成摘要。",
        "The investigation fixed an Error: Service unavailable response in the summary pipeline.",
        "We discussed why Synthetic Model is no longer available. Please switch to another model.",
    ]) assert.equal(validateAutoSummaryCandidate(valid), null, valid);
    let validated = false;
    const valid = await generateAutoSummaryResult("synthetic", [], "synthetic body", "grok", {
        callModel: async (_model, _prompt, chain, _timeout, options) => {
            assert.equal(chain, "grok");
            assert.ok(options?.responseValidator);
            validated = true;
            assert.equal(options.responseValidator({ text: "HTTP 503: Service unavailable", provider: "grok", model: "fixture-model" }), "service-error-response");
            return { text: "保存合成测试的处理结果与后续安排。", chainUsed: "grok", modelUsed: "fixture-model" };
        },
    });
    assert.ok(validated);
    assert.equal(valid.summary, "保存合成测试的处理结果与后续安排。");
    assert.equal(valid.provenance.provider, "grok");
    assert.equal(valid.provenance.model, "fixture-model");
    assert.ok(valid.provenance.generatedAt);
    for (const flags of [{ cancelled: true }, { safetyStopped: true }, { failureClass: "UnknownOutcome" as const }, { timedOut: true }]) {
        const stopped = await generateAutoSummaryResult("synthetic", [], "synthetic body", "auto", {
            callModel: async () => ({ text: "忽略停止状态会错误接受此摘要", chainUsed: "codex", ...flags }),
        });
        assert.equal(stopped.summary, null);
        assert.equal(stopped.provenance.status, "failed");
    }
    const rejected = await generateAutoSummaryResult("synthetic", [], "synthetic body", "auto", {
        callModel: async () => ({ text: "HTTP 503: Service unavailable", chainUsed: "grok" }),
    });
    assert.equal(rejected.summary, null);
    assert.equal(rejected.provenance.failures[0]?.kind, "response-validation");
    console.log("auto-summary-validation: notices/errors rejected, normal discussion retained, structured provenance and terminal stops passed");
} finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
