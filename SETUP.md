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

The script backs up `%USERPROFILE%\.codex\config.toml`, ensures the top-level `project_doc_max_bytes` setting is at least `65536`, and then merges HTTP MCP endpoints. The 64K minimum prevents the larger development and training profiles from being truncated by Codex's common 32K project-document limit.

Choose one Codex Rules profile:

```powershell
./install/Install-CodexRulesProfile.ps1 -Profile catgirl
```

Available profiles:

| Profile | Composition | Intended use |
| --- | --- | --- |
| `neutral` | shared engineering core | no character voice |
| `catgirl` | core + natural catgirl voice | normal single-machine use |
| `development` | core + catgirl + development role | dual-machine development side |
| `training` | core + catgirl + training role | dual-machine training side |

The installer backs up files that it overwrites under `%USERPROFILE%\\.codex\\backups\\rules-profile-<timestamp>` and independently ensures `project_doc_max_bytes >= 65536`. To preview a profile without installing it:

```powershell
./install/Build-CodexRulesProfile.ps1 -Profile development -OutputDirectory ".\\profile-preview"
```

Machine-specific accounts, trusted peers, group IDs, absolute paths, and credentials must stay outside the repository. Copy `rules/codex/local-overrides.example.md` to a private location, edit that private copy, and install it explicitly:

```powershell
./install/Install-CodexRulesProfile.ps1 `
  -Profile development `
  -LocalOverridePath "D:\\private\\codex-local-overrides.md"
```

Do not pass `local-overrides.example.md` itself: the scripts reject it to prevent placeholder values from being mistaken for a working binding.

Optional common system-prompt emphasis and the currently tested Codex Desktop interaction features:

```powershell
./install/Install-CodexRulesProfile.ps1 `
  -Profile catgirl `
  -InstallSystemPrompt `
  -InstallRecommendedDesktopFeatures
```

The installer backs up `config.toml`, maintains this pointer exactly once, and merges the feature tables without replacing unrelated private configuration:

```toml
model_instructions_file = "~/.codex/prompts/system-prompt.md"

[features]
default_mode_request_user_input = true
concurrent_reasoning_summaries = true
prevent_idle_sleep = true

[features.current_time_reminder]
enabled = true
reminder_interval_seconds = 120
clock_source = "system"
delivery_mode = "after_user_or_tool_output"
sleep_tool = false
```

The system prompt is shared by all four profiles and contains only universal execution principles. The feature block targets current Codex Desktop behavior: it provides periodic time context after user or tool output and enables the structured question UI while retaining free-form answers. Older standalone Codex CLI builds may reject the structured `current_time_reminder` table; Desktop-first installations may use it, while CLI-dependent receivers should omit `-InstallRecommendedDesktopFeatures` until their CLI supports the same schema. `Install-SystemPromptTemplate.ps1` remains available for receivers who want only the template.

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

Set the private remote URL and any additional API keys only on the receiver machine:

```powershell
$env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"
$env:EXA_MCP_API_KEYS = "<receiver-private-key-2>,<receiver-private-key-3>"
$env:EXA_MCP_REMOTE_BASE_URL = "https://mcp.exa.ai/mcp"
$env:EXA_MCP_PUBLIC_FALLBACK_ENABLED = "1"
```

The broker uses `exa-key-pool.mjs` and `exa-stateless-stdio.mjs` for deterministic key rotation, MCP-body 402 detection, persistent circuit breaking, half-open recovery, public no-key fallback, stable tools/list fallback, and transport retries. The default quota cooldown is 24 hours with up to 15 minutes of jitter. Do not commit `broker-private.env.json`, real URLs, API keys, or `exa-key-pool-state.json`.

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
$env:CODEX_MCP_BROKER_CONTROL_TOKEN = "<receiver-random-local-control-token>"
```

Uncomment the optional NapCat block in `templates/config.codex.toml`. The endpoint supports fixed-group notifications, structured `task_id` messages, a persistent task ledger, trusted-peer routing, native Codex Desktop unread wakeups, file upload/download, and heartbeat scripts. It never accepts an arbitrary group ID from a tool call.

Task routing state is written below the receiver's `.codex-toolkit/napcat-mcp/state` directory. Each participating Codex conversation must call `napcat_task_register` with a stable `task_id`, its own `conversation_id`, machine role, source/target labels, and trusted peer QQ. After processing messages, call `napcat_task_ack` with the actual maximum handled `message_seq`; close completed tasks with `napcat_task_close`.

Install or update the code with the guarded updater. It keeps source code separate from private state, validates a candidate before replacement, pauses automatic wake during the switch, preserves task fields, and reloads only the NapCat backend. Existing legacy installs can use the documented one-time mixed-root flag after making the generated backup; fresh installs should keep the default separate roots.

Treat the updater result as the source of truth: `activated=true` and `pendingActivation=false` mean the release is running; copied files or a staged candidate do not. Record the exact `sourceCommit`, then verify the active pointer, task registry, router paths, proxy status, and supervisor status before reporting the upgrade complete.

```powershell
./mcps/napcat-mcp/ops/update-codex-napcat-bridge.ps1 -SourceCommit "<git-commit>" -MigrateAutostart
./mcps/napcat-mcp/ops/get-codex-app-server-proxy-status.ps1
./mcps/napcat-mcp/ops/get-napcat-supervisor-status.ps1
./mcps/napcat-mcp/ops/get-napcat-task-router-status.ps1
```

After the first successful transparent-proxy installation, fully exit and normally open Codex once. The user experience and launch shortcut remain unchanged; the restart only lets Desktop inherit the loopback App Server URL. The supervisor starts the router only when the broker, NapCat OneBot, expected account, NapCat process, Codex process, at least one open task, and an inactive maintenance state all agree. Remove the logon task with `remove-napcat-autostart.ps1`; restore a failed code update with `rollback-codex-napcat-bridge.ps1`.

If the internal App Server protocol changes or the proxy repeatedly fails, automatic wake is paused before any further task write. A deduplicated incident is kept locally and sent to the fixed group after NapCat is online. The watchdog removes the proxy URL from the user environment so the next Codex launch uses the native App Server. This fallback protects normal Codex startup and existing tasks; it does not pretend an unknown future protocol is compatible.

Do not share NapCat binaries, QQ login state, QR codes, `binding.json`, OneBot tokens, task registry, router runtime, heartbeat state, or dedupe files. Verify the file upload → index → message read → download loop against the receiver's exact NapCat version because OneBot builds may disagree on `file_id` versus attachment UUID handling. Full details are in `mcps/napcat-mcp/README.md`.

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
./install/New-PortableToolkitPackage.ps1 -OutputDirectory "D:\releases\toolkit-2026-07-27" -ArchiveName "Portable-MCP-SKILL-RULES-Toolkit-2026-07-27.zip"
```

The command refuses to overwrite an existing output directory or archive, validates both source and copied package, and prints SHA256.
