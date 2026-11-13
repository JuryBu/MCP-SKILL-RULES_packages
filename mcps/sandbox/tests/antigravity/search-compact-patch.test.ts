import assert from "node:assert/strict";
import { test } from "node:test";
import { AntigravityCallError } from "../../src/antigravity-model-catalog.js";
import { callSmartModelWithFallback, generateIndex, isCompactSmartInput, parallelDispatch, searchCompactUnit, type SearchUnit } from "../../src/tools/smart-search.js";

function sampleUnit(code = "export function selectModel() { return 'carbon'; }"): SearchUnit {
    return { id: "sample", type: "file", filePath: "sample.ts", allFiles: ["sample.ts"], code,
        hitLines: new Map([["sample.ts", [1]]]), hitContent: new Map([["sample.ts", [code]]]), functionBounds: [] };
}

test("compact path is restricted to one complete bounded input", () => {
    assert.equal(isCompactSmartInput([sampleUnit()]), true);
    assert.equal(isCompactSmartInput([sampleUnit(), sampleUnit()]), false);
    assert.equal(isCompactSmartInput([sampleUnit("x".repeat(12_001))]), false);
    assert.equal(isCompactSmartInput([{ ...sampleUnit(), allFiles: ["first.ts", "second.ts"] }]), false);
});

test("one semantic call receives full code and returns actual quoted function", async () => {
    const unit = sampleUnit();
    const prompts: string[] = [];
    const result = await searchCompactUnit("模型选择", unit, async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ matches: [{ function: "selectModel", snippets: [unit.code], explanation: "selects Carbon" }] });
    });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(unit.code));
    assert.equal(result.fallback, false);
    assert.equal(result.results[0].functionName, "selectModel");
});

test("semantic no-match stays empty and malformed output is explicitly local fallback", async () => {
    assert.deepEqual(await searchCompactUnit("unrelated", sampleUnit(), async () => '{"matches":[]}'), { results: [], fallback: false });
    const fallback = await searchCompactUnit("selectModel", sampleUnit(), async () => "invalid JSON");
    assert.equal(fallback.fallback, true);
    assert.ok(fallback.results.every((result) => result.fallback));
});

test("verbose optional index labels do not discard a valid structural index", async () => {
    const result = await generateIndex(sampleUnit(), { query: "selectModel", callModel: async () => JSON.stringify({ file: "sample.ts",
        functions: [{ name: "selectModel", tag: "long label ".repeat(20) }], fileSummary: "long summary ".repeat(20) }) });
    assert.equal(result.fallback, false);
    assert.equal(result.files[0].functions[0].tag.length, 50);
    assert.equal(result.files[0].fileSummary.length, 80);
});

test("unknown accepted request cannot retry or change provider", async () => {
    const error = new AntigravityCallError("timeout", { submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "timeout-unknown" });
    let calls = 0;
    await assert.rejects(callSmartModelWithFallback({ primary: "antigravity", concurrency: 1, fallback: ["codex"] }, "prompt", "direct", {
        callBridge: async () => { calls += 1; throw error; },
    }), (actual) => actual === error);
    assert.equal(calls, 1);
    await assert.rejects(generateIndex(sampleUnit(), { query: "selectModel", callModel: async () => { throw error; },
        splitUnit: () => [sampleUnit()] }), (actual) => actual === error);
});

test("dispatch propagates non-retryable model outcome before retrying or starting queued units", async () => {
    const error = new AntigravityCallError("quota exhausted", { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "quota-exhausted" });
    let calls = 0;
    await assert.rejects(parallelDispatch([1, 2, 3], async () => { calls += 1; throw error; },
        { concurrency: 1, propagateNonRetryable: true }), (actual) => actual === error);
    assert.equal(calls, 1);
});

test("two active workers stop the remaining queue after an unknown outcome", async () => {
    const error = new AntigravityCallError("timeout", { submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "timeout-unknown" });
    const started: number[] = [];
    await assert.rejects(parallelDispatch([1, 2, 3], async (value) => {
        started.push(value);
        if (value === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 15));
        return value;
    }, { concurrency: 2, propagateNonRetryable: true }), actual => actual === error);
    assert.deepEqual(started, [1, 2]);
});

test("unknown outcome during the second attempt preserves the original error", async () => {
    const error = new AntigravityCallError("timeout", { submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "timeout-unknown" });
    const attempts: number[] = [];
    await assert.rejects(parallelDispatch([1], async (_value, _index, attempt) => {
        attempts.push(attempt);
        if (attempt === 1) throw new Error('temporary connection failure');
        throw error;
    }, { concurrency: 1, propagateNonRetryable: true }), actual => actual === error);
    assert.deepEqual(attempts, [1, 2]);
});
