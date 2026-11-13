import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RecordSchedulerDiscoveryBuildResult } from "../src/record-scheduler-runtime.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-catalog-1281-"));
const gui = path.join(root, "gui");
const workspace = path.join(root, "workspace");
const otherWorkspace = path.join(root, "other");
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.APPDATA = path.join(root, "appdata");
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_ANTIGRAVITY_ROOT = gui;
process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT = path.join(root, "cli");
process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = path.join(gui, "conversations");
process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = path.join(gui, "implicit");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
for (const directory of [gui, process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT, process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT, process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT]) fs.mkdirSync(directory, { recursive: true });

try {
    const registry = await import("../src/ls-registry.js");
    const ls = await import("../src/ls-client.js");
    registry.__setRegistryPathForTest(path.join(root, "registry.json"));
    ls.__disableLsForTest();
    ls.__setConvCacheDirForTest(path.join(root, "ls-cache"));
    const runtimeModule = await import("../src/record-scheduler-runtime.js");
    const discovery = await import("../src/record-discovery.js");
    const { workspaceHash } = await import("../src/store.js");
    const { canonicalizeSourceWorkspaceIdentity } = await import("../src/source-evidence-contracts.js");
    const { __recordConcurrencyTest, resolveBatchCandidateWorkspace } = await import("../src/tools/record.js");
    const request = { kind: "stale_check" as const, selector: "stale_only" as const, workspaceHash: workspaceHash(workspace), workspacePath: workspace, hosts: ["antigravity" as const], limit: 20 };
    const entries = [
        { id: "async-own", mtime: new Date(), sizeKB: 1, workspace },
        { id: "async-other", mtime: new Date(), sizeKB: 1, workspace: otherWorkspace },
        { id: "async-alias", mtime: new Date(), sizeKB: 1, workspace: otherWorkspace, workspaces: [workspace] },
    ];
    const asyncAdapter = runtimeModule.createProductionRecordSchedulerSourceEvidenceAdapter({ listAntigravityConversations: async () => entries });
    const asyncResult = await asyncAdapter.buildDiscoveryInput(request) as RecordSchedulerDiscoveryBuildResult;
    assert.deepEqual(asyncResult.input.sourceEnumerations.map(item => item.evidence.identity.conversationId).sort(), ["async-alias", "async-own"]);
    const canonicalWorkspace = canonicalizeSourceWorkspaceIdentity({ workspaceId: request.workspaceHash, canonicalPath: workspace }).canonicalPath;
    assert.ok(asyncResult.input.sourceEnumerations.every(item => item.evidence.identity.workspace.canonicalPath === canonicalWorkspace));
    assert.equal(asyncResult.enumerations[0].complete, true);
    const syncAdapter = runtimeModule.createProductionRecordSchedulerSourceEvidenceAdapter({ listAntigravityConversations: () => [{ id: "legacy-sync", mtime: new Date(), sizeKB: 1 }] });
    const syncResult = await syncAdapter.buildDiscoveryInput({ ...request, workspacePath: null }) as RecordSchedulerDiscoveryBuildResult;
    assert.equal(syncResult.input.sourceEnumerations[0].evidence.identity.conversationId, "legacy-sync");
    assert.equal(syncResult.input.sourceEnumerations[0].evidence.identity.workspace.canonicalPath, null);
    const failedAdapter = runtimeModule.createProductionRecordSchedulerSourceEvidenceAdapter({ listAntigravityConversations: async () => { throw new Error("catalog unavailable"); } });
    const failed = await failedAdapter.buildDiscoveryInput(request) as RecordSchedulerDiscoveryBuildResult;
    assert.equal(failed.enumerations[0].complete, false);
    assert.match(failed.enumerations[0].error!, /catalog unavailable/u);
    assert.equal(resolveBatchCandidateWorkspace({ workspace }, "antigravity", workspace), workspace);
    assert.equal(resolveBatchCandidateWorkspace({ workspace: otherWorkspace }, "antigravity", workspace), null);
    console.log("record-catalog-1281: async/sync API, real workspace filtering, alias matching and failed enumeration PASS");

    const database = new DatabaseSync(path.join(gui, "conversation_summaries.db"));
    try {
        database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,step_count INTEGER,last_modified_time TEXT,parent_conversation_id TEXT,agent_name TEXT,nesting_depth INTEGER)");
        const insert = database.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)");
        for (const [identifier, sourceWorkspace] of [["modern-own", workspace], ["modern-other", otherWorkspace], ["metadata-only", workspace]]) {
            insert.run(identifier, identifier, JSON.stringify([pathToFileURL(sourceWorkspace).href]), 2, "2026-11-13T00:00:00Z", "", "", 0);
            if (identifier === "metadata-only") continue;
            const logs = path.join(gui, "brain", identifier, ".system_generated", "logs");
            fs.mkdirSync(logs, { recursive: true });
            fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), [
                { step_index: 0, type: "USER_INPUT", content: "record directory fixture" },
                { step_index: 1, type: "PLANNER_RESPONSE", content: "answer" },
            ].map(row => JSON.stringify(row)).join("\n") + "\n");
        }
    } finally { database.close(); }
    const listed = await discovery.listAntigravityRecordConversations({ limit: 100 });
    assert.equal(listed.partial, false, `metadata-only body availability must not make the directory incomplete: ${JSON.stringify({ diagnostics: listed.diagnostics, warnings: listed.warnings })}`);
    assert.equal(listed.conversations.length, 3);
    const batch = await __recordConcurrencyTest.collectBatchCandidates("antigravity", { workspace, limit: 10 }, workspaceHash(workspace));
    assert.deepEqual(batch.candidates.map(candidate => candidate.id).sort(), ["metadata-only", "modern-own"]);
    assert.ok(batch.candidates.every(candidate => workspaceHash(candidate.workspace) === workspaceHash(workspace)));
    assert.equal(batch.diagnostics?.workspaceUnresolved, 0);
    const defaultAdapter = runtimeModule.createProductionRecordSchedulerSourceEvidenceAdapter();
    const defaultResult = await defaultAdapter.buildDiscoveryInput(request) as RecordSchedulerDiscoveryBuildResult;
    assert.equal(defaultResult.enumerations[0].complete, true, JSON.stringify(defaultResult.enumerations));
    assert.deepEqual(defaultResult.input.sourceEnumerations.map(item => item.evidence.identity.conversationId).sort(), ["metadata-only", "modern-own"]);
    const runtime = runtimeModule.createRecordSchedulerRuntime({ productionSourceApis: { listAntigravityConversations: async () => entries } });
    const snapshot = await runtime.discover(request);
    assert.deepEqual(snapshot.sourceEnumerations.map(item => item.evidence.identity.conversationId).sort(), ["async-alias", "async-own"]);
    console.log("record-catalog-1281: default modern catalog to batch and schedulerRuntime.discover PASS; metadata-only directory remains complete; no LS workspace fallback");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
