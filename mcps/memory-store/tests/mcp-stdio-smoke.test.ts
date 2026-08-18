import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan35-mcp-smoke-"));
const workspace = path.join(temporaryRoot, "workspace");
const home = path.join(temporaryRoot, "home");
const codexHome = path.join(home, ".codex");
const dataRoot = path.join(temporaryRoot, "data");

fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
execFileSync("python", [
  "-c",
  [
    "import sqlite3, sys",
    "conn = sqlite3.connect(sys.argv[1])",
    "conn.execute('create table threads (id text primary key, rollout_path text, cwd text, title text, source text, model text, reasoning_effort text, agent_nickname text, agent_role text, updated_at_ms integer, updated_at text, archived integer default 0)')",
    "conn.execute('create table thread_spawn_edges (child_thread_id text, parent_thread_id text, status text)')",
    "conn.commit()",
    "conn.close()",
  ].join("\n"),
  path.join(codexHome, "state_5.sqlite"),
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repositoryRoot, "dist", "index.js")],
  cwd: repositoryRoot,
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/u, "") || "C:",
    HOMEPATH: home.slice((path.parse(home).root.replace(/\\$/u, "") || "C:").length) || "\\",
    MEMORY_STORE_DATA_ROOT: dataRoot,
  },
  stderr: "pipe",
});

const client = new Client({ name: "plan35-mcp-stdio-smoke", version: "1.0.0" });
let serverStderr = "";
transport.stderr?.on("data", (chunk) => {
  serverStderr += String(chunk);
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "record_manage"), "record_manage tool must be registered");

  const result = await client.callTool({
    name: "record_manage",
    arguments: {
      action: "list",
      scope: "workspace",
      workspace,
    },
  });

  assert.equal(result.isError, undefined, `record_manage list failed: ${JSON.stringify(result)}`);
  const text = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(text, /Record|记录|未找到|0/iu, `unexpected list response: ${text}`);
  assert.equal(fs.existsSync(dataRoot), true, "server must create the isolated data root");
  assert.match(serverStderr, new RegExp(dataRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));

  const batchResult = await client.callTool({
    name: "record_manage",
    arguments: {
      action: "batch_update",
      dataChain: "codex",
      modelChain: "codex",
      workspace,
      stale_only: true,
      force: false,
      limit: 1,
    },
  });
  assert.equal(batchResult.isError, undefined, `record_manage batch_update failed: ${JSON.stringify(batchResult)}`);
  const batchText = batchResult.content
    .filter((item): item is Extract<(typeof batchResult.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const taskId = batchText.match(/taskId:\s*([\w-]+)/iu)?.[1];
  assert.ok(taskId, `batch_update must return taskId: ${batchText}`);

  const statusResult = await client.callTool({
    name: "record_manage",
    arguments: {
      action: "task_status",
      taskId,
      waitSeconds: 5,
    },
  });
  assert.equal(statusResult.isError, undefined, `record_manage task_status failed: ${JSON.stringify(statusResult)}`);
  const statusText = statusResult.content
    .filter((item): item is Extract<(typeof statusResult.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(statusText, /done|完成|无符合条件的对话/iu, `batch task must complete against the empty fixture: ${statusText}`);

  console.log("mcp stdio smoke passed", {
    toolCount: tools.tools.length,
    workspace,
    dataRoot,
    responsePreview: text.slice(0, 160),
    batchTaskId: taskId,
    batchStatusPreview: statusText.slice(0, 160),
  });
} catch (error) {
  if (serverStderr.trim()) {
    console.error("server stderr:\n" + serverStderr.trim());
  }
  throw error;
} finally {
  await client.close().catch(() => undefined);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
