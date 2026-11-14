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

# 1. Back up any existing rule files before overwriting
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

# 2. Render <USER> placeholders and install templates (leaves personal-care.local.md untouched)
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

## 三、接收方本地调整项、双机角色防撞与生效验证

1. **本地调整项与双机角色自知（`development` vs `training`）**：
   - **双机角色标记（多机用户必配）**：若同时维护开发机（`development`）与训练机（`training`），安装后请在各自机器的 `%USERPROFILE%\.gemini\GEMINI.md` 第七节及仓库外的 `%USERPROFILE%\.gemini\guidance\personal-care.local.md` 中明确标出本机 `local_role`（使助手清楚自己是「开发机的反重力」还是「训练机的反重力」，并在 Git 提交时分别使用 `[Antigravity/dev]` 与 `[Antigravity/training]` 正交双标，不混用署名）。后续若训练机需增加条件式训练监督规则，建议独立存为 `guidance\training-machine.md` 按需读取，不覆盖跨机共享的 `GEMINI.template.md`。
   - **语气与模型/MCP 列表**：可在本地 `GEMINI.md` 第一节调整语气风格，按实际订阅与 `templates/config.antigravity.example.json` 调整可用模型档位与 MCP 服务（未配 `exa` 时自动降级 `search_web`）。
2. **生效验证**：
   - 保存后在 Antigravity 2.0 新开一条对话（无需重启宿主），用一个纯只读小问题验证：让助手确认已注入 `GEMINI.md`（2.0 模块化版），复述本机机器角色（若已配置 `development` / `training`）及对应 Git 双标格式、单文件 `24,000 bytes` 预算线、`call_mcp_tool` `10 KiB` 落盘位置与 `schedule` 双模式的区别。
