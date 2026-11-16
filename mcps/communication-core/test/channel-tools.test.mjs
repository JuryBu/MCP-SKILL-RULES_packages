import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer, communicationTools } from "../src/mcp-server.mjs";
import { CoreError } from "../src/contracts.mjs";

const caller = { machine_id: "synthetic-machine", host: "synthetic-host", surface: "desktop", conversation_id: "synthetic-caller" };
const window = { channel: "qq", window_type: "group", window_id: "synthetic-group" };
const principal = { id: "synthetic-channel-reader", token: "synthetic-channel-reader-token", identity: caller, allowed_targets: [] };

async function harness(context, overrides = {}) {
  const calls = [];
  const core = {
    ...Object.fromEntries(communicationTools.map(entry => [entry.method, async () => ({})])),
    async readChannelMessages(auth, input) {
      calls.push({ method: "read", auth: auth.principal_id, input });
      return { observed_at: "2030-01-01T00:00:00.000Z", window, messages: [{ message_id: "synthetic-ordinary-message", text: "没有艾特或引用的普通内容" }] };
    },
    async downloadAttachment(auth, input) {
      calls.push({ method: "download", auth: auth.principal_id, input });
      return { downloaded: true, attachment_ref: input.attachment_ref, file_path: "synthetic-local-path", sha256: "a".repeat(64) };
    },
    ...overrides,
  };
  const service = await createMcpHttpServer({ core, principals: [principal] });
  const client = new Client({ name: "synthetic-channel-wire", version: "1" });
  context.after(async () => { await client.close(); await service.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${principal.token}` } } }));
  return { client, calls };
}

test("channel tool definitions separate read-only history from local download side effects", () => {
  const read = communicationTools.find(entry => entry.definition.name === "communication_read_channel_messages").definition;
  const download = communicationTools.find(entry => entry.definition.name === "communication_download_attachment").definition;
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(download.annotations.readOnlyHint, false);
  assert.equal(download.annotations.destructiveHint, false);
  assert.equal(read.inputSchema.additionalProperties, false);
  assert.equal(download.inputSchema.additionalProperties, false);
  assert.equal(read.inputSchema.properties.count.maximum, 50);
  assert.equal(Object.hasOwn(download.inputSchema.properties, "url"), false);
  assert.equal(Object.hasOwn(download.inputSchema.properties, "file_id"), false);
  const send = communicationTools.find(entry => entry.definition.name === "communication_send_message").definition;
  assert.ok(send.inputSchema.properties.origin.properties.kind.description.includes("agent_message"));
  assert.equal(Object.hasOwn(send.inputSchema.properties.origin.properties.kind, "enum"), false);
});

test("formal MCP reads ordinary messages and preserves original input and trusted context", async context => {
  const fixture = await harness(context);
  const argumentsValue = { caller, ...window, count: 20 };
  const result = await fixture.client.callTool({ name: "communication_read_channel_messages", arguments: argumentsValue });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.messages[0].text, "没有艾特或引用的普通内容");
  assert.deepEqual(fixture.calls, [{ method: "read", auth: principal.id, input: argumentsValue }]);
  assert.equal(JSON.parse(result.content[0].text.replace(/^交流操作结果：\n/, "")).messages[0].message_id, "synthetic-ordinary-message");
});

test("formal MCP downloads only by an attachment reference", async context => {
  const fixture = await harness(context);
  const argumentsValue = { caller, ...window, attachment_ref: "synthetic-scoped-ref" };
  const result = await fixture.client.callTool({ name: "communication_download_attachment", arguments: argumentsValue });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.downloaded, true);
  assert.deepEqual(fixture.calls, [{ method: "download", auth: principal.id, input: argumentsValue }]);
});

for (const invalid of [
  { count: 0 }, { count: 51 }, { count: "20" }, { cursor: 123 }, { channel: "wechat" },
  { action: "bind" }, { message_seq: "synthetic-raw-anchor" }, { target_key: "synthetic-other-target" },
]) {
  test(`history schema rejects unsupported input before dispatch ${JSON.stringify(invalid)}`, async context => {
    const fixture = await harness(context);
    const result = await fixture.client.callTool({ name: "communication_read_channel_messages", arguments: { caller, ...window, ...invalid } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "invalid_input");
    assert.equal(fixture.calls.length, 0);
  });
}

for (const invalid of [
  { url: "https://synthetic.invalid/file" }, { file_id: "synthetic-raw-id" },
  { attachment_ref: "" }, { destination_dir: 123 }, { name: "x".repeat(256) },
]) {
  test(`download schema rejects unsupported input before dispatch ${JSON.stringify(invalid)}`, async context => {
    const fixture = await harness(context);
    const result = await fixture.client.callTool({ name: "communication_download_attachment", arguments: { caller, ...window, attachment_ref: "synthetic-ref", ...invalid } });
    assert.equal(result.isError, true);
    assert.equal(fixture.calls.length, 0);
  });
}

test("channel permission failures retain their explicit code over formal MCP", async context => {
  const fixture = await harness(context, { async readChannelMessages() { throw new CoreError("forbidden", "synthetic-private-reason"); } });
  const result = await fixture.client.callTool({ name: "communication_read_channel_messages", arguments: { caller, ...window } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "forbidden");
  assert.equal(JSON.stringify(result).includes("synthetic-private-reason"), false);
});
