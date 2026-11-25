import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameReplaceSync } from "./atomic-file.mjs";

export const INTERNAL_MEMORY_CONNECTION_HEADER = "x-codex-internal-memory-connection";
const metadataHeader = "x-codex-turn-metadata";
const digestPattern = /^[a-f0-9]{64}$/u;
const requestPaths = new Set(["/v1/responses", "/backend-api/codex/responses"]);
const compactPaths = new Set([...requestPaths].map(value => `${value}/compact`));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = (code, status = 403) => Object.assign(new Error(`${code}: Internal memory request refused.`), {
  code, statusCode: status, httpStatus: status, localRequestFailure: true, errorType: "internal_memory_request_rejected",
});
const reject = (code, status) => { throw failure(code, status); };
const diagnosticFields = new Set(["grant", "operationId", "nativeGeneration", "nativePid", "connectionToken", "sequence", "kind",
  "nativeTurnId", "nativeThreadId", "expiresAt", "payloadSha256", "requestPath", "metadata", "capacity"]);
const diagnosticTypes = new Set(["undefined", "null", "array", "object", "string", "number", "boolean", "bigint", "symbol", "function"]);
const diagnosticReasons = new Set(["object", "text", "positive_safe_integer", "digest", "kind", "nullable_text", "safe_integer",
  "expired", "ttl_exceeded", "nullable_digest", "validation_refused"]);

export function internalMemoryRejectionDiagnostics(value) {
  if (!object(value) || value.schemaVersion !== 1) return undefined;
  const result = { schemaVersion: 1 };
  for (const [key, allowed] of [["failedField", diagnosticFields], ["fieldType", diagnosticTypes], ["reason", diagnosticReasons]]) {
    if (allowed.has(value[key])) result[key] = value[key];
  }
  for (const key of ["constructedAt", "validatedAt", "ttlCheckedAt", "expiresAt", "remainingMs", "expiryOverrunMs", "maxTtlMs", "workerPid", "sequence"]) {
    if (Number.isSafeInteger(value[key])) result[key] = value[key];
  }
  for (const key of ["operationHash", "connectionHash", "socketHash", "workerInstanceHash"]) {
    if (typeof value[key] === "string" && /^[a-f0-9]{16}$/u.test(value[key])) result[key] = value[key];
  }
  return Object.keys(result).length > 1 ? result : undefined;
}

function grantRejectionDiagnostics(input, failedField, reason, validatedAt, ttlCheckedAt, maxTtlMs) {
  const source = object(input) ? input : {};
  const context = object(source.diagnostics) ? source.diagnostics : {};
  const value = failedField === "grant" ? input : source[failedField];
  const fieldType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const remainingMs = Number.isSafeInteger(source.expiresAt) ? source.expiresAt - validatedAt : undefined;
  const summary = value => typeof value === "string" && value.length <= 256 ? sha256(value).slice(0, 16) : undefined;
  return internalMemoryRejectionDiagnostics({ schemaVersion: 1, failedField, fieldType, reason,
    constructedAt: context.constructedAt, validatedAt, ttlCheckedAt, expiresAt: source.expiresAt, remainingMs,
    expiryOverrunMs: remainingMs === undefined ? undefined : Math.max(0, -remainingMs), maxTtlMs,
    operationHash: summary(source.operationId), connectionHash: summary(source.connectionToken),
    socketHash: context.socketHash, workerPid: context.workerPid, workerInstanceHash: context.workerInstanceHash, sequence: source.sequence });
}

function header(headers, name) {
  const entries = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  if (entries.length > 1 || Array.isArray(entries[0]?.[1])) reject("INTERNAL_MEMORY_HEADER_CONFLICT");
  return entries[0]?.[1];
}

function metadataObject(value) {
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65536) reject("INTERNAL_MEMORY_METADATA_INVALID");
    try { value = JSON.parse(value); } catch { reject("INTERNAL_MEMORY_METADATA_INVALID"); }
  }
  if (!object(value)) reject("INTERNAL_MEMORY_METADATA_INVALID");
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

const canonical = value => JSON.stringify(stable(value));
const metadataHash = value => sha256(canonical(value));

export function internalMemoryPayloadSha256(payload) {
  if (!object(payload)) reject("INTERNAL_MEMORY_PAYLOAD_INVALID");
  const normalized = { ...payload };
  if (normalized.type === "response.create") delete normalized.type;
  if (normalized.stream !== undefined && typeof normalized.stream !== "boolean") reject("INTERNAL_MEMORY_PAYLOAD_INVALID");
  delete normalized.stream;
  if (object(normalized.client_metadata) && normalized.client_metadata[metadataHeader] !== undefined) {
    normalized.client_metadata = { ...normalized.client_metadata,
      [metadataHeader]: metadataObject(normalized.client_metadata[metadataHeader]) };
  }
  return sha256(canonical(normalized));
}

export function classifyInternalMemoryRequest(payload, headers = {}) {
  const bodyMetadata = payload == null ? null : metadataObject(payload?.client_metadata?.[metadataHeader]);
  const compatibilityMetadata = metadataObject(header(headers, metadataHeader));
  const metadata = bodyMetadata ?? compatibilityMetadata;
  const internalHint = value => value && (value.request_kind === "memory" || value.thread_source === "memory_consolidation"
    || value.turn_trigger === "memory_consolidation");
  const subagent = payload?.client_metadata?.["x-openai-subagent"];
  const subagentHeader = header(headers, "x-openai-subagent");
  if (!internalHint(bodyMetadata) && !internalHint(compatibilityMetadata) && subagent !== "memory_consolidation"
    && subagentHeader !== "memory_consolidation") return null;
  if (["turn", "compaction"].includes(metadata?.request_kind) && subagent !== "memory_consolidation"
    && subagentHeader !== "memory_consolidation") return null;
  if (!metadata || !["memory", "turn", "compaction"].includes(metadata.request_kind)
    || metadata.thread_source !== "memory_consolidation" || metadata.turn_trigger !== "memory_consolidation"
    || !text(metadata.turn_id) || metadata.subagent_kind != null) reject("INTERNAL_MEMORY_DESCRIPTOR_INVALID");
  if (bodyMetadata && compatibilityMetadata) {
    const projected = { ...bodyMetadata };
    delete projected.tool_namespaces_info;
    if (canonical(compatibilityMetadata) !== canonical(bodyMetadata) && canonical(compatibilityMetadata) !== canonical(projected)) {
      reject("INTERNAL_MEMORY_METADATA_CONFLICT");
    }
  }
  if (payload != null && !bodyMetadata) reject("INTERNAL_MEMORY_BODY_METADATA_REQUIRED");
  const kind = metadata.request_kind === "memory" ? "extract" : metadata.request_kind === "turn" ? "consolidate" : "compaction";
  if (metadata.thread_id !== undefined && !text(metadata.thread_id)) reject("INTERNAL_MEMORY_DESCRIPTOR_INVALID");
  if (kind !== "extract") {
    if (!text(metadata.thread_id)) reject("INTERNAL_MEMORY_DESCRIPTOR_INVALID");
    if (payload != null && subagent !== "memory_consolidation") reject("INTERNAL_MEMORY_SUBAGENT_REQUIRED");
    if (subagentHeader !== undefined && subagentHeader !== "memory_consolidation") reject("INTERNAL_MEMORY_METADATA_CONFLICT");
    for (const key of ["thread_id", "turn_id"]) {
      const outer = payload?.client_metadata?.[key];
      if (outer !== undefined && outer !== metadata[key]) reject("INTERNAL_MEMORY_METADATA_CONFLICT");
    }
  }
  return { kind, metadata, nativeThreadId: metadata.thread_id ?? null, nativeTurnId: metadata.turn_id, headerOnly: payload == null };
}

export function classifyInternalMemoryPrewarmRequest(payload) {
  if (!object(payload) || payload.generate !== false || !Array.isArray(payload.input) || payload.input.length !== 0
    || payload.client_metadata?.["x-openai-subagent"] !== "memory_consolidation") return null;
  const metadata = metadataObject(payload.client_metadata[metadataHeader]);
  if (!metadata || metadata.request_kind !== "prewarm" || metadata.thread_source !== "memory_consolidation"
    || [metadata.turn_id, payload.client_metadata.turn_id].some(value => value !== undefined && value !== "")) return null;
  return { kind: "prewarm", metadata };
}

export function takeInternalMemoryConnectionHeader(headers = {}) {
  let value;
  let invalid = false;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== INTERNAL_MEMORY_CONNECTION_HEADER) continue;
    if (value !== undefined || typeof headers[name] !== "string") invalid = true;
    value = headers[name];
    delete headers[name];
  }
  return invalid ? "invalid" : value;
}

export function createInternalMemoryRequestAuthority(options = {}) {
  const now = options.now ?? Date.now;
  const bound = (name, fallback, maximum) => {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure("INTERNAL_MEMORY_LIMIT_INVALID", 500);
    return value;
  };
  const maxOperations = bound("maxOperations", 256, 2048);
  const maxSteps = bound("maxSteps", 2048, 16384);
  const maxConnections = bound("maxConnections", 256, 2048);
  const maxPermits = bound("maxPermits", 256, 2048);
  const maxTtlMs = bound("maxTtlMs", 120000, 600000);
  const statePath = options.statePath ? path.resolve(options.statePath)
    : options.stateRoot ? path.resolve(options.stateRoot, "internal-memory", "worker-ledger.json") : null;
  const operations = new Map();
  const connections = new Map();
  const retiredCandidateTokens = new Map();
  const claims = new WeakMap();
  let blocked = false;
  let closed = false;
  const checkReady = () => { if (closed || blocked) reject("INTERNAL_MEMORY_STATE_UNAVAILABLE", 503); };
  const safeStatePath = () => {
    for (let current = statePath; current !== path.dirname(current); current = path.dirname(current)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) reject("INTERNAL_MEMORY_STATE_UNAVAILABLE", 503);
    }
  };
  if (statePath) {
    try {
      safeStatePath();
      if (fs.existsSync(statePath)) {
        if (fs.statSync(statePath).size > 16 * 1024 * 1024) throw new Error();
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (state.schemaVersion !== 1 || !Array.isArray(state.operations) || state.operations.length > maxOperations) throw new Error();
        if (state.retiredCandidateTokens !== undefined && (!Array.isArray(state.retiredCandidateTokens)
          || !state.retiredCandidateTokens.every(value => typeof value === "string" && digestPattern.test(value)))) throw new Error();
        for (const tokenHash of state.retiredCandidateTokens ?? []) retiredCandidateTokens.set(tokenHash, []);
        let count = 0;
        for (const operation of state.operations) {
          if (!text(operation.operationId) || operations.has(operation.operationId) || !digestPattern.test(operation.identitySha256)
            || !["extract", "consolidate"].includes(operation.kind) || !Array.isArray(operation.steps)) throw new Error();
          for (const step of operation.steps) {
            if (!(step.payloadSha256 === null || digestPattern.test(step.payloadSha256)) || !digestPattern.test(step.metadataSha256)
              || !["AUTHORIZED", "EXPIRED", "REVOKED", "SENDING", "UNKNOWN", "COMPLETED", "RETRYABLE"].includes(step.state)) throw new Error();
            if (["SENDING", "UNKNOWN", "COMPLETED", "RETRYABLE"].includes(step.state) && !digestPattern.test(step.payloadSha256)
              || !Number.isSafeInteger(step.step) || step.step < 1 || !Number.isSafeInteger(step.sequence) || step.sequence < 1
              || !Array.isArray(step.toolHashes) || step.toolHashes.length > 256 || !step.toolHashes.every(value => digestPattern.test(value))) throw new Error();
            if (step.state === "SENDING") step.state = "UNKNOWN";
            if (step.state === "AUTHORIZED") step.state = "EXPIRED";
            count += 1;
          }
          if (count > maxSteps) throw new Error();
          operations.set(operation.operationId, operation);
        }
      }
    } catch { blocked = true; }
  }
  const persist = () => {
    if (!statePath) return;
    let temporary;
    let descriptor;
    try {
      safeStatePath();
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, operations: [...operations.values()],
        retiredCandidateTokens: [...retiredCandidateTokens.keys()] }));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      renameReplaceSync(temporary, statePath);
      temporary = undefined;
    } catch {
      blocked = true;
      reject("INTERNAL_MEMORY_STATE_UNAVAILABLE", 503);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
    }
  };
  const prune = () => {
    for (const connection of connections.values()) {
      connection.permits = connection.permits.filter(permit => {
        if (permit.expiresAt > now()) return true;
        const step = operations.get(permit.operationId)?.steps.find(step => step.step === permit.step);
        if (step?.state === "AUTHORIZED") step.state = "EXPIRED";
        return false;
      });
    }
  };
  const stepCount = () => [...operations.values()].reduce((count, operation) => count + operation.steps.length, 0);
  const permitCount = () => [...connections.values()].reduce((count, connection) => count + connection.permits.length, 0);
  const unresolved = operation => operation.steps.some(step => ["SENDING", "UNKNOWN"].includes(step.state));
  const getClaim = context => {
    const claim = claims.get(context);
    if (!claim || claim.settled) reject("INTERNAL_MEMORY_CLAIM_INVALID");
    return claim;
  };

  return {
    prepareConnection(input) {
      checkReady();
      if (!object(input) || !digestPattern.test(input.connectionToken) || !text(input.nativeGeneration)
        || !Number.isSafeInteger(input.nativePid) || input.nativePid < 1 || !requestPaths.has(input.requestPath)
        || !digestPattern.test(input.payloadSha256)) reject("INTERNAL_MEMORY_PREWARM_REGISTRATION_INVALID");
      const tokenHash = sha256(input.connectionToken);
      if (retiredCandidateTokens.has(tokenHash)) reject("INTERNAL_MEMORY_CONNECTION_REVOKED");
      const nativeIdentity = metadataHash({ nativeGeneration: input.nativeGeneration, nativePid: input.nativePid });
      let connection = connections.get(tokenHash);
      if (connection && (connection.revoked || connection.nativeIdentity !== nativeIdentity
        || !connection.prepared || connection.prewarmPath !== input.requestPath
        || connection.prewarmPayloadSha256 !== input.payloadSha256)) reject("INTERNAL_MEMORY_PREWARM_REGISTRATION_MISMATCH");
      if (!connection) {
        if (connections.size >= maxConnections) reject("INTERNAL_MEMORY_CAPACITY", 503);
        connection = { sequence: 0, nativeIdentity, socketId: null, revoked: false, permits: [], operationIds: new Set(),
          prepared: true, prewarmClaimed: false, generationConsumed: false,
          prewarmPath: input.requestPath, prewarmPayloadSha256: input.payloadSha256 };
        connections.set(tokenHash, connection);
      }
      return { prepared: true };
    },
    claimPrewarm({ connectionToken, socketId, requestPath, payload } = {}) {
      checkReady();
      if (!digestPattern.test(connectionToken) || !text(socketId)) reject("INTERNAL_MEMORY_AUTHORIZATION_REQUIRED");
      const connection = connections.get(sha256(connectionToken));
      if (!connection || connection.revoked || !connection.prepared) reject("INTERNAL_MEMORY_AUTHORIZATION_REQUIRED");
      if (connection.socketId !== null && connection.socketId !== socketId) reject("INTERNAL_MEMORY_CONNECTION_MISMATCH");
      if (!classifyInternalMemoryPrewarmRequest(payload) || requestPath !== connection.prewarmPath
        || internalMemoryPayloadSha256(payload) !== connection.prewarmPayloadSha256) reject("INTERNAL_MEMORY_PREWARM_MISMATCH");
      if (connection.prewarmClaimed || connection.generationConsumed) reject("INTERNAL_MEMORY_PREWARM_REPLAY");
      connection.socketId = socketId;
      connection.prewarmClaimed = true;
      return { kind: "prewarm", prewarm: true };
    },
    authorize(input) {
      checkReady();
      prune();
      let validatedAt;
      let ttlCheckedAt;
      const refuse = (code, field, reason = "validation_refused", status) => {
        const error = failure(code, status);
        error.diagnostics = grantRejectionDiagnostics(input, field, reason, validatedAt ?? now(), ttlCheckedAt, maxTtlMs);
        throw error;
      };
      const invalid = (field, reason) => refuse("INTERNAL_MEMORY_GRANT_INVALID", field, reason);
      if (!object(input)) invalid("grant", "object");
      if (!text(input.operationId)) invalid("operationId", "text");
      if (!text(input.nativeGeneration)) invalid("nativeGeneration", "text");
      if (!Number.isSafeInteger(input.nativePid) || input.nativePid < 1) invalid("nativePid", "positive_safe_integer");
      if (!digestPattern.test(input.connectionToken)) invalid("connectionToken", "digest");
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) invalid("sequence", "positive_safe_integer");
      if (!["extract", "consolidate", "compaction"].includes(input.kind)) invalid("kind", "kind");
      if (!text(input.nativeTurnId)) invalid("nativeTurnId", "text");
      if (!(input.nativeThreadId === null || text(input.nativeThreadId))) invalid("nativeThreadId", "nullable_text");
      if (!Number.isSafeInteger(input.expiresAt)) invalid("expiresAt", "safe_integer");
      validatedAt = now();
      if (input.expiresAt <= validatedAt) invalid("expiresAt", "expired");
      ttlCheckedAt = now();
      if (input.expiresAt - ttlCheckedAt > maxTtlMs) invalid("expiresAt", "ttl_exceeded");
      if (!(input.payloadSha256 === null || digestPattern.test(input.payloadSha256))) invalid("payloadSha256", "nullable_digest");
      if (!(input.kind === "compaction" ? compactPaths.has(input.requestPath) || requestPaths.has(input.requestPath)
        : requestPaths.has(input.requestPath))) refuse("INTERNAL_MEMORY_PATH_MISMATCH", "requestPath");
      let metadata;
      let descriptor;
      try {
        metadata = metadataObject(input.metadata);
        descriptor = classifyInternalMemoryRequest(null, { [metadataHeader]: JSON.stringify(metadata),
          ...(input.kind === "extract" ? {} : { "x-openai-subagent": "memory_consolidation" }) });
      } catch (error) {
        error.diagnostics = grantRejectionDiagnostics(input, "metadata", "validation_refused", validatedAt, ttlCheckedAt, maxTtlMs);
        throw error;
      }
      if (!descriptor || descriptor.kind !== input.kind || descriptor.nativeThreadId !== input.nativeThreadId
        || descriptor.nativeTurnId !== input.nativeTurnId) refuse("INTERNAL_MEMORY_GRANT_MISMATCH", "metadata");
      const rootKind = input.kind === "compaction" ? "consolidate" : input.kind;
      const identitySha256 = metadataHash({ nativeGeneration: input.nativeGeneration, nativePid: input.nativePid,
        kind: rootKind, nativeThreadId: input.nativeThreadId, nativeTurnId: input.nativeTurnId });
      let operation = operations.get(input.operationId);
      if (operation && (operation.identitySha256 !== identitySha256 || operation.kind !== rootKind)) refuse("INTERNAL_MEMORY_OPERATION_MISMATCH", "operationId");
      if ([...operations.values()].some(value => value.operationId !== input.operationId && value.identitySha256 === identitySha256)) {
        refuse("INTERNAL_MEMORY_OPERATION_ALIAS", "operationId", "validation_refused", 409);
      }
      if (operation && unresolved(operation)) refuse("INTERNAL_MEMORY_OPERATION_UNRESOLVED", "operationId", "validation_refused", 409);
      if (input.kind === "compaction" && (!operation || !operation.steps.some(step => step.kind === "consolidate"
        && ["SENDING", "UNKNOWN", "COMPLETED", "RETRYABLE"].includes(step.state)))) {
        refuse("INTERNAL_MEMORY_CONSOLIDATION_REQUIRED", "kind");
      }
      if (!operation && operations.size >= maxOperations || stepCount() >= maxSteps || permitCount() >= maxPermits) {
        refuse("INTERNAL_MEMORY_CAPACITY", "capacity", "validation_refused", 503);
      }
      const tokenHash = sha256(input.connectionToken);
      if (retiredCandidateTokens.has(tokenHash)) refuse("INTERNAL_MEMORY_CONNECTION_REVOKED", "connectionToken");
      let connection = connections.get(tokenHash);
      const nativeIdentity = metadataHash({ nativeGeneration: input.nativeGeneration, nativePid: input.nativePid });
      if (connection && (connection.revoked || connection.nativeIdentity !== nativeIdentity)) refuse("INTERNAL_MEMORY_CONNECTION_REVOKED", "connectionToken");
      if (input.sequence !== (connection?.sequence ?? 0) + 1) refuse("INTERNAL_MEMORY_SEQUENCE_MISMATCH", "sequence", "validation_refused", 409);
      if (!connection && connections.size >= maxConnections) refuse("INTERNAL_MEMORY_CAPACITY", "capacity", "validation_refused", 503);
      if (input.payloadSha256 && operation?.steps.some(step => step.payloadSha256 === input.payloadSha256 && step.state === "COMPLETED")) {
        refuse("INTERNAL_MEMORY_REPLAY", "payloadSha256", "validation_refused", 409);
      }
      if (!operation) {
        operation = { operationId: input.operationId, identitySha256, kind: rootKind, steps: [] };
        operations.set(input.operationId, operation);
      }
      if (!connection) {
        connection = { sequence: 0, nativeIdentity, socketId: null, revoked: false, permits: [], operationIds: new Set(), generationConsumed: false };
        connections.set(tokenHash, connection);
      }
      connection.sequence = input.sequence;
      const step = { step: operation.steps.length + 1, sequence: input.sequence, kind: input.kind, requestPath: input.requestPath,
        metadataSha256: metadataHash(metadata), payloadSha256: input.payloadSha256, state: "AUTHORIZED", createdAt: now(), toolHashes: [] };
      operation.steps.push(step);
      connection.operationIds.add(input.operationId);
      connection.permits.push({ operationId: input.operationId, sequence: input.sequence, kind: input.kind,
        nativeThreadId: input.nativeThreadId, nativeTurnId: input.nativeTurnId, requestPath: input.requestPath,
        metadataSha256: metadataHash(metadata), payloadSha256: input.payloadSha256, expiresAt: input.expiresAt, step: step.step });
      persist();
      return { authorized: true, operationId: input.operationId, sequence: input.sequence, expiresAt: input.expiresAt };
    },
    claim({ connectionToken, socketId, requestPath, payload, headers }) {
      checkReady();
      prune();
      if (!digestPattern.test(connectionToken) || !text(socketId)) reject("INTERNAL_MEMORY_AUTHORIZATION_REQUIRED");
      const connection = connections.get(sha256(connectionToken));
      if (!connection || connection.revoked || !connection.permits.length) reject("INTERNAL_MEMORY_AUTHORIZATION_REQUIRED");
      if (connection.socketId !== null && connection.socketId !== socketId) reject("INTERNAL_MEMORY_CONNECTION_MISMATCH");
      const descriptor = classifyInternalMemoryRequest(payload, headers);
      const permit = connection.permits[0];
      const payloadSha256 = internalMemoryPayloadSha256(payload);
      const projected = descriptor && { ...descriptor.metadata };
      if (projected) delete projected.tool_namespaces_info;
      if (!descriptor || payload.generate === false || descriptor.kind !== permit.kind || requestPath !== permit.requestPath
        || descriptor.nativeThreadId !== permit.nativeThreadId || descriptor.nativeTurnId !== permit.nativeTurnId
        || metadataHash(descriptor.metadata) !== permit.metadataSha256
          && !(permit.payloadSha256 === null && metadataHash(projected) === permit.metadataSha256)
        || permit.payloadSha256 !== null && payloadSha256 !== permit.payloadSha256) reject("INTERNAL_MEMORY_REQUEST_MISMATCH");
      const operation = operations.get(permit.operationId);
      if (unresolved(operation)) reject("INTERNAL_MEMORY_OPERATION_UNRESOLVED", 409);
      if (operation.steps.some(step => step.payloadSha256 === payloadSha256 && step.state === "COMPLETED")) {
        connection.permits.shift();
        const rejected = operation.steps.find(step => step.step === permit.step);
        if (rejected?.state === "AUTHORIZED") {
          rejected.payloadSha256 = payloadSha256;
          rejected.state = "REVOKED";
          rejected.reason = "completed_payload_replay";
          persist();
        }
        reject("INTERNAL_MEMORY_REPLAY", 409);
      }
      connection.socketId = socketId;
      connection.permits.shift();
      const step = operation.steps.find(step => step.step === permit.step);
      if (!step || step.state !== "AUTHORIZED") reject("INTERNAL_MEMORY_CLAIM_INVALID");
      step.payloadSha256 = payloadSha256;
      step.state = "SENDING";
      connection.generationConsumed = true;
      const context = { operationId: operation.operationId, sequence: permit.sequence, kind: permit.kind,
        nativeThreadId: permit.nativeThreadId, nativeTurnId: permit.nativeTurnId,
        bindingKey: `internal-memory:${operation.operationId}`,
        threadBindingKey: permit.kind === "extract" ? `internal-memory:extract:${socketId}`
          : `internal-memory:thread:${metadataHash([connection.nativeIdentity, permit.nativeThreadId])}`, payloadSha256 };
      claims.set(context, { operation, step, settled: false });
      persist();
      return context;
    },
    recordTool(context, item) {
      checkReady();
      const { step } = getClaim(context);
      const toolHash = metadataHash(item);
      if (!step.toolHashes.includes(toolHash)) {
        if (step.toolHashes.length >= 256) reject("INTERNAL_MEMORY_CAPACITY", 503);
        step.toolHashes.push(toolHash);
        persist();
      }
    },
    settle(context, outcome = {}) {
      const claim = getClaim(context);
      const { step } = claim;
      const executableTypes = new Set(["function_call", "custom_tool_call", "local_shell_call", "computer_call", "mcp_call", "tool_search_call"]);
      const toolDelivered = Boolean(outcome.deliveredExecutableToolDone || step.toolHashes.length
        || Array.isArray(outcome.toolItemTypes) && outcome.toolItemTypes.some(type => executableTypes.has(type))
        || Array.isArray(outcome.event?.response?.output) && outcome.event.response.output.some(item => executableTypes.has(item?.type)));
      const safeRetry = outcome.requestStarted === false || !step.toolHashes.length && !outcome.progressObserved
        && !toolDelivered && !outcome.sawReplayUnsafeContent && !outcome.sawSubstantiveWork
        && ["not_sent", "rejected"].includes(outcome.policy?.acceptance);
      if (toolDelivered) step.toolDelivered = true;
      step.state = outcome.kind === "completed" ? "COMPLETED" : safeRetry ? "RETRYABLE" : "UNKNOWN";
      step.updatedAt = now();
      const responseId = outcome.responseId ?? outcome.event?.response?.id;
      if (typeof responseId === "string") step.responseIdSha256 = sha256(responseId);
      claim.settled = true;
      persist();
      return { operationId: context.operationId, sequence: context.sequence, state: step.state };
    },
    revoke({ connectionToken } = {}) {
      checkReady();
      const tokenHash = typeof connectionToken === "string" ? sha256(connectionToken) : null;
      const connection = connections.get(tokenHash);
      if (!connection && retiredCandidateTokens.has(tokenHash)) return { revoked: true, revokedPermits: 0,
        reclaimedOperationIds: retiredCandidateTokens.get(tokenHash).filter(operationId => !operations.has(operationId)), reclaimedConnection: true };
      const revokedPermits = connection?.permits.length ?? 0;
      const reclaimedOperationIds = [];
      let reclaimedConnection = false;
      if (connection) {
        connection.revoked = true;
        for (const permit of connection.permits) {
          const step = operations.get(permit.operationId)?.steps.find(step => step.step === permit.step);
          if (step?.state === "AUTHORIZED") step.state = "REVOKED";
        }
        connection.permits = [];
        for (const operationId of connection.operationIds) {
          const operation = operations.get(operationId);
          if (operation && operation.steps.every(step => ["REVOKED", "EXPIRED"].includes(step.state))
            && ![...connections.values()].some(value => value.permits.some(permit => permit.operationId === operationId))) {
            operations.delete(operationId);
            reclaimedOperationIds.push(operationId);
          }
        }
        if (!connection.generationConsumed) {
          retiredCandidateTokens.set(tokenHash, [...reclaimedOperationIds]);
          connections.delete(tokenHash);
          reclaimedConnection = true;
        }
        persist();
      }
      return { revoked: Boolean(connection), revokedPermits, reclaimedOperationIds, reclaimedConnection };
    },
    close() {
      closed = true;
      for (const connection of connections.values()) { connection.revoked = true; connection.permits = []; }
    },
    status() {
      prune();
      const steps = [...operations.values()].flatMap(operation => operation.steps);
      return { persistent: Boolean(statePath), blocked, closed, operations: operations.size, steps: steps.length,
        pendingPermits: permitCount(), connections: [...connections.values()].filter(connection => !connection.revoked).length,
        sending: steps.filter(step => step.state === "SENDING").length, unknown: steps.filter(step => step.state === "UNKNOWN").length,
        completed: steps.filter(step => step.state === "COMPLETED").length, retryable: steps.filter(step => step.state === "RETRYABLE").length,
        maxOperations, maxSteps, maxConnections, maxPermits,
        operationSummaries: [...operations.values()].map(operation => {
          const executed = operation.steps.filter(step => ["SENDING", "UNKNOWN", "COMPLETED", "RETRYABLE"].includes(step.state));
          const last = executed[executed.length - 1];
          const completed = executed.filter(step => step.state === "COMPLETED");
          const lastCompleted = completed[completed.length - 1];
          return { operationId: operation.operationId, kind: operation.kind,
            pendingPermits: [...connections.values()].reduce((count, connection) => count
              + connection.permits.filter(permit => permit.operationId === operation.operationId).length, 0),
            sending: executed.filter(step => step.state === "SENDING").length,
            unknown: executed.filter(step => step.state === "UNKNOWN").length,
            awaitingToolContinuation: Boolean(lastCompleted?.toolDelivered),
            lastResponseCompletedWithoutTools: last?.state === "COMPLETED" && !last.toolDelivered,
            steps: operation.steps.map(step => ({ step: step.step, sequence: step.sequence, kind: step.kind, state: step.state,
              payloadSha256: step.payloadSha256, toolDelivered: Boolean(step.toolDelivered) })) };
        }) };
    },
  };
}
