#!/usr/bin/env node
/**
 * MCP Web Fetcher Server v5.1
 *
 * 使用带 Cookie 的浏览器抓取网页内容，支持需要登录态的网站。
 * 通过 Playwright persistent context 复用专用 profile 中的 Cookie。
 *
 * v5.1: AI Summary 模式 — LS 驱动的智能网页摘要
 *   - 新增 ai_summary outputMode（调用 Gemini 3 Flash 生成精炼中文概括）
 *   - LS 不可用时自动降级为 compact 模式
 *   - 内置 LS 通信层（自动发现进程/端口/CSRF）
 *   - 截图默认保存临时文件（file 模式）
 *   - 5 级图片质量控制 (hd/clear/default/compact/fast)
 *   - 支持 DOCX/PPTX/XLSX/TEX/图片等本地文件
 *   - 多文件 Web 项目临时 HTTP 服务器
 *   - 临时文件缓存命中机制
 *   - 14 个工具：截图/文本/交互/流水线/视频/下载/转换/批量截图/表格提取
 */
export {};
//# sourceMappingURL=index.d.ts.map