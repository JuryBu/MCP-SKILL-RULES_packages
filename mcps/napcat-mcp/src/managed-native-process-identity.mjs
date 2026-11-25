import { randomUUID } from "node:crypto";
import path from "node:path";
import { readNativeProcessIdentity } from "./native-process-connection-identity.mjs";

class ManagedNativeIdentityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new ManagedNativeIdentityError(code); };
const validPid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;

function executable(value) {
  if (typeof value !== "string" || !value || value.length > 32767 || value.trim() !== value) return null;
  let normalized = value.replaceAll("/", "\\");
  if (/^\\\\\?\\UNC\\/iu.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/iu.test(normalized)) normalized = normalized.slice(4);
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/iu.test(normalized)
    || /[<>"|?*\x00-\x1f]/u.test(normalized) || normalized.slice(2).includes(":")
    || normalized.endsWith("\\")) return null;
  return path.win32.normalize(normalized).toLowerCase();
}

function validBirth(value) {
  if (typeof value !== "string") return false;
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!matched || !Number.isFinite(Date.parse(value)) || Number(matched[1].slice(0, 4)) < 1601
    || Number(matched[2]) > 23 || Number(matched[3]) > 59 || Number(matched[4]) > 59) return false;
  const calendar = new Date(`${matched[1]}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== matched[1]) return false;
  const zone = matched[5];
  return zone === "Z" || (Number(zone.slice(1, 3)) <= 14 && Number(zone.slice(4)) <= 59
    && (Number(zone.slice(1, 3)) < 14 || Number(zone.slice(4)) === 0));
}

const samePin = (before, after) => before.child === after.child && before.pid === after.pid
  && before.parentPid === after.parentPid && before.executablePath === after.executablePath;

async function withAbort(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) fail("ABORTED");
  let abort;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => reject(new ManagedNativeIdentityError("ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createManagedNativeIdentitySupplier({ getServiceState, readIdentity = readNativeProcessIdentity } = {}) {
  if (typeof getServiceState !== "function" || typeof readIdentity !== "function") {
    throw new TypeError("Managed Native identity supplier callbacks must be functions");
  }
  const children = new WeakMap();

  function pinCurrent() {
    try {
      const state = getServiceState();
      if (!state || typeof state !== "object") fail("MANAGED_NATIVE_STATE_INVALID");
      if (state.stopRequested) fail("MANAGED_NATIVE_STOPPING");
      const child = state.appServer;
      if (!child || typeof child !== "object" || !validPid(child.pid)
        || (child.exitCode !== null && child.exitCode !== undefined)
        || (child.signalCode !== null && child.signalCode !== undefined) || child.killed === true) {
        fail("MANAGED_NATIVE_NOT_RUNNING");
      }
      const pinned = { child, pid: child.pid, parentPid: state.pid, executablePath: state.currentExecutable };
      if (!validPid(pinned.parentPid) || !executable(pinned.executablePath)) fail("MANAGED_NATIVE_STATE_INVALID");
      return pinned;
    } catch (error) {
      if (error instanceof ManagedNativeIdentityError) throw error;
      fail("MANAGED_NATIVE_STATE_UNAVAILABLE");
    }
  }

  function assertCurrent(pinned) {
    if (!samePin(pinned, pinCurrent())) fail("MANAGED_NATIVE_CHANGED");
  }

  function verifiedIdentity(observed, pinned) {
    try {
      const observedPath = executable(observed?.executablePath);
      if (!observed || observed.pid !== pinned.pid || observed.parentPid !== pinned.parentPid
        || !observedPath || observedPath !== executable(pinned.executablePath) || !validBirth(observed.creationTime)) {
        fail("MANAGED_NATIVE_IDENTITY_INVALID");
      }
      return Object.freeze({ pid: pinned.pid, parentPid: pinned.parentPid,
        executablePath: observedPath, creationTime: observed.creationTime });
    } catch (error) {
      if (error instanceof ManagedNativeIdentityError) throw error;
      fail("MANAGED_NATIVE_IDENTITY_INVALID");
    }
  }

  function initialize(entry) {
    const attempt = { controller: new AbortController(), waiters: 0, settled: false };
    entry.pending = attempt;
    attempt.promise = (async () => {
      try {
        const pinned = entry.pin;
        let observed;
        try {
          observed = await withAbort(Promise.resolve().then(() => readIdentity({
            pid: pinned.pid, parentPid: pinned.parentPid, executablePath: pinned.executablePath,
            signal: attempt.controller.signal,
          })), attempt.controller.signal);
        } catch (error) {
          if (attempt.controller.signal.aborted) fail("ABORTED");
          fail("MANAGED_NATIVE_IDENTITY_QUERY_FAILED");
        }
        if (attempt.controller.signal.aborted) fail("ABORTED");
        assertCurrent(pinned);
        entry.identity = verifiedIdentity(observed, pinned);
        return entry.identity;
      } finally {
        attempt.settled = true;
        if (entry.pending === attempt) entry.pending = null;
      }
    })();
    return attempt;
  }

  const getExpectedIdentity = async function ({ signal } = {}) {
    if (signal != null && !(signal instanceof AbortSignal)) fail("INVALID_SIGNAL");
    if (signal?.aborted) fail("ABORTED");
    const pinned = pinCurrent();
    let entry = children.get(pinned.child);
    if (!entry) {
      entry = { pin: pinned, generation: randomUUID(), identity: null, pending: null };
      children.set(pinned.child, entry);
    }
    if (!samePin(entry.pin, pinned)) fail("MANAGED_NATIVE_CHANGED");
    let identity;
    if (entry.identity) identity = await withAbort(Promise.resolve(entry.identity), signal);
    else {
      const attempt = entry.pending ?? initialize(entry);
      attempt.waiters += 1;
      try { identity = await withAbort(attempt.promise, signal); }
      finally {
        attempt.waiters -= 1;
        if (attempt.waiters === 0 && !attempt.settled) attempt.controller.abort();
      }
    }
    if (signal?.aborted) fail("ABORTED");
    assertCurrent(pinned);
    return Object.freeze({ ...identity, generation: entry.generation });
  };
  Object.defineProperty(getExpectedIdentity, "isCurrent", { value: expected => {
    try {
      if (!expected || typeof expected !== "object") return false;
      const pinned = pinCurrent();
      const entry = children.get(pinned.child);
      if (!entry?.identity || !samePin(entry.pin, pinned)) return false;
      const current = entry.identity;
      return expected.pid === current.pid && expected.parentPid === current.parentPid
        && executable(expected.executablePath) === current.executablePath
        && expected.creationTime === current.creationTime && expected.generation === entry.generation;
    } catch { return false; }
  } });
  return getExpectedIdentity;
}
