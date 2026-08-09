# MCP Memory Store v1.22.6

AI 主动记忆管理系统 + 四数据链路对话原文阅读器 + 附件懒解析 + Auto Summary + 黄金片段提取 + 对话记录 Record + Record Reader 读侧治理 + Stage Guard 任务完整性验证，基于 MCP 实现。

## 功能

- **多工作区记忆管理**：按工作区隔离，支持跨工作区发现
- **三级搜索引擎** (v1.10+)：exact（多词分词AND）/ fuzzy（Fuse.js）/ smart（Flash语义）/ auto（exact→fuzzy fallback），覆盖 Record/Memory/Conversation 三大搜索场景
- **智能搜索引擎**：fuse.js 模糊匹配 + 标签过滤 + 全文 grep
- **三档深度控制**：index / summary / full，最小化上下文占用
- **冷热分层**：LRU 索引缓存 + 冷工作区归档
- **批量操作**：一次调用多个 write/read/query/update/delete
- **内置去重**：写入时自动检测相似记忆
- **置顶记忆**：每个工作区 3 条置顶精华，概览优先显示
- **对话原文读取** (v1.4+)：绕过 CHECKPOINT 压缩读取对话完整内容，并支持按宿主链路取数
- **Auto Summary 双轨制** (v1.5+)：AI 手写 searchSummary + Flash 自动生成 autoSummary，双路搜索提升召回率
- **黄金片段提取** (v1.5+)：从对话中提取关键决策、发现、踩坑经验，与现有记忆自动去重
- **与 LS 同生共死** (v1.6+)：MCP 进程绑定父 LS，窗口开着永不超时，窗口关闭 30s 内自动退出
- **LS 注册表加速** (v1.6+)：跨窗口 LS 发现从 PowerShell 全量扫描 (2-5s) 降至注册表查询 (~5ms)
- **三步查找路由** (v1.6+)：父 LS 直连 → 注册表 → PowerShell 兜底，跨窗口对话读取零额外延迟
- **进程生命周期容错** (v1.7+)：ppid 连续 3 次失败容错 + stdin 断裂诊断增强 + 非 LS 环境 1h 空闲超时兜底
- **对话记录 Record** (v1.8+ / 持久调度 v1.20+)：模型自动生成对话过程日志，抗 LS 过期，超长 prompt 分批处理；更新会冻结来源快照并物化为 Task → Record → Unit → Attempt，持久 scheduler 负责公平排队、取消、崩溃恢复和多步提交，同一逻辑 revision 由 Record work registry 去重
- **Stage Guard 任务完整性验证** (v1.9+ / 多实例 v1.19.2+)：四层防御网（RULES + 工具提醒 + 🔒标记 + 用户审计），审核模型比对 Plan/Task vs 执行记录。GuardKey 由 conversationId + stageId + childScopeId 组成，每次 start 生成不可变 guardId；同一 Task 可并存多个 Guard，pass/cancel/force 只处理目标实例。子任务用 scopeSelectors 定义局部审核范围，status(listAll=true) 不读取对话即可列出全部活跃 Guard。
- **四宿主统一 Fetch 缓存与来源控制** (v1.22+)：Codex、Claude Code、Windsurf、Antigravity 统一发布可校验、不可变的 fetch cache generation；Codex/Claude Code 对大 JSONL 流式增量读取，Windsurf/Antigravity 即使 IDE 与 Language Server 均未启动，也能直接解密 active/implicit 本地 PB。`source=auto|local|ls` 的成功 fetch 都发布到同一个宿主级最新缓存入口，`source=cache` 只读取最近一次成功发布的完整 generation。
- **大结果可续读与对话语义** (v1.22+)：`read/search` 对约 100K 的结果返回继续位置，不再沿用古老的静默截断；连续人类消息归为同一人类轮，annotations 保留被批注文本与用户评论，子代理明确标注与主线程的角色关系。
- **离线目录与压缩回溯 Recall** (v1.22.3+)：Windsurf/Antigravity 即使 IDE 与 Language Server 都关闭，也能从 active/implicit PB 元数据列出本地对话；四宿主 fetch cache generation 保存压缩边界元数据。`conversation_read_original(action="recall", recallMode="auto|manual|full")` 会先增量更新 fetch 缓存，再只从同一已提交 generation 恢复人类可见上下文；排除 thinking、工具结果、diff、Rules 注入和压缩摘要。`auto/manual` 继续遵守约 100K 分段交付，`full` 只返回带 SHA256 的临时文件。
- **旧 fetch 缓存自动迁移** (v1.22.4+)：缓存格式升级为 `conversation-source-cache/v2`，首次访问旧 generation 时自动按原始来源重建；搜索同时安全处理历史对象/数组字段，不再要求调用方先手动 fetch 才能避开 `.toLowerCase()` 类型错误。
- **本地 PB 全量统计** (v1.22.5+)：Windsurf/Antigravity 的 fetch 缓存保存整段对话的 AI 回复与工具调用总数；范围读取继续显示全量统计，旧缓存缺少统计字段时首次访问自动重建。
- **Record/Guard 缓存稳定性** (v1.22+)：Record 只使用已校验的不可变 fetch cache generation，不再回读可能达到 2GB 的原始对话文件；为保证 Phase 回滚正确性，会物化完整规范化缓存而非仅保存尾部。Stage Guard 的 `start` 以常数时间 O(1) 建立状态，遵守模型预算并保持稳定 `taskId`，让重试与恢复指向同一任务。
- **公开文档边界**：公开说明只覆盖可公开协议与行为；固定应用 key 属于本地 PB 格式兼容常量，不作为用户秘密。用户自定义覆盖值、真实样本以及执行 Plan/Task 不会进入 README、CHANGELOG 或 npm 发布包。
- **Record 自动触发可靠性** (v1.10+)：MCP 退出时等待 pending Record 生成，阈值 5→3 轮
- **Record Reader 读侧治理** (v1.12+)：Record markdown 仍是唯一事实源；新增 reader index、结构化 `read`、block 级 `search`、带来源 `guide`，支持只读 outline/state/outputs/phase 等局部内容，避免 70KB-100KB Record 每次整篇塞进上下文。
- **Record Reader 归属治理** (v1.12+)：`scope="workspace"` 严格只读指定工作区，`includeGeneral=true` 才显式兼容旧的 workspace + general 读法；新增 `audit_ownership` / `repair_ownership(dryRun=true)`，按 Antigravity `workspaceUri`、Codex `cwd`、子线程 parent/root 派生关系和同 ID 副本检测归属，不根据标题或正文语义猜测。
- **Record official home 止血** (v1.12.4+)：`C:\...`、`\\?\C:\...`、file URL、尾斜杠、大小写和分隔符差异不再制造不同 workspace hash；Record 读取、列表和搜索按覆盖轮次/更新时间/大小选择最可信副本，repair/update 会把旧 alias 或 `general` 副本 copy/upsert 到 official workspace，并用 sidecar 标记 `superseded`，默认视图不再展示已被取代副本。
- **Record 单批增量止血** (v1.12.5+)：`parallelMode="auto"` 下，如果旧 Record 已经较大，即使新增内容只切出 1 个 chunk，也会走 RecordPatch + local compose 增量合成，避免回落到“旧 Record + 新增轮次 → 模型输出完整新版 Record”的单批超时路径；Record 头部的对话ID、工作区、总轮次和总步骤由代码按结构化元数据校正，模型仍可记录当前状态、关联工作区和产出文件等正文信息。
- **Codex 超大 JSONL 流式读取** (v1.12.6+)：Codex 本地 rollout JSONL 分块逐行解析，不再一次性读成巨型字符串；超长元数据、加密 reasoning 与单条超大文本会在读取层丢弃或裁剪，避免 1GB+ 对话在 Record 更新或 `conversation_read_original` 前置读取阶段触发 V8 字符串上限。
- **Record Local Compose 轮次范围解析修复** (v1.12.7+)：Local Compose 质量检查支持 `- 轮次范围：X-Y`、`- **轮次范围**：X-Y` 这类 Phase 内标签式写法，不再只依赖 Phase 标题中的 `轮次 X-Y`；同时粗体头部元数据会被原位替换，避免重复追加总轮次/工作区。
- **Codex contextProbe 限时尾扫** (v1.12.8+)：`conversation_read_original(list, dataChain="codex", contextProbe=...)` 默认只扫描每个候选 JSONL 的尾部窗口，并带全局耗时预算，避免辅助定位当前线程时连续解析多个大 JSONL 拖穿 60 秒 MCP 客户端超时。可用 `MEMORY_STORE_CODEX_CONTEXT_PROBE_MAX_BYTES` 和 `MEMORY_STORE_CODEX_CONTEXT_PROBE_DEADLINE_MS` 调整。
- **Local Compose 旧 Phase 过滤** (v1.12.9+)：Record 本地合成解析结构化增量时，会丢弃结束轮次早于 `rewriteStartRound` 的旧 Phase，防止模型把稳定区重复吐进候选后造成 `59 -> 128` 这类轮次跳跃；质量检查仍保留，不接受缺口候选。
- **Codex list 快查止血与 deep_locate 骨架** (v1.13.0+)：Codex `conversation_read_original(list, mode="auto")` 收紧为标题/ID/工作区/Record/reader index/contextProbe 快查；query 未命中时不再自动读取多个超大 JSONL 原文预览，也不再自动触发 smart 模型搜索。新增 `deep_locate` 后台骨架，用 exact/fuzzy 流式扫描 Codex JSONL 来定位正文片段，支持进度、预算、partial hits 和取消入口；smart rerank、checkpoint/resume 与轻索引在后续阶段推进。
- **Record superseded 环、list ID 排序与阶段 ETA 修复** (v1.13.1+)：Record 归属 sidecar 若出现 `A → B → A` 这类 superseded 互指环，不再把所有副本都隐藏，列表和搜索会继续按覆盖轮次、更新时间和大小选择最可信副本；`conversation_read_original(list)` 用完整 ID 查询时真实 ID 命中优先于标题正文提及；后台任务预计剩余时间改按当前阶段开始时间估算，避免把上一阶段耗时算入新阶段。
- **Guard/Record 链路失败分类与旧 Phase 范围标题兼容** (v1.13.2+)：`stage_guard` 遇到模型链路不可用、Codex 模型桥退出等基础设施失败时返回“审查未完成”，不再计入未通过次数或触发三次失败裁定；Record Local Compose 解析兼容 `## Phase 1-36` / `## Phase 37-61` 这类旧压缩范围标题，避免把范围起点误当 Phase 编号导致 `1 -> 37` 跳号。
- **Stage Guard 索引驱动分段取证** (v1.13.4+)：`stage_guard(check)` 不再全量吞入超长 Plan/Task/Record；会按 `stageId`、标题、头部规则、尾部、小本本和证据窗口抽取局部内容，并固定注入命令、报告、run/obs ID、文件路径等证据清单。coverage 不足、锚点缺失或截断风险会返回“证据不足/未完成”，不计入未通过次数。
- **Record 正文覆盖自愈** (v1.13.6+)：`record_manage(update)` 会校验旧 Record 正文实际覆盖轮次与索引 `lastUpdatedRound` 是否一致；若索引声称 97 轮但正文只覆盖 3 轮，会先向下修正索引并从未覆盖轮次继续生成。`force=true` 对单个 update 生效，会绕过“已是最新”短路；v1.15.14 起旧 Record 可解析时默认保留稳定 Phase、回滚尾部并继续合成，结构化 read 会提示正文/索引覆盖不一致。
- **RecordPatch 检查点与中文格式自愈** (v1.13.6+)：并行 Record 生成会把成功的 map / compress 中间 `RecordPatch` 写入检查点；后续重试可复用已完成区段，只隔离 timeout / failed / invalid 节点。Record 解析兼容旧 `Rounds X-Y`，写入前会把 Phase 标题规范为中文“轮次 X-Y”，避免英文格式漂移导致覆盖误判。
- **Stage Guard 外部证据索引** (v1.13.7+)：`stage_guard(check)` 新增 `evidenceFiles` / `evidenceAssets` / `evidenceIndexMode`；PDF、Word、Excel、EPUB、图片、视频和复杂文件会先生成带 artifactPath/warnings 的纯文本索引，再进入 Guard prompt。索引走临时文件协议和大小校验，避免大文件、大 stdout 或完整二进制内容堆进主进程内存。
- **Codex AGENTS/RULES 注入折叠** (v1.13.8+)：Codex 对话开始与压缩后自动注入的 `# AGENTS.md instructions for ...` 规则快照会在读取层折叠为带 path/chars/hash 的短占位符；`conversation_read_original`、Record、Stage Guard、Golden Extract、contextProbe 和 deep_locate 默认不再吞入完整 RULES 正文。
- **Claude Code 对话与模型链路兼容** (v1.14.0+)：新增 `dataChain/modelChain="claude-code"` 与别名 `cc`。`conversation_read_original` 可读取 `.claude/projects/**/*.jsonl`，支持 `list/fetch/read/search/deep_locate/contextProbe`；Record、Golden Extract、Stage Guard 基于统一轮次工作。Claude Code 图片/文件附件只懒解析元信息或命中轮次临时化；Claude Code CLI 只在显式 `modelChain="claude-code"` 或允许 fallback 时使用，并带 timeout、进程树 kill 和输出预算。
- **Claude Code compact summary 折叠** (v1.14.1+)：Claude Code 上下文压缩后的 `compact_boundary + isCompactSummary` 续聊摘要会被识别为压缩元信息；`read` 默认只对实际读取到的轮次懒导出临时 Markdown，`depth="full"` 或 `compactionMode="full"` 可展开但保留 marker，Record/Guard/Golden Extract/contextProbe/deep_locate 默认不把 compact summary 当真实用户正文。
- **Windsurf 四数据链路兼容** (v1.15.0+)：新增 `dataChain="windsurf"` 与别名 `wsf`，通过 Windsurf Language Server 只读 Cascade 对话；`conversation_read_original` 支持 `list/fetch/read/search`，Record、Golden Extract、Stage Guard 可读取 WSF 对话并复用 Antigravity / Codex / Claude Code 模型链路。WSF 不提供 `modelChain`，`chain="windsurf"` 仅作为数据链路兼容写法，模型链路回落 `auto`。
- **Windsurf 工具证据归一化** (v1.15.2+)：WSF 的 run command、MCP tool、find、view file、code action、list directory、command status 等 step 会归一到 `toolCalls` / `fileViews` / `codeActions`，`conversation_read_original(read, depth="full")` 与 Stage Guard 能看到真实执行证据，避免把“读取不到工具调用”误判成任务虚标。
- **conversation_read_original 显式 ID 防串读** (v1.15.3+)：`fetch/search/read` 在 `dataChain="auto|codex|claude-code|windsurf"` 下必须显式传 `conversationId`，避免共享 HTTP 后端把“当前对话”推断到别的宿主或别的窗口；仅显式 `dataChain="antigravity"` 保留读取当前 Antigravity 窗口的兼容路径。`search` 输出会显示实际读取的 `conversationId`。
- **conversation_read_original 持久导出** (v1.15.4+)：新增 `action="export"`，可把 Codex / Antigravity / Claude Code / Windsurf 的可读对话原文导出为 `conversation.md`、`manifest.json`，并可选生成 `conversation.pdf`。导出支持 `scope="full|rounds|search"`、自定义 `outputDir` 自动创建、附件复制到 `assets/` 并重写相对链接；PDF 使用 Edge/Chrome 无头隐藏打印，不弹出有头浏览器窗口。
- **conversation_read_original 跨源过滤与批量导出** (v1.15.5+)：`list/export` 支持 `dataChains`、`workspaces`、`workspaceMode` 组合过滤；`exportBatch=true` 会把每条对话导出到独立目录并写入 `batch_manifest.json`。`dataChain="auto"` 且传 `conversationId` 时默认并行探测四数据源，只有唯一命中才自动选择，Antigravity/Windsurf 离线会按 warning 处理而不是拖垮其它源。
- **Claude Code 多账号侧栏索引增强** (v1.15.6+)：Claude Code 原文仍以 `~/.claude/projects/**/*.jsonl` 为准；`list` 会额外扫描 Claude 桌面侧栏索引层的 `local_*.json`，合并 `accountId`、`organizationId`、`isArchived`、桌面标题和最后活跃时间。换账号导致桌面侧栏旧会话暂时不可见时，MCP 仍可读共享 JSONL 原文；索引只做可选元数据增强。
- **Conversation App 标题与 WSF 工作区元数据增强** (v1.15.7+)：Codex `list/get/resolve` 会优先使用 `~/.codex/session_index.jsonl` 的 App 侧栏重命名标题，SQLite 旧标题只作 fallback；Windsurf `list/export` 会优先使用 `renamedTitle`，并解析 `workspaces[].workspaceFolderAbsoluteUri` 参与工作区过滤，避免 WSF 改名标题和工作区批量导出漏命中。
- **Conversation 工作区过滤范围与长标题展示治理** (v1.15.8+)：`conversation_read_original(list/export)` 新增 `workspaceScope="any|primary"`。默认 `any` 保持旧行为，会匹配主工作区和关联工作区；`primary` 只匹配对话主工作区，适合排除 WSF 跨项目引用导致的误命中。列表展示中的超长 App 标题会被折叠为短标题并标记 `[titleTruncated]`，搜索、读取和导出的原始数据不受影响。
- **Codex 子代理线程标注** (v1.15.9+)：Codex 子代理线程在 `conversation_read_original(list)` 中显示为 `子代理对话(role)：...`，候选 detail 会标出 `parentConversationId`；直接 `fetch/read/search` 子代理线程时会在头部提示源头对话 ID 与源头标题。Claude Code 与 Windsurf 子代理不作为独立对话强行标注。
- **Claude Code 加密思考占位** (v1.15.10+)：Claude Code JSONL 中 `thinking=""` 但存在 `signature` 的加密思考块，在 `read(depth="full", extraTypes=["thinking"])` 中会显示 `🔒 加密思考块 step N：thinking 为空，signature 存在，明文不可读`；完整 signature 不输出，也不会进入 contextProbe、deep_locate、Record、Guard 或 Golden Extract 的正文材料。
- **Conversation 主子线程定位与角色过滤** (v1.15.11+)：`conversation_read_original(list/export)` 支持 `threadMode="main|children|all"`、`parentConversationId`、`parentQuery`。默认 `main` 只返回主线程；若标题命中 Codex 子代理线程，会回指父线程并标注 `matchedChildConversationId`。`read` 支持 `messageRoles=["user","system","model","assistant","tool","subagent"]`；`user` 只读真实用户消息与结构化批注，`subagent` 单独读取子代理事件，不把它们混入人类轮。
- **Codex 标题全量轻量定位与 Record 写入门禁** (v1.15.11+)：Codex 标题/ID/工作区/来源查询使用 `session_index.jsonl` 等轻量元数据，不再被最近 300 条正文候选限制；`record_manage(update/batch_update/bulk_update)` 与自动后台 Record 写入前会统一拒绝 `0 Phase`、覆盖轮次不足、异常缩水或 Phase 范围重叠的候选，候选保存到 `memory-store/temp`，旧正式 Record 保持不变。
- **Record 手动补充保护误判修正** (v1.15.12+)：Local Compose 仍严格保留旧 `[手动补充]` 内容；质量检查比较前会忽略历史重复列表编号，避免 `9. 3.` 与 `1.` 这种编号变化被误判为内容丢失。
- **Conversation list 多词查询修正** (v1.15.13+)：`conversation_read_original(list/export)` 在标题、ID、工作区、主/子线程等轻量元数据定位中，会把空格分开的 `query` 词按“或”匹配；完整 ID、短 ID 前缀和完整标题仍优先排序。若要搜正文片段，仍使用 `search` 或 `deep_locate`，避免同步 `list` 扫超长原文。
- **Claude Code 逻辑续聊链与 Record 防缩水** (v1.15.14+)：`conversation_read_original(fetch/read/search/export, dataChain="claude-code")` 新增 `logicalChain="off|explain|auto|strict"`；默认 `off` 仍只读指定物理 JSONL，`explain` 只展示同工作区前序候选，`auto/strict` 仅在明确引用 ID/标题、压缩摘要或首尾内容重叠等强证据成立且无“从 0 开始/不要继承”信号时合并。`record_manage(update, dataChain="claude-code")` 默认用 `logicalChain="auto"`，但不会按标题语义强行合并。`force=true` 改为安全刷新：可解析旧 Record 时保留稳定 Phase、回滚尾部并走 RecordPatch + 本地合成，避免超长 Record 被整篇重生成压缩缩水；确需旧式全量重建可设置 `MEMORY_STORE_RECORD_FORCE_FULL_REBUILD=1`。最终写入门禁会容忍旧 Record 已存在且完全一致的稳定区 Phase 范围重叠，但仍拒绝新生成部分新增的重叠或倒退。
- **Record stale_check 与后台任务分层** (v1.17.3+ / v1.20+)：`record_manage(stale_check)` 用于检查 Record 是否落后于源对话，未在近期列表中找到的对话会标记为跳过而非确定丢失；`record_manage(update)` 与 `batch_update/bulk_update` 分别进入至少 8 槽的专用 materialization lane，模型并发仍只由持久 scheduler 与 provider admission 决定。Golden Extract、deep locate、批量导出等普通后台任务继续使用默认 2 槽 FIFO；`stage_guard(check)` 默认同步，仅在显式 `background=true` 时返回后台任务。
- **Grok/progrok 模型链路** (v1.18.0+)：`chain="grok"` 作为 `modelChain="grok"` 的兼容写法，`dataChain` 仍保持 `auto`；`modelChain="auto"` 优先探测本机 progrok proxy，成功时 Record、Stage Guard、smart search 等模型任务会按场景使用 Grok 模型，失败时继续按既有链路 fallback。Record prompt 预算、输出 token 上限、checkpoint/cache key 与报告输出会携带实际链路、实际模型和 `grokContext`，避免 `auto→grok` 与 fallback 结果串用；`finish_reason="length"` 会按截断失败处理并触发 fallback。
- **agy CLI 模型链路** (v1.20.0+)：`chain="agy"` 是 `modelChain="agy"` 的兼容写法，`agy` 永远不是 `dataChain`。显式 `modelChain="agy"` 只会调用本地 agy CLI 内置顺序「Gemini 3.5 Flash (High) → Flash (Medium) → Gemini 3.1 Pro (Low)」，失败不会跨到 Antigravity、Codex 或 Claude Code。`auto` 仅在设置 `MEMORY_STORE_AGY_AUTO_ENABLED=1` 时于 Grok 后尝试 agy；默认关闭以保持兼容路由。
- **Record 生产 provider 接线、调度 pump 与 unknown-chain 迁移** (v1.20.0+)：Grok、agy 与模型桥已接入统一的 provider transport，前台与 Record 分别携带对应流量类别申请物理许可；Record 更新由 production pump 和持久 coordinator 驱动，并保留恢复时的 claim/lease 处理。历史 `chain=unknown` 回填会对四宿主做完整证据核验，只有唯一匹配才生成带 CAS 前置条件的补丁，证据不完整或多宿主命中会保留为 `Unresolved` / `Conflict`，不会猜测性改写。
- **离线测试与公开包边界** (v1.20.0+)：默认 `npm test` 会执行 scheduler、source evidence、materialization/recovery、unit、commit 与 provider 的离线契约测试；npm 发布仅包含编译后的运行时代码、类型声明和公开说明文件，不会携带源码、测试、计划、工作资料或 source map。
- **持久恢复与来源证据边界** (v1.20.0+)：hard-exit 矩阵沿真实 runtime → production pump → provider → immutable spool → commit 路径注入进程退出，并只依赖同一 data root 恢复；`UnknownOutcome` 在宽限期内禁止重发，到期后最多消费一次预算并取得新的权威 fence，第二次仍不确定则终止。若 provider 不支持幂等键或结果状态查询，远端执行不能保证 exactly-once，系统只保证本地发布与索引提交不会重复生效，并明确保留可能重复调用的审计状态。四宿主附件只有具备可验证内容 SHA-256 时才进入冻结快照，data URL / base64 / 本地路径原文不会写入 Record payload；Codex SQLite 的 `rollout_path` 同时执行词法根目录与真实路径约束。缺少 identity sidecar 的旧 Record 正文仍可在持久锁和正文哈希匹配时安全刷新，提交协议会保存可条件恢复的 legacy before-image，而不会猜造历史所有权。
- **Record scheduler 真实生产闭环** (v1.21.0+)：来源枚举、exact/full read 与不可变证据统一接入四宿主生产入口；一个逻辑模型调用只创建一个稳定 Unit，Grok/agy/Codex 等物理调用作为该 Unit 的 Attempt 记录。网络、限流与本地资源故障在同 Unit 内 retry/fallback，只有 Quality/Complexity 才允许一次受限 split，避免把 provider 不可用误判成内容质量问题。
- **非阻塞 provider 接力与 agy 4+4** (v1.21.0+)：等待 provider permit 的 Unit 会持久挂起并释放后台 lane，不再阻塞其它 provider 或控制面。agy 的 first-run overflow 与 fallback 各保留 4 个逻辑槽、共享物理上限 8；Grok 饱和时 agy/Codex 可继续推进，任务状态按 Task 展示前方未终态 Task 数，并单独显示 Unit/Attempt 进度。
- **重叠热重启、force 发布换代与终态约束** (v1.21.0+)：same-identity admission 通过跨进程 namespace lock 复用同 taskId；foreign owner 由 PID/启动时间/lease fencing 接管，pending discovery 在 spool 建立前可连续重启恢复。显式 force 只有在正文、主索引、Reader Index 全部匹配旧 publication claim 时才推进发布代际；缺失、ownerless、部分发布或外来 owner 一律 fail closed。Task 只有在 durable local-finalize 全部 verified 后才能 Succeeded，Deferred/Cancelled/UnknownOutcome 不会被投影成假成功。
- **Record 手动修改的发布围栏** (v1.21.0+)：公共 `record_manage(edit/delete)` 会先取得可见 artifact 锁，再在发布注册表中推进 epoch/fencing token、清除旧 lease/claim，并把被替换的 Task ID 写入持久墓碑；旧 Task 不能重新挂接或重新取得 lease，同 revision 的全新 Task 仍可继续。索引已有 chain 时该宿主是唯一权威，外宿主发布状态、chain 缺失后的多候选或残缺候选都会 fail closed 为 RepairRequired。
- **Record 调度原始意图收尾** (v1.21.1+)：auto route 的单一 Unit 在 Grok permit 满载且尚未发生物理调用时，会用同一 attemptId 尝试 agy first-run overflow；Grok 真失败后的 agy 仍归 fallback。Antigravity LS、Codex CLI、Claude Code CLI 的启动/连接/超时/非零退出统一保真为 Availability，成功调用空输出才是 Quality，避免基础设施故障触发内容 split。
- **后台槽隔离与无终止排队** (v1.21.1+)：Windsurf Record admission 的 ownership 预探测显式使用 background，不再在 taskId 返回前占用 foreground 读取保留槽。Record single-flight 与持久化 gate 的纯容量等待没有终止性 queue timeout，只会在取消或任务已结算时退出；旧 `MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS` 不再影响行为。
- **压力下的锁与失败分类诚实性** (v1.21.1+)：Windows scheduler ledger lock 的创建、元数据写入和 stale-lock 读取遇到瞬时 EPERM/EACCES/EBUSY 时，会在原 lock deadline 内等待重试，不把文件占用误报成模型或 Task 失败。Antigravity LS 非 200 响应、Codex 输出文件读取失败均为 Availability；只有成功响应但内容为空才是 Quality。
- **模型桥与 Guard 边界恢复** (v1.21.2+)：Guard 截断不会切断 UTF-16 emoji 代理对；Codex Desktop 更新导致配置中的旧哈希路径失效时，会从本机安装目录选择最新 `codex.exe`；provider owner 的本地租约已过期时会重新认领新 epoch，不再用旧凭证续租并长期 fence 模型链路。
- **后台任务 cancel / recover** (v1.19.0+)：新增统一 `background_task_status` / `background_task_cancel`；Record、Stage Guard check、Golden Extract、批量导出和 deep locate 传播取消并阻止幽灵写回。后端启动会扫描持久任务：Record 按 checkpoint/ledger 续跑，Guard/Golden/批量导出按各自幂等规则恢复，任务文件默认保留 15 天。
- **Broker 动态等待 + WSF 缓存与统一模型准入**：共享 broker 按 `waitSeconds` / `timeout` 参数动态放宽调用窗口，普通请求仍保留默认 120 秒保护，等待类上限默认 30 分钟；实际长轮询建议使用 30–45 秒短轮询。Record 格式化会异步让出事件循环；Windsurf LS 保留独立 AIMD，Grok/agy 等模型调用统一经过持久 provider admission，foreground 与 Record 共享物理池并按 2:1 加权公平。Windsurf fetch/read 使用 TTL+LRU last-good 缓存、5 秒免复核窗口和 partial/0 轮保护。
- **WSF 前后台公平调度** (v1.19.2+)：`MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS` 默认 2。普通 conversation/Guard 请求为 foreground，Record 后台更新与 batch 为 background；后台在没有前台等待时可借满槽位，前台到达后不抢占运行中的 RPC，但在下一槽释放时优先。有效保留槽随 AIMD current limit 动态钳制，limit=1 时自动归零。
- **对话渲染边缘修复** (v1.19.2+)：brief 不再输出空 AI 标题，`messageRoles=["tool"]` 按 step/seq 稳定分组，非法 NaN/undefined stepIndex 统一降级为无 step 的 AI 标题。
- **Record 批量筛选、账本与 Grok 调度** (v1.20.0+)：`batch_update/bulk_update` 先分类、排序再应用 `limit`；默认选 stale+missing，`force=true` 再含 fresh，`stale_only=true` 始终只选 stale。近期列表未命中的 Record 保留为 unresolved，来源链路冲突安全跳过；每个 batch `taskId` 绑定 `resumeKey` 与 v2 ledger，恢复不重算已冻结候选。批次业务总计只读 ledger，AIMD 仅报告当前 Node 进程的运行诊断。
- **Codex 原文附件懒解析** (v1.12.2+)：Codex 图片可从 JSONL 内联 `data:image/...`、`local_images` 和 `Files mentioned` 文本块恢复为可读附件；`fetch` 只统计附件，`read/search/export` 命中轮次时才按需并行生成或复制图片，带哈希缓存、数量上限和大小上限。
- **Stage Guard 自指收口识别** (v1.12.3+)：当 Guard 明确承认实质产物、测试或用户裁定证据已充分，唯一缺口只是“本次 Guard 结果 / PASS 记录 / 完成标记”等后置记录时，自动按通过收口并保留 warning；混有真实代码、测试、文件缺口时仍保持失败。

## 四数据链路与模型链路说明

- `chain="auto"`：优先使用当前宿主链路；当前宿主不可用时，才尝试其它链路
- `chain="antigravity"`：强制走 Antigravity Language Server 链路；目标宿主不在线时直接报错
- `chain="codex"`：强制走 Codex 本地线程/模型桥链路；目标宿主不在线时直接报错
- `chain="claude-code"` / `chain="cc"`：强制走 Claude Code 本地 JSONL / CLI 链路；`cc` 会在内部归一为 `claude-code`
- `chain="windsurf"` / `chain="wsf"`：只在读取对话数据的工具里作为 `dataChain="windsurf"` 兼容写法；模型链路不会走 WSF，会回落 `auto`
- `chain="grok"`：只作为 `modelChain="grok"` 兼容写法；`dataChain` 保持 `auto`，显式 `dataChain="grok"` 不支持
- `chain="agy"`：只作为 `modelChain="agy"` 兼容写法；`dataChain` 保持 `auto`，显式 `dataChain="agy"` 会明确报错
- `dataChain` / `modelChain`：把“读取数据”和“调用模型”拆到不同链路；未填时分别继承 `chain`
- 兼容规则：`chain` 未填默认为 `auto`，`dataChain` 未填用 `chain`，`modelChain` 未填用 `chain`；如果 `chain` 是 `windsurf/wsf`，`modelChain` 会按 `auto` 处理；如果 `chain` 是 `grok` 或 `agy`，`dataChain` 会按 `auto` 处理
- `conversation_read_original` 的 `list/fetch/read/exact/fuzzy` 主要使用 `dataChain`；`list/search` 的 `smart` 模式用 `dataChain` 读取候选摘要、`modelChain` 调模型
- `conversation_golden_extract` 用 `dataChain` 读取对话、`modelChain` 调模型提取黄金片段
- 模型调用的 `auto` 优先探测 Grok/progrok，只有 `MEMORY_STORE_AGY_AUTO_ENABLED=1` 时才接着探测 agy CLI，然后 fallback 到 Antigravity LS、Codex 模型桥，必要时才按调用点允许使用 Claude Code CLI
- 显式指定 `chain="antigravity"`、`chain="codex"`、`chain="claude-code"`、`chain="grok"` 或 `chain="agy"` 时，不做跨宿主静默回退；显式 `modelChain="agy"` 只走 agy 内部三模型 fallback
- `modelChain` 只支持 `auto|antigravity|codex|claude-code|cc|grok|agy`；传入 `windsurf/wsf` 会明确报错，`dataChain="agy"` 也会明确报错
- Grok/progrok 不会由 memory-store 自动启动，只会探测 `MEMORY_STORE_GROK_PROXY_URL`；真实 smoke 前需确保 proxy 已在本机运行
- Codex 模型桥默认值：`gpt-5.5` + `model_reasoning_effort=medium` + `model_speed_tier=fast`
- Claude Code CLI 默认值：`MEMORY_STORE_CC_MODEL=sonnet`、`MEMORY_STORE_CC_EFFORT=medium`；普通 `modelChain="auto"` 不默认消耗 CC 额度，CC 相关非 Record 模型任务才允许按 `Antigravity > Codex > Claude Code CLI` fallback。
- Grok 默认模型：轻量任务使用 `MEMORY_STORE_GROK_MODEL`（默认 `grok-4.20-0309-non-reasoning`），Record 使用 `MEMORY_STORE_GROK_RECORD_MODEL`（默认 `grok-4.3`），Stage Guard 使用 `MEMORY_STORE_GROK_GUARD_MODEL`（默认 `grok-4.5`）；输出 token 上限 default/Record/Guard 分别默认 800/8192/4096，可用 `MEMORY_STORE_GROK_MAX_TOKENS`、`MEMORY_STORE_GROK_RECORD_MAX_TOKENS`、`MEMORY_STORE_GROK_GUARD_MAX_TOKENS` 覆盖；Record 场景 Grok 失败后 Antigravity fallback 使用 M20。
- 可覆盖环境变量：`MEMORY_STORE_GROK_PROXY_URL`、`MEMORY_STORE_GROK_API_KEY`、`MEMORY_STORE_GROK_MODEL`、`MEMORY_STORE_GROK_RECORD_MODEL`、`MEMORY_STORE_GROK_GUARD_MODEL`、`MEMORY_STORE_GROK_MAX_TOKENS`、`MEMORY_STORE_GROK_RECORD_MAX_TOKENS`、`MEMORY_STORE_GROK_GUARD_MAX_TOKENS`、`MEMORY_STORE_GROK_RECORD_MAX_PROMPT_CHARS`、`MEMORY_STORE_GROK_RECORD_TIMEOUT`、`MEMORY_STORE_AGY_COMMAND`、`MEMORY_STORE_AGY_AUTO_ENABLED`、`MEMORY_STORE_AGY_RECORD_MAX_PROMPT_CHARS`、`MEMORY_STORE_AGY_RECORD_TIMEOUT`、`MEMORY_STORE_CODEX_MODEL`、`MEMORY_STORE_CODEX_REASONING`、`MEMORY_STORE_CODEX_SPEED`、`MEMORY_STORE_CC_MODEL`、`MEMORY_STORE_CC_EFFORT`、`MEMORY_STORE_CC_MODEL_TIMEOUT_MS`、`MEMORY_STORE_AUTOSUMMARY_MODEL`、`MEMORY_STORE_AUTOSUMMARY_TIMEOUT_MS`
- `memory_query`、`memory_batch(query)`、`memory_write`、`memory_update`、`memory_stats(action="enhance")` 只涉及共享记忆数据与模型调用，支持 `modelChain`，旧 `chain` 继续作为兼容别名

## Benchmark 与诊断脚本

`scripts/` 下的 Grok / LS benchmark 脚本只用于维护期对比本机 progrok proxy 与 Antigravity LS 模型质量，不属于 MCP 运行路径；运行前先完成 `npm run build`，并确认目标 proxy 或 LS 可用。

- `node scripts/grok-bench.mjs` / `powershell -ExecutionPolicy Bypass -File scripts/grok-bench.ps1`：对 Grok 模型列表做轻量摘要与 Record 生成 prompt benchmark。可用 `MEMORY_STORE_GROK_PROXY_URL`、`MEMORY_STORE_GROK_API_KEY`、`MEMORY_STORE_GROK_BENCH_MODELS` 覆盖 proxy、认证 key 和逗号分隔模型列表。
- `powershell -ExecutionPolicy Bypass -File scripts/grok-check.ps1`：快速检查 progrok chat completions 可用性。可用 `MEMORY_STORE_GROK_CHECK_MODEL` 覆盖检查模型。
- `node scripts/ls-bench.mjs`：对 Antigravity LS 模型做同类 benchmark。可用 `MEMORY_STORE_LS_BENCH_MODELS` 和 `MEMORY_STORE_LS_BENCH_CONCURRENCY_MODEL` 覆盖模型列表与并发探测模型。

## 搜索模式

`memory_query`、`memory_batch` 的 query 子操作、`record_manage(action="search")`、`conversation_read_original(action="list|search|export")` 都支持 `mode="auto|exact|fuzzy|smart"`；语义搜索建议使用 `modelChain` 指定模型链路。`export(scope="search")` 默认只做本地 exact/fuzzy 检索，不隐式调用模型做全库语义召回。

- `exact`：精确/分词匹配
- `fuzzy`：模糊匹配
- `smart`：模型语义搜索，使用 `modelChain` 选择 Grok/progrok、Antigravity LS、Codex 模型桥或显式 Claude Code CLI
- `auto`：先本地 exact/fuzzy，必要时再走 smart

### Record Reader 与 `general` 归属治理

Record markdown 仍是唯一事实源。v1.12 的 Record Reader 方向只增强读取、搜索、导读和归属治理，不生成“Record 的 Record”，也不改变 Plan_11 稳定后的 Record 写入格式。

结构化读取参数：

- `record_manage(action="read", conversationId="...", view="outline", format="json")`：读取目录、Phase、section 统计和 warning。
- `view="state|outputs|lessons|risks|verification"`：只读当前状态、产出文件、经验教训、风险或验证区块；`state/lessons/risks/verification` 默认按最新区块优先返回，便于小预算下先看到最新状态。
- `view="phase", phaseIds=[1], exclude=["risks"]`：读取指定 Phase，并排除指定 section。
- `sectionTypes=["outputs"]`、`include`、`exclude`、`maxChars`、`withCitations`、`indexMode="auto|reuse|rebuild|off"` 可进一步控制读取范围。
- 结构化读取按标题层级形成 block：tail 区的 `# 产出文件总清单` 会包含其下 `## 源码与配置` 等子标题内容，不会只返回空父标题。
- 发生截断时，文本与 JSON 都会给出 `nextReadHint`；可把其中的 `startBlockId` 传回 `record_manage(read, startBlockId="...")` 继续读取。
- 不传 `view` / 结构化过滤参数时，旧 `read` 行为保持不变：短 Record 直接返回，长 Record 写临时文件。

结构化搜索与导读：

- 旧 `record_manage(action="search", query="...")` 默认仍按整份 Record 搜索。
- 传 `conversationId`、`recordIds`、`phaseIds`、`sectionTypes`、`searchScope="record|phase|section|item"` 或 `format="json"` 时，会改用 reader index 的 block 级搜索，并返回 `recordId`、`phaseId`、`sectionType`、`blockId`、`lineRange`、`charRange` 和 `readHint`。
- `record_manage(action="guide", goal="...", conversationId="...")` 只返回推荐阅读路径、搜索参数和来源位置，不生成事实摘要，也不写回正式 Record。
- reader index sidecar 存在于同一 records 目录，文件名形如 `{conversationId}.record_index.json`；Record 写入后会构建，read/search/guide 缺失时会懒重建。

`general` 的定位是无法确定真实工作区时的兜底区，不再作为每个 workspace 的隐式共享池：

- `record_manage(action="list", scope="workspace", workspace="...")`：只列指定 workspace。
- `record_manage(action="search", scope="workspace", workspace="...")`：只搜索指定 workspace。
- `includeGeneral=true`：显式恢复旧的 workspace + general 合并视图。
- `scope="global"`：搜索或列出所有 workspace 与 `general`。
- `workspace="general"` 或 `scope="general"`：只处理 `general`。

归属治理只使用结构来源，不做语义分类：

- Antigravity：读取对话 steps 中的 `activeUserState.openDocuments[].workspaceUri`。
- Codex：读取 thread `cwd`；子线程可使用 parent/root 派生关系。
- Claude Code：读取 JSONL 中的 `cwd`，不按标题或正文语义猜测工作区。
- 同一 `conversationId` 多副本：比较 `lastUpdatedRound`、`totalRounds`、`lastUpdatedAt`、`sizeBytes`，识别 duplicate / migratable / unknown / conflict。
- `audit_ownership` 是只读审计。
- 路径别名会先做保守规范化：`C:\project` 与 `\\?\C:\project` 会归为同一 workspace identity；已存在的旧 alias hash 作为兼容候选读取，但成功 repair/update 后会被标记为 `superseded`。
- `repair_ownership` 默认 `dryRun=true`，只返回迁移计划；非 dry-run 首版只 copy/upsert 到目标 workspace，并写入 ownership sidecar 标记来源副本被取代，不删除来源副本。

### Codex / Claude Code / Windsurf 对话原文来源

当工具走 `chain="codex"` 时，对话原文来自 Codex 本地数据：

- 线程索引：`~/.codex/state_5.sqlite`
- 原始事件流：`~/.codex/sessions/**/*.jsonl`

Codex 链路下的轮次是基于原始事件流的重建结果，目标是尽量贴近 Antigravity 的阅读体验。
`depth="full"` 配合 `extraTypes=["thinking","tool_results","code_actions","code_diffs","file_views"]` 时，会尽量展开 Codex 的可读 reasoning 摘要、命令/MCP/custom tool 结果、`apply_patch` 统一 diff，以及 Plan 等文件/计划类事件；加密 reasoning 不会被输出。
从 v1.12.6 起，Codex JSONL 使用流式读取；`session_meta` 里的超长 instructions、加密 reasoning 和单条超大文本会在读取层丢弃或裁剪，`fetch/read/search` 也会在构建输出时按预算提前截断并建议按轮次分段读取。

Codex 附件读取从 v1.12.2 起按需处理：

- 图片来源优先级：`event_msg.user_message.local_images` 本地路径优先；如果只剩 `response_item.message.content[].input_image` 的 `data:image/...;base64,...`，则在 `read/search` 真正输出该轮次时写入 `memory-store/temp/codex-attachments/<conversationId>/round-xxxxxx/sha256-*.png`。
- 普通文件来源：从 `# Files mentioned by the user` 文本块解析 PDF / DOCX / Markdown 等路径，只做路径解析和存在性标注，不读取文件正文。
- `fetch` 只返回附件数量、内联图片数量和本地路径存在性，不批量解码整条对话的图片。
- `read/search` 只处理指定轮次或命中上下文轮次；过多附件按 `MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_LIMIT` 限制数量，按 `MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_CONCURRENCY` 并行限流，按 `MEMORY_STORE_CODEX_ATTACHMENT_MAX_BYTES` 限制单图大小，按 `MEMORY_STORE_CODEX_ATTACHMENT_MAX_TOTAL_BYTES` 限制单次总解码量，并通过 SHA-256 文件名复用缓存。
- Antigravity 的 `brain/<conversationId>/media__*.png` 媒体路径保持原样输出，不复制到 Codex 临时目录。

Claude Code 链路下的原文来自 `~/.claude/projects/**/*.jsonl`。读取层会把 `user/assistant/system/attachment/ai-title/custom-title/last-prompt` 等事件归一为统一轮次：普通用户消息开启新轮次，纯 `tool_result` 回填到对应工具调用，明文 `thinking` 只在 `depth="full"` 或 `extraTypes=["thinking"]` 时显示；若 `thinking=""` 但存在 `signature`，只显示加密占位，不输出完整 `signature`。图片内联 base64 与本地附件路径沿用懒解析策略：`fetch/list` 只显示统计和元信息，`read/search` 命中轮次时再按需生成临时文件或标注原路径。

Claude Code 桌面侧栏索引是另一层可选元数据，常见于 `%APPDATA%\Claude\claude-code-sessions\<accountId>\<organizationId>\local_*.json`，新版桌面也可能改名为相邻目录。MCP 不依赖它读取正文，只在 `conversation_read_original(action="list", dataChain="claude-code")` 时扫描 `local_*.json` 并合并账号、组织、归档、桌面标题和最后活跃时间；可用 `MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS` 指定额外索引根目录，用系统路径分隔符分隔。

Claude Code 的 `compact_boundary + isCompactSummary` 续聊摘要默认作为压缩元信息处理：`read` 默认 `compactionMode="folded"`，只在实际输出到该轮时生成 `memory-store/temp/claude-code-compact-summaries/<conversationId>/` 下的 Markdown；`depth="full"` 或 `compactionMode="full"` 会展开摘要但保留 `<<<CLAUDE_CODE_COMPACT_SUMMARY>>>` 标记；`compactionMode="omit"` 只保留省略标记，适合 `fetch`、Record、Guard 和 Golden Extract 的去噪场景。

Claude Code 的桌面 UI 有时会让用户以为仍在同一条聊天里继续，但底层可能已经写入新的 JSONL；MCP 默认不把这些物理会话自动拼成一条，避免同名标题误合并。需要排查时可先用 `conversation_read_original(action="fetch", dataChain="claude-code", conversationId="...", logicalChain="explain")` 查看候选；只有显式 `logicalChain="auto|strict"` 或 Record 更新的安全自动路径，才会在强证据足够时恢复逻辑续聊链。

Windsurf 链路下的原文来自本机 Windsurf Language Server 的只读 Cascade 接口。工具只调用 `GetAllCascadeTrajectories` 和 `GetCascadeTrajectorySteps`，不会调用发送消息、模型代理或 ACP summary-agent。WSF 用户图片从 `userInput.images[]` 转成 `windsurf-data-url` 附件描述，`fetch/list` 只显示统计，`read/search` 命中轮次时再按既有数量、大小、并发和总量限制生成临时图片。WSF 首版不支持 `deep_locate` 后台深搜，也不把 `.pb` 离线文件当主读取来源。

WSF 工具类 steps 从 v1.15.2 起会进入统一执行记录：`CORTEX_STEP_TYPE_RUN_COMMAND`、`MCP_TOOL`、`FIND`、`VIEW_FILE`、`CODE_ACTION`、`LIST_DIRECTORY`、`COMMAND_STATUS`、`PROXY_WEB_SERVER` 会分别映射为命令、MCP、检索、文件查看、代码改动、目录、状态等短证据。Stage Guard 会读取这些归一化证据；如果 WSF LS 因单个超大 step 返回 partial，Guard 和 Record 仍会明确提示 partial 风险，不把缺失片段当作已验证。

v1.19.0 起，WSF `fetch` 强制刷新并写入 last-good cache，后续 `read/search` 优先复用 TTL+LRU 缓存；fresh cache 在默认 5 秒 revalidation window 内不访问 LS，过窗后才用受控 summary RPC 校验 `stepCount`。刷新得到 partial、LS 异常，或出现 `stepCount>0` 但 0 轮的坏结果时，不覆盖 last-good；无可用旧缓存时 `read` 会明确提示“LS 读取不完整”。read 路径还带独立格式化与附件预算，超预算返回部分结果；默认共享格式化函数、search/export/子线程展开不受该预算影响。

### 对话定位

`conversation_read_original(action="list")` 可按标题、工作区路径、ID 片段、已有 Record 摘要和近期上下文指纹列出候选对话，适合只知道界面标题、短 ID 或当前对话片段但不知道完整 `conversationId` 的场景。Codex 链路支持唯一 ID 前缀解析，Record 的 read/edit/delete 也支持唯一短前缀。标题、ID、来源、工作区和主/子线程筛选走轻量元数据定位；`query` 中用空格分开的词会按“或”匹配候选，完整 ID/标题仍优先。正文片段检索仍应使用 `search` 或 `deep_locate`，避免把古老超长对话全量塞进同步 list。

从 v1.13.0 起，Codex 链路的 `list(mode="auto")` 是快查入口；v1.14.0 起 Claude Code 也走同类快查：会查标题/ID/工作区、Record / reader index 轻量内容和最近尾部 `contextProbe`，但 query 未命中时不会自动读取多个超大 JSONL 原文预览，也不会自动触发 smart 搜索。若 query 实际是古老正文片段，`list` 会明确提示需要后续 deep locate 后台深搜，而不是把快查拖到 60 秒 MCP 超时。Antigravity 链路保持旧的 auto 兼容行为；显式 `mode="smart"` 只在轻量候选材料上使用 smart，不做全库原文扫描。

正文搜索仍保留候选预算和后台深搜：`MEMORY_STORE_CONVERSATION_LIST_CANDIDATE_LIMIT` 只影响旧兼容路径和正文候选预算；标题/ID/工作区/source/threadMode 这类“找对话本身”的查询会走全量轻量元数据。`MEMORY_STORE_CONVERSATION_LIST_RAW_SCAN_LIMIT` 仅用于保留旧链路和显式允许原文预览的路径，Codex `list(auto)` 不使用它做隐式深扫。

古老正文片段反查使用后台 deep locate：

```text
conversation_read_original(
  action="deep_locate",
  dataChain="codex|claude-code",
  query="某段正文片段",
  mode="exact|fuzzy",
  background=true
)
```

启动后用 `conversation_read_original(action="deep_locate_status", taskId="...", waitSeconds=30)` 轮询；需要中止时用 `conversation_read_original(action="deep_locate_cancel", taskId="...")`。deep locate 支持 Codex 与 Claude Code，默认后台、低并发、预算受控，不使用 smart 做全库召回；Windsurf 首版会明确返回 unsupported，不做 `.pb` 或大缓存扫描。

Codex / Claude Code 链路的 `list` 额外支持 `contextProbe`：调用方可从当前可见对话截取 50-120 字有辨识度的上下文片段传入，工具会在最近本地 JSONL 中做 fixed-string 语义的硬匹配，并在候选列表中标记 `contextProbe` 命中项。Codex 命中子代理线程时会同时补标 parent/root 候选，且优先把可能的主线母线程排在子线程前；多个线程命中时只标记和排序，不自动选中或写入。Codex 可用 `MEMORY_STORE_CODEX_CONTEXT_PROBE_SCAN_LIMIT`、`MEMORY_STORE_CODEX_CONTEXT_PROBE_MAX_BYTES` 调整；Claude Code 可用 `MEMORY_STORE_CC_CONTEXT_PROBE_SCAN_LIMIT`、`MEMORY_STORE_CC_CONTEXT_PROBE_MAX_BYTES` 和 `MEMORY_STORE_CC_CONTEXT_PROBE_DEADLINE_MS` 调整。

Codex / Claude Code / Windsurf 侧通过共享后端、本地 JSONL 或只读 LS 接口工作，不具备每个对话独立的“当前对话”状态。使用 `conversation_read_original(action="fetch|search|read|export")`、`record_manage(action="update")`、`conversation_golden_extract`、`stage_guard` 时必须显式传入稳定的 `conversationId`。`conversation_read_original(fetch/search/read/export)` 若未传 `conversationId` 且不是显式 `dataChain="antigravity"`，会直接返回错误，防止串读到其它当前窗口；如果只知道标题或关键词，先用 `conversation_read_original(action="list", dataChain="codex|antigravity|claude-code|windsurf", query="...")` 定位完整 ID；Codex/Claude Code 可额外传 `contextProbe="..."` 辅助硬匹配当前线程。

### 对话持久导出

`conversation_read_original(action="export")` 会复用现有可读轮次格式，把选定范围写入持久导出目录。默认目录为 `memory-store/exports/conversations/<dataChain>/<conversationId>/conversation_<timestamp>/`；也可传 `outputDir`，目录不存在时自动创建，`overwrite=true` 时直接写入指定目录而不再创建时间戳子目录。

批量查询和导出可用 `dataChains=["codex","antigravity","claude-code","windsurf"]` 与 `workspaces=["C:\\path\\to\\workspace"]` 组合过滤。`conversation_read_original(action="list", dataChains=[...], workspaces=[...])` 会合并候选并标出每条的 `dataChain`；`conversation_read_original(action="export", exportBatch=true, dataChains=[...], workspaces=[...])` 会为每条候选创建独立导出目录，不生成混合大文件。`workspaceScope="any"` 是默认值，会把主工作区和关联工作区都纳入匹配；如果只想查“真正发生在该工作区”的对话，传 `workspaceScope="primary"`。单个数据源离线时默认只写 warning，可用 `sourceFailureMode="fail"` 改为严格失败。

主/子线程查询可用 `threadMode` 控制：默认 `main` 只返回主线程；`children` 需要 `parentConversationId`，或用 `parentQuery` 唯一定位父线程后列出子线程；`all` 显式混合返回主线程与子线程。Codex 会使用结构化 `thread_spawn_edges`，不会按标题语义猜测父子关系。

按消息角色读取可用 `conversation_read_original(action="read", messageRoles=[...])`：`user` 只读真实用户消息与结构化批注，`model`/`assistant` 只读模型回复，`tool` 只读工具调用、文件视图和代码动作，`system` 只读压缩摘要、规则注入占位和系统类轮次，`subagent` 只读带昵称、对话 ID 和原始来源角色的子代理事件。未传 `messageRoles` 时保持完整轮次格式；搜索命中批注时返回单条 Annotation 和命中字段，不展开整个父轮。

常用参数：

- `exportFormat="markdown|pdf|both"`：默认 Markdown；`pdf` / `both` 会先生成同一份 Markdown，再用 Edge/Chrome 无头隐藏模式打印为 PDF。
- `exportScope="full|rounds|search"`：全量、轮次范围或关键词命中范围；`rounds` 使用 `startRound/endRound`，`search` 使用 `query/contextRounds/limit/mode`。
- `includeAssets=false`：只导出正文，不复制图片和文件。
- `pdfEmbedAttachments="off|auto|force"`：默认 `auto`；若本机有 `pypdf`，普通文件附件会尝试原生嵌入 PDF；不可用时仍保留 Markdown/PDF 中的附件清单和相对链接。

导出产物包括 `conversation.md`、`manifest.json`、可选 `conversation.pdf` / `conversation.html`，以及 `assets/images`、`assets/files`。图片会在 PDF 页面中直接显示；普通附件优先作为相对链接列入清单。导出不触发 Record 更新，也不改变 `fetch/read/search` 的旧行为。

`conversation_read_original`、`conversation_golden_extract` 和 `record_manage(update)` 支持 `dataChain` / `modelChain` 拆分。例如 `dataChain="windsurf"` 可读取 WSF Cascade 对话，`modelChain="grok"` 可使用本机 progrok proxy，`modelChain="agy"` 可使用本地 agy CLI 执行 smart 搜索、黄金片段提取或 Record 生成。agy 和 Grok 都不读取对话数据，Record 仍是文本 Record，不默认调用 Claude Code CLI 或任何 WSF 模型接口解析多模态附件。未传新参数时保持旧 `chain` 行为。

WSF `GetCascadeTrajectorySteps` 存在单个 step 大小限制；若遇到 `step at offset ... larger than 4194304 byte limit`，`conversation_read_original(fetch/read/search)` 会保留已读取内容、插入超大 step 占位轮次并尝试继续读取后续 steps，同时标记 partial 警告。partial WSF 结果不会自动触发 Record 更新，显式 `record_manage(update, dataChain="windsurf")` 也会中止，避免把缺失原文写入正式 Record。

Grok/progrok 链路只负责模型调用，不读取对话数据。默认 proxy 地址为 `http://127.0.0.1:18645`，认证 key 默认 `grok-local-proxy`；可用 `MEMORY_STORE_GROK_PROXY_URL` / `MEMORY_STORE_GROK_API_KEY` 覆盖。`auto` 模型路由把 Grok 放在第一优先；Grok 502/429/普通调用失败会继续 fallback，显式 `modelChain="grok"` 不会隐式 fallback。Record 的 prompt 预算、输出 token 上限与 checkpoint 会按实际链路、实际模型和 `grokContext` 隔离，避免 `auto→grok`、`auto→antigravity(M20)` 与显式 `grok` 串用；Grok 返回 `finish_reason="length"` 时视为截断失败，显式 Grok 直接报错，auto 路由继续 fallback。

Antigravity LS 模型默认值：`MEMORY_STORE_LS_MODEL` 未设置时使用 `MODEL_PLACEHOLDER_M132`（Gemini 3.5 Flash High）；默认 fallback 为 `MODEL_PLACEHOLDER_M132,MODEL_PLACEHOLDER_M20,MODEL_PLACEHOLDER_M18,MODEL_PLACEHOLDER_M16,MODEL_PLACEHOLDER_M36`，可用 `MEMORY_STORE_LS_MODEL_FALLBACKS` 覆盖。`MODEL_PLACEHOLDER_M47` 已在 2026-04-28 实测返回 `unknown model key`，`MODEL_PLACEHOLDER_M37` 已在 2026-05-23 实测返回 `INVALID_ARGUMENT`，均不再放入默认链路。

### Codex 子代理线程呈现策略

- 主线程阅读结果默认保留子代理引用或摘要
- Codex 子代理线程在 `list` 中会标注为 `子代理对话(role)：...`；直接读取子线程时会显示源头对话 ID，防止把 explorer/worker 子线程误当主线对话
- `fetch` 读取 Codex 子代理线程时不会触发自动 Record 更新；默认由源头主对话统一记录，避免把低层 explorer/worker 线程写成独立主线 Record
- `link="reference"` 只显示子线程 ID/昵称/角色；`link="summary"` 显示完成摘要；`link="expand_children"` 读取一级子线程全文
- 只有显式要求展开时，才读取子线程全文；展开时会用 `thread_spawn_edges` 补充父线程事件里遗漏的子线程，并允许精确读取已归档但仍有 rollout 文件的子线程
- 子线程索引缺失、rollout 文件缺失或解析失败时，会在“子代理线程诊断”里显式列出，不再静默跳过
- Record、Guard、黄金片段提取等功能应明确区分主线程正文与外链附件

## 11 个 MCP 工具

| 工具 | 说明 |
|------|------|
| `memory_write` | 写入新记忆（含去重检测 + autoSummary 异步生成） |
| `memory_query` | 查询记忆（fuse.js + grep + 三档 depth + autoSummary 搜索） |
| `memory_read` | 读取单条记忆（支持行范围） |
| `memory_update` | 更新/追加记忆（内容变化自动重生成 autoSummary） |
| `memory_delete` | 删除记忆 |
| `memory_batch` | 批量操作（最多 20 个） |
| `memory_stats` | 统计/归档/导出/导入/enhance 批量增强 |
| `conversation_read_original` | 读取和导出对话原文（list/fetch/search/read/export + deep_locate 后台深搜） |
| `conversation_golden_extract` | 黄金片段提取（对话关键信息 + 记忆去重对比） |
| `record_manage` | 对话记录管理（update/list/read/search/guide/edit/delete/batch_update/bulk_update/batch_delete/task_status/cancel/recover/audit_ownership/repair_ownership/stale_check） |
| `stage_guard` | 任务完整性验证（start/check/status/cancel，分段取证 + 四层防御网） |
| `background_task_status` | 查询任意 task-backed 后台任务状态与进度 |
| `background_task_cancel` | 取消任意 task-backed 后台任务并传播持久取消状态 |

### Stage Guard 调用约束

在 Codex / Claude Code / Windsurf 侧使用 `stage_guard` 时，必须显式传入稳定的 `conversationId`。如果不知道当前线程 ID，先调用 `conversation_read_original(action="list", dataChain="codex|claude-code|windsurf", query="标题或关键词", contextProbe="当前可见对话片段")` 定位完整 ID，再把同一个 ID 用于后续 `start/status/check/cancel`。Guard 的对话数据固定绑定当前宿主的明确对话，只有审核模型通过 `modelChain` 选择；Windsurf 不作为审核模型链路，Grok 可通过 `modelChain="grok"` 或 `auto` 的第一优先路由参与审核。

v1.19.2 起，`childScopeId` 只负责区分并行 Guard，传入时必须同时提供 `scopeSelectors`（Task 编号、小标题或稳定锚点）来定义实际审核范围。同一 GuardKey 重复 start 默认拒绝，只有 `force=true` 才会精确替换；selector 不完整且存在多个候选时 check/status/cancel 返回候选列表，不会静默选择。后台 check 与 PASS receipt 会携带 guardId，旧结果若遇到 force 替换会判定过期并拒绝写回。

Codex / Claude Code / Windsurf 侧同步 MCP 调用存在宿主超时窗口。`record_manage(action="update")` 与 `batch_update|bulk_update` 默认创建持久 scheduler Task 并立即返回 `taskId`；单更新和批量更新分别使用至少 8 槽的专用 materialization lane，lane 只限制任务编排，不拥有模型 permit。batch/bulk 会先分类、排序、应用 limit，再冻结最终候选；ledger 发布后恢复只读取冻结候选与 immutable source spool。Golden Extract、deep locate 和批量导出仍进入普通后台队列；`stage_guard(action="check")` 默认同步，只有显式 `background=true` 才返回后台任务。共享 broker 会按 `waitSeconds` / `timeout` 参数动态延长调用超时，默认上限 30 分钟；普通调用仍保持默认 120 秒。Codex/Claude Code 本地模型桥 Record 生成会按实际轮次大小切批；Grok Record 默认 prompt 上限 200000 字、输出上限 8192 tokens、超时 120000ms，可用对应环境变量覆盖；Windsurf 只提供对话数据，Record 生成仍由 `modelChain` 选择模型链路。`task_status` 直接从 scheduler ledger 投影 Task/Unit/Attempt、等待原因和恢复状态。

普通后台任务带独立 FIFO、deadline 与一次性结算保护，默认最多同时运行 2 个，可用 `MEMORY_STORE_BACKGROUND_MAX_CONCURRENCY` 或 `MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY` 调整；conversation batch export 默认 30 分钟，Stage Guard / Golden Extract 默认 15 分钟，并可用各自或通用 max-run 环境变量覆盖。scheduler-backed Record Task 的 envelope 固定 `maxRunMs=0`，排队、breaker、time_frozen 或重启恢复不会被旧的一小时后台总墙钟误判失败；其终态只由权威 scheduler ledger 决定。

v1.20.0 的 `force × stale_only` 批量候选矩阵如下；四类候选先完成筛选与排序，才应用有效 `limit`。未传 `limit` 时非 force 默认 10、force 默认 200；显式值分别钳制到最大 50 / 200：

| `force` | `stale_only` | stale | missing | fresh |
|---|---|---|---|---|
| false | false | 更新 | 更新 | 跳过 |
| true | false | 更新 | 更新 | 更新 |
| false | true | 更新 | 跳过 | 跳过 |
| true | true | 更新 | 跳过 | 跳过 |

随后按 `stale → missing → fresh` 排序（同类按更新时间降序、ID 升序）。近期有限列表中未找到的既有 Record 为 unresolved，仅统计、不更新、不删除；`conversationId` 的来源链路与既有 Record 冲突时也会跳过，避免覆盖另一个源。调用立即返回 `taskId`，其 `resumeKey` 绑定同一逻辑 batch：ledger 未冻结前可按原 request 重扫，冻结后只续跑候选快照；v2 ledger 会保存 inFlight 写入意图，恢复时依次补齐正文、主索引与 Reader Index，`completed` 只在这些写入完成后落账。

### 统一并发与 Record 热路径

- **事件循环层**：Record 普通轮格式化每 `MEMORY_STORE_RECORD_FORMAT_YIELD_INTERVAL` 轮使用 `setImmediate` 异步让步，默认 5；设为 0 才禁用让步。让步后会重新检查取消或结算状态，`formatRound` 的同步 API 不变。
- **数据层（Windsurf LS）**：`MEMORY_STORE_WINDSURF_LS_CONCURRENCY` 是 AIMD 的**最大值**，默认 max=6、min=1、initial=1，不再表示固定并发。`MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS` 默认 2；后台无前台等待时可借槽，前台到达后在下一槽释放时优先，运行中的 RPC 不被抢占。`effectiveReserved` 会按 current limit 动态钳制；429、5xx、超时和网络中断才会减半回退。
- **模型层（统一 provider admission）**：Grok 与 agy 各自拥有持久物理池，默认 physical max=8、initial=2；foreground 与 Record 共同计入 active，双方持续等待时按 2:1 加权轮转，任一类空闲时另一类可借满。容量、loss epoch、breaker、probe lease、uncertain grace 与 owner epoch 持久化到 provider control；旧 `MEMORY_STORE_GROK_QUEUE_*` / `MEMORY_STORE_GROK_BATCH_CONCURRENCY` 不再控制物理并发。
- **Record scheduler**：Task → Record → Unit 惰性展开，外层使用公平债务与 2N 截止派发，Record 内按归一化七因子排序；全局 coordinator 持久化 dispatchSeq、claim phase 与 owner fencing。生产路径设置 `schedulerManagedExecution`，不会再经过 legacy process-wide generation gate；单/批 materialization lane 的有效并发至少为 provider physical max，模型 active 仍只由 provider permit 决定。
- **诊断与回退**：`task_status` 从 ledger 展示 aheadTaskCount、Unit/Attempt、provider、waiting reason、UnknownOutcome 与 RepairRequired；provider 诊断展示 traffic class、active/pending/current limit、capacity generation、breaker 与 queue wait。取消、质量失败、截断和本机资源不足不会误触发远端拥塞 AIMD；只有分类为 Congestion 的失败创建 loss epoch。

单更新与 batch orchestrator 的专用 lane 分别可用 `MEMORY_STORE_RECORD_UPDATE_BACKGROUND_CONCURRENCY`、`MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY` 调高，但即使配置更低也会钳制到 provider physical max=8，避免在 provider 前重新形成旧模型阀门。Windsurf 缓存默认 TTL 30 分钟、最多 10 条、5 秒内免 summary 复核，可分别用 `MEMORY_STORE_WINDSURF_CACHE_TTL_MS`、`MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES`、`MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS` 覆盖；partial 或非合法 0 轮刷新不会污染 last-good。

`stage_guard(action="cancel")` 会按完整 GuardKey 选择目标并按 `guardId` 精确移除锁块；若候选不唯一则要求补充 stageId/childScopeId。取消已经启动的后台 Guard check 或其它 task-backed 任务应使用 `background_task_cancel(taskId)`；`record_manage(action="cancel")` 与 `conversation_read_original(action="deep_locate_cancel")` 只是兼容入口。

Stage Guard 从 v1.13.4 起使用索引驱动分段取证：超长 `Task.md` / `Plan_x.md` 会先按当前 `stageId`、标题、头部规则、尾部、“待复核/小本本”和证据窗口裁剪；Record 使用 Reader 的 state/outputs/verification/risks 局部视图加少量锚点窗口；对话原文只保留从 Guard 开始轮次之后的工具结果、文件编辑、命令输出等高证据片段。工具会生成 coverage / evidence manifest 临时文件；若定位不到当前阶段、证据被截断或覆盖不足，返回“证据不足/审查未完成”，不累计 Guard 失败次数。

Stage Guard 从 v1.13.7 起支持外部证据文件索引：

- `evidenceFiles: string[]`：快速传入证据文件路径。
- `evidenceAssets: [{ path, label?, type?, role?, range?, maxChars? }]`：带标签、类型、角色、范围和预算的结构化证据输入。
- `evidenceIndexMode="auto|reuse|rebuild|off"`：控制复用、重建或关闭索引。
- 纯文本/代码/Markdown/日志按字节预算读取，图片默认只生成元信息并明确“未做 OCR/视觉理解”。
- PDF/视频默认优先尝试 Gemini CLI agentic 索引，再尝试 Codex CLI；Word/Excel/EPUB/PDF 可降级到 Python 结构化提取；失败时生成 unreadable stub 而不是让 Guard 崩溃。
- 所有复杂索引落在 `memory-store/temp/stage-guard-evidence-indexes/`，必须包含 `<<<GUARD_EVIDENCE_INDEX>>>` / `<<<END_GUARD_EVIDENCE_INDEX>>>` 标记；宿主只读取标记区和短诊断，避免大文件或完整 stdout 进入内存。

Record 读侧从 v1.12 起严格区分 workspace 与 `general`：`list/search` 在 `scope="workspace"` 下默认不混入 `general`；需要旧合并视图时显式传 `includeGeneral=true`。结构化 `read/search/guide` 使用 reader index sidecar，返回原文行号和 `readHint`，但不生成新的摘要事实源。`audit_ownership` 只读检测 duplicate / migratable / conflict / unknown；`repair_ownership` 默认 `dryRun=true`，首版非 dry-run 也只 copy/upsert，不删除来源副本。v1.12.4 起，路径别名副本和已标记 `superseded` 的旧副本不会进入默认 list/search 正式视图。

## 目录结构

```
mcp-memory-store/         ← MCP 服务代码
├── src/
│   ├── index.ts          ← 入口 + 进程管理（v1.7 容错心跳 + 非 LS 兜底）
│   ├── store.ts          ← 存储引擎（含 autoSummary 字段）
│   ├── search.ts         ← 搜索引擎（fuse.js + autoSummary）
│   ├── cache.ts          ← LRU 索引缓存
│   ├── lifecycle.ts      ← 进程生命周期（ppid 3 次容错 + LS 环境检测）
│   ├── temp-store.ts     ← 临时文件管理
│   ├── ls-client.ts      ← LS 通信 + 三步查找路由（v1.6 重构）
│   ├── ls-registry.ts    ← LS 注册表（v1.6 新增，跨窗口加速）
│   ├── trajectory.ts     ← 对话数据解析（v1.4+）
│   ├── conversation-attachments.ts ← Codex 原文附件懒解析与临时图片缓存（v1.12.2+）
│   ├── search-engine.ts  ← 三级搜索引擎（exact/fuzzy/smart/auto，v1.10+）
│   ├── record-reader.ts  ← Record Reader 索引、结构解析和局部读取（v1.12+）
│   └── tools/
│       ├── write.ts          ← 写入 + 异步 autoSummary
│       ├── query.ts
│       ├── read.ts
│       ├── update.ts         ← 更新 + autoSummary 重生成
│       ├── delete.ts
│       ├── batch.ts
│       ├── stats.ts          ← 统计 + enhance 批量增强
│       ├── conversation.ts   ← 对话原文读取（v1.4+）
│       ├── golden-extract.ts ← 黄金片段提取（v1.5+）
│       ├── record.ts         ← 对话记录管理（v1.8+）
│       └── stage-guard.ts    ← Stage Guard 任务完整性验证（v1.9+）
│   ├── guard-store.ts    ← Guard 状态持久化 + 🔒标记管理（v1.9+）
│   ├── guard-engine.ts   ← Flash 比对引擎（v1.9+）
├── dist/                 ← 编译输出
└── 工作记忆/              ← 开发过程工作记忆（旧版）

memory-store/             ← 记忆数据（分离存储）
├── _global_index.json
├── config.json
├── ls-registry.json      ← LS 注册表（v1.6 新增）
├── temp/
├── workspaces/
│   └── {hash}/
│       ├── memories/
│       └── records/      ← Record 存储（v1.8+）；包含 *.record_index.json 读侧索引 sidecar（v1.12+）
└── general/              ← 无法确定真实 workspace 的兜底区，不默认混入 workspace scope
```

## 开发

```bash
npm install
npm run build
npm run test:record-ownership
npm test
```

测试需要避免污染真实数据时，可在启动 Node 前设置 `MEMORY_STORE_DATA_ROOT` 指向临时目录。`tests/record-ownership.test.ts` 会在 import 存储模块前自动设置隔离数据根。

真实环境验收不进入默认 `npm test`：`npm run test:mcp-broker-live-smoke` 只读检查 HTTP broker 握手、guide 版本、核心工具、memory 查询和四宿主 list；可用 `MEMORY_STORE_LIVE_MCP_URL`、`MEMORY_STORE_LIVE_WORKSPACE`、`MEMORY_STORE_LIVE_REQUIRED_VERSION`、`MEMORY_STORE_LIVE_TIMEOUT_MS` 覆盖目标。`npm run test:agy-concurrency` 是独立的真实 agy CLI 压力命令，会使用本机账号与模型额度，需显式执行。

## 配置

在 `~/.gemini/antigravity/mcp_config.json` 中添加：

```json
{
  "memory-store": {
    "command": "node",
    "args": ["C:\\Users\\<user>\\.gemini\\antigravity\\mcp-memory-store\\dist\\index.js"],
    "env": {},
    "disabled": false
  }
}
```
