function sseFrame(event) {
  return "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

function safeMessageItem(item) {
  return item?.type === "message";
}

function messageHasContent(item) {
  return Array.isArray(item?.content) && item.content.some(part => {
    return part && typeof part === "object" && Object.keys(part).length > 0;
  });
}

function completedMessage(item) {
  const message = structuredClone(item);
  message.status = "completed";
  message.content = (message.content ?? []).filter(Boolean);
  return message;
}

const executableToolTypes = new Set(["function_call", "custom_tool_call", "local_shell_call", "computer_call", "mcp_call", "tool_search_call"]);

function recordDeliveredText(entry, index, text, append = false) {
  if (typeof text !== "string" || text.length === 0) return false;
  entry.deliveredTextLengths ??= new Map();
  const previous = append ? entry.deliveredTextLengths.get(index) ?? 0 : 0;
  entry.deliveredTextLengths.set(index, previous + text.length);
  return true;
}

export function createStreamRecovery(requestId, { trackClientDelivery = false } = {}) {
  const compactId = requestId.replaceAll("-", "");
  const items = new Map();
  let responseId = null;
  let sequence = -1;
  let createdDelivered = false;
  let publicResponseDelivered = false;
  let visibleOutputDelivered = false;
  let executableToolDelivered = false;

  function observe(event) {
    if (!event || typeof event !== "object") return;
    for (const key of ["output_index", "content_index"]) {
      if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > 65535)) {
        throw Object.assign(new Error("Invalid response item index"), { code: "INVALID_RESPONSE_INDEX" });
      }
    }
    if (Number.isSafeInteger(event.sequence_number)) sequence = Math.max(sequence, event.sequence_number);
    responseId ??= event.response?.id ?? event.response_id ?? null;
    const outputIndex = Number.isSafeInteger(event.output_index) ? event.output_index : 0;
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const previous = items.get(outputIndex) ?? { item: null, done: false, deliveredDone: false };
      items.set(outputIndex, {
        ...previous,
        item: structuredClone(event.item),
        done: previous.done || event.type.endsWith(".done"),
      });
      return;
    }
    if (event.type === "response.content_part.added") {
      const entry = items.get(outputIndex);
      if (entry?.item?.type === "message") {
        entry.item.content ??= [];
        entry.item.content[event.content_index ?? 0] = structuredClone(event.part);
      }
      return;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      let entry = items.get(outputIndex);
      if (!entry) {
        entry = {
          item: { type: "message", id: event.item_id ?? "msg_partial_" + compactId, role: "assistant", content: [] },
          done: false,
          deliveredDone: false,
        };
        items.set(outputIndex, entry);
      }
      if (entry.item?.type === "message") {
        entry.item.content ??= [];
        const contentIndex = event.content_index ?? 0;
        entry.item.content[contentIndex] ??= { type: "output_text", text: "" };
        entry.item.content[contentIndex].text += event.delta;
      }
    }
  }

  function markDelivered(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "response.created") {
      createdDelivered = true;
      if (trackClientDelivery && typeof event.response?.id === "string" && event.response.id.length > 0) publicResponseDelivered = true;
    }
    const itemDone = event.type === "response.output_item.done";
    if (!trackClientDelivery && !itemDone) return;
    const outputIndex = Number.isSafeInteger(event.output_index) ? event.output_index : 0;
    const entry = items.get(outputIndex);
    if (itemDone) {
      if (entry) entry.deliveredDone = true;
      if (trackClientDelivery && executableToolTypes.has(event.item?.type)) executableToolDelivered = true;
    }
    if (!trackClientDelivery) return;
    if (event.type === "response.refusal.delta" && typeof event.delta === "string" && event.delta.length > 0) visibleOutputDelivered = true;
    if (entry?.item?.type !== "message" || entry.item.role !== "assistant") return;
    if (event.type === "response.output_text.delta") {
      if (recordDeliveredText(entry, event.content_index ?? 0, event.delta, true)) visibleOutputDelivered = true;
    } else if (event.type === "response.content_part.added") {
      if (event.part?.type === "output_text" && recordDeliveredText(entry, event.content_index ?? 0, event.part.text)) visibleOutputDelivered = true;
      if (event.part?.type === "refusal" && typeof event.part.refusal === "string" && event.part.refusal.length > 0) visibleOutputDelivered = true;
    } else if ((event.type === "response.output_item.added" || itemDone) && Array.isArray(event.item?.content)) {
      for (const [index, part] of event.item.content.entries()) {
        if (part?.type === "output_text" && recordDeliveredText(entry, index, part.text)) visibleOutputDelivered = true;
        if (part?.type === "refusal" && typeof part.refusal === "string" && part.refusal.length > 0) visibleOutputDelivered = true;
      }
    }
  }

  function nextEvent(events, event) {
    events.push({ ...event, sequence_number: ++sequence });
  }

  function ensureCreated(events) {
    if (!responseId) responseId = "resp_proxy_" + compactId;
    if (!createdDelivered) {
      nextEvent(events, { type: "response.created", response: { id: responseId, status: "in_progress" } });
      createdDelivered = true;
    }
  }

  function retainTerminalMessages(events, terminalEvent) {
    if (!["response.failed", "response.incomplete"].includes(terminalEvent?.type)
      || terminalEvent.response?.id !== responseId || !Array.isArray(terminalEvent.response.output)) return;
    const seen = new Set();
    const previousItems = new Map();
    let nextOutputIndex = 0;
    for (const [index, entry] of items) {
      if (typeof entry.item?.id === "string") previousItems.set(entry.item.id, [index, entry]);
      nextOutputIndex = Math.max(nextOutputIndex, index + 1);
    }
    for (const [terminalIndex, item] of terminalEvent.response.output.slice(0, 65536).entries()) {
      if (item?.type !== "message" || item.role !== "assistant"
        || typeof item.id !== "string" || !item.id || seen.has(item.id) || !Array.isArray(item.content)
        || !item.content.length || item.content.length > 65536
        || !item.content.every(part => part?.type === "output_text" && typeof part.text === "string")
        || !item.content.some(part => part.text.length)) continue;
      seen.add(item.id);
      const previous = previousItems.get(item.id);
      if (previous && (previous[1].item?.type !== "message" || previous[1].item?.role !== "assistant" || previous[1].deliveredDone)) continue;
      let outputIndex = previous?.[0] ?? terminalIndex;
      let entry = previous?.[1];
      if (entry) {
        const content = entry.item.content ?? [];
        if (!Array.isArray(content) || content.length > item.content.length || !content.every((part, contentIndex) =>
          part?.type === "output_text" && typeof part.text === "string" && item.content[contentIndex].text.startsWith(part.text))) continue;
      } else {
        if (items.has(outputIndex)) outputIndex = nextOutputIndex;
        if (outputIndex >= 65535) continue;
        entry = { item: { ...structuredClone(item), status: "in_progress", content: [] }, done: false, deliveredDone: false };
        items.set(outputIndex, entry);
        nextOutputIndex = Math.max(nextOutputIndex, outputIndex + 1);
        nextEvent(events, { type: "response.output_item.added", output_index: outputIndex, item: structuredClone(entry.item) });
      }
      for (const [contentIndex, part] of item.content.entries()) {
        const previousText = entry.item.content?.[contentIndex]?.text ?? "";
        const delta = part.text.slice(previousText.length);
        if (delta) nextEvent(events, { type: "response.output_text.delta", output_index: outputIndex,
          item_id: item.id, content_index: contentIndex, delta });
      }
      entry.item = { ...structuredClone(item), status: "completed" };
      entry.done = true;
    }
  }

  function finish(notice, terminalEvent, { omitNotice = false } = {}) {
    const events = [];
    ensureCreated(events);
    retainTerminalMessages(events, terminalEvent);
    const output = [];
    let outputIndex = 0;
    for (const index of items.keys()) outputIndex = Math.max(outputIndex, index + 1);
    for (const [index, entry] of [...items].sort(([left], [right]) => left - right)) {
      if (!safeMessageItem(entry.item)) continue;
      const message = completedMessage(entry.item);
      if (!entry.done && !messageHasContent(message)) continue;
      if (!entry.deliveredDone) nextEvent(events, { type: "response.output_item.done", output_index: index, item: message });
      output.push(message);
    }
    if (!omitNotice) {
      const message = {
        type: "message",
        id: "msg_proxy_" + compactId,
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: notice }],
      };
      nextEvent(events, { type: "response.output_item.added", output_index: outputIndex, item: { ...message, status: "in_progress", content: [] } });
      nextEvent(events, { type: "response.output_text.delta", output_index: outputIndex, item_id: message.id, content_index: 0, delta: notice });
      nextEvent(events, { type: "response.output_item.done", output_index: outputIndex, item: message });
      output.push(message);
    }
    nextEvent(events, { type: "response.completed", response: { id: responseId, status: "completed", output } });
    return events.map(sseFrame).join("");
  }

  function fail(code, message, { completeDeliveredText = false } = {}) {
    const events = [];
    ensureCreated(events);
    if (completeDeliveredText && publicResponseDelivered) {
      for (const [index, entry] of [...items].sort(([left], [right]) => left - right)) {
        if (entry.deliveredDone || !entry.deliveredTextLengths?.size
          || entry.item?.type !== "message" || entry.item.role !== "assistant") continue;
        const content = (entry.item.content ?? []).flatMap((part, contentIndex) => {
          const length = entry.deliveredTextLengths.get(contentIndex);
          return part?.type === "output_text" && typeof part.text === "string" && length
            ? [{ ...part, text: part.text.slice(0, length) }] : [];
        });
        if (!content.length) continue;
        nextEvent(events, { type: "response.output_item.done", output_index: index,
          item: { ...entry.item, status: "completed", content } });
        entry.deliveredDone = true;
      }
    }
    nextEvent(events, {
      type: "response.failed",
      response: { id: responseId, status: "failed", error: { code, message } },
    });
    return events.map(sseFrame).join("");
  }

  return { observe, markDelivered, finish, fail, isUnstarted: () => responseId === null && items.size === 0,
    enableClientDelivery() { trackClientDelivery = true; }, clientDelivery: () => trackClientDelivery ? ({
    clientCanContinue: publicResponseDelivered, progressObserved: visibleOutputDelivered, toolDelivered: executableToolDelivered,
  }) : null };
}

export function waitForRetry(delayMs, requestState, options = {}) {
  if (requestState.cancelled) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  const onKeepalive = typeof options.onKeepalive === "function" ? options.onKeepalive : null;
  const keepaliveIntervalMs = Math.max(1_000, Math.min(options.keepaliveIntervalMs ?? 5_000, delayMs));
  return new Promise(resolve => {
    let timer;
    let keepaliveTimer;
    const finish = proceed => {
      clearTimeout(timer);
      clearInterval(keepaliveTimer);
      if (requestState.currentAbort === cancel) requestState.currentAbort = null;
      resolve(proceed);
    };
    const cancel = () => finish(false);
    const keepalive = () => {
      if (requestState.cancelled) return;
      try {
        onKeepalive?.();
      } catch {
      }
    };
    requestState.currentAbort = cancel;
    if (onKeepalive) {
      keepalive();
      keepaliveTimer = setInterval(keepalive, keepaliveIntervalMs);
      keepaliveTimer.unref?.();
    }
    timer = setTimeout(() => finish(!requestState.cancelled), delayMs);
    timer.unref?.();
  });
}

export function waitForRecoveryAction(delayMs, requestState, { onKeepalive, keepaliveIntervalMs = 5000,
  canContinueHttp = false } = {}) {
  if (requestState.cancelled) return Promise.resolve("cancel");
  return new Promise(resolve => {
    let timer;
    let keepaliveTimer;
    let settled = false;
    const finish = action => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      clearInterval(keepaliveTimer);
      if (requestState.currentAbort === cancel) requestState.currentAbort = null;
      if (requestState.recoveryControl === control) requestState.recoveryControl = null;
      resolve(action);
      return true;
    };
    const cancel = () => finish("cancel");
    const control = { continueHttp: () => canContinueHttp && !requestState.cancelled && finish("continue_http") };
    requestState.currentAbort = cancel;
    requestState.recoveryControl = control;
    const keepalive = () => {
      if (requestState.cancelled) return finish("cancel");
      try { onKeepalive?.(); } catch { finish("cancel"); }
    };
    keepalive();
    if (settled) return;
    keepaliveTimer = setInterval(keepalive, Math.max(10, keepaliveIntervalMs));
    keepaliveTimer.unref?.();
    if (delayMs !== null) {
      timer = setTimeout(() => finish(requestState.cancelled ? "cancel" : "retry"), Math.max(0, delayMs));
      timer.unref?.();
    }
  });
}
