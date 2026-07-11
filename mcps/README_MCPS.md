# MCP Notes

## Components

### memory-store 1.19.3

Shared memory, Conversation reading/export, Record management, Golden Extract, Stage Guard, ownership repair, trajectories, smart search, background recovery, and stable task status.

Data routes: `auto | antigravity | codex | claude-code | cc | windsurf | wsf`.

Model routes: `auto | antigravity | codex | claude-code | cc | grok`.

`chain="windsurf"` is a compatibility shortcut for data only. `chain="grok"` is a compatibility shortcut for model execution only.

### sandbox 1.15.1

Short execution, parallel batch, persistent session, long-running launch, Codex task execution, smart search, and multi-model Council. Grok Council uses a receiver-managed ProGrok OpenAI-compatible endpoint and supports image input when the selected model supports vision.

Council runs now use manifest-governed artifact directories for transcripts, indexes, and large inputs. `sandbox_status(action="gc", gcScope="council")` defaults to a dry run and supports guarded apply, restore, and purge flows. Active, referenced, preserved, or malformed runs are retained and reported instead of being deleted blindly. Runtime paths follow `SANDBOX_DATA_ROOT`; the portable package never treats its source directory as persistent data storage.

The Antigravity CLI (`agy`) provider and file indexer share a cross-worker lease pool. Proxy inheritance is scoped to child processes, terminal failures stop pointless retries, and cancellation propagates through foreground and background Council work.

The portable build does not start or patch ProGrok.

### web-fetcher 7.0.0

Headless web access, authenticated browser profiles, local multi-format documents, screenshots, visual inspection, persistent sessions, interaction pipelines, downloads, conversion, video recording, and desktop application helpers.

### broker 0.1.0

Streamable HTTP bridge exposing memory-store, web-fetcher, sandbox, Playwright, sequential-thinking, optional Exa, and optional Windsurf subagent endpoints. Long calls inherit `waitSeconds` / `timeout` with a configurable cap.

### mcp-subagent 1.1.0

Optional Windsurf Cascade-only async subagent controller. It is not a shared four-host MCP and must not be presented as a Codex, Antigravity, or Claude Code native subagent service.

## Portable Data

Default root:

```text
%USERPROFILE%/.codex-toolkit/
```

Main overrides:

- `CODEX_TOOLKIT_DATA_ROOT`
- `CODEX_TOOLKIT_MCP_ROOT`
- `MEMORY_STORE_DATA_ROOT`
- `SANDBOX_DATA_ROOT`
- `WEB_FETCHER_PROFILE_BASE_DIR`（旧名 `WEB_FETCHER_PROFILES_DIR` 仍兼容）
- `ANTIGRAVITY_CONVERSATIONS_DIR`
- `CLAUDE_CODE_CONVERSATIONS_DIR`
- `WSF_CASCADE_ENDPOINT`

## Optional Model / Search Services

- ProGrok: `MEMORY_STORE_GROK_PROXY_URL`, `MEMORY_STORE_GROK_API_KEY`, `SANDBOX_PROGROK_BASE_URL`, `SANDBOX_PROGROK_API_KEY`
- Exa: `EXA_MCP_REMOTE_URL` or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`

Real values belong in the receiver's private environment, never in source or zip files.
