import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationLoadResult } from "../src/conversation-bridge.ts";
import type { ConversationRound } from "../src/trajectory.ts";
import { __setLsRpcImplForTest, type LsProcessInfo, type RpcResult } from "../src/ls-rpc.ts";
import {
    __resetLsTestOverridesForTest,
    __setConvCacheDirForTest,
    __setParentLsForTest,
} from "../src/ls-client.ts";
import {
    __resetWindsurfConversationCacheForTest,
    __resetWindsurfEndpointCacheForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
} from "../src/windsurf-client.ts";

const cache = await import("../src/conversation-source-cache.ts");
const bridge = await import("../src/conversation-bridge.ts");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-bridge-cache-"));
const conversationId = "cache-only-conversation";
const key = { source: "codex:link=summary", conversationId };
const round: ConversationRound = {
    roundIndex: 1556,
    startStep: 1,
    endStep: 2,
    userMessage: "用户消息",
    mediaAttachments: [],
    aiResponses: [{ stepIndex: 2, response: "模型回复", thinking: "", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    userMessages: [{ stepIndex: 1, text: "用户消息", rawRole: "user", semanticRole: "user", mediaAttachments: [] }],
    legacyRoundIndices: [1556],
    semanticEvents: [],
};

const LOCAL_PB_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function localPbVarint(value: bigint | number): Buffer {
    let current = typeof value === "bigint" ? value : BigInt(value);
    const bytes: number[] = [];
    do {
        const byte = Number(current & 0x7fn);
        current >>= 7n;
        bytes.push(current === 0n ? byte : byte | 0x80);
    } while (current !== 0n);
    return Buffer.from(bytes);
}

function localPbBytes(fieldNumber: number, value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    return Buffer.concat([localPbVarint((fieldNumber << 3) | 2), localPbVarint(bytes.byteLength), bytes]);
}

function encryptLocalPb(plaintext: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", LOCAL_PB_KEY, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function localPbConversation(conversationId: string, user: string, response: string): Buffer {
    const step = Buffer.concat([
        localPbBytes(19, localPbBytes(1, user)),
        localPbBytes(20, localPbBytes(1, response)),
    ]);
    return Buffer.concat([localPbBytes(1, conversationId), localPbBytes(2, step)]);
}

function lsConversationSteps(prefixUser: string, prefixResponse: string, options: { includeTail?: boolean; includeTool?: boolean } = {}): unknown[] {
    const steps: unknown[] = [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: prefixUser } },
        { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: prefixResponse } },
    ];
    if (options.includeTool) {
        steps.push({
            type: "CORTEX_STEP_TYPE_MCP_TOOL",
            mcpTool: {
                toolCall: { name: "semantic_tool", argumentsJson: "{\"ok\":true}" },
                resultString: "semantic result",
            },
        });
    }
    if (options.includeTail === false) return steps;
    return [
        ...steps,
        { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "LS 新增用户尾部" } },
        { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "LS 新增回复尾部" } },
    ];
}

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);
    const snapshot: ConversationLoadResult = {
        chainUsed: "codex",
        conversationId,
        rounds: [],
        totalSteps: 2,
        codexData: {
            thread: {
                id: conversationId,
                rolloutPath: "C:/not-accessed/cache-only.jsonl",
                cwd: "C:/workspace",
                title: "cache-only",
                source: "fixture",
            },
            rounds: [],
            totalSteps: 2,
            childThreads: [],
        },
    };
    const published = await cache.readOrBuild<ConversationLoadResult, ConversationRound>({
        key,
        fingerprint: { revision: "fixture-v1" },
        build: () => ({ snapshot, rounds: [round] }),
        getRoundNumber: item => item.roundIndex,
    });

    const loaded = await bridge.loadConversationData("codex", conversationId, { source: "cache", link: "summary" });
    assert.ok(loaded, "cache-only 应在原始 JSONL 不存在时仍可读取已发布缓存");
    assert.equal(loaded?.cacheGeneration, published.generation);
    assert.equal(loaded?.cacheState, "hit");
    assert.equal(loaded?.sourceMode, "cache");
    assert.equal(loaded?.rounds[0]?.userMessage, "用户消息");
    assert.equal(loaded?.rounds[0]?.roundIndex, 1556, "缓存水合不得把稳定轮次重新编号为 1");
    assert.equal(loaded?.codexData?.rounds[0]?.aiResponses[0]?.response, "模型回复");
    const ranged = await bridge.loadConversationData("codex", conversationId, {
        source: "cache",
        link: "summary",
        roundRange: { startRound: 1556, endRound: 1556 },
    });
    assert.deepEqual(ranged?.rounds.map(item => item.roundIndex), [1556], "范围读取必须保留缓存里的稳定轮次编号");

    await assert.rejects(
        () => bridge.loadConversationData("codex", conversationId, { source: "ls" }),
        /source=ls 不支持 codex/u,
    );
    const missingVariant = await bridge.loadConversationData("codex", conversationId, { source: "cache", link: "reference" });
    assert.equal(missingVariant, null, "不同 link 语义不能误读另一变体缓存");

    const lsCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-bridge-ls-cache-"));
    const lsInfo: LsProcessInfo = { pid: 6512, csrfToken: "test-csrf", workspaceId: "test-workspace", ports: [9651] };
    const explicitId = "antigravity-bridge-cache";
    const autoId = "antigravity-bridge-auto-cache";
    const antigravityLocalId = "antigravity-local-authority-cache";
    const windsurfLocalId = "windsurf-local-authority-cache";
    const windsurfEqualId = "windsurf-equal-prefers-ls-cache";
    const localUser = "本地 PB 共有用户前缀";
    const localResponse = "本地 PB 共有回复前缀";
    const antigravityPbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-antigravity-local-pb-"));
    const windsurfPbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-windsurf-local-pb-"));
    const localPbEnvironmentKeys = [
        "MEMORY_STORE_LOCAL_PB_KEY",
        "MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT",
        "MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT",
        "MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT",
        "MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT",
    ] as const;
    const originalLocalPbEnvironment = new Map(localPbEnvironmentKeys.map(key => [key, process.env[key]]));
    let stepCount = 2;
    let watermark: string | undefined = "2026-08-03T14:00:00.000Z";
    let stepReads = 0;
    let antigravityLsVisible = false;
    let antigravityLocalStepReads = 0;
    let windsurfLsVisible = false;
    let windsurfLocalStepReads = 0;
    __setConvCacheDirForTest(lsCacheRoot);
    __setParentLsForTest({ info: lsInfo, port: 9651 });
    fs.mkdirSync(path.join(antigravityPbRoot, "active"));
    fs.mkdirSync(path.join(antigravityPbRoot, "implicit"));
    fs.mkdirSync(path.join(windsurfPbRoot, "active"));
    fs.mkdirSync(path.join(windsurfPbRoot, "implicit"));
    process.env.MEMORY_STORE_LOCAL_PB_KEY = LOCAL_PB_KEY.toString("base64");
    process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = path.join(antigravityPbRoot, "active");
    process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = path.join(antigravityPbRoot, "implicit");
    process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(windsurfPbRoot, "active");
    process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(windsurfPbRoot, "implicit");
    fs.writeFileSync(path.join(antigravityPbRoot, "active", `${antigravityLocalId}.pb`), encryptLocalPb(localPbConversation(antigravityLocalId, localUser, localResponse)));
    fs.writeFileSync(path.join(windsurfPbRoot, "active", `${windsurfLocalId}.pb`), encryptLocalPb(localPbConversation(windsurfLocalId, localUser, localResponse)));
    fs.writeFileSync(path.join(windsurfPbRoot, "active", `${windsurfEqualId}.pb`), encryptLocalPb(localPbConversation(windsurfEqualId, localUser, localResponse)));
    __setLsRpcImplForTest(async (
        _info: LsProcessInfo,
        _port: number,
        method: string,
        payload: Record<string, unknown>,
    ): Promise<RpcResult> => {
        if (method === "GetAllCascadeTrajectories") {
            const trajectorySummaries: Record<string, unknown> = {
                [explicitId]: { cascadeId: explicitId, stepCount, lastModifiedTime: watermark },
                [autoId]: { cascadeId: autoId, stepCount, lastModifiedTime: watermark },
            };
            if (antigravityLsVisible) {
                trajectorySummaries[antigravityLocalId] = {
                    cascadeId: antigravityLocalId,
                    stepCount: 4,
                    lastModifiedTime: "2026-08-03T14:04:00.000Z",
                };
            }
            return {
                status: 200,
                data: {
                    trajectorySummaries,
                },
                rawSize: 100,
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            if (payload.cascadeId === antigravityLocalId) {
                antigravityLocalStepReads += 1;
                const steps = antigravityLsVisible && Number(payload.stepOffset ?? 0) === 0
                    ? lsConversationSteps(localUser, localResponse)
                    : [];
                return { status: 200, data: { steps }, rawSize: JSON.stringify(steps).length };
            }
            stepReads += 1;
            const offset = Number(payload.stepOffset ?? 0);
            const steps = offset === 0
                ? Array.from({ length: stepCount }, (_, index) => ({ type: "STEP", index }))
                : [];
            return { status: 200, data: { steps }, rawSize: JSON.stringify(steps).length };
        }
        return { status: 404, data: {}, rawSize: 0 };
    });
    __resetWindsurfEndpointCacheForTest();
    __resetWindsurfConversationCacheForTest();
    __setWindsurfEndpointResolverForTest(async () => [{ pid: 6513, port: 9652, csrfToken: "windsurf-test-csrf", executablePath: "C:/windsurf-test.exe" }]);
    __setWindsurfTransportFactoryForTest(() => async (method, payload) => {
        if (method === "Heartbeat") return {};
        if (method === "GetAllCascadeTrajectories") {
            return {
                trajectorySummaries: windsurfLsVisible
                    ? {
                        [windsurfLocalId]: {
                            cascadeId: windsurfLocalId,
                            stepCount: 4,
                            lastModifiedTime: "2026-08-03T14:04:00.000Z",
                        },
                        [windsurfEqualId]: {
                            cascadeId: windsurfEqualId,
                            stepCount: 3,
                            lastModifiedTime: "2026-08-03T14:05:00.000Z",
                        },
                    }
                    : {},
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            windsurfLocalStepReads += 1;
            const steps = windsurfLsVisible && Number(payload.stepOffset ?? 0) === 0
                ? payload?.cascadeId === windsurfLocalId
                    ? lsConversationSteps(localUser, localResponse)
                    : payload?.cascadeId === windsurfEqualId
                        ? lsConversationSteps(localUser, localResponse, { includeTail: false, includeTool: true })
                        : []
                : [];
            return { steps };
        }
        return {};
    });
    try {
        const explicitFirst = await bridge.loadConversationData("antigravity", explicitId, { source: "ls" });
        assert.equal(explicitFirst?.totalSteps, 2, "显式 LS 首次读取应写入缓存");
        const explicitGeneration = explicitFirst?.cacheGeneration;

        stepCount = 3;
        watermark = "2026-08-03T14:01:00.000Z";
        const explicitUpdated = await bridge.loadConversationData("antigravity", explicitId, { source: "ls" });
        assert.equal(explicitUpdated?.totalSteps, 3, "显式 LS 的水位变化不能永久命中旧缓存");
        assert.notEqual(explicitUpdated?.cacheGeneration, explicitGeneration, "显式 LS 更新应发布新缓存代次");

        watermark = undefined;
        stepCount = 4;
        const explicitUnversioned = await bridge.loadConversationData("antigravity", explicitId, { source: "ls" });
        stepCount = 5;
        const explicitUnversionedUpdated = await bridge.loadConversationData("antigravity", explicitId, { source: "ls" });
        assert.equal(explicitUnversioned?.totalSteps, 4, "缺失 LS 水位时仍应构建当前快照");
        assert.equal(explicitUnversionedUpdated?.totalSteps, 5, "缺失 LS 水位时不能用 null 指纹永久命中旧缓存");

        stepCount = 2;
        watermark = "2026-08-03T14:02:00.000Z";
        const autoFirst = await bridge.loadConversationData("antigravity", autoId, { source: "auto" });
        assert.equal(autoFirst?.totalSteps, 2, "auto 首次应选择可用的 LS 数据");
        const autoKey = { source: "antigravity", conversationId: autoId };
        const autoSnapshot = cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: autoKey });
        assert.equal(autoSnapshot?.snapshot.cacheAuthority, "ls", "auto 缓存必须记录 LS 为实际权威来源");

        const autoSecond = await bridge.loadConversationData("antigravity", autoId, { source: "auto" });
        assert.equal(autoSecond?.totalSteps, 2, "auto 应在迁移到组合水位后保留 LS 快照");
        const stepReadsAfterWatermarkCache = stepReads;
        const autoStable = await bridge.loadConversationData("antigravity", autoId, { source: "auto" });
        assert.equal(autoStable?.cacheState, "hit", "LS 与本地 PB stat 均未变化时应命中 conversation cache");
        assert.equal(stepReads, stepReadsAfterWatermarkCache, "稳定的 auto LS 命中只检查轻量水位，不能再次读取整段轨迹");

        stepCount = 4;
        watermark = "2026-08-03T14:03:00.000Z";
        const autoUpdated = await bridge.loadConversationData("antigravity", autoId, { source: "auto" });
        assert.equal(autoUpdated?.totalSteps, 4, "auto 在 LS 已选为权威后必须感知 LS 更新");
        assert.ok(stepReads > stepReadsAfterWatermarkCache, "LS 水位变化后才重新读取轨迹");

        const antigravityLocalFirst = await bridge.loadConversationData("antigravity", antigravityLocalId, { source: "auto" });
        assert.equal(antigravityLocalFirst?.totalSteps, 1, "Antigravity 在 LS 缺席时应由本地 PB 构建缓存");
        const antigravityLocalKey = { source: "antigravity", conversationId: antigravityLocalId };
        const antigravityLocalCache = cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: antigravityLocalKey });
        assert.equal(antigravityLocalCache?.snapshot.cacheAuthority, "local", "Antigravity auto 缓存必须记录本地 PB authority");
        const antigravityLocalGeneration = antigravityLocalFirst?.cacheGeneration;
        antigravityLsVisible = true;
        const antigravityTail = await bridge.loadConversationData("antigravity", antigravityLocalId, { source: "auto" });
        assert.equal(antigravityTail?.totalSteps, 4, "Antigravity LS 出现新增尾部后 auto 必须重建并采用更完整来源");
        assert.notEqual(antigravityTail?.cacheGeneration, antigravityLocalGeneration, "Antigravity LS 尾部出现后必须发布新缓存代次");
        assert.ok(antigravityLocalStepReads > 0, "Antigravity 新 LS 水位必须触发轨迹重读");
        assert.equal(cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: antigravityLocalKey })?.snapshot.cacheAuthority, "ls");

        const windsurfLocalFirst = await bridge.loadConversationData("windsurf", windsurfLocalId, { source: "auto" });
        assert.equal(windsurfLocalFirst?.totalSteps, 1, "WSF 在 LS 缺席时应由本地 PB 构建缓存");
        const windsurfLocalKey = { source: "windsurf", conversationId: windsurfLocalId };
        assert.equal(cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: windsurfLocalKey })?.snapshot.cacheAuthority, "local", "WSF auto 缓存必须记录本地 PB authority");
        const windsurfLocalGeneration = windsurfLocalFirst?.cacheGeneration;
        windsurfLsVisible = true;
        __resetWindsurfConversationCacheForTest();
        const windsurfTail = await bridge.loadConversationData("windsurf", windsurfLocalId, { source: "auto" });
        assert.equal(windsurfTail?.totalSteps, 4, "WSF LS 出现新增尾部后 auto 必须重建并采用更完整来源");
        assert.notEqual(windsurfTail?.cacheGeneration, windsurfLocalGeneration, "WSF LS 尾部出现后必须发布新缓存代次");
        assert.ok(windsurfLocalStepReads > 0, "WSF 新 LS 水位必须触发轨迹重读");
        assert.equal(cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: windsurfLocalKey })?.snapshot.cacheAuthority, "ls");

        const windsurfEqual = await bridge.loadConversationData("windsurf", windsurfEqualId, { source: "auto" });
        assert.equal(windsurfEqual?.rounds.length, 1, "WSF PB/LS 正文相等时仍应识别为同一轮内容");
        assert.equal(windsurfEqual?.toolCallCount, 1, "WSF PB/LS 正文相等时 auto 应采用 LS 以保留语义工具调用");
        assert.equal(
            cache.readCachedConversationSourceCache<{ cacheAuthority?: string }>({ key: { source: "windsurf", conversationId: windsurfEqualId } })?.snapshot.cacheAuthority,
            "ls",
            "WSF PB/LS 正文相等时缓存 authority 应记录 LS",
        );
    } finally {
        __setLsRpcImplForTest(null);
        __resetLsTestOverridesForTest();
        __setConvCacheDirForTest(null);
        __resetWindsurfConversationCacheForTest();
        __resetWindsurfEndpointCacheForTest();
        for (const key of localPbEnvironmentKeys) {
            const value = originalLocalPbEnvironment.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(lsCacheRoot, { recursive: true, force: true });
        fs.rmSync(antigravityPbRoot, { recursive: true, force: true });
        fs.rmSync(windsurfPbRoot, { recursive: true, force: true });
    }

    console.log("✅ conversation-bridge-cache 通过：cache-only、代次正文恢复、宿主元数据保留、LS 拒绝与变体隔离、LS 水位新鲜度、WSF/Antigravity local authority 迁移与 auto 重建");
} finally {
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
