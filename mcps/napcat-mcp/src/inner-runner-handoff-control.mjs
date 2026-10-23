import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fixedHandoffCompatibility, acceptHandoffVersion } from "./inner-handoff-compatibility.mjs";
import { validateInnerMigrationPlan } from "./inner-migration-plan.mjs";
import { validateInnerRuntimeProfile } from "./inner-runtime-profile.mjs";
import { signRecoveryEnvelope, canContinueRecovery } from "./model-recovery-notifications.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";

export const HANDOFF_CHANNEL = "inner-runner-handoff-v1";
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024 + 16 * 1024;
const MAX_REQUESTS = 4096;
const MAX_THREADS = 128;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const validIdentity = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const validThread = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\u0000");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function isolatedHandoffConfiguration({ environment = process.env, ipc = process, stateRoot, host, upstreamOrigin }) {
  if (typeof ipc.send !== "function" || !ipc.connected || !environment.CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL) return null;
  let config;
  try { config = JSON.parse(environment.CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL); }
  catch { fail("HANDOFF_INVALID_CONFIGURATION"); }
  if (config?.schemaVersion !== 1 || !["isolated", "production"].includes(config.mode) || !validIdentity(config.ownerId)
    || typeof config.capability !== "string" || !/^[0-9a-f]{64}$/u.test(config.capability)
    || typeof config.checkpointRoot !== "string" || !path.isAbsolute(config.checkpointRoot)
    || !environment.CODEX_MODEL_STREAM_PROXY_STATE_ROOT || !environment.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN
    || host !== "127.0.0.1") fail("HANDOFF_INVALID_CONFIGURATION");
  if (config.mode === "production") {
    const runtimeProfile = validateInnerRuntimeProfile(config.runtimeProfile, { workerStateRoot: stateRoot, host, upstreamOrigin });
    if (runtimeProfile.ownerId !== config.ownerId || runtimeProfile.nativeSourceId !== config.nativeSourceId
      || runtimeProfile.checkpointRoot !== config.checkpointRoot || environment.CODEX_HOME !== runtimeProfile.codexHome
      || environment.CODEX_MODEL_STREAM_PROXY_STATE_ROOT !== stateRoot
      || environment.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN !== upstreamOrigin) fail("HANDOFF_PROFILE_MISMATCH");
    return Object.freeze({ ...config, checkpointRoot: runtimeProfile.checkpointRoot,
      runtimeProfile, compatibility: fixedHandoffCompatibility(config.compatibility) });
  }
  if (config.runtimeProfile) fail("HANDOFF_PROFILE_MODE_MISMATCH");
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password) {
    fail("HANDOFF_LOOPBACK_REQUIRED");
  }
  const checkpointRoot = fs.realpathSync(config.checkpointRoot);
  if (!inside(fs.realpathSync(os.tmpdir()), checkpointRoot)) fail("HANDOFF_TEMP_ROOT_REQUIRED");
  if (!inside(checkpointRoot, path.resolve(stateRoot))) fail("HANDOFF_STATE_OUTSIDE_OWNED_ROOT");
  let existingParent = path.resolve(stateRoot);
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const resolvedParent = fs.realpathSync(existingParent);
  if (resolvedParent !== checkpointRoot && !inside(checkpointRoot, resolvedParent)) fail("HANDOFF_STATE_OUTSIDE_OWNED_ROOT");
  return Object.freeze({ ...config, checkpointRoot, compatibility: fixedHandoffCompatibility(config.compatibility) });
}

export function attachInnerRunnerHandoffControl({ config, proxy, instanceToken, runnerPath, onEvent, shutdown, isStopping, ipc = process }) {
  if (!config) return null;
  let compatibility = fixedHandoffCompatibility(config.compatibility ?? undefined);
  let migrationPlan = null;
  let migrationGeneration = 0;
  const currentTargetHashes = () => ({
    core: digest(fs.readFileSync(new URL("./codex-model-stream-proxy.mjs", import.meta.url))),
    helper: digest(fs.readFileSync(new URL("./thread-recovery-handoff.mjs", import.meta.url))),
  });
  const sourceHashes = {
    runner: digest(fs.readFileSync(runnerPath)),
    ...currentTargetHashes(),
    control: digest(fs.readFileSync(new URL(import.meta.url))),
  };
  const identity = { pid: process.pid, instanceToken, sourceHashes };
  const nativeTurns = new Map();
  const terminalTurns = new Map();
  const requestIds = new Set();
  const prepared = new Map();
  const key = Buffer.from(config.capability, "hex");
  const mac = value => crypto.createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
  let lastSequence = 0;
  let lastCoordinatorRequest = 0;
  let closed = false;
  let pendingReplies = 0;
  const recoveryActions = new Set();
  const findNativeTurn = threadId => nativeTurns.get(threadId) ?? terminalTurns.get(threadId);
  const pinnedThread = threadId => prepared.has(threadId)
    || (migrationPlan?.threadId === threadId && migrationPlan.expiresAt > Date.now());

  function reserveNativeSlot(threadId) {
    if (nativeTurns.size < MAX_THREADS) return;
    const status = proxy.status();
    if (!status.running || status.draining) fail("HANDOFF_THREAD_LIMIT");
    const retired = [...nativeTurns].filter(([identity, native]) => native.phase === "terminal" && !pinnedThread(identity))
      .sort((first, second) => first[1].sequence - second[1].sequence)[0];
    if (!retired) fail("HANDOFF_THREAD_LIMIT");
    if (terminalTurns.has(threadId)) terminalTurns.delete(threadId);
    else if (terminalTurns.size >= MAX_THREADS) {
      const expired = [...terminalTurns.keys()].find(identity => !pinnedThread(identity));
      if (!expired) fail("HANDOFF_THREAD_LIMIT");
      terminalTurns.delete(expired);
    }
    nativeTurns.delete(retired[0]);
    terminalTurns.set(...retired);
  }

  function send(message) {
    if (!ipc.connected) return;
    if (pendingReplies >= 16) {
      onEvent({ type: "handoff_ipc_backpressure" });
      void shutdown("handoff_ipc_backpressure", 1);
      return;
    }
    pendingReplies += 1;
    try {
      ipc.send({ channel: HANDOFF_CHANNEL, ...identity, ...message }, error => {
        pendingReplies -= 1;
        if (error && !closed) {
          onEvent({ type: "handoff_ipc_send_failed", code: error.code ?? "IPC_SEND_FAILED" });
          void shutdown("handoff_ipc_send_failed", 1);
        }
      });
    } catch (error) {
      pendingReplies -= 1;
      onEvent({ type: "handoff_ipc_send_failed", code: error.code ?? "IPC_SEND_FAILED" });
      void shutdown("handoff_ipc_send_failed", 1);
    }
  }

  function handoffBoundary(threadId, live = false) {
    if (!validThread(threadId)) fail("HANDOFF_INVALID_THREAD");
    const native = findNativeTurn(threadId);
    if (live !== true && live !== false) fail("HANDOFF_INVALID_MODE");
    if (live && !migrationPlan) fail("HANDOFF_LIVE_PLAN_REQUIRED");
    if (native?.phase !== (live ? "active" : "terminal")) fail(live ? "NATIVE_TURN_NOT_ACTIVE" : "NATIVE_TURN_NOT_TERMINAL");
    if (!proxy.status().running || proxy.status().draining || (!live && proxy.status().activeRequests !== 0)) fail("HANDOFF_HTTP_NOT_IDLE");
    return native;
  }

  function checkpointPath(fileName) {
    if (typeof fileName !== "string" || !/^inner-runner-[a-zA-Z0-9_.-]{1,100}\.json$/u.test(fileName)) fail("CHECKPOINT_INVALID_NAME");
    return path.join(config.checkpointRoot, fileName);
  }

  function prepare(message) {
    const native = handoffBoundary(message.threadId, message.live);
    if (migrationPlan) validateInnerMigrationPlan(migrationPlan, { identity, role: "source", threadId: message.threadId });
    const filePath = checkpointPath(message.fileName);
    if (fs.existsSync(filePath)) fail("CHECKPOINT_EXISTS");
    const snapshot = proxy.prepareThreadHandoff(message.threadId);
    const payload = { schemaVersion: 1, ownerId: config.ownerId, source: identity,
      ...(message.live ? { live: true, native } : { terminal: native }), snapshotSha256: digest(JSON.stringify(snapshot)), snapshot,
      ...(compatibility ? { compatibilityManifestSha256: compatibility.sha256 } : {}),
      ...(migrationPlan ? { migrationPlanSha256: digest(JSON.stringify(migrationPlan)) } : {}) };
    const bytes = Buffer.from(JSON.stringify({ payload, signature: mac(payload) }));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.pending`;
    let descriptor;
    try {
      if (bytes.length > MAX_CHECKPOINT_BYTES) fail("CHECKPOINT_TOO_LARGE");
      descriptor = fs.openSync(temporaryPath, "wx");
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporaryPath); } catch {}
      proxy.cancelThreadHandoff(message.threadId, snapshot.token);
      throw error;
    }
    prepared.set(message.threadId, snapshot.token);
    return { threadId: snapshot.threadId, token: snapshot.token, fileName: message.fileName,
      filePath, sha256: digest(bytes), bytes: bytes.length, ...(message.live ? { live: true, native } : { terminal: native }) };
  }

  function accept(message) {
    const native = handoffBoundary(message.threadId, message.live);
    const filePath = fs.realpathSync(checkpointPath(message.fileName));
    if (!inside(config.checkpointRoot, filePath)) fail("CHECKPOINT_OUTSIDE_OWNED_ROOT");
    const descriptor = fs.openSync(filePath, "r");
    let bytes;
    try {
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_CHECKPOINT_BYTES) fail("CHECKPOINT_TOO_LARGE");
      const buffer = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset > MAX_CHECKPOINT_BYTES) fail("CHECKPOINT_TOO_LARGE");
      bytes = buffer.subarray(0, offset);
    } finally {
      fs.closeSync(descriptor);
    }
    if (typeof message.sha256 !== "string" || digest(bytes) !== message.sha256) fail("CHECKPOINT_HASH_MISMATCH");
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); }
    catch { fail("CHECKPOINT_INVALID_JSON"); }
    const payload = envelope?.payload;
    if (!payload || typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.signature)
      || !crypto.timingSafeEqual(Buffer.from(mac(payload), "hex"), Buffer.from(envelope.signature, "hex"))) fail("CHECKPOINT_AUTHENTICATION_FAILED");
    const checkpointNative = message.live ? payload.native : payload.terminal;
    if (Boolean(payload.live) !== Boolean(message.live)
      || payload.ownerId !== config.ownerId || !validIdentity(message.sourceInstanceToken)
      || !Number.isSafeInteger(payload.source?.pid) || payload.source.pid < 1
      || payload.source?.instanceToken !== message.sourceInstanceToken || payload.source.instanceToken === instanceToken
      || payload.snapshot?.threadId !== message.threadId
      || payload.snapshotSha256 !== digest(JSON.stringify(payload.snapshot))
      || checkpointNative?.phase !== native.phase || checkpointNative.turnId !== native.turnId
      || checkpointNative.status !== native.status) fail("CHECKPOINT_IDENTITY_MISMATCH");
    if (migrationPlan) {
      validateInnerMigrationPlan(migrationPlan, { identity, role: "target", threadId: message.threadId });
      if (payload.migrationPlanSha256 !== digest(JSON.stringify(migrationPlan))
        || payload.source.pid !== migrationPlan.source.pid
        || payload.source.instanceToken !== migrationPlan.source.instanceToken) fail("CHECKPOINT_MIGRATION_PLAN_MISMATCH");
    } else if (payload.migrationPlanSha256) fail("CHECKPOINT_MIGRATION_PLAN_MISMATCH");
    const versionAcceptance = acceptHandoffVersion({ compatibility, payload, targetHashes: sourceHashes,
      currentTargetHashes: currentTargetHashes() });
    const accepted = proxy.acceptThreadHandoff(payload.snapshot);
    return { ...accepted, readPath: filePath, readBytes: bytes.length, readSha256: digest(bytes), source: payload.source,
      versionAcceptance };
  }

  function execute(message) {
    if (message.method === "bindRecovery") {
      const native = nativeTurns.get(message.threadId);
      if (native?.phase !== "active" || native.turnId !== message.turnId || native.connectionGeneration
        || !validIdentity(message.connectionGeneration)) fail("RECOVERY_BINDING_INVALID");
      native.connectionGeneration = message.connectionGeneration;
      return { bound: true };
    }
    if (message.method === "continueHttp") {
      const native = nativeTurns.get(message.threadId);
      const current = proxy.recoveryStates?.().find(event => event.threadId === message.threadId
        && event.turnId === message.turnId && event.requestId === message.recoveryRequestId);
      const actionKey = JSON.stringify([message.recoveryRequestId, message.sequence]);
      if (native?.phase !== "active" || native.turnId !== message.turnId
        || native.connectionGeneration !== message.connectionGeneration || !validIdentity(message.connectionGeneration)
        || message.producerId !== instanceToken || message.producerPid !== process.pid
        || message.nativeSourceId !== config.nativeSourceId || current?.sequence !== message.sequence
        || !canContinueRecovery(current) || recoveryActions.has(actionKey)) fail("RECOVERY_ACTION_STALE_OR_DISABLED");
      if (recoveryActions.size >= MAX_REQUESTS) fail("RECOVERY_ACTION_LIMIT");
      recoveryActions.add(actionKey);
      return proxy.continueWithHttp({ threadId: message.threadId, turnId: message.turnId, requestId: message.recoveryRequestId });
    }
    if (message.method === "check") {
      const status = proxy.status();
      const native = findNativeTurn(message.threadId) ?? null;
      let historicalRecovery;
      if (message.inspectExpired === true && !native && validThread(message.threadId)
        && status.running && !status.draining && status.activeRequests === 0 && !pinnedThread(message.threadId)) {
        const snapshot = proxy.prepareThreadHandoff(message.threadId);
        try {
          const channels = ["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"];
          if (snapshot.schemaVersion !== 1 || snapshot.threadId !== message.threadId || !snapshot.state
            || Object.keys(snapshot.state).sort().join(",") !== [...channels].sort().join(",")
            || channels.some(channel => !Array.isArray(snapshot.state[channel]))) fail("RECOVERY_HISTORICAL_STATE_UNVERIFIED");
          const recoveryEntries = channels.reduce((total, channel) => total + snapshot.state[channel].length, 0);
          let operationEntries = 0;
          if (snapshot.operationState !== undefined) {
            if (snapshot.operationState?.threadHash !== digest(message.threadId)) fail("RECOVERY_HISTORICAL_STATE_UNVERIFIED");
            const verified = createModelOperationLedger({ state: snapshot.operationState }).exportThread(message.threadId);
            operationEntries = verified.entries.length;
            if (operationEntries !== snapshot.operationState.entries.length) fail("RECOVERY_HISTORICAL_STATE_UNVERIFIED");
          } else if (status.managedRecovery || status.operationLedger) fail("RECOVERY_HISTORICAL_STATE_UNVERIFIED");
          const entries = recoveryEntries + operationEntries;
          historicalRecovery = { threadId: message.threadId, empty: entries === 0, entries,
            recoveryEntries, operationEntries, operationStateVerified: true,
            capturedAt: snapshot.capturedAt, snapshotSha256: digest(JSON.stringify(snapshot)) };
        } finally { proxy.cancelThreadHandoff(message.threadId, snapshot.token); }
      }
      return { status, native, nativeHistory: { retained: nativeTurns.size, archived: terminalTurns.size, limit: MAX_THREADS },
        prepared: prepared.has(message.threadId), ...(historicalRecovery ? { historicalRecovery } : {}) };
    }
    if (message.method === "authorizeMigration") {
      if (config.allowRuntimeCompatibility !== true) fail("HANDOFF_RUNTIME_PLAN_DISABLED");
      if (prepared.size !== 0) fail("HANDOFF_THREAD_FROZEN");
      const plan = validateInnerMigrationPlan(message.plan, { identity, role: message.role, minimumGeneration: migrationGeneration });
      migrationPlan = plan;
      compatibility = fixedHandoffCompatibility(plan.compatibility ?? undefined);
      migrationGeneration = plan.generation;
      return { generation: plan.generation, sha256: digest(JSON.stringify(plan)), expiresAt: plan.expiresAt };
    }
    if (message.method === "nativeTurn" || message.method === "restoreTerminal") {
      const event = message.event;
      const restoring = message.method === "restoreTerminal";
      if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence
        || !validThread(event.threadId) || !validThread(event.turnId)
        || !["active", "terminal"].includes(event.phase)) fail("HANDOFF_INVALID_NATIVE_EVENT");
      const previous = findNativeTurn(event.threadId);
      if (prepared.has(event.threadId)) fail("HANDOFF_THREAD_FROZEN");
      if (restoring) {
        validateInnerMigrationPlan(migrationPlan, { identity, role: "source", threadId: event.threadId });
        if (event.phase !== "terminal" || previous || !["completed", "failed", "interrupted"].includes(event.status)) fail("HANDOFF_INVALID_NATIVE_EVENT");
        const status = proxy.status();
        if (!status.running || status.draining || status.activeRequests !== 0) fail("HANDOFF_HTTP_NOT_IDLE");
      } else if (event.phase === "terminal" && (previous?.phase !== "active" || previous.turnId !== event.turnId
        || !["completed", "failed", "interrupted"].includes(event.status))) fail("HANDOFF_INVALID_NATIVE_EVENT");
      if (event.phase === "active" && previous?.phase === "active") fail("HANDOFF_INVALID_NATIVE_EVENT");
      if (!nativeTurns.has(event.threadId)) reserveNativeSlot(event.threadId);
      terminalTurns.delete(event.threadId);
      nativeTurns.set(event.threadId, { phase: event.phase, turnId: event.turnId, sequence: event.sequence,
        ...(event.connectionGeneration ? { connectionGeneration: event.connectionGeneration } : {}),
        ...(event.phase === "terminal" ? { status: event.status } : {}) });
      lastSequence = event.sequence;
      return { recorded: true, sequence: lastSequence };
    }
    if (message.method === "prepare") return prepare(message);
    if (message.method === "cancel") {
      proxy.cancelThreadHandoff(message.threadId, message.token);
      prepared.delete(message.threadId);
      return { cancelled: true, threadId: message.threadId };
    }
    if (message.method === "accept") return accept(message);
    if (message.method === "shutdown") return { shuttingDown: true };
    fail("HANDOFF_UNKNOWN_METHOD");
  }

  function receive(message) {
    if (message?.channel !== HANDOFF_CHANNEL) return;
    const requestId = validIdentity(message.requestId) ? message.requestId : null;
    try {
      if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) fail("HANDOFF_MESSAGE_TOO_LARGE");
      if (!requestId) fail("HANDOFF_INVALID_REQUEST_ID");
      if (message.instanceToken !== instanceToken || message.ownerId !== config.ownerId
        || typeof message.capability !== "string" || !/^[0-9a-f]{64}$/u.test(message.capability)
        || !crypto.timingSafeEqual(Buffer.from(message.capability, "hex"), key)) fail("HANDOFF_UNAUTHORIZED");
      if (closed || isStopping()) fail("HANDOFF_STOPPING");
      const coordinatorRequest = /^coordinator-([1-9][0-9]*)$/u.exec(requestId);
      if (coordinatorRequest) {
        const sequence = Number(coordinatorRequest[1]);
        if (!Number.isSafeInteger(sequence)) fail("HANDOFF_INVALID_REQUEST_ID");
        if (sequence <= lastCoordinatorRequest) fail("HANDOFF_REQUEST_REPLAY");
        lastCoordinatorRequest = sequence;
      } else {
        if (requestIds.has(requestId)) fail("HANDOFF_REQUEST_REPLAY");
        if (requestIds.size >= MAX_REQUESTS) fail("HANDOFF_REQUEST_LIMIT");
        requestIds.add(requestId);
      }
      const result = execute(message);
      send({ requestId, ok: true, result });
      onEvent({ type: "handoff_control_result", requestId, method: message.method, ok: true });
      if (message.method === "shutdown") void shutdown("handoff_ipc_shutdown");
    } catch (error) {
      send({ requestId, ok: false, error: { code: error.code ?? "HANDOFF_FAILED" } });
      onEvent({ type: "handoff_control_result", requestId, method: typeof message.method === "string" ? message.method.slice(0, 64) : null,
        ok: false, code: error.code ?? "HANDOFF_FAILED" });
    }
  }
  const disconnected = () => { void shutdown("handoff_ipc_disconnect"); };
  ipc.on("message", receive);
  ipc.once("disconnect", disconnected);
  send({ event: "ready", ownerId: config.ownerId, status: proxy.status() });
  return {
    publishRecovery(event) {
      if (closed || isStopping() || !ipc.connected) return false;
      const native = nativeTurns.get(event.threadId);
      const current = proxy.recoveryStates?.().find(state => state.requestId === event.requestId
        && state.threadId === event.threadId && state.turnId === event.turnId);
      if (native?.phase !== "active" || native.turnId !== event.turnId || !validIdentity(native.connectionGeneration)
        || current?.sequence !== event.sequence || current.phase !== event.phase) return false;
      const envelope = signRecoveryEnvelope({ ownerId: config.ownerId, nativeSourceId: config.nativeSourceId,
        producerId: instanceToken, producerPid: process.pid, sourceHashes,
        connectionGeneration: native.connectionGeneration }, event, config.capability);
      send({ event: "recovery", envelope });
      return true;
    },
    close() {
      closed = true;
      ipc.removeListener("message", receive);
      ipc.removeListener("disconnect", disconnected);
      if (ipc.connected) ipc.disconnect();
    },
  };
}
