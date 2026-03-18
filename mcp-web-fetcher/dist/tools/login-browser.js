import { z } from "zod";
// browserManager 不在此工具直接使用（用系统 Chrome + CDP）
import { touchActivity } from "../lifecycle.js";
import { COOKIES_BACKUP_FILE } from "../constants.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
const LoginBrowserInputSchema = z.object({
    startUrl: z
        .string()
        .url()
        .optional()
        .describe("可选，启动浏览器后首先打开的 URL（如 'https://www.zhihu.com/signin'）"),
});
// 远程调试端口
const CDP_PORT = 19222;
/**
 * 查找系统 Chrome 路径
 */
function findChromePath() {
    const possiblePaths = [
        process.env["PROGRAMFILES"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["LOCALAPPDATA"] + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of possiblePaths) {
        if (p && fs.existsSync(p))
            return p;
    }
    return null;
}
export function registerLoginBrowser(server) {
    server.registerTool("web_login_browser", {
        title: "打开浏览器登录",
        description: `打开浏览器窗口让用户手动登录网站。
使用系统 Chrome（完全原生，不受 Playwright 影响），确保所有网站都能正常加载。
登录后的 Cookie 会自动备份，服务重启后自动恢复。

⚠️ 调用此工具后，MCP Server 会暂时阻塞，直到用户关闭浏览器窗口。
请提醒用户：登录完成后关闭浏览器窗口即可。

参数:
  - startUrl (string, 可选): 启动后打开的 URL

返回: 登录操作完成的确认信息`,
        inputSchema: {
            startUrl: LoginBrowserInputSchema.shape.startUrl,
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        touchActivity();
        try {
            const startUrl = params.startUrl || "about:blank";
            // 查找系统 Chrome
            const chromePath = findChromePath();
            if (!chromePath) {
                return {
                    isError: true,
                    content: [{
                            type: "text",
                            text: "未找到系统 Chrome 浏览器。请确保已安装 Google Chrome。",
                        }],
                };
            }
            // 使用全新的临时 profile 目录
            const tempProfile = path.join(os.tmpdir(), `mcp-chrome-login-${Date.now()}`);
            fs.mkdirSync(tempProfile, { recursive: true });
            console.error(`[web-fetcher] 使用系统 Chrome 启动: ${chromePath}`);
            console.error(`[web-fetcher] 临时 Profile: ${tempProfile}`);
            console.error(`[web-fetcher] CDP 端口: ${CDP_PORT}`);
            // 启动 Chrome，带远程调试端口（用于导出 Cookie）
            const chromeProcess = spawn(chromePath, [
                `--user-data-dir=${tempProfile}`,
                `--remote-debugging-port=${CDP_PORT}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
                startUrl,
            ], {
                detached: false,
                stdio: "ignore",
            });
            console.error(`[web-fetcher] Chrome 已启动 (PID: ${chromeProcess.pid})`);
            // 等待 Chrome 启动完成
            await new Promise(r => setTimeout(r, 3000));
            // 通过 CDP 连接到 Chrome，定期备份 Cookie
            let lastCookies = [];
            let cdpBrowser = null;
            try {
                const { chromium } = await import("playwright");
                cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
                console.error("[web-fetcher] CDP 连接成功，开始定期保存 Cookie");
                const contexts = cdpBrowser.contexts();
                if (contexts.length > 0) {
                    const ctx = contexts[0];
                    // 定期保存 Cookie（每 10 秒）
                    const interval = setInterval(async () => {
                        try {
                            touchActivity(); // 防止心跳超时杀进程
                            lastCookies = await ctx.cookies();
                            console.error(`[web-fetcher] Cookie 快照: ${lastCookies.length} 个`);
                        }
                        catch {
                            // Chrome 可能已关闭
                        }
                    }, 10000);
                    // 等待 Chrome 进程退出
                    await new Promise((resolve) => {
                        chromeProcess.on("close", () => {
                            clearInterval(interval);
                            resolve();
                        });
                        chromeProcess.on("error", () => {
                            clearInterval(interval);
                            resolve();
                        });
                    });
                    // 尝试最后一次导出（可能已关闭）
                    try {
                        lastCookies = await ctx.cookies();
                    }
                    catch { /* Chrome 已关闭 */ }
                }
            }
            catch (cdpErr) {
                console.error("[web-fetcher] CDP 连接失败，将等待 Chrome 退出后从文件导出:", cdpErr);
                // CDP 连接失败，退回到等待 Chrome 退出
                await new Promise((resolve) => {
                    chromeProcess.on("close", () => resolve());
                    chromeProcess.on("error", () => resolve());
                });
            }
            // 断开 CDP 连接
            try {
                if (cdpBrowser)
                    await cdpBrowser.close();
            }
            catch { /* 忽略 */ }
            console.error(`[web-fetcher] Chrome 已关闭，最终 Cookie: ${lastCookies.length} 个`);
            // 合并 Cookie 到备份文件
            let mergedCount = 0;
            if (lastCookies.length > 0) {
                // 读取现有备份
                let existingCookies = [];
                if (fs.existsSync(COOKIES_BACKUP_FILE)) {
                    try {
                        existingCookies = JSON.parse(fs.readFileSync(COOKIES_BACKUP_FILE, "utf-8"));
                    }
                    catch { /* 忽略 */ }
                }
                // 合并策略：按 domain+name+path 为 key，新的覆盖旧的
                const cookieKey = (c) => `${c.domain}|${c.name}|${c.path || "/"}`;
                const cookieMap = new Map();
                // 先放旧的
                for (const c of existingCookies) {
                    cookieMap.set(cookieKey(c), c);
                }
                // 新的覆盖
                for (const c of lastCookies) {
                    cookieMap.set(cookieKey(c), c);
                }
                const merged = Array.from(cookieMap.values());
                mergedCount = merged.length;
                // 确保备份目录存在（冷启动时可能不存在）
                const backupDir = path.dirname(COOKIES_BACKUP_FILE);
                if (!fs.existsSync(backupDir)) {
                    fs.mkdirSync(backupDir, { recursive: true });
                }
                fs.writeFileSync(COOKIES_BACKUP_FILE, JSON.stringify(merged, null, 2), "utf-8");
                console.error(`[web-fetcher] Cookie 已合并: 新 ${lastCookies.length} + 旧 ${existingCookies.length} → ${mergedCount} 个`);
            }
            // 清理临时 profile
            try {
                fs.rmSync(tempProfile, { recursive: true, force: true });
                console.error("[web-fetcher] 临时 profile 已清理");
            }
            catch { /* 忽略 */ }
            return {
                content: [{
                        type: "text",
                        text: `✅ 登录完成！浏览器已关闭。\n🔒 已导出 ${lastCookies.length} 个 Cookie，合并后总计 ${mergedCount} 个。\n服务重启后会自动恢复，不需要重新登录。`,
                    }],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{
                        type: "text",
                        text: `启动登录浏览器失败: ${message}`,
                    }],
            };
        }
    });
}
//# sourceMappingURL=login-browser.js.map