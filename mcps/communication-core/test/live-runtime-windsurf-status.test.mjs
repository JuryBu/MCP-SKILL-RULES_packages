import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockAdapter } from "../src/adapters/mock.mjs";

test("live runtime registers the WSF desktop reader without enabling inbound delivery", async context => {
  const directory = await mkdtemp(join(tmpdir(), "communication-core-wsf-runtime-"));
  const previous = { appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA };
  process.env.APPDATA = directory;
  process.env.LOCALAPPDATA = directory;
  let service;
  let client;
  context.after(async () => {
    try {
      await client?.close();
      await service?.close();
    } finally {
      for (const [name, value] of [["APPDATA", previous.appData], ["LOCALAPPDATA", previous.localAppData]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  let discoveries = 0;
  const original = childProcess.execFile;
  const synthetic = () => { throw new Error("Only the isolated process discovery is expected"); };
  synthetic[promisify.custom] = async (command, args, options) => {
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    assert.equal(options.windowsHide, true);
    discoveries += 1;
    return { stdout: JSON.stringify({ complete: true, processes: [] }) };
  };
  let startLiveFromConfig;
  try {
    childProcess.execFile = synthetic;
    syncBuiltinESMExports();
    ({ startLiveFromConfig } = await import("../src/live-runtime.mjs?isolated_wsf_status"));
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  const caller = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-source-conversation" };
  const configuration = {
    adapter_mode: "live_test",
    allowed_conversation_ids: ["synthetic-ag-target"],
    adapters: [{ id: "synthetic-ag-adapter", kind: "antigravity" }],
    targets: [{ machine_id: caller.machine_id, host: "antigravity", surface: "test", conversation_id: "synthetic-ag-target",
      binding_id: "synthetic-ag-binding", binding_generation: 1, adapter_id: "synthetic-ag-adapter",
      capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" }],
    principals: [{ id: "synthetic-source", token: "synthetic-source-token", identity: caller,
      allowed_targets: ["synthetic-ag-binding"], allowed_target_scopes: [{ machine_id: caller.machine_id, host: "windsurf", surface: "desktop" }] }],
    status_hosts: ["windsurf"],
  };
  const configPath = join(directory, "synthetic-config.json");
  await writeFile(configPath, JSON.stringify(configuration), "utf8");
  service = await startLiveFromConfig({ configPath, stateDir: join(directory, "state"), factories: { antigravity: () => new MockAdapter() } });
  client = new Client({ name: "synthetic-wsf-runtime", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: "Bearer synthetic-source-token" } },
  }));
  const response = await client.callTool({ name: "communication_get_status", arguments: { caller, host: "windsurf" } });
  assert.equal(response.isError, undefined);
  const result = response.structuredContent;
  assert.equal(result.source, "windsurf_devin_desktop_process_and_readonly_sqlite");
  assert.equal(result.host_online, false);
  assert.equal(result.host_can_receive, false);
  assert.equal(result.can_deliver, "unknown");
  assert.deepEqual(result.configured_delivery_modes, { next_model_boundary: false, when_idle: false });
  assert.equal(discoveries, 1);
  assert.equal(result.model_observation.current_selection.code, "model_conversation_required");
  assert.throws(() => service.core.resolveTarget({ principal_id: "synthetic-source" }, { caller, host: "windsurf", conversation_id: "synthetic-pewter" }), { code: "host_not_enabled" });
});
