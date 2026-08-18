import assert from "node:assert/strict";
import {
    applyCodexContextProbeMatchesToCandidates,
    sortContextProbeFirst,
    type ConversationListCandidate,
} from "../src/tools/conversation.ts";
import type { CodexContextProbeThreadMatch, CodexThreadInfo } from "../src/codex-client.ts";

function thread(id: string, title: string): CodexThreadInfo {
    return {
        id,
        title,
        rolloutPath: "",
        cwd: "C:\\workspace",
        source: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
        updatedAtMs: Date.now(),
    };
}

function candidate(id: string, title: string): ConversationListCandidate {
    return {
        id,
        title,
        workspace: "C:\\workspace",
        updatedAt: new Date().toISOString(),
        detail: "test",
    };
}

const root = thread("root-thread", "root");
const parent = thread("parent-thread", "parent");
const child = { ...thread("child-thread", "child"), agentNickname: "child-agent", agentRole: "explorer" };

const candidates = [candidate(child.id, child.title)];
const matches: CodexContextProbeThreadMatch[] = [{
    thread: child,
    parentThread: parent,
    rootThread: root,
    hits: [{
        roundIndex: 2,
        role: "user",
        snippet: "grandchild context probe marker",
    }],
}];

const annotated = applyCodexContextProbeMatchesToCandidates(candidates, matches);
assert.equal(annotated.length, 3);

const rootCandidate = annotated.find(item => item.id === root.id);
const parentCandidate = annotated.find(item => item.id === parent.id);
const childCandidate = annotated.find(item => item.id === child.id);
assert.ok(rootCandidate?.contextProbe?.some(note => note.includes("[root-of-hit]")));
assert.ok(parentCandidate?.contextProbe?.some(note => note.includes("[parent-of-hit]")));
assert.ok(childCandidate?.contextProbe?.some(note => note.includes("[child-hit]")));

const sorted = sortContextProbeFirst(annotated);
assert.deepEqual(sorted.map(item => item.id), [root.id, parent.id, child.id]);
