import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { CorpusConversation, CorpusProjection, CorpusRangeProvider, CorpusReadControl } from "../src/conversation-corpus-types.js";
import type { ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan61-verified-alias-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const canonical = "verified-falcon";
const alias = "11111111-2222-4333-8444-555555555555";
const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,title TEXT,last_activity_at INTEGER,metadata TEXT);
CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));`);
database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(canonical, 8, "Same title", 1, "{}");
const insert = database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
for (let index = 1; index <= 4; index++) {
    insert.run(canonical, index * 2 - 1, index === 1 ? null : index * 2 - 2,
        JSON.stringify({ role: "user", content: `needle question ${index}`, metadata: { extensions: { "chisel/client-message-id": `shared-${index}` }, is_user_input: true } }), "{}", index);
    insert.run(canonical, index * 2, index * 2 - 1, JSON.stringify({ role: "assistant", content: `answer ${index}` }), "{}", index);
}
database.close();
const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${alias}.db`));
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES('info',?)").run(JSON.stringify({ title: "Same title" }));
desktop.prepare("INSERT INTO meta VALUES('truncated','0')").run();
for (let index = 1; index <= 4; index++) desktop.prepare("INSERT INTO messages VALUES(?,?,?)").run(index, "user_message", JSON.stringify({
    kind: "user_message", id: `user:shared-${index}`, content: [{ content: { type: "text", text: `needle question ${index}` },
        _meta: { "cognition.ai/clientMessageId": `shared-${index}` } }],
}));
desktop.close();

const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.js");
const { createMultiCorpusProvider } = await import("../src/conversation-corpus-reader-multi.js");
const { verifiedCorpusIdentity } = await import("../src/conversation-host-binary.js");
const { startCorpusSearch, getCorpusSearchStatus } = await import("../src/conversation-corpus-task.js");
const { loadCorpusTask, corpusResultRecords } = await import("../src/conversation-corpus-task-store.js");
const { executeHostProgressivePreparation } = await import("../src/conversation-progressive-worker-hosts.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
const { searchCorpusProjection } = await import("../src/conversation-corpus-search.js");
const { runCorpusAction } = await import("../src/tools/conversation-corpus-tool.js");
const provider = () => createMultiCorpusProvider({ providers: { windsurf: createHostCorpusProvider("windsurf") } });
after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("plan61-verified-alias-"));
    fs.rmSync(root, { recursive: true, force: true });
});

async function readAlias(): Promise<{ candidate: CorpusConversation; projection: CorpusProjection }> {
    const source = provider();
    const [candidate] = await source.list({ dataChains: ["windsurf"], conversationIds: [alias] }, {});
    assert.equal(candidate!.id, alias);
    assert.equal(verifiedCorpusIdentity(candidate!), undefined);
    return { candidate: candidate!, projection: await source.read(candidate!, {}) };
}

test("real SQLite Desktop UUID resolves through multi read/chunks/ranges to the verified CLI identity", async () => {
    const source = provider();
    const [candidate] = await source.list({ dataChains: ["windsurf"], conversationIds: [alias] }, {});
    const chunks: string[] = [];
    const full = await source.read(candidate!, { onChunk: chunk => { chunks.push(chunk.conversation.id); } });
    assert.equal(full.conversation.id, canonical);
    assert.deepEqual(chunks, [canonical]);
    assert.ok(verifiedCorpusIdentity(full.conversation)?.aliases.includes(alias));
    const tail = await source.readFast(candidate!, { lastRounds: 1 });
    assert.deepEqual(tail.rounds?.map(round => round.roundIndex), [4]);
    assert.equal(tail.revision, full.revision);
    const reopened = await provider().readRounds(candidate!, { revision: full.revision, startRound: 2, endRound: 2 });
    assert.equal(reopened.conversation.id, canonical);
    assert.deepEqual(reopened.rounds?.map(round => round.roundIndex), [2]);
    assert.equal(searchCorpusProjection(full, { query: "needle", conversationIds: [alias] })?.occurrences, 4);
    for (const target of [alias, canonical]) {
        const expanded = await runCorpusAction({ action: "read_hit", conversationId: "alias-owner", dataChain: "windsurf",
            conversationIds: [target], sourceRevision: full.revision, startRound: 2, endRound: 2 }) as CorpusProjection;
        assert.equal(expanded.conversation.id, canonical);
        assert.equal(expanded.revision, full.revision);
        assert.deepEqual(expanded.rounds?.map(round => round.roundIndex), [2]);
    }
    console.log(JSON.stringify({ alias, canonical: full.conversation.id, verified: true, chunks, occurrences: 4, reopenedRound: 2 }));
});

test("provider-supplied aliases, serialized evidence, changed same-source IDs and foreign chunks stay rejected", async () => {
    const { candidate, projection } = await readAlias();
    for (const actual of [JSON.parse(JSON.stringify(projection.conversation)),
        { ...projection.conversation, id: "wrong-canonical", canonicalId: "wrong-canonical", aliases: [alias] },
        { ...projection.conversation, source: "dsh" }]) {
        const forged = { ...projection, conversation: { ...actual, verifiedIdentity: verifiedCorpusIdentity(projection.conversation) } };
        const injected: CorpusRangeProvider = { list: async () => [candidate], read: async () => forged,
            readFast: async () => forged, readRounds: async () => forged };
        const wrapped = createMultiCorpusProvider({ providers: { windsurf: injected } });
        await assert.rejects(wrapped.read(candidate, {}), /source identity changed/u);
        await assert.rejects(wrapped.readFast(candidate, {}), /source identity changed/u);
        injected.read = async (_candidate, control) => { await control.onChunk?.({ ...forged, verified: true }); return projection; };
        let accepted = false;
        await assert.rejects(wrapped.read(candidate, { onChunk: () => { accepted = true; } }), /source identity changed/u);
        assert.equal(accepted, false);
    }
});

test("UUID and canonical queried together produce one final result without doubled occurrences and reopen intact", async () => {
    const taskRoot = path.join(root, "tasks");
    const started = await startCorpusSearch({ ownerId: "alias-owner", root: taskRoot, provider: provider(),
        request: { dataChains: ["windsurf"], conversationIds: [alias, canonical], query: "needle" } });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root: taskRoot, dataChain: "windsurf" as const };
    let status = started;
    for (let attempt = 0; attempt < 100 && ["running", "cancelling"].includes(status.status); attempt++) status = await getCorpusSearchStatus({ ...identity, waitMs: 50 });
    assert.ok(["completed", "partial"].includes(status.status), JSON.stringify(status));
    assert.equal(status.error, undefined);
    assert.equal(status.coverage.candidateConversations, 2);
    assert.equal(status.coverage.committedConversations, 2);
    assert.equal(status.totalMatches, 1);
    assert.equal(status.results[0]!.occurrences, 4);
    assert.equal(status.results[0]!.conversation.id, canonical);
    assert.ok(status.results[0]!.conversation.aliases?.includes(alias));
    assert.ok(status.results[0]!.snippets.every(snippet => snippet.conversationId === canonical && snippet.source === "windsurf"));
    const loaded = await loadCorpusTask(identity);
    assert.equal(loaded.records.size, 2);
    assert.equal(corpusResultRecords(loaded).length, 1);
    const records = [...loaded.records.values()];
    const changed = structuredClone(records[1]!);
    changed.verifiedIdentity!.evidence = "different-evidence";
    loaded.records.set([...loaded.records.keys()][1]!, changed);
    assert.equal(corpusResultRecords(loaded).length, 2);
    changed.verifiedIdentity = records[1]!.verifiedIdentity;
    changed.result!.sourceRevision = "different-revision";
    assert.equal(corpusResultRecords(loaded).length, 2);
    changed.result!.sourceRevision = records[1]!.result!.sourceRevision;
    changed.verifiedIdentity = undefined;
    assert.equal(corpusResultRecords(loaded).length, 2);
    const reopened = await getCorpusSearchStatus(identity);
    assert.equal(reopened.totalMatches, 1);
    assert.equal(reopened.results[0]!.occurrences, 4);
    await assert.rejects(getCorpusSearchStatus({ ...identity, dataChain: "dsh" }), { code: "CORPUS_SOURCE_MISMATCH" });
    console.log(JSON.stringify({ candidates: 2, committed: 2, finalConversations: status.totalMatches, occurrences: status.results[0]!.occurrences, reopened: true }));
});

test("real UUID progressive publication keeps requested source binding, canonical evidence and old refs on warm reopen", async () => {
    const payload: ProgressiveTaskPayload = { version: 1, taskId: "progressive-11111111-1111-4111-8111-111111111111", directory: path.join(root, "progressive"),
        request: { ownerId: "alias-owner", conversationId: alias, dataChain: "windsurf", initialRounds: 1,
            buildFull: true, direction: "latest", messageRoles: ["user", "assistant"], depth: "normal" } };
    const control = { provider: provider(), isCancelled: () => false, onActive: () => {}, onProgress: async () => {} };
    await executeHostProgressivePreparation(payload, control);
    const state = JSON.parse(fs.readFileSync(path.join(payload.directory, "ready.json"), "utf8"));
    assert.equal(state.current.source.host, "windsurf");
    assert.equal(state.current.source.conversationId, alias);
    assert.equal(state.current.source.conversation.id, canonical);
    const cache = await openProgressiveCache({ root: state.current.directory, source: state.current.source });
    assert.equal((await cache.status()).complete, true);
    assert.equal((await cache.read({ direction: "oldest" })).rows.length, 4);
    const previous = state.previous[0];
    assert.ok(previous);
    const old = await openProgressiveCache({ root: previous.directory, source: previous.source });
    assert.deepEqual((await old.read({ direction: "oldest" })).rows.map(row => row.round.roundIndex), [4]);
    await executeHostProgressivePreparation(payload, { ...control, provider: provider() });
    assert.deepEqual((await old.read({ direction: "oldest" })).rows.map(row => row.round.roundIndex), [4]);
});

test("UUID preparation persists both the requested commit key and verified canonical source across reopen", async () => {
    const taskRoot = path.join(root, "preparation");
    const started = await startCorpusSearch({ ownerId: "alias-owner", root: taskRoot, provider: provider(),
        request: { purpose: "prepare", dataChains: ["windsurf"], conversationIds: [alias] } });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root: taskRoot };
    let status = started;
    for (let attempt = 0; attempt < 100 && ["running", "cancelling"].includes(status.status); attempt++) status = await getCorpusSearchStatus({ ...identity, waitMs: 50 });
    assert.equal(status.error, undefined);
    assert.equal(status.coverage.committedConversations, 1);
    assert.equal(status.prepared?.source, "windsurf");
    assert.equal(status.prepared?.conversationId, canonical);
    const loaded = await loadCorpusTask(identity);
    const record = [...loaded.records.values()][0]!;
    assert.equal(record.conversationId, alias);
    assert.equal(record.verifiedIdentity?.canonicalId, canonical);
    assert.equal(record.prepared?.sourceRevision, record.verifiedIdentity?.sourceRevision);
    assert.equal((await getCorpusSearchStatus(identity)).prepared?.conversationId, canonical);
});

test("direct corpus task refuses a same-source alias assertion without reader-issued provenance", async () => {
    const { candidate, projection } = await readAlias();
    const forged = JSON.parse(JSON.stringify(projection));
    forged.conversation.verifiedIdentity = verifiedCorpusIdentity(projection.conversation);
    const taskRoot = path.join(root, "forged-task");
    const started = await startCorpusSearch({ ownerId: "alias-owner", root: taskRoot,
        request: { dataChains: ["windsurf"], conversationIds: [alias], query: "needle" },
        provider: { list: async () => [candidate], read: async () => forged } });
    let status = started;
    for (let attempt = 0; attempt < 100 && ["running", "cancelling"].includes(status.status); attempt++) status = await getCorpusSearchStatus({
        ownerId: started.ownerId, taskId: started.taskId, root: taskRoot, waitMs: 50 });
    assert.equal(status.totalMatches, 0);
    assert.equal(status.coverage.errorConversations, 1);
    assert.match(status.coverage.errors[0]!.message, /different conversation/u);
});

function progressFixture(name: string): { job: ProgressiveTaskPayload; input: CorpusProjection; candidate: CorpusConversation } {
    const candidate: CorpusConversation = { source: "dsh", id: "initial-progress", title: "progress", workspace: root };
    const input: CorpusProjection = { conversation: candidate, revision: "verified-initial", complete: true, requestedRangeComplete: true,
        totalRounds: 1, roundNumbering: "absolute", warnings: [],
        messages: [{ id: "progress-user", round: 1, role: "user", text: "question", position: { ordinal: 1 } }] };
    const job: ProgressiveTaskPayload = { version: 1, taskId: "progressive-11111111-1111-4111-8111-111111111111", directory: path.join(root, name),
        request: { ownerId: "alias-owner", conversationId: candidate.id, dataChain: "dsh", initialRounds: 1,
            buildFull: false, direction: "latest", messageRoles: ["user", "assistant"], depth: "normal" } };
    return { job, input, candidate };
}

test("initial readFast progress is visible, throttled and ignores callbacks after reader completion", async () => {
    const { job, input, candidate } = progressFixture("initial-progress-success");
    let readerControl: CorpusReadControl | undefined;
    const seen: Array<{ stage?: string; current?: number; total?: number }> = [];
    const source: CorpusRangeProvider = { list: async () => [candidate], read: async () => input, readRounds: async () => input,
        readFast: async (_candidate, _request, control) => {
            readerControl = control;
            for (let index = 0; index < 100; index++) control?.onProgress?.({ phase: "cold-window", bytes: index + 1, totalBytes: 100 });
            return input;
        } };
    await executeHostProgressivePreparation(job, { provider: source, isCancelled: () => false, onActive: () => {},
        onProgress: async message => { seen.push(message as typeof seen[number]); } });
    const initial = seen.filter(message => message.stage === "source:cold-window");
    assert.equal(initial.length, 1);
    assert.equal(initial[0]!.current, 1);
    assert.equal(initial[0]!.total, 100);
    readerControl!.onProgress?.({ phase: "late", bytes: 999 });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(seen.some(message => message.stage === "source:late"), false);
});

test("initial read failure and cancellation drain admitted progress before returning and ignore late callbacks", async () => {
    for (const mode of ["failure", "cancellation"]) {
        const { job, input, candidate } = progressFixture("initial-progress-" + mode);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        let readerControl: CorpusReadControl | undefined;
        let cancelled = false;
        let settled = false;
        let progressCalls = 0;
        const source: CorpusRangeProvider = { list: async () => [candidate], read: async () => input, readRounds: async () => input,
            readFast: async (_candidate, _request, control) => {
                readerControl = control;
                control?.onProgress?.({ phase: "cold-window", bytes: 1 });
                await started;
                if (mode === "cancellation") cancelled = true;
                throw new Error("initial-" + mode);
            } };
        const running = executeHostProgressivePreparation(job, { provider: source, isCancelled: () => cancelled, onActive: () => {},
            onProgress: async () => { progressCalls++; entered(); await gate; } });
        const observed = running.then(() => { settled = true; }, error => { settled = true; throw error; });
        try {
            await started;
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(settled, false);
            release();
            await assert.rejects(observed, new RegExp("initial-" + mode, "u"));
            readerControl!.onProgress?.({ phase: "late", bytes: 999 });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(progressCalls, 1);
        } finally { release(); await observed.catch(() => undefined); }
    }
});

test("initial source progress callback errors are surfaced before ready cache publication", async () => {
    const { job, input, candidate } = progressFixture("initial-progress-callback-error");
    const source: CorpusRangeProvider = { list: async () => [candidate], read: async () => input, readRounds: async () => input,
        readFast: async (_candidate, _request, control) => { control?.onProgress?.({ phase: "cold-window", bytes: 1 }); return input; } };
    await assert.rejects(executeHostProgressivePreparation(job, { provider: source, isCancelled: () => false, onActive: () => {},
        onProgress: async () => { throw new Error("initial-progress-rejected"); } }), /initial-progress-rejected/u);
    assert.equal(fs.existsSync(path.join(job.directory, "ready.json")), false);
});
