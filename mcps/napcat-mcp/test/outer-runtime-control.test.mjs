import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { parseOuterRuntimeArguments, runOuterRuntimeCommand } from "../ops/codex-outer-runtime.mjs";

const digest = source => crypto.createHash("sha256").update(source).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "outer-runtime-control-test-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = 'export default {apiVersion:1,version:"entry-unit",createEngine:()=>({inspectThread(){},subscribeThread(){},subscribeTask(){},wakeThread(){},observeDownstream(){},observeInjectedRequest(){},observeInjectedResponse(){},projectUpstream(){}})};';
fs.writeFileSync(path.join(root, "valid.mjs"), source);

test("runner root defaults off and coexists with the display policy root", () => {
  const required = ["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"]
    .flatMap(name => [`--${name}`, path.join(root, name)]);
  assert.equal(parseArguments(required).outerRuntimeRoot, null);
  const options = parseArguments([...required, "--outer-runtime-root", root, "--display-policy-root", root]);
  assert.equal(options.outerRuntimeRoot, root);
  assert.equal(options.displayPolicyRoot, root);
});

test("CLI rejects ambiguous arguments before contacting a control server", () => {
  const required = ["--runtime-state", "a", "--token-file", "b", "--action", "status"];
  assert.throws(() => parseOuterRuntimeArguments([...required, "--action", "restore"]), /INVALID_OUTER_RUNTIME_ARGUMENT/);
  assert.throws(() => parseOuterRuntimeArguments([...required.slice(0, 4), "--action", "prepare"]), /CANDIDATE_REQUIRED/);
  assert.throws(() => parseOuterRuntimeArguments([...required, "--revision", "9007199254740992"]), /INVALID_OUTER_RUNTIME_REVISION/);
  assert.throws(() => parseOuterRuntimeArguments([...required, "--receipt-out", "x"]), /REQUIRES_PREPARE/);
});

async function fixture(context, enabled) {
  const directory = fs.mkdtempSync(path.join(root, "fixture-"));
  const port = async () => {
    const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const assigned = listener.address().port; await new Promise(resolve => listener.close(resolve)); return assigned;
  };
  const proxy = createCodexAppServerProxy({ upstreamUrl: "ws://127.0.0.1:9", downstreamPort: await port(), controlPort: await port(),
    controlToken: "unit-private-token", instanceToken: "unit-owned-instance", ...(enabled ? { outerRuntimeRoot: root } : {}) });
  await proxy.start();
  context.after(() => proxy.close());
  const runtimePath = path.join(directory, "runtime.json");
  const tokenPath = path.join(directory, "token.txt");
  fs.writeFileSync(runtimePath, JSON.stringify({ controlUrl: `http://127.0.0.1:${proxy.controlServer.address().port}`, instanceToken: "unit-owned-instance" }));
  fs.writeFileSync(tokenPath, "unit-private-token");
  const command = (action, extra = {}) => runOuterRuntimeCommand({ "runtime-state": runtimePath, "token-file": tokenPath, action, ...extra });
  return { proxy, directory, runtimePath, tokenPath, command };
}

test("CLI uses the normal private identity, saved receipts and versioned restore", async context => {
  const { command, directory, tokenPath } = await fixture(context, true);
  assert.equal((await command("status")).version, "original");
  const receiptPath = path.join(directory, "receipt.json");
  const prepared = await command("prepare", { candidate: "valid.mjs", sha256: digest(source), "receipt-out": receiptPath });
  assert.equal(prepared.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).preparationId, prepared.preparationId);
  assert.equal((await command("activate", { receipt: receiptPath })).version, "entry-unit");
  assert.equal((await command("restore", { revision: "0" })).error.code, "OUTER_RUNTIME_REVISION_MISMATCH");
  assert.equal((await command("restore")).version, "original");
  const duplicate = await command("activate", { receipt: receiptPath });
  assert.equal(duplicate.alreadyActivated, true);
  assert.equal(duplicate.version, "original");
  assert.equal((await command("restore", { instance: "other" })).error.code, "OUTER_RUNTIME_INSTANCE_MISMATCH");
  const before = await command("status");
  assert.equal((await command("prepare", { candidate: "valid.mjs", sha256: "0".repeat(64) })).error.code, "OUTER_RUNTIME_SHA_MISMATCH");
  fs.writeFileSync(path.join(root, "bad.mjs"), 'throw new Error("UNIT_BAD_IMPORT");');
  assert.equal((await command("prepare", { candidate: "bad.mjs", sha256: digest('throw new Error("UNIT_BAD_IMPORT");') })).error.code, "UNIT_BAD_IMPORT");
  assert.equal((await command("status")).revision, before.revision);
  await assert.rejects(command("prepare", { candidate: "valid.mjs", sha256: digest(source), "receipt-out": receiptPath }), /OUTPUT_EXISTS/);
  fs.writeFileSync(tokenPath, "wrong-token");
  assert.equal((await command("status")).httpStatus, 401);
});

test("default closed HTTP control and non-loopback state are rejected", async context => {
  const { command, runtimePath } = await fixture(context, false);
  assert.equal((await command("status")).enabled, false);
  assert.equal((await command("prepare", { candidate: "valid.mjs", sha256: digest(source) })).error.code, "OUTER_RUNTIME_CONTROL_DISABLED");
  fs.writeFileSync(runtimePath, JSON.stringify({ controlUrl: "http://example.invalid:1234", instanceToken: "unit-owned-instance" }));
  await assert.rejects(command("status"), /REQUIRES_LOOPBACK/);
});
