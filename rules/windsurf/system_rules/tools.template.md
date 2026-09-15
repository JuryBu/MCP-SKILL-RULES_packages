## 搜索和工具使用

聊天时对你可能比较模糊的名词、现象或事件要积极搜索，知识库有时间差，不能想当然。

搜索优先级（公开互联网）：Exa MCP 首选（`web_search_exa` 语义搜索，用自然语言描述理想页面而非堆关键词）→ 已知 URL 用 `web_fetch_exa`（`urls` 是数组，多链接一次批量读）→ Exa 不可用或结果不足时用宿主原生网页搜索/抓取（旧 Cascade：search_web / read_url_content；Devin Local：web_search / webfetch，遇重定向立即跟随）→ 需要登录态、Cookie、等待元素（`waitFor`）或懒加载滚动（`scrollCount`）时用 web-fetcher `web_fetch_page`；截图/交互/下载转换也归 web-fetcher。MCP 工具用前先 list tools 认准实际名称与参数

工具通用规范：
- 代码搜索：精确字面/文件名/小范围用宿主原生搜索（Devin Local 的 `grep` / `find_file_by_name` / `code_search`）；语义、模糊、大目录批量用 sandbox smart_search（exact/fuzzy/smart三模式）；不要用命令行 rg/grep/find 代替
- 调用失败可重试；执行时监测输出别干等；卡住换方法
- docx/pptx/xlsx/pdf 任务先读对应 skill 的 SKILL.md 再动手
- 产出文件必须做视觉核验，不能只看代码觉得对就交付；工具按场景分：本地 HTML / Web 应用 → `browser_preview`（先起服务再预览，URL 只带协议+域名+端口）；自动化点击/填表/读控制台/回归 → Playwright MCP（若已安装）；Word/PPT/Excel/PDF 或任何 `file://` 页面 → web-fetcher `web_fetch_screenshot`；截图结果必须实际查看
  · Office 直接 file:// 截不用转PDF；别并发截（LibreOffice抢目录EPERM）；首次渲染慢~45s注意超时
- 同一问题连续失败 3 次→必须换方法或告诉用户，不能反复用同一方法碰墙
- 多模型交叉验证、红蓝对抗审题用 sandbox_council
- 复杂推理/数学证明/多方案对比用 sequential-thinking MCP

## MCP sandbox

- Sandbox 用 `memoryRequestMB` 表示预计调度占用，用 `maxMemoryMB` 表示整棵进程树硬上限；短命令可在 Windows 提交余量安全时继续并行，队首大任务放不下也不会堵住后续小任务。默认 4096MB 提交余量是重任务目标线，不是所有任务的绝对红线；目标线与 1536MB 紧急底线之间只放行不超过 192MB、且接纳后仍守住紧急底线的小请求。`admission_timeout` 表示命令尚未启动，按随机 `retryAfterMs` 最多重试一次；再次失败就拆小、降低请求量、改后台或明确反馈排队超时，不能把同一重命令绕到原生命令
- `maxMemoryMB` 的允许上限由服务端配置并在 `sandbox_status` 的「工具内存配置」中展示；参数越界或 `working_directory_missing`、`windows_job_runner_missing` 等启动前错误不等于 Sandbox 不可用，`commandStarted=false` 时修正参数或路径，禁止改用原生命令绕过保护。大目录 exact 搜索在全局 `maxResults` 到达后停止；fuzzy/smart 优先后台，取消时用同一 `taskId` 加 `cancel=true`
- Sandbox 1.18 起默认按实时物理/提交水位接纳，预估总额1536MB和总观测2048MB不再单独否决，显式24MB请求按24MB记账。估计仅覆盖未开始任务、默认1秒启动窗口及尚未被后续系统采样覆盖的观测增长，不能长期重复扣除已被系统余量计入的任务。黄色水位仍允许安全小请求，512MB物理/1536MB提交紧急底线、Windows低内存信号、完整样本有效期与单进程树硬保护保留；`fixed`仅供管理员明确选择旧额度模式。错误正文与`admissionDecision.blockedBy`均须说明实际阻断、有效请求和水位，0ms退避不表示立即重试，不用并发重发绕过保护。

- `memoryRequestMB` 的工具合法范围为16～`maxMemoryMB`，默认推导的64MB下限不适用于显式24MB；普通工具省略时按硬上限约四分之一推导且不超过硬上限，Codex有单独默认请求配置。不要为了等待而盲目低报，只在拆小实际任务或有证据证明原估计过高时修正。`admission_timeout` 只证明尚未启动，先按 `admissionDecision.blockedBy` 区分水位、采样、恢复或显式fixed额度；Session会话数/合计额度和batch局部并发预算仍独立存在，不等于整机缺内存。工具说明更新须验证真实 `tools/list` 和 `sandbox://guide`，当前会话缓存不一定即时刷新，不为此重启整个宿主。
- Windows 完整压力样本缺失/过期，或后台任务资源记账尚未恢复时，新执行请求会继续排队或返回未启动的接纳超时；查询与取消仍可用，应等待状态恢复而不是绕过 Sandbox。
- 排队超过约 1 秒后 Sandbox 会尝试定期发送等待位置和内存压力，但宿主界面未必展示 MCP progress；以最终结构化结果为准，不因没有中途提示就并发重发
- `execution_timeout` 表示命令已经启动后运行超时；`caller_deadline_exceeded` 表示排队与执行合计超过调用方总期限；`broker_backend_timeout` 表示 broker 与 Sandbox backend 通信超时。这三类可能已经开始执行，重试前先检查状态和副作用
- 大输出在安全预算内直接完整返回，超预算时返回头尾预览和 artifact 的路径、SHA256、字节数、行数及过期时间；读取 artifact 才是完整结果。`maxOutput` 按正文字符计算，元数据预留另计；`maxLines` 超预算仍保留全文 artifact，批量任务共享单次响应总预算
- 这些是 Sandbox 内部状态，不覆盖宿主自己的外层 MCP 期限。耗时任务使用对应工具的后台模式或 sandbox_launch，状态查询沿用本模板的 30～45 秒短轮询

## MCP 跨链路访问

共享 MCP 支持跨宿主，参数拆为 dataChain（对话数据来源：auto|antigravity|codex|claude-code|cc|windsurf|wsf|dsh|deepseek-harness）与 modelChain（smart 搜索/摘要调用的模型：auto|antigravity|codex|claude-code|cc|grok|agy，其中 grok / agy 仅在接收方安装了对应本地代理或 CLI 时可用）；旧参数 chain 仍兼容，按取值自动归入其一。
dataChain=windsurf 读 WSF 对话——memory-store ≥1.25 起旧 Windsurf Cascade（.pb）与 Devin Desktop / Devin Local 会话（`sessions.db` + `acp-messages`）内部自动路由，UUID 与 Devin 文字会话 ID 皆可；Devin 会话 source 用 auto/local/cache，`ls` 仅旧 Cascade。dataChain=dsh 只读 DeepSeek Harness session；modelChain 不支持 windsurf 或 dsh。速度：antigravity(~18s)>codex(~30s)。后台轮询 30-45s。

## MCP web-fetcher

网页截图/文本/交互/表格/链接提取、file://查看Office/PDF/图片/视频、格式转换(web_convert)、桌面应用调试(desktop_*)。需要登录态的网站由接收方在自己的设备上独立登录，模板不携带任何 Cookie 或账号状态。

### 图文交付与人工登录（web-fetcher 7.1+）

- 截图及检查附图默认返回原生 MCP 图片＋文本；需要旧临时路径时显式传 `saveMode="file"`，不要把再次打开路径作为默认查看步骤。
- 多图按页码、分片或标签顺序查看，检查报告的 `screenshotRef` 对应随附图片；数量、尺寸与总量限制以实时工具说明为准，超限应缩小范围或显式选择 file，不能把部分结果当成完整成功。
- `web_login_browser` 与自动弹出的人工验证窗口最多提供 600 秒人工操作；登录建议 `background=true` 后持同一 `taskId` 以 `waitSeconds=30–45` 短轮询，避免宿主同步调用期限截断，不将十分钟人工窗口等同于单次 MCP 调用期限。
- Cookie／localStorage 已写入不等于网站认证成功，纯 localStorage 登录也可能有 0 Cookie；应检查保存警告并实际访问目标页面验证，不能仅凭数量让用户重复登录。
- 自动化测试在能力允许时优先无界面，仅确需人工处理时打开可见窗口；结束后只清理本任务拥有的会话、窗口和进程，不关闭借用的用户浏览器，不清理共享 Cookie、localStorage 或 profile。
