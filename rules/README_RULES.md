# Rules Templates

This folder contains privacy-scrubbed Rules templates for each host:

- `codex/components/core.template.md` → shared Codex engineering behavior.
- `codex/components/catgirl.template.md` → optional natural catgirl voice.
- `codex/components/development.template.md` and `training.template.md` → optional dual-machine role overlays.
- `codex/profiles/*.profile.json` → four installable compositions: `neutral`, `catgirl`, `development`, and `training`.
- `codex/guidance/*.template.md` → six shared, trigger-read topics in every profile, plus the selected development/training role manual.
- `codex/local-overrides.example.md` → placeholder schema; copy it outside the repository before adding private values.
- `codex/system-prompt.template.md` → optional Codex model-instructions target.
- `antigravity/GEMINI.template.md` → merge into the receiver's Antigravity rules file.
- `claude-code/CLAUDE.template.md` → merge into the receiver's Claude Code rules file.
- `windsurf/global_rules.template.md` → short per-conversation Windsurf rules.
- `windsurf/system_rules/*.template.md` → long-lived Windsurf system rules, split by concern; on Devin Desktop (Devin Local) install them under `~/.devin/rules/` with a `trigger: always_on` frontmatter.
- `windsurf/DEPLOYMENT.md` → host-neutral deployment, compatibility, and rollback guidance, including the Devin Desktop layout and rule budget.
- `windsurf/Windsurf_Global_Rules.template.md` → condensed compatibility entry for older import scripts; use the new split layout for full coverage.

The templates preserve natural Chinese communication, anti-report-writing guidance, engineering workflow, subagent/council boundaries, evidence discipline, visual QA, bounded visible waiting, `chain` / `dataChain` / `modelChain`, stable `conversationId` / `ownerId`, background-task rules, project-trust checks before treating Codex `.codex/` layers as effective, and Council artifact safety (`dryRun` before approved cleanup). Dual-machine profiles additionally document explicit reply contracts, exact ACK fields, bounded stale-task reminders, and short production hot switches. Automatic bridge notices are described as compact channel/type/summary events for history restoration; the memory-store implementation remains a separate responsibility. The Codex catgirl voice is optional rather than embedded in the shared engineering core. General model-selection guidance may remain as a receiver-editable workflow preference; sender-specific identity, account data, local paths, credentials, active sessions, private entitlements, pricing claims, and quota promises are removed.

Sections titled `【可选配置 RULES 段】` apply only when the receiver explicitly installs and enables the corresponding integration. They may describe a neutral ecosystem role, but they never select the receiver's default owner-contact channel; that preference belongs in a private local overlay.

Build a Codex profile with `install/Build-CodexRulesProfile.ps1`, or install it with `install/Install-CodexRulesProfile.ps1`. Existing target files are backed up before replacement. Add `-InstallSystemPrompt -InstallRecommendedDesktopFeatures` only when the receiver wants the shared system prompt and the currently tested Desktop feature tables merged into its existing config. A real local override remains receiver-private and is ignored by package creation.

The Codex `system-prompt.template.md` is an optional receiver-installed model-instructions file shared by all four profiles. It reinforces following AGENTS user rules when the host supports this setting and never overwrites a host configuration automatically.

Reinstallation replaces the composed AGENTS file: supply the receiver's existing private `-LocalOverridePath` on every rebuild/install. The installer does not extract a private tail from an old mixed AGENTS file. Before updating such a file, separate and verify its private overlay; do not treat an installation without that argument as automatic preservation. Existing files are backed up, and unrelated private guidance files are left untouched.

Shared MCP capabilities vary by host. Use `chain`, `dataChain`, and `modelChain` only when the installed tool documents them, and treat Windsurf-specific automation as opt-in rather than a default shared capability.

After import, the receiver should set personal style, host-specific paths, installed tools, model preferences, and authorization locally.

## Codex core and trigger-read topics

AGENTS keeps the essential preferences, privacy/authority boundaries and explicit reading triggers. Longer procedures have one authoritative topic rather than repeated version/incident patches:

| Topic | Read before |
|---|---|
| `engineering-workflow.md` | Planning sustained/complex work, allocating resources or coordinating tasks |
| `maintenance-upgrades.md` | Upgrading, switching or publishing tools; its Git identity section applies to every local commit |
| `design-writing.md` | Creating design, slides, scripts or documents for actual readers |
| `communication-bridges.md` | Using an installed NapCat, WeChat or Tencent Docs bridge |
| `sandbox-runtime.md` / `web-visual.md` | Resource/time/output handling or web/file visual work respectively |

Every profile installs these six topics; role profiles additionally install their own machine manual. A file existing on disk does not prove automatic injection: check the effective project trust/configuration and the actual task's instruction source, and distinguish explicit manual reading from automatic loading. Running tasks, new tasks and resumed tasks are separate evidence cases.

The workflow separates Astra scheduling and route/progress reviews, adds hypothesis-driven artifact checks and realistic long-path acceptance, and keeps auxiliary-task scheduling autonomous within existing authority. It prohibits grandchild agents and `sandbox_codex` without disabling ordinary Sandbox execution. Model names and efforts are receiver-editable preferences, not availability or billing promises.

Design work establishes an image-generated reference with the user before asset production and implementation, then checks the actual artifact for templated language and visuals. Concrete, independent responses and consistent commitments matter; neither elaborate warmth nor defensive disclaimers substitute for responding to the person or delivering the agreed work.

Keep private network windows, identities, repositories, bindings and personal history in a repository-external override. The example file is not a ready-to-install private overlay. Publishing this template does not deploy it to another machine or authorize an offline machine's queued upgrade.
