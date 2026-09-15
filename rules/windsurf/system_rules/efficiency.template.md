## 上下文效率

- 大文件（>300行）先定位再精读，不要整个读入
- 代码/文件搜索分工：精确字面、文件名、小范围定位用宿主原生搜索（Devin Local 的 `grep` / `find_file_by_name` / `code_search` 等，零往返）；语义搜索、模糊拼写、大目录批量用 sandbox `smart_search`
- smart_search 模式选择：
  · exact：知道精确符号名/关键词（函数名、类名、字符串），<1秒
  · fuzzy：记不清名称拼个大概（拼写模糊、部分匹配），<2秒
  · smart：语义搜索，描述意图而非关键词（"处理超时的逻辑在哪"），45-110秒，grok low reasoning，默认后台
  · 批量查询用 queries 数组并行，maxResults 控制返回条数
- record/conversation 先 search 定位，信息够就不 read 全轮；需要大段原文时从 fetch 缓存按约 100K 字符的继续位置分段读取，不重复解析源文件
- memory_query 批量用 depth=summary，重要单条再 full
- ⚠️ MCP 宿主可能有短请求窗口（旧 Windsurf 约 60 秒；共享 HTTP broker 普通调用默认 120 秒，带 waitSeconds/timeout 的等待类调用可放宽）。耗时操作一律 background=true + 短轮询(waitSeconds=30-45)，别同步死等
- 脏活（扫目录/批量分析/长文摘要）拆子代理，不占主线

## 工具调用纪律

- **并行调用**：无依赖的工具调用一次并行发出（读多个文件、多路搜索、同时 fetch 两个对话等），不要串行一个个等结果。存在数据依赖（先读后改、先改后测、先起服务再预览、先建目录再写文件）、同一文件写入冲突或高风险步骤时必须串行；返回顺序不保证等于发起顺序
- **循环检测**：同一工具连续调用 3 次以上参数相似且结果无实质变化→立即停止，自问参数有没有变、策略该不该换
- **结果截断处理**：工具结果被截断→读临时文件或缩小范围重读，不忽略截断继续用同样参数调

## 宿主功能（Windsurf Cascade / Devin Desktop）

- `browser_preview`：预览本地 Web 服务
- 旧 Cascade 独有的 `trajectory_search`、`subagent_current`、MCP `subagent` 在 Devin Desktop（Devin Local 内核）中已不存在，不要写进新流程
- Devin 会话 ID 有两套形态：Desktop 侧每个对话一个 UUID（`%APPDATA%\Devin\User\acp-messages\<UUID>.db`）；CLI 侧文字词对 ID（形如 `<形容词>-<名词>`，存于 `%APPDATA%\devin\cli\sessions.db`）。memory-store `dataChain=windsurf` 两种都接受并返回别名，不用自己判断格式
- 找「我是哪个对话」（不要说「获取不到」）：`conversation_read_original(action="list", dataChain="windsurf", workspaces=[当前工作区], contextProbe="本对话 50-120 字独特原文")` 或 `deep_locate`；默认预算下常返回 partial，状态为 `single_match_in_partial_scan` 且命中唯一即可直接拿 ID 去读，要全范围确认再加 `deadlineMs`；多候选时按标题与命中轮次人工确认，不冒充唯一。用户 @mention 的对话自带 ID；Devin CLI 的 `devin list --format json` 只作辅助（交互式 `devin list` 会挂住）。⚠️不要 fetch 不传 conversationId
- 原生子代理记录：`list(threadMode="children", parentConversationId=父ID)` 取子 ID（形如 `父ID--subagent-<agentId>`）→ `read(conversationId=子ID)`；读父对话时 `messageRoles=["subagent"]` 只看子代理事件，`link="expand_children"` 才展开子消息（大会话慎用）
