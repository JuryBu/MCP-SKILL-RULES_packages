import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const target = "10000000-0000-4000-8000-000000000065";
const caller = "20000000-0000-4000-8000-000000000065";

test("Codex cumulative replacements select current search and latest blocks while old refs remain readable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preferred-window-"));
    const sessions = path.join(directory, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const leaf = path.join(sessions, `rollout-2026-01-02T00-00-00-${target}.jsonl`);
    const events: unknown[] = [{ ordinal: 0, type: "session_meta", payload: { id: target, cwd: directory } }];
    for (let round = 1; round <= 50; round += 1) {
        for (const role of ["user", "assistant"]) events.push({ ordinal: events.length,
            timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, round)).toISOString(), type: "response_item", payload: {
                type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text",
                    text: `${role} question ${round}${round === 35 ? " window-marker" : ""}` }],
            } });
    }
    fs.writeFileSync(leaf, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const database = new DatabaseSync(path.join(directory, ".codex", "state_5.sqlite"));
    database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(target, leaf, directory, "fictional replacement window", "vscode", null, null, null, null, 1, 1, 0);
    database.close();
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"],
        cwd: path.resolve(import.meta.dirname, ".."), stderr: "pipe", env: { ...process.env,
            HOME: directory, USERPROFILE: directory, MEMORY_STORE_DATA_ROOT: path.join(directory, "data"),
            MEMORY_STORE_AUTO_RECORD: "0", MEMORY_STORE_LIFECYCLE_ENABLED: "false",
        } });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "codex-preferred-window", version: "1" });
    const call = async (args: Record<string, unknown>): Promise<any> => {
        const reply = await client.callTool({ name: "conversation_read_original", arguments: {
            conversationId: caller, dataChain: "codex", messageRoles: ["user"], format: "json", ...args,
        } });
        const body = (reply.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text).join("\n");
        assert.ok(!reply.isError, body);
        return JSON.parse(body);
    };
    try {
        await client.connect(transport);
        let state = await call({ action: "read_fast", conversationIds: [target], lastRounds: 40, prepareCache: false, waitSeconds: 0 });
        const taskId = state.taskId;
        const deadline = Date.now() + 30000;
        while (!["done", "error", "failed", "cancelled"].includes(state.status) && Date.now() < deadline) {
            state = await call({ action: "prepare_status", taskId, waitSeconds: 1, afterProgressRevision: state.revision });
        }
        assert.equal(state.status, "done", JSON.stringify(state));
        const dataRoot = path.join(directory, "data");
        const readyFile = fs.readdirSync(dataRoot, { recursive: true }).find(file => path.basename(file) === "ready.json");
        assert.ok(readyFile);
        const ready = JSON.parse(fs.readFileSync(path.join(dataRoot, readyFile), "utf8"));
        const allBlocks = JSON.parse(fs.readFileSync(path.join(ready.current.directory, "manifest.json"), "utf8")).blocks;
        assert.ok(allBlocks.reduce((total: number, block: any) => total + block.roundCount, 0) > 40, "fixture must retain an older cumulative publication");
        const old = await call({ action: "read_ready", taskId, blockId: allBlocks[0].blockId, lastRounds: 1 });
        const oldRef = old.rounds[0].ref;
        const latest = await call({ action: "read_ready", taskId, lastRounds: 40 });
        assert.equal(latest.rounds.length, 40);
        assert.equal(new Set(latest.messages.map((message: any) => message.id)).size, 40);
        assert.deepEqual(latest.messages.map((message: any) => message.text), Array.from({ length: 40 }, (_, index) => {
            const round = index + 11;
            return `user question ${round}${round === 35 ? " window-marker" : ""}`;
        }));
        assert.equal(latest.coverage.reduce((total: number, range: any) => total + range.endRound - range.startRound + 1, 0), 40);
        const latestFive = await call({ action: "read_ready", taskId, lastRounds: 5 });
        assert.deepEqual(latestFive.messages.map((message: any) => message.text), [46, 47, 48, 49, 50].map(round => `user question ${round}`));
        const search = await call({ action: "search_ready", taskId, query: "window-marker", maxHits: 3 });
        assert.equal(search.totalHits, 1);
        assert.equal(search.scannedRounds, 40);
        assert.equal(search.status.relativeReadyRounds, 40);
        const preserved = await call({ action: "read_ready", taskId, rangeRef: oldRef });
        assert.deepEqual(preserved.messages, old.messages);
    } finally {
        await client.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
