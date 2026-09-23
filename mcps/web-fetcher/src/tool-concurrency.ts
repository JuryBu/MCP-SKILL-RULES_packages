import { z } from "zod";
import { performance } from "node:perf_hooks";
import { sessionManager, type SessionManager } from "./session.js";
import { getRequestContext, OperationGate, RequestAdmissionError, runWithRequestContext, throwIfRequestExpired, withRequestStage } from "./request-context.js";
import { assertPageAccessible, pageAccessResult, PageAccessError } from './page-access.js';

type ToolArguments = Record<string, unknown>;
type ToolHandler = (args: ToolArguments, extra?: any) => any;
export type ToolRequestClass = "normal" | "heavy" | "control" | "poll" | "login";

export interface ToolConcurrencyOptions {
    maxActive?: number;
    maxHeavy?: number;
    maxControl?: number;
    maxPoll?: number;
    maxLogin?: number;
    maxQueue?: number;
    queueTimeoutMs?: number;
    defaultTimeoutMs?: number;
    sessions?: SessionManager;
}

export function classifyToolRequest(name: string, args: ToolArguments = {}): ToolRequestClass {
    if (name === "background_task_cancel" || args.action === "close" || args.action === "cancel") return "control";
    if (typeof args.taskId === "string" && args.taskId) return "poll";
    if (name === "web_login_browser" || name === "web_human_browser_open" || name === "web_human_browser_attach") return "login";
    if (["web_list_sessions", "web_close_sessions", "web_list_cookies", "desktop_list_windows", "desktop_close", "background_task_cancel", "background_task_status", "web_human_browser_status", "web_human_browser_list_pages", "web_human_browser_close", "web_human_browser_detach"].includes(name)) return "control";
    if (args.action === "status" || args.action === "list") return "control";
    if (/screenshot|convert|record_video|fetch_rich/.test(name) || args.action === "screenshot" || args.action === "snapshot") return "heavy";
    if (name === "web_inspect" || name === "desktop_inspect") return "heavy";
    if (name === "web_pipeline" && Array.isArray(args.steps) && args.steps.some(step => step && ["screenshot", "snapshot"].includes(step.action))) return "heavy";
    return "normal";
}

export class ToolConcurrency {
    private readonly normal: OperationGate;
    private readonly heavy: OperationGate;
    private readonly control: OperationGate;
    private readonly poll: OperationGate;
    private readonly login: OperationGate;
    private readonly sessions: SessionManager;

    constructor(private readonly options: ToolConcurrencyOptions = {}) {
        const maxQueue = options.maxQueue ?? 64;
        this.normal = new OperationGate(options.maxActive ?? 6, maxQueue, "tool-operation");
        this.heavy = new OperationGate(options.maxHeavy ?? 2, maxQueue, "image-conversion");
        this.control = new OperationGate(options.maxControl ?? 8, maxQueue, "tool-control");
        this.poll = new OperationGate(options.maxPoll ?? 8, maxQueue, "task-poll");
        this.login = new OperationGate(options.maxLogin ?? 2, 8, "manual-login");
        this.sessions = options.sessions ?? sessionManager;
    }

    getStats() {
        return { normal: this.normal.getStats(), heavy: this.heavy.getStats(), control: this.control.getStats(), poll: this.poll.getStats(), login: this.login.getStats() };
    }

    async run(name: string, args: ToolArguments, handler: ToolHandler, extra?: { signal?: AbortSignal }): Promise<any> {
        const requestClass = classifyToolRequest(name, args);
        const explicitTimeout = typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : undefined;
        const configuredBudget = this.options.defaultTimeoutMs;
        const recordingMs = name === 'web_record_video' ? (typeof args.duration === 'number' ? args.duration : 5) * 1000 : 0;
        const timeoutMs = requestClass === 'login'
            ? Math.max(660_000, explicitTimeout ?? 0)
            : configuredBudget ?? Math.max(120_000, (explicitTimeout ?? 30_000) + recordingMs + 20_000);
        const viewport = args.viewport as { width?: unknown; height?: unknown } | undefined;
        const validViewport = viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
            ? { width: viewport.width, height: viewport.height } : undefined;
        return runWithRequestContext({
            ownerId: typeof args.ownerId === "string" ? args.ownerId : undefined,
            toolName: name,
            intent: `${name}${typeof args.action === "string" ? `.${args.action}` : ""}`,
            signal: extra?.signal,
            timeoutMs,
            viewport: validViewport,
            humanAssistance: args.humanAssistance === 'never' ? 'never' : 'auto',
        }, async () => {
            const context = getRequestContext()!;
            let started = false;
            try {
                const invoke = async () => this.withPermit(requestClass, async () => {
                    throwIfRequestExpired();
                    started = true;
                    const inspectedPage = typeof args.sessionId === 'string' && ['web_interact', 'web_pipeline', 'web_inspect', 'web_fetch_page', 'web_fetch_rich', 'web_fetch_screenshot'].includes(name)
                        ? this.sessions.get(args.sessionId, context.ownerId) : null;
                    if (inspectedPage && !['navigate', 'goto'].includes(String(args.action))) {
                        await assertPageAccessible(inspectedPage, { url: inspectedPage.url(), waitFor: typeof args.waitFor === 'string' ? args.waitFor : undefined });
                    }
                    const result = await withRequestStage("handler", () => Promise.resolve(handler(args, extra)));
                    if (context.pageAccessIssue) return pageAccessResult(context.pageAccessIssue);
                    if (inspectedPage && !inspectedPage.isClosed() && !result?.isError) await assertPageAccessible(inspectedPage, { url: inspectedPage.url() });
                    if (context.signal?.aborted || performance.now() >= context.deadline) {
                        return this.failure(context.signal?.aborted ? "request_cancelled" : "request_deadline_exceeded", true, result);
                    }
                    return result;
                });
                const usePageLock = requestClass !== "control" && requestClass !== "poll" && typeof args.sessionId === "string"
                    && ["web_interact", "web_pipeline", "web_inspect", "desktop_inspect", "desktop_screenshot", "web_fetch_page", "web_fetch_rich", "web_fetch_screenshot"].includes(name);
                const result = await (usePageLock
                    ? this.sessions.withOperation(args.sessionId as string, context.ownerId, invoke, { signal: context.signal, deadline: context.deadline, queueTimeoutMs: this.options.queueTimeoutMs })
                    : invoke());
                return result && typeof result === 'object' ? {
                    ...result,
                    _meta: { ...(result._meta ?? {}), webFetcherTiming: { totalMs: Math.round(performance.now() - context.startedAt), stages: context.timings } },
                } : result;
            } catch (error) {
                if (error instanceof PageAccessError) return pageAccessResult(error.assessment);
                if (context.pageAccessIssue) return pageAccessResult(context.pageAccessIssue);
                if (error instanceof RequestAdmissionError) return this.failure(error.code, started);
                if (context.signal?.aborted || performance.now() >= context.deadline) return this.failure(context.signal?.aborted ? "request_cancelled" : "request_deadline_exceeded", started);
                throw error;
            }
        });
    }

    private async withPermit<Result>(requestClass: ToolRequestClass, handler: () => Promise<Result>): Promise<Result> {
        const context = getRequestContext()!;
        const options = { ownerId: context.ownerId, signal: context.signal, deadline: Math.min(context.deadline, context.startedAt + (this.options.queueTimeoutMs ?? 30_000)), queueTimeoutMs: this.options.queueTimeoutMs };
        const releases: Array<() => void> = [];
        try {
            await withRequestStage("operation_queue", async () => {
                if (requestClass === "heavy") releases.push(await this.heavy.acquire(options));
                const gate = requestClass === "normal" || requestClass === "heavy" ? this.normal : this[requestClass];
                releases.push(await gate.acquire(options));
            });
            return await handler();
        } finally {
            for (const release of releases.reverse()) release();
        }
    }

    private failure(code: string, mayHaveStarted: boolean, result?: any) {
        const context = getRequestContext();
        const diagnostics = { code, mayHaveStarted, outcome: mayHaveStarted ? "unknown" : "not_started", retryable: false, timings: context?.timings ?? [] };
        const explanation = mayHaveStarted
            ? "请求取消或超过总期限；已等待当前动作实际结束后释放操作额度。外部副作用结果未确认（outcome unknown），不要自动重播点击或提交。"
            : "接纳失败，工具动作尚未开始，请先检查会话、队列或取消状态。";
        return {
            ...(result && typeof result === "object" ? result : {}),
            isError: true,
            content: [...(Array.isArray(result?.content) ? result.content : []), { type: "text" as const, text: `${code}: ${explanation}` }],
            _meta: { ...(result?._meta ?? {}), webFetcherConcurrency: diagnostics },
        };
    }
}

const installedServers = new WeakMap<object, ToolConcurrency>();

export function installToolConcurrency(server: { tool?: (...args: any[]) => any; registerTool?: (...args: any[]) => any }, options: ToolConcurrencyOptions = {}): ToolConcurrency {
    const existing = installedServers.get(server);
    if (existing) return existing;
    const controller = new ToolConcurrency(options);
    const addOwner = (schema: any, name: string) => {
        const ownerId = z.string().optional().describe("调用方标识，未传兼容 global；已有会话必须使用创建时的 ownerId");
        const humanAssistance = z.enum(['auto', 'never']).optional().describe('遇到强人机验证：auto在明确ownerId下创建后台人工任务并短返回；never只报告受阻，不弹窗。人工窗口保留600秒，用web_human_verification查询/关闭。');
        const supportsAssistance = /^web_(fetch_|interact$|inspect$|pipeline$|extract_|record_video$|batch_screenshot$)/.test(name);
        const additions = { ownerId, ...(supportsAssistance ? { humanAssistance } : {}) };
        if (schema instanceof z.ZodObject) return schema.extend({ ...additions, ...schema.shape });
        return { ...additions, ...(schema ?? {}) };
    };
    if (server.registerTool) {
        const original = server.registerTool.bind(server);
        server.registerTool = (name: string, config: any, handler: ToolHandler) => original(name, { ...config, inputSchema: addOwner(config.inputSchema, name) }, (args: ToolArguments, extra?: any) => controller.run(name, args, handler, extra));
    }
    if (server.tool) {
        const original = server.tool.bind(server);
        server.tool = (...registration: any[]) => {
            if (registration.length !== 4 || typeof registration[3] !== "function") return original(...registration);
            const [name, description, schema, handler] = registration;
            return original(name, description, addOwner(schema, name), (args: ToolArguments, extra?: any) => controller.run(name, args, handler, extra));
        };
    }
    installedServers.set(server, controller);
    return controller;
}
