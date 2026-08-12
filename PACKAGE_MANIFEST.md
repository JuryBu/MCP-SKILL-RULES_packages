# Package Manifest（2026-08-05）

## Included

| Area | Contents |
| --- | --- |
| MCP | memory-store 1.22.8, web-fetcher 7.0.0, sandbox 1.17.0, broker 0.1.0 |
| Optional MCP | Windsurf-only mcp-subagent 1.1.0, NapCat QQ group collaboration 0.2.0 |
| Rules | Four composable Codex profiles, Antigravity, Claude Code, Windsurf global + five system fragments |
| Skills | 18 license-reviewed portable user skills plus manifest |
| Setup | PowerShell build, broker, config, validation, and packaging scripts |
| Templates | Four host configs and receiver-private environment example |
| Tests | HTTP smoke helper, local pages, memory workspace, expected results |

## 2026-08-05 Changes

- Codex Rules now separate a shared engineering core from optional catgirl, development-machine, and training-machine overlays. Four profile manifests build `neutral`, `catgirl`, `development`, and `training` configurations without duplicating the engineering workflow.
- Added Codex profile build and install scripts. Installation backs up overwritten AGENTS, guidance, and optional system-prompt files; real machine identities and bindings must be supplied through a repository-external local override.
- NapCat autostart now uses an internal windowless launcher plus a long-running supervisor watchdog, so interactive logon does not expose PowerShell consoles and unexpected supervisor exits are retried without replacing receiver-private state.
- Added public-safe Bug/compatibility and Feature Request Issue forms for cross-machine MCP maintenance.
- Common MCP versions are memory-store 1.22.8, web-fetcher 7.0.0, sandbox 1.17.0, broker 0.1.0, and Windsurf-only mcp-subagent 1.1.0.
- Memory Store 1.22.8 retains four-host persistent fetch generations, offline PB listing and context-only Recall, automatically migrates old or duplicate-round fetch caches, preserves full local PB response/tool totals for range reads, and keeps Codex heartbeat, automatic channel wakes and subagent notifications out of human rounds while preserving owner replies, attachments and delegation bodies.
- NapCat public source is refreshed to the current task-ledger, router, supervisor, and Codex wake-bridge snapshot while keeping runtime state, real bindings, login data, and credentials excluded.

## 2026-07-24 Baseline

- memory-store upgraded from 1.19.3 to 1.21.1 with production Record scheduling, source evidence, startup barriers, commit protocols, provider admission/control, AGY routing, unknown-chain migration, background-task suspension and expanded multi-host recovery behavior.
- sandbox 1.17.0 separates expected scheduling memory from the per-process-tree hard limit. Windows builds a local Job Object runner from public C# source, applies the limit before the command resumes, measures sub-two-second and descendant processes, and keeps the generated EXE outside the portable source package. Admission now uses physical memory, Windows commit headroom and pressure notifications; a blocked heavy queue head no longer freezes fitting small work, while aged requests receive bounded reserved capacity. Adaptive 100K-token/2000-line/1MiB delivery and six-hour overflow artifacts remain unchanged.
- the portable Sandbox Council root now follows `SANDBOX_DATA_ROOT`, keeping transcripts, indexes, task checkpoints, quarantine groups, and other runtime data outside the source tree.
- refreshed lockfiles build successfully on Node.js 18+. On 2026-07-24, `npm audit --omit=dev` reported no critical issues but did report transitive advisories: memory-store 9, web-fetcher 11, sandbox 8, and mcp-subagent 5; broker reported 0. The package does not run `npm audit fix --force` because breaking dependency rewrites must be evaluated upstream rather than silently applied during packaging.
- web-fetcher remains 7.0.0 and synchronizes the latest constants, interaction and pipeline behavior.
- broker adds an optional `/napcat/mcp` endpoint while keeping receiver data under `%USERPROFILE%\.codex-toolkit`; NapCat is disabled by default.
- Windsurf-only subagent remains 1.1.0 and synchronizes current process guarding, LS client, registry and config utilities without carrying Cascade data.
- NapCat MCP 0.1.0 adds fixed-group status, target discovery, recent-message reads, file download/upload, training events, structured task messages and heartbeat scripts. The package contains no NapCat runtime or QQ state.
- Codex, Antigravity, Claude Code and Windsurf Rules were refreshed from current sources with personal information removed; Codex system-prompt and Windsurf five-fragment system rules are included.
- Skills include the Apache-2.0 `hatch-pet` workflow and the MIT `wechat-docs-collaboration` governance workflow; redistribution-restricted Office skills remain excluded.
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
- NapCat binaries, QQ account state, QR codes, real group binding, OneBot token, heartbeat and dedupe state
