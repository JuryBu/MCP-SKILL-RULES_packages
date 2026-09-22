# Sandbox执行与后台任务

适用：本机执行遇到接纳、内存、超时、取消或输出截断，或需要配置这些参数。主规则中的Sandbox优先和禁止sandbox_codex不因本文件而放宽。

## 先判断命令是否启动

| 状态 | 含义 | 下一步 |
|---|---|---|
| `admission_timeout` | 尚未启动，接纳等待超时 | 查 `admissionDecision.blockedBy`，按有效退避最多重试一次 |
| `execution_timeout` | 已启动，超出执行期限 | 检查副作用及进程树清理，再决定后续 |
| `caller_deadline_exceeded` | 排队加运行超出调用方期限 | 按 `mayHaveStarted` 判断，不把未知当作未执行 |
| `broker_backend_timeout` | broker与后端通信超时 | 查原持久任务或外部状态，禁止盲目重发 |

`working_directory_missing`、`windows_job_runner_missing` 等启动前错误应有 `commandStarted=false`；先修正对应环境问题，不绕过Sandbox改用原生命令。取消、超时或内存终止后等待整棵进程树清理，不能把返回取消视为全部副作用已撤销。

## 资源接纳

`memoryRequestMB` 是启动估计，`maxMemoryMB` 是整棵进程树的硬上限，二者不能混同。接纳依据当前物理/提交水位、新鲜采样、低内存信号以及会话和批任务的独立限制；一次拒绝不等于整机缺内存，也不等于后端不可用。Windows完整压力样本缺失或过期、后台资源记账未恢复时，新执行可能继续排队或返回未启动的超时；查询与取消仍可用，应先等待或修复状态，不绕过Sandbox。

先看拒绝原因、有效请求与采样，再参考有效 `retryAfterMs`，最多重试一次；0毫秒不表示应立即重试。仍受阻时拆小实际任务、改后台或报告等待原因，仅在有测量依据时更正高估。禁止盲目低报内存、并发重发、调高全局上限或绕过Sandbox。

参数合法范围、默认估计、可配置硬上限和调度策略以当前 `tools/list`、`sandbox_status`、`sandbox://guide` 为准，不沿用旧版本数字。显式小请求与默认推导下限不同；不能把参数越界当成系统内存压力，也不能重复扣除已计入实际水位的观测增长。工具说明可能缓存，不为刷新说明重启宿主。

## 输出、搜索与归属

输出超预算时保留完整artifact及其路径、SHA256、大小和有效期；头尾预览不是全文，结论需要全部证据时继续读取artifact。`maxOutput`、`maxLines`和batch共享预算按实时说明设置，避免重复放大返回内容。

大目录先用有界exact搜索缩小范围；fuzzy/smart长搜索优先后台。取消须使用原 `taskId`，不另开任务覆盖旧状态。`runMs`仅表示实际运行时间，排队时间单独计算。等待进度可能不在宿主展示，最终结构化状态才是判断依据。

持久任务显式带稳定 `ownerId`，只管理自己的任务和资源。数据、模型链路与对话ID按主规则显式传入，后端共享状态不代表存在安全的默认「当前对话」。

## 后台与外层期限

Sandbox内部期限和Codex宿主/MCP broker期限是不同层。长任务优先 `background=true`，持同一任务ID以30～45秒短轮询，不用一个超长同步调用占住宿主；轮询不设超过60秒。未知执行状态先查原任务，不重复启动。

共享broker的期限算法应查实际配置和工具说明，不能把旧默认值当作永久保证。重点是使一次轮询小于宿主期限，并为调度、通信和返回保留余量。

| 操作 | 后台方式 |
|---|---|
| Record更新 | `record_manage(update, background=true, dataChain="codex", modelChain="codex")`，用返回的原任务ID查询 |
| 阶段检查 | `stage_guard(check, background=true)`，原 `taskId` 加 `waitSeconds=45` |
| 语义提取/网页总结/大范围语义搜索 | 对应工具 `background=true`，原 `taskId` 加30～45秒等待 |
| 统一查询/取消 | `background_task_status` / `background_task_cancel`，保留归属与原任务ID |

具体工具支持的字段和数据/模型链路仍以当前接口为准，后台恢复、短轮询或请求超时都不是重新创建同一任务的理由。
