# Package Manifest（2026-5-23）

Included:

- `mcps/memory-store` source-only portable MCP (`1.14.0`)
- `mcps/web-fetcher` source-only portable MCP (`7.0.0`)
- `mcps/sandbox` source-only portable MCP (`1.13.1`)
- `mcps/broker` portable HTTP broker (`0.1.0`)
- `templates/config.codex.toml`
- `templates/config.antigravity.example.json`
- `templates/config.claude.example.json`
- `templates/env.example.ps1`
- `rules/codex/AGENTS.template.md`
- `rules/codex/system-prompt.template.md`
- `rules/antigravity/GEMINI.template.md`
- `rules/claude-code/CLAUDE.template.md`
- `rules/README_RULES.md`
- `rules/RULES_PORTING_NOTES.md`
- `install/*.ps1`
- `design-tests/*`

Excluded:

- `skills/`
- `node_modules/`, `dist/`, build caches
- `.git/`, editor state, temp folders
- API keys, auth files, cookies, browser profiles
- real memory-store data and Record files
- Codex / Antigravity / Claude Code sessions
- SQLite databases, logs, JSONL histories
- sender-specific paths, birthday, account links, sender-specific project branding

