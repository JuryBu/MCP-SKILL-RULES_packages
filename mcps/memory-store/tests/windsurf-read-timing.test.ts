import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerConversation } from "../src/tools/conversation.ts";
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
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-wsf-read-timing-"));
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

const conversationId = "wsf-read-timing-case";
let sourceDelayMs = 0;
const steps = [
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第一轮 alpha" } },
    { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", text: "AI alpha" },
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第二轮 beta" } },
    { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", text: "AI beta" },
];

function installPool(): void {
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfEndpointResolverForTest(async () => [endpoint(10, 9301)]);
    __setWindsurfTransportFactoryForTest((_ep): WindsurfLsTransport => async (method: string, payload?: Record<string, unknown>) => {
        if (sourceDelayMs > 0 && (method === "GetAllCascadeTrajectories" || method === "GetCascadeTrajectorySteps")) {
            await new Promise(resolve => setTimeout(resolve, sourceDelayMs));
        }
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

const handler = captureConversationHandler();

try {
    installPool();
    clearMappings();

    delete process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG;
    sourceDelayMs = 275;
    const fetchText = await readText(handler, {
        action: "fetch",
        dataChain: "windsurf",
        conversationId,
    });
    assert.match(fetchText, /⏱ WSF 源分段:/u);
    assert.match(fetchText, /endpoint/u);
    assert.match(fetchText, /steps/u);
    assert.match(fetchText, /enrich/u);
    assert.match(fetchText, /rounds/u);

    sourceDelayMs = 0;
    process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG = "1";
    const debugFetchText = await readText(handler, {
        action: "fetch",
        dataChain: "windsurf",
        conversationId,
    });
    assert.match(debugFetchText, /⏱ fetch 分段:/u);
    assert.match(debugFetchText, /格式化/u);
    assert.match(debugFetchText, /临时文件/u);

    const searchText = await readText(handler, {
        action: "search",
        dataChain: "windsurf",
        conversationId,
        query: "beta",
    });
    assert.match(searchText, /⏱ search 分段:/u);
    assert.match(searchText, /附件物化/u);
    assert.match(searchText, /格式化/u);

    process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS = "0";
    const readTextResult = await readText(handler, {
        action: "read",
        dataChain: "windsurf",
        conversationId,
        startRound: 1,
        endRound: 2,
    });
    assert.match(readTextResult, /⏱ read 分段:/u);
    assert.match(readTextResult, /附件物化/u);
    assert.match(readTextResult, /格式化/u);
    assert.match(readTextResult, /部分结果/u);
    assert.match(readTextResult, /缩小轮次范围/u);

    console.log("✅ windsurf-read-timing 通过：fetch/search/read 分段计时可见，read 预算超限返回部分结果提示");
} finally {
    sourceDelayMs = 0;
    delete process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG;
    delete process.env.MEMORY_STORE_READ_FORMAT_BUDGET_MS;
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfEndpointCacheForTest();
    clearMappings();
}
