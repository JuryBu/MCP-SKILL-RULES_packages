import assert from "node:assert/strict";
import { createHostCorpusProvider, type HostCorpusBackend } from "../src/conversation-corpus-reader-hosts.js";
import { createMultiCorpusProvider } from "../src/conversation-corpus-reader-multi.js";
import type { CorpusConversation } from "../src/conversation-corpus-types.js";
const target: CorpusConversation = { source: "windsurf", id: "target", title: "target", workspace: "", updatedAt: "", sourceKind: "devin-cli" };
let attempts = 0;
const backend: HostCorpusBackend = {
    async list() { return ++attempts === 1 ? [] : [target]; },
    async read() { throw new Error("Unexpected body read"); },
};
const provider = createHostCorpusProvider("windsurf", { backend });
assert.deepEqual(await provider.list({ dataChains: ["windsurf"], conversationIds: ["target"] }, { deadlineAt: Date.now() + 5000 }), [target]);
assert.equal(attempts, 2);
attempts = 0;
assert.deepEqual(await provider.list({ dataChains: ["windsurf"] }, { deadlineAt: Date.now() + 5000 }), []);
assert.equal(attempts, 1);
const incomplete = createMultiCorpusProvider({ providers: { windsurf: {
    ...provider,
    async list() { return []; },
    sourceStatuses() { return [{ source: "windsurf", status: "partial", candidateCount: 0, warnings: ["DEVIN_SOURCE_ACCESS: source temporarily unavailable"] }]; },
} } });
await assert.rejects(() => incomplete.list({ dataChains: ["windsurf"], conversationIds: ["target"], sourceFailureMode: "fail" }, { deadlineAt: Date.now() + 5000 }), /source listing is incomplete.*DEVIN_SOURCE_ACCESS/u);
console.log("PASS targeted same-source bounded retry; untargeted listing unchanged; incomplete metadata retained as source failure");
