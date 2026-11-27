import { CoreError, assertExactKeys, digest, requireInteger, requireText } from "./contracts.mjs";

const ROUTE_FIELDS = ["local_message_id", "origin_relay_id", "origin_message_id", "from_machine",
  "reply_relay_key", "reply_group_id", "reply_route_generation", "target_key"];
const PROCESSING = new Set(["processing", "done", "failed"]);
const OUTBOX_LIMIT = 2048;
const OUTBOX_BYTES = 16 * 1024 * 1024;
const TERMINAL_TTL_MS = 86400000;

export class RelayAckStore {
  #database;
  #transaction;
  #readMessage;
  #now;

  constructor({ database, transaction, readMessage, now = () => Date.now() }) {
    this.#database = database;
    this.#transaction = transaction;
    this.#readMessage = readMessage;
    this.#now = now;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS relay_inbound_map (
        local_message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(message_id),
        route_json TEXT NOT NULL CHECK (json_valid(route_json)),
        ack_seq INTEGER NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
        last_processing TEXT NOT NULL DEFAULT 'pending' CHECK (last_processing IN ('pending','processing','done','failed'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_outbox (
        event_id TEXT NOT NULL PRIMARY KEY,
        local_message_id TEXT NOT NULL REFERENCES relay_inbound_map(local_message_id),
        ack_seq INTEGER NOT NULL CHECK (ack_seq > 0),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','sent','unknown','dead_letter')),
        attempt INTEGER NOT NULL DEFAULT 0,
        due_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        UNIQUE(local_message_id, ack_seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relay_outbox_due ON relay_outbox(state, due_ms, event_id);
    `);
  }

  bindInbound(input) {
    assertExactKeys(input, ROUTE_FIELDS, "远端消息的原路回执");
    const route = Object.fromEntries(ROUTE_FIELDS.map(field => [
      field, field === "reply_route_generation" ? requireInteger(input[field], field, 1) : requireText(input[field], field, field === "target_key" ? 1024 : 256),
    ]));
    return this.#transaction(() => {
      const message = this.#readMessage(route.local_message_id);
      if (!message || message.target_key !== route.target_key || message.envelope?.caller?.machine_id !== route.from_machine) {
        throw new CoreError("delivery_mismatch", "远端回执未对应已保存的原发件机器与收件消息");
      }
      const existing = this.#database.prepare("SELECT route_json FROM relay_inbound_map WHERE local_message_id = ?").get(route.local_message_id);
      const saved = JSON.stringify(route);
      if (existing && existing.route_json !== saved) throw new CoreError("relay_route_changed", "这封信的原回执路线已固定");
      if (!existing) this.#database.prepare("INSERT INTO relay_inbound_map(local_message_id, route_json) VALUES (?, ?)").run(route.local_message_id, saved);
      return route;
    });
  }

  stageProcessing(localMessageId, processing) {
    requireText(localMessageId, "local_message_id", 256);
    if (!PROCESSING.has(processing)) throw new CoreError("invalid_input", "跨机回执需要明确处理状态");
    return this.#transaction(() => {
      const mapping = this.#database.prepare("SELECT * FROM relay_inbound_map WHERE local_message_id = ?").get(localMessageId);
      if (!mapping || mapping.last_processing === processing) return null;
      if (["done", "failed"].includes(mapping.last_processing)) throw new CoreError("processing_conflict", "原跨机确认已到终态");
      const now = this.#now();
      this.#database.prepare("DELETE FROM relay_outbox WHERE state IN ('sent','dead_letter') AND updated_ms < ?").run(now - TERMINAL_TTL_MS);
      const capacity = this.#database.prepare("SELECT count(*) AS total, COALESCE(sum(length(CAST(record_json AS BLOB))), 0) AS bytes FROM relay_outbox").get();
      const ackSeq = mapping.ack_seq + 1;
      const route = JSON.parse(mapping.route_json);
      const record = { event_id: digest({ localMessageId, ackSeq, origin: route.origin_relay_id }), ...route, ack_seq: ackSeq, processing };
      const value = JSON.stringify(record);
      if (capacity.total >= OUTBOX_LIMIT || capacity.bytes + Buffer.byteLength(value, "utf8") > OUTBOX_BYTES) {
        throw new CoreError("relay_outbox_full", "跨机回执队列已满，未提交新的处理确认");
      }
      this.#database.prepare("INSERT INTO relay_outbox(event_id, local_message_id, ack_seq, record_json, state, due_ms, updated_ms) VALUES (?, ?, ?, ?, 'prepared', ?, ?)")
        .run(record.event_id, localMessageId, ackSeq, value, now, now);
      this.#database.prepare("UPDATE relay_inbound_map SET ack_seq = ?, last_processing = ? WHERE local_message_id = ?").run(ackSeq, processing, localMessageId);
      return record;
    });
  }

  inboundRoute(localMessageId) {
    requireText(localMessageId, "local_message_id", 256);
    const saved = this.#database.prepare("SELECT route_json FROM relay_inbound_map WHERE local_message_id = ?").get(localMessageId);
    return saved ? JSON.parse(saved.route_json) : null;
  }

  reconcileLegacyProcessing() {
    return this.#transaction(() => {
      const evidence = this.#database.prepare(`
        SELECT mapping.local_message_id, json_extract(message.record_json, '$.processing') AS processing
        FROM relay_inbound_map AS mapping
        JOIN messages AS message ON message.message_id = mapping.local_message_id
        JOIN deliveries AS delivery ON delivery.message_id = message.message_id
        WHERE json_extract(message.record_json, '$.relay_inbound') = 1
          AND json_extract(message.record_json, '$.processing') IN ('processing','done','failed')
          AND json_extract(message.record_json, '$.processing') != mapping.last_processing
          AND mapping.last_processing IN ('pending','processing')
          AND json_extract(mapping.route_json, '$.target_key') = delivery.target_key
          AND delivery.status = 'accepted'
          AND EXISTS (
            SELECT 1 FROM message_events AS event
            WHERE event.message_id = message.message_id AND event.kind = 'processing'
              AND json_extract(event.data_json, '$.processing') = json_extract(message.record_json, '$.processing')
              AND json_extract(event.data_json, '$.delivery_id') = delivery.delivery_id
              AND json_extract(event.data_json, '$.binding_generation') = json_extract(delivery.record_json, '$.target_snapshot.binding_generation')
          )
        ORDER BY mapping.rowid
      `).all();
      return evidence.reduce((total, row) => total + Number(Boolean(this.stageProcessing(row.local_message_id, row.processing))), 0);
    });
  }

  ready(limit = 50) {
    requireInteger(limit, "limit", 1, 50);
    return this.#database.prepare("SELECT record_json, attempt FROM relay_outbox WHERE state = 'prepared' AND due_ms <= ? ORDER BY due_ms, rowid LIMIT ?")
      .all(this.#now(), limit).map(row => ({ ...JSON.parse(row.record_json), attempt: row.attempt }));
  }

  claim(eventId) {
    requireText(eventId, "event_id", 64);
    const now = this.#now();
    const row = this.#database.prepare("UPDATE relay_outbox SET state = 'dispatching', attempt = attempt + 1, updated_ms = ? WHERE event_id = ? AND state = 'prepared' AND due_ms <= ? RETURNING record_json, attempt")
      .get(now, eventId, now);
    return row ? { ...JSON.parse(row.record_json), attempt: row.attempt } : null;
  }

  settle(eventId, attempt, outcome) {
    requireText(eventId, "event_id", 64);
    requireInteger(attempt, "attempt", 1);
    const next = { accepted: "sent", unknown: "unknown", failed_before_send: "prepared", permanent_rejection: "dead_letter" };
    if (!Object.hasOwn(next, outcome)) throw new CoreError("invalid_input", "没有可核对的跨机回执结果");
    const now = this.#now();
    const due = outcome === "failed_before_send" ? now + Math.min(60000, 1000 * (2 ** Math.min(6, attempt - 1))) : now;
    const updated = this.#database.prepare(`
      UPDATE relay_outbox SET state = ?, due_ms = ?, updated_ms = ?
      WHERE event_id = ? AND attempt = ? AND (state = 'dispatching' OR (state = 'unknown' AND ? IN ('sent', 'dead_letter')))
    `).run(next[outcome], due, now, eventId, attempt, next[outcome]);
    return updated.changes === 1;
  }

  recoverInterrupted() {
    return this.#database.prepare("UPDATE relay_outbox SET state = 'unknown', updated_ms = ? WHERE state = 'dispatching'").run(this.#now()).changes;
  }

  read(eventId) {
    requireText(eventId, "event_id", 64);
    const row = this.#database.prepare("SELECT record_json, state, attempt FROM relay_outbox WHERE event_id = ?").get(eventId);
    return row ? { ...JSON.parse(row.record_json), state: row.state, attempt: row.attempt } : null;
  }
}
