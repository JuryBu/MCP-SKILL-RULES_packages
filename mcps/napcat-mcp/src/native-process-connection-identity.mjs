import childProcess from "node:child_process";
import net from "node:net";
import path from "node:path";
import { windowsPowerShellEnvironment } from "./windows-powershell-environment.mjs";

class VerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new VerificationError(code); };
const rejection = code => Object.freeze({ trusted: false, code });
const validPid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;

function birth(value) {
  if (typeof value !== "string") return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = matched;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number(year) < 1601 || calendar.getUTCFullYear() !== Number(year)
    || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59
    || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0))) return null;
  const milliseconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
  return Number.isFinite(milliseconds) ? (BigInt(milliseconds) * 10000n + BigInt(fraction.padEnd(7, "0"))).toString() : null;
}

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

function processIdentity(value) {
  if (!value || !validPid(value.pid) || !validPid(value.parentPid)) return null;
  const creationTime = birth(value.creationTime);
  const executablePath = executable(value.executablePath);
  if (creationTime == null || executablePath == null) return null;
  return { pid: value.pid, parentPid: value.parentPid, creationTime, executablePath };
}

function expectedIdentity(value) {
  const observed = processIdentity(value);
  if (!observed || (value.alive !== undefined && value.alive !== true)) return null;
  const generation = value.generation;
  if (!(typeof generation === "string" && generation.length > 0 && generation.length <= 128
    && generation.trim() === generation && !/[\x00-\x1f\x7f]/u.test(generation))
    && !(Number.isSafeInteger(generation) && generation >= 0)) return null;
  return {
    key: JSON.stringify({ ...observed, generation }),
    processKey: JSON.stringify(observed),
    public: Object.freeze({ ...observed, creationTime: value.creationTime, generation }),
  };
}

function address(value) {
  if (typeof value !== "string" || value.length > 80 || !/^[a-f\d:.%]+$/iu.test(value)) return null;
  const parts = value.split("%");
  if (parts.length > 2) return null;
  const [plain, rawScope] = parts;
  const scope = rawScope === undefined ? "" : (/^\d{1,10}$/u.test(rawScope)
    && Number(rawScope) > 0 && Number(rawScope) <= 0xffffffff ? `%${Number(rawScope)}` : null);
  if (scope == null) return null;
  const family = net.isIP(plain);
  if (family === 4) {
    if (scope) return null;
    const bytes = plain.split(".").map(Number);
    const mapped = `::ffff:${(bytes[0] * 256 + bytes[1]).toString(16)}:${(bytes[2] * 256 + bytes[3]).toString(16)}`;
    return { canonical: plain, queries: [plain, `::ffff:${plain}`, mapped] };
  }
  if (family !== 6) return null;
  const canonical = new URL(`http://[${plain}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/iu.exec(canonical);
  if (mapped) {
    if (scope) return null;
    const upper = Number.parseInt(mapped[1], 16);
    const lower = Number.parseInt(mapped[2], 16);
    return address(`${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`);
  }
  return { canonical: `${canonical}${scope}`, queries: [`${canonical}${scope}`] };
}

function tuple(value) {
  const local = address(value?.localAddress);
  const remote = address(value?.remoteAddress);
  if (!local || !remote || !validPort(value.localPort) || !validPort(value.remotePort)) return null;
  return Object.freeze({ localAddress: local.canonical, localPort: value.localPort,
    remoteAddress: remote.canonical, remotePort: value.remotePort });
}

const tupleKey = value => JSON.stringify(value);

function socketTuple(socket, retired) {
  if (!socket || typeof socket !== "object" || typeof socket.on !== "function"
    || typeof socket.removeListener !== "function") fail("INVALID_SOCKET");
  if (retired.has(socket) || socket.destroyed !== false || socket.closed === true || socket.connecting === true
    || socket.pending === true || socket.readable === false || socket.writable === false
    || socket.readableEnded === true || socket.writableEnded === true || socket.readyState !== "open") fail("CONNECTION_CLOSED");
  const normalized = tuple(socket);
  if (!normalized) fail("INVALID_ENDPOINT");
  return normalized;
}

function connectionRow(rows, target, owner, ownerCode) {
  if (!Array.isArray(rows)) fail("INVALID_INSPECTION");
  if (rows.length === 0) fail("CONNECTION_NOT_FOUND");
  if (rows.length !== 1) fail("AMBIGUOUS_CONNECTION");
  const record = rows[0];
  const observed = tuple(record);
  if (!observed || !validPid(record.owningProcess) || birth(record.creationTime) == null) fail("INVALID_INSPECTION");
  if (tupleKey(observed) !== tupleKey(target)) fail("CONNECTION_TUPLE_MISMATCH");
  if (record.state !== "Established") fail("CONNECTION_NOT_ESTABLISHED");
  if (record.owningProcess !== owner) fail(ownerCode);
  return birth(record.creationTime);
}

function validateInspection(data, connection, identity, serverPid) {
  if (!data || !Array.isArray(data.samples) || data.samples.length !== 2) fail("INVALID_INSPECTION");
  const reverse = { localAddress: connection.remoteAddress, localPort: connection.remotePort,
    remoteAddress: connection.localAddress, remotePort: connection.localPort };
  let previous;
  for (const sample of data.samples) {
    if (!sample || typeof sample !== "object") fail("INVALID_INSPECTION");
    const server = connectionRow(sample.serverConnections, connection, serverPid, "SERVER_OWNER_MISMATCH");
    const peer = connectionRow(sample.peerConnections, reverse, identity.public.pid, "CONNECTION_OWNER_MISMATCH");
    if (!Array.isArray(sample.processes)) fail("INVALID_INSPECTION");
    if (sample.processes.length === 0) fail("PROCESS_NOT_FOUND");
    if (sample.processes.length !== 1) fail("AMBIGUOUS_PROCESS");
    const observed = processIdentity(sample.processes[0]);
    if (!observed) fail("INVALID_INSPECTION");
    if (JSON.stringify(observed) !== identity.processKey) fail("PROCESS_IDENTITY_MISMATCH");
    if (BigInt(peer) / 10000000n < BigInt(observed.creationTime) / 10000000n) {
      fail("CONNECTION_PREDATES_PROCESS");
    }
    const current = JSON.stringify({ server, peer });
    if (previous !== undefined && current !== previous) fail("CONNECTION_CHANGED");
    previous = current;
  }
}

function powershellProcessReader(pid) {
  return `function Read-ProcessIdentity {
  Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, ExecutablePath FROM Win32_Process WHERE ProcessId = ${pid}' -ErrorAction Stop | ForEach-Object {
    [ordered]@{pid=[long]$_.ProcessId;parentPid=[long]$_.ParentProcessId;creationTime=$_.CreationDate.ToUniversalTime().ToString('o');executablePath=$_.ExecutablePath}
  }
}`;
}

function powershellScript(connection, pid) {
  const addresses = value => `@(${address(value).queries.map(item => `'${item}'`).join(",")})`;
  const forward = `${addresses(connection.localAddress)} ${connection.localPort} ${addresses(connection.remoteAddress)} ${connection.remotePort}`;
  const reverse = `${addresses(connection.remoteAddress)} ${connection.remotePort} ${addresses(connection.localAddress)} ${connection.localPort}`;
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
${powershellProcessReader(pid)}
function Read-Tuple([string[]]$localAddresses,[int]$localPort,[string[]]$remoteAddresses,[int]$remotePort) {
  try { $rows=@(Get-NetTCPConnection -LocalAddress $localAddresses -LocalPort $localPort -RemoteAddress $remoteAddresses -RemotePort $remotePort -State Established -ErrorAction Stop) }
  catch { if ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) { return }; throw }
  foreach ($row in $rows) {
    [ordered]@{localAddress=$row.LocalAddress;localPort=[int]$row.LocalPort;remoteAddress=$row.RemoteAddress;remotePort=[int]$row.RemotePort;state=$row.State.ToString();owningProcess=[long]$row.OwningProcess;creationTime=$row.CreationTime.ToUniversalTime().ToString('o')}
  }
}
function Read-Sample {
  $serverRows=@(Read-Tuple ${forward});
  $peerRows=@(Read-Tuple ${reverse});
  $processRows=@(Read-ProcessIdentity);
  [ordered]@{serverConnections=$serverRows;peerConnections=$peerRows;processes=$processRows}
}
try { [ordered]@{samples=@((Read-Sample),(Read-Sample))} | ConvertTo-Json -Depth 7 -Compress }
catch { [Console]::Error.Write('native_identity_inspection_failed'); exit 1 }`;
}

async function runPowerShell(script, { platform, timeoutMs, signal }) {
  if (platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  if (signal.aborted) throw signal.reason;
  const configured = windowsPowerShellEnvironment();
  let abortOperation;
  const cancelled = new Promise((resolve, reject) => {
    abortOperation = () => reject(signal.reason);
    signal.addEventListener("abort", abortOperation, { once: true });
  });
  try {
    const execution = new Promise((resolve, reject) => {
      childProcess.execFile(configured.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 65536,
        timeout: timeoutMs, signal, env: configured.environment,
      }, (error, stdout) => error ? reject(new VerificationError("INSPECTION_FAILED")) : resolve(stdout));
    });
    const output = await Promise.race([execution, cancelled]);
    if (signal.aborted) throw signal.reason;
    try {
      if (typeof output !== "string" || output.length > 65536) fail("INVALID_INSPECTION");
      return JSON.parse(output.replace(/^\uFEFF/u, ""));
    } catch { fail("INVALID_INSPECTION"); }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof VerificationError) throw error;
    fail("INSPECTION_FAILED");
  } finally { signal.removeEventListener("abort", abortOperation); }
}

function windowsInspector(platform, timeoutMs) {
  return (connection, { expectedIdentity: identity, signal }) => runPowerShell(powershellScript(connection, identity.pid), { platform, timeoutMs, signal });
}

export async function readNativeProcessIdentity({
  pid, parentPid, executablePath, signal, timeoutMs = 10000, platform = process.platform,
} = {}) {
  const expectedPath = executable(executablePath);
  if (!validPid(pid) || !validPid(parentPid) || !expectedPath) fail("EXPECTED_IDENTITY_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail("INVALID_TIMEOUT");
  if (signal != null && !(signal instanceof AbortSignal)) fail("INVALID_SIGNAL");
  if (signal?.aborted) fail("ABORTED");
  const controller = new AbortController();
  const abortCaller = () => controller.abort(new VerificationError("ABORTED"));
  signal?.addEventListener("abort", abortCaller, { once: true });
  const deadline = setTimeout(() => controller.abort(new VerificationError("INSPECTION_TIMEOUT")), timeoutMs);
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
${powershellProcessReader(pid)}
try { [ordered]@{processSamples=@(@(Read-ProcessIdentity),@(Read-ProcessIdentity))} | ConvertTo-Json -Depth 5 -Compress }
catch { [Console]::Error.Write('native_identity_inspection_failed'); exit 1 }`;
  try {
    const data = await runPowerShell(script, { platform, timeoutMs, signal: controller.signal });
    if (!data || !Array.isArray(data.processSamples) || data.processSamples.length !== 2) fail("INVALID_INSPECTION");
    let previous;
    let result;
    for (const processes of data.processSamples) {
      if (!Array.isArray(processes)) fail("INVALID_INSPECTION");
      if (processes.length === 0) fail("PROCESS_NOT_FOUND");
      if (processes.length !== 1) fail("AMBIGUOUS_PROCESS");
      const observed = processIdentity(processes[0]);
      if (!observed) fail("INVALID_INSPECTION");
      const key = JSON.stringify(observed);
      if (observed.pid !== pid || observed.parentPid !== parentPid || observed.executablePath !== expectedPath
        || (previous !== undefined && previous !== key)) fail("PROCESS_IDENTITY_MISMATCH");
      previous = key;
      result = { ...observed, creationTime: processes[0].creationTime };
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    return Object.freeze(result);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof VerificationError) throw error;
    fail("INSPECTION_FAILED");
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abortCaller);
  }
}

export function createNativeProcessConnectionVerifier({
  getExpectedIdentity, inspectConnection, timeoutMs = 10000, serverPid = process.pid, platform = process.platform,
} = {}) {
  if (typeof getExpectedIdentity !== "function" || (inspectConnection !== undefined && typeof inspectConnection !== "function")) {
    throw new TypeError("Native connection verifier callbacks must be functions");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !validPid(serverPid)) {
    throw new RangeError("Native connection verifier requires a 1..60000ms timeout and a valid server PID");
  }
  const inspect = inspectConnection ?? windowsInspector(platform, timeoutMs);
  const records = new Map();
  const retired = new WeakSet();
  const active = new Set();
  let disposed = false;

  function detach(record) {
    for (const event of ["close", "end", "finish", "error"]) record.socket.removeListener(event, record.closedListener);
    if (records.get(record.socket) === record) records.delete(record.socket);
    record.cache = null;
  }

  function retire(record, code) {
    retired.add(record.socket);
    detach(record);
    for (const controller of record.controllers) controller.abort(new VerificationError(code));
  }

  function ensure(controller, record, connection) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (disposed) fail("DISPOSED");
    if (tupleKey(socketTuple(record.socket, retired)) !== tupleKey(connection)) {
      retire(record, "CONNECTION_CHANGED");
      fail("CONNECTION_CHANGED");
    }
  }

  async function currentIdentity(controller) {
    try {
      const value = await getExpectedIdentity({ signal: controller.signal });
      const normalized = expectedIdentity(value);
      if (!normalized) fail("EXPECTED_IDENTITY_INVALID");
      return normalized;
    } catch { fail("EXPECTED_IDENTITY_INVALID"); }
  }

  async function verify(socket, { signal } = {}) {
    if (disposed) return rejection("DISPOSED");
    if (signal != null && !(signal instanceof AbortSignal)) return rejection("INVALID_SIGNAL");
    if (signal?.aborted) return rejection("ABORTED");
    let connection;
    try { connection = socketTuple(socket, retired); }
    catch (error) {
      const code = error instanceof VerificationError ? error.code : "INVALID_SOCKET";
      const existing = records.get(socket);
      if (existing) retire(existing, code);
      return rejection(code);
    }
    let record = records.get(socket);
    if (!record) {
      record = { socket, connection, controllers: new Set(), identityKey: null, cache: null };
      record.closedListener = () => retire(record, "CONNECTION_CLOSED");
      records.set(socket, record);
      for (const event of ["close", "end", "finish", "error"]) socket.on(event, record.closedListener);
    }
    if (tupleKey(record.connection) !== tupleKey(connection)) {
      retire(record, "CONNECTION_CHANGED");
      return rejection("CONNECTION_CHANGED");
    }
    const controller = new AbortController();
    record.controllers.add(controller);
    active.add(controller);
    const abortCaller = () => controller.abort(new VerificationError("ABORTED"));
    signal?.addEventListener("abort", abortCaller, { once: true });
    const deadline = setTimeout(() => controller.abort(new VerificationError("INSPECTION_TIMEOUT")), timeoutMs);
    let abortOperation;
    const cancelled = new Promise((resolve, reject) => {
      abortOperation = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortOperation, { once: true });
    });
    const operation = async () => {
      const before = await currentIdentity(controller);
      ensure(controller, record, connection);
      if (record.identityKey !== null && record.identityKey !== before.key) {
        retire(record, "IDENTITY_CHANGED");
        fail("IDENTITY_CHANGED");
      }
      record.identityKey = before.key;
      const cached = record.cache !== null;
      let data;
      if (!cached) {
        try {
          data = await inspect(connection, Object.freeze({ expectedIdentity: before.public, serverPid, signal: controller.signal }));
        } catch (error) {
          if (error instanceof VerificationError) throw error;
          fail("INSPECTION_FAILED");
        }
      }
      ensure(controller, record, connection);
      const after = await currentIdentity(controller);
      ensure(controller, record, connection);
      if (before.key !== after.key || record.identityKey !== after.key) {
        retire(record, "IDENTITY_CHANGED");
        fail("IDENTITY_CHANGED");
      }
      if (!cached) validateInspection(data, connection, before, serverPid);
      ensure(controller, record, connection);
      record.cache = before.public;
      return Object.freeze({ trusted: true, code: "TRUSTED", cached, identity: before.public });
    };
    try {
      const result = await Promise.race([operation(), cancelled]);
      ensure(controller, record, connection);
      return result;
    } catch (error) {
      const code = controller.signal.aborted ? controller.signal.reason?.code
        : error instanceof VerificationError ? error.code : "INVALID_INSPECTION";
      if (["EXPECTED_IDENTITY_INVALID", "CONNECTION_CLOSED", "CONNECTION_CHANGED", "INVALID_ENDPOINT"].includes(code)) retire(record, code);
      return rejection(code ?? "INSPECTION_FAILED");
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", abortOperation);
      signal?.removeEventListener("abort", abortCaller);
      record.controllers.delete(controller);
      active.delete(controller);
      if (record.cache === null && record.controllers.size === 0) detach(record);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of active) controller.abort(new VerificationError("DISPOSED"));
    for (const record of records.values()) detach(record);
  }

  return Object.freeze({ verify, dispose });
}
