import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const target = "10000000-0000-4000-8000-000000000064";
const caller = "20000000-0000-4000-8000-000000000064";
const ancestorId = "30000000-0000-4000-8000-000000000064";
const leafId = "40000000-0000-4000-8000-000000000064";

function fixture(blocked: boolean) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "progressive-tail-gap-"));
    const sessions = path.join(directory, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const ancestor = path.join(sessions, `rollout-2026-01-01T00-00-00-${target}_${ancestorId}.jsonl${blocked ? ".zst" : ""}`);
    const leaf = path.join(sessions, `rollout-2026-01-02T00-00-00-${target}_${leafId}.jsonl`);
    const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
    const message = (ordinal: number, role: string, text: string) => ({ ordinal, type: "response_item", payload: {
        type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    } });
    const parent: unknown[] = [{ ordinal: 0, type: "session_meta", payload: { id: target, cwd: directory } }];
    for (let round = 1; round <= 3; round += 1) {
        parent.push(message(parent.length, "user", "question " + round));
        parent.push(message(parent.length, "assistant", "answer " + round));
    }
    const parentBytes = blocked ? 4096 : Buffer.byteLength(encode(parent));
    fs.writeFileSync(ancestor, blocked ? Buffer.alloc(128) : encode(parent));
    const events: unknown[] = [{ ordinal: 7, type: "session_meta", payload: { id: target, cwd: directory,
        history_base: { thread_id: ancestorId, end_ordinal_exclusive: 7, end_byte_offset: parentBytes } } }];
    const count = blocked ? 8 : 1;
    for (let round = 4; round < 4 + count; round += 1) {
        events.push(message(7 + events.length, "user", "question " + round));
        events.push(message(7 + events.length, "assistant", "answer " + round));
    }
    fs.writeFileSync(leaf, encode(events));
    const database = new DatabaseSync(path.join(directory, ".codex", "state_5.sqlite"));
    database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(target, leaf, directory, "fictional tail gap", "vscode", null, null, null, null, 1, 1, 0);
    database.close();
    return { directory, leaf };
}

async function connect(input: ReturnType<typeof fixture>) {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"],
        cwd: path.resolve(import.meta.dirname, ".."), stderr: "pipe", env: { ...process.env,
            HOME: input.directory, USERPROFILE: input.directory, MEMORY_STORE_DATA_ROOT: path.join(input.directory, "data"),
            MEMORY_STORE_AUTO_RECORD: "0", MEMORY_STORE_LIFECYCLE_ENABLED: "false", MEMORY_STORE_CODEX_HISTORY_MAX_COMPRESSED_BYTES: "64",
        } });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "tail-gap-worker-test", version: "1" });
    await client.connect(transport);
    const tasks = new Set<string>();
    const call = async (arguments_: Record<string, unknown>): Promise<any> => {
        const reply = await client.callTool({ name: "conversation_read_original", arguments: { conversationId: caller, dataChain: "codex", ...arguments_ } });
        const text = (reply.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text).join("\n");
        assert.ok(!reply.isError, text);
        let value = JSON.parse(text);
        if (value.delivery === "artifact") value = JSON.parse(fs.readFileSync(value.artifactPath, "utf8"));
        if (value.taskId) tasks.add(value.taskId);
        return value;
    };
    const terminal = async (initial: any): Promise<any> => {
        let state = initial;
        const deadline = Date.now() + 30000;
        while (!["done", "error", "failed", "cancelled"].includes(state.status) && Date.now() < deadline) {
            state = await call({ action: "prepare_status", taskId: initial.taskId, waitSeconds: 1, afterProgressRevision: state.revision });
        }
        assert.ok(["done", "error", "failed", "cancelled"].includes(state.status), JSON.stringify(state));
        return state;
    };
    const close = async () => {
        for (const taskId of tasks) {
            await call({ action: "prepare_cancel", taskId }).catch(() => undefined);
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const state = await call({ action: "prepare_status", taskId }).catch(() => undefined);
                if (!state?.cancellationPending) break;
                await sleep(20);
            }
        }
        await client.close();
        assert.equal(path.dirname(input.directory), path.resolve(os.tmpdir()));
        fs.rmSync(input.directory, { recursive: true, force: true });
    };
    return { call, terminal, close };
}

test("default latest publishes partial leaf before the unchanged full-cache cap fails", async () => {
    const input = fixture(true);
    const session = await connect(input);
    try {
        const state = await session.terminal(await session.call({ action: "read_fast", conversationIds: [target], lastRounds: 2, waitSeconds: 0 }));
        assert.equal(state.request.buildFull, true);
        assert.equal(state.status, "error");
        assert.equal(state.fullSourceComplete, false);
        assert.equal(state.requestedRangeComplete, false);
        assert.match(state.error, /compressed size limit/u);
        assert.equal(state.ready.relativeReadyRounds, 2);
        assert.ok(state.warnings.some((warning: string) => warning.startsWith("CODEX_HISTORY_ANCESTRY_PENDING:")));
        assert.ok(state.warnings.some((warning: string) => warning.startsWith("CODEX_FULL_CACHE_PENDING:")));
        const read = await session.call({ action: "read_ready", taskId: state.taskId, lastRounds: 2 });
        assert.equal(read.rounds.length, 2);
        assert.equal(read.requestedRangeComplete, false);
        assert.equal(read.sourceRangeVerified, false);
        assert.equal(read.fullSourceComplete, false);
        assert.deepEqual(read.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["question 10", "question 11"]);
        const ref = read.rounds[0].ref;
        await session.call({ action: "prepare_cancel", taskId: state.taskId });
        const preserved = await session.call({ action: "read_ready", taskId: state.taskId, rangeRef: ref });
        assert.equal(preserved.rounds[0].ref, ref);
        assert.ok(preserved.messages.length);
        assert.equal(preserved.requestedRangeComplete, false);
    } finally { await session.close(); }
});

test("short leaf fills the same finite task and full preparation still completes", async () => {
    const input = fixture(false);
    const session = await connect(input);
    try {
        const partial = await session.terminal(await session.call({ action: "read_fast", conversationIds: [target], lastRounds: 2, prepareCache: false, waitSeconds: 0 }));
        assert.equal(partial.status, "done");
        assert.equal(partial.requestedRangeComplete, true);
        assert.equal(partial.fullSourceComplete, false);
        const finite = await session.call({ action: "read_ready", taskId: partial.taskId, lastRounds: 2 });
        assert.deepEqual(finite.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["question 3", "question 4"]);
        assert.equal(finite.sourceRangeVerified, true);
        const complete = await session.terminal(await session.call({ action: "read_fast", conversationIds: [target], lastRounds: 2, waitSeconds: 0 }));
        assert.equal(complete.status, "done", JSON.stringify(complete));
        assert.equal(complete.fullSourceComplete, true);
        assert.equal(complete.requestedRangeComplete, true);
        assert.ok(!complete.warnings.some((value: string) => value.startsWith("CODEX_HISTORY_ANCESTRY_PENDING:")));
        const read = await session.call({ action: "read_ready", taskId: complete.taskId, lastRounds: 2 });
        assert.deepEqual(read.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["question 3", "question 4"]);
        assert.equal(read.fullSourceComplete, true);
        assert.equal(read.sourceRangeVerified, true);
    } finally { await session.close(); }
});

test("oldest still requires the original ancestor validation before publication", async () => {
    const input = fixture(true);
    const session = await connect(input);
    try {
        const state = await session.terminal(await session.call({ action: "read_fast", conversationIds: [target], lastRounds: 2, buildOrder: "oldest", waitSeconds: 0 }));
        assert.equal(state.status, "error");
        assert.match(state.error, /compressed size limit/u);
        assert.ok(!state.ready?.blocks?.length);
        assert.equal(state.fullSourceComplete, false);
    } finally { await session.close(); }
});
