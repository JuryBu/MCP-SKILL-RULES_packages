import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityLsTransport, compactAntigravitySteps } from "../src/transports/antigravity-ls.mjs";

const target = { conversation_id: "test-cascade" };
const summary = { trajectorySummaries: { "test-cascade": { trajectoryId: "test-trajectory", status: "CASCADE_RUN_STATUS_IDLE", stepCount: 2, summary: "测试", trajectoryMetadata: { rootConversationId: "test-cascade" } } } };
const candidate = { pid: 123, ports: [12345], csrf: "private-test-sentinel" };

function setup(fetchImpl, options = {}) {
  return new AntigravityLsTransport({ discover: async () => [candidate], fetchImpl, ...options });
}

test("LS发现仅接受准确root绑定并正确解码中文", async () => {
  const calls = [];
  const transport = setup(async (url, options) => { calls.push({ url, options }); return Response.json(summary); });
  const description = await transport.describe(target);
  assert.equal(description.cascade_id, "test-cascade");
  assert.equal(description.trajectory_id, "test-trajectory");
  assert.equal(description.title, "测试");
  assert.equal(calls[0].url, "http://127.0.0.1:12345/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories");
  assert.equal(calls[0].options.headers["x-codeium-csrf-token"], candidate.csrf);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(JSON.stringify(description).includes(candidate.csrf), false);
  await transport.close();
});

function storedSteps() {
  return { steps: [0, 1].map(stepIndex => ({
    type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE",
    userInput: { items: [{ text: "已保存的目标对话" }] },
    metadata: { sourceTrajectoryStepInfo: { stepIndex, cascadeId: target.conversation_id, trajectoryId: "stored-trajectory" } },
  })) };
}

test("未加载目标可由只读保存轨迹核身份，不创建对话或覆盖模型", async () => {
  const calls = [];
  const transport = setup(async (url, options) => {
    calls.push({ method: url.split("/").at(-1), input: JSON.parse(options.body) });
    return Response.json(url.endsWith("GetAllCascadeTrajectories") ? {} : storedSteps());
  });
  const description = await transport.describe(target);
  assert.equal(description.cascade_id, target.conversation_id);
  assert.equal(description.trajectory_id, "stored-trajectory");
  assert.equal(description.status, "CASCADE_RUN_STATUS_NOT_LOADED");
  assert.equal(description.identity_source, "persisted_trajectory_steps");
  assert.equal(description.step_count, 2);
  assert.deepEqual(calls, [{ method: "GetAllCascadeTrajectories", input: {} }, { method: "GetCascadeTrajectorySteps", input: { cascadeId: target.conversation_id, stepOffset: 0 } }]);
});

test("保存轨迹缺失、身份混杂或步骤不连续时仍保持目标不可达", async () => {
  const fixtures = [ {}, { steps: [] }, storedSteps(), storedSteps(), storedSteps() ];
  fixtures[2].steps[1].metadata.sourceTrajectoryStepInfo.cascadeId = "other-root";
  fixtures[3].steps[1].metadata.sourceTrajectoryStepInfo.trajectoryId = "other-trajectory";
  fixtures[4].steps[1].metadata.sourceTrajectoryStepInfo.stepIndex = 3;
  for (const fixture of fixtures) {
    const transport = setup(async url => Response.json(url.endsWith("GetAllCascadeTrajectories") ? {} : fixture));
    await assert.rejects(transport.describe(target), { code: "ls_target_unavailable" });
  }
});

test("目标标题相同但root不符时不接受", async () => {
  const changed = structuredClone(summary);
  changed.trajectorySummaries["test-cascade"].trajectoryMetadata.rootConversationId = "other";
  const transport = setup(async () => Response.json(changed));
  await assert.rejects(transport.describe(target), { code: "ls_target_unavailable" });
});

test("多个实际端点同时含目标时拒绝猜测", async () => {
  const transport = new AntigravityLsTransport({ discover: async () => [{ ...candidate, ports: [12345, 12346] }], fetchImpl: async () => Response.json(summary) });
  await assert.rejects(transport.describe(target), { code: "ls_target_ambiguous" });
});

test("发送前重新核目标，禁止其它方法和跨目标载荷", async () => {
  const calls = [];
  const transport = setup(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return Response.json(url.endsWith("GetAllCascadeTrajectories") ? summary : {}); });
  await assert.rejects(transport.call("SendAgentMessage", {}, { target }), { code: "ls_target_mismatch" });
  await assert.rejects(transport.call("SendUserCascadeMessage", { cascadeId: "other" }, { target }), { code: "ls_target_mismatch" });
  assert.equal(calls.length, 0);
  const payload = { cascadeId: target.conversation_id, items: [{ text: "正文" }], clientMessageId: "original-request" };
  assert.deepEqual(await transport.call("SendUserCascadeMessage", payload, { target }), {});
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, payload);
});

test("submission tracking reports only the mutation and aborts before a delayed resolution can send", async () => {
  let reported = 0;
  let writes = 0;
  const controller = new AbortController();
  const transport = setup(async url => {
    if (url.endsWith("GetAllCascadeTrajectories")) return Response.json(summary);
    assert.equal(reported, 1);
    writes += 1;
    return Response.json({});
  });
  assert.equal(transport.submissionTracking, true);
  await transport.describe(target);
  assert.equal(reported, 0);
  await transport.call("SendUserCascadeMessage", { cascadeId: target.conversation_id }, { target, onRequestStarted() { reported += 1; } });
  assert.equal(writes, 1);
  transport.resolve = async () => { controller.abort(); return { endpoint: candidate }; };
  await assert.rejects(transport.call("SendUserCascadeMessage", { cascadeId: target.conversation_id }, { target, signal: controller.signal, onRequestStarted() { reported += 1; } }), error => error.requestSent === false);
  assert.equal(reported, 1);
  assert.equal(writes, 1);
  await transport.close();
});

test("步骤压缩排除thinking签名配置和凭据，只保留正文与原生身份", () => {
  const result = compactAntigravitySteps({ steps: [
    { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE", userInput: { items: [{ text: "第一段" }, { text: "第二段" }], clientMessageId: "request-original", apiKey: candidate.csrf }, metadata: { sourceTrajectoryStepInfo: { stepIndex: 6, cascadeId: "test-cascade", trajectoryId: "test-trajectory" } } },
    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE", plannerResponse: { response: "回复正文", messageId: "native-response", thinking: candidate.csrf, thinkingSignature: candidate.csrf }, secret: candidate.csrf },
  ] }, 6);
  assert.equal(result.steps[0].user_input.text, "第一段\n第二段");
  assert.equal(result.steps[0].user_input.client_message_id, "request-original");
  assert.equal(result.steps[1].index, 7);
  assert.equal(result.steps[1].assistant_response.text, "回复正文");
  assert.equal(JSON.stringify(result).includes(candidate.csrf), false);
  assert.equal(JSON.stringify(result).includes("thinking"), false);
});

test("真实步骤请求沿root并保留独立轨迹身份", async () => {
  const calls = [];
  const transport = setup(async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json(url.endsWith("GetAllCascadeTrajectories") ? summary : { steps: [{ type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE", plannerResponse: { response: "ok", messageId: "response-id" } }] }); });
  const result = await transport.readSteps(target, { stepOffset: 12 });
  assert.deepEqual(calls[1], { cascadeId: target.conversation_id, stepOffset: 12 });
  assert.equal(result.steps[0].index, 12);
});

test("带后续工具调用的 STOP_PATTERN 口播不能作为最终回信", () => {
  const base = { response: "synthetic visible text", stopReason: "STOP_REASON_STOP_PATTERN" };
  const result = compactAntigravitySteps({ steps: [
    { plannerResponse: { ...base, toolCalls: [{ function: "synthetic tool" }] } },
    { plannerResponse: { ...base, toolCalls: [] } },
    { plannerResponse: base },
    { plannerResponse: { ...base, toolCalls: {} } },
  ] });
  assert.deepEqual(result.steps.map(step => step.assistant_response.final), [false, true, true, false]);
  assert.equal(result.steps[0].assistant_response.has_tool_calls, true);
});

test("protobuf省略空repeated步骤时按真实空页处理，异常形状仍拒绝", () => {
  assert.deepEqual(compactAntigravitySteps({}, 30), { steps: [] });
  for (const body of [{ steps: null }, { steps: {} }, { error: "invalid" }, null]) {
    assert.throws(() => compactAntigravitySteps(body), { code: "ls_invalid_steps" });
  }
});

test("非JSON、超预算和HTTP错误均不回显外部诊断", async () => {
  for (const response of [new Response(candidate.csrf, { status: 500 }), new Response(candidate.csrf), new Response("x".repeat(1200))]) {
    const transport = setup(async () => response, { maxResponseBytes: 1024 });
    await assert.rejects(transport.request({ ...candidate, port: 12345 }, "GetAllCascadeTrajectories", {}), error => {
      assert.equal(error.message.includes(candidate.csrf), false);
      return true;
    });
  }
});

test("关闭后不再读取或发送", async () => {
  const transport = setup(async () => Response.json(summary));
  await transport.close();
  await assert.rejects(transport.request({ ...candidate, port: 12345 }, "GetAllCascadeTrajectories", {}), { code: "ls_method_rejected" });
});

test("第二次只读定位失败明确尚未发送，未知HTTP结果继续保持未知", async () => {
  const client = setup(async () => { throw new Error("read unavailable"); });
  await assert.rejects(client.call("SendUserCascadeMessage", { cascadeId: target.conversation_id }, { target }), error => error.requestSent === false);
  const uncertain = setup(async url => { if (url.endsWith("GetAllCascadeTrajectories")) return Response.json(summary); throw new Error("write result unavailable"); });
  await assert.rejects(uncertain.call("SendUserCascadeMessage", { cascadeId: target.conversation_id }, { target }), error => error.requestSent !== false);
});
