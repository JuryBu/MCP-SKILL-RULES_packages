# MCP Notes

This package contains source-only MCP servers plus a portable HTTP broker.

## Components

- `memory-store` (`1.17.1`): shared memory, Record, conversation reading, Conversation Export, Golden Extract, Stage Guard, ownership tools, query parsing / relevance scoring, WSF Cascade routing, local fallback, and four-host conversation/data routing; model routing currently uses Antigravity, Codex, or Claude Code. Supports `antigravity`, `codex`, `claude-code` / `cc`, and `windsurf` / `wsf` chains where applicable.
- `web-fetcher` (`7.0.0`): headless browsing, page fetch, rich extraction, screenshots, sessions, local multi-format file handling, visual inspection, AI summary/review, and desktop / browser interaction helpers. `modelChain` supports Antigravity, Codex, and Claude Code; Windsurf is dataChain-only in this package. Claude Code is explicit or opt-in fallback to avoid hidden quota use.
- `sandbox` (`1.13.7`): code execution, persistent sessions, batch tasks, long-running launches, smart search, `sandbox_codex`, and `sandbox_council`. This refresh includes SSRF / shell-injection hardening, stricter exec/batch validation, background abort cleanup, per-task launch registry, session memory reservation, and stderr temp-file preservation. Council includes Claude Code provider support, Gemini CLI indexing, large-input chunking, complex-file indexing, provider fallback, and pressure-timeout handling.
- `exa`: optional remote endpoint through `mcp-remote`; receiver must provide `EXA_MCP_REMOTE_URL` or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`.
- `broker` (`0.1.0`): Streamable HTTP bridge exposing `/memory-store/mcp`, `/web-fetcher/mcp`, `/sandbox/mcp`, optional `/exa/mcp`, plus optional Playwright and sequential-thinking endpoints.
- `mcp-subagent` (`0.0.1`): Windsurf-only async Cascade sub-agent controller. It supports `subagent_current`, `subagent_models`, `subagent_spawn`, `subagent_poll`, `subagent_reply`, `subagent_collect`, `subagent_interrupt`, `subagent_dispose`, `subagent_reconcile`, and cleanup tools. It is source-only and optional; do not expose it to non-Windsurf hosts unless you explicitly accept the local broker/config risk.

`mcp-subagent` is deliberately not treated as a four-source shared MCP. It writes to real Windsurf / Devin Cascade conversations and keeps its own `subagent-data` runtime registry, so package copies must exclude runtime data and installation must be explicit, backed up, and reversible.

## Chain Values

Use `auto | antigravity | codex | claude-code | cc | windsurf | wsf` where supported.

- `auto`: current host first; other hosts only when the tool explicitly supports fallback.
- `antigravity`: force Antigravity Language Server / model route.
- `codex`: force Codex local thread/model route.
- `claude-code` / `cc`: force Claude Code local JSONL / CLI route.
- `windsurf` / `wsf`: force Windsurf / Cascade local conversation data route where supported; model calls should use another `modelChain` because this package does not expose a Windsurf model bridge.

Prefer `dataChain` for conversation/source data and `modelChain` for model calls when a tool supports split routing.

## Runtime Data

Default portable data root:

```text
%USERPROFILE%/.codex-toolkit/
```

Useful environment variables:

- `CODEX_TOOLKIT_DATA_ROOT`
- `CODEX_TOOLKIT_MCP_ROOT`
- `MEMORY_STORE_DATA_ROOT`
- `SANDBOX_DATA_ROOT`
- `WEB_FETCHER_PROFILES_DIR`
- `ANTIGRAVITY_CONVERSATIONS_DIR` if Antigravity is installed in a non-default place
- `CLAUDE_CODE_CONVERSATIONS_DIR` if Claude Code is installed in a non-default place
- `EXA_MCP_REMOTE_URL` / `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL` for Exa only

Do not package runtime data, private keys, sessions, SQLite databases, logs, or browser profiles.
