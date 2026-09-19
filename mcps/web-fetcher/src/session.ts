import type { Page } from "playwright";
import { browserManager } from "./browser.js";
import { touchActivity } from "./lifecycle.js";
import { randomUUID } from "crypto";
import { getRequestContext, OperationGate, RequestAdmissionError, runWithRequestContext, throwIfRequestExpired, withRequestStage, type AdmissionOptions } from "./request-context.js";
import { performance } from "node:perf_hooks";

/**
 * 页面会话管理器
 * 维护多个命名页面会话，支持会话复用
 */

interface Session {
    page: Page;
    ownerId: string;
    createdAt: number;
    lastAccess: number;
    ownsPage: boolean;
    ownership: SessionOwnership;
    closePolicy: SessionClosePolicy;
    browserSource: SessionBrowserSource;
    closing?: boolean;
    closePromise?: Promise<boolean>;
}

const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 分钟无操作自动关闭
const DEFAULT_OWNER_ID = "global";

export type SessionOwnership = "managed" | "borrowed";
export type SessionClosePolicy = "close-page" | "disconnect-only" | "noop";
export type SessionBrowserSource = "playwright-launch" | "cdp-attach-live" | "external-page";

export interface SessionInfo {
    id: string;
    ownerId: string;
    url: string;
    createdAt: number;
    lastAccess: number;
    ageMs: number;
    idleMs: number;
    ownsPage: boolean;
    ownership: SessionOwnership;
    closePolicy: SessionClosePolicy;
    browserSource: SessionBrowserSource;
}

export interface RegisterPageOptions {
    ownsPage?: boolean;
    ownership?: SessionOwnership;
    closePolicy?: SessionClosePolicy;
    browserSource?: SessionBrowserSource;
}

export function normalizeOwnerId(ownerId?: string): string {
    const normalized = ownerId?.trim();
    return normalized || DEFAULT_OWNER_ID;
}

interface PageOperations {
    gate: OperationGate;
    inFlight: number;
    idleWaiters: Array<() => void>;
    closing?: Promise<boolean>;
}

export class SessionManager {
    private sessions = new Map<string, Session>();
    private pageOperations = new Map<Page, PageOperations>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private readonly sessionTimeout: number;

    constructor(options: { cleanupIntervalMs?: number; sessionTimeoutMs?: number } = {}) {
        this.sessionTimeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT;
        // 每 30 秒检查一次过期会话
        this.cleanupTimer = setInterval(() => this.cleanup(), options.cleanupIntervalMs ?? 30000);
        // 防止 cleanup 定时器阻止进程退出
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    /**
     * 创建新会话
     */
    async create(url: string, options?: {
        waitFor?: string;
        timeout?: number;
        scrollCount?: number;
        ownerId?: string;
        viewport?: { width: number; height: number };
    }): Promise<string> {
        let page: Page;
        try {
            page = await browserManager.navigateTo(url, options);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("已达到最大并发页面数") || message.includes('page_admission_timeout') || message.includes('page_queue_full')) {
                const active = this.list(options?.ownerId);
                const activeText = formatSessionList(active);
                const hint = active.length > 0
                    ? `\n\n当前 ownerId="${normalizeOwnerId(options?.ownerId)}" 的保留会话:\n${activeText}\n\n可用 web_close_sessions(sessionId="...", ownerId="${normalizeOwnerId(options?.ownerId)}") 关闭不再需要的会话。`
                    : `\n\n可先调用 web_list_sessions(ownerId="${normalizeOwnerId(options?.ownerId)}", includeAllOwners=true) 查看当前保留会话，再用 web_close_sessions 关闭不再需要的会话。`;
                throw new Error(`${message}${hint}`);
            }
            throw error;
        }
        const id = `session_${randomUUID()}`;
        const context = getRequestContext();
        if (context) {
            try {
                const release = await this.acquirePage(page, { ownerId: normalizeOwnerId(options?.ownerId), signal: context.signal, deadline: context.deadline });
                context.finalizers.push(release);
            } catch (error) {
                await page.close().catch(() => { });
                throw error;
            }
        }

        this.sessions.set(id, {
            page,
            ownerId: normalizeOwnerId(options?.ownerId),
            createdAt: Date.now(),
            lastAccess: Date.now(),
            ownsPage: true,
            ownership: "managed",
            closePolicy: "close-page",
            browserSource: "playwright-launch",
        });

        console.error(`[web-fetcher] 会话已创建: ${id}`);
        return id;
    }

    /**
     * v6.6: 注册一个已有的 Page 对象为会话（用于 popup 等外部页面）
     */
    registerPage(page: Page, ownerId?: string, options?: RegisterPageOptions): string {
        const owner = normalizeOwnerId(ownerId);
        for (const session of this.sessions.values()) {
            if (session.page === page && (session.ownerId !== owner || session.closing)) {
                throw new Error("同一页面不能跨 owner 注册，或页面正在关闭");
            }
        }
        const id = `session_${randomUUID()}`;
        const resourcePolicy = normalizeResourcePolicy(options);
        this.sessions.set(id, {
            page,
            ownerId: normalizeOwnerId(ownerId),
            createdAt: Date.now(),
            lastAccess: Date.now(),
            ownsPage: resourcePolicy.closePolicy === "close-page",
            ownership: resourcePolicy.ownership,
            closePolicy: resourcePolicy.closePolicy,
            browserSource: resourcePolicy.browserSource,
        });
        console.error(`[web-fetcher] 会话已注册: ${id} ${resourcePolicy.ownership}/${resourcePolicy.closePolicy}/${resourcePolicy.browserSource} → ${page.url()}`);
        return id;
    }

    /**
     * 获取已有会话
     */
    get(id: string, ownerId?: string): Page | null {
        const session = this.sessions.get(id);
        if (!session || session.closing) return null;
        if (session.ownerId !== normalizeOwnerId(ownerId)) {
            console.error(`[web-fetcher] 会话 ${id} owner 校验失败`);
            return null;
        }

        // 检测页面是否仍然存活（防止浏览器关闭后的僵尸引用）
        if (session.page.isClosed()) {
            this.forgetClosedSession(id, session);
            console.error(`[web-fetcher] 会话 ${id} 页面已死亡，自动清理`);
            return null;
        }

        session.lastAccess = Date.now();
        // 刷新全局活动时间戳，防止浏览器 idle timer 误杀活跃会话
        touchActivity();
        return session.page;
    }

    async withOperation<Result>(id: string, ownerId: string | undefined, handler: (page: Page) => Promise<Result>, options: AdmissionOptions = {}): Promise<Result> {
        if (!getRequestContext()) {
            return runWithRequestContext({ ownerId, signal: options.signal, deadline: options.deadline }, () => this.withOperation(id, ownerId, handler, options));
        }
        const session = this.sessions.get(id);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId) || session.closing || session.page.isClosed()) {
            throw new RequestAdmissionError("session_unavailable", `会话 "${id}" 不存在、已关闭或 ownerId 不匹配`);
        }
        const context = getRequestContext();
        if (context?.leasedPages.has(session.page)) return handler(session.page);
        const release = await withRequestStage("page_queue", () => this.acquirePage(session.page, {
            ...options,
            ownerId: normalizeOwnerId(ownerId),
            signal: options.signal ?? context?.signal,
            deadline: options.deadline ?? context?.deadline,
        }));
        try {
            throwIfRequestExpired();
            if (options.signal?.aborted) throw new RequestAdmissionError("request_cancelled", "请求已取消，页面动作未开始");
            if (options.deadline !== undefined && options.deadline <= performance.now()) throw new RequestAdmissionError("admission_timeout", "页面动作开始前总期限已到");
            if (this.sessions.get(id) !== session || session.closing || session.page.isClosed()) {
                throw new RequestAdmissionError("session_unavailable", "排队期间会话已关闭，操作未开始");
            }
            session.lastAccess = Date.now();
            touchActivity();
            return await handler(session.page);
        } finally {
            session.lastAccess = Date.now();
            await release();
        }
    }

    hasBusySessions(): boolean {
        return [...this.pageOperations.values()].some(state => state.gate.getStats().active > 0 || state.gate.getStats().queued > 0);
    }

    getOperationStats() {
        const states = [...this.pageOperations.values()];
        return {
            active: states.reduce((sum, state) => sum + state.inFlight, 0),
            queued: states.reduce((sum, state) => sum + state.gate.getStats().queued, 0),
            closing: [...this.sessions.values()].filter(session => session.closing).length,
        };
    }

    private stateFor(page: Page): PageOperations {
        let state = this.pageOperations.get(page);
        if (!state) {
            state = { gate: new OperationGate(1, 32, "page-operation"), inFlight: 0, idleWaiters: [] };
            this.pageOperations.set(page, state);
        }
        return state;
    }

    private forgetClosedSession(id: string, session: Session): void {
        this.sessions.delete(id);
        const state = this.pageOperations.get(session.page);
        if (state && state.gate.getStats().active === 0 && state.gate.getStats().queued === 0 && ![...this.sessions.values()].some(entry => entry.page === session.page)) {
            this.pageOperations.delete(session.page);
        }
    }

    private async acquirePage(page: Page, options: AdmissionOptions): Promise<() => Promise<void>> {
        const state = this.stateFor(page);
        const releaseGate = await state.gate.acquire(options);
        state.inFlight++;
        const context = getRequestContext();
        context?.leasedPages.add(page);
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            const closing = [...this.sessions.values()].filter(session => session.page === page && session.closePromise).map(session => session.closePromise!);
            context?.leasedPages.delete(page);
            state.inFlight--;
            if (state.inFlight === 0) for (const resolve of state.idleWaiters.splice(0)) resolve();
            releaseGate();
            if (state.gate.getStats().active === 0 && state.gate.getStats().queued === 0 && ![...this.sessions.values()].some(session => session.page === page)) {
                this.pageOperations.delete(page);
            }
            await Promise.all(closing);
        };
    }

    /**
     * 关闭指定会话
     */
    async close(id: string, ownerId?: string): Promise<boolean> {
        const session = this.sessions.get(id);
        if (!session) return false;
        if (session.ownerId !== normalizeOwnerId(ownerId)) {
            console.error(`[web-fetcher] 会话 ${id} owner 校验失败，拒绝关闭`);
            return false;
        }

        const state = this.stateFor(session.page);
        if (!session.closePromise) {
            const affected = session.closePolicy === "close-page"
                ? [...this.sessions.entries()].filter(([, entry]) => entry.page === session.page)
                : [[id, session] as const];
            for (const [, entry] of affected) entry.closing = true;
            const closing = state.closing ?? (async () => {
                if (state.gate.getStats().active > 0) {
                    await new Promise<void>(resolve => state.idleWaiters.push(resolve));
                }
                await closeSessionResources(session);
                for (const [affectedId, entry] of affected) {
                    if (this.sessions.get(affectedId) === entry) this.sessions.delete(affectedId);
                }
                if (state.gate.getStats().active === 0 && state.gate.getStats().queued === 0 && ![...this.sessions.values()].some(entry => entry.page === session.page)) {
                    this.pageOperations.delete(session.page);
                }
                return true;
            })();
            if (session.closePolicy === "close-page") state.closing = closing;
            session.closePromise = closing;
            void closing.catch(() => {
                for (const [, entry] of affected) { entry.closing = false; entry.closePromise = undefined; }
                if (state.closing === closing) state.closing = undefined;
            });
        }
        if (getRequestContext()?.leasedPages.has(session.page)) return true;
        return session.closePromise;
    }

    /**
     * 列出所有活跃会话
     */
    list(ownerId?: string, options?: { includeAllOwners?: boolean }): SessionInfo[] {
        const owner = normalizeOwnerId(ownerId);
        const includeAllOwners = options?.includeAllOwners ?? false;
        const result: SessionInfo[] = [];
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.page.isClosed()) {
                this.forgetClosedSession(id, session);
                continue;
            }
            if (!includeAllOwners && session.ownerId !== owner) continue;
            result.push({
                id,
                ownerId: session.ownerId,
                url: session.page.url(),
                createdAt: session.createdAt,
                lastAccess: session.lastAccess,
                ageMs: now - session.createdAt,
                idleMs: now - session.lastAccess,
                ownsPage: session.ownsPage,
                ownership: session.ownership,
                closePolicy: session.closePolicy,
                browserSource: session.browserSource,
            });
        }
        return result;
    }

    /**
     * 关闭指定 owner 下的所有会话
     */
    async closeAllForOwner(ownerId?: string): Promise<number> {
        const owner = normalizeOwnerId(ownerId);
        const ids = [...this.sessions.entries()]
            .filter(([, session]) => session.ownerId === owner)
            .map(([id]) => id);
        let closed = 0;
        for (const id of ids) {
            if (await this.close(id, owner)) closed++;
        }
        return closed;
    }

    /**
     * 清理过期会话
     */
    private cleanup(): void {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            // 超时清理 或 页面已死亡（浏览器被心跳关闭）
            const state = this.pageOperations.get(session.page);
            if (state && (state.gate.getStats().active > 0 || state.gate.getStats().queued > 0)) continue;
            if (now - session.lastAccess > this.sessionTimeout || session.page.isClosed()) {
                void this.close(id, session.ownerId).catch(error => console.error("[web-fetcher] 会话清理失败，保留记录", error));
                console.error(`[web-fetcher] 会话清理: ${id}`);
            }
        }
    }

    /**
     * 关闭所有会话
     */
    async closeAll(): Promise<void> {
        await Promise.all([...this.sessions.entries()].map(([id, session]) => this.close(id, session.ownerId)));
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
    }
}

export const sessionManager = new SessionManager();

export function formatSessionList(sessions: SessionInfo[]): string {
    if (sessions.length === 0) {
        return "没有活跃会话。";
    }
    return sessions.map((session, index) => {
        const age = formatDuration(session.ageMs);
        const idle = formatDuration(session.idleMs);
        const ownership = `${session.ownership}/${session.closePolicy}/${session.browserSource}`;
        return `${index + 1}. ${session.id} ownerId=${session.ownerId} ${ownership} idle=${idle} age=${age}\n   URL: ${session.url}`;
    }).join("\n");
}

export function formatPoolPressureHint(ownerId?: string, options?: { includeAllOwners?: boolean; includeSessionList?: boolean }): string {
    const pool = browserManager.getPoolStats();
    if (!pool.isNearLimit) return "";

    const owner = normalizeOwnerId(ownerId);
    const sessions = sessionManager.list(ownerId, { includeAllOwners: options?.includeAllOwners ?? false });
    const activeText = formatSessionList(sessions);
    const scope = options?.includeAllOwners ? "全部 ownerId" : `ownerId="${owner}"`;
    const includeSessionList = options?.includeSessionList ?? true;
    const cleanupHint = sessions.length > 0
        ? `可用 web_close_sessions(sessionId="...", ownerId="${owner}") 关闭不再需要的会话；如果确认该 owner 下都不用了，可用 web_close_sessions(ownerId="${owner}", closeAllForOwner=true)。`
        : `可先调用 web_list_sessions(ownerId="${owner}", includeAllOwners=true) 查看全部占用，再关闭不再需要的会话。`;

    const lines = [
        "",
        `⚠️ 页面池接近上限：${pool.activePages}/${pool.maxConcurrentPages}（提醒阈值 ${pool.warningThreshold}）。`,
        "建议顺手清理旧会话，避免下一次页面创建触顶。",
    ];
    if (includeSessionList) {
        lines.push(`当前 ${scope} 的保留会话:`, activeText);
    }
    lines.push(cleanupHint);
    return lines.join("\n");
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    if (minutes < 60) return restSeconds ? `${minutes}m${restSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function normalizeResourcePolicy(options?: RegisterPageOptions): Required<RegisterPageOptions> {
    const ownership = options?.ownership ?? (options?.ownsPage === false ? "borrowed" : "managed");
    const closePolicy = ownership === "borrowed" && options?.closePolicy === "close-page"
        ? "noop" : options?.closePolicy ?? (ownership === "managed" ? "close-page" : "noop");
    const browserSource = options?.browserSource ?? (ownership === "managed" ? "playwright-launch" : "external-page");
    return {
        ownsPage: closePolicy === "close-page",
        ownership,
        closePolicy,
        browserSource,
    };
}

async function closeSessionResources(session: Session): Promise<void> {
    if (session.closePolicy !== "close-page") {
        console.error(`[web-fetcher] borrowed 会话仅移除引用: ${session.ownership}/${session.closePolicy}/${session.browserSource}`);
        return;
    }
    if (!session.page.isClosed()) {
        await session.page.close();
    }
}
