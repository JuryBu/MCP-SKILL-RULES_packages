import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FormattedRecordRound } from "../src/record-types.js";
import type { ConversationRound } from "../src/trajectory.js";

delete process.env.MEMORY_STORE_GROK_RECORD_MAX_PROMPT_CHARS;
process.env.MEMORY_STORE_RECORD_MODEL_TIMEOUT = "1200";
process.env.MEMORY_STORE_GROK_RECORD_TIMEOUT = "1200";
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-grok-budget-"));
process.env.MEMORY_STORE_DATA_ROOT = testDataRoot;

const RECORD_TIMEOUT_MS = 1200;
const GROK_BUDGET_CONSUMPTION_MS = 400;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let grokModelsOk = true;
let grokCompletionMode: "success" | "delayed-failure" = "success";
let lsModelResponseMode: "success" | "hold" = "success";
const heldLsResponses: Array<{ destroy: () => void }> = [];
const grokServer = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
        res.writeHead(grokModelsOk ? 200 : 503, { "content-type": "application/json" });
        res.end(grokModelsOk ? JSON.stringify({ data: [{ id: "grok-test" }] }) : JSON.stringify({ error: "down" }));
        return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
        if (grokCompletionMode === "delayed-failure") {
            setTimeout(() => {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "forced Grok failure after consuming record budget" }));
            }, GROK_BUDGET_CONSUMPTION_MS);
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            choices: [{
                message: { content: "## Phase 1：Grok diagnostics（轮次 1-1）\n\n- local test record" },
                finish_reason: "stop",
            }],
        }));
        return;
    }
    res.writeHead(404);
    res.end("not found");
});

const lsServer = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.endsWith("/Heartbeat")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
    }
    if (url.endsWith("/GetModelResponse")) {
        if (lsModelResponseMode === "hold") {
            heldLsResponses.push(res);
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: "## Phase 1：LS fallback（轮次 1-1）\n\n- local test record" }));
        return;
    }
    res.writeHead(404);
    res.end("not found");
});

await new Promise<void>(resolve => grokServer.listen(0, "127.0.0.1", resolve));
await new Promise<void>(resolve => lsServer.listen(0, "127.0.0.1", resolve));
const grokPort = (grokServer.address() as AddressInfo).port;
const lsPort = (lsServer.address() as AddressInfo).port;

process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${grokPort}`;
process.env.MEMORY_STORE_GROK_API_KEY = "record-budget-test";

const { __setParentLsForTest } = await import("../src/ls-client.ts");
__setParentLsForTest({
    info: { pid: process.pid, csrfToken: "fake-csrf", workspaceId: "fake-ws", ports: [lsPort] },
    port: lsPort,
});
const {
    createRecordChunks,
    getMaxPromptChars,
    getMinBatchRounds,
    resolveRecordModelScope,
    generateRecord,
} = await import("../src/record-generator.ts");
const {
    GROK_RECORD_MAX_PROMPT_CHARS,
    GROK_RECORD_TIMEOUT_MS,
    AGY_RECORD_MAX_PROMPT_CHARS,
    AGY_RECORD_TIMEOUT_MS,
    MAX_PROMPT_CHARS,
    MIN_BATCH_ROUNDS,
} = await import("../src/record-config.ts");
const { resetGrokBridgeAvailabilityForTest } = await import("../src/grok-client.ts");
const { callModelResponse } = await import("../src/model-bridge.ts");
const {
    configureProviderTransportAdapterForTest,
    resetProviderTransportAdapterForTest,
} = await import("../src/provider-transport-adapter.ts");

await configureProviderTransportAdapterForTest({
    mode: "test",
    dataRoot: process.env.MEMORY_STORE_DATA_ROOT,
    ownerId: "record-generator-grok-budget-test",
});

const formattedRounds: FormattedRecordRound[] = [1, 2, 3].map((roundIndex) => ({
    round: {
        roundIndex,
        startStep: roundIndex,
        endStep: roundIndex,
        userMessage: `round ${roundIndex}`,
        mediaAttachments: [],
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    },
    text: "x".repeat(80_000),
    chars: 80_000,
}));

const recordRounds: ConversationRound[] = [{
    roundIndex: 1,
    startStep: 1,
    endStep: 1,
    userMessage: "exercise Grok diagnostics and fallback budget",
    mediaAttachments: [],
    aiResponses: [],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
}];

function assertGrokDiagnostics(diagnostics: {
    concurrencyScope?: unknown;
    pid?: unknown;
    trafficClass?: unknown;
    batchQueueWaitMs?: unknown;
    globalQueueWaitMs?: unknown;
    batchLimit?: unknown;
    globalLimit?: unknown;
} | undefined, label: string): void {
    assert.ok(diagnostics, `${label} must expose Grok diagnostics`);
    assert.equal(diagnostics.concurrencyScope, "process", `${label} must state that concurrency diagnostics are process-local`);
    assert.equal(diagnostics.pid, process.pid, `${label} must preserve the producing process PID`);
    assert.equal(diagnostics.trafficClass, "record-batch", `${label} must preserve record-batch traffic class`);
    assert.equal(typeof diagnostics.batchQueueWaitMs, "number", `${label} must expose batch queue wait`);
    assert.equal(typeof diagnostics.globalQueueWaitMs, "number", `${label} must expose global queue wait`);
    assert.equal(typeof diagnostics.batchLimit, "number", `${label} must expose batch gate limit`);
    assert.equal(typeof diagnostics.globalLimit, "number", `${label} must expose process-global gate limit`);
}

try {
    assert.equal(GROK_RECORD_MAX_PROMPT_CHARS, 200_000);
    assert.equal(GROK_RECORD_TIMEOUT_MS, RECORD_TIMEOUT_MS);
    assert.equal(AGY_RECORD_MAX_PROMPT_CHARS, 24_000);
    assert.equal(AGY_RECORD_TIMEOUT_MS, 5 * 60_000);
    assert.equal(getMaxPromptChars("grok"), 200_000);
    assert.equal(getMaxPromptChars("agy"), 24_000);
    assert.equal(getMaxPromptChars("antigravity"), MAX_PROMPT_CHARS);
    assert.equal(getMinBatchRounds("grok"), MIN_BATCH_ROUNDS);

    const grokChunks = createRecordChunks(
        formattedRounds,
        getMaxPromptChars("grok") - 2_000,
        getMinBatchRounds("grok"),
    );
    const antigravityChunks = createRecordChunks(
        formattedRounds,
        getMaxPromptChars("antigravity") - 2_000,
        getMinBatchRounds("antigravity"),
    );
    assert.equal(grokChunks.length, 2, "Grok Record budget should split a 240k formatted input");
    assert.equal(antigravityChunks.length, 1, "Antigravity default budget should keep the same input in one chunk");

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = true;
    const autoGrokScope = await resolveRecordModelScope("auto", {});
    assert.equal(autoGrokScope.modelChain, "grok");
    assert.equal(autoGrokScope.modelName, "grok-4.3");
    assert.equal(autoGrokScope.timeoutMs, RECORD_TIMEOUT_MS);
    assert.equal(getMaxPromptChars(autoGrokScope.modelChain), 200_000);

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = false;
    const autoFallbackScope = await resolveRecordModelScope("auto", {});
    assert.equal(autoFallbackScope.modelChain, "antigravity");
    assert.equal(autoFallbackScope.modelName, "MODEL_PLACEHOLDER_M20");
    assert.equal(getMaxPromptChars(autoFallbackScope.modelChain), MAX_PROMPT_CHARS);

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = true;
    grokCompletionMode = "success";
    const bridged = await callModelResponse("flash", "model bridge diagnostics", "grok", 1_000, {
        grokContext: "record",
        trafficClass: "record-batch",
    });
    assertGrokDiagnostics(bridged.grokDiagnostics, "ModelBridge");

    resetGrokBridgeAvailabilityForTest();
    const generated = await generateRecord(
        "general",
        `record-grok-diagnostics-${Date.now()}`,
        "test",
        recordRounds,
        1,
        "auto",
        { parallelMode: "off", trafficClass: "record-batch" },
    );
    assert.equal(generated.success, true);
    assertGrokDiagnostics(generated.grokDiagnostics, "GenerateRecord");

    resetGrokBridgeAvailabilityForTest();
    grokCompletionMode = "delayed-failure";
    lsModelResponseMode = "hold";
    const capturedErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { capturedErrors.push(args.map(String).join(" ")); };
    try {
        const recordPromise = generateRecord(
            "general",
            `record-grok-shared-deadline-${Date.now()}`,
            "test",
            recordRounds,
            1,
            "auto",
            { parallelMode: "off", trafficClass: "record-batch" },
        );
        const result = await Promise.race([
            recordPromise,
            sleep(RECORD_TIMEOUT_MS + 200).then(() => null),
        ]);
        if (!result) {
            for (const response of heldLsResponses) response.destroy();
            await recordPromise;
            assert.fail("auto Record fallback restarted the full timeout instead of using the remaining shared budget");
        }
        assert.equal(result.success, false);
        const timeoutLog = capturedErrors.find(line => /Antigravity LS 模型调用超时/u.test(line));
        const remainingBudget = Number(/（(\d+)ms）/u.exec(timeoutLog || "")?.[1]);
        assert.ok(Number.isFinite(remainingBudget), "fallback timeout must be observable in the Record timeout diagnostic");
        assert.ok(
            remainingBudget < RECORD_TIMEOUT_MS - Math.floor(GROK_BUDGET_CONSUMPTION_MS / 2),
            "fallback must receive the remaining total budget after Grok has already consumed part of it",
        );
    } finally {
        console.error = originalConsoleError;
        lsModelResponseMode = "success";
        grokCompletionMode = "success";
        for (const response of heldLsResponses.splice(0)) response.destroy();
    }
} finally {
    __setParentLsForTest(null);
    await resetProviderTransportAdapterForTest();
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    await new Promise<void>(resolve => grokServer.close(() => resolve()));
    await new Promise<void>(resolve => lsServer.close(() => resolve()));
}
