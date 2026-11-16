import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readAntigravityRendererModel } from "../src/host-model-observation.mjs";
import { AntigravityLsTransport } from "../src/transports/antigravity-ls.mjs";

const target = { host: "antigravity", conversation_id: "isolated-root" };
const endpoint = { pid: 10, host_pid: 20, port: 28002, ls_ports: [28002], host_ports: [28001], csrf: "private-csrf-sentinel" };
const page = { type: "page", url: "https://127.0.0.1:28002/c/another-open-conversation", webSocketDebuggerUrl: "ws://127.0.0.1:28001/devtools/page/isolated-renderer" };

function rendererFixture(state) {
  const calls = [];
  const sockets = [];
  class FixtureSocket extends EventTarget {
    constructor(address) {
      super();
      this.address = address;
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(payload) {
      const request = JSON.parse(payload);
      calls.push(request);
      assert.equal(request.method, "Runtime.evaluate");
      const root = { __reactContainer$fixture: { memoizedProps: { value: { store: { getState: () => state } } } } };
      const value = runInNewContext(request.params.expression, { document: { getElementById: () => root } }, { timeout: 100 });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: { result: { value } } }) })));
    }
    close() { this.closed = true; }
  }
  return { calls, sockets, WebSocketImpl: FixtureSocket, fetchImpl: async () => Response.json([page]) };
}

function selectionState({ selected = 1427, includeTarget = true, matches = 1 } = {}) {
  return {
    modelSelection: { default: { model: 9999 }, byConversation: includeTarget ? { [target.conversation_id]: { model: selected } } : {} },
    userStatus: { cascadeModelConfigData: { clientModelConfigs: Array.from({ length: matches }, () => ({
      modelId: "isolated-current-model", label: "Isolated current model", modelOrAlias: { choice: { case: "model", value: 1427 } },
    })) } },
  };
}

test("current renderer selection uses the exact conversation key and live catalogue instead of the different default", async () => {
  const fixture = rendererFixture(selectionState());
  const result = await readAntigravityRendererModel(target, endpoint, fixture);
  assert.equal(result.model, "isolated-current-model");
  assert.equal(result.raw_model, 1427);
  assert.equal(result.catalog_label, "Isolated current model");
  assert.equal(result.conversation_id, target.conversation_id);
  assert.equal(result.source, "antigravity_renderer_model_selection");
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.sockets.every(socket => socket.closed));
  assert.equal(JSON.stringify(result).includes(endpoint.csrf), false);
});

test("absent per-conversation selection and missing or ambiguous catalogue entries remain unknown", async () => {
  for (const [options, code] of [
    [{ includeTarget: false }, "model_renderer_selection_missing"],
    [{ matches: 0 }, "model_catalog_match_missing"],
    [{ matches: 2 }, "model_catalog_match_missing"],
  ]) {
    const result = await readAntigravityRendererModel(target, endpoint, rendererFixture(selectionState(options)));
    assert.equal(result.model, "unknown");
    assert.equal(result.code, code);
  }
});

test("foreign endpoint pages, foreign socket hosts and multiple matching windows cannot supply current selection", async () => {
  for (const pages of [
    [{ ...page, url: "https://127.0.0.1:28003/c/foreign" }],
    [{ ...page, webSocketDebuggerUrl: "ws://example.invalid:28001/devtools/page/foreign" }],
    [page, { ...page, webSocketDebuggerUrl: "ws://127.0.0.1:28001/devtools/page/second" }],
  ]) {
    const fixture = rendererFixture(selectionState());
    fixture.fetchImpl = async () => Response.json(pages);
    const result = await readAntigravityRendererModel(target, endpoint, fixture);
    assert.equal(result.model, "unknown");
    assert.equal(fixture.calls.length, 0);
  }
});

test("pre-cancelled renderer observation performs no metadata or socket operation", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = rendererFixture(selectionState());
  fixture.fetchImpl = () => assert.fail("cancelled observation must not fetch");
  const result = await readAntigravityRendererModel(target, endpoint, { ...fixture, signal: controller.signal });
  assert.equal(result.model, "unknown");
  assert.equal(result.code, "model_observation_timeout");
  assert.equal(fixture.sockets.length, 0);
});

function usageStep(index, overrides = {}) {
  return { metadata: {
    sourceTrajectoryStepInfo: { cascadeId: target.conversation_id, trajectoryId: "isolated-trajectory", stepIndex: index },
    modelUsage: { model: "MODEL_PLACEHOLDER_ISOLATED", apiProvider: "API_PROVIDER_ISOLATED" },
    createdAt: "2026-01-01T00:00:00.123456700Z",
    ...overrides,
  } };
}

function usageTransport(context, steps) {
  const calls = [];
  const instance = new AntigravityLsTransport({
    discover: () => assert.fail("model-only tail observation must not rediscover or load history"),
    fetchImpl: async (address, options) => { calls.push({ address, payload: JSON.parse(options.body) }); return Response.json({ steps }); },
  });
  instance.endpoints.set(target.conversation_id, { ...endpoint, trajectory_id: "isolated-trajectory", observed_at: Date.now() });
  context.after(() => instance.close());
  return { instance, calls, description: { cascade_id: target.conversation_id, trajectory_id: "isolated-trajectory", step_count: 100 } };
}

test("last invocation reads at most one 32-step tail and preserves original identity, enum and sample", async context => {
  const fixture = usageTransport(context, Array.from({ length: 32 }, (unused, index) => usageStep(68 + index)));
  const result = await fixture.instance.describeModel(target, { description: fixture.description, kind: "last_invocation" });
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].payload, { cascadeId: target.conversation_id, stepOffset: 68 });
  assert.equal(result.model, "MODEL_PLACEHOLDER_ISOLATED");
  assert.equal(result.step_index, 99);
  assert.equal(result.trajectory_id, "isolated-trajectory");
  assert.equal(result.tail_offset, 68);
  assert.equal(result.tail_count, 32);
  assert.equal(result.step_created_at, "2026-01-01T00:00:00.123456700Z");
  assert.ok(Number.isFinite(Date.parse(result.observed_at)));
  assert.equal(JSON.stringify(result).includes(endpoint.csrf), false);
});

test("overflow, mixed identity and noncontiguous indices reject the model tail without another request", async context => {
  for (const steps of [
    Array.from({ length: 33 }, (unused, index) => usageStep(68 + index)),
    [usageStep(68, { sourceTrajectoryStepInfo: { cascadeId: "foreign", trajectoryId: "isolated-trajectory", stepIndex: 68 } })],
    [usageStep(69)],
  ]) {
    const fixture = usageTransport(context, steps);
    const result = await fixture.instance.describeModel(target, { description: fixture.description, kind: "last_invocation" });
    assert.equal(result.model, "unknown");
    assert.equal(result.code, "model_tail_mismatch");
    assert.equal(fixture.calls.length, 1);
  }
});

test("stale or mismatched original descriptions do not trigger a model request", async context => {
  const fixture = usageTransport(context, [usageStep(68)]);
  fixture.instance.endpoints.get(target.conversation_id).observed_at = Date.now() - 9000;
  const stale = await fixture.instance.describeModel(target, { description: fixture.description, kind: "last_invocation" });
  assert.equal(stale.model, "unknown");
  assert.equal(fixture.calls.length, 0);
  fixture.instance.endpoints.get(target.conversation_id).observed_at = Date.now();
  const mismatched = await fixture.instance.describeModel(target, { description: { ...fixture.description, trajectory_id: "foreign-trajectory" }, kind: "last_invocation" });
  assert.equal(mismatched.model, "unknown");
  assert.equal(fixture.calls.length, 0);
});

test("current LS catalogue maps only the exact usage enum and preserves the authoritative ID and label", async context => {
  const fixture = usageTransport(context, []);
  const calls = [];
  fixture.instance.fetchImpl = async (address, options) => {
    calls.push({ address, body: JSON.parse(options.body) });
    return Response.json({ clientModelConfigs: [
      { modelOrAlias: { model: "MODEL_PLACEHOLDER_ISOLATED" }, modelId: "isolated-catalogue-model", label: "Isolated catalogue model" },
      { modelOrAlias: { model: "MODEL_PLACEHOLDER_OTHER" }, modelId: "isolated-other-model", label: "Other model" },
    ] });
  };
  const result = await fixture.instance.describeModelCatalog(target, { description: fixture.description, model: "MODEL_PLACEHOLDER_ISOLATED" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].address.endsWith("/GetCascadeModelConfigData"));
  assert.deepEqual(calls[0].body, {});
  assert.equal(result.catalog_model_id, "isolated-catalogue-model");
  assert.equal(result.catalog_label, "Isolated catalogue model");
  assert.equal(result.catalog_source, "antigravity_ls_model_config_data");
});

test("missing or ambiguous LS catalogue mappings remain a catalogue gap", async context => {
  const fixture = usageTransport(context, []);
  for (const configs of [[], [{ modelOrAlias: { model: "MODEL_PLACEHOLDER_ISOLATED" } }, { modelOrAlias: { model: "MODEL_PLACEHOLDER_ISOLATED" } }]]) {
    fixture.instance.fetchImpl = async () => Response.json({ clientModelConfigs: configs });
    const result = await fixture.instance.describeModelCatalog(target, { description: fixture.description, model: "MODEL_PLACEHOLDER_ISOLATED" });
    assert.equal(result.catalog_code, "model_catalog_match_missing");
    assert.equal(result.catalog_model_id, undefined);
  }
});
