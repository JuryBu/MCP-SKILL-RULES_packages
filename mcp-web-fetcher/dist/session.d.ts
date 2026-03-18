import type { Page } from "playwright";
declare class SessionManager {
    private sessions;
    private cleanupTimer;
    constructor();
    /**
     * 创建新会话
     */
    create(url: string, options?: {
        waitFor?: string;
        timeout?: number;
        scrollCount?: number;
    }): Promise<string>;
    /**
     * 获取已有会话
     */
    get(id: string): Page | null;
    /**
     * 关闭指定会话
     */
    close(id: string): Promise<boolean>;
    /**
     * 列出所有活跃会话
     */
    list(): Array<{
        id: string;
        url: string;
        createdAt: number;
        lastAccess: number;
    }>;
    /**
     * 清理过期会话
     */
    private cleanup;
    /**
     * 关闭所有会话
     */
    closeAll(): Promise<void>;
}
export declare const sessionManager: SessionManager;
export {};
//# sourceMappingURL=session.d.ts.map