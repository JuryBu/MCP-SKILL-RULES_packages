import { browserManager } from "./browser.js";
import { touchActivity } from "./lifecycle.js";
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 分钟无操作自动关闭
let sessionCounter = 0;
class SessionManager {
    sessions = new Map();
    cleanupTimer = null;
    constructor() {
        // 每 30 秒检查一次过期会话
        this.cleanupTimer = setInterval(() => this.cleanup(), 30000);
        // 防止 cleanup 定时器阻止进程退出
        if (this.cleanupTimer.unref)
            this.cleanupTimer.unref();
    }
    /**
     * 创建新会话
     */
    async create(url, options) {
        const page = await browserManager.navigateTo(url, options);
        const id = `session_${++sessionCounter}`;
        this.sessions.set(id, {
            page,
            createdAt: Date.now(),
            lastAccess: Date.now(),
        });
        console.error(`[web-fetcher] 会话已创建: ${id}`);
        return id;
    }
    /**
     * 获取已有会话
     */
    get(id) {
        const session = this.sessions.get(id);
        if (!session)
            return null;
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
    async close(id) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        await session.page.close().catch(() => { });
        this.sessions.delete(id);
        console.error(`[web-fetcher] 会话已关闭: ${id}`);
        return true;
    }
    /**
     * 列出所有活跃会话
     */
    list() {
        const result = [];
        for (const [id, session] of this.sessions) {
            result.push({
                id,
                url: session.page.url(),
                createdAt: session.createdAt,
                lastAccess: session.lastAccess,
            });
        }
        return result;
    }
    /**
     * 清理过期会话
     */
    cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            // 超时清理 或 页面已死亡（浏览器被心跳关闭）
            if (now - session.lastAccess > SESSION_TIMEOUT || session.page.isClosed()) {
                if (!session.page.isClosed()) {
                    session.page.close().catch(() => { });
                }
                this.sessions.delete(id);
                console.error(`[web-fetcher] 会话清理: ${id}`);
            }
        }
    }
    /**
     * 关闭所有会话
     */
    async closeAll() {
        for (const [_id, session] of this.sessions) {
            await session.page.close().catch(() => { });
        }
        this.sessions.clear();
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
    }
}
export const sessionManager = new SessionManager();
//# sourceMappingURL=session.js.map