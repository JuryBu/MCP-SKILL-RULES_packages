import assert from "node:assert/strict";
import {
    CHAIN_COMPAT_INPUT_VALUES,
    DATA_CHAIN_INPUT_VALUES,
    DATA_CHAIN_VALUES,
    assertValidDataChainInput,
    assertValidModelChainInput,
    normalizeDataChain,
    resolveChainSplit,
} from "../src/chain.ts";

function expectError(callback: () => void, pattern: RegExp): void {
    assert.throws(callback, pattern);
}

for (const input of ["dsh", "deepseek-harness"]) {
    assert.ok(DATA_CHAIN_INPUT_VALUES.includes(input as typeof DATA_CHAIN_INPUT_VALUES[number]));
    assert.ok(CHAIN_COMPAT_INPUT_VALUES.includes(input as typeof CHAIN_COMPAT_INPUT_VALUES[number]));
}
assert.ok(DATA_CHAIN_VALUES.includes("dsh"));
assert.equal(normalizeDataChain("deepseek-harness"), "dsh");
assert.equal(normalizeDataChain(" DeepSeek-Harness "), "dsh");

for (const input of ["dsh", "deepseek-harness"]) {
    assert.deepEqual(resolveChainSplit({ chain: input }), {
        chain: "auto",
        dataChain: "dsh",
        modelChain: "auto",
    });
}

for (const input of ["dsh", "deepseek-harness"]) {
    expectError(
        () => resolveChainSplit({ modelChain: input }),
        /DSH（DeepSeek Harness）只提供对话数据链路/u,
    );
    expectError(
        () => assertValidModelChainInput(input),
        /请使用 dataChain="dsh"/u,
    );
}

expectError(() => assertValidModelChainInput("windsurf"), /Windsurf 只提供对话数据链路/u);
expectError(() => assertValidDataChainInput("grok"), /Grok 只提供模型链路/u);
expectError(() => assertValidDataChainInput("agy"), /agy CLI 只提供模型链路/u);

const legacyCases = [
    ["auto", { chain: "auto", dataChain: "auto", modelChain: "auto" }],
    ["codex", { chain: "codex", dataChain: "codex", modelChain: "codex" }],
    ["claude-code", { chain: "claude-code", dataChain: "claude-code", modelChain: "claude-code" }],
    ["cc", { chain: "claude-code", dataChain: "claude-code", modelChain: "claude-code" }],
    ["windsurf", { chain: "auto", dataChain: "windsurf", modelChain: "auto" }],
    ["wsf", { chain: "auto", dataChain: "windsurf", modelChain: "auto" }],
    ["grok", { chain: "grok", dataChain: "auto", modelChain: "grok" }],
    ["agy", { chain: "agy", dataChain: "auto", modelChain: "agy" }],
] as const;

for (const [chain, expected] of legacyCases) {
    assert.deepEqual(resolveChainSplit({ chain }), expected);
}

console.log("chain-schema tests passed");
