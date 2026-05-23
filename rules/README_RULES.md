# Rules Templates

This folder has one Rules template per host:

- `codex/AGENTS.template.md` → merge into `%USERPROFILE%/.codex/AGENTS.md`
- `codex/system-prompt.template.md` → optional Codex `model_instructions_file` target
- `antigravity/GEMINI.template.md` → merge into Antigravity `GEMINI.md`
- `claude-code/CLAUDE.template.md` → merge into `%USERPROFILE%/.claude/CLAUDE.md`

All three templates are privacy-scrubbed handoff versions. They preserve work style, MCP usage rules, subagent/council habits, evidence discipline, PPT/document QA habits, and three-source chain conventions, but remove sender-specific birthday, account links, local private paths, private memories, and project branding.

Receiver should edit personal style, account references, model preferences, and host-specific paths after import.
