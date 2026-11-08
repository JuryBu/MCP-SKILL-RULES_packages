# 单轮Guard审查

Guard核验一个明确的小阶段，每次check独立完成一轮审查。调用者提供目标文件、阶段和必需原件，工具先核范围与预算，再把实际材料交给审核模型。

## 绑定这次要审的阶段

有Plan和Task时，start同时提供两类文件的完整绝对路径及具体stageId。下面路径和对话ID均为占位示例，调用时替换为实际目标：

```json
{
  "action": "start",
  "conversationId": "your-stable-conversation-id",
  "dataChain": "codex",
  "modelChain": "codex",
  "taskFiles": ["C:/project/plans/Task.md"],
  "planFiles": ["C:/project/plans/Plan.md"],
  "stageId": "Stage 3"
}
```

工具在注册或force替换前核验文件可读性及阶段范围，失败时保留原Guard和原锁。单文件小任务可省Plan；多阶段文档需要明确本次阶段。check、status会显示完整绑定路径，check若再次提供文件或scopeSelectors，内容须与原注册一致。

阶段提取同时支持标题和Plan表格，保留本阶段及明确适用的全局要求。Stage 6与Stage 63分别匹配，子任务编号也按完整标识匹配。本阶段要求中的命令和JSON原文保留，围栏中的伪标题不参与阶段定位。Guard锁块、明确标为示例或markdown/md的示例围栏、其它阶段的命令从本次要求中排除；阶段缺失或歧义会指出具体文件和范围。

childScopeId区分并行实例，scopeSelectors指定子任务内容，两者共同使用。旧注册继续沿原guardId、startedAt和任务身份读取，原后台任务仍用首次返回的taskId查询。

## 必需原件与参考材料

外部证据默认必需，report、output、screenshot等角色也属于必需。reference、context、optional表示参考材料。range限定本次实际要求读取的行段，完整性按该范围核验。

执行聊天默认必需。提供明确的必需外部原件后，可在check设置executionEvidenceRole为reference，模型据这些原件判断，聊天读取与裁剪缺口单独列出。只有参考材料、缺少原日志或实际工作未完成时，工具继续保留缺项。

Task勾选作为任务自述，完成情况由实际证据核验。当前check返回后才能写的通过记录可以在检查后保存，HTTP原始日志、测试结果等实质材料须在审查时提供。

## 每阶段登记一次原件

Task内可声明当前阶段的原件清单，后续check沿原Guard自动加载，省去反复组装evidenceAssets。声明只用于匹配的stageId和childScopeId，路径相对Task所在目录：

````markdown
```guard-evidence
{"version":1,"stageId":"Stage 3","childScopeId":"main","manifest":"evidence/stage3.json"}
```
````

清单文件保存显式原件位置，路径相对清单所在目录。也可把assets直接写进Task声明，或在evidenceAssets中传type="manifest"和清单路径：

```json
{
  "version": 1,
  "stageId": "Stage 3",
  "childScopeId": "main",
  "assets": [{
    "path": "original-request.json",
    "label": "请求与最终结果",
    "range": "json:[\"/request\",\"/response/status\",\"/response/result\",\"/finishedAt\"]",
    "role": "required",
    "maxChars": 12000
  }]
}
```

JSON范围使用JSON Pointer定位原字段，支持数组下标及~0、~1转义。选择的字段按原值进入输入，源文件SHA与所选路径一同保留，其余字段未进入本次审查。字段缺失、JSON不完整或声明错误会在调用模型前列出具体缺口；必需材料过大时继续显示实际预算差额。声明文件限512KiB，累计最多128项，不递归展开清单或遍历未声明目录。

必需原件先读取并检查，之后再处理聊天。executionEvidenceRole="reference"时只尝试已发布缓存，保留缓存代次及当前来源未刷新的说明，缺缓存时继续依据必需原件审查。最终模型只分析已提供输入，缺原件时指出所需内容，保持单轮小阶段检查。

Task、Plan或清单原件改变后，新的check按输入版本区分结果；同一Guard已有运行中或挂起的检查时继续返回原taskId，不重复发模型。查询既有taskId始终读取那一次检查，原返回与诊断保留。

## 看懂材料预算

maxChars限制一项证据进入提示的完整字符数，包括取得的索引正文、路径、标签、状态和诊断。若完整序列化需要2015字符、maxChars为1800，缺额为215；补到完整所需额度后，工具才能完整注入这项材料。

每项结果及manifest中的budget包含：

| 字段 | 含义 |
|---|---|
| sourceBodyChars / sourceMetadataChars | 已取得的索引正文与元数据字符数 |
| requiredChars | 完整注入已取得索引所需的字符数 |
| grantedChars / shortfallChars | 本次实际分配额度与相对完整成本的缺额 |
| completeSourceKnown | 请求范围的原内容是否已完整取得 |

completeSourceKnown为false时，成本只覆盖已取得的索引，原内容的完整成本仍未知。图片元数据、抽样提取或未读取材料保留其覆盖缺口。

总预算先分配给必需原件，其中较短材料优先，再分配参考材料。返回items保持调用者的输入顺序，提示里的材料可以按优先顺序排列；includedStart和includedEnd给出真实注入位置。最终提供者还会依据本源上限预检，必需内容放不下时列出缺项与预算，供调用者缩小本次范围、补齐原件或选择可容纳材料的既有链路。

现有软件默认预算继续保留，计量单位为UTF-16字符：

| 模型链路 | 输入上限 | 输出预留估计 |
|---|---:|---:|
| Grok | 200000 | 24000 |
| agy CLI / Antigravity LS | 24000 | 4000 |
| Codex / Claude Code | 100000 | 16000 |

环境覆盖与实际提供者会写入报告，Grok Guard另有既有输出token上限。回退使用实际接手链路的预算，输出截断、取消和基础设施错误仍保留各自状态。

## 模型预检与失败诊断

Grok先通过统一模型接纳读取本机代理的`GET /v1/models`，总预算默认10秒，包含接纳等待和HTTP读取；`MEMORY_STORE_GROK_STATUS_TIMEOUT_MS`可覆盖，最大60秒，调用者原有截止时间和取消仍优先。健康结果缓存60秒，失败结果仅缓存5秒，取消不写入失败缓存。报告中的`phase=admission|transport|complete`区分等待接纳与实际HTTP，`failure`、`elapsedMs`、`timeoutMs`和`httpStatus`显示本次具体原因。

目录探测为只读操作，超时按链路可用性失败处理，父调用取消按取消处理；真实模型生成超时、连接中断或结果未知仍保留原任务与禁止重放的状态。目录读取成功后，实际模型生成继续使用同一套统一接纳和原有输出、时间、上下文上限。

Codex诊断分别保存stdout事件和stderr原文。stderr中的明确工具拒绝会记录独立来源、行号和原始行哈希，并及时停止原调用及其子进程；目录刷新超时、一般工具失败和引用示例分别处理。stderr补充不会增加stdout事件数，也不会把`eventCoverage=partial`改为完整；发生拒绝的原动作保持停止，报告用于核对实际原因。

## 活动聊天与后台检查

Codex来源固定读取边界，边界后的纯追加可继续，边界内改写、截断、替换或祖先冲突会触发校验。原历史保持只读，报告保存实际来源和覆盖范围。

后台check显式传background=true，立即返回原taskId；默认或background=false先同步等待最多45秒，未结束时返回同一持久任务，继续用原taskId加waitSeconds=30～45查询。同步与后台共用同Guard在途登记，取消也针对该原任务。审查通过后再保存阶段完成记录，后续模型或进程恢复继续核原任务与副作用。
