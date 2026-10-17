import crypto from "node:crypto";
import { createBoundedJsonlWriter } from "./bounded-jsonl-log.mjs";

export function createManagedEventObserver(options) {
  const writer = options.writer ?? createBoundedJsonlWriter({ filePath: options.filePath, maxBytes: 512 * 1024, maxFiles: 2 });
  return event => {
    if (!event || !["request_rejected", "request_routed", "migration_committed", "migration_failed", "migration_waiting_inflight"].includes(event.type)) return;
    const value = { at: new Date().toISOString(), type: event.type };
    for (const name of ["code", "requestClass", "method"]) {
      if (typeof event[name] === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(event[name])) value[name] = event[name];
    }
    if (typeof event.path === "string" && ["/backend-api/codex/models", "/backend-api/codex/images/generations", "/backend-api/codex/images/edits", "/backend-api/codex/memories/trace_summarize"].includes(event.path)) value.path = event.path;
    if (/^[a-f0-9]{64}$/u.test(event.pathSha256 ?? "")) value.pathSha256 = event.pathSha256;
    if (typeof event.workerId === "string") value.workerFingerprint = crypto.createHash("sha256").update(event.workerId).digest("hex").slice(0,16);
    for (const name of ["threadHash", "turnHash", "currentTurnHash", "workerFingerprint"]) {
      if (typeof event[name] === "string" && /^[a-f0-9]{16}$/u.test(event[name])) value[name] = event[name];
    }
    for (const name of ["activeHttp", "workerActiveHttp", "coordinatorActiveHttp"]) {
      if (Number.isSafeInteger(event[name]) && event[name] >= 0) value[name] = event[name];
    }
    for (const name of ["nativeHealthy", "workerAlive"]) {
      if (typeof event[name] === "boolean") value[name] = event[name];
    }
    if (["native_unhealthy", "thread_not_found", "phase_not_active", "turn_mismatch", "worker_dead",
      "adoption_target_dead", "request_failed"].includes(event.reason)) value.reason = event.reason;
    if (["request_validation", "before_adopt", "during_adopt", "after_adopt", "forwarding"].includes(event.decisionPoint)) value.decisionPoint = event.decisionPoint;
    if (["active", "terminal"].includes(event.phase)) value.phase = event.phase;
    try { writer.append(value); } catch {}
  };
}
