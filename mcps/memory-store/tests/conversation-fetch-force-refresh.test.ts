import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-force-refresh-"));
const originalHome = os.homedir;
const originalNodeOptions = process.env.NODE_OPTIONS;
os.homedir = () => temporary;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const preload = path.join(temporary, "isolated-home.mjs");
fs.writeFileSync(preload, `import os from "node:os"; os.homedir = () => ${JSON.stringify(temporary)};\n`);
process.env.NODE_OPTIONS = `${originalNodeOptions || ""} --import ${JSON.stringify(pathToFileURL(preload).href)}`.trim();
const sessions = path.join(temporary, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const threadId = "11111111-1111-4111-8111-111111111111";
const rollout = path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
const rows = [
    { ordinal: 0, type: "session_meta", payload: { id: threadId, cwd: temporary } },
    ...["user", "assistant"].map((role, index) => ({ ordinal: index + 1, type: "response_item", payload: {
        type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: `synthetic ${role}` }],
    } })),
];
fs.writeFileSync(rollout, rows.map(row => JSON.stringify(row)).join("\n") + "\n");

try {
    const database = new DatabaseSync(path.join(temporary, ".codex", "state_5.sqlite"));
    database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(threadId, rollout, temporary, "synthetic force refresh", "vscode", null, null, null, null, 1, 1, 0);
    database.close();
    const bridge = await import("../src/conversation-bridge.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    const { registerConversation } = await import("../src/tools/conversation.ts");
    const tasks = await import("../src/background-tasks.ts");
    const client = await import("../src/conversation-fetch-worker-client.ts");
    const types = await import("../src/conversation-fetch-worker-types.ts");
    const options = { source: "local", link: "reference" } as const;
    const initial = await bridge.loadConversationData("codex", threadId, options);
    assert.ok(initial?.cacheKey);
    const key = initial.cacheKey;
    const breakCheckpoint = async (label: string) => {
        const state = cache.readCachedConversationSourceCache<NonNullable<typeof initial>>({ key });
        assert.ok(state?.snapshot.codexData?.sourceCheckpoint);
        const broken = await cache.readOrBuild({ key, refresh: true, fingerprint: state.fingerprint,
            build: () => ({ snapshot: { ...state.snapshot, codexData: { ...state.snapshot.codexData!,
                sourceCheckpoint: { ...state.snapshot.codexData!.sourceCheckpoint!, replaceFromRound: 999 } } }, rounds: initial.rounds }),
            getRoundNumber: round => round.roundIndex,
        });
        await cache.pinConversationSourceCacheGeneration({ ...broken, ownerId: label });
        return broken;
    };
    let handler: (params: any) => Promise<any> = async () => { throw new Error("tool not registered"); };
    let schema: Record<string, z.ZodTypeAny> = {};
    registerConversation({ tool: (_name: string, _description: string, rawSchema: typeof schema, callback: typeof handler) => {
        schema = rawSchema; handler = callback;
    } } as any);
    const fetch = async (background: boolean): Promise<string> => {
        const result = await handler(z.object(schema).parse({ action: "fetch", conversationId: threadId, dataChain: "codex",
            modelChain: "codex", source: "local", link: "reference", forceRefresh: true, background }));
        return result.content.map((item: { text: string }) => item.text).join("\n");
    };
    const firstBroken = await breakCheckpoint("force-foreground-old");
    const foreground = await fetch(false);
    assert.doesNotMatch(foreground, /❌|上一份完整缓存仍保留/u);
    const foregroundState = cache.readCachedConversationSourceCache<NonNullable<typeof initial>>({ key });
    assert.ok(foregroundState);
    assert.notEqual(foregroundState.generation, firstBroken.generation);
    assert.equal(foregroundState.snapshot.codexData?.sourceCheckpoint?.replaceFromRound, 1);
    assert.ok(cache.readCachedConversationSourceCache({ key, generation: firstBroken.generation }));
    const secondBroken = await breakCheckpoint("force-background-old");
    const response = await fetch(true);
    const taskId = response.match(/taskId: (conversation-fetch-[a-z0-9-]+)/u)?.[1];
    assert.ok(taskId, response);
    const completed = await tasks.waitForBackgroundTask(taskId, 15);
    assert.equal(completed?.status, "done", completed?.error || response);
    assert.ok(types.isCodexFetchWorkerPayload(completed.resumePayload));
    assert.equal(completed.resumePayload.forceRawCacheRebuild, true);
    const resumedPayload = JSON.parse(JSON.stringify(completed.resumePayload));
    assert.equal(client.buildCodexFetchTaskId(resumedPayload), client.buildCodexFetchTaskId(completed.resumePayload));
    const backgroundState = cache.readCachedConversationSourceCache<NonNullable<typeof initial>>({ key });
    assert.ok(backgroundState);
    assert.notEqual(backgroundState.generation, secondBroken.generation);
    assert.equal(backgroundState.snapshot.codexData?.sourceCheckpoint?.replaceFromRound, 1);
    assert.ok(cache.readCachedConversationSourceCache({ key, generation: secondBroken.generation }));
    const recovery = tasks.getBackgroundTaskRecoveryHandler("conversation-fetch");
    assert.ok(recovery);
    const action = await recovery({ ...completed, status: "running", resumePayload: resumedPayload });
    assert.equal(action.mode, "resume");
    assert.ok("run" in action);
    const recoveredResult = await action.run({ taskId, updateProgress: () => undefined, isCancelled: () => false, isSettled: () => false });
    assert.ok(recoveredResult);
    assert.equal(completed.id, taskId);
    const recovered = cache.readCachedConversationSourceCache({ key });
    assert.ok(recovered);
    assert.notEqual(recovered.generation, backgroundState.generation, "recovered original payload must retain explicit rebuild intent");
    assert.ok(cache.readCachedConversationSourceCache({ key, generation: firstBroken.generation }));
    assert.ok(cache.readCachedConversationSourceCache({ key, generation: secondBroken.generation }));
    console.log("conversation-fetch-force-refresh: PASS formal foreground/background forceRefresh, real isolated worker, durable rebuild flag/original task recovery, pinned old generations retained");
} finally {
    os.homedir = originalHome;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
