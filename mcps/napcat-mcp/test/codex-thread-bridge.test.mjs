import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CodexThreadBridgeError,
  createCodexThreadBridge,
} from "../src/codex-thread-bridge.mjs";

const thisFile = fileURLToPath(import.meta.url);
const fakeArgumentIndex = process.argv.indexOf("--fake-app-server");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runFakeAppServer(mode) {
  let inputBuffer = "";
  let running = mode === "busy";
  const log = (value) => process.stderr.write(`fake:${value}\n`);
  const resumeResult = (threadId) => ({
    thread: {
      id: threadId,
      status: running ? "in_progress" : "completed",
    },
    turns: [{
      id: running ? "turn-running" : "turn-completed",
      status: running ? "in_progress" : "completed",
    }],
  });
  const handleMessage = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.method) log(message.method);
    if (message.method === "initialized") return;
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "test" } });
      return;
    }
    if (message.method === "thread/resume") {
      if (mode === "rpc-error") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32004, message: "thread not found" },
        });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: resumeResult(message.params.threadId) });
      return;
    }
    if (message.method === "turn/start") {
      if (mode === "timeout") return;
      if (mode === "exit") {
        setTimeout(() => process.exit(17), 5);
        return;
      }
      if (mode === "turn-error") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "turn rejected" },
        });
        return;
      }
      if (mode === "immediate-complete") {
        running = false;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { turn: { id: "turn-new", status: "completed" } },
        });
        return;
      }
      running = true;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { turn: { id: "turn-new", status: "in_progress" } },
      });
      if (mode === "complete") {
        setTimeout(() => {
          running = false;
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: message.params.threadId,
              turn: { id: "turn-new", status: "completed" },
            },
          });
        }, 20);
      }
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unknown method ${message.method}` },
    });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    while (true) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).replace(/\r$/, "");
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      handleMessage(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => {
    log("stdin-end");
    process.exit(0);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createFixture(mode, overrides = {}) {
  const stderr = [];
  const bridge = createCodexThreadBridge({
    executablePath: process.execPath,
    appServerArgs: [thisFile, "--fake-app-server", mode],
    requestTimeoutMs: 120,
    startTimeoutMs: 1000,
    closeTimeoutMs: 120,
    onStderr: (chunk) => stderr.push(chunk),
    ...overrides,
  });
  return {
    bridge,
    stderr,
    async close() {
      await bridge.close();
    },
  };
}

if (fakeArgumentIndex >= 0) {
  runFakeAppServer(process.argv[fakeArgumentIndex + 1] || "complete");
} else {
  test("handshake, resume/read, wake accepted, and completion state", async () => {
    const fixture = createFixture("complete", { requestTimeoutMs: 1000, startTimeoutMs: 1000 });
    try {
      const initial = await fixture.bridge.inspectThread("thread-example-primary");
      assert.equal(initial.status, "idle");
      assert.equal(initial.found, true);

      const wake = await fixture.bridge.wake({
        threadId: "thread-example-primary",
        prompt: "继续执行已安排的检查",
      });
      assert.equal(wake.outcome, "accepted");
      assert.equal(wake.status, "busy");
      assert.equal(wake.started, true);

      await sleep(45);
      const completed = await fixture.bridge.inspectThread("thread-example-primary");
      assert.equal(completed.status, "idle");
      assert.match(fixture.stderr.join(""), /fake:initialize/);
      assert.match(fixture.stderr.join(""), /fake:initialized/);
      assert.match(fixture.stderr.join(""), /fake:thread\/resume/);
      assert.match(fixture.stderr.join(""), /fake:turn\/start/);
    } finally {
      await fixture.close();
    }
  });

  test("wake distinguishes a synchronously completed turn from accepted work", async () => {
    const fixture = createFixture("immediate-complete");
    try {
      const result = await fixture.bridge.wake({
        threadId: "thread-completed",
        prompt: "立即完成",
      });
      assert.equal(result.outcome, "completed");
      assert.equal(result.status, "idle");
      assert.equal(result.started, true);
    } finally {
      await fixture.close();
    }
  });

  test("wake does not start a second turn while the thread is busy", async () => {
    const fixture = createFixture("busy");
    try {
      const result = await fixture.bridge.wake({
        threadId: "thread-busy",
        prompt: "这段提示不应发送",
      });
      assert.deepEqual(result, {
        threadId: "thread-busy",
        status: "busy",
        outcome: "busy",
        started: false,
        thread: result.thread,
      });
      assert.doesNotMatch(fixture.stderr.join(""), /fake:turn\/start/);
    } finally {
      await fixture.close();
    }
  });

  test("resume RPC not-found response becomes a stable not_found state", async () => {
    const fixture = createFixture("rpc-error");
    try {
      const state = await fixture.bridge.inspectThread("thread-missing");
      assert.equal(state.status, "not_found");
      assert.equal(state.found, false);
      const wake = await fixture.bridge.wake({ threadId: "thread-missing", prompt: "不应开始" });
      assert.equal(wake.outcome, "unknown");
      assert.equal(wake.reason, "thread_not_found");
      assert.doesNotMatch(fixture.stderr.join(""), /fake:turn\/start/);
    } finally {
      await fixture.close();
    }
  });

  test("known app-server RPC errors are surfaced without an unknown result", async () => {
    const fixture = createFixture("turn-error");
    try {
      await assert.rejects(
        () => fixture.bridge.wake({ threadId: "thread-error", prompt: "触发已知错误" }),
        (error) => error instanceof CodexThreadBridgeError
          && error.code === "APP_SERVER_RPC_ERROR"
          && error.outcomeUnknown === false,
      );
      assert.match(fixture.stderr.join(""), /fake:turn\/start/);
    } finally {
      await fixture.close();
    }
  });

  test("turn timeout is returned as unknown and is not retried", async () => {
    const fixture = createFixture("timeout", { requestTimeoutMs: 40, startTimeoutMs: 1000 });
    try {
      const result = await fixture.bridge.wake({ threadId: "thread-timeout", prompt: "只发送一次" });
      assert.equal(result.status, "unknown");
      assert.equal(result.outcome, "unknown");
      assert.equal(result.error.code, "APP_SERVER_TIMEOUT");
      assert.equal((fixture.stderr.join("").match(/fake:turn\/start/g) ?? []).length, 1);
    } finally {
      await fixture.close();
    }
  });

  test("process exit after turn submission is unknown and close cleans the child", async () => {
    const fixture = createFixture("exit");
    try {
      const result = await fixture.bridge.wake({ threadId: "thread-exit", prompt: "会在提交后退出" });
      assert.equal(result.status, "unknown");
      assert.equal(result.outcome, "unknown");
      assert.equal(result.error.code, "APP_SERVER_EXIT");
      const beforeClose = fixture.bridge.status();
      assert.equal(beforeClose.running, false);
    } finally {
      await fixture.close();
      assert.equal(fixture.bridge.status().closed, true);
    }
  });

  test("close ends the fake app-server process and rejects further calls", async () => {
    const fixture = createFixture("complete");
    await fixture.bridge.inspectThread("thread-close");
    await fixture.close();
    assert.equal(fixture.bridge.status().running, false);
    assert.equal(fixture.bridge.status().closed, true);
    await assert.rejects(
      () => fixture.bridge.inspectThread("thread-close"),
      (error) => error instanceof CodexThreadBridgeError && error.code === "BRIDGE_CLOSED",
    );
  });

  test("transparent proxy bridge registers the full task subscription before wake", async () => {
    const calls = [];
    let configuredVisibility = "visible";
    const bridge = createCodexThreadBridge({
      mode: "transparent_proxy",
      controlUrl: "http://127.0.0.1:18431",
      controlToken: "proxy-test-token",
      bindingPath: "test-binding.json",
      fsImpl: {
        readFileSync: () => JSON.stringify({ codexWakeMessageVisibility: configuredVisibility }),
      },
      fetchImpl: async (url, options) => {
        const route = new URL(url).pathname;
        const body = JSON.parse(options.body);
        calls.push({ route, body });
        return new Response(JSON.stringify(route === "/v1/wakes"
          ? { ok: true, outcome: "accepted", started: true, turn: { id: "turn-proxy" } }
          : { ok: true, created: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const result = await bridge.wake({
        taskId: "task-proxy",
        generation: 3,
        threadId: "thread-proxy",
        localRole: "development",
        sourceMachine: "training",
        targetMachine: "development",
        trustedPeerQq: "1000000001",
        wakeId: "wake-proxy",
        pendingThroughSequence: 99,
        pendingThroughTime: "2026-08-02T00:00:00.000Z",
        promptSha256: "c".repeat(64),
        prompt: "wake prompt",
      });
      assert.equal(result.outcome, "accepted");
      assert.deepEqual(calls.map((call) => call.route), ["/v1/subscriptions", "/v1/wakes"]);
      assert.equal(calls[0].body.taskId, "task-proxy");
      assert.equal(calls[0].body.generation, 3);
      assert.equal(calls[1].body.pendingThroughSequence, 99);
      assert.equal(calls[1].body.wakeId, "wake-proxy");
      assert.equal(calls[1].body.messageVisibility, "visible");

      configuredVisibility = "hidden";
      await bridge.wake({
        taskId: "task-proxy",
        generation: 3,
        threadId: "thread-proxy",
        localRole: "development",
        sourceMachine: "training",
        targetMachine: "development",
        trustedPeerQq: "1000000001",
        wakeId: "wake-proxy-hidden",
        pendingThroughSequence: 100,
        pendingThroughTime: "2026-08-02T00:00:01.000Z",
        promptSha256: "d".repeat(64),
        prompt: "hidden wake prompt",
      });
      assert.equal(calls[3].body.messageVisibility, "hidden");
    } finally {
      await bridge.close();
    }
  });

}
