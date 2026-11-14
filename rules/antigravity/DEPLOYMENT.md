# Antigravity 2.0 Rules 部署说明

## 一、为什么从单文件拆分为「常驻核心 + 按需专题 + 工具手册」

Antigravity 2.0（`oneharness` 架构）对规则文件有两道硬性限制：

1. **单规则文件字节硬上限 `24,000 bytes`**：超出部分按行静默截断（旧版 1.x 单体 `45 KB` 模板在 2.0 下后半截工具规范会被截断丢失）。
2. **全局常驻规则总预算 `20,000 tokens`**：超出时整份常驻规则会被降级为路径指针，不再每轮自动注入。

因此，本目录将 Antigravity 2.0 规则拆分为 **1 份 `< 24 KB` 常驻核心** + **4 份事件驱动按需专题** + **1 份工具与环境按需 Skill** + **1 份仓库外私有覆盖示例**：

| 仓库模板路径 | 本机目标安装路径 | 加载机制与预算要求 |
|---|---|---|
| `GEMINI.template.md` | `%USERPROFILE%\.gemini\GEMINI.md` | 每轮常驻注入；替换 `<USER>` 后须实测 **`< 24,000 bytes`** |
| `guidance/engineering-workflow.template.md` | `%USERPROFILE%\.gemini\guidance\engineering-workflow.md` | 复杂/跨阶段工程开工与恢复前按需读取（`< 24,000 bytes`） |
| `guidance/design-writing.template.md` | `%USERPROFILE%\.gemini\guidance\design-writing.md` | 前端、3D、海报、PPT、正式文书创作前按需读取 |
| `guidance/web-visual.template.md` | `%USERPROFILE%\.gemini\guidance\web-visual.md` | 浏览器交互、登录墙、`file://` 原生预览与视觉验收前按需读取 |
| `guidance/maintenance-upgrades.template.md` | `%USERPROFILE%\.gemini\guidance\maintenance-upgrades.md` | 改配置、写回退脚本、本地 Git 提交与共享仓脱敏同步前按需读取 |
| `skills/tools-reference/SKILL.template.md` | `%USERPROFILE%\.gemini\antigravity\skills\tools-reference\SKILL.md` | 调 Lazy MCP、跨端读原文、遇 `10 KiB` 落盘或 `256k/5m0s` 压缩前按需读取 |
| `local-care.example.md` | `%USERPROFILE%\.gemini\guidance\personal-care.local.md`（可选） | **仅在仓库外自建**；存放个人偏好、作息与私有素材库路径，严禁入 Git |

---

## 二、推荐备份与部署步骤（PowerShell）

升级前请先备份本机现有 `.gemini` 规则，在仓库根目录（或 `rules\antigravity` 目录）运行以下脚本，从 `$env:USERPROFILE` 自动推导真实用户目录前缀完成替换与写入：

```powershell
$ErrorActionPreference = "Stop"
$UserProfileSlash = ($env:USERPROFILE -replace '\\', '/').TrimEnd('/')
$ProfileLeaf = Split-Path -Leaf $env:USERPROFILE
$GeminiRoot = Join-Path $env:USERPROFILE ".gemini"
$BackupDir = Join-Path $GeminiRoot ("backups\rules\" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-before-sync")
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

# 1. 备份已有文件
foreach ($rel in @(
    "GEMINI.md",
    "guidance\engineering-workflow.md",
    "guidance\design-writing.md",
    "guidance\web-visual.md",
    "guidance\maintenance-upgrades.md",
    "antigravity\skills\tools-reference\SKILL.md"
)) {
    $existing = Join-Path $GeminiRoot $rel
    if (Test-Path -LiteralPath $existing) {
        $bakTarget = Join-Path $BackupDir $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bakTarget) | Out-Null
        Copy-Item -LiteralPath $existing -Destination $bakTarget -Force
    }
}

# 2. 渲染用户目录占位符并安装模板（不会触碰本机已有的 personal-care.local.md）
$ToolkitAntigravityRoot = Join-Path (Get-Location) "rules\antigravity"
if (-not (Test-Path -LiteralPath $ToolkitAntigravityRoot) -and (Test-Path -LiteralPath ".\GEMINI.template.md")) {
    $ToolkitAntigravityRoot = (Get-Location).Path
}
$Map = @{
    "GEMINI.template.md"                              = "GEMINI.md"
    "guidance\engineering-workflow.template.md"       = "guidance\engineering-workflow.md"
    "guidance\design-writing.template.md"             = "guidance\design-writing.md"
    "guidance\web-visual.template.md"                 = "guidance\web-visual.md"
    "guidance\maintenance-upgrades.template.md"       = "guidance\maintenance-upgrades.md"
    "skills\tools-reference\SKILL.template.md"        = "antigravity\skills\tools-reference\SKILL.md"
}

foreach ($entry in $Map.GetEnumerator()) {
    $src = Join-Path $ToolkitAntigravityRoot $entry.Key
    $dst = Join-Path $GeminiRoot $entry.Value
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    $rendered = (Get-Content -LiteralPath $src -Raw -Encoding UTF8).Replace("C:/Users/<USER>", $UserProfileSlash).Replace("<USER>", $ProfileLeaf)
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    if ($utf8NoBom.GetByteCount($rendered) -ge 24000) {
        throw "Rendered file exceeds 24,000 bytes limit: $dst"
    }
    [System.IO.File]::WriteAllText($dst, $rendered, $utf8NoBom)
    Write-Host "[OK] Installed $dst ($($utf8NoBom.GetByteCount($rendered)) bytes)"
}
```

如需配置个人陪伴偏好与本机私有素材库入口，可将 `local-care.example.md` 复制为 `%USERPROFILE%\.gemini\guidance\personal-care.local.md` 并在本机单独编辑。

---

## 三、接收方本地调整项与生效验证

1. **本地调整项**：
   - 语气与角色风格（默认猫娘搭档口吻，可在本地 `GEMINI.md` 第一节改为中性工程风格）；
   - 已安装的 MCP 服务列表（见 `templates/config.antigravity.example.json`；若未配置 `exa`，按规则自动降级 `search_web`）；
   - 本机订阅实际可用的模型名称与思考档（模板默认主力 `Gemini 4 Carbon High`、先遣手脚 `Gemini 4 Hydrogen XHigh`）。
2. **生效验证**：
   - 保存后在 Antigravity 2.0 新开一条对话（无需重启宿主），用一个纯只读小问题验证：让助手确认已注入 `GEMINI.md`（2.0 模块化版），说出单文件 `24,000 bytes` 预算线、`call_mcp_tool` `10 KiB` 落盘位置以及 `schedule` 双模式（单次短巡检 Timer 与 `*/20` 持续工程防断 Cron）的区别。
