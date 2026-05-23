import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { desktopManager } from "../desktop/manager.js";
import { touchActivity } from "../lifecycle.js";
import { appendTiming } from "../constants.js";

const OwnerSchema = z.string().optional().describe("持久资源所有者标识；Antigravity/Codex 共享 MCP 后端时建议显式传入");

const DesktopLaunchInputSchema = z.object({
    kind: z.enum(["electron", "native"]).describe("目标类型：electron=Electron 应用；native=普通 Windows exe"),
    executablePath: z.string().min(1).describe("要启动的 Electron 或 exe 可执行文件路径"),
    args: z.array(z.string()).optional().describe("启动参数"),
    cwd: z.string().optional().describe("工作目录"),
    env: z.record(z.string()).optional().describe("额外环境变量"),
    ownerId: OwnerSchema,
    timeout: z.number().int().min(500).max(120000).optional().describe("启动/等待窗口超时毫秒数"),
});

const DesktopConnectCdpInputSchema = z.object({
    endpoint: z.string().optional().describe("CDP HTTP endpoint，例如 http://127.0.0.1:9222"),
    port: z.number().int().min(1).max(65535).optional().describe("本机 CDP 端口；未传 endpoint 时使用 http://127.0.0.1:{port}"),
    ownerId: OwnerSchema,
});

const DesktopSessionInputSchema = z.object({
    desktopSessionId: z.string().min(1).describe("desktop_launch 或 desktop_connect_cdp 返回的桌面会话 ID"),
    ownerId: OwnerSchema,
});

const DesktopWindowInputSchema = DesktopSessionInputSchema.extend({
    windowId: z.string().min(1).describe("desktop_list_windows 返回的窗口 ID"),
});

const DesktopInspectInputSchema = DesktopWindowInputSchema.extend({
    mode: z.enum(["structure", "accessibility", "native", "visual", "all"])
        .optional()
        .default("structure")
        .describe("检查模式：renderer/CDP 支持 structure/accessibility/all；native 支持 native/visual/all"),
});

const DesktopScreenshotInputSchema = DesktopWindowInputSchema.extend({
    fullPage: z.boolean().optional().default(false).describe("renderer/CDP 目标是否截完整页面"),
});

const DesktopInteractInputSchema = DesktopWindowInputSchema.extend({
    action: z.enum(["click", "type", "press", "scroll", "wait", "evaluate"]).describe("交互动作"),
    selector: z.string().optional().describe("renderer/CDP CSS 选择器"),
    value: z.string().optional().describe("输入文本、快捷键或 evaluate 代码"),
    x: z.number().optional().describe("屏幕/窗口坐标 x；native fallback 或 renderer 坐标点击使用"),
    y: z.number().optional().describe("屏幕/窗口坐标 y；native fallback 或 renderer 坐标点击使用"),
    name: z.string().optional().describe("native UI Automation 控件 Name 模糊匹配"),
    automationId: z.string().optional().describe("native UI Automation AutomationId 精确匹配"),
    timeout: z.number().int().min(500).max(120000).optional().describe("等待超时毫秒数"),
});

function jsonText(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function errorResult(message: string) {
    return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerDesktopTools(server: McpServer): void {
    server.registerTool(
        "desktop_launch",
        {
            title: "启动桌面应用",
            description: `启动 Electron 或普通 Windows exe，并返回 desktopSessionId 与可操作窗口列表。

这是 web-fetcher 的桌面扩展入口，不改变现有 web_fetch_* 工具语义。Electron renderer 会作为 Playwright Page 管理；普通 exe 走 Windows UI Automation / 视觉 fallback。`,
            inputSchema: {
                kind: DesktopLaunchInputSchema.shape.kind,
                executablePath: DesktopLaunchInputSchema.shape.executablePath,
                args: DesktopLaunchInputSchema.shape.args,
                cwd: DesktopLaunchInputSchema.shape.cwd,
                env: DesktopLaunchInputSchema.shape.env,
                ownerId: DesktopLaunchInputSchema.shape.ownerId,
                timeout: DesktopLaunchInputSchema.shape.timeout,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopLaunchInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await desktopManager.launch(params)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_connect_cdp",
        {
            title: "连接 CDP 桌面目标",
            description: "连接已开启 Chrome DevTools Protocol 远程调试端口的 Electron/Chromium/CEF 应用，返回 desktopSessionId 与窗口列表。",
            inputSchema: {
                endpoint: DesktopConnectCdpInputSchema.shape.endpoint,
                port: DesktopConnectCdpInputSchema.shape.port,
                ownerId: DesktopConnectCdpInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopConnectCdpInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await desktopManager.connectCdp(params)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_list_windows",
        {
            title: "列出桌面会话窗口",
            description: "列出 desktop session 下当前可操作的 renderer/CDP/native 窗口。",
            inputSchema: {
                desktopSessionId: DesktopSessionInputSchema.shape.desktopSessionId,
                ownerId: DesktopSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await desktopManager.listWindows(params.desktopSessionId, params.ownerId)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_register_window",
        {
            title: "注册桌面窗口为网页会话",
            description: "把 renderer/CDP 窗口注册成现有 web_interact 可复用的 sessionId。native 窗口不能注册为网页会话。",
            inputSchema: {
                desktopSessionId: DesktopWindowInputSchema.shape.desktopSessionId,
                windowId: DesktopWindowInputSchema.shape.windowId,
                ownerId: DesktopWindowInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopWindowInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await desktopManager.registerWindow(params.desktopSessionId, params.windowId, params.ownerId)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_inspect",
        {
            title: "检查桌面窗口结构",
            description: "检查 renderer DOM、CDP Accessibility/DOMSnapshot、Windows UI Automation 控件树或截图式 visual fallback。",
            inputSchema: {
                desktopSessionId: DesktopInspectInputSchema.shape.desktopSessionId,
                windowId: DesktopInspectInputSchema.shape.windowId,
                ownerId: DesktopInspectInputSchema.shape.ownerId,
                mode: DesktopInspectInputSchema.shape.mode,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopInspectInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({
                    content: [{ type: "text" as const, text: jsonText(await desktopManager.inspect(params.desktopSessionId, params.windowId, params.mode ?? "structure", params.ownerId)) }],
                }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_screenshot",
        {
            title: "桌面窗口截图",
            description: "截取 renderer/CDP 页面或 native 窗口截图，返回本地图片路径。",
            inputSchema: {
                desktopSessionId: DesktopScreenshotInputSchema.shape.desktopSessionId,
                windowId: DesktopScreenshotInputSchema.shape.windowId,
                ownerId: DesktopScreenshotInputSchema.shape.ownerId,
                fullPage: DesktopScreenshotInputSchema.shape.fullPage,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopScreenshotInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({
                    content: [{ type: "text" as const, text: jsonText(await desktopManager.screenshot(params.desktopSessionId, params.windowId, params.ownerId, params.fullPage ?? false)) }],
                }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_interact",
        {
            title: "桌面窗口交互",
            description: "对 renderer/CDP/native 窗口执行点击、输入、快捷键、等待、滚动或 renderer evaluate。",
            inputSchema: {
                desktopSessionId: DesktopInteractInputSchema.shape.desktopSessionId,
                windowId: DesktopInteractInputSchema.shape.windowId,
                ownerId: DesktopInteractInputSchema.shape.ownerId,
                action: DesktopInteractInputSchema.shape.action,
                selector: DesktopInteractInputSchema.shape.selector,
                value: DesktopInteractInputSchema.shape.value,
                x: DesktopInteractInputSchema.shape.x,
                y: DesktopInteractInputSchema.shape.y,
                name: DesktopInteractInputSchema.shape.name,
                automationId: DesktopInteractInputSchema.shape.automationId,
                timeout: DesktopInteractInputSchema.shape.timeout,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopInteractInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText(await desktopManager.interact(params)) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    server.registerTool(
        "desktop_close",
        {
            title: "关闭桌面会话",
            description: "关闭 desktop session，清理 Electron/CDP/native 资源与已注册的 web session。",
            inputSchema: {
                desktopSessionId: DesktopSessionInputSchema.shape.desktopSessionId,
                ownerId: DesktopSessionInputSchema.shape.ownerId,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (params: z.infer<typeof DesktopSessionInputSchema>) => {
            touchActivity();
            const start = Date.now();
            try {
                return appendTiming({ content: [{ type: "text" as const, text: jsonText({ closed: await desktopManager.close(params.desktopSessionId, params.ownerId) }) }] }, start);
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}
