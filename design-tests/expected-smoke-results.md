# Expected Smoke Results

## Package-clean

- 输出 `Portable skills verified: 17`。
- 输出 `Portable toolkit package-clean check completed.`。
- 不报告绝对用户路径、凭据、SQLite、日志、profile、session、node_modules 或 dist。

## Broker And MCP

- `/health` 返回 broker PID 与 endpoint 列表。
- memory-store、web-fetcher、sandbox 均可 initialize。
- 每个核心 endpoint 的 `tools/list` 至少返回一个工具。
- `-IncludeOptionalEndpoints` 下，Playwright 与 sequential-thinking 可 initialize；只有配置 Exa remote URL 时才测试 Exa。
- `-IncludeNapCatEndpoint` 只在接收方已经安装 NapCat、登录 QQ、提供私有 token 和绑定群后测试 `/napcat/mcp`；公开包默认不启动也不探测真实 QQ 服务。
- 长任务参数 `waitSeconds` / `timeout` 不应被 broker 的 120 秒普通调用上限提前截断，默认总上限为 30 分钟。

## Functional Fixtures

- memory-store 可在空数据根中写入和查询测试记忆，不依赖 Antigravity 数据目录。
- `sample-long-page.html` 可被 web-fetcher 读取并截图。
- `sample-overlap.html` 的视觉检查应报告 overlap、overflow 或 readability 问题。
- sandbox 可执行短代码，smart search 可完成 exact 模式；模型语义搜索只在接收方已配置对应 modelChain 时测试。
- Grok Council 只在接收方 ProGrok proxy 可用时测试，公开包不保证特定模型名或账户额度。
- `sandbox_status(action="gc", gcScope="council", gcMode="dryRun")` 只报告候选项，不改动数据；托管 Council 产物根应位于 `SANDBOX_DATA_ROOT\temp`，不应出现在工具包源码目录。
- 未设置 `SANDBOX_COUNCIL_AUTO_GC=1` 时，启动 Sandbox 不应自动执行会移动或删除持久产物的 Council GC。
- NapCat 的示例绑定必须使用假账号与假群，真实 `binding.json`、二维码、heartbeat、dedupe state 和 NapCat runtime 不得出现在源码或 zip。
- Council 的 `apply`、`restore` 与 `purge` 会改动持久数据，只在接收方理解预演结果并明确同意后测试。

## Troubleshooting

1. 确认 Node.js 18 或更高版本。
2. 运行 `install/Install-CodexToolkit.ps1` 构建源码。
3. 检查端口 14588 是否被占用。
4. 查看 `install/Status-CodexMcpBroker.ps1` 输出。
5. 确认接收方私有 env 已在启动 broker 的同一环境中加载。
6. 重启对应宿主，使其重新读取 MCP 配置与 Rules。
