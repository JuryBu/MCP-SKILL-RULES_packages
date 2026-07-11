# Optional environment overrides for this toolkit.

$env:CODEX_TOOLKIT_DATA_ROOT = "$env:USERPROFILE\.codex-toolkit"
$env:CODEX_TOOLKIT_MCP_ROOT = "<toolkit-root>\mcps"
$env:CODEX_MCP_BROKER_HOST = "127.0.0.1"
$env:CODEX_MCP_BROKER_PORT = "14588"
$env:CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS = "120000"
$env:CODEX_MCP_BROKER_WAIT_TIMEOUT_MS = "1800000"

$env:MEMORY_STORE_DATA_ROOT = "$env:CODEX_TOOLKIT_DATA_ROOT\memory-store"
$env:SANDBOX_DATA_ROOT = "$env:CODEX_TOOLKIT_DATA_ROOT\sandbox-data"
$env:WEB_FETCHER_PROFILE_BASE_DIR = "$env:CODEX_TOOLKIT_DATA_ROOT\web-fetcher-profiles"

# Optional Council retention controls. Managed artifacts default to 14 days; values below 7 are clamped to 7.
# Always preview receiver data with gcMode=dryRun before apply, restore, or purge.
# $env:SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS = "14"
# $env:SANDBOX_COUNCIL_TASK_RETENTION_DAYS = "15"
# $env:SANDBOX_COUNCIL_AUTO_GC = "0" # Set to 1 only after accepting startup apply behavior.

# Optional Antigravity CLI (agy) Council route. The default command is "agy" when installed.
# Proxy settings are injected only into agy child processes and never persisted by this toolkit.
# $env:SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND = "agy"
# $env:SANDBOX_COUNCIL_ANTIGRAVITY_CLI_CONCURRENCY = "2"
# $env:SANDBOX_COUNCIL_ANTIGRAVITY_CLI_PROXY_MODE = "auto"
# Optional: enable the Exa remote MCP endpoint through broker.
# Keep the real key on the receiver machine; do not write it into files you send around.
# $env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"

# Optional Grok / ProGrok OpenAI-compatible model bridge.
# The toolkit only probes this endpoint. It does not install, start, patch, or authenticate ProGrok.
# Keep the real API key in the receiver's private environment, never in this repository or a shared zip.
# $env:MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:18645"
# $env:MEMORY_STORE_GROK_API_KEY = "<receiver-private-key>"
# $env:SANDBOX_PROGROK_BASE_URL = "http://127.0.0.1:18645"
# $env:SANDBOX_PROGROK_API_KEY = "<receiver-private-key>"
# $env:SANDBOX_PROGROK_MODEL = "<receiver-supported-grok-model>"

# Optional Claude Code model bridge controls. Keep explicit-only by default to avoid hidden quota use.
# $env:MEMORY_STORE_CLAUDE_CODE_AUTO_FALLBACK = "0"
# $env:WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK = "0"
# $env:SANDBOX_CLAUDE_CODE_AUTO_FALLBACK = "0"


