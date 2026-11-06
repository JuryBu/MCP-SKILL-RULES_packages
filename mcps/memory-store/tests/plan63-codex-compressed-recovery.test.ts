import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { test } from "node:test";

test("full preparation survives a new process and cache-only context lookup recovers cold compressed text", () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "plan63-codex-compressed-recovery-")));
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const id = "00000000-0000-4000-8000-000000000163";
    const marker = "synthetic cold compression recovery marker plan63";
    const sessions = path.join(root, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    const text = [
        { type: "session_meta", payload: { id, cwd: root } },
        { type: "event_msg", payload: { type: "user_message", message: marker } },
        { type: "event_msg", payload: { type: "agent_message", message: "synthetic full reply" } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n";
    fs.writeFileSync(file + ".zst", zstdCompressSync(Buffer.from(text)));
    const database = new DatabaseSync(path.join(root, ".codex", "state_5.sqlite"));
    database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, file, root, "synthetic compressed recovery", "synthetic", null, null, null, null, 1, 1, 0);
    database.close();
    const env = { ...process.env, HOME: root, USERPROFILE: root, MEMORY_STORE_DATA_ROOT: path.join(root, "data"),
        MEMORY_STORE_AUTO_RECORD: "0", MEMORY_STORE_LIFECYCLE_ENABLED: "false", MEMORY_STORE_ENABLE_DUPLICATE_RETIREMENT: "0",
        PLAN63_RECOVERY_ID: id, PLAN63_RECOVERY_MARKER: marker, PLAN63_RECOVERY_FILE: file };
    const execute = (script: string) => {
        const started = performance.now();
        const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            cwd: repository, env, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024,
        });
        if (result.stdout) console.log(result.stdout.trim());
        if (result.stderr) console.log(result.stderr.trim());
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        console.log(`PLAN63_RECOVERY_PROCESS durationMs=${performance.now() - started}`);
    };
    try {
        execute(`
            import assert from 'node:assert/strict';
            import os from 'node:os';
            import { loadConversationData } from './src/conversation-bridge.ts';
            assert.equal(os.homedir(), process.env.USERPROFILE);
            const loaded = await loadConversationData('codex', process.env.PLAN63_RECOVERY_ID, { source: 'local', link: 'summary' });
            assert.ok(loaded?.cacheGeneration);
            assert.equal(loaded.rounds[0].userMessage, process.env.PLAN63_RECOVERY_MARKER);
            console.log('PLAN63_FULL_PREPARATION', JSON.stringify({ generation: loaded.cacheGeneration, rounds: loaded.roundCount, cacheState: loaded.cacheState }));
        `);
        execute(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { scanCodexContextProbeInRollout } from './src/codex-client.ts';
            import { loadConversationData } from './src/conversation-bridge.ts';
            import { listConversationCandidates } from './src/conversation-filter.ts';
            import { createContextLocateAdapters } from './src/conversation-context-locate-adapters.ts';
            const file = process.env.PLAN63_RECOVERY_FILE;
            const marker = process.env.PLAN63_RECOVERY_MARKER;
            const id = process.env.PLAN63_RECOVERY_ID;
            const originalOpen = fs.openSync;
            fs.openSync = function(filename, ...args) {
                assert.notEqual(path.resolve(String(filename)), file + '.zst', 'cache recovery must not read the raw archive');
                return originalOpen.call(this, filename, ...args);
            };
            const raw = await scanCodexContextProbeInRollout(file, marker, { maxBytes: 65536 });
            assert.equal(raw.partial, true);
            assert.ok(raw.warnings.includes('compressed_source_requires_verified_view'));
            const cached = await loadConversationData('codex', id, { source: 'cache', link: 'summary' });
            assert.equal(cached.rounds[0].userMessage, marker);
            const listed = await listConversationCandidates({ dataChains: ['codex'], source: 'cache', conversationIds: [id],
                contextProbe: marker, maxBytes: 2 * 1024 * 1024, deadlineMs: 5000, contextAdapters: createContextLocateAdapters() });
            assert.equal(listed.candidates[0]?.id, id);
            console.log('PLAN63_FRESH_PROCESS_CACHE_RECOVERY', JSON.stringify({ rawHits: raw.hits.length, rawPartial: raw.partial,
                cachedRounds: cached.roundCount, cacheListHits: listed.candidates.length, generation: cached.cacheGeneration }));
            fs.openSync = originalOpen;
        `);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        console.log("CLEANED_PLAN63_CODEX_COMPRESSED_RECOVERY");
    }
});
