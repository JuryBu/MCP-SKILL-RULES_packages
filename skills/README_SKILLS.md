# Skills Package

This folder contains portable user-side Codex skills copied from `%USERPROFILE%/.codex/skills` by allow-list.

## Included

Included skills are listed in `skills_manifest.md`. They are copied as source/workflow files only, with runtime and build artifacts removed.

## Excluded

- `.system/`: Codex bundled system skills. They are versioned with Codex itself and should not be copied from another machine.
- Plugin cache skills from `%USERPROFILE%/.codex/plugins/cache/`: install those through the plugin system instead.
- `docx/`, `pptx/`, `xlsx/`: excluded from the public package because their local `LICENSE.txt` files restrict copying / redistribution. Receivers should install official or licensed equivalents on their own machines.
- `doc-coauthoring/`: excluded because no local license file was present during packaging.
- Runtime/build artifacts: `node_modules`, `dist`, `build`, `__pycache__`, `.git`, temp folders, logs, generated test outputs, cookies, sessions, auth files, local database files, and browser state.

## Install Notes

Copy selected included skill folders into the receiver's Codex skills directory, usually:

```text
%USERPROFILE%/.codex/skills/
```

Then restart Codex or open a new session so the skill list is reloaded.

For hosts other than Codex, treat these as reference workflows: read the target `SKILL.md` and adapt it to the host's own skill/rule mechanism.

## Privacy Notes

This public package keeps only portable skill files. Receiver-specific credentials such as `OPENAI_API_KEY`, GitHub tokens, browser login state, and local file paths must stay outside the repository and outside zip packages.

`OPENAI_API_KEY` and similar strings may appear as environment-variable names in documentation or scripts; they are not bundled secret values.
