# NapCat QQ 群协作 MCP（可选）

这是一个固定账号、固定群聊的窄功能协作服务。AI 可以通过 NapCat OneBot HTTP API 向 QQ 群发送运行状态和文本、读取最近消息、上传或下载群文件，也可以把经过身份校验的结构化任务消息路由回已经登记的 Codex 对话。调用方不能临时指定任意群号或联系人。

本目录只包含 MCP 源码、示例绑定、测试和运维脚本，不包含 NapCat 本体、QQ 登录态、二维码、真实账号、真实群号、访问令牌或运行状态。接收方必须自行安装 NapCat 并在本机完成登录；broker 默认不启用本模块，只有设置 `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1` 后才暴露 `/napcat/mcp`。

## 工具

| 工具组 | 代表工具 | 用途 |
|---|---|---|
| 状态与目标 | `napcat_status`、`napcat_discover_target` | 检查 OneBot、登录账号和固定群身份 |
| 消息与文件 | `napcat_read_recent`、`napcat_download_file`、`napcat_send_text`、`napcat_send_file` | 按固定群读取、下载、发送与上传；任务文件会附带结构化索引 |
| 任务账本 | `napcat_task_register`、`napcat_task_update`、`napcat_task_status`、`napcat_task_list` | 维护任务、Codex 对话、角色、可信对端、代次和唤醒冷却 |
| 任务完成 | `napcat_task_ack`、`napcat_task_close` | 处理完明确消息序号后确认，任务结束后关闭路由 |
| 预览与训练事件 | `napcat_preview_*`、`napcat_send_training_event` | 在发送前预览正文，或发送受去重保护的训练状态 |

## 本机配置

先把 `binding.example.json` 复制到 `%USERPROFILE%\.codex-toolkit\napcat-mcp\binding.json`，再填写收件人自己的 QQ 账号、昵称、目标群和预期成员数。示例中的 `ExampleBot`、`ExampleGroup` 与号码均为假数据。OneBot 地址和 token 通过 broker 私密环境提供：

| 环境变量 | 示例 | 说明 |
|---|---|---|
| `NAPCAT_HTTP_URL` | `http://127.0.0.1:3010` | 仅回环地址的 OneBot HTTP 服务 |
| `NAPCAT_ACCESS_TOKEN` | 不写进同步包 | OneBot Bearer token |
| `NAPCAT_TASK_REGISTRY_PATH` | data root `state/task-registry.json` | 任务、对话、代次、游标、租约与冷却账本 |
| `NAPCAT_TASK_ROUTER_INTERVAL_MS` | `30000` | 固定群任务扫描间隔 |
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

参与任务的发送端和接收端都要调用 `napcat_task_register`，登记相同 `task_id`、本机稳定 `conversation_id`、本机角色、来源/目标机器和可信对端 QQ。任务路由器每 30 秒读取一次固定群，同一次扫描中的多条合格消息合并成一次唤醒；只有登记任务、可信发送者、正确来源/目标和未确认消息同时满足时才会唤醒对应 Codex 对话。

成功提交唤醒后默认保留 5 分钟处理租约，并应用每任务默认 10 分钟成功唤醒冷却。`napcat_task_ack` 只确认当前对话实际处理到的最大 `message_seq` 并释放租约，不绕过成功冷却；`napcat_task_update` 可把单任务冷却调整到 30 秒至 24 小时。换对话或修改路由身份时 generation 增加，旧代次不能继续 ACK；任务结束必须调用 `napcat_task_close`。

## 心跳进程

`src/heartbeat-runner.mjs` 是普通后台进程，不注册服务，也不设置开机启动。它每轮重新读取数据目录中的 `heartbeat.json`，向固定群发送 `heartbeat` 事件，并把 PID、最近尝试、最近成功、下次尝试和错误写入 `state/heartbeat-runtime.json`，简化日志写入 `state/heartbeat.jsonl`。

整机关机、Windows 卡死、runner 被终止、QQ 或 NapCat 离线后，心跳都会停止。缺失心跳因此能作为失联线索，但本机死亡时无法主动发送“我死了”；真正的超时报警仍应由群外接收端判断。

`ops/` 中还提供任务路由器与 `CodexNapCatSupervisor` 的启动、停止、状态和登录后自动启动脚本。监督器是当前 Windows 用户下的隐藏普通进程，不是系统服务；它同时核对 broker 健康与进程、NapCat OneBot 与进程、Codex 进程和 open task，条件齐全才保持任务路由运行。NapCat 完全未运行时才尝试无二维码快速登录，已有进程但 OneBot 离线时不会启动第二份。无二维码快登超时或账号不符时，登录脚本会结束本次启动的隐藏进程树，避免留下一个拿不到二维码、又阻止后续恢复的僵尸 NapCat。

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
