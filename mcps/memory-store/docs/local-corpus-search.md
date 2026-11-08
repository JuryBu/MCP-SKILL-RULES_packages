# 本地对话全文搜索与快速读取

`conversation_read_original` 的 `search_all` 支持本机Codex、Claude Code、Windsurf/Devin、Antigravity和DeepSeek Harness五端正文查找。Codex覆盖会话目录和归档目录里的明文、压缩历史，其它端使用各自来源适配器。结果按来源和对话分组，提供命中轮次、原文片段、各词出现次数、命中消息数和来源版本。默认读取真实用户与主助手正文，工具和子代理内容按 `messageRoles` 选择。五端差异及完整性字段见[五端搜索与范围读取](five-host-search.md)。

## 先搜索，再展开命中轮次

五端默认 `fetch` 与 `read_fast` 采用分段准备：先返回原任务及读取已就绪范围的 `next`，其余历史继续准备。需要完整持久 fetch 缓存供完整整理使用时，显式设置 `progressive=false`，大来源同时使用 `background=true`。非Codex来源的完整后台fetch仍使用原分段任务，沿返回的 `prepare_status` 查询；就绪范围继续可读，完整缓存发布后状态中的 `fullFetchCache` 给出 `cacheKey`、`cacheGeneration`、目标与实际完整性，供旧缓存读取入口使用。普通正文与 `full` 的思考、工具详情分别准备；按 normal 准备的原任务需要详情时，工具会给出按 full 准备的入口。

已就绪范围可以直接导出：`action="export"`、原调用者 `conversationId`、具体 `dataChain`、原 `progressiveTaskId`，再选择一个 `rangeRef`、`lastRounds` 或明确轮次。固定引用导出单轮，范围相对轮号需带原块；导出保留已核覆盖、身份警告和未知总数，读取与导出使用同一范围。

启动时用 `conversationId` 指定当前调用者的稳定 ID，单端必须显式填写具体 `dataChain`，多端用 `dataChains`，当前端也填写具体值，不省略或用 `auto`。`conversationIds` 用于限定目标对话，省略时搜索所选端的全部本地候选；`workspaces` 可限定一个或多个工作区。

子线程正文搜索可传`threadMode="children"`和准确的`parentConversationId`，只扫描来源中已核实属于该父线程的候选；未显式指定`messageRoles`时读取子代理正文，full或工具详情视图另包含工具内容。`parentDataChain`填写与单一`dataChain`相同的来源。`threadMode="main"`只查主线程，默认保留全部类型。按父标题定位时先用`list`取得准确ID。

`search_all`的`limit`只控制状态响应的页大小。`maxFiles`、`maxBytes`、`maxHits`和`deadlineMs`限制每次执行或恢复的扫描；`maxHits`按新增命中对话计数，字节预算在来源提供进度的读取边界检查。达到预算后状态为`partial`，已校验结果和未查范围保留，使用原`taskId`的`search_all_resume`继续，预算重新计时和计数。

大结果首段返回`delivery="paged"`、结果`taskId`、SHA256及`next`。直接执行该`read_result`参数可续读同一结果的UTF-8文本，直到`complete=true`；原文件也保留。结果绑定原调用者，续读不重新扫描来源或启动模型。文件指针和首段各自说明实际交付范围。

```json
{
  "action": "search_all",
  "conversationId": "current-thread-id",
  "dataChain": "codex",
  "allTerms": ["缓存", "超时"],
  "excludeTerms": ["已废弃方案"],
  "intersectionScope": "conversation",
  "workspaces": ["D:/projects/example"],
  "workspaceMode": "under"
}
```

把示例里的 ID 和工作区替换为实际值。启动返回 `taskId`，之后始终查询这个任务。

```json
{
  "action": "search_all_status",
  "conversationId": "current-thread-id",
  "dataChain": "codex",
  "taskId": "returned-task-id",
  "afterRevision": 0,
  "limit": 8,
  "waitSeconds": 30
}
```

动态响应的 `changes.upserts` 更新已有对话，`changes.removedConversationIds` 撤回失效结果。首次使用 `afterRevision=0`，以后传已消费的 `changes.throughRevision` 或 `nextAfterRevision`；`changes.hasMore=true` 时继续取增量。顶层 `revision` 表示任务最新提交版本。

大对话尚未读完时，命中可先标为 `provisional=true`。后续排除词或来源校验可能撤回这些命中。最终统计以任务状态和 `coverage.complete` 为依据，`partial`、`failed`、`cancelled` 均保留相应缺口。候选范围在发现完成后冻结，新创建的对话由下一次搜索纳入。

结果确定后，用目标 ID、来源版本和轮次展开原文：

```json
{
  "action": "read_hit",
  "conversationId": "current-thread-id",
  "conversationIds": ["matched-thread-id"],
  "dataChain": "codex",
  "sourceRevision": "matched-source-revision",
  "startRound": 12,
  "endRound": 12
}
```

`read_hit` 核对同一来源版本，来源已变化时会提示重新搜索。暂计结果的来源仍在验证中；需要立即读取该轮时可使用 `read_fast`，响应会标出当前来源和读取范围。

## 组合条件、范围和排序

| 参数 | 含义 |
|---|---|
| `allTerms` / `anyTerms` / `excludeTerms` | 全部包含、任一包含、排除；三组条件一起使用时取交集 |
| `searchExpression` | 用 `term`、`all`、`any`、`not` 组合嵌套条件 |
| `intersectionScope` | 默认 `conversation`，可切为同一 `round` 或同一 `message` |
| `messageRoles` | 默认 `user, assistant`；另可选 `tool, subagent`，`model` 是 `assistant` 的别名 |

关键词按原文子串匹配，中文短词可直接使用；默认不区分大小写，`caseSensitive=true` 可改为区分大小写。出现次数按非重叠匹配统计，同一逻辑对话内的镜像消息按稳定消息身份去重。

| 参数 | 含义 |
|---|---|
| `conversationIds` | 指定一个或多个目标对话，可传完整 ID 或 Codex 对话链接 |
| `workspaces` / `workspaceMode` | 工作区集合；支持包含、精确、子目录及集合条件 |
| `searchSort` | 默认 `latest_match`，按实际命中消息时间；另有 `activity, occurrences, messages` |
| `limit` / `continuationCursor` | 控制返回页长和终态快照翻页，扫描继续覆盖全部候选 |

缺少消息时间时会标为未知；对话最近活动时间用于 `activity` 排序。纯排除查询可返回满足条件的轮次，正向词片段可能为空。

## 已知目标时直接读取

`read_fast` 无需先等待完整 `fetch`。`conversationId` 仍是当前调用者，`conversationIds` 明确指定一个目标，同时填写该目标的具体 `dataChain`。

```json
{
  "action": "read_fast",
  "conversationId": "current-thread-id",
  "conversationIds": ["target-thread-id"],
  "dataChain": "codex",
  "lastRounds": 3
}
```

也可使用 `startRound/endRound`，与 `lastRounds` 择一。只给 `startRound` 时读取该单轮，冷热路径保持相同范围。有效正文缓存可直接复用；旧缓存已提供规范轮次映射时，只展开请求所需的旧轮次，完整正文准备沿独立任务继续。无轮次映射时，读取晚期轮次或最后几轮仍需确定采用历史的正式轮次。首次准备、已有缓存读取和增量更新的时间分别记录。

默认的`read_fast(lastRounds=N)`返回分段准备任务，使用原 `taskId` 调用 `prepare_status/prepare_cancel/prepare_resume`，`prepare_status`以`afterProgressRevision`等待新增就绪内容。`prepare`的`buildOrder="latest|oldest"`选择近期或早期优先。就绪后读取末N轮用原`taskId`与`lastRounds`，省略`rangeRef`；固定引用重读或提取用原`taskId`与`rangeRef`，返回该引用的一轮，`locate_ready`也必须同时传两项。`search_ready`的`rangeRef`只选择缓存版本，查询范围由`blockId/startRound/endRound`限定。其余历史继续准备；`prepareCache=false`只准备所需范围。

指定`startRound/endRound`或显式`progressive=false`时，`read_fast`直接返回正文；如果带`cachePreparation.taskId`，该任务使用`search_all_status/cancel/resume`。`read_fast`的`source`省略或填写`auto/local`，不使用`forceRefresh=true`；强刷仅用于新建`search_all`，旧完整缓存使用旧`search/read(source="cache")`，LS来源通过支持它的旧入口读取。根据实际响应的`next`与任务种类选择操作，分段准备任务和搜索缓存任务不能混用。重复请求按调用者和目标复用健康任务，含工具详情的完整原文仍可沿原`fetch/read`读取。

分段准备响应的`requestedRangeComplete`表示本次请求范围已读完并经来源确认，`fullSourceComplete`表示完整来源已校验并发布；兼容直接读取响应的`fullSourceProjectionComplete`表示该来源正文投影完整。相对轮号只属于对应的`rangeRef`块，未核实总轮次或身份时保留部分覆盖诊断。范围读取成功后，完整准备可以继续后台运行。完整缓存发布失败时保留上一份已验证结果及失败状态。

明文与压缩副本同时存在时，完整读取核验完整副本，提前返回的范围读取核验所采用的字节前缀；范围外内容继续保留为未完整读取。复用缓存前也会检查新增副本及原来源身份。图片、文件与媒体引用在直接读取和旧缓存复用中保留，内联二进制仅保留哈希及引用元信息。

首次没有正文索引时，搜索会读取采用历史并建立投影；超大压缩历史还需验证旧内容与新物理文件的一致性，这部分可能持续数分钟。已有缓存读取、首次转换和增量更新分别计时，进度里的逻辑字节包含解压后的内容。旧格式缺少的消息时间会明确保留为未知，按消息时间排序的搜索会重建所需投影。

## 取消、恢复与输出

`search_all_cancel` 和 `search_all_resume` 均需原调用者 ID 和原 `taskId`。取消等待读取停止后结束，进程退出后的持久任务可恢复；来源或查询语义升级时重新核定受影响结果，旧快照保留自己的来源与版本。

`coverage` 提供候选、已处理、未处理、不完整和错误数量。`sourceBytes` 表示已处理逻辑来源字节，压缩文件大小与解码字节分别核算。页长只控制展示量。

有效缓存采用最多四项的只读预取，完整来源重建与结果提交继续串行，取消后先排空本任务的预取。状态请求可在新提交到达时提前返回；客户端可按一至五秒的展示节奏消费变化，避免无间隔反复请求整个状态。工具执行失败时，MCP响应带 `isError=true`，调用者应先检查该标志，再读取结果字段。

超过内联预算的 JSON 写入完整文件，响应提供 `artifactPath`、`bytes` 和 `sha256`。读取文件后可核对哈希，完整结果保留原字段与轮次，恢复材料应在临时文件过期前保存到任务目录。
