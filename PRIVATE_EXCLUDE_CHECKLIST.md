# Private Exclude Checklist

打包或推送前必须确认：

- 不含发送方生日、学校、账号 ID、主页链接、项目昵称或本机绝对路径；开源许可证中的公开作者署名属于法律归属，不按隐私泄露处理。
- 不含 API Key、Bearer token、private remote URL、`.env`、`broker-private.env.json`、凭据或证书文件。
- 不含 cookies、localStorage、浏览器 profile、网页登录态、Codex / Claude / Windsurf auth。
- 不含 sessions、对话、Record、memory workspace、Cascade registry、archive、handoff zip。
- 不含 SQLite / DB / JSONL / HAR / 日志 / PID / state 文件。
- 不含 `node_modules`、`dist`、build、coverage、`__pycache__`、temp、cache、备份文件。
- 不含 Council 运行产物与控制状态：`council-artifacts`、`council-tasks`、`council-quarantine`、索引、大输入、模型调用临时目录或 `agy-runtime` 租约。
- 不含 Codex `.system` skills、插件缓存或许可证不允许再分发的技能。
- 不含 ProGrok 安装、proxy 私有环境、上游账户或发送方模型配额信息。

推荐命令：

```powershell
$env:CODEX_TOOLKIT_PRIVATE_PATTERNS = "C:\\Users\\YourName;your-account-link;your-private-marker"
./install/Test-CodexToolkit.ps1 -PackageClean
```

生成发布包时使用：

```powershell
./install/New-PortableToolkitPackage.ps1 -OutputDirectory "D:\releases\toolkit"
```

脚本会分别验证源码树和复制后的包，并输出 zip SHA256。仍需在推送前人工查看 `git diff --stat`、`git diff --check` 和 `git status --short`。

Git 历史可能保留早期公开提交中的旧路径。清理历史属于破坏性操作，必须单独备份、说明影响并获得明确授权，不能在普通更新中自动重写。
