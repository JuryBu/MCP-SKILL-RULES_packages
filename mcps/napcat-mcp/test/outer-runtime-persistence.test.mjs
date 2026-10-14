import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createOuterRuntime } from "../src/outer-runtime.mjs";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { OUTER_RUNTIME_SELECTION_FILE } from "../src/outer-runtime-selection.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const source = (version, extra = "") => `export default {apiVersion:1,version:${JSON.stringify(version)},createEngine:host=>({
async inspectThread(input){await host.wait();return {version:${JSON.stringify(version)},input};},
subscribeThread(){},subscribeTask(){},wakeThread(){},observeDownstream(client,message){host.observe(${JSON.stringify(version)},message);},
observeInjectedRequest(){},observeInjectedResponse(){},projectUpstream(client,message){host.observe(${JSON.stringify(version)},message);return message;},${extra}
})};`;

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "outer-runtime-persistence-unit-"));
  context.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimes = [];
  const observed = [];
  let waiting = Promise.resolve();
  const selectionFile = path.join(root, OUTER_RUNTIME_SELECTION_FILE);
  function runtime(options = {}) {
    const instance = createOuterRuntime({ candidateRoot: root, ...options, createHost: () => ({
      wait: () => waiting, observe: (version, message) => observed.push({ version, message }),
    }) });
    runtimes.push(instance);
    return instance;
  }
  context.after(() => { for (const instance of runtimes) instance.close(); });
  async function prepare(instance, version, extra) {
    const candidate = `versions/${version}.mjs`;
    fs.mkdirSync(path.join(root, "versions"), { recursive: true });
    const bytes = source(version, extra);
    fs.writeFileSync(path.join(root, candidate), bytes);
    return instance.prepare({ ...instance.status(), candidate, sha256: digest(bytes) });
  }
  return { root, runtime, prepare, observed, selectionFile,
    hold() { let release; waiting = new Promise(resolve => { release = resolve; }); return release; },
    bytes: () => fs.readFileSync(selectionFile), record: () => JSON.parse(fs.readFileSync(selectionFile, "utf8")),
  };
}

test("activation and restore persist exact relative modules and normal reopen selects the restored version", async context => {
  const setup = fixture(context);
  const first = setup.runtime();
  await first.reopenSelection();
  assert.equal(first.status().persistence.state, "empty");
  first.activate(await setup.prepare(first, "v1"));
  first.activate(await setup.prepare(first, "v2"));
  assert.equal(first.restore().version, "v1");
  const record = setup.record();
  assert.deepEqual(record.selected, { candidate: "versions/v1.mjs", version: "v1", sha256: digest(source("v1")) });
  assert.deepEqual(record.previous, [{ candidate: null, version: "original", sha256: null }]);
  assert.equal(record.revision, 3);
  const savedBytes = setup.bytes();
  first.close();
  const reopened = setup.runtime();
  await reopened.reopenSelection();
  assert.equal(reopened.status().version, "v1");
  assert.equal(reopened.status().revision, 3);
  assert.equal(reopened.status().persistence.state, "recovered");
  assert.equal(setup.bytes().equals(savedBytes), true);
  assert.deepEqual(await reopened.invoke("inspectThread", "reopened"), { version: "v1", input: "reopened" });
  assert.equal(reopened.restore().version, "original");
  const original = setup.runtime();
  await original.reopenSelection();
  assert.equal(original.status().version, "original");
  assert.equal(original.status().revision, 4);
});

test("failed preparation and activation preserve selection bytes and the live business version", async context => {
  const setup = fixture(context);
  const runtime = setup.runtime();
  runtime.activate(await setup.prepare(runtime, "v1"));
  const before = setup.bytes();
  fs.writeFileSync(path.join(setup.root, "bad.mjs"), 'throw new Error("PERSISTENCE_BAD_IMPORT");');
  await assert.rejects(runtime.prepare(path.join(setup.root, "bad.mjs")), /PERSISTENCE_BAD_IMPORT/);
  const rejected = await setup.prepare(runtime, "rejected", "beforeActivate(){return false;},");
  assert.throws(() => runtime.activate(rejected), /ACTIVATION_REJECTED/);
  assert.equal(runtime.status().version, "v1");
  assert.equal(runtime.status().revision, 1);
  assert.equal(setup.bytes().equals(before), true);
});

test("atomic write failure preserves live version, revision, receipt, old requests and record, then permits retry", async context => {
  const setup = fixture(context);
  let rejectWrites = false;
  const runtime = setup.runtime({ selectionFs: { ...fs, renameSync(...args) {
    if (rejectWrites) throw Object.assign(new Error("ISOLATED_RENAME_FAILURE"), { code: "EIO" });
    return fs.renameSync(...args);
  } } });
  runtime.activate(await setup.prepare(runtime, "v1"));
  const before = setup.bytes();
  const release = setup.hold();
  const oldOperation = runtime.invoke("inspectThread", "in-flight");
  const client = {};
  runtime.downstream(client, { id: 1, method: "turn/start", params: { threadId: "thread" } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "thread", turn: { id: "old-turn" } } });
  const receipt = await setup.prepare(runtime, "v2");
  rejectWrites = true;
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.throws(() => runtime.restore(), /SELECTION_WRITE_FAILED/);
  assert.equal(runtime.status().version, "v1");
  assert.equal(runtime.status().revision, 1);
  assert.equal(runtime.status().persistence.lastWriteError, "EIO");
  assert.equal(setup.bytes().equals(before), true);
  assert.equal(fs.readdirSync(setup.root).some(name => name.endsWith(".tmp")), false);
  rejectWrites = false;
  runtime.activate(receipt);
  runtime.upstream(client, { id: "tool", method: "item/tool/call", params: { threadId: "thread", turnId: "old-turn" } });
  runtime.downstream(client, { id: "tool", result: { success: true } });
  assert.equal(setup.observed.at(-1).version, "v1");
  release();
  assert.deepEqual(await oldOperation, { version: "v1", input: "in-flight" });
  assert.equal(runtime.status().version, "v2");
  assert.equal(runtime.status().persistence.lastWriteError, null);
});

for (const damage of ["missing-module", "changed-module", "activation-rejected"]) {
  test(`${damage} on reopen restores the previous usable version and retains the original record evidence`, async context => {
    const setup = fixture(context);
    const runtime = setup.runtime();
    runtime.activate(await setup.prepare(runtime, "v1"));
    runtime.activate(await setup.prepare(runtime, "v2", damage === "activation-rejected"
      ? `beforeActivate(){if(globalThis.outerPersistenceReject)throw new Error("REOPEN_REJECTED");},` : ""));
    const before = setup.bytes();
    if (damage === "missing-module") fs.unlinkSync(path.join(setup.root, "versions/v2.mjs"));
    if (damage === "changed-module") fs.appendFileSync(path.join(setup.root, "versions/v2.mjs"), "\n");
    if (damage === "activation-rejected") globalThis.outerPersistenceReject = true;
    context.after(() => { delete globalThis.outerPersistenceReject; });
    const reopened = setup.runtime();
    await reopened.reopenSelection();
    assert.equal(reopened.status().version, "v1");
    assert.equal(reopened.status().persistence.state, "fallback");
    assert.equal(reopened.status().persistence.persistedVersion, "v2");
    assert.equal(setup.bytes().equals(before), true);
    assert.equal(fs.readFileSync(path.join(setup.root, reopened.status().persistence.evidence)).equals(before), true);
    assert.equal(reopened.restore().version, "original");
    assert.equal(setup.record().selected.version, "original");
    const independent = setup.runtime();
    await independent.reopenSelection();
    assert.equal(independent.status().version, "original");
  });
}

for (const damage of ["bad-json", "record-sha", "outside-root", "manifest-version"]) {
  test(`${damage} selection fails safely, preserves evidence and allows an explicit new valid selection`, async context => {
    const setup = fixture(context);
    const runtime = setup.runtime();
    runtime.activate(await setup.prepare(runtime, "v1"));
    const record = setup.record();
    if (damage === "bad-json") fs.writeFileSync(setup.selectionFile, "{broken record");
    else {
      if (damage === "record-sha") record.sha256 = "0".repeat(64);
      if (damage === "outside-root") record.selected.candidate = "../outside.mjs";
      if (damage === "manifest-version") record.selected.version = "forged-version";
      if (damage !== "record-sha") {
        const { sha256, ...payload } = record;
        record.sha256 = digest(JSON.stringify(payload));
      }
      fs.writeFileSync(setup.selectionFile, JSON.stringify(record));
    }
    const damagedBytes = setup.bytes();
    const reopened = setup.runtime();
    await reopened.reopenSelection();
    assert.equal(reopened.status().version, "original");
    assert.equal(reopened.status().persistence.recoveryErrors.length > 0, true);
    assert.equal(setup.bytes().equals(damagedBytes), true);
    const evidence = path.join(setup.root, reopened.status().persistence.evidence);
    assert.equal(fs.readFileSync(evidence).equals(damagedBytes), true);
    reopened.activate(await setup.prepare(reopened, "repair"));
    assert.equal(fs.readFileSync(evidence).equals(damagedBytes), true);
    const independent = setup.runtime();
    await independent.reopenSelection();
    assert.equal(independent.status().version, "repair");
  });
}

test("external record changes and invalid file targets cannot overwrite the evidence or current selection", async context => {
  const setup = fixture(context);
  const runtime = setup.runtime();
  runtime.activate(await setup.prepare(runtime, "v1"));
  const receipt = await setup.prepare(runtime, "v2");
  fs.appendFileSync(setup.selectionFile, " ");
  const changedBytes = setup.bytes();
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.equal(runtime.status().persistence.lastWriteError, "OUTER_RUNTIME_SELECTION_CHANGED");
  assert.equal(setup.bytes().equals(changedBytes), true);
  fs.renameSync(setup.selectionFile, path.join(setup.root, "preserved-original.json"));
  fs.mkdirSync(setup.selectionFile);
  const reopened = setup.runtime();
  await reopened.reopenSelection();
  assert.equal(reopened.status().version, "original");
  assert.equal(reopened.status().persistence.state, "invalid");
  assert.throws(() => reopened.activate(receipt), /PREPARATION_INVALID/);
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.equal(runtime.status().version, "v1");
});

test("a record changed during Windows rename retry is preserved with the active version and receipt", { skip: process.platform !== "win32" }, async context => {
  const setup = fixture(context);
  let externalBytes;
  let injectChange = false;
  let renameAttempts = 0;
  const runtime = setup.runtime({ selectionFs: { ...fs, renameSync(...args) {
    renameAttempts += 1;
    if (injectChange) {
      injectChange = false;
      fs.writeFileSync(setup.selectionFile, externalBytes);
      throw Object.assign(new Error("WINDOWS_RENAME_RETRY"), { code: "EPERM" });
    }
    return fs.renameSync(...args);
  } } });
  runtime.activate(await setup.prepare(runtime, "v1"));
  const before = setup.bytes();
  const { sha256, ...payload } = setup.record();
  payload.selected = { candidate: null, version: "original", sha256: null };
  payload.revision += 1;
  externalBytes = Buffer.from(JSON.stringify({ ...payload, sha256: digest(JSON.stringify(payload)) }));
  const receipt = await setup.prepare(runtime, "v2");
  renameAttempts = 0;
  injectChange = true;
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.equal(renameAttempts, 1);
  assert.equal(runtime.status().persistence.lastWriteError, "OUTER_RUNTIME_SELECTION_CHANGED");
  assert.equal(runtime.status().version, "v1");
  assert.equal(runtime.status().revision, 1);
  assert.equal(setup.bytes().equals(externalBytes), true);
  assert.equal(fs.readdirSync(setup.root).some(name => name.endsWith(".tmp")), false);
  fs.writeFileSync(setup.selectionFile, before);
  assert.equal(runtime.activate(receipt).version, "v2");
});

test("partial evidence writes leave the damaged record and allow repair after storage recovers", async context => {
  const setup = fixture(context);
  const original = setup.runtime();
  original.activate(await setup.prepare(original, "v1"));
  fs.writeFileSync(setup.selectionFile, "{damaged selection record");
  const damagedBytes = setup.bytes();
  const evidenceName = `outer-runtime-selection-evidence-${digest(damagedBytes)}.json`;
  const evidencePath = path.join(setup.root, evidenceName);
  const evidenceDescriptors = new Set();
  let rejectWrite = true;
  const runtime = setup.runtime({ selectionFs: { ...fs,
    openSync(file, ...args) {
      const descriptor = fs.openSync(file, ...args);
      if (String(file).includes("selection-evidence-")) evidenceDescriptors.add(descriptor);
      return descriptor;
    },
    writeFileSync(target, bytes, options) {
      if (rejectWrite && (evidenceDescriptors.has(target) || String(target).includes("selection-evidence-"))) {
        fs.writeFileSync(target, bytes.subarray(0, 8), options);
        throw Object.assign(new Error("PARTIAL_EVIDENCE_WRITE"), { code: "ENOSPC" });
      }
      return fs.writeFileSync(target, bytes, options);
    },
    closeSync(descriptor) { evidenceDescriptors.delete(descriptor); return fs.closeSync(descriptor); },
  } });
  await runtime.reopenSelection();
  assert.equal(runtime.status().persistence.evidenceError, "ENOSPC");
  assert.equal(runtime.status().version, "original");
  assert.equal(setup.bytes().equals(damagedBytes), true);
  const receipt = await setup.prepare(runtime, "repaired");
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.equal(fs.existsSync(evidencePath), false);
  assert.equal(fs.readdirSync(setup.root).some(name => name.endsWith(".tmp")), false);
  rejectWrite = false;
  assert.equal(runtime.activate(receipt).version, "repaired");
  assert.equal(fs.readFileSync(evidencePath).equals(damagedBytes), true);
  const reopened = setup.runtime();
  await reopened.reopenSelection();
  assert.equal(reopened.status().version, "repaired");
});

test("a conflicting pre-existing evidence file remains untouched and valid evidence is reused", async context => {
  const setup = fixture(context);
  const original = setup.runtime();
  original.activate(await setup.prepare(original, "v1"));
  fs.writeFileSync(setup.selectionFile, "{damaged record");
  const damagedBytes = setup.bytes();
  const evidencePath = path.join(setup.root, `outer-runtime-selection-evidence-${digest(damagedBytes)}.json`);
  fs.writeFileSync(evidencePath, "pre-existing conflict");
  const runtime = setup.runtime();
  await runtime.reopenSelection();
  const receipt = await setup.prepare(runtime, "repaired");
  assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
  assert.equal(runtime.status().persistence.lastWriteError, "OUTER_RUNTIME_SELECTION_EVIDENCE_INVALID");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), "pre-existing conflict");
  assert.equal(setup.bytes().equals(damagedBytes), true);
  fs.renameSync(evidencePath, `${evidencePath}.preserved`);
  fs.writeFileSync(evidencePath, damagedBytes);
  const independent = setup.runtime({ selectionFs: { ...fs, openSync(file, ...args) {
    if (String(file).includes("selection-evidence-")) throw new Error("EXISTING_EVIDENCE_MUST_BE_REUSED");
    return fs.openSync(file, ...args);
  } } });
  await independent.reopenSelection();
  assert.equal(independent.status().persistence.evidenceError, undefined);
  assert.equal(independent.activate(await setup.prepare(independent, "repaired-again")).version, "repaired-again");
  assert.equal(fs.readFileSync(evidencePath).equals(damagedBytes), true);
  assert.equal(fs.readFileSync(`${evidencePath}.preserved`, "utf8"), "pre-existing conflict");
});

test("real Windows file locking followed by an external write stops the retried activation", { skip: process.platform !== "win32", timeout: 10000 }, async context => {
  const setup = fixture(context);
  const signalFile = path.join(setup.root, "begin-rename");
  const externalFile = path.join(setup.root, "external-selection.json");
  let signalRename = false;
  let renameAttempts = 0;
  const runtime = setup.runtime({ selectionFs: { ...fs, renameSync(...args) {
    if (signalRename) {
      renameAttempts += 1;
      fs.writeFileSync(signalFile, "begin");
    }
    return fs.renameSync(...args);
  } } });
  runtime.activate(await setup.prepare(runtime, "v1"));
  const before = setup.bytes();
  const { sha256, ...payload } = setup.record();
  payload.selected = { candidate: null, version: "original", sha256: null };
  payload.revision += 1;
  const externalBytes = Buffer.from(JSON.stringify({ ...payload, sha256: digest(JSON.stringify(payload)) }));
  fs.writeFileSync(externalFile, externalBytes);
  const receipt = await setup.prepare(runtime, "v2");
  const script = "$stream=[System.IO.File]::Open($env:SELECTION_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::WriteLine('LOCK_READY');$limit=[DateTime]::UtcNow.AddSeconds(5);while(-not(Test-Path -LiteralPath $env:SIGNAL_FILE)){if([DateTime]::UtcNow -gt $limit){throw 'SIGNAL_TIMEOUT'};Start-Sleep -Milliseconds 5};Start-Sleep -Milliseconds 40}finally{$stream.Dispose()};[System.IO.File]::WriteAllBytes($env:SELECTION_FILE,[System.IO.File]::ReadAllBytes($env:EXTERNAL_FILE));[Console]::WriteLine('EXTERNAL_COMMITTED')";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, SELECTION_FILE: setup.selectionFile, SIGNAL_FILE: signalFile, EXTERNAL_FILE: externalFile },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const childExit = once(child, "exit");
  try {
    const deadline = Date.now() + 4000;
    while (!stdout.includes("LOCK_READY")) {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(Date.now() < deadline, true, stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    signalRename = true;
    assert.throws(() => runtime.activate(receipt), /SELECTION_WRITE_FAILED/);
    const [exitCode] = await childExit;
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.includes("EXTERNAL_COMMITTED"), true);
    assert.equal(renameAttempts > 0, true);
    assert.equal(runtime.status().persistence.lastWriteError, "OUTER_RUNTIME_SELECTION_CHANGED");
    assert.equal(runtime.status().version, "v1");
    assert.equal(runtime.status().revision, 1);
    assert.equal(setup.bytes().equals(externalBytes), true);
    signalRename = false;
    fs.writeFileSync(setup.selectionFile, before);
    assert.equal(runtime.activate(receipt).version, "v2");
  } finally {
    fs.writeFileSync(signalFile, "release-own-helper");
    if (child.exitCode === null && child.signalCode === null) await childExit;
  }
});

test("proxy restores selection before listening and leaves an unspecified root disabled", async context => {
  const setup = fixture(context);
  const runtime = setup.runtime();
  runtime.activate(await setup.prepare(runtime, "v1"));
  const freePort = async () => {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
  };
  const proxy = createCodexAppServerProxy({ outerRuntimeRoot: setup.root, controlToken: "isolated-persistence",
    downstreamPort: await freePort(), controlPort: await freePort() });
  context.after(() => proxy.close());
  await proxy.start();
  assert.equal(proxy.status().outerRuntime.version, "v1");
  assert.equal(proxy.status().outerRuntime.persistence.state, "recovered");
  assert.equal(proxy.websocketServer.address().port > 0, true);
  const disabled = createOuterRuntime({ createHost: () => ({}) });
  context.after(() => disabled.close());
  await disabled.reopenSelection();
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().persistence.state, "disabled");
  await assert.rejects(disabled.prepare({ ...disabled.status(), candidate: "v1.mjs", sha256: digest(source("v1")) }), /CONTROL_DISABLED/);
});

test("a missing candidate root keeps the built-in runtime available without recreating or widening the root", async context => {
  const setup = fixture(context);
  const runtime = setup.runtime();
  runtime.activate(await setup.prepare(runtime, "v1"));
  const before = setup.bytes();
  runtime.close();
  const preservedRoot = `${setup.root}-preserved`;
  assert.equal(path.dirname(preservedRoot), os.tmpdir());
  fs.renameSync(setup.root, preservedRoot);
  context.after(() => fs.rmSync(preservedRoot, { recursive: true, force: true }));
  const reopened = setup.runtime();
  await reopened.reopenSelection();
  assert.equal(reopened.status().version, "original");
  assert.equal(reopened.status().persistence.state, "invalid");
  assert.equal(reopened.status().persistence.recoveryErrors[0].code, "ENOENT");
  assert.equal(fs.existsSync(setup.root), false);
  assert.equal(fs.readFileSync(path.join(preservedRoot, OUTER_RUNTIME_SELECTION_FILE)).equals(before), true);
  await assert.rejects(reopened.prepare({ ...reopened.status(), candidate: "versions/v1.mjs", sha256: digest(source("v1")) }), /ENOENT/);
});
