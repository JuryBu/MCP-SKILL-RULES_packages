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
export {};
//# sourceMappingURL=index.d.ts.map