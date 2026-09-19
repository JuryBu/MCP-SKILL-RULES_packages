import crypto from "node:crypto";

const HEARTBEATS = new Set(["keepalive", "keep_alive", "heartbeat", "ping", "response.in_progress", "response.queued"]);
const CONTENT_DELTAS = new Set(["response.output_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta"]);

export function deliveryProfileKey(headers, payload, origin) {
  const account = headers?.["chatgpt-account-id"];
  const model = payload?.model;
  if (typeof account !== "string" || !account.trim() || account.length > 4096
    || typeof model !== "string" || !model.trim() || model.length > 256) return null;
  return crypto.createHash("sha256").update(JSON.stringify([origin, account, model])).digest("hex");
}

export function createAdaptiveDeliveryRegistry(options = {}) {
  const cooldownMs = options.probeCooldownMs ?? 600_000;
  const ttlMs = options.profileTtlMs ?? 86_400_000;
  const profiles = new Map();
  const evidenceOrders = new Map();
  let attemptSequence = 0;
  const now = Date.now();
  const initial = options.state;
  if (initial !== undefined) {
    if (initial?.schemaVersion !== 1 || !Array.isArray(initial.profiles) || initial.profiles.length > 256) {
      throw new Error("Invalid adaptive delivery state");
    }
    for (const entry of initial.profiles) {
      if (!/^[a-f0-9]{64}$/u.test(entry?.key ?? "") || !["streaming", "buffered"].includes(entry.mode)
        || ![entry.updatedAt, entry.probeAfter, entry.evidenceStartedAt].every(Number.isSafeInteger)) {
        throw new Error("Invalid adaptive delivery profile");
      }
      if (entry.updatedAt > now || now - entry.updatedAt > ttlMs) continue;
      if (entry.evidenceStartedAt < 0 || entry.evidenceStartedAt > entry.updatedAt || entry.probeAfter < 0) {
        throw new Error("Invalid adaptive delivery evidence time");
      }
      profiles.set(entry.key, { key: entry.key, mode: entry.mode, updatedAt: entry.updatedAt,
        evidenceStartedAt: entry.evidenceStartedAt, probeAfter: Math.min(entry.probeAfter, now + cooldownMs) });
    }
  }
  const prune = (time) => {
    for (const [key, entry] of profiles) if (time - entry.updatedAt > ttlMs) { profiles.delete(key); evidenceOrders.delete(key); }
    while (profiles.size > 256) {
      const key = profiles.keys().next().value;
      profiles.delete(key);
      evidenceOrders.delete(key);
    }
  };
  const snapshot = () => ({ schemaVersion: 1, profiles: [...profiles.values()].map(entry => ({ ...entry })) });
  const save = (entry) => {
    profiles.delete(entry.key);
    profiles.set(entry.key, entry);
    prune(Date.now());
    try { options.onChange?.(snapshot()); } catch { options.onPersistenceError?.(); }
  };
  const profile = (key, time) => {
    prune(time);
    return profiles.get(key) ?? { key, mode: "streaming", updatedAt: time, probeAfter: 0, evidenceStartedAt: 0 };
  };
  return {
    snapshot,
    summary() {
      prune(Date.now());
      return { profiles: profiles.size, buffered: [...profiles.values()].filter(entry => entry.mode === "buffered").length, probeCooldownMs: cooldownMs };
    },
    begin({ key, startedAt, firstProgressTimeoutMs, waitLimitMs, upstreamIdleTimeoutMs, streamMinSpanMs = 1500, onEvent = () => {} }) {
      if (!key) return null;
      const attemptOrder = ++attemptSequence;
      const initialProfile = profile(key, startedAt);
      let extended = initialProfile.mode === "buffered";
      let probing = false;
      let lastUpstreamAt = null;
      let heartbeatSeen = false;
      let firstContentAt = null;
      let lastContentAt = null;
      let totalUnits = 0;
      let deltaCount = 0;
      const channels = new Map();
      const emit = (type, extra = {}) => onEvent({ type, profileHash: key, ...extra });
      const evidence = () => {
        for (const channel of channels.values()) {
          if (channel.count >= 8 && channel.small >= channel.count * 0.8
            && channel.last - channel.first >= streamMinSpanMs && channel.buckets.size >= 4) return "streaming";
        }
        if (deltaCount > 0 && totalUnits >= 256 && lastContentAt - firstContentAt <= 100) return "buffered";
        return "unknown";
      };
      emit("adaptive_delivery_started", { mode: initialProfile.mode, waitLimitMs, upstreamIdleTimeoutMs });
      return {
        active: () => extended,
        notePartialProgress(time) { lastUpstreamAt = time; },
        observe(event, time) {
          const type = event?.type;
          if (typeof type !== "string") return;
          if (type.startsWith("response.") || HEARTBEATS.has(type)) lastUpstreamAt = time;
          if (HEARTBEATS.has(type) && time - startedAt >= Math.min(1000, firstProgressTimeoutMs / 2)) heartbeatSeen = true;
          if (!CONTENT_DELTAS.has(type) || typeof event.delta !== "string" || !event.delta.length) return;
          firstContentAt ??= time;
          lastContentAt = time;
          totalUnits += event.delta.length;
          deltaCount++;
          const channelKey = `${type}:${event.item_id ?? event.output_index ?? "default"}`;
          if (!channels.has(channelKey) && channels.size >= 64) return;
          const channel = channels.get(channelKey) ?? { count: 0, small: 0, first: time, last: time, buckets: new Set() };
          channel.count++;
          if (event.delta.length <= 256) channel.small++;
          channel.last = time;
          if (channel.buckets.size < 8) channel.buckets.add(Math.floor((time - channel.first) / Math.max(1, streamMinSpanMs / 4)));
          channels.set(channelKey, channel);
        },
        tryProbe(time) {
          if (extended || !heartbeatSeen || lastUpstreamAt === null || time - lastUpstreamAt >= upstreamIdleTimeoutMs
            || evidence() === "streaming" || time >= startedAt + waitLimitMs) return false;
          const current = profile(key, time);
          if (current.mode !== "buffered" && current.probeAfter > time) return false;
          if (current.mode !== "buffered") save({ ...current, updatedAt: time, probeAfter: time + cooldownMs });
          extended = true;
          probing = current.mode !== "buffered";
          emit("adaptive_delivery_probe_started", { mode: probing ? "probe" : "buffered", elapsedMs: time - startedAt, deadlineAt: startedAt + waitLimitMs });
          return true;
        },
        deadline(normalDeadline, normalReason, phaseDeadline = null) {
          if (!extended) return { at: normalDeadline, reason: normalReason };
          let next = { at: startedAt + waitLimitMs, reason: "ADAPTIVE_WAIT_LIMIT" };
          const idle = { at: (lastUpstreamAt ?? startedAt) + upstreamIdleTimeoutMs, reason: "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT" };
          if (idle.at < next.at) next = idle;
          if (phaseDeadline && phaseDeadline.at < next.at) next = phaseDeadline;
          return next;
        },
        complete(time, eligible = true) {
          if (!eligible) return;
          const observed = evidence();
          const current = profile(key, time);
          emit("adaptive_delivery_observed", { observed, mode: current.mode, probing, elapsedMs: time - startedAt,
            firstContentDelayMs: firstContentAt === null ? null : firstContentAt - startedAt,
            contentSpanMs: firstContentAt === null ? null : lastContentAt - firstContentAt, deltaCount, totalUnits });
          if (observed === "unknown" || (observed === "buffered" && !extended)) return;
          if (startedAt < current.evidenceStartedAt || attemptOrder < (evidenceOrders.get(key) ?? 0)) return;
          const nextMode = observed === "streaming" ? "streaming"
            : observed === "buffered" && extended ? "buffered" : current.mode;
          save({ ...current, mode: nextMode, evidenceStartedAt: startedAt, updatedAt: time });
          evidenceOrders.set(key, attemptOrder);
          if (nextMode !== current.mode) emit("adaptive_delivery_mode_changed", { from: current.mode, to: nextMode, observed });
          if (probing && observed === "streaming") emit("adaptive_late_streaming_success", { elapsedMs: time - startedAt, nextFirstProgressTimeoutMs: firstProgressTimeoutMs });
        },
      };
    },
  };
}
