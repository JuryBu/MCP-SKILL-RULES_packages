import assert from "node:assert/strict";
import { listCandidateMatchesFuzzyTitle } from "../src/tools/conversation.ts";
import { listConversationCandidates, type ConversationSourceAdapters } from "../src/conversation-filter.ts";

const candidate = { id: "fixture-maintenance", title: "维护升级协作对话接力" };
assert.equal(listCandidateMatchesFuzzyTitle(candidate, "维护升级对话接力"), true);
assert.equal(listCandidateMatchesFuzzyTitle(candidate, "维护 升级 对话接力"), true);
assert.equal(listCandidateMatchesFuzzyTitle(candidate, "升级维护对话接力"), false);
assert.equal(listCandidateMatchesFuzzyTitle(candidate, "维护"), false);
assert.equal(listCandidateMatchesFuzzyTitle({ id: "another", title: "这是完全不同的项目研究记录" }, "维护升级对话接力"), false);
assert.equal(listCandidateMatchesFuzzyTitle({ id: "long", title: "其它项目的很长历史标题在前面维护升级协作对话接力" }, "维护升级对话接力"), false);
const adapters = { localList: async () => [
    { ...candidate, dataChain: "antigravity", workspace: "", updatedAt: "", detail: "", isChildThread: false },
    { id: "fixture-child", title: "child", dataChain: "antigravity", workspace: "", updatedAt: "", detail: "", isChildThread: true, parentConversationId: candidate.id },
    { id: "fixture-other", title: "other", dataChain: "antigravity", workspace: "", updatedAt: "", detail: "", isChildThread: true, parentConversationId: "other-parent" },
] } as unknown as ConversationSourceAdapters;
const fuzzy = await listConversationCandidates({ dataChains: ["antigravity"], source: "local", query: "维护升级对话接力", mode: "fuzzy", adapters });
assert.deepEqual(fuzzy.candidates.map(item => item.id), [candidate.id]);
const exact = await listConversationCandidates({ dataChains: ["antigravity"], source: "local", query: "维护升级对话接力", mode: "exact", adapters });
assert.equal(exact.candidates.length, 0);
const children = await listConversationCandidates({ dataChains: ["antigravity"], source: "local", threadMode: "children", parentConversationId: candidate.id, limit: 1, adapters });
assert.deepEqual(children.candidates.map(item => item.id), ["fixture-child"]);
console.log("✅ 中文标题省词定位保持顺序与相似度边界");
