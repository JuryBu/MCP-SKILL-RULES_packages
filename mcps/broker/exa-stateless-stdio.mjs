import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ExaKeyPool,
  buildExaEndpointConfig,
  classifyExaFailure,
  classifyExaToolResult,
} from "./exa-key-pool.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolkitMcpRoot = process.env.CODEX_TOOLKIT_MCP_ROOT || path.resolve(__dirname, "..");
const memoryStoreRoot = process.env.MEMORY_STORE_MCP_ROOT || path.join(toolkitMcpRoot, "memory-store");

function resolveSdkRoot() {
  const candidates = [
    process.env.CODEX_MCP_BROKER_SDK_ROOT,
    path.join(__dirname, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
    path.join(memoryStoreRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "server", "index.js")) &&
      fs.existsSync(path.join(candidate, "server", "stdio.js")) &&
      fs.existsSync(path.join(candidate, "client", "index.js")) &&
      fs.existsSync(path.join(candidate, "types.js"))
    ) {
      return candidate;
    }
  }
  throw new Error(`MCP SDK not found. Checked: ${candidates.join(", ")}`);
}

const sdkRoot = resolveSdkRoot();

const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "types.js")).href),
]);

const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} = types;

const fallbackTools = [
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

function loadPrivateEnv() {
  const privateEnvPath = path.join(__dirname, "broker-private.env.json");
  if (!fs.existsSync(privateEnvPath)) {
    return;
  }
  try {
    const privateEnv = JSON.parse(
      fs.readFileSync(privateEnvPath, "utf8").replace(/^\uFEFF/, ""),
    );
    for (const [key, value] of Object.entries(privateEnv)) {
      if (key && value !== undefined && value !== null && String(value) !== "" && !process.env[key]) {
        process.env[key] = String(value);
      }
    }
  } catch (error) {
    console.error(`[exa-stateless] private env load failed: ${error.message}`);
  }
}

function parseMcpResponse(text) {
  const dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.length > 0 ? dataLines.join("\n") : text;
  return JSON.parse(data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSecrets(value) {
  return String(value ?? "")
    .replace(/(exaApiKey=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(EXA_API_KEY["':=\s]+)[A-Za-z0-9_-]{16,}/gi, "$1<redacted>");
}

function flattenErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function describeError(error) {
  return flattenErrorChain(error)
    .map((item) => {
      const name = item.name || item.constructor?.name || "Error";
      const message = item.message || String(item);
      const code = item.code ? ` code=${item.code}` : "";
      return `${name}: ${message}${code}`;
    })
    .map(redactSecrets)
    .join(" <- ");
}

function isRetryableTransportError(error) {
  const retryableCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  return flattenErrorChain(error).some((item) => {
    const message = String(item.message || "");
    return retryableCodes.has(item.code) || message === "fetch failed";
  });
}

async function postRemoteMcpOnce(endpoint, method, params, timeoutMs) {
  if (!endpoint?.url) {
    throw new Error("Exa remote endpoint is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Exa ${method} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (endpoint.apiKey) {
      headers["x-api-key"] = endpoint.apiKey;
    }
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: params ?? {},
      }),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const error = new Error(redactSecrets(`Exa HTTP ${response.status}: ${text.slice(0, 500)}`));
      error.exaStatus = response.status;
      error.exaBody = text;
      throw error;
    }
    const message = parseMcpResponse(text);
    if (message.error) {
      const detail = message.error.message || JSON.stringify(message.error);
      throw new Error(redactSecrets(`Exa MCP ${message.error.code ?? "error"}: ${detail}`));
    }
    return message.result;
  } finally {
    clearTimeout(timer);
  }
}

async function postRemoteMcp(endpoint, method, params, timeoutMs, options = {}) {
  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts ?? process.env.EXA_STATELESS_MAX_ATTEMPTS ?? 3),
  );
  const retryDelayMs = Math.max(
    0,
    Number(options.retryDelayMs ?? process.env.EXA_STATELESS_RETRY_DELAY_MS ?? 500),
  );
  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, timeoutMs - elapsedMs);
    try {
      return await postRemoteMcpOnce(endpoint, method, params, remainingMs);
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < maxAttempts &&
        isRetryableTransportError(error) &&
        Date.now() - startedAt + retryDelayMs < timeoutMs;
      if (!canRetry) {
        break;
      }
      console.error(
        `[exa-stateless] ${endpoint.name} ${method} retry ${attempt + 1}/${maxAttempts} after ${describeError(error)}`,
      );
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(
    `Exa ${method} failed after ${attemptsMade}/${maxAttempts} attempt(s): ${describeError(lastError)}`,
  );
}

loadPrivateEnv();

const endpointConfig = buildExaEndpointConfig(process.env);
const keyPool = new ExaKeyPool({
  endpoints: endpointConfig.endpoints,
  statePath: endpointConfig.statePath,
  cooldownMs: endpointConfig.cooldownMs,
  cooldownJitterMs: endpointConfig.cooldownJitterMs,
  rateLimitCooldownMs: endpointConfig.rateLimitCooldownMs,
});
const listTimeoutMs = Number(process.env.EXA_STATELESS_LIST_TIMEOUT_MS || 5000);
const callTimeoutMs = Number(process.env.EXA_STATELESS_CALL_TIMEOUT_MS || 70000);
const listMaxAttempts = Math.max(1, Number(process.env.EXA_STATELESS_LIST_MAX_ATTEMPTS || 1));
const callMaxAttempts = Math.max(
  1,
  Number(process.env.EXA_STATELESS_CALL_MAX_ATTEMPTS || process.env.EXA_STATELESS_MAX_ATTEMPTS || 5),
);
const remoteToolsListEnabled = process.env.EXA_STATELESS_REMOTE_TOOLS_LIST === "1";

console.error(
  `[exa-stateless] endpoint pool ready: credentials=${endpointConfig.endpoints.length} publicFallback=${Boolean(endpointConfig.publicEndpoint)} state=${endpointConfig.statePath}`,
);

async function postRemoteMcpWithPool(method, params, timeoutMs, options = {}) {
  const attemptedIds = new Set();
  const startedAt = Date.now();
  let lastResult;
  let lastError;

  while (true) {
    const selection = keyPool.select(attemptedIds);
    if (!selection) {
      break;
    }
    attemptedIds.add(selection.endpoint.id);
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    try {
      const result = await postRemoteMcp(selection.endpoint, method, params, remainingMs, options);
      const failure = classifyExaToolResult(result);
      if (!failure) {
        keyPool.reportSuccess(selection);
        return result;
      }
      if (failure.kind === "quota" || failure.kind === "rate_limit" || failure.kind === "auth") {
        keyPool.reportFailure(selection, failure);
        console.error(
          `[exa-stateless] ${selection.endpoint.name} ${failure.kind} -> ${failure.reason}`,
        );
        lastResult = result;
        continue;
      }
      keyPool.reportSuccess(selection);
      return result;
    } catch (error) {
      const failure = classifyExaFailure(error.exaBody || error.message, error.exaStatus);
      if (failure) {
        keyPool.reportFailure(selection, failure);
        console.error(
          `[exa-stateless] ${selection.endpoint.name} ${failure.kind} -> ${failure.reason}`,
        );
        lastError = error;
        continue;
      }
      keyPool.release(selection);
      throw error;
    }
  }

  if (endpointConfig.publicEndpoint) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    console.error(`[exa-stateless] ${method} using public fallback`);
    return postRemoteMcp(
      endpointConfig.publicEndpoint,
      method,
      params,
      remainingMs,
      options,
    );
  }
  if (lastResult) {
    return lastResult;
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("No Exa endpoint is currently available");
}

const server = new Server(
  { name: "codex-exa-stateless-bridge", version: "0.2.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!remoteToolsListEnabled) {
    return { tools: fallbackTools };
  }
  try {
    const result = await postRemoteMcpWithPool("tools/list", {}, listTimeoutMs, {
      maxAttempts: listMaxAttempts,
    });
    if (Array.isArray(result?.tools) && result.tools.length > 0) {
      return result;
    }
  } catch (error) {
    console.error(`[exa-stateless] tools/list fallback: ${error.message}`);
  }
  return { tools: fallbackTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return postRemoteMcpWithPool("tools/call", request.params, callTimeoutMs, {
    maxAttempts: callMaxAttempts,
  });
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => {
  throw new Error("Exa stateless bridge does not expose resources");
});

const transport = new StdioServerTransport();
await server.connect(transport);
