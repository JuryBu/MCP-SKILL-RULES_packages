import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaults } from "./config-utils.js";

const client = new Client({
  name: "mcp-subagent-broker-smoke",
  version: "0.1.0",
});

const transport = new StreamableHTTPClientTransport(new URL(defaults.route));
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const required = [
    "subagent_cleanup",
    "subagent_collect",
    "subagent_current",
    "subagent_dispose",
    "subagent_interrupt",
    "subagent_list",
    "subagent_models",
    "subagent_move_queued",
    "subagent_poll",
    "subagent_reconcile",
    "subagent_reply",
    "subagent_spawn",
  ];
  for (const name of required) {
    if (!names.includes(name)) {
      throw new Error(`missing broker MCP tool ${name}; got ${names.join(",")}`);
    }
  }
  console.log(`broker mcp tools ok: ${names.join(",")}`);
} finally {
  await client.close();
}
