import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { NapcatMcpTransport } from "../src/transports/napcat-mcp.mjs";

const endpoint = "http://127.0.0.1:14588/napcat/mcp";
const conversationId = "synthetic-stable-core-component";
const targetKey = "synthetic-owner-target";
const routeKey = "synthetic-window-route";
const secret = "synthetic-private-detail-never-printed";
const originalFetch = globalThis.fetch;
let networkAttempts = 0;

test.before(() => {
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error(secret); };
});
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0); });

function binding() {
  const target = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "frozen-model",
    binding_id: "synthetic-model-binding", binding_generation: 11 };
  return { generation: 4, owner_key: identityKey(target), target };
}

const methods = [
  { method: "registerOwnerWindowRoute", tool: "napcat_owner_window_route_register", writes: true,
    parameters: () => ({ route_key: routeKey, target_key: targetKey, capture_owner_events: true, reply_delivery: "events_only",
      window_capture: true, expected_generation: 0, dedupe_key: "original-register-key", window_binding: binding() }) },
  { method: "getOwnerWindowRoute", tool: "napcat_owner_window_route_get", writes: false,
    parameters: () => ({ route_key: routeKey, dedupe_key: "original-register-key" }) },
  { method: "closeOwnerWindowRoute", tool: "napcat_owner_window_route_close", writes: true,
    parameters: () => ({ route_key: routeKey, expected_generation: 7 }) },
  { method: "readOwnerWindowEvents", tool: "napcat_owner_window_events_read", writes: false,
    parameters: () => ({ route_key: routeKey, expected_route_generation: 7, cursor: "base64url_cursor", limit: 50 }) },
];

function contextInput(overrides = {}) { return { conversationId, targetKey, ...overrides }; }

function sanitized(requestSent) {
  return error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "napcat_mcp_unconfirmed");
    assert.equal(error.message, "NapCat MCP尚未取得可核对结果");
    assert.deepEqual(error.details, { request_sent: requestSent });
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  };
}

function providerRejected(code) {
  return error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, code);
    assert.equal(error.message, "QQ窗口服务返回错误");
    assert.deepEqual(error.details, { request_sent: true });
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  };
}

function fixture(context, overrides = {}) {
  const calls = { factories: 0, connections: [], tools: [], clientCloses: 0, wireCloses: 0, lists: 0 };
  const client = {
    async connect(wire, options) {
      calls.connections.push({ wire, options });
      const close = wire.close.bind(wire);
      wire.close = async () => { calls.wireCloses += 1; return close(); };
      return overrides.connect?.(wire, options);
    },
    async callTool(parameters, schema, options) {
      calls.tools.push({ parameters, schema, options });
      return overrides.callTool ? overrides.callTool(parameters, schema, options) : { structuredContent: { ok: true, fixture: true } };
    },
    async listTools() { calls.lists += 1; assert.fail("window transport must not discover or guess other tools"); },
    async close() { calls.clientCloses += 1; return overrides.close?.(); },
  };
  const transport = new NapcatMcpTransport({ baseUrl: endpoint, conversationId,
    clientFactory() { calls.factories += 1; return overrides.factory ? overrides.factory() : client; } });
  context.after(async () => { await transport.close(); assert.equal(calls.lists, 0); });
  return { transport, calls };
}

test("four exact methods inject the actual component CID, retain scope and share one owned SDK connection", async context => {
  const { transport, calls } = fixture(context);
  let starts = 0;
  for (const entry of methods) {
    const parameters = entry.parameters();
    const before = structuredClone(parameters);
    await transport[entry.method](parameters, contextInput({ onRequestStarted() { starts += 1; }, user_id: secret, group_id: secret }));
    assert.deepEqual(calls.tools.at(-1).parameters, { name: entry.tool, arguments: { ...before, conversation_id: conversationId } });
    assert.deepEqual(parameters, before);
    if (!entry.writes || entry.method === "closeOwnerWindowRoute") {
      assert.equal(Object.hasOwn(calls.tools.at(-1).parameters.arguments, "target_key"), false);
    }
    assert.equal(calls.tools.at(-1).schema, undefined);
  }
  assert.equal(starts, 2);
  assert.equal(calls.factories, 1);
  assert.equal(calls.connections.length, 1);
  const { wire } = calls.connections[0];
  assert.ok(wire instanceof StreamableHTTPClientTransport);
  assert.equal(wire._url.href, endpoint);
  assert.deepEqual(wire._requestInit.headers, { "x-conversation-id": conversationId });
  assert.equal(wire._requestInit.redirect, "error");
  assert.equal(wire._reconnectionOptions.maxRetries, 0);
  assert.equal(transport.submissionTracking, true);
});

test("optional get dedupe and read pagination remain omitted rather than invented", async context => {
  const { transport, calls } = fixture(context);
  await transport.getOwnerWindowRoute({ route_key: routeKey }, contextInput());
  await transport.readOwnerWindowEvents({ route_key: routeKey, expected_route_generation: 1 }, contextInput());
  assert.deepEqual(calls.tools.map(call => call.parameters.arguments), [
    { route_key: routeKey, conversation_id: conversationId },
    { route_key: routeKey, conversation_id: conversationId, expected_route_generation: 1 },
  ]);
});

for (const entry of methods) {
  test(`${entry.method} rejects foreign component CID, caller address overrides and invalid requests before SDK work`, async context => {
    const { transport, calls } = fixture(context);
    const invalid = [undefined, null, [], Object.create(entry.parameters()),
      { ...entry.parameters(), conversation_id: conversationId }, { ...entry.parameters(), user_id: secret },
      { ...entry.parameters(), owner_sender_allowlist: [secret] }, { ...entry.parameters(), route_key: " padded " },
      { ...entry.parameters(), route_key: "route\nvalue" }, { ...entry.parameters(), route_key: "原".repeat(86) }];
    for (const parameters of invalid) await assert.rejects(transport[entry.method](parameters, contextInput()), sanitized(false));
    for (const scope of [undefined, {}, null, [], contextInput({ conversationId: "other-core" }),
      contextInput({ targetKey: undefined }), contextInput({ signal: {} }), contextInput({ onRequestStarted: true })]) {
      await assert.rejects(transport[entry.method](entry.parameters(), scope), sanitized(false));
    }
    const controller = new AbortController();
    controller.abort(secret);
    await assert.rejects(transport[entry.method](entry.parameters(), contextInput({ signal: controller.signal })), sanitized(false));
    assert.equal(calls.factories, 0);
  });

  test(`${entry.method} returns provider unknown and negative results without business retries or fabrication`, async context => {
    const responses = [{ ok: false, code: "provider_scope_mismatch" }, { status: "unknown", untouched: true }];
    const { transport, calls } = fixture(context, { async callTool() { return { structuredContent: responses[calls.tools.length - 1] }; } });
    for (const response of responses) assert.strictEqual(await transport[entry.method](entry.parameters(), contextInput()), response);
    assert.equal(calls.tools.length, 2);
    assert.ok(calls.tools.every(call => call.parameters.name === entry.tool));
  });

  for (const phase of ["connect", "callTool"]) {
    test(`${entry.method} ${phase} error preserves request_sent and never auto-reissues the business operation`, async context => {
      let starts = 0;
      const { transport, calls } = fixture(context, { async [phase]() { throw new Error(secret); } });
      await assert.rejects(transport[entry.method](entry.parameters(), contextInput({ onRequestStarted() { starts += 1; } })), sanitized(phase === "callTool"));
      await transport.close();
      assert.equal(calls.factories, 1);
      assert.equal(calls.tools.length, phase === "callTool" ? 1 : 0);
      assert.equal(starts, phase === "callTool" && entry.writes ? 1 : 0);
      assert.equal(calls.clientCloses, 1);
      assert.equal(calls.wireCloses, 1);
    });

    test(`${entry.method} cancellation during ${phase} aborts and removes its listener without a replacement operation`, async context => {
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const { transport, calls } = fixture(context, { async [phase]() { entered(); return new Promise(() => {}); } });
      const controller = new AbortController();
      const pending = transport[entry.method](entry.parameters(), contextInput({ signal: controller.signal }));
      const rejected = assert.rejects(pending, sanitized(phase === "callTool"));
      await ready;
      controller.abort(secret);
      await rejected;
      await transport.close();
      const options = phase === "callTool" ? calls.tools[0].options : calls.connections[0].options;
      assert.equal(options.signal.aborted, true);
      assert.equal(getEventListeners(options.signal, "abort").length, 0);
      assert.equal(calls.factories, 1);
      assert.equal(calls.tools.length, phase === "callTool" ? 1 : 0);
      assert.equal(calls.clientCloses, 1);
      assert.equal(calls.wireCloses, 1);
    });
  }

  test(`${entry.method} enforces the shared 10s deadline even if the mock SDK ignores cancellation`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { transport, calls } = fixture(context, { async callTool() { return new Promise(() => {}); } });
    const pending = transport[entry.method](entry.parameters(), contextInput());
    const rejected = assert.rejects(pending, sanitized(true));
    await nextTurn();
    assert.equal(calls.tools.length, 1);
    for (const options of [calls.tools[0].options, calls.connections[0].options]) {
      assert.equal(options.timeout, 10000);
      assert.equal(options.maxTotalTimeout, 10000);
      assert.equal(options.resetTimeoutOnProgress, false);
    }
    context.mock.timers.tick(10000);
    await rejected;
    assert.equal(calls.tools[0].options.signal.aborted, true);
    assert.equal(getEventListeners(calls.tools[0].options.signal, "abort").length, 0);
    await transport.close();
    assert.equal(calls.tools.length, 1);
  });
}

test("registration requires original binding, exact flags, target scope, dedupe and safe CAS fields", async context => {
  const { transport, calls } = fixture(context);
  const base = methods[0].parameters();
  const invalid = [
    { target_key: "another-target" }, { capture_owner_events: false }, { reply_delivery: "wake" }, { window_capture: false },
    { expected_generation: -1 }, { expected_generation: "0" }, { expected_generation: Number.MAX_SAFE_INTEGER + 1 },
    { dedupe_key: "" }, { dedupe_key: "原".repeat(67) }, { window_binding: undefined },
    { window_binding: { ...binding(), owner_key: "forged" } },
    { window_binding: { ...binding(), target: { ...binding().target, binding_generation: 0 } } },
  ];
  for (const patch of invalid) await assert.rejects(transport.registerOwnerWindowRoute({ ...base, ...patch }, contextInput()), sanitized(false));
  for (const field of ["capture_owner_events", "reply_delivery", "window_capture", "dedupe_key", "expected_generation", "window_binding"]) {
    const request = { ...base };
    delete request[field];
    await assert.rejects(transport.registerOwnerWindowRoute(request, contextInput()), sanitized(false));
  }
  assert.equal(calls.factories, 0);
});

test("close and read generations, optional cursor/limit and extra original QQ fields reject locally", async context => {
  const { transport, calls } = fixture(context);
  for (const value of [undefined, null, 0, -1, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(transport.closeOwnerWindowRoute({ route_key: routeKey, expected_generation: value }, contextInput()), sanitized(false));
    await assert.rejects(transport.readOwnerWindowEvents({ route_key: routeKey, expected_route_generation: value }, contextInput()), sanitized(false));
  }
  for (const patch of [{ limit: 0 }, { limit: 51 }, { limit: "1" }, { cursor: "" }, { cursor: "not valid" },
    { cursor: "c".repeat(4097) }, { original_qq_message_id: "88000001" }, { target_key: targetKey }]) {
    await assert.rejects(transport.readOwnerWindowEvents({ route_key: routeKey, expected_route_generation: 1, ...patch }, contextInput()), sanitized(false));
  }
  assert.equal(calls.factories, 0);
});

test("an unknown registration remains one attempt until the caller explicitly gets the original dedupe key", async context => {
  const { transport, calls } = fixture(context, { async callTool(request) {
    if (request.name === "napcat_owner_window_route_register") throw new Error(secret);
    return { structuredContent: { ok: true, registration: { dedupe_key: "original-register-key", applied_generation: 7 } } };
  } });
  await assert.rejects(transport.registerOwnerWindowRoute(methods[0].parameters(), contextInput()), sanitized(true));
  assert.equal(calls.tools.length, 1);
  const result = await transport.getOwnerWindowRoute(methods[1].parameters(), contextInput());
  assert.equal(result.registration.dedupe_key, "original-register-key");
  assert.deepEqual(calls.tools.map(call => call.parameters.name), ["napcat_owner_window_route_register", "napcat_owner_window_route_get"]);
  assert.equal(calls.factories, 2);
});

test("capture of registration parameters is independent of mutations while connection setup waits", async context => {
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const { transport, calls } = fixture(context, { async connect() { entered(); await new Promise(resolve => { release = resolve; }); } });
  const request = methods[0].parameters();
  const original = structuredClone(request);
  const pending = transport.registerOwnerWindowRoute(request, contextInput());
  await ready;
  request.dedupe_key = "changed-key";
  request.window_binding.target.conversation_id = "changed-model";
  release();
  await pending;
  assert.deepEqual(calls.tools[0].parameters.arguments, { ...original, conversation_id: conversationId });
  assert.equal(Object.isFrozen(calls.tools[0].parameters.arguments.window_binding.target), true);
});

test("malformed, error and JSON-text replies use the original structuredResult semantics", async context => {
  const responses = [
    { content: [{ type: "text", text: JSON.stringify({ ok: true, fixture: "JSON-text" }) }] },
    { isError: true, structuredContent: { ok: true } }, null,
    { content: [{ type: "text", text: secret }] },
  ];
  const { transport, calls } = fixture(context, { async callTool() { return responses.shift(); } });
  assert.deepEqual(await transport.getOwnerWindowRoute(methods[1].parameters(), contextInput()), { ok: true, fixture: "JSON-text" });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(transport.getOwnerWindowRoute(methods[1].parameters(), contextInput()), sanitized(true));
  }
  assert.equal(calls.tools.length, 4);
});

for (const entry of methods.filter(item => item.writes)) {
  test(`${entry.method} abort from request_started prevents a callTool dispatch and remains definitely before request_sent`, async context => {
    const { transport, calls } = fixture(context);
    const controller = new AbortController();
    let starts = 0;
    await assert.rejects(transport[entry.method](entry.parameters(), contextInput({ signal: controller.signal,
      onRequestStarted() { starts += 1; controller.abort(secret); } })), sanitized(false));
    await transport.close();
    assert.equal(starts, 1);
    assert.equal(calls.tools.length, 0);
  });
}

test("shutdown interrupts an in-flight window registration and later get remains closed without another SDK client", async context => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const { transport, calls } = fixture(context, { async callTool() { entered(); return new Promise(() => {}); } });
  const pending = transport.registerOwnerWindowRoute(methods[0].parameters(), contextInput());
  const rejected = assert.rejects(pending, sanitized(true));
  await ready;
  await transport.close();
  await rejected;
  await assert.rejects(transport.getOwnerWindowRoute(methods[1].parameters(), contextInput()), sanitized(false));
  assert.equal(calls.factories, 1);
  assert.equal(calls.tools.length, 1);
});

test("accessors, proxies and hidden fields are rejected without executing caller getters", async context => {
  const { transport, calls } = fixture(context);
  let evaluated = 0;
  const hostile = Object.defineProperty(methods[0].parameters(), "route_key", { enumerable: true,
    get() { evaluated += 1; throw new Error(secret); } });
  const scope = Object.defineProperty(contextInput(), "conversationId", { enumerable: true,
    get() { evaluated += 1; throw new Error(secret); } });
  const hidden = Object.defineProperty(methods[1].parameters(), "user_id", { value: secret });
  await assert.rejects(transport.registerOwnerWindowRoute(hostile, contextInput()), sanitized(false));
  await assert.rejects(transport.registerOwnerWindowRoute(methods[0].parameters(), scope), sanitized(false));
  await assert.rejects(transport.getOwnerWindowRoute(hidden, contextInput()), sanitized(false));
  await assert.rejects(transport.getOwnerWindowRoute(new Proxy(methods[1].parameters(), {}), contextInput()), sanitized(false));
  assert.equal(evaluated, 0);
  assert.equal(calls.factories, 0);
});

for (const entry of methods) {
  test(`${entry.method} retains only validated provider codes from native text, structured error and structured failure results`, async context => {
    const code = entry.method === "readOwnerWindowEvents" ? "OWNER_WINDOW_HISTORY_EXPIRED" : "OWNER_WINDOW_SCOPE_MISMATCH";
    const failure = { ok: false, code, message: secret, outcomeUnknown: false,
      request_sent: false, details: { request_sent: false, private_body: secret } };
    const responses = [
      { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] },
      { isError: true, structuredContent: failure, content: [{ type: "text", text: secret }] },
      { structuredContent: failure },
    ];
    const { transport, calls } = fixture(context, { async callTool() { return responses.shift(); } });
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(transport[entry.method](entry.parameters(), contextInput()), providerRejected(code));
    }
    assert.equal(calls.tools.length, 3);
    assert.ok(calls.tools.every(call => call.parameters.name === entry.tool));
  });

  test(`${entry.method} cannot trust a provider-looking error thrown by the SDK instead of returned by the provider`, async context => {
    const { transport, calls } = fixture(context, { async callTool() {
      throw new CoreError("OWNER_WINDOW_SCOPE_MISMATCH", secret, { request_sent: false });
    } });
    await assert.rejects(transport[entry.method](entry.parameters(), contextInput()), sanitized(true));
    assert.equal(calls.tools.length, 1);
  });
}

const providerCodeSuffixes = [
  "BASELINE_REQUIRED", "BINDING_GENERATION_MISMATCH", "BINDING_IDENTITY_MISMATCH", "CONTENT_UNAVAILABLE",
  "CURSOR_EXPIRED", "CURSOR_INVALID", "CURSOR_SCOPE_MISMATCH", "DEDUPE_CONFLICT", "GENERATION_MISMATCH",
  "HISTORY_EXPIRED", "INVALID_ARGUMENT", "ROUTE_CONFLICT", "SCOPE_MISMATCH", "SENDER_MISMATCH", "STATE_INVALID",
  "TRUST_AMBIGUOUS", "TRUST_CHANGED", "TRUST_UNAVAILABLE", "UNSUPPORTED",
];

test("all nineteen current provider codes remain finite and recognizable across the four window methods", async context => {
  let returnedCode;
  const { transport, calls } = fixture(context, { async callTool() {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: returnedCode, message: secret, outcomeUnknown: false }) }] };
  } });
  for (const suffix of providerCodeSuffixes) {
    returnedCode = `OWNER_WINDOW_${suffix}`;
    for (const entry of methods) {
      await assert.rejects(transport[entry.method](entry.parameters(), contextInput()), providerRejected(returnedCode));
    }
  }
  assert.equal(calls.tools.length, 19 * 4);
});

test("unknown, malformed, contradictory or explicitly unconfirmed provider failures remain unconfirmed", async context => {
  const failures = [
    { ok: false, code: "OWNER_WINDOW_FUTURE_CODE", message: secret },
    { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH\n", message: secret },
    { ok: true, code: "OWNER_WINDOW_SCOPE_MISMATCH", message: secret },
    { code: "OWNER_WINDOW_SCOPE_MISMATCH", message: secret },
    { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", outcomeUnknown: true, message: secret },
    { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", outcomeUnknown: "false", message: secret },
    { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", status: "unknown", message: secret },
    { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", outcome: "unknown", message: secret },
  ];
  const { transport, calls } = fixture(context, { async callTool() { return { isError: true, structuredContent: failures.shift() }; } });
  const count = failures.length;
  for (let index = 0; index < count; index += 1) {
    await assert.rejects(transport.getOwnerWindowRoute(methods[1].parameters(), contextInput()), sanitized(true));
  }
  assert.equal(calls.tools.length, count);
});

test("initial scope mismatch is exposed without claiming absence or bypassing native register CAS zero protection", async context => {
  const { transport, calls } = fixture(context, { async callTool() {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", message: secret }) }] };
  } });
  await assert.rejects(transport.getOwnerWindowRoute(methods[1].parameters(), contextInput()), providerRejected("OWNER_WINDOW_SCOPE_MISMATCH"));
  assert.equal(calls.tools.length, 1);
  await assert.rejects(transport.registerOwnerWindowRoute(methods[0].parameters(), contextInput()), providerRejected("OWNER_WINDOW_SCOPE_MISMATCH"));
  assert.equal(calls.tools.length, 2);
  assert.equal(calls.tools[1].parameters.arguments.expected_generation, 0);
  assert.deepEqual(calls.tools.map(call => call.parameters.name), ["napcat_owner_window_route_get", "napcat_owner_window_route_register"]);
});

test("old status, owner alert and quoted read still collapse provider isError into the original unconfirmed error", async context => {
  const { transport, calls } = fixture(context, { async callTool() {
    return { isError: true, structuredContent: { ok: false, code: "OWNER_WINDOW_SCOPE_MISMATCH", message: secret } };
  } });
  await assert.rejects(transport.status(), sanitized(true));
  await assert.rejects(transport.sendOwnerAlert({ route_key: routeKey, dedupe_key: "legacy-key", summary: "synthetic legacy summary" }), sanitized(true));
  await assert.rejects(transport.readOwnerEvents({ route_key: routeKey, original_qq_message_id: "88000001", expected_route_generation: 1 }, contextInput()), sanitized(true));
  assert.deepEqual(calls.tools.map(call => call.parameters.name), ["napcat_status", "napcat_owner_alert", "napcat_owner_events_read"]);
});
