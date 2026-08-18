import assert from "node:assert/strict";
import {
    buildOutline,
    buildRecordReaderIndex,
    formatReaderView,
    hashRecordSource,
    selectRecordReaderBlocks,
    selectReaderBlocks,
} from "../src/record-reader.ts";

const record = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`demo-record`",
    "- 工作区：`demo`",
    "",
    "```md",
    "## Phase 999：代码块里的假标题（轮次 999-1000）",
    "```",
    "",
    "## Phase 1：规划阶段（轮次 1-3）",
    "",
    "### 用户要求",
    "- 用户要求按结构读取 Record。",
    "",
    "### AI 执行",
    "- 新增 parser。",
    "",
    "### 产出文件",
    "- `src/record-reader.ts`",
    "",
    "### 验证",
    "- `npm run build` 通过。",
    "",
    "## Phase 2 - 收尾阶段（轮次 4至5）",
    "",
    "### 关键决策",
    "- raw Record 是唯一事实源。",
    "",
    "### 经验教训",
    "- 不要做 Record 的 Record。",
    "",
    "### 风险",
    "- 结构漂移。",
    "",
    "### 当前状态",
    "- Reader Index 初版完成。",
    "",
    "## 产出文件总清单",
    "- `README.md`",
    "",
    "## 当前状态",
    "- 等待 Guard。",
].join("\n");

const index = buildRecordReaderIndex("demo-record", record);

assert.equal(index.recordId, "demo-record");
assert.equal(index.sourceHash, hashRecordSource(record));
assert.equal(index.phases.length, 2, "code block pseudo phase should be ignored");
assert.equal(index.phases[0].roundStart, 1);
assert.equal(index.phases[0].roundEnd, 3);
assert.equal(index.phases[1].roundStart, 4);
assert.equal(index.phases[1].roundEnd, 5);

assert.ok(index.blocks.some(block => block.sectionType === "header"));
assert.ok(index.blocks.some(block => block.sectionType === "user_ops"));
assert.ok(index.blocks.some(block => block.sectionType === "ai_actions"));
assert.ok(index.blocks.some(block => block.sectionType === "outputs"));
assert.ok(index.blocks.some(block => block.sectionType === "verification"));
assert.ok(index.blocks.some(block => block.sectionType === "decisions"));
assert.ok(index.blocks.some(block => block.sectionType === "lessons"));
assert.ok(index.blocks.some(block => block.sectionType === "risks"));
assert.ok(index.blocks.some(block => block.sectionType === "status"));

assert.ok(index.aggregates.outputs.length >= 2, "phase and tail outputs should aggregate");
assert.ok(index.aggregates.status.length >= 2, "phase and tail status should aggregate");
assert.ok(index.aggregates.lessons.length >= 1);

const outline = buildOutline(index);
assert.equal(outline.phaseCount, 2);
assert.equal(outline.phases[0].id, "phase-1");

const phaseWithoutRisks = selectReaderBlocks(index, {
    view: "phase",
    phaseIds: ["phase-2"],
    exclude: ["risks"],
});
assert.ok(phaseWithoutRisks.every(block => block.phaseId === "phase-2"));
assert.ok(phaseWithoutRisks.every(block => block.sectionType !== "risks"));

const outputs = formatReaderView(index, { view: "outputs", withCitations: true });
assert.match(outputs.text, /src\/record-reader\.ts/u);
assert.match(outputs.text, /L\d+-\d+/u);
assert.equal(outputs.truncated, false);

const phaseOneOutputs = selectReaderBlocks(index, { view: "outputs", phaseIds: [1] });
assert.equal(phaseOneOutputs.length, 1);
assert.ok(phaseOneOutputs.every(block => block.phaseId === "phase-1"));
assert.match(phaseOneOutputs[0].text, /src\/record-reader\.ts/u);
assert.doesNotMatch(phaseOneOutputs[0].text, /README\.md/u);

const tiny = formatReaderView(index, { view: "phase", phaseIds: ["phase-2"], maxChars: 80 });
assert.equal(tiny.truncated, true);
assert.match(tiny.nextReadHint || "", /maxChars/u);

const realisticTailRecord = [
    "# Record：开发对话4接力",
    "",
    "- 总轮次：144",
    "- 总步骤：24933",
    "",
    "## Phase 1：早期授权修复（轮次 130-136）",
    "",
    "### 当前状态",
    "- U82 仍处在早期授权入口修复中。",
    "",
    "### 风险",
    "- 早期风险：授权窗还不够稳定。",
    "",
    "## Phase 2：真实链路修复（轮次 137-140）",
    "",
    "### 当前状态",
    "- U90 仍需压缩 observe 输出。",
    "",
    "# 产出文件总清单",
    "",
    "## 源码与配置",
    "",
    "- `computer-use-plugin/mcp-server/src/index.ts`",
    "- `computer-use-plugin/windows-helper/Program.cs`",
    "",
    "## 报告与证据文件",
    "",
    "- `computer-use-plugin/tests/reports/stage54-u100-qq-safe-route-live-retest-report.md`",
    "",
    "# 经验教训",
    "",
    "- Debug/Release helper 构建错位会造成真实弹窗仍旧。",
    "",
    "# 风险记录",
    "",
    "- 最新风险：U1 单一真实 ChatGPT + QQ E2E 尚未通过。",
    "- 最新风险：target_region 越界黑图需要明确报错。",
    "",
    "# 后续建议",
    "",
    "1. 先修 `target_region` 边界。",
].join("\n");

const realisticIndex = buildRecordReaderIndex("realistic-tail", realisticTailRecord);
assert.equal(realisticIndex.phases[0].roundStart, 130);
assert.equal(realisticIndex.phases[0].roundEnd, 136);

const realisticOutputs = formatReaderView(realisticIndex, { view: "outputs", withCitations: true });
assert.match(realisticOutputs.text, /源码与配置/u, "outputs should keep child headings under the tail parent");
assert.match(realisticOutputs.text, /mcp-server\/src\/index\.ts/u);
assert.match(realisticOutputs.text, /stage54-u100-qq-safe-route-live-retest-report\.md/u);
assert.equal(realisticOutputs.truncated, false);

const latestState = formatReaderView(realisticIndex, { view: "state", maxChars: 160, withCitations: false });
assert.match(latestState.text, /最新风险：U1 单一真实 ChatGPT \+ QQ E2E 尚未通过/u);
assert.doesNotMatch(latestState.text.slice(0, 240), /U82|早期风险/u, "state should prefer latest status/risk blocks first when budget is small");
assert.match(latestState.nextReadHint || "", /startBlockId/u);

const tooTinyOutputs = formatReaderView(realisticIndex, { view: "outputs", maxChars: 20 });
assert.equal(tooTinyOutputs.text, "");
assert.equal(tooTinyOutputs.truncated, true);
assert.equal(tooTinyOutputs.truncatedReason, "first_block_over_budget");
assert.match(tooTinyOutputs.nextReadHint || "", /startBlockId/u);
const tooTinySelected = selectRecordReaderBlocks(realisticIndex, { view: "outputs", maxChars: 20 });
assert.ok(tooTinySelected.nextReadHint?.startBlockId);

const continuedOutputs = formatReaderView(realisticIndex, {
    view: "outputs",
    startBlockId: tooTinySelected.nextReadHint!.startBlockId,
    maxChars: 1000,
    withCitations: false,
});
assert.match(continuedOutputs.text, /源码与配置/u, "startBlockId should be consumable by a follow-up structured read");

const englishRoundsRecord = [
    "# English rounds",
    "",
    "## Phase 3：U100 收口、现状盘点与新对话接力准备（Rounds 141-144）",
    "",
    "### 当前状态",
    "- latest",
].join("\n");
const englishRoundsIndex = buildRecordReaderIndex("english-rounds", englishRoundsRecord);
assert.equal(englishRoundsIndex.phases[0].roundStart, 141);
assert.equal(englishRoundsIndex.phases[0].roundEnd, 144);
