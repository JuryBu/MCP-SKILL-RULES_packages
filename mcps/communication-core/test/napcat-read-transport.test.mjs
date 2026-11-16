import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError } from "../src/contracts.mjs";
import { NapcatMcpTransport } from "../src/transports/napcat-mcp.mjs";

const endpoint = "http://127.0.0.1:14588/napcat/mcp";
const conversationId = "read-transport-fixture-cid";
const targetKey = "read-transport-fixture-target";
const secret = "Bearer fixture-read-secret-not-for-output";
const originalFetch = globalThis.fetch;
let networkAttempts = 0;

test.before(() => {
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("只读transport替身测试禁止网络请求");
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0);
});

function parameters(overrides = {}) {
  return { route_key: "fixture-read-route", original_qq_message_id: "75123", expected_route_generation: 7, ...overrides };
}

function readContext(overrides = {}) {
  return { conversationId, targetKey, ...overrides };
}

function page(overrides = {}) {
  return {
    ok: true,
    route: { route_key: "fixture-read-route", conversation_id: conversationId, target_key: targetKey, generation: 7 },
    original_qq_message_id: "75123",
    events: [],
    next_cursor: null,
    partial: false,
    ...overrides,
  };
}

function sanitized(requestSent) {
  return error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "napcat_mcp_unconfirmed");
    assert.equal(error.message, "NapCat MCP尚未取得可核对结果");
    assert.deepEqual(error.details, { request_sent: requestSent });
    assert.equal(error.cause, undefined);
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(secret), false);
    return true;
  };
}

function sdkFixture(context, { connect, callTool, close } = {}) {
  const calls = { factories: 0, connect: [], tools: [], closed: 0, transportClosed: 0, listed: 0 };
  const client = {
    async connect(transport, options) {
      calls.connect.push({ transport, options });
      const closeTransport = transport.close.bind(transport);
      transport.close = async () => { calls.transportClosed += 1; return closeTransport(); };
      return connect?.(transport, options);
    },
    async callTool(params, schema, options) {
      calls.tools.push({ params, schema, options });
      return callTool ? callTool(params, schema, options) : { structuredContent: page() };
    },
    async listTools() { calls.listed += 1; throw new Error("只读入口禁止tools/list"); },
    async close() { calls.closed += 1; return close?.(); },
  };
  const transport = new NapcatMcpTransport({
    baseUrl: endpoint,
    conversationId,
    clientFactory() { calls.factories += 1; return client; },
  });
  context.after(() => transport.close());
  context.after(() => assert.equal(calls.listed, 0));
  return { transport, calls };
}

test("owner read calls only the exact candidate tool with its explicit matching CID", async context => {
  const result = page({ unknown_provider_field: { retained: true } });
  const { transport, calls } = sdkFixture(context, { async callTool() { return { structuredContent: result }; } });
  const request = Object.freeze(parameters());
  const scope = Object.freeze(readContext());
  assert.equal(calls.factories, 0);
  assert.strictEqual(await transport.readOwnerEvents(request, scope), result);
  assert.equal(calls.factories, 1);
  assert.equal(calls.connect.length, 1);
  assert.deepEqual(calls.tools.map(call => call.params), [{
    name: "napcat_owner_events_read",
    arguments: { ...request, conversation_id: conversationId },
  }]);
  const wire = calls.connect[0].transport;
  assert.ok(wire instanceof StreamableHTTPClientTransport);
  assert.equal(wire._url.href, endpoint);
  assert.deepEqual(wire._requestInit.headers, { "x-conversation-id": conversationId });
  assert.equal(wire._requestInit.redirect, "error");
  assert.equal(wire._reconnectionOptions.maxRetries, 0);
  assert.equal(calls.tools[0].schema, undefined);
  assert.equal(Object.hasOwn(calls.tools[0].params.arguments, "target_key"), false);
  assert.deepEqual(scope, readContext());
});

test("read forwards optional pagination without inventing defaults and accepts exact numeric boundaries", async context => {
  const { transport, calls } = sdkFixture(context);
  for (const limit of [1, 50]) {
    const request = parameters({
      route_key: "r".repeat(256),
      original_qq_message_id: `-${"9".repeat(20)}`,
      expected_route_generation: Number.MAX_SAFE_INTEGER,
      cursor: "c".repeat(4096),
      limit,
    });
    await transport.readOwnerEvents(request, readContext());
    assert.deepEqual(calls.tools.at(-1).params.arguments, { ...request, conversation_id: conversationId });
  }
  await transport.readOwnerEvents(parameters(), readContext());
  assert.equal(calls.connect.length, 1);
  assert.equal(Object.hasOwn(calls.tools.at(-1).params.arguments, "cursor"), false);
  assert.equal(Object.hasOwn(calls.tools.at(-1).params.arguments, "limit"), false);
});

test("a null-prototype request is allowed while arbitrary target selectors in context stay off the wire", async context => {
  const { transport, calls } = sdkFixture(context);
  const request = Object.assign(Object.create(null), parameters());
  await transport.readOwnerEvents(request, readContext({ user_id: secret, group_id: secret, target_key: secret }));
  assert.deepEqual(calls.tools[0].params.arguments, { ...parameters(), conversation_id: conversationId });
});

const invalidParameters = [
  ["missing request", undefined],
  ["null request", null],
  ["array request", []],
  ["string request", secret],
  ["inherited request", Object.create(parameters())],
  ["missing route", parameters({ route_key: undefined })],
  ["empty route", parameters({ route_key: "" })],
  ["blank route", parameters({ route_key: " " })],
  ["padded route", parameters({ route_key: " route " })],
  ["control route", parameters({ route_key: "route\nvalue" })],
  ["oversized route", parameters({ route_key: "r".repeat(257) })],
  ["oversized UTF8 route", parameters({ route_key: "中".repeat(86) })],
  ...[undefined, null, 75123, "", "0", "-0", "0123", "+123", "1.2", " 123", "123\n", "1".repeat(21)]
    .map((value, index) => [`invalid original ID ${index}`, parameters({ original_qq_message_id: value })]),
  ...[undefined, null, 0, -1, 1.5, "7", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
    .map((value, index) => [`invalid generation ${index}`, parameters({ expected_route_generation: value })]),
  ...[null, "", " ", " cursor", "cursor\u0000value", 1, "c".repeat(4097), "中".repeat(1366)]
    .map((value, index) => [`invalid cursor ${index}`, parameters({ cursor: value })]),
  ...[null, 0, -1, 51, 1.5, "1", NaN, Infinity]
    .map((value, index) => [`invalid limit ${index}`, parameters({ limit: value })]),
];

for (const [name, request] of invalidParameters) {
  test(`${name} is rejected locally before creating an SDK client`, async context => {
    const { transport, calls } = sdkFixture(context);
    await assert.rejects(transport.readOwnerEvents(request, readContext()), sanitized(false));
    assert.equal(calls.factories, 0);
    assert.equal(calls.tools.length, 0);
  });
}

for (const key of ["conversation_id", "conversationId", "target_key", "targetKey", "user_id", "group_id", "qq", "account", "signal", "tool", "token"]) {
  test(`extra parameter ${key} cannot replace or extend the configured read route`, async context => {
    const { transport, calls } = sdkFixture(context);
    await assert.rejects(transport.readOwnerEvents(parameters({ [key]: secret }), readContext()), sanitized(false));
    assert.equal(calls.factories, 0);
  });
}

test("non-enumerable and symbol extras cannot bypass the parameter allowlist", async context => {
  const { transport, calls } = sdkFixture(context);
  for (const key of ["user_id", Symbol("target")]) {
    const request = Object.defineProperty(parameters(), key, { value: secret });
    await assert.rejects(transport.readOwnerEvents(request, readContext()), sanitized(false));
  }
  assert.equal(calls.factories, 0);
});

const invalidContexts = [
  ["omitted", undefined],
  ["null", null],
  ["array", []],
  ["string", secret],
  ["empty", {}],
  ["missing CID", readContext({ conversationId: undefined })],
  ["cross CID", readContext({ conversationId: "different-cid" })],
  ["blank CID", readContext({ conversationId: " " })],
  ["header injection CID", readContext({ conversationId: "fixture\r\nAuthorization: secret" })],
  ["missing target", readContext({ targetKey: undefined })],
  ["blank target", readContext({ targetKey: " " })],
  ["control target", readContext({ targetKey: "target\u007f" })],
  ["oversized target", readContext({ targetKey: "t".repeat(257) })],
  ...[null, true, {}, { aborted: false }, { aborted: true, reason: secret }]
    .map((signal, index) => [`invalid signal ${index}`, readContext({ signal })]),
];

for (const [name, scope] of invalidContexts) {
  test(`${name} context is rejected before SDK work`, async context => {
    const { transport, calls } = sdkFixture(context);
    await assert.rejects(transport.readOwnerEvents(parameters(), scope), sanitized(false));
    assert.equal(calls.factories, 0);
  });
}

test("throwing parameter or context accessors yield only the fixed local error", async context => {
  const { transport, calls } = sdkFixture(context);
  const request = Object.defineProperty(parameters(), "route_key", { get() { throw new Error(secret); } });
  const scope = Object.defineProperty(readContext(), "conversationId", { get() { throw new Error(secret); } });
  await assert.rejects(transport.readOwnerEvents(request, readContext()), sanitized(false));
  await assert.rejects(transport.readOwnerEvents(parameters(), scope), sanitized(false));
  const revoked = Proxy.revocable(parameters(), {});
  revoked.revoke();
  await assert.rejects(transport.readOwnerEvents(revoked.proxy, readContext()), sanitized(false));
  assert.equal(calls.factories, 0);
});

test("a pre-aborted read creates no SDK client and redacts its cancellation reason", async context => {
  const { transport, calls } = sdkFixture(context);
  const controller = new AbortController();
  controller.abort(secret);
  await assert.rejects(transport.readOwnerEvents(parameters(), readContext({ signal: controller.signal })), sanitized(false));
  assert.equal(calls.factories, 0);
  assert.equal(calls.closed, 0);
});

test("read uses shared deadlines, removes listeners and clears its successful timer", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { transport, calls } = sdkFixture(context);
  const controller = new AbortController();
  await transport.readOwnerEvents(parameters(), readContext({ signal: controller.signal }));
  for (const options of [calls.connect[0].options, calls.tools[0].options]) {
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxTotalTimeout, 10000);
    assert.equal(options.resetTimeoutOnProgress, false);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(getEventListeners(options.signal, "abort").length, 0);
  }
  context.mock.timers.tick(10000);
  assert.equal(calls.tools[0].options.signal.aborted, false);
});

test("read does not report submission while existing status and alert behavior is retained", async context => {
  let started = 0;
  const { transport, calls } = sdkFixture(context);
  const onRequestStarted = () => { started += 1; };
  await transport.readOwnerEvents(parameters(), readContext({ onRequestStarted }));
  await transport.status({ onRequestStarted });
  assert.equal(started, 0);
  const alert = { route_key: "fixture-read-route", dedupe_key: "fixture-dedupe", summary: "纯内存发送替身" };
  await transport.sendOwnerAlert(alert, { onRequestStarted });
  assert.equal(started, 1);
  assert.equal(calls.connect.length, 1);
  assert.deepEqual(calls.tools.map(call => call.params), [
    { name: "napcat_owner_events_read", arguments: { ...parameters(), conversation_id: conversationId } },
    { name: "napcat_status", arguments: { include_group: false } },
    { name: "napcat_owner_alert", arguments: alert },
  ]);
});

for (const result of [
  { ok: false, error: { code: "capture_unavailable" } },
  { status: "unknown", extra: { kept: true } },
  page({ partial: "unknown", next_cursor: undefined }),
  page({ route: { route_key: "mismatched-route" } }),
]) {
  test("provider unknown or incomplete content remains untouched for reader validation", async context => {
    const { transport } = sdkFixture(context, { async callTool() { return { structuredContent: result }; } });
    assert.strictEqual(await transport.readOwnerEvents(parameters(), readContext()), result);
  });
}

test("a sole JSON text result is parsed while structured content keeps precedence", async context => {
  const result = page({ extra: { kept: true } });
  const responses = [
    { structuredContent: result, content: [{ type: "text", text: secret }] },
    { content: [{ type: "text", text: JSON.stringify(result) }] },
  ];
  const { transport } = sdkFixture(context, { async callTool() { return responses.shift(); } });
  assert.strictEqual(await transport.readOwnerEvents(parameters(), readContext()), result);
  assert.deepEqual(await transport.readOwnerEvents(parameters(), readContext()), result);
});

for (const response of [null, { isError: true, structuredContent: page() }, { structuredContent: null }, { structuredContent: [] }, { content: [{ type: "text", text: secret }] }]) {
  test("a failed or malformed SDK read result cannot become a successful page", async context => {
    const { transport, calls } = sdkFixture(context, { async callTool() { return response; } });
    await assert.rejects(transport.readOwnerEvents(parameters(), readContext()), sanitized(true));
    await transport.close();
    assert.equal(calls.tools.length, 1);
    assert.equal(calls.closed, 1);
    assert.equal(calls.transportClosed, 1);
  });
}

test("SDK factory failure is sanitized before read submission", async () => {
  let factories = 0;
  const transport = new NapcatMcpTransport({ baseUrl: endpoint, conversationId, clientFactory() { factories += 1; throw new Error(secret); } });
  try {
    await assert.rejects(transport.readOwnerEvents(parameters(), readContext()), sanitized(false));
    assert.equal(factories, 1);
  } finally {
    await transport.close();
  }
});

for (const phase of ["connect", "callTool"]) {
  test(`${phase} failure closes the read connection without retry or leaked details`, async context => {
    const { transport, calls } = sdkFixture(context, {
      async [phase]() { throw new Error(secret); },
      async close() { throw new Error(secret); },
    });
    await assert.rejects(transport.readOwnerEvents(parameters(), readContext()), sanitized(phase === "callTool"));
    await transport.close();
    assert.equal(calls.factories, 1);
    assert.equal(calls.connect.length, 1);
    assert.equal(calls.tools.length, phase === "callTool" ? 1 : 0);
    assert.equal(calls.closed, 1);
    assert.equal(calls.transportClosed, 1);
  });

  test(`abort during ${phase} stops the read and cleans its shared connection`, async context => {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const { transport, calls } = sdkFixture(context, { async [phase]() { started(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const pending = transport.readOwnerEvents(parameters(), readContext({ signal: controller.signal }));
    await entered;
    controller.abort(secret);
    await assert.rejects(pending, sanitized(phase === "callTool"));
    await transport.close();
    assert.equal(calls.factories, 1);
    assert.equal(calls.tools.length, phase === "callTool" ? 1 : 0);
    assert.equal(calls.closed, 1);
    assert.equal(calls.transportClosed, 1);
    const options = phase === "callTool" ? calls.tools[0].options : calls.connect[0].options;
    assert.equal(options.signal.aborted, true);
    assert.equal(getEventListeners(options.signal, "abort").length, 0);
  });
}

test("the shared 10000ms deadline interrupts a read that ignores cancellation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { transport, calls } = sdkFixture(context, { async callTool() { return new Promise(() => {}); } });
  const pending = transport.readOwnerEvents(parameters(), readContext());
  await nextTurn();
  assert.equal(calls.tools.length, 1);
  context.mock.timers.tick(10000);
  await assert.rejects(pending, sanitized(true));
  assert.equal(calls.tools[0].options.signal.aborted, true);
  assert.equal(getEventListeners(calls.tools[0].options.signal, "abort").length, 0);
  await transport.close();
  assert.equal(calls.closed, 1);
  assert.equal(calls.transportClosed, 1);
});

test("closing an active read interrupts it and never opens another client", async context => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { transport, calls } = sdkFixture(context, { async callTool() { started(); return new Promise(() => {}); } });
  const pending = transport.readOwnerEvents(parameters(), readContext());
  await entered;
  const rejected = assert.rejects(pending, sanitized(true));
  await transport.close();
  await rejected;
  await assert.rejects(transport.readOwnerEvents(parameters(), readContext()), sanitized(false));
  assert.equal(calls.factories, 1);
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.transportClosed, 1);
});
