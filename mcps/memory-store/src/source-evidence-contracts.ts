import { createHash } from "node:crypto";

export const SOURCE_EVIDENCE_SCHEMA_VERSION = "source-evidence/v1" as const;
export const SOURCE_EVIDENCE_ADAPTER_VERSION = "source-evidence/v1" as const;

export const SOURCE_EVIDENCE_HOSTS = ["codex", "claude-code", "windsurf", "antigravity"] as const;
export type SourceEvidenceHost = typeof SOURCE_EVIDENCE_HOSTS[number];

export const EXACT_FETCH_RESULTS = ["present", "not_found", "unresolved"] as const;
export type ExactFetchResult = typeof EXACT_FETCH_RESULTS[number];

export const SOURCE_IDENTITY_KINDS = ["filesystem", "database", "endpoint", "hybrid"] as const;
export type SourceIdentityKind = typeof SOURCE_IDENTITY_KINDS[number];

export const SOURCE_EVIDENCE_ISSUE_CODES = [
    "timeout",
    "limit_reached",
    "pagination_incomplete",
    "parse_error",
    "cache_only",
    "permission_denied",
    "source_unavailable",
    "exact_fetch_failed",
    "revision_drift",
] as const;
export type SourceEvidenceIssueCode = typeof SOURCE_EVIDENCE_ISSUE_CODES[number];

export const ENUMERATION_TARGET_STATUSES = ["present", "absent", "unknown"] as const;
export type EnumerationTargetStatus = typeof ENUMERATION_TARGET_STATUSES[number];

export class SourceEvidenceContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SourceEvidenceContractError";
    }
}

export interface SourceEvidenceIssue {
    code: SourceEvidenceIssueCode;
    message: string;
}

export interface SourceWorkspaceIdentity {
    workspaceId: string;
    canonicalPath: string | null;
}

export interface SourceIdentity {
    kind: SourceIdentityKind;
    authority: string;
    authoritativeRoot: string;
    canonicalPath: string | null;
}

export interface SourceConversationIdentity {
    workspace: SourceWorkspaceIdentity;
    source: SourceIdentity;
    conversationId: string;
}

export interface SourceRevision {
    revision: string;
    contentCursor: string | null;
    eventWatermark: string | null;
    sequence?: number | null;
}

export interface CanonicalSourceRevision {
    revision: string;
    contentCursor: string | null;
    eventWatermark: string | null;
    sequence: number | null;
}

export interface PaginationEvidence {
    cursor: string | null;
    pages: number;
    limit: number | null;
    truncated: boolean;
}

export interface LogicalObservation {
    scanId: string;
    sequence: number;
    startedAt: string;
    completedAt: string;
}

export type SourceEvidenceKind = "source_enumeration" | "exact_fetch" | "full_source_read" | "lost_observation";

export interface SourceEvidenceBase {
    schemaVersion: typeof SOURCE_EVIDENCE_SCHEMA_VERSION;
    kind: SourceEvidenceKind;
    adapterVersion: typeof SOURCE_EVIDENCE_ADAPTER_VERSION;
    host: SourceEvidenceHost;
    identity: SourceConversationIdentity;
    sourceRevision: CanonicalSourceRevision;
    pagination: PaginationEvidence;
    enumerationComplete: boolean;
    cacheBypassed: boolean;
    exactFetchResult: ExactFetchResult;
    errors: SourceEvidenceIssue[];
    warnings: SourceEvidenceIssue[];
    observedAt: LogicalObservation;
    evidenceHash: string;
}

export interface SourceEnumerationEvidence extends SourceEvidenceBase {
    kind: "source_enumeration";
    targetStatus: EnumerationTargetStatus;
}

export interface ExactFetchEvidence extends SourceEvidenceBase {
    kind: "exact_fetch";
}

export interface FullSourceContent {
    mode: "full";
    byteLength: number;
    contentHash: string;
    roundRange: {
        start: number;
        end: number;
    };
    truncated: boolean;
    staleCache: boolean;
}

export interface FullSourceReadEvidence extends SourceEvidenceBase {
    kind: "full_source_read";
    content: FullSourceContent;
}

export interface LostObservation extends SourceEvidenceBase {
    kind: "lost_observation";
    targetStatus: "absent";
    enumerationEvidenceHash: string;
    exactFetchEvidenceHash: string;
}

export type SourceEvidence = SourceEnumerationEvidence | ExactFetchEvidence | FullSourceReadEvidence | LostObservation;

export type SourceEnumerationEvidenceInput = Omit<SourceEnumerationEvidence, "schemaVersion" | "kind" | "evidenceHash" | "sourceRevision"> & {
    sourceRevision: SourceRevision;
};
export type ExactFetchEvidenceInput = Omit<ExactFetchEvidence, "schemaVersion" | "kind" | "evidenceHash" | "sourceRevision"> & {
    sourceRevision: SourceRevision;
};
export type FullSourceReadEvidenceInput = Omit<FullSourceReadEvidence, "schemaVersion" | "kind" | "evidenceHash" | "sourceRevision"> & {
    sourceRevision: SourceRevision;
};

export interface LostObservationInput {
    enumeration: SourceEnumerationEvidence;
    exactFetch: ExactFetchEvidence;
}

export interface RecordSourceSnapshot {
    schemaVersion: typeof SOURCE_EVIDENCE_SCHEMA_VERSION;
    kind: "record_source_snapshot";
    snapshotId: string;
    fullSourceRead: FullSourceReadEvidence;
    snapshotHash: string;
}

export interface RecordSourceSnapshotInput {
    snapshotId: string;
    fullSourceRead: FullSourceReadEvidence;
}

export type SourceEvidenceState = "Present" | "Lost" | "Unresolved";
export type SourceEvidenceClassificationReason =
    | "exact-fetch-present"
    | "qualified-absence"
    | "exact-fetch-unresolved"
    | "identity-mismatch"
    | "revision-drift"
    | "scan-mismatch"
    | "enumeration-exact-contradiction"
    | "adapter-error"
    | "enumeration-incomplete"
    | "pagination-limit"
    | "pagination-incomplete"
    | "cache-not-bypassed"
    | "loss-gate-failed";

export interface SourceEvidenceClassification {
    state: SourceEvidenceState;
    reason: SourceEvidenceClassificationReason;
    lostObservation?: LostObservation;
}

export interface SourceEvidenceClassificationInput {
    enumeration: SourceEnumerationEvidence;
    exactFetch: ExactFetchEvidence;
}

export interface SourceIdentityKeyInput {
    host: SourceEvidenceHost;
    identity: SourceConversationIdentity;
}

const BASE_EVIDENCE_KEYS = [
    "schemaVersion",
    "kind",
    "adapterVersion",
    "host",
    "identity",
    "sourceRevision",
    "pagination",
    "enumerationComplete",
    "cacheBypassed",
    "exactFetchResult",
    "errors",
    "warnings",
    "observedAt",
] as const;

interface SourceEvidenceBasePayload extends Omit<SourceEvidenceBase, "evidenceHash"> {
    kind: SourceEvidenceKind;
}

interface ParsedBaseEvidence {
    payload: SourceEvidenceBasePayload;
    declaredHash: string | undefined;
    fields: Record<string, unknown>;
}

export function buildSourceEnumerationEvidence(input: SourceEnumerationEvidenceInput): SourceEnumerationEvidence {
    return parseSourceEnumerationEvidence(prepareBuilderInput(input, "source_enumeration", ["targetStatus"]), false);
}

export function validateSourceEnumerationEvidence(value: unknown): SourceEnumerationEvidence {
    return parseSourceEnumerationEvidence(value, true);
}

export function buildExactFetchEvidence(input: ExactFetchEvidenceInput): ExactFetchEvidence {
    return parseExactFetchEvidence(prepareBuilderInput(input, "exact_fetch", []), false);
}

export function validateExactFetchEvidence(value: unknown): ExactFetchEvidence {
    return parseExactFetchEvidence(value, true);
}

export function buildFullSourceReadEvidence(input: FullSourceReadEvidenceInput): FullSourceReadEvidence {
    return parseFullSourceReadEvidence(prepareBuilderInput(input, "full_source_read", ["content"]), false);
}

export function validateFullSourceReadEvidence(value: unknown): FullSourceReadEvidence {
    return parseFullSourceReadEvidence(value, true);
}

export function buildLostObservation(input: LostObservationInput): LostObservation {
    const enumeration = validateSourceEnumerationEvidence(input.enumeration);
    const exactFetch = validateExactFetchEvidence(input.exactFetch);
    const failure = lossEligibilityFailure(enumeration, exactFetch);
    if (failure) throw new SourceEvidenceContractError(`不足以构造 Lost observation: ${failure}`);

    return finalizeEvidence({
        schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
        kind: "lost_observation",
        adapterVersion: enumeration.adapterVersion,
        host: enumeration.host,
        identity: enumeration.identity,
        sourceRevision: enumeration.sourceRevision,
        pagination: enumeration.pagination,
        enumerationComplete: enumeration.enumerationComplete,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: mergeIssues(enumeration.warnings, exactFetch.warnings),
        observedAt: exactFetch.observedAt,
        targetStatus: "absent",
        enumerationEvidenceHash: enumeration.evidenceHash,
        exactFetchEvidenceHash: exactFetch.evidenceHash,
    });
}

export function validateLostObservation(value: unknown): LostObservation {
    const parsed = parseBaseEvidence(value, "lost_observation", ["targetStatus", "enumerationEvidenceHash", "exactFetchEvidenceHash"], true);
    const payload = {
        ...parsed.payload,
        targetStatus: parseKnownString(parsed.fields.targetStatus, ENUMERATION_TARGET_STATUSES, "lost_observation.targetStatus"),
        enumerationEvidenceHash: parseHash(parsed.fields.enumerationEvidenceHash, "lost_observation.enumerationEvidenceHash"),
        exactFetchEvidenceHash: parseHash(parsed.fields.exactFetchEvidenceHash, "lost_observation.exactFetchEvidenceHash"),
    } as Omit<LostObservation, "evidenceHash">;
    if (payload.targetStatus !== "absent") throw new SourceEvidenceContractError("Lost observation 必须记录枚举缺失");
    validateLostPayload(payload);
    return finalizeEvidence(payload, parsed.declaredHash);
}

export function validateSourceEvidence(value: unknown): SourceEvidence {
    const fields = asRecord(value, "source evidence");
    switch (fields.kind) {
        case "source_enumeration":
            return validateSourceEnumerationEvidence(value);
        case "exact_fetch":
            return validateExactFetchEvidence(value);
        case "full_source_read":
            return validateFullSourceReadEvidence(value);
        case "lost_observation":
            return validateLostObservation(value);
        default:
            throw new SourceEvidenceContractError("未知 source evidence kind");
    }
}

export function canonicalSerializeSourceEvidence(value: SourceEvidence): string {
    const evidence = validateSourceEvidence(value);
    const { evidenceHash: ignoredHash, ...payload } = evidence;
    void ignoredHash;
    return canonicalSerialize(payload);
}

export function canonicalSourceEvidenceHash(value: SourceEvidence): string {
    return validateSourceEvidence(value).evidenceHash;
}

export function canonicalSerialize(value: unknown): string {
    return canonicalSerializeValue(value);
}

export function canonicalizeSourceWorkspaceIdentity(input: SourceWorkspaceIdentity): SourceWorkspaceIdentity {
    return parseWorkspaceIdentity(input, "source workspace identity");
}

export function canonicalizeSourceIdentity(input: SourceIdentityKeyInput): SourceIdentityKeyInput {
    const fields = asRecord(input, "source identity");
    assertExactKeys(fields, ["host", "identity"], "source identity");
    return {
        host: parseKnownString(fields.host, SOURCE_EVIDENCE_HOSTS, "source identity.host"),
        identity: parseIdentity(fields.identity, "source identity.identity"),
    };
}

export function canonicalSourceIdentityKey(input: SourceIdentityKeyInput): string {
    const canonical = canonicalizeSourceIdentity(input);
    return `source:${sha256(canonicalSerialize(canonical))}`;
}

export function classifySourceEvidence(input: SourceEvidenceClassificationInput): SourceEvidenceClassification {
    const enumeration = validateSourceEnumerationEvidence(input.enumeration);
    const exactFetch = validateExactFetchEvidence(input.exactFetch);

    if (!sameIdentity(enumeration, exactFetch) || enumeration.host !== exactFetch.host || enumeration.adapterVersion !== exactFetch.adapterVersion) {
        return { state: "Unresolved", reason: "identity-mismatch" };
    }
    if (!sameRevision(enumeration.sourceRevision, exactFetch.sourceRevision)) {
        return { state: "Unresolved", reason: "revision-drift" };
    }
    if (enumeration.observedAt.scanId !== exactFetch.observedAt.scanId) {
        return { state: "Unresolved", reason: "scan-mismatch" };
    }
    if (enumeration.exactFetchResult !== exactFetch.exactFetchResult) {
        return { state: "Unresolved", reason: "enumeration-exact-contradiction" };
    }
    if (enumeration.errors.length > 0 || exactFetch.errors.length > 0) {
        return { state: "Unresolved", reason: "adapter-error" };
    }
    if (exactFetch.exactFetchResult === "unresolved") {
        return { state: "Unresolved", reason: "exact-fetch-unresolved" };
    }
    if (exactFetch.exactFetchResult === "present") {
        if (enumeration.targetStatus === "absent") {
            return { state: "Unresolved", reason: "enumeration-exact-contradiction" };
        }
        return { state: "Present", reason: "exact-fetch-present" };
    }
    if (enumeration.targetStatus !== "absent") {
        return { state: "Unresolved", reason: "enumeration-exact-contradiction" };
    }

    const failure = lossEligibilityFailure(enumeration, exactFetch);
    if (failure) return { state: "Unresolved", reason: failure };
    try {
        return {
            state: "Lost",
            reason: "qualified-absence",
            lostObservation: buildLostObservation({ enumeration, exactFetch }),
        };
    } catch {
        return { state: "Unresolved", reason: "loss-gate-failed" };
    }
}

export function buildRecordSourceSnapshot(input: RecordSourceSnapshotInput): RecordSourceSnapshot {
    const fields = asRecord(input, "record source snapshot input");
    assertExactKeys(fields, ["snapshotId", "fullSourceRead"], "record source snapshot input");
    const fullSourceRead = validateEligibleRecordSourceRead(fields.fullSourceRead);
    return finalizeSnapshot({
        schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
        kind: "record_source_snapshot",
        snapshotId: normalizeText(fields.snapshotId, "record source snapshot input.snapshotId"),
        fullSourceRead,
    });
}

export function validateRecordSourceSnapshot(value: unknown): RecordSourceSnapshot {
    const fields = asRecord(value, "record source snapshot");
    assertExactKeys(fields, ["schemaVersion", "kind", "snapshotId", "fullSourceRead", "snapshotHash"], "record source snapshot");
    if (fields.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION) throw new SourceEvidenceContractError("未知 record source snapshot schemaVersion");
    if (fields.kind !== "record_source_snapshot") throw new SourceEvidenceContractError("未知 record source snapshot kind");
    const payload = {
        schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
        kind: "record_source_snapshot" as const,
        snapshotId: normalizeText(fields.snapshotId, "record source snapshot.snapshotId"),
        fullSourceRead: validateEligibleRecordSourceRead(fields.fullSourceRead),
    };
    return finalizeSnapshot(payload, parseHash(fields.snapshotHash, "record source snapshot.snapshotHash"));
}

function parseSourceEnumerationEvidence(value: unknown, requireHash: boolean): SourceEnumerationEvidence {
    const parsed = parseBaseEvidence(value, "source_enumeration", ["targetStatus"], requireHash);
    return finalizeEvidence({
        ...parsed.payload,
        targetStatus: parseKnownString(parsed.fields.targetStatus, ENUMERATION_TARGET_STATUSES, "source_enumeration.targetStatus"),
    } as Omit<SourceEnumerationEvidence, "evidenceHash">, parsed.declaredHash);
}

function prepareBuilderInput(input: unknown, kind: SourceEvidenceKind, extraKeys: readonly string[]): Record<string, unknown> {
    const fields = asRecord(input, `${kind} builder input`);
    const required = BASE_EVIDENCE_KEYS.filter((key) => key !== "schemaVersion" && key !== "kind");
    assertExactKeys(fields, [...required, ...extraKeys], `${kind} builder input`);
    const sourceRevision = asRecord(fields.sourceRevision, `${kind} builder input.sourceRevision`);
    const canonicalSourceRevision = Object.prototype.hasOwnProperty.call(sourceRevision, "sequence")
        ? sourceRevision
        : { ...sourceRevision, sequence: null };
    return {
        schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
        kind,
        ...fields,
        sourceRevision: canonicalSourceRevision,
    };
}

function parseExactFetchEvidence(value: unknown, requireHash: boolean): ExactFetchEvidence {
    const parsed = parseBaseEvidence(value, "exact_fetch", [], requireHash);
    return finalizeEvidence(parsed.payload as Omit<ExactFetchEvidence, "evidenceHash">, parsed.declaredHash);
}

function parseFullSourceReadEvidence(value: unknown, requireHash: boolean): FullSourceReadEvidence {
    const parsed = parseBaseEvidence(value, "full_source_read", ["content"], requireHash);
    const payload = {
        ...parsed.payload,
        content: parseFullSourceContent(parsed.fields.content, "full_source_read.content"),
    } as Omit<FullSourceReadEvidence, "evidenceHash">;
    if (payload.exactFetchResult !== "present") throw new SourceEvidenceContractError("完整 source read 必须绑定 exact fetch present");
    return finalizeEvidence(payload, parsed.declaredHash);
}

function parseBaseEvidence(value: unknown, expectedKind: SourceEvidenceKind, extraKeys: readonly string[], requireHash: boolean): ParsedBaseEvidence {
    const fields = asRecord(value, expectedKind);
    assertExactKeys(fields, [...BASE_EVIDENCE_KEYS, ...extraKeys, ...(requireHash ? ["evidenceHash"] : [])], expectedKind);
    if (fields.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION) throw new SourceEvidenceContractError(`${expectedKind}.schemaVersion 不受支持`);
    if (fields.kind !== expectedKind) throw new SourceEvidenceContractError(`${expectedKind}.kind 不匹配`);
    if (fields.adapterVersion !== SOURCE_EVIDENCE_ADAPTER_VERSION) throw new SourceEvidenceContractError(`${expectedKind}.adapterVersion 不受支持`);
    return {
        payload: {
            schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
            kind: expectedKind,
            adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: parseKnownString(fields.host, SOURCE_EVIDENCE_HOSTS, `${expectedKind}.host`),
            identity: parseIdentity(fields.identity, `${expectedKind}.identity`),
            sourceRevision: parseSourceRevision(fields.sourceRevision, `${expectedKind}.sourceRevision`),
            pagination: parsePagination(fields.pagination, `${expectedKind}.pagination`),
            enumerationComplete: parseBoolean(fields.enumerationComplete, `${expectedKind}.enumerationComplete`),
            cacheBypassed: parseBoolean(fields.cacheBypassed, `${expectedKind}.cacheBypassed`),
            exactFetchResult: parseKnownString(fields.exactFetchResult, EXACT_FETCH_RESULTS, `${expectedKind}.exactFetchResult`),
            errors: parseIssues(fields.errors, `${expectedKind}.errors`),
            warnings: parseIssues(fields.warnings, `${expectedKind}.warnings`),
            observedAt: parseLogicalObservation(fields.observedAt, `${expectedKind}.observedAt`),
        },
        declaredHash: requireHash ? parseHash(fields.evidenceHash, `${expectedKind}.evidenceHash`) : undefined,
        fields,
    };
}

function parseIdentity(value: unknown, label: string): SourceConversationIdentity {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["workspace", "source", "conversationId"], label);
    const workspace = asRecord(fields.workspace, `${label}.workspace`);
    assertExactKeys(workspace, ["workspaceId", "canonicalPath"], `${label}.workspace`);
    const source = asRecord(fields.source, `${label}.source`);
    assertExactKeys(source, ["kind", "authority", "authoritativeRoot", "canonicalPath"], `${label}.source`);
    return {
        workspace: parseWorkspaceIdentity(workspace, `${label}.workspace`),
        source: {
            kind: parseKnownString(source.kind, SOURCE_IDENTITY_KINDS, `${label}.source.kind`),
            authority: normalizeLocator(source.authority, `${label}.source.authority`),
            authoritativeRoot: normalizeLocator(source.authoritativeRoot, `${label}.source.authoritativeRoot`),
            canonicalPath: parseCanonicalPath(source.canonicalPath, `${label}.source.canonicalPath`),
        },
        conversationId: normalizeText(fields.conversationId, `${label}.conversationId`),
    };
}

function parseWorkspaceIdentity(value: unknown, label: string): SourceWorkspaceIdentity {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["workspaceId", "canonicalPath"], label);
    return {
        workspaceId: normalizeText(fields.workspaceId, `${label}.workspaceId`),
        canonicalPath: parseCanonicalPath(fields.canonicalPath, `${label}.canonicalPath`),
    };
}

function parseSourceRevision(value: unknown, label: string): CanonicalSourceRevision {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["revision", "contentCursor", "eventWatermark", "sequence"], label);
    return {
        revision: normalizeText(fields.revision, `${label}.revision`),
        contentCursor: parseNullableText(fields.contentCursor, `${label}.contentCursor`),
        eventWatermark: parseNullableText(fields.eventWatermark, `${label}.eventWatermark`),
        sequence: fields.sequence === null ? null : parseSafeInteger(fields.sequence, `${label}.sequence`, 0),
    };
}

function parsePagination(value: unknown, label: string): PaginationEvidence {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["cursor", "pages", "limit", "truncated"], label);
    return {
        cursor: parseNullableText(fields.cursor, `${label}.cursor`),
        pages: parseSafeInteger(fields.pages, `${label}.pages`, 0),
        limit: fields.limit === null ? null : parseSafeInteger(fields.limit, `${label}.limit`, 1),
        truncated: parseBoolean(fields.truncated, `${label}.truncated`),
    };
}

function parseLogicalObservation(value: unknown, label: string): LogicalObservation {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["scanId", "sequence", "startedAt", "completedAt"], label);
    const startedAt = parseIsoTimestamp(fields.startedAt, `${label}.startedAt`);
    const completedAt = parseIsoTimestamp(fields.completedAt, `${label}.completedAt`);
    if (Date.parse(completedAt) < Date.parse(startedAt)) throw new SourceEvidenceContractError(`${label}.completedAt 不能早于 startedAt`);
    return {
        scanId: normalizeText(fields.scanId, `${label}.scanId`),
        sequence: parseSafeInteger(fields.sequence, `${label}.sequence`, 1),
        startedAt,
        completedAt,
    };
}

function parseFullSourceContent(value: unknown, label: string): FullSourceContent {
    const fields = asRecord(value, label);
    assertExactKeys(fields, ["mode", "byteLength", "contentHash", "roundRange", "truncated", "staleCache"], label);
    if (fields.mode !== "full") throw new SourceEvidenceContractError(`${label}.mode 必须为 full`);
    const roundRange = asRecord(fields.roundRange, `${label}.roundRange`);
    assertExactKeys(roundRange, ["start", "end"], `${label}.roundRange`);
    const start = parseSafeInteger(roundRange.start, `${label}.roundRange.start`, 1);
    const end = parseSafeInteger(roundRange.end, `${label}.roundRange.end`, 1);
    if (end < start) throw new SourceEvidenceContractError(`${label}.roundRange 结束轮次不能早于起始轮次`);
    const truncated = parseBoolean(fields.truncated, `${label}.truncated`);
    const staleCache = parseBoolean(fields.staleCache, `${label}.staleCache`);
    if (truncated) throw new SourceEvidenceContractError(`${label} 不能是截断读取`);
    if (staleCache) throw new SourceEvidenceContractError(`${label} 不能来自 stale cache`);
    return {
        mode: "full",
        byteLength: parseSafeInteger(fields.byteLength, `${label}.byteLength`, 0),
        contentHash: parseHash(fields.contentHash, `${label}.contentHash`),
        roundRange: { start, end },
        truncated,
        staleCache,
    };
}

function parseIssues(value: unknown, label: string): SourceEvidenceIssue[] {
    if (!Array.isArray(value)) throw new SourceEvidenceContractError(`${label} 必须是数组`);
    return value.map((issue, index) => {
        const fields = asRecord(issue, `${label}[${index}]`);
        assertExactKeys(fields, ["code", "message"], `${label}[${index}]`);
        return {
            code: parseKnownString(fields.code, SOURCE_EVIDENCE_ISSUE_CODES, `${label}[${index}].code`),
            message: normalizeText(fields.message, `${label}[${index}].message`),
        };
    }).sort(compareIssues);
}

function mergeIssues(...groups: readonly SourceEvidenceIssue[][]): SourceEvidenceIssue[] {
    const byKey = new Map<string, SourceEvidenceIssue>();
    for (const group of groups) {
        for (const issue of group) byKey.set(`${issue.code}\u0000${issue.message}`, issue);
    }
    return [...byKey.values()].sort(compareIssues);
}

function compareIssues(left: SourceEvidenceIssue, right: SourceEvidenceIssue): number {
    return left.code === right.code ? left.message.localeCompare(right.message, "en") : left.code.localeCompare(right.code, "en");
}

function finalizeEvidence<T extends object>(payload: T, declaredHash?: string): T & { evidenceHash: string } {
    const evidenceHash = hashPayload(payload);
    if (declaredHash !== undefined && declaredHash !== evidenceHash) throw new SourceEvidenceContractError("evidenceHash 与规范化内容不一致");
    return { ...payload, evidenceHash };
}

function finalizeSnapshot(payload: Omit<RecordSourceSnapshot, "snapshotHash">, declaredHash?: string): RecordSourceSnapshot {
    const snapshotHash = hashPayload(payload);
    if (declaredHash !== undefined && declaredHash !== snapshotHash) throw new SourceEvidenceContractError("snapshotHash 与规范化内容不一致");
    return { ...payload, snapshotHash };
}

function hashPayload(payload: object): string {
    return `sha256:${sha256(canonicalSerialize(payload))}`;
}

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateLostPayload(payload: Omit<LostObservation, "evidenceHash">): void {
    if (payload.exactFetchResult !== "not_found") throw new SourceEvidenceContractError("Lost observation 必须绑定 exact not_found");
    if (payload.targetStatus !== "absent") throw new SourceEvidenceContractError("Lost observation 必须绑定完整枚举缺失");
    if (payload.errors.length > 0) throw new SourceEvidenceContractError("Lost observation 不能含 errors");
    if (!payload.enumerationComplete) throw new SourceEvidenceContractError("Lost observation 必须来自完整枚举");
    if (!payload.cacheBypassed) throw new SourceEvidenceContractError("Lost observation 必须绕过缓存");
    const paginationReason = paginationFailure(payload.pagination);
    if (paginationReason) throw new SourceEvidenceContractError(`Lost observation 分页不完整: ${paginationReason}`);
    if (!payload.sourceRevision.revision) throw new SourceEvidenceContractError("Lost observation 缺少可审计 source revision");
}

function validateEligibleRecordSourceRead(value: unknown): FullSourceReadEvidence {
    const read = validateFullSourceReadEvidence(value);
    if (read.exactFetchResult !== "present") throw new SourceEvidenceContractError("RecordSourceSnapshot 必须来自 exact present 的完整读取");
    if (read.errors.length > 0) throw new SourceEvidenceContractError("RecordSourceSnapshot 不能绑定有错误的读取");
    if (!read.enumerationComplete) throw new SourceEvidenceContractError("RecordSourceSnapshot 必须来自完整枚举");
    if (!read.cacheBypassed) throw new SourceEvidenceContractError("RecordSourceSnapshot 必须绕过缓存");
    const paginationReason = paginationFailure(read.pagination);
    if (paginationReason) throw new SourceEvidenceContractError(`RecordSourceSnapshot 分页不完整: ${paginationReason}`);
    if (read.content.mode !== "full" || read.content.truncated || read.content.staleCache) {
        throw new SourceEvidenceContractError("RecordSourceSnapshot 只能绑定非摘要、非截断、非 stale cache 的完整读取");
    }
    return read;
}

function lossEligibilityFailure(enumeration: SourceEnumerationEvidence, exactFetch: ExactFetchEvidence): SourceEvidenceClassificationReason | null {
    if (!sameIdentity(enumeration, exactFetch) || enumeration.host !== exactFetch.host || enumeration.adapterVersion !== exactFetch.adapterVersion) return "identity-mismatch";
    if (!sameRevision(enumeration.sourceRevision, exactFetch.sourceRevision)) return "revision-drift";
    if (enumeration.observedAt.scanId !== exactFetch.observedAt.scanId) return "scan-mismatch";
    if (enumeration.exactFetchResult !== "not_found" || exactFetch.exactFetchResult !== "not_found" || enumeration.targetStatus !== "absent") {
        return "enumeration-exact-contradiction";
    }
    if (enumeration.errors.length > 0 || exactFetch.errors.length > 0) return "adapter-error";
    if (!enumeration.enumerationComplete || !exactFetch.enumerationComplete) return "enumeration-incomplete";
    if (!enumeration.cacheBypassed || !exactFetch.cacheBypassed) return "cache-not-bypassed";
    const enumerationPaginationFailure = paginationFailure(enumeration.pagination);
    if (enumerationPaginationFailure) return enumerationPaginationFailure;
    const exactPaginationFailure = paginationFailure(exactFetch.pagination);
    if (exactPaginationFailure) return exactPaginationFailure;
    return null;
}

function paginationFailure(pagination: PaginationEvidence): "pagination-limit" | "pagination-incomplete" | null {
    if (pagination.limit !== null) return "pagination-limit";
    if (pagination.truncated || pagination.cursor !== null) return "pagination-incomplete";
    return null;
}

function sameIdentity(left: Pick<SourceEvidenceBase, "identity">, right: Pick<SourceEvidenceBase, "identity">): boolean {
    return canonicalSerialize(left.identity) === canonicalSerialize(right.identity);
}

function sameRevision(left: CanonicalSourceRevision, right: CanonicalSourceRevision): boolean {
    return canonicalSerialize(left) === canonicalSerialize(right);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceEvidenceContractError(`${label} 必须是对象`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new SourceEvidenceContractError(`${label} 必须是普通对象`);
    return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const allowed = [...expected].sort();
    if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
        throw new SourceEvidenceContractError(`${label} 含有未知字段或缺少必填字段`);
    }
}

function parseKnownString<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    const normalized = normalizeText(value, label);
    if (!allowed.includes(normalized as T)) throw new SourceEvidenceContractError(`${label} 不受支持`);
    return normalized as T;
}

function parseBoolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new SourceEvidenceContractError(`${label} 必须是布尔值`);
    return value;
}

function parseSafeInteger(value: unknown, label: string, minimum: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
        throw new SourceEvidenceContractError(`${label} 必须是大于等于 ${minimum} 的有限安全整数`);
    }
    return value;
}

function parseHash(value: unknown, label: string): string {
    const hash = normalizeText(value, label);
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new SourceEvidenceContractError(`${label} 必须是小写 sha256 hash`);
    return hash;
}

function parseNullableText(value: unknown, label: string): string | null {
    return value === null ? null : normalizeText(value, label);
}

function parseCanonicalPath(value: unknown, label: string): string | null {
    return value === null ? null : normalizeCanonicalPath(value, label);
}

function normalizeText(value: unknown, label: string): string {
    if (typeof value !== "string") throw new SourceEvidenceContractError(`${label} 必须是非空字符串`);
    const normalized = value.normalize("NFC");
    if (!normalized || normalized.trim() !== normalized || /[\u0000-\u001F\u007F]/.test(normalized)) {
        throw new SourceEvidenceContractError(`${label} 不是可规范化的标识文本`);
    }
    return normalized;
}

function normalizeLocator(value: unknown, label: string): string {
    const normalized = normalizeText(value, label);
    if (/(^|[\\/])\.\.?(?:[\\/]|$)/.test(normalized)) throw new SourceEvidenceContractError(`${label} 不允许路径穿越`);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
        const endpoint = new URL(normalized);
        if (endpoint.username || endpoint.password) throw new SourceEvidenceContractError(`${label} 不能含认证信息`);
        return endpoint.toString().normalize("NFC");
    }
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(normalized)) return normalizeCanonicalPath(normalized, label);
    return normalized;
}

function normalizeCanonicalPath(value: unknown, label: string): string {
    const normalized = normalizeText(value, label).replace(/\\/g, "/");
    let prefix: string;
    let remainder: string;
    if (/^[A-Za-z]:\//.test(normalized)) {
        prefix = `${normalized[0].toLowerCase()}:/`;
        remainder = normalized.slice(3);
    } else if (normalized.startsWith("//")) {
        prefix = "//";
        remainder = normalized.slice(2);
    } else if (normalized.startsWith("/")) {
        prefix = "/";
        remainder = normalized.slice(1);
    } else {
        throw new SourceEvidenceContractError(`${label} 必须是绝对路径`);
    }
    const segments = remainder.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) throw new SourceEvidenceContractError(`${label} 不允许路径穿越`);
    return `${prefix}${segments.join("/")}`;
}

function parseIsoTimestamp(value: unknown, label: string): string {
    const timestamp = normalizeText(value, label);
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
        throw new SourceEvidenceContractError(`${label} 必须是 UTC ISO-8601 毫秒时间戳`);
    }
    return timestamp;
}

function canonicalSerializeValue(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new SourceEvidenceContractError("canonical serialization 不接受非有限数字");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((item) => canonicalSerializeValue(item)).join(",")}]`;
    if (!value || typeof value !== "object") throw new SourceEvidenceContractError("canonical serialization 不接受该值类型");
    const fields = asRecord(value, "canonical serialization object");
    return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalSerializeValue(fields[key])}`).join(",")}}`;
}
