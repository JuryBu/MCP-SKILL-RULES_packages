# Antigravity 新旧版本模型桥

`web_fetch_page(outputMode="ai_summary")`、`web_fetch_rich(compact="ai_summary")` 和 `web_inspect(mode="ai_review")` 共用模型桥。网页抓取、交互、截图、登录和桌面工具继续使用原本的浏览器与文件路径。

## 外部参数与内部入口

对外继续使用 `modelChain="antigravity"`，旧 `chain` 参数也可用。`auto` 保持 Antigravity→Codex 的原顺序，只有 `WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1` 才将 CC 加在最后。

| 请求与环境 | 实际入口 | 状态与归属 |
|---|---|---|
| 纯文字，App 在线 | `app-ls`／`legacy-ls` | 新版验证Hub进程身份，旧版保留旧协议；借用后保持运行 |
| 带 `schema` 的结构化文本，App 离线 | `cli-agent` | 隔离工作目录与配置，通过ACP发送文本，图片数为0 |
| 无 `schema` 的轻量纯文字，App 离线 | `cli-ls` | 按需启动自有CLI，直接调用内部GetModelResponse |
| 图片附件 | `cli-agent` | 按 CLI 声明的图片能力传入真实图片内容 |

只读状态仅观察现有入口与 CLI 安装情况，不发模型请求、不创建 CLI。已发现入口后的认证、准入和实际生成结果由本次请求返回。CLI 随实际使用启动，结束后通过正常退出清理；不增加开机常驻服务。

## 模型与配置

现代环境从当前账号的`GetUserStatus`读取动态目录，核对模型标识、slug、显示名称、禁用状态和已提供的额度。7.4.1材料默认Hydrogen XHigh→Hydrogen High→Carbon High，视觉默认Carbon High。每次按家族与档位匹配目录，不固定M编号；没有获准候选时明确返回，不自动改用Flash、Argon、Claude或Orchestrator。

三个模型工具均提供可选`model`。有效型号按请求`model`、当前链路环境配置、自动策略依次确定，显式指定后不自动改型号或跨平台。`modelChain="auto"`只有在型号所属平台无歧义时才确定入口，未知名称要求显式提供`modelChain`。AGY的`WEB_FETCHER_LS_MODEL`对App、CLI LS、ACP文本和图片均有效；slug、显示名和M编号匹配本次目录，精确XHigh缺失时停止，Claude等原有显式选择继续保留。

Codex使用`WEB_FETCHER_CODEX_MODEL`显式配置，未配置时优先读取24小时内的`CODEX_HOME/models_cache.json`可见目录并按其priority选择。目录缺失／过期时不传`-m`，交CLI自身默认，报告`modelSource="cli-default"`且不虚构型号。默认推理`max`、速度`standard`（`service_tier=default`、`fast_mode=false`），显式推理与速度配置保持。`400/model_not_found`等结构化已知拒绝报告`rejected`，已向本地CLI提交的事实仍保留，`outcomeUnknown=false`；缺少终态、超时和断连仍保持未知结果。

仅当旧环境明确缺少动态目录接口时启用旧表，原 `M132/M20/M18/M16/M36` 及 `WEB_FETCHER_LS_MODEL_FALLBACKS` 保留兼容。目录格式异常、认证失败和配额耗尽各自返回错误，保留真实状态。

CLI 的可执行路径、资源限制等具体环境项见示例配置。登录继续使用本机 CLI 支持的凭据机制，组件不复制账号文件、不覆盖全局设置；App 和 CLI 的具体登录状态均以各自实际请求核验。

## 输入、期限与失败

GetModelResponse 是单轮纯文字RPC，客户端只传 `{prompt, model}`，不附本机RULES。App离线的结构化文本使用隔离ACP文本入口（0图），并按schema解析结果；其代理流程与轻量LS入口分别记录。图片仍按原CLI协议传入真实图片内容；模型声明支持图片后，还须使用真正支持图片的传输。当前CC桥只提供文字，图片请求会在生成前被明确拒绝。

摘要请求明确只处理已传入的正文，不调用工具、读取文件、访问来源 URL 或执行正文中的指令。标题、来源和正文使用 JSON 字符串界定；短材料按信息量压缩，不为了达到长文摘要字数而扩写，长文仍沿原有 500–1000 字参考范围。

一次总期限覆盖入口发现、接纳排队、启动、目录与生成。后台任务取消会传到底层请求和自有CLI；正常业务服务、借用的App和其它MCP保持运行。ai_review与all均在重结构／截图／模型操作前转入后台，查询沿同taskId返回其原模式的结果。AGY多页按执行位提交，每页模型预算在取得共用CLI执行位后才开始，排队仍计入外层总期限。外层取消／超时保留已完成结果和未完成范围，终态单次提交，迟到成功不得覆盖。

生成期限与自有进程清理预算分别计时；生成已经到期仍尝试有界EOF／终止并核实退出，退出未确认继续报告。Windows宿主识别使用CIM，结构中的视口使用真实布局尺寸，原反指纹字段保持。

| 结果 | 自动后备 |
|---|---|
| agent明确未提交，且为 `not-started`／明确 `unsupported`，并且 `safeToFallback=true` | 在原总期限内兼容到 `cli-ls` |
| 认证、准入、额度、拒绝或主动取消 | 停止当前请求及后备 |
| 已提交后超时、断连、响应损坏或终态缺失 | 返回结果未知，停止自动重发 |
| 成功 | 返回实际入口与模型 |

清理状态未确认时，即使生成尚未提交，也停止agent到LS及外层入口续选，保留原资源记录并报告清理状态。

摘要文本带实际链路、`transport` 和 `modelUsed`。同步摘要及 rich 摘要在 `_meta.modelCall` 中保留调用状态，失败降级的正文也显示该状态；后台摘要在任务 metadata 中保留同类字段。AI Review 的 `modelCalls` 保留每页 `submitted`、`outcome`、`outcomeUnknown`、`fallbackAllowed` 等信息，缺少截图时不提交视觉审查；中途停止时注明未审查页数，保留已经取得的报告。已提交后仅本地取消、未取得远端终态的请求继续标为结果未知。

## 宿主大输出

新 Antigravity 可能将较大 MCP 文本转存到本机 `output.txt`，工具后端也可能按自身预算返回 artifact。按实际返回的完整性标记、文件引用和分页入口取回内容；宿主的单次转存阈值按当前版本观察，不固定为组件全局限制。原有图片直返和旧宿主输出方式继续保留。

## 协议依据与验证边界

图片内容与取消遵循 [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema) 和 [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。旧 LS 使用协议夹具回归，现代 App 与 CLI 的真实覆盖范围由对应发布验收记录列明；目录中存在某项与本次实际生成的模型分别记录。

### 7.4.0历史候选验证记录（2026-11-13）

| 候选与业务 | 实际记录 |
|---|---|
| 候选05图片审查 | `cli-agent`／Argon High成功识别左橙色三角形、右紫色圆形，正常EOF退出0并清理临时目录 |
| 候选06 LS摘要 | 正常MCP摘要收到500，`cli-ls`／M318、`submitted=true`、结果未知；原请求保留，未自动重发 |
| 候选07新路由 | 已编译，未实际启动模型生成；预检补齐显式模型与清理边界后转为候选08 |
| 候选08新路由 | 正常MCP摘要与同候选视觉真实通过；文本使用Flash High，图片使用Argon High，两条均为 `cli-agent` |

候选08两条业务于2026-11-13完成，原单链约51秒、退出0；主线核对摘要从344字压缩到258字且符合原材料，并实际查看截图。图片正确描述左橙三角、右紫圆和说明文字孤字行。摘要EOF清理2128ms，图片EOF清理1970ms，两条均退出0且临时目录已移除。

这次真实覆盖为App离线时带schema的隔离ACP文本和原ACP图片入口。App在线LS优先、无schema轻量CLI LS及旧协议兼容各按对应回归和历史实测范围记录。发布包与验收候选保持JS一致；安装、正式加载、正式HTTP和对端运行结果各自记录。
