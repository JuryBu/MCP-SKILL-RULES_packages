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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserManager } from "./browser.js";
import { sessionManager } from "./session.js";
import { getIdleTime, logStdinEvent, isParentAlive } from "./lifecycle.js";
import fs from "fs";
import path from "path";
import os from "os";

// 工具注册
import { registerFetchPage } from "./tools/fetch-page.js";
import { registerFetchHtml } from "./tools/fetch-html.js";
import { registerFetchScreenshot } from "./tools/fetch-screenshot.js";
import { registerListCookies } from "./tools/list-cookies.js";
import { registerLoginBrowser } from "./tools/login-browser.js";
import { registerInteract } from "./tools/interact.js";
import { registerExtractLinks } from "./tools/extract-links.js";
import { registerRecordVideo } from "./tools/record-video.js";
import { registerFetchRich } from "./tools/fetch-rich.js";
import { registerPipeline } from "./tools/pipeline.js";
import { registerFetchDownload } from "./tools/fetch-download.js";
import { registerConvertTool } from "./tools/convert-tool.js";
import { registerBatchScreenshot } from "./tools/batch-screenshot.js";
import { registerExtractTables } from "./tools/extract-tables.js";
import { isLsAvailable, getLsStatus } from "./ls-client.js";

// === 进程生命周期常量 ===
const HEARTBEAT_BROWSER_TIMEOUT = 20 * 60 * 1000; // 20 分钟无活动 → 关闭浏览器（下次调用自动重启）

// 创建 MCP Server 实例
const server = new McpServer({
    name: "web-fetcher-mcp-server",
    version: "5.2.0",
});

// 注册所有工具
registerFetchPage(server);
registerFetchHtml(server);
registerFetchScreenshot(server);
registerFetchRich(server);
registerListCookies(server);
registerLoginBrowser(server);
registerInteract(server);
registerExtractLinks(server);
registerRecordVideo(server);
registerPipeline(server);
registerFetchDownload(server);
registerConvertTool(server);
registerBatchScreenshot(server);
registerExtractTables(server);

// === 测试 Resource 注册（方案D已验证通过，保留供后续使用） ===
server.registerResource(
    "test-resource",
    "web-fetcher://test/hello",
    {
        description: "测试 resource，验证 Antigravity 可通过 read_resource 读取 MCP 注册的资源",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "web-fetcher://test/hello",
                text: "MCP Web Fetcher v5.0 - Resource 机制正常\n\n可用于将抓取结果存储为 resource，AI 按需读取。",
                mimeType: "text/plain",
            },
        ],
    })
);

// === 防重复 cleanup 守卫 ===
let isClosing = false;
async function safeCleanupAndExit(reason: string): Promise<void> {
    if (isClosing) return;
    isClosing = true;
    logStdinEvent(reason);
    console.error(`[web-fetcher] ${reason}`);
    await cleanup();
    process.exit(0);
}

// === stdin 断开检测（第一层防线，秒级响应）===
process.stdin.on("end", () => safeCleanupAndExit("stdin END — 管道断裂"));
process.stdin.on("close", () => safeCleanupAndExit("stdin CLOSE — 管道关闭"));
process.stdin.on("error", (err) => safeCleanupAndExit(`stdin ERROR: ${err.message}`));

// === 心跳：父 LS 存活检测 + 浏览器空闲释放 ===
// 每 30 秒检测一次父 LS 进程是否还活着（替代旧的超时自杀）
const heartbeatInterval = setInterval(async () => {
    if (!isParentAlive()) {
        await safeCleanupAndExit(`父 LS (PID=${process.ppid}) 已消失，自动退出`);
        return;
    }

    // 浏览器空闲释放：20 分钟无工具调用 → 关闭 Chromium 释放内存
    const idle = getIdleTime();
    if (idle > HEARTBEAT_BROWSER_TIMEOUT) {
        console.error(`[web-fetcher] ${Math.round(idle / 60000)} 分钟无活动，关闭浏览器释放内存`);
        await browserManager.closeBrowser();
    }
}, 30000);

// 防止 heartbeat interval 阻止进程退出
heartbeatInterval.unref();

// 启动 stdio 传输
async function main(): Promise<void> {
    console.error("[web-fetcher] MCP Server v5.2 启动中...");
    logStdinEvent("STARTED");

    // 清理遗留的临时目录（防止意外中断导致堆积）
    cleanStaleTempDirs();

    // v4.0: 清理过期临时文件 + 检测转换工具
    const { cleanOldTempFiles, ensureTempDirs } = await import('./temp-store.js');
    ensureTempDirs();
    cleanOldTempFiles();

    const { detectConversionTools } = await import('./converter.js');
    await detectConversionTools();

    // v5.1: 后台初始化 LS 客户端（非阻塞，不影响其他功能）
    isLsAvailable().then(available => {
        const status = getLsStatus();
        if (available) {
            console.error(`[web-fetcher] LS 已连接 (PID: ${status.pid}, Port: ${status.port}) — AI Summary 可用`);
        } else {
            console.error(`[web-fetcher] LS 未发现 — AI Summary 将降级为 compact 模式`);
        }
    }).catch(() => {
        console.error(`[web-fetcher] LS 检测失败 — AI Summary 将降级为 compact 模式`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("[web-fetcher] MCP Server v5.1 已启动，等待连接...");
}

/**
 * 清理超过 1 小时的 MCP 临时目录
 */
function cleanStaleTempDirs(): void {
    const tmpBase = os.tmpdir();
    const prefixes = ["mcp-video-", "mcp-chrome-login-"];
    const maxAge = 60 * 60 * 1000; // 1 小时

    try {
        const entries = fs.readdirSync(tmpBase);
        let cleaned = 0;
        for (const entry of entries) {
            if (!prefixes.some((p) => entry.startsWith(p))) continue;
            const fullPath = path.join(tmpBase, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory() && Date.now() - stat.mtimeMs > maxAge) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    cleaned++;
                }
            } catch { /* skip */ }
        }
        if (cleaned > 0) {
            console.error(`[web-fetcher] 已清理 ${cleaned} 个遗留临时目录`);
        }
    } catch { /* tmpdir 读取失败不影响启动 */ }
}

main().catch((error) => {
    console.error("[web-fetcher] 启动失败:", error);
    process.exit(1);
});

// 优雅关闭
const cleanup = async () => {
    console.error("[web-fetcher] 正在关闭...");
    clearInterval(heartbeatInterval);
    // v4.0: 关闭临时 HTTP 服务器
    try {
        const { stopAllServers } = await import('./local-server.js');
        stopAllServers();
    } catch { /* ignore */ }
    await sessionManager.closeAll();
    await browserManager.close();
};

process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
});
