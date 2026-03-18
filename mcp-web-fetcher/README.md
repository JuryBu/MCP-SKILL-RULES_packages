# MCP Web Fetcher

使用带 Cookie 的浏览器抓取网页内容的 MCP Server。解决 AI 助手无法访问需要登录才能查看的网站内容问题。

## 工作原理

通过 Playwright 维护一个独立的浏览器 profile（`mcp-web-fetcher-profile`），保存用户在各网站的登录 Cookie。MCP 工具调用时使用该 profile 的无头浏览器访问页面，从而绕过登录墙。

## 工具列表

| 工具名 | 功能 |
|--------|------|
| `web_fetch_page` | 抓取网页正文，返回 Markdown（支持 ai_summary 智能摘要模式） |
| `web_fetch_html` | 获取原始 HTML |
| `web_fetch_screenshot` | 网页截图（5级质量控制） |
| `web_fetch_rich` | 截图+文本一次获取（支持 ai_summary 模式） |
| `web_extract_links` | 提取页面链接 |
| `web_extract_tables` | 提取 HTML 表格 |
| `web_interact` | 页面交互（点击/输入/滚动/搜索） |
| `web_pipeline` | 多步操作流水线 |
| `web_download` | 文件下载 |
| `web_convert` | 格式转换（Office→PDF/HTML/TXT） |
| `web_batch_screenshot` | 批量截图 |
| `web_record_video` | 视频录制/关键帧提取 |
| `web_list_cookies` | 列出 Cookie 概要 |
| `web_login_browser` | 打开有头浏览器登录 |

## v5.1 新增：AI 智能摘要

通过 LS（Language Server）内置的 Gemini 3 Flash 模型，自动生成网页的精炼中文概括。

```
web_fetch_page(url, outputMode="ai_summary")   → 🤖 AI 摘要 + 完整内容临时文件
web_fetch_rich(url, compact="ai_summary")       → 截图 + 🤖 AI 摘要
```

- LS 不可用时自动降级为 compact 模式
- 典型压缩率 95%+（50000字 → 2000字）

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

## 首次使用

1. 编译：`npm run build`
2. 调用 `web_login_browser` 工具，打开有头浏览器
3. 在浏览器中登录需要的网站（知乎、X 等）
4. 登录完成后关闭浏览器窗口
5. 之后就可以用 `web_fetch_page` 等工具抓取需要登录的页面了

## MCP 配置

配置文件：`<MCP工具安装路径>\mcp_config.json`

```json
{
  "mcpServers": {
    "web-fetcher": {
      "command": "node",
      "args": ["C:\\Users\\<用户名>\\.gemini\\antigravity\\mcp-web-fetcher\\dist\\index.js"],
      "env": {}
    }
  }
}
```

## 开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript
npm run dev          # 开发模式（热重载）
npx tsx src/test.ts  # 运行 smoke test
```
