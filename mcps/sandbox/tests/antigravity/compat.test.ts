import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { parseAntigravityCatalog, selectAntigravityModel, readAntigravityCatalogFixture, AntigravityCallError } from "../../src/antigravity-model-catalog.js";
import { discoverAntigravityLsCandidates, isAntigravityLsIdentity, validateAntigravityHub, legacyAntigravityCandidate,
    type AntigravityProcessIdentity } from "../../src/antigravity-discovery.js";
import { __setParentLsForTest, __setAntigravityRuntimeForTest, callGetModelResponseDetailed,
    getAntigravityModelCatalog, initParentLs, resolveAntigravityCliModel, resolveLsModelName } from "../../src/ls-client.js";
import { callModelBridge } from "../../src/model-bridge.js";
import { callCouncilModel } from "../../src/council/providers.js";
import { buildCouncilFileIndex } from "../../src/council/cli-indexer.js";
import { __setAntigravityAgentCliRunnerForTest } from "../../src/antigravity-agent-cli.js";

const rejectLiveCli = async (): Promise<never> => { throw new Error("AGY fixture test forbids starting a real CLI"); };
__setAntigravityAgentCliRunnerForTest(rejectLiveCli);
mock.method(childProcess, "spawn", () => { throw new Error("AGY fixture test forbids native process launch"); });
mock.method(childProcess, "spawnSync", () => { throw new Error("AGY fixture test forbids native process launch"); });
syncBuiltinESMExports();
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

const originalFixture = process.env.SANDBOX_AGY_CATALOG_PATH;
const originalMaxAge = process.env.SANDBOX_AGY_CATALOG_MAX_AGE_MS;
const directories: string[] = [];
const ownedFiles: string[] = [];
const models = [
    { label: "Gemini 3.8 Flash (High)", id: "gemini-3.8-flash-high", model: "MODEL_PLACEHOLDER_M901", disabled: false, remaining: 0.5 },
    { label: "Gemini 4 Argon (High)", id: "gemini-4-argon-high", model: "MODEL_PLACEHOLDER_M902", disabled: false, remaining: 0.5 },
    { label: "Gemini 4 Carbon (High)", id: "gemini-4-carbon-high", model: "MODEL_PLACEHOLDER_M903", disabled: false, remaining: 0.5 },
    { label: "Claude Opus 5.5 (High)", id: "claude-opus-5-5-high", model: "MODEL_PLACEHOLDER_M904", disabled: false, remaining: 1 },
    { label: "Gemini 4 Hydrogen (High)", id: "gemini-4-hydrogen-high", model: "MODEL_PLACEHOLDER_M905", disabled: false, remaining: 0.5 },
    { label: "Orchestrator (Carbon)", id: "gemini-pro-orchestrator", model: "MODEL_PLACEHOLDER_M906", disabled: false, remaining: 0.5 },
];

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-agy-test-"));
    directories.push(directory);
    return directory;
}

function fixture(entries = models): string {
    const filePath = path.join(temporaryDirectory(), "catalog.json");
    fs.writeFileSync(filePath, JSON.stringify({ observedAt: new Date().toISOString(), models: entries }));
    process.env.SANDBOX_AGY_CATALOG_PATH = filePath;
    return filePath;
}

afterEach(() => {
    __setAntigravityRuntimeForTest();
    __setAntigravityAgentCliRunnerForTest(rejectLiveCli);
    if (originalFixture === undefined) delete process.env.SANDBOX_AGY_CATALOG_PATH;
    else process.env.SANDBOX_AGY_CATALOG_PATH = originalFixture;
    if (originalMaxAge === undefined) delete process.env.SANDBOX_AGY_CATALOG_MAX_AGE_MS;
    else process.env.SANDBOX_AGY_CATALOG_MAX_AGE_MS = originalMaxAge;
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    for (const filePath of ownedFiles.splice(0)) fs.rmSync(filePath, { force: true });
});

interface RequestRecord { method: string; body: any; headers: http.IncomingHttpHeaders; }

async function fakeLs(action: (port: number, requests: RequestRecord[]) => Promise<void>,
    handler: (request: RequestRecord, response: http.ServerResponse, incoming: http.IncomingMessage) => void): Promise<void> {
    const requests: RequestRecord[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer(async (incoming, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const entry = { method: incoming.url!.split("/").pop()!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: incoming.headers };
        requests.push(entry);
        handler(entry, response, incoming);
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await action((server.address() as import("node:net").AddressInfo).port, requests); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function inject(port: number, transport: "app-ls" | "legacy-ls" | "cli-ls" = "app-ls"): void {
    __setParentLsForTest({ info: { pid: 40001, csrfToken: transport === "cli-ls" ? "" : "fixture-csrf", workspaceId: "", ports: [port], transport }, port });
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

test("dynamic catalog maps semantic choices without embedding current enum numbers", () => {
    const catalog = parseAntigravityCatalog({ models })!;
    assert.equal(selectAntigravityModel(catalog).model, models[0].model);
    assert.equal(selectAntigravityModel(catalog, "pro").model, models[2].model);
    assert.equal(selectAntigravityModel(catalog, "argon").model, models[1].model);
    assert.equal(selectAntigravityModel(catalog, "carbon").model, models[2].model);
    assert.equal(selectAntigravityModel(catalog, "opus").model, models[3].model);
    assert.equal(selectAntigravityModel(catalog, "gemini-4-hydrogen-high").model, models[4].model);
    assert.equal(selectAntigravityModel(catalog, "gemini-pro-orchestrator").model, models[5].model);
    const changed = parseAntigravityCatalog({ models: [{ ...models[2], model: "MODEL_PLACEHOLDER_M987" }] })!;
    assert.equal(selectAntigravityModel(changed, "carbon").model, "MODEL_PLACEHOLDER_M987");
});

test("real supplied catalog is parsed read-only when explicitly provided", { skip: !process.env.SANDBOX_AGY_TEST_CATALOG_PATH }, () => {
    const raw = fs.readFileSync(process.env.SANDBOX_AGY_TEST_CATALOG_PATH!, "utf8");
    if (process.env.SANDBOX_AGY_TEST_CATALOG_SHA256) assert.equal(createHash("sha256").update(raw).digest("hex"), process.env.SANDBOX_AGY_TEST_CATALOG_SHA256);
    const catalog = parseAntigravityCatalog(JSON.parse(raw))!;
    assert.ok(catalog.models.length > 0);
    for (const choice of ["default", "argon", "carbon", "opus"]) {
        const selected = selectAntigravityModel(catalog, choice);
        assert.ok(catalog.models.includes(selected));
        assert.equal(selected.disabled, false);
    }
    assert.match(selectAntigravityModel(catalog).id, /flash-high$/u);
});

test("live GetUserStatus shape preserves quota, disabled state and notices", () => {
    const catalog = parseAntigravityCatalog({ userStatus: { cascadeModelConfigData: { clientModelConfigs: models.map(model => ({
        label: model.label, modelId: model.id, modelOrAlias: { model: model.model }, quotaInfo: { remainingFraction: model.remaining }, description: "Limited time",
    })) } } })!;
    assert.equal(catalog.source, "GetUserStatus");
    assert.equal(catalog.models[0].reason, "Limited time");
    assert.equal(catalog.models[0].remaining, 0.5);
    assert.equal(selectAntigravityModel(catalog).model, models[0].model);
});

test("explicit disabled or zero-quota models reject before submission", () => {
    for (const entry of [{ ...models[2], disabled: true, reason: "Ultra required" }, { ...models[2], remaining: 0 }]) {
        const catalog = parseAntigravityCatalog({ models: [models[0], entry] })!;
        assert.throws(() => selectAntigravityModel(catalog, entry.id), error => error instanceof AntigravityCallError && !error.submitted && !error.safeToFallback);
    }
    assert.throws(() => selectAntigravityModel(parseAntigravityCatalog({ models: [models[3], models[4], models[5]] })!), /flash high/iu);
    assert.throws(() => selectAntigravityModel(parseAntigravityCatalog({ models })!, "MODEL_PLACEHOLDER_M670"), /当前目录没有模型/u);
});

test("fixture freshness and changed content are checked without an RPC", () => {
    const filePath = fixture();
    const catalog = readAntigravityCatalogFixture()!;
    assert.equal(selectAntigravityModel(catalog).model, models[0].model);
    fs.writeFileSync(filePath, JSON.stringify({ observedAt: "2020-01-01T00:00:00Z", models }));
    assert.throws(() => readAntigravityCatalogFixture(), /过期/u);
});

const modernIdentity: AntigravityProcessIdentity = { pid: 42, name: "language_server.exe",
    executablePath: "C:\\Apps\\Antigravity\\resources\\language_server.exe", commandLine: '"C:\\Apps\\Antigravity\\resources\\language_server.exe" --csrf_token fixture-csrf --workspace_id ws',
    startedAt: "2026-11-13T04:00:00Z", ports: [34567] };

test("hub requires Antigravity executable identity, live PID, owned HTTP port and matching auth", () => {
    const hub = { pid: 42, httpPort: 34567, csrfToken: "fixture-csrf" };
    assert.equal(validateAntigravityHub(hub, modernIdentity)?.transport, "app-ls");
    assert.equal(validateAntigravityHub({ ...hub, pid: 43 }, modernIdentity), null);
    assert.equal(validateAntigravityHub({ ...hub, httpPort: 12345 }, modernIdentity), null);
    assert.equal(validateAntigravityHub({ ...hub, csrfToken: "wrong" }, modernIdentity), null);
    assert.equal(validateAntigravityHub(hub, { ...modernIdentity, executablePath: "C:\\Other\\language_server.exe", commandLine: "language_server.exe --csrf_token fixture-csrf" }), null);
    assert.equal(isAntigravityLsIdentity({ ...modernIdentity, name: "some-language-server.exe" }), false);
    assert.equal(isAntigravityLsIdentity({ ...modernIdentity, startedAt: "" }), false);
});

test("legacy process name and quoted command arguments remain supported", () => {
    const candidate = legacyAntigravityCandidate({ ...modernIdentity, name: "language_server_windows_x64.exe",
        commandLine: '"C:\\Apps\\Antigravity\\language_server_windows_x64.exe" --csrf_token="fixture-csrf" --workspace_id "quoted workspace"' })!;
    assert.equal(candidate.transport, "legacy-ls");
    assert.equal(candidate.workspaceId, "quoted workspace");
    assert.equal(candidate.csrfToken, "fixture-csrf");
    assert.equal(resolveLsModelName("gemini-3.1-pro-high"), "MODEL_PLACEHOLDER_M16");
    assert.equal(resolveLsModelName("m318"), "MODEL_PLACEHOLDER_M318");
});

test("discovery ignores stale hub files and deduplicates verified candidates", async () => {
    const hubDirectory = temporaryDirectory();
    fs.writeFileSync(path.join(hubDirectory, "hub_1.json"), JSON.stringify({ pid: 999, httpPort: 34567, csrfToken: "stale" }));
    fs.writeFileSync(path.join(hubDirectory, "hub_2.json"), JSON.stringify({ pid: 42, httpPort: 34567, csrfToken: "fixture-csrf" }));
    fs.writeFileSync(path.join(hubDirectory, "hub_3.json"), "invalid json");
    const candidates = await discoverAntigravityLsCandidates(undefined, { hubDirectory, processes: async () => [modernIdentity] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].pid, 42);
    assert.equal(candidates[0].transport, "app-ls");
});

test("App LS uses shared fixture and csrf; it does not start CLI or query status", async () => {
    fixture();
    let opens = 0;
    __setAntigravityRuntimeForTest({ openCli: async () => { opens++; throw new Error("unexpected CLI"); } });
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "fixture request", 2000);
        assert.equal(result.text, "APP_OK");
        assert.equal(result.model, models[0].model);
        assert.equal(result.transport, "app-ls");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers["x-codeium-csrf-token"], "fixture-csrf");
        assert.deepEqual(Object.keys(requests[0].body).sort(), ["model", "prompt"]);
        assert.equal(opens, 0);
    }, (request, response) => json(response, { response: "APP_OK" }));
});

test("dynamic live catalog is fetched once for concurrent requests", async () => {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    await fakeLs(async (port, requests) => {
        inject(port);
        const results = await Promise.all([callGetModelResponseDetailed("default", "one", 2000), callGetModelResponseDetailed("carbon", "two", 2000)]);
        assert.ok(results.every(result => result.text === "DYNAMIC_OK"));
        assert.equal(requests.filter(request => request.method === "GetUserStatus").length, 1);
        assert.deepEqual(results.map(result => result.model), [models[0].model, models[2].model]);
    }, (request, response) => request.method === "GetUserStatus" ? json(response, { userStatus: { cascadeModelConfigData: { clientModelConfigs: models.map(entry => ({ ...entry, modelId: entry.id, modelOrAlias: { model: entry.model } })) } } })
        : json(response, { response: "DYNAMIC_OK" }));
});

test("legacy default table falls back only on explicit unsupported-model rejection", async () => {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    await fakeLs(async (port, requests) => {
        inject(port, "legacy-ls");
        const result = await callGetModelResponseDetailed("default", "legacy", 2000);
        assert.equal(result.text, "LEGACY_OK");
        assert.deepEqual(requests.map(request => request.body.model), ["MODEL_PLACEHOLDER_M132", "MODEL_PLACEHOLDER_M20"]);
    }, (request, response) => request.body.model === "MODEL_PLACEHOLDER_M132" ? json(response, { message: "unknown model key" }, 500) : json(response, { response: "LEGACY_OK" }));
});

test("a modern LS without a catalog never mixes in old model constants", async () => {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "no legacy guessing", 2000);
        assert.equal(result.kind, "rejected");
        assert.equal(result.submitted, false);
        assert.equal(requests.filter(request => request.method === "GetModelResponse").length, 0);
    }, (_request, response) => json(response, { message: "unimplemented" }, 501));
});

test("a discovered legacy LS with an unsupported catalog keeps its original protocol", async () => {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    await fakeLs(async (port, requests) => {
        __setAntigravityRuntimeForTest({ discover: async () => [{ pid: 40011, csrfToken: "legacy-auth", workspaceId: "", ports: [port], transport: "legacy-ls" }] });
        const result = await callGetModelResponseDetailed("default", "legacy discovered", 2000);
        assert.equal(result.text, "OLD_PROTOCOL_OK");
        assert.equal(result.transport, "legacy-ls");
        assert.equal(requests.filter(request => request.method === "GetUserStatus").length, 1);
        assert.equal(requests.filter(request => request.method === "GetModelResponse")[0].body.model, "MODEL_PLACEHOLDER_M132");
    }, (request, response) => request.method === "GetUserStatus" ? json(response, { message: "unknown method" }, 404)
        : json(response, request.method === "Heartbeat" ? {} : { response: "OLD_PROTOCOL_OK" }));
});

test("catalog rejection or zero quota sends no generation request", async () => {
    fixture([{ ...models[0], remaining: 0 }]);
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "must not send", 2000);
        assert.equal(result.kind, "quota-exhausted");
        assert.equal(result.transport, "app-ls");
        assert.equal(result.submitted, false);
        assert.equal(result.safeToFallback, false);
        assert.equal(requests.length, 0);
    }, (_request, response) => json(response, { response: "UNEXPECTED" }));
});

test("auth and quota responses stop model and endpoint fallbacks", async () => {
    fixture();
    for (const status of [401, 403, 429]) await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "reject", 2000);
        assert.equal(result.outcomeUnknown, false);
        assert.equal(result.safeToFallback, false);
        assert.equal(result.kind, status === 429 ? "quota-exhausted" : "auth-required");
        assert.equal(requests.length, 1);
    }, (_request, response) => json(response, { message: status === 429 ? "quota exhausted" : "authentication required" }, status));
});

const flashLevels = [models[0],
    { ...models[0], label: "Gemini 3.8 Flash (Medium)", id: "gemini-3.8-flash-medium", model: "MODEL_PLACEHOLDER_M907" },
    { ...models[0], label: "Gemini 3.8 Flash (Low)", id: "gemini-3.8-flash-low", model: "MODEL_PLACEHOLDER_M908" }];

test("complete capacity rejection permits only the bounded default Flash siblings", async () => {
    fixture(flashLevels);
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "bounded default", 2000);
        assert.equal(result.text, "MEDIUM_OK");
        assert.equal(result.model, flashLevels[1].model);
        assert.deepEqual(requests.map(request => request.body.model), flashLevels.slice(0, 2).map(entry => entry.model));
    }, (request, response) => request.body.model === flashLevels[0].model
        ? json(response, { code: "unavailable", message: "No capacity available for gemini-3.8-flash-high" }, 503)
        : json(response, { response: "MEDIUM_OK" }));
});

test("all three default capacity rejections are known failures and terminate the chain", async () => {
    fixture(flashLevels);
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "capacity bound", 2000);
        assert.equal(result.kind, "rejected");
        assert.equal(result.outcomeUnknown, false);
        assert.equal(result.safeToFallback, false);
        assert.equal(requests.length, 3);
    }, (_request, response) => json(response, { code: "unavailable", message: "No capacity available for requested model" }, 503));
});

test("explicit Flash capacity rejection never changes the requested model", async () => {
    fixture(flashLevels);
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed(flashLevels[0].model, "explicit capacity", 2000);
        assert.equal(result.kind, "rejected");
        assert.equal(result.outcomeUnknown, false);
        assert.equal(result.safeToFallback, false);
        assert.equal(requests.length, 1);
    }, (_request, response) => json(response, { code: "unavailable", message: "No capacity available for gemini-3.8-flash-high" }, 503));
});

test("unrecognized 503 errors remain unknown rather than capacity fallbacks", async () => {
    fixture(flashLevels);
    await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "unknown 503", 2000);
        assert.equal(result.outcomeUnknown, true);
        assert.equal(requests.length, 1);
    }, (_request, response) => json(response, { message: "upstream response lost" }, 503));
});

test("submitted connection reset and malformed success are unknown, never replayed", async () => {
    fixture();
    for (const reset of [true, false]) await fakeLs(async (port, requests) => {
        inject(port);
        const result = await callGetModelResponseDetailed("default", "once", 2000);
        assert.equal(result.kind, "transport-unknown");
        assert.equal(result.submitted, true);
        assert.equal(result.outcomeUnknown, true);
        assert.equal(result.safeToFallback, false);
        assert.equal(requests.length, 1);
    }, (_request, response, incoming) => reset ? incoming.socket.destroy() : response.end("not a JSON response"));
});

test("one total deadline aborts the HTTP request and forbids replay", async () => {
    fixture();
    await fakeLs(async (port, requests) => {
        inject(port);
        const startedAt = Date.now();
        const result = await callGetModelResponseDetailed("default", "hang", 300);
        assert.ok(Date.now() - startedAt < 900);
        assert.equal(result.kind, "timeout-unknown");
        assert.equal(result.outcomeUnknown, true);
        assert.equal(result.timedOut, true);
        assert.equal(requests.length, 1);
    }, () => {});
});

test("caller cancellation after submission preserves unknown outcome", async () => {
    fixture();
    await fakeLs(async (port, requests) => {
        inject(port);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);
        try {
            const result = await callGetModelResponseDetailed("default", "cancel", 2000, controller.signal);
            assert.equal(result.kind, "cancelled");
            assert.equal(result.outcomeUnknown, true);
            assert.equal(result.safeToFallback, false);
            assert.equal(requests.length, 1);
        } finally { clearTimeout(timer); }
    }, () => {});
});

test("pre-cancelled request does not discover, launch CLI or submit", async () => {
    let operations = 0;
    __setAntigravityRuntimeForTest({ discover: async () => { operations++; return []; }, openCli: async () => { operations++; throw new Error("unexpected"); } });
    const controller = new AbortController();
    controller.abort();
    const result = await callGetModelResponseDetailed("default", "cancelled", 1000, controller.signal);
    assert.equal(result.kind, "cancelled");
    assert.equal(result.submitted, false);
    assert.equal(operations, 0);
});

test("no-App CLI LS is per request, has no CSRF header and closes exactly once", async () => {
    fixture();
    let opens = 0;
    let closes = 0;
    await fakeLs(async (port, requests) => {
        __setAntigravityRuntimeForTest({ discover: async () => [], openCli: async () => {
            opens++;
            return { info: { pid: 40002, csrfToken: "", workspaceId: "", ports: [port], transport: "cli-ls" }, port, close: async () => { closes++; } };
        } });
        const result = await callGetModelResponseDetailed("default", "cli", 2000);
        assert.equal(result.text, "CLI_LS_OK");
        assert.equal(result.transport, "cli-ls");
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(requests[0].headers["x-codeium-csrf-token"], undefined);
        assert.equal(opens, 1);
        assert.equal(closes, 1);
    }, (_request, response) => json(response, { response: "CLI_LS_OK" }));
});

test("CLI cleanup still runs after an unknown response and reports cleanup failure", async () => {
    fixture();
    let closes = 0;
    await fakeLs(async port => {
        __setAntigravityRuntimeForTest({ discover: async () => [], openCli: async () => ({
            info: { pid: 40003, csrfToken: "", workspaceId: "", ports: [port], transport: "cli-ls" }, port,
            close: async () => { closes++; throw new Error("fixture cleanup unconfirmed"); },
        }) });
        const result = await callGetModelResponseDetailed("default", "cli", 2000);
        assert.equal(result.text, null);
        assert.equal(result.partialText, "ORIGINAL_RESULT");
        assert.equal(result.cleanupConfirmed, false);
        assert.equal(result.safeToFallback, false);
        assert.match(result.error!, /cleanup unconfirmed/u);
        assert.equal(closes, 1);
    }, (_request, response) => json(response, { response: "ORIGINAL_RESULT" }));
});

test("CLI cancellation closes the owned endpoint once and preserves unknown submission", async () => {
    fixture();
    let closes = 0;
    await fakeLs(async (port, requests) => {
        __setAntigravityRuntimeForTest({ discover: async () => [], openCli: async () => ({
            info: { pid: 40005, csrfToken: "", workspaceId: "", ports: [port], transport: "cli-ls" }, port, close: async () => { closes++; },
        }) });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);
        try {
            const result = await callGetModelResponseDetailed("default", "cancel owned", 2000, controller.signal);
            assert.equal(result.kind, "cancelled");
            assert.equal(result.outcomeUnknown, true);
            assert.equal(result.cleanupConfirmed, true);
            assert.equal(requests.length, 1);
            assert.equal(closes, 1);
        } finally { clearTimeout(timer); }
    }, () => {});
});

test("unconfirmed CLI resource admission does not submit or invoke another endpoint", async () => {
    fixture();
    let opens = 0;
    __setAntigravityRuntimeForTest({ discover: async () => [], openCli: async () => {
        opens++;
        throw new AntigravityCallError("admission_timeout: physical_headroom", { transport: "cli-ls", submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" });
    } });
    const result = await callGetModelResponseDetailed("default", "not admitted", 2000);
    assert.equal(result.submitted, false);
    assert.equal(result.outcomeUnknown, false);
    assert.equal(opens, 1);
});

test("indexer quota rejection is preserved and cannot fall through to Codex", async () => {
    fixture([{ ...models[2], remaining: 0 }]);
    const previous = process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS;
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = "carbon";
    const inputPath = path.join(temporaryDirectory(), "input.txt");
    fs.writeFileSync(inputPath, "local fixture");
    try {
        await assert.rejects(buildCouncilFileIndex({ filePath: inputPath, preferredCli: "antigravity", timeoutMs: 1000 }),
            error => error instanceof AntigravityCallError && error.kind === "quota-exhausted" && !error.submitted && !error.safeToFallback);
    } finally {
        if (previous === undefined) delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS;
        else process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = previous;
    }
});

test("images are never silently discarded by the pure LS provider", async () => {
    fixture();
    const imagePath = path.join(temporaryDirectory(), "image.png");
    fs.writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    await assert.rejects(callCouncilModel({ id: "agy-images", provider: "antigravity", supportsVision: false }, "image", [imagePath], 1000), /图片|vision/iu);
    await assert.rejects(callModelBridge("antigravity", "image", 1000, { imagePaths: [imagePath] }),
        error => error instanceof AntigravityCallError && !error.submitted && !error.outcomeUnknown && !error.safeToFallback);
});

test("enabled images use the CLI agent with real readable paths, not the pure LS payload", async () => {
    fixture();
    const imagePath = path.join(temporaryDirectory(), "image.png");
    fs.writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    let calls = 0;
    __setAntigravityAgentCliRunnerForTest(async (script, _cwd, logBase) => {
        calls++;
        const match = script.match(/instructions in (.+?)\. Write the final sandbox_council response to (.+?)\. Do not print/u)!;
        assert.ok(match);
        assert.ok(fs.readFileSync(match[1], "utf8").includes(imagePath));
        fs.writeFileSync(match[2], "<<<COUNCIL_ANTIGRAVITY_CLI_RESPONSE>>>\nIMAGE_FIXTURE_OK\n<<<END_COUNCIL_ANTIGRAVITY_CLI_RESPONSE>>>");
        const stdoutPath = `${logBase}.stdout.txt`;
        const stderrPath = `${logBase}.stderr.txt`;
        fs.writeFileSync(stdoutPath, "");
        fs.writeFileSync(stderrPath, "");
        ownedFiles.push(match[1], match[2], stdoutPath, stderrPath);
        return { exitCode: 0, timedOut: false, aborted: false, stdoutPath, stderrPath, diagnostics: [] };
    });
    const result = await callCouncilModel({ id: "agy-fixture-image", provider: "antigravity", supportsVision: true }, "image", [imagePath], 1000);
    assert.equal(result.text, "IMAGE_FIXTURE_OK");
    assert.equal(result.metadata?.transport, "cli-agent");
    assert.equal(calls, 1);
});

test("read-only readiness and catalog queries never launch an absent CLI", async () => {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    let opens = 0;
    __setAntigravityRuntimeForTest({ discover: async () => [], openCli: async () => { opens++; throw new Error("unexpected CLI"); } });
    await initParentLs();
    assert.equal(await getAntigravityModelCatalog(), null);
    assert.equal(await resolveAntigravityCliModel("default"), "");
    assert.equal(opens, 0);
});

test("model bridge and council preserve actual model and stop retries after unknown acceptance", async () => {
    fixture();
    await fakeLs(async (port, requests) => {
        inject(port);
        const bridge = await callModelBridge("antigravity", "bridge", 2000, { model: "carbon" });
        assert.equal(bridge.chainUsed, "antigravity");
        assert.equal(bridge.model, models[2].model);
        assert.equal(bridge.transport, "app-ls");
        assert.equal(requests[0].body.model, models[2].model);
        const council = await callCouncilModel({ id: "agy-fixture", provider: "antigravity", model: "default" }, "council", [], 2000);
        assert.equal(council.model, models[0].model);
        assert.equal(council.metadata?.transport, "app-ls");
        const before = requests.length;
        await assert.rejects(callCouncilModel({ id: "agy-unknown", provider: "antigravity", model: "default", params: { retries: 3 } }, "reset", [], 2000),
            error => error instanceof AntigravityCallError && error.outcomeUnknown && !error.retryable);
        assert.equal(requests.length, before + 1);
    }, (request, response, incoming) => request.body.prompt === "reset" ? incoming.socket.destroy() : json(response, { response: "BRIDGE_OK" }));
});
