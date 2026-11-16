import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { CoreError } from "./contracts.mjs";

function locked() {
  return new CoreError("runtime_locked", "原运行实例、端点或独占记录仍需核查，保留现有状态");
}

async function canonicalPath(value) {
  const absolute = resolve(value);
  try { return await realpath(absolute); } catch (error) {
    if (error.code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}

const pathKey = value => process.platform === "win32" ? value.toLowerCase() : value;

async function identityFor({ configPath, stateDir, endpointFile }) {
  return {
    config_path: await canonicalPath(configPath),
    state_dir: await canonicalPath(stateDir),
    ...(endpointFile ? { endpoint_file: await canonicalPath(endpointFile) } : {}),
  };
}

async function readRecord(filePath) {
  try {
    const information = await lstat(filePath);
    if (!information.isFile() || information.size > 65536) throw locked();
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text) > 65536) throw locked();
    return { text, record: JSON.parse(text) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw locked();
  }
}

async function matchesIdentity(record, identity) {
  if (!record || typeof record !== "object") return false;
  for (const [field, value] of Object.entries(identity)) {
    if (typeof record[field] !== "string" || pathKey(await canonicalPath(record[field])) !== pathKey(value)) return false;
  }
  return true;
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw locked();
  }
}

export function processStatus(pid) {
  try { process.kill(pid, 0); return "present"; } catch (error) {
    return error.code === "ESRCH" ? "absent" : "unknown";
  }
}

export function loopbackPortStatus(port, host) {
  return new Promise(resolveStatus => {
    let result = "unknown";
    const socket = createConnection({ host, port, timeout: 750 });
    socket.once("connect", () => { result = "listening"; socket.destroy(); });
    socket.once("timeout", () => socket.destroy());
    socket.once("error", error => { result = error.code === "ECONNREFUSED" ? "closed" : "unknown"; });
    socket.once("close", () => resolveStatus(result));
  });
}

function endpointPort(record) {
  let endpoint;
  try { endpoint = new URL(record.url); } catch { throw locked(); }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== "/mcp" || endpoint.search || endpoint.hash) throw locked();
  const port = Number(endpoint.port || 80);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw locked();
  return port;
}

async function verifyTerminated(record, identity, probes) {
  if (!await matchesIdentity(record, identity) || !Number.isSafeInteger(record.pid) || record.pid < 1) throw locked();
  const inspectProcess = probes.processStatus ?? processStatus;
  const inspectPort = probes.loopbackPortStatus ?? loopbackPortStatus;
  if (await inspectProcess(record.pid) !== "absent") throw locked();
  if (record.url === undefined && (record.state === "starting" || (record.state === "closed" && typeof record.closed_at === "string" && Number.isFinite(Date.parse(record.closed_at))))) {
    if (await inspectProcess(record.pid) !== "absent") throw locked();
    return;
  }
  const port = endpointPort(record);
  const states = await Promise.all(["127.0.0.1", "::1"].map(host => inspectPort(port, host)));
  if (states.some(state => state !== "closed") || await inspectProcess(record.pid) !== "absent") throw locked();
}

async function claimFile(filePath, identity, { recoverTerminated = false, probes = {}, retainClosed = false } = {}) {
  const recoveryPath = `${filePath}.recovering`;
  const owner = { version: 1, state: "starting", owner_id: randomUUID(), pid: process.pid, ...identity, started_at: new Date().toISOString() };
  const serialized = () => JSON.stringify(owner);
  let released = false;
  const checkOwner = async () => {
    const current = await readRecord(filePath);
    if (!current?.record || current.record.owner_id !== owner.owner_id || current.record.pid !== owner.pid || !await matchesIdentity(current.record, identity)) throw locked();
  };
  const release = async () => {
    if (released) return;
    await checkOwner();
    if (retainClosed) await writeFile(filePath, JSON.stringify({ ...owner, state: "closed", closed_at: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
    else await unlink(filePath);
    released = true;
  };
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (await exists(recoveryPath)) throw locked();
  try {
    await writeFile(filePath, serialized(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (await exists(recoveryPath)) { await release(); throw locked(); }
  } catch (error) {
    if (error.code !== "EEXIST") throw locked();
    const candidate = await readRecord(filePath);
    if (!recoverTerminated && !(retainClosed && candidate?.record?.state === "closed")) throw locked();
    try { await mkdir(recoveryPath, { mode: 0o700 }); } catch { throw locked(); }
    const markerPath = join(recoveryPath, "owner.json");
    try {
      await writeFile(markerPath, serialized(), { encoding: "utf8", mode: 0o600, flag: "wx" });
      const previous = await readRecord(filePath);
      const clean = retainClosed && previous?.record?.state === "closed";
      const expectedIdentity = clean ? { config_path: identity.config_path, state_dir: identity.state_dir } : identity;
      if (!previous?.record || previous.record.version !== 1 || typeof previous.record.owner_id !== "string" || !previous.record.owner_id || !await matchesIdentity(previous.record, expectedIdentity)) throw locked();
      if (!clean) {
        if (!recoverTerminated || (previous.record.endpoint_file && !identity.endpoint_file)) throw locked();
        await verifyTerminated(previous.record, identity, probes);
      }
      if ((await readRecord(filePath))?.text !== previous.text) throw locked();
      if (!clean) await rename(filePath, `${filePath}.terminated-${owner.owner_id}.json`);
      await writeFile(filePath, serialized(), { encoding: "utf8", mode: 0o600, flag: clean ? "w" : "wx" });
    } finally {
      const marker = await readRecord(markerPath);
      if (marker?.record?.owner_id === owner.owner_id) {
        await unlink(markerPath);
        await rmdir(recoveryPath);
      }
    }
  }
  return {
    owner,
    async setUrl(url) {
      await checkOwner();
      owner.url = url;
      owner.state = "listening";
      await writeFile(filePath, serialized(), { encoding: "utf8", mode: 0o600 });
    },
    release,
  };
}

export async function acquireRuntimeLease(options) {
  const identity = await identityFor(options);
  const filePath = `${identity.state_dir}.runtime-lock`;
  if (await exists(join(identity.state_dir, "core.sqlite")) && !await exists(filePath)) throw locked();
  return claimFile(filePath, identity, { ...options, retainClosed: true });
}

export async function registerLegacyRuntime(options) {
  const identity = await identityFor(options);
  if (!identity.endpoint_file || !await exists(join(identity.state_dir, "core.sqlite"))) throw locked();
  const previous = await readRecord(identity.endpoint_file);
  const pointerIdentity = { config_path: identity.config_path, state_dir: identity.state_dir };
  const closed = previous?.record?.state === "closed" && options.adoptClosed === true;
  if (!previous?.record || (!closed && previous.record.state !== "listening") || !await matchesIdentity(previous.record, pointerIdentity) || !Number.isSafeInteger(previous.record.pid) || previous.record.pid < 1) throw locked();
  if (closed) await verifyTerminated(previous.record, pointerIdentity, options.probes ?? {});
  else {
    endpointPort(previous.record);
    if (await (options.probes?.processStatus ?? processStatus)(previous.record.pid) !== "present") throw locked();
  }
  const filePath = `${identity.state_dir}.runtime-lock`;
  if (await exists(`${filePath}.recovering`)) throw locked();
  const owner = { version: 1, state: closed ? "closed" : "listening", owner_id: randomUUID(), ...identity, pid: previous.record.pid, ...(previous.record.url === undefined ? {} : { url: previous.record.url }), started_at: previous.record.started_at, ...(closed ? { closed_at: previous.record.closed_at } : {}), registered_at: new Date().toISOString() };
  try { await writeFile(filePath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx" }); } catch { throw locked(); }
  const evidencePath = `${identity.endpoint_file}.legacy-${owner.owner_id}.json`;
  await writeFile(evidencePath, previous.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { lockPath: filePath, evidencePath, pid: owner.pid, owner_id: owner.owner_id };
}

export async function prepareServiceEndpoint(options) {
  const identity = await identityFor(options);
  const endpointPath = identity.endpoint_file;
  if (!endpointPath || pathKey(endpointPath) === pathKey(identity.config_path) || pathKey(endpointPath) === pathKey(identity.state_dir) || pathKey(endpointPath) === pathKey(join(identity.state_dir, "core.sqlite"))) throw locked();
  const pointerIdentity = { config_path: identity.config_path, state_dir: identity.state_dir };
  const validate = async previous => {
    if (!previous) return;
    if (!await matchesIdentity(previous.record, pointerIdentity)) throw locked();
    if (previous.record.state === "closed") return;
    if (previous.record.state !== "listening" || !options.recoverTerminated) throw locked();
    await verifyTerminated(previous.record, pointerIdentity, options.probes ?? {});
  };
  await validate(await readRecord(endpointPath));
  const lease = await claimFile(`${endpointPath}.runtime-lock`, identity, options);
  let previous;
  let published = false;
  try {
    previous = await readRecord(endpointPath);
    await validate(previous);
    if (previous?.record.state === "listening") {
      await copyFile(endpointPath, `${endpointPath}.terminated-${lease.owner.owner_id}.json`, constants.COPYFILE_EXCL);
      if ((await readRecord(endpointPath))?.text !== previous.text) throw locked();
    }
  } catch (error) { await lease.release(); throw error; }
  return {
    async publish(url) {
      if ((await readRecord(endpointPath))?.text !== previous?.text) throw locked();
      await lease.setUrl(url);
      await writeFile(endpointPath, JSON.stringify({ ...lease.owner, state: "listening", url }), { encoding: "utf8", mode: 0o600, flag: previous ? "w" : "wx" });
      published = true;
    },
    async close() {
      if (published) {
        const current = await readRecord(endpointPath);
        if (current?.record?.owner_id !== lease.owner.owner_id || current.record.pid !== process.pid) throw locked();
        await writeFile(endpointPath, JSON.stringify({ ...lease.owner, state: "closed", closed_at: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
      }
      await lease.release();
    },
  };
}
