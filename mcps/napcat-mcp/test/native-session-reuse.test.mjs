import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";

const user = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = text => ({ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const toolCall = () => ({ type: "function_call", id: "fc_fixture", status: "completed", call_id: "call_fixture", name: "counter_once", arguments: "{}" });
const nativeItem = (item, turnId = "turn-1") => ({ ...structuredClone(item), internal_chat_message_metadata_passthrough: { turn_id: turnId, ...(item.type === "message" ? { content_item_kinds: ["output_text"] } : {}) } });
const body = input => ({ model: "fixture-model", tools: [], instructions: "Native metadata regression", input });

async function fixture(context, outputs) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const packets = [];
  const decisions = [];
  const sockets = new Set();
  let connections = 0;
  server.on("connection", socket => {
    connections += 1;
    const generation = connections;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", bytes => {
      const packet = JSON.parse(bytes.toString());
      packets.push({ packet, bytes: bytes.length, generation });
      const index = packets.length;
      const output = outputs[index - 1] ?? [];
      socket.send(JSON.stringify({ type: "response.created", response: { id: `resp_${index}`, status: "in_progress", output: [] } }));
      socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${index}`, status: "completed", output } }));
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}/responses`;
  const transport = createIncrementalResponsesTransport({ responseTimeoutMs: 1500 });
  context.after(async () => {
    transport.close();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    assert.equal(transport.status().connections, 0);
    assert.equal(transport.status().retainedBytes, 0);
  });
  const send = (operationId, payload) => new Promise((resolve, reject) => {
    const client = transport.createRequestClient({ sessionKey: "native-session", operationId, payload, url,
      onPacketSending: progress => decisions.push(progress.cacheDecision) });
    const request = client.request(url);
    request.on("response", response => {
      response.resume();
      response.once("end", resolve);
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });
  return { send, packets, decisions, get connections() { return connections; } };
}

test("native-added tool and assistant passthrough metadata preserve one connection across tool continuation and second turn", async context => {
  const call = toolCall();
  const answer = assistant("Fixture answer");
  const state = await fixture(context, [[call], [answer], []]);
  const initial = [user("Initial history ".repeat(1500))];
  await state.send("first", body(initial));
  const result = { type: "function_call_output", call_id: call.call_id, output: "count=1" };
  const continuation = [...initial, nativeItem(call), result];
  await state.send("tool-result", body(continuation));
  const question = { ...user("Next turn"), internal_chat_message_metadata_passthrough: { turn_id: "turn-2" } };
  await state.send("second-turn", body([...continuation, nativeItem(answer), question]));
  assert.equal(state.connections, 1);
  assert.deepEqual(state.packets.map(entry => entry.generation), [1, 1, 1]);
  assert.deepEqual(state.decisions.map(entry => entry.reason), ["initial", "reused", "reused"]);
  assert.equal(state.packets[1].packet.previous_response_id, "resp_1");
  assert.equal(state.packets[2].packet.previous_response_id, "resp_2");
  assert.deepEqual(state.packets[1].packet.input, [result]);
  assert.deepEqual(state.packets[2].packet.input, [question]);
  assert.ok(state.packets[1].bytes < state.packets[0].bytes / 10);
  assert.ok(state.packets[2].bytes < state.packets[0].bytes / 10);
});

test("server turn metadata omitted by native retains incremental tool and message continuation", async context => {
  const serverItem = item => ({ ...item, metadata: { turn_id: "server-turn" },
    internal_chat_message_metadata_passthrough: { create_time: 123, turn_id: "server-turn" } });
  const nativeEcho = item => {
    const echoed = structuredClone(item);
    delete echoed.metadata;
    if (echoed.type === "message") echoed.internal_chat_message_metadata_passthrough.content_item_kinds = ["output_text"];
    return echoed;
  };
  const call = serverItem(toolCall());
  const answer = serverItem(assistant("Real response structure"));
  answer.content[0].logprobs = [];
  const state = await fixture(context, [[call], [answer], []]);
  const initial = [user("Initial history ".repeat(1500))];
  await state.send("first-real-shape", body(initial));
  const result = { type: "function_call_output", call_id: call.call_id, output: "count=1" };
  const continuation = [...initial, nativeEcho(call), result];
  await state.send("real-tool-result", body(continuation));
  const next = user("Next turn");
  await state.send("real-second-turn", body([...continuation, nativeEcho(answer), next]));
  assert.equal(state.connections, 1);
  assert.deepEqual(state.packets.map(entry => entry.generation), [1, 1, 1]);
  assert.deepEqual(state.packets[1].packet.input, [result]);
  assert.deepEqual(state.packets[2].packet.input, [next]);
  assert.equal(state.packets[2].packet.previous_response_id, "resp_2");
});

test("native omission of empty reasoning content preserves encrypted reasoning and incremental input", async context => {
  const reasoning = { type: "reasoning", id: "reasoning_fixture", summary: [], content: [], encrypted_content: "encrypted-fixture" };
  const state = await fixture(context, [[reasoning], []]);
  const initial = [user("Initial reasoning")];
  await state.send("reasoning-first", body(initial));
  const echoed = { ...reasoning };
  delete echoed.content;
  const next = user("Continue");
  await state.send("reasoning-continuation", body([...initial, echoed, next]));
  assert.equal(state.connections, 1);
  assert.deepEqual(state.packets[1].packet.input, [next]);
  assert.equal(state.packets[1].packet.previous_response_id, "resp_1");
});

test("nonempty or encrypted reasoning changes require the complete replacement input", async context => {
  for (const field of ["content", "encrypted_content"]) await context.test(field, async context => {
    const reasoning = { type: "reasoning", id: "reasoning_fixture", summary: [], content: [], encrypted_content: "encrypted-fixture" };
    const state = await fixture(context, [[reasoning], []]);
    const initial = [user("Initial reasoning")];
    await state.send("reasoning-first-" + field, body(initial));
    const edited = { ...reasoning, [field]: field === "content" ? [{ type: "reasoning_text", text: "Changed" }] : "different-encrypted-fixture" };
    const replacement = [...initial, edited, user("Next")];
    await state.send("reasoning-change-" + field, body(replacement));
    assert.equal(state.connections, 2);
    assert.deepEqual(state.packets[1].packet.input, replacement);
    assert.equal(state.packets[1].packet.previous_response_id, undefined);
  });
});

test("unknown server metadata remains part of the exact prefix comparison", async context => {
  const answer = { ...assistant("Unknown metadata"), metadata: { turn_id: "server-turn", label: "keep" } };
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first-unknown-metadata", body(initial));
  const edited = { ...answer, metadata: { turn_id: "next-turn", label: "changed" } };
  const next = [...initial, edited, user("Next")];
  await state.send("changed-unknown-metadata", body(next));
  assert.equal(state.connections, 2);
  assert.deepEqual(state.packets[1].packet.input, next);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
  assert.equal(state.decisions[1].reason, "input_prefix_changed");
  assert.deepEqual(state.decisions[1].changedItemFields, [{ field: "metadata", before: "object", after: "object" }]);
});

test("native metadata normalization retains changed tool arguments as a full-input connection reset", async context => {
  const call = toolCall();
  const state = await fixture(context, [[call], []]);
  const initial = [user("Initial")];
  await state.send("first", body(initial));
  const changed = { ...nativeItem(call), arguments: '{"changed":true}' };
  await state.send("changed-tool", body([...initial, changed, { type: "function_call_output", call_id: call.call_id, output: "done" }]));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
  assert.equal(state.packets[1].packet.input.length, 3);
});

test("native metadata normalization retains edited assistant content as a full-input connection reset", async context => {
  const answer = assistant("Original answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", body(initial));
  await state.send("edited-answer", body([...initial, nativeItem(assistant("Edited answer")), user("Next")]));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
});

test("unrelated item metadata remains semantic for prefix comparison", async context => {
  const answer = assistant("Answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", body(initial));
  await state.send("semantic-item-metadata", body([...initial, { ...nativeItem(answer), metadata: { policy: "changed" } }, user("Next")]));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
});

test("native caller provenance changes preserve incremental history and original wire metadata", async context => {
  const answer = assistant("Answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  const firstMetadata = { turn_id: "first", root_turn_id: "first", "x-codex-turn-metadata": JSON.stringify({ turn_id: "first", root_turn_id: "first", turn_started_at_unix_ms: 100 }) };
  const nextMetadata = { turn_id: "second", root_turn_id: "root", parent_turn_id: "parent", "x-codex-turn-metadata": JSON.stringify({ turn_id: "second", root_turn_id: "root", parent_turn_id: "parent", turn_started_at_unix_ms: 200, turn_trigger: "subagent_notification" }) };
  await state.send("first", { ...body(initial), client_metadata: firstMetadata });
  const addition = user("Next");
  await state.send("provenance", { ...body([...initial, nativeItem(answer), addition]), client_metadata: nextMetadata });
  assert.equal(state.connections, 1);
  assert.equal(state.packets[1].packet.previous_response_id, "resp_1");
  assert.deepEqual(state.packets[1].packet.input, [addition]);
  assert.deepEqual(state.packets[1].packet.client_metadata, nextMetadata);
});

test("unknown nested turn metadata still changes the connection binding", async context => {
  const answer = assistant("Answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", { ...body(initial), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "first", semantic_policy: "first" }) } });
  await state.send("semantic-config", { ...body([...initial, nativeItem(answer), user("Next")]), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "second", parent_turn_id: "parent", semantic_policy: "changed" }) } });
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
});

test("semantic client metadata still changes the connection binding", async context => {
  const answer = assistant("Answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", { ...body(initial), client_metadata: { semantic_policy: "first" } });
  await state.send("semantic-config", { ...body([...initial, nativeItem(answer), user("Next")]), client_metadata: { semantic_policy: "changed" } });
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
});

test("unknown native passthrough metadata additions retain a full-input connection reset", async context => {
  const answer = assistant("Answer");
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", body(initial));
  const changed = nativeItem(answer);
  changed.internal_chat_message_metadata_passthrough.unknown_semantic_policy = "new";
  await state.send("unknown-added", body([...initial, changed, user("Next")]));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
  assert.equal(state.packets[1].packet.input.length, 3);
});

test("unknown native passthrough metadata value changes retain a full-input connection reset", async context => {
  const answer = { ...assistant("Answer"), internal_chat_message_metadata_passthrough: { unknown_semantic_policy: "original" } };
  const state = await fixture(context, [[answer], []]);
  const initial = [user("Initial")];
  await state.send("first", body(initial));
  const changed = nativeItem(answer);
  changed.internal_chat_message_metadata_passthrough.unknown_semantic_policy = "changed";
  await state.send("unknown-changed", body([...initial, changed, user("Next")]));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
});

test("compressed native history drops the old connection and sends the complete replacement input", async context => {
  const answer = assistant("Original answer");
  const state = await fixture(context, [[answer], []]);
  await state.send("first", body([user("Uncompressed initial history"), user("Details")]));
  const compressed = [user("Compacted replacement history"), user("Next")];
  await state.send("compressed", body(compressed));
  assert.equal(state.connections, 2);
  assert.equal(state.packets[1].packet.previous_response_id, undefined);
  assert.deepEqual(state.packets[1].packet.input, compressed);
});
