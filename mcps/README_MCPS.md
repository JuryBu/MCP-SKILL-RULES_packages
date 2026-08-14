# MCP Notes

## Components

### memory-store 1.22.10

Shared memory, four-host Conversation reading/export/Recall, offline PB listing, compaction metadata, Record management, Golden Extract, Stage Guard, ownership repair, trajectories, smart search, background recovery, stable task status, source evidence, provider control and production Record scheduling.

Data routes: `auto | antigravity | codex | claude-code | cc | windsurf | wsf`.

Model routes: `auto | antigravity | codex | claude-code | cc | grok | agy`.

`chain="windsurf"` is a compatibility shortcut for data only. `chain="grok"` is a compatibility shortcut for model execution only.

### sandbox 1.17.2

Short execution, parallel batch, persistent session, long-running launch, Codex task execution, smart search, and multi-model Council. Grok Council uses a receiver-managed ProGrok OpenAI-compatible endpoint and supports image input when the selected model supports vision.

Expected scheduling memory is separate from the process-tree hard limit. Windows builds a local Job Object runner from public C# source, measures short and descendant processes, and combines physical memory, commit headroom, and pressure notifications so fitting light work can bypass a temporarily blocked heavy queue head without starving aged requests. The default 4096MB commit headroom is a heavy-work target; a separate 1536MB emergency floor lets bounded light work continue in the yellow zone without spending the final safety reserve.

The per-process-tree parameter ceiling defaults to 4096MB and is server-configurable without changing global admission or emergency reserves. Exact search streams ripgrep JSON and terminates at the global result cap; symbol indexing yields between bounded batches. Missing Windows helpers fail closed, startup errors distinguish the helper, working directory, and payload, and structured results report whether the command actually started.

Ordinary bounded stdout/stderr is returned directly without a persistent output artifact. Caller character and line budgets are independent from the hard serialized-response guard, batch tasks share one aggregate response budget, and error metadata keeps model-visible text on hosts that prefer structured results. Oversized, explicitly file-oriented, or interrupted recovery output retains a six-hour artifact; `sandbox_status overview/gc` reports retained artifact counts for receiver-side verification and expiry cleanup.

Council runs now use manifest-governed artifact directories for transcripts, indexes, and large inputs. `sandbox_status(action="gc", gcScope="council")` defaults to a dry run and supports guarded apply, restore, and purge flows. Active, referenced, preserved, or malformed runs are retained and reported instead of being deleted blindly. Runtime paths follow `SANDBOX_DATA_ROOT`; the portable package never treats its source directory as persistent data storage.

The Antigravity CLI (`agy`) provider and file indexer share a cross-worker lease pool. Proxy inheritance is scoped to child processes, terminal failures stop pointless retries, and cancellation propagates through foreground and background Council work.

The portable build does not start or patch ProGrok.

### web-fetcher 7.0.0

Headless web access, authenticated browser profiles, local multi-format documents, screenshots, visual inspection, persistent sessions, interaction pipelines, downloads, conversion, video recording, and desktop application helpers.

### broker 0.1.0

Streamable HTTP bridge exposing memory-store, web-fetcher, sandbox, Playwright, sequential-thinking, optional Exa, optional Windsurf subagent, optional NapCat, and optional WeChat Docs endpoints. Long calls inherit `waitSeconds` / `timeout` with a configurable cap.

### mcp-subagent 1.1.0

Optional Windsurf Cascade-only async subagent controller. It is not a shared four-host MCP and must not be presented as a Codex, Antigravity, or Claude Code native subagent service.

### napcat-mcp 0.3.14

Optional fixed-QQ-group collaboration MCP for status checks, structured task messages, verified file indexes, task ledger registration, trusted-peer routing, Codex conversation wakeups, heartbeat management, a process supervisor, and per-user autostart. It is source-only and disabled by default; the receiver must supply NapCat OneBot, a private token, QQ login state, and a private `binding.json`.

### wechat-docs-mcp 0.6.3

Optional governed local bridge for allowlisted WeChat routes and Tencent Docs. SQLite is the source of truth; WeChat routes and document monitors each use independent M:N subscriptions, delivery, merged wake, and exact ACK. Tencent Docs polling dynamically validates official read-only tools, establishes a no-replay baseline, preserves it on failed or incomplete reads, and coalesces changes over five/15-minute windows. The receiver must supply private bindings, policy references, database paths, token files, and a compatible logged-in desktop WeChat environment. Real WeChat UI sending remains disabled until a verified backend is installed privately.

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
- `NAPCAT_MCP_BINDING_PATH`
- `NAPCAT_MCP_STATE_PATH`
- `NAPCAT_TASK_REGISTRY_PATH`
- `NAPCAT_TASK_ROUTER_RUNTIME_PATH`
- `NAPCAT_TASK_ROUTER_LOG_PATH`

## Optional Model / Search Services

- ProGrok: `MEMORY_STORE_GROK_PROXY_URL`, `MEMORY_STORE_GROK_API_KEY`, `SANDBOX_PROGROK_BASE_URL`, `SANDBOX_PROGROK_API_KEY`
- Exa: `EXA_MCP_REMOTE_URL` or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`, plus optional `EXA_MCP_API_KEYS`, `EXA_MCP_REMOTE_BASE_URL`, `EXA_MCP_PUBLIC_FALLBACK_ENABLED`, and cooldown/state overrides documented in `broker/README.md`
- NapCat: `CODEX_TOOLKIT_ENABLE_NAPCAT_MCP`, `NAPCAT_HTTP_URL`, `NAPCAT_ACCESS_TOKEN`

Real values belong in the receiver's private environment, never in source or zip files.
