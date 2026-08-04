# Changelog

本文件记录面向 npm 发布的主要变更。

## [1.22.1] - 2026-08-04

### Fixed

- `conversation_read_original(search)` 将 response annotations 的被批注文本与用户评论分别建立命中项，返回单条 Annotation、命中字段和有限片段，不再因一个批注命中展开整个父轮。
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
