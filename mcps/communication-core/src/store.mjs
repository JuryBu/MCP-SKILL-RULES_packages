import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, types } from "node:util";
import { assertExactKeys, CoreError, identityKey, requireInteger, requireText } from "./contracts.mjs";

const MAX_PAGE_SIZE = 1000;
const MAX_DIRECTORY_PAGE_SIZE = 100;
const MAX_DIRECTORY_RECORD_BYTES = 65536;
const MAX_BINDING_ID_BYTES = 128;
const MAX_DIRECTORY_KEY_BYTES = 4096;
const UNSAFE_DIRECTORY_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MESSAGE_PATCH_FIELDS = [
  "delivery_status", "processing", "processing_note", "model_observed", "ui_observed",
  "error", "last_error", "evidence", "updated_at",
];
const DELIVERY_PATCH_FIELDS = [
  "status", "attempt_count", "updated_at", "error", "last_error", "evidence",
];

function encodeJson(value, name) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("JSON value required");
    return encoded;
  } catch {
    throw new CoreError("invalid_input", `${name}必须可以序列化为JSON`);
  }
}

function copyRecord(record, name) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new CoreError("invalid_input", `${name}必须是对象`);
  }
  const copied = JSON.parse(encodeJson(record, name));
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) {
    throw new CoreError("invalid_input", `${name}必须是JSON对象`);
  }
  return copied;
}

function decodeRecord(row) {
  return row ? JSON.parse(row.record_json) : null;
}

function encodeDirectoryRecord(record, name) {
  const encoded = encodeJson(record, name);
  if (Buffer.byteLength(encoded, "utf8") > MAX_DIRECTORY_RECORD_BYTES) {
    throw new CoreError("invalid_input", `${name}不能超过65536字节`);
  }
  return encoded;
}

function copyDirectoryRecord(record, name) {
  if (!record || typeof record !== "object" || types.isProxy(record) || Array.isArray(record)) {
    throw new CoreError("invalid_input", `${name}必须是JSON对象`);
  }
  const ancestors = new Set();
  let remainingValues = MAX_DIRECTORY_RECORD_BYTES;
  const copyValue = (value, depth) => {
    remainingValues -= 1;
    if (remainingValues < 0 || depth > 64) throw new CoreError("invalid_input", `${name}结构超出范围`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) {
      throw new CoreError("invalid_input", `${name}包含不安全的JSON值`);
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new CoreError("invalid_input", `${name}只能包含普通JSON对象和数组`);
    }
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array && (value.length > MAX_DIRECTORY_RECORD_BYTES || keys.length !== value.length + 1)) {
      throw new CoreError("invalid_input", `${name}包含不支持的数组结构`);
    }
    const copied = array ? [] : Object.create(null);
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (typeof key !== "string" || UNSAFE_DIRECTORY_KEYS.has(key)
        || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
        throw new CoreError("invalid_input", `${name}包含不安全的JSON属性`);
      }
      copied[key] = copyValue(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return copied;
  };
  return JSON.parse(encodeDirectoryRecord(copyValue(record, 0), name));
}

function directoryOptions(options, allowed, name) {
  if (types.isProxy(options) || !options || typeof options !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new CoreError("invalid_input", `${name}必须是普通JSON对象`);
  }
  assertExactKeys(options, allowed, name);
  const copied = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new CoreError("invalid_input", `${name}包含不安全的选项`);
    }
    if (descriptor.value !== undefined) copied[key] = descriptor.value;
  }
  return copyDirectoryRecord(copied, name);
}

function requireDirectoryText(value, name, maximum = MAX_DIRECTORY_KEY_BYTES) {
  requireText(value, name, maximum);
  if (value.includes("\0")) throw new CoreError("invalid_input", `${name}不能包含空字符`);
  return value;
}

function assertBindingGeneration(expected, actual) {
  if (expected !== actual) {
    throw new CoreError("binding_changed", "绑定代次已变化", {
      expected_generation: expected,
      actual_generation: actual,
    });
  }
}

function decodeBinding(row) {
  return row ? { ...decodeRecord(row), binding_generation: row.binding_generation } : null;
}

function decodeChannelBinding(row) {
  return row ? {
    ...decodeRecord(row),
    generation: row.generation,
    owner_key: row.owner_key,
    window_key: row.window_key,
    deleted: row.deleted === 1,
  } : null;
}

function validateMessage(record) {
  for (const field of [
    "message_id", "source_key", "target_key", "dedupe_key", "payload_hash",
    "created_at", "delivery_status",
  ]) {
    requireText(record[field], field);
  }
  if (!record.envelope || typeof record.envelope !== "object" || Array.isArray(record.envelope)) {
    throw new CoreError("invalid_input", "envelope必须是JSON对象");
  }
}

function validateDelivery(record) {
  for (const field of ["delivery_id", "message_id", "target_key", "status", "created_at", "updated_at"]) {
    requireText(record[field], field);
  }
  requireInteger(record.attempt_count, "attempt_count");
}

export class MessageStore {
  #database;
  #transactionDepth = 0;

  constructor({ filePath } = {}) {
    requireText(filePath, "filePath", 32768);
    if (filePath === ":memory:") {
      throw new CoreError("invalid_input", "filePath必须指向持久化数据库文件");
    }
    const databasePath = resolve(filePath);
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      defensive: true,
      timeout: 1000,
    });
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      const journal = this.#database.prepare("PRAGMA journal_mode = WAL").get();
      if (journal.journal_mode !== "wal") {
        throw new CoreError("store_configuration_error", "数据库未能启用WAL");
      }
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY NOT NULL,
          source_key TEXT NOT NULL,
          target_key TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK (json_valid(record_json)),
          UNIQUE (source_key, dedupe_key)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS messages_target ON messages (target_key);
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY NOT NULL,
          message_id TEXT NOT NULL UNIQUE REFERENCES messages (message_id),
          target_key TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK (json_valid(record_json))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS deliveries_status_id ON deliveries (status, delivery_id);
        CREATE INDEX IF NOT EXISTS deliveries_target ON deliveries (target_key);
        CREATE TABLE IF NOT EXISTS message_events (
          message_id TEXT NOT NULL REFERENCES messages (message_id),
          sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
          kind TEXT NOT NULL,
          data_json TEXT NOT NULL CHECK (json_valid(data_json)),
          created_at TEXT NOT NULL,
          PRIMARY KEY (message_id, sequence)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS conversation_bindings (
          binding_id TEXT PRIMARY KEY NOT NULL
            CHECK (length(CAST(binding_id AS BLOB)) BETWEEN 1 AND ${MAX_BINDING_ID_BYTES}),
          identity_key TEXT NOT NULL UNIQUE
            CHECK (length(CAST(identity_key AS BLOB)) BETWEEN 1 AND ${MAX_DIRECTORY_KEY_BYTES}),
          binding_generation INTEGER NOT NULL CHECK (binding_generation BETWEEN 1 AND 9007199254740991),
          record_json TEXT NOT NULL CHECK (
            length(CAST(record_json AS BLOB)) <= ${MAX_DIRECTORY_RECORD_BYTES}
            AND json_valid(record_json) AND json_type(record_json) IS 'object'
            AND json_type(record_json, '$.binding_id') IS 'text'
            AND json_extract(record_json, '$.binding_id') IS binding_id
            AND json_type(record_json, '$.binding_generation') IS 'integer'
            AND json_extract(record_json, '$.binding_generation') IS binding_generation
          )
        ) STRICT;
        CREATE TABLE IF NOT EXISTS channel_bindings (
          window_key TEXT PRIMARY KEY NOT NULL
            CHECK (length(CAST(window_key AS BLOB)) BETWEEN 1 AND ${MAX_DIRECTORY_KEY_BYTES}),
          owner_key TEXT NOT NULL
            CHECK (length(CAST(owner_key AS BLOB)) BETWEEN 1 AND ${MAX_DIRECTORY_KEY_BYTES}),
          generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
          deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
          record_json TEXT NOT NULL CHECK (
            length(CAST(record_json AS BLOB)) <= ${MAX_DIRECTORY_RECORD_BYTES}
            AND json_valid(record_json) AND json_type(record_json) IS 'object'
            AND json_type(record_json, '$.window_key') IS 'text'
            AND json_extract(record_json, '$.window_key') IS window_key
            AND json_type(record_json, '$.owner_key') IS 'text'
            AND json_extract(record_json, '$.owner_key') IS owner_key
            AND json_type(record_json, '$.generation') IS 'integer'
            AND json_extract(record_json, '$.generation') IS generation
            AND json_type(record_json, '$.deleted') IS CASE deleted WHEN 1 THEN 'true' ELSE 'false' END
          )
        ) STRICT;
        CREATE INDEX IF NOT EXISTS channel_bindings_owner_window ON channel_bindings (owner_key, window_key);
        CREATE TABLE IF NOT EXISTS channel_ingress_state (
          window_key TEXT PRIMARY KEY NOT NULL
            CHECK (length(CAST(window_key AS BLOB)) BETWEEN 1 AND ${MAX_DIRECTORY_KEY_BYTES}),
          record_json TEXT NOT NULL CHECK (
            length(CAST(record_json AS BLOB)) <= ${MAX_DIRECTORY_RECORD_BYTES}
            AND json_valid(record_json) AND json_type(record_json) IS 'object'
            AND json_type(record_json, '$.window_key') IS 'text'
            AND json_extract(record_json, '$.window_key') IS window_key
          )
        ) STRICT;
        COMMIT;
      `);
    } catch (error) {
      try {
        if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      } finally {
        this.#database.close();
      }
      throw error;
    }
  }

  #assertOpen() {
    if (!this.#database.isOpen) throw new CoreError("store_closed", "存储已关闭");
  }

  transaction(callback) {
    this.#assertOpen();
    if (typeof callback !== "function" || types.isAsyncFunction(callback)) {
      throw new CoreError("invalid_input", "transaction需要同步回调");
    }
    const outermost = this.#transactionDepth === 0;
    const savepoint = `store_transaction_${this.#transactionDepth}`;
    this.#database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = callback(this);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw new CoreError("invalid_input", "transaction回调不能返回Promise或thenable");
      }
      this.#database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (this.#database.isTransaction) {
          this.#database.exec(outermost
            ? "ROLLBACK"
            : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "事务执行与回滚均失败", { cause: error });
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  getBinding(bindingId) {
    this.#assertOpen();
    requireDirectoryText(bindingId, "binding_id", MAX_BINDING_ID_BYTES);
    return decodeBinding(this.#database.prepare(`
      SELECT record_json, binding_generation FROM conversation_bindings WHERE binding_id = ?
    `).get(bindingId));
  }

  findBindingByIdentity(key) {
    this.#assertOpen();
    requireDirectoryText(key, "identity_key");
    return decodeBinding(this.#database.prepare(`
      SELECT record_json, binding_generation FROM conversation_bindings WHERE identity_key = ?
    `).get(key));
  }

  putBinding(target, options = {}) {
    this.#assertOpen();
    const { expectedGeneration = 0 } = directoryOptions(options, ["expectedGeneration"], "绑定写入选项");
    requireInteger(expectedGeneration, "expectedGeneration");
    const binding = copyDirectoryRecord(target, "对话绑定");
    requireDirectoryText(binding.binding_id, "binding_id", MAX_BINDING_ID_BYTES);
    for (const [field, maximum] of [["machine_id", 128], ["host", 64], ["surface", 64], ["conversation_id", 256]]) {
      requireDirectoryText(binding[field], field, maximum);
    }
    requireInteger(binding.binding_generation, "binding_generation", 1);
    const key = requireDirectoryText(identityKey(binding), "identity_key");
    if (binding.identity_key !== undefined && binding.identity_key !== key) {
      throw new CoreError("invalid_input", "identity_key与对话身份不一致");
    }
    return this.transaction(() => {
      const current = this.getBinding(binding.binding_id);
      assertBindingGeneration(expectedGeneration, current?.binding_generation ?? 0);
      const existing = this.findBindingByIdentity(key);
      if (existing && existing.binding_id !== binding.binding_id) {
        throw new CoreError("binding_conflict", "该对话身份已有其它绑定");
      }
      if (current && isDeepStrictEqual(current, { ...binding, binding_generation: current.binding_generation })) {
        return current;
      }
      const generation = requireInteger((current?.binding_generation ?? 0) + 1, "binding_generation", 1);
      const updated = { ...binding, binding_generation: generation };
      this.#database.prepare(`
        INSERT INTO conversation_bindings (binding_id, identity_key, binding_generation, record_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (binding_id) DO UPDATE SET identity_key = excluded.identity_key,
          binding_generation = excluded.binding_generation, record_json = excluded.record_json
      `).run(updated.binding_id, key, generation, encodeDirectoryRecord(updated, "对话绑定"));
      return updated;
    });
  }

  listBindings(options = {}) {
    this.#assertOpen();
    const { limit = MAX_DIRECTORY_PAGE_SIZE, afterId } = directoryOptions(options, ["limit", "afterId"], "绑定分页选项");
    requireInteger(limit, "limit", 1, MAX_DIRECTORY_PAGE_SIZE);
    if (afterId !== undefined) requireDirectoryText(afterId, "afterId", MAX_BINDING_ID_BYTES);
    return this.#database.prepare(`
      SELECT record_json, binding_generation FROM conversation_bindings
      WHERE binding_id > ? ORDER BY binding_id ASC LIMIT ?
    `).all(afterId ?? "", limit).map(decodeBinding);
  }

  getChannelBinding(windowKey) {
    this.#assertOpen();
    requireDirectoryText(windowKey, "window_key");
    return decodeChannelBinding(this.#database.prepare(`
      SELECT record_json, generation, owner_key, window_key, deleted FROM channel_bindings WHERE window_key = ?
    `).get(windowKey));
  }

  putChannelBinding(record, options = {}) {
    this.#assertOpen();
    const { ownerKey, expectedGeneration, claimReleased = false } = directoryOptions(options, ["ownerKey", "expectedGeneration", "claimReleased"], "窗口绑定写入选项");
    requireDirectoryText(ownerKey, "ownerKey");
    requireInteger(expectedGeneration, "expectedGeneration");
    if (typeof claimReleased !== "boolean") throw new CoreError("invalid_input", "claimReleased必须是布尔值");
    const binding = copyDirectoryRecord(record, "窗口绑定");
    requireDirectoryText(binding.window_key, "window_key");
    if (binding.owner_key !== undefined && binding.owner_key !== ownerKey) {
      throw new CoreError("invalid_input", "owner_key与写入归属不一致");
    }
    if (binding.generation !== undefined) requireInteger(binding.generation, "generation", 1);
    if (binding.deleted !== undefined && typeof binding.deleted !== "boolean") {
      throw new CoreError("invalid_input", "deleted必须是布尔值");
    }
    return this.transaction(() => {
      const current = this.getChannelBinding(binding.window_key);
      if (current && current.owner_key !== ownerKey && !(claimReleased && current.deleted)) {
        throw new CoreError("channel_binding_conflict", "该聊天窗口属于其它对话");
      }
      if (current && claimReleased && !current.deleted) throw new CoreError("channel_binding_conflict", "该聊天窗口尚未释放");
      assertBindingGeneration(expectedGeneration, current?.generation ?? 0);
      const generation = requireInteger((current?.generation ?? 0) + 1, "generation", 1);
      const updated = { ...binding, generation, owner_key: ownerKey, window_key: binding.window_key, deleted: false };
      this.#database.prepare(`
        INSERT INTO channel_bindings (window_key, owner_key, generation, deleted, record_json)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT (window_key) DO UPDATE SET owner_key = excluded.owner_key, generation = excluded.generation,
          deleted = excluded.deleted, record_json = excluded.record_json
      `).run(binding.window_key, ownerKey, generation, encodeDirectoryRecord(updated, "窗口绑定"));
      return updated;
    });
  }

  deleteChannelBinding(windowKey, options = {}) {
    this.#assertOpen();
    requireDirectoryText(windowKey, "window_key");
    const { ownerKey, expectedGeneration } = directoryOptions(options, ["ownerKey", "expectedGeneration"], "窗口绑定删除选项");
    requireDirectoryText(ownerKey, "ownerKey");
    requireInteger(expectedGeneration, "expectedGeneration");
    return this.transaction(() => {
      const current = this.getChannelBinding(windowKey);
      if (current && current.owner_key !== ownerKey) {
        throw new CoreError("channel_binding_conflict", "该聊天窗口属于其它对话");
      }
      assertBindingGeneration(expectedGeneration, current?.generation ?? 0);
      if (!current || current.deleted) return current;
      const generation = requireInteger(current.generation + 1, "generation", 1);
      const updated = { ...current, generation, deleted: true };
      this.#database.prepare(`
        UPDATE channel_bindings SET generation = ?, deleted = 1, record_json = ? WHERE window_key = ?
      `).run(generation, encodeDirectoryRecord(updated, "窗口绑定"), windowKey);
      return updated;
    });
  }

  listChannelBindings(options = {}) {
    this.#assertOpen();
    const { ownerKey, limit = MAX_DIRECTORY_PAGE_SIZE, afterKey } = directoryOptions(options,
      ["ownerKey", "limit", "afterKey"], "窗口绑定分页选项");
    requireDirectoryText(ownerKey, "ownerKey");
    requireInteger(limit, "limit", 1, MAX_DIRECTORY_PAGE_SIZE);
    if (afterKey !== undefined) requireDirectoryText(afterKey, "afterKey");
    return this.#database.prepare(`
      SELECT record_json, generation, owner_key, window_key, deleted FROM channel_bindings
      WHERE owner_key = ? AND window_key > ? ORDER BY window_key ASC LIMIT ?
    `).all(ownerKey, afterKey ?? "", limit).map(decodeChannelBinding);
  }

  getChannelIngressState(windowKey) {
    this.#assertOpen();
    requireDirectoryText(windowKey, "window_key");
    return decodeRecord(this.#database.prepare("SELECT record_json FROM channel_ingress_state WHERE window_key = ?").get(windowKey));
  }

  putChannelIngressState(windowKey, record) {
    this.#assertOpen();
    requireDirectoryText(windowKey, "window_key");
    const state = copyDirectoryRecord(record, "窗口入站进度");
    if (state.window_key !== undefined && state.window_key !== windowKey) {
      throw new CoreError("invalid_input", "入站进度与窗口范围不一致");
    }
    const updated = { ...state, window_key: windowKey };
    const encoded = encodeDirectoryRecord(updated, "窗口入站进度");
    return this.transaction(() => {
      this.#database.prepare(`
        INSERT INTO channel_ingress_state (window_key, record_json) VALUES (?, ?)
        ON CONFLICT (window_key) DO UPDATE SET record_json = excluded.record_json
      `).run(windowKey, encoded);
      return JSON.parse(encoded);
    });
  }

  getMessage(messageId) {
    this.#assertOpen();
    return decodeRecord(this.#database.prepare("SELECT record_json FROM messages WHERE message_id = ?").get(messageId));
  }

  findMessageByDedupe(sourceKey, dedupeKey) {
    this.#assertOpen();
    return decodeRecord(this.#database.prepare("SELECT record_json FROM messages WHERE source_key = ? AND dedupe_key = ?")
      .get(sourceKey, dedupeKey));
  }

  insertMessage(record) {
    this.#assertOpen();
    const message = {
      processing: "pending",
      model_observed: "unknown",
      ui_observed: "unknown",
      ...copyRecord(record, "消息记录"),
    };
    validateMessage(message);
    this.#database.prepare(`
      INSERT INTO messages (message_id, source_key, target_key, dedupe_key, payload_hash, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.message_id, message.source_key, message.target_key, message.dedupe_key,
      message.payload_hash, encodeJson(message, "消息记录"));
    return message;
  }

  updateMessage(messageId, patch) {
    this.#assertOpen();
    assertExactKeys(patch, MESSAGE_PATCH_FIELDS, "消息更新");
    const changes = copyRecord(patch, "消息更新");
    assertExactKeys(changes, MESSAGE_PATCH_FIELDS, "消息更新");
    return this.transaction(() => {
      const current = this.getMessage(messageId);
      if (!current) return null;
      const updated = { ...current, ...changes };
      validateMessage(updated);
      this.#database.prepare("UPDATE messages SET record_json = ? WHERE message_id = ?")
        .run(encodeJson(updated, "消息记录"), messageId);
      return updated;
    });
  }

  getDelivery(deliveryId) {
    this.#assertOpen();
    return decodeRecord(this.#database.prepare("SELECT record_json FROM deliveries WHERE delivery_id = ?").get(deliveryId));
  }

  getDeliveryForMessage(messageId) {
    this.#assertOpen();
    return decodeRecord(this.#database.prepare("SELECT record_json FROM deliveries WHERE message_id = ?").get(messageId));
  }

  latestDeliveryIssueForTarget(targetKey) {
    this.#assertOpen();
    requireText(targetKey, "target_key", MAX_DIRECTORY_KEY_BYTES);
    const row = this.#database.prepare(`
      SELECT record_json FROM deliveries WHERE target_key = ? ORDER BY rowid DESC LIMIT 1
    `).get(targetKey);
    const delivery = decodeRecord(row);
    if (!delivery) return null;
    if (delivery.status === "prepared" && delivery.evidence?.outcome === "busy") return null;
    const error = delivery.error ?? null;
    const isIssueStatus = delivery.status === "failed"
      || delivery.status === "failed_before_send"
      || delivery.status === "expired"
      || delivery.status === "unknown"
      || delivery.status === "unsupported";
    if (error === null && !isIssueStatus) return null;
    return {
      delivery_id: delivery.delivery_id,
      message_id: delivery.message_id,
      status: delivery.status,
      updated_at: delivery.updated_at,
      ...(error !== null ? { error } : {}),
    };
  }

  insertDelivery(record) {
    this.#assertOpen();
    const delivery = { attempt_count: 0, ...copyRecord(record, "投递记录") };
    validateDelivery(delivery);
    this.#database.prepare(`
      INSERT INTO deliveries (delivery_id, message_id, target_key, status, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(delivery.delivery_id, delivery.message_id, delivery.target_key, delivery.status,
      delivery.created_at, encodeJson(delivery, "投递记录"));
    return delivery;
  }

  updateDelivery(deliveryId, patch) {
    this.#assertOpen();
    assertExactKeys(patch, DELIVERY_PATCH_FIELDS, "投递更新");
    const changes = copyRecord(patch, "投递更新");
    assertExactKeys(changes, DELIVERY_PATCH_FIELDS, "投递更新");
    return this.transaction(() => {
      const current = this.getDelivery(deliveryId);
      if (!current) return null;
      const updated = { ...current, ...changes };
      validateDelivery(updated);
      this.#database.prepare("UPDATE deliveries SET status = ?, record_json = ? WHERE delivery_id = ?")
        .run(updated.status, encodeJson(updated, "投递记录"), deliveryId);
      return updated;
    });
  }

  listDeliveries({ statuses, limit = 100, after_id } = {}) {
    this.#assertOpen();
    requireInteger(limit, "limit", 1, MAX_PAGE_SIZE);
    const afterId = after_id === undefined ? "" : requireText(after_id, "after_id");
    if (statuses !== undefined) {
      if (!Array.isArray(statuses) || statuses.length > MAX_PAGE_SIZE) {
        throw new CoreError("invalid_input", "statuses必须是大小受限的数组");
      }
      for (const status of statuses) requireText(status, "status");
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(", ");
      return this.#database.prepare(`
        SELECT record_json FROM deliveries WHERE delivery_id > ? AND status IN (${placeholders})
        ORDER BY delivery_id ASC LIMIT ?
      `).all(afterId, ...statuses, limit).map(decodeRecord);
    }
    return this.#database.prepare(`
      SELECT record_json FROM deliveries WHERE delivery_id > ? ORDER BY delivery_id ASC LIMIT ?
    `).all(afterId, limit).map(decodeRecord);
  }

  appendEvent(messageId, kind, data = {}) {
    this.#assertOpen();
    requireText(kind, "kind");
    const createdAt = new Date().toISOString();
    const row = this.#database.prepare(`
      INSERT INTO message_events (message_id, sequence, kind, data_json, created_at)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM message_events WHERE message_id = ?
      RETURNING message_id, sequence, kind, data_json, created_at
    `).get(messageId, kind, encodeJson(data, "事件数据"), createdAt, messageId);
    return {
      sequence: row.sequence,
      message_id: row.message_id,
      kind: row.kind,
      data: JSON.parse(row.data_json),
      created_at: row.created_at,
    };
  }

  eventsAfter(messageId, sequence = 0, limit = 100) {
    this.#assertOpen();
    requireInteger(sequence, "sequence");
    requireInteger(limit, "limit", 1, MAX_PAGE_SIZE);
    return this.#database.prepare(`
      SELECT message_id, sequence, kind, data_json, created_at FROM message_events
      WHERE message_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(messageId, sequence, limit).map(row => ({
      sequence: row.sequence,
      message_id: row.message_id,
      kind: row.kind,
      data: JSON.parse(row.data_json),
      created_at: row.created_at,
    }));
  }

  lastSequence(messageId) {
    this.#assertOpen();
    return this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM message_events WHERE message_id = ?")
      .get(messageId).sequence;
  }

  close() {
    if (this.#transactionDepth > 0) {
      throw new CoreError("store_transaction_active", "事务执行期间不能关闭存储");
    }
    if (this.#database.isOpen) this.#database.close();
  }
}
