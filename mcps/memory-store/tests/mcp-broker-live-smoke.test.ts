import assert from "node:assert/strict";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MEMORY_STORE_LIVE_MCP_URL || "http://127.0.0.1:14588/memory-store/mcp";
const workspace = process.env.MEMORY_STORE_LIVE_WORKSPACE || process.cwd();
const timeoutMs = Number.parseInt(process.env.MEMORY_STORE_LIVE_TIMEOUT_MS || "15000", 10);
const requiredVersion = process.env.MEMORY_STORE_LIVE_REQUIRED_VERSION || "1.22.2";
const chains = ["codex", "claude-code", "windsurf", "antigravity"] as const;

function textContent(result: { content?: readonly unknown[] }): string {
    return (result.content || [])
        .filter((item): item is { type: "text"; text: string } => {
            return typeof item === "object"
                && item !== null
                && (item as { type?: unknown }).type === "text"
                && typeof (item as { text?: unknown }).text === "string";
        })
        .map(item => item.text)
        .join("\n");
}

async function within<Value>(promise: Promise<Value>, label: string): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<Value>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

const client = new Client({ name: "memory-store-broker-live-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
    await within(client.connect(transport), "MCP initialize");
    const serverVersion = client.getServerVersion();
    assert.match(serverVersion?.name || "", /memory-store/iu, `unexpected live broker identity: ${JSON.stringify(serverVersion)}`);

    const tools = await within(client.listTools(), "tools/list");
    for (const toolName of ["memory_query", "conversation_read_original", "record_manage", "stage_guard"]) {
        assert.ok(tools.tools.some(tool => tool.name === toolName), `${toolName} must be registered by the live broker backend`);
    }

    const guide = await within(client.readResource({ uri: "memory-store://guide" }), "resources/read guide");
    const guideText = guide.contents
        .map(content => "text" in content && typeof content.text === "string" ? content.text : "")
        .join("\n");
    assert.match(guideText, new RegExp(`v${requiredVersion.replace(/\./gu, "\\.")}`, "u"), "guide must expose the expected version");

    const memory = await within(client.callTool({
        name: "memory_query",
        arguments: { workspace, depth: "index", limit: 1 },
    }), "memory_query");
    assert.equal(memory.isError, undefined, `memory_query failed: ${textContent(memory)}`);

    const sourceResults: Record<string, { isError: boolean; preview: string }> = {};
    for (const dataChain of chains) {
        const result = await within(client.callTool({
            name: "conversation_read_original",
            arguments: { action: "list", dataChain, limit: 1, threadMode: "main" },
        }), `conversation list ${dataChain}`);
        sourceResults[dataChain] = {
            isError: result.isError === true,
            preview: textContent(result).replace(/\s+/gu, " ").slice(0, 180),
        };
    }

    console.log(JSON.stringify({
        checkedAt: new Date().toISOString(),
        endpoint,
        serverVersion,
        toolCount: tools.tools.length,
        workspace,
        memoryPreview: textContent(memory).replace(/\s+/gu, " ").slice(0, 180),
        sourceResults,
    }, null, 2));
} finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
}
