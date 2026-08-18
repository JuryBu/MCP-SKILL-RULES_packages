import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cancel-record-"));
const fakeHome = path.join(tempRoot, "home");
const fakeCodexHome = path.join(fakeHome, ".codex");
const fakeSessionsDir = path.join(fakeCodexHome, "sessions");
const fakeDataRoot = path.join(tempRoot, "data");
const fakeWorkspaceSingle = path.join(tempRoot, "workspace-single");
const fakeWorkspaceBatch = path.join(tempRoot, "workspace-batch");
const fakeCodexJs = path.join(tempRoot, "fake-codex.js");
const fakeCodexCmd = path.join(tempRoot, "fake-codex.cmd");
const execCountFile = path.join(tempRoot, "codex-exec-count.txt");
const blockStartedFile = path.join(tempRoot, "codex-block-started.txt");
const blockReleaseFile = path.join(tempRoot, "codex-block-release.txt");

fs.mkdirSync(fakeSessionsDir, { recursive: true });
fs.mkdirSync(fakeWorkspaceSingle, { recursive: true });
fs.mkdirSync(fakeWorkspaceBatch, { recursive: true });

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
process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "2";
process.env.MEMORY_STORE_RECORD_BATCH_CONCURRENCY = "1";
process.env.FAKE_CODEX_EXEC_COUNT_FILE = execCountFile;
process.env.FAKE_CODEX_BLOCK_STARTED_FILE = blockStartedFile;
process.env.FAKE_CODEX_BLOCK_RELEASE_FILE = blockReleaseFile;

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

function readCount(file) {
  return file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf-8")) : 0;
}

function writeCount(file, value) {
  if (file) fs.writeFileSync(file, String(value), "utf-8");
}

function parseRoundRange(input) {
  const matches = Array.from(input.matchAll(/轮次[^\\d]*(\\d+)\\s*[-~–—－]\\s*(\\d+)/gu));
  if (matches.length === 0) return { start: 1, end: 3 };
  const last = matches[matches.length - 1];
  return { start: Number(last[1]), end: Number(last[2]) };
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", async () => {
    const countFile = process.env.FAKE_CODEX_EXEC_COUNT_FILE;
    const next = readCount(countFile) + 1;
    writeCount(countFile, next);

    const sleepCalls = String(process.env.FAKE_CODEX_SLEEP_CALLS || "")
      .split(",")
      .map(item => Number(item.trim()))
      .filter(item => Number.isFinite(item) && item > 0);
    const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || "0");
    if (sleepMs > 0 && sleepCalls.includes(next)) {
      await new Promise(resolve => setTimeout(resolve, sleepMs));
    }

    const blockCalls = String(process.env.FAKE_CODEX_BLOCK_CALLS || "")
      .split(",")
      .map(item => Number(item.trim()))
      .filter(item => Number.isFinite(item) && item > 0);
    if (blockCalls.includes(next)) {
      const startedFile = process.env.FAKE_CODEX_BLOCK_STARTED_FILE;
      const releaseFile = process.env.FAKE_CODEX_BLOCK_RELEASE_FILE;
      if (startedFile) fs.appendFileSync(startedFile, String(next) + "\\n", "utf-8");
      while (releaseFile && !fs.existsSync(releaseFile)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    if (input.includes("请输出 Record 的结构化增量")) {
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          rewriteStartRound: 1,
          rewriteEndRound: 3,
          phaseMarkdown: [
            "## Phase 1：取消前已保留区段（轮次 1-3)",
            "",
            "- 这是 Local Compose 的测试输出",
            "- 保留已完成 patch"
          ].join("\\n"),
          tailMarkdown: [
            "# 产出文件总清单",
            "",
            "- src/cancel-record.ts",
            "",
            "# 经验教训",
            "",
            "- cancel 之后不写半成品"
          ].join("\\n"),
          tags: ["cancel", "record"],
          warnings: []
        }),
        "\`\`\`"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }

    if (input.includes("请把指定轮次区段整理为 RecordPatch 草稿")) {
      const range = parseRoundRange(input);
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound: range.start,
          endRound: range.end,
          title: "取消测试区段",
          files: ["src/cancel-record.ts"],
          tags: ["cancel"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- patch body"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }

    const range = parseRoundRange(input);
    fs.writeFileSync(outputPath, [
      "# Record: cancel test",
      "",
      "- 对话ID：\`fake\`",
      "- 工作区：\`fake\`",
      "- 总轮次：3",
      "- 总步骤：6",
      "",
      \`## Phase 1：批量取消验证（轮次 \${range.start}-\${Math.max(range.end, 3)})\`,
      "",
      "- 生成完整 Record",
      "",
      "<!-- TAGS: cancel, record -->"
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
rows = [
${rows.map(row => `    (${JSON.stringify(row.id)}, ${JSON.stringify(row.rolloutPath)}, ${JSON.stringify(row.cwd)}, ${JSON.stringify(row.title)}, "codex", "gpt-test", "high", None, None, ${row.updatedAtMs}, ${JSON.stringify(new Date(row.updatedAtMs).toISOString())}, 0)`).join(",\n")}
]
conn.executemany("insert into threads (id, rollout_path, cwd, title, source, model, reasoning_effort, agent_nickname, agent_role, updated_at_ms, updated_at, archived) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
conn.commit()
conn.close()
`;
    execFileSync("python", ["-c", script, stateDb], {
        stdio: "inherit",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
}

function textOf(result: any): string {
    return (result?.content || []).map((item: any) => item?.text || "").join("\n");
}

function extractTaskId(text: string): string {
    const match = text.match(/taskId:\s*([^\s]+)/u);
    assert.ok(match, `missing taskId in response: ${text}`);
    return match[1];
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`timeout waiting for ${label}`);
}

function resetExecCounter(): void {
    fs.rmSync(execCountFile, { force: true });
}

function readExecCount(): number {
    return fs.existsSync(execCountFile) ? Number(fs.readFileSync(execCountFile, "utf-8")) : 0;
}

const {
    registerRecord,
} = await import("../src/tools/record.ts");
const { getRecordSchedulerRuntime } = await import("../src/record-scheduler-runtime.ts");
const { recordPatchCheckpointDir } = await import("../src/record-checkpoint.ts");
const {
    readRecord,
    resolveWorkspaceHashForRecord,
} = await import("../src/record-store.ts");

const toolRegistry = new Map<string, (args: any) => Promise<any>>();
registerRecord({
    tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
        toolRegistry.set(name, handler);
    },
} as any);

const recordManage = toolRegistry.get("record_manage");
assert.ok(recordManage, "record_manage should be registered");

const singleConversationId = "11111111-1111-4111-8111-111111111111";
const batchConversationIds = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
];

writeThreads([
    {
        id: singleConversationId,
        rolloutPath: createCodexThread(singleConversationId, fakeWorkspaceSingle, "single-cancel", 3000, 7000),
        cwd: fakeWorkspaceSingle,
        title: "single-cancel",
        updatedAtMs: 3000,
    },
    ...batchConversationIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, fakeWorkspaceBatch, `batch-${index + 1}`, 2000 - index * 100, 200),
        cwd: fakeWorkspaceBatch,
        title: `batch-${index + 1}`,
        updatedAtMs: 2000 - index * 100,
    })),
]);

try {
    resetExecCounter();
    fs.rmSync(blockStartedFile, { force: true });
    fs.rmSync(blockReleaseFile, { force: true });
    process.env.FAKE_CODEX_SLEEP_CALLS = "";
    process.env.FAKE_CODEX_SLEEP_MS = "0";
    process.env.FAKE_CODEX_BLOCK_CALLS = "2,3,4";

    const singleResponse = await recordManage!({
        action: "update",
        conversationId: singleConversationId,
        dataChain: "codex",
        modelChain: "codex",
        background: true,
        parallelMode: "force",
    });
    const singleTaskId = extractTaskId(textOf(singleResponse));
    const singleCheckpointDir = recordPatchCheckpointDir(singleConversationId);
    await waitFor(
        () => fs.existsSync(singleCheckpointDir) && fs.readdirSync(singleCheckpointDir).filter(name => name.endsWith(".json")).length >= 1,
        15_000,
        "single update first checkpoint",
    );
    const cancelledSingle = textOf(await recordManage!({ action: "cancel", taskId: singleTaskId }));
    assert.match(cancelledSingle, /Record scheduler cancel: (?:cancelling|cancelled)/u);
    const singleTask = await getRecordSchedulerRuntime().waitForTerminal(singleTaskId, 10);
    assert.equal(singleTask?.state, "Cancelled", singleTask?.reason);

    const singleCheckpointFiles = fs.readdirSync(singleCheckpointDir).filter(name => name.endsWith(".json"));
    assert.equal(singleCheckpointFiles.length, 1, "cancelled single update should keep only completed checkpoint");
    const singleHash = resolveWorkspaceHashForRecord(fakeWorkspaceSingle);
    assert.equal(readRecord(singleHash, singleConversationId), null, "cancelled single update must not write final Record");
    assert.ok(readExecCount() <= 2, "single update should stop before launching more model calls after cancellation");

    resetExecCounter();
    process.env.FAKE_CODEX_SLEEP_CALLS = "2";
    process.env.FAKE_CODEX_SLEEP_MS = "1200";

    const batchResponse = await recordManage!({
        action: "batch_update",
        dataChain: "codex",
        modelChain: "codex",
        workspace: fakeWorkspaceBatch,
        limit: 4,
    });
    const batchTaskId = extractTaskId(textOf(batchResponse));
    const batchHash = resolveWorkspaceHashForRecord(fakeWorkspaceBatch);
    await waitFor(() => fs.existsSync(blockStartedFile), 15_000, "batch update blocked provider call");
    await waitFor(
        () => batchConversationIds.filter(id => Boolean(readRecord(batchHash, id))).length === 1,
        15_000,
        "batch update first Task-owned Record",
    );
    const callsAtCancellation = readExecCount();
    const cancelledBatch = textOf(await recordManage!({ action: "cancel", taskId: batchTaskId }));
    assert.match(cancelledBatch, /Record scheduler cancel: (?:cancelling|cancelled)/u);
    fs.writeFileSync(blockReleaseFile, "release", "utf8");
    const batchTask = await getRecordSchedulerRuntime().waitForTerminal(batchTaskId, 10);
    assert.equal(batchTask?.state, "Cancelled", batchTask?.reason);

    const writtenBatchRecords = batchConversationIds.filter(id => Boolean(readRecord(batchHash, id)));
    assert.equal(writtenBatchRecords.length, 0, "batch_update cancel should conditionally compensate Task-owned Records");
    assert.equal(readExecCount(), callsAtCancellation, "batch_update cancel should let in-flight calls finish without starting later conversations");

    console.log("✅ cancel-record tests passed");
} finally {
    fs.writeFileSync(blockReleaseFile, "release", "utf8");
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
