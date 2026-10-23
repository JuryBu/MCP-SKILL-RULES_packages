import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveCodexStreamingHistorySource, scanCodexStreamingHistory, type CodexStreamingHistoryPosition } from "../src/codex-history-source.ts";

test("large replay prefix remains byte-verified while only replay records are emitted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-replay-prefix-"));
    try {
        const id = "10000000-0000-4000-8000-000000000059";
        const file = path.join(directory, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
        const user = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
        const assistant = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
        const initial = [{ type: "session_meta", payload: { id, cwd: directory } }, user("first"), assistant("first answer"),
            { type: "response_item", payload: { type: "function_call_output", call_id: "fixture", output: "prefix-data-".repeat(300000) } }, user("second"), assistant("second answer")];
        const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
        await fs.writeFile(file, encode(initial));
        const positions: CodexStreamingHistoryPosition[] = [];
        const previous = await scanCodexStreamingHistory(await resolveCodexStreamingHistorySource(file, { roots: [directory] }), (_event, position) => { positions.push(position); });
        const replay = { ...positions[4]!, endByte: positions[4]!.startByte };
        await fs.appendFile(file, encode([user("third"), assistant("third answer")]));
        const source = await resolveCodexStreamingHistorySource(file, { roots: [directory] });
        const emitted: unknown[] = [];
        const incremental = await scanCodexStreamingHistory(source, event => { emitted.push(event); }, { previousVerification: previous, replayFrom: replay });
        const full = await scanCodexStreamingHistory(source, () => {});
        assert.equal(emitted.length, 4);
        assert.deepEqual(emitted, [...initial.slice(4), user("third"), assistant("third answer")]);
        assert.equal(incremental.revision, full.revision);
        const changed = (await fs.readFile(file, "utf8")).replace("prefix-data-", "edited-data-");
        await fs.writeFile(file, changed);
        const rewritten = await resolveCodexStreamingHistorySource(file, { roots: [directory] });
        await assert.rejects(scanCodexStreamingHistory(rewritten, () => {}, { previousVerification: previous, replayFrom: replay }), /cached prefix changed/u);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
