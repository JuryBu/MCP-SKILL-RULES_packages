import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fixedHandoffCompatibility, acceptHandoffVersion } from "../src/inner-handoff-compatibility.mjs";
import { isolatedHandoffConfiguration } from "../src/inner-runner-handoff-control.mjs";

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const source = { core: "a".repeat(64), helper: "b".repeat(64) };
const target = { core: "c".repeat(64), helper: "b".repeat(64) };
const edge = () => ({ source: { ...source }, target: { ...target }, checkpointSchemaVersion: 1,
  stateSchemaVersion: 1, stateSemantics: "state-v1" });
const configuration = (edges = [edge()]) => {
  const manifest = { schemaVersion: 1, edges };
  return { manifest, sha256: digest(JSON.stringify(manifest)) };
};
const payload = () => ({ schemaVersion: 1, source: { sourceHashes: { ...source } },
  snapshot: { schemaVersion: 1, threadId: "synthetic", token: crypto.randomUUID(), capturedAt: Date.now(), policyKey: "{}",
    state: { attempts: [], emptyIdleTurns: [], businessProgress: [], waitTerminals: [] } } });
const argumentsFor = () => {
  const compatibility = fixedHandoffCompatibility(configuration());
  return { compatibility, payload: { ...payload(), compatibilityManifestSha256: compatibility.sha256 },
    targetHashes: { ...target }, currentTargetHashes: { ...target } };
};

test("startup manifest is bounded, exact, hash-bound and detached from its mutable caller", () => {
  assert.equal(fixedHandoffCompatibility(undefined), null);
  const supplied = configuration();
  const fixed = fixedHandoffCompatibility(supplied);
  supplied.manifest.edges[0].target.core = "d".repeat(64);
  assert.equal(fixed.manifest.edges[0].target.core, target.core);
  assert.ok(Object.isFrozen(fixed) && Object.isFrozen(fixed.manifest.edges[0].target));
  assert.throws(() => { fixed.manifest.edges.push(edge()); }, TypeError);
  for (const invalid of [null, {}, { ...configuration(), sha256: "0".repeat(64) },
    configuration([]), configuration([edge(), edge()]), configuration(Array.from({ length: 5 }, edge)),
    configuration([{ ...edge(), source: { ...source, extra: true } }]),
    configuration([{ ...edge(), target: { ...source } }]),
    configuration([{ ...edge(), stateSchemaVersion: 2 }]),
    configuration([{ ...edge(), checkpointSchemaVersion: 2 }]),
    configuration([{ ...edge(), stateSemantics: "state-v2" }]),
    configuration([{ ...edge(), approvalFromRequest: true }])]) {
    assert.throws(() => fixedHandoffCompatibility(invalid), error => /^HANDOFF_.*MANIFEST/u.test(error.code));
  }
});

test("default requires identical core and helper even with a request-supplied migration list", () => {
  const args = argumentsFor();
  assert.throws(() => acceptHandoffVersion({ ...args, compatibility: null,
    payload: { ...args.payload, compatibility: configuration() } }), { code: "CHECKPOINT_IDENTITY_MISMATCH" });
  assert.equal(acceptHandoffVersion({ ...args, compatibility: null, payload: {
    ...args.payload, source: { sourceHashes: { ...target } } } }).mode, "strict-same-sha");
  assert.throws(() => acceptHandoffVersion({ ...args, compatibility: null, payload: {
    ...args.payload, source: { sourceHashes: { ...target, helper: source.core } } } }), { code: "CHECKPOINT_IDENTITY_MISMATCH" });
});

test("normal configuration pins the manifest before use and keeps production mode closed", () => {
  const parent = process.env.INNER_RUNNER_TEST_ROOT ?? path.join(os.tmpdir(), "napcat-hot-switch-20261010", "inner-version-0100-unit");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "inner-version-0100-config-"));
  const supplied = { schemaVersion: 1, mode: "isolated", ownerId: "synthetic", capability: "a".repeat(64),
    checkpointRoot: root, compatibility: configuration() };
  const args = configuration => ({ environment: { CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify(configuration),
    CODEX_MODEL_STREAM_PROXY_STATE_ROOT: path.join(root, "state"), CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:1" },
    ipc: { connected: true, send() {} }, stateRoot: path.join(root, "state"), host: "127.0.0.1", upstreamOrigin: "http://127.0.0.1:1" });
  const fixed = isolatedHandoffConfiguration(args(supplied));
  assert.ok(Object.isFrozen(fixed));
  assert.equal(fixed.compatibility.sha256, supplied.compatibility.sha256);
  assert.throws(() => isolatedHandoffConfiguration(args({ ...supplied, mode: "production" })), { code: "HANDOFF_INVALID_CONFIGURATION" });
  assert.throws(() => isolatedHandoffConfiguration(args({ ...supplied, compatibility: { ...supplied.compatibility, sha256: "0".repeat(64) } })),
    { code: "HANDOFF_COMPATIBILITY_MANIFEST_HASH_MISMATCH" });
  fs.writeFileSync(path.join(root, "configuration-evidence.json"), JSON.stringify({ manifestSha256: fixed.compatibility.sha256,
    manifestFrozen: Object.isFrozen(fixed.compatibility.manifest), productionModeClosed: true }));
});

test("only the pinned directed edge and signed manifest digest can admit the new version", () => {
  const args = argumentsFor();
  assert.deepEqual(acceptHandoffVersion(args), { mode: "compatible-version", stateSemantics: "state-v1",
    manifestSha256: args.compatibility.sha256, edgeIndex: 0 });
  for (const sourceHashes of [{ ...source, core: "d".repeat(64) }, { ...source, helper: "d".repeat(64) }]) {
    assert.throws(() => acceptHandoffVersion({ ...args, payload: { ...args.payload, source: { sourceHashes } } }),
      { code: "CHECKPOINT_VERSION_EDGE_NOT_ALLOWED" });
  }
  const wrongTarget = { ...target, helper: "d".repeat(64) };
  assert.throws(() => acceptHandoffVersion({ ...args, targetHashes: wrongTarget, currentTargetHashes: wrongTarget }),
    { code: "CHECKPOINT_VERSION_EDGE_NOT_ALLOWED" });
  assert.throws(() => acceptHandoffVersion({ ...args, targetHashes: source, currentTargetHashes: source,
    payload: { ...args.payload, source: { sourceHashes: target } } }), { code: "CHECKPOINT_VERSION_EDGE_NOT_ALLOWED" });
  for (const compatibilityManifestSha256 of [undefined, "0".repeat(64)]) {
    assert.throws(() => acceptHandoffVersion({ ...args, payload: { ...args.payload, compatibilityManifestSha256 } }),
      { code: "CHECKPOINT_COMPATIBILITY_MANIFEST_MISMATCH" });
  }
});

test("target bytes are reread and unknown checkpoint or state formats fail before any import", () => {
  const args = argumentsFor();
  assert.throws(() => acceptHandoffVersion({ ...args, currentTargetHashes: source }), { code: "CHECKPOINT_TARGET_BYTES_CHANGED" });
  for (const invalid of [{ ...args.payload, schemaVersion: 2 },
    { ...args.payload, snapshot: { ...args.payload.snapshot, schemaVersion: 2 } },
    { ...args.payload, snapshot: { ...args.payload.snapshot, extension: true } },
    { ...args.payload, snapshot: { ...args.payload.snapshot, state: { ...args.payload.snapshot.state, unknown: [] } } },
    { ...args.payload, snapshot: { ...args.payload.snapshot, state: { ...args.payload.snapshot.state, attempts: {} } } }]) {
    assert.throws(() => acceptHandoffVersion({ ...args, payload: invalid }), { code: "CHECKPOINT_INCOMPATIBLE_STATE_FORMAT" });
  }
});
