import crypto from "node:crypto";
import path from "node:path";
import { approvedInnerCandidate, readInnerCandidateRegistry, saveInnerCandidateRegistry } from "./inner-runtime-profile.mjs";
import { fixedHandoffCompatibility } from "./inner-handoff-compatibility.mjs";
import { inspectProxyLiveBundle } from "./proxy-live-code-runtime.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameHashes = (left, right) => Object.keys(left ?? {}).sort().join(",") === "control,core,helper,runner"
  && Object.entries(left).every(([key, hash]) => right?.[key] === hash);
const frozenClone = value => {
  const cloned = structuredClone(value);
  const freeze = entry => {
    if (!entry || typeof entry !== "object") return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(cloned);
};

export function createProxyWholeRuntimeControl(parent, coordinator, profile, instanceId, candidateRoot) {
  const state = { parent, coordinator, profile, instanceId, candidateRoot,
    preparations: new Map(), busy: false, failed: false, selected: null, implementation: null, generation: 0 };
  const methods = ["status", "register", "prepare", "activate", "restore", "recover"];
  const checked = implementation => {
    if (!implementation || methods.some(method => typeof implementation[method] !== "function")) fail("LIVE_WHOLE_IMPLEMENTATION_INVALID");
    return implementation;
  };
  state.implementation = checked(createProxyWholeRuntimeControlImplementation(state));
  const snapshots = new WeakSet();
  const preparations = new WeakSet();
  const snapshot = () => {
    const token = Object.freeze({ state, implementation: state.implementation, generation: state.generation,
      selected: frozenClone(state.selected), failed: state.failed,
      approvals: frozenClone(state.profile.approvedCandidates),
      entries: [...state.preparations].map(([key, value]) => [key, frozenClone(value)]) });
    snapshots.add(token);
    return token;
  };
  const restoreSnapshot = token => {
    state.implementation = token.implementation;
    state.selected = token.selected;
    state.failed = token.failed;
    state.preparations.clear();
    for (const [key, value] of token.entries) state.preparations.set(key, value);
    if (token.approvals) state.profile.approvedCandidates.splice(0, state.profile.approvedCandidates.length, ...token.approvals);
    state.generation += 1;
  };
  const participant = Object.freeze({ id: "whole-runtime-control", stateSchema: "proxy-whole-control-state-v1",
    exportName: "createProxyWholeRuntimeControlImplementation", snapshot,
    prepare(module) {
      if (typeof module?.createProxyWholeRuntimeControlImplementation !== "function") fail("LIVE_WHOLE_IMPLEMENTATION_MISSING");
      const before = { ...state };
      const view = Object.freeze({ ...state, implementation: null,
        parent: Object.freeze({ status: () => frozenClone(state.parent.status()) }),
        coordinator: Object.freeze({ status: () => frozenClone(state.coordinator.status()) }),
        profile: frozenClone(state.profile), selected: frozenClone(state.selected),
        preparations: new Map([...state.preparations].map(([key, value]) => [key, frozenClone(value)])) });
      const implementation = checked(module.createProxyWholeRuntimeControlImplementation(view));
      if (Object.keys(before).some(key => before[key] !== state[key])) fail("LIVE_WHOLE_PREPARATION_DRIFT");
      const candidate = Object.freeze({ state, factory: module.createProxyWholeRuntimeControlImplementation, implementation });
      preparations.add(candidate);
      return candidate;
    },
    activate(candidate) {
      if (!preparations.has(candidate) || candidate.state !== state) fail("LIVE_WHOLE_CANDIDATE_INVALID");
      const token = snapshot();
      try {
        state.implementation = checked(candidate.factory(state));
        state.generation += 1;
      } catch (error) { restoreSnapshot(token); throw error; }
      return token;
    },
    restore(token) {
      if (!snapshots.has(token) || token.state !== state) fail("LIVE_WHOLE_SNAPSHOT_INVALID");
      restoreSnapshot(token);
    },
  });
  return { ...Object.fromEntries(methods.map(method => [method, (...args) => state.implementation[method](...args)])),
    liveCodeParticipant: () => participant,
    attachParent(value) {
      if (state.parent || !value || typeof value.status !== "function") fail("LIVE_WHOLE_PARENT_ALREADY_BOUND");
      state.parent = value;
    } };
}

export function createProxyWholeRuntimeControlImplementation(state) {
  const { coordinator, profile, instanceId, candidateRoot, preparations } = state;
  const parent = () => state.parent;
  const currentWorker = () => {
    const status = coordinator.status();
    const worker = status.workers.find(entry => entry.workerId === status.defaultWorkerId && entry.alive && entry.ready);
    if (!worker) fail("LIVE_WHOLE_WORKER_NOT_READY");
    return worker;
  };
  const sourceSpecification = worker => {
    if (sameHashes(worker.sourceHashes, profile.initial.expectedHashes)) return profile.initial;
    const approval = profile.approvedCandidates?.find(entry => sameHashes(worker.sourceHashes, entry.expectedHashes));
    if (!approval) fail("LIVE_WHOLE_SOURCE_NOT_APPROVED");
    const candidate = approvedInnerCandidate(profile, approval.id);
    return { runnerPath: candidate.runnerPath, expectedHashes: candidate.expectedHashes, candidateApprovalId: candidate.id };
  };
  const guard = input => {
    if (state.busy || state.failed) fail("LIVE_WHOLE_RUNTIME_BUSY_OR_FAILED");
    const status = parent().status();
    if (status.busy || status.failed) fail("LIVE_WHOLE_RUNTIME_BUSY_OR_FAILED");
    if (input.instanceId !== instanceId || input.expectedRevision !== status.revision) fail("LIVE_WHOLE_STALE_BINDING");
  };
  const reverseCompatibility = compatibility => {
    if (!compatibility) return undefined;
    const manifest = { schemaVersion: 1, edges: compatibility.manifest.edges.map(edge => ({ ...edge, source: edge.target, target: edge.source })) };
    return fixedHandoffCompatibility({ manifest, sha256: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
  };
  return {
    status() {
      const status = parent().status();
      return { ...status, instanceId, busy: state.busy || status.busy, failed: state.failed || status.failed,
        preparedWorkers: [...preparations].map(([id, value]) => ({ id, workerId: value.workerId })),
        candidateRegistrySha256: profile.stateRoot ? readInnerCandidateRegistry(profile)?.sha256 ?? null : null,
        approvedCandidateIds: (profile.approvedCandidates ?? []).map(candidate => candidate.id),
        controlGeneration: state.generation,
        modelWorker: state.selected ? { workerId: currentWorker().workerId, sourceHashes: currentWorker().sourceHashes } : null };
    },
    register(input) {
      guard(input);
      if (preparations.size || parent().status().prepared?.length) fail("LIVE_WHOLE_PREPARATIONS_PENDING");
      const allowed = ["instanceId", "expectedRevision", "expectedRegistrySha256", "manifestPath", "manifestSha256", "candidate"];
      if (!input.candidate || Object.keys(input).some(key => !allowed.includes(key))
        || Object.keys(input.candidate).sort().join(",") !== "expectedHashes,id,installationRoot,runnerPath") fail("LIVE_WHOLE_REGISTRATION_INVALID");
      const candidate = approvedInnerCandidate({ ...profile, approvedCandidates: [input.candidate] }, input.candidate.id);
      const bundle = inspectProxyLiveBundle(candidateRoot, input.manifestPath, input.manifestSha256);
      const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
        helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
      if (path.dirname(candidate.runnerPath) !== path.dirname(input.manifestPath)
        || Object.entries(names).some(([key, name]) => !bundle.manifest.files.some(file => file.path === name
          && file.sha256 === candidate.expectedHashes[key]))) fail("LIVE_WHOLE_SOURCE_PACKAGE_MISMATCH");
      const existing = profile.approvedCandidates ?? [];
      const duplicate = existing.find(entry => entry.id === candidate.id);
      if (duplicate && (duplicate.installationRoot !== candidate.installationRoot || duplicate.runnerPath !== candidate.runnerPath
        || !sameHashes(duplicate.expectedHashes, candidate.expectedHashes))) fail("LIVE_WHOLE_APPROVAL_ID_CONFLICT");
      if ((readInnerCandidateRegistry(profile)?.sha256 ?? null) !== input.expectedRegistrySha256) fail("INNER_PROFILE_CANDIDATE_REGISTRY_CHANGED");
      const commit = () => {
        const next = duplicate ? [...existing] : [...existing, { id: candidate.id, installationRoot: candidate.installationRoot,
          runnerPath: candidate.runnerPath, expectedHashes: candidate.expectedHashes }];
        const protectedIds = new Set(coordinator.status().workers.filter(worker => worker.alive)
          .map(worker => existing.find(entry => sameHashes(entry.expectedHashes, worker.sourceHashes))?.id).filter(Boolean));
        if (state.selected?.sourceSpec.candidateApprovalId) protectedIds.add(state.selected.sourceSpec.candidateApprovalId);
        if (state.selected?.previousSelection) protectedIds.add(state.selected.previousSelection.candidateId);
        const durableSelection = readInnerCandidateRegistry(profile)?.selection;
        if (durableSelection) protectedIds.add(durableSelection.candidateId);
        while (next.length > 4) {
          const removable = next.findIndex(entry => entry.id !== candidate.id && !protectedIds.has(entry.id));
          if (removable < 0) fail("LIVE_WHOLE_APPROVALS_IN_USE");
          next.splice(removable, 1);
        }
        if (!Array.isArray(profile.approvedCandidates) || Object.isFrozen(profile.approvedCandidates)) fail("LIVE_WHOLE_APPROVAL_ARRAY_REQUIRED");
        const registrySha256 = saveInnerCandidateRegistry(profile, next, input.expectedRegistrySha256);
        profile.approvedCandidates.splice(0, profile.approvedCandidates.length, ...next);
        return { ...this.status(), registeredCandidateId: candidate.id, candidateRegistrySha256: registrySha256 };
      };
      try { return commit(); }
      catch (error) {
        if (error.code !== "LIVE_WHOLE_APPROVALS_IN_USE") throw error;
        const shared = coordinator.liveCodeParticipant?.().snapshot().state;
        if (typeof shared?.dispatch !== "function") throw error;
        state.busy = true;
        return Promise.resolve().then(() => shared.dispatch("reclaimRetiredWorkers")).then(() => {
          state.busy = false;
          guard(input);
          return commit();
        }).finally(() => { state.busy = false; });
      }
    },
    async prepare(input) {
      guard(input);
      if (input.workerCandidateId === undefined) fail("LIVE_WHOLE_WORKER_CANDIDATE_REQUIRED");
      state.busy = true;
      let prepared;
      let worker;
      try {
        const { workerCandidateId, compatibility: requestedCompatibility, ...parentInput } = input;
        const candidate = approvedInnerCandidate(profile, workerCandidateId);
        const bundle = inspectProxyLiveBundle(candidateRoot, input.manifestPath, input.manifestSha256);
        const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
          helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
        if (path.dirname(candidate.runnerPath) !== path.dirname(input.manifestPath)
          || Object.entries(names).some(([key, name]) => !bundle.manifest.files.some(file =>
            file.path === name && file.sha256 === candidate.expectedHashes[key]))) fail("LIVE_WHOLE_SOURCE_PACKAGE_MISMATCH");
        const compatibility = fixedHandoffCompatibility(requestedCompatibility) ?? undefined;
        if ((profile.initial.expectedHashes.core !== candidate.expectedHashes.core
          || profile.initial.expectedHashes.helper !== candidate.expectedHashes.helper)
          && !compatibility?.manifest.edges.some(edge => edge.source.core === profile.initial.expectedHashes.core
            && edge.source.helper === profile.initial.expectedHashes.helper && edge.target.core === candidate.expectedHashes.core
            && edge.target.helper === candidate.expectedHashes.helper)) fail("LIVE_WHOLE_BOOT_COMPATIBILITY_REQUIRED");
        const registry = profile.stateRoot ? readInnerCandidateRegistry(profile) : null;
        const source = currentWorker();
        const sourceSpec = sourceSpecification(source);
        prepared = parent().prepare(parentInput);
        worker = await coordinator.prepareCandidate({ runnerPath: candidate.runnerPath,
          expectedHashes: candidate.expectedHashes, candidateApprovalId: candidate.id });
        if (currentWorker().workerId !== source.workerId) fail("LIVE_WHOLE_SELECTION_CHANGED");
        preparations.set(prepared.id, { revision: prepared.revision, sourceWorkerId: source.workerId, sourceSpec,
          workerId: worker.workerId, compatibility, candidateApprovalId: candidate.id,
          manifestPath: input.manifestPath, manifestSha256: input.manifestSha256,
          registrySha256: registry?.sha256 ?? null, previousSelection: registry?.selection ?? null });
        while (preparations.size > 4) preparations.delete(preparations.keys().next().value);
        return { ...prepared, workerId: worker.workerId };
      } catch (error) {
        if (prepared) parent().discard({ instanceId, expectedRevision: prepared.revision, preparationId: prepared.id });
        if (worker) await coordinator.discardCandidate({ workerId: worker.workerId });
        throw error;
      } finally { state.busy = false; }
    },
    async activate(input) {
      guard(input);
      const candidate = preparations.get(input.preparationId);
      if (!candidate) fail("LIVE_WHOLE_PREPARATION_REQUIRED");
      if (candidate.revision !== input.expectedRevision) fail("LIVE_WHOLE_STALE_PREPARATION");
      if (currentWorker().workerId !== candidate.sourceWorkerId) fail("LIVE_WHOLE_SELECTION_CHANGED");
      if (profile.stateRoot && (readInnerCandidateRegistry(profile)?.sha256 ?? null) !== candidate.registrySha256) fail("LIVE_WHOLE_REGISTRY_CHANGED");
      const checkpoint = parent().checkpoint({ instanceId, expectedRevision: input.expectedRevision });
      state.busy = true;
      let activation;
      let parentActivated = false;
      try {
        activation = await coordinator.activate({ candidateId: candidate.workerId, compatibility: candidate.compatibility });
        const result = parent().activate(input);
        parentActivated = true;
        if (profile.stateRoot) saveInnerCandidateRegistry(profile, profile.approvedCandidates, candidate.registrySha256,
          { candidateId: candidate.candidateApprovalId, manifestPath: candidate.manifestPath,
            manifestSha256: candidate.manifestSha256, compatibility: candidate.compatibility ?? null });
        state.selected = { ...candidate, activationId: activation.activationId };
        preparations.clear();
        return { ...result, modelWorker: activation };
      } catch (error) {
        if (parentActivated) {
          try { parent().rollbackCheckpoint({ instanceId, expectedRevision: parent().status().revision }, checkpoint); }
          catch (rollbackError) { state.failed = true; throw Object.assign(error, { recoveryError: rollbackError.code ?? rollbackError.message }); }
        }
        if (activation) {
          try { coordinator.rollbackActivation({ activationId: activation.activationId }); }
          catch (rollbackError) { state.failed = true; throw Object.assign(error, { recoveryError: rollbackError.code ?? rollbackError.message }); }
        }
        preparations.clear();
        parent().discard({ instanceId, expectedRevision: parent().status().revision, preparationId: input.preparationId });
        if (!activation) await coordinator.discardCandidate({ workerId: candidate.workerId });
        throw error;
      } finally { state.busy = false; }
    },
    async restore(input) {
      guard(input);
      if (!state.selected) fail("LIVE_WHOLE_RESTORE_UNAVAILABLE");
      const checkpoint = parent().checkpoint({ instanceId, expectedRevision: input.expectedRevision });
      const registry = profile.stateRoot ? readInnerCandidateRegistry(profile) : null;
      const selection = state.selected;
      state.busy = true;
      let fresh;
      let activation;
      let parentRestored = false;
      try {
        fresh = await coordinator.prepareCandidate(selection.sourceSpec);
        activation = await coordinator.activate({ candidateId: fresh.workerId, compatibility: reverseCompatibility(selection.compatibility) });
        const result = parent().restore(input);
        parentRestored = true;
        if (profile.stateRoot) saveInnerCandidateRegistry(profile, profile.approvedCandidates,
          registry?.sha256 ?? null, selection.previousSelection);
        state.selected = null;
        preparations.clear();
        return { ...result, modelWorker: { ...activation, originalBytes: true, freshWorker: true } };
      } catch (error) {
        try {
          if (parentRestored) parent().rollbackCheckpoint({ instanceId, expectedRevision: parent().status().revision }, checkpoint);
          if (activation) coordinator.rollbackActivation({ activationId: activation.activationId });
          if (fresh && !activation) await coordinator.discardCandidate({ workerId: fresh.workerId });
          state.selected = selection;
          preparations.clear();
        } catch (rollbackError) { state.failed = true; throw Object.assign(error, { recoveryError: rollbackError.code ?? rollbackError.message }); }
        throw error;
      }
      finally { state.busy = false; }
    },
    async recover() {
      const registry = profile.stateRoot ? readInnerCandidateRegistry(profile) : null;
      if (!registry?.selection || state.selected) return this.status();
      const selection = registry.selection;
      const binding = { instanceId, expectedRevision: parent().status().revision };
      const prepared = await this.prepare({ ...binding, manifestPath: selection.manifestPath,
        manifestSha256: selection.manifestSha256, workerCandidateId: selection.candidateId,
        ...(selection.compatibility ? { compatibility: selection.compatibility } : {}) });
      preparations.get(prepared.id).previousSelection = null;
      return this.activate({ ...binding, preparationId: prepared.id });
    },
  };
}
