import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-parallel-test-"));
// 隔离数据根：防止 generateRecord/writeRecord("general", …) 写进真实 general 库（测试崩溃会把
// record-parallel-*/broken-coverage-*/force-rebuild-* 等泄漏到生产数据）。必须在导入 record-store 前设置。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-parallel-data-"));
const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");
const patchCountFile = path.join(tempDir, "patch-count.txt");
const compressCountFile = path.join(tempDir, "compress-count.txt");

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

function readCount(file) {
  return file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf-8")) : 0;
}

function writeCount(file, value) {
  if (file) fs.writeFileSync(file, String(value), "utf-8");
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    if (input.includes("请输出 Record 的结构化增量")) {
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          rewriteStartRound: 3,
          rewriteEndRound: 5,
          phaseMarkdown: [
            "## Phase 2：重写衔接阶段（轮次 3-5）",
            "",
            "- 保留旧最后阶段的衔接信息",
            "- 覆盖新增轮次 4-5",
            "- 产出 src/local-compose.ts"
          ].join("\\n"),
          tailMarkdown: [
            "# 产出文件总清单",
            "",
            "- src/local-compose.ts",
            "",
            "# 经验教训",
            "",
            "- 模型只输出增量，代码合成完整 Record"
          ].join("\\n"),
          tags: ["local-compose", "record"],
          warnings: []
        }),
        "\`\`\`"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }
    if (input.includes("请把多个 RecordPatch 草稿压缩为一个中间 RecordPatch")) {
      const countFile = process.env.FAKE_CODEX_COMPRESS_COUNT_FILE;
      const next = readCount(countFile) + 1;
      writeCount(countFile, next);
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound: 1,
          endRound: 3,
          title: "压缩区段",
          files: ["src/compressed.ts"],
          tags: ["compressed"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- 压缩后的区段草稿"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }
    if (input.includes("请把指定轮次区段整理为 RecordPatch 草稿")) {
      const countFile = process.env.FAKE_CODEX_PATCH_COUNT_FILE;
      const next = readCount(countFile) + 1;
      writeCount(countFile, next);
      if (next <= Number(process.env.FAKE_CODEX_SLEEP_PATCHES || "0")) {
        setInterval(() => {}, 1000);
        return;
      }
      if (next <= Number(process.env.FAKE_CODEX_EMPTY_PATCHES || "0")) {
        process.exit(0);
      }
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound: 1,
          endRound: 1,
          title: "并行区段",
          files: ["src/example.ts"],
          tags: ["parallel"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- 并行区段草稿"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }
    const writeReducerOutput = () => {
      fs.writeFileSync(outputPath, [
        "# Record: parallel test",
        "",
        "- 总轮次：3",
        "- 总步骤：9",
        "",
        "## Phase 1：并行整合（轮次 1-3）",
        "",
        "**用户操作**：测试并行 Record 管线",
        "",
        "**AI执行**：整合 RecordPatch",
        "",
        "<!-- TAGS: parallel, record -->"
      ].join("\\n"), "utf-8");
      process.exit(0);
    };
    const reducerSleepMs = Number(process.env.FAKE_CODEX_SLEEP_REDUCER_MS || "0");
    if (reducerSleepMs > 0) {
      setTimeout(writeReducerOutput, reducerSleepMs);
    } else {
      writeReducerOutput();
    }
  });
  return;
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "5000";
process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT = "2000";
process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES = "1";
process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS = "30000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = "20000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = "20";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS = "20";
process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT = "1";
process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_SIZE = "2";
process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_CHARS = "60000";
process.env.MEMORY_STORE_RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS = "1000";
process.env.FAKE_CODEX_PATCH_COUNT_FILE = patchCountFile;
process.env.FAKE_CODEX_COMPRESS_COUNT_FILE = compressCountFile;

const {
    createRecordChunks,
    composeRecordLocally,
    enforceRecordHeaderMetadata,
    formatRoundsForRecord,
    generateRecord,
    getParallelChunkBudget,
    groupPatchesForCompression,
    parseLocalComposeResponse,
    parseRecordDocument,
    parseRecordPatchResponse,
    parseSerialComposeStep,
    relabelSerialPhaseMarkdown,
    salvagePhasesFromTruncatedJson,
    selectLocalComposeBoundary,
    shouldUseParallelPipeline,
    validateComposedRecord,
    inferCoveredRoundFromRecord,
} = await import("../src/record-generator.ts");
const { deleteRecord, readRecordsIndex, writeRecord } = await import("../src/record-store.ts");

function round(index: number, bodyChars: number): ConversationRound {
    return {
        roundIndex: index,
        startStep: index * 3,
        endStep: index * 3 + 2,
        userMessage: `用户轮次 ${index}`,
        mediaAttachments: [],
        aiResponses: [{ stepIndex: index * 3 + 1, response: "A".repeat(bodyChars), thinking: "", toolCalls: [] }],
        toolCalls: Array.from({ length: 10 }, (_, i) => ({
            stepIndex: index * 3 + 2,
            name: "shell_command",
            argsSummary: `cmd-${i}`,
            resultSummary: "ok",
        })),
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

try {
    const denseRounds = [round(1, 20_000), round(2, 20_000), round(3, 20_000)];
    const formatted = formatRoundsForRecord(denseRounds);
    const chunks = createRecordChunks(formatted, 30_000, 1);
    assert.equal(chunks.length, 3, "actual-size chunking should split dense rounds by real size");
    assert.ok(chunks.every(chunk => chunk.chars <= 30_000), "chunks should stay within target when single rounds fit");
    assert.equal(shouldUseParallelPipeline("off", chunks), false);
    assert.equal(shouldUseParallelPipeline("auto", chunks), true);
    assert.equal(shouldUseParallelPipeline("auto", [chunks[0]], { existingRecordChars: 100 }), false);
    assert.equal(shouldUseParallelPipeline("auto", [chunks[0]], { existingRecordChars: 2_000 }), true);
    assert.equal(getParallelChunkBudget(formatted, 500_000), 20_000, "dense tool conversations should use the tighter RecordPatch chunk budget");

    const patch = parseRecordPatchResponse([
        "```json",
        JSON.stringify({ startRound: 2, endRound: 3, title: "测试", files: ["a.ts"], tags: ["x"], risks: ["r"], status: "ok" }),
        "```",
        "## Phase Draft",
        "正文"
    ].join("\n"), 1, 1);
    assert.equal(patch.startRound, 2);
    assert.equal(patch.endRound, 3);
    assert.deepEqual(patch.files, ["a.ts"]);
    assert.match(patch.markdown, /Phase Draft/u);

    const normalizedHeader = enforceRecordHeaderMetadata([
        "# 对话记录 Record",
        "",
        "- 对话ID：`wrong-id`",
        "- 工作区：`auto`",
        "- 关联工作区：`C:\\Users\\Stardust\\Desktop\\插件\\computer-use-plugin`",
        "- 总轮次：1",
        "- 总步骤：1",
        "",
        "## Phase 1：测试（轮次 1-2）",
        "",
        "- 正文",
        "",
        "<!-- TAGS: old -->",
    ].join("\n"), {
        conversationId: "fixed-id",
        workspace: "C:\\Users\\Stardust\\.gemini\\antigravity",
        totalRounds: 2,
        totalSteps: 20,
    });
    assert.match(normalizedHeader, /- 对话ID：`fixed-id`/u);
    assert.match(normalizedHeader, /- 工作区：`C:\\Users\\Stardust\\.gemini\\antigravity`/u);
    assert.match(normalizedHeader, /- 关联工作区：`C:\\Users\\Stardust\\Desktop\\插件\\computer-use-plugin`/u);
    assert.match(normalizedHeader, /- 总轮次：2/u);
    assert.match(normalizedHeader, /- 总步骤：20/u);

    const parsedUnnumberedPhase = parseRecordDocument([
        "# 对话记录 Record",
        "",
        "- 对话ID：`unnumbered`",
        "",
        "## Phase: 无编号阶段（轮次 1-2）",
        "",
        "- 正文",
    ].join("\n"));
    assert.equal(parsedUnnumberedPhase.phases.length, 1, "local compose should parse legacy unnumbered Phase headings");
    assert.equal(parsedUnnumberedPhase.phases[0].number, 1);
    assert.equal(parsedUnnumberedPhase.phases[0].endRound, 2);

    const parsedRangeLabelPhases = parseRecordDocument([
        "# 对话记录 Record",
        "",
        "- 对话ID：`range-label`",
        "- 总轮次：50",
        "",
        "## Phase 1-36：旧压缩阶段 A",
        "",
        "- 轮次范围：1-10",
        "",
        "## Phase 37-61：旧压缩阶段 B",
        "",
        "- 轮次范围：11-20",
        "",
        "## Phase 62-66：旧压缩阶段 C",
        "",
        "- 轮次范围：21-30",
        "",
        "## Phase 67-70：旧压缩阶段 D",
        "",
        "- 轮次范围：31-40",
        "",
        "## Phase 5(41-50)：新阶段",
        "",
        "- 轮次范围：41-50",
        "",
        "# 经验教训",
        "",
        "- range label should not become phase ordinal",
        "",
        "<!-- TAGS: range-label -->",
    ].join("\n"));
    assert.deepEqual(parsedRangeLabelPhases.phases.map(phase => phase.number), [1, 2, 3, 4, 5]);
    const rangeLabelValidation = validateComposedRecord(
        parsedRangeLabelPhases.header + "\n\n" + parsedRangeLabelPhases.phases.map(phase => phase.content).join("\n\n") + "\n\n" + parsedRangeLabelPhases.tail + "\n\n<!-- TAGS: range-label -->",
        "",
        parsedRangeLabelPhases,
        { stablePhases: [], rollbackPhases: [], stableEndRound: 0, rewriteStartRound: 1, rollbackCount: 0, reason: "test" },
        50,
    );
    assert.equal(rangeLabelValidation.ok, true, rangeLabelValidation.errors.join("; "));

    const rangeLabelDelta = parseLocalComposeResponse([
        "```json",
        JSON.stringify({
            rewriteStartRound: 11,
            rewriteEndRound: 20,
            phaseMarkdown: "## Phase 37-61：模型误吐旧范围标签\n\n- 轮次范围：11-20",
            tailMarkdown: "# 经验教训\n\n- range label renumber",
            tags: ["range-label"],
            warnings: [],
        }),
        "```",
    ].join("\n"), 11, 20);
    assert.match(rangeLabelDelta.phaseMarkdown, /## Phase 37-61/u);
    const rangeRenumbered = composeRecordLocally(parsedRangeLabelPhases, {
        stablePhases: parsedRangeLabelPhases.phases.slice(0, 1),
        rollbackPhases: parsedRangeLabelPhases.phases.slice(1),
        stableEndRound: 10,
        rewriteStartRound: 11,
        rollbackCount: 4,
        reason: "test",
    }, rangeLabelDelta, {
        conversationId: "range-label",
        workspace: "test",
        totalRounds: 20,
        totalSteps: 200,
    });
    assert.match(rangeRenumbered, /## Phase 2：模型误吐旧范围标签/u);
    assert.doesNotMatch(rangeRenumbered, /## Phase 2-61/u);

    const oldRecord222 = [
        "# 对话记录 Record",
        "",
        "- 对话ID：`demo-222`",
        "- 工作区：`test`",
        "- 总轮次：23",
        "- 总步骤：1000",
        "",
        "## Phase 1：稳定阶段一（轮次 1-8）",
        "",
        "- 稳定内容 A",
        "",
        "## Phase 2：稳定阶段二（轮次 9-17）",
        "",
        "- 稳定内容 B",
        "",
        "## Phase 3：开放阶段（轮次 18-23）",
        "",
        "- 仍在进行中，下一步继续验证",
        "",
        "# 产出文件总清单",
        "",
        "- `old.ts`",
        "",
        "<!-- TAGS: old, record -->",
    ].join("\n");
    const parsed222 = parseRecordDocument(oldRecord222);
    const boundary222 = selectLocalComposeBoundary(parsed222, 23, 222);
    assert.equal(boundary222.stableEndRound, 17);
    assert.equal(boundary222.rewriteStartRound, 18);
    assert.equal(boundary222.rollbackCount, 1);
    const delta222 = parseLocalComposeResponse([
        "```json",
        JSON.stringify({
            rewriteStartRound: 18,
            rewriteEndRound: 222,
            phaseMarkdown: "## Phase 3：重写后的长阶段（轮次 18-222）\n\n- 覆盖 18-222",
            tailMarkdown: "# 产出文件总清单\n\n- `new.ts`\n\n# 经验教训\n\n- 本地合成",
            tags: ["new", "record"],
            warnings: [],
        }),
        "```",
    ].join("\n"), 18, 222);
    const composed222 = composeRecordLocally(parsed222, boundary222, delta222, {
        conversationId: "demo-222",
        workspace: "test",
        totalRounds: 222,
        totalSteps: 9999,
    });
    assert.match(composed222, /稳定内容 A/u);
    assert.match(composed222, /稳定内容 B/u);
    assert.doesNotMatch(composed222, /仍在进行中/u);
    assert.match(composed222, /轮次 18-222/u);
    assert.equal(validateComposedRecord(composed222, oldRecord222, parsed222, boundary222, 222).ok, true);

    const jsonishDelta = parseLocalComposeResponse([
        "```json",
        "{",
        '  "rewriteStartRound": 50,',
        '  "rewriteEndRound": 66,',
        '  "phaseMarkdown": "## Phase 14：Grok 收尾（轮次 50-66）\\n\\n- 覆盖 50-66\\n- 模型输出未闭合 JSON，但核心 phaseMarkdown 应被抢救"',
        "",
        "# 产出文件总清单",
        "",
        "- `README.md`",
    ].join("\n"), 50, 66);
    assert.equal(jsonishDelta.rewriteStartRound, 50);
    assert.equal(jsonishDelta.rewriteEndRound, 66);
    assert.match(jsonishDelta.phaseMarkdown, /Grok 收尾/u);
    assert.match(jsonishDelta.phaseMarkdown, /覆盖 50-66/u);
    assert.doesNotMatch(jsonishDelta.phaseMarkdown, /```json/u);
    assert.match(jsonishDelta.tailMarkdown, /README\.md/u);

    const stalePhaseDelta = parseLocalComposeResponse([
        "```json",
        JSON.stringify({
            rewriteStartRound: 126,
            rewriteEndRound: 129,
            phaseMarkdown: [
                "## Phase 8：旧稳定区（轮次 48-59）",
                "",
                "- 这段不应被重复拼入候选",
                "",
                "## Phase 9：仍是旧稳定区",
                "",
                "- **轮次范围**：60-125",
                "- 这段也应过滤",
                "",
                "## Phase 10：新增修复（轮次 126-129）",
                "",
                "- 只保留真正增量",
            ].join("\n"),
        }),
        "```",
    ].join("\n"), 126, 129);
    assert.doesNotMatch(stalePhaseDelta.phaseMarkdown, /这段不应被重复/u);
    assert.doesNotMatch(stalePhaseDelta.phaseMarkdown, /这段也应过滤/u);
    assert.match(stalePhaseDelta.phaseMarkdown, /新增修复/u);

    const manualOldRecord = [
        "# 对话记录 Record",
        "",
        "- 对话ID：`manual`",
        "- 工作区：`test`",
        "- 总轮次：6",
        "- 总步骤：60",
        "",
        "## Phase 1：稳定手动阶段（轮次 1-3）",
        "",
        "- [手动补充] 这条必须保留",
        "",
        "## Phase 2：开放阶段（轮次 4-6）",
        "",
        "- 下一步继续验证",
        "",
        "# 经验教训",
        "",
        "- 旧尾部",
        "",
        "<!-- TAGS: manual -->",
    ].join("\n");
    const parsedManual = parseRecordDocument(manualOldRecord);
    const boundaryManual = selectLocalComposeBoundary(parsedManual, 6, 8);
    const missingStableCandidate = [
        "# 对话记录 Record",
        "",
        "- 总轮次：8",
        "",
        "## Phase 1：缺失阶段（轮次 4-8）",
        "",
        "- 只写了新增内容",
        "",
        "# 经验教训",
        "",
        "- 新尾部",
        "",
        "<!-- TAGS: manual -->",
    ].join("\n");
    const missingStableValidation = validateComposedRecord(missingStableCandidate, manualOldRecord, parsedManual, boundaryManual, 8);
    assert.equal(missingStableValidation.ok, false);
    assert.ok(missingStableValidation.errors.some(error => /稳定区/u.test(error)));
    assert.ok(missingStableValidation.errors.some(error => /手动补充/u.test(error)));

    const renumberedManualOldRecord = [
        "# 对话记录 Record",
        "",
        "- 总轮次：10",
        "- 总步骤：100",
        "",
        "## Phase 1：稳定阶段（轮次 1-7）",
        "",
        "- 稳定正文",
        "",
        "# 必须保留的手动补充",
        "",
        "9. 3. 测试扩展集中在 `tests/record-generator-parallel.test.ts`：覆盖旧 Record 并保留 `[手动补充]`",
        "",
        "<!-- TAGS: manual -->",
    ].join("\n");
    const renumberedManualCandidate = [
        "# 对话记录 Record",
        "",
        "- 总轮次：11",
        "- 总步骤：110",
        "",
        "## Phase 1：稳定阶段（轮次 1-7）",
        "",
        "- 稳定正文",
        "",
        "## Phase 2：新增阶段（轮次 8-11）",
        "",
        "- 新增正文",
        "",
        "# 必须保留的手动补充",
        "",
        "1. 测试扩展集中在 `tests/record-generator-parallel.test.ts`：覆盖旧 Record 并保留 `[手动补充]`",
        "",
        "<!-- TAGS: manual -->",
    ].join("\n");
    const parsedRenumberedManual = parseRecordDocument(renumberedManualOldRecord);
    const boundaryRenumberedManual = selectLocalComposeBoundary(parsedRenumberedManual, 10, 11);
    const renumberedManualValidation = validateComposedRecord(
        renumberedManualCandidate,
        renumberedManualOldRecord,
        parsedRenumberedManual,
        boundaryRenumberedManual,
        11,
    );
    assert.equal(renumberedManualValidation.ok, true);

    const largeOldRecord = [
        "# 对话记录 Record",
        "",
        "- 总轮次：17",
        "- 总步骤：170",
        "",
        "## Phase 1：稳定阶段（轮次 1-8）",
        "",
        "- 稳定正文",
        "",
        "## Phase 2：超长旧阶段（轮次 9-17）",
        "",
        "- " + "旧阶段细节".repeat(6000),
        "",
        "# 经验教训",
        "",
        "- 旧尾部",
        "",
        "<!-- TAGS: large -->",
    ].join("\n");
    const parsedLarge = parseRecordDocument(largeOldRecord);
    const boundaryLarge = selectLocalComposeBoundary(parsedLarge, 17, 30);
    const smallDelta = parseLocalComposeResponse([
        "```json",
        JSON.stringify({
            rewriteStartRound: 9,
            rewriteEndRound: 30,
            phaseMarkdown: "## Phase 2：缩水阶段（轮次 9-30）\n\n- 只剩很短概述",
            tailMarkdown: "# 经验教训\n\n- 太短",
            tags: ["large"],
            warnings: [],
        }),
        "```",
    ].join("\n"), 9, 30);
    const smallCandidate = composeRecordLocally(parsedLarge, boundaryLarge, smallDelta, {
        conversationId: "large",
        workspace: "test",
        totalRounds: 30,
        totalSteps: 300,
    });
    const shrinkValidation = validateComposedRecord(smallCandidate, largeOldRecord, parsedLarge, boundaryLarge, 30);
    assert.equal(shrinkValidation.ok, false);
    assert.ok(shrinkValidation.errors.some(error => /过度压缩/u.test(error)));

    const gapCandidate = [
        "# 对话记录 Record",
        "",
        "- 总轮次：12",
        "",
        "## Phase 1：第一段（轮次 1-4）",
        "",
        "- A",
        "",
        "## Phase 3：跳号段（轮次 8-12）",
        "",
        "- B",
        "",
        "# 经验教训",
        "",
        "- gap",
        "",
        "<!-- TAGS: gap -->",
    ].join("\n");
    const gapValidation = validateComposedRecord(gapCandidate, "", parseRecordDocument(gapCandidate), { stablePhases: [], rollbackPhases: [], stableEndRound: 0, rewriteStartRound: 1, rollbackCount: 0, reason: "test" }, 12);
    assert.equal(gapValidation.ok, false);
    assert.ok(gapValidation.errors.some(error => /编号不连续|轮次不连续/u.test(error)));

    const labeledRangeCandidate = [
        "# Record：range label",
        "",
        "- **对话ID**：`old-id`",
        "- **工作区**：`old-workspace`",
        "- **总轮次**：24",
        "- **总步骤**：240",
        "",
        "## Phase 1：前段",
        "",
        "- **轮次范围**：1-28",
        "- 用户在轮次 28 纠正了窗口归属。",
        "",
        "## Phase 2：后段",
        "",
        "- **轮次范围**：29-59",
        "- 后续事实覆盖到目标轮次。",
        "",
        "# 经验教训",
        "",
        "- label range should count",
        "",
        "<!-- TAGS: range -->",
    ].join("\n");
    const parsedLabeledRange = parseRecordDocument(labeledRangeCandidate);
    assert.deepEqual(
        parsedLabeledRange.phases.map(phase => [phase.startRound, phase.endRound]),
        [[1, 28], [29, 59]],
    );
    assert.equal(inferCoveredRoundFromRecord(labeledRangeCandidate, 59), 59);
    const normalizedLabeledHeader = enforceRecordHeaderMetadata(labeledRangeCandidate, {
        conversationId: "new-id",
        workspace: "new-workspace",
        totalRounds: 59,
        totalSteps: 590,
    });
    assert.equal((normalizedLabeledHeader.match(/总轮次/gu) || []).length, 1);
    assert.match(normalizedLabeledHeader, /- 总轮次：59/u);
    assert.doesNotMatch(normalizedLabeledHeader, /\*\*总轮次\*\*：24/u);

    const headingRangeWinsCandidate = [
        "# Record：heading range wins",
        "",
        "- 总轮次：129",
        "",
        "## Phase 10：v1.12.7 修复（轮次 126-127）",
        "",
        "正文里会提到旧失败候选的 `- **轮次范围**：48-59`，但不能覆盖标题范围。",
        "",
        "# 经验教训",
        "",
        "- heading wins",
        "",
        "<!-- TAGS: range -->",
    ].join("\n");
    const parsedHeadingRangeWins = parseRecordDocument(headingRangeWinsCandidate);
    assert.equal(parsedHeadingRangeWins.phases[0].startRound, 126);
    assert.equal(parsedHeadingRangeWins.phases[0].endRound, 127);

    fs.rmSync(patchCountFile, { force: true });
    fs.rmSync(compressCountFile, { force: true });
    // reduce 逃生口（显式关闭 local-compose）：从零生成此时仍走 reduce 整篇整合，
    // 验证 patch 重试 + 压缩递归 + reduce 心跳等机制（默认从零已改走结构化本地合成，见下方新用例）。
    process.env.MEMORY_STORE_RECORD_LOCAL_COMPOSE = "0";
    process.env.FAKE_CODEX_EMPTY_PATCHES = "2";
    process.env.FAKE_CODEX_SLEEP_REDUCER_MS = "80";
    const progressEvents: Array<{ stage?: string; detail?: string }> = [];
    const result = await generateRecord("general", `record-parallel-${Date.now()}`, "test", denseRounds, 9, "codex", {
        background: true,
        parallelMode: "force",
        onProgress: progress => progressEvents.push(progress),
    });
    assert.equal(result.success, true);
    assert.equal(result.pipeline, "parallel");
    assert.match(result.content || "", /parallel test/u);
    assert.equal(Number(fs.readFileSync(patchCountFile, "utf-8")), 5, "first chunk should use internal retry plus one chunk retry, remaining chunks should run once");
    assert.equal(Number(fs.readFileSync(compressCountFile, "utf-8")), 3, "multiple patches should be recursively compressed before final reduce when direct limit is exceeded");
    assert.ok(
        progressEvents.some(progress => progress.stage === "整合 RecordPatch" && /已用 \d+s/u.test(progress.detail || "")),
        "reducer should emit heartbeat progress while the model call is still running",
    );

    // 默认从零生成（local-compose 启用）：不再掉 reduce 老路，改走结构化本地合成，
    // 产出代码兜底的 Phase 骨架（编号重排 + 轮次标签可读），根治 ## Phase 1-63 这类漂移被覆盖门禁误杀。
    process.env.MEMORY_STORE_RECORD_LOCAL_COMPOSE = "1";
    fs.rmSync(patchCountFile, { force: true });
    fs.rmSync(compressCountFile, { force: true });
    process.env.FAKE_CODEX_EMPTY_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_REDUCER_MS = "0";
    const fromScratchStructuredId = `record-parallel-from-scratch-${Date.now()}`;
    const fromScratchStructured = await generateRecord("general", fromScratchStructuredId, "test", denseRounds, 9, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(fromScratchStructured.success, true);
    assert.equal(fromScratchStructured.pipeline, "parallel");
    assert.doesNotMatch(fromScratchStructured.content || "", /# Record: parallel test/u, "从零生成默认不再走 reduce 老路");
    assert.match(fromScratchStructured.content || "", /## Phase 1：/u, "从零本地合成应产出代码重排后的 Phase 骨架");
    assert.equal(inferCoveredRoundFromRecord(fromScratchStructured.content || "", 3), 3, "结构化产物应能被覆盖判定正确读出轮次（不再误判第 0 轮）");
    await deleteRecord("general", fromScratchStructuredId);

    // 单元级：renumberPhaseMarkdown 把「Phase 编号位的轮次范围」(## Phase 1-63：) 转成标准「（轮次 X-Y）」，
    // 即使模型把范围写进编号位也能被覆盖判定读出——直击 ac6aa8cd 那类被误杀的具体格式。
    const rangeInHeadingRecord = composeRecordLocally(
        parseRecordDocument(""),
        { stablePhases: [], rollbackPhases: [], stableEndRound: 0, rewriteStartRound: 1, rollbackCount: 0, reason: "test" },
        { rewriteStartRound: 1, rewriteEndRound: 63, phaseMarkdown: "## Phase 1-63：从零阶段\n\n- 内容", tailMarkdown: "# 经验教训\n\n- x", tags: ["t"], warnings: [] },
        { conversationId: "range-heading", workspace: "test", totalRounds: 63, totalSteps: 100 },
    );
    assert.match(rangeInHeadingRecord, /## Phase 1：从零阶段（轮次 1-63）/u, "编号位范围应转为标准轮次标签");
    assert.equal(inferCoveredRoundFromRecord(rangeInHeadingRecord, 63), 63, "转换后覆盖判定应读出第 63 轮");

    // M1 加固：relabelSerialPhaseMarkdown（失败修复兜底）遇到「编号位多段范围」时应从编号位读出真实跨度，
    // 而非把 span 当 0 压成 1 轮——否则兜底会反手抹掉模型给出的正确边界。
    const relabelHeadingRange = relabelSerialPhaseMarkdown(
        "## Phase 1-30：第一阶段\n\n- a\n\n## Phase 31-63：第二阶段\n\n- b",
        1,
        63,
    );
    assert.match(relabelHeadingRange, /（轮次 1-30）/u, "relabel 应从编号位读出第一段真实跨度 1-30");
    assert.match(relabelHeadingRange, /（轮次 31-63）/u, "relabel 应从编号位读出第二段真实跨度 31-63");

    // 健壮性①：groupPatchesForCompression 轮次上限切窗——patch 粗（一个覆盖几十轮）时，仅靠数量/字数限不住单窗
    // 轮数，maxRounds 应按轮次切窗，防超大窗模型输出超 token 上限被截断（d554f2b4 的 1-118 轮巨窗根因）。
    const coarsePatches = [
        { startRound: 1, endRound: 40, title: "a", markdown: "x", files: [], tags: [], risks: [], status: "ok" },
        { startRound: 41, endRound: 80, title: "b", markdown: "x", files: [], tags: [], risks: [], status: "ok" },
        { startRound: 81, endRound: 120, title: "c", markdown: "x", files: [], tags: [], risks: [], status: "ok" },
    ] as any;
    assert.equal(groupPatchesForCompression(coarsePatches, 3, 12000).length, 1, "无轮次上限时 3 个粗 patch 挤进 1 个 120 轮巨窗（旧行为=截断根因）");
    assert.equal(groupPatchesForCompression(coarsePatches, 3, 12000, 45).length, 3, "轮次上限 45 应把 3 个 40 轮 patch 切成 3 个窗，每窗输出可控");

    // 健壮性②：parseSerialComposeStep 容忍截断——模型输出超 token 上限被砍成残缺 JSON 时，整体 JSON.parse 失败，
    // 但应抢救出前面已完整闭合的 Phase，而不是返回 0 phases（d554f2b4 实测形态：JSON 断在某个 Phase 中途）。
    const truncatedStep = '```json\n{\n  "phases": [\n    {"title":"A","startRound":1,"endRound":7,"open":false,"markdown":"## Phase ?：A（轮次 1-7）\\n\\n- x"},\n    {"title":"B","startRound":8,"endRound":15,"open":false,"markdown":"## Phase ?：B（轮次 8-15）\\n\\n- y"},\n    {"title":"C","startRound":16,"endRound":2';
    const salvagedStep = parseSerialComposeStep(truncatedStep);
    assert.equal(salvagedStep.phases.length, 2, "截断 JSON 应抢救出 2 个完整 Phase（第 3 个截断在中途丢弃）");
    assert.equal(salvagedStep.phases[0].endRound, 7);
    assert.equal(salvagedStep.phases[1].endRound, 15);
    assert.ok(salvagedStep.warnings.some((w: string) => /截断/u.test(w)), "抢救时应给出截断告警");
    assert.equal(salvagePhasesFromTruncatedJson(truncatedStep).length, 2, "salvage 直接调用也应得 2 个完整对象");
    // 完整 JSON 仍走正常路径、不误报截断
    const fullStep = parseSerialComposeStep('```json\n{"phases":[{"title":"A","startRound":1,"endRound":5,"open":false,"markdown":"## Phase ?：A（轮次 1-5）"}],"warnings":[]}\n```');
    assert.equal(fullStep.phases.length, 1);
    assert.ok(!fullStep.warnings.some((w: string) => /截断/u.test(w)), "完整 JSON 不应误报截断");

    // A3：截断占位注释（措辞避开触发词）不得干扰覆盖判定/Phase 解析
    const recWithGapNote = "# Record：x\n\n- 总轮次：50\n\n## Phase 1：阶段（轮次 1-50）\n\n- 内容\n\n<!-- 截断缺口：本 Phase 第 30-50 段内容因模型输出截断未完整保留（低保真兜底），建议重跑补全 -->\n";
    assert.equal(inferCoveredRoundFromRecord(recWithGapNote, 50), 50, "A3 截断占位注释不应干扰覆盖判定（应读出 50 而非被注释里的数字带偏）");
    assert.equal(parseRecordDocument(recWithGapNote).phases.length, 1, "A3 截断占位注释不应被误解析为额外 Phase");

    fs.rmSync(patchCountFile, { force: true });
    fs.rmSync(compressCountFile, { force: true });
    process.env.FAKE_CODEX_EMPTY_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_REDUCER_MS = "0";
    const checkpointConversationId = `record-parallel-checkpoint-${Date.now()}`;
    const checkpointFirst = await generateRecord("general", checkpointConversationId, "test", denseRounds, 9, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(checkpointFirst.success, true);
    const patchCountAfterFirst = Number(fs.readFileSync(patchCountFile, "utf-8"));
    const compressCountAfterFirst = Number(fs.readFileSync(compressCountFile, "utf-8"));
    const checkpointSecond = await generateRecord("general", checkpointConversationId, "test", denseRounds, 9, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(checkpointSecond.success, true);
    assert.equal(Number(fs.readFileSync(patchCountFile, "utf-8")), patchCountAfterFirst, "second run should reuse cached map patches");
    assert.equal(Number(fs.readFileSync(compressCountFile, "utf-8")), compressCountAfterFirst, "second run should reuse cached compressed patches");

    const upToDateConversationId = `record-parallel-up-to-date-${Date.now()}`;
    await writeRecord("general", upToDateConversationId, [
        "# Record: existing",
        "",
        "- 总轮次：2",
        "- 总步骤：6",
        "",
        "## Phase 1：既有记录（轮次 1-2）",
        "",
        "<!-- TAGS: existing -->",
    ].join("\n"), {
        title: "existing",
        totalRounds: 2,
        totalSteps: 6,
        lastUpdatedRound: 2,
        phases: 1,
        tags: ["existing"],
    });
    const upToDateResult = await generateRecord("general", upToDateConversationId, "test", [round(1, 100), round(2, 100)], 6, "codex");
    assert.equal(upToDateResult.success, true);
    assert.equal(upToDateResult.upToDate, true);
    assert.equal(upToDateResult.batches, 0);
    assert.match(upToDateResult.content || "", /Record: existing/u);
    await deleteRecord("general", upToDateConversationId);

    const brokenCoverageConversationId = `record-broken-coverage-${Date.now()}`;
    await writeRecord("general", brokenCoverageConversationId, [
        "# 对话记录 Record",
        "",
        "- 对话ID：`broken-coverage`",
        "- 工作区：`test`",
        "- 总轮次：5",
        "- 总步骤：15",
        "",
        "## Phase 1：只覆盖前三轮（轮次 1-3）",
        "",
        "- 旧 Record 正文只写到了第三轮",
        "",
        "<!-- TAGS: broken -->",
    ].join("\n"), {
        title: "broken-coverage",
        totalRounds: 5,
        totalSteps: 15,
        lastUpdatedRound: 5,
        phases: 1,
        tags: ["broken"],
    });
    fs.rmSync(patchCountFile, { force: true });
    process.env.FAKE_CODEX_EMPTY_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_PATCHES = "0";
    const brokenCoverageResult = await generateRecord("general", brokenCoverageConversationId, "test", [
        round(1, 100),
        round(2, 100),
        round(3, 100),
        round(4, 20_000),
        round(5, 20_000),
    ], 15, "codex", {
        background: true,
        parallelMode: "auto",
    });
    assert.equal(brokenCoverageResult.success, true);
    assert.notEqual(brokenCoverageResult.upToDate, true, "body/index mismatch must not short-circuit as up-to-date");
    assert.ok(brokenCoverageResult.warnings?.some(warning => warning.includes("正文实际覆盖 3/5 轮")));
    assert.equal(
        readRecordsIndex("general").records[brokenCoverageConversationId].lastUpdatedRound,
        5,
        "generateRecord must not mutate the persisted index before the coordinated commit",
    );
    assert.equal(Number(fs.readFileSync(patchCountFile, "utf-8")), 2, "repair should continue from uncovered rounds through generation");
    await deleteRecord("general", brokenCoverageConversationId);

    const forceConversationId = `record-force-rebuild-${Date.now()}`;
    await writeRecord("general", forceConversationId, [
        "# 对话记录 Record",
        "",
        "- 对话ID：`force-existing`",
        "- 工作区：`test`",
        "- 总轮次：5",
        "- 总步骤：15",
        "",
        "## Phase 1：既有记录（轮次 1-2）",
        "",
        "- force existing stable phase",
        "",
        "## Phase 2：旧尾巴（轮次 3-3）",
        "",
        "- 旧尾巴会被回滚重写",
        "",
        "<!-- TAGS: existing -->",
    ].join("\n"), {
        title: "force existing",
        totalRounds: 5,
        totalSteps: 15,
        lastUpdatedRound: 5,
        phases: 2,
        tags: ["existing"],
    });
    const forceResult = await generateRecord("general", forceConversationId, "test", [
        round(1, 100),
        round(2, 100),
        round(3, 100),
        round(4, 100),
        round(5, 100),
    ], 15, "codex", {
        force: true,
    });
    assert.equal(forceResult.success, true);
    assert.notEqual(forceResult.upToDate, true, "force=true must bypass up-to-date shortcut");
    assert.match(forceResult.content || "", /force existing stable phase/u, "force=true should preserve stable old Record body");
    assert.match(forceResult.content || "", /重写衔接阶段/u, "force=true should rewrite rollback/new tail");
    assert.ok(forceResult.warnings?.some(warning => warning.includes("安全刷新")));
    await deleteRecord("general", forceConversationId);

    const localComposeConversationId = `record-local-compose-${Date.now()}`;
    await writeRecord("general", localComposeConversationId, [
        "# 对话记录 Record",
        "",
        "- 对话ID：`local-compose`",
        "- 工作区：`test`",
        "- 总轮次：3",
        "- 总步骤：9",
        "",
        "## Phase 1：稳定阶段（轮次 1-2）",
        "",
        "- 稳定区必须原样保留",
        "",
        "## Phase 2：开放阶段（轮次 3-3）",
        "",
        "- 进行中，下一步继续",
        "",
        "# 产出文件总清单",
        "",
        "- `old.ts`",
        "",
        "<!-- TAGS: old, record -->",
    ].join("\n"), {
        title: "local-compose",
        totalRounds: 3,
        totalSteps: 9,
        lastUpdatedRound: 3,
        phases: 2,
        tags: ["old", "record"],
    });
    const localComposeRounds = [round(1, 100), round(2, 100), round(3, 100), round(4, 20_000), round(5, 20_000)];
    const localComposeResult = await generateRecord("general", localComposeConversationId, "test", localComposeRounds, 15, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(localComposeResult.success, true);
    assert.match(localComposeResult.content || "", /稳定区必须原样保留/u);
    assert.match(localComposeResult.content || "", /重写衔接阶段/u);
    assert.match(localComposeResult.content || "", /模型只输出增量/u);
    assert.doesNotMatch(localComposeResult.content || "", /# Record: parallel test/u);
    await deleteRecord("general", localComposeConversationId);

    const singleChunkConversationId = `record-single-chunk-local-compose-${Date.now()}`;
    await writeRecord("general", singleChunkConversationId, [
        "# 对话记录 Record",
        "",
        "- 对话ID：`single-chunk`",
        "- 工作区：`wrong-workspace`",
        "- 总轮次：3",
        "- 总步骤：9",
        "",
        "## Phase 1：稳定阶段（轮次 1-2）",
        "",
        "- " + "稳定区必须原样保留 ".repeat(200),
        "",
        "## Phase 2：开放阶段（轮次 3-3）",
        "",
        "- 进行中，下一步继续",
        "",
        "# 产出文件总清单",
        "",
        "- `old.ts`",
        "",
        "<!-- TAGS: old, record -->",
    ].join("\n"), {
        title: "single-chunk",
        totalRounds: 3,
        totalSteps: 9,
        lastUpdatedRound: 3,
        phases: 2,
        tags: ["old", "record"],
    });
    fs.rmSync(patchCountFile, { force: true });
    process.env.FAKE_CODEX_EMPTY_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_PATCHES = "0";
    const singleChunkResult = await generateRecord("general", singleChunkConversationId, "fixed-workspace", [
        round(1, 100),
        round(2, 100),
        round(3, 100),
        round(4, 100),
    ], 12, "codex", {
        background: true,
        parallelMode: "auto",
    });
    assert.equal(singleChunkResult.success, true);
    assert.equal(singleChunkResult.pipeline, "parallel", "large existing Record should use local compose even when new content is one chunk");
    assert.equal(Number(fs.readFileSync(patchCountFile, "utf-8")), 1, "single chunk should still be converted to one RecordPatch");
    assert.match(singleChunkResult.content || "", /- 工作区：`fixed-workspace`/u);
    await deleteRecord("general", singleChunkConversationId);

    fs.rmSync(patchCountFile, { force: true });
    process.env.FAKE_CODEX_EMPTY_PATCHES = "0";
    process.env.FAKE_CODEX_SLEEP_PATCHES = "1";
    process.env.FAKE_CODEX_SLEEP_REDUCER_MS = "0";
    const timeoutResult = await generateRecord("general", `record-parallel-timeout-${Date.now()}`, "test", denseRounds, 9, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(timeoutResult.success, false);
    assert.match(timeoutResult.error || "", /完整超时/u);
    assert.equal(Number(fs.readFileSync(patchCountFile, "utf-8")), 1, "full timeout should not trigger outer chunk retry");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
