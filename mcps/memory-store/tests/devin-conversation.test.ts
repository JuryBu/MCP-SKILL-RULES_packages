import assert from "node:assert/strict";
import { devinRawToRounds, redactDevinBinary } from "../src/devin-conversation.ts";
import { formatRound, formatRoundForMessageRoles } from "../src/trajectory.ts";
import { buildConversationCompactionMetadata, formatConversationRecallRound } from "../src/conversation-recall.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";
import type { DevinMessageNode, DevinRawConversation } from "../src/devin-types.ts";
import { devinDesktopText } from "../src/devin-conversation-content.ts";

function node(nodeId: number, role: string, content: string, extra: Record<string, unknown> = {}): DevinMessageNode {
    return { nodeId, parentNodeId: nodeId > 1 ? nodeId - 1 : null, createdAt: 2000000000, metadata: {}, message: { role, content, ...extra, metadata: { created_at: "2026-01-02T03:04:05.123Z", ...(extra.metadata as object || {}) } } };
}

function raw(nodes: DevinMessageNode[]): DevinRawConversation {
    return { summary: { id: "test-heron", canonicalId: "test-heron", sessionId: "test-heron", aliases: ["test-heron"], title: "Synthetic", workspaceUris: [], sourcePath: "synthetic", desktopPaths: [], sourceKind: "devin-cli", matchedMessageIds: 0, partial: false, warnings: [] }, nodes, desktopMessages: [], compactions: [], fingerprint: { revision: "synthetic-v1" }, partial: false, warnings: [] };
}

const source = raw([
    node(1, "system", "SECRET_SYSTEM_PREFIX"),
    node(2, "user", "# AGENTS.md instructions\n请解释这段引用，不是注入", { metadata: { is_user_input: true, extensions: { "chisel/acp-content-blocks": [{ type: "resource", resource: { text: "quoted selection", uri: "selection://example" } }] } }, images: [{ width: 1, height: 2, mime_type: "image/png", base64_data: "YWJj" }] }),
    node(3, "assistant", "visible answer", { thinking: "private thought", tool_calls: [{ id: "edit-1", name: "edit", arguments: { file_path: "sample.ts", old_string: "old", new_string: "new" } }, { id: "todo-1", name: "todo_write", arguments: { todos: [{ content: "verify", status: "pending" }] } }, { id: "read-1", name: "read", arguments: { file_path: "sample.ts" } }] }),
    node(4, "tool", "file contents", { tool_call_id: "read-1" }),
    node(5, "assistant", "COMPACTION_NOT_A_FACT"),
    node(6, "user", "next question"),
    node(7, "assistant", "next answer", { tool_calls: [{ id: "child-call", name: "run_subagent", arguments: { task: "inspect only" } }] }),
]);
source.compactions = [{ nodeId: 5, summarizedFrom: 4, summary: "COMPACTION_NOT_A_FACT", restored: true }];
source.desktopMessages = [{ position: 4, kind: "subagent", payload: { agentId: "agent-one", title: "Verifier", task: "inspect only", profile: "Explore", status: "completed", summary: "child summary", childMessages: [{ kind: "agent_message", content: [{ content: { type: "text", text: "expanded child body" } }] }] } }];
const rounds = devinRawToRounds(source);
assert.equal(rounds.length, 2);
assert.equal(rounds[0].createdAt, "2026-01-02T03:04:05.123Z");
assert.equal(rounds[0].userMessages?.[0].createdAt, rounds[0].createdAt);
assert.match(rounds[0].userMessage, /quoted selection/u);
assert.equal(rounds[0].attachments?.[0].width, 1);
assert.equal(rounds[0].attachments?.[0].height, 2);
assert.equal(rounds[0].toolCalls.length, 3);
assert.equal(rounds[0].toolCalls[2].resultFull, "file contents");
assert.equal(rounds[0].fileViews?.[0].textSummary, "file contents");
assert.equal(rounds[0].codeActions[0].diffs[0].replacementContent, "new");
assert.equal(rounds[0].taskBoundaries[0].taskStatus, "pending");
assert.equal(rounds[0].aiResponses.length, 1);
assert.equal(rounds[0].compactionSummaries?.[0].provider, "devin");
const users = formatRoundForMessageRoles(rounds[0], "normal", [], new Set(["user"]), "folded");
assert.match(users, /请解释这段引用/u);
assert.doesNotMatch(users, /SECRET_SYSTEM_PREFIX|COMPACTION_NOT_A_FACT|private thought/u);
const recall = formatConversationRecallRound(rounds[0]);
assert.match(recall, /请解释这段引用/u);
assert.match(recall, /visible answer/u);
assert.doesNotMatch(recall, /COMPACTION_NOT_A_FACT|private thought|file contents/u);
const projected = JSON.stringify(projectConversationRoundForRecord(rounds[0]));
assert.match(projected, /visible answer/u);
assert.doesNotMatch(projected, /COMPACTION_NOT_A_FACT|private thought|file contents/u);
const normal = formatRound(rounds[0], "normal", [], { compactionMode: "omit" });
assert.match(normal, /Devin Local/u);
assert.match(normal, /请解释这段引用/u);
const compaction = buildConversationCompactionMetadata("windsurf", rounds);
assert.equal(compaction.events.length, 1);
assert.equal(compaction.events[0].kind, "devin_compact_summary");
assert.equal(rounds[1].subagentSummaries[0].threadId, "test-heron--subagent-agent-one");
assert.equal(rounds[1].subagentSummaries[0].summary, "child summary");
const expanded = devinRawToRounds(source, { link: "expand_children" });
assert.match(expanded[1].subagentSummaries[0].summary || "", /expanded child body/u);
assert.equal(redactDevinBinary('data:image/png;base64,YWJj keep this text'), "[inline attachment] keep this text");
assert.equal(redactDevinBinary({ data: "ordinary text", image: { type: "image", data: "YWJj" } }), '{"data":"ordinary text","image":{"type":"image","data":"[binary omitted]"}}');
assert.throws(() => devinRawToRounds(source, { signal: AbortSignal.abort() }), /cancelled/u);
assert.equal(devinDesktopText({ content: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "MARK_" } }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "END" } }] }), "MARK_END");
const encodedToolImage = JSON.stringify({ content: [{ type: "image", mimeType: "image/png", data: "YWJj".repeat(16000) }] });
assert.ok(redactDevinBinary(encodedToolImage).length < 150);
assert.equal(redactDevinBinary('{ "ordinary": "spacing retained" }'), '{ "ordinary": "spacing retained" }');
const duplicateChildren = structuredClone(source);
duplicateChildren.desktopMessages.push(structuredClone(duplicateChildren.desktopMessages[0]));
assert.equal(devinRawToRounds(duplicateChildren)[1].subagentSummaries.length, 1);
const unknownChild = structuredClone(source);
unknownChild.desktopMessages[0].payload.task = "unmatched task";
assert.equal(devinRawToRounds(unknownChild).flatMap(round => round.subagentSummaries).length, 0);
assert.equal(unknownChild.partial, true);
const userSummary = structuredClone(source);
userSummary.nodes[4].message.role = "user";
assert.equal(devinRawToRounds(userSummary).length, 2);
console.log("PASS Devin normalization: original timestamps, quoted resources, image metadata, tool details, subagents, compaction/Record/recall separation and binary redaction");
