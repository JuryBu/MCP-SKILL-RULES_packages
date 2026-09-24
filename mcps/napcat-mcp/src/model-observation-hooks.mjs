const phases = new Set(["response.created", "response.in_progress", "response.completed", "response.failed", "response.incomplete"]);
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function createRequestObservation({ emit, producerInstance, requestId, endpoint }) {
  if (typeof emit !== "function") return null;
  let inputModel = null;
  let invalidFields = 0;
  let submitted = false;
  let protocol = endpoint === "unsupported" ? "unsupported" : "pending";
  let nativeAttempt = null;
  let finished = false;
  const model = value => {
    if (value == null) return null;
    if (typeof value === "string" && modelPattern.test(value)) return value;
    invalidFields += 1;
    return null;
  };
  const send = (source, phase, fields = {}) => {
    try {
      emit({ type: "model_observation", schema_version: 2, producer_instance: producerInstance,
        request_id: requestId, upstream_attempt: submitted ? 1 : 0, native_attempt: nativeAttempt,
        at: new Date().toISOString(), endpoint, protocol, observation_source: source, phase,
        proxy_input_model: inputModel, forwarded_model: submitted ? inputModel : null,
        request_sent: submitted, invalid_fields: invalidFields, outcome: "in_progress", ...fields });
    } catch {}
  };
  return {
    parsed(value) { inputModel = model(value); send("proxy_forward", "request.parsed"); },
    submitted(attempt = null) {
      nativeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
      submitted = true;
      send("proxy_forward", "request.submitted", { outcome: "in_progress" });
    },
    headers(headers, statusCode) {
      const contentType = typeof headers["content-type"] === "string" ? headers["content-type"].trim().toLowerCase() : "";
      protocol = contentType.includes("text/event-stream") ? "sse" : contentType.includes("json") ? "json"
        : contentType || endpoint === "unsupported" ? "unsupported" : "pending";
      send("upstream", "upstream.headers", { upstream_header_model: model(headers["openai-model"]),
        outcome: statusCode >= 400 ? "failed" : "in_progress" });
    },
    event(event) {
      if (!event || !phases.has(event.type)) return;
      protocol = "sse";
      send("upstream", event.type, { upstream_response_model: model(event.response?.model),
        outcome: event.type === "response.completed" ? "completed"
          : ["response.failed", "response.incomplete"].includes(event.type) ? "failed" : "in_progress" });
    },
    json(value) {
      protocol = "json";
      send("upstream", "response.json", { upstream_response_model: model(value?.model) });
      if (value?.response?.model != null) send("upstream", "response.json", { upstream_response_model: model(value.response.model) });
    },
    ended(kind = "ended_unknown") {
      if (finished) return;
      finished = true;
      const outcome = kind === "completed" ? "completed" : kind === "cancelled" ? "cancelled"
        : kind === "ended_unknown" ? "ended_unknown" : "failed";
      send("proxy_lifecycle", "request.ended", { outcome });
    },
    synthetic() { send("proxy_synthetic", "proxy.synthetic"); },
    unsupported() { send("proxy_lifecycle", "unsupported"); },
  };
}
