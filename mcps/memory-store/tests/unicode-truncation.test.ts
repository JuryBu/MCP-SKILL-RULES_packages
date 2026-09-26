import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-unicode-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE = "off";
const { formatRound, formatRoundForMessageRoles, searchInRounds } = await import("../src/trajectory.js");
const { renderGuardPromptForProvider } = await import("../src/guard-engine.js");
const { buildGuardEvidenceIndexes } = await import("../src/guard-evidence-index.js");
const { sliceUnicodeSafe } = await import("../src/unicode-text.js");
const { buildCodexRoundsForTest } = await import("../src/codex-client.js");
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const failures: string[] = [];
const passed: string[] = [];

function round(text: string): ConversationRound {
    return {
        roundIndex: 1, startStep: 0, endStep: 2, userMessage: text,
        mediaAttachments: [], attachments: [],
        aiResponses: [{ stepIndex: 1, response: text, thinking: "", toolCalls: [] }],
        toolCalls: [{ stepIndex: 2, name: "fixture", argsSummary: "", resultSummary: text }],
        taskBoundaries: [], codeActions: [], fileViews: [], subagentSummaries: [],
    };
}

function verify(text: string, context: string): void {
    assert.doesNotMatch(text, invalidUnicode, context);
    assert.doesNotMatch(text, /\uFFFD/u, `${context}: must preserve valid input without replacement characters`);
}

async function check(name: string, operation: () => void | Promise<void>): Promise<void> {
    try { await operation(); passed.push(name); }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}`); }
}

try {
    await check("all slice boundaries", () => {
        const fixture = "A😀B𠀀C";
        for (let start = 0; start <= fixture.length; start += 1) {
            for (let end = start; end <= fixture.length; end += 1) {
                const sliced = sliceUnicodeSafe(fixture, start, end);
                verify(sliced, `${start}:${end}`);
                assert.ok(sliced.length <= end - start);
            }
        }
        assert.equal(sliceUnicodeSafe(fixture), fixture);
        assert.equal(sliceUnicodeSafe(fixture, 4, 2), "");
        assert.equal(sliceUnicodeSafe(fixture, 0, Infinity), fixture);
        assert.equal(sliceUnicodeSafe("existing\uD83D", 0), "existing\uD83D", "source corruption is not silently normalized");
    });
    await check("tool-result normal boundary", () => verify(formatRound(round("x".repeat(199) + "🛡tail"), "normal", ["tool_results"]), "200-unit tool summary"));
    await check("Codex source summary boundaries", () => {
        const argumentsText = "x".repeat(119) + "😀tail";
        const outputText = "x".repeat(499) + "𠀀tail";
        const built = buildCodexRoundsForTest([
            { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] } },
            { type: "response_item", payload: { type: "function_call", name: "fixture", call_id: "fixture-call", arguments: argumentsText } },
            { type: "response_item", payload: { type: "function_call_output", call_id: "fixture-call", output: outputText } },
        ], "reference");
        const tool = built.rounds.flatMap(item => item.toolCalls)[0];
        assert.ok(tool);
        verify(tool.argsSummary, "Codex 120-unit argument summary");
        verify(tool.resultSummary, "Codex 500-unit result summary");
        assert.equal(tool.argsFull, argumentsText);
        assert.equal(tool.resultFull, outputText);
    });
    await check("legacy malformed tool summary", () => {
        const fixture = round("fixture");
        fixture.toolCalls[0].argsSummary = "x".repeat(119) + "\uD83D...";
        fixture.toolCalls[0].argsFull = "x".repeat(119) + "😀tail";
        fixture.toolCalls[0].resultSummary = "prefix\uDC00suffix";
        fixture.toolCalls[0].resultFull = "complete result 😀";
        const before = JSON.stringify(fixture);
        const rendered = formatRound(fixture, "normal", ["tool_results"]);
        verify(rendered, "legacy summary recovered from full fields");
        assert.match(rendered, /complete result 😀/u);
        assert.doesNotMatch(rendered, /摘要含不完整/u);
        assert.equal(JSON.stringify(fixture), before, "rendering must not rewrite cached fields");
        delete fixture.toolCalls[0].argsFull;
        delete fixture.toolCalls[0].resultFull;
        const escaped = formatRound(fixture, "normal", ["tool_results"]);
        verify(escaped, "legacy summary without full fields");
        assert.ok(escaped.includes("\\ud83d"));
        assert.match(escaped, /摘要含不完整UTF-16码元，已转义/u);
        verify(formatRoundForMessageRoles(fixture, "normal", ["tool_results"], new Set(["tool"]), "folded"), "legacy role view");
    });
    await check("tool-result full boundary", () => verify(formatRound(round("x".repeat(499) + "𠀀tail"), "full", ["tool_results"]), "500-unit tool summary"));
    await check("brief response boundary", () => verify(formatRound(round("x".repeat(99) + "😀tail"), "brief"), "100-unit brief response"));
    await check("role view boundary", () => verify(formatRoundForMessageRoles(round("x".repeat(19_999) + "😀tail"), "normal", [], new Set(["user"]), "folded"), "20K role view"));
    await check("search context prefix and suffix", () => {
        const fixture = round("😀" + "x".repeat(99) + "needle" + "x".repeat(99) + "😀tail");
        const matches = searchInRounds([fixture], "needle", 2);
        assert.ok(matches.length > 0);
        for (const match of matches) { verify(match.matchText, "search context boundary"); assert.match(match.matchText, /needle/u); }
    });
    await check("provider budgets", () => {
        for (const provider of ["grok", "agy", "codex"]) {
            for (let offset = 0; offset < 4; offset += 1) {
                const rendered = renderGuardPromptForProvider({
                    planContent: "plan", taskContent: "task", coverageText: "covered", evidenceText: "evidence", evidenceIndexText: "index",
                    executionRecord: "x".repeat(offset) + "🛡".repeat(150_000),
                }, provider);
                assert.ok(rendered.prompt.length <= rendered.budget.inputBudgetChars);
                verify(rendered.prompt, `${provider} budget offset ${offset}`);
            }
        }
    });
    await check("external evidence boundary", async () => {
        const evidencePath = path.join(fixtureRoot, "evidence.md");
        fs.writeFileSync(evidencePath, "x".repeat(1_919) + "😀" + "tail".repeat(500), "utf8");
        const indexed = await buildGuardEvidenceIndexes([{ path: evidencePath, maxChars: 2_000 }], { indexMode: "rebuild", maxFileChars: 2_000, maxTotalChars: 8_000 });
        assert.equal(indexed.items[0].ok, true);
        verify(indexed.items[0].text, "external evidence item");
        verify(indexed.text, "external evidence prompt");
        assert.ok(indexed.items[0].artifactPath);
        verify(fs.readFileSync(indexed.items[0].artifactPath, "utf8"), "persisted external evidence artifact");
        for (let offset = 0; offset < 2; offset += 1) {
            fs.writeFileSync(evidencePath, "x".repeat(offset) + "😀".repeat(3_000), "utf8");
            const boundary = await buildGuardEvidenceIndexes([{ path: evidencePath, maxChars: 2_000 }], { indexMode: "rebuild", maxFileChars: 2_000, maxTotalChars: 2_000 });
            verify(boundary.items[0].text, `double clipping offset ${offset}`);
            verify(boundary.text, `total evidence budget offset ${offset}`);
            assert.match(boundary.text, /-> 2000 chars\]$/u, "total evidence budget must actually truncate");
        }
    });
    await check("untruncated content unchanged", () => {
        const text = "English 中文 😀 𠀀 e\u0301 👩‍💻";
        const rendered = formatRound(round(text), "full", ["tool_results"]);
        verify(rendered, "untruncated multilingual content");
        assert.ok(rendered.includes(text));
    });
    console.log(JSON.stringify({ passed, failures }));
    assert.deepEqual(failures, []);
} finally {
    assert.equal(path.dirname(fixtureRoot), os.tmpdir());
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
