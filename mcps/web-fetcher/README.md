# MCP Web Fetcher

使用带 Cookie 的浏览器抓取网页内容的 MCP Server。解决 AI 助手无法访问需要登录才能查看的网站内容问题。

## 工作原理

通过 Playwright 维护浏览器 profile 基础目录（`mcp-web-fetcher-profiles`），每个 MCP 进程按 PID 使用独立 profile，共享 Cookie / localStorage 备份文件。MCP 工具调用时使用当前实例的无头浏览器访问页面，从而绕过登录墙并避免多实例锁冲突。

访问 `localhost`、`127.0.0.1` 或 `[::1]` 这类本地开发服务器时，浏览器会自动禁用磁盘缓存并附加 `Cache-Control: no-cache/no-store` 请求头，用于避免 Vite、Webpack 等开发服务器在同一持久 profile 下复用陈旧模块响应；该策略只清理浏览器 HTTP cache，不清理 Cookie / localStorage，也不会应用到远程站点。

## 工具列表

### 图片返回方式（7.1）

截图默认直接返回 MCP `image` 内容块和文本说明，客户端不必再次打开临时路径。同一结果可包含多张有序图片，适用于 `web_fetch_screenshot`（含多页）、`web_fetch_rich`、`web_interact`/`web_pipeline` 的 screenshot/snapshot、`desktop_screenshot`，以及 `web_inspect`/`desktop_inspect` 已生成的检查附图。

- 省略 `saveMode` 或设置 `saveMode="inline"`：直接返回图片＋文本。检查报告中的 `screenshotRef` 对应后续图片标签。
- 显式设置 `saveMode="file"`：保留原临时图片路径、路径清单和报告字段，不返回 image 块；依赖旧路径格式的自动化调用应明确传此参数。
- 多页示例：`web_fetch_screenshot(url="file:///path/slides.pptx", pages="1-6")`；超过范围请分批设置 pages，而不是反复请求全部页。
- 每次 inline 响应最多 10 张图片（含大图分片），图片 base64 总长不超过 12 MiB；超过限制明确报错，不静默漏图或自动切为地址。Pipeline/检查报告可能保留已交付部分，并明确标识未交付内容。
- 大图默认按行、列切片，单片各维最多 7800 像素。`web_fetch_screenshot(autoSplit=false)` 保留原始尺寸，宿主可能拒绝超大图片，建议仅文件模式使用。

此行为使用标准 MCP content 数组，四宿主接入方式和模型链路不变；具体界面能否显示、一次能显示多少图片仍取决于宿主。`web_inspect` 后台查询也可传 `saveMode`；只改变结果交付，不重新运行模型。

测试：`npm run test:images` 为图像与返回协议的针对性测试；`npm run test:images:http` 使用独立 Edge profile 和临时本地 HTTP MCP 服务验证真实截图、交互、多页与旧模式，不读取真实登录态。后者需要本机 Edge。

| 工具名 | 功能 |
|--------|------|
| `web_fetch_page` | 抓取网页/本地文档正文，返回 Markdown（支持 EPUB 与 ai_summary 智能摘要模式） |
| `web_fetch_html` | 获取原始 HTML |
| `web_fetch_screenshot` | 网页截图（5级质量控制） |
| `web_fetch_rich` | 截图+文本一次获取（支持 ai_summary 模式和 `modelChain` 参数，兼容 `chain`） |
| `web_extract_links` | 提取页面链接 |
| `web_extract_tables` | 提取 HTML 表格 |
| `web_interact` | 页面交互（点击/输入/滚动/搜索/键盘/JS执行/组合快照） |
| `web_pipeline` | 多步操作流水线，可新建 URL 或复用已有 session |
| `web_list_sessions` | 列出保留的网页/Electron renderer 会话 |
| `web_close_sessions` | 关闭单个会话或清理指定 owner 的全部会话 |
| `web_download` | 文件下载 |
| `web_convert` | 格式转换（Office→PDF/HTML/TXT） |
| `web_batch_screenshot` | 批量截图 |
| `web_record_video` | 视频录制/关键帧提取 |
| `web_inspect` | 检查网页/PDF/PPTX/EPUB 的结构、重叠、溢出、可读性、一致性和 AI 视觉审查 |
| `web_list_cookies` | 列出 Cookie 概要 |
| `web_login_browser` | 打开有头浏览器登录 |
| `web_human_browser_open` | 打开可见 Chrome，供用户手动处理验证/登录/弹窗 |
| `web_human_browser_attach` | 附着已有 CDP 浏览器为 human session |
| `web_human_browser_status` / `web_human_browser_list_pages` | 查询 human session 页面、Cookie 数量和 challenge 状态 |
| `web_human_browser_register_page` | 将 human browser 页面注册为 `web_interact` 可复用的 session |
| `web_human_browser_detach` / `web_human_browser_close` | 断开或关闭 human session |
| `desktop_launch` | 启动 Electron 或普通 Windows exe，创建桌面会话 |
| `desktop_connect_cdp` | 连接已开启 CDP 端口的 Electron/Chromium/CEF 应用 |
| `desktop_list_windows` | 列出桌面会话中的 renderer/CDP/native 窗口 |
| `desktop_register_window` | 将 renderer/CDP 窗口注册为 `web_interact` 可复用的 session |
| `desktop_inspect` | 提取 renderer DOM/CDP Accessibility/Windows UIA/视觉 fallback 结构 |
| `desktop_screenshot` | 截取 renderer/CDP 页面或 native 窗口截图 |
| `desktop_interact` | 对 renderer/CDP/native 窗口执行点击、输入、快捷键、等待等操作 |
| `desktop_close` | 关闭桌面会话并清理资源 |

## Local Document / Ebook 支持

Plan 8 新增本地文档格式路由，`file://` 会在进入 Chromium 前先判断文件类型，避免 EPUB 这类非网页格式被浏览器当成下载处理。

- `web_fetch_page(file://...epub)`：解析 EPUB 的 metadata、目录和 spine 章节，返回 Markdown 正文；支持中文路径和中文内容。
- `web_inspect(file://...epub, mode="structure")`：返回 `route="ebook"` 的静态结构，包含 metadata、TOC、章节列表、资源统计和截断/警告信息。
- `web_fetch_screenshot(file://...epub)`：当前阶段明确返回 `ERR_UNSUPPORTED_SCREENSHOT_ROUTE`，不伪装成网页截图；后续 HTML preview renderer 会作为独立扩展。
- 低风险文本扩展名 `.rst`、`.adoc`、`.org`、`.srt`、`.vtt` 已纳入直接文本读取路径。

Office / PPTX 截图链路：

- `web_fetch_screenshot(file://...pptx, page=1)` 与 `web_fetch_screenshot(file://...pptx, pages="1-6")` 都会先将 Office 文档转换为 PDF，再走同一套 PDF 渲染与截图路径。
- LibreOffice 在部分字体、模板或首次启动场景下可能返回 warning / 非零退出码，但仍生成了可用 PDF。转换器会先检查输出 PDF 是否存在且文件头有效，确认可用时按 warning 继续，不把这类情况误报为截图失败。
- 如果首次转换没有产出可用 PDF，会自动使用隔离 LibreOffice profile 重试一次，降低 profile 锁、首次启动状态和用户配置污染造成的偶发失败。
- `WEB_FETCHER_LIBREOFFICE_PATH` 可用于显式指定 LibreOffice / 测试转换器路径；未设置时仍按系统默认路径与 `where soffice` 自动检测。

安全边界：

- EPUB 会校验 ZIP magic bytes、根目录 `mimetype=application/epub+zip`、`META-INF/container.xml` 和 OPF spine。
- 受 DRM/加密保护的 EPUB 会返回 `ERR_DRM_PROTECTED`，工具不会绕过 DRM。
- ZIP entry 数量、解压总大小、单 entry 大小、压缩比、章节数和输出字符数都有默认限制，防止 Zip Bomb / OOM。
- 内部路径包含绝对路径或 `..` 时返回 `ERR_ARCHIVE_INVALID_PATH`；`container.xml` / OPF / NCX 含 `DOCTYPE` / `ENTITY` 时返回 `ERR_XML_UNSAFE_DOCTYPE`；章节 XHTML / `nav.xhtml` 允许常见安全 HTML/XHTML DOCTYPE，但会剥离后再解析，含内部子集或实体声明仍会拒绝。
- 该能力只扩展 `file://` 本地文件，不改变 `http/https` 网页抓取、人机验证、会话复用或桌面工具链路。

## Desktop Target 扩展

Desktop Target 是 web-fetcher 的桌面应用测试扩展，不改变现有网页工具语义。它把 Electron/Chromium renderer、CDP target、Windows native window 和视觉 fallback 统一成 desktop session。

- Electron renderer / CDP target 会复用 Playwright `Page` 能力，可注册成普通 `sessionId` 后继续使用 `web_interact`。
- 普通 Windows exe 走 Windows UI Automation 控件树；控件不可访问时只能返回截图式 visual fallback。
- `desktop_connect_cdp` 只连接本机或显式 endpoint，不会自动打开远程调试端口；测试时建议绑定 `127.0.0.1` 并使用短生命周期会话。

能力边界：

- Electron / Chromium / CEF renderer：支持 DOM 结构、Accessibility tree、DOMSnapshot、截图、CSS selector 点击、输入、快捷键、滚动、等待和 renderer `evaluate`。注册成 `web_interact` session 后，可继续使用网页侧的 `content` / `evaluate` / `click` / `type` 等能力。
- 已打包 Electron 应用：推荐用 `desktop_launch(kind="native", args=["--remote-debugging-port=..."])` 启动，再用 `desktop_connect_cdp` 附着。Playwright `_electron.launch` 更适合可控开发态 Electron 项目。
- 普通 Windows exe：支持窗口枚举、窗口截图、Windows UI Automation 控件树、按 `name` / `automationId` 触发控件、文本输入、快捷键和坐标点击。自绘 UI、Canvas、Unity、部分 Qt 控件可能只能走截图和坐标 fallback。

常用操作示例：

```text
desktop_inspect(desktopSessionId="desktop_...", windowId="window_...", mode="all")
desktop_interact(desktopSessionId="desktop_...", windowId="window_...", action="click", selector="#submit")
desktop_interact(desktopSessionId="desktop_...", windowId="window_...", action="type", selector="input[name=q]", value="hello")
desktop_interact(desktopSessionId="desktop_...", windowId="window_...", action="evaluate", value="() => document.title")
desktop_interact(desktopSessionId="desktop_...", windowId="window_...", action="click", name="确定")
desktop_interact(desktopSessionId="desktop_...", windowId="window_...", action="press", value="{ENTER}")
```

典型 CDP 连接流程：

```text
desktop_connect_cdp(port=9222, ownerId="project-a")
desktop_list_windows(desktopSessionId="desktop_...", ownerId="project-a")
desktop_register_window(desktopSessionId="desktop_...", windowId="window_...", ownerId="project-a")
web_interact(sessionId="session_...", ownerId="project-a", action="content")
desktop_close(desktopSessionId="desktop_...", ownerId="project-a")
```

## Human Browser 用户辅助浏览器

Human Browser 是 Plan 7 新增的显式旁路能力，用于处理 Cloudflare / Turnstile、登录检测、异常弹窗等需要用户手动完成的页面。它不默认接入 `web_fetch_page` / `web_interact` / `web_pipeline` 的 URL 主链路，因此不会改变普通网页抓取和交互行为。

核心边界：

- 不绕过验证码或人机验证；用户在真实 Chrome 中自行完成。
- `web_human_browser_open` 打开受管可见 Chrome，`web_human_browser_attach` 附着已有本机 CDP 端点。
- `web_human_browser_status` 返回页面 URL/title、存活状态、Cookie 数量、localStorage 快照摘要和最近 challenge 检测结果。
- `web_human_browser_register_page` 会把页面注册成普通 `sessionId`，后续复用 `web_interact(sessionId=...)` 或 `web_pipeline(sessionId=...)`。
- 注册出的 web session 是 borrowed/noop；`web_close_sessions` 只移除 alias，不关闭真实 Chrome 页面。
- `web_human_browser_status` / `web_human_browser_register_page` / `web_human_browser_detach` / `web_human_browser_close` 会 best-effort 快照 Cookie 与 localStorage 到共享备份，但 live session 仍是高风控站点的主路径。
- `web_human_browser_detach` 只断开 MCP/CDP 引用，不关闭真实 Chrome；`web_human_browser_close` 会先快照再关闭受管 Chrome 并清理临时 profile，attach 外部浏览器时只释放引用。
- Codex 侧可用 `web_human_browser_open(background=true)` 后再用 `taskId + waitSeconds` 轮询，避免启动或环境抖动超过同步调用窗口；用户手动操作发生在工具调用之外。

典型流程：

```text
web_human_browser_open(startUrl="https://example.com", ownerId="project-a", background=true)
web_human_browser_open(taskId="human-browser-open-...", waitSeconds=30)
web_human_browser_status(humanSessionId="human_...", ownerId="project-a")
web_human_browser_register_page(humanSessionId="human_...", pageId="human_page_...", ownerId="project-a")
web_interact(sessionId="session_...", ownerId="project-a", action="snapshot")
web_human_browser_close(humanSessionId="human_...", ownerId="project-a")
```

连接已有 CDP 浏览器：

```text
web_human_browser_attach(port=9222, ownerId="project-a")
web_human_browser_register_page(humanSessionId="human_...", ownerId="project-a")
web_pipeline(sessionId="session_...", ownerId="project-a", steps=[{action:"visible"}])
web_human_browser_detach(humanSessionId="human_...", ownerId="project-a")
```

## AI 智能摘要三链路

`ai_summary` 与 `web_inspect(mode="ai_review")` 路径现在支持 Antigravity / Codex / Claude Code 三链路模型调用。新参数是 `modelChain`，旧参数 `chain` 保留兼容：

- `modelChain="auto"`：默认值。按 `antigravity -> codex` 尝试；`WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1` 时才把 `claude-code` 作为最后 fallback，避免旧请求隐性消耗 Claude Code 额度。
- `modelChain="antigravity"`：强制走 Antigravity Language Server 的 `GetModelResponse`。
- `modelChain="codex"`：强制走 Codex CLI 模型桥。
- `modelChain="claude-code"`：强制走 Claude Code CLI `claude -p` provider。
- `modelChain` 未填写时使用 `chain`，两者都未填写时使用 `auto`。
- `chain` 仅作为模型链路兼容参数保留，不代表数据链路，也不会引入 `dataChain`。

当前只有 AI Summary 总结链和 `web_inspect(mode="ai_review")` 受 `modelChain` 影响，网页抓取、截图、表格提取、交互和下载主链不变。
这意味着 web-fetcher 不存在对话链路串线问题；只有 `outputMode="ai_summary"`、`compact="ai_summary"` 或 `mode="ai_review"` 会进入模型桥。

后台 AI 任务带 deadline 与 timedOut 状态，默认 15 分钟后标记失败，不会重启或杀掉 web-fetcher 后端；可用 `WEB_FETCHER_WEB_AI_BACKGROUND_MAX_RUN_MS`、`WEB_FETCHER_INSPECT_BACKGROUND_MAX_RUN_MS` 覆盖。

```
web_fetch_page(url, outputMode="ai_summary", modelChain="auto")  → 🤖 AI 摘要 + 完整内容临时文件
web_fetch_rich(url, compact="ai_summary", modelChain="auto")     → 截图 + 🤖 AI 摘要
web_inspect(url, mode="ai_review", modelChain="auto")            → 截图/结构/几何问题 + AI 审查报告
```

- `modelChain="auto"` 的前序链路不可用或调用失败时会继续尝试下一链路；显式指定链路失败时自动降级为 compact 模式并带出错误摘要
- 典型压缩率 95%+（50000字 → 2000字）
- Codex 侧长网页 AI Summary 建议使用后台模式，避免同步 MCP 调用超过宿主超时窗口：

```text
web_fetch_page(url="https://example.com", outputMode="ai_summary", modelChain="codex", background=true)
web_fetch_page(taskId="...", waitSeconds=30)
```

结果里会明确标出实际使用的链路，例如：

- `Antigravity LS GetModelResponse`
- `gpt-5.5 via Codex CLI`
- `sonnet via Claude Code CLI`

Antigravity LS 模型默认值：`WEB_FETCHER_LS_MODEL` 未设置时使用当前 GetModelResponse 实测可用的 Gemini 3.5 Flash High：`MODEL_PLACEHOLDER_M132`。默认 fallback 为 `MODEL_PLACEHOLDER_M132,MODEL_PLACEHOLDER_M20,MODEL_PLACEHOLDER_M18,MODEL_PLACEHOLDER_M16,MODEL_PLACEHOLDER_M36`，可通过 `WEB_FETCHER_LS_MODEL_FALLBACKS` 覆盖。其中 `M132/M20` 是新 Flash 高速路径，`M18` 是旧 Gemini 3 Flash 兜底，`M16/M36` 是 Gemini 3.1 Pro High/Low 兜底；复杂推理仍应优先理解为 Pro 更可靠，而不是把 Flash 的速度等同于最强推理。`MODEL_PLACEHOLDER_M47` 已返回 `unknown model key`，`MODEL_PLACEHOLDER_M37` 当前对 GetModelResponse 返回 `400 INVALID_ARGUMENT`，均不再放入默认链路。Codex 模型桥默认值：`gpt-5.5` + `model_reasoning_effort=medium` + `model_speed_tier=fast`，可覆盖环境变量：`WEB_FETCHER_CODEX_MODEL`、`WEB_FETCHER_CODEX_REASONING`、`WEB_FETCHER_CODEX_SPEED`。Claude Code CLI 默认值：`sonnet` + `--effort low`，可用 `WEB_FETCHER_CLAUDE_CODE_MODEL`、`WEB_FETCHER_CLAUDE_CODE_EFFORT`、`WEB_FETCHER_CLAUDE_CODE_TIMEOUT_MS`、`WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD` 覆盖；显式 `claude-code` 才主动调用，`auto` 末跳需 `WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1`。

## v7.0: 视觉检查与 AI Review

### `web_fetch_screenshot` 视觉增强

- `target`: 按文本内容定位局域截图，适用于网页、PDF 和 PPTX 转换后的页面。
- `scale`: 控制 `target` 局域截图放大倍率，默认 `1.4`，用于保留目标周边上下文。
- `diff`: 提供对比基准 URL 后生成差异高亮截图，并返回变化像素比例。

### `web_inspect`

`web_inspect` 用于检查网页、PDF、PPTX 与 EPUB 的结构和视觉问题，支持四种模式：

- `mode="structure"`：提取页面结构树，包含文本、边界框、层级、字体与颜色等信息。
- `mode="detect"`：检测 `overlap`、`overflow`、`readability`、`alignment`。
- `mode="ai_review"`：每页打包截图、结构树和几何检测结果，交给模型做审查。`modelChain="codex"` 会把截图作为多模态输入传给 Codex；`modelChain="antigravity"` 只能把截图路径、结构树和几何检测结果写入文本 prompt；`modelChain="claude-code"` 第一阶段走 Claude Code CLI 文本审查 fallback，不作为默认优先链路。
- `mode="all"`：一次执行结构提取、规则检测和 AI 审查。

EPUB 路线是静态 ebook 结构，不创建 DOM session；`ai_review` 当前只返回静态结构说明，不执行截图型视觉审查。

AI Review 支持同步单页和后台批量：

```text
web_inspect(url="file:///C:/demo.pptx", mode="ai_review", page=1, modelChain="auto")
web_inspect(url="file:///C:/deck.pptx", mode="ai_review", page="all", background=true, batchSize=5)
web_inspect(action="check", taskId="...", waitSeconds=30)
```

### 持久会话与登录态

- `web_interact` / `web_pipeline` 支持 `ownerId`。未传时按 `global` 兼容旧调用；保留 session 后，后续读取或关闭应使用同一 `ownerId`。
- `web_list_sessions(ownerId="project-a")` 可查看当前 owner 的保留会话；排查共享 broker 占用时可传 `includeAllOwners=true`。
- `web_close_sessions(sessionId="session_...", ownerId="project-a")` 关闭单个会话；`web_close_sessions(ownerId="project-a", closeAllForOwner=true)` 只清理该 owner 下的会话，不跨 owner 关闭。
- `web_pipeline` 可传 `sessionId` 复用已登录页面、弹窗 session 或 `desktop_register_window` 注册来的 Electron renderer；不传 `sessionId` 时仍按旧行为用 `url` 新建页面。
- `web_interact(action="snapshot")` 与 `web_pipeline(steps=[{action:"snapshot"}])` 默认一次返回图片、视口可见文本和 DOM 摘要；显式 `saveMode="file"` 保留旧截图路径输出。
- 页面池默认允许 5 个并发页面（可用 `WEB_FETCHER_MAX_CONCURRENT_PAGES` 覆盖）；达到 3 个活跃页面起会在 `web_interact`、`web_pipeline`、`web_list_sessions` 输出中提示接近上限，并建议用 `web_close_sessions` 顺手清理旧会话（提醒阈值可用 `WEB_FETCHER_PAGE_POOL_WARNING_THRESHOLD` 覆盖）。
- Cookie 与 localStorage 是全局共享资源，会通过文件锁和临时文件 rename 合并写入；它们不按对话或项目隔离。首次启用登录态功能前，应确认同一 Windows 账户下的四个宿主都被允许访问这些站点身份；需要隔离时使用不同的 `CODEX_TOOLKIT_DATA_ROOT`，不要共享 profile。
- 有头登录 / UAV 会使用动态空闲 CDP 端口，并只清理带匹配临时 profile 或 lockfile owner 的自有 Chrome，不按固定端口粗暴杀进程。
- 浏览器主 context 与 bareContext 在 `close()` / `closeBrowser()` 时都会关闭并清理各自临时 profile。
- 本地开发地址（`localhost` / `127.0.0.1` / `[::1]`）会自动走 no-cache 访问，避免同一 profile 下旧 Vite/开发服务器响应导致白屏；远程登录态站点仍保持原有缓存与 Cookie 行为。

```text
web_list_sessions(ownerId="project-a")
web_pipeline(sessionId="session_...", ownerId="project-a", steps=[{action:"snapshot"}])
web_close_sessions(sessionId="session_...", ownerId="project-a")
```

`modelChain="antigravity"` 会通过 Antigravity Language Server 的 `GetModelResponse` 调用模型。该 RPC 只支持 `{model,prompt}` 纯文本请求，因此 AI Review 会把截图路径、结构树和几何检测结果写入 prompt；截图本身不会作为 `images` 多模态 payload 发送。`modelChain="codex"` 会通过 Codex CLI 模型桥调用 GPT-5.x，并用 `-i` 传入截图。

## v5.2 新增：中国游戏社区适配 + 进程生命周期升级

### GBK 编码修复

NGA（ngabbs.com）等使用 GBK 编码的站点现在可以正确显示中文。在 Playwright 的 `page.route` 拦截层，自动检测 `Content-Type` 和 HTML meta 中的 charset 声明，用 `iconv-lite` 将 GBK/GB2312 字节流解码为 UTF-8 后注入浏览器。

### SPA 懒加载检测

对 B 站、米游社等 SPA 站点，自动检测内容是否为骨架屏/空壳页面：
- 内容低于 200 字符 + 包含骨架屏关键词 → 追加提示，建议使用 `scrollCount` 参数触发懒加载
- 不误报内容已充足的页面

### B 站 BV 号跳转诊断

检测到 `bilibili.com/video/BVxxx` 格式的 URL 被重定向到非视频页面时，自动追加诊断信息。

### 进程生命周期：与 LS 同生共死

- ~~超时自杀~~：不再使用 30 分钟空闲超时自杀机制
- **ppid 存活检测**：每 30 秒检测父 LS 进程是否存活，窗口关闭则自动退出
- **双层防护**：stdin 管道断裂（秒级）+ ppid 检测（30s）+ `isClosing` 防重复清理
- 浏览器空闲释放（20 分钟）保留，下次调用自动重启

## v6.1: 多实例隔离 + UAV + SmartLoad

### 多实例隔离
- 每个 MCP 进程使用独立的浏览器 profile（按 PID 隔离），解决 Chromium SingletonLock 冲突
- Cookie 与 localStorage 备份文件共享，所有实例间登录态同步

### UAV（用户辅助验证）
- 检测人机验证拦截 → 自动弹出系统 Chrome → 用户完成验证 → Cookie 回收到 Playwright
- v7.1 起检测器增加 Cloudflare challenge-platform / Turnstile / `cf-chl-*` 强信号；强挑战页不会因为已有 Cookie 备份就直接跳过 UAV
- 对 Cookie 可能绑定浏览器实例/指纹的站点，优先使用 Human Browser 复用同一真实浏览器会话；Cookie 回灌仍保留为 best-effort
- CDP 连接注入 Cookie + 定期快照 + 超时保护

### SmartLoad 智能加载
- 每 500ms 检测页面可见元素和文本变化，连续稳定后才认为加载完成
- SPA 域名自动延长等待时间，适配 B 站/知乎等重型 SPA

### Stealth 反检测 18 层防护
- 覆盖 navigator/plugins/WebGL/Canvas/Audio/字体 等 25+ 检测向量
- Function.toString 全局拦截 + Playwright DOM 痕迹清除 + CDP 痕迹处理

## v6.2: 进程生命周期容错

- ppid 监测 3 次容错机制（应对 LS 短暂抖动）
- heartbeat 动态间隔（degraded → 5s / alive → 30s）
- 非 LS 环境检测 + 1 小时空闲超时兜底

## v6.3: Stealth 一致性修复 + 延迟优化

### Stealth 审计与修复
- Chrome 版本号集中常量化（`constants.ts`），更新至最新稳定版
- WebGL 显卡型号通用化（RTX 3060），`getStealthScript()` 参数化
- `__stealthMark` 改用 Symbol 键，防止被 Object.keys 枚举检测

### 延迟优化
- SPA 域名跳过 `networkidle` 等待（省 ~5s 白等）
- 普通站点 `networkidle` 超时 5s → 3s（SmartLoad 兜底）
- UAV Chrome 启动从固定 3s 改为 CDP 端口轮询（通常 1-1.5s 返回）

## v6.8: 双向滚动 + iframe 穿透 + 内容完整性分析

### 双向滚动
- `scrollCount` 支持负数（如 -5 表示向上滚 5 次），解决 SPA 顶部懒加载问题

### 新增 action
- `press`: 键盘操作（快捷键 `Control+z` / 增量输入）
- `find`: 页面内文本搜索，返回匹配数量和上下文
- `visible`: 提取当前视口可见文本

### iframe 穿透
- `frame` 参数支持在 iframe 内执行操作，支持嵌套（` >> ` 分隔）

### 内容完整性多信号分析
- 5 信号组合评分：“加载更多”按钮检测 / SPA 框架指纹 / HTML体积比 / 折叠面板 / 隐藏标签页
- 分级提示：💡 low / 🔍 medium / ⚠️ high
- Readability + body fallback 两条路径均覆盖

## v6.9: evaluate action

- `web_interact` 和 `web_pipeline` 新增 `evaluate` action
- 支持本地 JS 文件路径（绕过 AI 输出长度限制）或内联 JS 代码
- 支持 async/await，返回值自动序列化

## 首次使用

1. 编译：`npm run build`
2. 调用 `web_login_browser` 工具，打开有头浏览器
3. 在浏览器中登录需要的网站（知乎、X 等）
4. 完成操作后可以直接关闭本次窗口，工具会保存状态并报告结果，不要求额外等待两秒
5. 确认工具报告已保存后，重新访问目标页面验证实际登录状态；状态已保存不等于网站认证成功

Codex 侧手动登录建议使用后台模式，避免同步 MCP 调用在用户登录完成前超时：

```text
web_login_browser(startUrl="https://example.com/login", background=true)
web_login_browser(taskId="web-login-...", waitSeconds=30)
```

同步和后台登录共用 600 秒人工操作窗口，UAV（访问过程中弹出的人工验证窗口）使用相同保存流程。周期采样串行执行，截止时先等待保存再关闭；手动关闭后只允许有界恢复本次工具自有、已经退出的 Chrome profile，恢复失败会保留来源并明确告警，不能把空导出报告成登录完成。纯 localStorage 登录也可以报告保存成功，不以 Cookie 数量作为唯一判断。

共享 Cookie 更新会刷新已有浏览器上下文，旧上下文未更新的认证值不能覆盖新备份。localStorage 按协议、主机和端口组成的 origin 隔离，在新页面导航时恢复；不会悄悄刷新用户正在操作的旧页面。旧版按主机保存的备份仅兼容该主机的默认 HTTPS 来源，不注入其它协议或端口。

Human Browser 同样使用串行快照，关闭或解绑会等待在途保存；借用外部浏览器时只断开连接，不关闭浏览器或清理对方 profile。保存计数、最近成功写入时间和当前错误分开报告。若工具提示保留恢复来源，请勿删除该目录或反复扫码；先核查导出与目标站点访问结果。

后台查询仍建议 `waitSeconds=30–45`，人工窗口结束后可能短暂继续保存和清理。`waitSeconds` 是本次查询等待时长，不是重新开启十分钟窗口。

验证命令：`npm run test:login` 覆盖隔离存储、并发与来源规则。设置 `WEB_FETCHER_LIVE_LOGIN_TEST=1` 后运行 `npm run test:login:browser` 可用本地合成站点与临时 Chrome/Edge 验证关窗、超时、纯 localStorage 和失败保留；设置 `WEB_FETCHER_600S_TEST=1` 后运行 `npm run test:login:600s` 会实际等待十分钟，验证截止前最后修改的状态能在新浏览器恢复。测试不使用真实账号。

## MCP 配置

配置文件：`%USERPROFILE%\.gemini\antigravity\mcp_config.json`

```json
{
  "mcpServers": {
    "web-fetcher": {
      "command": "node",
      "args": ["<toolkit-root>\\mcps\\web-fetcher\\dist\\index.js"],
      "env": {}
    }
  }
}
```

### Windsurf / WSF 接入

Windsurf / WSF 只作为 `web-fetcher` 的 MCP 客户端接入共享 HTTP broker，不新增 `modelChain="windsurf"` 或 `dataChain="windsurf"`。AI Summary / AI Review 仍使用现有 `modelChain="auto|antigravity|codex|claude-code"`，普通抓取、截图、交互、文件处理和登录态路径不受模型链路影响。

WSF 配置文件：

```text
%USERPROFILE%\.codeium\windsurf\mcp_config.json
```

推荐直连配置：

```json
{
  "mcpServers": {
    "web-fetcher": {
      "serverUrl": "http://127.0.0.1:14588/web-fetcher/mcp"
    }
  }
}
```

保存后在 Windsurf 中执行：

```text
Ctrl+Shift+P -> Cascade: Refresh MCP Servers
```

若 WSF 后续版本无法直连 Streamable HTTP `/mcp`，可用 `mcp-remote` 包装本机 broker：

```json
{
  "mcpServers": {
    "web-fetcher": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://127.0.0.1:14588/web-fetcher/mcp",
        "--allow-http",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

WSF 验收不能只看工具名出现，必须在 Cascade 对话里做至少一次真实调用。建议先测 `web_fetch_page`、`web_fetch_screenshot`、`web_inspect(mode="structure")`；登录态站点只在用户明确同意时测试。

## 开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm run dev          # 开发模式（热重载）
npx tsx src/test.ts  # 运行 smoke test
```
