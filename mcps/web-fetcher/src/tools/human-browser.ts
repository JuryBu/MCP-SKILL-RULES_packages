import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendTiming } from "../constants.js";
import { touchActivity } from "../lifecycle.js";
import { humanBrowserManager } from "../human-browser/manager.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";

const OwnerSchema = z.string().optional().describe("持久资源所有者标识；Antigravity/Codex 共享 MCP 后端时建议显式传入");

const HumanBrowserOpenInputSchema = z.object({
    startUrl: z.string().optional().describe("打开真实 Chrome 后进入的 URL；默认 about:blank"),
    ownerId: OwnerSchema,
    waitMs: z.number().int().min(500).max(15000).optional().describe("等待 CDP 端点就绪的毫秒数，默认 2500"),
    background: z.boolean().optional().describe("Codex 侧可设为 true：后台启动 Chrome 并返回 taskId"),
    taskId: z.string().optional().describe("查询后台 open 任务的 taskId"),
    waitSeconds: z.number().int().min(0).max(300).optional().describe("查询后台任务时等待秒数"),
});

const HumanBrowserAttachInputSchema = z.object({
    endpoint: z.string().optional().describe("已有 Chrome/CDP endpoint，例如 http://127.0.0.1:9222"),
    port: z.number().int().min(1).max(65535).optional().describe("本机 CDP 端口；未传 endpoint 时使用 http://127.0.0.1:{port}"),
    ownerId: OwnerSchema,
});

const HumanBrowserSessionInputSchema = z.object({
    humanSessionId: z.string().min(1).describe("web_human_browser_open 或 web_human_browser_attach 返回的 humanSessionId"),
    ownerId: OwnerSchema,
});

const HumanBrowserRegisterInputSchema = HumanBrowserSessionInputSchema.extend({
    pageId: z.string().optional().describe("web_human_browser_list_pages 返回的 pageId；未传时选择第一个非 about:blank 页面"),
});

function jsonText(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function errorResult(message: string) {
    return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerHumanBrowserTools(server: McpServer): void {
    server.registerTool(
        "web_human_browser_open",
        {
            title: "打开人工辅助浏览器",
            description: `打开一个可见系统 Chrome，供用户手动完成登录、人机验证或异常弹窗处理。

这是 Plan 7 的显式旁路能力，默认不会影响 web_fetch_page / web_interact / web_pipeline 的 URL 主链路。
返回 humanSessionId；后续可 list/register，把页面注册成普通 sessionId 后继续用 web_interact 操作。`,
            inputSchema: {
                startUrl: HumanBrowserOpenInputSchema.shape.startUrl,
                ownerId: HumanBrowserOpenInputSchema.shape.ownerId,
                waitMs: HumanBrowserOpenInputSchema.shape.waitMs,
                background: HumanBrowserOpenInputSchema.shape.background,
                taskId: HumanBrowserOpenInputSchema.shape.taskId,
                waitSeconds: HumanBrowserOpenInputSchema.shape.waitSeconds,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (params: z.infer<typeof HumanBrowserOpenInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                if (params.taskId) {
                    const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
                    return appendTiming({ content: [{ type: "text" as const, text: formatBackgroundTask(task) }] }, start);
                }
                if (params.background) {
                    const task = startBackgroundTask(
                        "human-browser-open",
                        async () => jsonText(await humanBrowserManager.open(params)),
                        { maxRunMs: Math.max(30_000, (params.waitMs ?? 2500) + 30_000) },
                    );
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 人工辅助浏览器正在后台启动",
                                `🆔 taskId: ${task.id}`,
                                "随后调用 web_human_browser_open(taskId=\"...\", waitSeconds=30-45) 查询 humanSessionId。",
                            ].join("\n"),
                        }],
                    }, start);
                }
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await humanBrowserManager.open(params)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_attach",
        {
            title: "附着人工辅助浏览器 CDP",
            description: "附着到已有 Chrome/Chromium CDP 端点，作为 borrowed live session 使用；关闭 human session 时不会主动杀掉外部浏览器。",
            inputSchema: {
                endpoint: HumanBrowserAttachInputSchema.shape.endpoint,
                port: HumanBrowserAttachInputSchema.shape.port,
                ownerId: HumanBrowserAttachInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (params: z.infer<typeof HumanBrowserAttachInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await humanBrowserManager.attach(params)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_status",
        {
            title: "查询人工辅助浏览器状态",
            description: "查询 human browser session 的存活状态、页面 URL/title、Cookie 数量和最近 challenge 检测结果。",
            inputSchema: {
                humanSessionId: HumanBrowserSessionInputSchema.shape.humanSessionId,
                ownerId: HumanBrowserSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof HumanBrowserSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await humanBrowserManager.describe(params.humanSessionId, params.ownerId)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_list_pages",
        {
            title: "列出人工辅助浏览器页面",
            description: "列出 human browser session 中当前可注册/可操作的 CDP 页面。",
            inputSchema: {
                humanSessionId: HumanBrowserSessionInputSchema.shape.humanSessionId,
                ownerId: HumanBrowserSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof HumanBrowserSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await humanBrowserManager.describe(params.humanSessionId, params.ownerId)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_register_page",
        {
            title: "注册人工辅助浏览器页面",
            description: "把 human browser session 的某个 CDP page 注册为普通 web sessionId，之后可用 web_interact / web_pipeline(sessionId=...) 继续操作。",
            inputSchema: {
                humanSessionId: HumanBrowserRegisterInputSchema.shape.humanSessionId,
                pageId: HumanBrowserRegisterInputSchema.shape.pageId,
                ownerId: HumanBrowserRegisterInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof HumanBrowserRegisterInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({
                    content: [{ type: "text" as const, text: jsonText(await humanBrowserManager.registerPage(params.humanSessionId, params.pageId, params.ownerId)) }],
                }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_detach",
        {
            title: "断开人工辅助浏览器会话",
            description: "仅断开 MCP/CDP 引用并移除 bridged session，不主动关闭真实 Chrome 或清理 managed profile。",
            inputSchema: {
                humanSessionId: HumanBrowserSessionInputSchema.shape.humanSessionId,
                ownerId: HumanBrowserSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof HumanBrowserSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText({ detached: await humanBrowserManager.detach(params.humanSessionId, params.ownerId) }) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "web_human_browser_close",
        {
            title: "关闭人工辅助浏览器会话",
            description: "关闭 human browser session。managed Chrome 会被终止并清理临时 profile；attach 外部浏览器只释放 MCP/CDP 引用。",
            inputSchema: {
                humanSessionId: HumanBrowserSessionInputSchema.shape.humanSessionId,
                ownerId: HumanBrowserSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof HumanBrowserSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText({ closed: await humanBrowserManager.close(params.humanSessionId, params.ownerId) }) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}
