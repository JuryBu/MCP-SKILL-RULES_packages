import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-management-race-"));
const fakeHome = path.join(tempRoot, "home");
const fakeCodexHome = path.join(fakeHome, ".codex");
const fakeSessionsDir = path.join(fakeCodexHome, "sessions");
const dataRoot = path.join(tempRoot, "data");
const workspace = path.join(tempRoot, "workspace");
const fakeCodexJs = path.join(tempRoot, "fake-codex.js");
const fakeCodexCmd = path.join(tempRoot, "fake-codex.cmd");
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fs.mkdirSync(fakeSessionsDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = path.parse(fakeHome).root.replace(/\\$/, "") || "C:";
process.env.HOMEPATH = fakeHome.slice(process.env.HOMEDRIVE.length) || "\\";
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "5000";
process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT = "5000";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_RECORD_PARALLEL_MODE = "off";
process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "1";
process.env.MEMORY_STORE_AUTO_RECORD = "0";

fs.writeFileSync(fakeCodexJs, String.raw`
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    if (input.includes("请把指定轮次区段整理为 RecordPatch 草稿")) {
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound: 1,
          endRound: 4,
          title: "并发写入区段",
          files: [],
          tags: ["race", "record"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- update generated as RecordPatch"
      ].join("\n"), "utf-8");
      process.exit(0);
    }
    const manualSupplement = input.match(/\[手动补充\][^\r\n]*/u)?.[0];
    fs.writeFileSync(outputPath, [
      "# Record: management race",
      "",
      "- 对话ID：fake",
      "- 工作区：fake",
      "- 总轮次：4",
      "- 总步骤：6",
      "",
      "## Phase 1：并发写入（轮次 1-4)",
      "",
      "- update generated",
      ...(manualSupplement ? [manualSupplement] : []),
      "",
      "<!-- TAGS: race, record -->"
    ].join("\n"), "utf-8");
    process.exit(0);
  });
  return;
}

process.exit(1);
`, "utf-8");
fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

function writeJsonl(filePath: string, events: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

const rolloutPath = path.join(fakeSessionsDir, `rollout-2026-07-11T00-00-00-${conversationId}.jsonl`);
writeJsonl(rolloutPath, [
    {
        type: "session_meta",
        payload: {
            id: conversationId,
            cwd: workspace,
            title: "management-race",
            source: "codex",
            model: "gpt-test",
            reasoning_effort: "high",
        },
    },
    ...Array.from({ length: 4 }, (_, index) => [
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `用户轮次 ${index + 1}` }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `助手轮次 ${index + 1}` }] } },
    ]).flat(),
]);

const stateDb = path.join(fakeCodexHome, "state_5.sqlite");
const createStateDb = `
import sqlite3, sys
db_path, conversation_id, rollout_path, cwd = sys.argv[1:]
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
  (conversation_id, rollout_path, cwd, "management-race", "codex", "gpt-test", "high", None, None, 1, "2026-07-11T00:00:00.000Z", 0)
)
conn.commit()
conn.close()
`;
execFileSync("python", ["-c", createStateDb, stateDb, conversationId, rolloutPath, workspace], {
    stdio: "inherit",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
process.chdir(workspace);

const { __recordConcurrencyTest, registerRecord } = await import("../src/tools/record.ts");
const { __recordUpdateCoordinationTest } = await import("../src/record-update-coordination.ts");
const { recordPatchCheckpointDir } = await import("../src/record-checkpoint.ts");
const {
    readRecord,
    readRecordSidecar,
    resolveWorkspaceHashForRecord,
    withRecordCommitArtifactLock,
    writeRecord,
    writeRecordSidecar,
} = await import("../src/record-store.ts");
const { buildRecordReaderIndex, isRecordReaderIndexFresh } = await import("../src/record-reader.ts");
const {
    readRecordWorkRegistry,
    recordWorkIdentityManifestPath,
    recordWorkRegistryPath,
} = await import("../src/record-work-registry.ts");

type ToolResponse = { content?: Array<{ text?: string }> };
type RecordManageHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const handlers = new Map<string, RecordManageHandler>();
registerRecord({
    tool(name: string, _description: string, _schema: unknown, handler: RecordManageHandler) {
        handlers.set(name, handler);
    },
} as never);
const recordManage = handlers.get("record_manage");
assert.ok(recordManage, "record_manage public handler should be registered");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function textOf(response: ToolResponse): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

function clearRecordCheckpoints(): void {
    fs.rmSync(recordPatchCheckpointDir(conversationId), { recursive: true, force: true });
}

async function startBlockedUpdate(force = true) {
    const entered = deferred<void>();
    const release = deferred<void>();
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_write" && event.conversationId === conversationId) {
            entered.resolve();
            await release.promise;
        }
    });
    let settledResponse: ToolResponse | null = null;
    const update = recordManage!({
        action: "update",
        conversationId,
        workspace,
        dataChain: "codex",
        modelChain: "codex",
        background: false,
        force,
    }).then(response => {
        settledResponse = response;
        return response;
    });
    const state = await Promise.race([
        entered.promise.then(() => "entered" as const),
        update.then(() => "settled" as const),
    ]);
    assert.equal(
        state,
        "entered",
        `update must reach its persistence hook: ${settledResponse ? textOf(settledResponse) : "still pending"}; record=${JSON.stringify(readRecord(hash, conversationId))}`,
    );
    return { update, release };
}

const hash = resolveWorkspaceHashForRecord(workspace);
const registryLocation = {
    dataRoot,
    identity: { chain: "codex" as const, workspaceHash: hash, conversationId },
};

try {
    const first = await startBlockedUpdate();
    let editSettled = false;
    const edit = recordManage!({ action: "edit", conversationId, workspace, append: "manual edit survives" })
        .then(result => {
            editSettled = true;
            return result;
        });
    await sleep(40);
    assert.equal(editSettled, false, "edit must wait for the in-flight update before reading its source Record");
    __recordConcurrencyTest.setPersistenceHook(null);
    first.release.resolve();
    await Promise.all([first.update, edit]);
    assert.match(readRecord(hash, conversationId) || "", /update generated/u);
    assert.match(readRecord(hash, conversationId) || "", /manual edit survives/u, "edit must read the committed update instead of overwriting it");
    const registryAfterEdit = await readRecordWorkRegistry(registryLocation);
    assert.equal(registryAfterEdit.kind, "ready", "public edit must leave the publication registry readable");
    if (registryAfterEdit.kind === "ready") {
        const active = registryAfterEdit.registry.works.find(work => work.state === "Active");
        assert.ok(active, "public edit must retain an attachable active work generation");
        assert.equal(active.publicationClaim, undefined, "public edit must clear the old winner claim");
        assert.equal(active.ownerLease, null, "public edit must fence the old owner lease");
        assert.deepEqual(active.activeTaskIds, [], "public edit must detach every old scheduler Task");
        assert.equal(active.publicationHistory?.at(-1)?.reason, "manual_record_mutation");
        assert.equal(active.publicationHistory?.at(-1)?.rolloverTrigger, "manual_edit");
    }

    const releaseArtifactLock = deferred<void>();
    const artifactLockEntered = deferred<void>();
    const artifactBlocker = withRecordCommitArtifactLock(hash, async () => {
        artifactLockEntered.resolve();
        await releaseArtifactLock.promise;
    });
    await artifactLockEntered.promise;
    let lockOrderEditSettled = false;
    const lockOrderEdit = recordManage!({ action: "edit", conversationId, workspace, append: "artifact lock order survives" })
        .then(response => {
            lockOrderEditSettled = true;
            return response;
        });
    await sleep(40);
    assert.equal(lockOrderEditSettled, false, "public edit must wait at the artifact lock before taking registry authority");
    const registryReadWhileEditWaits = await Promise.race([
        readRecordWorkRegistry(registryLocation),
        sleep(250).then(() => "timeout" as const),
    ]);
    assert.notEqual(registryReadWhileEditWaits, "timeout", "an edit waiting for the artifact lock must not hold the registry lock");
    releaseArtifactLock.resolve();
    await Promise.all([artifactBlocker, lockOrderEdit]);
    assert.match(readRecord(hash, conversationId) || "", /artifact lock order survives/u);

    const foreignManifestPath = recordWorkIdentityManifestPath({
        dataRoot,
        identity: { chain: "windsurf", workspaceHash: hash, conversationId },
    });
    fs.mkdirSync(path.dirname(foreignManifestPath), { recursive: true });
    fs.writeFileSync(foreignManifestPath, "{}", "utf8");
    const beforeForeignConflict = readRecord(hash, conversationId);
    const foreignConflictEdit = await recordManage!({ action: "edit", conversationId, workspace, append: "must not cross host" });
    assert.match(textOf(foreignConflictEdit), /索引宿主 codex 之外的发布注册表/u, "已知 chain 遇到外宿主发布状态必须 fail closed");
    assert.equal(readRecord(hash, conversationId), beforeForeignConflict, "宿主冲突时不得修改可见 Record");
    fs.rmSync(foreignManifestPath, { force: true });

    const staleReadContent = [
        "# Record: reader race",
        "",
        "- 对话ID：fake",
        "- 工作区：fake",
        "- 总轮次：3",
        "- 总步骤：6",
        "",
        "## Phase 1：旧正文（轮次 1-3)",
    ].join("\n");
    await writeRecord(hash, conversationId, staleReadContent, {
        phases: 1,
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
    });
    await writeRecordSidecar(hash, conversationId, "record_index.json", buildRecordReaderIndex(conversationId, `${staleReadContent}\nstale sidecar`));
    clearRecordCheckpoints();
    const readerBlockedUpdate = await startBlockedUpdate();
    let staleReaderSettled = false;
    const staleReader = recordManage!({ action: "read", conversationId, workspace, view: "outline", indexMode: "rebuild" })
        .then(response => {
            staleReaderSettled = true;
            return response;
        });
    await sleep(40);
    assert.equal(staleReaderSettled, false, "Reader Index rebuild must wait for an in-flight update before it can persist a sidecar");
    __recordConcurrencyTest.setPersistenceHook(null);
    readerBlockedUpdate.release.resolve();
    const [readerBlockedUpdateResponse] = await Promise.all([readerBlockedUpdate.update, staleReader]);
    const updatedAfterStaleRead = readRecord(hash, conversationId) || "";
    const updatedSidecar = readRecordSidecar<ReturnType<typeof buildRecordReaderIndex>>(hash, conversationId, "record_index.json");
    assert.match(updatedAfterStaleRead, /update generated/u, textOf(readerBlockedUpdateResponse));
    assert.ok(updatedSidecar, "an update must retain its Reader sidecar after a stale structured read resumes");
    assert.equal(isRecordReaderIndexFresh(updatedSidecar, updatedAfterStaleRead), true, "a stale structured read must not overwrite the updated Reader sidecar");
    await writeRecord(hash, conversationId, staleReadContent, {
        phases: 1,
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
    });
    await writeRecordSidecar(hash, conversationId, "record_index.json", buildRecordReaderIndex(conversationId, `${staleReadContent}\nstale sidecar`));
    const recordsIndexPath = path.join(dataRoot, "workspaces", hash, "records", "_records_index.json");
    const recordsIndexWithoutChain = JSON.parse(fs.readFileSync(recordsIndexPath, "utf8")) as {
        records: Record<string, { chain?: string }>;
    };
    delete recordsIndexWithoutChain.records[conversationId]?.chain;
    fs.writeFileSync(recordsIndexPath, JSON.stringify(recordsIndexWithoutChain, null, 2), "utf8");

    const foreignManifestWithoutChain = recordWorkIdentityManifestPath({
        dataRoot,
        identity: { chain: "windsurf", workspaceHash: hash, conversationId },
    });
    fs.mkdirSync(path.dirname(foreignManifestWithoutChain), { recursive: true });
    fs.writeFileSync(foreignManifestWithoutChain, "{}", "utf8");
    const beforeMultipleCandidates = readRecord(hash, conversationId);
    const multipleCandidateDelete = await recordManage!({ action: "delete", conversationId, workspace });
    assert.match(textOf(multipleCandidateDelete), /多个宿主发布注册表/u, "缺少 chain 时多宿主候选必须 fail closed");
    assert.equal(readRecord(hash, conversationId), beforeMultipleCandidates, "多宿主冲突不得删除可见 Record");
    fs.rmSync(foreignManifestWithoutChain, { force: true });

    const codexManifestPath = recordWorkIdentityManifestPath(registryLocation);
    const codexRegistryPath = recordWorkRegistryPath(registryLocation);
    const codexManifestBackupPath = `${codexManifestPath}.partial-probe-backup`;
    const codexRegistryBackupPath = `${codexRegistryPath}.partial-probe-backup`;
    fs.renameSync(codexManifestPath, codexManifestBackupPath);
    fs.renameSync(codexRegistryPath, codexRegistryBackupPath);
    fs.writeFileSync(foreignManifestWithoutChain, "{}", "utf8");
    const beforePartialCandidate = readRecord(hash, conversationId);
    const partialCandidateEdit = await recordManage!({ action: "edit", conversationId, workspace, append: "must not cross partial host" });
    assert.match(textOf(partialCandidateEdit), /registry_missing/u, "缺少 chain 时唯一但残缺的宿主状态必须 RepairRequired");
    assert.equal(readRecord(hash, conversationId), beforePartialCandidate, "残缺发布状态不得修改可见 Record");
    fs.rmSync(foreignManifestWithoutChain, { force: true });
    fs.renameSync(codexManifestBackupPath, codexManifestPath);
    fs.renameSync(codexRegistryBackupPath, codexRegistryPath);

    const readerBeforeSingleFlight = deferred<void>();
    const releaseReaderBeforeSingleFlight = deferred<void>();
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_reader_index_single_flight" && event.conversationId === conversationId) {
            readerBeforeSingleFlight.resolve();
            await releaseReaderBeforeSingleFlight.promise;
        }
    });
    const readerAfterDelete = recordManage!({ action: "read", conversationId, workspace, view: "outline", indexMode: "rebuild" });
    await readerBeforeSingleFlight.promise;
    const deleteBeforeReaderPersistence = await recordManage!({ action: "delete", conversationId, workspace });
    assert.match(textOf(deleteBeforeReaderPersistence), /已删除/u);
    releaseReaderBeforeSingleFlight.resolve();
    const deletedReaderResponse = await readerAfterDelete;
    assert.match(textOf(deletedReaderResponse), /rebuilt_in_memory_missing_record/u);
    assert.equal(readRecord(hash, conversationId), null, "the delete must remove the Record before the delayed reader validates it");
    assert.equal(readRecordSidecar(hash, conversationId, "record_index.json"), null, "a delayed Reader rebuild must not leave an orphan sidecar after delete");
    const registryAfterDelete = await readRecordWorkRegistry(registryLocation);
    assert.equal(registryAfterDelete.kind, "ready", "public delete must leave the publication registry readable");
    if (registryAfterDelete.kind === "ready") {
        const active = registryAfterDelete.registry.works.find(work => work.state === "Active");
        assert.ok(active, "public delete must retain an attachable active work generation");
        assert.equal(active.publicationClaim, undefined, "public delete must clear the old winner claim");
        assert.equal(active.ownerLease, null, "public delete must fence the old owner lease");
        assert.deepEqual(active.activeTaskIds, [], "public delete must detach every old scheduler Task");
        assert.equal(active.publicationHistory?.at(-1)?.reason, "manual_record_mutation");
        assert.equal(active.publicationHistory?.at(-1)?.rolloverTrigger, "manual_delete");
    }
    __recordConcurrencyTest.setPersistenceHook(null);

    const second = await startBlockedUpdate();
    let deleteSettled = false;
    const deletion = recordManage!({ action: "delete", conversationId, workspace })
        .then(result => {
            deleteSettled = true;
            return result;
        });
    await sleep(40);
    assert.equal(deleteSettled, false, "delete must wait for the in-flight update before removing its Record");
    __recordConcurrencyTest.setPersistenceHook(null);
    second.release.resolve();
    await Promise.all([second.update, deletion]);
    assert.equal(readRecord(hash, conversationId), null, "a completed delete must not be followed by an older update writeback");

    clearRecordCheckpoints();
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_write" && event.conversationId === conversationId) {
            throw new Error("forced persistence failure");
        }
    });
    const failedUpdate = await recordManage!({
        action: "update",
        conversationId,
        workspace,
        dataChain: "codex",
        modelChain: "codex",
        background: false,
        force: true,
    });
    assert.match(textOf(failedUpdate), /forced persistence failure/u);
    const persistenceStats = __recordUpdateCoordinationTest.persistenceStats();
    assert.equal(persistenceStats.active, 0);
    assert.equal(persistenceStats.pending, 0);
    assert.equal(persistenceStats.peakActive, 1);
    assert.equal(persistenceStats.limit, 1);
    assert.equal(persistenceStats.current, 1);
    assert.equal(persistenceStats.max, 1);
    assert.equal(persistenceStats.min, 1);
    assert.equal(persistenceStats.failures, 0);
    assert.equal(__recordUpdateCoordinationTest.singleFlightStats(conversationId), null, "a failed management update must release its single-flight permit");

    const staleContent = [
        "# Record: management race",
        "",
        "- 对话ID：fake",
        "- 工作区：fake",
        "- 总轮次：3",
        "- 总步骤：6",
        "",
        "## Phase 1：旧索引（轮次 1-3)",
        "",
        "- current Record content",
    ].join("\n");
    const staleIndex = buildRecordReaderIndex(conversationId, `${staleContent}\nold sidecar source`);
    await writeRecord(hash, conversationId, staleContent, {
        phases: 1,
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
    });
    await writeRecordSidecar(hash, conversationId, "record_index.json", staleIndex);
    clearRecordCheckpoints();
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_reader_index" && event.conversationId === conversationId) {
            throw new Error("forced reader index failure");
        }
    });
    const updateWithFailedIndex = await recordManage!({
        action: "update",
        conversationId,
        workspace,
        dataChain: "codex",
        modelChain: "codex",
        background: false,
        force: true,
    });
    assert.match(textOf(updateWithFailedIndex), /forced reader index failure/u);
    assert.equal(readRecordSidecar(hash, conversationId, "record_index.json"), null, "update must invalidate an old Reader sidecar after a failed replacement");

    const updatedContent = readRecord(hash, conversationId) || "";
    await writeRecordSidecar(hash, conversationId, "record_index.json", buildRecordReaderIndex(conversationId, updatedContent));
    const editWithFailedIndex = await recordManage!({ action: "edit", conversationId, workspace, append: "index failure edit" });
    assert.match(textOf(editWithFailedIndex), /Reader Index: error/u);
    assert.equal(readRecordSidecar(hash, conversationId, "record_index.json"), null, "edit must invalidate an old Reader sidecar after a failed replacement");

    const editedContent = readRecord(hash, conversationId) || "";
    await writeRecordSidecar(hash, conversationId, "record_index.json", buildRecordReaderIndex(conversationId, `${editedContent}\nold sidecar source`));
    const autoRead = await recordManage!({ action: "read", conversationId, workspace, view: "outline", indexMode: "auto" });
    assert.match(textOf(autoRead), /rebuilt_in_memory_pending/u, "ordinary Reader write failures must fall back to the in-memory index");
    assert.doesNotMatch(textOf(autoRead), /forced reader index failure/u, "ordinary Reader write failures must not turn a successful read into a tool error");
    assert.equal(readRecordSidecar(hash, conversationId, "record_index.json"), null, "auto Reader rebuild must not expose a stale sidecar after a failed replacement");
    assert.ok(readRecordSidecar(hash, conversationId, "record_index.rebuild.json"), "ordinary Reader write failures must leave a pending-rebuild marker");

    await writeRecord(hash, conversationId, staleContent, {
        phases: 1,
        totalRounds: 3,
        totalSteps: 6,
        lastUpdatedRound: 3,
    });
    await writeRecordSidecar(hash, conversationId, "record_index.json", staleIndex);
    clearRecordCheckpoints();
    const beforeSidecarCongestion = __recordUpdateCoordinationTest.persistenceStats();
    __recordConcurrencyTest.setPersistenceHook(async event => {
        if (event.stage === "before_reader_index" && event.conversationId === conversationId) {
            throw Object.assign(new Error("reader sidecar write failed"), {
                cause: Object.assign(new Error("file handles exhausted"), { code: "EMFILE" }),
            });
        }
    });
    const congestedUpdate = await recordManage!({
        action: "update",
        conversationId,
        workspace,
        dataChain: "codex",
        modelChain: "codex",
        background: false,
        force: true,
    });
    assert.match(textOf(congestedUpdate), /reader sidecar write failed/u);
    const afterSidecarCongestion = __recordUpdateCoordinationTest.persistenceStats();
    assert.equal(afterSidecarCongestion.failures, beforeSidecarCongestion.failures + 1, "Reader sidecar congestion in a cause chain must reach AIMD failure feedback");
    assert.equal(afterSidecarCongestion.current, 1, "Reader sidecar congestion must reduce the persistence window");

    console.log("✅ record management race tests passed");
} finally {
    __recordConcurrencyTest.setPersistenceHook(null);
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
}
