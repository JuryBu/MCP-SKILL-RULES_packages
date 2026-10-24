import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readModelRuntimeEnvironment } from "../src/model-runtime-policy.mjs";

const corePath = fileURLToPath(new URL("../src/codex-model-stream-proxy.mjs", import.meta.url));
const runnerPath = fileURLToPath(new URL("../src/codex-model-stream-proxy-runner.mjs", import.meta.url));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const originalEnvironment = {
  CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "0",
  CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: "0",
  CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS: "4",
  CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "16000",
  CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "600000",
};
const candidatePolicy = () => ({ schemaVersion: 1, sourceCoreSha256: hash(fs.readFileSync(corePath)),
  incrementalWs: true, incrementalImages: true, maxWsSessions: 32, uploadAllowanceMsPerMiB: 33555, maxUploadAllowanceMs: 4295040 });

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-runtime-policy-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "codex-model-runtime-policy.json");
  return { root, filename, write(value) { fs.writeFileSync(filename, JSON.stringify(value)); },
    read() { return readModelRuntimeEnvironment({ stateRoot: root, corePath, environment: originalEnvironment }); } };
}

test("missing and other-core policies preserve inherited runtime settings", context => {
  const value = fixture(context);
  assert.deepEqual(value.read(), originalEnvironment);
  value.write({ ...candidatePolicy(), sourceCoreSha256: "0".repeat(64) });
  assert.deepEqual(value.read(), originalEnvironment);
});

test("candidate policy overrides only its declared settings without changing the parent", context => {
  const value = fixture(context);
  value.write(candidatePolicy());
  assert.deepEqual(value.read(), {
    CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "1", CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: "1",
    CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS: "32",
    CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "33555", CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "4295040",
  });
  assert.equal(originalEnvironment.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS, "0");
  assert.equal(originalEnvironment.CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS, "4");
});

test("malformed matching candidate settings fail before any worker request", context => {
  const value = fixture(context);
  for (const change of [{ incrementalWs: "1" }, { maxUploadAllowanceMs: -1 }, { token: "invalid-field" }, { sourceCoreSha256: "bad" },
    { maxWsSessions: 0 }, { maxWsSessions: 129 }, { maxWsSessions: 4.5 }, { maxWsSessions: "32" }]) {
    value.write({ ...candidatePolicy(), ...change });
    assert.throws(value.read, /MODEL_RUNTIME_POLICY_INVALID/u);
  }
});

test("versioned candidate settings preserve the matching fallback upload policy", context => {
  const value = fixture(context);
  const fallbackCorePath = path.join(value.root, "fallback-core.mjs");
  fs.writeFileSync(fallbackCorePath, "export const version = 'fallback';");
  const fallbackPolicy = { ...candidatePolicy(), sourceCoreSha256: hash(fs.readFileSync(fallbackCorePath)),
    incrementalWs: false, incrementalImages: false };
  value.write(fallbackPolicy);
  const originalBytes = fs.readFileSync(value.filename);
  const versionedPath = path.join(value.root, `codex-model-runtime-policy-${candidatePolicy().sourceCoreSha256}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(candidatePolicy()));
  assert.equal(value.read().CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS, "1");
  const fallback = readModelRuntimeEnvironment({ stateRoot: value.root, corePath: fallbackCorePath, environment: originalEnvironment });
  assert.equal(fallback.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS, "0");
  assert.equal(fallback.CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB, "33555");
  assert.equal(fallback.CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS, "4295040");
  assert.deepEqual(fs.readFileSync(value.filename), originalBytes);
  fs.writeFileSync(versionedPath, JSON.stringify(fallbackPolicy));
  assert.throws(value.read, /MODEL_RUNTIME_POLICY_CORE_MISMATCH/u);
  fs.writeFileSync(versionedPath, "{");
  assert.throws(value.read, SyntaxError);
});

test("a selected versioned policy disappearing fails instead of reverting to inherited settings", context => {
  const value = fixture(context);
  const versionedPath = path.join(value.root, `codex-model-runtime-policy-${candidatePolicy().sourceCoreSha256}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(candidatePolicy()));
  const lstat = fs.lstatSync;
  let reads = 0;
  context.mock.method(fs, "lstatSync", function(filename, ...options) {
    if (filename === versionedPath && ++reads === 2) fs.unlinkSync(versionedPath);
    return lstat.call(this, filename, ...options);
  });
  assert.throws(value.read, { code: "ENOENT" });
});

for (const mode of ["candidate", "fallback", "versioned"]) test(`real runner reads ${mode} configuration once`, { timeout: 15000 }, async context => {
  const matching = mode !== "fallback";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-policy-runner-"));
  const workerRoot = path.join(root, "worker");
  fs.mkdirSync(workerRoot);
  const policyPath = path.join(workerRoot, "codex-model-runtime-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ ...candidatePolicy(), ...(matching ? {} : { sourceCoreSha256: "0".repeat(64) }) }));
  if (mode === "versioned") {
    fs.writeFileSync(policyPath, JSON.stringify({ ...candidatePolicy(), incrementalWs: false, incrementalImages: false }));
    fs.writeFileSync(path.join(workerRoot, `codex-model-runtime-policy-${candidatePolicy().sourceCoreSha256}.json`), JSON.stringify(candidatePolicy()));
  }
  const child = fork(runnerPath, [], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: {
    ...process.env, ...originalEnvironment,
    CODEX_MODEL_STREAM_PROXY_STATE_ROOT: workerRoot,
    CODEX_MODEL_STREAM_PROXY_HOST: "127.0.0.1", CODEX_MODEL_STREAM_PROXY_PORT: "0",
    CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:9",
    CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "1",
    CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL: "ws://127.0.0.1:9/v1/responses",
    CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
    CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify({ schemaVersion: 1, mode: "isolated",
      ownerId: "runtime-policy-test", nativeSourceId: "runtime-policy-native", capability: crypto.randomBytes(32).toString("hex"), checkpointRoot: root }),
  } });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimePath = path.join(workerRoot, "codex-model-stream-proxy-runtime.json");
  const deadline = Date.now() + 10000;
  let runtime;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`RUNNER_EXITED:${stderr}`);
    try { runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")); } catch {}
    if (runtime?.status === "running") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(runtime?.status, "running", stderr);
  assert.equal(runtime.incrementalEnabled, matching);
  assert.equal(runtime.incrementalImagesEnabled, matching);
  assert.equal(runtime.uploadAllowanceMsPerMiB, matching ? 33555 : 16000);
  assert.equal(runtime.maxUploadAllowanceMs, matching ? 4295040 : 600000);
  if (matching) assert.equal(runtime.incrementalTransport.maxSessions, 32);
  fs.writeFileSync(policyPath, JSON.stringify({ ...candidatePolicy(), incrementalWs: !matching }));
  await new Promise(resolve => setTimeout(resolve, 150));
  const unchanged = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  assert.equal(unchanged.pid, runtime.pid);
  assert.equal(unchanged.incrementalEnabled, matching);
});
