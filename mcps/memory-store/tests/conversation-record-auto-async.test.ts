import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-record-auto-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { RECORD_AUTO_THRESHOLD } = await import("../src/record-config.ts");
const { writeRecord } = await import("../src/record-store.ts");
const { shouldAutoUpdateRecord, shouldAutoUpdateRecordAsync } = await import("../src/record-generator.ts");
const { scheduleFetchRecordAutoUpdateForTest } = await import("../src/tools/conversation.ts");
const { normalizeRecordSourceCacheReferenceForScheduler } = await import("../src/tools/record.ts");

try {
    const hash = "conversation-record-auto-async";
    const conversationId = "conversation-record-auto-async-test";
    const threshold = RECORD_AUTO_THRESHOLD;

    assert.equal(shouldAutoUpdateRecord(hash, conversationId, threshold - 1), false);
    assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold - 1), false);
    assert.equal(shouldAutoUpdateRecord(hash, conversationId, threshold), true);
    assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold), true);

    await writeRecord(hash, conversationId, "# Record", {
        title: "异步自动更新检查",
        totalRounds: threshold,
        totalSteps: threshold,
        lastUpdatedRound: threshold,
        phases: 1,
    });

    assert.equal(shouldAutoUpdateRecord(hash, conversationId, threshold), false);
    assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold), false);
    assert.equal(shouldAutoUpdateRecord(hash, conversationId, threshold * 2), true);
    assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold * 2), true);

    const readFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync");
    Object.defineProperty(fs, "readFileSync", {
        configurable: true,
        value: () => {
            throw new Error("Record auto-update hot path must not use readFileSync");
        },
    });
    try {
        assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold), false);
        assert.equal(await shouldAutoUpdateRecordAsync(hash, conversationId, threshold * 2), true);
    } finally {
        if (readFileSyncDescriptor) Object.defineProperty(fs, "readFileSync", readFileSyncDescriptor);
        else Reflect.deleteProperty(fs, "readFileSync");
    }

    const fetchInput = {
        conversationId,
        chainUsed: "codex" as const,
        modelChain: "codex" as const,
        artifact: {
            tempPath: path.join(dataRoot, "fetch.md"),
            roundCount: threshold * 2,
            aiResponseCount: threshold * 2,
            toolCallCount: 0,
            attachmentCount: 0,
        },
        totalSteps: threshold * 2,
        cacheKey: { source: "codex", conversationId },
        cacheGeneration: "generation-1",
        cacheFingerprint: { revision: "revision-1" },
        cacheState: "built" as const,
        sourceMode: "local" as const,
    };
    let admitCalls = 0;
    const commonDependencies = {
        isEnabled: () => true,
        findRecordHash: async () => hash,
        resolveWorkspaceHash: () => hash,
        shouldUpdate: async () => true,
    };

    const staleNote = await scheduleFetchRecordAutoUpdateForTest({
        ...fetchInput,
        cacheState: "stale",
        cacheBuildFailure: { name: "SourceError", message: "source changed" },
    }, {
        ...commonDependencies,
        admit: async () => {
            admitCalls += 1;
            return "unexpected";
        },
    });
    assert.match(staleNote, /source changed/u);
    assert.equal(admitCalls, 0, "stale fetch cache must never reach scheduler admission");

    const noUpdateNote = await scheduleFetchRecordAutoUpdateForTest(fetchInput, {
        ...commonDependencies,
        shouldUpdate: async () => false,
        admit: async () => {
            admitCalls += 1;
            return "unexpected";
        },
    });
    assert.match(noUpdateNote, /无需执行/u);
    assert.equal(admitCalls, 0, "below-threshold fetch must not reach scheduler admission");

    let admissionResolved = false;
    let admittedInput: Record<string, unknown> | undefined;
    const pendingAdmission = scheduleFetchRecordAutoUpdateForTest(fetchInput, {
        ...commonDependencies,
        admit: async input => {
            admittedInput = input as unknown as Record<string, unknown>;
            await new Promise(resolve => setTimeout(resolve, 20));
            admissionResolved = true;
            return "🚀 Record scheduler 已接纳更新 (新任务)\n🆔 taskId: record-task-39";
        },
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(admissionResolved, false, "fetch must not announce admission before scheduler persistence resolves");
    const admittedNote = await pendingAdmission;
    assert.match(admittedNote, /taskId: record-task-39/u);
    const admittedSnapshot = (admittedInput?.sourceSnapshot || {}) as Record<string, unknown>;
    assert.equal("cacheState" in admittedSnapshot, false, "built/hit cache state must not perturb scheduler admission identity");

    const unknownNote = await scheduleFetchRecordAutoUpdateForTest(fetchInput, {
        ...commonDependencies,
        admit: async () => "⚠️ Record scheduler 接纳结果未确定，未返回成功 taskId",
    });
    assert.match(unknownNote, /未被确认接纳/u);

    const failedNote = await scheduleFetchRecordAutoUpdateForTest(fetchInput, {
        ...commonDependencies,
        admit: async () => { throw new Error("ledger write failed"); },
    });
    assert.match(failedNote, /未接纳：ledger write failed/u);

    const normalizedBuilt = normalizeRecordSourceCacheReferenceForScheduler({
        cacheGeneration: { key: fetchInput.cacheKey, generation: "generation-1", fingerprint: fetchInput.cacheFingerprint },
        sourceSnapshot: { cacheState: "built", roundCount: 10 },
    });
    const normalizedHit = normalizeRecordSourceCacheReferenceForScheduler({
        cacheGeneration: { key: fetchInput.cacheKey, generation: "generation-1", fingerprint: fetchInput.cacheFingerprint },
        sourceSnapshot: { cacheState: "hit", roundCount: 10 },
    });
    assert.deepEqual(normalizedBuilt, normalizedHit, "built and hit must normalize to one immutable scheduler request identity");

    console.log("✅ conversation record auto async tests passed");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
