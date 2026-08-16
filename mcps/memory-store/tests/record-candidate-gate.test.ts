import assert from "node:assert/strict";
import fs from "node:fs";
import { validateRecordCandidateForWrite } from "../src/record-generator.js";

const oldRecord = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`gate-test`",
    "- 总轮次：59",
    "- 总步骤：1000",
    "",
    "## Phase 1：旧阶段（轮次 1-28）",
    "",
    "- 旧记录内容 ".repeat(260),
    "",
    "## Phase 2：旧阶段（轮次 29-45）",
    "",
    "- 更多旧记录内容 ".repeat(260),
    "",
    "# 产出文件总清单",
    "",
    "<!-- TAGS: old, gate -->",
].join("\n");

const zeroPhaseCandidate = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`gate-test`",
    "- 总轮次：59",
    "- 总步骤：1000",
    "",
    "本次更新总结了很多内容，但模型没有输出任何 Phase。",
    "",
    "<!-- TAGS: bad -->",
].join("\n");

const rejected = validateRecordCandidateForWrite(zeroPhaseCandidate, "gate-test", 59, 59, { oldRecord });
assert.equal(rejected.ok, false, "0 Phase candidate must be rejected before write");
if (!rejected.ok) {
    assert.match(rejected.error, /未识别到任何 Phase/u);
    assert.equal(fs.existsSync(rejected.candidatePath), true, "rejected candidate should be saved for review");
}

const validCandidate = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`gate-test`",
    "- 总轮次：59",
    "- 总步骤：1000",
    "",
    "## Phase 1：旧阶段（轮次 1-28）",
    "",
    "- 旧记录内容 ".repeat(260),
    "",
    "## Phase 2：旧阶段（轮次 29-45）",
    "",
    "- 更多旧记录内容 ".repeat(260),
    "",
    "## Phase 3：新增阶段（轮次 46-59）",
    "",
    "- 新增记录内容 ".repeat(260),
    "",
    "# 产出文件总清单",
    "",
    "<!-- TAGS: ok, gate -->",
].join("\n");

const accepted = validateRecordCandidateForWrite(validCandidate, "gate-test", 59, 59, { oldRecord });
assert.equal(accepted.ok, true, "valid phased candidate should pass");

const tailWindowOldRecord = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`tail-window`",
    "- 总轮次：15",
    "- 总步骤：150",
    "",
    "## Phase 1：旧阶段（轮次 1-9）",
    "",
    "- 旧记录内容 ".repeat(80),
    "",
    "# 产出文件总清单",
    "",
    "<!-- TAGS: tail-window -->",
].join("\n");

const tailWindowCandidate = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`tail-window`",
    "- 总轮次：15",
    "- 总步骤：150",
    "",
    "## Phase 1：旧阶段（轮次 1-9）",
    "",
    "- 旧记录内容 ".repeat(80),
    "",
    "## Phase 2：尾部增量（轮次 10-15）",
    "",
    "- 新增记录内容 ".repeat(80),
    "",
    "# 产出文件总清单",
    "",
    "# 经验教训",
    "",
    "<!-- TAGS: tail-window, ok -->",
].join("\n");

const tailWindowWrongTotal = validateRecordCandidateForWrite(tailWindowCandidate, "tail-window", 6, 15, { oldRecord: tailWindowOldRecord });
assert.equal(tailWindowWrongTotal.ok, false, "tail-only materialized round count must not be used as the conversation total");
if (!tailWindowWrongTotal.ok) {
    assert.match(tailWindowWrongTotal.error, /只明确覆盖到第 6 轮，目标至少第 15 轮/u);
}
const tailWindowAccepted = validateRecordCandidateForWrite(tailWindowCandidate, "tail-window", 15, 15, { oldRecord: tailWindowOldRecord });
assert.equal(tailWindowAccepted.ok, true, "tail-only scheduler updates must validate against the real source total rounds");

const overlapCandidate = validCandidate.replace("## Phase 3：新增阶段（轮次 46-59）", "## Phase 3：新增阶段（轮次 44-59）");
const overlapRejected = validateRecordCandidateForWrite(overlapCandidate, "gate-test", 59, 59, { oldRecord, strictShrinkCheck: false });
assert.equal(overlapRejected.ok, false, "overlapping phase ranges should be rejected");

const legacyOverlappedRecord = [
    "# 对话记录 Record",
    "",
    "- 对话ID：`legacy-overlap`",
    "- 总轮次：140",
    "- 总步骤：1000",
    "",
    "## Phase 1：旧阶段（轮次 1-30）",
    "",
    "- 旧记录内容 ".repeat(120),
    "",
    "## Phase 2：历史范围错误但已存在（轮次 20-80）",
    "",
    "- 历史重叠内容 ".repeat(120),
    "",
    "# 产出文件总清单",
    "",
    "<!-- TAGS: legacy -->",
].join("\n");

const inheritedLegacyOverlap = [
    legacyOverlappedRecord.replace("<!-- TAGS: legacy -->", ""),
    "## Phase 3：新增阶段（轮次 81-140）",
    "",
    "- 新增记录内容 ".repeat(120),
    "",
    "# 经验教训",
    "",
    "<!-- TAGS: legacy, ok -->",
].join("\n");

const inheritedAccepted = validateRecordCandidateForWrite(inheritedLegacyOverlap, "legacy-overlap", 140, 140, {
    oldRecord: legacyOverlappedRecord,
    strictShrinkCheck: false,
});
assert.equal(inheritedAccepted.ok, true, "legacy overlap already present in old Record should not block new append");
if (inheritedAccepted.ok) {
    assert.ok(inheritedAccepted.warnings.some(warning => warning.includes("继承旧 Record 已存在")), "legacy overlap should be surfaced as warning");
}

const newOverlapCandidate = inheritedLegacyOverlap.replace("## Phase 3：新增阶段（轮次 81-140）", "## Phase 3：新增阶段（轮次 79-140）");
const newOverlapRejected = validateRecordCandidateForWrite(newOverlapCandidate, "legacy-overlap", 140, 140, {
    oldRecord: legacyOverlappedRecord,
    strictShrinkCheck: false,
});
assert.equal(newOverlapRejected.ok, false, "new overlap not present in old Record must still be rejected");

console.log("record-candidate-gate tests passed");
