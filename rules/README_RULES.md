# Rules Templates

This folder has one Rules template per host:

- `codex/AGENTS.template.md` → merge into `%USERPROFILE%/.codex/AGENTS.md`
- `codex/system-prompt.template.md` → optional Codex `model_instructions_file` target
- `antigravity/GEMINI.template.md` → merge into Antigravity `GEMINI.md`
- `claude-code/CLAUDE.template.md` → merge into `%USERPROFILE%/.claude/CLAUDE.md`
- `windsurf/Windsurf_Global_Rules.template.md` → merge into Windsurf global rules, usually `%USERPROFILE%/.codeium/windsurf/memories/global_rules.md`

All four templates are privacy-scrubbed handoff versions. They preserve work style, MCP usage rules, subagent/council habits, evidence discipline, PPT/document QA habits, and four-source chain conventions, but remove sender-specific birthday, account links, local private paths, private memories, login-state claims, and project branding.

Windsurf support is data-chain oriented for shared MCPs: `dataChain=windsurf` can read Cascade conversation data where supported, while `modelChain=windsurf` is intentionally not advertised. The separate `mcps/mcp-subagent` package is Windsurf-only automation for Cascade sub-agents and should be enabled explicitly, not treated as a default shared MCP.

Receiver should edit personal style, account references, model preferences, host-specific paths, and Windsurf memory/config locations after import.
