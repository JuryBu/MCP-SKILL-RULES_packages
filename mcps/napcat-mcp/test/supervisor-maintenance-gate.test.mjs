import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../ops/start-napcat-supervisor.ps1", import.meta.url));

for (const content of ["{\"owner\":\"fixture\"}", "invalid-marker-keeps-maintenance-closed"]) {
  test(`supervisor maintenance preserves all files before any startup: ${content}`, { skip: process.platform !== "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-supervisor-gate-"));
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    const marker = path.join(state, "supervisor-maintenance.json");
    const stop = path.join(state, "supervisor.stop");
    fs.writeFileSync(marker, content);
    fs.writeFileSync(stop, "owned-stop-marker");
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-DataRoot", root, "-BrokerRoot", path.join(root, "missing-broker")], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reason, "maintenance");
      assert.equal(fs.readFileSync(marker, "utf8"), content);
      assert.equal(fs.readFileSync(stop, "utf8"), "owned-stop-marker");
      assert.deepEqual(fs.readdirSync(root), ["state"]);
      assert.deepEqual(fs.readdirSync(state).sort(), ["supervisor-maintenance.json", "supervisor.stop"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
