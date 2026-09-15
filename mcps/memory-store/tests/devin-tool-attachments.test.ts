import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevinRawConversation } from "../src/devin-types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-tool-images-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
const { devinRawToRounds } = await import("../src/devin-conversation.js");
const { attachDevinToolImages } = await import("../src/devin-tool-attachments.js");
const { materializeRoundAttachments } = await import("../src/conversation-attachments.js");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const image = { type: "image", mimeType: "image/png", data: png };
const source = {
    summary: { canonicalId: "image-falcon" }, compactions: [], partial: false, warnings: [],
    nodes: [
        { message: { role: "user", content: "Inspect image" }, nodeId: 1, metadata: {} },
        { message: { role: "assistant", tool_calls: [{ id: "image-call", name: "screenshot", arguments: {} }] }, nodeId: 2, metadata: {} },
        { message: { role: "tool", tool_call_id: "image-call", content: JSON.stringify({ content: [image, { type: "text", text: "Image caption" }] }) }, nodeId: 3, metadata: {} },
    ],
    desktopMessages: [{ kind: "tool_call", payload: { toolCallId: "image-call", content: [image] } }],
} as unknown as DevinRawConversation;
try {
    const rounds = devinRawToRounds(source);
    assert.doesNotMatch(JSON.stringify(rounds), new RegExp(png));
    attachDevinToolImages(source, rounds);
    assert.equal(rounds[0].attachments?.length, 1);
    assert.equal(rounds[0].userMessages?.[0].attachments?.length, 0);
    const result = await materializeRoundAttachments(rounds, "image-falcon");
    const attachment = result.rounds[0].attachments![0];
    assert.ok(attachment.tempPath && fs.existsSync(attachment.tempPath));
    assert.equal(fs.readFileSync(attachment.tempPath!).toString("base64"), png);
    assert.match(rounds[0].toolCalls[0].resultFull || "", /Image caption/);
    console.log("PASS devin-tool-attachments: CLI JSON image and Desktop duplicate produce one materialized image without contaminating user messages");
} finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
