import assert from "node:assert/strict";
import test from "node:test";
import { createStreamRecovery } from "../src/codex-stream-recovery.mjs";

function eventsFromSse(body) {
  return body.trim().split("\n\n").map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data.slice(5).trim());
  });
}

test("recovery preserves the upstream response identity and never completes a held tool", () => {
  const recovery = createStreamRecovery("request-1");
  const responseId = "resp_upstream";
  const message = {
    type: "message",
    id: "msg_upstream",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  const tool = {
    type: "function_call",
    id: "call_upstream",
    name: "dangerous",
    arguments: "{}",
    status: "in_progress",
  };
  const observed = [
    { type: "response.created", sequence_number: 1, response: { id: responseId, status: "in_progress" } },
    { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: message },
    { type: "response.output_text.delta", sequence_number: 3, output_index: 0, item_id: message.id, content_index: 0, delta: "safe text" },
    { type: "response.output_item.added", sequence_number: 4, output_index: 1, item: tool },
    { type: "response.output_item.done", sequence_number: 5, output_index: 1, item: { ...tool, status: "completed" } },
  ];
  for (const event of observed) recovery.observe(event);
  for (const event of observed.slice(0, 3)) recovery.markDelivered(event);

  const events = eventsFromSse(recovery.finish("stream interrupted"));
  const toolDone = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "function_call");
  const completion = events.find((event) => event.type === "response.completed");
  const noticeAdded = events.find((event) => event.type === "response.output_item.added" && event.item?.id.startsWith("msg_proxy_"));

  assert.equal(toolDone, undefined);
  assert.equal(completion.response.id, responseId);
  assert.equal(completion.response.output.some((item) => item.type === "function_call"), false);
  assert.equal(noticeAdded.output_index, 2);
  assert.ok(events.every((event, index) => index === 0 || event.sequence_number > events[index - 1].sequence_number));
  assert.match(JSON.stringify(events), /safe text/u);
});
