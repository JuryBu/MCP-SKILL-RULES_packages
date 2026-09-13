import { randomUUID } from "crypto";
import {
    cleanupTempProfile,
    connectCDP,
    launchSystemChrome,
    recoverClosedChromeStorage,
    terminateOwnedChrome,
    type BrowserStorageSnapshotResult,
    type ChromeLaunchResult,
} from "../chrome-helper.js";
import { StorageSnapshotTracker } from "../storage-snapshot-tracker.js";
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
    storageSnapshot?: {
        cookieCount: number;
        mergedCookieCount?: number;
        savedCookieCount?: number;
        savedAt?: string;
        capturedAt?: string;
        recoveryPending?: boolean;
        localStorageDomains: Array<{ domain: string; keyCount: number }>;
        errors: string[];
    };
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
    tracker: StorageSnapshotTracker;
    startUrl: string;
    recovery?: Promise<void>;
    recoveredSnapshot?: BrowserStorageSnapshotResult;
    recoveryPending: boolean;
    removeListeners: () => void;
    closing?: Promise<boolean>;
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
        let desktopSessionId: string | undefined;
        let cdpBrowser: any;
        let session: HumanBrowserSession | undefined;
        try {
            await waitForCdpReady(chrome.cdpPort, params.waitMs ?? 2500);
            const connected = await desktopManager.connectCdp({ port: chrome.cdpPort, ownerId });
            desktopSessionId = connected.desktopSessionId;
            cdpBrowser = await connectCDP(chrome.cdpPort);
            session = await this.createSession({
                ownerId,
                desktopSessionId: connected.desktopSessionId,
                source: "managed-chrome",
                chrome,
                cdpBrowser,
                cdpPort: chrome.cdpPort,
                endpoint: `http://127.0.0.1:${chrome.cdpPort}`,
                startUrl: params.startUrl ?? "about:blank",
            });
            return await this.describe(session.id, ownerId);
        } catch (error) {
            if (session) {
                session.removeListeners();
                await session.tracker.stop().catch(() => undefined);
                this.sessions.delete(session.id);
            }
            if (desktopSessionId) await desktopManager.close(desktopSessionId, ownerId).catch(() => false);
            if (cdpBrowser) await cdpBrowser.close().catch(() => undefined);
            terminateOwnedChrome(chrome);
            throw new Error(`${error instanceof Error ? error.message : String(error)}; owned recovery profile retained: ${chrome.tempProfile}`);
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
        let cdpBrowser: any;
        let session: HumanBrowserSession | undefined;
        try {
            cdpBrowser = params.port ? await connectCDP(params.port) : await connectEndpoint(endpoint);
            session = await this.createSession({
                ownerId,
                desktopSessionId: connected.desktopSessionId,
                source: "cdp-attach",
                cdpBrowser,
                cdpPort: params.port,
                endpoint,
            });
            return await this.describe(session.id, ownerId);
        } catch (error) {
            if (session) {
                session.removeListeners();
                await session.tracker.stop().catch(() => undefined);
                this.sessions.delete(session.id);
            }
            await desktopManager.close(connected.desktopSessionId, ownerId).catch(() => false);
            if (cdpBrowser) await cdpBrowser.close().catch(() => undefined);
            throw error;
        }
    }

    async describe(humanSessionId: string, ownerId?: string): Promise<HumanBrowserSessionInfo> {
        const session = this.getSession(humanSessionId, ownerId);
        await this.recoverExitedSession(session);
        const pages = await this.refreshPages(session);
        const storageSnapshot = await this.snapshotStorage(session, "human-status");
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
            cookieCount: storageSnapshot.cookieCount,
            storageSnapshot: { ...this.publicStorageSnapshot(storageSnapshot), recoveryPending: session.recoveryPending },
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
        await this.snapshotStorage(session, "human-register-page");
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
        return session.closing ??= this.finishSession(session, true);
    }

    async detach(humanSessionId: string, ownerId?: string): Promise<boolean> {
        const session = this.sessions.get(humanSessionId);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId)) return false;
        return session.closing ??= this.finishSession(session, false);
    }

    private async finishSession(session: HumanBrowserSession, terminate: boolean): Promise<boolean> {
        session.removeListeners();
        await this.recoverExitedSession(session);
        const capturedBeforeClose = session.cdpBrowser.isConnected();
        await session.tracker.stop(capturedBeforeClose ? "human-close" : undefined);
        if (session.recovery) await session.recovery;
        const snapshot = this.storageSummary(session);
        let profileRetained = Boolean(session.chrome);
        if (terminate && session.chrome && session.cdpBrowser.isConnected()) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                (async () => {
                    const control = await session.cdpBrowser.newBrowserCDPSession();
                    await control.send("Browser.close");
                })().catch(() => undefined),
                new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); timer.unref(); }),
            ]).finally(() => { if (timer) clearTimeout(timer); });
        }
        for (const sessionId of session.registeredSessionIds.values()) {
            await sessionManager.close(sessionId, session.ownerId).catch(() => false);
        }
        await desktopManager.close(session.desktopSessionId, session.ownerId).catch(() => false);
        await session.cdpBrowser.close().catch(() => undefined);
        if (terminate && session.chrome) {
            terminateOwnedChrome(session.chrome);
            const exited = await this.waitForOwnedExit(session.chrome);
            if (exited && (capturedBeforeClose || session.recoveredSnapshot?.savedAt)
                && snapshot.savedAt && ((snapshot.savedCookieCount ?? 0) > 0 || snapshot.localStorageDomains.length > 0)
                && snapshot.errors.length === 0 && session.recoveredSnapshot?.recoveryBrowserClosed !== false) {
                cleanupTempProfile(session.chrome.tempProfile);
                profileRetained = false;
            }
        }
        if (!terminate && session.chrome) session.chrome.process.unref();
        logHumanVerificationAudit({
            phase: "detached",
            ownerId: session.ownerId,
            humanSessionId: session.id,
            metadata: { source: session.source, savedAt: snapshot.savedAt, storageErrors: snapshot.errors.length,
                profileRetained },
        });
        this.sessions.delete(session.id);
        return true;
    }

    private async waitForOwnedExit(chrome: ChromeLaunchResult): Promise<boolean> {
        if (chrome.process.exitCode !== null || chrome.process.signalCode !== null) return true;
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                chrome.process.removeListener("exit", finish);
                resolve(chrome.process.exitCode !== null || chrome.process.signalCode !== null);
            };
            const timer = setTimeout(finish, 5000);
            timer.unref();
            chrome.process.once("exit", finish);
        });
    }

    async closeAll(): Promise<void> {
        for (const session of Array.from(this.sessions.values())) {
            await this.close(session.id, session.ownerId).catch(() => undefined);
        }
    }

    private async createSession(params: Pick<HumanBrowserSession,
        "ownerId" | "desktopSessionId" | "source" | "chrome" | "cdpBrowser" | "cdpPort" | "endpoint"> & { startUrl?: string }): Promise<HumanBrowserSession> {
        const id = `human_${randomUUID()}`;
        const contexts = () => {
            if (!params.cdpBrowser.isConnected()) throw new Error("human browser disconnected");
            const active = params.cdpBrowser.contexts();
            if (!active.length) throw new Error("human browser contexts unavailable");
            return active;
        };
        let session: HumanBrowserSession;
        const tracker = new StorageSnapshotTracker({
            cookies: async () => {
                const cookies: any[] = [];
                for (const context of contexts()) cookies.push(...await context.cookies());
                return cookies;
            },
            pages: () => {
                const pages = contexts().flatMap((context: any) => context.pages());
                for (const page of pages) {
                    const url = page.url();
                    if (session && /^https?:\/\//.test(url)) session.startUrl = url;
                }
                return pages;
            },
        }, { reasonPrefix: "human-browser" });
        session = {
            id,
            createdAt: Date.now(),
            lastAccess: Date.now(),
            ...params,
            pages: new Map(),
            registeredSessionIds: new Map(),
            tracker,
            startUrl: params.startUrl ?? params.cdpBrowser.contexts()[0]?.pages()[0]?.url() ?? "about:blank",
            recoveryPending: false,
            removeListeners: () => undefined,
        };
        this.sessions.set(id, session);
        const disconnected = () => {
            void tracker.stop().catch(() => undefined);
            void this.recoverExitedSession(session).catch(() => undefined);
        };
        params.cdpBrowser.once("disconnected", disconnected);
        params.chrome?.process.once("exit", disconnected);
        session.removeListeners = () => {
            params.cdpBrowser.removeListener("disconnected", disconnected);
            params.chrome?.process.removeListener("exit", disconnected);
        };
        try {
            await tracker.start();
        } catch (error) {
            session.removeListeners();
            await tracker.stop().catch(() => undefined);
            this.sessions.delete(id);
            throw error;
        }
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
        const activePages = session.cdpBrowser.isConnected()
            ? session.cdpBrowser.contexts().flatMap((context: any) => context.pages()) : [];
        for (const [pageId, page] of Array.from(session.pages.entries())) {
            if (!activePages.includes(page) || page.isClosed()) {
                const registered = session.registeredSessionIds.get(pageId);
                if (registered) await sessionManager.close(registered, session.ownerId).catch(() => false);
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
            if (/^https?:\/\//.test(url)) session.startUrl = url;
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

    private async snapshotStorage(session: HumanBrowserSession, reason: string): Promise<BrowserStorageSnapshotResult> {
        if (session.cdpBrowser.isConnected() && !session.closing) await session.tracker.capture(reason);
        return this.storageSummary(session);
    }

    private storageSummary(session: HumanBrowserSession): BrowserStorageSnapshotResult {
        const tracked = session.tracker.summary();
        const recovered = session.recoveredSnapshot;
        if (!recovered) return tracked;
        if (recovered.savedAt && (!tracked.savedAt || recovered.savedAt >= tracked.savedAt)) {
            const origins = new Map(tracked.localStorageDomains.map(entry => [entry.domain, entry]));
            for (const entry of recovered.localStorageDomains) origins.set(entry.domain, entry);
            return {
                ...tracked,
                ...recovered,
                cookies: (recovered.savedCookieCount ?? 0) > 0 ? recovered.cookies : tracked.cookies,
                cookieCount: (recovered.savedCookieCount ?? 0) > 0 ? recovered.cookieCount : tracked.cookieCount,
                savedCookieCount: (recovered.savedCookieCount ?? 0) > 0 ? recovered.savedCookieCount : tracked.savedCookieCount,
                localStorageDomains: [...origins.values()],
            };
        }
        return { ...tracked, errors: [...new Set([...tracked.errors, ...recovered.errors])] };
    }

    private async recoverExitedSession(session: HumanBrowserSession): Promise<void> {
        if (!session.chrome || (session.chrome.process.exitCode === null && session.chrome.process.signalCode === null)) return;
        if (!session.recovery) {
            session.recoveryPending = true;
            session.recovery = (async () => {
                await session.tracker.stop();
                session.recoveredSnapshot = await recoverClosedChromeStorage(session.chrome!, session.startUrl);
            })().catch(() => {
                const summary = session.tracker.summary();
                session.recoveredSnapshot = { ...summary, errors: [...summary.errors, "owned profile recovery failed; profile retained"] };
            }).finally(() => {
                session.recoveryPending = false;
                session.removeListeners();
            });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            session.recovery,
            new Promise<void>(resolve => { timer = setTimeout(resolve, 20_000); timer.unref(); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
    }

    private publicStorageSnapshot(snapshot: BrowserStorageSnapshotResult): NonNullable<HumanBrowserSessionInfo["storageSnapshot"]> {
        return {
            cookieCount: snapshot.cookieCount,
            mergedCookieCount: snapshot.mergedCookieCount,
            savedCookieCount: snapshot.savedCookieCount,
            savedAt: snapshot.savedAt,
            capturedAt: snapshot.capturedAt,
            localStorageDomains: snapshot.localStorageDomains,
            errors: snapshot.errors,
        };
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
