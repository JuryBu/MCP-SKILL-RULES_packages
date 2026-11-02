# 五端正文搜索与范围读取

`conversation_read_original` 的 `search_all`、`read_hit`、`read_fast` 和分段准备接口支持 `codex`、`claude-code`、`windsurf`、`antigravity`、`dsh`。Windsurf来源也包含Devin桌面/CLI日志；DSH使用DeepSeek Harness本地会话日志。

## 选择来源和目标

`conversationId` 始终填写当前调用者的稳定ID。新查询必须显式填写具体 `dataChain`；查询当前端时，调用者也填写当前端的具体值。多个端同时查找用 `dataChains`。`auto`无法指定本次搜索范围，省略来源会返回修正参数的提示。

| 参数 | 作用 | 示例 |
|---|---|---|
| `dataChain` / `dataChains` | 选择一个或多个来源 | `"claude-code"` / `["codex","windsurf"]` |
| `conversationIds` | 限定目标对话 | `["target-session-id"]` |
| `workspaces` / `workspaceMode` | 限定工作区及匹配方式 | `["/workspace/project"]` / `"exact"` |
| `messageRoles` | 只查指定角色正文 | `["user","assistant"]` |

单次范围读取只选择一个端和一个目标。同一字符串ID出现在两个端时分别保留，命中中的来源必须原样传给后续 `read_hit`。同一端的桌面ID/词对ID仅在来源证据确认后关联；无法确认的别名、工作区或来源保持相应诊断。

```json
{"action":"search_all","conversationId":"caller-id","dataChains":["codex","windsurf"],"allTerms":["缓存","轮次"],"excludeTerms":["旧方案"],"messageRoles":["user","assistant"]}
```

`allTerms`取交集，`anyTerms`取并集，`excludeTerms`排除；`intersectionScope`默认同一对话，可改为同一轮或同一消息。结果按 `searchSort`排序，`latest_match`使用命中消息的时间，`activity`使用对话活动时间，还可选 `occurrences`或 `messages`。

## 动态结果与命中展开

创建查询返回 `taskId`。沿同一调用者、原任务和来源执行 `search_all_status`，可用 `afterRevision`和 `waitSeconds`等待新增结果。命中给出次数、轮次、有限原文、`sourceRevision`及覆盖状态；分页游标绑定查询、来源与结果快照。`search_all_cancel`保留已提交结果，`search_all_resume`沿原任务继续。

```json
{"action":"read_hit","conversationId":"caller-id","dataChain":"windsurf","conversationIds":["target-session-id"],"sourceRevision":"revision-from-hit","startRound":8,"endRound":9,"messageRoles":["user","assistant"]}
```

`pending`修订仍在核验，暂时不能作为固定命中展开。来源发生变化后旧修订会被拒绝，应重新搜索或使用 `read_fast`读取当前范围。部分来源的命中保留 `provisional`、警告和已查范围；没有覆盖的部分不计作零命中。

## 先用已就绪内容

`read_fast(lastRounds=N)`默认优先准备最新N轮，`prepare`还可用 `buildOrder="oldest"`优先早期内容。`prepareCache=false`只准备所需窗口；默认后台继续完整构建。状态、取消与恢复分别使用 `prepare_status`、`prepare_cancel`、`prepare_resume`，始终沿原任务操作。

范围就绪后可立即 `read_ready`、`search_ready`、`locate_ready`、`extract_ready`，无需等待其它历史。`rangeRef`绑定原来源、版本和块，完整历史构建后旧引用仍可读。相对轮号仅用于该块，确认总轮次后再使用绝对轮号。

| 字段 | 含义 |
|---|---|
| `publishedRangeComplete` | 已发布的缓存覆盖了本次请求范围 |
| `sourceRangeVerified` | 来源本身能够确认该范围 |
| `requestedRangeComplete` | 综合已发布范围与来源确认情况 |
| `fullSourceComplete` | 整个来源已校验并完成发布 |

## 各端的读取与复用

Codex继续使用明文/压缩历史与继承关系的原有校验和追加优化。Claude Code和DSH按目标物理日志读取，追加时重放必要边界；缓存重开可复用已解析内容，但完整内容校验仍会读取来源。Claude逻辑前驱链的自动合并继续使用完整fetch入口。

Claude Code与DSH大日志的首次范围读取优先整理约4MiB首部或尾部正文，随后完整构建继续沿同一任务进行。JSONL仍流式核对整个来源内容与UTF-8；DSH压缩源仍逐帧解码并核checksum，只减少窗口外事件的JSON解析与轮次整理。来源变化、未完成记录及工具归属不足会保留相应诊断。

缓存写入按块计算字节数与SHA，达到大小预算即停止临时写入，已有缓存保持。`host_persistent_cache_budget_exceeded`表示本次完整宿主缓存超出预算，当前读取与已经发布的范围仍可使用；来源读取上限与持久缓存上限分别检查。

Devin先发现元数据，再核目标身份和主链，按需要的轮次读取正文；来源版本包含SQLite和现有WAL内容，单看文件时间无法发现WAL-only修改。WSF/Antigravity的PB文件先认证，再投影所需步骤；需要比较多个候选时仍核它们的一致性。完整fetch与新范围入口都保留坏候选、未知字段和partial诊断。

PB目录元数据缺少工作区时，按工作区筛选会列出 `pb_workspace_metadata_unavailable`及来源覆盖缺口；指定明确对话ID仍可读取。DSH未完成帧、PB未知变体等保留partial，工具不将它们计入完整来源。首次扫描、内容哈希、解密及完整构建仍有成本，接口持续报告实际进度与已就绪范围。
