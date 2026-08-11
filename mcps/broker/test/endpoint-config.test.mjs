import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BACKEND_STARTUP_TIMEOUT_MS,
  MAX_BACKEND_STARTUP_TIMEOUT_MS,
  MIN_BACKEND_STARTUP_TIMEOUT_MS,
  getEndpointStartupTimeoutEnvKey,
  normalizeBackendStartupTimeoutMs,
  resolveEndpointStartupTimeoutMs,
} from "../endpoint-config.mjs";

test("endpoint startup timeout keeps the 15 second default", () => {
  assert.equal(resolveEndpointStartupTimeoutMs("wechat-docs", { env: {} }), DEFAULT_BACKEND_STARTUP_TIMEOUT_MS);
  assert.equal(getEndpointStartupTimeoutEnvKey("wechat-docs"), "CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS");
});

test("endpoint private timeout overrides the shared and process values", () => {
  assert.equal(resolveEndpointStartupTimeoutMs("wechat-docs", {
    env: {
      CODEX_MCP_BROKER_STARTUP_TIMEOUT_MS: "20000",
      CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS: "30000",
    },
    privateEnv: {
      CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS: "300000",
    },
  }), 300000);
});

test("endpoint startup timeout rejects invalid values and clamps safe bounds", () => {
  assert.equal(normalizeBackendStartupTimeoutMs("invalid", 42000), 42000);
  assert.equal(normalizeBackendStartupTimeoutMs(1, 42000), MIN_BACKEND_STARTUP_TIMEOUT_MS);
  assert.equal(normalizeBackendStartupTimeoutMs(9999999, 42000), MAX_BACKEND_STARTUP_TIMEOUT_MS);
});
