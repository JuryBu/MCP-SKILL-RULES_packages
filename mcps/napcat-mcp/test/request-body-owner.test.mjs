import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequestBodyOwner, createRequestBufferBudget } from "../src/request-body-buffer.mjs";

function fixture() {
  const budget = createRequestBufferBudget(1024);
  const lease = budget.lease();
  const owner = createRequestBodyOwner(lease);
  const body = Buffer.alloc(512, 42);
  assert.equal(lease.reserve(body.length), true);
  owner.assign(body);
  return { budget, owner, body };
}

test("submitted body drops the owner reference but keeps credit until local write finishes", () => {
  const { budget, owner, body } = fixture();
  const upstream = new EventEmitter();
  let submitted;
  upstream.end = value => { submitted = value; };
  let finishedBytes;
  owner.submit(upstream, bytes => { finishedBytes = bytes; });
  assert.equal(submitted, body);
  assert.equal(owner.body, null);
  assert.equal(owner.bytes, 512);
  assert.equal(budget.status().usedBytes, 512);
  owner.releaseUnused();
  assert.equal(budget.status().usedBytes, 512);
  upstream.emit("finish");
  assert.equal(finishedBytes, 512);
  assert.equal(budget.status().usedBytes, 0);
  upstream.emit("close");
  assert.equal(budget.status().usedBytes, 0);
});

test("closed upload releases credit without claiming a successful handoff", () => {
  const { budget, owner } = fixture();
  const upstream = new EventEmitter();
  upstream.end = () => {};
  let handoffs = 0;
  owner.submit(upstream, () => { handoffs += 1; });
  upstream.emit("close");
  assert.equal(handoffs, 0);
  assert.equal(budget.status().usedBytes, 0);
  owner.releaseUnused();
  assert.equal(budget.status().usedBytes, 0);
});

test("finish while a writer is already destroyed does not report a successful handoff", () => {
  const { budget, owner } = fixture();
  const upstream = new EventEmitter();
  upstream.end = () => {};
  let handoffs = 0;
  owner.submit(upstream, () => { handoffs += 1; });
  upstream.destroyed = true;
  upstream.emit("finish");
  upstream.emit("close");
  assert.equal(handoffs, 0);
  assert.equal(budget.status().usedBytes, 0);
});

test("synchronous submit failure closes the writer and waits for close before releasing credit", () => {
  const { budget, owner } = fixture();
  const upstream = new EventEmitter();
  const failure = new Error("fixture write failure");
  let destroyed = false;
  upstream.end = () => { throw failure; };
  upstream.destroy = () => { destroyed = true; };
  assert.throws(() => owner.submit(upstream), error => error === failure);
  assert.equal(destroyed, true);
  assert.equal(owner.body, null);
  assert.equal(budget.status().usedBytes, 512);
  owner.releaseUnused();
  assert.equal(budget.status().usedBytes, 512);
  upstream.emit("close");
  assert.equal(budget.status().usedBytes, 0);
});

test("unsubmitted body is released on early terminal paths exactly once", () => {
  const { budget, owner } = fixture();
  owner.releaseUnused();
  owner.releaseUnused();
  assert.equal(owner.body, null);
  assert.equal(budget.status().usedBytes, 0);
});

test("a submitted owner cannot forward the same encoded body twice", () => {
  const { budget, owner } = fixture();
  const upstream = new EventEmitter();
  upstream.end = () => {};
  owner.submit(upstream);
  assert.throws(() => owner.submit(upstream), /cannot be submitted twice/u);
  assert.throws(() => owner.assign(Buffer.alloc(1)), /already assigned/u);
  upstream.emit("close");
  assert.equal(budget.status().usedBytes, 0);
});
