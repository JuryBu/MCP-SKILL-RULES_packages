# 交接给 MCP 开发对话

## 1. 已验证状态（Windsurf 施工 + MCP 接管修复）

### 1.1 代码修复全部完成

| 修复项 | 状态 | 测试 |
|---|---|---|
| 连续消息缺口 (contiguous baseline) | ✅ | `test_contiguous_baseline_with_gap` |
| 入账失败不推进快照 | ✅ | `test_snapshot_not_advanced_on_all_ingestion_failure` |
| 空路径误报 (`Path("")` → `None`) | ✅ | 代码审查确认 |
| 首次启动强制刷新 | ✅ | `test_initial_scan_forces_full_cycle` |
| force_refresh 无变化不误报 | ✅ | `test_force_refresh_no_changes_does_not_report_decryption_failed` |
| wake_id 查询 (`wechat_wake_info`) | ✅ | `test_get_active_wake_returns_wake_id` |
| 并发互斥锁 | ✅ | `test_concurrent_watch_once_is_serialized` |
| 后台控制面并发锁 | ✅ | `test_concurrent_start_creates_one_poll_thread` / `test_stop_does_not_clear_replacement_thread` |
| 后台轮询错误可见性 | ✅ | `wechat_status` 字段确认 |
| subprocess UTF-8 解码 | ✅ | 零警告通过 |
| 迁移脚本 SQLite backup() | ✅ | 代码审查确认 |
| 后台停止竞态（独立 Event） | ✅ | 代码审查确认 |
| zstandard 依赖声明 | ✅ | `pyproject.toml` 确认 |
| 可见 wake 正文隔离与重试去重 | ✅ | `test_wake_notifier.py` |
| broker 深度健康 Supervisor | ✅ | `test_supervisor.py` |

### 1.2 测试结果

```
50 passed, zero warnings
```

| 文件 | 数量 |
|---|---|
| test_db_observer.py | 10 |
| test_db_watcher.py | 15 |
| test_ledger.py | 13 |
| test_server_polling.py | 4 |
| test_wake_notifier.py | 5 |
| test_supervisor.py | 3 |
| **合计** | **50** |

### 1.3 文档完成

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | 完整数据流、模块职责、架构图、表结构 |
| `docs/WECHAT_DATABASE.md` | 密钥提取、18 个 DB、Msg_MD5、zstd、消息类型 |
| `docs/EVENT_PROTOCOL.md` | route/baseline/event/wake/dedupe/ACK 语义 |
| `docs/OPERATIONS.md` | 环境配置、安装、启停、备份、健康状态 |
| `docs/TESTING_AND_TROUBLESHOOTING.md` | 50 项测试、验收步骤、常见错误、诊断顺序 |
| `docs/DECISIONS_AND_HISTORY.md` | raw-key 失败、UIA 取代、Config.Cipher 扫描 |

## 2. MCP 开发对话待完成

以下任务属于运行集成，需本地 MCP 开发维护任务接管：

### 2.1 环境配置

- [x] 版本化 Python 3.12.13 环境已安装锁定依赖
- [x] 私有运行配置已登记 `WECHAT_ENCRYPTED_DB_DIR`
- [x] 密钥提取工具已验证存在于 `private-state/tools/`
- [x] 已用 SQLite `backup()` 生成当前账本快照并通过完整性检查

### 2.2 版本化安装

- [x] 已安装到独立 release/env，不使用可变 editable 安装
- [x] `wechat-docs-mcp` 入口存在，Python 3.12.13
- [x] `wechat_status` 已在真实私有配置下返回 watcher ready、2 条 route

### 2.3 后台 Supervisor

- [x] 已实现 broker 后端自动轮询与深度健康 Supervisor
- [ ] 安装当前用户登录自启动并做崩溃恢复实测
- [ ] 配置日志轮转

### 2.4 Broker 唤醒注入

- [x] 已实现本地 wake → Codex 透明代理控制口，复用持久 `wake_id` 去重
- [x] 提醒仅含 route/generation/wake_id，不含微信消息正文
- [ ] 安装 broker 端点并用真实新微信消息验证可见注入

### 2.5 真实微信验收

- [ ] 启动后台服务
- [ ] 主人发一条新微信消息
- [ ] **不手动调用任何工具**
- [ ] 消息自动进入 Codex 对话
- [ ] ACK 后重启服务
- [ ] 旧消息不重放

### 2.6 Git 跟踪

- [x] 整个 MCP 目录已进入 Git 跟踪并形成首个可审计提交
- [x] 首个提交前已确认公开源码不含真实账号、Token、聊天内容

### 2.7 旧文档标记（已完成）

- [x] `WINDSURF_HANDOFF_20260809.md` 已添加历史归档标记
- [x] `plans/stage-2-ui-observation.md` 已添加历史归档标记
- [x] README 已更新为当前数据库解密路线

## 3. 验收标准

MCP 开发对话完成以下全部条件后，微信入站第一版正式可用：

1. **自动入账**：启动后台服务后，主人发一条新微信消息，不手动调用工具，消息自动进入账本
2. **自动通知**：新消息入账后，Codex 对话自动收到通知（broker 注入）
3. **精确 ACK**：Codex 读取事件后精确 ACK，待处理数归零，wake 关闭
4. **重启不重放**：ACK 后重启服务，旧消息不重放
5. **连续消息**：连续 3 条消息只产生 1 次 wake，3 条事件可逐项 ACK
6. **状态可见**：`wechat_status` 正确反映后台轮询状态和错误信息

## 4. 源码冻结声明

Windsurf 施工到此结束。以下文件的源码已冻结，不应再由 Windsurf 对话修改：

- `src/wechat_docs_mcp/db_watcher.py`
- `src/wechat_docs_mcp/db_observer.py`
- `src/wechat_docs_mcp/ledger.py`
- `src/wechat_docs_mcp/server.py`
- `src/wechat_docs_mcp/migrate_baselines.py`
- `tests/test_db_watcher.py`
- `tests/test_db_observer.py`
- `tests/test_ledger.py`
- `pyproject.toml`

后续修改由 MCP 开发对话负责。
