# Expected Smoke Results

通过时应看到：

- broker `/health` 返回 JSON。
- memory-store、web-fetcher、sandbox endpoint 可以 initialize。
- 设置 CODEX_TOOLKIT_SMOKE_OPTIONAL=1 且提供 EXA_MCP_REMOTE_URL 时，exa endpoint 也应可以 initialize。
- `tools/list` 至少返回工具数组或明确的 MCP JSON-RPC 响应。
- `sample-long-page.html` 可以被 web-fetcher 读取。
- `sample-overlap.html` 在视觉检查中应报告 overlap / overflow / readability 相关问题。

失败时优先检查：

- Node.js 是否为 18 或更高版本。
- 是否已经运行 `npm install` 和 `npm run build`。
- 端口 `14588` 是否被占用。
- Codex 是否已重启并重新读取 `config.toml`。


