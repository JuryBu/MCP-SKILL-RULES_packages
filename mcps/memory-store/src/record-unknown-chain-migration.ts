import { createHash } from "node:crypto";
import {
    canonicalSerialize,
    canonicalizeSourceWorkspaceIdentity,
    validateExactFetchEvidence,
    validateFullSourceReadEvidence,
    validateSourceEnumerationEvidence,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type SourceConversationIdentity,
    type SourceEvidenceHost,
    type SourceEnumerationEvidence,
    type SourceWorkspaceIdentity,
} from "./source-evidence-contracts.js";

export const UNKNOWN_CHAIN_MIGRATION_VERSION = "record-unknown-chain-migration/v1" as const;

export const UNKNOWN_CHAIN_MIGRATION_HOSTS = ["codex", "claude-code", "windsurf", "antigravity"] as const satisfies readonly SourceEvidenceHost[];

export type UnknownChainMigrationHost = typeof UNKNOWN_CHAIN_MIGRATION_HOSTS[number];

export interface HistoricalRecordIndexEntry {
    readonly recordId: string;
    readonly chain: string | null | undefined;
    readonly workspace: SourceWorkspaceIdentity;
    readonly conversationId: string;
    readonly indexRevision: string;
    readonly entryEvidenceHash: string;
}

export interface UnknownChainMigrationEvidence {
    readonly enumeration: SourceEnumerationEvidence;
    readonly exactFetch: ExactFetchEvidence;
    readonly fullSourceRead: FullSourceReadEvidence | null;
}

export interface UnknownChainMigrationReadRequest {
    readonly entry: Readonly<HistoricalRecordIndexEntry>;
    readonly host: UnknownChainMigrationHost;
    readonly signal?: AbortSignal;
}

export interface UnknownChainMigrationProductionReader {
    readonly host: UnknownChainMigrationHost;
    readonly adapterVersion?: string;
    scan(request: UnknownChainMigrationReadRequest): Promise<UnknownChainMigrationEvidence>;
}

export type UnknownChainMigrationReaders = Partial<Record<UnknownChainMigrationHost, UnknownChainMigrationProductionReader>>;

export interface UnknownChainMigrationScanInput {
    readonly entries: Iterable<HistoricalRecordIndexEntry>;
    readonly readers: UnknownChainMigrationReaders;
    readonly signal?: AbortSignal;
}

export interface UnknownChainMigrationBatchScanInput extends UnknownChainMigrationScanInput {
    readonly batchSize?: number;
}

export interface UnknownChainMigrationCasPrecondition {
    readonly expectedChain: "unknown";
    readonly expectedIndexRevision: string;
    readonly expectedEntryEvidenceHash: string;
}

export interface UnknownChainMigrationPatch {
    readonly kind: typeof UNKNOWN_CHAIN_MIGRATION_VERSION;
    readonly patchId: string;
    readonly recordId: string;
    readonly cas: UnknownChainMigrationCasPrecondition;
    readonly replacement: {
        readonly chain: UnknownChainMigrationHost;
        readonly workspace: SourceWorkspaceIdentity;
        readonly conversationId: string;
        readonly sourceIdentity: SourceConversationIdentity;
    };
    readonly evidenceHash: string;
    readonly scanId: string;
    readonly adapterVersion: string;
    readonly sourceIdentity: SourceConversationIdentity;
}

export type UnknownChainMigrationObservationStatus = "Matched" | "Absent" | "Unresolved";

export interface UnknownChainMigrationObservation {
    readonly host: UnknownChainMigrationHost;
    readonly status: UnknownChainMigrationObservationStatus;
    readonly reason: string;
    readonly evidenceHash?: string;
    readonly scanId?: string;
    readonly adapterVersion?: string;
    readonly sourceIdentity?: SourceConversationIdentity;
}

interface UnknownChainMigrationResultBase {
    readonly recordId: string;
    readonly observations: readonly UnknownChainMigrationObservation[];
}

export interface UnknownChainMigrationPatched extends UnknownChainMigrationResultBase {
    readonly status: "Patched";
    readonly patch: UnknownChainMigrationPatch;
}

export interface UnknownChainMigrationUnresolved extends UnknownChainMigrationResultBase {
    readonly status: "Unresolved";
    readonly reason: string;
}

export interface UnknownChainMigrationConflict extends UnknownChainMigrationResultBase {
    readonly status: "Conflict";
    readonly matchingHosts: readonly UnknownChainMigrationHost[];
}

export interface UnknownChainMigrationSkipped extends UnknownChainMigrationResultBase {
    readonly status: "Skipped";
    readonly reason: "known-chain";
}

export interface UnknownChainMigrationCancelled extends UnknownChainMigrationResultBase {
    readonly status: "Cancelled";
    readonly reason: "cancelled";
}

export type UnknownChainMigrationResult =
    | UnknownChainMigrationPatched
    | UnknownChainMigrationUnresolved
    | UnknownChainMigrationConflict
    | UnknownChainMigrationSkipped
    | UnknownChainMigrationCancelled;

interface CanonicalHistoricalEntry extends HistoricalRecordIndexEntry {
    readonly workspace: SourceWorkspaceIdentity;
    readonly conversationId: string;
}

interface MatchedObservation {
    readonly host: UnknownChainMigrationHost;
    readonly evidenceHash: string;
    readonly scanId: string;
    readonly adapterVersion: string;
    readonly sourceIdentity: SourceConversationIdentity;
}

function sha256(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex")}`;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
    return canonicalSerialize(left) === canonicalSerialize(right);
}

function isCancelled(signal: AbortSignal | undefined, error?: unknown): boolean {
    if (signal?.aborted) return true;
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function canonicalEntry(entry: HistoricalRecordIndexEntry): CanonicalHistoricalEntry {
    const recordId = text(entry.recordId);
    const conversationId = text(entry.conversationId);
    const indexRevision = text(entry.indexRevision);
    const entryEvidenceHash = text(entry.entryEvidenceHash);
    if (!recordId || !conversationId || !indexRevision || !entryEvidenceHash) {
        throw new Error("历史 Record index 条目缺少 recordId、conversationId、indexRevision 或 entryEvidenceHash");
    }
    return {
        ...entry,
        recordId,
        conversationId,
        indexRevision,
        entryEvidenceHash,
        workspace: canonicalizeSourceWorkspaceIdentity(entry.workspace),
    };
}

function invalidObservation(host: UnknownChainMigrationHost, reason: string): UnknownChainMigrationObservation {
    return { host, status: "Unresolved", reason };
}

function evidenceObservation(host: UnknownChainMigrationHost, status: UnknownChainMigrationObservationStatus, reason: string, matched?: MatchedObservation): UnknownChainMigrationObservation {
    return matched
        ? {
            host,
            status,
            reason,
            evidenceHash: matched.evidenceHash,
            scanId: matched.scanId,
            adapterVersion: matched.adapterVersion,
            sourceIdentity: matched.sourceIdentity,
        }
        : { host, status, reason };
}

function hasNoIssues(evidence: SourceEnumerationEvidence | ExactFetchEvidence | FullSourceReadEvidence): boolean {
    return evidence.errors.length === 0 && evidence.warnings.length === 0;
}

function hasCompleteFreshRead(evidence: SourceEnumerationEvidence | ExactFetchEvidence | FullSourceReadEvidence): boolean {
    return evidence.enumerationComplete
        && evidence.cacheBypassed
        && !evidence.pagination.truncated
        && evidence.pagination.cursor === null
        && hasNoIssues(evidence);
}

function sameEvidenceContext(left: SourceEnumerationEvidence | ExactFetchEvidence | FullSourceReadEvidence, right: SourceEnumerationEvidence | ExactFetchEvidence | FullSourceReadEvidence): boolean {
    return left.host === right.host
        && left.adapterVersion === right.adapterVersion
        && left.observedAt.scanId === right.observedAt.scanId
        && sameCanonicalValue(left.identity, right.identity)
        && sameCanonicalValue(left.sourceRevision, right.sourceRevision);
}

function matchesEntryIdentity(identity: SourceConversationIdentity, entry: CanonicalHistoricalEntry): boolean {
    return identity.conversationId === entry.conversationId
        && sameCanonicalValue(identity.workspace, entry.workspace);
}

function evaluateEvidence(
    host: UnknownChainMigrationHost,
    entry: CanonicalHistoricalEntry,
    evidence: UnknownChainMigrationEvidence,
    reader: UnknownChainMigrationProductionReader,
): { observation: UnknownChainMigrationObservation; match: MatchedObservation | null } {
    let enumeration: SourceEnumerationEvidence;
    let exactFetch: ExactFetchEvidence;
    let fullSourceRead: FullSourceReadEvidence | null;
    try {
        enumeration = validateSourceEnumerationEvidence(evidence.enumeration);
        exactFetch = validateExactFetchEvidence(evidence.exactFetch);
        fullSourceRead = evidence.fullSourceRead === null ? null : validateFullSourceReadEvidence(evidence.fullSourceRead);
    } catch (error) {
        return { observation: invalidObservation(host, `invalid-evidence:${error instanceof Error ? error.message : String(error)}`), match: null };
    }

    if (enumeration.host !== host || exactFetch.host !== host || fullSourceRead && fullSourceRead.host !== host) {
        return { observation: invalidObservation(host, "host-mismatch"), match: null };
    }
    if (reader.adapterVersion && (enumeration.adapterVersion !== reader.adapterVersion || exactFetch.adapterVersion !== reader.adapterVersion || fullSourceRead && fullSourceRead.adapterVersion !== reader.adapterVersion)) {
        return { observation: invalidObservation(host, "adapter-version-mismatch"), match: null };
    }
    if (!sameEvidenceContext(enumeration, exactFetch) || fullSourceRead && !sameEvidenceContext(enumeration, fullSourceRead)) {
        return { observation: invalidObservation(host, "evidence-context-drift"), match: null };
    }
    if (!matchesEntryIdentity(enumeration.identity, entry) || !matchesEntryIdentity(exactFetch.identity, entry) || fullSourceRead && !matchesEntryIdentity(fullSourceRead.identity, entry)) {
        return { observation: invalidObservation(host, "identity-drift"), match: null };
    }
    if (!hasCompleteFreshRead(enumeration) || !hasCompleteFreshRead(exactFetch) || fullSourceRead && !hasCompleteFreshRead(fullSourceRead)) {
        return { observation: invalidObservation(host, "incomplete-or-cache-backed-evidence"), match: null };
    }

    if (exactFetch.exactFetchResult === "not_found") {
        if (enumeration.targetStatus !== "absent" || fullSourceRead !== null) {
            return { observation: invalidObservation(host, "absence-contradiction"), match: null };
        }
        return { observation: evidenceObservation(host, "Absent", "qualified-exact-absence"), match: null };
    }
    if (exactFetch.exactFetchResult !== "present" || enumeration.targetStatus !== "present" || !fullSourceRead) {
        return { observation: invalidObservation(host, "exact-fetch-unresolved"), match: null };
    }
    if (fullSourceRead.content.mode !== "full" || fullSourceRead.content.truncated || fullSourceRead.content.staleCache) {
        return { observation: invalidObservation(host, "full-read-partial-or-stale"), match: null };
    }

    const match: MatchedObservation = {
        host,
        evidenceHash: fullSourceRead.evidenceHash,
        scanId: fullSourceRead.observedAt.scanId,
        adapterVersion: fullSourceRead.adapterVersion,
        sourceIdentity: fullSourceRead.identity,
    };
    return { observation: evidenceObservation(host, "Matched", "qualified-exact-match", match), match };
}

function patchFor(entry: CanonicalHistoricalEntry, match: MatchedObservation): UnknownChainMigrationPatch {
    const patchWithoutId = {
        kind: UNKNOWN_CHAIN_MIGRATION_VERSION,
        recordId: entry.recordId,
        cas: {
            expectedChain: "unknown" as const,
            expectedIndexRevision: entry.indexRevision,
            expectedEntryEvidenceHash: entry.entryEvidenceHash,
        },
        replacement: {
            chain: match.host,
            workspace: entry.workspace,
            conversationId: entry.conversationId,
            sourceIdentity: match.sourceIdentity,
        },
        evidenceHash: match.evidenceHash,
        scanId: match.scanId,
        adapterVersion: match.adapterVersion,
        sourceIdentity: match.sourceIdentity,
    };
    return {
        ...patchWithoutId,
        patchId: `unknown-chain-migration:${sha256(patchWithoutId)}`,
    };
}

function knownChainResult(entry: HistoricalRecordIndexEntry): UnknownChainMigrationSkipped {
    return {
        status: "Skipped",
        reason: "known-chain",
        recordId: text(entry.recordId) || "<unknown-record>",
        observations: [],
    };
}

function cancelledResult(entry: HistoricalRecordIndexEntry, observations: readonly UnknownChainMigrationObservation[]): UnknownChainMigrationCancelled {
    return {
        status: "Cancelled",
        reason: "cancelled",
        recordId: text(entry.recordId) || "<unknown-record>",
        observations,
    };
}

export async function inspectUnknownChainMigration(
    entry: HistoricalRecordIndexEntry,
    readers: UnknownChainMigrationReaders,
    options: { readonly signal?: AbortSignal } = {},
): Promise<UnknownChainMigrationResult> {
    if (entry.chain !== "unknown") return knownChainResult(entry);
    if (isCancelled(options.signal)) return cancelledResult(entry, []);

    let canonical: CanonicalHistoricalEntry;
    try {
        canonical = canonicalEntry(entry);
    } catch (error) {
        return {
            status: "Unresolved",
            reason: `invalid-index-entry:${error instanceof Error ? error.message : String(error)}`,
            recordId: text(entry.recordId) || "<unknown-record>",
            observations: [],
        };
    }

    const observations: UnknownChainMigrationObservation[] = [];
    const matches: MatchedObservation[] = [];
    for (const host of UNKNOWN_CHAIN_MIGRATION_HOSTS) {
        if (isCancelled(options.signal)) return cancelledResult(canonical, observations);
        const reader = readers[host];
        if (!reader) {
            observations.push(invalidObservation(host, "reader-unavailable"));
            continue;
        }
        if (reader.host !== host) {
            observations.push(invalidObservation(host, "reader-host-mismatch"));
            continue;
        }
        try {
            const evidence = await reader.scan({ entry: canonical, host, signal: options.signal });
            if (isCancelled(options.signal)) return cancelledResult(canonical, observations);
            const evaluated = evaluateEvidence(host, canonical, evidence, reader);
            observations.push(evaluated.observation);
            if (evaluated.match) matches.push(evaluated.match);
        } catch (error) {
            if (isCancelled(options.signal, error)) return cancelledResult(canonical, observations);
            observations.push(invalidObservation(host, `reader-error:${error instanceof Error ? error.message : String(error)}`));
        }
    }

    if (matches.length > 1) {
        return {
            status: "Conflict",
            recordId: canonical.recordId,
            matchingHosts: matches.map(match => match.host),
            observations,
        };
    }
    if (observations.some(observation => observation.status === "Unresolved")) {
        return {
            status: "Unresolved",
            reason: "evidence-incomplete-or-identity-unsafe",
            recordId: canonical.recordId,
            observations,
        };
    }
    if (matches.length === 0) {
        return {
            status: "Unresolved",
            reason: "no-unique-host-match",
            recordId: canonical.recordId,
            observations,
        };
    }
    return {
        status: "Patched",
        recordId: canonical.recordId,
        observations,
        patch: patchFor(canonical, matches[0]),
    };
}

export async function* scanUnknownChainMigrations(input: UnknownChainMigrationScanInput): AsyncGenerator<UnknownChainMigrationResult> {
    for (const entry of input.entries) {
        const result = await inspectUnknownChainMigration(entry, input.readers, { signal: input.signal });
        yield result;
        if (result.status === "Cancelled") return;
    }
}

export async function* scanUnknownChainMigrationBatches(input: UnknownChainMigrationBatchScanInput): AsyncGenerator<readonly UnknownChainMigrationResult[]> {
    const batchSize = Number.isSafeInteger(input.batchSize) && input.batchSize! > 0 ? input.batchSize! : 100;
    let batch: UnknownChainMigrationResult[] = [];
    for await (const result of scanUnknownChainMigrations(input)) {
        batch.push(result);
        if (batch.length >= batchSize) {
            yield batch;
            batch = [];
        }
        if (result.status === "Cancelled") return;
    }
    if (batch.length > 0) yield batch;
}
