# 网页、本地文件预览与视觉验收（Antigravity 2.0）

本专题遵循全局 `GEMINI.md`「专题阅读入口」：开展浏览器交互、登录墙处理、本地文件（Office / PDF / SVG / HTML）预览、截图或视觉验收前读取。MCP 参数细节配合 `tools-reference` Skill。

## 一、工具分工、内置 `browser` 边界与原生 `file://` 预览铁律

1. **三层工具选择与内置 `browser` 防死循环**：
   - **静态公开资料**：首选 `exa.web_search_exa` / `web_fetch_exa`（未配置或不可用时说明原因降级 `search_web`）。
   - **登录态读取、DOM/JS 检查、批量截图与可控自动化**：优先使用 MCP `web-fetcher`（`web_fetch_screenshot`、`web_inspect`、`web_interact`、`web_pipeline`；需操作本机浏览器时切勿粗暴 `taskkill` 用户正在使用的浏览器进程抢 profile 锁，优先用 `web-fetcher` 独立上下文或 `web_human_browser_*` 安全附着）。
   - **内置可视化 `browser` 子代理边界**：仅在明确要求于 IDE 内置浏览器面板实时演示/操作网页应用时委派。注意内置 `browser` 默认使用 Flash 系模型，易在模糊目标下陷入重复 `Wait` 死循环——**派发时严禁给开放式主观分析任务，必须给出精确动作序列与硬性终止条件（如「点击 X 并看到 Y 出现后立即截图返回，最多重试 2 次」）**，收到结果必核对宿主 `BROWSER_HOST_FACTS`。
2. **本地与 Office 原生查看（严禁转 PDF）**：
   - Word、PPT、Excel、PDF、SVG 与本地 HTML 一律用 `web-fetcher` 直接通过 `file://` 协议原生打开截图与检查，**严禁先转 PDF 再验收**。
   - **LibreOffice 并发禁忌**：严禁并发调用 LibreOffice 渲染 Office 截图（争抢配置目录会报 `EPERM`），必须串行逐份渲染，首次冷启动留足约 `45s` 窗口。

## 二、截图真实性、会话缓存避坑与全视角复验

1. **看图说话，禁盲报通过**：拿到截图或分片后必须亲自用 `read_file` 逐张查看画面（IDE 图片单边硬上限 `<= 8000px`；`web-fetcher` 长图默认 `1600px` 分片、`300px` 重叠，按顺序看全不漏页）。`web_inspect` 零告警只代表几何测量候选，不能代替肉眼检查遮挡、溢出、过曝泛白与审美质感。
2. **本地 HTML 修改后的会话缓存铁律**：`web_interact` 复用已有 `sessionId` 时，即使重传本地 `file://` URL 也可能命中旧页面缓存！每次修改磁盘上的 HTML/JS/CSS 后，**必须先 `close` 旧会话再新建会话（或执行强制无缓存刷新并核验 DOM 特征）**，确认加载的是最新磁盘代码。
3. **无头视口高度差异注意**：无头浏览器中 `window.innerHeight` 与全屏容器 `clientHeight` 可能存在差值（曾导致全屏 Three.js Canvas 底部出现黑带），全屏渲染应绑定容器 `clientHeight` + `ResizeObserver` 并在多个视口下实测。
4. **末轮改码后的全视角版本一致性**：最后一轮修改代码、材质、相机或布局后，**所有受影响的视角/页面必须重新截图并重看**；未重截的旧图绝不能混入最终交付验证清单冒充最新版成果。

## 三、登录墙核验与会话资源卫生

- **本地登录态先实测**：公开模板与工具包不携带任何 Cookie、账号或浏览器资料；若接收方在本机 `web-fetcher` 中独立配置了站点持久登录态，Cookie/localStorage 文件存在时仍可能已过期——必须实际访问目标页核验正文，确认确需人工登录时再用 `web_login_browser(background=true)` 并以 `30～45s` 短轮询等待人工操作，不凭搜索摘要冒充已读正文，也绝不绕过验证码或付费墙。
- **只清理自建资源**：持久会话必带显式 `ownerId`（当前会话 ID），收尾时通过明确 `sessionId` 或 `closeAllForOwner` 关闭本任务自建会话与窗口，**严禁关闭借用的用户浏览器或清理共享登录态/Cookie/profile**。

## 四、聊天正文图文混排、`<agent-embed>` 微组件与 `sidecar://` 胶囊

1. **正文图文混排**：反重力 2.0 仅允许内联渲染当前对话专属 `brain/<conversation-id>/` 目录下的媒体文件；外部截图或生成图须先拷入该目录（`image-generator` 产物已默认直存此处），再用 `![图注](file:///C:/完整正斜杠路径)` 单图或 `carousel`（`<!-- slide -->` 分隔）混排展示。
2. **`<agent-embed>` 气泡交互卡片**：自包含 `.html` 写入当前对话 `brain/<id>/`（设 `UserFacing=true`），仅引入白名单 `https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js`；使用 `<body class="bg-transparent ...">` 与宿主动态注入的 `--card`、`--background`、`--foreground`、`--muted-foreground`、`--border`、`--primary` 等语义变量（**严禁在 `:root` 声明本地颜色回退值**，最小字号 `>= 12px`），内容自然高度严格压在 `< 450px`（内联视口上限 `500px`，严禁顶层设 `100vh`/`h-screen`），大型仪表盘改为侧栏独立 Artifact。
3. **`sidecar://` 面板胶囊与克制红线**：仅对本机已启用运行的侧栏面板（如 `sidecar://swarm/swarm_board/`、`sidecar://dashboard`）输出 `[面板名](sidecar://...)` 胶囊且同一视图限发一颗。**严格避免本末倒置**：两三句话或一张小表就能讲明白的事，绝不耗时手搓 HTML 微组件让用户干等。
