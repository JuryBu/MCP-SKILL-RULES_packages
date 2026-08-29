import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAppToolsRelay,
  discoverAppToolsPipe,
  encodeJsonRpcFrame,
  isAppToolsListResponse,
  probeAppToolsPipe,
  resolveOfficialPluginServer,
} from "../src/codex-app-tools-compat-launcher.mjs";

function uniquePipe(label) {
  const name = `${label}-${process.pid}-${crypto.randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

function decodeFrames(onFrame) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const payload = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      onFrame(payload);
    }
  };
}

function appToolsList(id, suffix = "default") {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: [
        {
          name: `read_thread_${suffix}`,
          namespace: "codex_app",
          description: "read only",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: `plugin_status_${suffix}`,
          namespace: "plugin_management",
          description: "status",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  };
}

async function listen(server, pipePath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
}

async function closeServer(server, pipePath) {
  await new Promise((resolve) => server.close(resolve));
  if (process.platform !== "win32") fs.rmSync(pipePath, { force: true });
}

function createFakeAppToolsServer(pipePath, label) {
  const server = net.createServer((socket) => {
    socket.on("data", decodeFrames((message) => {
      if (message.method === "tools/list") {
        socket.write(encodeJsonRpcFrame(appToolsList(message.id, label)));
        return;
      }
      socket.write(encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: message.id,
        result: { label, method: message.method, params: message.params },
      }));
    }));
  });
  return { server, pipePath };
}

function requestPipe(pipePath, message, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("request timeout"));
    }, timeoutMs);
    socket.once("connect", () => socket.write(encodeJsonRpcFrame(message)));
    socket.on("data", decodeFrames((response) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    }));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("App Tools response validation accepts future tool names but requires codex_app namespace", () => {
  const id = "future-tools";
  assert.equal(isAppToolsListResponse(appToolsList(id, "future"), id), true);
  const unrelated = appToolsList(id, "other");
  unrelated.result.tools = unrelated.result.tools.filter((tool) => tool.namespace !== "codex_app");
  assert.equal(isAppToolsListResponse(unrelated, id), false);
  const malformed = appToolsList(id, "malformed");
  delete malformed.result.tools[0].inputSchema;
  assert.equal(isAppToolsListResponse(malformed, id), false);
});

test("discovery skips stale preferred pipe and selects the only verified candidate", async () => {
  const probes = [];
  const result = await discoverAppToolsPipe({
    preferredPath: "stale-pipe",
    listCandidates: () => ["browser-pipe", "verified-pipe"],
    probe: async (candidate) => {
      probes.push(candidate);
      return candidate === "verified-pipe"
        ? { valid: true, toolCount: 30, namespaces: ["codex_app"] }
        : { valid: false, reason: "not_app_tools" };
    },
  });
  assert.deepEqual(probes, ["stale-pipe", "browser-pipe", "verified-pipe"]);
  assert.equal(result.status, "selected");
  assert.equal(result.selected.pipePath, "verified-pipe");
});

test("discovery prefers a verified explicit pipe and refuses ambiguous implicit candidates", async () => {
  const validProbe = async () => ({ valid: true, toolCount: 30, namespaces: ["codex_app"] });
  const preferred = await discoverAppToolsPipe({
    preferredPath: "preferred-pipe",
    listCandidates: () => ["other-pipe"],
    probe: validProbe,
  });
  assert.equal(preferred.status, "selected");
  assert.equal(preferred.selected.pipePath, "preferred-pipe");

  const ambiguous = await discoverAppToolsPipe({
    listCandidates: () => ["first-pipe", "second-pipe"],
    probe: validProbe,
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.valid.length, 2);
});

test("discovery excludes the relay pipe even when a custom enumerator returns it", async () => {
  const probes = [];
  const result = await discoverAppToolsPipe({
    excludedPaths: ["relay-pipe"],
    listCandidates: () => ["relay-pipe", "desktop-pipe"],
    probe: async (candidate) => {
      probes.push(candidate);
      return { valid: true, toolCount: 30, namespaces: ["codex_app"] };
    },
  });
  assert.deepEqual(probes, ["desktop-pipe"]);
  assert.equal(result.selected.pipePath, "desktop-pipe");
});

test("real framed probe accepts App Tools and rejects malformed responses", { timeout: 10000 }, async (context) => {
  const validPath = uniquePipe("codex-app-tools-probe-valid");
  const valid = createFakeAppToolsServer(validPath, "valid");
  await listen(valid.server, validPath);
  context.after(() => closeServer(valid.server, validPath));
  const validResult = await probeAppToolsPipe(validPath, { timeoutMs: 1000 });
  assert.equal(validResult.valid, true);
  assert.equal(validResult.toolCount, 2);

  const malformedPath = uniquePipe("codex-app-tools-probe-malformed");
  const malformed = net.createServer((socket) => {
    socket.once("data", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(9 * 1024 * 1024, 0);
      socket.write(header);
    });
  });
  await listen(malformed, malformedPath);
  context.after(() => closeServer(malformed, malformedPath));
  const malformedResult = await probeAppToolsPipe(malformedPath, { timeoutMs: 1000 });
  assert.equal(malformedResult.valid, false);
  assert.equal(malformedResult.reason, "INVALID_FRAME_LENGTH");
});

test("relay forwards bytes and rediscovers the Desktop pipe after rotation", { timeout: 15000 }, async (context) => {
  const targetAPath = uniquePipe("codex-app-tools-target-a");
  const targetBPath = uniquePipe("codex-app-tools-target-b");
  const relayPath = uniquePipe("codex-app-tools-relay");
  const targetA = createFakeAppToolsServer(targetAPath, "A");
  const targetB = createFakeAppToolsServer(targetBPath, "B");
  let currentTarget = targetAPath;
  await listen(targetA.server, targetAPath);
  const relay = await createAppToolsRelay({
    stablePipePath: relayPath,
    listCandidates: () => [currentTarget],
    discoveryWaitMs: 1000,
    discoveryRetryMs: 25,
    timeoutMs: 500,
    logger: () => {},
  });
  context.after(async () => {
    await relay.close();
    if (targetA.server.listening) await closeServer(targetA.server, targetAPath);
    if (targetB.server.listening) await closeServer(targetB.server, targetBPath);
  });

  const first = await requestPipe(relayPath, {
    jsonrpc: "2.0",
    id: "first",
    method: "tools/call",
    params: { name: "read_thread" },
  });
  assert.deepEqual(first.result, { label: "A", method: "tools/call", params: { name: "read_thread" } });

  await closeServer(targetA.server, targetAPath);
  currentTarget = targetBPath;
  await listen(targetB.server, targetBPath);
  const second = await requestPipe(relayPath, {
    jsonrpc: "2.0",
    id: "second",
    method: "tools/call",
    params: { name: "list_threads" },
  });
  assert.deepEqual(second.result, { label: "B", method: "tools/call", params: { name: "list_threads" } });
});

test("relay preserves concurrent request ids when the target responds out of order", { timeout: 10000 }, async (context) => {
  const targetPath = uniquePipe("codex-app-tools-concurrent-target");
  const relayPath = uniquePipe("codex-app-tools-concurrent-relay");
  const target = net.createServer((socket) => {
    const pending = [];
    socket.on("data", decodeFrames((message) => {
      if (message.method === "tools/list") {
        socket.write(encodeJsonRpcFrame(appToolsList(message.id, "concurrent")));
        return;
      }
      pending.push(message);
      if (pending.length === 2) {
        for (const request of pending.reverse()) {
          socket.write(encodeJsonRpcFrame({ jsonrpc: "2.0", id: request.id, result: { order: request.params.order } }));
        }
      }
    }));
  });
  await listen(target, targetPath);
  const relay = await createAppToolsRelay({
    stablePipePath: relayPath,
    listCandidates: () => [targetPath],
    discoveryWaitMs: 1000,
    discoveryRetryMs: 25,
    timeoutMs: 500,
    logger: () => {},
  });
  context.after(async () => {
    await relay.close();
    if (target.listening) await closeServer(target, targetPath);
  });

  const responses = await new Promise((resolve, reject) => {
    const socket = net.createConnection(relayPath);
    const received = [];
    const timer = setTimeout(() => reject(new Error("concurrent timeout")), 3000);
    socket.once("connect", () => socket.write(Buffer.concat([
      encodeJsonRpcFrame({ jsonrpc: "2.0", id: "one", method: "tools/call", params: { order: 1 } }),
      encodeJsonRpcFrame({ jsonrpc: "2.0", id: "two", method: "tools/call", params: { order: 2 } }),
    ])));
    socket.on("data", decodeFrames((message) => {
      received.push(message);
      if (received.length === 2) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    }));
    socket.once("error", reject);
  });
  assert.deepEqual(responses.map((response) => response.id), ["two", "one"]);
  assert.deepEqual(responses.map((response) => response.result.order), [2, 1]);
});

test("missing Desktop pipe closes one plugin connection without killing the stable relay", { timeout: 15000 }, async (context) => {
  const targetPath = uniquePipe("codex-app-tools-late-target");
  const relayPath = uniquePipe("codex-app-tools-late-relay");
  let available = false;
  const target = createFakeAppToolsServer(targetPath, "late");
  const relay = await createAppToolsRelay({
    stablePipePath: relayPath,
    listCandidates: () => (available ? [targetPath] : []),
    discoveryWaitMs: 1000,
    discoveryRetryMs: 25,
    timeoutMs: 250,
    logger: () => {},
  });
  context.after(async () => {
    await relay.close();
    if (target.server.listening) await closeServer(target.server, targetPath);
  });

  await assert.rejects(
    requestPipe(relayPath, { jsonrpc: "2.0", id: "missing", method: "tools/list", params: {} }, 2500),
    (error) => ["ECONNRESET", "EPIPE"].includes(error.code) || error.message === "request timeout",
  );

  await listen(target.server, targetPath);
  available = true;
  const recovered = await requestPipe(relayPath, {
    jsonrpc: "2.0",
    id: "recovered",
    method: "tools/call",
    params: { name: "read_thread" },
  });
  assert.equal(recovered.result.label, "late");
});

test("official plugin resolver prefers current marketplace and otherwise uses newest cache", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-tools-resolver-"));
  try {
    const temporaryServer = path.join(home, ".codex", ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "codex-app-tools", "server.mjs");
    const oldServer = path.join(home, ".codex", "plugins", "cache", "openai-bundled", "codex-app-tools", "0.1.3", "server.mjs");
    const newServer = path.join(home, ".codex", "plugins", "cache", "openai-bundled", "codex-app-tools", "26.900.1", "server.mjs");
    for (const serverPath of [temporaryServer, oldServer, newServer]) {
      fs.mkdirSync(path.dirname(serverPath), { recursive: true });
      fs.writeFileSync(serverPath, "export {};\n", "utf8");
    }
    assert.equal(resolveOfficialPluginServer({ home }), temporaryServer);
    fs.rmSync(temporaryServer, { force: true });
    assert.equal(resolveOfficialPluginServer({ home }), newServer);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
