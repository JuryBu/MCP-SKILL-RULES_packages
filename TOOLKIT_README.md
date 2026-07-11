# Receiver Guide / 接收方说明

这是一份源码型工具包，不包含发送者的登录态、记忆、对话或 API Key。

## 你会得到什么

- 三个通用 MCP：memory-store 1.19.3、web-fetcher 7.0.0、sandbox 1.15.1。
- 一个 portable HTTP broker 0.1.0，用于 Codex 和其他支持 HTTP MCP 的宿主。
- 一个 Windsurf-only subagent 1.1.0，只在你明确安装并登录 Windsurf 后使用。
- Codex、Antigravity、Claude Code、Windsurf 四套脱敏 Rules。
- 16 个可迁移 Skills、安装脚本、配置模板和 smoke test（基础功能验证测试）。

## 最短安装路径

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Apply-CodexConfig.ps1
./install/Test-CodexToolkit.ps1
```

然后把 `rules/codex/AGENTS.template.md` 合并到自己的 `%USERPROFILE%/.codex/AGENTS.md`，按需复制 `skills/` 中的技能目录。

## 单宿主与多宿主

- 只有 Codex：可以直接使用，数据默认写入 `%USERPROFILE%\.codex-toolkit`。
- 安装多个宿主：memory-store 可按 `dataChain` 读取对应宿主对话，再按 `modelChain` 选择执行摘要或审查的模型。
- Windsurf 只提供对话数据链路；本工具包不提供 Windsurf 模型桥。
- Grok / ProGrok 只提供模型链路，必须由你自己运行兼容 proxy 并提供私有凭据。

## 不会自动做的事

- 不会复制发送者数据。
- 不会安装或启动 ProGrok。
- 不会自动登录任何网站或宿主。
- 不会自动修改 Windsurf 配置或创建 Cascade 子代理。
- 不会安装缺失的授权受限 Office skills。

完整配置见 `SETUP.md`，组件细节见 `mcps/README_MCPS.md`，Rules 部署见 `rules/README_RULES.md`。

---

This is a source-only receiver package. It includes portable MCP servers, broker scripts, four-host rules, sixteen allow-listed skills, configuration examples, and smoke tests. It does not include sender credentials, browser state, memories, conversations, logs, or databases.

Run `install/Test-CodexToolkit.ps1 -PackageClean` first, then follow `SETUP.md`. ProGrok, Exa credentials, signed-in browser profiles, and Windsurf Cascade access are receiver-managed optional dependencies.
