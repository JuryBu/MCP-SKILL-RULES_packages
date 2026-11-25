import crypto from "node:crypto";
import { createNativeProcessConnectionVerifier } from "./native-process-connection-identity.mjs";
import { classifyInternalMemoryRequest, classifyInternalMemoryPrewarmRequest, internalMemoryPayloadSha256, internalMemoryRejectionDiagnostics, INTERNAL_MEMORY_CONNECTION_HEADER } from "./internal-memory-request-authority.mjs";
import { nativeResponseMetadataHeader } from "./native-responses-ws-bridge.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameIdentity = (first, second) => first && second && ["pid", "parentPid", "creationTime", "executablePath", "generation"]
  .every(key => first[key] === second[key]);

export function createInnerInternalMemoryRouter(options) {
  const operations = new Map();
  const bindings = new Set();
  const sockets = new WeakMap();
  const socketHashes = new WeakMap();
  const now = options.now ?? Date.now;
  const verifier = options.verifier ?? createNativeProcessConnectionVerifier({ getExpectedIdentity: options.getExpectedIdentity });
  const secret = crypto.randomBytes(32);
  const summary = value => typeof value === "string" || Buffer.isBuffer(value)
    ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
  let closed = false;
  let snapshotRevision = 0;
  const changed = () => {
    if (snapshotRevision >= Number.MAX_SAFE_INTEGER) fail("INTERNAL_MEMORY_REVISION_LIMIT");
    snapshotRevision += 1;
  };

  const workerReady = worker => options.isWorkerAlive(worker) && !worker.recoveryTask && !worker.recoveryError
    && Number.isSafeInteger(worker.ready?.status?.port) && worker.ready.status.port > 0 && worker.ready.status.port < 65536;
  const pinWorker = worker => ({ child: worker.child, pid: worker.child.pid,
    instanceToken: worker.ready.instanceToken, port: worker.ready.status.port });
  const workerMatches = (worker, pinned) => workerReady(worker) && worker.child === pinned.child
    && worker.child.pid === pinned.pid && worker.ready.instanceToken === pinned.instanceToken
    && worker.ready.status.port === pinned.port;
  const requireOpen = request => {
    if (closed || options.isClosing()) fail("COORDINATOR_CLOSING");
    if (request.aborted || !request.socket || request.socket.destroyed) fail("INTERNAL_MEMORY_CONNECTION_CLOSED");
  };
  const emitDiagnostic = event => { try { options.onEvent?.(event); } catch {} };
  const bindingDiagnostics = binding => internalMemoryRejectionDiagnostics({ schemaVersion: 1, socketHash: binding.socketHash,
    connectionHash: summary(binding.token), workerPid: binding.workerPin.pid, workerInstanceHash: summary(binding.workerPin.instanceToken) });

  function reclaimOperation(key, operation) {
    if (operation.reclaimable && operation.inFlight === 0 && operations.get(key) === operation) {
      changed();
      operations.delete(key);
    }
  }

  function retire(binding) {
    if (binding.closed) return;
    binding.closed = true;
    binding.abort.abort();
    bindings.delete(binding);
    changed();
    emitDiagnostic({ type: "internal_memory_connection_retired", quarantined: binding.quarantined,
      diagnostics: bindingDiagnostics(binding) });
    const candidates = [...operations].filter(([, operation]) => operation.worker === binding.worker)
      .map(([key, operation]) => ({ key, operation, revision: operation.revision }));
    options.control(binding.worker, "revokeInternalMemoryConnection", {
      connectionToken: binding.token, reason: "native_connection_closed",
    }).then(result => {
      if (result?.revoked !== true || !Array.isArray(result.reclaimedOperationIds)
        || !workerMatches(binding.worker, binding.workerPin)) return;
      for (const candidate of candidates) {
        if (candidate.operation.revision !== candidate.revision || !result.reclaimedOperationIds.includes(candidate.operation.operationId)) continue;
        candidate.operation.reclaimable = true;
        reclaimOperation(candidate.key, candidate.operation);
      }
    }).catch(() => {});
  }

  function bind(request, worker, identity) {
    let workers = sockets.get(request.socket);
    if (!workers) { workers = new Map(); sockets.set(request.socket, workers); }
    let binding = workers.get(worker);
    if (binding) {
      if (binding.closed || binding.quarantined || !sameIdentity(binding.identity, identity)
        || !workerMatches(worker, binding.workerPin)) {
        emitDiagnostic({ type: "internal_memory_connection_rejected", code: "INTERNAL_MEMORY_CONNECTION_CHANGED",
          diagnostics: bindingDiagnostics(binding) });
        fail("INTERNAL_MEMORY_CONNECTION_CHANGED");
      }
      return binding;
    }
    if (!socketHashes.has(request.socket)) socketHashes.set(request.socket, summary(crypto.randomBytes(32)));
    binding = { worker, workerPin: pinWorker(worker), socket: request.socket, socketHash: socketHashes.get(request.socket),
      identity, token: crypto.randomBytes(32).toString("hex"), sequence: 0,
      closed: false, quarantined: false, abort: new AbortController(), pending: Promise.resolve() };
    workers.set(worker, binding);
    bindings.add(binding);
    changed();
    request.socket.once("close", () => retire(binding));
    return binding;
  }

  function validateBinding(request, binding, identity) {
    try {
      requireOpen(request);
      if (binding.closed || !workerMatches(binding.worker, binding.workerPin)) fail("COORDINATOR_WORKER_UNAVAILABLE");
      if (typeof options.getExpectedIdentity.isCurrent === "function"
        && options.getExpectedIdentity.isCurrent(identity) !== true) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
    } catch (error) {
      binding.quarantined = true;
      retire(binding);
      throw error;
    }
  }

  async function prepareConnection({ payload, request }) {
    if (!classifyInternalMemoryPrewarmRequest(payload)) return null;
    const requestPath = String(request.url ?? "").split("?")[0];
    if (!["/v1/responses", "/backend-api/codex/responses"].includes(requestPath)) fail("INTERNAL_MEMORY_REQUEST_PATH_INVALID");
    requireOpen(request);
    const worker = options.getDefaultWorker();
    if (!workerReady(worker)) fail("COORDINATOR_WORKER_UNAVAILABLE");
    const pinned = pinWorker(worker);
    const verified = await verifier.verify(request.socket);
    requireOpen(request);
    if (!verified.trusted) fail(`INTERNAL_MEMORY_${verified.code}`);
    if (!workerMatches(worker, pinned)) fail("COORDINATOR_WORKER_UNAVAILABLE");
    const current = await options.getExpectedIdentity({});
    requireOpen(request);
    if (!sameIdentity(verified.identity, current)) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
    if (!workerMatches(worker, pinned)) fail("COORDINATOR_WORKER_UNAVAILABLE");
    const binding = bind(request, worker, verified.identity);
    const validate = () => validateBinding(request, binding, verified.identity);
    const task = binding.pending.then(async () => {
      try {
        validate();
        const result = await options.control(worker, "prepareInternalMemoryConnection", { connection: {
          connectionToken: binding.token, nativeGeneration: verified.identity.generation, nativePid: verified.identity.pid,
          requestPath, payloadSha256: internalMemoryPayloadSha256(payload),
        } });
        if (result?.prepared !== true) fail("INTERNAL_MEMORY_PREWARM_REGISTRATION_UNKNOWN");
        const latest = await options.getExpectedIdentity({ signal: binding.abort.signal });
        if (!sameIdentity(verified.identity, latest)) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
        validate();
        const headers = { ...request.headers };
        for (const key of Object.keys(headers)) if ([INTERNAL_MEMORY_CONNECTION_HEADER, "x-codex-turn-metadata"].includes(key.toLowerCase())) delete headers[key];
        headers[INTERNAL_MEMORY_CONNECTION_HEADER] = binding.token;
        return { state: { worker, threadId: null, turnId: null, activeHttp: 0 }, headers, validate };
      } catch (error) {
        binding.quarantined = true;
        retire(binding);
        throw error;
      }
    });
    binding.pending = task.catch(() => {});
    return task;
  }

  async function acquire({ payload = null, request }) {
    const descriptor = classifyInternalMemoryRequest(payload, request.headers);
    if (!descriptor) return null;
    const requestPath = String(request.url ?? "").split("?")[0];
    const allowed = descriptor.kind === "compaction"
      ? ["/v1/responses", "/backend-api/codex/responses", "/v1/responses/compact", "/backend-api/codex/responses/compact"]
      : ["/v1/responses", "/backend-api/codex/responses"];
    if (!allowed.includes(requestPath) || payload === null && request.method !== "POST") fail("INTERNAL_MEMORY_REQUEST_PATH_INVALID");
    requireOpen(request);
    const verified = await verifier.verify(request.socket);
    requireOpen(request);
    if (!verified.trusted) fail(`INTERNAL_MEMORY_${verified.code}`);
    const identity = verified.identity;
    const current = await options.getExpectedIdentity({});
    requireOpen(request);
    if (!sameIdentity(identity, current)) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
    const parentKind = descriptor.kind === "extract" ? "extract" : "consolidate";
    const operationKey = JSON.stringify([identity.generation, parentKind, descriptor.nativeThreadId, descriptor.nativeTurnId]);
    let operation = operations.get(operationKey);
    if (!operation) {
      if (descriptor.kind === "compaction") fail("INTERNAL_MEMORY_OPERATION_NOT_AUTHORIZED");
      if (operations.size >= 256) fail("INTERNAL_MEMORY_OPERATION_LIMIT");
      const worker = options.getDefaultWorker();
      if (!workerReady(worker)) fail("COORDINATOR_WORKER_UNAVAILABLE");
      const operationId = `internal-${crypto.createHmac("sha256", secret).update(operationKey).digest("hex")}`;
      operation = { operationId, worker, workerPin: pinWorker(worker), threadId: null, turnId: null, activeHttp: 0,
        inFlight: 0, revision: 0, reclaimable: false };
      operations.set(operationKey, operation);
      let activeHttp = 0;
      Object.defineProperty(operation, "activeHttp", { enumerable: true, get: () => activeHttp, set: value => {
        if (value !== activeHttp) { changed(); activeHttp = value; }
      } });
      changed();
    }
    if (!workerMatches(operation.worker, operation.workerPin)) fail("COORDINATOR_WORKER_UNAVAILABLE");
    operation.inFlight += 1;
    operation.revision += 1;
    changed();
    operation.reclaimable = false;
    try {
      const binding = bind(request, operation.worker, identity);
      const authorize = async () => {
        requireOpen(request);
        if (binding.closed || binding.quarantined || !workerMatches(operation.worker, operation.workerPin)) fail("INTERNAL_MEMORY_CONNECTION_CHANGED");
        const latest = await options.getExpectedIdentity({ signal: binding.abort.signal });
        requireOpen(request);
        if (binding.closed || !sameIdentity(identity, latest)) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
        if (!workerMatches(operation.worker, operation.workerPin)) fail("COORDINATOR_WORKER_UNAVAILABLE");
        let constructedAt;
        const grant = { operationId: operation.operationId, nativeGeneration: identity.generation, nativePid: identity.pid,
          connectionToken: binding.token, sequence: ++binding.sequence, kind: descriptor.kind,
          nativeThreadId: descriptor.nativeThreadId, nativeTurnId: descriptor.nativeTurnId, requestPath,
          metadata: descriptor.metadata, payloadSha256: payload === null ? null : internalMemoryPayloadSha256(payload),
          expiresAt: (constructedAt = now()) + 120000, diagnostics: { ...bindingDiagnostics(binding), constructedAt } };
        operation.revision += 1;
        changed();
        operation.reclaimable = false;
        try {
          await options.control(operation.worker, "authorizeInternalMemory", { grant });
          requireOpen(request);
          const confirmed = await options.getExpectedIdentity({ signal: binding.abort.signal });
          requireOpen(request);
          if (binding.closed || !sameIdentity(identity, confirmed)) fail("INTERNAL_MEMORY_IDENTITY_CHANGED");
          if (!workerMatches(operation.worker, operation.workerPin)) fail("COORDINATOR_WORKER_UNAVAILABLE");
          const validate = () => validateBinding(request, binding, identity);
          const headers = { ...request.headers };
          for (const key of Object.keys(headers)) if (key.toLowerCase() === INTERNAL_MEMORY_CONNECTION_HEADER) delete headers[key];
          headers[INTERNAL_MEMORY_CONNECTION_HEADER] = binding.token;
          headers["x-codex-turn-metadata"] = nativeResponseMetadataHeader(descriptor.metadata);
          options.onEvent?.({ type: "internal_memory_authorized", kind: descriptor.kind, workerId: operation.worker.workerId });
          validate();
          return { state: operation, headers, validate };
        } catch (error) {
          emitDiagnostic({ type: "internal_memory_authorization_rejected", code: error.code,
            diagnostics: internalMemoryRejectionDiagnostics({ ...bindingDiagnostics(binding), constructedAt,
              operationHash: summary(operation.operationId), sequence: grant.sequence }) });
          binding.quarantined = true;
          retire(binding);
          throw error;
        }
      };
      const task = binding.pending.then(authorize);
      binding.pending = task.catch(() => {});
      return await task;
    } finally {
      operation.inFlight -= 1;
      changed();
      reclaimOperation(operationKey, operation);
    }
  }

  function dispose() {
    if (closed) return;
    closed = true;
    for (const binding of bindings) retire(binding);
    verifier.dispose();
  }

  return Object.freeze({ acquire, prepareConnection, dispose,
    operationSnapshot: () => ({ revision: snapshotRevision, operations: [...operations.values()].map(operation => ({
      operationId: operation.operationId, workerId: operation.worker.workerId, activeHttp: operation.activeHttp,
    })) }),
    status: () => ({ operations: operations.size, connections: bindings.size }) });
}
