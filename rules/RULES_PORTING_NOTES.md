# Rules Porting Notes

## Preserved

- Chinese-first collaboration style and concise progress updates.
- Work-mode distinction: chat vs. task execution.
- Subagent / council usage boundaries and evidence requirements.
- MCP usage rules for `memory-store`, `web-fetcher`, `sandbox`, and optional `exa`.
- Four-source chain model: `antigravity`, `codex`, `claude-code` / `cc`, and `windsurf` / `wsf`.
- `dataChain` and `modelChain` split-routing guidance.
- Exa-first search discipline, with fallback only after explicit unavailability or no-result evidence.
- PPT/PDF/DOCX/XLSX skill and visual QA expectations where applicable.
- Stage Guard / Record / conversation-reading discipline.

## Removed or Replaced

- Birthday, personal account links, and login-state claims.
- Sender-specific absolute paths.
- Private memory, local project paths, and historical private workspace references where they would identify the sender.
- sender-specific project branding.
- API key material and private broker env contents.

## Receiver Must Adjust

- Personal speaking style and identity details.
- Real MCP config paths for their host apps.
- Whether Claude Code fallback is allowed automatically; default recommendation is explicit-only to avoid hidden CC quota use.
- Windsurf global rules location and whether `dataChain=windsurf` should be enabled for local Cascade history.
- Whether the receiver wants to enable the Windsurf-only `mcp-subagent`; if yes, run its dry-run, backup, apply, validation, and rollback flow locally instead of blindly copying the sender's broker/config state.
- Exa URL/API key location. Keep it in private local env/config, never in package files.
- Any model names unavailable on the receiver machine.
