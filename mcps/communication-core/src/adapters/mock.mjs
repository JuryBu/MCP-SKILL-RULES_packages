import { identityKey } from "../contracts.mjs";

export class MockAdapter {
  constructor({ mode = "accept", now = () => Date.now() } = {}) {
    this.mode = mode;
    this.now = now;
    this.calls = [];
    this.queries = [];
    this.receipts = new Map();
  }

  async deliver({ message, delivery, target, signal }) {
    const identity = {
      delivery_id: delivery.delivery_id,
      target_key: identityKey(target),
    };
    if (signal?.aborted) return { ...identity, outcome: "failed_before_send", reason: "aborted_before_mock_send" };
    this.calls.push({ message_id: message.message_id, ...identity });
    if (this.mode === "busy") return { ...identity, outcome: "busy", reason: "simulated_busy" };
    if (this.mode === "unknown") return { ...identity, outcome: "unknown", reason: "simulated_unknown" };
    const existing = this.receipts.get(delivery.delivery_id);
    if (existing) return structuredClone(existing);
    const receipt = {
      ...identity,
      outcome: "accepted",
      host_request_id: `mock:${delivery.delivery_id}`,
      evidence: { kind: "simulated", observed_at: new Date(this.now()).toISOString() },
    };
    this.receipts.set(delivery.delivery_id, receipt);
    if (this.mode === "throw_after_accept") throw new Error("simulated_disconnect_after_accept");
    return structuredClone(receipt);
  }

  async query({ delivery, target }) {
    this.queries.push(delivery.delivery_id);
    return structuredClone(this.receipts.get(delivery.delivery_id) ?? {
      outcome: "unknown",
      delivery_id: delivery.delivery_id,
      target_key: identityKey(target),
      reason: "no_simulated_receipt",
    });
  }

  async close() {
  }
}
