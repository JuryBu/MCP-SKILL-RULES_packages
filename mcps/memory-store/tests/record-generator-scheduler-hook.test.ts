import assert from "node:assert/strict";
import type { ProviderTransportLease } from "../src/provider-transport-adapter.js";
import type { RecordSchedulerModelCallContext, RecordSchedulerModelCallRecipe } from "../src/record-types.js";

process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "0";

const {
    __recordGeneratorSchedulerHookTest,
    createRecordModelLogicalCallKey,
} = await import("../src/record-generator.ts");

const routeRecipe: RecordSchedulerModelCallRecipe = {
    recipeVersion: 1,
    templateId: "scheduler-hook-auto/v1",
    range: { axis: "round", start: 12, end: 18 },
    composeOrder: 3,
    continuationKey: "test-route",
};

const selectedLease: ProviderTransportLease = {
    provider: "antigravity",
    trafficClass: "record",
    attemptId: "route-attempt-antigravity",
    permitId: "route-antigravity",
    probe: false,
};

const autoCalls: RecordSchedulerModelCallContext[] = [];
let autoUnderlyingCalls = 0;
let autoCandidateResolverCalls = 0;
const autoResult = await __recordGeneratorSchedulerHookTest.callOnce({
    model: "route-model",
    prompt: "auto-route-once",
    modelChain: "auto",
    timeout: 1_000,
    resolveCandidates: async () => {
        autoCandidateResolverCalls++;
        return ["grok", "antigravity"];
    },
    recipe: routeRecipe,
    options: {
        schedulerManagedExecution: true,
        schedulerRetryBudget: 2,
        trafficClass: "record-batch",
        schedulerModelCall: async (call) => {
            autoCalls.push(call);
            assert.deepEqual(call.routePlan, ["grok", "antigravity"]);
            assert.deepEqual(call.providerCalls.map(providerCall => providerCall.provider), ["grok", "antigravity"]);
            assert.equal(call.provider, "grok");
            assert.equal(call.model, call.providerCalls[0].model);
            assert.equal(call.recipe, routeRecipe);
            assert.equal(call.retryBudget, 2);
            const splitPrompt = call.splitPrompt({ axis: "round", start: 12, end: 14 });
            assert.match(splitPrompt, /12-14/);
            assert.match(splitPrompt, /auto-route-once/);
            return await call.providerCalls[1].invokePrompt(splitPrompt, {
                transportLease: selectedLease,
                attemptId: "route-attempt-antigravity",
            });
        },
    },
    invoke: async (input) => {
        autoUnderlyingCalls++;
        assert.equal(input.provider, "antigravity");
        assert.equal(input.providerLease, selectedLease);
        assert.equal(input.attemptId, "route-attempt-antigravity");
        assert.match(input.prompt, /12-14/);
        return { text: "auto-route-result", chainUsed: "antigravity", modelUsed: input.model };
    },
});
assert.equal(autoResult.text, "auto-route-result");
assert.equal(autoUnderlyingCalls, 1);
assert.equal(autoCandidateResolverCalls, 1, "scheduler-managed auto 必须只解析一次 provider candidates");
assert.equal(autoCalls.length, 1, "scheduler-managed auto 必须只调用一次 hook");
assert.equal(autoCalls[0].logicalCallKey, createRecordModelLogicalCallKey({
    prompt: "auto-route-once",
    logicalTimeout: 1_000,
    routePlan: ["grok", "antigravity"],
    recipe: routeRecipe,
    retryBudget: 2,
    trafficClass: "record-batch",
    context: autoCalls[0].context,
}));

const longPrompt = `LONG-SPLIT-HEADER\n${"甲乙丙丁".repeat(4_000)}\nLONG-SPLIT-TAIL`;
await __recordGeneratorSchedulerHookTest.callOnce({
    prompt: longPrompt,
    modelChain: "codex",
    recipe: {
        recipeVersion: 1,
        templateId: "scheduler-hook-long-split/v1",
        range: { axis: "round", start: 1, end: 4 },
        composeOrder: 0,
    },
    options: {
        schedulerManagedExecution: true,
        schedulerModelCall: async call => {
            const first = call.splitPrompt({ axis: "round", start: 1, end: 2 });
            const second = call.splitPrompt({ axis: "round", start: 3, end: 4 });
            assert.notEqual(first, second, "split children 必须获得不同正文窗口");
            assert.ok(first.length < longPrompt.length && second.length < longPrompt.length, "长 prompt split 必须真实缩小每个子输入");
            assert.match(first, /LONG-SPLIT-HEADER/u);
            assert.match(second, /LONG-SPLIT-TAIL/u);
            assert.equal(first.includes("�") || second.includes("�"), false, "中文 split 边界不得产生替换字符");
            return { text: "long-split-checked", chainUsed: "codex", modelUsed: "route-model" };
        },
    },
    invoke: async () => {
        throw new Error("scheduler hook 已返回结果，不得调用 provider");
    },
});

async function selectedProviderLogicalKey(provider: "grok" | "antigravity"): Promise<string> {
    let logicalCallKey = "";
    const result = await __recordGeneratorSchedulerHookTest.callOnce({
        prompt: "same-logical-route",
        modelChain: "auto",
        timeout: 900,
        candidates: ["grok", "antigravity"],
        recipe: {
            recipeVersion: 1,
            templateId: "scheduler-hook-key/v1",
            range: { axis: "round", start: 1, end: 2 },
            composeOrder: 0,
        },
        options: {
            schedulerManagedExecution: true,
            schedulerModelCall: async (call) => {
                logicalCallKey = call.logicalCallKey;
                const selected = call.providerCalls.find(providerCall => providerCall.provider === provider);
                assert.ok(selected);
                return await selected.invoke();
            },
        },
        invoke: async (input) => ({ text: `${input.provider}-result`, chainUsed: input.provider }),
    });
    assert.equal(result.text, `${provider}-result`);
    return logicalCallKey;
}

assert.equal(
    await selectedProviderLogicalKey("grok"),
    await selectedProviderLogicalKey("antigravity"),
    "同一 logical route 的 key 不得随着实际 provider attempt 改变",
);

let managedRetryHookCalls = 0;
let managedRetryUnderlyingCalls = 0;
const managedRetryResult = await __recordGeneratorSchedulerHookTest.callWithRetry({
    prompt: "scheduler-owned-retry",
    modelChain: "codex",
    options: {
        schedulerManagedExecution: true,
        schedulerModelCall: async (call) => {
            managedRetryHookCalls++;
            return await call.providerCalls[0].invoke();
        },
    },
    invoke: async () => {
        managedRetryUnderlyingCalls++;
        return { text: null, error: "scheduler must own retry", chainUsed: "codex" };
    },
});
assert.equal(managedRetryResult.text, null);
assert.equal(managedRetryHookCalls, 1, "scheduler-managed retry 不得二次回调 hook");
assert.equal(managedRetryUnderlyingCalls, 1, "scheduler-managed retry 不得二次调用底层 provider");

let noHookUnderlyingCalls = 0;
const noHookResult = await __recordGeneratorSchedulerHookTest.callOnce({
    prompt: "scheduler-hook-required",
    modelChain: "codex",
    options: { schedulerManagedExecution: true },
    invoke: async () => {
        noHookUnderlyingCalls++;
        return { text: "must-not-run", chainUsed: "codex" };
    },
});
assert.equal(noHookResult.text, null);
assert.match(noHookResult.error || "", /schedulerModelCall/u);
assert.equal(noHookUnderlyingCalls, 0, "缺 scheduler hook 必须 fail closed，底层 invoke 为 0");

const legacyProviders: string[] = [];
let legacyUnderlyingCalls = 0;
const legacyResult = await __recordGeneratorSchedulerHookTest.callOnce({
    prompt: "legacy-auto-loop",
    modelChain: "auto",
    candidates: ["grok", "antigravity"],
    options: {
        schedulerModelCall: async (call) => {
            legacyProviders.push(call.provider);
            return await call.invoke();
        },
    },
    invoke: async (input) => {
        legacyUnderlyingCalls++;
        return input.provider === "grok"
            ? { text: null, error: "grok unavailable", chainUsed: "grok" }
            : { text: "legacy-auto-result", chainUsed: "antigravity" };
    },
});
assert.equal(legacyResult.text, "legacy-auto-result");
assert.deepEqual(legacyProviders, ["grok", "antigravity"], "未启用 schedulerManagedExecution 必须保留旧 provider loop");
assert.equal(legacyUnderlyingCalls, 2);

const legacyRetryOrdinals: number[] = [];
let legacyRetryUnderlyingCalls = 0;
const legacyRetryResult = await __recordGeneratorSchedulerHookTest.callWithRetry({
    prompt: "legacy-outer-retry",
    modelChain: "codex",
    options: {
        schedulerModelCall: async (call) => {
            legacyRetryOrdinals.push(call.retryOrdinal);
            return await call.invoke();
        },
    },
    invoke: async () => {
        legacyRetryUnderlyingCalls++;
        return legacyRetryUnderlyingCalls === 1
            ? { text: null, error: "legacy first attempt failed", chainUsed: "codex" }
            : { text: "legacy retry result", chainUsed: "codex" };
    },
});
assert.equal(legacyRetryResult.text, "legacy retry result");
assert.deepEqual(legacyRetryOrdinals, [0, 1]);
assert.equal(legacyRetryUnderlyingCalls, 2, "legacy 路径必须保留外层 retry");

let replayUnderlyingCalls = 0;
const replayResult = await __recordGeneratorSchedulerHookTest.callOnce({
    prompt: "route-replay-cache",
    modelChain: "codex",
    options: {
        schedulerManagedExecution: true,
        schedulerModelCall: async () => ({ text: "cached-route-result", chainUsed: "codex", modelUsed: "cached-model" }),
    },
    invoke: async () => {
        replayUnderlyingCalls++;
        throw new Error("scheduler replay must skip provider invoke");
    },
});
assert.equal(replayResult.text, "cached-route-result");
assert.equal(replayUnderlyingCalls, 0);

console.log("record generator scheduler route hook tests passed");
