# MCP-SKILL-RULES Packages

面向 AI 编程环境的可移植 MCP + Rules 工具包。

本仓库打包了一套 source-only 的 MCP 工具体系，以及经过脱敏处理的 Rules 模板。当前版本重点支持三个宿主：

- Antigravity
- Codex
- Claude Code

当前快照聚焦 **MCP + Rules**。`skills` 暂未打包进本仓库，仓库名里的 `SKILL` 作为后续公开 skill 包的预留位置。

---

## 包含内容

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| MCP servers | `mcps/` | `memory-store`、`web-fetcher`、`sandbox` 和可移植 HTTP broker |
| Rules 模板 | `rules/` | Codex、Antigravity、Claude Code 三套独立模板 |
| 安装脚本 | `install/` | Windows PowerShell 构建、配置、broker 启停和 smoke test 脚本 |
| 配置模板 | `templates/` | Codex、Antigravity、Claude Code 和环境变量示例 |
| 测试样例 | `design-tests/` | 本地测试页面和 MCP HTTP smoke test 辅助文件 |

## 当前版本

| 组件 | 版本 |
| --- | --- |
| `memory-store` | `1.14.0` |
| `sandbox` | `1.13.1` |
| `web-fetcher` | `7.0.0` |
| `codex-mcp-http-broker` | `0.1.0` |

## 三源互通

这套工具最早来自 Antigravity 内部自用 MCP，现在已经整理成 Antigravity / Codex / Claude Code 三源兼容的共享工具包。

支持的链路取值包括：

- `antigravity`
- `codex`
- `claude-code` / `cc`

在支持的工具里，可以用 `chain`、`dataChain`、`modelChain` 分别控制默认链路、对话数据来源和模型调用来源。

示例：

- `dataChain="claude-code"`：读取 Claude Code 本地对话数据
- `modelChain="codex"`：使用 Codex 模型桥完成模型辅助任务
- `modelChain="antigravity"`：强制使用 Antigravity Language Server 链路
- `modelChain="claude-code"`：显式使用 Claude Code CLI；默认不建议隐藏式自动消耗 CC 额度

## Windows 快速开始

环境要求：

- Node.js 18+
- npm
- PowerShell
- 按需安装 Codex、Antigravity 或 Claude Code

构建并测试：

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
./install/Stop-CodexMcpBroker.ps1
```

broker 默认暴露以下本地 endpoint：

```text
http://127.0.0.1:14588/memory-store/mcp
http://127.0.0.1:14588/web-fetcher/mcp
http://127.0.0.1:14588/sandbox/mcp
http://127.0.0.1:14588/exa/mcp          # 可选，需要接收方自行配置 Exa URL
```

## Rules 模板

不同宿主使用不同模板：

- Codex：`rules/codex/AGENTS.template.md`
- Codex 可选 system prompt：`rules/codex/system-prompt.template.md`
- Antigravity：`rules/antigravity/GEMINI.template.md`
- Claude Code：`rules/claude-code/CLAUDE.template.md`

这套 Rules 目前是「猫娘 / 朋友式协作」版本，核心目标不是角色扮演本身，而是让 AI 更像一个会正常交流的长期协作者：少一点模板腔、报告腔和伪人味，多一点自然反馈、主动确认、证据意识和边界感。

当前 Rules 覆盖：

- Codex
- Claude Code（CC）
- Antigravity

这些文件都是模板。正式使用前请自行调整说话风格、身份信息、模型偏好和本机路径。

## 隐私边界

本仓库只应包含源码、模板、文档和测试样例。

不要提交：

- API Key 或带 Key 的远程 MCP URL
- cookies、浏览器 profile、auth 文件、sessions、日志
- 真实 memory-store 数据或 Record 文件
- SQLite 数据库或 JSONL 对话历史
- 本机绝对路径
- 私人账号链接或个人标识信息

发布前建议运行：

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS="<用分号分隔你的私有标记>"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## 仓库结构

```text
.
├─ mcps/
│  ├─ broker/
│  ├─ memory-store/
│  ├─ sandbox/
│  └─ web-fetcher/
├─ rules/
│  ├─ codex/
│  ├─ antigravity/
│  └─ claude-code/
├─ install/
├─ templates/
├─ design-tests/
├─ PACKAGE_MANIFEST.md
├─ PRIVATE_EXCLUDE_CHECKLIST.md
├─ TOOLKIT_README.md
└─ SETUP.md
```

## License

MIT. See `LICENSE`.

---

# English

Portable MCP + Rules package for AI coding environments.

This repository packages a source-only MCP tool stack plus privacy-scrubbed Rules templates for three hosts:

- Antigravity
- Codex
- Claude Code

This snapshot focuses on **MCP + Rules**. Skills are intentionally not bundled yet; `SKILL` in the repository name is reserved for future public skill packaging.

## Included

| Area | Path | Notes |
| --- | --- | --- |
| MCP servers | `mcps/` | `memory-store`, `web-fetcher`, `sandbox`, and a portable HTTP broker |
| Host rules | `rules/` | Separate templates for Codex, Antigravity, and Claude Code |
| Install scripts | `install/` | Windows PowerShell scripts for build, config, broker lifecycle, and smoke tests |
| Config templates | `templates/` | Codex, Antigravity, Claude Code, and environment examples |
| Smoke tests | `design-tests/` | Local pages and MCP HTTP smoke test helpers |

## Current Versions

| Component | Version |
| --- | --- |
| `memory-store` | `1.14.0` |
| `sandbox` | `1.13.1` |
| `web-fetcher` | `7.0.0` |
| `codex-mcp-http-broker` | `0.1.0` |

## Three-Host Compatibility

The stack has evolved from an Antigravity-only internal experiment into a shared package for Antigravity, Codex, and Claude Code.

Supported chain values include:

- `antigravity`
- `codex`
- `claude-code` / `cc`

Where supported, tools accept `chain`, `dataChain`, and `modelChain` to route default behavior, conversation data, and model calls separately.

Examples:

- `dataChain="claude-code"` reads Claude Code local conversation data.
- `modelChain="codex"` uses the Codex model bridge.
- `modelChain="antigravity"` forces the Antigravity Language Server route.
- `modelChain="claude-code"` explicitly uses Claude Code CLI; hidden automatic CC quota usage is intentionally avoided by default.

## Quick Start On Windows

Requirements:

- Node.js 18+
- npm
- PowerShell
- Codex, Antigravity, or Claude Code depending on your target host

Build and smoke test:

```powershell
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
./install/Stop-CodexMcpBroker.ps1
```

Default broker endpoints:

```text
http://127.0.0.1:14588/memory-store/mcp
http://127.0.0.1:14588/web-fetcher/mcp
http://127.0.0.1:14588/sandbox/mcp
http://127.0.0.1:14588/exa/mcp          # optional, requires receiver-side Exa URL
```

## Rules Templates

- Codex: `rules/codex/AGENTS.template.md`
- Optional Codex system prompt: `rules/codex/system-prompt.template.md`
- Antigravity: `rules/antigravity/GEMINI.template.md`
- Claude Code: `rules/claude-code/CLAUDE.template.md`

The current Rules are a catgirl / friendly-collaborator variant. The point is not roleplay for its own sake; the practical goal is to make AI agents sound more human and less uncanny or template-like, while preserving directness, evidence discipline, boundary awareness, and useful progress updates.

Currently supported hosts:

- Codex
- Claude Code (CC)
- Antigravity

These are templates. Review and edit personal style, identity details, model preferences, and local paths before using them.

## Privacy Boundary

This repository should only contain source code, templates, docs, and test samples.

Do not commit:

- API keys or remote MCP URLs with embedded keys
- cookies, browser profiles, auth files, sessions, or logs
- real memory-store data or Record files
- SQLite databases or JSONL conversation histories
- machine-specific absolute paths
- private account links or personal identifiers

Recommended pre-publish check:

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS="<private markers separated by semicolons>"
./install/Test-CodexToolkit.ps1 -PackageClean
```

## Repository Layout

```text
.
├─ mcps/
│  ├─ broker/
│  ├─ memory-store/
│  ├─ sandbox/
│  └─ web-fetcher/
├─ rules/
│  ├─ codex/
│  ├─ antigravity/
│  └─ claude-code/
├─ install/
├─ templates/
├─ design-tests/
├─ PACKAGE_MANIFEST.md
├─ PRIVATE_EXCLUDE_CHECKLIST.md
├─ TOOLKIT_README.md
└─ SETUP.md
```

## License

MIT. See `LICENSE`.
