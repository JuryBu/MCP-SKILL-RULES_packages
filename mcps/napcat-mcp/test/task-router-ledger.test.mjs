import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskRegistry } from "../src/task-registry.mjs";
import { createTaskRouter } from "../src/task-router.mjs";

const BASE_TIME_MS = Date.parse("2026-08-02T16:00:00.000Z");

function message(messageSeq, offsetMs) {
  return {
    messageId: String(messageSeq),
    messageSeq: String(messageSeq),
    senderId: "1000000003",
    isSelf: false,
    taskId: "router-ledger-e2e",
    sourceMachine: "development",
    targetMachine: "training",
    deliveryId: `delivery-${messageSeq}`,
    time: new Date(BASE_TIME_MS + offsetMs).toISOString(),
    text: `message-${messageSeq}`,
    attachments: [],
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-router-ledger-test-"));
  let currentTimeMs = BASE_TIME_MS;
  let history = [message(10, 0)];
  const wakes = [];
  const receipts = [];
  const receiptKeys = new Set();
  const registry = createTaskRegistry({
    statePath: path.join(root, "state", "task-registry.json"),
    now: () => new Date(currentTimeMs),
    wakeLeaseMs: 30_000,
    wakeCooldownMs: 30_000,
  });
  registry.register({
    taskId: "router-ledger-e2e",
    conversationId: "thread-ledger-e2e",
    localRole: "training",
    sourceMachine: "development",
    targetMachine: "training",
    trustedPeerQq: "1000000003",
    wakeCooldownMs: 30_000,
  });
  const router = createTaskRouter({
    registry,
    wakeLeaseMs: 30_000,
    now: () => new Date(currentTimeMs),
    notifier: {
      async readRecentMessages() {
        return { scannedCount: history.length, messages: history };
      },
    },
    bridge: {
      async wake(input) {
        wakes.push(input);
        return { outcome: "accepted", status: "busy", started: true, turn: { id: `turn-${wakes.length}` } };
      },
    },
    controlPlane: {
      async keepAlive() {
        return { enabled: true };
      },
      async scanGroupHistory() {
        return { enabled: true, results: [] };
      },
      async reconcileOutgoingDeliveries() {
        return { results: [] };
      },
      async scanOwnerReplies() {
        return { enabled: true, results: [] };
      },
      async acknowledgeBusinessMessages(messages, stage) {
        const sent = [];
        for (const entry of messages) {
          const key = `${stage}:${entry.deliveryId}`;
          if (receiptKeys.has(key)) continue;
          receiptKeys.add(key);
          const receipt = { deliveryId: entry.deliveryId, stage, sent: true };
          receipts.push(receipt);
          sent.push(receipt);
        }
        return sent;
      },
    },
  });
  return {
    registry,
    router,
    wakes,
    receipts,
    advance(milliseconds) {
      currentTimeMs += milliseconds;
    },
    addMessage(messageSeq, offsetMs) {
      history = [...history, message(messageSeq, offsetMs)];
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("new traffic coalesces while old unACKed messages wait until the twelve-hour reminder interval", async () => {
  const fixture = createFixture();
  try {
    const first = await fixture.router.scanOnce();
    assert.equal(first.results[0].outcome, "accepted");
    assert.equal(fixture.wakes.length, 1);
    assert.match(fixture.wakes[0].prompt, /pending_message_seqs=\[10\]/);
    assert.match(fixture.wakes[0].prompt, /new_message_seqs=\[10\]/);
    assert.match(fixture.wakes[0].prompt, /previously_pending_message_seqs=\[\]/);

    const unchanged = await fixture.router.scanOnce();
    assert.equal(unchanged.results[0].outcome, "awaiting_ack");
    assert.equal(fixture.wakes.length, 1);

    fixture.advance(5_000);
    fixture.addMessage(11, 5_000);
    const cooldown = await fixture.router.scanOnce();
    assert.equal(cooldown.results[0].outcome, "wake_cooldown");
    assert.deepEqual(fixture.receipts.filter((entry) => entry.deliveryId === "delivery-11"), [
      { deliveryId: "delivery-11", stage: "machine_received", sent: true },
      { deliveryId: "delivery-11", stage: "conversation_received", sent: true },
    ]);
    assert.deepEqual(fixture.registry.get("router-ledger-e2e").pendingMessages.map((entry) => entry.messageSeq), [10, 11]);
    assert.equal(fixture.wakes.length, 1);
    fixture.advance(5_000);
    fixture.addMessage(12, 10_000);
    assert.equal((await fixture.router.scanOnce()).results[0].outcome, "wake_cooldown");
    fixture.advance(20_000);
    const second = await fixture.router.scanOnce();
    assert.equal(second.results[0].outcome, "accepted");
    assert.equal(fixture.wakes.length, 2);
    assert.match(fixture.wakes[1].prompt, /pending_message_seqs=\[11,12\]/);
    assert.match(fixture.wakes[1].prompt, /new_message_seqs=\[11,12\]/);
    assert.match(fixture.wakes[1].prompt, /previously_pending_message_seqs=\[\]/);

    fixture.registry.acknowledgeWake({
      taskId: "router-ledger-e2e",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: fixture.wakes[0].wakeId,
    });
    const partial = fixture.registry.acknowledgeWake({
      taskId: "router-ledger-e2e",
      expectedGeneration: 1,
      processedMessageSeqs: [11],
      wakeId: fixture.wakes[1].wakeId,
    });
    assert.deepEqual(partial.pendingMessages.map((entry) => entry.messageSeq), [12]);
    assert.equal((await fixture.router.scanOnce()).results[0].outcome, "awaiting_ack");
    assert.equal(fixture.wakes.length, 2);

    fixture.advance(10_000);
    fixture.addMessage(13, 40_000);
    fixture.addMessage(14, 40_001);
    assert.equal((await fixture.router.scanOnce()).results[0].outcome, "wake_cooldown");
    fixture.advance(20_000);
    const third = await fixture.router.scanOnce();
    assert.equal(third.results[0].outcome, "accepted");
    assert.equal(fixture.wakes.length, 3);
    assert.match(fixture.wakes[2].prompt, /pending_message_seqs=\[13,14\]/);
    assert.match(fixture.wakes[2].prompt, /new_message_seqs=\[13,14\]/);
    assert.match(fixture.wakes[2].prompt, /previously_pending_message_seqs=\[\]/);

    fixture.registry.acknowledgeWake({
      taskId: "router-ledger-e2e",
      expectedGeneration: 1,
      processedMessageSeqs: [12],
      wakeId: fixture.wakes[1].wakeId,
    });
    fixture.registry.acknowledgeWake({
      taskId: "router-ledger-e2e",
      expectedGeneration: 1,
      processedMessageSeqs: [13, 14],
      wakeId: fixture.wakes[2].wakeId,
    });
    assert.deepEqual(fixture.registry.get("router-ledger-e2e").pendingMessages, []);
    assert.equal((await fixture.router.scanOnce()).results[0].outcome, "no_new_message");
  } finally {
    fixture.cleanup();
  }
});
