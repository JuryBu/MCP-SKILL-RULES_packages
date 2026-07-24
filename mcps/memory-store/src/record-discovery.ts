import { createHash } from "node:crypto";
import { z } from "zod";
import {
    SOURCE_EVIDENCE_HOSTS,
    buildRecordSourceSnapshot as buildContractRecordSourceSnapshot,
    canonicalSerialize,
    canonicalSourceIdentityKey,
    canonicalizeSourceIdentity as canonicalizeContractSourceIdentity,
    canonicalizeSourceWorkspaceIdentity,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type LostObservation,
    type RecordSourceSnapshot as ContractRecordSourceSnapshot,
    type SourceConversationIdentity,
    type SourceEnumerationEvidence,
    type SourceEvidenceHost,
    validateFullSourceReadEvidence,
    validateExactFetchEvidence,
    validateLostObservation,
    validateRecordSourceSnapshot as validateContractRecordSourceSnapshot,
    validateSourceEnumerationEvidence,
} from "./source-evidence-contracts.js";

const RECORD_DISCOVERY_SCHEMA_VERSION = 2;
export const LOST_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeSequenceSchema = z.number().int().safe().nonnegative();
const IdentifierSchema = z.string().min(1).transform(value => value.normalize("NFC")).refine(value => (
    value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value)
));

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
]));

const JsonRecordSchema = z.record(JsonValueSchema);

function contractSchema<Value>(validator: (value: unknown) => Value): z.ZodType<Value, z.ZodTypeDef, unknown> {
    return z.unknown().transform((value, context) => {
        try {
            return validator(value);
        } catch (error) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: error instanceof Error ? error.message : String(error),
            });
            return z.NEVER;
        }
    });
}

const ContractSourceEnumerationSchema = contractSchema<SourceEnumerationEvidence>(validateSourceEnumerationEvidence);
const ContractExactFetchSchema = contractSchema<ExactFetchEvidence>(validateExactFetchEvidence);
const ContractLostObservationSchema = contractSchema<LostObservation>(validateLostObservation);
const ContractFullSourceReadSchema = contractSchema<FullSourceReadEvidence>(validateFullSourceReadEvidence);
const ContractRecordSourceSnapshotSchema = contractSchema<ContractRecordSourceSnapshot>(validateContractRecordSourceSnapshot);

export interface RecordSourceIdentity {
    host: SourceEvidenceHost;
    identity: SourceConversationIdentity;
}

const RawRecordSourceIdentitySchema = z.object({
    host: z.enum(SOURCE_EVIDENCE_HOSTS),
    identity: z.unknown(),
}).strict();

export const RecordSourceIdentitySchema = RawRecordSourceIdentitySchema.transform((value, context): RecordSourceIdentity => {
    try {
        return canonicalizeContractSourceIdentity(value as RecordSourceIdentity);
    } catch (error) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
    }
});

const WorkspaceIdentitySchema = z.object({
    workspaceId: IdentifierSchema,
    canonicalPath: z.string().min(1).nullable(),
}).strict().transform((workspace, context) => {
    try {
        return canonicalizeSourceWorkspaceIdentity(workspace);
    } catch (error) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
    }
});

export const SourceEnumerationEnvelopeSchema = z.object({
    evidence: ContractSourceEnumerationSchema,
    exactFetch: ContractExactFetchSchema.optional(),
    revisionSequence: SafeSequenceSchema.nullable(),
    title: z.string().min(1).nullable().default(null),
}).strict().superRefine((envelope, context) => {
    if (!envelope.evidence?.sourceRevision) return;
    if (envelope.revisionSequence !== envelope.evidence.sourceRevision.sequence) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["revisionSequence"],
            message: "revisionSequence must equal the authoritative sourceRevision.sequence",
        });
    }
});

export type SourceEnumerationEnvelope = z.infer<typeof SourceEnumerationEnvelopeSchema>;

export const SourceAbsenceObservationSchema = z.object({
    confirmation: z.enum(["tombstone", "stable_exact_not_found", "absence_recheck"]),
    evidence: ContractLostObservationSchema,
    observedAtMs: z.number().int().safe().finite().nonnegative(),
}).strict().superRefine((observation, context) => {
    if (Date.parse(observation.evidence.observedAt.completedAt) !== observation.observedAtMs) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["observedAtMs"],
            message: "observedAtMs must equal the evidence completedAt timestamp",
        });
    }
});

export type SourceAbsenceObservation = z.infer<typeof SourceAbsenceObservationSchema>;

const CoveredRevisionSchema = z.object({
    revision: IdentifierSchema,
    sequence: SafeSequenceSchema.nullable(),
}).strict();

const EvidenceErrorSchema = z.object({
    code: IdentifierSchema,
    message: IdentifierSchema,
}).strict();

const RecordIndexScopeCoreSchema = z.object({
    workspace: WorkspaceIdentitySchema,
    snapshotId: IdentifierSchema,
    indexRevision: IdentifierSchema,
    complete: z.boolean(),
    paginationComplete: z.boolean(),
    error: EvidenceErrorSchema.nullable(),
    extensions: JsonRecordSchema.default({}),
}).strict();

export const RecordIndexScopeSchema = RecordIndexScopeCoreSchema.extend({
    evidenceHash: HashSchema,
}).strict().superRefine((scope, context) => {
    const { evidenceHash: _evidenceHash, ...payload } = scope;
    if (evidenceHashFor(payload) !== scope.evidenceHash) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceHash"], message: "record index scope evidenceHash mismatch" });
    }
});

export type RecordIndexScope = z.infer<typeof RecordIndexScopeSchema>;

const RecordIndexEntryCoreSchema = z.object({
    recordId: IdentifierSchema,
    source: RecordSourceIdentitySchema,
    indexSnapshotId: IdentifierSchema,
    indexRevision: IdentifierSchema,
    coveredRevision: CoveredRevisionSchema.nullable(),
    recordBodyHash: HashSchema.nullable(),
    extensions: JsonRecordSchema.default({}),
}).strict();

export const RecordIndexEntrySchema = RecordIndexEntryCoreSchema.extend({
    evidenceHash: HashSchema,
}).strict().superRefine((entry, context) => {
    const { evidenceHash: _evidenceHash, ...payload } = entry;
    if (evidenceHashFor(payload) !== entry.evidenceHash) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceHash"], message: "record index entry evidenceHash mismatch" });
    }
});

export type RecordIndexEntry = z.infer<typeof RecordIndexEntrySchema>;

export const RecordIndexSnapshotSchema = z.object({
    scopes: z.array(RecordIndexScopeSchema),
    entries: z.array(RecordIndexEntrySchema),
}).strict();

export const RecordDiscoveryRequestSchema = z.object({
    snapshotId: IdentifierSchema,
    discoveredAtSequence: SafeSequenceSchema,
    filters: z.object({
        hosts: z.array(z.enum(SOURCE_EVIDENCE_HOSTS)).default([]),
        workspace: z.string().min(1).nullable().default(null),
        extensions: JsonRecordSchema.default({}),
    }).strict().default({}),
}).strict();

export const RecordDiscoveryInputSchema = z.object({
    request: RecordDiscoveryRequestSchema,
    sourceEnumerations: z.array(SourceEnumerationEnvelopeSchema),
    recordIndex: RecordIndexSnapshotSchema,
    absenceObservations: z.array(SourceAbsenceObservationSchema).default([]),
}).strict();

export type RecordDiscoveryInput = z.infer<typeof RecordDiscoveryInputSchema>;

export const RecordCandidateClassificationSchema = z.enum([
    "Fresh",
    "Stale",
    "Missing",
    "Unresolved",
    "Lost",
    "Conflict",
]);

export type RecordCandidateClassification = z.infer<typeof RecordCandidateClassificationSchema>;

const ClassificationReasonCodeSchema = z.enum([
    "record-covered-current-source",
    "source-revision-newer-than-record",
    "source-present-record-absent",
    "source-enumeration-incomplete",
    "source-enumeration-cache-not-bypassed",
    "source-enumeration-ambiguous",
    "source-enumeration-contradiction",
    "record-index-incomplete",
    "record-index-ambiguous",
    "record-index-entry-unbound",
    "source-multiple-records",
    "record-multiple-sources",
    "record-duplicate-conflict",
    "record-covered-revision-missing",
    "revision-order-unknown",
    "source-revision-older-than-record",
    "revision-sequence-conflict",
    "workspace-identity-conflict",
    "source-identity-conflict",
    "lost-strong-absence",
    "lost-two-independent-absences",
    "lost-observation-unbound",
    "source-not-observed",
]);

const ClassificationReasonSchema = z.object({
    code: ClassificationReasonCodeSchema,
    evidenceRefs: z.array(HashSchema),
}).strict();

const CurrentSourceRevisionSchema = z.object({
    revision: IdentifierSchema,
    contentCursor: z.string().min(1).nullable(),
    eventWatermark: z.string().min(1).nullable(),
    sequence: SafeSequenceSchema.nullable(),
}).strict();

export const RecordDiscoveryCandidateSchema = z.object({
    candidateId: IdentifierSchema,
    source: RecordSourceIdentitySchema,
    sourceEvidenceRefs: z.array(HashSchema),
    recordIndexEvidenceRefs: z.array(HashSchema),
    absenceEvidenceRefs: z.array(HashSchema),
    sourceRevision: CurrentSourceRevisionSchema.nullable(),
    classification: RecordCandidateClassificationSchema,
    classificationReason: ClassificationReasonSchema,
    safeToProcess: z.boolean(),
    evidenceHash: HashSchema,
    discoveredAtSequence: SafeSequenceSchema,
}).strict();

export type RecordDiscoveryCandidate = z.infer<typeof RecordDiscoveryCandidateSchema>;

const CandidateSnapshotPayloadSchema = z.object({
    schemaVersion: z.literal(RECORD_DISCOVERY_SCHEMA_VERSION),
    snapshotId: IdentifierSchema,
    request: z.object({
        filters: z.object({
            hosts: z.array(z.enum(SOURCE_EVIDENCE_HOSTS)),
            workspace: z.string().min(1).nullable(),
            extensions: JsonRecordSchema,
        }).strict(),
    }).strict(),
    discoveredAtSequence: SafeSequenceSchema,
    sourceEnumerations: z.array(SourceEnumerationEnvelopeSchema),
    recordIndex: RecordIndexSnapshotSchema,
    absenceObservations: z.array(SourceAbsenceObservationSchema),
    candidates: z.array(RecordDiscoveryCandidateSchema),
}).strict();

const CandidateSnapshotWireSchema = CandidateSnapshotPayloadSchema.extend({
    snapshotHash: HashSchema,
}).strict();

export type CandidateSnapshot = z.infer<typeof CandidateSnapshotWireSchema>;

export const CandidateSnapshotSchema = CandidateSnapshotWireSchema.superRefine((snapshot, context) => {
    try {
        assertCandidateSnapshotInternal(snapshot);
    } catch (error) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});

export type Immutable<Value> = Value extends (...args: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
        ? ReadonlyArray<Immutable<Item>>
        : Value extends object
            ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
            : Value;

const ContentBindingSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("inline"),
        content: z.string(),
        byteLength: SafeSequenceSchema,
        contentHash: HashSchema,
    }).strict(),
    z.object({
        kind: z.literal("spool"),
        ref: IdentifierSchema,
        byteLength: SafeSequenceSchema,
        contentHash: HashSchema,
    }).strict(),
]);

export const RecordSourceReadInputSchema = z.object({
    candidateId: IdentifierSchema,
    source: RecordSourceIdentitySchema,
    fullSourceRead: ContractFullSourceReadSchema,
    revisionSequence: SafeSequenceSchema.nullable(),
    contentBinding: ContentBindingSchema,
    formatterVersion: IdentifierSchema,
    capturedAtSequence: SafeSequenceSchema,
}).strict().superRefine((sourceRead, context) => {
    if (!sourceRead.fullSourceRead?.sourceRevision) return;
    if (sourceRead.revisionSequence !== sourceRead.fullSourceRead.sourceRevision.sequence) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["revisionSequence"],
            message: "revisionSequence must equal the authoritative full source read revision sequence",
        });
    }
});

const RecordSourceSnapshotPayloadSchema = z.object({
    schemaVersion: z.literal(RECORD_DISCOVERY_SCHEMA_VERSION),
    sourceSnapshotId: IdentifierSchema,
    candidateId: IdentifierSchema,
    source: RecordSourceIdentitySchema,
    contractSnapshot: ContractRecordSourceSnapshotSchema,
    desiredRevision: CurrentSourceRevisionSchema,
    contentBinding: ContentBindingSchema,
    formatterVersion: IdentifierSchema,
    capturedAtSequence: SafeSequenceSchema,
    verification: z.discriminatedUnion("status", [
        z.object({
            status: z.literal("inline-bytes-verified"),
            downstreamVerifierRequired: z.literal(false),
        }).strict(),
        z.object({
            status: z.literal("requires-downstream-spool-verification"),
            downstreamVerifierRequired: z.literal(true),
            reason: z.literal("pure-engine-cannot-read-spool-bytes"),
        }).strict(),
    ]),
}).strict();

const RecordSourceSnapshotWireSchema = RecordSourceSnapshotPayloadSchema.extend({
    snapshotHash: HashSchema,
}).strict();

export type RecordSourceSnapshot = z.infer<typeof RecordSourceSnapshotWireSchema>;

export const RecordSourceSnapshotSchema = RecordSourceSnapshotWireSchema.superRefine((snapshot, context) => {
    try {
        assertRecordSourceSnapshotInternal(snapshot);
    } catch (error) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
        });
    }
});

export const RecordSourceSnapshotRejectionSchema = z.object({
    status: z.literal("rejected"),
    classification: z.literal("Unresolved"),
    reason: z.enum(["invalid-source-read", "candidate-identity-mismatch", "content-binding-mismatch"]),
    issues: z.array(z.string().min(1)),
}).strict();

export const RecordSourceSnapshotResultSchema = z.discriminatedUnion("status", [
    z.object({
        status: z.literal("accepted"),
        snapshot: RecordSourceSnapshotSchema,
    }).strict(),
    RecordSourceSnapshotRejectionSchema,
]);

export type RecordSourceSnapshotResult = z.infer<typeof RecordSourceSnapshotResultSchema>;
export type RecordDiscoverySelector = "normal" | "stale_only" | "force";

interface DiscoveryMaterial {
    discoveredAtSequence: number;
    sourceEnumerations: SourceEnumerationEnvelope[];
    recordIndex: z.infer<typeof RecordIndexSnapshotSchema>;
    absenceObservations: SourceAbsenceObservation[];
}

interface CandidateClassificationResult {
    classification: RecordCandidateClassification;
    reason: z.infer<typeof ClassificationReasonSchema>;
    sourceRevision: z.infer<typeof CurrentSourceRevisionSchema> | null;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceHashFor(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function contentHashFor(value: string): string {
    return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function deepFreeze<Value>(value: Value): Immutable<Value> {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
        Object.freeze(value);
    }
    return value as Immutable<Value>;
}

function sourceIdentityFromEvidence(evidence: Pick<SourceEnumerationEvidence | LostObservation | FullSourceReadEvidence, "host" | "identity">): RecordSourceIdentity {
    return canonicalizeContractSourceIdentity({ host: evidence.host, identity: evidence.identity });
}

function sourceIdentityKey(source: RecordSourceIdentity): string {
    return canonicalSourceIdentityKey(source);
}

function workspaceKey(workspace: SourceConversationIdentity["workspace"]): string {
    return evidenceHashFor(canonicalizeSourceWorkspaceIdentity(workspace));
}

function workspaceKeyForSource(source: RecordSourceIdentity): string {
    return workspaceKey(source.identity.workspace);
}

function workspaceIdKeyForSource(source: RecordSourceIdentity): string {
    const canonical = canonicalizeContractSourceIdentity(source);
    return evidenceHashFor({
        host: canonical.host,
        workspaceId: canonical.identity.workspace.workspaceId,
    });
}

function conversationIdentityKeyForSource(source: RecordSourceIdentity): string {
    const canonical = canonicalizeContractSourceIdentity(source);
    return evidenceHashFor({
        host: canonical.host,
        workspace: canonical.identity.workspace,
        conversationId: canonical.identity.conversationId,
    });
}

function sourceStoreIdentityKeyForSource(source: RecordSourceIdentity): string {
    return evidenceHashFor(canonicalizeContractSourceIdentity(source).identity.source);
}

function candidateIdForSource(source: RecordSourceIdentity): string {
    return `candidate:${sourceIdentityKey(source)}`;
}

export function recordDiscoveryCandidateId(source: unknown): string {
    return candidateIdForSource(RecordSourceIdentitySchema.parse(source));
}

export function buildRecordIndexScope(input: unknown): Immutable<RecordIndexScope> {
    const payload = RecordIndexScopeCoreSchema.parse(input);
    return deepFreeze(RecordIndexScopeSchema.parse({ ...payload, evidenceHash: evidenceHashFor(payload) }));
}

export function buildRecordIndexEntry(input: unknown): Immutable<RecordIndexEntry> {
    const payload = RecordIndexEntryCoreSchema.parse(input);
    return deepFreeze(RecordIndexEntrySchema.parse({ ...payload, evidenceHash: evidenceHashFor(payload) }));
}

function sortByCanonical<Value>(values: readonly Value[]): Value[] {
    return values
        .map((value, index) => ({ value, index, sortKey: canonicalSerialize(value) }))
        .sort((left, right) => compareText(left.sortKey, right.sortKey) || left.index - right.index)
        .map(item => item.value);
}

function dedupeBy<Value>(values: readonly Value[], keyFor: (value: Value) => string): Value[] {
    const unique = new Map<string, Value>();
    for (const value of values) unique.set(keyFor(value), value);
    return sortByCanonical([...unique.values()]);
}

function completeEnumeration(evidence: SourceEnumerationEvidence, targetStatus: "present" | "absent"): boolean {
    return evidence.targetStatus === targetStatus
        && evidence.enumerationComplete
        && evidence.cacheBypassed
        && evidence.errors.length === 0
        && evidence.pagination.cursor === null
        && evidence.pagination.limit === null
        && !evidence.pagination.truncated
        && evidence.exactFetchResult === (targetStatus === "present" ? "present" : "not_found");
}

function enumerationSignature(envelope: SourceEnumerationEnvelope): string {
    return evidenceHashFor({
        scanId: envelope.evidence.observedAt.scanId,
        sourceRevision: envelope.evidence.sourceRevision,
        revisionSequence: envelope.revisionSequence,
        targetStatus: envelope.evidence.targetStatus,
    });
}

function reliableIndexScope(scopes: readonly RecordIndexScope[]): RecordIndexScope | null {
    const unique = dedupeBy(scopes, scope => scope.evidenceHash);
    if (unique.length !== 1) return null;
    const scope = unique[0];
    return scope.complete && scope.paginationComplete && scope.error === null ? scope : null;
}

function reason(code: z.infer<typeof ClassificationReasonCodeSchema>, refs: readonly string[]): z.infer<typeof ClassificationReasonSchema> {
    return { code, evidenceRefs: [...new Set(refs)].sort(compareText) };
}

function currentSourceRevision(envelope: SourceEnumerationEnvelope): z.infer<typeof CurrentSourceRevisionSchema> {
    return {
        revision: envelope.evidence.sourceRevision.revision,
        contentCursor: envelope.evidence.sourceRevision.contentCursor,
        eventWatermark: envelope.evidence.sourceRevision.eventWatermark,
        sequence: envelope.evidence.sourceRevision.sequence,
    };
}

function classifyRevision(
    sourceRevision: z.infer<typeof CurrentSourceRevisionSchema>,
    coveredRevision: z.infer<typeof CoveredRevisionSchema> | null,
    refs: readonly string[],
): CandidateClassificationResult {
    if (!coveredRevision) {
        return { classification: "Unresolved", reason: reason("record-covered-revision-missing", refs), sourceRevision };
    }
    if (sourceRevision.revision === coveredRevision.revision) {
        if (sourceRevision.sequence !== null && coveredRevision.sequence !== null && sourceRevision.sequence !== coveredRevision.sequence) {
            return { classification: "Conflict", reason: reason("revision-sequence-conflict", refs), sourceRevision };
        }
        return { classification: "Fresh", reason: reason("record-covered-current-source", refs), sourceRevision };
    }
    if (sourceRevision.sequence === null || coveredRevision.sequence === null) {
        return { classification: "Unresolved", reason: reason("revision-order-unknown", refs), sourceRevision };
    }
    if (sourceRevision.sequence === coveredRevision.sequence) {
        return { classification: "Conflict", reason: reason("revision-sequence-conflict", refs), sourceRevision };
    }
    if (sourceRevision.sequence < coveredRevision.sequence) {
        return { classification: "Unresolved", reason: reason("source-revision-older-than-record", refs), sourceRevision };
    }
    return { classification: "Stale", reason: reason("source-revision-newer-than-record", refs), sourceRevision };
}

function boundLostReason(
    enumerations: readonly SourceEnumerationEnvelope[],
    observations: readonly SourceAbsenceObservation[],
): z.infer<typeof ClassificationReasonSchema> | null {
    const enumerationsByHash = new Map(enumerations.map(envelope => [envelope.evidence.evidenceHash, envelope]));
    const bound: SourceAbsenceObservation[] = [];
    for (const observation of observations) {
        const enumeration = enumerationsByHash.get(observation.evidence.enumerationEvidenceHash);
        if (!enumeration) return reason("lost-observation-unbound", [observation.evidence.evidenceHash]);
        if (!completeEnumeration(enumeration.evidence, "absent")) {
            return reason("source-enumeration-incomplete", [enumeration.evidence.evidenceHash]);
        }
        if (sourceIdentityKey(sourceIdentityFromEvidence(enumeration.evidence)) !== sourceIdentityKey(sourceIdentityFromEvidence(observation.evidence))) {
            return reason("lost-observation-unbound", [observation.evidence.evidenceHash]);
        }
        if (enumeration.evidence.observedAt.scanId !== observation.evidence.observedAt.scanId) {
            return reason("lost-observation-unbound", [observation.evidence.evidenceHash]);
        }
        bound.push(observation);
    }
    const direct = bound.find(observation => observation.confirmation === "tombstone" || observation.confirmation === "stable_exact_not_found");
    if (direct) return reason("lost-strong-absence", [direct.evidence.evidenceHash, direct.evidence.enumerationEvidenceHash]);
    const rechecks = [...bound]
        .filter(observation => observation.confirmation === "absence_recheck")
        .sort((left, right) => left.observedAtMs - right.observedAtMs || compareText(left.evidence.observedAt.scanId, right.evidence.observedAt.scanId));
    let earliest: SourceAbsenceObservation | null = null;
    for (const observation of rechecks) {
        if (earliest && earliest.evidence.observedAt.scanId !== observation.evidence.observedAt.scanId
            && observation.observedAtMs - earliest.observedAtMs >= LOST_RECHECK_INTERVAL_MS) {
            return reason("lost-two-independent-absences", [
                earliest.evidence.evidenceHash,
                earliest.evidence.enumerationEvidenceHash,
                observation.evidence.evidenceHash,
                observation.evidence.enumerationEvidenceHash,
            ]);
        }
        if (!earliest || observation.observedAtMs < earliest.observedAtMs) earliest = observation;
    }
    return null;
}

function classifyCandidate(args: {
    source: RecordSourceIdentity;
    enumerations: SourceEnumerationEnvelope[];
    indexScopes: RecordIndexScope[];
    indexEntries: RecordIndexEntry[];
    observations: SourceAbsenceObservation[];
    recordHasMultipleSources: boolean;
    workspaceIdentityConflictRefs: string[];
    sourceIdentityConflictRefs: string[];
}): CandidateClassificationResult {
    const sourceRefs = args.enumerations.map(envelope => envelope.evidence.evidenceHash);
    const recordRefs = [
        ...args.indexScopes.map(scope => scope.evidenceHash),
        ...args.indexEntries.map(entry => entry.evidenceHash),
    ];
    const uniqueEntries = dedupeBy(args.indexEntries, entry => entry.evidenceHash);
    const uniqueRecordIds = new Set(uniqueEntries.map(entry => entry.recordId));
    const present = args.enumerations.filter(envelope => envelope.evidence.targetStatus === "present");
    const absent = args.enumerations.filter(envelope => envelope.evidence.targetStatus === "absent");

    if (args.workspaceIdentityConflictRefs.length > 0) {
        return {
            classification: "Conflict",
            reason: reason("workspace-identity-conflict", args.workspaceIdentityConflictRefs),
            sourceRevision: null,
        };
    }
    if (args.sourceIdentityConflictRefs.length > 0) {
        return {
            classification: "Conflict",
            reason: reason("source-identity-conflict", args.sourceIdentityConflictRefs),
            sourceRevision: null,
        };
    }
    if (args.recordHasMultipleSources) {
        return { classification: "Conflict", reason: reason("record-multiple-sources", recordRefs), sourceRevision: null };
    }
    if (uniqueRecordIds.size > 1) {
        return { classification: "Conflict", reason: reason("source-multiple-records", recordRefs), sourceRevision: null };
    }
    if (uniqueEntries.length > 1) {
        return { classification: "Conflict", reason: reason("record-duplicate-conflict", recordRefs), sourceRevision: null };
    }
    if (present.length > 0 && absent.length > 0) {
        return { classification: "Conflict", reason: reason("source-enumeration-contradiction", sourceRefs), sourceRevision: null };
    }

    if (present.length > 0) {
        if (present.some(envelope => !envelope.evidence.cacheBypassed)) {
            return { classification: "Unresolved", reason: reason("source-enumeration-cache-not-bypassed", sourceRefs), sourceRevision: null };
        }
        if (present.some(envelope => !completeEnumeration(envelope.evidence, "present"))) {
            return { classification: "Unresolved", reason: reason("source-enumeration-incomplete", sourceRefs), sourceRevision: null };
        }
        if (new Set(present.map(enumerationSignature)).size !== 1) {
            return { classification: "Unresolved", reason: reason("source-enumeration-ambiguous", sourceRefs), sourceRevision: null };
        }
        const authoritative = sortByCanonical(present)[0];
        const sourceRevision = currentSourceRevision(authoritative);
        if (sourceRevision.contentCursor === null && sourceRevision.eventWatermark === null) {
            return { classification: "Unresolved", reason: reason("source-enumeration-incomplete", sourceRefs), sourceRevision };
        }
        const indexScope = reliableIndexScope(args.indexScopes);
        if (!indexScope) {
            return {
                classification: "Unresolved",
                reason: reason(args.indexScopes.length > 1 ? "record-index-ambiguous" : "record-index-incomplete", recordRefs),
                sourceRevision,
            };
        }
        const record = uniqueEntries[0];
        if (!record) {
            return { classification: "Missing", reason: reason("source-present-record-absent", [...sourceRefs, indexScope.evidenceHash]), sourceRevision };
        }
        if (record.indexSnapshotId !== indexScope.snapshotId || record.indexRevision !== indexScope.indexRevision) {
            return { classification: "Unresolved", reason: reason("record-index-entry-unbound", recordRefs), sourceRevision };
        }
        return classifyRevision(sourceRevision, record.coveredRevision, [...sourceRefs, ...recordRefs]);
    }

    if (args.enumerations.some(envelope => !envelope.evidence.cacheBypassed)) {
        return { classification: "Unresolved", reason: reason("source-enumeration-cache-not-bypassed", sourceRefs), sourceRevision: null };
    }
    if (args.enumerations.some(envelope => !completeEnumeration(envelope.evidence, "absent"))) {
        return { classification: "Unresolved", reason: reason("source-enumeration-incomplete", sourceRefs), sourceRevision: null };
    }
    const lost = boundLostReason(args.enumerations, args.observations);
    if (lost?.code === "lost-strong-absence" || lost?.code === "lost-two-independent-absences") {
        return { classification: "Lost", reason: lost, sourceRevision: null };
    }
    if (lost) return { classification: "Unresolved", reason: lost, sourceRevision: null };
    return {
        classification: "Unresolved",
        reason: reason(args.enumerations.length === 0 ? "source-not-observed" : "lost-observation-unbound", [
            ...sourceRefs,
            ...args.observations.map(observation => observation.evidence.evidenceHash),
        ]),
        sourceRevision: null,
    };
}

function buildCandidates(material: DiscoveryMaterial): RecordDiscoveryCandidate[] {
    const enumerationsByIdentity = new Map<string, SourceEnumerationEnvelope[]>();
    const recordsByIdentity = new Map<string, RecordIndexEntry[]>();
    const observationsByIdentity = new Map<string, SourceAbsenceObservation[]>();
    const scopesByWorkspace = new Map<string, RecordIndexScope[]>();
    const references = new Map<string, RecordSourceIdentity>();
    const recordSources = new Map<string, Set<string>>();

    for (const envelope of material.sourceEnumerations) {
        const source = sourceIdentityFromEvidence(envelope.evidence);
        const key = sourceIdentityKey(source);
        const existing = enumerationsByIdentity.get(key) || [];
        existing.push(envelope);
        enumerationsByIdentity.set(key, existing);
        references.set(key, source);
    }
    for (const entry of material.recordIndex.entries) {
        const key = sourceIdentityKey(entry.source);
        const existing = recordsByIdentity.get(key) || [];
        existing.push(entry);
        recordsByIdentity.set(key, existing);
        references.set(key, entry.source);
        const sources = recordSources.get(entry.recordId) || new Set<string>();
        sources.add(key);
        recordSources.set(entry.recordId, sources);
    }
    for (const observation of material.absenceObservations) {
        const source = sourceIdentityFromEvidence(observation.evidence);
        const key = sourceIdentityKey(source);
        const existing = observationsByIdentity.get(key) || [];
        existing.push(observation);
        observationsByIdentity.set(key, existing);
        references.set(key, source);
    }
    for (const scope of material.recordIndex.scopes) {
        const key = workspaceKey(scope.workspace);
        const existing = scopesByWorkspace.get(key) || [];
        existing.push(scope);
        scopesByWorkspace.set(key, existing);
    }

    const candidateKeys = new Set<string>();
    for (const [key, enumerations] of enumerationsByIdentity) {
        if (enumerations.some(envelope => envelope.evidence.targetStatus === "present")) candidateKeys.add(key);
    }
    for (const key of recordsByIdentity.keys()) candidateKeys.add(key);

    const workspacePathGroups = new Map<string, {
        candidateKeys: Set<string>;
        canonicalPaths: Set<string>;
        evidenceRefs: Set<string>;
    }>();
    const sourceIdentityGroups = new Map<string, {
        candidateKeys: Set<string>;
        sourceStores: Set<string>;
        evidenceRefs: Set<string>;
    }>();
    for (const [key, source] of references) {
        const evidenceRefs = [
            ...(enumerationsByIdentity.get(key) || []).map(envelope => envelope.evidence.evidenceHash),
            ...(recordsByIdentity.get(key) || []).map(entry => entry.evidenceHash),
            ...(observationsByIdentity.get(key) || []).map(observation => observation.evidence.evidenceHash),
            ...(scopesByWorkspace.get(workspaceKeyForSource(source)) || []).map(scope => scope.evidenceHash),
        ];
        const groupKey = workspaceIdKeyForSource(source);
        const group = workspacePathGroups.get(groupKey) || {
            candidateKeys: new Set<string>(),
            canonicalPaths: new Set<string>(),
            evidenceRefs: new Set<string>(),
        };
        if (candidateKeys.has(key)) group.candidateKeys.add(key);
        const canonicalPath = canonicalizeSourceWorkspaceIdentity(source.identity.workspace).canonicalPath;
        if (canonicalPath !== null) group.canonicalPaths.add(canonicalPath);
        for (const evidenceRef of evidenceRefs) group.evidenceRefs.add(evidenceRef);
        workspacePathGroups.set(groupKey, group);

        const sourceGroupKey = conversationIdentityKeyForSource(source);
        const sourceGroup = sourceIdentityGroups.get(sourceGroupKey) || {
            candidateKeys: new Set<string>(),
            sourceStores: new Set<string>(),
            evidenceRefs: new Set<string>(),
        };
        if (candidateKeys.has(key)) sourceGroup.candidateKeys.add(key);
        sourceGroup.sourceStores.add(sourceStoreIdentityKeyForSource(source));
        for (const evidenceRef of evidenceRefs) sourceGroup.evidenceRefs.add(evidenceRef);
        sourceIdentityGroups.set(sourceGroupKey, sourceGroup);
    }
    const workspaceIdentityConflictRefs = new Map<string, string[]>();
    for (const group of workspacePathGroups.values()) {
        if (group.canonicalPaths.size < 2) continue;
        const refs = [...group.evidenceRefs].sort(compareText);
        for (const key of group.candidateKeys) workspaceIdentityConflictRefs.set(key, refs);
    }
    const sourceIdentityConflictRefs = new Map<string, string[]>();
    for (const group of sourceIdentityGroups.values()) {
        if (group.sourceStores.size < 2) continue;
        const refs = [...group.evidenceRefs].sort(compareText);
        for (const key of group.candidateKeys) sourceIdentityConflictRefs.set(key, refs);
    }

    return [...candidateKeys].sort(compareText).map(key => {
        const source = references.get(key);
        if (!source) throw new Error(`candidate ${key} has no canonical source identity`);
        const enumerations = sortByCanonical(enumerationsByIdentity.get(key) || []);
        const indexEntries = sortByCanonical(recordsByIdentity.get(key) || []);
        const observations = sortByCanonical(observationsByIdentity.get(key) || []);
        const indexScopes = sortByCanonical(scopesByWorkspace.get(workspaceKeyForSource(source)) || []);
        const recordHasMultipleSources = indexEntries.some(entry => (recordSources.get(entry.recordId)?.size || 0) > 1);
        const classified = classifyCandidate({
            source,
            enumerations,
            indexScopes,
            indexEntries,
            observations,
            recordHasMultipleSources,
            workspaceIdentityConflictRefs: workspaceIdentityConflictRefs.get(key) || [],
            sourceIdentityConflictRefs: sourceIdentityConflictRefs.get(key) || [],
        });
        const classification = classified.classification;
        const payload = {
            candidateId: candidateIdForSource(source),
            source,
            sourceEvidenceRefs: enumerations.map(envelope => envelope.evidence.evidenceHash).sort(compareText),
            recordIndexEvidenceRefs: [...indexScopes.map(scope => scope.evidenceHash), ...indexEntries.map(entry => entry.evidenceHash)].sort(compareText),
            absenceEvidenceRefs: observations.map(observation => observation.evidence.evidenceHash).sort(compareText),
            sourceRevision: classified.sourceRevision,
            classification,
            classificationReason: classified.reason,
            safeToProcess: classification === "Fresh" || classification === "Stale" || classification === "Missing",
            discoveredAtSequence: material.discoveredAtSequence,
        };
        return { ...payload, evidenceHash: evidenceHashFor(payload) };
    });
}

function snapshotPayload(snapshot: CandidateSnapshot): z.infer<typeof CandidateSnapshotPayloadSchema> {
    const { snapshotHash: _snapshotHash, ...payload } = snapshot;
    return payload;
}

function assertCandidateSnapshotInternal(snapshot: CandidateSnapshot): void {
    if (evidenceHashFor(snapshotPayload(snapshot)) !== snapshot.snapshotHash) throw new Error("CandidateSnapshot snapshotHash mismatch");
    const expected = buildCandidates({
        discoveredAtSequence: snapshot.discoveredAtSequence,
        sourceEnumerations: snapshot.sourceEnumerations,
        recordIndex: snapshot.recordIndex,
        absenceObservations: snapshot.absenceObservations,
    });
    if (canonicalSerialize(expected) !== canonicalSerialize(snapshot.candidates)) {
        throw new Error("CandidateSnapshot candidates violate discovery invariants");
    }
}

export function discoverRecordCandidates(input: unknown): Immutable<CandidateSnapshot> {
    const parsed = RecordDiscoveryInputSchema.parse(input);
    const material: DiscoveryMaterial = {
        discoveredAtSequence: parsed.request.discoveredAtSequence,
        sourceEnumerations: sortByCanonical(parsed.sourceEnumerations),
        recordIndex: {
            scopes: sortByCanonical(parsed.recordIndex.scopes),
            entries: sortByCanonical(parsed.recordIndex.entries),
        },
        absenceObservations: sortByCanonical(parsed.absenceObservations),
    };
    const payload: z.infer<typeof CandidateSnapshotPayloadSchema> = {
        schemaVersion: RECORD_DISCOVERY_SCHEMA_VERSION,
        snapshotId: parsed.request.snapshotId,
        request: { filters: parsed.request.filters },
        discoveredAtSequence: material.discoveredAtSequence,
        sourceEnumerations: material.sourceEnumerations,
        recordIndex: material.recordIndex,
        absenceObservations: material.absenceObservations,
        candidates: buildCandidates(material),
    };
    return deepFreeze(CandidateSnapshotSchema.parse({ ...payload, snapshotHash: evidenceHashFor(payload) }));
}

export function validateCandidateSnapshot(snapshot: unknown): Immutable<CandidateSnapshot> {
    return deepFreeze(CandidateSnapshotSchema.parse(snapshot));
}

export function selectRecordDiscoveryCandidates(
    snapshot: unknown,
    selector: RecordDiscoverySelector,
): Immutable<RecordDiscoveryCandidate[]> {
    const parsed = CandidateSnapshotSchema.parse(snapshot);
    const selected = parsed.candidates.filter(candidate => {
        if (selector === "normal") return candidate.classification === "Stale" || candidate.classification === "Missing";
        if (selector === "stale_only") return candidate.classification === "Stale";
        return candidate.classification === "Fresh"
            || candidate.classification === "Stale"
            || candidate.classification === "Missing"
            || (candidate.classification === "Unresolved"
                && candidate.classificationReason.code === "record-covered-revision-missing");
    });
    return deepFreeze([...selected].sort((left, right) => compareText(left.candidateId, right.candidateId)));
}

function assertContentBinding(fullSourceRead: FullSourceReadEvidence, binding: z.infer<typeof ContentBindingSchema>): void {
    if (binding.contentHash !== fullSourceRead.content.contentHash || binding.byteLength !== fullSourceRead.content.byteLength) {
        throw new Error("content binding hash/byteLength does not match full source read evidence");
    }
    if (binding.kind === "inline") {
        if (Buffer.byteLength(binding.content, "utf8") !== binding.byteLength || contentHashFor(binding.content) !== binding.contentHash) {
            throw new Error("inline content bytes do not match declared hash/byteLength");
        }
    }
}

function sourceSnapshotIdFor(input: {
    candidateId: string;
    fullSourceRead: FullSourceReadEvidence;
    contentBinding: z.infer<typeof ContentBindingSchema>;
    formatterVersion: string;
    capturedAtSequence: number;
}): string {
    return `record-source:${evidenceHashFor({
        candidateId: input.candidateId,
        fullSourceReadHash: input.fullSourceRead.evidenceHash,
        sourceRevision: input.fullSourceRead.sourceRevision,
        contentHash: input.contentBinding.contentHash,
        formatterVersion: input.formatterVersion,
        capturedAtSequence: input.capturedAtSequence,
    })}`;
}

function assertRecordSourceSnapshotInternal(snapshot: RecordSourceSnapshot): void {
    if (snapshot.candidateId !== candidateIdForSource(snapshot.source)) throw new Error("RecordSourceSnapshot candidateId mismatch");
    const fullSourceRead = snapshot.contractSnapshot.fullSourceRead;
    if (sourceIdentityKey(snapshot.source) !== sourceIdentityKey(sourceIdentityFromEvidence(fullSourceRead))) {
        throw new Error("RecordSourceSnapshot source identity mismatch");
    }
    if (snapshot.sourceSnapshotId !== snapshot.contractSnapshot.snapshotId) throw new Error("RecordSourceSnapshot id mismatch");
    if (snapshot.sourceSnapshotId !== sourceSnapshotIdFor({
        candidateId: snapshot.candidateId,
        fullSourceRead,
        contentBinding: snapshot.contentBinding,
        formatterVersion: snapshot.formatterVersion,
        capturedAtSequence: snapshot.capturedAtSequence,
    })) {
        throw new Error("RecordSourceSnapshot id does not match canonical snapshot identity");
    }
    if (canonicalSerialize(snapshot.desiredRevision) !== canonicalSerialize(fullSourceRead.sourceRevision)) {
        throw new Error("RecordSourceSnapshot desiredRevision does not match full source read evidence");
    }
    assertContentBinding(fullSourceRead, snapshot.contentBinding);
    if (snapshot.contentBinding.kind === "spool") {
        if (!snapshot.verification.downstreamVerifierRequired || snapshot.verification.status !== "requires-downstream-spool-verification") {
            throw new Error("spool binding must require downstream byte verification");
        }
    } else if (snapshot.verification.downstreamVerifierRequired || snapshot.verification.status !== "inline-bytes-verified") {
        throw new Error("inline binding verification state mismatch");
    }
    const { snapshotHash: _snapshotHash, ...payload } = snapshot;
    if (evidenceHashFor(payload) !== snapshot.snapshotHash) throw new Error("RecordSourceSnapshot snapshotHash mismatch");
}

export function createRecordSourceSnapshot(input: unknown): Immutable<RecordSourceSnapshotResult> {
    const parsed = RecordSourceReadInputSchema.safeParse(input);
    if (!parsed.success) {
        return deepFreeze({
            status: "rejected",
            classification: "Unresolved",
            reason: "invalid-source-read",
            issues: parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`),
        });
    }
    const sourceRead = parsed.data;
    if (sourceRead.candidateId !== candidateIdForSource(sourceRead.source)
        || sourceIdentityKey(sourceRead.source) !== sourceIdentityKey(sourceIdentityFromEvidence(sourceRead.fullSourceRead))) {
        return deepFreeze({
            status: "rejected",
            classification: "Unresolved",
            reason: "candidate-identity-mismatch",
            issues: ["candidateId, source identity, and full source read identity must be canonical and equal"],
        });
    }
    try {
        assertContentBinding(sourceRead.fullSourceRead, sourceRead.contentBinding);
    } catch (error) {
        return deepFreeze({
            status: "rejected",
            classification: "Unresolved",
            reason: "content-binding-mismatch",
            issues: [error instanceof Error ? error.message : String(error)],
        });
    }
    const sourceSnapshotId = sourceSnapshotIdFor({
        candidateId: sourceRead.candidateId,
        fullSourceRead: sourceRead.fullSourceRead,
        contentBinding: sourceRead.contentBinding,
        formatterVersion: sourceRead.formatterVersion,
        capturedAtSequence: sourceRead.capturedAtSequence,
    });
    const contractSnapshot = buildContractRecordSourceSnapshot({
        snapshotId: sourceSnapshotId,
        fullSourceRead: sourceRead.fullSourceRead,
    });
    const payload = RecordSourceSnapshotPayloadSchema.parse({
        schemaVersion: RECORD_DISCOVERY_SCHEMA_VERSION,
        sourceSnapshotId,
        candidateId: sourceRead.candidateId,
        source: sourceRead.source,
        contractSnapshot,
        desiredRevision: sourceRead.fullSourceRead.sourceRevision,
        contentBinding: sourceRead.contentBinding,
        formatterVersion: sourceRead.formatterVersion,
        capturedAtSequence: sourceRead.capturedAtSequence,
        verification: sourceRead.contentBinding.kind === "spool"
            ? {
                status: "requires-downstream-spool-verification",
                downstreamVerifierRequired: true,
                reason: "pure-engine-cannot-read-spool-bytes",
            }
            : {
                status: "inline-bytes-verified",
                downstreamVerifierRequired: false,
            },
    });
    const snapshot = RecordSourceSnapshotSchema.parse({ ...payload, snapshotHash: evidenceHashFor(payload) });
    return deepFreeze({ status: "accepted", snapshot });
}
