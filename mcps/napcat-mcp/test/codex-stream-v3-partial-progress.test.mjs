import test from "node:test";
import assert from "node:assert/strict";
import { partialResponsesSseProgress } from "../src/partial-response-progress.mjs";

const classify = value => partialResponsesSseProgress(value, new Set());

test("escaped argument payload growth is counted across quotes and backslashes", () => {
  const wire = `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", delta: JSON.stringify({ path: "C:\\中文\\file", text: 'say "hello"'.repeat(100) }) })}`;
  let previous = 0;
  for (let length = 100; length < wire.length; length += 31) {
    const progress = classify(wire.slice(0, length));
    assert.ok(progress.bytes > previous, `${length}: ${progress.bytes} <= ${previous}`);
    assert.equal(progress.argumentsProgress, true);
    previous = progress.bytes;
  }
});

test("only semantic fields refresh an incomplete frame", () => {
  const wire = 'data: {"type":"response.output_text.delta","delta":"work",';
  assert.equal(classify(wire).bytes, classify(`${wire}"metadata":"unrelated`).bytes);
  assert.equal(classify(wire).bytes, classify(`${wire}\n: keepalive comment`).bytes);
  assert.equal(classify(`data: ${JSON.stringify({ type: "heartbeat", text: "response.output_text.delta" })}`), null);
});

test("completed reasoning is not treated as new partial progress", () => {
  const wire = 'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_duplicate","encrypted_content":"abc';
  assert.equal(partialResponsesSseProgress(wire, new Set(["rs_duplicate"])), null);
});

test("partial function arguments retire preparation without completing the tool", () => {
  const wire = 'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fixture-tool","arguments":"partial';
  const progress = classify(wire);
  assert.equal(progress.argumentsProgress, true);
  assert.equal(progress.bytes, 7);
});
