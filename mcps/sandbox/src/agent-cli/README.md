# Sandbox Agent CLI

构建后的入口为 `dist/agent-cli/main.js`，npm bin 名为 `sandbox_agent`。人工 CLI 与 MCP `sandbox_agent/sandbox_grok` 共用独立的 Agent Server，由核心管理执行、存储、权限和模型调用。本页说明源码接口，实际安装的命令与能力以 `--help` 和 `info` 为准。

普通辅助工作继续使用宿主原生子代理和工具，用户指定外部模型或任务确需该模型时，再选择本入口。部署须包含完整 `dist/`、`assets/agent/`、锁定依赖及支持 `node:sqlite` 的 Node 运行时；各供应商和目标终端按实际版本分别验收。

## 脚本与人工入口

```text
sandbox_agent --help
sandbox_agent --help key set --json
sandbox_agent --data-dir <私有目录> doctor --json
sandbox_agent --data-dir <私有目录>
sandbox_agent --data-dir <私有目录> conversation create --mode archive --json
```

以上为命令格式，`<...>` 由操作者替换为实际值。帮助、菜单和参数检查共用 `COMMAND_SPECS`。缺少正式 RPC 的命令显示不可用原因，远端运行错误保留原错误码。帮助与版本查询不连接服务，其余操作通过公共 discovery 入口发现或启动相应私有核心。

非 TTY 必须明确给出命令。`--json` 返回一个 JSON 对象；`exec --format jsonl` 返回共同事件包和末项 `cli.result`。stdout 用于结果，stderr 用于进度、诊断和人工界面。

`exec` 等待任务终态和资源回收确认后返回，待人工批准或继续时返回退出码 5，收尾超过 30 秒仍待确认时返回 7 并保留原执行身份。人工取消且回收确认返回 130，SIGTERM 前台退出返回 143。

## 权限、工具与内部子任务

普通资料按当前系统账号已有权限读取。写入限主调用方批准的根目录和动作声明的路径，文件修改使用版本检查。CLI 新建会话的默认写入根为当前工作目录，可重复提供 `--write-root` 批准多个目录。删除、配置及 Git 历史变更等危险动作交主调用方核对批准，控制文件和凭据由可信核心保护。

```text
sandbox_agent conversation create --mode archive --write-root <目录一> --write-root <目录二> --json
sandbox_agent tools list --json
sandbox_agent tools show <toolId> --json
```

工具按需发现，模型内部先使用 `tool_catalog/tool_describe/tool_load`。`read_file` 返回的 `expectedVersion` 用于后续 `write_file`；`run_command` 提供明确的 `application/args/cwd`、实际 `writeSet`、期限、进程树内存和输出上限。命令及共享 MCP 遵守当前任务规则，可靠检测命中本机禁止动作时保留错误和已确认效果，暂停执行并交主调用方处理。

内部子任务默认关闭。主调用方明确启用后最多一层，并指定模型、推理强度、写入范围、工具范围和父子预算。CLI `conversation create --allow-subagents` 只开启会话开关，其余配置仍须按正式方法提供。模型名称与推理强度分别设置，按精确模型目录支持的字段选择。

内部派发的模型规则优先选会话 `options.modelRulesRef`，未提供时才选 API Profile 的 `globalModelRulesRef`。规则文件采用 JSON，或包含唯一 `sandbox-agent-model-rules/v1` JSON 代码块的文档；顶层提供 `rulesVersion="sandbox-agent-model-rules/v1"` 与 `entries`，每个 `taskKind` 唯一，条目包含 `profileId/modelId/reasoningEffort/requiredCapabilities/maxOutputTokens`。运行首请求前冻结所选来源、版本和哈希，明确提供但无效的任务规则会返回错误。内部子任务继续派发和递归调用模型工具保持关闭。

普通派生进程、网页会话及 MCP 资源随所属执行收尾，显式独立启动并由调用方接管的服务按其独立生命周期管理。查回与取消沿用原 `conversationId/runId/rootRunId/runEpoch/actionId/requestId`，工具自己的 `ownerId/taskId` 也保持原值。

## 未知结果与显式结束本地等待

连接中断、超时或 `outcome_unknown` 出现后，保留原 `dataDir/clientId/clientCommandId`，沿原会话、执行、动作与预算查回。`receipt` 查询原命令，`runs get` 查询原执行，费用预留继续保留，自动重发收费动作停止。

原执行处于 `outcome_unknown`，且本地工作、内部子任务、工具交互及所属资源均确认收尾后，主调用方可显式结束本地等待。以下 PowerShell 操作使用原身份，并为本次确认选择一个新的稳定命令号：

```powershell
$dataDir = Read-Host '原私有数据目录绝对路径'
$clientId = Read-Host '原 clientId'
$conversationId = Read-Host '原 Agent conversationId'
$runId = Read-Host '原 runId'
sandbox_agent --data-dir $dataDir --client-id $clientId --conversation $conversationId runs get $runId --json
$runEpoch = [int](Read-Host '上一步返回的当前 runEpoch')
$ackCommandId = Read-Host '本次结束等待的新稳定命令 ID'
sandbox_agent --data-dir $dataDir --client-id $clientId --conversation $conversationId cancel $runId --run-epoch $runEpoch --acknowledge-unknown --command-id $ackCommandId --json
```

MCP 对应 `action="runs.cancel"`，原 `params.conversationId/runId/expectedRunEpoch` 之外提供 `acknowledgeUnknown:true` 和稳定 `clientCommandId`；外层显式传 `callerHost/callerConversationId`。控制租约由共同客户端取得，接管须明确选择。

成功结束等待返回 `state="cancelled"`、`waitEnded=true`、`cleanupState="released"`、`accountingUnchanged=true`，原 `resultStatus/effectState` 仍为 `unknown`，原动作、尝试和费用预留保留。**CLI 仍返回退出码 7**，脚本同时读取 JSON 中的 `waitEnded` 和原结果字段。存在实际在途工作、未完成交互或回收未确认时，会保留原等待并给出对应错误。

旧命令的 `error` 回执保持原内容，本次显式确认使用独立的稳定命令号。若确认响应中断，用下方命令查本次回执，沿原号查回：

```text
sandbox_agent --data-dir <原目录> --client-id <原客户端> --conversation <原会话> receipt <本次确认命令ID> --json
```

结束等待会撤回尚未消费的排队输入。新任务须单独明确提交并选择新命令号，原请求的费用与结果仍按原身份核查。资源全部释放、等待经上述确认结束后，`conversations.update` 可按当前 `expectedRevision` 更新普通权限选项，例如批准写入根，下一请求生效。保存方式变更、分叉和文件恢复仍分别经过各自的状态检查。

## 配置与费用

```text
sandbox_agent profile add --label <名称> --protocol compatible_chat --base-url <地址> --model <模型ID> --json
sandbox_agent profile get <profileId> --json
sandbox_agent profile validate <profileId> --json
sandbox_agent key set <profileId> --secret-file <私有文件> --secret-format env --secret-field <变量名> --revision <配置版本> --json
sandbox_agent model list --profile <profileId> --json
sandbox_agent model get <modelId> --profile <profileId> --json
```

Key 导入只提交 `sourcePath/format/field`，CLI 不读取导入文件。格式为 `plain/env/json`，后两种要求明确字段。配置保存和本地校验不发送模型请求，目录联网刷新使用单独的 `model refresh`。不接受 `--api-key`，通用 `rpc` 入口拒绝凭据与握手方法。

人工交互首用按菜单选择服务商、导入 Key、选择模型，再确认工作区与保存方式即可聊天；人工执行默认使用 `metered` 计量，记录实际用量和费用，无需先配置强制金额预算，也可显式选择预算。主 Agent 通过 MCP 或非交互 CLI 调用时，仍须提供根预算和 Profile 引用的供应商累计预算，并保持稳定的 `callerHost/callerConversationId` 身份。累计预算通过 `budget configure-limit` 配置；授权金额、币种和来源由实际使用时提供。`model declare --params <JSON>` 用于有来源依据的精确模型条目，正常首用可从服务商模型目录选择。

模型目录记录上下文窗口、最大输出、输入输出模态、工具与流式能力、价格及参数证据。参数声明包含类型、枚举、范围、默认值和协议映射位置 `wirePath`，证据带来源、观察时间和适用范围，缺少声明时显示 `unknown`。`model refresh --profile <profileId>` 显式联网刷新目录；配置和本地目录查询走正常 discovery，必要时会启动本产品私有核心。

```text
sandbox_agent exec --profile <profileId> --model <modelId> --input-file <UTF-8文件> --budget <JSON对象> --json
sandbox_agent exec --conversation <id> --stdin --budget <JSON对象> --format jsonl
sandbox_agent exec --text <正文> --budget <JSON对象> --detach --command-id <稳定命令ID> --json
```

根预算字段包含 `wallMs/maxModelCalls/maxOutputTokens/costMode/currency/maxCostMicros`。预算在提交前按核心校验规则检查。`exec` 新建会话使用默认归档方式；同一显式命令 ID 对应确定的创建子命令 ID，重复提交可查询原创建和原执行回执。已有或新建的临时会话均不接受 `--detach`。

主 Agent 调用的累计额度 `definition.amountMode` 与根预算 `costMode` 默认均为 `hard`，执行前需要可靠的完整计费上界；人工交互采用上面的 `metered` 路径。旧额度省略 `amountMode` 时保持原定义和旧回执；显式写 `hard` 仍对应同一额度定义。金额以微货币单位表示，1.00 个货币单位为 `1000000`。

需要按估计金额运行时，通过 `budget configure-limit --amount-mode estimated` 创建新的累计额度，并在本次根预算中显式设置 `costMode="estimated"`；两处同时选择才接受有来源、有限非零的估计。已有额度 ID 的模式保持固定，切换模式须创建新 ID。CLI 表单和查询结果会显示所选模式及单次费用可能超出估计的提示。

已发送请求按完整实际费用入账，累计达到金额阈值后停止新增；单次实收高于原估计时继续按累计金额判断。在 `estimated` 累计额度下，费用未知或未结算时，保留原预留，并停止其它根任务的新增预留和派发，沿原请求查清后才能继续。内部子任务和压缩使用对应根预算。Progrok 的 `max_tokens` 仅约束可见输出，完整计费上界未知时，`hard` 在发送前保留具体缺项。

`runs get` 和 `exec` 会按 `resultContentId` 读取实际结果。`input list`、队列编辑和历史页会解析内容引用。原文分片逐页核对 MIME、字节数、偏移和 SHA256，再解码 JSON；默认每页 256 KiB、单次内存恢复上限 32 MiB。`artifact show/save` 可显式读取或保存原字节，保存默认保留已有目标文件，覆盖需要 `--force`。

## 保存方式、BPC 与原件

| 方式 | 选择方式 | 生命周期 |
|---|---|---|
| 临时 | `--mode temporary` | 正常关闭时清理正文、媒体及所属临时引用，最小核账状态单独保留 |
| 限时 | `--mode ttl --ttl 2h` | 显式时长，活动执行、未决资源和保存策略共同决定实际清理时点 |
| 长期归档 | `--mode archive` | 持久保留原文及原件，按实际状态关闭和重开 |

改变保存方式使用 `session mode`，先预览，再带返回的原 `previewToken` 和当前 `policyRevision` 确认。例如：

```text
sandbox_agent --conversation <id> session mode ttl --ttl 2h --policy-revision <当前版本> --json
sandbox_agent --conversation <id> session mode ttl --ttl 2h --policy-revision <同一版本> --preview-token <原预览token> --command-id <稳定命令ID> --json
```

`artifact save` 会在显式目标创建持久副本，保存前确认用途和目标授权，覆盖已有文件加 `--force`。临时会话拒绝 `exec --detach`，外部编辑器只对归档与限时会话生成文件。

BPC（后台渐进压缩）整理后续请求所用的较早内容，压缩模型依次取会话 `compressionModelSelection/compressionModel`、API Profile 的 `compressionModelRef`、当前任务模型。未另配时沿用当前模型，压缩沿所属执行的计量或预算方式处理；主 Agent 调用继续受根预算与供应商累计上限约束。手动 `compact` 启动维护执行，人工交互未显式配置预算时使用计量模式，`compact --preview` 只查看范围。

压缩后的请求通过摘要和引用使用旧内容，完整原文、图片及供应商原生响应引用在所选保存生命周期内保留，原图以 MIME、字节数和 SHA256 校验。原生签名块按已接入协议保存与续传，实际模型支持范围按目录和对应适配器核对。

压缩目标用于争取更小的后续请求。完整原句、出处和检索锚点已缩到可保留的最小表示时，重新计量完整请求；仍严格低于有效输入预算即可继续，视图记录实际计量、优化目标和是否停在最小表示。硬压缩发布后还会再次计量，保留最大输出与安全余量；达到或超过有效输入预算时暂停相同输入的自动压缩，错误正文及详情同时保留实际占用、有效输入预算与压缩目标。

Agent 需要核对较早的对话时，可按下面的顺序查回并反馈：

1. 用 `history_search` 定位当前 Core 会话中的原文；尚未找到目标且 `hasMore=true` 时，保持相同查询和轮范围，将返回的 `nextCursor` 作为 `cursor` 继续搜索。
2. 按搜索结果给出的参数调用 `history_read`，读取对应轮次、原文分片或完整摘要，分片未读完时沿返回的游标继续。
3. 确认查回内容帮助了当前任务后，用结果中的 `roundHit` 或 `summaryId` 调用 `mark_history_hit`，两者选一，供下一次 BPC 发布调整保留程度。

历史轮号按保存的原轮编号，压缩后保留的最近几轮继续使用原编号。优先直接使用返回的 `originalRead` 与 `usefulHit` 参数，分片读取沿 `nextRead` 继续；内部身份字段不作为模型自行填写的查回参数。

Task.md、Plan.md 和任务完成状态由主模型维护，压缩模型只整理事实、交流与原文检索线索，返回 `unresolved:[]` 并省略 `resolutions`。已有未决要求仅作只读交接材料，保留原句与来源；实体 Task/Plan 接管显示后，压缩视图停止展示这份旧交接表。

原文保存在原会话的历史与内容记录中，压缩记录保存摘要、来源引用和压缩尝试，用于构造后续请求与查回原件。两类记录按会话保存策略保留；核对原话时使用 `history_search/history_read`，核对压缩发布时使用原 `candidateId/attempt`。失败或结果未知的动作继续按原状态查询，停止自动重发。

压缩会计入保留原文、当前输入、规则和工具定义。供应商提供完整原生计数时使用该计数；摘要内部的保守文本估计与供应商 token 数分别处理，已发布视图复用经过完整请求核查的摘要预算，显式指定的摘要限制仍然生效。后台摘要已知过大时停止自动重复生成，保留旧视图与失败证据；完整当前输入仍在限额内的业务可以继续，达到硬限额则暂停新的模型请求并返回具体预算错误。

摘要请求已完整返回并持久确认后，若 JSON 结构或原文引用校验失败，每个压缩候选最多自动发起一次纠错请求，仍使用本根预算、原期限和严格来源校验。纠错使用新的请求身份，原失败响应、回执和费用继续保留；第二次校验失败后停止。供应商明确返回输出截断时保留原响应和费用，停止自动纠错，调用方核对压缩模型的推理参数与输出上限后再明确继续。结果未知、未完整返回、服务器拒绝、预算不足或取消按原状态处理，先核原请求。冷恢复沿已持久保存的纠错请求和原回执继续核实，单次上限随候选保存。

`context` 显示供应商窗口、明确的 `contextPolicy.localContextWindowTokens`、有效输入限额和压缩状态。本地窗口默认为空，沿用供应商已核实的窗口；调用方可在原会话配置中明确调整本地限制，再检查原候选和失败原因。调整本地窗口不会清除已执行请求、原回执或费用记录。

`CONTEXT_ACTIVE_ROUND_TOO_LARGE` 会保留完整活动轮、保留轮和已完成工具结果，当前没有可继续压缩的旧轮时停止新增模型请求。调用方依据返回的实际输入量、输出预留和后续文件读回所需空间，决定拆分后续输入或明确调整本地窗口；新的执行单独提交，旧执行的错误、已完成动作和费用保持原样。

```text
sandbox_agent history <conversationId> --limit 20 --json
sandbox_agent --conversation <id> artifact list --json
sandbox_agent --conversation <id> artifact show <artifactId> --json
sandbox_agent --conversation <id> artifact save <artifactId> <目标路径> --json
```

分页沿返回游标读全后核对原字节，`compact status/recover` 使用原 `candidateId`、`attempt` 和冻结配置查回。连接恢复沿原事件游标、回执和执行身份，付费未知状态继续保留。

## 人工输入

启动菜单默认选择新建归档会话，也提供已有会话、临时和显式 TTL。新会话先选服务商与模型，再确认工作目录及允许写入的目录；目录使用系统文件夹选择器，确认后保存。输入可以在后台连接期间进行。会话打开只展示现状，继续原执行需要明确操作。

| 操作 | 键位或命令 |
|---|---|
| 换行、发送、补充当前轮 | Ctrl+J、Enter、Alt+Enter |
| 命令、历史、外部编辑器 | `/` 或 Ctrl+G、Ctrl+R、Ctrl+X 后 Ctrl+E |
| 字素编辑、撤销与重做 | 左右/Home/End/Delete/Backspace、Ctrl+Z/Ctrl+Y |
| 清当前行、返回、取消 | Ctrl+U、Esc、Ctrl+C |

Alt+M 打开模型选择，Alt+W 打开工作区与写入目录，Alt+S 打开设置；对应命令为 `/model`、`/workspace`、`/settings`。

粘贴始终作为一次草稿编辑，多行也不自动发送。草稿上限 1 MiB；收到对应修订的回执后才清理该修订，迟到回执保留后续修改。命令与正文使用不同草稿，`//` 和 `@@` 可发送字面前缀。

外部编辑器按 VISUAL、EDITOR、Windows 记事本的顺序选择，按 argv 启动，不经过 Shell。只对归档与限时会话生成本次编辑文件，失败保留原稿并恢复终端。临时会话继续使用内置多行编辑。

取得控制后每 30 秒续租，过期或失权会清掉缓存并显示，下次写入正常申请，接管仍需明确选择。观察端不申请或续租控制。`/reconnect` 恢复原连接、游标和回执查询，未确认写命令保持原身份，不重发正文。

## 终端与角色

角色复用 `assets/agent/` 已批准素材，常规占用 30×17、紧凑占用 15×9 列行。Windows 交互终端在原生图形辅助程序可用时，可使用原生高清动画，经典 CMD 也走此路径；辅助程序不可用时回退到终端图形或字符。Sixel 等终端图形仍按实际能力与适配尺寸选择。`NO_COLOR` 和 `--color never` 使用单色字符；`--plain/--accessible` 使用线性文字输出。

`--reduce-motion` 和 `/terminal motion reduced|off` 使用状态静帧。完成表现要求核心终态与资源回收确认。`--diagnostics --renderer full|diff --image-cache off|on` 只改变本前台渲染策略。图像缓存上限 8 MiB、24 帧，退出只恢复本前台修改过的终端状态。

## 客户端集成

```ts
import { AgentClient, decodeArtifactJson } from './dist/agent-client/index.js';

const client = await AgentClient.connect({ dataDir, clientId });
try {
    const snapshot = await client.request('conversations.get', { conversationId });
    const artifact = await client.readArtifact(conversationId, contentId);
    if (artifact.ok && artifact.data) consume(decodeArtifactJson(artifact.data));
} finally {
    await client.close();
}
```

`AgentClient` 复用公共发现、HMAC 挑战认证、JSON-RPC schema、回执和事件游标。控制与事件使用独立连接。连接关闭会清理本客户端的 timer/socket，调用者仍需显式选择取消或脱离逻辑执行。

正式服务的 `server.info.capabilities.automaticModelExecution=true` 表示已提供 Provider 模型执行能力；`executor` 保留当前激活状态，`executorActivation` 为 `on_profile_run` 或 `active`。首次携带已选 Profile 的执行才激活执行器，查询能力不会发送模型请求。单独使用的纯 runtime 保持原有能力含义。

## 验证边界

正式控制链、配置导入、分页与 PTY 脚本位于 `tests/agent/e2e/cli*.mjs`。`cli-control`、`cli-profiles`、`cli-pty` 支持持久 evidence root，报告保留原始命令输出、构建哈希与资源关闭结果。`cli-pty --long` 使用超过 90 秒的真实控制租约轨迹，使用自身 ConPTY 和虚拟材料，不操作用户窗口。

当前草稿切换与未知回执记录保留在前台内存，跨进程草稿恢复等待正式服务端草稿端口。引用使用 `ref add/show`，规则与技能使用 `rules list/show/reload`、`skill list/show/load/unload`；`changes restore/rewind` 先预览，`changes commit` 带原恢复计划明确提交。命令按当前核心提供的方法和状态检查执行。

ConPTY 可验证已确认的 Unicode 字节，物理 IME 组合、实际 Windows Terminal 字体和 Shell shim 属于单独验收范围。离线组件截图用于布局与素材检查，真实供应商、持久状态、取消、预算与目标终端的验收按同版实际运行报告分别记录。
