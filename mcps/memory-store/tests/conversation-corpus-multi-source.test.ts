import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { CorpusConversation, CorpusMessage, CorpusProjection, CorpusProvider, CorpusSourceStatus } from "../src/conversation-corpus-types.js";
import type { CorpusTaskStoredState } from "../src/conversation-corpus-task-store.js";
import { CORPUS_SOURCES, corpusConversationKey, type CorpusSource } from "../src/conversation-corpus-sources.js";
import { compileCorpusSearch, corpusConversationMatchesScope, searchCorpusProjection } from "../src/conversation-corpus-search.js";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-multi-source-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { startCorpusSearch, getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch } = await import("../src/conversation-corpus-task.js");
const { startCorpusPreparation } = await import("../src/conversation-corpus-preparation.js");
const { corpusTaskDirectory, corpusPreparationDirectory, corpusOwnerHash, corpusCoverage, loadCorpusTask, readCorpusJson, writeCorpusJson } = await import("../src/conversation-corpus-task-store.js");
type Identity = Parameters<typeof getCorpusSearchStatus>[0];
type Status = Awaited<ReturnType<typeof getCorpusSearchStatus>>;
after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

function message(text = "hit", round = 1, role: CorpusMessage["role"] = "user"): CorpusMessage {
    return { id: `${round}-${role}`, text, round, role, timestamp: "2026-01-01T00:00:00Z", position: { ordinal: round } };
}

function projection(source: CorpusSource, id = "shared", messages = [message()]): CorpusProjection {
    return { conversation: { source, id, title: id, workspace: "C:/fixture/project" }, revision: `${source}-verified-v1`, complete: true,
        warnings: [], messages, sourceBytes: 10 };
}

function identity(status: Status, root: string): Identity { return { root, ownerId: status.ownerId, taskId: status.taskId }; }

async function waitFor(options: Identity, predicate: (status: Status) => boolean = status => !["running", "cancelling"].includes(status.status)): Promise<Status> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const status = await getCorpusSearchStatus({ ...options, waitMs: 25, limit: 100 });
        if (predicate(status)) return status;
        await sleep(2);
    }
    throw new Error("Multi-source fixture did not reach the expected state");
}

function providerFor(projections: CorpusProjection[]): CorpusProvider {
    return { async list() { return projections.map(value => value.conversation); },
        async read(candidate) { return structuredClone(projections.find(value => corpusConversationKey(value.conversation) === corpusConversationKey(candidate))!); } };
}

function statuses(sources: readonly CorpusSource[]): CorpusSourceStatus[] {
    return sources.map(source => ({ source, status: "ok", candidateCount: 1, warnings: [] }));
}

test("five equal IDs survive deduplication, out-of-order prefetch, batches, records, deltas and cursor reload", async () => {
    const root = path.join(temporary, "five-sources");
    const values = CORPUS_SOURCES.map(source => projection(source));
    const provider: CorpusProvider = {
        sourceStatuses: () => statuses(CORPUS_SOURCES),
        async list(request) {
            assert.deepEqual(request.dataChains, CORPUS_SOURCES);
            return [...values.map(value => value.conversation), { ...values[1]!.conversation, sourceWarnings: ["verified alias warning"] }];
        },
        async readCached(candidate) {
            await sleep((CORPUS_SOURCES.length - CORPUS_SOURCES.indexOf(candidate.source)) * 3);
            return structuredClone(values.find(value => value.conversation.source === candidate.source)!);
        },
        async read() { throw new Error("All fixtures are cached"); },
    };
    const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: [...CORPUS_SOURCES], query: "hit" }, provider, commitBatchSize: 8 });
    const options = identity(started, root);
    const finished = await waitFor(options);
    assert.equal(finished.status, "completed");
    assert.equal(finished.coverage.candidateConversations, 5);
    assert.equal(finished.coverage.scannedMessages, 5);
    assert.equal(finished.coverage.sourceStatuses.length, 5);
    assert.equal(finished.totalMatches, 5);
    assert.deepEqual(new Set(finished.results.map(result => corpusConversationKey(result.conversation))), new Set(CORPUS_SOURCES.map(source => JSON.stringify([source, "shared"]))));
    const loaded = await loadCorpusTask(options);
    assert.equal(loaded.records.size, 5);
    for (const source of CORPUS_SOURCES) {
        const record = loaded.records.get(JSON.stringify([source, "shared"]))!;
        assert.equal(record.source, source);
        assert.equal(record.result!.snippets[0]!.source, source);
        assert.equal(record.result!.snippets[0]!.conversationId, "shared");
        assert.equal(record.result!.snippets[0]!.sourceRevision, `${source}-verified-v1`);
        assert.equal(record.result!.provisional, false);
    }
    assert.ok(loaded.records.get('["claude-code","shared"]')!.warnings.includes("verified alias warning"));
    const deltas = await getCorpusSearchStatus({ ...options, afterRevision: 0, limit: 100 });
    assert.equal(deltas.changes!.upserts.length, 5);
    assert.deepEqual(deltas.changes!.removedConversations, []);
    const first = await getCorpusSearchStatus({ ...options, limit: 2 });
    const second = await getCorpusSearchStatus({ ...options, limit: 2, cursor: first.nextCursor });
    const last = await getCorpusSearchStatus({ ...options, limit: 2, cursor: second.nextCursor });
    assert.equal(new Set([...first.results, ...second.results, ...last.results].map(result => corpusConversationKey(result.conversation))).size, 5);
    assert.equal(first.snapshotId, last.snapshotId);
    const payload = JSON.parse(Buffer.from(first.nextCursor!.split(".")[0]!, "base64url").toString("utf8"));
    assert.deepEqual(payload.dataChains, CORPUS_SOURCES);
    assert.equal(payload.requestHash, loaded.state.requestHash);
    await assert.rejects(getCorpusSearchStatus({ ...options, dataChain: "codex", cursor: first.nextCursor }), { code: "CORPUS_SOURCE_MISMATCH" });
    await assert.rejects(cancelCorpusSearch({ ...options, dataChains: ["dsh"] }), { code: "CORPUS_SOURCE_MISMATCH" });
    await assert.rejects(resumeCorpusSearch({ ...options, dataChains: ["codex"], provider }), { code: "CORPUS_SOURCE_MISMATCH" });
    assert.equal((await resumeCorpusSearch({ ...options, dataChains: [...CORPUS_SOURCES], provider })).taskId, started.taskId);
    const commitsDirectory = path.join(corpusTaskDirectory(options), "commits");
    const filename = path.join(commitsDirectory, (await fs.readdir(commitsDirectory)).find(name => name.endsWith(".batch.json"))!);
    const original = await fs.readFile(filename, "utf8");
    const damaged = JSON.parse(original);
    damaged.commits[0] = { ...damaged.commits[0], source: undefined, result: null };
    await writeCorpusJson(filename, damaged);
    await assert.rejects(loadCorpusTask(options), { code: "CORPUS_TASK_CORRUPT" });
    await assert.rejects(getCorpusSearchStatus({ ...options, afterRevision: 0, limit: 100 }), { code: "CORPUS_TASK_CORRUPT" });
    await fs.writeFile(filename, original, "utf8");
});

test("new task sources are explicit and validation preserves generic IDs, aliases, workspace, expression and role semantics", async () => {
    const root = path.join(temporary, "validation");
    const provider = providerFor([]);
    await assert.rejects(startCorpusSearch({ ownerId: "owner", root, request: { query: "hit" }, provider }), /dataChain/u);
    for (const dataChains of [[], ["auto"], ["codex", "invalid"], "codex", null]) {
        assert.throws(() => compileCorpusSearch({ query: "hit", dataChains } as never));
    }
    assert.throws(() => compileCorpusSearch({ query: "hit", sourceFailureMode: "ignore" } as never), /sourceFailureMode/u);
    assert.throws(() => compileCorpusSearch({ purpose: "prepare", conversationIds: ["shared"], dataChains: ["codex", "dsh"] }), /exactly one source/u);
    const compiled = compileCorpusSearch({ dataChains: ["claude-code"], query: "red", allTerms: ["blue"], anyTerms: ["green", "yellow"], excludeTerms: ["veto"],
        conversationIds: ["CANON"], workspaces: ["C:/fixture"], workspaceMode: "under", intersectionScope: "round" });
    assert.deepEqual(compiled.request.conversationIds, ["CANON"]);
    const value = projection("claude-code", "CaseSensitive", [message("red blue green"), message("veto", 2, "tool")]);
    value.conversation.canonicalId = "CANON";
    value.conversation.aliases = ["VerifiedAlias"];
    value.conversation.sourceWarnings = ["partial metadata context"];
    const match = searchCorpusProjection(value, compiled.request)!;
    assert.deepEqual(match.rounds, [1]);
    assert.equal(match.snippets[0]!.source, "claude-code");
    assert.equal(match.snippets[0]!.canonicalId, "CANON");
    assert.ok(match.warnings.includes("partial metadata context"));
    assert.equal(corpusConversationMatchesScope({ ...value.conversation, source: "codex" }, compiled.request), false);
    assert.equal(corpusConversationMatchesScope(value.conversation, { dataChains: ["claude-code"], conversationIds: ["casesensitive"] }), false);
    assert.equal(corpusConversationMatchesScope(value.conversation, { dataChains: ["claude-code"], conversationIds: ["VerifiedAlias"] }), true);
    assert.deepEqual(compileCorpusSearch({ query: "hit", dataChains: ["codex"], conversationIds: [" CODEX://threads/ABC "] }).request.conversationIds, ["abc"]);
    assert.deepEqual(compileCorpusSearch({ query: "hit", dataChains: ["codex", "dsh"], conversationIds: ["CaseSensitive"] }).request.conversationIds, ["CaseSensitive"]);
    const partial = searchCorpusProjection({ ...value, partial: true } as CorpusProjection, compiled.request)!;
    assert.equal(partial.provisional, true);
});

test("zero-candidate failed sources persist partial coverage and resume the original task without rereading healthy sources", async () => {
    const root = path.join(temporary, "source-failure");
    const reads: CorpusSource[] = [];
    const codex = projection("codex");
    const antigravity = projection("antigravity");
    const provider: CorpusProvider = {
        sourceStatuses: () => [statuses(["codex"])[0]!, { source: "antigravity", status: "error", candidateCount: 0, warnings: ["PB unavailable"], error: "offline" }],
        async list() { return [codex.conversation]; },
        async read(candidate) { reads.push(candidate.source); return structuredClone(codex); },
    };
    const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: ["codex", "antigravity"], query: "hit" }, provider });
    const options = identity(started, root);
    const partial = await waitFor(options);
    assert.equal(partial.status, "partial");
    assert.equal(partial.coverage.complete, false);
    assert.equal(partial.coverage.candidateConversations, 1);
    assert.deepEqual(partial.coverage.sourceStatuses.find(status => status.source === "antigravity"), provider.sourceStatuses!()[1]);
    const state = await readCorpusJson<CorpusTaskStoredState>(path.join(corpusTaskDirectory(options), "state.json"));
    assert.equal(state.sourceStatuses![1]!.error, "offline");
    const snapshot = await readCorpusJson<{ coverage: Status["coverage"] }>(path.join(corpusTaskDirectory(options), "snapshots", `${partial.snapshotId}.json`));
    assert.equal(snapshot.coverage.sourceStatuses[1]!.status, "error");
    const healthy: CorpusProvider = {
        ...providerFor([codex, antigravity]), sourceStatuses: () => statuses(["codex", "antigravity"]),
        async read(candidate) { reads.push(candidate.source); return structuredClone(candidate.source === "codex" ? codex : antigravity); },
    };
    const resumed = await resumeCorpusSearch({ ...options, dataChains: ["antigravity", "codex"], provider: healthy });
    assert.equal(resumed.taskId, started.taskId);
    const complete = await waitFor(options);
    assert.equal(complete.status, "completed");
    assert.equal(complete.totalMatches, 2);
    assert.deepEqual(reads, ["codex", "antigravity"]);
    assert.equal((await loadCorpusTask(options)).records.size, 2);
    let strictReads = 0;
    const strict = await startCorpusSearch({ ownerId: "owner", root: path.join(temporary, "strict-failure"),
        request: { dataChains: ["codex", "antigravity"], query: "hit", sourceFailureMode: "fail" },
        provider: { ...provider, async read() { strictReads++; return codex; } } });
    const failed = await waitFor(identity(strict, path.join(temporary, "strict-failure")));
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /antigravity: offline/u);
    assert.equal(failed.coverage.complete, false);
    assert.equal(strictReads, 0);
});

test("partial discovery and omitted source reports cannot become a complete empty task", async () => {
    for (const mode of ["partial", "omitted", "throw"] as const) {
        const root = path.join(temporary, `empty-${mode}`);
        const provider: CorpusProvider = { async list() { if (mode === "throw") throw new Error("source transport failed"); return []; }, async read() { throw new Error("No candidates"); } };
        if (mode !== "throw") provider.sourceStatuses = () => mode === "omitted" ? [] : [{ source: "dsh", status: "partial", candidateCount: 0, warnings: ["incomplete discovery"] }];
        const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: ["dsh"], query: "hit" }, provider });
        const finished = await waitFor(identity(started, root));
        assert.equal(finished.coverage.complete, false);
        assert.equal(finished.status, mode === "throw" ? "failed" : "partial");
        assert.equal(finished.coverage.sourceStatuses[0]!.status, mode === "partial" ? "partial" : "error");
    }
});

test("stream replacement retracts only the exact source and preserves the other equal-ID result", async () => {
    const root = path.join(temporary, "stream-replacement");
    const codex = projection("codex");
    const claude = projection("claude-code");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: CorpusProvider = {
        async list() { return [codex.conversation, claude.conversation]; },
        async readCached(candidate) { return candidate.source === "codex" ? structuredClone(codex) : null; },
        async read(candidate, control) {
            await control.onChunk!({ conversation: candidate, revision: "claude-v1", messages: [message()], warnings: [] });
            await gate;
            await control.onChunk!({ conversation: candidate, revision: "claude-v2", replaceFromRound: 1, messages: [message("hit veto")], warnings: [] });
            return { ...claude, revision: "claude-v2", messages: [message("hit veto")] };
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: ["codex", "claude-code"], query: "hit", excludeTerms: ["veto"] }, provider });
    const options = identity(started, root);
    try {
        const intermediate = await waitFor(options, status => status.results.length === 2);
        assert.equal(intermediate.results.find(result => result.conversation.source === "claude-code")!.provisional, true);
        release();
        const complete = await waitFor(options);
        assert.equal(complete.status, "completed");
        assert.deepEqual(complete.results.map(result => result.conversation.source), ["codex"]);
        const deltas = await getCorpusSearchStatus({ ...options, afterRevision: intermediate.revision, limit: 100 });
        assert.deepEqual(deltas.changes!.removedConversations, [{ source: "claude-code", conversationId: "shared" }]);
        assert.deepEqual(deltas.changes!.removedConversationKeys, ['["claude-code","shared"]']);
        assert.deepEqual(deltas.changes!.removedConversationIds, []);
        const loaded = await loadCorpusTask(options);
        assert.equal(loaded.records.size, 2);
        assert.equal(loaded.records.get('["codex","shared"]')!.result!.conversation.source, "codex");
        assert.equal(loaded.records.get('["claude-code","shared"]')!.result, null);
    } finally { release(); await waitFor(options); }
});

test("cancellation retracts unverified source only and resumes with the same task ID and source binding", async () => {
    const root = path.join(temporary, "cancel-resume");
    const codex = projection("codex");
    const agy = projection("antigravity");
    let agyReads = 0;
    const provider: CorpusProvider = {
        async list() { return [codex.conversation, agy.conversation]; },
        async readCached(candidate) { return candidate.source === "codex" ? structuredClone(codex) : null; },
        async read(candidate, control) {
            agyReads++;
            if (agyReads === 1) {
                await control.onChunk!({ conversation: candidate, revision: "agy-v1", messages: [message()], warnings: [] });
                while (!control.isCancelled!()) await sleep(3);
                return { ...agy, revision: "pending:agy-v1", complete: false };
            }
            return structuredClone(agy);
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: ["codex", "antigravity"], query: "hit" }, provider });
    const options = identity(started, root);
    try {
        const intermediate = await waitFor(options, status => status.results.length === 2);
        await assert.rejects(cancelCorpusSearch({ ...options, dataChain: "dsh" }), { code: "CORPUS_SOURCE_MISMATCH" });
        await cancelCorpusSearch({ ...options, dataChains: ["codex", "antigravity"] });
        const cancelled = await waitFor(options);
        assert.equal(cancelled.status, "cancelled");
        assert.deepEqual(cancelled.results.map(result => result.conversation.source), ["codex"]);
        const delta = await getCorpusSearchStatus({ ...options, afterRevision: intermediate.revision, limit: 100 });
        assert.deepEqual(delta.changes!.removedConversations, [{ source: "antigravity", conversationId: "shared" }]);
        assert.equal((await resumeCorpusSearch({ ...options, dataChains: ["antigravity", "codex"], provider })).taskId, started.taskId);
        const complete = await waitFor(options);
        assert.equal(complete.status, "completed");
        assert.equal(complete.results.length, 2);
        assert.equal(agyReads, 2);
        assert.equal((await loadCorpusTask(options)).records.size, 2);
    } finally {
        const current = await getCorpusSearchStatus(options);
        if (["running", "cancelling"].includes(current.status)) { await cancelCorpusSearch(options); await waitFor(options); }
    }
});

test("wrong-source projections and partial projections remain isolated from healthy equal IDs", async () => {
    const root = path.join(temporary, "projection-validation");
    const values = [projection("codex"), projection("windsurf"), { ...projection("dsh"), partial: true }];
    const provider: CorpusProvider = { ...providerFor(values), async read(candidate) {
        return structuredClone(candidate.source === "windsurf" ? values[0]! : values.find(value => value.conversation.source === candidate.source)!);
    } };
    const started = await startCorpusSearch({ ownerId: "owner", root, request: { dataChains: ["codex", "windsurf", "dsh"], query: "hit" }, provider });
    const options = identity(started, root);
    const partial = await waitFor(options);
    assert.equal(partial.status, "partial");
    assert.equal(partial.coverage.errorConversations, 1);
    assert.equal(partial.coverage.errors[0]!.source, "windsurf");
    assert.equal(partial.results.find(result => result.conversation.source === "dsh")!.provisional, true);
    assert.equal(partial.results.find(result => result.conversation.source === "codex")!.provisional, false);
    assert.equal((await loadCorpusTask(options)).records.size, 3);
});

test("legacy Codex requests, commits and signed cursors remain readable and resume without changing the task ID or request hash", async () => {
    const root = path.join(temporary, "legacy");
    const options = { root, ownerId: "legacy-owner", taskId: `corpus-${crypto.randomUUID()}` };
    const directory = corpusTaskDirectory(options);
    const request = { query: "hit" };
    const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const state: CorpusTaskStoredState = { version: 1, ownerId: options.ownerId, taskId: options.taskId, requestHash: hash(request), secret: "legacy-secret",
        status: "completed", phase: "idle", revision: 2, discoveryComplete: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        checkpointEveryMessages: 256, checkpointIntervalMs: 250, computeMs: 0, semanticVersion: { query: "literal-corpus/v2", provider: null } };
    const values = [projection("codex", "first"), projection("codex", "second")];
    await writeCorpusJson(path.join(directory, "request.json"), request);
    await writeCorpusJson(path.join(directory, "state.json"), state);
    await writeCorpusJson(path.join(directory, "candidates.json"), values.map(value => value.conversation));
    const results = values.map(value => searchCorpusProjection(value, request)!);
    for (let index = 0; index < values.length; index++) await writeCorpusJson(path.join(directory, "commits", `${String(index + 1).padStart(12, "0")}.json`), {
        revision: index + 1, conversationId: values[index]!.conversation.id, complete: true, result: results[index], scannedMessages: 1,
        mirrorMessagesSkipped: 0, sourceBytes: 10, warnings: [], changed: true, semanticVersion: state.semanticVersion,
    });
    const loaded = await loadCorpusTask(options);
    assert.deepEqual(loaded.request.dataChains, ["codex"]);
    assert.equal(loaded.records.get('["codex","first"]')!.revision, 1);
    const { sourceStatuses: unused, ...legacyCoverage } = corpusCoverage(loaded);
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const snapshot = { snapshotId, revision: 2, status: "completed", results, coverage: legacyCoverage, semanticVersion: state.semanticVersion };
    state.snapshotId = snapshotId;
    state.snapshotHash = hash(snapshot);
    await writeCorpusJson(path.join(directory, "snapshots", `${snapshotId}.json`), snapshot);
    await writeCorpusJson(path.join(directory, "state.json"), state);
    const payload = Buffer.from(JSON.stringify({ version: 1, taskId: options.taskId, owner: corpusOwnerHash(options.ownerId), snapshotId, snapshotHash: state.snapshotHash, offset: 1 })).toString("base64url");
    const cursor = `${payload}.${crypto.createHmac("sha256", state.secret).update(payload).digest("base64url")}`;
    const page = await getCorpusSearchStatus({ ...options, dataChain: "codex", cursor, limit: 1 });
    assert.equal(page.totalMatches, 2);
    assert.equal(page.coverage.sourceStatuses[0]!.source, "codex");
    assert.equal(page.results[0]!.snippets[0]!.source, "codex");
    assert.equal((await resumeCorpusSearch({ ...options, dataChain: "codex", provider: providerFor(values) })).taskId, options.taskId);
    assert.equal((await waitFor(options)).status, "completed");
    assert.equal(hash(await readCorpusJson(path.join(directory, "request.json"))), state.requestHash);
    assert.equal((await loadCorpusTask(options)).records.size, 2);
    const filename = path.join(directory, "commits", "000000000001.json");
    const commit = await readCorpusJson<Record<string, unknown>>(filename);
    await writeCorpusJson(filename, { ...commit, source: "dsh" });
    await assert.rejects(loadCorpusTask(options), { code: "CORPUS_TASK_CORRUPT" });
    await writeCorpusJson(filename, commit);
});

test("preparation coalesces within each source, separates all five index and execution keys, and preserves legacy Codex index recovery", async () => {
    const root = path.join(temporary, "preparations");
    const values = CORPUS_SOURCES.map(source => projection(source));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: CorpusSource[] = [];
    const provider: CorpusProvider = {
        async list(request) { return values.filter(value => request.dataChains!.includes(value.conversation.source)).map(value => value.conversation); },
        async read(candidate) { reads.push(candidate.source); await gate; return structuredClone(values.find(value => value.conversation.source === candidate.source)!); },
    };
    const started: Status[] = [];
    try {
        for (const source of CORPUS_SOURCES) {
            const options = { root, ownerId: "owner", conversationId: "shared", dataChain: source, provider };
            const [first, repeated] = await Promise.all([startCorpusPreparation(options), startCorpusPreparation(options)]);
            assert.equal(first.taskId, repeated.taskId);
            started.push(first);
        }
        assert.equal(new Set(started.map(status => status.taskId)).size, 5);
    } finally { release(); }
    for (const status of started) {
        const complete = await waitFor(identity(status, root));
        const source = complete.request.dataChains![0]!;
        assert.equal(complete.prepared!.source, source);
        assert.equal(complete.status, "completed");
        assert.equal(complete.totalMatches, 0);
        const directory = corpusPreparationDirectory({ root, ownerId: "owner", conversationId: "shared", source });
        const index = await readCorpusJson<{ version: number; dataChain: string; taskId: string }>(path.join(directory, "index.json"));
        assert.equal(index.version, 3);
        assert.equal(index.dataChain, source);
        assert.equal(index.taskId, complete.taskId);
    }
    assert.deepEqual(new Set(reads), new Set(CORPUS_SOURCES));
    const legacyRoot = path.join(temporary, "legacy-preparation");
    const options = { root: legacyRoot, ownerId: "legacy-owner", taskId: `corpus-${crypto.randomUUID()}` };
    const directory = corpusTaskDirectory(options);
    const request = { purpose: "prepare", conversationIds: ["shared"], messageRoles: ["user", "assistant", "subagent"] };
    const state: CorpusTaskStoredState = { version: 1, ownerId: options.ownerId, taskId: options.taskId,
        requestHash: crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex"), secret: "legacy-secret", status: "resumable", phase: "idle",
        revision: 0, discoveryComplete: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        checkpointEveryMessages: 256, checkpointIntervalMs: 250, computeMs: 0 };
    await fs.mkdir(path.join(directory, "commits"), { recursive: true });
    await writeCorpusJson(path.join(directory, "request.json"), request);
    await writeCorpusJson(path.join(directory, "state.json"), state);
    const oldDirectory = corpusPreparationDirectory({ ...options, conversationId: "shared", source: "codex" });
    assert.equal(path.basename(oldDirectory), crypto.createHash("sha256").update("shared").digest("hex"));
    await writeCorpusJson(path.join(oldDirectory, "index.json"), { version: 2, ownerId: options.ownerId, conversationId: "shared", taskId: options.taskId });
    const recovered = await startCorpusPreparation({ root: legacyRoot, ownerId: options.ownerId, conversationId: "shared", provider: providerFor([projection("codex")]) });
    assert.equal(recovered.taskId, options.taskId);
    assert.equal((await waitFor(options)).prepared!.source, "codex");
    const other = await startCorpusPreparation({ root: legacyRoot, ownerId: options.ownerId, conversationId: "shared", dataChain: "dsh", provider: providerFor([projection("dsh")]) });
    assert.notEqual(other.taskId, options.taskId);
    assert.equal((await waitFor(identity(other, legacyRoot))).prepared!.source, "dsh");
});
