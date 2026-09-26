import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-agy-deadline-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.FAKE_AGY_MODE = "delay";
process.env.FAKE_AGY_DELAY_MS = "5000";
process.env.FAKE_AGY_LOG = path.join(root, "fake.jsonl");
const bridge = await import("../src/model-bridge.ts");
const transport = await import("../src/provider-transport-adapter.ts");
const { initializeProviderControlStore } = await import("../src/provider-control-store.ts");

try {
    const dataRoot = path.join(root, "provider");
    await initializeProviderControlStore({ dataRoot, initialization: "exclusive-install" });
    await transport.configureProviderTransportAdapterForTest({ mode: "enforced", dataRoot, ownerId: "model-bridge-agy-deadline-test" });
    const result = await bridge.callModelResponse("flash", "synthetic timeout only", "agy", 2500, {
        agyCommand: process.execPath,
        agyCommandArgs: [fileURLToPath(new URL("./fixtures/fake-agy-cli.mjs", import.meta.url))],
    });
    assert.equal(result.text, null);
    assert.equal(result.timedOut, true, JSON.stringify(result));
    assert.match(result.error || "", /phase=execution/);
    assert.match(result.error || "", /admissionWaitMs=\d+; executionMs=\d+/);
    assert.equal(result.agyAttempts?.length, 1);
    assert.equal(result.agyAttempts?.[0].phase, "execution");
    const events = fs.readFileSync(process.env.FAKE_AGY_LOG, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.throws(() => process.kill(events[0].pid, 0));
    console.log("AGY model bridge: shared deadline, phase/timing propagation, one fake invocation and process exit passed");
} finally {
    await transport.resetProviderTransportAdapterForTest();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
