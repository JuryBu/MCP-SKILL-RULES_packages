import assert from "node:assert/strict";
import {
    parseConversationAutomationEvent,
    projectConversationAutomationInput,
    renderConversationAutomationEvent,
} from "../src/conversation-automation-event.ts";
import {
    formatRound,
    formatRoundForMessageRoles,
    getRoundAutomationEvents,
    getRoundSubagentSummaries,
    getRoundUserMessages,
    normalizeConversationAutomationRound,
    mergeConsecutiveHumanRounds,
    searchInRounds,
    type ConversationRound,
} from "../src/trajectory.ts";
import { formatConversationRecallRound } from "../src/conversation-recall.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";

const napcatWake = [
    "[NAPCAT_TASK_WAKE]",
    "task_id=maintenance-e2e",
    "generation=2",
    "pending_message_seqs=[1905058768,906593436]",
    "wake_id=do-not-render-this-secret-token",
    "固定群有新增消息。请调用 napcat_read_recent，完成后调用 napcat_task_ack。",
].join("\n");

const napcat = parseConversationAutomationEvent(napcatWake);
assert.ok(napcat);
assert.equal(napcat.channel, "napcat-qq");
assert.equal(napcat.type, "napcat_task_wake");
assert.equal(napcat.identifiers?.task_id, "maintenance-e2e");
assert.equal(napcat.generation, "2");
assert.equal(napcat.pendingCount, 2);
assert.deepEqual(napcat.sequenceSummary, ["1905058768", "906593436"]);
assert.equal(napcat.needsHandling, true);
assert.equal(napcat.ackRequired, true);

const napcatRendered = renderConversationAutomationEvent(napcat);
assert.match(napcatRendered, /【自动QQ消息提醒】/u);
assert.match(napcatRendered, /task=maintenance-e2e/u);
assert.match(napcatRendered, /待处理 2 条/u);
assert.match(napcatRendered, /需要处理并 ACK/u);
assert.doesNotMatch(napcatRendered, /wake_id|secret-token|napcat_read_recent/u);

const wechatWake = parseConversationAutomationEvent([
    "[WECHAT_DOCS_WAKE]",
    "subscription_id=sub-42",
    "generation=7",
    "pending_event_ids=[evt-a,evt-b,evt-c]",
    "wake_id=omit-me",
    "请处理后 ACK。",
].join("\n"));
assert.ok(wechatWake);
assert.equal(wechatWake.channel, "wechat");
assert.equal(wechatWake.pendingCount, 3);
assert.match(renderConversationAutomationEvent(wechatWake), /【自动微信消息提醒】/u);

const tdocsWake = parseConversationAutomationEvent([
    "[TDOCS_MONITOR_WAKE]",
    "monitor_id=monitor-7",
    "subscription_id=sub-doc-7",
    "generation=3",
    "wake_id=omit-doc-wake",
    "pending_batch_count=4",
    "请处理后 ACK。",
].join("\n"));
assert.ok(tdocsWake);
assert.equal(tdocsWake.channel, "tencent-docs");
assert.equal(tdocsWake.pendingCount, 4);
assert.match(renderConversationAutomationEvent(tdocsWake), /【自动腾讯文档提醒】/u);

const connectionRequest = parseConversationAutomationEvent([
    "[NAPCAT_CONNECTION_REQUEST]",
    "request_id=req-1",
    "proposed_task_id=task-new",
    "previous_task_id=task-old",
    "source_machine=training",
    "target_machine=development",
    "可信对端请求重新建立双机任务连接。",
].join("\n"));
assert.ok(connectionRequest);
assert.equal(connectionRequest.type, "napcat_connection_request");
assert.equal(connectionRequest.ackRequired, false);

const ownerReplyRaw = [
    "[NAPCAT_OWNER_REPLY]",
    "route_key=owner-private",
    "task_id=maintenance-e2e",
    "message_seq=42",
    "主人通过 QQ 通知通道回复了这条 Codex 对话，请把下面内容作为用户补充信息处理：",
    "主人真实回复正文",
    "📎 附件引用: attachment-ref-1",
].join("\n");
const ownerReply = projectConversationAutomationInput(ownerReplyRaw);
assert.ok(ownerReply);
assert.equal(ownerReply.event.type, "napcat_owner_reply");
assert.equal(ownerReply.userText, "主人真实回复正文\n📎 附件引用: attachment-ref-1");
assert.equal(parseConversationAutomationEvent(ownerReplyRaw), null, "混合消息不能被当成纯自动事件整段删除");

const bufferedOwnerReply = projectConversationAutomationInput([
    "[NAPCAT_OWNER_REPLY]",
    "route_key=owner-private",
    "message_seq=43",
    "主人此前连续发送了以下附件或媒体，当时按规则只缓冲、没有单独触发回复：",
    "message_seq=41；类型=image；附件=[{\"attachment_ref\":\"ref-41\"}]",
    "主人现在补充了明确文字，请结合这些缓冲内容一起处理：",
    "请检查这张图",
].join("\n"));
assert.ok(bufferedOwnerReply?.userText);
assert.match(bufferedOwnerReply.userText, /attachment_ref.*ref-41/u);
assert.match(bufferedOwnerReply.userText, /请检查这张图/u);
assert.doesNotMatch(bufferedOwnerReply.userText, /route_key|通知通道/u);

const futureChannel = parseConversationAutomationEvent([
    "[MATRIX_ROOM_ALERT]",
    "subscription_id=room-9",
    "generation=1",
].join("\n"));
assert.ok(futureChannel);
assert.equal(futureChannel.channel, "matrix");
assert.match(renderConversationAutomationEvent(futureChannel), /【自动MATRIX提醒】/u);

assert.equal(parseConversationAutomationEvent("[NAPCAT_TASK_WAKE]\n这是主人讨论 marker 的真实发言"), null);
assert.equal(parseConversationAutomationEvent("主人说 [WECHAT_DOCS_WAKE] 应该折叠"), null);
assert.equal(
    parseConversationAutomationEvent("<codex_delegation><input>请修复公开任务正文</input></codex_delegation>"),
    null,
);

const heartbeat = `<heartbeat>
  <automation_id>stage70</automation_id>
  <current_time_iso>2026-08-12T07:36:51.198Z</current_time_iso>
  <instructions>这里是很长的定时任务执行模板，不得回填为用户正文。</instructions>
</heartbeat>`;
const heartbeatEvent = parseConversationAutomationEvent(heartbeat);
assert.ok(heartbeatEvent);
assert.equal(heartbeatEvent.channel, "codex-automation");
assert.equal(heartbeatEvent.identifiers?.automation_id, "stage70");
assert.equal(heartbeatEvent.ackRequired, false);
assert.match(renderConversationAutomationEvent(heartbeatEvent), /【自动定时任务提醒】/u);
assert.doesNotMatch(renderConversationAutomationEvent(heartbeatEvent), /执行模板|current_time_iso|instructions/u);
assert.equal(parseConversationAutomationEvent(`主人正在讨论这个格式：\n${heartbeat}`), null);

const legacyRound: ConversationRound = {
    roundIndex: 3,
    startStep: 30,
    endStep: 34,
    userMessage: `${napcatWake}\n\n主人真实发言`,
    mediaAttachments: [],
    userMessages: [
        { stepIndex: 30, text: napcatWake, rawRole: "response_item.message.user", semanticRole: "user" },
        { stepIndex: 31, text: "主人真实发言", rawRole: "response_item.message.user", semanticRole: "user" },
    ],
    aiResponses: [{ stepIndex: 33, response: "模型已处理", thinking: "", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    semanticEvents: [
        { stepIndex: 30, rawRole: "response_item.message.user", semanticRole: "user", kind: "message", text: napcatWake },
        { stepIndex: 31, rawRole: "response_item.message.user", semanticRole: "user", kind: "message", text: "主人真实发言" },
    ],
};

const normalized = normalizeConversationAutomationRound(legacyRound);
assert.deepEqual(getRoundUserMessages(normalized).map(message => message.text), ["主人真实发言"]);
assert.equal(getRoundAutomationEvents(normalized).length, 1);
assert.doesNotMatch(JSON.stringify(normalized), /do-not-render-this-secret-token|napcat_read_recent/u);

const readOutput = formatRound(legacyRound, "normal");
assert.match(readOutput, /自动通道事件/u);
assert.match(readOutput, /主人真实发言/u);
assert.match(readOutput, /模型已处理/u);
assert.doesNotMatch(readOutput, /wake_id|secret-token|napcat_read_recent/u);

const userOnly = formatRoundForMessageRoles(legacyRound, "normal", [], new Set(["user"]), "folded");
assert.match(userOnly, /主人真实发言/u);
assert.doesNotMatch(userOnly, /自动QQ消息提醒|wake_id/u);
const systemOnly = formatRoundForMessageRoles(legacyRound, "normal", [], new Set(["system"]), "folded");
assert.match(systemOnly, /自动QQ消息提醒/u);
assert.doesNotMatch(systemOnly, /主人真实发言|wake_id/u);

assert.equal(searchInRounds([legacyRound], "secret-token", 5).length, 0);
assert.equal(searchInRounds([legacyRound], "maintenance-e2e", 5)[0]?.matchType, "automation");
assert.equal(searchInRounds([legacyRound], "主人真实发言", 5)[0]?.matchType, "user");

const recallOutput = formatConversationRecallRound(legacyRound);
assert.match(recallOutput, /自动QQ消息提醒/u);
assert.match(recallOutput, /主人真实发言/u);
assert.doesNotMatch(recallOutput, /wake_id|secret-token|napcat_read_recent/u);

const recordProjection = projectConversationRoundForRecord(legacyRound, 0);
assert.deepEqual(recordProjection.messages.map(message => [message.role, message.text]), [
    ["user", "主人真实发言"],
    ["assistant", "模型已处理"],
]);

const annotationProtectedRound = normalizeConversationAutomationRound({
    roundIndex: 9,
    startStep: 90,
    endStep: 90,
    userMessage: "[NAPCAT_TASK_WAKE]\ntask_id=quoted-example\nwake_id=quoted-wake",
    userMessages: [{
        stepIndex: 90,
        text: "[NAPCAT_TASK_WAKE]\ntask_id=quoted-example\nwake_id=quoted-wake",
        annotations: [{ selectedText: "task_id=quoted-example", comment: "这是用户批注里的引用" }],
    }],
    aiResponses: [],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    mediaAttachments: [],
    semanticEvents: [{
        stepIndex: 90,
        rawRole: "response_item.message.user",
        semanticRole: "user",
        kind: "message",
        text: "[NAPCAT_TASK_WAKE]\ntask_id=quoted-example\nwake_id=quoted-wake",
    }],
});
assert.equal(annotationProtectedRound.userMessages?.length, 1);
assert.equal(annotationProtectedRound.semanticEvents?.some(event => event.automation), false);

const automationOnlyRound: ConversationRound = {
    roundIndex: 4,
    startStep: 40,
    endStep: 44,
    userMessage: heartbeat,
    userMessages: [{ stepIndex: 40, text: heartbeat, semanticRole: "user" }],
    aiResponses: [{ stepIndex: 42, response: "定时任务已执行", thinking: "", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    mediaAttachments: [],
    semanticEvents: [{ stepIndex: 40, semanticRole: "user", kind: "message", text: heartbeat }],
};
const adjacentHumanRound: ConversationRound = {
    roundIndex: 3,
    startStep: 30,
    endStep: 39,
    userMessage: "主人真实发言",
    userMessages: [{ stepIndex: 30, text: "主人真实发言", semanticRole: "user" }],
    aiResponses: [{ stepIndex: 35, response: "模型回复", thinking: "", toolCalls: [] }],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    mediaAttachments: [],
};
const collapsed = mergeConsecutiveHumanRounds([adjacentHumanRound, automationOnlyRound]);
assert.equal(collapsed.length, 1, "纯自动事件不得增加人类轮次");
assert.deepEqual(getRoundUserMessages(collapsed[0]).map(message => message.text), ["主人真实发言"]);
assert.match(formatRound(collapsed[0], "normal"), /自动定时任务提醒/u);
assert.doesNotMatch(formatRound(collapsed[0], "normal"), /### 👤 用户 \(step 40\)|执行模板/u);
assert.equal(mergeConsecutiveHumanRounds([automationOnlyRound]).length, 0, "只有自动事件的旧缓存不得伪造人类轮次");

const oldSubagentEnvelope = `<subagent_notification>\n${JSON.stringify({
    agent_path: "019f-old-subagent",
    agent_nickname: "worker-old",
    status: { completed: "旧缓存子代理已完成" },
})}\n</subagent_notification>`;
const oldSubagentRound: ConversationRound = {
    roundIndex: 5,
    startStep: 50,
    endStep: 52,
    userMessage: oldSubagentEnvelope,
    userMessages: [{ stepIndex: 50, text: oldSubagentEnvelope, semanticRole: "user" }],
    aiResponses: [],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
    mediaAttachments: [],
    semanticEvents: [{ stepIndex: 50, semanticRole: "user", kind: "message", text: oldSubagentEnvelope }],
};
assert.equal(getRoundUserMessages(oldSubagentRound).length, 0);
assert.equal(getRoundSubagentSummaries(oldSubagentRound).length, 1);
assert.equal(formatRoundForMessageRoles(oldSubagentRound, "normal", [], new Set(["user"]), "folded"), "");
const oldSubagentOutput = formatRoundForMessageRoles(oldSubagentRound, "normal", [], new Set(["subagent"]), "folded");
assert.match(oldSubagentOutput, /Subagent-worker-old/u);
assert.doesNotMatch(oldSubagentOutput, /<subagent_notification>/u);
assert.equal(projectConversationRoundForRecord(oldSubagentRound, 0).messages.length, 0);
const mixedSubagentRound = {
    ...oldSubagentRound,
    userMessage: `${oldSubagentEnvelope}\n\n主人真实补充`,
    userMessages: [{ stepIndex: 50, text: `${oldSubagentEnvelope}\n\n主人真实补充`, semanticRole: "user" as const }],
    semanticEvents: [{ stepIndex: 50, semanticRole: "user" as const, kind: "message", text: `${oldSubagentEnvelope}\n\n主人真实补充` }],
};
assert.deepEqual(getRoundUserMessages(mixedSubagentRound).map(message => message.text), ["主人真实补充"]);
const mergedSubagent = mergeConsecutiveHumanRounds([adjacentHumanRound, oldSubagentRound]);
assert.equal(mergedSubagent.length, 1, "旧缓存子代理通知不得增加人类轮次");
assert.equal(getRoundSubagentSummaries(mergedSubagent[0]).length, 1);

console.log("✅ conversation automation event：自动通道模板已结构化压缩，真实发言和旧缓存读取保持兼容");
