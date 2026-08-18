import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalSerialize, classifySourceEvidence } from "../src/source-evidence-contracts.ts";
import {
    buildCodexRoundsForTest,
    createCodexSourceRevisionAccumulator,
    codexSourceRevisionFromRounds,
    collectCodexSourceEvidence,
    collectCodexEvidenceMessagesForTest,
    enumerateCodexSourceEvidence,
    fetchCodexSourceEvidence,
    readCodexFullSourceEvidence,
    type CodexSourceEvidenceOptions,
} from "../src/codex-client.ts";

const MAIN_ID = "11111111-1111-1111-1111-111111111111";
const CHILD_ID = "22222222-2222-2222-2222-222222222222";
const MISSING_ID = "33333333-3333-3333-3333-333333333333";
const LIMIT_ID = "44444444-4444-4444-4444-444444444444";

interface FixtureThread {
    id: string;
    rolloutPath: string;
    source?: string | null;
    title?: string;
    updatedAtMs?: number;
    hasUserEvent?: number;
}

interface CodexFixture {
    root: string;
    sessionsRoot: string;
    stateDbPath: string;
    rolloutPaths: Map<string, string>;
}

function writeRollout(
    sessionsRoot: string,
    id: string,
    lines: unknown[],
): string {
    const rolloutPath = path.join(sessionsRoot, `rollout-2026-07-13T00-00-00-${id}.jsonl`);
    fs.writeFileSync(rolloutPath, lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n"), "utf8");
    return rolloutPath;
}

function message(role: "user" | "assistant", text: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "message",
            role,
            content: [{ type: role === "user" ? "input_text" : "output_text", text }],
        },
    };
}

const abortedEvents = [
    message("user", "第一次发送后立刻中止"),
    message("user", "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"),
    { type: "event_msg", payload: { type: "turn_aborted" } },
    message("user", "中止后重新发送"),
] as unknown[];
const abortedEvidence = collectCodexEvidenceMessagesForTest(abortedEvents);
assert.equal(abortedEvidence.roundEnd, 2, "Record 证据投影必须沿用中止边界，不能把两次发送压成一轮");
assert.deepEqual(abortedEvidence.messages.map(item => [item.role, item.text]), [
    ["user", "第一次发送后立刻中止"],
    ["user", "中止后重新发送"],
]);
const fetchRevision = codexSourceRevisionFromRounds(buildCodexRoundsForTest(abortedEvents, "reference").rounds, 7);
const expectedEvidenceRevision = `sha256:${createHash("sha256").update(canonicalSerialize({ messages: abortedEvidence.messages }), "utf8").digest("hex")}`;
assert.equal(fetchRevision.revision, expectedEvidenceRevision, "streamed fetch rounds and production evidence must derive the same authoritative Codex revision");
assert.equal(fetchRevision.sequence, 7);

const incrementalEvents = [
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "Cafe\u0301 😀" },
                { type: "input_image", image_url: "data:image/png;base64,aGk=" },
            ],
        },
    },
    message("assistant", "Unicode 与附件已接收"),
] as unknown[];
const incrementalRounds = buildCodexRoundsForTest(incrementalEvents, "reference").rounds;
const incrementalEvidence = collectCodexEvidenceMessagesForTest(incrementalEvents);
const incrementalExpected = `sha256:${createHash("sha256").update(canonicalSerialize({ messages: incrementalEvidence.messages }), "utf8").digest("hex")}`;
const incrementalAccumulator = createCodexSourceRevisionAccumulator();
for (const round of incrementalRounds) incrementalAccumulator.addRound(round);
assert.equal(incrementalAccumulator.finish(9).revision, incrementalExpected, "incremental revision must remain byte-equivalent for NFC, emoji and attachment projections");
assert.equal(incrementalAccumulator.finish(9).revision, incrementalExpected, "finish must be repeatable without consuming the underlying hash state");
const emptyAccumulator = createCodexSourceRevisionAccumulator();
const emptyExpected = `sha256:${createHash("sha256").update(canonicalSerialize({ messages: [] }), "utf8").digest("hex")}`;
assert.deepEqual(emptyAccumulator.finish(), {
    revision: emptyExpected,
    contentCursor: null,
    eventWatermark: null,
    sequence: null,
});

function createFixture(
    rollouts: Array<{ id: string; lines: unknown[] }>,
    threads: Array<Omit<FixtureThread, "rolloutPath"> & { id: string }>,
    edges: Array<{ child: string; parent: string }> = [],
): CodexFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-evidence-"));
    const sessionsRoot = path.join(root, "sessions");
    const stateDbPath = path.join(root, "state_5.sqlite");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const rolloutPaths = new Map<string, string>();
    for (const rollout of rollouts) rolloutPaths.set(rollout.id, writeRollout(sessionsRoot, rollout.id, rollout.lines));
    const rows = threads.map(thread => ({
        ...thread,
        rolloutPath: rolloutPaths.get(thread.id) || path.join(sessionsRoot, `rollout-2026-07-13T00-00-00-${thread.id}.jsonl`),
    }));
    const script = `
import json, sqlite3, sys
db_path, rows_json, edges_json = sys.argv[1:]
rows, edges = json.loads(rows_json), json.loads(edges_json)
conn = sqlite3.connect(db_path)
conn.execute("create table threads (id text primary key, rollout_path text, cwd text, title text, source text, model text, reasoning_effort text, agent_nickname text, agent_role text, updated_at_ms integer, archived integer default 0, has_user_event integer default 0)")
conn.execute("create table thread_spawn_edges (child_thread_id text, parent_thread_id text, status text)")
for row in rows:
    conn.execute("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (row["id"], row["rolloutPath"], "C:/fixture", row.get("title", ""), row.get("source"), None, None, None, None, row.get("updatedAtMs", 1), 0, row.get("hasUserEvent", 0)))
for edge in edges:
    conn.execute("insert into thread_spawn_edges values (?, ?, ?)", (edge["child"], edge["parent"], "completed"))
conn.commit()
`;
    execFileSync("python", ["-c", script, stateDbPath, JSON.stringify(rows), JSON.stringify(edges)], { encoding: "utf8", windowsHide: true });
    return { root, sessionsRoot, stateDbPath, rolloutPaths };
}

function updateFixtureRolloutPath(fixture: CodexFixture, conversationId: string, rolloutPath: string): void {
    const script = `
import sqlite3, sys
db_path, thread_id, rollout_path = sys.argv[1:]
conn = sqlite3.connect(db_path)
conn.execute("update threads set rollout_path = ? where id = ?", (rollout_path, thread_id))
conn.commit()
`;
    execFileSync("python", ["-c", script, fixture.stateDbPath, conversationId, rolloutPath], { encoding: "utf8", windowsHide: true });
}

function options(fixture: CodexFixture, conversationId: string, scanId: string, overrides: Partial<CodexSourceEvidenceOptions> = {}): CodexSourceEvidenceOptions {
    return {
        conversationId,
        workspace: { workspaceId: "codex-evidence-fixture", canonicalPath: fixture.root },
        scanId,
        sequence: 1,
        paths: { stateDbPath: fixture.stateDbPath, rolloutRoots: [fixture.sessionsRoot] },
        now: () => new Date("2026-07-13T12:00:00.000Z"),
        ...overrides,
    };
}

const fixture = createFixture(
    [
        {
            id: MAIN_ID,
            lines: [
                { type: "session_meta", payload: { id: MAIN_ID, title: "", source: "main-source" } },
                message("user", "主线程内容，尽管 has_user_event 为零"),
                message("assistant", "主线程答复"),
            ],
        },
        {
            id: CHILD_ID,
            lines: [
                { type: "session_meta", payload: { id: CHILD_ID, title: "", source: "child-source" } },
                message("user", "子代理真实用户内容"),
                message("assistant", "子代理真实答复"),
            ],
        },
    ],
    [
        { id: MAIN_ID, source: "main-source", title: "", hasUserEvent: 0 },
        { id: CHILD_ID, source: "child-source", title: "", hasUserEvent: 0 },
    ],
    [{ child: CHILD_ID, parent: MAIN_ID }],
);

try {
    const childResult = await collectCodexSourceEvidence(options(fixture, CHILD_ID, "scan-clean-child"));
    assert.equal(childResult.enumeration.enumerationComplete, true);
    assert.equal(childResult.enumeration.exactFetchResult, "present");
    assert.match(childResult.enumeration.evidenceHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(childResult.enumeration.adapterVersion, "source-evidence/v1");
    assert.equal(childResult.enumeration.sourceRevision.contentCursor, childResult.fullSourceRead?.sourceRevision.contentCursor);
    assert.equal(childResult.thread?.source, "child-source");
    assert.equal(childResult.thread?.isChildThread, true);
    assert.equal(childResult.thread?.parentConversationId, MAIN_ID);
    assert.equal(childResult.parentThread?.source, "main-source");
    assert.ok(childResult.fullSourceRead);
    assert.ok(childResult.sourceSnapshot, "真实 user/assistant 内容应产生完整 source snapshot");
    assert.equal(childResult.fullSourceRead?.errors.length, 0);
    assert.equal(childResult.fullSourceRead?.content.truncated, false);
    assert.equal(childResult.fullSourceRead?.pagination.limit, null);
    assert.deepEqual(childResult.sourceMessages, [
        { role: "user", text: "子代理真实用户内容" },
        { role: "assistant", text: "子代理真实答复" },
    ], "full rollout read must expose only meaningful user/assistant source messages without another file read");

    const cachedEnumeration = await enumerateCodexSourceEvidence(options(fixture, MISSING_ID, "scan-cache", { cacheBypassed: false }));
    const cachedExact = await fetchCodexSourceEvidence(options(fixture, MISSING_ID, "scan-cache", { cacheBypassed: false }));
    assert.equal(cachedEnumeration.evidence.cacheBypassed, false);
    assert.equal(cachedExact.evidence.exactFetchResult, "not_found");
    assert.deepEqual(classifySourceEvidence({ enumeration: cachedEnumeration.evidence, exactFetch: cachedExact.evidence }), {
        state: "Unresolved",
        reason: "cache-not-bypassed",
    });

    const revisionBefore = await enumerateCodexSourceEvidence(options(fixture, MAIN_ID, "scan-drift"));
    fs.appendFileSync(fixture.rolloutPaths.get(MAIN_ID)!, `\n${JSON.stringify(message("assistant", "扫描后的新增答复"))}`, "utf8");
    const revisionAfter = await fetchCodexSourceEvidence(options(fixture, MAIN_ID, "scan-drift"));
    assert.equal(classifySourceEvidence({ enumeration: revisionBefore.evidence, exactFetch: revisionAfter.evidence }).reason, "revision-drift");
} finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
}

const fidelityFixture = createFixture(
    [{
        id: MAIN_ID,
        lines: [
            { type: "session_meta", payload: { id: MAIN_ID } },
            { type: "response_item", payload: { type: "message", role: "user", id: "empty-user", content: [{ type: "input_text", text: "" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "whitespace-user", content: [{ type: "input_text", text: " \n" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "attachment-user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGk=" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "same-user-1", content: [{ type: "input_text", text: "连续同文" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "same-user-2", content: [{ type: "input_text", text: "连续同文" }] } },
            { type: "response_item", payload: { type: "message", role: "assistant", id: "empty-assistant", content: [{ type: "output_text", text: "" }] } },
            { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "tool_result", tool_use_id: "tool-only", content: "must-not-be-message" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "mirrored-user", content: [{ type: "input_text", text: "镜像消息" }] } },
            { type: "event_msg", payload: { type: "user_message", id: "mirrored-user", message: "镜像消息", images: ["data:image/png;base64,aGk="] } },
        ],
    }],
    [{ id: MAIN_ID }],
);

try {
    const fidelity = await collectCodexSourceEvidence(options(fidelityFixture, MAIN_ID, "scan-fidelity"));
    assert.deepEqual(fidelity.sourceMessages?.map(message => [message.role, message.text]), [
        ["user", ""],
        ["user", "连续同文"],
        ["user", "连续同文"],
        ["user", "镜像消息"],
    ]);
    assert.equal(fidelity.sourceMessages?.[0]?.attachments?.length, 1, "attachment-only user messages must survive source collection");
    assert.equal(fidelity.sourceMessages?.[3]?.attachments?.length, 1, "response_item/event_msg mirrors must merge attachment evidence by message identity");
    assert.equal(fidelity.fullSourceRead?.content.roundRange?.end, 2, "empty/whitespace transport messages do not create human rounds, while model activity separates the next human side");
    assert.equal(fidelity.sourceMessages?.some(message => message.text.includes("must-not-be-message")), false, "tool-only messages must stay excluded");
} finally {
    fs.rmSync(fidelityFixture.root, { recursive: true, force: true });
}

const hardenedMappingFixture = createFixture(
    [{
        id: MAIN_ID,
        lines: [
            { type: "session_meta", payload: { id: MAIN_ID } },
            { type: "response_item", payload: { type: "message", role: "user", id: "reused-message-id", content: [{ type: "input_text", text: "重复正文不能错绑附件" }] } },
            { type: "response_item", payload: { type: "message", role: "user", id: "reused-message-id", content: [{ type: "input_text", text: "重复正文不能错绑附件" }] } },
            { type: "event_msg", payload: { type: "user_message", id: "reused-message-id", message: "重复正文不能错绑附件", images: ["data:image/png;base64,aGk="] } },
            { type: "response_item", payload: { type: "message", role: "assistant", id: "future-block", content: [{ type: "future_output_block", opaque: "must-not-disappear" }] } },
        ],
    }],
    [{ id: MAIN_ID }],
);

try {
    const hardened = await collectCodexSourceEvidence(options(hardenedMappingFixture, MAIN_ID, "scan-hardened-mapping"));
    assert.deepEqual(hardened.sourceMessages?.map(sourceMessage => [
        sourceMessage.role,
        sourceMessage.text,
        sourceMessage.attachments?.length || 0,
    ]), [
        ["user", "重复正文不能错绑附件", 0],
        ["user", "重复正文不能错绑附件", 1],
        ["assistant", "[Codex 未识别内容块：type=future_output_block]", 0],
    ], "复用的 message ID 不得吞掉真人消息，相邻跨源镜像只补附件，未知内容块仍须保留");
} finally {
    fs.rmSync(hardenedMappingFixture.root, { recursive: true, force: true });
}

const malformedFixture = createFixture(
    [
        {
            id: MAIN_ID,
            lines: [
                { type: "session_meta", payload: { id: MAIN_ID } },
                message("user", "有效内容后面有坏行"),
                "{ this is malformed JSONL",
            ],
        },
    ],
    [{ id: MAIN_ID, source: null, hasUserEvent: 0 }],
);

try {
    const malformed = await readCodexFullSourceEvidence(options(malformedFixture, MAIN_ID, "scan-malformed"));
    assert.equal(malformed.evidence.exactFetchResult, "present");
    assert.ok(malformed.fullSourceRead?.errors.some(issue => issue.code === "parse_error"));
    assert.equal(malformed.fullSourceRead?.enumerationComplete, false);
    assert.equal(malformed.sourceSnapshot, undefined);
} finally {
    fs.rmSync(malformedFixture.root, { recursive: true, force: true });
}

const limitFixture = createFixture(
    [
        { id: MAIN_ID, lines: [{ type: "session_meta", payload: { id: MAIN_ID } }, message("user", "限制前"), message("assistant", "答复")] },
        { id: LIMIT_ID, lines: [{ type: "session_meta", payload: { id: LIMIT_ID } }, message("user", "限制后"), message("assistant", "答复")] },
    ],
    [{ id: MAIN_ID }, { id: LIMIT_ID }],
);

try {
    const limited = await enumerateCodexSourceEvidence(options(limitFixture, MAIN_ID, "scan-limit", { enumerationLimit: 1 }));
    assert.equal(limited.evidence.enumerationComplete, false);
    assert.equal(limited.evidence.pagination.limit, 1);
    assert.equal(limited.evidence.pagination.truncated, true);
    assert.ok(limited.evidence.errors.some(issue => issue.code === "limit_reached"));
} finally {
    fs.rmSync(limitFixture.root, { recursive: true, force: true });
}

const disappearingFixture = createFixture(
    [{ id: MAIN_ID, lines: [{ type: "session_meta", payload: { id: MAIN_ID } }, message("user", "即将消失"), message("assistant", "答复")] }],
    [{ id: MAIN_ID }],
);

try {
    const disappearingPath = disappearingFixture.rolloutPaths.get(MAIN_ID)!;
    const originalOpen = fs.promises.open;
    let removed = false;
    (fs.promises as { open: typeof fs.promises.open }).open = async (...args: Parameters<typeof fs.promises.open>) => {
        if (!removed && args[0] === disappearingPath) {
            removed = true;
            fs.rmSync(disappearingPath, { force: true });
        }
        return originalOpen(...args);
    };
    try {
        const disappearing = await enumerateCodexSourceEvidence(options(disappearingFixture, MAIN_ID, "scan-disappear"));
        assert.equal(disappearing.evidence.enumerationComplete, false);
        assert.ok(disappearing.evidence.errors.some(issue => issue.code === "source_unavailable"));
        assert.equal(disappearing.evidence.exactFetchResult, "present");
    } finally {
        (fs.promises as { open: typeof fs.promises.open }).open = originalOpen;
    }
} finally {
    fs.rmSync(disappearingFixture.root, { recursive: true, force: true });
}

const externalRolloutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-external-rollout-"));
const externalRolloutPath = path.join(externalRolloutRoot, `rollout-2026-07-13T00-00-00-${MAIN_ID}.jsonl`);
fs.writeFileSync(externalRolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: MAIN_ID } }),
    JSON.stringify(message("user", "根外合法 JSONL 不得被读取")),
    JSON.stringify(message("assistant", "根外内容不应进入完整来源")),
].join("\n"), "utf8");
const externalPathFixture = createFixture([], [{ id: MAIN_ID }]);
try {
    updateFixtureRolloutPath(externalPathFixture, MAIN_ID, externalRolloutPath);
    const externalPathResult = await collectCodexSourceEvidence(options(externalPathFixture, MAIN_ID, "scan-external-rollout"));
    assert.equal(externalPathResult.enumeration.exactFetchResult, "unresolved");
    assert.equal(externalPathResult.evidence.exactFetchResult, "unresolved");
    assert.equal(classifySourceEvidence({ enumeration: externalPathResult.enumeration, exactFetch: externalPathResult.evidence }).state, "Unresolved");
    assert.ok(externalPathResult.enumeration.errors.some(issue => issue.code === "source_unavailable"));
    assert.equal(externalPathResult.fullSourceRead, undefined);
    assert.equal(externalPathResult.sourceSnapshot, undefined);
    assert.equal(externalPathResult.sourceMessages, undefined);
} finally {
    fs.rmSync(externalPathFixture.root, { recursive: true, force: true });
    fs.rmSync(externalRolloutRoot, { recursive: true, force: true });
}

const symlinkEscapeFixture = createFixture([], [{ id: MAIN_ID }]);
const symlinkEscapeExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-symlink-rollout-"));
const symlinkEscapeExternalPath = path.join(symlinkEscapeExternalRoot, `rollout-2026-07-13T00-00-00-${MAIN_ID}.jsonl`);
const symlinkEscapePath = path.join(symlinkEscapeFixture.sessionsRoot, `rollout-2026-07-13T00-00-00-${MAIN_ID}.jsonl`);
fs.writeFileSync(symlinkEscapeExternalPath, [
    JSON.stringify({ type: "session_meta", payload: { id: MAIN_ID } }),
    JSON.stringify(message("user", "链接越界内容不得被读取")),
].join("\n"), "utf8");
let symlinkEscapeCreated = false;
try {
    try {
        fs.symlinkSync(symlinkEscapeExternalPath, symlinkEscapePath, "file");
        symlinkEscapeCreated = true;
    } catch {
        symlinkEscapeCreated = false;
    }
    if (symlinkEscapeCreated) {
        const symlinkEscapeResult = await collectCodexSourceEvidence(options(symlinkEscapeFixture, MAIN_ID, "scan-symlink-escape"));
        assert.equal(symlinkEscapeResult.enumeration.exactFetchResult, "unresolved");
        assert.equal(symlinkEscapeResult.evidence.exactFetchResult, "unresolved");
        assert.ok(symlinkEscapeResult.enumeration.errors.some(issue => issue.code === "source_unavailable"));
        assert.equal(symlinkEscapeResult.fullSourceRead, undefined);
        assert.equal(symlinkEscapeResult.sourceSnapshot, undefined);
        assert.equal(symlinkEscapeResult.sourceMessages, undefined);
    }
} finally {
    fs.rmSync(symlinkEscapeFixture.root, { recursive: true, force: true });
    fs.rmSync(symlinkEscapeExternalRoot, { recursive: true, force: true });
}
