# Package Manifest（2026-7-4）

Included:

- `mcps/memory-store` source-only portable MCP (`1.17.1`)
- `mcps/web-fetcher` source-only portable MCP (`7.0.0`)
- `mcps/sandbox` source-only portable MCP (`1.13.7`)
- `mcps/broker` portable HTTP broker (`0.1.0`)
- `mcps/mcp-subagent` source-only Windsurf-only optional MCP (`0.0.1`)
- `templates/config.codex.toml`
- `templates/config.antigravity.example.json`
- `templates/config.claude.example.json`
- `templates/config.windsurf.example.json`
- `templates/config.windsurf.subagent.example.json`
- `templates/env.example.ps1`
- `rules/codex/AGENTS.template.md`
- `rules/codex/system-prompt.template.md`
- `rules/antigravity/GEMINI.template.md`
- `rules/claude-code/CLAUDE.template.md`
- `rules/windsurf/Windsurf_Global_Rules.template.md`
- `rules/README_RULES.md`
- `rules/RULES_PORTING_NOTES.md`
- `skills/README_SKILLS.md`
- `skills/skills_manifest.md`
- `skills/<portable user skill folders>`
- `install/*.ps1`
- `design-tests/*`

Updated in this snapshot:

- 2026-07-04: refreshed changed MCP sources and rules templates; `memory-store` is now `1.17.1`, `sandbox` is now `1.13.7`, broker portability patches plus request timeout forwarding were retained, and `mcp-subagent` remains Windsurf-only optional.
- 2026-07-04: refreshed Claude Code and Windsurf rule deltas, rechecked Codex / Antigravity templates, then scrubbed personal info, account links, login-state claims, and sender-specific paths.

- Skills rechecked on 2026-07-04: allow-listed portable user-side skills copied from `%USERPROFILE%/.codex/skills`, excluding `.system`, plugin cache, Office skills with restrictive local licenses (`docx`, `pptx`, `xlsx`), unlicensed `doc-coauthoring`, runtime caches, build outputs, and generated test artifacts.

- `memory-store` refreshed to `1.17.1` with query parsing, relevance scoring, tool concurrency, WSF Cascade routing, and local fallback sources.
- `sandbox` refreshed to `1.13.7` with SSRF / shell injection hardening, batch/launch/session lifecycle fixes, background abort, and per-task registry.
- `web-fetcher` rechecked against the current local `7.0.0` tree; no functional source change was needed, and portable README examples were kept scrubbed.
- Codex / Antigravity / Claude Code / Windsurf rules refreshed or rechecked from current local templates, then all rules privacy-scrubbed.
- Four-host wording remains Antigravity + Codex + Claude Code / CC + Windsurf / WSF with shared data and broker routing.

Excluded:

- `.system/` skills, plugin cache skills, restrictive-license Office skills (`docx`, `pptx`, `xlsx`), and unlicensed `doc-coauthoring`
- `node_modules/`, `dist/`, build caches, `__pycache__`, generated skill test outputs
- `mcps/mcp-subagent/subagent-data`, Cascade child job registry, audit logs, archive exports, generated handoff zips, and built `dist/`
- `.git/`, editor state, temp folders
- API keys, auth files, cookies, browser profiles
- real memory-store data and Record files
- Codex / Antigravity / Claude Code / Windsurf sessions
- SQLite databases, logs, JSONL histories
- sender-specific paths, birthday, account links, sender-specific project branding
