import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { spawn } from "node:child_process";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { cancelCorpusSearch, getCorpusSearchStatus, startCorpusSearch } from "../src/conversation-corpus-task.ts";

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-replica-inventory-"));
    const codexHome = path.join(directory, "home");
    const sessions = path.join(codexHome, "sessions");
    const archived = path.join(codexHome, "archived_sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
    const id = "10000000-0000-4000-8000-000000000060";
    const baseId = "20000000-0000-4000-8000-000000000060";
    const basePath = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}_${baseId}.jsonl`);
    const leafPath = path.join(sessions, `rollout-2026-01-02T00-00-00-${id}.jsonl`);
    const message = (ordinal: number, role: string, text: string) => ({ ordinal, timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    const encode = (events: unknown[]) => Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const base = encode([{ ordinal: 0, type: "session_meta", payload: { id } }, message(1, "user", "祖先正文"), message(2, "assistant", "祖先回答")]);
    const leaf = encode([{ ordinal: 3, type: "session_meta", payload: { id, history_base: { thread_id: baseId, end_ordinal_exclusive: 3, end_byte_offset: base.length } } }, message(4, "user", "叶段正文"), message(5, "assistant", "叶段回答")]);
    fs.writeFileSync(basePath, base);
    fs.writeFileSync(leafPath, leaf);
    const cacheRoot = path.join(directory, "body");
    const provider = () => createCodexCorpusProvider({ codexHome, cacheRoot, listThreads: async () => [] });
    const conversation = { id, source: "codex" as const, title: id, workspace: directory, rolloutPath: leafPath };
    return { directory, codexHome, cacheRoot, sessions, archived, basePath, leafPath, base, leaf, provider, conversation,
        append: () => fs.appendFileSync(leafPath, encode([message(6, "user", "追加正文"), message(7, "assistant", "追加回答")])),
        close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("ancestor replay rejects a newly discovered conflicting replica after a leaf append", async () => {
    const sample = fixture();
    try {
        const provider = sample.provider();
        await provider.list({}, {});
        const before = await provider.read(sample.conversation, {});
        assert.equal(before.complete, true);
        fs.writeFileSync(`${sample.basePath}.zst`, zstdCompressSync(Buffer.from(sample.base.toString("utf8").replace("祖先正文", "冲突正文"))));
        sample.append();
        await provider.list({}, {});
        await assert.rejects(provider.read(sample.conversation, {}), /replica|Conflicting/u);
    } finally { sample.close(); }
});

test("a reopened cache-only provider discovers conflicting replicas in another source directory", async () => {
    const sample = fixture();
    try {
        const original = sample.provider();
        await original.list({}, {});
        await original.read(sample.conversation, {});
        fs.writeFileSync(path.join(sample.archived, `${path.basename(sample.basePath)}.zst`), zstdCompressSync(Buffer.from(sample.base.toString("utf8").replace("祖先正文", "冲突正文"))));
        const reopened = sample.provider();
        assert.equal(await reopened.readCached!(sample.conversation, {}), null);
        await assert.rejects(reopened.read(sample.conversation, {}), /replica|Conflicting/u);
    } finally { sample.close(); }
});

test("cold fast reads discover a conflicting leaf replica in another source directory", async () => {
    const sample = fixture();
    try {
        fs.writeFileSync(path.join(sample.archived, `${path.basename(sample.leafPath)}.zst`), zstdCompressSync(Buffer.from(sample.leaf.toString("utf8").replace("叶段正文", "冲突正文"))));
        await assert.rejects(sample.provider().readFast(sample.conversation, { lastRounds: 1 }), /replica|Conflicting/u);
    } finally { sample.close(); }
});

test("an identical newly discovered ancestor replica rebuilds safely and retains appended rounds", async () => {
    const sample = fixture();
    try {
        const provider = sample.provider();
        await provider.list({}, {});
        await provider.read(sample.conversation, {});
        fs.writeFileSync(`${sample.basePath}.zst`, zstdCompressSync(sample.base));
        sample.append();
        await provider.list({}, {});
        const chunks: string[] = [];
        const after = await provider.read(sample.conversation, { onChunk: chunk => { chunks.push(...chunk.messages.map(message => message.text)); } });
        assert.equal(after.complete, true);
        assert.ok(after.messages.some(message => message.text === "祖先正文"));
        assert.ok(after.messages.some(message => message.text === "追加正文"));
        assert.ok(chunks.includes("祖先正文"));
        assert.ok(chunks.includes("追加正文"));
    } finally { sample.close(); }
});

test("the same cancelled task rejects a new cross-directory conflict after an actual process reopen", async () => {
    const sample = fixture();
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let cacheReadStarted = false;
    try {
        const original = sample.provider();
        await original.list({}, {});
        await original.read(sample.conversation, {});
        const root = path.join(sample.directory, "tasks");
        const started = await startCorpusSearch({ ownerId: "replica-restart-owner", root, request: { query: "祖先正文", conversationIds: [sample.conversation.id] }, provider: {
            ...original,
            async readCached() { cacheReadStarted = true; await blocked; return null; },
        } });
        const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
        for (let attempt = 0; !cacheReadStarted && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(cacheReadStarted, true);
        await cancelCorpusSearch(identity);
        release();
        let cancelled = await getCorpusSearchStatus(identity);
        for (let attempt = 0; cancelled.status !== "cancelled" && attempt < 200; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
            cancelled = await getCorpusSearchStatus(identity);
        }
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.coverage.candidateConversations, 1);
        fs.writeFileSync(path.join(sample.archived, `${path.basename(sample.basePath)}.zst`), zstdCompressSync(Buffer.from(sample.base.toString("utf8").replace("祖先正文", "冲突正文"))));
        const script = `
            const { createCodexCorpusProvider } = await import(${JSON.stringify(new URL("../src/conversation-corpus-reader-codex.ts", import.meta.url).href)});
            const { resumeCorpusSearch, getCorpusSearchStatus } = await import(${JSON.stringify(new URL("../src/conversation-corpus-task.ts", import.meta.url).href)});
            const identity = ${JSON.stringify(identity)};
            const provider = createCodexCorpusProvider(${JSON.stringify({ codexHome: sample.codexHome, cacheRoot: sample.cacheRoot })});
            provider.list = async () => { throw new Error('Frozen candidates must not be rediscovered'); };
            await resumeCorpusSearch({ ...identity, provider });
            for (let attempt = 0; attempt < 500; attempt++) {
                const state = await getCorpusSearchStatus(identity);
                if (state.status === 'partial' || state.status === 'completed' || state.status === 'failed') { console.log(JSON.stringify(state)); process.exit(0); }
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            process.exit(2);
        `;
        const output = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", chunk => stdout += chunk);
            child.stderr.on("data", chunk => stderr += chunk);
            child.on("error", reject);
            child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`Reopened task failed with ${code}: ${stderr}`)));
        });
        const reopened = JSON.parse(output);
        assert.equal(reopened.taskId, started.taskId);
        assert.equal(reopened.status, "partial");
        assert.equal(reopened.coverage.candidateConversations, 1);
        assert.equal(reopened.coverage.errorConversations, 1);
        assert.equal(reopened.totalMatches, 0);
        assert.match(reopened.coverage.errors[0].message, /replica|Conflicting/u);
    } finally { release(); sample.close(); }
});
