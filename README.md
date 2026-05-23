# MCP-SKILL-RULES Packages

Portable MCP + Rules package for AI coding environments.

This repository packages a source-only MCP tool stack plus opinionated, privacy-scrubbed rules templates for three hosts:

- Antigravity
- Codex
- Claude Code

The current release focus is **MCP + Rules**. Skills are intentionally not bundled in this snapshot; the repository name keeps `SKILL` as a reserved slot for future public skill packaging.

## What Is Included

| Area | Path | Notes |
| --- | --- | --- |
| MCP servers | `mcps/` | `memory-store`, `web-fetcher`, `sandbox`, and a portable HTTP broker |
| Host rules | `rules/` | Separate templates for Codex, Antigravity, and Claude Code |
| Install scripts | `install/` | Windows PowerShell scripts for build, broker startup, config, and smoke tests |
| Config templates | `templates/` | Codex, Antigravity, Claude Code, and environment examples |
| Smoke tests | `design-tests/` | Local pages and MCP HTTP smoke test helpers |

## Current Versions

| Component | Version |
| --- | --- |
| `memory-store` | `1.14.0` |
| `sandbox` | `1.13.1` |
| `web-fetcher` | `7.0.0` |
| `codex-mcp-http-broker` | `0.1.0` |

## Three-Host Compatibility

The MCP stack has moved from an Antigravity-only experiment to a shared system that can work across:

- `antigravity`
- `codex`
- `claude-code` / `cc`

Where supported, tools accept `chain`, `dataChain`, and `modelChain` so conversation data and model calls can be routed independently.

Examples:

- `dataChain="claude-code"` reads Claude Code local conversation data.
- `modelChain="codex"` uses the Codex model bridge for model-assisted operations.
- `modelChain="antigravity"` forces the Antigravity Language Server route.
- `modelChain="claude-code"` explicitly uses Claude Code CLI; automatic CC fallback is intentionally conservative to avoid hidden quota use.

## Quick Start On Windows

Requirements:

- Node.js 18+
- npm
- PowerShell
- Codex, Antigravity, or Claude Code depending on which host you want to configure

Build and smoke test:

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
./install/Stop-CodexMcpBroker.ps1
```

The broker exposes these local endpoints by default:

```text
http://127.0.0.1:14588/memory-store/mcp
http://127.0.0.1:14588/web-fetcher/mcp
http://127.0.0.1:14588/sandbox/mcp
http://127.0.0.1:14588/exa/mcp          # optional, requires receiver-side Exa URL
```

## Rules Templates

Rules are split by host:

- Codex: `rules/codex/AGENTS.template.md`
- Optional Codex system prompt: `rules/codex/system-prompt.template.md`
- Antigravity: `rules/antigravity/GEMINI.template.md`
- Claude Code: `rules/claude-code/CLAUDE.template.md`

These are templates. Review and edit style, identity, model choices, and local paths before using them.

## Privacy Boundary

This repository should only contain source code, templates, docs, and test samples.

Do not commit:

- API keys or remote MCP URLs with embedded keys
- cookies, browser profiles, auth files, sessions, or logs
- real memory-store data or Record files
- SQLite databases or JSONL conversation histories
- machine-specific absolute paths
- private account links or personal identifiers

Run the package-clean smoke check before publishing changes:

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS="<add-your-private-markers-separated-by-semicolons>"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## Repository Layout

```text
.
├─ mcps/
│  ├─ broker/
│  ├─ memory-store/
│  ├─ sandbox/
│  └─ web-fetcher/
├─ rules/
│  ├─ codex/
│  ├─ antigravity/
│  └─ claude-code/
├─ install/
├─ templates/
├─ design-tests/
├─ PACKAGE_MANIFEST.md
├─ PRIVATE_EXCLUDE_CHECKLIST.md
├─ TOOLKIT_README.md
└─ SETUP.md
```

## License

MIT. See `LICENSE`.
