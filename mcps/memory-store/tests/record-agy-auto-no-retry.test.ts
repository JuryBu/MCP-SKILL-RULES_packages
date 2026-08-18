import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GenerateRecordOptions } from "../src/record-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-agy-auto-"));
const fakeAgyPath = path.join(tempRoot, "fake-agy.mjs");
const logPath = path.join(tempRoot, "agy-invocations.jsonl");
const missingCodexPath = path.join(tempRoot, "missing-codex.exe");

const previousEnvironment = new Map<string, string | undefined>([
    ["MEMORY_STORE_AGY_AUTO_ENABLED", process.env.MEMORY_STORE_AGY_AUTO_ENABLED],
    ["MEMORY_STORE_GROK_PROXY_URL", process.env.MEMORY_STORE_GROK_PROXY_URL],
    ["MEMORY_STORE_CODEX_COMMAND", process.env.MEMORY_STORE_CODEX_COMMAND],
    ["MEMORY_STORE_DATA_ROOT", process.env.MEMORY_STORE_DATA_ROOT],
    ["FAKE_AGY_LOG", process.env.FAKE_AGY_LOG],
]);

function restoreEnvironment(): void {
    for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function readInvocations(): Array<{ model: string }> {
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { model: string });
}

fs.writeFileSync(fakeAgyPath, `
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
    process.exit(0);
}
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "";
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ model, args }) + "\\n", "utf8");
process.stderr.write("invalid model " + model);
process.exit(2);
`, "utf8");

process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "1";
process.env.MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:1";
process.env.MEMORY_STORE_CODEX_COMMAND = missingCodexPath;
process.env.MEMORY_STORE_DATA_ROOT = path.join(tempRoot, "data");
process.env.FAKE_AGY_LOG = logPath;

const {
    configureProviderTransportAdapterForTest,
    resetProviderTransportAdapterForTest,
} = await import("../src/provider-transport-adapter.ts");

try {
    const { __disableLsForTest } = await import("../src/ls-client.ts");
    const { resetGrokBridgeAvailabilityForTest } = await import("../src/grok-client.ts");
    const { AGY_MODEL_SEQUENCE } = await import("../src/agy-client.ts");
    const { generateRecord } = await import("../src/record-generator.ts");

    await configureProviderTransportAdapterForTest({ mode: "shadow" });

    __disableLsForTest();
    resetGrokBridgeAvailabilityForTest();

    const options = {
        parallelMode: "off",
        __agyCommand: process.execPath,
        __agyCommandArgs: [fakeAgyPath],
    } as GenerateRecordOptions & {
        __agyCommand: string;
        __agyCommandArgs: string[];
        __lastRecordModelFailure?: {
            failureClass?: string;
            retryStrategy?: string;
            agyAttempts?: readonly { model: string; failureClass?: string }[];
        } | null;
    };
    const rounds: ConversationRound[] = [{
        roundIndex: 1,
        startStep: 1,
        endStep: 1,
        userMessage: "verify agy auto retry policy",
        mediaAttachments: [],
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    }];

    const result = await generateRecord("general", `agy-auto-${Date.now()}`, "test", rounds, 1, "auto", options);
    assert.equal(result.success, false);
    assert.deepEqual(readInvocations().map(invocation => invocation.model), AGY_MODEL_SEQUENCE);
    assert.equal(options.__lastRecordModelFailure?.failureClass, "DeterministicInput");
    assert.equal(options.__lastRecordModelFailure?.retryStrategy, "provider-fallback-exhausted");
    assert.deepEqual(options.__lastRecordModelFailure?.agyAttempts?.map(attempt => attempt.model), AGY_MODEL_SEQUENCE);
} finally {
    await resetProviderTransportAdapterForTest();
    restoreEnvironment();
    fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("record agy auto no-retry tests passed");
