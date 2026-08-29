import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_DISCOVERY_WAIT_MS = 15000;
const DEFAULT_DISCOVERY_RETRY_MS = 250;
const DEFAULT_PIPE_PREFIXES = ["codex-browser-use-", "codex-app-tools-"];
const DEFAULT_REQUIRED_NAMESPACES = ["codex_app"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function safeLogger(event) {
  process.stderr.write(`[codex-app-tools-compat] ${JSON.stringify(event)}\n`);
}

function pipeIdentity(pipePath) {
  return crypto.createHash("sha256").update(String(pipePath)).digest("hex").slice(0, 12);
}

export function encodeJsonRpcFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function createFrameReader(options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    if (buffered.length < 4) return null;
    const length = buffered.readUInt32LE(0);
    if (length < 2 || length > maxFrameBytes) throw new Error("INVALID_FRAME_LENGTH");
    if (buffered.length < length + 4) return null;
    const payload = buffered.subarray(4, length + 4);
    buffered = buffered.subarray(length + 4);
    if (buffered.length) throw new Error("UNEXPECTED_EXTRA_FRAME");
    return JSON.parse(payload.toString("utf8"));
  };
}

export function isAppToolsListResponse(message, requestId, options = {}) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || message.id !== requestId) return false;
  const tools = message?.result?.tools;
  if (!Array.isArray(tools) || !tools.length) return false;
  if (!tools.every((tool) => isObject(tool)
    && typeof tool.name === "string"
    && tool.name.length > 0
    && typeof tool.namespace === "string"
    && tool.namespace.length > 0
    && isObject(tool.inputSchema))) return false;
  const namespaces = new Set(tools.map((tool) => tool.namespace));
  const requiredNamespaces = options.requiredNamespaces ?? DEFAULT_REQUIRED_NAMESPACES;
  return requiredNamespaces.some((namespace) => namespaces.has(namespace));
}

export function probeAppToolsPipe(pipePath, options = {}) {
  const netImpl = options.netImpl ?? net;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 100, 10000);
  const requestId = `compat-${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    const socket = netImpl.createConnection(pipePath);
    const readFrame = createFrameReader({ maxFrameBytes: options.maxFrameBytes });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ valid: false, reason: "timeout" }), timeoutMs);
    socket.once("connect", () => {
      socket.write(encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/list",
        params: { threadStartKind: "all" },
      }));
    });
    socket.on("data", (chunk) => {
      try {
        const message = readFrame(chunk);
        if (!message) return;
        if (!isAppToolsListResponse(message, requestId, options)) {
          finish({ valid: false, reason: "unexpected_response" });
          return;
        }
        const tools = message.result.tools;
        finish({
          valid: true,
          reason: "verified",
          toolCount: tools.length,
          namespaces: [...new Set(tools.map((tool) => tool.namespace))].sort(),
        });
      } catch (error) {
        finish({ valid: false, reason: error?.message ?? "invalid_frame" });
      }
    });
    socket.once("error", (error) => finish({ valid: false, reason: error?.code ?? "socket_error" }));
    socket.once("close", () => finish({ valid: false, reason: "closed" }));
  });
}

function windowsPipePath(name) {
  return `\\\\.\\pipe\\${name}`;
}

export function listNamedPipeCandidates(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const prefixes = options.prefixes ?? DEFAULT_PIPE_PREFIXES;
  const excluded = new Set((options.excludedPaths ?? []).map((value) => String(value).toLowerCase()));
  if ((options.platform ?? process.platform) !== "win32") return [];
  let names = [];
  try {
    names = fsImpl.readdirSync("\\\\.\\pipe\\");
  } catch {
    return [];
  }
  return names
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map(windowsPipePath)
    .filter((candidate) => !excluded.has(candidate.toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

export async function discoverAppToolsPipe(options = {}) {
  const preferredPath = typeof options.preferredPath === "string" ? options.preferredPath.trim() : "";
  const excludedPaths = options.excludedPaths ?? [];
  const probe = options.probe ?? ((candidate) => probeAppToolsPipe(candidate, options));
  const discovered = typeof options.listCandidates === "function"
    ? await options.listCandidates()
    : listNamedPipeCandidates({ ...options, excludedPaths });
  const excluded = new Set(excludedPaths.map((value) => String(value).toLowerCase()));
  const candidates = [];
  if (preferredPath && !excludedPaths.some((value) => value.toLowerCase() === preferredPath.toLowerCase())) {
    candidates.push(preferredPath);
  }
  for (const candidate of discovered.filter((value) => !excluded.has(String(value).toLowerCase()))) {
    if (!candidates.some((value) => value.toLowerCase() === candidate.toLowerCase())) candidates.push(candidate);
  }
  const valid = [];
  for (const candidate of candidates) {
    const result = await probe(candidate);
    if (result?.valid) valid.push({ pipePath: candidate, ...result });
  }
  if (preferredPath) {
    const preferred = valid.find((candidate) => candidate.pipePath.toLowerCase() === preferredPath.toLowerCase());
    if (preferred) return { status: "selected", selected: preferred, valid };
  }
  if (valid.length === 1) return { status: "selected", selected: valid[0], valid };
  if (valid.length > 1) return { status: "ambiguous", selected: null, valid };
  return { status: "not_found", selected: null, valid: [] };
}

function defaultStablePipePath() {
  const name = `napcat-app-tools-relay-${process.pid}-${crypto.randomUUID()}`;
  return process.platform === "win32" ? windowsPipePath(name) : path.join(os.tmpdir(), `${name}.sock`);
}

function connectPipe(pipePath, netImpl = net) {
  return new Promise((resolve, reject) => {
    const socket = netImpl.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function createAppToolsRelay(options = {}) {
  const netImpl = options.netImpl ?? net;
  const logger = options.logger ?? safeLogger;
  const stablePipePath = options.stablePipePath ?? defaultStablePipePath();
  const preferredPath = options.preferredPath ?? process.env.CODEX_APP_TOOLS_PIPE_PATH ?? "";
  const discoveryWaitMs = boundedInteger(options.discoveryWaitMs, DEFAULT_DISCOVERY_WAIT_MS, 1000, 120000);
  const discoveryRetryMs = boundedInteger(options.discoveryRetryMs, DEFAULT_DISCOVERY_RETRY_MS, 50, 5000);
  const sockets = new Set();
  let closed = false;

  const discover = options.discover ?? (() => discoverAppToolsPipe({
    ...options,
    preferredPath,
    excludedPaths: [...(options.excludedPaths ?? []), stablePipePath],
  }));

  const server = netImpl.createServer((client) => {
    sockets.add(client);
    client.pause();
    client.once("close", () => sockets.delete(client));
    void (async () => {
      const deadline = Date.now() + discoveryWaitMs;
      let lastStatus = "not_found";
      while (!closed && !client.destroyed && Date.now() < deadline) {
        const result = await discover();
        lastStatus = result.status;
        if (result.status === "ambiguous") {
          logger({ event: "app_tools_pipe_ambiguous", candidateCount: result.valid.length });
          break;
        }
        if (result.selected?.pipePath) {
          try {
            const target = await connectPipe(result.selected.pipePath, netImpl);
            if (closed || client.destroyed) {
              target.destroy();
              return;
            }
            sockets.add(target);
            target.once("close", () => sockets.delete(target));
            logger({
              event: "app_tools_pipe_connected",
              pipeId: pipeIdentity(result.selected.pipePath),
              toolCount: result.selected.toolCount,
            });
            client.pipe(target);
            target.pipe(client);
            client.resume();
            const closePair = () => {
              client.destroy();
              target.destroy();
            };
            client.once("error", closePair);
            target.once("error", closePair);
            client.once("close", () => target.destroy());
            target.once("close", () => client.destroy());
            return;
          } catch (error) {
            logger({ event: "app_tools_pipe_connect_retry", code: error?.code ?? "CONNECT_ERROR" });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, discoveryRetryMs));
      }
      logger({ event: "app_tools_pipe_unavailable", status: lastStatus });
      client.destroy();
    })();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(stablePipePath, resolve);
  });
  logger({ event: "relay_ready", pipeId: pipeIdentity(stablePipePath) });

  return {
    stablePipePath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== "win32") fs.rmSync(stablePipePath, { force: true });
    },
  };
}

function versionParts(value) {
  return String(value).split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersionsDescending(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta) return delta;
  }
  return right.localeCompare(left);
}

export function resolveOfficialPluginServer(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const home = options.home ?? os.homedir();
  const explicit = options.explicitPath ?? process.env.CODEX_APP_TOOLS_SERVER_PATH;
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(path.join(home, ".codex", ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "codex-app-tools", "server.mjs"));
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "openai-bundled", "codex-app-tools");
  try {
    const versions = fsImpl.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDescending);
    for (const version of versions) candidates.push(path.join(cacheRoot, version, "server.mjs"));
  } catch {
  }
  const selected = candidates.find((candidate) => {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!selected) {
    const error = new Error("找不到官方 codex-app-tools server.mjs");
    error.code = "OFFICIAL_PLUGIN_NOT_FOUND";
    throw error;
  }
  return selected;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--plugin-server") options.explicitPath = argv[++index];
    else if (value === "--probe-timeout-ms") options.probeTimeoutMs = argv[++index];
    else if (value === "--discovery-wait-ms") options.discoveryWaitMs = argv[++index];
    else if (value === "--discovery-retry-ms") options.discoveryRetryMs = argv[++index];
    else {
      const error = new Error(`未知参数: ${value}`);
      error.code = "INVALID_ARGUMENT";
      throw error;
    }
  }
  return options;
}

export async function runCompatLauncher(options = {}) {
  const logger = options.logger ?? safeLogger;
  const pluginServer = resolveOfficialPluginServer(options);
  const relay = await createAppToolsRelay({
    ...options,
    timeoutMs: boundedInteger(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 100, 10000),
    logger,
  });
  const child = (options.spawnImpl ?? spawn)(process.execPath, [pluginServer], {
    env: { ...process.env, ...options.env, CODEX_APP_TOOLS_PIPE_PATH: relay.stablePipePath },
    stdio: "inherit",
    windowsHide: true,
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await relay.close();
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  child.once("error", async (error) => {
    logger({ event: "official_plugin_spawn_failed", code: error?.code ?? "SPAWN_ERROR" });
    await shutdown("SIGTERM");
    process.exitCode = 1;
  });
  child.once("exit", async (code, signal) => {
    await relay.close();
    if (signal) logger({ event: "official_plugin_exited", signal });
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
  return { child, relay, pluginServer };
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  try {
    await runCompatLauncher(parseCliArgs(process.argv.slice(2)));
  } catch (error) {
    safeLogger({ event: "launcher_failed", code: error?.code ?? "LAUNCHER_ERROR", message: error?.message });
    process.exitCode = 1;
  }
}
