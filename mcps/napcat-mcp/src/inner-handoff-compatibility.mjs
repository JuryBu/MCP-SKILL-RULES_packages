import crypto from "node:crypto";

const MAX_EDGES = 4;
const MAX_MANIFEST_BYTES = 8 * 1024;
const STATE_CHANNELS = ["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"];
const SNAPSHOT_FIELDS = ["schemaVersion", "threadId", "token", "capturedAt", "policyKey", "state"];
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const version = value => keys(value, ["core", "helper"]) && hash(value.core) && hash(value.helper);
const sameVersion = (left, right) => left?.core === right?.core && left?.helper === right?.helper;

export function fixedHandoffCompatibility(input) {
  if (input === undefined) return null;
  if (!keys(input, ["manifest", "sha256"]) || !hash(input.sha256)) fail("HANDOFF_INVALID_COMPATIBILITY_MANIFEST");
  const manifest = input.manifest;
  if (!keys(manifest, ["schemaVersion", "edges"]) || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.edges) || manifest.edges.length < 1 || manifest.edges.length > MAX_EDGES) {
    fail("HANDOFF_INVALID_COMPATIBILITY_MANIFEST");
  }
  const seen = new Set();
  const edges = manifest.edges.map(edge => {
    if (!keys(edge, ["source", "target", "checkpointSchemaVersion", "stateSchemaVersion", "stateSemantics"])
      || !version(edge.source) || !version(edge.target) || sameVersion(edge.source, edge.target)
      || edge.checkpointSchemaVersion !== 1 || edge.stateSchemaVersion !== 1 || edge.stateSemantics !== "state-v1") {
      fail("HANDOFF_INVALID_COMPATIBILITY_MANIFEST");
    }
    const normalized = { source: Object.freeze({ core: edge.source.core, helper: edge.source.helper }),
      target: Object.freeze({ core: edge.target.core, helper: edge.target.helper }), checkpointSchemaVersion: 1,
      stateSchemaVersion: 1, stateSemantics: "state-v1" };
    const identity = JSON.stringify(normalized);
    if (seen.has(identity)) fail("HANDOFF_INVALID_COMPATIBILITY_MANIFEST");
    seen.add(identity);
    return Object.freeze(normalized);
  });
  const normalized = Object.freeze({ schemaVersion: 1, edges: Object.freeze(edges) });
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) fail("HANDOFF_INVALID_COMPATIBILITY_MANIFEST");
  if (digest(serialized) !== input.sha256) fail("HANDOFF_COMPATIBILITY_MANIFEST_HASH_MISMATCH");
  return Object.freeze({ manifest: normalized, sha256: input.sha256 });
}

export function acceptHandoffVersion({ compatibility, payload, targetHashes, currentTargetHashes }) {
  if (!sameVersion(targetHashes, currentTargetHashes)) fail("CHECKPOINT_TARGET_BYTES_CHANGED");
  const snapshot = payload.snapshot;
  if (payload.schemaVersion !== 1 || !keys(snapshot, SNAPSHOT_FIELDS) || snapshot.schemaVersion !== 1
    || !keys(snapshot.state, STATE_CHANNELS) || !STATE_CHANNELS.every(channel => Array.isArray(snapshot.state[channel]))) {
    fail("CHECKPOINT_INCOMPATIBLE_STATE_FORMAT");
  }
  const sourceHashes = payload.source?.sourceHashes;
  if (!hash(sourceHashes?.core) || !hash(sourceHashes?.helper)) fail("CHECKPOINT_IDENTITY_MISMATCH");
  if (sameVersion(sourceHashes, targetHashes)) return { mode: "strict-same-sha", stateSemantics: "state-v1" };
  if (!compatibility) fail("CHECKPOINT_IDENTITY_MISMATCH");
  if (payload.compatibilityManifestSha256 !== compatibility.sha256) fail("CHECKPOINT_COMPATIBILITY_MANIFEST_MISMATCH");
  const edgeIndex = compatibility.manifest.edges.findIndex(edge => sameVersion(edge.source, sourceHashes)
    && sameVersion(edge.target, targetHashes) && edge.checkpointSchemaVersion === payload.schemaVersion
    && edge.stateSchemaVersion === snapshot.schemaVersion);
  if (edgeIndex < 0) fail("CHECKPOINT_VERSION_EDGE_NOT_ALLOWED");
  return { mode: "compatible-version", stateSemantics: "state-v1", manifestSha256: compatibility.sha256, edgeIndex };
}
