# Rules Templates

This folder contains privacy-scrubbed Rules templates for each host:

- `codex/components/core.template.md` → shared Codex engineering behavior.
- `codex/components/catgirl.template.md` → optional natural catgirl voice.
- `codex/components/development.template.md` and `training.template.md` → optional dual-machine role overlays.
- `codex/profiles/*.profile.json` → four installable compositions: `neutral`, `catgirl`, `development`, and `training`.
- `codex/guidance/*.template.md` → profile-specific machine-role guidance copied only by the corresponding profile.
- `codex/local-overrides.example.md` → placeholder schema; copy it outside the repository before adding private values.
- `codex/system-prompt.template.md` → optional Codex model-instructions target.
- `antigravity/GEMINI.template.md` → merge into the receiver's Antigravity rules file.
- `claude-code/CLAUDE.template.md` → merge into the receiver's Claude Code rules file.
- `windsurf/global_rules.template.md` → short per-conversation Windsurf rules.
- `windsurf/system_rules/*.template.md` → long-lived Windsurf system rules, split by concern.
- `windsurf/DEPLOYMENT.md` → host-neutral deployment, compatibility, and rollback guidance.
- `windsurf/Windsurf_Global_Rules.template.md` → condensed compatibility entry for older import scripts; use the new split layout for full coverage.

The templates preserve natural Chinese communication, anti-report-writing guidance, engineering workflow, subagent/council boundaries, evidence discipline, visual QA, `chain` / `dataChain` / `modelChain`, stable `conversationId` / `ownerId`, background-task rules, and Council artifact safety (`dryRun` before approved cleanup). The Codex catgirl voice is optional rather than embedded in the shared engineering core. General model-selection guidance may remain as a receiver-editable workflow preference; sender-specific identity, account data, local paths, credentials, active sessions, private entitlements, pricing claims, and quota promises are removed.

Sections titled `【可选配置 RULES 段】` apply only when the receiver explicitly installs and enables the corresponding integration. They may describe a neutral ecosystem role, but they never select the receiver's default owner-contact channel; that preference belongs in a private local overlay.

Build a Codex profile with `install/Build-CodexRulesProfile.ps1`, or install it with `install/Install-CodexRulesProfile.ps1`. Existing target files are backed up before replacement. Add `-InstallSystemPrompt -InstallRecommendedDesktopFeatures` only when the receiver wants the shared system prompt and the currently tested Desktop feature tables merged into its existing config. A real local override remains receiver-private and is ignored by package creation.

The Codex `system-prompt.template.md` is an optional receiver-installed model-instructions file shared by all four profiles. It reinforces following AGENTS user rules when the host supports this setting and never overwrites a host configuration automatically.

Shared MCP capabilities vary by host. Use `chain`, `dataChain`, and `modelChain` only when the installed tool documents them, and treat Windsurf-specific automation as opt-in rather than a default shared capability.

After import, the receiver should set personal style, host-specific paths, installed tools, model preferences, and authorization locally.
