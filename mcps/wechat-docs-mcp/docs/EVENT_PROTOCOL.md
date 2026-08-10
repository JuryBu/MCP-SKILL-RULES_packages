# 事件与发送协议

## 1. Route、subscription 与 event

route 是精确识别的一条微信会话资源，conversation 不写死在 route。subscription 是一个独占 session：

```text
subscription_id -> (route_id, conversation_id, generation)
```

route 与 conversation 都可连接多个 subscription。事件按 route 只入账一次，每个 active、listen-capable subscription 获得自己的 delivery。

新 subscription 默认以当前 `MAX(event_seq)` 为 baseline，不回放旧历史。数据库以 `PRIMARY KEY(subscription_id,event_id)` 防止同一订阅重复投递，但其它订阅收到同一 event 是有意 fan-out。

## 2. 建链

```python
ledger.register_route(
    route_id="route-synthetic",
    profile="human_group",
    identity={"chat_name": "Synthetic Group"},
    state="active",
    owner_account_key="synthetic-owner-key",
    username="synthetic-room@chatroom",
    chat_type="group",
    display_title="Synthetic Group",
)

ledger.register_subscription(
    "route-synthetic",
    "conversation-synthetic",
    1,
    subscription_id="subscription-synthetic",
    listen_capability=True,
    send_capability=False,
    policy_ref="private-listen-policy",
)
```

精确身份是规范化后的 `ownerAccountKey + username + chat_type`。显示标题只作展示和 UI 导航。同名候选不能自动选择；来源目标不唯一时进入 quarantine 或拒绝。

启用发送能力必须提供本机私有 `policy_ref`，并且 private binding 的对应 route/capability 也必须显式开启。监听授权不等于发送授权。

## 3. 入账与 fan-out

```python
result = ledger.ingest_event(
    route_id="route-synthetic",
    source_fingerprint="synthetic-room@chatroom:42:100200",
    event_type="text",
    payload={
        "kind": "text",
        "visible_text": "synthetic message",
        "sender_display": "Synthetic Sender",
    },
)
```

返回 `event_id`、`event_seq`、`delivery_count` 和本次涉及的 wakes。事件插入、所有 delivery 和 0→1 wake 创建在同一 SQLite 事务中。

`source_fingerprint` 只用于同一 route 内的来源去重。处理顺序必须使用 `event_seq`，不能按微信索引、数字大小、文件大小或 UUID 字典序推断。

## 4. 每 subscription 合并 wake

每个 subscription 最多有一个活跃 wake，活跃状态是 `prepared / submitted / unknown`。只有该订阅 pending 从 0 变 1 时创建 wake；后续事件合入同一 pending 集合，不逐消息注入 Codex。

wake 提醒必须包含 `subscription_id`、`route_id`、`generation` 和 `wake_id`，不能包含微信正文。Codex conversation 由 subscription 决定。

暂停 subscription 会关闭其活跃 wake，但不会 ACK 已有 pending。暂停期间的新 route event 不投递给该 subscription；其它 active subscription 不受影响。closed subscription 不能重新开启。

## 5. 读取与精确 ACK

```python
events = wechat_events_list(subscription_id="subscription-synthetic")
wake = wechat_wake_info(subscription_id="subscription-synthetic")

wechat_events_ack(
    subscription_id="subscription-synthetic",
    generation=wake["generation"],
    wake_id=wake["wake_id"],
    event_ids=[events[0]["event_id"]],
)
```

ACK 规则：

- 只列真正处理完的 event_id；未列 delivery 继续 PENDING。
- event 必须确实投递给当前 subscription。
- generation 必须同时匹配 subscription 与 wake。
- 一个 subscription 的 ACK 不会改变其它 subscription 的 delivery。
- pending 归零后仅关闭当前 subscription 的 wake。

`route_id` 参数只用于 V1 单订阅兼容。若 route 有多个 active subscription，兼容调用会返回 `AMBIGUOUS_SUBSCRIPTION`，调用者必须改用 `subscription_id`。

## 6. Outbound 草稿与状态

```text
PREPARED -> APPROVED -> EXECUTING -> SEND_ATTEMPTED -> VERIFIED
                               \-> FAILED
                               \-> UNKNOWN
```

微信草稿必须显式指定唯一 route 和 send-capable subscription：

```python
draft = outbound_prepare(
    route_id="route-synthetic",
    subscription_id="subscription-synthetic",
    kind="wechat_text",
    payload={"text": "SYNTHETIC_MARKER"},
)

outbound_approve(
    draft_id=draft["draft_id"],
    payload={"text": "SYNTHETIC_MARKER"},
    owner_authorization_refs=[{
        "conversation_id": "owner-conversation",
        "turn_id": "owner-turn",
        "message_item_id": "owner-item",
        "role": "user",
        "authorized_at": "2026-01-01T00:00:00+00:00"
    }],
    dedupe_key="synthetic-dedupe",
)
```

代码只机械校验授权引用字段、角色、时间、草稿哈希、TTL 与 dedupe，不判断主人消息是否在语义上授权当前动作。Agent/Rules 负责语义判断。

批准在 `APPROVED -> EXECUTING` 时一次消费。单个 `wechat-visible-ui` lease 同时只允许一条发送。进程重载后发现过期 `EXECUTING` 会改为 `UNKNOWN`，不能恢复为 `APPROVED` 或自动重试。

UI 键动作成功只表示 `SEND_ATTEMPTED`。只有可信数据库事件满足以下全部条件才可 `VERIFIED`：

- route 相同；
- event 和 draft 都是文字类型；
- 可信解析器明确给出 `direction=outbound`；
- `visible_text` 与批准草稿正文完全一致；
- event 晚于本次批准消费时间；
- 该 event 尚未被其它草稿消费，同一观察事件只能验证一次。

当前数据库观察器尚未稳定提供 outbound 方向，因此真实 UI backend 接入前会停在 `SEND_ATTEMPTED/UNKNOWN`，不得伪称成功。

## 7. 附件

下载是按需流程：先以 `(subscription_id,event_id,file_name,dedupe_key)` 创建 transfer，确认该事件确实投递给订阅且类型为 file/image/sticker；适配器把文件放入 intake root 后，再登记实际字节数和 SHA-256。大小或名称与元数据不一致时失败。

上传准备只接受 upload root 内的普通文件，并要求 subscription 属于目标 route、处于 active 且有发送能力。它只生成哈希清单，不执行发送；后续实际上传仍需不可变 outbound 草稿和授权链。

文件永不自动执行或解压。

## 8. 腾讯文档

高频只读工具可以直接调用。官方完整能力通过工具发现与通用调用入口保留；修改、删除、移动、权限等写操作仍需草稿、授权与 dedupe。

文档/表单观察器以文档 ID 哈希分组。变化后等待 5 分钟安静窗口；持续变化最多合并 15 分钟。相同 fingerprint 不重复计数，也不延长窗口。批次从 `OPEN -> READY -> EMITTED`，一个 batch 只生成一次汇总提醒。

## 9. 跨通道

跨 QQ/微信机器任务保留 `task_id`、`generation`、`source_machine`、`target_machine`、`delivery_id`、`trace_id`、`origin_transport`、`hop_count` 和 dedupe。重复 delivery 或超出 hop 限制必须拒绝，防止 QQ 与微信之间形成回环。
