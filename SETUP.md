# Setup Guide

Windows receiver-side setup for the portable MCP + Skills + Rules toolkit.

## 1. Prerequisites

- Windows PowerShell 5.1 or PowerShell 7
- Node.js 18 or newer
- A writable data directory; default: `%USERPROFILE%\.codex-toolkit`
- At least one supported host: Codex, Antigravity, Claude Code, or Windsurf

Copy `templates/env.example.ps1` to a private local file outside the repository, edit only the values required by the receiver, and load it before starting the broker.

## 2. Validate The Source Package

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
```

This verifies required MCP packages, four-host Rules, all 17 portable Skills, JSON config templates, absolute-path safety, and forbidden runtime files.

## 3. Build MCP Servers

```powershell
./install/Install-CodexToolkit.ps1
```

This installs dependencies and builds `memory-store`, `web-fetcher`, `sandbox`, and the portable broker.

Optional Windsurf-only subagent:

```powershell
./install/Install-CodexToolkit.ps1 -IncludeWindsurfSubagent
```

Building it does not edit Windsurf configuration. Follow `mcps/mcp-subagent/README.md` separately.

Optional NapCat source check:

```powershell
./install/Install-CodexToolkit.ps1 -IncludeNapCat
```

This does not install NapCat or log in to QQ. It only validates the bundled source and unit tests.

## 4. Start The HTTP Broker

```powershell
./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
```

Default URL: `http://127.0.0.1:14588`

Default data root: `%USERPROFILE%\.codex-toolkit`

Important overrides:

```powershell
$env:CODEX_TOOLKIT_DATA_ROOT = "D:\ai-tools-data"
$env:CODEX_TOOLKIT_MCP_ROOT = "D:\tools\mcps"
$env:CODEX_MCP_BROKER_PORT = "14588"
$env:CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS = "120000"
$env:CODEX_MCP_BROKER_WAIT_TIMEOUT_MS = "1800000"
```

## 5. Configure Codex

```powershell
./install/Apply-CodexConfig.ps1
```

The script backs up `%USERPROFILE%\.codex\config.toml` before merging HTTP MCP endpoints.

Rules:

```text
rules/codex/AGENTS.template.md -> %USERPROFILE%/.codex/AGENTS.md
```

Optional system prompt emphasis:

```powershell
./install/Install-SystemPromptTemplate.ps1
```

Then configure:

```toml
model_instructions_file = "~/.codex/prompts/system-prompt.md"
```

The system prompt only points Codex back to AGENTS-style instructions; it does not contain credentials or private data.

## 6. Configure Antigravity

Rules:

```text
rules/antigravity/GEMINI.template.md -> receiver Antigravity GEMINI.md
```

MCP example:

```text
templates/config.antigravity.example.json
```

Antigravity can run the MCP servers directly or use the same HTTP broker. When running directly, replace `<toolkit-root>` and keep runtime data outside the source directory.

## 7. Configure Claude Code

Rules:

```text
rules/claude-code/CLAUDE.template.md -> %USERPROFILE%/.claude/CLAUDE.md
```

MCP example:

```text
templates/config.claude.example.json
```

Claude Code model fallback remains explicit by default to avoid hidden quota use.

## 8. Configure Windsurf

MCP example:

```text
templates/config.windsurf.example.json
```

Rules are split into a short global rule and system fragments:

```text
rules/windsurf/global_rules.template.md
rules/windsurf/system_rules/tools.template.md
rules/windsurf/system_rules/memory.template.md
rules/windsurf/system_rules/collaboration.template.md
rules/windsurf/system_rules/efficiency.template.md
rules/windsurf/system_rules/rendering.template.md
```

Follow `rules/windsurf/DEPLOYMENT.md`. `Windsurf_Global_Rules.template.md` is retained only as a compatibility entry.

The optional subagent MCP is Windsurf-only because it creates and controls real Cascade conversations. Its runtime registry must remain outside the package.

## 9. Optional Grok / ProGrok Model Route

The package does not install, start, patch, or authenticate ProGrok. If the receiver already runs a compatible local proxy:

```powershell
$env:MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:18645"
$env:MEMORY_STORE_GROK_API_KEY = "<receiver-private-key>"
$env:SANDBOX_PROGROK_BASE_URL = "http://127.0.0.1:18645"
$env:SANDBOX_PROGROK_API_KEY = "<receiver-private-key>"
$env:SANDBOX_PROGROK_MODEL = "<receiver-supported-model>"
```

Use `modelChain="grok"` to force this route. `dataChain` never uses Grok because Grok does not own conversation data.

## 10. Sandbox Council Artifacts

Council 1.15.1 stores managed transcripts, indexes, large-input chunks, checkpoints, and quarantine data below `SANDBOX_DATA_ROOT`. The portable build does not run artifact GC automatically. Inspect candidates first:

```text
sandbox_status(action="gc", gcScope="council", gcMode="dryRun")
```

`apply` may move expired managed artifacts into quarantine, `restore` moves a selected quarantine group back, and `purge` permanently removes an eligible quarantine group. These modes modify persistent receiver data, so explain the scope and recovery path and obtain explicit approval before using them. A receiver may opt into startup cleanup with `SANDBOX_COUNCIL_AUTO_GC=1` only after accepting that behavior.

For Antigravity CLI / Gemini-family Council participants, use `provider="antigravityCli"`; `geminiCli` is a temporary compatibility alias. The `agy` command, login state, proxy, and model capacity are receiver-managed and are not included in this package.

## 11. Optional Exa Endpoint

Set the private remote URL only on the receiver machine:

```powershell
$env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"
```

The broker uses `exa-stateless-stdio.mjs` for stable tools/list fallback and retry behavior. Do not commit `broker-private.env.json` or the real URL.

## 12. Optional NapCat QQ Group Endpoint

Install and log in to a receiver-owned NapCat instance separately. Then copy the example binding to the private data root and replace every example identity:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex-toolkit\napcat-mcp" | Out-Null
Copy-Item ".\mcps\napcat-mcp\binding.example.json" "$env:USERPROFILE\.codex-toolkit\napcat-mcp\binding.json"
```

Keep the OneBot token in a private environment file outside the repository:

```powershell
$env:CODEX_TOOLKIT_ENABLE_NAPCAT_MCP = "1"
$env:NAPCAT_HTTP_URL = "http://127.0.0.1:3010"
$env:NAPCAT_ACCESS_TOKEN = "<receiver-private-onebot-token>"
```

Restart the broker, then uncomment the optional NapCat block in `templates/config.codex.toml`. The endpoint supports fixed-group notifications, structured `task_id` messages, recent-message reads, file upload/download, and heartbeat scripts. It never accepts an arbitrary group ID from a tool call.

Do not share NapCat binaries, QQ login state, QR codes, `binding.json`, OneBot tokens, heartbeat state, or dedupe files. Full details are in `mcps/napcat-mcp/README.md`.

## 13. Install Skills

Copy selected folders from `skills/` into:

```text
%USERPROFILE%/.codex/skills/
```

Restart Codex or open a new task. Other hosts may use the `SKILL.md` files as workflow references if their skill mechanism differs.

Office skills with redistribution-restricted local licenses and Codex system/plugin-cache skills are intentionally excluded. See `skills/skills_manifest.md`.

## 14. Smoke Tests

Core endpoints:

```powershell
./install/Test-CodexToolkit.ps1
```

Optional Playwright, sequential-thinking, and configured Exa endpoints:

```powershell
./install/Test-CodexToolkit.ps1 -IncludeOptionalEndpoints
```

Windsurf subagent is not included in generic smoke tests because a real check would require a signed-in Windsurf session and create Cascade state.

NapCat is also excluded from generic smoke tests because a live check requires a receiver-owned QQ login and bound group. After configuring it explicitly:

```powershell
./install/Test-CodexToolkit.ps1 -IncludeNapCatEndpoint
```

## 15. Build A Shareable Zip

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS = "C:\\Users\\YourName;your-account-link;your-private-marker"
./install/New-PortableToolkitPackage.ps1 -OutputDirectory "D:\releases\toolkit-2026-07-24" -ArchiveName "Portable-MCP-SKILL-RULES-Toolkit-2026-07-24.zip"
```

The command refuses to overwrite an existing output directory or archive, validates both source and copied package, and prints SHA256.
