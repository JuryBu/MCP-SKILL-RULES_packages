import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encodeCodexArchiveFixture } from "./helpers/codex-zstd-fixture.ts";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compressed-worker-tool-"));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const parentId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const sessions = path.join(temporaryRoot, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const rolloutPath = (identifier: string) => path.join(sessions, `rollout-2026-01-01T00-00-00-${identifier}.jsonl`);
for (const [identifier, marker] of [[parentId, "synthetic compressed parent"], [childId, "synthetic compressed child payload"]]) {
    const events = [
        { type: "session_meta", payload: { id: identifier, cwd: temporaryRoot } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "synthetic reply" }] } },
    ];
    fs.writeFileSync(`${rolloutPath(identifier)}.zst`, encodeCodexArchiveFixture(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n")));
}
const database = new DatabaseSync(path.join(temporaryRoot, ".codex", "state_5.sqlite"));
database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
for (const identifier of [parentId, childId]) database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(identifier, rolloutPath(identifier), temporaryRoot, "synthetic", "vscode", null, null, null, null, 1, 1, 0);
database.prepare("insert into thread_spawn_edges values(?,?,?)").run(parentId, childId, "completed");
database.close();
const textOf = (result: any): string => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: projectRoot,
    stderr: "pipe", env: { ...process.env, HOME: temporaryRoot, USERPROFILE: temporaryRoot, MEMORY_STORE_DATA_ROOT: path.join(temporaryRoot, "data"),
        MEMORY_STORE_AUTO_RECORD: "0", MEMORY_STORE_LIFECYCLE_ENABLED: "false", MEMORY_STORE_ENABLE_DUPLICATE_RETIREMENT: "0" } });
let serverErrors = "";
transport.stderr?.on("data", chunk => { serverErrors += chunk.toString(); });
const client = new Client({ name: "compressed-worker-tool-test", version: "1" });
try {
    await client.connect(transport);
    let result = await client.callTool({ name: "conversation_read_original", arguments: { action: "fetch", conversationId: parentId,
        dataChain: "codex", modelChain: "codex", source: "local", link: "expand_children", background: true, forceRefresh: true } });
    const taskId = /taskId:\s*([^\s]+)/u.exec(textOf(result))?.[1];
    assert.ok(taskId, textOf(result));
    for (let poll = 0; poll < 10; poll++) {
        result = await client.callTool({ name: "background_task_status", arguments: { taskId, waitSeconds: 3 } });
        if (!/后台任务运行中|后台任务已挂起/u.test(textOf(result))) break;
    }
    const completed = textOf(result);
    assert.notEqual(result.isError, true, completed + serverErrors);
    assert.match(completed, /cacheGeneration:/u);
    assert.doesNotMatch(completed, /❌|安全降级|后台任务运行中/u);
    const artifactPath = /临时文件:\s*([^\n\r]+)/u.exec(completed)?.[1];
    assert.ok(artifactPath, completed);
    const artifact = fs.readFileSync(artifactPath, "utf8");
    assert.match(artifact, /子代理线程展开/u);
    assert.match(artifact, /synthetic compressed parent/u);
    assert.match(artifact, /synthetic compressed child payload/u);
    const generation = /cacheGeneration:\s*([^\s|]+)/u.exec(completed)?.[1];
    const read = await client.callTool({ name: "conversation_read_original", arguments: { action: "read", conversationId: parentId,
        dataChain: "codex", source: "cache", link: "expand_children", cacheGeneration: generation, startRound: 1, endRound: 1, depth: "brief" } });
    assert.notEqual(read.isError, true);
    assert.match(textOf(read), /synthetic compressed parent/u);
    assert.ok(textOf(read).includes(generation!));
    console.log("codex-compressed-worker-tool: PASS normal stdio fetch/background worker/stale paths/small parent and compressed child expanded/same-generation read");
} finally {
    await client.close();
    await transport.close();
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
