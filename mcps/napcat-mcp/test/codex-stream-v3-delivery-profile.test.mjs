import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createToolPreparationDeadline } from "../src/tool-preparation-deadline.mjs";
import { parseToolDeliveryProfile, toolIdentityHash } from "../src/tool-delivery-profile.mjs";

const hash = (namespace, name) => createHash("sha256").update(JSON.stringify([namespace ?? null, name]), "utf8").digest("hex");
const tool = (namespace, name, id = "fixture-tool") => ({ type: "function_call", id, call_id: id, namespace, name, arguments: "" });
const added = item => ({ type: "response.output_item.added", output_index: 0, item });

test("only an exact synthetic namespace/name hash receives the extended budget", () => {
  const approved = tool("fixture", "buffered_writer");
  const policy = createToolPreparationDeadline(120_000, {
    bufferedToolIdentityHashes: [hash("fixture", "buffered_writer")],
    bufferedToolPreparationGraceMs: 300_000,
  });
  policy.observe(added(approved), 10);
  assert.equal(policy.deadline(40_000), 300_010);
  assert.equal(toolIdentityHash(approved), hash("fixture", "buffered_writer"));
  for (const candidate of [tool("other", "buffered_writer"), tool("fixture", "Buffered_writer"), tool("fixture", "buffered_writer_extra")]) {
    const ordinary = createToolPreparationDeadline(120_000, { bufferedToolIdentityHashes: [hash("fixture", "buffered_writer")] });
    ordinary.observe(added(candidate), 10);
    assert.equal(ordinary.deadline(40_000), 120_010);
  }
});

test("first argument delta immediately restores the 40-second normal deadline", () => {
  const policy = createToolPreparationDeadline(120_000, {
    bufferedToolIdentityHashes: [hash(null, "fixture_writer")], bufferedToolPreparationGraceMs: 300_000,
  });
  policy.observe(added(tool(null, "fixture_writer")), 0);
  policy.observe({ type: "response.function_call_arguments.delta", item_id: "fixture-tool", delta: "{" }, 100);
  assert.equal(policy.active(), false);
  assert.equal(policy.deadline(40_100), 40_100);
});

test("profile parser rejects malformed values and removes duplicate hashes", () => {
  assert.throws(() => parseToolDeliveryProfile("{"), /invalid tool delivery profile JSON/u);
  assert.throws(() => parseToolDeliveryProfile({ schemaVersion: 1, bufferedToolIdentityHashes: ["A".repeat(64)] }), /hash/u);
  const identity = hash(null, "fixture_writer");
  assert.deepEqual(parseToolDeliveryProfile({ schemaVersion: 1, bufferedToolIdentityHashes: [identity, identity] }), {
    schemaVersion: 1, bufferedToolIdentityHashes: [identity],
  });
});
