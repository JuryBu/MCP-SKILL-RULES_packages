import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { CorpusConversation, CorpusMessage, CorpusProjection, CorpusProvider } from "../src/conversation-corpus-types.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-task-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { startCorpusSearch, getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch } = await import("../src/conversation-corpus-task.js");
const { runCorpusAction } = await import("../src/tools/conversation-corpus-tool.js");
const { corpusTaskDirectory } = await import("../src/conversation-corpus-task-store.js");
type Identity = Parameters<typeof getCorpusSearchStatus>[0];
type Status = Awaited<ReturnType<typeof getCorpusSearchStatus>>;
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function projection(id: string, texts: string[], extra: Partial<CorpusProjection> = {}): CorpusProjection {
    const conversation: CorpusConversation = { id, title: id, workspace: "C:/project/demo", source: "codex" };
    const messages: CorpusMessage[] = texts.map((text, index) => ({
        id: `${id}-message-${index}`, round: index + 1, role: "user", text,
        timestamp: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`, position: { ordinal: index },
    }));
    return { conversation, revision: `${id}-v1`, complete: true, warnings: [], messages, sourceBytes: 100, ...extra };
}

function providerFor(projections: CorpusProjection[]): CorpusProvider {
    return {
        async list() { return projections.map(input => input.conversation); },
        async read(candidate) { return projections.find(input => input.conversation.id === candidate.id)!; },
    };
}

function identity(status: Status, root: string): Identity { return { ownerId: status.ownerId, taskId: status.taskId, root }; }

async function waitFor(options: Identity, predicate: (status: Status) => boolean = status => !["running", "cancelling"].includes(status.status)): Promise<Status> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const status = await getCorpusSearchStatus({ ...options, waitMs: 50 });
        if (predicate(status)) return status;
    }
    throw new Error("Corpus task did not reach the expected state in 10 seconds");
}

test("complete search to authenticated stable pagination scans every candidate", async () => {
    const root = path.join(temporary, "pagination");
    const projections = [projection("c", ["cache cache cache"]), projection("b", ["cache cache"]), projection("a", ["cache"])];
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "cache", sort: "occurrences" }, provider: providerFor(projections) });
    const options = identity(started, root);
    const finished = await waitFor(options);
    assert.equal(finished.status, "completed");
    assert.equal(finished.coverage.complete, true);
    assert.equal(finished.coverage.committedConversations, 3);
    assert.equal(finished.coverage.scannedMessages, 3);
    const first = await getCorpusSearchStatus({ ...options, limit: 1 });
    assert.equal(first.totalMatches, 3);
    assert.equal(first.results[0].conversation.id, "c");
    assert.ok(first.nextCursor);
    const second = await getCorpusSearchStatus({ ...options, limit: 1, cursor: first.nextCursor });
    const third = await getCorpusSearchStatus({ ...options, limit: 1, cursor: second.nextCursor });
    assert.deepEqual([first, second, third].map(page => page.results[0].conversation.id), ["c", "b", "a"]);
    assert.equal(first.snapshotId, third.snapshotId);
    assert.equal(third.nextCursor, undefined);
    assert.equal(third.hasMore, false);
    await assert.rejects(getCorpusSearchStatus({ ...options, cursor: `${first.nextCursor}corrupt` }), { code: "CORPUS_CURSOR_INVALID" });
    await assert.rejects(getCorpusSearchStatus({ ...options, afterRevision: finished.revision + 1 }), { code: "CORPUS_REVISION_INVALID" });
    await assert.rejects(getCorpusSearchStatus({ ...options, cursor: first.nextCursor, afterRevision: 0 }), { code: "CORPUS_CURSOR_INVALID" });
    assert.ok(finished.timings.queryComputeMs >= 0);
});

test("real tool status accepts 45 seconds and drains deltas through its explicit continuation", async () => {
    const root = path.join(temporary, "tool-wait");
    const provider = providerFor([projection("a", ["hit"]), projection("b", ["hit"]), projection("c", ["hit"])]);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider });
    await waitFor(identity(started, root));
    const api = {
        provider,
        start: (options: Parameters<typeof startCorpusSearch>[0]) => startCorpusSearch({ ...options, root }),
        status: (options: Identity) => getCorpusSearchStatus({ ...options, root }),
        cancel: (options: Identity) => cancelCorpusSearch({ ...options, root }),
        resume: (options: Identity & { provider: CorpusProvider }) => resumeCorpusSearch({ ...options, root }),
        readRounds: async () => projection("a", []), readFast: async () => projection("a", []),
        prepareCache: async () => { throw new Error("Status must not start preparation"); },
    };
    const ids: string[] = [];
    let afterRevision = 0;
    for (;;) {
        const page = await runCorpusAction({ action: "search_all_status", conversationId: "owner-a", taskId: started.taskId,
            waitSeconds: 45, limit: 1, afterRevision }, api) as Status & { nextAfterRevision: number };
        ids.push(...page.changes!.upserts.map(item => item.conversation.id));
        assert.equal(page.nextAfterRevision, page.changes!.throughRevision);
        afterRevision = page.nextAfterRevision;
        if (!page.changes!.hasMore) break;
    }
    assert.deepEqual(ids, ["a", "b", "c"]);
    await assert.rejects(getCorpusSearchStatus({ ...identity(started, root), waitMs: 45001 }), /45000/);
});

test("provider semantic migration retracts old complete results before revalidation and preserves old snapshot pages", async () => {
    const root = path.join(temporary, "semantic-migration");
    const inputs = [projection("a", ["hit"]), projection("b", ["hit hit"])];
    const oldProvider = { ...providerFor(inputs), semanticVersion: "fixture-body/v1" };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: oldProvider });
    const options = identity(started, root);
    const old = await waitFor(options);
    const oldPage = await getCorpusSearchStatus({ ...options, limit: 1 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const reads: string[] = [];
    await resumeCorpusSearch({ ...options, provider: {
        semanticVersion: "fixture-body/v2",
        async list() { throw new Error("Scope remains frozen"); },
        async read(candidate) { reads.push(candidate.id); await gate; return projection(candidate.id, ["clean"]); },
    } });
    try {
        const pending = await waitFor(options, status => status.progress?.phase === "reading");
        assert.equal(pending.totalMatches, 0);
        assert.equal(pending.coverage.committedConversations, 0);
        assert.equal(pending.semanticVersion.provider, "fixture-body/v2");
        const retractions = await getCorpusSearchStatus({ ...options, afterRevision: old.revision });
        assert.deepEqual(retractions.changes?.removedConversationIds.sort(), ["a", "b"]);
        assert.deepEqual(retractions.changes?.upserts, []);
        const history = await getCorpusSearchStatus({ ...options, afterRevision: 0, limit: 1 });
        assert.deepEqual(history.changes?.upserts, []);
        const frozen = await getCorpusSearchStatus({ ...options, cursor: oldPage.nextCursor });
        assert.equal(frozen.results[0].conversation.id, "b");
        assert.equal(frozen.viewSemanticVersion.provider, "fixture-body/v1");
        assert.equal(frozen.semanticVersion.provider, "fixture-body/v2");
    } finally { release(); }
    const complete = await waitFor(options);
    assert.equal(complete.status, "completed");
    assert.equal(complete.totalMatches, 0);
    assert.equal(complete.coverage.scannedMessages, 2);
    assert.equal(complete.viewSemanticVersion.provider, "fixture-body/v2");
    assert.deepEqual(reads, ["a", "b"]);
});

test("legacy unknown query and provider versions remain readable until explicit same-ID semantic resume", async () => {
    const root = path.join(temporary, "legacy-semantics");
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: providerFor([projection("a", ["hit"])]) });
    const options = identity(started, root);
    await waitFor(options);
    await sleep(20);
    const directory = corpusTaskDirectory(options);
    const statePath = path.join(directory, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    delete state.semanticVersion;
    for (const name of fs.readdirSync(path.join(directory, "commits"))) {
        const filename = path.join(directory, "commits", name);
        const commit = JSON.parse(fs.readFileSync(filename, "utf8"));
        delete commit.semanticVersion;
        fs.writeFileSync(filename, JSON.stringify(commit), "utf8");
    }
    const snapshotPath = path.join(directory, "snapshots", `${state.snapshotId}.json`);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    delete snapshot.semanticVersion;
    const bytes = JSON.stringify(snapshot);
    fs.writeFileSync(snapshotPath, bytes, "utf8");
    state.snapshotHash = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
    const legacy = await getCorpusSearchStatus(options);
    assert.deepEqual(legacy.semanticVersion, { query: null, provider: null });
    assert.equal(legacy.totalMatches, 1);
    let reads = 0;
    const resumed = await resumeCorpusSearch({ ...options, provider: {
        semanticVersion: "fixture-body/v2", async list() { throw new Error("Frozen scope"); },
        async read() { reads++; return projection("a", ["clean"]); },
    } });
    assert.equal(resumed.taskId, started.taskId);
    const complete = await waitFor(options);
    assert.equal(complete.totalMatches, 0);
    assert.equal(reads, 1);
    assert.equal(complete.semanticVersion.provider, "fixture-body/v2");
    assert.ok(complete.semanticVersion.query);
});

test("first stream chunk is visible before final read, later exclusion retracts it and verified projection replaces it", async () => {
    const root = path.join(temporary, "stream-visible");
    let releaseFirst!: () => void;
    let releaseFinal!: () => void;
    const firstGate = new Promise<void>(resolve => releaseFirst = resolve);
    const finalGate = new Promise<void>(resolve => releaseFinal = resolve);
    const input = projection("a", ["hit", "veto"]);
    const provider: CorpusProvider = {
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "pending:first", messages: [input.messages[0]], sourceBytes: 25 });
            await firstGate;
            await control.onChunk?.({ ...input, revision: "pending:second", messages: [input.messages[1]], sourceBytes: 50 });
            await finalGate;
            return { ...input, revision: "verified-v1" };
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit", excludeTerms: ["veto"] }, provider });
    const options = identity(started, root);
    try {
        const provisional = await waitFor(options, status => status.totalMatches === 1);
        assert.equal(provisional.results[0].provisional, true);
        assert.match(provisional.results[0].sourceRevision, /^pending:/);
        assert.equal(provisional.coverage.complete, false);
        assert.equal(provisional.coverage.scannedMessages, 1);
        releaseFirst();
        const retracted = await waitFor(options, status => status.revision > provisional.revision && status.totalMatches === 0);
        const changes = await getCorpusSearchStatus({ ...options, afterRevision: provisional.revision });
        assert.deepEqual(changes.changes?.removedConversationIds, ["a"]);
        assert.equal(retracted.coverage.scannedMessages, 2);
    } finally { releaseFirst(); releaseFinal(); }
    const complete = await waitFor(options);
    assert.equal(complete.status, "completed");
    assert.equal(complete.totalMatches, 0);
    assert.equal(complete.coverage.scannedMessages, 2);
});

test("source verification failure retracts streamed hits and same-ID resume uses verified messages", async () => {
    const root = path.join(temporary, "stream-failure");
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = projection("a", ["hit"]);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: {
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "pending:unverified" });
            await gate;
            throw new Error("Fixture source verification failed");
        },
    } });
    const options = identity(started, root);
    const provisional = await waitFor(options, status => status.totalMatches === 1);
    release();
    const failed = await waitFor(options);
    assert.equal(failed.status, "partial");
    assert.equal(failed.totalMatches, 0);
    assert.equal(failed.coverage.scannedMessages, 0);
    assert.equal(failed.coverage.errorConversations, 1);
    assert.deepEqual((await getCorpusSearchStatus({ ...options, afterRevision: provisional.revision })).changes?.removedConversationIds, ["a"]);
    await resumeCorpusSearch({ ...options, provider: providerFor([input]) });
    const complete = await waitFor(options);
    assert.equal(complete.results[0].provisional, false);
    assert.equal(complete.results[0].sourceRevision, input.revision);
});

test("cancellation retracts current chunks immediately and ignores late provider callbacks and final output", async () => {
    const root = path.join(temporary, "stream-cancel");
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = projection("a", ["hit"]);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: {
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "pending:early" });
            await gate;
            await control.onChunk?.({ ...input, revision: "pending:late", replaceFromRound: 1 });
            control.onProgress?.({ phase: "late", bytes: 9999 });
            return input;
        },
    } });
    const options = identity(started, root);
    await waitFor(options, status => status.totalMatches === 1);
    const cancelled = await cancelCorpusSearch(options);
    assert.equal(cancelled.status, "cancelling");
    assert.equal(cancelled.totalMatches, 0);
    assert.equal(cancelled.coverage.scannedMessages, 0);
    const revision = cancelled.revision;
    release();
    const complete = await waitFor(options);
    assert.equal(complete.status, "cancelled");
    assert.equal(complete.totalMatches, 0);
    assert.equal(complete.revision, revision);
});

test("streamed revisions remain pending and final verification recomputes exact counts instead of adding them", async () => {
    const root = path.join(temporary, "stream-final-replacement");
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = projection("a", ["hit hit"]);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: {
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "source-v1", messages: projection("a", ["hit hit hit hit"]).messages });
            await gate;
            return { ...input, revision: "source-v1" };
        },
    } });
    const options = identity(started, root);
    const pending = await waitFor(options, status => status.totalMatches === 1);
    assert.equal(pending.results[0].occurrences, 4);
    assert.equal(pending.results[0].sourceRevision, "pending:source-v1");
    release();
    const final = await waitFor(options);
    assert.equal(final.results[0].occurrences, 2);
    assert.equal(final.results[0].provisional, false);
    assert.equal(final.results[0].sourceRevision, "source-v1");
    assert.equal(final.coverage.scannedMessages, 1);
});

test("stream replaceFromRound retracts old terms and rejects an unverified complete final revision", async () => {
    const root = path.join(temporary, "stream-replacement");
    let releaseTail!: () => void;
    let releaseFinal!: () => void;
    const tail = new Promise<void>(resolve => releaseTail = resolve);
    const finish = new Promise<void>(resolve => releaseFinal = resolve);
    const input = projection("a", ["hit"]);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: {
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "pending:old" });
            await tail;
            await control.onChunk?.({ ...input, revision: "pending:new", replaceFromRound: 1, messages: projection("a", ["clean"]).messages });
            await finish;
            return { ...input, revision: "pending:unverified-final" };
        },
    } });
    const options = identity(started, root);
    const first = await waitFor(options, status => status.totalMatches === 1);
    releaseTail();
    await waitFor(options, status => status.revision > first.revision && status.totalMatches === 0);
    releaseFinal();
    const failed = await waitFor(options);
    assert.equal(failed.status, "partial");
    assert.equal(failed.totalMatches, 0);
    assert.match(failed.coverage.errors[0].message, /verified source revision/);
});

test("dynamic revisions update counts and retract a late excluded conversation", async () => {
    const root = path.join(temporary, "deltas");
    const started = await startCorpusSearch({
        ownerId: "owner-a", root, request: { query: "allow", excludeTerms: ["veto"] },
        provider: providerFor([projection("one", ["allow", "allow", "veto"])]), checkpointEveryMessages: 1, checkpointIntervalMs: 0,
    });
    const options = identity(started, root);
    const finished = await waitFor(options);
    assert.equal(finished.totalMatches, 0);
    assert.equal(finished.coverage.committedConversations, 1);
    const materialized = new Map<string, number>();
    const occurrences: number[] = [];
    let afterRevision = 0;
    let sawRetraction = false;
    while (true) {
        const page = await getCorpusSearchStatus({ ...options, afterRevision, limit: 1 });
        for (const result of page.changes!.upserts) {
            materialized.set(result.conversation.id, result.occurrences);
            occurrences.push(result.occurrences);
        }
        for (const id of page.changes!.removedConversationIds) { sawRetraction = true; materialized.delete(id); }
        afterRevision = page.changes!.throughRevision;
        if (!page.changes!.hasMore) break;
    }
    assert.deepEqual(occurrences, [1, 2]);
    assert.equal(sawRetraction, true);
    assert.equal(materialized.size, 0);
    assert.equal(afterRevision, finished.revision);
});

test("two owners cannot read, cancel, resume or reuse each other's cursor", async () => {
    const root = path.join(temporary, "owners");
    const provider = providerFor([projection("one", ["hit"]), projection("two", ["hit"])]);
    const first = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider });
    const second = await startCorpusSearch({ ownerId: "owner-b", root, request: { query: "hit" }, provider });
    await Promise.all([waitFor(identity(first, root)), waitFor(identity(second, root))]);
    const wrong = { ownerId: "owner-b", taskId: first.taskId, root };
    for (const call of [() => getCorpusSearchStatus(wrong), () => cancelCorpusSearch(wrong), () => resumeCorpusSearch({ ...wrong, provider })]) {
        await assert.rejects(call(), { code: "CORPUS_TASK_NOT_FOUND" });
    }
    const page = await getCorpusSearchStatus({ ...identity(first, root), limit: 1 });
    await assert.rejects(getCorpusSearchStatus({ ...identity(second, root), cursor: page.nextCursor }), { code: "CORPUS_CURSOR_INVALID" });
    await assert.rejects(startCorpusSearch({ ownerId: " ", root, request: { query: "hit" }, provider }), { code: "CORPUS_OWNER_REQUIRED" });
});

test("cancel and same-ID resume preserve committed conversations without recounting", async () => {
    const root = path.join(temporary, "resume");
    const projections = [projection("a", ["hit"]), projection("b", ["hit hit"])];
    const reads = new Map<string, number>();
    let listCount = 0;
    let hold = true;
    const provider: CorpusProvider = {
        async list() { listCount++; return projections.map(input => input.conversation); },
        async read(candidate, control) {
            reads.set(candidate.id, (reads.get(candidate.id) ?? 0) + 1);
            while (candidate.id === "b" && hold && !control.isCancelled?.()) await sleep(2);
            if (control.isCancelled?.()) throw new Error("Cancelled provider read");
            return projections.find(input => input.conversation.id === candidate.id)!;
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider });
    const options = identity(started, root);
    await waitFor(options, status => status.coverage.committedConversations === 1);
    await cancelCorpusSearch(options);
    const cancelled = await waitFor(options);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.coverage.complete, false);
    hold = false;
    const resumed = await resumeCorpusSearch({ ...options, provider });
    assert.equal(resumed.taskId, started.taskId);
    const finished = await waitFor(options);
    assert.equal(finished.status, "completed");
    assert.equal(finished.coverage.scannedMessages, 2);
    assert.equal(finished.results.reduce((total, result) => total + result.occurrences, 0), 3);
    assert.equal(listCount, 1);
    assert.equal(reads.get("a"), 1);
    await resumeCorpusSearch({ ...options, provider });
    assert.equal(reads.get("a"), 1);
});

test("partial projection is replaced on resume and old snapshot pages stay frozen", async () => {
    const root = path.join(temporary, "replacement");
    let changed = false;
    const first = projection("a", ["hit hit"], { complete: false, warnings: ["Source is partial"] });
    first.messages[0].timestamp = "2026-02-01T00:00:00Z";
    const second = projection("b", ["hit"]);
    const provider: CorpusProvider = {
        async list() { return [first.conversation, second.conversation]; },
        async read(candidate) { return candidate.id === "b" ? second : changed ? projection("a", ["hit veto"]) : first; },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit", excludeTerms: ["veto"] }, provider });
    const options = identity(started, root);
    const partial = await waitFor(options);
    assert.equal(partial.status, "partial");
    assert.equal(partial.coverage.complete, false);
    const firstPage = await getCorpusSearchStatus({ ...options, limit: 1 });
    assert.equal(firstPage.results[0].conversation.id, "a");
    changed = true;
    await resumeCorpusSearch({ ...options, provider });
    const final = await waitFor(options);
    assert.equal(final.status, "completed");
    assert.deepEqual(final.results.map(result => result.conversation.id), ["b"]);
    assert.equal(final.coverage.scannedMessages, 2);
    const delta = await getCorpusSearchStatus({ ...options, afterRevision: partial.revision });
    assert.deepEqual(delta.changes!.removedConversationIds, ["a"]);
    const oldPage = await getCorpusSearchStatus({ ...options, cursor: firstPage.nextCursor });
    assert.equal(oldPage.snapshotId, firstPage.snapshotId);
    assert.equal(oldPage.totalMatches, 2);
    assert.equal(oldPage.results[0].conversation.id, "b");
    const ownerDirectory = fs.readdirSync(root)[0];
    const snapshotFile = path.join(root, ownerDirectory, started.taskId, "snapshots", `${firstPage.snapshotId}.json`);
    const oldSnapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    oldSnapshot.results[0].occurrences = 999;
    fs.writeFileSync(snapshotFile, JSON.stringify(oldSnapshot), "utf8");
    await assert.rejects(getCorpusSearchStatus({ ...options, cursor: firstPage.nextCursor }), { code: "CORPUS_TASK_CORRUPT" });
});

test("reader errors and wrong identities remain uncovered rather than silently complete", async () => {
    const root = path.join(temporary, "errors");
    const inputs = [projection("a", ["hit"]), projection("b", ["hit"]), projection("c", ["hit"])];
    const provider: CorpusProvider = {
        async list() { return inputs.map(input => input.conversation); },
        async read(candidate) {
            if (candidate.id === "b") throw new Error("Fixture read failure");
            return candidate.id === "c" ? inputs[0] : inputs[0];
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider });
    const status = await waitFor(identity(started, root));
    assert.equal(status.status, "partial");
    assert.equal(status.coverage.complete, false);
    assert.equal(status.coverage.committedConversations, 1);
    assert.equal(status.coverage.errorConversations, 2);
    assert.deepEqual(status.coverage.errors.map(error => error.conversationId), ["b", "c"]);
});

test("listing failure is explicit and resumes the same discovery", async () => {
    const root = path.join(temporary, "list-error");
    let failing = true;
    const provider: CorpusProvider = {
        async list() { if (failing) throw new Error("Fixture discovery failure"); return [projection("one", ["hit"]).conversation]; },
        async read() { return projection("one", ["hit"]); },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider });
    const options = identity(started, root);
    const failed = await waitFor(options);
    assert.equal(failed.status, "failed");
    assert.equal(failed.coverage.discoveryComplete, false);
    assert.match(failed.error!, /discovery failure/);
    failing = false;
    await resumeCorpusSearch({ ...options, provider });
    assert.equal((await waitFor(options)).status, "completed");
});

test("filters, duplicate candidates and caller request mutation do not expand frozen scope", async () => {
    const root = path.join(temporary, "scope");
    const inputs = [projection("a", ["hit"]), projection("b", ["hit"])];
    const request = { query: "hit", conversationIds: ["a"], workspaces: ["C:/project"], workspaceMode: "under" as const };
    const base = providerFor([inputs[0], inputs[0], inputs[1]]);
    const provider: CorpusProvider = {
        async list(providerRequest, control) {
            providerRequest.conversationIds?.push("b");
            return base.list(providerRequest, control);
        },
        async read(candidate, control) {
            control.messageRoles?.pop();
            return base.read(candidate, control);
        },
    };
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request, provider });
    request.conversationIds.push("b");
    const finished = await waitFor(identity(started, root));
    assert.equal(finished.coverage.candidateConversations, 1);
    assert.deepEqual(finished.results.map(result => result.conversation.id), ["a"]);
});

test("restart reports resumable and continues from durable completed commits", async () => {
    const root = path.join(temporary, "restart");
    const moduleUrl = new URL("../src/conversation-corpus-task.ts", import.meta.url).href;
    const script = `
        const { startCorpusSearch, getCorpusSearchStatus } = await import(${JSON.stringify(moduleUrl)});
        const root = ${JSON.stringify(root)};
        const candidate = id => ({id,title:id,workspace:'C:/fixture',source:'codex'});
        const provider = {
            async list(){return [candidate('a'),candidate('b')]},
            async read(conversation){
                if(conversation.id==='b') return new Promise(()=>{});
                return {conversation,revision:'v1',complete:true,warnings:[],messages:[{id:'a-one',round:1,role:'user',text:'hit',position:{ordinal:1}}]};
            }
        };
        const task = await startCorpusSearch({ownerId:'restart-owner',root,request:{query:'hit'},provider});
        for(let attempt=0;attempt<500;attempt++){
            const status=await getCorpusSearchStatus({ownerId:task.ownerId,taskId:task.taskId,root});
            if(status.coverage.committedConversations===1){console.log('TASK='+task.taskId);process.exit(0)}
            await new Promise(resolve=>setTimeout(resolve,5));
        }
        process.exit(2);
    `;
    const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => stdout += chunk);
        child.stderr.on("data", chunk => stderr += chunk);
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`Restart fixture exit ${code}: ${stderr}`)));
    });
    const taskId = output.match(/TASK=(corpus-[a-f0-9-]+)/)![1];
    const options = { ownerId: "restart-owner", taskId, root };
    const recovered = await getCorpusSearchStatus(options);
    assert.equal(recovered.status, "resumable");
    assert.equal(recovered.coverage.committedConversations, 1);
    const reads: string[] = [];
    await resumeCorpusSearch({ ...options, provider: {
        async list() { throw new Error("Frozen candidates must not be rediscovered"); },
        async read(candidate) { reads.push(candidate.id); return projection(candidate.id, ["hit hit"]); },
    } });
    const finished = await waitFor(options);
    assert.equal(finished.status, "completed");
    assert.deepEqual(reads, ["b"]);
    assert.equal(finished.coverage.scannedMessages, 2);
    assert.equal(finished.results.reduce((total, result) => total + result.occurrences, 0), 3);
    assert.equal(finished.results.find(result => result.conversation.id === "a")!.latestMatchAt, null);
});

test("concurrent resumes acquire one lease and never duplicate a read", async () => {
    const root = path.join(temporary, "concurrent-resume");
    const input = projection("one", ["hit"], { complete: false });
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: providerFor([input]) });
    const options = identity(started, root);
    await waitFor(options);
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>(resolve => releaseRead = resolve);
    let reads = 0;
    const provider: CorpusProvider = {
        async list() { throw new Error("Must use frozen candidates"); },
        async read() { reads++; await gate; return { ...input, complete: true }; },
    };
    const attempts = await Promise.allSettled([resumeCorpusSearch({ ...options, provider }), resumeCorpusSearch({ ...options, provider })]);
    releaseRead!();
    const finished = await waitFor(options);
    assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
    assert.equal(finished.status, "completed");
    assert.equal(reads, 1);
});

test("cancellation waits for a noncooperative provider and does not commit its late result", async () => {
    const root = path.join(temporary, "late-cancel");
    const input = projection("one", ["hit"]);
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>(resolve => releaseRead = resolve);
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: {
        async list() { return [input.conversation]; },
        async read() { await gate; return input; },
    } });
    const options = identity(started, root);
    await waitFor(options, status => status.progress?.phase === "reading");
    const cancelling = await cancelCorpusSearch(options);
    assert.equal(cancelling.status, "cancelling");
    assert.equal(cancelling.coverage.committedConversations, 0);
    releaseRead!();
    const finished = await waitFor(options);
    assert.equal(finished.status, "cancelled");
    assert.equal(finished.totalMatches, 0);
    assert.equal(finished.coverage.committedConversations, 0);
});

test("request corruption and lost commits are surfaced explicitly", async () => {
    const root = path.join(temporary, "corruption");
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: providerFor([projection("one", ["hit"])]) });
    const options = identity(started, root);
    await waitFor(options);
    await sleep(20);
    const ownerDirectory = fs.readdirSync(root)[0];
    const directory = path.join(root, ownerDirectory, started.taskId);
    const filename = path.join(directory, "request.json");
    const original = fs.readFileSync(filename, "utf8");
    fs.writeFileSync(filename, JSON.stringify({ query: "different" }), "utf8");
    await assert.rejects(getCorpusSearchStatus(options), { code: "CORPUS_TASK_CORRUPT" });
    fs.writeFileSync(filename, original, "utf8");
    const commits = path.join(directory, "commits");
    fs.rmSync(path.join(commits, fs.readdirSync(commits)[0]));
    await assert.rejects(getCorpusSearchStatus({ ...options, afterRevision: 0 }), { code: "CORPUS_TASK_CORRUPT" });
});

test("final snapshot pagination does not require replaying the commit ledger", async () => {
    const root = path.join(temporary, "fast-snapshot");
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: providerFor([projection("a", ["hit"]), projection("b", ["hit"])]) });
    const options = identity(started, root);
    await waitFor(options);
    await sleep(20);
    const ownerDirectory = fs.readdirSync(root)[0];
    const commits = path.join(root, ownerDirectory, started.taskId, "commits");
    fs.renameSync(commits, `${commits}-unavailable`);
    const first = await getCorpusSearchStatus({ ...options, limit: 1 });
    const second = await getCorpusSearchStatus({ ...options, limit: 1, cursor: first.nextCursor });
    assert.equal(first.snapshotId, second.snapshotId);
    assert.equal(second.totalMatches, 2);
});

test("snapshot corruption is rejected before returning complete results", async () => {
    const root = path.join(temporary, "snapshot-corruption");
    const started = await startCorpusSearch({ ownerId: "owner-a", root, request: { query: "hit" }, provider: providerFor([projection("a", ["hit"])]) });
    const options = identity(started, root);
    const finished = await waitFor(options);
    await sleep(20);
    const ownerDirectory = fs.readdirSync(root)[0];
    const filename = path.join(root, ownerDirectory, started.taskId, "snapshots", `${finished.snapshotId}.json`);
    const snapshot = JSON.parse(fs.readFileSync(filename, "utf8"));
    snapshot.results[0].occurrences = 999;
    fs.writeFileSync(filename, JSON.stringify(snapshot), "utf8");
    await assert.rejects(getCorpusSearchStatus(options), { code: "CORPUS_TASK_CORRUPT" });
});
