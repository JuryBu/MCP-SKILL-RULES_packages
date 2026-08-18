import assert from "node:assert/strict";
import {
    listConversationCandidates,
    resolveConversationIdAcrossSources,
    workspaceMatches,
    type ConversationSourceAdapters,
} from "../src/conversation-filter.js";

const adapters: ConversationSourceAdapters = {
    codex: {
        list: () => [
            { id: "codex-1", title: "Teacher App", cwd: "C:\\Users\\Stardust\\Desktop\\插件\\computer-use-plugin", updatedAtMs: 1000 },
            { id: "codex-2", title: "Other", cwd: "C:\\Users\\Stardust\\Desktop\\其它", updatedAtMs: 2000 },
        ] as any,
        get: (id: string) => id === "codex-1"
            ? ({ id: "codex-1", title: "Teacher App", cwd: "C:\\Users\\Stardust\\Desktop\\插件\\computer-use-plugin" } as any)
            : null,
    },
    "claude-code": {
        list: () => [
            { id: "cc-1", title: "Teacher App CC", cwd: "C:/Users/Stardust/Desktop/插件/computer-use-plugin", updatedAtMs: 3000 },
        ] as any,
        get: (id: string) => id === "shared-id"
            ? ({ id: "shared-id", title: "Shared CC", cwd: "C:/cc" } as any)
            : null,
    },
    antigravity: {
        list: () => {
            throw new Error("antigravity LS offline");
        },
    },
    windsurf: {
        list: () => {
            throw new Error("windsurf LS offline");
        },
        resolve: (id: string) => id === "wsf-id" ? "wsf-id" : null,
    },
};

assert.equal(
    workspaceMatches("\\\\?\\C:\\Users\\Stardust\\Desktop\\插件\\computer-use-plugin", ["C:/Users/Stardust/Desktop/插件"], "any"),
    true,
    "workspaceMatches should normalize Windows long-path prefix and slashes",
);
assert.equal(
    workspaceMatches("C:/Users/Stardust/Desktop/插件/computer-use-plugin", ["C:/Users/Stardust/Desktop/插件"], "under"),
    true,
    "workspaceMode=under should match child workspace paths",
);
assert.equal(
    workspaceMatches("C:/Users/Stardust/Desktop/插件/computer-use-plugin", ["C:/Users/Stardust/Desktop/插件"], "exact"),
    false,
    "workspaceMode=exact should not match parent-only filters",
);
assert.equal(
    workspaceMatches(
        ["C:/Users/Stardust/Desktop/其它", "C:/Users/Stardust/Desktop/群项目"],
        ["C:/Users/Stardust/Desktop/群项目"],
        "exact",
    ),
    true,
    "workspaceMatches should support multi-workspace candidates",
);

const listResult = await listConversationCandidates({
    dataChains: ["codex", "claude-code", "windsurf"],
    query: "teacher",
    workspaces: ["C:\\Users\\Stardust\\Desktop\\插件"],
    limit: 10,
    sourceFailureMode: "warn",
    adapters,
});

assert.deepEqual(
    listResult.candidates.map(item => `${item.dataChain}:${item.id}`),
    ["claude-code:cc-1", "codex:codex-1"],
    "multi-source list should merge available sources and filter by workspace",
);
assert.equal(listResult.statuses.find(item => item.dataChain === "windsurf")?.status, "failed");

const strictListResult = await listConversationCandidates({
    dataChains: ["codex", "windsurf"],
    sourceFailureMode: "fail",
    adapters,
});
assert.equal(
    strictListResult.statuses.find(item => item.dataChain === "windsurf")?.status,
    "failed",
    "sourceFailureMode=fail should preserve unavailable source diagnostics for caller-level strict failure",
);

const windsurfMetadataResult = await listConversationCandidates({
    dataChains: ["windsurf"],
    query: "步步开发对话6",
    workspaces: ["C:/Users/Stardust/Desktop/群项目"],
    workspaceMode: "exact",
    limit: 5,
    adapters: {
        ...adapters,
        windsurf: {
            list: () => [
                {
                    id: "wsf-6",
                    title: "步步开发对话6",
                    summary: "Feixiang Courseware Debugging",
                    renamedTitle: "步步开发对话6",
                    titleSource: "renamedTitle",
                    cwd: "C:/Users/Stardust/Desktop/其它",
                    workspaceUris: [
                        "C:/Users/Stardust/Desktop/其它",
                        "C:/Users/Stardust/Desktop/群项目",
                    ],
                    referencedFiles: ["C:/Users/Stardust/Desktop/群项目/Task.md"],
                    stepCount: 719,
                    lastModifiedTime: "2026-06-10T01:00:00Z",
                },
            ] as any,
            resolve: (id: string) => id === "wsf-6" ? "wsf-6" : null,
        },
    },
});

assert.deepEqual(
    windsurfMetadataResult.candidates.map(item => `${item.dataChain}:${item.id}:${item.title}`),
    ["windsurf:wsf-6:步步开发对话6"],
    "windsurf renamedTitle and secondary workspace metadata should participate in list filtering",
);
assert.match(windsurfMetadataResult.candidates[0].detail, /title=renamedTitle/u);
assert.match(windsurfMetadataResult.candidates[0].detail, /workspaces=2/u);

const multiTermMetadataResult = await listConversationCandidates({
    dataChains: ["codex", "claude-code"],
    query: "不会命中 teacher",
    workspaces: ["C:\\Users\\Stardust\\Desktop\\插件"],
    limit: 10,
    adapters,
});

assert.deepEqual(
    multiTermMetadataResult.candidates.map(item => `${item.dataChain}:${item.id}`),
    ["claude-code:cc-1", "codex:codex-1"],
    "metadata list query should treat whitespace-separated terms as OR instead of requiring the full phrase",
);

const claudeCodeAliasResult = await listConversationCandidates({
    dataChains: ["claude-code"],
    query: "隐藏旧标题",
    limit: 5,
    adapters: {
        ...adapters,
        "claude-code": {
            list: () => [
                {
                    id: "cc-title-alias",
                    title: "当前显示标题",
                    titleAliases: ["隐藏旧标题", "Desktop 侧标题"],
                    cwd: "C:/Users/Stardust/Desktop/插件/old",
                    updatedAtMs: 200,
                },
            ] as any,
            get: () => null,
        },
    },
});

assert.deepEqual(
    claudeCodeAliasResult.candidates.map(item => `${item.id}:${item.title}`),
    ["cc-title-alias:当前显示标题"],
    "Claude Code titleAliases should participate in multi-source metadata query without replacing display title",
);

const oldConversationMetadataLimit = process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT;
process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT = "1234";
let claudeCodeWorkspaceLocateLimit = 0;
const claudeCodeWorkspaceResult = await listConversationCandidates({
    dataChains: ["claude-code"],
    workspaces: ["C:/Users/Stardust/Desktop/插件"],
    workspaceMode: "under",
    limit: 5,
    adapters: {
        ...adapters,
        "claude-code": {
            list: (limit: number) => {
                claudeCodeWorkspaceLocateLimit = limit;
                return [
                    { id: "cc-old-workspace", title: "Old CC Workspace", cwd: "C:/Users/Stardust/Desktop/插件/old", updatedAtMs: 100 },
                ] as any;
            },
            get: () => null,
        },
    },
});
if (oldConversationMetadataLimit === undefined) {
    delete process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT;
} else {
    process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT = oldConversationMetadataLimit;
}
assert.ok(
    claudeCodeWorkspaceLocateLimit >= 1234,
    "Claude Code workspace filtering should use the broad metadata locate window instead of only recent candidates",
);
assert.deepEqual(
    claudeCodeWorkspaceResult.candidates.map(item => item.id),
    ["cc-old-workspace"],
    "Claude Code workspace filtering should keep matches found in the expanded metadata candidate window",
);

const windsurfPrimaryScopeResult = await listConversationCandidates({
    dataChains: ["windsurf"],
    query: "步步开发对话6",
    workspaces: ["C:/Users/Stardust/Desktop/群项目"],
    workspaceMode: "exact",
    workspaceScope: "primary",
    limit: 5,
    adapters: {
        ...adapters,
        windsurf: {
            list: () => [
                {
                    id: "wsf-6",
                    title: "步步开发对话6",
                    cwd: "C:/Users/Stardust/Desktop/其它",
                    workspaceUris: [
                        "C:/Users/Stardust/Desktop/其它",
                        "C:/Users/Stardust/Desktop/群项目",
                    ],
                    stepCount: 719,
                    lastModifiedTime: "2026-06-10T01:00:00Z",
                },
            ] as any,
            resolve: (id: string) => id === "wsf-6" ? "wsf-6" : null,
        },
    },
});

assert.deepEqual(
    windsurfPrimaryScopeResult.candidates,
    [],
    "workspaceScope=primary should not match secondary/associated workspace paths",
);

const unique = await resolveConversationIdAcrossSources("wsf-id", {
    dataChains: ["codex", "windsurf", "antigravity"],
    sourceFailureMode: "warn",
    adapters,
});

assert.deepEqual(
    unique.hits.map(item => `${item.dataChain}:${item.conversationId}`),
    ["windsurf:wsf-id"],
    "unique ID probing should keep a valid hit even when another source fails",
);
assert.equal(unique.statuses.find(item => item.dataChain === "antigravity")?.status, "failed");

const ambiguous = await resolveConversationIdAcrossSources("shared-id", {
    dataChains: ["codex", "claude-code"],
    adapters: {
        ...adapters,
        codex: {
            ...adapters.codex,
            get: () => ({ id: "shared-id", title: "Shared Codex", cwd: "C:/codex" } as any),
        },
    },
});

assert.equal(ambiguous.hits.length, 2, "same conversationId across sources should be reported as ambiguous");

let codexMetadataLocateLimit = 0;
const codexThreadModeResult = await listConversationCandidates({
    dataChains: ["codex"],
    query: "CU插件开发对话6",
    threadMode: "main",
    limit: 5,
    adapters: {
        ...adapters,
        codex: {
            list: (limit: number) => {
                codexMetadataLocateLimit = limit;
                return [
                    { id: "parent-main", title: "Computer Use 主线程", cwd: "C:/Users/Stardust/Desktop/插件/computer-use-plugin", updatedAtMs: 1000 },
                    {
                        id: "child-worker",
                        title: "CU插件开发对话6",
                        cwd: "C:/Users/Stardust/Desktop/插件/computer-use-plugin",
                        updatedAtMs: 2000,
                        parentConversationId: "parent-main",
                        agentRole: "explorer",
                    },
                ] as any;
            },
            get: () => null,
        },
    },
});

assert.ok(codexMetadataLocateLimit >= 20_000, "codex title/workspace metadata locate should not be capped by the old recent 300 candidate window");
assert.deepEqual(
    codexThreadModeResult.candidates.map(item => `${item.id}:${item.matchedChildConversationId || ""}`),
    ["parent-main:child-worker"],
    "threadMode=main should promote a child title hit to its parent conversation",
);

const codexChildrenResult = await listConversationCandidates({
    dataChains: ["codex"],
    threadMode: "children",
    parentQuery: "Computer Use 主线程",
    limit: 5,
    adapters: {
        ...adapters,
        codex: {
            list: () => [
                { id: "parent-main", title: "Computer Use 主线程", cwd: "C:/Users/Stardust/Desktop/插件/computer-use-plugin", updatedAtMs: 1000 },
                {
                    id: "child-worker",
                    title: "CU插件开发对话6",
                    cwd: "C:/Users/Stardust/Desktop/插件/computer-use-plugin",
                    updatedAtMs: 2000,
                    parentConversationId: "parent-main",
                    agentRole: "explorer",
                },
            ] as any,
            get: () => null,
        },
    },
});

assert.deepEqual(
    codexChildrenResult.candidates.map(item => item.id),
    ["child-worker"],
    "threadMode=children should list children only after uniquely resolving the parent",
);

const claudeCodeThreadModeResult = await listConversationCandidates({
    dataChains: ["claude-code"],
    query: "子代理任务",
    threadMode: "main",
    limit: 5,
    adapters: {
        ...adapters,
        "claude-code": {
            list: () => [
                { id: "cc-parent", title: "Claude Code 主线程", cwd: "C:/repo", updatedAtMs: 1000 },
                {
                    id: "agent-cc-child",
                    title: "CC 子代理任务",
                    cwd: "C:/repo",
                    updatedAtMs: 2000,
                    isChildThread: true,
                    parentConversationId: "cc-parent",
                    agentRole: "claude-code-subagent",
                },
            ] as any,
            get: () => null,
        },
    },
});

assert.deepEqual(
    claudeCodeThreadModeResult.candidates.map(item => `${item.id}:${item.matchedChildConversationId || ""}`),
    ["cc-parent:agent-cc-child"],
    "Claude Code threadMode=main should promote a child title hit to its parent conversation",
);

const claudeCodeChildrenResult = await listConversationCandidates({
    dataChains: ["claude-code"],
    threadMode: "children",
    parentConversationId: "cc-parent",
    limit: 5,
    adapters: {
        ...adapters,
        "claude-code": {
            list: () => [
                { id: "cc-parent", title: "Claude Code 主线程", cwd: "C:/repo", updatedAtMs: 1000 },
                {
                    id: "agent-cc-child",
                    title: "CC 子代理任务",
                    cwd: "C:/repo",
                    updatedAtMs: 2000,
                    isChildThread: true,
                    parentConversationId: "cc-parent",
                    agentRole: "claude-code-subagent",
                },
            ] as any,
            get: () => null,
        },
    },
});

assert.deepEqual(
    claudeCodeChildrenResult.candidates.map(item => item.id),
    ["agent-cc-child"],
    "Claude Code threadMode=children should return child threads for a parentConversationId",
);

const windsurfThreadModeResult = await listConversationCandidates({
    dataChains: ["windsurf"],
    query: "test-naming-check",
    threadMode: "main",
    limit: 5,
    adapters: {
        ...adapters,
        windsurf: {
            list: () => [
                {
                    id: "wsf-parent",
                    title: "Windsurf 主线程",
                    summary: "Windsurf 主线程",
                    cwd: "C:/repo",
                    lastModifiedTime: "2026-06-10T00:00:00Z",
                },
                {
                    id: "wsf-child",
                    title: "普通标题",
                    summary: "普通摘要",
                    titleBestEffort: "[subagent] test-naming-check",
                    isChildThread: true,
                    parentConversationId: "wsf-parent",
                    agentRole: "test-naming-check",
                    cwd: "C:/repo",
                    lastModifiedTime: "2026-06-10T00:01:00Z",
                },
            ] as any,
            resolve: () => null,
        },
    },
});

assert.deepEqual(
    windsurfThreadModeResult.candidates.map(item => `${item.id}:${item.matchedChildConversationId || ""}`),
    ["wsf-parent:wsf-child"],
    "Windsurf threadMode=main should use titleBestEffort child hits to promote the parent conversation",
);

const windsurfChildrenResult = await listConversationCandidates({
    dataChains: ["windsurf"],
    threadMode: "children",
    parentQuery: "Windsurf 主线程",
    limit: 5,
    adapters: {
        ...adapters,
        windsurf: {
            list: () => [
                {
                    id: "wsf-parent",
                    title: "Windsurf 主线程",
                    summary: "Windsurf 主线程",
                    cwd: "C:/repo",
                    lastModifiedTime: "2026-06-10T00:00:00Z",
                },
                {
                    id: "wsf-child",
                    title: "普通标题",
                    summary: "普通摘要",
                    titleBestEffort: "[subagent] test-naming-check",
                    isChildThread: true,
                    parentConversationId: "wsf-parent",
                    agentRole: "test-naming-check",
                    cwd: "C:/repo",
                    lastModifiedTime: "2026-06-10T00:01:00Z",
                },
            ] as any,
            resolve: () => null,
        },
    },
});

assert.deepEqual(
    windsurfChildrenResult.candidates.map(item => item.id),
    ["wsf-child"],
    "Windsurf threadMode=children should resolve parentQuery and return child threads",
);

console.log("conversation-filter tests passed");
