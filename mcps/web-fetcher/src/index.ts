#!/usr/bin/env node
/**
 * MCP Web Fetcher Server v7.0
 *
 * 使用带 Cookie 的浏览器抓取网页内容，支持需要登录态的网站。
 * 通过 Playwright persistent context 复用专用 profile 中的 Cookie。
 *
 * v7.0: 视觉检查与 AI Review
 *   - web_inspect 支持 DOM/PDF/PPTX 的 structure/detect/ai_review/all
 *   - 检测 overlap/overflow/readability/alignment
 *   - AI Review 打包截图 + 结构树 + 几何检测结果，支持后台批量与三链路模型调用
 *
 * v6.4: Stealth 自适应降级系统
 *   - 检测到 400 Bad Request 时自动从完整 stealth (L3) 降级到裸奔模式 (L1)
 *   - 域名级降级记忆：同域后续请求直接使用最佳 stealth level
 *   - 降级前自动清除 Cookie 防止毒 Cookie 污染
 *   - stealth.ts 新增 StealthLevel 类型和 level 参数
 *
 * v6.3.1: UAV 反复弹窗修复 + 截图分片阈值放宽
 * v6.3: Stealth 一致性修复 + 延迟优化
 * v6.1: 多实例隔离 + UAV + 截图视觉就绪
 * v5.1: AI Summary + LS 通信层
 * v5.0: 14 个工具 / 5 级质量 / 临时文件缓存 / Cookie 持久化
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserManager } from "./browser.js";
import { sessionManager } from "./session.js";
import { getIdleTime, logStdinEvent, isParentAlive, checkParentAliveWithTolerance, isAntigravityLS, hasNewerSiblingInstance } from "./lifecycle.js";
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
import { registerSessionTools } from "./tools/sessions.js";
import { registerFetchDownload } from "./tools/fetch-download.js";
import { registerConvertTool } from "./tools/convert-tool.js";
import { registerBatchScreenshot } from "./tools/batch-screenshot.js";
import { registerExtractTables } from "./tools/extract-tables.js";
import { registerInspect } from "./tools/inspect.js";
import { registerDesktopTools } from "./tools/desktop.js";
import { registerHumanBrowserTools } from "./tools/human-browser.js";
import { desktopManager } from "./desktop/manager.js";
import { humanBrowserManager } from "./human-browser/manager.js";
import { isLsAvailable, getLsStatus } from "./ls-client.js";
import { getModelBridgeStatus } from "./model-bridge.js";

// === 进程生命周期常量 ===
const HEARTBEAT_BROWSER_TIMEOUT = 20 * 60 * 1000; // 20 分钟无活动 → 关闭浏览器（下次调用自动重启）

// 创建 MCP Server 实例
const server = new McpServer({
    name: "web-fetcher-mcp-server",
    version: "7.0.0",
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
registerSessionTools(server);
registerFetchDownload(server);
registerConvertTool(server);
registerBatchScreenshot(server);
registerExtractTables(server);
registerInspect(server);
registerDesktopTools(server);
registerHumanBrowserTools(server);

// === 测试 Resource 注册（方案D已验证通过，保留供后续使用） ===
server.registerResource(
    "web-fetcher-guide",
    "web-fetcher://guide",
    {
        description: "web-fetcher 工具指南，包含 AI Summary 与 web_inspect AI Review 的三链路说明",
        mimeType: "text/markdown",
    },
    async () => {
        const status = await getModelBridgeStatus();
        const guide = [
            "# MCP Web Fetcher Guide",
            "",
            "## AI Summary / AI Review 三链路",
            "",
            "- `web_fetch_page(outputMode=\"ai_summary\")` 与 `web_fetch_rich(compact=\"ai_summary\")` 支持 `modelChain` 参数，并兼容旧 `chain` 参数。",
            "- `web_fetch_page(outputMode=\"ai_summary\", background=true)` 可把 Codex 链路摘要转入后台任务，再用 `taskId` 查询。",
            "- Codex 侧长网页 AI Summary 建议使用后台模式：`web_fetch_page(url=\"...\", outputMode=\"ai_summary\", modelChain=\"codex\", background=true)`，随后 `web_fetch_page(taskId=\"...\", waitSeconds=30-45)`。",
            "- `web_inspect(mode=\"ai_review\")` 支持 `modelChain` 参数；Codex 链路会用 `-i` 传入截图，Antigravity LS 链路只能把截图路径、结构树与几何检测结果写入纯文本 prompt。",
            "- `modelChain=\"auto\"`：按 `antigravity -> codex` 尝试；只有 `WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1` 时才把 `claude-code` 作为最后 fallback，避免隐性消耗 Claude Code 额度。",
            "- `modelChain=\"antigravity\"`：强制走 Antigravity Language Server 的 `GetModelResponse`。",
            "- `modelChain=\"codex\"`：强制走 Codex CLI 模型桥。",
            "- `modelChain=\"claude-code\"`：强制走 Claude Code CLI `claude -p` provider。",
            "- `modelChain` 未填写时使用 `chain`，两者都未填写时使用 `auto`；`chain` 仅作为模型链路兼容参数保留，不代表数据链路，也不会引入 `dataChain`。",
            "- Codex 模型桥默认值：`gpt-5.5` + `model_reasoning_effort=medium` + `model_speed_tier=fast`，可用 `WEB_FETCHER_CODEX_MODEL`、`WEB_FETCHER_CODEX_REASONING`、`WEB_FETCHER_CODEX_SPEED` 覆盖。",
            "- Claude Code CLI 默认值：`sonnet` + `--effort low`；可用 `WEB_FETCHER_CLAUDE_CODE_MODEL`、`WEB_FETCHER_CLAUDE_CODE_EFFORT`、`WEB_FETCHER_CLAUDE_CODE_TIMEOUT_MS`、`WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD` 覆盖。",
            "- Antigravity LS 默认 GetModelResponse 候选：`M132 -> M20 -> M18 -> M16 -> M36`。前两项是 Gemini 3.5 Flash 高速路径，后两项是 Gemini 3.1 Pro 推理兜底；`M37/M47` 不再进入默认链路。",
            "- 只有 AI Summary 与 AI Review 受 `modelChain` 影响；网页抓取、截图、交互主链不变。",
            "- AI 后台任务带 deadline/timedOut：默认 15 分钟超时标记 error，不重启或杀掉 web-fetcher 后端。",
            "",
            "## Local Document / Ebook",
            "",
            "- `web_fetch_page(file://...epub)` 会在进入 Chromium 前走本地 EPUB adapter，解析 metadata、目录和 spine 章节，并返回 Markdown；不会再触发 `page.goto: Download is starting`。",
            "- `web_inspect(file://...epub, mode=\"structure\")` 返回 `route=\"ebook\"` 的静态结构，包含 metadata、TOC、章节列表、资源统计、warnings 和 truncated。",
            "- `web_fetch_screenshot(file://...epub)` 当前阶段明确返回 `ERR_UNSUPPORTED_SCREENSHOT_ROUTE`；EPUB 不注册 DOM session，也不承诺 selector 交互。",
            "- EPUB 会校验 ZIP magic、`mimetype=application/epub+zip`、`META-INF/container.xml`、OPF spine；DRM 返回 `ERR_DRM_PROTECTED`，Zip Slip 返回 `ERR_ARCHIVE_INVALID_PATH`。`container.xml` / OPF / NCX 严禁 DOCTYPE/ENTITY；章节 XHTML / `nav.xhtml` 允许安全 HTML/XHTML DOCTYPE，但会剥离后再解析。",
            "- `.rst`、`.adoc`、`.org`、`.srt`、`.vtt` 纳入直接文本读取；该本地文件路由只影响 `file://`，不改变 `http/https`、Human Browser、Desktop Target 或旧 PDF/PPTX 链路。",
            "",
            "## web_inspect",
            "",
            "- `mode=\"structure\"`：提取 DOM/PDF/PPTX/EPUB 结构树。",
            "- `mode=\"detect\"`：检测 overlap/overflow/readability/alignment。",
            "- `mode=\"ai_review\"`：使用截图、结构树与规则检测结果生成 AI 审查报告。注意 Antigravity LS 的 `GetModelResponse` 只接收 `{model,prompt}`，不能直接读取截图像素；需要真正多模态视觉审查时应使用 `modelChain=\"codex\"`；`modelChain=\"claude-code\"` 第一阶段作为低优先级 CLI fallback。",
            "- EPUB 路线第一阶段只提供静态结构；`ai_review` 返回结构说明，不执行截图型视觉审查。",
            "- `background=true` 可用于多页文档后台批量审查，再用 `web_inspect(action=\"check\", taskId=\"...\", waitSeconds=30-45)` 查询。",
            "",
            "## 持久会话与登录态",
            "",
            "- `web_interact` / `web_pipeline` 支持 `ownerId`；未传时按 global 兼容旧调用，访问或关闭已有 session 时按 owner 校验。",
            "- `web_list_sessions` 可列出当前 owner 或全部 owner 的保留会话；`web_close_sessions` 可关闭单个 session 或清理指定 owner 的全部 session。",
            "- `web_pipeline` 支持传入已有 `sessionId`，可在登录后的页面、弹窗 session、Electron renderer 注册 session 上继续执行多步操作；不传 `sessionId` 时仍按旧行为用 `url` 新建页面。",
            "- `web_interact(action=\"snapshot\")` / `web_pipeline(steps=[{action:\"snapshot\"}])` 会一次返回截图文件、视口可见文本和 DOM 摘要，适合动态课程平台、登录后页面和复杂单页应用的快速定位。",
            "- Cookie/localStorage 是全局共享网页登录态，写入时使用文件锁 + 临时文件 rename 合并，不能按对话隔离。",
            "- 登录/UAV 浏览器使用动态空闲 CDP 端口，只清理自有临时 profile/lockfile 对应的 Chrome。",
            "- 主 context 与 bareContext 在 close/closeBrowser 时都会关闭并清理 profile。",
            "",
            "## Human Browser 用户辅助浏览器",
            "",
            "- `web_human_browser_open` 打开可见系统 Chrome，让用户手动完成验证/登录/异常弹窗；这是显式旁路，默认不改变 `web_fetch_page` / `web_interact` / `web_pipeline` 的 URL 主链路。",
            "- `web_human_browser_attach` 可附着已有本机 CDP 端点；`web_human_browser_status` / `web_human_browser_list_pages` 返回页面 URL、title、存活状态、Cookie 数量和最近 challenge 检测结果。",
            "- `web_human_browser_register_page` 把页面注册为普通 `sessionId`，后续继续用 `web_interact(sessionId=...)` 或 `web_pipeline(sessionId=...)`。",
            "- 注册出的 session 是 borrowed/noop；`web_close_sessions` 只移除 alias，不关闭真实 Chrome 页面。",
            "- `web_human_browser_detach` 只断开 MCP/CDP 引用；`web_human_browser_close` 对受管 Chrome 会终止进程并清理临时 profile，对 attach 外部浏览器只释放引用。",
            "- Codex 侧可用 `web_human_browser_open(background=true)` 后再用 `taskId + waitSeconds=30-45` 轮询；用户手动操作发生在工具调用之外。",
            "- 人机验证 detector 现在识别 Cloudflare challenge-platform、Turnstile、`cf-chl-*` 等强信号；强挑战页不会仅因 Cookie 备份存在而跳过 UAV。Cookie 回灌保留为 best-effort，复杂挑战建议复用 Human Browser live session。",
            "",
            "## 当前状态",
            "",
            `- Antigravity LS 可用: ${status.antigravityAvailable ? "yes" : "no"}`,
            `- Codex 模型桥可用: ${status.codexAvailable ? "yes" : "no"}`,
            `- Claude Code CLI 可用: ${status.claudeCodeAvailable ? "yes" : "no"}`,
            `- Claude Code auto fallback: ${status.claudeCodeAutoFallbackEnabled ? "enabled" : "disabled"}`,
            "",
            "## 默认行为",
            "",
            "- `modelChain=\"auto\"` 按 `antigravity -> codex` 尝试；Claude Code CLI 只在 `WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK=1` 时进入自动末跳。",
            "- 显式指定链路失败时，AI Summary 会回退为 compact 模式并明确说明错误摘要。",
        ].join("\n");

        return {
            contents: [
                {
                    uri: "web-fetcher://guide",
                    text: guide,
                    mimeType: "text/markdown",
                },
            ],
        };
    }
);

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
                text: "MCP Web Fetcher v7.0.0 - Resource 机制正常\n\n可用于将抓取结果存储为 resource，AI 按需读取。",
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

// === stdin 断开检测（含诊断增强） ===
process.stdin.on("end", async () => {
    const parentAlive = isParentAlive();
    logStdinEvent(`stdin END — 父 LS ${parentAlive ? "仍存活（LS 内部重置?）" : "已死亡"}`);
    // 等 3 秒做诊断：区分 LS 真死 vs LS 抖动
    await new Promise(r => setTimeout(r, 3000));
    const parentStillAlive = isParentAlive();
    logStdinEvent(`stdin END 等待3s后 — 父 LS ${parentStillAlive ? "仍存活" : "已死亡"}，退出`);
    await cleanup();
    process.exit(0);
});

process.stdin.on("close", async () => {
    const parentAlive = isParentAlive();
    logStdinEvent(`stdin CLOSE — 父 LS ${parentAlive ? "仍存活" : "已死亡"}`);
    await cleanup();
    process.exit(0);
});

process.stdin.on("error", async (err) => {
    logStdinEvent(`stdin ERROR: ${err.message} — 父 LS ${isParentAlive() ? "仍存活" : "已死亡"}`);
    await cleanup();
    process.exit(0);
});

// === 心跳检测：父 LS 进程存活检测（连续 3 次失败容错）+ 浏览器空闲释放 ===
let heartbeatIntervalMs = 30000;
let heartbeatTimer = setInterval(heartbeatCheck, heartbeatIntervalMs);
heartbeatTimer.unref();
let enableDuplicateRetirement = false;
const DUPLICATE_RETIRE_IDLE_MS = 2 * 60 * 1000;

async function heartbeatCheck(): Promise<void> {
    const status = checkParentAliveWithTolerance();
    if (status === "dead") {
        logStdinEvent(`父 LS (PID=${process.ppid}) 连续3次检测失败，确认死亡，MCP 退出`);
        console.error(`[web-fetcher] 父 LS (PID=${process.ppid}) 连续3次检测失败，自动退出`);
        await cleanup();
        process.exit(0);
    } else if (status === "degraded") {
        // 单次失败，切换快速检测模式（5s 间隔，加速确认）
        if (heartbeatIntervalMs !== 5000) {
            heartbeatIntervalMs = 5000;
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(heartbeatCheck, 5000);
            heartbeatTimer.unref();
            logStdinEvent(`ppid 检测失败，切换快速检测模式 (5s)`);
            console.error(`[web-fetcher] ppid 检测失败，切换快速检测模式 (5s)`);
        }
    } else if (heartbeatIntervalMs !== 30000) {
        // 恢复正常间隔
        heartbeatIntervalMs = 30000;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(heartbeatCheck, 30000);
        heartbeatTimer.unref();
        logStdinEvent(`ppid 检测恢复正常，切回 30s 间隔`);
        console.error(`[web-fetcher] ppid 检测恢复正常，切回 30s 间隔`);
    }

    if (enableDuplicateRetirement && getIdleTime() > DUPLICATE_RETIRE_IDLE_MS) {
        const hasNewer = await hasNewerSiblingInstance();
        if (hasNewer) {
            logStdinEvent("检测到同父进程下更新的 web-fetcher 实例，当前实例空闲超时，主动让位退出");
            console.error("[web-fetcher] 检测到更新实例，当前实例空闲超时，主动让位退出");
            await cleanup();
            process.exit(0);
        }
    }

    // 浏览器空闲释放：20 分钟无工具调用 → 关闭 Chromium 释放内存
    const idle = getIdleTime();
    if (idle > HEARTBEAT_BROWSER_TIMEOUT) {
        console.error(`[web-fetcher] ${Math.round(idle / 60000)} 分钟无活动，关闭浏览器释放内存`);
        await browserManager.closeBrowser();
    }
}

// 启动 stdio 传输
async function main(): Promise<void> {
    console.error(`[web-fetcher] MCP Server v7.0.0 启动中... (ppid=${process.ppid})`);
    logStdinEvent("STARTED");

    // 清理遗留的临时目录（防止意外中断导致堆积）
    cleanStaleTempDirs();

    // v4.0: 清理过期临时文件 + 检测转换工具
    const { cleanOldTempFiles, ensureTempDirs } = await import('./temp-store.js');
    ensureTempDirs();
    cleanOldTempFiles();

    const { detectConversionTools } = await import('./converter.js');
    await detectConversionTools();

    // AI Summary 三链路状态预热（非阻塞，不影响其他功能）
    Promise.all([isLsAvailable(), getModelBridgeStatus()]).then(([lsAvailable, bridgeStatus]) => {
        const status = getLsStatus();
        if (lsAvailable) {
            console.error(`[web-fetcher] Antigravity LS 已连接 (PID: ${status.pid}, Port: ${status.port})`);
        } else {
            console.error("[web-fetcher] Antigravity LS 未发现");
        }

        console.error(
            `[web-fetcher] AI Summary 模型链路状态: antigravity=${bridgeStatus.antigravityAvailable ? "ready" : "down"}, codex=${bridgeStatus.codexAvailable ? "ready" : "down"}, claude-code=${bridgeStatus.claudeCodeAvailable ? "ready" : "down"} (autoFallback=${bridgeStatus.claudeCodeAutoFallbackEnabled ? "on" : "off"})`
        );
    }).catch(() => {
        console.error("[web-fetcher] AI Summary 链路状态检测失败");
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[web-fetcher] MCP Server v7.0.0 已启动，绑定父 LS PID=${process.ppid}`);
    logStdinEvent(`BOUND to parent LS PID=${process.ppid}`);

    // === 非 LS 环境兜底超时 ===
    const isLS = await isAntigravityLS();
    if (isLS) {
        console.error(`[web-fetcher] 检测到 Antigravity LS 环境，纯 ppid 管理`);
    } else {
        console.error(`[web-fetcher] 非 Antigravity LS 环境，启用 1 小时空闲兜底`);
        logStdinEvent(`非 LS 环境，启用 1 小时空闲超时兜底`);
        enableDuplicateRetirement = process.env.WEB_FETCHER_ENABLE_DUPLICATE_RETIREMENT === "1";
        const idleGuard = setInterval(async () => {
            if (getIdleTime() > 3600000) { // 1 小时
                logStdinEvent("非 LS 环境空闲超过 1 小时，兜底退出");
                console.error("[web-fetcher] 非 LS 环境空闲超过 1 小时，兜底退出");
                await cleanup();
                process.exit(0);
            }
        }, 60000); // 每分钟检查一次
        idleGuard.unref();
    }
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
    clearInterval(heartbeatTimer);
    // v4.0: 关闭临时 HTTP 服务器
    try {
        const { stopAllServers } = await import('./local-server.js');
        stopAllServers();
    } catch { /* ignore */ }
    await sessionManager.closeAll();
    await desktopManager.closeAll();
    await humanBrowserManager.closeAll();
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
