# Private Exclude Checklist

打包发送前，检查工具包内不应出现以下内容：

- 发送方真实用户名路径。
- 发送方生日、账号 ID、社交主页链接。
- Codex 或网页登录认证文件。
- Codex sqlite 数据库、日志数据库、wal/shm 伴随文件。
- `sessions`、`archived_sessions`、真实对话 Record。
- `memory-store/workspaces`、`memory-store/general`。
- `cookies-backup.json`、`localstorage-backup.json`、浏览器 profile。
- `node_modules`、`dist`、大日志文件。

推荐检查命令：

```powershell
Select-String -Path .\**\* -Pattern '<发送方用户名>','<发送方生日>','<发送方账号ID>' -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -Directory -Include node_modules,dist,sessions,workspaces,sandbox-data
Get-ChildItem -Recurse -File -Include auth.json,*.sqlite,*.sqlite-wal,*.sqlite-shm
```

- Windsurf / Cascade local conversation data and ~/.codeium/windsurf runtime state must not be packaged.

## Skills-specific checks

- Do not package `%USERPROFILE%/.codex/skills/.system`.
- Do not package `%USERPROFILE%/.codex/plugins/cache`.
- Remove `node_modules`, `dist`, `__pycache__`, generated tests, logs, auth files, cookies, sessions, and local outputs from skills.
