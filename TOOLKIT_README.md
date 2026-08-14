# Receiver Guide / 接收方说明

这是一份源码型工具包，不包含发送者的登录态、记忆、对话或 API Key。

## 你会得到什么

- 三个通用 MCP：memory-store 1.22.10、web-fetcher 7.0.0、sandbox 1.17.2。
- 一个 portable HTTP broker 0.1.0，用于 Codex 和其他支持 HTTP MCP 的宿主。
- 一个 Windsurf-only subagent 1.1.0，只在你明确安装并登录 Windsurf 后使用。
- 一个可选 NapCat MCP 0.3.14，用于 QQ 群通知、跨设备任务账本、可信路由、Codex 对话唤醒和群文件传输；需要你自己的 NapCat、QQ 登录与群绑定。
- Codex、Antigravity、Claude Code、Windsurf 四宿主脱敏 Rules；Codex 额外提供中性、普通猫娘、开发机猫娘、训练机猫娘四种组合。
- 18 个许可证允许迁移的 Skills、安装脚本、配置模板和 smoke test（基础功能验证测试）。

## 最短安装路径

```powershell
./install/Test-CodexToolkit.ps1 -PackageClean
./install/Install-CodexToolkit.ps1
./install/Start-CodexMcpBroker.ps1
./install/Apply-CodexConfig.ps1
./install/Test-CodexToolkit.ps1
```

`Apply-CodexConfig.ps1` 与 `Install-CodexRulesProfile.ps1` 都会保证 Codex 的 `project_doc_max_bytes` 至少为 `65536`，避免较长的开发机或训练机 Rules 在 32K 附近被截断。

需要同步安装公共 system prompt 和当前 Codex Desktop 的时间提醒、结构化提问等交互配置时，使用 `Install-CodexRulesProfile.ps1 -InstallSystemPrompt -InstallRecommendedDesktopFeatures`。脚本先备份再精确合并，不覆盖其它私有 `config.toml` 内容；仍依赖旧版独立 Codex CLI 的接收方应暂不启用该 Desktop 功能开关。

然后按自己的使用方式安装 Codex Rules，例如保留原有自然猫娘表达：

```powershell
./install/Install-CodexRulesProfile.ps1 -Profile catgirl
```

可选值还有 `neutral`、`development`、`training`。脚本会先备份已有 `%USERPROFILE%/.codex/AGENTS.md`，再由公共工程核心和所选角色组件生成新文件；开发机、训练机的真实账号、路径和群绑定应放在仓库外的私有覆盖文件中，通过 `-LocalOverridePath` 传入。最后按需复制 `skills/` 中的技能目录。

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
- 不会安装 NapCat、登录 QQ、绑定群聊或启用 `/napcat/mcp`。
- 不会安装缺失的授权受限 Office skills。

完整配置见 `SETUP.md`，组件细节见 `mcps/README_MCPS.md`，Rules 部署见 `rules/README_RULES.md`。

需要启用 NapCat 与 Codex Desktop 原生未读提醒时，不要只复制一个 MCP URL；按 `mcps/napcat-mcp/INSTALL-CODEX.md` 完成 Broker 私有环境、NapCat 安装根、App Server 透明代理和重启验收。

---

This is a source-only receiver package. It includes portable MCP servers, broker scripts, four-host rules, four composable Codex profiles, seventeen license-reviewed skills, configuration examples, and smoke tests. It does not include sender credentials, browser state, memories, conversations, logs, databases, NapCat binaries, QQ login state, or real group bindings.

Run `install/Test-CodexToolkit.ps1 -PackageClean` first, then follow `SETUP.md`. ProGrok, Exa credentials, signed-in browser profiles, Windsurf Cascade access, and NapCat OneBot are receiver-managed optional dependencies.
