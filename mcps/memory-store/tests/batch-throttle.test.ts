import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-batch-throttle-"));
const fakeHome = path.join(tempRoot, "home");
const fakeCodexHome = path.join(fakeHome, ".codex");
const fakeSessionsDir = path.join(fakeCodexHome, "sessions");
const fakeDataRoot = path.join(tempRoot, "data");
const fakeCodexJs = path.join(tempRoot, "fake-codex.js");
const fakeCodexCmd = path.join(tempRoot, "fake-codex.cmd");
const fakeCallCountFile = path.join(tempRoot, "fake-codex-call-count.txt");
const fakeActiveCountFile = path.join(tempRoot, "fake-codex-active-count.txt");
const fakePeakCountFile = path.join(tempRoot, "fake-codex-peak-count.txt");

const workspaceSingle = path.join(tempRoot, "workspace-single");
const workspaceBatchFill = path.join(tempRoot, "workspace-batch-fill");
const workspaceBatchA = path.join(tempRoot, "workspace-batch-a");
const workspaceBatchB = path.join(tempRoot, "workspace-batch-b");
const workspaceBatchC = path.join(tempRoot, "workspace-batch-c");
const workspaceBatchD = path.join(tempRoot, "workspace-batch-d");

for (const dir of [
    fakeSessionsDir,
    workspaceSingle,
    workspaceBatchFill,
    workspaceBatchA,
    workspaceBatchB,
    workspaceBatchC,
    workspaceBatchD,
]) {
    fs.mkdirSync(dir, { recursive: true });
}

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = path.parse(fakeHome).root.replace(/\\$/, "") || "C:";
process.env.HOMEPATH = fakeHome.slice(process.env.HOMEDRIVE.length) || "\\";
process.env.MEMORY_STORE_DATA_ROOT = fakeDataRoot;
process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "15000";
process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT = "15000";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_RECORD_PARALLEL_MODE = "off";
process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES = "0";
process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = "999999";
process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS = "20";
process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT = "99";
process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY = "4";
process.env.FAKE_CODEX_CALL_COUNT_FILE = fakeCallCountFile;
process.env.FAKE_CODEX_ACTIVE_COUNT_FILE = fakeActiveCountFile;
process.env.FAKE_CODEX_PEAK_COUNT_FILE = fakePeakCountFile;

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

function readCount(file) {
  return file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf-8") || "0") : 0;
}

function writeCount(file, value) {
  if (file) fs.writeFileSync(file, String(value), "utf-8");
}

function parseFailCalls(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map(item => Number(item.trim()))
      .filter(item => Number.isFinite(item) && item > 0)
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", async () => {
    const callFile = process.env.FAKE_CODEX_CALL_COUNT_FILE;
    const activeFile = process.env.FAKE_CODEX_ACTIVE_COUNT_FILE;
    const peakFile = process.env.FAKE_CODEX_PEAK_COUNT_FILE;
    const callNo = readCount(callFile) + 1;
    writeCount(callFile, callNo);
    const activeNow = readCount(activeFile) + 1;
    writeCount(activeFile, activeNow);
    writeCount(peakFile, Math.max(readCount(peakFile), activeNow));

    const finish = (code, errorMessage) => {
      const activeLeft = Math.max(0, readCount(activeFile) - 1);
      writeCount(activeFile, activeLeft);
      if (errorMessage) console.error(errorMessage);
      process.exit(code);
    };

    try {
      const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || "0");
      if (sleepMs > 0) await delay(sleepMs);
      const failCalls = parseFailCalls(process.env.FAKE_CODEX_FAIL_CALLS);
      if (failCalls.has(callNo)) {
        finish(1, "forced fake codex failure");
        return;
      }
      if (input.includes("RecordPatch")) {
        fs.writeFileSync(outputPath, [
          "\`\`\`json",
          JSON.stringify({
            startRound: 1,
            endRound: 4,
            title: "并发验证区段",
            files: [],
            tags: ["throttle", "record"],
            risks: [],
            status: "ok"
          }),
          "\`\`\`",
          "",
          "## Phase Draft",
          "",
          "- 生成并发验证 RecordPatch"
        ].join("\\n"), "utf-8");
        finish(0);
        return;
      }
      fs.writeFileSync(outputPath, [
        "# Record: batch throttle test",
        "",
        "- 对话ID：fake",
        "- 工作区：fake",
        "- 总轮次：4",
        "- 总步骤：6",
        "",
        "## Phase 1：并发验证（轮次 1-4)",
        "",
        "- 生成完整 Record",
        "",
        "<!-- TAGS: throttle, record -->"
      ].join("\\n"), "utf-8");
      finish(0);
    } catch (error) {
      finish(1, error instanceof Error ? error.message : String(error));
    }
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

function createCodexThread(id: string, workspace: string, title: string, updatedAtMs: number, assistantChars = 600): string {
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
    const python = `
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
    execFileSync("python", ["-c", python, stateDb], {
        stdio: "inherit",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
}

const singleThreadIds = ["single-a", "single-b", "single-c", "single-d"];
const fillThreadIds = Array.from({ length: 12 }, (_, index) => `fill-${index + 1}`);
const batchAThreadIds = Array.from({ length: 4 }, (_, index) => `batch-a-${index + 1}`);
const batchBThreadIds = Array.from({ length: 4 }, (_, index) => `batch-b-${index + 1}`);
const batchCThreadIds = Array.from({ length: 4 }, (_, index) => `batch-c-${index + 1}`);
const batchDThreadIds = Array.from({ length: 4 }, (_, index) => `batch-d-${index + 1}`);

const threadRows = [
    ...singleThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceSingle, id, 9_000 - index * 100),
        cwd: workspaceSingle,
        title: id,
        updatedAtMs: 9_000 - index * 100,
    })),
    ...fillThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceBatchFill, id, 8_000 - index * 10),
        cwd: workspaceBatchFill,
        title: id,
        updatedAtMs: 8_000 - index * 10,
    })),
    ...batchAThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceBatchA, id, 7_000 - index * 10),
        cwd: workspaceBatchA,
        title: id,
        updatedAtMs: 7_000 - index * 10,
    })),
    ...batchBThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceBatchB, id, 6_000 - index * 10),
        cwd: workspaceBatchB,
        title: id,
        updatedAtMs: 6_000 - index * 10,
    })),
    ...batchCThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceBatchC, id, 5_000 - index * 10),
        cwd: workspaceBatchC,
        title: id,
        updatedAtMs: 5_000 - index * 10,
    })),
    ...batchDThreadIds.map((id, index) => ({
        id,
        rolloutPath: createCodexThread(id, workspaceBatchD, id, 4_000 - index * 10),
        cwd: workspaceBatchD,
        title: id,
        updatedAtMs: 4_000 - index * 10,
    })),
];

writeThreads(threadRows);
process.chdir(workspaceSingle);

const { __recordConcurrencyTest, registerRecord } = await import("../src/tools/record.ts");
const { __recordGenerationConcurrencyTest } = await import("../src/record-generator.ts");
const { readRecordsIndexAsync, resolveWorkspaceHashForRecord } = await import("../src/record-store.ts");
const { getBackgroundTask } = await import("../src/background-tasks.ts");

type ToolResponse = { content?: Array<{ text?: string }> };
type RecordManageHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

let recordManageHandler: RecordManageHandler | null = null;
registerRecord({
    tool(name: string, _description: string, _schema: unknown, handler: RecordManageHandler) {
        if (name === "record_manage") recordManageHandler = handler;
    },
} as never);
assert.ok(recordManageHandler, "record_manage public handler should be registered");

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await sleep(20);
    }
    throw new Error(`waitFor timed out: ${label}`);
}

function readCount(filePath: string): number {
    return fs.existsSync(filePath) ? Number(fs.readFileSync(filePath, "utf-8") || "0") : 0;
}

function resetFakeCodexCounters(): void {
    fs.writeFileSync(fakeCallCountFile, "0", "utf-8");
    fs.writeFileSync(fakeActiveCountFile, "0", "utf-8");
    fs.writeFileSync(fakePeakCountFile, "0", "utf-8");
}

function resetSharedPool(shared: number, batch?: number, generation = 8): void {
    process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = String(shared);
    if (batch === undefined) {
        delete process.env.MEMORY_STORE_RECORD_BATCH_CONCURRENCY;
    } else {
        process.env.MEMORY_STORE_RECORD_BATCH_CONCURRENCY = String(batch);
    }
    process.env.MEMORY_STORE_RECORD_GENERATION_CONCURRENCY = String(generation);
    process.env.FAKE_CODEX_FAIL_CALLS = "";
    __recordConcurrencyTest.resetPeak();
    __recordGenerationConcurrencyTest.resetPeak();
    __recordConcurrencyTest.setPersistenceHook(null);
    resetFakeCodexCounters();
}

function queueWaits(events: Array<{ detail?: string }>): number[] {
    return events
        .map(event => {
            const match = (event.detail || "").match(/queueWaitMs=(\d+)ms/u);
            return match ? Number(match[1]) : null;
        })
        .filter((value): value is number => value !== null);
}

function textOf(response: ToolResponse): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

function taskIdOf(response: ToolResponse): string {
    const match = textOf(response).match(/taskId:\s*(record-(?:batch-update|scheduler)-[^\s]+)/u);
    assert.ok(match, `record_manage should return a batch taskId: ${textOf(response)}`);
    return match[1];
}

function makeBatchPayload(resumeKey: string, workspace: string, ids: string[]) {
    return {
        kind: "record-batch-update" as const,
        actionName: "batch_update" as const,
        resumeKey,
        dataChain: "codex" as const,
        modelChain: "codex" as const,
        force: true,
        candidates: ids.map(id => ({ id, workspace })),
    };
}

function batchLedgerFilePath(resumeKey: string): string {
    return path.join(fakeDataRoot, "record-task-recovery", `record-batch-${resumeKey}.json`);
}

function writeBatchLedgerFile(resumeKey: string, ledger: unknown): void {
    const filePath = batchLedgerFilePath(resumeKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), "utf-8");
}

function readBatchLedgerFile(resumeKey: string): any {
    return JSON.parse(fs.readFileSync(batchLedgerFilePath(resumeKey), "utf-8"));
}

function batchMetadata(conversationId: string) {
    return {
        conversationId,
        title: `ledger ${conversationId}`,
        timeSpan: "2026-07-11 00:00 ~ 2026-07-11 00:01",
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
        phases: 1,
        tags: ["ledger", "v2"],
        chain: "codex",
    };
}

async function waitForIdle(): Promise<void> {
    await waitFor("shared pool idle", () => {
        const stats = __recordConcurrencyTest.stats();
        return stats.active === 0 && stats.pending === 0;
    });
}

async function waitForTasks(taskIds: string[], timeoutMs = 60_000): Promise<void> {
    await waitFor("public batch tasks settled", () => taskIds.every(taskId => {
        const task = getBackgroundTask(taskId);
        return Boolean(task && task.status !== "running");
    }), timeoutMs);
    for (const taskId of taskIds) {
        const task = getBackgroundTask(taskId);
        assert.equal(task?.status, "done", `${taskId} should complete: ${task?.error || "missing"}`);
    }
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
    await fn();
    console.log(`ok - ${name}`);
}

await step("batch candidate ids are deduplicated before freezing", async () => {
    assert.deepEqual(
        __recordConcurrencyTest.dedupeCandidates([
            { id: "duplicate", workspace: workspaceBatchA },
            { id: "unique", workspace: workspaceBatchB },
            { id: "duplicate", workspace: workspaceBatchC },
        ]),
        [
            { id: "duplicate", workspace: workspaceBatchA },
            { id: "unique", workspace: workspaceBatchB },
        ],
    );
});

await step("FIFO permit order", async () => {
    resetSharedPool(1, 1);
    const first = await __recordConcurrencyTest.acquire();
    let secondResolved = false;
    let thirdResolved = false;

    const secondPromise = __recordConcurrencyTest.acquire().then(permit => {
        secondResolved = true;
        return permit;
    });
    const thirdPromise = __recordConcurrencyTest.acquire().then(permit => {
        thirdResolved = true;
        return permit;
    });

    await sleep(60);
    assert.equal(secondResolved, false);
    assert.equal(thirdResolved, false);

    first.release();
    const second = await secondPromise;
    assert.equal(secondResolved, true);
    assert.equal(thirdResolved, false);

    second.release();
    const third = await thirdPromise;
    assert.equal(thirdResolved, true);
    third.release();

    await waitForIdle();
});

await step("cancelled waiter does not leak permits", async () => {
    resetSharedPool(1, 1);
    const first = await __recordConcurrencyTest.acquire();
    let cancelled = false;
    const blocked = __recordConcurrencyTest.acquire({
        shouldCancel: () => cancelled,
        cancelMessage: "cancelled while waiting",
    });
    const blockedResult = blocked.then(
        () => ({ ok: true as const, error: null }),
        error => ({ ok: false as const, error }),
    );

    await sleep(40);
    cancelled = true;
    await sleep(60);
    const rejected = await blockedResult;
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /cancelled while waiting/u);
    assert.equal(__recordConcurrencyTest.stats().pending, 0);

    first.release();
    await waitForIdle();
});

await step("single update write queue waits past the retired timeout and resumes cleanly", async () => {
    resetSharedPool(1, 1);
    process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS = "60";
    const writeEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    let blocked = false;
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_write" && !blocked) {
            blocked = true;
            writeEntered.resolve();
            await releaseWrite.promise;
        }
    });
    const firstPromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: singleThreadIds[0],
        workspace: workspaceSingle,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    });
    try {
        await writeEntered.promise;
        let secondSettled = false;
        const secondPromise = __recordConcurrencyTest.runUpdate({
            hash: "general",
            conversationId: singleThreadIds[1],
            workspace: workspaceSingle,
            dataChain: "codex",
            modelChain: "codex",
            force: true,
        }).finally(() => {
            secondSettled = true;
        });
        await waitFor("second update did not enter the shared persistence queue", () => __recordConcurrencyTest.stats().pending === 1, 15_000);
        await sleep(120);
        assert.equal(secondSettled, false, "a queued update must not fail after the retired timeout interval");
        assert.equal(__recordConcurrencyTest.stats().pending, 1);
        releaseWrite.resolve();
        const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise]);
        assert.match(textOf(firstResponse), /✅ Record 已/u);
        assert.match(textOf(secondResponse), /✅ Record 已/u);
        assert.equal(__recordConcurrencyTest.stats().pending, 0);
    } finally {
        releaseWrite.resolve();
        await firstPromise;
        __recordConcurrencyTest.setPersistenceHook(null);
        delete process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS;
    }
    await waitForIdle();
});

await step("same conversation updates use single-flight instead of last-writer-wins", async () => {
    resetSharedPool(1, 1, 8);
    process.env.FAKE_CODEX_SLEEP_MS = "120";
    const firstPromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: singleThreadIds[2],
        workspace: workspaceSingle,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    });
    const secondPromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: singleThreadIds[2],
        workspace: workspaceSingle,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    });
    const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise]);
    assert.match(textOf(firstResponse), /✅ Record 已/u);
    assert.match(textOf(secondResponse), /✅ Record 已/u);
    assert.equal(readCount(fakePeakCountFile), 1);
    await waitForIdle();
});

await step("model generation does not occupy the write gate and writes stay serialized", async () => {
    resetSharedPool(1, 2, 8);
    process.env.FAKE_CODEX_SLEEP_MS = "600";
    const writeEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    let writeStarts = 0;
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage !== "before_write") return;
        writeStarts++;
        if (writeStarts === 1) {
            writeEntered.resolve();
            await releaseWrite.promise;
        }
    });
    const singlePromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: singleThreadIds[3],
        workspace: workspaceSingle,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    });
    const batchPromise = __recordConcurrencyTest.runBatchUpdate(
        makeBatchPayload(`write-boundary-${Date.now()}`, workspaceBatchA, batchAThreadIds.slice(0, 2)),
    );
    try {
        await waitFor("two model calls overlap before write", () => readCount(fakePeakCountFile) >= 2);
        assert.equal(__recordConcurrencyTest.stats().active, 0, "model stage must not hold the write gate");
        await writeEntered.promise;
        await sleep(80);
        assert.equal(writeStarts, 1, "only one write transaction may enter a limit-1 gate");
        assert.ok(__recordConcurrencyTest.stats().pending >= 1, "other completed generations should wait to write");
    } finally {
        releaseWrite.resolve();
        __recordConcurrencyTest.setPersistenceHook(null);
    }
    await Promise.all([singlePromise, batchPromise]);
    assert.ok(__recordConcurrencyTest.stats().peakActive <= 1);
    await waitForIdle();
});

await step("cross-batch generation uses the process-wide limit and preserves every index entry", async () => {
    resetSharedPool(8, 4, 2);
    process.env.FAKE_CODEX_SLEEP_MS = "360";

    const batches = [
        makeBatchPayload(`group-b-${Date.now()}`, workspaceBatchB, batchBThreadIds),
        makeBatchPayload(`group-c-${Date.now()}`, workspaceBatchC, batchCThreadIds),
        makeBatchPayload(`group-d-${Date.now()}`, workspaceBatchD, batchDThreadIds),
    ];

    const resultsPromise = Promise.all(batches.map(payload => __recordConcurrencyTest.runBatchUpdate(payload)));
    const results = await resultsPromise;

    assert.ok(results.every(result => /queueWaitMsMax=\d+ms/u.test(result)));
    assert.ok(__recordConcurrencyTest.stats().peakActive <= 8);
    assert.equal(__recordGenerationConcurrencyTest.stats().peakActive, 2);
    for (const [workspace, ids] of [
        [workspaceBatchB, batchBThreadIds],
        [workspaceBatchC, batchCThreadIds],
        [workspaceBatchD, batchDThreadIds],
    ] as const) {
        const index = await readRecordsIndexAsync(resolveWorkspaceHashForRecord(workspace));
        for (const id of ids) assert.ok(index.records[id], `missing concurrent Record index entry: ${id}`);
    }
    await waitForIdle();
});

await step("public bulk_update returns scheduler taskId without invoking the retired legacy collector", async () => {
    resetSharedPool(8, 8);
    let legacyCollectorCalls = 0;
    __recordConcurrencyTest.setBatchCandidateCollector(async () => {
        legacyCollectorCalls += 1;
        throw new Error("scheduler-managed bulk_update must not invoke the retired legacy candidate collector");
    });
    try {
        const startedAt = Date.now();
        const response = await Promise.race([
            recordManageHandler!({
                action: "bulk_update",
                workspace: workspaceBatchA,
                limit: 4,
                force: true,
                chain: "codex",
                dataChain: "codex",
                modelChain: "codex",
            }),
            sleep(5_000).then(() => { throw new Error("public bulk_update blocked on candidate preparation"); }),
        ]);
        const taskId = taskIdOf(response);
        assert.ok(Date.now() - startedAt < 5_000, "公开入口应先返回 taskId，不等待候选扫描完成");
        await waitFor("scheduler bulk_update settled", () => {
            const task = getBackgroundTask(taskId);
            return task !== undefined && task.status !== "running";
        }, 30_000);
        assert.equal(legacyCollectorCalls, 0);
    } finally {
        __recordConcurrencyTest.setBatchCandidateCollector(null);
    }
});

await step("write exception releases the permit for the next transaction", async () => {
    resetSharedPool(1, 1);
    process.env.FAKE_CODEX_SLEEP_MS = "80";
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_write" && event.conversationId === batchAThreadIds[2]) {
            throw new Error("forced persistence failure");
        }
    });

    const firstPromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: batchAThreadIds[2],
        workspace: workspaceBatchA,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    }).then(
        () => { throw new Error("forced persistence failure should reject the first update"); },
        error => error,
    );
    const secondPromise = __recordConcurrencyTest.runUpdate({
        hash: "general",
        conversationId: batchAThreadIds[3],
        workspace: workspaceBatchA,
        dataChain: "codex",
        modelChain: "codex",
        force: true,
    });

    const [firstError, secondResponse] = await Promise.all([firstPromise, secondPromise]);
    assert.match(String(firstError), /forced persistence failure/u);
    assert.match(textOf(secondResponse), /✅ Record 已/u);
    assert.equal(__recordConcurrencyTest.stats().active, 0);
    assert.equal(__recordConcurrencyTest.stats().pending, 0);
    __recordConcurrencyTest.setPersistenceHook(null);
    await waitForIdle();
});

await step("v1 ledger normalization retains legacy entries and rewrites as v2 on locked mutation", async () => {
    const candidates = ["legacy-completed", "legacy-failed"].map(id => ({ id, workspace: workspaceBatchA }));
    const payload = makeBatchPayload(`ledger-v1-${Date.now()}`, workspaceBatchA, candidates.map(candidate => candidate.id));
    const legacyCompleted = {
        ...candidates[0],
        recordedAt: "2026-07-11T00:00:00.000Z",
        reason: "legacy completed detail",
    };
    writeBatchLedgerFile(payload.resumeKey, {
        version: 1,
        resumeKey: payload.resumeKey,
        updatedAt: "2026-07-11T00:00:00.000Z",
        candidates: payload.candidates,
        completed: [legacyCompleted],
        skipped: [],
        failed: [],
        inFlight: [],
    });

    const normalized = await __recordConcurrencyTest.readBatchLedger(payload);
    assert.equal(normalized.version, 2, "v1 账本应在内存中正规化为 v2");
    assert.deepEqual(normalized.completed[0], legacyCompleted, "v1 completed 条目不能因正规化丢失字段");
    assert.equal(readBatchLedgerFile(payload.resumeKey).version, 1, "纯读取不得提前改写磁盘上的 v1 ledger");

    await __recordConcurrencyTest.mutateBatchLedger(payload, "failed", candidates[1], "legacy rewrite mutation");
    const persisted = readBatchLedgerFile(payload.resumeKey);
    assert.equal(persisted.version, 2, "锁内 mutation 应将正规化后的 ledger 回写为 v2");
    assert.deepEqual(persisted.completed[0], legacyCompleted, "v1 已完成条目在回写时必须原样保留");
    assert.equal(persisted.failed[0].reason, "legacy rewrite mutation");
});

await step("concurrent recovery ledger mutations preserve v2 attribution and metadata", async () => {
    const candidates = ["ledger-completed", "ledger-failed", "ledger-in-flight"].map(id => ({ id, workspace: workspaceBatchA }));
    const payload = makeBatchPayload(`ledger-rmw-${Date.now()}`, workspaceBatchA, candidates.map(candidate => candidate.id));
    const mutateLedger = __recordConcurrencyTest.mutateBatchLedger as unknown as (
        testPayload: typeof payload,
        mutation: "completed" | "failed" | "inFlight",
        candidate: { id: string; workspace: string },
        reason?: string,
        details?: { metadata?: ReturnType<typeof batchMetadata>; isNew?: boolean },
    ) => Promise<any>;
    await Promise.all([
        mutateLedger(payload, "completed", candidates[0], undefined, { isNew: true }),
        mutateLedger(payload, "failed", candidates[1], "forced ledger failure", { isNew: false }),
        mutateLedger(payload, "inFlight", candidates[2], "pending record content", {
            metadata: batchMetadata(candidates[2].id),
            isNew: true,
        }),
    ]);

    const ledger = await __recordConcurrencyTest.readBatchLedger(payload);
    assert.deepEqual(ledger.completed.map(entry => entry.id), [candidates[0].id]);
    assert.deepEqual(ledger.failed.map(entry => entry.id), [candidates[1].id]);
    assert.deepEqual(ledger.inFlight.map(entry => entry.id), [candidates[2].id]);
    assert.equal(ledger.failed[0].reason, "forced ledger failure");
    assert.equal(ledger.completed[0].isNew, true, "并发 RMW 不得丢失新建归因");
    assert.equal(ledger.failed[0].isNew, false, "并发 RMW 不得丢失更新归因");
    assert.equal(ledger.inFlight[0].isNew, true, "in-flight 必须在正文写入前保留新建归因");
    assert.ok(ledger.inFlight[0].contentHash, "in-flight ledger entries should retain their recovery content hash");
    assert.deepEqual(ledger.inFlight[0].metadata, batchMetadata(candidates[2].id), "并发 RMW 不得丢失恢复所需 metadata");
});

await step("batch result separates ledger totals from process AIMD diagnostics", async () => {
    const candidates = ["result-created", "result-updated", "result-legacy"].map(id => ({ id, workspace: workspaceBatchA }));
    const payload = makeBatchPayload(`ledger-result-${Date.now()}`, workspaceBatchA, candidates.map(candidate => candidate.id));
    writeBatchLedgerFile(payload.resumeKey, {
        version: 2,
        resumeKey: payload.resumeKey,
        updatedAt: new Date().toISOString(),
        candidates: payload.candidates,
        completed: [
            { ...candidates[0], recordedAt: new Date().toISOString(), isNew: true },
            { ...candidates[1], recordedAt: new Date().toISOString(), isNew: false },
            { ...candidates[2], recordedAt: new Date().toISOString() },
        ],
        skipped: [],
        failed: [],
        inFlight: [],
    });

    const result = await __recordConcurrencyTest.runBatchUpdate(payload);
    assert.match(result, /✅ 本 batch 成功: 3 份（新建 1 \/ 更新 1 \/ 未分类 1）/u);
    assert.match(result, /🚦 进程内 AIMD 累计:/u);
    assert.match(result, /successes=\d+（成功持久化事务） failures=\d+（拥塞反馈失败；均非本 batch ledger 数字）/u);
    assert.doesNotMatch(result, /✅ 本 batch 成功:[^\n]*(?:successes|failures)=/u, "ledger 总数不能混入 AIMD 运行期累计");

    const ledger = await __recordConcurrencyTest.readBatchLedger(payload);
    const resultWithGrokDiagnostics = __recordConcurrencyTest.formatBatchResult(
        ledger,
        ledger.candidates.length,
        { hadPriorState: false, initialSettledCount: 0 },
        {
            maxBatchQueueWaitMs: 12,
            maxGlobalQueueWaitMs: 34,
            maxQueueAttempts: 2,
            latest: {
                concurrencyScope: "process",
                context: "record",
                active: 1,
                pending: 2,
                limit: 3,
                current: 3,
                max: 8,
                min: 1,
                successes: 5,
                failures: 1,
                queueWaitMs: 46,
                batchQueueWaitMs: 12,
                globalQueueWaitMs: 34,
                queueAttempts: 2,
                trafficClass: "record-batch",
                pid: process.pid,
                globalActive: 1,
                globalPending: 2,
                globalLimit: 3,
                batchActive: 1,
                batchPending: 1,
                batchLimit: 4,
            },
        },
    );
    assert.match(resultWithGrokDiagnostics, new RegExp(`Grok 请求级保护（仅当前 memory-store Node 进程 pid=${process.pid}）`, "u"));
    assert.match(resultWithGrokDiagnostics, /trafficClass=record-batch.*batchQueueWaitMsMax=12.*globalQueueWaitMsMax=34.*queueAttemptsMax=2/u);
    assert.match(resultWithGrokDiagnostics, /batchActive=1 batchPending=1 batchLimit=4 globalActive=1 globalPending=2 globalLimit=3 AIMD=3\/8 failures=1/u);
});
