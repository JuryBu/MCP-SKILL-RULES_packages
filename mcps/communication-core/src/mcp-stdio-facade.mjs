import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { communicationContactsTool, communicationToolEntries, listCommunicationToolDefinitions, withSubmittedCaller } from "./mcp-server.mjs";

export const FACADE_INSTRUCTIONS =
  "每次填写真实 caller 的 host 与稳定 conversation_id。唯一匹配登记时可省 machine_id、surface；有多个匹配须补齐。已登记的宿主统一入口无需逐个登记CID；broker未提供可信宿主CID，门面按登记选连接，未鉴别实际宿主来源。" +
  "目标按端和对话ID寻址，也可用原绑定或已启用的联系人。普通代理发送可省 origin，本人来源需要原授权。发送默认next_model_boundary，能中途插入就插入；仅明确延后时用when_idle。Codex新消息默认hidden，可用message_visibility=visible。QQ来信回原QQ。" +
  "等待投递或回复与确认处理分开，实际处理后才ACK。结果未知时查原请求ID，保持原dedupe_key，不自动重发。门面只连接原核心，不启动服务。共享门面启用通讯录后可只读本机共有联系人；个人读写通过能核实具体对话的独立入口。" +
  "QQ 最近内容无需绑定或启用采集；下载使用本调用者在对应窗口取得的 attachment_ref，结果未知先核原请求与目录。普通发送可省 dedupe_key 与 expires_at（同分钟去重、24h 过期）；ack_processing 可只填 caller、message_id、processing，附可选进度 note；合法 in_reply_to 回信可确认原信。";

const CONNECT_TIMEOUT_MS = 4000;
const CALL_TIMEOUT_MS = 49000;
const identityFields = { machine_id: 128, host: 64, surface: 64, conversation_id: 256 };
const callerScopeFields = ["machine_id", "host", "surface"];
const errors = {
  invalid_input: "调用参数无效，请填写真实的 caller.host 与 caller.conversation_id，并补全该工具所需字段",
  caller_unregistered: "当前caller全身份未获唯一登记授权",
  caller_unverified: "当前入口仅能查看共有通讯录",
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

function completeFacadeCaller(connections, caller) {
  if (caller.machine_id !== undefined && caller.surface !== undefined) return identityKey(caller) ? caller : null;
  const candidates = new Map();
  for (const connection of connections) {
    const identity = connection.identity;
    if (caller.host !== identity.host || (caller.machine_id !== undefined && caller.machine_id !== identity.machine_id) ||
      (caller.surface !== undefined && caller.surface !== identity.surface) ||
      (!connection.scope && identity.conversation_id !== caller.conversation_id)) continue;
    const completed = { ...caller, machine_id: identity.machine_id, surface: identity.surface };
    candidates.set(identityKey(completed), completed);
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
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
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Communication-Core-Shared-Facade": "1" }, redirect: "error" },
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

export async function createMcpStdioFacade({ registryFile = process.env.COMMUNICATION_CORE_FACADE_REGISTRY, clientFactory = createFacadeHttpClient,
  includeContacts = process.env.COMMUNICATION_CORE_FACADE_CONTACTS === "1",
  includeMultiRecipient = process.env.COMMUNICATION_CORE_FACADE_MULTI_RECIPIENT === "1" } = {}) {
  try { await readRegistry(registryFile); } catch { throw new Error("facade_config_invalid"); }
  const features = { includeContacts, includeMultiRecipient };
  const entries = communicationToolEntries(features);
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
    const definition = entries.find(entry => entry.definition.name === name);
    const parsed = definition?.validator.safeParse(args);
    if (!parsed?.success || parsed.data.caller.conversation_id === "*") return failure("invalid_input");
    const submittedCaller = definition === communicationContactsTool ? parsed.data.caller : undefined;
    const fail = code => withSubmittedCaller(failure(code), submittedCaller);
    if (submittedCaller && !["list", "get"].includes(parsed.data.action)) return fail("caller_unverified");
    const signal = AbortSignal.any([lifetime.signal, ...(extra.signal ? [extra.signal] : [])]);
    let snapshot;
    try { snapshot = await readRegistry(registryFile); } catch {
      await Promise.all([...clients.values()].map(entry => retire(entry)));
      return fail("facade_config_invalid");
    }
    if (signal.aborted) return fail("request_cancelled");
    const currentKeys = new Set(snapshot.map(connection => connection.key));
    await Promise.all([...clients.values()].filter(entry => !currentKeys.has(entry.key)).map(entry => retire(entry)));
    const caller = completeFacadeCaller(snapshot, parsed.data.caller);
    const connection = caller && selectConnection(snapshot, caller);
    if (!connection) return fail("caller_unregistered");
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
        return fail("facade_config_invalid");
      }
      const currentCaller = completeFacadeCaller(current, parsed.data.caller);
      if (!currentCaller || identityKey(currentCaller) !== identityKey(caller) || selectConnection(current, currentCaller)?.key !== connection.key) {
        await retire(entry);
        return fail("caller_unregistered");
      }
      if (signal.aborted) return fail("request_cancelled");
      started = true;
      const result = await withSignal(() => client.callTool({ name, arguments: { ...parsed.data, caller } }, undefined, { signal, timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: false }), signal);
      const validated = CallToolResultSchema.safeParse(result);
      if (!validated.success) throw new Error("core_call_failed");
      return withSubmittedCaller(validated.data, submittedCaller);
    } catch {
      entry.retired = true;
      return fail(signal.aborted ? "request_cancelled" : started ? "core_call_failed" : "core_connect_failed");
    } finally {
      entry.active -= 1;
      if (entry.retired) await retire(entry);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listCommunicationToolDefinitions(features) }));
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
