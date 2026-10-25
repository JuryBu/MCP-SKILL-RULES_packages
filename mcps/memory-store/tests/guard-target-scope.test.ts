import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-target-scope-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_GUARD_EVIDENCE_TOTAL_CHARS = "100000";
const { buildGuardInputBundle, validateGuardTargetScope, findDeclaredGuardPlanFiles, materializeLocatorSuggestions, runGuardCheck, __testSetGuardModelBridge } = await import("../src/guard-engine.ts");
const write = (name: string, content: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, content, "utf8");
    return file;
};

try {
    const task = write("Task.md", [
        '<!-- STAGE_GUARD_LOCK_BEGIN {"stageId":"Stage 63","scopeSelectors":["scope-a"]} -->',
        "## Stage 63 fake lock heading", "<!-- STAGE_GUARD_LOCK_END -->", "# Task", "## 适用全局要求", "禁止重启共享服务 GLOBAL-SAFETY",
        "```markdown", "## Stage 63 fake example", "npm run test:fake-example", "```",
        "## Stage 6", "npm run test:old-office", "## Stage 63", "- [x] scope-a: CURRENT-A", "  - npm run test:navigation-safe-read",
        "- [ ] scope-b: CURRENT-B", "## Stage 64", "npm run test:future-release",
    ].join("\n"));
    const plan = write("Plan.md", [
        "# Plan", "## 目标与授权", "PLAN-GLOBAL", "## 执行阶段", "| 阶段 | 验收 |", "| --- | --- |",
        "| Stage 6 | OLD-PLAN |", "| Stage63 | CURRENT-PLAN |", "| Stage 64 | FUTURE-PLAN |",
    ].join("\n"));
    for (const stage of ["Stage63", "Stage 63"]) {
        assert.deepEqual(validateGuardTargetScope([task], [plan], stage, []), []);
        const bundle = buildGuardInputBundle([plan], [task], stage);
        assert.match(bundle.taskContent, /CURRENT-A/u);
        assert.match(bundle.taskContent, /GLOBAL-SAFETY/u);
        assert.match(bundle.planContent, /CURRENT-PLAN/u);
        assert.match(bundle.planContent, /PLAN-GLOBAL/u);
        assert.doesNotMatch(bundle.taskContent + bundle.planContent + bundle.evidenceText, /old-office|future-release|fake-example|OLD-PLAN|FUTURE-PLAN|STAGE_GUARD_LOCK/u);
        assert.match(bundle.coverageText, /L13-/u);
        assert.deepEqual(bundle.coverage.requiredGaps, []);
    }
    const scoped = buildGuardInputBundle([plan], [task], "Stage63", ["scope-a"]);
    assert.match(scoped.taskContent, /CURRENT-A/u);
    assert.match(scoped.taskContent, /GLOBAL-SAFETY/u);
    assert.match(scoped.planContent, /PLAN-GLOBAL/u);
    assert.doesNotMatch(scoped.taskContent, /CURRENT-B/u);
    const plainTable = write("PlainTable.md", "# Plan\n## 目标\nGLOBAL\n阶段 | 验收\n--- | ---\nStage6 | OLD\nStage 63 | CURRENT-PLAIN\nStage64 | NEXT\n");
    const plain = buildGuardInputBundle([plainTable], [task], "Stage63");
    assert.match(plain.planContent, /CURRENT-PLAIN/u);
    assert.doesNotMatch(plain.planContent, /\| OLD|\| NEXT/u);
    const fencedTask = write("FencedTask.md", [
        "# Task", "## Stage63", "- [x] 必须执行下列验收命令并核对返回", "```powershell",
        "node scripts/http-required.mjs --require-http-log", "## Stage64", "node scripts/still-current.mjs", "Write-Output 'STAGE_GUARD_LOCK_BEGIN'", "```",
        "```json", '{"requiredStatus":"completed"}', "```", "### 代码示例", "```powershell",
        "npm run test:sample-only", "```", "## Stage64", "node scripts/future.mjs",
    ].join("\n"));
    const fencedBundle = buildGuardInputBundle([], [fencedTask], "Stage63");
    assert.equal(fencedBundle.coverage.confidence, "high");
    assert.match(fencedBundle.taskContent, /http-required\.mjs/u);
    assert.match(fencedBundle.taskContent, /still-current\.mjs/u);
    assert.match(fencedBundle.taskContent, /requiredStatus/u);
    assert.match(fencedBundle.taskContent, /Write-Output 'STAGE_GUARD_LOCK_BEGIN'/u);
    assert.doesNotMatch(fencedBundle.taskContent, /sample-only|future\.mjs/u);
    assert.ok(fencedBundle.evidenceManifest.commands.some(command => command.includes("http-required.mjs")));
    assert.ok(fencedBundle.evidenceManifest.commands.some(command => command.includes("still-current.mjs")));
    const fencedLocated = materializeLocatorSuggestions([{ file: fencedTask, startLine: 1, endLine: 30 }], [], [fencedTask], "Stage63");
    assert.match(fencedLocated.taskSegments.join("\n"), /http-required\.mjs/u);
    assert.doesNotMatch(fencedLocated.taskSegments.join("\n"), /sample-only|future\.mjs/u);
    const unrelatedGlobal = write("NotGlobal.md", "# Task\n## 全局搜索旧实验\nnpm run test:old-search\n## Stage63\nCURRENT\n");
    assert.doesNotMatch(buildGuardInputBundle([], [unrelatedGlobal], "Stage63").taskContent, /old-search/u);
    const locator = materializeLocatorSuggestions([{ file: task, startLine: 1, endLine: 100 }], [plan], [task], "Stage63", ["scope-a"]);
    assert.match(locator.taskSegments.join("\n"), /CURRENT-A/u);
    assert.doesNotMatch(locator.taskSegments.join("\n"), /old-office|future-release|CURRENT-B|STAGE_GUARD_LOCK/u);
    const unitTask = write("Units.md", "# Task\n## 总原则\nGLOBAL\n## Stage 63\n### U102\nUNIT102\n### U103\nUNIT103\n## Stage 64\nFUTURE\n");
    const unit = buildGuardInputBundle([], [unitTask], "Stage63-U102");
    assert.match(unit.taskContent, /UNIT102/u);
    assert.doesNotMatch(unit.taskContent, /UNIT103|FUTURE/u);
    assert.ok(validateGuardTargetScope([unitTask], [], "Stage6", []).some(gap => gap.includes("unresolved")));
    assert.ok(validateGuardTargetScope([task], [], "", []).some(gap => gap.includes("stageId missing")));
    assert.ok(validateGuardTargetScope([task], [], "Stage630", []).some(gap => gap.includes("unresolved")));
    assert.ok(validateGuardTargetScope([task], [], "Stage63", ["not-found"]).some(gap => gap.includes("selector not found")));
    const duplicate = write("Duplicate.md", "# Task\n## Stage 63\nA\n## Stage63\nB\n");
    assert.ok(validateGuardTargetScope([duplicate], [], "Stage63", []).some(gap => gap.includes("ambiguous")));
    const duplicateSelector = write("Selector.md", "# Task\n## Stage 63\n- scope-a\n- scope-a\n");
    assert.ok(validateGuardTargetScope([duplicateSelector], [], "Stage63", ["scope-a"]).some(gap => gap.includes("ambiguous")));
    const lightweight = write("Lightweight.md", "# Single task\n- [x] Verify the artifact\n");
    assert.deepEqual(validateGuardTargetScope([lightweight], [], "", []), []);
    assert.deepEqual(validateGuardTargetScope([lightweight], [], "legacy-label", []), []);
    assert.match(buildGuardInputBundle([], [lightweight]).taskContent, /Verify the artifact/u);
    assert.ok(validateGuardTargetScope([path.join(root, "missing.md")], [], "Stage63", []).some(gap => gap.includes("unreadable")));
    const declared = write("Declared.md", `# Task\n计划：[目标](Plan.md)。\n普通提及 Plan_other.md\n\x60\x60\x60\n计划：ignored.md\n\x60\x60\x60\n## Stage 63\n计划：not-metadata.md\n`);
    assert.deepEqual(findDeclaredGuardPlanFiles([declared]), [plan]);
    assert.deepEqual(findDeclaredGuardPlanFiles([lightweight]), []);
    let modelCalls = 0;
    __testSetGuardModelBridge({ call: async () => { modelCalls += 1; throw new Error("unexpected model call"); } });
    const result = await runGuardCheck({ active: true, guardId: "scope-preflight", conversationId: "never-read", stageId: "Stage630", childScopeId: "main", scopeSelectors: [], taskFiles: [task], planFiles: [plan], startRound: 1, startedAt: new Date().toISOString(), checkHistory: [], chain: "codex", modelChain: "codex" });
    assert.equal(result.evidenceInsufficient, true);
    assert.equal(result.infrastructureError, false);
    assert.equal(modelCalls, 0);
    assert.ok(result.coverage?.requiredGaps?.length);
    const requiredAsset = write("required.txt", "REQUIRED-RAW\n".repeat(2500));
    const state = { active: true, guardId: "provider-preflight", conversationId: "", stageId: "legacy-label", childScopeId: "main", scopeSelectors: [], taskFiles: [lightweight], planFiles: [], startRound: 1, startedAt: new Date().toISOString(), checkHistory: [], chain: "codex" as const, modelChain: "auto" as const };
    const providers: string[] = [];
    __testSetGuardModelBridge({
        candidates: async () => ["grok", "agy"],
        call: async (_model, _prompt, provider) => { providers.push(provider); return { text: null, error: "fixture unavailable", infrastructureError: true, chainUsed: provider }; },
    });
    const fallback = await runGuardCheck(state, undefined, undefined, { evidenceAssets: [{ path: requiredAsset, role: "required", maxChars: 80000 }], executionEvidenceRole: "reference" });
    assert.deepEqual(providers, ["grok"]);
    assert.equal(fallback.evidenceInsufficient, true);
    assert.equal(fallback.infrastructureError, false);
    assert.equal(fallback.promptBudget?.provider, "agy");
    const fallbackReport = fs.readFileSync(fallback.reportPath!, "utf8");
    assert.match(fallbackReport, /body=\d+, metadata=\d+, required=\d+, granted=\d+, shortfall=0, completeSourceKnown=true/u);
    const partial = await runGuardCheck(state, undefined, undefined, { evidenceAssets: [{ path: requiredAsset, role: "required", maxChars: 1800 }], executionEvidenceRole: "reference" });
    assert.deepEqual(providers, ["grok"]);
    assert.equal(partial.evidenceInsufficient, true);
    assert.match(fs.readFileSync(partial.reportPath!, "utf8"), /shortfall=[1-9]\d*/u);
    const noRequired = await runGuardCheck(state, undefined, undefined, { evidenceAssets: [{ path: requiredAsset, role: "reference", maxChars: 1800 }], executionEvidenceRole: "reference" });
    assert.equal(noRequired.evidenceInsufficient, true);
    assert.deepEqual(providers, ["grok"]);
    __testSetGuardModelBridge({ candidates: async () => ["codex"], call: async () => ({ text: "FAIL\nHTTP原件缺失\n- MISSING: 本次 Guard 检查缺少 HTTP 原始日志", chainUsed: "codex", modelUsed: "fixture" }) });
    const missingHttp = await runGuardCheck(state, undefined, undefined, { evidenceAssets: [{ path: requiredAsset, role: "required", maxChars: 80000 }], executionEvidenceRole: "reference" });
    assert.equal(missingHttp.passed, false);
    assert.equal(missingHttp.evidenceInsufficient, false);
    assert.deepEqual(missingHttp.missingItems, ["本次 Guard 检查缺少 HTTP 原始日志"]);
    console.log("guard-target-scope: PASS exact stage/unit boundaries, global rules, tables, locks/examples, selectors, locator bounds, missing/ambiguous scopes, lightweight legacy, declared Plan metadata, zero-model preflight");
} finally {
    __testSetGuardModelBridge();
    fs.rmSync(root, { recursive: true, force: true });
}
