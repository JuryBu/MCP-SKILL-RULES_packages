import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequestObservation } from "../src/model-observation-hooks.mjs";
import { createModelObserver } from "../src/model-observer.mjs";

async function scenario(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-watch-hooks-"));
  const filePath = path.join(directory, "observations.jsonl");
  const producerInstance = crypto.randomUUID();
  const writer = createModelObserver({ filePath, statusPath: path.join(directory, "runtime.json"), producerInstance });
  const accepted = [];
  const hooks = createRequestObservation({ emit: record => accepted.push(writer.observe(record)), producerInstance, requestId: crypto.randomUUID(), endpoint: "compact" });
  try {
    await run(hooks);
    await writer.flush();
    const records = (await fs.readFile(filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    return { accepted, records: records.filter(record => record.type === "model_observation"), status: writer.status() };
  } finally { await writer.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test("real hooks plus writer accept pending, JSON, synthetic and unsupported phases without schema loss", async () => {
  const result = await scenario(hooks => {
    hooks.parsed("model-A"); hooks.submitted(); hooks.headers({ "content-type": "application/json" }, 200);
    hooks.json({ model: "model-B", output: ["private-output"] }); hooks.synthetic(); hooks.unsupported(); hooks.ended("completed");
  });
  assert.ok(result.accepted.every(Boolean));
  assert.equal(result.status.dropped, 0);
  assert.equal(result.status.write_errors, 0);
  assert.equal(result.records.length, 7);
  assert.ok(result.records.some(record => record.phase === "response.json" && record.upstream_response_model === "model-B"));
  assert.doesNotMatch(JSON.stringify(result.records), /private-output/);
});

test("hook-sanitized illegal model counter survives writer without disclosing value", async () => {
  const result = await scenario(hooks => {
    hooks.parsed("private invalid request"); hooks.submitted(); hooks.headers({ "openai-model": "private invalid header" }, 200);
    hooks.event({ type: "response.completed", response: { model: "model-B" } }); hooks.ended("completed");
  });
  assert.ok(result.accepted.every(Boolean));
  assert.ok(result.records.some(record => record.invalid_fields === 2));
  assert.doesNotMatch(JSON.stringify(result.records), /private invalid/);
  assert.equal(result.status.dropped, 0);
});
