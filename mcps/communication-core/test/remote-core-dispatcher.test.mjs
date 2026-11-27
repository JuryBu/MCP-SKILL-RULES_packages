import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CoreError } from "../src/contracts.mjs";
import { RelayAckStore } from "../src/relay-ack-store.mjs";
import * as relayEnvelope from "../src/relay-envelope.mjs";
import {
  DEFAULT_OUTBOX_LIMITS,
  PERMANENT_OUTBOX_ERROR_CODES,
  RelayOutboxStore,
  RemoteCoreDispatcher,
  createRemoteMachineProviders,
  shouldAcceptProcessingUpdate,
} from "../src/remote-core-dispatcher.mjs";
import { InMemoryRelayBus, RelayError } from "../src/transports/napcat-relay.mjs";

const MACHINE_DEV = "machine-dev";
const MACHINE_TRAIN = "machine-train";
const MACHINE_PEER = "machine-peer";
const RELAY_DEV_TRAIN = "relay-dev-train";
const RELAY_PEER_TRAIN = "relay-peer-train";
const GROUP_DEV_TRAIN = "group-relay-1001";
const GROUP_PEER_TRAIN = "group-relay-1002";

function makeTargetKey(machineId, host, surface, conversationId) {
  return JSON.stringify([machineId, host, surface, conversationId]);
}

function makeInboundMapping(overrides = {}) {
  return {
    local_message_id: "local-msg-1",
    origin_relay_id: "rly_origin_1",
    origin_message_id: "orig-msg-1",
    from_machine: MACHINE_DEV,
    reply_relay_key: RELAY_DEV_TRAIN,
    reply_group_id: GROUP_DEV_TRAIN,
    reply_route_generation: 1,
    target_key: makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1"),
    source_endpoint: "codex/desktop/conv-train-1",
    origin_source_endpoint: "antigravity/desktop/conv-dev-1",
    ...overrides,
  };
}

function createBusFrameCodec() {
  return {
    encode(input, opts = {}) {
      const maxFrameChars = opts.maxFrameChars ?? relayEnvelope.DEFAULT_MAX_FRAME_CHARS;
      try {
        return relayEnvelope.encodeRelayFrame(input, { maxFrameChars, enforceCqBudget: true });
      } catch (error) {
        if (error?.code === "relay_frame_too_large") {
          const fallback = relayEnvelope.encodeRelayFrame(
            { ...input, body: "" },
            { maxFrameChars: relayEnvelope.MAX_CONFIGURABLE_FRAME_CHARS, enforceCqBudget: false },
          );
          const overflowLen = Math.max(maxFrameChars + 16, error.details?.frame_length ?? maxFrameChars + 16);
          return {
            relayId: fallback.relayId,
            frameText: "x".repeat(overflowLen),
            bodySha256: relayEnvelope.computeBodySha256(input.body ?? ""),
          };
        }
        throw error;
      }
    },
    cqEncodedLength: relayEnvelope.cqEncodedLength,
  };
}

function createAckStoreHarness(t, { startMs = 1_700_000_000_000 } = {}) {
  let currentMs = startMs;
  const now = () => currentMs;
  const advance = ms => {
    currentMs += ms;
    return currentMs;
  };

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE messages (message_id TEXT PRIMARY KEY) STRICT;");
  t.after(() => db.close());

  let savepointCounter = 0;
  const transaction = fn => {
    const sp = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // 保持原始错误抛出
      }
      throw error;
    }
  };

  const messageRecords = new Map();
  const insertMessage = ({ message_id, target_key, from_machine }) => {
    db.prepare("INSERT OR IGNORE INTO messages (message_id) VALUES (?)").run(message_id);
    messageRecords.set(message_id, {
      message_id,
      target_key,
      envelope: { caller: { machine_id: from_machine } },
    });
  };

  const ackStore = new RelayAckStore({
    database: db,
    transaction,
    readMessage: id => messageRecords.get(id) ?? null,
    now,
  });

  return { db, ackStore, insertMessage, now, advance };
}

function createTwoMachineBus(t, {
  now = () => Date.now(),
  devBundleEnabled = true,
  trainBundleEnabled = true,
  allowFileBundleWrite = true,
  allowRecipientListDisclosure = true,
  withThirdPeer = false,
} = {}) {
  const bus = new InMemoryRelayBus({
    now,
    frameCodec: createBusFrameCodec(),
  });
  bus.registerMachine({ machine_id: MACHINE_DEV, qq_id: "qq-dev-10001", bundle_enabled: devBundleEnabled });
  bus.registerMachine({ machine_id: MACHINE_TRAIN, qq_id: "qq-train-10002", bundle_enabled: trainBundleEnabled });
  bus.registerRoute({
    relay_key: RELAY_DEV_TRAIN,
    group_id: GROUP_DEV_TRAIN,
    expected_group_name: "synthetic-dev-train-relay",
    channel: "qq",
    members: [MACHINE_DEV, MACHINE_TRAIN],
    generation: 1,
    role: "active_write",
    enabled: true,
    allow_file_bundle_write: allowFileBundleWrite,
    allow_recipient_list_disclosure: allowRecipientListDisclosure,
  });

  const transports = [];
  const createTransport = (machineId, opts = {}) => {
    const transport = bus.createTransportFor(machineId, opts);
    transports.push(transport);
    return transport;
  };

  const devTransport = createTransport(MACHINE_DEV, { bundleEnabled: devBundleEnabled });
  const trainTransport = createTransport(MACHINE_TRAIN, { bundleEnabled: trainBundleEnabled });

  let peerTransport = null;
  if (withThirdPeer) {
    bus.registerMachine({ machine_id: MACHINE_PEER, qq_id: "qq-peer-10003", bundle_enabled: true });
    bus.registerRoute({
      relay_key: RELAY_PEER_TRAIN,
      group_id: GROUP_PEER_TRAIN,
      expected_group_name: "synthetic-peer-train-relay",
      channel: "qq",
      members: [MACHINE_PEER, MACHINE_TRAIN],
      generation: 1,
      role: "active_write",
      enabled: true,
      allow_file_bundle_write: allowFileBundleWrite,
      allow_recipient_list_disclosure: allowRecipientListDisclosure,
    });
    peerTransport = createTransport(MACHINE_PEER, { bundleEnabled: true });
  }

  t.after(async () => {
    await Promise.all(transports.map(tr => tr.close()));
  });

  return { bus, devTransport, trainTransport, peerTransport };
}

function assertSpoolEmpty(bus, machineId) {
  const stats = bus.getSpoolStats(machineId);
  assert.equal(stats.incomingCount, 0, `${machineId} incomingSpool should be 0`);
  assert.equal(stats.outgoingCount, 0, `${machineId} outgoingSpool should be 0`);
  assert.equal(stats.totalBytes, 0, `${machineId} totalBytes should be 0`);
  assert.deepEqual(stats.pendingEventIds, [], `${machineId} pendingEventIds should be empty`);
}

function countResources(list) {
  const map = new Map();
  for (const kind of list) {
    map.set(kind, (map.get(kind) ?? 0) + 1);
  }
  return map;
}

/* ============================================================================
 * 1. RelayOutboxStore: node:sqlite STRICT 表 & 内存回退双模式
 * ========================================================================== */

for (const mode of ["sqlite", "memory"]) {
  describe(`RelayOutboxStore (${mode} 模式)`, () => {
    function createStore(t, opts = {}) {
      let currentMs = opts.startMs ?? 1_700_000_000_000;
      const now = () => currentMs;
      const advance = ms => {
        currentMs += ms;
        return currentMs;
      };
      let db = null;
      if (mode === "sqlite") {
        db = new DatabaseSync(":memory:");
        t.after(() => db.close());
      }
      const store = new RelayOutboxStore({
        database: db,
        now,
        maxOutbox: opts.maxOutbox ?? DEFAULT_OUTBOX_LIMITS.maxOutbox,
        maxOutboxBytes: opts.maxOutboxBytes ?? DEFAULT_OUTBOX_LIMITS.maxOutboxBytes,
        ttlMs: opts.ttlMs ?? 60_000,
        baseRetryMs: opts.baseRetryMs ?? 1_000,
        maxRetryMs: opts.maxRetryMs ?? 5_000,
      });
      return { store, db, now, advance };
    }

    it("recordInboundMapping 幂等，修改原路由抛 relay_route_changed", t => {
      const { store } = createStore(t);
      const base = makeInboundMapping();
      const first = store.recordInboundMapping(base);
      assert.equal(first.local_message_id, base.local_message_id);
      assert.equal(first.ack_seq, 0);
      assert.equal(first.last_processing, "pending");

      const second = store.recordInboundMapping({ ...base });
      assert.deepEqual(second, first);

      assert.throws(
        () => store.recordInboundMapping({ ...base, reply_route_generation: 2 }),
        err => err instanceof CoreError && err.code === "relay_route_changed",
      );
      assert.throws(
        () => store.recordInboundMapping({ ...base, reply_group_id: "group-relay-9999" }),
        err => err instanceof CoreError && err.code === "relay_route_changed",
      );
      assert.throws(
        () => store.recordInboundMapping({ ...base, reply_relay_key: "relay-other" }),
        err => err instanceof CoreError && err.code === "relay_route_changed",
      );
    });

    it("enqueueAck 递增 ack_seq、终态冲突抛 processing_conflict、超容量抛 relay_outbox_full", t => {
      const { store } = createStore(t, { maxOutbox: 3 });
      assert.equal(store.enqueueAck({ local_message_id: "missing-msg", processing: "processing" }), null);

      store.recordInboundMapping(makeInboundMapping({ local_message_id: "local-a" }));
      const e1 = store.enqueueAck({ local_message_id: "local-a", processing: "processing", note: "step 1" });
      const e2 = store.enqueueAck({ local_message_id: "local-a", processing: "processing", note: "step 2" });
      const e3 = store.enqueueAck({
        local_message_id: "local-a",
        processing: "done",
        note: "complete",
        reply_message_id: "reply-msg-1",
      });

      assert.equal(e1.ack_seq, 1);
      assert.equal(e2.ack_seq, 2);
      assert.equal(e3.ack_seq, 3);
      assert.equal(e3.reply_message_id, "reply-msg-1");
      assert.equal(e3.status, "pending");

      // 同终态幂等返回最新记录
      const sameTerminal = store.enqueueAck({ local_message_id: "local-a", processing: "done" });
      assert.equal(sameTerminal.id, e3.id);
      assert.equal(sameTerminal.ack_seq, 3);

      // 终态冲突抛 processing_conflict
      assert.throws(
        () => store.enqueueAck({ local_message_id: "local-a", processing: "failed" }),
        err => err instanceof CoreError && err.code === "processing_conflict",
      );
      assert.throws(
        () => store.enqueueAck({ local_message_id: "local-a", processing: "processing" }),
        err => err instanceof CoreError && err.code === "processing_conflict",
      );

      // 容量已达 maxOutbox=3，再入队抛 relay_outbox_full
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "local-b", origin_relay_id: "rly_origin_2" }));
      assert.throws(
        () => store.enqueueAck({ local_message_id: "local-b", processing: "failed" }),
        err => err instanceof CoreError && err.code === "relay_outbox_full",
      );

      // 验证 failed -> done 也抛 processing_conflict
      const { store: store2 } = createStore(t, { maxOutbox: 5 });
      store2.recordInboundMapping(makeInboundMapping({ local_message_id: "local-c" }));
      store2.enqueueAck({ local_message_id: "local-c", processing: "failed", note: "boom" });
      assert.throws(
        () => store2.enqueueAck({ local_message_id: "local-c", processing: "done" }),
        err => err instanceof CoreError && err.code === "processing_conflict",
      );
    });

    it("markOutboxRetry 指数退避、永久错误转 dead_letter、pruneExpired 过期转死信并清理", t => {
      const { store, now, advance } = createStore(t, { ttlMs: 30_000, baseRetryMs: 1_000, maxRetryMs: 5_000 });
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "local-backoff" }));
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "local-perm", origin_relay_id: "rly_origin_perm" }));
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "local-expire", origin_relay_id: "rly_origin_exp" }));

      const eBackoff = store.enqueueAck({ local_message_id: "local-backoff", processing: "processing" });
      const ePerm = store.enqueueAck({ local_message_id: "local-perm", processing: "done" });
      const eExpire = store.enqueueAck({ local_message_id: "local-expire", processing: "processing" });

      // 指数退避：1000 -> 2000 -> 4000 -> 5000 (maxRetryMs)，且支持更大的 retryAfterMs
      const r1 = store.markOutboxRetry(eBackoff.id, "relay_provider_error", 0, now());
      assert.equal(r1.status, "pending");
      assert.equal(r1.attempt_count, 1);
      assert.equal(r1.next_attempt_at, now() + 1_000);

      const r2 = store.markOutboxRetry(eBackoff.id, "relay_provider_error", 0, now());
      assert.equal(r2.attempt_count, 2);
      assert.equal(r2.next_attempt_at, now() + 2_000);

      const r3 = store.markOutboxRetry(eBackoff.id, "relay_provider_error", 0, now());
      assert.equal(r3.attempt_count, 3);
      assert.equal(r3.next_attempt_at, now() + 4_000);

      const r4 = store.markOutboxRetry(eBackoff.id, "relay_provider_error", 0, now());
      assert.equal(r4.attempt_count, 4);
      assert.equal(r4.next_attempt_at, now() + 5_000);

      const r5 = store.markOutboxRetry(eBackoff.id, "RELAY_RATE_LIMITED", 8_000, now());
      assert.equal(r5.last_error_code, "relay_rate_limited");
      assert.equal(r5.next_attempt_at, now() + 8_000);

      // 永久错误码直接转 dead_letter
      assert.equal(PERMANENT_OUTBOX_ERROR_CODES.has("relay_route_drain_expired"), true);
      const dead = store.markOutboxRetry(ePerm.id, "RELAY_ROUTE_DRAIN_EXPIRED", 0, now());
      assert.equal(dead.status, "dead_letter");
      assert.equal(dead.last_error_code, "relay_route_drain_expired");
      assert.equal(dead.retryable, false);

      // 标记一条已发送，随后推进时间验证 pruneExpired
      store.markOutboxSent(eBackoff.id, { relay_id: "rly_sent_1" }, now());

      // 推进过 ttlMs (30_000)：eExpire(pending) 过期转死信，已到期的 sent/dead_letter 被删除
      advance(30_000);
      const prune1 = store.pruneExpired(now());
      assert.equal(prune1.dead_lettered, 1);
      assert.equal(prune1.deleted, 2);
      const afterExpire = store.getOutboxEntry(eExpire.id);
      assert.equal(afterExpire.status, "dead_letter");
      assert.equal(afterExpire.last_error_code, "relay_outbox_expired");

      // 再推进一个 ttlMs，死信本身过期被物理清理
      advance(30_000);
      const prune2 = store.pruneExpired(now());
      assert.equal(prune2.dead_lettered, 0);
      assert.equal(prune2.deleted, 1);
      assert.equal(store.stats().total_outbox, 0);
    });

    it("markOutboxUnknown 状态保护：仅在 confirmedNotSent、永久错误或超时才离开 unknown", t => {
      const { store, now, advance } = createStore(t, { ttlMs: 20_000, baseRetryMs: 1_000, maxRetryMs: 5_000 });
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "u-not-sent", origin_relay_id: "rly_u1" }));
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "u-perm", origin_relay_id: "rly_u2" }));
      store.recordInboundMapping(makeInboundMapping({ local_message_id: "u-expire", origin_relay_id: "rly_u3" }));

      const e1 = store.enqueueAck({ local_message_id: "u-not-sent", processing: "processing" });
      const e2 = store.enqueueAck({ local_message_id: "u-perm", processing: "processing" });
      const e3 = store.enqueueAck({ local_message_id: "u-expire", processing: "done" });

      const u1 = store.markOutboxUnknown(e1.id, { relay_id: "rly_attempt_1", error_code: "relay_transport_unconfirmed" }, now());
      assert.equal(u1.status, "unknown");
      assert.equal(u1.outcome_unknown, true);
      assert.equal(u1.retryable, false);
      assert.equal(u1.evidence.dedupe_key, e1.dedupe_key);
      assert.equal(store.listDueOutbox(now() + 10_000).some(x => x.id === e1.id), false);

      // 默认 markOutboxRetry（confirmedNotSent=false）绝不退出 unknown
      const stillUnknown = store.markOutboxRetry(e1.id, "relay_provider_error", 0, now() + 500);
      assert.equal(stillUnknown.status, "unknown");
      assert.equal(stillUnknown.outcome_unknown, true);
      assert.equal(stillUnknown.retryable, false);

      // 仅 confirmedNotSent: true 才回到 pending
      const requeued = store.markOutboxRetry(e1.id, "relay_not_sent", 0, now() + 1_000, { confirmedNotSent: true });
      assert.equal(requeued.status, "pending");
      assert.equal(requeued.outcome_unknown, false);
      assert.equal(requeued.retryable, true);

      // 永久错误离开 unknown -> dead_letter
      store.markOutboxUnknown(e2.id, { error_code: "relay_transport_unconfirmed" }, now());
      const permDead = store.markOutboxRetry(e2.id, "relay_route_drain_expired", 0, now() + 500);
      assert.equal(permDead.status, "dead_letter");
      assert.equal(permDead.outcome_unknown, false);
      assert.equal(permDead.last_error_code, "relay_route_drain_expired");

      // 超时离开 unknown -> dead_letter
      store.markOutboxUnknown(e3.id, { error_code: "relay_transport_unconfirmed" }, now());
      advance(20_000);
      const expiredDead = store.markOutboxUnknown(e3.id, { verify_status: "still_unknown" }, now());
      assert.equal(expiredDead.status, "dead_letter");
      assert.equal(expiredDead.outcome_unknown, false);
    });
  });
}

/* ============================================================================
 * 2. 原生对接 RelayAckStore（ackStore 模式）
 * ========================================================================== */

describe("RemoteCoreDispatcher + RelayAckStore（ackStore 原生模式）", () => {
  it("走通 recordInboundMessageMapping -> enqueueProcessingAck -> triggerFlush/flushOutbox -> settle('accepted')", async t => {
    const { ackStore, insertMessage, now } = createAckStoreHarness(t);
    const sentFrames = [];
    const transport = {
      async sendFrame(frame) {
        sentFrames.push(frame);
        return {
          ok: true,
          status: "sent_verified",
          relay_id: `rly_sent_${sentFrames.length}`,
          relay_key: frame.reply_relay_key,
          group_id: frame.reply_group_id,
          route_generation: frame.reply_route_generation,
          outcome_unknown: false,
        };
      },
    };

    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport,
      ackStore,
      now,
    });
    t.after(() => dispatcher.close());

    assert.equal(dispatcher.outboxStore, ackStore);
    assert.equal(dispatcher.getMetrics().using_shared_ack_store, true);

    const targetKey = makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1");
    insertMessage({ message_id: "local-ack-1", target_key: targetKey, from_machine: MACHINE_DEV });

    dispatcher.recordInboundMessageMapping({
      local_message_id: "local-ack-1",
      origin_relay_id: "rly_orig_ack_1",
      origin_message_id: "orig-ack-1",
      from_machine: MACHINE_DEV,
      reply_relay_key: RELAY_DEV_TRAIN,
      reply_group_id: GROUP_DEV_TRAIN,
      reply_route_generation: 3,
      target_key: targetKey,
    });

    const staged1 = dispatcher.enqueueProcessingAck({ local_message_id: "local-ack-1", processing: "processing" });
    assert.equal(staged1.ack_seq, 1);
    assert.equal(ackStore.read(staged1.event_id).state, "prepared");

    const triggerSummary = await dispatcher.triggerFlush();
    assert.equal(triggerSummary.flushed, 1);
    assert.equal(ackStore.read(staged1.event_id).state, "sent");
    assert.equal(ackStore.read(staged1.event_id).attempt, 1);

    // 再入队 done 并经 flushOutbox 发送
    const staged2 = dispatcher.enqueueProcessingAck({ local_message_id: "local-ack-1", processing: "done" });
    assert.equal(staged2.ack_seq, 2);
    const flushSummary = await dispatcher.flushOutbox();
    assert.equal(flushSummary.flushed, 1);
    assert.equal(ackStore.read(staged2.event_id).state, "sent");

    assert.equal(sentFrames.length, 2);
    assert.equal(sentFrames[0].op, "processing_ack");
    assert.equal(sentFrames[0].reply_relay_key, RELAY_DEV_TRAIN);
    assert.equal(sentFrames[0].reply_group_id, GROUP_DEV_TRAIN);
    assert.equal(sentFrames[0].reply_route_generation, 3);
    assert.equal(sentFrames[0].meta.processing, "processing");
    assert.equal(sentFrames[1].meta.processing, "done");
  });

  it("outcome_unknown 结果与 outcomeUnknown 异常均精准 settle('unknown') 且再次 flushOutbox 绝不盲重发", async t => {
    const { ackStore, insertMessage, now, advance } = createAckStoreHarness(t);
    const settleCalls = [];
    const origSettle = ackStore.settle.bind(ackStore);
    ackStore.settle = (eventId, attempt, outcome) => {
      settleCalls.push({ eventId, attempt, outcome });
      return origSettle(eventId, attempt, outcome);
    };

    let sendCalls = 0;
    const transport = {
      async sendFrame(frame) {
        sendCalls += 1;
        if (frame.meta.local_message_id === "local-u-res") {
          return { ok: true, status: "sent_unverified", outcome_unknown: true, relay_id: "rly_unverified_1" };
        }
        throw new RelayError(
          "relay_transport_unconfirmed",
          "请求已发出但未取得明确回执",
          { request_sent: true },
          { outcomeUnknown: true },
        );
      },
    };

    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport,
      ackStore,
      now,
    });
    t.after(() => dispatcher.close());

    const targetKey = makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1");
    insertMessage({ message_id: "local-u-res", target_key: targetKey, from_machine: MACHINE_DEV });
    insertMessage({ message_id: "local-u-err", target_key: targetKey, from_machine: MACHINE_DEV });

    dispatcher.recordInboundMessageMapping(makeInboundMapping({ local_message_id: "local-u-res", origin_relay_id: "rly_ur1" }));
    dispatcher.recordInboundMessageMapping(makeInboundMapping({ local_message_id: "local-u-err", origin_relay_id: "rly_ue1" }));

    const ev1 = dispatcher.enqueueProcessingAck({ local_message_id: "local-u-res", processing: "processing" });
    const ev2 = dispatcher.enqueueProcessingAck({ local_message_id: "local-u-err", processing: "done" });

    const res1 = await dispatcher.flushOutbox();
    assert.equal(res1.unknown, 2);
    assert.equal(res1.flushed, 0);
    assert.equal(sendCalls, 2);
    assert.equal(ackStore.read(ev1.event_id).state, "unknown");
    assert.equal(ackStore.read(ev2.event_id).state, "unknown");
    assert.deepEqual(settleCalls.map(c => c.outcome), ["unknown", "unknown"]);

    // 推进时钟后多次 flushOutbox 绝不盲重发
    advance(120_000);
    const res2 = await dispatcher.flushOutbox();
    assert.equal(res2.flushed, 0);
    assert.equal(res2.unknown, 0);
    assert.equal(sendCalls, 2);
    assert.equal(ackStore.ready().length, 0);
  });

  it("明确发送前失败 settle('failed_before_send') 可退避重试，永久拒收 settle('permanent_rejection')，recoverInterruptedOutbox 转 unknown", async t => {
    const { ackStore, insertMessage, now, advance } = createAckStoreHarness(t);
    const settleCalls = [];
    const origSettle = ackStore.settle.bind(ackStore);
    ackStore.settle = (eventId, attempt, outcome) => {
      settleCalls.push({ eventId, attempt, outcome });
      return origSettle(eventId, attempt, outcome);
    };

    const attemptsByMsg = new Map();
    const transport = {
      async sendFrame(frame) {
        const id = frame.meta.local_message_id;
        const count = (attemptsByMsg.get(id) ?? 0) + 1;
        attemptsByMsg.set(id, count);
        if (id === "local-retry") {
          if (count === 1) {
            throw new RelayError(
              "relay_transport_unconfirmed",
              "连接前失败未发送",
              { request_sent: false },
              { outcomeUnknown: false },
            );
          }
          return { ok: true, status: "sent_verified", relay_id: "rly_retry_ok", outcome_unknown: false };
        }
        if (id === "local-perm") {
          throw new RelayError(
            "relay_route_drain_expired",
            "旧中继群排空期已过",
            { request_sent: false },
            { outcomeUnknown: false },
          );
        }
        return { ok: true, status: "sent_verified", relay_id: "rly_unexpected" };
      },
    };

    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport,
      ackStore,
      now,
    });
    t.after(() => dispatcher.close());

    const targetKey = makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1");
    for (const id of ["local-retry", "local-perm", "local-interrupted"]) {
      insertMessage({ message_id: id, target_key: targetKey, from_machine: MACHINE_DEV });
      dispatcher.recordInboundMessageMapping(makeInboundMapping({ local_message_id: id, origin_relay_id: `rly_${id}` }));
    }

    const evRetry = dispatcher.enqueueProcessingAck({ local_message_id: "local-retry", processing: "processing" });
    const evPerm = dispatcher.enqueueProcessingAck({ local_message_id: "local-perm", processing: "done" });
    const evInterrupted = dispatcher.enqueueProcessingAck({ local_message_id: "local-interrupted", processing: "done" });

    // 手动模拟进程崩溃中断在 dispatching 状态
    const claimed = ackStore.claim(evInterrupted.event_id);
    assert.equal(claimed.attempt, 1);
    assert.equal(ackStore.read(evInterrupted.event_id).state, "dispatching");

    const recovered = dispatcher.recoverInterruptedOutbox();
    assert.equal(recovered, 1);
    assert.equal(ackStore.read(evInterrupted.event_id).state, "unknown");

    // 首次刷盘：local-retry 失败未发 -> prepared 退避，local-perm 永久拒收 -> dead_letter，local-interrupted 不盲重发
    const f1 = await dispatcher.flushOutbox();
    assert.equal(f1.retried, 1);
    assert.equal(f1.dead_lettered, 1);
    assert.equal(ackStore.read(evRetry.event_id).state, "prepared");
    assert.equal(ackStore.read(evPerm.event_id).state, "dead_letter");
    assert.equal(attemptsByMsg.get("local-interrupted"), undefined);
    assert.deepEqual(
      settleCalls.map(c => [c.eventId, c.outcome]),
      [
        [evRetry.event_id, "failed_before_send"],
        [evPerm.event_id, "permanent_rejection"],
      ],
    );

    // 退避期未到不重发；推进 1000ms 后重发成功转 sent
    const fImmediate = await dispatcher.flushOutbox();
    assert.equal(fImmediate.flushed, 0);
    advance(1_000);
    const f2 = await dispatcher.flushOutbox();
    assert.equal(f2.flushed, 1);
    assert.equal(ackStore.read(evRetry.event_id).state, "sent");
    assert.equal(ackStore.read(evRetry.event_id).attempt, 2);
    assert.equal(attemptsByMsg.get("local-interrupted"), undefined);
  });
});

/* ============================================================================
 * 3. 独立 RelayOutboxStore 下的两阶段 flushOutbox()
 * ========================================================================== */

describe("独立 RelayOutboxStore 两阶段 flushOutbox()", () => {
  it("阶段 1 对 unknown 仅调 verifyFrameDelivery（confirmed / not_sent / still_unknown），阶段 2 对 pending 沿原三元组发送", async t => {
    let currentMs = 1_700_000_000_000;
    const now = () => currentMs;
    const advance = ms => {
      currentMs += ms;
      return currentMs;
    };

    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    const outboxStore = new RelayOutboxStore({ database: db, now, baseRetryMs: 1_000, maxRetryMs: 5_000, ttlMs: 60_000 });

    const sendCalls = [];
    const verifyCalls = [];
    const sendBehavior = new Map();
    const verifyBehavior = new Map();

    const transport = {
      async sendFrame(frame) {
        sendCalls.push(frame);
        const mode = sendBehavior.get(frame.meta.local_message_id) ?? "ok";
        if (mode === "unknown_result") {
          return { ok: true, status: "sent_unverified", outcome_unknown: true, relay_id: `rly_u_${frame.meta.local_message_id}` };
        }
        if (mode === "unknown_error") {
          throw new RelayError(
            "relay_transport_unconfirmed",
            "网络超时结果未知",
            { relay_id: `rly_u_${frame.meta.local_message_id}` },
            { outcomeUnknown: true },
          );
        }
        return {
          ok: true,
          status: "sent_verified",
          relay_id: `rly_ok_${sendCalls.length}`,
          relay_key: frame.reply_relay_key,
          group_id: frame.reply_group_id,
          route_generation: frame.reply_route_generation,
          outcome_unknown: false,
        };
      },
      async verifyFrameDelivery(req) {
        verifyCalls.push(req);
        return verifyBehavior.get(req.dedupe_key) ?? { verify_status: "still_unknown" };
      },
    };

    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport,
      outboxStore,
      now,
    });
    t.after(() => dispatcher.close());

    // 先登记 3 条将进入 unknown 的消息（各自不同的原路由代次以校验原三元组）
    const specs = [
      { id: "msg-u-confirmed", gen: 1, mode: "unknown_result" },
      { id: "msg-u-not-sent", gen: 2, mode: "unknown_error" },
      { id: "msg-u-still", gen: 3, mode: "unknown_result" },
    ];
    const entries = {};
    for (const spec of specs) {
      sendBehavior.set(spec.id, spec.mode);
      dispatcher.recordInboundMessageMapping(makeInboundMapping({
        local_message_id: spec.id,
        origin_relay_id: `rly_${spec.id}`,
        reply_route_generation: spec.gen,
      }));
      entries[spec.id] = dispatcher.enqueueProcessingAck({ local_message_id: spec.id, processing: "processing" });
    }

    // 首次刷盘：3 条都进入 unknown
    const first = await dispatcher.flushOutbox();
    assert.equal(first.unknown, 3);
    assert.equal(sendCalls.length, 3);
    assert.equal(verifyCalls.length, 0);

    // 此时新增第 4 条明确未发 pending 消息
    sendBehavior.set("msg-pending-fresh", "ok");
    dispatcher.recordInboundMessageMapping(makeInboundMapping({
      local_message_id: "msg-pending-fresh",
      origin_relay_id: "rly_msg-pending-fresh",
      reply_relay_key: RELAY_DEV_TRAIN,
      reply_group_id: GROUP_DEV_TRAIN,
      reply_route_generation: 4,
    }));
    const eFresh = dispatcher.enqueueProcessingAck({ local_message_id: "msg-pending-fresh", processing: "done", note: "fresh" });

    // 配置阶段 1 查证结果
    verifyBehavior.set(entries["msg-u-confirmed"].dedupe_key, { confirmed: true, status: "sent_verified" });
    verifyBehavior.set(entries["msg-u-not-sent"].dedupe_key, { not_sent: true, status: "not_sent", code: "relay_not_sent" });
    verifyBehavior.set(entries["msg-u-still"].dedupe_key, { verify_status: "still_unknown" });
    sendBehavior.set("msg-u-not-sent", "ok");

    // 推进 1_000ms 使 3 条 unknown 到期查证
    advance(1_000);
    const sendBefore = sendCalls.length;
    const second = await dispatcher.flushOutbox();

    assert.equal(verifyCalls.length, 3);
    assert.equal(second.verified_sent, 1);
    assert.equal(second.verified_requeued, 1);
    assert.equal(second.unknown, 1);
    assert.equal(second.flushed, 2); // 1 verified_sent + 1 fresh pending sent

    // 阶段 1 严禁对 3 条 unknown 调 sendFrame；阶段 2 仅发送了 eFresh
    const round2Sends = sendCalls.slice(sendBefore);
    assert.equal(round2Sends.length, 1);
    assert.equal(round2Sends[0].dedupe_key, eFresh.dedupe_key);
    assert.equal(round2Sends[0].reply_relay_key, RELAY_DEV_TRAIN);
    assert.equal(round2Sends[0].reply_group_id, GROUP_DEV_TRAIN);
    assert.equal(round2Sends[0].reply_route_generation, 4);

    // 核对各条查证调用携带原 dedupe_key 与原三元组
    const confirmedVerify = verifyCalls.find(v => v.dedupe_key === entries["msg-u-confirmed"].dedupe_key);
    assert.equal(confirmedVerify.reply_relay_key, RELAY_DEV_TRAIN);
    assert.equal(confirmedVerify.reply_group_id, GROUP_DEV_TRAIN);
    assert.equal(confirmedVerify.reply_route_generation, 1);

    assert.equal(outboxStore.getOutboxEntry(entries["msg-u-confirmed"].id).status, "sent");
    assert.equal(outboxStore.getOutboxEntry(entries["msg-u-not-sent"].id).status, "pending");
    assert.equal(outboxStore.getOutboxEntry(entries["msg-u-still"].id).status, "unknown");
    assert.equal(outboxStore.getOutboxEntry(eFresh.id).status, "sent");

    // 推进时钟越过 msg-u-not-sent 的退避窗口（2000ms）：
    // msg-u-still 再次查证仍为 unknown 绝不盲重发；msg-u-not-sent 沿原 dedupe_key 与原三元组发送成功
    advance(2_000);
    const sendBeforeRound3 = sendCalls.length;
    const third = await dispatcher.flushOutbox();
    assert.equal(third.flushed, 1);
    assert.equal(third.unknown, 1);

    const round3Sends = sendCalls.slice(sendBeforeRound3);
    assert.equal(round3Sends.length, 1);
    assert.equal(round3Sends[0].dedupe_key, entries["msg-u-not-sent"].dedupe_key);
    assert.equal(round3Sends[0].reply_route_generation, 2);
    assert.equal(outboxStore.getOutboxEntry(entries["msg-u-not-sent"].id).status, "sent");
    assert.equal(outboxStore.getOutboxEntry(entries["msg-u-still"].id).status, "unknown");
  });

  it("无 verifyFrameDelivery 或查证遇永久错误时正确保护/转死信", async t => {
    let currentMs = 1_700_000_000_000;
    const now = () => currentMs;
    const outboxStore = new RelayOutboxStore({ now, baseRetryMs: 1_000, maxRetryMs: 5_000, ttlMs: 60_000 });

    let sendCount = 0;
    const transportNoVerifier = {
      async sendFrame() {
        sendCount += 1;
        return { ok: true, status: "sent_unverified", outcome_unknown: true };
      },
    };
    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: transportNoVerifier,
      outboxStore,
      now,
    });
    t.after(() => dispatcher.close());

    dispatcher.recordInboundMessageMapping(makeInboundMapping({ local_message_id: "no-verifier-msg" }));
    const entry = dispatcher.enqueueProcessingAck({ local_message_id: "no-verifier-msg", processing: "processing" });

    await dispatcher.flushOutbox();
    assert.equal(sendCount, 1);
    assert.equal(outboxStore.getOutboxEntry(entry.id).status, "unknown");

    currentMs += 2_000;
    const second = await dispatcher.flushOutbox();
    assert.equal(second.unknown, 1);
    assert.equal(sendCount, 1);
    assert.equal(outboxStore.getOutboxEntry(entry.id).evidence.verify_status, "verifier_unavailable");
  });
});

/* ============================================================================
 * 4. 真实 relay-envelope.mjs (frameCodec) + InMemoryRelayBus 联调
 * ========================================================================== */

describe("真实 relay-envelope.mjs + InMemoryRelayBus 端到端联调", () => {
  it("短消息走文本中继并完整推进 4 层状态（relay_accepted -> remote_core_persisted -> target_delivered -> target_processing）", async t => {
    const { devTransport, trainTransport } = createTwoMachineBus(t);
    const deliveredAtTrain = [];
    const deliveryAcksAtDev = [];
    const processingAcksAtDev = [];

    const dev = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: devTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        applyRemoteDeliveryAck: ack => deliveryAcksAtDev.push(ack),
        applyRemoteProcessingAck: ack => processingAcksAtDev.push(ack),
      },
    });
    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        deliverInboundMessage: msg => {
          deliveredAtTrain.push(msg);
          return {
            local_message_id: `local-train-${deliveredAtTrain.length}`,
            target_key: makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1"),
            delivery_status: "accepted",
          };
        },
      },
    });
    t.after(async () => {
      await dev.close();
      await train.close();
    });

    const sent = await dev.dispatchMessage({
      dedupeKey: "msg-short-1",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "hello synthetic cross-machine",
      sourceIdentityVerified: true,
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.transport_mode, "text_relay");
    assert.equal(sent.stage, "relay_accepted");
    assert.equal(sent.stages.relay_accepted.ok, true);
    assert.equal(sent.stages.remote_core_persisted.ok, false);
    assert.equal(sent.stages.target_delivered.status, "unknown");
    assert.equal(sent.stages.target_processing.status, "pending");

    // 1. train 轮询收件并回发 delivery_ack
    const trainPoll = await train.pollOnce();
    assert.equal(trainPoll.processed, 1);
    assert.equal(deliveredAtTrain.length, 1);
    assert.equal(deliveredAtTrain[0].body, "hello synthetic cross-machine");
    assert.equal(deliveredAtTrain[0].source_identity_verified, true);
    // 校验底层线上原始帧符合真实 relay-envelope 规范
    const decodedWire = relayEnvelope.decodeRelayFrame(deliveredAtTrain[0].event.frame.raw_frame);
    assert.equal(decodedWire.ok, true);
    assert.equal(decodedWire.frame.op, "message");
    assert.equal(decodedWire.frame.body, "hello synthetic cross-machine");

    // 2. dev 轮询收到 delivery_ack，推进 remote_core_persisted 与 target_delivered
    const devPoll1 = await dev.pollOnce();
    assert.equal(devPoll1.processed, 1);
    assert.equal(deliveryAcksAtDev.length, 1);
    const afterDelivery = dev.getOutboundStatus(sent.request_id);
    assert.equal(afterDelivery.stages.remote_core_persisted.ok, true);
    assert.equal(afterDelivery.stages.target_delivered.status, "accepted");
    assert.equal(afterDelivery.stages.target_processing.status, "pending");

    // 3. train 刷盘 processing_ack (processing -> done)
    train.enqueueProcessingAck({ local_message_id: "local-train-1", processing: "processing", note: "started" });
    await train.flushOutbox();
    await dev.pollOnce();
    const afterProcessing = dev.getOutboundStatus(sent.request_id);
    assert.equal(afterProcessing.stages.target_processing.status, "processing");
    assert.equal(afterProcessing.stages.target_processing.ack_seq, 1);
    assert.equal(afterProcessing.stages.target_processing.note, "started");

    train.enqueueProcessingAck({ local_message_id: "local-train-1", processing: "done", note: "finished" });
    await train.flushOutbox();
    await dev.pollOnce();
    const afterDone = dev.getOutboundStatus(sent.request_id);
    assert.equal(afterDone.stages.target_processing.status, "done");
    assert.equal(afterDone.stages.target_processing.ack_seq, 2);
    assert.equal(afterDone.stages.target_processing.note, "finished");
    assert.equal(processingAcksAtDev.length, 2);

    // 补充验证 frame_text 字符串入站路径走通 frameCodec.decodeRelayFrame
    const encodedRaw = relayEnvelope.encodeRelayFrame({
      relay_id: "rly_raw_text_decode_1",
      op: "message",
      from_machine: MACHINE_DEV,
      to_machine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "via frame_text decode",
      meta: { request_id: "req_raw_1", hop_count: 1, source_identity_verified: true },
    });
    const rawOutcome = await train.handleInboundEvent({
      event_id: "evt_raw_text_1",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_DEV,
      sender_verified: true,
      frame_text: encodedRaw.frameText,
    });
    assert.equal(rawOutcome.handled, true);
    assert.equal(deliveredAtTrain.at(-1).body, "via frame_text decode");
  });

  it("超长正文、CQ 膨胀破 1800 与携带 attachments 自动升格 sendBundle 并在接管后释放 spool；无文件包通道抛小写错误码", async t => {
    const { bus, devTransport, trainTransport } = createTwoMachineBus(t);
    const received = [];

    const dev = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: devTransport,
      frameCodec: relayEnvelope,
    });
    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        deliverInboundMessage: msg => {
          received.push(msg);
          return {
            local_message_id: `local-b-${received.length}`,
            target_key: makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1"),
            delivery_status: "accepted",
          };
        },
      },
    });
    t.after(async () => {
      await dev.close();
      await train.close();
    });

    // (a) 超长正文 > 1800
    const longBody = "L".repeat(2200);
    const rLong = await dev.dispatchMessage({
      dedupeKey: "bundle-long-1",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: longBody,
    });
    assert.equal(rLong.transport_mode, "file_bundle");
    assert.equal(bus.getSpoolStats(MACHINE_DEV).outgoingCount, 1);

    // (b) CQ 膨胀破 1800（原长 380 < 1800，但每个 & 膨胀 +4 达 1900 > 1800）
    const cqBody = "&".repeat(380);
    assert.ok(cqBody.length < 1800);
    assert.ok(relayEnvelope.cqEncodedLength(cqBody) > 1800);
    const rCq = await dev.dispatchMessage({
      dedupeKey: "bundle-cq-1",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: cqBody,
    });
    assert.equal(rCq.transport_mode, "file_bundle");

    // (c) 短正文 + attachments 自动升格 sendBundle
    const rAtt = await dev.dispatchMessage({
      dedupeKey: "bundle-att-1",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "short with attachment",
      attachments: [{ name: "report.txt", filePath: "/synthetic/attachments/report.txt" }],
    });
    assert.equal(rAtt.transport_mode, "file_bundle");
    assert.equal(bus.getSpoolStats(MACHINE_DEV).outgoingCount, 3);

    // train 接管 3 笔文件包并立即 ackBundleEvents 释放 spool
    const trainPoll = await train.pollOnce();
    assert.equal(trainPoll.processed, 3);
    assert.equal(trainPoll.bundle_acked, 3);
    assert.equal(received.length, 3);
    assert.equal(received.some(m => m.body === longBody), true);
    assert.equal(received.some(m => m.body === cqBody), true);
    const attMsg = received.find(m => m.body === "short with attachment");
    assert.equal(attMsg.staged_files.length, 1);
    assert.equal(attMsg.staged_files[0].name, "report.txt");

    // 收发两端 spool 均已彻底释放
    assertSpoolEmpty(bus, MACHINE_TRAIN);
    assertSpoolEmpty(bus, MACHINE_DEV);

    // (d) 无文件包通道（不含 sendBundle 方法的传输层）
    const textOnlyTransport = {
      sendFrame: (params, ctx) => devTransport.sendFrame(params, ctx),
      poll: (params, ctx) => devTransport.poll(params, ctx),
      readEvents: (params, ctx) => devTransport.readEvents(params, ctx),
    };
    const devTextOnly = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: textOnlyTransport,
      frameCodec: relayEnvelope,
    });
    t.after(() => devTextOnly.close());

    await assert.rejects(
      () => devTextOnly.dispatchMessage({
        dedupeKey: "no-bundle-long",
        targetMachine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: longBody,
      }),
      err => err instanceof CoreError && err.code === "relay_frame_too_large",
    );
    await assert.rejects(
      () => devTextOnly.dispatchMessage({
        dedupeKey: "no-bundle-cq",
        targetMachine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: cqBody,
      }),
      err => err instanceof CoreError && err.code === "relay_frame_too_large",
    );
    await assert.rejects(
      () => devTextOnly.dispatchMessage({
        dedupeKey: "no-bundle-att",
        targetMachine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: "with att",
        attachments: [{ name: "a.bin", filePath: "/synthetic/attachments/a.bin" }],
      }),
      err => err instanceof CoreError && err.code === "bundle_transport_unavailable",
    );

    // (e) NapcatRelayTransport bundleEnabled: false 时同样抛出小写 bundle_transport_unavailable
    const disabledBundleTransport = bus.createTransportFor(MACHINE_DEV, { bundleEnabled: false });
    const devBundleDisabled = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: disabledBundleTransport,
      frameCodec: relayEnvelope,
    });
    t.after(async () => {
      await devBundleDisabled.close();
      await disabledBundleTransport.close();
    });
    await assert.rejects(
      () => devBundleDisabled.dispatchMessage({
        dedupeKey: "disabled-bundle-att",
        targetMachine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: "with att disabled",
        attachments: [{ name: "b.bin", filePath: "/synthetic/attachments/b.bin" }],
      }),
      err => err instanceof CoreError && err.code === "bundle_transport_unavailable",
    );
  });

  it("processing_ack 偏序保护（done 后迟到 processing 返回 stale_processing_ack 不回退）与伪造机拦截（ack_pairing_mismatch）", async t => {
    const { devTransport } = createTwoMachineBus(t);
    const dev = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: devTransport,
      frameCodec: relayEnvelope,
    });
    t.after(() => dev.close());

    // 先验证纯函数偏序语义
    assert.equal(shouldAcceptProcessingUpdate({ processing: "pending", ack_seq: 0 }, { processing: "processing", ack_seq: 1 }), true);
    assert.equal(shouldAcceptProcessingUpdate({ processing: "processing", ack_seq: 1 }, { processing: "processing", ack_seq: 2 }), true);
    assert.equal(shouldAcceptProcessingUpdate({ processing: "processing", ack_seq: 2 }, { processing: "processing", ack_seq: 2 }), false);
    assert.equal(shouldAcceptProcessingUpdate({ processing: "done", ack_seq: 2 }, { processing: "processing", ack_seq: 3 }), false);

    // 消息 1：推进到 done 后投递迟到 processing
    const sent1 = await dev.dispatchMessage({
      dedupeKey: "order-msg-1",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "order check",
    });

    const okDone = await dev.handleInboundEvent({
      event_id: "evt_ack_done_1",
      relay_key: sent1.stages.relay_accepted.relay_key,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_ack_done_1",
        op: "processing_ack",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-train-1",
        recipients: ["antigravity/desktop/conv-dev-1"],
        in_reply_to: sent1.relay_id,
        body: "",
        meta: {
          hop_count: 1,
          origin_relay_id: sent1.relay_id,
          origin_message_id: sent1.request_id,
          processing: "done",
          ack_seq: 2,
          note: "final",
        },
      },
    });
    assert.equal(okDone.handled, true);
    assert.equal(dev.getOutboundStatus(sent1.request_id).stages.target_processing.status, "done");

    const stale = await dev.handleInboundEvent({
      event_id: "evt_ack_stale_1",
      relay_key: sent1.stages.relay_accepted.relay_key,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_ack_stale_1",
        op: "processing_ack",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-train-1",
        recipients: ["antigravity/desktop/conv-dev-1"],
        in_reply_to: sent1.relay_id,
        body: "",
        meta: {
          hop_count: 1,
          origin_relay_id: sent1.relay_id,
          origin_message_id: sent1.request_id,
          processing: "processing",
          ack_seq: 1,
          note: "late",
        },
      },
    });
    assert.equal(stale.handled, false);
    assert.equal(stale.status, "ignored");
    assert.equal(stale.code, "stale_processing_ack");
    assert.equal(dev.getOutboundStatus(sent1.request_id).stages.target_processing.status, "done");

    // 消息 2：非原目标机伪造 processing_ack 返回 ack_pairing_mismatch
    const sent2 = await dev.dispatchMessage({
      dedupeKey: "order-msg-2",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "pairing check",
    });

    const forgedMachine = await dev.handleInboundEvent({
      event_id: "evt_ack_forged_machine",
      relay_key: sent2.stages.relay_accepted.relay_key,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_PEER,
      sender_verified: true,
      frame: {
        relay_id: "rly_ack_forged_1",
        op: "processing_ack",
        from_machine: MACHINE_PEER,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-peer-1",
        recipients: ["antigravity/desktop/conv-dev-1"],
        in_reply_to: sent2.relay_id,
        body: "",
        meta: {
          hop_count: 1,
          origin_relay_id: sent2.relay_id,
          origin_message_id: sent2.request_id,
          processing: "processing",
          ack_seq: 1,
        },
      },
    });
    assert.equal(forgedMachine.handled, false);
    assert.equal(forgedMachine.status, "rejected");
    assert.equal(forgedMachine.code, "ack_pairing_mismatch");
    assert.equal(dev.getOutboundStatus(sent2.request_id).stages.target_processing.status, "pending");

    // 同一目标机但错 relay_key 同样返回 ack_pairing_mismatch
    const sent3 = await dev.dispatchMessage({
      dedupeKey: "order-msg-3",
      targetMachine: MACHINE_TRAIN,
      source: "antigravity/desktop/conv-dev-1",
      recipients: ["codex/desktop/conv-train-1"],
      body: "relay key mismatch check",
    });
    const forgedRelayKey = await dev.handleInboundEvent({
      event_id: "evt_ack_forged_key",
      relay_key: "relay-rogue-route",
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_ack_forged_key",
        op: "processing_ack",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-train-1",
        recipients: ["antigravity/desktop/conv-dev-1"],
        in_reply_to: sent3.relay_id,
        body: "",
        meta: {
          hop_count: 1,
          origin_relay_id: sent3.relay_id,
          origin_message_id: sent3.request_id,
          processing: "done",
          ack_seq: 1,
        },
      },
    });
    assert.equal(forgedRelayKey.handled, false);
    assert.equal(forgedRelayKey.status, "rejected");
    assert.equal(forgedRelayKey.code, "ack_pairing_mismatch");
  });

  it("双层 source_identity_verified：通配符/系统端点/假标志/缺验明为 false，完整三段+验明发送机+meta===true 为 true", async t => {
    const { trainTransport } = createTwoMachineBus(t);
    const seen = [];

    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        deliverInboundMessage: msg => {
          seen.push(msg);
          return {
            local_message_id: `local-siv-${seen.length}`,
            target_key: makeTargetKey(MACHINE_TRAIN, "codex", "desktop", "conv-train-1"),
            delivery_status: "accepted",
          };
        },
      },
    });
    t.after(() => train.close());

    const makeEvent = (id, { source, sourceMachine = MACHINE_DEV, senderVerified = true, metaFlag = true }) => ({
      event_id: `evt_siv_${id}`,
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      ...(sourceMachine !== null ? { source_machine: sourceMachine } : {}),
      sender_verified: senderVerified,
      frame: {
        relay_id: `rly_siv_${id}`,
        op: "message",
        from_machine: MACHINE_DEV,
        to_machine: MACHINE_TRAIN,
        source,
        recipients: ["codex/desktop/conv-train-1"],
        body: `case-${id}`,
        meta: { hop_count: 1, request_id: `req_siv_${id}`, source_identity_verified: metaFlag },
      },
    });

    // 1. 通配符 source（antigravity/desktop/*）-> source_identity_verified 必须为 false
    const wildcardSeen = [];
    const wildcardTrain = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: {
        async sendFrame() {
          return { ok: true, status: "sent_verified", relay_id: "rly_wc_ack" };
        },
      },
      localHandlers: {
        deliverInboundMessage: msg => {
          wildcardSeen.push(msg);
          return { deliveries: [] };
        },
      },
    });
    t.after(() => wildcardTrain.close());

    const c1 = await wildcardTrain.handleInboundEvent(makeEvent("wildcard", { source: "antigravity/desktop/*", metaFlag: true }));
    assert.equal(c1.handled, true);
    assert.equal(c1.source_identity_verified, false);
    assert.equal(wildcardSeen.length, 1);
    assert.equal(wildcardSeen[0].source_identity_verified, false);

    // 2. 系统端点 source -> false
    const c2 = await train.handleInboundEvent(makeEvent("system", { source: "core/system/dispatcher", metaFlag: true }));
    assert.equal(c2.handled, true);
    assert.equal(c2.source_identity_verified, false);
    assert.equal(seen.at(-1).source_identity_verified, false);

    // 3. 假标志（false 及非布尔 "true"）-> false
    const c3a = await train.handleInboundEvent(makeEvent("false-flag", { source: "antigravity/desktop/conv-dev-1", metaFlag: false }));
    assert.equal(c3a.source_identity_verified, false);
    const c3b = await train.handleInboundEvent(makeEvent("str-flag", { source: "antigravity/desktop/conv-dev-1", metaFlag: "true" }));
    assert.equal(c3b.source_identity_verified, false);

    // 4. 缺少 event.source_machine（未验明发送机）-> false
    const c4 = await train.handleInboundEvent(makeEvent("no-src-machine", {
      source: "antigravity/desktop/conv-dev-1",
      sourceMachine: null,
      metaFlag: true,
    }));
    assert.equal(c4.handled, true);
    assert.equal(c4.source_identity_verified, false);

    // 5. sender_verified: false 直接拒收
    const c5 = await train.handleInboundEvent(makeEvent("unverified-sender", {
      source: "antigravity/desktop/conv-dev-1",
      senderVerified: false,
      metaFlag: true,
    }));
    assert.equal(c5.handled, false);
    assert.equal(c5.code, "sender_unverified");

    // 6. 完整三段 + 验明发送机 + meta.source_identity_verified === true -> true
    const c6 = await train.handleInboundEvent(makeEvent("verified", {
      source: "antigravity/desktop/conv-dev-1",
      sourceMachine: MACHINE_DEV,
      senderVerified: true,
      metaFlag: true,
    }));
    assert.equal(c6.handled, true);
    assert.equal(c6.source_identity_verified, true);
    assert.equal(seen.at(-1).source_identity_verified, true);
  });
});

/* ============================================================================
 * 5. 对称跨机查询 & createRemoteMachineProviders & 安全边界
 * ========================================================================== */

describe("对称跨机查询、createRemoteMachineProviders 与安全边界", () => {
  it("queryStatus：成功获取、缓存 last_observed，对端超时降级返回 host_online:'unknown' + code:'remote_timeout' + last_observed", async t => {
    const { devTransport, trainTransport } = createTwoMachineBus(t);

    const dev = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: devTransport,
      frameCodec: relayEnvelope,
    });
    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        queryLocalStatus: ({ scope, target }) => ({
          scope,
          target,
          host_online: true,
          conversation_exists: true,
          conversation_running: false,
          can_deliver: true,
          transport_ready: true,
          control_enabled: true,
          control_ready: true,
        }),
      },
    });
    t.after(async () => {
      await dev.close();
      await train.close();
    });

    const queryTarget = { host: "codex", surface: "desktop", conversation_id: "conv-train-1" };
    const p1 = dev.queryStatus({ targetMachine: MACHINE_TRAIN, scope: "conversation", target: queryTarget, timeoutMs: 2_000 });
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const okStatus = await p1;

    assert.equal(okStatus.source, "remote_core_relay");
    assert.equal(okStatus.host_online, true);
    assert.equal(okStatus.conversation_exists, true);
    assert.equal(okStatus.conversation_running, false);
    assert.equal(okStatus.target.machine_id, MACHINE_TRAIN);

    // 对端不再轮询响应，再次查询超时并附带上次缓存的 last_observed
    const timedOut = await dev.queryStatus({
      targetMachine: MACHINE_TRAIN,
      scope: "conversation",
      target: queryTarget,
      timeoutMs: 35,
    });
    assert.equal(timedOut.host_online, "unknown");
    assert.equal(timedOut.code, "remote_timeout");
    assert.equal(timedOut.last_observed.host_online, true);
    assert.equal(timedOut.last_observed.conversation_exists, true);
  });

  it("queryDirectory：签名游标翻页、跨机盗用游标报 relay_cursor_scope_mismatch、group_visibility_policy ('redacted' | 'none')", async t => {
    const { devTransport, trainTransport, peerTransport } = createTwoMachineBus(t, { withThirdPeer: true });

    const allItems = [
      { conversation_id: "conv-train-1", title: "Sensitive Alpha", participants: ["u1", "u2"], group_members: ["g1"] },
      { conversation_id: "conv-train-2", title: "Sensitive Beta", participants: ["u3"], group_members: ["g2"] },
      { conversation_id: "conv-train-3", title: "Sensitive Gamma", participants: ["u4"], group_members: ["g3"] },
    ];

    const trainPolicy = {
      defaults: { allow_directory: true, group_visibility_policy: "full" },
      peers: {
        [MACHINE_DEV]: { group_visibility_policy: "full" },
        [MACHINE_PEER]: { group_visibility_policy: "redacted" },
      },
    };

    const dev = new RemoteCoreDispatcher({ localMachineId: MACHINE_DEV, transport: devTransport, frameCodec: relayEnvelope });
    const peer = new RemoteCoreDispatcher({ localMachineId: MACHINE_PEER, transport: peerTransport, frameCodec: relayEnvelope });
    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      signDirectoryCursor: true,
      policy: trainPolicy,
      localHandlers: {
        queryLocalDirectory: ({ limit = 2, cursor }) => {
          const offset = cursor ? Number(cursor) : 0;
          const slice = allItems.slice(offset, offset + limit);
          const next = offset + limit < allItems.length ? String(offset + limit) : null;
          return { conversations: slice, next_cursor: next };
        },
      },
    });
    t.after(async () => {
      await dev.close();
      await peer.close();
      await train.close();
    });

    // 第 1 页
    const pPage1 = dev.queryDirectory({ targetMachine: MACHINE_TRAIN, host: "codex", surface: "desktop", limit: 2, timeoutMs: 2_000 });
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const page1 = await pPage1;
    assert.equal(page1.conversations.length, 2);
    assert.equal(page1.conversations[0].title, "Sensitive Alpha");
    assert.ok(typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);

    // 第 2 页（使用原签名游标）
    const pPage2 = dev.queryDirectory({
      targetMachine: MACHINE_TRAIN,
      host: "codex",
      surface: "desktop",
      limit: 2,
      cursor: page1.next_cursor,
      timeoutMs: 2_000,
    });
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const page2 = await pPage2;
    assert.equal(page2.conversations.length, 1);
    assert.equal(page2.conversations[0].conversation_id, "conv-train-3");
    assert.equal(page2.next_cursor, null);

    // 第三台机器 peer 盗用发给 dev 的游标 -> relay_cursor_scope_mismatch
    const pStolen = peer.queryDirectory({
      targetMachine: MACHINE_TRAIN,
      host: "codex",
      surface: "desktop",
      cursor: page1.next_cursor,
      timeoutMs: 2_000,
    });
    const stolenCheck = assert.rejects(
      () => pStolen,
      err => err instanceof CoreError && err.code === "relay_cursor_scope_mismatch",
    );
    await nextTurn();
    await train.pollOnce();
    await peer.pollOnce();
    await stolenCheck;

    // peer 处于 group_visibility_policy: "redacted" -> title/participants/group_members 移除并标 redacted: true
    const pRedacted = peer.queryDirectory({ targetMachine: MACHINE_TRAIN, host: "codex", surface: "desktop", limit: 2, timeoutMs: 2_000 });
    await nextTurn();
    await train.pollOnce();
    await peer.pollOnce();
    const redactedDir = await pRedacted;
    assert.equal(redactedDir.conversations.length, 2);
    assert.equal(redactedDir.conversations[0].redacted, true);
    assert.equal("title" in redactedDir.conversations[0], false);
    assert.equal("participants" in redactedDir.conversations[0], false);
    assert.equal("group_members" in redactedDir.conversations[0], false);

    // 篡改游标签名 -> relay_cursor_invalid
    const tamperedCursor = Buffer.from(JSON.stringify({
      owner_machine: MACHINE_DEV,
      cursor: "2",
      sig: "0000000000000000",
    }), "utf8").toString("base64url");
    const pTampered = dev.queryDirectory({
      targetMachine: MACHINE_TRAIN,
      host: "codex",
      surface: "desktop",
      cursor: tamperedCursor,
      timeoutMs: 2_000,
    });
    const tamperedCheck = assert.rejects(
      () => pTampered,
      err => err instanceof CoreError && err.code === "relay_cursor_invalid",
    );
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    await tamperedCheck;

    // 切换 group_visibility_policy: "none" -> 返回空数组
    trainPolicy.peers[MACHINE_PEER].group_visibility_policy = "none";
    const pNone = peer.queryDirectory({ targetMachine: MACHINE_TRAIN, host: "codex", surface: "desktop", limit: 2, timeoutMs: 2_000 });
    await nextTurn();
    await train.pollOnce();
    await peer.pollOnce();
    const noneDir = await pNone;
    assert.deepEqual(noneDir.conversations, []);
    assert.deepEqual(noneDir.items, []);
  });

  it("querySnapshot：禁用文件包按 max_chars 优雅裁剪（truncated/omitted），启用文件包完整回传并释放 spool", async t => {
    const { bus, devTransport, trainTransport } = createTwoMachineBus(t);
    const hugeText = `HEAD-${"S".repeat(2400)}-TAIL`;

    // 场景 A：禁用文件包（allow_file_bundle: false）按 max_chars 优雅裁剪
    const devA = new RemoteCoreDispatcher({ localMachineId: MACHINE_DEV, transport: devTransport, frameCodec: relayEnvelope });
    const trainA = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      policy: { defaults: { allow_file_bundle: false } },
      localHandlers: {
        queryLocalSnapshot: () => ({ text: hugeText }),
      },
    });
    t.after(async () => {
      await devA.close();
      await trainA.close();
    });

    const pTrunc = devA.querySnapshot({
      targetMachine: MACHINE_TRAIN,
      target: { host: "codex", surface: "desktop", conversation_id: "conv-train-1" },
      max_chars: 120,
      timeoutMs: 2_000,
    });
    await nextTurn();
    await trainA.pollOnce();
    await devA.pollOnce();
    const truncSnap = await pTrunc;

    assert.equal(truncSnap.ok, true);
    assert.equal(truncSnap.truncated, true);
    assert.equal(truncSnap.omitted, true);
    assert.equal(truncSnap.original_chars, hugeText.length);
    assert.ok(truncSnap.returned_chars <= 120);
    assert.equal(truncSnap.snapshot.text.length, truncSnap.returned_chars);
    assert.equal(truncSnap.snapshot.text, hugeText.slice(0, truncSnap.returned_chars));

    // 场景 B：启用文件包，不设 max_chars，自动走 bundle 完整回传超长快照并释放 spool
    const { bus: busB, devTransport: devTB, trainTransport: trainTB } = createTwoMachineBus(t);
    const devB = new RemoteCoreDispatcher({ localMachineId: MACHINE_DEV, transport: devTB, frameCodec: relayEnvelope });
    const trainB = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTB,
      frameCodec: relayEnvelope,
      policy: { defaults: { allow_file_bundle: true } },
      localHandlers: {
        queryLocalSnapshot: () => ({
          conversation_id: "conv-train-1",
          status: "idle",
          rounds: [{ messages: [{ role: "assistant", text: hugeText }] }],
        }),
      },
    });
    t.after(async () => {
      await devB.close();
      await trainB.close();
    });

    const pFull = devB.querySnapshot({
      targetMachine: MACHINE_TRAIN,
      target: { host: "codex", surface: "desktop", conversation_id: "conv-train-1" },
      timeoutMs: 2_000,
    });
    await nextTurn();
    await trainB.pollOnce();
    const devPollB = await devB.pollOnce();
    const fullSnap = await pFull;

    assert.equal(devPollB.bundle_acked, 1);
    assert.equal(fullSnap.ok, true);
    assert.equal(fullSnap.truncated, false);
    assert.equal(fullSnap.omitted, false);
    assert.equal(fullSnap.snapshot.rounds[0].messages[0].text, hugeText);
    assertSpoolEmpty(busB, MACHINE_DEV);
    assertSpoolEmpty(busB, MACHINE_TRAIN);
    assertSpoolEmpty(bus, MACHINE_DEV);
  });

  it("createRemoteMachineProviders 输出 Map<machineId, Map<host, provider>> 并满足 getHostStatus/describeConversation/list/readRecent", async t => {
    const { devTransport, trainTransport } = createTwoMachineBus(t);
    let statusQueryCalls = 0;

    const dev = new RemoteCoreDispatcher({ localMachineId: MACHINE_DEV, transport: devTransport, frameCodec: relayEnvelope });
    const train = new RemoteCoreDispatcher({
      localMachineId: MACHINE_TRAIN,
      transport: trainTransport,
      frameCodec: relayEnvelope,
      localHandlers: {
        queryLocalStatus: ({ target }) => {
          statusQueryCalls += 1;
          return {
            target,
            host_online: true,
            transport_ready: true,
            control_enabled: true,
            control_ready: true,
            conversation_exists: true,
            conversation_running: true,
            can_accept_direct_input: true,
          };
        },
        queryLocalDirectory: () => ({
          conversations: [{ conversation_id: "conv-train-1", title: "Synthetic Thread" }],
          next_cursor: null,
        }),
        queryLocalSnapshot: ({ target }) => ({
          conversation_id: target.conversation_id,
          status: "running",
          rounds: [{ messages: [{ role: "user", text: "ping" }, { role: "assistant", text: "pong" }] }],
        }),
      },
    });
    t.after(async () => {
      await dev.close();
      await train.close();
    });

    const machineProviders = createRemoteMachineProviders(dev, [MACHINE_TRAIN], ["antigravity", "codex"], { timeoutMs: 2_000 });
    assert.equal(machineProviders instanceof Map, true);
    assert.equal(machineProviders.get(MACHINE_TRAIN) instanceof Map, true);

    const codexProvider = machineProviders.get(MACHINE_TRAIN).get("codex");
    assert.equal(codexProvider.source, "remote_core_relay");
    assert.equal(codexProvider.machine_id, MACHINE_TRAIN);
    assert.equal(codexProvider.host, "codex");

    // 并发调用 getHostStatus 与 describeConversation 命中同目标去重（只发 1 次 status_query）
    const target = { surface: "desktop", conversation_id: "conv-train-1" };
    const pHost = codexProvider.getHostStatus(target);
    const pDesc = codexProvider.describeConversation(target);
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const [hostStatus, convDesc] = await Promise.all([pHost, pDesc]);

    assert.equal(statusQueryCalls, 1);
    assert.equal(hostStatus.host_online, true);
    assert.equal(hostStatus.transport_ready, true);
    assert.equal(hostStatus.control_ready, true);
    assert.equal(convDesc.conversation_exists, true);
    assert.equal(convDesc.conversation_running, true);
    assert.equal(convDesc.can_accept_direct_input, true);

    // list
    const pList = codexProvider.list({ host: "codex", surface: "desktop" }, { limit: 10 });
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const listed = await pList;
    assert.equal(listed.conversations.length, 1);
    assert.equal(listed.conversations[0].conversation_id, "conv-train-1");
    assert.equal(listed.next_cursor, null);

    // readRecent
    const pRecent = codexProvider.readRecent({ host: "codex", surface: "desktop", conversation_id: "conv-train-1" }, { lastRounds: 2 });
    await nextTurn();
    await train.pollOnce();
    await dev.pollOnce();
    const recent = await pRecent;
    assert.equal(recent.conversation_id, "conv-train-1");
    assert.equal(recent.rounds.length, 1);
    assert.equal(recent.rounds[0].messages[1].text, "pong");
  });

  it("安全边界（防环/自回声/来源机不匹配/三元配对拦截）与 registerOpHandler('board_delta') / unsupported_op", async t => {
    const { devTransport, trainTransport } = createTwoMachineBus(t);
    const sentAtDev = [];
    const spyingDevTransport = {
      async sendFrame(params, ctx) {
        sentAtDev.push(params);
        return devTransport.sendFrame(params, ctx);
      },
      poll: (params, ctx) => devTransport.poll(params, ctx),
      readEvents: (params, ctx) => devTransport.readEvents(params, ctx),
      sendBundle: (params, ctx) => devTransport.sendBundle(params, ctx),
      pollBundles: (params, ctx) => devTransport.pollBundles(params, ctx),
      readBundleEvents: (params, ctx) => devTransport.readBundleEvents(params, ctx),
      ackBundleEvents: (params, ctx) => devTransport.ackBundleEvents(params, ctx),
    };

    const dev = new RemoteCoreDispatcher({ localMachineId: MACHINE_DEV, transport: spyingDevTransport, frameCodec: relayEnvelope });
    const train = new RemoteCoreDispatcher({ localMachineId: MACHINE_TRAIN, transport: trainTransport, frameCodec: relayEnvelope });
    t.after(async () => {
      await dev.close();
      await train.close();
    });

    // 1. 防环 hop_count > 1
    const hopRes = await train.handleInboundEvent({
      event_id: "evt_hop_2",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_DEV,
      sender_verified: true,
      frame: {
        relay_id: "rly_hop_2",
        op: "message",
        from_machine: MACHINE_DEV,
        to_machine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: "looped",
        meta: { hop_count: 2 },
      },
    });
    assert.equal(hopRes.handled, false);
    assert.equal(hopRes.status, "rejected");
    assert.equal(hopRes.code, "hop_limit_exceeded");

    // 2. 自回声丢弃
    const echoRes = await train.handleInboundEvent({
      event_id: "evt_self_echo",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_self_echo",
        op: "message",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-train-1",
        recipients: ["antigravity/desktop/conv-dev-1"],
        body: "echo",
        meta: { hop_count: 1 },
      },
    });
    assert.equal(echoRes.handled, false);
    assert.equal(echoRes.status, "ignored");
    assert.equal(echoRes.code, "self_echo");

    // 3. 来源机不匹配
    const mismatchSrc = await train.handleInboundEvent({
      event_id: "evt_src_mismatch",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_PEER,
      sender_verified: true,
      frame: {
        relay_id: "rly_src_mismatch",
        op: "message",
        from_machine: MACHINE_DEV,
        to_machine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["codex/desktop/conv-train-1"],
        body: "spoofed",
        meta: { hop_count: 1 },
      },
    });
    assert.equal(mismatchSrc.handled, false);
    assert.equal(mismatchSrc.status, "rejected");
    assert.equal(mismatchSrc.code, "source_machine_mismatch");

    // 4. 请求三元配对拦截 (request_id, expectedTargetMachine, relay_key) + expectedOp
    const pStatus = dev.queryStatus({ targetMachine: MACHINE_TRAIN, scope: "host", timeoutMs: 2_000 });
    await nextTurn();
    const outboundQuery = sentAtDev.find(f => f.op === "status_query");
    const reqId = outboundQuery.meta.request_id;

    // 4a. 伪造来源机器
    const badMachineReply = await dev.handleInboundEvent({
      event_id: "evt_pair_bad_machine",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_PEER,
      sender_verified: true,
      frame: {
        relay_id: "rly_pair_bad_machine",
        op: "status_reply",
        from_machine: MACHINE_PEER,
        to_machine: MACHINE_DEV,
        source: "core/system/dispatcher",
        recipients: ["core/system/dispatcher"],
        body: JSON.stringify({ ok: true, status: { host_online: true } }),
        meta: { hop_count: 1, in_reply_to_request_id: reqId, ok: true },
      },
    });
    assert.equal(badMachineReply.status, "rejected");
    assert.equal(badMachineReply.code, "request_pairing_mismatch");

    // 4b. 错 relay_key
    const badKeyReply = await dev.handleInboundEvent({
      event_id: "evt_pair_bad_key",
      relay_key: "relay-wrong-key",
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_pair_bad_key",
        op: "status_reply",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "core/system/dispatcher",
        recipients: ["core/system/dispatcher"],
        body: JSON.stringify({ ok: true, status: { host_online: true } }),
        meta: { hop_count: 1, in_reply_to_request_id: reqId, ok: true },
      },
    });
    assert.equal(badKeyReply.status, "rejected");
    assert.equal(badKeyReply.code, "request_pairing_mismatch");

    // 4c. 错 op（list_reply 回复 status_query）
    const badOpReply = await dev.handleInboundEvent({
      event_id: "evt_pair_bad_op",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_pair_bad_op",
        op: "list_reply",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "core/system/dispatcher",
        recipients: ["core/system/dispatcher"],
        body: JSON.stringify({ ok: true, items: [] }),
        meta: { hop_count: 1, in_reply_to_request_id: reqId, ok: true },
      },
    });
    assert.equal(badOpReply.status, "rejected");
    assert.equal(badOpReply.code, "request_pairing_mismatch");

    // 4d. 合法匹配三元组的回复仍可正常唤醒原请求
    const goodReply = await dev.handleInboundEvent({
      event_id: "evt_pair_good",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_TRAIN,
      sender_verified: true,
      frame: {
        relay_id: "rly_pair_good",
        op: "status_reply",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "core/system/dispatcher",
        recipients: ["core/system/dispatcher"],
        body: JSON.stringify({ ok: true, status: { host_online: true } }),
        meta: { hop_count: 1, in_reply_to_request_id: reqId, ok: true },
      },
    });
    assert.equal(goodReply.handled, true);
    const resolvedStatus = await pStatus;
    assert.equal(resolvedStatus.host_online, true);

    // 5. 第二波扩展口 registerOpHandler("board_delta", ...) 与未注册 op -> unsupported_op
    const boardReceived = [];
    const unregister = train.registerOpHandler("board_delta", async ctx => {
      boardReceived.push({ op: ctx.frame.op, from: ctx.remotePrincipal.from_machine, body: ctx.frame.body });
      await ctx.reply({ op: "board_ack", meta: { revision: 7 } });
      return { applied_revision: 7 };
    });

    const boardRes = await train.handleInboundEvent({
      event_id: "evt_board_delta_1",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_DEV,
      sender_verified: true,
      frame: {
        relay_id: "rly_board_delta_1",
        op: "board_delta",
        from_machine: MACHINE_DEV,
        to_machine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["core/system/dispatcher"],
        body: "{\"patch\":1}",
        meta: { hop_count: 1, board_id: "board-1" },
      },
    });
    assert.equal(boardRes.handled, true);
    assert.deepEqual(boardRes.result, { applied_revision: 7 });
    assert.equal(boardReceived.length, 1);
    assert.equal(boardReceived[0].from, MACHINE_DEV);

    // 验证 dev 端收到原路发回的 board_ack，若 dev 未注册 board_ack 则报 unsupported_op
    const devBoardPoll = await dev.pollOnce();
    assert.equal(devBoardPoll.rejected.length, 1);
    assert.equal(devBoardPoll.rejected[0].code, "unsupported_op");
    assert.equal(devBoardPoll.rejected[0].op, "board_ack");

    // 注销后再次投递 board_delta 或未注册 board_dissolved 均返回 unsupported_op
    unregister();
    const unregRes = await train.handleInboundEvent({
      event_id: "evt_board_dissolved_1",
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      route_generation: 1,
      source_machine: MACHINE_DEV,
      sender_verified: true,
      frame: {
        relay_id: "rly_board_dissolved_1",
        op: "board_dissolved",
        from_machine: MACHINE_DEV,
        to_machine: MACHINE_TRAIN,
        source: "antigravity/desktop/conv-dev-1",
        recipients: ["core/system/dispatcher"],
        body: "",
        meta: { hop_count: 1 },
      },
    });
    assert.equal(unregRes.handled, false);
    assert.equal(unregRes.status, "rejected");
    assert.equal(unregRes.code, "unsupported_op");
  });
});

/* ============================================================================
 * 6. 确定性清理与句柄归零（Node 24 process.getActiveResourcesInfo）
 * ========================================================================== */

describe("确定性清理与 Node 24 活跃句柄归零", () => {
  it("startPolling + 在途查询期间调用 close()，挂起请求以 dispatcher_closed 干净结束且活跃句柄增量为 0", async () => {
    await nextTurn();
    const beforeList = process.getActiveResourcesInfo();
    const beforeCounts = countResources(beforeList);

    const bus = new InMemoryRelayBus({ frameCodec: createBusFrameCodec() });
    bus.registerMachine({ machine_id: MACHINE_DEV, qq_id: "qq-dev-10001", bundle_enabled: true });
    bus.registerMachine({ machine_id: MACHINE_TRAIN, qq_id: "qq-train-10002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: RELAY_DEV_TRAIN,
      group_id: GROUP_DEV_TRAIN,
      channel: "qq",
      members: [MACHINE_DEV, MACHINE_TRAIN],
      generation: 1,
      role: "active_write",
      enabled: true,
    });

    const transport = bus.createTransportFor(MACHINE_DEV);
    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport,
      frameCodec: relayEnvelope,
      limits: { pollIntervalMs: 25, idlePollIntervalMs: 40, queryTimeoutMs: 10_000 },
    });

    dispatcher.startPolling(25);
    assert.equal(dispatcher.getMetrics().polling, true);
    assert.equal(dispatcher.getMetrics().has_poll_timer, true);

    const pStatus = dispatcher.queryStatus({
      targetMachine: MACHINE_TRAIN,
      scope: "conversation",
      target: { host: "codex", surface: "desktop", conversation_id: "conv-train-1" },
      timeoutMs: 10_000,
    });
    const pDir = dispatcher.queryDirectory({
      targetMachine: MACHINE_TRAIN,
      host: "codex",
      surface: "desktop",
      timeoutMs: 10_000,
    });
    const pSnap = dispatcher.querySnapshot({
      targetMachine: MACHINE_TRAIN,
      target: { host: "codex", surface: "desktop", conversation_id: "conv-train-1" },
      timeoutMs: 10_000,
    });

    // 预先挂上拒绝断言，确保 close() 中途触发时不产生未处理 rejection
    const dirRejected = assert.rejects(
      () => pDir,
      err => err instanceof CoreError && err.code === "dispatcher_closed",
    );
    const snapRejected = assert.rejects(
      () => pSnap,
      err => err instanceof CoreError && err.code === "dispatcher_closed",
    );

    await nextTurn();
    assert.equal(dispatcher.getMetrics().pending_requests, 3);

    await dispatcher.close();
    await transport.close();

    const [statusOnClose] = await Promise.all([pStatus, dirRejected, snapRejected]);
    assert.equal(statusOnClose.host_online, "unknown");
    assert.equal(statusOnClose.code, "dispatcher_closed");

    // 关闭后所有入口均以 dispatcher_closed 干净拒绝
    await assert.rejects(
      () => dispatcher.queryDirectory({ targetMachine: MACHINE_TRAIN, host: "codex" }),
      err => err instanceof CoreError && err.code === "dispatcher_closed",
    );
    await assert.rejects(
      () => dispatcher.pollOnce(),
      err => err instanceof CoreError && err.code === "dispatcher_closed",
    );

    const metrics = dispatcher.getMetrics();
    assert.equal(metrics.closed, true);
    assert.equal(metrics.polling, false);
    assert.equal(metrics.has_poll_timer, false);
    assert.equal(metrics.pending_requests, 0);
    assert.deepEqual(transport.getActiveHandleCounts(), { timers: 0, controllers: 0, connections: 0, closing: 0 });

    await nextTurn();
    const afterList = process.getActiveResourcesInfo();
    const afterCounts = countResources(afterList);

    assert.equal(afterList.length - beforeList.length, 0, `活跃句柄应归零: before=${JSON.stringify(beforeList)}, after=${JSON.stringify(afterList)}`);
    for (const [kind, count] of afterCounts.entries()) {
      assert.equal(count - (beforeCounts.get(kind) ?? 0), 0, `资源类型 ${kind} 存在泄漏`);
    }
  });
});

describe("Wave 2 §0: dispatchCustomOp, opHandlers identity/retain_bundle, bundle control frame ignore, and pollOnce poison isolation", () => {
  it("dispatchCustomOp enforces board op whitelist, 429 backoff, CQ budget auto-upgrade to sendBundle, and rejects system source_identity_verified", async () => {
    let nowMs = 2_000_000;
    const sentFrames = [];
    const sentBundles = [];
    const transport = {
      async sendFrame(req) {
        sentFrames.push(req);
        return { ok: true, status: "sent_verified", relay_id: "rly_custom_1", relay_key: "r-main", group_id: "900", route_generation: 1 };
      },
      async sendBundle(req) {
        sentBundles.push(req);
        return { ok: true, status: "announced", bundle_id: "bnd_custom_1", relay_key: "r-main", group_id: "900", route_generation: 1 };
      },
    };
    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport,
      localHandlers: {},
      now: () => nowMs,
    });

    // Rejects non-board op
    await assert.rejects(
      () => dispatcher.dispatchCustomOp({ op: "message", dedupeKey: "dk-bad", targetMachine: MACHINE_TRAIN }),
      err => err instanceof CoreError && err.code === "invalid_input",
    );

    // Small payload goes via sendFrame and core/system/* never sets source_identity_verified=true
    // Also verify replyRoute translates to reply_relay_key / reply_group_id / reply_route_generation
    const smallRes = await dispatcher.dispatchCustomOp({
      op: "board_dissolved",
      dedupeKey: "dk-dissolve-1",
      targetMachine: MACHINE_TRAIN,
      source: "core/system/board_sync",
      sourceIdentityVerified: true,
      payloadJson: { board_id: "b-1", state_version: 2 },
      replyRoute: { relay_key: "r-orig", group_id: "900", route_generation: 2 },
      allowBundle: false,
    });
    assert.equal(smallRes.ok, true);
    assert.equal(smallRes.transport_mode, "text_relay");
    assert.equal(sentFrames.length, 1);
    assert.equal(sentFrames[0].meta.source_identity_verified, undefined);
    assert.equal(sentFrames[0].reply_relay_key, "r-orig");
    assert.equal(sentFrames[0].reply_group_id, "900");
    assert.equal(sentFrames[0].reply_route_generation, 2);
    assert.equal("relay_key" in sentFrames[0], false);

    // Oversized payload auto-upgrades to sendBundle when allowBundle=true
    const bigRes = await dispatcher.dispatchCustomOp({
      op: "board_delta",
      dedupeKey: "dk-delta-big",
      targetMachine: MACHINE_TRAIN,
      source: "codex/desktop/conv-remote-actor",
      sourceIdentityVerified: true,
      payloadJson: { board_id: "b-1", bulk: "x".repeat(3000) },
      allowBundle: true,
    });
    assert.equal(bigRes.ok, true);
    assert.equal(bigRes.transport_mode, "file_bundle");
    assert.equal(bigRes.relay_id, "bnd_custom_1");
    assert.equal(sentBundles.length, 1);
    assert.equal(sentBundles[0].meta.source_identity_verified, true);

    // 429 rate-limit triggers backoff window for subsequent dispatchCustomOp
    transport.sendFrame = async () => {
      throw new CoreError("relay_rate_limited", "rate limited", { retry_after_ms: 5000 });
    };
    await assert.rejects(
      () => dispatcher.dispatchCustomOp({
        op: "board_ack",
        dedupeKey: "dk-ack-429",
        targetMachine: MACHINE_TRAIN,
        body: "{}",
        allowBundle: false,
      }),
      err => err instanceof CoreError && err.code === "relay_rate_limited",
    );
    await assert.rejects(
      () => dispatcher.dispatchCustomOp({
        op: "board_ack",
        dedupeKey: "dk-ack-blocked",
        targetMachine: MACHINE_TRAIN,
        body: "{}",
        allowBundle: false,
      }),
      err => err instanceof CoreError && err.code === "relay_rate_limited",
    );
    nowMs += 6000;
    await dispatcher.close();
  });

  it("opHandlers receive frozen source_endpoint/source_identity_verified/trust_source_identity (excluding core/system/*) and retain_bundle defers spool ack", async () => {
    const ackedBundles = [];
    const bundleQueue = [
      {
        event_id: "ev-sys-1",
        bundle_id: "bnd-sys-1",
        source_machine: MACHINE_TRAIN,
        sender_id: "200001",
        sender_verified: true,
        relay_key: "r-main",
        group_id: "900",
        route_generation: 1,
        payload_json: {
          op: "board_delta",
          from_machine: MACHINE_TRAIN,
          to_machine: MACHINE_DEV,
          source: "core/system/board_sync",
          recipients: ["core/system/board_sync"],
          body: "",
          meta: { hop_count: 1, source_identity_verified: true },
        },
      },
      {
        event_id: "ev-user-defer",
        bundle_id: "bnd-user-defer",
        source_machine: MACHINE_TRAIN,
        sender_id: "200001",
        sender_verified: true,
        relay_key: "r-main",
        group_id: "900",
        route_generation: 1,
        payload_json: {
          op: "board_state_sync",
          from_machine: MACHINE_TRAIN,
          to_machine: MACHINE_DEV,
          source: "codex/desktop/conv-train-1",
          recipients: ["core/system/board_sync"],
          body: "",
          meta: { hop_count: 1, source_identity_verified: true },
        },
      },
    ];
    const observed = [];
    let deferFirst = true;
    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: {
        async readBundleEvents() {
          return { events: bundleQueue.splice(0), errors: [], next_cursor: null };
        },
        async ackBundleEvents({ event_ids }) {
          ackedBundles.push(...event_ids);
        },
      },
      policy: { peers: { [MACHINE_TRAIN]: { trust_source_identity: true } } },
      localHandlers: {},
    });

    dispatcher.registerOpHandler("board_delta", async ctx => {
      observed.push({ op: "board_delta", ep: ctx.source_endpoint, verified: ctx.source_identity_verified, trusted: ctx.remotePrincipal.trust_source_identity });
      return { ok: true };
    });
    dispatcher.registerOpHandler("board_state_sync", async ctx => {
      observed.push({ op: "board_state_sync", ep: ctx.source_endpoint, verified: ctx.source_identity_verified, trusted: ctx.remotePrincipal.trust_source_identity, defer: deferFirst });
      if (deferFirst) {
        deferFirst = false;
        return { retain_bundle: true, code: "storage_enospc" };
      }
      return { ok: true };
    });

    const summary = await dispatcher.pollOnce();
    assert.equal(summary.processed, 1);
    assert.deepEqual(ackedBundles, ["ev-sys-1"]);
    // core/system/board_sync must NEVER be marked source_identity_verified=true
    assert.deepEqual(observed[0], { op: "board_delta", ep: null, verified: false, trusted: true });
    // Real 3-segment endpoint gets verified=true + trusted=true, and retain_bundle prevented spool ack and processedCache entry
    assert.deepEqual(observed[1], { op: "board_state_sync", ep: "codex/desktop/conv-train-1", verified: true, trusted: true, defer: true });

    // Re-delivering ev-user-defer succeeds because it was NOT put in processedCache when deferred
    const retryOutcome = await dispatcher.handleInboundEvent({
      event_id: "ev-user-defer",
      bundle_id: "bnd-user-defer",
      source_machine: MACHINE_TRAIN,
      sender_id: "200001",
      sender_verified: true,
      relay_key: "r-main",
      group_id: "900",
      route_generation: 1,
      payload_json: {
        op: "board_state_sync",
        from_machine: MACHINE_TRAIN,
        to_machine: MACHINE_DEV,
        source: "codex/desktop/conv-train-1",
        recipients: ["core/system/board_sync"],
        body: "",
        meta: { hop_count: 1, source_identity_verified: true },
      },
    }, { isBundle: true });
    assert.equal(retryOutcome.handled, true);
    await dispatcher.close();
  });

  it("silently ignores file_notice/file_ack/file_cancel/file_resume in text stream and isolates poison exceptions in pollOnce", async () => {
    const errors = [];
    const ackedBundles = [];
    const handledTexts = [];
    const dispatcher = new RemoteCoreDispatcher({
      localMachineId: MACHINE_DEV,
      transport: {
        async readEvents() {
          return {
            events: [
              { event_id: "ctrl-1", frame_text: "[COMM_RELAY_V1]\nop: file_notice\n---\n[END_COMM_RELAY_V1]" },
              { event_id: "ctrl-2", frame_text: "[COMM_RELAY_V1]\nop: file_cancel\n---\n[END_COMM_RELAY_V1]" },
              { event_id: "ctrl-3", frame_text: "[COMM_RELAY_V1]\nop: file_resume\n---\n[END_COMM_RELAY_V1]" },
              {
                event_id: "poison-text",
                source_machine: MACHINE_TRAIN,
                sender_verified: true,
                relay_key: "r-main",
                group_id: "900",
                route_generation: 1,
                frame: {
                  relay_id: "rly-poison-1",
                  op: "board_delta",
                  from_machine: MACHINE_TRAIN,
                  to_machine: MACHINE_DEV,
                  source: "core/system/board_sync",
                  recipients: ["core/system/board_sync"],
                  body: "boom",
                  meta: { hop_count: 1 },
                },
              },
              {
                event_id: "good-text",
                source_machine: MACHINE_TRAIN,
                sender_verified: true,
                relay_key: "r-main",
                group_id: "900",
                route_generation: 1,
                frame: {
                  relay_id: "rly-good-1",
                  op: "board_ack",
                  from_machine: MACHINE_TRAIN,
                  to_machine: MACHINE_DEV,
                  source: "core/system/board_sync",
                  recipients: ["core/system/board_sync"],
                  body: "ok",
                  meta: { hop_count: 1 },
                },
              },
            ],
            next_cursor: "c2",
          };
        },
        async readBundleEvents() {
          return {
            events: [
              {
                event_id: "poison-bnd",
                bundle_id: "bnd-poison",
                source_machine: MACHINE_TRAIN,
                sender_id: "200001",
                sender_verified: true,
                relay_key: "r-main",
                group_id: "900",
                route_generation: 1,
                payload_json: {
                  op: "board_delta",
                  from_machine: MACHINE_TRAIN,
                  to_machine: MACHINE_DEV,
                  source: "core/system/board_sync",
                  recipients: ["core/system/board_sync"],
                  body: "boom",
                  meta: { hop_count: 1 },
                },
              },
              {
                event_id: "good-bnd",
                bundle_id: "bnd-good",
                source_machine: MACHINE_TRAIN,
                sender_id: "200001",
                sender_verified: true,
                relay_key: "r-main",
                group_id: "900",
                route_generation: 1,
                payload_json: {
                  op: "board_ack",
                  from_machine: MACHINE_TRAIN,
                  to_machine: MACHINE_DEV,
                  source: "core/system/board_sync",
                  recipients: ["core/system/board_sync"],
                  body: "ok",
                  meta: { hop_count: 1 },
                },
              },
            ],
            errors: [],
            next_cursor: null,
          };
        },
        async ackBundleEvents({ event_ids }) {
          ackedBundles.push(...event_ids);
        },
      },
      localHandlers: {},
      onError: err => errors.push(err),
    });

    dispatcher.registerOpHandler("board_delta", async () => {
      throw new Error("simulated_poison_crash");
    });
    dispatcher.registerOpHandler("board_ack", async ({ frame }) => {
      handledTexts.push(frame.relay_id);
      return { ok: true };
    });

    const summary = await dispatcher.pollOnce();
    assert.equal(summary.ignored, 3); // file_notice + file_cancel + file_resume (colon format!) silently ignored
    assert.equal(summary.processed, 2); // good-text + good-bnd both survived poison!
    assert.equal(summary.rejected.length, 2); // poison-text + poison-bnd isolated
    assert.equal(errors.length, 2);
    assert.deepEqual(ackedBundles, ["good-bnd"]); // poison-bnd NOT acked/released!
    assert.deepEqual(handledTexts, ["rly-good-1", "bnd-good"]);
    await dispatcher.close();
  });
});
