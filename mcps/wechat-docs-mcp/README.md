# 微信与腾讯文档组合 MCP

这是面向本机 Agent 的可选协作基础设施：通过微信 4.1+ 本地数据库读取获准会话的新消息，以 SQLite 作为唯一权威账本，并把腾讯文档能力治理后转发到官方腾讯文档 MCP。公开源码不包含真实账号、聊天名称、route binding、Token、消息、授权引用或私有路径。

## 当前能力

- route 表示一个由 `ownerAccountKey + username + chat_type` 精确识别的微信会话；显示标题不参与身份判定。
- route 与 Codex conversation 是 M:N。每个 subscription 只属于一个 `(route_id, conversation_id, generation)`，事件按 route 只入账一次，再向所有 active subscription 独立投递。
- 每个 subscription 有独立 pending、wake、ACK、暂停、关闭和能力策略；一个订阅 ACK 不影响其它订阅。
- 微信发送与腾讯文档写入都使用不可变草稿、非空 `owner_authorization_refs`、TTL 和 `dedupe_key`。批准只消费一次，`UNKNOWN` 不自动重试。
- 文件、普通图片和表情先只入账元数据，并生成不可伪造的 `attachment_ref`；按需下载时才解析实体，记录来源事件、实际字节、SHA-256、MIME 和可得尺寸，不自动 OCR、解析、执行或解压。
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
| 附件 | `wechat_attachment_*`、`wechat_read_attachments`、`wechat_read_image`、`wechat_capture_visible_image_preview` | 精确下载、图片/PDF/Office 可视读取、人工辅助视窗预览、上传草稿、受控执行与数据库确认 |
| 腾讯文档 | `tdocs_*`、`tdocs_monitor_*` | 高频读、官方完整能力入口、allowlist 监视、M:N 批次投递与精确 ACK |

当前源码包含安全文字发送状态机，但普通文字仍没有正式 UI backend。附件另有默认关闭的 Windows 可见执行器：搜索标题必须在本地联系人库唯一，粘贴后必须由 `SessionDraft` 证明草稿属于精确微信 username，发送后还要由消息数据库中唯一的新出站记录匹配文件 MD5、大小和 route。附件开关与普通文字总开关独立；`WECHAT_DOCS_MCP_ATTACHMENT_OUTBOUND_ENABLED` 明确设置时优先，否则只读取私有数据根目录下 `config/service-runtime.json` 的布尔字段 `attachmentOutboundWeChatEnabled`，缺失、损坏或非布尔值都会保持关闭。

`wechat_read_attachments` 只接受当前 subscription 已投递的 `attachment_ref`。图片和表情返回 MCP `ImageContent`；PDF 按页渲染；DOCX/PPTX 先在私有派生目录中用禁宏、隔离配置的 LibreOffice 转成 PDF，再复用同一分页合同。响应受图片数、总像素和总返回字节三重预算约束，超出时返回稳定 continuation cursor，不能静默漏图或跳页。原件始终完整保留并记录 SHA-256；XLSX 只下载原件，不自动分页。

若普通图片的本地实体仍加密且无法按事件唯一执行客户端“另存为”，`wechat_capture_visible_image_preview` 只能在用户已手动打开目标图片查看器后显式调用。它不激活窗口，只抓取唯一微信查看器的当前视窗，并标记为 `human_assisted`、`viewport_preview`、`original_available=false`、`machine_verified_content_identity=false`。预览哈希不是原件哈希，视窗也可能没有覆盖完整图片；找不到唯一窗口、前台焦点变化或缺少人工确认引用时必须拒绝。

## 状态合同

Outbound 只使用以下状态：

`PREPARED → APPROVED → EXECUTING → SEND_ATTEMPTED → VERIFIED`

失败分支是 `FAILED` 或 `UNKNOWN`。文字只有可信数据库解析层明确标记为 outbound 且正文匹配不可变草稿时才能进入 `VERIFIED`；附件则要求发送前 baseline 之后出现唯一的目标 route 出站记录，并匹配附件 MD5 与字节数。UI 只完成到 `SEND_ATTEMPTED`，数据库超时、歧义、窗口恢复失败或结果不明都会进入 `UNKNOWN`，绝不自动重发。

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
