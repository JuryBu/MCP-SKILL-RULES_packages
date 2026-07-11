# Skills Manifest

Generated for the 2026-07-11 refresh. These are allow-listed portable user-side skills, not system bundled skills or plugin cache skills. Package validation checks every listed skill directory and its `SKILL.md`; byte-size snapshots are intentionally omitted because they become stale after harmless documentation edits.

| Skill | Files | Notes |
| --- | ---: | --- |
| `algorithmic-art` | 4 | Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. |
| `brand-guidelines` | 2 | Applies Anthropic brand colors and typography when that visual identity is appropriate. |
| `canvas-design` | 83 | Creates polished static visual art in PNG and PDF formats. |
| `frontend-design` | 2 | Builds distinctive production-grade web interfaces and components. |
| `imagegen` | 11 | Generates and edits images through an OpenAI Image API workflow. |
| `internal-comms` | 6 | Provides reusable internal-communication formats and workflows. |
| `jupyter-notebook` | 12 | Creates and edits reproducible Jupyter notebooks. |
| `mcp-builder` | 10 | Guides design and implementation of Model Context Protocol servers. |
| `pdf` | 4 | Reads, creates, and visually validates PDF documents. |
| `playwright` | 9 | Automates real browser workflows for testing and extraction. |
| `screenshot` | 11 | Captures desktop, window, and region screenshots. |
| `skill-creator` | 18 | Creates, improves, and evaluates reusable skills. |
| `slack-gif-creator` | 7 | Creates animated GIFs optimized for Slack. |
| `theme-factory` | 13 | Applies reusable visual themes to documents and web artifacts. |
| `webapp-testing` | 6 | Tests local web applications with Playwright. |
| `web-artifacts-builder` | 5 | Builds multi-component HTML artifacts with modern frontend tools. |

## Excluded By Design

- `.system/` skills: installed by Codex itself and may change with Codex releases.
- Plugin cache skills: should be installed through the plugin system, not copied from another machine.
- Runtime/build artifacts: `node_modules`, `dist`, `build`, `__pycache__`, temp output, generated test decks, logs, sessions, cookies, auth files, and database files.

## Excluded Skills

| Skill | Reason |
| --- | --- |
| `docx` | Local license restricts copying / redistribution; receiver should install a licensed equivalent. |
| `pptx` | Local license restricts copying / redistribution; receiver should install a licensed equivalent. |
| `xlsx` | Local license restricts copying / redistribution; receiver should install a licensed equivalent. |
| `doc-coauthoring` | No local license file was present during packaging. |
| `.system/*` | Codex bundled skills, versioned with Codex itself. |
| plugin cache skills | Install through the plugin system rather than copying another machine's cache. |

## Notes

- `brand-guidelines` is brand-specific and should be used only when Anthropic brand styling is appropriate.
- `internal-comms` is a generic internal communications workflow template in this package; receivers should adapt organization-specific formats locally.
