import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireRuntimeLease, prepareServiceEndpoint, processStatus, registerLegacyRuntime } from "../src/runtime-lease.mjs";

const absentProbes = { processStatus: () => "absent", loopbackPortStatus: () => "closed" };

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "communication-runtime-lease-中文 "));
  context.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, "synthetic-config.json");
  await writeFile(configPath, "{}");
  const stateDir = join(directory, "synthetic-state");
  return { directory, configPath, stateDir, endpointFile: join(directory, "synthetic-endpoint.json"), lockPath: `${stateDir}.runtime-lock` };
}

function terminatedRecord(files, changes = {}) {
  return { version: 1, state: "listening", owner_id: "synthetic-terminated-owner", pid: 12345, config_path: files.configPath, state_dir: files.stateDir, endpoint_file: files.endpointFile, url: "http://127.0.0.1:23456/mcp", started_at: "2026-01-01T00:00:00.000Z", ...changes };
}

test("独占文件在状态创建前生效，路径别名共享同一锁且只在释放后重开", async context => {
  const files = await fixture(context);
  const lease = await acquireRuntimeLease(files);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  await assert.rejects(acquireRuntimeLease({ ...files, stateDir: join(files.stateDir, ".") }), { code: "runtime_locked" });
  const alias = join(files.directory, "synthetic-parent-alias");
  await symlink(files.directory, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireRuntimeLease({ ...files, stateDir: join(alias, "synthetic-state") }), { code: "runtime_locked" });
  await lease.release();
  await lease.release();
  const reopened = await acquireRuntimeLease(files);
  assert.notEqual(reopened.owner.owner_id, lease.owner.owner_id);
  await lease.release();
  assert.equal(JSON.parse(await readFile(files.lockPath, "utf8")).owner_id, reopened.owner.owner_id);
  await reopened.release();
  assert.equal(JSON.parse(await readFile(files.lockPath, "utf8")).state, "closed");
});

test("释放与更新都核对owner，外部替换的锁完整保留", async context => {
  const files = await fixture(context);
  const lease = await acquireRuntimeLease(files);
  const replacement = JSON.stringify({ ...lease.owner, owner_id: "synthetic-other-owner" });
  await writeFile(files.lockPath, replacement);
  await assert.rejects(lease.release(), { code: "runtime_locked" });
  await assert.rejects(lease.setUrl("http://127.0.0.1:23456/mcp"), { code: "runtime_locked" });
  assert.equal(await readFile(files.lockPath, "utf8"), replacement);
});

test("仅显式恢复同配置已死实例，双栈端口核查后逐字保存旧锁", async context => {
  const files = await fixture(context);
  const previous = JSON.stringify(terminatedRecord(files), null, 2);
  await writeFile(files.lockPath, previous);
  let inspected = 0;
  await assert.rejects(acquireRuntimeLease({ ...files, probes: { processStatus: () => { inspected += 1; return "absent"; } } }), { code: "runtime_locked" });
  assert.equal(inspected, 0);
  const ports = [];
  const lease = await acquireRuntimeLease({ ...files, recoverTerminated: true, probes: {
    processStatus: pid => { assert.equal(pid, 12345); inspected += 1; return "absent"; },
    loopbackPortStatus: (port, host) => { ports.push([port, host]); return "closed"; },
  } });
  assert.equal(inspected, 2);
  assert.deepEqual(ports, [[23456, "127.0.0.1"], [23456, "::1"]]);
  assert.equal(await readFile(`${files.lockPath}.terminated-${lease.owner.owner_id}.json`, "utf8"), previous);
  assert.equal(JSON.parse(await readFile(files.lockPath, "utf8")).pid, process.pid);
  await assert.rejects(stat(`${files.lockPath}.recovering`), { code: "ENOENT" });
  await lease.release();
});

test("活PID、PID复用、权限未知、端口监听或未知和归属不符全部保留旧锁", async context => {
  const files = await fixture(context);
  const cases = [
    { probes: { ...absentProbes, processStatus: () => "present" } },
    { probes: { ...absentProbes, processStatus: () => "unknown" } },
    { probes: { ...absentProbes, loopbackPortStatus: () => "listening" } },
    { probes: { ...absentProbes, loopbackPortStatus: () => "unknown" } },
    { probes: { ...absentProbes, loopbackPortStatus: (port, host) => host === "::1" ? "listening" : "closed" } },
    { changes: { config_path: join(files.directory, "other-config.json") } },
    { changes: { state_dir: join(files.directory, "other-state") } },
    { changes: { url: "https://127.0.0.1:23456/mcp" } },
    { changes: { url: "http://example.invalid:23456/mcp" } },
    { changes: { url: undefined } },
    { changes: { pid: -1 } },
  ];
  for (const entry of cases) {
    const previous = JSON.stringify(terminatedRecord(files, entry.changes));
    await writeFile(files.lockPath, previous);
    await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: entry.probes ?? absentProbes }), { code: "runtime_locked" });
    assert.equal(await readFile(files.lockPath, "utf8"), previous);
    await assert.rejects(stat(`${files.lockPath}.recovering`), { code: "ENOENT" });
  }
  let checks = 0;
  await writeFile(files.lockPath, JSON.stringify(terminatedRecord(files)));
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: { ...absentProbes, processStatus: () => ++checks === 1 ? "absent" : "present" } }), { code: "runtime_locked" });
  assert.equal(checks, 2);
  assert.equal((await readdir(files.directory)).some(name => name.includes(".terminated-")), false);
});

test("两个恢复者和普通启动竞争时只有一个可取得独占，核查期间原锁不变", async context => {
  const files = await fixture(context);
  const previous = JSON.stringify(terminatedRecord(files));
  await writeFile(files.lockPath, previous);
  let entered;
  const entering = new Promise(resolveEntered => { entered = resolveEntered; });
  let proceed;
  const proceeding = new Promise(resolveProceed => { proceed = resolveProceed; });
  const first = acquireRuntimeLease({ ...files, recoverTerminated: true, probes: {
    ...absentProbes,
    processStatus: async () => { entered(); await proceeding; return "absent"; },
  } });
  await entering;
  try {
    await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
    await assert.rejects(acquireRuntimeLease(files), { code: "runtime_locked" });
    assert.equal(await readFile(files.lockPath, "utf8"), previous);
  } finally { proceed(); }
  const recovered = await first;
  assert.equal((await readdir(files.directory)).filter(name => name.includes(".terminated-")).length, 1);
  await recovered.release();
});

test("畸形锁与遗留恢复占用不自动删除，端点只改写自己owner", async context => {
  const files = await fixture(context);
  await writeFile(files.lockPath, "synthetic-unknown-lock");
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  assert.equal(await readFile(files.lockPath, "utf8"), "synthetic-unknown-lock");
  await writeFile(files.lockPath, "null");
  await assert.rejects(acquireRuntimeLease(files), { code: "runtime_locked" });
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  assert.equal(await readFile(files.lockPath, "utf8"), "null");
  await mkdir(`${files.lockPath}.recovering`);
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  assert.ok((await stat(`${files.lockPath}.recovering`)).isDirectory());
  const endpoint = await prepareServiceEndpoint(files);
  await endpoint.publish("http://127.0.0.1:23456/mcp");
  const pointer = JSON.parse(await readFile(files.endpointFile, "utf8"));
  const changed = JSON.stringify({ ...pointer, owner_id: "synthetic-other-owner" });
  await writeFile(files.endpointFile, changed);
  await assert.rejects(endpoint.close(), { code: "runtime_locked" });
  assert.equal(await readFile(files.endpointFile, "utf8"), changed);
  assert.ok((await stat(`${files.endpointFile}.runtime-lock`)).isFile());
});

test("进程探针只把ESRCH判定为确实不存在，探针不发送退出信号", context => {
  const calls = [];
  let result;
  context.mock.method(process, "kill", (pid, signal) => { calls.push([pid, signal]); if (result) throw Object.assign(new Error(), { code: result }); return true; });
  assert.equal(processStatus(12345), "present");
  result = "EPERM";
  assert.equal(processStatus(12345), "unknown");
  result = "ESRCH";
  assert.equal(processStatus(12345), "absent");
  assert.deepEqual(calls, [[12345, 0], [12345, 0], [12345, 0]]);
});

test("旧无锁SQLite必须先登记原实例，换端点或缺少原端点均无法绕过", async context => {
  const files = await fixture(context);
  await mkdir(files.stateDir);
  await writeFile(join(files.stateDir, "core.sqlite"), "synthetic-legacy-state");
  const previous = JSON.stringify({ ...terminatedRecord(files), state: "listening" }, null, 2);
  await writeFile(files.endpointFile, previous);
  const alternateEndpoint = join(files.directory, "synthetic-alternate-endpoint.json");
  await assert.rejects(acquireRuntimeLease(files), { code: "runtime_locked" });
  await assert.rejects(acquireRuntimeLease({ ...files, endpointFile: alternateEndpoint, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  await assert.rejects(stat(files.lockPath), { code: "ENOENT" });
  const registration = await registerLegacyRuntime({ ...files, probes: { processStatus: () => "present" } });
  assert.equal(registration.pid, 12345);
  assert.equal(await readFile(files.endpointFile, "utf8"), previous);
  assert.equal(await readFile(registration.evidencePath, "utf8"), previous);
  const registered = await readFile(files.lockPath, "utf8");
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: { ...absentProbes, processStatus: () => "present" } }), { code: "runtime_locked" });
  await assert.rejects(acquireRuntimeLease({ ...files, endpointFile: alternateEndpoint, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  await assert.rejects(acquireRuntimeLease({ configPath: files.configPath, stateDir: files.stateDir, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  assert.equal(await readFile(files.lockPath, "utf8"), registered);
  await writeFile(files.endpointFile, JSON.stringify({ state: "closed", pid: 12345, config_path: files.configPath, state_dir: files.stateDir }));
  const recovered = await acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes });
  assert.equal(await readFile(`${files.lockPath}.terminated-${recovered.owner.owner_id}.json`, "utf8"), registered);
  await recovered.release();
  const next = await acquireRuntimeLease({ configPath: files.configPath, stateDir: files.stateDir });
  await next.release();
  assert.equal(await readFile(join(files.stateDir, "core.sqlite"), "utf8"), "synthetic-legacy-state");
});

test("已死starting锁尚无URL时显式恢复保存原锁，活动与未知PID仍拒绝", async context => {
  const files = await fixture(context);
  const previous = JSON.stringify(terminatedRecord(files, { state: "starting", url: undefined }));
  await writeFile(files.lockPath, previous);
  let pidChecks = 0;
  let portChecks = 0;
  for (const status of ["present", "unknown"]) {
    await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: { processStatus: () => status } }), { code: "runtime_locked" });
    assert.equal(await readFile(files.lockPath, "utf8"), previous);
  }
  const recovered = await acquireRuntimeLease({ ...files, recoverTerminated: true, probes: {
    processStatus: () => { pidChecks += 1; return "absent"; },
    loopbackPortStatus: () => { portChecks += 1; return "closed"; },
  } });
  assert.equal(pidChecks, 2);
  assert.equal(portChecks, 0);
  assert.equal(await readFile(`${files.lockPath}.terminated-${recovered.owner.owner_id}.json`, "utf8"), previous);
  await assert.rejects(stat(`${files.lockPath}.recovering`), { code: "ENOENT" });
  await recovered.release();
});

test("旧SQLite无锁且原服务已关闭的历史状态仍拒绝迁移，不构造新所有权", async context => {
  const files = await fixture(context);
  await mkdir(files.stateDir);
  await writeFile(join(files.stateDir, "core.sqlite"), "synthetic-closed-legacy-state");
  const previous = JSON.stringify({ state: "closed", pid: 12345, config_path: files.configPath, state_dir: files.stateDir });
  await writeFile(files.endpointFile, previous);
  await assert.rejects(acquireRuntimeLease({ ...files, recoverTerminated: true, probes: absentProbes }), { code: "runtime_locked" });
  await assert.rejects(registerLegacyRuntime({ ...files, probes: absentProbes }), { code: "runtime_locked" });
  await assert.rejects(stat(files.lockPath), { code: "ENOENT" });
  assert.equal(await readFile(files.endpointFile, "utf8"), previous);
  assert.equal(await readFile(join(files.stateDir, "core.sqlite"), "utf8"), "synthetic-closed-legacy-state");
});

test("旧已关闭端点具有准确关闭收据时可显式登记并原状态正常重开", async context => {
  const files = await fixture(context);
  await mkdir(files.stateDir);
  await writeFile(join(files.stateDir, "core.sqlite"), "synthetic-closed-legacy-state");
  const previous = JSON.stringify({ state: "closed", pid: 12345, config_path: files.configPath, state_dir: files.stateDir, closed_at: "2026-01-01T01:00:00.000Z" });
  await writeFile(files.endpointFile, previous);
  for (const status of ["present", "unknown"]) await assert.rejects(registerLegacyRuntime({ ...files, adoptClosed: true, probes: { processStatus: () => status } }), { code: "runtime_locked" });
  const registration = await registerLegacyRuntime({ ...files, adoptClosed: true, probes: absentProbes });
  assert.equal(await readFile(registration.evidencePath, "utf8"), previous);
  const lease = await acquireRuntimeLease(files);
  await lease.release();
  assert.equal(await readFile(join(files.stateDir, "core.sqlite"), "utf8"), "synthetic-closed-legacy-state");
});
