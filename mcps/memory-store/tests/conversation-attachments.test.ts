import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { TEMP_DIR, saveTempFile, saveTempFileAsync } from "../src/temp-store.ts";
import {
    formatAttachmentOverview,
    materializeRoundAttachments,
    type ConversationAttachment,
} from "../src/conversation-attachments.ts";
import type { ConversationRound } from "../src/trajectory.ts";

function imageAttachment(seed: string, source: ConversationAttachment["source"] = "codex-data-url"): ConversationAttachment {
    return {
        kind: "image",
        source,
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from(seed).toString("base64")}`,
        sizeBytes: seed.length,
    };
}

function round(index: number, attachments: ConversationAttachment[]): ConversationRound {
    return {
        roundIndex: index,
        startStep: index,
        endStep: index,
        userMessage: `round ${index}`,
        mediaAttachments: [],
        attachments,
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

const conversationId = "test-conversation-attachments";
const rounds = [
    round(1, [imageAttachment("a"), imageAttachment("b"), imageAttachment("c")]),
    round(2, [imageAttachment("d")]),
];

const overview = formatAttachmentOverview(rounds);
assert.match(overview, /图片 4 张/u);
assert.match(overview, /read\/search 命中轮次时按需生成临时文件/u);

const windsurfOverview = formatAttachmentOverview([round(9, [imageAttachment("wsf", "windsurf-data-url")])]);
assert.match(windsurfOverview, /内联图片 1 张/u);

const { rounds: limitedRounds, truncated } = await materializeRoundAttachments(rounds.slice(0, 1), conversationId, {
    limit: 2,
    concurrency: 2,
});
assert.equal(truncated, 1);
assert.equal(limitedRounds[0].attachments?.filter(item => item.tempPath && fs.existsSync(item.tempPath)).length, 2);
assert.equal(limitedRounds[0].attachments?.filter(item => item.warning?.includes("数量上限")).length, 1);

const { rounds: cachedRounds } = await materializeRoundAttachments(rounds.slice(0, 1), conversationId, {
    limit: 3,
    concurrency: 3,
});
const firstPaths = cachedRounds[0].attachments?.map(item => item.tempPath).filter(Boolean);
const { rounds: cachedAgain } = await materializeRoundAttachments(rounds.slice(0, 1), conversationId, {
    limit: 3,
    concurrency: 3,
});
const secondPaths = cachedAgain[0].attachments?.map(item => item.tempPath).filter(Boolean);
assert.deepEqual(secondPaths, firstPaths);

const largeDataUrl = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024, "a").toString("base64")}`;
let yieldedBeforeLargeDecode = false;
let largeDecodeObserved = false;
const originalBufferFrom = Buffer.from;
setImmediate(() => {
    yieldedBeforeLargeDecode = true;
});
(Buffer as any).from = (...args: any[]) => {
    if (args[1] === "base64") {
        largeDecodeObserved = true;
        assert.equal(yieldedBeforeLargeDecode, true, "大附件解码前应先让出事件循环");
    }
    return (originalBufferFrom as any)(...args);
};
try {
    const { rounds: largeMaterialized } = await materializeRoundAttachments([
        round(13, [{ kind: "image", source: "codex-data-url", dataUrl: largeDataUrl }]),
    ], conversationId);
    assert.ok(fs.existsSync(largeMaterialized[0].attachments?.[0].tempPath || ""));
} finally {
    (Buffer as any).from = originalBufferFrom;
}
assert.equal(largeDecodeObserved, true);

// EP-E 修误杀（蓝图冲突3裁决）：本地路径图与一张【不同的】 data-url 图同轮时，
// data-url 图不再因「数量配额」被误杀，而是正常落盘（sha256 不命中本地图）。
const { rounds: notKilled } = await materializeRoundAttachments([
    round(6, [
        { kind: "image", source: "files-mentioned", originalPath: "C:\\tmp\\local.png", exists: true },
        imageAttachment("distinct-data-url-not-killed"),
    ]),
], conversationId);
assert.ok(notKilled[0].attachments?.[1].tempPath, "不同物理图的 data-url 应正常落盘，不被本地图数量误杀");
assert.ok(fs.existsSync(notKilled[0].attachments?.[1].tempPath || ""));

// T15 E4 快路径：同一附件【自身】既有可用 originalPath 又有 dataUrl → 跳过 data-url 落盘。
const { rounds: selfLocal } = await materializeRoundAttachments([
    round(8, [
        { kind: "image", source: "codex-data-url", originalPath: "C:\\tmp\\self.png", exists: true,
          dataUrl: `data:image/png;base64,${Buffer.from("self-has-both").toString("base64")}` },
    ]),
], conversationId);
assert.equal(selfLocal[0].attachments?.[0].tempPath, undefined);
assert.match(selfLocal[0].attachments?.[0].warning || "", /已有本地图片路径/u);

// T14 真·同图去重：本地路径图与 data-url 图 sha256 相同 → data-url 不落盘。
const sharedSha = "".padStart(64, "a");
const { rounds: sameSha } = await materializeRoundAttachments([
    round(10, [
        { kind: "image", source: "files-mentioned", originalPath: "C:\\tmp\\dup.png", exists: true, sha256: sharedSha },
        { kind: "image", source: "codex-data-url", sha256: sharedSha,
          dataUrl: `data:image/png;base64,${Buffer.from("dup-by-sha").toString("base64")}` },
    ]),
], conversationId);
assert.equal(sameSha[0].attachments?.[1].tempPath, undefined);
assert.match(sameSha[0].attachments?.[1].warning || "", /sha256 命中/u);

const { rounds: sizeLimited } = await materializeRoundAttachments([round(3, [imageAttachment("oversized")])], conversationId, {
    maxBytes: 1,
});
assert.match(sizeLimited[0].attachments?.[0].warning || "", /超过大小限制/u);
assert.equal(sizeLimited[0].attachments?.[0].tempPath, undefined);

const { rounds: totalLimited, truncated: totalTruncated } = await materializeRoundAttachments([
    round(4, [imageAttachment("ab"), imageAttachment("cd")]),
], conversationId, {
    maxTotalBytes: 2,
    limit: 2,
});
assert.equal(totalTruncated, 1);
assert.match(totalLimited[0].attachments?.[1].warning || "", /总大小上限/u);

const attachmentLimitEnvironmentKeys = [
    "MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_LIMIT",
    "MEMORY_STORE_CODEX_ATTACHMENT_MAX_BYTES",
    "MEMORY_STORE_CODEX_ATTACHMENT_MAX_TOTAL_BYTES",
    "MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_CONCURRENCY",
] as const;
const originalAttachmentLimitEnvironment = new Map(attachmentLimitEnvironmentKeys.map(key => [key, process.env[key]]));
const invalidAttachmentLimitConversationIds: string[] = [];
try {
    for (const [index, invalidValue] of [Infinity, NaN, -1, 0, 1.5].entries()) {
        const suffix = String(invalidValue).replace(/[^a-zA-Z0-9]/gu, "-");
        const optionConversationId = `test-invalid-attachment-options-${index}-${suffix}`;
        const environmentConversationId = `test-invalid-attachment-environment-${index}-${suffix}`;
        invalidAttachmentLimitConversationIds.push(optionConversationId, environmentConversationId);
        const attachments = [imageAttachment(`limit-${index}-first`), imageAttachment(`limit-${index}-second`)];

        const { rounds: optionRounds } = await materializeRoundAttachments([round(20 + index, attachments)], optionConversationId, {
            limit: invalidValue,
            maxBytes: invalidValue,
            maxTotalBytes: invalidValue,
            concurrency: invalidValue,
        });
        assert.equal(
            optionRounds[0].attachments?.filter(item => item.tempPath && fs.existsSync(item.tempPath)).length,
            attachments.length,
            `options ${String(invalidValue)} must fall back to safe attachment limits`,
        );

        for (const key of attachmentLimitEnvironmentKeys) process.env[key] = String(invalidValue);
        const { rounds: environmentRounds } = await materializeRoundAttachments([round(30 + index, attachments)], environmentConversationId);
        assert.equal(
            environmentRounds[0].attachments?.filter(item => item.tempPath && fs.existsSync(item.tempPath)).length,
            attachments.length,
            `environment ${String(invalidValue)} must fall back to safe attachment limits`,
        );
    }
} finally {
    for (const key of attachmentLimitEnvironmentKeys) {
        const value = originalAttachmentLimitEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const id of invalidAttachmentLimitConversationIds) {
        fs.rmSync(path.join(TEMP_DIR, "codex-attachments", id), { recursive: true, force: true });
    }
}

const { rounds: badMime } = await materializeRoundAttachments([
    round(5, [{
        kind: "image",
        source: "codex-data-url",
        dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}`,
    }]),
], conversationId);
assert.match(badMime[0].attachments?.[0].warning || "", /不支持的图片 MIME/u);

const windsurfConversationId = "test-windsurf-attachments";
const { rounds: windsurfMaterialized } = await materializeRoundAttachments([
    round(7, [imageAttachment("windsurf-inline", "windsurf-data-url")]),
], windsurfConversationId);
const windsurfTempPath = windsurfMaterialized[0].attachments?.[0].tempPath || "";
assert.ok(fs.existsSync(windsurfTempPath));
assert.match(windsurfTempPath, /windsurf-attachments/u);

// T13 不误杀纯 data-url AI 内嵌图：单张无 originalPath、sha256 缺失的 data-url → 落盘，无误杀 warning。
const aiInlineConversationId = "test-ai-inline-attachments";
const { rounds: aiInline } = await materializeRoundAttachments([
    round(11, [imageAttachment("ai-inline-screenshot", "claude-code-data-url")]),
], aiInlineConversationId);
assert.ok(aiInline[0].attachments?.[0].tempPath, "纯 data-url AI 内嵌图应落盘");
assert.ok(fs.existsSync(aiInline[0].attachments?.[0].tempPath || ""));
assert.equal(aiInline[0].attachments?.[0].warning, undefined);

// T17 antigravity-tool-image 落盘：反重力工具截图 data-url → 生成临时文件、目录正确。
const antigravityConversationId = "test-antigravity-tool-attachments";
const { rounds: antigravityMaterialized } = await materializeRoundAttachments([
    round(12, [imageAttachment("antigravity-tool-screenshot", "antigravity-tool-image")]),
], antigravityConversationId);
const antigravityTempPath = antigravityMaterialized[0].attachments?.[0].tempPath || "";
assert.ok(fs.existsSync(antigravityTempPath), "antigravity-tool-image 应落盘");
assert.match(antigravityTempPath, /antigravity-tool-attachments/u);

const asyncTempPath = await saveTempFileAsync("conversation-attachments", "async", "async temporary output");
assert.equal(await fs.promises.readFile(asyncTempPath, "utf-8"), "async temporary output");
const syncTempPath = saveTempFile("conversation-attachments", "sync", "sync temporary output");
assert.equal(fs.readFileSync(syncTempPath, "utf-8"), "sync temporary output");

const attachmentDir = path.join(TEMP_DIR, "codex-attachments", conversationId);
if (fs.existsSync(attachmentDir)) {
    fs.rmSync(attachmentDir, { recursive: true, force: true });
}
const windsurfAttachmentDir = path.join(TEMP_DIR, "windsurf-attachments", windsurfConversationId);
if (fs.existsSync(windsurfAttachmentDir)) {
    fs.rmSync(windsurfAttachmentDir, { recursive: true, force: true });
}
for (const dir of [
    path.join(TEMP_DIR, "claude-code-attachments", aiInlineConversationId),
    path.join(TEMP_DIR, "antigravity-tool-attachments", antigravityConversationId),
]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
for (const filePath of [asyncTempPath, syncTempPath]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
}
