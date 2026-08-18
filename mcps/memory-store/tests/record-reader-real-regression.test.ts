import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Record reader 端到端回归（findRecordHash → readRecord → reader index → 结构化 search → guide）。
 *
 * 改造背景：本测试原先写死生产环境的真实对话 UUID + 真实数据目录，换机/清数据后必挂、CI 无法重放。
 * 现改为「自给自足 fixture」：在临时 DATA_ROOT 里用 writeRecord 合成 Record 再跑全链路，不读任何生产数据。
 * 可选的真实库冒烟用 env 开关 MEMORY_STORE_REAL_REGRESSION=1 才跑；默认（含 CI/新机）只跑 fixture，永远绿。
 *
 * ⚠️ 必须在 import 数据层之前就设隔离 DATA_ROOT（store/record-store 在模块加载时读 env 算路径）。
 */

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-real-regression-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { writeRecord, findRecordHash, readRecord, resolveWorkspaceHashForRecord } = await import("../src/record-store.ts");
const { buildRecordReaderIndex, formatReaderView } = await import("../src/record-reader.ts");
const { buildStructuredRecordSearchBlocks, buildRecordGuideRecommendations } = await import("../src/tools/record.ts");
const { search } = await import("../src/search-engine.ts");

// ============================================================
// 合成 fixture：一份内容丰富、靠后轮次、含 tail 产出清单/风险/状态的 Record
// 覆盖原回归断言所有点：reader blocks/phases、outline 可放下、state 优先最新、
// outputs 含尾部文件清单、结构化 search 有 provenance、guide 有 hint+provenance。
// ============================================================
function buildFixtureRecord(): string {
    return [
        "# 对话记录 Record：QQ 安全入口接力",
        "",
        "- 对话ID：`fixture-real-regression`",
        "- 工作区：`fixture-ws`",
        "- 总轮次：144",
        "- 总步骤：24933",
        "",
        "## Phase 1：早期授权入口修复（轮次 82-100）",
        "",
        "### 用户要求",
        "- U82 要求修复早期授权入口。",
        "",
        "### 当前状态",
        "- U82 早期授权入口已初步打通，但仍不稳定。",
        "",
        "### 风险",
        "- 早期风险：授权窗口偶发不弹出。",
        "",
        "## Phase 2：真实链路重测与收口（轮次 130-144）",
        "",
        "### AI 执行",
        "- 重跑 QQ 安全入口真实链路 E2E 重测。",
        "",
        "### 关键决策",
        "- raw Record 是唯一事实源，reader 只做结构化视图。",
        "",
        "### 验证",
        "- `npm run build` 通过，结构化 search 可返回 block 来源。",
        "",
        "### 经验教训",
        "- Debug/Release helper 构建错位会造成真实弹窗仍旧。",
        "",
        "### 风险",
        "- QQ 安全入口仍是当前主 blocker。",
        "- 最新风险：U1 单一真实 ChatGPT + QQ E2E 尚未通过。",
        "",
        "### 当前状态",
        "- U100 收口完成，准备新对话接力。",
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
        "# 风险记录",
        "",
        "- 最新风险：target_region 越界黑图需要明确报错。",
        "",
        "# 后续建议",
        "",
        "1. 先修 `target_region` 边界。",
    ].join("\n");
}

/** 对一个已落盘的 Record 跑完整 reader → search → guide 链路断言（fixture 与真实库共用）。 */
async function runRegressionFlow(label: string, hash: string, id: string, opts: { strictTail?: boolean } = {}): Promise<void> {
    const content = readRecord(hash, id);
    assert.ok(content, `[${label}] missing record content for ${id}`);

    const index = buildRecordReaderIndex(id, content!);
    assert.ok(index.blocks.length > 0, `[${label}] no reader blocks for ${id}`);
    assert.ok(index.phases.length > 0, `[${label}] no phases for ${id}`);

    const outline = formatReaderView(index, { view: "outline", maxChars: 4000 });
    assert.equal(outline.truncated, false, `[${label}] outline should fit for ${id}`);

    const state = formatReaderView(index, { view: "state", maxChars: 4000 });
    assert.ok(state.text.length > 0 || index.aggregates.status.length === 0, `[${label}] state read failed for ${id}`);

    if (opts.strictTail) {
        // 复刻原测试对「真实尾部产出/最新状态」的强断言（现由 fixture 保证）
        const outputs = formatReaderView(index, { view: "outputs", maxChars: 8000 });
        assert.match(outputs.text, /computer-use-plugin\/mcp-server\/src\/index\.ts/u, `[${label}] outputs should include tail child file list`);
        assert.match(outputs.text, /stage54-u100-qq-safe-route-live-retest-report\.md/u, `[${label}] outputs should include report file list`);
        const currentState = formatReaderView(index, { view: "state", maxChars: 3000 });
        assert.match(currentState.text, /QQ 安全入口仍是当前主 blocker|U1 单一真实 ChatGPT \+ QQ E2E/u, `[${label}] state should prioritize latest risk/status content`);
        assert.doesNotMatch(currentState.text.slice(0, 400), /U82/u, `[${label}] state should not start from old U82 content under small budget`);
    }

    const blocks = await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
        conversationId: id,
        searchScope: "section",
        sectionTypes: ["outputs", "status", "lessons", "risks", "verification"],
        indexMode: "rebuild",
    });
    assert.ok(blocks.length > 0, `[${label}] no structured blocks for ${id}`);

    const results = await search(blocks, "Record", { mode: "auto", limit: 3 });
    assert.ok(results.length > 0, `[${label}] no structured search results for ${id}`);
    assert.ok(results[0].metadata?.recordId, `[${label}] missing provenance for ${id}`);

    const guide = await buildRecordGuideRecommendations(hash, "workspace", false, {
        conversationId: id,
        goal: "当前状态 产出文件",
        maxRecommendations: 3,
    });
    assert.ok(guide.length > 0, `[${label}] no guide recommendations for ${id}`);
    assert.ok(guide[0].readHint || guide[0].searchHint, `[${label}] guide missing hints for ${id}`);
    assert.ok(guide[0].provenance, `[${label}] guide missing provenance for ${id}`);

    console.log(`[${label}] ${id} hash=${hash} sizeKB=${(Buffer.byteLength(content!, "utf8") / 1024).toFixed(1)} phases=${index.phases.length} blocks=${index.blocks.length} search=${results.length} guide=${guide.length}`);
}

/**
 * 真实库冒烟：spawn 一个不带 MEMORY_STORE_DATA_ROOT 的子进程，对真实库里的若干 id 跑
 * findRecordHash → readRecord → buildRecordReaderIndex。id 不存在则跳过单条，不让整体失败。
 * 仅 MEMORY_STORE_REAL_REGRESSION=1 时调用，默认/CI 不触碰真实数据。
 */
function runRealSmoke(): void {
    const realIds = (process.env.MEMORY_STORE_REAL_REGRESSION_IDS
        || "019dd825-a3db-7aa2-bf7c-f840b2d9dc4b,019ddbe1-5242-7873-b86e-c653a957eabc,019e19f2-97ff-73f1-a68f-d73c6854be7a")
        .split(",").map(s => s.trim()).filter(Boolean);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.join(here, "..", "src");
    const storeUrl = pathToFileURL(path.join(srcDir, "record-store.ts")).href;
    const readerUrl = pathToFileURL(path.join(srcDir, "record-reader.ts")).href;
    const childScript = `
import { findRecordHash, readRecord } from ${JSON.stringify(storeUrl)};
import { buildRecordReaderIndex } from ${JSON.stringify(readerUrl)};
const ids = ${JSON.stringify(realIds)};
let checked = 0, skipped = 0;
for (const id of ids) {
    const hash = findRecordHash(id);
    if (!hash) { console.log("[real-smoke] skip (not found): " + id); skipped++; continue; }
    const content = readRecord(hash, id);
    if (!content) { console.log("[real-smoke] skip (no content): " + id); skipped++; continue; }
    const index = buildRecordReaderIndex(id, content);
    if (!(index.blocks.length > 0 && index.phases.length > 0)) {
        console.error("[real-smoke] FAIL parse: " + id); process.exit(2);
    }
    console.log("[real-smoke] ok: " + id + " hash=" + hash + " phases=" + index.phases.length);
    checked++;
}
console.log("[real-smoke] done checked=" + checked + " skipped=" + skipped);
`;
    const tmpScript = path.join(os.tmpdir(), `real-smoke-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mts`);
    fs.writeFileSync(tmpScript, childScript, "utf-8");
    try {
        const childEnv = { ...process.env };
        delete childEnv.MEMORY_STORE_DATA_ROOT; // 子进程读真实默认库
        // 用 shell 字符串形式（而非 args 数组 + shell:true）避免 DEP0190；tmpScript 路径由本测试生成、可控无注入风险。
        const res = spawnSync(`npx tsx ${JSON.stringify(tmpScript)}`, {
            cwd: path.join(here, ".."),
            env: childEnv,
            encoding: "utf-8",
            shell: true,
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        assert.equal(res.status, 0, `真实库冒烟子进程应退出 0（id 不存在会跳过而非失败），实际 ${res.status}`);
        console.log("[real-regression] 真实库冒烟通过（子进程读默认真实库）。");
    } finally {
        try { fs.rmSync(tmpScript, { force: true }); } catch { /* ignore */ }
    }
}

try {
    // ---------------- ① fixture 路径（始终运行，干净临时库可重放）----------------
    const workspace = path.join(dataRoot, "fixture-ws");
    const hash = resolveWorkspaceHashForRecord(workspace);
    const fixtureId = "fixture-real-regression";
    await writeRecord(hash, fixtureId, buildFixtureRecord(), {
        title: "QQ 安全入口接力（fixture）",
        totalRounds: 144,
        totalSteps: 24933,
        lastUpdatedRound: 144,
        phases: 2,
        tags: ["regression", "fixture"],
    });

    // findRecordHash 必须能从合成索引里定位回 hash（不读生产）
    const foundHash = findRecordHash(fixtureId);
    assert.equal(foundHash, hash, "findRecordHash 应从合成索引定位到 fixture 所在 hash");

    await runRegressionFlow("fixture", hash, fixtureId, { strictTail: true });

    // ---------------- ② 可选真实库冒烟（仅 MEMORY_STORE_REAL_REGRESSION=1 时跑）----------------
    // 本进程的 DATA_ROOT 已在 import 时锁定到临时目录，无法运行时切回真实根；故真实冒烟用一个
    // 不带 MEMORY_STORE_DATA_ROOT 的子进程去读默认真实库。真实 id 不存在则跳过单条、不让整体失败。
    if (process.env.MEMORY_STORE_REAL_REGRESSION === "1") {
        runRealSmoke();
    } else {
        console.log("[real-regression] 跳过真实库冒烟（设 MEMORY_STORE_REAL_REGRESSION=1 启用）。");
    }

    console.log("✅ record-reader-real-regression 通过：fixture 自给自足、findRecordHash 定位、reader/search/guide 全链路、真实库冒烟受 env 开关控制");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
