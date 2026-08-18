import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    MAX_RECORD_COMMIT_BODY_BYTES,
    RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION,
    RecordCommitIdReuseError,
    RecordCommitInitialGuardRejectedError,
    RecordCommitLedgerRepairRequiredError,
    RecordCommitProtocol,
    type JsonValue,
    type RecordCommitBinding,
    type RecordCommitBodyImage,
    type RecordCommitBodyRef,
    type RecordCommitJsonImage,
    type RecordCommitLedger,
    type RecordCommitPersistenceFaultInput,
    type RecordCommitPersistenceFaultPoint,
    type RecordCommitPayload,
    type RecordCommitProtocolAdapter,
    type RecordCommitStage,
    type RecordCommitTarget,
} from "../src/record-commit-protocol.ts";

type Fault = { stage: RecordCommitStage; point: "before_write" | "after_write" } | null;
type PersistenceFault = { stage: RecordCommitStage; point: RecordCommitPersistenceFaultPoint } | null;

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function clone<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}

function canonicalJson(value: JsonValue): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function jsonHash(value: JsonValue): string {
    return sha256(canonicalJson(value));
}

function utf8ByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function emptyBody(): RecordCommitBodyImage {
    return { bodyRef: null, bodyHash: null, byteLength: null, ownerCommitId: null, revision: null };
}

function emptyJson(): RecordCommitJsonImage {
    return { value: null, hash: null, ownerCommitId: null, revision: null };
}

function sameBodyRef(left: RecordCommitBodyRef | null, right: RecordCommitBodyRef | null): boolean {
    return left === null || right === null
        ? left === right
        : canonicalJson(left as unknown as JsonValue) === canonicalJson(right as unknown as JsonValue);
}

function sameBodyImage(left: RecordCommitBodyImage, right: RecordCommitBodyImage): boolean {
    return sameBodyRef(left.bodyRef, right.bodyRef)
        && left.bodyHash === right.bodyHash
        && left.byteLength === right.byteLength
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision;
}

function sameJsonImage(left: RecordCommitJsonImage, right: RecordCommitJsonImage): boolean {
    return left.hash === right.hash && left.ownerCommitId === right.ownerCommitId && left.revision === right.revision
        && canonicalJson(left.value) === canonicalJson(right.value);
}

class FakeCommitAdapter {
    readonly ledgers = new Map<string, RecordCommitLedger>();
    readonly bodyObjects = new Map<string, string>();
    readonly stagedBodies = new Map<string, RecordCommitBodyImage>();
    readonly isolated: Array<{ commitId: string; bodyRef: RecordCommitBodyRef; bodyHash: string; byteLength: number; reason: string }> = [];
    readonly boundedReadLimits: number[] = [];
    readonly writes: string[] = [];
    readonly ledgerCasRevisions: number[] = [];
    readonly persistenceFaultEvents: RecordCommitPersistenceFaultInput[] = [];
    readonly persistenceTimeline: string[] = [];
    readonly activeTaskIds = new Set<string>(["task-a"]);
    readonly detached: string[] = [];
    readonly provider = { postCount: 0 };
    body: RecordCommitBodyImage = emptyBody();
    mainIndex: RecordCommitJsonImage = emptyJson();
    readerIndex: RecordCommitJsonImage = emptyJson();
    cancelled = false;
    currentEpoch = 1;
    currentFence = 1;
    currentLeaseId = "lease-a";
    currentSourceSnapshotId = "snapshot-a";
    currentInputHash = "input-a";
    fault: Fault = null;
    persistenceFault: PersistenceFault = null;
    rejectTargets = false;
    rebuildReaderCalls = 0;
    afterDetach: (() => void) | null = null;
    afterRestoreMain: (() => void) | null = null;
    initialCasBarrier: (() => Promise<void>) | null = null;
    clock = 0;
    dynamicMetadata = false;
    metadataMaterializationCount = 0;

    createProtocol(): RecordCommitProtocol {
        return new RecordCommitProtocol(this.adapter());
    }

    generateRecord(bodyOverride?: string): { body: string; contentHash: string; byteLength: number } {
        this.provider.postCount += 1;
        const body = bodyOverride ?? `# record ${this.provider.postCount}`;
        return { body, contentHash: sha256(body), byteLength: utf8ByteLength(body) };
    }

    storeImmutableBody(body: string, currentBinding: Pick<RecordCommitBinding, "conversationId" | "recordId">, objectId: string): RecordCommitBodyRef {
        const existing = this.bodyObjects.get(objectId);
        if (existing !== undefined && existing !== body) throw new Error(`immutable body object ${objectId} was reused`);
        this.bodyObjects.set(objectId, body);
        return {
            kind: "immutable_record_body",
            conversationId: currentBinding.conversationId,
            recordId: currentBinding.recordId,
            objectId,
            relativePath: `record-output/${currentBinding.conversationId}/${currentBinding.recordId}/${objectId}.body`,
        };
    }

    setVisibleBody(body: string, ownerCommitId: string, revision: string, currentBinding: Pick<RecordCommitBinding, "conversationId" | "recordId">, objectId: string): void {
        const bodyRef = this.storeImmutableBody(body, currentBinding, objectId);
        this.body = { bodyRef, bodyHash: sha256(body), byteLength: utf8ByteLength(body), ownerCommitId, revision };
    }

    requireStoredBody(bodyRef: RecordCommitBodyRef, bodyHash: string, byteLength: number, maxBytes: number): string {
        const body = this.bodyObjects.get(bodyRef.objectId);
        if (body === undefined) throw new Error(`body object ${bodyRef.objectId} is missing`);
        const actualByteLength = utf8ByteLength(body);
        if (actualByteLength > maxBytes) throw new Error(`body object ${bodyRef.objectId} exceeded maxBytes`);
        if (actualByteLength !== byteLength || sha256(body) !== bodyHash) throw new Error(`body object ${bodyRef.objectId} descriptor mismatch`);
        return body;
    }

    adapter(): RecordCommitProtocolAdapter {
        return {
            durable: {
                readLedger: async commitId => clone(this.ledgers.get(commitId) || null),
                compareAndSwapInitialLedger: async (commitId, next) => {
                    await this.initialCasBarrier?.();
                    if (this.cancelled) return { kind: "rejected", guard: "cancelled", reason: "fake task cancelled" };
                    if (next.binding.recordCommitEpoch !== this.currentEpoch
                        || next.binding.fencingToken !== this.currentFence
                        || next.binding.workLeaseId !== this.currentLeaseId
                        || next.binding.sourceSnapshotId !== this.currentSourceSnapshotId
                        || next.binding.inputHash !== this.currentInputHash) {
                        return { kind: "rejected", guard: "stale", reason: "fake initial binding changed" };
                    }
                    if (this.ledgers.has(commitId)) return { kind: "conflict" };
                    this.ledgers.set(commitId, clone(next));
                    return { kind: "written" };
                },
                compareAndSwapLedger: async (commitId, expectedRevision, next) => {
                    const existing = this.ledgers.get(commitId);
                    if ((existing?.revision ?? null) !== expectedRevision) return { kind: "conflict" };
                    this.ledgerCasRevisions.push(next.revision);
                    this.persistenceTimeline.push(`cas:${expectedRevision}->${next.revision}`);
                    this.ledgers.set(commitId, clone(next));
                    return { kind: "written" };
                },
            },
            registry: {
                validate: async binding => {
                    if (binding.recordCommitEpoch !== this.currentEpoch || binding.fencingToken !== this.currentFence || binding.workLeaseId !== this.currentLeaseId) {
                        return { kind: "stale", reason: "epoch_or_fence_superseded" };
                    }
                    if (binding.sourceSnapshotId !== this.currentSourceSnapshotId || binding.inputHash !== this.currentInputHash) {
                        return { kind: "stale", reason: "source_or_input_changed" };
                    }
                    return {
                        kind: "authorized",
                        recordWorkKey: binding.recordWorkKey,
                        workLeaseId: binding.workLeaseId,
                        recordCommitEpoch: binding.recordCommitEpoch,
                        fencingToken: binding.fencingToken,
                        sourceSnapshotId: binding.sourceSnapshotId,
                        inputHash: binding.inputHash,
                    };
                },
                readSharedWork: async () => ({ activeTaskIds: [...this.activeTaskIds] }),
                detachTask: async binding => {
                    this.activeTaskIds.delete(binding.taskId);
                    this.detached.push(binding.taskId);
                    this.afterDetach?.();
                },
            },
            io: {
                validateTarget: async input => !this.rejectTargets
                    && input.target.kind === input.expectedKind
                    && input.target.conversationId === input.binding.conversationId
                    && input.target.recordId === input.binding.recordId
                    && !input.target.relativePath.startsWith("/")
                    && !input.target.relativePath.includes("..")
                    && !input.target.relativePath.includes("\\")
                    && !input.target.relativePath.includes("%"),
                validateBodyRef: async input => !this.rejectTargets
                    && input.bodyRef.kind === "immutable_record_body"
                    && input.bodyRef.conversationId === input.binding.conversationId
                    && input.bodyRef.recordId === input.binding.recordId
                    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.bodyRef.objectId)
                    && !input.bodyRef.relativePath.startsWith("/")
                    && !input.bodyRef.relativePath.includes("..")
                    && !input.bodyRef.relativePath.includes("\\")
                    && !input.bodyRef.relativePath.includes("%"),
                readBodyRef: async input => {
                    this.boundedReadLimits.push(input.maxBytes);
                    const body = this.bodyObjects.get(input.bodyRef.objectId);
                    if (body === undefined) return { kind: "missing" };
                    const bytes = Buffer.from(body, "utf8");
                    if (bytes.length > input.maxBytes) {
                        return { kind: "found", body: bytes.subarray(0, input.maxBytes).toString("utf8"), truncated: true };
                    }
                    return { kind: "found", body, truncated: false };
                },
                captureBodyBeforeImage: async input => {
                    if (this.body.bodyRef !== null) {
                        this.requireStoredBody(this.body.bodyRef, this.body.bodyHash!, this.body.byteLength!, input.maxBytes);
                    }
                    return clone(this.body);
                },
                stageBody: async input => {
                    this.requireStoredBody(input.bodyRef, input.bodyHash, input.byteLength, input.maxBytes);
                    this.writes.push("stageBody");
                    this.stagedBodies.set(input.commitId, {
                        bodyRef: clone(input.bodyRef),
                        bodyHash: input.bodyHash,
                        byteLength: input.byteLength,
                        ownerCommitId: input.commitId,
                        revision: "stage",
                    });
                },
                readStagedBody: async commitId => clone(this.stagedBodies.get(commitId) || emptyBody()),
                publishBody: async input => {
                    this.requireStoredBody(input.bodyRef, input.bodyHash, input.byteLength, input.maxBytes);
                    this.writes.push("publishBody");
                    this.body = {
                        bodyRef: clone(input.bodyRef),
                        bodyHash: input.bodyHash,
                        byteLength: input.byteLength,
                        ownerCommitId: input.commitId,
                        revision: input.coveredRevision,
                    };
                },
                readBody: async () => clone(this.body),
                writeMainIndex: async input => {
                    this.writes.push("writeMainIndex");
                    this.mainIndex = { value: clone(input.entry) as unknown as JsonValue, hash: input.entryHash, ownerCommitId: input.commitId, revision: input.entry.coveredRevision };
                },
                readMainIndex: async () => clone(this.mainIndex),
                writeReaderIndex: async input => {
                    this.writes.push("writeReaderIndex");
                    this.readerIndex = { value: clone(input.index) as unknown as JsonValue, hash: input.indexHash, ownerCommitId: input.commitId, revision: input.index.coveredRevision };
                },
                readReaderIndex: async () => clone(this.readerIndex),
                discardStagedBodyIfOwned: async input => {
                    const staged = this.stagedBodies.get(input.commitId);
                    if (!staged) return { kind: "already_applied" };
                    if (staged.ownerCommitId !== input.commitId
                        || !sameBodyRef(staged.bodyRef, input.expectedBodyRef)
                        || staged.bodyHash !== input.expectedBodyHash
                        || staged.byteLength !== input.expectedByteLength) {
                        return { kind: "ownership_changed", reason: "staged_body_owner_changed" };
                    }
                    this.stagedBodies.delete(input.commitId);
                    return { kind: "applied" };
                },
                restoreBodyIfOwned: async input => {
                    if (sameBodyImage(this.body, input.before)) return { kind: "already_applied" };
                    if (!sameBodyImage(this.body, input.expected)) {
                        return { kind: "ownership_changed", reason: "body_owner_changed" };
                    }
                    if (input.before.bodyRef !== null) {
                        this.requireStoredBody(input.before.bodyRef, input.before.bodyHash!, input.before.byteLength!, input.maxBytes);
                    }
                    this.body = clone(input.before);
                    return { kind: "applied" };
                },
                restoreMainIndexIfOwned: async input => {
                    if (sameJsonImage(this.mainIndex, input.before)) return { kind: "already_applied" };
                    if (this.mainIndex.ownerCommitId !== input.commitId || this.mainIndex.hash !== input.expectedEntryHash) {
                        return { kind: "ownership_changed", reason: "main_index_owner_changed" };
                    }
                    this.mainIndex = clone(input.before);
                    this.afterRestoreMain?.();
                    return { kind: "applied" };
                },
                rebuildReaderIndexFromBody: async input => {
                    this.rebuildReaderCalls += 1;
                    if (!sameBodyImage(this.body, input.expectedBody) || !sameJsonImage(this.mainIndex, input.expectedMainIndex)) {
                        return { kind: "ownership_changed", reason: "restored_body_or_main_changed" };
                    }
                    if (this.readerIndex.ownerCommitId !== input.commitId && !sameJsonImage(this.readerIndex, input.expectedReaderIndex)) {
                        return { kind: "ownership_changed", reason: "reader_index_owner_changed" };
                    }
                    const body = this.body.bodyRef === null
                        ? undefined
                        : this.requireStoredBody(this.body.bodyRef, this.body.bodyHash!, this.body.byteLength!, input.maxBytes);
                    this.readerIndex = body === undefined
                        ? emptyJson()
                        : { value: { rebuiltFrom: sha256(body) }, hash: jsonHash({ rebuiltFrom: sha256(body) }), ownerCommitId: this.body.ownerCommitId, revision: "rebuilt" };
                    return { kind: "applied" };
                },
                verifyTaskExclusiveResultsInvisible: async input => this.body.ownerCommitId !== input.commitId && this.mainIndex.ownerCommitId !== input.commitId && this.readerIndex.ownerCommitId !== input.commitId,
                isolateLateOutput: async input => {
                    this.isolated.push({
                        commitId: input.commitId,
                        bodyRef: clone(input.bodyRef),
                        bodyHash: input.bodyHash,
                        byteLength: input.byteLength,
                        reason: input.reason,
                    });
                },
            },
            hash: sha256,
            byteLength: utf8ByteLength,
            now: () => `2026-07-13T00:00:${String(this.clock++).padStart(2, "0")}.000Z`,
            isTaskCancelled: async () => this.cancelled,
            ...(this.dynamicMetadata ? {
                materializeCommitPayloadMetadata: async () => {
                    this.metadataMaterializationCount += 1;
                    const snapshot = { generation: this.metadataMaterializationCount };
                    return { snapshot, hash: jsonHash(snapshot) };
                },
            } : {}),
            hooks: {
                onFaultPoint: async input => {
                    if (this.fault && this.fault.stage === input.stage && this.fault.point === input.point) {
                        const fault = this.fault;
                        this.fault = null;
                        throw new Error(`injected ${fault.stage}:${fault.point}`);
                    }
                },
                onPersistenceFaultPoint: async input => {
                    this.persistenceFaultEvents.push(clone(input));
                    this.persistenceTimeline.push(`fault:${input.point}:${input.expectedRevision}->${input.nextRevision}`);
                    if (this.persistenceFault && this.persistenceFault.stage === input.stage && this.persistenceFault.point === input.point) {
                        const fault = this.persistenceFault;
                        this.persistenceFault = null;
                        throw new Error(`injected ${fault.stage}:${fault.point}`);
                    }
                },
            },
        };
    }
}

function binding(contentHash: string, overrides: Partial<RecordCommitBinding> = {}): RecordCommitBinding {
    return {
        conversationKey: "codex:workspace:conversation-1",
        conversationId: "conversation-1",
        recordId: "record-1",
        taskId: "task-a",
        unitId: "unit-a",
        attemptId: "attempt-a",
        recordWorkKey: "work-a",
        workLeaseId: "lease-a",
        recordCommitEpoch: 1,
        fencingToken: 1,
        contentHash,
        sourceSnapshotId: "snapshot-a",
        inputHash: "input-a",
        ...overrides,
    };
}

function commitTarget(kind: RecordCommitTarget["kind"], relativePath: string, identity: Pick<RecordCommitBinding, "conversationId" | "recordId">): RecordCommitTarget {
    return { kind, relativePath, conversationId: identity.conversationId, recordId: identity.recordId };
}

function commitPayload(commitId: string, bodyRef: RecordCommitBodyRef, byteLength: number, currentBinding: RecordCommitBinding, coveredRevision = "revision-a"): RecordCommitPayload {
    return {
        bodyRef: clone(bodyRef),
        bodyHash: currentBinding.contentHash,
        byteLength,
        coveredRevision,
        bodyTarget: commitTarget("record_body", "records/body.md", currentBinding),
        mainIndexTarget: commitTarget("main_index", "indexes/main.json", currentBinding),
        mainIndexEntry: { coveredRevision, commitId, conversationId: currentBinding.conversationId, recordId: currentBinding.recordId },
        readerIndexTarget: commitTarget("reader_index", "indexes/reader.json", currentBinding),
        readerIndex: { bodyHash: currentBinding.contentHash, coveredRevision, commitId, conversationId: currentBinding.conversationId, recordId: currentBinding.recordId },
    };
}

async function createCommit(
    adapter: FakeCommitAdapter,
    commitId = "commit-a",
    bindingOverrides: Partial<RecordCommitBinding> = {},
    bodyOverride?: string,
): Promise<{ protocol: RecordCommitProtocol; commitId: string; body: string; bodyRef: RecordCommitBodyRef; bodyHash: string; byteLength: number }> {
    const protocol = adapter.createProtocol();
    const generated = adapter.generateRecord(bodyOverride);
    const currentBinding = binding(generated.contentHash, bindingOverrides);
    const bodyRef = adapter.storeImmutableBody(generated.body, currentBinding, `${commitId}-result`);
    await protocol.create({
        commitId,
        binding: currentBinding,
        payload: commitPayload(commitId, bodyRef, generated.byteLength, currentBinding),
    });
    return { protocol, commitId, body: generated.body, bodyRef, bodyHash: generated.contentHash, byteLength: generated.byteLength };
}

async function advanceTo(protocol: RecordCommitProtocol, commitId: string, stage: RecordCommitStage): Promise<RecordCommitLedger> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const ledger = await protocol.read(commitId);
        if (ledger.stage === stage) return ledger;
        const result = await protocol.advanceOnce(commitId);
        assert.equal(result.kind, "advanced", `到达 ${stage} 前不应提前终态`);
    }
    assert.fail(`未能推进到 ${stage}`);
}

{
    const cancelledBefore = new FakeCommitAdapter();
    cancelledBefore.cancelled = true;
    await assert.rejects(
        createCommit(cancelledBefore, "commit-cancel-before-create"),
        (error: unknown) => error instanceof RecordCommitInitialGuardRejectedError && error.guard === "cancelled",
    );
    assert.equal(cancelledBefore.ledgers.has("commit-cancel-before-create"), false);

    const simultaneous = new FakeCommitAdapter();
    let enterBarrier!: () => void;
    let releaseBarrier!: () => void;
    const entered = new Promise<void>(resolve => { enterBarrier = resolve; });
    const release = new Promise<void>(resolve => { releaseBarrier = resolve; });
    simultaneous.initialCasBarrier = async () => {
        enterBarrier();
        await release;
    };
    const racingCreate = createCommit(simultaneous, "commit-cancel-simultaneous");
    await entered;
    simultaneous.cancelled = true;
    releaseBarrier();
    await assert.rejects(
        racingCreate,
        (error: unknown) => error instanceof RecordCommitInitialGuardRejectedError && error.guard === "cancelled",
    );
    assert.equal(simultaneous.ledgers.has("commit-cancel-simultaneous"), false);

    const cancelledAfter = new FakeCommitAdapter();
    const created = await createCommit(cancelledAfter, "commit-cancel-after-create");
    cancelledAfter.cancelled = true;
    const cancelled = await created.protocol.recover(created.commitId);
    assert.equal(cancelled.kind, "cancelled");
}

{
    const adapter = new FakeCommitAdapter();
    adapter.dynamicMetadata = true;
    const protocol = adapter.createProtocol();
    const generated = adapter.generateRecord("# dynamic metadata retry");
    const currentBinding = binding(generated.contentHash);
    const bodyRef = adapter.storeImmutableBody(generated.body, currentBinding, "commit-dynamic-metadata-result");
    const payload = commitPayload("commit-dynamic-metadata", bodyRef, generated.byteLength, currentBinding);
    const created = await protocol.create({ commitId: "commit-dynamic-metadata", binding: currentBinding, payload });
    assert.equal(adapter.metadataMaterializationCount, 1);
    const retried = await adapter.createProtocol().create({ commitId: "commit-dynamic-metadata", binding: currentBinding, payload });
    assert.equal(adapter.metadataMaterializationCount, 1, "既有 commitId 重放必须继承持久 metadata，不能重新生成动态字段");
    assert.deepEqual(retried.payload.mainIndexMetadata, created.payload.mainIndexMetadata);
    await assert.rejects(
        adapter.createProtocol().create({
            commitId: "commit-dynamic-metadata",
            binding: currentBinding,
            payload: {
                ...payload,
                mainIndexMetadata: { snapshot: { generation: 99 }, hash: jsonHash({ generation: 99 }) },
            },
        }),
        (error: unknown) => error instanceof RecordCommitIdReuseError && error.reason.startsWith("payload_mismatch"),
        "调用方显式提供不同 metadata 时仍必须由严格 commit identity 拒绝",
    );
}

for (const stage of ["BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified"] as const) {
    for (const point of ["before_write", "after_write"] as const) {
        const adapter = new FakeCommitAdapter();
        const { protocol, commitId } = await createCommit(adapter, `commit-${stage}-${point}`);
        adapter.fault = { stage, point };
        await assert.rejects(protocol.recover(commitId), new RegExp(`injected ${stage}:${point}`, "u"));
        const afterCrash = await protocol.read(commitId);
        assert.notEqual(afterCrash.stage, "Verified", `${stage}:${point} 崩溃不应伪装为完成`);
        const restarted = adapter.createProtocol();
        const recovered = await restarted.recover(commitId);
        assert.equal(recovered.kind, "verified", `${stage}:${point} 应从最后确认阶段恢复`);
        assert.equal(adapter.provider.postCount, 1, `${stage}:${point} 恢复不得增加 fake provider POST`);
        const verified = await restarted.read(commitId);
        assert.deepEqual(verified.confirmedStages, ["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified"]);
        assert.equal(verified.schemaVersion, RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION);
    }
}

for (const { stage, predecessor, point } of [
    { stage: "PublishIntent", predecessor: "BodyStaged", point: "before_intent_persist" },
    { stage: "PublishIntent", predecessor: "BodyStaged", point: "after_intent_persist" },
    { stage: "Verified", predecessor: "ReaderIndexWritten", point: "before_stage_confirm" },
    { stage: "Verified", predecessor: "ReaderIndexWritten", point: "after_stage_confirm" },
] as const) {
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, `commit-persistence-${stage}-${point}`);
    await advanceTo(protocol, commitId, predecessor);
    const beforeFault = await protocol.read(commitId);
    adapter.ledgerCasRevisions.length = 0;
    adapter.persistenceFaultEvents.length = 0;
    adapter.persistenceTimeline.length = 0;
    adapter.persistenceFault = { stage, point };

    await assert.rejects(protocol.advanceOnce(commitId), new RegExp(`injected ${stage}:${point}`, "u"));
    const afterCrash = await adapter.createProtocol().read(commitId);
    const faultEvent = adapter.persistenceFaultEvents.find(event => event.point === point);
    assert.deepEqual(faultEvent, {
        commitId,
        stage,
        point,
        binding: beforeFault.binding,
        expectedRevision: point === "before_stage_confirm" || point === "after_stage_confirm" ? beforeFault.revision + 1 : beforeFault.revision,
        nextRevision: point === "before_stage_confirm" || point === "after_stage_confirm" ? beforeFault.revision + 2 : beforeFault.revision + 1,
    }, `${stage}:${point} 必须携带完整 commit identity 与准确 revision`);

    if (point === "before_intent_persist") {
        assert.equal(afterCrash.revision, beforeFault.revision);
        assert.equal(afterCrash.stage, predecessor);
        assert.equal(afterCrash.intent, null);
        assert.deepEqual(adapter.ledgerCasRevisions, []);
        assert.deepEqual(adapter.persistenceTimeline, [`fault:${point}:${beforeFault.revision}->${beforeFault.revision + 1}`]);
    } else if (point === "after_intent_persist") {
        assert.equal(afterCrash.revision, beforeFault.revision + 1);
        assert.equal(afterCrash.stage, predecessor);
        assert.equal(afterCrash.intent?.targetStage, stage);
        assert.deepEqual(adapter.ledgerCasRevisions, [beforeFault.revision + 1]);
        assert.deepEqual(adapter.persistenceTimeline, [
            `fault:before_intent_persist:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `cas:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `fault:${point}:${beforeFault.revision}->${beforeFault.revision + 1}`,
        ]);
    } else if (point === "before_stage_confirm") {
        assert.equal(afterCrash.revision, beforeFault.revision + 1);
        assert.equal(afterCrash.stage, predecessor);
        assert.equal(afterCrash.intent?.targetStage, stage);
        assert.deepEqual(adapter.ledgerCasRevisions, [beforeFault.revision + 1]);
        assert.deepEqual(adapter.persistenceTimeline, [
            `fault:before_intent_persist:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `cas:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `fault:after_intent_persist:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `fault:${point}:${beforeFault.revision + 1}->${beforeFault.revision + 2}`,
        ]);
    } else {
        assert.equal(afterCrash.revision, beforeFault.revision + 2);
        assert.equal(afterCrash.stage, stage);
        assert.equal(afterCrash.intent, null);
        assert.deepEqual(adapter.ledgerCasRevisions, [beforeFault.revision + 1, beforeFault.revision + 2]);
        assert.deepEqual(adapter.persistenceTimeline, [
            `fault:before_intent_persist:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `cas:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `fault:after_intent_persist:${beforeFault.revision}->${beforeFault.revision + 1}`,
            `fault:before_stage_confirm:${beforeFault.revision + 1}->${beforeFault.revision + 2}`,
            `cas:${beforeFault.revision + 1}->${beforeFault.revision + 2}`,
            `fault:${point}:${beforeFault.revision + 1}->${beforeFault.revision + 2}`,
        ]);
    }

    const recovered = await adapter.createProtocol().recover(commitId);
    assert.equal(recovered.kind, "verified", `${stage}:${point} 重启后必须从持久 ledger 恢复`);
    assert.equal(adapter.provider.postCount, 1, `${stage}:${point} 恢复不得增加 fake provider POST`);
}

{
    const adapter = new FakeCommitAdapter();
    const marker = "LEDGER-MUST-NOT-CONTAIN-THIS-RECORD-BODY";
    const created = await createCommit(adapter, "commit-ledger-reference-only", {}, marker);
    const ledger = await created.protocol.read(created.commitId);
    const serialized = JSON.stringify(ledger);
    assert.equal(Object.hasOwn(ledger.payload, "body"), false, "payload 运行时形状也不得保留旧 body 字段");
    assert.equal(serialized.includes(marker), false, "durable ledger 序列化不得复制正文");
    assert.equal(ledger.payload.bodyRef.objectId, created.bodyRef.objectId);
    assert.equal(ledger.payload.bodyHash, created.bodyHash);
    assert.equal(ledger.payload.byteLength, created.byteLength);

    const retransmitted = { ...clone(ledger.payload), body: marker } as RecordCommitPayload & { body: string };
    await assert.rejects(
        created.protocol.create({ commitId: "commit-retransmitted-body", binding: ledger.binding, payload: retransmitted }),
        /payload 字段集合无效/u,
        "调用者不能借额外字段把正文重新塞回 ledger",
    );
}

{
    const adapter = new FakeCommitAdapter();
    const largeMarker = "LARGE-RECORD-BODY-MUST-STAY-IN-ONE-OBJECT::";
    const largeBody = largeMarker + "x".repeat(2 * 1024 * 1024);
    const created = await createCommit(adapter, "commit-large-reference-only", {}, largeBody);
    const beforeRecovery = await created.protocol.read(created.commitId);
    const beforeSerialized = JSON.stringify(beforeRecovery);
    assert.equal(beforeSerialized.includes(largeMarker), false, "大正文不得进入初始 ledger");
    assert.ok(beforeSerialized.length < 32 * 1024, "ledger 大小不得随正文线性增长");
    assert.equal(adapter.bodyObjects.size, 1, "大正文只允许存在于一个不可变对象中");
    assert.equal([...adapter.bodyObjects.values()].filter(value => value === largeBody).length, 1);

    const recovered = await adapter.createProtocol().recover(created.commitId);
    assert.equal(recovered.kind, "verified");
    const durableMetadata = JSON.stringify({
        ledger: await created.protocol.read(created.commitId),
        stagedBodies: [...adapter.stagedBodies.values()],
        body: adapter.body,
        isolated: adapter.isolated,
    });
    assert.equal(durableMetadata.includes(largeMarker), false, "staging、正式正文元数据与隔离元数据都只能保存 ref");
    assert.equal(adapter.bodyObjects.size, 1, "发布和恢复不得复制大正文对象");
    assert.equal(adapter.provider.postCount, 1, "大正文恢复不得增加 provider POST");
    assert.ok(adapter.boundedReadLimits.length > 0, "协议必须通过有界 ref 读取验证正文");
    assert.ok(adapter.boundedReadLimits.every(limit => limit === created.byteLength + 1 && limit <= MAX_RECORD_COMMIT_BODY_BYTES + 1));
}

for (const corruption of ["missing", "same_length_hash", "byte_length"] as const) {
    const adapter = new FakeCommitAdapter();
    const created = await createCommit(adapter, `commit-body-ref-${corruption}`);
    if (corruption === "missing") adapter.bodyObjects.delete(created.bodyRef.objectId);
    if (corruption === "same_length_hash") adapter.bodyObjects.set(created.bodyRef.objectId, created.body.replace(/.$/u, "x"));
    if (corruption === "byte_length") adapter.bodyObjects.set(created.bodyRef.objectId, `${created.body}x`);
    const result = await created.protocol.advanceOnce(created.commitId);
    assert.equal(result.kind, "repair_required", `${corruption} spool 损坏必须 fail closed`);
    const expectedReason = corruption === "missing" ? /body_ref_missing/u : corruption === "same_length_hash" ? /body_hash_mismatch/u : /byte_length_mismatch/u;
    assert.match(result.ledger.repairState || "", expectedReason);
    assert.equal(adapter.provider.postCount, 1, "spool 损坏不得重调模型");
}

for (const stage of ["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten"] as const) {
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, `commit-cancel-${stage}`);
    await advanceTo(protocol, commitId, stage);
    adapter.cancelled = true;
    const restarted = adapter.createProtocol();
    const cancelled = await restarted.recover(commitId);
    assert.equal(cancelled.kind, "cancelled", `${stage} 边界的 cancel+restart 必须完成条件清理`);
    assert.equal(adapter.provider.postCount, 1, `${stage} 边界恢复不得重发 fake provider POST`);
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-cancel-restart");
    await advanceTo(protocol, commitId, "MainIndexWritten");
    adapter.cancelled = true;
    const cancelled = await adapter.createProtocol().recover(commitId);
    assert.equal(cancelled.kind, "cancelled", "取消后重启必须走 CleanupIntent 补偿");
    assert.equal(adapter.body.ownerCommitId, null, "取消只条件恢复本 commit 的正文");
    assert.equal(adapter.mainIndex.ownerCommitId, null, "取消只条件恢复本 commit 的单条主索引");
    assert.equal(adapter.readerIndex.ownerCommitId, null, "Reader Index 必须由恢复正文重建");
    assert.equal(adapter.stagedBodies.has(commitId), false, "取消必须清理本 commit 的 staging 输出");
    assert.equal(adapter.activeTaskIds.has("task-a"), false, "solo cancel 必须先从 activeTaskIds 摘除当前 task");
    assert.deepEqual(adapter.detached, ["task-a"], "solo cancel 必须持久 detach 一次");
}

{
    const adapter = new FakeCommitAdapter();
    const oldBody = "# old body must only survive behind its immutable ref";
    adapter.setVisibleBody(oldBody, "commit-before", "revision-before", { conversationId: "conversation-1", recordId: "record-1" }, "commit-before-visible");
    const oldMain = { coveredRevision: "revision-before", commitId: "commit-before", conversationId: "conversation-1", recordId: "record-1" };
    const oldReader = { bodyHash: sha256(oldBody), coveredRevision: "revision-before", commitId: "commit-before", conversationId: "conversation-1", recordId: "record-1" };
    adapter.mainIndex = { value: oldMain, hash: jsonHash(oldMain), ownerCommitId: "commit-before", revision: "revision-before" };
    adapter.readerIndex = { value: oldReader, hash: jsonHash(oldReader), ownerCommitId: "commit-before", revision: "revision-before" };

    const created = await createCommit(adapter, "commit-before-image-ref", {}, "# replacement body");
    await advanceTo(created.protocol, created.commitId, "MainIndexWritten");
    const inFlight = await created.protocol.read(created.commitId);
    assert.equal(inFlight.beforeImages?.body.bodyRef?.objectId, "commit-before-visible", "before-image 必须保存旧正文 ref");
    assert.equal(JSON.stringify(inFlight).includes(oldBody), false, "before-image 不得把旧正文复制进 ledger");
    assert.equal(JSON.stringify(inFlight).includes(created.body), false, "提交 payload 也不得把新正文复制进 ledger");

    adapter.cancelled = true;
    const cancelled = await created.protocol.cancel(created.commitId);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(adapter.body.bodyRef?.objectId, "commit-before-visible", "取消必须按 before-image ref 条件恢复旧正文");
    assert.equal(adapter.body.bodyHash, sha256(oldBody));
    assert.equal(adapter.readerIndex.ownerCommitId, "commit-before", "Reader Index 必须从恢复后的旧正文 ref 重建");
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-shared");
    await advanceTo(protocol, commitId, "BodyStaged");
    adapter.cancelled = true;
    adapter.activeTaskIds.add("task-b");
    const detached = await protocol.cancel(commitId);
    assert.equal(detached.kind, "detached", "共享 work 有其他 task 时取消只能 detach");
    assert.deepEqual(adapter.detached, ["task-a"]);
    assert.equal(adapter.stagedBodies.has(commitId), true, "共享提交不能因单 task 取消被清理");
    assert.equal(detached.ledger.lifecycle, "Detached", "shared detach 必须写入明确终态");
    const restarted = await adapter.createProtocol().recover(commitId);
    assert.equal(restarted.kind, "detached", "Detached ledger 重启后不得再次进入 cancel");
    assert.deepEqual(adapter.detached, ["task-a"], "Detached 重启不得重复 detach");
    assert.equal(adapter.activeTaskIds.has("task-b"), true, "共享 work 必须继续保留其他 task");
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-attach-during-detach");
    await advanceTo(protocol, commitId, "BodyStaged");
    adapter.cancelled = true;
    adapter.afterDetach = () => { adapter.activeTaskIds.add("task-b"); };
    const detached = await protocol.cancel(commitId);
    assert.equal(detached.kind, "detached", "solo detach 后出现新挂接时必须停止 cleanup");
    assert.equal(adapter.stagedBodies.has(commitId), true, "新 task 挂接后不能误清 shared staging");
    assert.equal(adapter.activeTaskIds.has("task-b"), true);
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-a-cleanup");
    await advanceTo(protocol, commitId, "MainIndexWritten");
    adapter.cancelled = true;
    adapter.currentEpoch = 2;
    adapter.currentFence = 2;
    adapter.currentLeaseId = "lease-b";
    adapter.setVisibleBody("# task b", "commit-b", "body-b", { conversationId: "conversation-1", recordId: "record-1" }, "commit-b-visible");
    adapter.mainIndex = { value: { coveredRevision: "revision-b", commitId: "commit-b" }, hash: jsonHash({ coveredRevision: "revision-b", commitId: "commit-b" }), ownerCommitId: "commit-b", revision: "main-b" };
    adapter.readerIndex = { value: { bodyHash: adapter.body.bodyHash, commitId: "commit-b" }, hash: jsonHash({ bodyHash: adapter.body.bodyHash, commitId: "commit-b" }), ownerCommitId: "commit-b", revision: "reader-b" };
    const staleCleanup = await protocol.cancel(commitId);
    assert.equal(staleCleanup.kind, "audited_stale", "高 epoch 接管后旧 cleanup 只能审计");
    assert.equal(adapter.body.ownerCommitId, "commit-b");
    assert.equal(adapter.mainIndex.ownerCommitId, "commit-b");
    assert.equal(adapter.readerIndex.ownerCommitId, "commit-b");
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-takeover-between-cleanup-effects");
    await advanceTo(protocol, commitId, "MainIndexWritten");
    adapter.cancelled = true;
    adapter.afterRestoreMain = () => {
        const body = "# task b takeover";
        const bodyHash = sha256(body);
        adapter.currentEpoch = 2;
        adapter.currentFence = 2;
        adapter.currentLeaseId = "lease-b";
        adapter.activeTaskIds.add("task-b");
        adapter.setVisibleBody(body, "commit-b", "revision-b", { conversationId: "conversation-1", recordId: "record-1" }, "commit-b-takeover-visible");
        const mainValue = { coveredRevision: "revision-b", commitId: "commit-b", conversationId: "conversation-1", recordId: "record-1" };
        adapter.mainIndex = { value: mainValue, hash: jsonHash(mainValue), ownerCommitId: "commit-b", revision: "revision-b" };
        const readerValue = { bodyHash, coveredRevision: "revision-b", commitId: "commit-b", conversationId: "conversation-1", recordId: "record-1" };
        adapter.readerIndex = { value: readerValue, hash: jsonHash(readerValue), ownerCommitId: "commit-b", revision: "revision-b" };
    };
    const stopped = await protocol.cancel(commitId);
    assert.equal(stopped.kind, "audited_stale", "B 在 A 恢复 body/main 后接管时，A 必须在下一副作用前停止");
    assert.equal(adapter.rebuildReaderCalls, 0, "旧 A 不能重建并覆盖 B 的 Reader Index");
    assert.equal(adapter.body.ownerCommitId, "commit-b");
    assert.equal(adapter.mainIndex.ownerCommitId, "commit-b");
    assert.equal(adapter.readerIndex.ownerCommitId, "commit-b");
}

{
    const adapter = new FakeCommitAdapter();
    const first = await createCommit(adapter, "commit-old");
    await advanceTo(first.protocol, first.commitId, "BodyPublished");
    adapter.currentEpoch = 2;
    adapter.currentFence = 2;
    adapter.currentLeaseId = "lease-b";
    const stale = await first.protocol.advanceOnce(first.commitId);
    assert.equal(stale.kind, "audited_stale", "迟到旧 epoch 结果不能越过提交栅栏");
    const second = adapter.createProtocol();
    const nextBody = "# task b";
    const nextBinding = binding(sha256(nextBody), { taskId: "task-b", unitId: "unit-b", attemptId: "attempt-b", workLeaseId: "lease-b", recordCommitEpoch: 2, fencingToken: 2 });
    const nextBodyRef = adapter.storeImmutableBody(nextBody, nextBinding, "commit-new-result");
    await second.create({
        commitId: "commit-new",
        binding: nextBinding,
        payload: commitPayload("commit-new", nextBodyRef, utf8ByteLength(nextBody), nextBinding, "revision-b"),
    });
    adapter.activeTaskIds.clear();
    adapter.activeTaskIds.add("task-b");
    const committed = await second.recover("commit-new");
    assert.equal(committed.kind, "verified", "相同 conversation 的新 epoch task 应可提交");
    assert.equal(adapter.body.ownerCommitId, "commit-new");
    const late = await first.protocol.discardLateResult(first.commitId, first.bodyRef, first.bodyHash, first.byteLength);
    assert.equal(late.kind, "audited_stale");
    assert.equal(adapter.isolated.length, 1, "迟到输出必须进入隔离区");
    assert.equal(adapter.body.ownerCommitId, "commit-new", "隔离迟到结果不得触碰新正文");
}

for (const mismatch of ["body_revision", "main_identity", "reader_body_hash"] as const) {
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, `commit-visibility-${mismatch}`);
    await advanceTo(protocol, commitId, "ReaderIndexWritten");
    if (mismatch === "body_revision") {
        adapter.body.revision = "wrong-revision";
    } else if (mismatch === "main_identity") {
        const value = { ...(adapter.mainIndex.value as Record<string, JsonValue>), conversationId: "other-conversation" };
        adapter.mainIndex = { ...adapter.mainIndex, value, hash: jsonHash(value) };
    } else {
        const value = { ...(adapter.readerIndex.value as Record<string, JsonValue>), bodyHash: "wrong-body-hash" };
        adapter.readerIndex = { ...adapter.readerIndex, value, hash: jsonHash(value) };
    }
    const verified = await protocol.recover(commitId);
    assert.equal(verified.kind, "repair_required", `${mismatch} 必须 fail closed`);
    assert.match(verified.ledger.repairState || "", /mismatch/u);
    assert.notEqual(verified.ledger.stage, "Verified");
}

for (const deceptive of ["absolute", "parent", "encoded_parent", "windows_absolute", "wrong_identity"] as const) {
    const adapter = new FakeCommitAdapter();
    const protocol = adapter.createProtocol();
    const body = `# deceptive ${deceptive}`;
    const currentBinding = binding(sha256(body));
    const commitId = `commit-deceptive-${deceptive}`;
    const bodyRef = adapter.storeImmutableBody(body, currentBinding, `${commitId}-result`);
    const payload = commitPayload(commitId, bodyRef, utf8ByteLength(body), currentBinding);
    if (deceptive === "absolute") payload.bodyTarget.relativePath = "/tmp/body.md";
    if (deceptive === "parent") payload.bodyTarget.relativePath = "records/../body.md";
    if (deceptive === "encoded_parent") payload.bodyTarget.relativePath = "records/%2e%2e/body.md";
    if (deceptive === "windows_absolute") payload.bodyTarget.relativePath = "C:\\tmp\\body.md";
    if (deceptive === "wrong_identity") payload.bodyTarget.conversationId = "other-conversation";
    await assert.rejects(
        protocol.create({ commitId, binding: currentBinding, payload }),
        /target/u,
        `${deceptive} target 必须在协议层被拒绝`,
    );
}

for (const deceptiveRef of ["absolute", "parent", "encoded_parent", "windows_absolute", "wrong_identity", "invalid_object_id"] as const) {
    const adapter = new FakeCommitAdapter();
    const protocol = adapter.createProtocol();
    const body = `# deceptive ref ${deceptiveRef}`;
    const currentBinding = binding(sha256(body));
    const commitId = `commit-deceptive-ref-${deceptiveRef}`;
    const bodyRef = adapter.storeImmutableBody(body, currentBinding, `${commitId}-result`);
    const payload = commitPayload(commitId, bodyRef, utf8ByteLength(body), currentBinding);
    if (deceptiveRef === "absolute") payload.bodyRef.relativePath = "/tmp/body.blob";
    if (deceptiveRef === "parent") payload.bodyRef.relativePath = "record-output/../body.blob";
    if (deceptiveRef === "encoded_parent") payload.bodyRef.relativePath = "record-output/%2e%2e/body.blob";
    if (deceptiveRef === "windows_absolute") payload.bodyRef.relativePath = "C:\\tmp\\body.blob";
    if (deceptiveRef === "wrong_identity") payload.bodyRef.recordId = "other-record";
    if (deceptiveRef === "invalid_object_id") payload.bodyRef.objectId = "../../body";
    await assert.rejects(
        protocol.create({ commitId, binding: currentBinding, payload }),
        /bodyRef/u,
        `${deceptiveRef} bodyRef 必须在协议层被拒绝`,
    );
}

{
    const adapter = new FakeCommitAdapter();
    adapter.rejectTargets = true;
    const protocol = adapter.createProtocol();
    const body = "# adapter target rejection";
    const currentBinding = binding(sha256(body));
    const commitId = "commit-adapter-target-rejection";
    const bodyRef = adapter.storeImmutableBody(body, currentBinding, `${commitId}-result`);
    await assert.rejects(
        protocol.create({ commitId, binding: currentBinding, payload: commitPayload(commitId, bodyRef, utf8ByteLength(body), currentBinding) }),
        /adapter 拒绝/u,
        "adapter 必须保留 target 二次校验",
    );
}

{
    const adapter = new FakeCommitAdapter();
    const { protocol, commitId } = await createCommit(adapter, "commit-reuse");
    const original = await protocol.read(commitId);
    const originalBody = adapter.bodyObjects.get(original.payload.bodyRef.objectId)!;
    const alternateRef = adapter.storeImmutableBody(originalBody, original.binding, "commit-reuse-alternate-result");
    await assert.rejects(
        protocol.create({
            commitId,
            binding: original.binding,
            payload: { ...clone(original.payload), bodyRef: alternateRef },
        }),
        error => error instanceof RecordCommitIdReuseError,
        "同一 commitId 不得换绑另一个 immutable body object",
    );
    await assert.rejects(
        protocol.create({
            commitId,
            binding: { ...original.binding, taskId: "different-task" },
            payload: original.payload,
        }),
        error => error instanceof RecordCommitIdReuseError,
    );
    const tampered = clone(original);
    tampered.integrityHash = "tampered";
    adapter.ledgers.set(commitId, tampered);
    await assert.rejects(protocol.read(commitId), error => error instanceof RecordCommitLedgerRepairRequiredError);
}

{
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-commit-child-"));
    const statePath = path.join(tempRoot, "state.json");
    const childPath = path.join(tempRoot, "record-commit-child.mjs");
    const moduleUrl = pathToFileURL(path.resolve("src/record-commit-protocol.ts")).href;
    fs.writeFileSync(statePath, JSON.stringify({
        ledgers: {},
        bodyObjects: {},
        stagedBodies: {},
        body: emptyBody(),
        mainIndex: emptyJson(),
        readerIndex: emptyJson(),
        providerPostCount: 0,
        clock: 0,
    }), "utf8");
    fs.writeFileSync(childPath, `
import crypto from "node:crypto";
import fs from "node:fs";
import { RecordCommitProtocol } from ${JSON.stringify(moduleUrl)};

const [mode, statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonicalJson = value => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
};
const emptyBody = () => ({ bodyRef: null, bodyHash: null, byteLength: null, ownerCommitId: null, revision: null });
const emptyJson = () => ({ value: null, hash: null, ownerCommitId: null, revision: null });
const binding = body => ({ conversationKey: "child-conversation", conversationId: "child-conversation", recordId: "child-record", taskId: "child-task", unitId: "child-unit", attemptId: "child-attempt", recordWorkKey: "child-work", workLeaseId: "child-lease", recordCommitEpoch: 1, fencingToken: 1, contentHash: hash(body), sourceSnapshotId: "child-snapshot", inputHash: "child-input" });
const byteLength = value => Buffer.byteLength(value, "utf8");
const storeBody = (body, current, objectId) => {
  if (state.bodyObjects[objectId] !== undefined && state.bodyObjects[objectId] !== body) throw new Error("immutable body object reused");
  state.bodyObjects[objectId] = body; save();
  return { kind: "immutable_record_body", conversationId: current.conversationId, recordId: current.recordId, objectId, relativePath: "record-output/" + current.conversationId + "/" + current.recordId + "/" + objectId + ".body" };
};
const requireBody = (bodyRef, bodyHash, expectedByteLength, maxBytes) => {
  const body = state.bodyObjects[bodyRef.objectId];
  if (body === undefined || byteLength(body) !== expectedByteLength || byteLength(body) > maxBytes || hash(body) !== bodyHash) throw new Error("body ref readback mismatch");
  return body;
};
const adapter = {
  durable: {
    readLedger: async commitId => clone(state.ledgers[commitId] ?? null),
    compareAndSwapInitialLedger: async (commitId, next) => {
      if (state.ledgers[commitId] !== undefined) return { kind: "conflict" };
      state.ledgers[commitId] = clone(next); save(); return { kind: "written" };
    },
    compareAndSwapLedger: async (commitId, expectedRevision, next) => {
      if ((state.ledgers[commitId]?.revision ?? null) !== expectedRevision) return { kind: "conflict" };
      state.ledgers[commitId] = clone(next); save(); return { kind: "written" };
    },
  },
  registry: {
    validate: async current => ({ kind: "authorized", recordWorkKey: current.recordWorkKey, workLeaseId: current.workLeaseId, recordCommitEpoch: current.recordCommitEpoch, fencingToken: current.fencingToken, sourceSnapshotId: current.sourceSnapshotId, inputHash: current.inputHash }),
    readSharedWork: async () => ({ activeTaskIds: ["child-task"] }),
    detachTask: async () => {},
  },
  io: {
    validateTarget: async input => input.target.kind === input.expectedKind && input.target.conversationId === input.binding.conversationId && input.target.recordId === input.binding.recordId,
    validateBodyRef: async input => input.bodyRef.kind === "immutable_record_body" && input.bodyRef.conversationId === input.binding.conversationId && input.bodyRef.recordId === input.binding.recordId,
    readBodyRef: async input => {
      const body = state.bodyObjects[input.bodyRef.objectId];
      if (body === undefined) return { kind: "missing" };
      const bytes = Buffer.from(body, "utf8");
      return bytes.length > input.maxBytes
        ? { kind: "found", body: bytes.subarray(0, input.maxBytes).toString("utf8"), truncated: true }
        : { kind: "found", body, truncated: false };
    },
    captureBodyBeforeImage: async input => { if (state.body.bodyRef !== null) requireBody(state.body.bodyRef, state.body.bodyHash, state.body.byteLength, input.maxBytes); return clone(state.body); },
    stageBody: async input => { requireBody(input.bodyRef, input.bodyHash, input.byteLength, input.maxBytes); state.stagedBodies[input.commitId] = { bodyRef: input.bodyRef, bodyHash: input.bodyHash, byteLength: input.byteLength, ownerCommitId: input.commitId, revision: "stage" }; save(); },
    readStagedBody: async commitId => clone(state.stagedBodies[commitId] ?? emptyBody()),
    publishBody: async input => { requireBody(input.bodyRef, input.bodyHash, input.byteLength, input.maxBytes); state.body = { bodyRef: input.bodyRef, bodyHash: input.bodyHash, byteLength: input.byteLength, ownerCommitId: input.commitId, revision: input.coveredRevision }; save(); },
    readBody: async () => clone(state.body),
    writeMainIndex: async input => { state.mainIndex = { value: input.entry, hash: input.entryHash, ownerCommitId: input.commitId, revision: input.entry.coveredRevision }; save(); },
    readMainIndex: async () => clone(state.mainIndex),
    writeReaderIndex: async input => { state.readerIndex = { value: input.index, hash: input.indexHash, ownerCommitId: input.commitId, revision: input.index.coveredRevision }; save(); },
    readReaderIndex: async () => clone(state.readerIndex),
    discardStagedBodyIfOwned: async () => ({ kind: "already_applied" }),
    restoreBodyIfOwned: async () => ({ kind: "already_applied" }),
    restoreMainIndexIfOwned: async () => ({ kind: "already_applied" }),
    rebuildReaderIndexFromBody: async () => ({ kind: "already_applied" }),
    verifyTaskExclusiveResultsInvisible: async () => true,
    isolateLateOutput: async () => {},
  },
  hash,
  byteLength,
  now: () => "2026-07-13T01:00:" + String(state.clock++).padStart(2, "0") + ".000Z",
  isTaskCancelled: async () => false,
  hooks: mode === "crash" ? { onFaultPoint: async ({ stage, point }) => { if (stage === "BodyPublished" && point === "after_write") process.exit(91); } } : undefined,
};
const protocol = new RecordCommitProtocol(adapter);
const commitId = "child-commit";
if (mode === "crash") {
  const body = "# child record";
  state.providerPostCount += 1; save();
  const currentBinding = binding(body);
  const outputRef = storeBody(body, currentBinding, "child-commit-result");
  await protocol.create({ commitId, binding: currentBinding, payload: { bodyRef: outputRef, bodyHash: hash(body), byteLength: byteLength(body), coveredRevision: "child-revision", bodyTarget: { kind: "record_body", conversationId: currentBinding.conversationId, recordId: currentBinding.recordId, relativePath: "records/body.md" }, mainIndexTarget: { kind: "main_index", conversationId: currentBinding.conversationId, recordId: currentBinding.recordId, relativePath: "indexes/main.json" }, mainIndexEntry: { coveredRevision: "child-revision", commitId, conversationId: currentBinding.conversationId, recordId: currentBinding.recordId }, readerIndexTarget: { kind: "reader_index", conversationId: currentBinding.conversationId, recordId: currentBinding.recordId, relativePath: "indexes/reader.json" }, readerIndex: { bodyHash: hash(body), coveredRevision: "child-revision", commitId, conversationId: currentBinding.conversationId, recordId: currentBinding.recordId } } });
}
const result = await protocol.recover(commitId);
const ledgerText = JSON.stringify(state.ledgers[commitId]);
console.log(JSON.stringify({ kind: result.kind, providerPostCount: state.providerPostCount, bodyObjectCount: Object.keys(state.bodyObjects).length, ledgerContainsBody: ledgerText.includes("# child record") }));
`, "utf8");
    const crashed = spawnSync(process.execPath, ["--import", "tsx", childPath, "crash", statePath], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(crashed.status, 91, `子进程应在 BodyPublished 写后硬退出: ${crashed.stderr}`);
    const resumed = spawnSync(process.execPath, ["--import", "tsx", childPath, "resume", statePath], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(resumed.status, 0, `第二进程应从磁盘 ledger 恢复: ${resumed.stderr}`);
    assert.deepEqual(
        JSON.parse(resumed.stdout.trim()),
        { kind: "verified", providerPostCount: 1, bodyObjectCount: 1, ledgerContainsBody: false },
        "硬退出恢复必须只从磁盘 ref 读取，且不得重发 fake provider POST 或复制正文进 ledger",
    );
}

console.log("record-commit-protocol tests passed");
