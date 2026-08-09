import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";

function startMcp() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-task-mcp-"));
  const child = spawn(process.execPath, [path.resolve("src", "index.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NAPCAT_TASK_REGISTRY_PATH: path.join(temporaryRoot, "task-registry.json"),
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(String(message.id))) {
      pending.get(String(message.id))(message);
      pending.delete(String(message.id));
    }
  });
  let nextId = 1;
  function request(method, params, timeoutMs = 10000) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`MCP 请求超时：${method}\n${stderr}`));
      }, timeoutMs);
      pending.set(String(id), (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async function close() {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return { child, request, close };
}

function toolPayload(response) {
  assert.equal(response.error, undefined);
  const text = response.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("MCP task tools register, rebind, reject stale generation, and close", async () => {
  const fixture = startMcp();
  try {
    const initialize = await fixture.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "task-tool-test", version: "1.0.0" },
    });
    assert.equal(initialize.error, undefined);
    fixture.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listedTools = await fixture.request("tools/list", {});
    const names = listedTools.result.tools.map((tool) => tool.name);
    for (const name of [
      "napcat_task_register",
      "napcat_task_update",
      "napcat_task_close",
      "napcat_task_list",
      "napcat_task_status",
      "napcat_task_router_status",
      "napcat_task_ack",
    ]) {
      assert.equal(names.includes(name), true, `缺少工具：${name}`);
    }
    const sendFileTool = listedTools.result.tools.find((tool) => tool.name === "napcat_send_file");
    assert.deepEqual(
      ["task_id", "source_machine", "target_machine"].filter((field) => !sendFileTool.inputSchema.properties[field]),
      [],
    );
    const taskUpdateTool = listedTools.result.tools.find((tool) => tool.name === "napcat_task_update");
    assert.equal(Boolean(taskUpdateTool.inputSchema.properties.wake_cooldown_ms), true);
    const taskAckTool = listedTools.result.tools.find((tool) => tool.name === "napcat_task_ack");
    assert.equal(taskAckTool.inputSchema.properties.processed_message_seqs.type, "array");
    assert.equal(taskAckTool.inputSchema.properties.processed_message_seqs.uniqueItems, true);
    assert.deepEqual(taskAckTool.inputSchema.anyOf[0].required, ["processed_message_seqs", "wake_id"]);

    const registered = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_register",
      arguments: {
        task_id: "语音处理",
        conversation_id: "thread-example-primary",
        local_role: "development",
        source_machine: "development",
        target_machine: "training",
        trusted_peer_qq: "1000000001",
        wake_cooldown_ms: 1_800_000,
      },
    }));
    assert.equal(registered.ok, true);
    assert.equal(registered.task.generation, 1);
    assert.equal(registered.task.wakeCooldownMs, 1_800_000);
    assert.equal(registered.router.reason, "autostart_disabled");

    const status = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_status",
      arguments: { task_id: "语音处理" },
    }));
    assert.equal(status.task.conversationId, "thread-example-primary");

    const timingUpdated = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_update",
      arguments: {
        task_id: "语音处理",
        expected_generation: 1,
        wake_cooldown_ms: 60_000,
      },
    }));
    assert.equal(timingUpdated.task.wakeCooldownMs, 60_000);
    assert.equal(timingUpdated.task.generation, 1);

    const rebound = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_update",
      arguments: {
        task_id: "语音处理",
        expected_generation: 1,
        conversation_id: "thread-example-secondary",
      },
    }));
    assert.equal(rebound.task.generation, 2);

    const staleClose = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_close",
      arguments: { task_id: "语音处理", expected_generation: 1 },
    }));
    assert.equal(staleClose.ok, false);
    assert.equal(staleClose.code, "GENERATION_MISMATCH");

    const closed = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_close",
      arguments: {
        task_id: "语音处理",
        expected_generation: 2,
        confirm_pending_empty: true,
        confirm_peer_ready: true,
        final_close: true,
      },
    }));
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.task.status, "closed");

    const listed = toolPayload(await fixture.request("tools/call", {
      name: "napcat_task_list",
      arguments: { status: "closed" },
    }));
    assert.deepEqual(listed.tasks.map((task) => task.taskId), ["语音处理"]);
  } finally {
    await fixture.close();
  }
});
