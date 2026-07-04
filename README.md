# MCP-SKILL-RULES Packages

面向 AI 编程环境的可移植 MCP + Skills + Rules 工具包。

这套项目最早来自 Antigravity 内部自用 MCP，现在已经整理成 **Antigravity / Codex / Claude Code（CC）/ Windsurf（WSF）四源兼容、数据互通** 的工具体系。目标是让不同 AI 宿主共享同一套本地能力、同一套记忆/Record 数据和相近的工作习惯。

当前公开快照现在包含 **MCP + Skills + Rules**。`skills/` 收录便携 user-side Codex skills；不包含 `.system` bundled skills、插件缓存、运行态缓存或私有数据。

> 2026-07-04 refresh: latest MCP sources and rules templates are refreshed and privacy-scrubbed; `memory-store` is now `1.17.1`, `sandbox` is `1.13.7`, `web-fetcher` remains `7.0.0`, `mcp-subagent` remains Windsurf-only optional, and `broker` keeps portable path/data-root patches plus upstream request timeout handling.

---

## 核心特点

### 四源数据互通

- 支持 Antigravity、Codex、Claude Code（CC）、Windsurf（WSF）四类宿主。
- 通过共享 HTTP broker 暴露同一组 MCP endpoint。
- 通过统一数据目录让 memory、Record、会话读取、Stage Guard 等能力跨宿主复用。
- 支持 `chain`、`dataChain`、`modelChain`，可以把「对话数据来源」和「模型调用来源」拆开。

常见用法：

- `dataChain="claude-code"`：读取 Claude Code 本地对话数据。
- `dataChain="windsurf"`：读取 Windsurf / Cascade 本地对话数据；本包不提供 `modelChain="windsurf"`。
- `dataChain="codex"`：读取 Codex 本地线程 / JSONL / SQLite 索引。
- `dataChain="antigravity"`：读取 Antigravity Language Server 对话数据。
- `modelChain="codex"`：使用 Codex 模型桥。
- `modelChain="antigravity"`：使用 Antigravity 模型链路。
- `modelChain="claude-code"`：显式调用 Claude Code CLI；默认不建议隐藏式消耗 CC 额度。

### MCP：本地能力层

当前包含三个共享核心 MCP、一个 HTTP broker，以及一个 Windsurf 专属可选 MCP：

| MCP | 当前版本 | 主要能力 |
| --- | --- | --- |
| `memory-store` | `1.17.1` | 记忆库、对话读取、Conversation Export、Record、Golden Extract、Stage Guard、四源数据链路、查询解析/相关性评分、WSF Cascade 路由与本地 fallback |
| `web-fetcher` | `7.0.0` | 无头浏览、网页抓取、截图、交互、登录态、文件读取/转换、多格式视觉检查 |
| `sandbox` | `1.13.7` | 代码执行、持久 REPL、批量任务、长任务托管、智能搜索、Codex/CC 调用、多模型 council、SSRF/注入修复、后台 abort 与 per-task registry |
| `broker` | `0.1.0` | 将 stdio MCP 统一暴露为 Streamable HTTP，供 Codex / Claude Code / Windsurf 等宿主复用 |
| `mcp-subagent` | `0.0.1` | Windsurf 专属异步子代理：spawn / poll / reply / collect / interrupt / dispose；默认不作为四源共享 MCP 启用 |

`mcp-subagent` 需要特别对待：它会通过 Windsurf / Devin Language Server 操作真实 Cascade 对话，属于 WSF 私有自动化能力。源码放在 `mcps/mcp-subagent/`，但默认安装脚本不会自动写入全局 broker 或 Windsurf 配置；需要接收方明确授权后，按 `mcps/mcp-subagent/README.md` 执行 dry-run、备份、apply 和 rollback。

#### memory-store：Conversation / Record / Guard 中枢

`memory-store` 是这套工具的长期记忆和对话数据核心。

重点能力：

- `memory_query` / `memory_write` / `memory_update` / `memory_batch`：跨工作区记忆读写、查询和维护。
- `conversation_read_original`：按 ID、标题、关键词读取 Antigravity / Codex / Claude Code / Windsurf 的原始对话。
- `conversation_golden_extract`：从长对话里提取高价值片段。
- `record_manage`：生成和维护结构化 Record，把长对话沉淀成阶段、输出、风险、验证和经验。
- `stage_guard`：按 `Task.md` 阶段做门禁检查，支持外部证据索引，防止漏做、早报完成、证据不足和 Guard 自指循环。
- 显式 `conversationId` / `ownerId`：让跨宿主、跨对话、后台任务和共享 broker 场景更稳定。
- 查询解析、相关性评分、Windsurf Cascade 多窗口路由和本地 `.pb` fallback：提升跨源对话定位与读取可靠性。

#### web-fetcher：网页、浏览器和本地文件理解

`web-fetcher` 是网页和视觉检查入口。

重点能力：

- 基于 Playwright / Chromium 的无头浏览，适合全网页抓取、截图、页面交互和自动化检查。
- 支持 `web_fetch_page`、`web_fetch_rich`、`web_fetch_screenshot`、`web_interact`、`web_pipeline` 等网页工具。
- 支持登录态、Cookie/localStorage 备份、session 复用和 owner 隔离。
- 支持本地文件和多格式内容检查：HTML、PDF、PPTX、EPUB、Office 转换路径等，具体能力取决于本机依赖。
- 支持 `web_inspect` 做重叠、溢出、可读性、截图和 AI 视觉审查，适合 PPT / 报告 / 网页 UI QA。
- `ai_summary` / `ai_review` 支持 `modelChain`，可在 Antigravity、Codex、Claude Code 间选择模型链路。

#### sandbox：执行、搜索和多模型 council

`sandbox` 是隔离执行与多模型协作层。

重点能力：

- `sandbox_exec`：执行短代码或命令，支持 Python / Node / PowerShell / cmd / bash 等，并包含 code/command 互斥校验回归。
- `sandbox_session`：持久 REPL 会话。
- `sandbox_batch`：批量并行执行任务。
- `sandbox_launch`：长任务脱离执行，日志和状态落盘；per-task registry、cwd 校验、spawn error 落盘和后台 abort 清理更稳。
- `smart_search`：大目录 / 长文件智能搜索，`rg` 探测改为 shellless，降低注入和 ESM 兼容风险。
- `sandbox_codex`：调用 Codex CLI 做后台任务。
- `sandbox_council`：多模型会审，支持 Antigravity、Codex、Claude Code、Gemini CLI、OpenAI/Anthropic/Gemini/custom provider 等路线。
- council 支持大输入分块、复杂文件索引、Gemini CLI / Codex CLI fallback、压力输入超时和参与者/主持人分工。

### Skills：可迁移工作流层

本仓库现在包含 `skills/` 目录，收录从 `%USERPROFILE%/.codex/skills` 复制的便携 user-side skills。

当前 Skills 内容：

- 文档类：当前公开包包含 `pdf`；`docx` / `pptx` / `xlsx` 因本地许可证限制不随 GitHub 包再分发，接收方应自行安装授权版本。
- 设计类：前端设计、画布设计、主题工厂等。
- 工具构建类：MCP 构建、Skill 创建、Playwright / 浏览器测试等。
- 打包边界：不包含 `.system/`、插件缓存、`node_modules`、`dist`、`__pycache__`、生成测试输出、日志、cookies、sessions、auth 文件或本机私有数据。Office skills（`docx` / `pptx` / `xlsx`）因许可证限制排除。

### Rules：让 AI 更像长期协作者

当前 Rules 是「猫娘 / 朋友式协作」版本。核心目标不是角色扮演本身，而是让 AI **说人话、少一点伪人味**：少模板腔、少报告腔、少机械结尾，多自然反馈、边界意识、证据意识和任务收口能力。

Rules 覆盖四个宿主：

- Codex：`rules/codex/AGENTS.template.md`
- Codex 可选 system prompt：`rules/codex/system-prompt.template.md`
- Antigravity：`rules/antigravity/GEMINI.template.md`
- Claude Code（CC）：`rules/claude-code/CLAUDE.template.md`
- Windsurf（WSF）：`rules/windsurf/Windsurf_Global_Rules.template.md`

Rules 主要约束：

- 中文优先、自然口语、降低模板化和伪人味。
- 区分聊天模式和任务模式。
- 更积极但有边界地使用子代理 / council。
- 对复杂任务先读记忆和上下文，必要时更新 Record。
- 对 PPT、文档、网页、UI 等产物做视觉和结构 QA。
- 高风险操作先讲清影响、备份和回滚路径。
- 对 Exa、web-fetcher、sandbox、memory-store 的使用顺序和降级路径做明确约束。

---

## 包含内容

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| MCP servers | `mcps/` | `memory-store`、`web-fetcher`、`sandbox`、可移植 HTTP broker，以及 WSF 专属 `mcp-subagent` |
| Rules 模板 | `rules/` | Codex、Antigravity、Claude Code、Windsurf 四套独立模板 |
| 安装脚本 | `install/` | Windows PowerShell 构建、配置、broker 启停和 smoke test 脚本 |
| 配置模板 | `templates/` | Codex、Antigravity、Claude Code、Windsurf 和环境变量示例 |
| Skills | `skills/` | 便携 user-side Codex skills、README 和 manifest |
| 测试样例 | `design-tests/` | 本地测试页面和 MCP HTTP smoke test 辅助文件 |

## Windows 快速开始

环境要求：

- Node.js 18+
- npm
- PowerShell
- 按需安装 Codex、Antigravity、Claude Code 或 Windsurf

构建并测试：

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
./install/Stop-CodexMcpBroker.ps1
```

如需同时构建 Windsurf 专属 `mcp-subagent` 源码，可运行 `./install/Install-CodexToolkit.ps1 -IncludeWindsurfSubagent`；这个开关只构建源码，不会自动写入 Windsurf 或 broker 配置。

broker 默认暴露以下本地 endpoint：

```text
http://127.0.0.1:14588/memory-store/mcp
http://127.0.0.1:14588/web-fetcher/mcp
http://127.0.0.1:14588/sandbox/mcp
http://127.0.0.1:14588/exa/mcp          # 可选，需要接收方自行配置 Exa URL
```

## 隐私边界

本仓库只应包含源码、模板、文档和测试样例。

不要提交：

- API Key 或带 Key 的远程 MCP URL
- cookies、浏览器 profile、auth 文件、sessions、日志
- 真实 memory-store 数据或 Record 文件
- SQLite 数据库或 JSONL 对话历史
- 本机绝对路径
- 私人账号链接或个人标识信息

发布前建议运行：

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS="<用分号分隔你的私有标记>"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## 仓库结构

```text
.
├─ mcps/
│  ├─ broker/
│  ├─ memory-store/
│  ├─ mcp-subagent/
│  ├─ sandbox/
│  └─ web-fetcher/
├─ rules/
│  ├─ codex/
│  ├─ antigravity/
│  └─ claude-code/
├─ install/
├─ skills/
├─ templates/
├─ design-tests/
├─ PACKAGE_MANIFEST.md
├─ PRIVATE_EXCLUDE_CHECKLIST.md
├─ TOOLKIT_README.md
└─ SETUP.md
```

## License

MIT. See `LICENSE`.

---

# English

Portable MCP + Skills + Rules package for AI coding environments.

This project started as an Antigravity-only internal MCP stack and has now been reorganized into a shared toolkit for **Antigravity / Codex / Claude Code (CC) / Windsurf (WSF) with cross-host data interoperability**. The goal is to let different AI hosts share the same local capabilities, the same memory/Record data, and similar working habits.

The current public snapshot now contains **MCP + Skills + Rules**. `skills/` contains portable user-side Codex skills; it excludes `.system` bundled skills, plugin cache, runtime caches, and private data.

## Key Features

### Cross-host data interoperability

- Supports Antigravity, Codex, Claude Code (CC), and Windsurf (WSF).
- Exposes the same MCP endpoints through a shared HTTP broker.
- Uses a shared data root so memory, Records, conversation reading, and Stage Guard can work across hosts.
- Supports `chain`, `dataChain`, and `modelChain` to split default routing, conversation data source, and model-call route.

Common examples:

- `dataChain="claude-code"`: read Claude Code local conversation data.
- `dataChain="windsurf"`: read Windsurf / Cascade local conversation data; this package does not expose `modelChain="windsurf"`.
- `dataChain="codex"`: read Codex local thread / JSONL / SQLite index data.
- `dataChain="antigravity"`: read Antigravity Language Server conversation data.
- `modelChain="codex"`: use the Codex model bridge.
- `modelChain="antigravity"`: use the Antigravity model route.
- `modelChain="claude-code"`: explicitly use Claude Code CLI; hidden automatic CC quota usage is intentionally avoided by default.

### MCP: local capability layer

| MCP | Version | Main capabilities |
| --- | --- | --- |
| `memory-store` | `1.17.1` | Memory, conversation reading, Conversation Export, Records, Golden Extract, Stage Guard, four-source data chains, query parsing / relevance scoring, WSF Cascade routing, and local fallback |
| `web-fetcher` | `7.0.0` | Headless browsing, web fetch, screenshots, interactions, login state, local file / multi-format inspection |
| `sandbox` | `1.13.7` | Code execution, persistent REPL, batch jobs, long-running tasks, smart search, Codex/CC calls, multi-model council, SSRF/injection fixes, background abort, and per-task registry |
| `broker` | `0.1.0` | Exposes stdio MCP servers as Streamable HTTP endpoints for Codex / Claude Code / Windsurf and other hosts |
| `mcp-subagent` | `0.0.1` | Windsurf-only async sub-agents: spawn / poll / reply / collect / interrupt / dispose; not enabled as a default shared MCP |

`mcp-subagent` is special: it operates real Windsurf / Devin Cascade conversations through the local Language Server. The source is included under `mcps/mcp-subagent/`, but the default installer does not automatically patch the shared broker or Windsurf config. Receivers should follow `mcps/mcp-subagent/README.md` and run dry-run, backup, apply, and rollback steps only with explicit local authorization.

#### memory-store: Conversation / Record / Guard hub

`memory-store` is the long-term memory and conversation-data core.

Highlights:

- `memory_query` / `memory_write` / `memory_update` / `memory_batch`: workspace-aware memory operations.
- `conversation_read_original`: read original conversations by ID, title, or keyword across Antigravity / Codex / Claude Code / Windsurf.
- `conversation_golden_extract`: extract high-value snippets from long conversations.
- `record_manage`: generate and maintain structured Records with phases, outputs, risks, verification, and lessons.
- `stage_guard`: stage-level guardrails for `Task.md` workflows with external evidence indexing, preventing missing work, premature completion reports, weak evidence, and self-referential guard loops.
- Explicit `conversationId` / `ownerId`: stabilizes cross-host, cross-conversation, background-task, and shared-broker usage.
- Query parsing, relevance scoring, Windsurf Cascade multi-window routing, and local `.pb` fallback improve cross-source conversation lookup and reads.

#### web-fetcher: web, browser, and local file understanding

Highlights:

- Playwright / Chromium based headless browsing for web fetch, screenshots, page interactions, and automated checks.
- Tools such as `web_fetch_page`, `web_fetch_rich`, `web_fetch_screenshot`, `web_interact`, and `web_pipeline`.
- Login state, Cookie/localStorage backup, session reuse, and owner isolation.
- Local file and multi-format inspection support: HTML, PDF, PPTX, EPUB, and Office conversion paths where local dependencies are available.
- `web_inspect` for overlap, overflow, readability, screenshot, and AI visual review, useful for PPT / reports / web UI QA.
- `ai_summary` / `ai_review` with `modelChain` support across Antigravity, Codex, and Claude Code; Windsurf is currently data-chain oriented.

#### sandbox: execution, search, and multi-model council

Highlights:

- `sandbox_exec`: run short code or commands, including Python / Node / PowerShell / cmd / bash, with code/command mutex regression coverage.
- `sandbox_session`: persistent REPL sessions.
- `sandbox_batch`: parallel batch execution.
- `sandbox_launch`: detached long-running tasks with logs and status on disk; per-task registry, cwd validation, spawn-error persistence, and background abort cleanup are improved.
- `smart_search`: smart search over large directories or long files; `rg` probing is shellless for safer ESM/runtime behavior.
- `sandbox_codex`: background tasks through Codex CLI.
- `sandbox_council`: multi-model council with Antigravity, Codex, Claude Code, Gemini CLI, OpenAI/Anthropic/Gemini/custom providers.
- Council support for large-input chunking, complex-file indexing, Gemini CLI / Codex CLI fallback, pressure timeouts, and moderator/participant separation.

### Skills: portable workflow layer

This repository now includes a `skills/` directory copied from portable user-side `%USERPROFILE%/.codex/skills` entries.

Planned Skill directions:

- Document workflows: this public package includes `pdf`; `docx` / `pptx` / `xlsx` are excluded from GitHub redistribution because their local licenses restrict copying, so receivers should install licensed equivalents themselves.
- Design workflows: frontend design, canvas design, theme factory.
- Tool-building workflows: MCP builder, skill creator, Playwright / browser testing.
- Packaging boundary: excludes `.system/`, plugin cache, `node_modules`, `dist`, `__pycache__`, generated test outputs, logs, cookies, sessions, auth files, and local private data. Office skills (`docx` / `pptx` / `xlsx`) are excluded due to redistribution restrictions.

### Rules: making AI a better long-term collaborator

The current Rules are a catgirl / friendly-collaborator variant. The point is not roleplay for its own sake; the practical goal is to make AI agents **sound more human and less uncanny or template-like**, while preserving directness, evidence discipline, boundary awareness, and useful progress updates.

Rules cover:

- Codex: `rules/codex/AGENTS.template.md`
- Optional Codex system prompt: `rules/codex/system-prompt.template.md`
- Antigravity: `rules/antigravity/GEMINI.template.md`
- Claude Code (CC): `rules/claude-code/CLAUDE.template.md`
- Windsurf (WSF): `rules/windsurf/Windsurf_Global_Rules.template.md`

Rules mainly define:

- Chinese-first, natural conversation style with fewer template-like reports.
- Chat mode vs task mode distinction.
- More proactive but bounded subagent / council usage.
- Memory and context lookup before complex work, with Record updates when useful.
- Visual and structural QA for PPT, documents, webpages, and UI artifacts.
- High-risk operation boundaries: explain impact, backup, and rollback first.
- Clear tool usage and fallback rules for Exa, web-fetcher, sandbox, and memory-store.

## Included

| Area | Path | Notes |
| --- | --- | --- |
| MCP servers | `mcps/` | `memory-store`, `web-fetcher`, `sandbox`, a portable HTTP broker, and WSF-only `mcp-subagent` |
| Host rules | `rules/` | Separate templates for Codex, Antigravity, Claude Code, and Windsurf |
| Install scripts | `install/` | Windows PowerShell scripts for build, config, broker lifecycle, and smoke tests |
| Config templates | `templates/` | Codex, Antigravity, Claude Code, Windsurf, and environment examples |
| Skills | `skills/` | Portable user-side Codex skills, README, and manifest |
| Smoke tests | `design-tests/` | Local pages and MCP HTTP smoke test helpers |

## Quick Start On Windows

Requirements:

- Node.js 18+
- npm
- PowerShell
- Codex, Antigravity, Claude Code, or Windsurf depending on your target host

Build and smoke test:

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
./install/Stop-CodexMcpBroker.ps1
```

To also build the Windsurf-only `mcp-subagent` source, run `./install/Install-CodexToolkit.ps1 -IncludeWindsurfSubagent`; it only builds source and does not auto-patch Windsurf or broker config.

Default broker endpoints:

```text
http://127.0.0.1:14588/memory-store/mcp
http://127.0.0.1:14588/web-fetcher/mcp
http://127.0.0.1:14588/sandbox/mcp
http://127.0.0.1:14588/exa/mcp          # optional, requires receiver-side Exa URL
```

## Privacy Boundary

This repository should only contain source code, templates, docs, and test samples.

Do not commit:

- API keys or remote MCP URLs with embedded keys
- cookies, browser profiles, auth files, sessions, or logs
- real memory-store data or Record files
- SQLite databases or JSONL conversation histories
- machine-specific absolute paths
- private account links or personal identifiers

Recommended pre-publish check:

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS="<private markers separated by semicolons>"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## Repository Layout

```text
.
├─ mcps/
│  ├─ broker/
│  ├─ memory-store/
│  ├─ mcp-subagent/
│  ├─ sandbox/
│  └─ web-fetcher/
├─ rules/
│  ├─ codex/
│  ├─ antigravity/
│  └─ claude-code/
├─ install/
├─ skills/
├─ templates/
├─ design-tests/
├─ PACKAGE_MANIFEST.md
├─ PRIVATE_EXCLUDE_CHECKLIST.md
├─ TOOLKIT_README.md
└─ SETUP.md
```

## License

MIT. See `LICENSE`.
