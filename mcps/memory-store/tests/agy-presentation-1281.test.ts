import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listAntigravityLocalConversations, type AntigravityLocalDiagnostic } from "../src/antigravity-local-sources.ts";
import { antigravityEventsToRounds, type AntigravityLocalEvent } from "../src/antigravity-local-projection.ts";
import { filterRoundAttachmentsForRoles, materializeRoundAttachments, mergeRoundAttachments, type ConversationAttachment } from "../src/conversation-attachments.ts";
import { formatCorpusReadableResult, withCorpusOutputFormat } from "../src/conversation-readable-output.ts";
import { projectHostCorpus } from "../src/conversation-host-projection.ts";
import { TEMP_DIR } from "../src/temp-store.ts";
import type { ConversationRound } from "../src/trajectory.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agy-presentation-1281-"));
const materializationId = `agy-presentation-1281-${randomUUID()}`;
const gui = path.join(temporary, "gui");
const cli = path.join(temporary, "cli");

function event(stepIndex: number, type: string, raw: Record<string, unknown>): AntigravityLocalEvent {
    return { stepIndex, type, raw, sourcePath: path.join(gui, "transcript.jsonl"), line: stepIndex + 1 };
}

async function summaries(root: string, count: number): Promise<void> {
    await fs.mkdir(root, { recursive: true });
    const database = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    try {
        database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT)");
        const insert = database.prepare("INSERT INTO conversation_summaries VALUES(?,?,?)");
        database.exec("BEGIN");
        for (let index = 0; index < count; index++) insert.run(`metadata-${index}`, `Metadata ${index}`, "2026-11-13T00:00:00Z");
        database.exec("COMMIT");
    } finally { database.close(); }
}

async function sourceState(root: string): Promise<unknown[]> {
    const state: unknown[] = [];
    for (const filename of (await fs.readdir(root)).sort()) {
        const file = path.join(root, filename);
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        state.push({ filename, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
            sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
    }
    return state;
}

try {
    await summaries(gui, 710);
    await summaries(cli, 2);
    const diagnostics: AntigravityLocalDiagnostic[] = [];
    const roots = [{ kind: "gui" as const, root: gui }, { kind: "cli" as const, root: cli }];
    const started = performance.now();
    const listed = await listAntigravityLocalConversations({ roots, onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    const grouped = diagnostics.filter(diagnostic => diagnostic.code === "ANTIGRAVITY_METADATA_ONLY");
    assert.equal(listed.length, 712);
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped.map(diagnostic => diagnostic.occurrences), [710, 2]);
    assert.equal(grouped[0].conversationIds?.length, 710);
    assert.equal(new Set(grouped[0].conversationIds).size, 710);
    assert.ok(grouped[1].conversationIds?.every(id => id.startsWith("antigravity-cli:")));
    assert.match(grouped[0].message, /710 gui.*local bodies are unavailable/u);
    assert.ok(grouped[0].sourcePath);
    assert.ok(grouped[0].message.includes("structured diagnostics"));
    assert.ok(grouped[0].message.includes("conversationIds"));
    assert.ok(Buffer.byteLength(JSON.stringify(grouped)) < 40_000);
    const exact: AntigravityLocalDiagnostic[] = [];
    await listAntigravityLocalConversations({ roots, conversationIds: ["metadata-709"], onDiagnostic: diagnostic => exact.push(diagnostic) });
    assert.deepEqual(exact[0].conversationIds, ["metadata-709"]);
    assert.equal(exact[0].occurrences, 1);
    console.log(`PASS metadata: 712 candidates, 2 source groups, full ID membership, exact lookup; ${Math.round(performance.now() - started)}ms, ${Buffer.byteLength(JSON.stringify(grouped))} diagnostic bytes`);

    const cancelDiagnostics: AntigravityLocalDiagnostic[] = [];
    let activityChecks = 0;
    await assert.rejects(listAntigravityLocalConversations({ roots, isCancelled: () => ++activityChecks > 1000,
        onDiagnostic: diagnostic => cancelDiagnostics.push(diagnostic) }), { name: "AbortError" });
    assert.ok(cancelDiagnostics.some(diagnostic => diagnostic.code === "ANTIGRAVITY_METADATA_ONLY" && diagnostic.occurrences! > 0 && diagnostic.occurrences! < 710));
    console.log("PASS cancellation: observed metadata-only counts survive an interrupted enumeration");

    const closedWalRoot = path.join(temporary, "closed-wal-mode");
    await fs.mkdir(closedWalRoot);
    const closedWal = new DatabaseSync(path.join(closedWalRoot, "conversation_summaries.db"));
    closedWal.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT)");
    closedWal.prepare("INSERT INTO conversation_summaries VALUES(?,?)").run("closed-wal", "closed WAL mode");
    closedWal.close();
    const closedBefore = await sourceState(closedWalRoot);
    const closedListed = await listAntigravityLocalConversations({ roots: [{ kind: "gui", root: closedWalRoot }] });
    assert.deepEqual(closedListed.map(candidate => candidate.id), ["closed-wal"]);
    assert.deepEqual(await sourceState(closedWalRoot), closedBefore);
    assert.deepEqual((await fs.readdir(closedWalRoot)).sort(), ["conversation_summaries.db"]);
    console.log("PASS closed WAL directory index: file set, SHA256, size and timestamps unchanged; no source WAL/SHM created");

    const liveWalRoot = path.join(temporary, "committed-live-wal");
    await fs.mkdir(liveWalRoot);
    const liveWal = new DatabaseSync(path.join(liveWalRoot, "conversation_summaries.db"));
    try {
        liveWal.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT); PRAGMA wal_checkpoint(TRUNCATE)");
        liveWal.prepare("INSERT INTO conversation_summaries VALUES(?,?)").run("committed-in-wal", "only in committed WAL");
        assert.ok((await fs.stat(path.join(liveWalRoot, "conversation_summaries.db-wal"))).size > 32);
        const liveBefore = await sourceState(liveWalRoot);
        const liveListed = await listAntigravityLocalConversations({ roots: [{ kind: "gui", root: liveWalRoot }] });
        assert.deepEqual(liveListed.map(candidate => candidate.id), ["committed-in-wal"]);
        assert.deepEqual(await sourceState(liveWalRoot), liveBefore);
        console.log("PASS committed WAL directory index: WAL-only row readable, DB/WAL/SHM file set, hashes, sizes and timestamps unchanged");
    } finally { liveWal.close(); }

    const brokenRoot = path.join(temporary, "unsupported-directory-index");
    await fs.mkdir(brokenRoot);
    const broken = new DatabaseSync(path.join(brokenRoot, "conversation_summaries.db"));
    broken.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries(other TEXT)");
    broken.close();
    const brokenBefore = await sourceState(brokenRoot);
    const brokenDiagnostics: AntigravityLocalDiagnostic[] = [];
    await listAntigravityLocalConversations({ roots: [{ kind: "gui", root: brokenRoot }], onDiagnostic: diagnostic => brokenDiagnostics.push(diagnostic) });
    assert.ok(brokenDiagnostics.some(diagnostic => diagnostic.code === "ANTIGRAVITY_METADATA_UNAVAILABLE"));
    assert.deepEqual(await sourceState(brokenRoot), brokenBefore);
    console.log("PASS failed directory query: visible coverage diagnostic and unchanged source file set/content");

    const userPath = path.join(temporary, "user.png");
    const toolPath = path.join(temporary, "tool.png");
    const rounds = antigravityEventsToRounds([
        event(10, "USER_INPUT", { content: "用户原图", media: [{ uri: userPath, mime_type: "image/png" }] }),
        event(20, "PLANNER_RESPONSE", { content: "查看截图", tool_calls: [{ name: "view_image", args: "{}" }] }),
        event(30, "GENERIC", { content: "工具截图", media: [{ uri: toolPath, mime_type: "image/png" }] }),
    ]);
    const round = rounds[0];
    assert.deepEqual(round.attachments?.map(attachment => [attachment.stepIndex, attachment.semanticRole]), [[0, "user"], [2, "tool"]]);
    assert.deepEqual(round.userMessages?.[0].attachments?.map(attachment => attachment.originalPath), [userPath]);
    assert.deepEqual(round.mediaAttachments, [userPath]);
    const toolEvent = round.semanticEvents?.find(item => item.kind === "tool");
    assert.deepEqual(toolEvent?.attachments?.map(attachment => attachment.originalPath), [toolPath]);
    assert.equal(toolEvent?.attachments?.[0].stepIndex, 2);
    for (const oldCache of [false, true]) {
        const selectedRound = oldCache ? JSON.parse(JSON.stringify(round)) as ConversationRound : round;
        if (oldCache) for (const attachment of selectedRound.attachments || []) delete attachment.semanticRole;
        const users = filterRoundAttachmentsForRoles(selectedRound, new Set(["user"]));
        const tools = filterRoundAttachmentsForRoles(selectedRound, new Set(["tool"]));
        assert.deepEqual(users.attachments?.map(attachment => attachment.originalPath), [userPath]);
        assert.deepEqual(tools.attachments?.map(attachment => attachment.originalPath), [toolPath]);
        assert.deepEqual(tools.mediaAttachments, []);
        assert.deepEqual(tools.userMessages?.[0].attachments, []);
    }
    const projected = projectHostCorpus({ id: "fixture", title: "Fixture", source: "antigravity", workspace: temporary },
        { rounds, revision: "fixture-source", sourceComplete: true }, undefined, { messageRoles: ["user", "assistant", "tool"] });
    assert.deepEqual(projected.messages.find(message => message.role === "user")?.attachments?.map(attachment => attachment.originalPath), [userPath]);
    assert.ok(!JSON.stringify(projected.messages.find(message => message.role === "user")).includes(toolPath));
    console.log("PASS ownership: GENERIC tool event and round attachments, user projection, role filtering including old caches with source_record steps");

    const fragment = structuredClone(round);
    fragment.userMessages = fragment.userMessages?.slice(0, 1);
    fragment.attachments = fragment.userMessages?.[0].attachments;
    fragment.semanticEvents = fragment.semanticEvents?.filter(item => item.semanticRole === "user");
    const reindexed = antigravityEventsToRounds([event(99, "USER_INPUT", { content: "用户原图" }),
        { ...event(101, "USER_INPUT", {}), fragment }])[0];
    assert.equal(reindexed.userMessages?.[1].attachments?.[0].stepIndex, 1);
    assert.equal(reindexed.semanticEvents?.find(item => item.semanticRole === "user" && item.stepIndex === 1)?.attachments?.[0].stepIndex, 1);
    const reused: ConversationRound = { ...round, attachments: [] };
    mergeRoundAttachments(reused, [
        { kind: "image", source: "antigravity-raw-attachment", originalPath: userPath, stepIndex: 0, semanticRole: "user" },
        { kind: "image", source: "antigravity-uri", originalPath: userPath, stepIndex: 2, semanticRole: "tool" },
    ]);
    assert.equal(reused.attachments?.length, 2);
    console.log("PASS step provenance: nested fragment attachments reindexed; repeated physical image retained for each event");

    const dataUrl = `data:image/png;base64,${Buffer.from("same physical image").toString("base64")}`;
    const userInline: ConversationAttachment = { kind: "image", source: "codex-data-url", dataUrl, stepIndex: 0, semanticRole: "user" };
    const toolInline: ConversationAttachment = { kind: "image", source: "antigravity-tool-image", dataUrl, stepIndex: 2, semanticRole: "tool" };
    const inline: ConversationRound = { ...round, attachments: [userInline, toolInline],
        userMessages: [{ text: "图", stepIndex: 0, attachments: [userInline] }],
        semanticEvents: [{ kind: "tool", semanticRole: "tool", stepIndex: 2, attachments: [toolInline] }] };
    const materialized = (await materializeRoundAttachments([inline], materializationId, { concurrency: 1 })).rounds[0];
    assert.equal(materialized.userMessages?.[0].attachments?.[0].stepIndex, 0);
    assert.equal(materialized.userMessages?.[0].attachments?.[0].semanticRole, "user");
    assert.equal(materialized.userMessages?.[0].attachments?.[0].source, "codex-data-url");
    assert.equal(materialized.semanticEvents?.[0].attachments?.[0].stepIndex, 2);
    assert.equal(materialized.semanticEvents?.[0].attachments?.[0].semanticRole, "tool");
    assert.ok(materialized.userMessages?.[0].attachments?.[0].tempPath);
    assert.ok(materialized.semanticEvents?.[0].attachments?.[0].tempPath);
    assert.equal(inline.userMessages?.[0].attachments?.[0].tempPath, undefined);
    console.log("PASS materialization: shared image content preserves each user/tool step and role, including semantic event paths");

    for (const status of ["done", "completed", "error", "failed", "cancelled", "canceled", "resumable"]) {
        for (const rangeAvailable of [false, true]) {
            const output = formatCorpusReadableResult({ taskId: "original-task", status, rangeAvailable, requestedRangeComplete: false,
                fullSourceComplete: false, progress: { detail: "后台任务已开始执行" }, error: status === "error" ? "source changed" : undefined,
                next: { action: "prepare_status", taskId: "original-task" } }, { action: "prepare_status" })!;
            assert.match(output, /本任务已结束/u);
            assert.doesNotMatch(output, /仍在准备|后台任务已开始执行|⏳/u);
            assert.ok(output.includes("original-task"));
            if (status === "error") assert.match(output, /source changed/u);
        }
    }
    const running = formatCorpusReadableResult({ taskId: "active-task", status: "running", progress: { detail: "后台任务已开始执行" } }, { action: "prepare_status" })!;
    assert.match(running, /所需范围仍在准备/u);
    assert.match(running, /后台任务已开始执行/u);
    const error = { taskId: "old-error", status: "error", error: "source changed", progress: { stage: "running", detail: "后台任务已开始执行" } };
    const json = withCorpusOutputFormat(error, "json") as typeof error;
    assert.equal(json.progress.stage, "error");
    assert.equal(json.progress.detail, "source changed");
    assert.equal(error.progress.detail, "后台任务已开始执行");
    const partialError = formatCorpusReadableResult({ ...error, messages: [{ round: 1, role: "user", text: "已有正文" }],
        fullSourceComplete: false, cachePreparation: error }, { action: "read_ready" })!;
    assert.match(partialError, /本任务已结束/u);
    assert.match(partialError, /source changed/u);
    assert.doesNotMatch(partialError, /仍在准备|后台任务已开始执行|⏳/u);
    console.log("PASS terminal output: seven final states, empty/partial ranges, stale detail suppressed; running detail retained");
} finally {
    await fs.rm(temporary, { recursive: true, force: true });
    for (const directory of ["codex-attachments", "antigravity-tool-attachments"]) {
        await fs.rm(path.join(TEMP_DIR, directory, materializationId), { recursive: true, force: true });
    }
}
