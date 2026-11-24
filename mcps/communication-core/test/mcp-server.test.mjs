import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError } from "../src/contracts.mjs";
import { createMcpHttpServer } from "../src/mcp-server.mjs";
import { parseCliArguments, runCli, startFromConfig } from "../src/cli.mjs";

const caller = { machine_id: "synthetic-machine", host: "synthetic-host", surface: "desktop", conversation_id: "synthetic-source" };
const receiver = { ...caller, conversation_id: "synthetic-receiver" };
const principals = [
  { id: "synthetic-source", token: "synthetic-source-test-token", identity: caller, allowed_targets: ["synthetic-target"], origin_kinds: ["agent_message"] },
  { id: "synthetic-receiver", token: "synthetic-receiver-test-token", identity: receiver, allowed_targets: ["synthetic-target"], origin_kinds: ["agent_message"] },
];
const methods = {
  communication_list_conversations: "listConversations",
  communication_resolve_target: "resolveTarget",
  communication_send_message: "sendMessage",
  communication_get_message: "getMessage",
  communication_wait: "wait",
  communication_ack_processing: "ackProcessing",
  communication_get_status: "getStatus",
  communication_read_recent_snapshot: "readRecentSnapshot",
  communication_read_channel_messages: "readChannelMessages",
  communication_download_attachment: "downloadAttachment",
  communication_manage_channel_binding: "manageChannelBinding",
};
const initializeBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-http-test", version: "1" } } });

function stubCore(overrides = {}) {
  return {
    ...Object.fromEntries(Object.values(methods).map(method => [method, async (context, input) => ({
      method, context: { principal_id: context.principal_id }, input,
      ...(method === "readRecentSnapshot" ? { markdown: "**用户**\n\n> 最近测试输入" } : {}),
    })])),
    ...overrides,
  };
}

async function harness(context, overrides = {}, options = {}) {
  const core = stubCore(overrides);
  const service = await createMcpHttpServer({ core, principals, ...options });
  const clients = [];
  context.after(async () => {
    for (const client of clients) await client.close();
    await service.close();
  });
  return {
    service,
    core,
    async client(token = principals[0].token, transportOptions = {}) {
      const client = new Client({ name: "synthetic-sdk-client", version: "1" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { ...transportOptions, requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    },
  };
}

function raw(service, { method = "POST", body = initializeBody, headers = {} } = {}) {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(service.url, {
      method,
      headers: Array.isArray(headers) ? headers : {
        Authorization: `Bearer ${principals[0].token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolveRequest({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(2000, () => request.destroy(new Error("synthetic_request_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

function pendingWait(service, principal, requestId, messageId) {
  let request;
  const settled = new Promise(resolveRequest => {
    request = httpRequest(service.url, { method: "POST", headers: {
      Authorization: `Bearer ${principal.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    } }, response => {
      response.resume();
      response.once("end", () => resolveRequest(response.statusCode));
    });
    request.once("error", () => resolveRequest(null));
    request.end(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
      name: "communication_wait", arguments: { caller: principal.identity, message_id: messageId, wait_ms: 45000 },
    } }));
  });
  return { request, settled };
}

function waitObserver() {
  const entries = new Map();
  return {
    entries,
    wait(authContext, input) {
      let cancelled;
      const entry = { signal: authContext.signal, cancelled: new Promise(resolveCancel => { cancelled = resolveCancel; }) };
      entries.set(input.message_id, entry);
      return new Promise(resolveWait => {
        entry.complete = () => resolveWait({ message_id: input.message_id, matched: false, events: [], timed_out: false });
        authContext.signal.addEventListener("abort", () => { cancelled(); entry.complete(); }, { once: true });
      });
    },
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic_wait_condition_timeout");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  }
}

function cancelWait(service, principal, requestId) {
  return raw(service, { headers: { Authorization: `Bearer ${principal.token}` }, body: JSON.stringify({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "synthetic-cancel" },
  }) });
}

test("CLI收到shutdown行后退出，父端保持stdin管道开启仍不会挂住", { timeout: 8000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), "communication-core-http-"));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../src/cli.mjs", import.meta.url)),
    "--config", fileURLToPath(new URL("../examples/isolation.config.json", import.meta.url)),
    "--state-dir", join(temporary, "synthetic-state"),
  ], { cwd: temporary, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  child.stdin.on("error", () => {});
  child.stderr.resume();
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  });
  await new Promise((resolveStart, rejectStart) => {
    let output = "";
    const timer = setTimeout(() => rejectStart(new Error("synthetic_cli_start_timeout")), 5000);
    child.once("error", error => { clearTimeout(timer); rejectStart(error); });
    child.once("exit", () => { clearTimeout(timer); rejectStart(new Error("synthetic_cli_early_exit")); });
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      try {
        const event = JSON.parse(output.split("\n")[0]);
        assert.equal(event.event, "listening");
        assert.match(event.url, /\/mcp$/);
        assert.ok(!output.includes(principals[0].token));
        clearTimeout(timer);
        resolveStart();
      } catch (error) { clearTimeout(timer); rejectStart(error); }
    });
  });
  child.stdin.write("shutdown\n");
  let timer;
  const result = await Promise.race([exited, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), 2000); })]);
  clearTimeout(timer);
  assert.deepEqual(result, { code: 0, signal: null });
});

test("SDK真实初始化、发现十一个工具并逐项转发可信context与参数", async context => {
  const fixture = await harness(context);
  const client = await fixture.client();
  const listed = await client.listTools();
  assert.equal(Object.hasOwn(listed.tools.find(entry => entry.name === "communication_send_message").inputSchema.properties, "model_override"), false);
  assert.deepEqual(listed.tools.map(entry => entry.name).sort(), Object.keys(methods).sort());
  for (const entry of listed.tools) {
    assert.equal(entry.inputSchema.additionalProperties, false);
    assert.ok(entry.inputSchema.required.includes("caller"));
    assert.match(entry.description, /[\u4e00-\u9fff]/);
  }
  const inputs = {
    communication_list_conversations: { caller, host: "synthetic-host", limit: 7, cursor: "synthetic-cursor" },
    communication_resolve_target: { caller, binding_id: "synthetic-target" },
    communication_send_message: {
      caller,
      origin: { kind: "agent_message", channel: "synthetic", source_ref: "synthetic-turn" },
      target: { ...receiver, binding_id: "synthetic-target", binding_generation: 3 },
      dedupe_key: "synthetic-dedupe",
      text: "这是一条模拟消息",
      attachment_refs: ["synthetic://attachment"],
      delivery_policy: "when_idle",
      reply_required: true,
      expires_at: "2030-01-01T00:00:00Z",
      in_reply_to: "synthetic-parent-message",
      origin_receipt_binding: { component: "synthetic", resource_id: "synthetic-resource", generation: 1, wake_id: "synthetic-wake", notification_id: null, event_ids: ["synthetic-event"] },
    },
    communication_get_message: { caller, message_id: "synthetic-message" },
    communication_wait: { caller, message_id: "synthetic-message", after_cursor: "synthetic-cursor", until: "reply", wait_ms: 10, limit: 3 },
    communication_ack_processing: { caller, message_id: "synthetic-message", delivery_id: "synthetic-delivery", binding_generation: 3, processing: "processing" },
    communication_get_status: { caller, host: "synthetic-host", conversation_id: "synthetic-receiver" },
    communication_read_recent_snapshot: { caller, target: { host: "codex", conversation_id: "synthetic-receiver" }, last_rounds: 3 },
    communication_read_channel_messages: { caller, channel: "qq", window_type: "private", window_id: "synthetic-private-window", count: 7 },
    communication_download_attachment: { caller, channel: "qq", window_type: "private", window_id: "synthetic-private-window", attachment_ref: "synthetic-attachment-ref" },
    communication_manage_channel_binding: { caller, action: "list", limit: 7 },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { method: methods[name], context: { principal_id: principals[0].id }, input });
    if (name === "communication_read_recent_snapshot") {
      assert.equal(result.content[0].text, "**用户**\n\n> 最近测试输入");
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 8192);
    } else {
      assert.match(result.content[0].text, /交流操作结果/);
    }
  }
});

test("MCP未绑定窗口get返回binding:null，其它工具和动作仍要求对象结果", async context => {
  const fixture = await harness(context, { manageChannelBinding: async () => null, getMessage: async () => null });
  const client = await fixture.client();
  const missing = await client.callTool({ name: "communication_manage_channel_binding", arguments: { caller, action: "get", channel: "qq", window_type: "private", window_id: "synthetic-private-window" } });
  assert.notEqual(missing.isError, true);
  assert.deepEqual(missing.structuredContent, { binding: null });
  assert.match(missing.content[0].text, /"binding":null/);
  for (const action of ["bind", "remove", "list"]) {
    const result = await client.callTool({ name: "communication_manage_channel_binding", arguments: { caller, action } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "internal_error");
  }
  const invalid = await client.callTool({ name: "communication_get_message", arguments: { caller, message_id: "synthetic-message" } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "internal_error");
});

test("不同Bearer分别绑定principal，caller保留给核心核验", async context => {
  const fixture = await harness(context, {
    listConversations(authContext, input) {
      const identity = principals.find(principal => principal.id === authContext.principal_id).identity;
      if (JSON.stringify(input.caller) !== JSON.stringify(identity)) throw new CoreError("caller_mismatch", "synthetic private detail");
      return { principal_id: authContext.principal_id };
    },
  });
  const sourceClient = await fixture.client();
  const receiverClient = await fixture.client(principals[1].token);
  const sourceResult = await sourceClient.callTool({ name: "communication_list_conversations", arguments: { caller } });
  const receiverResult = await receiverClient.callTool({ name: "communication_list_conversations", arguments: { caller: receiver } });
  assert.equal(sourceResult.structuredContent.principal_id, principals[0].id);
  assert.equal(receiverResult.structuredContent.principal_id, principals[1].id);
  const forged = await sourceClient.callTool({ name: "communication_list_conversations", arguments: { caller: receiver } });
  assert.equal(forged.isError, true);
  assert.equal(forged.structuredContent.error.code, "caller_mismatch");
});

test("缺失、错误、重复Authorization与URL查询令牌均被拒绝", async context => {
  const { service } = await harness(context);
  for (const authorization of [undefined, "Bearer synthetic-wrong", "Basic synthetic-wrong", `Bearer ${principals[0].token}, Bearer ${principals[1].token}`]) {
    const headers = { Host: new URL(service.url).host };
    if (authorization !== undefined) headers.Authorization = authorization;
    const result = await raw(service, { headers: Object.entries(headers).flat() });
    assert.equal(result.status, 401);
    assert.match(result.headers["www-authenticate"], /Bearer/);
    assert.ok(!result.body.includes(principals[0].token));
  }
  const duplicate = await raw(service, { headers: ["Host", new URL(service.url).host, "Authorization", `Bearer ${principals[0].token}`, "Authorization", `Bearer ${principals[1].token}`] });
  assert.equal(duplicate.status, 401);
  const queryOnly = await raw({ url: `${service.url}?token=${principals[0].token}` }, { headers: ["Host", new URL(service.url).host] });
  assert.equal(queryOnly.status, 401);
});

test("拒绝非法Host与Origin，允许同端口的两个回环名字", async context => {
  const { service } = await harness(context);
  const authority = new URL(service.url).host;
  for (const host of ["evil.invalid", `127.0.0.1:${service.address.port + 1}`, "localhost.evil.invalid", "127.0.0.1."]) {
    assert.equal((await raw(service, { headers: { Host: host } })).status, 403);
  }
  for (const origin of ["null", "https://evil.invalid", "http://127.0.0.1", `http://${authority}/`, `https://${authority}`]) {
    assert.equal((await raw(service, { headers: { Origin: origin } })).status, 403);
  }
  const duplicateHost = await raw(service, { headers: ["Host", authority, "Host", authority, "Authorization", `Bearer ${principals[0].token}`] });
  assert.equal(duplicateHost.status, 403);
  const duplicateOrigin = await raw(service, { headers: ["Host", authority, "Authorization", `Bearer ${principals[0].token}`, "Origin", `http://${authority}`, "Origin", `http://${authority}`] });
  assert.equal(duplicateOrigin.status, 403);
  for (const host of [authority, `localhost:${service.address.port}`]) {
    assert.equal((await raw(service, { headers: { Host: host, Origin: `http://${host}` } })).status, 200);
  }
});

test("stateless JSON响应不创建session，GET与DELETE没有长连接", async context => {
  const { service } = await harness(context);
  const initialized = await raw(service);
  assert.equal(initialized.status, 200);
  assert.match(initialized.headers["content-type"], /^application\/json/);
  assert.equal(initialized.headers["mcp-session-id"], undefined);
  for (const method of ["GET", "DELETE", "PUT"]) {
    const result = await raw(service, { method, body: undefined });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "POST");
  }
});

test("载荷上限、JSON错误与编码错误返回有界脱敏错误", async context => {
  const { service } = await harness(context, {}, { maxBodyBytes: 512 });
  const oversized = await raw(service, { body: JSON.stringify({ secret: principals[0].token, padding: "x".repeat(1024) }) });
  assert.equal(oversized.status, 413);
  assert.ok(!oversized.body.includes(principals[0].token));
  assert.equal((await raw(service, { body: "{" })).status, 400);
  assert.equal((await raw(service, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await raw(service, { headers: { "Content-Encoding": "gzip" } })).status, 400);
  assert.equal((await raw(service)).status, 200);
});

test("CoreError保留具体code，普通异常和结果序列化异常不泄露细节", async context => {
  const privateText = `${principals[0].token} C:\\synthetic-private\\state.sqlite Error: secret stack`;
  const circular = {};
  circular.self = circular;
  const fixture = await harness(context, {
    resolveTarget() { throw new CoreError("forbidden", privateText, { privateText }); },
    getMessage() { throw new Error(privateText); },
    listConversations() { return circular; },
  });
  const client = await fixture.client();
  for (const [name, input, expectedCode] of [
    ["communication_resolve_target", { caller, binding_id: "synthetic-target" }, "forbidden"],
    ["communication_get_message", { caller, message_id: "synthetic-message" }, "internal_error"],
    ["communication_list_conversations", { caller }, "internal_error"],
  ]) {
    const result = await client.callTool({ name, arguments: input });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, expectedCode);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(principals[0].token));
    assert.ok(!serialized.includes("synthetic-private"));
    assert.ok(!serialized.includes("stack"));
    assert.match(result.content[0].text, /[\u4e00-\u9fff]/);
  }
});

test("参数与未知工具错误同样返回structuredContent，不回显敏感输入", async context => {
  let invoked = false;
  const fixture = await harness(context, { wait() { invoked = true; return {}; } });
  const client = await fixture.client();
  for (const request of [
    { name: "communication_wait", arguments: { caller, message_id: "synthetic-message", wait_ms: 45001 } },
    { name: "communication_wait", arguments: { caller, message_id: "synthetic-message", principal_id: principals[0].token } },
    { name: principals[0].token, arguments: { caller } },
    { name: "communication_ack_processing", arguments: { caller, message_id: "synthetic-message", delivery_id: "synthetic-delivery", binding_generation: 1 } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "invalid_input");
    assert.ok(!JSON.stringify(result).includes(principals[0].token));
  }
  assert.equal(invoked, false);
});

test("服务关闭会结束在途wait并释放端口，保留外部核心的所有权", { timeout: 5000 }, async context => {
  let waitStarted;
  const started = new Promise(resolveWait => { waitStarted = resolveWait; });
  let releaseWait;
  let coreCloseCalls = 0;
  const fixture = await harness(context, {
    wait() { waitStarted(); return new Promise(resolveWait => { releaseWait = resolveWait; }); },
    close() { coreCloseCalls += 1; },
  });
  const client = await fixture.client();
  const pending = client.callTool({ name: "communication_wait", arguments: { caller, message_id: "synthetic-message", wait_ms: 30000 } }).then(value => ({ value }), error => ({ error }));
  await started;
  const before = Date.now();
  await fixture.service.close();
  await fixture.service.close();
  const settled = await pending;
  releaseWait({ message_id: "synthetic-message", timed_out: true });
  assert.ok(Date.now() - before < 1500);
  if (settled.value) assert.equal(settled.value.structuredContent.error.code, "server_closed");
  else assert.ok(settled.error instanceof Error);
  assert.equal(coreCloseCalls, 0);
  await assert.rejects(raw(fixture.service));
});

test("HTTP连接断开把合成signal传给可信核心context并结束内部wait", { timeout: 5000 }, async context => {
  let waitStarted;
  let waitCancelled;
  let captured;
  const started = new Promise(resolveWait => { waitStarted = resolveWait; });
  const cancelled = new Promise(resolveWait => { waitCancelled = resolveWait; });
  const fixture = await harness(context, {
    wait(authContext) {
      captured = authContext;
      waitStarted();
      return new Promise(resolveWait => {
        authContext.signal.addEventListener("abort", () => {
          waitCancelled();
          resolveWait({ message_id: "synthetic-message", timed_out: false });
        }, { once: true });
      });
    },
  });
  const client = await fixture.client();
  const pending = client.callTool({ name: "communication_wait", arguments: { caller, message_id: "synthetic-message", wait_ms: 45000 } }).then(() => null, error => error);
  await started;
  assert.equal(captured.principal_id, principals[0].id);
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.signal.aborted, false);
  await client.close();
  assert.ok(await pending instanceof Error);
  await cancelled;
  assert.equal(captured.signal.aborted, true);
});

test("真实SDK跨POST取消通知按原requestId清理核心等待", { timeout: 5000 }, async context => {
  const observer = waitObserver();
  const fixture = await harness(context, { wait: observer.wait });
  const outbound = [];
  const client = await fixture.client(principals[0].token, { fetch(url, options) {
    if (typeof options?.body === "string") {
      const body = JSON.parse(options.body);
      outbound.push({ method: body.method, id: body.id, requestId: body.params?.requestId });
    }
    return fetch(url, options);
  } });
  const controller = new AbortController();
  const pending = client.callTool({ name: "communication_wait", arguments: { caller, message_id: "synthetic-sdk-cancel", wait_ms: 45000 } }, undefined, { signal: controller.signal }).catch(error => error);
  await waitUntil(() => observer.entries.has("synthetic-sdk-cancel"));
  const original = outbound.find(entry => entry.method === "tools/call");
  controller.abort();
  assert.ok(await pending instanceof Error);
  await observer.entries.get("synthetic-sdk-cancel").cancelled;
  assert.ok(outbound.some(entry => entry.method === "notifications/cancelled" && entry.requestId === original.id));
  assert.equal(observer.entries.get("synthetic-sdk-cancel").signal.aborted, true);
});

test("取消严格隔离principal，并区分数字和字符串requestId", { timeout: 5000 }, async context => {
  const observer = waitObserver();
  const { service } = await harness(context, { wait: observer.wait });
  const sourceWait = pendingWait(service, principals[0], 71, "synthetic-source-cancel");
  const receiverWait = pendingWait(service, principals[1], 71, "synthetic-receiver-cancel");
  await waitUntil(() => observer.entries.size === 2);
  assert.equal((await cancelWait(service, principals[0], 71)).status, 202);
  await observer.entries.get("synthetic-source-cancel").cancelled;
  assert.equal(observer.entries.get("synthetic-receiver-cancel").signal.aborted, false);
  assert.equal((await cancelWait(service, principals[1], 71)).status, 202);
  await observer.entries.get("synthetic-receiver-cancel").cancelled;
  await Promise.all([sourceWait.settled, receiverWait.settled]);
  const numeric = pendingWait(service, principals[0], 72, "synthetic-numeric-id");
  const textual = pendingWait(service, principals[0], "72", "synthetic-string-id");
  await waitUntil(() => observer.entries.size === 4);
  await cancelWait(service, principals[0], 72);
  await observer.entries.get("synthetic-numeric-id").cancelled;
  assert.equal(observer.entries.get("synthetic-string-id").signal.aborted, false);
  await cancelWait(service, principals[0], "72");
  await observer.entries.get("synthetic-string-id").cancelled;
  await Promise.all([numeric.settled, textual.settled]);
});

test("重复、歧义与近期复用requestId的取消通知不会终止另一条请求", { timeout: 5000 }, async context => {
  const observer = waitObserver();
  const { service } = await harness(context, { wait: observer.wait });
  const first = pendingWait(service, principals[0], 81, "synthetic-duplicate-first");
  const second = pendingWait(service, principals[0], 81, "synthetic-duplicate-second");
  await waitUntil(() => observer.entries.size === 2);
  await cancelWait(service, principals[0], 81);
  assert.equal(observer.entries.get("synthetic-duplicate-first").signal.aborted, false);
  assert.equal(observer.entries.get("synthetic-duplicate-second").signal.aborted, false);
  first.request.destroy();
  await observer.entries.get("synthetic-duplicate-first").cancelled;
  await first.settled;
  await cancelWait(service, principals[0], 81);
  assert.equal(observer.entries.get("synthetic-duplicate-second").signal.aborted, false);
  second.request.destroy();
  await observer.entries.get("synthetic-duplicate-second").cancelled;
  await second.settled;
  const reused = pendingWait(service, principals[0], 81, "synthetic-reused-id");
  await waitUntil(() => observer.entries.size === 3);
  await cancelWait(service, principals[0], 81);
  assert.equal(observer.entries.get("synthetic-reused-id").signal.aborted, false);
  reused.request.destroy();
  await observer.entries.get("synthetic-reused-id").cancelled;
  await reused.settled;
});

test("startup拒绝非回环、重复凭据与不合法边界参数", async () => {
  for (const options of [
    { host: "0.0.0.0" }, { host: "::1" }, { port: -1 }, { port: 65536 }, { maxBodyBytes: 0 }, { maxBodyBytes: 1048577 },
    { principals: [] },
    { principals: [principals[0], { ...principals[1], token: principals[0].token }] },
    { principals: [principals[0], { ...principals[1], id: principals[0].id }] },
    { principals: [{ ...principals[0], token: "synthetic invalid token" }] },
  ]) await assert.rejects(createMcpHttpServer({ core: stubCore(), principals, ...options }), { code: "invalid_config" });
});

test("localhost选项仍只监听IPv4回环，SDK连接可用", async context => {
  const fixture = await harness(context, {}, { host: "localhost" });
  assert.equal(fixture.service.address.address, "127.0.0.1");
  const client = await fixture.client();
  assert.equal((await client.listTools()).tools.length, Object.keys(methods).length);
});

test("CLI必须显式给出两个路径，帮助与缺参不启动服务", async () => {
  const output = [];
  const errors = [];
  const streams = { stdout: { write: message => output.push(message) }, stderr: { write: message => errors.push(message) } };
  assert.equal(await runCli([], streams), 1);
  assert.equal(await runCli(["--help"], streams), 0);
  assert.match(output.join(""), /--config/);
  assert.match(errors.join(""), /--state-dir/);
  for (const argumentsList of [["--config", "synthetic.json"], ["--state-dir", "synthetic"], ["--config", "a", "--config", "b", "--state-dir", "c"], ["--unknown", "a", "--state-dir", "b"]]) {
    assert.throws(() => parseCliArguments(argumentsList), { code: "invalid_input" });
  }
  const parsed = parseCliArguments(["--config", "synthetic.json", "--state-dir", "synthetic-state"]);
  assert.ok(isAbsolute(parsed.configPath));
  assert.ok(isAbsolute(parsed.stateDir));
});

test("CLI拒绝真实模式与无效授权，失败时不创建状态目录", async context => {
  const temporary = await mkdtemp(join(tmpdir(), "communication-core-http-"));
  context.after(async () => {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  });
  const example = JSON.parse(await readFile(new URL("../examples/isolation.config.json", import.meta.url), "utf8"));
  assert.equal(example.adapter_mode, "mock");
  assert.ok(example.targets.every(target => target.evidence === "simulated"));
  const configurationPath = join(temporary, "synthetic-config.json");
  const stateDir = join(temporary, "must-not-be-created");
  for (const configuration of [
    { ...example, adapter_mode: "real" },
    { ...example, adapter_mode: undefined },
    { ...example, host: "0.0.0.0" },
    { ...example, principals: [example.principals[0], { ...example.principals[1], token: example.principals[0].token }] },
  ]) {
    await writeFile(configurationPath, JSON.stringify(configuration), "utf8");
    await assert.rejects(startFromConfig({ configPath: configurationPath, stateDir }));
    await assert.rejects(stat(stateDir), { code: "ENOENT" });
  }
});

test("CLI支持带BOM的UTF8配置，启动后正常关闭自有核心与SQLite", async context => {
  const temporary = await mkdtemp(join(tmpdir(), "communication-core-http-"));
  context.after(async () => {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  });
  const configurationPath = join(temporary, "synthetic-配置.json");
  const stateDir = join(temporary, "synthetic-状态");
  const example = await readFile(new URL("../examples/isolation.config.json", import.meta.url), "utf8");
  await writeFile(configurationPath, `\uFEFF${example}`, "utf8");
  const service = await startFromConfig({ configPath: configurationPath, stateDir });
  context.after(() => service.close());
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await service.close();
  await service.close();
  assert.ok((await stat(join(stateDir, "core.sqlite"))).size > 0);
});
