import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CoreError } from "../src/contracts.mjs";
import { NapcatMcpTransport } from "../src/transports/napcat-mcp.mjs";

const readArguments = { target_key: "synthetic-owner-window", count: 20, include_owner_event_content: true };
const downloadArguments = { target_key: "synthetic-owner-window", message_id: "74213", attachment_ref: "synthetic-provider-ref", destination_dir: "C:/synthetic-downloads" };
const secret = "synthetic-private-error";

function fixture(context, response = { structuredContent: { ok: true } }) {
  const calls = { created: 0, connected: 0, closed: 0, tools: [] };
  const transport = new NapcatMcpTransport({
    baseUrl: "http://127.0.0.1:14588/napcat/mcp",
    conversationId: "synthetic-channel-caller",
    clientFactory() {
      calls.created += 1;
      return {
        async connect() { calls.connected += 1; },
        async callTool(input, schema, options) {
          calls.tools.push({ input, options });
          return typeof response === "function" ? response(input, options) : response;
        },
        async close() { calls.closed += 1; },
      };
    },
  });
  context.after(() => transport.close());
  return { transport, calls };
}

function unconfirmed(requestSent) {
  return error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "napcat_mcp_unconfirmed");
    assert.deepEqual(error.details, { request_sent: requestSent });
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  };
}

test("configured history reuses one SDK connection and forwards only the exact scoped contract", async context => {
  const expected = { ok: true, messages: [], next_cursor: "74212" };
  const { transport, calls } = fixture(context, { structuredContent: expected });
  assert.strictEqual(await transport.readConfiguredRecent({ target_key: readArguments.target_key }), expected);
  await transport.readConfiguredRecent({ ...readArguments, count: 50, before_message_id: "74212" });
  assert.equal(calls.created, 1);
  assert.equal(calls.connected, 1);
  assert.deepEqual(calls.tools.map(entry => entry.input), [
    { name: "napcat_read_configured_recent", arguments: readArguments },
    { name: "napcat_read_configured_recent", arguments: { ...readArguments, count: 50, before_message_id: "74212" } },
  ]);
  assert.equal(calls.tools[0].options.timeout, 10000);
  assert.equal(calls.tools[0].options.maxTotalTimeout, 10000);
  assert.equal(calls.tools[0].options.resetTimeoutOnProgress, false);
});

test("configured download forwards the original message and reference with a bounded 45-second deadline", async context => {
  const expected = { downloaded: true };
  const { transport, calls } = fixture(context, { content: [{ type: "text", text: JSON.stringify(expected) }] });
  assert.deepEqual(await transport.downloadConfiguredFile({ ...downloadArguments, name: "synthetic.txt" }), expected);
  assert.deepEqual(calls.tools[0].input, { name: "napcat_download_configured_file", arguments: { ...downloadArguments, name: "synthetic.txt" } });
  assert.equal(calls.tools[0].options.timeout, 45000);
  assert.equal(calls.tools[0].options.maxTotalTimeout, 45000);
});

for (const [method, parameters] of [
  ["readConfiguredRecent", { ...readArguments, groupId: "synthetic-other-group" }],
  ["readConfiguredRecent", { ...readArguments, count: 51 }],
  ["readConfiguredRecent", { ...readArguments, count: null }],
  ["readConfiguredRecent", { ...readArguments, target_key: " padded " }],
  ["readConfiguredRecent", { ...readArguments, include_owner_event_content: false }],
  ["downloadConfiguredFile", { ...downloadArguments, url: "https://synthetic.invalid/file" }],
  ["downloadConfiguredFile", { ...downloadArguments, file_id: "synthetic-raw-file" }],
  ["downloadConfiguredFile", { ...downloadArguments, attachment_ref: "" }],
  ["downloadConfiguredFile", { ...downloadArguments, name: "中".repeat(86) }],
]) {
  test(`invalid ${method} input is rejected before client creation ${JSON.stringify(parameters)}`, async context => {
    const { transport, calls } = fixture(context);
    await assert.rejects(transport[method](parameters), unconfirmed(false));
    assert.equal(calls.created, 0);
  });
}

test("accessor and inherited parameters cannot make a configured request", async context => {
  const { transport, calls } = fixture(context);
  let getters = 0;
  const accessor = Object.defineProperty({}, "target_key", { enumerable: true, get() { getters += 1; return secret; } });
  for (const parameters of [accessor, Object.create(readArguments), new Proxy(readArguments, {})]) {
    await assert.rejects(transport.readConfiguredRecent(parameters), unconfirmed(false));
  }
  assert.equal(getters, 0);
  assert.equal(calls.created, 0);
});

test("provider confirmed failures retain only their safe exact code and never leak private details", async context => {
  const { transport, calls } = fixture(context, { isError: true, structuredContent: { ok: false, code: "CONFIGURED_FILE_UNAVAILABLE", outcomeUnknown: false, message: secret, details: { token: secret } } });
  await assert.rejects(transport.downloadConfiguredFile(downloadArguments), error => {
    assert.equal(error.code, "channel_operation_failed");
    assert.deepEqual(error.details, { request_sent: true, outcome_unknown: false, provider_code: "CONFIGURED_FILE_UNAVAILABLE" });
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.closed, 0);
});

test("a confirmed history failure preserves its healthy connection and an unrelated in-flight send", async context => {
  let finishSend;
  const { transport, calls } = fixture(context, async input => {
    if (input.name === "napcat_owner_alert") return new Promise(resolveResult => { finishSend = resolveResult; });
    return { isError: true, structuredContent: { ok: false, code: "HISTORY_CURSOR_UNVERIFIED", outcomeUnknown: false } };
  });
  const sending = transport.sendOwnerAlert({ route_key: "synthetic-route", dedupe_key: "synthetic-alert", summary: "synthetic-only" });
  await nextTurn();
  await assert.rejects(transport.readConfiguredRecent(readArguments), { code: "channel_operation_failed" });
  assert.equal(calls.closed, 0);
  await assert.rejects(transport.readConfiguredRecent(readArguments), { code: "channel_operation_failed" });
  assert.equal(calls.created, 2);
  finishSend({ structuredContent: { ok: true, messageId: "74214" } });
  assert.equal((await sending).messageId, "74214");
});

test("cancelling history closes only its own lane while the original send can finish", async context => {
  let finishSend;
  const { transport, calls } = fixture(context, async input => input.name === "napcat_owner_alert"
    ? new Promise(resolveResult => { finishSend = resolveResult; }) : new Promise(() => {}));
  const sending = transport.sendOwnerAlert({ route_key: "synthetic-route", dedupe_key: "synthetic-cancel-alert", summary: "synthetic-only" });
  await nextTurn();
  const controller = new AbortController();
  const reading = transport.readConfiguredRecent(readArguments, { signal: controller.signal });
  await nextTurn();
  controller.abort();
  await assert.rejects(reading, unconfirmed(true));
  assert.equal(calls.tools[0].options.signal.aborted, false);
  finishSend({ structuredContent: { ok: true, messageId: "74215" } });
  assert.equal((await sending).messageId, "74215");
  assert.equal(calls.created, 2);
});

test("cleanup-pending failures preserve only bounded cleanup metadata for the original operation", async context => {
  const { transport } = fixture(context, { isError: true, structuredContent: { ok: false, code: "FILE_DOWNLOAD_FAILED", outcomeUnknown: false,
    details: { cleanupPending: true, temporaryPath: "C:/synthetic-downloads/file.part-synthetic", token: secret } } });
  await assert.rejects(transport.downloadConfiguredFile(downloadArguments), error => {
    assert.deepEqual(error.details, { request_sent: true, outcome_unknown: false, provider_code: "FILE_DOWNLOAD_FAILED", cleanup_pending: true,
      temporary_path: "C:/synthetic-downloads/file.part-synthetic" });
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

for (const response of [
  { isError: true, structuredContent: { ok: false, code: "CONFIGURED_FILE_UNAVAILABLE", outcomeUnknown: true, details: secret } },
  { isError: true, structuredContent: { ok: false, code: "UNEXPECTED_ERROR", outcomeUnknown: false, details: secret } },
  { isError: true, structuredContent: { ok: false, code: "CONFIGURED_FILE_UNAVAILABLE" } },
  { isError: "false", structuredContent: { ok: true } },
  { content: [{ type: "text", text: secret }] },
]) {
  test("unconfirmed or malformed provider responses remain unknown without a second submission", async context => {
    const { transport, calls } = fixture(context, response);
    await assert.rejects(transport.downloadConfiguredFile(downloadArguments), unconfirmed(true));
    assert.equal(calls.tools.length, 1);
  });
}

test("aborted configured calls never create a client", async context => {
  const { transport, calls } = fixture(context);
  const controller = new AbortController();
  controller.abort(secret);
  await assert.rejects(transport.downloadConfiguredFile(downloadArguments, { signal: controller.signal }), unconfirmed(false));
  await assert.rejects(transport.readConfiguredRecent(readArguments, { signal: {} }), unconfirmed(false));
  assert.equal(calls.created, 0);
});

test("a download timeout cancels the exact pending request at 45 seconds without retry", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { transport, calls } = fixture(context, async () => new Promise(() => {}));
  const pending = transport.downloadConfiguredFile(downloadArguments);
  await nextTurn();
  assert.equal(calls.tools.length, 1);
  context.mock.timers.tick(44999);
  assert.equal(calls.tools[0].options.signal.aborted, false);
  context.mock.timers.tick(1);
  await assert.rejects(pending, unconfirmed(true));
  assert.equal(calls.tools[0].options.signal.aborted, true);
  assert.equal(calls.tools.length, 1);
});
