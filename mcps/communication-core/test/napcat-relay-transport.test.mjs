import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError } from "../src/contracts.mjs";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";
import * as relayEnvelope from "../src/relay-envelope.mjs";
import {
  InMemoryRelayBus,
  MACHINE_BUNDLE_LANE,
  MACHINE_RELAY_LANE,
  NapcatRelayTransport,
  RELAY_ALLOWED_OPS,
  RELAY_ERROR_CODE_MAP,
  RelayError,
  mapRelayProviderErrorCode,
  mapRelayRouteToBundleRoute,
  projectRelayRoutesForAddressBook,
} from "../src/transports/napcat-relay.mjs";

const LOOPBACK_URL = "http://127.0.0.1:14589/napcat/relay/mcp";
const SYNTHETIC_CID = "synthetic-core-relay-client";
const HEX64_A = "a".repeat(64);
const HEX64_B = "b".repeat(64);
const HEX64_C = "c".repeat(64);

function sampleFrameParams(overrides = {}) {
  return {
    dedupe_key: "synthetic-frame-dedupe-1",
    target_machine: "train-machine",
    op: "message",
    source: "antigravity/desktop/dev-conv-1",
    recipients: ["codex/desktop/train-conv-1"],
    body: "synthetic hello body",
    meta: { request_id: "req-1", hop_count: 1 },
    ...overrides,
  };
}

function sampleBundleParams(overrides = {}) {
  return {
    dedupe_key: "synthetic-bundle-dedupe-1",
    target_machine: "train-machine",
    op: "message",
    source: "antigravity/desktop/dev-conv-1",
    recipients: ["codex/desktop/train-conv-1"],
    meta: { request_id: "bundle-req-1", hop_count: 1 },
    payload_json: { text: "synthetic payload", items: [1, 2, 3] },
    ...overrides,
  };
}

function missingBrokerSession(statusCode = 404) {
  return new StreamableHTTPError(
    statusCode,
    'Error POSTing to endpoint: {"error":"Missing or invalid MCP session. Send initialize first."}',
  );
}

function createInjectedFixture(context, options = {}) {
  const stats = {
    clientsByLane: new Map(),
    wires: [],
    calls: [],
    closes: 0,
    wireCloses: 0,
  };
  const {
    handler = () => ({ structuredContent: { ok: true } }),
    transportOptions = {},
  } = options;

  const transport = new NapcatRelayTransport({
    ...transportOptions,
    clientFactory(lane) {
      stats.clientsByLane.set(lane, (stats.clientsByLane.get(lane) ?? 0) + 1);
      return {
        async connect(wire, connectOpts) {
          const origClose = wire.close.bind(wire);
          wire.close = async () => {
            stats.wireCloses += 1;
            return origClose();
          };
          stats.wires.push({ lane, wire, connectOpts });
        },
        async callTool(request, schema, callOpts) {
          stats.calls.push({ lane, request, schema, callOpts });
          return handler(request, { lane, callOpts });
        },
        async close() {
          stats.closes += 1;
        },
      };
    },
  });
  context.after(() => transport.close());
  return { transport, stats };
}

function countResources() {
  const counts = new Map();
  for (const name of process.getActiveResourcesInfo()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/* ============================================================================
 * 1. Configuration, Loopback, Stdio, Prototype & Proxy Security Defenses
 * ========================================================================== */

test("rejects non-loopback, credentialed, query/hash, path-traversal and malformed configurations", () => {
  const badConfigs = [
    undefined,
    null,
    [],
    {},
    new Proxy({ baseUrl: LOOPBACK_URL, conversationId: SYNTHETIC_CID }, {}),
    Object.create({ baseUrl: LOOPBACK_URL, conversationId: SYNTHETIC_CID }),
    { baseUrl: LOOPBACK_URL, conversationId: SYNTHETIC_CID, extraField: true },
    { baseUrl: "https://127.0.0.1:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://192.168.1.50:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://0.0.0.0:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://example.com:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://localhost.evil.test:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://[::ffff:127.0.0.1]:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://user:pass@127.0.0.1:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://user@127.0.0.1:14589/napcat/relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://127.0.0.1:14589/napcat/relay/mcp?token=1", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://127.0.0.1:14589/napcat/relay/mcp?", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://127.0.0.1:14589/napcat/relay/mcp#frag", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://127.0.0.1:14589/napcat/relay/mcp#", conversationId: SYNTHETIC_CID },
    { baseUrl: "http://127.0.0.1:14589/napcat/../relay/mcp", conversationId: SYNTHETIC_CID },
    { baseUrl: LOOPBACK_URL },
    { baseUrl: LOOPBACK_URL, conversationId: " leading-space" },
    { baseUrl: LOOPBACK_URL, conversationId: "line\nbreak" },
    { baseUrl: LOOPBACK_URL, conversationId: SYNTHETIC_CID, stdioCommand: process.execPath },
    { stdioCommand: process.execPath, stdioArgs: ["ok", "bad\x00arg"] },
    { stdioCommand: process.execPath, stdioStderr: "invalid" },
    { clientFactory: () => ({}), timeoutMs: 50 },
    { clientFactory: () => ({}), bundleEnabled: "yes" },
  ];

  for (const cfg of badConfigs) {
    assert.throws(
      () => new NapcatRelayTransport(cfg),
      err => err instanceof CoreError && err.code === "invalid_config",
      `expected invalid_config for ${JSON.stringify(cfg)}`,
    );
  }
});

test("accepts valid loopback HTTP, private stdio, transportFactory and injected client modes", async context => {
  for (const url of [
    "http://127.0.0.1:14589/napcat/relay/mcp",
    "http://127.0.0.2:14589/relay",
    "http://localhost:14589/relay",
    "http://[::1]:14589/relay",
  ]) {
    const { transport, stats } = createInjectedFixture(context, {
      transportOptions: { baseUrl: url, conversationId: SYNTHETIC_CID },
    });
    assert.equal(transport.mode, "http");
    await transport.status();
    assert.equal(stats.wires.length, 1);
    const wire = stats.wires[0].wire;
    assert.ok(wire instanceof StreamableHTTPClientTransport);
    assert.equal(wire._requestInit.redirect, "error");
    assert.deepEqual(wire._requestInit.headers, { "x-conversation-id": SYNTHETIC_CID });
    assert.equal(wire._reconnectionOptions.maxRetries, 0);
  }

  const { transport: stdioTransport, stats: stdioStats } = createInjectedFixture(context, {
    transportOptions: {
      stdioCommand: process.execPath,
      stdioArgs: ["--version"],
      stdioStderr: "ignore",
    },
  });
  assert.equal(stdioTransport.mode, "stdio");
  await stdioTransport.status();
  assert.ok(stdioStats.wires[0].wire instanceof StdioClientTransport);

  let factoryLanes = [];
  const customWire = { async start() {}, async send() {}, async close() {} };
  const { transport: customTransport } = createInjectedFixture(context, {
    transportOptions: {
      transportFactory(lane) {
        factoryLanes.push(lane);
        return customWire;
      },
    },
  });
  assert.equal(customTransport.mode, "stdio");
  await customTransport.status();
  await customTransport.readBundleEvents();
  assert.deepEqual(factoryLanes, [MACHINE_RELAY_LANE, MACHINE_BUNDLE_LANE]);
});

test("defends all methods against Proxy, prototype-chain, getter and prototype-pollution inputs", async context => {
  const { transport, stats } = createInjectedFixture(context);
  const getterObj = {};
  Object.defineProperty(getterObj, "include_live_check", {
    enumerable: true,
    get() { return true; },
  });
  const protoPolluted = JSON.parse('{"__proto__":{"polluted":true}}');

  await assert.rejects(transport.status(new Proxy({}, {})), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.status(Object.create({ include_live_check: true })), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.status(getterObj), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.status(protoPolluted), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.status({}, new Proxy({}, {})), err => err instanceof CoreError && err.code === "invalid_input");

  await assert.rejects(
    transport.sendFrame(sampleFrameParams({ meta: new Proxy({ hop_count: 1 }, {}) })),
    err => err instanceof CoreError && err.code === "invalid_input",
  );
  await assert.rejects(
    transport.sendBundle(sampleBundleParams({ payload_json: new Proxy({ a: 1 }, {}) })),
    err => err instanceof CoreError && err.code === "invalid_input",
  );
  assert.equal(stats.calls.length, 0);
});

/* ============================================================================
 * 2. Error Code Mapping & Structured RelayError Preservation
 * ========================================================================== */

test("maps all RELAY_* uppercase codes to Core snake_case relay_* and normalizes unknown codes", () => {
  const expectedContract13 = {
    RELAY_FRAME_TOO_LARGE: "relay_frame_too_large",
    RELAY_RATE_LIMITED: "relay_rate_limited",
    RELAY_RECIPIENT_DISCLOSURE_BLOCKED: "relay_recipient_disclosure_blocked",
    RELAY_ROUTE_NOT_FOUND: "relay_route_not_found",
    RELAY_ROUTE_AMBIGUOUS: "relay_route_ambiguous",
    RELAY_ROUTE_DRAIN_EXPIRED: "relay_route_drain_expired",
    RELAY_ROUTE_CHANGED: "relay_route_changed",
    RELAY_DEDUPE_CONFLICT: "relay_dedupe_conflict",
    RELAY_CURSOR_EXPIRED: "relay_cursor_expired",
    RELAY_HISTORY_EXPIRED: "relay_history_expired",
    RELAY_HISTORY_GAP: "relay_history_gap",
    RELAY_CURSOR_INVALID: "relay_cursor_invalid",
    RELAY_CURSOR_SCOPE_MISMATCH: "relay_cursor_scope_mismatch",
  };
  for (const [providerCode, coreCode] of Object.entries(expectedContract13)) {
    assert.equal(RELAY_ERROR_CODE_MAP[providerCode], coreCode);
    assert.equal(mapRelayProviderErrorCode(providerCode), coreCode);
  }
  for (const mapped of Object.values(RELAY_ERROR_CODE_MAP)) {
    assert.match(mapped, /^[a-z][a-z0-9_]{0,63}$/u);
  }
  assert.equal(mapRelayProviderErrorCode("RELAY_FUTURE_UNLISTED_CODE"), "relay_provider_error");
  assert.equal(mapRelayProviderErrorCode("UNKNOWN_UPPER_ERR"), "relay_provider_error");
  assert.equal(mapRelayProviderErrorCode("toString"), "relay_provider_error");
  assert.equal(mapRelayProviderErrorCode("constructor"), "relay_provider_error");
  assert.equal(mapRelayProviderErrorCode(""), "relay_provider_error");
  assert.equal(mapRelayProviderErrorCode(null), "relay_provider_error");
});

test("preserves structured RelayError code, details, provider_code and outcomeUnknown without swallowing", async context => {
  let response = {
    isError: true,
    structuredContent: {
      ok: false,
      code: "RELAY_RATE_LIMITED",
      message: "rate limited",
      outcome_unknown: false,
      details: { retry_after_ms: 4200, relay_key: "dev-train-main" },
    },
  };
  const { transport } = createInjectedFixture(context, { handler: () => response });

  await assert.rejects(transport.sendFrame(sampleFrameParams()), err => {
    assert.ok(err instanceof RelayError);
    assert.ok(err instanceof CoreError);
    assert.equal(err.code, "relay_rate_limited");
    assert.equal(err.outcomeUnknown, false);
    assert.equal(err.details.provider_code, "RELAY_RATE_LIMITED");
    assert.equal(err.details.retry_after_ms, 4200);
    assert.equal(err.details.relay_key, "dev-train-main");
    assert.equal(err.details.request_sent, true);
    return true;
  });

  response = {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        code: "RELAY_BRAND_NEW_UNKNOWN",
        outcomeUnknown: true,
        details: { hint: "keep-me" },
      }),
    }],
  };
  await assert.rejects(transport.status(), err => {
    assert.ok(err instanceof RelayError);
    assert.equal(err.code, "relay_provider_error");
    assert.equal(err.outcomeUnknown, true);
    assert.equal(err.details.provider_code, "RELAY_BRAND_NEW_UNKNOWN");
    assert.equal(err.details.hint, "keep-me");
    return true;
  });
});

/* ============================================================================
 * 3. Independent Dual Lanes, Write-Tool No-Retry & onRequestStarted Hook
 * ========================================================================== */

test("separates machine_relay and machine_bundle lanes and isolates disabled bundle lane", async context => {
  const { transport, stats } = createInjectedFixture(context);
  await transport.status();
  await transport.pollBundles({ cursor: null, limit: 10 });
  assert.equal(stats.clientsByLane.get(MACHINE_RELAY_LANE), 1);
  assert.equal(stats.clientsByLane.get(MACHINE_BUNDLE_LANE), 1);
  assert.deepEqual(stats.calls.map(c => [c.lane, c.request.name]), [
    [MACHINE_RELAY_LANE, "napcat_relay_status"],
    [MACHINE_BUNDLE_LANE, "napcat_file_bundle_poll"],
  ]);

  const { transport: noBundle, stats: noBundleStats } = createInjectedFixture(context, {
    transportOptions: { bundleEnabled: false },
  });
  assert.deepEqual(await noBundle.status(), { ok: true });
  for (const invoke of [
    () => noBundle.sendBundle(sampleBundleParams()),
    () => noBundle.pollBundles(),
    () => noBundle.readBundleEvents(),
    () => noBundle.ackBundleEvents({ event_ids: [HEX64_A] }),
  ]) {
    await assert.rejects(invoke, err => err instanceof CoreError && err.code === "bundle_transport_unavailable");
  }
  assert.equal(noBundleStats.clientsByLane.get(MACHINE_BUNDLE_LANE), undefined);
  assert.equal(noBundleStats.calls.length, 1);
});

test("maps provider-side disabled or unknown bundle tool errors to bundle_transport_unavailable", async context => {
  let mode = 0;
  const { transport } = createInjectedFixture(context, {
    handler() {
      mode += 1;
      if (mode === 1) {
        return { isError: true, structuredContent: { ok: false, code: "RELAY_FILE_INTEGRATION_DISABLED" } };
      }
      if (mode === 2) {
        return { isError: true, structuredContent: { ok: false, code: "RELAY_FILE_TOOL_UNKNOWN" } };
      }
      const rpcErr = new Error("Unknown tool: napcat_file_bundle_poll");
      rpcErr.code = -32601;
      throw rpcErr;
    },
  });

  await assert.rejects(transport.readBundleEvents(), err => err instanceof CoreError && err.code === "bundle_transport_unavailable");
  await assert.rejects(transport.sendBundle(sampleBundleParams()), err => err instanceof CoreError && err.code === "bundle_transport_unavailable");
  await assert.rejects(transport.pollBundles(), err => err instanceof CoreError && err.code === "bundle_transport_unavailable");
});

test("never auto-retries write tools on HTTP 404 session missing and always fires onRequestStarted before callTool", async context => {
  const startedOrder = [];
  const { transport, stats } = createInjectedFixture(context, {
    transportOptions: { baseUrl: LOOPBACK_URL, conversationId: SYNTHETIC_CID },
    handler(request) {
      startedOrder.push(`call:${request.name}`);
      throw missingBrokerSession(404);
    },
  });

  const writeCases = [
    {
      tool: "napcat_relay_send",
      run: hook => transport.sendFrame(sampleFrameParams(), { onRequestStarted: hook }),
    },
    {
      tool: "napcat_file_bundle_send",
      run: hook => transport.sendBundle(sampleBundleParams(), { onRequestStarted: hook }),
    },
    {
      tool: "napcat_file_bundle_events_ack",
      run: hook => transport.ackBundleEvents({ event_ids: [HEX64_A] }, { onRequestStarted: hook }),
    },
  ];

  for (const item of writeCases) {
    startedOrder.length = 0;
    const beforeCalls = stats.calls.length;
    await assert.rejects(
      item.run(() => startedOrder.push(`start:${item.tool}`)),
      err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.outcomeUnknown === true && err.details.request_sent === true,
    );
    assert.equal(stats.calls.length - beforeCalls, 1, `${item.tool} must never auto-retry on 404`);
    assert.deepEqual(startedOrder, [`start:${item.tool}`, `call:${item.tool}`]);
  }
});

test("real loopback HTTP server reconnects once on 404 for read tools while write tools never replay", async context => {
  const sessions = new Set();
  const dispatched = [];
  let initCount = 0;
  let seenHeader = null;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    seenHeader = req.headers["x-conversation-id"];
    let raw = "";
    for await (const chunk of req) raw += chunk.toString("utf8");
    const msg = JSON.parse(raw);
    const reply = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    };
    if (msg.method === "initialize") {
      const sid = `sid-${++initCount}`;
      sessions.add(sid);
      reply(200, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-relay", version: "1.0.0" },
        },
      }, { "mcp-session-id": sid });
      return;
    }
    if (!sessions.has(req.headers["mcp-session-id"])) {
      reply(404, { error: "Missing or invalid MCP session. Send initialize first." });
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    dispatched.push(msg.params.name);
    reply(200, {
      jsonrpc: "2.0",
      id: msg.id,
      result: { structuredContent: { ok: true, tool: msg.params.name } },
    });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const transport = new NapcatRelayTransport({
    baseUrl: `http://127.0.0.1:${port}/napcat/relay/mcp`,
    conversationId: SYNTHETIC_CID,
  });
  context.after(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  assert.deepEqual(await transport.status(), { ok: true, tool: "napcat_relay_status" });
  assert.equal(seenHeader, SYNTHETIC_CID);

  // Evict session -> read tool retries once and succeeds
  sessions.clear();
  assert.deepEqual(await transport.readEvents({ limit: 5 }), { ok: true, tool: "napcat_relay_events_read" });
  assert.equal(initCount, 2);

  // Evict session -> write tool MUST NOT retry
  sessions.clear();
  let startCalled = 0;
  await assert.rejects(
    transport.sendFrame(sampleFrameParams(), { onRequestStarted: () => { startCalled += 1; } }),
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.outcomeUnknown === true,
  );
  assert.equal(startCalled, 1);
  assert.equal(initCount, 2);
  assert.deepEqual(dispatched, ["napcat_relay_status", "napcat_relay_events_read"]);
});

/* ============================================================================
 * 4. All 8 Methods Parameter Validation (Block A & Block B)
 * ========================================================================== */

test("validates all Block A (4 methods) and Block B (4 methods) schemas strictly", async context => {
  const { transport, stats } = createInjectedFixture(context);

  // Block A: sendFrame allows all 15 ops and empty body ""
  for (const op of RELAY_ALLOWED_OPS) {
    await transport.sendFrame(sampleFrameParams({ op, body: "" }));
  }
  assert.equal(stats.calls.length, 15);
  assert.equal(stats.calls[0].request.arguments.body, "");

  // Block A invalid inputs
  for (const bad of [
    sampleFrameParams({ op: "unknown_op" }),
    sampleFrameParams({ recipients: [] }),
    sampleFrameParams({ recipients: Array.from({ length: 17 }, (_, i) => `codex/desktop/c${i}`) }),
    sampleFrameParams({ body: 123 }),
    sampleFrameParams({ reply_relay_key: "r1" }), // partial reply triple
    sampleFrameParams({ reply_relay_key: "r1", reply_group_id: "900001" }),
    sampleFrameParams({ reply_relay_key: "r1", reply_group_id: "900001", reply_route_generation: 0 }),
    sampleFrameParams({ allow_disclose_recipients: "true" }),
  ]) {
    await assert.rejects(transport.sendFrame(bad), err => err instanceof CoreError && err.code === "invalid_input");
  }
  await assert.rejects(transport.poll({ relay_keys: [] }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.poll({ max_pages: 51 }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.readEvents({ limit: 51 }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.readEvents({ limit: 0 }), err => err instanceof CoreError && err.code === "invalid_input");

  // Block B: sendBundle 7 required keys + attachments <= 63 + disallowed ops
  const missingKeyCases = ["dedupe_key", "target_machine", "op", "source", "recipients", "meta", "payload_json"];
  for (const key of missingKeyCases) {
    const partial = sampleBundleParams();
    delete partial[key];
    await assert.rejects(transport.sendBundle(partial), err => err instanceof CoreError && err.code === "invalid_input");
  }
  await assert.rejects(transport.sendBundle(sampleBundleParams({ op: "file_notice" })), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.sendBundle(sampleBundleParams({ op: "file_ack" })), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(
    transport.sendBundle(sampleBundleParams({
      attachments: Array.from({ length: 64 }, (_, i) => ({ name: `f${i}.bin`, filePath: `/tmp/f${i}.bin` })),
    })),
    err => err instanceof CoreError && err.code === "invalid_input",
  );
  await assert.rejects(
    transport.sendBundle(sampleBundleParams({ attachments: [{ name: "a.txt", filePath: "/tmp/a.txt", extra: 1 }] })),
    err => err instanceof CoreError && err.code === "invalid_input",
  );
  const circular = {};
  circular.self = circular;
  await assert.rejects(transport.sendBundle(sampleBundleParams({ payload_json: circular })), err => err instanceof CoreError && err.code === "invalid_input");

  // Valid 63 attachments succeeds
  await transport.sendBundle(sampleBundleParams({
    attachments: Array.from({ length: 63 }, (_, i) => ({ name: `f${i}.bin`, filePath: `/synthetic/f${i}.bin` })),
    reply_relay_key: "dev-train-main",
    reply_group_id: "900001",
    reply_route_generation: 2,
    allow_disclose_recipients: true,
  }));

  // Block B: pollBundles, readBundleEvents, ackBundleEvents cursor/limit/event_ids
  for (const badCursor of ["not-hex", "A".repeat(64), "a".repeat(63), "a".repeat(65), 123]) {
    await assert.rejects(transport.pollBundles({ cursor: badCursor }), err => err instanceof CoreError && err.code === "invalid_input");
    await assert.rejects(transport.readBundleEvents({ cursor: badCursor }), err => err instanceof CoreError && err.code === "invalid_input");
  }
  await assert.rejects(transport.pollBundles({ limit: 33 }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.readBundleEvents({ limit: 33 }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.ackBundleEvents({ event_ids: [] }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(transport.ackBundleEvents({ event_ids: ["bad-id"] }), err => err instanceof CoreError && err.code === "invalid_input");
  await assert.rejects(
    transport.ackBundleEvents({ event_ids: Array.from({ length: 33 }, () => HEX64_A) }),
    err => err instanceof CoreError && err.code === "invalid_input",
  );

  // Valid Block B calls pass exact parameters
  await transport.pollBundles({ relay_keys: ["dev-train-main"], cursor: HEX64_A, limit: 32 });
  await transport.readBundleEvents({ cursor: null, limit: 16 });
  await transport.ackBundleEvents({ event_ids: [HEX64_A, HEX64_B] });
  assert.deepEqual(stats.calls.at(-1).request, {
    name: "napcat_file_bundle_events_ack",
    arguments: { event_ids: [HEX64_A, HEX64_B] },
  });
});

/* ============================================================================
 * 5. AddressBook Projection & Block A -> Block B Route Mapping
 * ========================================================================== */

test("projectRelayRoutesForAddressBook outputs exact 7 sanitized fields compatible with ConversationAddressBook", () => {
  const statusResponse = {
    ok: true,
    routes: [
      {
        relay_key: "dev-train-v2",
        generation: 2,
        group_id: "900002",
        expected_group_name: "Dev-Train Main Relay",
        channel: "qq",
        local_machine_id: "dev-machine",
        expected_self_id: "100001",
        peer_machine_id: "train-machine",
        peer_qq_id: "200002",
        role: "active_write",
        enabled: true,
        secret_token: "must-never-leak",
        cookie: "must-never-leak",
      },
      {
        relay_key: "dev-train-v1",
        generation: 1,
        group_id: "900001",
        channel: "qq",
        local_machine_id: "dev-machine",
        expected_self_id: "100001",
        peer_machine_id: "train-machine",
        peer_qq_id: "200002",
        role: "draining_read",
        enabled: true,
        api_key: "must-never-leak",
      },
    ],
  };

  const projected = projectRelayRoutesForAddressBook(statusResponse);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[0], {
    machine_id: "train-machine",
    channel: "qq",
    group_label: "Dev-Train Main Relay",
    group_id: "900002",
    account_id: "200002",
    enabled: true,
    relay_mode: "group",
  });
  assert.deepEqual(projected[1], {
    machine_id: "train-machine",
    channel: "qq",
    group_label: "dev-train-v1",
    group_id: "900001",
    account_id: "200002",
    enabled: false,
    relay_mode: "group_draining",
  });
  assert.equal(JSON.stringify(projected).includes("must-never-leak"), false);

  // Verify direct compatibility with real ConversationAddressBook
  const db = new DatabaseSync(":memory:");
  try {
    const book = new ConversationAddressBook({
      database: db,
      machineId: "dev-machine",
      machineRoutes: projected,
    });
    assert.ok(book);
  } finally {
    db.close();
  }
});

test("mapRelayRouteToBundleRoute maps Block A snake_case fields to Block B camelCase without leaking secrets", () => {
  const route = {
    relay_key: "dev-train-v2",
    generation: 3,
    group_id: "900002",
    channel: "qq",
    local_machine_id: "dev-machine",
    expected_self_id: "100001",
    peer_machine_id: "train-machine",
    peer_qq_id: "200002",
    token: "secret-should-drop",
  };
  const mapped = mapRelayRouteToBundleRoute(route);
  assert.deepEqual(mapped, {
    relayId: "dev-train-v2",
    generation: 3,
    groupId: "900002",
    channel: "qq",
    selfQqId: "100001",
    peerQqId: "200002",
    localMachineId: "dev-machine",
    peerMachineId: "train-machine",
  });
  assert.equal(Object.hasOwn(mapped, "token"), false);

  const withDisclosure = mapRelayRouteToBundleRoute(route, { disclosesRecipients: true });
  assert.equal(withDisclosure.disclosesRecipients, true);
});

/* ============================================================================
 * 6. InMemoryRelayBus: 3-Node End-to-End, Rotation, Coexistence, CQ, Rate Limit,
 *    Dedupe, Cursor/Gap & File-Bundle Spool Release
 * ========================================================================== */

test("InMemoryRelayBus supports 3 nodes, route rotation/draining, drain expiry, legacy coexistence, disclosure and CQ limits", async context => {
  let clockMs = Date.parse("2026-11-27T08:00:00.000Z");
  const bus = new InMemoryRelayBus({ now: () => clockMs });

  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100001", bundle_enabled: true });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200002", bundle_enabled: true });
  bus.registerMachine({ machine_id: "obs-machine", qq_id: "300003", bundle_enabled: false });

  // Route 1: dev <-> train (initially legacy_training_coexistence: true -> forces allow_file_bundle_write: false)
  const legacyRoute = bus.registerRoute({
    relay_key: "dev-train-legacy",
    group_id: "900001",
    expected_group_name: "Legacy Coexist Group",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    legacy_training_coexistence: true,
    allow_file_bundle_write: true, // MUST be forced to false
    allow_recipient_list_disclosure: false,
    rate_limit_per_minute: 2,
  });
  assert.equal(legacyRoute.allow_file_bundle_write, false);

  // Route 2: dev <-> obs
  bus.registerRoute({
    relay_key: "dev-obs-main",
    group_id: "900099",
    members: ["dev-machine", "obs-machine"],
    generation: 1,
    allow_recipient_list_disclosure: true,
  });

  const dev = bus.createTransportFor("dev-machine");
  const train = bus.createTransportFor("train-machine");
  const obs = bus.createTransportFor("obs-machine");
  context.after(async () => {
    await Promise.all([dev.close(), train.close(), obs.close()]);
  });

  // Status + AddressBook projection
  const devStatus = await dev.status({ include_live_check: true });
  assert.equal(devStatus.local_machine_id, "dev-machine");
  assert.equal(devStatus.live_check.ok, true);
  assert.equal(projectRelayRoutesForAddressBook(devStatus).length, 2);

  // Legacy coexistence blocks file bundle writes while permitting text relay
  await assert.rejects(
    dev.sendBundle(sampleBundleParams({ dedupe_key: "legacy-bundle-blocked" })),
    err => err instanceof RelayError && err.code === "relay_file_route_denied",
  );

  // Multiple recipients blocked when allow_recipient_list_disclosure === false
  await assert.rejects(
    dev.sendFrame(sampleFrameParams({
      dedupe_key: "multi-blocked",
      recipients: ["codex/desktop/t1", "antigravity/desktop/t2"],
    })),
    err => err instanceof RelayError && err.code === "relay_recipient_disclosure_blocked",
  );

  // CQ expansion exceeds 1800 even when UTF-16 length <= 1800
  const cqHeavyBody = "[],&".repeat(350); // 1400 UTF-16 chars, +5600 CQ expansion -> 7000 > 1800
  await assert.rejects(
    dev.sendFrame(sampleFrameParams({ dedupe_key: "cq-overflow", body: cqHeavyBody })),
    err => {
      assert.ok(err instanceof RelayError);
      assert.equal(err.code, "relay_frame_too_large");
      assert.ok(err.details.frame_length <= 1800);
      assert.ok(err.details.cq_encoded_length > 1800);
      assert.equal(err.details.suggest_file_bundle, true);
      return true;
    },
  );

  // Send frame gen=1 on dev-train-legacy + dedupe idempotency & conflict
  const sent1 = await dev.sendFrame(sampleFrameParams({ dedupe_key: "k-1", body: "hello gen 1" }));
  assert.equal(sent1.status, "sent_verified");
  assert.equal(sent1.transport_stage, "group_received");
  assert.equal(sent1.relay_key, "dev-train-legacy");
  assert.equal(sent1.route_generation, 1);
  assert.match(sent1.body_sha256, /^[a-f0-9]{64}$/u);
  assert.ok(sent1.frame_length > 0);

  const dup1 = await dev.sendFrame(sampleFrameParams({ dedupe_key: "k-1", body: "hello gen 1" }));
  assert.equal(dup1.status, "duplicate");
  assert.equal(dup1.relay_id, sent1.relay_id);

  await assert.rejects(
    dev.sendFrame(sampleFrameParams({ dedupe_key: "k-1", body: "tampered body" })),
    err => err instanceof RelayError && err.code === "relay_dedupe_conflict",
  );

  // Rate limit per minute (limit=2) -> 2nd succeeds, 3rd hits RELAY_RATE_LIMITED with retry_after_ms
  await dev.sendFrame(sampleFrameParams({ dedupe_key: "k-2", body: "second within minute" }));
  await assert.rejects(
    dev.sendFrame(sampleFrameParams({ dedupe_key: "k-3", body: "third rate limited" })),
    err => err instanceof RelayError && err.code === "relay_rate_limited" && err.details.retry_after_ms > 0,
  );
  clockMs += 60_001;
  await dev.sendFrame(sampleFrameParams({ dedupe_key: "k-3", body: "third after window" }));

  // Train polls & reads events (dev self-echo ignored when dev polls)
  const devSelfPoll = await dev.poll();
  assert.equal(devSelfPoll.ingested_count, 0);
  assert.equal(devSelfPoll.ignored_count, 3);

  const trainPoll = await train.poll();
  assert.equal(trainPoll.ingested_count, 3);
  assert.equal(trainPoll.scanned_routes.length, 1);
  const trainRead = await train.readEvents({ limit: 10 });
  assert.equal(trainRead.events.length, 3);
  assert.equal(trainRead.events[0].frame.body, "hello gen 1");

  // Rotate route: old becomes draining_read (gen=1, drain_until +30m), new becomes active_write (gen=2, bundle enabled)
  const drainDeadline = clockMs + 30 * 60_000;
  bus.rotateRoute({
    from_relay_key: "dev-train-legacy",
    new_relay_key: "dev-train-v2",
    new_group_id: "900002",
    drain_until: drainDeadline,
    legacy_training_coexistence: false,
    allow_file_bundle_write: true,
    allow_recipient_list_disclosure: true,
  });

  // Fresh sends automatically use active_write gen=2
  const sentGen2 = await dev.sendFrame(sampleFrameParams({ dedupe_key: "k-gen2", body: "on new group" }));
  assert.equal(sentGen2.relay_key, "dev-train-v2");
  assert.equal(sentGen2.group_id, "900002");
  assert.equal(sentGen2.route_generation, 2);

  // Train replies to old gen=1 message pinned to original triple while within drain_until
  const replyGen1 = await train.sendFrame({
    dedupe_key: "ack-gen1-ok",
    target_machine: "dev-machine",
    reply_relay_key: "dev-train-legacy",
    reply_group_id: "900001",
    reply_route_generation: 1,
    op: "processing_ack",
    source: "codex/desktop/train-conv-1",
    recipients: ["antigravity/desktop/dev-conv-1"],
    in_reply_to: sent1.relay_id,
    body: "done",
  });
  assert.equal(replyGen1.relay_key, "dev-train-legacy");
  assert.equal(replyGen1.route_generation, 1);

  // Wrong generation pinned -> relay_route_changed
  await assert.rejects(
    train.sendFrame({
      dedupe_key: "ack-wrong-gen",
      target_machine: "dev-machine",
      reply_relay_key: "dev-train-legacy",
      reply_group_id: "900001",
      reply_route_generation: 99,
      op: "processing_ack",
      source: "codex/desktop/train-conv-1",
      recipients: ["antigravity/desktop/dev-conv-1"],
      body: "done",
    }),
    err => err instanceof RelayError && err.code === "relay_route_changed",
  );

  // Advance clock beyond drain_until -> relay_route_drain_expired
  clockMs = drainDeadline + 1000;
  await assert.rejects(
    train.sendFrame({
      dedupe_key: "ack-after-drain",
      target_machine: "dev-machine",
      reply_relay_key: "dev-train-legacy",
      reply_group_id: "900001",
      reply_route_generation: 1,
      op: "processing_ack",
      source: "codex/desktop/train-conv-1",
      recipients: ["antigravity/desktop/dev-conv-1"],
      body: "late",
    }),
    err => err instanceof RelayError && err.code === "relay_route_drain_expired",
  );

  // 3rd node (obs-machine) can exchange text frames while its bundle channel reports unavailable
  await dev.sendFrame(sampleFrameParams({
    dedupe_key: "dev-to-obs",
    target_machine: "obs-machine",
    recipients: ["codex/desktop/obs-1", "antigravity/desktop/obs-2"],
    body: "hello observer",
  }));
  const obsPoll = await obs.poll();
  assert.equal(obsPoll.ingested_count, 1);
  await assert.rejects(obs.readBundleEvents(), err => err instanceof CoreError && err.code === "bundle_transport_unavailable");
});

test("InMemoryRelayBus simulates cursor errors, history gaps, custom frameCodec and file-bundle spool ack release", async context => {
  const bus = new InMemoryRelayBus({
    frameCodec: {
      encode(input) {
        const frameText = `[CUSTOM]\n${input.body}`;
        return {
          relayId: "rly_custom_codec_1",
          frameText,
          bodySha256: HEX64_C,
        };
      },
    },
  });
  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100001", bundle_enabled: true });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200002", bundle_enabled: true });
  bus.registerRoute({
    relay_key: "dev-train-main",
    group_id: "900002",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    allow_file_bundle_write: true,
    allow_recipient_list_disclosure: true,
  });

  const dev = bus.createTransportFor("dev-machine");
  const train = bus.createTransportFor("train-machine");
  context.after(async () => {
    await Promise.all([dev.close(), train.close()]);
  });

  // Custom frameCodec verification
  const sentCustom = await dev.sendFrame(sampleFrameParams({ dedupe_key: "custom-1", body: "hello" }));
  assert.equal(sentCustom.relay_id, "rly_custom_codec_1");
  assert.equal(sentCustom.body_sha256, HEX64_C);
  await dev.sendFrame(sampleFrameParams({ dedupe_key: "custom-2", body: "world" }));

  // Inject history gap and verify both poll.history_gaps and readEvents.route_gaps
  bus.injectHistoryGap("train-machine", "dev-train-main", {
    code: "RELAY_HISTORY_GAP",
    message: "synthetic gap",
    from_seq: 10,
    to_seq: 15,
  });
  const polled = await train.poll();
  assert.equal(polled.history_gaps.length, 1);
  assert.equal(polled.history_gaps[0].code, "RELAY_HISTORY_GAP");

  const page1 = await train.readEvents({ limit: 1 });
  assert.equal(page1.events.length, 1);
  assert.equal(page1.has_more, true);
  assert.equal(page1.route_gaps.length, 1);

  // Cursor invalid & scope mismatch & expired
  await assert.rejects(
    train.readEvents({ cursor: "!!!not-base64-json!!!" }),
    err => err instanceof RelayError && err.code === "relay_cursor_invalid",
  );
  await assert.rejects(
    train.readEvents({ cursor: page1.next_cursor, relay_key: "dev-train-main" }),
    err => err instanceof RelayError && err.code === "relay_cursor_scope_mismatch",
  );
  bus.trimEvents("train-machine", 0);
  await assert.rejects(
    train.readEvents({ cursor: page1.next_cursor }),
    err => err instanceof RelayError && err.code === "relay_cursor_expired",
  );

  // File-bundle end-to-end with spool tracking & ack release
  const bundleSent = await dev.sendBundle(sampleBundleParams({
    dedupe_key: "bundle-e2e-1",
    recipients: ["codex/desktop/t1", "antigravity/desktop/t2"],
    payload_json: { kind: "large_snapshot", content: "x".repeat(4000) },
    attachments: [{ name: "report.bin", filePath: "/synthetic/report.bin" }],
  }));
  assert.equal(bundleSent.status, "sent_verified");
  assert.equal(bundleSent.relay_key, "dev-train-main");
  assert.equal(bus.getSpoolStats("dev-machine").outgoingCount, 1);
  assert.ok(bus.getSpoolStats("dev-machine").outgoingBytes > 4000);

  // Bundle dedupe idempotency & conflict
  const bundleDup = await dev.sendBundle(sampleBundleParams({
    dedupe_key: "bundle-e2e-1",
    recipients: ["codex/desktop/t1", "antigravity/desktop/t2"],
    payload_json: { kind: "large_snapshot", content: "x".repeat(4000) },
    attachments: [{ name: "report.bin", filePath: "/synthetic/report.bin" }],
  }));
  assert.equal(bundleDup.status, "duplicate");
  await assert.rejects(
    dev.sendBundle(sampleBundleParams({
      dedupe_key: "bundle-e2e-1",
      recipients: ["codex/desktop/t1"],
      payload_json: { kind: "tampered" },
    })),
    err => err instanceof RelayError && err.code === "relay_file_id_conflict",
  );

  // Train polls & reads bundle events -> incoming spool occupied
  const bundlePoll = await train.pollBundles({ relay_keys: ["dev-train-main"], cursor: null, limit: 10 });
  assert.equal(bundlePoll.results.length, 1);
  assert.equal(bus.getSpoolStats("train-machine").incomingCount, 1);
  assert.ok(bus.getSpoolStats("train-machine").incomingBytes > 4000);

  const bundleRead = await train.readBundleEvents({ cursor: null, limit: 10 });
  assert.equal(bundleRead.events.length, 1);
  const evt = bundleRead.events[0];
  assert.match(evt.event_id, /^[a-f0-9]{64}$/u);
  assert.equal(evt.payload_json.kind, "large_snapshot");
  assert.equal(evt.sender_id, "100001");
  assert.equal(evt.staged_files.length, 1);
  assert.equal(evt.staged_files[0].name, "report.bin");

  // Ack releases both incoming & outgoing spool deterministically and is idempotent
  const ackRes = await train.ackBundleEvents({ event_ids: [evt.event_id] });
  assert.deepEqual(ackRes, {
    ok: true,
    results: [{ event_id: evt.event_id, status: "recorded", release: "released" }],
    not_found: [],
  });
  assert.equal(bus.getSpoolStats("train-machine").totalBytes, 0);
  assert.equal(bus.getSpoolStats("dev-machine").totalBytes, 0);

  const ackAgain = await train.ackBundleEvents({ event_ids: [evt.event_id, HEX64_A] });
  assert.deepEqual(ackAgain, {
    ok: true,
    results: [{ event_id: evt.event_id, status: "recorded", release: "released" }],
    not_found: [HEX64_A],
  });
  const afterAckRead = await train.readBundleEvents({ cursor: null, limit: 10 });
  assert.equal(afterAckRead.events.length, 0);
});

/* ============================================================================
 * 7. Deterministic close() Cleanup & Node 24 Active Resource Delta Zero Check
 * ========================================================================== */

test("close() deterministically aborts inflight calls, clears timers/lanes and leaves zero active resource delta", async () => {
  await nextTurn();
  const beforeResources = countResources();

  const transport = new NapcatRelayTransport({
    timeoutMs: 60_000,
    bundleTimeoutMs: 60_000,
    clientFactory() {
      return {
        async connect() {},
        async callTool(_req, _schema, options) {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        async close() {},
      };
    },
  });

  const inflightRelay = transport.status();
  const inflightBundle = transport.readBundleEvents();
  await nextTurn();

  const during = transport.getActiveHandleCounts();
  assert.equal(during.timers, 2);
  assert.equal(during.controllers, 2);
  assert.equal(during.connections, 2);

  await transport.close();
  await transport.close(); // idempotent

  await assert.rejects(inflightRelay, err => err instanceof RelayError && err.code === "relay_transport_unconfirmed");
  await assert.rejects(inflightBundle, err => err instanceof RelayError && err.code === "relay_transport_unconfirmed");
  await assert.rejects(transport.status(), err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.details.request_sent === false);

  assert.equal(transport.closed, true);
  assert.deepEqual(transport.getActiveHandleCounts(), {
    timers: 0,
    controllers: 0,
    connections: 0,
    closing: 0,
  });

  await nextTurn();
  const afterResources = countResources();
  for (const [resource, count] of afterResources.entries()) {
    assert.ok(
      count <= (beforeResources.get(resource) ?? 0),
      `active resource "${resource}" leaked: before=${beforeResources.get(resource) ?? 0}, after=${count}`,
    );
  }
});

test("supports dedicated bundle lane override, onRequestStarted abort guard, timeout cleanup and ambiguous/missing routes", async context => {
  // Dedicated bundle clientFactory separate from relay clientFactory
  const laneHits = [];
  const splitTransport = new NapcatRelayTransport({
    clientFactory(lane) {
      laneHits.push(`relay-factory:${lane}`);
      return {
        async connect() {},
        async callTool({ name }) { return { structuredContent: { ok: true, from: "relay", name } }; },
        async close() {},
      };
    },
    bundleClientFactory(lane) {
      laneHits.push(`bundle-factory:${lane}`);
      return {
        async connect() {},
        async callTool({ name }) { return { structuredContent: { ok: true, from: "bundle", name } }; },
        async close() {},
      };
    },
  });
  context.after(() => splitTransport.close());
  assert.equal((await splitTransport.status()).from, "relay");
  assert.equal((await splitTransport.pollBundles()).from, "bundle");
  assert.deepEqual(laneHits, [`relay-factory:${MACHINE_RELAY_LANE}`, `bundle-factory:${MACHINE_BUNDLE_LANE}`]);

  // If onRequestStarted aborts signal, callTool must never run and request_sent stays false
  let callToolRuns = 0;
  const abortTransport = new NapcatRelayTransport({
    clientFactory() {
      return {
        async connect() {},
        async callTool() { callToolRuns += 1; return { structuredContent: { ok: true } }; },
        async close() {},
      };
    },
  });
  context.after(() => abortTransport.close());
  const ac = new AbortController();
  await assert.rejects(
    abortTransport.sendFrame(sampleFrameParams(), {
      signal: ac.signal,
      onRequestStarted() { ac.abort(); },
    }),
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.details.request_sent === false,
  );
  assert.equal(callToolRuns, 0);
  await nextTurn();
  assert.deepEqual(abortTransport.getActiveHandleCounts(), { timers: 0, controllers: 0, connections: 0, closing: 0 });

  // Timeout aborts cleanly and clears timers
  const slowTransport = new NapcatRelayTransport({
    timeoutMs: 120,
    clientFactory() {
      return {
        async connect() {},
        async callTool() { return new Promise(() => {}); },
        async close() {},
      };
    },
  });
  context.after(() => slowTransport.close());
  await assert.rejects(
    slowTransport.status(),
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.outcomeUnknown === true,
  );
  assert.equal(slowTransport.getActiveHandleCounts().timers, 0);
  assert.equal(slowTransport.getActiveHandleCounts().controllers, 0);

  // Ambiguous route, missing route and draining_read blocking new sendBundle on InMemoryRelayBus
  const bus = new InMemoryRelayBus();
  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100001" });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200002" });
  bus.registerMachine({ machine_id: "orphan-machine", qq_id: "400004" });
  bus.registerRoute({ relay_key: "r-a", group_id: "910001", members: ["dev-machine", "train-machine"], generation: 1 });
  bus.registerRoute({ relay_key: "r-b", group_id: "910002", members: ["dev-machine", "train-machine"], generation: 1 });
  const dev = bus.createTransportFor("dev-machine");
  context.after(() => dev.close());

  await assert.rejects(
    dev.sendFrame(sampleFrameParams({ dedupe_key: "ambig-1" })),
    err => err instanceof RelayError && err.code === "relay_route_ambiguous",
  );
  await assert.rejects(
    dev.sendFrame(sampleFrameParams({ dedupe_key: "notfound-1", target_machine: "orphan-machine" })),
    err => err instanceof RelayError && err.code === "relay_route_not_found",
  );

  // Mark r-a as draining_read -> pinned sendBundle to r-a must be rejected
  bus.setRouteState("r-a", { role: "draining_read" });
  await assert.rejects(
    dev.sendBundle(sampleBundleParams({
      dedupe_key: "draining-bundle-1",
      reply_relay_key: "r-a",
      reply_group_id: "910001",
      reply_route_generation: 1,
    })),
    err => err instanceof RelayError && err.code === "relay_file_route_denied",
  );
});

/* ============================================================================
 * 8. Round-2 Adversarial Review Regressions (P1-1, P1-1A, P1-6, P2-2 & sender_id)
 * ========================================================================== */

test("P1-1: InMemoryRelayBus accepts real relay-envelope module (prefers encodeRelayFrame) and maps relay_frame_too_large cleanly", async context => {
  const bus = new InMemoryRelayBus({ frameCodec: relayEnvelope });
  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100001", bundle_enabled: true });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200002", bundle_enabled: true });
  bus.registerRoute({
    relay_key: "dev-train-real-codec",
    group_id: "920001",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    allow_file_bundle_write: true,
    allow_recipient_list_disclosure: true,
  });

  const dev = bus.createTransportFor("dev-machine");
  const train = bus.createTransportFor("train-machine");
  context.after(async () => {
    await Promise.all([dev.close(), train.close()]);
  });

  // Normal send runs real encodeRelayFrame and decodes cleanly via real decodeRelayFrame
  const sent = await dev.sendFrame(sampleFrameParams({
    dedupe_key: "real-codec-ok",
    body: "line1\n\nline3",
  }));
  assert.equal(sent.status, "sent_verified");
  assert.equal(sent.outcome_unknown, false);
  await train.poll();
  const read = await train.readEvents({ limit: 5 });
  assert.equal(read.events.length, 1);
  const rawFrame = read.events[0].frame.raw_frame;
  const decoded = relayEnvelope.decodeRelayFrame(rawFrame);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.frame.body, "line1\n\nline3");

  // Oversized frame thrown by real encodeRelayFrame MUST become RelayError("relay_frame_too_large"), never relay_transport_unconfirmed
  await assert.rejects(
    dev.sendFrame(sampleFrameParams({
      dedupe_key: "real-codec-too-large",
      body: "[,&]".repeat(400),
    })),
    err => {
      assert.ok(err instanceof RelayError);
      assert.equal(err.code, "relay_frame_too_large");
      assert.equal(err.outcomeUnknown, false);
      assert.equal(err.details.provider_code, "RELAY_FRAME_TOO_LARGE");
      assert.equal(err.details.suggest_file_bundle, true);
      assert.equal(err.details.max_frame_chars, 1800);
      assert.ok(err.details.cq_encoded_length > 1800);
      assert.ok(typeof err.details.frame_length === "number" && err.details.frame_length > 0);
      return true;
    },
  );

  // When both encodeRelayFrame and encode exist on frameCodec, prefer encodeRelayFrame
  const called = [];
  const dualCodecBus = new InMemoryRelayBus({
    frameCodec: {
      encodeRelayFrame(input, opts) {
        called.push("encodeRelayFrame");
        return relayEnvelope.encodeRelayFrame(input, opts);
      },
      encode() {
        called.push("encode");
        throw new Error("should not call legacy encode when encodeRelayFrame exists");
      },
    },
  });
  dualCodecBus.registerMachine({ machine_id: "dev-machine", qq_id: "100001" });
  dualCodecBus.registerMachine({ machine_id: "train-machine", qq_id: "200002" });
  dualCodecBus.registerRoute({
    relay_key: "dev-train-dual",
    group_id: "920002",
    members: ["dev-machine", "train-machine"],
    generation: 1,
  });
  const dualDev = dualCodecBus.createTransportFor("dev-machine");
  context.after(() => dualDev.close());
  await dualDev.sendFrame(sampleFrameParams({ dedupe_key: "dual-1" }));
  assert.deepEqual(called, ["encodeRelayFrame"]);
});

test("P1-1A: cancelling or timing out one request on a lane does not tear down another inflight write request on the same lane", async context => {
  let clientCloses = 0;
  let wireCloses = 0;
  let connectCount = 0;
  let releaseWrite;
  const writeEntered = new Promise(resolve => {
    releaseWrite = resolve;
  });
  let finishWrite;
  const writeDoneGate = new Promise(resolve => {
    finishWrite = resolve;
  });

  const transport = new NapcatRelayTransport({
    transportFactory() {
      return {
        async start() {},
        async send() {},
        async close() { wireCloses += 1; },
      };
    },
    clientFactory() {
      return {
        async connect() { connectCount += 1; },
        async callTool({ name }, _schema, callOpts) {
          if (name === "napcat_relay_send") {
            releaseWrite();
            await writeDoneGate;
            return { structuredContent: { ok: true, status: "sent_verified", relay_id: "rly_inflight_ok" } };
          }
          return new Promise((_resolve, reject) => {
            callOpts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        async close() { clientCloses += 1; },
      };
    },
  });
  context.after(() => transport.close());

  // Start long-running write request on MACHINE_RELAY_LANE
  const writePromise = transport.sendFrame(sampleFrameParams({ dedupe_key: "concurrent-write-1" }));
  await writeEntered;

  // Concurrent read on same lane cancelled by external AbortSignal
  const ac = new AbortController();
  const readAbortPromise = transport.status({}, { signal: ac.signal });
  await nextTurn();
  ac.abort();
  await assert.rejects(
    readAbortPromise,
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed",
  );

  // Concurrent read on same lane hitting short per-request timeout
  await assert.rejects(
    transport.status({}, { timeoutMs: 100 }),
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed",
  );

  // Shared connection MUST remain open with zero disconnects while write is still inflight
  assert.equal(clientCloses, 0);
  assert.equal(wireCloses, 0);
  assert.equal(connectCount, 1);
  assert.equal(transport.getActiveHandleCounts().connections, 1);

  // Release write -> succeeds cleanly on the same connection
  finishWrite();
  const writeRes = await writePromise;
  assert.equal(writeRes.relay_id, "rly_inflight_ok");
  assert.equal(connectCount, 1);

  // Closing transport prefers client.close() without double-closing wire transport
  await transport.close();
  assert.equal(clientCloses, 1);
  assert.equal(wireCloses, 0);

  // When client.close() throws, #disconnect falls back to transport.close()
  let fallbackWireCloses = 0;
  const fallbackTransport = new NapcatRelayTransport({
    transportFactory() {
      return {
        async start() {},
        async send() {},
        async close() { fallbackWireCloses += 1; },
      };
    },
    clientFactory() {
      return {
        async connect() {},
        async callTool() { return { structuredContent: { ok: true } }; },
        async close() { throw new Error("client close failed"); },
      };
    },
  });
  await fallbackTransport.status();
  await fallbackTransport.close();
  assert.equal(fallbackWireCloses, 1);
});

test("P1-1A: aborting the first caller during connect does not abort shared connect for a concurrent peer on the same lane", async context => {
  let finishConnect;
  const connectGate = new Promise(resolve => {
    finishConnect = resolve;
  });
  let receivedConnectSignal = null;
  let clientCloses = 0;

  const transport = new NapcatRelayTransport({
    clientFactory() {
      return {
        async connect(_wire, opts) {
          receivedConnectSignal = opts.signal;
          await connectGate;
        },
        async callTool({ name }) {
          return { structuredContent: { ok: true, tool: name } };
        },
        async close() { clientCloses += 1; },
      };
    },
  });
  context.after(() => transport.close());

  const ac1 = new AbortController();
  const firstCall = transport.status({}, { signal: ac1.signal });
  const secondCall = transport.readEvents({ limit: 5 });
  await nextTurn();

  // First caller aborts before connect finishes -> shared connectSignal MUST NOT abort
  ac1.abort();
  await assert.rejects(
    firstCall,
    err => err instanceof RelayError && err.code === "relay_transport_unconfirmed" && err.details.request_sent === false,
  );
  assert.equal(receivedConnectSignal.aborted, false);
  assert.equal(clientCloses, 0);

  // Connect resolves -> second caller completes cleanly
  finishConnect();
  const res = await secondCall;
  assert.equal(res.tool, "napcat_relay_events_read");
});

test("P1-6 & sender_id: enforces 80-byte limits on bundle target_machine/relay_keys, maps RELAY_FILE_RESUME_LIMIT, and attaches verified sender_id", async context => {
  assert.equal(RELAY_ERROR_CODE_MAP.RELAY_FILE_RESUME_LIMIT, "relay_file_resume_limit");
  assert.equal(mapRelayProviderErrorCode("RELAY_FILE_RESUME_LIMIT"), "relay_file_resume_limit");

  const { transport } = createInjectedFixture(context);
  const ok80 = "m".repeat(80);
  const bad81 = "m".repeat(81);

  await transport.sendBundle(sampleBundleParams({ target_machine: ok80 }));
  await assert.rejects(
    transport.sendBundle(sampleBundleParams({ target_machine: bad81 })),
    err => err instanceof CoreError && err.code === "invalid_input",
  );

  await transport.pollBundles({ relay_keys: [ok80] });
  await assert.rejects(
    transport.pollBundles({ relay_keys: [bad81] }),
    err => err instanceof CoreError && err.code === "invalid_input",
  );

  // Block A poll still permits relay_key > 80 bytes (up to 256)
  await transport.poll({ relay_keys: [bad81] });

  // Verified sender_id on InMemoryRelayBus readBundleEvents ignores spoofed meta/payload sender_id
  const bus = new InMemoryRelayBus();
  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100088", bundle_enabled: true });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200099", bundle_enabled: true });
  bus.registerRoute({
    relay_key: "dev-train-sender-check",
    group_id: "930001",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    allow_file_bundle_write: true,
    allow_recipient_list_disclosure: true,
  });
  const dev = bus.createTransportFor("dev-machine");
  const train = bus.createTransportFor("train-machine");
  context.after(async () => {
    await Promise.all([dev.close(), train.close()]);
  });

  await dev.sendBundle(sampleBundleParams({
    dedupe_key: "bundle-spoof-sender",
    meta: { request_id: "req-spoof", hop_count: 1, sender_id: "999999999" },
    payload_json: { sender_id: "888888888", body: "spoof attempt" },
  }));
  await train.pollBundles({ relay_keys: ["dev-train-sender-check"], cursor: null, limit: 10 });
  const eventsRes = await train.readBundleEvents({ cursor: null, limit: 10 });
  assert.equal(eventsRes.events.length, 1);
  assert.equal(eventsRes.events[0].sender_id, "100088");
  assert.equal(eventsRes.events[0].source_machine, "dev-machine");
});

test("P2-2: InMemoryRelayBus isolates per-route event retention and bounds group messages without breaking incremental polling", async context => {
  const bus = new InMemoryRelayBus({ maxEventsPerRoute: 3 });
  bus.registerMachine({ machine_id: "dev-machine", qq_id: "100001" });
  bus.registerMachine({ machine_id: "train-machine", qq_id: "200002" });
  bus.registerMachine({ machine_id: "aux-machine", qq_id: "300003" });

  bus.registerRoute({
    relay_key: "route-a",
    group_id: "940001",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    rate_limit_per_minute: 1000,
  });
  bus.registerRoute({
    relay_key: "route-b",
    group_id: "940002",
    members: ["aux-machine", "train-machine"],
    generation: 1,
    rate_limit_per_minute: 1000,
  });

  const dev = bus.createTransportFor("dev-machine");
  const aux = bus.createTransportFor("aux-machine");
  const train = bus.createTransportFor("train-machine");
  context.after(async () => {
    await Promise.all([dev.close(), aux.close(), train.close()]);
  });

  // Route B sends 1 message -> train polls and reads cursor for route-b
  await aux.sendFrame(sampleFrameParams({
    dedupe_key: "b-1",
    target_machine: "train-machine",
    body: "route-b-important",
  }));
  await train.poll();
  const bFirstRead = await train.readEvents({ relay_key: "route-b", limit: 10 });
  assert.equal(bFirstRead.events.length, 1);
  assert.equal(bFirstRead.events[0].frame.body, "route-b-important");

  // Route A floods 6 messages (> maxEventsPerRoute=3)
  for (let i = 1; i <= 6; i += 1) {
    await dev.sendFrame(sampleFrameParams({
      dedupe_key: `a-${i}`,
      target_machine: "train-machine",
      body: `route-a-${i}`,
    }));
  }
  await train.poll();

  // Route A keeps only latest 3 events, while Route B's event is completely untouched!
  const aRead = await train.readEvents({ relay_key: "route-a", limit: 10 });
  assert.deepEqual(aRead.events.map(e => e.frame.body), ["route-a-4", "route-a-5", "route-a-6"]);

  const bStillThere = await train.readEvents({ relay_key: "route-b", limit: 10 });
  assert.equal(bStillThere.events.length, 1);
  assert.equal(bStillThere.events[0].frame.body, "route-b-important");

  // Route B cursor stays valid after Route A eviction
  await aux.sendFrame(sampleFrameParams({
    dedupe_key: "b-2",
    target_machine: "train-machine",
    body: "route-b-second",
  }));
  await train.poll({ relay_keys: ["route-b"] });
  const bAfterCursor = await train.readEvents({ relay_key: "route-b", cursor: bFirstRead.next_cursor, limit: 10 });
  assert.deepEqual(bAfterCursor.events.map(e => e.frame.body), ["route-b-second"]);

  // Group message cap (512): sending 520 messages in one route keeps incremental poll working across overflow
  for (let i = 1; i <= 520; i += 1) {
    await dev.sendFrame(sampleFrameParams({
      dedupe_key: `flood-${i}`,
      target_machine: "train-machine",
      body: `flood-${i}`,
    }));
  }
  const floodPoll = await train.poll({ relay_keys: ["route-a"] });
  assert.equal(floodPoll.ingested_count, 512);
  await dev.sendFrame(sampleFrameParams({
    dedupe_key: "after-flood-521",
    target_machine: "train-machine",
    body: "after-flood-521",
  }));
  const postFloodPoll = await train.poll({ relay_keys: ["route-a"] });
  assert.equal(postFloodPoll.ingested_count, 1);
  const latestA = await train.readEvents({ relay_key: "route-a", limit: 10 });
  assert.equal(latestA.events.at(-1).frame.body, "after-flood-521");

  // dedupeMap cap (4096): inserting >4096 distinct keys evicts oldest key while keeping newest key deduplicated
  const capBus = new InMemoryRelayBus();
  capBus.registerMachine({ machine_id: "dev-machine", qq_id: "100001" });
  capBus.registerMachine({ machine_id: "train-machine", qq_id: "200002" });
  capBus.registerRoute({
    relay_key: "route-cap",
    group_id: "940009",
    members: ["dev-machine", "train-machine"],
    generation: 1,
    rate_limit_per_minute: 10_000,
  });
  const capDev = capBus.createTransportFor("dev-machine");
  context.after(() => capDev.close());
  for (let i = 0; i < 4097; i += 1) {
    await capDev.sendFrame(sampleFrameParams({
      dedupe_key: `cap-k-${i}`,
      target_machine: "train-machine",
      body: `b-${i}`,
    }));
  }
  // Oldest key cap-k-0 was evicted -> sending with different body succeeds instead of RELAY_DEDUPE_CONFLICT
  const reusedOldest = await capDev.sendFrame(sampleFrameParams({
    dedupe_key: "cap-k-0",
    target_machine: "train-machine",
    body: "different-after-evict",
  }));
  assert.equal(reusedOldest.status, "sent_verified");
  // Latest key cap-k-4096 is still retained -> different body triggers RELAY_DEDUPE_CONFLICT
  await assert.rejects(
    capDev.sendFrame(sampleFrameParams({
      dedupe_key: "cap-k-4096",
      target_machine: "train-machine",
      body: "conflict-body",
    })),
    err => err instanceof RelayError && err.code === "relay_dedupe_conflict",
  );
});
