# MCP-Antigravity

**Custom MCP (Model Context Protocol) Servers** — 为 AI IDE 打造的增强工具集。

最初为 [Antigravity IDE](https://codeium.com) 开发，兼容 Cursor、Trae、Windsurf、VS Code 等支持 MCP 协议的 IDE。

---

## 🛠️ 包含工具

| Server | 版本 | 功能 |
|--------|------|------|
| **[memory-store](./mcp-memory-store/)** | v1.6.0 | AI 跨对话记忆管理（多工作区 / 搜索 / 冷热分层 / AutoSummary / 黄金片段提取） |
| **[sandbox](./mcp-sandbox/)** | v1.5.0 | 代码执行沙箱（硬超时 / 内存限制 / REPL / 并行执行 / Codex CLI / 长任务脱离） |
| **[web-fetcher](./mcp-web-fetcher/)** | v1.0.0 | 网页抓取与交互（截图 / 文本提取 / Cookie 管理 / 文件转换 / AI 摘要 / 录屏） |

另外推荐搭配使用官方公共 MCP Server：
- [`@modelcontextprotocol/server-sequential-thinking`](https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking) — 结构化深度推理

---

## 🚀 快速开始

### 环境要求

- **Node.js 18+**
- npm 或其他包管理器

### 安装

```bash
# 克隆仓库
git clone https://github.com/JuryBu/MCP-Antigravity.git
cd MCP-Antigravity

# 安装各工具依赖
cd mcp-memory-store && npm install && cd ..
cd mcp-sandbox && npm install && cd ..
cd mcp-web-fetcher && npm install && npx playwright install chromium && cd ..
```

### 配置 IDE

在你的 IDE 的 MCP 配置中添加：

```jsonc
{
  "mcpServers": {
    "memory-store": {
      "command": "node",
      "args": ["/path/to/MCP-Antigravity/mcp-memory-store/dist/index.js"]
    },
    "sandbox": {
      "command": "node",
      "args": ["/path/to/MCP-Antigravity/mcp-sandbox/dist/index.js"]
    },
    "web-fetcher": {
      "command": "node",
      "args": ["/path/to/MCP-Antigravity/mcp-web-fetcher/dist/index.js"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

> **配置文件位置因 IDE 而异**：
> - Antigravity: `~/.gemini/antigravity/mcp_config.json`
> - Cursor: `~/.cursor/mcp.json`
> - Windsurf: `~/.codeium/windsurf/mcp_config.json`
> - Trae: 设置面板或 `~/.trae/mcp.json`

---

## 📦 各工具详情

### memory-store — AI 记忆管理系统

让 AI 拥有跨对话的持久记忆。AI 可以主动保存和搜索知识，下次对话自动召回。

**工具列表**：
- `memory_write` / `memory_query` / `memory_read` / `memory_update` / `memory_delete`
- `memory_batch` — 批量操作
- `memory_stats` — 统计/导入/导出/增强

**特性**：多工作区隔离、自然语言搜索、标签过滤、CJK 分词优化、冷热分层归档

### sandbox — 代码执行沙箱

安全执行代码和命令，自带超时保护和内存限制。

**工具列表**：
- `sandbox_exec` — 执行代码/命令（Python/Node/PowerShell/cmd/bash）
- `sandbox_session` — 持久 REPL 会话
- `sandbox_batch` — 并行执行多任务
- `sandbox_status` — 系统状态信息
- `sandbox_codex` — 调用 OpenAI Codex CLI（需额外安装）
- `sandbox_launch` — 长任务脱离执行

### web-fetcher — 网页抓取与交互

使用带 Cookie 的浏览器完成各种网页操作。

**工具列表**：
- 抓取：`web_fetch_page` / `web_fetch_screenshot` / `web_fetch_rich` / `web_fetch_html`
- 提取：`web_extract_links` / `web_extract_tables`
- 交互：`web_interact` / `web_pipeline`
- 文件：`web_download` / `web_convert` / `web_batch_screenshot`
- 其他：`web_login_browser` / `web_record_video` / `web_list_cookies`

---

## ⚠️ IDE 兼容性

| 功能 | 反重力 | Cursor/Trae/其他 |
|------|--------|------------------|
| 核心 MCP 工具 | ✅ | ✅ |
| `conversation_read_original` | ✅ | ❌ 需适配 |
| `conversation_golden_extract` | ✅ | ❌ 需适配 |
| `ai_summary` 模式 | ✅ | ⚡ 自动降级 |
| `sandbox_codex` | ✅ | ⚡ 需安装 Codex CLI |

源码中部分路径硬编码为 `~/.gemini/antigravity/`，非反重力用户需搜索替换后 `npm run build`。

---

## 🔧 开发

```bash
# 修改 TypeScript 源码后重新构建
cd mcp-memory-store && npm run build
cd ../mcp-sandbox && npm run build
cd ../mcp-web-fetcher && npm run build
```

---

## 📄 License

[MIT](./LICENSE)

---

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP 协议规范
- [Playwright](https://playwright.dev/) — 浏览器自动化
- [Fuse.js](https://www.fusejs.io/) — 模糊搜索
