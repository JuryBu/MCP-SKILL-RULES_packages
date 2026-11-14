---
name: tools-reference
description: >-
  全局规则的按需技术手册（与 GEMINI.md 同等效力）：涵盖 Antigravity 2.0 Lazy MCP 调用规范、
  宿主 call_mcp_tool 10KiB 自动落盘读取、PowerShell 5.1 与 Python 3.9 编码避坑、invoke_subagent / swarm / image-generator / agentapi / schedule 防断与 256k 压缩机制、
  exa 与 web-fetcher 7.4.1 网页/截图/Office 原生查看、sandbox 1.20.7 内存水位与现代模型路由、
  memory-store 五端跨链路路由与 2.0 会话原文读取、后台短轮询及 24KB/20k 规则预算校验。
---

# 全局工具与环境按需手册（Antigravity 2.0）

> 部署时将文中 `C:/Users/<USER>/` 替换为接收方本机用户目录，并保存为 `%USERPROFILE%/.gemini/antigravity/skills/tools-reference/SKILL.md`（单文件保持 `< 24,000 bytes`）。

本手册从全局 `GEMINI.md` 拆出，与常驻全局规则具有同等强制效力。

## 一、Antigravity 2.0 Lazy MCP 机制、宿主 `10 KiB` 落盘与本机脚本避坑

- **共享网关拓扑**：`exa`（可选）、`memory-store`、`sandbox`、`sequential-thinking`、`web-fetcher` 统一经本机常驻网关 `http://127.0.0.1:14588/<endpoint>/mcp` 接入（配置位于 `C:/Users/<USER>/.gemini/config/mcp_config.json`，参考仓库 `templates/config.antigravity.example.json`）。需要做复杂架构权衡、多假设根因推演且普通思维链易漏分支时，可按需调用 `sequential-thinking`。
- **Lazy Loading 调用铁律**：MCP 工具默认懒加载。首次使用某工具或传入非默认参数前，必须先用 `read_file` 查看 `C:/Users/<USER>/.gemini/antigravity/mcp/<serverName>/<toolName>.json` 确认真实字段与枚举，再用 `call_mcp_tool` 调用，严禁凭记忆猜参数名。
- **⚠️ 宿主 `call_mcp_tool` `10 KiB` 自动转存机制（必知，非 MCP 截断故障！）**：
  - 共享 MCP 后端支持大字符返回，但 **Antigravity 2.0 宿主对 `call_mcp_tool`（及 `read_board` 等部分内置工具）硬编码了 `10 KiB`（`10,240 bytes`）内联阈值**：只要单次返回超过 `10,240 bytes`，宿主会自动将完整无损的原始返回保存在 `C:/Users/<USER>/.gemini/antigravity/brain/<当前会话ID>/.system_generated/steps/<步号>/output.txt`，并在上下文中仅返回一行路径提示（或头尾预览）。
  - **省往返双层策略（治本优先）**：
    1. **源头控流 `< 9 KB`（免二次读取 Turn）**：写 `sandbox_exec` 脚本时严禁无脑全量打印大文件或深层目录，直接在脚本内完成筛选、行号定位与统计摘要（如需留存完整明细备查则写入会话 `scratch/*.json`，`stdout` 只打印 `< 8 KB` 关键结论）；调用 `memory_query` 用 `depth="summary"`、`web_fetch_page` 用 `outputMode="summary"|"compact"`，一步内联拿完结果，零额外往返。
    2. **落盘后单轮 `45 KiB` 并行吞完（禁串行翻页）**：若确需读取大原文触发了 `saved to: file:///.../steps/<n>/output.txt`（或 Sandbox `output-artifacts`），**严禁误判截断重跑，也严禁 `200` 行一页串行翻好几轮**——内置 `read_file` 单次上限达 `46,080 bytes`（`45 KiB`，是 `10 KiB` 的 4.5 倍），`<= 45 KiB` 直接 1 次读全；更大文件在同一轮用多个 `read_file(ByteOffset=0 / 46080 / 92160)` 并行一次拉齐，或多文件直接委派子代理在独立上下文消化后只回传带行号精要。
- **显式身份与后台短轮询**：网关由多端共享，无隐式「当前对话」。对话工具必传显式稳定 `conversationId`；持久资源（`sandbox_session`、`sandbox_launch`、`web_interact` 会话、`sandbox_council` 等）必传显式 `ownerId`。耗时任务一律用 `background=true` 启动，持**同一公开 `taskId`** 以 `waitSeconds=30～45` 短轮询（严禁 `>60s`）；统一查询/取消入口为 `memory-store` 的 `background_task_status` / `background_task_cancel`，状态未知先查原任务，禁盲目重发。
- **Windows PowerShell 5.1 与 Python 3.9 兼容避坑**：
  1. **防吞引号与管道中文乱码**：`sandbox_exec` 与 `run_command` 底层均为 Windows PowerShell 5.1，禁止在单行 `python -c` / `node -e` 内多层嵌套引号或裸写 `$`。通过管道向 `python -` 传含中文的内联脚本时，PowerShell 5.1 默认 `$OutputEncoding` 为 GBK/ASCII 会把中文转坏导致 `SyntaxError: Non-UTF-8 code`——**必须在管道前加 `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`**，或直接给 `sandbox_exec` 传 `language="python", code="..."`，或在会话 `scratch/` 目录写带 `# -*- coding: utf-8 -*-` 的 `.py` 脚本执行。
  2. **Python 3.9 GBK `.pth` 启动崩溃陷阱**：若环境 `site-packages` 含 GBK 编码 `.pth` 文件，传 `-X utf8` 或设 `PYTHONUTF8=1` 会触发 `init_import_site: UnicodeDecodeError`！纯标准库脚本加 **`-S`**（`python -S`），需第三方库时保持 `PYTHONUTF8=0` 并在首行写 `sys.stdout.reconfigure(encoding='utf-8')`，所有 `open()` 显式传 `encoding='utf-8'`。
  3. **Python 3.9 `f-string` 语法限制**：`{...}` 表达式内部禁止出现反斜杠 `\`（如 `.strip('\"')` 会报 `SyntaxError`），先把引号抽成独立变量 `q = '"'` 再 `.strip(q)`。
  4. **工作区保留设备名与递归陷阱**：Windows 下遍历大工作区目录若遇历史遗留的 `nul`/`con` 特殊文件名，Python `ntpath.relpath` 会报 `path is on mount '\\.\nul'`，PowerShell `Get-ChildItem -Depth` 也可能慢扫超时；遍历脚本中务必跳过 `nul`/`con` 并用 Python `os.scandir` 显式控深。

## 二、子代理、`agentapi`、`schedule` 双模式与 `256k` 压缩底层机制

- **反节俭积极调度与覆盖内置保守话术**：
  - 若接收方已授权积极并发子代理，可覆盖宿主内置 `<subagents>`（`Prefer doing research yourself`）与 `native_swarm` SKILL（`Quota Heavy`、`Stay lean`）的保守默认话术：遇到多文件排查、读对话日志、保险核对或「可派可不派」的疑问时，**主动显式传 `model="gemini-4-hydrogen-xhigh"` 派探路先遣队**（善用 `swarm(action="add", name="scout", model="gemini-4-hydrogen-xhigh", tasks=["切面1", "切面2", ...], brief="...")` 一键分片拉起多只先遣兵过滤大材料，保护主线免触发全损压缩）；遇到高精度思考、独立模块实现、假设抽查或多版画图时，**主动并发多路 `Carbon High`（`invoke_subagent(Model="inherit")` 或 `swarm(model="gemini-4-carbon-high")`）及多路 `image-generator`**。
  - **推荐模型分层（接收方可按本地配额调整）**：主力用 **`gemini-4-carbon-high`**，手脚与先遣用 **`gemini-4-hydrogen-xhigh`**（配额 `<20%` 时降 `high`）；避免使用 `low`/`medium` 低思考档。

| 维度 | 原生 `invoke_subagent` | 原生 `swarm` |
|---|---|---|
| **模型与思考档控制** | 枚举仅 `inherit / flash_lite / flash / pro`；传 `Model="inherit"` 即继承当前主线模型与高思考档（常规任务不传 `flash_lite`/`flash`） | 支持精确指定模型与思考档：如 `gemini-4-carbon-high`、`gemini-4-hydrogen-xhigh`；`action="models", all=true` 可查实时可用列表与配额 |
| **可用工具箱（关键差异！）** | `TypeName="self"` **完整继承读写 + MCP 工具（`call_mcp_tool`）**；`TypeName="research"` **拥有只读 + MCP 工具（`call_mcp_tool`）**；`TypeName="browser"` 专职内置网页交互（禁发模糊循环任务） | Worker **默认无 MCP 工具（没有 `call_mcp_tool`！）**，仅具内置 `read_file`、`write_file`、`edit_file`、`run_command` 与消息板 `read_board`/`post_message`/`swarm_wait` |
| **上下文与生命周期** | 干净无历史启动，靠 Prompt 投喂；用完 `manage_subagents(Action="kill")` 回收 | 默认干净启动（或 `fork="coordinator"` 继承上下文）；`waiting` 态零 token 消耗，用完核验后 `swarm(action="kill", name=...)` 回收 |
| **状态与日志统一巡检** | `manage_subagents(Action="list")`（**同时返回 `invoke_subagent` 与 `swarm` worker 的实时 `state`、`stateDetail` 与 `lastStepTime`**）+ `brain/<subagentId>/.system_generated/logs/transcript.jsonl` | 除 `manage_subagents(Action="list")` 外，配合 `swarm(action="status")` + `read_board(since=...)` + `brain/<workerId>/.system_generated/logs/transcript.jsonl`（识别半截续写睡入 `waiting` 或流挂起） |

- **内置生图子代理 `image-generator`（Nano Banana 驱动）**：`invoke_subagent(TypeName="image-generator", Role=..., Prompt=...)` 底层集成 Google Nano Banana 模型池（由云端动态选档）。Prompt 写清主体、风格、构图并将画面精确文字加引号；改图时把本地参考图绝对路径写入说明供其传 `ImagePaths`；产物直存父对话 `brain/<id>/` 目录。
- **本机跨对话线程 CLI `agentapi`（对标 Codex 线程工具）**：二进制位于 `%LOCALAPPDATA%\Programs\Antigravity\resources\bin\language_server.exe agentapi`（包装脚本 `~/.gemini/antigravity/bin/agentapi.bat`）。在共享 `sandbox_exec` 中调用时，先遍历 `~/.gemini/antigravity/daemon/hub_*.json` 校验 `pid` 存活，取当前在线 Hub 的 `httpPort` 与 `csrfToken` 注入 `ANTIGRAVITY_LS_ADDRESS=127.0.0.1:<httpPort>` 与 `ANTIGRAVITY_CSRF_TOKEN=<csrfToken>`（新建会话另从 `~/.gemini/config/projects/*.json` 匹配工作区注入 `ANTIGRAVITY_PROJECT_ID`）：
  - `agentapi get-conversation-metadata <conversation_id>`：只读查询本机指定对话的标题与工作区元数据；
  - `agentapi send-message [--title=<title>] <recipient_id> <content>`：向本机已有辅助对话或自身投递异步消息（宿主自动唤醒目标对话）；
  - `agentapi new-conversation [--model=<model_id>] [--title=<title>] [--profile=<profile>] <prompt>`：在对应项目下拉起全新独立对话线程（仅限明确授权或换线程交接时使用，严禁乱开刷屏）。
- **`schedule` 双模式与 `manage_task` 管理（短巡检 Timer + 持续工程 Cron 防断）**：
  1. **等子代理单次短巡检**：`schedule(DurationSeconds=120～180, TimerCondition="any", Prompt="...")`，子代理提前发消息会自动消掉 Timer 直接唤醒；
  2. **持续工程周期防断心跳**：`schedule(CronExpression="*/20 * * * *", Prompt="...")`（`ExactTiming=false` 防拥堵抖动，`IsDaemon=false`），绑定当前对话原位唤醒（免开新帖）；开工后用 `manage_task(Action="list")` 记下 `TaskId`，完工、待用户操作、外部阻塞或明确暂停时必调 `manage_task(Action="kill", TaskId=...)` 停用并读回确认；
  3. **禁空回铁律**：调用 `schedule` 后须在同一回合附简短说明或随工具回合直接收尾，严禁下一拍输出既无工具调用又无可见字符的纯空响应（会触发宿主 `ERROR_MESSAGE`）。
- **`language_server.exe` 自动压缩（`context_summary`）底层机制与防超时参数**：
  - 现役 `oneharness` 在 `hooks.checkpointNeeded` 比较 `CheckpointConfig.MaxTokenLimit = 256,000`（扣减 `systemPrompt + tools` 占位后超出即触发，压后回落至 `~30k`）；`NewContextSummaryHook` **直接读取当前对话主模型（`PlannerConfig.Model`，如 `Carbon High`）**发起摘要请求，且流超时在二进制 `.data` 段硬编码只读 `300000000000 ns`（**`5m0s`，无任何环境变量或 flag 可调**）。
  - 上下文越过 `~235k` 时极易触发 `cache_read_tokens=0` 冷 Prefill，若同窗叠加大批 `Carbon High` 子代理重流抢占通道，TTFT 易突破 `5m0s` 报错。持续工程须自查本对话 `transcript.jsonl` 末条 `PLANNER_RESPONSE` 的 `input_tokens + cache_read_tokens`：`180k～210k` 阶段间隙写齐近况后提醒输入 `/compact`（走 `SlashCommandScopeItem` 拼接 `ON-DEMAND COMPACTION`，支持附带保留指令，趁热缓存秒压），且 `>= 200k` 禁同窗新发大批 `Carbon High` 重流。
- **web-fetcher 7.4.1+ 模型摘要与视觉审查**：本段用于 `web-fetcher`；上方模型要求继续用于原生 `invoke_subagent` 与 `swarm`。
  - **参数与入口**：`web_fetch_page(outputMode="ai_summary")`、`web_fetch_rich(compact="ai_summary")`、`web_inspect(mode="ai_review"|"all")` 均支持可选 `model` 和 `modelChain`；指定型号时优先传完整 slug 与明确链路。`auto` 保持 `Antigravity -> Codex` 顺序，配置 `WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1` 才追加 Claude Code。纯文字优先在线 App LS，离线后按能力使用自有 `cli-ls`／`cli-agent`；原生图片走 `cli-agent`。
  - **默认模型与期限**：现代目录材料任务采用 `Hydrogen XHigh -> Hydrogen High -> Carbon High`，视觉采用 `Carbon High`；旧 LS 保留原映射。page 摘要及 inspect 的 `ai_review`／`all` 长任务使用 `background=true`，沿原 `taskId` 每 30～45 秒查询；`all` 在结构处理前返回任务号并保留结构、检测、审查结果。核对 `_meta.modelCall` 或逐页 `modelCalls` 与 `cleanup`；认证、准入、额度、取消与结果未知时停止，已提交后超时先查原任务。

## 三、网页检索、视觉核验、Office 原生预览与前端缓存避坑

- **公开网页降级链**：① 首选 `exa.web_search_exa`（自然语言语义描述目标页）与 `exa.web_fetch_exa`（仅在接收方配置 Exa 时可用） → ② Exa 未配置或返回 402 时说明原因降级内置 `search_web` → ③ 登录态、动态等待（`waitFor`）、滚动、截图、DOM 交互、下载转换用 `web-fetcher`（长页 `outputMode` 默认用 `summary`/`compact`）。
- **Office 与本地文件 `file://` 原生查看（禁转 PDF、禁并发）**：Word / PPT / Excel / PDF / SVG / HTML 直接用 `web-fetcher` 走 `file://` 截图（`web_fetch_screenshot`）与检查（`web_inspect`）；**严禁并发调 LibreOffice 截图**（防争抢配置报 `EPERM`，首次冷启动约 `45s`）。图片任意单边须 `<= 8000px`，分片长图逐张用 `read_file` 看全。
- **前端本地调试三项避坑**：① 本地 HTML/JS 修改落盘后，复用旧 `web_interact` 会话传 URL 可能仍读旧缓存，**须先 `close` 旧会话再新开**；② 无头浏览器 `window.innerHeight` 与全屏容器 `clientHeight` 可能不同，全屏画布优先绑定容器 `clientHeight` + `ResizeObserver`；③ 末轮改码后必须重截所有受影响视角，禁混用旧截图。接收方自配的持久登录态用前先访问目标页实测，收尾只关本任务 `ownerId` 自建会话，禁删共享 Cookie/profile。

## 四、MCP sandbox（v1.20.7+）：内存调度、四类超时与多模型通道

| 状态码 / 错误类型 | 真实含义 | 强制处置规范 |
|---|---|---|
| `admission_timeout` | 命令**尚未启动**，内存/并发接纳排队超时 | 查 `admissionDecision.blockedBy`，按 `retryAfterMs` 最多重试 1 次；仍受阻则拆小、改后台或报告，**严禁绕到原生 `run_command` 跑同一重命令** |
| `execution_timeout` | 命令**已启动**，运行超出执行期限 | 先检查已产生的副作用、输出 artifact 与进程树清理，再决定续跑或缩小范围 |
| `caller_deadline_exceeded` | 排队 + 运行超出调用方期限 | 按 `mayHaveStarted` 核实是否已执行，禁止把未知状态当未执行盲目重发 |
| `broker_backend_timeout` | 网关与后端通信超时 | 先查原持久任务或产物状态，禁止盲目重发 |
| `commandStarted=false` 类错误 | 目录缺失、参数越界等启动前拒绝 | 属调用侧参数问题（Sandbox 本身正常），修正路径或参数，禁止绕过 Sandbox |

- **`sandbox_exec` 执行与内存上限（v1.20.7+）**：按实时物理/提交水位接纳（显式 `24MB` 按 `24MB` 记账，黄区允许 `<= 192MB` 安全小请求）。`code` 与 `command` 二选一互斥，必传稳定 `ownerId`；`language="node"` 运行在 ESM 环境（用 `import` 禁 `require`，顶层 `await` 正常收尾）；默认进程树硬上限 `maxMemoryMB=256`，若脚本内需拉起 `agy`、无头浏览器或编译等重子进程，须显式传 `maxMemoryMB=1024`（或按需调高）。超长耗时脱离任务用 `sandbox_launch`。
- **`smart_search` 三模式（严禁使用内置 `grep_search`）**：**必传 `searchPath`**；`exact`（ripgrep 精确字面量/正则，`<0.5s` 首选）｜`fuzzy`（tree-sitter AST 符号模糊定位，`<2s`）｜`smart`（语义搜索，`45～90s`，走 `background=true` + 可传 `modelChain="auto"` / `"grok"` / `"antigravity"` / `"codex"`；`v1.20.7` 下 `antigravity` 链支持紧凑单文件 `direct` 单步语义解析；`smart` 默认申请 `512 MB` 内存预留，整机可用内存近 `1.5 GB` 黄区时勿与大内存 `sandbox_exec` 同拍挤占；多词用 `queries` 数组并行）。
- **`sandbox_codex`、`sandbox_council`、`sandbox_agent` 与现代模型目录（v1.20.7+）**：`sandbox_codex` 用于重型纯代码 Review / 跨文件核查（`background=true` + `action="check"` + `waitSeconds=45`，**仅主代理可调，子代理严禁调用**）；`sandbox_council` 只讨论找盲点不执行，托管产物遵循 `SANDBOX_DATA_ROOT`（清理前必先 `gcMode="dryRun"`），支持 `codex`、`grok`、`geminiCli`、`antigravityCli`（统一复用 `%LOCALAPPDATA%\agy\bin\agy.exe` 探测，复杂文件与大输入自动落临时索引，可用 `SANDBOX_COUNCIL_GEMINI_CLI_*` / `SANDBOX_COUNCIL_LARGE_INPUT_*` 调整）。反重力现代自动链为 **`Hydrogen XHigh -> Hydrogen High -> Carbon High`**，支持完整 ID 或简写（`"hydrogen-xhigh"`、`"hydrogen"`、`"carbon"`，`"pro"`/`"strong"` 优先命中 `Carbon High`）。用户明确指定外部 API 模型时使用 `sandbox_agent`（必传 `callerHost="antigravity"` 与 `callerConversationId`）或 `sandbox_grok`，未知受理先查原命令回执与预算，禁止自动重发。

## 五、MCP memory-store、五端会话原文读取与 Stage Guard

- **查询、分层检索与单条读取**：`memory_query` 的 `scope` 枚举仅支持 `"workspace"` 或 `"global"`（**不支持 `"all"`**），支持 `+必含 -排除 ^加权` 行内语法与 `tiers: {high, med, low}` 分层置信度，初筛传 `depth="summary"`；**读单条记忆用 `memory_read(id=..., startLine=..., endLine=...)`（`memory_read` 无 `depth` 参数，传行范围直接内联返回，不传则导出临时 `.md` 路径供 `read_file` 读取）**。`dataChain` 选数据源（`antigravity | codex | windsurf | claude-code | dsh`）；`modelChain` 选摘要/语义模型（`windsurf` 与 `dsh` 仅作数据源）。
- **本端与五端原文恢复（v1.28.1+）**：
  - **显式双 ID 契约**：所有原文操作均必传调用者稳定 `conversationId`，并用 `conversationIds=[<目标ID>]` 指定目标会话，禁止用 `auto` 猜数据来源。
  - **本端当前对话压缩自救与活跃子代理巡检**：直接用内置 `read_file` 读 `brain/<id>/.system_generated/logs/transcript.jsonl`（遇 `truncated_fields` 定点补读同目录 `transcript_full.jsonl` 对应行）；定位本会话派发过的子代理直接搜 `transcript.jsonl` 中的 `invoke_subagent` / `swarm`（2.0 子代理目录无 SQLite `parent_conversation_id` 绑定，勿依赖 `threadMode="children"`）。
  - **同机其它 Antigravity 会话（2.0 GUI 裸 `<id>` / CLI `antigravity-cli:<id>` / 1.x `.pb`）与跨端历史（Codex / Devin-WSF / CC / DSH）**：未知 ID 用 `list`（Devin 填 `dataChain="windsurf"`，支持 UUID 与词对别名如 `<adjective>-<noun>`；DSH 支持 `.jsonl.zstd`）→ 跨会话搜词用 `search_all`（显式传 `dataChain` 或 `dataChains`）+ `read_hit` → 单目标末 N 轮或定点范围优先用 **`read_fast` / `prepare` → `read_ready` / `extract_ready` / `locate_ready` / `search_ready`**（遵循响应 `next`；`1.28.1` 默认 `source="auto"` 原生走 SQLite/WAL 隔离临时副本与完整 JSONL；活跃 2.0 会话高频写 `.db-wal` 时避免对其它 2.0 会话调 `fetch(progressive=false)`，日常直接用 `read_fast` / `prepare`）。大结果返回 `continuationCursor` 时沿同一 `taskId` 用 `read_result` 续读；遇到导出图片路径须用 `read_file` 看图。
- **Record 与 Stage Guard**：多端协作时仅**主线角色**在阶段收尾更新 `record_manage`，非主线只提交代码不改 Record，禁调全局 `batch_update/batch_delete`。`record_manage` 的 `list / search / audit_ownership / stale_check` 默认 `scope="workspace"`，**必须同时显式传非空 `workspace` 绝对路径**（通用区传 `scope="general"`，全范围传 `scope="global"`）；读长 Record 优先用 `read(view="outline" | "state" | "decisions" | "lessons")`。`stage_guard` **全部操作均必传显式 `conversationId`**，顺序必为 **`start`（传完整 `taskFiles`、`planFiles`、`stageId`）→ 完成实现并落盘全部产物与验证证据 → `check`**（若外部文件为必需证据、聊天仅作参考，可传 `executionEvidenceRole="reference"`）。

## 六、Antigravity 2.0 规则位置与字节/Token 预算校验

- **加载路径与硬上限**：全局常驻为 `C:/Users/<USER>/.gemini/GEMINI.md`，工作区为 `AGENTS.md` / `.agents/rules/*.md`，按需专题位于 `C:/Users/<USER>/.gemini/guidance/*.md`。**单规则文件硬上限 `24,000 bytes`（超出按行截断）**；全局常驻规则总预算 **`20,000 tokens`**（超出整份降级为路径指针；中文 UTF-8 约 `3 bytes ≈ 1 token`，建议 `GEMINI.md` 保持在 `16,000 ～ 23,800 bytes` 安全区）。兼顾 Devin 的共享工作区根 `AGENTS.md` 保持 `<= 7,000 bytes`。
- **改规则后必跑校验命令**：在 `sandbox_exec` 中用 `(Get-Item "$env:USERPROFILE\.gemini\GEMINI.md").Length` 或 Python `os.path.getsize` 实测确认 `< 24000`。
