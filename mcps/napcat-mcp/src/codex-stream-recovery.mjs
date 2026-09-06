function sseFrame(event) {
  return "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

function safeMessageItem(item) {
  return item?.type === "message";
}

function messageHasContent(item) {
  return Array.isArray(item?.content) && item.content.some((part) => {
    return part && typeof part === "object" && Object.keys(part).length > 0;
  });
}

function completedMessage(item) {
  const message = structuredClone(item);
  message.status = "completed";
  message.content = (message.content ?? []).filter(Boolean);
  return message;
}

export function createStreamRecovery(requestId) {
  const compactId = requestId.replaceAll("-", "");
  const items = new Map();
  let responseId = null;
  let sequence = -1;
  let createdDelivered = false;

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
      if (entry.item.type === "message") {
        entry.item.content ??= [];
        const contentIndex = event.content_index ?? 0;
        entry.item.content[contentIndex] ??= { type: "output_text", text: "" };
        entry.item.content[contentIndex].text += event.delta;
      }
    }
  }

  function markDelivered(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "response.created") createdDelivered = true;
    if (event.type !== "response.output_item.done") return;
    const outputIndex = Number.isSafeInteger(event.output_index) ? event.output_index : 0;
    const entry = items.get(outputIndex);
    if (entry) entry.deliveredDone = true;
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

  function finish(notice) {
    const events = [];
    ensureCreated(events);
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
    nextEvent(events, { type: "response.completed", response: { id: responseId, status: "completed", output: [...output, message] } });
    return events.map(sseFrame).join("");
  }

  function fail(code, message) {
    const events = [];
    ensureCreated(events);
    nextEvent(events, {
      type: "response.failed",
      response: { id: responseId, status: "failed", error: { code, message } },
    });
    return events.map(sseFrame).join("");
  }

  return { observe, markDelivered, finish, fail };
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
