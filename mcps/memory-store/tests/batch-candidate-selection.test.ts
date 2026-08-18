import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceHashForRecord } from "../src/record-store.js";
import { DATA_ROOT } from "../src/store.js";
import {
    __recordConcurrencyTest,
    effectiveRecordBatchLimit,
    formatRecordBatchCandidateDiagnostics,
    formatStaleCheckNoStaleSummary,
    recordBatchGenerateForce,
    registerRecord,
    resolveBatchCandidateWorkspace,
    selectRecordBatchCandidates,
} from "../src/tools/record.js";

const workspaceParent = "C:/fixtures/parent";
const workspaceChild = "C:/fixtures/parent/child";
const parentHash = resolveWorkspaceHashForRecord(workspaceParent);
const childHash = resolveWorkspaceHashForRecord(workspaceChild);
const recordUpdatedAt = "2026-07-11T00:00:00.000Z";
const recordUpdatedMs = Date.parse(recordUpdatedAt);

const candidates = [
    { id: "stale-a", workspace: workspaceChild, workspaceHash: childHash, chain: "codex" as const, lastModifiedMs: recordUpdatedMs + 60_001 },
    { id: "stale-b", workspace: workspaceChild, workspaceHash: childHash, chain: "codex" as const, lastModifiedMs: recordUpdatedMs + 60_001 },
    { id: "missing", workspace: workspaceParent, workspaceHash: parentHash, chain: "codex" as const, lastModifiedMs: recordUpdatedMs + 200_000 },
    { id: "fresh", workspace: workspaceParent, workspaceHash: parentHash, chain: "codex" as const, lastModifiedMs: recordUpdatedMs + 60_000 },
    { id: "conflict", workspace: workspaceParent, workspaceHash: parentHash, chain: "codex" as const, lastModifiedMs: recordUpdatedMs + 200_000 },
    { id: "wsf-rename", workspace: workspaceParent, workspaceHash: parentHash, chain: "windsurf" as const, lastModifiedMs: recordUpdatedMs + 200_000, stepCount: 7 },
    { id: "wsf-content", workspace: workspaceParent, workspaceHash: parentHash, chain: "windsurf" as const, lastModifiedMs: recordUpdatedMs + 200_000 },
];

const recordsByWorkspaceHash = {
    [parentHash]: {
        fresh: { chain: "codex", lastUpdatedAt: recordUpdatedAt, totalSteps: 4 },
        conflict: { chain: "windsurf", lastUpdatedAt: recordUpdatedAt, totalSteps: 4 },
        "wsf-rename": { chain: "windsurf", lastUpdatedAt: recordUpdatedAt, totalSteps: 7 },
        "wsf-content": { chain: "windsurf", lastUpdatedAt: recordUpdatedAt, totalSteps: 7 },
    },
    [childHash]: {
        "stale-a": { chain: "codex", lastUpdatedAt: recordUpdatedAt, totalSteps: 4 },
        "stale-b": { chain: "codex", lastUpdatedAt: recordUpdatedAt, totalSteps: 4 },
    },
};

const defaultSelection = selectRecordBatchCandidates(candidates, recordsByWorkspaceHash, { limit: 10, sourceEnumerationLimited: true });
assert.deepEqual(defaultSelection.candidates.map(item => item.id), ["wsf-content", "stale-a", "stale-b", "missing"]);
assert.deepEqual(defaultSelection.candidates.map(item => item.selectionKind), ["stale", "stale", "stale", "missing"]);
assert.deepEqual(defaultSelection.candidates.map(item => item.refreshExisting), [true, true, true, false]);
assert.equal(defaultSelection.diagnostics.scanned, 7);
assert.equal(defaultSelection.diagnostics.eligible, 4);
assert.equal(defaultSelection.diagnostics.selected, 4);
assert.equal(defaultSelection.diagnostics.truncated, 0);
assert.equal(defaultSelection.diagnostics.conflicts, 1);
assert.equal(defaultSelection.diagnostics.sourceEnumerationLimited, true);
assert.equal(defaultSelection.diagnostics.workspaceUnresolved, 0);

const staleOnly = selectRecordBatchCandidates(candidates, recordsByWorkspaceHash, { force: false, stale_only: true, limit: 10 });
const staleOnlyForced = selectRecordBatchCandidates(candidates, recordsByWorkspaceHash, { force: true, stale_only: true, limit: 10 });
assert.deepEqual(staleOnlyForced.candidates, staleOnly.candidates, "stale_only must override force");
assert.deepEqual(staleOnly.candidates.map(item => item.id), ["wsf-content", "stale-a", "stale-b"]);

const forced = selectRecordBatchCandidates(candidates, recordsByWorkspaceHash, { force: true, limit: 10 });
assert.deepEqual(forced.candidates.map(item => item.id), ["wsf-content", "stale-a", "stale-b", "missing", "wsf-rename", "fresh"]);
assert.equal(forced.candidates.find(item => item.id === "fresh")?.refreshExisting, true, "force refreshes fresh Records");
assert.equal(recordBatchGenerateForce(defaultSelection.candidates[0]), true, "stale Record bypasses generator latest short-circuit");
assert.equal(recordBatchGenerateForce(defaultSelection.candidates.at(-1)!), false, "missing Record uses normal generation");

const truncated = selectRecordBatchCandidates(candidates, recordsByWorkspaceHash, { force: true, limit: 1 });
assert.deepEqual(truncated.candidates.map(item => item.id), ["wsf-content"]);
assert.equal(truncated.diagnostics.truncated, 5);

assert.equal(effectiveRecordBatchLimit(undefined, false), 10);
assert.equal(effectiveRecordBatchLimit(undefined, true), 200);
assert.equal(effectiveRecordBatchLimit(200, false), 50);
assert.equal(effectiveRecordBatchLimit(200, true), 200);

assert.equal(
    resolveBatchCandidateWorkspace({}, "antigravity", workspaceParent),
    null,
    "Antigravity candidate without a detected workspace must not fall back to general",
);
assert.equal(
    resolveBatchCandidateWorkspace({
        workspace: "C:/fixtures/other",
        workspaceUris: ["C:/fixtures/other", workspaceParent],
    }, "windsurf", workspaceParent),
    workspaceParent,
    "Windsurf must use a matching workspaceUris entry when cwd is not in the requested workspace",
);

const readyPayload = {
    kind: "record-batch-update",
    actionName: "batch_update",
    resumeKey: "selection-test",
    workspaceHash: parentHash,
    dataChain: "codex",
    modelChain: "auto",
    force: false,
    stale_only: true,
    phase: "ready",
    candidates: defaultSelection.candidates,
    diagnostics: defaultSelection.diagnostics,
};
assert.ok(__recordConcurrencyTest.parseBatchResumePayload(readyPayload), "ready payload preserves selection metadata for recovery");
const updatePayload = __recordConcurrencyTest.parseUpdateResumePayload({
    kind: "record-update",
    conversationId: "resume-cache-boundary",
    workspace: workspaceParent,
    workspaceHash: parentHash,
    dataChain: "codex",
    modelChain: "grok",
    sourceCacheReference: {
        cacheReadStartRound: 37,
        sourceSnapshot: { kind: "conversation-fetch-cache" },
    },
});
assert.equal(
    updatePayload?.sourceCacheReference?.cacheReadStartRound,
    37,
    "record update recovery schema must preserve the rollback-safe cache read boundary",
);
const legacyPayload = __recordConcurrencyTest.parseBatchResumePayload({
    ...readyPayload,
    candidates: [{ id: "legacy", workspace: workspaceParent }],
});
assert.equal(legacyPayload?.candidates[0]?.refreshExisting, true, "legacy recovery must conservatively refresh existing Records");
assert.equal(legacyPayload?.candidates[0]?.selectionKind, "fresh");

const legacyPreparingResumeKey = `legacy-preparing-${Date.now()}`;
const legacyLedgerPath = path.join(DATA_ROOT, "record-task-recovery", `record-batch-${legacyPreparingResumeKey}.json`);
const legacyPreparingPayload = {
    kind: "record-batch-update",
    actionName: "batch_update",
    resumeKey: legacyPreparingResumeKey,
    dataChain: "codex",
    modelChain: "auto",
    force: false,
    stale_only: true,
    phase: "preparing",
    request: { workspace: workspaceParent, limit: 1 },
};
for (const { legacyLimit, normalizedLimit } of [
    { legacyLimit: 0, normalizedLimit: undefined },
    { legacyLimit: 1.8, normalizedLimit: 1 },
    { legacyLimit: 201, normalizedLimit: 200 },
]) {
    const parsedLegacyPreparing = __recordConcurrencyTest.parseBatchResumePayload({
        ...legacyPreparingPayload,
        request: { workspace: workspaceParent, limit: legacyLimit },
    });
    assert.ok(parsedLegacyPreparing && "request" in parsedLegacyPreparing, "legacy preparing payload must remain recoverable");
    assert.equal(parsedLegacyPreparing.request.limit, normalizedLimit, `legacy limit ${legacyLimit} must be normalized during recovery`);
}
await fs.mkdir(path.dirname(legacyLedgerPath), { recursive: true });
await fs.writeFile(legacyLedgerPath, JSON.stringify({
    version: 1,
    resumeKey: legacyPreparingResumeKey,
    updatedAt: new Date().toISOString(),
    candidates: [{ id: "legacy-preparing", workspace: workspaceParent }],
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [],
}), "utf-8");
try {
    const prepared = await __recordConcurrencyTest.prepareBatchPayload(legacyPreparingPayload);
    const recoveredCandidate = prepared.payload?.candidates[0];
    assert.equal(recoveredCandidate?.chain, "codex");
    assert.equal(recoveredCandidate?.lastModifiedMs, 0);
    assert.equal(recoveredCandidate?.selectionKind, "fresh");
    assert.equal(recoveredCandidate?.refreshExisting, true, "legacy preparing recovery must bypass latest short-circuit");
    await __recordConcurrencyTest.ensureBatchLedger(prepared.payload);
    const readOnlyLedger = JSON.parse(await fs.readFile(legacyLedgerPath, "utf-8"));
    assert.equal(readOnlyLedger.version, 1, "read-only ensure must not rewrite a v1 ledger before a state mutation");
    await __recordConcurrencyTest.mutateBatchLedger(prepared.payload, "skipped", recoveredCandidate!, "test migration");
    const persistedLedger = JSON.parse(await fs.readFile(legacyLedgerPath, "utf-8"));
    assert.equal(persistedLedger.version, 2, "the next locked mutation must persist the normalized v2 ledger");
    assert.deepEqual(persistedLedger.candidates[0], recoveredCandidate, "legacy ledger must persist the normalized frozen candidate");
} finally {
    await fs.rm(legacyLedgerPath, { force: true });
}

let observedLegacyLimit: number | undefined;
__recordConcurrencyTest.setBatchCandidateCollector(async (_chain, args) => {
    observedLegacyLimit = args.limit;
    return {
        candidates: [],
        emptyReason: "📦 无符合条件的对话",
        diagnostics: {
            scanned: 4,
            eligible: 0,
            selected: 0,
            truncated: 0,
            conflicts: 1,
            sourceEnumerationLimited: true,
            workspaceUnresolved: 2,
        },
    };
});
try {
    const emptyPrepared = await __recordConcurrencyTest.prepareBatchPayload({
        ...legacyPreparingPayload,
        resumeKey: `legacy-empty-${Date.now()}`,
        request: { workspace: workspaceParent, limit: 0 },
    });
    assert.equal(observedLegacyLimit, undefined, "legacy limit=0 must recover with the normal default limit");
    assert.match(emptyPrepared.result || "", /scanned=4 eligible=0 selected=0 truncated=0 source-limit=yes conflicts=1/);
    assert.match(emptyPrepared.result || "", /workspace-unresolved=2\(Antigravity workspace 未解析，已跳过\)/);
} finally {
    __recordConcurrencyTest.setBatchCandidateCollector(null);
}

assert.match(
    formatRecordBatchCandidateDiagnostics({
        scanned: 0,
        eligible: 0,
        selected: 0,
        truncated: 0,
        conflicts: 0,
        sourceEnumerationLimited: false,
        workspaceUnresolved: 1,
    }),
    /source-limit=no conflicts=0 workspace-unresolved=1\(Antigravity workspace 未解析，已跳过\)/,
    "empty candidate diagnostics must explain an unresolved Antigravity workspace",
);
assert.match(formatStaleCheckNoStaleSummary(2), /未发现确认过期，仍有 2 份 unresolved/);
assert.doesNotMatch(formatStaleCheckNoStaleSummary(2), /所有 Record 均已跟进到最新/);
assert.match(formatStaleCheckNoStaleSummary(0), /所有 Record 均已跟进到最新/);

const registeredTools: Array<{ name: string; schema: Record<string, { safeParse(value: unknown): { success: boolean } }> }> = [];
registerRecord({
    tool(name: string, _description: string, schema: Record<string, { safeParse(value: unknown): { success: boolean } }>) {
        registeredTools.push({ name, schema });
    },
} as never);
const recordManageSchema = registeredTools.find(tool => tool.name === "record_manage")?.schema;
assert.ok(recordManageSchema, "record_manage public schema should be registered");
assert.equal(recordManageSchema.limit.safeParse(1).success, true);
assert.equal(recordManageSchema.limit.safeParse(200).success, true);
assert.equal(recordManageSchema.limit.safeParse(0).success, false);
assert.equal(recordManageSchema.limit.safeParse(1.5).success, false);
assert.equal(recordManageSchema.limit.safeParse(201).success, false);
assert.equal(recordManageSchema.stale_only.safeParse(true).success, true);

console.log("✅ batch candidate selection tests passed");
