import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-agy-preflight-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.FAKE_AGY_LOG = path.join(root, "fake.jsonl");
const fake = fileURLToPath(new URL("./fixtures/fake-agy-slow-help.mjs", import.meta.url));
const bridge = await import("../src/model-bridge.ts");
const transport = await import("../src/provider-transport-adapter.ts");
const { initializeProviderControlStore } = await import("../src/provider-control-store.ts");

const events = () => fs.existsSync(process.env.FAKE_AGY_LOG!)
    ? fs.readFileSync(process.env.FAKE_AGY_LOG!, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
const clearEvents = () => fs.rmSync(process.env.FAKE_AGY_LOG!, { force: true });
const options = { agyCommand: process.execPath, agyCommandArgs: [fake] };

try {
    const dataRoot = path.join(root, "provider");
    await initializeProviderControlStore({ dataRoot, initialization: "exclusive-install" });
    await transport.configureProviderTransportAdapterForTest({ mode: "enforced", dataRoot, ownerId: "agy-preflight-test" });

    process.env.FAKE_AGY_HELP_DELAY_MS = "1200";
    let startedAt = performance.now();
    const expired = await bridge.callModelResponse("flash", "synthetic", "agy", 200, options);
    assert.equal(expired.text, null);
    assert.equal(expired.timedOut, true, JSON.stringify(expired));
    assert.match(expired.error || "", /phase=preflight; totalMs=\d+/);
    assert.ok(performance.now() - startedAt < 700, "slow --help must not consume its independent 8-second allowance");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(events().filter(event => !event.help).length, 0, "expired preflight must never launch model CLI later");
    clearEvents();

    const controller = new AbortController();
    startedAt = performance.now();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await bridge.callModelResponse("flash", "synthetic", "agy", 5000, { ...options, signal: controller.signal });
    assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
    assert.match(cancelled.error || "", /phase=preflight/);
    assert.ok(performance.now() - startedAt < 650, "abort during --help must return promptly");
    assert.equal(events().filter(event => !event.help).length, 0);
    clearEvents();

    process.env.FAKE_AGY_HELP_DELAY_MS = "120";
    const success = await bridge.callModelResponse("flash", "synthetic", "agy", 3000, options);
    assert.equal(success.text, "fake answer", JSON.stringify(success));
    assert.equal(events().filter(event => !event.help).length, 1);
    clearEvents();

    process.env.FAKE_AGY_MODE = "fallback";
    const fallback = await bridge.callModelResponse("flash", "synthetic", "agy", 3000, options);
    assert.equal(fallback.text, "fake answer", JSON.stringify(fallback));
    assert.equal(events().filter(event => !event.help).length, 2, "eligible failure must retain AGY model fallback");
    clearEvents();

    process.env.FAKE_AGY_MODE = "success";
    process.env.FAKE_AGY_HELP_DELAY_MS = "250";
    process.env.FAKE_AGY_CALL_DELAY_MS = "5000";
    const executionExpired = await bridge.callModelResponse("flash", "synthetic", "agy", 2000, options);
    assert.equal(executionExpired.timedOut, true, JSON.stringify(executionExpired));
    assert.match(executionExpired.error || "", /phase=execution; totalMs=\d+; preflightMs=\d+; admissionWaitMs=\d+; executionMs=\d+/);
    const timing = /totalMs=(\d+); preflightMs=(\d+)/u.exec(executionExpired.error || "");
    assert.ok(timing && Number(timing[1]) >= Number(timing[2]) && Number(timing[2]) >= 200);
    assert.equal(events().filter(event => !event.help).length, 1, "expired execution must not start another AGY model");
    clearEvents();

    await transport.resetProviderTransportAdapterForTest();
    const queuedRoot = path.join(root, "queued-provider");
    await initializeProviderControlStore({ dataRoot: queuedRoot, initialization: "exclusive-install" });
    await transport.configureProviderTransportAdapterForTest({ mode: "enforced", dataRoot: queuedRoot, ownerId: "agy-preflight-queue-test" });
    const adapter = transport.getProviderTransportAdapter();
    const firstHolder = await adapter.acquire("agy", { attemptId: "preflight-holder-one" });
    const secondHolder = await adapter.acquire("agy", { attemptId: "preflight-holder-two" });
    try {
        process.env.FAKE_AGY_HELP_DELAY_MS = "0";
        const queued = await bridge.callModelResponse("flash", "synthetic", "agy", 200, options);
        assert.equal(queued.timedOut, true, JSON.stringify(queued));
        assert.match(queued.error || "", /phase=preflight/);
        assert.equal(events().length, 0, "queued preflight must not launch --help or model CLI");
    } finally {
        await adapter.release(firstHolder);
        await adapter.release(secondHolder);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(events().length, 0, "expired queued probe must not launch after permits release");
    console.log("AGY bridge preflight: deadline, abort, queued no-late-launch, success, fallback and entry timing passed");
} finally {
    await transport.resetProviderTransportAdapterForTest();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
