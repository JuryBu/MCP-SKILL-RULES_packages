/**
 * Memory Store MCP "guide" Resource 的完整使用指南正文。
 *
 * 此前作为一大段内嵌模板字符串塞在 index.ts 的 registerResource 调用里（200+ 行），
 * 影响 index.ts 可读性。原样抽到这里集中维护，index.ts 只 import 引用。
 *
 * 仅标题行的程序版本号改为引用 VERSION 单一来源；正文 changelog 里描述具体特性的
 * 历史版本标记（如 "v1.15.14 起..."）属文档内容，保持原字面量不变。
 */
import { VERSION } from "./version.js";

export const GUIDE_TEXT = `# MCP Memory Store v${VERSION} 使用指南

## 快速开始
- 新对话开始: memory_query() 或 memory_query(workspace="工作区路径") 获取背景
- 全局概览: memory_query(scope="global") 查看所有工作区
- 写入记忆: memory_write(title, content, searchSummary, tags, workspace)

## 11 个工具

### memory_write — 写入新记忆
- searchSummary 应由 AI 精心撰写，包含关键词、近义词、技术栈名称
- 自动检测相似记忆并提醒（不阻止写入）
- workspace 不传则归入 general 通用记忆
- pinned: 置顶标记（每个工作区/general 建议最多 3 条）
- ID 格式: YYYYMMDD-HHmmssSSS-slug（含毫秒，降低批量碰撞风险）

### memory_query — 查询记忆
- query: 模糊搜索 title+searchSummary+tags（搜索引擎 v2：多词分词+子串匹配+CJK 支持）
- grep: 正文精确搜索
- depth: index(默认) / summary / full(写临时文件返回路径)
- scope: workspace(默认) / global（全局查询支持跨工作区全文读取）
- tags/category: 过滤
- after/before: 时间范围过滤（ISO格式或YYYY-MM-DD，基于 updatedAt）
- 无参调用: 展示概览（📌置顶记忆 + 🕐最近记忆，总上限10条）
- 跨域推荐: 在工作区概览底部提示 general 置顶记忆数量

### memory_read — 读取单条
- startLine/endLine: 行范围读取
- 无范围: 写临时文件返回路径（节省上下文，需用 view_file 读取）

### memory_update — 更新/追加
- content: 替换全部正文
- append: 追加到末尾（自动加时间戳分隔线）
- tags: 合并到已有标签（不覆盖）
- removeTags: 移除指定标签
- category: 修改分类(problem-solution/technical-note/conversation/general)
- pinned: 设置/取消置顶
- title/searchSummary: 更新元信息

### memory_delete — 删除单条

### memory_batch — 批量操作（最多20个）
- 支持 write/read/query/update/delete 混合
- query 支持 query(模糊) 和 grep(精确) 两种

### memory_stats — 系统管理
- overview: 全局统计（默认）
- detail: 工作区详情
- gc: 清理临时文件+卸载缓存+孤儿工作区检测
- archive/unarchive: 冷工作区归档/解归档（gzip压缩，含路径安全校验）
- export: 导出记忆为 .gz（支持 workspace/ids 过滤，含已归档正文）
- import: 导入 .gz 恢复记忆（自动去重，按 updatedAt 比较新旧）

## 时间戳体系
- created/updated: 记忆 frontmatter 中自动记录
- lastAccessed: 索引中的最后访问时间
- append 追加: 正文中插入中文时间戳分隔线
- 查询过滤: 用 after/before 参数按 updatedAt 过滤

## 置顶记忆 (v1.1+)
- write/update 支持 pinned 参数
- 概览中 📌 置顶记忆始终显示在最前面（无论多老）
- 每个工作区/general 建议最多 3 条置顶
- AI 应持续维护置顶记忆，将核心知识浓缩在其中
- 跨域推荐: 工作区概览底部提示 general 是否有置顶记忆

## 最佳实践
1. 新对话优先 memory_query 获取背景（先看置顶记忆）
2. searchSummary 写好关键词（比正文更影响命中率）
3. 旧项目看到「工作记忆」文件夹时读取其中内容，考虑迁移到 MCP
4. 单条上限 15KB，建议按主题拆分多条
5. 对话结束前用 memory_write/update 持久化关键信息
6. 为项目/general 维护 1-3 条置顶精华记忆（17+1 模型）
7. 恢复状态时用 depth=summary 而非 full，避免上下文浪费
8. ⚠️ 项目有 Plan_x + Task.md 时，Stage 开始前 stage_guard(start)，完成后 stage_guard(check) 通过才能标记完成

### conversation_read_original — 读取对话原文 (v1.4+)
- 绕过 CHECKPOINT 压缩机制，读取对话的真实完整内容
- 六类操作：list(列出候选) / fetch(拉取缓存) / search(关键词搜索) / read(范围阅读) / export(持久导出 Markdown/PDF) / deep_locate(后台深搜定位)
- list/search 均支持 mode="auto|exact|fuzzy|smart"；list 会综合标题、ID、工作区、Record 摘要和近期上下文指纹定位对话
- list 的标题、ID、来源、工作区和主/子线程查询走轻量元数据定位；只有正文搜索才使用候选预算和 deep_locate
- Codex list 快查止血(v1.13.0): dataChain="codex" 且 mode="auto" 时，query 未命中不会自动读取多个超大 JSONL 原文预览，也不会自动触发 smart 模型搜索；若 query 是古老正文片段，会提示后续使用 deep_locate 后台深搜能力
- deep_locate(v1.17.3): conversation_read_original(action="deep_locate", dataChain="codex|claude-code", query="...") 默认自动进入后台 FIFO 队列并返回 taskId；支持 exact/fuzzy、进度、预算、partial hits 和 cancel/status；显式 background=false 不支持；Windsurf 首版不支持 deep_locate
- Record list / list ID 排序 / ETA 修复(v1.13.1): Record 归属 sidecar 出现 superseded 互指环时不再把所有副本都隐藏，列表和搜索会继续按完整度去重显示；conversation list 用完整 ID 查询时真实 ID 命中优先于标题正文提及；后台任务预计剩余时间改按当前阶段开始时间估算，避免把前一阶段耗时算入新阶段。
- Codex / Claude Code list 支持 contextProbe：从当前可见聊天截取 50-120 字独特上下文，硬匹配本地 JSONL 并标记候选；不会自动选中
- 三级详细度：brief(截断100字) / normal(完整文本) / full(含思考+工具结果；Codex 链路会展开可读 reasoning、工具事件、patch diff 和文件/计划视图)
- Antigravity LS 链路下，conversationId 不填可默认当前对话；Codex / Claude Code / Windsurf 通过共享后端、本地 JSONL 或只读 LS 接口定位，必须显式传稳定 conversationId
- extraTypes: 额外拉取 thinking/tool_results/code_actions/code_diffs/file_views
- "chain=\"auto|antigravity|codex|claude-code|cc|grok|agy|windsurf|wsf\"" 为兼容旧参数；cc 会归一为 claude-code，wsf 会归一为 windsurf；chain="windsurf" 只作为 dataChain 兼容写法，modelChain 回落 auto；chain="grok"/"agy" 只作为 modelChain 兼容写法，dataChain 回落 auto
- "dataChain=\"auto|antigravity|codex|claude-code|cc|windsurf|wsf\"" 控制原文来源；list/fetch/read/exact/fuzzy 主要使用 dataChain
- "modelChain=\"auto|antigravity|codex|claude-code|cc|grok|agy\"" 控制 smart 搜索的模型调用链路；显式 claude-code 只走 Claude Code CLI，显式 grok 只走本机 progrok proxy，显式 agy 只走本地 agy CLI 的三模型内部 fallback
- modelChain 不支持 windsurf/wsf，dataChain 不支持 grok 或 agy；Windsurf 只提供对话数据，Grok 与 agy 都只提供模型调用链路
- memory_query、memory_batch(query)、memory_write、memory_update、memory_stats(action="enhance") 也支持 modelChain；旧 chain 继续作为模型链路兼容别名
- "chain=\"auto\"" 优先当前宿主链路；模型调用按 Grok →（仅 MEMORY_STORE_AGY_AUTO_ENABLED=1 时）agy → Antigravity → Codex → 可选 Claude Code CLI 探测
- 显式指定 "modelChain=\"grok\""、"modelChain=\"agy\"" 或对应旧 chain 时只使用该模型链路，不可用直接报错；agy 内部仅按「Gemini 3.5 Flash (High) → Flash (Medium) → Gemini 3.1 Pro (Low)」fallback，不会跨到其它宿主模型链路；显式指定 "chain=\"antigravity\""、"chain=\"codex\"" 或 "chain=\"claude-code\"" 时同样不静默回退
- Antigravity 链路通过 Language Server 本地 API 获取解密数据，无需手动解密 .pb 文件
- Codex 链路通过本地线程索引与原始事件流重建轮次
- Codex 附件懒解析(v1.12.2): fetch 只返回附件统计；read/search 只对实际输出轮次按需处理图片和文件路径。local_images 本地路径优先；仅当图片只存在于 JSONL 的 data:image base64 时，才并行限流写入 memory-store/temp/codex-attachments/<conversationId>/round-xxxxxx/sha256-*.png。普通 PDF/DOCX/Markdown 文件从 Files mentioned 文本块解析路径并标注存在性，不读取正文。可用 MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_LIMIT / MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_CONCURRENCY / MEMORY_STORE_CODEX_ATTACHMENT_MAX_BYTES / MEMORY_STORE_CODEX_ATTACHMENT_MAX_TOTAL_BYTES 控制数量、并发、单图大小和单次总解码量。
- Codex 超大 JSONL 流式读取(v1.12.6): 本地 rollout 改为分块逐行解析，超长 session_meta / 加密 reasoning / 单条超大文本在读取层丢弃或裁剪；conversation_read_original 的 fetch/read/search 也会按预算构建输出，避免 1GB+ 对话在原文读取或 Record 更新前置阶段触发 V8 字符串上限。
- Record Local Compose 轮次范围解析(v1.12.7): 质量检查支持 Phase 内 "轮次范围：X-Y" / "**轮次范围**：X-Y" 标签式写法，并替换粗体头部元数据，避免候选明明覆盖到目标轮次却被误判为只覆盖正文中某个旧轮次。
- Codex contextProbe 限时尾扫(v1.12.8): conversation_read_original(list, dataChain="codex", contextProbe=...) 默认只扫每个候选 JSONL 尾部窗口，并带总耗时预算，避免辅助定位当前线程时连续解析多个大 JSONL 触发 60 秒 MCP 客户端超时。
- Local Compose 旧 Phase 过滤(v1.12.9): 解析结构化增量时丢弃结束轮次早于 rewriteStartRound 的旧 Phase，防止模型重复输出稳定区后造成 59 -> 128 这类候选轮次跳跃；质量检查仍保留。
- Codex list 快查止血(v1.13.0): conversation_read_original(list, dataChain="codex", mode="auto") 只做 metadata/Record/reader index/contextProbe 快查；不再隐式原文深扫或 smart 兜底，避免标题/正文片段定位把同步 list 拖到 60 秒 MCP 超时。
- Codex deep_locate 后台骨架(v1.13.0): action="deep_locate" 以 background task 运行，exact/fuzzy 流式扫描候选 Codex JSONL 并返回 conversationId、round、role、offset、snippet；用 deep_locate_status 轮询，用 deep_locate_cancel 取消。
- Guard/Record 链路失败分类(v1.13.2): stage_guard 模型链路不可用或 Codex 模型桥退出时返回“审查未完成”，不计入未通过次数；Record Local Compose 兼容 "Phase 1-36" / "Phase 37-61" 旧范围标题，避免误判 Phase 编号跳号。
- Stage Guard 分段取证(v1.13.4): stage_guard(check) 不再全量吞入超长 Plan/Task/Record；会按 stageId、标题、头部规则、尾部、小本本和证据窗口裁剪，并固定注入命令、报告、run/obs ID、文件路径等证据清单。coverage 不足、锚点缺失或截断风险返回“证据不足/审查未完成”，不累计未通过次数。
- Record 正文覆盖自愈(v1.13.6): record_manage(update) 会校验旧 Record 正文实际覆盖轮次和索引 lastUpdatedRound；若索引声称已覆盖但正文只到更早轮次，会先修正索引并继续增量生成。单个 update 支持 force=true 绕过“已是最新”短路；v1.15.14 起可解析旧 Record 时默认保留稳定 Phase 并只回滚尾部继续合成；结构化 read 会提示正文/索引覆盖不一致。
- RecordPatch 检查点与中文格式自愈(v1.13.6): 并行生成会缓存成功的 map / compress 中间 RecordPatch，重试时复用已完成区段并隔离 timeout/failed/invalid 节点；旧 Record 的 "Rounds X-Y" 可容错读取，写入前会规范成中文“轮次 X-Y”。
- Stage Guard 外部证据索引(v1.13.7): stage_guard(check) 支持 evidenceFiles / evidenceAssets / evidenceIndexMode；图片、PDF、Word、Excel、视频等复杂证据先写入临时索引 artifact，再把短索引喂给审核模型，避免把大文件或 base64 堆进内存。
- Stage Guard 多实例与局部范围(v1.19.2): GuardKey 由 conversationId + stageId + childScopeId 组成，每次 start 生成不可变 guardId；同一 Task 可并存多个 Guard，pass/cancel/force 只影响目标实例。子任务传 childScopeId 时必须同时传 scopeSelectors，check 只审核命中的任务项；同键重复 start 默认拒绝，force=true 才精确替换；status(listAll=true) 不读取对话即可列出全部活跃 Guard。
- Codex AGENTS/RULES 注入折叠(v1.13.8): Codex 对话开始和 context compact 后的 AGENTS.md/RULES 快照按事件结构识别并折叠为短占位符；默认读取、搜索、Record、Guard 与 Golden Extract 不再把完整规则正文当成真实用户消息。
- Claude Code 对话与模型链路兼容(v1.14.0): 新增 dataChain/modelChain="claude-code" 与别名 "cc"；conversation_read_original 可读取 .claude/projects 下 JSONL，支持 list/fetch/read/search/deep_locate/contextProbe；Record/Golden Extract/Stage Guard 基于统一轮次工作，附件只懒解析元信息；Claude Code CLI 仅在显式 modelChain 或允许 fallback 时使用，并带 timeout/kill/输出预算。
- Claude Code compact summary 折叠(v1.14.1): Claude Code compact_boundary + isCompactSummary 续聊摘要会作为压缩元信息处理；conversation_read_original(read) 默认按读取轮次懒导出临时 Markdown，depth="full" 或 compactionMode="full" 可展开但保留 marker，Record/Guard/Golden Extract/contextProbe/deep_locate 默认不把它当真实用户正文。
- Windsurf 四数据链路兼容(v1.15.0): 新增 dataChain="windsurf" 与别名 "wsf"；conversation_read_original 通过 Windsurf Language Server 只读 Cascade 对话，支持 list/fetch/read/search；Record/Golden Extract/Stage Guard 可读取 WSF 对话并复用现有模型链路；不调用 WSF 模型代理、发送消息接口或 ACP summary-agent。
- Windsurf 超大 step 降级(v1.15.1): 若 WSF LS 返回单个 step 超过 4MB 限制，conversation_read_original 会插入占位轮次并继续读取后续 steps；partial 结果会明确警告，且不会自动或显式写入正式 Record。
- Windsurf 工具证据归一化(v1.15.2): WSF run command、MCP tool、find、view file、code action、list directory、command status 等 step 会进入 toolCalls/fileViews/codeActions；conversation_read_original(depth="full") 和 Stage Guard 可看到真实执行证据，避免因 WSF 工具步骤不可见误判虚标。
- Windsurf fetch/read 缓存与诊断(v1.19.0): fetch 强刷并写 last-good，read/search 优先复用 TTL+LRU；默认 5 秒 fresh window 内不访问 LS，过窗 summary 校验 stepCount。partial、LS 异常或 stepCount>0 但 0 轮时不覆盖 last-good；无旧缓存则 read 明示 LS 读取不完整。read 独享格式化/附件预算，search/export/子线程展开保持旧行为。
- conversation_read_original 防串读(v1.15.3): fetch/search/read/export 在 dataChain="auto|codex|claude-code|windsurf" 下必须显式传稳定 conversationId；只有显式 dataChain="antigravity" 保留当前窗口兼容路径。search 输出会显示实际读取的 conversationId，避免共享后端推断到其它窗口。
- conversation_read_original 持久导出(v1.15.4): action="export" 可按 full/rounds/search 范围导出 conversation.md、manifest.json、assets/，并可选生成 conversation.pdf；PDF 使用 Edge/Chrome 无头隐藏打印，不弹出有头浏览器窗口。导出不触发 Record 更新，也不改变 fetch/read/search 旧行为。
- conversation_read_original 跨源过滤(v1.15.5): list/export 支持 dataChains、workspaces、workspaceMode、exportBatch；批量导出为每条对话创建独立目录和 batch_manifest.json。dataChain=auto+conversationId 默认全源唯一匹配，Antigravity/Windsurf 离线默认作为 warning。
- Claude Code 多账号侧栏索引增强(v1.15.6): Claude Code 正文仍读取 .claude/projects JSONL；list 会额外合并 Claude 桌面 local_*.json 索引中的 accountId、organizationId、isArchived、标题和最后活跃时间，换账号导致侧栏索引隔离时仍不影响原文读取。
- Conversation App 标题与 WSF 工作区元数据增强(v1.15.7): Codex list/get/resolve 优先使用 ~/.codex/session_index.jsonl 的 thread_name 作为 App 侧栏标题，SQLite title 只作 fallback；Windsurf list/export 优先使用 renamedTitle，并解析 workspaces[].workspaceFolderAbsoluteUri 参与工作区过滤和批量导出。
- Conversation 工作区过滤范围与长标题展示治理(v1.15.8): conversation_read_original(list/export) 新增 workspaceScope="any|primary"；默认 any 匹配主工作区和关联工作区，primary 只匹配主工作区；list 展示超长标题会折叠并标记 [titleTruncated]，不影响搜索、读取和导出原始数据。
- Codex 子代理线程标注(v1.15.9): Codex 子代理线程在 list 中显示为 子代理对话(role)，detail 标出 parentConversationId；fetch/read/search 子线程时会显示源头对话 ID 与源头标题；fetch 子代理线程不触发自动 Record 更新。
- Claude Code 加密思考占位(v1.15.10): Claude Code JSONL 中 thinking 为空但 signature 存在的加密思考块，会在 read(depth="full", extraTypes=["thinking"]) 中显示“🔒 加密思考块 step N：thinking 为空，signature 存在，明文不可读”；完整 signature 不输出，也不进入 contextProbe/deep_locate/Record/Guard/Golden Extract 正文材料。
- Conversation 主子线程与消息角色过滤(v1.15.11): conversation_read_original(list/export) 支持 threadMode="main|children|all"、parentConversationId、parentQuery；默认 main 会把命中子线程的标题回指父线程候选。read 支持 messageRoles=["user","system","model","assistant","tool"]，可只读用户、系统/压缩摘要、模型回复或工具证据。Codex 标题定位使用全量 session_index 轻量索引，不再被最近 300 条正文候选限制。
- Record 最终写入质量门禁(v1.15.11): record_manage(update/batch_update/bulk_update) 与自动后台 Record 写入前会统一校验 Phase 数、覆盖轮次、长度比例和 Phase 范围；长对话或旧 Record 有 Phase 时，0 Phase 候选会被拒绝并保存到 temp，不覆盖正式 Record。
- Record 手动补充保护修正(v1.15.12): Local Compose 质量检查保留旧 [手动补充] 硬约束，但比较前会忽略历史重复列表编号，避免 9. 3. 与 1. 这类编号变化误判为丢失。
- Conversation list 多词查询修正(v1.15.13): conversation_read_original(list/export) 的标题/ID/工作区轻量定位中，空格分开的 query 词按 OR 匹配候选；完整 ID、ID 前缀和完整标题仍优先排序，正文片段仍应使用 search/deep_locate。
- Claude Code 逻辑续聊链与 Record 防缩水(v1.15.14): conversation_read_original(fetch/read/search/export, dataChain="claude-code") 支持 logicalChain="off|explain|auto|strict"；默认 off 只读指定物理 JSONL，explain 只展示同工作区前序候选，auto/strict 仅在明确引用 ID/标题、压缩摘要或首尾内容重叠等强证据成立且无“从 0 开始/不要继承”信号时合并。record_manage(update, dataChain="claude-code") 默认 logicalChain="auto"，证据不足只给 warning，不按标题语义强行合并；最终写入门禁会容忍旧 Record 已存在且完全一致的稳定区 Phase 范围重叠，但仍拒绝新生成部分新增的重叠或倒退。
- Grok/progrok 模型链路(v1.18.0): 新增 modelChain="grok" 与 chain="grok" 兼容写法；Grok 只作为模型链路，不作为 dataChain。auto 模型路由优先探测本机 progrok proxy，默认顺序为 grok → antigravity → codex → 可选 claude-code；Record 场景使用 grok-4.3 与 Antigravity M20 fallback，Stage Guard 使用 grok-4.5；输出 token 上限 default/Record/Guard 默认 800/8192/4096，可用 MEMORY_STORE_GROK_MAX_TOKENS / MEMORY_STORE_GROK_RECORD_MAX_TOKENS / MEMORY_STORE_GROK_GUARD_MAX_TOKENS 覆盖，finish_reason=length 视为截断失败。proxy 默认 http://127.0.0.1:18645，认证 key 默认 grok-local-proxy，可用 MEMORY_STORE_GROK_PROXY_URL / MEMORY_STORE_GROK_API_KEY 覆盖；工具只探测 proxy，不会自动启动 progrok。
- 后台任务生命周期(v1.19.0): background_task_status / background_task_cancel 统一查询和取消 task-backed 任务；Record、Guard check、Golden Extract、批量导出与 deep locate 传播取消并阻止幽灵写回。后端启动扫描持久任务，Record 按 checkpoint/ledger 续跑，其余类型按幂等规则恢复或明确转 error；任务默认保留 15 天。
- Broker、WSF 与 provider admission: 共享 broker 按 waitSeconds/timeout 参数动态放宽请求窗口，普通调用仍默认 120 秒，wait 上限默认 30 分钟；长任务建议 background=true + waitSeconds=30-45 短轮询。Record 普通轮格式化每 N 轮用 setImmediate 让出事件循环（MEMORY_STORE_RECORD_FORMAT_YIELD_INTERVAL 默认 5，0 禁用），让步后重查取消状态。WSF LS 使用 AIMD，max=6、min=1、initial=1，并由 MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS（默认 2）提供非抢占前台保留槽；后台空闲时可借用，前台在下一槽释放时优先，effectiveReserved 随 current limit 动态钳制。模型 provider 的统一 admission 默认 enforced：同一 provider 的 foreground 与 Record 请求共享一个物理池，必须先取得 permit，才会发 HTTP 请求或启动 CLI。
- 对话渲染边缘修复(v1.19.2): brief 空 AI step 不再输出标题；messageRoles=["tool"] 按 step/seq 稳定分组；NaN/undefined stepIndex 在 normal/full、brief、messageRoles 三条路径统一降级为无 step 的 AI 标题。
- Record 批量筛选、账本与 provider 调度(v1.19.3): batch_update/bulk_update 先分类、排序后才应用 limit；force/stale_only 矩阵为 false/false=stale+missing、true/false=stale+missing+fresh、false/true 与 true/true 均只选 stale。近期列表未命中的既有 Record 保留为 unresolved，来源链路冲突安全跳过；batch taskId 绑定 scheduler ledger，业务总计只看 ledger；provider admission 的 AIMD、breaker、owner lease 与 loss epoch 持久化到 provider control，旧进程内共享池诊断不再授予物理模型许可。
- Record scheduler 真实生产闭环(v1.21.0): 四宿主来源枚举、exact/full read 与 immutable evidence 统一进入生产 runtime；一个逻辑模型调用只物化一个 route Unit，Grok/agy/Codex 等 provider 调用作为同 Unit 的 Attempt。Availability/Congestion/LocalResource 在同 Unit retry/fallback，Quality/Complexity 才允许一次 split；有 durable resultRef 的 ResultReady 可放行后续 continuation，但只有 local-finalize 全部 verified 才能把 Task 投影为 Succeeded。
- 非阻塞接力、4+4 与重启恢复(v1.21.0): blocked provider 候选持久挂起并释放 background lane，事件/CAS 唤醒后沿同 taskId、Unit、attemptId 继续；agy first-run overflow 与 fallback 各保障 4，任一类空闲时另一类可非抢占借用，但物理合计始终最多 8。same-identity admission 使用跨进程 namespace lock，foreign owner 通过 PID/启动时间/lease fencing 接管；pending discovery 在 spool 创建前允许连续热重启，不会误报 missing_task_manifest。
- force 发布换代与可见 artifact 门禁(v1.21.0): force 仅在正文、主索引、Reader Index 全部匹配旧 publication claim 时推进 recordCommitEpoch 并保留历史；coherently absent、ownerless legacy、部分发布、混合 owner 或 unresolved 均 fail closed 为 RepairRequired。普通非 force 的同 revision/不同 body 继续冲突，repair_divergence 仍走独立修复路径。
- Record 手动修改发布围栏(v1.21.0): record_manage(edit/delete) 按 artifact→registry 锁序先推进 epoch/fencing token、清除旧 lease/claim 并持久记录 retiredTaskIds，再修改正文与索引；旧 Task 不得重新挂接或取得 lease，同 revision 的新 Task 仍可继续。索引已有 chain 时该宿主唯一权威，外宿主状态、chain 缺失后的多候选或残缺候选均 RepairRequired。
- Record 调度原始意图收尾(v1.21.1): auto 单 Unit 在 Grok permit 满载且尚未调用 provider 时，以同一 attemptId 尝试 agy first-run overflow；Grok 真失败后的 agy 仍走 fallback。Antigravity/Codex/Claude Code 的启动、连接、超时与非零退出为 Availability，成功调用空输出为 Quality。Windsurf Record ownership 预探测走 background；single-flight 与持久化 gate 的容量等待无终止性 queue timeout，只因取消或任务结算退出，旧 MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS 不再生效。
- Codex HTTP broker 共享后端进程，fetch/search/read 必须显式传稳定 conversationId；只知道标题时先用 list 定位完整 ID，可补 contextProbe 辅助确认当前主线
- Codex 如存在子代理线程，默认以引用或摘要方式呈现；link="expand_children" 时读取一级子线程全文，并用 thread_spawn_edges 补充父线程事件遗漏或已归档但仍可读的子线程；缺失子线程会输出诊断而不是静默跳过

### Auto Summary 双轨制 (v1.5+)
- memory_write 的 searchSummary 参数现在是可选的
- 写入后系统自动用 Gemini 3 Flash 生成 autoSummary（异步，不阻塞返回）
- 搜索时 autoSummary 和 searchSummary 合并匹配，大幅提升检索召回率
- memory_update 修改 content/append 时自动重新生成 autoSummary
- memory_stats(action="enhance"): 批量为所有缺少 autoSummary 的老记忆生成
- 需要 LS 可用（IDE 运行中），LS 不可用时静默跳过

### conversation_golden_extract — 黄金片段提取 (v1.5+)
- 从对话中提取关键决策、发现、踩坑经验
- 自动与现有记忆对比去重：标注已有/疑似重复/全新
- 参数: conversationId（Antigravity 当前对话可选，Codex 链路必填）、stepStart/stepEnd（范围）、autoCompare（默认true）
- 帮助发现对话中值得持久化但尚未保存的知识
- 受宿主链路影响时，默认建议 "chain=\"auto\""；需要跨宿主显式取数时再指定链路
- 支持 dataChain/modelChain 拆分：dataChain 读取对话，modelChain 调模型提取；未填时保持旧 chain 行为；Windsurf 只允许作为 dataChain

## 进程生命周期 (v1.7+)

MCP 进程与父 LS 绑定（ppid），与窗口同生共死：
- **ppid 连续 3 次容错**：单次 ppid 检测失败不退出，切 5s 快速检测确认
- **stdin 断裂诊断**：记录退出时 ppid 状态，区分 LS 抖动 vs LS 真死
- **非 LS 环境兜底**：检测父进程是否为 Antigravity LS，非 LS 启用 1h 空闲超时
- **诊断日志**：%TEMP%\\mcp-memory-stdin-log.txt

### record_manage — 对话记录管理 (v1.8+ / Reader v1.12+)
- Record 是对话过程日志，Flash 自动生成，永久存于 records/，抗 LS 过期
- action: update/list/read/search/guide/edit/delete/batch_update/bulk_update/batch_delete/task_status/cancel/recover/audit_ownership/repair_ownership/migrate_unknown_chain/stale_check
- 自动触发: Antigravity LS 环境下所有工具调用自动节流检查（60s 间隔），轮次增量≥3 后台更新；同一对话同一工作区已有 pending 时跳过重复触发
- Codex wrapper 环境默认关闭后台自动 Record，避免普通查询隐式拉起模型桥；需要时可设 MEMORY_STORE_CODEX_AUTO_RECORD=1 显式开启
- 显式更新: record_manage update / batch_update / bulk_update 会跳过入口自动检查，避免手动更新与后台自动更新重复生成
- 工作区落点: 自动更新优先使用当前宿主/线程检测到的工作区，避免历史异常 Record hash 污染新写入
- 模型重试: Antigravity LS 链路首次失败自动等 5s 重试 1 次；Codex 链路只对输出为空/启动失败等快失败重试 1 次，完整超时不重试，避免拖穿宿主 MCP 超时
- 分批处理超长对话：按实际轮次大小切批，避免高密工具轮次被平均值低估
- 实验并行管线: record_manage(update, parallelMode="auto|force") 使用 RecordPatch map/reduce；默认 off
- force=true: 单个 update 时强制绕过“已是最新”短路；v1.15.14 起可解析旧 Record 时默认保留稳定 Phase、回滚尾部并继续 Local Compose，避免长 Record 被全量重建压缩缩水；确需旧式全量重建可设置 MEMORY_STORE_RECORD_FORCE_FULL_REBUILD=1
- v1.12.5 单批增量止血: parallelMode="auto" 在旧 Record 已较大时，新增只切出单 chunk 也进入 local compose；Record 头部的对话ID/工作区/总轮次/总步骤由代码校正，模型只补状态、关联工作区、阶段和尾部内容
- 结构化读取: record_manage(read, view="outline|state|outputs|lessons|risks|verification|phase|custom", phaseIds, sectionTypes, include/exclude, maxChars, format, withCitations, indexMode, startBlockId)
- Reader v1.13.3: tail 区按标题层级成块；state/lessons/risks/verification 默认最新优先；截断时返回可续读 nextReadHint.startBlockId
- 结构化搜索: record_manage(search, conversationId/recordIds, phaseIds, sectionTypes, searchScope="record|phase|section|item") 返回 block 级 provenance 与 readHint；未传结构化参数时旧整篇 Record 搜索不变
- 导读建议: record_manage(guide, goal, conversationId/recordIds) 只返回推荐 read/search 参数与来源位置，不生成事实摘要，不写回正式 Record
- 批量更新: record_manage(batch_update 或 bulk_update, dataChain, workspace, after/before, limit, force, stale_only) 先返回 taskId，再在 batch 专用后台 lane 内按 conversationId 去重、分类、排序并冻结候选；limit 只在筛选后生效，未传时非 force 默认 10 / force 默认 200，显式值分别钳制到最大 50 / 200。force/stale_only 矩阵为 false/false=stale+missing、true/false=stale+missing+fresh、false/true 与 true/true 均只更新 stale；bulk_update 是安全别名，避开共享 broker 对 batch_update 名称的全局拦截
- 过期检查(v1.17.3 / 批量筛选 v1.19.3): record_manage(stale_check, scope, dataChain, limit) 检测范围内哪些 Record 已过期（对话有新内容但 Record 未跟进）；近期有限列表未命中的 Record 标为 unresolved，仅统计、不更新、不删除，不能误称确定丢失。批量候选的来源链路若与既有 Record 冲突同样安全跳过；Windsurf 源用 stepCount 对比排除 rename-only 误报；RecordIndexEntry 的 chain 字段记录对话来源
- 读侧归属治理: list/search 的 scope="workspace" 严格只读指定 workspace；includeGeneral=true 才显式兼容旧的 workspace + general 合并读法
- general 审计: audit_ownership 只读检测 duplicate/migratable/conflict/unknown；repair_ownership 默认 dryRun=true，首版只 copy/upsert，不删除来源副本
- unknown 链迁移: record_manage(migrate_unknown_chain, scope, apply=false) 默认只读扫描 Codex、Claude Code、Windsurf、Antigravity 的权威 enumeration/exact-fetch/full-read 证据。仅一个宿主完整匹配且其余宿主可证明不存在时才提出 Patch；apply=true 才按 index revision/hash CAS 写入 chain。任一证据不完整或多宿主命中均保持 Unresolved/Conflict，不改索引，也不作为 batch_update 前置步骤
- official home 止血: C:\\ 与 \\\\?\\C:\\ 等路径别名会归一；repair/update 会把旧 alias/general 副本 copy/upsert 到 official workspace，并用 ownership sidecar 标记 superseded，默认 list/search 不展示已取代副本
- 降级: LS 不可用时自动从 Record 读取
- 四数据链路约定: "chain=\"auto\"" 时优先当前宿主；dataChain/modelChain 未填时沿用 chain；显式指定链路时不静默回退；chain="windsurf" 只代表 dataChain，modelChain 回落 auto；chain="grok"/"agy" 只代表 modelChain，dataChain 回落 auto
- 支持 dataChain/modelChain 拆分：dataChain 读取对话，modelChain 生成 Record；可读取 Codex/Claude Code/Windsurf 对话并用 Grok/progrok、agy CLI、Antigravity LS、Codex 或 Claude Code 模型生成。agy 不能填入 dataChain
- Codex 链路下，Record 读取的对话原文来自本地线程索引与事件流，子代理内容默认以摘要或引用纳入；Claude Code 链路来自 .claude/projects JSONL
- Codex/Claude Code 侧 update 必须显式传 conversationId；未传 background 时默认创建持久 scheduler Task 并返回 taskId，单更新与 batch 分别进入至少 8 槽的专用 materialization lane；lane 只编排任务，不拥有模型 permit。后续用 action="task_status" + taskId + waitSeconds=30-45 轮询
- Grok Record 使用 grok-4.3，默认 prompt 上限 200000、输出上限 8192 tokens、超时 120000ms，可用 MEMORY_STORE_GROK_RECORD_MAX_PROMPT_CHARS / MEMORY_STORE_GROK_RECORD_MAX_TOKENS / MEMORY_STORE_GROK_RECORD_TIMEOUT 覆盖；agy Record 默认 prompt 上限 24000、总超时 5 分钟，可用 MEMORY_STORE_AGY_RECORD_MAX_PROMPT_CHARS / MEMORY_STORE_AGY_RECORD_TIMEOUT 覆盖，三模型内部 fallback 共用同一预算；Codex/Claude Code 本地模型桥 Record 会按较小 prompt 批次生成，Codex 后台单批默认允许 8 分钟，可用 MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT 覆盖；Claude Code 可用 MEMORY_STORE_CC_RECORD_BACKGROUND_TIMEOUT_MS 覆盖
- task_status 会展示后台任务阶段、x/y 轮进度、当前批次/轮次和预计剩余时间，便于判断任务是否正常推进；cancel + taskId 是 Record 兼容入口
- recover 不传 taskId 时只读列出可恢复的 Record 后台任务；传 taskId 时执行安全恢复。单条 Record update 沿用原 taskId 和已有 RecordPatch checkpoint；批量 taskId 绑定 resumeKey，ledger 未冻结前按原 request 重扫，冻结后只续跑快照。v2 ledger 会保留 inFlight 的正文哈希、归因和索引元数据，恢复按正文、主索引、Reader Index 的顺序补齐，全部完成后才转 completed；旧 v1 ledger 会在下一次锁内 mutation 规范化回写
- scheduler-backed Record 更新会冻结来源并物化 Task → Record → Unit → Attempt；Record work registry 按 canonical conversation + desiredRevision 去重，global coordinator 持久化公平顺序、claim phase 与 owner fencing。生产执行设置 schedulerManagedExecution，不再经过 legacy process-wide generation gate。
- 单更新与 batch materialization lane 分别由 MEMORY_STORE_RECORD_UPDATE_BACKGROUND_CONCURRENCY / MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY 配置，但有效值不得低于 provider physical max=8；scheduler Task 的 background maxRunMs=0，长时间排队、time_frozen 或重启恢复不会被旧总墙钟误判失败。模型 active 只由统一 provider admission 决定。

### background_task_status / background_task_cancel — 统一后台任务生命周期入口 (v1.19+)
- background_task_status(taskId, waitSeconds?) 可查询任意 task-backed 后台任务，返回统一进度/结果格式
- background_task_cancel(taskId, reason?) 可取消任意 task-backed 后台任务；同 DATA_ROOT 的另一进程会通过持久化 task 状态感知取消
- stage_guard(action="cancel") 仍表示取消当前 Guard 并按 guardId 精确移除对应锁块，不能用来取消后台 check task；后台 check 使用 background_task_cancel
- conversation_read_original(action="deep_locate_cancel") 和 record_manage(action="cancel") 作为兼容别名继续保留
- autoSummary 仍是 fire-and-forget，不属于 task-backed 后台任务；写回前使用内容指纹防止旧摘要覆盖新内容
- MCP 后端启动后会异步扫描 tasks/：带 schedulerAdmission 的 Record 只按 scheduler ledger 与 owner lease 恢复，缺少 admission 的 legacy Record 保留原 taskId/resumePayload 并转 error，不再调用旧 handler 重跑；Golden Extract、Stage Guard check、conversation batch export 按各自幂等规则恢复；deep_locate 明确转 error，不自动重跑
- 恢复元数据只持久化白名单 JSON 参数并校验 resumeVersion/resumeHash；任务文件默认保留 15 天，旁置同名 .preserve 可阻止自动清理
- Codex HTTP broker 对普通调用保持默认 120 秒；参数含 waitSeconds>0 时使用 waitSeconds*1000+15 秒余量，参数 timeout 大于普通上限时使用 timeout+15 秒余量，两者均受 CODEX_MCP_BROKER_WAIT_TIMEOUT_MS（默认 30 分钟）约束
- WSF 缓存默认 TTL 30 分钟、LRU 10 条、5 秒 revalidation window；MEMORY_STORE_WINDSURF_CACHE_TTL_MS / MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES / MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS 可调。fresh hit 不占 LS 位，过窗 summary 与刷新才进入 MEMORY_STORE_WINDSURF_LS_CONCURRENCY AIMD 门控（默认 max=6、min=1、initial=1）；MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS 默认 2，诊断包含 configured/effective reserved、前后台 active/pending 与 borrowing；partial/坏 0 轮不覆盖 last-good。
- 模型 provider 只使用统一 admission，而不再使用旧 Grok 的 global/batch gate。每个 provider 的 foreground 与 Record 共享物理池，排队始终受本次调用的总 deadline 和取消信号控制，不再单设 Grok queue timeout/retry；因此排队中的请求若被取消或 deadline 到期，不会启动真实 HTTP/CLI 调用。provider control 首次安装只能以 exclusive-install 独占初始化；控制文件、初始化标记或 install manifest 损坏或不一致时会进入 dispatchBlocked，停止模型派发，必须修复后才恢复。旧 MEMORY_STORE_GROK_QUEUE_*、MEMORY_STORE_GROK_CALL_CONCURRENCY 与 MEMORY_STORE_GROK_BATCH_CONCURRENCY 不再提供物理并发或排队控制，不能据此调节 admission。

### stage_guard — 任务完整性验证 (v1.9+ / 分段取证 v1.13.4+ / 外部证据 v1.13.7+)
- ⚠️ 当项目有 Plan_x 和 Task.md 时，每个 Stage 开始前必须 start，完成后必须 check 通过才能标记完成
- 四层防御网防止 CHECKPOINT 压缩导致任务遗漏
- action: start(注册守卫) / check(Flash比对验证) / status(查看状态) / cancel(取消)
- start 时传入 taskFiles + planFiles + stageId，自动获取当前轮次；同一 GuardKey 已活跃时默认拒绝，只有 force=true 才会先精确清理旧锁再替换
- GuardKey = conversationId + stageId + childScopeId（默认 main）；guardId 标识某一次不可变实例，旧后台 check 返回时会先比对 guardId，过期结果不得写历史、移锁或清理新 Guard
- 子任务 Guard 传 childScopeId 时必须同时传 scopeSelectors（Task 编号、小标题或稳定锚点）；scopeSelectors 才定义审核内容，childScopeId/job_id 只负责区分实例
- check/status/cancel 在选择器不完整且存在多个候选时会返回候选列表，拒绝静默选取；status(listAll=true) 直接扫描状态目录，不读取任何对话
- start 时可手动设 startRound 为更早轮次以覆盖已完成的工作
- check 时审核模型独立比对 Plan/Task vs 执行记录；v1.13.4 起输入由分段取证器构建，不再整篇读取超长 Plan/Task/Record
- Plan/Task 取证优先保留当前 Stage section、头部规则、尾部、小本本、标题邻近块和命令/报告/文件路径证据窗口
- Record 取证优先使用 Reader 局部视图（state/outputs/verification/risks）和少量锚点窗口；对话原文会展开工具结果、代码编辑、diff 和文件视图，但仍受总预算控制
- check 报告会保存 extraction manifest 与 evidence manifest，说明读取了哪些行、哪些区间没读、命中了哪些命令/报告/run/obs/文件证据
- coverage 不足、锚点缺失或截断风险时，工具返回证据不足/审查未完成，不累计未通过次数，也不触发三次失败裁定
- check 时可传 evidence 补录证据（如 Guard start 之前完成的修改）
- check 时可传 evidenceFiles 或 evidenceAssets 追加外部证据文件；evidenceAssets 支持 path、label、type、role、range、maxChars，适合报告、截图、PDF、Word、Excel、视频和原始日志
- evidenceIndexMode: auto(默认，复用缓存或按需重建) / reuse(只用已有索引) / rebuild(强制重建) / off(只登记文件元数据，不读取内容)
- 外部证据索引写入 temp/stage-guard-evidence-indexes，artifact 内有 <<<GUARD_EVIDENCE_INDEX>>> 标记；Guard prompt 只注入短索引和 artifactPath，不直接塞入大文件、图片 base64 或完整 PDF/Word 内容
- 图片默认只登记尺寸和元数据；需要真正理解图片内容时可开启 CLI 索引或改用支持视觉的模型链路，Guard 会显式提示“未读取图片视觉内容”
- 核心原则：执行记录是 ground truth，Task.md 标记不可信，防止 AI 虚标
- 按 GuardKey 隔离：同一对话、同一 Stage 的不同 childScope 可以并存，不会互相覆盖
- 同一 Task.md 支持多个 Guard 独立锁块；pass/cancel/force 按 guardId 精确处理，保留其它活跃 Guard 锁
- Guard 对话数据固定绑定当前宿主的明确 conversationId，不跨宿主操作异源 Guard
- "modelChain=\"auto|antigravity|codex|claude-code|cc|grok|agy\"" 只控制审核模型；旧 chain 参数继续作为 modelChain 兼容别名；显式 grok 使用 progrok proxy，显式 agy 使用本地三模型 fallback，显式 claude-code 使用 Claude Code CLI，普通 auto 不默认消耗 CC 额度
- Codex 链路下，审核上下文来自本地线程索引与事件流重建结果，子代理线程默认作为引用或摘要处理
- Codex HTTP broker 下，start/status/check/cancel 必须显式传 conversationId；check 默认同步作为门禁特例，只有显式 background=true 才进入后台任务；后台检查后用 taskId + waitSeconds=30-45 轮询
- 后台任务使用独立 FIFO 队列，默认 lane 并发 2（MEMORY_STORE_BACKGROUND_MAX_CONCURRENCY / MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY 可调），并带 deadline 与 timedOut 状态。Record update 与 batch update 各有独立的有界 materialization/任务执行 lane，可用 MEMORY_STORE_RECORD_UPDATE_BACKGROUND_CONCURRENCY / MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY 调高，但有效并发不会低于 provider 物理上限 8；这两个 lane 不是模型许可，真实模型 active 仍只由 provider adapter/pump 控制。Record update/batch update 默认 60 分钟，conversation batch export 默认 30 分钟，Guard/Golden Extract 默认 15 分钟；超时只标记任务 error，不重启 MCP 后端

## 三级搜索引擎 (v1.10+)
- Record search / conversation list+search / memory_query / memory_batch(query) 均已升级
- exact: 多词分词 AND 匹配（precise grep）
- fuzzy: Fuse.js 模糊匹配（“大概记得”场景）
- smart: Flash 语义搜索（自然语言问题）
- auto: exact → fuzzy fallback（默认）
- Record search 已去掉 ~ 前缀 hack，默认走 auto 模式

## Record 自动触发可靠性 (v1.10+)
- MCP 退出时等待所有 pending Record 生成完成（90s 超时保底）
- 自动触发阈值从 5 轮降至 3 轮
- 自动更新使用 per workspace + conversation 去重，避免重复模型桥进程
- Codex wrapper 环境默认只响应显式 record_manage update / batch_update / bulk_update，不在普通工具调用入口后台生成 Record
- 显式 Record 更新不会同时触发后台自动更新
- 当前宿主检测到的 workspace hash 优先级高于历史 Record 所在 hash`;
