# Expected Smoke Results

## Package-clean

- 输出 `Portable skills verified: 16`。
- 输出 `Portable toolkit package-clean check completed.`。
- 不报告绝对用户路径、凭据、SQLite、日志、profile、session、node_modules 或 dist。

## Broker And MCP

- `/health` 返回 broker PID 与 endpoint 列表。
- memory-store、web-fetcher、sandbox 均可 initialize。
- 每个核心 endpoint 的 `tools/list` 至少返回一个工具。
- `-IncludeOptionalEndpoints` 下，Playwright 与 sequential-thinking 可 initialize；只有配置 Exa remote URL 时才测试 Exa。
- 长任务参数 `waitSeconds` / `timeout` 不应被 broker 的 120 秒普通调用上限提前截断，默认总上限为 30 分钟。

## Functional Fixtures

- memory-store 可在空数据根中写入和查询测试记忆，不依赖 Antigravity 数据目录。
- `sample-long-page.html` 可被 web-fetcher 读取并截图。
- `sample-overlap.html` 的视觉检查应报告 overlap、overflow 或 readability 问题。
- sandbox 可执行短代码，smart search 可完成 exact 模式；模型语义搜索只在接收方已配置对应 modelChain 时测试。
- Grok Council 只在接收方 ProGrok proxy 可用时测试，公开包不保证特定模型名或账户额度。

## Troubleshooting

1. 确认 Node.js 18 或更高版本。
2. 运行 `install/Install-CodexToolkit.ps1` 构建源码。
3. 检查端口 14588 是否被占用。
4. 查看 `install/Status-CodexMcpBroker.ps1` 输出。
5. 确认接收方私有 env 已在启动 broker 的同一环境中加载。
6. 重启对应宿主，使其重新读取 MCP 配置与 Rules。
