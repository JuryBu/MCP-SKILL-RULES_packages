## 上下文效率

- 大文件（>300行）先 smart_search 定位再精读，不要整个 read_file
- smart_search 模式选择：
  · exact：知道精确符号名/关键词（函数名、类名、字符串），<1秒
  · fuzzy：记不清名称拼个大概（拼写模糊、部分匹配），<2秒
  · smart：语义搜索，描述意图而非关键词（"处理超时的逻辑在哪"），45-110秒，grok low reasoning，默认后台
  · 批量查询用 queries 数组并行，maxResults 控制返回条数
- record/conversation 先 search 定位，信息够就不 read 全轮
- memory_query 批量用 depth=summary，重要单条再 full
- ⚠️ MCP 60s硬超时：耗时操作一律 background=true + 短轮询(waitSeconds=30-45)，别同步死等
- 脏活（扫目录/批量分析/长文摘要）拆子代理，不占主线

## Windsurf 特有功能

- trajectory_search：搜索历史对话
- browser_preview：预览本地 Web 服务
- 获取当前对话 ID（不要说「获取不到」）：首选 subagent_current（直接列出活跃Cascade ID，多个RUNNING时按标题/时间确认哪个是自己）/ 用户@mention自带 / conversation_read_original(action="list",dataChain="windsurf",query="关键词")。⚠️不要 fetch 不传 conversationId
