import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildGuardInputBundle,
    isGuardEvidenceInsufficient,
    materializeLocatorSuggestions,
    parseLocatorSuggestions,
    truncateGuardTextForTest,
    type GuardCheckResult,
} from "../src/guard-engine.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-evidence-"));

const emojiBoundaryText = `${"A".repeat(20)}😀${"B".repeat(200)}`;
const emojiBoundaryTruncated = truncateGuardTextForTest(emojiBoundaryText, 101);
const emojiBoundaryPreview = emojiBoundaryTruncated.split("\n\n...[truncated", 1)[0];
assert.equal(emojiBoundaryPreview, "A".repeat(20), "Guard truncation must not retain a lone high UTF-16 surrogate");
assert.doesNotMatch(emojiBoundaryPreview, /[\uD800-\uDFFF]/u, "Guard truncation preview must remain valid Unicode");

function writeFixture(name: string, content: string): string {
    const filePath = path.join(tmp, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

const oldFiller = Array.from({ length: 5200 }, (_, index) => `OLD-FILLER-${index}: unrelated historical Stage content`).join("\n");

const taskPath = writeFixture("Task.md", [
    "# Task",
    "",
    "## 工作原则",
    "Guard check 必须先看真实执行证据，不能只看 Task 自述。",
    "",
    "### U100 历史任务",
    oldFiller,
    "",
    "### U102 任务栏结构化目标与使用者体验指标（2026-05-14）",
    "",
    "目标：同名但不同位置/功能的图标必须拆成独立结构化目标。",
    "",
    "执行证据：",
    "- `mcp-server/src/observe.ts` 写入 `surfaceIdentity`。",
    "- `mcp-server/src/shortChain.ts` 保留 selectedCandidate 身份。",
    "- 测试命令 `npm run build`、`npm run test:stage54-observe-targets` 均通过。",
    "- 报告：`tests/reports/stage54-u102-taskbar-structured-targets-usability-report.md`。",
    "- 真实 run `run_43923a12-fc11-4396-bed5-2699d7c0b261`，observation `obs_ebaf29fc-df14-4993-bd7b-c09d9a1419c5`。",
    "",
    "边界：不完成 ChatGPT + QQ 单一真实 E2E。",
    "",
    "## 待复核/小本本追加：U102 Guard 证据可见性冲突（2026-05-14）",
    "",
    "- [ ] Stage54-U102 Guard 证据可见性冲突：代码、报告、真实只读验证和测试命令已经落盘，但旧 Guard 没看到。",
    "",
    "### U103 后续任务",
    "U103 tail handoff should be visible in tail segment.",
    "",
    "### U104 后续任务",
    "tail context",
    "",
    "### U105 最新尾部",
    "latest tail closure",
].join("\n"));

const longPlanFiller = Array.from({ length: 1900 }, (_, index) => `PLAN-FILLER-${index}: old acceptance material`).join("\n");
const planPath = writeFixture("Plan_6_8_Real.md", [
    "# Plan",
    "## 目标",
    "真实桌面验收必须保留安全边界和可验证证据。",
    "",
    longPlanFiller,
    "",
    "## U102 Update - Taskbar Structured Targets And Usability Metrics (2026-05-14)",
    "U102 implements the bottom-taskbar upper strategy.",
    "Report: `tests/reports/stage54-u102-taskbar-structured-targets-usability-report.md`.",
    "",
    "## U103 追加：复杂界面编号区域",
    "next stage",
].join("\n"));

const mapPath = writeFixture("Plan_6_8_Stage54_Script_Report_Map.md", [
    "# Plan 6.8 附录 - Stage54 脚本与报告映射",
    "## 总原则",
    "This short dense map may be read fully.",
    "## U102 - Taskbar Structured Targets And Usability Metrics",
    "- Report: `tests/reports/stage54-u102-taskbar-structured-targets-usability-report.md`.",
    "## U103 - Complex Interface Numbered Regions",
    "next",
].join("\n"));

const bundle = buildGuardInputBundle([planPath, mapPath], [taskPath], "Stage54-U102 taskbar structured targets and usability metrics");

assert.match(bundle.taskContent, /工作原则/u);
assert.match(bundle.taskContent, /### U102 任务栏结构化目标/u);
assert.match(bundle.taskContent, /待复核\/小本本追加：U102/u);
assert.match(bundle.taskContent, /U105 最新尾部/u);
assert.doesNotMatch(bundle.taskContent, /OLD-FILLER-3000/u);

assert.match(bundle.planContent, /真实桌面验收必须保留安全边界/u);
assert.match(bundle.planContent, /U102 Update - Taskbar Structured Targets/u);
assert.match(bundle.planContent, /Plan 6\.8 附录/u);
assert.match(bundle.planContent, /U103 - Complex Interface Numbered Regions/u);
assert.doesNotMatch(bundle.planContent, /PLAN-FILLER-1200/u);

assert.match(bundle.coverageText, /Task\.md/u);
assert.match(bundle.coverageText, /stage-section/u);
assert.match(bundle.coverageText, /guard-note/u);
assert.match(bundle.coverageText, /full-map/u);

assert.ok(bundle.evidenceManifest.commands.some(command => command.includes("npm run build")));
assert.ok(bundle.evidenceManifest.commands.some(command => command.includes("npm run test:stage54-observe-targets")));
assert.ok(bundle.evidenceManifest.reports.some(report => report.includes("stage54-u102-taskbar-structured-targets-usability-report.md")));
assert.ok(bundle.evidenceManifest.runIds.includes("run_43923a12-fc11-4396-bed5-2699d7c0b261"));
assert.ok(bundle.evidenceManifest.observationIds.includes("obs_ebaf29fc-df14-4993-bd7b-c09d9a1419c5"));
assert.equal(bundle.coverage.truncationRisk, "none");

const insufficient: GuardCheckResult = {
    passed: false,
    summary: "当前 Stage section 已定位，但强制证据区为空且 coverage 显示存在未读区间。",
    missingItems: [],
    rawResponse: "EVIDENCE_INSUFFICIENT\n当前 Stage section 已定位，但强制证据区为空且 coverage 显示存在未读区间。",
    evidenceInsufficient: true,
};

assert.equal(isGuardEvidenceInsufficient(insufficient), true);

const hugeTaskPath = writeFixture("HugeTask.md", [
    "# Huge Task",
    "## 工作原则",
    "Stage Guard must preserve evidence coverage.",
    ...Array.from({ length: 6400 }, (_, index) => `HUGE-OLD-${index}: old stage material that should not be injected`),
    "### U102 Taskbar Structured Targets And Usability Metrics",
    "目标：U102 target section should be retained fully.",
    "- command: `npm run test:stage54-observe-targets`",
    "- report: `tests/reports/stage54-u102-taskbar-structured-targets-usability-report.md`",
    "- run: `run_a43f2af9-8674-40c9-bb86-f4e4be24926f`",
    "- observation: `obs_9d62d92f-a74c-491a-b1af-c59a0e0c6b78`",
    "### U103 Next Stage",
    "next stage marker",
    ...Array.from({ length: 300 }, (_, index) => `TAIL-${index}: latest tail material`),
].join("\n"));

const hugePlanPath = writeFixture("HugePlan.md", [
    "# Huge Plan",
    "## 目标",
    "Acceptance head must be retained.",
    ...Array.from({ length: 2500 }, (_, index) => `HUGE-PLAN-OLD-${index}: old plan material`),
    "## U102 Update - Taskbar Structured Targets And Usability Metrics",
    "Plan U102 section retained.",
    "## U103 Update",
    "next",
].join("\n"));

const hugeBundle = buildGuardInputBundle([hugePlanPath, mapPath], [hugeTaskPath], "Stage54-U102 taskbar structured targets and usability metrics");

assert.match(hugeBundle.taskContent, /Huge Task/u);
assert.match(hugeBundle.taskContent, /U102 target section should be retained fully/u);
assert.match(hugeBundle.taskContent, /TAIL-299/u);
assert.doesNotMatch(hugeBundle.taskContent, /HUGE-OLD-3000/u);
assert.match(hugeBundle.planContent, /Acceptance head must be retained/u);
assert.match(hugeBundle.planContent, /Plan U102 section retained/u);
assert.doesNotMatch(hugeBundle.planContent, /HUGE-PLAN-1200/u);
assert.ok(hugeBundle.evidenceManifest.commands.some(command => command.includes("npm run test:stage54-observe-targets")));
assert.ok(hugeBundle.evidenceManifest.runIds.includes("run_a43f2af9-8674-40c9-bb86-f4e4be24926f"));
assert.ok(hugeBundle.evidenceManifest.observationIds.includes("obs_9d62d92f-a74c-491a-b1af-c59a0e0c6b78"));
assert.ok(hugeBundle.coverage.sources.some(source => source.basename === "HugeTask.md" && source.unreadRanges.length > 0));

const parsedLocator = parseLocatorSuggestions([
    "```json",
    JSON.stringify({
        suggestions: [
            { file: hugeTaskPath, startLine: 6403, endLine: 6535, reason: "U102 section and nearby evidence" },
            { file: path.join(tmp, "not-allowed.md"), startLine: 1, endLine: 5, reason: "must be ignored" },
        ],
    }),
    "```",
].join("\n"));
const materializedLocator = materializeLocatorSuggestions(parsedLocator, [hugePlanPath], [hugeTaskPath]);
assert.equal(materializedLocator.taskSegments.length, 1);
assert.equal(materializedLocator.planSegments.length, 0);
assert.match(materializedLocator.taskSegments[0], /model-locator/u);
assert.match(materializedLocator.taskSegments[0], /U102 Taskbar Structured Targets/u);
assert.doesNotMatch(materializedLocator.taskSegments[0], /TAIL-200/u);
assert.ok(materializedLocator.evidenceSources.some(source => source.includes("stage54-u102-taskbar-structured-targets-usability-report.md")));

console.log("guard-engine-evidence ok");
