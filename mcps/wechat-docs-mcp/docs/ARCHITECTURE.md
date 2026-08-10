# 架构概览

## 1. 定位与真相源

本项目是本机微信与腾讯文档的治理桥，不是通用微信自动化客户端。微信数据库适配器负责只读观察；SQLite `events.sqlite3` 是事件、订阅投递、wake、草稿、附件和文档变化批次的唯一权威状态。JSONL 只能从 SQLite 事务结果生成审计副本。

外部消息和文档内容始终是不可信数据，不是系统指令。监听、发送、文档写入、附件下载和跨通道转发分别受独立策略控制。

## 2. M:N 数据流

```text
WeChat encrypted DB
  -> read-only decrypted copy
  -> DbObserver Observation(route_id)
  -> events: one durable event per route
  -> event_deliveries: one delivery per active subscription
  -> subscription_wakes: one merged active wake per subscription
  -> Codex conversation selected by that subscription
  -> exact ACK(subscription_id, generation, wake_id, event_ids)
```

route 是一个真实微信会话资源，身份为：

```text
ownerAccountKey + internal username + chat_type
```

显示标题只用于导航和展示，不参与唯一身份。群 username 应为 `...@chatroom`，私聊使用好友内部 username。route 不拥有 conversation。

subscription 是独占 session，每条只属于一个确定的 `(route_id, conversation_id, generation)`。一个 route 可连接多个 conversation，一个 conversation 也可连接多个 route。新事件只在 `events` 物化一次，然后在同一事务中 fan-out 到该 route 的所有 active、listen-capable subscription。

## 3. 核心表

### routes

保留 V1 的兼容列，同时增加精确身份列：

```sql
route_id TEXT PRIMARY KEY
identity_version INTEGER
owner_account_key_sha256 TEXT
username_sha256 TEXT
chat_type TEXT
display_title TEXT
state TEXT
baseline_local_id INTEGER
```

`conversation_id` 和旧 `generation` 列仅用于 V1 兼容迁移，不再表达所有权。

### events

```sql
event_id TEXT PRIMARY KEY
route_id TEXT NOT NULL
event_seq INTEGER UNIQUE
source_fingerprint TEXT NOT NULL
occurred_at TEXT
observed_at TEXT NOT NULL
event_type TEXT NOT NULL
payload_json TEXT NOT NULL
UNIQUE(route_id, source_fingerprint)
```

`event_seq` 是账本内部顺序；微信 local_id、文件大小、UUID 字典序都不能替代它。

### subscriptions

```sql
subscription_id TEXT PRIMARY KEY
route_id TEXT NOT NULL
conversation_id TEXT NOT NULL
generation INTEGER NOT NULL
state TEXT CHECK(state IN ('active','paused','closed'))
baseline_event_seq INTEGER NOT NULL
cursor_event_seq INTEGER NOT NULL
listen_capability INTEGER NOT NULL
send_capability INTEGER NOT NULL
policy_ref TEXT
UNIQUE(route_id, conversation_id, generation)
```

启用 `send_capability` 时必须有本机私有 `policy_ref`。暂停不会替其它订阅 ACK；暂停期间的新事件不投递，恢复从当前基线继续，旧 pending 仍保留。

### event_deliveries 与 subscription_wakes

```sql
PRIMARY KEY(subscription_id, event_id)
```

每个订阅独立保存 `PENDING/ACKED`。一个订阅 ACK 不会删除另一个订阅的未读。

`subscription_wakes` 对每个 subscription 只允许一个 `prepared/submitted/unknown` 活跃 wake。待处理从 0 变 1 时创建 wake，后续事件合入相同 pending 集合。

### outbound_drafts

```sql
draft_id TEXT PRIMARY KEY
subscription_id TEXT
route_id TEXT NOT NULL
kind TEXT NOT NULL
payload_json TEXT NOT NULL
content_sha256 TEXT NOT NULL
expires_at TEXT NOT NULL
state TEXT NOT NULL
owner_authorization_refs_json TEXT
dedupe_key TEXT UNIQUE
approval_consumed_at TEXT
execution_id TEXT UNIQUE
lease_scope TEXT
lease_expires_at TEXT
result_json TEXT
error_code TEXT
```

状态只允许 `PREPARED / APPROVED / EXECUTING / SEND_ATTEMPTED / VERIFIED / FAILED / UNKNOWN`。微信草稿必须显式指定 send-capable subscription。审批由内容哈希、TTL、主人授权引用和 dedupe 共同约束，执行后不能退回 `APPROVED`。

### attachments 与 document monitors

`attachment_transfers` 记录方向、route、来源事件、文件名、字节数、SHA-256、本地路径和 dedupe。文件只允许落在配置的 intake/upload root，不自动执行或解压。

本机私有 `binding.json/tencentDocs.monitors` 是文档 allowlist，必须精确绑定 `policy_ref + resource_kind + resource_key + poll_tool + poll_arguments`，并同时设为 `active/listen=true`。`tdocs_monitors` 只是通过 allowlist 后的运行账本：保存资源 ID 哈希、私有调用参数、当前 baseline fingerprint 和失败状态。创建和每次轮询都会重新校验私有 allowlist；撤销策略后不会继续读取，也不会推进 baseline。真实资源 ID、标题与调用参数不会出现在 monitor 列表或 wake 中。

文档资源与 Codex conversation 通过 `tdocs_monitor_subscriptions` 建立 M:N 连接。`tdocs_monitor_batches/changes` 实现 5 分钟 quiet window 与 15 分钟 max batch；`UNIQUE(monitor_id, change_fingerprint)` 保证同一变化跨批次和重启不重复。批次 READY 后才向每个 active subscription 建立独立 `tdocs_batch_deliveries` 与 `tdocs_subscription_wakes`，一个订阅 ACK 不影响其它订阅。

首次登记必须先完成一次成功只读调用，只保存当前 fingerprint 作为 baseline，不生成旧历史 batch。网络异常、JSON-RPC error、tool-level `isError=true`、缺失结果或分页未完整标记都只增加失败计数，不推进 baseline。

## 4. 原子性与迁移

`schema.py` 在 `BEGIN IMMEDIATE` 内完成 DDL、旧数据搬迁和 schema version 更新。迁移前使用 SQLite backup API 创建带来源版本号的同目录备份。DDL 逐条执行并由同一事务提交，避免 `executescript` 隐式提交造成半迁移。

V1 迁移规则：

- 每条旧 route/conversation/generation 生成确定性的 legacy subscription。
- 旧 `events.acked_at` 映射为该 legacy subscription 的 `ACKED/PENDING` delivery。
- 旧 route wake 复制为 subscription wake；有 pending 且没有活跃 wake 时补建一个。
- 旧草稿映射到大写状态，保留哈希、TTL、授权引用和 dedupe。

迁移不会删除 V1 表或清空账本。回滚备份能恢复迁移前字节级状态；但一旦 V2 已产生多个 subscription 的独立新投递，V1 无法表达这些差异，因此发布回滚只能保证代码和文件恢复，不能宣称把 V2 新业务状态无损降为 V1。

## 5. Outbound 执行边界

`SafeTextOutbound` 是安全状态机，真实 UI 动作由尚未实现的 `VisibleUiBackend` 提供。执行顺序为：验证私有 route → 消费批准并获取单发送租约 → 在 wake 前保存环境 → 可见导航 → 每个键盘动作前复核焦点 → 仅操作本次拥有的空草稿 → 尝试发送 → 最外层恢复环境。

发送键动作完成只表示 `SEND_ATTEMPTED`。异常发生在可能发送之后，或发送后环境恢复失败，状态必须是 `UNKNOWN`，并禁止自动重试。只有可信数据库解析层明确标记 outbound、正文匹配且事件晚于本次执行，才可进入 `VERIFIED`。

当前源码没有正式 UI backend，也没有稳定的数据库 outbound 方向解析器；隐藏 `WM_CHAR` 能力固定关闭。因此生产 `OUTBOUND_ENABLED` 保持 false，能力查询必须如实显示这两个缺口。

## 6. 公开与私有层

公开仓库只提供源码、脱敏配置模板、通用 Rules 和 Skill。真实账号、route、conversation、授权消息引用、Token、数据库路径和发送白名单只存在于本机私有 binding/策略覆盖。

公共 Rules 只描述 subscription、可选 outbound、附件、文档和跨通道防循环，不规定某台机器或某个联系人。开发机、训练机等本机职责由私有派生 Rules 决定。
