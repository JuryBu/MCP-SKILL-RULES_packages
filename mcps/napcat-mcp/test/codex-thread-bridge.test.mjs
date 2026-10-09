import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CodexThreadBridgeError,
  createCodexThreadBridge,
} from "../src/codex-thread-bridge.mjs";

const thisFile = fileURLToPath(import.meta.url);
const fakeArgumentIndex = process.argv.indexOf("--fake-app-server");
const fixtureStartTimeoutMs = 5000;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runFakeAppServer(mode) {
  let inputBuffer = "";
  let running = mode === "busy" || mode === "notify-item-completed";
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
    if (message.method) log(`${message.method}:${JSON.stringify(message.params ?? {})}`);
    if (message.method === "initialized") return;
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "test" } });
      return;
    }
    if (message.method === "thread/read" || message.method === "thread/resume") {
      if (mode === "rpc-error") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32004, message: `thread not found: ${message.params.threadId}` },
        });
        return;
      }
      const readErrors = {
        "rpc-method-error": { code: -32601, message: "thread/read: method not found" },
        "rpc-storage-error": { code: -32603, message: "thread storage: database missing required table" },
        "rpc-unloaded-error": { code: -32602, message: `thread not loaded: ${message.params.threadId}` },
        "rpc-wrong-missing-id": { code: -32602, message: "thread not found: unrelated-thread" },
      };
      if (readErrors[mode]) {
        send({ jsonrpc: "2.0", id: message.id, error: readErrors[mode] });
        return;
      }
      const invalidSummaries = {
        "null-summary": null,
        "missing-summary": {},
        "array-summary": { thread: [] },
        "missing-id-summary": { thread: { status: { type: "idle" } } },
        "wrong-id-summary": { thread: { id: "unrelated-thread", status: { type: "idle" }, metadata: { id: message.params.threadId, status: "idle" } } },
      };
      if (Object.hasOwn(invalidSummaries, mode)) {
        send({ jsonrpc: "2.0", id: message.id, result: invalidSummaries[mode] });
        return;
      }
      if (mode === "wrong-resume-summary" && message.method === "thread/resume") {
        send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "unrelated-thread", status: { type: "idle" } } } });
        return;
      }
      const conflictingTypes = {
        "summary-priority-active": "active",
        "summary-priority-system-error": "systemError",
        "summary-priority-found-false": "active",
        "summary-priority-future-notfound": "futureNotFoundReason",
        "summary-priority-object-busy": "busy",
        "resume-priority-active": "active",
        "resume-priority-system-error": "systemError",
      };
      if (Object.hasOwn(conflictingTypes, mode)) {
        const type = mode.startsWith("resume-priority-") && message.method === "thread/read"
          ? "notLoaded" : conflictingTypes[mode];
        send({ jsonrpc: "2.0", id: message.id, result: {
          threadId: message.params.threadId,
          status: "idle",
          ...(mode === "summary-priority-found-false" ? { found: false } : {}),
          thread: { id: message.params.threadId, status: { type } },
        } });
        return;
      }
      if (message.method === "thread/read" && (mode === "not-loaded" || mode === "system-error")) {
        send({ jsonrpc: "2.0", id: message.id, result: { thread: {
          id: message.params.threadId,
          status: { type: mode === "not-loaded" ? "notLoaded" : "systemError" },
          turns: [{ id: "old-completed", status: "completed" }],
        } } });
        return;
      }
      if (message.method === "thread/resume" && mode === "resume-busy") running = true;
      send({ jsonrpc: "2.0", id: message.id, result: resumeResult(message.params.threadId) });
      if (message.method === "thread/read" && mode.startsWith("notify-")) {
        setTimeout(() => send(mode === "notify-item-completed" ? {
          method: "item/completed",
          params: { threadId: message.params.threadId, item: { id: "tool-item", type: "commandExecution", status: "completed" } },
        } : mode === "notify-closed" ? {
          method: "thread/closed", params: { threadId: message.params.threadId },
        } : {
          method: "thread/status/changed",
          params: { threadId: message.params.threadId, status: { type: mode === "notify-not-loaded" ? "notLoaded" : "systemError" } },
        }), 10);
      }
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
    startTimeoutMs: fixtureStartTimeoutMs,
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
  for (const [mode, inspectedStatus, outcome, resumed] of [
    ["summary-priority-active", "busy", "busy", false],
    ["summary-priority-system-error", "system_error", "unknown", false],
    ["summary-priority-found-false", "busy", "busy", false],
    ["summary-priority-future-notfound", "unknown", "unknown", false],
    ["summary-priority-object-busy", "unknown", "unknown", false],
    ["resume-priority-active", "not_loaded", "busy", true],
    ["resume-priority-system-error", "not_loaded", "unknown", true],
  ]) {
    test(`direct ${mode} keeps the validated official summary and never submits a conflicting turn`, async () => {
      const fixture = createFixture(mode);
      try {
        const inspected = await fixture.bridge.inspectThread("thread-target");
        assert.equal(inspected.status, inspectedStatus);
        assert.equal(inspected.found, true);
        const result = await fixture.bridge.wake({ threadId: "thread-target", prompt: "fixture input" });
        assert.equal(result.outcome, outcome);
        const log = fixture.stderr.join("");
        assert.equal(log.includes("fake:thread/resume"), resumed);
        assert.doesNotMatch(log, /fake:turn\/start|fake:turn\/steer/);
      } finally {
        await fixture.close();
      }
    });
  }

  for (const [type, expected] of [["active", "busy"], ["systemError", "system_error"], ["futureNotFoundReason", "unknown"], ["busy", "unknown"]]) {
    test(`transparent official ${type} has priority over a same-id wrapper and false existence`, async () => {
      const bridge = createCodexThreadBridge({
        mode: "transparent_proxy", controlToken: "fixture-token",
        fetchImpl: async () => new Response(JSON.stringify({
          threadId: "thread-target", status: "idle", found: false,
          thread: { id: "thread-target", status: { type } },
        }), { status: 200 }),
      });
      try {
        const inspected = await bridge.inspectThread("thread-target");
        assert.equal(inspected.status, expected);
        assert.equal(inspected.found, true);
        assert.equal(inspected.thread.status.type, type);
      } finally {
        await bridge.close();
      }
    });
  }

  for (const mode of ["null-summary", "missing-summary", "array-summary", "missing-id-summary", "wrong-id-summary"]) {
    test(`direct ${mode} is rejected without resume or turn submission`, async () => {
      const fixture = createFixture(mode);
      try {
        await assert.rejects(() => fixture.bridge.inspectThread("thread-target"), { code: "INVALID_THREAD_SUMMARY" });
        await assert.rejects(() => fixture.bridge.wake({ threadId: "thread-target", prompt: "fixture input" }), { code: "INVALID_THREAD_SUMMARY" });
        assert.doesNotMatch(fixture.stderr.join(""), /fake:thread\/resume|fake:turn\/start|fake:turn\/steer/);
      } finally {
        await fixture.close();
      }
    });
  }

  test("direct rejects a mismatched resume summary before turn submission", async () => {
    const fixture = createFixture("wrong-resume-summary");
    try {
      await assert.rejects(() => fixture.bridge.wake({ threadId: "thread-target", prompt: "fixture input" }), { code: "INVALID_THREAD_SUMMARY" });
      assert.match(fixture.stderr.join(""), /fake:thread\/resume/);
      assert.doesNotMatch(fixture.stderr.join(""), /fake:turn\/start|fake:turn\/steer/);
    } finally {
      await fixture.close();
    }
  });

  for (const mode of ["rpc-method-error", "rpc-storage-error", "rpc-unloaded-error", "rpc-wrong-missing-id"]) {
    test(`direct ${mode} preserves the RPC error instead of claiming a missing thread`, async () => {
      const fixture = createFixture(mode);
      try {
        await assert.rejects(() => fixture.bridge.inspectThread("thread-target"), { code: "APP_SERVER_RPC_ERROR" });
        assert.doesNotMatch(fixture.stderr.join(""), /fake:thread\/resume|fake:turn\/start/);
      } finally {
        await fixture.close();
      }
    });
  }

  for (const [mode, status] of [["notify-not-loaded", "not_loaded"], ["notify-system-error", "system_error"], ["notify-closed", "not_loaded"], ["notify-item-completed", "busy"]]) {
    test(`direct ${mode} retains thread existence and correct runtime state`, async () => {
      const fixture = createFixture(mode);
      try {
        await fixture.bridge.inspectThread("thread-target");
        await sleep(35);
        const state = fixture.bridge.status().threads.find(entry => entry.threadId === "thread-target");
        assert.equal(state.status, status);
        assert.equal(state.found, true);
      } finally {
        await fixture.close();
      }
    });
  }

  test("handshake, read-only inspection, resumed wake, and completion state", async () => {
    const fixture = createFixture("complete", {
      requestTimeoutMs: 1000,
      startTimeoutMs: fixtureStartTimeoutMs,
    });
    try {
      const initial = await fixture.bridge.inspectThread("thread-example-primary");
      assert.equal(initial.status, "idle");
      assert.equal(initial.found, true);
      await fixture.bridge.inspectThread("thread-example-primary");
      assert.match(fixture.stderr.join(""), /fake:thread\/read:\{"threadId":"thread-example-primary","includeTurns":false\}/);
      assert.doesNotMatch(fixture.stderr.join(""), /fake:thread\/resume|fake:turn\/start|fake:turn\/steer/);

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
      assert.match(fixture.stderr.join(""), /fake:thread\/resume:\{\"threadId\":\"thread-example-primary\",\"excludeTurns\":true\}/);
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

  test("direct inspection leaves a stored thread unloaded and a real wake resumes it", async () => {
    const fixture = createFixture("not-loaded");
    try {
      const state = await fixture.bridge.inspectThread("thread-stored");
      assert.equal(state.status, "not_loaded");
      assert.equal(state.found, true);
      assert.doesNotMatch(fixture.stderr.join(""), /fake:thread\/resume|fake:turn\/start/);
      const result = await fixture.bridge.wake({ threadId: "thread-stored", prompt: "fixture wake" });
      assert.equal(result.outcome, "accepted");
      const log = fixture.stderr.join("");
      assert.ok(log.indexOf("fake:thread/resume") < log.indexOf("fake:turn/start"));
    } finally {
      await fixture.close();
    }
  });

  test("direct wake rechecks resumed state before starting a turn", async () => {
    const fixture = createFixture("resume-busy");
    try {
      const result = await fixture.bridge.wake({ threadId: "thread-raced", prompt: "fixture wake" });
      assert.equal(result.outcome, "busy");
      assert.match(fixture.stderr.join(""), /fake:thread\/resume/);
      assert.doesNotMatch(fixture.stderr.join(""), /fake:turn\/start/);
    } finally {
      await fixture.close();
    }
  });

  test("systemError is preserved despite a completed historical turn and never resumes", async () => {
    const fixture = createFixture("system-error");
    try {
      const state = await fixture.bridge.inspectThread("thread-system-error");
      assert.equal(state.status, "system_error");
      assert.equal(state.found, true);
      const result = await fixture.bridge.wake({ threadId: "thread-system-error", prompt: "fixture wake" });
      assert.equal(result.outcome, "unknown");
      assert.doesNotMatch(fixture.stderr.join(""), /fake:thread\/resume|fake:turn\/start/);
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

  test("read RPC not-found response becomes a stable not_found state", async () => {
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
    const fixture = createFixture("timeout", {
      requestTimeoutMs: 40,
      startTimeoutMs: fixtureStartTimeoutMs,
    });
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

  test("transparent proxy bridge retains legacy payload parsing without a runtime thread status", async () => {
    const responses = [
      { threadId: "thread-proxy", results: [{ thread: { id: "thread-proxy", turns: [{ status: "in_progress" }] } }] },
      { threadId: "thread-proxy", results: [{ thread: { id: "thread-proxy", turns: [{ status: "completed" }] } }] },
    ];
    const bridge = createCodexThreadBridge({
      mode: "transparent_proxy",
      controlUrl: "http://127.0.0.1:18431",
      controlToken: "proxy-test-token",
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      const busy = await bridge.inspectThread("thread-proxy");
      assert.equal(busy.status, "busy");
      assert.equal(busy.busy, true);
      const idle = await bridge.inspectThread("thread-proxy");
      assert.equal(idle.status, "idle");
      assert.equal(idle.busy, false);
    } finally {
      await bridge.close();
    }
  });

  test("transparent proxy bridge reconciles a timed out wake that failed before send", async () => {
    const calls = [];
    let wakeStatus = "dispatching";
    const bridge = createCodexThreadBridge({
      mode: "transparent_proxy",
      controlUrl: "http://127.0.0.1:18431",
      controlToken: "proxy-test-token",
      requestTimeoutMs: 250,
      reconcileTimeoutMs: 1000,
      reconcilePollMs: 10,
      fetchImpl: async (url, options) => {
        const route = new URL(url).pathname;
        calls.push({ route, method: options.method });
        if (route === "/v1/subscriptions") {
          return new Response(JSON.stringify({ ok: true, created: true }), { status: 200 });
        }
        if (route === "/v1/wakes" && options.method === "POST") {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              wakeStatus = "failed_before_send";
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          wake: {
            wakeId: "wake-timeout-failed",
            threadId: "thread-timeout-failed",
            status: wakeStatus,
            error: wakeStatus === "failed_before_send"
              ? { code: "APP_SERVER_TIMEOUT", message: "thread/resume 未完成", outcomeUnknown: false }
              : null,
          },
        }), { status: 200 });
      },
    });
    try {
      await assert.rejects(
        () => bridge.wake({
          taskId: "task-timeout-failed",
          generation: 1,
          threadId: "thread-timeout-failed",
          localRole: "development",
          sourceMachine: "training",
          targetMachine: "development",
          trustedPeerQq: "1000000001",
          wakeId: "wake-timeout-failed",
          pendingThroughSequence: 10,
          promptSha256: "e".repeat(64),
          prompt: "timeout wake prompt",
        }),
        (error) => error instanceof CodexThreadBridgeError
          && error.code === "APP_SERVER_TIMEOUT"
          && error.outcomeUnknown === false,
      );
      assert.equal(calls.filter((call) => call.route === "/v1/wakes" && call.method === "POST").length, 1);
      assert.ok(calls.some((call) => call.route === "/v1/wakes/wake-timeout-failed" && call.method === "GET"));
    } finally {
      await bridge.close();
    }
  });

  test("transparent proxy bridge recovers a timed out wake already accepted by the proxy", async () => {
    const calls = [];
    let wakeStatus = "dispatching";
    const bridge = createCodexThreadBridge({
      mode: "transparent_proxy",
      controlUrl: "http://127.0.0.1:18431",
      controlToken: "proxy-test-token",
      requestTimeoutMs: 250,
      reconcileTimeoutMs: 1000,
      reconcilePollMs: 10,
      fetchImpl: async (url, options) => {
        const route = new URL(url).pathname;
        calls.push({ route, method: options.method });
        if (route === "/v1/subscriptions") {
          return new Response(JSON.stringify({ ok: true, created: true }), { status: 200 });
        }
        if (route === "/v1/wakes" && options.method === "POST") {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              wakeStatus = "accepted";
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          wake: {
            wakeId: "wake-timeout-accepted",
            threadId: "thread-timeout-accepted",
            status: wakeStatus,
            turnId: wakeStatus === "accepted" ? "turn-accepted" : null,
          },
        }), { status: 200 });
      },
    });
    try {
      const result = await bridge.wake({
        taskId: "task-timeout-accepted",
        generation: 1,
        threadId: "thread-timeout-accepted",
        localRole: "development",
        sourceMachine: "training",
        targetMachine: "development",
        trustedPeerQq: "1000000001",
        wakeId: "wake-timeout-accepted",
        pendingThroughSequence: 11,
        promptSha256: "f".repeat(64),
        prompt: "accepted wake prompt",
      });
      assert.equal(result.outcome, "accepted");
      assert.equal(result.recovered, true);
      assert.equal(result.duplicateSuppressed, true);
      assert.equal(result.turn.id, "turn-accepted");
      assert.equal(calls.filter((call) => call.route === "/v1/wakes" && call.method === "POST").length, 1);
    } finally {
      await bridge.close();
    }
  });

}
