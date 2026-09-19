import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { toolIdentityHash } from "../src/tool-delivery-profile.mjs";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

for (const scenario of ["absent", "valid"]) {
  test(`runner loads ${scenario} synthetic profile without exposing its contents`, async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-v3-profile-"));
    const portReservation = http.createServer();
    let child;
    try {
      if (scenario === "valid") {
        fs.writeFileSync(path.join(stateRoot, "codex-model-stream-delivery-profiles.json"), JSON.stringify({
          schemaVersion: 1, bufferedToolIdentityHashes: [toolIdentityHash({ name: "fixture_writer" })],
        }), "utf8");
      }
      portReservation.listen(0, "127.0.0.1");
      await once(portReservation, "listening");
      const port = portReservation.address().port;
      await new Promise(resolve => portReservation.close(resolve));
      child = spawn(process.execPath, [path.resolve("src/codex-model-stream-proxy-runner.mjs")], {
        windowsHide: true,
        env: { ...process.env, CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot, CODEX_MODEL_STREAM_PROXY_PORT: String(port),
          CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:1" },
        stdio: "ignore",
      });
      const runtimePath = path.join(stateRoot, "codex-model-stream-proxy-runtime.json");
      const deadline = Date.now() + 7_000;
      while (!fs.existsSync(runtimePath) && child.exitCode === null && Date.now() < deadline) await pause(30);
      assert.equal(child.exitCode, null);
      const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
      assert.equal(runtime.bufferedToolProfileCount, scenario === "valid" ? 1 : 0);
      assert.equal(runtime.toolPreparationGraceMs, 120_000);
      assert.equal(runtime.bufferedToolPreparationGraceMs, 300_000);
      fs.writeFileSync(path.join(stateRoot, "codex-model-stream-proxy.stop"), "test complete", "utf8");
      await Promise.race([once(child, "close"), pause(2_500)]);
      assert.notEqual(child.exitCode, null);
      assert.equal(fs.existsSync(path.join(stateRoot, "codex-model-stream-proxy.lock.json")), false);
    } finally {
      if (child?.exitCode === null) child.kill();
      if (portReservation.listening) await new Promise(resolve => portReservation.close(resolve));
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
}
