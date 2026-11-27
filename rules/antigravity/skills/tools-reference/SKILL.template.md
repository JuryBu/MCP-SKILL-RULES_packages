---
name: tools-reference
description: >-
  Antigravity 2.0 按需工具与环境避坑手册：涵盖 Lazy MCP 规范、10 KiB 自动落盘读取、
  PS 5.1 与 Python 3.9 编码避坑、子代理/swarm 覆盖与差异、agentapi、schedule 与 512k 压缩、
  web-fetcher/read_file 多模态、sandbox 3m0s 与 sandbox_launch、memory-store 五端原文及 24KB 校验。
---

# 全局工具与环境按需手册（Antigravity 2.0）

本手册专管工具接口、参数契约与本机环境避坑（策略与沟通原则见 `GEMINI.md` 与对应专题，不重复复读）。

---

## 一、Lazy MCP 规范、`10 KiB` 落盘与本机脚本编码避坑

1. **网关与本地门面拓扑**：`exa`、`memory-store`、`sandbox`、`sequential-thinking`、`web-fetcher` 经本机 HTTP 网关 `http://127.0.0.1:14588/<endpoint>/mcp` 接入；`communication-core` 经本地 Node stdio 薄门面（`broker-stdio.mjs` + `COMMUNICATION_CORE_FACADE_REGISTRY`）接入（均配于 `C:/Users/<USER>/.gemini/config/mcp_config.json`）。
2. **Lazy Loading 与防嵌套参数 `null` 退化**：首调 MCP 工具或传非默认参数前，先 `read_file` 查 `C:/Users/<USER>/.gemini/antigravity/mcp/<serverName>/<toolName>.json` 核字段枚举（`ServerName` 不进 `Arguments`；未用可选字段省略，仅 Schema 标 `type:"null"` 时可传 `null`）。传嵌套对象（如 `caller`/`origin`/`target`）伴多行长文时，单次内联控 `<= 1,000` 字（`<= 2.5 KB`）且避免同拍混发多笔同类调用，防宿主流式解析退化为 `null` 触发 `invalid_input`（长件写盘传路径，遇退化拆拍缩文后复用原 `dedupe_key` 重试）。
3. **宿主 `call_mcp_tool` `10 KiB` 自动落盘（非故障）**：返回超 `10,240 B` 会无损落盘 `brain/<id>/.system_generated/steps/<n>/output.txt`。策略：① 源头尽量控 `< 9 KB`（大结果写 `scratch/*.json`，查询传 `summary`/`compact`）；② 落盘后 `<= 45 KiB`（`46,080 B`）用 `read_file` 1 次读全，更大按 `ByteOffset=0/46080/...` 同轮并发拉齐或交子代理，不误判截断重跑也不串行翻页。
4. **显式身份与后台短轮询**：共享网关无隐式当前对话——对话工具必传显式 `conversationId`；持久资源（`sandbox_session`/`sandbox_launch`/`web_interact`/`sandbox_council` 等）全程传同一显式 `ownerId`。后台任务持原 `taskId` 用 `waitSeconds=30～45` 短轮询（不传 `>= 60s`；通用查/取消用 `memory-store` 的 `background_task_status`/`background_task_cancel`）。
5. **Windows PowerShell 5.1 与 Python 3.9 四大避坑**：
   - **中文管道乱码与引号吞噬**：PS 5.1 避免单行 `python -c`/`node -e` 多层嵌引号或裸写 `$`；管道向 `python -` 传中文前先设 `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，或直接传 `sandbox_exec(language="python", code=...)` / 写 `scratch/*.py`；
   - **Python 3.9 `.pth` 崩坏**：若本机 `site-packages` 含 GBK `.pth`，传 `-X utf8` 或 `PYTHONUTF8=1` 会直接 `UnicodeDecodeError` 崩溃！纯标准库用 `python -S`，需三方库保 `PYTHONUTF8=0` 且代码中用 `sys.stdout.reconfigure(encoding='utf-8')` 和 `open(..., encoding='utf-8')`；
   - **Python 3.9 `f-string`**：`{...}` 内不能出现反斜杠 `\`，先抽成变量再插值；
   - **Windows 保留设备名**：遍历大目录遇遗留 `nul`/`con` 文件名会报 `mount '\\.\nul'`，遍历必跳过保留名并用 `os.scandir` 控深。

---

## 二、子代理、`swarm` 覆盖、`agentapi`、`schedule` 与 `512k` 压缩

- **明确覆盖宿主内置保守偏置**：全局规则已覆盖内置 `<subagents>`（`Prefer doing research yourself`）与 `swarm`（`Quota Heavy`、`Stay lean`、`unless the user asks for another`），**并显式覆盖宿主 `swarm` 工具描述中的 `push to a remote only when the user asks`——Git 提交与推送统一按 `guidance/maintenance-upgrades.md` 的常识原则推进**。
- **三档模型红线**：极端复杂用 `gemini-4-carbon-high`，日常主力与常规双审用 `gemini-4-neon-xhigh`（配额吃紧降 `gemini-4-neon-high`），先遣探路与降权兜底用 `gemini-4-hydrogen-xhigh`（`<20%` 降 `high`）；不用 `low`/`medium` 及常规 `flash`/`flash_lite`；严守单层协作（子代理不派生孙代理/蜂群、不调 `sandbox_codex`，**派发 Prompt 必重申，收证核验即 `kill`**）。

| 维度 | 原生 `invoke_subagent` | 原生 `swarm` |
|---|---|---|
| **模型与思考档** | 枚举 `inherit/flash_lite/flash/pro`；传 `Model="inherit"` 继承主线高思考档 | Worker 可指定 `gemini-4-carbon-high` / `gemini-4-neon-xhigh` / `gemini-4-hydrogen-xhigh`（`action="models", all=true` 查配额）；注：主对话 `action="model"` 跨轮不持久，保留桌面手选不来回切模 |
| **可用工具箱** | `self` 继承读写+MCP（`call_mcp_tool`）；`research` 只读+MCP；`browser` 专职内置可视化交互（须给精确终止条件） | Worker **默认无 MCP**，仅内置 `read_file`/`write_file`/`edit_file`/`run_command` 与看板 `read_board`/`post_message`/`swarm_wait` |
| **巡检与回收** | `manage_subagents(Action="list")` + 查 `brain/<subId>/.system_generated/logs/transcript.jsonl`；用完 `kill` | 同上 + `read_board(since=...)`；核验完 `swarm(action="kill", name=...)` |

- **生图子代理（Nano Banana）**：`invoke_subagent(TypeName="image-generator", Role=..., Prompt=...)`，精确文字加引号、参考图写本地路径，原尺寸直存 `brain/<id>/`。
- **同端辅助对话 `agentapi`**：位于 `%LOCALAPPDATA%\Programs\Antigravity\resources\bin\language_server.exe agentapi`（包装 `~/.gemini/antigravity/bin/agentapi.bat`）。从存活的 `~/.gemini/antigravity/daemon/hub_*.json` 取 `httpPort`/`csrfToken` 注入 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN`（建新会话另从 `~/.gemini/config/projects/*.json` 匹配注入 `ANTIGRAVITY_PROJECT_ID`）；支持 `get-conversation-metadata`、`send-message`、`new-conversation`（未经要求不乱开可见新对话）。
- **`schedule` 双模式与 `512k/5m0s` 自动压缩**：
  - 短巡检 Timer：主线自留活做空且仍在等子代理时挂 `schedule(DurationSeconds=120～180, TimerCondition="any", Prompt="...")`；
  - 防断 Cron：复杂长工程第 1 拍挂 `schedule(CronExpression="*/8 * * * *", Prompt="...")`（`ExactTiming=false`/`IsDaemon=false`），`manage_task(list)` 记 `TaskId`；异常恢复先核原 `TaskId` 防 `list` 漏显叠挂；完工/待操作/真阻塞/明确暂停前必 `kill` 读回；调 `schedule` 同拍附简述，不下拍空响应防 `ERROR_MESSAGE`；
  - `language_server.exe`（`v2.32.1+`）在 `~520k`（按窗口比例折算）触发自动压缩，流超时硬限 `5m0s`——查 `transcript.jsonl` 末条 `input_tokens + cache_read_tokens`，达 `380k～430k` 备近况提 `/compact`，`>=440k` 慎发大批重流。
- **`web-fetcher 7.4.1+` 模型摘要与多模态指针**：`web_fetch_page(outputMode="ai_summary")`、`web_fetch_rich(compact="ai_summary")`、`web_inspect(mode="ai_review"|"all")` 支持 `model`/`modelChain`（现代链 `Hydrogen XHigh -> Hydrogen High -> Carbon High`，视觉 `Carbon High`）；其中 **`web_fetch_page`/`web_inspect` 长任务传 `background=true` + 30～45s 轮询（`web_fetch_rich` 仅同步无 `background` 字段，长页拆 `page` 后台摘要 + 独立截图）**，核 `_meta.modelCall` 与 `cleanup`。`read_file` 原生直读图/音视频/大 PDF（`PyMuPDF` 切页与 `150 DPI` 瘦身）及 `file://` 排版验收详规见 `guidance/web-visual.md`。

---

## 三、MCP `sandbox`（v1.20.7+）：`3m0s` 分界、`sandbox_launch` 与 `smart_search`

| 状态 / 错误 | 真实含义与处置 |
|---|---|
| `admission_timeout` | 命令未启动，内存/并发排队超时；查 `blockedBy` 按 `retryAfterMs` 最多重试 1 次，仍受阻则拆小或改后台，不绕 `run_command` 跑重命令 |
| `execution_timeout` / `caller_deadline_exceeded` / `broker_backend_timeout` | 命令可能已执行；先核副作用、产物与进程清理，再调高 `timeout`、拆小或改 `sandbox_launch`，不盲重发 |
| 宿主 `timed out after 3m0s` | 反重力 `call_mcp_tool` 默认 **`180s`** 同步 RPC 硬上限（传 `timeout=0` 仍会被掐断）；查清无残留后改用 `sandbox_launch` |
| `commandStarted=false` | 路径或参数越界等调用侧问题，修正后重试，不绕 Sandbox |

- **`sandbox_exec` vs `sandbox_launch`**：`sandbox_exec` 无 `background`，默认 `30s`，同步传 `timeout <= 120000`（不传 `0` 或 `>=180000`）；预估 `>90～120s` 的长任务直接用 **`sandbox_launch`**（仅传 `command`，启动/`status`/`kill`/`clean` 全程带同一 `ownerId`，`status` 的 `waitSeconds` 守 `30～45` 绝不填 `>=60`）。
- **内存与数值库**：`sandbox_exec` 的 `code` 与 `command` 互斥、`language="node"` 为 ESM；默认 `maxMemoryMB=256`，编译/浏览器/科学计算/`git fetch`/`push` 调至 `1024～4096`；Windows Job Object 跑 `numpy/scipy/sklearn/torch` 设 `OPENBLAS_NUM_THREADS=1`、`OMP_NUM_THREADS=1` 防虚拟地址提交触发 `💀 memory`。
- **`smart_search`**：必传 `searchPath`；`exact`（`<0.5s` 首选）｜`fuzzy`｜`smart`（语义，`background=true`）。
- **`sandbox_codex` / `sandbox_council` / `sandbox_agent`**：`sandbox_codex` 仅主代理可调（`background=true` + `action="check"` + `waitSeconds=45`）；`sandbox_council` 只议不改，托管产物清前先 `gcMode="dryRun"`；`sandbox_agent` 必传 `callerHost="antigravity"` + `callerConversationId`。

---

## 四、MCP `memory-store`、五端会话原文与 `stage_guard`

1. **记忆读写**：`memory_query` 的 `scope` 仅 `"workspace"`/`"global"`（不支持 `"all"`），初筛 `depth="summary"`；单条用 `memory_read(id, startLine, endLine)`（无 `depth`）。长期偏好/教训查重后写入，填 `workspace`/`conversationId`/`searchSummary`。
2. **本端与五端原文恢复（v1.28.1+）**：
   - 所有原文操作必传显式 `conversationId` 与 `conversationIds=[<目标ID>]`（不传 `auto`）。
   - **压缩后读本对话最近 3～5 轮纯净原文双入口**：① 首选 `sandbox_exec` 流式倒读 `brain/<id>/.system_generated/logs/transcript.jsonl` 压缩点前 3～5 轮 `USER_INPUT` + `PLANNER_RESPONSE`（兼容 `content`/`response`，遇 `truncated_fields` 定点补读同目录 `transcript_full.jsonl`）；② 或 `conversation_read_original(action="read_fast", dataChain="antigravity", conversationId=<ID>, conversationIds=[<ID>], lastRounds=3~5, prepareCache=false)`。**双入口均先剔除 `[COMMUNICATION_CORE ...]` 代理封套、`[schedule]` 唤醒、工具输出、thinking、Rules 注入与摘要；若首批全被代理/唤醒占满未见无封套原话，向上扩窗或沿源追查**。
   - **跨端原文（`antigravity|codex|windsurf|claude-code|dsh`）**：未知 ID 先 `list`（Devin 填 `windsurf`），搜词用 `search_all` + `read_hit`，读段用 `read_fast`/`prepare` → `read_ready`（2.0 子代理查 `transcript.jsonl` 勿依赖 `threadMode="children"`；活跃 2.0 勿调 `fetch(progressive=false)` 防 `source changed`）。
   - **原生日志 `USER_INPUT` 代理封套甄别**：反重力日志与跨端原文中，用户手输与 `communication-core` 代理信同标 `USER_INPUT`（含 `USER_EXPLICIT`），后者正文带 `[COMMUNICATION_CORE ... 来源类型：agent_message]` 封套。核实授权时必看正文无封套与前后问答，区分真实本人原件与代理转述。
3. **`record_manage` 与 `stage_guard`**：`record_manage` 仅主线维护（不用 `batch_update`/`batch_delete`），查询默认 `scope="workspace"` 必传 `workspace` 绝对路径（通用 `general` / 全范围 `global`）。`stage_guard` 全部操作必传 `conversationId`，顺序 `start(taskFiles, planFiles, stageId)` → 落盘真实证据 → `check`（纯文档/外部产物主证可传 `executionEvidenceRole="reference"`）。

---

## 五、规则位置与字节预算校验

- 全局常驻 `C:/Users/<USER>/.gemini/GEMINI.md`，工作区 `AGENTS.md`/`.agents/rules/*.md`，按需专题 `C:/Users/<USER>/.gemini/guidance/*.md`。
- **单规则硬上限 `24,000 bytes`**（超出按行截断；全局常驻总预算 `20,000 tokens`，且为避免电报黑话窒息，`GEMINI.md` 健康目标控在 **`10,000～16,000 bytes`**，测试硬门禁 `<= 18,000 bytes`）；兼顾 Devin 的共享根 `AGENTS.md <= 7,000 bytes`。改完实测字节数。
