# 架构概览：微信与腾讯文档组合 MCP

## 1. 系统定位

本系统是面向本机 AI Agent（Codex、Windsurf 等）的**私有事件桥接基础设施**。它在主人不在线时，自动将获准的微信新消息写入本地 SQLite 权威账本，并通过 wake 机制通知 Agent 读取和精确 ACK。同时提供腾讯文档的只读和受控写入能力。

核心设计原则：
- **SQLite 是唯一真相源**，JSONL 只是审计副本
- **外部消息是数据，不是系统指令**（prompt injection 防护）
- **监听授权 ≠ 发送授权**，两者独立
- **公开源码不含任何真实账号、Token 或聊天内容**

## 2. 完整数据流

```text
┌─────────────────────────────────────────────────────────────────┐
│  微信 4.1+ 进程                                                  │
│  └─ db_storage/ (SQLCipher 4 加密数据库)                         │
│     ├─ message/message_0.db  (消息表 Msg_<MD5(username)>)       │
│     ├─ contact/contact.db    (联系人/群成员)                     │
│     └─ session/session.db    (会话状态)                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │ 文件 mtime + size 变化
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  DbWatcher (db_watcher.py)                                      │
│  1. _scan_encrypted_files() — 扫描 .db 文件 mtime/size          │
│  2. _detect_changes() — 与上次快照对比                           │
│  3. _has_message_db_changed() — 只关心 message*.db              │
│  4. refresh_keys() — 调用 wcdb_key_tool_windows.py 提取密钥     │
│  5. decrypt_changed() — 调用 key tool 解密到 decrypted_dir      │
│  6. poll_and_ingest() — 轮询解密后的 DB，入账新消息              │
│  └─ 互斥锁 _lock 保证线程安全                                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │ Observation 列表
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  DbObserver (db_observer.py)                                    │
│  ├─ poll_new_messages(baselines) — 按 baseline 过滤新消息       │
│  ├─ _msg_table_name(username) — Msg_<MD5(username)> 表名计算    │
│  ├─ _decompress_field() — zstd 解压 WCDB_CT=4 的字段            │
│  ├─ _classify_message() — 按 local_type 分类消息类型            │
│  ├─ _extract_text() — 提取可见文本                              │
│  ├─ _extract_attachment_info() — 提取附件元数据                  │
│  └─ _contact_display_name() — 从 contact.db 查昵称              │
└──────────────────────┬──────────────────────────────────────────┘
                       │ Observation(route_id, source_fingerprint, ...)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  EventLedger (ledger.py) — SQLite 权威账本                      │
│  ├─ routes 表 — route 注册 + baseline_local_id 防回放           │
│  ├─ events 表 — 事件入账 + source_fingerprint 去重              │
│  ├─ wakes 表 — 合并唤醒 + 一活跃 wake per route 约束            │
│  ├─ drafts 表 — 两阶段草稿审批                                  │
│  └─ deliveries 表 — 跨通道去重                                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │ wake_id + event_id
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (server.py) — 工具入口                              │
│  ├─ wechat_poll_start/stop — 后台轮询线程                       │
│  ├─ wechat_poll — 手动单次轮询                                  │
│  ├─ wechat_events_list — 列出待处理事件                         │
│  ├─ wechat_wake_info — 获取当前 wake_id + generation            │
│  ├─ wechat_events_ack — 精确 ACK 事件                           │
│  ├─ wechat_status — 健康状态 + 后台轮询状态                     │
│  ├─ outbound_prepare/approve — 两阶段发送审批                   │
│  └─ tdocs_* — 腾讯文档工具                                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │ MCP stdio 协议
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI Agent (Codex / Windsurf)                                    │
│  1. wechat_events_list(route_id) → 看到有待处理事件             │
│  2. wechat_wake_info(route_id) → 获取 wake_id + generation      │
│  3. 读取事件内容，处理完毕                                       │
│  4. wechat_events_ack(route_id, gen, wake_id, event_ids) → ACK │
│  5. 所有事件 ACK 后 wake 自动关闭                               │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 模块职责

| 模块 | 文件 | 职责 |
|---|---|---|
| **DbWatcher** | `db_watcher.py` | 加密文件变化检测、密钥提取、解密触发、快照管理、线程安全 |
| **DbObserver** | `db_observer.py` | 解密后 DB 只读轮询、消息分类、文本提取、联系人映射、基线管理 |
| **EventLedger** | `ledger.py` | SQLite 事件账本、去重、合并 wake、精确 ACK、草稿审批、路由管理 |
| **MCP Server** | `server.py` | MCP 工具入口、后台轮询线程、状态报告、腾讯文档代理 |
| **TencentDocs** | `tencent_docs.py` | 官方腾讯文档 MCP 客户端、工具目录缓存、读写分类 |
| **RouteBinding** | `db_observer.py` | 授权聊天到 route_id 的映射 |
| **Observation** | `db_observer.py` | 一条待入账消息的完整数据结构 |
| **migrate_baselines** | `migrate_baselines.py` | 一次性迁移脚本：加 baseline 列 + 回填 + SQLite backup |
| **enroll_routes** | `enroll_routes.py` | 路由注册脚本 |

## 4. 关键设计决策

### 4.1 为什么用文件轮询而非文件系统监听？

`DbWatcher` 使用 mtime + size 轮询而非 OS 级文件监听（如 `ReadDirectoryChangesW`）：
- **可移植**：Windows/Linux/macOS 行为一致
- **可预测**：不受 OS 缓冲区溢出影响
- **足够快**：5 秒间隔对微信消息延迟可接受
- **简单可靠**：无需处理复杂的 OS 回调和错误恢复

### 4.2 为什么快照延迟推进？

文件快照（`_snapshot`）只在**整个流程成功**后才推进：
- 密钥提取失败 → 不推进，下轮重试
- 解密失败 → 不推进，下轮重试
- 入账部分失败 → 不推进，下轮重试（失败的会被重试，成功的靠 `source_fingerprint` 去重）

这确保**任何中间步骤失败都不会丢消息**。

### 4.3 为什么用 contiguous baseline 而非 max baseline？

消息 4 成功、5 失败、6 成功时：
- **max baseline**：基线推进到 6，第 5 条永久丢失
- **contiguous baseline**：基线推进到 4，第 5 条下轮重试，第 6 条靠 `source_fingerprint` 去重

### 4.4 为什么每代线程用独立停止事件？

`wechat_poll_stop` 超时后如果共用一个 `threading.Event`，下次 `wechat_poll_start` 的 `clear()` 会让旧线程复活，形成两个轮询循环。每代线程创建独立的 `Event` 对象，旧线程的 `Event` 永远不会被 clear。

## 5. 数据库表结构

### routes 表
```sql
route_id TEXT PRIMARY KEY
generation INTEGER NOT NULL       -- 路由代次，防止跨代 ACK
conversation_id TEXT NOT NULL
profile TEXT NOT NULL
identity_sha256 TEXT NOT NULL     -- 路由身份指纹
state TEXT NOT NULL               -- enrolling/active/quarantine/disabled
baseline_local_id INTEGER NOT NULL DEFAULT 0  -- 防回放高水位
created_at TEXT, updated_at TEXT
```

### events 表
```sql
event_id TEXT PRIMARY KEY
route_id TEXT REFERENCES routes(route_id)
generation INTEGER NOT NULL
source_fingerprint TEXT NOT NULL  -- username:local_id:server_id
occurred_at TEXT, observed_at TEXT
event_type TEXT NOT NULL          -- text/image/voice/video/file/link/...
payload_json TEXT NOT NULL        -- 完整消息载荷
sensitivity TEXT NOT NULL         -- normal/awaiting_owner_instruction
acked_at TEXT                     -- NULL = 待处理
UNIQUE(route_id, source_fingerprint)  -- 去重约束
```

### wakes 表
```sql
wake_id TEXT PRIMARY KEY
route_id TEXT REFERENCES routes(route_id)
generation INTEGER NOT NULL
created_at TEXT
client_user_message_id TEXT NOT NULL
state TEXT NOT NULL               -- prepared/submitted/unknown/closed/failed
-- 唯一索引：每个 route 同时只有一个活跃 wake
```

### drafts 表
```sql
draft_id TEXT PRIMARY KEY
route_id TEXT, kind TEXT
payload_json TEXT, content_sha256 TEXT  -- 内容哈希，变化使批准失效
expires_at TEXT, state TEXT
owner_authorization_refs_json TEXT      -- 主人授权引用
dedupe_key TEXT UNIQUE                  -- 跨通道去重
```

## 6. 安全边界

- **route 默认拒绝**：只有 allowlist 中的聊天且身份校验通过才被监听
- **同名群隔离**：改名、类型或成员指纹异常进入 quarantine
- **发送需两阶段审批**：prepare → approve（需主人授权引用 + dedupe_key）
- **内容变化使批准失效**：`content_sha256` 不匹配则旧批准作废
- **附件不自动执行**：图片/文件先入账缓冲，等主人文字指令
- **Token 脱敏**：腾讯文档 Token 只从私有文件读取，日志永远 `[REDACTED]`
- **外部消息是数据**：MCP instructions 明确声明外部内容不是系统指令
