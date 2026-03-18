# MCP Memory Store v1.6

AI 主动记忆管理系统 + 对话原文阅读器 + Auto Summary + 黄金片段提取，基于 MCP (Model Context Protocol) 实现。

## 功能

- **多工作区记忆管理**：按工作区隔离，支持跨工作区发现
- **智能搜索引擎**：fuse.js 模糊匹配 + 标签过滤 + 全文 grep
- **三档深度控制**：index / summary / full，最小化上下文占用
- **冷热分层**：LRU 索引缓存 + 冷工作区归档
- **批量操作**：一次调用多个 write/read/query/update/delete
- **内置去重**：写入时自动检测相似记忆
- **置顶记忆**：每个工作区 3 条置顶精华，概览优先显示
- **对话原文读取** (v1.4+)：绕过 CHECKPOINT 压缩，通过 LS API 读取对话完整内容
- **Auto Summary 双轨制** (v1.5+)：AI 手写 searchSummary + Flash 自动生成 autoSummary，双路搜索提升召回率
- **黄金片段提取** (v1.5+)：从对话中提取关键决策、发现、踩坑经验，与现有记忆自动去重
- **与 LS 同生共死** (v1.6+)：MCP 进程绑定父 LS，窗口开着永不超时，窗口关闭 30s 内自动退出
- **LS 注册表加速** (v1.6+)：跨窗口 LS 发现从 PowerShell 全量扫描 (2-5s) 降至注册表查询 (~5ms)
- **三步查找路由** (v1.6+)：父 LS 直连 → 注册表 → PowerShell 兜底，跨窗口对话读取零额外延迟

## 10 个 MCP 工具

| 工具 | 说明 |
|------|------|
| `memory_write` | 写入新记忆（含去重检测 + autoSummary 异步生成） |
| `memory_query` | 查询记忆（fuse.js + grep + 三档 depth + autoSummary 搜索） |
| `memory_read` | 读取单条记忆（支持行范围） |
| `memory_update` | 更新/追加记忆（内容变化自动重生成 autoSummary） |
| `memory_delete` | 删除记忆 |
| `memory_batch` | 批量操作（最多 20 个） |
| `memory_stats` | 统计/归档/导出/导入/enhance 批量增强 |
| `conversation_read_original` | 读取对话原文（fetch/search/read 三模式） |
| `conversation_golden_extract` | 黄金片段提取（对话关键信息 + 记忆去重对比） |

## 目录结构

```
mcp-memory-store/         ← MCP 服务代码
├── src/
│   ├── index.ts          ← 入口 + 进程管理（v1.6.0 ppid 绑定）
│   ├── store.ts          ← 存储引擎（含 autoSummary 字段）
│   ├── search.ts         ← 搜索引擎（fuse.js + autoSummary）
│   ├── cache.ts          ← LRU 索引缓存
│   ├── lifecycle.ts      ← 进程生命周期（isParentAlive ppid 检测）
│   ├── temp-store.ts     ← 临时文件管理
│   ├── ls-client.ts      ← LS 通信 + 三步查找路由（v1.6 重构）
│   ├── ls-registry.ts    ← LS 注册表（v1.6 新增，跨窗口加速）
│   ├── trajectory.ts     ← 对话数据解析（v1.4+）
│   └── tools/
│       ├── write.ts          ← 写入 + 异步 autoSummary
│       ├── query.ts
│       ├── read.ts
│       ├── update.ts         ← 更新 + autoSummary 重生成
│       ├── delete.ts
│       ├── batch.ts
│       ├── stats.ts          ← 统计 + enhance 批量增强
│       ├── conversation.ts   ← 对话原文读取（v1.4+）
│       └── golden-extract.ts ← 黄金片段提取（v1.5+）
├── dist/                 ← 编译输出
└── 工作记忆/              ← 开发过程工作记忆（旧版）

memory-store/             ← 记忆数据（分离存储）
├── _global_index.json
├── config.json
├── ls-registry.json      ← LS 注册表（v1.6 新增）
├── temp/
├── workspaces/
│   └── {hash}/
└── general/
```

## 开发

```bash
npm install
npm run build
```

## 配置

在 `~/.gemini/antigravity/mcp_config.json` 中添加：

```json
{
  "memory-store": {
    "command": "node",
    "args": ["C:\\Users\\Stardust\\.gemini\\antigravity\\mcp-memory-store\\dist\\index.js"],
    "env": {},
    "disabled": false
  }
}
```
