import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memory-progressive-sdk-"));
const home = path.join(temporary, "home");
const sessions = path.join(home, ".codex", "sessions");
await fs.mkdir(sessions, { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const target = "10000000-0000-4000-8000-000000000059";
const caller = "20000000-0000-4000-8000-000000000059";
const timestamp = "2026-01-01T00:00:00.000Z";
const events: unknown[] = [{ timestamp, type: "session_meta", payload: { id: target, cwd: path.join(temporary, "workspace") } }];
for (let round = 1; round <= 120; round++) {
    events.push({ timestamp, type: "event_msg", payload: { type: "user_message", message: "question-" + round } });
    events.push({ timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer-" + round }] } });
}
await fs.writeFile(path.join(sessions, "rollout-2026-01-01T00-00-00-" + target + ".jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { registerConversation } = await import("../src/tools/conversation.js");
const server = new McpServer({ name: "progressive-test", version: "1.0.0" });
registerConversation(server);
const client = new Client({ name: "progressive-test-client", version: "1.0.0" });
if (process.argv.includes("--stdio")) {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ["--import", "tsx", "src/index.ts"], cwd: path.resolve(import.meta.dirname, ".."), env: environment }));
} else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
}
const call = async (args: Record<string, unknown>): Promise<any> => {
    const result = await client.callTool({ name: "conversation_read_original", arguments: { conversationId: caller, dataChain: "codex", ...args } });
    const text = (result.content as Array<{ type: string; text?: string }>).filter(item => item.type === "text").map(item => item.text).join("\n");
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
};
let taskId: string | undefined;
try {
    const started = await call({ action: "read_fast", conversationIds: [target], lastRounds: 50, waitSeconds: 0 });
    taskId = started.taskId;
    assert.match(taskId!, /^progressive-/);
    const deadline = Date.now() + 45000;
    let state = started;
    let firstRef: string | undefined;
    let liveRead = false;
    let resumed = false;
    let previousCoverage = 0;
    while (Date.now() < deadline) {
        state = await call({ action: "prepare_status", taskId, waitSeconds: 0 });
        if (state.error) throw new Error(state.error);
        if (state.ready?.blocks?.length) {
            const count = state.ready.relativeReadyRounds || state.ready.coveredAbsoluteRounds;
            assert.ok(count >= previousCoverage, "default searchable coverage cannot decrease");
            previousCoverage = count;
            const last = await call({ action: "read_ready", taskId, lastRounds: 5 });
            assert.equal(last.rounds.length, 5);
            assert.deepEqual(last.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), [116, 117, 118, 119, 120].map(round => "question-" + round));
            firstRef ||= last.rounds[0].ref;
            liveRead ||= state.status === "running";
            if (!resumed && state.status === "running") {
                await call({ action: "prepare_cancel", taskId });
                for (let attempt = 0; attempt < 150; attempt++) {
                    const cleanup = await call({ action: "prepare_status", taskId });
                    if (!cleanup.cancellationPending) break;
                    await sleep(20);
                }
                const preserved = await call({ action: "locate_ready", taskId, rangeRef: firstRef });
                assert.ok(preserved.messages.length);
                await call({ action: "prepare_resume", taskId });
                resumed = true;
                continue;
            }
        }
        if (state.status === "done") break;
        await sleep(20);
    }
    assert.equal(state.status, "done", JSON.stringify(state));
    assert.equal(state.fullSourceComplete, true);
    assert.ok(firstRef);
    const located = await call({ action: "locate_ready", taskId, rangeRef: firstRef });
    assert.equal(located.messages.find((message: any) => message.role === "user").text, "question-116");
    const search = await call({ action: "search_ready", taskId, query: "question-" });
    assert.equal(search.scannedRounds, 120);
    const extracted = await call({ action: "extract_ready", taskId, rangeRef: firstRef });
    assert.match(extracted.text, /question-116/);
    await assert.rejects(() => call({ action: "prepare_status", taskId, conversationId: "wrong-owner" }));
    const tailTaskId = taskId;
    const head = await call({ action: "prepare", conversationIds: ["codex://threads/" + target], buildOrder: "oldest", lastRounds: 50, prepareCache: false });
    taskId = head.taskId;
    let headState = head;
    while (Date.now() < deadline) {
        headState = await call({ action: "prepare_status", taskId, waitSeconds: 1, afterProgressRevision: headState.revision });
        if (headState.error) throw new Error(headState.error);
        if (headState.status === "done") break;
    }
    assert.equal(headState.status, "done");
    assert.equal(headState.fullSourceComplete, false);
    const first50 = await call({ action: "read_ready", taskId, lastRounds: 50 });
    assert.deepEqual(first50.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), Array.from({ length: 50 }, (_, index) => "question-" + (index + 1)));
    await assert.rejects(() => call({ action: "read_ready", taskId, startRound: 1, endRound: 5 }), /global round/);
    console.log(JSON.stringify({ passed: true, tailTaskId, headTaskId: taskId, liveRead, resumed, totalRounds: search.scannedRounds, oldRefRetained: true, oldest50: true, temporary }));
} finally {
    if (taskId) {
        await call({ action: "prepare_cancel", taskId }).catch(() => undefined);
        for (let attempt = 0; attempt < 100; attempt++) {
            const state = await call({ action: "prepare_status", taskId }).catch(() => undefined);
            if (!state?.cancellationPending) break;
            await sleep(100);
        }
    }
    await client.close();
    await server.close();
    await fs.rm(temporary, { recursive: true, force: true });
}
