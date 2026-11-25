import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBoundedJsonlWriter } from "./bounded-jsonl-log.mjs";
import { readNativeProcessIdentity } from "./native-process-connection-identity.mjs";

export const LIFECYCLE_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxFiles: 4, retentionMs: 7 * 86400_000 });
const events = new Set(["started", "attached", "child_started", "identity_observed", "step", "stop_requested", "exit_observed", "error_observed"]);
const components = new Set(["outer", "native", "worker", "supervisor", "unknown"]);
const steps = new Set(["created", "listening", "probing", "spawned", "ready", "stop_requested", "draining", "child_stop_requested", "child_exited", "resources_closed", "exiting", "failed"]);
const reasons = new Set(["requested", "control_request", "signal", "stop_file", "ipc_shutdown", "ipc_disconnect", "ipc_failure", "startup_failure", "uncaught_exception", "unhandled_rejection", "recovery", "timeout", "unknown"]);
const actors = new Set(["runner", "control", "supervisor", "signal", "stop_file", "unknown"]);
const scopes = new Set(["self", "native", "worker", "runtime_tree", "unknown"]);
const signals = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGHUP", "SIGBREAK", "SIGSEGV"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const select = (values, value, fallback = "unknown") => values.has(value) ? value : fallback;
const identifier = value => typeof value === "string" && uuidPattern.test(value) ? value : null;
const pid = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function identity(value = {}) {
  return {
    pid: pid(value.pid),
    parentPid: pid(value.parentPid),
    creationTime: typeof value.creationTime === "string" && timePattern.test(value.creationTime)
      && Number.isFinite(Date.parse(value.creationTime)) ? value.creationTime : null,
    creationTimeSource: select(new Set(["os", "process_uptime_estimate"]), value.creationTimeSource),
  };
}

export function createRuntimeLifecycleDiagnostics(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());
  const filePath = path.resolve(options.filePath);
  const writer = createBoundedJsonlWriter({ filePath, fsImpl, now, ...LIFECYCLE_LIMITS });
  const startupId = identifier(options.startupId) ?? randomUUID();
  const self = identity(options.identity ?? {
    pid: process.pid, parentPid: process.ppid,
    creationTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    creationTimeSource: "process_uptime_estimate",
  });
  const component = select(components, options.component);
  const startedAt = typeof options.startedAt === "string" && timePattern.test(options.startedAt)
    && Number.isFinite(Date.parse(options.startedAt)) ? options.startedAt : new Date(now()).toISOString();
  const disposers = new Set();
  const watched = new WeakSet();
  const childIdentities = new WeakMap();
  const inspections = new Set();
  let sequence = 0;
  let failures = 0;
  let identityFailures = 0;
  let closed = false;
  let lastStep = "created";

  function record(event, details = {}) {
    if (closed || !events.has(event)) return false;
    try {
      if (steps.has(details.step)) lastStep = details.step;
      const row = {
        schemaVersion: 1, at: new Date(now()).toISOString(), startedAt, sequence: ++sequence,
        event, component, startupId, identity: self, lastStep,
        targetComponent: select(components, details.targetComponent, component),
        target: details.target ? identity(details.target) : self,
        actorKind: select(actors, details.actorKind),
        actor: details.actor ? identity(details.actor) : null,
        operationId: identifier(details.operationId),
        controlSequence: Number.isSafeInteger(details.controlSequence) && details.controlSequence > 0 ? details.controlSequence : null,
        scope: select(scopes, details.scope), reasonCode: select(reasons, details.reasonCode),
        exitCode: Number.isSafeInteger(details.exitCode) && details.exitCode >= -2147483648
          && details.exitCode <= 4294967295 ? details.exitCode : null,
        signal: signals.has(details.signal) ? details.signal : null,
      };
      writer.append(row);
      const descriptor = fsImpl.openSync(filePath, "r+");
      try { fsImpl.fsyncSync(descriptor); } finally { fsImpl.closeSync(descriptor); }
      return true;
    } catch {
      failures += 1;
      return false;
    }
  }

  function inspectIdentity(target, executablePath, targetComponent) {
    if (!options.captureIdentity || closed || !target.pid || !target.parentPid || !executablePath) return () => {};
    const controller = new AbortController();
    inspections.add(controller);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      return (options.readIdentity ?? readNativeProcessIdentity)({
        pid: target.pid, parentPid: target.parentPid, executablePath, signal: controller.signal, timeoutMs: 2000,
      });
    }).then(observed => {
      if (closed || controller.signal.aborted) return;
      const verified = identity({ ...observed, creationTimeSource: "os" });
      if (verified.pid !== target.pid || verified.parentPid !== target.parentPid || !verified.creationTime) {
        identityFailures += 1;
        return;
      }
      Object.assign(target, verified);
      record("identity_observed", { target, targetComponent });
    }).catch(() => { if (!controller.signal.aborted) identityFailures += 1; })
      .finally(() => inspections.delete(controller));
    return () => { controller.abort(); inspections.delete(controller); };
  }

  function watchProcess(processLike = process) {
    if (closed || watched.has(processLike)) return () => {};
    watched.add(processLike);
    const cancelInspection = inspectIdentity(self, options.executablePath ?? process.execPath, component);
    const onExit = exitCode => {
      record("exit_observed", { exitCode, scope: "self" });
      close();
    };
    const onException = () => record("error_observed", { reasonCode: "uncaught_exception", step: "failed" });
    processLike.once("exit", onExit);
    processLike.on("uncaughtExceptionMonitor", onException);
    const dispose = () => {
      processLike.removeListener("exit", onExit);
      processLike.removeListener("uncaughtExceptionMonitor", onException);
      disposers.delete(dispose);
      watched.delete(processLike);
      cancelInspection();
    };
    disposers.add(dispose);
    return dispose;
  }

  function watchChild(child, childIdentity = {}, targetComponent = "unknown") {
    if (closed || !child || typeof child.once !== "function" || childIdentities.has(child)) return () => {};
    watched.add(child);
    const target = identity({ ...childIdentity, pid: child.pid });
    childIdentities.set(child, target);
    record("child_started", { target, targetComponent, step: "spawned" });
    const cancelInspection = inspectIdentity(target, childIdentity.executablePath, targetComponent);
    const onExit = (exitCode, signal) => {
      record("exit_observed", { target, targetComponent, exitCode, signal });
      dispose();
    };
    const dispose = () => {
      child.removeListener("exit", onExit);
      disposers.delete(dispose);
      watched.delete(child);
      cancelInspection();
    };
    child.once("exit", onExit);
    disposers.add(dispose);
    if (Number.isInteger(child.exitCode) || child.signalCode) onExit(child.exitCode, child.signalCode);
    return dispose;
  }

  function stopInspections() {
    for (const controller of inspections) controller.abort();
    inspections.clear();
  }

  function close() {
    closed = true;
    for (const dispose of [...disposers]) dispose();
    stopInspections();
  }

  return {
    record, watchProcess, watchChild, close, stopInspections,
    selfIdentity: () => ({ ...self }),
    childIdentity: child => childIdentities.get(child) ?? { pid: child?.pid, parentPid: self.pid },
    status: () => ({ startupId, startedAt, sequence, failures, identityFailures, closed, lastStep, ...LIFECYCLE_LIMITS }),
  };
}
