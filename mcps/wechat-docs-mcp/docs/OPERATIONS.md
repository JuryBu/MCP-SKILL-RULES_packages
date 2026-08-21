# 运维手册

## 1. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Python | >=3.12, <3.14 | 目标环境 3.12 |
| 微信 | 4.1+ | 需运行中且已登录 |
| 操作系统 | Windows | 密钥提取工具依赖 Windows API |
| zstandard | >=0.22, <1 | zstd 解压依赖，`pip install zstandard` |
| mcp | >=2, <3 | MCP SDK |

## 2. 配置项

### 2.1 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WECHAT_DOCS_MCP_DATA_ROOT` | `~/.codex-toolkit/wechat-docs-mcp` | 数据根目录 |
| `WECHAT_ENCRYPTED_DB_DIR` | (无) | 微信加密数据库目录，**必须设置** |
| `WECHAT_KEY_TOOL` | `<data_root>/private-state/tools/wcdb_key_tool_windows.py` | 密钥提取工具路径 |
| `TENCENT_DOCS_MCP_TOKEN_FILE` | `<data_root>/secrets/tencent-docs-mcp.token` | 腾讯文档 Token 文件 |
| `WECHAT_DOCS_MCP_AUTO_POLL` | `0` | MCP 进程启动时自动开启后台轮询 |
| `CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS` | `15000` | broker 深层健康检查等待微信 backend 冷启动的上限；仅在实测依赖导入较慢时提高 |
| `WECHAT_DOCS_MCP_TDOCS_AUTO_POLL` | `0` | 启动时开启腾讯文档只读监视；候选验证前保持关闭 |
| `WECHAT_DOCS_MCP_TDOCS_POLL_INTERVAL` | `60` | 文档监视轮询间隔秒数，最小 15 秒 |
| `WECHAT_DOCS_MCP_WAKE_ENABLED` | `0` | 将 prepared wake 提交给 Codex 透明代理 |
| `WECHAT_DOCS_MCP_WAKE_MESSAGE_VISIBILITY` | `visible` | `visible` 显示 Codex 用户消息气泡，`hidden` 仅隐藏气泡；两者保持相同注入、重试、wake 与 ACK 语义，非法值拒绝启动 |
| `WECHAT_DOCS_MCP_WAKE_REMINDER_COOLDOWN_SECONDS` | `60` | 已提交 logical wake 出现更大 pending event_seq 后，再次提醒的冷却秒数；合法范围 30～3600 |
| `WECHAT_DOCS_MCP_OUTBOUND_ENABLED` | `0` | 旧版进程启动开关；0.6.1 起不再作为实时文字发送 gate，避免 broker 环境残留覆盖私有关闭状态 |
| `WECHAT_DOCS_MCP_ATTACHMENT_OUTBOUND_ENABLED` | `0` | 旧版进程启动开关；0.6.1 起不再作为实时附件发送 gate |
| `WECHAT_DOCS_MCP_INTAKE_ROOT` | `%TEMP%/wechat-docs-mcp/intake` | 按需物化附件的允许根目录；读取缓存默认 24 小时后清理 |
| `WECHAT_DOCS_MCP_IMAGE_KEY_ROOT` | `<data_root>/secrets/wechat-image-v2` | 按 owner account identity 哈希分区的图片密钥目录 |
| `WECHAT_DOCS_MCP_ACTIVE_OWNER_ACCOUNT_KEY_SHA256` | 空 | 私有 enrollment 已核验的当前账号身份哈希；缺失或与 route 不符时禁止进程扫描并返回 `WAITING_FOR_KEY` |
| `WECHAT_DOCS_MCP_FFMPEG_PATH` | `PATH` 中的 ffmpeg | wxgf/HEVC 图片的无窗口本地解码器 |
| `WECHAT_DOCS_MCP_UPLOAD_ROOT` | `<data_root>/upload` | 附件草稿只允许读取此目录内文件，执行前重新校验 SHA-256 |
| `WECHAT_DOCS_MCP_DERIVED_ROOT` | `<data_root>/derived` | PDF 页面及 DOCX/PPTX 派生 PDF 的私有缓存目录 |
| `WECHAT_DOCS_MCP_SOFFICE_PATH` | `C:\Program Files\LibreOffice\program\soffice.exe` | DOCX/PPTX 的本地隔离转换器；Windows 仅使用 GUI 启动器并强制无控制台窗口，缺失时不降级执行宏或联网转换 |
| `WECHAT_DOCS_MCP_IMAGE_VIEWER_TITLES` | `图片和视频` | 分号分隔的微信图片查看器标题，仅供显式人工辅助视窗预览；不用于消息身份推断 |
| `WECHAT_DOCS_MCP_IMAGE_KEY_FILE` | `<data_root>/secrets/wechat-image-v2.json` | 旧版无账号归属 key 的兼容候选；只有通过当前精确 DAT 验证后才迁入分账号目录 |
| `CODEX_WAKE_PROXY_RUNTIME_FILE` | (无) | 透明代理运行状态文件 |
| `CODEX_WAKE_PROXY_TOKEN_FILE` | (无) | 透明代理控制 token 文件 |

`WECHAT_DOCS_MCP_WAKE_MESSAGE_VISIBILITY=hidden` 依赖共享 Codex App Server 代理 0.3.12 或更新版本提供“可见性与投递语义解耦”的合同。切换前必须先确认该代理版本已生效；旧代理在目标对话忙碌时可能把 `hidden` 当作拒绝投递，而不是与 `visible` 一样转入当前 turn。

0.6.1 起，微信真实发送只读取 `<data_root>/config/service-runtime.json` 中的 `outboundWeChatEnabled` 与 `attachmentOutboundWeChatEnabled`。MCP 在状态查询、能力查询和每次执行发送前都会重新读取该私有文件；文件缺失、损坏、字段缺失或字段不是布尔值时一律关闭。`wechat_outbound_capabilities.active_execution_count` 报告仍持有发送租约的微信执行；关闭脚本必须先关闭动态 gate，再等待该计数归零后才能报告完成。route policy、草稿批准、授权引用、dedupe 与数据库确认仍是独立硬门，动态 gate 不会自动执行或重试既有草稿。

`wechat_outbound_capabilities` 会分别报告严格无窗口附件候选、当前是否启用、低打扰文件选择器回退、复杂剪贴板恢复和接收端确认要求。执行审计中的 `wechat_visible_duration_ms`、前后可见窗口数、前台焦点、鼠标和剪贴板字段用于衡量干扰程度；没有全程采样证据时，不能仅凭前后窗口数都为零宣称严格无窗口。

### 2.2 目录结构

```
<DATA_ROOT>/
├── config/
│   └── binding.json          # 路由绑定配置
├── private-state/
│   ├── decrypted/            # 解密后的数据库
│   │   ├── message/message_0.db
│   │   └── contact/contact.db
│   ├── keys/
│   │   └── all_keys.json     # 提取的密钥文件
│   └── tools/
├── intake/                    # 已验证的入站附件原件
├── upload/                    # 待发送附件允许根目录
└── derived/                   # 可清理的 PDF/Office 页面派生缓存
│       └── wcdb_key_tool_windows.py  # 密钥提取工具
├── state/
│   └── events.sqlite3        # 权威事件账本
├── intake/                   # 按需下载文件，不自动执行或解压
├── upload/                   # 待批准上传文件的允许根目录
└── secrets/
    └── tencent-docs-mcp.token
```

### 2.3 binding.json 格式

使用 `binding.example.json` 的 schema v2 模板。route 只保存精确微信会话身份和本机 outbound capability；conversation 放在独立 `subscriptions` 数组中。一个 route 可出现于多个 subscription，一个 conversation 也可订阅多个 route。`tencentDocs.monitors` 是独立的文档监视 allowlist，不复用微信 route 身份表。

公开模板默认 route 为 `enrolling`、subscription 为 `paused`、outbound 全关闭，示例文档策略也为 `paused/listen=false`。接收方完成唯一身份核验后，才在本机私有文件中启用。启用 `send_capability` 时必须同时提供非空 `policy_ref`，真实授权消息引用另存于私有授权链，不得提交。

## 3. 安装

### 3.1 从源码安装

```powershell
cd <project_root>
python -m pip install -e .
```

### 3.2 验证安装

```powershell
python -m pytest tests/ -v
```

应看到全部测试通过、零警告；准确数量以当前提交的 pytest 输出为准。

### 3.3 配置环境变量

```powershell
$env:WECHAT_ENCRYPTED_DB_DIR = "C:\Users\<user>\Documents\WeChat Files\<wxid>\db_storage"
```

## 4. 启动与停止

### 4.1 手动单次轮询

```python
wechat_poll(force_refresh=False)
# {"changed_files": [...], "decrypted_files": [...], "new_observations": [...], "error": null}
```

### 4.2 后台轮询

```python
# 启动
wechat_poll_start(interval=5.0)
# {"status": "started", "interval": 5.0}

# 停止
wechat_poll_stop(timeout=70.0)
# {"status": "stopped"} 或 {"status": "stopping", "alive": true}
```

### 4.3 停止超时处理

`wechat_poll_stop` 默认等待 70 秒（密钥提取 ~3s + 解密 ~60s + 余量）。如果返回 `stopping`：
- 线程仍在运行，引用保留
- **不能**再次 `wechat_poll_start`（会返回 `already_running`）
- 再次调用 `wechat_poll_stop` 重试等待

腾讯文档监视使用独立控制线程，不会启动、停止或重置微信 watcher：

```python
tdocs_monitor_poll()                  # 手动轮询全部 active monitor
tdocs_monitor_poll_start(interval=60)
tdocs_monitor_poll_stop(timeout=35)
```

首次调用 `tdocs_monitor_create` 会先把资源、官方工具、参数和 `policy_ref` 与私有 `binding.json/tencentDocs.monitors` 做精确比对，再动态核对官方工具目录和必填字段，最后执行一次只读 baseline。每次后续轮询也会重新核对 allowlist，策略暂停、删除或不一致时不访问官方 MCP，baseline 不推进。正式资源 ID、轮询参数、conversation 与策略引用只保存在私有 binding/SQLite；公开模板仅提供 synthetic 占位值。

同一资源需要切换只读轮询工具时，先暂停 monitor，并确保它的所有 delivery 已 ACK、active wake 已清空；随后用相同 `monitor_id` 再次调用 `tdocs_monitor_create`。服务只允许同一资源原地重新建立 baseline，不允许改绑另一资源，也不会回放切换前历史。

### 4.4 MCP 服务启动

```powershell
wechat-docs-mcp
```

通过 stdio 与 MCP 客户端通信。

### 4.5 Broker 与 Supervisor

公开 broker 仅在 `CODEX_TOOLKIT_ENABLE_WECHAT_DOCS_MCP=1` 时增加 `/wechat-docs/mcp`。建议从版本化 release 的 `env` 启动后端，并让 Supervisor 定期调用深度健康检查：

```powershell
& <current>\ops\manage-wechat-docs-supervisor.ps1 -Action Start
& <current>\ops\manage-wechat-docs-supervisor.ps1 -Action Status
& <current>\ops\manage-wechat-docs-supervisor.ps1 -Action Stop
```

安装当前用户登录自启动前应先完成候选 release、broker 端点和回滚验证：

```powershell
& <current>\ops\manage-wechat-docs-supervisor.ps1 -Action InstallAutostart
```

## 5. 健康状态

```python
wechat_status()
```

返回字段：

| 字段 | 说明 |
|---|---|
| `data_root_ready` | 数据根目录存在 |
| `ledger_ready` | 事件账本文件存在 |
| `tencent_docs_token_ready` | 腾讯文档 Token 文件非空 |
| `decrypted_db_ready` | 解密目录存在 |
| `encrypted_db_configured` | 加密 DB 目录已配置且存在 |
| `route_count` | 绑定的路由数量 |
| `subscription_count` | 当前账本中的 subscription 数量 |
| `watcher_ready` | DbWatcher 实例已创建 |
| `background_polling` | 后台轮询线程是否活跃 |
| `poll_last_error` | 后台轮询最后一次错误信息 |
| `poll_last_error_time` | 错误发生时间 |
| `poll_consecutive_failures` | 连续失败次数 |
| `wake_notifier_enabled` | 是否启用 Codex wake 提交 |
| `wake_message_visibility` | 当前 wake 气泡可见性，`visible` 或 `hidden`；该值在 backend 启动时读取 |
| `wake_notifier_ready` | 代理 runtime、token 与回环地址是否就绪 |
| `wake_notifier_error` | 最近一次 wake 提交错误码，不含消息正文或 token |
| `wake_last_attempt_time` | 最近一次提交尝试时间 |
| `tdocs_monitoring` | 文档 monitor/subscription/pending/wake 计数、后台线程、失败次数和文档 wake 状态；不含资源 ID 或正文 |
| `outbound_enabled` | 文字或附件动态 gate 任一开启时为 true；不代表 route、草稿、数据库或接收端确认已通过 |
| `outbound_text_enabled` | 私有运行文件中的动态文字发送 gate |
| `attachment_outbound_enabled` | 私有运行文件中的动态附件发送 gate |
| `runtime_gate_mode` | 动态 gate 的 fail-closed 读取模式 |

### 5.1 健康判断

- **就绪**：`encrypted_db_configured` + `watcher_ready` + `route_count > 0`
- **后台运行中**：`background_polling` = true
- **后台异常**：`poll_consecutive_failures` > 0 且 `poll_last_error` 非空

## 6. 备份与恢复

### 6.1 迁移脚本备份

schema 自动迁移和 `migrate_baselines.py` 都使用 SQLite 原生 `backup()` API 创建时间戳备份；备份名记录来源 schema 版本：

```powershell
python -m wechat_docs_mcp.migrate_baselines
```

备份文件格式：`events.sqlite3.bak.<YYYYMMDDTHHMMSSZ>`

### 6.2 手动备份

```python
import sqlite3
src = sqlite3.connect("path/to/events.sqlite3")
dst = sqlite3.connect("path/to/backup.sqlite3")
src.backup(dst)
dst.close()
src.close()
```

**不要用 `shutil.copy2`** 复制 WAL 模式的 SQLite 文件，可能丢失 -wal 文件中的事务。

### 6.3 旧 route 精确身份恢复

早期 V1 route 只保存了旧身份 JSON 的 SHA-256，没有保存原始 JSON。原始输入已经丢失时，禁止猜测字段组合或直接覆盖指纹。`EventLedger.recover_legacy_route_identity_from_events` 是依赖外部核验的低层维护原语，不是自证身份的恢复工具。

代码会强制检查：route 仍为 active、`identity_version=1`，旧指纹与账本当前值精确相等；route 至少已有一个事件，且每个 `source_fingerprint` 都以同一个内部 username 加冒号开头；group/friend 与 `@chatroom` 格式双向一致；调用方提供非空核验证据引用、核验证据 SHA-256 和 SQLite 备份 SHA-256。身份更新、事务内返回快照和脱敏审计记录一起提交，失败全部回滚。

正式包装器仍必须先用 SQLite `backup()` 生成可校验备份，再由私有 binding、当前微信账户和联系人数据库独立确认 owner、username、chat type，并把脱敏核验报告落到私有验证目录。事件前缀只能证明账本内 username 一致，不能证明 owner 或 chat type。此方法不会自动 quarantine，也不会修改事件、delivery、wake 或 ACK，不是 Agent 可调用的 MCP 工具。

### 6.4 恢复

```powershell
# 停止服务
# 用备份文件替换 events.sqlite3
# 重启服务
```

## 7. 升级回滚

### 7.1 离线演练

正式切换前必须使用独立目录运行 `Drill`。它复用生产切换和回滚函数，但健康检查使用本地 fixture，不访问或修改正式 service、data、broker：

```powershell
& .\ops\manage-wechat-docs-release.ps1 `
  -Action Drill `
  -DrillRoot <disposable_absolute_path> `
  -CandidateManifestPath <candidate_release>\service-manifest.json `
  -ProbePython <python.exe> `
  -TimeoutSeconds 5
```

`READY_FOR_ACTIVATION` 只有在以下项目全部成立时返回：

- 候选 Python 能从最终 release 路径导入项目，工具数与预期一致；
- `validation` 缺失、为 `null`、`activeBackend` 为 `null` 三种旧 manifest 均能升级；
- Junction 切到候选后，`activeBackend`、backend generation 和 Supervisor 状态一致；
- 账本 schema version、事件、subscription、pending delivery、wake 和 active wake 计数不变；
- 受保护 endpoint 的 broker PID、backend PID 和 generation 均未改变；
- 每个成功案例主动回滚并再次通过健康检查；
- 强制健康失败会自动回滚，active 与 last-known-good 恢复旧 release。

演练目录不会自动删除，其中 `drill-summary.json`、`activation-verification.json` 和 `rollback-verification.json` 是验收证据。

### 7.2 正式激活

`Activate` 默认硬拒绝，必须同时提供预期旧 release、候选 release、私有 route 和显式确认开关：

```powershell
& .\ops\manage-wechat-docs-release.ps1 `
  -Action Activate `
  -ServiceRoot <service_root> `
  -DataRoot <data_root> `
  -BrokerRoot <broker_root> `
  -CandidateReleaseId <candidate_release_id> `
  -ExpectedCurrentReleaseId <current_release_id> `
  -RouteId <private_route_id> `
  -ConfirmProductionActivation
```

脚本只做 endpoint-scoped reload，不重启整个 broker。候选健康、账本快照、受保护 endpoint 和 Supervisor 全部通过后，才更新 active/candidate/last-known-good 与 manifest；每个 JSON 文件使用临时文件原子替换，跨文件一致性由失败回滚保障。缺少 `-ConfirmProductionActivation` 时，在创建目录或 Junction 前即终止。

### 7.3 自动回滚

切换后的任何异常都会执行同一回滚函数：恢复旧 Junction、pointer、私有运行配置、broker 私有环境和候选 manifest，随后 scoped reload 旧后端并再次核对健康与账本。只有 `rollback-verification.json` 中 `verified=true` 才会报告“失败后已验证回滚”。

schema v2 首次启动会先备份再迁移旧账本。若迁移后已经产生多 subscription 的独立新 delivery，旧 V1 代码无法表达这些差异；此时不能只切回旧 release 并宣称数据语义已回滚。应保留现场，使用迁移前 SQLite backup 恢复到独立副本核验，再决定恢复窗口。

账本检查由 `ops/release_probe.py` 完成。PowerShell 只传文件路径和 route 参数，不再使用内嵌 `python -c`，避免 Windows 多层引号和换行转义改变代码。

### 7.4 手动恢复

如果自动回滚本身无法完成，应保留 `current.failed-*`、`current.before-*` 和 `backups/release-switch-*`，停止继续切换。先把 `current.before-*` 恢复为 `current`，再恢复同一 backup 目录内的 pointer 与私有配置，最后只重载 `wechat-docs` backend。不要删除或替换 `events.sqlite3` 来掩盖 release 状态错误。

## 8. 常见配置问题

### 8.1 `WECHAT_ENCRYPTED_DB_DIR` 未设置

`ENCRYPTED_DB_DIR` 为 `None`，`watcher()` 返回 `None`，`watcher_ready=false`，`encrypted_db_configured=false`。

解决：设置环境变量指向微信 `db_storage` 目录。

### 8.2 `zstandard` 未安装

压缩消息内容返回空字符串，不崩溃但消息内容丢失。

解决：`pip install zstandard`

### 8.3 密钥提取工具不存在

`refresh_keys()` 返回 `False`，`watch_once` 报不含工具输出或凭据的具体类别，例如 `key extraction failed: tool unavailable`、`timeout` 或非零退出码。

解决：确认 `WECHAT_KEY_TOOL` 路径正确，工具文件存在。

### 8.4 binding.json 不存在

`_load_bindings()` 返回空列表，`watcher()` 返回 `None`。

解决：创建 `config/binding.json`，参考 `binding.example.json`。
