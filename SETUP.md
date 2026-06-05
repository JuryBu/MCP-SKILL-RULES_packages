# Setup Guide

This guide is for setting up the portable MCP + Rules package on Windows.

## 1. Build MCP Servers

From the repository root:

```powershell
./install/Install-CodexToolkit.ps1
```

This installs dependencies and builds:

- `mcps/memory-store`
- `mcps/web-fetcher`
- `mcps/sandbox`
- `mcps/broker`

## 2. Start The HTTP Broker

```powershell
./install/Start-CodexMcpBroker.ps1
./install/Status-CodexMcpBroker.ps1
```

Default broker URL:

```text
http://127.0.0.1:14588
```

Default runtime data root:

```text
%USERPROFILE%\.codex-toolkit
```

Override with:

```powershell
$env:CODEX_TOOLKIT_DATA_ROOT = "D:\\ai-tools-data"
$env:CODEX_MCP_BROKER_PORT = "14588"
```

## 3. Configure Codex

Apply the Codex HTTP MCP config block:

```powershell
./install/Apply-CodexConfig.ps1
```

Then merge the rules template manually:

```text
rules/codex/AGENTS.template.md -> %USERPROFILE%/.codex/AGENTS.md
```

Optional Codex system prompt:

```powershell
./install/Install-SystemPromptTemplate.ps1
```

Make sure `%USERPROFILE%/.codex/config.toml` contains:

```toml
model_instructions_file = "~/.codex/prompts/system-prompt.md"
```

## 4. Configure Antigravity

Rules:

```text
rules/antigravity/GEMINI.template.md -> your Antigravity GEMINI.md
```

MCP config example:

```text
templates/config.antigravity.example.json
```

If you run the MCP servers directly through Antigravity instead of through the HTTP broker, update all `<toolkit-root>` placeholders and keep runtime data outside the repository.

## 5. Configure Claude Code

Rules:

```text
rules/claude-code/CLAUDE.template.md -> %USERPROFILE%/.claude/CLAUDE.md
```

User-scope MCP example:

```text
templates/config.claude.example.json
```

Use Claude Code's own MCP configuration flow, or manually merge the HTTP endpoints into the user config. Keep secrets outside the repository.

## 6. Optional Exa Endpoint

The `/exa/mcp` endpoint is disabled in practice unless the receiver provides a private Exa remote URL.

Set one of these on the receiver machine only:

```powershell
$env:EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"
# or
$env:CODEX_TOOLKIT_EXA_MCP_REMOTE_URL = "<receiver-private-exa-remote-url>"
```

Never commit the real URL or API key.

## 7. Smoke Test

```powershell
./install/Test-CodexToolkit.ps1
```

Expected output includes initialized MCP endpoints for:

- `memory-store`
- `web-fetcher`
- `sandbox`

Optional Exa smoke test:

```powershell
$env:CODEX_TOOLKIT_SMOKE_OPTIONAL = "1"
./install/Test-CodexToolkit.ps1
```

## 8. Package Clean Check

Before pushing public changes:

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
```

Also scan for private markers:

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS = "C:\\Users\\YourName;your-account-link;your-api-key-prefix"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## Notes

- `node_modules/` and `dist/` are intentionally not tracked.
- Runtime folders such as `sandbox-data/`, browser profiles, logs, sessions, JSONL histories, and SQLite databases must stay out of git.
- Claude Code fallback should usually be explicit-only to avoid hidden quota usage.

## Windsurf / WSF

Use `templates/config.windsurf.example.json` as a receiver-side example for %USERPROFILE%/.codeium/windsurf/mcp_config.json. Windsurf participates as a data source through dataChain=windsurf; model calls should use Codex, Antigravity, or Claude Code routes.
