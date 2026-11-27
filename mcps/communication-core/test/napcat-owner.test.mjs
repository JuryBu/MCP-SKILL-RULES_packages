import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { NapcatMcpTransport } from "../src/transports/napcat-mcp.mjs";
import { createOwnerSourceTitleReader, NapcatOwnerAdapter } from "../src/adapters/napcat-owner.mjs";

const endpoint = "http://127.0.0.1:14588/napcat/mcp";
const secret = "Bearer fixture-credential-not-for-output";
const alert = { route_key: "test-route", dedupe_key: "test-dedupe", summary: "替身测试摘要", reply_hint: "引用本条回复" };
let networkAttempts = 0;
const originalFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("替身测试禁止网络请求");
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0);
});

function input() {
  return {
    target: { machine_id: "test-machine", host: "qq", surface: "group", conversation_id: "configured-test-target", binding_id: "qq-binding", binding_generation: 1 },
    delivery: { delivery_id: "test-delivery", attempt_count: 1 },
    message: {
      message_id: "test-message",
      envelope: {
        caller: { machine_id: "test-machine", host: "antigravity", surface: "desktop", conversation_id: "test-source" },
        origin: { kind: "agent_message", channel: "host_mcp", source_ref: "test-event" },
        text: "这是来自真实来源标识的替身里程碑",
        attachment_refs: [],
      },
    },
  };
}

function sent(overrides = {}) {
  return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: input().target.conversation_id }, messageId: "123456", ...overrides };
}

function adapterFixture(overrides = {}, adapterOptions = {}) {
  const calls = { status: [], send: [], closed: 0 };
  const transport = {
    async status(options) { calls.status.push(options); return { ok: true, ready: true }; },
    async sendOwnerAlert(request, options) { calls.send.push({ request, options }); return sent(); },
    async close() { calls.closed += 1; },
    ...overrides,
  };
  const adapter = new NapcatOwnerAdapter({ transport, routeKey: "test-route", replyHint: "引用本条回复", ...adapterOptions });
  return { adapter, transport, calls };
}

function sdkFixture(context, { baseUrl = endpoint, connect, callTool, close } = {}) {
  const calls = { factories: 0, connect: [], tools: [], closed: 0 };
  const client = {
    async connect(transport, options) {
      calls.connect.push({ transport, options });
      return connect?.(transport, options);
    },
    async callTool(params, schema, options) {
      calls.tools.push({ params, schema, options });
      return callTool ? callTool(params, schema, options) : { structuredContent: { ok: true, ready: true } };
    },
    async close() { calls.closed += 1; return close?.(); },
  };
  const transport = new NapcatMcpTransport({ baseUrl, conversationId: "test-source-cid", clientFactory() { calls.factories += 1; return client; } });
  context.after(() => transport.close());
  return { transport, calls };
}

function matchesIdentity(result, original) {
  assert.equal(result.delivery_id, original.delivery.delivery_id);
  assert.equal(result.target_key, identityKey(original.target));
  assert.equal(result.evidence.kind, result.outcome === "accepted" ? "receipt" : "transport");
  assert.ok(Number.isFinite(Date.parse(result.evidence.observed_at)));
}

test("submission tracking reports the owner alert after connection, never the status read", async context => {
  let reported = 0;
  const { transport, calls } = sdkFixture(context, { callTool: async params => {
    assert.equal(reported, params.name === "napcat_owner_alert" ? 1 : 0);
    return { structuredContent: { ok: true, ready: true } };
  } });
  assert.equal(transport.submissionTracking, true);
  await transport.status();
  await transport.sendOwnerAlert(alert, { onRequestStarted() { reported += 1; } });
  assert.equal(reported, 1);
  assert.equal(calls.tools.length, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.sendOwnerAlert(alert, { signal: controller.signal, onRequestStarted() { reported += 1; } }));
  assert.equal(reported, 1);
  assert.equal(calls.tools.length, 2);
});

test("submission tracking cannot cross an aborted initial connection", async context => {
  const controller = new AbortController();
  const { transport, calls } = sdkFixture(context, { connect: async () => { controller.abort(); } });
  let reported = 0;
  await assert.rejects(transport.sendOwnerAlert(alert, { signal: controller.signal, onRequestStarted() { reported += 1; } }));
  assert.equal(reported, 0);
  assert.equal(calls.tools.length, 0);
});

test("owner delivery preserves agent source, fixed dedupe, exact identity and signal", async () => {
  const { adapter, calls } = adapterFixture();
  const original = input();
  original.signal = new AbortController().signal;
  const result = await adapter.deliver(original);
  assert.equal(result.outcome, "accepted");
  matchesIdentity(result, original);
  assert.deepEqual(calls.send[0].request, {
    route_key: "test-route",
    dedupe_key: "communication-core:test-delivery",
    summary: `交流核心转送 / 来源Antigravity对话：\n${original.message.envelope.text}`,
    reply_hint: "引用本条回复",
  });
  assert.equal(calls.status[0].signal, original.signal);
  assert.equal(calls.send[0].options.signal, original.signal);
  assert.equal(result.processing_status, undefined);
  assert.equal(result.model_observed, undefined);
  assert.deepEqual(result.evidence.native_receipt, { provider: "napcat_owner", message_id: "123456", verified: true, state_persisted: true });
  assert.equal(typeof adapter.observeReply, "function");
  assert.equal(await adapter.observeReply(original), null);
  assert.equal(calls.status.length, 1);
  assert.equal(calls.send.length, 1);
});

test("the adapter forwards the actual host and can use the component default reply hint", async () => {
  const { transport, calls } = adapterFixture();
  const adapter = new NapcatOwnerAdapter({ transport, routeKey: "test-route" });
  const original = input();
  original.message.envelope.caller.host = "codex";
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  assert.ok(calls.send[0].request.summary.startsWith("交流核心转送 / 来源Codex对话："));
  assert.equal(Object.hasOwn(calls.send[0].request, "reply_hint"), false);
});

test("an authorized readable conversation name is used without changing body, route or dedupe", async () => {
  const original = input();
  const source = original.message.envelope.caller;
  original.message.principal_id = "fixture-bound-subject";
  original.message.envelope.source_title = "外部正文不能决定抬头";
  const readSourceTitle = createOwnerSourceTitleReader({
    localMachineId: source.machine_id,
    principals: [{ id: original.message.principal_id, identity: source, allowed_host_snapshots: [source] }],
    readers: new Map([[source.host, async (target, { signal }) => {
      assert.deepEqual(target, source);
      assert.equal(signal.aborted, false);
      return "  隔离维护窗口  ";
    }]]),
  });
  const { adapter, calls } = adapterFixture({}, { readSourceTitle });
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  assert.deepEqual(calls.send[0].request, {
    route_key: "test-route",
    dedupe_key: "communication-core:test-delivery",
    summary: "交流核心转送 / 来源「隔离维护窗口」：\n" + original.message.envelope.text,
    reply_hint: "引用本条回复",
  });
});

test("shared source scopes need existing read authority, and remote identities are never looked up locally", async () => {
  const original = input();
  const caller = original.message.envelope.caller;
  const { machine_id, host, surface, conversation_id } = caller;
  const scope = { machine_id, host, surface };
  let reads = 0;
  const principals = [
    { id: "exact-send-only", identity: caller },
    { id: "shared", identity: caller, caller_scope: scope },
    { id: "listed", identity: caller, caller_scope: scope, allowed_host_lists: [scope] },
    { id: "snapshot", identity: caller, caller_scope: scope, allowed_host_snapshots: [{ ...scope, conversation_id }] },
  ];
  const readSourceTitle = createOwnerSourceTitleReader({ localMachineId: machine_id, principals,
    readers: new Map([[host, () => { reads += 1; return "fixture"; }]]) });
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "exact-send-only" }), null);
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "shared" }), null);
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "listed" }), "fixture");
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "snapshot" }), "fixture");
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "listed", relay_inbound: {} }), null);
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "snapshot",
    envelope: { ...original.message.envelope, caller: { ...caller, conversation_id: "unauthorized" } } }), null);
  assert.equal(await readSourceTitle({ ...original.message, principal_id: "listed",
    envelope: { ...original.message.envelope, caller: { ...caller, machine_id: "remote" } } }), null);
  assert.equal(reads, 2);
});

test("missing, unsafe or too long titles fall back with the original body intact", async () => {
  for (const value of [null, "test-source", "换行\n伪造抬头", "隐藏方向\u202e", "[CQ:fixture,value=synthetic]", "长".repeat(129)]) {
    const { adapter, calls } = adapterFixture({}, { readSourceTitle: async () => value });
    const original = input();
    assert.equal((await adapter.deliver(original)).outcome, "accepted");
    assert.equal(calls.send[0].request.summary, "交流核心转送 / 来源Antigravity对话：\n" + original.message.envelope.text);
  }
  const prefix = "交流核心转送 / 来源Antigravity对话：\n";
  const original = input();
  original.message.envelope.text = "中".repeat(800 - prefix.length);
  const { adapter, calls } = adapterFixture({}, { readSourceTitle: async () => "较长的真实会话标题".repeat(8) });
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  assert.equal(calls.send[0].request.summary, prefix + original.message.envelope.text);
});

test("an unavailable optional title falls back, but cancellation never submits a QQ message", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const unavailable = adapterFixture({}, { readSourceTitle() { throw new Error(secret); } });
  assert.equal((await unavailable.adapter.deliver(input())).outcome, "accepted");
  const slow = adapterFixture({}, { readSourceTitle: () => new Promise(() => {}) });
  const pending = slow.adapter.deliver(input());
  await nextTurn();
  context.mock.timers.tick(1000);
  assert.equal((await pending).outcome, "accepted");
  assert.match(slow.calls.send[0].request.summary, /来源Antigravity对话：/u);

  const controller = new AbortController();
  const cancelled = adapterFixture({}, { readSourceTitle: () => new Promise(() => {}) });
  const pendingCancel = cancelled.adapter.deliver({ ...input(), signal: controller.signal });
  await nextTurn();
  controller.abort();
  assert.equal((await pendingCancel).outcome, "busy");
  assert.equal(cancelled.calls.send.length, 0);
});

const invalidInputs = [
  ["human origin", original => { original.message.envelope.origin.kind = "human_message"; }],
  ["missing origin", original => { delete original.message.envelope.origin; }],
  ["attachment", original => { original.message.envelope.attachment_refs = ["attachment-ref"]; }],
  ["invalid attachments", original => { original.message.envelope.attachment_refs = {}; }],
  ["missing text", original => { delete original.message.envelope.text; }],
  ["empty text", original => { original.message.envelope.text = " "; }],
  ["1001 Chinese characters", original => { original.message.envelope.text = "中".repeat(1001); }],
  ["1001 supplementary characters", original => { original.message.envelope.text = "𠮷".repeat(1001); }],
  ["wrong host", original => { original.target.host = "codex"; }],
  ["missing source", original => { delete original.message.envelope.caller; }],
  ["source header injection", original => { original.message.envelope.caller.host = "antigravity\n主人"; }],
  ["oversized delivery ID", original => { original.delivery.delivery_id = "d".repeat(182); }],
];
for (const [name, change] of invalidInputs) {
  test(`unsupported ${name} is rejected before status or mutation`, async () => {
    const { adapter, calls } = adapterFixture();
    const original = input();
    change(original);
    const result = await adapter.deliver(original);
    assert.equal(result.outcome, "failed_before_send");
    assert.equal(result.error.code, "unsupported");
    matchesIdentity(result, original);
    assert.equal(calls.status.length, 0);
    assert.equal(calls.send.length, 0);
  });
}

test("summary respects the existing 800-code-unit tool limit without truncation", async () => {
  const { adapter, calls } = adapterFixture();
  const original = input();
  const prefix = "交流核心转送 / 来源Antigravity对话：\n";
  original.message.envelope.text = "中".repeat(800 - prefix.length);
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  assert.equal(calls.send[0].request.summary.length, 800);
  original.message.envelope.text += "中";
  const refused = await adapter.deliver(original);
  assert.equal(refused.outcome, "failed_before_send");
  assert.equal(refused.reason, "owner_alert_summary_too_long");
  assert.equal(refused.error.code, "unsupported");
  assert.equal(calls.send.length, 1);
});

for (const status of [{ ready: false }, { online: true }, { ready: "true" }, { ok: false, ready: true }, null]) {
  test(`non-ready status ${JSON.stringify(status)} never sends`, async () => {
    const { adapter, calls } = adapterFixture({ async status() { return status; } });
    const result = await adapter.deliver(input());
    assert.equal(result.outcome, "busy");
    assert.equal(result.evidence.retry_after_ms, 1000);
    assert.equal(calls.send.length, 0);
  });
}

test("preflight errors stay busy with bounded exponential backoff and no external error", async () => {
  const { adapter, calls } = adapterFixture({ async status() { throw new Error(secret); } });
  for (const [attempt, delay] of [[0, 1000], [1, 1000], [2, 2000], [6, 32000], [7, 45000], [100, 45000]]) {
    const original = input();
    original.delivery.attempt_count = attempt;
    const result = await adapter.deliver(original);
    assert.equal(result.outcome, "busy");
    assert.equal(result.evidence.retry_after_ms, delay);
    assert.equal(JSON.stringify(result).includes(secret), false);
    matchesIdentity(result, original);
  }
  assert.equal(calls.send.length, 0);
});

test("abort before delivery or after status confirms no send occurred", async () => {
  const controller = new AbortController();
  const { adapter, calls } = adapterFixture({ async status() { controller.abort(secret); return { ready: true }; } });
  const original = input();
  original.signal = controller.signal;
  assert.equal((await adapter.deliver(original)).outcome, "busy");
  assert.equal(calls.send.length, 0);
  const alreadyAborted = adapterFixture();
  assert.equal((await alreadyAborted.adapter.deliver(original)).outcome, "busy");
  assert.equal(alreadyAborted.calls.status.length, 0);
});

test("a transport-confirmed pre-tool failure is busy; arbitrary send errors remain unknown", async () => {
  const confirmed = adapterFixture({ async sendOwnerAlert() { throw new CoreError("napcat_mcp_unconfirmed", "固定错误", { request_sent: false }); } });
  assert.equal((await confirmed.adapter.deliver(input())).outcome, "busy");
  const uncertain = adapterFixture({ async sendOwnerAlert() { throw Object.assign(new Error(secret), { request_sent: false }); } });
  const result = await uncertain.adapter.deliver(input());
  assert.equal(result.outcome, "unknown");
  assert.equal(result.evidence.retry_after_ms, undefined);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("disconnect after send remains unknown and recovery never replays the mutation", async () => {
  let mutations = 0;
  let statuses = 0;
  const { adapter } = adapterFixture({
    async status() { statuses += 1; return { ready: true }; },
    async sendOwnerAlert() { mutations += 1; throw new Error(secret); },
  });
  const original = input();
  assert.equal((await adapter.deliver(original)).outcome, "unknown");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await adapter.query(original);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.reason, "owner_alert_recovery_query_unsupported");
    matchesIdentity(result, original);
  }
  assert.equal(mutations, 1);
  assert.equal(statuses, 1);
});

test("query cannot upgrade even a previous accepted send or invent a QQ reply", async () => {
  const { adapter, calls } = adapterFixture();
  assert.equal((await adapter.deliver(input())).outcome, "accepted");
  const result = await adapter.query(input());
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason, "owner_alert_recovery_query_unsupported");
  assert.equal(calls.status.length, 1);
  assert.equal(calls.send.length, 1);
});

test("stable delivery dedupe survives attempts and accepts only fully verified deduped receipts", async () => {
  const requests = [];
  const { adapter } = adapterFixture({ async sendOwnerAlert(request) {
    requests.push(request);
    return sent(requests.length === 1 ? {} : { sent: false, deduped: true });
  } });
  const original = input();
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  original.delivery.attempt_count = 9;
  original.message.message_id = "another-message-id";
  assert.equal((await adapter.deliver(original)).outcome, "accepted");
  assert.equal(requests[0].dedupe_key, requests[1].dedupe_key);
  assert.equal(requests[1].dedupe_key, "communication-core:test-delivery");
});

const uncertainReceipts = [
  ["missing result", null],
  ["ok flag", sent({ ok: false })],
  ["no sent or deduped", sent({ sent: false })],
  ["truthy sent", sent({ sent: "true" })],
  ["unverified", sent({ verified: false })],
  ["unpersisted", sent({ statePersisted: false })],
  ["wrong target", sent({ target: { targetKey: "other-private-target" } })],
  ["missing target", sent({ target: null })],
  ["missing message ID", sent({ messageId: null })],
  ["blank message ID", sent({ messageId: " " })],
  ["object message ID", sent({ messageId: { token: secret } })],
  ["non-numeric message ID", sent({ messageId: secret })],
  ["zero message ID", sent({ messageId: "0" })],
  ["oversized message ID", sent({ messageId: "1".repeat(21) })],
  ["legacy incomplete suppression", { ok: true, sent: false, duplicateSuppressed: true, reason: "already_sent", existing: { messageId: "123456", verified: true } }],
];
for (const [name, response] of uncertainReceipts) {
  test(`uncertain ${name} receipt remains unknown with no retry hint`, async () => {
    const { adapter } = adapterFixture({ async sendOwnerAlert() { return response; } });
    const original = input();
    const result = await adapter.deliver(original);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.evidence.retry_after_ms, undefined);
    assert.equal(JSON.stringify(result).includes(secret), false);
    matchesIdentity(result, original);
  });
}

test("QQ send acceptance exposes no external body, login, target ID or processing claim", async () => {
  const { adapter } = adapterFixture({ async sendOwnerAlert() { return sent({ messageId: "-123456", body: secret, credentials: secret, identity: { token: secret }, target: { targetKey: input().target.conversation_id, id: secret } }); } });
  const result = await adapter.deliver(input());
  assert.equal(result.outcome, "accepted");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(Object.keys(result.evidence).sort(), ["kind", "native_receipt", "observed_at"]);
  assert.equal(result.evidence.native_receipt.message_id, "-123456");
  assert.equal(result.business_completed, undefined);
});

test("adapter close only closes its configured transport once and prevents further sends", async () => {
  const { adapter, calls } = adapterFixture();
  await adapter.close();
  await adapter.close();
  assert.equal(calls.closed, 1);
  assert.equal((await adapter.deliver(input())).outcome, "busy");
  assert.equal(calls.status.length, 0);
});

test("SDK client is lazy, reuses its own connection, and uses CID header rather than tool arguments", async context => {
  const { transport, calls } = sdkFixture(context);
  assert.equal(calls.factories, 0);
  assert.deepEqual(await transport.status(), { ok: true, ready: true });
  await transport.sendOwnerAlert({ ...alert, token: secret, target_key: "unapproved-extra" });
  assert.equal(calls.factories, 1);
  assert.equal(calls.connect.length, 1);
  const wire = calls.connect[0].transport;
  assert.ok(wire instanceof StreamableHTTPClientTransport);
  assert.equal(wire._url.href, endpoint);
  assert.deepEqual(wire._requestInit.headers, { "x-conversation-id": "test-source-cid" });
  assert.equal(wire._requestInit.redirect, "error");
  assert.equal(wire._reconnectionOptions.maxRetries, 0);
  assert.deepEqual(calls.tools.map(call => call.params), [
    { name: "napcat_status", arguments: { include_group: false } },
    { name: "napcat_owner_alert", arguments: alert },
  ]);
  for (const options of [calls.connect[0].options, ...calls.tools.map(call => call.options)]) {
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxTotalTimeout, 10000);
    assert.equal(options.resetTimeoutOnProgress, false);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(calls.tools[0].schema, undefined);
  assert.equal(typeof transport.call, "undefined");
  assert.equal(typeof transport.listTools, "undefined");
  await transport.close();
  await transport.close();
  assert.equal(calls.closed, 1);
  await assert.rejects(transport.status(), { code: "napcat_mcp_unconfirmed" });
  assert.equal(calls.tools.length, 2);
});

for (const baseUrl of ["http://127.0.0.1:23456/napcat/mcp", "http://localhost:23457/napcat/mcp", "http://127.0.0.2:23458/napcat/mcp", "http://[::1]:23459/napcat/mcp"]) {
  test(`configured loopback endpoint ${baseUrl} is retained per instance`, async context => {
    const { transport, calls } = sdkFixture(context, { baseUrl });
    await transport.status();
    assert.equal(calls.connect[0].transport._url.href, baseUrl);
  });
}

for (const baseUrl of [undefined, "https://localhost:23456/napcat/mcp", "http://example.com/napcat/mcp", "http://192.168.1.1/napcat/mcp", "http://[::ffff:127.0.0.1]/napcat/mcp", "http://localhost:23456/other", "http://localhost:23456/napcat/mcp/", "http://localhost:23456/napcat/mcp?token=fixture-secret", "http://localhost:23456/napcat/mcp#fixture-secret", "http://localhost:23456/napcat/mcp?", "http://localhost:23456/napcat/mcp#", "http://fixture-secret@localhost:23456/napcat/mcp"]) {
  test("invalid endpoint rejects without connecting or exposing its value", () => {
    let factories = 0;
    assert.throws(() => new NapcatMcpTransport({ baseUrl, conversationId: "test-cid", clientFactory() { factories += 1; } }), error => {
      assert.equal(error.code, "invalid_config");
      assert.equal(error.message, "NapCat MCP配置无效");
      assert.equal(error.message.includes("fixture-secret"), false);
      return true;
    });
    assert.equal(factories, 0);
  });
}

test("transport construction and unused close perform no client or network work", async () => {
  let factories = 0;
  const transport = new NapcatMcpTransport({ baseUrl: endpoint, conversationId: "test-cid", clientFactory() { factories += 1; throw new Error(secret); } });
  await transport.close();
  assert.equal(factories, 0);
});

test("missing CID and header control characters reject before creating the SDK client", () => {
  for (const conversationId of [undefined, "", " ", "cid\r\nAuthorization: secret", "cid\u0000value"]) {
    assert.throws(() => new NapcatMcpTransport({ baseUrl: endpoint, conversationId }), { code: "invalid_config" });
  }
});

test("SDK structured content has priority; a sole JSON text block is the only fallback", async context => {
  const responses = [
    { structuredContent: { ready: true }, content: [{ type: "text", text: secret }] },
    { content: [{ type: "text", text: JSON.stringify({ ready: false }) }] },
  ];
  const { transport } = sdkFixture(context, { async callTool() { return responses.shift(); } });
  assert.deepEqual(await transport.status(), { ready: true });
  assert.deepEqual(await transport.status(), { ready: false });
});

for (const response of [null, { isError: true, structuredContent: { ready: true }, content: [{ type: "text", text: secret }] }, { structuredContent: null }, { structuredContent: [] }, { content: [] }, { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }, { content: [{ type: "image", data: secret }] }, { content: [{ type: "text", text: secret }] }, { content: [{ type: "text", text: "null" }] }, { content: [{ type: "text", text: "[]" }] }]) {
  test("invalid SDK response produces only a fixed sanitized error", async context => {
    const { transport } = sdkFixture(context, { async callTool() { return response; } });
    await assert.rejects(transport.status(), error => {
      assert.equal(error.code, "napcat_mcp_unconfirmed");
      assert.equal(error.message, "NapCat MCP尚未取得可核对结果");
      assert.deepEqual(error.details, { request_sent: true });
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  });
}

test("SDK initialization failure is definitely before tool submission and closes its client", async context => {
  const { transport, calls } = sdkFixture(context, { async connect() { throw new Error(secret); } });
  await assert.rejects(transport.sendOwnerAlert(alert), error => {
    assert.deepEqual(error.details, { request_sent: false });
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await transport.close();
  assert.equal(calls.tools.length, 0);
  assert.equal(calls.closed, 1);
});

test("SDK submission failures never leak raw server or cleanup errors", async context => {
  const { transport, calls } = sdkFixture(context, { async callTool() { throw new Error(secret); }, async close() { throw new Error(secret); } });
  await assert.rejects(transport.sendOwnerAlert(alert), error => {
    assert.deepEqual(error.details, { request_sent: true });
    assert.equal(error.message, "NapCat MCP尚未取得可核对结果");
    return true;
  });
  await transport.close();
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.closed, 1);
});

test("a pre-aborted caller starts no SDK client and never exposes its abort reason", async context => {
  const { transport, calls } = sdkFixture(context);
  const controller = new AbortController();
  controller.abort(secret);
  await assert.rejects(transport.status({ signal: controller.signal }), error => {
    assert.deepEqual(error.details, { request_sent: false });
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls.factories, 0);
});

for (const phase of ["connect", "callTool"]) {
  test(`abort during ${phase} closes the SDK connection and stops waiting`, async context => {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const block = async () => { started(); return new Promise(() => {}); };
    const { transport, calls } = sdkFixture(context, { [phase]: block });
    const controller = new AbortController();
    const pending = transport.sendOwnerAlert(alert, { signal: controller.signal });
    await entered;
    controller.abort(secret);
    await assert.rejects(pending, error => {
      assert.deepEqual(error.details, { request_sent: phase === "callTool" });
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    await transport.close();
    assert.equal(calls.closed, 1);
    assert.equal(calls.tools.length, phase === "callTool" ? 1 : 0);
  });
}

test("closing an active SDK operation interrupts it and closes only its owned client", async context => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { transport, calls } = sdkFixture(context, { async callTool() { started(); return new Promise(() => {}); } });
  const pending = transport.sendOwnerAlert(alert);
  await entered;
  const rejected = assert.rejects(pending, error => {
    assert.deepEqual(error.details, { request_sent: true });
    return true;
  });
  await transport.close();
  await rejected;
  assert.equal(calls.closed, 1);
  assert.equal(calls.tools.length, 1);
});

test("10000ms deadline aborts even an injected SDK call that ignores cancellation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { transport, calls } = sdkFixture(context, { async callTool() { return new Promise(() => {}); } });
  const pending = transport.sendOwnerAlert(alert);
  await nextTurn();
  assert.equal(calls.tools.length, 1);
  context.mock.timers.tick(10000);
  await assert.rejects(pending, error => {
    assert.deepEqual(error.details, { request_sent: true });
    return true;
  });
  assert.equal(calls.tools[0].options.signal.aborted, true);
  await transport.close();
  assert.equal(calls.closed, 1);
});

test("transport validation rejects malformed alert fields before any SDK work", async context => {
  const { transport, calls } = sdkFixture(context);
  for (const overrides of [{ route_key: "" }, { dedupe_key: "d".repeat(201) }, { summary: "中".repeat(801) }, { reply_hint: "中".repeat(81) }]) {
    await assert.rejects(transport.sendOwnerAlert({ ...alert, ...overrides }), error => {
      assert.deepEqual(error.details, { request_sent: false });
      return true;
    });
  }
  assert.equal(calls.factories, 0);
});

test("adapter plus SDK injection distinguishes pre-call failure from post-call uncertainty", async context => {
  for (const phase of ["connect", "callTool"]) {
    const { transport } = sdkFixture(context, { [phase]: async () => { throw new Error(secret); } });
    const adapter = new NapcatOwnerAdapter({ transport: { status: async () => ({ ready: true }), sendOwnerAlert: transport.sendOwnerAlert.bind(transport) }, routeKey: "test-route" });
    const result = await adapter.deliver(input());
    assert.equal(result.outcome, phase === "connect" ? "busy" : "unknown");
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});
