import assert from "node:assert/strict";
import test from "node:test";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { createAntigravityConversationContent, projectAntigravityTail } from "../src/antigravity-conversation-content.mjs";
import { AntigravityLsTransport } from "../src/transports/antigravity-ls.mjs";

const target = { machine_id: "synthetic", host: "antigravity", surface: "desktop", conversation_id: "selected-synthetic-cascade" };
const trajectoryId = "synthetic-trajectory";

function transportFixture(context, mode = "ok") {
  const calls = [];
  const initiallyCold = mode.startsWith("cold");
  let loaded = !initiallyCold;
  const transport = new AntigravityLsTransport({
    discover: async () => [{ pid: 100, ports: [39002], csrf: "synthetic" },
      ...(mode === "cold-ambiguous" ? [{ pid: 101, ports: [39003], csrf: "synthetic-other" }] : [])],
    fetchImpl: async (url, request) => {
      const method = url.split("/").at(-1);
      const payload = JSON.parse(request.body);
      calls.push({ method, payload });
      if (method === "GetAllCascadeTrajectories") {
        const ids = mode === "missing" || !loaded ? [] : [target.conversation_id, "different-synthetic-cascade"];
        return Response.json({ trajectorySummaries: Object.fromEntries(ids.map(id => [id, {
          trajectoryId, status: "CASCADE_RUN_STATUS_RUNNING", stepCount: 200,
          summary: "合成会话", lastModifiedTime: "2026-11-18T06:12:00Z",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///C:/private-folder/%E6%B5%8B%E8%AF%95" }],
          trajectoryMetadata: { rootConversationId: id, workspaceUris: ["file:///C:/private-folder/%E6%B5%8B%E8%AF%95", "https://invalid.workspace.example/path"] },
        }])) });
      }
      if (method === "GetCascadeTrajectoryGeneratorMetadata" && initiallyCold) {
        assert.deepEqual(payload, { cascadeId: target.conversation_id });
        loaded = true;
        return { ok: true, body: {
          async cancel() { calls.push({ method: "DiscardUnneededMetadataBody" }); },
          getReader() { throw new Error("metadata body must not be read"); },
        } };
      }
      if (method === "GetCascadeModelConfigData") return Response.json({ clientModelConfigs: [] });
      if (method !== "GetCascadeTrajectorySteps") throw new Error("only the original read methods are expected");
      if (payload.stepOffset === 72) return new Response("x".repeat(800 * 1024));
      const steps = Array.from({ length: 200 - payload.stepOffset }, (_, index) => ({
        type: "CORTEX_STEP_TYPE_GENERIC",
        metadata: { sourceTrajectoryStepInfo: {
          stepIndex: payload.stepOffset + index,
          cascadeId: mode === "wrong-tail" ? "unrelated-cascade" : mode === "cold-unverified" ? undefined : target.conversation_id,
          trajectoryId,
        } },
      }));
      return Response.json({ steps });
    },
  });
  context.after(() => transport.close());
  return { transport, calls };
}

test("approved Antigravity tail retries a smaller suffix on byte overflow without fetching full history", async context => {
  const { transport, calls } = transportFixture(context);
  const observed = await transport.readContentTail(target);
  assert.equal(observed.steps.length, 32);
  assert.equal(observed.omitted_earlier, true);
  assert.deepEqual(calls.filter(call => call.method === "GetCascadeTrajectorySteps").map(call => call.payload.stepOffset), [72, 168]);
  assert.ok(calls.every(call => call.method !== "SendUserCascadeMessage"));
  const provider = createAntigravityConversationContent(transport);
  const listed = await provider.list(target, { limit: 1, cursor: null });
  assert.equal(listed.conversations.length, 1);
  assert.equal(listed.next_cursor, "resident:different-synthetic-cascade");
  const second = await provider.list(target, { limit: 1, cursor: listed.next_cursor });
  assert.equal(second.conversations[0].conversation_id, target.conversation_id);
  assert.equal(second.conversations[0].workspace, "测试");
  assert.equal(second.conversations[0].updated_at, "2026-11-18T06:12:00Z");
  assert.doesNotMatch(JSON.stringify(second), /private-folder|invalid\.workspace/u);
  assert.equal(second.next_cursor, null);
});

test("unloaded or unrelated Antigravity tails cannot fall back to raw history", async context => {
  const missing = transportFixture(context, "missing");
  await assert.rejects(missing.transport.readContentTail(target), { code: "ls_target_unavailable" });
  assert.ok(missing.calls.every(call => call.method === "GetAllCascadeTrajectories"));
  const mismatch = transportFixture(context, "wrong-tail");
  await assert.rejects(mismatch.transport.readContentTail(target), { code: "ls_invalid_steps" });
});

test("an approved cold desktop root gets one scoped metadata lookup and no unbounded history read", async context => {
  const { transport, calls } = transportFixture(context, "cold");
  const verified = [];
  const reader = createAntigravityConversationContent(transport, { summaryIndex: { async find({ conversationId }) {
    verified.push(conversationId);
    return { cascade_id: conversationId };
  } } });
  const result = await reader.readRecent(target, { lastRounds: 2 });
  assert.equal(result.title, "合成会话");
  assert.deepEqual(verified, [target.conversation_id]);
  assert.deepEqual(calls.slice(0, 6).map(call => call.method), [
    "GetAllCascadeTrajectories", "GetCascadeTrajectoryGeneratorMetadata", "DiscardUnneededMetadataBody", "GetAllCascadeTrajectories",
    "GetCascadeTrajectorySteps", "GetCascadeTrajectorySteps",
  ]);
  assert.deepEqual(calls.filter(call => call.method === "GetCascadeTrajectorySteps").map(call => call.payload.stepOffset), [72, 168]);
});

test("unapproved cold identities and multiple responding hosts stop before metadata reads", async context => {
  for (const [mode, decision] of [["cold", false], ["cold-ambiguous", true]]) {
    const { transport, calls } = transportFixture(context, mode);
    await assert.rejects(transport.readContentTail(target, { verifyColdTarget: async () => decision }), { code: "ls_target_unavailable" });
    assert.ok(calls.every(call => call.method === "GetAllCascadeTrajectories"));
  }
  const unverified = transportFixture(context, "cold-unverified");
  await assert.rejects(unverified.transport.readContentTail(target, { verifyColdTarget: async () => true }), { code: "ls_invalid_steps" });
});

test("an explicitly selected native catalog retains older threads and enriches status only for a live exact match", async context => {
  const { transport, calls } = transportFixture(context);
  const indexCalls = [];
  const summaryIndex = { async page({ after, limit }) {
    indexCalls.push({ after, limit });
    if (after) throw new CoreError("host_content_unavailable", "unavailable");
    return {
      conversations: [{ cascade_id: "old-thread", title: "较早的对话" }, { cascade_id: target.conversation_id, title: "当前测试" }],
      has_more: true, generation: "a".repeat(24),
    };
  } };
  const provider = createAntigravityConversationContent(transport, { summaryIndex });
  const first = await provider.list(target, { limit: 2, cursor: null });
  assert.equal(first.coverage_source, "desktop_catalog");
  assert.equal(first.partial, false);
  assert.deepEqual(first.conversations.map(entry => entry.status), ["unknown", "running"]);
  assert.equal(first.next_cursor, "catalog:" + "a".repeat(24) + ":" + target.conversation_id);
  await assert.rejects(provider.list(target, { limit: 2, cursor: first.next_cursor }), { code: "host_content_unavailable" });
  assert.equal(calls.filter(call => call.method === "GetAllCascadeTrajectories").length, 1);
  assert.deepEqual(indexCalls, [{ after: "", limit: 2 }, { after: target.conversation_id, limit: 2 }]);
});

test("a changed catalog generation never yields a next page from a different directory", async context => {
  const { transport, calls } = transportFixture(context);
  const summaryIndex = { async page({ after }) {
    return { conversations: [{ cascade_id: "middle" }], has_more: !after, generation: (after ? "b" : "a").repeat(24) };
  } };
  const provider = createAntigravityConversationContent(transport, { summaryIndex });
  const first = await provider.list(target, { limit: 1, cursor: null });
  await assert.rejects(provider.list(target, { limit: 1, cursor: first.next_cursor }), { code: "invalid_cursor" });
  assert.equal(calls.filter(call => call.method === "GetAllCascadeTrajectories").length, 1);
});

test("starting with the live subset marks partial coverage; later pages never switch to the disk index", async context => {
  const { transport } = transportFixture(context);
  let count = 0;
  const summaryIndex = { async page() { count += 1; throw new CoreError("host_content_unavailable", "unavailable"); } };
  const provider = createAntigravityConversationContent(transport, { summaryIndex });
  const first = await provider.list(target, { limit: 1, cursor: null });
  assert.equal(first.coverage_source, "resident_index");
  assert.deepEqual(first.coverage_reasons, ["native_index_limited"]);
  assert.equal(first.partial, true);
  const second = await provider.list(target, { limit: 1, cursor: first.next_cursor });
  assert.equal(second.conversations[0].conversation_id, target.conversation_id);
  assert.equal(count, 1);
});

test("grouping preserves a validated delivery within its native round and drops hidden or tool text", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const messageId = "00000000-0000-0000-0000-000000000002";
  const hidden = "00000000-0000-0000-0000-000000000003";
  const mismatched = "00000000-0000-0000-0000-000000000004";
  const sent = "跨端回执正文";
  const marker = (delivery, payload) => `[COMMUNICATION_CORE message_id=${messageId} delivery_id=${delivery}]\n\n${payload}`;
  const tail = { description: { cascade_id: target.conversation_id }, steps: [
    { type: "user_input", execution_id: "first", user_input: { text: "先查一下" } },
    { type: "CORTEX_STEP_TYPE_GENERIC", assistant_response: { final: true, text: "DO-NOT-SHOW-TOOL" } },
    { type: "CORTEX_STEP_TYPE_MCP_TOOL" },
    { type: "planner_response", status: "DONE", assistant_response: { final: true, has_tool_calls: true, text: "DO-NOT-SHOW-NARRATION" } },
    { type: "user_input", execution_id: "first", user_input: { client_message_id: id, text: marker(id, sent) } },
    { type: "user_input", execution_id: "first", user_input: { client_message_id: hidden, text: "DO-NOT-SHOW-HIDDEN-CHANGED-FORMAT" } },
    { type: "user_input", execution_id: "first", user_input: { client_message_id: mismatched, text: "DO-NOT-SHOW-UNVERIFIED-TEXT" } },
    { type: "planner_response", status: "DONE", assistant_response: { final: true, text: "找到了" } },
  ] };
  const projected = projectAntigravityTail(tail, target, 3, delivery => ({
    message_id: messageId, target_key: identityKey(target),
    envelope: { caller: { host: "codex" }, text: delivery === hidden ? "DO-NOT-SHOW-HIDDEN" : sent, ...(delivery === hidden ? { message_visibility: "hidden" } : {}) },
  }));
  assert.equal(projected.rounds.length, 1);
  assert.deepEqual(projected.rounds[0].messages.map(message => message.role), ["user", "external", "assistant", "activity"]);
  assert.equal(projected.rounds[0].messages[1].text, sent);
  assert.equal(projected.rounds[0].messages[1].visibility, "visible");
  assert.equal(projected.rounds[0].messages.at(-1).text, "该轮还有 2 条工具或活动记录");
  assert.equal(projected.partial, true);
  assert.doesNotMatch(JSON.stringify(projected), /DO-NOT-SHOW/u);
});

test("consecutive inputs of one execution stay together until activity or an explicit interruption", () => {
  const input = (body, interrupting = false) => ({ type: "user_input", execution_id: "synthetic-native-execution", interrupting, user_input: { text: body } });
  const tail = { description: { cascade_id: target.conversation_id }, steps: [
    input("first input"), input("follow-up before work"), { type: "CORTEX_STEP_TYPE_MCP_TOOL" },
    input("follow-up after work"), input("explicit native interruption", true),
  ] };
  const result = projectAntigravityTail(tail, target, 3);
  assert.deepEqual(result.rounds.map(round => round.messages.filter(message => message.role === "user").map(message => message.text)),
    [["first input", "follow-up before work"], ["follow-up after work"], ["explicit native interruption"]]);
});

test("an unverified relay never appears as a native user message", () => {
  const deliveryId = "00000000-0000-0000-0000-000000000007";
  const messageId = "00000000-0000-0000-0000-000000000008";
  const outsideId = "00000000-0000-0000-0000-000000000009";
  const marker = `[COMMUNICATION_CORE message_id=${messageId} delivery_id=${deliveryId}]`;
  const tail = { description: { cascade_id: target.conversation_id }, steps: [
    { type: "user_input", user_input: { text: `解释一下 ${marker}` } },
    { type: "user_input", user_input: { client_message_id: deliveryId, text: `这条消息来自「codex」代理对话「fixture」，由交流核心转送。\n${marker}\n\nDO-NOT-SHOW-ORPHAN` } },
    { type: "user_input", user_input: { text: "主人在QQ窗口中的来信，由交流核心转送。\n\nDO-NOT-SHOW-NO-ID" } },
    { type: "user_input", user_input: { client_message_id: outsideId, text: "DO-NOT-SHOW-OTHER-TARGET" } },
    { type: "planner_response", status: "DONE", assistant_response: { final: true, text: "保留已观察的回复" } },
  ] };
  const projected = projectAntigravityTail(tail, target, 3, id => id === outsideId ? { target_key: "other-target" } : null);
  assert.equal(projected.partial, true);
  assert.deepEqual(projected.rounds[0].messages.map(entry => entry.text), [`解释一下 ${marker}`, "保留已观察的回复"]);
  assert.doesNotMatch(JSON.stringify(projected), /DO-NOT-SHOW/u);
});
