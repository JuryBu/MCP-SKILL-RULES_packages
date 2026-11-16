import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CoreError, normalizeIdentity } from "./contracts.mjs";

const REQUEST_TIMEOUT_MS = 50000;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_CONTROL_REQUESTS = 4;
const MAX_TRACKED_REQUEST_IDS = 1024;
const messages = {
  invalid_input: "调用参数无效，请核对工具参数与大小限制",
  invalid_cursor: "游标无效，请使用当前消息返回的游标",
  caller_mismatch: "来源对话与当前连接授权不一致",
  forbidden: "当前连接没有这项操作的授权",
  source_unverified: "消息来源缺少对应授权",
  binding_changed: "目标绑定已经变化，请重新解析目标",
  not_found: "没有找到可访问的消息或目标",
  server_closed: "服务正在关闭，等待已经结束",
  request_closed: "请求连接已经关闭",
  request_cancelled: "请求已取消，已持久化的消息可继续查询原投递状态",
  request_timeout: "请求超时，请核对原消息状态后再继续",
  internal_error: "服务暂时无法完成操作，请核对原消息状态",
};

function textField(maximum) {
  return {
    schema: { type: "string", minLength: 1, maxLength: maximum },
    validator: z.string().min(1).max(maximum).refine(value => Boolean(value.trim()) && Buffer.byteLength(value, "utf8") <= maximum),
  };
}

function integerField(minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return { schema: { type: "integer", minimum, maximum }, validator: z.number().int().min(minimum).max(maximum) };
}

function optional(field) {
  return { ...field, optional: true, validator: field.validator.optional() };
}

function nullable(field) {
  return { schema: { anyOf: [field.schema, { type: "null" }] }, validator: field.validator.nullable() };
}

function objectField(fields) {
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema])),
      required: Object.entries(fields).filter(([, field]) => !field.optional).map(([name]) => name),
      additionalProperties: false,
    },
    validator: z.object(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.validator]))).strict(),
  };
}

function arrayField(field, maximum) {
  return { schema: { type: "array", items: field.schema, maxItems: maximum }, validator: z.array(field.validator).max(maximum) };
}

const booleanField = { schema: { type: "boolean" }, validator: z.boolean() };
const identityFields = {
  machine_id: textField(128),
  host: textField(64),
  surface: optional(textField(64)),
  conversation_id: textField(256),
};
const callerField = objectField(identityFields);
const boundTargetField = objectField({ ...identityFields, binding_id: textField(128), binding_generation: integerField(1) });
const addressField = objectField({ machine_id: optional(textField(128)), host: textField(64), surface: optional(textField(64)), conversation_id: textField(256) });
const targetField = {
  schema: { anyOf: [boundTargetField.schema, addressField.schema] },
  validator: z.union([boundTargetField.validator, addressField.validator]),
};
const receiptField = objectField({
  component: textField(64),
  resource_id: textField(256),
  generation: integerField(1),
  wake_id: textField(256),
  notification_id: optional(nullable(textField(256))),
  event_ids: arrayField({ schema: { anyOf: [{ type: "string" }, { type: "integer" }] }, validator: z.union([z.string(), z.number().int().safe()]) }, 1000),
});

function tool(name, method, description, fields, readOnly) {
  const parameters = objectField({ caller: callerField, ...fields });
  return {
    definition: {
      name: `communication_${name}`,
      description,
      inputSchema: parameters.schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    method,
    validator: parameters.validator,
  };
}

const tools = [
  tool("list_conversations", "listConversations", "分页列出当前连接获准访问的对话绑定。保留目标的证据状态，模拟目标会标记 simulated。", {
    host: optional(textField(64)), limit: optional(integerField(1, 100)), cursor: optional(nullable(textField(512))),
  }, true),
  tool("resolve_target", "resolveTarget", "按宿主端和对话ID解析目标，或兼容旧binding_id。已启用宿主无需逐对话开通；返回身份及投递接线，实际在线状态另查。", {
    binding_id: optional(textField(128)),
    machine_id: optional(textField(128)), host: optional(textField(64)), surface: optional(textField(64)), conversation_id: optional(textField(256)),
  }, true),
  tool("send_message", "sendMessage", "向端和对话ID或已有绑定发消息，默认next_model_boundary，在宿主支持的下一接收边界中途送入，保留原工具。when_idle仅用于明确延后。Codex默认hidden；未知结果沿原ID查询。", {
    origin: objectField({ kind: textField(64), channel: textField(64), source_ref: textField(512) }),
    target: targetField,
    dedupe_key: textField(128),
    text: textField(262144),
    attachment_refs: optional(arrayField(textField(512), 32)),
    delivery_policy: optional({ schema: { type: "string", enum: ["next_model_boundary", "when_idle"], default: "next_model_boundary", description: "默认能中途插入就插入，原工具继续；仅明确要求延后或宿主确实只支持空闲时用when_idle" }, validator: z.enum(["next_model_boundary", "when_idle"]) }),
    message_visibility: optional({ schema: { type: "string", enum: ["hidden", "visible"], description: "仅用于Codex注入，省略时新消息默认hidden；visible保留全部消息气泡" }, validator: z.enum(["hidden", "visible"]) }),
    reply_required: optional(booleanField),
    expires_at: textField(64),
    in_reply_to: optional(nullable(textField(256))),
    origin_receipt_binding: optional(nullable(receiptField)),
  }, false),
  tool("get_message", "getMessage", "读取当前来源或接收方有权访问的消息、投递状态与后续事件游标。", {
    message_id: textField(256),
  }, true),
  tool("wait", "wait", "从消息游标之后分页等待事件。单次等待最多45000毫秒，超时或关闭时结束，回复判定由核心执行。", {
    message_id: textField(256),
    after_cursor: optional(nullable(textField(512))),
    until: optional({ schema: { type: "string", enum: ["reply", "delivery", "processing", "any"] }, validator: z.enum(["reply", "delivery", "processing", "any"]) }),
    wait_ms: optional(integerField(0, 45000)),
    limit: optional(integerField(1, 100)),
  }, true),
  tool("ack_processing", "ackProcessing", "由接收对话确认指定消息、投递ID和绑定代次的处理状态，具体状态由核心校验。", {
    message_id: textField(256),
    delivery_id: textField(256),
    binding_generation: integerField(1),
    processing: { schema: { type: "string", enum: ["processing", "done", "failed"] }, validator: z.enum(["processing", "done", "failed"]) },
  }, false),
  tool("get_status", "getStatus", "只读查询宿主在线、目标对话运行与中途投递能力，返回真实采样时间及来源；未知明确保留。不得根据旧回复或主人休息猜代理休眠。", {
    binding_id: optional(textField(128)), machine_id: optional(textField(128)), host: optional(textField(64)), surface: optional(textField(64)), conversation_id: optional(textField(256)),
  }, true),
  tool("manage_channel_binding", "manageChannelBinding", "当前对话自行登记、查询或移除QQ及已启用微信聊天窗口对应的模型对话。普通发送无需先建立窗口绑定；更新按原代次核对，保留其它对话归属。", {
    action: { schema: { type: "string", enum: ["bind", "get", "list", "remove"] }, validator: z.enum(["bind", "get", "list", "remove"]) },
    channel: optional({ schema: { type: "string", enum: ["qq", "wechat"] }, validator: z.enum(["qq", "wechat"]) }),
    window_type: optional({ schema: { type: "string", enum: ["private", "group"] }, validator: z.enum(["private", "group"]) }),
    window_id: optional(textField(256)),
    expected_generation: optional(integerField(0)),
    limit: optional(integerField(1, 100)), after_key: optional(textField(256)),
  }, false),
];

export { tools as communicationTools };

function toolFailure(error) {
  const code = error instanceof CoreError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "internal_error";
  const message = messages[code] ?? "交流操作未完成，请核对当前消息与绑定状态";
  return { isError: true, structuredContent: { error: { code, message } }, content: [{ type: "text", text: `${message}（${code}）` }] };
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof CoreError ? signal.reason : new CoreError("request_closed", "请求关闭"));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function makeServer(core, principalId, requestSignal) {
  const server = new Server({ name: "communication-core-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(entry => entry.definition) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const entry = tools.find(candidate => candidate.definition.name === request.params.name);
      if (!entry) throw new CoreError("invalid_input", "未知工具");
      const parsed = entry.validator.safeParse(request.params.arguments);
      if (!parsed.success) throw new CoreError("invalid_input", "工具参数无效");
      const signal = AbortSignal.any([requestSignal, extra.signal]);
      const value = await abortable(() => core[entry.method]({ principal_id: principalId, signal }, parsed.data), signal);
      const result = value === null && entry.method === "manageChannelBinding" && parsed.data.action === "get" ? { binding: null } : value;
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid result");
      const serialized = JSON.stringify(result);
      return { structuredContent: result, content: [{ type: "text", text: `交流操作结果：\n${serialized}` }] };
    } catch (error) {
      return toolFailure(error);
    }
  });
  return server;
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function httpFailure(response, status, code, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) return response.destroy();
  response.status(status).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message, data: { code } } });
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function requestKey(principalId, requestId) {
  const valid = typeof requestId === "string" ? Buffer.byteLength(requestId, "utf8") <= 512 : Number.isSafeInteger(requestId);
  return valid ? JSON.stringify([principalId, typeof requestId, requestId]) : null;
}

function credentialsFor(principals) {
  if (!Array.isArray(principals) || principals.length < 1 || principals.length > 256) throw new CoreError("invalid_config", "需要有界的连接授权列表");
  const identities = new Set();
  const tokens = new Set();
  return principals.map(principal => {
    if (!principal || typeof principal.id !== "string" || !principal.id.trim() || Buffer.byteLength(principal.id) > 128) throw new CoreError("invalid_config", "连接授权ID无效");
    normalizeIdentity(principal.identity);
    if (typeof principal.token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(principal.token) || principal.token.length > 4096) throw new CoreError("invalid_config", "连接令牌格式无效");
    const digest = tokenDigest(principal.token);
    const tokenKey = digest.toString("hex");
    if (identities.has(principal.id) || tokens.has(tokenKey)) throw new CoreError("invalid_config", "连接授权ID或令牌重复");
    identities.add(principal.id);
    tokens.add(tokenKey);
    return { principalId: principal.id, digest };
  });
}

export async function createMcpHttpServer({ core, principals, host = "127.0.0.1", port = 0, maxBodyBytes = 1048576 }) {
  if (!["127.0.0.1", "localhost"].includes(host)) throw new CoreError("invalid_config", "服务只能绑定本机回环地址");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new CoreError("invalid_config", "端口或载荷上限无效");
  if (!core || tools.some(entry => typeof core[entry.method] !== "function")) throw new CoreError("invalid_config", "交流核心接口不完整");
  const credentials = credentialsFor(principals);
  const app = express();
  app.disable("x-powered-by");
  const server = createServer({ maxHeaderSize: 16384 }, app);
  server.maxConnections = 32;
  server.maxHeadersCount = 64;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  const requests = new Set();
  const activeRequests = new Set();
  const requestBindings = new Map();
  const sockets = new Set();
  const pruneRequestBindings = () => {
    const now = Date.now();
    for (const [key, binding] of requestBindings) {
      if (binding.entries.size === 0 && binding.expiresAt <= now) requestBindings.delete(key);
    }
  };
  const bindRequest = (entry, principalId, requestId) => {
    const key = requestKey(principalId, requestId);
    if (key === null) return "invalid_request_id";
    pruneRequestBindings();
    let binding = requestBindings.get(key);
    if (binding) binding.ambiguous = true;
    else {
      if (requestBindings.size >= MAX_TRACKED_REQUEST_IDS) return "busy";
      binding = { entries: new Set(), ambiguous: false, expiresAt: 0 };
      requestBindings.set(key, binding);
    }
    binding.entries.add(entry);
    entry.requestKey = key;
    return null;
  };
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closing = false;
  let closePromise;
  let authorities;
  app.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (closing) return httpFailure(response, 503, "server_closed", "服务正在关闭");
    const authority = request.headers.host?.toLowerCase();
    if (headerCount(request, "host") !== 1 || !authorities.has(authority)) return httpFailure(response, 403, "invalid_host", "Host不在本机服务范围内");
    const origin = request.headers.origin;
    if (headerCount(request, "origin") > 1 || (origin !== undefined && ![...authorities].some(allowed => origin === `http://${allowed}`))) return httpFailure(response, 403, "invalid_origin", "Origin不在本机服务范围内");
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
    const supplied = tokenDigest(match ? match[1] : "");
    let principalId;
    for (const credential of credentials) {
      if (timingSafeEqual(supplied, credential.digest)) principalId = credential.principalId;
    }
    if (!match || headerCount(request, "authorization") !== 1 || !principalId) {
      response.set("WWW-Authenticate", "Bearer");
      return httpFailure(response, 401, "unauthorized", "需要当前连接的有效Bearer令牌");
    }
    if (requests.size >= MAX_ACTIVE_REQUESTS + MAX_CONTROL_REQUESTS) return httpFailure(response, 503, "busy", "服务请求已满，请稍后重试");
    const controller = new AbortController();
    let finished;
    const entry = { controller, response, done: new Promise(resolve => { finished = resolve; }) };
    let cleaned = false;
    const timer = setTimeout(() => {
      controller.abort(new CoreError("request_timeout", "请求超时"));
      httpFailure(response, 504, "request_timeout", "请求超出等待期限");
      void entry.cleanup();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    entry.cleanup = async () => {
      if (cleaned) return entry.done;
      cleaned = true;
      clearTimeout(timer);
      controller.abort(new CoreError("request_closed", "请求已关闭"));
      try {
        if (entry.mcp) await entry.mcp.close();
        else if (entry.transport) await entry.transport.close();
      } catch {} finally {
        activeRequests.delete(entry);
        if (entry.requestKey) {
          const binding = requestBindings.get(entry.requestKey);
          binding?.entries.delete(entry);
          if (binding) binding.expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
        }
        requests.delete(entry);
        finished();
      }
    };
    requests.add(entry);
    response.once("finish", () => { void entry.cleanup(); });
    response.once("close", () => { void entry.cleanup(); });
    response.locals.entry = entry;
    response.locals.principalId = principalId;
    next();
  });
  app.post("/mcp", (request, response, next) => {
    if (!request.is("application/json")) return httpFailure(response, 415, "invalid_content_type", "请求需要application/json格式");
    next();
  }, express.json({ limit: maxBodyBytes, strict: true, inflate: false }), async (request, response) => {
    const entry = response.locals.entry;
    if (entry.controller.signal.aborted) return;
    try {
      const body = request.body;
      const cancellation = body?.jsonrpc === "2.0" && body.method === "notifications/cancelled" && !Object.hasOwn(body, "id") ? CancelledNotificationSchema.safeParse(body) : null;
      if (cancellation?.success) {
        pruneRequestBindings();
        const key = requestKey(response.locals.principalId, cancellation.data.params.requestId);
        const binding = requestBindings.get(key);
        if (binding && !binding.ambiguous && binding.entries.size === 1) {
          const [original] = binding.entries;
          original.controller.abort(new CoreError("request_cancelled", "请求已取消"));
        }
      } else {
        if (activeRequests.size >= MAX_ACTIVE_REQUESTS) return httpFailure(response, 503, "busy", "服务请求已满，请稍后重试");
        activeRequests.add(entry);
        if (body?.jsonrpc === "2.0" && body.method === "tools/call" && Object.hasOwn(body, "id")) {
          const failure = bindRequest(entry, response.locals.principalId, body.id);
          if (failure) return httpFailure(response, failure === "busy" ? 503 : 400, failure, "请求ID无效或取消关联容量已满");
        }
      }
      entry.mcp = makeServer(core, response.locals.principalId, entry.controller.signal);
      entry.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await entry.mcp.connect(entry.transport);
      if (entry.controller.signal.aborted) return await entry.cleanup();
      await entry.transport.handleRequest(request, response, request.body);
    } catch {
      httpFailure(response, 500, "internal_error", "服务暂时无法完成请求");
      await entry.cleanup();
    }
  });
  app.all("/mcp", (request, response) => {
    response.set("Allow", "POST");
    httpFailure(response, 405, "method_not_allowed", "独立服务只接收MCP POST请求");
  });
  app.use((request, response) => httpFailure(response, 404, "not_found", "没有对应的服务入口"));
  app.use((error, request, response, next) => {
    const oversized = error?.type === "entity.too.large";
    httpFailure(response, oversized ? 413 : 400, oversized ? "payload_too_large" : "invalid_json", oversized ? "请求载荷超出大小限制" : "请求JSON或编码无效");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const bound = server.address();
      authorities = new Set([`127.0.0.1:${bound.port}`, `localhost:${bound.port}`]);
      if (bound.port === 80) { authorities.add("127.0.0.1"); authorities.add("localhost"); }
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${host}:${server.address().port}/mcp`,
    address: server.address(),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const stopped = new Promise(resolve => server.close(resolve));
        const pending = [...requests];
        for (const entry of pending) entry.controller.abort(new CoreError("server_closed", "服务关闭"));
        let graceTimer;
        await Promise.race([Promise.all(pending.map(entry => entry.done)), new Promise(resolve => { graceTimer = setTimeout(resolve, 100); })]);
        clearTimeout(graceTimer);
        for (const entry of pending) {
          httpFailure(entry.response, 503, "server_closed", "服务正在关闭");
          await entry.cleanup();
        }
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await stopped;
        requestBindings.clear();
      })();
      return closePromise;
    },
  };
}
