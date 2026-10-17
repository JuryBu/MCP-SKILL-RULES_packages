import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCodexArchiveFixture } from "./helpers/codex-zstd-fixture.ts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const childMode = process.argv[2] === "--child";
const temporaryRoot = childMode ? process.argv[3]! : fs.mkdtempSync(path.join(os.tmpdir(), "codex-compressed-cache-lifecycle-"));
const originalHome = os.homedir;
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const codexHome = path.join(temporaryRoot, ".codex");
const sessions = path.join(codexHome, "sessions");
const rolloutPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
const dataRoot = path.join(temporaryRoot, "data");
os.homedir = () => temporaryRoot;
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

try {
    const bridge = await import("../src/conversation-bridge.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    cache.setConversationSourceCacheDataRootForTests(dataRoot);
    const options = { source: "local", link: "reference" } as const;
    if (childMode) {
        const reloaded = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(reloaded?.cacheState, "hit");
        assert.equal(reloaded.cacheGeneration, process.argv[4]);
        assert.deepEqual(reloaded.rounds.map(round => round.userMessage), ["COMPRESSED_USER", "SECOND_USER"]);
        assert.equal(reloaded.codexData?.historySource?.leafPath, `${rolloutPath}.zst`);
        console.log(JSON.stringify({ reload: true, cacheState: reloaded.cacheState, generation: reloaded.cacheGeneration }));
    } else {
        fs.mkdirSync(sessions, { recursive: true });
        const events = [
            { type: "session_meta", payload: { id: conversationId, cwd: temporaryRoot } },
            ...["COMPRESSED_USER", "FIRST_ANSWER", "SECOND_USER", "SECOND_ANSWER"].map((text, index) => ({
                type: "response_item",
                payload: { type: "message", role: index % 2 ? "assistant" : "user", content: [{ type: index % 2 ? "output_text" : "input_text", text }] },
            })),
        ];
        const text = events.map(event => JSON.stringify(event)).join("\n") + "\n";
        fs.writeFileSync(rolloutPath, text);
        const databasePath = path.join(codexHome, "state_5.sqlite");
        execFileSync("python", ["-c", "import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\nconn.execute('create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer)')\nconn.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)')\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'compressed-cache','vscode',None,None,None,None,1,1,0))\nconn.commit()\nconn.close()", databasePath, conversationId, rolloutPath, temporaryRoot]);
        const original = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(original?.cacheState, "built");
        assert.equal(original.codexData?.historySource?.leafPath, rolloutPath);
        const compressedBytes = encodeCodexArchiveFixture(Buffer.from(text));
        fs.writeFileSync(`${rolloutPath}.zst`, compressedBytes);
        fs.unlinkSync(rolloutPath);
        const compressed = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(compressed?.cacheState, "built");
        assert.notEqual(compressed.cacheGeneration, original.cacheGeneration);
        assert.equal(compressed.codexData?.historySource?.leafPath, `${rolloutPath}.zst`);
        assert.deepEqual(compressed.rounds.map(round => round.userMessage), ["COMPRESSED_USER", "SECOND_USER"]);
        const stable = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(stable?.cacheState, "hit");
        assert.equal(stable.cacheGeneration, compressed.cacheGeneration);
        const childOutput = execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", temporaryRoot, compressed.cacheGeneration!], { encoding: "utf8", timeout: 30000 });
        assert.match(childOutput, /"reload":true/);
        fs.writeFileSync(`${rolloutPath}.zst`, compressedBytes.subarray(0, compressedBytes.length - 2));
        await assert.rejects(bridge.loadConversationData("codex", conversationId, options), /archive|zstd|EOF|truncat/i);
        const retained = await bridge.loadConversationData("codex", conversationId, { ...options, source: "cache" });
        assert.equal(retained?.cacheGeneration, compressed.cacheGeneration);
        assert.deepEqual(retained.rounds.map(round => round.userMessage), ["COMPRESSED_USER", "SECOND_USER"]);
        fs.writeFileSync(`${rolloutPath}.zst`, compressedBytes);
        await assert.rejects(bridge.loadConversationData("codex", conversationId, { ...options, isCancelled: () => true }), /cancel/i);
        assert.equal((await bridge.loadConversationData("codex", conversationId, { ...options, source: "cache" }))?.cacheGeneration, compressed.cacheGeneration);
        console.log("codex-compressed-cache-lifecycle: PASS plaintext to compressed/stale SQLite path/new generation/stable hit/process reload/bad archive and cancellation preserve published generation");
    }
    cache.setConversationSourceCacheDataRootForTests(undefined);
} finally {
    os.homedir = originalHome;
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    if (!childMode) {
        assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporaryRoot).startsWith("codex-compressed-cache-lifecycle-"));
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}
