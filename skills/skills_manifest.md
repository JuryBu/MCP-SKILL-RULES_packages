# Skills Manifest

Generated for the 2026-06-24 refresh. These are allow-listed portable user-side skills, not system bundled skills or plugin cache skills.

| Skill | Files | Size KB | Notes |
| --- | ---: | ---: | --- |
| `algorithmic-art` | 4 | 58.4 | Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, gener... |
| `brand-guidelines` | 2 | 13.3 | Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand co... |
| `canvas-design` | 83 | 5423.8 | Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art... |
| `frontend-design` | 2 | 14.7 | Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifact... |
| `imagegen` | 11 | 84.3 | Use when the user asks to generate or edit images via the OpenAI Image API (for example: generate image, edit/inpaint/mask, background removal or replacement... |
| `internal-comms` | 6 | 21.9 | A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenev... |
| `jupyter-notebook` | 12 | 30.8 | Use when the user asks to create, scaffold, or edit Jupyter notebooks (`.ipynb`) for experiments, explorations, or tutorials; prefer the bundled templates an... |
| `mcp-builder` | 10 | 119.3 | Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use whe... |
| `pdf` | 4 | 14.7 | Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter; prefer visual checks by rendering pages (Poppler) and use... |
| `playwright` | 9 | 22.3 | Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging)... |
| `screenshot` | 11 | 52.2 | Use when the user explicitly asks for a desktop or system screenshot (full screen, specific app or window, or a pixel region), or when tool-specific capture ... |
| `skill-creator` | 18 | 218.6 | Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize ... |
| `slack-gif-creator` | 7 | 42.7 | Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users reques... |
| `theme-factory` | 13 | 140.7 | Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors... |
| `webapp-testing` | 6 | 21.9 | Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing... |
| `web-artifacts-builder` | 5 | 45.2 | Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use ... |

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
