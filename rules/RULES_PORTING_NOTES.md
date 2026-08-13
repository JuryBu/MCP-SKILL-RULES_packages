# Rules Porting Notes

## Preserved

- Chinese-first collaboration style and concise progress updates.
- Work-mode distinction: chat vs. task execution.
- Subagent / council usage boundaries and evidence requirements.
- MCP usage rules for `memory-store`, `web-fetcher`, `sandbox`, optional `exa`, Windsurf subagent, and optional NapCat QQ group collaboration.
- Five-source chain model: `antigravity`, `codex`, `claude-code` / `cc`, `windsurf` / `wsf`, and read-only `dsh` / `deepseek-harness`; DSH is not a model provider.
- `dataChain` and `modelChain` split-routing guidance.
- Exa-first search discipline, with fallback only after explicit unavailability or no-result evidence.
- PPT/PDF/DOCX/XLSX skill and visual QA expectations where applicable.
- Stage Guard / Record / conversation-reading discipline.
- Council manifest ownership, stable `ownerId`, `antigravityCli` naming, and `dryRun` before any artifact cleanup.
- A shared Codex engineering core, with optional catgirl, development-machine, and training-machine overlays.

## Removed or Replaced

- Birthday, personal account links, and login-state claims.
- Sender-specific absolute paths.
- Private memory, local project paths, and historical private workspace references where they would identify the sender.
- sender-specific project branding.
- Credential material, private broker settings, and runtime environment details.
- Real dual-machine identities, trusted peer accounts, fixed group bindings, and machine-specific absolute paths.

## Receiver Must Adjust

- Personal speaking style and identity details.
- Real host configuration paths and installed MCP capabilities.
- Whether model fallback, cross-chain routing, and Windsurf-only automation are enabled locally.
- Whether the optional NapCat endpoint is enabled; the receiver must supply a private OneBot token and fixed-group binding.
- Fixed-group migrations are coordinated through private bindings and a shared cutover time; old and new group identities must not be committed to the public Rules.
- Which search provider, models, and background-task limits are available in the receiver's environment.
- Local authorization and credential storage; keep it outside package files.
- Which Codex profile to install. Put machine-private facts in a repository-external override copied from `codex/local-overrides.example.md`.
