import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearMappings } from "../src/conversation-router.ts";
import { listLocalPbConversationCandidates } from "../src/conversation-local-list.ts";
import {
    ANTIGRAVITY_RECALL_FALLBACK_CHARS,
    buildConversationCompactionMetadata,
    formatConversationRecallRound,
    selectConversationRecallRange,
    writeConversationRecallArtifact,
} from "../src/conversation-recall.ts";
import {
    resetConversationSourceCacheForTests,
    setConversationSourceCacheDataRootForTests,
} from "../src/conversation-source-cache.ts";
import { iterateConversationRecallRounds, registerConversation } from "../src/tools/conversation.ts";
import type { ConversationRound } from "../src/trajectory.ts";
import {
    __resetWindsurfEndpointCacheForTest,
    __resetWindsurfConversationCacheForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";

process.env.MEMORY_STORE_AUTO_RECORD = "0";

function round(index: number, options: {
    user?: string;
    response?: string;
    tokenCount?: number;
    foldedRules?: boolean;
    compactSummary?: boolean;
} = {}): ConversationRound {
    const user = options.foldedRules
        ? `[Codex AGENTS/RULES 注入已折叠 reason=resume]\n${options.user || "用户正文"}`
        : (options.user || `用户 ${index}`);
    return {
        roundIndex: index,
        startStep: index * 10,
        endStep: index * 10 + 4,
        userMessage: user,
        mediaAttachments: [],
        attachments: [],
        userMessages: [{
            stepIndex: index * 10,
            text: user,
            annotations: index === 1 ? [{ selectedText: "选中文本", comment: "" }] : undefined,
            attachments: index === 1 ? [{ kind: "file", source: "codex-local-path", originalPath: "C:/safe/reference.txt" }] : undefined,
        }],
        aiResponses: [{
            stepIndex: index * 10 + 1,
            response: options.response || `模型 ${index}`,
            thinking: "HIDDEN_THINKING",
            toolCalls: [{ name: "hidden_tool", args: "HIDDEN_TOOL_ARGS" }],
        }],
        toolCalls: [{
            stepIndex: index * 10 + 2,
            name: "hidden_tool",
            argsSummary: "HIDDEN_ARGS_SUMMARY",
            resultSummary: "HIDDEN_RESULT_SUMMARY",
            argsFull: "HIDDEN_ARGS_FULL",
            resultFull: "HIDDEN_RESULT_FULL",
        }],
        taskBoundaries: [],
        codeActions: [{
            stepIndex: index * 10 + 3,
            description: "HIDDEN_CODE_ACTION",
            targetFile: "secret.ts",
            instruction: "HIDDEN_DIFF",
            diffs: [],
        }],
        subagentSummaries: [{ threadId: "subagent-secret", nickname: "Hidden", summary: "HIDDEN_SUBAGENT" }],
        semanticEvents: options.tokenCount === undefined ? undefined : [{
            stepIndex: index * 10 + 4,
            rawRole: "local_pb.field_25",
            semanticRole: "system",
            kind: "context_tokens",
            contextTokens: options.tokenCount,
        }],
        compactionSummaries: options.compactSummary ? [{
            provider: "claude-code",
            kind: "compact_summary",
            text: "HIDDEN_COMPACT_SUMMARY",
            summaryChars: 22,
            summarySha256: "0".repeat(64),
            trigger: "isCompactSummary",
        }] : undefined,
    };
}

{
    const source = round(1);
    source.userMessages![0].text = "# Response annotations:\nRAW_ANNOTATION_ENVELOPE\n## My request for Codex:\n真正请求";
    const text = formatConversationRecallRound(source);
    assert.match(text, /真正请求/u);
    assert.match(text, /选中文本/u);
    assert.match(text, /评论为空/u);
    assert.match(text, /C:\/safe\/reference\.txt/u);
    assert.match(text, /模型 1/u);
    assert.doesNotMatch(text, /RAW_ANNOTATION_ENVELOPE|HIDDEN_/u);
}

{
    const metadata = buildConversationCompactionMetadata("windsurf", [
        round(1, { tokenCount: 100_000 }),
        round(2, { tokenCount: 38_000 }),
        round(3, { tokenCount: 42_000 }),
    ]);
    assert.equal(metadata.latestObservedTokens, 42_000);
    assert.equal(metadata.events.length, 1);
    assert.deepEqual(
        { kind: metadata.events[0].kind, preTokens: metadata.events[0].preTokens, postTokens: metadata.events[0].postTokens },
        { kind: "windsurf_token_drop", preTokens: 100_000, postTokens: 38_000 },
    );
}

{
    const metadata = buildConversationCompactionMetadata("codex", [
        round(1, { foldedRules: true }),
        round(2),
        round(3, { foldedRules: true }),
        round(4),
    ]);
    assert.equal(metadata.events.length, 1, "only the second and later folded AGENTS injection marks Codex compaction");
    assert.equal(metadata.events[0].roundIndex, 3);
    assert.equal(metadata.events[0].kind, "codex_agents_reinjection");
}

{
    const metadata = buildConversationCompactionMetadata("claude-code", [round(1), round(2, { compactSummary: true }), round(3)]);
    assert.equal(metadata.events[0].kind, "claude_code_compact_summary");
    assert.equal(formatConversationRecallRound(round(2, { compactSummary: true })).includes("HIDDEN_COMPACT_SUMMARY"), false);
}

{
    const metadata = buildConversationCompactionMetadata("antigravity", Array.from({ length: 8 }, (_, index) => round(index + 1, {
        user: "甲".repeat(80_000),
        response: "乙".repeat(10_000),
    })));
    const automatic = selectConversationRecallRange(metadata, "auto");
    assert.ok(automatic);
    assert.equal(automatic.endRound, 8);
    assert.ok(automatic.selectedContextChars >= ANTIGRAVITY_RECALL_FALLBACK_CHARS);
    const manual = selectConversationRecallRange(metadata, "manual", 3, 5);
    assert.deepEqual([manual?.startRound, manual?.endRound], [3, 5]);
    const full = selectConversationRecallRange(metadata, "full");
    assert.deepEqual([full?.startRound, full?.endRound], [1, 8]);
    assert.throws(() => selectConversationRecallRange(metadata, "manual", 0, 2), /manual recall round range/u);
}

{
    const selection = { startRound: 1, endRound: 2, targetContextChars: 1, selectedContextChars: 1, reason: "test" };
    const artifact = await writeConversationRecallArtifact({
        conversationId: "recall-artifact-test",
        dataChain: "codex",
        cacheGeneration: "generation-test",
        selection,
        rounds: [round(1), round(2)],
    });
    try {
        const text = fs.readFileSync(artifact.path, "utf8");
        assert.match(text, /cacheGeneration: generation-test/u);
        assert.match(text, /用户 1/u);
        assert.match(text, /模型 2/u);
        assert.doesNotMatch(text, /HIDDEN_/u);
        assert.equal(artifact.rounds, 2);
        assert.equal(artifact.bytes, Buffer.byteLength(text, "utf8"));
    } finally {
        fs.rmSync(artifact.path, { force: true });
    }
}

{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-recall-list-"));
    const activeRoot = path.join(root, "active");
    const implicitRoot = path.join(root, "implicit");
    fs.mkdirSync(activeRoot);
    fs.mkdirSync(implicitRoot);
    const previousActive = process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT;
    const previousImplicit = process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT;
    try {
        process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = activeRoot;
        process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = implicitRoot;
        fs.writeFileSync(path.join(activeRoot, "shared-id.pb"), Buffer.alloc(7));
        fs.writeFileSync(path.join(implicitRoot, "shared-id.pb"), Buffer.alloc(11));
        fs.writeFileSync(path.join(implicitRoot, "implicit-only.pb"), Buffer.alloc(13));
        fs.writeFileSync(path.join(activeRoot, "ignored.txt"), Buffer.alloc(100));
        const candidates = listLocalPbConversationCandidates("windsurf", { limit: 10 });
        const shared = candidates.find(item => item.id === "shared-id");
        assert.deepEqual(shared?.kinds, ["active", "implicit"]);
        assert.equal(shared?.bytes, 18);
        assert.equal(shared?.files, 2);
        assert.ok(candidates.some(item => item.id === "implicit-only"));
        assert.equal(candidates.some(item => item.id === "ignored"), false);
    } finally {
        if (previousActive === undefined) delete process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT;
        else process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = previousActive;
        if (previousImplicit === undefined) delete process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT;
        else process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = previousImplicit;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

{
    assert.throws(
        () => [...iterateConversationRecallRounds({
            cacheKey: { source: "codex", conversationId: "corrupt-recall-cache" },
            cacheGeneration: "missing-generation",
            rounds: [],
        } as never, 1, 1)],
        /missing or corrupt/u,
        "a missing generation body must fail closed instead of producing header-only recall output",
    );
}

{
    type Handler = (args?: Record<string, unknown>) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
    let handler: Handler | undefined;
    registerConversation({
        tool(name: string, _description: string, _schema: unknown, registeredHandler: Handler) {
            if (name === "conversation_read_original") handler = registeredHandler;
        },
    } as never);
    assert.ok(handler);
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-recall-handler-"));
    const conversationId = "recall-handler-wsf";
    let sourceReads = 0;
    let sourceUnavailable = false;
    try {
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(cacheRoot);
        clearMappings();
        __resetWindsurfEndpointCacheForTest();
        __setWindsurfEndpointResolverForTest(async () => [{ pid: 1, port: 9999, csrfToken: "csrf", executablePath: "C:/wsf.exe" }]);
        __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => async (method: string, payload?: Record<string, unknown>) => {
            if (method === "Heartbeat") return {};
            if (sourceUnavailable) throw new Error("simulated WSF source outage");
            if (method === "GetAllCascadeTrajectories") {
                return { trajectorySummaries: { [conversationId]: { cascadeId: conversationId, stepCount: 4, lastModifiedTime: "2026-08-04T00:00:00Z" } } };
            }
            if (method === "GetCascadeTrajectorySteps") {
                sourceReads += 1;
                if (String(payload?.cascadeId || "") !== conversationId || Number(payload?.stepOffset || 0) > 0) return { steps: [] };
                return { steps: [
                    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第一轮用户" } },
                    { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", text: "第一轮模型" },
                    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第二轮用户" } },
                    { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", text: "第二轮模型" },
                ] };
            }
            return {};
        });
        const result = await handler!({
            action: "recall",
            dataChain: "windsurf",
            conversationId,
            recallMode: "manual",
            startRound: 1,
            endRound: 2,
            sourceFailureMode: "fail",
        });
        const text = result.content?.find(item => item.type === "text")?.text || "";
        assert.ok(sourceReads >= 1, "recall must refresh the source before reading the committed fetch generation");
        assert.match(text, /cacheGeneration/u);
        assert.match(text, /第一轮用户/u);
        assert.match(text, /第二轮模型/u);
        assert.doesNotMatch(text, /thinking|toolCalls|codeActions/u);

        sourceUnavailable = true;
        __resetWindsurfConversationCacheForTest();
        const warningResult = await handler!({
            action: "recall",
            dataChain: "windsurf",
            conversationId,
            recallMode: "manual",
            startRound: 1,
            endRound: 1,
            sourceFailureMode: "warn",
        });
        const warningText = warningResult.content?.find(item => item.type === "text")?.text || "";
        assert.match(warningText, /刷新失败/u, "warn mode must disclose that it returned the previous complete fetch generation");
        assert.match(warningText, /第一轮用户/u);

        __resetWindsurfConversationCacheForTest();
        const failResult = await handler!({
            action: "recall",
            dataChain: "windsurf",
            conversationId,
            recallMode: "manual",
            startRound: 1,
            endRound: 1,
            sourceFailureMode: "fail",
        });
        const failText = failResult.content?.find(item => item.type === "text")?.text || "";
        assert.doesNotMatch(failText, /第一轮用户/u, "fail mode must reject stale cache content after a refresh failure");
        assert.match(failText, /刷新失败|stale|simulated WSF source outage/iu);
    } finally {
        __setWindsurfEndpointResolverForTest(null);
        __setWindsurfTransportFactoryForTest(null);
        __resetWindsurfEndpointCacheForTest();
        clearMappings();
        resetConversationSourceCacheForTests();
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
}

console.log("✅ conversation-recall 通过：离线枚举、四宿主压缩元数据、上下文投影、三种范围与 artifact 均符合预期");
