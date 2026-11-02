# Memory Store 的职责

将本片段合并到接收方已有 `~/.dsh/rules/60-context-memory.md` 的「Memory Store 的职责」节，保留宿主上下文、Record 与线程规则；合并后另行核对实际请求的加载情况。

阶段决策、长期事实、验证结论与可复用经验写入 Memory Store；短期 Todo 留在任务中。回答旧讨论的具体内容时读取原文，保留 Record 与摘要的来源。

`conversation_read_original` 的新 `search_all/read_hit/read_fast/prepare` 以稳定 `conversationId` 标识当前调用者，目标放 `conversationIds`；本端显式用 `dataChain="dsh"`，跨端选择具体 `dataChain`，多端用 `dataChains` 明列，禁止用 `auto` 猜来源。DSH 与 Windsurf 只提供数据链路，模型另选受支持的 `modelChain`。

正文跨对话查找用 `search_all` → `search_all_status`，取消/恢复用 `search_all_cancel/search_all_resume`，沿同一调用者和原 `taskId`；`read_hit` 保留命中的来源、目标、`sourceRevision` 与轮次。

末 N 轮或定点范围用 `read_fast` / `prepare`，限单端单目标，末 N 轮用 `lastRounds=N`，默认近期优先，早期准备用 `buildOrder="oldest"`。分段准备沿原任务用 `prepare_status/prepare_cancel/prepare_resume`；兼容直接快读若带 `cachePreparation.taskId`，按其搜索缓存任务操作，优先遵循响应 `next`。保留相对轮次、`partial` 与未覆盖范围，相对轮号只用于原块。

ready 沿原 `taskId`：末 N 轮 `read_ready(lastRounds=N)` 省略 `rangeRef`；固定引用 `read_ready/extract_ready` 用 `rangeRef`（单轮），`locate_ready` 必传 `taskId` 与 `rangeRef`；`search_ready` 的 `rangeRef` 仅选缓存版本，范围用 `blockId/startRound/endRound`。

完整 `fetch` 继续用于完整规范化、recall、Record 等；局部读取按上述范围入口使用。`search_all/read_hit/read_fast` 的 `source` 省略或填 `auto/local`；`read_fast` 不使用 `forceRefresh=true`，刷新仅用于新建 `search_all`。旧完整缓存用 `search/read(source="cache")`，`ls` 通过支持的旧入口读取。长返回沿 continuation/artifact 继续，参数与长例见工具 guide 和[五端正文搜索与范围读取](../../mcps/memory-store/docs/five-host-search.md)。
