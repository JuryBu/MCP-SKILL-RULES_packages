import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";
import { identityKey } from "../src/contracts.mjs";

const target = {
  machine_id: "isolated-machine", host: "antigravity", surface: "desktop", conversation_id: "root-cascade",
  binding_id: "isolated-binding", binding_generation: 2,
};

function makeInput() {
  return {
    target: structuredClone(target),
    delivery: { delivery_id: "original-delivery" },
    message: {
      message_id: "original-message",
      envelope: {
        caller: { machine_id: "source-machine", host: "codex", surface: "desktop", conversation_id: "source-conversation" },
        origin: { kind: "agent_message", channel: "host_mcp", source_ref: "source-event" },
        text: "请继续原来的工作并核对材料",
        attachment_refs: [],
        delivery_policy: "next_model_boundary",
      },
    },
  };
}

function stableMarker(input = makeInput()) {
  return `[COMMUNICATION_CORE message_id=${input.message.message_id} delivery_id=${input.delivery.delivery_id}]`;
}

function userStep(index, overrides = {}) {
  return {
    index, type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE",
    user_input: { text: "original text", client_message_id: "original-delivery" },
    ...overrides,
  };
}

function replyStep(index, overrides = {}) {
  return {
    index, type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE",
    assistant_response: { text: "材料已核对，继续原来的工作", message_id: "native-reply", final: true },
    ...overrides,
  };
}

function fixture({ description = {}, steps = [], callResult = {}, describeError, callError, readError, onDescribe, onCall } = {}) {
  const invocations = [];
  const adapter = new AntigravityDeliveryAdapter({ transport: {
    async describe(actualTarget, options) {
      invocations.push({ method: "describe", target: actualTarget, options });
      onDescribe?.();
      if (describeError) throw describeError;
      return { cascade_id: "root-cascade", trajectory_id: "distinct-trajectory", status: "idle", step_count: steps.length, ...description };
    },
    async call(method, payload, options) {
      invocations.push({ method, payload, options });
      onCall?.();
      if (callError) throw callError;
      return callResult;
    },
    async readSteps(actualTarget, options) {
      invocations.push({ method: "readSteps", target: actualTarget, options });
      if (readError) throw readError;
      return { steps };
    },
  } });
  return { adapter, invocations };
}

async function renderedInput() {
  const { adapter, invocations } = fixture();
  await adapter.deliver(makeInput());
  return invocations.find(invocation => invocation.method === "SendUserCascadeMessage").payload.items[0].text;
}

function assertReceipt(receipt, outcome, input = makeInput()) {
  assert.equal(receipt.outcome, outcome);
  assert.equal(receipt.delivery_id, input.delivery.delivery_id);
  assert.equal(receipt.target_key, identityKey(input.target));
  for (const field of ["model_observed", "model_done", "ui_visible", "business_done", "processing", "raw", "thinking", "metadata"]) {
    assert.equal(Object.hasOwn(receipt, field), false);
  }
}

test("constructor requires only the explicit describe/call/readSteps transport contract", () => {
  assert.throws(() => new AntigravityDeliveryAdapter(), TypeError);
  for (const missing of ["describe", "call", "readSteps"]) {
    const transport = { describe() {}, call() {}, readSteps() {} };
    delete transport[missing];
    assert.throws(() => new AntigravityDeliveryAdapter({ transport }), TypeError);
  }
});

test("delivery describes first and submits only the exact payload with authentic source before body", async () => {
  const input = makeInput();
  const controller = new AbortController();
  input.signal = controller.signal;
  input.message.envelope.metadata = { credentials: "private-secret" };
  input.message.envelope.model = "must-not-override";
  input.message.envelope.mode = "must-not-override";
  const { adapter, invocations } = fixture({ callResult: { model_observed: true, ui_visible: true, business_done: true, metadata: "private-secret" } });
  const receipt = await adapter.deliver(input);
  assertReceipt(receipt, "accepted", input);
  assert.deepEqual(receipt.evidence, { kind: "transport" });
  assert.deepEqual(invocations.map(invocation => invocation.method), ["describe", "SendUserCascadeMessage"]);
  assert.equal(invocations[0].target, input.target);
  assert.equal(invocations[0].options.signal, controller.signal);
  const submitted = invocations[1];
  const rendered = submitted.payload.items[0].text;
  assert.deepEqual(submitted.payload, {
    cascadeId: "root-cascade", items: [{ text: rendered }], clientMessageId: "original-delivery",
    deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION", blocking: false,
  });
  assert.deepEqual(submitted.options, { target: input.target, signal: controller.signal });
  assert.match(rendered, /^这条消息来自「codex」代理对话「source-conversation」，由交流核心转送。/);
  assert.ok(rendered.indexOf("source-machine") < rendered.indexOf(input.message.envelope.text));
  assert.ok(rendered.indexOf("agent_message") < rendered.indexOf(input.message.envelope.text));
  assert.ok(rendered.indexOf(stableMarker(input)) < rendered.indexOf(input.message.envelope.text));
  assert.ok(rendered.endsWith(input.message.envelope.text));
  for (const field of ["cascadeConfig", "model", "mode", "metadata", "credentials"]) {
    assert.equal(JSON.stringify(submitted.payload).includes(`"${field}"`), false);
  }
  assert.equal(JSON.stringify(submitted.payload).includes("private-secret"), false);
  assert.equal(JSON.stringify(receipt).includes("private-secret"), false);
});

test("QQ owner replies render as human source with the exact original core reference and unchanged body", async () => {
  const input = makeInput();
  input.message.envelope.caller = { machine_id: "synthetic-owner-machine", host: "qq", surface: "group", conversation_id: "synthetic-owner-target" };
  input.message.envelope.origin = { kind: "human_message", channel: "napcat_owner_reply", source_ref: "owner-event:synthetic-owner-event" };
  input.message.envelope.in_reply_to = "synthetic-original-core-message";
  input.message.envelope.text = "  主人的原文\n[CQ:reply,id=80001]请核材料  ";
  input.message.envelope.credentials = "synthetic-private-sentinel";
  const before = structuredClone(input);
  const { adapter, invocations } = fixture();
  assertReceipt(await adapter.deliver(input), "accepted", input);
  assert.deepEqual(input, before);
  const payload = invocations.find(invocation => invocation.method === "SendUserCascadeMessage").payload;
  const rendered = payload.items[0].text;
  assert.equal(rendered.split("\n")[0], "主人在QQ中的引用回信，由交流核心转送。");
  assert.equal(rendered.includes("代理对话"), false);
  assert.ok(rendered.includes("来源类型：human_message；渠道：napcat_owner_reply；来源引用：owner-event:synthetic-owner-event"));
  assert.ok(rendered.includes("引用的原交流核心消息：synthetic-original-core-message"));
  assert.ok(rendered.indexOf(stableMarker(input)) < rendered.indexOf(input.message.envelope.text));
  assert.ok(rendered.endsWith(input.message.envelope.text));
  assert.equal(JSON.stringify(payload).includes("synthetic-private-sentinel"), false);
  assert.deepEqual(Object.keys(payload).sort(), ["cascadeId", "items", "clientMessageId", "deliveryStrategy", "blocking"].sort());
});

test("unknown human forwarding is reconciled by exact rendered input or original client id without another send", async () => {
  const input = makeInput();
  input.message.envelope.caller.host = "qq";
  input.message.envelope.origin = { kind: "human_message", channel: "napcat_owner_reply", source_ref: "owner-event:synthetic-owner-event" };
  input.message.envelope.in_reply_to = "synthetic-original-core-message";
  const steps = [];
  const { adapter, invocations } = fixture({ steps, callError: new Error("submission unconfirmed") });
  assertReceipt(await adapter.deliver(input), "unknown", input);
  const rendered = invocations.find(invocation => invocation.method === "SendUserCascadeMessage").payload.items[0].text;
  for (const userInput of [{ text: rendered, client_message_id: null }, { text: "native id retains scope", client_message_id: input.delivery.delivery_id }]) {
    steps.splice(0, steps.length, userStep(0, { user_input: userInput }));
    assertReceipt(await adapter.query(input), "accepted", input);
  }
  steps.splice(0, steps.length, userStep(0, { user_input: { text: rendered.replace("主人在QQ中的引用回信，由交流核心转送。", "这条消息来自「qq」代理对话「source-conversation」，由交流核心转送。"), client_message_id: null } }));
  assertReceipt(await adapter.query(input), "unknown", input);
  assert.equal(invocations.filter(invocation => invocation.method === "SendUserCascadeMessage").length, 1);
});

test("unsupported or incomplete human source contracts never render as an agent or submit", async () => {
  for (const change of [
    input => { input.message.envelope.caller.host = "codex"; },
    input => { input.message.envelope.origin.channel = "host_mcp"; },
    input => { delete input.message.envelope.in_reply_to; },
    input => { input.message.envelope.origin.kind = "system_message"; },
  ]) {
    const input = makeInput();
    input.message.envelope.caller.host = "qq";
    input.message.envelope.origin = { kind: "human_message", channel: "napcat_owner_reply", source_ref: "owner-event:synthetic-owner-event" };
    input.message.envelope.in_reply_to = "synthetic-original-core-message";
    change(input);
    const { adapter, invocations } = fixture();
    const receipt = await adapter.deliver(input);
    assertReceipt(receipt, "failed_before_send", input);
    assert.equal(receipt.reason, "invalid_message");
    assert.equal(invocations.some(invocation => invocation.method === "SendUserCascadeMessage"), false);
  }
});

test("empty JSON object confirms only host acceptance", async () => {
  const { adapter } = fixture();
  assert.deepEqual(await adapter.deliver(makeInput()), {
    delivery_id: "original-delivery", target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" },
  });
});

test("when_idle explicitly selects WHEN_IDLE without consulting idle/running status", async () => {
  const input = makeInput();
  input.message.envelope.delivery_policy = "when_idle";
  const { adapter, invocations } = fixture({ description: { status: "running" } });
  assertReceipt(await adapter.deliver(input), "accepted", input);
  assert.equal(invocations[1].payload.deliveryStrategy, "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE");
});

test("missing or wrong root cannot be replaced by a matching trajectory and is never sent", async () => {
  for (const cascadeId of ["other-root", "distinct-trajectory", undefined, null]) {
    const { adapter, invocations } = fixture({ description: { cascade_id: cascadeId, trajectory_id: "root-cascade" } });
    assertReceipt(await adapter.deliver(makeInput()), "failed_before_send");
    assert.deepEqual(invocations.map(invocation => invocation.method), ["describe"]);
  }
});

test("preflight failures remain safely retryable while submission exceptions stay unknown", async () => {
  for (const errors of [{ describeError: new Error("private-secret") }, { callError: new Error("private-secret") }]) {
    const { adapter, invocations } = fixture(errors);
    const receipt = await adapter.deliver(makeInput());
    assertReceipt(receipt, errors.describeError ? "busy" : "unknown");
    if (errors.describeError) assert.equal(receipt.evidence.retry_after_ms, 1000);
    assert.equal(JSON.stringify(receipt).includes("private-secret"), false);
    assert.ok(invocations.filter(invocation => invocation.method === "SendUserCascadeMessage").length <= 1);
  }
});

test("missing or non-object RPC results remain unknown", async () => {
  for (const callResult of [undefined, null, false, 0, "", []]) {
    const { adapter, invocations } = fixture({ callResult: null });
    adapter.transport.call = async () => { invocations.push({ method: "SendUserCascadeMessage" }); return callResult; };
    assertReceipt(await adapter.deliver(makeInput()), "unknown");
    assert.equal(invocations.filter(invocation => invocation.method === "SendUserCascadeMessage").length, 1);
  }
});

test("known pre-send abort prevents sending and cancellation after invocation remains unknown", async () => {
  const before = new AbortController();
  before.abort();
  const abortedInput = { ...makeInput(), signal: before.signal };
  const first = fixture();
  assertReceipt(await first.adapter.deliver(abortedInput), "failed_before_send", abortedInput);
  assert.equal(first.invocations.length, 0);
  const duringDescribe = new AbortController();
  const second = fixture({ onDescribe: () => duringDescribe.abort() });
  assertReceipt(await second.adapter.deliver({ ...makeInput(), signal: duringDescribe.signal }), "failed_before_send");
  assert.deepEqual(second.invocations.map(invocation => invocation.method), ["describe"]);
  const duringCall = new AbortController();
  const third = fixture({ onCall: () => duringCall.abort(), callError: new Error("cancelled") });
  assertReceipt(await third.adapter.deliver({ ...makeInput(), signal: duringCall.signal }), "unknown");
});

test("unsupported policy or malformed message fails before the send RPC", async () => {
  for (const mutate of [
    input => { input.message.envelope.delivery_policy = "toString"; },
    input => { input.message.envelope.text = ""; },
    input => { input.message.envelope.caller = null; },
    input => { input.message.message_id = "bad id]"; },
  ]) {
    const input = makeInput();
    mutate(input);
    const { adapter, invocations } = fixture();
    assertReceipt(await adapter.deliver(input), "failed_before_send", input);
    assert.deepEqual(invocations.map(invocation => invocation.method), ["describe"]);
  }
});

test("unmapped attachments fail before sending and preserve the original message", async () => {
  const input = makeInput();
  input.message.envelope.attachment_refs = ["original-attachment-reference"];
  const original = structuredClone(input);
  const { adapter, invocations } = fixture();
  const receipt = await adapter.deliver(input);
  assertReceipt(receipt, "failed_before_send", input);
  assert.equal(receipt.error.code, "unsupported");
  assert.equal(receipt.reason, "attachment_mapping_unsupported");
  assert.deepEqual(input, original);
  assert.deepEqual(invocations.map(invocation => invocation.method), ["describe"]);
});

test("query matches the exact original client ID or complete originally rendered input and never sends", async () => {
  const originalText = await renderedInput();
  for (const userInput of [
    { text: "text without marker", client_message_id: "original-delivery" },
    { text: originalText, client_message_id: null },
  ]) {
    const { adapter, invocations } = fixture({ steps: [userStep(0, { user_input: userInput })] });
    const receipt = await adapter.query(makeInput());
    assertReceipt(receipt, "accepted");
    assert.deepEqual(receipt.evidence, { kind: "query" });
    assert.deepEqual(invocations.map(invocation => invocation.method), ["describe", "readSteps"]);
  }
});

test("unknown submit is reconciled with the same delivery ID by reads only", async () => {
  const steps = [];
  const input = makeInput();
  const { adapter, invocations } = fixture({ steps, callError: new Error("accepted then disconnected") });
  assertReceipt(await adapter.deliver(input), "unknown", input);
  steps.push(userStep(0));
  assertReceipt(await adapter.query(input), "accepted", input);
  assert.equal(invocations.filter(invocation => invocation.method === "SendUserCascadeMessage").length, 1);
  assert.equal(invocations.find(invocation => invocation.payload)?.payload.clientMessageId, "original-delivery");
});

test("query rejects wrong IDs, partial markers, wrong-message markers and assistant echoes", async () => {
  const invalidSteps = [
    userStep(0, { user_input: { client_message_id: "original-delivery-extra", text: "same body" } }),
    userStep(1, { user_input: { text: "[COMMUNICATION_CORE message_id=original-message delivery_id=original-delivery", client_message_id: null } }),
    userStep(2, { user_input: { text: "[COMMUNICATION_CORE message_id=wrong-message delivery_id=original-delivery]", client_message_id: null } }),
    userStep(3, { user_input: { text: "[COMMUNICATION_CORE message_id=original-message delivery_id=original-delivery-extra]", client_message_id: null } }),
    replyStep(4, { assistant_response: { text: stableMarker(), message_id: "echo" } }),
  ];
  const { adapter, invocations } = fixture({ steps: invalidSteps });
  assertReceipt(await adapter.query(makeInput()), "unknown");
  assert.equal(invocations.some(invocation => invocation.method === "SendUserCascadeMessage"), false);
});

test("query and reply observation preserve signal and bound reads to the latest 500 steps", async () => {
  const input = { ...makeInput(), signal: new AbortController().signal };
  const steps = Array.from({ length: 501 }, (_, position) => ({ index: 700 + position, type: "tool", status: "DONE" }));
  steps[0] = userStep(700);
  const { adapter, invocations } = fixture({ description: { step_count: 1200 }, steps });
  assertReceipt(await adapter.query(input), "unknown", input);
  assert.equal(await adapter.observeReply(input), null);
  const reads = invocations.filter(invocation => invocation.method === "readSteps");
  assert.equal(reads.length, 2);
  for (const read of reads) assert.deepEqual(read.options, { stepOffset: 700, signal: input.signal });
  const within = fixture({ description: { step_count: 1200 }, steps: [userStep(1198), replyStep(1199)] });
  assertReceipt(await within.adapter.query(input), "accepted", input);
  assert.equal((await within.adapter.observeReply(input)).source_step_index, 1199);
});

test("read-only lookup mismatch, invalid count, missing steps or exceptions never confirm delivery", async () => {
  const variants = [
    { description: { cascade_id: "other-root" } },
    { description: { step_count: -1 } },
    { description: { step_count: "2" } },
    { describeError: new Error("private-secret") },
    { readError: new Error("private-secret") },
  ];
  for (const variant of variants) {
    const { adapter, invocations } = fixture({ steps: [userStep(0), replyStep(1)], ...variant });
    assertReceipt(await adapter.query(makeInput()), "unknown");
    assert.equal(await adapter.observeReply(makeInput()), null);
    assert.equal(invocations.some(invocation => invocation.method === "SendUserCascadeMessage"), false);
  }
  const { adapter } = fixture();
  adapter.transport.readSteps = async () => ({});
  assertReceipt(await adapter.query(makeInput()), "unknown");
  assert.equal(await adapter.observeReply(makeInput()), null);
});

test("reply observation returns only the DONE planner reply after the original input", async () => {
  const steps = [replyStep(3, { assistant_response: { text: "older reply", message_id: "older" } }), userStep(4), replyStep(5)];
  const { adapter, invocations } = fixture({ steps });
  assert.deepEqual(await adapter.observeReply(makeInput()), {
    native_message_id: "native-reply", text: "材料已核对，继续原来的工作", source_step_index: 5,
    cascade_id: "root-cascade", trajectory_id: "distinct-trajectory",
  });
  assert.deepEqual(invocations.map(invocation => invocation.method), ["describe", "readSteps"]);
});

test("reply observation also accepts normalized types and the exact originally rendered input", async () => {
  const originalText = await renderedInput();
  const steps = [
    userStep(0, { type: "user_input", user_input: { text: originalText, client_message_id: null } }),
    replyStep(1, { type: "planner_response", status: "DONE" }),
  ];
  const { adapter } = fixture({ steps });
  assert.equal((await adapter.observeReply(makeInput())).native_message_id, "native-reply");
});

test("the next input ends reply ownership even when blank, unfinished or carrying an unexpected type", async () => {
  for (const boundary of [
    userStep(1, { user_input: { text: "concurrent input", client_message_id: "other-delivery" } }),
    userStep(1, { status: "RUNNING", user_input: { text: "", client_message_id: null } }),
    { index: 1, type: "unexpected", status: "DONE", user_input: null },
    { index: 1, type: "user_input", status: "RUNNING" },
  ]) {
    const { adapter } = fixture({ steps: [userStep(0), boundary, replyStep(2)] });
    assert.equal(await adapter.observeReply(makeInput()), null);
  }
});

test("a reply before the next user input belongs to the original rather than the later reply", async () => {
  const { adapter } = fixture({ steps: [
    userStep(0), replyStep(1), userStep(2, { user_input: { text: "other", client_message_id: "other-delivery" } }),
    replyStep(3, { assistant_response: { text: "later reply", message_id: "later" } }),
  ] });
  assert.equal((await adapter.observeReply(makeInput())).native_message_id, "native-reply");
});

test("unfinished, empty or non-planner outputs cannot serve as a reply", async () => {
  for (const response of [
    replyStep(1, { status: "CORTEX_STEP_STATUS_RUNNING" }),
    replyStep(1, { status: "NOT_DONE" }),
    replyStep(1, { assistant_response: { text: " \n ", message_id: "empty" } }),
    replyStep(1, { type: "tool_response" }),
    replyStep(1, { type: "thinking" }),
  ]) {
    const { adapter } = fixture({ steps: [userStep(0), response] });
    assert.equal(await adapter.observeReply(makeInput()), null);
  }
});

test("wrong markers or duplicate original inputs leave reply attribution unresolved", async () => {
  for (const steps of [
    [userStep(0, { user_input: { text: "[COMMUNICATION_CORE message_id=wrong delivery_id=original-delivery]", client_message_id: "wrong" } }), replyStep(1)],
    [userStep(0), replyStep(1), userStep(2), replyStep(3)],
  ]) {
    assert.equal(await fixture({ steps }).adapter.observeReply(makeInput()), null);
  }
});

test("missing, duplicated or reordered step indexes cannot hide a concurrent input boundary", async () => {
  for (const responseIndex of [2, 0, -1, undefined, "1"]) {
    assert.equal(await fixture({ steps: [userStep(0), replyStep(responseIndex)] }).adapter.observeReply(makeInput()), null);
  }
});

test("missing trajectory identity or native message ID prevents reply attribution", async () => {
  const steps = [userStep(0), replyStep(1)];
  assert.equal(await fixture({ steps, description: { trajectory_id: null } }).adapter.observeReply(makeInput()), null);
  for (const messageId of [undefined, null, "", " \n ", 1]) {
    const missingIdSteps = [userStep(0), replyStep(1, { assistant_response: { text: "reply", message_id: messageId } })];
    assert.equal(await fixture({ steps: missingIdSteps }).adapter.observeReply(makeInput()), null);
  }
});

test("explicit native cascade and trajectory identities on both input and reply must match describe", async () => {
  const nativeIdentity = { cascade_id: "root-cascade", trajectory_id: "distinct-trajectory" };
  const steps = [userStep(0, nativeIdentity), replyStep(1, nativeIdentity)];
  const observed = await fixture({ steps }).adapter.observeReply(makeInput());
  assert.equal(observed.native_message_id, "native-reply");
  assert.equal(observed.cascade_id, "root-cascade");
  assert.equal(observed.trajectory_id, "distinct-trajectory");
});

test("mismatched native input identity rejects replies even when original client ID and marker match", async () => {
  for (const field of ["cascade_id", "trajectory_id"]) {
    for (const invalidIdentity of ["other-native-id", "", null, undefined]) {
      const steps = [
        userStep(0, { [field]: invalidIdentity, user_input: { client_message_id: "original-delivery", text: stableMarker() } }),
        replyStep(1, { cascade_id: "root-cascade", trajectory_id: "distinct-trajectory" }),
      ];
      assert.equal(await fixture({ steps }).adapter.observeReply(makeInput()), null, `${field}=${invalidIdentity}`);
    }
  }
});

test("mismatched native reply identity rejects a completed response to a correctly scoped input", async () => {
  for (const field of ["cascade_id", "trajectory_id"]) {
    for (const invalidIdentity of ["other-native-id", "", null, undefined]) {
      const steps = [
        userStep(0, { cascade_id: "root-cascade", trajectory_id: "distinct-trajectory" }),
        replyStep(1, { [field]: invalidIdentity }),
        replyStep(2),
      ];
      assert.equal(await fixture({ steps }).adapter.observeReply(makeInput()), null, `${field}=${invalidIdentity}`);
    }
  }
});

test("root and trajectory identities cannot be interchanged and omitted native fields remain compatible", async () => {
  const swappedIdentity = { cascade_id: "distinct-trajectory", trajectory_id: "root-cascade" };
  for (const steps of [[userStep(0, swappedIdentity), replyStep(1)], [userStep(0), replyStep(1, swappedIdentity)]]) {
    assert.equal(await fixture({ steps }).adapter.observeReply(makeInput()), null);
  }
  for (const nativeIdentity of [{}, { cascade_id: "root-cascade" }, { trajectory_id: "distinct-trajectory" }]) {
    const observed = await fixture({ steps: [userStep(0, nativeIdentity), replyStep(1, nativeIdentity)] }).adapter.observeReply(makeInput());
    assert.equal(observed.native_message_id, "native-reply");
  }
});

test("query and observation never read thinking/raw fields or turn host acceptance into completion", async () => {
  const steps = [userStep(0), replyStep(1)];
  for (const step of steps) {
    for (const field of ["thinking", "raw"]) {
      Object.defineProperty(step, field, { get() { throw new Error("forbidden content read"); } });
    }
  }
  Object.defineProperty(steps[1].assistant_response, "thinking", { get() { throw new Error("forbidden thinking read"); } });
  const { adapter, invocations } = fixture({ steps });
  assertReceipt(await adapter.query(makeInput()), "accepted");
  assert.equal((await adapter.observeReply(makeInput())).native_message_id, "native-reply");
  assert.equal(invocations.some(invocation => invocation.method === "SendUserCascadeMessage"), false);
});
