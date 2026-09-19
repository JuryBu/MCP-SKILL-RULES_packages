import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../ops/switch-codex-model-stream-proxy.ps1", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };

async function withFixture(run, healthy = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-switch-test-"));
  const configPath = path.join(root, "配置.toml");
  const backupRoot = path.join(root, "backups");
  const originalText = [
    'model = "fixture-model"',
    'model_reasoning_effort = "high"',
    'model_provider = "openai"',
    "",
    "[mcp_servers.fixture]",
    'command = "fixture-command"',
    "",
    "[model_providers.other]",
    'base_url = "https://example.invalid/v1"',
    "",
  ].join("\r\n");
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(originalText)]);
  fs.writeFileSync(configPath, original);
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/health");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: healthy }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  async function invoke(action, extra = []) {
    const result = await execute("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Action", action, "-ConfigPath", configPath, "-BackupRoot", backupRoot, "-Port", String(port), ...extra,
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
    return JSON.parse(result.stdout.trim());
  }
  try {
    await run({ configPath, backupRoot, original, originalText, port, invoke });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "codex-provider-switch-test-")));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("provider preview leaves exact configuration and backup directory untouched", windowsOnly, async () => {
  await withFixture(async ({ configPath, backupRoot, original, invoke }) => {
    const preview = await invoke("Preview");
    assert.equal(preview.changed, true);
    assert.equal(preview.restartCodexRequired, true);
    assert.deepEqual(fs.readFileSync(configPath), original);
    assert.equal(fs.existsSync(backupRoot), false);
  });
});

test("provider activation preserves settings, enables finite native retries and rolls back exact bytes", windowsOnly, async () => {
  await withFixture(async ({ configPath, original, originalText, port, invoke }) => {
    const applied = await invoke("Apply");
    const installedBytes = fs.readFileSync(configPath);
    const installed = installedBytes.toString("utf8");
    assert.equal(applied.changed, true);
    assert.deepEqual(fs.readFileSync(applied.backupPath), original);
    assert.deepEqual(installedBytes.subarray(0, 3), original.subarray(0, 3));
    assert.match(installed, /^stream_max_retries = 5\r?$/mu);
    assert.match(installed, /^stream_idle_timeout_ms = 150000\r?$/mu);
    assert.match(installed, /^requires_openai_auth = true\r?$/mu);
    assert.match(installed, /^supports_websockets = false\r?$/mu);
    assert.ok(installed.includes(`base_url = "http://127.0.0.1:${port}/backend-api/codex"`));
    assert.equal(installed.split("[model_providers.local_model_stream_proxy]").length, 2);
    const restoredText = installed.replace(/^\uFEFF/u, "")
      .replace(/\r\n\r\n\[model_providers\.local_model_stream_proxy\][\s\S]*$/u, "\r\n")
      .replace('model_provider = "local_model_stream_proxy"', 'model_provider = "openai"');
    assert.deepEqual(restoredText.split("\r\n").filter(Boolean), originalText.split("\r\n").filter(Boolean));
    const repeated = await invoke("Apply");
    assert.equal(repeated.changed, false);
    assert.deepEqual(fs.readFileSync(configPath), installedBytes);
    const rollback = await invoke("Rollback", ["-RollbackBackupPath", applied.backupPath]);
    assert.equal(rollback.restartCodexRequired, true);
    assert.deepEqual(fs.readFileSync(configPath), original);
  });
});

test("unhealthy model proxy refuses activation without changing configuration", windowsOnly, async () => {
  await withFixture(async ({ configPath, backupRoot, original, invoke }) => {
    await assert.rejects(invoke("Apply"), /health check failed/u);
    assert.deepEqual(fs.readFileSync(configPath), original);
    assert.equal(fs.existsSync(backupRoot), false);
  }, false);
});
