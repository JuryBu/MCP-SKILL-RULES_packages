import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const source = { machine_id: "test-machine", host: "antigravity", surface: "desktop", conversation_id: "test-agent" };
const context = { principal_id: "test-principal" };
const sentinel = "synthetic-secret-never-a-real-credential";

function fixture(directory, { host = "qq", outcome = "accepted", nativeReceipt = {} } = {}) {
  const target = {
    machine_id: "test-machine", host, surface: host === "qq" ? "group" : "desktop", conversation_id: "test-receiver",
    binding_id: "test-binding", binding_generation: 1, adapter_id: "test-adapter",
    capabilities: { next_model_boundary: true, when_idle: false }, evidence: "fixture",
  };
  const store = new MessageStore({ filePath: join(directory, "messages.sqlite") });
  const state = { sends: 0 };
  const core = new CommunicationCore({
    store, targets: [target], principals: [{ id: context.principal_id, identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] }],
    adapters: { "test-adapter": { async deliver(request) {
      state.sends += 1;
      return {
        outcome, delivery_id: request.delivery.delivery_id, target_key: identityKey(target),
        evidence: { kind: "receipt", native_receipt: { provider: "napcat_owner", message_id: "-123456", verified: true, state_persisted: true, ...nativeReceipt } },
      };
    } } },
  });
  const input = {
    caller: source, target: Object.fromEntries(Object.entries(target).filter(([key]) => !["adapter_id", "capabilities", "evidence"].includes(key))),
    origin: { kind: "agent_message", channel: "test", source_ref: "receipt-test" }, dedupe_key: "receipt-test", text: "测试正文",
    expires_at: "2031-01-01T00:00:00Z",
  };
  return { core, store, state, input };
}

test("verified QQ native receipt survives SQLite reopen without resending the accepted message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "communication-qq-receipt-"));
  let active;
  try {
    active = fixture(directory);
    await active.core.start();
    const sent = await active.core.sendMessage(context, active.input);
    await active.core.drain();
    const receipt = active.store.getDelivery(sent.delivery.delivery_id).evidence.evidence.native_receipt;
    assert.deepEqual(receipt, { provider: "napcat_owner", message_id: "-123456", verified: true, state_persisted: true });
    assert.equal(active.state.sends, 1);
    await active.core.close();
    active.store.close();
    active = fixture(directory);
    await active.core.start();
    const duplicate = await active.core.sendMessage(context, active.input);
    await active.core.drain();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.message_id, sent.message.message_id);
    assert.equal(duplicate.delivery.delivery_id, sent.delivery.delivery_id);
    assert.deepEqual(duplicate.delivery.evidence.evidence.native_receipt, receipt);
    assert.equal(active.state.sends, 0);
    assert.equal(duplicate.message.processing, "pending");
  } finally {
    await active?.core.close();
    active?.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const patch of [
  { nativeReceipt: { message_id: sentinel } },
  { nativeReceipt: { verified: false } },
  { nativeReceipt: { state_persisted: false } },
  { nativeReceipt: { provider: sentinel } },
  { host: "codex" },
  { outcome: "unknown" },
]) {
  test(`native receipt whitelist discards ${JSON.stringify(patch)}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "communication-qq-receipt-safe-"));
    const { core, store, input } = fixture(directory, patch);
    try {
      await core.start();
      const sent = await core.sendMessage(context, input);
      await core.drain();
      const snapshot = core.getMessage(context, { caller: source, message_id: sent.message.message_id });
      assert.equal(snapshot.delivery.evidence.evidence.native_receipt, undefined);
      assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
      for (const suffix of ["", "-wal", "-shm"]) {
        const filePath = join(directory, "messages.sqlite") + suffix;
        if (existsSync(filePath)) assert.equal(readFileSync(filePath).includes(Buffer.from(sentinel)), false);
      }
    } finally {
      await core.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
