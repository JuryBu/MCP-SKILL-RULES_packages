import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { callAgyModel, callAgyWithFallback, probeAgy, AGY_MODEL_SEQUENCE } from "../src/agy-client.ts";
import { callGrokExec, isGrokBridgeAvailable, resetGrokBridgeAvailabilityForTest, resetGrokCallConcurrencyForTest } from "../src/grok-client.ts";
import { callModelResponse, isAgyBridgeAvailable } from "../src/model-bridge.ts";
import {
    ProviderAdmissionFencedError,
    type ProviderAdmission,
    type ProviderAdmissionPermit,
    type ProviderAdmissionSnapshot,
} from "../src/provider-admission.ts";
import { initializeProviderControlStore } from "../src/provider-control-store.ts";
import {
    ProviderTransportAdapter,
    configureProviderTransportAdapterForTest,
    getProviderTransportAdapter,
    mapProviderTrafficClass,
    resetProviderTransportAdapterForTest,
} from "../src/provider-transport-adapter.ts";

type GrokMode = "success" | "failure" | "hold" | "slow-body";

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(10);
    }
    throw new Error(message);
}

function fakeSnapshot(provider: "grok" | "agy"): ProviderAdmissionSnapshot {
    return {
        provider,
        mode: "test",
        queuedForeground: 0,
        queuedRecord: 0,
        active: 0,
        uncertain: 0,
        currentLimit: 2,
        effectiveLimit: 2,
        capacityGeneration: 1,
        lossEpoch: 0,
        frozen: false,
        breakerOpenUntilMs: null,
        shadowGrants: 0,
    };
}

function fakeAdmission(
    complete: ProviderAdmissionPermit["complete"],
): Pick<ProviderAdmission, "acquire" | "snapshot"> {
    return {
        async acquire(provider, trafficClass, invocation): Promise<ProviderAdmissionPermit> {
            return {
                provider,
                trafficClass,
                attemptId: invocation.attemptId,
                leaseId: `fake-${invocation.attemptId}`,
                ownerEpoch: 1,
                capacityGeneration: 1,
                leaseIdentity: null,
                receipt: null,
                probe: false,
                complete,
                async markUnknownOutcome() { return true; },
                async release() { return true; },
                async assertCurrent() {},
            };
        },
        async snapshot(provider) { return fakeSnapshot(provider); },
    };
}

async function lineCount(filePath: string): Promise<number> {
    try {
        const text = await fs.readFile(filePath, "utf8");
        return text.split(/\r?\n/u).filter(Boolean).length;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}

async function main(): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "provider-transport-wiring-"));
    const fakeAgyPath = path.join(tempRoot, "fake-agy.mjs");
    const fakeAgyLogPath = path.join(tempRoot, "fake-agy-spawns.log");
    await fs.writeFile(fakeAgyPath, `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help")) {
    console.log("fake agy help");
    process.exit(0);
}
const model = args[args.indexOf("--model") + 1];
const mode = process.env.FAKE_AGY_MODE || "success";
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, model + "\\n", "utf8");
if (mode === "fail") {
    console.error("resource exhausted");
    process.exit(1);
}
if (mode === "hang") {
    setTimeout(() => console.log("late"), 1_000);
} else {
    console.log("agy:" + model);
}
`, "utf8");

    let grokMode: GrokMode = "success";
    let holdDelayMs = 300;
    let postCount = 0;
    let slowBodyStarted = false;
    const server = http.createServer(async (request, response) => {
        if (request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [] }));
            return;
        }
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404);
            response.end();
            return;
        }
        postCount++;
        if (grokMode === "hold") {
            await delay(holdDelayMs);
        }
        if (grokMode === "failure") {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "overloaded" }));
            return;
        }
        if (grokMode === "slow-body") {
            const payload = JSON.stringify({ choices: [{ message: { content: "grok:slow" }, finish_reason: "stop" }] });
            response.writeHead(200, { "content-type": "application/json" });
            response.write(payload.slice(0, 12));
            slowBodyStarted = true;
            await delay(300);
            response.end(payload.slice(12));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "grok:ok" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake Grok server did not bind a TCP port");

    const previousProxyUrl = process.env.MEMORY_STORE_GROK_PROXY_URL;
    const previousConcurrency = process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
    const previousAgyAuto = process.env.MEMORY_STORE_AGY_AUTO_ENABLED;
    const previousDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
    const previousFakeAgyLog = process.env.FAKE_AGY_LOG;
    process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address.port}`;
    process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "1";
    process.env.MEMORY_STORE_DATA_ROOT = path.join(tempRoot, "environment-data-root");
    process.env.FAKE_AGY_LOG = fakeAgyLogPath;

    try {
        assert.equal(mapProviderTrafficClass(), "foreground");
        assert.equal(mapProviderTrafficClass("record"), "record");
        assert.equal(mapProviderTrafficClass("record-batch"), "record");
        const defaultModeAdapter = new ProviderTransportAdapter({
            admission: fakeAdmission(async () => true),
        });
        assert.equal(defaultModeAdapter.diagnostics().mode, "enforced");
        await defaultModeAdapter.close();

        const enforcedRoot = path.join(tempRoot, "enforced-data-root");
        await initializeProviderControlStore({ dataRoot: enforcedRoot, initialization: "exclusive-install" });
        const enforcedAdapter = new ProviderTransportAdapter({
            mode: "enforced",
            dataRoot: enforcedRoot,
            ownerId: "provider-transport-enforced-test",
        });
        let enforcedExecutionCount = 0;
        assert.equal(
            await enforcedAdapter.execute("grok", {}, async () => {
                enforcedExecutionCount++;
                return "enforced";
            }, () => "success"),
            "enforced",
        );
        assert.equal(enforcedExecutionCount, 1);
        assert.equal(enforcedAdapter.diagnostics().attempts[0]?.permitSettled, true);
        await enforcedAdapter.close();

        let falseCompleteCalls = 0;
        const falseCompleteAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => {
                falseCompleteCalls++;
                return false;
            }),
        });
        await assert.rejects(
            falseCompleteAdapter.execute("grok", {}, async () => "must-not-return", () => "success"),
            ProviderAdmissionFencedError,
        );
        assert.equal(falseCompleteCalls, 1);
        assert.equal(falseCompleteAdapter.diagnostics().attempts[0]?.permitSettled, false);

        let grantedCompleteCalls = 0;
        const grantedAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => {
                grantedCompleteCalls++;
                return true;
            }),
        });
        const grantedLease = await grantedAdapter.acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-grok-attempt",
        });
        let grantedExecutionCount = 0;
        assert.equal(
            await grantedAdapter.executeGranted(grantedLease, async () => {
                grantedExecutionCount++;
                return "granted-result";
            }, () => "success"),
            "granted-result",
        );
        assert.equal(grantedExecutionCount, 1, "a granted lease must execute the transport exactly once");
        assert.equal(grantedCompleteCalls, 1, "a granted lease must complete exactly once");
        assert.equal(grantedAdapter.diagnostics().acquireCount, 1);
        assert.equal(grantedAdapter.diagnostics().settleCount, 1);
        assert.equal(grantedAdapter.diagnostics().attempts[0]?.attemptId, "scheduler-grok-attempt");
        assert.equal(grantedAdapter.diagnostics().attempts[0]?.permitId, grantedLease.permitId);
        await assert.rejects(
            grantedAdapter.executeGranted(grantedLease, async () => {
                grantedExecutionCount++;
                return "reused";
            }, () => "success"),
            /已消费/u,
        );
        assert.equal(grantedExecutionCount, 1, "a consumed lease must not call the transport again");
        assert.equal(grantedCompleteCalls, 1, "a consumed lease must not complete again");

        let cancelledCompleteCalls = 0;
        const cancellableAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => {
                cancelledCompleteCalls++;
                return true;
            }),
        });
        const cancelledLease = await cancellableAdapter.acquire("agy", {
            trafficClass: "record",
            attemptId: "scheduler-agy-cancelled",
        });
        assert.equal(await cancellableAdapter.cancel(cancelledLease), true, "an unconsumed lease must be cancellable");
        assert.equal(await cancellableAdapter.release(cancelledLease), false, "a cancelled lease must not complete twice");
        await assert.rejects(
            cancellableAdapter.executeGranted(cancelledLease, async () => "must-not-run", () => "success"),
            /已释放/u,
        );
        assert.equal(cancelledCompleteCalls, 1);
        assert.equal(cancellableAdapter.diagnostics().attempts[0]?.settlement, "cancelled");

        let fencedGrantedExecutions = 0;
        let fencedGrantedCompletes = 0;
        const fencedGrantedAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => {
                fencedGrantedCompletes++;
                return false;
            }),
        });
        const fencedGrantedLease = await fencedGrantedAdapter.acquire("grok", { attemptId: "scheduler-fenced-attempt" });
        await assert.rejects(
            fencedGrantedAdapter.executeGranted(fencedGrantedLease, async () => {
                fencedGrantedExecutions++;
                return "must-not-commit";
            }, () => "success"),
            ProviderAdmissionFencedError,
        );
        assert.equal(fencedGrantedExecutions, 1, "the physical transport may finish before fencing is detected");
        assert.equal(fencedGrantedCompletes, 1);
        assert.equal(fencedGrantedAdapter.diagnostics().attempts[0]?.permitSettled, false, "fenced completion must block result submission");

        const settlementFailure = new Error("fake permit settlement failed");
        const throwingCompleteAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => { throw settlementFailure; }),
        });
        await assert.rejects(
            throwingCompleteAdapter.execute("grok", {}, async () => "must-not-return", () => "success"),
            error => error === settlementFailure,
        );
        const originalTransportFailure = new Error("original transport failed");
        await assert.rejects(
            throwingCompleteAdapter.execute(
                "grok",
                {},
                async () => { throw originalTransportFailure; },
                () => "success",
                () => "availability",
            ),
            error => error === originalTransportFailure,
        );
        const throwingDiagnostics = throwingCompleteAdapter.diagnostics();
        assert.equal(throwingDiagnostics.settleFailureCount, 2);
        assert.match(throwingDiagnostics.attempts[1]?.settlementError || "", /fake permit settlement failed/u);

        const synchronousFailure = new Error("synchronous transport callback failed");
        let synchronousCompleteCalls = 0;
        const synchronousFailureAdapter = new ProviderTransportAdapter({
            mode: "test",
            admission: fakeAdmission(async () => {
                synchronousCompleteCalls++;
                return true;
            }),
        });
        await assert.rejects(
            synchronousFailureAdapter.execute(
                "agy",
                {},
                () => { throw synchronousFailure; },
                () => "success",
                () => "availability",
            ),
            error => error === synchronousFailure,
        );
        assert.equal(synchronousCompleteCalls, 1);
        assert.equal(synchronousFailureAdapter.diagnostics().attempts[0]?.settlement, "availability");

        await configureProviderTransportAdapterForTest({ mode: "shadow" });
        process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = "1";
        resetGrokCallConcurrencyForTest();
        grokMode = "hold";
        const holder = callGrokExec("shadow holder", "grok-test", 5_000);
        await waitFor(() => postCount === 1, "first Grok POST did not reach fake transport");
        const queued = callGrokExec("shadow queued", "grok-test", 5_000);
        await delay(75);
        assert.equal(postCount, 2, "explicit shadow mode must not retain the retired Grok process gate");
        const [holderResult, queuedResult] = await Promise.all([holder, queued]);
        assert.equal(holderResult.text, "grok:ok", holderResult.error);
        assert.equal(queuedResult.text, "grok:ok", queuedResult.error);
        const shadowDiagnostics = getProviderTransportAdapter().diagnostics();
        assert.equal(shadowDiagnostics.mode, "shadow");
        assert.equal(shadowDiagnostics.acquireCount, 2);
        assert.equal(shadowDiagnostics.settleCount, 2);
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).shadowGrants, 2);

        grokMode = "success";
        resetGrokBridgeAvailabilityForTest();
        const beforeGrokAvailability = getProviderTransportAdapter().diagnostics();
        assert.equal(await isGrokBridgeAvailable(), true);
        const grokAvailabilityAttempts = getProviderTransportAdapter().diagnostics().attempts.slice(beforeGrokAvailability.attempts.length);
        assert.equal(grokAvailabilityAttempts.length, 1);
        assert.deepEqual(
            { provider: grokAvailabilityAttempts[0]?.provider, probe: grokAvailabilityAttempts[0]?.probe, settlement: grokAvailabilityAttempts[0]?.settlement },
            { provider: "grok", probe: true, settlement: "success" },
        );
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).shadowGrants, 3);

        const beforeAgyAvailability = getProviderTransportAdapter().diagnostics();
        assert.equal(await isAgyBridgeAvailable({ agyCommand: process.execPath, agyCommandArgs: [fakeAgyPath] }), true);
        const agyAvailabilityAttempts = getProviderTransportAdapter().diagnostics().attempts.slice(beforeAgyAvailability.attempts.length);
        assert.equal(agyAvailabilityAttempts.length, 1);
        assert.deepEqual(
            { provider: agyAvailabilityAttempts[0]?.provider, probe: agyAvailabilityAttempts[0]?.probe, settlement: agyAvailabilityAttempts[0]?.settlement },
            { provider: "agy", probe: true, settlement: "success" },
        );
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("agy")).shadowGrants, 1);

        const dataRoot = path.join(tempRoot, "data-root");
        await configureProviderTransportAdapterForTest({ mode: "test", dataRoot, ownerId: "provider-transport-wiring-test" });
        process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = "8";
        resetGrokCallConcurrencyForTest();
        grokMode = "slow-body";
        slowBodyStarted = false;
        const beforeSlowBody = getProviderTransportAdapter().diagnostics();
        const slowBodyCall = callGrokExec("slow body", "grok-test", 2_000);
        await waitFor(() => slowBodyStarted, "slow Grok response did not send headers");
        assert.equal(getProviderTransportAdapter().diagnostics().settleCount, beforeSlowBody.settleCount, "permit must remain active until the response body is consumed");
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).active, 1);
        assert.equal((await slowBodyCall).text, "grok:slow");
        assert.equal(getProviderTransportAdapter().diagnostics().settleCount, beforeSlowBody.settleCount + 1);
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).active, 0);

        const grokQueueRoot = path.join(tempRoot, "grok-queue-data-root");
        await initializeProviderControlStore({ dataRoot: grokQueueRoot, initialization: "exclusive-install" });
        await configureProviderTransportAdapterForTest({ mode: "enforced", dataRoot: grokQueueRoot, ownerId: "provider-transport-grok-queue-test" });
        grokMode = "hold";
        holdDelayMs = 1_500;
        const postsBeforeQueue = postCount;
        const firstQueuedHolder = callGrokExec("grok queue holder one", "grok-test", 5_000);
        const secondQueuedHolder = callGrokExec("grok queue holder two", "grok-test", 5_000);
        await waitFor(() => postCount === postsBeforeQueue + 2, "two Grok holders did not reach the fake transport");
        const queuedGrokAbort = new AbortController();
        const cancelledBeforePost = callGrokExec("grok cancelled in provider queue", "grok-test", 5_000, 128, {
            signal: queuedGrokAbort.signal,
            queueTimeoutMs: 10,
            queueRetryLimit: 0,
        });
        await waitFor(
            async () => (await getProviderTransportAdapter().admissionSnapshot("grok")).queuedForeground === 1,
            "Grok request did not enter provider admission queue",
        );
        await delay(75);
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).queuedForeground, 1, "legacy queueTimeoutMs must not terminate provider admission waiting");
        assert.equal(postCount, postsBeforeQueue + 2, "provider-queued Grok request must not execute an HTTP POST before its permit");
        queuedGrokAbort.abort();
        assert.equal((await cancelledBeforePost).cancelled, true);
        assert.equal(postCount, postsBeforeQueue + 2, "cancelled provider-queued Grok request must not execute an HTTP POST");
        const grokAfterQueueCancel = await getProviderTransportAdapter().admissionSnapshot("grok");
        assert.equal(grokAfterQueueCancel.queuedForeground, 0);
        assert.ok(grokAfterQueueCancel.active <= 2);
        await Promise.all([firstQueuedHolder, secondQueuedHolder]);
        const grokAfterQueueDrain = await getProviderTransportAdapter().admissionSnapshot("grok");
        assert.equal(grokAfterQueueDrain.queuedForeground, 0);
        assert.equal(grokAfterQueueDrain.active, 0);

        const agyQueueRoot = path.join(tempRoot, "agy-queue-data-root");
        await initializeProviderControlStore({ dataRoot: agyQueueRoot, initialization: "exclusive-install" });
        await configureProviderTransportAdapterForTest({ mode: "enforced", dataRoot: agyQueueRoot, ownerId: "provider-transport-agy-queue-test" });
        await fs.rm(fakeAgyLogPath, { force: true });
        const agyQueueEnv = { ...process.env, FAKE_AGY_MODE: "hang", FAKE_AGY_LOG: fakeAgyLogPath };
        const agySpawnsBeforeQueue = await lineCount(fakeAgyLogPath);
        const firstAgyHolder = callAgyModel("agy queue holder one", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: agyQueueEnv,
            timeoutMs: 3_000,
        });
        const secondAgyHolder = callAgyModel("agy queue holder two", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: agyQueueEnv,
            timeoutMs: 3_000,
        });
        await waitFor(
            async () => await lineCount(fakeAgyLogPath) === agySpawnsBeforeQueue + 2,
            "two agy holders did not spawn",
        );
        const queuedAgyAbort = new AbortController();
        const cancelledBeforeSpawn = callAgyModel("agy cancelled in provider queue", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: agyQueueEnv,
            signal: queuedAgyAbort.signal,
            timeoutMs: 3_000,
        });
        await waitFor(
            async () => (await getProviderTransportAdapter().admissionSnapshot("agy")).queuedForeground === 1,
            "agy request did not enter provider admission queue",
        );
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeQueue + 2, "provider-queued agy request must not spawn a CLI process before its permit");
        queuedAgyAbort.abort();
        const cancelledAgyResult = await cancelledBeforeSpawn;
        assert.equal(cancelledAgyResult.cancelled, true);
        assert.equal(cancelledAgyResult.launched, false);
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeQueue + 2, "cancelled provider-queued agy request must not spawn a CLI process");
        const agyAfterQueueCancel = await getProviderTransportAdapter().admissionSnapshot("agy");
        assert.equal(agyAfterQueueCancel.queuedForeground, 0);
        assert.ok(agyAfterQueueCancel.active <= 2);
        await Promise.all([firstAgyHolder, secondAgyHolder]);
        const agyAfterQueueDrain = await getProviderTransportAdapter().admissionSnapshot("agy");
        assert.equal(agyAfterQueueDrain.queuedForeground, 0);
        assert.equal(agyAfterQueueDrain.active, 0);

        await configureProviderTransportAdapterForTest({ mode: "test", dataRoot, ownerId: "provider-transport-wiring-test" });
        grokMode = "success";
        holdDelayMs = 300;
        const directStart = await getProviderTransportAdapter().admissionSnapshot("grok");
        assert.equal(directStart.queuedForeground, 0);
        assert.equal(directStart.active, 0);
        assert.equal(directStart.uncertain, 0);

        const beforeDirect = getProviderTransportAdapter().diagnostics();
        const directGrok = await callGrokExec("direct grok", "grok-test", 1_000, 128, { trafficClass: "record-batch" });
        assert.equal(directGrok.text, "grok:ok", directGrok.error);
        const directAgy = await callAgyModel("direct agy", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            trafficClass: "record",
        });
        assert.match(directAgy.text || "", /^agy:/u);
        const afterDirect = getProviderTransportAdapter().diagnostics();
        assert.equal(afterDirect.acquireCount - beforeDirect.acquireCount, 2, "direct Grok and agy calls each acquire exactly once");
        assert.equal(afterDirect.settleCount - beforeDirect.settleCount, 2, "direct Grok and agy calls each settle exactly once");
        assert.equal(afterDirect.attempts.at(-2)?.trafficClass, "record");
        assert.equal(afterDirect.attempts.at(-1)?.trafficClass, "record");

        const cancelAfterCandidatesLease = await getProviderTransportAdapter().acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-cancel-after-candidates",
        });
        const afterCancelAfterCandidatesAcquire = getProviderTransportAdapter().diagnostics();
        const postsBeforeCancelAfterCandidates = postCount;
        let candidateCancellationChecks = 0;
        const cancelledAfterCandidates = await callModelResponse("grok-test", "cancel after candidates", "auto", 1_000, {
            providerLease: cancelAfterCandidatesLease,
            attemptId: "scheduler-cancel-after-candidates",
            shouldCancel: () => ++candidateCancellationChecks >= 2,
        });
        assert.equal(cancelledAfterCandidates.cancelled, true);
        assert.equal(candidateCancellationChecks, 2, "cancellation must become visible after candidates resolve and before provider execution");
        assert.equal(postCount, postsBeforeCancelAfterCandidates, "post-candidate cancellation must not execute a Grok HTTP request");
        const afterCancelAfterCandidates = getProviderTransportAdapter().diagnostics();
        assert.equal(afterCancelAfterCandidates.acquireCount, afterCancelAfterCandidatesAcquire.acquireCount);
        assert.equal(afterCancelAfterCandidates.settleCount, afterCancelAfterCandidatesAcquire.settleCount + 1, "unused granted lease must settle exactly once");
        assert.equal(afterCancelAfterCandidates.attempts.at(-1)?.attemptId, "scheduler-cancel-after-candidates");
        assert.equal(afterCancelAfterCandidates.attempts.at(-1)?.settlement, "cancelled");
        assert.equal((await getProviderTransportAdapter().admissionSnapshot("grok")).active, 0, "cancelled unused lease must leave no active provider permit");

        const unsupportedLease = await getProviderTransportAdapter().acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-unsupported-chain",
        });
        const afterUnsupportedAcquire = getProviderTransportAdapter().diagnostics();
        const postsBeforeUnsupported = postCount;
        const unsupported = await callModelResponse("grok-test", "unsupported chain", "windsurf", 1_000, {
            providerLease: unsupportedLease,
            attemptId: "scheduler-unsupported-chain",
        });
        assert.match(unsupported.error || "", /Windsurf 只支持 dataChain/u);
        assert.equal(postCount, postsBeforeUnsupported);
        const afterUnsupported = getProviderTransportAdapter().diagnostics();
        assert.equal(afterUnsupported.settleCount, afterUnsupportedAcquire.settleCount + 1);
        assert.equal(afterUnsupported.attempts.at(-1)?.settlement, "cancelled");

        const throwingChainLease = await getProviderTransportAdapter().acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-throw-before-provider",
        });
        const afterThrowingChainAcquire = getProviderTransportAdapter().diagnostics();
        const postsBeforeThrowingChain = postCount;
        const chainResolutionError = new Error("chain conversion failed");
        const throwingChain = {
            toString() {
                throw chainResolutionError;
            },
        } as unknown as string;
        await assert.rejects(
            callModelResponse("grok-test", "throw before provider", throwingChain, 1_000, {
                providerLease: throwingChainLease,
                attemptId: "scheduler-throw-before-provider",
            }),
            error => error === chainResolutionError,
        );
        assert.equal(postCount, postsBeforeThrowingChain);
        const afterThrowingChain = getProviderTransportAdapter().diagnostics();
        assert.equal(afterThrowingChain.settleCount, afterThrowingChainAcquire.settleCount + 1);
        assert.equal(afterThrowingChain.attempts.at(-1)?.settlement, "cancelled");

        const mismatchLease = await getProviderTransportAdapter().acquire("agy", {
            trafficClass: "record",
            attemptId: "scheduler-provider-mismatch",
        });
        const afterMismatchAcquire = getProviderTransportAdapter().diagnostics();
        const postsBeforeMismatch = postCount;
        const agySpawnsBeforeMismatch = await lineCount(fakeAgyLogPath);
        const mismatch = await callModelResponse("grok-test", "provider mismatch", "grok", 1_000, {
            providerLease: mismatchLease,
            attemptId: "scheduler-provider-mismatch",
        });
        assert.match(mismatch.error || "", /不能用于 modelChain=grok/u);
        assert.equal(postCount, postsBeforeMismatch);
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeMismatch);
        const afterMismatch = getProviderTransportAdapter().diagnostics();
        assert.equal(afterMismatch.settleCount, afterMismatchAcquire.settleCount + 1);
        assert.equal(afterMismatch.attempts.at(-1)?.settlement, "cancelled");

        const cancelledGrokLease = await getProviderTransportAdapter().acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-direct-grok-cancel",
        });
        const afterCancelledGrokAcquire = getProviderTransportAdapter().diagnostics();
        const postsBeforeCancelledGrok = postCount;
        const cancelledGrokSignal = new AbortController();
        cancelledGrokSignal.abort();
        const cancelledGrantedGrok = await callGrokExec("cancelled granted grok", "grok-test", 1_000, 128, {
            providerLease: cancelledGrokLease,
            attemptId: "scheduler-direct-grok-cancel",
            signal: cancelledGrokSignal.signal,
        });
        assert.equal(cancelledGrantedGrok.cancelled, true);
        assert.equal(postCount, postsBeforeCancelledGrok);
        const afterCancelledGrok = getProviderTransportAdapter().diagnostics();
        assert.equal(afterCancelledGrok.settleCount, afterCancelledGrokAcquire.settleCount + 1);
        assert.equal(afterCancelledGrok.attempts.at(-1)?.settlement, "cancelled");

        const invalidAgyLease = await getProviderTransportAdapter().acquire("agy", {
            trafficClass: "record",
            attemptId: "scheduler-direct-agy-invalid",
        });
        const afterInvalidAgyAcquire = getProviderTransportAdapter().diagnostics();
        const agySpawnsBeforeInvalid = await lineCount(fakeAgyLogPath);
        const invalidGrantedAgy = await callAgyModel("invalid granted agy", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath, "--help"],
            providerLease: invalidAgyLease,
            attemptId: "scheduler-direct-agy-invalid",
        });
        assert.equal(invalidGrantedAgy.failureClass, "DeterministicInput");
        assert.equal(invalidGrantedAgy.launched, false);
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeInvalid);
        const afterInvalidAgy = getProviderTransportAdapter().diagnostics();
        assert.equal(afterInvalidAgy.settleCount, afterInvalidAgyAcquire.settleCount + 1);
        assert.equal(afterInvalidAgy.attempts.at(-1)?.settlement, "cancelled");

        const grantedGrokLease = await getProviderTransportAdapter().acquire("grok", {
            trafficClass: "record",
            attemptId: "scheduler-pregranted-grok",
        });
        const afterGrantedGrokAcquire = getProviderTransportAdapter().diagnostics();
        const grokPostsBeforeGrantedExecution = postCount;
        const grantedGrok = await callGrokExec("granted grok", "grok-test", 1_000, 128, {
            providerLease: grantedGrokLease,
            providerTrafficClass: "record",
            attemptId: "scheduler-pregranted-grok",
        });
        assert.equal(grantedGrok.text, "grok:ok", grantedGrok.error);
        assert.equal(postCount, grokPostsBeforeGrantedExecution + 1, "a granted Grok lease must execute one HTTP POST");
        const afterGrantedGrok = getProviderTransportAdapter().diagnostics();
        assert.equal(afterGrantedGrok.acquireCount, afterGrantedGrokAcquire.acquireCount, "Grok must not acquire beneath a granted lease");
        assert.equal(afterGrantedGrok.settleCount, afterGrantedGrokAcquire.settleCount + 1);
        assert.equal(afterGrantedGrok.attempts.at(-1)?.attemptId, "scheduler-pregranted-grok");

        const grantedAgyLease = await getProviderTransportAdapter().acquire("agy", {
            trafficClass: "record",
            attemptId: "scheduler-pregranted-agy-fallback",
        });
        const afterGrantedAgyAcquire = getProviderTransportAdapter().diagnostics();
        const agySpawnsBeforeGrantedFallback = await lineCount(fakeAgyLogPath);
        const grantedFallback = await callAgyWithFallback("granted fallback", {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: { ...process.env, FAKE_AGY_MODE: "fail", FAKE_AGY_LOG: fakeAgyLogPath },
            trafficClass: "record",
            providerLease: grantedAgyLease,
            attemptId: "scheduler-pregranted-agy-fallback",
        });
        assert.equal(grantedFallback.attempts.length, 3);
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeGrantedFallback + 3, "the granted agy fallback must still run its three physical CLI attempts");
        const afterGrantedAgyFallback = getProviderTransportAdapter().diagnostics();
        assert.equal(afterGrantedAgyFallback.acquireCount, afterGrantedAgyAcquire.acquireCount, "agy fallback must not reacquire after consuming its outer lease");
        assert.equal(afterGrantedAgyFallback.settleCount, afterGrantedAgyAcquire.settleCount + 1, "one outer agy lease must settle once after fallback exhausts");
        assert.equal(afterGrantedAgyFallback.attempts.at(-1)?.attemptId, "scheduler-pregranted-agy-fallback");

        const grantedBridgeLease = await getProviderTransportAdapter().acquire("agy", {
            trafficClass: "record",
            attemptId: "scheduler-pregranted-bridge-agy",
        });
        const afterGrantedBridgeAcquire = getProviderTransportAdapter().diagnostics();
        const agySpawnsBeforeGrantedBridge = await lineCount(fakeAgyLogPath);
        const grantedBridge = await callModelResponse("agy-test", "granted bridge", "auto", 1_000, {
            agyCommand: process.execPath,
            agyCommandArgs: [fakeAgyPath],
            providerLease: grantedBridgeLease,
            attemptId: "scheduler-pregranted-bridge-agy",
            trafficClass: "record-batch",
        });
        assert.equal(grantedBridge.chainUsed, "agy", grantedBridge.error);
        assert.equal(await lineCount(fakeAgyLogPath), agySpawnsBeforeGrantedBridge + 1, "model bridge must route an agy lease directly without availability probing or another acquire");
        const afterGrantedBridge = getProviderTransportAdapter().diagnostics();
        assert.equal(afterGrantedBridge.acquireCount, afterGrantedBridgeAcquire.acquireCount, "model bridge must not acquire beneath a granted lease");
        assert.equal(afterGrantedBridge.settleCount, afterGrantedBridgeAcquire.settleCount + 1);
        assert.equal(afterGrantedBridge.attempts.at(-1)?.attemptId, "scheduler-pregranted-bridge-agy");

        const beforeSpawnFailure = getProviderTransportAdapter().diagnostics();
        const spawnFailure = await callAgyModel("spawn failure", AGY_MODEL_SEQUENCE[0], {
            command: path.join(tempRoot, "missing-agy-command.exe"),
            trafficClass: "foreground",
        });
        assert.equal(spawnFailure.text, null);
        assert.equal(spawnFailure.launched, false);
        assert.equal(spawnFailure.failureClass, "Availability");
        const spawnFailureAttempts = getProviderTransportAdapter().diagnostics().attempts.slice(beforeSpawnFailure.attempts.length);
        assert.equal(spawnFailureAttempts.length, 1);
        assert.equal(spawnFailureAttempts[0]?.settlement, "availability");
        assert.equal(spawnFailureAttempts[0]?.permitSettled, true);

        const probe = await probeAgy({ command: process.execPath, commandArgs: [fakeAgyPath], trafficClass: "foreground" });
        assert.equal(probe.available, true);
        assert.equal(getProviderTransportAdapter().diagnostics().attempts.at(-1)?.probe, true, "agy probe must also use the adapter");

        const beforeFallback = getProviderTransportAdapter().diagnostics();
        const fallback = await callAgyWithFallback("fallback", {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: { ...process.env, FAKE_AGY_MODE: "fail" },
            trafficClass: "record",
        });
        assert.equal(fallback.attempts.length, 3);
        const fallbackAttempts = getProviderTransportAdapter().diagnostics().attempts.slice(beforeFallback.attempts.length);
        assert.equal(fallbackAttempts.length, 3, "agy fallback must acquire and settle once for every actual spawn");
        assert.ok(fallbackAttempts.every(attempt => attempt.provider === "agy" && attempt.trafficClass === "record" && attempt.settlement === "congestion"));

        grokMode = "failure";
        resetGrokBridgeAvailabilityForTest();
        const bridged = await callModelResponse("grok-test", "bridge fallback", "auto", 2_000, {
            agyCommand: process.execPath,
            agyCommandArgs: [fakeAgyPath],
            trafficClass: "record-batch",
        });
        assert.equal(bridged.chainUsed, "agy", bridged.error || "Grok transport failure should fall back to agy");
        assert.equal(getProviderTransportAdapter().diagnostics().attempts.at(-2)?.trafficClass, "record");
        assert.equal(getProviderTransportAdapter().diagnostics().attempts.at(-1)?.trafficClass, "record");

        grokMode = "hold";
        holdDelayMs = 2_000;
        const beforeTimeout = getProviderTransportAdapter().diagnostics();
        const timedOut = await callGrokExec("timeout", "grok-test", 1_000);
        assert.equal(timedOut.timedOut, true);
        await waitFor(
            () => getProviderTransportAdapter().diagnostics().attempts.length === beforeTimeout.attempts.length + 1,
            "Grok transport timeout did not settle its adapter permit",
        );
        assert.equal(getProviderTransportAdapter().diagnostics().attempts.at(-1)?.settlement, "unknown");
        holdDelayMs = 300;

        const abortController = new AbortController();
        const cancelled = callAgyModel("cancel", AGY_MODEL_SEQUENCE[0], {
            command: process.execPath,
            commandArgs: [fakeAgyPath],
            env: { ...process.env, FAKE_AGY_MODE: "hang" },
            signal: abortController.signal,
            timeoutMs: 1_000,
        });
        setTimeout(() => abortController.abort(), 25).unref?.();
        assert.equal((await cancelled).cancelled, true);
        assert.equal(getProviderTransportAdapter().diagnostics().attempts.at(-1)?.settlement, "unknown");

        console.log("provider transport wiring tests passed");
    } finally {
        await resetProviderTransportAdapterForTest();
        resetGrokCallConcurrencyForTest();
        resetGrokBridgeAvailabilityForTest();
        if (previousProxyUrl === undefined) delete process.env.MEMORY_STORE_GROK_PROXY_URL;
        else process.env.MEMORY_STORE_GROK_PROXY_URL = previousProxyUrl;
        if (previousConcurrency === undefined) delete process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
        else process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = previousConcurrency;
        if (previousAgyAuto === undefined) delete process.env.MEMORY_STORE_AGY_AUTO_ENABLED;
        else process.env.MEMORY_STORE_AGY_AUTO_ENABLED = previousAgyAuto;
        if (previousDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
        else process.env.MEMORY_STORE_DATA_ROOT = previousDataRoot;
        if (previousFakeAgyLog === undefined) delete process.env.FAKE_AGY_LOG;
        else process.env.FAKE_AGY_LOG = previousFakeAgyLog;
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
