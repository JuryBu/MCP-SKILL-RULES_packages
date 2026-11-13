import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { validateAppLsHub } from "../src/ls-app-discovery.ts";
import { parseLsModelCatalog, selectLsModelCandidates } from "../src/ls-model-catalog.ts";
import { isOwnedCliLsLog, runLsModelRequest, type LsModelConnection } from "../src/ls-model-runtime.ts";

const entry = (model: string, label: string, disabled = false, remaining = 1) => ({ modelOrAlias: { model }, label, modelId: label.toLowerCase().replace(/[^a-z0-9]+/gu, "-"), disabled, quotaInfo: { remainingFraction: remaining } });
const envelope = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    entry("MODEL_PLACEHOLDER_M318", "Gemini 3.8 Flash (High)"),
    entry("MODEL_PLACEHOLDER_M319", "Gemini 3.8 Flash (Medium)"),
    entry("MODEL_PLACEHOLDER_M320", "Gemini 3.8 Flash (Low)", false, 0),
    entry("MODEL_PLACEHOLDER_M437", "Gemini 4 Carbon (Medium)"),
    entry("MODEL_PLACEHOLDER_M427", "Gemini 4 Carbon (High)"),
    entry("MODEL_PLACEHOLDER_M417", "Gemini 4 Argon (High)"),
    entry("MODEL_PLACEHOLDER_M670", "Old Carbon", true),
    entry("MODEL_PLACEHOLDER_M402", "Claude Opus 5.5 (High)"),
] } } };
const catalog = parseLsModelCatalog(envelope)!;
assert.equal(catalog.length, 8);
assert.equal(parseLsModelCatalog({}), null);
assert.deepEqual(selectLsModelCandidates("MODEL_PLACEHOLDER_M318", catalog), ["MODEL_PLACEHOLDER_M318", "MODEL_PLACEHOLDER_M319"]);
assert.deepEqual(selectLsModelCandidates("MODEL_PLACEHOLDER_M20", catalog), ["MODEL_PLACEHOLDER_M427", "MODEL_PLACEHOLDER_M417", "MODEL_PLACEHOLDER_M437"]);
assert.deepEqual(selectLsModelCandidates("M402", catalog), ["MODEL_PLACEHOLDER_M402"]);
assert.deepEqual(selectLsModelCandidates("Claude Opus 5.5 (High)", catalog), ["MODEL_PLACEHOLDER_M402"]);
assert.deepEqual(selectLsModelCandidates("MODEL_PLACEHOLDER_M670", catalog), []);
assert.deepEqual(selectLsModelCandidates("MODEL_PLACEHOLDER_M318", []), []);
assert.equal(selectLsModelCandidates("MODEL_PLACEHOLDER_M318", null)[0], "MODEL_PLACEHOLDER_M132");
assert.equal(selectLsModelCandidates("MODEL_PLACEHOLDER_M20", null)[0], "MODEL_PLACEHOLDER_M20");
assert.deepEqual(selectLsModelCandidates("flash", catalog, "MODEL_PLACEHOLDER_M402").slice(-1), ["MODEL_PLACEHOLDER_M402"]);

const hub = { pid: 42, httpPort: 12345, csrfToken: "fixture-token" };
const processes = [{ pid: 42, name: "language_server.exe", executablePath: "C:/Apps/Antigravity/language_server.exe", ports: [12345] }];
assert.equal(validateAppLsHub(hub, "hub_12345.json", processes)?.transport, "app");
assert.equal(validateAppLsHub(hub, "hub_54321.json", processes), null);
assert.equal(validateAppLsHub({ ...hub, csrfToken: "" }, "hub_12345.json", processes), null);
assert.equal(validateAppLsHub(hub, "hub_12345.json", [{ ...processes[0], pid: 43 }]), null);
assert.equal(validateAppLsHub(hub, "hub_12345.json", [{ ...processes[0], name: "other.exe" }]), null);
assert.equal(validateAppLsHub(hub, "hub_12345.json", [{ ...processes[0], executablePath: "C:/Apps/NotAntigravity/language_server.exe" }]), null);
assert.equal(validateAppLsHub(hub, "hub_12345.json", [{ ...processes[0], ports: [54321] }]), null);
const log = "Starting language server process with pid 42\nLanguage server listening on random port at 12345 for HTTP\n";
assert.equal(isOwnedCliLsLog(log, 42), 12345);
assert.equal(isOwnedCliLsLog(log, 43), null);

let mode: "success" | "unknown-model" | "internal" | "quota" | "auth" | "capacity" | "capacity-fallback" | "empty" | "disconnect" | "hang" = "success";
let legacy = false;
let received: any[] = [];
let disconnected = 0;
let catalogStatus = 200;
let rejectedStatus = 0;
const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.setHeader("Content-Type", "application/json");
        if (request.url?.endsWith("/GetUserStatus")) {
            response.statusCode = legacy ? 404 : catalogStatus;
            response.end(JSON.stringify(legacy ? {} : envelope));
            return;
        }
        received.push(payload);
        if (rejectedStatus) { response.statusCode = rejectedStatus; response.end('{"message":"unknown model key"}'); return; }
        assert.deepEqual(Object.keys(payload).sort(), ["model", "prompt"]);
        response.on("close", () => { disconnected++; });
        if (mode === "hang") return;
        if (mode === "disconnect") { response.destroy(); return; }
        if (mode === "internal") { response.statusCode = 500; response.end('{"message":"internal failure"}'); return; }
        if (mode === "quota") { response.statusCode = 429; response.end('{"message":"quota exhausted"}'); return; }
        if (mode === "auth") { response.statusCode = 403; response.end('{"message":"access denied"}'); return; }
        if (mode === "capacity" || mode === "capacity-fallback" && payload.model === "MODEL_PLACEHOLDER_M318") { response.statusCode = 503; response.end('{"message":"No capacity available for model fixture"}'); return; }
        if (mode === "unknown-model" && payload.model === "MODEL_PLACEHOLDER_M318") { response.statusCode = 500; response.end('{"message":"unknown model key"}'); return; }
        response.end(JSON.stringify({ response: mode === "empty" ? "" : payload.model }));
    });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const connection: LsModelConnection = { info: { pid: process.pid, csrfToken: "fixture-token", workspaceId: "", ports: [port], transport: "app" }, port };
const invoke = (timeout = 2000, extra = {}) => runLsModelRequest("MODEL_PLACEHOLDER_M318", "fixture prompt", timeout, { connection, ...extra });

try {
    let releases = 0;
    const successful = await invoke(2000, { connection: { ...connection, release: async () => { releases++; } } });
    assert.equal(successful.text, "MODEL_PLACEHOLDER_M318");
    assert.equal(successful.modelUsed, "MODEL_PLACEHOLDER_M318");
    assert.equal(releases, 1);

    received = [];
    mode = "unknown-model";
    const fallback = await invoke();
    assert.equal(fallback.text, "MODEL_PLACEHOLDER_M319");
    assert.equal(received.length, 2);

    received = [];
    mode = "capacity-fallback";
    const capacityFallback = await invoke();
    assert.equal(capacityFallback.text, "MODEL_PLACEHOLDER_M319");
    assert.equal(received.length, 2);
    received = [];
    const boundedCapacity = await invoke(2000, { maxGenerationAttempts: 1 });
    assert.equal(boundedCapacity.text, null);
    assert.equal(boundedCapacity.failureClass, "Congestion");
    assert.equal(received.length, 1);

    for (const failureMode of ["internal", "quota", "auth", "capacity", "disconnect"] as const) {
        received = [];
        mode = failureMode;
        const failed = await invoke();
        assert.equal(failed.text, null);
        assert.equal(received.length, failureMode === "capacity" ? 2 : 1);
        assert.equal(failed.failureClass, failureMode === "auth" ? "DeterministicInput" : failureMode === "quota" || failureMode === "capacity" ? "Congestion" : "UnknownOutcome");
        if (failureMode === "quota" || failureMode === "auth") assert.equal(failed.safetyStopped, true);
    }

    for (const status of [401, 403, 429]) {
        received = [];
        rejectedStatus = status;
        const stopped = await invoke();
        assert.equal(stopped.safetyStopped, true);
        assert.equal(stopped.failureClass, status === 429 ? "Congestion" : "DeterministicInput");
        assert.equal(received.length, 1);
    }
    rejectedStatus = 0;
    for (const status of [401, 403, 429]) {
        received = [];
        catalogStatus = status;
        const stopped = await invoke();
        assert.equal(stopped.safetyStopped, true);
        assert.equal(stopped.failureClass, status === 429 ? "Congestion" : "DeterministicInput");
        assert.equal(received.length, 0);
    }
    catalogStatus = 200;

    received = [];
    mode = "hang";
    const timedOut = await invoke(80);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.failureClass, "UnknownOutcome");
    assert.equal(received.length, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(disconnected > 0);

    received = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const cancelled = await invoke(2000, { signal: controller.signal });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.failureClass, "UnknownOutcome");
    assert.equal(received.length, 1);

    received = [];
    mode = "success";
    const validated = await invoke(2000, { validator: (_text: string, model: string) => model.endsWith("318") ? "fixture rejected" : null });
    assert.equal(validated.modelUsed, "MODEL_PLACEHOLDER_M319");
    assert.equal(received.length, 2);

    received = [];
    legacy = true;
    const old = await invoke(2000, { connection: { ...connection, info: { ...connection.info, transport: "legacy" } } });
    assert.equal(old.modelUsed, "MODEL_PLACEHOLDER_M132");
    assert.equal(received.length, 1);
    const failClosed = await invoke();
    assert.equal(failClosed.text, null);
    assert.equal(received.length, 1);
    legacy = false;

    const cleanup = await invoke(2000, { connection: { ...connection, release: async () => { throw new Error("fixture cleanup error"); } } });
    assert.equal(cleanup.text, null);
    assert.equal(cleanup.failureClass, "UnknownOutcome");
    assert.match(cleanup.error!, /cleanup unverified/u);
    console.log("ls-model-runtime.test.ts PASS: catalog, hub ownership, CLI ownership, payload, fallback, cancel, unknown outcome, legacy, cleanup");
} finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}
