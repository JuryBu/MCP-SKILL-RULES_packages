import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-params-1281-"));
const home = path.join(temporary, "home");
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_RECORD_AUTO_UPDATE = "false";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(temporary, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(temporary, "desktop");
const caller = "20000000-0000-4000-8000-000000001281";
const target = "10000000-0000-4000-8000-000000001281";
const workspace = path.join(temporary, "workspace");
const sessions = path.join(home, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const timestamp = "2026-01-01T00:00:00.000Z";
const events: unknown[] = [{ timestamp, type: "session_meta", payload: { id: target, cwd: workspace } }];
for (let roundIndex = 1; roundIndex <= 6; roundIndex++) {
    events.push({ timestamp, type: "event_msg", payload: { type: "user_message", message: `question-${roundIndex}` } });
    events.push({ timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${roundIndex}` }] } });
}
fs.writeFileSync(path.join(sessions, `rollout-2026-01-01T00-00-00-${target}.jsonl`), events.map(event => JSON.stringify(event)).join("\n") + "\n");

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean; structuredContent?: Record<string, any> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, z.ZodObject<any>>();
const server = {
    tool(name: string, _description: string, schema: z.ZodRawShape, callback: Handler) {
        handlers.set(name, callback);
        schemas.set(name, z.object(schema));
    },
};
const textOf = (response: ToolResult) => (response.content || []).map(item => item.text || "").join("\n");
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(schemas.get(name)!.parse(args));
const record = (args: Record<string, unknown>) => call("record_manage", { conversationId: caller, dataChain: "codex", ...args });
const conversation = (args: Record<string, unknown>) => call("conversation_read_original", {
    conversationId: caller, conversationIds: [target], dataChain: "codex", format: "json", ...args,
});
const valueOf = (response: ToolResult) => {
    assert.notEqual(response.isError, true, textOf(response));
    return JSON.parse(textOf(response));
};
let legacyLoads = 0;
let progressiveTaskId: string | undefined;

try {
    const { registerRecord } = await import("../src/tools/record.js");
    const { registerConversation } = await import("../src/tools/conversation.js");
    const { ensureWorkspaceAsync } = await import("../src/store.js");
    const { writeRecord } = await import("../src/record-store.js");
    registerRecord(server as never);
    registerConversation(server as never, { loadConversation: async () => { legacyLoads++; return null; } });

    const scopedActions = ["list", "search", "guide", "audit_ownership", "repair_ownership", "migrate_unknown_chain", "stale_check"];
    const originalReaddir = fs.promises.readdir;
    fs.promises.readdir = (async () => { throw new Error("unexpected directory scan before scope validation"); }) as typeof originalReaddir;
    try {
        for (const action of scopedActions) {
            for (const scope of [undefined, "workspace"]) {
                for (const missingWorkspace of [undefined, "", " \t "]) {
                    const response = await record({ action, scope, workspace: missingWorkspace, query: "needle", auditAll: true });
                    assert.equal(response.isError, true, `${action} must reject missing workspace`);
                    assert.match(textOf(response), /scope=workspace.*需要非空 workspace/u);
                    assert.match(textOf(response), /scope="general"/u);
                    assert.doesNotMatch(textOf(response), /unexpected directory scan/u);
                }
            }
        }
    } finally {
        fs.promises.readdir = originalReaddir;
    }

    const generalAudit = await record({ action: "audit_ownership", scope: "general", recordIds: [target], format: "json" });
    assert.notEqual(generalAudit.isError, true, textOf(generalAudit));
    assert.equal(generalAudit.structuredContent?.scope, "general");
    assert.deepEqual(generalAudit.structuredContent?.selection.requestedIds, [target]);
    const globalAudit = await record({ action: "audit_ownership", scope: "global", recordIds: [target], format: "json" });
    assert.equal(globalAudit.structuredContent?.scope, "global");
    const generalStale = await record({ action: "stale_check", scope: "general", limit: 1 });
    assert.notEqual(generalStale.isError, true, textOf(generalStale));
    assert.match(textOf(generalStale), /scheduler stale_check/u);

    const { hash } = await ensureWorkspaceAsync(workspace);
    const metadata = { title: "workspace-only-1281", totalRounds: 1, totalSteps: 2, lastUpdatedRound: 1, phases: 1 };
    await writeRecord(hash, "workspace-record-1281", "# Workspace\n\nworkspace-needle-1281", metadata);
    await writeRecord("general", target, "# General\n\ngeneral-needle-1281", { ...metadata, title: "general-only-1281", chain: "codex" });
    const workspaceList = await record({ action: "list", workspace });
    assert.match(textOf(workspaceList), /workspace-only-1281/u);
    assert.doesNotMatch(textOf(workspaceList), /general-only-1281/u);
    const includedList = await record({ action: "list", workspace, includeGeneral: true });
    assert.match(textOf(includedList), /general-only-1281/u);
    const generalList = await record({ action: "list", scope: "general" });
    assert.match(textOf(generalList), /general-only-1281/u);
    assert.doesNotMatch(textOf(generalList), /workspace-only-1281/u);
    const generalSearch = await record({ action: "search", scope: "general", conversationId: target, query: "general-needle-1281", mode: "exact" });
    assert.match(textOf(generalSearch), /general-needle-1281/u);
    const workspaceRepair = await record({ action: "repair_ownership", workspace, dryRun: true });
    assert.doesNotMatch(textOf(workspaceRepair), /general-only-1281/u);
    const generalRepair = await record({ action: "repair_ownership", scope: "general", dryRun: true });
    assert.match(textOf(generalRepair), /general-only-1281/u);

    const rejected = await conversation({ action: "read", lastRounds: 2, source: "local", progressive: false });
    assert.equal(rejected.isError, true);
    assert.equal(legacyLoads, 0);
    assert.equal(rejected.structuredContent?.code, "READ_LAST_ROUNDS_REQUIRES_READ_FAST");
    assert.equal(rejected.structuredContent?.callerConversationId, caller);
    assert.deepEqual(rejected.structuredContent?.targetConversationIds, [target]);
    const next = rejected.structuredContent?.next;
    assert.equal(next.action, "read_fast");
    assert.equal(next.conversationId, caller);
    assert.deepEqual(next.conversationIds, [target]);
    assert.equal(next.progressive, false);
    const tail = valueOf(await call("conversation_read_original", next));
    assert.deepEqual(tail.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["question-5", "question-6"]);

    const fixedCache = await conversation({ action: "read", lastRounds: 2, source: "cache", cacheGeneration: "old-generation", continuationCursor: "old-cursor" });
    assert.equal(fixedCache.isError, true);
    assert.match(textOf(fixedCache), /startRound\/endRound/u);
    assert.equal(fixedCache.structuredContent?.next.cacheGeneration, undefined);
    assert.equal(fixedCache.structuredContent?.next.continuationCursor, undefined);
    assert.equal(fixedCache.structuredContent?.next.source, undefined);
    const unknownSource = await conversation({ action: "read", lastRounds: 2, dataChain: "auto" });
    assert.equal(unknownSource.structuredContent?.next, undefined);
    const ambiguousTarget = await conversation({ action: "read", lastRounds: 2, conversationIds: [target, caller] });
    assert.equal(ambiguousTarget.structuredContent?.next, undefined);
    const missingCaller = await conversation({ action: "read", lastRounds: 2, conversationId: undefined });
    assert.equal(missingCaller.structuredContent?.next, undefined);

    const started = valueOf(await conversation({ action: "prepare", lastRounds: 3, prepareCache: false }));
    progressiveTaskId = started.taskId;
    assert.match(progressiveTaskId!, /^progressive-/u);
    const deadline = Date.now() + 20000;
    let state = started;
    while (Date.now() < deadline && state.status !== "done") {
        state = valueOf(await conversation({ action: "prepare_status", taskId: progressiveTaskId, waitSeconds: 1 }));
        if (state.error) throw new Error(state.error);
    }
    assert.equal(state.status, "done");
    const preparedTail = valueOf(await conversation({ action: "read", progressiveTaskId, lastRounds: 2 }));
    assert.deepEqual(preparedTail.messages.filter((message: any) => message.role === "user").map((message: any) => message.text), ["question-5", "question-6"]);
    const otherCaller = "30000000-0000-4000-8000-000000001281";
    const wrongOwner = await conversation({ action: "read", progressiveTaskId, lastRounds: 2, conversationId: otherCaller });
    assert.equal(wrongOwner.isError, true);
    assert.equal(wrongOwner.structuredContent?.callerConversationId, otherCaller);
    assert.deepEqual(wrongOwner.structuredContent?.targetConversationIds, [target]);
    assert.match(textOf(wrongOwner), /调用者 conversationId:.*30000000/u);
    assert.match(textOf(wrongOwner), /目标 conversationIds:.*10000000/u);
    assert.equal(legacyLoads, 0);
    console.log("record-params-1281: PASS; 42 missing-workspace boundaries; explicit general/global; workspace isolation; actionable next executed; read_fast progressive=false tail; progressiveTaskId+lastRounds; caller/target ownership");
} finally {
    if (progressiveTaskId) {
        await conversation({ action: "prepare_cancel", taskId: progressiveTaskId }).catch(() => undefined);
        for (let attempt = 0; attempt < 100; attempt++) {
            const status = await conversation({ action: "prepare_status", taskId: progressiveTaskId }).catch(() => undefined);
            if (!status || !valueOf(status).cancellationPending) break;
            await sleep(20);
        }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
}
