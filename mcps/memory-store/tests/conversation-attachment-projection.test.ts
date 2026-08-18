import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { materializeRoundAttachments, type ConversationAttachment } from "../src/conversation-attachments.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";
import { TEMP_DIR } from "../src/temp-store.ts";
import type { ConversationRound } from "../src/trajectory.ts";

const conversationId = `test-conversation-attachment-projection-${randomUUID()}`;
const dataUrl = `data:image/png;base64,${Buffer.from("second-user-message-image").toString("base64")}`;
const secondMessageAttachment: ConversationAttachment = {
    kind: "image",
    source: "codex-data-url",
    mimeType: "image/png",
    dataUrl,
};
const sourceRound: ConversationRound = {
    roundIndex: 1,
    startStep: 1,
    endStep: 4,
    userMessage: "第一条消息\n\n第二条消息",
    mediaAttachments: [],
    attachments: [{ ...secondMessageAttachment }],
    userMessages: [
        { stepIndex: 1, text: "第一条消息", rawRole: "CORTEX_STEP_TYPE_USER_INPUT", semanticRole: "user" },
        {
            stepIndex: 2,
            text: "第二条消息",
            rawRole: "CORTEX_STEP_TYPE_USER_INPUT",
            semanticRole: "user",
            attachments: [{ ...secondMessageAttachment }],
        },
    ],
    aiResponses: [{
        stepIndex: 3,
        response: "助手回复",
        thinking: "FULL_ONLY_THINKING",
        toolCalls: [{ name: "hidden-tool", args: "FULL_ONLY_TOOL_ARGUMENT" }],
    }],
    toolCalls: [{
        stepIndex: 4,
        name: "hidden-tool",
        argsSummary: "摘要",
        resultSummary: "结果摘要",
        argsFull: "FULL_ONLY_TOOL_ARGUMENT",
        resultFull: "FULL_ONLY_TOOL_RESULT",
    }],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
};

try {
    const { rounds } = await materializeRoundAttachments([sourceRound], conversationId);
    const materializedRound = rounds[0];
    const topLevelAttachment = materializedRound.attachments?.[0];
    const secondMessageAttachmentAfterMaterialization = materializedRound.userMessages?.[1]?.attachments?.[0];

    assert.ok(topLevelAttachment?.tempPath && fs.existsSync(topLevelAttachment.tempPath));
    assert.deepEqual(secondMessageAttachmentAfterMaterialization, topLevelAttachment);
    assert.equal(sourceRound.userMessages?.[1]?.attachments?.[0]?.tempPath, undefined);

    const projection = projectConversationRoundForRecord(materializedRound, 0);
    assert.deepEqual(projection.messages.slice(0, 2), [
        {
            role: "user",
            text: "第一条消息",
            rawRole: "CORTEX_STEP_TYPE_USER_INPUT",
            semanticRole: "user",
        },
        {
            role: "user",
            text: "第二条消息",
            rawRole: "CORTEX_STEP_TYPE_USER_INPUT",
            semanticRole: "user",
            attachments: [topLevelAttachment],
        },
    ]);
    assert.deepEqual(projection.messages[2], { role: "assistant", text: "助手回复" });
    assert.doesNotMatch(JSON.stringify(projection), /FULL_ONLY_(?:THINKING|TOOL_ARGUMENT|TOOL_RESULT)/u);
} finally {
    fs.rmSync(path.join(TEMP_DIR, "codex-attachments", conversationId), { recursive: true, force: true });
}
