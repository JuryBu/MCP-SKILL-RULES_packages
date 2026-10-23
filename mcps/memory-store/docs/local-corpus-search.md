# 本地对话全文搜索与快速读取

`conversation_read_original` 的 `search_all` 在本机 Codex 对话中按正文查找，覆盖会话目录和归档目录里的明文、压缩历史。结果按对话分组，提供命中轮次、原文片段、各词出现次数、命中消息数和来源版本。默认读取真实用户与主助手正文，工具和子代理内容按 `messageRoles` 选择。

## 先搜索，再展开命中轮次

启动时用 `conversationId` 指定当前调用者的稳定 ID。`conversationIds` 用于限定目标对话，省略时搜索全部本地候选；`workspaces` 可限定一个或多个工作区。

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
  "conversationId": "matched-thread-id",
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

`read_fast` 无需先等待完整 `fetch`。`conversationId` 仍是当前调用者，`conversationIds` 可指定一个目标，省略时读取当前对话。

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

默认并行准备完整正文缓存，响应中的 `cachePreparation.taskId` 可用 `search_all_status/cancel/resume` 管理；`prepareCache=false` 只读取所需范围。重复请求按调用者和目标复用健康准备任务。完整正文缓存与含工具详情的旧 `fetch` 快照分别保存，详细原文仍沿原 `fetch/read` 能力读取。

`requestedRangeComplete` 表示本次请求范围已读完，`fullSourceProjectionComplete` 表示完整来源正文投影已建立。范围读取成功后，完整准备可以继续后台运行。完整缓存发布失败时保留上一份已验证结果及失败状态。

明文与压缩副本同时存在时，完整读取核验完整副本，提前返回的范围读取核验所采用的字节前缀；范围外内容继续保留为未完整读取。复用缓存前也会检查新增副本及原来源身份。图片、文件与媒体引用在直接读取和旧缓存复用中保留，内联二进制仅保留哈希及引用元信息。

首次没有正文索引时，搜索会读取采用历史并建立投影；超大压缩历史还需验证旧内容与新物理文件的一致性，这部分可能持续数分钟。已有缓存读取、首次转换和增量更新分别计时，进度里的逻辑字节包含解压后的内容。旧格式缺少的消息时间会明确保留为未知，按消息时间排序的搜索会重建所需投影。

## 取消、恢复与输出

`search_all_cancel` 和 `search_all_resume` 均需原调用者 ID 和原 `taskId`。取消等待读取停止后结束，进程退出后的持久任务可恢复；来源或查询语义升级时重新核定受影响结果，旧快照保留自己的来源与版本。

`coverage` 提供候选、已处理、未处理、不完整和错误数量。`sourceBytes` 表示已处理逻辑来源字节，压缩文件大小与解码字节分别核算。页长只控制展示量。

有效缓存采用最多四项的只读预取，完整来源重建与结果提交继续串行，取消后先排空本任务的预取。状态请求可在新提交到达时提前返回；客户端可按一至五秒的展示节奏消费变化，避免无间隔反复请求整个状态。工具执行失败时，MCP响应带 `isError=true`，调用者应先检查该标志，再读取结果字段。

超过内联预算的 JSON 写入完整文件，响应提供 `artifactPath`、`bytes` 和 `sha256`。读取文件后可核对哈希，完整结果保留原字段与轮次，恢复材料应在临时文件过期前保存到任务目录。
