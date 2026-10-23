import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { corpusToolResult, isCorpusAction, runCorpusAction, type CorpusToolImplementation } from "../src/tools/conversation-corpus-tool.js";
import type { CorpusConversation } from "../src/conversation-corpus-types.js";
import { registerConversation } from "../src/tools/conversation.js";

const conversation: CorpusConversation = { id: "target", title: "Example", workspace: "/project", source: "codex" };
const calls: Array<{ operation: string; args: any }> = [];
const api: CorpusToolImplementation = {
    provider: {
        list: async request => { calls.push({ operation: "list", args: request }); return [conversation]; },
        read: async () => ({ conversation, revision: "revision-a", complete: true, warnings: [], messages: [] }),
    },
    start: async args => { calls.push({ operation: "start", args }); return { taskId: "task-a", status: "running" }; },
    status: async args => { calls.push({ operation: "status", args }); return { status: "done" }; },
    cancel: async args => { calls.push({ operation: "cancel", args }); return { status: "cancelled" }; },
    resume: async args => { calls.push({ operation: "resume", args }); return { status: "running" }; },
    readRounds: async (target, request) => { calls.push({ operation: "read", args: { target, request } }); return { conversation: target, revision: request.revision, complete: true, warnings: [], messages: [] }; },
    readFast: async (target, request) => { calls.push({ operation: "fast", args: { target, request } }); return { conversation: target, revision: "range:current", complete: false, requestedRangeComplete: true, warnings: ["requested_round_range_complete", "full_source_projection_not_built"], messages: [] }; },
    prepareCache: async args => { calls.push({ operation: "prepare", args }); return { taskId: "preparation-a", status: "running" }; },
};

assert.equal(isCorpusAction("search_all"), true);
assert.equal(isCorpusAction("search"), false);
await runCorpusAction({ action: "search_all", conversationId: "caller-a", query: "缓存", messageRoles: ["user", "model"], workspaces: ["/project"] }, api);
assert.equal(calls[0].args.ownerId, "caller-a");
assert.equal(calls[0].args.request.conversationIds, undefined);
assert.deepEqual(calls[0].args.request.messageRoles, ["user", "assistant"]);
await runCorpusAction({ action: "search_all_status", conversationId: "caller-a", taskId: "task-a", waitSeconds: 120, limit: 100, afterRevision: 2 }, api);
assert.deepEqual(calls.at(-1)?.args, { ownerId: "caller-a", taskId: "task-a", waitMs: 45000, limit: 50, cursor: undefined, afterRevision: 2 });
await runCorpusAction({ action: "read_hit", conversationId: "target", sourceRevision: "revision-a", startRound: 3, endRound: 3 }, api);
assert.equal(calls.at(-1)?.args.request.revision, "revision-a");
assert.equal(calls.at(-1)?.args.request.startRound, 3);
const callsBeforePending = calls.length;
await assert.rejects(() => runCorpusAction({ action: "read_hit", conversationId: "target", sourceRevision: "pending:source-a", startRound: 1 }, api), /暂计/u);
assert.equal(calls.length, callsBeforePending);
const fast = await runCorpusAction({ action: "read_fast", conversationId: "target", startRound: 3, endRound: 3 }, api) as any;
assert.equal(calls.at(-1)?.operation, "fast");
assert.equal(fast.requestedRangeComplete, true);
assert.equal(fast.fullSourceProjectionComplete, false);
assert.equal(fast.complete, false);
const truncated = await runCorpusAction({ action: "read_fast", conversationId: "target", lastRounds: 1, prepareCache: false }, {
    ...api, readFast: async target => ({ conversation: target, revision: "partial", complete: false, warnings: ["requested_range_truncated"], messages: [] }),
}) as any;
assert.equal(truncated.requestedRangeComplete, false);
assert.equal(fast.cachePreparation.taskId, "preparation-a");
await runCorpusAction({ action: "read_fast", conversationId: "caller-a", conversationIds: ["target"], lastRounds: 1 }, api);
assert.equal(calls.at(-2)?.operation, "prepare");
assert.equal(calls.at(-2)?.args.ownerId, "caller-a");
assert.equal(calls.at(-2)?.args.conversationId, "target");
for (const target of ["target", " codex://threads/target ", " CODEX://threads/TARGET "]) {
    await runCorpusAction({ action: "read_fast", conversationId: "caller-a", conversationIds: [target], lastRounds: 1, prepareCache: false }, api);
    assert.equal(calls.at(-1)?.args.target.id, "target");
}
const preparationCount = calls.filter(call => call.operation === "prepare").length;
await runCorpusAction({ action: "read_fast", conversationId: "target", lastRounds: 1, prepareCache: false }, api);
assert.equal(calls.filter(call => call.operation === "prepare").length, preparationCount);
await assert.rejects(() => runCorpusAction({ action: "read_fast", conversationId: "caller-a", conversationIds: ["target", "other"], lastRounds: 1 }, api), /一个目标/u);
await assert.rejects(() => runCorpusAction({ action: "read_fast", conversationId: "target", sourceRevision: "old", lastRounds: 1 }, api), /read_hit/u);
await assert.rejects(() => runCorpusAction({ action: "read_fast", conversationId: "target", startRound: 4, endRound: 3 }, api), /startRound/u);
await assert.rejects(() => runCorpusAction({ action: "search_all", query: "word" }, api), /调用者/u);
await assert.rejects(() => runCorpusAction({ action: "read_hit", conversationId: "target", startRound: 1 }, api), /sourceRevision/u);
await assert.rejects(() => runCorpusAction({ action: "read_hit", conversationId: "target", sourceRevision: "revision-a" }, api), /限定读取范围/u);
await assert.rejects(() => runCorpusAction({ action: "search_all", conversationId: "caller-a", messageRoles: ["system"] }, api), /system/u);
await assert.rejects(() => runCorpusAction({ action: "search_all", conversationId: "caller-a", dataChain: "windsurf" }, api), /Codex/u);

let handler: (params: any) => Promise<any> = async () => { throw new Error("not registered"); };
let schema: Record<string, any> = {};
registerConversation({ tool: (_name: string, _description: string, definition: typeof schema, callback: typeof handler) => { schema = definition; handler = callback; } } as any, { corpus: api, loadConversation: async () => null });
assert.equal(schema.action.parse("search_all"), "search_all");
assert.equal(schema.searchExpression.parse({ all: [{ term: "缓存" }, { any: [{ term: "轮次" }, { term: "原文" }] }] }).all.length, 2);
const started = await handler({ action: "search_all", conversationId: "caller-a", dataChain: "codex", allTerms: ["缓存"], intersectionScope: "round" });
assert.equal(JSON.parse(started.content[0].text).taskId, "task-a");
assert.equal(calls.at(-1)?.args.request.intersectionScope, "round");
const expanded = await handler({ action: "read_hit", conversationId: "target", sourceRevision: "revision-a", startRound: 3, endRound: 3 });
assert.equal(JSON.parse(expanded.content[0].text).revision, "revision-a");
const recent = await handler({ action: "read_fast", conversationId: "target", lastRounds: 2, background: false });
assert.equal(JSON.parse(recent.content[0].text).requestedRangeComplete, true);
const missingIdentity = await handler({ action: "search_all", query: "缓存" });
assert.match(missingIdentity.content[0].text, /调用者/u);
assert.equal(missingIdentity.isError, true);
const missingCache = await handler({ action: "read", conversationId: "10000000-0000-4000-8000-000000000061", source: "cache", dataChain: "codex", startRound: 1, endRound: 1 });
assert.equal(missingCache.isError, true);

const large = { text: "原文".repeat(50000) };
const result = await corpusToolResult(large);
const delivery = JSON.parse(result.content[0].text);
assert.equal(delivery.complete, true);
assert.equal(delivery.delivery, "artifact");
const bytes = await fs.readFile(delivery.artifactPath);
assert.deepEqual(JSON.parse(bytes.toString("utf8")), large);
assert.equal(delivery.sha256, createHash("sha256").update(bytes).digest("hex"));
assert.equal(delivery.bytes, bytes.length);
const directory = path.dirname(delivery.artifactPath);
assert.equal(path.dirname(directory), os.tmpdir());
assert.match(path.basename(directory), /^memory-store-corpus-/u);
await fs.unlink(delivery.artifactPath);
await fs.rmdir(directory);
console.log("PASS corpus tool routes caller/target identities, revision/round linkage, bounded status and complete hashed artifacts");
