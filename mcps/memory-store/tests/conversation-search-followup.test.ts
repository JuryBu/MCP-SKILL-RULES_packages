import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConversationRound } from "../src/trajectory.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-search-followup-"));
const originalHome = os.homedir;
os.homedir = () => temporary;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const cache = await import("../src/conversation-source-cache.js");
const policy = await import("../src/conversation-search-policy.js");
const { registerConversation } = await import("../src/tools/conversation.js");
const conversationId = "fixture-logical-followup";
let handler: (params: any) => Promise<any> = async () => { throw new Error("tool not registered"); };
let schema: Record<string, z.ZodTypeAny> = {};
registerConversation({ tool: (_name: string, _description: string, rawSchema: typeof schema, callback: typeof handler) => { schema = rawSchema; handler = callback; } } as any);

async function call(params: Record<string, unknown>): Promise<string> {
    const result = await handler(z.object(schema).parse(params));
    return result.content.map((item: { text: string }) => item.text).join("\n");
}

function readParams(text: string): Record<string, unknown> {
    for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue;
        const parsed = JSON.parse(line);
        if (parsed.action === "read") return parsed;
    }
    throw new Error("missing read followup");
}

try {
    cache.setConversationSourceCacheDataRootForTests(path.join(temporary, "data"));
    const fixtureRound: ConversationRound = { roundIndex: 1, startStep: 1, endStep: 2, userMessage: "LOGICAL_FOLLOWUP_NEEDLE",
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
    for (const logicalChain of ["auto", "strict"] as const) {
        const published = await cache.readOrBuild({ key: { source: `claude-code:logical=${logicalChain}`, conversationId },
            fingerprint: { size: 1, revision: logicalChain }, build: () => ({ snapshot: { chainUsed: "claude-code", conversationId, rounds: [], roundCount: 1, totalSteps: 2 },
                rounds: [fixtureRound] }), getRoundNumber: item => item.roundIndex });
        const searched = await call({ action: "search", conversationId, dataChain: "claude-code", source: "cache", logicalChain,
            query: "LOGICAL_FOLLOWUP_NEEDLE", mode: "exact", messageRoles: ["user"] });
        assert.match(searched, /exact 模式命中 1 处/u);
        const next = readParams(searched);
        assert.equal(next.logicalChain, logicalChain);
        assert.equal(next.cacheGeneration, published.generation);
        const read = await call(next);
        assert.match(read, /LOGICAL_FOLLOWUP_NEEDLE/u);
        assert.match(read, new RegExp(published.generation));
        const missing = await call({ ...next, cacheGeneration: "missing-generation" });
        assert.match(missing, new RegExp(`logicalChain="${logicalChain}"`));
    }
    const completion = policy.formatConversationFetchCacheContinuation({ conversationId: "fixture-codex-followup", chainUsed: "codex", requestedLink: "expand_children",
        effectiveLink: "reference", cacheGeneration: "fixture-generation", cacheState: "built", cacheCreatedAt: "2026-01-01T00:00:00.000Z", cacheReadPolicy: "verified",
        sourceCoverageBytes: 123, sourceFileCount: 2, sourceEndByte: 100, sourceEndOrdinalExclusive: 40, roundCount: 2 }, Date.parse("2026-01-01T00:00:30.000Z"));
    const next = readParams(completion);
    assert.equal(next.source, "cache");
    assert.equal(next.link, "reference");
    assert.equal(next.cacheGeneration, "fixture-generation");
    assert.equal(next.endRound, 2);
    assert.match(completion, /age: 30s/u);
    assert.match(completion, /本次原文校验: yes/u);
    const legacy = policy.formatConversationFetchCacheContinuation({ conversationId: "fixture", chainUsed: "codex", requestedLink: "summary", effectiveLink: "summary", roundCount: 0 });
    assert.match(legacy, /cacheGeneration: unknown/u);
    assert.ok(!legacy.includes('"action":"read"'));
    console.log("PASS conversation-search-followup: real cached Claude logical auto/strict search-read, exact recovery view, background completion generation/link/coverage and unknown legacy fields");
} finally {
    os.homedir = originalHome;
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(null);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
