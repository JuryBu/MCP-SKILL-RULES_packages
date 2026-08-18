import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ 必须在 import 数据层之前就设隔离 DATA_ROOT：store.ts 在模块加载时按 env 算路径，
//    import 后再设无效，且会污染真实记忆库。
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-core-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const store = await import("../src/store.ts");
const {
    buildMemoryFile,
    parseMemoryFile,
    writeMemoryFile,
    readMemoryFile,
    generateMemoryId,
    workspaceHash,
    canonicalWorkspacePath,
    ensureWorkspace,
    ensureDataDirs,
    getEntryPath,
    WORKSPACES_DIR,
} = store;
const { checkDuplicates, fuseSearch, grepInEntries } = await import("../src/search.ts");

type Frontmatter = import("../src/store.ts").MemoryFrontmatter;
type Entry = import("../src/cache.ts").MemoryIndexEntry;

ensureDataDirs();

function indexEntry(overrides: Partial<Entry>): Entry {
    return {
        id: "id-x",
        title: "默认标题",
        searchSummary: "",
        tags: [],
        category: "general",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
        lastAccessed: "2026-06-22T00:00:00.000Z",
        sizeBytes: 0,
        lineCount: 0,
        ...overrides,
    } as Entry;
}

let passed = 0;
function ok(label: string): void {
    passed++;
    console.log(`  ✓ ${label}`);
}

// ============================================================
// ① frontmatter 往返：build → write → read → parse round-trip 无损
// ============================================================
{
    const now = "2026-06-22T13:45:09.123Z";
    const hash = "core00aa";
    const id = "20260622-134509123-roundtrip";
    const fm: Frontmatter = {
        id,
        title: '标题含"引号"与 colon: 冒号',
        tags: ["frontmatter", "round-trip", "记忆"],
        category: "technical-note",
        created: now,
        updated: now,
        workspace: "C:/proj/demo",
        conversationId: "conv-abc-123",
        searchSummary: "这是一条用于测试往返的搜索摘要 包含关键词 frontmatter roundtrip",
        autoSummary: "Flash 自动生成的摘要 内含 powershell 与 mcp 关键字",
        pinned: true,
    };
    const body = "# 正文标题\n\n这是正文，包含代码 `const x = 1;` 与中文段落。\n\n- 列表项一\n- 列表项二\n";

    const built = buildMemoryFile(fm, body);
    writeMemoryFile(hash, id, built);

    // 落盘路径正确
    assert.equal(fs.existsSync(getEntryPath(hash, id)), true, "记忆文件应落到 entries 目录");

    const raw = readMemoryFile(hash, id);
    assert.ok(raw, "readMemoryFile 应能读回内容");
    assert.equal(raw, built, "读回的原始字节应与写入一致");

    const parsed = parseMemoryFile(raw!);
    assert.ok(parsed, "parseMemoryFile 应成功解析");
    const f = parsed!.frontmatter;

    assert.equal(f.id, fm.id, "id round-trip");
    assert.equal(f.title, fm.title, "title round-trip（含引号/冒号）");
    assert.deepEqual(f.tags, fm.tags, "tags 数组 round-trip");
    assert.equal(f.category, fm.category, "category round-trip");
    assert.equal(f.created, fm.created, "created（ISO 含冒号）round-trip");
    assert.equal(f.updated, fm.updated, "updated round-trip");
    assert.equal(f.workspace, fm.workspace, "workspace round-trip");
    assert.equal(f.conversationId, fm.conversationId, "conversationId round-trip");
    assert.equal(f.searchSummary, fm.searchSummary, "searchSummary（折叠块）round-trip");
    assert.equal(f.autoSummary, fm.autoSummary, "autoSummary（折叠块）round-trip");
    assert.equal(f.pinned, true, "pinned 布尔 round-trip");
    // 注：buildMemoryFile 在 frontmatter 与正文间插一个空行，parseMemoryFile 的 body 捕获含该前导换行，
    //     属生产既定行为；用 trim() 对齐两端空白后比对正文内容。
    assert.equal(parsed!.body.trim(), body.trim(), "正文 body round-trip");
    ok("frontmatter 全字段 round-trip 无损（含引号/冒号/折叠块/可选字段）");
}

// 最小字段（无可选字段：无 conversationId / autoSummary / pinned；空 tags）也能 round-trip
{
    const now = "2026-06-22T01:02:03.000Z";
    const hash = "core00bb";
    const id = "20260622-010203000-minimal";
    const fm: Frontmatter = {
        id,
        title: "最小记忆",
        tags: [],
        category: "general",
        created: now,
        updated: now,
        workspace: "general",
        searchSummary: "",
    };
    const built = buildMemoryFile(fm, "只有正文一行。");
    // 未设的可选字段不应出现在 YAML 中
    assert.doesNotMatch(built, /conversationId:/u, "未传 conversationId 不应写入");
    assert.doesNotMatch(built, /\npinned:/u, "未传 pinned 不应写入");
    assert.doesNotMatch(built, /autoSummary:/u, "未传 autoSummary 不应写入");

    writeMemoryFile(hash, id, built);
    const parsed = parseMemoryFile(readMemoryFile(hash, id)!);
    assert.ok(parsed);
    assert.equal(parsed!.frontmatter.id, id);
    assert.deepEqual(parsed!.frontmatter.tags, [], "空 tags round-trip 为空数组");
    assert.equal(parsed!.frontmatter.conversationId, undefined, "缺省 conversationId 解析为 undefined");
    assert.equal(parsed!.frontmatter.pinned, undefined, "缺省 pinned 解析为 undefined");
    ok("最小字段记忆 round-trip（可选字段缺省正确）");
}

// 非法输入 parseMemoryFile 返回 null（无 frontmatter）
{
    assert.equal(parseMemoryFile("没有 frontmatter 的纯文本"), null, "无 frontmatter 应返回 null");
    assert.equal(readMemoryFile("core00aa", "不存在的-id"), null, "读不存在的文件应返回 null");
    ok("非法 / 缺失输入边界（parse 返回 null、read 返回 null）");
}

// ============================================================
// ② id 防碰撞：同标题多次生成不重复（含毫秒）
// ============================================================
{
    const title = "并发写入同标题的记忆";

    // 格式断言：YYYYMMDD-HHmmssSSS-slug（毫秒精度参与防撞）
    const fixed = new Date("2026-06-22T08:09:10.456Z");
    const a = generateMemoryId(title, fixed);
    assert.match(a, /^\d{8}-\d{9}-/u, "id 形如 YYYYMMDD-HHmmssSSS-slug（含毫秒）");
    assert.ok(a.includes("456"), "id 时间部分应含毫秒 456");

    // 毫秒级防撞：不同毫秒的同标题写入应得到不同 id（覆盖真实跨毫秒写入场景）
    const seen = new Set<string>();
    const base = Date.parse("2026-06-22T08:09:10.000Z");
    for (let i = 0; i < 200; i++) {
        seen.add(generateMemoryId(title, new Date(base + i)));
    }
    assert.equal(seen.size, 200, `不同毫秒同标题 200 次应生成 200 个不同 id，实际 ${seen.size}`);

    // ⚠️ 已知局限（如实记录，非断言失败）：generateMemoryId 仅到毫秒精度、无随机后缀/计数器，
    //    同一毫秒内对同标题的多次调用会得到完全相同的 id（200 次 → 去重后 1 个）。
    //    单进程并发写同标题（同毫秒）存在文件覆盖隐患；此处只观测、不让测试因生产实现而假绿/假红。
    const sameMs = new Set<string>();
    const ms = new Date("2026-06-22T08:09:10.456Z");
    for (let i = 0; i < 50; i++) sameMs.add(generateMemoryId(title, ms));
    assert.equal(sameMs.size, 1, "同毫秒同标题当前会碰撞（已知局限，见报告/已 spawn 修复任务）");
    ok("generateMemoryId：毫秒精度防撞（不同毫秒 200 次不重）+ 同毫秒局限已记录");
}

// ============================================================
// ③ workspaceHash 归一化：同一路径不同写法映射到同一 hash
// ============================================================
{
    const variants = [
        "C:/Users/Demo/proj",
        "C:\\Users\\Demo\\proj",        // 反斜杠
        "c:/users/demo/proj",            // 盘符 + 大小写
        "C:/Users/Demo/proj/",           // 尾斜杠
        "C:\\Users\\Demo\\proj\\",       // 反斜杠 + 尾分隔符
        "\\\\?\\C:\\Users\\Demo\\proj",  // Windows long-path 前缀
        "file:///C:/Users/Demo/proj",    // file URL
    ];
    const hashes = variants.map(v => workspaceHash(v));
    const canon = variants.map(v => canonicalWorkspacePath(v));
    assert.equal(new Set(hashes).size, 1, `同一路径 ${variants.length} 种写法应映射同一 hash，实际得到 ${new Set(hashes).size} 个：${[...new Set(hashes)].join(",")}`);
    assert.equal(new Set(canon).size, 1, "归一化路径应一致");
    assert.equal(canon[0], "c:/users/demo/proj", "归一化形态：盘符小写、正斜杠、无尾斜杠");

    // 不同路径必须映射到不同 hash（防误合并）
    assert.notEqual(workspaceHash("C:/Users/Demo/projA"), workspaceHash("C:/Users/Demo/projB"), "不同路径 hash 应不同");
    ok("workspaceHash 归一化：7 种等价写法同 hash，不同路径不撞");
}

// ensureWorkspace 建目录 + 索引 + 全局索引正确
{
    const wsPath = "C:/Users/Demo/ensure-test-ws";
    const { hash, dir } = ensureWorkspace(wsPath);
    assert.equal(hash, workspaceHash(wsPath), "ensureWorkspace 返回的 hash 应与 workspaceHash 一致");
    assert.equal(fs.existsSync(path.join(dir, "entries")), true, "entries 目录应被创建");
    assert.equal(fs.existsSync(path.join(dir, "_index.json")), true, "_index.json 应被创建");
    assert.equal(fs.existsSync(path.join(dir, "_meta.json")), true, "_meta.json 应被创建");
    assert.equal(dir, path.join(WORKSPACES_DIR, hash), "工作区目录路径应在 WORKSPACES_DIR/hash 下");

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "_meta.json"), "utf-8"));
    assert.equal(meta.originalPath, wsPath, "_meta 记录原始路径");
    assert.equal(meta.canonicalPath, canonicalWorkspacePath(wsPath), "_meta 记录归一化路径");

    const globalIndex = JSON.parse(fs.readFileSync(path.join(dataRoot, "_global_index.json"), "utf-8"));
    assert.ok(globalIndex.workspaces[hash], "全局索引应登记该工作区");

    // 同路径不同写法 ensureWorkspace 复用同一目录（不重建）
    const again = ensureWorkspace("c:\\users\\demo\\ensure-test-ws\\");
    assert.equal(again.hash, hash, "等价写法应复用同一工作区目录");
    ok("ensureWorkspace 建目录/索引/全局索引正确，等价路径复用");
}

// ============================================================
// ④ checkDuplicates / fuseSearch / grepInEntries 命中符合预期
// ============================================================
{
    const entries: Entry[] = [
        indexEntry({ id: "e-ps", title: "PowerShell 脚本调试技巧", searchSummary: "powershell pwsh 命令行 脚本 调试 排错", tags: ["powershell", "debug"] }),
        indexEntry({ id: "e-mcp", title: "MCP memory-store 设计笔记", searchSummary: "mcp memory store 记忆 索引 缓存 工作区", tags: ["mcp", "memory"] }),
        indexEntry({ id: "e-fuse", title: "Fuse.js 模糊搜索配置", searchSummary: "fuse 模糊 搜索 阈值 threshold 评分", tags: ["search", "fuse"] }),
        indexEntry({ id: "e-py", title: "Python 数据处理", searchSummary: "python pandas dataframe 数据清洗", tags: ["python"] }),
    ];

    // --- fuseSearch：英文关键词命中且排序合理 ---
    const r1 = fuseSearch(entries, "powershell", 5);
    assert.ok(r1.length >= 1, "fuseSearch 'powershell' 应有命中");
    assert.equal(r1[0].entry.id, "e-ps", "powershell 应命中 PowerShell 记忆排第一");

    // --- fuseSearch：多词查询覆盖率评分（mcp memory 应命中 mcp 记忆） ---
    const r2 = fuseSearch(entries, "mcp memory", 5);
    assert.ok(r2.length >= 1, "fuseSearch 多词 'mcp memory' 应有命中");
    assert.equal(r2[0].entry.id, "e-mcp", "多词查询应优先命中 MCP 记忆");

    // --- fuseSearch：CJK 子串命中 ---
    const r3 = fuseSearch(entries, "模糊搜索", 5);
    assert.ok(r3.some(r => r.entry.id === "e-fuse"), "CJK '模糊搜索' 应命中 Fuse 记忆");

    // --- fuseSearch：完全不相关 query 不应误命中 ---
    const r4 = fuseSearch(entries, "区块链智能合约挖矿", 5);
    assert.ok(!r4.some(r => r.entry.id === "e-py" && r.score < 0.3), "不相关 query 不应高分误命中");

    // --- fuseSearch：空库返回空 ---
    assert.deepEqual(fuseSearch([], "anything", 5), [], "空库 fuseSearch 返回空");
    ok("fuseSearch：英文命中/多词覆盖/CJK 子串/不相关过滤/空库");

    // --- checkDuplicates：高度相似应被检出 ---
    const dups = checkDuplicates(entries, "PowerShell 脚本调试", "powershell 命令行 脚本 调试");
    assert.ok(dups.some(d => d.entry.id === "e-ps"), "近似标题/摘要应被去重检测命中");
    assert.ok(dups.find(d => d.entry.id === "e-ps")!.score > 0.5, "重复项相似度应较高");

    // --- checkDuplicates：全新内容不应误报 ---
    const noDups = checkDuplicates(entries, "Rust 异步运行时 tokio 入门", "rust async tokio future 异步");
    assert.ok(!noDups.some(d => d.entry.id === "e-ps" || d.entry.id === "e-mcp"), "无关新记忆不应被判为重复");

    // --- checkDuplicates：空库返回空 ---
    assert.deepEqual(checkDuplicates([], "t", "s"), [], "空库去重返回空");
    ok("checkDuplicates：相似命中/无关不误报/空库");

    // --- grepInEntries：在真实落盘的 entries 正文里全文搜 ---
    const grepHash = "core00cc";
    const fmA: Frontmatter = {
        id: "20260622-000000001-grepa", title: "Grep 测试 A", tags: ["grep"], category: "general",
        created: "2026-06-22T00:00:00.000Z", updated: "2026-06-22T00:00:00.000Z", workspace: "general",
        searchSummary: "摘要里不含关键词",
    };
    writeMemoryFile(grepHash, fmA.id, buildMemoryFile(fmA, "正文第一行\n这一行包含 UNIQUE_NEEDLE 关键词\n正文第三行"));
    const fmB: Frontmatter = {
        id: "20260622-000000002-grepb", title: "Grep 测试 B", tags: ["grep"], category: "general",
        created: "2026-06-22T00:00:00.000Z", updated: "2026-06-22T00:00:00.000Z", workspace: "general",
        searchSummary: "另一条摘要",
    };
    writeMemoryFile(grepHash, fmB.id, buildMemoryFile(fmB, "完全无关的正文内容\n没有目标词"));

    const grepHits = grepInEntries(grepHash, "UNIQUE_NEEDLE");
    assert.equal(grepHits.length, 1, "grep 应命中唯一一条含关键词的记忆");
    assert.equal(grepHits[0].memoryId, "20260622-000000001-grepa", "命中的 memoryId 正确");
    assert.match(grepHits[0].lineContent, /UNIQUE_NEEDLE/u, "命中行内容包含关键词");
    assert.ok(grepHits[0].lineNumber > 0, "命中行号为 1-indexed 正整数");

    // grep 大小写不敏感
    assert.equal(grepInEntries(grepHash, "unique_needle").length, 1, "grep 应大小写不敏感命中");
    // grep 不应命中 frontmatter（摘要/标题在 frontmatter 区域）
    assert.equal(grepInEntries(grepHash, "另一条摘要").length, 0, "grep 不应命中 frontmatter 区域的摘要");
    // grep 无命中返回空
    assert.equal(grepInEntries(grepHash, "绝不存在的词xyz123").length, 0, "grep 无命中返回空数组");
    // grep 空目录返回空
    assert.deepEqual(grepInEntries("nonexistenthash", "x"), [], "grep 不存在的 hash 返回空");
    ok("grepInEntries：正文命中/大小写不敏感/跳过 frontmatter/无命中/空目录");
}

console.log(`\n✅ memory-core 全部通过（${passed} 组断言）：frontmatter 往返、id 防撞、workspaceHash 归一化、ensureWorkspace、checkDuplicates/fuseSearch/grepInEntries`);

// 清理临时库
fs.rmSync(dataRoot, { recursive: true, force: true });
