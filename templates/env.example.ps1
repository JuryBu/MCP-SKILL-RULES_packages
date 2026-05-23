# Optional environment overrides for this toolkit.

$env:CODEX_TOOLKIT_DATA_ROOT = "$env:USERPROFILE\.codex-toolkit"
$env:CODEX_TOOLKIT_MCP_ROOT = "<toolkit-root>\mcps"
$env:CODEX_MCP_BROKER_HOST = "127.0.0.1"
$env:CODEX_MCP_BROKER_PORT = "14588"

$env:MEMORY_STORE_DATA_ROOT = "$env:CODEX_TOOLKIT_DATA_ROOT\memory-store"
$env:SANDBOX_DATA_ROOT = "$env:CODEX_TOOLKIT_DATA_ROOT\sandbox-data"
$env:WEB_FETCHER_PROFILES_DIR = "$env:CODEX_TOOLKIT_DATA_ROOT\web-fetcher-profiles"
# Optional: enable the Exa remote MCP endpoint through broker.
# Keep the real key on the receiver machine; do not write it into files you send around.
# $env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"

# Optional Claude Code model bridge controls. Keep explicit-only by default to avoid hidden quota use.
# $env:MEMORY_STORE_CLAUDE_CODE_AUTO_FALLBACK = "0"
# $env:WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK = "0"
# $env:SANDBOX_CLAUDE_CODE_AUTO_FALLBACK = "0"


