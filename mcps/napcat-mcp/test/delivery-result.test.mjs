import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrackedDelivery, withOutgoingDeliveryTracking } from "../src/delivery-result.mjs";

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

test("successful delivery tracking preserves the authoritative send result", () => {
  const calls = [];
  const result = withOutgoingDeliveryTracking(
    { sent: true, verified: true, deliveryId: "delivery-1", messageId: 77 },
    {
      task_id: "task-1",
      source_machine: "development",
      target_machine: "training",
    },
    (delivery) => calls.push(delivery),
  );
  assert.deepEqual(calls, [{
    deliveryId: "delivery-1",
    taskId: "task-1",
    sourceMachine: "development",
    targetMachine: "training",
    messageSeq: 77,
  }]);
  assert.equal(result.sent, true);
  assert.equal(result.verified, true);
  assert.equal(result.deliveryTracked, true);
  assert.equal(result.deliveryTrackingError, null);
});

test("post-send tracking failure is returned as a non-retryable degraded success", () => {
  const error = new Error("control state rename failed");
  error.code = "STATE_WRITE_FAILED";
  error.details = { statePath: "control-state.json" };
  const result = withOutgoingDeliveryTracking(
    { sent: true, verified: true, deliveryId: "delivery-1", messageId: 77 },
    {
      task_id: "task-1",
      source_machine: "development",
      target_machine: "training",
    },
    () => {
      throw error;
    },
  );
  assert.equal(result.sent, true);
  assert.equal(result.verified, true);
  assert.equal(result.deliveryTracked, false);
  assert.equal(result.retryRecommended, false);
  assert.deepEqual(result.deliveryTrackingError, {
    code: "STATE_WRITE_FAILED",
    message: "control state rename failed",
    outcomeUnknown: false,
    details: { statePath: "control-state.json" },
  });
});
