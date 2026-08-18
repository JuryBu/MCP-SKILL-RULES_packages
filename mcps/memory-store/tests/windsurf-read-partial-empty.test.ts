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
import { __setWindsurfCascadeDirForTest } from "../src/windsurf-local-store.ts";
import { clearMappings } from "../src/conversation-router.ts";

process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-wsf-read-partial-"));

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

function installPool(
    pool: Array<{
        pid: number;
        port: number;
        summaries?: Record<string, number>;
        steps?: Record<string, any[]>;
    }>,
): void {
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfEndpointResolverForTest(async () => pool.map(item => endpoint(item.pid, item.port)));
    __setWindsurfTransportFactoryForTest((ep): WindsurfLsTransport => {
        const current = pool.find(item => item.pid === ep.pid && item.port === ep.port);
        return async (method: string, payload?: Record<string, unknown>) => {
            if (method === "Heartbeat") return {};
            if (method === "GetAllCascadeTrajectories") {
                const trajectorySummaries: Record<string, any> = {};
                for (const [id, stepCount] of Object.entries(current?.summaries || {})) {
                    trajectorySummaries[id] = {
                        cascadeId: id,
                        stepCount,
                        lastModifiedTime: "2026-07-10T00:00:00Z",
                    };
                }
                return { trajectorySummaries };
            }
            if (method === "GetCascadeTrajectorySteps") {
                const cascadeId = String(payload?.cascadeId || "");
                const offset = Number(payload?.stepOffset ?? 0);
                const steps = current?.steps?.[cascadeId] || [];
                return { steps: offset === 0 ? steps : [] };
            }
            return {};
        };
    });
}

async function readText(handler: ConversationHandler, args: Record<string, unknown>): Promise<string> {
    const result = await handler(args);
    return result.content?.find(item => item.type === "text")?.text || "";
}

const handler = captureConversationHandler();
const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-wsf-pb-"));
__setWindsurfCascadeDirForTest(pbDir);

try {
    {
        clearMappings();
        const conversationId = "wsf-partial-local-empty";
        fs.writeFileSync(path.join(pbDir, `${conversationId}.pb`), "pb");
        installPool([{ pid: 1, port: 9201, summaries: {}, steps: {} }]);
        const text = await readText(handler, {
            action: "read",
            dataChain: "windsurf",
            conversationId,
            startRound: 1,
            endRound: 2,
        });
        assert.match(text, /Windsurf 源读取暂不完整/u);
        assert.match(text, /fetch 强制 refresh/u);
        assert.match(text, /稍后重试/u);
        assert.doesNotMatch(text, /startRound 1 超出范围/u);
    }

    {
        clearMappings();
        const conversationId = "wsf-stepcount-but-empty";
        installPool([{
            pid: 2,
            port: 9202,
            summaries: { [conversationId]: 3 },
            steps: { [conversationId]: [] },
        }]);
        const text = await readText(handler, {
            action: "read",
            dataChain: "windsurf",
            conversationId,
            startRound: 1,
            endRound: 3,
        });
        assert.match(text, /Windsurf 源读取暂不完整/u);
        assert.match(text, /totalSteps=3|stepCount=3/u);
        assert.match(text, /fetch 强制 refresh/u);
        assert.doesNotMatch(text, /startRound 1 超出范围/u);
    }

    console.log("✅ windsurf-read-partial-empty 通过：partial 空壳与 stepCount>0 读空都会返回不完整提示");
} finally {
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfCascadeDirForTest(null);
    clearMappings();
}
