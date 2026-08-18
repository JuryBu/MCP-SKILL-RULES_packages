import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const FIXTURE_CONVERSATION_ID = "plan35-stale-codex-fixture";
const SENTINEL_CONVERSATION_ID = "plan35-other-workspace-sentinel";
const REFRESH_MARKER = "PLAN35_STALE_BATCH_REFRESHED";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan35-stale-e2e-"));
const fakeHome = path.join(tempRoot, "home");
const fakeCodexHome = path.join(fakeHome, ".codex");
const fakeSessionsDir = path.join(fakeCodexHome, "sessions");
const dataRoot = path.join(tempRoot, "data");
const fixtureWorkspace = path.join(tempRoot, "workspace-fixture");
const sentinelWorkspace = path.join(tempRoot, "workspace-sentinel");
const originalCwd = process.cwd();
const environmentKeys = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "MEMORY_STORE_DATA_ROOT",
    "MEMORY_STORE_GROK_PROXY_URL",
    "MEMORY_STORE_GROK_API_KEY",
    "MEMORY_STORE_GROK_CALL_CONCURRENCY",
    "MEMORY_STORE_GROK_BATCH_CONCURRENCY",
    "MEMORY_STORE_GROK_FOREGROUND_RESERVED_SLOTS",
    "MEMORY_STORE_RECORD_PARALLEL_MODE",
    "MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY",
] as const;
const originalEnvironment = new Map<string, string | undefined>(
    environmentKeys.map(key => [key, process.env[key]]),
);

for (const directory of [fakeSessionsDir, fixtureWorkspace, sentinelWorkspace]) {
    fs.mkdirSync(directory, { recursive: true });
}

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = path.parse(fakeHome).root.replace(/\\$/, "") || "C:";
process.env.HOMEPATH = fakeHome.slice(process.env.HOMEDRIVE.length) || "\\";
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_GROK_API_KEY = "plan35-test-key";
process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = "2";
process.env.MEMORY_STORE_GROK_BATCH_CONCURRENCY = "1";
process.env.MEMORY_STORE_GROK_FOREGROUND_RESERVED_SLOTS = "0";
process.env.MEMORY_STORE_RECORD_PARALLEL_MODE = "off";
process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY = "1";

const refreshedRecord = [
    "# Record: Plan 35 stale batch fixture",
    "",
    `- 对话ID：${FIXTURE_CONVERSATION_ID}`,
    "- 工作区：fixture",
    "- 总轮次：4",
    "- 总步骤：6",
    `- 刷新标记：${REFRESH_MARKER}`,
    "",
    "## Phase 1：批量 stale 刷新（轮次 1-4)",
    "",
    "- 使用 fake Grok proxy 生成可重复的刷新结果",
    "- 验证同轮数 stale Record 仍会重新生成",
    "",
    "## 验证结果",
    "",
    "- 主索引和 Reader Index 应指向同一份刷新正文",
    "",
    "<!-- TAGS: plan35, stale, refreshed -->",
].join("\n");

const staleSeedRecord = [
    "# Record: Plan 35 stale batch fixture",
    "",
    `- 对话ID：${FIXTURE_CONVERSATION_ID}`,
    "- 工作区：fixture",
    "- 总轮次：4",
    "- 总步骤：6",
    "- 刷新标记：STALE_SEED",
    "",
    "## Phase 1：初始记录（轮次 1-4)",
    "",
    "- 这份 Record 的轮数已相同，但更新时间故意落后",
    "",
    "## 验证结果",
    "",
    "- 等待 stale_only 批量刷新",
].join("\n");

const sentinelRecord = [
    "# Record: Plan 35 sentinel",
    "",
    `- 对话ID：${SENTINEL_CONVERSATION_ID}`,
    "",
    "## Phase 1：不可触碰（轮次 1-3)",
    "",
    "- 不同 workspace 的 sentinel，所有字节必须保持不变",
].join("\n");

function writeJsonl(filePath: string, events: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

function writeFixedCodexFixture(updatedAtMs: number): void {
    const rolloutPath = path.join(fakeSessionsDir, `rollout-2026-07-11T00-00-00-${FIXTURE_CONVERSATION_ID}.jsonl`);
    writeJsonl(rolloutPath, [
        {
            type: "session_meta",
            payload: {
                id: FIXTURE_CONVERSATION_ID,
                cwd: fixtureWorkspace,
                title: "Plan 35 stale fixture",
                source: "codex",
                model: "gpt-test",
                reasoning_effort: "high",
            },
        },
        ...[1, 2, 3, 4].flatMap(round => [
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: `fixture user round ${round}` }],
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: `fixture assistant round ${round}` }],
                },
            },
        ]),
    ]);

    const stateDb = path.join(fakeCodexHome, "state_5.sqlite");
    const python = `
import sqlite3, sys
db_path, rollout_path, workspace, updated_at_ms = sys.argv[1:]
conn = sqlite3.connect(db_path)
conn.execute("""
create table threads (
  id text primary key,
  rollout_path text,
  cwd text,
  title text,
  source text,
  model text,
  reasoning_effort text,
  agent_nickname text,
  agent_role text,
  updated_at_ms integer,
  updated_at text,
  archived integer default 0
)
""")
conn.execute("""
create table thread_spawn_edges (
  child_thread_id text,
  parent_thread_id text,
  status text
)
""")
conn.execute(
  "insert into threads (id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms, updated_at, archived) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ("${FIXTURE_CONVERSATION_ID}", rollout_path, workspace, "Plan 35 stale fixture", "codex", "gpt-test", "high", None, None, int(updated_at_ms), "2026-07-11T00:00:00.000Z", 0)
)
conn.commit()
conn.close()
`;
    execFileSync("python", ["-c", python, stateDb, rolloutPath, fixtureWorkspace, String(updatedAtMs)], {
        stdio: "inherit",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
}

function snapshotDirectoryBytes(directory: string): Array<[string, string]> {
    const entries: Array<[string, string]> = [];
    const visit = (current: string, relative: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const nextRelative = path.join(relative, entry.name);
            const nextPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(nextPath, nextRelative);
            } else if (entry.isFile()) {
                entries.push([nextRelative, fs.readFileSync(nextPath).toString("base64")]);
            }
        }
    };
    visit(directory, "");
    return entries.sort(([left], [right]) => left.localeCompare(right, "en"));
}

function textOf(response: { content?: Array<{ text?: string }> }): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

function taskIdOf(response: { content?: Array<{ text?: string }> }): string {
    const text = textOf(response);
    const match = text.match(/taskId:\s*(record-(?:batch-update|scheduler)-[^\s]+)/u);
    assert.ok(match, `batch_update should return its taskId: ${text}`);
    return match[1];
}

function resumeKeyOf(response: { content?: Array<{ text?: string }> }): string {
    const text = textOf(response);
    const match = text.match(/resumeKey:\s*([^\s]+)/u);
    assert.ok(match, `batch_update should return its resumeKey: ${text}`);
    return match[1];
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let grokPostCount = 0;
const grokBodies: unknown[] = [];
const recordPatchResponse = [
    "```json",
    JSON.stringify({
        startRound: 1,
        endRound: 4,
        title: "Plan 35 stale refresh patch",
        files: ["tests/record-batch-stale-e2e.test.ts"],
        tags: ["plan35", "stale", "refreshed"],
        risks: [],
        status: "ok",
    }),
    "```",
    "",
    "## Phase Draft",
    "",
    `- 刷新标记：${REFRESH_MARKER}`,
].join("\n");
const grokProxy = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "grok-4.5" }] }));
        return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
        response.writeHead(404);
        response.end("not found");
        return;
    }

    let raw = "";
    request.setEncoding("utf-8");
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
        grokPostCount += 1;
        const requestBody = raw ? JSON.parse(raw) : null;
        grokBodies.push(requestBody);
        const prompt = JSON.stringify(requestBody);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            choices: [{
                message: { content: prompt.includes("RecordPatch") ? recordPatchResponse : refreshedRecord },
                finish_reason: "stop",
            }],
        }));
    });
});

await new Promise<void>((resolve, reject) => {
    grokProxy.once("error", reject);
    grokProxy.listen(0, "127.0.0.1", () => resolve());
});
const proxyAddress = grokProxy.address();
assert.ok(proxyAddress && typeof proxyAddress === "object", "fake Grok proxy should listen on a TCP port");
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${proxyAddress.port}`;

try {
    const fixtureConversationUpdatedAtMs = Date.now() - 2 * 60_000;
    writeFixedCodexFixture(fixtureConversationUpdatedAtMs);
    process.chdir(fixtureWorkspace);

    const { registerRecord } = await import("../src/tools/record.ts");
    const {
        readRecordAsync,
        readRecordSidecarAsync,
        readRecordsIndexAsync,
        resolveWorkspaceHashForRecord,
        writeRecord,
        writeRecordsIndex,
    } = await import("../src/record-store.ts");
    const { WORKSPACES_DIR } = await import("../src/store.ts");
    const { calculateRecordSourceHash } = await import("../src/record-reader.ts");
    const { getBackgroundTask } = await import("../src/background-tasks.ts");
    const { resetGrokBridgeAvailabilityForTest, resetGrokCallConcurrencyForTest } = await import("../src/grok-client.ts");
    const { configureProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");

    resetGrokBridgeAvailabilityForTest();
    resetGrokCallConcurrencyForTest();
    const providerTransport = await configureProviderTransportAdapterForTest({
        mode: "test",
        dataRoot,
        ownerId: "record-batch-stale-e2e",
    });

    type ToolResponse = { content?: Array<{ text?: string }> };
    type RecordManageHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;
    let recordManageHandler: RecordManageHandler | null = null;
    registerRecord({
        tool(name: string, _description: string, _schema: unknown, handler: RecordManageHandler) {
            if (name === "record_manage") recordManageHandler = handler;
        },
    } as never);
    assert.ok(recordManageHandler, "record_manage public handler should be registered");
    const unsupportedRecordIds = textOf(await recordManageHandler!({
        action: "stale_check",
        workspace: fixtureWorkspace,
        scope: "workspace",
        dataChain: "codex",
        recordIds: [FIXTURE_CONVERSATION_ID],
    }));
    assert.match(unsupportedRecordIds, /stale_check.*不支持 recordIds/u, "stale_check must reject recordIds instead of silently scanning the whole scope");

    const fixtureHash = resolveWorkspaceHashForRecord(fixtureWorkspace);
    const sentinelHash = resolveWorkspaceHashForRecord(sentinelWorkspace);
    await writeRecord(fixtureHash, FIXTURE_CONVERSATION_ID, staleSeedRecord, {
        title: "Plan 35 stale fixture",
        timeSpan: "2026-07-11 00:00 ~ 2026-07-11 00:01",
        totalRounds: 4,
        totalSteps: 6,
        lastUpdatedRound: 3,
        phases: 1,
        tags: ["plan35", "stale"],
        chain: "codex",
    });
    const staleIndex = await readRecordsIndexAsync(fixtureHash);
    const staleCoveredRevisionSequence = fixtureConversationUpdatedAtMs - 4 * 60_000;
    const staleCoveredRevision = "codex-revision-before-refresh";
    const staleCommitId = "plan35-stale-seed-commit";
    const staleEntry = staleIndex.records[FIXTURE_CONVERSATION_ID];
    staleEntry.lastUpdatedAt = new Date(staleCoveredRevisionSequence).toISOString();
    staleEntry.coveredRevisionSequence = staleCoveredRevisionSequence;
    staleEntry.commitArtifact = {
        identity: {
            conversationId: FIXTURE_CONVERSATION_ID,
            recordId: FIXTURE_CONVERSATION_ID,
            commitId: staleCommitId,
            coveredRevision: staleCoveredRevision,
            bodyHash: calculateRecordSourceHash(staleSeedRecord),
            recordCommitEpoch: 1,
        },
        mainIndex: {
            conversationId: FIXTURE_CONVERSATION_ID,
            recordId: FIXTURE_CONVERSATION_ID,
            commitId: staleCommitId,
            coveredRevision: staleCoveredRevision,
        },
    };
    await writeRecordsIndex(fixtureHash, staleIndex);

    await writeRecord(sentinelHash, SENTINEL_CONVERSATION_ID, sentinelRecord, {
        title: "Plan 35 untouched sentinel",
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
        phases: 1,
        chain: "codex",
    });
    const sentinelRecordsDirectory = path.join(WORKSPACES_DIR, sentinelHash, "records");
    const sentinelBytesBefore = snapshotDirectoryBytes(sentinelRecordsDirectory);

    const staleBefore = textOf(await recordManageHandler!({
        action: "stale_check",
        workspace: fixtureWorkspace,
        scope: "workspace",
        dataChain: "codex",
        limit: 1,
    }));
    assert.match(staleBefore, /其中 1 份已过期/u, `fixture should begin with exactly one stale Record: ${staleBefore}`);

    const startResponse = await recordManageHandler!({
        action: "batch_update",
        workspace: fixtureWorkspace,
        dataChain: "codex",
        modelChain: "grok",
        stale_only: true,
        force: false,
        limit: 1,
    });
    const taskId = taskIdOf(startResponse);
    const resumeKey = resumeKeyOf(startResponse);
    const ledgerPath = path.join(dataRoot, "record-task-recovery", `record-batch-${resumeKey}.json`);

    let latestPublicStatus = "";
    let ledgerFromPoll: any = null;
    const timeoutAt = Date.now() + 30_000;
    while (Date.now() < timeoutAt) {
        latestPublicStatus = textOf(await recordManageHandler!({ action: "task_status", taskId }));
        if (fs.existsSync(ledgerPath)) {
            ledgerFromPoll = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
        }
        const task = getBackgroundTask(taskId);
        if (task?.status !== "running") break;
        await sleep(25);
    }

    const task = getBackgroundTask(taskId);
    assert.equal(task?.status, "done", `batch task should finish successfully: ${task?.error || latestPublicStatus}`);
    assert.ok(ledgerFromPoll, "task polling should observe the v2 batch ledger");
    assert.equal(ledgerFromPoll.version, 2, "batch ledger should be normalized to v2");
    assert.deepEqual(
        ledgerFromPoll.completed.map((entry: { id: string }) => entry.id),
        [FIXTURE_CONVERSATION_ID],
        JSON.stringify({
            completed: ledgerFromPoll.completed,
            skipped: ledgerFromPoll.skipped,
            failed: ledgerFromPoll.failed,
            inFlight: ledgerFromPoll.inFlight,
            taskResult: task?.result,
        }, null, 2),
    );
    assert.equal(ledgerFromPoll.completed[0].isNew, false, "existing stale Record should be attributed as an update");
    assert.deepEqual(ledgerFromPoll.failed, []);
    assert.deepEqual(ledgerFromPoll.skipped, []);
    assert.deepEqual(ledgerFromPoll.inFlight, []);

    const finalText = task?.result || latestPublicStatus;
    assert.match(finalText, /本 batch 成功: 1 份（新建 0 \/ 更新 1 \/ 未分类 0）/u);
    const providerDiagnostics = providerTransport.diagnostics();
    assert.equal(providerDiagnostics.mode, "test");
    assert.ok(providerDiagnostics.acquireCount > 0, "scheduler-managed refresh must acquire the durable provider lane");
    assert.equal(providerDiagnostics.settleCount, providerDiagnostics.acquireCount, "every acquired provider lease must settle before batch completion");
    assert.ok(providerDiagnostics.attempts.some(attempt => attempt.provider === "grok"
        && attempt.trafficClass === "record"
        && attempt.settlement === "success"
        && attempt.permitSettled), "the real Grok call must finish through a settled record-traffic provider permit");
    assert.ok(grokPostCount > 0, "stale-only refresh should issue at least one Grok POST");
    assert.ok(grokBodies.every(body => body && typeof body === "object"), "each Grok POST should carry a JSON request body");

    const refreshedBody = await readRecordAsync(fixtureHash, FIXTURE_CONVERSATION_ID);
    assert.ok(refreshedBody, "fixture Record body should still exist after the stale refresh");
    assert.notEqual(refreshedBody, staleSeedRecord, "stale fixture body should be rewritten instead of timestamp-only touching");
    assert.match(refreshedBody || "", new RegExp(`刷新标记：${REFRESH_MARKER}`, "u"));
    const refreshedIndex = await readRecordsIndexAsync(fixtureHash);
    const refreshedEntry = refreshedIndex.records[FIXTURE_CONVERSATION_ID];
    assert.equal(refreshedEntry.totalRounds, refreshedEntry.lastUpdatedRound);
    assert.ok(refreshedEntry.totalRounds >= 4, "main index should preserve the fixture's current round count");
    assert.ok(refreshedEntry.totalSteps >= 6, "main index should preserve the fixture's current step count");
    assert.equal(refreshedEntry.chain, "codex");
    assert.equal(refreshedEntry.sizeBytes, Buffer.byteLength(refreshedBody, "utf-8"));
    const readerIndex = await readRecordSidecarAsync<{ sourceHash: string; sourceSizeBytes: number }>(
        fixtureHash,
        FIXTURE_CONVERSATION_ID,
        "record_index.json",
    );
    assert.ok(readerIndex, "updated Record should persist its Reader Index");
    assert.equal(readerIndex.sourceHash, calculateRecordSourceHash(refreshedBody), "Reader Index must describe the updated Record body");
    assert.equal(readerIndex.sourceSizeBytes, Buffer.byteLength(refreshedBody, "utf-8"));

    const staleAfter = textOf(await recordManageHandler!({
        action: "stale_check",
        workspace: fixtureWorkspace,
        scope: "workspace",
        dataChain: "codex",
        limit: 1,
    }));
    assert.match(staleAfter, /其中 0 份已过期/u, `fixture stale count should fall from 1 to 0: ${staleAfter}`);
    assert.deepEqual(
        snapshotDirectoryBytes(sentinelRecordsDirectory),
        sentinelBytesBefore,
        "different-workspace sentinel files must remain byte-for-byte unchanged",
    );

    console.log("✅ record batch stale E2E tests passed");
} finally {
    const { resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
    await resetProviderTransportAdapterForTest();
    await new Promise<void>(resolve => grokProxy.close(() => resolve()));
    process.chdir(originalCwd);
    for (const key of environmentKeys) {
        const value = originalEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
