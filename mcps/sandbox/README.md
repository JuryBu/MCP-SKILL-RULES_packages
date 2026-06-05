# MCP Sandbox v1.13.3

代码执行沙箱 MCP Server，解决 Antigravity IDE 中 run_command 的超时卡死、临时文件繁琐、输出管理粗糙等痛点。

## 功能

| 工具 | 功能 |
|------|------|
| `sandbox_exec` | 执行代码片段或系统命令，支持硬超时、内存限制、GPU、输出截断、重复输出折叠 |
| `sandbox_session` | 持久 REPL 会话，变量状态跨调用保持 |
| `sandbox_batch` | 一次调用并行执行多个任务 |
| `sandbox_status` | 查看系统状态、可用环境、GPU/CUDA 信息 |
| `sandbox_codex` | Codex CLI 专用调用，后台模式不阻塞，自动报告检查，支持 gpt-5.5/exec review |
| `sandbox_launch` | 长任务脱离执行（模型训练等），进程独立于 MCP，磁盘持久化 |
| `smart_search` | 三模式代码搜索（exact/fuzzy/smart），smart 支持 `modelChain=auto|antigravity|codex|claude-code|cc` 三链路显式选择，兼容 `chain` |
| `sandbox_council` | 多模型审议工具，主持模型控制轮次和有限工具调用，Markdown/JSON 副本落盘 |

## 核心优势（vs run_command）

- ✅ 直接传代码字符串，不用写临时文件
- ✅ 硬超时 + 自动杀进程，不会卡死
- ✅ 内存限制，防止吃光系统内存
- ✅ 输出截断/模式控制，不爆上下文
- ✅ 连续重复输出自动折叠（`[× N 重复]`）
- ✅ maxLines 行数限制（保留头尾，折叠中间）
- ✅ 持久 REPL 会话，有状态交互
- ✅ 并行执行多任务
- ✅ GPU/CUDA 支持
- ✅ 清晰的失败原因（timeout/memory/vram/crash）

## 进程生命周期（v1.9）

MCP 进程与父 LS 进程绑定（ppid），容错管理：
- **ppid 容错**: 单次失败不退出，切 5s 快速检测模式，连续 3 次失败确认死亡
- **stdin 诊断**: 管道断裂时记录 ppid 状态，区分 LS 真死 vs 内部重置
- **LS 环境**: 检测到 Antigravity LS → 纯 ppid 管理，无超时限制
- **非 LS 环境**: 其他 IDE 使用时 → 启用 1 小时空闲兜底退出

## smart_search 模型链路

`smart_search` 的 `exact` / `fuzzy` 模式行为保持不变，只有 `smart` 模式使用模型链路参数。新参数是 `modelChain`，旧参数 `chain` 保留兼容：

- `modelChain="auto"`：当前宿主优先。Antigravity 宿主优先走 LS，Codex/其他宿主优先走 Codex bridge；不会自动调用 Claude Code CLI，避免静默消耗额度
- `modelChain="antigravity"`：强制走 Antigravity LS 的 `GetModelResponse`
- `modelChain="codex"`：强制走本地 `codex exec` 模型桥
- `modelChain="claude-code"` / `modelChain="cc"`：显式走本地 Claude Code CLI，适合人工确认后做末端 fallback 或 CC 兼容测试
- Windsurf / WSF 只是 MCP 客户端和对话数据来源，不提供 Sandbox 模型链路；`modelChain="windsurf"` 不在 schema 中，应被拒绝
- `modelChain` 未填写时使用 `chain`，两者都未填写时使用 `auto`。
- `chain` 仅作为模型链路兼容参数保留，不代表数据链路，也不会引入 `dataChain`。

补充说明：

- 批量搜索时，顶层 `modelChain` 可作为默认值，`queries[i].modelChain` 可单独覆盖；未填时按 `chain` 兼容规则回退
- `modelChain` 仅影响 `smart` 模式；`exact` / `fuzzy` 完全不受影响
- `modelChain="antigravity"` 需要存在可连接的 Antigravity LS；`modelChain="codex"` 需要本机可调用 `codex` CLI；`modelChain="claude-code"` 需要本机可调用 `claude` CLI
- Antigravity LS 模型默认值：`SANDBOX_LS_MODEL` 未设置时使用 `MODEL_PLACEHOLDER_M132`（Gemini 3.5 Flash High）；默认 fallback 为 `MODEL_PLACEHOLDER_M132,MODEL_PLACEHOLDER_M20,MODEL_PLACEHOLDER_M18,MODEL_PLACEHOLDER_M16,MODEL_PLACEHOLDER_M36`，可用 `SANDBOX_LS_MODEL_FALLBACKS` 覆盖。`MODEL_PLACEHOLDER_M37` 会转到当前 Pro High `M16`，`MODEL_PLACEHOLDER_M47` 会转到 `M18`，旧 `MODEL_GOOGLE_GEMINI_2_5_FLASH*` 会转到新 Flash 占位符。
- Codex 模型桥默认值：`gpt-5.5` + `model_reasoning_effort=low` + `model_speed_tier=fast`，用于 `smart_search(modelChain="codex")` 这类短同步模型桥；可用 `SANDBOX_CODEX_BRIDGE_REASONING` 覆盖
- Codex 模型桥稳定性：默认 fallback 链为 `gpt-5.5:low → gpt-5.4:low → gpt-5.4-mini:low`，只在超时、429/5xx、连接中断、空输出等可重试错误时降级；可用 `SANDBOX_CODEX_BRIDGE_FALLBACKS`、`SANDBOX_CODEX_BRIDGE_FALLBACKS_ENABLED=0`、`SANDBOX_CODEX_BRIDGE_RETRIES` 调整。`sandbox_codex` 是可执行 agent 入口，可能有文件写入副作用，不默认自动重试，长任务仍建议 `background=true`
- Claude Code CLI 默认值：`SANDBOX_CLAUDE_CODE_MODEL` 未设置时使用 `sonnet`，默认预算上限 `SANDBOX_CLAUDE_CODE_MAX_BUDGET_USD=0.05`；可通过 `SANDBOX_CLAUDE_CODE_COMMAND`、`SANDBOX_CLAUDE_CODE_TIMEOUT_MS`、`SANDBOX_CLAUDE_CODE_PERMISSION_MODE` 覆盖
- 可覆盖环境变量：`SANDBOX_CODEX_MODEL`、`SANDBOX_CODEX_REASONING`、`SANDBOX_CODEX_SPEED`、`SANDBOX_SMART_FILES_TIMEOUT_MS`、`SANDBOX_SMART_STAGE1_TIMEOUT_MS`、`SANDBOX_SMART_STAGE2_TIMEOUT_MS`、`SANDBOX_SMART_CLAUDE_CODE_FILES_TIMEOUT_MS`、`SANDBOX_SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS`
- 默认超时：文件定点 smart 120s、阶段一 90s、阶段二 120s。Codex CLI 首次启动和 gpt-5.5 推理可能超过 60s，不应按短超时判定链路失败。
- 批量查询的每个 `queries[i]` 可单独覆盖 `mode/searchPath/modelChain`，smart 查询内部最多 2 并发，避免模型桥阻塞。
- `smart_search(background=true)` 的后台任务带 `ownerId`、deadline 与 timedOut，默认 15 分钟超时标记 error，可用 `SANDBOX_SMART_BACKGROUND_MAX_RUN_MS` 覆盖。
- Codex 侧大目录或长文件 smart 搜索建议使用后台模式，避免同步 MCP 调用超过宿主超时窗口：

```text
smart_search(mode="smart", modelChain="codex", query="...", searchPath="...", background=true)
smart_search(taskId="...", waitSeconds=30)
```

- `files[].range` 支持 `620-650` 与 `#620-650` 两种行号范围写法；无法识别的 range 会回退全文传给模型，避免空 prompt。

### Antigravity LS 模型别名

`GetModelResponse` 内部仍使用 `MODEL_*` 编码，但 `smart_search` 和 `sandbox_council` 的 Antigravity 路径都支持下列易读别名：

| 别名 | 实际编码 | 说明 |
|------|----------|------|
| `M132`, `fast`, `default`, `ag-fast`, `flash` | `MODEL_PLACEHOLDER_M132` | Gemini 3.5 Flash High，当前 auto 默认快模型 |
| `M20`, `flash-medium`, `flash-lite`, `gemini-3.5-flash-medium` | `MODEL_PLACEHOLDER_M20` | Gemini 3.5 Flash Medium |
| `M18`, `gemini-3-flash` | `MODEL_PLACEHOLDER_M18` | Gemini 3 Flash，旧稳定兜底 |
| `M16`, `M37`, `gemini-pro`, `gemini-3.1-pro`, `pro-high` | `MODEL_PLACEHOLDER_M16` | Gemini 3.1 Pro High；`M37` 是旧 Pro High 占位符，自动转到 M16 |
| `M36`, `gemini-3.1-pro-low`, `pro-low` | `MODEL_PLACEHOLDER_M36` | Gemini 3.1 Pro Low |
| `M35`, `sonnet`, `claude-sonnet`, `claude-4.6-sonnet` | `MODEL_PLACEHOLDER_M35` | Claude Sonnet |
| `M26`, `opus`, `claude-opus`, `claude-4.6-opus` | `MODEL_PLACEHOLDER_M26` | Claude Opus |
| `M47` | `MODEL_PLACEHOLDER_M18` | 旧编码已下线，自动转到 M18 |

## 生命周期与 owner 边界

- `sandbox_session`、`sandbox_codex`、`sandbox_launch`、`smart_search(background=true)`、`sandbox_council(background=true)` 都支持 `ownerId`；未传时按 `global` 兼容旧调用。后台任务启动时传了 `ownerId`，后续 `taskId` 查询也必须带同一个 `ownerId`。
- `sandbox_session` 同一 REPL 会话的并发 exec 会串行排队，避免 stdout/stderr buffer 混写。
- `sandbox_launch` 注册表会记录 `createdAtMs`、`commandHash`、`ownerId`、`exitMarkerPath`，状态优先读取 done marker；kill 前校验 PID 创建时间和命令特征，避免 PID 复用误杀。
- `sandbox_launch` 是显式长期任务，不会因为后台超时自动杀；需要用 `status/list/kill/clean` 管理。

## Windsurf / WSF MCP 客户端兼容

Windsurf / WSF 通过本机共享 HTTP broker 使用 Sandbox MCP，不新增任何 WSF 模型链路或 council provider。

- WSF MCP 配置文件：`%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- 推荐配置：`mcpServers.sandbox.serverUrl = "http://127.0.0.1:14588/sandbox/mcp"`
- 已验证 broker 端点：`/sandbox/mcp` 可完成 MCP `initialize` / `tools/list`，暴露 8 个 Sandbox 工具
- 若 WSF 直连 Streamable HTTP `/mcp` 失败，fallback 是用 `mcp-remote` stdio 包装同一个 broker endpoint；不要把 Sandbox 改成 WSF 专属 stdio 后端
- WSF 只作为 MCP 客户端；`modelChain="windsurf"` 和 `provider="windsurf"` 均不支持，也不应加入 schema
- WSF 侧使用 `sandbox_session`、`sandbox_launch`、`smart_search(background=true)`、`sandbox_council(background=true)` 时必须显式传稳定 `ownerId`，建议形如 `wsf:<project-or-task>`，避免共享 broker 下与 Codex / Antigravity / Claude Code 串任务

最小配置示例与验收步骤见 `docs/windsurf/`。

## sandbox_council 多模型审议

`sandbox_council` 用于红蓝黑队讨论、设计审议、实验结果复盘、做题后审议和 Guard 式检查。它不是完整 agentic sandbox：参与模型只发言，只有 `moderator` 主持模型能决定调用有限工具、继续讨论、点名补充或终止。

核心能力：

- `participants[]`: 每个参与者配置 `id / role / provider / model / params / supportsVision`
- `moderator`: 主持模型配置对象，必须包含 `id / role / provider`，可选 `model / params / supportsVision`；不能写成 `"gpt-5.4"` 字符串
- `provider`: `antigravity`、`codex`、`claudeCode`、`openai`、`anthropic`、`gemini`、`geminiCli`、`customOpenAICompatible`
- WSF 不提供 `provider="windsurf"`；在 WSF Cascade 中调用 council 时仍需显式选择现有 provider
- `files[]`: 背景文件，支持 `range`；纯文本文件直接抽取，图片会自动提升到 `images[]`，PDF/Word/Excel/EPUB/视频等复杂文件优先走 Gemini CLI agentic 索引，失败后 fallback 到 Codex CLI，再不行会对常见 Office/EPUB/PDF 走本地结构化兜底。CLI 索引必须写入 `sandbox-data/temp/council-indexes` 下的临时 Markdown，stdout/stderr 只保留短状态和诊断；宿主会检查产物存在、大小上限和 `<<<COUNCIL_INDEX>>>` 标记，避免把大索引堆在内存里
- `manualContext`: 手动粘贴的上下文
- `largeInput`: 大输入处理配置。`input`、`manualContext`、超长纯文本文件和 CSV 超过阈值时，会写入 `sandbox-data/temp/council-large-inputs`，生成 source 原文、checkpoint JSON 和 LargeInputIndex Markdown；分块按真实字符计算，默认 `chunkSize=24000`、`overlap=1200`，模型上下文只收到索引摘录和临时文件路径
- `modelTimeoutMs / pressureModelTimeoutMs`: 正式模型调用超时。普通任务默认 `120000ms`；检测到大输入索引、复杂文件索引或图片时自动使用压力场景超时，默认 `600000ms`。单个 participant/moderator 仍可用 `params.timeoutMs` 覆盖
- `contextMode`: `none` 只带输入和模式，`manual` 只带手动上下文，`summary` 带文件/图片摘要，`full` 带更完整文件/图片转述
- `textProjectionModel`: 纯文本参与者的专用转述模型；默认走 codex/gpt-5.4-mini
- `images[]`: 支持视觉输入的模型每轮可直接接收原图；若存在纯文本模型，系统会先用 codex 链路生成 only-text 转述
- `tools`: `webSearch`、`webFetchText`、`simpleScript`
- 主持人可用 `toolCall` 调一个工具，也可用 `toolCalls[]` 一轮最多调 3 个工具；总次数仍受 `maxToolCalls` 限制；同一轮里主持人会在拿到工具结果后继续决定要不要再调工具
- `afterToolInstruction`: 有效工具结果返回后写入下一轮公共上下文，作为参与模型额外指令
- `maxRounds` + `maxToolCalls`: 双上限控制讨论节奏；默认值调整为 4 轮 / 6 次工具
- `transcriptPath/outputDir`: 同时写 Markdown 和 JSON 副本
- `background/taskId/waitSeconds/ownerId`: 长讨论后台运行；任务未完成时会返回当前轮次、参与者返回情况、主持摘要和工具进度。启动时使用了 `ownerId`，查询必须继续传同一个 `ownerId`。`sandbox_council` 后台任务现已改为磁盘持久 spec/progress/done，跨 MCP 热重启仍可继续查询
- `customOpenAICompatible`: 通过 `params.baseUrl` 指向 OpenAI-compatible `/v1` 端点；本地代理建议在 `params.body` 明确传 `max_tokens`
- `params.fallbackModels`: provider 同类模型降级链。主模型按 `params.retries` 重试仍失败，且错误属于超时、429、5xx、空输出、连接中断这类临时问题时，按顺序尝试备用模型；API key 缺失、模型/图片参数错误、安全拦截、输出截断等不会自动降级
- Antigravity/OpenAI/Anthropic/Gemini/custom provider 的 fallback 不会按模型别名自动补齐，必须在对应 participant 或 moderator 的 `params.fallbackModels` 显式传入。Antigravity Claude/Sonnet/Opus 不稳定时，建议给该参与者配置例如 `"params": {"retries": 1, "fallbackModels": ["M132", "M20", "M18", "M16", "M36"]}`；否则只会重试当前模型，失败后该参与者本轮为空。复杂推理、Guard、审议类任务若不想优先 Flash，可显式指定 `M16` 或把 `M16` 放在自定义 fallback 前段
- Codex provider 未显式传 `params.fallbackModels` 时会自动使用同 provider 默认降级链：`gpt-5.4 high → gpt-5.4 medium → gpt-5.4 low → gpt-5.4-mini medium → gpt-5.4-mini low`，并跳过当前已使用的同模型/同 reasoning 档位；可用 `SANDBOX_COUNCIL_CODEX_DEFAULT_FALLBACKS=0` 关闭
- Claude Code provider 使用 `provider="claudeCode"`，只在显式配置时启用，不进入 `auto` 或 Codex 默认 fallback；默认模型 `sonnet`、默认预算 `0.05 USD`，可用 `params.maxBudgetUsd / params.sessionId / params.permissionMode / params.timeoutMs / params.allowedTools / params.disallowedTools` 控制。transcript 和 JSON 会记录 sessionId、实际模型、耗时、预算消耗与临时 stdout/stderr 路径，方便追溯 CC jsonl
- Gemini CLI provider 使用 `provider="geminiCli"`，这是本地 Gemini CLI 路线，不需要 `GEMINI_API_KEY`，适合让 Gemini 作为 council 正式参与者/主持人并直接处理图片路径；`supportsVision=true` 时会把原始图片路径交给 CLI。未显式传 `params.fallbackModels` 时默认按 `auto-gemini-3 → gemini-3.1-pro-preview → gemini-2.5-pro → gemini-3.1-flash-lite-preview → gemini-2.5-flash-lite` 降级，可用 `SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS=0` 关闭。Gemini CLI provider 默认 `approvalMode=yolo`，可用 `params.approvalMode` 或 `SANDBOX_COUNCIL_GEMINI_CLI_APPROVAL_MODE` 覆盖；provider/indexer 的临时 prompt/artifact 会写到 Gemini 允许访问的项目临时目录。若超时时标记结果已经写好，宿主会直接收结果并清理进程树
- moderator 调用失败时会先走 provider fallback；若所有主持模型仍失败，council 会用规则兜底汇总已返回的参与者意见，并明确标注该结论未经过主持模型二次综合
- CLI 文件索引降级链可通过环境变量调整：`SANDBOX_COUNCIL_GEMINI_INDEX_MODELS`、`SANDBOX_COUNCIL_GEMINI_INDEX_APPROVAL_MODES`、`SANDBOX_COUNCIL_CODEX_INDEX_MODELS`、`SANDBOX_COUNCIL_CLI_INDEX_RETRIES`、`SANDBOX_COUNCIL_CLI_INDEX_MAX_BYTES`。默认 Gemini 链会优先尝试 `auto-gemini-3`/`gemini-3.1-pro-preview`/`gemini-2.5-pro`，实测慢挂的 `gemini-2.5-flash` 已从默认链移除；默认 Codex 链为 `gpt-5.4:medium → gpt-5.4:low → gpt-5.4-mini:medium → gpt-5.4-mini:low`
- 大输入阈值和分块策略可通过 `largeInput` 参数或环境变量覆盖：`SANDBOX_COUNCIL_LARGE_INPUT_ENABLED=0` 关闭，`SANDBOX_COUNCIL_LARGE_INPUT_THRESHOLD_CHARS` 控制触发阈值，`SANDBOX_COUNCIL_LARGE_INPUT_CHUNK_CHARS` 控制 chunk 大小，`SANDBOX_COUNCIL_LARGE_INPUT_OVERLAP_CHARS` 控制重叠字符数，`SANDBOX_COUNCIL_LARGE_INPUT_INDEX_CONTEXT_CHARS` 控制注入上下文的索引摘录长度
- 压力输入场景的正式模型调用超时可通过 `pressureModelTimeoutMs` 或环境变量 `SANDBOX_COUNCIL_PRESSURE_MODEL_TIMEOUT_MS` 覆盖；普通模型超时仍可用 `modelTimeoutMs` 或 `SANDBOX_COUNCIL_MODEL_TIMEOUT_MS` 覆盖。后台任务默认 deadline 已放宽到 45 分钟，可用 `SANDBOX_COUNCIL_BACKGROUND_MAX_RUN_MS` 覆盖

最小可用示例：

```json
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
```

后台查询时不要只传 `taskId`；需要复用启动时返回的 `ownerId`：

```json
{
  "taskId": "council-xxx",
  "ownerId": "example-owner",
  "waitSeconds": 45
}
```

如果 council 已经在后台跑，主线程可以继续做不重叠的本地检查、读文件、构建或整理证据，等 council 返回后再合并观点；不要因为一次查询漏带 `ownerId` 就重新启动同一场审议。

常见错误：

- ❌ `"moderator": "gpt-5.4"`
- ✅ `"moderator": {"id":"moderator","role":"主持人","provider":"codex","model":"gpt-5.4"}`

安全边界：

- Antigravity provider 只走 `GetModelResponse`，不使用 Cascade
- `simpleScript` v1.10 只执行受限 Node/Python 子进程片段。Node 启用 permission、禁用字符串代码生成、无文件授权、短超时；Python 走 AST 审查、白名单安全模块、隔离临时目录、最小环境和短超时。默认 `language=node`，不是通用命令执行器
- v1.11 增加 provider 稳定性保护：`antigravity` 默认同源并发 2，`codex` 默认同源并发 2，`customOpenAICompatible` 默认同 `baseUrl/source` 并发 2；可用 `params.maxConcurrency` 或环境变量覆盖。HTTP 5xx/429、超时、空输出和 `GetModelResponse` 失败会按 `params.retries`/`params.retryBackoffMs` 做有限 retry
- v1.11 会识别常见截断/中止信号：OpenAI Responses `incomplete`、OpenAI-compatible `finish_reason=length`、Anthropic `stop_reason=max_tokens`、Gemini `finishReason=MAX_TOKENS/SAFETY`，并在 transcript 错误中显式说明
- v1.12.3 增加 provider fallback：`params.fallbackModels` 可传字符串数组，或 `{ "model": "...", "params": {...}, "supportsVision": false }` 对象数组。例如 Claude Opus 可 fallback 到 Sonnet；Gemini Pro high 可 fallback 到同模型 low 参数或 Flash。fallback 仅允许同 provider，不做跨供应商静默切换
- v1.12.4 增加 Codex 默认 fallback 和主持规则兜底：Codex 在未显式配置 `fallbackModels` 时按 reasoning 逐级减负再切到 `gpt-5.4-mini`；主持模型全部失败时，使用规则汇总已有参与者发言，避免无最终结论
- v1.12.5 增强复杂文件索引稳定性：Gemini CLI / Codex CLI 索引改为临时文件产物协议，不再要求完整索引走 stdout；宿主校验临时文件大小、标记和最短内容，并支持 CLI 模型链 retry/fallback。本地结构化兜底的 JSON/Markdown 也统一写入 `sandbox-data/temp/council-indexes`
- v1.12.6 增加 `geminiCli` provider：Gemini CLI 可像 Codex provider 一样作为正式参与者或主持人进入 council，默认保留 retry/fallback 链，响应同样写入 `sandbox-data/temp/council-model-calls` 临时文件后由宿主校验读取
- v1.12.7 增加大输入分块索引：`input`、`manualContext`、超长纯文本/CSV 文件会生成带 overlap 的临时 source/checkpoint/index 产物，transcript 记录 artifact 路径和覆盖质量，避免把全文直接塞进模型上下文
- v1.12.8 增加压力输入长超时：检测到大输入索引、复杂文件索引或图片时，正式模型调用自动使用 `pressureModelTimeoutMs`（默认 600s），后台任务默认 deadline 放宽到 45 分钟，并支持单模型 `params.timeoutMs` 覆盖
- v1.12.10 修复 council 后台 worker cwd 漂移：后台完成标记不再写入 `dist/council/sandbox-data` 错误目录；查询旧错位任务时会自动回收 legacy `done/progress`，避免误报“worker 已退出但未写入完成标记”
- v1.12.11 修复 Antigravity stdio 父进程 cwd 漂移：council 后台 task 根目录固定到 `mcp-sandbox/sandbox-data/temp/council-tasks`，并从旧 `process.cwd()` 与 `dist/council` legacy 目录回收 `spec/progress/done`。
- v1.12.12 修复 council 复杂文件索引卡住观感：Gemini CLI 索引临时目录改为 ASCII 安全路径，避免中文路径被 CLI 错解；检测到模型容量 429、workspace path rejected、AttachConsole failed 时会提前结束当前尝试并进入 fallback，同时后台进度会显示正在索引哪个文件和使用哪条 CLI 链路。
- v1.12.13 补齐 council 卡死兜底：`geminiCli` 正式参与者/主持链路复用 Gemini CLI 早退和孤儿进程清理；后台 worker 按 deadline 写入中断终态并退出，查询时发现 deadline 过期也会中断任务，避免长期停留在 running。
- v1.13.0 增加 Claude Code 显式链路：`smart_search(modelChain="claude-code"|"cc")` 可走本地 `claude` CLI；`sandbox_council` 新增 `provider="claudeCode"`，并记录 CC session/cost/model metadata。`auto` 仍只在 Antigravity/Codex 之间选择，不会静默调用 Claude Code
- v1.13.1 更新 Antigravity GetModelResponse auto 模型链：默认 `M132 → M20 → M18 → M16 → M36`；同步别名表，旧 `M37/M47/2.5 flash` 入口会转到当前可用占位符。复杂推理任务建议显式选择 `M16`
- v1.13.2 增加 Windsurf / WSF MCP 客户端兼容文档和 schema 防呆说明：WSF 通过 `http://127.0.0.1:14588/sandbox/mcp` 调用 Sandbox，不新增 `modelChain="windsurf"` 或 `provider="windsurf"`
- v1.13.3 增强 Codex 模型桥稳定性：`smart_search(modelChain="codex")` 默认改用低 reasoning 快速首选，并在可重试失败时按同 provider fallback 链降级；`sandbox_codex` 保持无默认自动重试以避免副作用
- `webSearch` 现默认优先走 Exa MCP；Exa 失败或无结果时才降级到 360/Bing HTML fallback，并在结果里带降级说明。DuckDuckGo 当前环境常见 403/timeout，默认跳过，可传 `duckDuckGo=true` 强制尝试
- v1.12.1 补充 `sandbox_council` 参数防呆：schema 和文档明确 `moderator` 必须是对象，并给出最小 JSON 示例
- v1.12.2 补充 `sandbox_council` 后台查询防呆：启动返回会直接给出带 `ownerId` 的查询示例；README、Resource guide 和 schema 明确查询必须复用同一个 `ownerId`，避免误判任务丢失后重复启动
- `webFetchText` 现默认优先尝试 Exa（`text`）和 `web-fetcher`（`text/html/links/tables`），失败后才降级到轻量直抓；仍拒绝 localhost / 私有地址，也不接管登录态网页点击

## 开发

```bash
npm install
npm run build
```

## 相关文档

- Plan_1.md — v1.0 总纲领
- Plan_2_codex_tool.md — Codex 工具详设
- Plan_4_output_quality.md — 输出质量优化
- Plan_5_smart_search.md — Smart Search 智能搜索
- Plan_5_plus_batch_search.md — Smart Search 批量搜索扩展
- Plan_6.md — Codex CLI v0.124.0 适配
- Plan_6_codex_upgrade.md — Codex 链路与 CLI 升级设计
- Plan_8_claude_code_compat.md — Claude Code 兼容与三链路互通设计
- docs/claude-code/ — Claude Code MCP 配置、CLAUDE 规则模板与验证说明
- docs/windsurf/ — Windsurf / WSF MCP 配置示例与 Sandbox 验收说明
- LS-Principles.md — LS 进程原理
- LS-Update-Suggestion.md — LS 生命周期与双链路补充说明
- Task.md — 执行任务清单
