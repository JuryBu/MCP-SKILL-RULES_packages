# MCP-SKILL-RULES Packages

面向 Windows AI 编程环境的可移植 MCP、Skills 与 Rules 工具包。

这套项目最初用于 Antigravity，后来扩展为 Codex、Claude Code 与 Windsurf 共用同一套 MCP 源码、数据目录约定和模型路由。当前版本同时保留「单独安装一个宿主也能使用」与「多个宿主共享数据」两种模式。

> 2026-07-11 refresh：memory-store 1.19.3、sandbox 1.14.0、web-fetcher 7.0.0、portable broker 0.1.0、Windsurf-only subagent 1.1.0。

## 这套工具解决什么问题

- 同一台电脑上的 Codex、Antigravity、Claude Code、Windsurf 可以访问同一份便携 MCP 数据，而不需要复制多套记忆库。
- `dataChain` 负责选择对话数据来源，`modelChain` 负责选择执行摘要、审查或搜索的模型，两者可以分开。
- 只有 Codex 时也能运行，默认数据写入 `%USERPROFILE%\.codex-toolkit`，不会依赖 Antigravity 目录。
- 安装多个宿主后，可按能力启用跨宿主对话读取与模型 fallback；缺失的宿主不会被伪装成可用。
- 公开包只包含源码、模板、说明和测试，不包含登录态、真实记忆、对话、密钥、日志或数据库。

## 当前组件

| 组件 | 版本 | 主要用途 |
| --- | ---: | --- |
| `memory-store` | 1.19.3 | 记忆、Conversation、Record、Golden Extract、Stage Guard、后台任务与跨宿主路由 |
| `sandbox` | 1.14.0 | 隔离执行、持久会话、批处理、智能搜索、Codex 任务与多模型 Council |
| `web-fetcher` | 7.0.0 | 无头浏览、登录态浏览、本地多格式文件、截图、视觉检查与桌面交互 |
| `broker` | 0.1.0 | 将本地 stdio MCP 暴露为稳定的 Streamable HTTP endpoint |
| `mcp-subagent` | 1.1.0 | Windsurf Cascade 专属异步子代理控制器，可选安装 |

## 重点能力

### memory-store：Conversation 与 Record 系列

- `conversation_read_original` 可列出、定位、搜索、分轮读取和导出 Codex、Antigravity、Claude Code、Windsurf 对话。
- `conversation_golden_extract` 从长对话中提取可复用的高价值片段。
- `record_manage` 维护结构化工作记录，支持读取视图、阶段更新、所有权审计与后台生成。
- `stage_guard` 在阶段结束前对照 Plan、Task 和执行证据检查是否漏项。
- 后台任务支持稳定 `taskId`、取消、重启恢复、进度查询和并发控制。
- Grok / ProGrok 是可选模型链路，只负责模型调用，不读取对话数据；`auto` 不可用时会按工具允许的顺序 fallback。

### web-fetcher：网页、文件与视觉检查

- 可抓取公开网页，也可通过接收方自己的浏览器 profile 使用已登录站点。
- 支持 HTML、PDF、DOCX、PPTX、XLSX、EPUB、图片等本地文件的读取与转换流程。
- `web_fetch_screenshot`、`web_inspect` 可检查重叠、溢出、可读性和页面结构。
- `web_interact`、`web_pipeline` 支持持久 session、点击、输入、DOM 检查和批量流水线。
- desktop 工具可连接 Electron / Chromium / CEF 应用进行调试和截图。

### sandbox：执行、搜索与 Council

- `sandbox_exec`、`sandbox_batch`、`sandbox_session`、`sandbox_launch` 覆盖短代码、并行任务、持久会话和后台进程。
- `smart_search` 提供精确、模糊和模型语义搜索，可选择 Grok、Antigravity、Codex 或显式 Claude Code 模型链路。
- `sandbox_council` 让多个模型独立审议同一问题，支持文件和图片输入、后台任务、owner 隔离与 provider fallback。
- 公开版 ProGrok 集成只连接接收方已经运行的 OpenAI-compatible API，不安装、不启动、不 patch ProGrok。

### HTTP broker

默认监听 `127.0.0.1:14588`，提供：

- `/memory-store/mcp`
- `/web-fetcher/mcp`
- `/sandbox/mcp`
- `/playwright/mcp`
- `/sequential-thinking/mcp`
- `/exa/mcp`，仅在接收方配置 Exa remote URL 时可用
- `/subagent/mcp`，仅适用于已安装并登录 Windsurf 的接收方

broker 会为普通请求使用 120 秒默认超时，并根据工具参数中的 `waitSeconds` / `timeout` 放宽长任务等待，上限默认 30 分钟。状态文件在退出、`SIGBREAK` 和 `beforeExit` 时尽力落盘。

### Rules：四宿主的人类化工作规则

Rules 保留了猫娘式自然表达、少汇报腔、解释技术概念、Plan / Task / Stage Guard、子代理证据、Office 视觉验收和隐私边界等工作习惯，目标是让 AI 说人话并减少模板化伪人感。

| 宿主 | 模板 |
| --- | --- |
| Codex | `rules/codex/AGENTS.template.md` 与可选 `system-prompt.template.md` |
| Antigravity | `rules/antigravity/GEMINI.template.md` |
| Claude Code | `rules/claude-code/CLAUDE.template.md` |
| Windsurf | `rules/windsurf/global_rules.template.md` 与五个 `system_rules` 分片 |

Rules 已删除生日、学业、账号链接、登录态、本机路径、真实服务额度和私人项目上下文。接收方应根据自己的环境再修改。

### Skills：完整的可迁移技能包

`skills/` 当前包含 16 个经过 allow-list 筛选的用户侧技能。`install/Test-CodexToolkit.ps1 -PackageClean` 会逐个检查技能目录、`SKILL.md` 和 manifest，避免压缩包漏掉 Skills。

没有打包 Codex `.system` 技能、插件缓存、运行产物，以及本机许可证不允许再分发的 Office skills。详情见 `skills/skills_manifest.md`。

## 快速安装

要求：Windows、PowerShell、Node.js 18 或更高版本。

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
./install/Apply-CodexConfig.ps1
./install/Test-CodexToolkit.ps1
```

构建 Windsurf 专属 subagent：

```powershell
./install/Install-CodexToolkit.ps1 -IncludeWindsurfSubagent
```

它不会自动修改 Windsurf 或其他宿主配置。请按 `mcps/mcp-subagent/README.md` 单独部署。

完整步骤见 `SETUP.md`，接收方快速说明见 `TOOLKIT_README.md`。

## Grok / ProGrok 配置边界

本仓库不包含 ProGrok 程序、上游账号或 API Key。接收方需要自行运行兼容 OpenAI Chat Completions 的本地 proxy，并在私有环境中设置：

```powershell
$env:MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:18645"
$env:MEMORY_STORE_GROK_API_KEY = "<receiver-private-key>"
$env:SANDBOX_PROGROK_BASE_URL = "http://127.0.0.1:18645"
$env:SANDBOX_PROGROK_API_KEY = "<receiver-private-key>"
```

不要把真实值写入仓库、共享 zip 或 Rules。

## 打包与隐私检查

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS = "C:\\Users\\YourName;your-account-link;your-private-marker"
./install/Test-CodexToolkit.ps1 -PackageClean
./install/New-PortableToolkitPackage.ps1 -OutputDirectory "D:\releases\toolkit"
```

打包脚本会验证 MCP、Rules、Skills、配置模板和禁止文件，再创建 zip 与 SHA256。它不会复制 `.git`、`node_modules`、`dist`、浏览器 profile、sessions、日志、SQLite、真实 memory 或私有 env。

## 仓库结构

```text
mcps/          portable MCP source and broker
rules/         Codex / Antigravity / Claude Code / Windsurf templates
skills/        allow-listed portable skills
install/       build, config, broker, validation, packaging scripts
templates/     host config and environment examples
design-tests/  local pages and smoke-test helpers
```

---

# English

Portable MCP, Skills, and Rules toolkit for Windows AI coding environments.

The project started as an Antigravity toolset and now supports Codex, Antigravity, Claude Code, and Windsurf. A single host can run independently with data under `%USERPROFILE%\.codex-toolkit`; multi-host installations can share data and split conversation access (`dataChain`) from model execution (`modelChain`).

## Included components

| Component | Version | Purpose |
| --- | ---: | --- |
| `memory-store` | 1.19.3 | Memory, Conversation, Record, Golden Extract, Stage Guard, background tasks, and host routing |
| `sandbox` | 1.14.0 | Isolated execution, sessions, batch jobs, smart search, Codex tasks, and multi-model Council |
| `web-fetcher` | 7.0.0 | Headless browsing, authenticated profiles, local file formats, screenshots, inspection, and desktop control |
| `broker` | 0.1.0 | Stable Streamable HTTP bridge for local stdio MCP servers |
| `mcp-subagent` | 1.1.0 | Optional Windsurf Cascade-only asynchronous sub-agent controller |

## Highlights

- Conversation tools can locate, search, read by round, and export conversations from all four hosts.
- Record, Golden Extract, Stage Guard, ownership checks, background recovery, and stable task IDs support long engineering workflows.
- Web Fetcher handles local HTML, PDF, DOCX, PPTX, XLSX, EPUB, images, real browser sessions, screenshots, visual inspection, and DOM interaction.
- Sandbox provides short execution, parallel batches, persistent sessions, background launches, smart code search, and Council reviews across Grok, Antigravity, Codex, and explicit Claude Code routes.
- The broker forwards long-task timeouts, writes shutdown state reliably, and includes an optional stateless Exa bridge.
- Rules templates focus on natural human communication, evidence-based engineering work, privacy, and visual QA. Windsurf uses a short global rule plus five system-rule fragments.
- Sixteen allow-listed portable skills are included and validated during package checks.

## Installation

Requirements: Windows, PowerShell, and Node.js 18 or newer.

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Apply-CodexConfig.ps1
./install/Test-CodexToolkit.ps1
```

Use `SETUP.md` for host-specific installation and `TOOLKIT_README.md` for the receiver handoff guide.

## Grok / ProGrok boundary

ProGrok itself, upstream accounts, and credentials are not bundled. The portable source only probes a receiver-managed OpenAI-compatible local endpoint. Keep all real URLs and API keys in the receiver's private environment.

## Privacy

The repository and generated package exclude credentials, cookies, browser profiles, sessions, conversations, real memory data, SQLite databases, JSONL history, logs, `node_modules`, build output, and sender-specific paths or identity details.

Run before publishing:

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
```
