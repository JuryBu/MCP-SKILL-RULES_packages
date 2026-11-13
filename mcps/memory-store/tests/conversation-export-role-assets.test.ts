import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConversationRound } from "../src/trajectory.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan65-dsh-use-agy-fix-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
const { exportConversation } = await import("../src/conversation-exporter.ts");
const { filterRoundAttachmentsForRoles } = await import("../src/conversation-attachments.ts");
const userImage = path.join(dataRoot, "real user image.png");
const aliasImage = path.join(dataRoot, "same-image-copy.png");
const toolImage = path.join(dataRoot, "tool-screenshot.png");
fs.writeFileSync(userImage, "user-image-bytes");
fs.copyFileSync(userImage, aliasImage);
fs.writeFileSync(toolImage, "tool-image-bytes");

function round(index: number, stepIndex: number): ConversationRound {
    return { roundIndex: index, startStep: stepIndex, endStep: stepIndex + 5,
        userMessage: `request ${index}`, mediaAttachments: [], aiResponses: [], toolCalls: [],
        taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

const uploaded = { kind: "image" as const, source: "antigravity-raw-attachment" as const, originalPath: userImage, stepIndex: 427 };
const userRound = { ...round(19, 427), userMessage: `look ${userImage}`, mediaAttachments: [userImage],
    attachments: [uploaded], userMessages: [{ stepIndex: 427, text: `look ${pathToFileURL(userImage).href}`,
        mediaAttachments: [userImage], attachments: [uploaded] }] };
const toolRound = { ...round(20, 435),
    attachments: [{ kind: "image" as const, source: "antigravity-uri" as const, originalPath: toolImage, stepIndex: 440 },
        { kind: "image" as const, source: "antigravity-uri" as const, originalPath: userImage, stepIndex: 427 }],
    userMessages: [{ stepIndex: 435, text: "why is the output truncated?" }],
    toolCalls: [{ stepIndex: 440, name: "read_file", argsSummary: "read screenshot", resultSummary: toolImage }] };
const originals = JSON.stringify([userRound, toolRound]);
assert.equal(filterRoundAttachmentsForRoles(userRound, new Set(["subagent"]), true).attachments?.length, 1);
assert.equal(filterRoundAttachmentsForRoles(userRound, new Set(["user"]), true).attachments?.length, 0);
const userOnly = await exportConversation({ conversationId: "role-assets", chainUsed: "antigravity", rounds: [userRound, toolRound],
    totalSteps: 451, scope: "rounds", startRound: 19, endRound: 20, messageRoles: ["user"],
    format: "markdown", outputDir: path.join(dataRoot, "user-only"), includeAssets: true });
const userManifest = JSON.parse(fs.readFileSync(userOnly.manifestPath, "utf8"));
const userMarkdown = fs.readFileSync(userOnly.markdownPath!, "utf8");
assert.equal(userOnly.stats.assetsCopied, 1);
assert.equal(userManifest.assets.length, 2);
assert(userManifest.assets.every((asset: { roundIndex: number; stepIndex: number }) => asset.roundIndex === 19 && asset.stepIndex === 427));
assert(!userMarkdown.includes(userImage));
assert(!userMarkdown.includes(pathToFileURL(userImage).href));
assert(!userMarkdown.includes("tool-screenshot"));
assert(userMarkdown.includes("assets/images/"));
assert.equal(JSON.stringify([userRound, toolRound]), originals);
assert.equal(fs.readdirSync(path.join(userOnly.exportDir, "assets/images")).length, 1);

const allRoles = await exportConversation({ conversationId: "all-assets", chainUsed: "antigravity", rounds: [userRound, toolRound],
    totalSteps: 451, scope: "rounds", startRound: 19, endRound: 20, format: "markdown",
    outputDir: path.join(dataRoot, "all-roles"), includeAssets: true });
assert.equal(allRoles.stats.assetsCopied, 2);
const toolOnly = await exportConversation({ conversationId: "tool-assets", chainUsed: "antigravity", rounds: [userRound, toolRound],
    totalSteps: 451, scope: "rounds", startRound: 19, endRound: 20, messageRoles: ["tool"], format: "markdown",
    outputDir: path.join(dataRoot, "tool-only"), includeAssets: true });
assert.equal(toolOnly.stats.assetsCopied, 2);

process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_ASSETS = "1";
const duplicates = [{ ...round(1, 1), mediaAttachments: [userImage] },
    { ...round(2, 10), mediaAttachments: [aliasImage] },
    { ...round(3, 20), mediaAttachments: [`data:image/png;base64,${Buffer.from("user-image-bytes").toString("base64")}`] }];
const deduped = await exportConversation({ conversationId: "hash-dedupe", chainUsed: "antigravity", rounds: duplicates,
    totalSteps: 30, scope: "full", messageRoles: ["user"], format: "markdown", outputDir: path.join(dataRoot, "dedupe"), includeAssets: true });
assert.equal(deduped.stats.assetsCopied, 1);
assert.equal(deduped.stats.assetsSkipped, 0);
const dedupedManifest = JSON.parse(fs.readFileSync(deduped.manifestPath, "utf8"));
assert.equal(new Set(dedupedManifest.assets.map((asset: { relativePath: string }) => asset.relativePath)).size, 1);
delete process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_ASSETS;
const firstAgentId = "00000000-1111-4000-8000-111111111111";
const secondAgentId = "00000000-2222-4000-8000-222222222222";
const subagentRound = { ...round(1, 1), subagentSummaries: [
    { threadId: firstAgentId, nickname: "subagent", status: "completed", summary: "first complete response " + "first-detail ".repeat(40) },
    { threadId: secondAgentId, nickname: "subagent", status: "completed", summary: "second complete response " + "second-detail ".repeat(40) },
] };
const subagentExport = await exportConversation({ conversationId: "subagent-bodies", chainUsed: "codex", rounds: [subagentRound],
    totalSteps: 7, scope: "full", messageRoles: ["subagent"], format: "markdown", outputDir: path.join(dataRoot, "subagents"), includeAssets: false });
const subagentMarkdown = fs.readFileSync(subagentExport.markdownPath!, "utf8");
assert(subagentMarkdown.includes(firstAgentId));
assert(subagentMarkdown.includes(secondAgentId));
assert(subagentMarkdown.includes(subagentRound.subagentSummaries[0].summary));
assert(subagentMarkdown.includes(subagentRound.subagentSummaries[1].summary));
console.log(JSON.stringify({ dataRoot, cases: ["user provenance", "all roles", "tool roles", "portable user links", "hash dedupe with exhausted count budget", "source immutability"], success: true }));
