import assert from "node:assert/strict";
import type {
    ExactFetchEvidenceInput,
    FullSourceReadEvidenceInput,
    PaginationEvidence,
    SourceEnumerationEvidenceInput,
} from "../src/source-evidence-contracts.ts";

const contracts = await import("../src/source-evidence-contracts.ts");

const contentHash = `sha256:${"a".repeat(64)}`;
const sourceRevision = {
    revision: "revision-1",
    contentCursor: "cursor-1",
    eventWatermark: "watermark-1",
    sequence: null,
};
const identity = {
    workspace: {
        workspaceId: "workspace-café",
        canonicalPath: "C:\\Workspace\\Records",
    },
    source: {
        kind: "database" as const,
        authority: "codex-local-sqlite",
        authoritativeRoot: "C:\\example\\<user>\\.codex",
        canonicalPath: "C:\\example\\<user>\\.codex\\state.sqlite",
    },
    conversationId: "conversation-1",
};

function observation(scanId = "scan-1", sequence = 1) {
    return {
        scanId,
        sequence,
        startedAt: "2026-07-13T00:00:00.000Z",
        completedAt: "2026-07-13T00:00:01.000Z",
    };
}

function pagination(overrides: Partial<PaginationEvidence> = {}) {
    return { ...basePagination, ...overrides };
}

const basePagination: PaginationEvidence = {
    cursor: null,
    pages: 2,
    limit: null,
    truncated: false,
};

function enumerationInput(overrides: Record<string, unknown> = {}) {
    return {
        adapterVersion: contracts.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity,
        sourceRevision,
        pagination: basePagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: observation(),
        targetStatus: "absent",
        ...overrides,
    } as SourceEnumerationEvidenceInput;
}

function enumeration(overrides: Record<string, unknown> = {}) {
    return contracts.buildSourceEnumerationEvidence(enumerationInput(overrides));
}

function exactFetch(overrides: Record<string, unknown> = {}) {
    return contracts.buildExactFetchEvidence({
        adapterVersion: contracts.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity,
        sourceRevision,
        pagination: basePagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: observation(),
        ...overrides,
    } as ExactFetchEvidenceInput);
}

function classify(overrides: { enumeration?: Record<string, unknown>; exactFetch?: Record<string, unknown> } = {}) {
    return contracts.classifySourceEvidence({
        enumeration: enumeration(overrides.enumeration),
        exactFetch: exactFetch(overrides.exactFetch),
    });
}

const truthTable = [
    {
        case: "present",
        result: classify({
            enumeration: { targetStatus: "present", exactFetchResult: "present" },
            exactFetch: { exactFetchResult: "present" },
        }),
        expected: "Present",
    },
    {
        case: "absent complete fresh exact-not-found",
        result: classify(),
        expected: "Lost",
    },
    {
        case: "incomplete enumeration",
        result: classify({ enumeration: { enumerationComplete: false } }),
        expected: "Unresolved",
    },
    {
        case: "adapter parse error",
        result: classify({ enumeration: { errors: [{ code: "parse_error", message: "bad jsonl" }] } }),
        expected: "Unresolved",
    },
    {
        case: "pagination limit",
        result: classify({ enumeration: { pagination: pagination({ limit: 100 }) } }),
        expected: "Unresolved",
    },
    {
        case: "cache hit",
        result: classify({ enumeration: { cacheBypassed: false } }),
        expected: "Unresolved",
    },
    {
        case: "revision drift",
        result: classify({ exactFetch: { sourceRevision: { ...sourceRevision, revision: "revision-2" } } }),
        expected: "Unresolved",
    },
    {
        case: "exact-fetch contradiction",
        result: classify({ enumeration: { targetStatus: "present" } }),
        expected: "Unresolved",
    },
];

for (const row of truthTable) assert.equal(row.result.state, row.expected, row.case);
assert.equal(truthTable[1].result.lostObservation?.targetStatus, "absent");
assert.equal(truthTable[4].result.reason, "pagination-limit");
assert.equal(truthTable[5].result.reason, "cache-not-bypassed");
assert.equal(truthTable[6].result.reason, "revision-drift");

const verifiedCacheIdentity = {
    ...identity,
    source: {
        ...identity.source,
        authority: "memory-store-fetch-cache",
        authoritativeRoot: "conversation-cache:codex:conversation-1",
        canonicalPath: "C:\\conversation-cache\\codex\\conversation-1\\generation-1",
    },
};
const verifiedCacheRevision = {
    revision: "cache-generation:generation-1",
    contentCursor: "round:63",
    eventWatermark: "cache-fingerprint:sha256:fixture",
    sequence: 63,
};
const verifiedCacheEnumeration = enumeration({
    identity: verifiedCacheIdentity,
    sourceRevision: verifiedCacheRevision,
    cacheBypassed: false,
    targetStatus: "present",
    exactFetchResult: "present",
});
const verifiedCacheExactFetch = exactFetch({
    identity: verifiedCacheIdentity,
    sourceRevision: verifiedCacheRevision,
    cacheBypassed: false,
    exactFetchResult: "present",
});
assert.equal(
    contracts.isVerifiedConversationCacheEnumeration(verifiedCacheEnumeration, verifiedCacheExactFetch),
    true,
    "候选判定与调度账本必须共同认可同一份已验证不可变 fetch 缓存",
);
assert.equal(
    contracts.isVerifiedConversationCacheEnumeration(verifiedCacheEnumeration, exactFetch({
        identity: verifiedCacheIdentity,
        sourceRevision: { ...verifiedCacheRevision, revision: "cache-generation:generation-2" },
        cacheBypassed: false,
        exactFetchResult: "present",
    })),
    false,
    "fetch 缓存 generation 不一致时不得获得调度权威性",
);

const qualifiedLost = contracts.buildLostObservation({ enumeration: enumeration(), exactFetch: exactFetch() });
assert.equal(contracts.validateLostObservation(qualifiedLost).exactFetchResult, "not_found");
assert.throws(
    () => contracts.buildLostObservation({ enumeration: enumeration({ pagination: pagination({ cursor: "next" }) }), exactFetch: exactFetch() }),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildLostObservation({ enumeration: enumeration(), exactFetch: exactFetch({ errors: [{ code: "timeout", message: "timed out" }] }) }),
    contracts.SourceEvidenceContractError,
);

const unicodeEquivalent = enumeration({
    identity: {
        ...identity,
        workspace: { workspaceId: "workspace-cafe\u0301", canonicalPath: "c:/Workspace/Records" },
        source: { ...identity.source, canonicalPath: "c:/example/<user>/.codex/state.sqlite" },
    },
});
assert.equal(unicodeEquivalent.evidenceHash, enumeration().evidenceHash);
const canonicalIdentity = contracts.canonicalizeSourceIdentity({ host: "codex", identity });
assert.equal(canonicalIdentity.identity.workspace.canonicalPath, "c:/Workspace/Records");
assert.equal(canonicalIdentity.identity.source.canonicalPath, "c:/example/<user>/.codex/state.sqlite");
assert.equal(
    contracts.canonicalSourceIdentityKey({ host: "codex", identity }),
    contracts.canonicalSourceIdentityKey(canonicalIdentity),
);
assert.notEqual(
    contracts.canonicalSourceIdentityKey({ host: "codex", identity }),
    contracts.canonicalSourceIdentityKey({
        host: "codex",
        identity: {
            ...identity,
            workspace: { ...identity.workspace, canonicalPath: "c:/workspace/Records" },
        },
    }),
    "Windows component case must follow the single source-evidence canonicalizer",
);
assert.notEqual(
    contracts.canonicalSourceIdentityKey({ host: "codex", identity }),
    contracts.canonicalSourceIdentityKey({ host: "antigravity", identity }),
);
assert.throws(
    () => contracts.buildSourceEnumerationEvidence({
        ...enumerationInput(),
        adapterVersion: "source-evidence/v2",
    } as unknown as SourceEnumerationEvidenceInput),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildSourceEnumerationEvidence({
        ...enumerationInput(),
        pagination: pagination({ pages: Number.POSITIVE_INFINITY }),
    }),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildSourceEnumerationEvidence({
        ...enumerationInput(),
        identity: {
            ...identity,
            source: { ...identity.source, canonicalPath: "C:\\Workspace\\..\\escape" },
        },
    }),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildSourceEnumerationEvidence({
        ...enumerationInput(),
        unexpectedField: true,
    } as unknown as SourceEnumerationEvidenceInput),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.validateSourceEnumerationEvidence({
        ...enumeration(),
        warnings: [{ code: "timeout", message: "tampered" }],
    }),
    contracts.SourceEvidenceContractError,
);

function fullSourceReadInput(overrides: Record<string, unknown> = {}) {
    return {
        adapterVersion: contracts.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity,
        sourceRevision: { ...sourceRevision, sequence: 7 },
        pagination: basePagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: observation("scan-2", 2),
        content: {
            mode: "full",
            byteLength: 4096,
            contentHash,
            roundRange: { start: 1, end: 9 },
            truncated: false,
            staleCache: false,
        },
        ...overrides,
    } as FullSourceReadEvidenceInput;
}

const fullSourceRead = contracts.buildFullSourceReadEvidence(fullSourceReadInput());
const recordSnapshot = contracts.buildRecordSourceSnapshot({ snapshotId: "snapshot-1", fullSourceRead });
assert.equal(recordSnapshot.fullSourceRead.content.byteLength, 4096);
assert.equal(recordSnapshot.fullSourceRead.content.contentHash, contentHash);
assert.deepEqual(recordSnapshot.fullSourceRead.content.roundRange, { start: 1, end: 9 });
assert.equal(recordSnapshot.fullSourceRead.sourceRevision.revision, "revision-1");
assert.equal(recordSnapshot.fullSourceRead.sourceRevision.sequence, 7);
assert.equal(contracts.validateRecordSourceSnapshot(recordSnapshot).snapshotHash, recordSnapshot.snapshotHash);

const sequence999Read = contracts.buildFullSourceReadEvidence(fullSourceReadInput({
    sourceRevision: { ...sourceRevision, sequence: 999 },
}));
const sequence999RecordSnapshot = contracts.buildRecordSourceSnapshot({ snapshotId: "snapshot-1", fullSourceRead: sequence999Read });
assert.notEqual(sequence999Read.evidenceHash, fullSourceRead.evidenceHash, "source revision sequence must participate in evidenceHash");
assert.notEqual(sequence999RecordSnapshot.snapshotHash, recordSnapshot.snapshotHash, "source revision sequence must participate in snapshotHash");

const rejectedSnapshotReads = [
    {
        case: "cache hit",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ cacheBypassed: false })),
    },
    {
        case: "partial enumeration",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ enumerationComplete: false })),
    },
    {
        case: "pagination cursor",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ pagination: pagination({ cursor: "next-page" }) })),
    },
    {
        case: "pagination limit",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ pagination: pagination({ limit: 100 }) })),
    },
    {
        case: "pagination truncated",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ pagination: pagination({ truncated: true }) })),
    },
    {
        case: "read errors",
        read: contracts.buildFullSourceReadEvidence(fullSourceReadInput({ errors: [{ code: "parse_error", message: "partial source" }] })),
    },
];

for (const rejected of rejectedSnapshotReads) {
    assert.throws(
        () => contracts.buildRecordSourceSnapshot({ snapshotId: `snapshot-rejected-${rejected.case}`, fullSourceRead: rejected.read }),
        contracts.SourceEvidenceContractError,
        rejected.case,
    );
}

const tamperedBindings = [
    {
        case: "scanId mismatch",
        read: { ...fullSourceRead, observedAt: { ...fullSourceRead.observedAt, scanId: "scan-other" } },
    },
    {
        case: "identity mismatch",
        read: { ...fullSourceRead, identity: { ...fullSourceRead.identity, conversationId: "conversation-other" } },
    },
    {
        case: "revision mismatch",
        read: { ...fullSourceRead, sourceRevision: { ...fullSourceRead.sourceRevision, revision: "revision-other" } },
    },
    {
        case: "revision sequence mismatch",
        read: { ...fullSourceRead, sourceRevision: { ...fullSourceRead.sourceRevision, sequence: 999 } },
    },
];

for (const tampered of tamperedBindings) {
    assert.throws(
        () => contracts.buildRecordSourceSnapshot({ snapshotId: `snapshot-tampered-${tampered.case}`, fullSourceRead: tampered.read }),
        contracts.SourceEvidenceContractError,
        tampered.case,
    );
}

assert.throws(
    () => contracts.buildFullSourceReadEvidence({
        ...fullSourceReadInput(),
        content: { ...fullSourceRead.content, staleCache: true },
    }),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildFullSourceReadEvidence({
        ...fullSourceReadInput(),
        content: { ...fullSourceRead.content, truncated: true },
    }),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildFullSourceReadEvidence({
        ...fullSourceReadInput(),
        content: { ...fullSourceRead.content, mode: "summary" },
    } as unknown as FullSourceReadEvidenceInput),
    contracts.SourceEvidenceContractError,
);
assert.throws(
    () => contracts.buildFullSourceReadEvidence({
        ...fullSourceReadInput(),
        exactFetchResult: "unresolved",
    }),
    contracts.SourceEvidenceContractError,
);

console.log(`source-evidence-contracts: ${truthTable.length} truth-table rows and ${rejectedSnapshotReads.length} snapshot rejection rows passed`);
