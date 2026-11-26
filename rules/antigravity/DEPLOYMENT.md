# Antigravity 2.0 Rules 部署说明

## 一、双版本组件架构与「常驻核心 + 按需专题 + 工具手册」拆分

Antigravity 2.0（`oneharness` 架构）对规则文件有两道硬性限制：

1. **单规则文件字节硬上限 `24,000 bytes`**：超出部分按行静默截断（旧版 1.x 单体 `45 KB` 模板在 2.0 下后半截工具规范会被截断丢失）。
2. **全局常驻规则总预算 `20,000 tokens`**：超出时整份常驻规则会被降级为路径指针，不再每轮自动注入。

因此，本目录对齐 Codex 规则体系，将 Antigravity 2.0 规则拆分为 **双版本人格组件（`catgirl` 猫娘搭档版 / `neutral` 通用无猫娘版）+ `variants/` 变体清单 + 5 份事件驱动按需专题 + 1 份工具与环境按需 Skill + 仓库外私有覆盖示例**（注：变体清单目录命名为 `variants/` 以兼容整仓 `Test-CodexToolkit.ps1` 的目录白名单，各变体 JSON 预留 `machineRole` 字段用于后续双机 `development` / `training` 扩展）：

| 仓库模板 / 组件路径 | 本机目标安装路径 / 作用 | 加载机制与预算要求 |
|---|---|---|
| `variants/catgirl.profile.json` | 猫娘搭档版构建清单（`audienceMode: "catgirl"`, `machineRole: "universal"`） | 拼装 `components/catgirl.template.md` + `components/core.template.md`，按受众词转换规则渲染全部输出 |
| `variants/neutral.profile.json` | 通用无猫娘版构建清单（`audienceMode: "neutral"`, `machineRole: "universal"`） | 拼装 `components/neutral.template.md` + `components/core.template.md`，全部 7 份产物 100% 零猫娘/主人/喵/颜文字 |
| `components/catgirl.template.md` | 猫娘搭档版头部、专题入口表与第一节人格/语流/逆风锚定 | 由 `Build-AntigravityRulesProfile.ps1` 按清单拼装 |
| `components/neutral.template.md` | 通用中性工程搭档版头部、专题入口表与第一节清晰沟通/反模式 | 由 `Build-AntigravityRulesProfile.ps1` 按清单拼装 |
| `components/core.template.md` | 共享核心第二至第七节（中性底稿：近况、`update_steps`、调度、多模态原生直读、工具路由） | 由构建脚本按 `audienceMode` 渲染为 `GEMINI.md` 后半段 |
| `GEMINI.template.md` | `%USERPROFILE%\.gemini\GEMINI.md`（单文件手工兼容镜像） | 与 `Build-AntigravityRulesProfile.ps1 -Profile catgirl -KeepTemplatePlaceholders` 输出逐字节一致；替换 `<USER>` 后须严格 **`< 24,000 bytes`** |
| `guidance/engineering-workflow.template.md` | `%USERPROFILE%\.gemini\guidance\engineering-workflow.md` | 复杂/跨阶段工程开工与恢复前按需读取（`< 24,000 bytes`） |
| `guidance/communication-bridges.template.md` | `%USERPROFILE%\.gemini\guidance\communication-bridges.md` | 调 `communication-core`、跨端协同与外部 IM 回信前按需读取（`< 24,000 bytes`） |
| `guidance/design-writing.template.md` | `%USERPROFILE%\.gemini\guidance\design-writing.md` | 前端、3D、海报、PPT、正式文书创作前按需读取（中性底稿） |
| `guidance/web-visual.template.md` | `%USERPROFILE%\.gemini\guidance\web-visual.md` | 多模态原生直读（图/视频/音频/大 PDF 切页）、浏览器交互、登录墙与 `file://` 预览前按需读取 |
| `guidance/maintenance-upgrades.template.md` | `%USERPROFILE%\.gemini\guidance\maintenance-upgrades.md` | 改配置、写回退脚本、本地 Git 提交与共享仓脱敏同步前按需读取 |
| `skills/tools-reference/SKILL.template.md` | `%USERPROFILE%\.gemini\antigravity\skills\tools-reference\SKILL.md` | 调 Lazy MCP、`read_file` 多模态/`update_steps`、跨端读原文、`10 KiB` 落盘与 `512k/5m0s` 压缩前按需读取（`< 24,000 bytes`） |
| `local-care.example.md` | `%USERPROFILE%\.gemini\guidance\personal-care.local.md`（可选） | **仅在仓库外自建**；存放个人偏好、通知路由、作息与私有素材库路径，严禁入 Git（构建/安装脚本拒收直接传入示例原件） |
| *(仓库外可选自建，无公开模板)* | `%USERPROFILE%\.gemini\guidance\account-status.local.md`（可选） | 若本机装有本地只读账号/步数监控 CLI，可在仓库外自建私有专题供 `GEMINI.md` 入口按需引用，严禁入 Git |

---

## 二、一键构建、安装与自动化门禁（推荐，PowerShell 5.1+）

在仓库根目录执行以下一键命令，即可按需选择 **猫娘搭档版（`catgirl`）** 或 **通用无猫娘版（`neutral`）**，自动完成路径占位符替换、受众词转换、纯 LF 无 BOM 写入、每文件 `< 24,000 bytes` 硬校验、旧文件 SHA256 备份与原子安装（默认保护已存在的 `guidance\personal-care.local.md` 与 `guidance\account-status.local.md` 不被覆盖或删除）：

```powershell
# 1. 一键安装猫娘搭档版到 %USERPROFILE%\.gemini（默认备份旧文件至 .gemini\backups\rules-profile-<timestamp>\）
.\install\Install-AntigravityRulesProfile.ps1 -Profile catgirl

# 2. 一键安装通用无猫娘工程搭档版到 %USERPROFILE%\.gemini
.\install\Install-AntigravityRulesProfile.ps1 -Profile neutral

# 3. 附带本机仓库外私有陪伴配置一起安装（严禁直接传 local-care.example.md）
.\install\Install-AntigravityRulesProfile.ps1 -Profile catgirl -LocalCarePath "D:\private\personal-care.local.md"

# 4. 仅离线构建到指定目录审阅差异（可选 -KeepTemplatePlaceholders 保留 C:/Users/<USER> 占位符）
.\install\Build-AntigravityRulesProfile.ps1 -Profile neutral -OutputDirectory "$env:TEMP\agy-neutral-preview"

# 5. 运行双版本自动化门禁测试（实测双版本构建/隔离安装、20 字符长用户名膨胀 < 24,000 B、人格隔离、逐字一致与严格脱敏）
.\install\Test-AntigravityRulesProfiles.ps1
```

> **预留双机 `local_role` / `machineRole` 接口说明**：当前 `variants/{catgirl,neutral}.profile.json` 均设 `"machineRole": "universal"`，跨开发机与训练机通用；后续若训练机部署 Antigravity 2.0 并需要专属训练监督组件，可新增 `variants/training.profile.json`（及 `guidance/training-machine.template.md`），无需改动现有两套通用配置。

---

## 三、离线预览与手工复制说明（PowerShell）

如需在不直接写入 `%USERPROFILE%\.gemini` 的情况下离线构建完整渲染结果逐文件审阅，或从离线目录手工复制，请统一先运行 `Build-AntigravityRulesProfile.ps1`（确保 `GEMINI.md` 与 `guidance\*.md`、`SKILL.md` 的受众称呼及 `交流近况.md` / `主人交流近况.md` 命名完全一致，避免主规则与按需专题称呼分裂）：

```powershell
$ErrorActionPreference = "Stop"
$PreviewDir = Join-Path $env:TEMP "agy-rules-manual-preview"
.\install\Build-AntigravityRulesProfile.ps1 -Profile catgirl -OutputDirectory $PreviewDir
Get-ChildItem -LiteralPath $PreviewDir -Recurse -File | Select-Object FullName, Length
```

> 注：仓库顶层保留的 `GEMINI.template.md` 为 `Build-AntigravityRulesProfile.ps1 -Profile catgirl -KeepTemplatePlaceholders` 的逐字节同步镜像，供单文件快速浏览参考；正式部署请优先使用第二节 `Install-AntigravityRulesProfile.ps1 -Profile catgirl|neutral`。

如需配置个人陪伴偏好、外部 IM 通知路由与本机私有素材库入口，可将 `local-care.example.md` 复制为 `%USERPROFILE%\.gemini\guidance\personal-care.local.md` 并在本机单独编辑。

---

## 四、接收方本地调整项、双机角色防撞与生效验证

1. **本地调整项与双机角色自知（`development` vs `training`）**：
   - **双机角色标记（多机用户必配）**：若同时维护开发机（`development`）与训练机（`training`），安装后请在各自机器的 `%USERPROFILE%\.gemini\GEMINI.md` 第七节及仓库外的 `%USERPROFILE%\.gemini\guidance\personal-care.local.md` 中明确标出本机 `local_role`（使助手清楚自己是「开发机的反重力」还是「训练机的反重力」，并在 Git 提交时分别使用 `[Antigravity/dev]` 与 `[Antigravity/training]` 正交双标，不混用署名）。后续若训练机需增加条件式训练监督规则，建议独立存为 `guidance\training-machine.md` 并配对应变体清单按需读取，不覆盖跨机共享的核心组件。
   - **风格切换与模型/MCP 列表**：随时可通过重跑 `Install-AntigravityRulesProfile.ps1 -Profile catgirl|neutral` 无损切换猫娘版与中性版（旧版自动备份，私有 `.local.md` 原样保留）；并按实际订阅与 `templates/config.antigravity.example.json` 调整可用模型档位与 MCP 服务（未配 `exa` 时自动降级 `search_web`；启用 `communication-core` 时在私有门面配置登记宿主统一连接或会话绑定）。
2. **生效验证**：
   - 保存后在 Antigravity 2.0 新开一条对话（无需重启宿主），用一个纯只读小问题验证：让助手确认已注入 `GEMINI.md`（2.0 双版本模块化版），复述本机机器角色（若已配置 `development` / `training`）及对应 Git 双标格式、单文件 `24,000 bytes` 预算线、`call_mcp_tool` `10 KiB` 落盘位置、`communication-core` 十一工具调用红线、`update_steps` 多步实时更新与收尾全标 `done`/`skipped` 规范、`schedule` 双模式与真·完全并行先完先检铁律、单端主攻 `plans_agy/` 隔离与进度表去内部代号要求、Gemini `read_file` 原生多模态直读与超大 PDF `PyMuPDF` 切页/`150 DPI` 瘦身规范，以及压缩/中断恢复找回已撤前置与原生日志 `USER_INPUT` 代理封套甄别红线。
