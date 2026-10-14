import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createManagedInnerProxySession, validateManagedSessionConfiguration } from "../src/inner-managed-session.mjs";

function configuration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-managed-options-"));
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home);
  const files = ["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"];
  return { mode: "isolated", checkpointRoot: root, codexHome: home, innerPort: 39801,
    outerArguments: [...files.flatMap(name => [`--${name}`, path.join(root, `${name}.json`)]),
      "--codex-exe", process.execPath, "--downstream-port", "39802", "--control-port", "39803",
      "--upstream-port", "39804", "--probe-port", "39805", "--empty-client-restart-ms", "0"] };
}

test("managed session accepts only explicit temporary inputs", () => {
  const input = configuration();
  const result = validateManagedSessionConfiguration(input);
  assert.equal(result.options.emptyClientRestartMs, 0);
  assert.equal(result.home, fs.realpathSync(input.codexHome));
});

test("managed session rejects an incomplete production profile before parsing or acquiring resources", () => {
  assert.throws(() => validateManagedSessionConfiguration({ mode: "production" }), /MANAGED_SESSION_PRODUCTION_ARGUMENTS_REQUIRED/);
});

test("managed session rejects state outside its temporary root", () => {
  const input = configuration();
  input.outerArguments[1] = path.join(os.tmpdir(), "outside-managed-state.json");
  assert.throws(() => validateManagedSessionConfiguration(input), /PATH_OUTSIDE_ROOT/);
});

test("managed session rejects a shared home and duplicate ports", () => {
  const input = configuration();
  assert.throws(() => validateManagedSessionConfiguration({ ...input, codexHome: os.tmpdir() }), /HOME_REQUIRED/);
  assert.throws(() => validateManagedSessionConfiguration({ ...input, innerPort: 39802 }), /DISTINCT_PORTS_REQUIRED/);
});

test("managed session preserves a preexisting stop requirement", () => {
  const input = configuration();
  const stopPath = input.outerArguments[input.outerArguments.indexOf("--stop-file") + 1];
  fs.writeFileSync(stopPath, "other-owner");
  assert.throws(() => validateManagedSessionConfiguration(input), /STOP_REQUIREMENT_PRESENT/);
  assert.equal(fs.readFileSync(stopPath, "utf8"), "other-owner");
});

test("normal runner startup failure preserves the occupied endpoint and ends its own worker", { timeout: 30000 }, async () => {
  const configurationValue = configuration();
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const descriptor = { runnerPath: path.join(source, "codex-model-stream-proxy-runner.mjs"), expectedHashes: {} };
  for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    descriptor.expectedHashes[name] = crypto.createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex");
  }
  const listener = net.createServer(socket => socket.end("OLD_ENDPOINT_PRESERVED"));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const allocate = async () => {
    const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
  };
  configurationValue.innerPort = await allocate();
  for (const [name, port] of [["downstream-port", listener.address().port], ["control-port", await allocate()],
    ["upstream-port", await allocate()], ["probe-port", await allocate()]]) {
    configurationValue.outerArguments[configurationValue.outerArguments.indexOf(`--${name}`) + 1] = String(port);
  }
  Object.assign(configurationValue, { ownerId: "managed-startup-failure", nativeSourceId: "managed-native", initial: descriptor,
    upstreamOrigin: "http://127.0.0.1:9", environment: { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100" } });
  const events = [];
  const session = createManagedInnerProxySession(configurationValue, event => events.push(event));
  try {
    await assert.rejects(session.start());
    const state = session.status();
    assert.equal(state.closed, true);
    assert.equal(state.outerFinished, true);
    assert.equal(state.outerResult.state, "failed");
    assert.equal(state.coordinator.workers.length, 1);
    assert.equal(state.coordinator.workers[0].alive, false);
    assert.equal(state.coordinator.workers[0].exitCode, 0);
    assert.equal(listener.listening, true);
    const client = net.connect(listener.address().port, "127.0.0.1");
    let reply = "";
    client.on("data", chunk => { reply += chunk; });
    await once(client, "close");
    assert.equal(reply, "OLD_ENDPOINT_PRESERVED");
    fs.writeFileSync(path.join(configurationValue.checkpointRoot, "startup-failure-evidence.json"), JSON.stringify({ events, state, reply }, null, 2));
    console.log(`managed failure evidence: ${configurationValue.checkpointRoot}`);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
