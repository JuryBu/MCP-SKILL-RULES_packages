# 事件协议参考

## 1. 核心概念

| 概念 | 说明 |
|---|---|
| **Route** | 一个获准监听的微信会话（私聊或群聊），有唯一 `route_id` 和 `generation` |
| **Baseline** | 每个 route 的高水位标记（`baseline_local_id`），防止旧历史回放 |
| **Event** | 一条入账的微信消息，有唯一 `event_id` 和 `source_fingerprint` |
| **Wake** | 合并唤醒，多条消息只产生一次 wake，Agent 读取后精确 ACK |
| **Draft** | 两阶段发送草稿，prepare → approve → send |
| **ACK** | 确认事件已处理，只 ACK 真正处理完的 `event_id` |

## 2. Route 生命周期

### 2.1 注册

```python
ledger.register_route(
    route_id="route-xxx",
    conversation_id="conv-xxx",
    generation=1,
    profile="test",
    identity={"chat_name": "TestUser", "chat_type": "friend", "username": "wxid_xxx"},
    state="active",
    baseline_local_id=0,
)
```

- `generation` 从 1 开始，每次重开 route 递增，防止跨代 ACK
- `identity` 的 SHA-256 存入 `identity_sha256`，用于检测身份变化
- `state` 可以是 `enrolling`、`active`、`quarantine`、`disabled`
- 只有 `active` 状态的 route 才能入账事件

### 2.2 身份校验

路由身份包含：
- `chat_name` — 精确标题（微信中显示的名称）
- `chat_type` — `friend` 或 `group`
- `username` — wxid 或 chatroom ID
- `group_member_count` — 群成员数（仅群聊）

身份变化（改名、成员数变化）会触发 quarantine，不自动迁移。

### 2.3 Baseline 防回放

`baseline_local_id` 是该 route 消息表中的 `MAX(local_id)`。新消息入账后基线推进到 contiguous max（连续成功的最大值），确保：
- 旧历史不回放
- 中间失败的消息会被重试
- 成功的消息靠 `source_fingerprint` 去重

`update_baseline()` 有回归检查：新值必须 >= 当前值。

## 3. Event 入账

### 3.1 入账流程

```python
result = ledger.ingest_event(
    route_id="route-xxx",
    source_fingerprint="wxid_xxx:42:100200",
    event_type="text",
    payload={"kind": "text", "visible_text": "你好", "sender_display": "张三", ...},
    occurred_at="2026-08-09T11:00:00+00:00",
    sensitivity="normal",
)
```

返回值：
```python
# 新事件
{"inserted": True, "event_id": "uuid-xxx", "wake": {"wake_id": "uuid-yyy", "state": "prepared", ...}}

# 重复事件（source_fingerprint 已存在）
{"inserted": False, "event_id": "existing-uuid", "wake": None}
```

### 3.2 去重机制

`events` 表有 `UNIQUE(route_id, source_fingerprint)` 约束。`source_fingerprint` 格式是 `<username>:<local_id>:<server_id>`，保证：
- 同一消息不会重复入账
- `watch_once` 重试时已入账的消息被安全跳过
- 不同 route 的相同消息各自独立入账

### 3.3 Payload 结构

```json
{
  "kind": "text",
  "sender_display": "张三",
  "sender_username": "wxid_abc123",
  "message_time_display": "2026-08-09T11:00:00+00:00",
  "visible_text": "你好",
  "local_id": 42,
  "server_id": 100200,
  "source_window_identity": "张三",
  "attachment_name": "report.pdf",
  "attachment_size": 1048576,
  "attachment_size_display": "1.0MB"
}
```

附件字段只在 file/link/mini_program 类型消息中出现。

## 4. Wake 合并唤醒

### 4.1 创建规则

当一条新事件入账时：
1. 查询该 route 当前是否有活跃 wake（`state IN ('prepared','submitted','unknown')`）
2. 查询该 route 入账前的待处理事件数
3. 如果**入账前待处理数为 0 且没有活跃 wake**，创建新 wake
4. 否则不创建新 wake（合并到现有 wake）

这意味着：短时间内收到多条消息只产生一次唤醒。

### 4.2 唯一约束

```sql
CREATE UNIQUE INDEX wakes_one_active_per_route
  ON wakes(route_id) WHERE state IN ('prepared','submitted','unknown');
```

数据库层面保证每个 route 同时只有一个活跃 wake。

### 4.3 Wake 状态流转

```
prepared → submitted → closed    (正常流程)
prepared → unknown → closed      (异常恢复)
prepared → failed                (处理失败)
```

- `prepared` — 刚创建，等待 Agent 读取
- `submitted` — Agent 已开始处理（可选状态）
- `unknown` — 状态不确定（恢复用）
- `closed` — 所有事件已 ACK，wake 关闭
- `failed` — 处理失败

### 4.4 查询活跃 wake

```python
wake = ledger.get_active_wake("route-xxx")
# {"wake_id": "uuid-yyy", "route_id": "route-xxx", "generation": 1, "state": "prepared", ...}
```

MCP 工具 `wechat_wake_info(route_id)` 返回 `wake_id` 和 `generation`，供 `wechat_events_ack` 使用。

## 5. ACK 精确确认

### 5.1 ACK 操作

```python
result = ledger.ack(
    route_id="route-xxx",
    generation=1,
    wake_id="uuid-yyy",
    event_ids=["event-uuid-1", "event-uuid-2"],
)
```

### 5.2 ACK 规则

- 只 ACK 真正处理完的 `event_id`，未列出的事件继续待处理
- `wake_id` 必须是当前活跃的 wake
- `generation` 必须与 wake 的 generation 一致（防跨代 ACK）
- 所有 `event_id` 必须属于该 route 和 generation
- 所有事件 ACK 后 wake 自动关闭（`state='closed'`）

### 5.3 ACK 返回值

```python
{
  "processed_event_ids": ["event-uuid-1", "event-uuid-2"],
  "pending_count": 0,      # 剩余待处理数
  "wake_active": False      # wake 是否仍活跃
}
```

### 5.4 部分 ACK

如果一次只 ACK 部分事件：
```python
result = ledger.ack("route-xxx", 1, "wake-uuid", ["event-1"])
# {"processed_event_ids": ["event-1"], "pending_count": 2, "wake_active": True}
```

剩余事件继续待处理，wake 保持活跃。

## 6. 发送授权（两阶段草稿）

### 6.1 流程

```
1. outbound_prepare(route_id, kind, payload, ttl_seconds)
   → 生成不可变草稿，返回 draft_id + content_sha256

2. outbound_approve(draft_id, payload, owner_authorization_refs, dedupe_key)
   → 验证 payload 哈希一致 + 主人授权引用有效
   → 返回 approved 状态

3. 执行发送（通过 wxautox4 或其他适配器）
   → mark_draft_state(draft_id, "approved", "client_sent")
```

### 6.2 安全约束

- **payload 变化使批准失效**：`content_sha256` 不匹配则 `DRAFT_CHANGED` 错误
- **主人授权引用必填**：`owner_authorization_refs` 不能为空
- **授权引用校验**：每条引用必须有 `conversation_id`、`turn_id`、`message_item_id`、`role`（必须是 `user`）、`authorized_at`（必须早于调用时间）
- **dedupe_key 唯一**：防止同一发送重复执行
- **TTL 过期**：草稿超过 `expires_at` 后不能批准

### 6.3 Draft 状态

```
prepared → approved → client_sent → chat_observed
                    → failed
```

- `prepared` — 刚创建
- `approved` — 已批准
- `client_sent` — 已发送到微信
- `chat_observed` — 在聊天中观察到发送结果
- `failed` — 发送失败

## 7. 附件处理

### 7.1 缓冲策略

图片、文件、表情等附件类消息先入账，`sensitivity` 标记为 `awaiting_owner_instruction`，不触发立即回复。

### 7.2 附件元数据

```json
{
  "attachment_name": "report.pdf",
  "attachment_size": 1048576,
  "attachment_size_display": "1.0MB"
}
```

### 7.3 安全要求

- 附件**不自动执行或解压**
- 下载后记录来源 `event_id`、字节数和 SHA-256
- 等待主人后续文字指令后，把附件与指令合并交付

## 8. 完整 ACK 闭环示例

```python
# 1. 后台轮询自动入账新消息
# 2. Agent 发现有待处理事件
events = wechat_events_list("route-xxx", limit=50)
# [{"event_id": "evt-1", "event_type": "text", "payload": {...}, ...}, ...]

# 3. 获取 wake 信息
wake = wechat_wake_info("route-xxx")
# {"wake_id": "wake-uuid", "generation": 1, "state": "prepared"}

# 4. 处理事件，逐项 ACK
wechat_events_ack("route-xxx", 1, "wake-uuid", ["evt-1", "evt-2"])
# {"processed_event_ids": ["evt-1", "evt-2"], "pending_count": 0, "wake_active": False}

# 5. wake 自动关闭，闭环完成
```
