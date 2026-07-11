# Design And Smoke Tests

这些文件用于接收方安装后的基础功能验证测试，也用于发布前检查工具包是否完整。

本目录是公开包的可移植验证套件。上游开发仓库的内部单元测试依赖本机 fixture、宿主运行态与私有路径，因此不会随分发包复制；三个核心 MCP 的 `npm run test:portable` 只执行 TypeScript 构建验证，HTTP 初始化、工具列表与页面样例由本目录脚本覆盖。

## Package-clean Test

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
```

检查内容：

- 五个 MCP 源码包存在且 package.json 可读。
- Codex、Antigravity、Claude Code、Windsurf Rules 结构完整。
- Windsurf 的 global rule 和五个 system rule 分片齐全。
- 16 个 Skills 均有 `SKILL.md` 且出现在 manifest。
- 四个 JSON 配置模板能解析。
- 不含绝对用户路径、credential-shaped 文本、数据库、日志、profile、session、构建产物。

## HTTP Smoke Test

`smoke-mcp-http.mjs` 通过 HTTP 完成 MCP initialize、initialized notification 和 tools/list。

默认测试：memory-store、web-fetcher、sandbox。

```powershell
./install/Test-CodexToolkit.ps1
```

可选测试 Playwright、sequential-thinking 和已配置的 Exa：

```powershell
./install/Test-CodexToolkit.ps1 -IncludeOptionalEndpoints
```

Windsurf subagent 不进入通用 smoke，因为真实调用需要登录态并会创建 Cascade 状态。

## Local Design Fixtures

- `sample-long-page.html`：测试长页面正文提取、截图和摘要。
- `sample-overlap.html`：测试 `web_inspect` 是否能发现重叠、溢出和可读性问题。
- `sample-memory-workspace/README.md`：测试空白接收方数据根下的 memory write/query 与 workspace 归属。
- `expected-smoke-results.md`：列出通过标准和排错顺序。

## Optional Provider Checks

Grok / ProGrok 与 Exa 都需要接收方私有配置。公开测试只验证配置入口与代码路径，不携带或调用发送方凭据。
