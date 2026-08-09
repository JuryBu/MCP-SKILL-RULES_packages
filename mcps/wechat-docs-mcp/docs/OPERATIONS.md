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
| `WECHAT_DOCS_MCP_WAKE_ENABLED` | `0` | 将 prepared wake 提交给 Codex 透明代理 |
| `CODEX_WAKE_PROXY_RUNTIME_FILE` | (无) | 透明代理运行状态文件 |
| `CODEX_WAKE_PROXY_TOKEN_FILE` | (无) | 透明代理控制 token 文件 |

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
│       └── wcdb_key_tool_windows.py  # 密钥提取工具
├── state/
│   └── events.sqlite3        # 权威事件账本
└── secrets/
    └── tencent-docs-mcp.token
```

### 2.3 binding.json 格式

```json
{
  "routes": [
    {
      "route_id": "route-friend-xxx",
      "exact_title": "张三",
      "chat_type": "friend",
      "username": "wxid_abc123",
      "conversation_id": "receiver-owned-codex-thread",
      "generation": 1
    },
    {
      "route_id": "route-group-xxx",
      "exact_title": "工作群",
      "chat_type": "group",
      "username": "12345678@chatroom",
      "conversation_id": "receiver-owned-codex-thread",
      "generation": 1
    }
  ]
}
```

参考 `binding.example.json` 获取模板。

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

应看到 50 项全部通过、零警告。

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
| `watcher_ready` | DbWatcher 实例已创建 |
| `background_polling` | 后台轮询线程是否活跃 |
| `poll_last_error` | 后台轮询最后一次错误信息 |
| `poll_last_error_time` | 错误发生时间 |
| `poll_consecutive_failures` | 连续失败次数 |
| `wake_notifier_enabled` | 是否启用 Codex wake 提交 |
| `wake_notifier_ready` | 代理 runtime、token 与回环地址是否就绪 |
| `wake_notifier_error` | 最近一次 wake 提交错误码，不含消息正文或 token |
| `wake_last_attempt_time` | 最近一次提交尝试时间 |

### 5.1 健康判断

- **就绪**：`encrypted_db_configured` + `watcher_ready` + `route_count > 0`
- **后台运行中**：`background_polling` = true
- **后台异常**：`poll_consecutive_failures` > 0 且 `poll_last_error` 非空

## 6. 备份与恢复

### 6.1 迁移脚本备份

`migrate_baselines.py` 使用 SQLite 原生 `backup()` API 创建时间戳备份：

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

### 6.3 恢复

```powershell
# 停止服务
# 用备份文件替换 events.sqlite3
# 重启服务
```

## 7. 升级回滚

### 7.1 升级流程

1. 停止后台轮询：`wechat_poll_stop()`
2. 备份账本：运行 `migrate_baselines` 或手动 `backup()`
3. 更新代码：`git pull` 或覆盖源码
4. 安装依赖：`pip install -e .`
5. 运行测试：`pytest tests/ -v`
6. 启动服务

### 7.2 回滚

1. 停止服务
2. 恢复备份的 `events.sqlite3`
3. 恢复旧代码
4. 启动服务

## 8. 常见配置问题

### 8.1 `WECHAT_ENCRYPTED_DB_DIR` 未设置

`ENCRYPTED_DB_DIR` 为 `None`，`watcher()` 返回 `None`，`watcher_ready=false`，`encrypted_db_configured=false`。

解决：设置环境变量指向微信 `db_storage` 目录。

### 8.2 `zstandard` 未安装

压缩消息内容返回空字符串，不崩溃但消息内容丢失。

解决：`pip install zstandard`

### 8.3 密钥提取工具不存在

`refresh_keys()` 返回 `False`，`watch_once` 报 `"Key extraction failed"`。

解决：确认 `WECHAT_KEY_TOOL` 路径正确，工具文件存在。

### 8.4 binding.json 不存在

`_load_bindings()` 返回空列表，`watcher()` 返回 `None`。

解决：创建 `config/binding.json`，参考 `binding.example.json`。
