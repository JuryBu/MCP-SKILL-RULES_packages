import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, "communication-core-demo-中文 "));
const configuration = JSON.parse(fs.readFileSync(path.join(root, "examples", "isolation.config.json"), "utf8"));
configuration.port = 0;
for (const principal of configuration.principals) principal.token = randomUUID();
for (const target of configuration.targets) target.capabilities = { ...target.capabilities, when_idle: false };
const configPath = path.join(directory, "config.json");
fs.writeFileSync(configPath, JSON.stringify(configuration), { encoding: "utf8", mode: 0o600 });
const stateDirectory = path.join(directory, "state");
const clients = [];
let child = null;
let childExit = null;

function address(target) {
  const { machine_id, host, conversation_id, binding_id, binding_generation } = target;
  return { machine_id, host, surface: target.surface ?? "desktop", conversation_id, binding_id, binding_generation };
}

async function launch() {
  child = spawn(process.execPath, [path.join(root, "src", "cli.mjs"), "--config", configPath, "--state-dir", stateDirectory], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const processInstance = child;
  processInstance.stdin.on("error", () => {});
  let stderr = "";
  processInstance.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  childExit = new Promise(resolve => processInstance.once("exit", (code, signal) => resolve({ code, signal })));
  return await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: processInstance.stdout });
    const timer = setTimeout(() => { lines.close(); reject(new Error("隔离进程启动超时")); }, 10000);
    processInstance.once("error", error => { clearTimeout(timer); lines.close(); reject(error); });
    processInstance.once("exit", () => { clearTimeout(timer); lines.close(); reject(new Error(`隔离进程提前退出：${stderr}`)); });
    lines.on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.event !== "listening" || typeof event.url !== "string") return;
      clearTimeout(timer);
      lines.close();
      resolve(event.url);
    });
  });
}

async function stop() {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  if (!child) return;
  const processInstance = child;
  if (processInstance.exitCode === null && !processInstance.stdin.destroyed) processInstance.stdin.write("shutdown\n");
  const result = await Promise.race([childExit, new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 5000);
    timer.unref();
  })]);
  if (!result) {
    processInstance.kill();
    await childExit;
    child = null;
    throw new Error("隔离进程正常退出超时");
  }
  child = null;
  assert.equal(result.code, 0, "隔离进程应正常退出");
}

async function connect(url, principal) {
  const client = new Client({ name: `isolation-demo-${principal.id}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${principal.token}` } },
  }));
  clients.push(client);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

try {
  const [sourcePrincipal, receiverPrincipal] = configuration.principals;
  const receiverBinding = configuration.targets.find(target => sourcePrincipal.allowed_targets.includes(target.binding_id));
  const sourceBinding = configuration.targets.find(target => receiverPrincipal.allowed_targets.includes(target.binding_id));
  const url = await launch();
  const source = await connect(url, sourcePrincipal);
  const receiver = await connect(url, receiverPrincipal);
  const resolved = await call(source, "communication_resolve_target", { caller: sourcePrincipal.identity, binding_id: receiverBinding.binding_id });
  const request = {
    caller: sourcePrincipal.identity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "demo-request" },
    target: address(resolved.target),
    dedupe_key: "demo-stable-request",
    text: "请核对隔离测试材料并保留原工作进度",
    reply_required: true,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const sent = await call(source, "communication_send_message", request);
  const messageId = sent.message.message_id;
  const delivered = await call(source, "communication_wait", { caller: sourcePrincipal.identity, message_id: messageId, until: "delivery", wait_ms: 5000 });
  assert.equal(delivered.matched, true);
  assert.equal((await call(source, "communication_get_message", { caller: sourcePrincipal.identity, message_id: messageId })).delivery.status, "accepted");
  await call(receiver, "communication_send_message", {
    caller: receiverPrincipal.identity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "demo-reply" },
    target: address(sourceBinding),
    dedupe_key: "demo-stable-reply",
    text: "隔离材料已核对",
    in_reply_to: messageId,
    expires_at: request.expires_at,
  });
  const reply = await call(source, "communication_wait", { caller: sourcePrincipal.identity, message_id: messageId, until: "reply", wait_ms: 5000 });
  assert.equal(reply.matched, true);
  assert.equal(reply.matched_by, "reply");
  assert.equal((await call(source, "communication_get_message", { caller: sourcePrincipal.identity, message_id: messageId })).message.processing, "pending");
  await call(receiver, "communication_ack_processing", { caller: receiverPrincipal.identity, message_id: messageId, delivery_id: sent.delivery.delivery_id, binding_generation: receiverBinding.binding_generation, processing: "done" });
  const pendingRequest = { ...request, dedupe_key: "demo-pending-recovery", text: "请在能力就绪后补收这条独立消息", delivery_policy: "when_idle" };
  const pending = await call(source, "communication_send_message", pendingRequest);
  const pendingObserved = await call(source, "communication_wait", { caller: sourcePrincipal.identity, message_id: pending.message.message_id, until: "delivery", wait_ms: 5000 });
  assert.equal(pendingObserved.matched, true);
  assert.equal((await call(source, "communication_get_message", { caller: sourcePrincipal.identity, message_id: pending.message.message_id })).delivery.status, "unsupported");
  assert.equal(pending.message.processing, "pending");
  await stop();
  for (const target of configuration.targets) target.capabilities.when_idle = true;
  fs.writeFileSync(configPath, JSON.stringify(configuration), { encoding: "utf8", mode: 0o600 });
  const reopenedUrl = await launch();
  const reopened = await connect(reopenedUrl, sourcePrincipal);
  const restored = await call(reopened, "communication_get_message", { caller: sourcePrincipal.identity, message_id: messageId });
  assert.equal(restored.message.processing, "done");
  const repeated = await call(reopened, "communication_send_message", request);
  assert.equal(repeated.message.message_id, messageId);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.delivery.delivery_id, sent.delivery.delivery_id);
  const pendingWait = await call(reopened, "communication_wait", { caller: sourcePrincipal.identity, message_id: pending.message.message_id, after_cursor: pendingObserved.next_cursor, until: "delivery", wait_ms: 5000 });
  assert.equal(pendingWait.matched, true);
  const recovered = await call(reopened, "communication_get_message", { caller: sourcePrincipal.identity, message_id: pending.message.message_id });
  assert.equal(recovered.delivery.status, "accepted");
  assert.equal(recovered.delivery.delivery_id, pending.delivery.delivery_id);
  assert.equal(recovered.message.processing, "pending");
  await stop();
  process.stdout.write(`${JSON.stringify({ mode: "mock_only", mcp_roundtrip: "PASS", reply_separate_from_processing: "PASS", graceful_exit: "PASS", process_reopen: "PASS", persistent_dedupe: "PASS", pending_recovery: "PASS" })}\n`);
} finally {
  await stop();
  const resolved = fs.realpathSync(directory);
  if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith("communication-core-demo-")) throw new Error("临时目录范围校验失败");
  fs.rmSync(resolved, { recursive: true });
}
