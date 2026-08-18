import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

/**
 * B5 / M3：串行长记录中段不可见（治标版）回归测试。
 *
 * 根因：串行合成跨窗续写「未收尾的开放 Phase」时，喂给下一窗模型的 openPhaseSnippet
 * 旧实现只取 `acc.openPhase.markdown.slice(-1500)`（末 1500 字），但 prompt 又要求模型
 * 把延续后的【完整】markdown（含历史已写部分）放进 phases[0]——模型只看到末 1500 字
 * 却要重产整段 → 丢掉开放 Phase 的头部内容。
 *
 * 治标方案：buildOpenPhaseSnippet 喂完整累积内容（仅超 RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS
 * 这个很高的上限时才头尾截断兜底），让模型看到完整历史→完整重产→不丢头部。
 *
 * 本测试两层断言：
 * 1) 单元（确定性）：buildOpenPhaseSnippet 在 markdown > 1500 字时仍包含开头部分。
 * 2) 端到端（fake-codex 桩 + 临时 DATA_ROOT）：串行管线下，第二窗的 step prompt 能看到
 *    第一窗开放 Phase 的头部标志串（不再只有末 1500 字），且最终 Record 含该头部标志串。
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-serial-open-phase-test-"));
// 隔离数据根，必须在导入 record-store 前设置。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-serial-open-phase-data-"));
const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");
// 第二窗及之后的 step prompt 是否包含第一窗开放 Phase 的头部标志串（写 "1"/"0"）。
const headSeenFile = path.join(tempDir, "head-seen.txt");
// 第二窗及之后的 step prompt 是否包含开放 Phase 的尾部标志串（确认确实拿到完整内容）。
const tailSeenFile = path.join(tempDir, "tail-seen.txt");

// 头部 / 尾部标志串，配合中段大量填充，让开放 Phase 的累积 markdown 远超 1500 字，
// 旧实现（末 1500 字）必然丢掉头部标志串，新实现（完整内容）则能看到。
const HEAD_MARKER = "OPENPHASE_HEAD_MARKER_UNIQUE_12345";
const TAIL_MARKER = "OPENPHASE_TAIL_MARKER_UNIQUE_67890";
const FILLER = "中段填充内容用于把开放 Phase 撑过 1500 字阈值并使末尾窗口看不到头部。".repeat(120);

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

const HEAD_MARKER = ${JSON.stringify(HEAD_MARKER)};
const TAIL_MARKER = ${JSON.stringify(TAIL_MARKER)};
const FILLER = ${JSON.stringify(FILLER)};
const HEAD_SEEN_FILE = process.env.FAKE_CODEX_HEAD_SEEN_FILE;
const TAIL_SEEN_FILE = process.env.FAKE_CODEX_TAIL_SEEN_FILE;

if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("-o");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    // === patch 步：回填 prompt 里的 startRound/endRound，每个 chunk 一个 patch ===
    if (input.includes("请把指定轮次区段整理为 RecordPatch 草稿")) {
      const sm = input.match(/"startRound":\\s*(\\d+)/);
      const em = input.match(/"endRound":\\s*(\\d+)/);
      const startRound = sm ? Number(sm[1]) : 1;
      const endRound = em ? Number(em[1]) : startRound;
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          startRound, endRound,
          title: "区段 " + startRound + "-" + endRound,
          files: ["src/example.ts"],
          tags: ["serial"],
          risks: [],
          status: "ok"
        }),
        "\`\`\`",
        "",
        "## Phase Draft",
        "",
        "- 区段 " + startRound + "-" + endRound + " 草稿"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }

    // === 串行步：第一窗产 open:true 的超长开放 Phase，后续窗校验是否看到头部 ===
    if (input.includes("正在串行累积一段长 Record 的重写区") || input.includes("请只输出本子窗口")) {
      const wm = input.match(/本子窗口轮次范围:\\s*(\\d+)-(\\d+)/);
      const winStart = wm ? Number(wm[1]) : 1;
      const winEnd = wm ? Number(wm[2]) : winStart;
      const isLastWindow = /是否末窗口:\\s*true/.test(input);
      const hasOpenPhaseSection = input.includes("上一步留下的未收尾 Phase");

      if (hasOpenPhaseSection) {
        // 这是第二窗及之后：记录 step prompt 是否包含第一窗开放 Phase 的头/尾标志串。
        if (HEAD_SEEN_FILE) fs.writeFileSync(HEAD_SEEN_FILE, input.includes(HEAD_MARKER) ? "1" : "0", "utf-8");
        if (TAIL_SEEN_FILE) fs.writeFileSync(TAIL_SEEN_FILE, input.includes(TAIL_MARKER) ? "1" : "0", "utf-8");
        // 续写并收尾这个开放 Phase：把头部标志串原样带回（模拟「完整重产」），最终 Record 才含头部。
        const md = [
          "## Phase ?：跨窗开放阶段（轮次 X-Y）",
          "",
          "- " + HEAD_MARKER,
          "- " + FILLER,
          "- 续写补充：本窗收尾",
          "- " + TAIL_MARKER
        ].join("\\n");
        fs.writeFileSync(outputPath, [
          "\`\`\`json",
          JSON.stringify({
            phases: [
              { title: "跨窗开放阶段", startRound: winStart, endRound: winEnd, open: !isLastWindow, markdown: md }
            ],
            warnings: []
          }),
          "\`\`\`"
        ].join("\\n"), "utf-8");
        process.exit(0);
      }

      // 第一窗：产一个 open:true 的超长开放 Phase（头部标志 + 大段填充 + 尾部标志 > 1500 字）。
      const md = [
        "## Phase ?：跨窗开放阶段（轮次 X-Y）",
        "",
        "- " + HEAD_MARKER,
        "- " + FILLER,
        "- " + TAIL_MARKER
      ].join("\\n");
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          phases: [
            { title: "跨窗开放阶段", startRound: winStart, endRound: winEnd, open: !isLastWindow, markdown: md }
          ],
          warnings: []
        }),
        "\`\`\`"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }

    // === tail 步：全局尾部 ===
    if (input.includes("生成 Record 的全局尾部")) {
      fs.writeFileSync(outputPath, [
        "\`\`\`json",
        JSON.stringify({
          tailMarkdown: "# 产出文件总清单\\n\\n- src/example.ts\\n\\n# 经验教训\\n\\n- 串行合成喂完整开放 Phase",
          tags: ["serial", "record"]
        }),
        "\`\`\`"
      ].join("\\n"), "utf-8");
      process.exit(0);
    }

    // 兜底：其它（如 compress）请求，给一个最小合法 patch。
    fs.writeFileSync(outputPath, [
      "\`\`\`json",
      JSON.stringify({ startRound: 1, endRound: 1, title: "兜底", files: [], tags: [], risks: [], status: "ok" }),
      "\`\`\`",
      "",
      "## Phase Draft",
      "",
      "- 兜底草稿"
    ].join("\\n"), "utf-8");
    process.exit(0);
  });
  return;
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "5000";
process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT = "5000";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS = "0";
process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY = "1";
process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES = "0";
// 每轮一个 chunk → 每个 chunk 一个 patch（patch 粒度细，方便窗口切分）。
process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = "5000";
process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = "100000";
// 直接进 reduce 的 patch 上限设高，确保不触发 compress；串行触发后窗口切分才是重点。
process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT = "100";
// 串行触发阈值：轮数跨度 > 此值即走串行（造 6 轮 > 3 即触发）。
process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS = "3";
process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS = "1000000";
// 串行窗口切分：每窗最多 2 轮 → 6 轮切成 3 窗，保证产生「跨窗开放 Phase」。
process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_ROUNDS = "2";
process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_PATCHES = "2";
process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_CHARS = "1000000";
process.env.FAKE_CODEX_HEAD_SEEN_FILE = headSeenFile;
process.env.FAKE_CODEX_TAIL_SEEN_FILE = tailSeenFile;

const {
    buildOpenPhaseSnippet,
    formatRoundsForRecord,
    generateRecord,
} = await import("../src/record-generator.ts");
const { deleteRecord } = await import("../src/record-store.ts");

function round(index: number): ConversationRound {
    return {
        roundIndex: index,
        startStep: index * 3,
        endStep: index * 3 + 2,
        userMessage: `用户轮次 ${index}`,
        mediaAttachments: [],
        aiResponses: [{ stepIndex: index * 3 + 1, response: "A".repeat(3_000), thinking: "", toolCalls: [] }],
        toolCalls: [{ stepIndex: index * 3 + 2, name: "shell_command", argsSummary: "cmd", resultSummary: "ok" }],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

try {
    // ============ 单元（确定性）：核心断言 ============
    // markdown > 1500 字时，旧实现 slice(-1500) 会丢头部；新实现喂完整内容，必含开头部分。
    const headMarker = "HEAD_UNIQUE_AAA";
    const tailMarker = "TAIL_UNIQUE_ZZZ";
    const longMd = `## Phase ?：开放阶段（轮次 1-5）\n\n- ${headMarker}\n- ${"填充".repeat(2000)}\n- ${tailMarker}`;
    assert.ok(longMd.length > 1500, "测试前提：开放 Phase markdown 必须 > 1500 字");
    const snippet = buildOpenPhaseSnippet({ startRound: 1, endRound: 5, markdown: longMd });
    assert.ok(snippet.includes(headMarker), "新实现必须包含开放 Phase 的头部内容（旧 slice(-1500) 会丢掉）");
    assert.ok(snippet.includes(tailMarker), "snippet 也应包含尾部内容");
    // 反向锚定：证明旧实现（末 1500 字）确实看不到头部，否则本测试没意义。
    assert.ok(!longMd.slice(-1500).includes(headMarker), "对照：旧 slice(-1500) 确实丢失头部（验证修复有效性）");

    // 超高上限的病态超长兜底：超过上限时头尾保留，仍含头部。
    const hugeMd = `## Phase ?：巨型开放阶段\n\n- ${headMarker}\n- ${"X".repeat(120_000)}\n- ${tailMarker}`;
    const hugeSnippet = buildOpenPhaseSnippet({ startRound: 1, endRound: 5, markdown: hugeMd });
    assert.ok(hugeSnippet.includes(headMarker), "病态超长兜底仍须保留头部");
    assert.ok(hugeSnippet.includes(tailMarker), "病态超长兜底仍须保留尾部");
    assert.ok(hugeSnippet.includes("中段省略"), "病态超长应走头尾保留+中段省略兜底");
    assert.ok(hugeSnippet.length < hugeMd.length, "病态超长应被截断到上限附近");

    // ============ 端到端：串行管线下第二窗能看到头部 + 最终 Record 含头部 ============
    fs.rmSync(headSeenFile, { force: true });
    fs.rmSync(tailSeenFile, { force: true });
    const rounds = Array.from({ length: 6 }, (_, i) => round(i + 1));
    // 触发并行→本地合成→串行：用 formatRoundsForRecord 让 chunk 数 >= 2。
    const formatted = formatRoundsForRecord(rounds);
    assert.ok(formatted.length === 6, "应有 6 个格式化轮");

    const convId = `serial-open-phase-${Date.now()}`;
    const result = await generateRecord("general", convId, "test", rounds, 18, "codex", {
        background: true,
        parallelMode: "force",
    });
    assert.equal(result.success, true, `生成应成功：${result.error || ""}`);
    assert.equal(result.pipeline, "parallel");

    // 第二窗（含「上一步留下的未收尾 Phase」段）必须看到第一窗开放 Phase 的头部标志串。
    assert.ok(fs.existsSync(headSeenFile), "应有后续窗口收到开放 Phase 上下文（说明确实跨窗）");
    assert.equal(fs.readFileSync(headSeenFile, "utf-8"), "1", "第二窗 step prompt 必须包含开放 Phase 的头部标志串（修复点：不再只喂末 1500 字）");
    assert.equal(fs.readFileSync(tailSeenFile, "utf-8"), "1", "第二窗 step prompt 也应包含开放 Phase 的尾部标志串（喂的是完整累积内容）");

    // 最终 Record 应保留头部标志串（头部内容未丢失）。
    assert.ok((result.content || "").includes(HEAD_MARKER), "最终合成的 Record 必须含开放 Phase 头部内容（头部未丢失）");

    await deleteRecord("general", convId);

    console.log("[serial-open-phase-context] 全部断言通过");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
