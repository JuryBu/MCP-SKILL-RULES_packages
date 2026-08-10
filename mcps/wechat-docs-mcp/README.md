# 微信与腾讯文档组合 MCP

这是面向本机 Agent 的可选协作基础设施：通过微信 4.1+ 本地数据库读取获准会话的新消息，以 SQLite 作为唯一权威账本，并把腾讯文档能力治理后转发到官方腾讯文档 MCP。公开源码不包含真实账号、聊天名称、route binding、Token、消息、授权引用或私有路径。

## 当前能力

- route 表示一个由 `ownerAccountKey + username + chat_type` 精确识别的微信会话；显示标题不参与身份判定。
- route 与 Codex conversation 是 M:N。每个 subscription 只属于一个 `(route_id, conversation_id, generation)`，事件按 route 只入账一次，再向所有 active subscription 独立投递。
- 每个 subscription 有独立 pending、wake、ACK、暂停、关闭和能力策略；一个订阅 ACK 不影响其它订阅。
- 微信发送与腾讯文档写入都使用不可变草稿、非空 `owner_authorization_refs`、TTL 和 `dedupe_key`。批准只消费一次，`UNKNOWN` 不自动重试。
- 附件按需准备和登记，记录来源事件、文件名、字节数与 SHA-256，不自动执行或解压。
- 腾讯文档资源使用独立 monitor 与 M:N subscription，不复用微信 route 身份。首次登记只保存成功只读轮询得到的当前 baseline；变化按 quiet window 5 分钟、max batch 15 分钟合并，同 fingerprint 全局去重。
- 官方 MCP 的网络错误、JSON-RPC error、tool-level `isError=true` 或分页未完整结果都不会推进文档 baseline。可见 wake 只含 monitor/subscription/generation/wake 和批次数，不含文档正文。

## 微信监听路线

微信 4.1+ 使用 SQLCipher 4 加密本地数据库。本项目调用本机私有层提供的密钥工具，只读解密数据库副本，再轮询获准 route 的消息表。`DbWatcher` 只在完整轮询成功后推进文件快照，`DbObserver` 使用连续基线和 `source_fingerprint` 避免漏读与重复入账。

## MCP 工具分组

| 分组 | 主要工具 | 作用 |
|---|---|---|
| 状态与轮询 | `wechat_status`、`wechat_poll*` | 检查各层状态，手动或后台轮询 |
| 订阅与事件 | `wechat_subscriptions_*`、`wechat_events_*`、`wechat_wake_info` | M:N 建链、独立读取与精确 ACK |
| Outbound 治理 | `outbound_prepare/approve/status/recover/verify`、`wechat_outbound_capabilities` | 草稿审批、状态恢复和严格数据库确认 |
| 附件 | `wechat_attachment_*` | 下载准备、落盘哈希、上传清单；不直接发送 |
| 腾讯文档 | `tdocs_*`、`tdocs_monitor_*` | 高频读、官方完整能力入口、allowlist 监视、M:N 批次投递与精确 ACK |

当前源码包含安全文字发送状态机和 `VisibleUiBackend` 协议，但没有正式微信 UI backend。`wechat_outbound_capabilities()` 会明确返回 `visible_ui_backend_implemented=false`；默认 `WECHAT_DOCS_MCP_OUTBOUND_ENABLED=0`。因此公开候选不会触碰微信输入框，也不能把 `SEND_ATTEMPTED` 说成 `VERIFIED`。

## 状态合同

Outbound 只使用以下状态：

`PREPARED → APPROVED → EXECUTING → SEND_ATTEMPTED → VERIFIED`

失败分支是 `FAILED` 或 `UNKNOWN`。只有可信数据库解析层明确标记为 outbound、正文与不可变草稿完全一致、并且事件晚于本次执行时，才能进入 `VERIFIED`。当前数据库观察器尚未稳定提供 outbound 方向字段，所以真实 UI 验收前不会伪造确认。

## 私有层与安装层

接收方应把私有配置、Token、SQLite、附件和日志放在 `%USERPROFILE%\.codex-toolkit\wechat-docs-mcp`，把版本化服务放在 `%USERPROFILE%\.codex\services\wechat-docs-bridge\releases`，通过 `current / pointers / releases` 切换。`events.sqlite3` 是唯一真相源；JSONL 只能是由 SQLite 事务生成的审计导出。

`binding.example.json` 只提供脱敏 schema v2 模板。真实 route、conversation、授权引用和策略引用必须写入本机私有覆盖，不得提交。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | M:N 数据流、表结构、迁移与回滚边界 |
| [docs/EVENT_PROTOCOL.md](docs/EVENT_PROTOCOL.md) | subscription、delivery、wake、ACK、outbound 合同 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 私有配置、运行、备份、发布和恢复 |
| [docs/PRIVATE_POLICY_OVERLAY.md](docs/PRIVATE_POLICY_OVERLAY.md) | 公共规则与本机私有策略的分层方式 |
| [docs/TESTING_AND_TROUBLESHOOTING.md](docs/TESTING_AND_TROUBLESHOOTING.md) | 自动测试、迁移演练与真实验收 |
| [docs/DECISIONS_AND_HISTORY.md](docs/DECISIONS_AND_HISTORY.md) | 已放弃路线与当前决策依据 |

`WINDSURF_HANDOFF_20260809.md` 与 `plans/stage-2-ui-observation.md` 是已被数据库路线取代的历史材料。
