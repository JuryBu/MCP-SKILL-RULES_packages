import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-guard-evidence-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const guard = await import("../src/tools/stage-guard.js");
const { getBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.js");
const server = new McpServer({ name: "guard-evidence-test", version: "1" });
const client = new Client({ name: "guard-evidence-test-client", version: "1" });
const conversationId = "01900000-1111-7222-8333-444444444444";
const guardOptions = { chain: "auto" as const, dataChain: "codex" as const, modelChain: "codex" as const, conversationId, stageId: "evidence-input-fixture" };
const observed: Array<string | undefined> = [];
let releaseCheck = () => {};
let checkGate: Promise<void> | undefined;
let backgroundTaskId: string | undefined;
const responseText = (response: unknown) => JSON.stringify(response);
const taskIdFrom = (response: unknown) => responseText(response).match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];

guard.__testSetStageGuardConversationIdResolver(async identifier => identifier || null);
guard.__testSetStageGuardConversationLoader(async () => ({ chainUsed: "codex", conversationId, rounds: [], roundCount: 1, totalSteps: 2 }) as any);
guard.__testSetStageGuardCheckRunner(async (_state, _appeal, evidence, options) => {
    observed.push(evidence);
    options?.onProgress?.("model");
    await checkGate;
    return { passed: false, summary: "Synthetic evidence input inspected", missingItems: [] } as any;
});
guard.registerStageGuard(server);

try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const evidenceSchema = listed.tools.find(tool => tool.name === "stage_guard")?.inputSchema.properties?.evidence as any;
    assert.deepEqual(evidenceSchema.anyOf.map((variant: any) => variant.type), ["string", "array"]);
    assert.equal(evidenceSchema.anyOf[1].items.type, "string");

    const taskFile = path.join(fixtureRoot, "Task.md");
    fs.writeFileSync(taskFile, "# Synthetic task\n- [ ] Inspect evidence input\n", "utf8");
    const started = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "start", startRound: 1, taskFiles: [taskFile] } });
    assert.match(responseText(started), /已激活/u);
    const direct = await guard.runStageGuard({ ...guardOptions, action: "check", evidence: ["file-a.ts:10 checked", "file-b.ts:20 checked"], background: false });
    assert.match(responseText(direct), /Synthetic evidence input inspected/u);
    assert.equal(observed[0], "file-a.ts:10 checked\nfile-b.ts:20 checked");

    const fromString = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "check", evidence: "single string remains unchanged", background: false } });
    assert.match(responseText(fromString), /Synthetic evidence input inspected/u);
    assert.equal(observed[1], "single string remains unchanged");
    const invalid = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "check", evidence: ["valid string", 42] } });
    assert.equal(invalid.isError, true);
    assert.equal(observed.length, 2);

    checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
    const evidence = ["first retained line", "", "third retained line"];
    const background = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "check", evidence, background: true } });
    backgroundTaskId = taskIdFrom(background);
    assert.ok(backgroundTaskId, responseText(background));
    assert.equal((getBackgroundTask(backgroundTaskId)?.resumePayload as any).evidence, evidence.join("\n"));
    for (let attempt = 0; attempt < 100 && getBackgroundTask(backgroundTaskId)?.progress?.stage !== "guard:model"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getBackgroundTask(backgroundTaskId)?.progress?.stage, "guard:model");
    const persisted = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "tasks", `${backgroundTaskId}.json`), "utf8"));
    assert.equal(persisted.resumePayload.evidence, evidence.join("\n"));
    assert.equal(persisted.progress.stage, "guard:model");
    const equivalent = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "check", evidence: evidence.join("\n"), background: true } });
    assert.equal(taskIdFrom(equivalent), backgroundTaskId);
    releaseCheck();
    await waitForBackgroundTask(backgroundTaskId, 2);
    assert.equal(getBackgroundTask(backgroundTaskId)?.status, "done");
    assert.deepEqual(observed, ["file-a.ts:10 checked\nfile-b.ts:20 checked", "single string remains unchanged", evidence.join("\n")]);
    const polled = await client.callTool({ name: "stage_guard", arguments: { ...guardOptions, action: "check", taskId: backgroundTaskId } });
    assert.match(responseText(polled), /Synthetic evidence input inspected/u);
    assert.equal(observed.length, 3);
    console.log("PASS Stage Guard evidence: actual MCP tools/list string|string[] schema, validation, direct execution, MCP execution, newline preservation, persisted background payload, equivalent-input task deduplication and polling");
} finally {
    releaseCheck();
    if (backgroundTaskId) await waitForBackgroundTask(backgroundTaskId, 2);
    await guard.runStageGuard({ ...guardOptions, action: "cancel" });
    guard.__testSetStageGuardConversationIdResolver();
    guard.__testSetStageGuardConversationLoader();
    guard.__testSetStageGuardCheckRunner();
    await client.close();
    await server.close();
    assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
