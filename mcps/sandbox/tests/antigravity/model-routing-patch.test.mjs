import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";

const sourceRoot = new URL("../../src/", import.meta.url);
const environmentNames = ["PATH", "SANDBOX_AGY_CLI_COMMAND", "SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND", "SANDBOX_COUNCIL_GEMINI_CLI_COMMAND", "SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS", "SANDBOX_COUNCIL_GEMINI_INDEX_MODELS", "SANDBOX_AGY_CATALOG_PATH", "SANDBOX_COUNCIL_ANTIGRAVITY_CLI_MODEL_CHAIN", "SANDBOX_COUNCIL_GEMINI_CLI_MODEL_CHAIN", "SANDBOX_COUNCIL_ANTIGRAVITY_CLI_DEFAULT_FALLBACKS", "SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS", "SANDBOX_LS_MODEL", "SANDBOX_LS_MODEL_FALLBACKS"];
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
const catalogSource = stripTypeScriptTypes(fs.readFileSync(new URL("antigravity-model-catalog.ts", sourceRoot), "utf8"));
const catalogModule = await import(`data:text/javascript;base64,${Buffer.from(catalogSource).toString("base64")}`);
const { AntigravityCallError, parseAntigravityCatalog, selectAntigravityModel, antigravityCouncilCandidates, defaultAntigravityCandidates, defaultAntigravityFlashCandidates } = catalogModule;
const model = (id, label = id, extra = {}) => ({ id, label, model: `MODEL_${id.replace(/[^a-z0-9]/giu, "_").toUpperCase()}`, disabled: false, remaining: 1, ...extra });
const modernModels = [
    model("gemini-4-argon-high", "Gemini 4 Argon (High)"),
    model("gemini-4-carbon-high", "Gemini 4 Carbon (High)"),
    model("gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"),
    model("gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"),
    model("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
    model("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
    model("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
];
const catalog = entries => parseAntigravityCatalog({ models: entries });

afterEach(() => {
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

async function isolatedSource(relativePath, additions, overrides = {}) {
    const context = vm.createContext({ console, process, AbortSignal, AbortController, DOMException, setTimeout, clearTimeout, Buffer, URL });
    const moduleCache = new Map();
    const mocks = {
        fs: { default: fs }, "node:fs": { default: fs }, os: { default: os }, "node:os": { default: os },
        path: { default: path }, "node:path": { default: path }, "node:crypto": { randomUUID: () => "fixture-id" },
        "node:child_process": { spawn: () => { throw new Error("live CLI forbidden"); } },
        "node:events": { once: () => { throw new Error("live CLI forbidden"); } },
        "../antigravity-model-catalog.js": catalogModule, "./antigravity-model-catalog.js": catalogModule,
        "./types.js": { normalizeCouncilModelConfig: value => value, normalizeCouncilProvider: value => value },
        "../ls-client.js": { getAntigravityModelCatalog: async () => catalog(modernModels), resolveAntigravityCliModel: async choice => selectAntigravityModel(catalog(modernModels), choice).label, callGetModelResponseDetailed: async () => { throw new Error("live model forbidden"); } },
        "../antigravity-cli-ls.js": { resolveAntigravityLsCliCommand: preferred => preferred || "installed-agy.exe" },
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => { throw new Error("live model forbidden"); } },
        "../model-bridge.js": { callCodexText: async () => { throw new Error("live model forbidden"); } },
        "../claude-code-bridge.js": { callClaudeCodeText: async () => {}, claudeCodeOptionsFromParams: () => ({}) },
        "../grok-bridge.js": { callProgrokAPI: async () => {} },
        "./agy-runtime.js": { buildAntigravityCliEnvironment: () => ({ env: {}, diagnostics: [] }), spawnPowerShellScript: async () => {}, withAntigravityCliLease: async (_signal, action) => action() },
        "./council/agy-runtime.js": { acquireAntigravityCliLease: async () => { throw new Error("live CLI forbidden"); }, buildAntigravityCliEnvironment: () => ({ env: {} }) },
        "./windows-job-runner.js": { createWindowsJobLaunch: () => {}, readWindowsJobMetadata: () => {}, removeWindowsJobMetadata: () => {} },
        "./antigravity-discovery.js": { readAntigravityWindowsProcesses: async () => [] },
        "./paths.js": { councilRuntimeDirectory: () => { throw new Error("runtime writes forbidden"); } },
        "./artifact-store.js": { councilArtifactPath: () => {}, registerCouncilArtifact: () => {} },
        "../agent-server/providers/http.js": { FetchTransport: class {}, decodeResponse: value => value },
        "../agent-server/providers/gemini.js": { normalizeGeminiResponse: value => value },
        "../agent-server/providers/compatible-chat.js": { normalizeChatResponse: value => value },
        "../agent-server/providers/openai-responses.js": { normalizeResponsesResponse: value => value },
        "../agent-server/providers/anthropic.js": { normalizeAnthropicResponse: value => value },
        "../agent-server/providers/types.js": { ProviderFault: class extends Error {} },
        "./api-results.js": { saveCouncilApiResponse: () => {} },
        ...overrides,
    };
    const source = fs.readFileSync(new URL(relativePath, sourceRoot), "utf8");
    const loaded = new vm.SourceTextModule(stripTypeScriptTypes(`${source}\n${additions}`, { mode: "transform" }), { context });
    await loaded.link(specifier => {
        if (!Object.hasOwn(mocks, specifier)) throw new Error(`unmocked dependency: ${specifier}`);
        if (!moduleCache.has(specifier)) {
            const exports = mocks[specifier];
            moduleCache.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            }, { context }));
        }
        return moduleCache.get(specifier);
    });
    await loaded.evaluate();
    return loaded.namespace;
}

function reply(response, value, status = 200) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

async function withFixtureLs(entries, handler, action, overrides = {}) {
    delete process.env.SANDBOX_AGY_CATALOG_PATH;
    const requests = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (request.url.endsWith("/GetUserStatus")) return reply(response, { models: entries });
        requests.push(body);
        handler(body, response, request);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const port = server.address().port;
        const loaded = await isolatedSource("ls-client.ts", "", {
            "node:http": { default: http },
            "./antigravity-discovery.js": { discoverAntigravityLsCandidates: async () => { throw new Error("live discovery forbidden"); }, verifyAntigravityLsProcess: async () => false },
            "./antigravity-cli-ls.js": { openOwnedAntigravityLs: async () => { throw new Error("live CLI forbidden"); }, resolveAntigravityLsCliCommand: () => "fixture-only-agy" },
            ...overrides,
        });
        loaded.__setParentLsForTest({ port, info: { pid: 4242, ports: [port], csrfToken: "fixture", workspaceId: "", transport: "app-ls" } });
        await action(loaded, requests);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test("automatic defaults rank Hydrogen XHigh then High then Carbon High with numeric versions inside each tier", () => {
    const entries = [...modernModels, model("gemini-10-hydrogen-xhigh"), model("gemini-9-hydrogen-xhigh"), model("gemini-99-hydrogen-high"), model("gemini-99-carbon-high"), model("gemini-100-hydrogen-medium"), model("gemini-100-carbon-xhigh")];
    const expected = ["gemini-10-hydrogen-xhigh", "gemini-9-hydrogen-xhigh", "gemini-4-hydrogen-xhigh", "gemini-99-hydrogen-high", "gemini-4-hydrogen-high", "gemini-99-carbon-high", "gemini-4-carbon-high"];
    for (const ordered of [entries, [...entries].reverse()]) {
        const actual = catalog(ordered);
        for (const choice of ["", "default", "auto", "fast", "ag-fast"]) {
            assert.equal(selectAntigravityModel(actual, choice).id, expected[0]);
            assert.deepEqual(defaultAntigravityCandidates(actual, choice).map(entry => entry.id), expected);
        }
        assert.deepEqual(defaultAntigravityFlashCandidates(actual, "default"), defaultAntigravityCandidates(actual, "default"));
    }
});

test("modern automatic candidates skip unavailable entries, deduplicate enums and never fall into lower tiers or Flash", () => {
    const entries = modernModels.map(entry => entry.id.includes("hydrogen") ? { ...entry, remaining: 0 } : entry);
    entries.push({ ...modernModels[1], id: "gemini-4-carbon-copy-high" });
    const actual = catalog(entries);
    assert.equal(selectAntigravityModel(actual).model, modernModels[1].model);
    assert.deepEqual(defaultAntigravityCandidates(actual, "auto").map(entry => entry.model), [modernModels[1].model]);
    const blocked = catalog(modernModels.map(entry => /hydrogen|carbon/u.test(entry.id) ? { ...entry, disabled: true } : entry));
    assert.throws(() => defaultAntigravityCandidates(blocked, "default"), error => !error.safeToFallback && !error.submitted);
    const lowerOnly = catalog([modernModels[4], model("gemini-4-hydrogen-low"), model("gemini-4-carbon-medium")]);
    assert.throws(() => selectAntigravityModel(lowerOnly), /Hydrogen XHigh\/High/u);
});

test("old catalogs retain Flash default siblings while modern explicit aliases and exact identities stay single-model", () => {
    const flash = [model("gemini-3.8-flash-high"), model("gemini-3.8-flash-medium"), model("gemini-3.8-flash-low")];
    const old = catalog([model("gemini-3.1-pro-high"), ...flash]);
    assert.deepEqual(defaultAntigravityCandidates(old, "default").map(entry => entry.id), flash.map(entry => entry.id));
    const actual = catalog([...modernModels, ...flash.slice(1)]);
    for (const [choice, expected] of [["flash", modernModels[4]], ["gemini-flash", modernModels[4]], ["pro", modernModels[1]], ["hydrogen", modernModels[2]], ["hydrogen-xhigh", modernModels[3]]]) {
        assert.deepEqual(defaultAntigravityCandidates(actual, choice).map(entry => entry.model), [expected.model]);
    }
    for (const entry of modernModels) for (const choice of [entry.id, entry.label, entry.model]) {
        assert.deepEqual(defaultAntigravityCandidates(actual, choice).map(candidate => candidate.model), [entry.model]);
    }
    const numbered = { ...modernModels[3], model: "MODEL_PLACEHOLDER_M987" };
    for (const choice of [numbered.id, numbered.label, numbered.model, "M987"]) {
        assert.deepEqual(defaultAntigravityCandidates(catalog([numbered, ...modernModels.filter(entry => entry.id !== numbered.id)]), choice).map(entry => entry.model), [numbered.model]);
    }
    const literalDefault = model("default", "Exact default ID");
    assert.deepEqual(defaultAntigravityCandidates(catalog([...modernModels, literalDefault]), "default").map(entry => entry.model), [literalDefault.model]);
    for (const state of [{ disabled: true }, { remaining: 0 }]) {
        const entry = { ...modernModels[3], ...state };
        for (const choice of [entry.id, entry.label, entry.model]) assert.throws(() => defaultAntigravityCandidates(catalog([...modernModels.filter(candidate => candidate.id !== entry.id), entry]), choice), error => !error.safeToFallback && !error.submitted);
        assert.throws(() => defaultAntigravityCandidates(catalog([{ ...numbered, ...state }, ...modernModels.filter(candidate => candidate.id !== numbered.id)]), "M987"), error => !error.safeToFallback && !error.submitted);
    }
    assert.throws(() => selectAntigravityModel(catalog([modernModels[2]]), "hydrogen-xhigh"), /hydrogen xhigh/u);
    assert.throws(() => selectAntigravityModel(catalog([model("gemini-4-carbon-low")]), "carbon-high"), /carbon high/u);
});

test("modern complete NoCapacity rejections advance only along the high-thinking automatic chain and terminate known", async () => {
    process.env.SANDBOX_LS_MODEL_FALLBACKS = "flash,argon";
    const expected = [modernModels[3], modernModels[2], modernModels[1]].map(entry => entry.model);
    for (const succeeds of [true, false]) await withFixtureLs(modernModels, (body, response) => {
        if (succeeds && body.model === modernModels[1].model) reply(response, { response: "CARBON_OK" });
        else reply(response, { code: "unavailable", message: "No capacity available for requested model" }, 503);
    }, async (loaded, requests) => {
        const result = await loaded.callGetModelResponseDetailed("default", "fixture", 2000);
        assert.deepEqual(requests.map(request => request.model), expected);
        assert.equal(result.outcomeUnknown, false);
        assert.equal(result.safeToFallback, false);
        assert.equal(result.kind, succeeds ? "success" : "rejected");
        assert.equal(result.text, succeeds ? "CARBON_OK" : null);
    });
});

test("modern unknown, auth and quota outcomes submit once without automatic replay", async () => {
    for (const [status, message, unknown] of [[503, "upstream response lost", true], [401, "authentication required", false], [403, "unauthenticated", false], [429, "quota exhausted", false]]) {
        await withFixtureLs(modernModels, (_body, response) => reply(response, { message }, status), async (loaded, requests) => {
            const result = await loaded.callGetModelResponseDetailed("auto", "fixture", 2000);
            assert.equal(result.outcomeUnknown, unknown);
            assert.equal(result.safeToFallback, false);
            assert.equal(result.submitted, true);
            assert.equal(requests.length, 1);
        });
    }
});

test("a pre-submission transport failure preserves endpoint fallback without advancing automatic models", async () => {
    let attempts = 0;
    await withFixtureLs(modernModels, () => { throw new Error("generation must not reach fixture"); }, async (loaded, requests) => {
        const result = await loaded.callGetModelResponseDetailed("default", "not submitted", 2000);
        assert.equal(attempts, 1);
        assert.equal(requests.length, 0);
        assert.equal(result.model, modernModels[3].model);
        assert.equal(result.kind, "not-started");
        assert.equal(result.submitted, false);
        assert.equal(result.outcomeUnknown, false);
        assert.equal(result.safeToFallback, true);
    }, { "node:http": { default: { request: (options, callback) => {
        if (options.path.endsWith("/GetModelResponse")) {
            attempts += 1;
            throw new Error("fixture connection was not started");
        }
        return http.request(options, callback);
    } } } });
});

test("request model and lsModel override the frozen environment model without joining automatic fallbacks", async () => {
    process.env.SANDBOX_LS_MODEL = "flash";
    process.env.SANDBOX_LS_MODEL_FALLBACKS = "hydrogen,carbon";
    await withFixtureLs(modernModels, (body, response) => body.model === modernModels[4].model
        ? reply(response, { message: "No capacity available for explicit Flash" }, 503)
        : reply(response, { response: "EXPLICIT_OK" }), async (loaded, requests) => {
        const bridge = await isolatedSource("model-bridge.ts", "", {
            child_process: { spawn: () => { throw new Error("live spawn forbidden"); }, spawnSync: () => { throw new Error("live spawn forbidden"); } },
            "./ls-client.js": loaded,
            "./lifecycle.js": { isAntigravityLS: () => true },
            "./claude-code-bridge.js": { callClaudeCodeText: async () => { throw new Error("live model forbidden"); }, claudeCodeOptionsFromParams: () => ({}), isClaudeCodeCliAvailable: () => false },
            "./grok-bridge.js": { callProgrokAPI: async () => { throw new Error("live model forbidden"); }, DEFAULT_PROGROK_FALLBACK_MODEL: "fixture", DEFAULT_PROGROK_REASONING_EFFORT: "high", normalizeProgrokReasoningEffort: value => value },
        });
        process.env.SANDBOX_LS_MODEL = "carbon";
        await assert.rejects(bridge.callModelBridge("antigravity", "frozen environment", 2000), error => error.model === modernModels[4].model && !error.safeToFallback && !error.outcomeUnknown);
        assert.equal(requests.length, 1);
        const requested = await bridge.callModelBridge("antigravity", "request priority", 2000, { model: "hydrogen-high", lsModel: "carbon" });
        assert.equal(requested.model, modernModels[2].model);
        const alias = await bridge.callModelBridge("antigravity", "lsModel priority", 2000, { lsModel: "carbon" });
        assert.equal(alias.model, modernModels[1].model);
        assert.deepEqual(requests.map(request => request.model), [modernModels[4], modernModels[2], modernModels[1]].map(entry => entry.model));
    });
});

test("Hydrogen aliases select High and XHigh while precise IDs and enums stay exact", () => {
    const actual = catalog(modernModels);
    for (const choice of ["hydrogen", "hydrogen-high"]) assert.equal(selectAntigravityModel(actual, choice).id, "gemini-4-hydrogen-high");
    assert.equal(selectAntigravityModel(actual, "hydrogen-xhigh").id, "gemini-4-hydrogen-xhigh");
    for (const entry of modernModels) for (const choice of [entry.id, entry.label, entry.model]) assert.equal(selectAntigravityModel(actual, choice), actual.models.find(candidate => candidate.id === entry.id));
});

test("pro and strong prefer available Carbon without forbidding explicit Argon", () => {
    for (const choice of ["pro", "strong", "reasoning", "gemini-pro", "pro-high"]) assert.equal(selectAntigravityModel(catalog(modernModels), choice).id, "gemini-4-carbon-high");
    assert.equal(selectAntigravityModel(catalog(modernModels), "argon").id, "gemini-4-argon-high");
    const exhausted = modernModels.map(entry => entry.id.includes("carbon") ? { ...entry, remaining: 0 } : entry);
    assert.equal(selectAntigravityModel(catalog(exhausted), "pro").id, "gemini-4-argon-high");
    assert.throws(() => selectAntigravityModel(catalog(exhausted), "carbon"), error => error.kind === "quota-exhausted" && !error.safeToFallback);
});

test("family tokens reject substring impostors and retain old Pro Flash and Claude catalogs", () => {
    assert.throws(() => selectAntigravityModel(catalog([model("gemini-4-hydrogenated-high")]), "hydrogen"), AntigravityCallError);
    assert.throws(() => selectAntigravityModel(catalog([model("gemini-profile-high")]), "pro"), AntigravityCallError);
    const old = catalog([model("gemini-3.1-pro-high"), model("gemini-3.5-flash-high"), model("claude-sonnet-4-6-thinking"), model("claude-opus-4-6-thinking")]);
    for (const [choice, id] of [["pro", "gemini-3.1-pro-high"], ["default", "gemini-3.5-flash-high"], ["sonnet", "claude-sonnet-4-6-thinking"], ["opus", "claude-opus-4-6-thinking"]]) assert.equal(selectAntigravityModel(old, choice).id, id);
});

test("Council candidates derive only available directory entries with Argon behind preferred families", () => {
    const entries = [...modernModels, model("gemini-9-carbon-high", "disabled Carbon", { disabled: true }), model("gemini-9-hydrogen-high", "empty Hydrogen", { remaining: 0 })];
    const candidates = antigravityCouncilCandidates(catalog(entries));
    assert.equal(candidates[0].id, "gemini-4-carbon-high");
    assert.equal(candidates.at(-1).id, "gemini-4-argon-high");
    assert.ok(candidates.every(entry => entries.some(original => original.id === entry.id) && !entry.disabled && entry.remaining > 0 && !entry.id.includes("orchestrator")));
});

test("legacy default fallback ordering retains Pro High to Flash High before lower tiers", async () => {
    const oldModels = [model("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"), model("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"), model("gemini-3.5-flash-high", "Gemini 3.5 Flash (High)"), model("gemini-3.5-flash-medium", "Gemini 3.5 Flash (Medium)")];
    const loaded = await isolatedSource("council/providers.ts", "export { getDefaultFallbackConfigs };");
    const candidates = loaded.getDefaultFallbackConfigs({ id: "old", provider: "antigravityCli", model: oldModels[0].label }, catalog(oldModels));
    assert.deepEqual(Array.from(candidates, entry => entry.model), [oldModels[2].label, oldModels[3].label, oldModels[1].label]);
    assert.ok(candidates.every(entry => oldModels.some(original => original.label === entry.model)));
});

test("Council drops absent explicit fallbacks and preserves unknown acceptance after a safe first fallback", async () => {
    let calls = 0;
    const unknown = new AntigravityCallError("accepted outcome unknown", { submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "timeout-unknown" });
    const loaded = await isolatedSource("council/providers.ts", "export { getDefaultFallbackConfigs, getFallbackConfigs, isRetryableError, createAntigravityCliError };", {
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => {
            calls += 1;
            if (calls === 1) throw new AntigravityCallError("not started", { submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" });
            throw unknown;
        } },
        "./paths.js": { councilRuntimeDirectory: () => os.tmpdir() },
        fs: { default: { ...fs, mkdirSync: () => {}, writeFileSync: () => {} } },
    });
    const config = { id: "fixture", provider: "antigravityCli", model: "pro", params: { retries: 0, fallbackModels: ["removed-old-model", "hydrogen"] } };
    assert.equal(loaded.isRetryableError(unknown), false);
    assert.equal(loaded.createAntigravityCliError("timeout").safeToFallback, false);
    await assert.rejects(loaded.callCouncilModel(config, "fixture", [], 1000), error => error === unknown && !error.safeToFallback);
    assert.equal(calls, 2);
    const defaults = loaded.getDefaultFallbackConfigs({ ...config, params: {} }, catalog(modernModels));
    assert.ok(defaults.length > 0);
    assert.ok(defaults.every(entry => modernModels.some(actual => actual.label === entry.model)));
});

test("explicit same-model fallback with different parameters remains usable", async () => {
    let calls = 0;
    const stopped = new AntigravityCallError("known rejection", { submitted: true, outcomeUnknown: false, safeToFallback: false, kind: "quota-exhausted" });
    const loaded = await isolatedSource("council/providers.ts", "", {
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => {
            calls += 1;
            if (calls === 1) throw new AntigravityCallError("not started", { submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" });
            throw stopped;
        } },
        "./paths.js": { councilRuntimeDirectory: () => os.tmpdir() },
        fs: { default: { ...fs, mkdirSync: () => {}, writeFileSync: () => {} } },
    });
    const config = { id: "fixture", provider: "antigravityCli", model: "carbon", params: { retries: 0, fallbackModels: [{ model: "carbon", params: { command: "alternative.exe" } }] } };
    await assert.rejects(loaded.callCouncilModel(config, "fixture", [], 1000), error => error === stopped && !error.safeToFallback);
    assert.equal(calls, 2);
});

test("indexer skips removed candidates before launch and shares explicit command precedence", async () => {
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = "removed-model,hydrogen,hydrogen-high";
    const loaded = await isolatedSource("council/cli-indexer.ts", "export { antigravityAttempts, resolveAntigravityCommand };");
    const notes = [];
    const attempts = await loaded.antigravityAttempts("fixture.ts", notes);
    assert.deepEqual(Array.from(attempts), ["Gemini 4 Hydrogen (High)"]);
    assert.equal(notes.length, 1);
    assert.equal(loaded.resolveAntigravityCommand({ params: { command: "explicit.exe" } }), "explicit.exe");
    assert.equal(loaded.resolveAntigravityCommand({}), "installed-agy.exe");
});

test("indexer keeps exact legacy IDs ahead of legacy alias translation", async () => {
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = "gemini-3.1-pro-preview";
    const exact = model("gemini-3.1-pro-preview", "Exact Legacy Pro");
    const loaded = await isolatedSource("council/cli-indexer.ts", "export { antigravityAttempts };", {
        "../ls-client.js": { getAntigravityModelCatalog: async () => catalog([exact]), resolveAntigravityCliModel: async () => { throw new Error("unexpected second resolution"); } },
    });
    assert.deepEqual(Array.from(await loaded.antigravityAttempts("fixture.ts", [])), [exact.label]);
});

test("indexer retains explicit quota rejection instead of advancing to another model", async () => {
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = "carbon,hydrogen";
    const entries = modernModels.map(entry => entry.id.includes("carbon") ? { ...entry, remaining: 0 } : entry);
    const loaded = await isolatedSource("council/cli-indexer.ts", "export { antigravityAttempts };", {
        "../ls-client.js": { getAntigravityModelCatalog: async () => catalog(entries), resolveAntigravityCliModel: async () => { throw new Error("live model forbidden"); } },
    });
    await assert.rejects(loaded.antigravityAttempts("fixture.ts", []), error => error instanceof AntigravityCallError && error.kind === "quota-exhausted" && !error.safeToFallback);
});

test("provider passes installed command discovery and explicit command environments to the same resolver", async () => {
    const commands = [];
    const stopped = new AntigravityCallError("fixture stopped before launch", { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "not-started" });
    const loaded = await isolatedSource("council/providers.ts", "export { callAntigravityCliText };", {
        "../antigravity-cli-ls.js": { resolveAntigravityLsCliCommand: preferred => { const command = preferred || "installed-agy.exe"; commands.push(command); return command; } },
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => { throw stopped; } },
        "./paths.js": { councilRuntimeDirectory: () => os.tmpdir() },
        fs: { default: { ...fs, mkdirSync: () => {}, writeFileSync: () => {} } },
    });
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND;
    delete process.env.SANDBOX_COUNCIL_GEMINI_CLI_COMMAND;
    const config = { id: "fixture", provider: "antigravityCli", model: "hydrogen" };
    await assert.rejects(loaded.callAntigravityCliText(config, "fixture", [], 1000), error => error === stopped);
    process.env.SANDBOX_COUNCIL_GEMINI_CLI_COMMAND = "legacy-explicit.exe";
    await assert.rejects(loaded.callAntigravityCliText(config, "fixture", [], 1000), error => error === stopped);
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND = "council-explicit.exe";
    await assert.rejects(loaded.callAntigravityCliText({ ...config, params: { command: "request-explicit.exe" } }, "fixture", [], 1000), error => error === stopped);
    assert.deepEqual(commands, ["installed-agy.exe", "legacy-explicit.exe", "request-explicit.exe"]);
});

test("shared command discovery supports installed Windows exe with empty PATH and retains CLI-LS environment priority", async () => {
    const expected = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
    const loaded = await isolatedSource("antigravity-cli-ls.ts", "", {
        "node:fs": { default: { existsSync: candidate => candidate === expected } },
    });
    delete process.env.SANDBOX_AGY_CLI_COMMAND;
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND;
    process.env.PATH = "";
    assert.equal(loaded.resolveAntigravityLsCliCommand("override.exe"), "override.exe");
    if (process.platform === "win32") assert.equal(loaded.resolveAntigravityLsCliCommand(), expected);
    process.env.SANDBOX_AGY_CLI_COMMAND = "ls-explicit.exe";
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND = "council-explicit.exe";
    assert.equal(loaded.resolveAntigravityLsCliCommand(), "ls-explicit.exe");
    assert.equal(loaded.resolveAntigravityLsCliCommand(process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND), "council-explicit.exe");
});

test("explicit XHigh rejects absent disabled or exhausted tiers without silently selecting High", async () => {
    const high = modernModels.find(entry => entry.id === "gemini-4-hydrogen-high");
    const xhigh = modernModels.find(entry => entry.id === "gemini-4-hydrogen-xhigh");
    for (const entries of [[high], [high, { ...xhigh, disabled: true }], [high, { ...xhigh, remaining: 0 }]]) {
        for (const choice of ["hydrogen-xhigh", xhigh.id, xhigh.label]) assert.throws(() => selectAntigravityModel(catalog(entries), choice), error => error instanceof AntigravityCallError && !error.submitted && !error.outcomeUnknown && !error.safeToFallback);
        assert.equal(selectAntigravityModel(catalog(entries), "hydrogen").id, high.id);
    }
    assert.equal(selectAntigravityModel(catalog([xhigh]), "hydrogen-xhigh").id, xhigh.id);
    assert.throws(() => selectAntigravityModel(catalog([xhigh]), "hydrogen-high"), AntigravityCallError);
    for (const entries of [modernModels, [...modernModels].reverse()]) {
        assert.equal(selectAntigravityModel(catalog(entries), "pro").id, "gemini-4-carbon-high");
        assert.equal(selectAntigravityModel(catalog(entries), "hydrogen-xhigh").id, xhigh.id);
    }
    let launches = 0;
    const loaded = await isolatedSource("council/providers.ts", "", {
        "../ls-client.js": {
            getAntigravityModelCatalog: async () => catalog([high]),
            resolveAntigravityCliModel: async () => { launches += 1; throw new Error("unexpected resolution after rejection"); },
            callGetModelResponseDetailed: async () => { throw new Error("live model forbidden"); },
        },
    });
    await assert.rejects(loaded.callCouncilModel({ id: "missing-xhigh", provider: "antigravityCli", model: "hydrogen-xhigh", params: { retries: 0, fallbackModels: ["hydrogen-high"] } }, "fixture", [], 1000), error => error instanceof AntigravityCallError && error.kind === "rejected" && !error.submitted && !error.safeToFallback);
    assert.equal(launches, 0);
});

test("public Council default fallback executes dynamic directory branch without a catalog fixture", async () => {
    for (const name of ["SANDBOX_AGY_CATALOG_PATH", "SANDBOX_COUNCIL_ANTIGRAVITY_CLI_MODEL_CHAIN", "SANDBOX_COUNCIL_GEMINI_CLI_MODEL_CHAIN", "SANDBOX_COUNCIL_ANTIGRAVITY_CLI_DEFAULT_FALLBACKS", "SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS"]) delete process.env[name];
    const requests = [];
    let catalogReads = 0;
    let fixtureReads = 0;
    const stopped = new AntigravityCallError("accepted outcome unknown", { submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "transport-unknown" });
    const loaded = await isolatedSource("council/providers.ts", "", {
        "../antigravity-model-catalog.js": { ...catalogModule, readAntigravityCatalogFixture: () => { fixtureReads += 1; return null; } },
        "../ls-client.js": {
            getAntigravityModelCatalog: async () => { catalogReads += 1; return catalog(modernModels); },
            resolveAntigravityCliModel: async choice => { const selected = selectAntigravityModel(catalog(modernModels), choice); requests.push(selected.id); return selected.label; },
            callGetModelResponseDetailed: async () => { throw new Error("live model forbidden"); },
        },
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => {
            if (requests.length === 1) throw new AntigravityCallError("not started", { submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" });
            throw stopped;
        } },
        "./paths.js": { councilRuntimeDirectory: () => os.tmpdir() },
        fs: { default: { ...fs, mkdirSync: () => {}, writeFileSync: () => {} } },
    });
    await assert.rejects(loaded.callCouncilModel({ id: "dynamic", provider: "antigravityCli", model: "default", params: { retries: 0 } }, "fixture", [], 1000), error => error === stopped);
    assert.deepEqual(requests, ["gemini-4-hydrogen-xhigh", "gemini-4-carbon-high"]);
    assert.equal(catalogReads, 1);
    assert.equal(fixtureReads, 0);
});

test("default fallback switches and model chains retain new environment priority over legacy variables", async () => {
    const config = { id: "switch", provider: "antigravityCli", model: "default" };
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_MODEL_CHAIN;
    delete process.env.SANDBOX_COUNCIL_GEMINI_CLI_MODEL_CHAIN;
    for (const [current, legacy, enabled] of [["0", "1", false], ["1", "0", true], [undefined, "0", false]]) {
        if (current === undefined) delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_DEFAULT_FALLBACKS;
        else process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_DEFAULT_FALLBACKS = current;
        process.env.SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS = legacy;
        const loaded = await isolatedSource("council/providers.ts", "export { getDefaultFallbackConfigs };");
        assert.equal(loaded.getDefaultFallbackConfigs(config, catalog(modernModels)).length > 0, enabled);
    }
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_DEFAULT_FALLBACKS = "1";
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_MODEL_CHAIN = "hydrogen";
    process.env.SANDBOX_COUNCIL_GEMINI_CLI_MODEL_CHAIN = "argon";
    const loaded = await isolatedSource("council/providers.ts", "export { getDefaultFallbackConfigs };");
    assert.deepEqual(Array.from(loaded.getDefaultFallbackConfigs(config, catalog(modernModels)), entry => entry.model), ["hydrogen"]);
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_MODEL_CHAIN;
    assert.deepEqual(Array.from(loaded.getDefaultFallbackConfigs(config, catalog(modernModels)), entry => entry.model), ["argon"]);
});

test("provider and indexer preserve conflicting command priorities quoting and missing-install fallback", async () => {
    const installed = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
    const shared = await isolatedSource("antigravity-cli-ls.ts", "", { "node:fs": { default: { existsSync: candidate => candidate === installed } } });
    const commands = [];
    const stopped = new AntigravityCallError("fixture stopped", { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "not-started" });
    const provider = await isolatedSource("council/providers.ts", "export { callAntigravityCliText, buildAntigravityCliScript };", {
        "../antigravity-cli-ls.js": { resolveAntigravityLsCliCommand: preferred => { const command = shared.resolveAntigravityLsCliCommand(preferred); commands.push(command); return command; } },
        "../antigravity-agent-cli.js": { runAntigravityAgentCli: async () => { throw stopped; } },
        "./paths.js": { councilRuntimeDirectory: () => os.tmpdir() },
        fs: { default: { ...fs, mkdirSync: () => {}, writeFileSync: () => {} } },
    });
    const indexer = await isolatedSource("council/cli-indexer.ts", "export { resolveAntigravityCommand, buildAntigravityScript };", { "../antigravity-cli-ls.js": { resolveAntigravityLsCliCommand: shared.resolveAntigravityLsCliCommand } });
    process.env.SANDBOX_AGY_CLI_COMMAND = "generic.exe";
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND = "current.exe";
    process.env.SANDBOX_COUNCIL_GEMINI_CLI_COMMAND = "legacy.exe";
    const config = { id: "priority", provider: "antigravityCli", model: "hydrogen" };
    for (const [params, expected] of [[{ command: "request.exe", cli: "alias.exe" }, "request.exe"], [{ cli: "alias.exe" }, "alias.exe"], [{}, "current.exe"]]) {
        await assert.rejects(provider.callAntigravityCliText({ ...config, params }, "fixture", [], 1000), error => error === stopped);
        assert.equal(commands.at(-1), expected);
        assert.equal(indexer.resolveAntigravityCommand({ params }), expected);
    }
    assert.equal(shared.resolveAntigravityLsCliCommand(), "generic.exe");
    for (const [removed, expected] of [["SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND", "legacy.exe"], ["SANDBOX_COUNCIL_GEMINI_CLI_COMMAND", "generic.exe"], ["SANDBOX_AGY_CLI_COMMAND", process.platform === "win32" ? installed : "agy"]]) {
        delete process.env[removed];
        await assert.rejects(provider.callAntigravityCliText(config, "fixture", [], 1000), error => error === stopped);
        assert.equal(commands.at(-1), expected);
        assert.equal(indexer.resolveAntigravityCommand({}), expected);
    }
    const absent = await isolatedSource("antigravity-cli-ls.ts", "", { "node:fs": { default: { existsSync: () => false } } });
    assert.equal(absent.resolveAntigravityLsCliCommand(), process.platform === "win32" ? "agy.exe" : "agy");
    const quoted = "C:\\Program Files\\Owner's AGY\\agy.exe";
    const escaped = "'C:\\Program Files\\Owner''s AGY\\agy.exe'";
    assert.ok(provider.buildAntigravityCliScript("prompt.txt", "result.md", "Hydrogen", quoted, []).includes(`& ${escaped} -p`));
    assert.ok(indexer.buildAntigravityScript("prompt.txt", "result.md", "Hydrogen", quoted, []).includes(`& ${escaped} -p`));
});

test("pro family priority precedes newer Argon and Pro versions while each family sorts internally", () => {
    const entries = [model("gemini-99-argon-high"), model("gemini-99-pro-high"), model("gemini-4-carbon-high"), model("gemini-5-carbon-high")];
    for (const ordered of [entries, [...entries].reverse()]) {
        for (const choice of ["pro", "strong"]) assert.equal(selectAntigravityModel(catalog(ordered), choice).id, "gemini-5-carbon-high");
        assert.equal(selectAntigravityModel(catalog(ordered), "argon").id, "gemini-99-argon-high");
        const exhausted = ordered.map(entry => entry.id === "gemini-5-carbon-high" ? { ...entry, remaining: 0 } : entry);
        assert.equal(selectAntigravityModel(catalog(exhausted), "pro").id, "gemini-4-carbon-high");
    }
});

test("indexer default chain starts with default then deduplicated available directory candidates and honors explicit environment chains", async () => {
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS;
    delete process.env.SANDBOX_COUNCIL_GEMINI_INDEX_MODELS;
    const duplicate = { ...modernModels[1], id: "gemini-4-carbon-alias-high", label: "Carbon duplicate enum" };
    const entries = [...modernModels, duplicate, model("gemini-9-carbon-high", "disabled", { disabled: true })];
    const loaded = await isolatedSource("council/cli-indexer.ts", "export { antigravityAttempts };", {
        "../ls-client.js": { getAntigravityModelCatalog: async () => catalog(entries), resolveAntigravityCliModel: async () => { throw new Error("unexpected secondary catalog lookup"); } },
    });
    const notes = [];
    const attempts = Array.from(await loaded.antigravityAttempts("fixture.ts", notes));
    assert.equal(attempts[0], "Gemini 4 Hydrogen (XHigh)");
    assert.ok(attempts.includes("Gemini 4 Carbon (High)"));
    assert.ok(attempts.includes("Gemini 4 Hydrogen (High)"));
    const selected = attempts.map(choice => selectAntigravityModel(catalog(entries), choice));
    assert.equal(new Set(selected.map(entry => entry.model)).size, selected.length);
    assert.ok(selected.every(entry => !entry.disabled && entry.remaining > 0 && !entry.id.includes("orchestrator")));
    process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS = "hydrogen";
    process.env.SANDBOX_COUNCIL_GEMINI_INDEX_MODELS = "argon";
    assert.deepEqual(Array.from(await loaded.antigravityAttempts("fixture.ts", [])), ["Gemini 4 Hydrogen (High)"]);
    delete process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS;
    assert.deepEqual(Array.from(await loaded.antigravityAttempts("fixture.ts", [])), ["Gemini 4 Argon (High)"]);
});
