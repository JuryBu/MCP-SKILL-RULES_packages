# mcp-subagent

**Windsurf 专属 · 异步子代理 MCP server**

让主对话在一轮内**不阻塞地派发并行子代理**（自选模型/模式/prompt/图片/上下文），子代理用完整工具独立探索；主对话可在**任意 step 边界**回收结果并继续——**主模型零轮询**（MCP 内部 watchdog 负责 step 监控/回插，LS 无原生 step-boundary push）。

> **标注图例**（全 Plan 系列通用）：✅【已验证】实测有据 ｜ 🟡【待验证】见 Plan_3 §4 ｜ 🎯【设计目标】未证、实现时需验收。

## 状态

✅ **Stage A~K 已完成并自测** —— 当前已支持异步子代理、自动回插、多轮 reply、当前主对话绑定、模型列表与 `model_profile`、`subagent_wait` 短等待、管理工具默认摘要和 per-turn collect 去重。live broker 已写入并通过 reload / 工具列表 smoke，维护仓库交接包已生成，后续由维护仓库流程 commit / push。

## 为什么放在 `.codeium\windsurf\mcp-subagent\`

- **抗 IDE 更新**：用户数据目录不被程序更新覆盖（更新只冲安装目录 `Programs\Devin\`）
- **语义贴合**：仿照 Antigravity 的 `.gemini\antigravity\mcp-sandbox\`，这是 WSF 的对等私有位
- **卸载风险已兜底**：正式实现会纳入 `JuryBu/MCP-SKILL-RULES_packages` 维护体系，重装后一行安装/恢复即可
- **进程托管**：采纳**挂全局 broker(14588) 托管进程**（单例、防泄漏），WSF 侧只用 `serverUrl` 引用；🟡 broker 可加载性待验证，fallback 为 stdio `command` + 孤儿进程防护（详见 Plan_1 §2）
- **隔离**：工具面板可见性靠 WSF 配置控制；真正写权限靠 registry / 谱系 / `main_id` 授权校验，不把 broker 当权限边界（详见 Plan_1 §8 安全边界）

## 目录结构

```
mcp-subagent/
├── README.md              本文件
├── Plan/
│   ├── Plan_1_架构与落点.md
│   ├── Plan_2_工具与参数设计.md
│   ├── Plan_3_认证实现与待验证.md
│   └── Task.md            分 Stage 任务(面向 CODEX)
├── package.json           node 项目(MCP SDK)，含 build/smoke 脚本
├── .gitignore
├── schemas/
│   └── registry.schema.json
├── scripts/               各 Stage smoke/探测脚本
└── src/
    ├── index.js           MCP stdio 入口
    ├── tools.js           子代理工具实现
    ├── audit.js           写/删操作审计日志
    ├── processGuard.js    stdio fallback 单例锁/父进程检查
    ├── registry.js        jobs.json 原子写/锁/归档目录
    ├── lsClient.js        Windsurf Language Server 发现与调用
    ├── cascadeOps.js      Cascade API 操作封装
    ├── metadata.js
    └── auth.js
```

## 架构一句话

```
主模型 --调用(WSF serverUrl ─► 14588 broker)--> mcp-subagent(broker 托管 node, 单例)
   current / models / spawn / poll / wait / collect / interrupt / dispose / list / reconcile / move_queued / cleanup
        └ 内部用 LS HTTP API 操作独立 Cascade 子对话（仅限自己 spawn 的谱系）
```

## MCP 工具

`subagent_current`(列出当前可用真实 Cascade 候选，防模型编 `main_id`) · `subagent_models`(查看当前缓存模型与语义 `model_profile` 候选) · `subagent_spawn`(派发) · `subagent_poll`(查状态) · `subagent_wait`(短等待指定子代理完成，可选完成后 collect) · `subagent_reply`(继续回复同一子代理，多轮追问) · `subagent_collect`(三档回插: queue/interrupt@边界/force) · `subagent_interrupt`(强插) · `subagent_list`(盘点回档) · `subagent_dispose`(显式归档/清除, 先归档再删) · `subagent_reconcile`(registry/LS 状态修复) · `subagent_move_queued`(队列顺序调整) · `subagent_cleanup`(TTL 自动归档与归档保留)

`job_id` 由工具生成，`sub_cid` / `queue_id` 从真实 LS 返回并登记到 registry；`subagent_reply`、`subagent_collect`、`subagent_dispose` 等后续操作默认只需要 `job_id`，不应让模型手填 `sub_cid` / `queue_id`。`subagent_spawn` 的 `main_id` 必须是真实的当前 Windsurf/Devin Cascade 对话 ID，不是随便起的 job label；若不知道当前对话 ID，先调用 `subagent_current({ limit: 10 })` 看候选，再使用 `current_best_effort.main_id` 或明确候选。传入类似 `cascade-main-test-001` 的假 ID 会被拒绝，并提示先调用 `subagent_current`。

`subagent_spawn` 默认 `auto_collect=true`：子代理完成后，MCP 常驻进程会按 `collect_mode` 自动调用回插 watchdog；测试或手动编排时可传 `auto_collect:false`。回插按 `job_id + turn` 单飞，collecting/collected/已有同轮 queue 都不会再次 `QueueCascadeMessage`；`interrupt` 失败默认清掉队列并标 `collect_failed`，只有显式 `fallback_to_queue:true` 才退化保留 queue。回插主对话时会从主对话最新 `USER_INPUT` 反查当前 `requestedModelUid` 与 `plannerMode`，再原样构造 `cascadeConfig`，避免把主对话的 Code / Ask / Plan 模式固定切成 Ask；子代理自身模式由 `spawn.mode` / `reply.mode` 控制，默认 `code`。

`subagent_wait({ job_id, wait_ms?, collect? })` 用于主对话短阻塞等待子代理反馈：默认最多等 30 秒，上限 45 秒，超时返回 `still_running:true`，避免撞上 broker / MCP 客户端传输超时；`collect:true` 只在子代理 done 后调用一次幂等 `subagent_collect`，不会绕过 auto-collect 单飞锁。

`model` 是精确 WSF 模型 UID，`model_profile` 是语义档位：`cowork` / `explore` / `frontend` / `review` / `unblock`，并兼容 `fronted` / `brainstorm` 别名。`subagent_models()` 默认是摘要视图，只返回 profile 摘要、来源计数和少量候选；`subagent_models({ purpose:"explore", detail:"detail" })` 展开指定用途候选；只有 `detail:"full"` 或 `include_available:true` 才返回全量缓存模型清单。当前来源是 IDE 缓存的 Cascade 模型列表，不是服务端实时全集，所以返回里会标 `source` 与 `updated_at`。普通 `spawn/reply` 只返回模型解析摘要；只有调用 `subagent_models`、模型不可用或发生 fallback 时才展示候选说明，不在 README 固化长模型清单。

`subagent_list()` 默认隐藏 `deleted/archived` 历史，`filter:"all"` 也优先保持可读；需要翻旧账时传 `include_deleted:true`、`include_archived:true` 或 `detail:"full"`。

## 清理策略

- `SUBAGENT_CLEANUP_INTERVAL_SEC`：常驻进程周期扫描间隔，默认 `3600` 秒；设为 `0` 可关闭定时器
- `SUBAGENT_IDLE_TTL_SEC`：`done/timeout` job 自动归档阈值，默认 `86400` 秒
- `SUBAGENT_RETAIN_ARCHIVES`：保留最近归档数，默认 `200`
- `subagent_cleanup({ dry_run:true })` 可预览；`hard_delete_archives:true` 只会清旧归档文件，并先写入 `subagent-data/archive-exports/` 导出留底
- 清理只处理 `done/timeout`，不会自动删除活跃 Cascade；真正删除仍需显式 `subagent_dispose({ mode:"delete" })`

## 本地验证

```powershell
npm install
npm run build
npm run smoke:mcp-tools
npm run smoke:models
npm run smoke:list-defaults
npm run smoke:model-fallback
npm run smoke:model-profile -- <main_id>
npm run smoke:current-binding -- <main_id>
npm run smoke:auto-collect -- <main_id>
npm run smoke:collect-dedupe -- <main_id>
npm run smoke:stage-f
npm run smoke:stage-g -- <main_id>
npm run smoke:stage-g-tool -- <main_id>
npm run smoke:stage-h -- <main_id>
npm run smoke:stage-h-tool -- <main_id>
```

生成给维护仓库的交付包：

```powershell
npm run package:handoff
Compress-Archive -Path 'dist/mcp-subagent-handoff\*' -DestinationPath 'dist/mcp-subagent-handoff.zip' -Force
```

当前建议导入目标：`JuryBu/MCP-SKILL-RULES_packages` 仓库的 `packages/mcp-subagent`。交付包 manifest 位于 `dist/mcp-subagent-handoff/manifest.json`。

## 配置接入

默认只 dry-run，不写全局配置：

```powershell
npm run install:config
npm run patch:codex-broker
npm run smoke:broker-dry-run
npm run check:live-config
```

正式写入前要确认这是高风险操作：会修改 `%USERPROFILE%\.gemini\antigravity\mcp_config.json` 和 `%USERPROFILE%\.codeium\windsurf\mcp_config.json`。脚本会先生成 `.before-subagent-<timestamp>` 备份，再原子写入。

```powershell
npm run install:config -- --apply
npm run patch:codex-broker -- --apply
npm run check:live-config
npm run smoke:broker-load
npm run smoke:broker-tools
```

当前 Codex HTTP broker 的 `%USERPROFILE%\.codex\mcp-http-broker\broker.mjs` 是静态 endpoint 表；`patch:codex-broker -- --apply` 会先备份 `broker.mjs.before-subagent-*`，再加入 `/subagent/mcp`。如果 broker 未热加载 `/subagent/mcp`，重启 broker 宿主或 Antigravity/Codex 后再跑 `npm run smoke:broker-load` / `npm run smoke:broker-tools`。若不借用 broker，可改用 WSF stdio fallback：

```powershell
npm run install:config -- --apply --target windsurf --stdio-fallback
```

回滚默认 dry-run；确认备份路径后再 `--apply`：

```powershell
npm run rollback:config
npm run rollback:config -- --apply
```

污染检查：broker route 是本机共享进程托管层，真正权限不靠工具面板隐藏。若 Antigravity 工具面板出现 `subagent`，这是预期风险之一；不接受时回滚 broker config，或只保留 WSF stdio fallback。

## Stage G 真实闭环

需要传一个真实主 Cascade `main_id`：

```powershell
npm run smoke:stage-g -- <main_id>
```

`smoke:stage-g` 执行 `spawn → poll → result_text 裁剪 → collect(interrupt/fallback queue) → dispose(delete)`，删除前会先写 `subagent-data/archive/` 归档，写/删操作审计落在 `subagent-data/audit/*.jsonl`。

`smoke:stage-g-tool` 会让子代理真实读取 `README.md`，再用最终结论回插主对话，用于验证「工具产出 → result_text → collect」不会夹带 MEMORY、global rules 或 raw steps。

`smoke:current-binding` 会验证 `subagent_current` 能列出真实 Cascade 候选、真实 `main_id` 可解析、假 `main_id` / 缺失 `main_id` 会被拒绝且提示 `subagent_current`。这是防止 WSF 模型把 `main_id` 编成 `cascade-main-test-001` 这类 label 的回归测试。

`smoke:auto-collect` 会验证默认 `auto_collect=true`：脚本只 `spawn`，不手动调用 `subagent_collect`，等待 MCP watcher 在子代理 done 后自动把结果插回临时主对话。

`smoke:list-defaults` 会用临时 registry 验证 `subagent_list` 默认不把 deleted/archived 历史刷出来，显式 `detail:"full"` 才展开；`smoke:models` 会验证 `subagent_models()` 默认不会返回全量模型清单。

`smoke:collect-dedupe` 会对同一 job/turn 并发调用三次 `subagent_collect({ mode:"queue" })`，验证只产生一个 `queue_id` 和一条 `queue_history`，用于防 auto-collect/watchdog 重复补队列。

`smoke:stage-h` 会验证 `subagent_reply` 多轮追问：脚本会创建临时 running main，第一轮用 `interrupt` 的 active-step watchdog 等主输出 step 完成后回插，再继续回复同一个 `sub_cid`，第二轮再次回插并使用新的 `turn=2` 幂等记录，不被第一轮 `collect_result` 阻挡。Stage H 不接受单纯 `queue` 作为最终回插证据。

`smoke:stage-h-tool` 会验证多轮工具 step 场景：临时主对话真实进入 `CORTEX_STEP_TYPE_RUN_COMMAND` 后，watchdog 锚定该工具 step，等待工具 step 完成后再回插子代理结果，证明 collect 不需要等整条主消息结束，也不会截断正在运行的工具 step。

## 关键依据

所有底层机制（StartCascade / SendUserCascadeMessage / QueueCascadeMessage /
InterruptWithQueuedMessage / step 状态检测 / 三档回收）均已在
历史探索目录下逐 stage 实测，结论已整理为本 README 的功能边界说明。
