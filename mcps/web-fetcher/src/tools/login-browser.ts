import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import {
    findChromePath, launchSystemChrome, connectCDP,
    cleanupTempProfile, waitForChromeClose, snapshotBrowserStorage,
    type BrowserStorageSnapshotResult,
} from "../chrome-helper.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";

const MANUAL_LOGIN_MAX_RUN_MS = 600_000;
const STORAGE_SNAPSHOT_INTERVAL_MS = 2000;

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
        .max(600)
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

    // 通过 CDP 连接到 Chrome，定期备份 Cookie + localStorage
    const snapshotState: { last?: BrowserStorageSnapshotResult } = {};
    let cdpBrowser: any = null;

    try {
        cdpBrowser = await connectCDP(cdpPort);
        console.error("[web-fetcher] CDP 连接成功，开始定期保存 Cookie + localStorage");

        const contexts = cdpBrowser.contexts();
        if (contexts.length > 0) {
            const ctx = contexts[0];

            const snapshot = async (reason: string) => {
                try {
                    touchActivity(); // 防止心跳超时杀进程
                    snapshotState.last = await snapshotBrowserStorage(ctx, { reason });
                } catch (error) {
                    console.error(`[web-fetcher] 存储快照失败(${reason}): ${error instanceof Error ? error.message : String(error)}`);
                }
            };

            await snapshot("login-initial");

            // 定期保存 Cookie + localStorage（每 2 秒立即落盘）
            const interval = setInterval(() => {
                void snapshot("login-periodic");
            }, STORAGE_SNAPSHOT_INTERVAL_MS);

            // 等待 Chrome 进程退出
            await waitForChromeClose(chromeProcess);
            clearInterval(interval);

            // 主动关闭后 CDP 可能已不可用；最后一次只作 best-effort，主要依赖周期快照已落盘
            await snapshot("login-final").catch(() => undefined);
        }
    } catch (cdpErr) {
        console.error("[web-fetcher] CDP 连接失败，将等待 Chrome 退出后从文件导出:", cdpErr);
        await waitForChromeClose(chromeProcess);
    }

    // 断开 CDP 连接
    try {
        if (cdpBrowser) await cdpBrowser.close();
    } catch { /* 忽略 */ }

    const cookieCount = snapshotState.last?.cookieCount ?? 0;
    const mergedCount = snapshotState.last?.mergedCookieCount ?? 0;
    const localStorageDomains = snapshotState.last?.localStorageDomains ?? [];
    console.error(`[web-fetcher] Chrome 已关闭，最近快照 Cookie: ${cookieCount} 个，localStorage 域名: ${localStorageDomains.length} 个`);

    // 清理临时 profile
    cleanupTempProfile(tempProfile);

    const exportMsg = cookieCount > 0 || localStorageDomains.length > 0
        ? `🔒 已快照 ${cookieCount} 个 Cookie，合并后总计 ${mergedCount} 个；localStorage ${localStorageDomains.length} 个域名。`
        : `⚠️ 未捕获到新 Cookie/localStorage（CDP 连接可能未成功或浏览器关闭太快）。已有备份不受影响。`;

    return `✅ 登录完成！浏览器已关闭。\n${exportMsg}\n服务重启后会自动恢复，不需要重新登录。`;
}

export function registerLoginBrowser(server: McpServer): void {
    server.registerTool(
        "web_login_browser",
        {
            title: "打开浏览器登录",
            description: `打开浏览器窗口让用户手动登录网站。
使用系统 Chrome（完全原生，不受 Playwright 影响），确保所有网站都能正常加载。
登录后的 Cookie 与 localStorage 会自动周期性备份，服务重启后自动恢复。

⚠️ 调用此工具后，MCP Server 会暂时阻塞，直到用户关闭浏览器窗口。
Codex 侧建议传 background=true，先返回 taskId，再用 taskId + waitSeconds 轮询，避免手动登录超过同步 MCP 调用窗口。
人工操作上限按 600s 设计；请提醒用户：登录完成后等 2 秒再关闭浏览器窗口，确保最新登录态已快照。

参数:
  - startUrl (string, 可选): 启动后打开的 URL
  - background (boolean, 可选): 后台登录模式，立即返回 taskId
  - taskId (string, 可选): 查询后台登录任务
  - waitSeconds (number, 可选): 查询后台任务时等待秒数，最大 600

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
                    const task = startBackgroundTask(
                        "web-login",
                        async () => runLoginBrowser(startUrl),
                        {
                            maxRunMs: MANUAL_LOGIN_MAX_RUN_MS,
                            timeoutMessage: "登录浏览器后台任务超时（600s）。最近一次 Cookie/localStorage 快照已尽量落盘；可重新打开登录浏览器继续。",
                        }
                    );
                    return {
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 登录浏览器已在后台打开",
                                `🆔 taskId: ${task.id}`,
                                "请在弹出的 Chrome 窗口完成登录，完成后等 2 秒再关闭该窗口。",
                                "后台人工操作上限 600s；随后调用 web_login_browser(taskId=\"...\", waitSeconds=30-45) 查询 Cookie/localStorage 导出结果。",
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
