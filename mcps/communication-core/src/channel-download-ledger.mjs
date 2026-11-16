import { promises as fs, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { types } from "node:util";
import { CoreError, digest } from "./contracts.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["pending", "unknown", "downloaded", "failed", "failed_before_send"]);
const SOURCE_FIELDS = ["caller_key", "channel", "window_type", "window_id", "window_key", "source_message_id", "file_type", "file_identity", "scope_fingerprint", "target_key"];

function failure(code, message) {
  return new CoreError(`channel_download_ledger_${code}`, message);
}

function object(value, fields) {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure("invalid", "下载记录必须是普通对象");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key) || (fields && !fields.includes(key))
      || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw failure("invalid", "下载记录含不支持的字段");
  }
  return value;
}

function text(value, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure("invalid", "下载记录字段无效或过长");
  }
  return value;
}

function boundedCopy(value, maximum = 65536) {
  let nodes = 0;
  let bytes = 0;
  const copy = (entry, depth = 0) => {
    if (++nodes > 8192 || depth > 16) throw failure("capacity", "下载记录超出节点范围");
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry);
      if (bytes > maximum) throw failure("capacity", "下载记录超出字节范围");
      return entry;
    }
    if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) return entry;
    if (Array.isArray(entry)) {
      if (types.isProxy(entry) || Object.getPrototypeOf(entry) !== Array.prototype || entry.length > 1024
        || Reflect.ownKeys(entry).length !== entry.length + 1) throw failure("invalid", "下载记录数组无效");
      return Array.from({ length: entry.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw failure("invalid", "下载记录数组含访问器或空项");
        return copy(descriptor.value, depth + 1);
      });
    }
    object(entry);
    const result = {};
    for (const [key, child] of Object.entries(entry)) {
      bytes += Buffer.byteLength(key) + 16;
      if (bytes > maximum) throw failure("capacity", "下载记录超出字节范围");
      result[key] = copy(child, depth + 1);
    }
    return result;
  };
  const result = copy(value);
  if (Buffer.byteLength(JSON.stringify(result)) > maximum) throw failure("capacity", "下载记录超出字节范围");
  return result;
}

function sourceRecord(value) {
  object(value, SOURCE_FIELDS);
  const source = Object.fromEntries(SOURCE_FIELDS.map(field => [field, text(value[field])]));
  if (source.channel !== "qq" || !["private", "group"].includes(source.window_type) || !/^[1-9]\d{0,19}$/.test(source.window_id)
    || !HASH.test(source.scope_fingerprint)) throw failure("invalid", "下载来源身份无效");
  return source;
}

function sourceKey(source) {
  return digest([source.caller_key, source.channel, source.window_type, source.window_id, source.source_message_id, source.file_type, source.file_identity]);
}

function parametersRecord(value) {
  object(value, ["destination_dir", "name"]);
  const destination = text(value.destination_dir);
  if (!isAbsolute(destination) || resolve(destination) !== destination) throw failure("invalid", "下载记录目录必须是规范绝对路径");
  if (value.name !== undefined && (text(value.name, 255) !== basename(value.name) || win32.basename(value.name) !== value.name
    || /[<>:"|?*]/.test(value.name) || /[. ]$/.test(value.name) || [".", ".."].includes(value.name))) throw failure("invalid", "下载记录文件名无效");
  return { destination_dir: destination, ...(value.name === undefined ? {} : { name: value.name }) };
}

function validateRecord(value) {
  object(value, ["version", "content_key", "operation_id", "parent_operation_id", "source", "parameters", "status", "result", "created_at", "updated_at"]);
  if (value.version !== 1 || !UUID.test(value.operation_id) || !HASH.test(value.content_key)
    || (value.parent_operation_id !== null && !UUID.test(value.parent_operation_id)) || !STATUSES.has(value.status)
    || !Number.isSafeInteger(value.created_at) || !Number.isSafeInteger(value.updated_at) || value.updated_at < value.created_at) throw failure("invalid", "下载记录身份或状态无效");
  const source = sourceRecord(value.source);
  if (sourceKey(source) !== value.content_key) throw failure("invalid", "下载记录与原消息身份不匹配");
  parametersRecord(value.parameters);
  if (value.result !== null) {
    object(value.result);
    if (value.result.operation_id !== value.operation_id || value.result.status !== value.status
      || value.result.downloaded !== (value.status === "downloaded")) throw failure("invalid", "下载回执与操作身份不匹配");
  } else if (!["pending", "unknown"].includes(value.status)) throw failure("invalid", "已确认下载状态缺少回执");
  return value;
}

function projected(record) {
  const copied = boundedCopy(record);
  if (copied.status === "pending") {
    copied.status = "unknown";
    if (copied.result) Object.assign(copied.result, { status: "unknown", downloaded: false, outcome_unknown: true, retry_allowed: false });
  }
  return copied;
}

export async function createChannelDownloadLedger({ stateDir, maxOperations = 256, maxRecordBytes = 65536,
  maxTotalBytes = 16 * 1024 * 1024, fileSystem = fs, now = () => Date.now() } = {}) {
  text(stateDir);
  if (!isAbsolute(stateDir) || resolve(stateDir) === parse(resolve(stateDir)).root || typeof now !== "function"
    || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 1024
    || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 65536
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxRecordBytes || maxTotalBytes > 64 * 1024 * 1024) {
    throw failure("invalid", "下载记录配置无效");
  }
  const root = resolve(stateDir);
  const limit = Math.min(maxOperations, Math.floor(maxTotalBytes / maxRecordBytes));
  const records = new Map();
  const heads = new Map();
  const hashes = new Map();
  let directoryIdentity;
  let tail = Promise.resolve();
  let closing = false;
  let closePromise;
  let fatal;

  async function inspectDirectory(create = false) {
    const parts = [];
    for (let current = root; current !== dirname(current); current = dirname(current)) parts.unshift(current);
    for (const current of parts) {
      let stat;
      try { stat = await fileSystem.lstat(current); } catch (error) {
        if (!create || error.code !== "ENOENT") throw error;
        await fileSystem.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
        stat = await fileSystem.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("changed", "下载记录目录含链接或非目录路径");
    }
    const stat = await fileSystem.lstat(root);
    const real = await fileSystem.realpath(root);
    const comparable = path => process.platform === "win32" ? path.toLowerCase() : path;
    if (comparable(real) !== comparable(root)) throw failure("changed", "下载记录目录实际路径已变化");
    const identity = `${stat.dev}:${stat.ino}:${real}`;
    if (directoryIdentity && identity !== directoryIdentity) throw failure("changed", "下载记录目录已被替换");
    directoryIdentity = identity;
  }

  async function inventory() {
    await inspectDirectory();
    const names = [];
    const directory = await fileSystem.opendir(root);
    for await (const entry of directory) {
      if (names.length >= limit || !entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)
        || !UUID.test(entry.name.slice(0, -5))) throw failure("changed", "下载记录目录存在未知文件或超出容量");
      names.push(entry.name);
    }
    return names;
  }

  async function readFile(operationId, expectedHash) {
    const path = join(root, `${operationId}.json`);
    const before = await fileSystem.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxRecordBytes) throw failure("changed", "下载记录文件类型、链接或大小无效");
    const handle = await fileSystem.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw failure("changed", "下载记录在读取时被替换");
      const buffer = Buffer.alloc(maxRecordBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length).toString("utf8");
      const after = await fileSystem.lstat(path);
      if (length > maxRecordBytes || after.size > maxRecordBytes || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
        || (expectedHash && digest(bytes) !== expectedHash)) throw failure("changed", "下载记录内容已变化");
      const envelope = object(JSON.parse(bytes), ["record", "checksum"]);
      if (digest(envelope.record) !== envelope.checksum) throw failure("changed", "下载记录校验失败");
      const record = validateRecord(boundedCopy(envelope.record, maxRecordBytes));
      if (record.operation_id !== operationId) throw failure("changed", "下载记录文件名与操作身份不匹配");
      return { record, hash: digest(bytes) };
    } finally { await handle.close(); }
  }

  async function verify() {
    const names = await inventory();
    if (names.length !== records.size || names.some(name => !records.has(name.slice(0, -5)))) throw failure("changed", "下载记录存在未协调的并发写入");
  }

  async function persist(record, fresh = false) {
    validateRecord(record);
    const encoded = `${JSON.stringify({ record, checksum: digest(record) })}\n`;
    if (Buffer.byteLength(encoded) > maxRecordBytes) throw failure("capacity", "下载记录超出预留字节范围");
    await verify();
    if (!fresh) await readFile(record.operation_id, hashes.get(record.operation_id));
    const target = join(root, `${record.operation_id}.json`);
    const temporary = join(root, `.pending-${record.operation_id}-${randomUUID()}`);
    let handle;
    try {
      handle = await fileSystem.open(temporary, "wx", 0o600);
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await inspectDirectory();
      if (fresh) {
        await fileSystem.link(temporary, target);
        await fileSystem.unlink(temporary);
      } else {
        await readFile(record.operation_id, hashes.get(record.operation_id));
        await fileSystem.rename(temporary, target);
      }
      if (process.platform !== "win32") {
        const directory = await fileSystem.open(root, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await readFile(record.operation_id, digest(encoded));
      hashes.set(record.operation_id, digest(encoded));
      records.set(record.operation_id, boundedCopy(record));
    } catch (error) {
      fatal = error instanceof CoreError ? error : failure("io", "下载记录持久写失败，请核对原操作");
      throw fatal;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fileSystem.unlink(temporary).catch(() => {});
    }
  }

  function run(action, allowClosing = false) {
    if (closing && !allowClosing) return Promise.reject(failure("closed", "下载记录已关闭"));
    const current = tail.then(async () => {
      if (fatal) throw fatal;
      try { return await action(); } catch (error) {
        if (!(error instanceof CoreError)) fatal = failure("io", "下载记录读取或写入失败");
        else if (error.code === "channel_download_ledger_changed") fatal = error;
        throw fatal ?? error;
      }
    });
    tail = current.catch(() => {});
    return current;
  }

  await inspectDirectory(true);
  for (const name of await inventory()) {
    const operationId = name.slice(0, -5);
    const loaded = await readFile(operationId);
    records.set(operationId, loaded.record);
    hashes.set(operationId, loaded.hash);
  }
  const children = new Map();
  for (const record of records.values()) {
    if (record.parent_operation_id) {
      const parent = records.get(record.parent_operation_id);
      if (!parent || parent.content_key !== record.content_key || digest(parent.source) !== digest(record.source)
        || !["failed", "failed_before_send"].includes(parent.status) || parent.result?.cleanup_pending === true || parent.result?.cleanupPending === true
        || children.has(parent.operation_id)) throw failure("changed", "下载重试记录存在无效父项或分叉");
      children.set(parent.operation_id, record.operation_id);
    }
  }
  const reachable = new Set();
  for (const record of records.values()) {
    if (record.parent_operation_id !== null) continue;
    if (heads.has(record.content_key)) throw failure("changed", "同一附件存在多个下载起点");
    let current = record;
    const visited = new Set();
    while (current) {
      if (visited.has(current.operation_id)) throw failure("changed", "下载重试记录形成循环");
      visited.add(current.operation_id);
      reachable.add(current.operation_id);
      heads.set(current.content_key, current.operation_id);
      current = records.get(children.get(current.operation_id));
    }
  }
  if (reachable.size !== records.size) throw failure("changed", "下载记录缺少有效起点或存在未连接记录");

  return {
    async read(contentKey, operationId) {
      return run(async () => {
        if (!HASH.test(contentKey)) throw failure("invalid", "下载内容标识无效");
        await verify();
        const record = records.get(operationId ?? heads.get(contentKey));
        if (!record) return null;
        if (record.content_key !== contentKey) throw failure("scope", "下载操作属于其它附件");
        await readFile(record.operation_id, hashes.get(record.operation_id));
        return projected(record);
      });
    },
    async begin({ contentKey, source, parameters, retryFailed = false, expectedOperationId } = {}) {
      return run(async () => {
        const origin = sourceRecord(source);
        const requested = parametersRecord(parameters);
        if (!HASH.test(contentKey) || sourceKey(origin) !== contentKey || typeof retryFailed !== "boolean"
          || (retryFailed ? !UUID.test(expectedOperationId) : expectedOperationId !== undefined)) throw failure("invalid", "下载重试身份或来源无效");
        await verify();
        let current = records.get(heads.get(contentKey));
        if (current) {
          await readFile(current.operation_id, hashes.get(current.operation_id));
          if (digest(current.source) !== digest(origin)) throw failure("scope", "下载原来源已变化，保留原操作核对");
          if (!retryFailed) return { created: false, operation: projected(current) };
          const parent = records.get(expectedOperationId);
          if (!parent || parent.content_key !== contentKey) throw failure("operation_changed", "原失败下载操作已变化");
          await readFile(parent.operation_id, hashes.get(parent.operation_id));
          const childId = children.get(parent.operation_id);
          if (childId) {
            const child = records.get(childId);
            if (digest(child.parameters) !== digest(requested)) throw failure("operation_changed", "该重试已产生后继操作，参数不能更换");
            await readFile(child.operation_id, hashes.get(child.operation_id));
            return { created: false, operation: projected(child) };
          }
          if (current.operation_id !== expectedOperationId || !["failed", "failed_before_send"].includes(current.status)
            || current.result?.cleanup_pending === true || current.result?.cleanupPending === true) {
            throw failure("retry_forbidden", "该操作尚未明确失败或清理未完成，禁止重新下载");
          }
        } else if (retryFailed) throw failure("operation_changed", "未找到原失败下载操作");
        if (records.size >= limit) throw failure("capacity", "下载记录已达到预留容量，保留原操作记录");
        const timestamp = Math.max(now(), current?.updated_at ?? 0);
        const record = { version: 1, content_key: contentKey, operation_id: randomUUID(), parent_operation_id: current?.operation_id ?? null,
          source: origin, parameters: requested, status: "pending", result: null, created_at: timestamp, updated_at: timestamp };
        await persist(record, true);
        if (current) children.set(current.operation_id, record.operation_id);
        heads.set(contentKey, record.operation_id);
        return { created: true, operation: boundedCopy(record) };
      });
    },
    async update(operationId, { status, result = null } = {}) {
      return run(async () => {
        const previous = records.get(operationId);
        if (!previous || !STATUSES.has(status) || status === "pending") throw failure("operation_changed", "下载完成回执的操作身份无效");
        if (["downloaded", "failed", "failed_before_send"].includes(previous.status)) return projected(previous);
        const record = { ...previous, status, result: result === null ? null : boundedCopy(result, 32768), updated_at: Math.max(previous.updated_at, now()) };
        await persist(record);
        return projected(record);
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = run(async () => {
        for (const previous of [...records.values()]) {
          if (previous.status !== "pending") continue;
          await persist({ ...previous, status: "unknown", result: null, updated_at: Math.max(previous.updated_at, now()) });
        }
        return { closed: true, pending_downloads: [...records.values()].filter(record => record.status === "unknown").map(projected) };
      }, true);
      return closePromise;
    },
  };
}
