# Portable MCP + Rules 工具包（2026-6-5）

这是一份给 Windows 上的 Codex、Antigravity、Claude Code、Windsurf 共用的本地工具包，包含四源兼容 MCP 源码、HTTP broker、四套脱敏 Rules 模板和基础测试文件。本版不包含 skills。

## 今日重点

- MCP 已从 Codex + Antigravity 双链路升级为 Antigravity / Codex / Claude Code / Windsurf 四源兼容。
- `memory-store`、`web-fetcher`、`sandbox` 支持四源数据链路；`windsurf` / `wsf` 用于 Cascade 对话数据，模型调用仍走 Antigravity / Codex / Claude Code。
- `exa` 作为可选远程 MCP endpoint，经 broker 暴露给 Codex / Claude Code / Windsurf；API Key 只应放接收方本机环境变量或私有配置。
- Rules 分四套标记：`rules/codex/AGENTS.template.md`、`rules/antigravity/GEMINI.template.md`、`rules/claude-code/CLAUDE.template.md`、`rules/windsurf/Windsurf_Global_Rules.template.md`。

## 当前 MCP 版本

- `memory-store`：`1.15.3`
- `web-fetcher`：`7.0.0`
- `sandbox`：`1.13.3`
- `broker`：`0.1.0`
- `exa`：可选远程 MCP endpoint；需要接收方自己设置 `EXA_MCP_REMOTE_URL` 或 `CODEX_TOOLKIT_EXA_MCP_REMOTE_URL`。

## Codex 安装

```powershell
./install/Install-CodexToolkit.ps1
./install/Apply-CodexConfig.ps1
./install/Start-CodexMcpBroker.ps1
./install/Test-CodexToolkit.ps1
```

然后把 `rules/codex/AGENTS.template.md` 合并到 `%USERPROFILE%/.codex/AGENTS.md`。

如需同步 Codex system prompt：

```powershell
./install/Install-SystemPromptTemplate.ps1
```

并确认 `%USERPROFILE%/.codex/config.toml` 顶层包含：

```toml
model_instructions_file = "~/.codex/prompts/system-prompt.md"
```

## Antigravity Rules

把 `rules/antigravity/GEMINI.template.md` 合并到接收方 Antigravity 使用的 `GEMINI.md`。

如果接收方也要让 Antigravity 直接跑这些 MCP，可参考 `templates/config.antigravity.example.json`，但不要把 API Key、cookies、登录态、真实 memory 数据写进要发送的文件。

## Claude Code Rules

把 `rules/claude-code/CLAUDE.template.md` 合并到 `%USERPROFILE%/.claude/CLAUDE.md`。

Claude Code 的 MCP user-scope 配置可参考 `templates/config.claude.example.json`。实际写入时推荐在接收方机器上用 Claude Code 自己的 MCP 配置命令或手动合并到用户配置，不要把私钥写进项目文件。

## 数据目录

默认运行态数据写到：

```text
%USERPROFILE%/.codex-toolkit/
```

可以通过 `templates/env.example.ps1` 改位置。Antigravity / Codex / Claude Code / Windsurf 共享同一套 MCP 时，要让它们指向同一个 broker 和同一个数据目录，才能实现记忆、Record、会话读取等能力互通。

## 隐私边界

这个包只应包含源码、模板、说明和测试样例。不要包含发送方或接收方的 API Key、cookies、浏览器 profile、对话记录、记忆库、sqlite、sessions、日志、本机绝对路径或账户链接。

## 2026-6-5 refresh

This snapshot refreshes memory-store to 1.15.3, sandbox to 1.13.3, keeps web-fetcher at 7.0.0, and refreshes Codex / Claude Code rules from the current local templates after privacy scrubbing.


## Windsurf / WSF refresh

This snapshot includes `rules/windsurf/Windsurf_Global_Rules.template.md` and `templates/config.windsurf.example.json`. Windsurf is supported as a fourth data source for Cascade conversation history where MCP tools expose `dataChain=windsurf`; model calls should still use Codex, Antigravity, or Claude Code routes.
