import assert from "node:assert/strict";
import {
    createAntigravityLsSourceEvidenceAdapter,
    type AntigravityEvidenceCacheState,
    type AntigravityEvidenceCallResult,
    type AntigravityEvidenceFailureCode,
    type AntigravityLsEvidenceExactValue,
    type AntigravityLsEvidenceFullValue,
    type AntigravityLsEvidencePage,
    type AntigravityLsEvidenceReader,
} from "../src/ls-client.ts";
import { classifySourceEvidence } from "../src/source-evidence-contracts.ts";

const cascadeId = "cascade-stage6";
const request = {
    cascadeId,
    workspaceId: "workspace-stage6",
    workspacePath: "C:/workspace/stage6",
    source: {
        endpoint: "http://127.0.0.1:9911",
        pbRoot: "C:/workspace/.gemini/antigravity/conversations",
        vscdbPath: "C:/workspace/state.vscdb",
    },
    scan: {
        scanId: "scan-stage6-001",
        sequence: 7,
        startedAt: "2026-07-13T12:00:00.000Z",
        completedAt: "2026-07-13T12:00:05.000Z",
    },
};

function ok<T>(value: T, revision: string, contentCursor = "cursor-1", cache: AntigravityEvidenceCacheState = "bypassed"): AntigravityEvidenceCallResult<T> {
    return { kind: "ok", value, revision, contentCursor, cache };
}

function notFound(revision: string, contentCursor = "cursor-1", cache: AntigravityEvidenceCacheState = "bypassed"): AntigravityEvidenceCallResult<never> {
    return { kind: "not_found", revision, contentCursor, cache };
}

function failed(code: AntigravityEvidenceFailureCode, message: string): AntigravityEvidenceCallResult<never> {
    return { kind: "error", failure: { code, message } };
}

function page(ids: string[], nextCursor: string | null = null, truncated = false): AntigravityLsEvidencePage {
    return { ids, nextCursor, truncated };
}

function defaultReader(overrides: Partial<AntigravityLsEvidenceReader> = {}): AntigravityLsEvidenceReader {
    const exact = {} satisfies AntigravityLsEvidenceExactValue;
    const full: AntigravityLsEvidenceFullValue = {
        content: "user: hello\nassistant: world",
        roundRange: { start: 1, end: 2 },
    };
    return {
        listLsPage: async () => ok(page([cascadeId]), "ls-r1"),
        listPb: async () => ok(page([cascadeId]), "pb-r1"),
        listVscdb: async () => ok(page([cascadeId]), "vscdb-r1"),
        fetchLs: async () => ok(exact, "ls-r1"),
        fetchPb: async () => ok(exact, "pb-r1"),
        fetchVscdb: async () => ok(exact, "vscdb-r1"),
        readFullLs: async () => ok(full, "ls-r1"),
        ...overrides,
    };
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader());
    const enumeration = await adapter.enumerate(request);
    const exact = await adapter.fetchExact(request);
    const full = await adapter.readFull(request, "snapshot-stage6-stable");

    assert.equal(enumeration.enumerationComplete, true);
    assert.equal(enumeration.exactFetchResult, "present");
    assert.equal(enumeration.identity.workspace.workspaceId, request.workspaceId);
    assert.equal(enumeration.identity.conversationId, cascadeId);
    assert.equal(enumeration.identity.source.authority.includes(request.source.endpoint), true);
    assert.equal(enumeration.adapterVersion, "source-evidence/v1");
    assert.equal(enumeration.observedAt.scanId, request.scan.scanId);
    assert.deepEqual(enumeration.pagination, { cursor: null, pages: 1, limit: null, truncated: false });
    assert.match(enumeration.evidenceHash, /^sha256:/);
    assert.equal(classifySourceEvidence({ enumeration, exactFetch: exact }).state, "Present");
    assert.equal(full.state, "Present");
    assert.notEqual(full.snapshot, null);
    assert.equal(full.content, "user: hello\nassistant: world");
    assert.ok(full.evidence);
    assert.equal(full.enumeration.observedAt.scanId, request.scan.scanId);
    assert.equal(full.evidence.enumerationComplete, full.enumeration.enumerationComplete);
    assert.deepEqual(full.evidence.pagination, full.enumeration.pagination);
    assert.deepEqual(full.evidence.sourceRevision, full.enumeration.sourceRevision);
    assert.equal(full.evidence.sourceRevision.contentCursor, "cursor-1");
}

{
    const sources = ["ls", "pb", "vscdb"] as const;
    for (const source of sources) {
        let listCalls = 0;
        let fullCalls = 0;
        const overrides: Partial<AntigravityLsEvidenceReader> = {
            readFullLs: async () => {
                fullCalls += 1;
                return ok({ content: "must not be read", roundRange: { start: 1, end: 1 } }, "ls-r1");
            },
        };
        if (source === "ls") {
            overrides.listLsPage = async () => {
                listCalls += 1;
                return failed("timeout", "LS list failed") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>;
            };
        } else if (source === "pb") {
            overrides.listPb = async () => {
                listCalls += 1;
                return failed("missing", ".pb index missing") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>;
            };
        } else {
            overrides.listVscdb = async () => {
                listCalls += 1;
                return failed("permission", "vscdb permission denied") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>;
            };
        }

        const full = await createAntigravityLsSourceEvidenceAdapter(defaultReader(overrides))
            .readFull({ ...request, scan: { ...request.scan, scanId: `scan-list-failure-${source}` } }, `snapshot-list-failure-${source}`);

        assert.equal(listCalls > 0, true, `${source} list must be called`);
        assert.equal(fullCalls, 0, `${source} list failure must stop the full read`);
        assert.equal(full.state, "Unresolved");
        assert.equal(full.enumeration.enumerationComplete, false);
        assert.equal(full.snapshot, null);
        assert.equal(full.evidence, null);
        assert.equal(full.errors.length > 0, true);
    }
}

{
    const cases: Array<{
        name: string;
        request: typeof request & { pageLimit?: number };
        reader: AntigravityLsEvidenceReader;
        expectedCode: "pagination_incomplete" | "limit_reached" | "cache_only" | "revision_drift";
    }> = [
        {
            name: "partial",
            request: { ...request, scan: { ...request.scan, scanId: "scan-list-partial" } },
            reader: defaultReader({ listLsPage: async () => ok(page([cascadeId], null, true), "ls-r1") }),
            expectedCode: "pagination_incomplete",
        },
        {
            name: "limit",
            request: { ...request, scan: { ...request.scan, scanId: "scan-list-limit" }, pageLimit: 1 },
            reader: defaultReader({ listLsPage: async () => ok(page([cascadeId], "page-2"), "ls-r1") }),
            expectedCode: "limit_reached",
        },
        {
            name: "cache",
            request: { ...request, scan: { ...request.scan, scanId: "scan-list-cache" } },
            reader: defaultReader({ listPb: async () => ok(page([cascadeId]), "pb-r1", "cursor-1", "used") }),
            expectedCode: "cache_only",
        },
        {
            name: "page-revision-drift",
            request: { ...request, scan: { ...request.scan, scanId: "scan-list-page-drift" } },
            reader: defaultReader({
                listLsPage: async (input) => input.cursor === null
                    ? ok(page([cascadeId], "page-2"), "ls-r1")
                    : ok(page([cascadeId]), "ls-r2"),
            }),
            expectedCode: "revision_drift",
        },
        {
            name: "enumeration-exact-revision-drift",
            request: { ...request, scan: { ...request.scan, scanId: "scan-list-exact-drift" } },
            reader: defaultReader({ fetchPb: async () => ok({}, "pb-r2") }),
            expectedCode: "revision_drift",
        },
    ];

    for (const fixture of cases) {
        const full = await createAntigravityLsSourceEvidenceAdapter(fixture.reader)
            .readFull(fixture.request, `snapshot-${fixture.name}`);

        assert.equal(full.state, "Unresolved", fixture.name);
        assert.equal(full.snapshot, null, fixture.name);
        assert.equal(full.evidence, null, fixture.name);
        assert.equal(full.errors.some((entry) => entry.code === fixture.expectedCode), true, fixture.name);
    }
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listLsPage: async () => ok(page([]), "ls-r1"),
        listPb: async () => ok(page([]), "pb-r1"),
        listVscdb: async () => ok(page([]), "vscdb-r1"),
        fetchLs: async () => notFound("ls-r1"),
        fetchPb: async () => notFound("pb-r1"),
        fetchVscdb: async () => notFound("vscdb-r1"),
    }));
    const enumeration = await adapter.enumerate(request);
    const exact = await adapter.fetchExact(request);

    assert.equal(enumeration.enumerationComplete, true);
    assert.equal(enumeration.targetStatus, "absent");
    assert.equal(enumeration.errors.length, 0);
    assert.equal(exact.exactFetchResult, "not_found");
    assert.equal(exact.errors.length, 0);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listPb: async () => ({ kind: "ok", value: { ids: "not-an-array", nextCursor: null }, revision: "pb-r1", contentCursor: "cursor-1", cache: "bypassed" } as unknown as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>),
        listVscdb: async () => failed("permission", "state.vscdb access denied") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>,
    }));
    const enumeration = await adapter.enumerate(request);

    assert.equal(enumeration.enumerationComplete, false);
    assert.equal(enumeration.targetStatus, "unknown");
    assert.deepEqual(enumeration.errors.map((entry) => entry.code).sort(), ["parse_error", "permission_denied"]);
    assert.equal(enumeration.errors.some((entry) => entry.message.includes(".pb enumeration")), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listVscdb: async () => ({ kind: "ok", value: { ids: [cascadeId], nextCursor: 9 }, revision: "vscdb-r1", contentCursor: "cursor-1", cache: "bypassed" } as unknown as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>),
    }));
    const enumeration = await adapter.enumerate(request);

    assert.equal(enumeration.enumerationComplete, false);
    assert.equal(enumeration.errors.some((entry) => entry.code === "parse_error" && entry.message.includes("vscdb enumeration")), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listPb: async () => failed("missing", "conversation directory is absent") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>,
        listVscdb: async () => failed("permission", "state.vscdb access denied") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>,
    }));
    const enumeration = await adapter.enumerate(request);

    assert.equal(enumeration.enumerationComplete, false);
    assert.equal(enumeration.errors.some((entry) => entry.code === "source_unavailable"), true);
    assert.equal(enumeration.errors.some((entry) => entry.code === "permission_denied"), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listLsPage: async () => failed("timeout", "GetAllCascadeTrajectories timed out") as AntigravityEvidenceCallResult<AntigravityLsEvidencePage>,
        fetchLs: async () => failed("unavailable", "language server restarted") as AntigravityEvidenceCallResult<AntigravityLsEvidenceExactValue>,
    }));
    const enumeration = await adapter.enumerate(request);
    const exact = await adapter.fetchExact(request);

    assert.equal(enumeration.enumerationComplete, false);
    assert.equal(enumeration.exactFetchResult, "unresolved");
    assert.equal(enumeration.errors.some((entry) => entry.code === "timeout"), true);
    assert.equal(exact.exactFetchResult, "unresolved");
    assert.equal(exact.errors.some((entry) => entry.code === "source_unavailable"), true);
    assert.equal(classifySourceEvidence({ enumeration, exactFetch: exact }).state, "Unresolved");
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        listLsPage: async (input) => input.cursor === null
            ? ok(page([cascadeId], "page-2"), "ls-r1")
            : ok(page([cascadeId]), "ls-r1"),
    }));
    const complete = await adapter.enumerate(request);
    const limited = await adapter.enumerate({ ...request, scan: { ...request.scan, scanId: "scan-stage6-limit" }, pageLimit: 1 });

    assert.equal(complete.enumerationComplete, true);
    assert.equal(complete.pagination.pages, 2);
    assert.equal(complete.pagination.cursor, null);
    assert.equal(limited.enumerationComplete, false);
    assert.equal(limited.pagination.limit, 1);
    assert.equal(limited.errors.some((entry) => entry.code === "limit_reached"), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        fetchVscdb: async () => failed("cache", "vscdb cache metadata is unreadable") as AntigravityEvidenceCallResult<AntigravityLsEvidenceExactValue>,
    }));
    const exact = await adapter.fetchExact(request);

    assert.equal(exact.exactFetchResult, "unresolved");
    assert.equal(exact.errors.some((entry) => entry.code === "cache_only"), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        fetchVscdb: async () => ok({}, "vscdb-r1", "cursor-1", "used"),
        readFullLs: async () => ok({ content: "stale", roundRange: { start: 1, end: 1 } }, "ls-r1", "cursor-1", "stale"),
    }));
    const enumeration = await adapter.enumerate(request);
    const exact = await adapter.fetchExact(request);
    const full = await adapter.readFull(request, "snapshot-stage6-cache");

    assert.equal(exact.cacheBypassed, false);
    assert.equal(exact.errors.some((entry) => entry.code === "cache_only"), true);
    assert.equal(classifySourceEvidence({ enumeration, exactFetch: exact }).state, "Unresolved");
    assert.equal(full.state, "Unresolved");
    assert.equal(full.snapshot, null);
    assert.equal(full.evidence, null);
    assert.equal(full.errors.some((entry) => entry.code === "cache_only"), true);
}

{
    const adapter = createAntigravityLsSourceEvidenceAdapter(defaultReader({
        readFullLs: async () => ok({ content: "newly changed", roundRange: { start: 1, end: 2 } }, "ls-r2", "cursor-2"),
    }));
    const full = await adapter.readFull(request, "snapshot-stage6-drift");

    assert.equal(full.state, "Unresolved");
    assert.equal(full.snapshot, null);
    assert.equal(full.content, null);
    assert.equal(full.evidence, null);
    assert.equal(full.errors.some((entry) => entry.code === "revision_drift"), true);
}

console.log("ls-source-evidence: full-read enumeration gate, one-sided list failures, cache, revision drift, and pagination fixtures passed");
