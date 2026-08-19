import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const conversationId = "scheduler-production-tools-e2e";
const deferredBatchConversationId = "scheduler-production-batch-deferred-a";
const secondBatchConversationId = "scheduler-production-batch-second-b";
const failureConversationId = "scheduler-production-failed-final";
const cancellationConversationId = "scheduler-production-cancel-deferred-c";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-production-tools-workspace-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-production-tools-"));
const home = path.join(root, "home");
const codexHome = path.join(home, ".codex");
const sessions = path.join(codexHome, "sessions");
const dataRoot = path.join(root, "data");
const envKeys = [
    "HOME",
    "USERPROFILE",
    "MEMORY_STORE_DATA_ROOT",
    "MEMORY_STORE_GROK_PROXY_URL",
    "MEMORY_STORE_GROK_API_KEY",
    "MEMORY_STORE_RECORD_BATCH_CONCURRENCY",
] as const;
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

function writeJsonl(filePath: string, rows: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function writeCodexFixture(): void {
    const fixtures = [
        { id: conversationId, title: "production tools e2e" },
        { id: deferredBatchConversationId, title: "deferred batch provider fixture" },
        { id: secondBatchConversationId, title: "second batch provider fixture" },
    ];
    const threadEntries = fixtures.map(fixture => {
        const rolloutPath = path.join(sessions, `rollout-2026-07-14T00-00-00-${fixture.id}.jsonl`);
        writeJsonl(rolloutPath, [
            { type: "session_meta", payload: { id: fixture.id, cwd: workspace, title: fixture.title, source: "codex", model: "gpt-test", reasoning_effort: "high" } },
            ...[1, 2, 3, 4].flatMap(round => [
                { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${fixture.id} user-${round}` }] } },
                { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${fixture.id} assistant-${round}` }] } },
            ]),
        ]);
        return { ...fixture, rolloutPath };
    });
    const script = `
import json, sqlite3, sys
db, entries_json, cwd = sys.argv[1:]
conn = sqlite3.connect(db)
conn.execute("create table threads (id text primary key, rollout_path text, cwd text, title text, source text, model text, reasoning_effort text, agent_nickname text, agent_role text, updated_at_ms integer, updated_at text, archived integer default 0)")
conn.execute("create table thread_spawn_edges (child_thread_id text, parent_thread_id text, status text)")
for entry in json.loads(entries_json):
    conn.execute("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (entry["id"], entry["rolloutPath"], cwd, entry["title"], "codex", "gpt-test", "high", None, None, 1784000000000, "2026-07-14T00:00:00.000Z", 0))
conn.commit()
`;
    execFileSync("python", ["-c", script, path.join(codexHome, "state_5.sqlite"), JSON.stringify(threadEntries), workspace], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: "inherit",
    });
}

function writeCancellationCodexFixture(): void {
    const fixture = { id: cancellationConversationId, title: "cancelled in-flight provider fixture" };
    const rolloutPath = path.join(sessions, `rollout-2026-07-14T00-00-00-${fixture.id}.jsonl`);
    writeJsonl(rolloutPath, [
        { type: "session_meta", payload: { id: fixture.id, cwd: workspace, title: fixture.title, source: "codex", model: "gpt-test", reasoning_effort: "high" } },
        ...[1, 2, 3, 4].flatMap(round => [
            { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${fixture.id} user-${round}` }] } },
            { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${fixture.id} assistant-${round}` }] } },
        ]),
    ]);
    const script = `
import sqlite3, sys
db, conversation_id, rollout_path, cwd = sys.argv[1:]
conn = sqlite3.connect(db)
conn.execute("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (conversation_id, rollout_path, cwd, "cancelled in-flight provider fixture", "codex", "gpt-test", "high", None, None, 1784000000000, "2026-07-14T00:00:00.000Z", 0))
conn.commit()
`;
    execFileSync("python", ["-c", script, path.join(codexHome, "state_5.sqlite"), fixture.id, rolloutPath, workspace], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: "inherit",
    });
}

function writeFailureCodexFixture(): void {
    const rolloutPath = path.join(sessions, `rollout-2026-07-14T00-00-00-${failureConversationId}.jsonl`);
    writeJsonl(rolloutPath, [
        { type: "session_meta", payload: { id: failureConversationId, cwd: workspace, title: "failed final provider fixture", source: "codex", model: "gpt-test", reasoning_effort: "high" } },
        ...[1, 2, 3, 4].flatMap(round => [
            { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${failureConversationId} user-${round}` }] } },
            { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${failureConversationId} assistant-${round}` }] } },
        ]),
    ]);
    const script = `
import sqlite3, sys
db, conversation_id, rollout_path, cwd = sys.argv[1:]
conn = sqlite3.connect(db)
conn.execute("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (conversation_id, rollout_path, cwd, "failed final provider fixture", "codex", "gpt-test", "high", None, None, 1784000000000, "2026-07-14T00:00:00.000Z", 0))
conn.commit()
`;
    execFileSync("python", ["-c", script, path.join(codexHome, "state_5.sqlite"), failureConversationId, rolloutPath, workspace], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: "inherit",
    });
}

function appendStaleRound(conversation: string): number {
    const rolloutPath = path.join(sessions, `rollout-2026-07-14T00-00-00-${conversation}.jsonl`);
    const marker = `stale-refresh-${conversation}`;
    fs.appendFileSync(rolloutPath, [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${marker}-assistant` }] } }),
        "",
    ].join("\n"), "utf8");
    return Math.floor(fs.statSync(rolloutPath).mtimeMs);
}

function textOf(response: { content?: Array<{ text?: string }> }): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

function taskIdOf(response: { content?: Array<{ text?: string }> }): string {
    const match = textOf(response).match(/taskId:\s*(\S+)/u);
    assert.ok(match, `scheduler admission should expose taskId: ${textOf(response)}`);
    return match[1];
}

async function waitForTask(
    taskId: string,
    getBackgroundTask: (id: string) => { status: string; error?: string; result?: string } | undefined,
    expectedStatus = "done",
): Promise<{ status: string; error?: string; result?: string }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const task = getBackgroundTask(taskId);
        if (!task) {
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
        }
        if (task.status !== "running") {
            assert.equal(task.status, expectedStatus, `scheduler task should settle as ${expectedStatus}: ${task.error || "unknown error"}`);
            return task;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`scheduler task ${taskId} did not settle`);
}

async function waitForSignal(signal: Promise<void>, label: string): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            signal,
            new Promise<void>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function finalRecordFor(targetConversationId: string, totalRounds = 4): string {
    return [
        `# Record: ${targetConversationId}`,
        "",
        `- 对话ID：${targetConversationId}`,
        `- 总轮次：${totalRounds}`,
        `- 总步骤：${totalRounds * 2}`,
        "",
        `## Phase 1：真实 scheduler 工具路径（轮次 1-${totalRounds})`,
        "",
        "- 通过 production session 调用 provider",
        "- 只允许 local-finalize 提交 Verified",
        "",
        "## 验证结果",
        "",
        "- scheduler managed 路径未走旧 direct write/index gate",
    ].join("\n");
}
const patchRecord = [
    "```json",
    JSON.stringify({ startRound: 1, endRound: 4, title: "tools e2e", files: ["tests/record-scheduler-production-tools-e2e.test.ts"], tags: ["scheduler"], risks: [], status: "ok" }),
    "```",
    "",
    "## Phase Draft",
    "",
    "- production scheduler patch",
].join("\n");

let modelRequests = 0;
let deferBatchA = false;
let deferredBatchProviderConversation: string | null = null;
let releaseDeferredBatchA: (() => void) | null = null;
let resolveDeferredBatchAStarted: (() => void) | null = null;
let resolveSecondBatchRequest: (() => void) | null = null;
let deferCancellationProvider = false;
let releaseCancellationProvider: (() => void) | null = null;
let resolveCancellationProviderStarted: (() => void) | null = null;
let resolveCancellationProviderResponseSent: (() => void) | null = null;
const deferredBatchAStarted = new Promise<void>(resolve => { resolveDeferredBatchAStarted = resolve; });
const secondBatchRequestReached = new Promise<void>(resolve => { resolveSecondBatchRequest = resolve; });
const cancellationProviderStarted = new Promise<void>(resolve => { resolveCancellationProviderStarted = resolve; });
const cancellationProviderResponseSent = new Promise<void>(resolve => { resolveCancellationProviderResponseSent = resolve; });
const server = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "grok-4.5" }] }));
        return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", part => { body += part; });
    request.on("end", () => {
        modelRequests++;
        const targetConversationId = body.includes(cancellationConversationId)
            ? cancellationConversationId
            : body.includes(failureConversationId)
                ? failureConversationId
            : body.includes(deferredBatchConversationId)
            ? deferredBatchConversationId
            : body.includes(secondBatchConversationId)
                ? secondBatchConversationId
                : conversationId;
        const respond = () => {
            if (targetConversationId === failureConversationId) {
                response.writeHead(503, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "forced production provider failure" } }));
                return;
            }
            const content = body.includes("RecordPatch")
                ? patchRecord
                : finalRecordFor(targetConversationId, body.includes("stale-refresh-") ? 5 : 4);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
            if (targetConversationId === cancellationConversationId) resolveCancellationProviderResponseSent?.();
        };
        if (deferCancellationProvider && targetConversationId === cancellationConversationId && !releaseCancellationProvider) {
            resolveCancellationProviderStarted?.();
            releaseCancellationProvider = respond;
            return;
        }
        const isBatchPressureCandidate = targetConversationId === deferredBatchConversationId
            || targetConversationId === secondBatchConversationId;
        if (deferBatchA && isBatchPressureCandidate && !releaseDeferredBatchA) {
            deferredBatchProviderConversation = targetConversationId;
            resolveDeferredBatchAStarted?.();
            releaseDeferredBatchA = respond;
            return;
        }
        if (deferBatchA && isBatchPressureCandidate && targetConversationId !== deferredBatchProviderConversation) {
            resolveSecondBatchRequest?.();
        }
        respond();
    });
});

await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
});

let resetRecordTestHooks = () => undefined;
let resetProviderAdapter = async () => undefined;

try {
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
    process.env.MEMORY_STORE_GROK_API_KEY = "production-tools-e2e";
    process.env.MEMORY_STORE_RECORD_BATCH_CONCURRENCY = "1";
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address.port}`;
    writeCodexFixture();
    const {
        registerRecord,
        __recordConcurrencyTest,
        effectiveRecordBatchLimit,
        recordBatchDiscoveryScanLimit,
    } = await import("../src/tools/record.ts");
    const { getBackgroundTask } = await import("../src/background-tasks.ts");
    const { configureProviderTransportAdapterForTest, getProviderTransportAdapter, resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
    const { readRecordAsync, readRecordsIndexAsync, resolveWorkspaceHashForRecord } = await import("../src/record-store.ts");
    const { readRecordSchedulerLedgerStore } = await import("../src/record-scheduler-store.ts");
    const { formatRoundsForRecord } = await import("../src/record-generator.ts");
    const evidence = await import("../src/source-evidence-contracts.ts");
    resetRecordTestHooks = () => {
        __recordConcurrencyTest.setUnknownChainMigrationProductionSourceReader(null);
        __recordConcurrencyTest.setPersistenceHook(null);
    };
    resetProviderAdapter = resetProviderTransportAdapterForTest;

    await configureProviderTransportAdapterForTest({ mode: "test", dataRoot, ownerId: "production-tools-e2e" });
    type Handler = (args: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;
    let handler: Handler | null = null;
    registerRecord({ tool(name: string, _description: string, _schema: unknown, implementation: Handler) { if (name === "record_manage") handler = implementation; } } as never);
    assert.ok(handler, "record_manage handler should register");
    assert.equal(effectiveRecordBatchLimit(undefined, false), 10, "normal batches default to a materialization limit of 10");
    assert.equal(effectiveRecordBatchLimit(37, false), 37, "explicit normal limits must be preserved below the normal cap");
    assert.equal(effectiveRecordBatchLimit(200, false), 50, "normal batches must cap materialization at 50");
    assert.equal(effectiveRecordBatchLimit(undefined, true), 200, "force batches default to the force cap");
    assert.equal(effectiveRecordBatchLimit(250, true), 200, "force batches must cap materialization at 200");
    assert.equal(recordBatchDiscoveryScanLimit(false), 50, "normal discovery must scan the classification range instead of the selected range");
    assert.equal(recordBatchDiscoveryScanLimit(true), 200, "force discovery must retain the larger classification range");

    const persistenceHookEvents: Array<{ stage: string; persistencePath: "legacy" | "scheduler" }> = [];
    __recordConcurrencyTest.setPersistenceHook(event => {
        persistenceHookEvents.push({ stage: event.stage, persistencePath: event.persistencePath });
    });
    const updateTaskId = taskIdOf(await handler({ action: "update", conversationId, workspace, dataChain: "codex", modelChain: "grok" }));
    const updateTask = await waitForTask(updateTaskId, getBackgroundTask);
    const workspaceHash = resolveWorkspaceHashForRecord(workspace);
    const schedulerLedger = await readRecordSchedulerLedgerStore(updateTaskId, { expectPublished: true });
    const schedulerDetail = schedulerLedger.kind === "current"
        ? JSON.stringify({
            state: schedulerLedger.ledger.task.state,
            repairState: schedulerLedger.ledger.task.repairState,
            candidates: schedulerLedger.ledger.candidateSnapshot.candidates,
            sourceMaterialization: schedulerLedger.ledger.sourceMaterialization,
            sources: schedulerLedger.ledger.sourceSnapshots,
            units: schedulerLedger.ledger.units,
        })
        : JSON.stringify(schedulerLedger);
    assert.match(
        await readRecordAsync(workspaceHash, conversationId) || "",
        /真实 scheduler 工具路径/u,
        `scheduler task settled without publishing the expected Record: ${updateTask.result || updateTask.error || "no task detail"}; ${schedulerDetail}`,
    );
    assert.equal(schedulerLedger.kind, "current", "update must persist a scheduler ledger");
    if (schedulerLedger.kind === "current") {
        assert.ok(schedulerLedger.ledger.units.some(unit => unit.state === "Succeeded"), "local-finalize should settle a persistent Unit");
        assert.ok(schedulerLedger.ledger.attempts.some(attempt => attempt.provider === "local" && attempt.state === "KnownSuccess"), "local-finalize Attempt should be KnownSuccess");
        assert.ok(schedulerLedger.ledger.attempts.some(attempt => attempt.provider !== "local"), "provider model call should have a durable Attempt");
    }
    assert.deepEqual(
        persistenceHookEvents.filter(event => event.persistencePath === "legacy"),
        [],
        "scheduler-managed update must not enter legacy direct write/index hook",
    );
    assert.deepEqual(
        persistenceHookEvents.filter(event => event.persistencePath === "scheduler").map(event => event.stage),
        ["before_write", "before_reader_index"],
        "scheduler-managed update must expose both protocol persistence fault points",
    );
    assert.ok(getProviderTransportAdapter().diagnostics().acquireCount > 0, "model request must consume a provider permit");

    const requestsBeforeUpToDate = modelRequests;
    const upToDateTaskId = taskIdOf(await handler({ action: "update", conversationId, workspace, dataChain: "codex", modelChain: "grok" }));
    await waitForTask(upToDateTaskId, getBackgroundTask);
    assert.equal(modelRequests, requestsBeforeUpToDate, "up-to-date path must local-finalize without a model request");
    const upToDateLedger = await readRecordSchedulerLedgerStore(upToDateTaskId, { expectPublished: true });
    assert.equal(upToDateLedger.kind, "current");
    if (upToDateLedger.kind === "current") {
        assert.equal(upToDateLedger.ledger.task.state, "Succeeded", "complete zero-selection discovery must persist a successful no-op");
        assert.equal(upToDateLedger.ledger.task.recordItems.total, 0);
        assert.equal(upToDateLedger.ledger.units.length, 0);
        assert.equal(upToDateLedger.ledger.attempts.length, 0);
        assert.equal(upToDateLedger.ledger.commits.length, 0);
    }

    deferBatchA = true;
    const batchTaskId = taskIdOf(await handler({
        action: "batch_update",
        workspace,
        dataChain: "codex",
        modelChain: "grok",
        limit: 2,
    }));
    try {
        await waitForSignal(deferredBatchAStarted, "deferred batch A provider request");
    } catch (error) {
        const task = getBackgroundTask(batchTaskId);
        const ledger = await readRecordSchedulerLedgerStore(batchTaskId, { expectPublished: true });
        throw new Error(`${error instanceof Error ? error.message : String(error)}; task=${JSON.stringify(task)}; ledger=${JSON.stringify(ledger)}`);
    }
    assert.ok(releaseDeferredBatchA, "batch A should be held in an in-flight provider request");
    await waitForSignal(secondBatchRequestReached, "batch B second provider permit");
    releaseDeferredBatchA();
    releaseDeferredBatchA = null;
    deferredBatchProviderConversation = null;
    deferBatchA = false;
    await waitForTask(batchTaskId, getBackgroundTask);
    const batchLedger = await readRecordSchedulerLedgerStore(batchTaskId, { expectPublished: true });
    assert.equal(batchLedger.kind, "current", "batch tool path should persist a scheduler ledger");
    if (batchLedger.kind === "current") {
        const providerUnits = batchLedger.ledger.units.filter(unit => unit.layer !== "local-finalize");
        assert.equal(batchLedger.ledger.units.filter(unit => unit.state === "Succeeded" && unit.layer === "local-finalize").length, 2, "both frozen batch candidates should finalize Verified");
        assert.ok(providerUnits.length >= 2 && providerUnits.every(unit => unit.state === "Succeeded"), "all provider model Units should settle after local-finalize verification");
        assert.equal(batchLedger.ledger.candidateSnapshot.candidates.length, 3, "discovery must classify the whole available scope before applying limit");
        assert.equal(batchLedger.ledger.candidateSnapshot.selectionLimit, 2, "scheduler snapshot must persist the materialization limit");
        assert.equal(batchLedger.ledger.sourceMaterialization?.selected.length, 2, "source materialization intent must contain only the final selected set");
    }
    const committedBatchIndex = await readRecordsIndexAsync(workspaceHash);
    for (const targetConversationId of [deferredBatchConversationId, secondBatchConversationId]) {
        assert.ok(
            Number.isSafeInteger(committedBatchIndex.records[targetConversationId]?.coveredRevisionSequence),
            "Verified Record metadata must persist the authoritative source revision sequence",
        );
        assert.ok(
            typeof committedBatchIndex.records[targetConversationId]?.coveredRevision === "string"
            && committedBatchIndex.records[targetConversationId]!.coveredRevision!.length > 0,
            "Verified Record metadata must persist the authoritative source revision",
        );
    }
    const modelRequestsBeforeStaleBatch = modelRequests;
    const deferredBatchSourceSequence = appendStaleRound(deferredBatchConversationId);
    const secondBatchSourceSequence = appendStaleRound(secondBatchConversationId);
    assert.ok(deferredBatchSourceSequence > committedBatchIndex.records[deferredBatchConversationId].coveredRevisionSequence!, "deferred batch source sequence must advance after append");
    assert.ok(secondBatchSourceSequence > committedBatchIndex.records[secondBatchConversationId].coveredRevisionSequence!, "second batch source sequence must advance after append");
    const staleBatchTaskId = taskIdOf(await handler({
        action: "batch_update",
        workspace,
        dataChain: "codex",
        modelChain: "grok",
        limit: 2,
    }));
    await waitForTask(staleBatchTaskId, getBackgroundTask);
    const staleBatchLedger = await readRecordSchedulerLedgerStore(staleBatchTaskId, { expectPublished: true });
    assert.equal(staleBatchLedger.kind, "current", "a new scheduler batch admission must not reuse the legacy batch ledger as correctness state");
    if (staleBatchLedger.kind === "current") {
        const frozenDiscovery = JSON.parse(fs.readFileSync(
            path.join(dataRoot, staleBatchLedger.ledger.candidateSnapshot.snapshotRef.path),
            "utf8",
        )) as { snapshot?: { candidates?: Array<Record<string, any>>; recordIndex?: { entries?: Array<Record<string, any>> } } };
        const staleDiagnostics = JSON.stringify((frozenDiscovery.snapshot?.candidates || []).map(candidate => ({
            conversationId: candidate.source?.identity?.conversationId,
            classification: candidate.classification,
            reason: candidate.classificationReason,
            sourceRevision: candidate.sourceRevision,
            recordCoveredRevision: frozenDiscovery.snapshot?.recordIndex?.entries?.find(entry => entry.source?.identity?.conversationId === candidate.source?.identity?.conversationId)?.coveredRevision,
        })));
        assert.equal(staleBatchLedger.ledger.units.filter(unit => unit.state === "Succeeded" && unit.layer === "local-finalize").length, 2, `legacy completed ids must not suppress stale frozen candidates in a new scheduler task; candidates=${staleDiagnostics}`);
        const staleProviderUnits = staleBatchLedger.ledger.units.filter(unit => unit.layer !== "local-finalize");
        assert.ok(staleProviderUnits.length >= 2 && staleProviderUnits.every(unit => unit.state === "Succeeded"), "stale batch provider Units should settle after local-finalize verification");
    }
    assert.ok(modelRequests >= modelRequestsBeforeStaleBatch + 2, "stale frozen candidates suppressed by an old completed ledger must still make fresh provider calls");
    assert.deepEqual(
        persistenceHookEvents.filter(event => event.persistencePath === "legacy"),
        [],
        "scheduler-managed batch local-finalize must not enter legacy direct write/index hooks",
    );

    writeFailureCodexFixture();
    const failureTaskId = taskIdOf(await handler({ action: "update", conversationId: failureConversationId, workspace, dataChain: "codex", modelChain: "grok" }));
    const failedProjection = await waitForTask(failureTaskId, getBackgroundTask, "error");
    assert.match(failedProjection.error || "", /Record scheduler .*未完成 Record|执行失败/u, "provider failure must reject the background projection instead of returning a success-looking string");
    const failedLedger = await readRecordSchedulerLedgerStore(failureTaskId, { expectPublished: true });
    assert.equal(failedLedger.kind, "current", "failed production update must retain a readable scheduler ledger");
    if (failedLedger.kind === "current") {
        assert.equal(failedLedger.ledger.task.state, "FailedFinal", "incomplete durable Units must never be promoted to Succeeded");
        assert.equal(failedLedger.ledger.task.recordItems.succeeded, 0);
        assert.ok(failedLedger.ledger.units.some(unit => unit.state === "FailedFinal"), "provider failure must remain visible on its Unit");
    }
    assert.equal(await readRecordAsync(workspaceHash, failureConversationId), null, "failed production update must not publish a formal Record body");

    writeCancellationCodexFixture();
    deferCancellationProvider = true;
    const cancellationTaskId = taskIdOf(await handler({ action: "update", conversationId: cancellationConversationId, workspace, dataChain: "codex", modelChain: "grok" }));
    await waitForSignal(cancellationProviderStarted, "cancellation provider request");
    assert.ok(releaseCancellationProvider, "cancellation fixture should hold its provider request in flight");
    const cancellationResponsePromise = handler({ action: "cancel", taskId: cancellationTaskId });
    await waitForSignal(cancellationResponsePromise.then(() => undefined), "scheduler cancellation control response");
    const cancellationResponse = await cancellationResponsePromise;
    assert.match(textOf(cancellationResponse), /Record scheduler cancel: cancelling/u, "cancel must return the scheduler cancelling disposition before the held provider request completes");
    assert.ok(releaseCancellationProvider, "cancel must not wait for the held provider request to complete");
    const cancellingLedger = await readRecordSchedulerLedgerStore(cancellationTaskId, { expectPublished: true });
    assert.equal(cancellingLedger.kind, "current", "in-flight cancellation should retain a readable scheduler ledger");
    if (cancellingLedger.kind === "current") {
        assert.equal(cancellingLedger.ledger.task.state, "Cancelling", "scheduler task must remain Cancelling while the provider request is held");
    }
    releaseCancellationProvider();
    releaseCancellationProvider = null;
    deferCancellationProvider = false;
    await waitForSignal(cancellationProviderResponseSent, "cancelled provider late response");
    await waitForTask(cancellationTaskId, getBackgroundTask);
    const cancelledLedger = await readRecordSchedulerLedgerStore(cancellationTaskId, { expectPublished: true });
    assert.equal(cancelledLedger.kind, "current", "late provider output must leave a readable scheduler ledger");
    if (cancelledLedger.kind === "current") {
        assert.equal(cancelledLedger.ledger.task.state, "Cancelled", "late provider output must settle the scheduler task as Cancelled");
        assert.ok(cancelledLedger.ledger.attempts.some(attempt => attempt.state === "Discarded" && attempt.outcome === "discarded"), "late provider output must be discarded instead of entering Record finalization");
    }
    assert.equal(await readRecordAsync(workspaceHash, cancellationConversationId), null, "cancelled conversation must not receive a formal Record body");
    assert.equal((await readRecordsIndexAsync(workspaceHash)).records[cancellationConversationId], undefined, "cancelled conversation must not receive formal Record index metadata");

    const canonicalMessages = [
        { order: 1, role: "assistant" as const, content: "leading-assistant" },
        {
            order: 2,
            role: "user" as const,
            content: "consecutive-user-a",
            attachments: [{
                kind: "image",
                source: "codex-local-file",
                name: "attachment.png",
                mimeType: "image/png",
                reference: "path-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                sizeBytes: 42,
                sha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
                exists: false,
                warning: "attachment descriptor could not be fully resolved",
                originalPath: "C:\\Users\\FixtureUser\\private\\do-not-leak.png",
                dataUrl: "data:image/png;base64,c2Vuc2l0aXZlLWF0dGFjaG1lbnQ=",
            }],
        },
        { order: 3, role: "user" as const, content: "consecutive-user-b" },
        { order: 4, role: "assistant" as const, content: "assistant-a" },
        { order: 5, role: "assistant" as const, content: "assistant-b" },
        { order: 6, role: "user" as const, content: "trailing-user" },
    ];
    const frozen = {
        snapshot: { sourceSnapshotId: "canonical-fixture", chain: "codex", conversationId: "canonical-fixture", workspaceHash, contentHash: "canonical-hash", contentRef: { hash: "canonical-hash" } },
        document: { schemaVersion: "record-source-content/v1", formatterVersion: "canonical-json-nfc-lf/v1", source: { host: "codex", conversationId: "canonical-fixture" }, messages: canonicalMessages },
    } as never;
    const reconstructed = __recordConcurrencyTest.loadFrozenSource(frozen);
    const attachmentRound = reconstructed.rounds.find(round => round.userMessage === "consecutive-user-a");
    assert.ok(attachmentRound, "frozen replay should retain the round carrying canonical attachment metadata");
    assert.deepEqual(attachmentRound.attachments, [{
        kind: "image",
        source: "codex-local-file",
        name: "attachment.png [source=codex-local-file; reference=path-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; sha256=sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789; mime=image/png; sizeBytes=42; exists=false]",
        mimeType: "image/png",
        reference: "path-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 42,
        sha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        exists: false,
        warning: "attachment descriptor could not be fully resolved",
        stepIndex: 2,
    }], "frozen replay should retain only the canonical attachment descriptor fields");
    assert.equal(JSON.stringify(attachmentRound).includes("C:\\Users\\FixtureUser\\private\\do-not-leak.png"), false, "frozen replay must not restore a local attachment path");
    assert.equal(JSON.stringify(attachmentRound).includes("data:image/png;base64,c2Vuc2l0aXZlLWF0dGFjaG1lbnQ="), false, "frozen replay must not restore an attachment data URL or base64 payload");
    const v2Reconstructed = __recordConcurrencyTest.loadFrozenSource({
        ...frozen,
        document: { ...frozen.document, formatterVersion: "canonical-json-nfc-lf/v2" },
    });
    assert.equal(v2Reconstructed.rounds.length, reconstructed.rounds.length, "frozen replay must accept the current v2 canonical formatter");
    const replayedMessages = reconstructed.rounds.flatMap((round: { userMessage: string; aiResponses: Array<{ response: string }> }) => [
        ...(round.userMessage ? [{ role: "user", content: round.userMessage }] : []),
        ...round.aiResponses.map(response => ({ role: "assistant", content: response.response })),
    ]);
    assert.deepEqual(
        replayedMessages,
        canonicalMessages.map(message => ({ role: message.role, content: message.content })),
        "canonical frozen messages must replay once, in order, with unchanged role and content",
    );
    const promptText = formatRoundsForRecord(reconstructed.rounds).map(round => round.text).join("\n");
    for (const message of canonicalMessages) {
        assert.equal(promptText.split(message.content).length - 1, 1, `canonical text should appear once in prompt formatter: ${message.content}`);
    }
    assert.match(promptText, /attachment\.png \[source=codex-local-file; reference=path-sha256:/u, "Record prompt should preserve sanitized frozen attachment metadata");
    assert.doesNotMatch(promptText, /C:\\Users\\FixtureUser\\private\\do-not-leak\.png|data:image\/png;base64,c2Vuc2l0aXZlLWF0dGFjaG1lbnQ=/u, "Record prompt must not expose a local attachment path or data URL");
    assert.throws(
        () => __recordConcurrencyTest.loadFrozenSource({
            ...frozen,
            document: { ...frozen.document, schemaVersion: "record-source-content/unsupported" },
        }),
        /schemaVersion/u,
        "frozen replay must reject an unsupported canonical schema before parsing messages",
    );
    assert.throws(
        () => __recordConcurrencyTest.loadFrozenSource({
            ...frozen,
            document: { ...frozen.document, formatterVersion: "canonical-json-nfc-lf/v3" },
        }),
        /formatterVersion/u,
        "frozen replay must reject an unsupported canonical formatter before parsing messages",
    );

    const unknownId = "unknown-chain-migration-e2e";
    const index = await readRecordsIndexAsync(workspaceHash);
    index.records[unknownId] = { conversationId: unknownId, title: "unknown", timeSpan: "", totalRounds: 1, totalSteps: 1, lastUpdatedRound: 1, lastUpdatedAt: "2026-07-14T00:00:00.000Z", phases: 1, sizeBytes: 1, tags: [], chain: "unknown" };
    const { writeRecordsIndex } = await import("../src/record-store.ts");
    await writeRecordsIndex(workspaceHash, index);
    const hosts = ["codex", "claude-code", "windsurf", "antigravity"] as const;
    const migrationSourceReaderCalls: string[] = [];
    let emitIncompleteMigrationEvidence = false;
    const migrationSourceReader = {
        async scan(request: any) {
            const host = request.host as typeof hosts[number];
            migrationSourceReaderCalls.push(`${host}:${request.conversationId}`);
            const workspaceIdentity = host === "codex"
                ? request.workspace
                : { workspaceId: request.workspaceId, canonicalPath: request.workspacePath };
            const sourcePath = path.join(root, "migration-source", host);
            const identity = { workspace: workspaceIdentity, source: { kind: "filesystem" as const, authority: `${host}-fixture`, authoritativeRoot: sourcePath, canonicalPath: sourcePath }, conversationId: request.conversationId };
            const base = { adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION, host, identity, sourceRevision: { revision: `${host}-revision`, contentCursor: null, eventWatermark: null, sequence: 1 }, pagination: { cursor: null, pages: 1, limit: null, truncated: false }, enumerationComplete: true, cacheBypassed: true, errors: [], warnings: [], observedAt: { scanId: `migration-${host}`, sequence: 1, startedAt: "2026-07-14T00:00:00.000Z", completedAt: "2026-07-14T00:00:01.000Z" } };
            const present = host === "codex" || (request.conversationId === "unknown-chain-conflict-e2e" && host === "windsurf");
            const incomplete = emitIncompleteMigrationEvidence
                && request.conversationId === "unknown-chain-unresolved-e2e"
                && host === "antigravity";
            const enumeration = evidence.buildSourceEnumerationEvidence({
                ...base,
                targetStatus: incomplete ? "unknown" : present ? "present" : "absent",
                exactFetchResult: incomplete ? "unresolved" : present ? "present" : "not_found",
                ...(incomplete ? { enumerationComplete: false, errors: [{ code: "source_unavailable", message: "fixture incomplete" }] } : {}),
            });
            const exactFetch = evidence.buildExactFetchEvidence({
                ...base,
                exactFetchResult: incomplete ? "unresolved" : present ? "present" : "not_found",
                ...(incomplete ? { enumerationComplete: false, errors: [{ code: "source_unavailable", message: "fixture incomplete" }] } : {}),
            });
            return {
                host,
                scanId: `migration-${host}`,
                enumeration,
                exactFetch,
                fullSourceRead: present ? {
                    status: "complete",
                    evidence: evidence.buildFullSourceReadEvidence({ ...base, exactFetchResult: "present", content: { mode: "full", byteLength: 1, contentHash: `sha256:${createHash("sha256").update(host).digest("hex")}`, roundRange: { start: 1, end: 1 }, truncated: false, staleCache: false } }),
                } : { status: "unresolved", evidence: null },
            };
        },
    };
    __recordConcurrencyTest.setUnknownChainMigrationReaders(null);
    __recordConcurrencyTest.setUnknownChainMigrationProductionSourceReader(migrationSourceReader as never);
    const dryRun = textOf(await handler({ action: "migrate_unknown_chain", workspace, scope: "workspace" }));
    assert.match(dryRun, /proposed=1 applied=0/u, "migration default must be dry-run");
    assert.deepEqual([...new Set(migrationSourceReaderCalls)].sort(), hosts.map(host => `${host}:${unknownId}`).sort(), "default migration readers must inspect every authoritative host through ProductionSourceReader");
    assert.equal((await readRecordsIndexAsync(workspaceHash)).records[unknownId].chain, "unknown");
    const applied = textOf(await handler({ action: "migrate_unknown_chain", workspace, scope: "workspace", apply: true }));
    assert.match(applied, /applied=1/u, "explicit apply should perform a CAS-protected migration");
    assert.equal((await readRecordsIndexAsync(workspaceHash)).records[unknownId].chain, "codex");
    const conflictId = "unknown-chain-conflict-e2e";
    const conflictIndex = await readRecordsIndexAsync(workspaceHash);
    conflictIndex.records[conflictId] = { ...conflictIndex.records[unknownId], conversationId: conflictId, chain: "unknown" };
    await writeRecordsIndex(workspaceHash, conflictIndex);
    const conflictApply = textOf(await handler({ action: "migrate_unknown_chain", workspace, scope: "workspace", apply: true }));
    assert.match(conflictApply, /Conflict/u, "multiple host matches must remain a conflict");
    assert.equal((await readRecordsIndexAsync(workspaceHash)).records[conflictId].chain, "unknown", "conflict must not mutate the index");
    const unresolvedId = "unknown-chain-unresolved-e2e";
    const unresolvedIndex = await readRecordsIndexAsync(workspaceHash);
    unresolvedIndex.records[unresolvedId] = { ...unresolvedIndex.records[conflictId], conversationId: unresolvedId, chain: "unknown" };
    await writeRecordsIndex(workspaceHash, unresolvedIndex);
    emitIncompleteMigrationEvidence = true;
    const unresolvedApply = textOf(await handler({ action: "migrate_unknown_chain", workspace, scope: "workspace", apply: true }));
    assert.match(unresolvedApply, /Unresolved/u, "incomplete authoritative reader evidence must remain unresolved");
    assert.equal((await readRecordsIndexAsync(workspaceHash)).records[unresolvedId].chain, "unknown", "incomplete evidence must not mutate the index");
    __recordConcurrencyTest.setUnknownChainMigrationProductionSourceReader(null);
    __recordConcurrencyTest.setPersistenceHook(null);
    await resetProviderTransportAdapterForTest();
} finally {
    releaseDeferredBatchA?.();
    releaseCancellationProvider?.();
    resetRecordTestHooks();
    await resetProviderAdapter();
    for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log("record scheduler production tools E2E passed");
