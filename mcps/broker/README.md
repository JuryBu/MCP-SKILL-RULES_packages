# Portable HTTP MCP Broker

This broker exposes the package MCP servers as Streamable HTTP endpoints for Codex, Claude Code, and other compatible hosts.

Default endpoints:

- `/memory-store/mcp`
- `/web-fetcher/mcp`
- `/sandbox/mcp`
- `/exa/mcp` optional, requires `EXA_MCP_REMOTE_URL` or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`
- `/playwright/mcp` optional via `npx @playwright/mcp@latest`
- `/sequential-thinking/mcp` optional via `npx @modelcontextprotocol/server-sequential-thinking`

Use the scripts in `install/` from the package root:

```powershell
./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
./install/Stop-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
```

The broker reads MCP source from `CODEX_TOOLKIT_MCP_ROOT` or `../` relative to this folder. Runtime logs/state are written under `CODEX_TOOLKIT_DATA_ROOT\mcp-http-broker` when started through the package scripts.

Do not package local logs, pid files, private env files, browser profiles, API keys, session data, or SQLite databases.
