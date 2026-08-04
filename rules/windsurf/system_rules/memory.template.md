## 工作记忆系统

MCP memory-store 是跨对话持久化知识的主要方式，是你和下一个窗口自己交流的黄金渠道：
- 新对话开始时主动 memory_query 获取当前项目的背景记忆
- 工作中遇到有价值的信息（技术方案、踩坑经验、设计决策）应主动 memory_write
- 对话结束时持久化关键信息供下次使用
- 写入时写好 searchSummary（含关键词、近义词、技术栈），方便未来检索

对话原文读取（conversation_read_original）：
- 用户说"我们之前讨论过""你之前做的" → 先 search 确认原文再回答
- 操作顺序：先search定位→read精读→需要时depth="full"深度查看
- `fetch` 建立或更新规范化缓存，后续 search/read/full/diff 从同一缓存派生；fetch/search/read/export 都要显式传稳定 conversationId
- `source="auto"` 以本地 PB 为一等来源并按需比较 LS，`local` 只读 PB，`ls` 只读 Language Server，`cache` 只读上一份完整可用缓存
- 单次返回默认约 100K 字符，超出时使用响应给出的 continuationCursor / 下一段参数继续，不能把截断当成完整结果
- `messageRoles=["user"]` 只含真实用户消息与结构化批注，`messageRoles=["subagent"]` 单独读取子代理事件；批注搜索返回命中的单条 Annotation 与命中字段
- 遇到图片/附件路径要主动查看内容，不要只报路径
- 导出对话图片：conversation_read_original读自己对话→图片导出到临时路径→复制到项目 `assets/` 归档
- CHECKPOINT 压缩后需要恢复细节时主动使用，不要凭摘要回答

对话记录（record_manage）：对话粒度的结构化过程日志，由模型自动生成，抗 LS 过期。
- update 触发生成/更新，支持 list/read/search/guide/edit/delete
- 定位介于原始对话（太重）和精炼记忆（太轻）之间，适合查阅历史操作决策过程
- 大对话 update 用 background=true 后台生成
- Record 只接纳已校验且未过期的 fetch 缓存 generation；Guard start 只核对缓存元数据，check 再按实际范围读取，不应预先扫整份对话
- 创建、排队、恢复到完成始终轮询同一个公开 taskId；普通后台任务也可统一用 background_task_status / background_task_cancel

任务验证（stage_guard）：只要按 Plan/Task 开始修改，每个 Stage 必须 start+check，通过才标记完成，连续3次未过上报用户。
