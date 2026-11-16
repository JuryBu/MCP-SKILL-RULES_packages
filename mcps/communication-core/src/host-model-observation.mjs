const UNKNOWN = "unknown";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const REASONS = {
  model_conversation_required: "本次只查询宿主，模型选择需要指定具体对话",
  model_metadata_not_observed: "本次没有取得该对话的模型元数据",
  model_metadata_not_exposed: "当前状态描述接口未提供模型元数据",
  model_selection_not_exposed: "当前对话摘要未提供有效的模型选择字段",
  model_invocation_not_exposed: "当前只读对话摘要未提供最近一次调用的模型元数据",
  model_observation_unavailable: "本次有界模型观察未取得可核对结果",
  model_observation_timeout: "模型观察达到独立期限，宿主与对话状态保持原结果",
  model_renderer_selection_missing: "当前宿主页面没有该对话的独立模型选择记录",
  model_renderer_ambiguous: "多个当前宿主页面的模型选择来源尚未取得唯一结果",
  model_catalog_match_missing: "当前模型目录未唯一匹配该对话的原始模型值",
  model_catalog_unavailable: "本次未取得宿主当前模型目录，已取得的调用模型与步骤保持原值",
  model_tail_unavailable: "本次有限尾部步骤未提供可核对的调用模型",
  model_tail_mismatch: "有限尾部步骤的身份、顺序或范围核对未通过",
};

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function modelIdentifier(value) {
  return identifier(value) && ![UNKNOWN, "model_observed"].includes(value.toLowerCase()) ? value : undefined;
}

function unavailable(source, code) {
  return { model: UNKNOWN, source, code, reason: REASONS[code] };
}

function provenance(value) {
  const result = {};
  for (const field of ["conversation_id", "trajectory_id", "catalog_field", "catalog_source"]) {
    if (identifier(value?.[field])) result[field] = value[field];
  }
  for (const field of ["observed_at", "catalog_observed_at"]) {
    const timestamp = value?.[field];
    if (typeof timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(timestamp)
      && Number.isFinite(Date.parse(timestamp))) result[field] = timestamp;
  }
  if (Number.isSafeInteger(value?.raw_model) && value.raw_model >= 0 || modelIdentifier(value?.raw_model)) result.raw_model = value.raw_model;
  if (typeof value?.catalog_label === "string" && value.catalog_label.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value.catalog_label)) result.catalog_label = value.catalog_label;
  if (modelIdentifier(value?.catalog_model_id)) result.catalog_model_id = value.catalog_model_id;
  if (["model_catalog_unavailable", "model_catalog_match_missing", "model_observation_timeout"].includes(value?.catalog_code)) result.catalog_code = value.catalog_code;
  for (const field of ["step_index", "tail_offset"]) {
    if (Number.isSafeInteger(value?.[field]) && value[field] >= 0) result[field] = value[field];
  }
  for (const field of ["step_created_at", "step_started_at", "step_completed_at"]) {
    const timestamp = value?.[field];
    if (typeof timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(timestamp)
      && Number.isFinite(Date.parse(timestamp))) result[field] = timestamp;
  }
  if (Number.isSafeInteger(value?.tail_count) && value.tail_count >= 0 && value.tail_count <= 32) result.tail_count = value.tail_count;
  return result;
}

export function unknownModelObservation(source, code = "model_metadata_not_observed") {
  const safeCode = Object.hasOwn(REASONS, code) ? code : "model_metadata_not_observed";
  return { current_selection: unavailable(source, safeCode), last_invocation: unavailable(source, safeCode) };
}

export function codexModelObservation(thread) {
  const source = "codex_thread_inspect";
  const observation = unknownModelObservation(source, "model_invocation_not_exposed");
  const model = modelIdentifier(thread?.model);
  observation.current_selection = model ? {
    model, source, field: "thread.model",
    ...(identifier(thread?.modelProvider) ? { provider: thread.modelProvider } : {}),
    ...(EFFORTS.has(thread?.reasoningEffort) ? { reasoning_effort: thread.reasoningEffort } : {}),
  } : unavailable(source, "model_selection_not_exposed");
  return observation;
}

export function projectModelObservation(value, source) {
  const observation = unknownModelObservation(source);
  for (const kind of ["current_selection", "last_invocation"]) {
    const input = value?.[kind];
    if (!record(input) || !identifier(input.source)) continue;
    if (input.model === UNKNOWN && Object.hasOwn(REASONS, input.code)) {
      observation[kind] = { ...unavailable(input.source, input.code), ...provenance(input) };
      continue;
    }
    const model = modelIdentifier(input.model);
    if (!model || !identifier(input.field)) continue;
    observation[kind] = {
      model, source: input.source, field: input.field,
      ...(identifier(input.provider) ? { provider: input.provider } : {}),
      ...(EFFORTS.has(input.reasoning_effort) ? { reasoning_effort: input.reasoning_effort } : {}),
      ...provenance(input),
    };
  }
  return observation;
}

function rendererSelection(conversationId) {
  const root = document.getElementById("root");
  const key = Object.keys(root ?? {}).find(name => name.startsWith("__reactContainer$"));
  const first = root?.[key];
  const pending = [first, first?.stateNode?.current];
  const visited = new Set();
  while (pending.length && visited.size < 2048) {
    const fiber = pending.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    const props = fiber.memoizedProps;
    for (const store of [props?.store, props?.value?.store]) {
      if (typeof store?.getState !== "function") continue;
      const state = store.getState();
      if (!state?.modelSelection?.byConversation) continue;
      const selected = state.modelSelection.byConversation[conversationId];
      const observedAt = new Date().toISOString();
      if (!selected || !Number.isSafeInteger(selected.model) || selected.model <= 0) return { conversation_id: conversationId, observed_at: observedAt, code: "model_renderer_selection_missing" };
      const catalogue = state.userStatus?.cascadeModelConfigData?.clientModelConfigs;
      const matches = Array.isArray(catalogue) ? catalogue.filter(config => config.modelOrAlias?.choice?.case === "model" && config.modelOrAlias.choice.value === selected.model) : [];
      if (matches.length !== 1) return { conversation_id: conversationId, observed_at: observedAt, raw_model: selected.model, code: "model_catalog_match_missing" };
      return { conversation_id: conversationId, observed_at: observedAt, raw_model: selected.model, model: matches[0].modelId, catalog_label: matches[0].label };
    }
    for (const child of [fiber.sibling, fiber.child]) if (child) pending.push(child);
  }
  return { conversation_id: conversationId, observed_at: new Date().toISOString(), code: "model_renderer_selection_missing" };
}

async function modelJson(response) {
  if (!response.ok || !response.body?.getReader) throw new Error("model_metadata_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 128 * 1024) throw new Error("model_metadata_limit");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function evaluateModel(socketAddress, conversationId, signal, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = new WebSocketImpl(socketAddress);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("model_observation_cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("error", () => finish(new Error("model_renderer_unavailable")), { once: true });
    socket.addEventListener("close", () => finish(new Error("model_renderer_closed")), { once: true });
    socket.addEventListener("open", () => {
      if (signal.aborted) return onAbort();
      try {
        socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
          expression: `(${rendererSelection.toString()})(${JSON.stringify(conversationId)})`, returnByValue: true, timeout: 400,
        } }));
      } catch {
        finish(new Error("model_renderer_unavailable"));
      }
    }, { once: true });
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 64 * 1024) return finish(new Error("model_renderer_response_invalid"));
      try {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails || !record(message.result?.result?.value)) return finish(new Error("model_renderer_response_invalid"));
        finish(null, message.result.result.value);
      } catch {
        finish(new Error("model_renderer_response_invalid"));
      }
    });
    if (signal.aborted) onAbort();
  });
}

export async function readAntigravityRendererModel(target, endpoint, { fetchImpl = fetch, WebSocketImpl = WebSocket, signal = AbortSignal.timeout(1000) } = {}) {
  const source = "antigravity_renderer_model_selection";
  const missing = code => unavailable(source, code);
  if (!identifier(target?.conversation_id) || !Number.isSafeInteger(endpoint?.host_pid) || endpoint.host_pid < 1 || !Array.isArray(endpoint.host_ports) || !Array.isArray(endpoint.ls_ports)) return missing("model_observation_unavailable");
  try {
    signal.throwIfAborted();
    for (const port of endpoint.host_ports.slice(0, 4)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      let pages;
      try {
        pages = await modelJson(await fetchImpl(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal }));
      } catch {
        signal.throwIfAborted();
        continue;
      }
      if (!Array.isArray(pages) || pages.length > 16) continue;
      const matches = pages.flatMap(page => {
        try {
          const address = new URL(page.url);
          const socket = new URL(page.webSocketDebuggerUrl);
          if (page.type !== "page" || !["http:", "https:"].includes(address.protocol) || address.hostname !== "127.0.0.1"
            || !endpoint.ls_ports.includes(Number(address.port)) || !address.pathname.startsWith("/c/")
            || socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== port
            || socket.username || socket.password || !socket.pathname.startsWith("/devtools/page/")) return [];
          return [socket.href];
        } catch {
          return [];
        }
      });
      if (matches.length > 1) return missing("model_renderer_ambiguous");
      if (!matches.length) continue;
      const value = await evaluateModel(matches[0], target.conversation_id, signal, WebSocketImpl);
      if (value.conversation_id !== target.conversation_id) return missing("model_observation_unavailable");
      const normalized = { ...provenance(value), source, field: "modelSelection.byConversation.model" };
      if (!modelIdentifier(value.model)) return { ...missing(Object.hasOwn(REASONS, value.code) ? value.code : "model_catalog_match_missing"), ...provenance(value) };
      return { ...normalized, model: value.model, catalog_field: "userStatus.cascadeModelConfigData.clientModelConfigs.modelOrAlias" };
    }
    return missing("model_observation_unavailable");
  } catch {
    return missing(signal.aborted ? "model_observation_timeout" : "model_observation_unavailable");
  }
}
