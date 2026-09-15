# Windsurf Rules 部署说明

## 文件分层

| 文件 | 用途 |
|---|---|
| `global_rules.template.md` | 每轮对话注入的短规则，保留风格和工作方式 |
| `system_rules/*.template.md` | IDE 启动或系统级加载的长规则，按能力拆分 |
| `Windsurf_Global_Rules.template.md` | 旧文件名兼容入口，保留核心全局规则并指向新结构 |

## 推荐安装步骤

1. 在 Windsurf Settings 中搜索 `Rules`，打开全局 Rules 编辑入口，将 `global_rules.template.md` 的正文合并进去；不要把模板文件名本身当成自动加载路径。
2. 如果当前版本提供 system rules / system prompt fragments 管理入口，为 `tools`、`memory`、`collaboration`、`efficiency`、`rendering` 分别创建独立分片，再粘贴对应 `system_rules/*.template.md`；不要把五份内容重复塞进全局 Rules。
3. 如果当前版本只有一个全局 Rules 输入框，只安装 `global_rules.template.md`，需要长规则时再按字符限制逐段合并；`Windsurf_Global_Rules.template.md` 只是旧自动化脚本的兼容入口，不代表完整五分片。
4. 保存后关闭旧 Cascade，新建一条 Cascade 对话；若规则仍未刷新，再完整重启 Windsurf。
5. 用一个不会修改文件的小任务验证：让 AI 复述当前可用 MCP、说明 `dataChain` 与 `modelChain` 的区别，并确认 Windsurf 只提供数据链路。

Windsurf 不同版本的设置入口和系统分片能力会变化，因此本包不硬编码接收方内部安装目录；应优先使用该版本 Settings 中可见的 Rules 管理入口，而不是直接改 IDE 安装文件。

## Devin Desktop（Devin Local 内核）安装

Devin Desktop 是 Windsurf 的后继宿主，规则加载方式不同，五份模板内容不变、位置要换：

1. 全局规则仍合并进 Windsurf 的 `~\.codeium\windsurf\memories\global_rules.md`（Devin 通过 `read_config_from.windsurf` 导入）。
2. 五份 `system_rules/*.template.md` 各存为 `~\.devin\rules\<name>.md`，文件头加 YAML frontmatter：`---` / `trigger: always_on` / `---`。缺 frontmatter 的文件默认 manual，不会注入。长参数手册可拆成 `trigger: model_decision` + `description` 的按需规则，模型按需读取，不占每轮预算。
3. 预算：always-on 合计（含全局规则与工作区 `AGENTS.md`）控制在约 32 KiB 内、单条不超过 16 KiB，这是实测值而非官方承诺；超出时整条规则会被随机丢弃，安装后核对字节数。
4. 不要在 `~\.devin\` 放 `global_rules.md`，它会静默顶替 Windsurf 的全局规则。`C:\ProgramData\Windsurf\rules\` 与 `C:\ProgramData\Devin\rules\` 不再被 Devin CLI/ACP 扫描，仅作备份。
5. 需要排除其它提供方的规则导入（如 Claude、Cursor）时，在 `%APPDATA%\Devin\config.json` 的 `read_config_from` 中把对应键设为 `false`，保留 `agents_standard` 与 `windsurf`；`devin rules list` 不反映此开关，以新对话里实际注入的 `<rules>` 块为准。
6. 规则改动新开对话即生效，不必重启。验证：新开对话，用一个不改文件的小任务让 AI 复述已注入的规则清单，并说明 `dataChain=windsurf` 同时覆盖旧 Cascade 与 Devin 会话、`ls` 只对旧 Cascade 有效。

部署前填写个人风格偏好，确认已安装的 MCP、Skill 和模型；不要把账户、Cookie、密钥、真实项目路径、端口或额度信息写进模板。

## 兼容与回滚

旧文件名仅为兼容已有导入脚本，不再是主入口。升级前备份接收方现有规则，采用复制覆盖前先比较差异；出现异常时恢复该备份并逐个启用系统规则，以定位不兼容项。
