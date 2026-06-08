#!/usr/bin/env node
import assert from "node:assert/strict";
import { callLanguageServer, callResolvedLanguageServer, resolveLanguageServer } from "../src/lsClient.js";

const mainId = process.argv[2] || process.env.SUBAGENT_MAIN_ID || undefined;
const resolved = await resolveLanguageServer({ mainId });

let staleCsrfFailed = false;
try {
  await callLanguageServer({
    port: resolved.port,
    csrf: "stale-csrf-token-for-smoke",
    method: "GetAllCascadeTrajectories",
    payload: {},
    timeoutMs: 5000,
  });
} catch (error) {
  staleCsrfFailed = true;
  assert.ok(error.status === 401 || error.status === 403, `expected auth failure, got ${error.status || error.message}`);
}
assert.ok(staleCsrfFailed, "stale CSRF smoke should fail before recovery");

let stalePortFailed = false;
try {
  await callLanguageServer({
    port: 9,
    csrf: resolved.csrf,
    method: "GetAllCascadeTrajectories",
    payload: {},
    timeoutMs: 1500,
  });
} catch {
  stalePortFailed = true;
}
assert.ok(stalePortFailed, "stale port smoke should fail before recovery");

const recovered = await callResolvedLanguageServer({
  mainId,
  method: "GetAllCascadeTrajectories",
  payload: {},
  retries: 1,
});
assert.ok(recovered.body.trajectorySummaries, "recovered call should return trajectory summaries");

console.log(
  `recovery ok: pid=${recovered.resolved.pid} port=${recovered.resolved.port} attempts=${recovered.attempts} trajectories=${Object.keys(recovered.body.trajectorySummaries).length}`,
);
