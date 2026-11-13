import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostCorpusProvider, type HostCorpusBackend } from "../src/conversation-corpus-reader-hosts.ts";
import type { CorpusConversation } from "../src/conversation-corpus-types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-wsf-hit-snapshot-"));
let version = 1;
let reads = 0;
const conversation: CorpusConversation = { source: "windsurf", id: "fixture-heron", title: "fixture", workspace: root, sourceKind: "devin-cli" };
const backend: HostCorpusBackend = {
    async list() { return [conversation]; },
    async readCached(target, control) { return this.read(target, undefined, control); },
    async read(_conversation, request, control) {
        reads++;
        if (!request) assert.deepEqual(control.messageRoles, ["user", "assistant", "tool", "subagent"]);
        return { revision: `version-${version}`, sourceComplete: true, totalRounds: 1, rounds: [{
            roundIndex: 1, startStep: 0, endStep: 1, userMessage: `question-${version}`, mediaAttachments: [],
            aiResponses: [{ stepIndex: 1, response: `answer-${version}`, thinking: "" }], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
        }] };
    },
};
try {
    const options = { cacheRoot: root, backend };
    const searched = await createHostCorpusProvider("windsurf", options).read(conversation, { messageRoles: ["user"] });
    assert.ok(searched.messages.every(message => message.role === "user"));
    assert.equal(searched.rounds?.[0].aiResponses.length, 0);
    version = 2;
    const hit = await createHostCorpusProvider("windsurf", options).readRounds(conversation, { revision: searched.revision, startRound: 1, endRound: 1 });
    assert.equal(reads, 1);
    assert.equal(hit.snapshotSourceRevision, searched.revision);
    assert.equal(hit.sourceRevalidatedThisCall, false);
    assert.ok(hit.messages.some(message => message.text === "answer-1"));
    assert.ok(hit.messages.every(message => !message.text.includes("-2")));
    const current = await createHostCorpusProvider("windsurf", options).read(conversation, {});
    assert.notEqual(current.revision, searched.revision);
    const cachedSearch = await createHostCorpusProvider("windsurf", options).readCached!(conversation, { messageRoles: ["user"] });
    assert.ok(cachedSearch?.messages.every(message => message.role === "user"));
    const cachedHit = await createHostCorpusProvider("windsurf", options).readRounds(conversation, { revision: cachedSearch!.revision, startRound: 1, endRound: 1 });
    assert.ok(cachedHit.messages.some(message => message.text === "answer-2"));
    await assert.rejects(createHostCorpusProvider("windsurf", { ...options, cacheRoot: path.join(root, "empty") })
        .readRounds(conversation, { revision: searched.revision, startRound: 1, endRound: 1 }), /revision changed/u);
    console.log("PASS WSF user-only search -> reopened full-context hit, historical body, uncached changed-source rejection");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
