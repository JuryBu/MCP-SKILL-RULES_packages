import assert from "node:assert/strict";
import { formatRound, type ConversationRound } from "../src/trajectory.js";
import {
    buildAdjacentContext, buildOpenPhaseSnippet, buildRecordSchedulerSplitPrompt,
    formatRoundsForRecord, normalizeSnippetText, summarizeRecordStructure, trimRecordForPrompt,
    type FormattedRecordRound, type RecordChunk,
} from "../src/record-generator.js";

const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function assertWellFormed(text: string, label: string): void {
    assert.equal(invalidUnicode.test(text), false, label);
    assert.equal(text.includes("\uFFFD"), false, `${label}: replacement character`);
}

const failures: string[] = [];
function check(label: string, render: () => string): void {
    try { assertWellFormed(render(), label); }
    catch { failures.push(label); }
}

function round(text: string): ConversationRound {
    return {
        roundIndex: 1, startStep: 0, endStep: 1, userMessage: text,
        mediaAttachments: [], attachments: [], aiResponses: [], toolCalls: [],
        taskBoundaries: [], codeActions: [], fileViews: [], subagentSummaries: [],
    };
}

const offset = formatRound(round("x".repeat(100)), "normal").indexOf("x".repeat(100));
const oversizedRound = round("x".repeat(35_999 - offset) + "😀" + "x".repeat(70_000));
assertWellFormed(formatRound(oversizedRound, "normal"), "clean source round");
check("60K single-round cut", () => formatRoundsForRecord([oversizedRound])[0].text);
const suffixLength = formatRound(round("x".repeat(100)), "normal").length - offset - 100;
const tailEmojiStart = 70_000 + suffixLength - 24_001;
const tailRound = round("x".repeat(tailEmojiStart) + "😀" + "x".repeat(70_000 - tailEmojiStart - 2));
check("60K single-round tail", () => formatRoundsForRecord([tailRound])[0].text);

const openPhase = "x".repeat(29_999) + "😀" + "x".repeat(25_000);
assertWellFormed(openPhase, "clean open phase");
check("50K open-phase cut", () => buildOpenPhaseSnippet({ startRound: 1, endRound: 1, markdown: openPhase }));
check("50K open-phase tail", () => buildOpenPhaseSnippet({ startRound: 1, endRound: 1,
    markdown: "x".repeat(35_000) + "😀" + "x".repeat(19_999) }));

const adjacentText = "x".repeat(5_999) + "😀" + "x".repeat(100);
const formatted = [1, 2, 3].map(roundIndex => ({
    round: { ...round("middle"), roundIndex }, text: adjacentText, chars: adjacentText.length,
})) satisfies FormattedRecordRound[];
const chunk = { startRound: 2, endRound: 2 } as RecordChunk;
check("6K adjacent rounds", () => buildAdjacentContext(formatted, chunk));

const schedulerPrompt = "x".repeat(1_999) + "😀" + "x".repeat(8_000);
check("scheduler middle split", () => buildRecordSchedulerSplitPrompt(schedulerPrompt,
    { axis: "round", start: 1, end: 2 }, { axis: "round", start: 1, end: 1 }));
check("scheduler tail split", () => buildRecordSchedulerSplitPrompt("x".repeat(9_000) + "😀" + "x".repeat(999),
    { axis: "round", start: 1, end: 2 }, { axis: "round", start: 1, end: 1 }));

check("old Record summary", () => summarizeRecordStructure("x".repeat(11_999) + "😀" + "x".repeat(100)));
check("old Record headed summary", () => summarizeRecordStructure("# " + "x".repeat(11_997) + "😀" + "x".repeat(100)));
check("controlled rebuild Record snippet", () => normalizeSnippetText("x".repeat(116) + "😀" + "x".repeat(100), 180));
check("Codex Record context", () => trimRecordForPrompt("x".repeat(7_999) + "😀" + "x".repeat(40_000), "codex"));
check("Codex Record tail context", () => trimRecordForPrompt("x".repeat(17_999) + "😀" + "x".repeat(21_999), "codex"));

assert.deepEqual(failures, []);
console.log("record Unicode cuts: PASS");
