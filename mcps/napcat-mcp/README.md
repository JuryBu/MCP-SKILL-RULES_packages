# NapCat QQ 群协作 MCP（可选）

这是一个固定账号、固定任务群与私有通知目标的窄功能协作服务。AI 可以通过 NapCat OneBot HTTP API 向任务群发送运行状态和文本、读取最近消息、上传或下载群文件，也可以把经过身份校验的结构化任务消息路由回已经登记的 Codex 对话。主人私聊或通知群只能由本机私有 binding 预先命名，调用方不能临时指定任意群号或联系人。

第一次在 Codex Desktop 接入时，请先按 `INSTALL-CODEX.md` 完成 Broker、私有绑定、透明 App Server 代理和重启后验收；本文件继续说明协议、安全边界和维护细节。

本目录只包含 MCP 源码、示例绑定、测试和运维脚本，不包含 NapCat 本体、QQ 登录态、二维码、真实账号、真实群号、访问令牌或运行状态。接收方必须自行安装 NapCat 并在本机完成登录；broker 默认不启用本模块，只有设置 `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1` 后才暴露 `/napcat/mcp`。

## 工具

| 工具组 | 代表工具 | 用途 |
|---|---|---|
| 状态与目标 | `napcat_status`、`napcat_discover_target` | 检查 OneBot、登录账号和固定群身份 |
| 消息与文件 | `napcat_read_recent`、`napcat_download_file`、`napcat_send_text`、`napcat_send_file` | 按固定群读取、下载、发送与上传；任务文件会附带结构化索引 |
| 任务账本 | `napcat_task_register`、`napcat_task_update`、`napcat_task_status`、`napcat_task_list` | 维护任务、Codex 对话、角色、可信对端、代次和唤醒冷却 |
| 任务完成 | `napcat_task_ack`、`napcat_task_close` | 处理完明确消息序号后确认，任务结束后关闭路由 |
| 送达与重连 | `napcat_delivery_status`、`napcat_connection_request` | 查询对端机器/对话送达状态，或向已知对端对话提出重新建链请求 |
| 主人通知 | `napcat_owner_route_register`、`napcat_owner_alert`、`napcat_owner_route_close` | 把简短人话提醒发到预配置私聊/群聊，并把引用回复送回指定 Codex 对话 |
| 预览与训练事件 | `napcat_preview_*`、`napcat_send_training_event` | 在发送前预览正文，或发送受去重保护的训练状态 |

## 本机配置

先把 `binding.example.json` 复制到 `%USERPROFILE%\.codex-toolkit\napcat-mcp\binding.json`，再填写收件人自己的 QQ 账号、昵称、目标群和预期成员数。示例中的 `ExampleBot`、`ExampleGroup` 与号码均为假数据。OneBot 地址和 token 通过 broker 私密环境提供：

双机任务需要在双方私有 binding 中填写不同的 `controlPlane.localMachine`、可信对端 `trustedPeerQq`，并把 `enabled` 与 `machineIngressEnabled` 同时设为 `true`。这两个开关控制固定任务群的消息扫描、`machine_received` / `conversation_received` 送达回执和回执索引吸收；`targets` 与 `defaultTargetKey` 只服务主人私聊或通知群，不是双机回执前置条件。可先运行 `ops/enable-napcat-machine-ingress.ps1` 做备份、校验和原子启用，再选择性重载 NapCat backend 与 task router。`napcat_status.controlPlane.machineIngressReady=true` 才表示双机回执链路已真正就绪。

`codexWakeMessageVisibility` 只控制自动唤醒是否作为 Codex Desktop 可见消息保存，不改变注入方式、送达时机或模型收到的内容。无论设为 `visible` 还是 `hidden`，对话忙碌时都使用 `turn/steer` 插入当前轮次，空闲时都使用 `turn/start`；省略或设为 `visible` 时，代理还会为每次逻辑唤醒生成并持久化一个 UUID 格式的 `clientUserMessageId`，设为 `hidden` 时则不携带客户端消息 ID，因此不保存独立的用户消息气泡。task router 每次唤醒前都会重新读取 binding，因此修改字段后从下一次唤醒立即生效，不需要重启 broker、NapCat 或任务路由器。Codex Desktop 在前台命令持续运行时可能延后绘制可见模式的气泡，命令结束后才显示，但模型会在同一轮上下文中收到消息。

| 环境变量 | 示例 | 说明 |
|---|---|---|
| `NAPCAT_HTTP_URL` | `http://127.0.0.1:3010` | 仅回环地址的 OneBot HTTP 服务 |
| `NAPCAT_ACCESS_TOKEN` | 不写进同步包 | OneBot Bearer token |
| `NAPCAT_TASK_REGISTRY_PATH` | data root `state/task-registry.json` | 任务、对话、代次、游标、租约与冷却账本 |
| `NAPCAT_CONTROL_STATE_PATH` | data root `state/control-state.json` | 送达回执、重连请求、主人回复路由与控制消息去重状态 |
| `NAPCAT_TASK_ROUTER_INTERVAL_MS` | `30000` | 固定群任务扫描间隔 |
| `NAPCAT_ROUTER_HISTORY_MAX_PAGES` | `40` | 路由恢复时向前分页补扫的最大页数 |
| `NAPCAT_CONTROL_HISTORY_LOOKBACK_MS` | `900000` | 控制消息首次启用时允许进入处理窗口的时间范围 |
| `NAPCAT_DELIVERY_MACHINE_ALERT_MS` | `120000` | 关键送达缺少 `machine_received` 时触发严重告警的等待时间 |
| `NAPCAT_DELIVERY_CONVERSATION_ALERT_MS` | `300000` | 关键送达缺少 `conversation_received` 时触发严重告警的等待时间 |
| `NAPCAT_MCP_BINDING_PATH` | `%USERPROFILE%\.codex-toolkit\napcat-mcp\binding.json` | 固定账号和群绑定 |
| `NAPCAT_MCP_STATE_PATH` | `%USERPROFILE%\.codex-toolkit\napcat-mcp\state\dedupe.json` | 通知去重状态 |
| `NAPCAT_FILE_UPLOAD_TIMEOUT_MS` | `600000` | 群文件上传最长等待 10 分钟 |
| `NAPCAT_FILE_DOWNLOAD_TIMEOUT_MS` | `600000` | 群文件下载最长等待 10 分钟 |
| `NAPCAT_MAX_FILE_BYTES` | `2147483648` | 单文件默认上限 2 GiB |
| `MCP_SDK_ROOT` | 由 broker 注入 | MCP SDK 的 `dist\esm` 路径 |

缺少 token 时默认拒绝连接。只有测试环境显式设置 `NAPCAT_ALLOW_EMPTY_TOKEN=1` 才允许空 token。

## 去重与未知结果

发送前先把 `dedupe_key` 写成 `pending_send`。收到 NapCat 的 message_id 后立即更新为 `sent_unverified`，随后调用 `get_msg` 验证并更新为 `sent_verified`。

若网络在发送请求后中断、无法判断 QQ 是否已收到，服务保留 `pending_send` 并阻止同一去重键自动重发，避免恢复后重复刷屏。调用者应查看状态并人工决定是否使用新的去重键补发。

跨进程发送锁超过 15 分钟时，服务返回 `STALE_SEND_LOCK` 和锁文件路径，不会自动删锁。先确认旧进程已退出，再检查数据目录中的 `state/dedupe.json`；存在 `pending_send` 时不得自动补发，没有对应状态时可把旧锁改名留证后重试。

## 固定群文件上传

`napcat_send_file` 只接受本机绝对文件路径、可选显示文件名和去重键，不接受群号。上传前会确认文件存在、不是空文件、大小未超限，计算 SHA256，再次校验登录账号和固定绑定群；上传后调用 `get_group_root_files`，按文件名、大小和可用的上传者信息核验。

若上传请求超时、连接中断、HTTP 错误或缺少 `file_id`，结果按未知处理，同一去重键不会自动重传。正式训练回包应先完成本地双重验包和外置 SHA256，再上传 ZIP；上传结果、群文件 ID、文件大小和 SHA256 写入回包 manifest。

## 固定群文件读取与下载

`napcat_read_recent` 会从数组消息段或 NapCat 的 `[CQ:file,...]` 文本中提取原始 `fileId/fileUuid`、文件名、大小和可用的 `busId`。需要取回文件时，把任务文件索引或附件返回的 `fileId` 交给 `napcat_download_file`，同时给出本机绝对保存目录；若索引同时提供 `file_message_seq` 与 `busid`，应一并传入。工具先复核登录账号和固定绑定群，再向 NapCat 获取临时下载地址并流式落盘，返回本地路径、字节数和 SHA256。

下载工具不接受群号或调用方提供的 URL，也不覆盖同名文件。目标文件已存在时应先核对是不是同一份，随后换一个明确文件名或目录，不能静默覆盖已有训练材料。

NapCat 的 `get_group_root_files.files[].file_id` 是当前 NapCat 进程内可解码的临时映射，不适合跨机器写入任务索引；上传接口返回的原始 `fileUuid` 才是任务索引发布值，根文件 `file_id` 只用于本机上传核验。接收方 NapCat 重启或内存映射过期后，第一次 URL 查询可能失败；下载工具会按 `file_message_seq` 刷新对应群历史（未提供时刷新最近 50 条）以重建映射，再用同一原始 `fileUuid` 重试一次。

## 任务账本与 Codex 自动唤醒

`napcat_send_text` 可选传入 `task_id`、`source_machine` 和 `target_machine`，正文会写成 `[Codex][TASK_MESSAGE]` 并包含精确的「任务：<task_id>」行。`napcat_read_recent` 传同一个 `task_id` 时，只返回扫描范围内匹配该任务的结构化消息，同时给出 `scannedCount` 和 `returnedCount`；没有任务标记的日常聊天不会被当成任务消息。

`napcat_send_file` 提供 `task_id`、来源机器和目标机器时，会在文件上传并完成群文件核验后追加 `[Codex][TASK_FILE_INDEX]`，记录文件名、字节数、SHA256 和文件标识。索引发送失败时不会重新上传已核验文件，重试只补索引。

参与任务的发送端和接收端都要调用 `napcat_task_register`，登记相同 `task_id`、本机稳定 `conversation_id`、本机角色、来源/目标机器和可信对端 QQ。`task_id` 应表示长期任务身份，不把每次运行日期当成默认组成；重复实验日期、时间和批次放在 `run_id` 或当前 generation 中。任务路由器每 30 秒读取一次固定群，同一次扫描中的多条合格消息合并成一次唤醒；只有登记任务、可信发送者、正确来源/目标和未确认消息同时满足时才会唤醒对应 Codex 对话。

唤醒提交使用默认 5 分钟的注入租约，防止多个路由进程同时向同一对话写入；提交成功后应用每任务默认 10 分钟冷却。冷却期间到达的新消息进入持久消息账本，不会重置冷却截止时间；时间满足后只合并唤醒一次。普通消息没有新内容时，已经提醒过但尚未 ACK 的旧消息不会因为计时被反复发送；只有明确登记的双机结构化 task 在 pending 首次持续 12 小时且没有业务 ACK 时，才允许发送一条简短去重提醒，此后每满 12 小时至多再发一条，普通群聊、主人聊天和只读群消息不参与。

每次唤醒携带 `generation`、`wake_id`、全部 `pending_message_seqs`、本次 `new_message_seqs` 和 `previously_pending_message_seqs`。模型实际处理完一条或多条后，调用 `napcat_task_ack`，明确传 `expected_generation=唤醒提示中的 generation`、该消息所在唤醒的 `wake_id`，并在 `processed_message_seqs` 中只列出已完成消息；未列出的消息继续待处理。旧唤醒的迟到 ACK 只确认明确列出的消息，不能清除后来消息。`pending_through_message_seq` 仅保留作兼容摘要，不再是整批 ACK 边界。`napcat_task_update` 可把单任务冷却调整到 30 秒至 24 小时。换对话或修改路由身份时 generation 增加，旧代次不能继续 ACK；任务仍有待处理消息或活动唤醒时，路由换绑会被拒绝，必须先处理或安全恢复账本，不能靠换绑清空现场。

需要对端业务回信的结构化任务在正文或索引中显式写 `reply_required=true`、`expected_reply`、带时区回复期限和 `next_check`。`machine_received` 与 `conversation_received` 只证明运输链路，不是业务回信；预计处理超过 60 秒时接收方先回 `IN_PROGRESS` 和新的检查时间。发送方等待其它对话 20～30 分钟时设置一次性 `automation_update` 叫回检查，收到回信后撤销，避免两端互等。

生产对话已经长期空闲、但旧版留下多批 `sent` 唤醒且待处理消息仍不能判定完成时，只能使用 `ops/rearm-stale-sent-wake.mjs` 做受控重新提醒。先用 `--prepare` 固定 registry/dedupe/router log 哈希、任务绑定、精确 pending 与 wake 身份，再在确认对话空闲和业务进程为 0 后用 `--execute`；脚本会备份三文件、归档旧 wake、保持消息与 ACK 状态不变，并向同一对话注入恰好一个随机新 `wake_id`。任一身份或文件漂移都会拒绝执行，注入失败则恢复备份；禁止用它代 ACK、清 pending、换 generation 或启动新业务。

`napcat_task_close` 不再接受无条件关闭：调用方必须确认本地没有 pending/active wake、对端已经完成最终交接，并明确这是最终关闭，或给出已经登记、方向兼容且双方握手成功的 `successor_task_id`。任务迁移固定采用「两端先登记后继任务并互发握手 → 验证新路由 → 再关闭旧任务」的顺序；关闭后的任务不会继续扫描或唤醒，不能把先关旧任务当成建新连接的捷径。

## 送达回执、重连请求与主人通知

结构化任务文本和文件索引都会得到稳定 `delivery_id`。接收端路由器识别到可信消息后自动发送 `machine_received`；校验任务绑定并把消息持久化进绑定对话的任务账本后发送 `conversation_received`。任务级 wake cooldown 只控制下一次 `[NAPCAT_TASK_WAKE]` 何时注入，不延迟这项持久化回执。发送端用 `napcat_delivery_status` 查询这两个传输状态。它们只回答「对端机器看到了」「消息已进入目标对话的持久任务账本」，不会确认 UI 提醒已经出现、模型已经理解或业务已经完成，因此绝不能代替上面的显式 `napcat_task_ack`。

跨机器送达对账只使用 `delivery_id`、`task_id`、generation、发送时间和内容哈希；不同 QQ 账号看到的 `message_seq` 只在各自本机历史分页中使用，不能跨账号比较或查询。路由器会从最新页向前补扫到开放任务或控制窗口边界，即使消息已经掉出最近 50 条，也不会因短暂停机或维护窗口永久漏掉。

关键结构化送达在短窗口内仍缺少 `machine_received` 或 `conversation_received` 时，会通过私有 binding 中固定的主人通知群发送一次去重后的严重故障告警；告警包含 task、delivery、缺失层级、影响、是否已执行和当前处置。对应层恢复后只发送一次解除告警。告警属于控制面通知，不携带或 ACK 业务正文，也不依赖跨账号 `message_seq` 关联。

收到跨机投递严重告警后，双方维护对话必须尽快通过维护 task 回一条带原 `delivery_id` 的接警消息，并分别核对发送侧 `napcat_delivery_status`、接收侧 task 绑定/持久账本、router 状态和当前 wake 租约。不得因告警自动重发业务消息、替生产对话 ACK、关闭 task，或按跨账号 `message_seq` 猜测状态。消息已持久化但仍在合法 wake cooldown 内时属于「已投递、待提醒」，不能按对话失联处置，也不应仅为消除投递告警而降低生产 task 的提醒冷却；真实缺失则由维护对话修复路由并等待系统发送去重后的恢复通知，随后回报最终处置。

控制面第一次在启用状态下成功读取群历史时，会把当前可信业务消息快照的两阶段回执键写入基线，并持久化 `businessReceiptBootstrapAt`；这些历史消息不补发 `machine_received` 或 `conversation_received`，避免把群历史刷成一屏回执。业务基线不依赖 QQ 时间戳或两台电脑的时钟，写入后也不会随进程或电脑重启改变，因此机器离线期间后来到达的消息仍会在恢复扫描后正常补回执。首次启用时只有最近 15 分钟内且时间可核验的建链请求允许进入处理窗口，更旧或时间无效的请求只记为历史基线；已经确认或发送结果未知的控制回执按稳定键去重，不会因扫描器重启自动重发。

意外关闭任务时，可以调用 `napcat_connection_request`。首次请求只在这条控制消息中交换 `source_conversation_id` 与 `target_conversation_id`，接收端校验可信机器后把回拨地址持久保存；以后反向重连可传 `reply_to_request_id`，或用稳定的 `previous_task_id` 自动恢复对端地址。普通任务消息、文件索引和 heartbeat 不携带双方 conversationId，不会持续挤占 QQ 单条消息空间。工具只负责唤醒和提出请求，不会替对端创建、更新或绑定任务；对端仍需自行核对身份并调用 `napcat_task_register`，两边完成握手后才能恢复正式消息或关闭旧连接。

主人通知先用 `napcat_owner_route_register` 把内部 `route_key` 绑定到本机 Codex 对话与私有 `target_key`，再用 `napcat_owner_alert` 发送简短、自然、方便主人直接阅读的提醒。首次登记或关闭后重开路由时，控制面会把目标当前已有的最近消息保存为基线，旧私聊历史不会被重新注入；路由开放期间已经确认或缓冲的消息身份也会持久保存，backend 重启不会回放。发送成功后，控制面只在本机保存「QQ 消息 ID → route_key → conversationId」映射，不把路由字段写进给主人看的正文；私聊末尾默认追加「引用此条回复即可」，群聊默认追加「引用此条并 @ 当前机器账号回复即可」，调用方也可用 `reply_hint` 换成更符合语境的短提示。

私聊必须引用对应通知，群聊必须引用对应通知并 @ 本机 NapCat 账号；系统只按被引用通知的 QQ 消息 ID 精确恢复 `route_key` 与 `conversationId`，不根据语义、发送时间或“最近开放路由”猜测目标，也不会广播给其它对话。主人单独发送图片、文件、转发、表情等无明确文字指令的消息时，扫描器只把附件元数据写入该路由的持久缓冲，不立即唤醒 Codex；后续出现明确文字时再把缓冲附件和文字合并成一次可见唤醒，提交失败则保留缓冲等待重试。扫描器只把匹配回复送回绑定对话，普通私聊、普通群消息和其它任务不会触发。滚动升级期间仍兼容旧的可见 `route_key` 回复，但新通知不再生成这种格式。真实 QQ、群号和目标映射只存在于私有 binding，公开示例只放占位值。

维护升级默认等待所有活跃唤醒自然完成；确需在任务暂停期间保留未 ACK 唤醒时，可显式给 `ops/update-codex-napcat-bridge.ps1` 传 `-PreserveActiveWakes`。脚本会先进入维护态并停止任务路由器，再校验任务绑定、generation、逐消息账本和唤醒批次完全不变，之后才允许切换代码；它不会替模型 ACK，也不会清除待处理消息。

仅修改 NapCat MCP 后端与任务路由、透明中转相关文件哈希完全未变时，可同时传 `-BackendOnlyHotReload`。升级器会证明代理关键文件逐个相同，只重载 NapCat broker 子进程并重启监督器和任务路由器，不结束 Codex，也不中断当前透明代理连接；任一代理文件变化时会拒绝该模式，必须改走完整升级。

维护发布按无感升级设计：实现、测试、干净包、回滚演练和双端影子验证全部在隔离环境完成，生产侧只执行已验证候选的约 1～2 分钟后端热切与健康检查，通常不需要生产停工，也不应反复找业务主线开放窗口。只有实时业务确实依赖该信道、存在不可保护状态或必须完整切换代理时，才携带候选身份、回滚入口和实时门槛协调一次短窗口。

## Codex App Server 透明中转

原生蓝点和侧边栏未读状态只会出现在 Codex Desktop 自己持有的 App Server 连接上。直接启动另一份 App Server 虽然能把文字写进对话存储，却不能通知当前 Desktop 刷新。可选透明中转使用下面的连接方式，把 Desktop 的原始流量双向转发给官方 App Server，同时允许 NapCat 在同一条已初始化连接上先恢复已登记任务，再提交一条带 `wake_id` 的唤醒消息：

```text
Codex Desktop -> ws://127.0.0.1:18432 透明中转 -> ws://127.0.0.1:18433 官方 App Server（默认；冲突时自动换空闲端口）
NapCat task router -> http://127.0.0.1:18431/v1/subscriptions + /v1/wakes
```

`18432` 是 Codex Desktop 始终使用的固定入口；透明中转先监听该端口，再探测或启动官方 App Server。Desktop 提前连接时，初始化请求会留在受条数和总字节双重限制的内存队列中，并在上游就绪后继续发送，避免开机竞态表现成 `ECONNREFUSED` 或 WebSocket 1005。官方 App Server 的上游端口只在本机回环地址中使用。受管 App Server 停止时最长等待 120 秒，并同时确认子进程和仍由真实进程承载的监听都已消失；Windows 端口表若只残留一个查不到进程实体的旧 PID，则记录为 `staleListener`，允许新代理改用空闲回环端口，不能因此把升级永久卡在维护态。默认上游端口被真实历史进程占用时同样选择空闲端口并记录实际地址；所有可结束实例仍须通过精确 PID、命令行、路径和端口校验，禁止按进程名结束 Codex。代理运行期间还会比较当前最新 `codex.exe` 的路径、修改时间和文件大小；只有 Desktop 已断开、代理客户端数为 0，并且新候选通过独立探针时，才结束旧受管 App Server 并切换到新版本，避免 Codex 更新后长期沿用旧 App Server，也避免在线会话被强制中断。

更新脚本不会终止 Codex Desktop。便携包会启动隐藏激活器，等待当前 Codex 与代理连接自然断开后，再干净重启受管代理并热重载 NapCat backend；用户只需正常退出 Codex、等待约 10 秒后重新打开，不需要重启 Windows。

未来版本若确需退出 Codex 或重启 Windows，验收必须覆盖最后收尾而不只看代码复制：激活器应完成 `activated=true`、`pendingActivation=false`、`restartCodexRequired=false`；超时、撤销或失败应恢复 router 并清除本次维护留下的 `task-router.stop`/maintenance；Windows 登录后共享 broker 必须使用包内 Node 绝对路径自动启动，再核对 router 连续扫描、open task 与私有账本无漂移。任一项未满足都不能报升级完成。

控制端口只监听回环地址并要求随机 Bearer token。task router 会从任务账本所在的 `state` 目录自动发现 `codex-app-server-proxy-runtime.json` 与 `codex-app-server-proxy-token.txt`；发现任一代理产物后必须走透明中转，配置残缺或代理不可达时暂停自动唤醒并报错，禁止静默退回独立 App Server。任务订阅同时绑定 `task_id`、generation、conversation ID、本机角色、来源/目标机器和可信 QQ，订阅接口只登记绑定并确认 Desktop 在线，真正唤醒时才执行一次 `thread/resume`，并通过 `excludeTurns=true` 只取任务元数据和当前运行状态，不重复拉取整段历史。同一个 `wake_id` 在任何并发、超时或重启情况下最多提交一次。可见模式的 `clientUserMessageId` 在请求发送前写入唤醒日志，同一次逻辑唤醒重试只复用原值，不把 UUID 当作去重边界。若 App Server 在正常会话中退出，透明中转会关闭当前 Desktop 连接，让 Desktop 重新建立一条权威会话并补齐状态；它不会在旧连接上猜测重放普通请求或通知。已经写出但没有得到确定结果的 `turn/start` 或 `turn/steer` 记为 `unknown`，不会自动补发。WebSocket 显式允许大型合法帧，但只解析小型控制消息，大帧保持原始二进制转发；队列、发送缓冲和心跳都有上限，超限或半开连接会主动断开并触发权威重连。proxy、supervisor 和 task router 的单实例恢复同时核对 PID、runner 路径、runtime/lock 路径、随机实例 token、监听端口与状态心跳，不能只因某个 PID 仍存在就认定旧实例健康。

协议探针、唤醒日志、控制 token、运行状态和 fallback 请求都保存在私有 data root。唤醒日志损坏、协议不兼容、代理连续恢复失败或维护状态不可读时，系统采取两层降级：当前自动唤醒立即暂停；监督器在固定群发送一条去重告警并保留本地 incident 状态。看门狗随后清除用户级 `CODEX_APP_SERVER_WS_URL`，让下一次普通 Codex 启动回到官方原生路径。这个设计保证代理故障不会持续阻止 Codex 打开，但无法承诺未来任意 Codex 版本永不改变内部协议；不兼容时必须以「暂停自动化、保留任务、恢复原生启动」结束，不能猜协议继续写入。

升级验收必须使用两端各自独立登记的测试 task 和测试对话，不能拿正式 open task 试错。两台机器同步同一公开提交并正常重启 Codex 后，由两端维护对话互发唯一测试消息；主人需要在目标测试对话尚未打开时亲眼确认侧边栏未读标记，随后确认消息实时可见、只出现一次、测试对话能正常处理并 ACK。两端都通过后才能恢复正式自动路由；只有后端日志、对话存储写入或重启后才看见消息，均不算通过。测试 task 完成后应关闭，正式 task 的 generation、游标、租约和绑定保持不变。

## 安全更新与回滚

公开代码目录和私有 data root 必须分开。推荐代码安装到 `%USERPROFILE%\.codex\services\napcat-bridge\current`，绑定、任务账本、控制状态、ACK 游标、唤醒租约、心跳、日志、二维码和登录态继续留在 `%USERPROFILE%\.codex-toolkit\napcat-mcp`。GitHub 更新不得整目录覆盖 data root，也不得把接收机私有文件反向复制进仓库。`control-state.json` 固定与任务账本共享 data root；升级器会备份并迁移旧代码目录中的同名状态，若两处同时存在且内容不同则拒绝切换，保留两份文件等待人工核对。

监督器和登录脚本在尝试快速登录前会同时检查 `launcher-user.bat` 与 `napcat.mjs`。核心文件缺失时状态应明确为 `NAPCAT_RUNTIME_INCOMPLETE`，自动登录暂停且不会生成或索要二维码；这通常表示安装损坏或安全软件隔离，不等于快速登录授权过期。恢复时应先核对安全软件记录，再从相同 NapCat 版本的官方发布包恢复文件并校验哈希，不能用关闭安全软件或排除整个目录代替诊断。

面向日常使用者的安装应优先采用「先准备、后退出 Codex 激活」：候选代码、私有路径和登录计划任务先在不触碰当前 Codex 进程的情况下写好，隐藏激活器等待 Codex 与代理自然断开后，只清理受管代理和它启动的官方 App Server。用户正常退出 Codex、等待约 10 秒再打开即可，不需要重启 Windows；任何清理失败都必须保留旧任务和本地状态、暂停自动唤醒并报警，不能终止 Codex Desktop 或按进程名误杀其它实例。

```powershell
# 在仓库根目录执行；首次迁移计划任务时加 -MigrateAutostart
$brokerRoot = (Resolve-Path ".\mcps\broker").Path
./mcps/napcat-mcp/ops/update-codex-napcat-bridge.ps1 `
  -BrokerRoot $brokerRoot `
  -SourceCommit "<git-commit>" `
  -MigrateAutostart

# 检查代理、监督器和任务路由
./mcps/napcat-mcp/ops/get-codex-app-server-proxy-status.ps1
./mcps/napcat-mcp/ops/get-napcat-supervisor-status.ps1
./mcps/napcat-mcp/ops/get-napcat-task-router-status.ps1
```

更新器先从当前进程或 broker 私有配置解析真实 `MCP_SDK_ROOT`；训练机只有 `CODEX_TOOLKIT_BROKER_ROOT` 时，也会按 broker 的真实目录布局，从其父目录下的同级 `memory-store/node_modules` 推导 SDK。路径缺失时直接拒绝升级；路径有效后，先在独立候选目录执行 `npm ci`、语法检查和完整测试，三项全部通过才创建维护标记、等待或保护 `wakePending/activeWakeId`、备份任务账本与私有环境并进入安装。候选检查失败时只删除隔离候选，不写维护状态、不停止 task router、watchdog、透明代理或 App Server，不修改或重载 broker，也不中断当前 Codex。候选通过后才替换公开代码，停止并恢复实际需要切换的 router/supervisor/proxy，最后只重载 broker 的 NapCat backend。broker PID 和其他 MCP 前端 session 保持不变。更新前后会比较每个任务的对话绑定、角色、可信对端、generation、open/closed 状态、last seen/ACK、冷却、租约和 active wake，任何意外变化都会停止完成流程并留下告警。更新输出中的 `sourceCommit`、`activated` 和 `pendingActivation` 是运行态依据：只有 `activated=true` 且 `pendingActivation=false` 才表示新版本已经运行，候选写入或文件复制完成不能冒充热重载完成。

监督器恢复 broker 时优先读取受管 `service-manifest.json` 中的 `broker.startScript`，并要求 `broker.brokerScript` 的父目录与本次传入的 `BrokerRoot` 完全一致；这样 NapCat `CodeRoot` 与便携 broker release 分离安装时不会再从错误目录猜启动器。清单缺字段、路径不存在或归属不一致都会在启动前安全拒绝，不会误拉起另一套 broker。

便携同步包的顶层入口源码位于 `package/APPLY-NAPCAT-APPSERVER-UPGRADE.ps1`。它不负责在线修改 broker：`-ValidateOnly` 可在 broker 更新前先做无运行态副作用的 NapCat 候选预检；正式安装时再逐文件证明目标机 broker 已由 `Update-CodexMcpBroker.ps1` 更新到与包内相同的快照，然后调用受保护更新器。证明失败或候选验证失败时，它不会停止 watchdog、透明代理或 App Server，不复制 broker 文件，也不重启计划任务；这条入口必须随公开源码和同步包一起测试，不能只验证内部 updater。

便携包升级顺序固定为：先运行 `APPLY-NAPCAT-APPSERVER-UPGRADE.ps1 -ValidateOnly`，确认候选源码、依赖与测试全部通过；再运行 `Update-CodexMcpBroker.ps1` 更新共享 broker；最后运行不带 `-ValidateOnly` 的 NapCat 升级入口完成受保护切换。不得把 broker 更新或任何停服动作放在候选验证之前。

只修改任务路由、账本、监督器、MCP backend 或 `codex-thread-bridge.mjs` 时可以使用 `-BackendOnlyHotReload`：该模式会停止并恢复 task router 与 supervisor、定向重载 NapCat backend，但保持透明代理、受管 App Server、Codex Desktop 连接和其他 MCP session 不变。只有 `codex-app-server-proxy*.mjs` 或代理启停脚本变化时才必须等 Codex 正常退出后执行完整代理切换。维护文件中只有 `automationBridge` 原因时，监督器允许启动 task router 核对代理唤醒日志并自愈；包升级、回滚、认证或协议异常仍会继续拦截自动路由。

首次启用透明中转后需要彻底退出并正常打开 Codex 一次，让 Desktop 继承新的 `CODEX_APP_SERVER_WS_URL`。以后仍按原方式启动 Codex。更新失败时不要手工删除 task；运行 `rollback-codex-napcat-bridge.ps1` 恢复上一个代码备份，或者保留维护状态等待排查。若上一个代理也无法恢复，更新器会清除用户级代理 URL、写入 fallback 请求，并让下一次 Codex 启动走官方原生路径；回滚同样只重载 NapCat backend，不重启整个 broker。

## 心跳进程

`src/heartbeat-runner.mjs` 是普通后台进程，不注册服务，也不设置开机启动。它每轮重新读取数据目录中的 `heartbeat.json`，向固定群发送 `heartbeat` 事件，并把 PID、最近尝试、最近成功、下次尝试和错误写入 `state/heartbeat-runtime.json`，简化日志写入 `state/heartbeat.jsonl`。

整机关机、Windows 卡死、runner 被终止、QQ 或 NapCat 离线后，心跳都会停止。缺失心跳因此能作为失联线索，但本机死亡时无法主动发送“我死了”；真正的超时报警仍应由群外接收端判断。

`ops/` 中还提供任务路由器与 `CodexNapCatSupervisor` 的启动、停止、状态和登录后自动启动脚本。监督器是当前 Windows 用户下的隐藏普通进程，不是系统服务；它同时核对 broker 健康与进程、NapCat OneBot 与进程、Codex 进程和 open task，条件齐全才保持任务路由运行。NapCat 完全未运行时才尝试无二维码快速登录，已有进程但 OneBot 离线时不会启动第二份。无二维码快登超时或账号不符时，登录脚本会结束本次启动的隐藏进程树，避免留下一个拿不到二维码、又阻止后续恢复的僵尸 NapCat。

监督器对 broker 的判断使用 `/health?endpoint=napcat&deep=1`，必须完成 NapCat 子后端的只读 `tools/list` 往返才算健康。只有 14588 端口或 broker 主进程仍在、但子 transport 已断开的情况会被识别并恢复；恢复不会读取群消息、发送内容、ACK 或重放先前结果未知的工具调用。

有人值守恢复时直接运行 `ops/start-napcat-login.ps1`：脚本会使用 binding 中的 `expectedSelfId` 先尝试该账号的快速登录；授权有效则不显示二维码，授权失效且 NapCat 生成新二维码时才弹出小窗口并阻塞到登录成功或明确失败。监督器始终传 `-NoQr`，不会在无人值守桌面弹出二维码。

`install-napcat-autostart.ps1 -StartNow` 只注册固定名称的当前用户登录计划任务，替换前会导出同名旧任务并记录回滚状态。`remove-napcat-autostart.ps1` 只移除该固定任务，并在存在备份时恢复前任任务。所有运行状态默认写入接收方的 `.codex-toolkit/napcat-mcp` 数据目录，不写回源码目录。

## 已知兼容性说明

不同 NapCat / OneBot 构建对群文件标识和 `busid` 的接受范围仍可能不同。本快照按 NapCat v4.17.53 的实际实现区分原始 `fileUuid` 与根文件临时 `file_id`，并覆盖缓存失效后的历史刷新重试；正式使用前仍应在接收方版本上验证上传、索引、读取、重启后下载和 SHA256 闭环。

## 安全边界

- 调用时不能指定 group_id，目标群只能来自本机 `binding.json`
- 读取和发送前都核对 self_id、群名和成员数
- 文件工具不接受 URL，只上传本机普通文件
- token 不写 stdout、工具结果或普通日志
- 任务路由只接受登记任务、可信对端、正确机器方向与当前 generation
- ACK 不能回退、不能超过扫描游标，也不能确认尚未处理的消息
- 不开放撤回、踢人、禁言、群管理和任意消息接口
- Computer Use 仅作为人工备用，不是此 MCP 的依赖
