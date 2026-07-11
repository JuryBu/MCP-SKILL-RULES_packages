# mcp-subagent 1.1.0

`mcp-subagent` 是一个 **仅供 Windsurf 使用的可选 MCP 服务**。它通过 Windsurf 本机 Language Server 的 Cascade 接口创建、轮询、回收子对话，提供 `subagent_spawn`、`subagent_poll`、`subagent_collect`、`subagent_interrupt` 与 `subagent_dispose` 等工具。

它不是通用子代理实现，也不提供 Codex、Claude 或 Antigravity 的原生集成。其他客户端即使能读取此目录，也不应将其视为受支持的安装或运行方式。

## 运行边界

- 仅支持 Windows 上已登录且正在运行的 Windsurf。
- 子对话必须属于当前 Windsurf Cascade 谱系；`main_id` 不是任意字符串。
- 服务只访问本机 Windsurf Language Server，并从本地 Windsurf 凭据存储中读取认证信息。
- `subagent-data/` 保存 registry、审计和归档，属于运行时数据，不应提交或分发。
- 安装、回滚和检查脚本只会处理 Windsurf MCP 配置，不修改任何其他客户端或共享 broker。

## 前置条件

- Node.js 18 或更高版本
- Python（认证辅助程序通过 `python` 命令启动）
- Windsurf 已登录并至少打开一个 Cascade 对话

安装依赖：

```powershell
npm ci
```

基础语法检查：

```powershell
npm run build
```

## Windsurf 配置

先执行只读预览：

```powershell
npm run install:config
```

确认输出无误后，才写入 Windsurf 配置：

```powershell
npm run install:config -- --apply
```

默认写入位置由 `USERPROFILE` 推导为 `%USERPROFILE%\.codeium\windsurf\mcp_config.json`。脚本会先创建同目录的 `.before-subagent-<timestamp>` 备份，再原子替换配置文件。

恢复最近一次备份：

```powershell
npm run rollback:config -- --apply
```

检查当前 Windsurf 条目：

```powershell
npm run check:live-config
```

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WSF_CONFIG` | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | Windsurf MCP 配置文件路径 |
| `WSF_SUBAGENT_KEY` | `subagent` | MCP 服务键名 |
| `SUBAGENT_DATA_DIR` | `%USERPROFILE%\.codex-toolkit\subagent-data` | registry、审计和归档目录，必须放在包外 |
| `WSF_CASCADE_HOST` | `127.0.0.1` | Windsurf Language Server 主机 |
| `WSF_CASCADE_ENDPOINT` | 未设置 | 完整 Cascade HTTP 基地址，可使用 `{port}` 占位符 |
| `SUBAGENT_CLEANUP_INTERVAL_SEC` | `3600` | 清理检查间隔（秒） |
| `SUBAGENT_IDLE_TTL_SEC` | `86400` | 已完成任务的空闲保留时间（秒） |

`WSF_CASCADE_ENDPOINT` 优先于 `WSF_CASCADE_HOST`，例如 `http://127.0.0.1:{port}`。默认端口仍由 Windsurf 进程发现逻辑获取，不需要写死本机端口。

## 工具概览

| 工具 | 作用 |
| --- | --- |
| `subagent_current` | 列出可用的真实 Cascade 主对话候选 |
| `subagent_models` | 查看当前 Windsurf 缓存中的模型候选 |
| `subagent_spawn` | 创建子代理任务 |
| `subagent_poll` / `subagent_wait` | 读取任务状态或短等待完成 |
| `subagent_reply` | 继续同一子对话 |
| `subagent_collect` | 将结果回插主对话 |
| `subagent_interrupt` | 请求中断正在运行的任务 |
| `subagent_list` / `subagent_reconcile` | 检查 registry 与 Language Server 状态 |
| `subagent_dispose` / `subagent_cleanup` | 显式归档、删除或按 TTL 清理完成任务 |

`subagent_spawn` 默认启用 `auto_collect`。测试或手动编排时可传 `auto_collect: false`，再使用 `subagent_collect` 明确决定何时回插结果。

## 安全注意事项

- 不要提交 `subagent-data/`、日志、备份文件或本机 MCP 配置。
- 不要把认证辅助程序输出、Language Server 响应或审计内容贴入公开 issue。
- `subagent_dispose({ mode: "delete" })` 会删除对应 Cascade 任务；先用 `archive` 保留证据。
- 本包不包含跨客户端 broker 修补、交接打包或硬编码仓库同步脚本。

## 验证建议

```powershell
npm run build
npm run test:auth
npm run smoke:ls
```

后两项会访问本机 Windsurf 凭据和 Language Server，应只在拥有对应账号与会话的机器上执行。
