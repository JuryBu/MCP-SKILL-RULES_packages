import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { createCodexCommunicationAttachment } from "../src/codex-communication-attachment.mjs";

const instanceId = "conditional-attachment-fixture-instance";
const writerEpoch = "independent-writer-epoch-fixture";
const manifestSha256 = "51".repeat(32);
const adminToken = "conditional-attachment-admin-fixture-only";
const communicationToken = "conditional-attachment-communication-fixture-only";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function configuration(context, name = "first") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `conditional-attachment-${name}-`));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token.txt");
  const ledgerPath = path.join(directory, "ledger.json");
  const configPath = path.join(directory, "configuration.json");
  fs.writeFileSync(tokenFile, communicationToken);
  const bytes = Buffer.from(JSON.stringify({ host: "127.0.0.1", port: 0, token_file: tokenFile,
    ledger_path: ledgerPath, principal_id: "conditional-fixture-core",
    allowed_origins: [{ host: "codex", conversation_id: "conditional-fixture-core" }],
    allowed_targets: [{ conversation_id: "conditional-fixture-target", binding_generation: 1 }] }));
  fs.writeFileSync(configPath, bytes);
  return { configPath, ledgerPath, bytes, input: { config_path: configPath, expected_instance_id: instanceId,
    expected_manifest_sha256: manifestSha256, expected_configuration_sha256: sha256(bytes) } };
}

function parent() {
  const state = { instanceId, busy: false, failed: false, selected: { manifestSha256 } };
  const proxy = { closed: false, writerEpoch, liveCodeRuntime: { status: () => state },
    subscribeThread() {}, _liveReadyClients() { return []; }, _liveMaintenanceStatus() {}, _liveInjectRequest() {} };
  return { state, proxy };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function httpFixture(context) {
  const proxy = createCodexAppServerProxy({ upstreamUrl: "ws://127.0.0.1:1", downstreamPort: await freePort(),
    controlPort: await freePort(), controlToken: adminToken });
  context.after(() => proxy.close());
  await proxy.start();
  const endpoint = `http://127.0.0.1:${proxy.controlPort}`;
  async function request(method, body) {
    const response = await fetch(`${endpoint}/v1/communication/control`, { method,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { proxy, request };
}

test("conditional attachment returns exact immutable instance, manifest and configuration binding", async context => {
  const files = configuration(context);
  const { proxy } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  const attached = await attachment.attach(files.input);
  assert.deepEqual(attached.binding, { instance_id: instanceId, manifest_sha256: manifestSha256,
    configuration_sha256: sha256(files.bytes) });
  attached.binding.instance_id = "mutated-copy";
  assert.equal(attachment.status().binding.instance_id, instanceId);
  await attachment.close();
  assert.deepEqual(attachment.status(), { enabled: false, endpoint: null, configuration_path: null });
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
});

test("legacy attachment retains its original response shape", async context => {
  const files = configuration(context);
  const { proxy } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  const result = await attachment.attach({ config_path: files.configPath });
  assert.deepEqual(Object.keys(result).sort(), ["configuration_path", "enabled", "endpoint"]);
});

test("partial or malformed conditions fail before the ledger is opened", async context => {
  const files = configuration(context);
  const { proxy } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  for (const input of [{ config_path: files.configPath, expected_instance_id: instanceId },
    { ...files.input, expected_manifest_sha256: "bad-hash" }, { ...files.input, expected_instance_id: "" }]) {
    await assert.rejects(attachment.attach(input), /COMMUNICATION_ATTACH_CONDITIONS_INVALID/);
    assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
  }
});

test("stale instance, busy parent, failed parent or changed manifest cannot attach", async context => {
  const files = configuration(context);
  const { proxy, state } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  const changes = [() => { state.instanceId = "different-instance"; }, () => { state.busy = true; },
    () => { state.failed = true; }, () => { state.selected.manifestSha256 = "62".repeat(32); }];
  for (const change of changes) {
    proxy.writerEpoch = writerEpoch;
    Object.assign(state, { instanceId, busy: false, failed: false, selected: { manifestSha256 } });
    change();
    await assert.rejects(attachment.attach(files.input), /COMMUNICATION_PARENT_CONDITION_CHANGED/);
    assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
  }
});

test("changed configuration bytes cannot attach even when the parsed configuration is equivalent", async context => {
  const files = configuration(context);
  const { proxy } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  fs.appendFileSync(files.configPath, "\n");
  await assert.rejects(attachment.attach(files.input), /COMMUNICATION_CONFIGURATION_CONDITION_CHANGED/);
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
  assert.equal(attachment.status().enabled, false);
});

test("parent drift while the listener starts closes the candidate and releases its ledger", async context => {
  const files = configuration(context);
  const { proxy, state } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  const listening = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    state.selected.manifestSha256 = "73".repeat(32);
    return listening.apply(this, args);
  };
  try {
    await assert.rejects(attachment.attach(files.input), /COMMUNICATION_PARENT_CONDITION_CHANGED/);
  } finally {
    net.Server.prototype.listen = listening;
  }
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
  assert.equal(attachment.status().enabled, false);
  state.selected.manifestSha256 = manifestSha256;
  assert.equal((await attachment.attach(files.input)).enabled, true);
});

test("an independent writer epoch is accepted, but a change during startup is rejected", async context => {
  const files = configuration(context);
  const { proxy } = parent();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());
  const listening = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    proxy.writerEpoch = "replacement-writer-during-start";
    return listening.apply(this, args);
  };
  try {
    await assert.rejects(attachment.attach(files.input), /COMMUNICATION_PARENT_CONDITION_CHANGED/);
  } finally {
    net.Server.prototype.listen = listening;
  }
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
  assert.equal(attachment.status().enabled, false);
  assert.equal((await attachment.attach(files.input)).binding.instance_id, instanceId);
});

test("a closed old attachment is replaced, while an active attachment is preserved", async context => {
  const files = configuration(context);
  const { proxy, request } = await httpFixture(context);
  let oldAttachCalls = 0;
  const old = { status: () => ({ enabled: false }), attach() { oldAttachCalls += 1; throw new Error("OLD_FACTORY_USED"); }, async close() {} };
  proxy.communicationAttachment = old;
  const result = await request("POST", { config_path: files.configPath });
  assert.equal(result.body.enabled, true);
  assert.equal(oldAttachCalls, 0);
  const active = proxy.communicationAttachment;
  assert.equal((await request("GET")).body.enabled, true);
  await request("POST", { config_path: files.configPath });
  assert.equal(proxy.communicationAttachment, active);
  assert.equal((await request("DELETE")).body.enabled, false);
});

test("concurrent first attachments with separate ledgers cannot leave an unreachable listener", { timeout: 10000 }, async context => {
  const first = configuration(context, "first");
  const second = configuration(context, "second");
  const { proxy, request } = await httpFixture(context);
  const originalReadBody = proxy._liveReadBody.bind(proxy);
  let unblock;
  let bodyRead;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const firstReachedBody = new Promise(resolve => { bodyRead = resolve; });
  let firstRequest = true;
  proxy._liveReadBody = async (...args) => {
    if (firstRequest) { firstRequest = false; bodyRead(); await blocked; }
    return originalReadBody(...args);
  };
  const firstResult = request("POST", { config_path: first.configPath });
  await firstReachedBody;
  const secondResult = request("POST", { config_path: second.configPath });
  await new Promise(resolve => setImmediate(resolve));
  unblock();
  const results = await Promise.all([firstResult, secondResult]);
  const opened = results.filter(result => result.body.enabled === true);
  context.after(async () => { for (const result of opened) { try { await fetch(result.body.endpoint); } catch {} } });
  assert.equal(opened.length, 1);
  assert.equal((await request("GET")).body.endpoint, opened[0].body.endpoint);
  await request("DELETE");
  assert.equal(fs.existsSync(`${first.ledgerPath}.lock`), false);
  assert.equal(fs.existsSync(`${second.ledgerPath}.lock`), false);
  await assert.rejects(fetch(opened[0].body.endpoint));
});

test("a different factory drains an old in-flight attachment before replacing its manager", { timeout: 10000 }, async context => {
  const first = configuration(context, "old-factory");
  const second = configuration(context, "new-factory");
  const { proxy, request } = await httpFixture(context);
  const old = createCodexCommunicationAttachment(proxy);
  proxy.communicationAttachment = old;
  proxy.communicationAttachmentFactory = () => {};
  const listening = net.Server.prototype.listen;
  let release;
  let entered;
  const waitingForListen = new Promise(resolve => { entered = resolve; });
  net.Server.prototype.listen = function (...args) {
    const server = this;
    net.Server.prototype.listen = listening;
    release = () => listening.apply(server, args);
    entered();
    return this;
  };
  const firstAttach = old.attach({ config_path: first.configPath });
  context.after(async () => { net.Server.prototype.listen = listening; await old.close(); });
  await waitingForListen;
  const next = request("POST", { config_path: second.configPath });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(proxy.communicationAttachment, old);
  release();
  const oldReceipt = await firstAttach;
  const current = await next;
  assert.equal(current.body.enabled, true);
  assert.notEqual(proxy.communicationAttachment, old);
  assert.equal(old.status().enabled, false);
  await assert.rejects(fetch(oldReceipt.endpoint));
  assert.equal(fs.existsSync(`${first.ledgerPath}.lock`), false);
  await request("DELETE");
  assert.equal(fs.existsSync(`${second.ledgerPath}.lock`), false);
});
