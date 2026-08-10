import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrackedDelivery } from "../src/delivery-result.mjs";

test("fresh and same-dedupe existing results resolve the same delivery identity", () => {
  assert.deepEqual(resolveTrackedDelivery({ deliveryId: "delivery-1", messageId: 77 }), {
    deliveryId: "delivery-1",
    messageSeq: 77,
  });
  assert.deepEqual(resolveTrackedDelivery({
    existing: { deliveryId: "delivery-1", messageId: 77 },
  }), {
    deliveryId: "delivery-1",
    messageSeq: 77,
  });
});

test("incomplete delivery results are not tracked", () => {
  assert.equal(resolveTrackedDelivery({ messageId: 77 }), null);
  assert.equal(resolveTrackedDelivery({ deliveryId: "delivery-1" }), null);
  assert.equal(resolveTrackedDelivery({ deliveryId: "delivery-1", messageId: -1 }), null);
});
