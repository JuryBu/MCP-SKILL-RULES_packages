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

附件事件先只入账元数据，并在事务中生成随机 `attachment_ref`。下载必须精确提供 `(subscription_id,event_id,attachment_ref,dedupe_key)`；适配器只能在对应 route 的精确消息身份中解析实体，默认物化到系统临时 intake 且不覆盖同名文件，并登记实际字节、SHA-256、MIME 和可得尺寸。大小、MD5、文件索引、CDN 主机或 route 身份不一致时失败。表情与普通图片是不同来源类型，不能互相冒充；普通图片 key 按 owner account identity 分区，旧无归属 key 必须先通过当前目标验证。

可视读取必须先完成同一下载与完整性合同。`wechat_read_attachments` 可接收多个已授权 `attachment_ref`：图片/表情各产生一个 `ImageContent`，PDF 按页产生多个 `ImageContent`，DOCX/PPTX 先生成可审计的派生 PDF；wxgf 原件先保留并登记，再从 HEVC 生成带独立哈希的派生 PNG。每个返回块记录来源 ref、页码、原件/返回 MIME、尺寸、字节和 SHA-256，以及是否缩放或转码。总图片数、总像素和总返回字节均有硬上限；超限必须返回已返回与剩余 ref/page 以及稳定 continuation cursor，续读不得重复或跳页。任意本机路径、伪造 ref、重复 ref、损坏或加密 PDF 都应拒绝。

`wechat_capture_visible_image_preview` 是显式人工辅助降级，不是附件下载。调用仍需 subscription、event 与 `attachment_ref` 精确一致，并要求非空人工确认引用；实现只能后台抓取唯一、可见、未最小化的微信图片查看器，不能激活窗口或发送输入。返回必须标明视窗预览不是原件、预览哈希不能替代原件哈希、客户端无法把查看器像素机器绑定到 event/local/server 标识且视窗可能不完整。窗口不唯一、焦点变化、空白捕获或质量不足时保守拒绝。

Office 转换只接受无宏、无外部关系的 DOCX/PPTX，使用隔离 LibreOffice profile，不修改原件；派生 PDF 与页面缓存按 `attachment_ref + source_sha + converter_version` 隔离并可过期清理。字体替换和版式诊断无法完整证明时必须明确标记 unknown，不能伪称无警告。XLSX 只保留原件供 spreadsheet 工具读取。

上传准备只接受 upload root 内的普通文件，并要求 subscription 属于目标 route、处于 active 且有发送能力。prepare 原子绑定 transfer 清单与不可变 outbound 草稿；approve 机械验证主人授权引用、TTL、草稿哈希和 dedupe；execute 再核对精确 route 与本机附件 outbound 开关。Windows 执行器必须先枚举剪贴板格式；只有能逐字节无损复制和恢复的简单全局内存格式才允许继续，图片、位图、复杂 OLE 或未知格式必须在唤醒微信前拒绝。执行器随后保存窗口状态，搜索目标显示名后用 `SessionDraft` 证明附件草稿属于精确 username，检测到用户切换焦点或移动鼠标立即停止。

UI 按键完成只算 `SEND_ATTEMPTED`。只有发送前 baseline 之后出现唯一的目标 route 数据库出站记录，并且文件 MD5、大小与草稿一致，才进入 `VERIFIED`。数据库刷新失败、等待超时或出现多个匹配记录一律为 `UNKNOWN`，不得自动重试；`wechat_attachment_upload_verify` 只能对原尝试补做确认，不能再次发送。

文件永不自动执行或解压。

## 8. 腾讯文档

高频只读工具可以直接调用。官方完整能力通过工具发现与通用调用入口保留；修改、删除、移动、权限等写操作仍需草稿、授权与 dedupe。

文档/表单观察器只允许登记本机私有 allowlist 中的资源；单独提供一个非空 `policy_ref` 不算通过。创建和每次轮询都必须精确匹配资源、官方工具、参数及 active/listen 状态。首次成功只读轮询建立当前 baseline，不产生历史 batch；策略撤销、网络失败、`isError=true` 或不完整分页不得推进 baseline。每次成功结果只保存 fingerprint 与不含正文的结构摘要。

变化后等待 5 分钟安静窗口；持续变化最多合并 15 分钟。相同 `(monitor_id, change_fingerprint)` 跨批次和重启去重，几十个单元格或多位填写者在同一窗口内只形成一个 READY batch。

文档 monitor 与 conversation 是 M:N。每个 document subscription 有独立 delivery、wake 和 ACK。`[TDOCS_MONITOR_WAKE]` 只包含 `monitor_id/subscription_id/generation/wake_id/pending_batch_count`；Agent 再调用 `tdocs_monitor_pending_batches` 读取摘要，并用同一 wake 精确 ACK 已完成的 `batch_id`。一个订阅 ACK 不得确认其它订阅。

## 9. 跨通道

跨 QQ/微信机器任务保留 `task_id`、`generation`、`source_machine`、`target_machine`、`delivery_id`、`trace_id`、`origin_transport`、`hop_count` 和 dedupe。重复 delivery 或超出 hop 限制必须拒绝，防止 QQ 与微信之间形成回环。
