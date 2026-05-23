/**
 * Quick smoke test for the MCP Web Fetcher v5 server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

async function main() {
    console.log("🔧 Starting MCP Web Fetcher v5 test...\n");

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0",
    });

    await client.connect(transport);
    console.log("✅ Connected to MCP Server v2\n");

    // List tools
    const tools = await client.listTools();
    console.log(`📋 Found ${tools.tools.length} tools:\n`);
    for (const tool of tools.tools) {
        console.log(`  - ${tool.name}: ${tool.description?.split("\n")[0]}`);
    }
    console.log();

    // Test fetch_page on example.com
    console.log("🌐 Testing web_fetch_page with example.com...");
    try {
        const result = await client.callTool({
            name: "web_fetch_page",
            arguments: { url: "https://example.com" },
        });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text || "";
        console.log(`✅ Fetched ${text.length} chars. Preview: ${text.slice(0, 100)}...\n`);
    } catch (error) {
        console.log(`❌ Error: ${error}\n`);
    }

    // Test extract_links
    console.log("🔗 Testing web_extract_links with example.com...");
    try {
        const result = await client.callTool({
            name: "web_extract_links",
            arguments: { url: "https://example.com" },
        });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text || "";
        console.log(`✅ Result: ${text.slice(0, 200)}\n`);
    } catch (error) {
        console.log(`❌ Error: ${error}\n`);
    }

    // Test interact - open session then close
    console.log("🖱️ Testing web_interact session...");
    try {
        const result = await client.callTool({
            name: "web_interact",
            arguments: { url: "https://example.com", action: "content" },
        });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text || "";
        const sessionId = text.match(/session_[0-9a-f-]{36}/i)?.[0];
        console.log(`✅ Session: ${sessionId}, Content: ${text.slice(0, 100)}...\n`);

        if (sessionId) {
            const closeResult = await client.callTool({
                name: "web_interact",
                arguments: { sessionId, action: "close" },
            });
            const closeText = (closeResult.content as Array<{ type: string; text?: string }>)[0]?.text || "";
            console.log(`✅ Close: ${closeText}\n`);
        }
    } catch (error) {
        console.log(`❌ Error: ${error}\n`);
    }

    console.log("🧹 Closing...");
    await client.close();
    console.log("✅ All v2 tests complete!");
    process.exit(0);
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
