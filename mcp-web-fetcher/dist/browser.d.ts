import { type BrowserContext, type Page } from "playwright";
/**
 * 浏览器管理器 — 单例模式
 * 使用独立的 persistent context 保存登录态
 */
declare class BrowserManager {
    private context;
    private launching;
    private activePages;
    private static readonly MAX_CONCURRENT_PAGES;
    private idleTimer;
    private static readonly BROWSER_IDLE_TIMEOUT;
    private domainLastRequest;
    lastRetryCount: number;
    /**
     * 获取或启动浏览器上下文
     */
    getContext(): Promise<BrowserContext>;
    /**
     * 启动浏览器 persistent context
     */
    private launch;
    /**
     * 判断错误是否为瞬时故障（值得重试）
     */
    private isTransientError;
    /**
     * 创建新页面并导航到指定 URL（内置瞬时故障自动重试）
     */
    navigateTo(url: string, options?: {
        waitFor?: string;
        timeout?: number;
        scrollCount?: number;
        fullPage?: boolean;
        pageNumber?: number;
        pageNumbers?: number[];
    }): Promise<Page>;
    /**
     * 从 URL 提取主域名（用于限速）
     */
    private extractDomain;
    /**
     * 判断是否为高风控域名
     */
    private isHighRiskDomain;
    /**
     * 智能内容就绪检测：等待 DOM 稳定（元素数量不再增长）+ iframe 加载
     * 解决 SPA / iframe 页面（如网易云音乐）在 networkidle 后内容仍未渲染的问题
     */
    private waitForContentReady;
    /**
     * 滚动页面以触发懒加载内容
     */
    scrollPage(page: Page, count: number): Promise<void>;
    /**
     * 获取浏览器上下文中的 cookies
     */
    getCookies(domain?: string): Promise<Array<{
        name: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
    }>>;
    /**
     * 以有头模式启动浏览器，让用户登录
     */
    launchLoginMode(): Promise<void>;
    /**
     * 保存当前所有 Cookie 到备份文件
     */
    saveCookies(): Promise<void>;
    /**
     * 从备份文件恢复 Cookie
     */
    private restoreCookies;
    /**
     * 关闭浏览器
     */
    close(): Promise<void>;
    /**
     * 仅关闭浏览器释放内存，MCP 进程继续运行
     * 下次 getContext() 调用时会自动重新启动浏览器
     */
    closeBrowser(): Promise<void>;
    /**
     * 重置浏览器空闲超时计时器
     */
    private resetIdleTimer;
    /**
     * 清理 Profile 中的非关键缓存目录
     * 保留 Cookies、Local Storage、IndexedDB 等登录态相关数据
     * 注意：必须在浏览器启动前调用（运行时目录被锁定无法删除）
     */
    private cleanProfileCache;
}
export declare const browserManager: BrowserManager;
export {};
//# sourceMappingURL=browser.d.ts.map