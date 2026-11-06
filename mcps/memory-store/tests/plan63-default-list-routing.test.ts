import assert from "node:assert/strict";
import test from "node:test";
import { registerConversation } from "../src/tools/conversation.js";

test("an explicit source with default list options uses the budgeted metadata entry", async () => {
    let handler: (parameters: any) => Promise<any> = async () => { throw new Error("Unregistered tool"); };
    const calls: any[] = [];
    const server = { tool: (_name: string, _description: string, _schema: unknown, callback: typeof handler) => { handler = callback; } };
    registerConversation(server as any, {
        listCandidates: async options => {
            calls.push(options);
            return {
                candidates: [],
                statuses: options.dataChains!.map(dataChain => ({ dataChain, status: "ok" as const, count: 0 })),
                partial: false,
            };
        },
    });
    for (const dataChain of ["codex", "claude-code", "windsurf", "antigravity", "dsh"]) {
        const response = await handler({ action: "list", conversationId: "synthetic-owner", dataChain, limit: 2 });
        assert.equal(calls.length, ["codex", "claude-code", "windsurf", "antigravity", "dsh"].indexOf(dataChain) + 1);
        assert.deepEqual(calls.at(-1).dataChains, [dataChain]);
        assert.equal(calls.at(-1).query, undefined);
        assert.equal(calls.at(-1).source, "auto");
        assert.equal(calls.at(-1).limit, 2);
        assert.equal(response.isError, undefined);
        assert.match(response.content[0].text, /候选对话: 0/u);
    }
    await handler({ action: "list", conversationId: "synthetic-owner", dataChain: "codex", conversationIds: ["synthetic-target"], source: "cache" });
    assert.deepEqual(calls.at(-1).conversationIds, ["synthetic-target"]);
    await handler({ action: "list", conversationId: "synthetic-owner", dataChain: "codex", query: "synthetic-title", conversationIds: ["synthetic-target"] });
    assert.equal(calls.at(-1).query, "synthetic-title");
    assert.deepEqual(calls.at(-1).conversationIds, ["synthetic-target"]);
});
