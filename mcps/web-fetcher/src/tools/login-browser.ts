import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import { runLoginBrowserSession } from "../login-session.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";

const MANUAL_LOGIN_MAX_RUN_MS = 600_000;
const LOGIN_CLEANUP_ALLOWANCE_MS = 120_000;

const LoginBrowserInputSchema = z.object({
    startUrl: z.string().url().optional().describe("可选，启动后打开的网址"),
    background: z.boolean().optional().describe("推荐 true：返回 taskId，人工登录不占用同步 MCP 调用"),
    taskId: z.string().optional().describe("查询已有后台登录任务"),
    waitSeconds: z.number().int().min(0).max(600).optional().describe("轮询等待秒数，建议 30–45 秒"),
});

type LoginBrowserInput = z.infer<typeof LoginBrowserInputSchema>;

async function runLoginBrowser(startUrl: string, runSession = runLoginBrowserSession): Promise<string> {
    const result = await runSession(startUrl);
    const snapshot = result.snapshot;
    const saved = snapshot.savedCookieCount > 0 || snapshot.localStorageDomains.length > 0;
    const warnings = [...snapshot.errors];
    if (saved) {
        try {
            const { browserManager } = await import("../browser.js");
            await browserManager.refreshAuthState();
        } catch {
            warnings.push("共享浏览器登录态刷新失败，备份仍保留；后续访问需重新检查登录状态");
        }
    }
    return [
        result.timedOut ? "人工操作已达到 600 秒，已先尝试保存，再关闭本次自有浏览器。" : "本次人工浏览器会话已结束。",
        result.browserClosed ? "本次浏览器已关闭。" : "⚠️ 浏览器退出尚未确认，已保留专用 profile。",
        saved
            ? `已确认写入 ${snapshot.savedCookieCount} 个 Cookie，localStorage ${snapshot.localStorageDomains.length} 个来源；最近保存 ${snapshot.savedAt ?? "未知"}。这只证明状态已保存，不代表网站已验证登录。`
            : "⚠️ 尚未确认保存新的 Cookie/localStorage，不能宣称登录成功；已有备份不受影响。",
        ...warnings.map(warning => `⚠️ ${warning}`),
        ...(result.recoveryProfile ? [`恢复来源已保留：${result.recoveryProfile}。不要删除此目录或反复扫码，应先排查导出结果。`] : []),
    ].join("\n");
}

export function registerLoginBrowser(server: McpServer, options?: { runSession?: typeof runLoginBrowserSession }): void {
    server.registerTool("web_login_browser", {
        title: "打开浏览器登录",
        description: `打开专用系统 Chrome 窗口供用户手动登录，周期性保存 Cookie 与 localStorage。
同步与后台模式都给予最多 600 秒人工操作时间，截止后先保存再关闭；手动关闭后会有界恢复本次专用 profile，失败则保留恢复来源。
建议 background=true，取得 taskId 后每次 waitSeconds=30–45 轮询，不必让同步调用等待几分钟。
返回区分「状态写入成功」和「网站登录已验证」，不保证已有 Cookie 就是有效登录；不要求用户为导出额外等待两秒。
后台任务可能在人工操作结束后短暂继续保存和清理，最终返回结果及警告。`,
        inputSchema: LoginBrowserInputSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (params: LoginBrowserInput) => {
        touchActivity();
        if (params.taskId) {
            const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
            return { content: [{ type: "text" as const, text: formatBackgroundTask(task) }] };
        }
        try {
            if (params.background) {
                const task = startBackgroundTask("web-login", () => runLoginBrowser(params.startUrl || "about:blank", options?.runSession), {
                    maxRunMs: MANUAL_LOGIN_MAX_RUN_MS + LOGIN_CLEANUP_ALLOWANCE_MS,
                    timeoutMessage: "登录保存/清理超过受控期限，结果未确认；请保留专用 profile 排查，不要据此重新扫码。",
                });
                return { content: [{ type: "text" as const, text: [
                    "登录浏览器任务已启动。请在本次 Chrome 窗口操作，完成后可以关闭窗口。",
                    `taskId: ${task.id}`,
                    "人工操作最多 600 秒，之后执行保存和清理；请用同一 taskId、waitSeconds=30–45 查询最终结果。",
                ].join("\n") }] };
            }
            return { content: [{ type: "text" as const, text: await runLoginBrowser(params.startUrl || "about:blank", options?.runSession) }] };
        } catch {
            return { isError: true, content: [{ type: "text" as const, text: "启动或完成登录浏览器失败，请检查系统 Chrome 与本次专用 profile；未确认新的登录状态已保存。" }] };
        }
    });
}
