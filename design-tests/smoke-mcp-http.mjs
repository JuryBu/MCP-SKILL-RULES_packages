const endpoints = ["memory-store", "web-fetcher", "sandbox"];
if (process.env.CODEX_TOOLKIT_SMOKE_OPTIONAL === "1" && (process.env.EXA_MCP_REMOTE_URL || process.env.CODEX_TOOLKIT_EXA_MCP_REMOTE_URL)) {
  endpoints.push("exa");
}
const base = process.env.CODEX_TOOLKIT_MCP_BASE_URL || "http://127.0.0.1:14588";

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"));
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
  }
  return trimmed ? JSON.parse(trimmed) : null;
}

async function post(endpoint, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${base}/${endpoint}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return {
    sessionId: response.headers.get("mcp-session-id"),
    body: parseMcpResponse(text),
  };
}

for (const endpoint of endpoints) {
  const init = await post(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "portable-codex-toolkit-smoke", version: "0.1.0" },
    },
  });
  const sessionId = init.sessionId;
  await post(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const tools = await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
  const count = tools.body?.result?.tools?.length ?? 0;
  console.log(`${endpoint}: initialized, tools=${count}`);
}




