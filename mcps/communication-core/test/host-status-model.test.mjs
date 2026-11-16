import test from "node:test";
import assert from "node:assert/strict";
import { HostStatusProvider, createCodexStatusReader, createAntigravityStatusReader, createWindsurfStatusReader } from "../src/host-status.mjs";
import { codexModelObservation, projectModelObservation, unknownModelObservation } from "../src/host-model-observation.mjs";

const target = { host: "codex", conversation_id: "isolated-model-thread" };
const configured = { next_model_boundary: true, when_idle: true };

function codexReader(thread, envelope = {}) {
  return createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() {
      return {
        ok: true, closed: false, readyClientCount: 1, control_enabled: true,
        clients: [{ initialized: true, upstreamReady: true, downstreamState: 1, upstreamState: 1 }],
      };
    },
    async inspectThread(threadId) {
      return { ok: true, threadId, found: true, thread: { id: threadId, status: "active", canAcceptDirectInput: true, ...thread }, ...envelope };
    },
  });
}

function provider(context, reader, host = "codex", options = {}) {
  const instance = new HostStatusProvider({ providers: { [host]: reader }, ...options });
  context.after(() => instance.close());
  return instance;
}

test("Codex checked thread selection keeps its field, provider and effort separately from invocation", async context => {
  const instance = provider(context, codexReader({ model: "isolated-codex-model", modelProvider: "isolated-provider", reasoningEffort: "max", token: "private-model-token" }), "codex", { now: () => 1000 });
  const result = await instance.getStatus(target);
  assert.deepEqual(result.model_observation.current_selection, {
    model: "isolated-codex-model", source: "codex_thread_inspect", field: "thread.model", provider: "isolated-provider", reasoning_effort: "max",
  });
  assert.equal(result.model_observation.last_invocation.model, "unknown");
  assert.equal(result.model_observation.last_invocation.code, "model_invocation_not_exposed");
  assert.equal(result.observed_at, "1970-01-01T00:00:01.000Z");
  assert.equal(result.conversation_running, true);
  assert.equal(result.can_deliver, true);
  assert.equal(JSON.stringify(result).includes("private-model-token"), false);
});

test("whole-host model query stays unknown and never inspects a conversation", async context => {
  const reader = codexReader({ model: "isolated-codex-model" });
  reader.describeConversation = () => assert.fail("host-only query must not inspect a conversation");
  const result = await provider(context, reader).getStatus({ host: "codex" });
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.equal(result.model_observation.current_selection.code, "model_conversation_required");
  assert.equal(result.model_observation.last_invocation.code, "model_conversation_required");
});

test("mismatched, failed and absent thread identities never expose their model selection", async context => {
  for (const envelope of [
    { threadId: "foreign-thread" }, { thread: { id: "foreign-thread", model: "foreign-model" } },
    { ok: false }, { found: false, thread: null },
  ]) {
    const result = await provider(context, codexReader({ model: "unverified-model" }, envelope)).getStatus(target);
    assert.equal(result.model_observation.current_selection.model, "unknown");
    assert.equal(JSON.stringify(result).includes("unverified-model"), false);
    assert.equal(JSON.stringify(result).includes("foreign-model"), false);
  }
});

test("missing selection never falls back to recent turns, defaults, receipts or unrelated metadata", async context => {
  const result = await provider(context, codexReader({
    model_observed: true, defaultModel: "isolated-default-model", extra: { model: "isolated-extra-model" },
    turns: [{ model: "isolated-historical-model", status: "completed" }],
  }, { model: "isolated-envelope-model", receipt: { status: "model_observed" } })).getStatus(target);
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.equal(result.model_observation.current_selection.code, "model_selection_not_exposed");
  assert.equal(result.model_observation.last_invocation.model, "unknown");
  assert.equal(JSON.stringify(result).includes("isolated-historical-model"), false);
});

test("model identifiers reject receipt status, malformed values and unbounded text", () => {
  for (const model of [undefined, null, 123, {}, [], "", "unknown", "model_observed", "MODEL_OBSERVED", " model ", "model\nsecret", "model\u007fsecret", "x".repeat(129)]) {
    const result = codexModelObservation({ model });
    assert.equal(result.current_selection.model, "unknown");
    assert.equal(result.last_invocation.model, "unknown");
  }
  const result = codexModelObservation({ model: "isolated-model", modelProvider: "private\nprovider", reasoningEffort: "private-effort" });
  assert.deepEqual(result.current_selection, { model: "isolated-model", source: "codex_thread_inspect", field: "thread.model" });
});

test("projection emits only bounded fields and reconstructs unknown reasons", () => {
  const projected = projectModelObservation({
    current_selection: { model: "isolated-model", source: "isolated_source", field: "thread.model", token: "private-token", raw: { secret: "private-secret" } },
    last_invocation: { model: "unknown", source: "isolated_source", code: "model_invocation_not_exposed", reason: "private-reason" },
  }, "fallback_source");
  assert.deepEqual(projected.current_selection, { model: "isolated-model", source: "isolated_source", field: "thread.model" });
  assert.equal(JSON.stringify(projected).includes("private-"), false);
  assert.equal(projected.last_invocation.code, "model_invocation_not_exposed");
  assert.deepEqual(projectModelObservation({ current_selection: { model: "model_observed", source: "isolated_source", field: "thread.model" } }, "fallback_source"), unknownModelObservation("fallback_source"));
});

test("AG keeps model unknown with the exact describe-contract gap and performs no history reads", async context => {
  const reader = createAntigravityStatusReader({
    async describeHost() { return { host_online: true }; },
    async describe(actual) {
      return { cascade_id: actual.conversation_id, trajectory_id: "isolated-trajectory", status: "CASCADE_RUN_STATUS_RUNNING", model: "unverified-top-level-model", metadata: { model: "unverified-metadata-model" } };
    },
    readSteps() { assert.fail("model projection must not silently introduce history reads"); },
  }, { configured_delivery_modes: configured });
  const result = await provider(context, reader, "antigravity").getStatus({ ...target, host: "antigravity" });
  assert.equal(result.conversation_running, true);
  assert.equal(result.can_deliver, true);
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.equal(result.model_observation.current_selection.code, "model_metadata_not_exposed");
  assert.equal(result.model_observation.current_selection.source, "antigravity_ls_describe");
  assert.equal(JSON.stringify(result).includes("unverified-"), false);
});

test("model results are independent of transport readiness and cannot mutate the next snapshot", async context => {
  const reader = codexReader({ model: "isolated-model" });
  reader.getHostStatus = async () => ({ host_online: "unknown", control_enabled: false });
  const instance = provider(context, reader);
  const first = await instance.getStatus(target);
  assert.equal(first.model_observation.current_selection.model, "isolated-model");
  assert.equal(first.can_deliver, false);
  first.model_observation.current_selection.model = "mutated-model";
  const second = await instance.getStatus(target);
  assert.equal(second.model_observation.current_selection.model, "isolated-model");
});

test("injected Windsurf reader keeps its own unknown model source without launching a host", async context => {
  const reader = createWindsurfStatusReader({
    async describeHost() { return { host_online: true }; },
    async describe(actual) { return { cascade_id: actual.conversation_id, trajectory_id: "isolated-trajectory", status: "CASCADE_RUN_STATUS_IDLE" }; },
  });
  const result = await provider(context, reader, "windsurf").getStatus({ ...target, host: "windsurf" });
  assert.equal(result.model_observation.current_selection.source, "windsurf_ls_describe");
  assert.equal(result.model_observation.current_selection.model, "unknown");
});

test("closed, cancelled and failed probes retain unknown model evidence", async context => {
  const reader = codexReader({ model: "isolated-model" });
  const instance = provider(context, reader);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await instance.getStatus(target, { signal: controller.signal })).model_observation.current_selection.model, "unknown");
  reader.describeConversation = async () => { throw new Error("private-inspection-error"); };
  assert.equal((await instance.getStatus(target)).model_observation.current_selection.model, "unknown");
  await instance.close();
  const result = await instance.getStatus(target);
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.equal(result.code, "status_closed");
});

test("AG model observation retains current selection and checked invocation provenance separately", async context => {
  const calls = [];
  const reader = createAntigravityStatusReader({
    async describeHost() { return { host_online: true }; },
    async describe(actual) { return { cascade_id: actual.conversation_id, trajectory_id: "isolated-trajectory", status: "CASCADE_RUN_STATUS_RUNNING", step_count: 64 }; },
    async describeModel(actual, { description, kind, signal }) {
      calls.push({ actual, description, kind, signal });
      return kind === "current_selection" ? {
        model: "isolated-selected-model", raw_model: 1427, catalog_label: "Isolated selected model", source: "antigravity_renderer_model_selection",
        field: "modelSelection.byConversation.model", conversation_id: actual.conversation_id, observed_at: "2026-01-01T00:00:00.000Z",
      } : {
        model: "MODEL_PLACEHOLDER_ISOLATED", source: "antigravity_ls_model_usage", field: "steps.metadata.modelUsage.model",
        conversation_id: actual.conversation_id, trajectory_id: description.trajectory_id, step_index: 63, tail_offset: 32, tail_count: 32,
        observed_at: "2026-01-01T00:00:00.001Z",
      };
    },
  }, { configured_delivery_modes: configured });
  const result = await provider(context, reader, "antigravity").getStatus({ ...target, host: "antigravity" });
  assert.equal(result.model_observation.current_selection.model, "isolated-selected-model");
  assert.equal(result.model_observation.current_selection.raw_model, 1427);
  assert.equal(result.model_observation.last_invocation.model, "MODEL_PLACEHOLDER_ISOLATED");
  assert.equal(result.model_observation.last_invocation.step_index, 63);
  assert.equal(result.model_observation.last_invocation.tail_count, 32);
  assert.deepEqual(calls.map(call => call.kind), ["last_invocation", "current_selection"]);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && call.description.cascade_id === target.conversation_id));
  assert.equal(JSON.stringify(result).includes("model_context"), false);
});

test("model timeouts preserve independently successful observations and the host and run state", async context => {
  const reader = {
    source: "isolated_ag_status", configured_delivery_modes: configured,
    async getHostStatus() { return { host_online: true, transport_ready: true }; },
    async describeConversation() { return { conversation_exists: true, conversation_running: true }; },
    async observeModel(actual, { kind }) {
      if (kind === "current_selection") return { model: "isolated-selected-model", source: "isolated_live_selection", field: "modelSelection.byConversation.model" };
      return new Promise(() => {});
    },
  };
  const result = await provider(context, reader, "antigravity", { modelTimeoutMs: 5 }).getStatus({ ...target, host: "antigravity" });
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_running, true);
  assert.equal(result.can_deliver, true);
  assert.equal(result.code, undefined);
  assert.equal(result.model_observation.current_selection.model, "isolated-selected-model");
  assert.equal(result.model_observation.last_invocation.code, "model_observation_timeout");
});

test("failed current selection can coexist with a successful last invocation", async context => {
  const reader = {
    source: "isolated_ag_status", configured_delivery_modes: configured,
    async getHostStatus() { return { host_online: true, transport_ready: true }; },
    async describeConversation() { return { conversation_exists: true, conversation_running: false }; },
    async observeModel(actual, { kind }) {
      if (kind === "current_selection") throw new Error("private-renderer-error");
      return { model: "MODEL_PLACEHOLDER_ISOLATED", source: "isolated_model_usage", field: "steps.metadata.modelUsage.model", step_index: 7 };
    },
  };
  const result = await provider(context, reader, "antigravity").getStatus({ ...target, host: "antigravity" });
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_running, false);
  assert.equal(result.model_observation.current_selection.code, "model_observation_unavailable");
  assert.equal(result.model_observation.last_invocation.model, "MODEL_PLACEHOLDER_ISOLATED");
  assert.equal(JSON.stringify(result).includes("private-renderer-error"), false);
});

test("catalogue timeout retains usage identity and precedes the optional UI selection", async context => {
  const calls = [];
  const reader = {
    source: "isolated_ag_status", configured_delivery_modes: configured,
    async getHostStatus() { return { host_online: true, transport_ready: true }; },
    async describeConversation() { return { conversation_exists: true, conversation_running: false }; },
    async observeModel(actual, { kind }) {
      calls.push(kind);
      return kind === "last_invocation" ? {
        model: "MODEL_PLACEHOLDER_ISOLATED", source: "isolated_usage", field: "steps.metadata.modelUsage.model",
        step_index: 7, step_created_at: "2026-01-01T00:00:00.123456700Z",
      } : { model: "unknown", source: "isolated_renderer", code: "model_renderer_selection_missing" };
    },
    async observeModelCatalog() { calls.push("catalogue"); return new Promise(() => {}); },
  };
  const result = await provider(context, reader, "antigravity", { modelTimeoutMs: 5 }).getStatus({ ...target, host: "antigravity" });
  assert.deepEqual(calls, ["last_invocation", "catalogue", "current_selection"]);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_running, false);
  assert.equal(result.model_observation.last_invocation.model, "MODEL_PLACEHOLDER_ISOLATED");
  assert.equal(result.model_observation.last_invocation.step_created_at, "2026-01-01T00:00:00.123456700Z");
  assert.equal(result.model_observation.last_invocation.catalog_code, "model_observation_timeout");
});
