import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
    CandidateSnapshotSchema,
    buildRecordIndexEntry,
    buildRecordIndexScope,
    createRecordSourceSnapshot,
    discoverRecordCandidates,
    LOST_RECHECK_INTERVAL_MS,
    RecordSourceSnapshotSchema,
    type RecordSourceIdentity,
    recordDiscoveryCandidateId,
    selectRecordDiscoveryCandidates,
} from "../src/record-discovery.js";
import {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildLostObservation,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
    canonicalSourceIdentityKey,
    type SourceEvidenceHost,
} from "../src/source-evidence-contracts.js";

const alpha = "C:/fixtures/alpha";
const beta = "C:/fixtures/beta";
const baseTimeMs = Date.parse("2026-07-13T00:00:00.000Z");

function hash(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function contentHash(content: string): string {
    return `sha256:${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}`;
}

function trimTrailingSeparators(value: string): string {
    return value.replace(/[\\/]+$/, "");
}

function source(
    host: SourceEvidenceHost,
    workspace: string,
    conversationId: string,
    workspaceId = workspace,
): RecordSourceIdentity {
    const root = trimTrailingSeparators(workspace);
    const separator = workspace.includes("\\") ? "\\" : "/";
    return {
        host,
        identity: {
            workspace: { workspaceId, canonicalPath: workspace },
            source: {
                kind: "filesystem",
                authority: `${root}${separator}authority`,
                authoritativeRoot: `${root}${separator}authority`,
                canonicalPath: `${root}${separator}store`,
            },
            conversationId,
        },
    };
}

function observation(scanId: string, sequence: number, completedAtMs = baseTimeMs + sequence * 1000) {
    return {
        scanId,
        sequence,
        startedAt: new Date(completedAtMs - 100).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
    };
}

function enumeration(
    sourceIdentity: RecordSourceIdentity,
    revision: string,
    revisionSequence: number | null,
    options: {
        scanId?: string;
        observationSequence?: number;
        completedAtMs?: number;
        targetStatus?: "present" | "absent" | "unknown";
        complete?: boolean;
        cacheBypassed?: boolean;
        error?: boolean;
        paginationComplete?: boolean;
    } = {},
) {
    const targetStatus = options.targetStatus || "present";
    const complete = options.complete ?? true;
    const cacheBypassed = options.cacheBypassed ?? true;
    const paginationComplete = options.paginationComplete ?? true;
    const observationSequence = options.observationSequence || Math.max(1, revisionSequence || 1);
    const scanId = options.scanId || `scan-${sourceIdentity.identity.conversationId}-${observationSequence}`;
    const evidence = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: sourceIdentity.host,
        identity: sourceIdentity.identity,
        sourceRevision: {
            revision,
            contentCursor: `cursor-${revision}`,
            eventWatermark: `event-${revision}`,
            sequence: revisionSequence,
        },
        pagination: {
            cursor: paginationComplete ? null : "next-page",
            pages: 1,
            limit: null,
            truncated: !paginationComplete,
        },
        enumerationComplete: complete,
        cacheBypassed,
        exactFetchResult: targetStatus === "present" ? "present" : targetStatus === "absent" ? "not_found" : "unresolved",
        errors: options.error ? [{ code: "source_unavailable", message: "fixture source unavailable" }] : [],
        warnings: [],
        observedAt: observation(scanId, observationSequence, options.completedAtMs),
        targetStatus,
    });
    return { evidence, revisionSequence, title: sourceIdentity.identity.conversationId };
}

function absence(
    sourceIdentity: RecordSourceIdentity,
    scanId: string,
    observationSequence: number,
    completedAtMs: number,
    confirmation: "tombstone" | "stable_exact_not_found" | "absence_recheck",
) {
    const envelope = enumeration(sourceIdentity, `absent-${scanId}`, null, {
        scanId,
        observationSequence,
        completedAtMs,
        targetStatus: "absent",
    });
    const exactFetch = buildExactFetchEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: sourceIdentity.host,
        identity: sourceIdentity.identity,
        sourceRevision: envelope.evidence.sourceRevision,
        pagination: envelope.evidence.pagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: envelope.evidence.observedAt,
    });
    const evidence = buildLostObservation({ enumeration: envelope.evidence, exactFetch });
    return {
        envelope: { ...envelope, exactFetch },
        observation: {
            confirmation,
            evidence,
            observedAtMs: completedAtMs,
        },
    };
}

function indexScope(sourceIdentity: RecordSourceIdentity, options: {
    snapshotId?: string;
    revision?: string;
    complete?: boolean;
    paginationComplete?: boolean;
    error?: boolean;
} = {}) {
    return buildRecordIndexScope({
        workspace: sourceIdentity.identity.workspace,
        snapshotId: options.snapshotId || "index-alpha",
        indexRevision: options.revision || "index-rev-1",
        complete: options.complete ?? true,
        paginationComplete: options.paginationComplete ?? true,
        error: options.error ? { code: "index-read-failed", message: "fixture index failed" } : null,
        extensions: {},
    });
}

function recordEntry(
    recordId: string,
    sourceIdentity: RecordSourceIdentity,
    coveredRevision: { revision: string; sequence: number | null } | null,
    options: { snapshotId?: string; indexRevision?: string; recordBodyHash?: string } = {},
) {
    return buildRecordIndexEntry({
        recordId,
        source: sourceIdentity,
        indexSnapshotId: options.snapshotId || "index-alpha",
        indexRevision: options.indexRevision || "index-rev-1",
        coveredRevision,
        recordBodyHash: options.recordBodyHash || hash({ recordId }),
        extensions: {},
    });
}

const freshSource = source("codex", alpha, "fresh");
const staleSource = source("codex", alpha, "stale");
const missingSource = source("antigravity", alpha, "missing");
const legacyCoveredRevisionSource = source("codex", alpha, "legacy-covered-revision");
const unknownOrderSource = source("claude-code", alpha, "unknown-order");
const olderSource = source("windsurf", alpha, "source-older");
const cacheSource = source("codex", alpha, "cache-false");
const duplicateRecordSource = source("codex", alpha, "duplicate-record-conflict");
const mixedEnumerationSource = source("windsurf", alpha, "complete-incomplete");
const indexOnlySource = source("claude-code", alpha, "index-only");
const twoRecordsSource = source("antigravity", alpha, "two-records");
const sharedCodexSource = source("codex", alpha, "shared-record-codex");
const sharedWindsurfSource = source("windsurf", alpha, "shared-record-windsurf");
const lostSource = source("windsurf", alpha, "lost");
const directLost = absence(lostSource, "lost-direct", 100, baseTimeMs + 100_000, "stable_exact_not_found");

const primaryInput = {
    request: {
        snapshotId: "snapshot-primary",
        discoveredAtSequence: 500,
        filters: { hosts: [], workspace: null, extensions: {} },
    },
    sourceEnumerations: [
        enumeration(freshSource, "rev-2", 2),
        enumeration(staleSource, "rev-3", 3),
        enumeration(missingSource, "rev-1", 1),
        enumeration(legacyCoveredRevisionSource, "rev-legacy", 5),
        enumeration(unknownOrderSource, "rev-current", null),
        enumeration(olderSource, "rev-1", 1),
        enumeration(cacheSource, "rev-cache", 4, { cacheBypassed: false }),
        enumeration(duplicateRecordSource, "rev-3", 3),
        enumeration(mixedEnumerationSource, "rev-4", 4, { scanId: "mixed", observationSequence: 40 }),
        enumeration(mixedEnumerationSource, "rev-4", 4, { scanId: "mixed", observationSequence: 40, complete: false }),
        enumeration(twoRecordsSource, "rev-2", 2),
        enumeration(sharedCodexSource, "rev-2", 2),
        enumeration(sharedWindsurfSource, "rev-2", 2),
        directLost.envelope,
    ],
    recordIndex: {
        scopes: [indexScope(freshSource)],
        entries: [
            recordEntry("record-fresh", freshSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-stale", staleSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-legacy-covered-revision", legacyCoveredRevisionSource, null),
            recordEntry("record-unknown", unknownOrderSource, { revision: "rev-old", sequence: 1 }),
            recordEntry("record-older", olderSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-duplicate", duplicateRecordSource, { revision: "rev-1", sequence: 1 }),
            recordEntry("record-duplicate", duplicateRecordSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-index-only", indexOnlySource, { revision: "rev-old", sequence: 1 }),
            recordEntry("record-two-a", twoRecordsSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-two-b", twoRecordsSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-shared", sharedCodexSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-shared", sharedWindsurfSource, { revision: "rev-2", sequence: 2 }),
            recordEntry("record-lost", lostSource, { revision: "rev-old", sequence: 1 }),
        ],
    },
    absenceObservations: [directLost.observation],
};

const snapshot = discoverRecordCandidates(primaryInput);
const byConversation = new Map(snapshot.candidates.map(candidate => [candidate.source.identity.conversationId, candidate]));
const persistedLostExact = snapshot.sourceEnumerations.find(item => item.evidence.identity.conversationId === "lost")?.exactFetch;
assert.equal(persistedLostExact?.evidenceHash, directLost.envelope.exactFetch.evidenceHash, "exact fetch diagnostics must survive immutable snapshot round-trip");

assert.equal(byConversation.get("fresh")?.classification, "Fresh");
assert.equal(byConversation.get("stale")?.classification, "Stale");
assert.equal(byConversation.get("missing")?.classification, "Missing");
assert.equal(byConversation.get("legacy-covered-revision")?.classification, "Unresolved");
assert.equal(byConversation.get("legacy-covered-revision")?.classificationReason.code, "record-covered-revision-missing");
assert.equal(byConversation.get("unknown-order")?.classification, "Unresolved", "unknown revision order must not become Stale");
assert.equal(byConversation.get("source-older")?.classification, "Unresolved", "older source revision must not become Stale");
assert.equal(byConversation.get("cache-false")?.classification, "Unresolved", "cacheBypassed=false must be Unresolved");
assert.equal(byConversation.get("duplicate-record-conflict")?.classification, "Conflict", "duplicate same record conflicting revision");
assert.equal(byConversation.get("complete-incomplete")?.classification, "Unresolved", "complete+incomplete must not use the complete observation alone");
assert.equal(byConversation.get("index-only")?.classification, "Unresolved");
assert.equal(byConversation.get("two-records")?.classification, "Conflict");
assert.equal(byConversation.get("shared-record-codex")?.classification, "Conflict");
assert.equal(byConversation.get("shared-record-windsurf")?.classification, "Conflict");
assert.equal(byConversation.get("lost")?.classification, "Lost");
assert.equal(byConversation.get("lost")?.classificationReason.code, "lost-strong-absence");
assert.equal(byConversation.get("lost")?.candidateId, recordDiscoveryCandidateId(lostSource));

const sameRevisionSequenceDriftSource = source("codex", alpha, "same-revision-sequence-drift");
const differentRevisionSameSequenceSource = source("codex", alpha, "different-revision-same-sequence");
const revisionIdentitySnapshot = discoverRecordCandidates({
    request: { snapshotId: "revision-identity", discoveredAtSequence: 501, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [
        enumeration(sameRevisionSequenceDriftSource, "content-hash-a", 9),
        enumeration(differentRevisionSameSequenceSource, "content-hash-new", 7),
    ],
    recordIndex: {
        scopes: [indexScope(sameRevisionSequenceDriftSource), indexScope(differentRevisionSameSequenceSource)],
        entries: [
            recordEntry("record-same-revision-sequence-drift", sameRevisionSequenceDriftSource, { revision: "content-hash-a", sequence: 3 }),
            recordEntry("record-different-revision-same-sequence", differentRevisionSameSequenceSource, { revision: "content-hash-old", sequence: 7 }),
        ],
    },
    absenceObservations: [],
});
const revisionIdentityByConversation = new Map(revisionIdentitySnapshot.candidates.map(candidate => [candidate.source.identity.conversationId, candidate]));
assert.equal(
    revisionIdentityByConversation.get("same-revision-sequence-drift")?.classification,
    "Fresh",
    "identical content revision remains Fresh when only the auxiliary ordering sequence drifts",
);
assert.equal(
    revisionIdentityByConversation.get("different-revision-same-sequence")?.classification,
    "Conflict",
    "different content revisions at the same authoritative sequence remain conflicting",
);

const normal = selectRecordDiscoveryCandidates(snapshot, "normal");
assert.deepEqual(new Set(normal.map(candidate => candidate.source.identity.conversationId)), new Set(["stale", "missing"]));
const staleOnly = selectRecordDiscoveryCandidates(snapshot, "stale_only");
assert.deepEqual(staleOnly.map(candidate => candidate.source.identity.conversationId), ["stale"]);
const forced = selectRecordDiscoveryCandidates(snapshot, "force");
assert.deepEqual(
    new Set(forced.map(candidate => candidate.source.identity.conversationId)),
    new Set(["fresh", "stale", "missing", "legacy-covered-revision"]),
);

const forged = JSON.parse(JSON.stringify(snapshot));
const forgedCandidate = forged.candidates.find((candidate: { source: RecordSourceIdentity }) => candidate.source.identity.conversationId === "missing");
forgedCandidate.classification = "Unresolved";
forgedCandidate.safeToProcess = true;
const { evidenceHash: _candidateHash, ...forgedCandidatePayload } = forgedCandidate;
forgedCandidate.evidenceHash = hash(forgedCandidatePayload);
const { snapshotHash: _snapshotHash, ...forgedSnapshotPayload } = forged;
forged.snapshotHash = hash(forgedSnapshotPayload);
assert.throws(
    () => selectRecordDiscoveryCandidates(forged, "force"),
    /discovery invariants/,
    "FORGED_UNRESOLVED_FORCE",
);

const lostWithoutEnumeration = discoverRecordCandidates({
    ...primaryInput,
    request: { ...primaryInput.request, snapshotId: "lost-without-enumeration" },
    sourceEnumerations: primaryInput.sourceEnumerations.filter(item => item.evidence.evidenceHash !== directLost.envelope.evidence.evidenceHash),
});
assert.equal(
    lostWithoutEnumeration.candidates.find(candidate => candidate.source.identity.conversationId === "lost")?.classification,
    "Unresolved",
    "LOST_WITHOUT_ENUMERATION",
);

const closeAbsenceSource = source("codex", beta, "close-absences");
const closeFirst = absence(closeAbsenceSource, "close-a", 1, baseTimeMs, "absence_recheck");
const closeSecond = absence(closeAbsenceSource, "close-b", 2, baseTimeMs + 1, "absence_recheck");
const closeScope = indexScope(closeAbsenceSource, { snapshotId: "index-beta", revision: "index-beta-1" });
const closeAbsenceSnapshot = discoverRecordCandidates({
    request: { snapshotId: "close-absence", discoveredAtSequence: 10, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [closeFirst.envelope, closeSecond.envelope],
    recordIndex: {
        scopes: [closeScope],
        entries: [recordEntry("record-close", closeAbsenceSource, { revision: "old", sequence: 1 }, {
            snapshotId: "index-beta",
            indexRevision: "index-beta-1",
        })],
    },
    absenceObservations: [closeFirst.observation, closeSecond.observation],
});
assert.equal(closeAbsenceSnapshot.candidates[0]?.classification, "Unresolved", "TWO_ABSENCES_ONE_SEQUENCE_APART");

const spacedSecond = absence(closeAbsenceSource, "spaced-b", 3, baseTimeMs + LOST_RECHECK_INTERVAL_MS, "absence_recheck");
const spacedSnapshot = discoverRecordCandidates({
    request: { snapshotId: "spaced-absence", discoveredAtSequence: 11, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [closeFirst.envelope, spacedSecond.envelope],
    recordIndex: closeAbsenceSnapshot.recordIndex,
    absenceObservations: [closeFirst.observation, spacedSecond.observation],
});
assert.equal(spacedSnapshot.candidates[0]?.classification, "Lost");

const unreliableScopeSnapshot = discoverRecordCandidates({
    request: { snapshotId: "scope-conflict", discoveredAtSequence: 12, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [enumeration(missingSource, "rev-1", 1)],
    recordIndex: {
        scopes: [
            indexScope(missingSource, { snapshotId: "scope-complete", complete: true }),
            indexScope(missingSource, { snapshotId: "scope-incomplete", complete: false }),
        ],
        entries: [],
    },
    absenceObservations: [],
});
assert.equal(unreliableScopeSnapshot.candidates[0]?.classification, "Unresolved", "complete+incomplete index scope must not become Missing");

const decomposedWorkspace = "C:\\work\\cafe\u0301\\";
const decomposedConversation = "thread-e\u0301";
const composedWorkspace = "c:/work/café";
const composedConversation = "thread-é";
const decomposedSource = source("codex", decomposedWorkspace, decomposedConversation, "workspace-e\u0301");
const composedSource = source("codex", composedWorkspace, composedConversation, "workspace-é");
const canonicalSnapshot = discoverRecordCandidates({
    request: { snapshotId: "canonical-paths", discoveredAtSequence: 13, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [enumeration(decomposedSource, "rev-canonical", 9)],
    recordIndex: {
        scopes: [indexScope(composedSource, { snapshotId: "canonical-index", revision: "canonical-r1" })],
        entries: [recordEntry("record-canonical", composedSource, { revision: "rev-canonical", sequence: 9 }, {
            snapshotId: "canonical-index",
            indexRevision: "canonical-r1",
        })],
    },
    absenceObservations: [],
});
assert.equal(canonicalSnapshot.candidates.length, 1, "path/Unicode equivalent identities must not split candidates");
assert.equal(canonicalSnapshot.candidates[0]?.classification, "Fresh");
assert.equal(recordDiscoveryCandidateId(decomposedSource), recordDiscoveryCandidateId(composedSource));
assert.equal(canonicalSnapshot.candidates[0]?.candidateId, recordDiscoveryCandidateId(decomposedSource));

const canonicalCaseSource = source("codex", "C:\\Canonical\\Workspace\\", "canonical-entry", "workspace-canonical-entry");
const canonicalCaseVariant = source("codex", "c:/canonical/Workspace", "canonical-entry", "workspace-canonical-entry");
assert.equal(recordDiscoveryCandidateId(canonicalCaseSource), `candidate:${canonicalSourceIdentityKey(canonicalCaseSource)}`);
assert.equal(recordDiscoveryCandidateId(canonicalCaseVariant), `candidate:${canonicalSourceIdentityKey(canonicalCaseVariant)}`);
assert.notEqual(
    recordDiscoveryCandidateId(canonicalCaseSource),
    recordDiscoveryCandidateId(canonicalCaseVariant),
    "discovery and source-evidence must share the same component-case-sensitive Windows canonical key",
);

const sharedPathSource = source("codex", "C:/fixtures/shared-workspace", "cross-workspace", "workspace-a");
const sharedPathIndex = source("codex", "c:\\fixtures\\shared-workspace\\", "cross-workspace", "workspace-b");
const crossWorkspaceSnapshot = discoverRecordCandidates({
    request: { snapshotId: "cross-workspace-id", discoveredAtSequence: 14, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [enumeration(sharedPathSource, "rev-cross", 5)],
    recordIndex: {
        scopes: [indexScope(sharedPathIndex, { snapshotId: "cross-index", revision: "cross-r1" })],
        entries: [recordEntry("record-cross", sharedPathIndex, { revision: "rev-cross", sequence: 5 }, {
            snapshotId: "cross-index",
            indexRevision: "cross-r1",
        })],
    },
    absenceObservations: [],
});
assert.equal(crossWorkspaceSnapshot.candidates.length, 2, "same path with different workspaceId must remain separate candidates");
assert.ok(crossWorkspaceSnapshot.candidates.every(candidate => candidate.classification !== "Fresh"), "different workspaceId must never cross-bind as Fresh");
assert.notEqual(recordDiscoveryCandidateId(sharedPathSource), recordDiscoveryCandidateId(sharedPathIndex));
assert.deepEqual(
    new Set(crossWorkspaceSnapshot.candidates.map(candidate => candidate.candidateId)),
    new Set([recordDiscoveryCandidateId(sharedPathSource), recordDiscoveryCandidateId(sharedPathIndex)]),
);

const crossWorkspaceAbsence = absence(sharedPathSource, "cross-workspace-absence", 16, baseTimeMs + 16_000, "stable_exact_not_found");
const crossWorkspaceAbsenceSnapshot = discoverRecordCandidates({
    request: { snapshotId: "cross-workspace-absence", discoveredAtSequence: 16, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [crossWorkspaceAbsence.envelope],
    recordIndex: {
        scopes: [indexScope(sharedPathIndex, { snapshotId: "cross-absence-index", revision: "cross-absence-r1" })],
        entries: [recordEntry("record-cross-absence", sharedPathIndex, { revision: "rev-old", sequence: 1 }, {
            snapshotId: "cross-absence-index",
            indexRevision: "cross-absence-r1",
        })],
    },
    absenceObservations: [crossWorkspaceAbsence.observation],
});
assert.equal(crossWorkspaceAbsenceSnapshot.candidates.length, 1);
assert.equal(crossWorkspaceAbsenceSnapshot.candidates[0]?.candidateId, recordDiscoveryCandidateId(sharedPathIndex));
assert.equal(crossWorkspaceAbsenceSnapshot.candidates[0]?.classification, "Unresolved", "absence from another workspaceId must not bind as Lost");

const firstWorkspacePath = source("codex", "C:/fixtures/workspace-path-a", "workspace-path-conflict", "workspace-shared");
const secondWorkspacePath = source("codex", "C:/fixtures/workspace-path-b", "workspace-path-conflict", "workspace-shared");
const workspacePathConflictSnapshot = discoverRecordCandidates({
    request: { snapshotId: "workspace-path-conflict", discoveredAtSequence: 15, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [enumeration(firstWorkspacePath, "rev-path", 6)],
    recordIndex: {
        scopes: [indexScope(secondWorkspacePath, { snapshotId: "path-index", revision: "path-r1" })],
        entries: [recordEntry("record-path", secondWorkspacePath, { revision: "rev-path", sequence: 6 }, {
            snapshotId: "path-index",
            indexRevision: "path-r1",
        })],
    },
    absenceObservations: [],
});
assert.equal(workspacePathConflictSnapshot.candidates.length, 2, "same workspaceId with different real paths must not merge");
assert.ok(workspacePathConflictSnapshot.candidates.every(candidate => candidate.classification === "Conflict"));
assert.ok(workspacePathConflictSnapshot.candidates.every(candidate => candidate.classificationReason.code === "workspace-identity-conflict"));

const sourceStoreA = source("codex", "C:/fixtures/source-store-conflict", "source-store-conflict", "workspace-source-store");
const sourceStoreB: RecordSourceIdentity = {
    host: sourceStoreA.host,
    identity: {
        ...sourceStoreA.identity,
        source: {
            kind: "filesystem",
            authority: "C:/fixtures/source-store-conflict/store-b-authority",
            authoritativeRoot: "C:/fixtures/source-store-conflict/store-b-root",
            canonicalPath: "C:/fixtures/source-store-conflict/store-b",
        },
    },
};
const sourceStoreConflictSnapshot = discoverRecordCandidates({
    request: { snapshotId: "source-store-conflict", discoveredAtSequence: 17, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [enumeration(sourceStoreA, "rev-source-store", 7)],
    recordIndex: {
        scopes: [indexScope(sourceStoreB, { snapshotId: "source-store-index", revision: "source-store-r1" })],
        entries: [recordEntry("record-source-store", sourceStoreB, { revision: "rev-source-store", sequence: 7 }, {
            snapshotId: "source-store-index",
            indexRevision: "source-store-r1",
        })],
    },
    absenceObservations: [],
});
assert.equal(sourceStoreConflictSnapshot.candidates.length, 2);
assert.ok(sourceStoreConflictSnapshot.candidates.every(candidate => candidate.classification === "Conflict"));
assert.ok(sourceStoreConflictSnapshot.candidates.every(candidate => candidate.classificationReason.code === "source-identity-conflict"));
assert.equal(selectRecordDiscoveryCandidates(sourceStoreConflictSnapshot, "normal").length, 0, "conflicting source stores must fail closed before Missing selection");
assert.notEqual(
    recordDiscoveryCandidateId(source("codex", "C:/fixtures/a", "b|c")),
    recordDiscoveryCandidateId(source("codex", "C:/fixtures/a|b", "c")),
    "malicious separators must not collide",
);

const rebuiltInput = JSON.parse(JSON.stringify(primaryInput));
rebuiltInput.sourceEnumerations.reverse();
rebuiltInput.recordIndex.scopes.reverse();
rebuiltInput.recordIndex.entries.reverse();
rebuiltInput.absenceObservations.reverse();
assert.deepEqual(discoverRecordCandidates(rebuiltInput), snapshot, "stable rebuild must ignore input order");
assert.ok(Object.isFrozen(snapshot));
assert.ok(Object.isFrozen(snapshot.candidates));
assert.equal(CandidateSnapshotSchema.safeParse({ ...snapshot, unexpected: true }).success, false);

const tamperedEvidenceInput = JSON.parse(JSON.stringify(primaryInput));
tamperedEvidenceInput.sourceEnumerations[0].evidence.evidenceHash = hash({ forged: true });
assert.throws(() => discoverRecordCandidates(tamperedEvidenceInput), /evidenceHash|哈希/i);
const tamperedExactInput = JSON.parse(JSON.stringify(primaryInput));
const exactEnvelopeIndex = tamperedExactInput.sourceEnumerations.findIndex((item: { exactFetch?: unknown }) => item.exactFetch !== undefined);
assert.ok(exactEnvelopeIndex >= 0);
tamperedExactInput.sourceEnumerations[exactEnvelopeIndex].exactFetch.evidenceHash = hash({ forged: "exact" });
assert.throws(() => discoverRecordCandidates(tamperedExactInput), /evidenceHash|哈希/i);

const sourceContent = "完整 source 内容，喵";
const sourceContentHash = contentHash(sourceContent);
const fullReadSource = source("codex", alpha, "full-read");
function fullReadEvidenceAtSequence(sequence: number) {
    return buildFullSourceReadEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: fullReadSource.host,
        identity: fullReadSource.identity,
        sourceRevision: {
            revision: "full-rev-7",
            contentCursor: "cursor-full-7",
            eventWatermark: "event-full-7",
            sequence,
        },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: observation("full-read-scan", 700),
        content: {
            mode: "full",
            byteLength: Buffer.byteLength(sourceContent, "utf8"),
            contentHash: sourceContentHash,
            roundRange: { start: 1, end: 8 },
            truncated: false,
            staleCache: false,
        },
    });
}
const fullReadEvidence = fullReadEvidenceAtSequence(7);
const fullReadCandidateId = recordDiscoveryCandidateId(fullReadSource);
const inlineContentBinding = {
    kind: "inline" as const,
    content: sourceContent,
    byteLength: Buffer.byteLength(sourceContent, "utf8"),
    contentHash: sourceContentHash,
};
const inlineSnapshot = createRecordSourceSnapshot({
    candidateId: fullReadCandidateId,
    source: fullReadSource,
    fullSourceRead: fullReadEvidence,
    revisionSequence: 7,
    contentBinding: inlineContentBinding,
    formatterVersion: "formatter-v2",
    capturedAtSequence: 701,
});
assert.equal(inlineSnapshot.status, "accepted");
if (inlineSnapshot.status === "accepted") {
    assert.equal(inlineSnapshot.snapshot.candidateId, recordDiscoveryCandidateId(fullReadSource));
    assert.equal(inlineSnapshot.snapshot.verification.status, "inline-bytes-verified");
    assert.equal(inlineSnapshot.snapshot.desiredRevision.sequence, 7);
    const forgedSourceSnapshot = JSON.parse(JSON.stringify(inlineSnapshot.snapshot));
    forgedSourceSnapshot.desiredRevision.revision = "forged-revision";
    const { snapshotHash: _sourceSnapshotHash, ...forgedSourceSnapshotPayload } = forgedSourceSnapshot;
    forgedSourceSnapshot.snapshotHash = hash(forgedSourceSnapshotPayload);
    assert.equal(RecordSourceSnapshotSchema.safeParse(forgedSourceSnapshot).success, false);

    const forgedSequenceSnapshot = JSON.parse(JSON.stringify(inlineSnapshot.snapshot));
    forgedSequenceSnapshot.desiredRevision.sequence = 999;
    const { snapshotHash: _sequenceSnapshotHash, ...forgedSequencePayload } = forgedSequenceSnapshot;
    forgedSequenceSnapshot.snapshotHash = hash(forgedSequencePayload);
    assert.equal(RecordSourceSnapshotSchema.safeParse(forgedSequenceSnapshot).success, false, "desiredRevision.sequence drift must fail schema validation");
}

const mismatchedRevisionSequence = createRecordSourceSnapshot({
    candidateId: fullReadCandidateId,
    source: fullReadSource,
    fullSourceRead: fullReadEvidence,
    revisionSequence: 999,
    contentBinding: inlineContentBinding,
    formatterVersion: "formatter-v2",
    capturedAtSequence: 701,
});
assert.equal(mismatchedRevisionSequence.status, "rejected", "external sequence drift must be rejected");

const sequence999Snapshot = createRecordSourceSnapshot({
    candidateId: fullReadCandidateId,
    source: fullReadSource,
    fullSourceRead: fullReadEvidenceAtSequence(999),
    revisionSequence: 999,
    contentBinding: inlineContentBinding,
    formatterVersion: "formatter-v2",
    capturedAtSequence: 701,
});
assert.equal(sequence999Snapshot.status, "accepted");
if (inlineSnapshot.status === "accepted" && sequence999Snapshot.status === "accepted") {
    assert.notEqual(inlineSnapshot.snapshot.sourceSnapshotId, sequence999Snapshot.snapshot.sourceSnapshotId, "revision sequence must participate in sourceSnapshotId");
}

const mismatchedSpool = createRecordSourceSnapshot({
    candidateId: fullReadCandidateId,
    source: fullReadSource,
    fullSourceRead: fullReadEvidence,
    revisionSequence: 7,
    contentBinding: {
        kind: "spool",
        ref: "C:/spool/full-read.bin",
        byteLength: Buffer.byteLength(sourceContent, "utf8"),
        contentHash: contentHash("different bytes"),
    },
    formatterVersion: "formatter-v2",
    capturedAtSequence: 701,
});
assert.equal(mismatchedSpool.status, "rejected", "spool hash mismatch");
assert.equal(mismatchedSpool.reason, "content-binding-mismatch");

const spoolSnapshot = createRecordSourceSnapshot({
    candidateId: fullReadCandidateId,
    source: fullReadSource,
    fullSourceRead: fullReadEvidence,
    revisionSequence: 7,
    contentBinding: {
        kind: "spool",
        ref: "C:/spool/full-read.bin",
        byteLength: Buffer.byteLength(sourceContent, "utf8"),
        contentHash: sourceContentHash,
    },
    formatterVersion: "formatter-v2",
    capturedAtSequence: 701,
});
assert.equal(spoolSnapshot.status, "accepted");
if (spoolSnapshot.status === "accepted") {
    assert.equal(spoolSnapshot.snapshot.verification.downstreamVerifierRequired, true);
    assert.equal(spoolSnapshot.snapshot.verification.status, "requires-downstream-spool-verification");
}

assert.throws(() => buildFullSourceReadEvidence({
    adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
    host: fullReadSource.host,
    identity: fullReadSource.identity,
    sourceRevision: fullReadEvidence.sourceRevision,
    pagination: fullReadEvidence.pagination,
    enumerationComplete: true,
    cacheBypassed: true,
    exactFetchResult: "present",
    errors: [],
    warnings: [],
    observedAt: observation("invalid-range", 702),
    content: {
        ...fullReadEvidence.content,
        roundRange: { start: 8, end: 1 },
    },
}), /结束轮次/);

const performanceSource = source("codex", "C:/fixtures/performance", "performance-template");
const performanceScope = indexScope(performanceSource, { snapshotId: "index-performance", revision: "index-performance-1" });
const performanceEnumerations = Array.from({ length: 10_000 }, (_, index) => {
    const candidateSource = source("codex", "C:/fixtures/performance", `performance-${index.toString().padStart(5, "0")}`);
    return enumeration(candidateSource, `rev-${index}`, index + 1, {
        scanId: `performance-scan-${index}`,
        observationSequence: index + 1,
        completedAtMs: baseTimeMs + index,
    });
});
const performanceStartedAt = performance.now();
const performanceSnapshot = discoverRecordCandidates({
    request: { snapshotId: "performance-10k", discoveredAtSequence: 20_000, filters: { hosts: ["codex"], workspace: null, extensions: {} } },
    sourceEnumerations: performanceEnumerations,
    recordIndex: { scopes: [performanceScope], entries: [] },
    absenceObservations: [],
});
const performanceElapsedMs = performance.now() - performanceStartedAt;
assert.equal(performanceSnapshot.candidates.length, 10_000, "10k performance candidate count");
assert.ok(performanceElapsedMs < 30_000, `10k performance exceeded 30s: ${performanceElapsedMs.toFixed(1)}ms`);

console.log(`✅ record discovery tests passed (10k=${performanceElapsedMs.toFixed(1)}ms)`);
