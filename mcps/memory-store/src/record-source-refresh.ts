import { createHash } from "node:crypto";
import type {
    CandidateState,
    ImmutableBlobReference,
    PendingRefreshReference,
    RecordSourceSnapshot,
    SourceChain,
} from "./record-scheduler-contracts.js";

export const RECORD_SOURCE_REFRESH_COORDINATOR_VERSION = 2 as const;
export const RECORD_SOURCE_REFRESH_RECEIPT_VERSION = 1 as const;

export interface RecordSourceRefreshIdentity {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}

export interface RecordSourceRefreshRootBinding {
    dataRootId: string;
    rootPathHash: string;
}

export type ImmutableRecordSourceSnapshot = Readonly<Omit<RecordSourceSnapshot, "snapshotRef" | "contentRef" | "readRange" | "gaps" | "parseWarnings">> & {
    snapshotRef: Readonly<ImmutableBlobReference>;
    contentRef: Readonly<ImmutableBlobReference>;
    readRange: Readonly<RecordSourceSnapshot["readRange"]>;
    gaps: readonly string[];
    parseWarnings: readonly string[];
};

export type RecordSourceRefreshContentEvidence =
    | { authority: "independent-content-hash"; verified: true }
    | { authority: "content-addressed-revision"; verified: true; revisionContentHash: string };

export interface RecordSourceRefreshRereadBase {
    identity: RecordSourceRefreshIdentity;
    complete: boolean;
    partial: boolean;
    cacheBypassed: boolean;
    errors: readonly string[];
}

export interface RecordSourceRefreshCurrentReread extends RecordSourceRefreshRereadBase {
    kind: "current";
    currentRevision: string;
    currentRevisionSequence?: number;
    contentHash: string;
    contentEvidence: RecordSourceRefreshContentEvidence;
}

export interface RecordSourceRefreshLostReread extends RecordSourceRefreshRereadBase {
    kind: "lost";
}

export interface RecordSourceRefreshConflictReread extends RecordSourceRefreshRereadBase {
    kind: "conflict";
}

export interface RecordSourceRefreshUnresolvedReread extends RecordSourceRefreshRereadBase {
    kind: "unresolved";
}

export type RecordSourceRefreshReread =
    | RecordSourceRefreshCurrentReread
    | RecordSourceRefreshLostReread
    | RecordSourceRefreshConflictReread
    | RecordSourceRefreshUnresolvedReread;

export type AuthoritativeRevisionOrder = "equal" | "advanced" | "behind" | "unresolved";

export interface RecordSourceRefreshRereadRequest {
    identity: RecordSourceRefreshIdentity;
    sourceSnapshotId: string;
    expectedRevision: string;
    expectedContentHash: string;
    contentRef: Readonly<ImmutableBlobReference>;
}

export interface RecordSourceRefreshRevisionOrderRequest {
    identity: RecordSourceRefreshIdentity;
    expectedRevision: string;
    expectedRevisionSequence?: number;
    currentRevision: string;
    currentRevisionSequence?: number;
}

export interface RecordSourceRefreshSchedulerLedgerCasBarrier {
    mode: "scheduler-ledger-cas";
    ledgerId: string;
    expectedRevision: number;
    commitId: string;
}

export interface RecordSourceRefreshEnsureRequest {
    refreshKey: string;
    identity: RecordSourceRefreshIdentity;
    persistenceRoot: RecordSourceRefreshRootBinding;
    sourceSnapshot: ImmutableRecordSourceSnapshot;
    taskId: string;
    recordWorkKey: string;
    fromRevision: string;
    desiredRevision: string;
    schedulerLedgerCas?: RecordSourceRefreshSchedulerLedgerCasBarrier;
}

export interface RecordSourceRefreshLedgerDurabilityReceipt {
    revision: number;
    ref: ImmutableBlobReference;
    persistedHash: string;
}

export interface RecordSourceRefreshWriteDurabilityReceipt {
    scope: "process-crash-hot-restart";
    temporaryFileSynced: true;
    atomicReplaceCompleted: true;
    targetFileSynced: true;
    parentDirectory: {
        method: "directory-fsync" | "windows-target-file-flush";
        durableBarrierCompleted: true;
    };
}

export type RecordSourceRefreshCasReceipt =
    | {
        scope: "refresh-ledger";
        ledgerId: string;
        expectedRevision: number;
        committedRevision: number;
        transactionId: string;
    }
    | {
        scope: "scheduler-ledger";
        ledgerId: string;
        expectedRevision: number;
        committedRevision: number;
        transactionId: string;
        commitId: string;
        commitSourceFieldsIncluded: true;
    };

export interface RecordSourceRefreshDurabilityReceipt {
    version: typeof RECORD_SOURCE_REFRESH_RECEIPT_VERSION;
    refreshKey: string;
    rootBinding: RecordSourceRefreshRootBinding;
    ledger: RecordSourceRefreshLedgerDurabilityReceipt;
    refreshRecordHash: string;
    durability: RecordSourceRefreshWriteDurabilityReceipt;
    cas: RecordSourceRefreshCasReceipt;
}

export interface RecordSourceRefreshEnsureResult {
    disposition: "created" | "attached";
    pendingRefresh: PendingRefreshReference;
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
}

export interface RecordSourceRefreshReadBackRequest {
    refreshKey: string;
    identity: RecordSourceRefreshIdentity;
    persistenceRoot: RecordSourceRefreshRootBinding;
    sourceSnapshotId: string;
    recordWorkKey: string;
    fromRevision: string;
    desiredRevision: string;
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
    schedulerLedgerCas?: RecordSourceRefreshSchedulerLedgerCasBarrier;
}

export interface RecordSourceRefreshVerifiedReadBack {
    kind: "verified";
    readFrom: "durable-storage";
    refreshKey: string;
    rootBinding: RecordSourceRefreshRootBinding;
    pendingRefresh: PendingRefreshReference;
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
    ledger: RecordSourceRefreshLedgerDurabilityReceipt;
    refreshRecordHash: string;
    observedAt: string;
}

export type RecordSourceRefreshReadBackResult =
    | RecordSourceRefreshVerifiedReadBack
    | { kind: "missing"; reason: string }
    | { kind: "corrupt"; reason: string }
    | { kind: "unresolved"; reason: string };

export interface RecordSourceRefreshBackend {
    rereadCurrentSource(request: RecordSourceRefreshRereadRequest): Promise<RecordSourceRefreshReread>;
    compareAuthoritativeRevisions(request: RecordSourceRefreshRevisionOrderRequest): Promise<AuthoritativeRevisionOrder>;
    ensurePendingRefresh(request: RecordSourceRefreshEnsureRequest): Promise<RecordSourceRefreshEnsureResult>;
    readBackPendingRefresh(request: RecordSourceRefreshReadBackRequest): Promise<RecordSourceRefreshReadBackResult>;
}

export interface RecordSourceRefreshCoordinateInput {
    taskId: string;
    recordWorkKey: string;
    sourceSnapshot: Readonly<RecordSourceSnapshot>;
    persistenceRoot: RecordSourceRefreshRootBinding;
    schedulerLedgerCas?: RecordSourceRefreshSchedulerLedgerCasBarrier;
}

export interface RecordSourceRefreshLedgerSourceFields {
    sourceSnapshotId: string;
    sourceRevision: string;
    desiredRevision: string;
    contentHash: string;
    contentRef: Readonly<ImmutableBlobReference>;
}

export interface RecordSourceRefreshLedgerCommitFields {
    sourceSnapshotId: string;
    observedSourceRevisionAtCommit: string;
    coveredRevision: string | null;
    pendingRefresh: PendingRefreshReference | null;
}

export interface RecordSourceRefreshConversationStateFields {
    identity: RecordSourceRefreshIdentity;
    candidateState: CandidateState;
    sourceSnapshotId: string;
    sourceRevision: string;
    observedSourceRevision: string | null;
    observedContentHash: string | null;
    recordCoveredRevision: string | null;
    pendingRefreshKey: string | null;
    contentHash: string;
    contentRef: Readonly<ImmutableBlobReference>;
}

export interface RecordSourceRefreshVerifiedPersistence {
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
    readBack: RecordSourceRefreshVerifiedReadBack;
}

export interface RecordSourceRefreshDecision {
    version: typeof RECORD_SOURCE_REFRESH_COORDINATOR_VERSION;
    commitAllowed: boolean;
    candidateState: CandidateState;
    reason: string;
    sourceSnapshot: ImmutableRecordSourceSnapshot;
    reread: RecordSourceRefreshReread | null;
    ledgerSource: RecordSourceRefreshLedgerSourceFields;
    ledgerCommit: RecordSourceRefreshLedgerCommitFields | null;
    conversationState: RecordSourceRefreshConversationStateFields;
    refreshPersistence: RecordSourceRefreshVerifiedPersistence | null;
}

export function createPendingRefreshKey(identity: RecordSourceRefreshIdentity, currentRevision: string): string {
    return sha256(JSON.stringify([identity.chain, identity.workspaceHash, identity.conversationId, currentRevision, "record-refresh"]));
}

export function createPendingRefreshRecordHash(pendingRefresh: PendingRefreshReference): string {
    return sha256(canonicalSerialize(pendingRefresh));
}

export class RecordSourceRefreshCoordinator {
    constructor(private readonly backend: RecordSourceRefreshBackend) {}

    async coordinate(input: RecordSourceRefreshCoordinateInput): Promise<RecordSourceRefreshDecision> {
        const sourceSnapshot = freezeSnapshot(input.sourceSnapshot);
        const identity = sourceIdentity(sourceSnapshot);
        const ledgerSource = sourceFields(sourceSnapshot);
        const persistenceRoot = freezeRootBinding(input.persistenceRoot);
        const schedulerLedgerCas = freezeSchedulerLedgerCas(input.schedulerLedgerCas);

        if (!isNonEmptyString(input.taskId) || !isNonEmptyString(input.recordWorkKey)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "task-or-record-work-key-invalid", null);
        }
        if (!isValidRootBinding(persistenceRoot)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "persistence-root-binding-invalid", null);
        }
        if (schedulerLedgerCas !== undefined && !isValidSchedulerLedgerCasBarrier(schedulerLedgerCas)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "scheduler-ledger-cas-barrier-invalid", null);
        }
        if (!isCommitEligibleSnapshot(sourceSnapshot)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "source-snapshot-invalid", null);
        }

        let reread: RecordSourceRefreshReread;
        try {
            reread = await this.backend.rereadCurrentSource({
                identity,
                sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
                expectedRevision: sourceSnapshot.desiredRevision,
                expectedContentHash: sourceSnapshot.contentHash,
                contentRef: sourceSnapshot.contentRef,
            });
        } catch {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "source-reread-failed", null);
        }

        if (!isWellFormedReread(reread)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "source-reread-malformed", null);
        }
        if (!sameIdentity(identity, reread.identity)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Conflict", "source-identity-drift", reread);
        }
        if (reread.kind === "lost") {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Lost", "source-lost", reread);
        }
        if (reread.kind === "conflict") {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Conflict", "source-reread-conflict", reread);
        }
        if (reread.kind !== "current") {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "source-reread-unresolved", reread);
        }
        if (!isAuthoritativeCurrentReread(reread)) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "source-reread-not-authoritative", reread);
        }

        let order: AuthoritativeRevisionOrder;
        try {
            order = await this.backend.compareAuthoritativeRevisions({
                identity,
                expectedRevision: sourceSnapshot.desiredRevision,
                expectedRevisionSequence: sourceSnapshot.sourceRevisionSequence,
                currentRevision: reread.currentRevision,
                currentRevisionSequence: reread.currentRevisionSequence,
            });
        } catch {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "revision-ordering-failed", reread);
        }

        if (order === "equal") {
            if (reread.currentRevision !== sourceSnapshot.desiredRevision) {
                return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "authoritative-equality-revision-mismatch", reread);
            }
            if (reread.contentHash !== sourceSnapshot.contentHash) {
                return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "equal-revision-content-hash-mismatch", reread);
            }
            return allowedDecision(sourceSnapshot, ledgerSource, identity, reread, "Fresh", "revision-and-content-equal", reread.currentRevision, null, null);
        }
        if (order === "behind") {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Conflict", "source-revision-moved-backward", reread);
        }
        if (order !== "advanced") {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "revision-ordering-unresolved", reread);
        }

        const refreshKey = createPendingRefreshKey(identity, reread.currentRevision);
        let ensured: RecordSourceRefreshEnsureResult;
        try {
            const ensureResult = await this.backend.ensurePendingRefresh({
                refreshKey,
                identity,
                persistenceRoot,
                sourceSnapshot,
                taskId: input.taskId,
                recordWorkKey: input.recordWorkKey,
                fromRevision: sourceSnapshot.desiredRevision,
                desiredRevision: reread.currentRevision,
                schedulerLedgerCas,
            });
            if (!isValidEnsureResult(
                ensureResult,
                refreshKey,
                identity,
                persistenceRoot,
                sourceSnapshot,
                input.recordWorkKey,
                reread.currentRevision,
                schedulerLedgerCas,
            )) {
                return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "pending-refresh-durability-receipt-invalid", reread);
            }
            ensured = ensureResult;
        } catch (error) {
            return blockedDecision(
                sourceSnapshot,
                ledgerSource,
                identity,
                "Unresolved",
                `pending-refresh-ensure-failed:${error instanceof Error ? error.message : String(error)}`,
                reread,
            );
        }

        let readBack: RecordSourceRefreshReadBackResult;
        try {
            readBack = await this.backend.readBackPendingRefresh({
                refreshKey,
                identity,
                persistenceRoot,
                sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
                recordWorkKey: input.recordWorkKey,
                fromRevision: sourceSnapshot.desiredRevision,
                desiredRevision: reread.currentRevision,
                durabilityReceipt: ensured.durabilityReceipt,
                schedulerLedgerCas,
            });
        } catch (error) {
            return blockedDecision(
                sourceSnapshot,
                ledgerSource,
                identity,
                "Unresolved",
                `pending-refresh-readback-failed:${error instanceof Error ? error.message : String(error)}`,
                reread,
            );
        }

        if (!isValidVerifiedReadBack(
            readBack,
            ensured,
            refreshKey,
            identity,
            persistenceRoot,
            sourceSnapshot,
            input.recordWorkKey,
            reread.currentRevision,
            schedulerLedgerCas,
        )) {
            return blockedDecision(sourceSnapshot, ledgerSource, identity, "Unresolved", "pending-refresh-readback-unverified", reread);
        }

        return allowedDecision(
            sourceSnapshot,
            ledgerSource,
            identity,
            reread,
            "Stale",
            "source-advanced-refresh-durable-and-verified",
            reread.currentRevision,
            ensured.pendingRefresh,
            { durabilityReceipt: ensured.durabilityReceipt, readBack },
        );
    }
}

function allowedDecision(
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    ledgerSource: RecordSourceRefreshLedgerSourceFields,
    identity: RecordSourceRefreshIdentity,
    reread: RecordSourceRefreshCurrentReread,
    candidateState: "Fresh" | "Stale",
    reason: string,
    observedSourceRevisionAtCommit: string,
    pendingRefresh: PendingRefreshReference | null,
    refreshPersistence: RecordSourceRefreshVerifiedPersistence | null,
): RecordSourceRefreshDecision {
    const coveredRevision = candidateState === "Fresh"
        ? observedSourceRevisionAtCommit
        : sourceSnapshot.desiredRevision;
    return {
        version: RECORD_SOURCE_REFRESH_COORDINATOR_VERSION,
        commitAllowed: true,
        candidateState,
        reason,
        sourceSnapshot,
        reread,
        ledgerSource,
        ledgerCommit: {
            sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
            observedSourceRevisionAtCommit,
            coveredRevision,
            pendingRefresh,
        },
        conversationState: conversationStateFields(
            sourceSnapshot,
            identity,
            candidateState,
            observedSourceRevisionAtCommit,
            reread.contentHash,
            coveredRevision,
            pendingRefresh?.refreshKey ?? null,
        ),
        refreshPersistence,
    };
}

function blockedDecision(
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    ledgerSource: RecordSourceRefreshLedgerSourceFields,
    identity: RecordSourceRefreshIdentity,
    candidateState: Exclude<CandidateState, "Fresh" | "Stale">,
    reason: string,
    reread: RecordSourceRefreshReread | null,
): RecordSourceRefreshDecision {
    return {
        version: RECORD_SOURCE_REFRESH_COORDINATOR_VERSION,
        commitAllowed: false,
        candidateState,
        reason,
        sourceSnapshot,
        reread,
        ledgerSource,
        ledgerCommit: null,
        conversationState: conversationStateFields(
            sourceSnapshot,
            identity,
            candidateState,
            reread?.kind === "current" ? reread.currentRevision : null,
            reread?.kind === "current" ? reread.contentHash : null,
            null,
            null,
        ),
        refreshPersistence: null,
    };
}

function conversationStateFields(
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    identity: RecordSourceRefreshIdentity,
    candidateState: CandidateState,
    observedSourceRevision: string | null,
    observedContentHash: string | null,
    recordCoveredRevision: string | null,
    pendingRefreshKey: string | null,
): RecordSourceRefreshConversationStateFields {
    return {
        identity,
        candidateState,
        sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
        sourceRevision: sourceSnapshot.sourceRevision,
        observedSourceRevision,
        observedContentHash,
        recordCoveredRevision,
        pendingRefreshKey,
        contentHash: sourceSnapshot.contentHash,
        contentRef: sourceSnapshot.contentRef,
    };
}

function sourceFields(sourceSnapshot: ImmutableRecordSourceSnapshot): RecordSourceRefreshLedgerSourceFields {
    return {
        sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
        sourceRevision: sourceSnapshot.sourceRevision,
        desiredRevision: sourceSnapshot.desiredRevision,
        contentHash: sourceSnapshot.contentHash,
        contentRef: sourceSnapshot.contentRef,
    };
}

function sourceIdentity(sourceSnapshot: ImmutableRecordSourceSnapshot): RecordSourceRefreshIdentity {
    return {
        chain: sourceSnapshot.chain,
        workspaceHash: sourceSnapshot.workspaceHash,
        conversationId: sourceSnapshot.conversationId,
    };
}

function freezeSnapshot(snapshot: Readonly<RecordSourceSnapshot>): ImmutableRecordSourceSnapshot {
    const snapshotRef = Object.freeze({ ...snapshot.snapshotRef });
    const contentRef = Object.freeze({ ...snapshot.contentRef });
    const readRange = Object.freeze({ ...snapshot.readRange });
    const gaps = Object.freeze([...snapshot.gaps]);
    const parseWarnings = Object.freeze([...snapshot.parseWarnings]);
    return Object.freeze({ ...snapshot, snapshotRef, contentRef, readRange, gaps, parseWarnings });
}

function freezeRootBinding(rootBinding: RecordSourceRefreshRootBinding): RecordSourceRefreshRootBinding {
    return Object.freeze({ ...rootBinding });
}

function freezeSchedulerLedgerCas(
    schedulerLedgerCas: RecordSourceRefreshSchedulerLedgerCasBarrier | undefined,
): RecordSourceRefreshSchedulerLedgerCasBarrier | undefined {
    return schedulerLedgerCas === undefined ? undefined : Object.freeze({ ...schedulerLedgerCas });
}

function isCommitEligibleSnapshot(snapshot: ImmutableRecordSourceSnapshot): boolean {
    return isNonEmptyString(snapshot.sourceSnapshotId)
        && isNonEmptyString(snapshot.chain)
        && isNonEmptyString(snapshot.workspaceHash)
        && isNonEmptyString(snapshot.conversationId)
        && isNonEmptyString(snapshot.sourceRevision)
        && snapshot.sourceRevision === snapshot.desiredRevision
        && isOptionalSafeRevisionSequence(snapshot.sourceRevisionSequence)
        && isNonEmptyString(snapshot.contentHash)
        && isValidBlobReference(snapshot.contentRef)
        && snapshot.contentRef.hash === snapshot.contentHash
        && snapshot.complete
        && snapshot.gaps.length === 0
        && snapshot.parseWarnings.length === 0
        && snapshot.readRange.startRound <= 1
        && snapshot.readRange.endRound >= snapshot.readRange.totalRounds;
}

function isAuthoritativeCurrentReread(reread: RecordSourceRefreshCurrentReread): boolean {
    if (!isNonEmptyString(reread.currentRevision)
        || !isNonEmptyString(reread.contentHash)
        || !reread.complete
        || reread.partial
        || !reread.cacheBypassed
        || reread.errors.length > 0
        || !isOptionalSafeRevisionSequence(reread.currentRevisionSequence)) return false;
    if (reread.contentEvidence.authority === "independent-content-hash") {
        return reread.contentEvidence.verified === true;
    }
    return reread.contentEvidence.verified === true
        && reread.contentEvidence.revisionContentHash === reread.contentHash
        && reread.currentRevision === reread.contentHash;
}

function isWellFormedReread(value: unknown): value is RecordSourceRefreshReread {
    if (!isObject(value)) return false;
    if (!isWellFormedIdentity(value.identity)
        || typeof value.complete !== "boolean"
        || typeof value.partial !== "boolean"
        || typeof value.cacheBypassed !== "boolean"
        || !Array.isArray(value.errors)
        || !value.errors.every(isNonEmptyString)) return false;
    if (value.kind === "current") {
        return isNonEmptyString(value.currentRevision)
            && isNonEmptyString(value.contentHash)
            && isOptionalSafeRevisionSequence(value.currentRevisionSequence)
            && isWellFormedContentEvidence(value.contentEvidence);
    }
    return value.kind === "lost" || value.kind === "conflict" || value.kind === "unresolved";
}

function isOptionalSafeRevisionSequence(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isWellFormedContentEvidence(value: unknown): value is RecordSourceRefreshContentEvidence {
    if (!isObject(value) || value.verified !== true) return false;
    if (value.authority === "independent-content-hash") return true;
    return value.authority === "content-addressed-revision" && isNonEmptyString(value.revisionContentHash);
}

function isValidEnsureResult(
    value: unknown,
    refreshKey: string,
    identity: RecordSourceRefreshIdentity,
    persistenceRoot: RecordSourceRefreshRootBinding,
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    recordWorkKey: string,
    desiredRevision: string,
    schedulerLedgerCas: RecordSourceRefreshSchedulerLedgerCasBarrier | undefined,
): value is RecordSourceRefreshEnsureResult {
    if (!isObject(value) || (value.disposition !== "created" && value.disposition !== "attached")) return false;
    if (!isValidPendingRefresh(value.pendingRefresh, refreshKey, identity, sourceSnapshot, recordWorkKey, desiredRevision)) return false;
    return isValidDurabilityReceipt(
        value.durabilityReceipt,
        value.pendingRefresh,
        refreshKey,
        persistenceRoot,
        schedulerLedgerCas,
    );
}

function isValidDurabilityReceipt(
    value: unknown,
    pendingRefresh: PendingRefreshReference,
    refreshKey: string,
    persistenceRoot: RecordSourceRefreshRootBinding,
    schedulerLedgerCas: RecordSourceRefreshSchedulerLedgerCasBarrier | undefined,
): value is RecordSourceRefreshDurabilityReceipt {
    if (!isObject(value)
        || value.version !== RECORD_SOURCE_REFRESH_RECEIPT_VERSION
        || value.refreshKey !== refreshKey
        || !sameRootBinding(value.rootBinding, persistenceRoot)
        || !isObject(value.ledger)
        || !Number.isInteger(value.ledger.revision)
        || (value.ledger.revision as number) <= 0
        || !isValidBlobReference(value.ledger.ref)
        || !isNonEmptyString(value.ledger.persistedHash)
        || value.ledger.ref.hash !== value.ledger.persistedHash
        || value.ledger.revision !== pendingRefresh.ledgerRevision
        || !sameBlobReference(value.ledger.ref, pendingRefresh.ledgerRef)
        || value.refreshRecordHash !== createPendingRefreshRecordHash(pendingRefresh)
        || !isValidWriteDurabilityReceipt(value.durability)
        || !isValidCasReceipt(value.cas, value.ledger.revision as number, schedulerLedgerCas)) return false;
    return true;
}

function isValidWriteDurabilityReceipt(value: unknown): value is RecordSourceRefreshWriteDurabilityReceipt {
    return isObject(value)
        && value.scope === "process-crash-hot-restart"
        && value.temporaryFileSynced === true
        && value.atomicReplaceCompleted === true
        && value.targetFileSynced === true
        && isObject(value.parentDirectory)
        && (value.parentDirectory.method === "directory-fsync" || value.parentDirectory.method === "windows-target-file-flush")
        && value.parentDirectory.durableBarrierCompleted === true;
}

function isValidCasReceipt(
    value: unknown,
    ledgerRevision: number,
    schedulerLedgerCas: RecordSourceRefreshSchedulerLedgerCasBarrier | undefined,
): value is RecordSourceRefreshCasReceipt {
    if (!isObject(value)
        || !isNonEmptyString(value.ledgerId)
        || !Number.isInteger(value.expectedRevision)
        || (value.expectedRevision as number) < 0
        || !Number.isInteger(value.committedRevision)
        || (value.committedRevision as number) <= (value.expectedRevision as number)
        || value.committedRevision !== ledgerRevision
        || !isNonEmptyString(value.transactionId)) return false;
    if (schedulerLedgerCas === undefined) return value.scope === "refresh-ledger";
    return value.scope === "scheduler-ledger"
        && value.ledgerId === schedulerLedgerCas.ledgerId
        && value.expectedRevision === schedulerLedgerCas.expectedRevision
        && value.commitId === schedulerLedgerCas.commitId
        && value.commitSourceFieldsIncluded === true;
}

function isValidVerifiedReadBack(
    value: unknown,
    ensured: RecordSourceRefreshEnsureResult,
    refreshKey: string,
    identity: RecordSourceRefreshIdentity,
    persistenceRoot: RecordSourceRefreshRootBinding,
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    recordWorkKey: string,
    desiredRevision: string,
    schedulerLedgerCas: RecordSourceRefreshSchedulerLedgerCasBarrier | undefined,
): value is RecordSourceRefreshVerifiedReadBack {
    if (!isObject(value)
        || value.kind !== "verified"
        || value.readFrom !== "durable-storage"
        || value.refreshKey !== refreshKey
        || !sameRootBinding(value.rootBinding, persistenceRoot)
        || !isValidPendingRefresh(value.pendingRefresh, refreshKey, identity, sourceSnapshot, recordWorkKey, desiredRevision)
        || !samePendingRefresh(value.pendingRefresh, ensured.pendingRefresh)
        || !isValidDurabilityReceipt(value.durabilityReceipt, value.pendingRefresh, refreshKey, persistenceRoot, schedulerLedgerCas)
        || !sameCanonicalValue(value.durabilityReceipt, ensured.durabilityReceipt)
        || !isObject(value.ledger)
        || value.ledger.revision !== ensured.durabilityReceipt.ledger.revision
        || value.ledger.persistedHash !== ensured.durabilityReceipt.ledger.persistedHash
        || !sameBlobReference(value.ledger.ref, ensured.durabilityReceipt.ledger.ref)
        || value.refreshRecordHash !== ensured.durabilityReceipt.refreshRecordHash
        || value.refreshRecordHash !== createPendingRefreshRecordHash(value.pendingRefresh)
        || !Number.isFinite(Date.parse(String(value.observedAt)))) return false;
    return true;
}

function isValidPendingRefresh(
    value: unknown,
    refreshKey: string,
    identity: RecordSourceRefreshIdentity,
    sourceSnapshot: ImmutableRecordSourceSnapshot,
    recordWorkKey: string,
    desiredRevision: string,
): value is PendingRefreshReference {
    if (!isObject(value)) return false;
    return value.refreshKey === refreshKey
        && value.sourceSnapshotId === sourceSnapshot.sourceSnapshotId
        && value.recordWorkKey === recordWorkKey
        && value.chain === identity.chain
        && value.workspaceHash === identity.workspaceHash
        && value.conversationId === identity.conversationId
        && value.fromRevision === sourceSnapshot.desiredRevision
        && value.desiredRevision === desiredRevision
        && isNonEmptyString(value.refreshTaskId)
        && Number.isInteger(value.ledgerRevision)
        && (value.ledgerRevision as number) > 0
        && isValidBlobReference(value.ledgerRef)
        && (value.state === "Queued" || value.state === "Running")
        && Number.isFinite(Date.parse(String(value.persistedAt)));
}

function isValidRootBinding(value: unknown): value is RecordSourceRefreshRootBinding {
    return isObject(value)
        && isNonEmptyString(value.dataRootId)
        && isSha256(value.rootPathHash);
}

function isValidSchedulerLedgerCasBarrier(value: unknown): value is RecordSourceRefreshSchedulerLedgerCasBarrier {
    return isObject(value)
        && value.mode === "scheduler-ledger-cas"
        && isNonEmptyString(value.ledgerId)
        && Number.isInteger(value.expectedRevision)
        && (value.expectedRevision as number) >= 0
        && isNonEmptyString(value.commitId);
}

function sameIdentity(left: RecordSourceRefreshIdentity, right: RecordSourceRefreshIdentity): boolean {
    return left.chain === right.chain
        && left.workspaceHash === right.workspaceHash
        && left.conversationId === right.conversationId;
}

function sameRootBinding(left: unknown, right: RecordSourceRefreshRootBinding): boolean {
    return isObject(left)
        && left.dataRootId === right.dataRootId
        && left.rootPathHash === right.rootPathHash;
}

function sameBlobReference(left: unknown, right: Readonly<ImmutableBlobReference>): boolean {
    return isObject(left)
        && left.path === right.path
        && left.hash === right.hash
        && left.byteLength === right.byteLength;
}

function samePendingRefresh(left: unknown, right: PendingRefreshReference): boolean {
    return isObject(left)
        && left.refreshKey === right.refreshKey
        && left.refreshTaskId === right.refreshTaskId
        && left.sourceSnapshotId === right.sourceSnapshotId
        && left.recordWorkKey === right.recordWorkKey
        && left.chain === right.chain
        && left.workspaceHash === right.workspaceHash
        && left.conversationId === right.conversationId
        && left.fromRevision === right.fromRevision
        && left.desiredRevision === right.desiredRevision
        && left.persistedAt === right.persistedAt
        && left.ledgerRevision === right.ledgerRevision
        && sameBlobReference(left.ledgerRef, right.ledgerRef)
        && left.state === right.state;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
    try {
        return canonicalSerialize(left) === canonicalSerialize(right);
    } catch {
        return false;
    }
}

function isWellFormedIdentity(value: unknown): value is RecordSourceRefreshIdentity {
    return isObject(value)
        && isNonEmptyString(value.chain)
        && isNonEmptyString(value.workspaceHash)
        && isNonEmptyString(value.conversationId);
}

function isValidBlobReference(value: unknown): value is ImmutableBlobReference {
    return isObject(value)
        && isNonEmptyString(value.path)
        && isNonEmptyString(value.hash)
        && Number.isFinite(value.byteLength)
        && (value.byteLength as number) >= 0;
}

function canonicalSerialize(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("canonical hash 不接受非有限数字");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
    if (isObject(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(",")}}`;
    }
    throw new TypeError("canonical hash 不接受 unsupported value");
}

function sha256(value: string): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
