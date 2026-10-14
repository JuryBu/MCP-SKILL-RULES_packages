import crypto from "node:crypto";
import fs from "node:fs";
import { inspectProxyLiveBundle, loadProxyLiveCompiledBundle } from "./proxy-live-code-runtime.mjs";

const participantIds = Object.freeze(["outer-proxy", "inner-coordinator", "managed-session", "proxy-service"]);
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const synchronous = value => {
  if (value && typeof value.then === "function") fail("LIVE_PARENT_ASYNC_PARTICIPANT_REFUSED");
  return value;
};

export function createProxyParentCodeRuntime(participants, options = {}) {
  const requiredIds = [...participantIds, ...(Array.isArray(participants) && participants.some(participant => participant?.id === "whole-runtime-control")
    ? ["whole-runtime-control"] : [])];
  if (!Array.isArray(participants) || participants.length !== requiredIds.length
    || new Set(participants.map(participant => participant?.id)).size !== requiredIds.length
    || requiredIds.some(id => !participants.some(participant => participant?.id === id))) {
    fail("LIVE_PARENT_PARTICIPANTS_INCOMPLETE");
  }
  const ordered = requiredIds.map(id => participants.find(participant => participant.id === id));
  if (ordered.some(participant => typeof participant.stateSchema !== "string"
    || typeof participant.exportName !== "string"
    || ["snapshot", "prepare", "activate", "restore"].some(method => typeof participant[method] !== "function"
      || participant[method].constructor.name === "AsyncFunction"))) {
    fail("LIVE_PARENT_PARTICIPANT_INVALID");
  }
  if (typeof options.instanceId !== "string" || !options.instanceId) fail("LIVE_PARENT_INSTANCE_REQUIRED");
  const root = fs.realpathSync(options.candidateRoot);
  const preparations = new Map();
  let revision = 0;
  let busy = false;
  let failed = false;
  let selected = { id: "original", version: "original", manifestSha256: null };
  let previous = null;
  const checkpoints = new WeakSet();
  const snapshotAll = () => ordered.map(participant => synchronous(participant.snapshot()));
  const restoreAll = snapshots => {
    const failures = [];
    for (let index = ordered.length - 1; index >= 0; index--) {
      try { synchronous(ordered[index].restore(snapshots[index])); }
      catch (error) { failures.push({ id: ordered[index].id, code: error.code ?? error.message }); }
    }
    if (failures.length) {
      failed = true;
      fail("LIVE_PARENT_ROLLBACK_FAILED", failures);
    }
  };
  const unchanged = expected => ordered.every((participant, index) => {
    const current = synchronous(participant.snapshot());
    return current.state === expected[index].state && current.implementation === expected[index].implementation
      && current.generation === expected[index].generation;
  });
  const bind = input => {
    if (failed) fail("LIVE_PARENT_RECOVERY_REQUIRED");
    if (busy) fail("LIVE_PARENT_TRANSACTION_ACTIVE");
    if (input?.instanceId !== options.instanceId || input.expectedRevision !== revision) fail("LIVE_PARENT_STALE_IDENTITY_OR_REVISION");
  };
  const validateActive = () => synchronous(options.validateActive?.());
  const status = () => ({ stateSchema: "proxy-live-parent-v1", revision, busy, failed,
    selected: { ...selected }, previous: previous ? { ...previous.selected } : null,
    participants: ordered.map(participant => ({ id: participant.id, stateSchema: participant.stateSchema })),
    prepared: [...preparations.values()].map(entry => ({ id: entry.id, version: entry.version })) });
  return {
    status,
    checkpoint(input) {
      bind(input);
      const token = Object.freeze({ snapshots: snapshotAll(), selected, previous, revision });
      checkpoints.add(token);
      return token;
    },
    rollbackCheckpoint(input, token) {
      bind(input);
      if (!checkpoints.has(token)) fail("LIVE_PARENT_CHECKPOINT_INVALID");
      const retained = snapshotAll();
      busy = true;
      try {
        try { restoreAll(token.snapshots); validateActive(); }
        catch (error) { restoreAll(retained); throw error; }
        selected = token.selected;
        previous = token.previous;
        preparations.clear();
        revision++;
        return { ...status(), busy: false };
      } finally { busy = false; }
    },
    discard(input) {
      bind(input);
      const removed = preparations.delete(input.preparationId);
      return { ...status(), discarded: removed };
    },
    prepare(input) {
      bind(input);
      if (preparations.size >= 4) fail("LIVE_PARENT_PREPARATION_LIMIT");
      busy = true;
      try {
        const { manifest, module } = loadProxyLiveCompiledBundle(root, input.manifestPath, input.manifestSha256);
        const snapshots = snapshotAll();
        let candidates;
        try {
          candidates = ordered.map(participant => synchronous(participant.prepare(module)));
          if (!unchanged(snapshots)) fail("LIVE_PARENT_PREPARE_MUTATED_IMPLEMENTATION");
        } catch (error) {
          restoreAll(snapshots);
          throw error;
        }
        const entry = { id: crypto.randomUUID(), version: manifest.version,
          manifestPath: input.manifestPath, manifestSha256: input.manifestSha256,
          revision, snapshots, candidates };
        preparations.set(entry.id, entry);
        return { id: entry.id, version: entry.version, revision, manifestSha256: entry.manifestSha256 };
      } finally { busy = false; }
    },
    activate(input) {
      bind(input);
      const candidate = preparations.get(input.preparationId);
      if (!candidate || candidate.revision !== revision || !unchanged(candidate.snapshots)) fail("LIVE_PARENT_PREPARATION_STALE");
      inspectProxyLiveBundle(root, candidate.manifestPath, candidate.manifestSha256);
      const snapshots = snapshotAll();
      busy = true;
      const startedAt = performance.now();
      try {
        try {
          for (let index = 0; index < ordered.length; index++) synchronous(ordered[index].activate(candidate.candidates[index]));
          validateActive();
        } catch (error) {
          restoreAll(snapshots);
          preparations.clear();
          throw error;
        }
        previous = { selected, snapshots };
        selected = { id: candidate.id, version: candidate.version, manifestSha256: candidate.manifestSha256 };
        preparations.clear();
        revision++;
        return { ...status(), busy: false, actualMs: performance.now() - startedAt };
      } finally { busy = false; }
    },
    restore(input) {
      bind(input);
      if (!previous) fail("LIVE_PARENT_RESTORE_UNAVAILABLE");
      const retained = snapshotAll();
      busy = true;
      try {
        try { restoreAll(previous.snapshots); validateActive(); }
        catch (error) { restoreAll(retained); throw error; }
        const discarded = { selected, snapshots: retained };
        selected = previous.selected;
        previous = discarded;
        preparations.clear();
        revision++;
        return { ...status(), busy: false };
      } finally { busy = false; }
    },
  };
}
