import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { startCorpusSearch, getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch } from "../src/conversation-corpus-task.ts";
import { corpusTaskDirectory, loadCorpusTask } from "../src/conversation-corpus-task-store.ts";
import type { CorpusProjection, CorpusProvider } from "../src/conversation-corpus-types.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-batch-publish-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
type Identity = Parameters<typeof getCorpusSearchStatus>[0];
type Status = Awaited<ReturnType<typeof getCorpusSearchStatus>>;

function projection(index: number): CorpusProjection {
    const id = `fixture-${String(index).padStart(4, "0")}`;
    return { conversation: { id, title: id, workspace: "fixture", source: "codex" }, revision: "fixture-v1", complete: true,
        sourceBytes: 100, warnings: [], messages: [{ id: `${id}-message`, round: 1, role: "user", text: "fixture hit", position: { ordinal: 1 } }] };
}

function providerFor(count: number, reads: string[] = []): CorpusProvider {
    const items = Array.from({ length: count }, (_, index) => projection(index));
    return {
        async list() { return items.map(item => item.conversation); },
        async read(candidate) { reads.push(candidate.id); return items.find(item => item.conversation.id === candidate.id)!; },
    };
}

async function waitFor(identity: Identity, predicate: (state: Status) => boolean = state => !["running", "cancelling"].includes(state.status)): Promise<Status> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const state = await getCorpusSearchStatus({ ...identity, waitMs: 20 });
        if (predicate(state)) return state;
    }
    throw new Error("Corpus batch fixture did not reach expected state");
}

test("new searches default to single commits and preserve explicit batch options", async () => {
    const outcomes: Status[] = [];
    for (const commitBatchSize of [undefined, 1, 32]) {
        const root = path.join(temporary, `default-policy-${commitBatchSize ?? "omitted"}`);
        const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider: providerFor(5),
            ...(commitBatchSize === undefined ? {} : { commitBatchSize }) });
        const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
        const finished = await waitFor(identity);
        assert.equal(finished.status, "completed");
        assert.equal(finished.revision, 5);
        assert.equal(finished.totalMatches, 5);
        const loaded = await loadCorpusTask(identity);
        assert.equal(loaded.state.commitBatchSize, commitBatchSize ?? 1);
        const files = await fs.readdir(path.join(corpusTaskDirectory(identity), "commits"));
        assert.equal(files.length, commitBatchSize === 32 ? 1 : 5);
        assert.equal(files.filter(name => name.endsWith(".batch.json")).length, commitBatchSize === 32 ? 1 : 0);
        outcomes.push(finished);
    }
    for (const outcome of outcomes.slice(1)) {
        assert.deepEqual(outcome.results, outcomes[0]!.results);
        assert.deepEqual(outcome.coverage, outcomes[0]!.coverage);
    }
});

test("batch publication preserves every revision and terminal snapshot delta page", async () => {
    const root = path.join(temporary, "pages");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider: providerFor(70), commitBatchSize: 32 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 70);
    assert.equal(finished.totalMatches, 70);
    assert.equal(finished.coverage.scannedMessages, 70);
    const directory = corpusTaskDirectory(identity);
    const files = await fs.readdir(path.join(directory, "commits"));
    assert.equal(files.filter(name => name.endsWith(".batch.json")).length, 3);
    const loaded = await loadCorpusTask(identity);
    assert.deepEqual(loaded.commits.map(commit => commit.revision), Array.from({ length: 70 }, (_, index) => index + 1));
    const seen: string[] = [];
    let revision = 0;
    do {
        const page = await getCorpusSearchStatus({ ...identity, afterRevision: revision, limit: 11 });
        seen.push(...page.changes!.upserts.map(result => result.conversation.id));
        revision = page.changes!.throughRevision;
        if (!page.changes!.hasMore) break;
    } while (revision < finished.revision);
    assert.equal(revision, 70);
    assert.equal(seen.length, 70);
    assert.equal(new Set(seen).size, 70);
    const first = await getCorpusSearchStatus({ ...identity, limit: 5 });
    const next = await getCorpusSearchStatus({ ...identity, limit: 5, cursor: first.nextCursor });
    assert.equal(first.snapshotId, next.snapshotId);
    assert.equal(new Set([...first.results, ...next.results].map(result => result.conversation.id)).size, 10);
});

test("single-file and batched publication retain identical results, coverage and per-revision contents", async () => {
    const items = Array.from({ length: 40 }, (_, index) => projection(index));
    for (let index = 0; index < items.length; index++) {
        if (index % 7 === 0) items[index]!.messages[0]!.text = "fixture hit excluded";
        if (index % 11 === 0) { items[index]!.complete = false; items[index]!.warnings = ["fixture partial source"]; }
    }
    const provider: CorpusProvider = { async list() { return items.map(item => item.conversation); },
        async read(candidate) {
            if (candidate.id === projection(5).conversation.id) throw new Error("fixture isolated source failure");
            return items.find(item => item.conversation.id === candidate.id)!;
        } };
    const outcomes: Array<{ status: Status; commits: unknown[] }> = [];
    for (const commitBatchSize of [1, 32]) {
        const root = path.join(temporary, `equivalence-${commitBatchSize}`);
        const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit", excludeTerms: ["excluded"] }, provider, commitBatchSize });
        const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
        await waitFor(identity);
        const status = await getCorpusSearchStatus({ ...identity, limit: 100 });
        const task = await loadCorpusTask(identity);
        outcomes.push({ status, commits: task.commits.map(({ queryComputeMs, ...commit }) => commit) });
    }
    assert.equal(outcomes[0]!.status.status, "partial");
    assert.equal(outcomes[1]!.status.status, "partial");
    assert.deepEqual(outcomes[0]!.status.results, outcomes[1]!.status.results);
    assert.deepEqual(outcomes[0]!.status.coverage, outcomes[1]!.status.coverage);
    assert.deepEqual(outcomes[0]!.commits, outcomes[1]!.commits);
});

test("unpublished batch stays invisible and blocks producer at the bounded batch size", async context => {
    const root = path.join(temporary, "publication-gate");
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const publishing = new Promise<void>(resolve => { reached = resolve; });
    const rename = fs.rename.bind(fs);
    let intercepted = false;
    context.mock.method(fs, "rename", async (from: string, to: string) => {
        if (!intercepted && String(to).startsWith(root) && String(to).endsWith(".batch.json")) {
            intercepted = true;
            reached();
            await blocked;
        }
        return rename(from, to);
    });
    const reads: string[] = [];
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider: providerFor(20, reads), commitBatchSize: 8 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    await publishing;
    try {
        const before = await getCorpusSearchStatus({ ...identity, afterRevision: 0 });
        assert.equal(before.revision, 0);
        assert.equal(before.totalMatches, 0);
        assert.equal(before.coverage.committedConversations, 0);
        assert.deepEqual(before.changes!.upserts, []);
        assert.equal(reads.length, 8);
        const loaded = await loadCorpusTask(identity);
        assert.equal(loaded.state.revision, 0);
        assert.equal(loaded.commits.length, 0);
        assert.ok((await fs.readdir(path.join(loaded.directory, "commits"))).some(name => name.endsWith(".tmp")));
    } finally { release(); }
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 20);
});

test("rename failure preserves the earlier published prefix and resumes only missing entries", async context => {
    const root = path.join(temporary, "rename-failure");
    const rename = fs.rename.bind(fs);
    let publications = 0;
    const mock = context.mock.method(fs, "rename", async (from: string, to: string) => {
        if (String(to).startsWith(root) && String(to).endsWith(".batch.json") && ++publications === 2) {
            throw Object.assign(new Error("fixture publication failure"), { code: "EIO" });
        }
        return rename(from, to);
    });
    const reads: string[] = [];
    const provider = providerFor(24, reads);
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider, commitBatchSize: 8 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const failed = await waitFor(identity);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /fixture publication failure/);
    assert.equal(failed.revision, 8);
    assert.equal(failed.totalMatches, 8);
    const files = await fs.readdir(path.join(corpusTaskDirectory(identity), "commits"));
    assert.equal(files.length, 1);
    assert.equal((await loadCorpusTask(identity)).records.size, 8);
    mock.mock.restore();
    reads.length = 0;
    await resumeCorpusSearch({ ...identity, provider });
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 24);
    assert.equal(finished.totalMatches, 24);
    assert.equal(reads.length, 16);
    assert.ok(reads.every(id => id >= projection(8).conversation.id));
});

test("an error returned after rename verifies the original published batch without duplicate publication", async context => {
    const root = path.join(temporary, "postpublication-error");
    const rename = fs.rename.bind(fs);
    let injected = false;
    context.mock.method(fs, "rename", async (from: string, to: string) => {
        await rename(from, to);
        if (!injected && String(to).startsWith(root) && String(to).endsWith(".batch.json")) {
            injected = true;
            throw Object.assign(new Error("fixture post-publication failure"), { code: "EIO" });
        }
    });
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider: providerFor(24), commitBatchSize: 8 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const finished = await waitFor(identity);
    assert.equal(injected, true);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 24);
    assert.equal(finished.totalMatches, 24);
    assert.equal((await fs.readdir(path.join(corpusTaskDirectory(identity), "commits"))).length, 3);
    assert.equal((await loadCorpusTask(identity)).commits.length, 24);
});

test("cancellation drains validated deferred entries and retains an immutable old cursor after resume", async () => {
    const root = path.join(temporary, "cancel-pending");
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { reached = resolve; });
    let pause = true;
    const reads: string[] = [];
    const provider = providerFor(12, reads);
    const read = provider.read;
    provider.read = async (candidate, control) => {
        if (pause && candidate.id === projection(7).conversation.id) { reached(); await blocked; }
        return read(candidate, control);
    };
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider, commitBatchSize: 32 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    await reading;
    await cancelCorpusSearch(identity);
    release();
    const cancelled = await waitFor(identity);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.revision, 7);
    assert.equal(cancelled.totalMatches, 7);
    const before = await getCorpusSearchStatus({ ...identity, limit: 2 });
    const oldCursor = before.nextCursor!;
    reads.length = 0;
    pause = false;
    await resumeCorpusSearch({ ...identity, provider });
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 12);
    assert.equal(finished.totalMatches, 12);
    assert.equal(reads.length, 5);
    const old = await getCorpusSearchStatus({ ...identity, cursor: oldCursor, limit: 2 });
    assert.equal(old.viewRevision, 7);
    assert.equal(old.totalMatches, 7);
    assert.equal(old.snapshotStatus, "cancelled");
    const changes = await getCorpusSearchStatus({ ...identity, afterRevision: 7 });
    assert.equal(changes.changes!.upserts.length, 5);
});

test("a partially filled batch becomes visible while the next source read is blocked", async () => {
    const root = path.join(temporary, "timed-flush");
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider = providerFor(8);
    const read = provider.read;
    provider.read = async (candidate, control) => {
        if (candidate.id === projection(3).conversation.id) await blocked;
        return read(candidate, control);
    };
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider, commitBatchSize: 32 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    try {
        const progress = await waitFor(identity, state => state.revision === 3);
        assert.equal(progress.status, "running");
        assert.equal(progress.totalMatches, 3);
        assert.equal((await loadCorpusTask(identity)).records.size, 3);
    } finally { release(); }
    assert.equal((await waitFor(identity)).status, "completed");
});

test("oversized compact entries flush immediately instead of accumulating a full batch", async () => {
    const root = path.join(temporary, "byte-bound");
    const items = Array.from({ length: 3 }, (_, index) => projection(index));
    for (const item of items) item.conversation.title = "fixture".repeat(50000);
    const provider: CorpusProvider = { async list() { return items.map(item => item.conversation); },
        async read(candidate) { return items.find(item => item.conversation.id === candidate.id)!; } };
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "hit" }, provider, commitBatchSize: 32 });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 3);
    const files = await fs.readdir(path.join(corpusTaskDirectory(identity), "commits"));
    assert.equal(files.length, 3);
    assert.ok(files.every(name => !name.endsWith(".batch.json")));
});

test("process exit after a published batch recovers a lagging state with the same task identity", async () => {
    const root = path.join(temporary, "process-recovery");
    const moduleUrl = new URL("../src/conversation-corpus-task.ts", import.meta.url).href;
    const source = `
        import fs from "node:fs/promises";
        import { startCorpusSearch, getCorpusSearchStatus } from ${JSON.stringify(moduleUrl)};
        const root = ${JSON.stringify(root)};
        const ownerId = "fixture-crash-owner";
        const items = Array.from({length:40}, (_, index) => {
            const id = "fixture-" + String(index).padStart(4, "0");
            return { conversation: {id, title:id, workspace:"fixture", source:"codex"}, revision:"fixture-v1", complete:true,
                sourceBytes:100, warnings:[], messages:[{id:id+"-message", round:1, role:"user", text:"fixture hit", position:{ordinal:1}}] };
        });
        const provider = { async list() {return items.map(item => item.conversation);}, async read(candidate) {
            if (candidate.id === items[32].conversation.id) await new Promise(() => {});
            return items.find(item => item.conversation.id === candidate.id);
        }};
        const rename = fs.rename.bind(fs);
        fs.rename = async (from, to) => { await rename(from, to); if (String(to).endsWith(".batch.json")) process.exit(0); };
        const started = await startCorpusSearch({ownerId, root, request:{query:"hit"}, provider, commitBatchSize:32});
        const identity = {ownerId, root, taskId:started.taskId};
        console.log(JSON.stringify(identity));
        const deadline = Date.now()+5000;
        while (Date.now()<deadline) {
            const state = await getCorpusSearchStatus({...identity, waitMs:20});
            if (state.revision===32) {console.log(JSON.stringify(identity)); process.exit(0);}
        }
        process.exit(2);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: path.join(root, "data"), MEMORY_STORE_LIFECYCLE_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(exitCode, 0, stderr);
    const identity = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as Identity;
    const stored = JSON.parse(await fs.readFile(path.join(corpusTaskDirectory(identity), "state.json"), "utf8"));
    assert.equal(stored.revision, 0);
    const loaded = await loadCorpusTask(identity);
    assert.equal(loaded.state.status, "resumable");
    assert.equal(loaded.state.revision, 32);
    assert.equal(loaded.records.size, 32);
    const reads: string[] = [];
    await resumeCorpusSearch({ ...identity, provider: providerFor(40, reads) });
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.taskId, identity.taskId);
    assert.equal(finished.revision, 40);
    assert.equal(finished.totalMatches, 40);
    assert.equal(reads.length, 8);
    const delta = await getCorpusSearchStatus({ ...identity, afterRevision: 32 });
    assert.equal(delta.changes!.upserts.length, 8);
    assert.equal((await fs.readdir(path.join(corpusTaskDirectory(identity), "commits"))).length, 2);
});

test("process exit before rename ignores the orphan temporary file and replays every pending candidate", async () => {
    const root = path.join(temporary, "prepublication-exit");
    const moduleUrl = new URL("../src/conversation-corpus-task.ts", import.meta.url).href;
    const source = `
        import fs from "node:fs/promises";
        import { startCorpusSearch } from ${JSON.stringify(moduleUrl)};
        const root = ${JSON.stringify(root)};
        const ownerId = "fixture-prepublication-owner";
        const items = Array.from({length:8}, (_, index) => {
            const id = "fixture-" + String(index).padStart(4, "0");
            return { conversation:{id,title:id,workspace:"fixture",source:"codex"}, revision:"fixture-v1", complete:true,
                sourceBytes:100, warnings:[], messages:[{id:id+"-message",round:1,role:"user",text:"fixture hit",position:{ordinal:1}}] };
        });
        const rename = fs.rename.bind(fs);
        fs.rename = async (from, to) => { if (String(to).endsWith(".batch.json")) process.exit(0); return rename(from, to); };
        const provider = {async list(){return items.map(item=>item.conversation);},async read(candidate){return items.find(item=>item.conversation.id===candidate.id);}};
        const started = await startCorpusSearch({ownerId,root,request:{query:"hit"},provider,commitBatchSize:8});
        console.log(JSON.stringify({ownerId,root,taskId:started.taskId}));
        setTimeout(()=>process.exit(2),5000).unref();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: path.join(root, "data"), MEMORY_STORE_LIFECYCLE_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(exitCode, 0, stderr);
    const identity = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as Identity;
    const loaded = await loadCorpusTask(identity);
    assert.equal(loaded.state.status, "resumable");
    assert.equal(loaded.state.revision, 0);
    assert.equal(loaded.records.size, 0);
    const files = await fs.readdir(path.join(loaded.directory, "commits"));
    assert.equal(files.length, 1);
    assert.ok(files[0]!.endsWith(".tmp"));
    const reads: string[] = [];
    await resumeCorpusSearch({ ...identity, provider: providerFor(8, reads) });
    const finished = await waitFor(identity);
    assert.equal(finished.status, "completed");
    assert.equal(finished.revision, 8);
    assert.equal(finished.totalMatches, 8);
    assert.equal(reads.length, 8);
});
