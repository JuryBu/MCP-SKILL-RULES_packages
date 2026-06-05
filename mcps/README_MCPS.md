# MCP Notes

This package contains source-only MCP servers plus a portable HTTP broker.

## Components

- `memory-store` (`1.15.3`): shared memory, Record, conversation reading, Golden Extract, Stage Guard, ownership tools, and three-host conversation / model routing. Supports `antigravity`, `codex`, and `claude-code` / `cc` chains where applicable.
- `web-fetcher` (`7.0.0`): headless browsing, page fetch, rich extraction, screenshots, sessions, local multi-format file handling, visual inspection, AI summary/review, and desktop / browser interaction helpers. `modelChain` supports the three hosts; Claude Code is explicit or opt-in fallback to avoid hidden quota use.
- `sandbox` (`1.13.3`): code execution, persistent sessions, batch tasks, long-running launches, smart search, `sandbox_codex`, and `sandbox_council`. Council includes Claude Code provider support, Gemini CLI indexing, large-input chunking, complex-file indexing, provider fallback, and pressure-timeout handling.
- `exa`: optional remote endpoint through `mcp-remote`; receiver must provide `EXA_MCP_REMOTE_URL` or `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`.
- `broker` (`0.1.0`): Streamable HTTP bridge exposing `/memory-store/mcp`, `/web-fetcher/mcp`, `/sandbox/mcp`, optional `/exa/mcp`, plus optional Playwright and sequential-thinking endpoints.

## Chain Values

Use `auto | antigravity | codex | claude-code | cc` where supported.

- `auto`: current host first; other hosts only when the tool explicitly supports fallback.
- `antigravity`: force Antigravity Language Server / model route.
- `codex`: force Codex local thread/model route.
- `claude-code` / `cc`: force Claude Code local JSONL / CLI route.

Prefer `dataChain` for conversation/source data and `modelChain` for model calls when a tool supports split routing.

## Runtime Data

Default portable data root:

``text
%USERPROFILE%/.codex-toolkit/
``

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
