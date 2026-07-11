# Package Manifest（2026-07-11）

## Included

| Area | Contents |
| --- | --- |
| MCP | memory-store 1.19.3, web-fetcher 7.0.0, sandbox 1.14.0, broker 0.1.0 |
| Optional MCP | Windsurf-only mcp-subagent 1.1.0 |
| Rules | Codex, Antigravity, Claude Code, Windsurf global + five system fragments |
| Skills | 16 allow-listed portable user skills plus manifest |
| Setup | PowerShell build, broker, config, validation, and packaging scripts |
| Templates | Four host configs and receiver-private environment example |
| Tests | HTTP smoke helper, local pages, memory workspace, expected results |

## 2026-07-11 Changes

- memory-store upgraded from 1.17.1 to 1.19.3 with Grok model routing, split data/model chains, adaptive concurrency, background recovery, Record coordination, stable task status, and expanded Conversation / Stage Guard workflows.
- sandbox upgraded from 1.13.7 to 1.14.0 with ProGrok model bridge, Grok Council provider, vision input, provider concurrency, smarter search stages, and stronger background lifecycle behavior.
- web-fetcher kept version 7.0.0 and synchronized the current interaction and pipeline behavior.
- broker added dynamic long-call timeout forwarding, a 30-minute default cap, reliable shutdown state writes, and a portable Exa stateless bridge.
- Windsurf-only subagent upgraded from 0.0.1 to 1.1.0; cross-client broker patch and handoff scripts were removed from the public package.
- Windsurf Rules changed from one large template to a short global rule plus `tools`, `memory`, `collaboration`, `efficiency`, and `rendering` system fragments.
- Package validation now verifies Skills, Rules, config templates, forbidden runtime files, credential-shaped text, and absolute user paths.
- Added `install/New-PortableToolkitPackage.ps1` to create a verified directory, zip, and SHA256 without omitting Skills.

## Excluded

上游开发仓库中依赖本机 fixture、登录态或宿主内部数据的单元测试不属于分发内容。公开包保留 `npm run test:portable` 构建验证、HTTP smoke test（基础功能验证测试）和页面样例。

- API keys, private remote URLs, credentials, cookies, browser profiles, localStorage, sessions, auth files
- Real memory-store data, Records, conversations, workspaces, Cascade registries, archives
- SQLite / DB / JSONL files, logs, HAR files, state and PID files
- `node_modules`, `dist`, build output, coverage, test profiles, cache, temp, backup files
- Sender-specific identity, account links, paths, project history, model quota claims
- Codex `.system` skills, plugin cache skills, and skills whose local licenses do not allow redistribution
- ProGrok binaries, configuration, upstream account, and private proxy environment
