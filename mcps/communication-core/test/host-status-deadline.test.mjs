import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { HostStatusProvider } from "../src/host-status.mjs";

test("optional model observations cannot erase a host result completed just before its original deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let finishHost;
  const observations = [];
  const provider = new HostStatusProvider({ timeoutMs: 8, modelTimeoutMs: 20, providers: {
    synthetic: {
      source: "synthetic_status",
      configured_delivery_modes: { next_model_boundary: true, when_idle: true },
      async getHostStatus() { return new Promise(resolveResult => { finishHost = resolveResult; }); },
      async describeConversation() { return { conversation_exists: true, conversation_running: true }; },
      async observeModel(target, { kind }) { observations.push(kind); return new Promise(() => {}); },
    },
  } });
  context.after(() => provider.close());
  let settled = false;
  const pending = provider.getStatus({ host: "synthetic", conversation_id: "synthetic-deadline-cid" }).then(value => { settled = true; return value; });
  await nextTurn();
  context.mock.timers.tick(7);
  finishHost({ host_online: true, transport_ready: true });
  await nextTurn();
  assert.deepEqual(observations, ["last_invocation"]);
  context.mock.timers.tick(1);
  await nextTurn();
  assert.equal(settled, false);
  for (let iteration = 0; iteration < 3 && !settled; iteration += 1) {
    context.mock.timers.tick(20);
    await nextTurn();
  }
  const result = await pending;
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.conversation_running, true);
  assert.equal(result.can_deliver, true);
  assert.equal(result.model_observation.last_invocation.model, "unknown");
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.deepEqual(observations, ["last_invocation", "current_selection"]);
});
