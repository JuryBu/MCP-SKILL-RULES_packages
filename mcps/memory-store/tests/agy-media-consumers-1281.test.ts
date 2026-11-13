import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-media-consumers-1281-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
const { antigravityEventsToRounds } = await import("../src/antigravity-local-projection.ts");
const { formatRound, formatRoundForMessageRoles, getRoundUserMessages } = await import("../src/trajectory.ts");
const { projectCodexCorpusRound } = await import("../src/conversation-corpus-reader-projection.ts");
const { selectHostCorpusProjectionRoles } = await import("../src/conversation-corpus-host-snapshot.ts");
const { exportConversation } = await import("../src/conversation-exporter.ts");
const { projectHostCorpus } = await import("../src/conversation-host-projection.ts");
const userPath = path.join(root, "user.png");
const toolPath = path.join(root, "tool.png");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
try {
    await fs.writeFile(userPath, png);
    await fs.writeFile(toolPath, png);
    const rounds = antigravityEventsToRounds([
        { stepIndex: 0, type: "USER_INPUT", raw: { content: "用户原图", media: [{ uri: userPath }] }, sourcePath: "fixture.jsonl", line: 1 },
        { stepIndex: 1, type: "PLANNER_RESPONSE", raw: { content: "查看工具图" }, sourcePath: "fixture.jsonl", line: 2 },
        { stepIndex: 2, type: "GENERIC", raw: { tool_name: "view_image", content: "截图结果", media: [{ uri: toolPath }] }, sourcePath: "fixture.jsonl", line: 3 },
        { stepIndex: 3, type: "GENERIC", raw: { tool_name: "inspect_image", content: "再次查看", media: [{ uri: toolPath }] }, sourcePath: "fixture.jsonl", line: 4 },
    ]);
    const round = rounds[0];
    const messages = projectCodexCorpusRound("fixture", round, new Map(), ["user", "assistant", "tool"]);
    assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.attachments?.map(attachment => attachment.stepIndex)), [[2], [3]]);
    assert.ok(!JSON.stringify(messages.find(message => message.role === "user")).includes(toolPath));
    for (const attachmentMode of ["text", "markdown"] as const) {
        const markdown = formatRound(round, "full", [], { attachmentMode });
        assert.ok(markdown.indexOf("tool.png") > markdown.indexOf("工具调用 (step 2)"), markdown);
        assert.ok(!markdown.slice(0, markdown.indexOf("工具调用 (step 2)")).includes("tool.png"));
        assert.ok(markdown.slice(markdown.indexOf("工具调用 (step 3)")).includes("tool.png"));
    }
    const roleText = formatRoundForMessageRoles(round, "normal", [], new Set(["user", "assistant", "tool"]), "full");
    assert.ok(roleText.indexOf(toolPath) > roleText.indexOf("工具调用 (step 2)"));
    const userOnly = formatRoundForMessageRoles(round, "full", [], new Set(["user"]), "full");
    assert.ok(userOnly.includes(userPath));
    assert.ok(!userOnly.includes(toolPath));
    console.log("PASS messages/search projection and Markdown: tool images stay with steps 2/3; user-only view excludes tool images");

    const orphan = { ...round, userMessage: "", userMessages: [], mediaAttachments: [], attachments: round.attachments?.filter(attachment => attachment.semanticRole === "tool") };
    assert.deepEqual(getRoundUserMessages(orphan), []);
    assert.ok(!projectCodexCorpusRound("tool-only", orphan, new Map(), ["user", "tool"]).some(message => message.role === "user"));
    console.log("PASS tool-only fragment: no fabricated user message or user image ownership");

    const conversation = { id: "fixture", title: "Fixture", source: "antigravity" as const, workspace: root };
    const projection = projectHostCorpus(conversation, { rounds, revision: "fixture-v4", sourceComplete: true }, undefined, { messageRoles: ["user", "assistant", "tool"] });
    const legacy = structuredClone(projection);
    for (const attachment of legacy.rounds?.[0].attachments || []) delete attachment.semanticRole;
    legacy.messages.find(message => message.role === "user")!.attachments!.push(...legacy.rounds![0].attachments!.filter(attachment => attachment.stepIndex === 2));
    for (const message of legacy.messages) if (message.role === "tool") delete message.attachments;
    const tools = selectHostCorpusProjectionRoles(legacy, ["tool"]);
    assert.deepEqual(tools.rounds?.[0].attachments?.map(attachment => attachment.stepIndex), [2, 3]);
    assert.deepEqual(tools.messages.map(message => message.attachments?.[0].stepIndex), [2, 3]);
    assert.deepEqual(tools.rounds?.[0].mediaAttachments, []);
    const users = selectHostCorpusProjectionRoles(legacy, ["user"]);
    assert.deepEqual(users.rounds?.[0].attachments?.map(attachment => attachment.stepIndex), [0]);
    assert.ok(!JSON.stringify(users.messages).includes(toolPath));
    console.log("PASS legacy cached role selection: tool-only retains round/message images, user-only retains the user image");

    const exported = await exportConversation({ conversationId: "fixture", chainUsed: "antigravity", rounds, totalSteps: 4,
        outputDir: path.join(root, "export"), format: "markdown", depth: "full", includeAssets: true });
    assert.equal(exported.success, true);
    const output = await fs.readFile(exported.markdownPath!, "utf8");
    assert.ok(output.includes("工具调用 (step 2)"));
    const manifest = JSON.parse(await fs.readFile(exported.manifestPath, "utf8"));
    const toolAssets = manifest.assets.filter((asset: { stepIndex: number }) => [2, 3].includes(asset.stepIndex));
    assert.deepEqual(toolAssets.map((asset: { stepIndex: number }) => asset.stepIndex), [2, 3]);
    assert.ok(!output.includes(toolPath));
    assert.ok(!output.slice(0, output.indexOf("工具调用 (step 2)")).includes("tool.png"));
    console.log("PASS Markdown export: assets retain both tool steps and use copied relative links, without original path duplication");
} finally {
    await fs.rm(root, { recursive: true, force: true });
}
