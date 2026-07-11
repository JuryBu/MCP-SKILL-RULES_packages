#!/usr/bin/env node
/**
 * MCP Sandbox Server v1.14.0
 *
 * 代码执行沙箱，解决 Antigravity IDE 中 run_command 的痛点。
 *
 * 8 个 MCP 工具：
 *   - sandbox_exec: 执行代码片段或系统命令（硬超时、内存限制、输出截断）
 *   - sandbox_session: 持久 REPL 会话（变量状态跨调用保持）
 *   - sandbox_batch: 一次调用并行执行多任务
 *   - sandbox_status: 查看系统状态（环境、GPU、资源、会话）
 *   - sandbox_codex: Codex CLI 专用调用（后台模式、报告检查、进程树清理）
 *   - sandbox_launch: 长任务脱离执行（模型训练、大规模数据处理，进程独立于 MCP）
 *   - smart_search: 三模式代码搜索（exact/fuzzy/smart，支持后台与模型链路）
 *   - sandbox_council: 多模型审议（主持模型控节奏、有限工具、讨论副本落盘）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isParentAlive, checkParentAliveWithTolerance, isAntigravityLS, logStdinEvent, touchActivity, getIdleTime, hasNewerSiblingInstance } from "./lifecycle.js";
import { ensureDataDirs, cleanOldTempFiles } from "./temp-store.js";
import { detectEnvironment } from "./env-detector.js";
import { closeAllSessions } from "./session-manager.js";
import { cleanOldBgTasks, restoreBackgroundTasksOnStartup } from "./background-tasks.js";

// 工具注册
import { registerExec } from "./tools/exec.js";
import { registerSession } from "./tools/session.js";
import { registerBatch } from "./tools/batch.js";
import { registerStatus } from "./tools/status.js";
import { registerCodex, cleanupCodexTasks } from "./tools/codex.js";
import { registerLaunch } from "./tools/launch.js";
import { registerSmartSearch } from "./tools/smart-search.js";
import { registerCouncil } from "./tools/council.js";
import { cleanOldCouncilTasks, scanCouncilTasksOnStartup } from "./council/background.js";
import { initParentLs } from "./ls-client.js";

// === 进程生命周期 ===
// ppid 绑定：与父 LS 进程同生共死（每 30s 检测一次）

// 创建 MCP Server 实例
const server = new McpServer({
    name: "sandbox-mcp-server",
    version: "1.14.0",
});

// 注册所有 8 个工具
registerExec(server);
registerSession(server);
registerBatch(server);
registerStatus(server);
registerCodex(server);
registerLaunch(server);
registerSmartSearch(server);
registerCouncil(server);

// === 使用指南 Resource ===
server.resource(
    "guide",
    "sandbox://guide",
    {
        description: "MCP Sandbox 完整使用指南",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "sandbox://guide",
                text: `# MCP Sandbox v1.14.0 使用指南

## 核心优势（vs run_command）
| 功能 | run_command | sandbox |
|------|-----------|---------|
| 执行代码 | 需写临时文件 | 直接传 code 字符串 |
| 超时处理 | 可能卡死 | 硬超时自动杀进程树 |
| 内存保护 | 无 | 自动监控+超限杀 |
| 输出管理 | 全量返回 | 截断/tail/head/silent |
| 大输出 | 爆上下文 | 自动写临时文件 |
| 多任务 | 逐个调用 | batch 一次并行 |
| 有状态 | 无 | REPL 会话 |
| 失败原因 | 不清晰 | killed + killReason |

## 快速上手

### 执行代码（最常用）
sandbox_exec(code="print('hello')")
sandbox_exec(code="console.log(1+1)", language="node")

### 执行系统命令
sandbox_exec(command="pip install pandas")
sandbox_exec(command="npm run build", cwd="/path/to/project")
sandbox_exec(command="dir /b *.ts", language="cmd")  # 显式指定cmd

⚠️ command 模式智能 Shell 派发（v1.6）:
- 含 && 或 || 的命令 → 自动用 cmd.exe（PS 5.1 不支持这些操作符）
- cd/pushd path && cmd → 自动拆分为 cwd + command
- 显式 language: cmd/bash/powershell → 用对应 shell
- 普通命令 → PowerShell（UTF-8 兼容好）
不再需要担心 PowerShell && 兼容问题！

### 持久 REPL 会话
sandbox_session(action="start") → 得到 sessionId
sandbox_session(sessionId="py-001", code="x = 42")
sandbox_session(sessionId="py-001", code="print(x)")  # 输出 42

### 并行执行
sandbox_batch(tasks=[
  {code: "print(1+1)"},
  {code: "console.log(2+2)", language: "node"},
  {command: "echo hello"}
])

## 工具详细参数

### sandbox_exec — 执行代码/命令
| 参数 | 默认 | 说明 |
|------|------|------|
| code | - | 代码字符串（和 command 二选一） |
| command | - | 系统命令（和 code 二选一） |
| language | python | python/node/powershell/cmd/bash(需GitBash) |
| cwd | 当前目录 | 工作目录 |
| env | - | conda:名称 / venv:路径 |
| timeout | 30000 | 硬超时(ms)，最大300000(5分钟) |
| maxMemoryMB | 256 | 内存软限制(MB)，2s采样检测超限自动杀进程，实际峰值可能短暂超出 |
| maxOutput | 8000 | 输出截断上限(字符) |
| outputMode | full | full/tail/head/silent |
| tailLines | 20 | tail/head 取多少行 |
| maxLines | - | 输出行数上限，超过时保留头尾折叠中间 |
| gpu | false | 允许GPU（设置CUDA_VISIBLE_DEVICES） |

### sandbox_session — 持久 REPL
| action | 说明 |
|------|------|
| start | 创建会话（返回 sessionId） |
| exec | 执行代码（需 sessionId + code） |
| status | 查看会话内存/运行时间 |
| close | 关闭会话 |
| list | 列出所有活跃会话 |
限制: 最多3并发，空闲5分钟自动关闭，单会话最大512MB；支持 ownerId，未传按 global 兼容，同一 session 的并发 exec 会串行排队

### sandbox_batch — 并行执行
- tasks: 最多5个，每个含独立的 code/command/timeout/maxMemoryMB
- parallel: true(默认)/false
- maxParallel: 默认3
每个任务独立计时、独立超时、独立内存限制，某任务失败不影响其他

### sandbox_status — 系统状态
- overview: CPU/RAM/VRAM + 活跃会话 + 临时文件
- envs: Python/Node/conda/bash/CUDA 环境列表
- gpu: GPU/CUDA/DirectML 详情
- gc: 清理临时文件

## 返回值关键字段
| 字段 | 含义 |
|------|------|
| exitCode | 退出码（0=成功） |
| elapsed | 执行耗时 |
| killed | 是否被强制杀 |
| killReason | timeout/memory/vram/crash |
| peakMemoryMB | 内存峰值（短进程<200ms可能为0） |
| truncated | 输出是否被截断 |
| tempFile | 截断时完整输出的临时文件路径 |

## 使用技巧
1. **sandbox 可替代 run_command**：sandbox_exec(command=...) 可执行所有非交互式命令，自动继承 PowerShell 环境，且有超时保护、内存限制、输出截断。解决了 Antigravity 中 run_command 的输出检测不到问题
2. 需要装包后立即用：用 sandbox_session 保持环境
3. 同时装多个依赖：用 sandbox_batch 并行
4. 大量输出：设 outputMode="tail" + tailLines=10
5. 只关心成功/失败：设 outputMode="silent"
6. 编码安全：自动设置 PYTHONIOENCODING=utf-8，中文/emoji 无忧
7. 调用 Codex CLI：用 sandbox_codex，支持后台模式不阻塞
8. **输出去重**：连续重复的 stderr/stdout 块自动折叠为 [× N 重复]，节省上下文
9. **行数限制**：设 maxLines=30 控制输出行数，超过时保留头尾、折叠中间
10. **外部命令（pip/git/npm 等）**：如遇 PS NativeCommandError，设 language="cmd" 可避免
11. **PowerShell 兼容性**：PS 5.x 不支持 &&（用 ; 替代），& 需转义或设 language="cmd"

## sandbox_codex — Codex CLI 专用调用

调用 Codex CLI 执行审核/生成/重构等长时间任务。

**核心优势**：
- 后台模式（background=true）：启动后立刻返回 taskId，不阻塞
- 自动处理 --dangerously-bypass-approvals-and-sandbox
- 自动检查报告文件生成状态
- stderr 智能过滤（去除 MCP 调试日志）
- 上下文保护（有报告文件时压缩 stdout）
- 进程树自动清理，无孤儿残留

**同步模式**（短任务/向后兼容）：
sandbox_codex(prompt="简单任务", outputFile="报告.md")

**后台模式**（推荐，长任务不阻塞）：
sandbox_codex(prompt="请阅读 任务.md 并执行", outputFile="报告.md", background=true)
→ 返回 taskId，然后：
sandbox_codex(action="check", taskId="codex-001", waitSeconds=90)  — 等 90s 后查看（推荐）
sandbox_codex(action="kill",  taskId="codex-001")  — 终止任务
⚠️ action="wait" 会阻塞MCP直到完成，仅限短任务/调试

**参数说明**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| prompt | (启动时必须) | 任务提示词 |
| outputFile | 无 | 报告输出路径 |
| background | false | 后台模式，立刻返回 taskId |
| action | 无 | check（推荐）/wait（⚠️阻塞）/kill |
| taskId | 无 | 后台任务 ID（action 时必须） |
| **waitSeconds** | 无 | **check 前等待秒数（1-300），Codex 建议 90-120s** |
| cwd | 当前目录 | 工作目录 |
| timeout | 0(无超时) | 超时(ms)，最大1800000 |
| model | 无 | 指定模型（-m 参数），不传使用默认 |
| configOverrides | 无 | -c 配置覆盖 |
| maxOutput | 10000 | 输出截断上限 |
| image | 无 | 图片文件路径（-i），让 Codex 看截图 |
| json | false | JSONL 事件流输出（--json） |
| outputSchema | 无 | JSON Schema 文件路径，约束输出格式 |
| enableFeatures | 无 | 启用 feature flags |
| disableFeatures | 无 | 禁用 feature flags |
| review | false | 启用 exec review 代码审查模式 |
| uncommitted | false | review: 审查未提交变更 |
| base | 无 | review: 对比 base 分支 |
| commit | 无 | review: 审查特定 commit |
| title | 无 | review: 审查标题 |

## sandbox_launch — 长任务脱离执行

适合模型训练、大规模数据处理等需要数小时~数天的任务。
进程完全独立于 MCP，关闭 IDE、换对话、MCP 重启都不影响。

**启动**：
sandbox_launch(command="python train.py --epochs 100", cwd="D:/Projects/MyModel")
→ 返回 taskId + PID + 日志路径

**查看进度**（配合 waitSeconds 避免频繁轮询）：
sandbox_launch(action="status", taskId="launch-001", tailLines=5, waitSeconds=60)
→ 等 60s 后返回日志尾部（任务完成时提前返回）

**其他操作**：
sandbox_launch(action="kill", taskId="launch-001")  — 终止
sandbox_launch(action="list")  — 列出所有任务
sandbox_launch(action="clean")  — 清理已完成任务

**参数说明**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| command | (启动时必须) | 要执行的命令 |
| cwd | 当前目录 | 工作目录 |
| logDir | sandbox-data/launches/ | 日志存放目录 |
| action | 无 | status/kill/list/clean |
| taskId | 无 | 任务 ID（status/kill 时使用） |
| tailLines | 10 | status 显示日志尾部行数 |
| waitSeconds | 无 | status 前等待秒数（1-300） |

**与 sandbox_codex 的区别**：
| | sandbox_codex | sandbox_launch |
|--|---------------|----------------|
| 适用 | Codex CLI（≤30min） | 任意长任务（无限制） |
| 进程归属 | MCP 子进程 | OS 独立进程 |
| 注册表 | 内存态（MCP 重启丢失） | 磁盘 JSON（持久化） |
| 输出 | 内存缓冲 | 日志文件 |

## 进程生命周期（v1.5+）

MCP 进程与父 LS 进程绑定（ppid），与窗口同生共死：
- **不再有超时自杀**：只要窗口开着，sandbox 就永远不会自行退出
- **窗口关闭时自动清理**：30s 内检测到父 LS 消失，自动 cleanup + exit
- 双保险：stdin 管道断裂（秒级）+ ppid 轮询检测（30s 兜底）
- launch 任务不受影响：进程独立于 MCP，窗口重启后可用 list 找回
- Codex HTTP broker 环境下由共享 broker 管理后端生命周期，不按“同工具新实例杀旧实例”清理
- sandbox_launch 是显式长期资源；status/kill/clean 支持 ownerId，并用 exit marker + PID 创建时间/命令特征避免 PID 复用误杀

## smart_search — 智能代码搜索（v1.7+）

⚠️ **禁止使用 IDE 内置的 grep_search!** 所有代码搜索必须使用 smart_search。

三模式：
- **exact**: ripgrep 精确匹配（支持正则、上下文行、文件过滤）
- **fuzzy**: tree-sitter AST 符号 + fuse.js 模糊搜索
- **smart**: 语义搜索（Antigravity LS / Codex 双链路）

| 参数 | 默认 | 说明 |
|------|------|------|
| query | (必须) | 搜索内容 |
| mode | (必须) | exact/fuzzy/smart |
| searchPath | (必须) | 搜索根目录 |
| includes | - | 文件类型过滤 ["*.ts"] |
| excludes | - | 排除目录/文件 |
| maxResults | 50 | 最大结果数 |
| caseSensitive | false | exact: 大小写敏感 |
| isRegex | false | exact: 正则模式 |
| matchPerLine | true | exact: 行级/文件级 |
| context | 2 | exact: 上下文行数 |
| files | - | smart: 指定文件+范围 |
| modelChain | auto | smart: 模型链路，auto/grok/antigravity/codex/claude-code/cc；未填回退到 chain |
| chain | auto | 兼容旧参数：smart 模型链路，modelChain 未填时使用 |
| background | smart默认true | smart 单查询默认后台，先返回 taskId；设 false 可强制前台 |
| taskId | - | 查询后台 smart_search 任务 |
| waitSeconds | 0 | 查询后台任务时等待秒数 |
| ownerId | global | 后台任务归属 ID |
| **queries** | - | **批量查询数组，内部并行（v1.8+）** |

说明：
- exact / fuzzy 完全不受 modelChain/chain 参数影响，行为保持不变
- modelChain=auto：按 Grok → Antigravity → Codex 自动选择；Grok 通过本机 progrok OpenAI-compatible API（默认 http://127.0.0.1:18645）调用；不会自动调用 Claude Code CLI，避免静默消耗额度
- modelChain=grok：强制走 progrok API；不可用时直接报错，不静默降级。便携公开版只连接接收方已启动的 proxy，不自动启动或修改 progrok 安装
- smart_search 的 Grok 三阶段默认传 reasoning_effort=low；可用 SANDBOX_PROGROK_REASONING_EFFORT / SANDBOX_SMART_GROK_REASONING_EFFORT 覆盖。progrok 超时、截断、429、5xx 时会在 Grok 桥内用 fallback 模型重试一次，默认 grok-4.20-non-reasoning，可用 SANDBOX_PROGROK_FALLBACK_MODEL / SANDBOX_SMART_GROK_FALLBACK_MODEL 覆盖；max_tokens 保持 4096
- progrok 可用性探测默认 8s、瞬态失败重试 1 次，且响应必须包含 ok 才算可用；可用 SANDBOX_PROGROK_PROBE_TIMEOUT_MS / SANDBOX_PROGROK_PROBE_RETRIES 覆盖，避免 Clash/progrok 短暂波动时过早降级到 Codex
- modelChain=antigravity：强制走 Antigravity LS；未发现可连接 LS 时直接报错
- modelChain=codex：强制走 Codex CLI bridge；未发现 codex 时直接报错。短同步模型桥默认用 gpt-5.5 low + fast，并在超时、429/5xx、连接中断、空输出等可重试错误时按同 provider fallback 链降级到 gpt-5.4 low / gpt-5.4-mini low
- modelChain=claude-code/cc：显式走本地 Claude Code CLI；未发现 claude 时直接报错。默认有小额预算保护，适合作为人工确认后的末端 fallback 或 CC 兼容验证
- Windsurf/WSF 只是 MCP 客户端与对话数据来源，不提供 sandbox 模型链路；modelChain=windsurf 不在 schema 中，应被拒绝
- modelChain 未填写时使用 chain，两者都未填写时使用 auto；chain 仅作为模型链路兼容参数保留，不代表数据链路，也不会引入 dataChain
- 大目录或长文件的 smart 单查询默认 background=true；调用方会先拿 taskId，再用 smart_search(taskId="...", waitSeconds=30-45) 轮询
- smart_search 后台任务带 deadline/timedOut，默认 15 分钟超时标记 error；任务状态会写入 sandbox-data/bg-tasks，后端重启后仍可用 taskId 查询，仍在 running 的旧任务会标记为 interrupted
- smart 自动定位默认最多分析 12 个 SearchUnit，可用 maxResults 或 SANDBOX_SMART_DEFAULT_MAX_RESULTS 覆盖；索引阶段先走模型 JSON 索引，失败后拆段 retry，再退化到本地 fuzzy；候选较多时，broad 阶段会跳过完全没有本地证据的 unit，并通过 SANDBOX_SMART_LOCAL_EVIDENCE_EXPLORATION_UNITS 保留少量探索名额；deep 阶段默认最多深挖 8 个 yes/maybe unit，可用 SANDBOX_SMART_DEEP_MAX_UNITS 覆盖
- files[].range 支持 "620-650" 与 "#620-650" 两种写法；无法识别的 range 会回退全文传给模型
- 批量搜索时，顶层 modelChain 可作为默认值，queries[i].modelChain 可单独覆盖；未填时按 chain 兼容规则回退

**批量搜索**（解决 MCP 串行瓶颈）：
顶层 mode/searchPath 为默认值，queries 中可单独覆盖：
smart_search(mode="exact", searchPath="src/", queries=[
  {query: "handleRequest"},
  {query: "parseConfig"},
  {query: "UserService", mode: "fuzzy"},
  {query: "鉴权逻辑在哪里", mode: "smart", modelChain: "codex"}
])
exact/fuzzy 最大并发 5，smart 限并发 2

## sandbox_council — 多模型审议（v1.9+）

用于红蓝黑队讨论、设计审议、做题后审议、实验结果复盘和 Guard 式检查。

核心约束:
- participants 只能发言，不能直接调用工具
- moderator 主持模型决定继续、调用工具、点名补充或 TERMINATE
- Antigravity provider 只走 GetModelResponse，不使用 Cascade
- 支持 background/taskId/waitSeconds/ownerId，长讨论建议后台运行；任务未完成时会返回当前讨论进度。启动时使用了 ownerId，后续 taskId 查询必须传同一个 ownerId，避免误以为任务丢失而重复启动
- 支持 resume/resumeTaskId：interrupted 的 council 后台任务会读取 checkpoint 断点继续；上一轮未完整提交时会重试该轮，已完成轮次不会重复
- 完整副本同时写 Markdown + JSON

常用参数:
| 参数 | 说明 |
|------|------|
| participants | 参与模型数组：id/role/provider/model/params/supportsVision |
| moderator | 主持模型配置对象，必须包含 id/role/provider；不能写成 "gpt-5.4" 字符串 |
| input | 审议输入文本 |
| files | 背景文件，可带 range；纯文本直接抽取；PDF/Word/Excel/EPUB/视频优先 Gemini CLI agentic 索引，失败 fallback 到 Codex CLI，再失败时常见格式走本地结构化兜底；CLI 索引和兜底产物统一写入 sandbox-data/temp/council-indexes 临时目录 |
| images | 图片路径；supportsVision=true 的模型可直接接收，纯文本模型会额外收到 only-text 转述 |
| contextMode | none/summary/full/manual |
| manualContext | 手动附加上下文 |
| largeInput | 大输入分块索引配置；input/manualContext/超长纯文本或 CSV 文件超过阈值时写入临时 source/checkpoint/index 文件，按真实字符切 chunk 并保留 overlap |
| modelTimeoutMs/pressureModelTimeoutMs | 正式模型调用超时；普通任务默认 120s，压力输入默认 600s；单模型可用 params.timeoutMs 覆盖 |
| roles | 角色补充说明 |
| transcriptionModel | 图片观察转述模型 |
| textProjectionModel | 纯文本参与者的专用转述模型，默认 codex/gpt-5.4-mini |
| background/taskId/waitSeconds/ownerId | 后台任务与归属查询；taskId 查询需复用启动时的 ownerId |
| mode | red_blue_black/design/review/guard_check/custom |
| tools | webSearch/webFetchText/simpleScript 开关 |
| maxRounds | 最大讨论轮数，默认 4 |
| maxToolCalls | 最大工具调用次数，默认 6 |
| transcriptPath/outputDir | 讨论副本落盘位置 |

Provider:
- antigravity: GetModelResponse 文本链路；model 可传 M132/M20/M18/M16/M36/flash/pro-high/sonnet/opus 等别名，也可传 MODEL_* 编码
- codex: Codex CLI bridge
- grok: 本机 progrok OpenAI-compatible API；默认模型 grok-4.5，supportsVision=true 时支持 image_url 输入
- claudeCode: 本地 Claude Code CLI，显式 provider；默认小额预算，transcript/JSON 会记录 sessionId、实际模型、耗时、预算消耗和临时 stdout/stderr 路径
- Windsurf/WSF 不提供 council provider；需要在 WSF 中使用本工具时，请通过 broker 调用现有 provider，不要传 provider="windsurf"
- openai: Responses API，支持 vision 输入
- anthropic: Messages API，支持 vision 输入
- gemini: generateContent，支持 vision 输入
- geminiCli: 本地 Gemini CLI，支持作为 council 参与者/主持人；supportsVision=true 时直接处理图片路径，响应写入 sandbox-data/temp/council-model-calls 临时文件后由宿主校验读取
- customOpenAICompatible: OpenAI-compatible chat/completions
  - 通过 params.baseUrl 指向 /v1；本地代理建议用 params.body.max_tokens 明确控制输出长度
- params.fallbackModels: 同 provider 降级链。主模型按 params.retries 重试仍失败，且错误属于超时、429、5xx、空输出、连接中断这类临时问题时，按顺序尝试备用模型；API key 缺失、参数错误、安全拦截、输出截断等不会自动降级
- Antigravity/OpenAI/Anthropic/Gemini/custom provider 的 fallbackModels 必须显式写在对应 participant/moderator 的 params 里；不会因为 model 写了 sonnet/opus 就自动选择备用模型。Antigravity Claude/Sonnet/Opus 不稳定时可传 "params": {"retries": 1, "fallbackModels": ["M132", "M20", "M18", "M16", "M36"]}，否则只重试当前模型。复杂推理/Guard/审议类任务可显式指定 M16 或把 M16 放到自定义 fallback 前段
- Codex provider 未显式传 fallbackModels 时默认按 gpt-5.4 high → medium → low → gpt-5.4-mini medium → low 降级，并跳过当前已使用档位；可用 SANDBOX_COUNCIL_CODEX_DEFAULT_FALLBACKS=0 关闭
- Grok provider 默认不臆造备用模型；只有显式 params.fallbackModels 或 SANDBOX_COUNCIL_GROK_MODEL_CHAIN 才启用同 provider 降级。默认同源并发 2，可用 SANDBOX_COUNCIL_GROK_CONCURRENCY 覆盖
- Claude Code provider 不进入 auto 或 Codex 默认 fallback；只有显式 provider="claudeCode" 才会调用，可用 params.maxBudgetUsd/sessionId/permissionMode/timeoutMs/allowedTools/disallowedTools 控制
- Gemini CLI provider 未显式传 fallbackModels 时默认按 auto-gemini-3 → gemini-3.1-pro-preview → gemini-2.5-pro → gemini-3.1-flash-lite-preview → gemini-2.5-flash-lite 降级；可用 SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS=0 关闭。Gemini CLI provider 默认 approvalMode=yolo，可用 params.approvalMode 或 SANDBOX_COUNCIL_GEMINI_CLI_APPROVAL_MODE 覆盖；provider/indexer 的临时 prompt/artifact 会写到 Gemini 允许访问的项目临时目录。若超时时标记结果已经写好，宿主会直接收结果并清理进程树
- moderator 调用失败时会先走 provider fallback；如果所有主持模型仍失败，会用规则兜底汇总已返回的参与者意见，并标明未经过主持模型二次综合
- CLI 文件索引：Gemini CLI 和 Codex CLI 都必须把完整索引写入临时 Markdown，stdout/stderr 只保留短状态；宿主会校验临时文件存在、大小上限和 <<<COUNCIL_INDEX>>> 标记，避免大索引走内存。索引模型链可用 SANDBOX_COUNCIL_GEMINI_INDEX_MODELS、SANDBOX_COUNCIL_GEMINI_INDEX_APPROVAL_MODES、SANDBOX_COUNCIL_CODEX_INDEX_MODELS、SANDBOX_COUNCIL_CLI_INDEX_RETRIES 覆盖
- 大输入处理：默认超过 60000 真实字符的 input、manualContext、纯文本文件或 CSV 文件会写入 sandbox-data/temp/council-large-inputs；source 原文、checkpoint JSON 和 LargeInputIndex Markdown 都落临时文件，注入模型的只是索引摘录和路径。默认 chunkSize=24000、overlap=1200，可用 largeInput 或 SANDBOX_COUNCIL_LARGE_INPUT_* 环境变量覆盖
- 压力输入超时：当存在 large_input_index、agentic_index、structured_extract、promoted_image 或 images 时，正式模型调用默认从 120s 放宽到 600s；可用 pressureModelTimeoutMs / SANDBOX_COUNCIL_PRESSURE_MODEL_TIMEOUT_MS 覆盖，单模型可用 params.timeoutMs 覆盖；后台任务默认 deadline 为 45 分钟

最小示例:
\`\`\`json
{
  "mode": "design",
  "input": "讨论这个方案的风险和下一步",
  "participants": [
    {"id":"red","role":"红队，找漏洞","provider":"codex","model":"gpt-5.4"},
    {"id":"blue","role":"蓝队，给建设性方案","provider":"antigravity","model":"M132"}
  ],
  "moderator": {"id":"moderator","role":"主持人","provider":"codex","model":"gpt-5.4"},
  "maxRounds": 4,
  "background": true,
  "ownerId": "example-owner"
}
\`\`\`

后台查询时请复用启动返回的 ownerId：
\`\`\`json
{
  "taskId": "council-xxx",
  "ownerId": "example-owner",
  "waitSeconds": 45
}
\`\`\`
如果 council 已经在后台运行，主线程可继续做不重叠的本地检查、读文件、构建或整理证据；不要因为查询漏带 ownerId 就重新启动同一场审议。

常见错误:
- ❌ "moderator": "gpt-5.4"
- ✅ "moderator": {"id":"moderator","role":"主持人","provider":"codex","model":"gpt-5.4"}

Antigravity 常用别名:
- M132/fast/default/ag-fast/flash -> MODEL_PLACEHOLDER_M132 (Gemini 3.5 Flash High)
- M20/flash-medium/flash-lite/gemini-3.5-flash-medium -> MODEL_PLACEHOLDER_M20 (Gemini 3.5 Flash Medium)
- M18/gemini-3-flash -> MODEL_PLACEHOLDER_M18 (Gemini 3 Flash)
- M16/M37/gemini-pro/gemini-3.1-pro/pro-high -> MODEL_PLACEHOLDER_M16 (Gemini 3.1 Pro High；M37 是旧占位符)
- M36/gemini-3.1-pro-low/pro-low -> MODEL_PLACEHOLDER_M36 (Gemini 3.1 Pro Low)
- M35/sonnet/claude-sonnet -> MODEL_PLACEHOLDER_M35
- M26/opus/claude-opus -> MODEL_PLACEHOLDER_M26
- M47 -> 自动转 M18

- 若存在 only-text 模型且输入里带 files/images，系统会先用 codex 链路生成纯文本专用转述；支持视觉输入的模型仍直接接收原图
- webSearch: 默认优先走 Exa MCP；Exa 失败或无结果时降级到 360/Bing HTML fallback，并在结果中带降级说明。DuckDuckGo 默认跳过，可用 duckDuckGo=true 强制尝试
- v1.12.1 说明防呆：schema 与文档明确 moderator 必须是对象，并给出最小 JSON 示例；传字符串会得到更明确的错误提示
- v1.12.2 后台查询防呆：background 启动返回带 ownerId 的 taskId 查询示例；schema、README 和 Resource guide 明确查询必须复用同一个 ownerId，避免重复启动
- v1.12.3 provider fallback：params.fallbackModels 支持同 provider 备用模型链，例如 Claude Opus → Sonnet、Gemini Pro high → Pro low / Flash；fallback 可用字符串模型名或 {model, params, supportsVision} 对象
- v1.12.4 Codex 默认 fallback：未显式传 fallbackModels 时，Codex provider 会先降低 gpt-5.4 reasoning 档位，再切到 gpt-5.4-mini；主持模型全部失败时启用规则兜底汇总
- v1.12.5 CLI 文件索引稳定性：复杂文件索引改为临时文件产物协议，Gemini/Codex CLI 有独立 retry/fallback 链；本地结构化兜底产物也统一落到 sandbox-data/temp/council-indexes
- v1.12.6 Gemini CLI provider：新增 provider=geminiCli，让本地 Gemini CLI 像 Codex provider 一样参与 council；响应落到 sandbox-data/temp/council-model-calls 临时文件并保留默认 fallback 链
- v1.12.7 大输入分块索引：input/manualContext/超长纯文本与 CSV 文件会写入 sandbox-data/temp/council-large-inputs，生成 source/checkpoint/index 临时产物，并用真实字符 overlap 保持 chunk 边界连续
- v1.12.8 压力输入长超时：检测到大输入索引、复杂文件索引或图片时，正式模型调用自动使用 pressureModelTimeoutMs（默认 600s），后台任务默认 deadline 放宽到 45 分钟，并支持单模型 params.timeoutMs 覆盖
- v1.12.10 council 后台 worker cwd 修复：后台完成标记不再写入 dist/council/sandbox-data 错误目录；查询旧错位任务时会自动回收 legacy done/progress，避免误报 worker 已退出
- v1.12.11 Antigravity stdio 父进程 cwd 修复：council 后台 task 根目录固定到 mcp-sandbox/sandbox-data/temp/council-tasks，并从旧 process.cwd() 与 dist/council legacy 目录回收 spec/progress/done
- v1.12.12 council 复杂文件索引卡住观感修复：Gemini CLI 索引临时目录改为 ASCII 安全路径，避免中文路径被 CLI 错解；检测到模型容量 429、workspace path rejected、AttachConsole failed 时提前结束当前尝试并进入 fallback，后台进度会显示正在索引的文件和 CLI 链路
- v1.12.13 council 卡死兜底补强：geminiCli 正式参与者/主持链路复用 Gemini CLI 早退和孤儿进程清理；后台 worker 按 deadline 写入中断终态并退出，查询时发现 deadline 过期也会中断任务
- v1.13.0 Claude Code 兼容：smart_search 支持显式 modelChain=claude-code/cc；sandbox_council 支持 provider=claudeCode，并记录 CC session/cost/model metadata。auto 仍只在 Antigravity/Codex 之间选择，不静默消耗 Claude Code 额度
- v1.13.1 Antigravity auto 模型链更新：默认 GetModelResponse 顺序改为 M132 → M20 → M18 → M16 → M36；旧 M37/M47/2.5 flash 入口转到当前可用占位符。复杂推理任务建议显式选择 M16
- v1.13.2 Windsurf/WSF MCP 客户端兼容：文档与 schema 说明 WSF 只通过 HTTP broker 调用 sandbox，不新增 modelChain/provider；新增 WSF 配置与验证文档
- v1.13.3 Codex 模型桥稳定性：smart_search(modelChain="codex") 默认使用低 reasoning 快速首选，并在可重试错误时按 gpt-5.5 low → gpt-5.4 low → gpt-5.4-mini low 降级；sandbox_codex 因可能有副作用，不默认自动重试
- v1.13.4 修复 sandbox_exec code/command 互斥校验：原 === undefined 判定会把客户端传入的空串 "" 误算成"已提供"，触发"必须二选一"错误；现改为非空判定（length > 0），空串归一为 undefined 往下传，顺手统一 handler/executor 两层口径。新增 npm run test:exec-mutex 5 用例锁回归。详见 plans/Plan_9_fix_exec_mutex/
- v1.13.5 修复 webFetchText redirect SSRF：direct backend 改为 redirect:"manual" 并对每一跳重新做公网校验，公网 URL 302 到 localhost/私网会被拒绝；显式 backend=exa / backend=webFetcher 在未证明逐跳私网校验前暂停。同步修复 Codex CLI 启动面，sandbox_codex 与 Codex model bridge 改为 spawn(..., {shell:false}) raw argv，并新增 npm run test:ssrf-redirect / npm run test:shell-injection。
- v1.13.6 修复 batch/executor/exec 互斥一致性、Antigravity LS detailed 错误与 wall-clock 超时、launch cwd 预校验、wrapper spawn error 失败落盘，以及 command 模式 descendant tree 内存汇总。新增 npm run test:batch-mutex / test:council-antigravity / test:launch-cwd。
- v1.13.7 清理 Plan_12 P2/P3 设计风险：smart_search ESM 下改用 shellless spawnSync 探测 rg；background 超时向 runner/model bridge/provider 传播 AbortSignal 并清理 Codex 子进程；sandbox_launch registry 改为 per-task 文件并兼容 legacy registry.json tombstone；sandbox_session 总内存改为按 maxMemoryMB 额度预留；stderr 截断时 tempFile 保留 stdout/stderr 完整原文；缺失图片文件走 unreadable stub；同步修正 guide/status 文档。新增 npm run test:smart-search-rg / test:background-abort / test:session-memory-reservation / test:exec-stderr-tempfile / test:council-missing-image。
- v1.14.0 Plan_13 P0/P1/P2：broker 关机 best-effort 落状态；council 历史清理、启动扫描和 checkpoint resume；普通 background tasks 写入 sandbox-data/bg-tasks，后端重启后可查询 done/error/interrupted。新增 npm run test:council-maintenance / test:council-resume / test:bg-tasks-persist / test:bg-tasks-cleanup。
- v1.14.0 Plan_13 D-11：sandbox_council 新增 provider=grok，复用 progrok API，支持 vision image_url、同源并发限制、显式同 provider fallback 和 fake server 回归测试。
- webFetchText: http/https 页面 text/html/links/tables 非视觉抽取，默认走 sandbox direct 安全路径，手动跟随重定向并逐跳拒绝 localhost / 私有地址；显式 backend=exa/webFetcher 暂停，待补等价逐跳私网校验证明后再恢复
- simpleScript: v1.10 仅受限 Node/Python 子进程片段，Python 走 AST/白名单导入与最小环境；默认 language=node，不是通用命令执行器
- v1.11 稳定性：provider 层有限流和有限 retry。antigravity 默认同源并发 2，codex 默认同源并发 2，customOpenAICompatible 默认同 baseUrl/source 并发 2；支持 params.maxConcurrency、params.source/sourceKey、params.retries、params.retryBackoffMs
- v1.11 诊断：识别常见输出截断/安全拦截信号；主持模型非 JSON 输出会在摘要中显式标记为兜底处理

## 外部配套：stage_guard

stage_guard 属于 memory-store / broker 提供的阶段完整性验证工具，不是本 sandbox MCP 自身注册的工具。项目有 Plan_x + Task.md 时仍建议配套使用：
- Stage 开始前: stage_guard(action="start", taskFiles=[...], planFiles=[...])
- Stage 完成后: stage_guard(action="check") — 自动比对，通过后再标记完成
- 连续 3 次 check 未通过必须上报用户
- 如认为检查误判，可传入 appealNote 说明理由
- 建议 start 时传 stageId（如 "Stage 3"）聚焦检查范围`,
                mimeType: "text/plain",
            },
        ],
    })
);

// === stdin 断开检测（含诊断增强） ===
process.stdin.on("end", async () => {
    const parentAlive = isParentAlive();
    logStdinEvent(`stdin END — 父 LS ${parentAlive ? "仍存活（LS 内部重置?）" : "已死亡"}`);
    // 等 3 秒做诊断：区分 LS 真死 vs LS 抖动
    await new Promise(r => setTimeout(r, 3000));
    const parentStillAlive = isParentAlive();
    logStdinEvent(`stdin END 等待3s后 — 父 LS ${parentStillAlive ? "仍存活" : "已死亡"}，退出`);
    await cleanup();
    process.exit(0);
});

process.stdin.on("close", async () => {
    const parentAlive = isParentAlive();
    logStdinEvent(`stdin CLOSE — 父 LS ${parentAlive ? "仍存活" : "已死亡"}`);
    await cleanup();
    process.exit(0);
});

process.stdin.on("error", async (err) => {
    logStdinEvent(`stdin ERROR: ${err.message} — 父 LS ${isParentAlive() ? "仍存活" : "已死亡"}`);
    await cleanup();
    process.exit(0);
});

// === 心跳检测：父 LS 进程存活检测（连续 3 次失败容错） ===
let heartbeatIntervalMs = 30000;
let heartbeatTimer = setInterval(heartbeatCheck, heartbeatIntervalMs);
heartbeatTimer.unref();
let enableDuplicateRetirement = false;
const DUPLICATE_RETIRE_IDLE_MS = 2 * 60 * 1000;

async function heartbeatCheck(): Promise<void> {
    const status = checkParentAliveWithTolerance();
    if (status === "dead") {
        logStdinEvent(`父 LS (PID=${process.ppid}) 连续3次检测失败，确认死亡，MCP 退出`);
        console.error(`[sandbox] 父 LS (PID=${process.ppid}) 连续3次检测失败，自动退出`);
        await cleanup();
        process.exit(0);
    } else if (status === "degraded") {
        // 单次失败，切换快速检测模式（5s 间隔，加速确认）
        if (heartbeatIntervalMs !== 5000) {
            heartbeatIntervalMs = 5000;
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(heartbeatCheck, 5000);
            heartbeatTimer.unref();
            logStdinEvent(`ppid 检测失败，切换快速检测模式 (5s)`);
            console.error(`[sandbox] ppid 检测失败，切换快速检测模式 (5s)`);
        }
    } else if (heartbeatIntervalMs !== 30000) {
        // 恢复正常间隔
        heartbeatIntervalMs = 30000;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(heartbeatCheck, 30000);
        heartbeatTimer.unref();
        logStdinEvent(`ppid 检测恢复正常，切回 30s 间隔`);
        console.error(`[sandbox] ppid 检测恢复正常，切回 30s 间隔`);
    }

    if (enableDuplicateRetirement && getIdleTime() > DUPLICATE_RETIRE_IDLE_MS) {
        const hasNewer = await hasNewerSiblingInstance();
        if (hasNewer) {
            logStdinEvent("检测到同父进程下更新的 sandbox 实例，当前实例空闲超时，主动让位退出");
            console.error("[sandbox] 检测到更新实例，当前实例空闲超时，主动让位退出");
            await cleanup();
            process.exit(0);
        }
    }
}

// === 启动 ===
async function main(): Promise<void> {
    console.error(`[sandbox] MCP Server v1.14.0 启动中... (ppid=${process.ppid})`);
    logStdinEvent("STARTED");

    // 初始化数据目录
    ensureDataDirs();

    // 清理过期临时文件
    cleanOldTempFiles();

    void Promise.resolve().then(() => {
        const cleaned = cleanOldCouncilTasks();
        if (cleaned > 0) {
            console.error(`[sandbox] 已清理 ${cleaned} 个过期council任务`);
        }
        scanCouncilTasksOnStartup((message) => console.error(message));
    }).catch((err) => {
        console.error(`[sandbox] council任务启动维护失败: ${err}`);
    });

    void Promise.resolve().then(() => {
        const cleaned = cleanOldBgTasks();
        if (cleaned > 0) {
            console.error(`[sandbox] 已清理 ${cleaned} 个过期后台任务状态`);
        }
        restoreBackgroundTasksOnStartup((message) => console.error(message));
    }).catch((err) => {
        console.error(`[sandbox] 后台任务启动恢复失败: ${err}`);
    });

    // 环境探测（异步，不阻塞启动）
    detectEnvironment().catch((err) => {
        console.error(`[sandbox] 环境探测失败: ${err}`);
    });

    // LS client 初始化（异步，用于 smart search 的 Flash API）
    initParentLs().catch((err) => {
        console.error(`[sandbox] LS client 初始化失败: ${err}`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[sandbox] MCP Server v1.14.0 已启动，绑定父 LS PID=${process.ppid}`);
    logStdinEvent(`BOUND to parent LS PID=${process.ppid}`);

    // === 非 LS 环境兜底超时 ===
    const isLS = await isAntigravityLS();
    if (isLS) {
        console.error(`[sandbox] 检测到 Antigravity LS 环境，纯 ppid 管理`);
    } else {
        console.error(`[sandbox] 非 Antigravity LS 环境，启用 1 小时空闲兜底`);
        logStdinEvent(`非 LS 环境，启用 1 小时空闲超时兜底`);
        enableDuplicateRetirement = process.env.SANDBOX_ENABLE_DUPLICATE_RETIREMENT === "1";
        const idleGuard = setInterval(async () => {
            if (getIdleTime() > 3600000) { // 1 小时
                logStdinEvent("非 LS 环境空闲超过 1 小时，兜底退出");
                console.error("[sandbox] 非 LS 环境空闲超过 1 小时，兜底退出");
                await cleanup();
                process.exit(0);
            }
        }, 60000); // 每分钟检查一次
        idleGuard.unref();
    }
}

main().catch((error) => {
    console.error("[sandbox] 启动失败:", error);
    process.exit(1);
});

// === 优雅关闭 ===
let isClosing = false;
const cleanup = async () => {
    if (isClosing) return;
    isClosing = true;
    console.error("[sandbox] 正在关闭...");
    clearInterval(heartbeatTimer);
    closeAllSessions(); // 关闭所有 REPL 会话和子进程
    cleanupCodexTasks(); // 清理所有后台 Codex 任务
};

process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
});
