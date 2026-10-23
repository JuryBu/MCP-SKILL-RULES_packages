import crypto from "node:crypto";

const phases = new Set(["waiting", "retrying", "resumed", "completed", "failed", "stopped"]);
const terminal = new Set(["completed", "failed", "stopped"]);
const textId = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\u0000");
const digest = (value, capability) => crypto.createHmac("sha256", Buffer.from(capability, "hex"))
  .update(JSON.stringify(value)).digest("hex");
const payload = envelope => Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "signature"));

export function recoveryIdentityMatches(envelope, expected) {
  return ["ownerId", "nativeSourceId", "producerId", "producerPid", "connectionGeneration"].every(key =>
    expected?.[key] !== undefined && envelope?.[key] === expected[key])
    && ["core", "helper", "runner", "control"].every(key => typeof expected.sourceHashes?.[key] === "string"
      && envelope.sourceHashes?.[key] === expected.sourceHashes[key]);
}

export function signRecoveryEnvelope(identity, event, capability) {
  const envelope = { ...identity, recovery: structuredClone(event) };
  return { ...envelope, signature: digest(envelope, capability) };
}

export function validateRecoveryEnvelope(envelope, expected, capability) {
  const event = envelope?.recovery;
  if (!recoveryIdentityMatches(envelope, expected) || !event || event.type !== "model_recovery_state"
    || ![event.requestId, event.threadId, event.turnId].every(textId)
    || event.threadId !== expected.threadId || event.turnId !== expected.turnId
    || expected.requestId !== undefined && event.requestId !== expected.requestId
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !phases.has(event.phase)
    || typeof event.willRetry !== "boolean" || typeof event.canContinueHttp !== "boolean"
    || typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(digest(payload(envelope), capability), "hex"));
}

export function canContinueRecovery(event) {
  return event?.phase === "waiting" && event.canContinueHttp === true
    && ["rejected", "not_sent"].includes(event.acceptance) && textId(event.requestId);
}

export function createRecoveryNotificationRouter({ ownerId, nativeSourceId, bindingFor, sendNotification, limit = 128 }) {
  const pending = new WeakMap();
  const subscriptions = new Map();
  const records = new Map();
  const trim = map => { while (map.size > limit) map.delete(map.keys().next().value); };
  return {
    expectTurn(client, threadId, requestId = Symbol(), connectionGeneration = client.metadataUpstreamGeneration) {
      if (!textId(threadId)) return;
      const requests = pending.get(client) ?? new Map();
      requests.set(requestId, { threadId, connectionGeneration });
      trim(requests);
      pending.set(client, requests);
    },
    rejectExpectedTurn(client, requestId, connectionGeneration) {
      const requests = pending.get(client);
      const expected = requests?.get(requestId);
      if (!expected || expected.connectionGeneration !== connectionGeneration) return false;
      return requests.delete(requestId);
    },
    observeNative(client, message, connectionGeneration) {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      const requests = pending.get(client);
      const expected = message.method === "turn/started" && textId(turnId)
        ? [...(requests ?? [])].find(([, request]) => request.threadId === threadId
          && request.connectionGeneration === connectionGeneration) : null;
      if (expected) {
        requests.delete(expected[0]);
        const previous = subscriptions.get(threadId);
        if (previous && previous.turnId === turnId && previous.client !== client) return false;
        subscriptions.set(threadId, { client, turnId, connectionGeneration, active: true });
        trim(subscriptions);
        return true;
      }
      const subscription = subscriptions.get(threadId);
      if (message.method === "turn/completed" && subscription?.turnId === turnId) subscription.active = false;
      return subscription?.active === true && subscription.client === client && subscription.turnId === turnId;
    },
    accept(envelope) {
      const event = envelope?.recovery;
      if (!event) return { accepted: false };
      const subscription = subscriptions.get(event.threadId);
      const expected = bindingFor(event.threadId, event.turnId, event.requestId);
      if (!subscription?.active || subscription.turnId !== event.turnId || subscription.client.closed
        || subscription.client.metadataUpstreamGeneration !== subscription.connectionGeneration
        || envelope.ownerId !== ownerId || envelope.nativeSourceId !== nativeSourceId
        || envelope.connectionGeneration !== subscription.connectionGeneration
        || !recoveryIdentityMatches(envelope, expected)
        || JSON.stringify(expected?.current) !== JSON.stringify(envelope)) return { accepted: false };
      const key = JSON.stringify([event.threadId, event.turnId, event.requestId]);
      const previous = records.get(key);
      if (previous?.terminal || event.sequence <= (previous?.sequence ?? 0)) return { accepted: false };
      if (!previous && records.size >= limit) {
        for (const [recordKey, record] of records) {
          const active = subscriptions.get(record.threadId);
          if (!active?.active || active.turnId !== record.turnId) records.delete(recordKey);
        }
        if (records.size >= limit) return { accepted: false };
      }
      const record = { ...event, displayState: event.phase === "stopped" ? "cancelled" : event.phase,
        actionRequired: canContinueRecovery(event) ? "choose_http_or_cancel" : event.acceptance === "unknown"
          ? "verify_request_state" : event.phase === "waiting" && !event.willRetry ? "cancel_or_verify" : "none",
        sequence: event.sequence, terminal: terminal.has(event.phase), noticed: previous?.noticed ?? false };
      if (event.phase === "resumed") record.noticed = false;
      records.set(key, record);
      if (!["waiting", "retrying"].includes(event.phase) || record.noticed) return { accepted: true, notified: false };
      const status = Number.isInteger(event.httpStatusCode) && event.httpStatusCode >= 400 && event.httpStatusCode <= 599
        ? event.httpStatusCode : null;
      const message = `模型请求遇到${status ? ` HTTP ${status} 故障` : "连接或传输故障"}，${event.willRetry
        ? "正在等待恢复并按退避策略重试，可取消当前回合。" : "已进入等待，自动重试已暂停，可取消当前回合或核对请求状态。"}`;
      const notification = { method: "error", params: { threadId: event.threadId, turnId: event.turnId,
        willRetry: event.willRetry, error: { message,
          ...(status ? { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } } : {}) } } };
      const sent = sendNotification(subscription.client, notification, { connectionGeneration: subscription.connectionGeneration });
      if (sent === true) record.noticed = true;
      return { accepted: true, notified: sent === true };
    },
    closeClient(client) {
      pending.delete(client);
      for (const subscription of subscriptions.values()) if (subscription.client === client) subscription.active = false;
    },
    status() { return [...records.values()].map(({ noticed, terminal: finished, ...record }) => structuredClone(record)); },
  };
}
