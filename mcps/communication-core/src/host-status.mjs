import { codexModelObservation, projectModelObservation, unknownModelObservation } from "./host-model-observation.mjs";

const UNKNOWN = "unknown";
const REMOTE_STATUS_TIMEOUT_MS = 15000;
const MODES = ["next_model_boundary", "when_idle"];
const RUNNING = new Set(["RUNNING", "CASCADE_RUN_STATUS_RUNNING"]);
const IDLE = new Set(["IDLE", "NOT_LOADED", "CASCADE_RUN_STATUS_IDLE", "CASCADE_RUN_STATUS_NOT_LOADED"]);
const ERROR_CODES = new Set([
  "ls_target_unavailable", "ls_target_ambiguous", "ls_target_mismatch", "ls_discovery_failed",
  "ls_cancelled", "ls_timeout", "ls_closed", "ls_host_unavailable", "ls_process_not_found", "ls_endpoint_not_found",
  "codex_no_ready_client", "codex_proxy_closed", "codex_control_disabled", "codex_control_unknown", "codex_control_not_ready",
  "codex_target_mismatch", "codex_thread_system_error", "codex_thread_status_missing",
  "codex_direct_input_disabled", "codex_direct_input_unknown",
  "remote_timeout",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truth(value) {
  return typeof value === "boolean" ? value : UNKNOWN;
}

function modes(value) {
  return Object.fromEntries(MODES.map(mode => [mode, truth(value?.[mode])]));
}

function everyRequired(values) {
  const states = values.map(truth);
  if (states.includes(false)) return false;
  return states.every(state => state === true) ? true : UNKNOWN;
}

function sendingConfigured(reader) {
  const configuration = modes(reader?.configured_delivery_modes);
  if (MODES.some(mode => configuration[mode] === true)) return true;
  if (MODES.every(mode => configuration[mode] === false)) return false;
  if (reader?.delivery_configured === false || !record(reader?.configured_delivery_modes)
    || !MODES.some(mode => Object.hasOwn(reader.configured_delivery_modes, mode))) return false;
  return UNKNOWN;
}

function socketReady(state) {
  return Number.isInteger(state) && state >= 0 && state <= 3 ? state === 1 : UNKNOWN;
}

function codexTransportReady(proxy) {
  if (!record(proxy)) return UNKNOWN;
  const available = everyRequired([truth(proxy.ok), proxy.closed === false ? true : proxy.closed === true ? false : UNKNOWN]);
  if (available === false) return false;
  const count = Number.isInteger(proxy.readyClientCount) && proxy.readyClientCount >= 0 ? proxy.readyClientCount : UNKNOWN;
  if (count === 0) return false;
  const clients = Array.isArray(proxy.clients) ? proxy.clients.map(client => everyRequired([
    truth(client?.initialized), truth(client?.upstreamReady), socketReady(client?.downstreamState), socketReady(client?.upstreamState),
  ])) : [];
  const connections = clients.includes(true) ? true
    : Array.isArray(proxy.clients) && clients.every(state => state === false) ? false : UNKNOWN;
  return everyRequired([available, typeof count === "number" && count > 0 ? true : UNKNOWN, connections]);
}

function codexControlState(value) {
  const supplied = truth(value?.control_enabled);
  const legacy = !Object.hasOwn(value ?? {}, "control_ready") && value?.control_state_version === undefined;
  return {
    control_enabled: legacy ? supplied === true ? true : UNKNOWN : supplied,
    control_ready: legacy ? supplied : truth(value?.control_ready),
    legacy_control_input: legacy,
  };
}

function configurationFor(reader, target) {
  const configured = modes(reader?.configured_delivery_modes);
  for (const mode of MODES) {
    if (!record(target?.capabilities) || !Object.hasOwn(target.capabilities, mode)) continue;
    const capability = truth(target.capabilities[mode]);
    configured[mode] = configured[mode] === false || capability === false ? false
      : configured[mode] === true && capability === true ? true : UNKNOWN;
  }
  return configured;
}

function rawStatus(value) {
  const status = value?.raw_status ?? value?.status;
  return typeof status === "string" && status.length <= 128 || typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function runningStatus(status) {
  if (RUNNING.has(status)) return true;
  if (IDLE.has(status)) return false;
  return UNKNOWN;
}

function cancellationCode(signal) {
  return ["status_timeout", "status_closed"].includes(signal.reason) ? signal.reason : "status_cancelled";
}

function errorCode(error) {
  return ERROR_CODES.has(error?.code) ? error.code : "status_probe_failed";
}

function diagnostic(code) {
  const reasons = {
    status_reader_not_configured: "该宿主尚未配置真实状态读取器",
    status_host_unsupported: "读取器未提供宿主状态接口",
    status_conversation_unsupported: "读取器未提供单对话状态接口",
    status_timeout: "状态探测达到期限，未完成的项目保持未知",
    remote_timeout: "远端机器在等待窗口内未返回状态",
    status_cancelled: "本次状态查询已取消",
    status_closed: "状态读取器已关闭",
    status_invalid_target: "状态查询目标无效",
    status_invalid_response: "状态接口没有返回可核对的状态字段",
    status_probe_failed: "状态探测失败，未确认的字段保持未知",
    status_unknown_enum: "宿主返回了未识别的运行状态，原值保留在raw_status",
    status_conversation_unknown: "已确认目标存在，接口未提供可核对的当前运行状态",
    status_delivery_not_configured: "投递方式尚未显式配置",
    status_host_scope: "本次只查询宿主，未查询任何具体对话",
    ls_target_unavailable: "原对话描述接口未能核实目标，是否存在保持未知",
    ls_target_ambiguous: "多个实际端点匹配同一目标，无法确认唯一对话",
    ls_target_mismatch: "对话描述返回的原始身份与目标不符",
    ls_discovery_failed: "宿主实例发现失败，接口在线情况保持未知",
    ls_host_unavailable: "本次没有取得成功的宿主只读接口响应",
    ls_process_not_found: "本次准确进程发现未找到宿主实例",
    ls_endpoint_not_found: "发现了宿主进程，尚无可核对的接口端口",
    ls_cancelled: "宿主只读探测已取消",
    ls_timeout: "宿主只读探测达到期限",
    ls_closed: "宿主只读接口已关闭",
    codex_no_ready_client: "本次快照未确认可用的Desktop上下游连接",
    codex_proxy_closed: "本次代理快照报告控制连接已关闭",
    codex_control_disabled: "当前控制入口明确未启用投递",
    codex_control_unknown: "尚未取得当前控制入口是否启用的证据",
    codex_control_not_ready: "当前控制入口尚未通过端点、配置及实例绑定核对",
    codex_target_mismatch: "对话检查未返回与目标一致的原始身份",
    codex_thread_system_error: "宿主报告systemError，当前是否运行保持未知",
    codex_thread_status_missing: "本次对话原件缺少顶层运行状态",
    codex_direct_input_disabled: "本次对话原件明确不接受直接输入",
    codex_direct_input_unknown: "本次对话原件未确认是否接受直接输入",
  };
  return reasons[code] ?? "宿主接口未确认目标状态，详见code";
}

function read(reader, method, target, signal, unsupported, options = {}) {
  if (signal.aborted) return Promise.resolve({ code: cancellationCode(signal) });
  if (typeof reader[method] !== "function") return Promise.resolve({ code: unsupported });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ code: cancellationCode(signal) });
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return reader[method](target, { ...options, signal });
    }).then(value => finish(record(value) ? { value } : { code: "status_invalid_response" }), error => {
      finish({ code: signal.aborted ? cancellationCode(signal) : errorCode(error) });
    });
  });
}

export function createAntigravityStatusReader(transport, { configured_delivery_modes = {} } = {}) {
  if (typeof transport?.describe !== "function" || typeof transport?.describeHost !== "function") {
    throw new TypeError("Antigravity status transport requires describe and describeHost");
  }
  return {
    source: "antigravity_ls",
    configured_delivery_modes: modes(configured_delivery_modes),
    delivery_configured: record(configured_delivery_modes) && MODES.some(mode => Object.hasOwn(configured_delivery_modes, mode)),
    async getHostStatus(target, options = {}) {
      const value = await transport.describeHost(options);
      if (!record(value)) return value;
      return { ...value, transport_ready: everyRequired([
        truth(value.host_online), Object.hasOwn(value, "transport_ready") ? truth(value.transport_ready) : true,
      ]) };
    },
    async describeConversation(target, options = {}) {
      const description = await transport.describe(target, options);
      if (description?.cascade_id !== target.conversation_id || typeof description?.trajectory_id !== "string" || !description.trajectory_id.trim()) {
        return { conversation_exists: UNKNOWN, conversation_running: UNKNOWN, code: "ls_target_mismatch" };
      }
      return {
        host_online: true, conversation_exists: true, status: description.status,
        model_observation: unknownModelObservation(target.host === "windsurf" ? "windsurf_ls_describe" : "antigravity_ls_describe", "model_metadata_not_exposed"),
        ...(typeof transport.describeModel === "function" ? { model_context: {
          cascade_id: description.cascade_id, trajectory_id: description.trajectory_id, step_count: description.step_count,
        } } : {}),
      };
    },
    ...(typeof transport.describeModel === "function" ? {
      async observeModel(target, { signal, context, kind } = {}) {
        return transport.describeModel(target, { signal, description: context, kind });
      },
    } : {}),
    ...(typeof transport.describeModelCatalog === "function" ? {
      async observeModelCatalog(target, { signal, context, model } = {}) {
        return transport.describeModelCatalog(target, { signal, description: context, model });
      },
    } : {}),
  };
}

export function createWindsurfStatusReader(transport) {
  const reader = createAntigravityStatusReader(transport, { configured_delivery_modes: { next_model_boundary: false, when_idle: false } });
  reader.source = "windsurf_ls";
  delete reader.observeModel;
  delete reader.observeModelCatalog;
  return reader;
}

export function createCodexStatusReader({ readHostStatus, inspectThread, configured_delivery_modes = {} } = {}) {
  if (typeof readHostStatus !== "function" || typeof inspectThread !== "function") {
    throw new TypeError("Codex status reader requires readHostStatus and inspectThread");
  }
  return {
    source: "codex_proxy_status_and_thread_inspect",
    requires_control_enabled: true,
    requires_direct_input: true,
    requires_host_status: true,
    configured_delivery_modes: modes(configured_delivery_modes),
    delivery_configured: record(configured_delivery_modes) && MODES.some(mode => Object.hasOwn(configured_delivery_modes, mode)),
    async getHostStatus(target, options = {}) {
      const value = await readHostStatus(target, options);
      const proxy = value?.proxy ?? value;
      const control = codexControlState(value);
      const ready = proxy?.ok === true && proxy.closed === false && Number.isInteger(proxy.readyClientCount) && proxy.readyClientCount > 0 &&
        Array.isArray(proxy.clients) && proxy.clients.some(client => client?.initialized === true && client.upstreamReady === true && client.downstreamState === 1 && client.upstreamState === 1);
      const transportReady = everyRequired([
        codexTransportReady(proxy), Object.hasOwn(value ?? {}, "transport_ready") ? truth(value.transport_ready) : true,
      ]);
      return {
        host_online: value?.host_online === false ? false : ready ? true : UNKNOWN, transport_ready: transportReady, ...control,
        ...(value?.host_can_receive === false ? { host_can_receive: false } : {}),
        ...(!ready ? { code: proxy?.closed === true ? "codex_proxy_closed" : "codex_no_ready_client" } : {}),
      };
    },
    async describeConversation(target, options = {}) {
      const value = await inspectThread(target.conversation_id, options);
      if (value?.threadId !== target.conversation_id || value?.ok === false) return { code: "codex_target_mismatch" };
      if (value.found === false && value.thread === null) return { host_online: true, conversation_exists: false, conversation_running: false };
      if (value.found !== true || value.thread?.id !== target.conversation_id) return { code: "codex_target_mismatch" };
      const status = record(value.thread.status) ? value.thread.status.type : value.thread.status;
      const running = status === "active" ? true : ["idle", "notLoaded"].includes(status) ? false : UNKNOWN;
      return {
        host_online: true, conversation_exists: true, conversation_running: running,
        can_accept_direct_input: truth(value.thread.canAcceptDirectInput),
        model_observation: codexModelObservation(value.thread),
        ...(rawStatus({ status }) === undefined ? { code: "codex_thread_status_missing" } : { raw_status: status }),
        ...(status === "systemError" ? { code: "codex_thread_system_error" } : {}),
      };
    },
  };
}

export class HostStatusProvider {
  constructor({ providers = {}, machineProviders = new Map(), localMachineId, now = () => Date.now(), timeoutMs = 8000, modelTimeoutMs = 500 } = {}) {
    if (!record(providers) || typeof now !== "function") throw new TypeError("Invalid status providers or clock");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new RangeError("timeoutMs must be an integer in 1..8000");
    if (!Number.isInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > 2000) throw new RangeError("modelTimeoutMs must be an integer in 1..2000");
    this.providers = new Map(Object.entries(providers));
    this.machineProviders = machineProviders;
    this.localMachineId = localMachineId;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.modelTimeoutMs = modelTimeoutMs;
    this.inflight = new Map();
    this.active = new Set();
    this.closed = false;
  }

  snapshot(target, source, code, configuration, receptionConfigured = UNKNOWN) {
    const configured = modes(configuration);
    return {
      target: structuredClone(target), observed_at: new Date(this.now()).toISOString(), source,
      host_online: UNKNOWN, conversation_exists: UNKNOWN, conversation_running: UNKNOWN, can_deliver: UNKNOWN,
      model_observation: unknownModelObservation(source, target?.conversation_id === undefined ? "model_conversation_required" : "model_metadata_not_observed"),
      transport_ready: UNKNOWN, control_enabled: UNKNOWN, control_ready: UNKNOWN,
      host_can_receive: receptionConfigured === false ? false : UNKNOWN,
      configured_delivery_modes: configured,
      delivery_modes: Object.fromEntries(MODES.map(mode => [mode, configured[mode] === false ? false : UNKNOWN])),
      ...(code ? { code, reason: diagnostic(code) } : {}),
    };
  }

  async probe(target, reader, signal, source, remote, hostObserved) {
    const hasConversation = target.conversation_id !== undefined;
    const configured = configurationFor(reader, target);
    if (remote && typeof reader.getRemoteStatus === "function") {
      const received = await read(reader, "getRemoteStatus", target, signal, "status_host_unsupported");
      hostObserved();
      const value = received.value;
      const relaySource = "remote_core_relay";
      if (received.code === "status_timeout" || received.code === "remote_timeout" || value?.code === "remote_timeout") {
        return this.snapshot(target, relaySource, "remote_timeout");
      }
      if (!record(value?.target) || ["machine_id", "host", "surface", "conversation_id"].some(key => target[key] !== value.target[key])) {
        return this.snapshot(target, relaySource, received.code ?? "status_invalid_response");
      }
      const status = this.snapshot(target, relaySource, value.code === "forbidden" ? "forbidden" : undefined);
      if (value.code === "forbidden") return status;
      for (const key of ["host_online", "conversation_exists", "conversation_running", "can_deliver", "transport_ready", "control_enabled",
        "control_ready", "host_can_receive"]) status[key] = truth(value[key]);
      status.configured_delivery_modes = modes(value.configured_delivery_modes);
      status.delivery_modes = modes(value.delivery_modes);
      if (hasConversation) status.model_observation = projectModelObservation(value.model_observation, relaySource);
      if (rawStatus(value) !== undefined) status.raw_status = rawStatus(value);
      return status;
    }
    const result = this.snapshot(target, source, undefined, configured, sendingConfigured(reader));
    const [host, conversation] = await Promise.all([
      read(reader, "getHostStatus", target, signal, "status_host_unsupported"),
      hasConversation ? read(reader, "describeConversation", target, signal, "status_conversation_unsupported") : Promise.resolve({}),
    ]);
    hostObserved();
    if (remote && (signal.reason === "status_timeout" ||
      [host, conversation].some(status => status.code === "remote_timeout" || status.value?.code === "remote_timeout"))) {
      return this.snapshot(target, "remote_core_relay", "remote_timeout", configured);
    }
    result.host_online = truth(host.value?.host_online);
    result.transport_ready = truth(host.value?.transport_ready);
    result.control_enabled = truth(host.value?.control_enabled);
    result.control_ready = truth(host.value?.control_ready);
    const control = reader.requires_control_enabled === true
      ? everyRequired([result.control_enabled, result.control_ready])
      : [result.control_enabled, result.control_ready].includes(false) ? false : true;
    result.host_can_receive = everyRequired([
      sendingConfigured(reader), result.host_online, result.transport_ready, control,
      host.value?.host_can_receive === false ? false : true,
    ]);
    const codes = [host.code];
    if (host.value && result.host_online === UNKNOWN) codes.push(ERROR_CODES.has(host.value.code) ? host.value.code : "status_invalid_response");
    if (hasConversation) {
      result.conversation_exists = truth(conversation.value?.conversation_exists);
      const status = rawStatus(conversation.value);
      if (status !== undefined) result.raw_status = status;
      if (result.conversation_exists === false) result.conversation_running = false;
      else if (result.conversation_exists === true) {
        result.model_observation = projectModelObservation(conversation.value?.model_observation, source);
        result.conversation_running = truth(conversation.value?.conversation_running);
        if (result.conversation_running === UNKNOWN) result.conversation_running = runningStatus(status);
      }
      if (result.host_online === UNKNOWN && conversation.value?.host_online === true && reader.requires_host_status !== true) result.host_online = true;
      codes.push(conversation.code);
      if (conversation.value && result.conversation_exists === UNKNOWN) {
        codes.push(ERROR_CODES.has(conversation.value.code) ? conversation.value.code : "status_invalid_response");
      } else if (ERROR_CODES.has(conversation.value?.code)) codes.push(conversation.value.code);
      else if (result.conversation_exists === true && result.conversation_running === UNKNOWN && status !== undefined) {
        codes.push("status_unknown_enum");
      } else if (result.conversation_exists === true && result.conversation_running === UNKNOWN) {
        codes.push("status_conversation_unknown");
      }
      const enabled = MODES.some(mode => configured[mode] === true);
      const directInput = reader.requires_direct_input === true ? truth(conversation.value?.can_accept_direct_input) : true;
      const checks = [result.host_online, result.conversation_exists, control, directInput];
      if (result.transport_ready === false && (host.value?.legacy_control_input !== true || result.host_online === true)) checks.push(false);
      if (host.value?.host_can_receive === false) checks.push(false);
      for (const mode of MODES) {
        result.delivery_modes[mode] = configured[mode] === false || checks.includes(false) ? false
          : configured[mode] === true && checks.every(value => value === true) ? true : UNKNOWN;
      }
      if (MODES.some(mode => result.delivery_modes[mode] === true)) result.can_deliver = true;
      else if (MODES.every(mode => result.delivery_modes[mode] === false)) result.can_deliver = false;
      if (control !== true) codes.push(result.control_enabled === false ? "codex_control_disabled"
        : result.control_ready === false ? "codex_control_not_ready" : "codex_control_unknown");
      if (directInput !== true && result.conversation_exists === true) codes.push(directInput === false ? "codex_direct_input_disabled" : "codex_direct_input_unknown");
      if (result.can_deliver === UNKNOWN && !enabled) codes.push("status_delivery_not_configured");
    } else codes.push("status_host_scope");
    const code = codes.find(Boolean);
    if (code) Object.assign(result, { code, reason: diagnostic(code) });
    if (hasConversation && result.conversation_exists === true && typeof reader.observeModel === "function") {
      const observeKind = async kind => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort("status_timeout"), this.modelTimeoutMs);
        const modelSignal = AbortSignal.any([signal, controller.signal]);
        try {
          const observation = await read(reader, "observeModel", target, modelSignal, "status_conversation_unsupported", { kind, context: conversation.value?.model_context });
          result.model_observation[kind] = observation.value
            ? projectModelObservation({ [kind]: observation.value }, source)[kind]
            : unknownModelObservation(source, modelSignal.aborted ? "model_observation_timeout" : "model_observation_unavailable")[kind];
        } catch {
          result.model_observation[kind] = unknownModelObservation(source, "model_observation_unavailable")[kind];
        } finally {
          clearTimeout(timer);
        }
      };
      await observeKind("last_invocation");
      if (result.model_observation.last_invocation.model !== UNKNOWN && typeof reader.observeModelCatalog === "function") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort("status_timeout"), this.modelTimeoutMs);
        const modelSignal = AbortSignal.any([signal, controller.signal]);
        const previous = result.model_observation.last_invocation;
        try {
          const catalogue = await read(reader, "observeModelCatalog", target, modelSignal, "status_conversation_unsupported", {
            context: conversation.value?.model_context, model: previous.model,
          });
          const fields = ["catalog_source", "catalog_model_id", "catalog_label", "catalog_field", "catalog_observed_at", "catalog_code"];
          const extra = catalogue.value ? Object.fromEntries(fields.filter(field => Object.hasOwn(catalogue.value, field)).map(field => [field, catalogue.value[field]]))
            : { catalog_code: modelSignal.aborted ? "model_observation_timeout" : "model_catalog_unavailable" };
          result.model_observation.last_invocation = projectModelObservation({ last_invocation: { ...previous, ...extra } }, source).last_invocation;
        } catch {
          result.model_observation.last_invocation = { ...previous, catalog_code: "model_catalog_unavailable" };
        } finally {
          clearTimeout(timer);
        }
      }
      await observeKind("current_selection");
    }
    return result;
  }

  start(target, reader, key, source, { remote, generation }) {
    const controller = new AbortController();
    const entry = { controller, reader, generation, startedAt: this.now(), waiters: 0, settled: false };
    const timeoutMs = remote ? REMOTE_STATUS_TIMEOUT_MS : this.timeoutMs;
    const timer = setTimeout(() => controller.abort("status_timeout"), timeoutMs);
    this.active.add(entry);
    this.inflight.set(key, entry);
    entry.promise = this.probe(target, reader, controller.signal, source, remote, () => clearTimeout(timer)).catch(() => this.snapshot(target, source, "status_probe_failed", configurationFor(reader, target), sendingConfigured(reader))).finally(() => {
      entry.settled = true;
      clearTimeout(timer);
      this.active.delete(entry);
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    return entry;
  }

  async getStatus(target, { signal } = {}) {
    const source = "host_status_provider";
    if (!record(target) || typeof target.host !== "string" || !target.host.trim() ||
      target.conversation_id !== undefined && (typeof target.conversation_id !== "string" || !target.conversation_id.trim())) {
      return this.snapshot(target ?? null, source, "status_invalid_target");
    }
    target = structuredClone(target);
    const home = this.localMachineId;
    const remote = home === null || (home !== undefined && target.machine_id !== undefined && target.machine_id !== home);
    const reader = this.machineProviders.get(target.machine_id)?.get(target.host) ?? (remote ? null : this.providers.get(target.host));
    const configuration = record(reader) ? configurationFor(reader, target) : undefined;
    const receptionConfigured = record(reader) ? sendingConfigured(reader) : UNKNOWN;
    if (this.closed) return this.snapshot(target, source, "status_closed", configuration, receptionConfigured);
    if (signal?.aborted) return this.snapshot(target, source, "status_cancelled", configuration, receptionConfigured);
    if (!record(reader)) return this.snapshot(target, source, "status_reader_not_configured");
    const readerSource = typeof reader.source === "string" && reader.source.length <= 128 ? reader.source : `${target.host}_status_reader`;
    const generation = remote && Number.isSafeInteger(reader.cursorGeneration) ? reader.cursorGeneration : null;
    const key = JSON.stringify(Object.entries(target).sort(([left], [right]) => left.localeCompare(right)));
    let entry = this.inflight.get(key);
    const age = entry ? this.now() - entry.startedAt : Infinity;
    if (!entry || entry.reader !== reader || entry.generation !== generation || (remote && generation === null) ||
      entry.settled || entry.controller.signal.aborted || age < 0 || age >= 1000) {
      entry = this.start(target, reader, key, readerSource, { remote, generation });
    }
    return new Promise(resolve => {
      let settled = false;
      entry.waiters += 1;
      const finish = result => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        entry.waiters -= 1;
        if (!entry.waiters && !entry.settled) entry.controller.abort("status_cancelled");
        resolve(structuredClone(result));
      };
      const onAbort = () => finish(this.snapshot(target, readerSource, "status_cancelled", configuration, receptionConfigured));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      entry.promise.then(finish);
    });
  }

  async close() {
    this.closed = true;
    const active = [...this.active];
    for (const entry of active) entry.controller.abort("status_closed");
    await Promise.allSettled(active.map(entry => entry.promise));
    this.inflight.clear();
  }
}
