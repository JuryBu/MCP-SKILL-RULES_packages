import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { createOwnerReplyReader } from "../src/owner-replies.mjs";
import { planOwnerReplyForward } from "../src/reply-forwarding.mjs";
import { MessageStore } from "../src/store.mjs";
import { NapcatOwnerAdapter } from "../src/adapters/napcat-owner.mjs";

const SOURCE = { machine_id: "synthetic-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-w26-origin" };
const OWNER = {
  machine_id: "synthetic-machine",
  host: "qq",
  surface: "group",
  conversation_id: "synthetic-w26-group",
  binding_id: "synthetic-w26-owner",
  binding_generation: 2,
  adapter_id: "synthetic-w26-qq",
  capabilities: { next_model_boundary: true, when_idle: false },
  evidence: "synthetic",
};
const RETURN_TARGET = {
  ...SOURCE,
  binding_id: "synthetic-w26-return",
  binding_generation: 3,
  adapter_id: "synthetic-w26-ag",
  capabilities: { next_model_boundary: true, when_idle: true },
  evidence: "synthetic",
};
const PRINCIPAL = { id: "synthetic-w26-principal", identity: SOURCE, allowed_targets: [OWNER.binding_id], origin_kinds: ["agent_message"] };
const ROUTE = { route_key: "synthetic-w26-route", conversation_id: "synthetic-w26-caller", target_key: OWNER.conversation_id, generation: 9 };
const RULE = {
  id: "synthetic-w26-return-rule",
  source_principal_id: PRINCIPAL.id,
  from_binding_id: OWNER.binding_id,
  to_binding_id: RETURN_TARGET.binding_id,
  ttl_ms: 24 * 60 * 60 * 1000,
  owner_sender_allowlist: ["90001"],
};

function seedAgedQq(store, { count, startIndex = 0, timestampMs, idPrefix = "00000000-0000-4000-8000", withForwardBinding = false, principalId = PRINCIPAL.id }) {
  const iso = new Date(timestampMs).toISOString();
  const sourceKey = identityKey(SOURCE);
  const targetKey = identityKey(OWNER);
  store.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const idx = startIndex + i;
      const msgId = `${idPrefix}-${String(idx).padStart(12, "0")}`;
      const delivId = `${idPrefix.replace("-8000", "-9000")}-${String(idx).padStart(12, "0")}`;
      const qqId = String(50000 + idx);
      store.insertMessage({
        message_id: msgId,
        source_key: sourceKey,
        target_key: targetKey,
        dedupe_key: `aged-qq-${idx}`,
        payload_hash: `hash-aged-${idx}`,
        principal_id: principalId,
        ...(withForwardBinding ? {
          reply_forward_binding: {
            rule_id: RULE.id,
            source_principal_id: PRINCIPAL.id,
            from_target: OWNER,
            to_target: RETURN_TARGET,
            ttl_ms: RULE.ttl_ms,
            owner_sender_allowlist: RULE.owner_sender_allowlist,
            principal_id: `owner-reply-forward:${RULE.id}`,
          },
        } : {}),
        envelope: {
          caller: SOURCE,
          origin: { kind: "agent_message", channel: "test", source_ref: `aged-${idx}` },
          target: {
            machine_id: OWNER.machine_id,
            host: OWNER.host,
            surface: OWNER.surface,
            conversation_id: OWNER.conversation_id,
            binding_id: OWNER.binding_id,
            binding_generation: OWNER.binding_generation,
          },
          text: `历史旧通知 ${idx}`,
          dedupe_key: `aged-qq-${idx}`,
          reply_required: false,
          attachment_refs: [],
          delivery_policy: "next_model_boundary",
          expires_at: "2035-01-01T00:00:00Z",
        },
        created_at: iso,
        delivery_status: "accepted",
      });
      store.insertDelivery({
        delivery_id: delivId,
        message_id: msgId,
        target_key: targetKey,
        target_snapshot: { ...OWNER },
        status: "accepted",
        attempt_count: 1,
        evidence: {
          outcome: "accepted",
          delivery_id: delivId,
          target_key: targetKey,
          evidence: {
            kind: "receipt",
            native_receipt: {
              provider: "napcat_owner",
              message_id: qqId,
              verified: true,
              state_persisted: true,
              reply_route: { ...ROUTE },
            },
          },
        },
        created_at: iso,
        updated_at: iso,
      });
    }
  });
}

test("4h QQ hot pool captures late first reply (25m & 3h50m) immediately without queuing behind 50 aged messages", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-late-first-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-05-01T00:00:00Z");
  let nextQqId = 81000;
  const readLog = [];
  const repliesByQqId = new Map();

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: {
      enabled: true,
      callerConversationId: ROUTE.conversation_id,
      targetKey: ROUTE.target_key,
      routeGeneration: ROUTE.generation,
      ownerSenderAllowlist: ["90001"],
    },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        const messageId = String(++nextQqId);
        return {
          ok: true, sent: true, verified: true, statePersisted: true,
          target: { targetKey: OWNER.conversation_id },
          messageId,
          replyRoute: {
            messageId,
            routeKey: ROUTE.route_key,
            conversationId: ROUTE.conversation_id,
            targetKey: ROUTE.target_key,
            ownerEventGeneration: ROUTE.generation,
          },
        };
      },
      async readOwnerEvents(params) {
        readLog.push(params.original_qq_message_id);
        return {
          ok: true,
          route: { ...ROUTE },
          original_qq_message_id: params.original_qq_message_id,
          events: repliesByQqId.get(params.original_qq_message_id) ?? [],
          next_cursor: null,
          partial: false,
        };
      },
    },
  });
  const received = [];
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const core = new CommunicationCore({
    store,
    targets: [OWNER, RETURN_TARGET],
    principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [RULE],
    now: () => clockMs,
    qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });

  seedAgedQq(store, { count: 50, timestampMs: clockMs - 6 * 60 * 60 * 1000 });
  await core.start();

  const sent = await core.sendMessage({ principal_id: PRINCIPAL.id }, {
    caller: SOURCE,
    origin: { kind: "agent_message", channel: "test", source_ref: "late-first" },
    target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
    text: "需要延迟后收回复的群消息",
    dedupe_key: "w26-late-first",
    expires_at: "2035-01-01T00:00:00Z",
  });
  await core.drain();
  const origQqId = core.result(sent.message.message_id).delivery.evidence.evidence.native_receipt.message_id;

  // Advance 25 minutes (> legacy 15m window, inside 4h hot pool) -> owner replies
  clockMs += 25 * 60 * 1000;
  repliesByQqId.set(origQqId, [
    { event_id: "evt-25m", message_id: "901001", message_seq: 1, quoted_message_id: origQqId, sender_id: "90001", text: "25分钟后的首条引用" },
  ]);
  readLog.length = 0;
  const poll1 = await core.pollReplies();
  await core.drain();
  assert.equal(poll1.replies, 1);
  assert.equal(readLog[0], origQqId, "25m-old QQ message must be probed FIRST in hot pool before aged messages");
  assert.deepEqual(received, ["25分钟后的首条引用"]);

  // Advance another 3h25m (total 3h50m since send, 3h25m since reply 1) -> owner sends 2nd reply
  clockMs += (3 * 60 + 25) * 60 * 1000;
  repliesByQqId.get(origQqId).push(
    { event_id: "evt-3h50m", message_id: "901002", message_seq: 2, quoted_message_id: origQqId, sender_id: "90001", text: "3小时50分后的追问" },
  );
  readLog.length = 0;
  const poll2 = await core.pollReplies();
  await core.drain();
  assert.equal(poll2.replies, 1);
  assert.equal(readLog[0], origQqId);
  assert.deepEqual(received, ["25分钟后的首条引用", "3小时50分后的追问"]);
});

test("multi-reply QQ forwards 3 consecutive replies in one poll, stays hot after reply renewal, survives reopen idempotently, and retires past TTL", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-multi-reply-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-06-01T00:00:00Z");
  const readLog = [];
  const ownerEvents = [];
  const received = [];

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: {
      enabled: true,
      callerConversationId: ROUTE.conversation_id,
      targetKey: ROUTE.target_key,
      routeGeneration: ROUTE.generation,
      ownerSenderAllowlist: ["90001"],
    },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        return {
          ok: true, sent: true, verified: true, statePersisted: true,
          target: { targetKey: OWNER.conversation_id },
          messageId: "88001",
          replyRoute: {
            messageId: "88001",
            routeKey: ROUTE.route_key,
            conversationId: ROUTE.conversation_id,
            targetKey: ROUTE.target_key,
            ownerEventGeneration: ROUTE.generation,
          },
        };
      },
      async readOwnerEvents(params) {
        readLog.push(params.original_qq_message_id);
        return {
          ok: true,
          route: { ...ROUTE },
          original_qq_message_id: params.original_qq_message_id,
          events: [...ownerEvents],
          next_cursor: null,
          partial: false,
        };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push({ eventId: message.forward_of.native_source.event.event_id, text: message.envelope.text });
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  let store;
  let core;
  const openCore = async () => {
    store = new MessageStore({ filePath: dbPath });
    core = new CommunicationCore({
      store,
      targets: [OWNER, RETURN_TARGET],
      principals: [PRINCIPAL],
      adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
      replyForwarding: [RULE],
      now: () => clockMs,
      qqReplyRecentMs: 4 * 60 * 60 * 1000,
    });
    await core.start();
  };
  testContext.after(async () => { await core?.close(); store?.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await openCore();

  const sent = await core.sendMessage({ principal_id: PRINCIPAL.id }, {
    caller: SOURCE,
    origin: { kind: "agent_message", channel: "test", source_ref: "multi-reply" },
    target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
    text: "连续多条引用原消息",
    dedupe_key: "w26-multi-origin",
    expires_at: "2035-01-01T00:00:00Z",
  });
  await core.drain();

  // 1) Owner sends 3 consecutive quoted replies (+ 1 non-owner distraction in between)
  clockMs += 3 * 60 * 60 * 1000; // T + 3h
  ownerEvents.push(
    { event_id: "evt-r1", message_id: "1048582536", message_seq: 4, quoted_message_id: "88001", sender_id: "90001", text: "第一条引用回复" },
    { event_id: "evt-other", message_id: "1048582599", message_seq: 5, quoted_message_id: "88001", sender_id: "99999", text: "非主人路人回复应被忽略" },
    { event_id: "evt-r2", message_id: "1301863668", message_seq: 6, quoted_message_id: "88001", sender_id: "90001", text: "第二条紧接追问" },
    { event_id: "evt-r3", message_id: "692348014", message_seq: 7, quoted_message_id: "88001", sender_id: "90001", text: "第三条补充说明" },
  );
  const firstPoll = await core.pollReplies();
  await core.drain();
  assert.equal(firstPoll.replies, 3);
  assert.deepEqual(received, [
    { eventId: "evt-r1", text: "第一条引用回复" },
    { eventId: "evt-r2", text: "第二条紧接追问" },
    { eventId: "evt-r3", text: "第三条补充说明" },
  ]);

  // 2) Advance to T + 5h (> 4h after original send, but only 2h after last reply -> MUST stay hot!)
  clockMs += 2 * 60 * 60 * 1000; // T + 5h
  ownerEvents.push(
    { event_id: "evt-r4", message_id: "1301863700", message_seq: 8, quoted_message_id: "88001", sender_id: "90001", text: "第4条在续热窗口内秒转" },
  );
  // Seed an aged message so slow lane is also non-empty; if renewal works, hot pool probes 88001 BEFORE aged slow lane without passive gap block
  seedAgedQq(store, { count: 1, startIndex: 99, timestampMs: clockMs - 10 * 60 * 60 * 1000 });
  readLog.length = 0;
  const secondPoll = await core.pollReplies();
  await core.drain();
  assert.equal(secondPoll.replies, 1);
  assert.equal(readLog[0], "88001", "renewed multi-reply QQ must remain in hot pool past original 4h send window");
  assert.equal(received.length, 4);
  assert.equal(received[3].eventId, "evt-r4");

  // 3) Reopen SQLite -> zero duplicate forwards for R1..R4; new R5 forwards cleanly
  await core.close();
  store.close();
  await openCore();
  readLog.length = 0;
  const reopenQuiet = await core.pollReplies();
  await core.drain();
  assert.equal(reopenQuiet.replies, 0);
  assert.equal(received.length, 4, "reopen must never re-forward already persisted replies");

  ownerEvents.push(
    { event_id: "evt-r5", message_id: "1301863750", message_seq: 9, quoted_message_id: "88001", sender_id: "90001", text: "重启后第5条追问" },
  );
  const reopenFifth = await core.pollReplies();
  await core.drain();
  assert.equal(reopenFifth.replies, 1);
  assert.equal(received.length, 5);
  assert.equal(received[4].eventId, "evt-r5");

  // 4) Past TTL (24h) and past 4h inactivity -> naturally retires from observation
  clockMs += 25 * 60 * 60 * 1000;
  readLog.length = 0;
  const retired = await core.pollReplies();
  assert.equal(retired.replies, 0);
  assert.equal(readLog.includes("88001"), false, "multi-reply QQ past TTL and inactivity must retire instead of polling forever");

  // Confirm 5 durable forward messages exist for the single original message
  const forwardEvents = store.eventsAfter(sent.message.message_id, 0, 100).filter(e => e.kind === "reply_forward_created");
  assert.equal(forwardEvents.length, 5);
});

test("slow-lane QQ scans newest-first by timestamp (not UUID order) and preempts long non-QQ scans after 5s gap", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-slow-priority-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-07-01T12:00:00Z");
  const qqReadLog = [];
  const agReadLog = [];

  const AG_TARGET = {
    machine_id: "synthetic-machine",
    host: "antigravity",
    surface: "desktop",
    conversation_id: "synthetic-ag-busy",
    binding_id: "synthetic-ag-busy-binding",
    binding_generation: 1,
    adapter_id: "synthetic-ag-busy-adapter",
    capabilities: { next_model_boundary: true, when_idle: true },
    evidence: "synthetic",
  };
  const agPrincipal = { id: "synthetic-ag-sender", identity: SOURCE, allowed_targets: [OWNER.binding_id, AG_TARGET.binding_id], origin_kinds: ["agent_message"] };

  const qqAdapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: {
      enabled: true,
      callerConversationId: ROUTE.conversation_id,
      targetKey: ROUTE.target_key,
      routeGeneration: ROUTE.generation,
      ownerSenderAllowlist: ["90001"],
    },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        qqReadLog.push(params.original_qq_message_id);
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: [], next_cursor: null, partial: false };
      },
    },
  });

  const agAdapter = {
    async deliver({ delivery, target }) {
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
    async observeReply({ delivery }) {
      agReadLog.push(delivery.delivery_id);
      // Simulate each AG poll taking 2 seconds of wall clock so 4 AG deliveries cross the 5s QQ slow-lane cooldown mid-poll
      clockMs += 2000;
      return null;
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const core = new CommunicationCore({
    store,
    targets: [OWNER, AG_TARGET],
    principals: [agPrincipal],
    adapters: { [OWNER.adapter_id]: qqAdapter, [AG_TARGET.adapter_id]: agAdapter },
    now: () => clockMs,
    maxConcurrent: 1,
    qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await qqAdapter.close(); rmSync(dir, { recursive: true, force: true }); });

  // Seed 20 ancient QQ deliveries with SMALLEST UUIDs (24h old -> qqId 50000..50019)
  seedAgedQq(store, { count: 20, startIndex: 0, timestampMs: clockMs - 24 * 60 * 60 * 1000, idPrefix: "00000000-0000-4000-8000", principalId: agPrincipal.id });
  // Seed 2 newer-but-aged QQ deliveries with LARGEST UUIDs (5h old -> qqId 50100, 6h old -> qqId 50101)
  seedAgedQq(store, { count: 1, startIndex: 100, timestampMs: clockMs - 5 * 60 * 60 * 1000, idPrefix: "ffffffff-ffff-4000-8000", principalId: agPrincipal.id });
  seedAgedQq(store, { count: 1, startIndex: 101, timestampMs: clockMs - 6 * 60 * 60 * 1000, idPrefix: "fffffffe-ffff-4000-8000", principalId: agPrincipal.id });

  await core.start();

  // Send 6 fresh AG deliveries so the non-QQ page scan crosses 5s cooldown inside a single pollReplies()
  for (let i = 0; i < 6; i += 1) {
    await core.sendMessage({ principal_id: agPrincipal.id }, {
      caller: SOURCE,
      origin: { kind: "agent_message", channel: "test", source_ref: `ag-${i}` },
      target: { machine_id: AG_TARGET.machine_id, host: AG_TARGET.host, surface: AG_TARGET.surface, conversation_id: AG_TARGET.conversation_id, binding_id: AG_TARGET.binding_id, binding_generation: AG_TARGET.binding_generation },
      text: `AG慢扫描消息 ${i}`,
      dedupe_key: `w26-ag-slow-${i}`,
      expires_at: "2035-01-01T00:00:00Z",
    });
  }
  await core.drain();

  await core.pollReplies();
  assert.equal(agReadLog.length, 6);
  // 1st QQ read must be 5h-old (50100) despite largest UUID; mid-scan after >5s, 2nd QQ read must preempt AG scan and read 6h-old (50101)!
  assert.ok(qqReadLog.length >= 2, `expected >= 2 aged QQ reads during long AG scan, got ${qqReadLog.length}: ${JSON.stringify(qqReadLog)}`);
  assert.equal(qqReadLog[0], "50100", "newest aged QQ (5h old, largest UUID) must be probed before 24h-old smallest UUIDs");
  assert.equal(qqReadLog[1], "50101", "second-newest aged QQ (6h old) must be probed next via mid-poll preemption");
});

test("partial attachment unknown QQ delivery remains observable in slow lane after reopen and supports multi-reply", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-partial-unknown-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-08-01T00:00:00Z");
  const received = [];

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: {
      enabled: true,
      callerConversationId: ROUTE.conversation_id,
      targetKey: ROUTE.target_key,
      routeGeneration: ROUTE.generation,
      ownerSenderAllowlist: ["90001"],
    },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        return {
          ok: true,
          route: { ...ROUTE },
          original_qq_message_id: params.original_qq_message_id,
          events: [
            { event_id: "evt-p1", message_id: "770001", message_seq: 1, quoted_message_id: params.original_qq_message_id, sender_id: "90001", text: "部分附件消息首条回复" },
            { event_id: "evt-p2", message_id: "770002", message_seq: 2, quoted_message_id: params.original_qq_message_id, sender_id: "90001", text: "部分附件消息第二条回复" },
          ],
          next_cursor: null,
          partial: false,
        };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const agedIso = new Date(clockMs - 6 * 60 * 60 * 1000).toISOString();
  const sourceKey = identityKey(SOURCE);
  const targetKey = identityKey(OWNER);
  store.transaction(() => {
    store.insertMessage({
      message_id: "msg-partial-qq",
      source_key: sourceKey,
      target_key: targetKey,
      dedupe_key: "partial-qq-aged",
      payload_hash: "hash-partial-qq",
      principal_id: PRINCIPAL.id,
      reply_forward_binding: {
        rule_id: RULE.id,
        source_principal_id: PRINCIPAL.id,
        from_target: OWNER,
        to_target: RETURN_TARGET,
        ttl_ms: RULE.ttl_ms,
        owner_sender_allowlist: RULE.owner_sender_allowlist,
        principal_id: `owner-reply-forward:${RULE.id}`,
      },
      envelope: {
        caller: SOURCE,
        origin: { kind: "agent_message", channel: "test", source_ref: "partial-qq" },
        target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
        text: "正文成功但附件部分失败的QQ消息",
        dedupe_key: "partial-qq-aged",
        reply_required: false,
        attachment_refs: ["C:/synthetic/report.txt"],
        delivery_policy: "next_model_boundary",
        expires_at: "2035-01-01T00:00:00Z",
      },
      created_at: agedIso,
      delivery_status: "unknown",
    });
    store.insertDelivery({
      delivery_id: "deliv-partial-qq",
      message_id: "msg-partial-qq",
      target_key: targetKey,
      target_snapshot: { ...OWNER },
      status: "unknown",
      attempt_count: 1,
      evidence: {
        outcome: "unknown",
        delivery_id: "deliv-partial-qq",
        target_key: targetKey,
        evidence: {
          kind: "receipt",
          partial_delivery: true,
          native_receipt: {
            provider: "napcat_owner",
            message_id: "760001",
            verified: true,
            state_persisted: true,
            reply_route: { ...ROUTE },
            attachments: [],
          },
        },
      },
      created_at: agedIso,
      updated_at: agedIso,
    });
  });

  const core = new CommunicationCore({
    store,
    targets: [OWNER, RETURN_TARGET],
    principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [RULE],
    now: () => clockMs,
    qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  const polled = await core.pollReplies();
  await core.drain();
  assert.equal(polled.replies, 2);
  assert.deepEqual(received, ["部分附件消息首条回复", "部分附件消息第二条回复"]);
});

test("MessageStore.listDeliveriesForTargets filters by target keys, statuses and exclusive cursor", testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-store-targets-"));
  const store = new MessageStore({ filePath: join(dir, "core.sqlite") });
  testContext.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  seedAgedQq(store, { count: 5, startIndex: 0, timestampMs: Date.parse("2030-01-01T00:00:00Z") });
  const ownerKey = identityKey(OWNER);
  assert.deepEqual(store.listDeliveriesForTargets({ targetKeys: [], statuses: ["accepted"] }), []);
  assert.deepEqual(store.listDeliveriesForTargets({ targetKeys: [ownerKey], statuses: [] }), []);
  assert.deepEqual(store.listDeliveriesForTargets({ targetKeys: ["other-target"], statuses: ["accepted"] }), []);

  const page1 = store.listDeliveriesForTargets({ targetKeys: [ownerKey], statuses: ["accepted", "unknown"], limit: 2 });
  assert.equal(page1.length, 2);
  const page2 = store.listDeliveriesForTargets({ targetKeys: [ownerKey], statuses: ["accepted", "unknown"], limit: 2, after_id: page1[1].delivery_id });
  assert.equal(page2.length, 2);
  const page3 = store.listDeliveriesForTargets({ targetKeys: [ownerKey], statuses: ["accepted", "unknown"], limit: 2, after_id: page2[1].delivery_id });
  assert.equal(page3.length, 1);
  assert.ok(page1[1].delivery_id < page2[0].delivery_id && page2[1].delivery_id < page3[0].delivery_id);
  assert.throws(() => store.listDeliveriesForTargets({ targetKeys: "not-array" }), { code: "invalid_input" });
});

test("pollReplies started during QQ 5s cooldown still preempts long non-QQ scans once cooldown expires", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-cooldown-preempt-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-07-02T12:00:00Z");
  const qqReadLog = [];

  const AG_TARGET = {
    machine_id: "synthetic-machine",
    host: "antigravity",
    surface: "desktop",
    conversation_id: "synthetic-ag-cooldown",
    binding_id: "synthetic-ag-cooldown-binding",
    binding_generation: 1,
    adapter_id: "synthetic-ag-cooldown-adapter",
    capabilities: { next_model_boundary: true, when_idle: true },
    evidence: "synthetic",
  };
  const agPrincipal = { id: "synthetic-cooldown-sender", identity: SOURCE, allowed_targets: [OWNER.binding_id, AG_TARGET.binding_id], origin_kinds: ["agent_message"] };
  const qqAdapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        qqReadLog.push(params.original_qq_message_id);
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: [], next_cursor: null, partial: false };
      },
    },
  });
  let slowAg = false;
  const agAdapter = {
    async deliver({ delivery, target }) {
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
    async observeReply() {
      if (slowAg) clockMs += 2000;
      return null;
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const core = new CommunicationCore({
    store,
    targets: [OWNER, AG_TARGET],
    principals: [agPrincipal],
    adapters: { [OWNER.adapter_id]: qqAdapter, [AG_TARGET.adapter_id]: agAdapter },
    now: () => clockMs,
    maxConcurrent: 1,
    qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await qqAdapter.close(); rmSync(dir, { recursive: true, force: true }); });

  seedAgedQq(store, { count: 1, startIndex: 200, timestampMs: clockMs - 5 * 60 * 60 * 1000, idPrefix: "ffffffff-ffff-4000-8000", principalId: agPrincipal.id });
  seedAgedQq(store, { count: 1, startIndex: 201, timestampMs: clockMs - 6 * 60 * 60 * 1000, idPrefix: "fffffffe-ffff-4000-8000", principalId: agPrincipal.id });
  await core.start();

  // First poll consumes slow lane (50200) and starts 5s cooldown
  await core.pollReplies();
  assert.deepEqual(qqReadLog, ["50200"]);

  // Send 5 AG deliveries and start second poll only 1s into cooldown (qqPass.passive.used starts false!)
  for (let i = 0; i < 5; i += 1) {
    await core.sendMessage({ principal_id: agPrincipal.id }, {
      caller: SOURCE,
      origin: { kind: "agent_message", channel: "test", source_ref: `cd-ag-${i}` },
      target: { machine_id: AG_TARGET.machine_id, host: AG_TARGET.host, surface: AG_TARGET.surface, conversation_id: AG_TARGET.conversation_id, binding_id: AG_TARGET.binding_id, binding_generation: AG_TARGET.binding_generation },
      text: `冷却期间AG消息 ${i}`,
      dedupe_key: `w26-cd-ag-${i}`,
      expires_at: "2035-01-01T00:00:00Z",
    });
  }
  await core.drain();
  clockMs += 1000; // Still inside 5s cooldown (t=1s; nextAt=5s)!
  slowAg = true;
  await core.pollReplies();
  // AG#1->3s, AG#2->5s (preempt 50201, nextAt=10s), AG#3->7s, AG#4->9s, AG#5->11s (preempt wrap 50200)
  assert.deepEqual(qqReadLog, ["50200", "50201", "50200"], "mid-scan preemption must fire once cooldown expires and keep rotating every 5s");
});

test("partial attachment unknown QQ with reply_required=true past 4h and hot-pool overflow stays observable while non-partial unknown is rejected", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-partial-overflow-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-08-05T12:00:00Z");
  const received = [];

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        if (params.original_qq_message_id === "761001" || params.original_qq_message_id === "761002") {
          return {
            ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id,
            events: [{ event_id: `evt-${params.original_qq_message_id}`, message_id: `8${params.original_qq_message_id}`, message_seq: 1, quoted_message_id: params.original_qq_message_id, sender_id: "90001", text: `回信-${params.original_qq_message_id}` }],
            next_cursor: null, partial: false,
          };
        }
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: [], next_cursor: null, partial: false };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const sourceKey = identityKey(SOURCE);
  const targetKey = identityKey(OWNER);
  const insertPartial = (id, qqId, iso, replyRequired) => {
    store.insertMessage({
      message_id: `msg-${id}`, source_key: sourceKey, target_key: targetKey, dedupe_key: `dedupe-${id}`, payload_hash: `hash-${id}`, principal_id: PRINCIPAL.id,
      reply_forward_binding: { rule_id: RULE.id, source_principal_id: PRINCIPAL.id, from_target: OWNER, to_target: RETURN_TARGET, ttl_ms: RULE.ttl_ms, owner_sender_allowlist: RULE.owner_sender_allowlist, principal_id: `owner-reply-forward:${RULE.id}` },
      envelope: { caller: SOURCE, origin: { kind: "agent_message", channel: "test", source_ref: id }, target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation }, text: `部分附件-${id}`, dedupe_key: `dedupe-${id}`, reply_required: replyRequired, attachment_refs: ["C:/synthetic/a.txt"], delivery_policy: "next_model_boundary", expires_at: "2035-01-01T00:00:00Z" },
      created_at: iso, delivery_status: "unknown",
    });
    store.insertDelivery({
      delivery_id: `deliv-${id}`, message_id: `msg-${id}`, target_key: targetKey, target_snapshot: { ...OWNER }, status: "unknown", attempt_count: 1,
      evidence: { outcome: "unknown", delivery_id: `deliv-${id}`, target_key: targetKey, evidence: { kind: "receipt", partial_delivery: true, native_receipt: { provider: "napcat_owner", message_id: qqId, verified: true, state_persisted: true, reply_route: { ...ROUTE }, attachments: [] } } },
      created_at: iso, updated_at: iso,
    });
  };

  store.transaction(() => {
    // 1) reply_required: true, older than 4h (never in hot pool, never isOld!)
    insertPartial("req-old", "761001", new Date(clockMs - 6 * 60 * 60 * 1000).toISOString(), true);
    // 2) recent partial unknown evicted by 130 newer QQ deliveries (> 128 hot pool cap)
    insertPartial("evicted-recent", "761002", new Date(clockMs - 10 * 60 * 1000).toISOString(), false);
  });
  seedAgedQq(store, { count: 130, startIndex: 300, timestampMs: clockMs - 5 * 60 * 1000, idPrefix: "11111111-1111-4000-8000" });

  // Verify planOwnerReplyForward strictly rejects plain unknown without partial_delivery or with empty attachment_refs
  const partialMsg = store.getMessage("msg-req-old");
  const partialDel = store.getDelivery("deliv-req-old");
  const sampleReply = { native_message_id: "8761001", native_conversation_id: OWNER.conversation_id, source_step_index: 1, text: "回信", native_source: { provider: "napcat_owner", route: { ...ROUTE }, original_qq_message_id: "761001", event: { event_id: "evt-check", message_id: "8761001", message_seq: 1, quoted_message_id: "761001", sender_id: "90001" } } };
  const noPartialDel = structuredClone(partialDel);
  noPartialDel.evidence.evidence.partial_delivery = false;
  assert.equal(planOwnerReplyForward({ message: partialMsg, delivery: noPartialDel, reply: sampleReply, binding: partialMsg.reply_forward_binding, observedAt: new Date(clockMs).toISOString() }), null);
  const noAttachMsg = structuredClone(partialMsg);
  noAttachMsg.envelope.attachment_refs = [];
  assert.equal(planOwnerReplyForward({ message: noAttachMsg, delivery: partialDel, reply: sampleReply, binding: partialMsg.reply_forward_binding, observedAt: new Date(clockMs).toISOString() }), null);

  const core = new CommunicationCore({
    store, targets: [OWNER, RETURN_TARGET], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [RULE], now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  assert.equal(core.recentQqDeliveries.has("deliv-req-old"), false);
  assert.equal(core.recentQqDeliveries.has("deliv-evicted-recent"), false);
  // Poll with bounded per-poll active budget: reply_required=true arrives immediately on poll 1,
  // and evicted recent partial unknown is reached via fair round-robin within <= 10 polls without reading all 132 in one poll
  for (let round = 0; round < 10 && received.length < 2; round += 1) {
    const polled = await core.pollReplies();
    await core.drain();
    assert.ok(polled.checked <= 17, `single poll must stay bounded (<=16 active + 1 aged), got ${polled.checked}`);
  }
  assert.deepEqual(received.sort(), ["回信-761001", "回信-761002"]);
});

test("MessageStore deliveries_target_status_id index avoids scanning non-QQ rows for single and multi targets without ANALYZE", testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-index-plan-"));
  const dbPath = join(dir, "core.sqlite");
  const store = new MessageStore({ filePath: dbPath });
  testContext.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const iso = "2030-01-01T00:00:00.000Z";
  const qq1 = identityKey(OWNER);
  const qq2 = identityKey({ ...OWNER, surface: "private", conversation_id: "synthetic-w26-private" });
  const agKey = identityKey(SOURCE);
  store.transaction(() => {
    for (let i = 0; i < 2000; i += 1) {
      const targetKey = i < 20 ? qq1 : i < 35 ? qq2 : agKey;
      const msgId = `idx-msg-${String(i).padStart(6, "0")}`;
      const delivId = `idx-del-${String(i).padStart(6, "0")}`;
      store.insertMessage({
        message_id: msgId, source_key: agKey, target_key: targetKey, dedupe_key: `dk-${i}`, payload_hash: `ph-${i}`,
        envelope: { caller: SOURCE, target: OWNER, text: "x" }, created_at: iso, delivery_status: "accepted",
      });
      store.insertDelivery({
        delivery_id: delivId, message_id: msgId, target_key: targetKey, status: "accepted", attempt_count: 1, created_at: iso, updated_at: iso,
      });
    }
  });

  const rows = store.listDeliveriesForTargets({ targetKeys: [qq1, qq2], statuses: ["accepted", "unknown"], limit: 100 });
  assert.equal(rows.length, 35);
  assert.ok(rows.every(r => r.target_key === qq1 || r.target_key === qq2));

  const inspectDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const keys of [[qq1], [qq1, qq2]]) {
      const placeholders = keys.map(() => "?").join(", ");
      const plan = inspectDb.prepare(`
        EXPLAIN QUERY PLAN
        SELECT record_json FROM deliveries
        WHERE target_key IN (${placeholders}) AND delivery_id > ? AND status IN (?, ?)
        ORDER BY delivery_id ASC LIMIT ?
      `).all(...keys, "", "accepted", "unknown", 100);
      const text = plan.map(r => r.detail).join(" | ");
      assert.match(text, /USING INDEX deliveries_target_status_id/u, `expected composite index for ${keys.length} targets, got: ${text}`);
    }
  } finally {
    inspectDb.close();
  }
});

test("revoked explicit owner_sender_allowlist blocks new replies from persisting, forwarding, or renewing hot pool", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-revoke-sender-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-09-01T00:00:00Z");
  const received = [];

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001", "90002"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: OWNER.conversation_id }, messageId: "89100", replyRoute: { messageId: "89100", routeKey: ROUTE.route_key, conversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, ownerEventGeneration: ROUTE.generation } };
      },
      async readOwnerEvents() {
        return {
          ok: true, route: { ...ROUTE }, original_qq_message_id: "89100",
          events: [{ event_id: "evt-revoked", message_id: "89101", message_seq: 1, quoted_message_id: "89100", sender_id: "90001", text: "已被吊销发送者的回复" }],
          next_cursor: null, partial: false,
        };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  let store = new MessageStore({ filePath: dbPath });
  let core = new CommunicationCore({
    store, targets: [OWNER, RETURN_TARGET], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [RULE], now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core?.close(); store?.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  const sent = await core.sendMessage({ principal_id: PRINCIPAL.id }, {
    caller: SOURCE, origin: { kind: "agent_message", channel: "test", source_ref: "revoke-test" },
    target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
    text: "测试吊销发送者", dedupe_key: "w26-revoke-msg", expires_at: "2035-01-01T00:00:00Z",
  });
  await core.drain();

  // Reopen with 90001 revoked from explicit replyForwarding rule (replaced by 90002)
  await core.close();
  store.close();
  clockMs += 3 * 60 * 60 * 1000;
  store = new MessageStore({ filePath: dbPath });
  core = new CommunicationCore({
    store, targets: [OWNER, RETURN_TARGET], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [{ ...RULE, owner_sender_allowlist: ["90002"] }],
    now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  await core.start();

  const beforeHotTs = core.recentQqDeliveries.get(sent.delivery.delivery_id);
  const polled = await core.pollReplies();
  await core.drain();
  assert.equal(polled.replies, 0);
  assert.equal(received.length, 0);
  assert.equal(store.eventsAfter(sent.message.message_id, 0, 100).filter(e => e.kind === "reply").length, 0);
  assert.equal(core.recentQqDeliveries.get(sent.delivery.delivery_id), beforeHotTs, "revoked sender must not renew hot pool timestamp");
});

test("multi-reply SQLite transaction rollback leaves caches clean so next poll captures all replies", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-rollback-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-09-10T00:00:00Z");
  const received = [];

  const adapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: OWNER.conversation_id }, messageId: "89200", replyRoute: { messageId: "89200", routeKey: ROUTE.route_key, conversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, ownerEventGeneration: ROUTE.generation } };
      },
      async readOwnerEvents() {
        return {
          ok: true, route: { ...ROUTE }, original_qq_message_id: "89200",
          events: [
            { event_id: "evt-rb1", message_id: "89201", message_seq: 1, quoted_message_id: "89200", sender_id: "90001", text: "回滚测试1" },
            { event_id: "evt-rb2", message_id: "89202", message_seq: 2, quoted_message_id: "89200", sender_id: "90001", text: "回滚测试2" },
          ],
          next_cursor: null, partial: false,
        };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  const core = new CommunicationCore({
    store, targets: [OWNER, RETURN_TARGET], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: adapter, [RETURN_TARGET.adapter_id]: returnAdapter },
    replyForwarding: [RULE], now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  const sent = await core.sendMessage({ principal_id: PRINCIPAL.id }, {
    caller: SOURCE, origin: { kind: "agent_message", channel: "test", source_ref: "rb" },
    target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
    text: "测试多回复事务回滚", dedupe_key: "w26-rb-msg", expires_at: "2035-01-01T00:00:00Z",
  });
  await core.drain();

  const origInsert = store.insertDelivery.bind(store);
  let failOnSecond = 0;
  store.insertDelivery = record => {
    if (record.target_key === identityKey(SOURCE)) {
      failOnSecond += 1;
      if (failOnSecond === 2) throw new Error("injected-second-forward-failure");
    }
    return origInsert(record);
  };
  await assert.rejects(core.pollReplies(), /injected-second-forward-failure/);
  assert.equal(core.observedOwnerReplyEvents(sent.message.message_id).ids.size, 0, "rolled-back replies must not pollute event ID cache");
  assert.equal(received.length, 0);

  store.insertDelivery = origInsert;
  const recovered = await core.pollReplies();
  await core.drain();
  assert.equal(recovered.replies, 2);
  assert.deepEqual(received, ["回滚测试1", "回滚测试2"]);
});

test("createOwnerReplyReader({ multiple: true }) is strictly fail-closed and disabled ignores throwing multiple getter", async () => {
  // 1) enabled: false with throwing multiple getter -> disabled (not invalid_setup)
  const disabledReader = createOwnerReplyReader({
    enabled: false,
    get multiple() { throw new Error("should not read multiple when disabled"); },
  });
  assert.deepEqual(await disabledReader({}), { status: "unsupported", reason: "disabled", reply: null });

  const binding = { message_id: "m1", delivery_id: "d1", route: { ...ROUTE } };
  const input = {
    message: { message_id: "m1", source_key: identityKey(SOURCE), target_key: identityKey(OWNER), envelope: { caller: SOURCE, target: OWNER } },
    delivery: {
      delivery_id: "d1", message_id: "m1", target_key: identityKey(OWNER), target_snapshot: OWNER, status: "accepted",
      evidence: { outcome: "accepted", delivery_id: "d1", target_key: identityKey(OWNER), evidence: { kind: "receipt", native_receipt: { provider: "napcat_owner", message_id: "80001", verified: true, state_persisted: true, reply_route: { ...ROUTE } } } },
    },
    target: OWNER,
  };

  // 2) Second page fails -> discards valid page 1 replies
  let call = 0;
  const failingSecondPage = createOwnerReplyReader({
    enabled: true, multiple: true, callerConversationId: ROUTE.conversation_id, ownerSenderAllowlist: ["90001"], binding,
    async readPage() {
      call += 1;
      if (call === 1) {
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: "80001", events: [{ event_id: "e1", message_id: "80002", message_seq: 1, quoted_message_id: "80001", sender_id: "90001", text: "第一页有效回复" }], next_cursor: "c2", partial: true };
      }
      return { ok: false, route: { ...ROUTE }, original_qq_message_id: "80001", events: [], next_cursor: null, partial: false };
    },
  });
  assert.equal((await failingSecondPage(input)).status, "unsupported");

  // 3) Duplicate event across pages -> fail-closed
  call = 0;
  const dupReader = createOwnerReplyReader({
    enabled: true, multiple: true, callerConversationId: ROUTE.conversation_id, ownerSenderAllowlist: ["90001"], binding,
    async readPage() {
      call += 1;
      return {
        ok: true, route: { ...ROUTE }, original_qq_message_id: "80001",
        events: [{ event_id: "e1", message_id: "80002", message_seq: 1, quoted_message_id: "80001", sender_id: "90001", text: "重复" }],
        next_cursor: call === 1 ? "c2" : null, partial: call === 1,
      };
    },
  });
  assert.deepEqual(await dupReader(input), { status: "unsupported", reason: "duplicate_event", reply: null });

  // 4) Only non-owner replies -> no_reply
  const nonOwnerReader = createOwnerReplyReader({
    enabled: true, multiple: true, callerConversationId: ROUTE.conversation_id, ownerSenderAllowlist: ["90001"], binding,
    async readPage() {
      return {
        ok: true, route: { ...ROUTE }, original_qq_message_id: "80001",
        events: [{ event_id: "e2", message_id: "80003", message_seq: 2, quoted_message_id: "80001", sender_id: "99999", text: "非主人" }],
        next_cursor: null, partial: false,
      };
    },
  });
  assert.deepEqual(await nonOwnerReader(input), { status: "unsupported", reason: "no_reply", reply: null });
});

test("reopened slow lane preserves newest-first order, wraps into newly aged cohort, and custom malformed observeReplies fails closed", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-wrap-and-failclosed-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-10-01T12:00:00Z");
  const readLog = [];

  const qqAdapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        readLog.push(params.original_qq_message_id);
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: [], next_cursor: null, partial: false };
      },
    },
  });

  let store = new MessageStore({ filePath: dbPath });
  // Seed 2 aged QQ messages: 5h old (50401, larger UUID) and 10h old (50400, smaller UUID)
  seedAgedQq(store, { count: 1, startIndex: 400, timestampMs: clockMs - 10 * 60 * 60 * 1000, idPrefix: "00000000-0000-4000-8000" });
  seedAgedQq(store, { count: 1, startIndex: 401, timestampMs: clockMs - 5 * 60 * 60 * 1000, idPrefix: "ffffffff-ffff-4000-8000" });
  // Seed 1 message currently 3h59m old (will age past 4h after +2m!)
  seedAgedQq(store, { count: 1, startIndex: 402, timestampMs: clockMs - (4 * 60 - 1) * 60 * 1000, idPrefix: "eeeeeeee-eeee-4000-8000" });

  let core = new CommunicationCore({
    store, targets: [OWNER], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: qqAdapter },
    now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core?.close(); store?.close(); await qqAdapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  // First poll: 50402 is hot (3h59m), slow lane picks newest aged (50401)
  await core.pollReplies();
  assert.deepEqual(readLog, ["50402", "50401"]);

  // Advance 5.1s -> slow lane moves to 50400 (after 50402 is still hot)
  clockMs += 5100;
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50402", "50400"]);

  // Advance 2m -> 50402 is now 4h01m (newly aged!), cohort wraps and picks 50402 first!
  clockMs += 2 * 60 * 1000;
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50402"], "exhausted cohort must wrap into newly aged cohort immediately");

  // Reopen SQLite -> fresh slow lane still probes newest aged (50402) first!
  await core.close();
  store.close();
  store = new MessageStore({ filePath: dbPath });
  core = new CommunicationCore({
    store, targets: [OWNER], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: qqAdapter },
    now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  await core.start();
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50402"]);

  // Verify callReplyObservers fails closed if custom adapter returns any malformed item in batch
  const malformedAdapter = {
    async observeReplies() {
      return [
        { native_message_id: "9001", native_conversation_id: OWNER.conversation_id, source_step_index: 1, text: "valid", native_source: { provider: "napcat_owner", route: { ...ROUTE }, original_qq_message_id: "50402", event: { event_id: "ok", message_id: "9001", message_seq: 1, quoted_message_id: "50402", sender_id: "90001" } } },
        { corrupted: true },
      ];
    },
  };
  const msg402 = store.getMessage("eeeeeeee-eeee-4000-8000-000000000402");
  const del402 = store.getDelivery("eeeeeeee-eeee-4000-9000-000000000402");
  const multiMsg = { ...msg402, reply_forward_binding: { rule_id: RULE.id } };
  const observed = await core.callReplyObservers(malformedAdapter, multiMsg, del402, OWNER);
  assert.deepEqual(observed, [], "any corrupted item in custom observeReplies batch must fail closed and drop entire batch");
});

test("newly crossed 4h QQ preempts an in-progress old slow-lane cohort immediately while 1:1 alternation prevents starving old history", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-fresh-aged-fair-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-11-01T12:00:00Z");
  const readLog = [];

  const qqAdapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() { throw new Error("unexpected send"); },
      async readOwnerEvents(params) {
        readLog.push(params.original_qq_message_id);
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: [], next_cursor: null, partial: false };
      },
    },
  });

  const store = new MessageStore({ filePath: dbPath });
  // 20 old 10h messages (50100..50119) + 2 messages at 3h59m (50200, 50201)
  seedAgedQq(store, { count: 20, startIndex: 100, timestampMs: clockMs - 10 * 60 * 60 * 1000, idPrefix: "00000000-0000-4000-8000" });
  seedAgedQq(store, { count: 1, startIndex: 200, timestampMs: clockMs - (4 * 60 - 1) * 60 * 1000, idPrefix: "ffffffff-ffff-4000-8000" });
  seedAgedQq(store, { count: 1, startIndex: 201, timestampMs: clockMs - (4 * 60 - 1.5) * 60 * 1000, idPrefix: "fffffffe-ffff-4000-8000" });

  const core = new CommunicationCore({
    store, targets: [OWNER], principals: [PRINCIPAL],
    adapters: { [OWNER.adapter_id]: qqAdapter },
    now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await qqAdapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  // Poll 1: old cohort starts on 50100 (19 old messages remain in cohort!)
  await core.pollReplies();
  assert.equal(readLog.at(-1), "50100");

  // Advance 2 minutes: both 50200 (newest) & 50201 cross the 4h line while 19 old messages remain!
  clockMs += 2 * 60 * 1000;
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50201"], "newest newly-crossed 4h QQ must be probed immediately instead of waiting 19 rounds");

  // Advance 5.1s: 1:1 fairness must advance the old cohort (50101) before the second newly-crossed item (50200), never starving history!
  clockMs += 5100;
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50101"], "old cohort must advance 1:1 with newly-crossed items so history is never starved");

  // Advance 5.1s: next slot serves the second newly-crossed 4h item (50200)
  clockMs += 5100;
  readLog.length = 0;
  await core.pollReplies();
  assert.deepEqual(readLog, ["50200"], "second newly-crossed item is served on the very next alternating slot");
});

test("130 replied multi-reply QQ deliveries stay bounded per poll, rotate without starving fresh QQ or non-QQ hosts", async testContext => {
  const dir = mkdtempSync(join(tmpdir(), "comm-w26-bounded-pool-"));
  const dbPath = join(dir, "core.sqlite");
  let clockMs = Date.parse("2030-11-10T12:00:00Z");
  let roundQqReads = [];
  let agReads = 0;
  const received = [];
  const customEvents = new Map();

  const AG_TARGET = {
    machine_id: "synthetic-machine",
    host: "antigravity",
    surface: "desktop",
    conversation_id: "synthetic-ag-fairness",
    binding_id: "synthetic-ag-fairness-binding",
    binding_generation: 1,
    adapter_id: "synthetic-ag-fairness-adapter",
    capabilities: { next_model_boundary: true, when_idle: true },
    evidence: "synthetic",
  };
  const sharedPrincipal = { id: PRINCIPAL.id, identity: SOURCE, allowed_targets: [OWNER.binding_id, AG_TARGET.binding_id], origin_kinds: ["agent_message"] };

  let nextQqId = 95000;
  const qqAdapter = new NapcatOwnerAdapter({
    routeKey: ROUTE.route_key,
    conversationId: ROUTE.conversation_id,
    replyEvents: { enabled: true, callerConversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, routeGeneration: ROUTE.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        const messageId = String(++nextQqId);
        return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: OWNER.conversation_id }, messageId, replyRoute: { messageId, routeKey: ROUTE.route_key, conversationId: ROUTE.conversation_id, targetKey: ROUTE.target_key, ownerEventGeneration: ROUTE.generation } };
      },
      async readOwnerEvents(params) {
        roundQqReads.push(params.original_qq_message_id);
        return { ok: true, route: { ...ROUTE }, original_qq_message_id: params.original_qq_message_id, events: customEvents.get(params.original_qq_message_id) ?? [], next_cursor: null, partial: false };
      },
    },
  });
  const agAdapter = {
    async deliver({ delivery, target }) {
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
    async observeReply() {
      agReads += 1;
      return null;
    },
  };
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      received.push(message.envelope.text);
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "transport" } };
    },
  };

  const store = new MessageStore({ filePath: dbPath });
  // Seed 130 recent (< 1h) multi-reply QQ deliveries, each ALREADY having 1 persisted reply (no new events)
  seedAgedQq(store, { count: 130, startIndex: 0, timestampMs: clockMs - 30 * 60 * 1000, idPrefix: "22222222-2222-4000-8000", withForwardBinding: true });
  store.transaction(() => {
    for (let i = 0; i < 130; i += 1) {
      const msgId = `22222222-2222-4000-8000-${String(i).padStart(12, "0")}`;
      const delivId = `22222222-2222-4000-9000-${String(i).padStart(12, "0")}`;
      const qqId = String(50000 + i);
      store.appendEvent(msgId, "reply", {
        delivery_id: delivId,
        native_message_id: String(700000 + i),
        native_conversation_id: OWNER.conversation_id,
        source_step_index: 1,
        text: "既有首条回复",
        native_source: { provider: "napcat_owner", route: { ...ROUTE }, original_qq_message_id: qqId, event: { event_id: `existing-evt-${i}`, message_id: String(700000 + i), message_seq: 1, quoted_message_id: qqId, sender_id: "90001" } },
        evidence: { kind: "native_reply", source: "adapter.observeReply", observed_at: new Date(clockMs - 10 * 60 * 1000).toISOString() },
      });
    }
  });

  const core = new CommunicationCore({
    store, targets: [OWNER, RETURN_TARGET, AG_TARGET], principals: [sharedPrincipal],
    adapters: { [OWNER.adapter_id]: qqAdapter, [RETURN_TARGET.adapter_id]: returnAdapter, [AG_TARGET.adapter_id]: agAdapter },
    replyForwarding: [RULE], now: () => clockMs, qqReplyRecentMs: 4 * 60 * 60 * 1000,
  });
  testContext.after(async () => { await core.close(); store.close(); await qqAdapter.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.start();

  // Add 3 non-QQ AG deliveries alongside the 130 replied QQ deliveries
  for (let i = 0; i < 3; i += 1) {
    await core.sendMessage({ principal_id: sharedPrincipal.id }, {
      caller: SOURCE, origin: { kind: "agent_message", channel: "test", source_ref: `fair-ag-${i}` },
      target: { machine_id: AG_TARGET.machine_id, host: AG_TARGET.host, surface: AG_TARGET.surface, conversation_id: AG_TARGET.conversation_id, binding_id: AG_TARGET.binding_id, binding_generation: AG_TARGET.binding_generation },
      text: `非QQ消息 ${i}`, dedupe_key: `fair-ag-${i}`, expires_at: "2035-01-01T00:00:00Z",
    });
  }
  await core.drain();

  // Two consecutive polls: each must cap active QQ reads at <= 16 (NEVER 130!), rotate disjointly, and always serve all 3 AG deliveries!
  roundQqReads = [];
  agReads = 0;
  await core.pollReplies();
  const batch1 = [...roundQqReads];
  assert.equal(batch1.length, 16, `poll 1 must cap active QQ reads at 16 instead of 130, got ${batch1.length}`);
  assert.equal(agReads, 3, "non-QQ AG deliveries must still be scanned on poll 1");

  roundQqReads = [];
  agReads = 0;
  await core.pollReplies();
  const batch2 = [...roundQqReads];
  assert.equal(batch2.length, 16, `poll 2 must cap active QQ reads at 16 instead of 130, got ${batch2.length}`);
  assert.equal(agReads, 3, "non-QQ AG deliveries must still be scanned on poll 2");
  assert.equal(batch1.filter(id => batch2.includes(id)).length, 0, "consecutive polls must rotate disjointly across the 130 replied QQ pool");

  // Send 1 brand-new QQ notification while pool is full -> MUST jump to first probe and deliver reply immediately alongside AG!
  const fresh = await core.sendMessage({ principal_id: sharedPrincipal.id }, {
    caller: SOURCE, origin: { kind: "agent_message", channel: "test", source_ref: "fresh-under-full-pool" },
    target: { machine_id: OWNER.machine_id, host: OWNER.host, surface: OWNER.surface, conversation_id: OWNER.conversation_id, binding_id: OWNER.binding_id, binding_generation: OWNER.binding_generation },
    text: "满池下新发的QQ通知", dedupe_key: "fresh-under-full-pool", expires_at: "2035-01-01T00:00:00Z",
  });
  await core.drain();
  const freshQqId = core.result(fresh.message.message_id).delivery.evidence.evidence.native_receipt.message_id;
  customEvents.set(freshQqId, [
    { event_id: "evt-fresh-full", message_id: "995001", message_seq: 1, quoted_message_id: freshQqId, sender_id: "90001", text: "满池下新信秒回" },
  ]);

  roundQqReads = [];
  agReads = 0;
  const poll3 = await core.pollReplies();
  await core.drain();
  assert.equal(poll3.replies, 1);
  assert.equal(roundQqReads[0], freshQqId, "brand-new unreplied QQ must jump ahead of 130 replied QQ items");
  assert.equal(roundQqReads.length, 16);
  assert.equal(agReads, 3, "non-QQ AG deliveries remain unblocked even with fresh QQ + 130 full pool");
  assert.deepEqual(received, ["满池下新信秒回"]);
});


