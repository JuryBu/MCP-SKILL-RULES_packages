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

# Optional Sandbox-wide resource admission. Requests reserve expected working memory; maxMemoryMB remains the per-process-tree hard limit.
# $env:SANDBOX_ADMISSION_MIN_RESERVATION_MB = "64"
# $env:SANDBOX_ADMISSION_LIMIT_MB = "1536"
# $env:SANDBOX_ADMISSION_HARD_LIMIT_MB = "2048"
# $env:SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB = "512"
# $env:SANDBOX_ADMISSION_COMMIT_HEADROOM_MB = "4096"
# $env:SANDBOX_ADMISSION_COMMIT_CRITICAL_FLOOR_MB = "1536"
# $env:SANDBOX_ADMISSION_YELLOW_PHYSICAL_MB = "1536"
# $env:SANDBOX_ADMISSION_YELLOW_MAX_REQUEST_MB = "192"
# $env:SANDBOX_ADMISSION_MAX_AGED_RESERVATION_MB = "256"
# $env:SANDBOX_ADMISSION_MAX_QUEUE = "256"
# $env:SANDBOX_ADMISSION_WAIT_MIN_MS = "8000"
# $env:SANDBOX_ADMISSION_WAIT_MAX_MS = "10000"
# $env:SANDBOX_ADMISSION_AGING_MS = "1000"
# $env:SANDBOX_ADMISSION_PROGRESS_INTERVAL_MS = "2000"
# $env:SANDBOX_ADMISSION_RETRY_SLOT_MS = "500"
# $env:SANDBOX_ADMISSION_MAX_RETRY_EXPONENT = "4"
# $env:SANDBOX_EXEC_MAX_TIMEOUT_MS = "21600000"

# Optional reservations for tools whose child-process lifetime is managed as one unit.
# $env:SANDBOX_CODEX_RESERVATION_MB = "512"
# $env:SANDBOX_COUNCIL_RESERVATION_MB = "512"
# $env:SANDBOX_SMART_RESERVATION_MB = "512"

# Optional Sandbox session limits.
# $env:SANDBOX_SESSION_MAX_COUNT = "5"
# $env:SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB = "1536"
# $env:SANDBOX_SESSION_DEFAULT_MEMORY_MB = "256"
# $env:SANDBOX_SESSION_IDLE_TIMEOUT_MS = "300000"

# Optional adaptive output artifact retention. Defaults to six hours.
# $env:SANDBOX_OUTPUT_ARTIFACT_TTL_MS = "21600000"
# $env:SANDBOX_OUTPUT_HARD_RESPONSE_BYTES = "1048576"

# Limit design-tests/smoke-mcp-http.mjs to an already enabled comma-separated subset, for example sandbox only.
# $env:CODEX_TOOLKIT_SMOKE_ENDPOINTS = "sandbox"

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
# Keep real keys on the receiver machine; do not write them into files you send around.
# A legacy key may remain inside EXA_MCP_REMOTE_URL. Add more keys as a comma-separated pool.
# $env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"
# $env:EXA_MCP_API_KEYS = "<receiver-private-key-2>,<receiver-private-key-3>"
# $env:EXA_MCP_REMOTE_BASE_URL = "https://mcp.exa.ai/mcp"
# $env:EXA_MCP_PUBLIC_FALLBACK_ENABLED = "1"
# $env:EXA_MCP_KEY_COOLDOWN_MS = "86400000"
# $env:EXA_MCP_KEY_COOLDOWN_JITTER_MS = "900000"
# $env:EXA_MCP_RATE_LIMIT_COOLDOWN_MS = "60000"

# Optional NapCat QQ group collaboration MCP. NapCat itself and QQ login state are not bundled.
# Copy mcps\napcat-mcp\binding.example.json to the private data root and replace all example values.
# $env:CODEX_TOOLKIT_ENABLE_NAPCAT_MCP = "1"
# $env:NAPCAT_MCP_ROOT = "$env:USERPROFILE\.codex\services\napcat-bridge\current"
# $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT = "$env:CODEX_TOOLKIT_DATA_ROOT\napcat-mcp"
# $env:NAPCAT_HTTP_URL = "http://127.0.0.1:3010"
# $env:NAPCAT_ACCESS_TOKEN = "<receiver-private-onebot-token>"
# $env:CODEX_MCP_BROKER_CONTROL_TOKEN = "<receiver-random-local-control-token>"
# $env:NAPCAT_MCP_BINDING_PATH = "$env:CODEX_TOOLKIT_DATA_ROOT\napcat-mcp\binding.json"
# $env:NAPCAT_MCP_STATE_PATH = "$env:CODEX_TOOLKIT_DATA_ROOT\napcat-mcp\state\dedupe.json"

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


