import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-guard-final-coverage-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
const { applyGuardCoverageConstraints, collectGuardExecutionEvidence, mergeGuardFinalCoverage, parseGuardResult, renderGuardPromptForProvider, resolveGuardSelfReferenceResult } = await import("../src/guard-engine.js");
const { buildGuardEvidenceIndexes } = await import("../src/guard-evidence-index.js");
const base = { confidence: "high", truncationRisk: "none", sources: [], coverageGaps: [] } as const;
const modelPass = { passed: true, summary: "fixture evidence complete", missingItems: [], rawResponse: "PASS\nfixture evidence complete" };
const makeExternal = (status: "complete" | "partial" | "unread", role?: string) => ({
    text: "fixture index",
    manifestPath: path.join(fixtureRoot, "manifest.json"),
    items: [{ path: path.join(fixtureRoot, "evidence.txt"), kind: "text", ingestMode: "direct_text", parser: "fixture", ok: status !== "unread", text: "fixture", warnings: [], readStatus: status, sourceChars: 100, includedChars: status === "complete" ? 100 : 10, truncated: status !== "complete", role }],
    coverage: { requestedAssets: 1, completeAssets: status === "complete" ? 1 : 0, partialAssets: status === "partial" ? 1 : 0, unreadAssets: status === "unread" ? 1 : 0, sourceChars: 100, includedChars: status === "complete" ? 100 : 10, truncated: status !== "complete", coverageGaps: status === "complete" ? [] : [`fixture: ${status}`] },
}) as any;

try {
    const partial = makeExternal("partial");
    const coverage = mergeGuardFinalCoverage(base as any, partial);
    assert.equal(coverage.confidence, "low");
    assert.equal(coverage.truncationRisk, "high");
    assert.ok(coverage.requiredGaps?.length);
    const constrained = applyGuardCoverageConstraints(modelPass, coverage);
    assert.equal(constrained.passed, false);
    assert.equal(constrained.evidenceInsufficientReason, "REQUIRED_EVIDENCE_INCOMPLETE");
    assert.equal(constrained.rawResponse, modelPass.rawResponse);
    assert.equal(resolveGuardSelfReferenceResult({ ...constrained, missingItems: ["本次Guard通过记录未见"], summary: "实质证据已充分" }).passed, false);

    const optional = makeExternal("partial", "reference");
    const optionalCoverage = mergeGuardFinalCoverage(base as any, optional);
    assert.equal(optionalCoverage.requiredGaps?.length, 0);
    assert.equal(optionalCoverage.confidence, "medium");
    assert.equal(applyGuardCoverageConstraints(modelPass, optionalCoverage).passed, true);
    assert.equal(applyGuardCoverageConstraints(modelPass, mergeGuardFinalCoverage(base as any, makeExternal("complete"))).passed, true);
    assert.equal(applyGuardCoverageConstraints(modelPass, mergeGuardFinalCoverage(base as any, makeExternal("unread"))).passed, false);

    const previousBudget = process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET;
    try {
        process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = "6000";
        const rendered = renderGuardPromptForProvider({
            planContent: "small plan", taskContent: "small task", executionRecord: "", coverageText: "confidence: high", evidenceText: "",
            evidenceIndexText: "INDEX ".repeat(4000), evidenceIndexSourceChars: 80000, hasRequiredExternalAssets: true,
        }, "codex");
        const usage = rendered.budget.sections.find(section => section.name === "evidenceIndexText")!;
        assert.equal(usage.sourceChars, 80000);
        assert.equal(usage.availableChars, 24000);
        assert.equal(usage.preCompressedChars, 56000);
        assert.ok(usage.includedChars < 24000);
        assert.ok(rendered.prompt.length <= 6000);
        assert.match(rendered.prompt, /最终模型输入覆盖/u);
        assert.match(rendered.prompt, /confidence: low; truncationRisk: high/u);
        const finalCoverage = mergeGuardFinalCoverage(base as any, makeExternal("complete"), rendered.budget);
        assert.equal(applyGuardCoverageConstraints(modelPass, finalCoverage).passed, false);
    } finally {
        if (previousBudget === undefined) delete process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET;
        else process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = previousBudget;
    }

    const diagnosticBase = { callId: "fixture-call", rejectedCommandCount: 1, modelReportedRefusal: false } as any;
    const rejected = applyGuardCoverageConstraints(modelPass, mergeGuardFinalCoverage(base as any, makeExternal("complete")), diagnosticBase);
    assert.equal(rejected.evidenceInsufficientReason, "COMMAND_REJECTED");
    assert.equal(rejected.safetyStopped, true);
    assert.equal(rejected.passed, false);
    const claimed = applyGuardCoverageConstraints({ passed: false, summary: "fixture claim", missingItems: [], rawResponse: "EVIDENCE_INSUFFICIENT\n本机读取命令被策略拒绝", evidenceInsufficient: true }, coverage, { ...diagnosticBase, rejectedCommandCount: 0, modelReportedRefusal: true });
    assert.equal(claimed.evidenceInsufficientReason, "MODEL_REPORTED_REFUSAL_UNVERIFIED");
    assert.equal(claimed.safetyStopped, true);
    for (const raw of ["PASS\n读取命令被策略拒绝", "FAIL\n实质证据已充分，读取命令被策略拒绝\n- MISSING: 本次Guard通过记录未见"]) {
        const stopped = resolveGuardSelfReferenceResult(applyGuardCoverageConstraints(parseGuardResult(raw), optionalCoverage, { ...diagnosticBase, rejectedCommandCount: 0, modelReportedRefusal: true }));
        assert.equal(stopped.passed, false);
        assert.equal(stopped.evidenceInsufficientReason, "MODEL_REPORTED_REFUSAL_UNVERIFIED");
        assert.equal(stopped.safetyStopped, true);
    }
    for (const diagnostics of [{ ...diagnosticBase, rejectedCommandCount: 0, eventCoverage: "partial" }, { ...diagnosticBase, rejectedCommandCount: 0, captureError: "fixture storage unavailable" }]) {
        const stopped = applyGuardCoverageConstraints(modelPass, optionalCoverage, diagnostics);
        assert.equal(stopped.passed, false);
        assert.equal(stopped.evidenceInsufficientReason, "CLI_DIAGNOSTICS_INCOMPLETE");
    }
    const previousLimit = process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET;
    process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = "6500";
    const executionRendered = renderGuardPromptForProvider({ planContent: "plan", taskContent: "task", executionRecord: "execution ".repeat(4000), evidenceText: "forced ".repeat(6000), coverageText: "high", evidenceIndexText: "", hasRequiredExternalAssets: false }, "codex");
    const executionCoverage = mergeGuardFinalCoverage(base as any, { ...makeExternal("complete"), items: [], coverage: { ...makeExternal("complete").coverage, requestedAssets: 0 } }, executionRendered.budget);
    assert.equal(applyGuardCoverageConstraints(modelPass, executionCoverage).passed, false);
    assert.ok(executionCoverage.requiredGaps?.some(gap => gap.startsWith("executionRecord:")));
    assert.ok(executionCoverage.requiredGaps?.some(gap => gap.startsWith("evidenceText:")));
    assert.match(executionRendered.prompt, /confidence: low; truncationRisk: high/u);
    process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = "100000";
    const requiredPath = path.join(fixtureRoot, "required.txt");
    const referencePath = path.join(fixtureRoot, "reference.txt");
    fs.writeFileSync(requiredPath, "complete required fixture");
    fs.writeFileSync(referencePath, "reference ".repeat(5000));
    const mixed = await buildGuardEvidenceIndexes([{ path: requiredPath }, { path: referencePath, role: "reference", maxChars: 3000 }], { maxTotalChars: 10000 });
    const required = mixed.items[0];
    assert.ok(required.includedStart !== undefined && required.includedEnd !== undefined);
    const requiredBlock = mixed.text.slice(required.includedStart, required.includedEnd);
    assert.match(requiredBlock, /complete required fixture/u);
    const mixedRender = renderGuardPromptForProvider({ planContent: "plan", taskContent: "task", executionRecord: "", evidenceText: "", coverageText: "coverage", evidenceIndexText: mixed.text, evidenceIndexSourceChars: mixed.coverage.sourceChars, hasRequiredExternalAssets: true, requiredExternalBlocks: [requiredBlock] }, "codex");
    const mixedCoverage = mergeGuardFinalCoverage(base as any, mixed, mixedRender.budget);
    assert.equal(mixedCoverage.requiredGaps?.length, 0);
    assert.equal(applyGuardCoverageConstraints(modelPass, mixedCoverage).passed, true);
    if (previousLimit === undefined) delete process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET;
    else process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = previousLimit;
    const round = { roundIndex: 4, startStep: 0, endStep: 1, userMessage: "fixture ".repeat(500), mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
    const execution = collectGuardExecutionEvidence([round, { ...round, roundIndex: 6 }], 4, 350, "fixture");
    assert.ok(execution.coverageGaps.some(gap => gap.includes("brief") || gap.includes("unread")));
    assert.ok(execution.sourceChars > execution.includedChars);
    assert.equal(applyGuardCoverageConstraints(modelPass, mergeGuardFinalCoverage({ ...base, executionEvidence: execution } as any, makeExternal("complete"))).passed, false);
    const referenceExecutionCoverage = mergeGuardFinalCoverage({ ...base, executionEvidence: { ...execution, role: "reference" } } as any, makeExternal("complete"));
    assert.equal(applyGuardCoverageConstraints(modelPass, referenceExecutionCoverage).passed, true);
    const referenceWithoutRequired = mergeGuardFinalCoverage({ ...base, executionEvidence: { ...execution, role: "reference" } } as any, optional);
    assert.equal(applyGuardCoverageConstraints(modelPass, referenceWithoutRequired).passed, false);
    console.log("guard-final-coverage: PASS required/reference/source counts/provider compression/self-reference/refusal provenance");
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
