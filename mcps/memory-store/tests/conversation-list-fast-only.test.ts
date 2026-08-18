import assert from "node:assert/strict";
import {
    getConversationListFallbackPlan,
    listCandidateMatchesQuery,
    normalizeListQuery,
    shouldRequireExplicitConversationId,
    sortListMatchesByQuery,
    splitListQueryTerms,
    type ConversationListCandidate,
} from "../src/tools/conversation.ts";

const codexAutoPlan = getConversationListFallbackPlan("codex", "auto", 0);
assert.equal(codexAutoPlan.includeRawPreview, false, "Codex list(auto) must not read raw JSONL previews");
assert.equal(codexAutoPlan.allowSmartSearch, false, "Codex list(auto) must not trigger smart search");
assert.equal(codexAutoPlan.returnContextProbeHitsFirst, false);
assert.equal(codexAutoPlan.deepSearchSuggested, true);
assert.ok(codexAutoPlan.skipped.includes("raw-jsonl-preview"));
assert.ok(codexAutoPlan.skipped.includes("smart-auto"));

const codexProbePlan = getConversationListFallbackPlan("codex", "auto", 1);
assert.equal(codexProbePlan.returnContextProbeHitsFirst, true, "Codex list should return contextProbe hits before deeper fallback");
assert.equal(codexProbePlan.includeRawPreview, false);
assert.equal(codexProbePlan.allowSmartSearch, false);
assert.equal(codexProbePlan.deepSearchSuggested, true);

const codexExactPlan = getConversationListFallbackPlan("codex", "exact", 0);
assert.equal(codexExactPlan.includeRawPreview, false);
assert.equal(codexExactPlan.allowSmartSearch, false);
assert.equal(codexExactPlan.skipped.includes("smart-auto"), false);

const codexFuzzyPlan = getConversationListFallbackPlan("codex", "fuzzy", 0);
assert.equal(codexFuzzyPlan.includeRawPreview, false);
assert.equal(codexFuzzyPlan.allowSmartSearch, false);

const codexSmartPlan = getConversationListFallbackPlan("codex", "smart", 0);
assert.equal(codexSmartPlan.includeRawPreview, false, "Even explicit Codex list(smart) must stay on lightweight candidate material");
assert.equal(codexSmartPlan.allowSmartSearch, true, "Explicit smart remains available for lightweight rerank/search");
assert.equal(codexSmartPlan.deepSearchSuggested, true);

const antigravityAutoPlan = getConversationListFallbackPlan("antigravity", "auto", 0);
assert.equal(antigravityAutoPlan.deepSearchSuggested, false);
assert.equal(antigravityAutoPlan.allowSmartSearch, true, "Antigravity list(auto) keeps legacy smart fallback");

const antigravitySmartPlan = getConversationListFallbackPlan("antigravity", "smart", 0);
assert.equal(antigravitySmartPlan.includeRawPreview, true, "Antigravity explicit smart keeps legacy raw preview behavior");
assert.equal(antigravitySmartPlan.allowSmartSearch, true);

const windsurfAutoPlan = getConversationListFallbackPlan("windsurf", "auto", 0);
assert.equal(windsurfAutoPlan.includeRawPreview, false, "Windsurf list(auto) must not pull raw Cascade previews");
assert.equal(windsurfAutoPlan.allowSmartSearch, false, "Windsurf list(auto) must stay metadata-only");
assert.equal(windsurfAutoPlan.deepSearchSuggested, false, "Windsurf has no deep_locate background scanner yet");
assert.ok(windsurfAutoPlan.skipped.includes("raw-trajectory-preview"));
assert.ok(windsurfAutoPlan.skipped.includes("deep-locate-unsupported"));

const windsurfSmartPlan = getConversationListFallbackPlan("windsurf", "smart", 0);
assert.equal(windsurfSmartPlan.includeRawPreview, false, "Windsurf list(smart) still uses lightweight candidate material");
assert.equal(windsurfSmartPlan.allowSmartSearch, true, "Explicit smart can rerank lightweight Windsurf candidates");

const exactId = "019deda5-e3c6-76b1-b6f8-2f18c2ab7f33";
const candidates: ConversationListCandidate[] = [
    {
        id: "019e114a-62bc-7e12-9444-c40f73ff93cc",
        title: `${exactId}\n\n你接着我们之前在这个对话的开发进度去继续`,
        workspace: "C:\\Users\\Stardust\\Desktop\\插件",
        updatedAt: "2026-05-10T09:53:16.527Z",
        detail: "",
    },
    {
        id: exactId,
        title: "CU插件开发对话1",
        workspace: "\\\\?\\C:\\Users\\Stardust\\Desktop\\插件",
        updatedAt: "2026-05-07T10:48:17.450Z",
        detail: "",
    },
];
assert.equal(
    sortListMatchesByQuery(candidates, "019deda5e3c676b1b6f82f18c2ab7f33")[0].id,
    exactId,
    "Full conversationId matches must rank before newer titles that merely mention the ID",
);

const multiTermQuery = "再次检查工具加载情况 computer-use 不加载 名称";
const normalizedMultiTermQuery = normalizeListQuery(multiTermQuery);
const multiTermQueryTerms = splitListQueryTerms(multiTermQuery);
const multiTermCandidates: ConversationListCandidate[] = [
    {
        id: "cc-body",
        title: "再次检查工具加载情况",
        workspace: "C:/Users/Stardust/Desktop/工具",
        updatedAt: "2026-06-14T01:00:00.000Z",
        detail: "",
    },
    {
        id: "cc-workspace",
        title: "无关标题",
        workspace: "C:/Users/Stardust/Desktop/computer-use-plugin",
        updatedAt: "2026-06-14T02:00:00.000Z",
        detail: "",
    },
    {
        id: "cc-miss",
        title: "完全无关",
        workspace: "C:/Users/Stardust/Desktop/其它",
        updatedAt: "2026-06-14T03:00:00.000Z",
        detail: "",
    },
];
assert.equal(
    listCandidateMatchesQuery(multiTermCandidates[0], normalizedMultiTermQuery, multiTermQueryTerms),
    true,
    "Whitespace-separated list query terms should match by OR against titles",
);
assert.equal(
    listCandidateMatchesQuery(multiTermCandidates[1], normalizedMultiTermQuery, multiTermQueryTerms),
    true,
    "Whitespace-separated list query terms should match by OR against workspaces",
);
assert.equal(
    listCandidateMatchesQuery(multiTermCandidates[2], normalizedMultiTermQuery, multiTermQueryTerms),
    false,
    "Candidates without any query term match should stay filtered out",
);
assert.deepEqual(
    sortListMatchesByQuery(multiTermCandidates.filter(item => listCandidateMatchesQuery(item, normalizedMultiTermQuery, multiTermQueryTerms)), normalizedMultiTermQuery, multiTermQueryTerms)
        .map(item => item.id),
    ["cc-body", "cc-workspace"],
    "Title term hits should rank before workspace-only term hits",
);

const aliasQuery = "旧 UI 标题";
const normalizedAliasQuery = normalizeListQuery(aliasQuery);
const aliasCandidates: ConversationListCandidate[] = [
    {
        id: "cc-alias-hit",
        title: "当前显示标题",
        searchAliases: ["旧 UI 标题", "Windows Store Desktop Title"],
        workspace: "C:/Users/Stardust/Desktop/其它",
        updatedAt: "2026-06-14T04:00:00.000Z",
        detail: "",
    },
    {
        id: "cc-workspace-hit",
        title: "无关标题",
        workspace: "C:/Users/Stardust/Desktop/旧 UI 标题",
        updatedAt: "2026-06-14T05:00:00.000Z",
        detail: "",
    },
];
assert.equal(
    listCandidateMatchesQuery(aliasCandidates[0], normalizedAliasQuery, splitListQueryTerms(aliasQuery)),
    true,
    "Claude Code searchAliases should participate in single-source list query matching",
);
assert.deepEqual(
    sortListMatchesByQuery(aliasCandidates, normalizedAliasQuery, splitListQueryTerms(aliasQuery)).map(item => item.id),
    ["cc-alias-hit", "cc-workspace-hit"],
    "Alias title hits should rank before workspace-only hits",
);

assert.equal(
    shouldRequireExplicitConversationId("search", "auto", undefined),
    true,
    "Direct search without an explicit conversationId must not infer current conversation through shared backend",
);
assert.equal(
    shouldRequireExplicitConversationId("read", "codex", undefined),
    true,
    "Codex read must require an explicit conversationId",
);
assert.equal(
    shouldRequireExplicitConversationId("fetch", "windsurf", undefined),
    true,
    "Windsurf fetch must require an explicit conversationId",
);
assert.equal(
    shouldRequireExplicitConversationId("export", "auto", undefined),
    true,
    "Export without an explicit conversationId must not infer current conversation through shared backend",
);
assert.equal(
    shouldRequireExplicitConversationId("export", "codex", exactId),
    false,
    "Export with an explicit conversationId remains available on Codex",
);
assert.equal(
    shouldRequireExplicitConversationId("search", "auto", exactId),
    false,
    "Explicit conversationId keeps auto cross-chain fallback available",
);
assert.equal(
    shouldRequireExplicitConversationId("search", "antigravity", undefined),
    false,
    "Explicit Antigravity dataChain keeps legacy current-window compatibility",
);
assert.equal(
    shouldRequireExplicitConversationId("list", "auto", undefined),
    false,
    "List remains the no-id discovery action",
);
