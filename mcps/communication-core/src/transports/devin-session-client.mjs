import { createHash, randomUUID } from 'node:crypto';

const CLIENT_MESSAGE_ID = 'cognition.ai/clientMessageId';
const QUEUE_METHOD = '_cognition.ai/queuedMessages/update';
const DEFAULT_LIMITS = Object.freeze({ maxFrameBytes: 2097152, maxTextBytes: 270336, maxPending: 32, maxOperations: 128, maxWriteQueue: 32 });
const PERSIST_POLL_DELAYS_MS = Object.freeze([900, 1800, 3200, 5500, 8500]);
const STALE_TURN_RECONCILE_MS = 15000;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\r\n\u0000]/u.test(value);
}

function validSignal(signal) {
  return signal == null || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function extractConfigValue(options, targetId) {
  if (!Array.isArray(options)) return null;
  const entry = options.find(item => object(item) && item.id === targetId);
  return identifier(entry?.currentValue, 128) ? entry.currentValue : null;
}

export function createDevinSessionClient({
  sendLine,
  connectorId,
  sessionId,
  cwd,
  requestTimeoutMs = 10000,
  limits = {},
  evictSettled = false,
  allowStdioAcp = false,
  verifyPersisted,
  checkSessionIdle,
} = {}) {
  if (typeof sendLine !== 'function' || !identifier(connectorId) || !identifier(sessionId) || !identifier(cwd, 4096)) {
    throw new TypeError('sendLine, connectorId, sessionId and cwd are required');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 3600000) throw new TypeError('Invalid requestTimeoutMs');
  if (typeof allowStdioAcp !== 'boolean') throw new TypeError('Invalid allowStdioAcp');
  if (verifyPersisted !== undefined && typeof verifyPersisted !== 'function') throw new TypeError('Invalid verifyPersisted');
  if (checkSessionIdle !== undefined && typeof checkSessionIdle !== 'function') throw new TypeError('Invalid checkSessionIdle');
  if (!object(limits) || Object.keys(limits).some(key => !(key in DEFAULT_LIMITS))) throw new TypeError('Invalid limits');
  const budgets = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(budgets)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) throw new TypeError(`Invalid ${name}`);

  const connectionId = randomUUID();
  const operations = new Map();
  const deliveryIndex = new Map();
  const requests = new Map();
  const pollTimers = new Set();
  const writeQueue = [];
  let open = true;
  let initialized = false;
  let ready = false;
  let protocolVersion = null;
  let wireProtocolVersion = null;
  let daemonPid = null;
  let currentModel = null;
  let currentMode = null;
  let turnActive = false;
  let lastActivityAt = Date.now();
  let capabilities = { direct: false, queue: false, resume: false, load: false, daemon: false, local_idle_gate: false };
  let initializeRequest;
  let attachRequest;
  let writerRunning = false;
  let sequence = 0;
  let closedReason = null;
  const counters = { foreign_notifications: 0, unmatched_responses: 0, unsupported_requests: 0 };

  function touch() {
    lastActivityAt = Date.now();
  }

  function identity(messageId = null, deliveryId = null) {
    return {
      message_id: messageId,
      delivery_id: deliveryId,
      session_id: sessionId,
      connector_id: connectorId,
      connection_id: connectionId,
      protocol_version: protocolVersion,
      ...(daemonPid !== null ? { daemon_pid: daemonPid } : {}),
    };
  }

  function pendingCount() {
    let count = 0;
    for (const request of requests.values()) if (request.awaitingReply) count++;
    return count;
  }

  function evictSettledOperationsIfNeeded() {
    if (!evictSettled || operations.size < budgets.maxOperations) return;
    for (const [msgId, req] of operations.entries()) {
      if (operations.size < budgets.maxOperations) break;
      if (req.settled && !req.awaitingReply && req.outcome === 'accepted') {
        operations.delete(msgId);
        if (req.deliveryId) deliveryIndex.delete(req.deliveryId);
        requests.delete(req.id);
      }
    }
  }

  function snapshot(request) {
    return {
      ...identity(request.messageId, request.deliveryId),
      protocol_version: request.protocolVersion ?? protocolVersion,
      outcome: request.outcome,
      request_sent: request.sent,
      reason: request.reason ?? undefined,
      evidence: request.evidence ? structuredClone(request.evidence) : undefined,
      model_processing: request.modelProcessing ?? 'unknown',
      ui_visibility: request.uiVisibility ?? 'unknown',
    };
  }

  function unsent(input, outcome, reason) {
    return {
      ...identity(input?.message_id ?? null, input?.delivery_id ?? null),
      outcome,
      request_sent: false,
      reason,
      model_processing: 'unknown',
      ui_visibility: 'unknown',
    };
  }

  function clearPersistPoller(request) {
    if (request.persistTimer) {
      clearTimeout(request.persistTimer);
      pollTimers.delete(request.persistTimer);
      request.persistTimer = null;
    }
    request.persistPolling = false;
  }

  function clearInFlightGuard(request) {
    if (request.inFlightGuardTimer) {
      clearTimeout(request.inFlightGuardTimer);
      pollTimers.delete(request.inFlightGuardTimer);
      request.inFlightGuardTimer = null;
    }
  }

  function armInFlightGuardIfNeeded(request) {
    if (!open || request.responseReceived || !request.awaitingReply || request.inFlightGuardTimer) return;
    const guardMs = Math.max(requestTimeoutMs, 180000);
    const requiresLiveProcessForTurn = allowStdioAcp && !capabilities.daemon;
    const scheduleGuard = (delayMs) => {
      if (!open || request.responseReceived || !request.awaitingReply) return;
      const guard = setTimeout(async () => {
        pollTimers.delete(guard);
        request.inFlightGuardTimer = null;
        if (!open || request.responseReceived || !request.awaitingReply) return;
        if (requiresLiveProcessForTurn) {
          const idleElapsed = Date.now() - lastActivityAt;
          if (idleElapsed < guardMs) {
            scheduleGuard(Math.max(1000, guardMs - idleElapsed));
            return;
          }
          if (typeof checkSessionIdle === 'function') {
            try {
              const status = await checkSessionIdle({ sessionId });
              if (!open || request.responseReceived || !request.awaitingReply) return;
              if (status?.idle !== true) {
                scheduleGuard(guardMs);
                return;
              }
            } catch {
              if (!open || request.responseReceived || !request.awaitingReply) return;
              scheduleGuard(guardMs);
              return;
            }
          } else {
            scheduleGuard(guardMs);
            return;
          }
        }
        request.awaitingReply = false;
        if (request.method === 'session/prompt') turnActive = false;
        requests.delete(request.id);
      }, delayMs);
      guard.unref?.();
      request.inFlightGuardTimer = guard;
      pollTimers.add(guard);
    };
    scheduleGuard(guardMs);
  }

  function settle(request, outcome, reason, evidence) {
    clearPersistPoller(request);
    if (request.outcome !== 'accepted' || outcome === 'accepted') {
      request.outcome = outcome;
      request.reason = reason;
      if (evidence) request.evidence = evidence;
    }
    if (!request.settled) {
      request.settled = true;
      clearTimeout(request.timer);
      if (request.abortListener) request.signal?.removeEventListener('abort', request.abortListener);
      if (!request.responseReceived && request.awaitingReply && outcome === 'accepted' && request.method === 'session/prompt') {
        armInFlightGuardIfNeeded(request);
      } else if (!request.awaitingReply) {
        clearInFlightGuard(request);
        requests.delete(request.id);
      }
      const resolve = request.resolve;
      request.resolve = null;
      request.abortListener = null;
      resolve(snapshot(request));
    }
  }

  function abandon(request, reason) {
    request.expired = true;
    request.line = null;
    clearInFlightGuard(request);
    if (request.sent === false) {
      request.awaitingReply = false;
      requests.delete(request.id);
    }
    settle(request, request.sent === false ? 'failed_before_send' : 'unknown', reason);
  }

  function close(reason = 'client_closed') {
    if (!open) return describe();
    open = false;
    ready = false;
    turnActive = false;
    closedReason = identifier(reason, 128) ? reason : 'client_closed';
    for (const timer of pollTimers) clearTimeout(timer);
    pollTimers.clear();
    for (const request of [...requests.values()]) if (!request.responseReceived) abandon(request, closedReason);
    requests.clear();
    writeQueue.length = 0;
    return describe();
  }

  function startPersistPoller(request) {
    if (!verifyPersisted || request.method !== 'session/prompt' || !request.messageId || !request.deliveryId) return;
    request.persistPolling = true;
    let step = 0;
    const next = () => {
      if (!open || request.settled || !request.persistPolling || step >= PERSIST_POLL_DELAYS_MS.length) return;
      const timer = setTimeout(async () => {
        pollTimers.delete(timer);
        request.persistTimer = null;
        if (!open || request.settled || !request.persistPolling) return;
        try {
          const found = await verifyPersisted({
            sessionId,
            messageId: request.messageId,
            deliveryId: request.deliveryId,
            signal: request.signal,
          });
          if (found?.verified === true && !request.settled) {
            const evidence = {
              kind: 'persisted_session_node',
              rpc_id: request.id,
              ...binding(),
              ...(Number.isSafeInteger(found.node_id) ? { node_id: found.node_id } : {}),
              ...(typeof found.created_at === 'string' ? { persisted_at: found.created_at } : {}),
              turn_complete: false,
            };
            request.receipt = evidence;
            settle(request, 'accepted', undefined, evidence);
            return;
          }
        } catch {}
        step += 1;
        next();
      }, PERSIST_POLL_DELAYS_MS[step]);
      timer.unref?.();
      request.persistTimer = timer;
      pollTimers.add(timer);
    };
    next();
  }

  async function drainWrites() {
    if (writerRunning) return;
    writerRunning = true;
    try {
      while (open && writeQueue.length) {
        const job = writeQueue.shift();
        if (job.reply) {
          await sendLine(job.reply);
          continue;
        }
        const request = job.request;
        if (request.expired) continue;
        const hook = request.hook;
        request.hook = null;
        try {
          if (hook) await hook({ ...identity(request.messageId, request.deliveryId), rpc_id: request.id, method: request.method });
        } catch {
          abandon(request, 'on_request_started_failed');
          continue;
        }
        if (!open || request.expired || request.signal?.aborted) {
          if (!request.expired) abandon(request, open ? 'cancelled_before_send' : closedReason);
          continue;
        }
        const line = request.line;
        request.line = null;
        request.sent = true;
        touch();
        if (request.method === 'session/prompt') turnActive = true;
        try {
          await sendLine(line);
          startPersistPoller(request);
        } catch {
          if (!request.responseReceived) {
            request.sent = 'unknown';
            request.awaitingReply = false;
            settle(request, 'unknown', 'write_failed_may_have_sent');
          }
          close('write_failed');
        }
      }
    } catch {
      close('reply_write_failed');
    } finally {
      writerRunning = false;
    }
  }

  function issue(method, params, { input, signal, hook, onResult, timeoutOverrideMs } = {}) {
    const id = `${connectionId}:${++sequence}`;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(line) > budgets.maxFrameBytes) return { immediate: unsent(input, 'failed_before_send', 'frame_budget') };
    if (!open) return { immediate: unsent(input, 'failed_before_send', closedReason) };
    if (signal?.aborted) return { immediate: unsent(input, 'failed_before_send', 'cancelled_before_send') };
    if (pendingCount() >= budgets.maxPending || writeQueue.length >= budgets.maxWriteQueue) return { immediate: unsent(input, 'busy', 'pending_budget') };
    const effectiveTimeout = timeoutOverrideMs ?? requestTimeoutMs;
    const request = {
      id, method, line, signal, hook, onResult, messageId: input?.message_id ?? null, deliveryId: input?.delivery_id ?? null,
      protocolVersion, sent: false, outcome: 'unknown', awaitingReply: true, responseReceived: false, expired: false, settled: false,
      persistTimer: null, persistPolling: false, inFlightGuardTimer: null,
    };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    request.timer = setTimeout(() => abandon(request, request.sent === false ? 'timeout_before_send' : 'response_timeout'), effectiveTimeout);
    request.timer.unref?.();
    request.abortListener = () => abandon(request, request.sent === false ? 'cancelled_before_send' : 'cancelled_after_send');
    if (signal) signal.addEventListener('abort', request.abortListener, { once: true });
    requests.set(id, request);
    writeQueue.push({ request });
    return { request };
  }

  function start(issued) {
    if (issued.immediate) return Promise.resolve(issued.immediate);
    void drainWrites();
    return issued.request.settled ? Promise.resolve(snapshot(issued.request)) : issued.request.promise;
  }

  function binding() {
    return {
      session_id: sessionId,
      connector_id: connectorId,
      connection_id: connectionId,
      protocol_version: protocolVersion,
      ...(daemonPid !== null ? { daemon_pid: daemonPid } : {}),
    };
  }

  function initialize({ signal } = {}) {
    if (!validSignal(signal)) return Promise.resolve(unsent(null, 'failed_before_send', 'invalid_signal'));
    if (initializeRequest) return initializeRequest.settled ? Promise.resolve(snapshot(initializeRequest)) : initializeRequest.promise;
    const clientCapabilities = {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { terminal: false },
    };
    const clientInfo = { name: 'core-daemon-session-client', version: '0.1.0' };
    const issued = issue('initialize', {
      protocolVersion: 2,
      clientCapabilities,
      clientInfo,
    }, { signal, onResult(result, request) {
      if (!object(result) || !object(result.agentCapabilities)) {
        settle(request, 'unknown', 'unsupported_initialize_protocol');
        return;
      }
      const agent = result.agentCapabilities;
      const daemonInfo = result._meta?.['cognition.ai/daemon'];
      const isDaemonV2 = result.protocolVersion === 1
        && agent._meta?.['cognition.ai/daemon'] === true
        && object(daemonInfo)
        && Number.isSafeInteger(daemonInfo.protocolVersion)
        && daemonInfo.protocolVersion >= 2;
      const hasResume = object(agent.sessionCapabilities?.resume);
      const isStdioAcp = allowStdioAcp
        && !isDaemonV2
        && (result.protocolVersion === 1 || result.protocolVersion === 2)
        && (agent.loadSession === true || hasResume);
      if (result.protocolVersion !== 2 && !isDaemonV2 && !isStdioAcp) {
        settle(request, 'unknown', 'unsupported_initialize_protocol');
        return;
      }
      wireProtocolVersion = result.protocolVersion;
      protocolVersion = result.protocolVersion === 2 ? 2 : (isDaemonV2 ? daemonInfo.protocolVersion : 2);
      daemonPid = isDaemonV2 && Number.isSafeInteger(daemonInfo.pid) && daemonInfo.pid > 0 ? daemonInfo.pid : null;
      initialized = true;
      const hasLoad = agent.loadSession === true && (isDaemonV2 || isStdioAcp);
      capabilities = {
        direct: agent._meta?.['cognition.ai/midTurnPrompts'] === true,
        queue: agent._meta?.['cognition.ai/queuedMessages'] === true,
        resume: hasResume,
        load: hasLoad,
        daemon: isDaemonV2 || agent._meta?.['cognition.ai/daemon'] === true,
        local_idle_gate: (isDaemonV2 || isStdioAcp) && typeof checkSessionIdle === 'function',
      };
      settle(request, 'accepted', undefined, { kind: 'initialize_ack', rpc_id: request.id, wire_protocol_version: wireProtocolVersion, ...binding() });
    } });
    initializeRequest = issued.request;
    return start(issued);
  }

  function authenticate({ apiKey, apiServerUrl = 'https://server.codeium.com', signal } = {}) {
    if (!identifier(apiKey, 4096) || !identifier(apiServerUrl, 512) || !validSignal(signal)) {
      return Promise.resolve(unsent(null, 'failed_before_send', 'invalid_auth_input'));
    }
    if (!initialized) return Promise.resolve(unsent(null, 'failed_before_send', 'initialize_required'));
    const issued = issue('authenticate', {
      methodId: 'windsurf-api-key',
      _meta: { api_key: apiKey, api_server_url: apiServerUrl },
    }, {
      signal,
      onResult(result, request) {
        if (!object(result)) {
          settle(request, 'unknown', 'invalid_auth_response');
          return;
        }
        touch();
        settle(request, 'accepted', undefined, { kind: 'authenticate_ack', rpc_id: request.id, ...binding() });
      },
    });
    return start(issued);
  }

  function attach({ signal } = {}) {
    if (!validSignal(signal)) return Promise.resolve(unsent(null, 'failed_before_send', 'invalid_signal'));
    if (attachRequest) return attachRequest.settled ? Promise.resolve(snapshot(attachRequest)) : attachRequest.promise;
    if (!initialized || (!capabilities.resume && !capabilities.load)) {
      return Promise.resolve(unsent(null, 'failed_before_send', initialized ? 'resume_unsupported' : 'initialize_required'));
    }
    const useResume = capabilities.resume;
    const method = useResume ? 'session/resume' : 'session/load';
    const params = useResume
      ? { sessionId, cwd, mcpServers: [] }
      : { sessionId, cwd, mcpServers: [], _meta: { 'cognition.ai/replayFrom': { type: 'tail', count: 0 } } };
    const issued = issue(method, params, { signal, onResult(result, request) {
      if (!object(result) || (result.sessionId !== undefined && result.sessionId !== sessionId)) {
        settle(request, 'unknown', 'resume_session_mismatch');
        close('resume_session_mismatch');
        return;
      }
      if (Array.isArray(result.configOptions)) {
        currentModel = extractConfigValue(result.configOptions, 'model') ?? currentModel;
        currentMode = extractConfigValue(result.configOptions, 'mode') ?? currentMode;
      }
      if (identifier(result.modes?.currentModeId, 128)) currentMode = result.modes.currentModeId;
      turnActive = false;
      ready = true;
      touch();
      settle(request, 'accepted', undefined, { kind: useResume ? 'resume_ack' : 'load_ack', rpc_id: request.id, ...binding() });
    } });
    attachRequest = issued.request;
    return start(issued);
  }

  function clearStaleTurnActive() {
    for (const req of [...requests.values()]) {
      if (req.method === 'session/prompt' && req.settled && req.outcome === 'accepted' && req.awaitingReply) {
        req.awaitingReply = false;
        clearInFlightGuard(req);
        requests.delete(req.id);
      }
    }
    if (turnActive && pendingCount() === 0 && writeQueue.length === 0) {
      turnActive = false;
      return true;
    }
    return false;
  }

  async function isIdleForQueue({ signal } = {}) {
    if (!open || !ready) return { idle: false, reason: 'not_ready' };
    for (const req of requests.values()) {
      if (req.method === 'session/prompt' && req.awaitingReply && !(req.settled && req.outcome === 'accepted' && Date.now() - lastActivityAt > STALE_TURN_RECONCILE_MS)) {
        return { idle: false, reason: 'prompt_in_flight' };
      }
    }
    if (typeof checkSessionIdle !== 'function') {
      return turnActive ? { idle: false, reason: 'live_turn_active' } : { idle: false, reason: 'idle_probe_missing' };
    }
    if (turnActive && Date.now() - lastActivityAt <= STALE_TURN_RECONCILE_MS) {
      return { idle: false, reason: 'live_turn_active' };
    }
    try {
      const status = await checkSessionIdle({ sessionId, signal });
      if (status?.idle === true) {
        clearStaleTurnActive();
        if (turnActive && pendingCount() === 0) turnActive = false;
        return pendingCount() === 0 ? { idle: true } : { idle: false, reason: 'prompt_in_flight' };
      }
      return { idle: false, reason: status?.reason ?? (turnActive ? 'live_turn_active' : 'session_busy_or_unverified') };
    } catch {
      return { idle: false, reason: 'idle_probe_error' };
    }
  }

  function setConfigOption({ configId, value, signal } = {}) {
    if (!identifier(configId, 64) || !identifier(value, 128) || !validSignal(signal)) {
      return Promise.resolve(unsent(null, 'failed_before_send', 'invalid_config_option'));
    }
    if (!open || !ready) return Promise.resolve(unsent(null, 'busy', 'not_ready'));
    const issued = issue('session/set_config_option', { sessionId, configId, value }, {
      signal,
      onResult(result, request) {
        if (!object(result)) {
          settle(request, 'unknown', 'invalid_config_response');
          return;
        }
        if (Array.isArray(result.configOptions)) {
          currentModel = extractConfigValue(result.configOptions, 'model') ?? currentModel;
          currentMode = extractConfigValue(result.configOptions, 'mode') ?? currentMode;
        }
        touch();
        settle(request, 'accepted', undefined, { kind: 'config_option_ack', rpc_id: request.id, config_id: configId, value, model_id: currentModel, mode_id: currentMode, ...binding() });
      },
    });
    return start(issued);
  }

  function deliver(input = {}) {
    if (!object(input) || !identifier(input.message_id) || !identifier(input.delivery_id) || typeof input.text !== 'string' || input.text.length === 0 || !validSignal(input.signal) || (input.onRequestStarted !== undefined && typeof input.onRequestStarted !== 'function')) {
      return Promise.resolve(unsent(input, 'failed_before_send', 'invalid_input'));
    }
    if ((input.session_id !== undefined && input.session_id !== sessionId) || (input.connector_id !== undefined && input.connector_id !== connectorId) || (input.connection_id !== undefined && input.connection_id !== connectionId)) {
      return Promise.resolve(unsent(input, 'failed_before_send', 'target_mismatch'));
    }
    const policy = input.policy ?? 'next_model_boundary';
    if (policy !== 'next_model_boundary' && policy !== 'when_idle') return Promise.resolve(unsent(input, 'failed_before_send', 'unsupported_policy'));
    if (Buffer.byteLength(input.text) > budgets.maxTextBytes) return Promise.resolve(unsent(input, 'failed_before_send', 'text_budget'));
    const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, input.message_id, input.delivery_id, policy, input.text])).digest('hex');
    const known = operations.get(input.message_id) ?? deliveryIndex.get(input.delivery_id);
    if (known) {
      if (known.fingerprint !== fingerprint) return Promise.resolve(unsent(input, 'failed_before_send', 'id_conflict'));
      return known.settled ? Promise.resolve(snapshot(known)) : known.promise;
    }
    if (!open) return Promise.resolve(unsent(input, 'failed_before_send', closedReason));
    if (!ready) return Promise.resolve(unsent(input, 'busy', 'not_ready'));
    if (!(policy === 'when_idle' ? capabilities.queue : capabilities.direct)) return Promise.resolve(unsent(input, 'failed_before_send', 'mode_unsupported'));
    evictSettledOperationsIfNeeded();
    if (operations.size >= budgets.maxOperations) return Promise.resolve(unsent(input, 'busy', 'operation_budget'));
    const queued = policy === 'when_idle';
    const method = queued ? QUEUE_METHOD : 'session/prompt';
    const params = queued
      ? { sessionId, op: 'add', id: input.message_id, message: { message: input.text } }
      : { sessionId, prompt: [{ type: 'text', text: input.text }], _meta: { [CLIENT_MESSAGE_ID]: input.message_id } };
    const promptTimeoutMs = !queued && verifyPersisted ? Math.max(requestTimeoutMs, 180000) : requestTimeoutMs;
    const issued = issue(method, params, {
      input,
      signal: input.signal,
      hook: input.onRequestStarted,
      timeoutOverrideMs: promptTimeoutMs,
      onResult(result, request) {
        if (!queued) turnActive = false;
        if (!object(result) || (result.sessionId !== undefined && result.sessionId !== sessionId)) {
          settle(request, 'unknown', 'invalid_delivery_response');
          return;
        }
        const messageId = result._meta?.['cognition.ai/streamingMessageId'] ?? result.messageId;
        const stopReason = typeof result.stopReason === 'string' && result.stopReason.length <= 128 ? result.stopReason : undefined;
        if (queued || identifier(messageId) || stopReason) {
          const evidence = { kind: queued ? 'queue_ack' : stopReason ? 'direct_completion' : 'direct_receipt', rpc_id: request.id, ...binding() };
          if (identifier(messageId)) evidence.native_message_id = messageId;
          if (stopReason) evidence.stop_reason = stopReason;
          evidence.turn_complete = Boolean(stopReason);
          request.receipt = evidence;
          settle(request, 'accepted', undefined, evidence);
        } else settle(request, 'unknown', 'prompt_receipt_missing');
      },
    });
    if (issued.request) {
      issued.request.fingerprint = fingerprint;
      issued.request.policy = policy;
      operations.set(input.message_id, issued.request);
      deliveryIndex.set(input.delivery_id, issued.request);
    }
    return start(issued);
  }

  function query({ message_id, delivery_id } = {}) {
    const request = operations.get(message_id);
    if (request && request.deliveryId === delivery_id) return snapshot(request);
    return {
      ...identity(message_id ?? null, delivery_id ?? null),
      outcome: 'unknown',
      request_sent: 'unknown',
      reason: 'receipt_not_in_this_connection',
      model_processing: 'unknown',
      ui_visibility: 'unknown',
    };
  }

  function describe() {
    return {
      ...binding(),
      ready: open && ready,
      initialized: open && initialized,
      closed: !open,
      closed_reason: closedReason,
      turn_active: open && turnActive,
      last_activity_at: lastActivityAt,
      capabilities: {
        direct: open && capabilities.direct,
        queue: open && capabilities.queue,
        resume: open && capabilities.resume,
      },
      daemon_capabilities: {
        load: open && capabilities.load,
        daemon: open && capabilities.daemon,
        local_idle_gate: open && capabilities.local_idle_gate,
      },
      mode_evidence: initialized ? {
        ...binding(),
        source: 'initialize.agentCapabilities',
        direct: capabilities.direct,
        queue: capabilities.queue,
        resume: capabilities.resume,
      } : null,
      model_id: currentModel,
      mode_id: currentMode,
      model_processing: 'unknown',
      ui_visibility: 'unknown',
      limits: { ...budgets },
      retained_operations: operations.size,
      awaiting_responses: pendingCount(),
      queued_writes: writeQueue.length,
      can_detach_safely: open && ready && !writerRunning && writeQueue.length === 0
        && (!(allowStdioAcp && !capabilities.daemon) || (!turnActive && pendingCount() === 0))
        && [...requests.values()].every(r => r.settled && r.outcome === 'accepted'),
      counters: { ...counters },
    };
  }

  function feedLine(line) {
    if (!open) return { status: 'closed', reason: closedReason };
    if (line === null) { close('eof'); return { status: 'closed', reason: 'eof' }; }
    if (typeof line !== 'string' || Buffer.byteLength(line) > budgets.maxFrameBytes) {
      close('frame_budget_or_type');
      return { status: 'closed', reason: 'frame_budget_or_type' };
    }
    let frame;
    try { frame = JSON.parse(line); } catch { close('invalid_json'); return { status: 'closed', reason: 'invalid_json' }; }
    const hasId = object(frame) && Object.hasOwn(frame, 'id');
    const hasMethod = object(frame) && Object.hasOwn(frame, 'method');
    const hasResult = object(frame) && Object.hasOwn(frame, 'result');
    const hasError = object(frame) && Object.hasOwn(frame, 'error');
    const validId = !hasId || (identifier(frame.id, 512) || (Number.isSafeInteger(frame.id) && frame.id >= 0));
    if (!object(frame) || frame.jsonrpc !== '2.0' || !validId || (hasMethod ? !identifier(frame.method) || hasResult || hasError : !hasId || hasResult === hasError)) {
      close('invalid_rpc_frame');
      return { status: 'closed', reason: 'invalid_rpc_frame' };
    }
    touch();
    if (hasMethod) {
      if (hasId) {
        counters.unsupported_requests++;
        if (writeQueue.length >= budgets.maxWriteQueue) { close('reply_budget'); return { status: 'closed', reason: 'reply_budget' }; }
        const reason = frame.params?.sessionId !== undefined && frame.params.sessionId !== sessionId ? 'foreign_session' : 'client_method_unsupported';
        const reply = JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Client method not supported', data: { method: frame.method, reason } } }) + '\n';
        if (Buffer.byteLength(reply) > budgets.maxFrameBytes) { close('reply_frame_budget'); return { status: 'closed', reason: 'reply_frame_budget' }; }
        writeQueue.push({ reply });
        void drainWrites();
        return { status: 'unsupported_request', method: frame.method };
      }
      if (frame.params?.sessionId !== undefined && frame.params.sessionId !== sessionId) {
        counters.foreign_notifications++;
        return { status: 'foreign_notification' };
      }
      if (frame.method === '_cognition.ai/turn_stats') {
        if (ready) turnActive = true;
        return { status: 'ignored_notification' };
      }
      if (frame.method === '_cognition.ai/agent_stopped') {
        turnActive = false;
        return { status: 'ignored_notification' };
      }
      const update = frame.params?.update;
      if (frame.method !== 'session/update' || !object(update)) return { status: 'ignored_notification' };
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        currentModel = extractConfigValue(update.configOptions, 'model') ?? currentModel;
        currentMode = extractConfigValue(update.configOptions, 'mode') ?? currentMode;
        return { status: 'ignored_notification' };
      }
      if (update.sessionUpdate === 'current_mode_update' && identifier(update.currentModeId, 128)) {
        currentMode = update.currentModeId;
        return { status: 'ignored_notification' };
      }
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        if (ready) turnActive = true;
        return { status: 'ignored_notification' };
      }
      if (update.sessionUpdate !== 'user_message_chunk') return { status: 'ignored_notification' };
      const messageId = update._meta?.[CLIENT_MESSAGE_ID];
      const request = operations.get(messageId);
      if (!request || request.sent === false || update._meta?.['cognition.ai/isOptimistic'] === true || update._meta?.['cognition.ai/unconfirmed'] === true) {
        return { status: 'unmatched_echo' };
      }
      const evidence = { kind: request.policy === 'when_idle' ? 'queue_echo' : 'direct_echo', rpc_id: request.id, ...binding(), client_message_id: messageId, turn_complete: request.receipt?.turn_complete === true };
      request.echo = evidence;
      if (!verifyPersisted) {
        settle(request, 'accepted', undefined, request.receipt ?? evidence);
      }
      return { status: 'matched_echo', message_id: messageId, delivery_id: request.deliveryId };
    }
    const request = requests.get(frame.id);
    if (!request || request.sent === false || request.responseReceived) {
      counters.unmatched_responses++;
      return { status: 'unmatched_response' };
    }
    request.responseReceived = true;
    request.awaitingReply = false;
    clearInFlightGuard(request);
    if (request.method === 'session/prompt') turnActive = false;
    if (hasError) {
      const code = Number.isSafeInteger(frame.error?.code) ? frame.error.code : null;
      settle(request, 'unknown', 'native_rpc_error', { kind: 'rpc_error', rpc_id: request.id, code, ...binding() });
    } else request.onResult(frame.result, request);
    requests.delete(request.id);
    return { status: 'matched_response', rpc_id: request.id };
  }

  return Object.freeze({ initialize, authenticate, attach, clearStaleTurnActive, isIdleForQueue, setConfigOption, deliver, query, describe, feedLine, close });
}
