import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function bootstrapPrivateEnv() {
  const privateEnvPath = path.join(__dirname, "broker-private.env.json");
  if (!fs.existsSync(privateEnvPath)) return;
  try {
    const privateEnv = JSON.parse(fs.readFileSync(privateEnvPath, "utf8").replace(/^\uFEFF/, ""));
    for (const [key, value] of Object.entries(privateEnv)) {
      if (key && value !== undefined && value !== null && String(value) !== "" && !process.env[key]) {
        process.env[key] = String(value);
      }
    }
  } catch (error) {
    console.error(`[codex-mcp-broker] private env load failed: ${error.message}`);
  }
}

bootstrapPrivateEnv();

const toolkitMcpRoot = process.env.CODEX_TOOLKIT_MCP_ROOT || path.resolve(__dirname, "..");
const toolkitDataRoot = process.env.CODEX_TOOLKIT_DATA_ROOT || path.join(os.homedir(), ".codex-toolkit");
const memoryStoreRoot = process.env.MEMORY_STORE_MCP_ROOT || path.join(toolkitMcpRoot, "memory-store");
const webFetcherRoot = process.env.WEB_FETCHER_MCP_ROOT || path.join(toolkitMcpRoot, "web-fetcher");
const sandboxRoot = process.env.SANDBOX_MCP_ROOT || path.join(toolkitMcpRoot, "sandbox");
const subagentRoot = process.env.SUBAGENT_MCP_ROOT || path.join(toolkitMcpRoot, "mcp-subagent");
const sdkRoot = path.join(
  memoryStoreRoot,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);

const [
  { Server },
  { StreamableHTTPServerTransport },
  { Client },
  { StdioClientTransport },
  types,
] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "server", "streamableHttp.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "types.js")).href),
]);

const {
  ListToolsRequestSchema,
  ListToolsResultSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  isInitializeRequest,
} = types;

const port = Number(process.env.CODEX_MCP_BROKER_PORT || 14588);
const host = process.env.CODEX_MCP_BROKER_HOST || "127.0.0.1";
const brokerDataRoot = path.join(toolkitDataRoot, "broker");
const logPath = process.env.CODEX_MCP_BROKER_LOG || path.join(brokerDataRoot, "broker.log");
const statePath = process.env.CODEX_MCP_BROKER_STATE || path.join(brokerDataRoot, "broker-state.json");
const configuredRequestTimeoutMs = Number(process.env.CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS || 120000);
const requestTimeoutMs = Number.isFinite(configuredRequestTimeoutMs) && configuredRequestTimeoutMs > 0
  ? Math.floor(configuredRequestTimeoutMs)
  : 120000;
const configuredWaitTimeoutCapMs = Number(process.env.CODEX_MCP_BROKER_WAIT_TIMEOUT_MS || 1800000);
const waitTimeoutCapMs = Number.isFinite(configuredWaitTimeoutCapMs) && configuredWaitTimeoutCapMs > 0
  ? Math.max(requestTimeoutMs, Math.floor(configuredWaitTimeoutCapMs))
  : Math.max(requestTimeoutMs, 1800000);
const sessionIdleMs = Number(process.env.CODEX_MCP_BROKER_SESSION_IDLE_MS || 6 * 60 * 60 * 1000);

const exaMcpRemoteUrl = process.env.EXA_MCP_REMOTE_URL || process.env.CODEX_TOOLKIT_EXA_MCP_REMOTE_URL || "";

const exaToolsListFallback = [
  {
    name: "web_search_exa",
    description:
      "Search the web for current information and return clean text content from top results.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query. Describe the ideal page rather than only keywords.",
        },
        numResults: {
          type: "number",
          description: "Number of search results to return.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch_exa",
    description:
      "Read one or more webpages as clean markdown after search results are insufficient or a URL is known.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "URLs to read. Batch multiple URLs in one call.",
          items: { type: "string" },
        },
        maxCharacters: {
          type: "number",
          description: "Maximum characters to extract per page.",
        },
      },
      required: ["urls"],
      additionalProperties: false,
    },
  },
];

const endpoints = {
  playwright: {
    path: "/playwright/mcp",
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npx.cmd @playwright/mcp@latest"],
    cwd: __dirname,
    resources: false,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "playwright",
    },
  },
  "sequential-thinking": {
    path: "/sequential-thinking/mcp",
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npx.cmd -y @modelcontextprotocol/server-sequential-thinking"],
    cwd: __dirname,
    resources: false,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "sequential-thinking",
    },
  },
  exa: {
    path: "/exa/mcp",
    command: "node",
    args: [path.join(__dirname, "exa-stateless-stdio.mjs")],
    cwd: __dirname,
    resources: false,
    cacheToolsList: true,
    resetBackendOnToolsListError: true,
    toolsListConnectTimeoutMs: Number(process.env.CODEX_MCP_BROKER_EXA_TOOLS_LIST_CONNECT_TIMEOUT_MS || 8000),
    toolsListTimeoutMs: Number(process.env.CODEX_MCP_BROKER_EXA_TOOLS_LIST_TIMEOUT_MS || 8000),
    toolsListFallback: exaMcpRemoteUrl ? exaToolsListFallback : null,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "exa",
      EXA_MCP_REMOTE_URL: exaMcpRemoteUrl,
    },
  },
  "memory-store": {
    path: "/memory-store/mcp",
    command: "node",
    args: [path.join(memoryStoreRoot, "dist", "index.js")],
    cwd: memoryStoreRoot,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "memory-store",
      MEMORY_STORE_ENABLE_DUPLICATE_RETIREMENT: "0",
    },
  },
  "web-fetcher": {
    path: "/web-fetcher/mcp",
    command: "node",
    args: [path.join(webFetcherRoot, "dist", "index.js")],
    cwd: webFetcherRoot,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "web-fetcher",
      WEB_FETCHER_ENABLE_DUPLICATE_RETIREMENT: "0",
    },
  },
  sandbox: {
    path: "/sandbox/mcp",
    command: "node",
    args: [path.join(sandboxRoot, "dist", "index.js")],
    cwd: sandboxRoot,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "sandbox",
      SANDBOX_ENABLE_DUPLICATE_RETIREMENT: "0",
    },
  },
  subagent: {
    path: "/subagent/mcp",
    command: "node",
    args: [path.join(subagentRoot, "src", "index.js")],
    cwd: subagentRoot,
    env: {
      CODEX_MCP_WRAPPER: "1",
      CODEX_MCP_TOOL_NAME: "subagent",
      SUBAGENT_DATA_DIR: process.env.SUBAGENT_DATA_DIR || path.join(toolkitDataRoot, "mcp-subagent"),
      SUBAGENT_CLEANUP_INTERVAL_SEC: "3600",
      SUBAGENT_IDLE_TTL_SEC: "86400",
    },
  },
};

function log(message, details = undefined) {
  const entry = {
    ts: new Date().toISOString(),
    message,
    ...(details === undefined ? {} : { details }),
  };
  const line = `${JSON.stringify(entry)}\n`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, "utf8");
  console.error(`[codex-mcp-broker] ${message}`);
}

function writeState(brokers) {
  const state = {
    pid: process.pid,
    host,
    port,
    updatedAt: new Date().toISOString(),
    endpoints: Object.fromEntries(
      Object.entries(brokers).map(([name, broker]) => [name, broker.status()]),
    ),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeMcpAcceptHeader(req) {
  const current = String(req.headers.accept || "");
  const required = ["application/json", "text/event-stream"];
  const merged = current
    ? [...new Set([...current.split(",").map((item) => item.trim()).filter(Boolean), ...required])].join(", ")
    : required.join(", ");
  req.headers.accept = merged;
  const raw = Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [];
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === "accept") {
      raw[i + 1] = merged;
      found = true;
    }
  }
  if (!found) {
    raw.push("accept", merged);
  }
  req.rawHeaders = raw;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function ensureDefaultContentType(res) {
  if (res.__codexMcpContentTypePatched) return;
  res.__codexMcpContentTypePatched = true;

  const setDefaultContentType = (chunk = undefined) => {
    if (!res.headersSent && !res.hasHeader("content-type")) {
      const hasBody = chunk !== undefined && chunk !== null && Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk)) > 0;
      res.setHeader("content-type", hasBody ? "application/json" : "text/plain; charset=utf-8");
    }
    if (!res.headersSent && !res.hasHeader("content-length")) {
      const hasBody = chunk !== undefined && chunk !== null && Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk)) > 0;
      if (!hasBody) {
        res.setHeader("content-length", "0");
      }
    }
  };

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalFlushHeaders = typeof res.flushHeaders === "function" ? res.flushHeaders.bind(res) : undefined;

  res.writeHead = (statusCode, statusMessageOrHeaders, headersMaybe) => {
    let statusMessage = statusMessageOrHeaders;
    let headers = headersMaybe;
    if (typeof statusMessageOrHeaders === "object" && statusMessageOrHeaders !== null) {
      statusMessage = undefined;
      headers = statusMessageOrHeaders;
    }
    const nextHeaders = { ...(headers || {}) };
    for (const key of Object.keys(nextHeaders)) {
      if (
        key.toLowerCase() === "content-type"
        && (statusCode === 200 || statusCode === 202)
        && String(nextHeaders[key]).toLowerCase().startsWith("text/plain")
      ) {
        nextHeaders[key] = "application/json";
      }
    }
    const hasContentType = Object.keys(nextHeaders).some((key) => key.toLowerCase() === "content-type")
      || res.hasHeader("content-type");
    if (!hasContentType) {
      nextHeaders["content-type"] = "application/json";
    }
    return statusMessage === undefined
      ? originalWriteHead(statusCode, nextHeaders)
      : originalWriteHead(statusCode, statusMessage, nextHeaders);
  };

  res.write = (...args) => {
    setDefaultContentType(args[0]);
    return originalWrite(...args);
  };

  res.end = (...args) => {
    const hasBody = args[0] !== undefined && args[0] !== null && Buffer.byteLength(Buffer.isBuffer(args[0]) ? args[0] : String(args[0])) > 0;
    if (!hasBody && (res.statusCode === 200 || res.statusCode === 202)) {
      const body = JSON.stringify({ ok: true });
      if (!res.headersSent) {
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", Buffer.byteLength(body));
      }
      return originalEnd(body);
    }
    setDefaultContentType(args[0]);
    return originalEnd(...args);
  };

  if (originalFlushHeaders) {
    res.flushHeaders = (...args) => {
      setDefaultContentType();
      return originalFlushHeaders(...args);
    };
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function killProcessTree(pid, reason) {
  if (!pid || process.platform !== "win32") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, stdout, stderr) => {
      log("kill process tree", {
        pid,
        reason,
        ok: !error,
        exitCode: error?.code ?? 0,
        stdout: stdout?.trim(),
        stderr: stderr?.trim(),
      });
      resolve();
    });
  });
}

function isMethodNotFound(error) {
  return error?.message?.includes("MCP error -32601") || error?.code === -32601;
}

function getToolArguments(params) {
  return params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
}

function hasConversationId(args) {
  return typeof args.conversationId === "string" && args.conversationId.trim().length > 0;
}

function hasTaskId(args) {
  return typeof args.taskId === "string" && args.taskId.trim().length > 0;
}

function isConversationBatchExport(args, action) {
  if (action !== "export") return false;
  if (args.exportBatch === true) return true;
  return Array.isArray(args.dataChains) || Array.isArray(args.workspaces);
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

function validateMemoryStoreToolCall(params) {
  const toolName = params?.name;
  const args = getToolArguments(params);

  const action = typeof args.action === "string" ? args.action : undefined;
  const isBackgroundStatusRead =
    hasTaskId(args) && (
      toolName === "conversation_golden_extract" ||
      toolName === "stage_guard" ||
      (toolName === "record_manage" && action === "task_status")
    );

  if (isBackgroundStatusRead) {
    return null;
  }

  const requiresConversationId =
    (toolName === "conversation_read_original" && action !== "list" && !isConversationBatchExport(args, action)) ||
    toolName === "conversation_golden_extract" ||
    (toolName === "record_manage" && action === "update") ||
    toolName === "stage_guard";

  if (requiresConversationId && !hasConversationId(args)) {
    return [
      "Codex MCP broker blocked this memory-store call.",
      "The Codex HTTP backend is shared across sessions, so current-conversation inference is unsafe here.",
      `Tool ${toolName} requires an explicit conversationId. chain/dataChain/modelChain cannot safely infer the current conversation.`,
      'Use conversation_read_original(action="list", dataChain="codex", query="...") to locate the id first.',
    ].join(" ");
  }

  if (toolName === "record_manage" && (action === "batch_update" || action === "batch_delete")) {
    return [
      "Codex MCP broker blocked record_manage batch operation.",
      "Batch record operations are global in the shared backend and can cross conversation boundaries.",
      "Use record_manage(action=\"update\", dataChain=\"codex\", modelChain=\"codex\", conversationId=\"...\") for one conversation.",
    ].join(" ");
  }

  if (toolName === "record_manage" && action === "delete" && !hasConversationId(args)) {
    return [
      "Codex MCP broker blocked record_manage delete without conversationId.",
      "Deleting without a conversationId is global in the shared backend.",
    ].join(" ");
  }

  return null;
}

function validateToolCall(endpoint, params) {
  if (endpoint !== "memory-store") {
    return null;
  }
  return validateMemoryStoreToolCall(params);
}

class BackendManager {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.client = null;
    this.transport = null;
    this.connecting = null;
    this.generation = 0;
    this.lastError = null;
    this.lastStartedAt = null;
    this.lastActivityAt = null;
    this.lastPid = null;
  }

  status() {
    const connected = Boolean(this.client);
    return {
      generation: this.generation,
      connected,
      pid: connected ? this.lastPid : null,
      lastPid: this.lastPid,
      lastStartedAt: this.lastStartedAt,
      lastActivityAt: this.lastActivityAt,
      lastError: this.lastError,
    };
  }

  async ensureConnected(options = {}) {
    if (this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connect(options.connectTimeoutMs).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async connect(connectTimeoutMs) {
    const env = {
      ...process.env,
      ...this.config.env,
      CODEX_MCP_BROKER: "1",
      CODEX_MCP_BROKER_PID: String(process.pid),
    };
    const client = new Client({ name: `codex-http-broker-${this.name}`, version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd,
      env,
      stderr: "pipe",
    });

    const stderrChunks = [];
    transport.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      while (stderrChunks.join("").length > 8000) {
        stderrChunks.shift();
      }
    });

    transport.onclose = () => {
      const closedPid = this.lastPid;
      this.lastError = null;
      this.client = null;
      this.transport = null;
      log("backend closed", { endpoint: this.name, generation: this.generation, pid: closedPid });
    };
    transport.onerror = (error) => {
      this.lastError = error.message;
      log("backend transport error", { endpoint: this.name, error: error.message });
    };

    try {
      await withTimeout(
        client.connect(transport),
        Number(connectTimeoutMs || requestTimeoutMs),
        `${this.name} connect`,
      );
    } catch (error) {
      this.lastError = error.message;
      const failedPid = transport.pid ?? null;
      log("backend connect failed", { endpoint: this.name, error: error.message, pid: failedPid });
      void (async () => {
        await client.close().catch((closeError) => {
          log("backend close after connect failure failed", {
            endpoint: this.name,
            error: closeError.message,
          });
        });
        if (failedPid) {
          await killProcessTree(failedPid, `${this.name} backend connect failure`);
        }
      })();
      throw error;
    }
    this.client = client;
    this.transport = transport;
    this.generation += 1;
    this.lastStartedAt = new Date().toISOString();
    this.lastActivityAt = this.lastStartedAt;
    this.lastPid = transport.pid;
    this.lastError = null;
    log("backend connected", {
      endpoint: this.name,
      generation: this.generation,
      pid: this.lastPid,
      command: this.config.command,
      args: this.config.args,
    });
    return client;
  }

  async request(request, resultSchema, options = {}) {
    const client = await this.ensureConnected(options);
    this.lastActivityAt = new Date().toISOString();
    const timeoutMs = Number(options.timeoutMs || requestTimeoutMs);
    try {
      return await withTimeout(
        client.request(request, resultSchema, { timeout: timeoutMs }),
        timeoutMs,
        `${this.name} ${request.method}`,
      );
    } catch (error) {
      this.lastError = error.message;
      log("backend request failed", { endpoint: this.name, method: request.method, error: error.message });
      if (options.closeOnError !== false) {
        await this.close();
      }
      throw error;
    }
  }

  async close() {
    const client = this.client;
    const pid = this.lastPid;
    this.client = null;
    this.transport = null;
    if (client) {
      await client.close().catch((error) => {
        log("backend close failed", { endpoint: this.name, error: error.message });
      });
    }
    await killProcessTree(pid, `${this.name} backend close`);
  }
}

class EndpointBroker {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.backend = new BackendManager(name, config);
    this.sessions = new Map();
    this.cachedToolsList = Array.isArray(config.toolsListFallback)
      ? { tools: config.toolsListFallback }
      : null;
    this.cachedToolsListAt = this.cachedToolsList ? "static-fallback" : null;
  }

  status() {
    const sessions = Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    }));
    return {
      path: this.config.path,
      sessions: this.sessions.size,
      sessionIdleMs,
      oldestSessionAt: sessions.map((session) => session.createdAt).sort()[0] ?? null,
      newestSessionSeenAt: sessions.map((session) => session.lastSeenAt).sort().at(-1) ?? null,
      toolsListCacheAt: this.cachedToolsListAt,
      backend: this.backend.status(),
    };
  }

  createServer() {
    const server = new Server(
      { name: `codex-http-broker-${this.name}`, version: "0.1.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: false },
        },
      },
    );

    const forward = (schema, resultSchema) => {
      server.setRequestHandler(schema, async (request) => {
        return this.backend.request(
          {
            method: request.method,
            params: request.params,
          },
          resultSchema,
          { closeOnError: false },
        );
      });
    };

    const forwardOptionalList = (schema, resultSchema, emptyResult) => {
      server.setRequestHandler(schema, async (request) => {
        if (this.config.resources === false) {
          log("optional method skipped", {
            endpoint: this.name,
            method: request.method,
          });
          return emptyResult;
        }
        try {
          return await this.backend.request(
            {
              method: request.method,
              params: request.params,
            },
            resultSchema,
          );
        } catch (error) {
          if (isMethodNotFound(error)) {
            log("optional method unsupported", {
              endpoint: this.name,
              method: request.method,
            });
            return emptyResult;
          }
          throw error;
        }
      });
    };

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      try {
        const result = await this.backend.request(
          {
            method: request.method,
            params: request.params,
          },
          ListToolsResultSchema,
          {
            closeOnError: this.config.resetBackendOnToolsListError === true,
            connectTimeoutMs: this.config.toolsListConnectTimeoutMs,
            timeoutMs: this.config.toolsListTimeoutMs,
          },
        );
        if (this.config.cacheToolsList === true) {
          this.cachedToolsList = result;
          this.cachedToolsListAt = new Date().toISOString();
        }
        return result;
      } catch (error) {
        if (this.cachedToolsList) {
          log("tools/list fallback used", {
            endpoint: this.name,
            error: error.message,
            cachedAt: this.cachedToolsListAt,
          });
          return this.cachedToolsList;
        }
        throw error;
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const validationError = validateToolCall(this.name, request.params);
      if (validationError) {
        log("tool call blocked", {
          endpoint: this.name,
          tool: request.params?.name,
          error: validationError,
        });
        return toolError(validationError);
      }
      const args = request.params?.arguments || {};
      let callTimeoutMs = requestTimeoutMs;
      if (typeof args.waitSeconds === "number" && args.waitSeconds > 0) {
        callTimeoutMs = Math.min(
          Math.max(args.waitSeconds * 1000 + 15000, requestTimeoutMs),
          waitTimeoutCapMs,
        );
      } else if (typeof args.timeout === "number" && args.timeout > requestTimeoutMs) {
        callTimeoutMs = Math.min(args.timeout + 15000, waitTimeoutCapMs);
      }
      return this.backend.request(
        {
          method: request.method,
          params: request.params,
        },
        CallToolResultSchema,
        { closeOnError: false, timeoutMs: callTimeoutMs },
      );
    });
    forwardOptionalList(ListResourcesRequestSchema, ListResourcesResultSchema, { resources: [] });
    forward(ReadResourceRequestSchema, ReadResourceResultSchema);
    forwardOptionalList(ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema, { resourceTemplates: [] });
    return server;
  }

  async createSession() {
    let sessionEntry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (sessionEntry) {
          this.sessions.set(sessionId, sessionEntry);
          log("frontend session created", { endpoint: this.name, sessionId });
        }
      },
    });
    const server = this.createServer();
    await server.connect(transport);
    const now = new Date().toISOString();
    sessionEntry = { server, transport, createdAt: now, lastSeenAt: now };
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };
    return sessionEntry;
  }

  async handle(req, res, parsedBody) {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      session.lastSeenAt = new Date().toISOString();
      await session.transport.handleRequest(req, res, parsedBody);
      if (req.method === "DELETE") {
        this.sessions.delete(sessionId);
        log("frontend session deleted", { endpoint: this.name, sessionId });
      }
      return;
    }

    const isInitialize = isInitializeRequest(parsedBody);
    if (req.method === "POST" && isInitialize) {
      const session = await this.createSession();
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    sendJson(res, sessionId ? 404 : 400, { error: "Missing or invalid MCP session. Send initialize first." });
  }

  async cleanupIdleSessions(nowMs = Date.now()) {
    const stale = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      const lastSeenMs = Date.parse(session.lastSeenAt);
      if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > sessionIdleMs) {
        stale.push([sessionId, session]);
      }
    }
    for (const [sessionId, session] of stale) {
      this.sessions.delete(sessionId);
      await session.transport.close().catch((error) => {
        log("frontend session close failed", { endpoint: this.name, sessionId, error: error.message });
      });
      log("frontend idle session removed", { endpoint: this.name, sessionId });
    }
  }

  async close() {
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();
    await Promise.all(
      sessions.map(([sessionId, session]) =>
        session.transport.close().catch((error) => {
          log("frontend session close failed", { endpoint: this.name, sessionId, error: error.message });
        }),
      ),
    );
    await this.backend.close();
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const brokers = Object.fromEntries(
  Object.entries(endpoints).map(([name, config]) => [name, new EndpointBroker(name, config)]),
);

function writeStateBestEffort(reason) {
  try {
    writeState(brokers);
  } catch (error) {
    log("broker state write failed", { reason, error: error.message });
  }
}

setInterval(() => {
  Promise.all(Object.values(brokers).map((broker) => broker.cleanupIdleSessions()))
    .then(() => writeState(brokers))
    .catch((error) => log("idle session cleanup failed", { error: error.message }));
}, Math.min(sessionIdleMs, 10 * 60 * 1000)).unref();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      writeState(brokers);
      sendJson(res, 200, { ok: true, pid: process.pid, endpoints: Object.keys(endpoints) });
      return;
    }

    const broker = Object.values(brokers).find((candidate) => req.url?.startsWith(candidate.config.path));
    if (!broker) {
      sendJson(res, 404, { error: "Unknown MCP endpoint" });
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    normalizeMcpAcceptHeader(req);
    ensureDefaultContentType(res);
    let parsedBody;
    try {
      parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch (error) {
      log("request json parse failed", { url: req.url, method: req.method, error: error.message });
      sendJson(res, 400, { error: "Invalid JSON request body" });
      return;
    }
    await broker.handle(req, res, parsedBody);
    writeState(brokers);
  } catch (error) {
    log("request failed", { url: req.url, method: req.method, error: error.message });
    if (res.writableEnded || res.destroyed) {
      return;
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, 500, { error: error.message });
  }
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  log("shutting down", { signal });
  try {
    await Promise.all(Object.values(brokers).map((broker) => broker.close()));
  } finally {
    writeStateBestEffort(`shutdown:${signal}`);
  }
  server.close(() => {
    writeStateBestEffort(`server-close:${signal}`);
    process.exit(0);
  });
  setTimeout(() => {
    writeStateBestEffort(`shutdown-timeout:${signal}`);
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));
process.on("beforeExit", () => writeStateBestEffort("beforeExit"));

server.listen(port, host, () => {
  log("broker listening", { host, port, pid: process.pid });
  writeState(brokers);
});
