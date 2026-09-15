import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-legacy-isolation-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "corrupt.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "absent-jobs.json");
fs.writeFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH, "not sqlite");
const windsurf = await import("../src/windsurf-client.js");
const local = await import("../src/windsurf-local-store.js");
let oldCalls = 0;
windsurf.__setWindsurfEndpointResolverForTest(async () => [{ pid: 1, port: 1, csrfToken: "synthetic" }]);
windsurf.__setWindsurfTransportFactoryForTest(() => async method => {
    oldCalls++;
    if (method === "GetAllCascadeTrajectories") return { trajectorySummaries: { "legacy-cascade": { summary: "Legacy fixture", stepCount: 1 } } };
    return { steps: [] };
});
local.__setWindsurfCascadeDirForTest(root);
try {
    assert.equal(await windsurf.resolveWindsurfThreadId("legacy-cascade"), "legacy-cascade");
    assert.ok(oldCalls > 0);
    const { scanWindsurfConsumerSourceEvidence } = await import("../src/devin-source-evidence.js");
    const evidence = await scanWindsurfConsumerSourceEvidence("legacy-cascade", {
        transport: async (method, payload) => {
            if (method === "GetAllCascadeTrajectories") return { trajectorySummaries: { "legacy-cascade": { summary: "Legacy fixture", stepCount: 2, lastModifiedTime: "2026-01-01T00:00:00Z" } } };
            if (method === "GetCascadeTrajectorySteps") return { steps: Number(payload?.stepOffset) === 0 ? [
                { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "Legacy user" } },
                { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "Legacy answer" } },
            ] : [] };
            throw new Error(`unexpected method ${method}`);
        },
    });
    assert.equal(evidence.classification.state, "Present");
    const list = await windsurf.listRecentWindsurfThreads(10);
    assert.equal(list[0].id, "legacy-cascade");
    assert.match(list[0].discoveryWarnings!.join(" "), /DEVIN_DISCOVERY_UNAVAILABLE/);
    await assert.rejects(() => windsurf.resolveWindsurfThreadId("unknown-conversation"), /SQLite/);
    const beforeLocal = oldCalls;
    fs.writeFileSync(path.join(root, "legacy-local.pb"), "synthetic");
    assert.equal(await windsurf.withLegacyWindsurfFallback("legacy-local", async () => { throw new Error("SQLite failed"); }, { source: "local" }), null);
    assert.equal(oldCalls, beforeLocal);
    await assert.rejects(() => windsurf.withLegacyWindsurfFallback("legacy-local", async () => { throw new Error("alias ambiguous"); }), /ambiguous/);
    await assert.rejects(() => windsurf.withLegacyWindsurfFallback("legacy-local", async () => { throw new Error("reading cancelled"); }), /cancelled/);
    await assert.rejects(() => windsurf.withLegacyWindsurfFallback("legacy-cascade", async () => { throw new Error("SQLite failed"); }, { source: "local" }), /SQLite/);

    const file = new URL("../src/guard-engine.ts", import.meta.url);
    const source = fs.readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "getConversationExecutionRecord");
    assert.ok(declaration);
    const compiled = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const execute = new Function("loadConversationData", "assertConversationConsumerSourceComplete", `${compiled}; return getConversationExecutionRecord("fixture-falcon", 1, 40000, "windsurf");`);
    await assert.rejects(() => execute(async () => null, () => {}), /missing WSF/);
    for (const failure of ["partial", "stale", "source unavailable"]) {
        await assert.rejects(() => execute(async () => ({ chainUsed: "windsurf" }), () => { throw new Error(failure); }), new RegExp(failure));
    }
    console.log("PASS devin-legacy-isolation: corrupt database isolation, exact legacy identity, local-only boundaries and Guard second-read rejection");
} finally {
    windsurf.__setWindsurfEndpointResolverForTest(null);
    windsurf.__setWindsurfTransportFactoryForTest(null);
    local.__setWindsurfCascadeDirForTest(null);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
