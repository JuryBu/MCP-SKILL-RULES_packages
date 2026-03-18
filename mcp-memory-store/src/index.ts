#!/usr/bin/env node
/**
 * MCP Memory Store Server v1.6
 * 
 * AI 主动记忆管理系统，支持多工作区、冷热分层、置顶记忆、批量操作、对话原文阅读、
 * Auto Summary 双轨制、黄金片段提取。
 * 
 * v1.6: 进程生命周期升级 — 与 LS 同生共死 + 注册表加速 + 三步查找
 * 
 * 10 个 MCP 工具：
 *   - memory_write: 写入新记忆（含去重检测 + autoSummary 异步生成）
 *   - memory_query: 查询记忆（fuse.js + grep + 三档 depth + autoSummary 搜索）
 *   - memory_read: 读取单条记忆（支持行范围）
 *   - memory_update: 更新/追加记忆（内容变化自动重生成 autoSummary）
 *   - memory_delete: 删除记忆
 *   - memory_batch: 批量操作
 *   - memory_stats: 统计/归档/导出/导入/enhance 批量增强
 *   - conversation_read_original: 读取对话原文（绕过上下文压缩）
 *   - conversation_golden_extract: 黄金片段提取（对话关键信息 + 记忆去重）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getIdleTime, logStdinEvent, touchActivity, isParentAlive } from "./lifecycle.js";
import { ensureDataDirs } from "./store.js";
import { cleanOldTempFiles, ensureTempDir } from "./temp-store.js";
import { initParentLs } from "./ls-client.js";
import { cleanupRegistryOnExit } from "./ls-registry.js";

// 工具注册
import { registerWrite } from "./tools/write.js";
import { registerQuery } from "./tools/query.js";
import { registerRead } from "./tools/read.js";
import { registerUpdate } from "./tools/update.js";
import { registerDelete } from "./tools/delete.js";
import { registerBatch } from "./tools/batch.js";
import { registerStats } from "./tools/stats.js";
import { registerConversation } from "./tools/conversation.js";
import { registerGoldenExtract } from "./tools/golden-extract.js";

// === 进程生命周期 ===
let isClosing = false; // 防止重复清理

// 创建 MCP Server 实例
const server = new McpServer({
    name: "memory-store-mcp-server",
    version: "1.6.0",
});

// 注册所有 10 个工具
registerWrite(server);
registerQuery(server);
registerRead(server);
registerUpdate(server);
registerDelete(server);
registerBatch(server);
registerStats(server);
registerConversation(server);
registerGoldenExtract(server);

// === 使用指南 Resource ===
server.registerResource(
    "guide",
    "memory-store://guide",
    {
        description: "Memory Store MCP 完整使用指南",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "memory-store://guide",
                text: `# MCP Memory Store v1.5.0 使用指南

## 快速开始
- 新对话开始: memory_query() 或 memory_query(workspace="工作区路径") 获取背景
- 全局概览: memory_query(scope="global") 查看所有工作区
- 写入记忆: memory_write(title, content, searchSummary, tags, workspace)

## 7 个工具

### memory_write — 写入新记忆
- searchSummary 应由 AI 精心撰写，包含关键词、近义词、技术栈名称
- 自动检测相似记忆并提醒（不阻止写入）
- workspace 不传则归入 general 通用记忆
- pinned: 置顶标记（每个工作区/general 建议最多 3 条）
- ID 格式: YYYYMMDD-HHmmssSSS-slug（含毫秒，降低批量碰撞风险）

### memory_query — 查询记忆
- query: 模糊搜索 title+searchSummary+tags（搜索引擎 v2：多词分词+子串匹配+CJK 支持）
- grep: 正文精确搜索
- depth: index(默认) / summary / full(写临时文件返回路径)
- scope: workspace(默认) / global（全局查询支持跨工作区全文读取）
- tags/category: 过滤
- after/before: 时间范围过滤（ISO格式或YYYY-MM-DD，基于 updatedAt）
- 无参调用: 展示概览（📌置顶记忆 + 🕐最近记忆，总上限10条）
- 跨域推荐: 在工作区概览底部提示 general 置顶记忆数量

### memory_read — 读取单条
- startLine/endLine: 行范围读取
- 无范围: 写临时文件返回路径（节省上下文，需用 view_file 读取）

### memory_update — 更新/追加
- content: 替换全部正文
- append: 追加到末尾（自动加时间戳分隔线）
- tags: 合并到已有标签（不覆盖）
- removeTags: 移除指定标签
- category: 修改分类(problem-solution/technical-note/conversation/general)
- pinned: 设置/取消置顶
- title/searchSummary: 更新元信息

### memory_delete — 删除单条

### memory_batch — 批量操作（最多20个）
- 支持 write/read/query/update/delete 混合
- query 支持 query(模糊) 和 grep(精确) 两种

### memory_stats — 系统管理
- overview: 全局统计（默认）
- detail: 工作区详情
- gc: 清理临时文件+卸载缓存+孤儿工作区检测
- archive/unarchive: 冷工作区归档/解归档（gzip压缩，含路径安全校验）
- export: 导出记忆为 .gz（支持 workspace/ids 过滤，含已归档正文）
- import: 导入 .gz 恢复记忆（自动去重，按 updatedAt 比较新旧）

## 时间戳体系
- created/updated: 记忆 frontmatter 中自动记录
- lastAccessed: 索引中的最后访问时间
- append 追加: 正文中插入中文时间戳分隔线
- 查询过滤: 用 after/before 参数按 updatedAt 过滤

## 置顶记忆 (v1.1+)
- write/update 支持 pinned 参数
- 概览中 📌 置顶记忆始终显示在最前面（无论多老）
- 每个工作区/general 建议最多 3 条置顶
- AI 应持续维护置顶记忆，将核心知识浓缩在其中
- 跨域推荐: 工作区概览底部提示 general 是否有置顶记忆

## 最佳实践
1. 新对话优先 memory_query 获取背景（先看置顶记忆）
2. searchSummary 写好关键词（比正文更影响命中率）
3. 旧项目看到「工作记忆」文件夹时读取其中内容，考虑迁移到 MCP
4. 单条上限 15KB，建议按主题拆分多条
5. 对话结束前用 memory_write/update 持久化关键信息
6. 为项目/general 维护 1-3 条置顶精华记忆（17+1 模型）
7. 恢复状态时用 depth=summary 而非 full，避免上下文浪费

### conversation_read_original — 读取对话原文 (v1.4+)
- 绕过 CHECKPOINT 压缩机制，读取对话的真实完整内容
- 三种模式：fetch(拉取缓存) / search(关键词搜索) / read(范围阅读)
- 三级详细度：brief(截断100字) / normal(完整文本) / full(含思考+工具结果)
- conversationId 不填默认当前对话（最常见场景：恢复被压缩的上下文）
- extraTypes: 额外拉取 thinking/tool_results/code_actions/code_diffs/file_views
- 通过 Language Server 本地 API 获取解密数据，无需手动解密 .pb 文件

### Auto Summary 双轨制 (v1.5+)
- memory_write 的 searchSummary 参数现在是可选的
- 写入后系统自动用 Gemini 3 Flash 生成 autoSummary（异步，不阻塞返回）
- 搜索时 autoSummary 和 searchSummary 合并匹配，大幅提升检索召回率
- memory_update 修改 content/append 时自动重新生成 autoSummary
- memory_stats(action="enhance"): 批量为所有缺少 autoSummary 的老记忆生成
- 需要 LS 可用（IDE 运行中），LS 不可用时静默跳过

### conversation_golden_extract — 黄金片段提取 (v1.5+)
- 从对话中提取关键决策、发现、踩坑经验
- 自动与现有记忆对比去重：标注已有/疑似重复/全新
- 参数: conversationId（可选）、stepStart/stepEnd（范围）、autoCompare（默认true）
- 帮助发现对话中值得持久化但尚未保存的知识`,
                mimeType: "text/plain",
            },
        ],
    })
);

// === stdin 断开检测（第一层防线，秒级响应）===
process.stdin.on("end", async () => {
    if (isClosing) return;
    isClosing = true;
    logStdinEvent("stdin END event — 管道断裂");
    cleanupRegistryOnExit();
    await cleanup();
    process.exit(0);
});

process.stdin.on("close", async () => {
    if (isClosing) return;
    isClosing = true;
    logStdinEvent("stdin CLOSE event");
    cleanupRegistryOnExit();
    await cleanup();
    process.exit(0);
});

process.stdin.on("error", async (err) => {
    if (isClosing) return;
    isClosing = true;
    logStdinEvent(`stdin ERROR: ${err.message}`);
    cleanupRegistryOnExit();
    await cleanup();
    process.exit(0);
});

// === ppid 存活检测（第二层防线，30s 内响应）===
const heartbeatInterval = setInterval(async () => {
    if (!isParentAlive()) {
        if (isClosing) return;
        isClosing = true;
        logStdinEvent(`父 LS (PID=${process.ppid}) 已消失，自动退出`);
        console.error(`[memory-store] 父 LS (PID=${process.ppid}) 已消失，自动退出`);
        cleanupRegistryOnExit();
        await cleanup();
        process.exit(0);
    }
}, 30000); // 30s 检测间隔

heartbeatInterval.unref();

// === 启动 ===
async function main(): Promise<void> {
    console.error("[memory-store] MCP Server v1.6.0 启动中...");
    logStdinEvent("STARTED");

    // 初始化数据目录
    ensureDataDirs();

    // 初始化临时文件目录 + 清理过期文件
    ensureTempDir();
    cleanOldTempFiles();

    // 异步初始化父 LS 连接（不阻塞工具注册）
    initParentLs().catch(err => {
        console.error("[memory-store] 父 LS 初始化异常:", err);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("[memory-store] MCP Server v1.6.0 已启动，等待连接...");
}

main().catch((error) => {
    console.error("[memory-store] 启动失败:", error);
    process.exit(1);
});

// === 优雅关闭 ===
const cleanup = async () => {
    console.error("[memory-store] 正在关闭...");
    clearInterval(heartbeatInterval);
};

process.on("SIGINT", async () => {
    if (isClosing) return;
    isClosing = true;
    cleanupRegistryOnExit();
    await cleanup();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    if (isClosing) return;
    isClosing = true;
    cleanupRegistryOnExit();
    await cleanup();
    process.exit(0);
});
