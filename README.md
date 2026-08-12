# MCP-SKILL-RULES Packages

面向 Windows AI 编程环境的可移植 MCP、Skills 与 Rules 工具包。

这套项目最初用于 Antigravity，后来扩展为 Codex、Claude Code 与 Windsurf 共用同一套 MCP 源码、数据目录约定和模型路由。当前版本同时保留「单独安装一个宿主也能使用」与「多个宿主共享数据」两种模式。

> 2026-08-02 refresh：NapCat 自动唤醒接入 Codex Desktop 当前 App Server 连接，新增原生未读状态、任务级幂等、上游自恢复、自动化暂停告警、候选验证、局部 backend 热重载和可回滚升级流程。

## 这套工具解决什么问题

- 同一台电脑上的 Codex、Antigravity、Claude Code、Windsurf 可以访问同一份便携 MCP 数据，而不需要复制多套记忆库。
- `dataChain` 负责选择对话数据来源，`modelChain` 负责选择执行摘要、审查或搜索的模型，两者可以分开。
- 只有 Codex 时也能运行，默认数据写入 `%USERPROFILE%\.codex-toolkit`，不会依赖 Antigravity 目录。
- 安装多个宿主后，可按能力启用跨宿主对话读取与模型 fallback；缺失的宿主不会被伪装成可用。
- 公开包只包含源码、模板、说明和测试，不包含登录态、真实记忆、对话、密钥、日志或数据库。

## 当前组件

| 组件 | 版本 | 主要用途 |
| --- | ---: | --- |
| `memory-store` | 1.22.9 | 记忆、四宿主 Conversation/Recall、Record、Golden Extract、Stage Guard、调度恢复与跨宿主路由 |
| `sandbox` | 1.17.0 | 隔离执行、动态内存调度、Windows 进程树硬限制、按需 artifact、持久会话、Codex 任务与多模型 Council |
| `web-fetcher` | 7.0.0 | 无头浏览、登录态浏览、本地多格式文件、截图、视觉检查与桌面交互 |
| `broker` | 0.1.0 | 将本地 stdio MCP 暴露为稳定的 Streamable HTTP endpoint |
| `mcp-subagent` | 1.1.0 | Windsurf Cascade 专属异步子代理控制器，可选安装 |
| `napcat-mcp` | 0.3.9 | 可选 QQ 群通知、任务账本、双机送达回执、可信路由、Codex 原生未读唤醒、自然私聊回复路由、热升级历史基线、群文件传输、监督器与安全更新 |
| `wechat-docs-mcp` | 0.3.0 | 可选本地微信与腾讯文档双 M:N 订阅、独立投递/ACK、文档只读合并提醒、安全 outbound 骨架与当前用户监督器 |

## 重点能力

### memory-store：Conversation 与 Record 系列

- `conversation_read_original` 可列出、定位、搜索、分轮读取和导出 Codex、Antigravity、Claude Code、Windsurf 对话。
- Memory Store 1.22.9 可在 Windsurf/Antigravity 离线时列出本地 PB，通过 auto/manual/full Recall 恢复 context-only 上下文，并自动重建旧缓存使全局人类轮号与新语义一致；Codex heartbeat、自动通道提醒和子代理通知不再占用人类轮，主人回复、附件与真实跨线程委派正文继续保留。
- 跨宿主 Conversation 需要接收方自行授权访问对应宿主的本地对话目录；工具包不会携带发送方数据，也不会把读取权限扩展到未配置的机器或账户。
- `conversation_golden_extract` 从长对话中提取可复用的高价值片段。
- `record_manage` 维护结构化工作记录，支持读取视图、阶段更新、所有权审计与后台生成。
- `stage_guard` 在阶段结束前对照 Plan、Task 和执行证据检查是否漏项。
- 后台任务支持稳定 `taskId`、取消、重启恢复、进度查询和并发控制。
- Record 1.21.1 增加生产级调度队列、来源证据、启动屏障、提交协议、跨链未知归属迁移与 provider admission/control，使长任务能在多宿主并发和异常重启后继续保持可追踪状态。
- Grok / ProGrok 是可选模型链路，只负责模型调用，不读取对话数据；`auto` 不可用时会按工具允许的顺序 fallback。

### web-fetcher：网页、文件与视觉检查

- 可抓取公开网页，也可通过接收方自己的浏览器 profile 使用已登录站点。
- 启用持久浏览器 profile 会在接收方数据根保存 Cookie 与 localStorage，可能包含登录态；不要把 profile、备份或运行数据再次打包分享。
- 支持 HTML、PDF、DOCX、PPTX、XLSX、EPUB、图片等本地文件的读取与转换流程。
- `web_fetch_screenshot`、`web_inspect` 可检查重叠、溢出、可读性和页面结构。
- `web_interact`、`web_pipeline` 支持持久 session、点击、输入、DOM 检查和批量流水线。
- desktop 工具可连接 Electron / Chromium / CEF 应用进行调试和截图。

### sandbox：执行、搜索与 Council

- `sandbox_exec`、`sandbox_batch`、`sandbox_session`、`sandbox_launch` 覆盖短代码、并行任务、持久会话和后台进程。
- 名称里的「sandbox」指硬超时、内存约束、任务管理与输出治理，不是 Windows AppContainer 或虚拟机级隔离；命令仍以接收方当前用户权限访问本机文件和环境变量。
- `smart_search` 提供精确、模糊和模型语义搜索，可选择 Grok、Antigravity、Codex 或显式 Claude Code 模型链路。
- `sandbox_council` 让多个模型独立审议同一问题，支持文件和图片输入、后台任务、owner 隔离、可中止续跑与同 provider fallback。
- Council 1.15.1 为每次运行建立带 `manifest.json` 的托管产物目录，统一追踪 transcript、索引和大输入；`sandbox_status` 提供只读预演、隔离、恢复与受保护清理，避免误删运行中或仍被依赖的产物。
- Antigravity CLI（`agy`）模型调用和文件索引共享跨 worker 租约池，并加强代理继承、终止错误分类、超时中止与进程树回收；公开版仍把所有运行数据放到接收方的数据根，不写回源码目录。
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
- `/napcat/mcp`，仅在接收方自行安装 NapCat、填写私有绑定并设置 `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1` 后可用

broker 会为普通请求使用 120 秒默认超时，并根据工具参数中的 `waitSeconds` / `timeout` 放宽长任务等待，上限默认 30 分钟。状态文件在退出、`SIGBREAK` 和 `beforeExit` 时尽力落盘。

broker 子后端断管后会丢弃失效 transport，但不会自动重放结果未知的当前工具调用；下一次调用或仅允许本机回环访问的 `GET /health?endpoint=<name>&deep=1` 只读探针会建立新子后端。已有本机安装可用 `install\Update-CodexMcpBroker.ps1` 先备份、受控重启并验证 NapCat/Sandbox 等深层健康，同时用 `-ProtectedStatePaths` 逐字节保护稳定任务账本，用 `-TaskRouterRuntimeStatePaths` 对会周期更新的 `task-router-runtime.json` 做路由进程、锁、实例身份与健康字段核对。运行态文件误放进逐字节清单会在修改前拒绝，正常扫描时间、任务数和 `keepAlive` 变化不会再触发误回滚。未显式传入 `-BrokerRoot` 时，更新器优先读取 `CODEX_TOOLKIT_SERVICE_MANIFEST` 或 `%USERPROFILE%\.codex-toolkit\services\infrastructure\service-manifest.json`，分别使用 `broker.brokerScript`、`broker.startScript` 和 `broker.stopScript` 指向的受管 release 文件；写入前会证明健康 PID 的 Node 入口就是目标 broker，更新后还要求 PID 已变化且入口路径仍一致。平铺安装继续使用目标目录内的 Start/Stop 脚本；失败时恢复原 broker 代码及原有生命周期文件状态。

### Rules：四宿主的人类化工作规则

Rules 保留少汇报腔、解释技术概念、Plan / Task / Stage Guard、子代理证据、Office 视觉验收和隐私边界等工作习惯，主要目标是让 AI 说人话并减少模板化伪人感。猫娘表达已从 Codex 核心工程规则中拆成可选组件：不喜欢角色风格时可安装中性版，喜欢原有表达时可安装普通猫娘版，双机协作环境则选择开发机或训练机版。

| 宿主 | Rules 入口 |
| --- | --- |
| Codex | `rules/codex/profiles/` 中的中性、普通猫娘、开发机猫娘、训练机猫娘四种组合 |
| Antigravity | `rules/antigravity/GEMINI.template.md` |
| Claude Code | `rules/claude-code/CLAUDE.template.md` |
| Windsurf | `rules/windsurf/global_rules.template.md` 与五个 `system_rules` 分片 |

Codex 四种配置都复用 `components/core.template.md`，所以工程流程、工具说明和证据要求不会因角色风格变化而丢失。开发机与训练机配置可能超过常见的 32K 项目说明读取上限，`Apply-CodexConfig.ps1` 与 Rules 安装器都会幂等保证 `project_doc_max_bytes >= 65536`，并保留已有更高值。`system-prompt.template.md` 是四种配置共用的可选模板，集中放置时间与质量、先查证再实现、提问边界和写作组织等通用原则；`Install-CodexRulesProfile.ps1 -InstallSystemPrompt -InstallRecommendedDesktopFeatures` 可在备份后维护提示词指针和当前 Desktop 功能配置，不会整份覆盖 `config.toml`。开发机与训练机的真实账号、群号、路径和信任边界必须写入仓库外的私有覆盖文件，公开示例不能直接当真实配置安装。

Rules 已删除生日、学业、账号链接、登录态、本机路径、真实服务额度和私人项目上下文。接收方应根据自己的环境再修改。

### Skills：完整的可迁移技能包

`skills/` 当前包含 18 个经过 allow-list 与许可证筛选的用户侧技能，包含 `hatch-pet` 与 `wechat-docs-collaboration`。`install/Test-CodexToolkit.ps1 -PackageClean` 会逐个检查技能目录、`SKILL.md` 和 manifest，避免压缩包漏掉 Skills。

没有打包 Codex `.system` 技能、插件缓存、运行产物，以及本机许可证不允许再分发的 Office skills。详情见 `skills/skills_manifest.md`。

## 快速安装

要求：Windows、PowerShell、Node.js 18 或更高版本。

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
./install/Apply-CodexConfig.ps1
./install/Install-CodexRulesProfile.ps1 -Profile catgirl
./install/Test-CodexToolkit.ps1
```

Codex Rules 还可选择 `neutral`、`development` 或 `training`。需要部署公共 `system-prompt.template.md` 时追加 `-InstallSystemPrompt`；需要机器私有配置时先把 `rules/codex/local-overrides.example.md` 复制到仓库外，再通过 `-LocalOverridePath` 传入。

构建 Windsurf 专属 subagent：

```powershell
./install/Install-CodexToolkit.ps1 -IncludeWindsurfSubagent
```

它不会自动修改 Windsurf 或其他宿主配置。请按 `mcps/mcp-subagent/README.md` 单独部署。

检查可选 NapCat 模块源码：

```powershell
./install/Install-CodexToolkit.ps1 -IncludeNapCat
```

NapCat 本体、QQ 登录态和真实群绑定不会被安装或打包；配置步骤见 `mcps/napcat-mcp/README.md`。

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
| `memory-store` | 1.22.9 | Memory, four-host Conversation/Recall, Record, Golden Extract, Stage Guard, scheduling recovery, and host routing |
| `sandbox` | 1.17.0 | Isolated execution, adaptive memory admission, Windows process-tree hard limits, on-demand artifacts, sessions, Codex tasks, and multi-model Council |
| `web-fetcher` | 7.0.0 | Headless browsing, authenticated profiles, local file formats, screenshots, inspection, and desktop control |
| `broker` | 0.1.0 | Stable Streamable HTTP bridge for local stdio MCP servers |
| `mcp-subagent` | 1.1.0 | Optional Windsurf Cascade-only asynchronous sub-agent controller |
| `napcat-mcp` | 0.3.9 | Optional QQ group messaging, task ledger, cross-machine delivery receipts, trusted routing, native Codex unread wakeups, natural private-reply routing, hot-upgrade history baselines, file transfer, supervisor, and guarded updates |
| `wechat-docs-mcp` | 0.3.0 | Optional governed local WeChat and Tencent Docs M:N subscriptions, independent delivery/ACK, read-only coalesced document wakes, safe outbound scaffolding, and a per-user supervisor |

## Highlights

- Conversation tools can locate, search, read by round, and export conversations from all four hosts.
- Memory Store 1.22.9 can list local Windsurf/Antigravity PB files offline, restore context-only history through auto/manual/full Recall, rebuild legacy caches so global human-round numbering matches the new semantics, preserve full local PB response/tool totals during range reads, and keep Codex heartbeats, automatic channel wakes and subagent notifications out of human rounds while retaining owner replies, attachments and real delegation bodies.
- Cross-host conversation access requires receiver-granted access to each host's local conversation directory; no sender data or remote account access is bundled.
- Record, Golden Extract, Stage Guard, ownership checks, background recovery, and stable task IDs support long engineering workflows.
- Memory Store 1.21.1 adds production scheduling, source-evidence tracking, startup barriers, commit protocols, provider admission/control, and unknown-chain migration for recoverable multi-host Record work.
- Web Fetcher handles local HTML, PDF, DOCX, PPTX, XLSX, EPUB, images, real browser sessions, screenshots, visual inspection, and DOM interaction.
- Persistent browser profiles store receiver-side cookies and localStorage and must never be repackaged. Sandbox adds timeouts, memory limits, and task governance but is not an OS-level VM or AppContainer; commands retain the receiver user's file and environment access.
- Sandbox provides short execution, parallel batches, persistent sessions, background launches, smart code search, and Council reviews across Grok, Antigravity, Codex, and explicit Claude Code routes. Council 1.15.1 adds manifest-governed artifacts, abort/resume hardening, guarded garbage collection, and a cross-worker `agy` lease pool while keeping runtime data outside the source tree.
- The broker forwards long-task timeouts, writes shutdown state reliably, and includes optional Exa, Windsurf subagent, and NapCat endpoints. NapCat remains disabled until the receiver supplies a local OneBot service and private binding.
- Rules templates focus on natural human communication, evidence-based engineering work, privacy, and visual QA. Codex Rules are composed from a shared engineering core plus optional catgirl, development-machine, or training-machine overlays; Windsurf uses a short global rule plus five system-rule fragments.
- Seventeen license-reviewed portable skills are included and validated during package checks, including the new `hatch-pet` workflow.

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
