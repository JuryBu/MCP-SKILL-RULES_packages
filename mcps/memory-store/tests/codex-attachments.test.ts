import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildCodexRoundsForTest } from "../src/codex-client.ts";
import { formatRound } from "../src/trajectory.ts";
import { TEMP_DIR } from "../src/temp-store.ts";
import { materializeRoundAttachments } from "../src/conversation-attachments.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-attachments-"));
const localImage = path.join(cwd, "图片 样例(1).png");
const mentionedDoc = path.join(cwd, "课程 OBE(测试).docx");
fs.writeFileSync(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(mentionedDoc, "docx-placeholder", "utf-8");

const dataUrl = `data:image/png;base64,${Buffer.from("inline-image").toString("base64")}`;
const userText = [
    "# Files mentioned by the user:",
    "",
    `## 课程 OBE(测试).docx: ${mentionedDoc}`,
    "",
    "## My request for Codex:",
    "请读一下图片和文件",
    "",
    "请读一下图片和文件",
].join("\n");

const { rounds } = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: userText },
                { type: "input_image", image_url: dataUrl },
            ],
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "user_message",
            message: userText,
            local_images: [localImage],
        },
    },
], "summary", { cwd });

assert.equal(rounds.length, 1);
assert.equal(rounds[0].attachments?.length, 3);
assert.equal(rounds[0].attachments?.some(item => item.name === "My request for Codex"), false);
assert.equal(rounds[0].attachments?.filter(item => item.kind === "image").length, 2);
assert.equal(rounds[0].attachments?.filter(item => item.kind === "file").length, 1);
assert.equal(rounds[0].attachments?.some(item => item.source === "codex-data-url"), true);
assert.equal(rounds[0].attachments?.some(item => item.source === "codex-local-image" && item.originalPath === localImage && item.exists), true);
assert.equal(rounds[0].attachments?.some(item => item.source === "files-mentioned" && item.originalPath === mentionedDoc && item.exists), true);

const imageMentionOnly = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `# Files mentioned by the user:\n\n## 图片 样例(1).png: ${localImage}` }],
        },
    },
], "summary", { cwd });
assert.equal(imageMentionOnly.rounds[0].attachments?.[0].kind, "image");
assert.equal(imageMentionOnly.rounds[0].attachments?.[0].source, "files-mentioned");

const unmaterialized = formatRound(rounds[0], "normal");
assert.match(unmaterialized, /Codex JSONL 内联图片/u);
assert.doesNotMatch(unmaterialized, /base64/u);
assert.match(unmaterialized, /课程 OBE\(测试\)\.docx/u);

const { rounds: displayRounds } = await materializeRoundAttachments(rounds, "test-codex-attachments", {
    limit: 5,
    concurrency: 2,
});
const inlineImage = displayRounds[0].attachments?.find(item => item.source === "codex-data-url");
// EP-E 修复：内联 data-url 图不再因「同轮恰好有不相关的本地路径图」被误杀（旧 preferLocalRemaining 按数量配额跳过 data-url），
// 改为精确判重（同一附件 originalPath+dataUrl，或 sha256 命中本地图才跳）。本场景本地图与内联图是两张不同的图 → 内联图应被 materialize 落盘。
assert.ok(inlineImage?.tempPath, "EP-E 修复后内联图不应被同轮不相关本地图误杀，应 materialize");
assert.equal(fs.existsSync(inlineImage.tempPath), true);
assert.equal(inlineImage?.exists, true);

const dataUrlOnly = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "只有内联图片" },
                { type: "input_image", image_url: dataUrl },
            ],
        },
    },
], "summary", { cwd });
const { rounds: dataUrlOnlyDisplay } = await materializeRoundAttachments(dataUrlOnly.rounds, "test-codex-attachments", {
    limit: 5,
    concurrency: 2,
});
const dataUrlOnlyImage = dataUrlOnlyDisplay[0].attachments?.find(item => item.source === "codex-data-url");
assert.ok(dataUrlOnlyImage?.tempPath);
assert.equal(fs.existsSync(dataUrlOnlyImage.tempPath), true);

const oversizedDataUrl = `data:image/png;base64,${Buffer.alloc(128, 0x61).toString("base64")}`;
const oversizedDataUrlOnly = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: oversizedDataUrl }],
        },
    },
], "summary", { cwd });
const { rounds: oversizedDisplay } = await materializeRoundAttachments(oversizedDataUrlOnly.rounds, "test-codex-attachments", {
    limit: 5,
    maxBytes: 64,
});
const oversizedImage = oversizedDisplay[0].attachments?.find(item => item.source === "codex-data-url");
assert.equal(oversizedImage?.sizeBytes, 128);
assert.match(oversizedImage?.warning || "", /超过大小限制/u);
assert.equal(oversizedImage?.tempPath, undefined);

const attachmentDir = path.join(TEMP_DIR, "codex-attachments", "test-codex-attachments");
if (fs.existsSync(attachmentDir)) {
    fs.rmSync(attachmentDir, { recursive: true, force: true });
}
fs.rmSync(cwd, { recursive: true, force: true });
