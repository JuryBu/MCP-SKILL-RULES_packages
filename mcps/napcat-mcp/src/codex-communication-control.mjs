import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { createCodexCommunicationLedger } from "./codex-communication-ledger.mjs";
import { createCodexThreadReadHandler, isCodexThreadReadPath } from "./codex-thread-read-control.mjs";
import { HUMAN_SOURCE_KEYS, humanSourceFrom } from "./codex-communication-origin.mjs";
import { AGENT_PRIORITY_NOTICE_V1 } from "./codex-communication-transport.mjs";

const HOSTS = new Set(["codex", "antigravity", "windsurf"]);
const POLICIES = new Set(["next_model_boundary", "when_idle"]);
const METHODS = new Set(["turn/start", "turn/steer"]);
const PAYLOAD_KEYS = ["delivery_id", "message_id", "binding_generation", "origin", "target", "text", "delivery_policy", "message_visibility"];
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const generation = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const hash = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const deliveryRecordDigest = (payload, variant) => hash(JSON.stringify(variant === undefined ? payload : [variant, payload]));
const sourceScope = value => value.origin.kind === "human_message" ? value.relay : value.origin;
const hasHostIdentity = value => Object.hasOwn(value, "machine_id") || Object.hasOwn(value, "surface");
const validHostIdentity = value => !hasHostIdentity(value) || (identifier(value.machine_id) && identifier(value.surface));
const hostIdentityFields = value => hasHostIdentity(value) ? { machine_id: value.machine_id, surface: value.surface } : {};
const hostScopeKey = value => JSON.stringify([value.machine_id, value.host, value.surface]);
const compatibleUnknownIdentity = (left, right) => left.host === right.host && left.conversation_id === right.conversation_id
  && (!hasHostIdentity(left) || !hasHostIdentity(right) || (left.machine_id === right.machine_id && left.surface === right.surface));
const nativeTransportInput = value => value.origin.kind === "human_message" && hasHostIdentity(value.target)
  ? { ...value, target: { host: value.target.host, conversation_id: value.target.conversation_id } } : value;
const evidence = accepted => ({ adapter_accepted: accepted ? "observed" : "unknown", model_observed: "unknown", ui_observed: "unknown", processing: "unknown" });

function failure(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function loopback(host) {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."))
    || (typeof host === "string" && host.startsWith("::ffff:") && loopback(host.slice(7)));
}

function payloadFrom(input, allowRetry = false, historical = false) {
  const human = input?.origin?.kind === "human_message";
  const window = human && input.origin.channel === "napcat_owner_window";
  const keys = human ? [...PAYLOAD_KEYS, ...HUMAN_SOURCE_KEYS] : PAYLOAD_KEYS;
  let source;
  if (human) {
    try { source = humanSourceFrom(input); }
    catch { throw failure(400, "invalid_delivery"); }
  }
  if (!onlyKeys(input, allowRetry ? [...keys, "retry_failed_before_send"] : keys)
    || !identifier(input.delivery_id) || !identifier(input.message_id) || !generation(input.binding_generation)
    || (!human && (!onlyKeys(input.origin, ["kind", "host", "conversation_id", "machine_id", "surface"])
      || !identifier(input.origin.conversation_id) || typeof input.origin.kind !== "string" || typeof input.origin.host !== "string"
      || !validHostIdentity(input.origin)))
    || !onlyKeys(input.target, ["host", "conversation_id", "machine_id", "surface"])
    || !identifier(input.target.conversation_id) || typeof input.target.host !== "string" || !validHostIdentity(input.target)
    || (window && !hasHostIdentity(input.target))
    || typeof input.text !== "string" || !input.text.length || (human && Buffer.byteLength(input.text, "utf8") > 256 * 1024)
    || !POLICIES.has(input.delivery_policy)
    || (input.message_visibility !== undefined && typeof input.message_visibility !== "string")
    || (input.retry_failed_before_send !== undefined && typeof input.retry_failed_before_send !== "boolean")) throw failure(400, "invalid_delivery");
  return {
    delivery_id: input.delivery_id,
    message_id: input.message_id,
    binding_generation: input.binding_generation,
    origin: human ? source.origin : { kind: input.origin.kind, host: input.origin.host, conversation_id: input.origin.conversation_id, ...hostIdentityFields(input.origin) },
    target: { host: input.target.host, conversation_id: input.target.conversation_id, ...hostIdentityFields(input.target) },
    text: input.text,
    delivery_policy: input.delivery_policy,
    ...(!historical || Object.hasOwn(input, "message_visibility") ? { message_visibility: input.message_visibility ?? "hidden" } : {}),
    ...(human ? source : {}),
  };
}

function validateRecord(record) {
  try {
    const keys = record?.origin?.kind === "human_message" ? [...PAYLOAD_KEYS, ...HUMAN_SOURCE_KEYS] : PAYLOAD_KEYS;
    const payload = payloadFrom(Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])), false, true);
    if (!onlyKeys(record, [...keys, "principal_id", "digest", "status", "outcome", "request_sent", "injection_method", "thread_id", "turn_id", "attempt_count", "created_at", "updated_at", "evidence", "error", "visibility_item_key", "agent_render_variant"])
      || (payload.origin.kind !== "human_message" && (payload.origin.kind !== "agent" || !HOSTS.has(payload.origin.host)))
      || payload.target.host !== "codex" || ![undefined, "hidden", "visible"].includes(payload.message_visibility)
      || (Object.hasOwn(record, "agent_render_variant") && (record.agent_render_variant !== AGENT_PRIORITY_NOTICE_V1
        || payload.origin.kind !== "agent" || !Object.hasOwn(payload, "message_visibility")))
      || !identifier(record.principal_id) || record.digest !== deliveryRecordDigest(payload, record.agent_render_variant)
      || !Number.isSafeInteger(record.attempt_count) || record.attempt_count < 1
      || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))
      || typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))
      || record.thread_id !== payload.target.conversation_id || !(record.turn_id === null || identifier(record.turn_id))
      || !(record.injection_method === null || METHODS.has(record.injection_method))
      || ![true, false, null].includes(record.request_sent)
      || (record.error !== undefined && (!onlyKeys(record.error, ["code"]) || !identifier(record.error.code)))) return false;
    if (record.visibility_item_key !== undefined) {
      const identity = JSON.parse(record.visibility_item_key);
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== record.thread_id
        || identity[1] !== record.turn_id || !identity.every(identifier)) return false;
    }
    const pending = ["prepared", "dispatching"].includes(record.status);
    if (pending && (record.outcome !== null || record.request_sent !== null)) return false;
    if (record.status === "confirmed" && (record.outcome !== "accepted" || record.request_sent !== true || !METHODS.has(record.injection_method))) return false;
    if (["busy", "failed_before_send"].includes(record.status) && (record.outcome !== record.status || record.request_sent !== false)) return false;
    if (record.status === "unknown" && record.outcome !== "unknown") return false;
    if (!["prepared", "dispatching", "confirmed", "busy", "failed_before_send", "unknown"].includes(record.status)) return false;
    const expected = evidence(record.status === "confirmed");
    return onlyKeys(record.evidence, Object.keys(expected)) && Object.entries(expected).every(([key, value]) => record.evidence[key] === value);
  } catch {
    return false;
  }
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maximum) {
        if (!exceeded) reject(failure(413, "body_too_large"));
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on("end", () => {
      if (exceeded) return;
      try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(failure(400, "invalid_json")); }
    });
    request.on("error", () => reject(failure(400, "request_interrupted")));
    request.on("aborted", () => reject(failure(400, "request_interrupted")));
  });
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readStaleLockCandidate(lockPath) {
  let stat;
  try { stat = fs.lstatSync(lockPath, { bigint: true }); }
  catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1n || stat.size > 256n) return null;
  let bytes;
  try { bytes = fs.readFileSync(lockPath); }
  catch { return null; }
  if (BigInt(bytes.length) !== stat.size) return null;
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"), (key, value) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("invalid_lock");
      return value;
    });
  } catch { return null; }
  if (!onlyKeys(parsed, ["version", "pid", "owner"]) || parsed.version !== 1
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || typeof parsed.owner !== "string" || !/^[a-z0-9-]{1,80}$/iu.test(parsed.owner)) return null;
  if (isPidAlive(parsed.pid)) return null;
  let after;
  try { after = fs.lstatSync(lockPath, { bigint: true }); }
  catch { return null; }
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) return null;
  return { pid: parsed.pid, owner: parsed.owner, dev: stat.dev, ino: stat.ino, size: stat.size, sha256: hash(bytes) };
}

function reclaimExitedLedgerLock({ ledgerPath, server, now }) {
  if (!server?.listening) return { reclaimed: false };
  const address = server.address();
  if (!address || typeof address !== "object" || !(address.port > 0)) return { reclaimed: false };
  const resolvedLedger = path.resolve(ledgerPath);
  const lockPath = `${resolvedLedger}.lock`;
  const gatePath = `${resolvedLedger}.recovery-gate`;
  const candidate = readStaleLockCandidate(lockPath);
  if (!candidate) return { reclaimed: false };
  try {
    const ledgerStat = fs.lstatSync(resolvedLedger);
    if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink()) return { reclaimed: false };
  } catch (error) {
    if (error?.code !== "ENOENT") return { reclaimed: false };
  }
  let gateFd;
  let gateStat;
  try {
    gateFd = fs.openSync(gatePath, "wx", 0o600);
    gateStat = fs.fstatSync(gateFd, { bigint: true });
    const rawTs = Number(new Date(now()));
    const ts = Number.isSafeInteger(rawTs) && rawTs >= 0 ? rawTs : Date.now();
    fs.writeFileSync(gateFd, JSON.stringify({ version: 1, pid: process.pid, ts }), "utf8");
    fs.fsyncSync(gateFd);
    const latest = readStaleLockCandidate(lockPath);
    if (!latest || latest.pid !== candidate.pid || latest.owner !== candidate.owner
      || latest.dev !== candidate.dev || latest.ino !== candidate.ino
      || latest.sha256 !== candidate.sha256 || isPidAlive(latest.pid) || !server.listening) {
      return { reclaimed: false };
    }
    let archivePath = `${lockPath}.exited.${ts}.${latest.pid}.lock`;
    let suffix = 1;
    while (fs.existsSync(archivePath) && suffix < 100) {
      archivePath = `${lockPath}.exited.${ts}-${suffix}.${latest.pid}.lock`;
      suffix += 1;
    }
    if (fs.existsSync(archivePath)) return { reclaimed: false };
    fs.renameSync(lockPath, archivePath);
    return { reclaimed: true, archivePath, exitedPid: latest.pid };
  } catch {
    return { reclaimed: false };
  } finally {
    if (gateFd !== undefined) {
      try { fs.closeSync(gateFd); } catch {}
      try {
        const currentGate = fs.lstatSync(gatePath, { bigint: true });
        if (gateStat && currentGate.isFile() && !currentGate.isSymbolicLink()
          && currentGate.dev === gateStat.dev && currentGate.ino === gateStat.ino) {
          fs.unlinkSync(gatePath);
        }
      } catch {}
    }
  }
}

export function createCodexCommunicationControl(options = {}) {
  const writeAgentPriorityNotice = options.writeAgentPriorityNotice ?? true;
  if (typeof writeAgentPriorityNotice !== "boolean") throw new TypeError("writeAgentPriorityNotice must be boolean");
  const { host = "127.0.0.1", port = 0, token, principalId, allowedOrigins, allowedTargets, ledgerPath, transport, now = () => new Date(), maxBodyBytes = 256 * 1024 } = options;
  if (typeof host !== "string" || !isIP(host) || !loopback(host) || !Number.isInteger(port) || port < 0 || port > 65535
    || typeof token !== "string" || !/^\S+$/.test(token) || !identifier(principalId)
    || !Array.isArray(allowedOrigins) || !Array.isArray(allowedTargets) || typeof ledgerPath !== "string" || !ledgerPath
    || typeof transport?.inspectAndDispatch !== "function" || typeof now !== "function"
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw failure(400, "invalid_control_options");
  const threadRead = options.threadRead === undefined ? null : createCodexThreadReadHandler({
    ...options.threadRead, canRespond: () => !closed,
  });
  if (options.threadRead?.readToken === token) throw failure(400, "thread_read_token_must_differ");
  const origins = new Set();
  const originScopes = new Set();
  const ownerRelays = new Set();
  const ownerWindowRelays = new Set();
  const targets = new Map();
  const targetScopes = new Map();
  for (const origin of allowedOrigins) {
    if (origin?.scope === "host") {
      if (!onlyKeys(origin, ["scope", "machine_id", "host", "surface"]) || !identifier(origin.machine_id)
        || !["codex", "antigravity"].includes(origin.host) || origin.surface !== "desktop") throw failure(400, "invalid_allowed_origin");
      originScopes.add(hostScopeKey(origin));
      continue;
    }
    if (!onlyKeys(origin, ["host", "conversation_id", "owner_reply_channels"]) || !HOSTS.has(origin.host) || !identifier(origin.conversation_id)
      || (origin.owner_reply_channels !== undefined && (!Array.isArray(origin.owner_reply_channels)
        || origin.owner_reply_channels.length > 2 || new Set(origin.owner_reply_channels).size !== origin.owner_reply_channels.length
        || origin.owner_reply_channels.some(channel => !["napcat_owner_reply", "napcat_owner_window"].includes(channel))
        || (origin.owner_reply_channels.length > 0 && origin.host !== "codex")))) throw failure(400, "invalid_allowed_origin");
    const identity = JSON.stringify([origin.host, origin.conversation_id]);
    origins.add(identity);
    if (origin.owner_reply_channels?.includes("napcat_owner_reply")) ownerRelays.add(identity);
    if (origin.owner_reply_channels?.includes("napcat_owner_window")) ownerWindowRelays.add(identity);
  }
  for (const target of allowedTargets) {
    if (target?.scope === "host") {
      if (!onlyKeys(target, ["scope", "machine_id", "host", "surface", "binding_generation"]) || !identifier(target.machine_id)
        || target.host !== "codex" || target.surface !== "desktop" || !generation(target.binding_generation)
        || targetScopes.has(hostScopeKey(target))) throw failure(400, "invalid_allowed_target");
      targetScopes.set(hostScopeKey(target), target.binding_generation);
      continue;
    }
    if (!onlyKeys(target, ["conversation_id", "binding_generation"]) || !identifier(target.conversation_id)
      || !generation(target.binding_generation) || targets.has(target.conversation_id)) throw failure(400, "invalid_allowed_target");
    targets.set(target.conversation_id, target.binding_generation);
  }
  const timestamp = () => new Date(now()).toISOString();
  const uncertain = (record, code) => ({ ...record, status: "unknown", outcome: "unknown", updated_at: timestamp(), evidence: evidence(false), error: { code } });
  const ledger = createCodexCommunicationLedger({ ledgerPath, validateRecord, uncertainRecord: uncertain, recoverRecord: record => uncertain({ ...record, request_sent: null }, "restart_outcome_unknown") });
  const visibilityClients = new Map();
  const visibilityItems = new Map();
  const visibilityItemByDelivery = new Map();
  let visibilityRevision = Object.freeze({});

  function indexVisibility(record) {
    const clientId = `communication-${hash(record.delivery_id)}`;
    const previous = visibilityItemByDelivery.get(record.delivery_id);
    if (previous && visibilityItems.get(previous) === record.delivery_id) visibilityItems.delete(previous);
    visibilityItemByDelivery.delete(record.delivery_id);
    if (!["dispatching", "confirmed", "unknown"].includes(record.status) || !METHODS.has(record.injection_method)) {
      visibilityClients.delete(clientId);
      return;
    }
    visibilityClients.set(clientId, record.delivery_id);
    if (record.visibility_item_key) {
      visibilityItems.set(record.visibility_item_key, record.delivery_id);
      visibilityItemByDelivery.set(record.delivery_id, record.visibility_item_key);
    }
  }

  function putRecord(record) {
    const written = ledger.put(record);
    indexVisibility(ledger.get(record.delivery_id));
    if (written) visibilityRevision = Object.freeze({});
    return written;
  }

  function readVisibilityRevision(threadId) {
    if (closed || !ledger.writable) return null;
    for (const record of ledger.values()) {
      if ((record.thread_id ?? record.target_conversation_id) === threadId
        && (["prepared", "dispatching", "unknown"].includes(record.status) || sentHiddenSteer(record)
          && !(visibilityItemByDelivery.get(record.delivery_id) ?? record.visibility_item_key))) return null;
    }
    return visibilityRevision;
  }

  function lookupVisibility({ clientId, itemKey, threadId, turnId }) {
    const deliveryId = clientId ? visibilityClients.get(clientId) : visibilityItems.get(itemKey);
    const record = deliveryId ? ledger.get(deliveryId) : null;
    const boundItemKey = visibilityItemByDelivery.get(deliveryId) ?? record?.visibility_item_key ?? null;
    if (!record || record.thread_id !== threadId || (record.turn_id !== null && record.turn_id !== turnId)
      || (!clientId && boundItemKey !== itemKey)) return null;
    return Object.freeze({ ...nativeTransportInput(record), visibility_item_key: boundItemKey });
  }

  function retiredVisibility() { return closed && !ledger.writable; }

  function sentHiddenSteer(record) {
    return record?.message_visibility === "hidden" && record.injection_method === "turn/steer"
      && ["dispatching", "confirmed", "unknown"].includes(record.status) && record.request_sent !== false;
  }

  function hasUnboundHidden() {
    for (const record of ledger.values()) {
      if (sentHiddenSteer(record) && !record.visibility_item_key) return true;
    }
    return false;
  }

  function canReplaceVisibility(next) {
    if (!retiredVisibility()) return true;
    for (const [deliveryId, itemKey] of visibilityItemByDelivery) {
      const record = ledger.get(deliveryId);
      if (!record) return false;
      if (record.visibility_item_key === itemKey) continue;
      const match = next.lookup({ itemKey, threadId: record.thread_id, turnId: record.turn_id });
      if (match?.delivery_id !== deliveryId || match.visibility_item_key !== itemKey || match.digest !== record.digest
        || match.agent_render_variant !== record.agent_render_variant) return false;
    }
    for (const record of ledger.values()) {
      if (!sentHiddenSteer(record) || record.visibility_item_key || visibilityItemByDelivery.has(record.delivery_id)) continue;
      const match = next.lookup({ clientId: `communication-${hash(record.delivery_id)}`,
        threadId: record.thread_id, turnId: record.turn_id });
      if (!sentHiddenSteer(match) || match.delivery_id !== record.delivery_id || match.digest !== record.digest
        || match.agent_render_variant !== record.agent_render_variant
        || match.thread_id !== record.thread_id || match.turn_id !== record.turn_id) return false;
    }
    return true;
  }

  function visibilityBound(deliveryId, registration) {
    const record = ledger.get(deliveryId);
    if (!record || record.message_visibility !== "hidden" || !["dispatching", "confirmed", "unknown"].includes(record.status)) return false;
    const identity = JSON.parse(registration.itemKey);
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== record.thread_id
      || identity[1] !== registration.turnId || !identity.every(identifier)) return false;
    const bound = { ...record, turn_id: registration.turnId, visibility_item_key: registration.itemKey };
    if (retiredVisibility()) {
      const key = visibilityItemByDelivery.get(deliveryId);
      const owner = visibilityItems.get(registration.itemKey);
      if (record.injection_method !== "turn/steer" || record.turn_id !== registration.turnId
        || (key && key !== registration.itemKey) || (owner && owner !== deliveryId)) return false;
      indexVisibility(bound);
      return true;
    }
    return putRecord(bound);
  }
  const expectedToken = Buffer.from(hash(token), "hex");
  const active = new Map();
  const targetTails = new Map();
  const handlers = new Set();
  let server;
  let starting;
  let closing;
  let closed = false;

  function sameRecord(record, digest, payload) {
    if (record.principal_id !== principalId) throw failure(403, "principal_not_allowed");
    if (!Object.hasOwn(record, "message_visibility") && payload?.message_visibility === "visible") {
      const { message_visibility, ...historical } = payload;
      if (record.digest === hash(JSON.stringify(historical))) return;
    }
    const expectedDigest = record.agent_render_variant === undefined ? digest : deliveryRecordDigest(payload, record.agent_render_variant);
    if (record.digest !== expectedDigest) throw failure(409, "delivery_id_conflict");
  }

  function publicRecord(record) {
    const { digest, visibility_item_key, agent_render_variant, ...delivery } = record;
    return clone({ ...delivery, message_visibility: delivery.message_visibility ?? "visible" });
  }

  async function dispatch(payload, digest, retry) {
    const existing = ledger.get(payload.delivery_id);
    if (existing) {
      sameRecord(existing, digest, payload);
      if (!retry || !["busy", "failed_before_send"].includes(existing.outcome) || existing.request_sent !== false) return publicRecord(existing);
    } else {
      for (const prior of ledger.values()) {
        const priorSource = sourceScope(prior);
        const source = sourceScope(payload);
        if (prior.principal_id === principalId && prior.message_id === payload.message_id
          && prior.origin.kind === payload.origin.kind && compatibleUnknownIdentity(priorSource, source)
          && compatibleUnknownIdentity(prior.target, payload.target) && prior.outcome === "unknown") throw failure(409, "message_delivery_unknown");
      }
    }
    if (!ledger.writable) throw failure(503, "ledger_unavailable");
    const variant = existing
      ? existing.agent_render_variant
      : writeAgentPriorityNotice && payload.origin.kind === "agent" ? AGENT_PRIORITY_NOTICE_V1 : undefined;
    const renderedInput = variant === undefined ? payload : { ...payload, agent_render_variant: variant };
    const record = {
      ...renderedInput, principal_id: principalId, digest: deliveryRecordDigest(payload, variant), status: "prepared", outcome: null,
      request_sent: null, injection_method: null, thread_id: payload.target.conversation_id, turn_id: null,
      attempt_count: (existing?.attempt_count ?? 0) + 1,
      created_at: existing?.created_at ?? timestamp(), updated_at: timestamp(), evidence: evidence(false),
    };
    if (!putRecord(record)) return publicRecord(ledger.get(payload.delivery_id));
    let mutation;
    let mutationReady = false;
    const beforeMutation = metadata => {
      mutation ??= Promise.resolve().then(() => {
        const identity = METHODS.has(metadata?.injection_method) && (metadata.turn_id === null || identifier(metadata.turn_id))
          ? { injection_method: metadata.injection_method, turn_id: metadata.turn_id } : {};
        if (!putRecord({ ...record, ...identity, status: "dispatching", updated_at: timestamp() })) throw failure(503, "ledger_write_failed");
        mutationReady = true;
      });
      return mutation;
    };
    let result;
    try {
      result = await transport.inspectAndDispatch(clone(nativeTransportInput(renderedInput)), { beforeMutation,
        onVisibilityBound: registration => visibilityBound(payload.delivery_id, registration) });
    } catch {
      result = { outcome: "unknown", request_sent: null, error: { code: "transport_outcome_unknown" } };
    }
    try { if (mutation) await mutation; }
    catch { result = { outcome: "unknown", request_sent: null, error: { code: "ledger_write_failed" } }; }
    const valid = object(result) && ["accepted", "busy", "failed_before_send", "unknown"].includes(result.outcome)
      && result.thread_id === payload.target.conversation_id
      && (result.turn_id === null || identifier(result.turn_id))
      && (result.injection_method === null || METHODS.has(result.injection_method))
      && [true, false, null].includes(result.request_sent)
      && (result.outcome !== "accepted" || (mutationReady && result.request_sent === true && METHODS.has(result.injection_method)))
      && (!["busy", "failed_before_send"].includes(result.outcome) || result.request_sent === false);
    const outcome = valid ? result.outcome : "unknown";
    const visibilityItemKey = ledger.get(payload.delivery_id)?.visibility_item_key;
    const completed = {
      ...record, status: outcome === "accepted" ? "confirmed" : outcome, outcome,
      request_sent: [true, false, null].includes(result?.request_sent) ? result.request_sent : null,
      injection_method: METHODS.has(result?.injection_method) ? result.injection_method : null,
      turn_id: identifier(result?.turn_id) ? result.turn_id : visibilityItemKey ? JSON.parse(visibilityItemKey)[1] : null,
      ...(visibilityItemKey ? { visibility_item_key: visibilityItemKey } : {}),
      updated_at: timestamp(), evidence: evidence(outcome === "accepted"),
    };
    if (result?.error || !valid) completed.error = { code: identifier(result?.error?.code) ? result.error.code : "transport_contract_violation" };
    if (ledger.writable) putRecord(completed);
    return publicRecord(ledger.get(payload.delivery_id));
  }

  async function deliver(input) {
    const payload = payloadFrom(input, true);
    const digest = hash(JSON.stringify(payload));
    const existing = ledger.get(payload.delivery_id);
    if (existing) sameRecord(existing, digest, payload);
    const source = sourceScope(payload);
    if (payload.origin.kind === "human_message") {
      const relays = payload.origin.channel === "napcat_owner_window" ? ownerWindowRelays : ownerRelays;
      if (!relays.has(JSON.stringify([source.host, source.conversation_id]))) throw failure(403, "origin_not_allowed");
    }
    const running = active.get(payload.delivery_id);
    if (running) {
      if (running.digest !== digest) throw failure(409, "delivery_id_conflict");
      return running.promise;
    }
    if (existing && (input.retry_failed_before_send !== true || !["busy", "failed_before_send"].includes(existing.outcome) || existing.request_sent !== false)) return publicRecord(existing);
    if (payload.origin.kind !== "human_message" && (payload.origin.kind !== "agent" || !HOSTS.has(source.host)
      || !(hasHostIdentity(source) ? originScopes.has(hostScopeKey(source))
        : origins.has(JSON.stringify([source.host, source.conversation_id]))))) throw failure(403, "origin_not_allowed");
    const targetGeneration = hasHostIdentity(payload.target) ? targetScopes.get(hostScopeKey(payload.target)) : targets.get(payload.target.conversation_id);
    if (payload.target.host !== "codex" || targetGeneration === undefined) throw failure(403, "target_not_allowed");
    if (targetGeneration !== payload.binding_generation) throw failure(409, "binding_generation_mismatch");
    if (!["hidden", "visible"].includes(payload.message_visibility)) throw failure(422, "unsupported_visibility");
    const previous = targetTails.get(payload.target.conversation_id) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => dispatch(payload, digest, input.retry_failed_before_send === true));
    active.set(payload.delivery_id, { digest, promise });
    targetTails.set(payload.target.conversation_id, promise);
    const cleanup = () => {
      active.delete(payload.delivery_id);
      if (targetTails.get(payload.target.conversation_id) === promise) targetTails.delete(payload.target.conversation_id);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  function lookup(deliveryId, query) {
    const keys = ["source_host", "source_conversation_id", "target_conversation_id", "binding_generation"];
    const sourceKeys = ["source_machine_id", "source_surface"];
    const targetKeys = ["target_host", "target_machine_id", "target_surface"];
    const scopedSource = sourceKeys.some(key => query.has(key));
    const scopedTarget = targetKeys.some(key => query.has(key));
    if (scopedSource) keys.push(...sourceKeys);
    if (scopedTarget) keys.push(...targetKeys);
    if ([...query.keys()].length !== keys.length || keys.some(key => query.getAll(key).length !== 1)
      || !HOSTS.has(query.get("source_host")) || !identifier(query.get("source_conversation_id"))
      || (scopedSource && (!identifier(query.get("source_machine_id")) || !identifier(query.get("source_surface"))))
      || (scopedTarget && (!HOSTS.has(query.get("target_host")) || !identifier(query.get("target_machine_id")) || !identifier(query.get("target_surface"))))
      || !identifier(query.get("target_conversation_id")) || !/^(0|[1-9]\d*)$/.test(query.get("binding_generation"))
      || !generation(Number(query.get("binding_generation")))) throw failure(400, "invalid_lookup");
    const record = ledger.get(deliveryId);
    if (!record) throw failure(404, "delivery_not_found");
    const source = sourceScope(record);
    if (record.principal_id !== principalId || source.host !== query.get("source_host")
      || source.conversation_id !== query.get("source_conversation_id")
      || source.machine_id !== (query.get("source_machine_id") ?? undefined) || source.surface !== (query.get("source_surface") ?? undefined)
      || record.target.host !== (query.get("target_host") ?? "codex")
      || record.target.conversation_id !== query.get("target_conversation_id")
      || record.target.machine_id !== (query.get("target_machine_id") ?? undefined) || record.target.surface !== (query.get("target_surface") ?? undefined)
      || record.binding_generation !== Number(query.get("binding_generation"))) throw failure(403, "delivery_scope_mismatch");
    return publicRecord(record);
  }

  function respond(response, status, body) {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "connection": "close" });
    response.end(JSON.stringify(body));
  }

  async function handle(request, response) {
    try {
      if (!loopback(request.socket.remoteAddress)) throw failure(403, "loopback_required");
      if (threadRead && isCodexThreadReadPath(request.url)) {
        if (closed) throw failure(503, "control_closing");
        await threadRead(request, response);
        return;
      }
      const authorization = request.headers.authorization;
      if (request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length !== 1
        || typeof authorization !== "string" || !/^Bearer \S+$/i.test(authorization)
        || !timingSafeEqual(expectedToken, Buffer.from(hash(authorization.slice(7)), "hex"))) throw failure(401, "unauthorized");
      if (closed) throw failure(503, "control_closing");
      if (!request.url.startsWith("/") || request.url.startsWith("//")) throw failure(400, "invalid_request_target");
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/v1/communication/deliveries" && !url.search) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers["content-type"] ?? "")
          || ![undefined, "identity"].includes(request.headers["content-encoding"])) throw failure(415, "json_required");
        if (Number(request.headers["content-length"]) > maxBodyBytes) throw failure(413, "body_too_large");
        respond(response, 200, { ok: true, delivery: await deliver(await readBody(request, maxBodyBytes)) });
      } else if (request.method === "GET" && url.pathname.startsWith("/v1/communication/deliveries/")) {
        const readingReplies = url.pathname.endsWith("/replies");
        let deliveryId;
        try { deliveryId = decodeURIComponent(url.pathname.slice("/v1/communication/deliveries/".length, readingReplies ? -"/replies".length : undefined)); }
        catch { throw failure(400, "invalid_delivery_id"); }
        if (!identifier(deliveryId)) throw failure(400, "invalid_delivery_id");
        const query = new URLSearchParams(url.searchParams);
        const cursors = readingReplies ? query.getAll("cursor") : [];
        let replyCursor;
        if (readingReplies) query.delete("cursor");
        if (cursors.length > 1 || (cursors.length && (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursors[0])))) throw failure(400, "invalid_reply_cursor");
        if (cursors.length) {
          try { replyCursor = JSON.parse(Buffer.from(cursors[0], "base64url").toString("utf8")); }
          catch { throw failure(400, "invalid_reply_cursor"); }
          if (!object(replyCursor)) throw failure(400, "invalid_reply_cursor");
        }
        const delivery = lookup(deliveryId, query);
        if (!readingReplies) {
          respond(response, 200, { ok: true, delivery });
        } else {
          if (delivery.status !== "confirmed" || delivery.outcome !== "accepted" || delivery.request_sent !== true) throw failure(409, "delivery_not_accepted");
          if (typeof transport.readCompletedReplies !== "function") throw failure(501, "replies_unsupported");
          const replies = await transport.readCompletedReplies({ ...delivery, ...(replyCursor ? { reply_cursor: replyCursor } : {}) });
          const cursor = replies.cursor ? Buffer.from(JSON.stringify(replies.cursor)).toString("base64url") : null;
          respond(response, 200, { ok: true, delivery, replies: { ...replies, cursor } });
        }
      } else throw failure(404, "route_not_found");
    } catch (error) {
      respond(response, error.status ?? 500, { ok: false, error: { code: error.status ? error.code : "control_error" } });
    }
  }

  return {
    start() {
      if (closed) return Promise.reject(failure(503, "control_closed"));
      starting ??= (async () => {
        let serving = false;
        const stopServer = async () => {
          if (server?.listening) {
            const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            server.closeAllConnections?.();
            await stopped;
          }
        };
        try {
          server = http.createServer((request, response) => {
            if (!serving) {
              respond(response, 503, { ok: false, error: { code: "owned_control_starting" } });
              return;
            }
            const handler = handle(request, response);
            handlers.add(handler);
            handler.then(() => handlers.delete(handler), () => handlers.delete(handler));
          });
          server.requestTimeout = 30_000;
          server.headersTimeout = 10_000;
          await new Promise((resolve, reject) => {
            const onError = error => reject(error);
            server.once("error", onError);
            server.listen({ host, port, exclusive: true }, () => { server.off("error", onError); resolve(); });
          });
          if (typeof options.ownedColdLockRecovery === "function") {
            await options.ownedColdLockRecovery({ host, port: server.address().port });
          }
          if (closed) throw failure(503, "control_closed");
          reclaimExitedLedgerLock({ ledgerPath, server, now });
          ledger.open();
          for (const record of ledger.values()) indexVisibility(record);
          transport.setVisibilitySource?.({ lookup: lookupVisibility, onBound: visibilityBound, readable: () => !closed && ledger.writable,
            retired: retiredVisibility, hasUnboundHidden, canReplace: canReplaceVisibility, readVisibilityRevision });
          serving = true;
          return { host, port: server.address().port };
        } catch (error) {
          await stopServer().catch(() => {});
          ledger.close();
          throw error;
        }
      })();
      return starting;
    },
    close() {
      closing ??= (async () => {
        closed = true;
        if (starting) await starting.catch(() => {});
        if (server?.listening) {
          const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
          await stopped;
        }
        await Promise.allSettled([...handlers]);
        ledger.close();
      })();
      return closing;
    },
  };
}
