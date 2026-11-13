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

现代环境从当前账号的 `GetUserStatus` 读取动态目录，核对模型标识、显示名称、禁用状态和已提供的额度。普通材料默认选择 Gemini 3.8 Flash High，当前目录 ID 为 `MODEL_PLACEHOLDER_M318`。目录未来变化时重新解析，不将一份历史账号快照当作长期准入表。

`WEB_FETCHER_LS_MODEL` 用于显式模型选择，App离线的schema ACP文本入口继续传递这个既有配置，指定项不可用时返回具体错误。普通摘要优先 Flash High，视觉审查自动选择可用的 Argon High，其次 Carbon High；两者均不可用时明确停止，不以 Flash 或 Claude 替换。Claude、Hydrogen、Orchestrator 等目录条目可被识别，Claude 保留显式选择。图片请求的显式 M 编号通过本次 CLI 的账号目录映射到 ACP 模型，无法唯一匹配时停止，不跨平台换型。

仅当旧环境明确缺少动态目录接口时启用旧表，原 `M132/M20/M18/M16/M36` 及 `WEB_FETCHER_LS_MODEL_FALLBACKS` 保留兼容。目录格式异常、认证失败和配额耗尽各自返回错误，保留真实状态。

CLI 的可执行路径、资源限制等具体环境项见示例配置。登录继续使用本机 CLI 支持的凭据机制，组件不复制账号文件、不覆盖全局设置；App 和 CLI 的具体登录状态均以各自实际请求核验。

## 输入、期限与失败

GetModelResponse 是单轮纯文字RPC，客户端只传 `{prompt, model}`，不附本机RULES。App离线的结构化文本使用隔离ACP文本入口（0图），并按schema解析结果；其代理流程与轻量LS入口分别记录。图片仍按原CLI协议传入真实图片内容；模型声明支持图片后，还须使用真正支持图片的传输。当前CC桥只提供文字，图片请求会在生成前被明确拒绝。

摘要请求明确只处理已传入的正文，不调用工具、读取文件、访问来源 URL 或执行正文中的指令。标题、来源和正文使用 JSON 字符串界定；短材料按信息量压缩，不为了达到长文摘要字数而扩写，长文仍沿原有 500–1000 字参考范围。

一次总期限覆盖入口发现、接纳排队、启动、目录与生成。后台任务取消会传到底层请求和自有 CLI；正常业务服务、借用的 App 和其它 MCP 保持运行。

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

### 2026-11-13候选验证记录

| 候选与业务 | 实际记录 |
|---|---|
| 候选05图片审查 | `cli-agent`／Argon High成功识别左橙色三角形、右紫色圆形，正常EOF退出0并清理临时目录 |
| 候选06 LS摘要 | 正常MCP摘要收到500，`cli-ls`／M318、`submitted=true`、结果未知；原请求保留，未自动重发 |
| 候选07新路由 | 已编译，未实际启动模型生成；预检补齐显式模型与清理边界后转为候选08 |
| 候选08新路由 | 正常MCP摘要与同候选视觉真实通过；文本使用Flash High，图片使用Argon High，两条均为 `cli-agent` |

候选08两条业务于2026-11-13完成，原单链约51秒、退出0；主线核对摘要从344字压缩到258字且符合原材料，并实际查看截图。图片正确描述左橙三角、右紫圆和说明文字孤字行。摘要EOF清理2128ms，图片EOF清理1970ms，两条均退出0且临时目录已移除。

这次真实覆盖为App离线时带schema的隔离ACP文本和原ACP图片入口。App在线LS优先、无schema轻量CLI LS及旧协议兼容各按对应回归和历史实测范围记录。发布包与验收候选保持JS一致；安装、正式加载、正式HTTP和对端运行结果各自记录。
