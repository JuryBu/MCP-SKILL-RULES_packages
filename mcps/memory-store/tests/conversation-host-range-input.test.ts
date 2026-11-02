import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.ts";

const temporary = await mkdtemp(path.join(os.tmpdir(), "host-range-input-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const { validateHostRange } = await import("../src/conversation-host-projection.ts");
try {
    assert.throws(() => validateHostRange({ startRound: 0 }), /positive integer/u);
    assert.throws(() => validateHostRange({ lastRounds: 2, startRound: 1 }), /not both/u);
    const rounds: ConversationRound[] = [{ roundIndex: 1, startStep: 0, endStep: 1, userMessage: "owner text", mediaAttachments: [],
        aiResponses: [{ stepIndex: 1, response: "model text", thinking: "", toolCalls: [] }],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] }];
    for (const source of ["claude-code", "windsurf", "antigravity", "dsh"] as const) {
        const conversation = { source, id: "range-fixture", title: "fixture" };
        const provider = createHostCorpusProvider(source, { backend: { list: async () => [conversation], read: async () => ({ rounds, revision: "fixed-revision" }) } });
        const full = await provider.read(conversation, {});
        const result = await provider.readRounds(conversation, { revision: full.revision, startRound: 1, endRound: 1, messageRoles: ["assistant"] });
        assert.deepEqual(result.messages.map(message => message.role), ["assistant"]);
        assert.equal(result.messages[0]!.text, "model text");
        await assert.rejects(provider.readRounds(conversation, { revision: "changed-revision", startRound: 1, messageRoles: ["user"] }), /revision changed/u);
    }
    console.log("PASS four-host hit ranges accept role metadata and preserve role/revision filtering");
} finally { await rm(temporary, { recursive: true, force: true }); }
