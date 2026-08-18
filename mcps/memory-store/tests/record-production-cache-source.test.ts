import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";

const cache = await import("../src/conversation-source-cache.ts");
const { createProductionSourceReader } = await import("../src/record-production-source-readers.ts");
const { createProductionRecordSchedulerSourceEvidenceAdapter } = await import("../src/record-scheduler-runtime.ts");
const { discoverRecordCandidates } = await import("../src/record-discovery.ts");
const { conversationLoadFromFrozenSource } = await import("../src/tools/record.ts");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-cache-source-"));
const conversationId = "44444444-4444-4444-8444-444444444444";
const key = { source: "codex:link=summary", conversationId };
const fingerprint = { path: path.join(dataRoot, "huge-source.jsonl"), size: 2_000_000_000, mtime: 1_786_000_000_000 };
const rounds: ConversationRound[] = [{
    roundIndex: 1,
    startStep: 1,
    endStep: 2,
    userMessage: "缓存里的第一轮用户消息",
    mediaAttachments: [],
    aiResponses: [{ stepIndex: 2, response: "缓存里的第一轮模型回复", thinking: "FULL-ONLY-THINKING-SENTINEL", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
}, {
    roundIndex: 2,
    startStep: 3,
    endStep: 5,
    userMessage: "缓存里的第二轮第一条用户消息\n\n缓存里的第二轮第二条用户消息",
    mediaAttachments: [],
    attachments: [{
        kind: "image",
        source: "codex-local-image",
        originalPath: "C:\\fixture\\missing-image.png",
        exists: false,
        warning: "source path unavailable",
    }],
    userMessages: [
        {
            stepIndex: 3,
            text: "缓存里的第二轮第一条用户消息",
            rawRole: "CORTEX_STEP_TYPE_USER_INPUT",
            semanticRole: "user",
        },
        {
            stepIndex: 4,
            text: "缓存里的第二轮第二条用户消息",
            rawRole: "CORTEX_STEP_TYPE_USER_INPUT",
            semanticRole: "user",
            attachments: [{
                kind: "image",
                source: "codex-local-image",
                originalPath: "C:\\fixture\\missing-image.png",
                exists: false,
                warning: "source path unavailable",
            }],
        },
    ],
    aiResponses: [{ stepIndex: 5, response: "缓存里的第二轮模型回复", thinking: "", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
}];

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);
    const published = await cache.readOrBuild({
        key,
        fingerprint,
        build: () => ({ snapshot: { conversationId, rounds: [] }, rounds }),
        getRoundNumber: round => round.roundIndex,
        projectRecordRound: projectConversationRoundForRecord,
    });
    const cacheGeneration = {
        key,
        generation: published.generation,
        fingerprint,
    };
    const projection = cache.readConversationSourceCacheRecordProjection({ key, generation: published.generation });
    assert.equal(projection?.roundCount, 2);
    assert.ok((projection?.bytes || Number.POSITIVE_INFINITY) < 2048, "Record 投影应远小于 full/diff 完整轮次文件");
    const cacheDirectory = cache.getConversationSourceCacheEntryDirectory(key);
    const cacheManifest = JSON.parse(fs.readFileSync(path.join(cacheDirectory, "manifest.json"), "utf8"));
    const projectionText = fs.readFileSync(path.join(cacheDirectory, cacheManifest.files.recordProjection.file), "utf8");
    assert.doesNotMatch(projectionText, /FULL-ONLY-THINKING-SENTINEL/u, "Record 投影不得复制 thinking/tool/full-diff 等仅供深度读取的内容");
    const secondKey = { source: "claude-code:logical=off", conversationId: "55555555-5555-4555-8555-555555555555" };
    const secondPublished = await cache.readOrBuild({
        key: secondKey,
        fingerprint: null,
        build: () => ({ snapshot: { conversationId: secondKey.conversationId }, rounds }),
        getRoundNumber: round => round.roundIndex,
    });
    await cache.pinConversationSourceCacheGeneration({ ...cacheGeneration, ownerId: "terminal-record-task" });
    await cache.pinConversationSourceCacheGeneration({
        key: secondKey,
        generation: secondPublished.generation,
        fingerprint: null,
        ownerId: "terminal-record-task",
    });
    assert.equal(await cache.releaseConversationSourceCacheGenerationPinsForOwner("terminal-record-task"), 2, "终态任务必须能按 owner 跨 cache key 释放全部 pin");
    assert.equal(await cache.releaseConversationSourceCacheGenerationPinsForOwner("terminal-record-task"), 0, "重复释放必须幂等");
    let scanSequence = 0;
    const reader = createProductionSourceReader({
        now: () => new Date("2026-08-03T14:00:00.000Z"),
        scanIdFactory: () => `verified-cache-scan-${++scanSequence}`,
    });
    const authorityRevision = {
        revision: "sha256:verified-origin-revision",
        contentCursor: "sha256:verified-origin-revision",
        eventWatermark: "sha256:verified-origin-revision",
        sequence: 123,
    };
    const result = await reader.scan({
        host: "codex",
        conversationId,
        workspace: { workspaceId: "workspace-cache", canonicalPath: "C:/workspace-cache" },
        paths: {
            stateDbPath: path.join(dataRoot, "must-not-open.sqlite"),
            sessionsRoots: [path.join(dataRoot, "must-not-open-sessions")],
        },
        cacheGeneration,
        cacheReadStartRound: 2,
        sourceSnapshot: { cacheState: "hit", totalSteps: 5, authorityRevision },
    });

    assert.equal(result.classification.state, "Present");
    assert.equal(result.enumeration.cacheBypassed, false, "Record 必须诚实标记来自 fetch 缓存");
    assert.equal(result.enumeration.identity.source.authority, "memory-store-fetch-cache");
    assert.equal(result.enumeration.sourceRevision.revision, authorityRevision.revision, "verified cache must retain the originating source revision for later freshness checks");
    assert.equal(result.enumeration.sourceRevision.sequence, authorityRevision.sequence);
    assert.equal(result.fullSourceRead.status, "complete");
    assert.equal(result.fullSourceRead.authority.cacheBypassed, false);
    assert.equal(result.cacheGeneration?.generation, published.generation);
    assert.deepEqual(result.cacheSourceSnapshot, {
        kind: "verified-conversation-fetch-cache",
        generation: published.generation,
        source: key.source,
        roundCount: 2,
        totalSteps: 5,
        materializedSource: "recordProjection",
        requestedReadStartRound: 2,
        materializedReadStartRound: 2,
        materializedReadEndRound: 2,
    });
    if (result.fullSourceRead.status !== "complete") assert.fail("verified cache should materialize a complete source");
    const document = JSON.parse(Buffer.from(result.fullSourceRead.payload.bytes).toString("utf8"));
    assert.deepEqual(document.messages.map((message: { content: string }) => message.content), [
        "缓存里的第二轮第一条用户消息",
        "缓存里的第二轮第二条用户消息",
        "缓存里的第二轮模型回复",
    ], "Record 增量生产来源只应物化请求起点之后的缓存轮次");
    assert.deepEqual(document.messages.map((message: { roundIndex?: number }) => message.roundIndex), [2, 2, 2], "同一人类轮的全部投影消息必须保留原轮号");
    assert.equal(document.messages[1]?.rawRole, "CORTEX_STEP_TYPE_USER_INPUT");
    assert.equal(document.messages[1]?.semanticRole, "user");
    const cachedAttachment = document.messages[1]?.attachments?.[0];
    assert.match(cachedAttachment?.reference || "", /^path-sha256:[0-9a-f]{64}$/u, "已校验 fetch 缓存中的历史附件允许保留脱敏稳定引用");
    assert.equal(cachedAttachment?.sha256, undefined, "没有内容哈希的历史附件不得伪造 SHA-256");
    assert.equal(cachedAttachment?.exists, false);
    const contentHash = result.fullSourceRead.payload.contentHash;
    const frozenLoad = conversationLoadFromFrozenSource({
        snapshot: {
            sourceSnapshotId: "frozen-cache-tail",
            chain: "codex",
            conversationId,
            contentHash,
            contentRef: { hash: contentHash },
        },
        document,
        cacheSourceSnapshot: result.cacheSourceSnapshot,
    } as never);
    assert.equal(frozenLoad.roundStart, 2);
    assert.equal(frozenLoad.roundCount, 2);
    assert.equal(frozenLoad.totalSteps, 5);
    assert.deepEqual(frozenLoad.rounds.map(round => round.roundIndex), [2], "冻结后的增量缓存不能把绝对第 2 轮重新编号成第 1 轮");
    assert.equal(frozenLoad.rounds.length, 1, "同一 ConversationRound 内连续 userMessages 冻结恢复后仍须是一轮");
    const recoveredRound = frozenLoad.rounds[0];
    assert.deepEqual(recoveredRound.userMessages?.map(message => message.text), [
        "缓存里的第二轮第一条用户消息",
        "缓存里的第二轮第二条用户消息",
    ]);
    const recoveredSecondUserMessage = recoveredRound.userMessages?.[1];
    assert.equal(recoveredSecondUserMessage?.rawRole, "CORTEX_STEP_TYPE_USER_INPUT");
    assert.equal(recoveredSecondUserMessage?.semanticRole, "user");
    assert.equal(recoveredSecondUserMessage?.attachments?.[0]?.reference, cachedAttachment?.reference);
    assert.equal(recoveredSecondUserMessage?.attachments?.[0]?.exists, false);
    const discontinuousDocument = JSON.parse(JSON.stringify(document));
    for (const message of discontinuousDocument.messages) message.roundIndex = 3;
    assert.throws(() => conversationLoadFromFrozenSource({
        snapshot: {
            sourceSnapshotId: "frozen-cache-tail-discontinuous",
            chain: "codex",
            conversationId,
            contentHash,
            contentRef: { hash: contentHash },
        },
        document: discontinuousDocument,
        cacheSourceSnapshot: result.cacheSourceSnapshot,
    } as never), /增量轮次窗口不连续/u, "冻结来源不能借助原轮号绕过增量轮次窗口连续性校验");

    const legacyConversationId = "66666666-6666-4666-8666-666666666666";
    const legacyKey = { source: "codex:link=summary", conversationId: legacyConversationId };
    const legacyPublished = await cache.readOrBuild({
        key: legacyKey,
        fingerprint: null,
        build: () => ({ snapshot: { conversationId: legacyConversationId }, rounds }),
        getRoundNumber: round => round.roundIndex,
    });
    let legacyRebuildCount = 0;
    const legacyReader = createProductionSourceReader({
        now: () => new Date("2026-08-03T14:00:00.000Z"),
        scanIdFactory: () => `legacy-cache-migration-${++scanSequence}`,
        rebuildLegacyCache: async () => {
            legacyRebuildCount += 1;
            const migrated = await cache.readOrBuild({
                key: legacyKey,
                fingerprint: null,
                refresh: true,
                build: () => ({ snapshot: { conversationId: legacyConversationId }, rounds }),
                getRoundNumber: round => round.roundIndex,
                projectRecordRound: projectConversationRoundForRecord,
            });
            return {
                cacheGeneration: {
                    key: legacyKey,
                    generation: migrated.generation,
                    fingerprint: null,
                },
                sourceSnapshot: { cacheState: "built", totalSteps: 5 },
            };
        },
    });
    const legacyResult = await legacyReader.scan({
        host: "codex",
        conversationId: legacyConversationId,
        workspace: { workspaceId: "workspace-cache", canonicalPath: "C:/workspace-cache" },
        cacheGeneration: {
            key: legacyKey,
            generation: legacyPublished.generation,
            fingerprint: null,
        },
    });
    assert.equal(legacyResult.fullSourceRead.status, "complete", "升级前没有 Record 投影的 fetch 缓存必须先迁移再读取");
    assert.equal(legacyRebuildCount, 1, "legacy generation 只能触发一次受控投影重建");
    assert.notEqual(legacyResult.cacheGeneration?.generation, legacyPublished.generation, "Record 不得继续逐轮解析旧 generation 的完整大轮次");
    assert.equal(legacyResult.cacheSourceSnapshot?.materializedSource, "recordProjection");

    await assert.rejects(() => reader.scan({
        host: "codex",
        conversationId,
        workspace: { workspaceId: "workspace-cache", canonicalPath: "C:/workspace-cache" },
        paths: {
            stateDbPath: path.join(dataRoot, "must-not-open.sqlite"),
            sessionsRoots: [path.join(dataRoot, "must-not-open-sessions")],
        },
        cacheGeneration,
        sourceSnapshot: { cacheState: "stale" },
    }), /stale fetch 缓存不可作为 Record 生产来源/u, "production reader 必须拒绝 stale fetch 缓存，而非洗白为 staleCache=false");

    const discoveryRequests: Array<{ cacheReadStartRound?: number }> = [];
    const discoveryAdapter = createProductionRecordSchedulerSourceEvidenceAdapter({
        listCodexThreads: () => [],
    }, {
        scan: async request => {
            discoveryRequests.push({ cacheReadStartRound: request.cacheReadStartRound });
            return reader.scan(request);
        },
    } as never, {
        now: () => new Date("2026-08-03T14:00:00.000Z"),
        scanIdFactory: () => `cache-discovery-${++scanSequence}`,
    });
    const discovery = await discoveryAdapter.buildDiscoveryInput({
        kind: "record-update",
        selector: "normal",
        workspaceHash: "workspace-cache",
        workspacePath: "C:/workspace-cache",
        hosts: ["codex"],
        targets: [{
            host: "codex",
            conversationId,
            workspaceHash: "workspace-cache",
            workspacePath: "C:/workspace-cache",
        }],
        sourceCacheReferences: [{
            host: "codex",
            conversationId,
            workspaceHash: "workspace-cache",
            cacheGeneration,
            cacheReadStartRound: 2,
            sourceSnapshot: { authorityRevision },
        }],
    });
    assert.equal(discoveryRequests[0]?.cacheReadStartRound, 2, "discovery must preserve the rollback-safe cache read boundary before materialization");
    assert.equal(discovery.input.sourceEnumerations.length, 1);
    assert.equal(discovery.input.sourceEnumerations[0].evidence.targetStatus, "present");
    assert.equal(discovery.input.sourceEnumerations[0].evidence.cacheBypassed, false);
    assert.equal(discovery.input.sourceEnumerations[0].evidence.sourceRevision.revision, authorityRevision.revision);
    const discoverySnapshot = discoverRecordCandidates(discovery.input);
    assert.equal(discoverySnapshot.candidates[0]?.classification, "Missing", "已完整校验的不可变 fetch 缓存必须能进入 Record 生产，不能被普通 cacheBypassed 门槛误判为 Unresolved");

    fs.writeFileSync(path.join(cacheDirectory, cacheManifest.files.recordProjection.file), "tampered\n", "utf8");
    await assert.rejects(() => reader.scan({
        host: "codex",
        conversationId,
        workspace: { workspaceId: "workspace-cache", canonicalPath: "C:/workspace-cache" },
        cacheGeneration,
    }), /Record 投影不存在、损坏或未完整校验/u, "新 generation 声明的投影损坏时必须失败，不能偷偷回退大 rounds 文件");

    await assert.rejects(() => reader.scan({
        host: "codex",
        conversationId,
        workspace: { workspaceId: "workspace-cache", canonicalPath: "C:/workspace-cache" },
        cacheGeneration: { ...cacheGeneration, generation: "missing-generation" },
    }), /generation 不存在、损坏或未完整校验/u);

    console.log("✅ verified fetch cache 可直接供 Record 使用，且不会回读宿主巨型源文件");
} finally {
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
