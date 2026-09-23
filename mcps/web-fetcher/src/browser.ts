import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import { getStealthScript, type StealthLevel } from "./stealth.js";
import {
    BROWSER_PROFILES_BASE_DIR,
    BROWSER_USER_DATA_DIR,
    COOKIES_BACKUP_FILE,
    DOWNLOADS_DIR,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT,
    CHROME_VERSION,
    CHROME_FULL_VERSION,
    CHROMIUM_BRANDS,
    CHROMIUM_FULL_VERSION_LIST,
    WEBGL_VENDOR,
    WEBGL_RENDERER,
    ANTI_BOT_DELAY_MIN,
    ANTI_BOT_DELAY_MAX,
    DOMAIN_REQUEST_COOLDOWN,
    HIGH_RISK_DOMAINS,
    HIGH_RISK_DELAY_MIN,
    HIGH_RISK_DELAY_MAX,
    BROWSER_ACCEPT_HEADERS,
    SPA_LAZY_LOAD_DOMAINS,
    SMART_LOAD_CHECK_INTERVAL,
    SMART_LOAD_STABILITY_THRESHOLD,
    SMART_LOAD_STABLE_CHECKS,
    SMART_LOAD_MAX_WAIT_NORMAL,
    SMART_LOAD_MAX_WAIT_SPA,
    SMART_LOAD_MIN_CONTENT_LENGTH,
    IMAGE_LOAD_MAX_WAIT,
    IMAGE_LOAD_CHECK_INTERVAL,
    IMAGE_LOAD_STABLE_CHECKS,
    IMAGE_LOAD_BG_MIN_AREA,
} from "./constants.js";
import {
    detectHumanVerificationSignals,
    formatHumanVerificationDetection,
} from "./human-verification.js";
import { logHumanVerificationAudit } from "./human-audit.js";
import { BrowserAuthState, installOriginStorage } from "./browser-auth-state.js";
import { waitForPageReadiness, type ReadinessResult } from './readiness.js';
import { getRequestContext, getActiveRequestCount, remainingRequestMs, throwIfRequestExpired, withRequestStage, withSuspendedRequestDeadline } from './request-context.js';
import { PageAdmissionController, type PageLease } from './page-admission.js';
import { getRuntimeMemorySampler } from './memory-sampler.js';
import { applyExplicitViewport, assertViewportTarget, type ResponsiveViewport } from './viewport.js';
import { assertPageAccessible } from './page-access.js';

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 浏览器管理器 — 单例模式
 * 使用独立的 persistent context 保存登录态
 */
class BrowserManager {
    private authState = new BrowserAuthState();
    private context: BrowserContext | null = null;
    private launching: Promise<BrowserContext> | null = null;
    private activePages = new Set<Page>();
    private admission?: PageAdmissionController;
    private pageLeases = new WeakMap<Page, PageLease>();
    private retryCounts = new WeakMap<object, number>();
    private fallbackRetryCount = 0;
    private static readonly PAGE_POOL_WARNING_THRESHOLD = readPositiveIntEnv("WEB_FETCHER_PAGE_POOL_WARNING_THRESHOLD", 3);
    private static readonly LOCAL_DEV_NO_CACHE_HEADERS = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    } as const;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly BROWSER_IDLE_TIMEOUT = 20 * 60 * 1000; // 20 分钟无活动关闭浏览器
    // 域名级请求时间记录 — 防止同域高频请求触发封禁
    private domainLastRequest: Map<string, number> = new Map();
    public get lastRetryCount(): number { const request = getRequestContext(); return request ? this.retryCounts.get(request) ?? 0 : this.fallbackRetryCount; }
    public set lastRetryCount(value: number) { const request = getRequestContext(); if (request) this.retryCounts.set(request, value); else this.fallbackRetryCount = value; }
    // v6.4: 域名级 stealth 降级记忆 — 避免同域每次都要试错
    private domainStealthLevel: Map<string, StealthLevel> = new Map();
    // v6.4: 裸奔 context（L1）— WAF 域名用独立 context，不影响主 context 的 stealth
    private bareContext: BrowserContext | null = null;
    private bareLaunching: Promise<BrowserContext> | null = null;

    /**
     * 获取或启动浏览器上下文
     */
    async getContext(): Promise<BrowserContext> {
        // 健康检查：如果已有 context，验证是否仍可用
        if (this.context) {
            try {
                await this.context.pages();
                await this.refreshAuthState();
                this.resetIdleTimer();
                return this.context;
            } catch {
                console.error("[web-fetcher] 检测到 context 已损坏，重建中...");
                this.context = null;
            }
        }

        // 防止并发启动
        if (this.launching) {
            return this.launching;
        }

        this.launching = this.launch();
        try {
            this.context = await this.launching;
            this.resetIdleTimer();
            return this.context;
        } finally {
            this.launching = null;
        }
    }

    /**
     * 启动浏览器 persistent context
     * v6.1: 使用 per-PID profile 隔离，避免多实例 SingletonLock 冲突
     */
    private async launch(): Promise<BrowserContext> {
        // v6.1: 旧 Cookie 备份迁移（从旧的单一 profile 目录迁移到共享位置）
        this.migrateOldCookieBackup();

        // v6.1: 清理其他已死进程留下的孤儿 profile 目录
        this.cleanStaleProfiles();

        // 确保当前实例的 profile 目录存在
        if (!fs.existsSync(BROWSER_USER_DATA_DIR)) {
            fs.mkdirSync(BROWSER_USER_DATA_DIR, { recursive: true });
        }

        // 启动前清理缓存（此时浏览器未运行，无文件锁）
        this.cleanProfileCache();

        console.error(`[web-fetcher] 启动浏览器，profile: ${BROWSER_USER_DATA_DIR} (PID: ${process.pid})`);

        const context = await chromium.launchPersistentContext(
            BROWSER_USER_DATA_DIR,
            {
                headless: true,
                acceptDownloads: true,
                downloadsPath: DOWNLOADS_DIR,
                userAgent: DEFAULT_USER_AGENT,
                viewport: { width: 1920, height: 1080 },
                locale: "zh-CN",
                timezoneId: "Asia/Shanghai",
                // v6.3.2: 排除 Playwright 默认的 --enable-automation（这是 navigator.webdriver=true 的根源）
                ignoreDefaultArgs: ['--enable-automation'],
                // 反检测启动参数
                args: [
                    // 核心反自动化
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-infobars",
                    // 性能 & 兼容
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    // WebGL 硬件加速（防止 SwiftShader 暴露）
                    "--enable-webgl",
                    "--use-gl=angle",
                    "--enable-features=VaapiVideoDecoder",
                    // WebRTC 禁止泄露真实 IP
                    "--enforce-webrtc-ip-permission-check",
                    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
                    // 隐藏自动化特征（核心 stealth 参数）
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=AutomationControlled",
                    "--disable-component-extensions-with-background-pages",
                    "--disable-default-apps",
                    "--disable-component-update",
                    "--disable-hang-monitor",
                    "--disable-ipc-flooding-protection",
                    "--disable-popup-blocking",
                    "--disable-prompt-on-repost",
                    "--disable-renderer-backgrounding",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--password-store=basic",
                    "--use-mock-keychain",
                    // 窗口大小一致性
                    "--window-size=1920,1080",
                    "--window-position=0,0",
                    // 本地文件访问支持
                    "--allow-file-access-from-files",
                    "--allow-file-access",
                ],
                // Sec-CH-UA Client Hints HTTP headers（引用 constants 统一管理）
                extraHTTPHeaders: {
                    "Sec-CH-UA": CHROMIUM_BRANDS.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
                    "Sec-CH-UA-Mobile": "?0",
                    "Sec-CH-UA-Platform": '"Windows"',
                    "Sec-CH-UA-Platform-Version": '"15.0.0"',
                    "Sec-CH-UA-Full-Version-List": CHROMIUM_FULL_VERSION_LIST.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
                },
            }
        );

        // Stealth 反检测脚本注入（v6.4 双 context 架构：主 context 始终 L3）
        await context.addInitScript(getStealthScript({
            chromeVersion: CHROME_VERSION,
            chromeFullVersion: CHROME_FULL_VERSION,
            brands: CHROMIUM_BRANDS,
            fullVersionList: CHROMIUM_FULL_VERSION_LIST,
            webglVendor: WEBGL_VENDOR,
            webglRenderer: WEBGL_RENDERER,
            level: 3,
        }));

        console.error("[web-fetcher] 浏览器启动成功（已注入 stealth L3 完整版）");
        // 恢复备份的 Cookie
        await this.restoreCookies(context);

        return context;
    }

    /**
     * v6.4: 获取裸奔 context（L1, 无 stealth 注入）
     * 按需创建，用于 WAF 高级检测的域名，不影响主 context
     */
    private async getBareContext(): Promise<BrowserContext> {
        if (this.bareContext) {
            try {
                await this.bareContext.pages();
                await this.authState.refresh(this.bareContext).catch(() => {
                    console.error("[web-fetcher] shared Cookie refresh failed; existing context preserved");
                });
                return this.bareContext;
            } catch {
                this.bareContext = null;
            }
        }
        if (this.bareLaunching) return this.bareLaunching;

        this.bareLaunching = this.launchBareContext();
        try {
            this.bareContext = await this.bareLaunching;
            return this.bareContext;
        } finally {
            this.bareLaunching = null;
        }
    }

    /**
     * v6.4: 启动裸奔 context（L1）
     * 使用独立的临时 profile，不注入任何 stealth 脚本
     */
    private async launchBareContext(): Promise<BrowserContext> {
        const bareProfileDir = BROWSER_USER_DATA_DIR + '-bare';
        if (!fs.existsSync(bareProfileDir)) {
            fs.mkdirSync(bareProfileDir, { recursive: true });
        }

        console.error(`[web-fetcher] 启动裸奔浏览器 (L1, 无 stealth)...`);

        const context = await chromium.launchPersistentContext(
            bareProfileDir,
            {
                headless: true,
                acceptDownloads: true,
                downloadsPath: DOWNLOADS_DIR,
                userAgent: DEFAULT_USER_AGENT,
                viewport: { width: 1920, height: 1080 },
                locale: "zh-CN",
                timezoneId: "Asia/Shanghai",
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-infobars",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--enable-webgl",
                    "--use-gl=angle",
                    "--window-size=1920,1080",
                    "--window-position=0,0",
                    "--allow-file-access-from-files",
                    "--allow-file-access",
                ],
                extraHTTPHeaders: {
                    "Sec-CH-UA": CHROMIUM_BRANDS.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
                    "Sec-CH-UA-Mobile": "?0",
                    "Sec-CH-UA-Platform": '"Windows"',
                },
            }
        );

        // L1: 不注入 stealth，仅空占位
        await context.addInitScript('/* stealth level 1: bare mode */');
        await this.restoreCookies(context);

        console.error(`[web-fetcher] 裸奔浏览器启动成功 (L1)`);
        return context;
    }

    /**
     * 判断错误是否为瞬时故障（值得重试）
     */
    private isTransientError(error: unknown): boolean {
        const msg = error instanceof Error ? error.message : String(error);
        const TRANSIENT_PATTERNS = [
            'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED',
            'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED',
            'ERR_TIMED_OUT', 'ERR_ABORTED',
            'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
            'Timeout', 'timeout',
            'CDN 加载失败', '初始化超时',
            'net::ERR_',
        ];
        return TRANSIENT_PATTERNS.some(p => msg.includes(p));
    }

    /**
     * 创建新页面并导航到指定 URL（内置瞬时故障自动重试）
     */
    async navigateTo(
        url: string,
        options?: {
            waitFor?: string;
            timeout?: number;
            scrollCount?: number;
            fullPage?: boolean;
            pageNumber?: number;
            pageNumbers?: number[];
            viewport?: ResponsiveViewport;
        }
    ): Promise<Page> {
        // 每次导航重置重试计数
        if (!getRequestContext()) this.lastRetryCount = 0;

        const viewport = options?.viewport ?? getRequestContext()?.viewport;
        assertViewportTarget(url, viewport);
        let page: Page;
        try {
            // v6.4: 域名级 context 路由 — WAF 域名用 bareContext，其他用主 context
            const targetDomain = this.extractDomain(url);
            const domainLevel = this.domainStealthLevel.get(targetDomain);
            const context = await withRequestStage('browser.context', () => domainLevel === 1
                ? this.getBareContext()
                : this.getContext());
            page = await this.createManagedPage(context);
            try { await applyExplicitViewport(page, viewport); }
            catch (error) { await this.closeFailedPage(page, 'viewport-error'); throw error; }
        } catch (err) {
            throw err;
        }
        const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

        // ========== 本地文件快捷通道 ==========
        const isFileProtocol = url.startsWith("file://") || url.startsWith("file:///");
        if (isFileProtocol) {
            try {
                const fileCategory = (await import('./converter.js')).categorizeFile(decodeURIComponent(url.replace(/^file:\/\/\/?/, '')));

                if (fileCategory === 'pdf' || fileCategory === 'office' || fileCategory === 'tex') {
                    // PDF / Office / TeX → pdf.js 渲染
                    // Office/TeX 先转为 PDF
                    let pdfFilePath: string;
                    let filePath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));

                    if (fileCategory === 'office' || fileCategory === 'tex') {
                        const { convertToPDF } = await import('./converter.js');
                        pdfFilePath = await convertToPDF(filePath);
                        console.error(`[web-fetcher] 文件 ${filePath} → PDF: ${pdfFilePath}`);
                    } else {
                        pdfFilePath = filePath;
                    }

                    const pdfFs = await import('fs');
                    if (!pdfFs.existsSync(pdfFilePath)) {
                        throw new Error(`PDF 文件不存在: ${pdfFilePath}`);
                    }
                    const pdfBuffer = pdfFs.readFileSync(pdfFilePath);
                    const pdfSizeMB = pdfBuffer.length / 1024 / 1024;
                    if (pdfSizeMB > 50) {
                        throw new Error(`PDF 文件过大 (${pdfSizeMB.toFixed(1)}MB)，最大支持 50MB`);
                    }

                    console.error(`[web-fetcher] PDF 渲染: ${pdfFilePath} (${pdfSizeMB.toFixed(1)}MB)`);

                    // 确定要渲染的页码列表
                    // pageNumbers 优先（多页批量），其次 pageNumber（单页），默认第1页
                    const requestedPages = options?.pageNumbers ?? (options?.pageNumber ? [options.pageNumber] : [1]);

                    await page.goto('about:blank', { waitUntil: 'load', timeout: 5000 });

                    await page.setContent(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <style>
                                html, body { margin: 0; padding: 0; background: #525659; overflow: hidden; }
                                #pdf-container { display: flex; flex-direction: column; align-items: center; }
                                canvas { display: block; background: white; }
                                #status { color: white; font-family: sans-serif; font-size: 18px; text-align: center; padding: 40px; }
                            </style>
                        </head>
                        <body>
                            <div id="pdf-container">
                                <div id="status">正在加载 PDF...</div>
                            </div>
                        </body>
                        </html>
                    `, { waitUntil: 'load', timeout: 5000 });

                    // pdf.js CDN 加载（带瞬时故障重试）
                    for (let cdnAttempt = 0; cdnAttempt < 2; cdnAttempt++) {
                        try {
                            await page.addScriptTag({
                                url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.9.359/pdf.min.js',
                            });
                            await page.waitForFunction(
                                () => typeof (window as any).pdfjsLib !== 'undefined',
                                { timeout: 10000 }
                            );
                            break;
                        } catch (cdnErr) {
                            if (cdnAttempt === 0) {
                                this.lastRetryCount++;
                                console.error(`[web-fetcher] ⚡ pdf.js CDN 加载失败，2秒后重试...`);
                                await page.waitForTimeout(2000);
                            } else {
                                throw new Error('pdf.js CDN 加载失败（已重试），请检查网络连接');
                            }
                        }
                    }

                    console.error(`[web-fetcher] pdf.js 加载成功，渲染 ${requestedPages.length} 页: [${requestedPages.join(',')}]`);

                    const pdfBase64 = pdfBuffer.toString('base64');
                    const renderResult = await page.evaluate(async (args: { b64: string; pages: number[]; viewportWidth: number }) => {
                        try {
                            const pdfjsLib = (window as any).pdfjsLib;
                            pdfjsLib.GlobalWorkerOptions.workerSrc =
                                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.9.359/pdf.worker.min.js';

                            const binaryStr = atob(args.b64);
                            const bytes = new Uint8Array(binaryStr.length);
                            for (let i = 0; i < binaryStr.length; i++) {
                                bytes[i] = binaryStr.charCodeAt(i);
                            }

                            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                            const totalPages = pdf.numPages;

                            // 页码越界检查
                            const invalidPages = args.pages.filter(p => p < 1 || p > totalPages);
                            if (invalidPages.length > 0) {
                                return {
                                    success: false,
                                    error: `页码 [${invalidPages.join(',')}] 超出范围（该文档共 ${totalPages} 页）`,
                                    totalPages,
                                    renderedPages: [] as number[],
                                    heights: {} as Record<number, number>,
                                    firstPageHeight: 0,
                                };
                            }

                            const container = document.getElementById('pdf-container')!;
                            container.innerHTML = '';

                            const heights: Record<number, number> = {};
                            const texts: Record<number, string> = {};

                            // 按需渲染指定页，每页独立 canvas 带唯一 id
                            for (const pageNum of args.pages) {
                                const pdfPage = await pdf.getPage(pageNum);
                                const defaultViewport = pdfPage.getViewport({ scale: 1.0 });
                                const scale = args.viewportWidth / defaultViewport.width;
                                const viewport = pdfPage.getViewport({ scale });

                                const canvas = document.createElement('canvas');
                                canvas.id = `pdf-page-${pageNum}`;
                                canvas.width = viewport.width;
                                canvas.height = viewport.height;
                                container.appendChild(canvas);
                                heights[pageNum] = viewport.height;

                                const ctx = canvas.getContext('2d');
                                await pdfPage.render({ canvasContext: ctx, viewport }).promise;

                                // 提取文本层
                                try {
                                    const textContent = await pdfPage.getTextContent();
                                    const pageText = textContent.items
                                        .map((item: any) => item.str || '')
                                        .join('')
                                        .replace(/\s+/g, ' ')
                                        .trim();
                                    if (pageText.length > 0) {
                                        texts[pageNum] = pageText;
                                    }
                                } catch { /* 文本提取失败不影响截图 */ }
                            }

                            // 暴露页码信息供调用方读取
                            (window as any).__mcpPdfInfo = {
                                totalPages,
                                currentPage: args.pages[0],
                                renderedPages: args.pages,
                                heights,
                                texts,
                                // goToPage: 重新渲染指定页（供 batch-screenshot 多页切换用）
                                goToPage: async (targetPage: number) => {
                                    if (targetPage < 1 || targetPage > totalPages) return;
                                    const container = document.getElementById('pdf-container')!;
                                    container.innerHTML = '';
                                    const pdfPage = await pdf.getPage(targetPage);
                                    const defaultViewport = pdfPage.getViewport({ scale: 1.0 });
                                    const scale = args.viewportWidth / defaultViewport.width;
                                    const viewport = pdfPage.getViewport({ scale });
                                    const canvas = document.createElement('canvas');
                                    canvas.id = `pdf-page-${targetPage}`;
                                    canvas.width = viewport.width;
                                    canvas.height = viewport.height;
                                    container.appendChild(canvas);
                                    const ctx = canvas.getContext('2d');
                                    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
                                    (window as any).__mcpPdfInfo.currentPage = targetPage;
                                    (window as any).__mcpPdfInfo.heights[targetPage] = viewport.height;
                                },
                            };

                            return {
                                success: true,
                                totalPages,
                                renderedPages: args.pages,
                                heights,
                                firstPageHeight: heights[args.pages[0]] || 0,
                                texts,
                            };
                        } catch (err: any) {
                            return {
                                success: false, error: err.message || String(err),
                                totalPages: 0, renderedPages: [] as number[],
                                heights: {} as Record<number, number>, firstPageHeight: 0,
                            };
                        }
                    }, { b64: pdfBase64, pages: requestedPages, viewportWidth: 1920 });

                    if (!renderResult.success) {
                        throw new Error(`PDF 渲染失败: ${renderResult.error}`);
                    }

                    // 调整页面视口高度匹配第一页高度（单页截图用）
                    await page.setViewportSize({
                        width: 1920,
                        height: Math.round(renderResult.firstPageHeight || 1080),
                    });

                    await page.waitForTimeout(300);
                    console.error(`[web-fetcher] PDF 渲染完成: ${renderResult.renderedPages.length}页 [${renderResult.renderedPages.join(',')}] / 共${renderResult.totalPages}页`);
                } else if (fileCategory === 'image') {
                    // 图片文件：用 <img> 标签显示
                    const imgPath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));
                    const imgBuffer = fs.readFileSync(imgPath);
                    const ext = path.extname(imgPath).toLowerCase();
                    const mimeMap: Record<string, string> = {
                        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                        '.png': 'image/png', '.gif': 'image/gif',
                        '.webp': 'image/webp', '.svg': 'image/svg+xml',
                        '.bmp': 'image/bmp', '.ico': 'image/x-icon',
                    };
                    const mime = mimeMap[ext] || 'image/png';
                    const b64 = imgBuffer.toString('base64');
                    await page.setContent(`
                        <!DOCTYPE html>
                        <html><head><style>
                            html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; background: #fff; display: flex; justify-content: center; align-items: center; }
                            img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
                        </style></head>
                        <body><img src="data:${mime};base64,${b64}" /></body></html>
                    `, { waitUntil: 'load' });
                    await page.waitForTimeout(300);
                } else {
                    // HTML / Markdown / 纯文本 / 其它
                    const localFilePath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));
                    const localExt = path.extname(localFilePath).toLowerCase();

                    // 多文件项目检测：HTML 文件 + 同目录有 .js/.css → 用临时 HTTP 服务器
                    if ((localExt === '.html' || localExt === '.htm') && localFilePath) {
                        const { isMultiFileProject, serveDirectory } = await import('./local-server.js');
                        if (isMultiFileProject(localFilePath)) {
                            const dir = path.dirname(localFilePath);
                            const fileName = path.basename(localFilePath);
                            const { url: serverUrl } = await serveDirectory(dir);
                            const httpUrl = `${serverUrl}/${fileName}`;
                            console.error(`[web-fetcher] 多文件项目检测 → HTTP 服务: ${httpUrl}`);
                            await page.goto(httpUrl, {
                                waitUntil: "domcontentloaded",
                                timeout,
                            });
                            await page.waitForTimeout(500);
                        } else {
                            await page.goto(url, { waitUntil: "domcontentloaded", timeout });
                            await page.waitForTimeout(500);
                        }
                    } else if (localExt === '.md' || localExt === '.markdown') {
                        // Markdown 文件：渲染为 HTML
                        const mdContent = fs.readFileSync(localFilePath, 'utf-8');
                        const escapedMd = JSON.stringify(mdContent);
                        await page.setContent(`
                            <!DOCTYPE html>
                            <html><head>
                            <style>
                                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
                                       max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1f2328; line-height: 1.6; background: #fff; }
                                h1 { font-size: 2em; border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
                                h2 { font-size: 1.5em; border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
                                h3 { font-size: 1.25em; }
                                code { background: #eff1f3; padding: 0.2em 0.4em; border-radius: 6px; font-size: 85%; font-family: 'SFMono-Regular', Consolas, monospace; }
                                pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
                                pre code { background: none; padding: 0; }
                                blockquote { border-left: 4px solid #d1d9e0; padding: 0 16px; color: #656d76; margin: 0 0 16px 0; }
                                table { border-collapse: collapse; width: 100%; }
                                th, td { border: 1px solid #d1d9e0; padding: 6px 13px; }
                                th { background: #f6f8fa; font-weight: 600; }
                                img { max-width: 100%; }
                                a { color: #0969da; text-decoration: none; }
                                hr { border: none; border-top: 1px solid #d1d9e0; margin: 24px 0; }
                                ul, ol { padding-left: 2em; }
                                li { margin: 0.25em 0; }
                            </style>
                            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
                            </head>
                            <body><div id="content">正在渲染 Markdown...</div>
                            <script>
                                document.getElementById('content').innerHTML = marked.parse(${escapedMd});
                            </script>
                            </body></html>
                        `, { waitUntil: 'load' });
                        await page.waitForTimeout(500);
                        console.error(`[web-fetcher] Markdown 渲染完成: ${path.basename(localFilePath)}`);
                    } else {
                        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
                        await page.waitForTimeout(500);
                    }
                }

                if (options?.scrollCount && options.scrollCount > 0) {
                    await this.scrollPage(page, options.scrollCount);
                }

                return page;
            } catch (error) {
                await page.close().catch(() => { });
                throw error;
            }
        }

        try {
            // ========== 域名级请求限速 ==========
            const domain = this.extractDomain(url);
            const isHighRisk = this.isHighRiskDomain(domain);
            const isLocalDevUrl = this.isLocalDevUrl(url);
            const lastReq = this.domainLastRequest.get(domain);
            if (lastReq && !isLocalDevUrl) {
                const elapsed = Date.now() - lastReq;
                const cooldown = isHighRisk ? DOMAIN_REQUEST_COOLDOWN * 2 : DOMAIN_REQUEST_COOLDOWN;
                if (elapsed < cooldown) {
                    const wait = cooldown - elapsed + Math.random() * 500;
                    console.error(`[web-fetcher] 域名限速：${domain} 等待 ${Math.round(wait)}ms`);
                    await new Promise(r => setTimeout(r, wait));
                }
            }
            this.domainLastRequest.set(domain, Date.now());

            await this.prepareLocalDevCacheBypass(page, url);

            // ========== 设置真实浏览器 Headers ==========
            await page.setExtraHTTPHeaders({
                ...BROWSER_ACCEPT_HEADERS,
                // 高风控站点加 Referer，模拟从站内导航
                ...(isHighRisk ? { 'Referer': `https://${domain}/` } : {}),
            });

            // ========== 资源层兼容性拦截 ==========
        // 解决无头浏览器 CDN 资源加载问题：
        //   1. 移除 SRI integrity → 防止 CDN 指纹差异导致 hash 不匹配（如 DeepSeek）
        //   2. 移除 CSP → 防止 Content-Security-Policy 干扰 stealth 注入脚本
        //   3. 移除 X-Frame-Options → 改善 iframe 兼容性
            await page.route('**/*', async (route) => {
            try {
                const isLocalDevRequest = this.isLocalDevUrl(route.request().url());
                const response = isLocalDevRequest
                    ? await route.fetch({
                        headers: this.withLocalDevNoCacheHeaders(route.request().headers()),
                    })
                    : await route.fetch();
                const contentType = response.headers()['content-type'] || '';

                if (contentType.includes('text/html')) {
                    // v5.2: GBK/GB2312 编码检测与转码
                    // 检查 Content-Type 是否声明了 GBK/GB2312 字符集
                    const charsetMatch = contentType.match(/charset\s*=\s*([\w-]+)/i);
                    const declaredCharset = charsetMatch ? charsetMatch[1].toLowerCase() : '';
                    const isGBK = declaredCharset.startsWith('gb') || declaredCharset === 'gbk' || declaredCharset === 'gb2312';

                    let body: string;
                    if (isGBK) {
                        // GBK 站点：用 iconv-lite 从原始字节解码
                        const rawBody = await response.body();
                        body = iconv.decode(rawBody, declaredCharset || 'gbk');
                    } else {
                        body = await response.text();
                        // 如果 HTTP 头没声明但 HTML meta 声明了 GBK，也做转码
                        if (!declaredCharset) {
                            const metaMatch = body.substring(0, 2048).match(/charset\s*=\s*["']?(gb[\w-]*)/i);
                            if (metaMatch) {
                                // meta 声明 GBK 但 response.text() 已按 UTF-8 解码（大概率乱码）
                                // 重新用原始字节解码
                                const rawBody = await response.body();
                                body = iconv.decode(rawBody, metaMatch[1]);
                            }
                        }
                    }

                    // 移除 SRI integrity 属性（防止 CDN 返回内容与 hash 不匹配）
                    body = body.replace(/\s+integrity="[^"]*"/g, '');
                    // 移除 nonce 属性（某些 CSP 策略依赖 nonce 限制脚本执行）
                    body = body.replace(/\s+nonce="[^"]*"/g, '');

                    // 清理限制性 HTTP headers
                    const headers = { ...response.headers() };
                    delete headers['content-security-policy'];
                    delete headers['content-security-policy-report-only'];
                    delete headers['x-frame-options'];
                    delete headers['content-length'];
                    // 更新 charset 为 UTF-8（已转码）
                    if (isGBK && headers['content-type']) {
                        headers['content-type'] = headers['content-type']
                            .replace(/charset\s*=\s*[\w-]+/gi, 'charset=utf-8');
                    }

                    await route.fulfill({ response, body, headers });
                } else {
                    // 非 HTML 资源直接透传
                    await route.fulfill({ response });
                }
            } catch {
                // 拦截失败则放行原始请求
                await route.continue();
            }
            });

            // 网络导航（带瞬时故障自动重试）
            let navigationAttempt = 0;
            const maxNavigationAttempts = 2;
            let lastNavigationError: unknown = null;

            while (navigationAttempt < maxNavigationAttempts) {
                try {
                throwIfRequestExpired();
                const currentTimeout = Math.max(1, Math.min(timeout, remainingRequestMs(timeout)));

                if (navigationAttempt === 0) {
                    try {
                        await installOriginStorage(page, url);
                    } catch {
                        console.error("[web-fetcher] localStorage restore unavailable for this navigation");
                    }
                }

                await withRequestStage('navigation', () => page.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: currentTimeout,
                }));

                await assertPageAccessible(page, { url, waitFor: options?.waitFor, early: true });
                await this.waitForContentReady(page, currentTimeout, url);

                lastNavigationError = null;
                break; // 成功，跳出重试循环
                } catch (navErr) {
                    if (this.isTransientError(navErr)) {
                        await assertPageAccessible(page, { url, waitFor: options?.waitFor });
                    }
                    lastNavigationError = navErr;
                    navigationAttempt++;

                    if (navigationAttempt < maxNavigationAttempts && this.isTransientError(navErr)) {
                        this.lastRetryCount++;
                        const retryDelay = 3000;
                        console.error(`[web-fetcher] ⚡ 导航瞬时故障 (${navErr instanceof Error ? navErr.message.slice(0, 60) : navErr})，${retryDelay / 1000}秒后重试...`);
                        await page.waitForTimeout(retryDelay);
                    } else {
                        throw navErr; // 确定性错误或已用完重试次数
                    }
                }
            }
            if (lastNavigationError) throw lastNavigationError;

            // ========== v6.4: Stealth 自适应降级检测 ==========
        // WAF 拦截的典型表现：返回完全空白的 HTML（如 <html><head></head><body></body></html>）
        // 降级策略：Level 3 → Level 1，清除 Cookie 后用裸奔模式重试
            const domainForStealth = this.extractDomain(url);
            const isWafBlocked = await page.evaluate(() => {
            const html = document.documentElement?.outerHTML || '';
            const bodyText = (document.body?.innerText || '').trim();
            const title = (document.title || '').trim();
            // WAF 拦截特征：HTML 极短 + body 无文本内容 + 无标题
            if (html.length < 200 && bodyText.length === 0 && title.length === 0) return true;
            // 显式 400/403/412 状态码检测（某些 WAF 会显示错误码）
            if (html.length < 500) {
                const combined = title + ' ' + bodyText;
                if (/\b(400|403|412)\b/.test(combined) && /bad request|forbidden|precondition/i.test(combined)) return true;
            }
            return false;
            }).catch(() => false);

            if (isWafBlocked && !this.domainStealthLevel.has(domainForStealth)) {
            // v6.4 双 context 架构：WAF 拦截后，标记域名 → 用裸奔 context 重试
            // 主 context（L3 stealth）不受影响，其他域名继续正常 stealth
            console.error(`[web-fetcher] ⚠️ 检测到 WAF 拦截（空白页） → 切换到裸奔 context (${domainForStealth})`);

            // 关闭当前空白页
                await this.closeFailedPage(page, "waf-stealth-retry");

                // 标记该域名需要裸奔
                this.domainStealthLevel.set(domainForStealth, 1);

                // 使用裸奔 context 重新导航（递归调用会自动走 bareContext 分支）
                this.lastRetryCount++;
                console.error(`[web-fetcher] 🔄 使用裸奔 context 重新导航: ${url}`);
                return this.navigateTo(url, options);
            }

            try {

            // 如果指定了等待选择器
            if (options?.waitFor) {
                throwIfRequestExpired();
                try {
                    await page.waitForSelector(options.waitFor, { timeout: Math.max(1, Math.min(timeout, remainingRequestMs(timeout))) });
                } catch (error) {
                    await this.checkAndHandleVerification(page, url, options);
                    throw error;
                }
            }

            // 反爬随机延迟（高风控站点用更大延迟范围）
            const delayMin = isHighRisk ? HIGH_RISK_DELAY_MIN : ANTI_BOT_DELAY_MIN;
            const delayMax = isHighRisk ? HIGH_RISK_DELAY_MAX : ANTI_BOT_DELAY_MAX;
            const delay = delayMin + Math.random() * (delayMax - delayMin);
            if (!isLocalDevUrl) await page.waitForTimeout(Math.min(delay, remainingRequestMs(delay)));

            // 更新请求时间
            this.domainLastRequest.set(domain, Date.now());

            // 滚动加载
            if (options?.scrollCount && options.scrollCount > 0) {
                await this.scrollPage(page, options.scrollCount);
            }
            // v6.1: 全工具 UAV 拦截检测 — 在 navigateTo 层级统一处理
            // 无论是 screenshot、fetch-page、fetch-rich 还是其他工具，都能自动触发 UAV
            const uavPage = await this.checkAndHandleVerification(page, url, options);
            return uavPage;
            } catch (error) {
                await this.closeFailedPage(page, "post-navigation-error");
                throw error;
            }
        } catch (error) {
            await this.closeFailedPage(page, "navigation-error");
            throw error;
        }
    }

    private trackActivePage(page: Page): void {
        this.activePages.add(page);
        const screenshot = page.screenshot.bind(page);
        page.screenshot = options => withRequestStage('screenshot', () => screenshot(options));
        page.once("close", () => {
            this.activePages.delete(page);
            this.pageLeases.get(page)?.release();
            this.pageLeases.delete(page);
        });
    }

    private async createManagedPage(context: BrowserContext): Promise<Page> {
        const request = getRequestContext();
        const controller = this.admission ??= new PageAdmissionController();
        const lease = await withRequestStage('page_admission', () => controller.acquire({ ownerId: request?.ownerId ?? 'global', signal: request?.signal, deadlineAt: request?.deadline }));
        let page: Page | undefined;
        try {
            throwIfRequestExpired();
            page = await withRequestStage('page.create', () => context.newPage());
            lease.markCreated();
            this.pageLeases.set(page, lease);
            this.trackActivePage(page);
            if (page.isClosed()) throw new Error('新建页面已关闭');
            throwIfRequestExpired();
            return page;
        } catch (error) {
            if (page) await this.closeFailedPage(page, 'page-create-expired');
            else lease.release();
            throw error;
        }
    }

    async createOwnedPage(context: BrowserContext): Promise<Page> {
        return this.createManagedPage(context);
    }

    private pruneClosedActivePages(): void {
        for (const page of Array.from(this.activePages)) {
            if (page.isClosed()) {
                this.activePages.delete(page);
                this.pageLeases.get(page)?.release();
                this.pageLeases.delete(page);
            }
        }
    }

    private async closeFailedPage(page: Page, reason: string): Promise<void> {
        if (page.isClosed()) { this.pruneClosedActivePages(); return; }
        try {
            this.pageLeases.get(page)?.markClosing();
            await page.close();
        } catch {
            this.pruneClosedActivePages();
            return;
        }
        this.activePages.delete(page);
        console.error(`[web-fetcher] 已关闭失败路径页面: ${reason}`);
    }

    private isLocalDevUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol)) return false;
            const hostname = parsed.hostname.toLowerCase();
            return hostname === "localhost"
                || hostname === "127.0.0.1"
                || hostname === "::1"
                || hostname === "[::1]";
        } catch {
            return false;
        }
    }

    private withLocalDevNoCacheHeaders(headers: Record<string, string>): Record<string, string> {
        const nextHeaders = { ...headers };
        for (const key of Object.keys(nextHeaders)) {
            const normalized = key.toLowerCase();
            if (normalized === "cache-control" || normalized === "pragma" || normalized === "expires") {
                delete nextHeaders[key];
            }
        }
        return {
            ...nextHeaders,
            ...BrowserManager.LOCAL_DEV_NO_CACHE_HEADERS,
        };
    }

    private async prepareLocalDevCacheBypass(page: Page, url: string): Promise<void> {
        if (!this.isLocalDevUrl(url)) return;
        let cdpSession: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>> | null = null;
        try {
            cdpSession = await page.context().newCDPSession(page);
            await cdpSession.send("Network.enable");
            await cdpSession.send("Network.setCacheDisabled", { cacheDisabled: true });
            await cdpSession.send("Network.clearBrowserCache");
            const sessionForClose = cdpSession;
            page.once("close", () => {
                sessionForClose.detach().catch(() => undefined);
            });
            cdpSession = null;
            console.error(`[web-fetcher] 本地开发地址已禁用浏览器缓存: ${new URL(url).origin}`);
        } catch (error) {
            console.error(`[web-fetcher] 本地开发地址禁用缓存失败，继续按原流程访问: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            await cdpSession?.detach().catch(() => undefined);
        }
    }

    getPoolStats() {
        this.pruneClosedActivePages();
        const admission = this.admission?.stats();
        return {
            activePages: this.activePages.size,
            maxConcurrentPages: admission?.max ?? readPositiveIntEnv('WEB_FETCHER_MAX_CONCURRENT_PAGES', 8),
            warningThreshold: BrowserManager.PAGE_POOL_WARNING_THRESHOLD,
            isNearLimit: this.activePages.size >= BrowserManager.PAGE_POOL_WARNING_THRESHOLD,
            admission,
        };
    }

    /**
     * v6.1: 统一人机验证检测 + UAV 处理
     * 在 navigateTo 层级调用，所有工具自动受益
     * 检测逻辑：
     *   1. 收集主 frame 文本、title、script/iframe URL 和有限 HTML 快照
     *   2. 强结构信号（Cloudflare challenge / Turnstile 等）优先
     *   3. 可用正文作为反证，避免普通页面因安全脚本误弹窗
     *   4. Cookie 只作为辅助状态，不能让强挑战页直接跳过 UAV
     */
    async checkAndHandleVerification(
        page: any,
        url: string,
        options?: { timeout?: number; scrollCount?: number; waitFor?: string }
    ): Promise<any> {
        await assertPageAccessible(page, { url, waitFor: options?.waitFor });
        return page;
    }

    private hasCookieBackupForDomain(domain: string): boolean {
        try {
            if (!fs.existsSync(COOKIES_BACKUP_FILE)) return false;
            const backupCookies: any[] = JSON.parse(fs.readFileSync(COOKIES_BACKUP_FILE, 'utf-8'));
            return backupCookies.some(cookie => {
                const cookieDomain = (cookie.domain || '').replace(/^\./, '');
                return domain === cookieDomain
                    || domain.endsWith('.' + cookieDomain)
                    || cookieDomain.endsWith('.' + domain);
            });
        } catch {
            return false;
        }
    }

    /**
     * v6.1 Stage 16: 截图前视觉就绪检测
     * 等待页面中可见的图片/视频/CSS背景图加载完成
     * 
     * @param page - Playwright page 实例
     * @param maxWait - 最大等待毫秒数，默认 IMAGE_LOAD_MAX_WAIT (10000)
     * @returns 检测结果（total/ready/waited/note）
     */
    async waitForVisualReady(page: Page, maxWait: number = IMAGE_LOAD_MAX_WAIT, options: { fullPage?: boolean } = {}): Promise<ReadinessResult> {
        try { return await waitForPageReadiness(page, { mode: 'visual', maxWait, fullPage: options.fullPage }); }
        finally { this.pageLeases.get(page)?.markReady(); }
    }

    /**
     * 从 URL 提取主域名（用于限速）
     */
    private extractDomain(url: string): string {
        try {
            const hostname = new URL(url).hostname;
            // 提取主域名（如 www.reddit.com → reddit.com）
            const parts = hostname.split('.');
            if (parts.length > 2) {
                return parts.slice(-2).join('.');
            }
            return hostname;
        } catch {
            return 'unknown';
        }
    }

    /**
     * 判断是否为高风控域名
     */
    private isHighRiskDomain(domain: string): boolean {
        return HIGH_RISK_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
    }

    /**
     * 智能内容就绪检测：等待 DOM 稳定（元素数量不再增长）+ iframe 加载
     * 解决 SPA / iframe 页面（如网易云音乐）在 networkidle 后内容仍未渲染的问题
     */
    private async waitForContentReady(page: Page, timeout: number, url?: string): Promise<void> {
        const isSPA = url ? SPA_LAZY_LOAD_DOMAINS.some(domain => url.includes(domain)) : false;
        await waitForPageReadiness(page, { mode: 'content', maxWait: Math.min(timeout, isSPA ? 15000 : 8000), minimumObserveMs: isSPA ? 1000 : 500 });
        if (!/screenshot|snapshot|inspect/.test(getRequestContext()?.intent ?? '')) this.pageLeases.get(page)?.markReady();
    }

    /**
     * 滚动页面以触发懒加载内容
     */
    async scrollPage(page: Page, count: number, direction: 'up' | 'down' = 'down'): Promise<void> {
        for (let i = 0; i < count; i++) {
            try {
                const prevScroll = await page.evaluate(() => window.scrollY);
                const prevHeight = await page.evaluate(() => document.body.scrollHeight);

                if (direction === 'up') {
                    // v6.8: 向上滚动 — 用于加载 SPA 页面顶部的懒加载内容
                    await page.evaluate(() =>
                        window.scrollTo({ top: 0, behavior: "smooth" })
                    );
                } else {
                    await page.evaluate(() =>
                        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
                    );
                }

                await waitForPageReadiness(page, { mode: 'content', maxWait: 4000, minimumObserveMs: 1000 });

                const newScroll = await page.evaluate(() => window.scrollY);
                const newHeight = await page.evaluate(() => document.body.scrollHeight);

                console.error(
                    `[web-fetcher] 滚动${direction === 'up' ? '↑' : '↓'} ${i + 1}/${count}，scrollY: ${prevScroll} → ${newScroll}，页面高度: ${prevHeight} → ${newHeight}`
                );

                // 如果位置和高度都没变，说明已经到顶/到底了
                if (newScroll === prevScroll && newHeight === prevHeight) {
                    console.error(`[web-fetcher] 页面已滚动到${direction === 'up' ? '顶部' : '底部'}，停止滚动`);
                    break;
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (msg.includes('context was destroyed') || msg.includes('Execution context')) {
                    console.error(`[web-fetcher] 滚动 ${i + 1}/${count} 时页面发生导航，等待稳定后继续`);
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                    await page.waitForTimeout(1000);
                    break;
                }
                throw error;
            }
        }
    }

    // ========== UAV: 用户辅助验证 (v6.0) ==========

    /** UAV 超时时间（毫秒）— 600 秒 */
    private static UAV_TIMEOUT = 600_000;

    /**
     * 用户辅助验证（User-Assisted Verification）
     *
     * 当检测到人机验证/拦截时调用。
     * 弹出系统 Chrome 让用户手动完成验证，完成后回收 Cookie。
     *
     * @param url 需要验证的 URL
     * @returns 是否成功完成验证
     */
    async userAssistedVerification(url: string): Promise<boolean> {
        return withSuspendedRequestDeadline(() => this.performUserAssistedVerification(url), 600000);
    }

    private async performUserAssistedVerification(url: string): Promise<boolean> {
        const context = this.context;
        if (!context) return false;
        try {
            const { runLoginBrowserSession } = await import("./login-session.js");
            const result = await runLoginBrowserSession(url, {
                initialCookies: await context.cookies(),
                profilePrefix: "mcp-chrome-uav",
                maxRunMs: BrowserManager.UAV_TIMEOUT,
            });
            await this.refreshAuthState();
            const saved = Boolean(result.snapshot.savedAt)
                && (result.snapshot.savedCookieCount > 0 || result.snapshot.localStorageDomains.length > 0);
            console.error(saved
                ? "[web-fetcher] UAV storage saved; page access still requires verification"
                : "[web-fetcher] UAV storage not confirmed; recovery profile preserved when available");
            return saved;
        } catch {
            console.error("[web-fetcher] UAV could not complete; no automatic repeat login");
            return false;
        }
    }

    /**
     * 获取浏览器上下文中的 cookies
     */
    async getCookies(domain?: string): Promise<
        Array<{
            name: string;
            domain: string;
            path: string;
            expires: number;
            httpOnly: boolean;
            secure: boolean;
            sameSite: string;
        }>
    > {
        const context = await this.getContext();
        const cookies = await context.cookies();

        let filtered = cookies;
        if (domain) {
            filtered = cookies.filter(
                (c) => c.domain === domain || c.domain === `.${domain}` || c.domain.endsWith(`.${domain}`)
            );
        }

        // 返回去除实际值的 cookie 信息
        return filtered.map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
        }));
    }

    /**
     * 以有头模式启动浏览器，让用户登录
     */
    async launchLoginMode(): Promise<void> {
        const { runLoginBrowserSession } = await import("./login-session.js");
        const result = await runLoginBrowserSession("about:blank");
        await this.refreshAuthState();
        if (!result.snapshot.savedAt) throw new Error("登录窗口已结束，但未确认保存登录状态；请检查保留的恢复资料");
        console.error("[web-fetcher] 登录窗口已结束，状态已保存；站点认证有效性需要访问验证");
    }

    /**
     * 保存当前所有 Cookie 到备份文件（合并模式，保留未访问域名的 Cookie）
     */
    async saveCookies(): Promise<boolean> {
        if (!this.context) return true;
        return this.saveCookiesFromContext(this.context, "主 context");
    }

    private async saveCookiesFromContext(context: BrowserContext, label: string): Promise<boolean> {
        let saved = true;
        try {
            await this.authState.save(context);
        } catch {
            saved = false;
            console.error(`[web-fetcher] Cookie backup failed (${label})`);
        }
        try {
            if (!await this.authState.saveLocalStorage(context)) saved = false;
        } catch {
            saved = false;
            console.error(`[web-fetcher] localStorage backup failed (${label})`);
        }
        if (saved) console.error(`[web-fetcher] Cookie/localStorage changes saved (${label}); concurrent shared updates preserved`);
        return saved;
    }

    /**
     * 从备份文件恢复 Cookie
     */
    private async restoreCookies(context: BrowserContext): Promise<void> {
        try {
            await this.authState.refresh(context);
        } catch {
            console.error("[web-fetcher] Cookie restore unavailable; existing context preserved");
        }
    }

    async refreshAuthState(): Promise<void> {
        for (const context of [this.context, this.bareContext]) {
            if (context) await this.restoreCookies(context);
        }
    }

    /**
     * 关闭浏览器
     * v6.1: 关闭后清理 per-PID profile 目录
     */
    async close(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.bareContext && await this.closeContextPreservingStorage(this.bareContext, BROWSER_USER_DATA_DIR + "-bare", "bare context")) this.bareContext = null;
        if (this.context && await this.closeContextPreservingStorage(this.context, BROWSER_USER_DATA_DIR, "主 context")) this.context = null;
        this.bareLaunching = null;
        this.launching = null;
        this.pruneClosedActivePages();
        if (this.context || this.bareContext || this.activePages.size) throw new Error('浏览器关闭未确认，保留页面占用与恢复信息');
        console.error("[web-fetcher] 浏览器已关闭");
    }

    /**
     * 仅关闭浏览器释放内存，MCP 进程继续运行
     * 下次 getContext() 调用时会自动重新启动浏览器
     */
    async closeBrowser(): Promise<void> {
        await this.close();
    }

    async shutdown(): Promise<void> {
        this.admission?.dispose();
        try { await this.close(); }
        finally { await getRuntimeMemorySampler().close(); }
    }

    private closingContexts = new WeakMap<BrowserContext, Promise<boolean>>();

    private closeContextPreservingStorage(context: BrowserContext, profileDir: string, label: string): Promise<boolean> {
        const previous = this.closingContexts.get(context);
        if (previous) return previous;
        const pending = this.persistAndCloseContext(context, profileDir, label);
        this.closingContexts.set(context, pending);
        void pending.then(closed => { if (!closed) this.closingContexts.delete(context); }, () => this.closingContexts.delete(context));
        return pending;
    }

    private async persistAndCloseContext(context: BrowserContext, profileDir: string, label: string): Promise<boolean> {
        const marker = path.join(profileDir, ".web-fetcher-recovery.json");
        const alreadyRetained = fs.existsSync(marker);
        let marked = alreadyRetained;
        try {
            if (!marked) {
                fs.mkdirSync(profileDir, { recursive: true });
                fs.writeFileSync(marker, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), reason: "storage-close-pending" }), { encoding: "utf8", flag: "wx" });
                marked = true;
            }
        } catch {
            console.error(`[web-fetcher] recovery marker could not be written (${label}); profile cleanup disabled`);
        }
        const saved = await this.saveCookiesFromContext(context, label);
        let closed = false;
        try {
            await context.close();
            closed = true;
        } catch {
            console.error(`[web-fetcher] context close failed (${label}); profile retained`);
        }
        if (!saved || !closed || !marked || alreadyRetained) {
            console.error(`[web-fetcher] recovery profile retained (${label}): ${profileDir}`);
            return closed;
        }
        try {
            if (path.dirname(path.resolve(profileDir)) !== path.resolve(BROWSER_PROFILES_BASE_DIR)) throw new Error("unexpected profile directory");
            fs.rmSync(profileDir, { recursive: true, force: true });
            console.error(`[web-fetcher] 已清理 profile: ${profileDir}`);
        } catch {
            console.error(`[web-fetcher] profile cleanup incomplete (${label}); recovery marker retained when available`);
        }
        return closed;
    }

    /**
     * 重置浏览器空闲超时计时器
     */
    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
            if (getActiveRequestCount() > 0 || this.activePages.size > 0) this.resetIdleTimer();
            else void this.closeBrowser().catch(error => console.error('[web-fetcher] idle close failed', error));
        }, BrowserManager.BROWSER_IDLE_TIMEOUT);
        this.idleTimer.unref();
    }

    /**
     * v6.1: 迁移旧版 Cookie 备份文件
     * 旧版: mcp-web-fetcher-profile/cookies-backup.json（单一 profile 目录下）
     * 新版: mcp-web-fetcher-profiles/cookies-backup.json（共享基础目录下）
     */
    private migrateOldCookieBackup(): void {
        const oldBackupPath = path.join(
            path.dirname(BROWSER_PROFILES_BASE_DIR),
            "mcp-web-fetcher-profile",
            "cookies-backup.json"
        );

        if (fs.existsSync(oldBackupPath) && !fs.existsSync(COOKIES_BACKUP_FILE)) {
            try {
                // 确保新目录存在
                if (!fs.existsSync(BROWSER_PROFILES_BASE_DIR)) {
                    fs.mkdirSync(BROWSER_PROFILES_BASE_DIR, { recursive: true });
                }
                fs.copyFileSync(oldBackupPath, COOKIES_BACKUP_FILE);
                console.error(`[web-fetcher] 已迁移旧 Cookie 备份 → ${COOKIES_BACKUP_FILE}`);
            } catch (err) {
                console.error("[web-fetcher] Cookie 备份迁移失败:", err);
            }
        }
    }

    /**
     * v6.1: 清理已死进程留下的孤儿 profile 目录
     * profile 目录命名格式: profile-{PID}
     * 如果对应 PID 的进程不存在，则清理该目录
     */
    private cleanStaleProfiles(): void {
        if (!fs.existsSync(BROWSER_PROFILES_BASE_DIR)) return;

        try {
            const entries = fs.readdirSync(BROWSER_PROFILES_BASE_DIR);
            let cleaned = 0;

            for (const entry of entries) {
                const match = entry.match(/^profile-(\d+)$/);
                if (!match) continue;

                const pid = parseInt(match[1]);
                if (pid === process.pid) continue; // 不清理自己的
                const staleDir = path.join(BROWSER_PROFILES_BASE_DIR, entry);
                if (fs.existsSync(path.join(staleDir, ".web-fetcher-recovery.json"))) continue;
                if (fs.lstatSync(staleDir).isSymbolicLink()) continue;

                // 检查进程是否存活
                let alive = false;
                try {
                    process.kill(pid, 0); // signal 0 只检测不杀
                    alive = true;
                } catch (error: any) {
                    alive = error?.code !== "ESRCH";
                }

                if (!alive) {
                    try {
                        fs.rmSync(staleDir, { recursive: true, force: true });
                        cleaned++;
                    } catch { /* 文件锁等原因无法清理，跳过 */ }
                }
            }

            if (cleaned > 0) {
                console.error(`[web-fetcher] 已清理 ${cleaned} 个孤儿 profile 目录`);
            }
        } catch { /* readdir 失败，跳过 */ }
    }

    /**
     * 清理 Profile 中的非关键缓存目录
     * 保留 Cookies、Local Storage、IndexedDB 等登录态相关数据
     * 注意：必须在浏览器启动前调用（运行时目录被锁定无法删除）
     */
    private cleanProfileCache(): void {
        const SAFE_CLEAN_DIRS = [
            "Service Worker",
            "Cache",
            "Code Cache",
            "GPUCache",
            "GrShaderCache",
            "ShaderCache",
            "DawnGraphiteCache",
            "DawnWebGPUCache",
            "blob_storage",
            "Session Storage",
            "Crashpad",
            "BrowserMetrics",
            "WebStorage",
            "shared_proto_db",
            "optimization_guide_model_store",
            "component_crx_cache",
        ];

        let cleanedCount = 0;

        const cleanDir = (basePath: string) => {
            for (const dirName of SAFE_CLEAN_DIRS) {
                const dirPath = path.join(basePath, dirName);
                try {
                    if (fs.existsSync(dirPath)) {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        cleanedCount++;
                    }
                } catch {
                    // 权限问题，跳过
                }
            }
        };

        cleanDir(BROWSER_USER_DATA_DIR);
        const defaultDir = path.join(BROWSER_USER_DATA_DIR, "Default");
        if (fs.existsSync(defaultDir)) {
            cleanDir(defaultDir);
        }

        if (cleanedCount > 0) {
            console.error(
                `[web-fetcher] Profile 缓存已清理: ${cleanedCount} 个目录`
            );
        }
    }
}

// 导出单例
export const browserManager = new BrowserManager();

// 注意: 进程退出清理已在 index.ts 中统一处理，此处不再注册重复的事件处理器
