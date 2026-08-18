import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatRound } from "../src/trajectory.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cc-client-test-"));
const claudeHome = path.join(tempDir, ".claude");
const projectDir = path.join(claudeHome, "projects", "C--Users-Stardust-Desktop-CC-Fixture");
const appDataRoot = path.join(tempDir, "AppData", "Roaming");
const localAppDataRoot = path.join(tempDir, "AppData", "Local");
const desktopIndexRoot = path.join(appDataRoot, "Claude", "claude-code-sessions");
const packageDesktopIndexRoot = path.join(localAppDataRoot, "Packages", "Claude_fixture", "LocalCache", "Roaming", "Claude", "claude-code-sessions");
const accountId = "account-old-1111";
const organizationId = "org-team-2222";
const threadId = "11111111-2222-4333-8444-555555555555";
const aliasThreadId = "66666666-6666-4666-8666-666666666666";
const boundedThreadId = "77777777-7777-4777-8777-777777777777";
const cwd = "C:\\Users\\Stardust\\Desktop\\CC Fixture";
const jsonlPath = path.join(projectDir, `${threadId}.jsonl`);
const aliasJsonlPath = path.join(projectDir, `${aliasThreadId}.jsonl`);
const boundedJsonlPath = path.join(projectDir, `${boundedThreadId}.jsonl`);
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

process.env.MEMORY_STORE_CLAUDE_HOME = claudeHome;
delete process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS;
process.env.APPDATA = appDataRoot;
process.env.LOCALAPPDATA = localAppDataRoot;
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(path.join(desktopIndexRoot, accountId, organizationId), { recursive: true });
fs.mkdirSync(path.join(packageDesktopIndexRoot, accountId, organizationId), { recursive: true });
fs.writeFileSync(
    jsonlPath,
    [
        {
            type: "user",
            cwd,
            message: { role: "user", content: [{ type: "text", text: "请帮我测试 Claude Code 解析器" }] },
        },
        {
            type: "assistant",
            cwd,
            message: {
                role: "assistant",
                model: "claude-sonnet-4-5",
                content: [
                    { type: "thinking", thinking: "需要先跑 echo", signature: "SECRET_SIGNATURE_SHOULD_NOT_LEAK" },
                    { type: "thinking", thinking: "", signature: "EMPTY_THINKING_SIGNATURE_SHOULD_NOT_LEAK" },
                ],
            },
        },
        {
            type: "assistant",
            cwd,
            message: {
                role: "assistant",
                model: "claude-sonnet-4-5",
                content: [
                    { type: "text", text: "我准备执行命令" },
                    { type: "tool_use", id: "toolu_echo", name: "Bash", input: { command: "echo hi" } },
                ],
            },
        },
        {
            type: "user",
            cwd,
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_echo", content: "fallback result" }] },
            toolUseResult: { stdout: "hi\n", stderr: "" },
        },
        { type: "ai-title", cwd, aiTitle: "AI 标题" },
        { type: "custom-title", cwd, customTitle: "CC Fixture 标题" },
        { type: "last-prompt", cwd, lastPrompt: "最后一次 prompt" },
        {
            type: "system",
            subtype: "compact_boundary",
            uuid: "compact-boundary-1",
            content: "Conversation compacted",
            compactMetadata: {
                trigger: "auto",
                preTokens: 167046,
                postTokens: 4960,
                durationMs: 156216,
            },
            cwd,
            sessionId: threadId,
        },
        {
            type: "user",
            parentUuid: "compact-boundary-1",
            isCompactSummary: true,
            cwd,
            sessionId: threadId,
            message: {
                role: "user",
                content: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\ncompact-secret-should-not-search\n真实摘要正文",
            },
        },
        {
            type: "assistant",
            cwd,
            message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "压缩后继续工作" }] },
        },
        {
            type: "user",
            cwd,
            message: {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
                    { type: "text", text: "这是带图问题 unique-probe-abcdef" },
                ],
            },
        },
        {
            type: "assistant",
            cwd,
            message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "图片已收到" }] },
        },
        {
            type: "assistant",
            cwd,
            message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "future_content", payload: "preserve-type-evidence" }] },
        },
    ].map(line => JSON.stringify(line)).join("\n") + "\n",
    "utf-8",
);
fs.writeFileSync(
    path.join(desktopIndexRoot, accountId, organizationId, `local_${threadId}.json`),
    JSON.stringify({
        cliSessionId: threadId,
        title: "Desktop Index Title",
        cwd,
        lastActivityAt: "2026-06-10T01:02:03.000Z",
        isArchived: true,
    }),
    "utf-8",
);
fs.writeFileSync(
    aliasJsonlPath,
    [
        { type: "custom-title", cwd, customTitle: "旧 UI 标题" },
        { type: "ai-title", cwd, aiTitle: "AI Alias 标题" },
        { type: "custom-title", cwd, customTitle: "新 UI 标题" },
        { type: "last-prompt", cwd, lastPrompt: "最后 alias prompt" },
        {
            type: "user",
            cwd,
            message: { role: "user", content: [{ type: "text", text: "这个首轮文本也应该作为标题别名参与检索" }] },
        },
    ].map(line => JSON.stringify(line)).join("\n") + "\n",
    "utf-8",
);
fs.writeFileSync(
    path.join(packageDesktopIndexRoot, accountId, organizationId, `local_${aliasThreadId}.json`),
    JSON.stringify({
        cliSessionId: aliasThreadId,
        title: "Windows Store Desktop Title",
        cwd,
        lastActivityAt: "2026-06-11T01:02:03.000Z",
    }),
    "utf-8",
);
fs.writeFileSync(
    boundedJsonlPath,
    [
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: "bounded head title" } }),
        `${JSON.stringify({ type: "progress", payload: "x".repeat(1024) })}\n`.repeat(5_000).trimEnd(),
        JSON.stringify({ type: "custom-title", cwd, customTitle: "bounded tail title" }),
    ].join("\n") + "\n",
    "utf-8",
);

const {
    deepLocateClaudeCodeConversations,
    findClaudeCodeContextProbeMatches,
    listRecentClaudeCodeThreads,
    loadClaudeCodeConversation,
    loadClaudeCodeConversationAsync,
    matchClaudeCodeContextProbeInJsonl,
    resolveClaudeCodeThreadId,
} = await import("../src/claude-code-client.ts");

try {
    const originalReadSync = fs.readSync;
    let listReadBytes = 0;
    (fs as any).readSync = (...args: any[]) => {
        const bytesRead = (originalReadSync as any)(...args);
        listReadBytes += bytesRead;
        return bytesRead;
    };
    let threads;
    try {
        threads = listRecentClaudeCodeThreads(10);
    } finally {
        (fs as any).readSync = originalReadSync;
    }
    assert.ok(listReadBytes < 1024 * 1024, `Claude Code list metadata reads must stay bounded, observed ${listReadBytes} bytes`);
    const boundedThread = threads.find(item => item.id === boundedThreadId);
    assert.ok(boundedThread);
    assert.equal(boundedThread.title, "bounded tail title");
    assert.equal(boundedThread.cwd, cwd);
    const thread = threads.find(item => item.id === threadId);
    assert.ok(thread);
    assert.equal(thread.title, "CC Fixture 标题");
    assert.equal(thread.cwd, cwd);
    assert.equal(thread.accountId, accountId);
    assert.equal(thread.organizationId, organizationId);
    assert.equal(thread.isArchived, true);
    assert.ok(thread.desktopIndexPath?.endsWith(`local_${threadId}.json`));
    assert.equal(thread.updatedAtMs, Date.parse("2026-06-10T01:02:03.000Z"));
    assert.equal(resolveClaudeCodeThreadId(threadId.slice(0, 8)), threadId);
    const aliasThread = threads.find(item => item.id === aliasThreadId);
    assert.ok(aliasThread);
    assert.equal(aliasThread.title, "新 UI 标题");
    assert.ok(aliasThread.desktopIndexRoot?.includes(`${path.sep}Packages${path.sep}Claude_fixture${path.sep}`));
    assert.equal(aliasThread.updatedAtMs, Date.parse("2026-06-11T01:02:03.000Z"));
    assert.deepEqual(
        ["旧 UI 标题", "AI Alias 标题", "新 UI 标题", "最后 alias prompt", "Windows Store Desktop Title"].every(alias => aliasThread.titleAliases?.includes(alias)),
        true,
        "Claude Code titleAliases should preserve overwritten JSONL titles and Windows Store desktop title",
    );
    assert.equal(resolveClaudeCodeThreadId("旧 UI 标题"), aliasThreadId);
    assert.equal(resolveClaudeCodeThreadId("Windows Store Desktop Title"), aliasThreadId);

    const loaded = loadClaudeCodeConversation(threadId);
    assert.ok(loaded);
    assert.equal(loaded.rounds.length, 3);
    assert.equal(loaded.totalSteps, 13);
    assert.equal(loaded.rounds[0].toolCalls.length, 1);
    assert.equal(loaded.rounds[0].toolCalls[0].name, "Bash");
    assert.match(loaded.rounds[0].toolCalls[0].resultSummary || "", /hi/u);
    assert.equal(loaded.rounds[2].attachments?.[0]?.source, "claude-code-data-url");
    assert.ok(
        loaded.rounds[2].aiResponses.some(response => response.response === "[Claude Code unknown content block type=\"future_content\"]"),
        "unknown Claude content blocks must keep deterministic type evidence instead of becoming empty responses",
    );

    const originalSetImmediate = globalThis.setImmediate;
    let asyncYieldCalls = 0;
    globalThis.setImmediate = ((callback: (...args: any[]) => void, ...args: any[]) => {
        asyncYieldCalls += 1;
        return originalSetImmediate(callback, ...args);
    }) as typeof setImmediate;
    try {
        const loadedAsync = await loadClaudeCodeConversationAsync(threadId);
        assert.deepEqual(loadedAsync, loaded);
    } finally {
        globalThis.setImmediate = originalSetImmediate;
    }
    assert.ok(asyncYieldCalls > 0, "async Claude Code loading should yield to the event loop");

    const crlfThreadId = "77777777-7777-4777-8777-777777777777";
    fs.writeFileSync(
        path.join(projectDir, `${crlfThreadId}.jsonl`),
        [
            {
                type: "user",
                cwd,
                message: { role: "user", content: [{ type: "text", text: "CRLF fixture user message" }] },
            },
            {
                type: "assistant",
                cwd,
                message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "CRLF fixture response" }] },
            },
        ].map(line => JSON.stringify(line)).join("\r\n"),
        "utf-8",
    );
    const crlfSync = loadClaudeCodeConversation(crlfThreadId);
    const crlfAsync = await loadClaudeCodeConversationAsync(crlfThreadId);
    assert.deepEqual(crlfAsync, crlfSync, "async JSONL loading should preserve CRLF and EOF-without-newline handling");

    const fullRound = formatRound(loaded.rounds[0], "full", ["thinking", "tool_results"]);
    assert.match(fullRound, /需要先跑 echo/u);
    assert.match(fullRound, /🔒 加密思考块 step 2：thinking 为空，signature 存在，明文不可读/u);
    assert.doesNotMatch(fullRound, /SECRET_SIGNATURE_SHOULD_NOT_LEAK/u);
    assert.doesNotMatch(fullRound, /EMPTY_THINKING_SIGNATURE_SHOULD_NOT_LEAK/u);
    assert.match(fullRound, /Bash/u);
    assert.match(fullRound, /hi/u);

    const compactRound = formatRound(loaded.rounds[1], "normal");
    assert.match(compactRound, /Claude Code 压缩续聊摘要已折叠/u);
    assert.match(compactRound, /完整压缩摘要临时文件/u);
    assert.doesNotMatch(compactRound, /compact-secret-should-not-search/u);
    const compactPath = compactRound.match(/完整压缩摘要临时文件: (.+)/u)?.[1]?.trim();
    assert.ok(compactPath && fs.existsSync(compactPath));
    const compactRoundAgain = formatRound(loaded.rounds[1], "normal");
    assert.match(compactRoundAgain, new RegExp(compactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    const compactFull = formatRound(loaded.rounds[1], "full");
    assert.match(compactFull, /compact-secret-should-not-search/u);
    assert.match(compactFull, /<<<CLAUDE_CODE_COMPACT_SUMMARY>>>/u);

    const directHits = matchClaudeCodeContextProbeInJsonl(jsonlPath, "这是带图问题 unique-probe-abcdef");
    assert.equal(directHits.length, 1);
    assert.equal(directHits[0].roundIndex, 3);
    assert.equal(directHits[0].role, "user");

    const compactHits = matchClaudeCodeContextProbeInJsonl(jsonlPath, "compact-secret-should-not-search");
    assert.equal(compactHits.length, 0);
    const encryptedThinkingHits = matchClaudeCodeContextProbeInJsonl(jsonlPath, "加密思考块");
    assert.equal(encryptedThinkingHits.length, 0);
    const encryptedSignatureHits = matchClaudeCodeContextProbeInJsonl(jsonlPath, "EMPTY_THINKING_SIGNATURE_SHOULD_NOT_LEAK");
    assert.equal(encryptedSignatureHits.length, 0);

    const threadMatches = findClaudeCodeContextProbeMatches(threads, "这是带图问题 unique-probe-abcdef");
    assert.equal(threadMatches.length, 1);
    assert.equal(threadMatches[0].thread.id, threadId);

    const located = deepLocateClaudeCodeConversations("unique-probe-abcdef", threads, { maxFiles: 5, maxBytes: 1024 * 1024 });
    assert.equal(located.status, "found");
    assert.equal(located.hits[0].conversationId, threadId);
    assert.equal(located.hits[0].roundIndex, 3);

    const compactLocated = deepLocateClaudeCodeConversations("compact-secret-should-not-search", threads, { maxFiles: 5, maxBytes: 1024 * 1024 });
    assert.equal(compactLocated.status, "no_hit_after_full_scan");
    const encryptedLocated = deepLocateClaudeCodeConversations("EMPTY_THINKING_SIGNATURE_SHOULD_NOT_LEAK", threads, { maxFiles: 5, maxBytes: 1024 * 1024 });
    assert.equal(encryptedLocated.status, "no_hit_after_full_scan");

    const predecessorId = "22222222-2222-4222-8222-222222222222";
    const continuationId = "33333333-3333-4333-8333-333333333333";
    const cleanStartId = "44444444-4444-4444-8444-444444444444";
    fs.writeFileSync(
        path.join(projectDir, `${predecessorId}.jsonl`),
        [
            {
                type: "custom-title",
                cwd,
                customTitle: "NLP大作业",
            },
            {
                type: "user",
                cwd,
                message: { role: "user", content: [{ type: "text", text: "开始做 NLP 大作业，先实现分词与标签流程" }] },
            },
            {
                type: "assistant",
                cwd,
                message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "已完成分词 baseline，尾部因为环境卡住准备换新对话继续" }] },
            },
        ].map(line => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
    );
    fs.writeFileSync(
        path.join(projectDir, `${continuationId}.jsonl`),
        [
            {
                type: "custom-title",
                cwd,
                customTitle: "继续NLP大作业",
            },
            {
                type: "user",
                cwd,
                message: { role: "user", content: [{ type: "text", text: `继续 ${predecessorId} 的 NLP 大作业，接着做标签评估` }] },
            },
            {
                type: "assistant",
                cwd,
                message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "继续完成标签评估" }] },
            },
        ].map(line => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
    );
    fs.writeFileSync(
        path.join(projectDir, `${cleanStartId}.jsonl`),
        [
            {
                type: "custom-title",
                cwd,
                customTitle: "NLP大作业",
            },
            {
                type: "user",
                cwd,
                message: { role: "user", content: [{ type: "text", text: `提到旧对话 ${predecessorId}，但这次清理污染，从 0 开始，不要继承旧上下文` }] },
            },
        ].map(line => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
    );

    const explain = loadClaudeCodeConversation(continuationId, { logicalChain: "explain" });
    assert.ok(explain?.logicalChain);
    assert.equal(explain.logicalChain.merged, false);
    assert.ok(explain.logicalChain.segments.some(segment => segment.thread.id === predecessorId && segment.score >= 85));

    const merged = loadClaudeCodeConversation(continuationId, { logicalChain: "auto" });
    assert.ok(merged?.logicalChain?.merged, "explicit predecessor reference should be merged in auto mode");
    assert.equal(merged.rounds.length, 2);
    assert.match(merged.rounds[0].userMessage, /开始做 NLP 大作业/u);
    assert.match(merged.rounds[1].userMessage, /继续/u);

    const mergedAsync = await loadClaudeCodeConversationAsync(continuationId, { logicalChain: "auto" });
    assert.deepEqual(mergedAsync, merged);

    const cleanStart = loadClaudeCodeConversation(cleanStartId, { logicalChain: "auto" });
    assert.equal(cleanStart?.logicalChain?.merged, false, "negative clean-start intent must block logical merge");
    assert.ok(cleanStart?.logicalChain?.segments.some(segment => segment.thread.id === predecessorId && segment.negativeEvidence.length > 0));

    const subagentParentId = "55555555-5555-4555-8555-555555555555";
    const subagentId = "agent-cc-child-0001";
    const subagentDir = path.join(projectDir, subagentParentId, "subagents");
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
        path.join(subagentDir, `${subagentId}.jsonl`),
        [
            {
                type: "custom-title",
                cwd,
                customTitle: "CC 子代理 fixture",
            },
            {
                type: "user",
                cwd,
                message: { role: "user", content: [{ type: "text", text: "子代理检查 parentConversationId" }] },
            },
            {
                type: "assistant",
                cwd,
                message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "已完成子代理检查" }] },
            },
        ].map(line => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
    );

    const refreshedThreads = listRecentClaudeCodeThreads(20);
    const subagentThread = refreshedThreads.find(item => item.id === subagentId);
    assert.ok(subagentThread, "Claude Code subagent JSONL should be discovered recursively");
    assert.equal(subagentThread.isChildThread, true);
    assert.equal(subagentThread.parentConversationId, subagentParentId);
    assert.equal(subagentThread.agentRole, "claude-code-subagent");
    assert.equal(subagentThread.agentNickname, subagentId);

    const loadedSubagent = loadClaudeCodeConversation(subagentId);
    assert.ok(loadedSubagent);
    assert.equal(loadedSubagent.thread.isChildThread, true);
    assert.equal(loadedSubagent.thread.parentConversationId, subagentParentId);
    assert.equal(loadedSubagent.rounds.length, 1);
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
