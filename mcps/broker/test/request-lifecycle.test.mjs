import assert from "node:assert/strict";
import test from "node:test";

import { shouldTrackBackendWork } from "../request-lifecycle.mjs";

test("long-lived GET subscriptions do not block scoped backend reload", () => {
  assert.equal(shouldTrackBackendWork("GET"), false);
  assert.equal(shouldTrackBackendWork("get"), false);
});

test("mutating and request-bearing methods still drain before reload", () => {
  assert.equal(shouldTrackBackendWork("POST"), true);
  assert.equal(shouldTrackBackendWork("DELETE"), true);
  assert.equal(shouldTrackBackendWork(undefined), true);
});
