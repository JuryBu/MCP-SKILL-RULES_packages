# NapCat MCP + Broker + Codex Desktop 首次接入

这份说明面向第一次拿到本仓库的接收方，目标是把四层组件接成一条可验证的链路：

```text
Codex Desktop
  ├─ HTTP MCP -> 127.0.0.1:14588/napcat/mcp -> 共享 Broker -> NapCat MCP backend -> OneBot
  └─ WebSocket -> App Server 透明代理 -> 官方 Codex App Server
                                      └─ task router 注入原生未读提醒
```

Broker 负责让 Codex 稳定连接多个 MCP；NapCat MCP 负责固定群、任务账本和精确 ACK；App Server 透明代理只负责把已登记任务的提醒实时放进目标 Codex 对话。只配置 MCP URL 可以调用 QQ 工具，但不会自动得到原生侧边栏未读提醒。

## 1. 安装边界

公开仓库只提供源码、脚本、空白模板和测试。接收方仍需自行准备：

- Windows、PowerShell、Node.js 18 或更高版本
- 已安装并登录的 NapCat / QQ，以及仅监听本机回环地址的 OneBot HTTP 服务
- 接收方自己的群、账号、可信对端与 token
- 一个不会被随意移动的仓库目录；登录计划任务和 App Server 代理会记录绝对路径

真实 token、QQ 登录态、二维码、`binding.json`、任务账本和运行日志都留在接收方机器，不得提交或打包。

## 2. 在仓库根目录准备源码

以下命令都在仓库根目录执行：

```powershell
$repoRoot = (Resolve-Path ".").Path
$brokerRoot = Join-Path $repoRoot "mcps\broker"
$napcatSourceRoot = Join-Path $repoRoot "mcps\napcat-mcp"
$napcatCodeRoot = Join-Path $env:USERPROFILE ".codex\services\napcat-bridge\current"
$napcatDataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()

./install/Test-CodexToolkit.ps1 -PackageClean
./install/Install-CodexToolkit.ps1 -IncludeNapCat
```

第一条检查公开包里没有私密运行文件；第二条为 Broker 和各 MCP 安装依赖，并对 NapCat 执行语法检查和完整测试。此时还没有修改生产任务或 Codex 配置。

## 3. 创建私有固定群绑定

```powershell
New-Item -ItemType Directory -Force $napcatDataRoot | Out-Null
$bindingPath = Join-Path $napcatDataRoot "binding.json"
Copy-Item (Join-Path $napcatSourceRoot "binding.example.json") $bindingPath
notepad $bindingPath
```

把示例中的账号、群名、成员数、机器角色和可信对端全部替换成接收方真实值。不要只改群号；状态检查会同时核对当前账号、群名和成员数，任一不符都应拒绝读写。

## 4. 在同一个 PowerShell 会话中启动 Broker

首次启动前创建被 Git 忽略的 `mcps\broker\broker-private.env.json`。这个文件属于当前接收方，不能复制别人的账号、令牌或绑定：

```powershell
$tokenBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
$privateEnv = [ordered]@{
  CODEX_TOOLKIT_ENABLE_NAPCAT_MCP = "1"
  NAPCAT_MCP_ROOT = $napcatSourceRoot
  CODEX_TOOLKIT_NAPCAT_DATA_ROOT = $napcatDataRoot
  NAPCAT_MCP_BINDING_PATH = $bindingPath
  NAPCAT_HTTP_URL = "http://127.0.0.1:3010"
  NAPCAT_ACCESS_TOKEN = Read-Host "OneBot access token"
  CODEX_MCP_BROKER_CONTROL_TOKEN = [Convert]::ToBase64String($tokenBytes)
}
$privateEnvPath = Join-Path $brokerRoot "broker-private.env.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($privateEnvPath, ($privateEnv | ConvertTo-Json), $utf8NoBom)

./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
Invoke-RestMethod "http://127.0.0.1:14588/health?endpoint=napcat&deep=1"
```

必须在启动 Broker 前把 `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1` 写入该私有文件，否则 Broker 不会暴露 `/napcat/mcp`。Shell 环境变量仍可临时覆盖同名 JSON 值；后续正常启动直接读取这个文件。更新器只补齐和维护 NapCat 的代码、数据、绑定与控制状态路径，不负责凭空生成 OneBot 令牌。

## 5. 安装 NapCat bridge 与 App Server 透明代理

```powershell
./mcps/napcat-mcp/ops/update-codex-napcat-bridge.ps1 `
  -BrokerRoot $brokerRoot `
  -CodeRoot $napcatCodeRoot `
  -DataRoot $napcatDataRoot `
  -SourceCommit $sourceCommit `
  -MigrateAutostart
```

这里的 `-BrokerRoot` 必须与第 4 步实际启动的 Broker 根目录一致。源码模式就是仓库里的 `mcps\broker`；已有受管安装可以依赖有效的 `service-manifest.json`；平铺安装则显式传平铺 Broker 根目录。不要让 updater 写一套私有环境，而运行中的 Broker 从另一目录读取。

更新器会在隔离候选目录中再次执行依赖安装、语法检查和完整测试，通过后才备份、写入代码，并合并私有文件中的受管 NapCat 路径。输出中只有 `activated=true` 且 `pendingActivation=false` 才表示已生效；`pendingActivation=true` 只表示候选已暂存，不能当作安装完成。

## 6. 让 Codex 连接 NapCat endpoint

```powershell
./install/Apply-CodexConfig.ps1 -IncludeNapCat
```

脚本会备份 `%USERPROFILE%\.codex\config.toml`，保留其它私有配置，并只启用：

```toml
[mcp_servers.napcat]
url = "http://127.0.0.1:14588/napcat/mcp"
enabled = true
```

如果配置文件已经手工定义同名表，脚本会在写入前拒绝，要求先人工合并，避免生成重复 TOML 表。

## 7. 正常退出并重新打开 Codex

首次启用透明代理后，完整退出 Codex Desktop，等待约 10 秒，再按原方式打开 Codex。通常不需要重启 Windows。这样新进程才能同时读取：

- `config.toml` 中的 NapCat MCP endpoint
- 用户级 `CODEX_APP_SERVER_WS_URL` 透明代理地址

如果 updater 输出 `restartCodexRequired=true`，就必须完成这一步；重新打开后该字段应归零。

## 8. 验证运行链路

```powershell
./install/Status-CodexMcpBroker.ps1
./mcps/napcat-mcp/ops/get-codex-app-server-proxy-status.ps1 -DataRoot $napcatDataRoot
./mcps/napcat-mcp/ops/get-napcat-supervisor-status.ps1 -DataRoot $napcatDataRoot
./mcps/napcat-mcp/ops/get-napcat-task-router-status.ps1 -DataRoot $napcatDataRoot
Invoke-RestMethod "http://127.0.0.1:14588/health?endpoint=napcat&deep=1"
```

验收时至少确认：Broker 与 NapCat backend 深层健康、NapCat 工具列表可见、代理和监督器在运行、router 扫描时间持续推进、没有 `task-router.stop` 或维护残留。尚未登记 open task 时 router 可以保持待命，但不能把“没有 task”误报成 endpoint 故障。

然后使用独立测试对话和测试 `task_id` 做一次双向真实验证：目标对话未打开时出现原生未读标记，消息只出现一次，实际处理后用提示中的 generation、`wake_id` 和精确 `processed_message_seqs` ACK。不要拿生产 task 做首次试验。

## 9. 后续更新怎么选

| 变化范围 | 推荐方式 | 是否退出 Codex |
| --- | --- | --- |
| 仅 NapCat backend、账本、router 或 supervisor | `-BackendOnlyHotReload -PreserveActiveWakes` | 通常不需要 |
| App Server 代理源码或代理启停脚本变化 | 完整受保护更新 | 需要正常退出并重新打开 |
| 共享 Broker 本体变化 | 先验证候选，再用 `Update-CodexMcpBroker.ps1` | 通常不需要退出 Codex，但会短暂重启 Broker |
| 只改 `config.toml` 的 endpoint 开关 | `Apply-CodexConfig.ps1` | 需要重新打开 Codex |

实现、完整测试、打包和影子验证应在隔离环境完成；生产切换只执行已验证候选、备份、短热切和健康检查。更新失败时不要删 task 或清账，使用 updater 输出的 `backupRoot` 与 `rollback-codex-napcat-bridge.ps1` 恢复。

## 10. 常见误区

- `machine_received` / `conversation_received` 只证明运输或持久化，不等于业务已经处理或 ACK。
- Broker 端口能连接不等于子 backend 健康，验收要使用 `deep=1`。
- `CodeRoot` 是可替换代码，`DataRoot` 是私有账本；绝不能用 GitHub 文件覆盖整个 DataRoot。
- 原生未读提醒依赖透明代理；只看到群消息或数据库入账不等于 App Server 注入成功。
- 不要把真实 binding、token、登录态、二维码、群文件、日志或 state 文件上传到 GitHub。

协议、任务 M:N 绑定、owner route、精确 ACK、升级保护域和故障降级细节继续查阅 `README.md`；Broker timeout、endpoint reload 与私有环境规则查阅 `../broker/README.md`。
