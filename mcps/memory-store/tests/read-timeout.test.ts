import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paginateConversationReadText, registerConversation } from "../src/tools/conversation.ts";
import { materializeRoundAttachments, type ConversationAttachment } from "../src/conversation-attachments.ts";
import type { ConversationRound } from "../src/trajectory.ts";
import {
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    __resetWindsurfEndpointCacheForTest,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";
import { clearMappings } from "../src/conversation-router.ts";
import { resetConversationSourceCacheForTests, setConversationSourceCacheDataRootForTests } from "../src/conversation-source-cache.ts";

process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-read-timeout-"));
resetConversationSourceCacheForTests();
setConversationSourceCacheDataRootForTests(process.env.MEMORY_STORE_DATA_ROOT);

type ConversationHandler = (args?: Record<string, unknown>) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;

function captureConversationHandler(): ConversationHandler {
    let handler: ConversationHandler | undefined;
    const fakeServer = {
        tool(name: string, _description: string, _schema: unknown, registeredHandler: ConversationHandler) {
            if (name === "conversation_read_original") {
                handler = registeredHandler;
            }
        },
    };
    registerConversation(fakeServer as never);
    assert.ok(handler, "conversation_read_original 应成功注册");
    return handler!;
}

function endpoint(pid: number, port: number): WindsurfLsEndpoint {
    return { pid, port, csrfToken: `csrf-${pid}`, executablePath: `C:/wsf-${pid}.exe` };
}

const conversationId = "wsf-read-timeout-case";
const steps = Array.from({ length: 40 }, (_, index) => {
    if (index % 2 === 0) {
        return { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: `第 ${(index / 2) + 1} 轮用户消息` } };
    }
    return { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", text: `第 ${Math.ceil(index / 2)} 轮 AI 回复 ${"内容".repeat(20)}` };
});

function installPool(): void {
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfEndpointResolverForTest(async () => [endpoint(20, 9401)]);
    __setWindsurfTransportFactoryForTest((_ep): WindsurfLsTransport => async (method: string, payload?: Record<string, unknown>) => {
        if (method === "Heartbeat") return {};
        if (method === "GetAllCascadeTrajectories") {
            return {
                trajectorySummaries: {
                    [conversationId]: {
                        cascadeId: conversationId,
                        stepCount: steps.length,
                        lastModifiedTime: "2026-07-10T00:00:00Z",
                    },
                },
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            const cascadeId = String(payload?.cascadeId || "");
            const offset = Number(payload?.stepOffset ?? 0);
            return { steps: cascadeId === conversationId && offset === 0 ? steps : [] };
        }
        return {};
    });
}

async function readText(handler: ConversationHandler, args: Record<string, unknown>): Promise<string> {
    const result = await handler(args);
    return result.content?.find(item => item.type === "text")?.text || "";
}

function imageAttachment(seed: string): ConversationAttachment {
    return {
        kind: "image",
        source: "codex-data-url",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from(seed).toString("base64")}`,
        sizeBytes: seed.length,
    };
}

function attachmentRound(index: number, attachments: ConversationAttachment[]): ConversationRound {
    return {
        roundIndex: index,
        startStep: index,
        endStep: index,
        userMessage: `round ${index}`,
        mediaAttachments: [],
        attachments,
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

const handler = captureConversationHandler();
const originalNow = Date.now;
const originalReadFormatBudget = process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS;

try {
    installPool();
    clearMappings();

    process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG = "1";
    process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS = "0";
    const text = await readText(handler, {
        action: "read",
        dataChain: "windsurf",
        conversationId,
        startRound: 1,
        endRound: 20,
    });
    assert.match(text, /📖 读取轮次 1-20/u);
    assert.match(text, /⏱ read 分段:/u);
    assert.match(text, /部分结果/u);
    assert.match(text, /缩小轮次范围/u);

    const oversizedOutput = "x".repeat(100_001);
    for (const value of [NaN, Infinity, -1, 0, 1.5]) {
        const byBytes = paginateConversationReadText({
            conversationId,
            text: oversizedOutput,
            sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
            maxBytes: value,
        });
        const byChars = paginateConversationReadText({
            conversationId,
            text: oversizedOutput,
            sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
            maxChars: value,
        });
        assert.equal(byBytes.endCharPosition, 100_000, `maxBytes=${value} must use the default delivery budget`);
        assert.equal(byChars.endCharPosition, 100_000, `maxChars=${value} must use the default delivery budget`);
    }

    for (const value of ["not-a-number", "Infinity", "-1", "1.5"]) {
        process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS = value;
        const fallbackText = await readText(handler, {
            action: "read",
            dataChain: "windsurf",
            conversationId,
            startRound: 1,
            endRound: 20,
        });
        assert.match(fallbackText, /📖 读取轮次 1-20/u);
        assert.doesNotMatch(fallbackText, /部分结果/u, `MEMORY_STORE_READ_FORMAT_BUDGET_MS=${value} must use the default deadline instead of disabling it`);
    }

    let fakeNow = 0;
    Date.now = () => fakeNow++;
    const attachmentResult = await materializeRoundAttachments([
        attachmentRound(1, [imageAttachment("a"), imageAttachment("b"), imageAttachment("c"), imageAttachment("d")]),
        attachmentRound(2, [imageAttachment("e"), imageAttachment("f")]),
    ], "test-read-timeout-attachments", {
        deadlineAt: 7,
        concurrency: 1,
    });
    assert.equal(attachmentResult.budgetExceeded, true);
    const materializedCount = attachmentResult.rounds
        .flatMap(round => round.attachments || [])
        .filter(item => item.tempPath && fs.existsSync(item.tempPath))
        .length;
    const warnedCount = attachmentResult.rounds
        .flatMap(round => round.attachments || [])
        .filter(item => item.warning?.includes("达到附件物化时间预算"))
        .length;
    assert.ok(materializedCount >= 1, "预算触发前应保留已处理附件");
    assert.ok(warnedCount >= 1, "预算触发后未处理附件应带 warning");

    console.log("✅ read-timeout 通过：read 预算超限返回部分结果，附件预算超限保留已处理项并标记未处理项");
} finally {
    Date.now = originalNow;
    delete process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG;
    if (originalReadFormatBudget === undefined) delete process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS;
    else process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS = originalReadFormatBudget;
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfEndpointCacheForTest();
    clearMappings();
}
