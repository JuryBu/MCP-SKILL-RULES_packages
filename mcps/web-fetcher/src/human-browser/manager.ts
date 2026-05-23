import { randomUUID } from "crypto";
import {
    cleanupTempProfile,
    connectCDP,
    launchSystemChrome,
    terminateOwnedChrome,
    type ChromeLaunchResult,
} from "../chrome-helper.js";
import { desktopManager } from "../desktop/manager.js";
import { normalizeOwnerId } from "../session.js";
import { sessionManager } from "../session.js";
import { detectHumanVerificationSignals, type HumanVerificationDetection } from "../human-verification.js";
import { logHumanVerificationAudit } from "../human-audit.js";

export interface HumanBrowserPageInfo {
    humanSessionId: string;
    pageId: string;
    title?: string;
    url?: string;
    registeredSessionId?: string;
    alive: boolean;
    challenge?: HumanVerificationDetection;
}

export interface HumanBrowserSessionInfo {
    humanSessionId: string;
    ownerId: string;
    desktopSessionId: string;
    source: "managed-chrome" | "cdp-attach";
    cdpPort?: number;
    endpoint?: string;
    createdAt: number;
    lastAccess: number;
    alive: boolean;
    cookieCount?: number;
    pages: HumanBrowserPageInfo[];
}

interface HumanBrowserSession {
    id: string;
    ownerId: string;
    desktopSessionId: string;
    source: "managed-chrome" | "cdp-attach";
    chrome?: ChromeLaunchResult;
    cdpBrowser: any;
    cdpPort?: number;
    endpoint?: string;
    createdAt: number;
    lastAccess: number;
    pages: Map<string, any>;
    registeredSessionIds: Map<string, string>;
}

class HumanBrowserManager {
    private sessions = new Map<string, HumanBrowserSession>();

    async open(params: {
        startUrl?: string;
        ownerId?: string;
        waitMs?: number;
    }): Promise<HumanBrowserSessionInfo> {
        const ownerId = normalizeOwnerId(params.ownerId);
        const chrome = await launchSystemChrome({
            startUrl: params.startUrl ?? "about:blank",
            profilePrefix: "mcp-chrome-human",
        });
        try {
            await waitForCdpReady(chrome.cdpPort, params.waitMs ?? 2500);
            const connected = await desktopManager.connectCdp({ port: chrome.cdpPort, ownerId });
            const cdpBrowser = await connectCDP(chrome.cdpPort);
            const session = this.createSession({
                ownerId,
                desktopSessionId: connected.desktopSessionId,
                source: "managed-chrome",
                chrome,
                cdpBrowser,
                cdpPort: chrome.cdpPort,
                endpoint: `http://127.0.0.1:${chrome.cdpPort}`,
            });
            return this.describe(session.id, ownerId);
        } catch (error) {
            terminateOwnedChrome(chrome);
            cleanupTempProfile(chrome.tempProfile);
            throw error;
        }
    }

    async attach(params: {
        endpoint?: string;
        port?: number;
        ownerId?: string;
    }): Promise<HumanBrowserSessionInfo> {
        const ownerId = normalizeOwnerId(params.ownerId);
        const endpoint = params.endpoint ?? (params.port ? `http://127.0.0.1:${params.port}` : undefined);
        if (!endpoint) throw new Error("web_human_browser_attach requires endpoint or port");
        const connected = await desktopManager.connectCdp({ endpoint, ownerId });
        const cdpBrowser = params.port ? await connectCDP(params.port) : await connectEndpoint(endpoint);
        const session = this.createSession({
            ownerId,
            desktopSessionId: connected.desktopSessionId,
            source: "cdp-attach",
            cdpBrowser,
            cdpPort: params.port,
            endpoint,
        });
        return this.describe(session.id, ownerId);
    }

    async describe(humanSessionId: string, ownerId?: string): Promise<HumanBrowserSessionInfo> {
        const session = this.getSession(humanSessionId, ownerId);
        const pages = await this.refreshPages(session);
        session.lastAccess = Date.now();
        return {
            humanSessionId: session.id,
            ownerId: session.ownerId,
            desktopSessionId: session.desktopSessionId,
            source: session.source,
            cdpPort: session.cdpPort,
            endpoint: session.endpoint,
            createdAt: session.createdAt,
            lastAccess: session.lastAccess,
            alive: pages.some(page => page.alive),
            cookieCount: await this.cookieCount(session),
            pages,
        };
    }

    async registerPage(humanSessionId: string, pageId: string | undefined, ownerId?: string): Promise<{
        humanSessionId: string;
        sessionId: string;
        page: HumanBrowserPageInfo;
    }> {
        const session = this.getSession(humanSessionId, ownerId);
        const info = await this.describe(humanSessionId, session.ownerId);
        const target = pageId
            ? info.pages.find(page => page.pageId === pageId)
            : info.pages.find(page => page.url && page.url !== "about:blank") ?? info.pages[0];
        if (!target) throw new Error(`human browser session ${humanSessionId} has no CDP page`);
        const targetPage = session.pages.get(target.pageId);
        if (!targetPage) throw new Error(`human browser page ${target.pageId} 不存在或已关闭`);
        let sessionId = session.registeredSessionIds.get(target.pageId);
        if (!sessionId) {
            sessionId = sessionManager.registerPage(targetPage, session.ownerId, {
                ownership: "borrowed",
                closePolicy: "noop",
                browserSource: "cdp-attach-live",
            });
            session.registeredSessionIds.set(target.pageId, sessionId);
        }
        logHumanVerificationAudit({
            phase: "live_session_reused",
            url: target.url,
            ownerId: session.ownerId,
            humanSessionId,
            sessionId,
            pageId: target.pageId,
            metadata: {
                source: session.source,
                closePolicy: "noop",
            },
        });
        const refreshed = await this.describe(humanSessionId, session.ownerId);
        const refreshedPage = refreshed.pages.find(item => item.pageId === target.pageId) ?? target;
        return {
            humanSessionId,
            sessionId,
            page: {
                ...refreshedPage,
                registeredSessionId: sessionId,
            },
        };
    }

    async close(humanSessionId: string, ownerId?: string): Promise<boolean> {
        const session = this.sessions.get(humanSessionId);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId)) return false;
        await this.detach(humanSessionId, session.ownerId).catch(() => false);
        if (session.chrome) {
            terminateOwnedChrome(session.chrome);
            cleanupTempProfile(session.chrome.tempProfile);
        }
        return true;
    }

    async detach(humanSessionId: string, ownerId?: string): Promise<boolean> {
        const session = this.sessions.get(humanSessionId);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId)) return false;
        for (const sessionId of session.registeredSessionIds.values()) {
            await sessionManager.close(sessionId, session.ownerId).catch(() => false);
        }
        await desktopManager.close(session.desktopSessionId, session.ownerId).catch(() => false);
        if (session.source === "managed-chrome") {
            await session.cdpBrowser.close().catch(() => undefined);
        }
        logHumanVerificationAudit({
            phase: "detached",
            ownerId: session.ownerId,
            humanSessionId,
            metadata: { source: session.source },
        });
        this.sessions.delete(humanSessionId);
        return true;
    }

    async closeAll(): Promise<void> {
        for (const session of Array.from(this.sessions.values())) {
            await this.close(session.id, session.ownerId).catch(() => undefined);
        }
    }

    private createSession(params: Omit<HumanBrowserSession, "id" | "createdAt" | "lastAccess" | "pages" | "registeredSessionIds">): HumanBrowserSession {
        const id = `human_${randomUUID()}`;
        const session: HumanBrowserSession = {
            id,
            createdAt: Date.now(),
            lastAccess: Date.now(),
            ...params,
            pages: new Map(),
            registeredSessionIds: new Map(),
        };
        this.sessions.set(id, session);
        return session;
    }

    private getSession(humanSessionId: string, ownerId?: string): HumanBrowserSession {
        const session = this.sessions.get(humanSessionId);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId)) {
            throw new Error(`human browser session ${humanSessionId} 不存在、已关闭或 ownerId 不匹配`);
        }
        return session;
    }

    private async refreshPages(session: HumanBrowserSession): Promise<HumanBrowserPageInfo[]> {
        const activePages = session.cdpBrowser.contexts().flatMap((context: any) => context.pages());
        for (const [pageId, page] of Array.from(session.pages.entries())) {
            if (!activePages.includes(page) || page.isClosed()) {
                session.pages.delete(pageId);
                session.registeredSessionIds.delete(pageId);
            }
        }
        for (const page of activePages) {
            if ([...session.pages.values()].includes(page)) continue;
            session.pages.set(`human_page_${randomUUID()}`, page);
        }

        const result: HumanBrowserPageInfo[] = [];
        for (const [pageId, page] of session.pages.entries()) {
            const alive = !page.isClosed();
            const title = alive ? await page.title().catch(() => "") : "";
            const url = alive ? page.url() : "";
            result.push({
                humanSessionId: session.id,
                pageId,
                title,
                url,
                registeredSessionId: session.registeredSessionIds.get(pageId),
                alive,
                challenge: alive ? await this.detectPageChallenge(page).catch(() => undefined) : undefined,
            });
        }
        return result;
    }

    private async detectPageChallenge(page: any): Promise<HumanVerificationDetection> {
        const snapshot = await page.evaluate(() => ({
            title: document.title || "",
            visibleText: document.body?.innerText || "",
            html: (document.documentElement?.outerHTML || "").slice(0, 120_000),
            scriptUrls: Array.from(document.scripts).map(script => script.src || "").filter(Boolean),
            iframeUrls: Array.from(document.querySelectorAll("iframe")).map(iframe => iframe.getAttribute("src") || "").filter(Boolean),
        })).catch(() => ({
            title: "",
            visibleText: "",
            html: "",
            scriptUrls: [] as string[],
            iframeUrls: [] as string[],
        }));
        return detectHumanVerificationSignals({
            url: page.url(),
            title: snapshot.title,
            visibleText: snapshot.visibleText,
            html: snapshot.html,
            scriptUrls: snapshot.scriptUrls,
            iframeUrls: snapshot.iframeUrls,
        });
    }

    private async cookieCount(session: HumanBrowserSession): Promise<number> {
        try {
            const counts = await Promise.all(session.cdpBrowser.contexts().map((context: any) => context.cookies().then((cookies: any[]) => cookies.length).catch(() => 0)));
            return counts.reduce((sum, count) => sum + count, 0);
        } catch {
            return 0;
        }
    }
}

async function connectEndpoint(endpoint: string): Promise<any> {
    const { chromium } = await import("playwright");
    return chromium.connectOverCDP(endpoint);
}

async function waitForCdpReady(port: number, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`CDP endpoint did not become ready on port ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export const humanBrowserManager = new HumanBrowserManager();
