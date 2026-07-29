import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExaKeyPool,
  buildExaEndpointConfig,
  classifyExaToolResult,
} from "../exa-key-pool.mjs";

function createTempStatePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "exa-key-pool-"));
  return path.join(directory, "state.json");
}

function createPool(options = {}) {
  const config = buildExaEndpointConfig({
    EXA_MCP_REMOTE_URL: "https://mcp.exa.ai/mcp?exaApiKey=legacy-key",
    EXA_MCP_API_KEYS: "second-key,third-key",
    EXA_MCP_PUBLIC_FALLBACK_ENABLED: "1",
  });
  return new ExaKeyPool({
    endpoints: config.endpoints,
    statePath: options.statePath || createTempStatePath(),
    cooldownMs: options.cooldownMs ?? 1000,
    cooldownJitterMs: options.cooldownJitterMs ?? 0,
    rateLimitCooldownMs: options.rateLimitCooldownMs ?? 100,
    now: options.now || (() => 100000),
    random: () => 0.5,
    logger: { error() {} },
  });
}

test("buildExaEndpointConfig combines legacy and additional keys without duplicates", () => {
  const config = buildExaEndpointConfig({
    EXA_MCP_REMOTE_URL: "https://mcp.exa.ai/mcp?exaApiKey=legacy-key",
    EXA_MCP_API_KEYS: "second-key,third-key,second-key",
  });
  assert.equal(config.endpoints.length, 3);
  assert.deepEqual(
    config.endpoints.map((endpoint) => endpoint.apiKey),
    ["legacy-key", "second-key", "third-key"],
  );
  assert.ok(config.endpoints.every((endpoint) => !endpoint.url.includes("exaApiKey")));
  assert.equal(config.publicEndpoint.url, "https://mcp.exa.ai/mcp");
});

test("healthy endpoints are selected in deterministic round-robin order", () => {
  const pool = createPool();
  const selected = [];
  for (let index = 0; index < 4; index += 1) {
    const selection = pool.select();
    selected.push(selection.endpoint.id);
    pool.reportSuccess(selection);
  }
  assert.equal(selected[0], selected[3]);
  assert.equal(new Set(selected.slice(0, 3)).size, 3);
});

test("quota failures open an endpoint and allow one half-open probe after cooldown", () => {
  let currentTime = 100000;
  const pool = createPool({ now: () => currentTime });
  const first = pool.select();
  pool.reportFailure(first, { kind: "quota", reason: "NO_MORE_CREDITS" });

  const second = pool.select();
  assert.notEqual(second.endpoint.id, first.endpoint.id);
  pool.reportSuccess(second);
  const third = pool.select();
  assert.notEqual(third.endpoint.id, first.endpoint.id);
  pool.reportSuccess(third);

  currentTime += 1001;
  const probe = pool.select();
  assert.equal(probe.endpoint.id, first.endpoint.id);
  assert.equal(probe.probe, true);

  const concurrent = pool.select();
  assert.notEqual(concurrent.endpoint.id, first.endpoint.id);
  pool.reportSuccess(concurrent);
  pool.reportSuccess(probe);
  assert.equal(pool.snapshot().endpoints[first.endpoint.id].status, "healthy");
});

test("open state survives process-style pool recreation", () => {
  const statePath = createTempStatePath();
  const firstPool = createPool({ statePath });
  const first = firstPool.select();
  firstPool.reportFailure(first, { kind: "quota", reason: "NO_MORE_CREDITS" });

  const secondPool = createPool({ statePath });
  const selected = secondPool.select();
  assert.notEqual(selected.endpoint.id, first.endpoint.id);
  assert.equal(secondPool.snapshot().endpoints[first.endpoint.id].status, "open");
});

test("MCP result errors classify quota, rate limit, and authentication failures", () => {
  const result = (text) => ({ isError: true, content: [{ type: "text", text }] });
  assert.equal(classifyExaToolResult(result("web_search_exa error (402): credits limit")).kind, "quota");
  assert.equal(classifyExaToolResult(result("web_search_exa error (429): rate limit")).kind, "rate_limit");
  assert.equal(classifyExaToolResult(result("web_search_exa error (401): invalid API key")).kind, "auth");
  assert.equal(classifyExaToolResult(result("invalid query parameters")), null);
});
