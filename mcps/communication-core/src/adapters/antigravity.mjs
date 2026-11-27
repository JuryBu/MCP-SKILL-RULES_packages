import { identityKey } from "../contracts.mjs";
import { renderHostMessage as render } from "./host-message.mjs";

const MAX_STEPS = 500;
const USER_INPUT_TYPES = new Set(["user_input", "CORTEX_STEP_TYPE_USER_INPUT"]);
const PLANNER_RESPONSE_TYPES = new Set(["planner_response", "CORTEX_STEP_TYPE_PLANNER_RESPONSE"]);
const DONE_STATUSES = new Set(["DONE", "CORTEX_STEP_STATUS_DONE"]);
const DELIVERY_STRATEGIES = {
  next_model_boundary: "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION",
  when_idle: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
};

function isUserInput(step) {
  return step && typeof step === "object"
    && (USER_INPUT_TYPES.has(step.type) || Object.hasOwn(step, "user_input"));
}

function matchesInput(step, input) {
  if (!isUserInput(step)) return false;
  const userInput = step.user_input;
  const clientId = userInput?.client_message_id;
  if (clientId !== undefined && clientId !== null && clientId !== "") return clientId === input.delivery.delivery_id;
  return typeof userInput?.text === "string"
    && (userInput.text === render(input) || userInput.text === render(input, { includePriorityNotice: false }));
}

function matchesStepIdentity(step, description) {
  return ["cascade_id", "trajectory_id"].every(field => !Object.hasOwn(step, field) || step[field] === description[field]);
}

function originalInputPosition(window, input) {
  if (!window || typeof window.description.trajectory_id !== "string" || !window.description.trajectory_id.trim()) return -1;
  let selected = -1;
  for (let position = 0; position < window.steps.length; position += 1) {
    const step = window.steps[position];
    if (!matchesInput(step, input)) continue;
    if (selected !== -1 || !matchesStepIdentity(step, window.description) || !Number.isSafeInteger(step.index) || step.index < 0) return -1;
    selected = position;
  }
  return selected;
}

function result(input, outcome, reason, evidenceKind) {
  return {
    delivery_id: input.delivery.delivery_id,
    target_key: identityKey(input.target),
    outcome,
    ...(reason ? { reason } : {}),
    ...(evidenceKind ? { evidence: { kind: evidenceKind } } : {}),
  };
}

export class AntigravityDeliveryAdapter {
  constructor({ transport } = {}) {
    if (typeof transport?.describe !== "function" || typeof transport?.call !== "function" || typeof transport?.readSteps !== "function") {
      throw new TypeError("Antigravity transport需要describe、call和readSteps方法");
    }
    this.transport = transport;
    this.submissionTracking = transport.submissionTracking === true;
  }

  async deliver(input) {
    if (input.signal?.aborted) return result(input, "failed_before_send", "aborted_before_send");
    let description;
    try {
      description = await this.transport.describe(input.target, { signal: input.signal });
    } catch {
      const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (input.delivery.attempt_count ?? 1) - 1))));
      return { ...result(input, "busy", "transport_unavailable_before_send"), error: { code: "unavailable" }, evidence: { kind: "query", retry_after_ms: retryAfterMs } };
    }
    if (description?.cascade_id !== input.target.conversation_id) {
      return result(input, "failed_before_send", "cascade_id_mismatch");
    }
    let payload;
    try {
      const attachments = input.message.envelope.attachment_refs ?? [];
      if (!Array.isArray(attachments) || attachments.length) {
        return { ...result(input, "failed_before_send", "attachment_mapping_unsupported"), error: { code: "unsupported" } };
      }
      const policy = input.message.envelope.delivery_policy;
      if (!Object.hasOwn(DELIVERY_STRATEGIES, policy)) return result(input, "failed_before_send", "unsupported_delivery_policy");
      payload = {
        cascadeId: input.target.conversation_id,
        items: [{ text: render(input) }],
        clientMessageId: input.delivery.delivery_id,
        deliveryStrategy: DELIVERY_STRATEGIES[policy],
        blocking: false,
      };
    } catch {
      return result(input, "failed_before_send", "invalid_message");
    }
    if (input.signal?.aborted) return result(input, "failed_before_send", "aborted_before_send");
    try {
      const response = await this.transport.call("SendUserCascadeMessage", payload, { target: input.target, signal: input.signal, ...(typeof input.onRequestStarted === "function" ? { onRequestStarted: input.onRequestStarted } : {}) });
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        return result(input, "unknown", "missing_transport_result");
      }
      return result(input, "accepted", null, "transport");
    } catch (error) {
      if (error?.requestSent === false) {
        const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (input.delivery.attempt_count ?? 1) - 1))));
        return { ...result(input, "busy", "transport_unavailable_before_send"), error: { code: "unavailable" }, evidence: { kind: "query", retry_after_ms: retryAfterMs } };
      }
      return result(input, "unknown", "transport_submission_unconfirmed");
    }
  }

  async readWindow(input) {
    if (input.signal?.aborted) return null;
    const description = await this.transport.describe(input.target, { signal: input.signal });
    if (description?.cascade_id !== input.target.conversation_id) return null;
    if (!Number.isSafeInteger(description.step_count) || description.step_count < 0) return null;
    if (input.signal?.aborted) return null;
    const stepOffset = Math.max(0, description.step_count - MAX_STEPS);
    const response = await this.transport.readSteps(input.target, { stepOffset, signal: input.signal });
    if (!Array.isArray(response?.steps) || input.signal?.aborted) return null;
    return { description, steps: response.steps.slice(-MAX_STEPS) };
  }

  async query(input) {
    try {
      const window = await this.readWindow(input);
      if (originalInputPosition(window, input) !== -1) {
        return result(input, "accepted", null, "query");
      }
      return result(input, "unknown", "original_input_not_observed");
    } catch {
      return result(input, "unknown", "transport_query_unavailable");
    }
  }

  async observeReply(input) {
    try {
      const window = await this.readWindow(input);
      const originalPosition = originalInputPosition(window, input);
      if (originalPosition === -1) return null;
      const { description, steps } = window;
      let previousIndex = steps[originalPosition].index;
      if (!Number.isSafeInteger(previousIndex) || previousIndex < 0) return null;
      let selected = null;
      for (let position = originalPosition + 1; position < steps.length; position += 1) {
        const step = steps[position];
        if (!Number.isSafeInteger(step?.index) || step.index !== previousIndex + 1) return null;
        previousIndex = step.index;
        if (isUserInput(step)) return selected;
        if (!PLANNER_RESPONSE_TYPES.has(step.type) || !DONE_STATUSES.has(step.status)) continue;
        if (!matchesStepIdentity(step, description)) return null;
        const response = step.assistant_response;
        if (typeof response?.text !== "string" || !response.text.trim()) continue;
        if (response.final !== true) continue;
        if (typeof response.message_id !== "string" || !response.message_id.trim()) return null;
        selected = {
          native_message_id: response.message_id,
          text: response.text,
          source_step_index: step.index,
          cascade_id: description.cascade_id,
          trajectory_id: description.trajectory_id,
        };
      }
      return selected;
    } catch {
      return null;
    }
  }
}
