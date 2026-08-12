# Changelog

本文件记录面向 npm 发布的主要变更。

## [1.22.9] - 2026-08-13

### Fixed

- fetch 缓存格式升级为 `conversation-source-cache/v3`。v1.22.8 以前的缓存会在首次访问时通过原始来源单航班重建，避免自动事件虽然在展示层折叠、旧物理轮号却仍被继续增量复用。
- 重建后 fetch/read/search/recall/export 共享同一套全局人类轮号和统计口径；旧缓存不会再把 heartbeat、自动通道事件或子代理通知遗留成独立轮。

## [1.22.8] - 2026-08-13

### Fixed

- Codex `<heartbeat>` 定时注入现在保存为短结构化自动事件，不再回填长 `instructions`、创建空用户标题或增加人类轮次；旧 fetch 缓存会在读取时合并历史自动事件轮，新 fetch 在解析 JSONL 时直接使用正确语义。
- NapCat task wake、建链请求、微信 wake、腾讯文档 wake 与子代理通知不会进入 `messageRoles=["user"]`；`[NAPCAT_OWNER_REPLY]` 仅移除自动运输外壳，主人真实正文、缓冲附件引用继续作为用户消息。
- `<codex_delegation>` 与 `<realtime_delegation>` 按真实跨线程任务正文保留为用户消息，避免把协作输入误归类为系统注入。

### Verification

- 使用超大真实 Codex 对话脱敏重放：heartbeat 被折叠进短系统事件，用户视图无 heartbeat，完整人类消息聚类未发现其它自动注入残留。

## [1.22.7] - 2026-08-12

### Added

- fetch/cache 规范化新增通用自动通道事件模型，按 `channel/type/summary` 表示 QQ、微信及后续渠道的 wake/alert/notification/event；输出仅保留必要的任务或订阅身份、待处理数量/序号摘要和处理/ACK 状态。

### Fixed

- `read/search/recall/export` 不再把 `wake_id`、工具调用说明和整段自动通知模板回填为用户原话；已有 v2 缓存读取时动态兼容，后续增量发布会写入规范化事件。
- 主人真实发言、带批注的引用、附件引用和 `<codex_delegation>` 对端任务正文继续保留；Record 投影不会把自动提醒计入用户消息。

## [1.22.6] - 2026-08-10

### Fixed

- 修复 Codex 与 Claude Code 活跃对话多次增量 fetch 后，合并尾部轮次从 1 重新编号，导致缓存统计虚高、按轮 read 无法读取最新范围的问题。
- fetch 缓存发布与读取都会拒绝重复轮号；已有损坏代次会放弃增量复用，并在下一次 fetch 时完整重建。

## [1.22.5] - 2026-08-09

### Fixed

- Windsurf/Antigravity 本地 PB fetch 缓存现在保存整段对话的 AI 回复与工具调用总数，修复范围读取正文正常但概览显示 `0 条/0 次` 的统计错误。
- 缺少全量统计字段的旧 fetch 缓存会在首次源读取时通过现有单航班链路重建，后续 `source=cache` 与范围读取直接复用新统计，不重复解析 PB。

## [1.22.4] - 2026-08-04

### Fixed

- fetch 缓存格式升级为 `conversation-source-cache/v2`，旧 generation 不再被新版读取器误认为兼容缓存，而是在首次访问时通过现有单航班 fetch 链路规范化重建。
- `searchInRounds` 会把历史 AI 回复、thinking、工具参数与结果中的对象/数组安全序列化为可搜索文本，修复 `aiText.toLowerCase is not a function`；Codex、Windsurf、Antigravity、Claude Code 共用修复。

## [1.22.3] - 2026-08-04

### Added

- Windsurf 与 Antigravity 的 `conversation_read_original(list, source="local")` 直接扫描 active/implicit PB 元数据；IDE 与 Language Server 均关闭时仍可列出本地对话，精确 ID fetch 继续使用离线 PB 解码链路。
- fetch cache generation 新增四宿主压缩元数据：Windsurf 使用 PB `f5.f25` token 下降，Codex 使用第二次及后续折叠 Rules 注入，Claude Code 使用 `isCompactSummary`；Antigravity 无可靠信号时明确使用最近约 150K tokens（约 450K context characters）保底。
- 新增 `conversation_read_original(action="recall", recallMode="auto|manual|full")`。Recall 先增量刷新并提交最新可取得的 fetch generation，再只从同一 generation 输出上下文；自动模式恢复到压缩前规模约 60%，手动模式按人类轮次，全量模式写入带 SHA256 的临时文件。

### Safety

- Recall 只包含用户消息、引导消息、annotations、模型可见回复与附件引用；不会输出 thinking、工具调用/结果、代码 diff、文件查看、Rules 注入、压缩摘要或内部诊断。超过约 100K 的普通结果继续通过 continuation 与临时 artifact 安全交付。

## [1.22.2] - 2026-08-04

### Fixed

- Windsurf 与 Antigravity 本地 PB 在未配置显式覆盖密钥时使用稳定的应用密钥，关闭 IDE 与 Language Server 后仍可独立完成解密、fetch 与后续缓存读取。
- `source="local"`、`source="ls"` 与 `source="auto"` 发布到同一个宿主级 fetch 缓存入口，`source="cache"` 始终读取最近一次成功 fetch 的 generation，不再命中按来源分裂的旧缓存。

## [1.22.1] - 2026-08-04

### Fixed

- `conversation_read_original(search)` 将 response annotations 的被批注文本与用户评论分别建立命中项，返回单条 Annotation、命中字段和有限片段，不再因一个批注命中展开整个父轮。
- Codex 原生 response annotations 隐藏宿主自动注入的说明文字，保留真实请求正文，并将没有评论的批注明确显示为“未填写”。
- 补齐 malformed annotations 原文回退、`messageRoles=["subagent"]` 文档、四端 Rules 安装语义与 Plan_39 收尾状态。
- 巨型活动 Codex 对话后台 fetch 固定读取启动时的字节快照；源文件仅向尾部追加时允许发布该完整快照，截断、替换或旧前缀锚点变化时仍拒绝发布并保留上一代缓存。

## [1.22.0] - 2026-08-03

### Changed

- 四宿主统一以可校验、不可变的 fetch cache generation 作为读取快照。Codex 与 Claude Code 对大 JSONL 流式增量读取；Windsurf 与 Antigravity 将本地 PB 作为一等来源，并提供 `source=auto|local|ls|cache` 显式控制，`cache` 仅读取已发布的完整缓存。
- `conversation_read_original(read/search)` 对约 100K 的大结果保留继续位置，不再静默截断；连续人类消息、annotations（被批注文本与评论）和子代理/主线程角色关系按统一语义输出。
- Record 只消费经过校验的不可变 fetch cache generation，不再回读可能达到 2GB 的原始来源。为保证 Phase 回滚，缓存物化为完整规范化版本，而非仅保存尾部。
- Stage Guard 的 `start` 改为常数时间 O(1) 初始化，按模型预算执行并复用稳定 `taskId`，使重试、取消与恢复保持同一任务身份。
- 公共文档与 npm 发布物不包含私有 PB key、真实样本或执行 Plan/Task。

## [1.21.2] - 2026-08-03

### Fixed

- Guard 文本截断在 UTF-16 高代理项边界前退一位，避免 emoji 被切成非法 Unicode 并触发上游请求解析失败。
- 配置中的 Codex Desktop 可执行路径失效时，从 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe` 选择修改时间最新的安装；普通 PATH 命令保持原样。
- provider owner 本地租约已过期时清除旧 fence 并重新认领新 epoch，避免使用过期凭证续租后让 Grok/agy 链路持续不可用。

### Validation

- 新增 emoji 临界截断、Codex Desktop 路径轮换与 provider owner 过期自恢复回归，并通过对应 Guard、model bridge、provider admission 定向测试。

## [1.21.1] - 2026-07-16

### Fixed

- production pump 在 auto 单 Unit 的 Grok permit 满载、尚未形成 Attempt 时，会用同一 attemptId 原子尝试 agy first-run overflow；Grok 容量拒绝不创建假 Attempt、不扣额外 dispatchSeq，Grok 真失败后的 agy 仍使用 fallback 保障份额。
- Antigravity LS、Codex CLI 与 Claude Code CLI 的失败分类跨 model bridge 保真：启动/连接/超时/非零退出为 Availability，成功调用空输出为 Quality，非 Grok 基础设施失败不再被默认成 Quality 并触发 split。
- Windsurf Record admission/resume 的 ownership probe 显式使用 background request class；公开 ownership audit 保留 foreground 默认值。
- Record single-flight 与持久化共享 gate 删除终止性排队 timeout，纯容量等待不会因旧环境变量到期失败；FIFO、取消/已结算检测和持久化 AIMD 反馈保持不变。
- Windows scheduler ledger lock 对 create/write/stale-read 的瞬时 EPERM/EACCES/EBUSY 在既有 lock deadline 内重试，避免高并发原子发布时把已到 ResultReady 的 Unit 错误结算成 Task error；LS 非 200 与 Codex 输出文件 I/O 失败统一归 Availability。
- `record_manage(stale_check)` 不再静默忽略 `recordIds`，会明确提示使用受支持的范围参数；guide 的 agy 4+4 文案改为两类各保障 4、空闲可借、物理合计最多 8。

### Validation

- 新增单 Unit Grok→agy first-run overflow、Antigravity→Codex Availability fallback/no split、WSF ownership request class、旧 timeout 值后继续排队并恢复、Windows lock 三段瞬时竞争、LS HTTP 500 与 Codex 输出 I/O 等专项回归；UnknownOutcome/WaitingRetry 持久唤醒、取消与重启 timer 路径重新通过。

## [1.21.0] - 2026-07-16

### Changed

- 四宿主来源枚举、exact/full read 与不可变来源证据统一接入 Record scheduler 生产入口，WSF 空终页、别名与显式目标解析不再把完整来源误判为失败；结构性来源不足仍以 Deferred 终止，不生成半份 Record。
- provider 路由改为一个逻辑 Unit 对应多个物理 Attempt；Availability/Congestion/LocalResource 在同 Unit retry/fallback，Quality/Complexity 才允许一次受限 split。Grok failureClass 会跨 model bridge 保真，不再被默认成 Quality。
- provider permit 等待改为持久非阻塞挂起，blocked 候选不会占用后台 lane 或阻塞其它 provider；agy first-run overflow 与 fallback 各保留 4 个逻辑槽、共享物理上限 8。
- same-identity admission 增加跨进程 namespace lock 与 capsule-first 解析；foreign owner 通过 PID、启动时间、lease 与 fencing 接管，pending discovery 可在 spool 建立前连续热重启并复用同 taskId。
- Task 成功增加权威 ledger 后置条件：UnknownOutcome、FailedFinal、未完成 Unit/Attempt 或缺少 verified local-finalize 时禁止投影为 Succeeded；durable ResultReady 可安全放行 continuation，避免环形等待。
- 显式 force 只有在正文、主索引、Reader Index 全部匹配旧 publication claim 时才能推进 recordCommitEpoch；缺失、ownerless、部分发布、混合 owner 或 unresolved 可见状态全部 fail closed，普通 repair_divergence 保持独立路径。
- 公共 `record_manage(edit/delete)` 会在 artifact→registry 统一锁序内先推进发布 fence，把旧 Task ID 写入持久墓碑并清除旧 lease/claim，再修改正文与索引；同 revision 只允许新 Task 重新挂接。索引宿主与外宿主发布状态冲突、chain 缺失后的多候选或残缺候选都会 RepairRequired，不会跨宿主猜测修改。
- 新增真实 Grok→agy 同 Unit fallback 与 4+4 provider 压力脚本，补齐跨进程 admission、重叠热重启、取消迟到结果、force publication、UnknownOutcome 与控制面专项回归。

## [1.20.0] - 2026-07-14

### Changed

- Grok、agy 与模型桥现经统一 provider transport 获取物理许可，Record 更新已由 production pump 与持久 coordinator 接线驱动；前台与 Record 的流量类别保持可区分。
- 历史 `chain=unknown` 回填已接入四宿主证据扫描：仅唯一、完整的宿主匹配生成带 CAS 前置条件的补丁，证据不足或多宿主匹配保留为 `Unresolved` / `Conflict`。
- hard-exit 恢复测试现沿真实 runtime、production pump、provider、immutable spool 与 commit 路径执行；`UnknownOutcome` 宽限期到期后只允许一次新 fence 重试，预算耗尽后终止，不会无限重发。
- 四宿主附件冻结改为内容哈希可验证后才接纳，原始 data URL、base64 与本地路径不会进入 Record payload；Codex SQLite `rollout_path` 同时受词法根目录和真实路径约束。
- 新提交协议可在持久锁与正文哈希匹配时安全接管缺少 identity sidecar 的旧 Record 正文，并保留可条件恢复的 legacy before-image，不再把合法历史正文误判为不可恢复。
- 默认 `npm test` 现会执行 scheduler、source evidence、materialization/recovery、unit、commit 与 provider 的新增离线契约测试，并补回此前未进入默认链路的既有测试。
- 真实 agy CLI 并发压力探测保留为独立 `npm run test:agy-concurrency`，不再混入默认离线回归；命令从 `MEMORY_STORE_AGY_COMMAND` 或 PATH 解析，不携带本机用户绝对路径。
- 同 revision 的一致 legacy 改写或三件发布产物全部缺失时可受控推进 publication generation；部分产物、混合 owner 或外来 claim 仍 fail closed，Reader Index 半发布会先失效旧 sidecar 再恢复。
- 同步 Record/background 状态现在会返回持久 Task 保存的精确终态错误，不再只显示泛化的 `FailedFinal`。
- npm 发布改为 `files` 正向白名单，只发布编译后的 `dist` JavaScript、类型声明以及 README 和 CHANGELOG，不发布源码、测试、计划、内部资料或 source map。
- 公开测试、源码注释和 README 中的本机用户目录示例已改为匿名占位符。
