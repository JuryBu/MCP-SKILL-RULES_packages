import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

// 隔离数据根：必须在导入数据层（record-store 等）前设置，否则阈值常量加载时读不到。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-round-split-data-"));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-round-split-test-"));
const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");

// 假 codex：
// - MODE=empty   → 收到压缩 prompt 时退出 0 但不写 output（模拟空返回，触发降级）
// - MODE=echo    → 收到压缩 prompt 时回显一个简短摘要，并把 steps 区间标记原样带回（验证不丢不重）
// 任何未匹配分支 → process.exit(1)，防假绿。
fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    if (input.includes("你在压缩一个超长对话轮")) {
      const mode = process.env.FAKE_CODEX_MODE || "echo";
      if (mode === "empty") {
        // 退出 0 但不写 output → Codex 桥判定「输出为空」→ resp.text=null → 整轮降级。
        process.exit(0);
      }
      // echo：抽取 prompt 里的 "第 k/n 段（覆盖 steps a-b）" 标记，回显一个短摘要。
      const m = input.match(/第 (\\d+)\\/(\\d+) 段（覆盖 steps (\\d+)-(\\d+)）/);
      const tag = m ? ("STEPS_" + m[3] + "_" + m[4]) : "STEPS_UNKNOWN";
      fs.writeFileSync(outputPath, "压缩摘要 " + tag + "：执行了关键操作，涉及文件 src/x.ts，命令 npm run build，结论 ok。", "utf-8");
      process.exit(0);
    }
    // 未匹配的 prompt（不应发生）→ 失败暴露问题
    process.exit(1);
  });
  return;
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "8000";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
// 把切分 part 上限调小，让多 step 巨轮稳定切成多段。
process.env.MEMORY_STORE_RECORD_ROUND_SPLIT_PART_CHARS = "20000";
// 单轮上限保持默认 60K（>60K 才触发切分/截断），显式写出以防外部环境覆盖。
process.env.MEMORY_STORE_RECORD_MAX_SINGLE_ROUND_CHARS = "60000";

const { formatRoundsForRecordAsync } = await import("../src/record-generator.ts");

const PART_LIMIT = 20000;
const SINGLE_ROUND_LIMIT = 60000;

/** 构造一个多 step 的超大轮：每个 step 一条 AI 回复，response 约 perStepChars 字。 */
function oversizedRound(roundIndex: number, stepCount: number, perStepChars: number): ConversationRound {
    const startStep = roundIndex * 1000; // 让不同轮 step 不重叠
    const aiResponses = Array.from({ length: stepCount }, (_, i) => ({
        stepIndex: startStep + i,
        response: `[step ${startStep + i}] ` + "字".repeat(perStepChars),
        thinking: "",
        toolCalls: [] as { name: string; args: string }[],
    }));
    return {
        roundIndex,
        startStep,
        endStep: startStep + stepCount - 1,
        userMessage: `用户在轮次 ${roundIndex} 的提问（唯一标记 UNIQUE_USER_MSG_${roundIndex}）`,
        mediaAttachments: [],
        aiResponses,
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

/** 普通小轮（~1K 字），不应触发切分/模型调用。 */
function smallRound(roundIndex: number): ConversationRound {
    const startStep = roundIndex * 1000;
    return {
        roundIndex,
        startStep,
        endStep: startStep + 1,
        userMessage: `小轮用户消息 ${roundIndex}`,
        mediaAttachments: [],
        aiResponses: [{ stepIndex: startStep + 1, response: "正常回复内容。".repeat(50), thinking: "", toolCalls: [] }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

// ============ 用例 1：降级路径（最关键） ============
{
    process.env.FAKE_CODEX_MODE = "empty";
    // 10 个 step × 8000 字 ≈ 80K+ 字 → 超 60K，触发切分；空返回 → 整轮降级。
    const round = oversizedRound(1, 10, 8000);
    const rounds = [round];

    let threw = false;
    let formatted: Awaited<ReturnType<typeof formatRoundsForRecordAsync>> | null = null;
    try {
        formatted = await formatRoundsForRecordAsync(rounds, "codex", {});
    } catch {
        threw = true;
    }

    assert.equal(threw, false, "降级路径绝不能抛异常");
    assert.ok(formatted, "应返回结果");
    assert.equal(formatted!.length, 1, "应正好返回一个 FormattedRecordRound（一轮=最小对齐单元）");
    const item = formatted![0];
    assert.equal(item.round.roundIndex, 1, "roundIndex 不变");
    // capSingleRoundText 的截断标记
    assert.ok(
        item.text.includes("超单轮上限") && item.text.includes("中段"),
        "降级文本应含 capSingleRoundText 的截断标记，实际：" + item.text.slice(0, 200),
    );
    // 不应含压缩摘要的回显标记（确认确实走的是截断而非压缩）
    assert.ok(!item.text.includes("压缩摘要 STEPS_"), "降级路径不应出现压缩摘要内容");
    console.log("用例1 通过：降级路径不抛、capSingleRoundText 截断、roundIndex 不变、返回 1 个 round");
}

// ============ 用例 2：普通小轮不触发 ============
{
    process.env.FAKE_CODEX_MODE = "empty"; // 即便配成 empty，小轮也不应调用模型
    const round = smallRound(2);
    const rawText = (await import("../src/trajectory.ts")).formatRound(round, "normal");
    const formatted = await formatRoundsForRecordAsync([round], "codex", {});
    assert.equal(formatted.length, 1, "返回一个 round");
    assert.equal(formatted[0].text, rawText, "普通小轮应原样返回 rawText（未压缩/未截断）");
    assert.ok(!formatted[0].text.includes("超单轮上限"), "小轮不应有截断标记");
    assert.ok(!formatted[0].text.includes("已按 step 切成"), "小轮不应有压缩合并标记");
    assert.equal(formatted[0].round.roundIndex, 2, "roundIndex 不变");
    console.log("用例2 通过：普通小轮原样返回、不调模型、text==rawText");
}

// ============ 用例 3：切分正确性（压缩路径跑通） ============
{
    process.env.FAKE_CODEX_MODE = "echo";
    const stepCount = 12;
    const round = oversizedRound(3, stepCount, 8000); // 12 × 8000 ≈ 96K+ → 切多段
    const formatted = await formatRoundsForRecordAsync([round], "codex", {});

    assert.equal(formatted.length, 1, "返回一个 round");
    const text = formatted[0].text;
    assert.equal(formatted[0].round.roundIndex, 3, "roundIndex 不变");

    // 压缩后体量应远小于原文（96K+），且整体 ≤ 单轮上限。
    assert.ok(text.length <= SINGLE_ROUND_LIMIT, `压缩后 text 应 ≤ 单轮上限，实际 ${text.length}`);

    // userMessage（唯一标记）只出现一次。
    const userMatches = text.match(/UNIQUE_USER_MSG_3/g) || [];
    assert.equal(userMatches.length, 1, `userMessage 应只在开头出现一次，实际 ${userMatches.length} 次`);

    // 应含合并 header 与压缩说明。
    assert.ok(text.includes("## 轮次 3 (steps"), "应含轮次 header");
    assert.ok(text.includes("已按 step 切成"), "应含压缩合并说明");

    // 各 step 不丢不重：把每个 part 回显的 STEPS_a_b 标记解析出来，
    // 断言所有 part 区间首尾相接、连续覆盖 [startStep, endStep] 且无重叠。
    const startStep = 3 * 1000;
    const endStep = startStep + stepCount - 1;
    const tagRe = /压缩摘要 STEPS_(\d+)_(\d+)/g;
    const ranges: Array<[number, number]> = [];
    let mm: RegExpExecArray | null;
    while ((mm = tagRe.exec(text)) !== null) {
        ranges.push([Number(mm[1]), Number(mm[2])]);
    }
    assert.ok(ranges.length >= 2, `应切成多段（≥2），实际 ${ranges.length} 段`);
    // 排序后校验连续无缝、无重叠、首尾对齐整轮。
    ranges.sort((a, b) => a[0] - b[0]);
    assert.equal(ranges[0][0], startStep, `首段应从轮 startStep=${startStep} 开始，实际 ${ranges[0][0]}`);
    assert.equal(ranges[ranges.length - 1][1], endStep, `末段应到轮 endStep=${endStep} 结束，实际 ${ranges[ranges.length - 1][1]}`);
    for (let i = 1; i < ranges.length; i++) {
        assert.equal(ranges[i][0], ranges[i - 1][1] + 1, `第 ${i} 段应紧接上一段（不丢不重），上段末=${ranges[i - 1][1]} 本段首=${ranges[i][0]}`);
    }
    console.log(`用例3 通过：压缩后 ${text.length} 字 ≤ 上限、切成 ${ranges.length} 段 step 连续无缝、userMessage 只出现一次`);
}

console.log("record-round-split 全部用例通过");
