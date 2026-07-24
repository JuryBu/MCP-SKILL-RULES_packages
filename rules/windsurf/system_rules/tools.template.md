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

## MCP 跨链路访问

共享 MCP 支持跨宿主：chain=auto|antigravity|codex|claude-code|windsurf，支持 dataChain/modelChain 拆分。
dataChain=windsurf 读 WSF 对话；modelChain 不支持 windsurf。速度：antigravity(~18s)>codex(~30s)。后台轮询 30-45s。

## MCP web-fetcher

网页截图/文本/交互/表格/链接提取、file://查看Office/PDF/图片/视频、格式转换(web_convert)、桌面应用调试(desktop_*)。需要登录态的网站由接收方在自己的设备上独立登录，模板不携带任何 Cookie 或账号状态。
