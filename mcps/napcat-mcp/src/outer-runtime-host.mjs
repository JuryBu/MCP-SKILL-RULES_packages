export function createOuterRuntimeHost(options) {
  const assertRunnable = () => {
    if (!options.entry.runnable) throw new Error("OUTER_RUNTIME_PREPARE_SIDE_EFFECT_BLOCKED");
  };
  const gated = operation => (...args) => {
    assertRunnable();
    return operation(...args);
  };
  const service = (target, readMethods) => {
    if (!target) return target;
    const readers = new Set(readMethods);
    const view = {};
    for (const [name, value] of Object.entries(target)) {
      if (typeof value === "function") {
        const invoke = (...args) => Reflect.apply(value, target, args);
        view[name] = readers.has(name) ? invoke : gated(invoke);
      } else if (name === "filePath" && typeof value === "string") {
        view[name] = value;
      }
    }
    return Object.freeze(view);
  };
  return Object.freeze({
    state: Object.freeze({
      journal: service(options.state.journal, ["get", "getWake", "visibilityWakes", "status"]),
      wakeVisibility: service(options.state.wakeVisibility, ["snapshot"]),
      displayPolicy: service(options.state.displayPolicy, ["status"]),
      resumeRequestTimeoutMs: options.state.resumeRequestTimeoutMs,
      writerEpoch: options.state.writerEpoch,
    }),
    readyClients: gated(options.readyClients),
    maintenanceStatus: options.maintenanceStatus,
    recordError: gated(options.recordError),
    injectRequest: gated(options.injectRequest),
    notifyRecoveryState: gated(options.notifyRecoveryState),
  });
}
