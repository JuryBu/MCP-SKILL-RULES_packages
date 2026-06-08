# Codex MCP HTTP Broker

Codex-only local daemon that exposes shared Antigravity MCP servers through Streamable HTTP endpoints.

Endpoints:

- `http://127.0.0.1:14588/memory-store/mcp`
- `http://127.0.0.1:14588/web-fetcher/mcp`
- `http://127.0.0.1:14588/sandbox/mcp`
- `http://127.0.0.1:14588/playwright/mcp`
- `http://127.0.0.1:14588/sequential-thinking/mcp`

The daemon keeps Codex config stable with `url` transports while it manages backend stdio MCP child processes internally.

Antigravity-side MCP source, config, and data paths are not modified.

Shared backend semantics:

- Each endpoint has one shared backend MCP process for all Codex frontend sessions.
- This prevents per-conversation wrapper process growth.
- Tools that infer the current Codex conversation from backend process state are unsafe without an explicit conversation id.

Codex hard guards for `memory-store`:

- `conversation_read_original` actions other than `list` require `conversationId`, except explicit `action="export"` batch exports with `exportBatch=true` / `dataChains` / `workspaces`.
- `conversation_golden_extract` always requires `conversationId`.
- `record_manage action=update` always requires `conversationId`.
- `stage_guard` always requires `conversationId`.
- These guards apply regardless of `chain`, `dataChain`, or `modelChain`, because the HTTP backend is shared and cannot infer the active Codex conversation.
- `record_manage action=batch_update|batch_delete` is blocked from Codex because it is a global shared-backend task.
- `record_manage action=delete` without `conversationId` is blocked from Codex.

Commands:

- Start: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Start-CodexMcpBroker.ps1`
- Status: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Status-CodexMcpBroker.ps1`
- Health check: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Test-CodexMcpBrokerHealth.ps1`
- Stop orphan backend processes only: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Test-CodexMcpBrokerHealth.ps1 -Fix`
- Full broker reset: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Test-CodexMcpBrokerHealth.ps1 -Fix -RestartBroker`
- Stop: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Stop-CodexMcpBroker.ps1`
- Roll back Codex config: `powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.codex\mcp-http-broker\Rollback-CodexMcpBrokerConfig.ps1`

Health script safety:

- Default mode is read-only: it reports broker pid/state, backend ownership, confirmed orphan backend processes, and endpoint initialize/content-type smoke checks.
- Default mode does not call `/health`, because `/health` rewrites `broker-state.json`. Pass `-RefreshState` when a fresh state snapshot is intended.
- `-Fix` only stops confirmed orphan local backend processes that are not referenced by current `broker-state.json` and whose parent process is gone.
- `-Fix` refuses to stop processes when `broker-state.json` is older than `-MaxStateAgeSeconds` unless state has been refreshed first.
- `-RestartBroker` is ignored unless `-Fix` is also supplied, because restarting broker interrupts current MCP sessions.
- Running without `-Fix` is the safe preview mode.
