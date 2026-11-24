import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { communicationTools, listCommunicationToolDefinitions } from "./mcp-server.mjs";

export const FACADE_INSTRUCTIONS = "每次调用填写本地真实caller四字段：machine_id、host、surface、conversation_id，对话ID须具体。已登记的宿主统一入口可供该宿主各对话使用，无需逐个登记CID。目标按端和对话ID寻址，参数以工具schema为准。发送默认next_model_boundary，能中途插入就插入；仅明确延后时用when_idle。Codex新消息默认hidden，显示全部气泡可选message_visibility=visible。QQ来信回原QQ。等待投递或回复与确认处理分开，实际处理后才ACK确认。结果未知时查原请求ID，保持原dedupe_key，不自动重发。门面只连接原核心，不启动服务。caller由本机可信入口声明，broker未提供可信宿主CID，门面按登记选连接，未鉴别实际宿主来源。普通代理发送的origin.kind填写agent_message，source_ref通常填当前真实对话ID，不能自行声明human_message。QQ最近内容无需绑定或启用采集；下载使用本调用者从对应窗口取得的attachment_ref，结果未知先核对原请求与目录，不换引用重下。普通发送可省dedupe_key与expires_at（默认同分钟去重、24h过期）；ack_processing可仅填caller、message_id、processing（可选note附简短进度）；收合法in_reply_to回信自动销账。";

const CONNECT_TIMEOUT_MS = 4000;
const CALL_TIMEOUT_MS = 49000;
const identityFields = { machine_id: 128, host: 64, surface: 64, conversation_id: 256 };
const callerScopeFields = ["machine_id", "host", "surface"];
const errors = {
  invalid_input: "调用参数无效，必须显式填写当前caller全身份与原工具参数",
  caller_unregistered: "当前caller全身份未获唯一登记授权",
  facade_config_invalid: "门面登记、连接或端点配置无效，请联系本机维护任务",
  facade_closed: "门面已关闭，请查询原请求状态",
  core_connect_failed: "未能连接原核心，本次工具操作尚未转交",
  core_call_failed: "核心调用未取得结果，请只查询原请求并保持原去重键",
  request_cancelled: "本次等待已取消，请查询原请求状态并保持原去重键",
};

function failure(code) {
  const message = errors[code];
  return { isError: true, structuredContent: { error: { code, message } }, content: [{ type: "text", text: `${message}（${code}）` }] };
}

function invalidConfig() {
  throw new Error("facade_config_invalid");
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedText(value, maximum) {
  return typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value, "utf8") <= maximum;
}

function identityKey(identity) {
  if (!exactObject(identity, Object.keys(identityFields)) || Object.entries(identityFields).some(([field, maximum]) => !boundedText(identity[field], maximum))) return null;
  return JSON.stringify(Object.keys(identityFields).map(field => identity[field]));
}

function callerScopeKey(scope) {
  if (!exactObject(scope, callerScopeFields) || callerScopeFields.some(field => !boundedText(scope[field], identityFields[field]))) return null;
  return JSON.stringify(callerScopeFields.map(field => scope[field]));
}

function selectConnection(connections, caller) {
  const scope = callerScopeKey(Object.fromEntries(callerScopeFields.map(field => [field, caller[field]])));
  return connections.find(connection => connection.scope === scope) ?? connections.find(connection => !connection.scope && connection.principal === identityKey(caller));
}

function pathKey(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) invalidConfig();
  const normalized = normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, maximum = 1048576) {
  pathKey(filePath);
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > maximum) invalidConfig();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) invalidConfig();
    const text = bytes.subarray(0, length).toString("utf8").replace(/^\uFEFF/, "");
    return { value: JSON.parse(text), fingerprint: digest(text) };
  } finally {
    await handle.close();
  }
}

async function readRegistry(registryFile) {
  const { value: registry } = await readJson(registryFile);
  if (!exactObject(registry, ["version", "connections"]) || registry.version !== 1 || !Array.isArray(registry.connections) || registry.connections.length < 1 || registry.connections.length > 128) invalidConfig();
  const paths = new Set();
  const identities = new Set();
  const scopes = new Set();
  const tokens = new Set();
  const connections = [];
  for (const item of registry.connections) {
    if (!exactObject(item, ["connection_file"])) invalidConfig();
    const profilePath = pathKey(item.connection_file);
    if (paths.has(profilePath)) invalidConfig();
    paths.add(profilePath);
    const profile = await readJson(item.connection_file, 65536);
    const connection = profile.value;
    const hasScope = Object.hasOwn(connection ?? {}, "caller_scope");
    if (!exactObject(connection, ["endpoint_file", "identity", "token", ...(hasScope ? ["caller_scope"] : [])])) invalidConfig();
    const principal = identityKey(connection.identity);
    if (!principal || identities.has(principal) || !boundedText(connection.token, 4096) || !/^[A-Za-z0-9._~+/-]+=*$/.test(connection.token)) invalidConfig();
    const scope = hasScope ? callerScopeKey(connection.caller_scope) : null;
    if (hasScope) {
      if (!scope || scopes.has(scope) || connection.identity.conversation_id !== "*" || callerScopeFields.some(field => connection.identity[field] !== connection.caller_scope[field])) invalidConfig();
      scopes.add(scope);
    } else if (connection.identity.conversation_id === "*") invalidConfig();
    identities.add(principal);
    const tokenKey = digest(connection.token);
    if (tokens.has(tokenKey)) invalidConfig();
    tokens.add(tokenKey);
    const endpoint = (await readJson(connection.endpoint_file, 65536)).value;
    if (endpoint.version !== 1 || endpoint.state !== "listening" || !boundedText(endpoint.owner_id, 256) || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || pathKey(endpoint.endpoint_file) !== pathKey(connection.endpoint_file) || !boundedText(endpoint.started_at, 128)) invalidConfig();
    pathKey(endpoint.config_path);
    pathKey(endpoint.state_dir);
    if (typeof endpoint.url !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)(?::[0-9]{1,5})?\/mcp$/.test(endpoint.url)) invalidConfig();
    const url = new URL(endpoint.url);
    if (url.port === "0" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") invalidConfig();
    const key = digest(JSON.stringify([profilePath, profile.fingerprint, principal, endpoint.owner_id, url.href, pathKey(endpoint.config_path), pathKey(endpoint.state_dir), endpoint.started_at]));
    connections.push({ key, principal, scope, url: url.href, token: connection.token, identity: connection.identity });
  }
  return connections;
}

async function withSignal(operation, signal) {
  if (signal.aborted) throw new Error("request_cancelled");
  let aborted;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("request_cancelled");
        return operation();
      }),
      new Promise((resolve, reject) => {
        aborted = () => reject(new Error("request_cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export async function createFacadeHttpClient({ url, token, signal, timeoutMs }) {
  const endpoint = new URL(url);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (input, init) => {
      if (new URL(input instanceof Request ? input.url : input).href !== endpoint.href) throw new Error("facade_endpoint_changed");
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    },
  });
  const client = new Client({ name: "communication-core-broker-facade", version: "0.1.0" });
  try {
    const connecting = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    await withSignal(() => client.connect(transport, { signal: connecting, timeout: timeoutMs }), connecting);
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error("core_connect_failed");
  }
}

export async function createMcpStdioFacade({ registryFile = process.env.COMMUNICATION_CORE_FACADE_REGISTRY, clientFactory = createFacadeHttpClient } = {}) {
  try { await readRegistry(registryFile); } catch { throw new Error("facade_config_invalid"); }
  const clients = new Map();
  const ownedClients = new Set();
  const lifetime = new AbortController();
  let closePromise;
  const server = new Server({ name: "communication-core-broker-facade", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: FACADE_INSTRUCTIONS });

  async function retire(entry, force = false) {
    entry.retired = true;
    if (clients.get(entry.key) === entry) clients.delete(entry.key);
    if (!force && entry.active) return;
    if (entry.closing) return entry.closing;
    entry.controller.abort();
    entry.closing = entry.ready.then(client => client.close()).catch(() => {}).finally(() => ownedClients.delete(entry));
    return entry.closing;
  }

  async function callTool(name, args, extra = {}) {
    if (lifetime.signal.aborted) return failure("facade_closed");
    const definition = communicationTools.find(entry => entry.definition.name === name);
    const parsed = definition?.validator.safeParse(args);
    if (!parsed?.success || !identityKey(parsed.data.caller) || parsed.data.caller.conversation_id === "*") return failure("invalid_input");
    const signal = AbortSignal.any([lifetime.signal, ...(extra.signal ? [extra.signal] : [])]);
    let snapshot;
    try { snapshot = await readRegistry(registryFile); } catch {
      await Promise.all([...clients.values()].map(entry => retire(entry)));
      return failure("facade_config_invalid");
    }
    if (signal.aborted) return failure("request_cancelled");
    const currentKeys = new Set(snapshot.map(connection => connection.key));
    await Promise.all([...clients.values()].filter(entry => !currentKeys.has(entry.key)).map(entry => retire(entry)));
    const connection = selectConnection(snapshot, parsed.data.caller);
    if (!connection) return failure("caller_unregistered");
    let entry = clients.get(connection.key);
    if (!entry) {
      const controller = new AbortController();
      entry = { key: connection.key, controller, active: 0, retired: false, closing: false };
      entry.ready = Promise.resolve().then(() => clientFactory({ url: connection.url, token: connection.token, identity: { ...connection.identity }, signal: AbortSignal.any([lifetime.signal, controller.signal]), timeoutMs: CONNECT_TIMEOUT_MS }));
      entry.ready.catch(() => {});
      clients.set(connection.key, entry);
      ownedClients.add(entry);
    }
    entry.active += 1;
    let started = false;
    try {
      const client = await withSignal(() => entry.ready, signal);
      let current;
      try { current = await readRegistry(registryFile); } catch {
        await Promise.all([...clients.values()].map(candidate => retire(candidate)));
        return failure("facade_config_invalid");
      }
      if (selectConnection(current, parsed.data.caller)?.key !== connection.key) {
        await retire(entry);
        return failure("caller_unregistered");
      }
      if (signal.aborted) return failure("request_cancelled");
      started = true;
      const result = await withSignal(() => client.callTool({ name, arguments: parsed.data }, undefined, { signal, timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: false }), signal);
      const validated = CallToolResultSchema.safeParse(result);
      if (!validated.success) throw new Error("core_call_failed");
      return validated.data;
    } catch {
      entry.retired = true;
      return failure(signal.aborted ? "request_cancelled" : started ? "core_call_failed" : "core_connect_failed");
    } finally {
      entry.active -= 1;
      if (entry.retired) await retire(entry);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listCommunicationToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => callTool(request.params.name, request.params.arguments, extra));

  function close() {
    if (closePromise) return closePromise;
    lifetime.abort();
    closePromise = Promise.resolve().then(async () => {
      await server.close().catch(() => {});
      await Promise.all([...ownedClients].map(entry => retire(entry, true)));
    });
    return closePromise;
  }

  server.onclose = () => { void close(); };
  return { server, callTool, connect: (transport = new StdioServerTransport()) => server.connect(transport), close };
}
