import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startFromConfig } from "../src/cli.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("受限SDK客户端在真实子进程调用MCP，沿原请求去重且不输出token", async context => {
  const directory = await mkdtemp(join(tmpdir(), "communication-scoped-client-"));
  let service;
  context.after(async () => { await service?.close(); await rm(directory, { recursive: true }); });
  const configuration = JSON.parse(await readFile(join(root, "examples/isolation.config.json"), "utf8"));
  const source = configuration.principals[0];
  const target = configuration.targets[1];
  const configPath = join(directory, "config.json");
  const endpointPath = join(directory, "endpoint.json");
  const connectionPath = join(directory, "source.json");
  const requestPath = join(directory, "request.json");
  await writeFile(configPath, JSON.stringify(configuration));
  service = await startFromConfig({ configPath, stateDir: join(directory, "state") });
  await writeFile(endpointPath, JSON.stringify({ state: "listening", url: service.url }));
  await writeFile(connectionPath, JSON.stringify({ endpoint_file: endpointPath, token: source.token }));
  const { adapter_id, capabilities, evidence, ...address } = target;
  await writeFile(requestPath, JSON.stringify({ input: { caller: source.identity, origin: { kind: "agent_message", channel: "test", source_ref: "scoped-source" }, target: address, dedupe_key: "stable-scoped-message", text: "隔离客户端测试", expires_at: new Date(Date.now() + 60000).toISOString() } }));
  const runs = [];
  for (let run = 0; run < 2; run += 1) {
    const resultPath = join(directory, `result-${run}.json`);
    const output = await execute(process.execPath, [join(root, "scripts/mcp-client.mjs"), "--connection", connectionPath, "--request", requestPath, "--result", resultPath, "--until", "delivery", "--wait-ms", "5000"], { windowsHide: true, timeout: 15000, maxBuffer: 8192, encoding: "utf8" });
    assert.equal(output.stdout.includes(source.token), false);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.phase, "delivery_observed");
    assert.equal(result.snapshot.delivery.status, "accepted");
    runs.push(result);
  }
  assert.equal(runs[1].duplicate, true);
  assert.equal(runs[0].message_id, runs[1].message_id);
  assert.equal(runs[0].delivery_id, runs[1].delivery_id);
});
