# Package Manifest（2026-6-5）

Included:

- `mcps/memory-store` source-only portable MCP (`1.15.3`)
- `mcps/web-fetcher` source-only portable MCP (`7.0.0`)
- `mcps/sandbox` source-only portable MCP (`1.13.3`)
- `mcps/broker` portable HTTP broker (`0.1.0`)
- `templates/config.codex.toml`
- `templates/config.antigravity.example.json`
- `templates/config.claude.example.json`
- `templates/config.windsurf.example.json`
- `templates/env.example.ps1`
- `rules/codex/AGENTS.template.md`
- `rules/codex/system-prompt.template.md`
- `rules/antigravity/GEMINI.template.md`
- `rules/claude-code/CLAUDE.template.md`
- `rules/windsurf/Windsurf_Global_Rules.template.md`
- `rules/README_RULES.md`
- `rules/RULES_PORTING_NOTES.md`
- `install/*.ps1`
- `design-tests/*`

Updated in this snapshot:

- `memory-store` refreshed to `1.15.3`.
- `sandbox` refreshed to `1.13.3`.
- `web-fetcher` source refreshed from the current local tree; version remains `7.0.0`.
- Codex and Claude Code rules refreshed from current local templates, Windsurf rules added from WSF config, then all rules privacy-scrubbed.
- Four-host wording remains Antigravity + Codex + Claude Code / CC + Windsurf / WSF with shared data and broker routing.

Excluded:

- `skills/` runtime or private skill cache
- `node_modules/`, `dist/`, build caches
- `.git/`, editor state, temp folders
- API keys, auth files, cookies, browser profiles
- real memory-store data and Record files
- Codex / Antigravity / Claude Code / Windsurf sessions
- SQLite databases, logs, JSONL histories
- sender-specific paths, birthday, account links, sender-specific project branding
