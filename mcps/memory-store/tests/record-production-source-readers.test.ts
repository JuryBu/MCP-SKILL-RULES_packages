import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
    PRODUCTION_SOURCE_FORMATTER_VERSION,
    PRODUCTION_SOURCE_FORMATTER_VERSION_V1,
    MAX_PRODUCTION_SOURCE_ATTACHMENT_DECODE_BYTES,
    createProductionSourceReader,
    isSupportedProductionSourceFormatterVersion,
    type AntigravityProductionSourceIo,
    type ProductionSourceCanonicalDocument,
    type ProductionSourceContentPayload,
    type ProductionSourceReadResult,
} from "../src/record-production-source-readers.ts";
import type { ClaudeCodeSourceEvidenceFileSystem } from "../src/claude-code-client.ts";
import type { WindsurfLsTransport } from "../src/windsurf-client.ts";

const CODEX_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_DAMAGED_ID = "11111111-1111-4111-8111-111111111112";
const CLAUDE_CODE_ID = "22222222-2222-4222-8222-222222222222";
const CLAUDE_CODE_DAMAGED_ID = "22222222-2222-4222-8222-222222222223";
const CLAUDE_CODE_GROWTH_ID = "22222222-2222-4222-8222-222222222224";
const CLAUDE_CODE_DELETED_LOCAL_FILE_ID = "22222222-2222-4222-8222-222222222225";
const CLAUDE_CODE_REPLACED_LOCAL_FILE_ID = "22222222-2222-4222-8222-222222222226";
const WINDSURF_ID = "cascade-production-reader";
const ANTIGRAVITY_ID = "33333333-3333-4333-8333-333333333333";
const LARGE_UNICODE_LINE = `大行-é-${"界".repeat(96 * 1024)}`;

interface CodexFixture {
    stateDbPath: string;
    sessionsRoot: string;
    rolloutPath: string;
}

interface IoCounters {
    listLive: number;
    fetchLive: number;
    listPb: number;
    fetchPb: number;
    listVscdb: number;
    fetchVscdb: number;
}

function writeJsonl(filePath: string, events: unknown[], malformedTail = false): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf8");
    if (malformedTail) fs.appendFileSync(filePath, "{not-json}\n", "utf8");
}

function createCodexFixture(root: string, conversationId: string, label: string, malformedTail = false): CodexFixture {
    const sessionsRoot = path.join(root, `codex-sessions-${label}`);
    const stateDbPath = path.join(root, `state-${label}.sqlite`);
    const rolloutPath = path.join(sessionsRoot, `rollout-2026-07-14T00-00-00-${conversationId}.jsonl`);
    writeJsonl(rolloutPath, [
        { type: "session_meta", payload: { id: conversationId, source: "fixture-subagent-without-thread-source" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex e\u0301\r\n用户" }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 助手回复" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "  \r\n" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGk=" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "连续同文" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "连续同文" }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "codex-tool-only-secret" }] } },
        { type: "response_item", payload: { type: "function_call", name: "codex-tool-secret" } },
        { type: "event_msg", payload: { type: "context_compacted", message: "codex-compact-secret" } },
    ], malformedTail);
    const script = `
import sqlite3, sys
db_path, rollout_path, thread_id = sys.argv[1:]
conn = sqlite3.connect(db_path)
conn.execute("create table threads (id text primary key, rollout_path text, cwd text, title text, source text, model text, reasoning_effort text, agent_nickname text, agent_role text, updated_at_ms integer, archived integer default 0, has_user_event integer default 0)")
conn.execute("create table thread_spawn_edges (child_thread_id text, parent_thread_id text, status text)")
conn.execute("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (thread_id, rollout_path, "C:/fixture", "", "subagent-unmarked", None, None, None, None, 1, 1, 0))
conn.commit()
`;
    execFileSync("python", ["-c", script, stateDbPath, rolloutPath, conversationId], { encoding: "utf8", windowsHide: true });
    return { stateDbPath, sessionsRoot, rolloutPath };
}

function createCountingClaudeFileSystem(counter: { calls: number }): Partial<ClaudeCodeSourceEvidenceFileSystem> {
    const count = <T>(operation: () => T): T => {
        counter.calls += 1;
        return operation();
    };
    return {
        readdirSync: directory => count(() => fs.readdirSync(directory, { withFileTypes: true })),
        statSync: filePath => count(() => fs.statSync(filePath)),
        readFileSync: filePath => count(() => fs.readFileSync(filePath)),
        openSync: (filePath, flags) => count(() => fs.openSync(filePath, flags)),
        readSync: (fileDescriptor, buffer, offset, length, position) => count(() =>
            fs.readSync(fileDescriptor, buffer, offset, length, position)),
        closeSync: fileDescriptor => count(() => fs.closeSync(fileDescriptor)),
    };
}

function createWindsurfController(growDuringRead = false, images: unknown[] = [{ mimeType: "image/png", base64Data: "aGk=" }]): {
    transport: WindsurfLsTransport;
    calls: { list: number; steps: number };
} {
    const calls = { list: 0, steps: 0 };
    const steps = [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "WSF e\u0301\r\n用户", images } },
        { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "WSF 助手消息" } },
        { type: "CORTEX_STEP_TYPE_UNKNOWN_META", text: "wsf-tool-secret" },
    ];
    const transport: WindsurfLsTransport = async (method, payload) => {
        if (method === "GetAllCascadeTrajectories") {
            calls.list += 1;
            return {
                trajectorySummaries: {
                    [WINDSURF_ID]: {
                        summary: "WSF 生产读取器夹具",
                        title_best_effort: "sidecar fixture",
                        stepCount: steps.length,
                        lastModifiedTime: growDuringRead && calls.list > 1
                            ? "2026-07-14T00:00:01.000Z"
                            : "2026-07-14T00:00:00.000Z",
                        cwd: "C:/fixture",
                    },
                },
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            calls.steps += 1;
            return Number(payload?.stepOffset) === 0 ? { steps } : { steps: [] };
        }
        throw new Error(`unexpected WSF method ${method}`);
    };
    return { transport, calls };
}

function createAntigravityController(): {
    io: AntigravityProductionSourceIo;
    calls: IoCounters;
    setAssistantText(value: string): void;
    setTrajectory(value: unknown): void;
} {
    const ids = [ANTIGRAVITY_ID];
    const eventWatermarks = { [ANTIGRAVITY_ID]: "2026-07-14T00:00:00.000Z" };
    const calls: IoCounters = { listLive: 0, fetchLive: 0, listPb: 0, fetchPb: 0, listVscdb: 0, fetchVscdb: 0 };
    let assistantText = "AG 助手消息";
    let trajectory: unknown = null;
    const io: AntigravityProductionSourceIo = {
        listLive: async () => {
            calls.listLive += 1;
            return { ids, endpointIds: ["fixture-ls:9000"], eventWatermarks };
        },
        fetchLive: async conversationId => {
            calls.fetchLive += 1;
            return conversationId === ANTIGRAVITY_ID
                ? {
                    trajectory: trajectory || {
                        steps: [
                            { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "AG e\u0301\r\n用户", images: [{ mimeType: "image/png", base64Data: "aGk=" }] } },
                            { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: assistantText } },
                            { type: "CORTEX_STEP_TYPE_UNKNOWN_META", text: "ag-tool-secret" },
                        ],
                    },
                    endpointId: "fixture-ls:9000",
                    eventWatermark: eventWatermarks[ANTIGRAVITY_ID],
                }
                : null;
        },
        listPb: async () => {
            calls.listPb += 1;
            return { ids, revision: "pb-fixture-v1" };
        },
        fetchPb: async (_pbRoot, conversationId) => {
            calls.fetchPb += 1;
            return conversationId === ANTIGRAVITY_ID;
        },
        listVscdb: async () => {
            calls.listVscdb += 1;
            return { ids, revision: "vscdb-fixture-v1" };
        },
        fetchVscdb: async (_vscdbPath, conversationId) => {
            calls.fetchVscdb += 1;
            return conversationId === ANTIGRAVITY_ID;
        },
    };
    return {
        io,
        calls,
        setAssistantText: value => { assistantText = value; },
        setTrajectory: value => { trajectory = value; },
    };
}

function parsePayload(payload: ProductionSourceContentPayload): ProductionSourceCanonicalDocument {
    assert.equal(payload.byteLength, payload.bytes.byteLength);
    assert.equal(
        payload.contentHash,
        `sha256:${createHash("sha256").update(payload.bytes).digest("hex")}`,
        "payload hash must be computed from the returned canonical bytes",
    );
    assert.equal(payload.schemaVersion, PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION);
    assert.equal(payload.formatterVersion, PRODUCTION_SOURCE_FORMATTER_VERSION);
    assert.equal(payload.encoding, "utf-8");
    return JSON.parse(Buffer.from(payload.bytes).toString("utf8")) as ProductionSourceCanonicalDocument;
}

function assertComplete(result: ProductionSourceReadResult, host: string): ProductionSourceCanonicalDocument {
    assert.equal(result.host, host);
    assert.equal(result.enumeration.cacheBypassed, true);
    assert.equal(result.exactFetch.cacheBypassed, true);
    assert.equal(result.enumeration.enumerationComplete, true);
    assert.equal(result.enumeration.pagination.cursor, null);
    assert.equal(result.enumeration.pagination.truncated, false);
    assert.equal(result.exactFetch.exactFetchResult, "present");
    assert.equal(
        result.classification.state,
        "Present",
        `${host} classification issues: ${JSON.stringify({
            issues: result.fullSourceRead.issues,
            enumerationRevision: result.enumeration.sourceRevision,
            exactRevision: result.exactFetch.sourceRevision,
            fullRevision: result.fullSourceRead.evidence?.sourceRevision,
            scanIds: [
                result.enumeration.observedAt.scanId,
                result.exactFetch.observedAt.scanId,
                result.fullSourceRead.evidence?.observedAt.scanId,
            ],
        })}`,
    );
    if (result.fullSourceRead.status !== "complete") assert.fail(`${host} should return a complete canonical payload`);
    const fullRead = result.fullSourceRead;
    assert.ok(result.sourceSnapshot);
    assert.equal(result.sourceSnapshot, fullRead.sourceSnapshot);
    assert.equal(fullRead.evidence.content.byteLength, fullRead.payload.byteLength);
    assert.equal(fullRead.evidence.content.contentHash, fullRead.payload.contentHash);
    assert.equal(fullRead.authority.identityStable, true);
    assert.equal(fullRead.authority.revisionStable, true);
    assert.equal(fullRead.authority.cacheBypassed, true);
    const document = parsePayload(fullRead.payload);
    assert.equal(document.schemaVersion, PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION);
    assert.equal(document.formatterVersion, PRODUCTION_SOURCE_FORMATTER_VERSION);
    assert.deepEqual(document.messages.map(message => message.order), document.messages.map((_, index) => index + 1));
    assert.ok(document.messages.every(message => message.role === "user" || message.role === "assistant"));
    return document;
}

function replayPayload(result: ProductionSourceReadResult): ProductionSourceCanonicalDocument {
    if (result.fullSourceRead.status !== "complete") assert.fail("cannot replay an unresolved full read");
    const first = Buffer.from(result.fullSourceRead.payload.bytes);
    const second = Buffer.from(result.fullSourceRead.payload.bytes);
    assert.deepEqual(first, second, "payload bytes must be repeatably consumable");
    return JSON.parse(second.toString("utf8")) as ProductionSourceCanonicalDocument;
}

function assertUnresolvedAttachment(result: ProductionSourceReadResult, label: string): void {
    assert.equal(result.fullSourceRead.status, "unresolved", `${label} must not produce a frozen source payload`);
    assert.equal(result.fullSourceRead.payload, null);
    assert.equal(result.fullSourceRead.sourceSnapshot, null);
    assert.equal(result.sourceSnapshot, null);
    assert.ok(
        result.fullSourceRead.issues.some(issue => issue.code === "source_unavailable"),
        `${label} must report the attachment as unavailable for verification`,
    );
}

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-production-source-readers-"));
    try {
    assert.equal(PRODUCTION_SOURCE_FORMATTER_VERSION, "canonical-json-nfc-lf/v2");
    assert.ok(isSupportedProductionSourceFormatterVersion(PRODUCTION_SOURCE_FORMATTER_VERSION_V1));
    assert.ok(isSupportedProductionSourceFormatterVersion(PRODUCTION_SOURCE_FORMATTER_VERSION));
    assert.equal(isSupportedProductionSourceFormatterVersion("canonical-json-nfc-lf/v3"), false);
    const codex = createCodexFixture(root, CODEX_ID, "normal");
    const damagedCodex = createCodexFixture(root, CODEX_DAMAGED_ID, "damaged", true);
    const claudeProjectsRoot = path.join(root, "claude-projects");
    const claudePath = path.join(claudeProjectsRoot, "project-a", `${CLAUDE_CODE_ID}.jsonl`);
    const damagedClaudePath = path.join(claudeProjectsRoot, "project-b", `${CLAUDE_CODE_DAMAGED_ID}.jsonl`);
    const growthClaudePath = path.join(claudeProjectsRoot, "project-c", `${CLAUDE_CODE_GROWTH_ID}.jsonl`);
    const deletedClaudePath = path.join(claudeProjectsRoot, "project-d", `${CLAUDE_CODE_DELETED_LOCAL_FILE_ID}.jsonl`);
    const replacedClaudePath = path.join(claudeProjectsRoot, "project-e", `${CLAUDE_CODE_REPLACED_LOCAL_FILE_ID}.jsonl`);
    const deletedLocalImagePath = path.join(root, "attachments", "deleted.png");
    const replacedLocalImagePath = path.join(root, "attachments", "replaced.png");
    fs.mkdirSync(path.dirname(replacedLocalImagePath), { recursive: true });
    fs.writeFileSync(replacedLocalImagePath, "replacement-image-bytes", "utf8");
    writeJsonl(claudePath, [
        { type: "user", message: { content: [{ type: "text", text: "CC e\u0301\r\n用户" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] } },
        { type: "assistant", message: { content: [{ type: "text", text: LARGE_UNICODE_LINE }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "cc-tool-secret" }] } },
        { type: "system", subtype: "compact_boundary", uuid: "compact-boundary" },
        {
            type: "user",
            parentUuid: "compact-boundary",
            isCompactSummary: true,
            message: { content: "This session is being continued from a previous conversation that ran out of context.\ncc-compact-secret" },
        },
    ]);
    writeJsonl(damagedClaudePath, [
        { type: "user", message: { content: [{ type: "text", text: "损坏前的消息" }] } },
    ], true);
    writeJsonl(growthClaudePath, [
        { type: "user", message: { content: [{ type: "text", text: "增长前的用户消息" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "增长前的助手消息" }] } },
    ]);
    writeJsonl(deletedClaudePath, [
        { type: "user", message: { content: [{ type: "text", text: "已删除本地图像" }, { type: "image", source: { path: deletedLocalImagePath } }] } },
    ]);
    writeJsonl(replacedClaudePath, [
        { type: "user", message: { content: [{ type: "text", text: "已替换本地图像" }, { type: "image", source: { path: replacedLocalImagePath } }] } },
    ]);

    const claudeIoCounter = { calls: 0 };
    const claudeFileSystem = createCountingClaudeFileSystem(claudeIoCounter);
    const windsurf = createWindsurfController();
    const antigravity = createAntigravityController();
    let scanSequence = 0;
    const reader = createProductionSourceReader({
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        scanIdFactory: host => `fixture-${host}-${++scanSequence}`,
        antigravityIo: antigravity.io,
    });

    const codexRequest = {
        host: "codex" as const,
        conversationId: CODEX_ID,
        workspace: { workspaceId: "codex-fixture", canonicalPath: root },
        paths: { stateDbPath: codex.stateDbPath, rolloutRoots: [codex.sessionsRoot] },
    };
    const claudeRequest = {
        host: "claude-code" as const,
        conversationId: CLAUDE_CODE_ID,
        projectsRoot: claudeProjectsRoot,
        workspaceId: "claude-fixture",
        workspacePath: root,
        readChunkBytes: 4096,
        maxLineBytes: 1024 * 1024,
        fileSystem: claudeFileSystem,
    };
    const windsurfRequest = {
        host: "windsurf" as const,
        conversationId: WINDSURF_ID,
        transport: windsurf.transport,
        workspaceId: "windsurf-fixture",
        workspacePath: root,
    };
    const antigravityRequest = {
        host: "antigravity" as const,
        conversationId: ANTIGRAVITY_ID,
        workspaceId: "antigravity-fixture",
        workspacePath: root,
        source: { endpoint: "fixture-ls:9000", pbRoot: "/fixture/pb", vscdbPath: "/fixture/state.vscdb" },
    };

    const results = await Promise.all([
        reader.scan(codexRequest),
        reader.scan(claudeRequest),
        reader.scan(windsurfRequest),
        reader.scan(antigravityRequest),
    ]);
    const documents = [
        assertComplete(results[0], "codex"),
        assertComplete(results[1], "claude-code"),
        assertComplete(results[2], "windsurf"),
        assertComplete(results[3], "antigravity"),
    ];
    assert.equal(new Set(results.map(result => result.scanId)).size, 4, "every scan must have an independent scanId");
    assert.deepEqual(documents.map(document => document.source.host), ["codex", "claude-code", "windsurf", "antigravity"]);
    assert.equal(documents[0].messages[0]?.content, "Codex é\n用户");
    assert.equal(documents[1].messages[0]?.content, "CC é\n用户");
    assert.equal(documents[1].messages[1]?.content, LARGE_UNICODE_LINE.normalize("NFC"));
    assert.equal(documents[2].messages[0]?.content, "WSF é\n用户");
    assert.equal(documents[3].messages[0]?.content, "AG é\n用户");
    assert.deepEqual(documents[0].messages.slice(2).map(message => [
        message.role,
        message.content,
        message.attachments?.length || 0,
    ]), [
        ["user", "", 1],
        ["user", "连续同文", 0],
        ["user", "连续同文", 0],
    ], "纯空白传输消息应省略，附件真人消息与连续同文真人消息必须按语义顺序保留");
    assert.deepEqual(documents[0].messages.map(message => message.order), [1, 2, 3, 4, 5]);
    for (const document of documents) {
        const attachment = document.messages.flatMap(message => message.attachments || [])[0];
        assert.ok(attachment, `${document.source.host} must retain at least one attachment descriptor`);
        assert.match(attachment.sha256 || "", /^sha256:[0-9a-f]{64}$/u);
        assert.ok(!JSON.stringify(document).includes("data:"), `${document.source.host} canonical source must not leak data URLs`);
        assert.ok(!JSON.stringify(document).includes("aGk="), `${document.source.host} canonical source must not leak base64`);
    }
    const serializedDocuments = documents.map(document => JSON.stringify(document));
    for (const forbidden of ["codex-tool-secret", "codex-tool-only-secret", "codex-compact-secret", "cc-tool-secret", "cc-compact-secret", "wsf-tool-secret", "ag-tool-secret"]) {
        assert.ok(serializedDocuments.every(document => !document.includes(forbidden)), `${forbidden} must not enter canonical content`);
    }

    const secondResults = await Promise.all([
        reader.scan(codexRequest),
        reader.scan(claudeRequest),
        reader.scan(windsurfRequest),
        reader.scan(antigravityRequest),
    ]);
    for (let index = 0; index < results.length; index += 1) {
        const first = results[index].fullSourceRead;
        const second = secondResults[index].fullSourceRead;
        if (first.status !== "complete" || second.status !== "complete") assert.fail("stable source should remain complete");
        assert.deepEqual(Buffer.from(first.payload.bytes), Buffer.from(second.payload.bytes), "canonical bytes must be scan-independent");
        assert.equal(first.payload.contentHash, second.payload.contentHash);
        assert.notEqual(results[index].scanId, secondResults[index].scanId);
    }

    const offlineCodexPath = `${codex.rolloutPath}.offline`;
    fs.renameSync(codex.rolloutPath, offlineCodexPath);
    try {
        assert.deepEqual(replayPayload(results[0]), documents[0]);
    } finally {
        fs.renameSync(offlineCodexPath, codex.rolloutPath);
    }
    const offlineClaudePath = `${claudePath}.offline`;
    fs.renameSync(claudePath, offlineClaudePath);
    const claudeCallsBeforeReplay = claudeIoCounter.calls;
    try {
        assert.deepEqual(replayPayload(results[1]), documents[1]);
        assert.equal(claudeIoCounter.calls, claudeCallsBeforeReplay, "replaying CC bytes must not touch the host filesystem");
    } finally {
        fs.renameSync(offlineClaudePath, claudePath);
    }
    const windsurfCallsBeforeReplay = { ...windsurf.calls };
    const antigravityCallsBeforeReplay = { ...antigravity.calls };
    assert.deepEqual(replayPayload(results[2]), documents[2]);
    assert.deepEqual(replayPayload(results[3]), documents[3]);
    assert.deepEqual(windsurf.calls, windsurfCallsBeforeReplay, "replaying WSF bytes must not call LS");
    assert.deepEqual(antigravity.calls, antigravityCallsBeforeReplay, "replaying AG bytes must not call LS/.pb/vscdb");

    const projectedFullRead = await reader.readFull(codexRequest);
    assert.equal(projectedFullRead.status, "complete");
    if (projectedFullRead.status === "complete") parsePayload(projectedFullRead.payload);

    const maxExceeded = await reader.scan({ ...claudeRequest, maxContentBytes: 512 });
    assert.equal(maxExceeded.classification.state, "Unresolved");
    assert.equal(maxExceeded.fullSourceRead.status, "unresolved");
    assert.equal(maxExceeded.fullSourceRead.payload, null);
    assert.ok(maxExceeded.fullSourceRead.issues.some(issue => issue.code === "limit_reached"));
    assert.equal(maxExceeded.sourceSnapshot, null);

    const damagedCodexResult = await reader.scan({
        ...codexRequest,
        conversationId: CODEX_DAMAGED_ID,
        paths: { stateDbPath: damagedCodex.stateDbPath, rolloutRoots: [damagedCodex.sessionsRoot] },
    });
    assert.equal(damagedCodexResult.fullSourceRead.status, "unresolved");
    assert.equal(damagedCodexResult.fullSourceRead.payload, null);
    assert.ok(damagedCodexResult.fullSourceRead.issues.some(issue => issue.code === "parse_error"));

    const damagedClaudeResult = await reader.scan({ ...claudeRequest, conversationId: CLAUDE_CODE_DAMAGED_ID });
    assert.equal(damagedClaudeResult.fullSourceRead.status, "unresolved");
    assert.equal(damagedClaudeResult.fullSourceRead.payload, null);
    assert.ok(damagedClaudeResult.fullSourceRead.issues.some(issue => issue.code === "parse_error"));

    const deletedLocalFileResult = await reader.scan({ ...claudeRequest, conversationId: CLAUDE_CODE_DELETED_LOCAL_FILE_ID });
    const replacedLocalFileResult = await reader.scan({ ...claudeRequest, conversationId: CLAUDE_CODE_REPLACED_LOCAL_FILE_ID });
    assertUnresolvedAttachment(deletedLocalFileResult, "deleted Claude Code local-file attachment");
    assertUnresolvedAttachment(replacedLocalFileResult, "replaced Claude Code local-file attachment");

    let growthTriggered = false;
    const growthResult = await reader.scan({
        ...claudeRequest,
        conversationId: CLAUDE_CODE_GROWTH_ID,
        fileSystem: {
            readSync: (fileDescriptor, buffer, offset, length, position) => {
                const bytesRead = fs.readSync(fileDescriptor, buffer, offset, length, position);
                if (!growthTriggered) {
                    growthTriggered = true;
                    fs.appendFileSync(growthClaudePath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "读取期间增长" }] } })}\n`, "utf8");
                }
                return bytesRead;
            },
        },
    });
    assert.equal(growthResult.fullSourceRead.status, "unresolved");
    assert.equal(growthResult.fullSourceRead.payload, null);
    assert.ok(growthResult.fullSourceRead.issues.some(issue => issue.code === "revision_drift"));

    const growingWindsurf = createWindsurfController(true);
    const windsurfGrowthResult = await reader.scan({ ...windsurfRequest, transport: growingWindsurf.transport });
    assert.equal(windsurfGrowthResult.fullSourceRead.status, "unresolved");
    assert.equal(windsurfGrowthResult.fullSourceRead.payload, null);
    assert.ok(windsurfGrowthResult.fullSourceRead.issues.some(issue => issue.code === "revision_drift"));

    antigravity.setAssistantText("AG 同 revision 下被改写的助手消息");
    const contradictoryAntigravity = await reader.scan(antigravityRequest);
    assert.equal(contradictoryAntigravity.fullSourceRead.status, "unresolved");
    assert.equal(contradictoryAntigravity.fullSourceRead.payload, null);
    assert.equal(contradictoryAntigravity.classification.reason, "revision-drift");
    assert.ok(contradictoryAntigravity.fullSourceRead.issues.some(issue => issue.code === "revision_drift"));
    assert.equal(contradictoryAntigravity.fullSourceRead.authority.contradiction?.kind, "same-revision-different-bytes");
    assert.notEqual(
        contradictoryAntigravity.fullSourceRead.authority.contradiction?.previousContentHash,
        contradictoryAntigravity.fullSourceRead.authority.contradiction?.observedContentHash,
    );

    const singleAbsence = await reader.scan({
        ...antigravityRequest,
        conversationId: "44444444-4444-4444-8444-444444444444",
    });
    assert.equal(singleAbsence.classification.state, "Unresolved", "one complete absence cannot become Lost without a tombstone/second observation");
    assert.ok(singleAbsence.qualifiedAbsence);
    assert.equal(singleAbsence.enumeration.exactFetchResult, "not_found");
    assert.equal(singleAbsence.fullSourceRead.status, "unresolved");
    assert.equal(singleAbsence.fullSourceRead.payload, null);

    const localPath = "C:\\fixture\\private\\secret-report.png";
    const ordinaryUserText = `请保留 ${localPath} 和 data:text/plain;base64,c2FmZQ==`;
    const oversizedBase64 = "A".repeat(Math.ceil((MAX_PRODUCTION_SOURCE_ATTACHMENT_DECODE_BYTES + 1) / 3) * 4);
    const windowsLocalPath = "C:\\fixture\\evidence\\screenshots\\sample.png";
    const extendedWindowsLocalPath = "\\\\?\\c:\\FIXTURE\\evidence\\screenshots\\.\\sample.png";
    const uncLocalPath = "\\\\server\\share\\records\\.\\..\\blob.bin";
    const extendedUncLocalPath = "\\\\?\\UNC\\SERVER\\SHARE\\blob.bin";
    const posixUpperPath = "/var/Record-Source/Blob.bin";
    const posixLowerPath = "/var/record-source/blob.bin";
    const externalBlobHash = `sha256:${createHash("sha256").update("external-blob").digest("hex")}`;
    antigravity.setTrajectory({
        messages: [
            {
                role: "user",
                content: ordinaryUserText,
                attachments: [{
                    kind: "image", source: "codex-local-image", name: localPath, mimeType: "image/png",
                    dataUrl: "data:image/png;base64,aGk=", warning: `failed to read ${localPath}`,
                },
                { kind: "image", source: "codex-local-image", originalPath: windowsLocalPath, sha256: externalBlobHash },
                { kind: "file", source: "codex-local-file", originalPath: extendedWindowsLocalPath, sha256: externalBlobHash },
                { kind: "file", source: "claude-code-local-file", originalPath: uncLocalPath, sha256: externalBlobHash },
                { kind: "file", source: "claude-code-local-file", originalPath: extendedUncLocalPath, sha256: externalBlobHash },
                { kind: "file", source: "claude-code-local-file", originalPath: posixUpperPath, sha256: externalBlobHash },
                { kind: "file", source: "claude-code-local-file", originalPath: posixLowerPath, sha256: externalBlobHash },
                ],
            },
        ],
    });
    const attachmentReader = createProductionSourceReader({
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        scanIdFactory: host => `attachment-${host}`,
        antigravityIo: antigravity.io,
    });
    const attachmentDocument = assertComplete(await attachmentReader.scan(antigravityRequest), "antigravity");
    assert.equal(attachmentDocument.messages.length, 1, "Antigravity direct fallback must keep attachment messages");
    assert.equal(attachmentDocument.messages[0]?.content, ordinaryUserText, "ordinary user content must not be attachment-sanitized");
    const [safeAttachment, windowsAttachment, extendedWindowsAttachment, uncAttachment, extendedUncAttachment, posixUpperAttachment, posixLowerAttachment] = attachmentDocument.messages[0]?.attachments || [];
    assert.deepEqual(safeAttachment, {
        kind: "image",
        source: "codex-local-image",
        name: "attachment.png",
        mimeType: "image/png",
        sizeBytes: 2,
        sha256: `sha256:${createHash("sha256").update(Buffer.from("aGk=", "base64")).digest("hex")}`,
        warning: "attachment metadata warning redacted",
    });
    assert.equal(windowsAttachment?.source, "codex-local-image");
    assert.equal(windowsAttachment?.sha256, externalBlobHash);
    assert.equal(windowsAttachment?.reference, extendedWindowsAttachment?.reference);
    assert.equal(uncAttachment?.reference, extendedUncAttachment?.reference);
    assert.notEqual(posixUpperAttachment?.reference, posixLowerAttachment?.reference);
    const attachmentPayload = JSON.stringify(attachmentDocument.messages.flatMap(message => message.attachments || []));
    for (const forbidden of [localPath, windowsLocalPath, extendedWindowsLocalPath, uncLocalPath, extendedUncLocalPath, posixUpperPath, posixLowerPath, "data:image/png;base64,aGk="]) {
        assert.ok(!attachmentPayload.includes(forbidden), `attachment payload must redact ${forbidden.slice(0, 32)}`);
    }

    antigravity.setTrajectory({
        messages: [{
            role: "user",
            content: "超大附件",
            attachments: [{ kind: "file", source: "antigravity-raw-attachment", dataUrl: `data:application/octet-stream;base64,${oversizedBase64}` }],
        }],
    });
    let unverifiedScanSequence = 0;
    const unverifiedAttachmentReader = createProductionSourceReader({
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        scanIdFactory: host => `unverified-${host}-${++unverifiedScanSequence}`,
        antigravityIo: antigravity.io,
    });
    assertUnresolvedAttachment(await unverifiedAttachmentReader.scan(antigravityRequest), "warning/reference-only attachment");
    assertUnresolvedAttachment(
        await unverifiedAttachmentReader.scan({ ...windsurfRequest, transport: createWindsurfController(false, [{ mimeType: "image/png" }]).transport }),
        "Windsurf attachment without base64",
    );
    assertUnresolvedAttachment(
        await unverifiedAttachmentReader.scan({ ...windsurfRequest, transport: createWindsurfController(false, [{ mimeType: "image/png", base64Data: "not-base64!" }]).transport }),
        "Windsurf attachment with invalid base64",
    );

    console.log("record-production-source-readers tests passed");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
