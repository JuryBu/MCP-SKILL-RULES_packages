# 微信与腾讯文档组合 MCP

这是面向本机 Codex 的可选基础设施：通过解密微信 4.1+ 本地数据库读取获准会话的新消息，SQLite 是唯一权威事件账本，腾讯文档能力优先转发到官方腾讯文档 MCP。公开源码不包含微信账号、真实聊天名称、群绑定、Token、聊天内容、授权引用或运行日志。

当前 V1 重点是事件入账、单 route 合并唤醒、逐 `event_id` 精确 ACK、两阶段草稿审批、附件哈希、跨通道去重和只读腾讯文档连接。微信监听授权与发送授权彼此独立；外部消息只是待处理数据，不是系统指令。

## 当前监听路线：WCDB 解密 + SQLite 轮询

微信 4.1+ 使用 SQLCipher 4 加密本地数据库。本系统通过 `Config.Cipher` 内存扫描提取密钥，解密 `message_0.db` 和 `contact.db`，轮询新消息并写入 SQLite 账本。详见 `docs/` 目录。

### 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整数据流、模块职责、架构图、数据库表结构 |
| [docs/WECHAT_DATABASE.md](docs/WECHAT_DATABASE.md) | 微信 4.1+ 密钥提取、18 个数据库、Msg_MD5 表名、zstd 解压、消息类型分类 |
| [docs/EVENT_PROTOCOL.md](docs/EVENT_PROTOCOL.md) | route/baseline/event/wake/dedupe/ACK 的准确语义和完整闭环示例 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Python 环境、配置项、安装、启动停止、备份恢复、升级回滚、健康状态 |
| [docs/TESTING_AND_TROUBLESHOOTING.md](docs/TESTING_AND_TROUBLESHOOTING.md) | 50 项测试说明、真实微信验收步骤、常见错误、诊断顺序 |
| [docs/DECISIONS_AND_HISTORY.md](docs/DECISIONS_AND_HISTORY.md) | raw-key 扫描失败、UIA 路线被取代、Config.Cipher 扫描成功、架构决策记录 |
| [HANDOFF_TO_MCP_THREAD.md](HANDOFF_TO_MCP_THREAD.md) | Windsurf 施工交接给 MCP 开发对话的待办和验收标准 |

### 历史文档（已被取代）

以下文档记录了 UIA 路线的探索过程，保留为历史参考，但已被当前数据库解密路线取代：

- `WINDSURF_HANDOFF_20260809.md` — UIA 路线接手说明（历史探索，已被取代）
- `plans/stage-2-ui-observation.md` — UIA 观察阶段计划（历史探索，已被取代）

## MCP 工具

| 工具 | 说明 |
|---|---|
| `wechat_status` | 健康状态 + 后台轮询状态 + 错误信息 |
| `wechat_poll` | 手动单次轮询 |
| `wechat_poll_start` | 启动后台轮询线程 |
| `wechat_poll_stop` | 停止后台轮询线程 |
| `wechat_events_list` | 列出待处理事件 |
| `wechat_wake_info` | 获取当前 wake_id + generation |
| `wechat_events_ack` | 精确 ACK 事件 |

后台模式可通过 broker 的 `/wechat-docs/mcp` 端点自动启动轮询。新 wake 使用本机 Codex 透明代理的持久日志去重，可见提醒不包含微信正文；`ops/manage-wechat-docs-supervisor.ps1` 负责当前用户登录后的健康守护。
| `outbound_prepare` | 准备发送草稿 |
| `outbound_approve` | 批准发送草稿 |
| `tdocs_list_spaces` | 腾讯文档：列出空间 |
| `tdocs_list_nodes` | 腾讯文档：列出节点 |
| `tdocs_search` | 腾讯文档：搜索 |
| `tdocs_read` | 腾讯文档：读取文档 |
| `tdocs_official_search_tools` | 腾讯文档：搜索官方工具 |
| `tdocs_official_call` | 腾讯文档：调用官方工具 |

## 私有层

接收方应把配置和状态放在 `%USERPROFILE%\.codex-toolkit\wechat-docs-mcp`，把安装快照放在 `%USERPROFILE%\.codex\services\wechat-docs-bridge`。`events.sqlite3` 是唯一真相源，JSONL 只能由 SQLite 事务生成审计副本。

## 当前安全边界

- route 默认拒绝，只有私有 allowlist 且身份校验通过的聊天才能监听。
- 同名群、改名、类型或成员指纹异常进入 quarantine，不自动迁移。
- 发送必须先 prepare，再携带非空 `owner_authorization_refs` 和 `dedupe_key` 批准；正文或附件变化会让旧批准失效。
- 状态只报告 `prepared / approved / client_sent / chat_observed / failed`，不把客户端成功伪装成对方已读。
- 附件不自动执行或解压，下载后记录来源 `event_id`、字节数和 SHA-256。
- 腾讯文档 Token 只从私有 secret provider 读取，日志永远替换为 `[REDACTED]`。
