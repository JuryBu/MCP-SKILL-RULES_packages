export function createInnerNativeTurnSource({ sourceId, coordinator, maximumRemembered = 4096, previousSource }) {
  if (!sourceId || !coordinator || !Number.isInteger(maximumRemembered) || maximumRemembered < 1 || maximumRemembered > 65536) {
    throw new Error("NATIVE_SOURCE_INVALID_OPTIONS");
  }
  const previousStatus = previousSource?.status();
  if (previousStatus && !previousStatus.healthy) throw new Error("NATIVE_SOURCE_UNAVAILABLE");
  const previous = previousSource?.handoff?.();
  const remembered = new Map(previous?.remembered);
  while (remembered.size > maximumRemembered) remembered.delete(remembered.keys().next().value);
  const rejectionLimit = Math.min(maximumRemembered, 128);
  const rejections = (previous?.rejections ?? []).slice(-rejectionLimit);
  let healthy = true;
  let duplicates = previousStatus?.duplicates ?? 0;
  let delivered = previousStatus?.delivered ?? 0;
  let rejected = previousStatus?.rejected ?? 0;
  let failureCode = null;
  let pending = previous?.pending ?? previousSource?.observe(null) ?? Promise.resolve();
  const invalidate = code => { healthy = false; failureCode = code; };
  if (previousSource) {
    pending = Promise.resolve(pending).then(() => {
      if (!previousSource.status().healthy || !coordinator.status().nativeHealthy) throw new Error("NATIVE_SOURCE_RELAY_FAILED");
    }).catch(error => { invalidate(error.code ?? "NATIVE_SOURCE_RELAY_FAILED"); throw error; });
    pending.catch(() => {});
  }
  function observe(message) {
    if (!healthy) throw new Error("NATIVE_SOURCE_UNAVAILABLE");
    if (!message || Object.hasOwn(message, "id") || !["turn/started", "turn/completed"].includes(message.method)) return pending;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    const status = message.method === "turn/completed" ? message.params?.turn?.status : "active";
    if (typeof threadId !== "string" || !threadId || threadId.length > 512 || typeof turnId !== "string" || !turnId || turnId.length > 512
      || !["active", "completed", "failed", "interrupted"].includes(status)) {
      invalidate("NATIVE_SOURCE_INVALID_EVENT");
      throw new Error(failureCode);
    }
    const key = JSON.stringify([threadId, turnId, message.method]);
    if (remembered.has(key)) {
      if (remembered.get(key) !== status) {
        invalidate("NATIVE_SOURCE_CONFLICTING_DUPLICATE");
        throw new Error(failureCode);
      }
      duplicates += 1;
      return pending;
    }
    try {
      const relayed = coordinator.observeNativeMessage(sourceId, message);
      remembered.set(key, status);
      if (remembered.size > maximumRemembered) remembered.delete(remembered.keys().next().value);
      delivered += 1;
      pending = Promise.all([pending, relayed]).then(() => {
        if (!coordinator.status().nativeHealthy) throw new Error("NATIVE_SOURCE_RELAY_FAILED");
      }).catch(error => { invalidate(error.code ?? "NATIVE_SOURCE_RELAY_FAILED"); throw error; });
      return pending;
    } catch (error) {
      const code = error.code ?? error.message;
      if (["COORDINATOR_THREAD_LIMIT", "COORDINATOR_NATIVE_SEQUENCE_INVALID"].includes(code)) {
        rejected += 1;
        rejections.push({ sourceId, threadId, turnId, method: message.method, status, code });
        if (rejections.length > rejectionLimit) rejections.shift();
      } else invalidate(error.code ?? "NATIVE_SOURCE_SEQUENCE_FAILED");
      throw error;
    }
  }
  return { observe, invalidate,
    handoff() {
      if (!healthy) throw new Error("NATIVE_SOURCE_UNAVAILABLE");
      return { remembered: new Map(remembered), rejections: rejections.map(entry => ({ ...entry })), pending };
    },
    status: () => ({ healthy, failureCode, delivered, duplicates, remembered: remembered.size, rejected,
      rejections: rejections.map(entry => ({ ...entry })) }) };
}
