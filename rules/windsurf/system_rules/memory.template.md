## 工作记忆系统

MCP memory-store 是跨对话持久化知识的主要方式，是你和下一个窗口自己交流的黄金渠道：
- 新对话开始时主动 memory_query 获取当前项目的背景记忆
- 工作中遇到有价值的信息（技术方案、踩坑经验、设计决策）应主动 memory_write
- 对话结束时持久化关键信息供下次使用
- 写入时写好 searchSummary（含关键词、近义词、技术栈），方便未来检索

对话原文读取（conversation_read_original）：用户问及旧讨论时核对原文。本端显式填写 `dataChain="windsurf"`，同时覆盖旧 Cascade 与 Devin Desktop / Local；跨端用具体 `dataChain`，多端用 `dataChains` 明列，禁止用 `auto` 猜来源。新接口的 `conversationId` 固定为当前调用者，目标写入 `conversationIds`，宿主归属按来源证据确认。
- 正文跨对话查找：`search_all` → `search_all_status`；取消/恢复用 `search_all_cancel/search_all_resume`，沿同一调用者和原 `taskId`；`read_hit` 原样传命中的来源、目标、`sourceRevision` 与轮次。
- 末 N 轮或定点范围：`read_fast` / `prepare`，限单端单目标，末 N 轮用 `lastRounds=N`，默认近期优先，早期准备用 `buildOrder="oldest"`。分段准备沿原任务用 `prepare_status/prepare_cancel/prepare_resume`；兼容直接快读若带 `cachePreparation.taskId`，按其搜索缓存任务操作，优先遵循响应 `next`。
- ready 沿原 `taskId`：末 N 轮 `read_ready(lastRounds=N)` 省略 `rangeRef`；固定引用 `read_ready/extract_ready` 用 `rangeRef`（单轮），`locate_ready` 必传 `taskId` 与 `rangeRef`；`search_ready` 的 `rangeRef` 仅选缓存版本，范围用 `blockId/startRound/endRound`。
- 保留相对轮次、`partial` 和未覆盖范围；相对轮号仅用于原块，完整覆盖按返回状态核对。Devin 初始近期窗口保留身份关联待核验状态，绝对轮次按核验结果读取。
- 完整 `fetch` 用于完整规范化、recall、Record 等，旧 `search/read` 复用已提交完整缓存；局部查找按上述范围入口读取。`recall` 仅从已提交完整 fetch generation 恢复用户/模型可见内容，压缩摘要保留其摘要身份。
- `search_all/read_hit/read_fast` 的 `source` 省略或填 `auto/local`；`read_fast` 不使用 `forceRefresh=true`，刷新仅用于新建 `search_all`。旧完整缓存用 `search/read(source="cache")`，`ls` 通过支持的旧入口读取；长返回沿 continuation/artifact 继续。区分真实用户、批注和子代理事件；图片附件实际查看，需长期保留时归档到项目。

参数和长例见工具 guide 与[五端正文搜索与范围读取](../../../mcps/memory-store/docs/five-host-search.md)，全局入口只引用本片段。

对话记录（record_manage）：对话粒度的结构化过程日志，由模型根据原文生成，抗 LS 过期。
- update 在授权范围内触发生成/更新，绑定稳定 `conversationId`、`dataChain="windsurf"` 与受支持的 `modelChain`；支持 list/read/search/guide/edit/delete
- 定位介于原始对话（太重）和精炼记忆（太轻）之间，适合查阅历史操作决策过程
- 大对话 update 用 background=true 后台生成
- Record 只接纳已校验且未过期的完整 fetch 缓存 generation
- 创建、排队、恢复到完成始终轮询同一个公开 taskId；普通后台任务也可统一用 background_task_status / background_task_cancel

任务验证（stage_guard）：按 Plan/Task 执行时，每个 Stage 必须 start+check，通过后标记完成，连续3次未过上报用户。start 绑定当前稳定 `conversationId`、`dataChain="windsurf"`、Plan/Task 完整绝对路径与具体 `stageId`，审核模型另选受支持的 `modelChain`。partial/stale 先核来源、证据与预算，按需刷新完整缓存或补证；证据角色和长例见[单轮 Guard 审查](../../../mcps/memory-store/docs/stage-guard.md)。
