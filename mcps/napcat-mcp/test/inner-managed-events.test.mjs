import assert from "node:assert/strict";
import test from "node:test";
import { createManagedEventObserver } from "../src/inner-managed-events.mjs";

test("managed rejection diagnostics keep fixed fields without request or conversation contents", () => {
  const values = [];
  const observe = createManagedEventObserver({ writer: { append: value => values.push(value) } });
  observe({ type: "request_rejected", code: "COORDINATOR_TURN_IDENTITY_REQUIRED", method: "GET", path: "/backend-api/codex/models",
    headers: { authorization: "private-token" }, threadId: "private-thread", body: "private-body" });
  assert.equal(values.length, 1);
  assert.equal(values[0].code, "COORDINATOR_TURN_IDENTITY_REQUIRED");
  assert.equal(values[0].path, "/backend-api/codex/models");
  assert.equal(JSON.stringify(values).includes("private"), false);
  observe({ type: "request_rejected", code: "safe", method: "POST", path: "/unknown/private-request", body: "secret" });
  assert.equal(Object.hasOwn(values[1], "path"), false);
  observe({ type: "request_routed", requestClass: "memory", method: "POST", path: "/backend-api/codex/memories/trace_summarize", body: "secret" });
  assert.equal(values[2].path, "/backend-api/codex/memories/trace_summarize");
  assert.equal(Object.hasOwn(values[2], "body"), false);
});

test("a diagnostic storage fault leaves the managed observer caller running", () => {
  const observe = createManagedEventObserver({ writer: { append() { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } } });
  assert.doesNotThrow(() => observe({ type: "request_rejected", code: "COORDINATOR_TURN_UNAVAILABLE" }));
});

test("managed rejection observer accepts only validated diagnostic scalars and hash16 identities", () => {
  const values = [];
  const observe = createManagedEventObserver({ writer: { append: value => values.push(value) } });
  const fields = { reason: "turn_mismatch", decisionPoint: "after_adopt", phase: "active", nativeHealthy: true,
    workerAlive: false, activeHttp: 1, workerActiveHttp: 2, coordinatorActiveHttp: 3,
    threadHash: "1".repeat(16), turnHash: "2".repeat(16), currentTurnHash: "3".repeat(16), workerFingerprint: "4".repeat(16) };
  observe({ type: "request_rejected", ...fields, threadId: "private-thread", turnId: "private-turn",
    currentTurnId: "private-current", headers: { authorization: "private-token" }, body: "private-body", prompt: "private-prompt",
    metadata: { thread_id: "private-thread" }, token: "private-token" });
  for (const [name, value] of Object.entries(fields)) assert.equal(values[0][name], value);
  assert.equal(JSON.stringify(values).includes("private"), false);
  observe({ type: "request_rejected", reason: "private-reason", decisionPoint: "private-stage", phase: "private-phase",
    nativeHealthy: "private-true", workerAlive: 1, activeHttp: -1, workerActiveHttp: 1.5, coordinatorActiveHttp: Number.MAX_SAFE_INTEGER + 1,
    threadHash: "private-thread", turnHash: "A".repeat(16), currentTurnHash: "1".repeat(17), workerFingerprint: { token: "private" } });
  assert.deepEqual(Object.keys(values[1]).sort(), ["at", "type"]);
});
