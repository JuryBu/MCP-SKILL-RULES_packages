import assert from "node:assert/strict";
import { formatConversationReadDelivery, formatPaginatedConversationReadText, paginateConversationReadText } from "../src/tools/conversation.ts";

const defaultBoundaryText = "a".repeat(100_000) + "终";
const defaultBoundary = paginateConversationReadText({
    conversationId: "continuation-default-boundary",
    text: defaultBoundaryText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
});
assert.equal(defaultBoundary.text.length, 100_000);
assert.equal(defaultBoundary.hasMore, true);
assert.ok(defaultBoundary.cursor);

const emojiText = "ab😀cd";
const emojiFirstPage = paginateConversationReadText({
    conversationId: "continuation-emoji",
    text: emojiText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
    maxBytes: 6,
});
assert.equal(emojiFirstPage.text, "ab😀");
assert.equal(Buffer.byteLength(emojiFirstPage.text, "utf8"), 6);
assert.ok(emojiFirstPage.cursor);
const emojiSecondPage = paginateConversationReadText({
    conversationId: "continuation-emoji",
    text: emojiText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
    maxBytes: 6,
    continuationCursor: emojiFirstPage.cursor,
});
assert.equal(emojiSecondPage.text, "cd");
assert.equal(emojiFirstPage.text + emojiSecondPage.text, emojiText);

const tamperedPayload = JSON.parse(Buffer.from(defaultBoundary.cursor || "", "base64url").toString("utf8"));
tamperedPayload.charPosition += 1;
const tamperedCursor = Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64url");
assert.throws(() => paginateConversationReadText({
    conversationId: "continuation-default-boundary",
    text: defaultBoundaryText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
    continuationCursor: tamperedCursor,
}), /integrity check failed/u);
assert.throws(() => paginateConversationReadText({
    conversationId: "continuation-default-boundary",
    text: `${defaultBoundaryText} changed`,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
    continuationCursor: defaultBoundary.cursor,
}), /source changed/u);

const fullText = Array.from({ length: 500 }, (_, index) => `第${index + 1}段😀内容\n`).join("");
const sourcePositions = [
    { charPosition: 0, roundIndex: 1, stepIndex: 10 },
    { charPosition: Math.floor(fullText.length / 2), roundIndex: 2, stepIndex: 20 },
];
const deliveredPages: string[] = [];
let continuationCursor: string | undefined;
do {
    const page = paginateConversationReadText({
        conversationId: "continuation-reassemble",
        text: fullText,
        sourcePositions,
        maxBytes: 97,
        continuationCursor,
    });
    assert.ok(Buffer.byteLength(page.text, "utf8") <= 97);
    deliveredPages.push(page.text);
    continuationCursor = page.cursor;
} while (continuationCursor);
assert.equal(deliveredPages.join(""), fullText);

const roundBoundaryText = "## 轮次 1\n\n第一轮正文\n\n## 轮次 2\n\n" + "第二轮很长".repeat(80);
const secondRoundPosition = roundBoundaryText.indexOf("## 轮次 2");
const roundBoundaryPage = paginateConversationReadText({
    conversationId: "continuation-round-boundary",
    text: roundBoundaryText,
    sourcePositions: [
        { charPosition: 0, roundIndex: 1, stepIndex: 1 },
        { charPosition: secondRoundPosition, roundIndex: 2, stepIndex: 3 },
    ],
    maxBytes: Buffer.byteLength(roundBoundaryText.slice(0, secondRoundPosition + 30), "utf8"),
});
assert.equal(roundBoundaryPage.endCharPosition, secondRoundPosition, "预算进入下一轮时必须回退到完整轮次边界");
assert.equal(roundBoundaryPage.hardSplit, undefined);

const prefixedLongRoundText = "读取概览\n\n## 轮次 59\n\n" + "第一请求轮很长\n".repeat(80);
const firstRoundBodyPosition = prefixedLongRoundText.indexOf("## 轮次 59");
const prefixedLongRoundPage = paginateConversationReadText({
    conversationId: "continuation-prefixed-long-first-round",
    text: prefixedLongRoundText,
    sourcePositions: [
        { charPosition: 0, roundIndex: 59, stepIndex: 100 },
        { charPosition: firstRoundBodyPosition, roundIndex: 59, stepIndex: 100 },
    ],
    maxBytes: 160,
});
assert.ok(prefixedLongRoundPage.text.includes("## 轮次 59"), "概览后的首轮自身超预算时不能退回成只有概览的空正文页");
assert.ok(prefixedLongRoundPage.endCharPosition > firstRoundBodyPosition, "首个分页必须真正进入请求的第一轮正文");

const fencedText = "代码说明\n\n```diff\n" + "+ very long diff line\n".repeat(80) + "```\n尾部";
const fencedPage = paginateConversationReadText({
    conversationId: "continuation-code-fence",
    text: fencedText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
    maxBytes: 120,
});
assert.equal(fencedPage.text, "代码说明\n\n", "预算落入代码围栏时应先回退到围栏前的完整块边界");
const hardFencePage = paginateConversationReadText({
    conversationId: "continuation-code-fence",
    text: fencedText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
    continuationCursor: fencedPage.cursor,
    maxBytes: 120,
});
assert.equal(hardFencePage.hardSplit, true, "单个代码围栏自身超预算时必须明确标记结构内硬切");
assert.equal(hardFencePage.splitReason, "inside_code_fence");
const formattedHardFence = formatConversationReadDelivery(hardFencePage, { action: "read" });
assert.ok(formattedHardFence.indexOf("➡️ 下一段参数") < formattedHardFence.indexOf("```diff"), "结构内硬切时续读参数必须显示在半截 Markdown 正文之前");

const smallText = "旧的小结果应保持原文本兼容";
const smallDelivery = paginateConversationReadText({
    conversationId: "continuation-small",
    text: smallText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 10 }],
});
assert.equal(smallDelivery.hasMore, false);
assert.equal(formatConversationReadDelivery(smallDelivery, { action: "read" }), smallText);
const terminalWindowDelivery = formatConversationReadDelivery(
    smallDelivery,
    { action: "read", continuationCursor: "unused" },
    { action: "read", startRound: 61, endRound: 63 },
);
assert.match(terminalWindowDelivery, /➡️ 下一段参数\n\{"action":"read","startRound":61,"endRound":63\}$/u);

const oversizedReadText = "大段😀内容\n".repeat(320_000);
const oversizedFirstPage = formatPaginatedConversationReadText({
    conversationId: "continuation-over-2m",
    text: oversizedReadText,
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
    nextParams: { action: "read", conversationId: "continuation-over-2m" },
    detail: "⏱️ 测试计时详情",
});
assert.ok(oversizedReadText.length > 2_000_000);
assert.ok(oversizedFirstPage.text.length <= 100_000, "默认 100K 必须覆盖正文、尾预览、光标和详情，而非只限制正文");
assert.equal(oversizedFirstPage.delivery.hasMore, true);

const byteBudgetPage = formatPaginatedConversationReadText({
    conversationId: "continuation-byte-budget",
    text: "😀字节预算".repeat(50_000),
    sourcePositions: [{ charPosition: 0, roundIndex: 1, stepIndex: 1 }],
    maxBytes: 16_384,
    nextParams: { action: "read", conversationId: "continuation-byte-budget", maxBytes: 16_384 },
    detail: "⏱️ 测试计时详情",
});
assert.ok(Buffer.byteLength(byteBudgetPage.text, "utf8") + 1_024 <= 16_384, "显式 maxBytes 必须包含返回包装和最终计时预留");

console.log("✅ conversation-continuation 通过：100K 分页、Emoji、结构边界、硬切提示、光标校验与逐段拼接均符合预期");
