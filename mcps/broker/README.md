# Codex MCP HTTP Broker

Portable local daemon, primarily used by Codex, that exposes shared MCP servers through Streamable HTTP endpoints. Other hosts may reuse the same HTTP endpoints when their MCP client supports Streamable HTTP.

Endpoints:

- `http://127.0.0.1:14588/memory-store/mcp`
- `http://127.0.0.1:14588/web-fetcher/mcp`
- `http://127.0.0.1:14588/sandbox/mcp`
- `http://127.0.0.1:14588/playwright/mcp`
- `http://127.0.0.1:14588/sequential-thinking/mcp`
- `http://127.0.0.1:14588/exa/mcp` (optional remote URL)
- `http://127.0.0.1:14588/subagent/mcp` (Windsurf-only backend)
- `http://127.0.0.1:14588/napcat/mcp` (optional; disabled by default)

The daemon keeps Codex config stable with `url` transports while it manages backend stdio MCP child processes internally.

The broker resolves bundled MCP packages from `CODEX_TOOLKIT_MCP_ROOT` (or the adjacent `mcps` directory) and stores data beneath `CODEX_TOOLKIT_DATA_ROOT` (or `~/.codex-toolkit`). It does not depend on a user-specific home-directory layout.

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

Call timeout behavior:

- Ordinary tool calls keep the `CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS` limit, which defaults to `120000` ms.
- Calls whose arguments contain `waitSeconds > 0` receive `max(waitSeconds * 1000 + 15000, request timeout)`, capped by `CODEX_MCP_BROKER_WAIT_TIMEOUT_MS`.
- Calls whose arguments contain `timeout > request timeout` receive `timeout + 15000` ms, capped by the same wait limit.
- `CODEX_MCP_BROKER_WAIT_TIMEOUT_MS` defaults to `1800000` ms (30 minutes). Invalid timeout variables fall back to defaults, and the cap is never lower than the ordinary request timeout.
- Timeout selection is argument-based, so it works for any compatible tool without hard-coding tool names. Endpoint `tools/list` calls keep their own short timeout.

Exa stateless bridge:

- `/exa/mcp` starts `exa-stateless-stdio.mjs`, a small stdio MCP bridge that forwards calls to `EXA_MCP_REMOTE_URL` (or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`).
- The bridge uses the MCP SDK bundled with the portable `memory-store` package, returns a local fallback tool list when remote listing is disabled or unavailable, and retries transient network failures within its configured request deadline.
- Configure optional behavior with `EXA_STATELESS_LIST_TIMEOUT_MS`, `EXA_STATELESS_CALL_TIMEOUT_MS`, `EXA_STATELESS_MAX_ATTEMPTS`, `EXA_STATELESS_CALL_MAX_ATTEMPTS`, `EXA_STATELESS_LIST_MAX_ATTEMPTS`, `EXA_STATELESS_RETRY_DELAY_MS`, and `EXA_STATELESS_REMOTE_TOOLS_LIST=1`.

NapCat QQ group bridge:

- `/napcat/mcp` is added only when `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP=1`; the source package remains inert otherwise.
- The receiver must install NapCat separately, provide a loopback `NAPCAT_HTTP_URL`, keep `NAPCAT_ACCESS_TOKEN` private, and place a receiver-owned fixed-group binding below `%USERPROFILE%\.codex-toolkit\napcat-mcp` or set `NAPCAT_MCP_BINDING_PATH` explicitly.
- The broker never bundles QQ login state, a real binding, heartbeat state, QR codes, or NapCat binaries. See `../napcat-mcp/README.md`.

Local secrets:

- The broker and Exa bridge may optionally load `broker-private.env.json` from this directory when it exists. Environment variables supplied by the shell always win.
- This file is for local credentials and endpoints only. It is ignored by Git and must never be committed. Do not copy a private file from another installation.

Commands:

- From each sibling MCP source package, install its declared dependencies before starting the broker. In particular, the Exa bridge loads `../memory-store/node_modules/@modelcontextprotocol/sdk`; run `npm install` in `../memory-store` first, then start this package with `npm start`. Direct startup stores logs and broker state under `%USERPROFILE%\.codex-toolkit\broker` unless `CODEX_TOOLKIT_DATA_ROOT`, `CODEX_MCP_BROKER_LOG`, or `CODEX_MCP_BROKER_STATE` overrides it.
- Syntax validation for both entry points: `npm run check`
- The `npm run health` alias intentionally runs that static validation. This package does not ship the private PowerShell health scripts.

Shutdown behavior:

- `SIGINT`, `SIGTERM`, and Windows `SIGBREAK` close backend sessions before exit. A best-effort state snapshot is also attempted during shutdown, server close, forced shutdown timeout, and Node's `beforeExit` event.
- Runtime files such as logs, broker state, and PID files are local-only and ignored by Git.
