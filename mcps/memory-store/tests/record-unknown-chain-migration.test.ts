import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildSourceEnumerationEvidence,
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    type FullSourceReadEvidence,
    type SourceEvidenceHost,
    type SourceWorkspaceIdentity,
} from "../src/source-evidence-contracts.js";
import {
    inspectUnknownChainMigration,
    scanUnknownChainMigrationBatches,
    scanUnknownChainMigrations,
    type HistoricalRecordIndexEntry,
    type UnknownChainMigrationEvidence,
    type UnknownChainMigrationHost,
    type UnknownChainMigrationProductionReader,
    type UnknownChainMigrationReaders,
} from "../src/record-unknown-chain-migration.js";

const hosts = ["codex", "claude-code", "windsurf", "antigravity"] as const satisfies readonly UnknownChainMigrationHost[];
const alpha: SourceWorkspaceIdentity = { workspaceId: "workspace-alpha", canonicalPath: "C:/workspace/alpha" };
const beta: SourceWorkspaceIdentity = { workspaceId: "workspace-beta", canonicalPath: "C:/workspace/beta" };

function hash(value: unknown): string {
    return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function entry(overrides: Partial<HistoricalRecordIndexEntry> = {}): HistoricalRecordIndexEntry {
    return {
        recordId: "record-unknown-1",
        chain: "unknown",
        workspace: alpha,
        conversationId: "conversation-1",
        indexRevision: "index-revision-1",
        entryEvidenceHash: hash("index-entry"),
        ...overrides,
    };
}

function sourceIdentity(host: SourceEvidenceHost, workspace: SourceWorkspaceIdentity, conversationId: string) {
    return {
        workspace,
        source: {
            kind: "filesystem" as const,
            authority: `${host}-fixture`,
            authoritativeRoot: `fixture://${host}`,
            canonicalPath: `C:/fixtures/${host}`,
        },
        conversationId,
    };
}

function evidence(host: UnknownChainMigrationHost, status: "present" | "absent", options: {
    workspace?: SourceWorkspaceIdentity;
    conversationId?: string;
    complete?: boolean;
    cacheBypassed?: boolean;
    fullTruncated?: boolean;
} = {}): UnknownChainMigrationEvidence {
    const identity = sourceIdentity(host, options.workspace || alpha, options.conversationId || "conversation-1");
    const complete = options.complete ?? true;
    const cacheBypassed = options.cacheBypassed ?? true;
    const scanId = `scan-${host}-${identity.workspace.workspaceId}`;
    const base = {
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host,
        identity,
        sourceRevision: { revision: `revision-${host}`, contentCursor: `cursor-${host}`, eventWatermark: `watermark-${host}`, sequence: 1 },
        pagination: { cursor: complete ? null : "next-page", pages: 1, limit: null, truncated: !complete },
        enumerationComplete: complete,
        cacheBypassed,
        errors: [],
        warnings: [],
        observedAt: { scanId, sequence: 1, startedAt: "2026-07-14T00:00:00.000Z", completedAt: "2026-07-14T00:00:01.000Z" },
    };
    const enumeration = buildSourceEnumerationEvidence({
        ...base,
        exactFetchResult: status === "present" ? "present" : "not_found",
        targetStatus: status,
    });
    const exactFetch = buildExactFetchEvidence({
        ...base,
        exactFetchResult: status === "present" ? "present" : "not_found",
    });
    const fullSourceRead: FullSourceReadEvidence | null = status === "present"
        ? buildFullSourceReadEvidence({
            ...base,
            exactFetchResult: "present",
            content: {
                mode: "full",
                byteLength: 42,
                contentHash: hash(`content-${host}`),
                roundRange: { start: 1, end: 2 },
                truncated: options.fullTruncated ?? false,
                staleCache: false,
            },
        })
        : null;
    return { enumeration, exactFetch, fullSourceRead };
}

function readers(responses: Partial<Record<UnknownChainMigrationHost, UnknownChainMigrationEvidence>>, calls?: Map<UnknownChainMigrationHost, number>): UnknownChainMigrationReaders {
    return Object.fromEntries(hosts.map(host => [host, {
        host,
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        async scan() {
            calls?.set(host, (calls.get(host) || 0) + 1);
            const response = responses[host];
            if (!response) throw new Error(`missing fixture response for ${host}`);
            return response;
        },
    } satisfies UnknownChainMigrationProductionReader])) as UnknownChainMigrationReaders;
}

function allAbsent() {
    return Object.fromEntries(hosts.map(host => [host, evidence(host, "absent")])) as Record<UnknownChainMigrationHost, UnknownChainMigrationEvidence>;
}

async function run(): Promise<void> {
    const unique = allAbsent();
    unique.codex = evidence("codex", "present");
    const uniqueResult = await inspectUnknownChainMigration(entry(), readers(unique));
    assert.equal(uniqueResult.status, "Patched");
    assert.equal(uniqueResult.patch.replacement.chain, "codex");
    assert.equal(uniqueResult.patch.cas.expectedChain, "unknown");
    assert.equal(uniqueResult.patch.evidenceHash, unique.codex.fullSourceRead!.evidenceHash);
    assert.equal(uniqueResult.patch.scanId, unique.codex.fullSourceRead!.observedAt.scanId);
    assert.equal(uniqueResult.patch.adapterVersion, SOURCE_EVIDENCE_ADAPTER_VERSION);

    const noMatch = await inspectUnknownChainMigration(entry(), readers(allAbsent()));
    assert.equal(noMatch.status, "Unresolved");
    assert.equal(noMatch.reason, "no-unique-host-match");

    const multiple = allAbsent();
    multiple.codex = evidence("codex", "present");
    multiple["claude-code"] = evidence("claude-code", "present");
    const conflict = await inspectUnknownChainMigration(entry(), readers(multiple));
    assert.equal(conflict.status, "Conflict");
    assert.deepEqual(conflict.matchingHosts, ["codex", "claude-code"]);

    const partial = allAbsent();
    partial.codex = evidence("codex", "present");
    partial.windsurf = evidence("windsurf", "absent", { complete: false });
    const partialResult = await inspectUnknownChainMigration(entry(), readers(partial));
    assert.equal(partialResult.status, "Unresolved");
    assert.match(partialResult.observations.find(observation => observation.host === "windsurf")!.reason, /incomplete/u);

    const wrongWorkspace = allAbsent();
    wrongWorkspace.codex = evidence("codex", "present", { workspace: beta });
    const drift = await inspectUnknownChainMigration(entry(), readers(wrongWorkspace));
    assert.equal(drift.status, "Unresolved");
    assert.equal(drift.observations.find(observation => observation.host === "codex")!.reason, "identity-drift");

    const cancellation = new AbortController();
    const cancellationCalls = new Map<UnknownChainMigrationHost, number>();
    const cancellingReaders = readers(unique, cancellationCalls);
    const originalCodex = cancellingReaders.codex!;
    cancellingReaders.codex = {
        ...originalCodex,
        async scan(request) {
            cancellation.abort();
            return originalCodex.scan(request);
        },
    };
    const cancelled = await inspectUnknownChainMigration(entry(), cancellingReaders, { signal: cancellation.signal });
    assert.equal(cancelled.status, "Cancelled");
    assert.equal(cancellationCalls.get("codex"), 1);
    assert.equal(cancellationCalls.get("claude-code") || 0, 0);

    const rerunFirst = await inspectUnknownChainMigration(entry(), readers(unique));
    const rerunSecond = await inspectUnknownChainMigration(entry(), readers(unique));
    assert.deepEqual(rerunSecond, rerunFirst);
    const knownCalls = new Map<UnknownChainMigrationHost, number>();
    const known = await inspectUnknownChainMigration(entry({ chain: "codex" }), readers(unique, knownCalls));
    assert.equal(known.status, "Skipped");
    assert.equal([...knownCalls.values()].reduce((total, count) => total + count, 0), 0);

    let produced = 0;
    function* tenThousandEntries(): Generator<HistoricalRecordIndexEntry> {
        for (let index = 0; index < 10_000; index += 1) {
            produced += 1;
            yield entry({ recordId: `record-${index}` });
        }
    }
    const lazyCalls = new Map<UnknownChainMigrationHost, number>();
    const lazyScan = scanUnknownChainMigrations({ entries: tenThousandEntries(), readers: readers(unique, lazyCalls) });
    const first = await lazyScan.next();
    assert.equal(first.done, false);
    assert.equal(produced, 1);
    assert.equal([...lazyCalls.values()].reduce((total, count) => total + count, 0), 4);

    const batched = scanUnknownChainMigrationBatches({ entries: tenThousandEntries(), readers: readers(unique), batchSize: 2 });
    const firstBatch = await batched.next();
    assert.equal(firstBatch.done, false);
    assert.equal(firstBatch.value.length, 2);
    assert.equal(produced, 3);
}

await run();
console.log("record unknown-chain migration tests passed");
