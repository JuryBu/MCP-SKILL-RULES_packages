export const RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION = 3;
export const MAX_RECORD_COMMIT_BODY_BYTES = 64 * 1024 * 1024;

export const RECORD_COMMIT_STAGES = [
    "ResultReady",
    "BodyStaged",
    "PublishIntent",
    "BodyPublished",
    "MainIndexWritten",
    "ReaderIndexWritten",
    "Verified",
] as const;

export type RecordCommitStage = typeof RECORD_COMMIT_STAGES[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RecordCommitLifecycle = "Active" | "Cancelling" | "Cancelled" | "Detached";
export type RecordCommitIntentKind = "stage_body" | "publish_intent" | "publish_body" | "write_main_index" | "write_reader_index" | "verify" | "cleanup";
export type RecordCommitFaultPoint = "before_write" | "after_write";
export type RecordCommitPersistenceFaultPoint = "before_intent_persist" | "after_intent_persist" | "before_stage_confirm" | "after_stage_confirm";

export interface RecordCommitBinding {
    conversationKey: string;
    conversationId: string;
    recordId: string;
    taskId: string;
    unitId: string;
    attemptId: string;
    recordWorkKey: string;
    workLeaseId: string;
    recordCommitEpoch: number;
    fencingToken: number;
    contentHash: string;
    sourceSnapshotId: string;
    inputHash: string;
}

export type RecordCommitTargetKind = "record_body" | "main_index" | "reader_index";

export interface RecordCommitTarget {
    kind: RecordCommitTargetKind;
    conversationId: string;
    recordId: string;
    relativePath: string;
}

export interface RecordCommitBodyRef {
    kind: "immutable_record_body";
    conversationId: string;
    recordId: string;
    objectId: string;
    relativePath: string;
}

export interface RecordCommitMainIndexEntry {
    commitId: string;
    coveredRevision: string;
    conversationId: string;
    recordId: string;
}

export interface RecordCommitReaderIndex {
    commitId: string;
    bodyHash: string;
    coveredRevision: string;
    conversationId: string;
    recordId: string;
}

export interface RecordCommitPayloadMetadata {
    snapshot: JsonValue;
    hash: string;
}

export interface RecordCommitPayload {
    bodyRef: RecordCommitBodyRef;
    bodyHash: string;
    byteLength: number;
    coveredRevision: string;
    bodyTarget: RecordCommitTarget;
    mainIndexTarget: RecordCommitTarget;
    mainIndexEntry: RecordCommitMainIndexEntry;
    mainIndexMetadata: RecordCommitPayloadMetadata;
    readerIndexTarget: RecordCommitTarget;
    readerIndex: RecordCommitReaderIndex;
}

export interface RecordCommitBodyImage {
    bodyRef: RecordCommitBodyRef | null;
    bodyHash: string | null;
    byteLength: number | null;
    ownerCommitId: string | null;
    revision: string | null;
}

export type RecordCommitBodyReadResult =
    | { kind: "found"; body: string; truncated: boolean }
    | { kind: "missing" };

export interface RecordCommitJsonImage {
    value: JsonValue | null;
    hash: string | null;
    ownerCommitId: string | null;
    revision: string | null;
    identity?: JsonValue | null;
}

export interface RecordCommitBeforeImages {
    body: RecordCommitBodyImage;
    mainIndex: RecordCommitJsonImage;
    readerIndex: RecordCommitJsonImage;
    capturedAt: string;
}

export interface RecordCommitIntent {
    kind: RecordCommitIntentKind;
    targetStage: RecordCommitStage | null;
    createdAt: string;
    beforeImages?: RecordCommitBeforeImages;
    integrityHash: string;
}

export interface RecordCommitAuditEntry {
    at: string;
    kind: "late_result_discarded" | "stale_fence" | "cancel_detached" | "cleanup_skipped_takeover" | "repair_required";
    detail: string;
}

export interface RecordCommitLedger {
    schemaVersion: typeof RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION;
    kind: "record-commit-protocol";
    commitId: string;
    revision: number;
    binding: RecordCommitBinding;
    payload: RecordCommitPayload;
    payloadHash: string;
    stage: RecordCommitStage;
    confirmedStages: RecordCommitStage[];
    lifecycle: RecordCommitLifecycle;
    repairState: string | null;
    beforeImages?: RecordCommitBeforeImages;
    intent: RecordCommitIntent | null;
    audit: RecordCommitAuditEntry[];
    createdAt: string;
    updatedAt: string;
    integrityHash: string;
}

export type RecordCommitLedgerCasResult =
    | { kind: "written" }
    | { kind: "conflict" };

export type RecordCommitInitialLedgerCasResult = RecordCommitLedgerCasResult
    | { kind: "rejected"; guard: "cancelled" | "stale" | "repair_required"; reason: string };

export interface RecordCommitDurableStateAdapter {
    readLedger(commitId: string): Promise<unknown | null>;
    compareAndSwapInitialLedger(commitId: string, next: RecordCommitLedger): Promise<RecordCommitInitialLedgerCasResult>;
    compareAndSwapLedger(commitId: string, expectedRevision: number | null, next: RecordCommitLedger): Promise<RecordCommitLedgerCasResult>;
}

export type RecordCommitRegistryEvidence =
    | {
        kind: "authorized";
        recordWorkKey: string;
        workLeaseId: string;
        recordCommitEpoch: number;
        fencingToken: number;
        sourceSnapshotId: string;
        inputHash: string;
    }
    | { kind: "stale"; reason: string }
    | { kind: "repair_required"; reason: string };

export interface RecordCommitSharedWorkEvidence {
    activeTaskIds: string[];
}

export interface RecordCommitRegistryAdapter {
    validate(binding: RecordCommitBinding, purpose: "commit" | "cleanup"): Promise<RecordCommitRegistryEvidence>;
    readSharedWork(binding: RecordCommitBinding): Promise<RecordCommitSharedWorkEvidence>;
    detachTask(binding: RecordCommitBinding): Promise<void>;
}

export type RecordCommitConditionalMutationResult =
    | { kind: "applied" | "already_applied" }
    | { kind: "ownership_changed"; reason: string };

export interface RecordCommitIoAdapter {
    validateTarget(input: { binding: RecordCommitBinding; target: RecordCommitTarget; expectedKind: RecordCommitTargetKind }): Promise<boolean>;
    validateBodyRef(input: { binding: RecordCommitBinding; bodyRef: RecordCommitBodyRef }): Promise<boolean>;
    readBodyRef(input: { binding: RecordCommitBinding; bodyRef: RecordCommitBodyRef; maxBytes: number }): Promise<RecordCommitBodyReadResult>;
    captureBodyBeforeImage(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; maxBytes: number }): Promise<RecordCommitBodyImage>;
    stageBody(input: { commitId: string; binding: RecordCommitBinding; bodyRef: RecordCommitBodyRef; bodyHash: string; byteLength: number; maxBytes: number }): Promise<void>;
    readStagedBody(commitId: string): Promise<RecordCommitBodyImage>;
    publishBody(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; bodyRef: RecordCommitBodyRef; bodyHash: string; byteLength: number; maxBytes: number; coveredRevision: string }): Promise<void>;
    readBody(target: RecordCommitTarget): Promise<RecordCommitBodyImage>;
    writeMainIndex(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; entry: RecordCommitMainIndexEntry; entryHash: string }): Promise<void>;
    readMainIndex(target: RecordCommitTarget): Promise<RecordCommitJsonImage>;
    writeReaderIndex(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; index: RecordCommitReaderIndex; indexHash: string }): Promise<void>;
    readReaderIndex(target: RecordCommitTarget): Promise<RecordCommitJsonImage>;
    discardStagedBodyIfOwned(input: { commitId: string; binding: RecordCommitBinding; expectedBodyRef: RecordCommitBodyRef; expectedBodyHash: string; expectedByteLength: number }): Promise<RecordCommitConditionalMutationResult>;
    restoreBodyIfOwned(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; expected: RecordCommitBodyImage; before: RecordCommitBodyImage; maxBytes: number }): Promise<RecordCommitConditionalMutationResult>;
    restoreMainIndexIfOwned(input: { commitId: string; binding: RecordCommitBinding; target: RecordCommitTarget; expectedEntryHash: string; before: RecordCommitJsonImage }): Promise<RecordCommitConditionalMutationResult>;
    rebuildReaderIndexFromBody(input: { commitId: string; binding: RecordCommitBinding; bodyTarget: RecordCommitTarget; mainIndexTarget: RecordCommitTarget; readerIndexTarget: RecordCommitTarget; expectedBody: RecordCommitBodyImage; expectedMainIndex: RecordCommitJsonImage; expectedReaderIndex: RecordCommitJsonImage; maxBytes: number }): Promise<RecordCommitConditionalMutationResult>;
    verifyTaskExclusiveResultsInvisible(input: { commitId: string; binding: RecordCommitBinding; bodyTarget: RecordCommitTarget; mainIndexTarget: RecordCommitTarget; readerIndexTarget: RecordCommitTarget }): Promise<boolean>;
    isolateLateOutput(input: { commitId: string; binding: RecordCommitBinding; bodyRef: RecordCommitBodyRef; bodyHash: string; byteLength: number; reason: string }): Promise<void>;
}

export interface RecordCommitPersistenceFaultInput {
    commitId: string;
    stage: RecordCommitStage;
    point: RecordCommitPersistenceFaultPoint;
    binding: RecordCommitBinding;
    expectedRevision: number;
    nextRevision: number;
}

export interface RecordCommitProtocolHooks {
    onFaultPoint?(input: { commitId: string; stage: RecordCommitStage; point: RecordCommitFaultPoint }): Promise<void> | void;
    onPersistenceFaultPoint?(input: RecordCommitPersistenceFaultInput): Promise<void> | void;
    onCleanupCheckpoint?(input: { commitId: string; point: "before_guard" | "before_effect" }): Promise<void> | void;
}

export interface RecordCommitProtocolAdapter {
    durable: RecordCommitDurableStateAdapter;
    registry: RecordCommitRegistryAdapter;
    io: RecordCommitIoAdapter;
    hash(value: string): string;
    byteLength(value: string): number;
    now(): string;
    isTaskCancelled(taskId: string): Promise<boolean>;
    materializeCommitPayloadMetadata?(input: { binding: RecordCommitBinding; payload: Omit<RecordCommitPayload, "mainIndexMetadata"> }): Promise<RecordCommitPayloadMetadata>;
    hooks?: RecordCommitProtocolHooks;
}

export interface CreateRecordCommitInput {
    commitId: string;
    binding: RecordCommitBinding;
    payload: Omit<RecordCommitPayload, "mainIndexMetadata"> & { mainIndexMetadata?: RecordCommitPayloadMetadata };
}

export type RecordCommitAdvanceResult =
    | { kind: "advanced"; ledger: RecordCommitLedger }
    | { kind: "verified"; ledger: RecordCommitLedger }
    | { kind: "cancelled"; ledger: RecordCommitLedger }
    | { kind: "detached"; ledger: RecordCommitLedger }
    | { kind: "audited_stale"; ledger: RecordCommitLedger }
    | { kind: "repair_required"; ledger: RecordCommitLedger };

export class RecordCommitIdReuseError extends Error {
    constructor(readonly commitId: string, readonly reason = "commit_object_mismatch") {
        super(`commitId ${commitId} 已绑定到不同的提交对象: ${reason}`);
        this.name = "RecordCommitIdReuseError";
    }
}

export class RecordCommitLedgerRepairRequiredError extends Error {
    constructor(readonly commitId: string, readonly reason: string) {
        super(`commit ledger ${commitId} 需要修复: ${reason}`);
        this.name = "RecordCommitLedgerRepairRequiredError";
    }
}

export class RecordCommitInitialGuardRejectedError extends Error {
    constructor(
        readonly commitId: string,
        readonly guard: "cancelled" | "stale" | "repair_required",
        readonly reason: string,
    ) {
        super(`commit ${commitId} 初始 guard 拒绝: ${guard} (${reason})`);
        this.name = "RecordCommitInitialGuardRejectedError";
    }
}

export class RecordCommitVerificationError extends Error {
    constructor(readonly reason: string) {
        super(`record commit verification failed: ${reason}`);
        this.name = "RecordCommitVerificationError";
    }
}

const NEXT_STAGE: Record<RecordCommitStage, RecordCommitStage | null> = {
    ResultReady: "BodyStaged",
    BodyStaged: "PublishIntent",
    PublishIntent: "BodyPublished",
    BodyPublished: "MainIndexWritten",
    MainIndexWritten: "ReaderIndexWritten",
    ReaderIndexWritten: "Verified",
    Verified: null,
};

function canonicalJson(value: JsonValue): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("ledger 不能包含非有限数字");
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function clone<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
    const allowed = new Set(allowedKeys);
    return Object.keys(value).every(key => allowed.has(key)) && allowedKeys.every(key => Object.hasOwn(value, key));
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stageIndex(stage: RecordCommitStage): number {
    return RECORD_COMMIT_STAGES.indexOf(stage);
}

function isRecordCommitStage(value: unknown): value is RecordCommitStage {
    return typeof value === "string" && (RECORD_COMMIT_STAGES as readonly string[]).includes(value);
}

function hashJson(adapter: Pick<RecordCommitProtocolAdapter, "hash">, value: JsonValue): string {
    return adapter.hash(canonicalJson(value));
}

function hashBody(adapter: Pick<RecordCommitProtocolAdapter, "hash">, body: string): string {
    return adapter.hash(body);
}

function withoutIntegrityHash(ledger: RecordCommitLedger): Omit<RecordCommitLedger, "integrityHash"> {
    const { integrityHash: _integrityHash, ...withoutHash } = ledger;
    return withoutHash;
}

function withoutIntentHash(intent: RecordCommitIntent): Omit<RecordCommitIntent, "integrityHash"> {
    const { integrityHash: _integrityHash, ...withoutHash } = intent;
    return withoutHash;
}

function sealIntent(adapter: Pick<RecordCommitProtocolAdapter, "hash">, intent: Omit<RecordCommitIntent, "integrityHash">): RecordCommitIntent {
    const { integrityHash: _integrityHash, ...withoutHash } = intent as Omit<RecordCommitIntent, "integrityHash"> & { integrityHash?: string };
    return { ...withoutHash, integrityHash: hashJson(adapter, withoutHash as unknown as JsonValue) };
}

function sealLedger(adapter: Pick<RecordCommitProtocolAdapter, "hash">, ledger: Omit<RecordCommitLedger, "integrityHash">): RecordCommitLedger {
    const { integrityHash: _integrityHash, ...withoutHash } = ledger as Omit<RecordCommitLedger, "integrityHash"> & { integrityHash?: string };
    return { ...withoutHash, integrityHash: hashJson(adapter, withoutHash as unknown as JsonValue) };
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

function firstJsonDifferencePath(left: JsonValue, right: JsonValue, path = "$" ): string | null {
    if (left === right) return null;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return path;
        if (left.length !== right.length) return `${path}.length`;
        for (let index = 0; index < left.length; index += 1) {
            const difference = firstJsonDifferencePath(left[index]!, right[index]!, `${path}[${index}]`);
            if (difference) return difference;
        }
        return null;
    }
    if (isRecord(left) || isRecord(right)) {
        if (!isRecord(left) || !isRecord(right)) return path;
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        for (const key of keys) {
            if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return `${path}.${key}`;
            const difference = firstJsonDifferencePath(left[key] as JsonValue, right[key] as JsonValue, `${path}.${key}`);
            if (difference) return difference;
        }
        return null;
    }
    return path;
}

function sameCommitObject(
    adapter: Pick<RecordCommitProtocolAdapter, "hash">,
    ledger: RecordCommitLedger,
    input: Omit<CreateRecordCommitInput, "payload"> & { payload: RecordCommitPayload },
): boolean {
    return ledger.commitId === input.commitId
        && sameJson(ledger.binding as unknown as JsonValue, input.binding as unknown as JsonValue)
        && sameJson(ledger.payload as unknown as JsonValue, input.payload as unknown as JsonValue)
        && ledger.payloadHash === hashJson(adapter, input.payload as unknown as JsonValue);
}

function commitObjectMismatchReason(
    adapter: Pick<RecordCommitProtocolAdapter, "hash">,
    ledger: RecordCommitLedger,
    input: Omit<CreateRecordCommitInput, "payload"> & { payload: RecordCommitPayload },
): string {
    if (ledger.commitId !== input.commitId) return "commit_id_mismatch";
    if (!sameJson(ledger.binding as unknown as JsonValue, input.binding as unknown as JsonValue)) return "binding_mismatch";
    if (!sameJson(ledger.payload as unknown as JsonValue, input.payload as unknown as JsonValue)) {
        const path = firstJsonDifferencePath(ledger.payload as unknown as JsonValue, input.payload as unknown as JsonValue);
        return `payload_mismatch${path ? `:${path}` : ""}`;
    }
    if (ledger.payloadHash !== hashJson(adapter, input.payload as unknown as JsonValue)) return "payload_hash_mismatch";
    return "commit_object_mismatch";
}

function assertBinding(binding: RecordCommitBinding): void {
    const strings: Array<keyof RecordCommitBinding> = [
        "conversationKey",
        "conversationId",
        "recordId",
        "taskId",
        "unitId",
        "attemptId",
        "recordWorkKey",
        "workLeaseId",
        "contentHash",
        "sourceSnapshotId",
        "inputHash",
    ];
    for (const key of strings) {
        if (!isNonEmptyString(binding[key])) throw new TypeError(`binding.${key} 必须是非空字符串`);
    }
    if (!isPositiveInteger(binding.recordCommitEpoch)) throw new TypeError("binding.recordCommitEpoch 必须是正整数");
    if (!isPositiveInteger(binding.fencingToken)) throw new TypeError("binding.fencingToken 必须是正整数");
}

function assertCanonicalRelativePath(relativePath: string, label: string): void {
    if (relativePath.startsWith("/")
        || relativePath.startsWith("\\")
        || /^[A-Za-z]:/u.test(relativePath)
        || relativePath.includes("\\")
        || relativePath.includes("%")
        || relativePath.includes("\0")) {
        throw new TypeError(`${label} 必须是规范相对路径`);
    }
    const segments = relativePath.split("/");
    if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
        throw new TypeError(`${label} 禁止空段、当前目录或上跳段`);
    }
}

function assertTarget(binding: RecordCommitBinding, target: RecordCommitTarget, expectedKind: RecordCommitTargetKind): void {
    if (!isRecord(target)
        || !hasOnlyKeys(target, ["kind", "conversationId", "recordId", "relativePath"])
        || target.kind !== expectedKind
        || target.conversationId !== binding.conversationId
        || target.recordId !== binding.recordId
        || !isNonEmptyString(target.relativePath)) {
        throw new TypeError(`${expectedKind} target 与 commit identity 不匹配`);
    }
    assertCanonicalRelativePath(target.relativePath, `${expectedKind} target`);
}

function assertBodyRef(binding: RecordCommitBinding, bodyRef: RecordCommitBodyRef): void {
    if (!isRecord(bodyRef)
        || !hasOnlyKeys(bodyRef, ["kind", "conversationId", "recordId", "objectId", "relativePath"])
        || bodyRef.kind !== "immutable_record_body"
        || bodyRef.conversationId !== binding.conversationId
        || bodyRef.recordId !== binding.recordId
        || !isNonEmptyString(bodyRef.objectId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(bodyRef.objectId)
        || !isNonEmptyString(bodyRef.relativePath)) {
        throw new TypeError("bodyRef 与 commit identity/objectId 不匹配");
    }
    assertCanonicalRelativePath(bodyRef.relativePath, "bodyRef.relativePath");
}

function assertPayload(adapter: Pick<RecordCommitProtocolAdapter, "hash">, binding: RecordCommitBinding, payload: RecordCommitPayload, commitId?: string): void {
    if (!isRecord(payload) || !hasOnlyKeys(payload, [
        "bodyRef",
        "bodyHash",
        "byteLength",
        "coveredRevision",
        "bodyTarget",
        "mainIndexTarget",
        "mainIndexEntry",
        "mainIndexMetadata",
        "readerIndexTarget",
        "readerIndex",
    ])) throw new TypeError("payload 字段集合无效");
    assertBodyRef(binding, payload.bodyRef);
    if (!isNonEmptyString(payload.bodyHash) || payload.bodyHash !== binding.contentHash) throw new TypeError("payload.bodyHash 与 binding.contentHash 不匹配");
    if (!isNonNegativeInteger(payload.byteLength) || payload.byteLength > MAX_RECORD_COMMIT_BODY_BYTES) throw new TypeError("payload.byteLength 超出协议边界");
    if (!isNonEmptyString(payload.coveredRevision)) throw new TypeError("payload.coveredRevision 必须是非空字符串");
    assertTarget(binding, payload.bodyTarget, "record_body");
    assertTarget(binding, payload.mainIndexTarget, "main_index");
    assertTarget(binding, payload.readerIndexTarget, "reader_index");
    if (!isRecord(payload.mainIndexEntry)
        || !hasOnlyKeys(payload.mainIndexEntry, ["commitId", "coveredRevision", "conversationId", "recordId"])
        || !isNonEmptyString(payload.mainIndexEntry.commitId)
        || payload.mainIndexEntry.coveredRevision !== payload.coveredRevision
        || payload.mainIndexEntry.conversationId !== binding.conversationId
        || payload.mainIndexEntry.recordId !== binding.recordId
        || (commitId !== undefined && payload.mainIndexEntry.commitId !== commitId)) {
        throw new TypeError("payload.mainIndexEntry identity/revision/commitId 不匹配");
    }
    if (!isRecord(payload.mainIndexMetadata)
        || !hasOnlyKeys(payload.mainIndexMetadata, ["snapshot", "hash"])
        || !isJsonValue(payload.mainIndexMetadata.snapshot)
        || !isNonEmptyString(payload.mainIndexMetadata.hash)
        || payload.mainIndexMetadata.hash !== hashJson(adapter, payload.mainIndexMetadata.snapshot)) {
        throw new TypeError("payload.mainIndexMetadata snapshot/hash 不匹配");
    }
    if (!isRecord(payload.readerIndex)
        || !hasOnlyKeys(payload.readerIndex, ["commitId", "bodyHash", "coveredRevision", "conversationId", "recordId"])
        || !isNonEmptyString(payload.readerIndex.commitId)
        || payload.readerIndex.bodyHash !== payload.bodyHash
        || payload.readerIndex.coveredRevision !== payload.coveredRevision
        || payload.readerIndex.conversationId !== binding.conversationId
        || payload.readerIndex.recordId !== binding.recordId
        || (commitId !== undefined && payload.readerIndex.commitId !== commitId)) {
        throw new TypeError("payload.readerIndex bodyHash/identity/revision/commitId 不匹配");
    }
}

function assertBodyImage(binding: RecordCommitBinding, image: RecordCommitBodyImage): void {
    if (!isRecord(image) || !hasOnlyKeys(image, ["bodyRef", "bodyHash", "byteLength", "ownerCommitId", "revision"])) {
        throw new TypeError("正文 before-image 字段集合无效");
    }
    if (image.bodyRef === null) {
        if (image.bodyHash !== null || image.byteLength !== null || image.ownerCommitId !== null || image.revision !== null) {
            throw new TypeError("空正文 before-image 不得携带引用或所有权元数据");
        }
    } else {
        assertBodyRef(binding, image.bodyRef);
        if (!isNonEmptyString(image.bodyHash)) throw new TypeError("正文 before-image bodyHash 无效");
        if (!isNonNegativeInteger(image.byteLength) || image.byteLength > MAX_RECORD_COMMIT_BODY_BYTES) throw new TypeError("正文 before-image byteLength 无效");
    }
    if (!(image.ownerCommitId === null || isNonEmptyString(image.ownerCommitId))) throw new TypeError("正文 before-image ownerCommitId 无效");
    if (!(image.revision === null || isNonEmptyString(image.revision))) throw new TypeError("正文 before-image revision 无效");
}

function assertJsonImage(adapter: Pick<RecordCommitProtocolAdapter, "hash">, image: RecordCommitJsonImage): void {
    if (image.value === null) {
        if (image.hash !== null) throw new TypeError("空索引 before-image 不得携带 hash");
    } else if (!isJsonValue(image.value) || image.hash !== hashJson(adapter, image.value)) {
        throw new TypeError("索引 before-image hash 不匹配");
    }
    if (!(image.ownerCommitId === null || isNonEmptyString(image.ownerCommitId))) throw new TypeError("索引 before-image ownerCommitId 无效");
    if (!(image.revision === null || isNonEmptyString(image.revision))) throw new TypeError("索引 before-image revision 无效");
    if (!(image.identity === undefined || image.identity === null || isJsonValue(image.identity))) throw new TypeError("索引 before-image identity 无效");
}

function sameBodyRef(left: RecordCommitBodyRef | null, right: RecordCommitBodyRef | null): boolean {
    return left === null || right === null
        ? left === right
        : sameJson(left as unknown as JsonValue, right as unknown as JsonValue);
}

function sameBodyImage(left: RecordCommitBodyImage, right: RecordCommitBodyImage): boolean {
    return sameBodyRef(left.bodyRef, right.bodyRef)
        && left.bodyHash === right.bodyHash
        && left.byteLength === right.byteLength
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision;
}

function sameJsonImage(left: RecordCommitJsonImage, right: RecordCommitJsonImage): boolean {
    return left.hash === right.hash
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision
        && left.value !== undefined
        && right.value !== undefined
        && sameJson(left.value, right.value)
        && sameJson(left.identity ?? null, right.identity ?? null);
}

function assertBeforeImages(adapter: Pick<RecordCommitProtocolAdapter, "hash">, binding: RecordCommitBinding, images: RecordCommitBeforeImages): void {
    assertBodyImage(binding, images.body);
    assertJsonImage(adapter, images.mainIndex);
    assertJsonImage(adapter, images.readerIndex);
    if (!isNonEmptyString(images.capturedAt)) throw new TypeError("before-image 缺少 capturedAt");
}

function assertIntent(adapter: Pick<RecordCommitProtocolAdapter, "hash">, binding: RecordCommitBinding, intent: RecordCommitIntent): void {
    const allowedKinds: readonly RecordCommitIntentKind[] = ["stage_body", "publish_intent", "publish_body", "write_main_index", "write_reader_index", "verify", "cleanup"];
    if (!allowedKinds.includes(intent.kind)) throw new TypeError("ledger intent kind 无效");
    if (!(intent.targetStage === null || isRecordCommitStage(intent.targetStage))) throw new TypeError("ledger intent targetStage 无效");
    if (!isNonEmptyString(intent.createdAt)) throw new TypeError("ledger intent 缺少 createdAt");
    if (intent.beforeImages) assertBeforeImages(adapter, binding, intent.beforeImages);
    if (intent.integrityHash !== hashJson(adapter, withoutIntentHash(intent) as unknown as JsonValue)) throw new TypeError("ledger intent hash 不匹配");
}

function assertConfirmedStages(stage: RecordCommitStage, confirmedStages: unknown): asserts confirmedStages is RecordCommitStage[] {
    if (!Array.isArray(confirmedStages) || confirmedStages.length === 0) throw new TypeError("ledger confirmedStages 无效");
    const expected = RECORD_COMMIT_STAGES.slice(0, stageIndex(stage) + 1);
    if (confirmedStages.length !== expected.length || confirmedStages.some((value, index) => value !== expected[index])) {
        throw new TypeError("ledger 阶段不是严格单向序列");
    }
}

export function validateRecordCommitLedger(adapter: Pick<RecordCommitProtocolAdapter, "hash">, value: unknown): value is RecordCommitLedger {
    try {
        if (!isRecord(value)
            || value.schemaVersion !== RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION
            || value.kind !== "record-commit-protocol"
            || !isNonEmptyString(value.commitId)
            || !isPositiveInteger(value.revision)
            || !isRecord(value.binding)
            || !isRecord(value.payload)
            || !isNonEmptyString(value.payloadHash)
            || !isRecordCommitStage(value.stage)
            || !["Active", "Cancelling", "Cancelled", "Detached"].includes(value.lifecycle as string)
            || !(value.repairState === null || isNonEmptyString(value.repairState))
            || !(value.intent === null || isRecord(value.intent))
            || !Array.isArray(value.audit)
            || !isNonEmptyString(value.createdAt)
            || !isNonEmptyString(value.updatedAt)
            || !isNonEmptyString(value.integrityHash)) return false;
        const ledger = value as unknown as RecordCommitLedger;
        assertBinding(ledger.binding);
        assertPayload(adapter, ledger.binding, ledger.payload, ledger.commitId);
        if (ledger.payloadHash !== hashJson(adapter, ledger.payload as unknown as JsonValue)) return false;
        assertConfirmedStages(ledger.stage, ledger.confirmedStages);
        if (ledger.beforeImages) assertBeforeImages(adapter, ledger.binding, ledger.beforeImages);
        if (ledger.intent) assertIntent(adapter, ledger.binding, ledger.intent);
        for (const audit of ledger.audit) {
            if (!isRecord(audit) || !isNonEmptyString(audit.at) || !isNonEmptyString(audit.detail)
                || !["late_result_discarded", "stale_fence", "cancel_detached", "cleanup_skipped_takeover", "repair_required"].includes(audit.kind as string)) return false;
        }
        if ((ledger.lifecycle === "Cancelled" || ledger.lifecycle === "Detached") && ledger.repairState !== null) return false;
        return ledger.integrityHash === hashJson(adapter, withoutIntegrityHash(ledger) as unknown as JsonValue);
    } catch {
        return false;
    }
}

function intentKindForStage(stage: RecordCommitStage): RecordCommitIntentKind {
    switch (stage) {
        case "BodyStaged": return "stage_body";
        case "PublishIntent": return "publish_intent";
        case "BodyPublished": return "publish_body";
        case "MainIndexWritten": return "write_main_index";
        case "ReaderIndexWritten": return "write_reader_index";
        case "Verified": return "verify";
        case "ResultReady": throw new Error("ResultReady 不是可前进的目标阶段");
    }
}

type CommitGuard =
    | { kind: "authorized" }
    | { kind: "cancelled" }
    | { kind: "stale"; reason: string }
    | { kind: "repair_required"; reason: string };

export class RecordCommitProtocol {
    constructor(private readonly adapter: RecordCommitProtocolAdapter) {}

    async create(input: CreateRecordCommitInput): Promise<RecordCommitLedger> {
        if (!isNonEmptyString(input.commitId)) throw new TypeError("commitId 必须是非空字符串");
        assertBinding(input.binding);
        const initialCurrent = await this.adapter.durable.readLedger(input.commitId);
        let persistedMetadata: RecordCommitPayloadMetadata | undefined;
        if (initialCurrent !== null) {
            if (!validateRecordCommitLedger(this.adapter, initialCurrent)) {
                throw new RecordCommitLedgerRepairRequiredError(input.commitId, "ledger_invalid_or_hash_mismatch");
            }
            persistedMetadata = initialCurrent.payload.mainIndexMetadata;
        }
        const payload = await this.materializePayload(input.binding, input.payload.mainIndexMetadata || !persistedMetadata
            ? input.payload
            : { ...input.payload, mainIndexMetadata: clone(persistedMetadata) });
        const normalizedInput = { ...input, payload };
        assertPayload(this.adapter, input.binding, payload, input.commitId);
        await this.validateAdapterTargets(input.binding, payload);
        await this.verifyBodyReference(input.binding, payload.bodyRef, payload.bodyHash, payload.byteLength, "create_payload");
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const current = attempt === 0 ? initialCurrent : await this.adapter.durable.readLedger(input.commitId);
            if (current !== null) {
                if (!validateRecordCommitLedger(this.adapter, current)) {
                    throw new RecordCommitLedgerRepairRequiredError(input.commitId, "ledger_invalid_or_hash_mismatch");
                }
                if (!sameCommitObject(this.adapter, current, normalizedInput)) {
                    throw new RecordCommitIdReuseError(input.commitId, commitObjectMismatchReason(this.adapter, current, normalizedInput));
                }
                return clone(current);
            }
            const now = this.adapter.now();
            const next = sealLedger(this.adapter, {
                schemaVersion: RECORD_COMMIT_PROTOCOL_SCHEMA_VERSION,
                kind: "record-commit-protocol",
                commitId: input.commitId,
                revision: 1,
                binding: clone(input.binding),
                payload: clone(payload),
                payloadHash: hashJson(this.adapter, payload as unknown as JsonValue),
                stage: "ResultReady",
                confirmedStages: ["ResultReady"],
                lifecycle: "Active",
                repairState: null,
                intent: null,
                audit: [],
                createdAt: now,
                updatedAt: now,
            });
            const written = await this.adapter.durable.compareAndSwapInitialLedger(input.commitId, next);
            if (written.kind === "written") return next;
            if (written.kind === "rejected") {
                throw new RecordCommitInitialGuardRejectedError(input.commitId, written.guard, written.reason);
            }
        }
        throw new Error(`commit ledger ${input.commitId} 创建 CAS 重试耗尽`);
    }

    private async materializePayload(
        binding: RecordCommitBinding,
        payload: CreateRecordCommitInput["payload"],
    ): Promise<RecordCommitPayload> {
        if (payload.mainIndexMetadata) return clone(payload) as RecordCommitPayload;
        const { mainIndexMetadata: _mainIndexMetadata, ...withoutMetadata } = payload;
        const metadata = this.adapter.materializeCommitPayloadMetadata
            ? await this.adapter.materializeCommitPayloadMetadata({ binding: clone(binding), payload: clone(withoutMetadata) })
            : (() => {
                const snapshot: JsonValue = {
                    kind: "legacy-implicit-record-index-metadata",
                    conversationId: binding.conversationId,
                    recordId: binding.recordId,
                    bodyHash: payload.bodyHash,
                    byteLength: payload.byteLength,
                    coveredRevision: payload.coveredRevision,
                };
                return { snapshot, hash: hashJson(this.adapter, snapshot) };
            })();
        return { ...clone(withoutMetadata), mainIndexMetadata: clone(metadata) };
    }

    async read(commitId: string): Promise<RecordCommitLedger> {
        const value = await this.adapter.durable.readLedger(commitId);
        if (!validateRecordCommitLedger(this.adapter, value)) {
            throw new RecordCommitLedgerRepairRequiredError(commitId, value === null ? "ledger_missing" : "ledger_invalid_or_hash_mismatch");
        }
        return clone(value);
    }

    async advanceOnce(commitId: string): Promise<RecordCommitAdvanceResult> {
        const ledger = await this.read(commitId);
        if (ledger.lifecycle === "Cancelled") return { kind: "cancelled", ledger };
        if (ledger.lifecycle === "Detached") return { kind: "detached", ledger };
        await this.validateAdapterTargets(ledger.binding, ledger.payload);
        if (ledger.repairState && ledger.lifecycle !== "Cancelling") return { kind: "repair_required", ledger };
        if (ledger.lifecycle === "Cancelling") return this.cleanup(commitId);
        if (ledger.stage === "Verified") return { kind: "verified", ledger };
        const beforeIntent = await this.guard(ledger.binding);
        const stopped = await this.stopForGuard(ledger, beforeIntent);
        if (stopped) return stopped;
        const nextStage = NEXT_STAGE[ledger.stage];
        if (!nextStage) return { kind: "verified", ledger };
        if (nextStage === "PublishIntent") return this.publishIntent(commitId, ledger);
        const intentLedger = await this.ensureIntent(commitId, nextStage);
        const beforeWrite = await this.guard(intentLedger.binding);
        const stoppedAfterIntent = await this.stopForGuard(intentLedger, beforeWrite);
        if (stoppedAfterIntent) return stoppedAfterIntent;
        await this.fault(intentLedger.commitId, nextStage, "before_write");
        try {
            await this.performWrite(intentLedger, nextStage);
            await this.fault(intentLedger.commitId, nextStage, "after_write");
            await this.verifyStageWrite(intentLedger, nextStage);
        } catch (error) {
            if (error instanceof RecordCommitVerificationError) {
                return { kind: "repair_required", ledger: await this.markRepair(commitId, error.reason) };
            }
            throw error;
        }
        const afterWrite = await this.guard(intentLedger.binding);
        const stoppedAfterWrite = await this.stopForGuard(intentLedger, afterWrite);
        if (stoppedAfterWrite) return stoppedAfterWrite;
        const confirmed = await this.confirmStage(commitId, nextStage);
        return nextStage === "Verified" ? { kind: "verified", ledger: confirmed } : { kind: "advanced", ledger: confirmed };
    }

    async recover(commitId: string): Promise<RecordCommitAdvanceResult> {
        for (let attempt = 0; attempt < RECORD_COMMIT_STAGES.length + 2; attempt += 1) {
            const result = await this.advanceOnce(commitId);
            if (result.kind !== "advanced") return result;
        }
        throw new Error(`commit ledger ${commitId} 未在有限步骤内收敛`);
    }

    async cancel(commitId: string): Promise<RecordCommitAdvanceResult> {
        const ledger = await this.read(commitId);
        if (ledger.lifecycle === "Cancelled") return { kind: "cancelled", ledger };
        if (ledger.lifecycle === "Detached") return { kind: "detached", ledger };
        await this.validateAdapterTargets(ledger.binding, ledger.payload);
        const initialStop = await this.stopForCleanupFence(ledger, await this.guard(ledger.binding, true));
        if (initialStop) return initialStop;
        const beforeDetach = await this.adapter.registry.readSharedWork(ledger.binding);
        if (beforeDetach.activeTaskIds.includes(ledger.binding.taskId)) {
            const preDetachStop = await this.stopForCleanupFence(ledger, await this.guard(ledger.binding, true));
            if (preDetachStop) return preDetachStop;
            await this.adapter.registry.detachTask(ledger.binding);
            const postDetachStop = await this.stopForCleanupFence(ledger, await this.guard(ledger.binding, true));
            if (postDetachStop) return postDetachStop;
        }
        const afterDetach = await this.adapter.registry.readSharedWork(ledger.binding);
        if (afterDetach.activeTaskIds.includes(ledger.binding.taskId)) {
            return { kind: "repair_required", ledger: await this.markRepair(commitId, "cancel_detach_not_persisted") };
        }
        const otherActiveTasks = afterDetach.activeTaskIds.filter(taskId => taskId !== ledger.binding.taskId);
        if (otherActiveTasks.length > 0) {
            return { kind: "detached", ledger: await this.markDetached(commitId, `shared work remains attached to ${otherActiveTasks.join(",")}`) };
        }
        await this.ensureCleanupIntent(commitId);
        return this.cleanup(commitId);
    }

    async discardLateResult(commitId: string, bodyRef: RecordCommitBodyRef, bodyHash: string, byteLength: number, reason = "late_result"): Promise<RecordCommitAdvanceResult> {
        const ledger = await this.read(commitId);
        assertBodyRef(ledger.binding, bodyRef);
        if (!isNonEmptyString(bodyHash)) throw new TypeError("迟到结果的 bodyHash 无效");
        if (!isNonNegativeInteger(byteLength) || byteLength > MAX_RECORD_COMMIT_BODY_BYTES) throw new TypeError("迟到结果的 byteLength 无效");
        await this.verifyBodyReference(ledger.binding, bodyRef, bodyHash, byteLength, "late_output");
        await this.adapter.io.isolateLateOutput({ commitId, binding: ledger.binding, bodyRef: clone(bodyRef), bodyHash, byteLength, reason });
        return { kind: "audited_stale", ledger: await this.audit(commitId, "late_result_discarded", reason) };
    }

    private async cleanup(commitId: string): Promise<RecordCommitAdvanceResult> {
        let ledger = await this.ensureCleanupIntent(commitId);
        if (ledger.lifecycle === "Cancelled") return { kind: "cancelled", ledger };
        if (ledger.lifecycle === "Detached") return { kind: "detached", ledger };
        await this.validateAdapterTargets(ledger.binding, ledger.payload);
        try {
            let stopped = await this.runCleanupEffect(
                commitId,
                "discard_staged_body",
                async current => {
                    await this.verifyPayloadBodyReference(current, "cleanup_discard_staged_before");
                    return this.adapter.io.discardStagedBodyIfOwned({
                        commitId,
                        binding: current.binding,
                        expectedBodyRef: clone(current.payload.bodyRef),
                        expectedBodyHash: current.payload.bodyHash,
                        expectedByteLength: current.payload.byteLength,
                    });
                },
                async current => {
                    await this.verifyPayloadBodyReference(current, "cleanup_discard_staged_precondition");
                    const image = await this.adapter.io.readStagedBody(commitId);
                    return image.bodyRef === null || this.matchesPayloadBody(image, current);
                },
                async current => {
                    await this.verifyPayloadBodyReference(current, "cleanup_discard_staged_after");
                    const image = await this.adapter.io.readStagedBody(commitId);
                    return image.bodyRef === null && image.ownerCommitId === null;
                },
            );
            if (stopped) return stopped;
            ledger = await this.read(commitId);
            const beforeImages = ledger.beforeImages;
            if (beforeImages) {
                stopped = await this.runCleanupEffect(
                    commitId,
                    "restore_body",
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_restore_body_before_image");
                        return this.adapter.io.restoreBodyIfOwned({
                            commitId,
                            binding: current.binding,
                            target: current.payload.bodyTarget,
                            expected: this.expectedPublishedBody(current),
                            before: clone(beforeImages.body),
                            maxBytes: (beforeImages.body.byteLength ?? 0) + 1,
                        });
                    },
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_restore_body_precondition");
                        const image = await this.adapter.io.readBody(current.payload.bodyTarget);
                        return sameBodyImage(image, beforeImages.body)
                            || sameBodyImage(image, this.expectedPublishedBody(current));
                    },
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_restore_body_after");
                        return sameBodyImage(await this.adapter.io.readBody(current.payload.bodyTarget), beforeImages.body);
                    },
                );
                if (stopped) return stopped;
                stopped = await this.runCleanupEffect(
                    commitId,
                    "restore_main_index",
                    current => this.adapter.io.restoreMainIndexIfOwned({
                        commitId,
                        binding: current.binding,
                        target: current.payload.mainIndexTarget,
                        expectedEntryHash: hashJson(this.adapter, current.payload.mainIndexEntry as unknown as JsonValue),
                        before: clone(beforeImages.mainIndex),
                    }),
                    async current => {
                        const image = await this.adapter.io.readMainIndex(current.payload.mainIndexTarget);
                        return sameJsonImage(image, beforeImages.mainIndex)
                            || (image.ownerCommitId === current.commitId
                                && image.hash === hashJson(this.adapter, current.payload.mainIndexEntry as unknown as JsonValue));
                    },
                    async current => sameJsonImage(await this.adapter.io.readMainIndex(current.payload.mainIndexTarget), beforeImages.mainIndex),
                );
                if (stopped) return stopped;
                stopped = await this.runCleanupEffect(
                    commitId,
                    "rebuild_reader_index",
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_rebuild_reader_before_image");
                        return this.adapter.io.rebuildReaderIndexFromBody({
                            commitId,
                            binding: current.binding,
                            bodyTarget: current.payload.bodyTarget,
                            mainIndexTarget: current.payload.mainIndexTarget,
                            readerIndexTarget: current.payload.readerIndexTarget,
                            expectedBody: clone(beforeImages.body),
                            expectedMainIndex: clone(beforeImages.mainIndex),
                            expectedReaderIndex: clone(beforeImages.readerIndex),
                            maxBytes: (beforeImages.body.byteLength ?? 0) + 1,
                        });
                    },
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_rebuild_reader_precondition");
                        const [body, mainIndex, readerIndex] = await Promise.all([
                            this.adapter.io.readBody(current.payload.bodyTarget),
                            this.adapter.io.readMainIndex(current.payload.mainIndexTarget),
                            this.adapter.io.readReaderIndex(current.payload.readerIndexTarget),
                        ]);
                        return sameBodyImage(body, beforeImages.body)
                            && sameJsonImage(mainIndex, beforeImages.mainIndex)
                            && (readerIndex.ownerCommitId === current.commitId || sameJsonImage(readerIndex, beforeImages.readerIndex));
                    },
                    async current => {
                        await this.verifyBodyImageReference(current.binding, beforeImages.body, "cleanup_rebuild_reader_after");
                        const [body, mainIndex, readerIndex] = await Promise.all([
                            this.adapter.io.readBody(current.payload.bodyTarget),
                            this.adapter.io.readMainIndex(current.payload.mainIndexTarget),
                            this.adapter.io.readReaderIndex(current.payload.readerIndexTarget),
                        ]);
                        return sameBodyImage(body, beforeImages.body)
                            && sameJsonImage(mainIndex, beforeImages.mainIndex)
                            && readerIndex.ownerCommitId !== current.commitId;
                    },
                );
                if (stopped) return stopped;
            }
            ledger = await this.read(commitId);
            stopped = await this.cleanupCheckpoint(ledger);
            if (stopped) return stopped;
            const invisible = await this.adapter.io.verifyTaskExclusiveResultsInvisible({
                commitId,
                binding: ledger.binding,
                bodyTarget: ledger.payload.bodyTarget,
                mainIndexTarget: ledger.payload.mainIndexTarget,
                readerIndexTarget: ledger.payload.readerIndexTarget,
            });
            stopped = await this.cleanupCheckpoint(await this.read(commitId));
            if (stopped) return stopped;
            if (!invisible) {
                return { kind: "repair_required", ledger: await this.markRepair(commitId, "cleanup_visibility_not_proven", "Cancelling") };
            }
            stopped = await this.cleanupCheckpoint(await this.read(commitId));
            if (stopped) return stopped;
            ledger = await this.update(commitId, current => {
                if (current.lifecycle === "Cancelled") return current;
                if (current.lifecycle !== "Cancelling") throw new RecordCommitLedgerRepairRequiredError(commitId, "cleanup_lifecycle_changed");
                return this.nextLedger(current, {
                    lifecycle: "Cancelled",
                    repairState: null,
                    intent: null,
                });
            });
            const finalFenceStop = await this.stopForCleanupFence(ledger, await this.guard(ledger.binding, true));
            if (finalFenceStop) return finalFenceStop;
            return { kind: "cancelled", ledger };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { kind: "repair_required", ledger: await this.markRepair(commitId, `cleanup_failed:${detail}`, "Cancelling") };
        }
    }

    private async runCleanupEffect(
        commitId: string,
        effectName: string,
        effect: (ledger: RecordCommitLedger) => Promise<RecordCommitConditionalMutationResult>,
        verifyBefore: (ledger: RecordCommitLedger) => Promise<boolean>,
        verifyAfter: (ledger: RecordCommitLedger) => Promise<boolean>,
    ): Promise<RecordCommitAdvanceResult | null> {
        let ledger = await this.read(commitId);
        const beforeStop = await this.cleanupCheckpoint(ledger);
        if (beforeStop) return beforeStop;
        if (!await verifyBefore(ledger)) {
            return {
                kind: "repair_required",
                ledger: await this.markRepair(commitId, `${effectName}_precondition_ownership_mismatch`, "Cancelling"),
            };
        }
        const outcome = await effect(ledger);
        ledger = await this.read(commitId);
        const afterStop = await this.cleanupCheckpoint(ledger);
        if (afterStop) return afterStop;
        if (outcome.kind === "ownership_changed") {
            return {
                kind: "repair_required",
                ledger: await this.markRepair(commitId, `${effectName}_ownership_changed:${outcome.reason}`, "Cancelling"),
            };
        }
        if (!await verifyAfter(ledger)) {
            return {
                kind: "repair_required",
                ledger: await this.markRepair(commitId, `${effectName}_postcondition_ownership_mismatch`, "Cancelling"),
            };
        }
        return null;
    }

    private async cleanupCheckpoint(ledger: RecordCommitLedger): Promise<RecordCommitAdvanceResult | null> {
        await this.adapter.hooks?.onCleanupCheckpoint?.({ commitId: ledger.commitId, point: "before_guard" });
        await this.validateAdapterTargets(ledger.binding, ledger.payload);
        const fenceStop = await this.stopForCleanupFence(ledger, await this.guard(ledger.binding, true));
        if (fenceStop) return fenceStop;
        const shared = await this.adapter.registry.readSharedWork(ledger.binding);
        if (shared.activeTaskIds.length > 0) {
            return {
                kind: "detached",
                ledger: await this.markDetached(ledger.commitId, `cleanup stopped because shared work has active tasks: ${shared.activeTaskIds.join(",")}`),
            };
        }
        await this.adapter.hooks?.onCleanupCheckpoint?.({ commitId: ledger.commitId, point: "before_effect" });
        return null;
    }

    private async publishIntent(commitId: string, ledger: RecordCommitLedger): Promise<RecordCommitAdvanceResult> {
        try {
            await this.verifyPayloadBodyReference(ledger, "publish_intent_before_capture");
            const existing = ledger.intent;
            let beforeImages = existing?.targetStage === "PublishIntent" ? existing.beforeImages : undefined;
            if (!beforeImages) beforeImages = await this.captureBeforeImages(ledger);
            else await this.verifyBodyImageReference(ledger.binding, beforeImages.body, "publish_intent_existing_before_image");
            const beforeIntentGuard = await this.guard(ledger.binding);
            const stoppedBeforeIntent = await this.stopForGuard(ledger, beforeIntentGuard);
            if (stoppedBeforeIntent) return stoppedBeforeIntent;
            const intentLedger = await this.ensureIntent(commitId, "PublishIntent", beforeImages);
            const guard = await this.guard(intentLedger.binding);
            const stopped = await this.stopForGuard(intentLedger, guard);
            if (stopped) return stopped;
            await this.fault(intentLedger.commitId, "PublishIntent", "before_write");
            await this.fault(intentLedger.commitId, "PublishIntent", "after_write");
            await this.verifyPayloadBodyReference(intentLedger, "publish_intent_after_write");
            const afterIntentGuard = await this.guard(intentLedger.binding);
            const stoppedAfterIntent = await this.stopForGuard(intentLedger, afterIntentGuard);
            if (stoppedAfterIntent) return stoppedAfterIntent;
            const confirmed = await this.confirmStage(commitId, "PublishIntent");
            return { kind: "advanced", ledger: confirmed };
        } catch (error) {
            if (error instanceof RecordCommitVerificationError) {
                return { kind: "repair_required", ledger: await this.markRepair(commitId, error.reason) };
            }
            throw error;
        }
    }

    private async performWrite(ledger: RecordCommitLedger, stage: RecordCommitStage): Promise<void> {
        await this.verifyPayloadBodyReference(ledger, `before_${stage}`);
        switch (stage) {
            case "BodyStaged":
                await this.adapter.io.stageBody({
                    commitId: ledger.commitId,
                    binding: clone(ledger.binding),
                    bodyRef: clone(ledger.payload.bodyRef),
                    bodyHash: ledger.payload.bodyHash,
                    byteLength: ledger.payload.byteLength,
                    maxBytes: ledger.payload.byteLength + 1,
                });
                return;
            case "BodyPublished":
                await this.adapter.io.publishBody({
                    commitId: ledger.commitId,
                    binding: clone(ledger.binding),
                    target: clone(ledger.payload.bodyTarget),
                    bodyRef: clone(ledger.payload.bodyRef),
                    bodyHash: ledger.payload.bodyHash,
                    byteLength: ledger.payload.byteLength,
                    maxBytes: ledger.payload.byteLength + 1,
                    coveredRevision: ledger.payload.coveredRevision,
                });
                return;
            case "MainIndexWritten":
                await this.adapter.io.writeMainIndex({
                    commitId: ledger.commitId,
                    binding: clone(ledger.binding),
                    target: clone(ledger.payload.mainIndexTarget),
                    entry: clone(ledger.payload.mainIndexEntry),
                    entryHash: hashJson(this.adapter, ledger.payload.mainIndexEntry as unknown as JsonValue),
                });
                return;
            case "ReaderIndexWritten":
                await this.adapter.io.writeReaderIndex({
                    commitId: ledger.commitId,
                    binding: clone(ledger.binding),
                    target: clone(ledger.payload.readerIndexTarget),
                    index: clone(ledger.payload.readerIndex),
                    indexHash: hashJson(this.adapter, ledger.payload.readerIndex as unknown as JsonValue),
                });
                return;
            case "Verified":
                return;
            case "ResultReady":
            case "PublishIntent":
                throw new Error(`阶段 ${stage} 没有外部写入`);
        }
    }

    private async verifyStageWrite(ledger: RecordCommitLedger, stage: RecordCommitStage): Promise<void> {
        if (stage !== "ResultReady" && stage !== "PublishIntent") {
            await this.verifyPayloadBodyReference(ledger, `after_${stage}`);
        }
        switch (stage) {
            case "BodyStaged": {
                const image = await this.adapter.io.readStagedBody(ledger.commitId);
                if (!this.matchesPayloadBody(image, ledger)) {
                    throw new RecordCommitVerificationError("staged_body_mismatch");
                }
                await this.verifyBodyImageReference(ledger.binding, image, "staged_body_readback");
                return;
            }
            case "BodyPublished": {
                const image = await this.adapter.io.readBody(ledger.payload.bodyTarget);
                if (!sameBodyImage(image, this.expectedPublishedBody(ledger))) {
                    throw new RecordCommitVerificationError("published_body_identity_or_revision_mismatch");
                }
                await this.verifyBodyImageReference(ledger.binding, image, "published_body_readback");
                return;
            }
            case "MainIndexWritten": {
                const image = await this.adapter.io.readMainIndex(ledger.payload.mainIndexTarget);
                if (image.ownerCommitId !== ledger.commitId
                    || image.value === null
                    || image.hash !== hashJson(this.adapter, ledger.payload.mainIndexEntry as unknown as JsonValue)
                    || !sameJson(image.value, ledger.payload.mainIndexEntry as unknown as JsonValue)
                    || image.revision !== ledger.payload.coveredRevision
                    || !isRecord(image.value)
                    || image.value.commitId !== ledger.commitId
                    || image.value.coveredRevision !== ledger.payload.coveredRevision
                    || image.value.conversationId !== ledger.binding.conversationId
                    || image.value.recordId !== ledger.binding.recordId) {
                    throw new RecordCommitVerificationError("main_index_identity_or_revision_mismatch");
                }
                return;
            }
            case "ReaderIndexWritten": {
                const image = await this.adapter.io.readReaderIndex(ledger.payload.readerIndexTarget);
                if (image.ownerCommitId !== ledger.commitId
                    || image.value === null
                    || image.hash !== hashJson(this.adapter, ledger.payload.readerIndex as unknown as JsonValue)
                    || !sameJson(image.value, ledger.payload.readerIndex as unknown as JsonValue)
                    || image.revision !== ledger.payload.coveredRevision
                    || !isRecord(image.value)
                    || image.value.commitId !== ledger.commitId
                    || image.value.bodyHash !== ledger.payload.bodyHash
                    || image.value.coveredRevision !== ledger.payload.coveredRevision
                    || image.value.conversationId !== ledger.binding.conversationId
                    || image.value.recordId !== ledger.binding.recordId) {
                    throw new RecordCommitVerificationError("reader_index_body_hash_identity_or_revision_mismatch");
                }
                return;
            }
            case "Verified":
                await this.verifyAllArtifacts(ledger);
                return;
            case "ResultReady":
            case "PublishIntent":
                throw new Error(`阶段 ${stage} 不可回读确认`);
        }
    }

    private async verifyAllArtifacts(ledger: RecordCommitLedger): Promise<void> {
        await this.verifyStageWrite(ledger, "BodyPublished");
        await this.verifyStageWrite(ledger, "MainIndexWritten");
        await this.verifyStageWrite(ledger, "ReaderIndexWritten");
    }

    private expectedPublishedBody(ledger: RecordCommitLedger): RecordCommitBodyImage {
        return {
            bodyRef: clone(ledger.payload.bodyRef),
            bodyHash: ledger.payload.bodyHash,
            byteLength: ledger.payload.byteLength,
            ownerCommitId: ledger.commitId,
            revision: ledger.payload.coveredRevision,
        };
    }

    private matchesPayloadBody(image: RecordCommitBodyImage, ledger: RecordCommitLedger): boolean {
        return image.ownerCommitId === ledger.commitId
            && sameBodyRef(image.bodyRef, ledger.payload.bodyRef)
            && image.bodyHash === ledger.payload.bodyHash
            && image.byteLength === ledger.payload.byteLength;
    }

    private async verifyPayloadBodyReference(ledger: RecordCommitLedger, label: string): Promise<void> {
        await this.verifyBodyReference(
            ledger.binding,
            ledger.payload.bodyRef,
            ledger.payload.bodyHash,
            ledger.payload.byteLength,
            label,
        );
    }

    private async verifyBodyImageReference(binding: RecordCommitBinding, image: RecordCommitBodyImage, label: string): Promise<void> {
        try {
            assertBodyImage(binding, image);
        } catch {
            throw new RecordCommitVerificationError(`${label}_metadata_invalid`);
        }
        if (image.bodyRef === null) return;
        await this.verifyBodyReference(binding, image.bodyRef, image.bodyHash!, image.byteLength!, label);
    }

    private async verifyBodyReference(
        binding: RecordCommitBinding,
        bodyRef: RecordCommitBodyRef,
        bodyHash: string,
        byteLength: number,
        label: string,
    ): Promise<void> {
        try {
            assertBodyRef(binding, bodyRef);
        } catch {
            throw new RecordCommitVerificationError(`${label}_body_ref_invalid`);
        }
        if (!isNonEmptyString(bodyHash)
            || !isNonNegativeInteger(byteLength)
            || byteLength > MAX_RECORD_COMMIT_BODY_BYTES) {
            throw new RecordCommitVerificationError(`${label}_descriptor_invalid`);
        }
        const accepted = await this.adapter.io.validateBodyRef({ binding: clone(binding), bodyRef: clone(bodyRef) });
        if (!accepted) throw new RecordCommitVerificationError(`${label}_body_ref_rejected`);
        const maxBytes = byteLength + 1;
        const read = await this.adapter.io.readBodyRef({ binding: clone(binding), bodyRef: clone(bodyRef), maxBytes });
        if (!isRecord(read) || read.kind === "missing") throw new RecordCommitVerificationError(`${label}_body_ref_missing`);
        if (read.kind !== "found" || typeof read.body !== "string" || typeof read.truncated !== "boolean") {
            throw new RecordCommitVerificationError(`${label}_readback_invalid`);
        }
        const actualByteLength = this.adapter.byteLength(read.body);
        if (!isNonNegativeInteger(actualByteLength) || actualByteLength > maxBytes) {
            throw new RecordCommitVerificationError(`${label}_read_exceeded_bound`);
        }
        if (read.truncated) throw new RecordCommitVerificationError(`${label}_read_truncated`);
        if (actualByteLength !== byteLength) throw new RecordCommitVerificationError(`${label}_byte_length_mismatch`);
        if (hashBody(this.adapter, read.body) !== bodyHash) throw new RecordCommitVerificationError(`${label}_body_hash_mismatch`);
    }

    private async captureBeforeImages(ledger: RecordCommitLedger): Promise<RecordCommitBeforeImages> {
        const [body, mainIndex, readerIndex] = await Promise.all([
            this.adapter.io.captureBodyBeforeImage({
                commitId: ledger.commitId,
                binding: clone(ledger.binding),
                target: clone(ledger.payload.bodyTarget),
                maxBytes: MAX_RECORD_COMMIT_BODY_BYTES + 1,
            }),
            this.adapter.io.readMainIndex(ledger.payload.mainIndexTarget),
            this.adapter.io.readReaderIndex(ledger.payload.readerIndexTarget),
        ]);
        await this.verifyBodyImageReference(ledger.binding, body, "captured_before_body");
        assertJsonImage(this.adapter, mainIndex);
        assertJsonImage(this.adapter, readerIndex);
        return { body: clone(body), mainIndex: clone(mainIndex), readerIndex: clone(readerIndex), capturedAt: this.adapter.now() };
    }

    private async guard(binding: RecordCommitBinding, ignoreTaskCancellation = false): Promise<CommitGuard> {
        const [evidence, cancelled] = await Promise.all([
            this.adapter.registry.validate(clone(binding), ignoreTaskCancellation ? "cleanup" : "commit"),
            this.adapter.isTaskCancelled(binding.taskId),
        ]);
        if (evidence.kind === "repair_required") return { kind: "repair_required", reason: evidence.reason };
        if (evidence.kind === "stale") return { kind: "stale", reason: evidence.reason };
        if (evidence.recordWorkKey !== binding.recordWorkKey
            || evidence.workLeaseId !== binding.workLeaseId
            || evidence.recordCommitEpoch !== binding.recordCommitEpoch
            || evidence.fencingToken !== binding.fencingToken
            || evidence.sourceSnapshotId !== binding.sourceSnapshotId
            || evidence.inputHash !== binding.inputHash) {
            return { kind: "stale", reason: "registry evidence does not match commit binding" };
        }
        if (!ignoreTaskCancellation && cancelled) return { kind: "cancelled" };
        return { kind: "authorized" };
    }

    private async stopForGuard(ledger: RecordCommitLedger, guard: CommitGuard): Promise<RecordCommitAdvanceResult | null> {
        if (guard.kind === "authorized") return null;
        if (guard.kind === "cancelled") return this.cancel(ledger.commitId);
        if (guard.kind === "stale") return { kind: "audited_stale", ledger: await this.audit(ledger.commitId, "stale_fence", guard.reason) };
        return { kind: "repair_required", ledger: await this.markRepair(ledger.commitId, guard.reason) };
    }

    private async stopForCleanupFence(ledger: RecordCommitLedger, guard: CommitGuard): Promise<RecordCommitAdvanceResult | null> {
        if (guard.kind === "authorized") return null;
        if (guard.kind === "stale") {
            return { kind: "audited_stale", ledger: await this.audit(ledger.commitId, "cleanup_skipped_takeover", guard.reason) };
        }
        const reason = guard.kind === "cancelled" ? "cleanup_guard_unexpected_cancelled" : guard.reason;
        if (ledger.lifecycle === "Cancelled" || ledger.lifecycle === "Detached") {
            return { kind: "repair_required", ledger: await this.audit(ledger.commitId, "repair_required", reason) };
        }
        return { kind: "repair_required", ledger: await this.markRepair(ledger.commitId, reason, "Cancelling") };
    }

    private async validateAdapterTargets(binding: RecordCommitBinding, payload: RecordCommitPayload): Promise<void> {
        const accepted = await Promise.all([
            this.adapter.io.validateTarget({ binding: clone(binding), target: clone(payload.bodyTarget), expectedKind: "record_body" }),
            this.adapter.io.validateTarget({ binding: clone(binding), target: clone(payload.mainIndexTarget), expectedKind: "main_index" }),
            this.adapter.io.validateTarget({ binding: clone(binding), target: clone(payload.readerIndexTarget), expectedKind: "reader_index" }),
            this.adapter.io.validateBodyRef({ binding: clone(binding), bodyRef: clone(payload.bodyRef) }),
        ]);
        if (accepted.some(value => !value)) throw new TypeError("adapter 拒绝 commit target/bodyRef identity/path");
    }

    private async ensureIntent(commitId: string, targetStage: RecordCommitStage, beforeImages?: RecordCommitBeforeImages): Promise<RecordCommitLedger> {
        const intentKind = intentKindForStage(targetStage);
        return this.update(commitId, current => {
            if (current.stage === targetStage && current.intent === null) return current;
            if (NEXT_STAGE[current.stage] !== targetStage) {
                if (current.intent?.targetStage === targetStage && current.intent.kind === intentKind) return current;
                throw new RecordCommitLedgerRepairRequiredError(commitId, `intent transition ${current.stage} -> ${targetStage} 无效`);
            }
            if (current.intent) {
                if (current.intent.targetStage !== targetStage || current.intent.kind !== intentKind) {
                    throw new RecordCommitLedgerRepairRequiredError(commitId, "存在不同的未完成 intent");
                }
                return current;
            }
            const intent = sealIntent(this.adapter, {
                kind: intentKind,
                targetStage,
                createdAt: this.adapter.now(),
                ...(beforeImages ? { beforeImages: clone(beforeImages) } : {}),
            });
            return this.nextLedger(current, { intent });
        }, {
            stage: targetStage,
            before: "before_intent_persist",
            after: "after_intent_persist",
        });
    }

    private async ensureCleanupIntent(commitId: string): Promise<RecordCommitLedger> {
        return this.update(commitId, current => {
            if (current.lifecycle === "Cancelled" || current.lifecycle === "Detached") return current;
            if (current.intent?.kind === "cleanup") return current;
            const intent = sealIntent(this.adapter, {
                kind: "cleanup",
                targetStage: null,
                createdAt: this.adapter.now(),
            });
            return this.nextLedger(current, { lifecycle: "Cancelling", intent });
        });
    }

    private async confirmStage(commitId: string, stage: RecordCommitStage): Promise<RecordCommitLedger> {
        return this.update(commitId, current => {
            if (current.stage === stage && current.intent === null) return current;
            if (NEXT_STAGE[current.stage] !== stage || current.intent?.targetStage !== stage || current.intent.kind !== intentKindForStage(stage)) {
                throw new RecordCommitLedgerRepairRequiredError(commitId, `confirm ${stage} 不匹配现有 intent`);
            }
            const beforeImages = current.intent.beforeImages || current.beforeImages;
            if (stage === "PublishIntent" && !beforeImages) throw new RecordCommitLedgerRepairRequiredError(commitId, "PublishIntent 缺少 before-images");
            return this.nextLedger(current, {
                stage,
                confirmedStages: [...current.confirmedStages, stage],
                ...(beforeImages ? { beforeImages } : {}),
                intent: null,
            });
        }, {
            stage,
            before: "before_stage_confirm",
            after: "after_stage_confirm",
        });
    }

    private async audit(commitId: string, kind: RecordCommitAuditEntry["kind"], detail: string): Promise<RecordCommitLedger> {
        return this.update(commitId, current => this.nextLedger(current, {
            audit: [...current.audit, { at: this.adapter.now(), kind, detail }],
        }));
    }

    private async markDetached(commitId: string, detail: string): Promise<RecordCommitLedger> {
        return this.update(commitId, current => {
            if (current.lifecycle === "Detached") return current;
            return this.nextLedger(current, {
                lifecycle: "Detached",
                repairState: null,
                intent: null,
                audit: [...current.audit, { at: this.adapter.now(), kind: "cancel_detached", detail }],
            });
        });
    }

    private async markRepair(commitId: string, reason: string, lifecycle?: RecordCommitLifecycle): Promise<RecordCommitLedger> {
        return this.update(commitId, current => this.nextLedger(current, {
            lifecycle: lifecycle || current.lifecycle,
            repairState: reason,
            audit: [...current.audit, { at: this.adapter.now(), kind: "repair_required", detail: reason }],
        }));
    }

    private async update(
        commitId: string,
        mutate: (current: RecordCommitLedger) => RecordCommitLedger,
        persistenceFault?: {
            stage: RecordCommitStage;
            before: Extract<RecordCommitPersistenceFaultPoint, `before_${string}`>;
            after: Extract<RecordCommitPersistenceFaultPoint, `after_${string}`>;
        },
    ): Promise<RecordCommitLedger> {
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const current = await this.read(commitId);
            const candidate = mutate(clone(current));
            if (candidate === current || sameJson(candidate as unknown as JsonValue, current as unknown as JsonValue)) return current;
            const next = sealLedger(this.adapter, { ...candidate, revision: current.revision + 1, updatedAt: this.adapter.now() });
            if (persistenceFault) await this.persistenceFault(next, persistenceFault.stage, persistenceFault.before, current.revision);
            const written = await this.adapter.durable.compareAndSwapLedger(commitId, current.revision, next);
            if (written.kind === "written") {
                if (persistenceFault) await this.persistenceFault(next, persistenceFault.stage, persistenceFault.after, current.revision);
                return next;
            }
        }
        throw new Error(`commit ledger ${commitId} 更新 CAS 重试耗尽`);
    }

    private nextLedger(current: RecordCommitLedger, patch: Partial<Omit<RecordCommitLedger, "schemaVersion" | "kind" | "commitId" | "revision" | "binding" | "payload" | "payloadHash" | "createdAt" | "updatedAt" | "integrityHash">>): RecordCommitLedger {
        return { ...current, ...patch };
    }

    private async fault(commitId: string, stage: RecordCommitStage, point: RecordCommitFaultPoint): Promise<void> {
        await this.adapter.hooks?.onFaultPoint?.({ commitId, stage, point });
    }

    private async persistenceFault(
        ledger: RecordCommitLedger,
        stage: RecordCommitStage,
        point: RecordCommitPersistenceFaultPoint,
        expectedRevision: number,
    ): Promise<void> {
        await this.adapter.hooks?.onPersistenceFaultPoint?.({
            commitId: ledger.commitId,
            stage,
            point,
            binding: clone(ledger.binding),
            expectedRevision,
            nextRevision: ledger.revision,
        });
    }
}
