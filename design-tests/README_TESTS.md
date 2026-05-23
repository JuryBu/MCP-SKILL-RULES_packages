# Design Tests

这些文件用于安装后 smoke test。

## Files

- `sample-long-page.html`：测试网页正文提取、截图和摘要。
- `sample-overlap.html`：测试 `web_inspect` 是否能发现重叠和溢出。
- `sample-memory-workspace/README.md`：给 memory-store 测试用的普通工作区样例。
- `smoke-mcp-http.mjs`：用 HTTP 初始化 MCP endpoint 并尝试列工具。
- `expected-smoke-results.md`：预期结果说明。

默认 smoke test 只测三大核心 MCP。若接收方已经配置 EXA_MCP_REMOTE_URL，可额外设置 CODEX_TOOLKIT_SMOKE_OPTIONAL=1 后测试 exa endpoint。

