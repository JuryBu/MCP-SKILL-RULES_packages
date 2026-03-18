# MCP Tools 配置指南

> **版本**: memory-store v1.6.0 · sandbox v1.5.0 · web-fetcher v1.0.0
> **更新日期**: 2026-03-18

本文件夹包含 **3 个自建 MCP Server** + **1 个公共 MCP Server** 配置指引。

---

## 📦 工具概览

| 工具 | 目录 | 功能 |
|------|------|------|
| **memory-store** v1.6 | `mcp-memory-store/` | AI 跨对话记忆（读写/搜索/多工作区/AutoSummary/黄金片段提取） |
| **sandbox** v1.5 | `mcp-sandbox/` | 代码执行沙箱（硬超时/内存限制/REPL/并行/Codex CLI/长任务脱离） |
| **web-fetcher** | `mcp-web-fetcher/` | 网页抓取与交互（截图/文本/Cookie/Office转换/AI摘要） |
| **sequential-thinking** | _(npm 包)_ | 结构化深度推理（`npx -y @modelcontextprotocol/server-sequential-thinking`） |

---

## 🚀 安装三步走

### 1. 确保 Node.js 18+

```bash
node --version  # 需要 >= 18
```

### 2. 安装依赖

```bash
cd mcp-memory-store && npm install
cd ../mcp-sandbox && npm install
cd ../mcp-web-fetcher && npm install && npx playwright install chromium
```

### 3. 配置你的 IDE

在 IDE 的 MCP 配置中添加（以 JSON 格式为例，路径需替换为实际绝对路径）：

```json
{
  "mcpServers": {
    "memory-store": {
      "command": "node",
      "args": ["<绝对路径>/mcp-memory-store/dist/index.js"]
    },
    "sandbox": {
      "command": "node",
      "args": ["<绝对路径>/mcp-sandbox/dist/index.js"]
    },
    "web-fetcher": {
      "command": "node",
      "args": ["<绝对路径>/mcp-web-fetcher/dist/index.js"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

---

## 🔧 各 IDE 配置位置

| IDE | 配置文件位置 | 备注 |
|-----|-------------|------|
| **Antigravity (反重力)** | `~/.gemini/antigravity/mcp_config.json` | 原生完全支持 |
| **Cursor** | `~/.cursor/mcp.json`（全局）或 `.cursor/mcp.json`（项目） | 需 Agent 模式 |
| **Trae** | 设置面板 → MCP Servers 或 `~/.trae/mcp.json` | 路径因版本而异 |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | 需确认路径 |
| **VS Code** | 取决于 MCP 扩展，通常在扩展设置中 | 需安装 MCP 支持扩展 |

> [!TIP]
> **非反重力用户**：配置文件位置可能随 IDE 版本变化，建议让 AI 在本机搜索 `mcp` 相关 JSON 文件来定位。

---

## ⚠️ 重要兼容性说明

### 所有 IDE 通用

- ✅ **sandbox** 全部 6 个工具在所有 IDE 下可用
- ✅ **memory-store** 核心记忆功能（write/query/read/update/delete/batch/stats）全部可用
- ✅ **web-fetcher** 全部工具可用（需先 `npx playwright install chromium`）
- ✅ **sequential-thinking** 全部可用（公共 npm 包）

### 仅反重力 IDE 可用的功能

| 功能 | 工具 | 原因 | 替代方案 |
|------|------|------|---------|
| `conversation_read_original` | memory-store | 依赖反重力 Language Server RPC | 禁用或适配你 IDE 的 API |
| `conversation_golden_extract` | memory-store | 同上 | 同上 |
| `ai_summary` 输出模式 | web-fetcher | 依赖反重力 LS 内置 Flash 模型 | 自动降级为 compact 模式 |
| `sandbox_codex` | sandbox | 依赖 Codex CLI 安装 | 安装 `npm i -g @openai/codex` + API Key |

### 需要自行适配的路径

源码中硬编码了 `~/.gemini/antigravity/` 路径，**非反重力用户需修改后重新构建**：

```bash
# 搜索所有硬编码路径
grep -rn ".gemini/antigravity" */src/

# 修改后重新构建
cd mcp-memory-store && npm run build
cd ../mcp-sandbox && npm run build
cd ../mcp-web-fetcher && npm run build
```

> [!TIP]
> 可以直接让 AI 帮你：「搜索所有源码中的 `.gemini/antigravity` 路径，替换为 `<你选择的路径>`，然后 `npm run build`」

### web-fetcher 登录态

Cookie **不可移植**，每个用户需自行用 `web_login_browser` 登录各平台。

---

## ❓ 快速排障

| 问题 | 解决 |
|------|------|
| 工具无法连接 | 确认 `dist/index.js` 存在，终端手动 `node dist/index.js` 测试 |
| 修改源码没生效 | 修改 `.ts` 后必须 `npm run build` |
| Playwright 安装失败 | 国内用户设置 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright` |
| sharp 安装失败 | `npm install --ignore-scripts` 再 `npx sharp install` |
| sandbox 执行超时 | 调大 `timeout` 参数（最大 300000ms） |
