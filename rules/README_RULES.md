# Rules Templates

This folder contains privacy-scrubbed Rules templates for each host:

- `codex/AGENTS.template.md` → merge into the receiver's Codex rules file.
- `codex/system-prompt.template.md` → optional Codex model-instructions target.
- `antigravity/GEMINI.template.md` → merge into the receiver's Antigravity rules file.
- `claude-code/CLAUDE.template.md` → merge into the receiver's Claude Code rules file.
- `windsurf/global_rules.template.md` → short per-conversation Windsurf rules.
- `windsurf/system_rules/*.template.md` → long-lived Windsurf system rules, split by concern.
- `windsurf/DEPLOYMENT.md` → host-neutral deployment, compatibility, and rollback guidance.
- `windsurf/Windsurf_Global_Rules.template.md` → condensed compatibility entry for older import scripts; use the new split layout for full coverage.

The templates preserve the current catgirl-style natural Chinese voice, anti-report-writing guidance, engineering workflow, subagent/council boundaries, evidence discipline, visual QA, `chain` / `dataChain` / `modelChain`, stable `conversationId` / `ownerId`, background-task rules, and Council artifact safety (`dryRun` before approved cleanup). They remove sender-specific identity, account data, local paths, credentials, active sessions, real-time service claims, model defaults, pricing, and quota promises.

The Codex `system-prompt.template.md` is an optional receiver-installed model-instructions file that reinforces following AGENTS user rules when the host supports this setting. It is included as a template only and never overwrites a host configuration automatically.

Shared MCP capabilities vary by host. Use `chain`, `dataChain`, and `modelChain` only when the installed tool documents them, and treat Windsurf-specific automation as opt-in rather than a default shared capability.

After import, the receiver should set personal style, host-specific paths, installed tools, model preferences, and authorization locally.
