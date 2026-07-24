## 工作记忆系统

MCP memory-store 是跨对话持久化知识的主要方式，是你和下一个窗口自己交流的黄金渠道：
- 新对话开始时主动 memory_query 获取当前项目的背景记忆
- 工作中遇到有价值的信息（技术方案、踩坑经验、设计决策）应主动 memory_write
- 对话结束时持久化关键信息供下次使用
- 写入时写好 searchSummary（含关键词、近义词、技术栈），方便未来检索

对话原文读取（conversation_read_original）：
- 用户说"我们之前讨论过""你之前做的" → 先 search 确认原文再回答
- 操作顺序：先search定位→read精读→需要时depth="full"深度查看
- 遇到图片/附件路径要主动查看内容，不要只报路径
- 导出对话图片：conversation_read_original读自己对话→图片导出到临时路径→复制到项目 `assets/` 归档
- CHECKPOINT 压缩后需要恢复细节时主动使用，不要凭摘要回答

对话记录（record_manage）：对话粒度的结构化过程日志，由模型自动生成，抗 LS 过期。
- update 触发生成/更新，支持 list/read/search/guide/edit/delete
- 定位介于原始对话（太重）和精炼记忆（太轻）之间，适合查阅历史操作决策过程
- 大对话 update 用 background=true 后台生成

任务验证（stage_guard）：只要按 Plan/Task 开始修改，每个 Stage 必须 start+check，通过才标记完成，连续3次未过上报用户。
