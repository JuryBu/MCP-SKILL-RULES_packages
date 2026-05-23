import type { Page } from "playwright";
import { browserManager } from "./browser.js";
import { touchActivity } from "./lifecycle.js";
import { randomUUID } from "crypto";

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

class SessionManager {
    private sessions = new Map<string, Session>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // 每 30 秒检查一次过期会话
        this.cleanupTimer = setInterval(() => this.cleanup(), 30000);
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
    }): Promise<string> {
        let page: Page;
        try {
            page = await browserManager.navigateTo(url, options);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("已达到最大并发页面数")) {
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
        if (!session) return null;
        if (session.ownerId !== normalizeOwnerId(ownerId)) {
            console.error(`[web-fetcher] 会话 ${id} owner 校验失败`);
            return null;
        }

        // 检测页面是否仍然存活（防止浏览器关闭后的僵尸引用）
        if (session.page.isClosed()) {
            this.sessions.delete(id);
            console.error(`[web-fetcher] 会话 ${id} 页面已死亡，自动清理`);
            return null;
        }

        session.lastAccess = Date.now();
        // 刷新全局活动时间戳，防止浏览器 idle timer 误杀活跃会话
        touchActivity();
        return session.page;
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

        await closeSessionResources(session);
        this.sessions.delete(id);
        console.error(`[web-fetcher] 会话已关闭: ${id}`);
        return true;
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
                this.sessions.delete(id);
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
            if (now - session.lastAccess > SESSION_TIMEOUT || session.page.isClosed()) {
                closeSessionResources(session).catch(() => { });
                this.sessions.delete(id);
                console.error(`[web-fetcher] 会话清理: ${id}`);
            }
        }
    }

    /**
     * 关闭所有会话
     */
    async closeAll(): Promise<void> {
        for (const [_id, session] of this.sessions) {
            await closeSessionResources(session);
        }
        this.sessions.clear();
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
    const closePolicy = options?.closePolicy ?? (ownership === "managed" ? "close-page" : "noop");
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
        await session.page.close().catch(() => { });
    }
}
