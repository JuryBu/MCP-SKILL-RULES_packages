import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { ConversationRound } from "../src/trajectory.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-export-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { exportConversation } = await import("../src/conversation-exporter.ts");
const { findPdfBrowser } = await import("../src/conversation-pdf.ts");
const { readOrBuildConversationSourceCache } = await import("../src/conversation-source-cache.ts");

function makeRound(index: number, userMessage: string, aiResponse = ""): ConversationRound {
    return {
        roundIndex: index,
        startStep: index * 10,
        endStep: index * 10 + 1,
        userMessage,
        mediaAttachments: [],
        aiResponses: aiResponse ? [{
            stepIndex: index * 10 + 1,
            response: aiResponse,
            thinking: "",
            toolCalls: [],
        }] : [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-export-fixture-"));
const imagePath = path.join(fixtureDir, "local-image.png");
fs.writeFileSync(imagePath, Buffer.from("fake-png"));
const docPath = path.join(fixtureDir, "note.txt");
fs.writeFileSync(docPath, "attachment text", "utf-8");
const missingPath = path.join(fixtureDir, "missing.txt");
const inlinePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJ7vtgAAAABJRU5ErkJggg==";

const rounds: ConversationRound[] = [
    makeRound(1, "第一轮，包含 alpha", "AI alpha"),
    {
        ...makeRound(2, "第二轮，包含 beta 和附件", "AI beta"),
        mediaAttachments: [imagePath, inlinePng],
        attachments: [{
            kind: "file",
            source: "files-mentioned",
            name: "note.txt",
            originalPath: docPath,
            exists: true,
        }, {
            kind: "file",
            source: "files-mentioned",
            name: "missing.txt",
            originalPath: missingPath,
            exists: false,
        }],
        codeActions: [{
            stepIndex: 25,
            description: "测试 diff 导出",
            targetFile: "src/demo.ts",
            instruction: "把 old 改成 new",
            diffs: [{
                targetContent: "const value = 'old';",
                replacementContent: "const value = 'new';",
                startLine: 1,
                endLine: 1,
                unifiedDiff: "--- a/src/demo.ts\n+++ b/src/demo.ts\n@@\n-const value = 'old';\n+const value = 'new';",
            }],
        }],
    },
    makeRound(3, "第三轮，包含 gamma", "AI gamma"),
];

const roleFilteredRounds: ConversationRound[] = [
    {
        ...makeRound(1, "只导出用户输入", "user-only 模式不应出现的模型回复"),
        toolCalls: [{
            stepIndex: 12,
            name: "shell_command",
            argsSummary: "echo hidden",
            resultSummary: "user-only 模式不应出现的工具结果",
        }],
    },
    {
        ...makeRound(2, "角色过滤搜索不应靠用户命中"),
        aiResponses: [{
            stepIndex: 21,
            response: "模型先说 alpha",
            thinking: "",
            toolCalls: [],
        }, {
            stepIndex: 23,
            response: "模型后说 omega",
            thinking: "",
            toolCalls: [],
        }],
        toolCalls: [{
            stepIndex: 22,
            name: "run_shell",
            argsSummary: "echo role",
            resultSummary: "工具命中 needle-role-search",
        }],
    },
];

const defaultResult = await exportConversation({
    conversationId: "export-test-conversation",
    chainUsed: "codex",
    rounds,
    totalSteps: 31,
    format: "markdown",
    scope: "rounds",
    startRound: 2,
    endRound: 2,
    depth: "normal",
    extraTypes: [],
    compactionMode: "folded",
});

assert.equal(defaultResult.success, true);
assert.match(defaultResult.exportDir, /exports[\\/]conversations[\\/]codex[\\/]export-test-conversation/u);
assert.ok(fs.existsSync(defaultResult.markdownPath || ""));
assert.ok(fs.existsSync(defaultResult.manifestPath));
const defaultMarkdown = fs.readFileSync(defaultResult.markdownPath || "", "utf-8");
assert.match(defaultMarkdown, /第二轮，包含 beta/u);
assert.doesNotMatch(defaultMarkdown, /第一轮，包含 alpha/u);
assert.match(defaultMarkdown, /assets\/images/u);
assert.match(defaultMarkdown, /!\[round-2-media-1\]\(assets\/images\//u);
assert.doesNotMatch(defaultMarkdown, /📎 图片: assets\/images/u);
assert.match(defaultMarkdown, /assets\/files/u);
assert.doesNotMatch(defaultMarkdown, new RegExp(imagePath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
assert.doesNotMatch(defaultMarkdown, new RegExp(docPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
const manifest = JSON.parse(fs.readFileSync(defaultResult.manifestPath, "utf-8"));
assert.equal(manifest.roundsExported, 1);
assert.equal(manifest.dataChain, "codex");
assert.equal(manifest.format, "markdown");
assert.equal(manifest.scope, "rounds");
assert.equal(manifest.depth, "normal");
assert.equal(manifest.startRound, 2);
assert.equal(manifest.endRound, 2);
assert.equal(manifest.stats.assetsCopied, 3);
assert.equal(manifest.stats.assetsSkipped, 1);
assert.match(manifest.warnings.join("\n"), /missing\.txt|不可访问/u);
assert.ok(fs.existsSync(path.join(defaultResult.exportDir, "assets", "images")));
assert.ok(fs.existsSync(path.join(defaultResult.exportDir, "assets", "files")));

const roleUserDir = path.join(os.tmpdir(), "memory-store-role-user-export-dir", String(Date.now()));
const roleUserResult = await exportConversation({
    conversationId: "export-role-user-conversation",
    chainUsed: "codex",
    rounds: roleFilteredRounds,
    totalSteps: 24,
    format: "markdown",
    scope: "full",
    outputDir: roleUserDir,
    overwrite: true,
    depth: "normal",
    extraTypes: ["tool_results"],
    messageRoles: ["user"],
    compactionMode: "folded",
});
const roleUserMarkdown = fs.readFileSync(roleUserResult.markdownPath || "", "utf-8");
assert.match(roleUserMarkdown, /messageRoles: user/u);
assert.match(roleUserMarkdown, /只导出用户输入/u);
assert.match(roleUserMarkdown, /角色过滤搜索不应靠用户命中/u);
assert.doesNotMatch(roleUserMarkdown, /user-only 模式不应出现的模型回复/u);
assert.doesNotMatch(roleUserMarkdown, /user-only 模式不应出现的工具结果/u);
const roleUserManifest = JSON.parse(fs.readFileSync(roleUserResult.manifestPath, "utf-8"));
assert.deepEqual(roleUserManifest.messageRoles, ["user"]);

const roleSearchDir = path.join(os.tmpdir(), "memory-store-role-search-export-dir", String(Date.now()));
const roleSearchResult = await exportConversation({
    conversationId: "export-role-search-conversation",
    chainUsed: "codex",
    rounds: roleFilteredRounds,
    totalSteps: 24,
    format: "markdown",
    scope: "search",
    query: "needle-role-search",
    contextRounds: 0,
    outputDir: roleSearchDir,
    overwrite: true,
    depth: "normal",
    extraTypes: ["tool_results"],
    messageRoles: ["model", "tool"],
    compactionMode: "folded",
});
const roleSearchMarkdown = fs.readFileSync(roleSearchResult.markdownPath || "", "utf-8");
assert.match(roleSearchMarkdown, /messageRoles: model, tool/u);
assert.match(roleSearchMarkdown, /模型先说 alpha/u);
assert.match(roleSearchMarkdown, /run_shell/u);
assert.match(roleSearchMarkdown, /needle-role-search/u);
assert.match(roleSearchMarkdown, /模型后说 omega/u);
assert.doesNotMatch(roleSearchMarkdown, /只导出用户输入/u);
const firstAiIndex = roleSearchMarkdown.indexOf("模型先说 alpha");
const toolIndex = roleSearchMarkdown.indexOf("#### 🔧 工具调用 (step 22)");
const secondAiIndex = roleSearchMarkdown.indexOf("模型后说 omega");
assert.ok(firstAiIndex >= 0 && toolIndex > firstAiIndex && secondAiIndex > toolIndex);

const customDir = path.join(os.tmpdir(), "memory-store-custom-export-dir", String(Date.now()));
const searchResult = await exportConversation({
    conversationId: "export-search-conversation",
    chainUsed: "windsurf",
    rounds,
    totalSteps: 31,
    format: "markdown",
    scope: "search",
    query: "gamma",
    contextRounds: 0,
    outputDir: customDir,
    depth: "brief",
    extraTypes: [],
    compactionMode: "folded",
    partialWarning: "WSF partial warning fixture",
});
assert.ok(fs.existsSync(customDir));
assert.match(searchResult.exportDir, new RegExp(customDir.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
const searchMarkdown = fs.readFileSync(searchResult.markdownPath || "", "utf-8");
assert.match(searchMarkdown, /第三轮，包含 gamma/u);
assert.doesNotMatch(searchMarkdown, /第二轮，包含 beta/u);
assert.match(searchMarkdown, /WSF partial warning fixture/u);

const overwriteDir = path.join(os.tmpdir(), "memory-store-overwrite-export-dir", String(Date.now()));
const fullResult = await exportConversation({
    conversationId: "export-full-conversation",
    chainUsed: "claude-code",
    rounds,
    totalSteps: 31,
    format: "markdown",
    scope: "full",
    outputDir: overwriteDir,
    overwrite: true,
    depth: "normal",
    extraTypes: [],
    compactionMode: "folded",
});
assert.equal(fullResult.exportDir, overwriteDir);
const fullMarkdown = fs.readFileSync(fullResult.markdownPath || "", "utf-8");
assert.match(fullMarkdown, /第一轮，包含 alpha/u);
assert.match(fullMarkdown, /第三轮，包含 gamma/u);

const cacheKey = { source: "codex", conversationId: "export-cache-conversation" };
const cachedRounds = [
    makeRound(1, "缓存第一轮", "缓存 AI 一"),
    makeRound(2, "缓存第二轮", "缓存 AI 二"),
    makeRound(3, "缓存第三轮", "缓存 AI 三"),
];
const publishedCache = await readOrBuildConversationSourceCache({
    key: cacheKey,
    fingerprint: { revision: "conversation-exporter-cache-test" },
    build: () => ({ snapshot: { version: 1 }, rounds: cachedRounds }),
    getRoundNumber: round => round.roundIndex,
});
const cachedFullDir = path.join(os.tmpdir(), "memory-store-cached-full-export-dir", String(Date.now()));
const cachedFullResult = await exportConversation({
    conversationId: cacheKey.conversationId,
    chainUsed: "codex",
    rounds: [],
    totalSteps: 31,
    cacheKey,
    cacheGeneration: publishedCache.generation,
    format: "markdown",
    scope: "full",
    outputDir: cachedFullDir,
    overwrite: true,
    depth: "normal",
    extraTypes: [],
    compactionMode: "folded",
    includeAssets: false,
});
const cachedFullMarkdown = fs.readFileSync(cachedFullResult.markdownPath || "", "utf-8");
assert.match(cachedFullMarkdown, /缓存第一轮/u);
assert.match(cachedFullMarkdown, /缓存第三轮/u);
assert.equal(cachedFullResult.stats.totalRounds, 3);
assert.equal(cachedFullResult.stats.roundsExported, 3);

const cachedRangeDir = path.join(os.tmpdir(), "memory-store-cached-range-export-dir", String(Date.now()));
const cachedRangeResult = await exportConversation({
    conversationId: cacheKey.conversationId,
    chainUsed: "codex",
    rounds: [],
    totalSteps: 31,
    cacheKey,
    cacheGeneration: publishedCache.generation,
    format: "markdown",
    scope: "rounds",
    startRound: 2,
    endRound: 2,
    outputDir: cachedRangeDir,
    overwrite: true,
    depth: "normal",
    extraTypes: [],
    compactionMode: "folded",
    includeAssets: false,
});
const cachedRangeMarkdown = fs.readFileSync(cachedRangeResult.markdownPath || "", "utf-8");
assert.match(cachedRangeMarkdown, /缓存第二轮/u);
assert.doesNotMatch(cachedRangeMarkdown, /缓存第一轮|缓存第三轮/u);
assert.match(cachedRangeMarkdown, /📊 统计: 1 轮对话/u);
assert.doesNotMatch(cachedRangeMarkdown, /📊 统计: 0 轮对话/u);
assert.equal(cachedRangeResult.stats.totalRounds, 3);
assert.equal(cachedRangeResult.stats.roundsExported, 1);

const previousExportMaxChars = process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS;
try {
    process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS = "6000000";
    const largeBody = `开头-${"x".repeat(5_100_000)}-结尾`;
    const largeExportResult = await exportConversation({
        conversationId: "export-large-full-conversation",
        chainUsed: "codex",
        rounds: [makeRound(1, largeBody)],
        totalSteps: 11,
        format: "markdown",
        scope: "full",
        outputDir: path.join(os.tmpdir(), "memory-store-large-export-dir", String(Date.now())),
        overwrite: true,
        depth: "normal",
        extraTypes: [],
        compactionMode: "folded",
        includeAssets: false,
    });
    const largeMarkdown = fs.readFileSync(largeExportResult.markdownPath || "", "utf-8");
    assert.ok(largeMarkdown.length > 5_000_000);
    assert.match(largeMarkdown, /-结尾/u);

    process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS = "10000";
    await assert.rejects(() => exportConversation({
        conversationId: "export-explicit-limit-conversation",
        chainUsed: "codex",
        rounds: [makeRound(1, "y".repeat(10_001))],
        totalSteps: 11,
        format: "markdown",
        scope: "full",
        outputDir: path.join(os.tmpdir(), "memory-store-explicit-limit-export-dir", String(Date.now())),
        overwrite: true,
        depth: "normal",
        extraTypes: [],
        compactionMode: "folded",
        includeAssets: false,
    }), /conversation export exceeds MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS/u);
} finally {
    if (previousExportMaxChars === undefined) delete process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS;
    else process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS = previousExportMaxChars;
}

const pdfDir = path.join(os.tmpdir(), "memory-store-pdf-export-dir", String(Date.now()));
const pdfBrowser = findPdfBrowser();
const pdfResult = await exportConversation({
    conversationId: "export-pdf-conversation",
    chainUsed: "windsurf",
    rounds,
    totalSteps: 31,
    format: "both",
    scope: "rounds",
    startRound: 2,
    endRound: 2,
    outputDir: pdfDir,
    overwrite: true,
    depth: "full",
    extraTypes: ["code_actions", "code_diffs"],
    compactionMode: "folded",
    pdfEmbedAttachments: "off",
});
assert.ok(fs.existsSync(pdfResult.markdownPath || ""));
const pdfMarkdown = fs.readFileSync(pdfResult.markdownPath || "", "utf-8");
assert.match(pdfMarkdown, /```diff/u);
assert.match(pdfMarkdown, /src\/demo\.ts/u);
assert.match(pdfMarkdown, /!\[round-2-media-1\]\(assets\/images\//u);
if (pdfBrowser) {
    assert.ok(pdfResult.pdfPath, "PDF browser exists, export should create a PDF");
    assert.ok(fs.existsSync(pdfResult.pdfPath || ""));
    assert.ok(fs.statSync(pdfResult.pdfPath || "").size > 0);
    assert.ok(fs.existsSync(pdfResult.htmlPath || ""));
    const pdfHtml = fs.readFileSync(pdfResult.htmlPath || "", "utf-8");
    assert.match(pdfHtml, /<img src="assets\/images\//u);
} else {
    assert.match(pdfResult.warnings.join("\n"), /未找到可用浏览器/u);
}

// 清理临时目录。Windows 下 PDF 导出可能仍有浏览器/LibreOffice 子进程短暂占用临时文件，
// 导致 rmSync 偶发 EPERM——这是 teardown 的环境竞态，与断言无关，带短重试并最终容忍。
function rmTolerant(target: string): void {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            return;
        } catch (err: any) {
            if (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "ENOTEMPTY") {
                // 句柄未释放，稍后重试
                const wait = Date.now() + 150;
                while (Date.now() < wait) { /* busy-wait 150ms */ }
                continue;
            }
            throw err;
        }
    }
    // 5 次仍失败 → teardown 容忍（临时目录由 OS 最终回收），不让 teardown 竞态失败整条测试。
}

rmTolerant(dataRoot);
rmTolerant(fixtureDir);
rmTolerant(roleUserDir);
rmTolerant(roleSearchDir);
rmTolerant(customDir);
rmTolerant(overwriteDir);
rmTolerant(pdfDir);
