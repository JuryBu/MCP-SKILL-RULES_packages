import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProxyParentCodeRuntime } from "../src/proxy-live-parent-runtime.mjs";
import { createProxyClassCodeParticipant } from "../src/proxy-live-code-runtime.mjs";

const ids = ["outer-proxy", "inner-coordinator", "managed-session", "proxy-service"];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function participant(id) {
  const state = { history: ["original"], clients: new Map(), implementation: { version: "original" }, generation: 0 };
  const snapshots = new WeakSet();
  const candidates = new WeakSet();
  return { id, stateSchema: `${id}-v1`, exportName: id, state,
    snapshot() { const token = Object.freeze({ state, implementation: state.implementation, generation: state.generation }); snapshots.add(token); return token; },
    prepare(module) { const candidate = Object.freeze({ implementation: module[this.id] }); candidates.add(candidate); return candidate; },
    activate(candidate) { assert.ok(candidates.has(candidate)); state.implementation = candidate.implementation; state.generation++; if (candidate.implementation.fail === this.id) throw new Error("injected-activation-failure"); },
    restore(token) { assert.ok(snapshots.has(token)); state.implementation = token.implementation; state.generation++; },
  };
}
function fixture(context, { failAt, validateActive } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parent-code-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = Buffer.from(`module.exports = ${JSON.stringify(Object.fromEntries(ids.map(id => [id, { version: "next", fail: failAt }])))};`);
  fs.writeFileSync(path.join(root, "parent.cjs"), source);
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1", format: "commonjs-bundle",
    version: "next", entry: "parent.cjs", files: [{ path: "parent.cjs", sha256: hash(source) }] }));
  const participants = ids.map(participant);
  const runtime = createProxyParentCodeRuntime(participants, { candidateRoot: root, instanceId: "fixture", validateActive });
  const prepared = runtime.prepare({ instanceId: "fixture", expectedRevision: 0, manifestPath, manifestSha256: hash(fs.readFileSync(manifestPath)) });
  return { root, participants, runtime, prepared };
}
test("all parent participants activate and restore together with resources unchanged", context => {
  const { participants, runtime, prepared } = fixture(context);
  const resources = participants.map(value => value.state.clients);
  const result = runtime.activate({ instanceId: "fixture", expectedRevision: 0, preparationId: prepared.id });
  assert.equal(result.selected.version, "next");
  assert.equal(result.revision, 1);
  participants.forEach((value, index) => { assert.equal(value.state.implementation.version, "next"); assert.equal(value.state.clients, resources[index]); assert.deepEqual(value.state.history, ["original"]); });
  runtime.restore({ instanceId: "fixture", expectedRevision: 1 });
  participants.forEach(value => assert.equal(value.state.implementation.version, "original"));
  assert.equal(runtime.status().revision, 2);
  runtime.restore({ instanceId: "fixture", expectedRevision: 2 });
  participants.forEach(value => assert.equal(value.state.implementation.version, "next"));
});
for (const failAt of ids) test(`activation failure at ${failAt} restores every participant`, context => {
  const { participants, runtime, prepared } = fixture(context, { failAt });
  assert.throws(() => runtime.activate({ instanceId: "fixture", expectedRevision: 0, preparationId: prepared.id }), /injected-activation-failure/u);
  participants.forEach(value => assert.equal(value.state.implementation.version, "original"));
  assert.equal(runtime.status().revision, 0);
  assert.equal(runtime.status().busy, false);
});
test("one missing runtime object prevents a partial parent upgrade", () => {
  assert.throws(() => createProxyParentCodeRuntime(ids.slice(0, 3).map(participant), {}), /LIVE_PARENT_PARTICIPANTS_INCOMPLETE/u);
});
test("asynchronous object mutation is refused before invoking any participant", () => {
  const participants = ids.map(participant);
  participants[1].activate = async () => { throw new Error("must-not-run"); };
  assert.throws(() => createProxyParentCodeRuntime(participants, {}), /LIVE_PARENT_PARTICIPANT_INVALID/u);
});
test("a separately changed participant invalidates an already prepared version", context => {
  const { participants, runtime, prepared } = fixture(context);
  participants[2].state.generation++;
  assert.throws(() => runtime.activate({ instanceId: "fixture", expectedRevision: 0, preparationId: prepared.id }), /LIVE_PARENT_PREPARATION_STALE/u);
});
test("modified bytes are refused before any runtime is activated", context => {
  const { root, participants, runtime, prepared } = fixture(context);
  fs.appendFileSync(path.join(root, "parent.cjs"), "\n");
  assert.throws(() => runtime.activate({ instanceId: "fixture", expectedRevision: 0, preparationId: prepared.id }), /LIVE_CODE_FILE_CHANGED/u);
  participants.forEach(value => assert.equal(value.state.implementation.version, "original"));
});
test("failed aggregate health rolls back the complete parent", context => {
  const { participants, runtime, prepared } = fixture(context, { validateActive: () => { throw new Error("unhealthy"); } });
  assert.throws(() => runtime.activate({ instanceId: "fixture", expectedRevision: 0, preparationId: prepared.id }), /unhealthy/u);
  participants.forEach(value => assert.equal(value.state.implementation.version, "original"));
});
test("proxy class participant retains clients and rejects foreign restore tokens", () => {
  class Original { static hotRuntimeSchema = "proxy-live-state-v1"; status() { return { closed: false, version: "original" }; } }
  class Candidate { static hotRuntimeSchema = "proxy-live-state-v1"; status() { return { closed: false, version: "next" }; } }
  const proxy = new Original();
  proxy.clients = new Map([["client", { pendingTool: "once" }]]);
  const controller = createProxyClassCodeParticipant(proxy);
  const clients = proxy.clients;
  const original = controller.activate(controller.prepare({ CodexAppServerProxy: Candidate }));
  assert.equal(proxy.status().version, "next");
  assert.equal(proxy.clients, clients);
  assert.throws(() => controller.restore({ ...original }), /LIVE_CODE_SNAPSHOT_INVALID/u);
  controller.restore(original);
  assert.equal(proxy.status().version, "original");
});
