import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import {
    findChromePath, launchSystemChrome, connectCDP,
    saveCookiesToBackup, saveLocalStorageToBackup, cleanupTempProfile, waitForChromeClose
} from "../chrome-helper.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";

const LoginBrowserInputSchema = z.object({
    startUrl: z
        .string()
        .url()
        .optional()
        .describe("可选，启动浏览器后首先打开的 URL（如 'https://www.zhihu.com/signin'）"),
    background: z
        .boolean()
        .optional()
        .describe("Codex 侧推荐设为 true：立即返回 taskId，登录窗口在后台等待用户关闭并导出 Cookie"),
    taskId: z
        .string()
        .optional()
        .describe("查询后台登录任务的 taskId"),
    waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe("查询后台任务时等待秒数，任务完成时提前返回"),
});

type LoginBrowserInput = z.infer<typeof LoginBrowserInputSchema>;

async function runLoginBrowser(startUrl: string): Promise<string> {
    // 检查系统 Chrome
    if (!findChromePath()) {
        throw new Error("未找到系统 Chrome 浏览器。请确保已安装 Google Chrome。");
    }

    // 启动系统 Chrome（动态空闲 CDP 端口）
    const { process: chromeProcess, tempProfile, cdpPort } = await launchSystemChrome({
        startUrl,
        profilePrefix: 'mcp-chrome-login',
    });

    // 等待 Chrome 启动完成
    await new Promise(r => setTimeout(r, 3000));

    // 通过 CDP 连接到 Chrome，定期备份 Cookie
    let lastCookies: any[] = [];
    let cdpBrowser: any = null;

    try {
        cdpBrowser = await connectCDP(cdpPort);
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
                } catch {
                    // Chrome 可能已关闭
                }
            }, 10000);

            // 等待 Chrome 进程退出
            await waitForChromeClose(chromeProcess);
            clearInterval(interval);

            // 尝试最后一次导出（可能已关闭）
            try {
                lastCookies = await ctx.cookies();

                // v6.4: 同时导出 localStorage
                const pages = ctx.pages();
                for (const page of pages) {
                    try {
                        const url = page.url();
                        if (!url || url === 'about:blank') continue;
                        const domain = new URL(url).hostname;
                        const lsData = await page.evaluate(() => {
                            const result: Record<string, string> = {};
                            for (let i = 0; i < localStorage.length; i++) {
                                const key = localStorage.key(i);
                                if (key) result[key] = localStorage.getItem(key) || '';
                            }
                            return result;
                        });
                        if (Object.keys(lsData).length > 0) {
                            saveLocalStorageToBackup(domain, lsData);
                        }
                    } catch { /* 页面可能已关闭 */ }
                }
            } catch { /* Chrome 已关闭 */ }
        }
    } catch (cdpErr) {
        console.error("[web-fetcher] CDP 连接失败，将等待 Chrome 退出后从文件导出:", cdpErr);
        await waitForChromeClose(chromeProcess);
    }

    // 断开 CDP 连接
    try {
        if (cdpBrowser) await cdpBrowser.close();
    } catch { /* 忽略 */ }

    console.error(`[web-fetcher] Chrome 已关闭，最终 Cookie: ${lastCookies.length} 个`);

    // 合并 Cookie 到备份文件
    let mergedCount = 0;
    if (lastCookies.length > 0) {
        mergedCount = saveCookiesToBackup(lastCookies);
        console.error(`[web-fetcher] Cookie 已合并: 新 ${lastCookies.length} → 总 ${mergedCount} 个`);
    }

    // 清理临时 profile
    cleanupTempProfile(tempProfile);

    const exportMsg = lastCookies.length > 0
        ? `🔒 已导出 ${lastCookies.length} 个 Cookie，合并后总计 ${mergedCount} 个。`
        : `⚠️ 未捕获到新 Cookie（CDP 连接可能未成功或浏览器关闭太快）。已有备份不受影响。`;

    return `✅ 登录完成！浏览器已关闭。\n${exportMsg}\n服务重启后会自动恢复，不需要重新登录。`;
}

export function registerLoginBrowser(server: McpServer): void {
    server.registerTool(
        "web_login_browser",
        {
            title: "打开浏览器登录",
            description: `打开浏览器窗口让用户手动登录网站。
使用系统 Chrome（完全原生，不受 Playwright 影响），确保所有网站都能正常加载。
登录后的 Cookie 会自动备份，服务重启后自动恢复。

⚠️ 调用此工具后，MCP Server 会暂时阻塞，直到用户关闭浏览器窗口。
Codex 侧建议传 background=true，先返回 taskId，再用 taskId + waitSeconds 轮询，避免手动登录超过同步 MCP 调用窗口。
请提醒用户：登录完成后关闭浏览器窗口即可。

参数:
  - startUrl (string, 可选): 启动后打开的 URL
  - background (boolean, 可选): 后台登录模式，立即返回 taskId
  - taskId (string, 可选): 查询后台登录任务
  - waitSeconds (number, 可选): 查询后台任务时等待秒数

返回: 登录操作完成的确认信息`,
            inputSchema: {
                startUrl: LoginBrowserInputSchema.shape.startUrl,
                background: LoginBrowserInputSchema.shape.background,
                taskId: LoginBrowserInputSchema.shape.taskId,
                waitSeconds: LoginBrowserInputSchema.shape.waitSeconds,
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: LoginBrowserInput) => {
            touchActivity();
            const startUrl = params.startUrl || "about:blank";
            if (params.taskId) {
                const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
                return {
                    content: [{ type: "text" as const, text: formatBackgroundTask(task) }],
                };
            }
            try {
                if (params.background) {
                    const task = startBackgroundTask("web-login", async () => runLoginBrowser(startUrl));
                    return {
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 登录浏览器已在后台打开",
                                `🆔 taskId: ${task.id}`,
                                "请在弹出的 Chrome 窗口完成登录，完成后关闭该窗口。",
                                "随后调用 web_login_browser(taskId=\"...\", waitSeconds=30-45) 查询 Cookie 导出结果。",
                            ].join("\n"),
                        }],
                    };
                }
                return {
                    content: [{
                        type: "text" as const,
                        text: await runLoginBrowser(startUrl),
                    }],
                };
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `启动登录浏览器失败: ${message}`,
                    }],
                };
            }
        }
    );
}
