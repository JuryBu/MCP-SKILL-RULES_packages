## 搜索和工具使用

聊天时对你可能比较模糊的名词、现象或事件要积极搜索，知识库有时间差，不能想当然。

搜索优先级：Exa MCP 首选（语义搜索，描述理想页面而非堆关键词）→ search_web 备用 → read_url_content 已知URL → web-fetcher（截图/登录态/交互/下载转换）

工具通用规范：
- 代码搜索用 smart_search（exact/fuzzy/smart三模式），禁用 grep_search
- 调用失败可重试；执行时监测输出别干等；卡住换方法
- docx/pptx/xlsx/pdf 任务先读对应 skill 的 SKILL.md 再动手
- 产出文件（Word/PPT/HTML/PDF等）必须用 web-fetcher 截图做视觉检查，不能只看代码觉得对就交付
  · Office 直接 file:// 截不用转PDF；别并发截（LibreOffice抢目录EPERM）；首次渲染慢~45s注意超时
- 多模型交叉验证、红蓝对抗审题用 sandbox_council
- 复杂推理/数学证明/多方案对比用 sequential-thinking MCP

## MCP sandbox

- Sandbox 自身预留额度和系统可用内存都足够时立即并行；只有接近任一内存底线时才等待。`admission_timeout` 表示命令尚未启动，按返回的 `queueWaitMs`、`memoryPressure` 和随机 `retryAfterMs` 退避后再重试，不要立即并发重发
- `execution_timeout` 表示命令已经启动后运行超时；`caller_deadline_exceeded` 表示排队与执行合计超过调用方总期限；`broker_backend_timeout` 表示 broker 与 Sandbox backend 通信超时。这三类可能已经开始执行，重试前先检查状态和副作用
- 大输出在安全预算内直接完整返回，超预算时返回头尾预览和 artifact 的路径、SHA256、字节数、行数及过期时间；读取 artifact 才是完整结果
- 这些是 Sandbox 内部状态，不覆盖 Windsurf 自己的外层 MCP 期限。耗时任务使用对应工具的后台模式或 sandbox_launch，状态查询沿用本模板的 30～45 秒短轮询

## MCP 跨链路访问

共享 MCP 支持跨宿主：chain=auto|antigravity|codex|claude-code|windsurf，支持 dataChain/modelChain 拆分。
dataChain=windsurf 读 WSF 对话；modelChain 不支持 windsurf。速度：antigravity(~18s)>codex(~30s)。后台轮询 30-45s。

## MCP web-fetcher

网页截图/文本/交互/表格/链接提取、file://查看Office/PDF/图片/视频、格式转换(web_convert)、桌面应用调试(desktop_*)。需要登录态的网站由接收方在自己的设备上独立登录，模板不携带任何 Cookie 或账号状态。
