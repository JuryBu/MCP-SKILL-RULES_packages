import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-subagent-broker-follower-"));
const lockPath = path.join(dataDir, "process.lock");
await fs.writeFile(lockPath, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  created_at: new Date().toISOString(),
  note: "smoke owner lock held by parent process",
}, null, 2), "utf8");

const client = new Client({
  name: "mcp-subagent-broker-follower-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_MCP_BROKER: "1",
    SUBAGENT_DATA_DIR: dataDir,
    SUBAGENT_CLEANUP_INTERVAL_SEC: "0",
    SUBAGENT_AUTO_COLLECT_SCAN_SEC: "0",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  for (const name of ["subagent_current", "subagent_spawn", "subagent_collect", "subagent_wait"]) {
    if (!names.includes(name)) {
      throw new Error(`missing MCP tool ${name}; got ${names.join(",")}`);
    }
  }
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  if (lock.pid !== process.pid) {
    throw new Error(`broker follower should not replace owner lock; lock pid=${lock.pid}`);
  }
  console.log(`broker follower lock ok: tools=${names.length} ownerPid=${lock.pid}`);
} finally {
  await client.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
