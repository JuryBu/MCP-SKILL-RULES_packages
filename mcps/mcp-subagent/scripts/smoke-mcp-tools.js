import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-subagent-mcp-smoke-"));

const client = new Client({
  name: "mcp-subagent-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    SUBAGENT_DATA_DIR: dataDir,
    SUBAGENT_CLEANUP_INTERVAL_SEC: "0",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const required = ["subagent_cleanup", "subagent_collect", "subagent_current", "subagent_dispose", "subagent_interrupt", "subagent_list", "subagent_models", "subagent_move_queued", "subagent_poll", "subagent_reconcile", "subagent_reply", "subagent_spawn", "subagent_wait"];
  for (const name of required) {
    if (!names.includes(name)) {
      throw new Error(`missing MCP tool ${name}; got ${names.join(",")}`);
    }
  }
  const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));
  const modelsProps = byName.subagent_models.inputSchema.properties;
  if (!modelsProps.detail || !modelsProps.include_available || !modelsProps.candidate_limit) {
    throw new Error("subagent_models schema missing Stage K summary/detail controls");
  }
  const listProps = byName.subagent_list.inputSchema.properties;
  if (!listProps.detail || !listProps.include_deleted || !listProps.include_archived || !listProps.limit) {
    throw new Error("subagent_list schema missing Stage K visibility controls");
  }
  const waitProps = byName.subagent_wait.inputSchema.properties;
  if (!waitProps.wait_ms || !waitProps.poll_ms || !waitProps.collect) {
    throw new Error("subagent_wait schema missing wait/collect controls");
  }
  console.log(`mcp tools ok: ${names.join(",")}`);
} finally {
  await client.close();
}
