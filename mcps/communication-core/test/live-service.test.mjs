import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveService } from "../scripts/live-service.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeUrl = pathToFileURL(join(root, "src/live-runtime.mjs")).href;
const mockUrl = pathToFileURL(join(root, "src/adapters/mock.mjs")).href;
const mockLoader = `import { registerHooks } from "node:module"; registerHooks({ load(url, context, nextLoad) { if (url === ${JSON.stringify(runtimeUrl)}) return { format: "module", shortCircuit: true, source: ${JSON.stringify(`import { startLiveFromConfig as start } from ${JSON.stringify(`${runtimeUrl}?service-test`)}; import { MockAdapter } from ${JSON.stringify(mockUrl)}; export const startLiveFromConfig = options => start({ ...options, factories: { antigravity: () => new MockAdapter() } });`)} }; return nextLoad(url, context); } });`;
const mockExecArgv = ["--import", `data:text/javascript,${encodeURIComponent(mockLoader)}`];

async function serviceFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "communication-service-factory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "synthetic-config.json");
  await writeFile(configPath, "{}");
  return { directory, configPath, stateDir: join(directory, "synthetic-state"), endpointFile: join(directory, "synthetic-endpoint.json") };
}

test("服务工厂在活动、未知、畸形或归属不符端点前完全不启动", async context => {
  const files = await serviceFixture(context);
  let started = 0;
  const dependencies = { startRuntime: async () => { started += 1; throw new Error("不得构造runtime"); } };
  const base = { pid: process.pid, config_path: files.configPath, state_dir: files.stateDir, url: "http://127.0.0.1:23456/mcp" };
  for (const previous of [JSON.stringify({ ...base, state: "listening" }), JSON.stringify({ ...base, state: "starting" }), "synthetic-malformed", JSON.stringify({ ...base, state: "closed", state_dir: join(files.directory, "other-state") })]) {
    await writeFile(files.endpointFile, previous);
    await assert.rejects(startLiveService(files, dependencies), { code: "runtime_locked" });
    assert.equal(await readFile(files.endpointFile, "utf8"), previous);
  }
  assert.equal(started, 0);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
});

test("同端点启动竞争、启动失败及在途关闭保留原指针与独占", async context => {
  const files = await serviceFixture(context);
  await assert.rejects(startLiveService(files, { startRuntime: async () => { throw new Error("synthetic-startup-failure"); } }), /synthetic-startup-failure/);
  await assert.rejects(stat(`${files.endpointFile}.runtime-lock`), { code: "ENOENT" });
  await assert.rejects(stat(files.endpointFile), { code: "ENOENT" });
  let finishStartup;
  const ready = new Promise(resolveReady => { finishStartup = resolveReady; });
  let entered;
  const entering = new Promise(resolveEntered => { entered = resolveEntered; });
  let finishClose;
  const closing = new Promise(resolveClose => { finishClose = resolveClose; });
  const starting = startLiveService(files, { startRuntime: async () => { entered(); await ready; return { url: "http://127.0.0.1:23456/mcp", close: () => closing }; } });
  await entering;
  try {
    await assert.rejects(startLiveService({ ...files, stateDir: join(files.directory, "different-state") }, { startRuntime: () => { throw new Error("竞争者不得启动"); } }), { code: "runtime_locked" });
  } finally { finishStartup(); }
  const service = await starting;
  const original = await readFile(files.endpointFile, "utf8");
  const stopped = service.close();
  assert.strictEqual(service.close(), stopped);
  try {
    await assert.rejects(startLiveService(files), { code: "runtime_locked" });
    assert.equal(await readFile(files.endpointFile, "utf8"), original);
  } finally { finishClose(); }
  await stopped;
  assert.equal(JSON.parse(await readFile(files.endpointFile, "utf8")).state, "closed");
  await assert.rejects(stat(`${files.endpointFile}.runtime-lock`), { code: "ENOENT" });
});

test("显式恢复旧端点先核死PID和端口，保留旧指针证据且活动或未知PID拒绝", async context => {
  const files = await serviceFixture(context);
  const previous = JSON.stringify({ state: "listening", pid: 12345, config_path: files.configPath, state_dir: files.stateDir, url: "http://127.0.0.1:23456/mcp" }, null, 2);
  await writeFile(files.endpointFile, previous);
  let starts = 0;
  const events = [];
  const startRuntime = async () => { starts += 1; events.push("runtime"); return { url: "http://127.0.0.1:34567/mcp", close: async () => {} }; };
  for (const status of ["present", "unknown"]) {
    await assert.rejects(startLiveService({ ...files, recoverTerminated: true }, { startRuntime, probes: { processStatus: () => status } }), { code: "runtime_locked" });
    assert.equal(await readFile(files.endpointFile, "utf8"), previous);
  }
  assert.equal(starts, 0);
  const service = await startLiveService({ ...files, recoverTerminated: true }, { startRuntime, probes: {
    processStatus: () => { events.push("pid"); return "absent"; },
    loopbackPortStatus: (port, host) => { assert.equal(port, 23456); events.push(host); return "closed"; },
  } });
  assert.equal(events.at(-1), "runtime");
  assert.ok(events.indexOf("127.0.0.1") < events.indexOf("runtime"));
  const evidence = (await readdir(files.directory)).filter(name => name.includes(".terminated-"));
  assert.equal(evidence.length, 1);
  assert.equal(await readFile(join(files.directory, evidence[0]), "utf8"), previous);
  await service.close();
});

test("旧活动端点在启动core与创建SQLite之前拒绝第二实例", { timeout: 10000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "communication-service-preflight-"));
  const configPath = join(directory, "config.json");
  const endpointPath = join(directory, "endpoint.json");
  const stateDir = join(directory, "state");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(configPath, JSON.stringify({ adapter_mode: "live_test", allowed_conversation_ids: ["synthetic-target"], adapters: [{ id: "synthetic-adapter", kind: "antigravity" }], targets: [{ machine_id: "synthetic", host: "antigravity", conversation_id: "synthetic-target", binding_id: "synthetic-binding", binding_generation: 1, adapter_id: "synthetic-adapter" }], principals: [{ id: "synthetic-source", token: "synthetic-token", identity: { machine_id: "synthetic", host: "codex", conversation_id: "synthetic-source" }, allowed_targets: ["synthetic-binding"] }] }));
  const previous = JSON.stringify({ state: "listening", pid: process.pid, url: "http://127.0.0.1:1/mcp", config_path: configPath, state_dir: stateDir, started_at: new Date().toISOString() });
  await writeFile(endpointPath, previous);
  const child = fork(join(root, "scripts/live-service.mjs"), ["--config", configPath, "--state-dir", stateDir, "--endpoint-file", endpointPath], { execArgv: mockExecArgv, cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const result = await new Promise(resolveExit => child.once("exit", code => resolveExit(code)));
  assert.equal(result, 1, stderr);
  assert.equal(await readFile(endpointPath, "utf8"), previous);
  await assert.rejects(stat(join(stateDir, "core.sqlite")), { code: "ENOENT" });
});

test("独立服务不因stdin EOF退出，同状态可正常关闭重开且旧端口释放", async context => {
  const directory = await mkdtemp(join(tmpdir(), "communication-service-lifecycle-"));
  const configPath = join(directory, "config.json");
  const endpointPath = join(directory, "endpoint.json");
  const target = { machine_id: "synthetic", host: "antigravity", conversation_id: "synthetic-cascade", binding_id: "synthetic-binding", binding_generation: 1, adapter_id: "synthetic-adapter", capabilities: { next_model_boundary: true }, evidence: "synthetic" };
  await writeFile(configPath, JSON.stringify({ adapter_mode: "live_test", allowed_conversation_ids: [target.conversation_id], adapters: [{ id: "synthetic-adapter", kind: "antigravity" }], targets: [target], principals: [{ id: "synthetic-source", token: "synthetic-service-token", identity: { machine_id: "synthetic", host: "codex", conversation_id: "synthetic-source" }, allowed_targets: [target.binding_id] }] }));
  const children = [];
  context.after(async () => { for (const record of children) if (record.child.exitCode === null) { record.child.kill(); await record.exited; } await rm(directory, { recursive: true }); });
  for (let run = 0; run < 2; run += 1) {
    const child = fork(join(root, "scripts/live-service.mjs"), ["--config", configPath, "--state-dir", join(directory, "state"), "--endpoint-file", endpointPath], { execArgv: mockExecArgv, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const exited = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
    children.push({ child, exited });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const ready = await Promise.race([new Promise(resolveReady => child.stdout.on("data", chunk => { stdout += chunk; const line = stdout.split("\n").find(value => value.includes('"event":"listening"')); if (line) resolveReady(JSON.parse(line)); })), exited.then(() => { throw new Error("独立服务在监听前退出"); }), new Promise((resolveTimeout, rejectTimeout) => { const timer = setTimeout(() => rejectTimeout(new Error("独立服务启动超时")), 8000); timer.unref(); })]);
    assert.equal(child.exitCode, null);
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
    assert.equal(endpoint.state, "listening");
    assert.equal(endpoint.pid, child.pid);
    const client = new Client({ name: "synthetic-service-client", version: "0.1.0" });
    try { await client.connect(new StreamableHTTPClientTransport(new URL(ready.url), { requestInit: { headers: { Authorization: "Bearer synthetic-service-token" } } })); assert.equal((await client.listTools()).tools.length, 10); } finally { await client.close(); }
    child.send("shutdown");
    const stopped = await Promise.race([exited, new Promise((resolveTimeout, rejectTimeout) => { const timer = setTimeout(() => rejectTimeout(new Error("独立服务退出超时")), 5000); timer.unref(); })]);
    assert.equal(stopped.code, 0);
    assert.equal(JSON.parse(await readFile(endpointPath, "utf8")).state, "closed");
    await assert.rejects(fetch(ready.url));
    assert.equal((stdout + stderr).includes("synthetic-service-token"), false);
  }
});
