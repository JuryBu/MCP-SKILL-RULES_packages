# 测试与排障

## 1. 测试概览

当前共 **41 项测试**，分布在 4 个文件中：

| 文件 | 测试数 | 覆盖范围 |
|---|---|---|
| `test_db_observer.py` | 10 | 消息轮询、基线、去重指纹、消息分类、发送者解析 |
| `test_db_watcher.py` | 15 | 文件变化检测、快照管理、入账重试、并发锁、wake 查询 |
| `test_ledger.py` | 12 | 事件去重、合并 wake、部分 ACK、草稿审批、状态迁移、路由隔离 |
| `test_server_polling.py` | 4 | 后台启动互斥、停止/启动交错、停止超时、轮询失败恢复 |

### 1.1 运行测试

```powershell
cd <project_root>
$env:PYTHONPATH="src"
python -m pytest tests/ -v
```

### 1.2 零警告要求

所有 `subprocess.run` 调用使用 `encoding="utf-8", errors="replace"`，避免 Windows GBK 解码产生后台线程异常警告。

## 2. 关键回归测试

### 2.1 连续消息缺口（阻断A修复）

**测试**：`test_contiguous_baseline_with_gap`

消息 4 成功、5 失败、6 成功时，验证基线推进到 4（不是 6），第 5 条会被重试。

```python
mock_ledger.ingest_event.side_effect = selective_ingest  # local_id=5 失败
obs, ok = watcher2.poll_and_ingest()
assert ok == False
mock_ledger.update_baseline.assert_called_once_with("route-test", 4)  # 不是 6
```

### 2.2 入账失败不推进快照（阻断B修复）

**测试**：`test_snapshot_not_advanced_on_all_ingestion_failure`

所有入账失败时，文件快照不推进，下一轮仍能检测到变化。

### 2.3 首次启动强制刷新（必做D修复）

**测试**：`test_initial_scan_forces_full_cycle`

首次 `watch_once` 强制走完整流程，不跳过解密和轮询。

### 2.4 force_refresh 无变化不误报（必修1修复）

**测试**：`test_force_refresh_no_changes_does_not_report_decryption_failed`

有快照但无文件变化时 `force_refresh=True`，不报 "Decryption failed"。

### 2.5 并发安全（必修3修复）

**测试**：`test_concurrent_watch_once_is_serialized`

两个线程并发调用 `watch_once`，验证互斥锁序列化执行。

### 2.6 Wake 查询（必修2修复）

**测试**：`test_get_active_wake_returns_wake_id` / `test_get_active_wake_returns_none_when_no_events`

入账后 `get_active_wake` 返回 wake_id，无事件时返回 None。

### 2.7 后台轮询控制面并发

**测试**：`test_concurrent_start_creates_one_poll_thread` / `test_stop_does_not_clear_replacement_thread` / `test_stop_timeout_preserves_live_thread` / `test_poll_loop_records_failure_then_recovers`

并发启动只能创建一条轮询线程；停止与新启动交错时，旧停止请求不能清空新线程引用；停止超时保留真实运行状态，后台轮询失败后成功一轮会恢复健康状态。

## 3. 真实微信验收步骤

### 3.1 前置条件

- 微信 4.1+ 已登录且运行中
- `WECHAT_ENCRYPTED_DB_DIR` 已设置
- `binding.json` 已配置至少 1 个 route
- 密钥提取工具已安装
- `zstandard` 已安装

### 3.2 验收流程

```
1. 启动 MCP 服务
2. wechat_poll_start(interval=5)  → 启动后台轮询
3. 从另一手机向授权会话发送一条测试消息
4. 等待 5-10 秒
5. wechat_events_list(route_id)   → 应看到新事件
6. wechat_wake_info(route_id)     → 应返回 wake_id
7. wechat_events_ack(route_id, gen, wake_id, [event_id])  → ACK
8. wechat_events_list(route_id)   → 待处理数应为 0
9. wechat_poll_stop()             → 停止后台轮询
10. wechat_poll_start(interval=5) → 重启
11. wechat_events_list(route_id)  → 旧消息不重放
```

### 3.3 验收通过标准

- [ ] 新消息自动入账，不需手动 `wechat_poll`
- [ ] 事件内容包含正确文字、发送者、时间
- [ ] 连续 3 条消息只产生 1 次 wake
- [ ] 逐条 ACK 后 wake 关闭
- [ ] 重启服务后旧消息不重放
- [ ] 后台轮询状态在 `wechat_status` 中可见

## 4. 常见错误

### 4.1 "Key extraction failed"

**原因**：密钥提取工具不存在或执行失败
**排查**：
1. 检查 `WECHAT_KEY_TOOL` 路径是否正确
2. 确认微信进程正在运行
3. 手动运行 `python <tool_path> extract --db-dir <dir> --output <file>` 查看错误

### 4.2 "Decryption failed"

**原因**：解密工具执行失败，可能密钥过期
**排查**：
1. 确认密钥文件存在且非空
2. 微信重启后密钥可能变化，等下次 `refresh_keys` 自动更新
3. 手动运行 `python <tool_path> decrypt --db-dir <dir> --keys <file> --output <dir>`

### 4.3 "Ingestion failed for some messages"

**原因**：部分消息入账失败（如数据库锁竞争）
**行为**：文件快照不推进，下一轮自动重试
**排查**：
1. 检查 `poll_last_error` 和 `poll_consecutive_failures`
2. 如果持续失败，检查 SQLite WAL 文件权限

### 4.4 "ROUTE_NOT_ACTIVE"

**原因**：route 状态不是 `active`
**排查**：检查 `binding.json` 中的 route 是否已注册并激活

### 4.5 "STALE_WAKE" / "STALE_GENERATION"

**原因**：ACK 时提供的 `wake_id` 或 `generation` 不匹配
**排查**：先调用 `wechat_wake_info(route_id)` 获取当前值

### 4.6 后台线程无法停止

**原因**：单次 `watch_once` 执行时间超过 `timeout`
**行为**：`wechat_poll_stop` 返回 `{"status": "stopping", "alive": true}`
**解决**：再次调用 `wechat_poll_stop(timeout=120)` 增加等待时间

## 5. 诊断顺序

遇到问题时按此顺序排查：

1. **`wechat_status()`** — 检查整体状态
   - `encrypted_db_configured` = false → 设置环境变量
   - `watcher_ready` = false → 检查 binding.json 和解密目录
   - `poll_consecutive_failures` > 0 → 查看具体错误

2. **`wechat_poll(force_refresh=True)`** — 手动触发一次完整轮询
   - 查看返回的 `error` 字段
   - 查看哪些文件变化了

3. **手动运行密钥工具** — 确认工具可用
   ```powershell
   python <tool_path> extract --db-dir <dir> --output <file>
   python <tool_path> decrypt --db-dir <dir> --keys <file> --output <dir>
   ```

4. **检查解密后的数据库** — 确认数据可读
   ```powershell
   sqlite3 <decrypted_dir>/message/message_0.db "SELECT COUNT(*) FROM Name2Id"
   ```

5. **检查账本** — 确认事件已入账
   ```python
   ledger.list_pending("route-xxx")
   ```

## 6. 测试数据构造

测试使用 `_make_encrypted_tree()` 和 `_make_decrypted_tree()` 创建最小化的测试数据库：

- 加密目录：只有 `message/message_0.db`（假数据）
- 解密目录：有完整的 `message_0.db`（含 `Name2Id` 和 `Msg_<md5>` 表）和 `contact.db`
- 测试消息：`local_id=1, sender=wxid_test, content="hello"`

`_insert_msg()` 辅助函数可向测试 DB 插入额外消息行。
