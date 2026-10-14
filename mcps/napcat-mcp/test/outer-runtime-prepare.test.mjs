import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "outer-runtime-prepare-test-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const digest = source => crypto.createHash("sha256").update(source).digest("hex");
const subscription = { taskId: "isolated-prepare-subscription", generation: 1, threadId: "isolated-thread", localRole: "development",
  sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001" };
const methods = 'inspectThread(){},subscribeThread(){},subscribeTask(){},wakeThread(){},observeDownstream(){},observeInjectedRequest(){},observeInjectedResponse(){},projectUpstream(){}';
function fixture(context) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const journal = createWakeJournal({ filePath: path.join(directory, "journal.json") });
  journal.registerSubscription(subscription); journal.writeWake("preserved-wake", { status: "completed", meaning: "original state" });
  const proxy = createCodexAppServerProxy({ journal, outerRuntimeRoot: directory, controlToken: "isolated-token", instanceToken: "isolated-instance" });
  context.after(() => proxy.close());
  let identifier = 0;
  const prepare = async source => {
    const candidate = `candidate-${++identifier}.mjs`; fs.writeFileSync(path.join(directory, candidate), source);
    return proxy.prepareOuterRuntime({ instanceId: "isolated-instance", revision: proxy.outerRuntime.status().revision, candidate, sha256: digest(source) });
  };
  return { proxy, journal, prepare };
}

for (const phase of ["factory", "validate"]) {
  test(`${phase} state writes fail before touching the original journal or display state`, async context => {
    const { proxy, journal, prepare } = fixture(context);
    const calls = [
      "host.state.journal.writeWake('preserved-wake',{status:'corrupted'})",
      "host.state.journal.write('preserved-wake',{status:'corrupted'})",
      `host.state.journal.registerSubscription(${JSON.stringify({ ...subscription, generation: 2 })})`,
      "host.state.journal.claimWake({})",
      "host.state.wakeVisibility.registerWake({})",
      "host.state.wakeVisibility.forgetWake({})",
      "host.state.wakeVisibility.close()",
      "host.state.displayPolicy.commitReminderBinding({itemKey:'prepare-only'},{version:'bad',decision:{visibility:'inherit'}})",
      "host.state.displayPolicy.registerReminder({key:'prepare-only'})",
      "host.state.displayPolicy.restore()",
      "host.readyClients()",
      "host.recordError('prepare',new Error('bad'))",
      "host.injectRequest(null,'turn/start',{})",
    ];
    const before = fs.readFileSync(journal.filePath);
    const beforeDisplay = proxy.displayPolicy.status(); const beforeVisibility = proxy.wakeVisibility.snapshot();
    for (const call of calls) {
      const reads = "if(host.state.journal.getWake('preserved-wake').meaning!=='original state')throw new Error('READ_FAILED');host.state.journal.status();host.state.journal.visibilityWakes();host.state.wakeVisibility.snapshot();host.state.displayPolicy.status();host.maintenanceStatus();";
      const operation = `${reads}${call};throw new Error('FAIL_AFTER_WRITE');`;
      const source = phase === "factory"
        ? `export default {apiVersion:1,version:'failed-factory',createEngine(host){${operation}}};`
        : `export default {apiVersion:1,version:'failed-validate',createEngine(host){return {${methods},validate(){${operation}}};}};`;
      await assert.rejects(prepare(source), /OUTER_RUNTIME_PREPARE_SIDE_EFFECT_BLOCKED/);
      assert.equal(fs.readFileSync(journal.filePath).equals(before), true);
      assert.deepEqual(proxy.displayPolicy.status(), beforeDisplay); assert.deepEqual(proxy.wakeVisibility.snapshot(), beforeVisibility);
      assert.equal(proxy.outerRuntime.status().version, "original"); assert.equal(proxy.outerRuntime.status().revision, 0);
      assert.equal(proxy.lastError, null); assert.equal(proxy.journal, journal);
    }
  });
}

test("preparation can read state and activation hook failure retains the original bytes", async context => {
  const { proxy, journal, prepare } = fixture(context);
  const before = fs.readFileSync(journal.filePath);
  const source = `export default {apiVersion:1,version:'read-only',createEngine(host){const seen=host.state.journal.get('preserved-wake');return {${methods},validate(){if(seen.meaning!=='original state'||host.state.journal.status().wakeCount!==1)throw new Error('READ_FAILED');},beforeActivate(){host.state.journal.writeWake('preserved-wake',{status:'activation-write'});}};}};`;
  const receipt = await prepare(source); assert.equal(receipt.version, "read-only");
  assert.equal(fs.readFileSync(journal.filePath).equals(before), true);
  assert.throws(() => proxy.activateOuterRuntime(receipt), /OUTER_RUNTIME_PREPARE_SIDE_EFFECT_BLOCKED/);
  assert.equal(proxy.outerRuntime.status().version, "original"); assert.equal(fs.readFileSync(journal.filePath).equals(before), true);
});

test("an activated old operation writes the same journal after a newer version is activated", async context => {
  const { proxy, journal, prepare } = fixture(context);
  const firstSource = `export default {apiVersion:1,version:'write-v1',createEngine(host){return {${methods},async wakeThread(){await new Promise(resolve=>setTimeout(resolve,80));return host.state.journal.writeWake('preserved-wake',{completedBy:'write-v1'});},inspectThread(){return host.state.journal.writeWake('activated-write',{status:'completed'});}};}};`;
  proxy.activateOuterRuntime(await prepare(firstSource));
  const job = proxy.wakeThread({}); assert.equal(proxy.outerRuntime.status().activeOperationCount, 1);
  const second = await prepare(`export default {apiVersion:1,version:'write-v2',createEngine(){return {${methods}};}};`);
  proxy.activateOuterRuntime(second); assert.equal(proxy.outerRuntime.status().version, "write-v2");
  assert.equal((await job).completedBy, "write-v1"); assert.equal(journal.getWake("preserved-wake").meaning, "original state");
  proxy.restoreOuterRuntime({ instanceId: "isolated-instance", revision: proxy.outerRuntime.status().revision });
  assert.equal((await proxy.inspectThread("ignored")).wakeId, "activated-write"); assert.equal(proxy.journal, journal);
});
