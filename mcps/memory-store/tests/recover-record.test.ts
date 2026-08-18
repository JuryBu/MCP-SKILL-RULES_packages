import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-recover-record-"));
const fakeHome = path.join(tempRoot, "home");
const fakeCodexHome = path.join(fakeHome, ".codex");
const fakeSessionsDir = path.join(fakeCodexHome, "sessions");
const fakeDataRoot = path.join(tempRoot, "data");
const fakeWorkspaceSingle = path.join(tempRoot, "workspace-single");
const fakeWorkspaceBatchCreate = path.join(tempRoot, "workspace-batch-create");
const fakeWorkspaceBatchRecover = path.join(tempRoot, "workspace-batch-recover");
const fakeCodexJs = path.join(tempRoot, "fake-codex.js");
const fakeCodexCmd = path.join(tempRoot, "fake-codex.cmd");

fs.mkdirSync(fakeSessionsDir, { recursive: true });
fs.mkdirSync(fakeWorkspaceSingle, { recursive: true });
fs.mkdirSync(fakeWorkspaceBatchCreate, { recursive: true });
fs.mkdirSync(fakeWorkspaceBatchRecover, { recursive: true });

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = path.parse(fakeHome).root.replace(/\\$/, "") || "C:";
process.env.HOMEPATH = fakeHome.slice(process.env.HOMEDRIVE.length) || "\\";
process.env.MEMORY_STORE_DATA_ROOT = fakeDataRoot;
process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "4000";
process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT = "4000";
process.env.MEMORY_STORE_RECORD_PARALLEL_MODE = "off";
process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES = "0";
process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = "999999";
process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS = "20";
process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT = "99";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY = "1";

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

function parseRoundRange(input) {
  const matches = Array.from(input.matchAll(/轮次[^\\d]*(\\d+)\\s*[-~–—－]\\s*(\\d+)/gu));
  if (matches.length === 0) return { start: 1, end: 4 };
  const last = matches[matches.length - 1];
  return { start: Number(last[1]), end: Number(last[2]) };
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const range = parseRoundRange(input);
    if (input.includes("RecordPatch")) {
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound: range.start,
          endRound: range.end,
          title: "恢复测试区段",
          files: [],
          tags: ["recover", "record"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- 生成恢复测试 RecordPatch"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }
    fs.writeFileSync(outputPath, [
      "# Record: recover test",
      "",
      "- 对话ID：fake",
      "- 工作区：fake",
      "- 总轮次：4",
      "- 总步骤：6",
      "",
      \`## Phase 1：恢复测试（轮次 \${range.start}-\${Math.max(range.end, 4)})\`,
      "",
      "- 生成完整 Record",
      "",
      "<!-- TAGS: recover, record -->"
    ].join("\\n"), "utf-8");
    process.exit(0);
  });
  return;
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

function writeJsonl(filePath: string, events: any[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

function createRoundsEvents(rounds: number, assistantChars: number): any[] {
    const events: any[] = [];
    for (let index = 1; index <= rounds; index += 1) {
        events.push({
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `用户轮次 ${index}` }],
            },
        });
        events.push({
            type: "response_item",
            payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `助手轮次 ${index} ` + "A".repeat(assistantChars) }],
            },
        });
    }
    return events;
}

function createCodexThread(id: string, workspace: string, title: string, updatedAtMs: number, assistantChars: number): string {
    const rolloutPath = path.join(fakeSessionsDir, `rollout-2026-07-10T00-00-00-${id}.jsonl`);
    writeJsonl(rolloutPath, [
        {
            type: "session_meta",
            payload: {
                id,
                cwd: workspace,
                title,
                source: "codex",
                model: "gpt-test",
                reasoning_effort: "high",
            },
        },
        ...createRoundsEvents(3, assistantChars),
    ]);
    return rolloutPath;
}

function writeThreads(rows: Array<{ id: string; rolloutPath: string; cwd: string; title: string; updatedAtMs: number }>): void {
    const stateDb = path.join(fakeCodexHome, "state_5.sqlite");
    fs.mkdirSync(fakeCodexHome, { recursive: true });
    const script = `
import sqlite3, sys
db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.execute("drop table if exists threads")
conn.execute("drop table if exists thread_spawn_edges")
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
rows = ${JSON.stringify(rows)}
for row in rows:
    conn.execute(
        "insert into threads (id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms, updated_at, archived) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (row["id"], row["rolloutPath"], row["cwd"], row["title"], "codex", "gpt-test", "high", None, None, row["updatedAtMs"], "2026-07-10T00:00:00.000Z", 0)
    )
conn.commit()
conn.close()
`;
    execFileSync("python", ["-c", script, stateDb], {
        stdio: "inherit",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
}

function readTaskFile(taskId: string): any {
    return JSON.parse(fs.readFileSync(path.join(fakeDataRoot, "tasks", `${taskId}.json`), "utf-8"));
}

function readLedgerFile(resumeKey: string): any {
    return JSON.parse(fs.readFileSync(path.join(fakeDataRoot, "record-task-recovery", `record-batch-${resumeKey}.json`), "utf-8"));
}

function writeLedgerFile(resumeKey: string, ledger: unknown): void {
    const ledgerPath = path.join(fakeDataRoot, "record-task-recovery", `record-batch-${resumeKey}.json`);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf-8");
}

function recordBodyPath(hash: string, conversationId: string): string {
    return path.join(fakeDataRoot, "workspaces", hash, "records", `${conversationId}.md`);
}

function writeRecordBodyOnly(hash: string, conversationId: string, content: string): void {
    const filePath = recordBodyPath(hash, conversationId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
}

function recoveryMetadata(conversationId: string) {
    return {
        conversationId,
        title: `recover ${conversationId}`,
        timeSpan: "2026-07-11 00:00 ~ 2026-07-11 00:01",
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
        phases: 1,
        tags: ["recover", "ledger-v2"],
        chain: "codex",
    };
}

function extractTaskId(text: string): string {
    const match = text.match(/taskId:\s*(\S+)/u);
    assert.ok(match, `响应里应包含 taskId，实际输出：${text}`);
    return match[1];
}

const currentThreadId = "current-auto-thread";
const createBatchThreadA = "batch-create-a";
const createBatchThreadB = "batch-create-b";
const recoverSingleThreadId = "recover-single-thread";
const recoverBatchCompletedId = "recover-batch-completed";
const recoverBatchPendingId = "recover-batch-pending";
const recoverBodyOnlyId = "recover-batch-body-only";
const recoverIndexOnlyId = "recover-batch-index-only";
const recoverReaderFailureId = "recover-batch-reader-failure";
const recoverLegacyIndexedId = "recover-batch-legacy-indexed";
const recoverLegacyPendingId = "recover-batch-legacy-pending";

writeThreads([
    {
        id: currentThreadId,
        rolloutPath: createCodexThread(currentThreadId, fakeWorkspaceSingle, "current-auto", 9_000, 8_000),
        cwd: fakeWorkspaceSingle,
        title: "current-auto",
        updatedAtMs: 9_000,
    },
    {
        id: createBatchThreadA,
        rolloutPath: createCodexThread(createBatchThreadA, fakeWorkspaceBatchCreate, "batch-create-a", 8_000, 7_000),
        cwd: fakeWorkspaceBatchCreate,
        title: "batch-create-a",
        updatedAtMs: 8_000,
    },
    {
        id: createBatchThreadB,
        rolloutPath: createCodexThread(createBatchThreadB, fakeWorkspaceBatchCreate, "batch-create-b", 7_000, 7_000),
        cwd: fakeWorkspaceBatchCreate,
        title: "batch-create-b",
        updatedAtMs: 7_000,
    },
    {
        id: recoverSingleThreadId,
        rolloutPath: createCodexThread(recoverSingleThreadId, fakeWorkspaceSingle, "recover-single", 6_000, 7_000),
        cwd: fakeWorkspaceSingle,
        title: "recover-single",
        updatedAtMs: 6_000,
    },
    {
        id: recoverBatchCompletedId,
        rolloutPath: createCodexThread(recoverBatchCompletedId, fakeWorkspaceBatchRecover, "recover-batch-completed", 5_000, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-completed",
        updatedAtMs: 5_000,
    },
    {
        id: recoverBatchPendingId,
        rolloutPath: createCodexThread(recoverBatchPendingId, fakeWorkspaceBatchRecover, "recover-batch-pending", 4_000, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-pending",
        updatedAtMs: 4_000,
    },
    {
        id: recoverBodyOnlyId,
        rolloutPath: createCodexThread(recoverBodyOnlyId, fakeWorkspaceBatchRecover, "recover-batch-body-only", 3_000, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-body-only",
        updatedAtMs: 3_000,
    },
    {
        id: recoverIndexOnlyId,
        rolloutPath: createCodexThread(recoverIndexOnlyId, fakeWorkspaceBatchRecover, "recover-batch-index-only", 2_000, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-index-only",
        updatedAtMs: 2_000,
    },
    {
        id: recoverReaderFailureId,
        rolloutPath: createCodexThread(recoverReaderFailureId, fakeWorkspaceBatchRecover, "recover-batch-reader-failure", 1_750, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-reader-failure",
        updatedAtMs: 1_750,
    },
    {
        id: recoverLegacyIndexedId,
        rolloutPath: createCodexThread(recoverLegacyIndexedId, fakeWorkspaceBatchRecover, "recover-batch-legacy-indexed", 1_500, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-legacy-indexed",
        updatedAtMs: 1_500,
    },
    {
        id: recoverLegacyPendingId,
        rolloutPath: createCodexThread(recoverLegacyPendingId, fakeWorkspaceBatchRecover, "recover-batch-legacy-pending", 1_000, 7_000),
        cwd: fakeWorkspaceBatchRecover,
        title: "recover-batch-legacy-pending",
        updatedAtMs: 1_000,
    },
]);

process.chdir(fakeWorkspaceSingle);

const { __recordConcurrencyTest, registerRecord } = await import("../src/tools/record.ts");
const {
    __testWritePersistedTask,
    stableJsonHash,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");
const {
    readRecord,
    readRecordSidecar,
    readRecordsIndexAsync,
    resolveWorkspaceHashForRecord,
    writeRecord,
} = await import("../src/record-store.ts");

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>>();
const fakeServer = {
    tool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) {
        handlers.set(name, handler);
    },
};

registerRecord(fakeServer as never);
const recordManage = handlers.get("record_manage");
assert.ok(recordManage, "record_manage 应已注册");

const explicitWorkspacePayload = await __recordConcurrencyTest.buildUpdateResumePayload({
    workspaceHash: "general",
    conversationId: currentThreadId,
    workspace: fakeWorkspaceSingle,
    dataChain: "codex",
    modelChain: "codex",
});
assert.equal(
    explicitWorkspacePayload?.workspaceHash,
    resolveWorkspaceHashForRecord(fakeWorkspaceSingle),
    "显式 workspace 必须是 canonical workspaceHash 的权威来源，不能信任矛盾的内部 hash 参数",
);

const updateCreate = await recordManage!({
    action: "update",
    dataChain: "codex",
    modelChain: "codex",
    background: true,
});
const updateTaskId = extractTaskId(updateCreate.content[0].text);
const createdUpdateTask = readTaskFile(updateTaskId);
    assert.deepEqual(
        Object.keys(createdUpdateTask.resumePayload).sort(),
        ["conversationId", "dataChain", "kind", "modelChain", "workspaceHash"],
        "single update 应只写最小白名单 resumePayload",
    );
    assert.equal(createdUpdateTask.resumePayload.conversationId, currentThreadId, "single update 应冻结当前 conversationId");
    assert.equal(createdUpdateTask.resumePayload.dataChain, "codex", "single update 恢复链路应冻结为 resolved dataChain");
    assert.equal(createdUpdateTask.resumePayload.workspaceHash, resolveWorkspaceHashForRecord(fakeWorkspaceSingle), "single update 恢复链路必须冻结 canonical workspaceHash");
assert.equal(createdUpdateTask.resumeHash, stableJsonHash(createdUpdateTask.resumePayload));

const batchCreate = await recordManage!({
    action: "batch_update",
    dataChain: "codex",
    modelChain: "codex",
    workspace: fakeWorkspaceBatchCreate,
    force: true,
    limit: 2,
});
const batchTaskId = extractTaskId(batchCreate.content[0].text);
const createdBatchTask = readTaskFile(batchTaskId);
    assert.deepEqual(
        Object.keys(createdBatchTask.resumePayload).sort(),
        ["actionName", "dataChain", "force", "kind", "modelChain", "phase", "request", "resumeKey", "workspaceHash"],
        "batch update 初始任务应只写候选准备所需的最小白名单 resumePayload",
);
assert.equal(createdBatchTask.resumePayload.actionName, "batch_update");
assert.equal(createdBatchTask.resumePayload.dataChain, "codex");
assert.equal(createdBatchTask.resumePayload.modelChain, "codex");
    assert.equal(createdBatchTask.resumePayload.force, true);
    assert.equal(createdBatchTask.resumePayload.phase, "preparing");
    assert.equal(createdBatchTask.resumePayload.workspaceHash, resolveWorkspaceHashForRecord(fakeWorkspaceBatchCreate), "batch update 恢复链路必须冻结 canonical workspaceHash");
assert.deepEqual(createdBatchTask.resumePayload.request, {
    limit: 2,
    workspace: fakeWorkspaceBatchCreate,
});
assert.equal("candidates" in createdBatchTask.resumePayload, false, "公开入口不应在返回 taskId 前同步冻结候选");
assert.equal(createdBatchTask.resumeHash, stableJsonHash(createdBatchTask.resumePayload));

const [completedUpdateTask, completedBatchTask] = await Promise.all([
    waitForBackgroundTask(updateTaskId, 30),
    waitForBackgroundTask(batchTaskId, 30),
]);
assert.equal(completedUpdateTask?.status, "done", `single update 创建链路应完成：${completedUpdateTask?.error || "missing task"}`);
assert.equal(completedBatchTask?.status, "done", `batch update 创建链路应完成：${completedBatchTask?.error || "missing task"}`);

const createdLedger = readLedgerFile(createdBatchTask.resumePayload.resumeKey);
assert.equal(createdLedger.completed.length, 2);
assert.equal(createdLedger.skipped.length, 0);
assert.equal(createdLedger.failed.length, 0);
assert.equal(createdLedger.inFlight.length, 0);
assert.equal(createdLedger.candidates.length, 2);
    assert.ok(
        createdLedger.candidates.every((candidate: any) => (
            path.resolve(candidate.workspace).toLowerCase() === path.resolve(fakeWorkspaceBatchCreate).toLowerCase()
            && candidate.workspaceHash === createdBatchTask.resumePayload.workspaceHash
        )),
        "后台候选准备应冻结候选工作区路径与 canonical workspaceHash",
    );

const manualSinglePayload = {
    kind: "record-update" as const,
    conversationId: recoverSingleThreadId,
    dataChain: "codex" as const,
    modelChain: "codex" as const,
};
const manualSingleTaskId = "record-update-recover-single";
__testWritePersistedTask({
    id: manualSingleTaskId,
    kind: "record-update",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    ownerPid: 2_147_483_647,
    resumePayload: manualSinglePayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(manualSinglePayload),
});

const originalCompletedRecord = "# Record: keep completed\n\n- 保持不变\n";
const recoverBatchHash = resolveWorkspaceHashForRecord(fakeWorkspaceBatchRecover);
await writeRecord(recoverBatchHash, recoverBatchCompletedId, originalCompletedRecord, {
    title: "keep completed",
    totalRounds: 3,
    totalSteps: 6,
    lastUpdatedRound: 3,
    phases: 1,
    tags: ["keep"],
    chain: "codex",
});

const manualBatchPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "manual-batch-resume",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [
        { id: recoverBatchCompletedId, workspace: fakeWorkspaceBatchRecover },
        { id: recoverBatchPendingId, workspace: fakeWorkspaceBatchRecover },
    ],
};
const manualBatchLedgerPath = path.join(fakeDataRoot, "record-task-recovery", `record-batch-${manualBatchPayload.resumeKey}.json`);
fs.mkdirSync(path.dirname(manualBatchLedgerPath), { recursive: true });
fs.writeFileSync(manualBatchLedgerPath, JSON.stringify({
    version: 1,
    resumeKey: manualBatchPayload.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: manualBatchPayload.candidates,
    completed: [],
    inFlight: [{
        id: recoverBatchCompletedId,
        workspace: fakeWorkspaceBatchRecover,
        recordedAt: new Date().toISOString(),
        contentHash: crypto.createHash("sha256").update(originalCompletedRecord, "utf8").digest("hex"),
    }],
    skipped: [],
    failed: [],
}, null, 2), "utf-8");

const manualBatchTaskId = "record-batch-recover-pending-only";
__testWritePersistedTask({
    id: manualBatchTaskId,
    kind: "record-batch-update",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    ownerPid: 2_147_483_647,
    resumePayload: manualBatchPayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(manualBatchPayload),
});

const nonRecordTaskId = "golden-recover-not-record";
const nonRecordPayload = { version: 1, conversationId: "golden-conversation", dataChain: "codex", modelChain: "codex" };
__testWritePersistedTask({
    id: nonRecordTaskId,
    kind: "golden-extract",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    resumePayload: nonRecordPayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(nonRecordPayload),
});

const liveRecordTaskId = "record-update-live-owner";
__testWritePersistedTask({
    id: liveRecordTaskId,
    kind: "record-update",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxRunMs: 60_000,
    ownerPid: process.pid,
    resumePayload: manualSinglePayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(manualSinglePayload),
});

const preparingBatchPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "manual-batch-preparing-without-ledger",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    phase: "preparing" as const,
    request: {
        workspace: fakeWorkspaceBatchCreate,
        limit: 1,
    },
};
const preparingBatchTaskId = "record-batch-recover-preparing-without-ledger";
__testWritePersistedTask({
    id: preparingBatchTaskId,
    kind: "record-batch-update",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    ownerPid: 2_147_483_647,
    resumePayload: preparingBatchPayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(preparingBatchPayload),
});

const recoverList = await recordManage!({ action: "recover" });
const recoverListText = recoverList.content[0].text;
assert.doesNotMatch(recoverListText, new RegExp(manualSingleTaskId), "缺少 scheduler admission 的 legacy single task 不得列为可自动恢复");
assert.doesNotMatch(recoverListText, new RegExp(manualBatchTaskId), "缺少 scheduler admission 的 legacy batch task 不得列为可自动恢复");
assert.doesNotMatch(recoverListText, new RegExp(preparingBatchTaskId), "未冻结 scheduler admission 的 preparing task 不得重扫来源");
assert.doesNotMatch(recoverListText, new RegExp(nonRecordTaskId));
assert.doesNotMatch(recoverListText, new RegExp(liveRecordTaskId), "仍由存活进程持有的 Record 任务不应列为可恢复");

const nonRecordRecover = await recordManage!({ action: "recover", taskId: nonRecordTaskId });
assert.match(nonRecordRecover.content[0].text, /仅恢复 Record 任务/u);

const singleRecover = await recordManage!({ action: "recover", taskId: manualSingleTaskId });
assert.match(singleRecover.content[0].text, /恢复失败|缺少 schedulerAdmission|迁移.*RepairRequired/u);
assert.equal(readTaskFile(manualSingleTaskId).status, "error", "legacy single task 必须在原 envelope 上持久化为 error");
assert.deepEqual(readTaskFile(manualSingleTaskId).resumePayload, manualSinglePayload, "legacy single 取证 payload 不得丢失");
assert.equal(readRecord(resolveWorkspaceHashForRecord(fakeWorkspaceSingle), recoverSingleThreadId), null, "legacy single 不得重跑 generate/write");

const batchRecover = await recordManage!({ action: "recover", taskId: manualBatchTaskId });
assert.match(batchRecover.content[0].text, /恢复失败|缺少 schedulerAdmission|迁移.*RepairRequired/u);
assert.equal(readTaskFile(manualBatchTaskId).status, "error", "legacy batch task 必须停在原 envelope 供迁移取证");
assert.deepEqual(readTaskFile(manualBatchTaskId).resumePayload, manualBatchPayload, "legacy batch 的候选与 resumeKey 证据不得丢失");
assert.equal(readRecord(recoverBatchHash, recoverBatchCompletedId), originalCompletedRecord, "legacy batch 拒绝恢复时已完成正文必须保持不变");
assert.equal(readRecord(recoverBatchHash, recoverBatchPendingId), null, "legacy batch 不得自动补跑 pending 候选");
assert.equal(readLedgerFile(manualBatchPayload.resumeKey).inFlight.length, 1, "legacy ledger 必须保留原 in-flight 供人工修复");

const preparingBatchRecover = await recordManage!({ action: "recover", taskId: preparingBatchTaskId });
assert.match(preparingBatchRecover.content[0].text, /恢复失败|缺少 schedulerAdmission|迁移.*RepairRequired/u);
assert.equal(readTaskFile(preparingBatchTaskId).status, "error", "legacy preparing task 不得重扫实时候选");
assert.equal(fs.existsSync(path.join(fakeDataRoot, "record-task-recovery", `record-batch-${preparingBatchPayload.resumeKey}.json`)), false);

const bodyOnlyPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "recover-after-body-only",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [{ id: recoverBodyOnlyId, workspace: fakeWorkspaceBatchRecover }],
};
let bodyOnlyFailureInjected = false;
__recordConcurrencyTest.setPersistenceHook(async event => {
    if (event.stage === "after_record_body" && event.conversationId === recoverBodyOnlyId) {
        bodyOnlyFailureInjected = true;
        throw new Error("forced crash after Record body");
    }
});
try {
    await __recordConcurrencyTest.runBatchUpdate(bodyOnlyPayload);
} finally {
    __recordConcurrencyTest.setPersistenceHook(null);
}
assert.equal(bodyOnlyFailureInjected, true, "测试必须在正文写入后、主索引写入前注入故障");
const bodyOnlyLedgerBeforeRecover = readLedgerFile(bodyOnlyPayload.resumeKey);
const bodyOnlyInFlightMetadata = bodyOnlyLedgerBeforeRecover.inFlight[0]?.metadata;
assert.equal(bodyOnlyLedgerBeforeRecover.inFlight.length, 1);
assert.equal(bodyOnlyLedgerBeforeRecover.inFlight[0].isNew, true, "正文阶段故障前 in-flight 必须持久新建归因");
assert.ok(bodyOnlyInFlightMetadata, "正文阶段故障前 in-flight 必须持久恢复 metadata");
assert.ok(readRecord(recoverBatchHash, recoverBodyOnlyId), "正文必须已写入");
assert.equal((await readRecordsIndexAsync(recoverBatchHash)).records[recoverBodyOnlyId], undefined, "主索引在注入点前不得出现");
assert.equal(readRecordSidecar(recoverBatchHash, recoverBodyOnlyId, "record_index.json"), null, "Reader Index 在注入点前不得出现");

await __recordConcurrencyTest.runBatchUpdate(bodyOnlyPayload);
const bodyOnlyLedgerAfterRecover = readLedgerFile(bodyOnlyPayload.resumeKey);
const bodyOnlyReaderIndex = readRecordSidecar<any>(recoverBatchHash, recoverBodyOnlyId, "record_index.json");
assert.equal(bodyOnlyLedgerAfterRecover.inFlight.length, 0);
assert.equal(bodyOnlyLedgerAfterRecover.completed.length, 1);
assert.equal(bodyOnlyLedgerAfterRecover.completed[0].isNew, true, "completed 必须继承 in-flight 的新建归因");
assert.ok(readRecord(recoverBatchHash, recoverBodyOnlyId), "恢复后正文必须保留");
const bodyOnlyRecoveredIndex = (await readRecordsIndexAsync(recoverBatchHash)).records[recoverBodyOnlyId];
assert.equal(bodyOnlyRecoveredIndex?.title, bodyOnlyInFlightMetadata.title, "恢复必须用 in-flight metadata 补齐主索引");
assert.equal(bodyOnlyRecoveredIndex?.lastUpdatedRound, bodyOnlyInFlightMetadata.lastUpdatedRound, "恢复不得丢失 in-flight 覆盖轮次");
assert.equal(bodyOnlyReaderIndex?.recordId, recoverBodyOnlyId, "恢复必须补齐匹配正文的 Reader Index");
assert.equal(bodyOnlyReaderIndex?.sourceSizeBytes, Buffer.byteLength(readRecord(recoverBatchHash, recoverBodyOnlyId) || "", "utf8"), "Reader Index 必须对应恢复后的正文");

const indexOnlyPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "recover-after-index-only",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [{ id: recoverIndexOnlyId, workspace: fakeWorkspaceBatchRecover }],
};
let indexOnlyFailureInjected = false;
__recordConcurrencyTest.setPersistenceHook(async event => {
    if (event.stage === "after_record_index" && event.conversationId === recoverIndexOnlyId) {
        indexOnlyFailureInjected = true;
        throw new Error("forced crash after Record index");
    }
});
try {
    await __recordConcurrencyTest.runBatchUpdate(indexOnlyPayload);
} finally {
    __recordConcurrencyTest.setPersistenceHook(null);
}
assert.equal(indexOnlyFailureInjected, true, "测试必须在主索引写入后、Reader Index 写入前注入故障");
const indexOnlyLedgerBeforeRecover = readLedgerFile(indexOnlyPayload.resumeKey);
const indexOnlyInFlightMetadata = indexOnlyLedgerBeforeRecover.inFlight[0]?.metadata;
assert.equal(indexOnlyLedgerBeforeRecover.inFlight.length, 1);
assert.ok(indexOnlyInFlightMetadata, "主索引阶段故障前 in-flight 必须持久恢复 metadata");
assert.ok(readRecord(recoverBatchHash, recoverIndexOnlyId), "正文必须已写入");
assert.equal((await readRecordsIndexAsync(recoverBatchHash)).records[recoverIndexOnlyId]?.title, indexOnlyInFlightMetadata.title, "主索引必须已使用 in-flight metadata 写入");
assert.equal(readRecordSidecar(recoverBatchHash, recoverIndexOnlyId, "record_index.json"), null, "Reader Index 在注入点前不得出现");

await __recordConcurrencyTest.runBatchUpdate(indexOnlyPayload);
const indexOnlyLedgerAfterRecover = readLedgerFile(indexOnlyPayload.resumeKey);
const indexOnlyReaderIndex = readRecordSidecar<any>(recoverBatchHash, recoverIndexOnlyId, "record_index.json");
assert.equal(indexOnlyLedgerAfterRecover.inFlight.length, 0);
assert.equal(indexOnlyLedgerAfterRecover.completed.length, 1);
assert.equal(indexOnlyLedgerAfterRecover.completed[0].isNew, true, "主索引已写入后的恢复也必须保留新建归因");
assert.ok(readRecord(recoverBatchHash, recoverIndexOnlyId), "恢复后正文必须保留");
assert.equal((await readRecordsIndexAsync(recoverBatchHash)).records[recoverIndexOnlyId]?.lastUpdatedRound, indexOnlyInFlightMetadata.lastUpdatedRound, "恢复后主索引必须保留 in-flight metadata");
assert.equal(indexOnlyReaderIndex?.recordId, recoverIndexOnlyId, "恢复必须补齐 Reader Index");
assert.equal(indexOnlyReaderIndex?.sourceSizeBytes, Buffer.byteLength(readRecord(recoverBatchHash, recoverIndexOnlyId) || "", "utf8"), "Reader Index 必须对应主索引已写入时的正文");

const readerFailurePayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "recover-after-reader-failure",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [{ id: recoverReaderFailureId, workspace: fakeWorkspaceBatchRecover }],
};
let readerFailureInjected = false;
__recordConcurrencyTest.setPersistenceHook(async event => {
    if (event.stage === "before_reader_index" && event.conversationId === recoverReaderFailureId) {
        readerFailureInjected = true;
        throw new Error("forced Reader Index write failure");
    }
});
try {
    await __recordConcurrencyTest.runBatchUpdate(readerFailurePayload);
} finally {
    __recordConcurrencyTest.setPersistenceHook(null);
}
assert.equal(readerFailureInjected, true, "测试必须进入 Reader Index 的实际写入错误路径");
const readerFailureLedgerBeforeRecover = readLedgerFile(readerFailurePayload.resumeKey);
assert.equal(readerFailureLedgerBeforeRecover.inFlight.length, 1, "Reader Index 写失败后必须保留 in-flight");
assert.equal(readerFailureLedgerBeforeRecover.completed.length, 0, "Reader Index 写失败时禁止提前 completed");
assert.ok(readRecord(recoverBatchHash, recoverReaderFailureId), "Reader Index 失败前正文必须已写入");
assert.ok((await readRecordsIndexAsync(recoverBatchHash)).records[recoverReaderFailureId], "Reader Index 失败前主索引必须已写入");
assert.equal(readRecordSidecar(recoverBatchHash, recoverReaderFailureId, "record_index.json"), null, "Reader Index 写失败后不能留下成功 sidecar");

await __recordConcurrencyTest.runBatchUpdate(readerFailurePayload);
const readerFailureLedgerAfterRecover = readLedgerFile(readerFailurePayload.resumeKey);
const recoveredReaderFailureIndex = readRecordSidecar<any>(recoverBatchHash, recoverReaderFailureId, "record_index.json");
assert.equal(readerFailureLedgerAfterRecover.inFlight.length, 0);
assert.equal(readerFailureLedgerAfterRecover.completed.length, 1, "Reader Index 补齐后才能 completed");
assert.equal(readerFailureLedgerAfterRecover.completed[0].isNew, true, "恢复完成必须保留原 in-flight 归因");
assert.equal(recoveredReaderFailureIndex?.recordId, recoverReaderFailureId, "恢复必须补齐 Reader Index sidecar");

const legacyIndexedContent = "# Record: legacy indexed\n\n- keep body\n";
await writeRecord(recoverBatchHash, recoverLegacyIndexedId, legacyIndexedContent, recoveryMetadata(recoverLegacyIndexedId));
const legacyIndexedPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "recover-v1-inflight-indexed",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [{ id: recoverLegacyIndexedId, workspace: fakeWorkspaceBatchRecover }],
};
writeLedgerFile(legacyIndexedPayload.resumeKey, {
    version: 1,
    resumeKey: legacyIndexedPayload.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: legacyIndexedPayload.candidates,
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [{
        id: recoverLegacyIndexedId,
        workspace: fakeWorkspaceBatchRecover,
        recordedAt: new Date().toISOString(),
        contentHash: crypto.createHash("sha256").update(legacyIndexedContent, "utf8").digest("hex"),
    }],
});
const legacyIndexedTaskId = "record-batch-recover-v1-inflight-indexed";
__testWritePersistedTask({
    id: legacyIndexedTaskId,
    kind: "record-batch-update",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    ownerPid: 2_147_483_647,
    resumePayload: legacyIndexedPayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(legacyIndexedPayload),
});
const legacyIndexedRecover = await recordManage!({ action: "recover", taskId: legacyIndexedTaskId });
assert.match(legacyIndexedRecover.content[0].text, /恢复失败|缺少 schedulerAdmission|迁移.*RepairRequired/u);
assert.equal(readTaskFile(legacyIndexedTaskId).status, "error");
const legacyIndexedLedger = readLedgerFile(legacyIndexedPayload.resumeKey);
assert.equal(legacyIndexedLedger.version, 1, "没有 scheduler admission 的 v1 ledger 不得自动迁移");
assert.equal(legacyIndexedLedger.inFlight.length, 1, "legacy in-flight 证据必须保留");
assert.equal(legacyIndexedLedger.completed.length, 0);
assert.equal(readRecord(recoverBatchHash, recoverLegacyIndexedId), legacyIndexedContent, "legacy 拒绝恢复时不得重写正文");

const legacyPendingContent = "# Record: legacy pending\n\n- body without index\n";
writeRecordBodyOnly(recoverBatchHash, recoverLegacyPendingId, legacyPendingContent);
const legacyPendingPayload = {
    kind: "record-batch-update" as const,
    actionName: "batch_update" as const,
    resumeKey: "recover-v1-inflight-pending",
    dataChain: "codex" as const,
    modelChain: "codex" as const,
    force: true,
    candidates: [{ id: recoverLegacyPendingId, workspace: fakeWorkspaceBatchRecover }],
};
writeLedgerFile(legacyPendingPayload.resumeKey, {
    version: 1,
    resumeKey: legacyPendingPayload.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: legacyPendingPayload.candidates,
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [{
        id: recoverLegacyPendingId,
        workspace: fakeWorkspaceBatchRecover,
        recordedAt: new Date().toISOString(),
        contentHash: crypto.createHash("sha256").update(legacyPendingContent, "utf8").digest("hex"),
    }],
});
const legacyPendingTaskId = "record-batch-recover-v1-inflight-pending";
__testWritePersistedTask({
    id: legacyPendingTaskId,
    kind: "record-batch-update",
    status: "running",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    maxRunMs: 60_000,
    ownerPid: 2_147_483_647,
    resumePayload: legacyPendingPayload,
    resumeVersion: 1,
    resumeHash: stableJsonHash(legacyPendingPayload),
});
const legacyPendingRecover = await recordManage!({ action: "recover", taskId: legacyPendingTaskId });
assert.match(legacyPendingRecover.content[0].text, /恢复失败|缺少 schedulerAdmission|迁移.*RepairRequired/u);
assert.equal(readTaskFile(legacyPendingTaskId).status, "error");
const legacyPendingLedger = readLedgerFile(legacyPendingPayload.resumeKey);
assert.equal(legacyPendingLedger.inFlight.length, 1, "缺主索引的 legacy in-flight 不得被猜测成 pending");
assert.equal(legacyPendingLedger.completed.length, 0);
assert.equal(readRecord(recoverBatchHash, recoverLegacyPendingId), legacyPendingContent, "legacy 拒绝恢复时原始正文证据必须保留");
assert.equal((await readRecordsIndexAsync(recoverBatchHash)).records[recoverLegacyPendingId], undefined);
assert.equal(readRecordSidecar<any>(recoverBatchHash, recoverLegacyPendingId, "record_index.json"), null);

console.log("✅ recover-record tests passed");
