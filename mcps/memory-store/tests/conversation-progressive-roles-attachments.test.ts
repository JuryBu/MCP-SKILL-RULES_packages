import assert from "node:assert/strict";
import { formatProgressiveReadRows, progressiveReadRoles } from "../src/tools/conversation-progressive-tool.ts";

const params = { action: "locate_ready", conversationId: "fixture-caller", dataChain: "codex" };
const available = ["user"] as const;
assert.deepEqual(progressiveReadRoles(params, [...available]), ["user"]);
assert.deepEqual(progressiveReadRoles({ ...params, messageRoles: ["assistant"] }, [...available]), ["assistant"]);
assert.deepEqual(progressiveReadRoles(params, ["subagent", "tool"]), ["subagent", "tool"]);
const round = { roundIndex: 1, startStep: 1, endStep: 2, userMessage: "human", userMessages: [{ text: "human", stepIndex: 1 }],
    aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
    attachments: [{ kind: "image", originalPath: "C:/human.png", stepIndex: 1 }, { kind: "image", originalPath: "C:/tool.png", stepIndex: 2 }],
    mediaAttachments: ["C:/human.png", "C:/tool.png"] };
const messages = [{ id: "human", role: "user", round: 1, text: "human", position: { path: "fixture", ordinal: 101 },
    attachments: [round.attachments[0]], mediaAttachments: ["C:/human.png"] },
    { id: "tool", role: "tool", round: 1, text: "tool", position: { path: "fixture", ordinal: 2 }, attachments: [round.attachments[1]], mediaAttachments: ["C:/tool.png"] }];
const result = { rows: [{ round, ref: "fixture-ref", blockId: "fixture-block", kind: "absolute", messages }], messages,
    status: { source: { host: "antigravity", conversationId: "fixture", revision: "fixture", snapshot: {} }, complete: true } };
const original = JSON.stringify(result);
const user = formatProgressiveReadRows(result as never, { action: "read_ready", messageRoles: ["user"] }, ["user"]);
assert.deepEqual(user.rounds[0].attachments, [round.attachments[0]]);
assert.deepEqual(user.rounds[0].mediaAttachments, ["C:/human.png"]);
const tool = formatProgressiveReadRows(result as never, { action: "read_ready", messageRoles: ["tool"] }, ["tool"]);
assert.deepEqual(tool.rounds[0].attachments, [round.attachments[1]]);
const pseudoAttachment = { kind: "file", source: "files-mentioned", name: "My request", stepIndex: 1 };
const cachedResult = { ...result, messages: messages.map(message => message.role === "user"
    ? { ...message, attachments: [...message.attachments, pseudoAttachment] } : message) };
const cached = formatProgressiveReadRows(cachedResult as never, { action: "read_ready", messageRoles: ["user"] }, ["user"]);
assert.equal(cached.messages[0].attachments?.some(attachment => attachment.name === "My request"), false);
assert.deepEqual(cached.rounds[0].attachments, [round.attachments[0]]);
assert.equal(JSON.stringify(result), original);
console.log("PASS progressive ready roles: inherit user/subagent projection, explicit roles preserved, user/tool attachments filtered, full cache unchanged");
