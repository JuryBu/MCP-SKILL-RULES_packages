import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createToolPreparationDeadline, classifyContextHint } from "../src/tool-preparation-deadline.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const tool = (name = "buffered_writer", id = "tool1", type = "function_call") => ({ type, id, call_id: id, name, arguments: "" });
const added = item => ({ type: "response.output_item.added", output_index: 0, item });
const done = item => ({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: "{}", status: "completed" } });
const complete = { type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } };

test("one fixed grace: heartbeat, duplicate start and later tool do not renew it", () => {
  const policy = createToolPreparationDeadline(120000);
  assert.equal(policy.deadline(40000), 40000);
  policy.observe(added(tool()), 1000);
  assert.equal(policy.deadline(40000), 121000);
  policy.observe({ type: "keepalive" }, 100000);
  policy.observe(added(tool()), 110000);
  policy.observe(added(tool("second", "tool2")), 115000);
  assert.equal(policy.deadline(40000), 121000);
  policy.observe(done(tool()), 116000);
  assert.equal(policy.active(), true);
  policy.observe(done(tool("second", "tool2")), 117000);
  assert.equal(policy.deadline(157000), 157000);
  policy.observe(added(tool("third", "tool3")), 160000);
  assert.equal(policy.deadline(157000), 157000);
});

test("hosted, message, reasoning and compaction items get no local grace", () => {
  for (const type of ["message", "reasoning", "web_search_call", "mcp_call", "custom_tool_call", "local_shell_call", "compaction", "future_unknown"]) {
    const policy = createToolPreparationDeadline(120000);
    policy.observe(added(tool("name", "identity", type)), 1000);
    assert.equal(policy.active(), false, type);
  }
});

test("only real function parameter delta exits the fixed preparation deadline", () => {
  const policy = createToolPreparationDeadline(120000);
  policy.observe(added(tool()), 1000);
  policy.observe({ type: "response.output_text.delta", delta: "message" }, 110000);
  assert.equal(policy.deadline(150000), 121000);
  policy.observe({ type: "response.function_call_arguments.delta", item_id: "tool1", delta: "{" }, 110000);
  assert.equal(policy.deadline(140000), 140000);
});

async function runScenario(schedule, options = {}) {
  const events = [];
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequests++;
    request.resume();
    const timers = [];
    const later = (delay, operation) => timers.push(setTimeout(operation, delay));
    response.on("close", () => timers.forEach(clearTimeout));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.created", response: { id: "resp_test", status: "in_progress" } }));
    schedule({ request, response, later, send: event => response.write(frame(event)) });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({
    host: "127.0.0.1", port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    firstProgressTimeoutMs: options.firstProgressTimeoutMs ?? 200, progressIdleTimeoutMs: 200,
    toolPreparationGraceMs: 600,
    onEvent: event => events.push(event),
  });
  const started = await proxy.start();
  const outputs = [];
  const startedAt = Date.now();
  try {
    for (let attempt = 0; attempt < (options.attempts ?? 1); attempt++) {
      const response = await fetch(`http://127.0.0.1:${started.port}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ thread_id: "isolated", turn_id: "test-turn", request_kind: "turn" }), ...options.headers },
        body: JSON.stringify({ model: "mock", stream: true, input: options.input ?? [] }),
      });
      let output = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
        options.onChunk?.(output);
      }
      outputs.push(output + decoder.decode());
    }
    return { events, outputs, elapsedMs: Date.now() - startedAt, upstreamRequests, status: proxy.status() };
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

for (const name of ["buffered_writer", "new_context", "functions.new_context"]) {
  test(`buffered preparation completes without native retry: ${name}`, async () => {
    const result = await runScenario(({ send, later }) => {
      send(added(tool(name)));
      later(400, () => {
        send({ type: "response.function_call_arguments.done", output_index: 0, item_id: "tool1", arguments: "{}" });
        send(done(tool(name)));
        send(complete);
      });
    });
    assert.equal(result.status.counters.actualCompletions, 1);
    assert.equal(result.status.counters.retrySignals, 0);
    assert.equal((result.outputs[0].match(/event: response.output_item.done/g) ?? []).length, 1);
  });
}

test("stalled tool with keepalives exhausts exactly three fixed local preparation attempts", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    for (let delay = 50; delay < 1500; delay += 50) later(delay, () => send({ type: "keepalive" }));
    later(500, () => send(added(tool())));
  }, { attempts: 3 });
  assert.equal(result.upstreamRequests, 3);
  const attempts = result.events.filter(event => event.type === "turn_attempt_finished");
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) assert.ok(attempt.elapsedMs >= 570 && attempt.elapsedMs < 1000, attempt.elapsedMs);
  assert.equal(result.status.counters.retrySignals, 2);
  assert.equal(result.events.filter(event => event.type === "local_tool_phase_retry_signal").length, 2);
  assert.equal(result.events.filter(event => event.type === "local_tool_phase_timeout").length, 1);
  assert.equal(result.events.find(event => event.type === "local_tool_phase_timeout")?.category, "tool_preparation");
  assert.match(result.outputs[2], /有限自动重试上限/u);
  assert.equal(result.outputs[0].includes('"type":"function_call"'), true);
  assert.equal(result.outputs[0].includes('event: response.function_call_arguments.done'), false);
  assert.equal(result.outputs[0].includes('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0'), false);
});

test("completed, argument-done or delta-before-added events cannot resurrect grace", () => {
  const terminalEvents = [done(tool()),
    { type: "response.function_call_arguments.done", item_id: "tool1", arguments: "{}" },
    { type: "response.function_call_arguments.delta", item_id: "tool1", delta: "{" }, complete];
  for (const event of terminalEvents) {
    const policy = createToolPreparationDeadline(120000);
    policy.observe(event, 0);
    policy.observe(added(tool()), 1000);
    policy.observe(added(tool("again", "tool2")), 2000);
    assert.equal(policy.active(), false, event.type);
    assert.equal(policy.deadline(40000), 40000);
  }
  const policy = createToolPreparationDeadline(120000);
  policy.observe(added(tool()), 0);
  policy.observe({ type: "response.function_call_arguments.delta", item_id: "tool1", delta: "" }, 10000);
  assert.equal(policy.active(), true);
  policy.observe({ type: "response.function_call_arguments.delta", item_id: "tool1", delta: "{" }, 11000);
  policy.observe(added(tool()), 20000);
  assert.equal(policy.active(), false);
});

for (const type of ["custom_tool_call", "local_shell_call"]) {
  test(`${type} keeps original timeout even with a context reminder`, async () => {
    const result = await runScenario(({ send }) => send(added(tool("exec", "tool1", type))), {
      input: [{ role: "developer", content: "<context_window_reminder>fixture</context_window_reminder>" }],
    });
    assert.ok(result.elapsedMs < 450, result.elapsedMs);
    assert.equal(result.status.counters.retrySignals, 1);
  });
}

test("tool done is delivered only after real response completion, exactly once", async () => {
  let completionSent = false;
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    later(350, () => send({ type: "response.function_call_arguments.done", item_id: "tool1", arguments: "{}" }));
    later(380, () => send(done(tool())));
    later(450, () => { completionSent = true; send(complete); });
  }, { onChunk: output => {
    if (output.includes("event: response.output_item.done")) assert.equal(completionSent, true);
  } });
  assert.equal(result.status.counters.actualCompletions, 1);
  assert.equal((result.outputs[0].match(/event: response.output_item.done/g) ?? []).length, 1);
});

test("complete emitted diagnostics contain no body, tool argument or auth canary", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    later(300, () => {
      send({ type: "response.function_call_arguments.done", item_id: "tool1", arguments: '{"value":"PARAM-CANARY"}' });
      send({ ...done(tool()), item: { ...tool(), arguments: '{"value":"PARAM-CANARY"}' } });
      send(complete);
    });
  }, { input: [{ role: "user", content: "BODY-CANARY" }], headers: { authorization: "Bearer AUTH-CANARY" } });
  const logged = JSON.stringify(result.events);
  for (const secret of ["BODY-CANARY", "PARAM-CANARY", "AUTH-CANARY"]) assert.equal(logged.includes(secret), false, secret);
  assert.equal(result.status.counters.actualCompletions, 1);
});

test("request hint is role-scoped and diagnostic output excludes content and credentials", () => {
  const marker = "<context_window_reminder>PRIVATE-CANARY</context_window_reminder>";
  const payload = { authorization: "SECRET", input: [{ role: "developer", content: [{ type: "input_text", text: marker }] }, { type: "function_call", name: "new_context", arguments: "PRIVATE-CANARY" }] };
  const summary = classifyContextHint(payload);
  assert.equal(summary.contextPreparationHint, true);
  assert.equal(summary.reminderCount, 1);
  assert.equal(JSON.stringify(summary).includes("PRIVATE-CANARY"), false);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  assert.equal(classifyContextHint({ input: [{ role: "user", content: marker }] }).contextPreparationHint, null);
  assert.equal(summary.hintFreshness, "unknown");
  assert.equal(classifyContextHint({ input: [{ encrypted_content: "opaque" }] }).contextPreparationHint, null);
  assert.equal(classifyContextHint({}).contextPreparationHint, null);
});

test("function delta retires grace and a subsequent stall gets original timeout", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    later(50, () => send({ type: "response.function_call_arguments.delta", item_id: "tool1", delta: "{" }));
    later(150, () => send(added(tool())));
  }, { input: [] });
  assert.ok(result.elapsedMs < 450, result.elapsedMs);
  assert.equal(result.status.counters.retrySignals, 1);
  assert.equal(result.events.find(event => event.type === "native_retry_signal")?.category, "local_timer");
  const outcome = result.events.find(event => event.type === "turn_attempt_finished");
  assert.equal(outcome.phase, "tool_parameters");
  assert.equal(outcome.endCause, "local_timer");
  assert.equal(outcome.contextPreparationHint, null);
});

test("heartbeats without a local tool keep the original 200ms threshold", async () => {
  const result = await runScenario(({ send, later }) => {
    for (let delay = 50; delay < 800; delay += 50) later(delay, () => send({ type: "keepalive" }));
  });
  assert.ok(result.elapsedMs < 450, result.elapsedMs);
  assert.equal(result.events.find(event => event.type === "native_retry_signal")?.reason, "FIRST_PROGRESS_TIMEOUT");
});

test("hosted tool does not get the local preparation grace", async () => {
  const result = await runScenario(({ send }) => send(added(tool("web", "tool1", "web_search_call"))));
  assert.ok(result.elapsedMs < 450, result.elapsedMs);
  assert.equal(result.status.counters.retrySignals, 1);
});

test("done item waits behind completion barrier and is absent from local recovery", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool("new_context")));
    later(50, () => send(done(tool("new_context"))));
    later(500, () => send(complete));
  }, { attempts: 3 });
  assert.equal(result.events.find(event => event.type === "local_tool_phase_timeout")?.category, "tool_completion");
  assert.equal(result.upstreamRequests, 3);
  assert.equal(result.status.counters.retrySignals, 2);
  assert.equal(result.events.filter(event => event.type === "local_tool_phase_retry_signal").length, 2);
  const delivered = result.outputs.join("\n").split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(delivered.some(event => event.type === "response.output_item.done" && event.item?.type === "function_call"), false);
  assert.equal(delivered.find(event => event.type === "response.completed").response.output.some(item => item.type === "function_call"), false);
});

test("real incremental progress is not cut off by a fixed 600ms grace", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    for (let delay = 100; delay < 900; delay += 100) later(delay, () => send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "tool1", delta: "x" }));
    later(900, () => { send(done(tool())); send(complete); });
  });
  assert.equal(result.status.counters.actualCompletions, 1);
  assert.equal(result.status.counters.retrySignals, 0);
});

test("unique encrypted reasoning completions sustain actual progress", async () => {
  const result = await runScenario(({ send, later }) => {
    for (const delay of [100, 220, 340]) later(delay, () => send({ type: "response.output_item.done", item: { type: "reasoning", id: `rs_${delay}`, encrypted_content: "synthetic-payload" } }));
    later(480, () => send(complete));
  });
  assert.equal(result.status.counters.retrySignals, 0);
  assert.equal(result.events.find(event => event.type === "turn_attempt_finished").kind, "completed");
});

test("replayed encrypted reasoning cannot keep a stalled request alive", async () => {
  const result = await runScenario(({ send, later }) => {
    for (const delay of [100, 200, 280, 360]) later(delay, () => send({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_duplicate", encrypted_content: "synthetic-payload" } }));
  });
  assert.equal(result.status.counters.retrySignals, 1);
  assert.ok(result.elapsedMs < 440, result.elapsedMs);
});

test("reasoning progress does not renew fixed function preparation grace", async () => {
  const result = await runScenario(({ send, later }) => {
    send(added(tool()));
    for (const delay of [100, 250, 400, 550]) later(delay, () => send({ type: "response.output_item.done", item: { type: "reasoning", id: `rs_${delay}`, encrypted_content: "synthetic-payload" } }));
  });
  assert.equal(result.status.counters.retrySignals, 1);
  assert.equal(result.events.find(event => event.type === "local_tool_phase_retry_signal")?.category, "tool_preparation");
  assert.ok(result.elapsedMs < 750, result.elapsedMs);
});

test("genuine connection resets retain five native retries and rapid wait", async () => {
  const result = await runScenario(({ response, later }) => later(5, () => response.destroy()), { attempts: 6, firstProgressTimeoutMs: 1500 });
  assert.equal(result.upstreamRequests, 6);
  assert.equal(result.events.filter(event => event.type === "native_retry_signal").length, 5);
  assert.equal(result.events.filter(event => event.type === "rapid_retry_wait_started").length, 1);
  assert.equal(result.events.find(event => event.type === "retry_exhausted_completed_idle")?.category, "network");
});
