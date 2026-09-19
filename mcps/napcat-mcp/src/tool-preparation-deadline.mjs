import { toolIdentityHash } from "./tool-delivery-profile.mjs";

export function createToolPreparationDeadline(graceMs, options = {}) {
  const bufferedToolIdentityHashes = new Set(options.bufferedToolIdentityHashes ?? []);
  const bufferedToolPreparationGraceMs = options.bufferedToolPreparationGraceMs ?? 300_000;
  const pending = new Set();
  const closed = new Set();
  let graceDeadline = null;
  let retired = false;
  function observe(event, now) {
    if (event?.type === "response.function_call_arguments.delta" && typeof event.delta === "string" && event.delta.length > 0) {
      retired = true;
      return;
    }
    if (event?.type === "response.function_call_arguments.done"
      || ["response.completed", "response.failed", "response.incomplete"].includes(event?.type)) {
      retired = true;
      return;
    }
    if (event?.item?.type !== "function_call") return;
    const identity = event.item.id ?? event.item.call_id ?? event.output_index;
    if (identity === undefined || identity === null) return;
    if (event.type === "response.output_item.added") {
      if (typeof event.item.arguments === "string" && event.item.arguments.length > 0) retired = true;
      if (retired || closed.has(identity)) return;
      pending.add(identity);
      if (graceDeadline === null) {
        const matchesBufferedDeliveryProfile = bufferedToolIdentityHashes.has(toolIdentityHash(event.item));
        graceDeadline = now + (matchesBufferedDeliveryProfile ? bufferedToolPreparationGraceMs : graceMs);
      }
    } else if (event.type === "response.output_item.done") {
      pending.delete(identity);
      closed.add(identity);
      if (pending.size === 0) retired = true;
    }
  }
  const active = () => !retired && pending.size > 0;
  function deadline(normalDeadline) {
    return active() ? graceDeadline : normalDeadline;
  }
  return { observe, deadline, active };
}

export function classifyContextHint(payload) {
  if (!Array.isArray(payload?.input)) return { contextPreparationHint: null, reminderCount: 0, inputItems: null, visibility: "unknown" };
  let reminderCount = 0;
  let opaqueItems = 0;
  for (const item of payload.input) {
    if (item?.encrypted_content) opaqueItems++;
    if (item?.role !== "developer") continue;
    const parts = typeof item.content === "string" ? [item.content]
      : Array.isArray(item.content) ? item.content.filter(part => part?.type === "input_text" || part?.type === "text").map(part => part.text) : [];
    for (const content of parts) {
      if (typeof content !== "string") continue;
      reminderCount += (content.match(/<context_window_reminder>[\s\S]*?<\/context_window_reminder>/gu) ?? []).length;
    }
  }
  return { contextPreparationHint: reminderCount > 0 ? true : null, hintFreshness: "unknown",
    reminderCount, inputItems: payload.input.length, opaqueItems,
    visibility: reminderCount > 0 ? "visible_hint_not_execution" : opaqueItems ? "partial" : "visible_no_hint" };
}
