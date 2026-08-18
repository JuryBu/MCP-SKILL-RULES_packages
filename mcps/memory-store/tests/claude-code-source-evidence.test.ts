import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cc-source-evidence-"));
const projectsRoot = path.join(tempDir, "projects");
const workspaceId = "cc-source-evidence-fixture";
const workspacePath = path.join(tempDir, "workspace");
const sessionId = "11111111-2222-4333-8444-555555555555";
const secondSessionId = "22222222-2222-4333-8444-555555555555";
const damagedSessionId = "33333333-2222-4333-8444-555555555555";
const subagentParentId = "44444444-2222-4333-8444-555555555555";
const subagentId = "agent-source-evidence-child";
const longTailSessionId = "66666666-2222-4333-8444-555555555555";
const tailReferenceSessionId = "77777777-2222-4333-8444-555555555555";
const fidelitySessionId = "88888888-2222-4333-8444-555555555555";
const truncatedContentSessionId = "99999999-2222-4333-8444-555555555555";

process.env.MEMORY_STORE_CC_ATTACHMENT_MAX_BYTES = "2";

function writeJsonl(filePath: string, events: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function sourceOptions(conversationId: string, extra: Record<string, unknown> = {}) {
    return {
        conversationId,
        projectsRoot,
        workspaceId,
        workspacePath,
        scanId: "cc-source-evidence-scan-001",
        now: () => new Date("2026-07-13T12:00:00.000Z"),
        ...extra,
    };
}

fs.mkdirSync(workspacePath, { recursive: true });
writeJsonl(path.join(projectsRoot, "a-project", `${sessionId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "需要纳入内容游标的用户消息" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "需要纳入内容游标的助手回复" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "不应污染游标" }] } },
    { type: "system", subtype: "compact_boundary", uuid: "compact-boundary" },
    {
        type: "user",
        parentUuid: "compact-boundary",
        isCompactSummary: true,
        message: { content: "This session is being continued from a previous conversation that ran out of context.\nSummary" },
    },
]);
writeJsonl(path.join(projectsRoot, "b-project", `${secondSessionId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "第二个会话" }] } },
]);
writeJsonl(path.join(projectsRoot, "c-project", `${damagedSessionId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "损坏行前的内容" }] } },
]);
fs.appendFileSync(path.join(projectsRoot, "c-project", `${damagedSessionId}.jsonl`), "{not-json}\n", "utf8");
writeJsonl(path.join(projectsRoot, "d-project", subagentParentId, "subagents", `${subagentId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "子代理消息" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "子代理回复" }] } },
]);
const longTailMeaningfulEvents = [
    { type: "user", message: { content: [{ type: "text", text: "长尾前的意义用户消息" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "长尾前的意义助手回复" }] } },
];
const toolTailEvents = Array.from({ length: 320 }, (_, index) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: `tail-tool-${index}`, content: `tool tail ${index}` }] },
}));
writeJsonl(path.join(projectsRoot, "e-project", `${longTailSessionId}.jsonl`), [
    ...longTailMeaningfulEvents,
    {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "oversized-tail-tool", content: "x".repeat(3 * 1024 * 1024) }] },
    },
    ...toolTailEvents,
]);
writeJsonl(path.join(projectsRoot, "f-project", `${tailReferenceSessionId}.jsonl`), longTailMeaningfulEvents);
writeJsonl(path.join(projectsRoot, "g-project", `${fidelitySessionId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "" }] } },
    { type: "user", message: { content: [{ type: "text", text: "  \n" }] } },
    { type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-only", content: "must-not-be-message" }] } },
    { type: "user", message: { content: [{ type: "image", source: { type: "opaque" } }] } },
    { type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "Y W J j\n" } }] } },
]);
writeJsonl(path.join(projectsRoot, "h-project", `${truncatedContentSessionId}.jsonl`), [
    { type: "user", message: { content: [{ type: "text", text: "x".repeat(200_001) }] } },
]);

const {
    enumerateClaudeCodeSourceEvidence,
    fetchClaudeCodeSourceEvidence,
    inspectClaudeCodeSourceEvidence,
    readClaudeCodeFullSourceEvidence,
} = await import("../src/claude-code-client.ts");

try {
    const enumeration = enumerateClaudeCodeSourceEvidence(sourceOptions(sessionId));
    assert.equal(enumeration.enumeration.enumerationComplete, true);
    assert.equal(enumeration.enumeration.pagination.truncated, false);
    assert.ok(enumeration.enumeration.pagination.pages >= 5, "nested projects must be scanned as multiple filesystem pages");
    assert.equal(enumeration.enumeration.targetStatus, "present");
    assert.equal(enumeration.session?.conversationId, sessionId);

    const exact = fetchClaudeCodeSourceEvidence(sourceOptions(sessionId));
    assert.equal(exact.exactFetch.exactFetchResult, "present");
    assert.equal(exact.exactFetch.errors.length, 0);

    const complete = inspectClaudeCodeSourceEvidence(sourceOptions(sessionId, { snapshotId: "cc-source-evidence-complete" }));
    assert.equal(complete.classification.state, "Present");
    assert.ok(complete.fullSourceRead);
    assert.equal(complete.fullSourceRead.enumerationComplete, true);
    assert.equal(complete.fullSourceRead.cacheBypassed, true);
    assert.match(complete.fullSourceRead.sourceRevision.contentCursor || "", /^sha256:[0-9a-f]{64}$/u);
    assert.ok(complete.snapshot, "only a complete, cache-bypassed read may create a snapshot");
    assert.equal(complete.snapshot?.snapshotId, "cc-source-evidence-complete");
    assert.match(complete.snapshot?.snapshotHash || "", /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(complete.sourceMessages, [
        { role: "user", text: "需要纳入内容游标的用户消息" },
        { role: "assistant", text: "需要纳入内容游标的助手回复" },
    ], "full JSONL read must expose meaningful user/assistant messages while excluding tool_result and compact summary events");

    const fidelity = inspectClaudeCodeSourceEvidence(sourceOptions(fidelitySessionId));
    assert.deepEqual(fidelity.sourceMessages?.map(message => [message.role, message.text]), [
        ["user", ""],
        ["user", "  \n"],
        ["user", ""],
        ["assistant", ""],
        ["user", ""],
        ["user", ""],
    ]);
    assert.equal(fidelity.sourceMessages?.[2]?.attachments?.[0]?.sizeBytes, 2, "attachment-only input must retain its decoded size in source evidence");
    assert.match(fidelity.sourceMessages?.[2]?.attachments?.[0]?.sha256 || "", /^sha256:[0-9a-f]{64}$/u, "attachment-only input must retain a stable content hash");
    assert.equal(fidelity.sourceMessages?.[2]?.attachments?.[0]?.dataUrl, undefined, "fetch cache must not duplicate inline image bytes into source evidence");
    assert.match(fidelity.sourceMessages?.[2]?.attachments?.[0]?.warning || "", /data URL omitted from cache/u, "source evidence must explain that image bytes were intentionally omitted");
    assert.match(fidelity.sourceMessages?.[4]?.attachments?.[0]?.warning || "", /could not be resolved/u, "unparseable attachments must remain as warnings");
    assert.equal(fidelity.sourceMessages?.[5]?.attachments?.[0]?.sizeBytes, 3, "base64 size must be estimated before data URL materialization");
    assert.equal(fidelity.sourceMessages?.[5]?.attachments?.[0]?.dataUrl, undefined, "oversized base64 must not be copied into a data URL");
    assert.match(fidelity.sourceMessages?.[5]?.attachments?.[0]?.warning || "", /estimated at 3 bytes exceeds configured 2-byte limit/u);
    assert.equal(fidelity.sourceMessages?.some(message => message.text.includes("must-not-be-message")), false, "tool-only messages must stay excluded");

    const standaloneFullRead = readClaudeCodeFullSourceEvidence(sourceOptions(secondSessionId));
    assert.ok(standaloneFullRead.snapshot, "standalone full reads must share one generated scanId across enumeration and exact fetch");

    const truncatedContent = inspectClaudeCodeSourceEvidence(sourceOptions(truncatedContentSessionId));
    assert.equal(truncatedContent.contentTruncated, undefined, "fetch source evidence must preserve long text instead of applying model-return limits");
    assert.equal(truncatedContent.fullSourceRead?.enumerationComplete, true, "complete long source content must remain eligible for a reusable snapshot");
    assert.equal(truncatedContent.fullSourceRead?.pagination.truncated, false, "long text alone must not create a pagination truncation");
    assert.equal(truncatedContent.fullSourceRead?.errors.some((issue) => issue.code === "limit_reached"), false);
    assert.ok(truncatedContent.snapshot, "complete long source content must produce a reusable snapshot");
    assert.equal(truncatedContent.sourceMessages?.[0]?.text.length, 200_001, "fetch source evidence must retain every text character");

    const limited = inspectClaudeCodeSourceEvidence(sourceOptions(sessionId, { limit: 1 }));
    assert.equal(limited.enumeration.enumerationComplete, false);
    assert.equal(limited.enumeration.pagination.limit, 1);
    assert.equal(limited.enumeration.pagination.truncated, true);
    assert.equal(limited.fullSourceRead?.enumerationComplete, false);
    assert.equal(limited.snapshot, null);
    assert.equal(limited.classification.state, "Unresolved");
    assert.equal(limited.classification.reason, "pagination-limit");

    const limitedUnknown = inspectClaudeCodeSourceEvidence(sourceOptions(secondSessionId, { limit: 1 }));
    assert.equal(limitedUnknown.enumeration.enumerationComplete, false);
    assert.equal(limitedUnknown.enumeration.targetStatus, "unknown");
    assert.equal(limitedUnknown.enumeration.exactFetchResult, "unresolved");
    assert.ok(limitedUnknown.enumeration.warnings.some((issue) => issue.code === "limit_reached"));
    assert.equal(limitedUnknown.classification.state, "Unresolved");

    const missing = inspectClaudeCodeSourceEvidence(sourceOptions("55555555-2222-4333-8444-555555555555"));
    assert.equal(missing.enumeration.targetStatus, "absent");
    assert.equal(missing.exactFetch.exactFetchResult, "not_found");
    assert.equal(missing.fullSourceRead, null);
    assert.notEqual(missing.classification.reason, "adapter-error");

    const damaged = inspectClaudeCodeSourceEvidence(sourceOptions(damagedSessionId));
    assert.equal(damaged.exactFetch.exactFetchResult, "present", "the file exists even when its JSONL body is malformed");
    assert.ok(damaged.fullSourceRead?.errors.some((issue) => issue.code === "parse_error"));
    assert.equal(damaged.fullSourceRead?.enumerationComplete, false);
    assert.equal(damaged.snapshot, null);
    assert.equal(damaged.classification.state, "Unresolved");
    assert.equal(damaged.classification.reason, "adapter-error");

    const subagent = inspectClaudeCodeSourceEvidence(sourceOptions(subagentId));
    assert.equal(subagent.session?.isSubagent, true);
    assert.equal(subagent.session?.parentConversationId, subagentParentId);
    assert.equal(subagent.session?.conversationId, subagentId);

    const readLengths: number[] = [];
    const readPositions: number[] = [];
    const boundedLongTail = inspectClaudeCodeSourceEvidence(sourceOptions(longTailSessionId, {
        readChunkBytes: 4096,
        fileSystem: {
            readFileSync: () => {
                throw new Error("source evidence must not read the whole JSONL");
            },
            readSync: (fileDescriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
                readLengths.push(length);
                readPositions.push(position);
                return fs.readSync(fileDescriptor, buffer, offset, length, position);
            },
        },
    }));
    const tailReference = inspectClaudeCodeSourceEvidence(sourceOptions(tailReferenceSessionId, { readChunkBytes: 4096 }));
    assert.ok(boundedLongTail.snapshot, "300+ tool tail events and a multi-megabyte line must still permit a complete snapshot");
    assert.equal(boundedLongTail.fullSourceRead?.errors.length, 0);
    assert.equal(
        boundedLongTail.fullSourceRead?.sourceRevision.contentCursor,
        tailReference.fullSourceRead?.sourceRevision.contentCursor,
        "tool-only tail events must not hide or alter the latest meaningful user/assistant cursor",
    );
    assert.ok(readLengths.length > 300, "the oversized fixture should require many bounded reads");
    assert.ok(readLengths.every((length) => length <= 4096), "every source read must respect the configured chunk bound");
    assert.ok(readPositions.some((position, index) => index > 0 && position < readPositions[index - 1]), "tail discovery must issue backward-positioned reads");

    const sourceFile = path.join(projectsRoot, "a-project", `${sessionId}.jsonl`);
    let readCount = 0;
    const drift = inspectClaudeCodeSourceEvidence(sourceOptions(sessionId, {
        fileSystem: {
            readSync: (fileDescriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
                readCount += 1;
                const bytesRead = fs.readSync(fileDescriptor, buffer, offset, length, position);
                if (readCount === 2) {
                    fs.appendFileSync(sourceFile, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "扫描期间增长" }] } }) + "\n", "utf8");
                }
                return bytesRead;
            },
        },
    }));
    assert.ok(drift.fullSourceRead?.errors.some((issue) => issue.code === "revision_drift"));
    assert.equal(drift.snapshot, null);
    assert.deepEqual(drift.classification, { state: "Unresolved", reason: "revision-drift" });

    const cached = inspectClaudeCodeSourceEvidence(sourceOptions(sessionId, { cacheBypassed: false }));
    assert.ok(cached.enumeration.warnings.some((issue) => issue.code === "cache_only"));
    assert.equal(cached.fullSourceRead, null);
    assert.equal(cached.snapshot, null);
    assert.deepEqual(cached.classification, { state: "Unresolved", reason: "cache-not-bypassed" });

    const permission = fetchClaudeCodeSourceEvidence(sourceOptions(sessionId, {
        fileSystem: {
            openSync: () => {
                const error = Object.assign(new Error("denied by fixture"), { code: "EACCES" });
                throw error;
            },
        },
    }));
    assert.equal(permission.exactFetch.exactFetchResult, "unresolved");
    assert.ok(permission.exactFetch.errors.some((issue) => issue.code === "permission_denied"));

    const directFullRead = readClaudeCodeFullSourceEvidence(sourceOptions(sessionId), enumeration, exact);
    assert.equal(directFullRead.snapshot, null, "a full read must not trust evidence from another scanId/revision context");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("claude-code-source-evidence: bounded reverse tail, limit unknown, parse, permission, subagent, drift, and cache cases passed");
