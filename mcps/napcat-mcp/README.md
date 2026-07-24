# NapCat QQ 群协作 MCP（可选）

这是一个固定账号、固定群聊的窄功能协作服务。AI 可以通过 NapCat OneBot HTTP API 向 QQ 群发送运行状态和文本、读取最近消息、上传或下载群文件，用于多台设备之间的任务通知与材料交接。调用方不能临时指定任意群号或联系人。

本目录只包含 MCP 源码、示例绑定、测试和运维脚本，不包含 NapCat 本体、QQ 登录态、二维码、真实账号、真实群号、访问令牌或运行状态。接收方必须自行安装 NapCat 并在本机完成登录；broker 默认不启用本模块，只有设置 `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1` 后才暴露 `/napcat/mcp`。

## 工具

| 工具 | 是否发送消息 | 用途 |
|---|---|---|
| `napcat_status` | 否 | 检查 OneBot、登录账号和已绑定群 |
| `napcat_discover_target` | 否 | 按 binding 中的群名和成员数查找候选群 |
| `napcat_read_recent` | 否 | 读取固定群最近消息和文件附件元数据，先校验账号和群 |
| `napcat_download_file` | 否 | 用读取结果中的 file_id 下载固定群文件到本机目录 |
| `napcat_preview_training_event` | 否 | 生成最终通知正文 |
| `napcat_preview_text` | 否 | 预览固定群文本正文 |
| `napcat_send_training_event` | 是 | 校验账号与群后发送并去重 |
| `napcat_send_text` | 是 | 向固定群发送普通或 task_id 结构化文本并去重、核验 |
| `napcat_preview_file` | 否 | 计算本机文件大小和 SHA256，预览上传目标 |
| `napcat_send_file` | 是 | 向固定群上传文件并用群文件列表核验 |

## 本机配置

先把 `binding.example.json` 复制到 `%USERPROFILE%\.codex-toolkit\napcat-mcp\binding.json`，再填写收件人自己的 QQ 账号、昵称、目标群和预期成员数。示例中的 `ExampleBot`、`ExampleGroup` 与号码均为假数据。OneBot 地址和 token 通过 broker 私密环境提供：

| 环境变量 | 示例 | 说明 |
|---|---|---|
| `NAPCAT_HTTP_URL` | `http://127.0.0.1:3010` | 仅回环地址的 OneBot HTTP 服务 |
| `NAPCAT_ACCESS_TOKEN` | 不写进同步包 | OneBot Bearer token |
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

`napcat_read_recent` 会从数组消息段或 NapCat 的 `[CQ:file,...]` 文本中提取 `fileId`、文件名和大小。需要取回文件时，把该 `fileId` 交给 `napcat_download_file`，同时给出本机绝对保存目录；工具先复核登录账号和固定绑定群，再向 NapCat 获取临时下载地址并流式落盘，返回本地路径、字节数和 SHA256。

下载工具不接受群号或调用方提供的 URL，也不覆盖同名文件。目标文件已存在时应先核对是不是同一份，随后换一个明确文件名或目录，不能静默覆盖已有训练材料。

## 多任务读取

`napcat_send_text` 可选传入 `task_id`、`source_machine` 和 `target_machine`，正文会写成 `[Codex][TASK_MESSAGE]` 并包含精确的「任务：<task_id>」行。`napcat_read_recent` 传同一个 `task_id` 时，只返回扫描范围内匹配该任务的结构化消息，同时给出 `scannedCount` 和 `returnedCount`；没有任务标记的日常聊天不会被当成任务消息。

群文件本身不能附带自定义 task_id，所以正式流程是先上传文件，再用同 task_id 的结构化文本发送文件名、返回的 fileId、大小和 SHA256。接收端按 task_id 读取这条说明，再调用下载工具。

MCP 仍是由 Codex 主动调用的拉取接口。若要无人值守地把消息自动送回指定 Codex 对话，需要该对话的 Codex automation 定时调用读取工具，并在本机持久登记 `task_id → conversationId` 与最近消息序号；普通 NapCat 后台进程不能直接调用 Codex App 的线程工具。

## 心跳进程

`src/heartbeat-runner.mjs` 是普通后台进程，不注册服务，也不设置开机启动。它每轮重新读取数据目录中的 `heartbeat.json`，向固定群发送 `heartbeat` 事件，并把 PID、最近尝试、最近成功、下次尝试和错误写入 `state/heartbeat-runtime.json`，简化日志写入 `state/heartbeat.jsonl`。

整机关机、Windows 卡死、runner 被终止、QQ 或 NapCat 离线后，心跳都会停止。缺失心跳因此能作为失联线索，但本机死亡时无法主动发送“我死了”；真正的超时报警仍应由群外接收端判断。

`ops/` 中提供登录、启动心跳、更新心跳、查询状态和停止心跳五个脚本。登录脚本以无控制台窗口方式启动 NapCat，把日志写入桌面 `NapCat\logs`，二维码窗口持续到绑定账号上线或明确失败，不会把“二维码已生成”当成登录成功。停止脚本会先核对记录 PID 的命令行包含当前源码目录下的 `heartbeat-runner.mjs`，再写停止文件；默认不会直接杀死不匹配的进程。

## 安全边界

- 调用时不能指定 group_id，目标群只能来自本机 `binding.json`
- 读取和发送前都核对 self_id、群名和成员数
- 文件工具不接受 URL，只上传本机普通文件
- token 不写 stdout、工具结果或普通日志
- 不开放撤回、踢人、禁言、群管理和任意消息接口
- Computer Use 仅作为人工备用，不是此 MCP 的依赖
