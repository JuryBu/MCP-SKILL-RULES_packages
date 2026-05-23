import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import type { Browser, ElectronApplication, Page } from "playwright";
import { chromium, _electron as electron } from "playwright";
import { ensureTempDirs, generateCacheKey, TEMP_DIRS } from "../temp-store.js";
import { normalizeOwnerId, sessionManager } from "../session.js";
import { extractDomStructureFromPage } from "../inspector/dom-inspector.js";
import type { PageStructure } from "../inspector/types.js";
import {
    inspectNativeWindow,
    interactNativeWindow,
    listNativeWindows,
    screenshotNativeWindow,
    type NativeInspectResult,
    type NativeWindowInfo,
} from "./native-windows.js";

export type DesktopSessionKind = "electron" | "cdp" | "native";
export type DesktopTargetKind = "renderer-page" | "cdp-target" | "native-window";

export interface DesktopWindowInfo {
    desktopSessionId: string;
    windowId: string;
    targetKind: DesktopTargetKind;
    title: string;
    url?: string;
    handle?: number;
    processId?: number;
    bounds?: { x: number; y: number; width: number; height: number };
    registeredSessionId?: string;
}

interface DesktopWindowRecord extends DesktopWindowInfo {
    page?: Page;
}

interface DesktopSession {
    id: string;
    ownerId: string;
    kind: DesktopSessionKind;
    createdAt: number;
    lastAccess: number;
    app?: ElectronApplication;
    cdpBrowser?: Browser;
    process?: ChildProcess;
    processId?: number;
    windows: Map<string, DesktopWindowRecord>;
}

export interface DesktopLaunchParams {
    kind: "electron" | "native";
    executablePath: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    ownerId?: string;
    timeout?: number;
}

export interface DesktopConnectCdpParams {
    endpoint?: string;
    port?: number;
    ownerId?: string;
}

export interface DesktopInspectResult {
    desktopSessionId: string;
    windowId: string;
    targetKind: DesktopTargetKind;
    mode: string;
    domStructure?: PageStructure[];
    accessibilityTree?: unknown;
    domSnapshot?: unknown;
    nativeTree?: NativeInspectResult;
    visualTree?: {
        source: "visual-window";
        screenshotPath: string;
        confidence: "screenshot-only";
        note: string;
    };
}

export interface DesktopScreenshotResult {
    desktopSessionId: string;
    windowId: string;
    targetKind: DesktopTargetKind;
    path: string;
    method: string;
}

const SESSION_TIMEOUT = 20 * 60 * 1000;

function mergeStringEnv(env?: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") merged[key] = value;
    }
    const result = { ...merged, ...(env ?? {}) };
    if (process.platform === "win32") {
        const systemRoot = result.SystemRoot || result.SYSTEMROOT || result.windir || result.WINDIR || "C:\\Windows";
        const systemPath = `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem;${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\`;
        const pathValue = result.Path || result.PATH || systemPath;
        const normalizedPath = pathValue.toLowerCase().includes(`${systemRoot.toLowerCase()}\\system32`)
            ? pathValue
            : `${systemPath};${pathValue}`;
        result.Path = normalizedPath;
        result.PATH = normalizedPath;
        result.ComSpec = result.ComSpec || result.COMSPEC || `${systemRoot}\\System32\\cmd.exe`;
        result.COMSPEC = result.ComSpec;
        result.SystemRoot = systemRoot;
        result.SYSTEMROOT = systemRoot;
        result.windir = result.windir || systemRoot;
        result.WINDIR = result.windir;
    }
    return result;
}

class DesktopManager {
    private sessions = new Map<string, DesktopSession>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.cleanupTimer = setInterval(() => void this.cleanup(), 60_000);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    async launch(params: DesktopLaunchParams): Promise<{ desktopSessionId: string; windows: DesktopWindowInfo[] }> {
        const ownerId = normalizeOwnerId(params.ownerId);
        if (params.kind === "electron") {
            const app = await electron.launch({
                executablePath: params.executablePath,
                args: params.args ?? [],
                cwd: params.cwd,
                env: mergeStringEnv(params.env),
                timeout: params.timeout ?? 30_000,
            });
            const id = this.createSession("electron", ownerId, { app, processId: app.process().pid });
            const first = await app.firstWindow({ timeout: params.timeout ?? 30_000 }).catch(() => null);
            if (first) this.upsertPageWindow(this.sessions.get(id)!, first, "renderer-page");
            for (const page of app.windows()) {
                this.upsertPageWindow(this.sessions.get(id)!, page, "renderer-page");
            }
            return { desktopSessionId: id, windows: await this.listWindows(id, ownerId) };
        }

        const child = spawn(params.executablePath, params.args ?? [], {
            cwd: params.cwd,
            env: mergeStringEnv(params.env),
            stdio: "ignore",
            windowsHide: false,
        });
        const launchDelay = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, Math.min(params.timeout ?? 1500, 5000));
            child.once("error", error => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once("exit", code => {
                if (code !== null && code !== 0) {
                    clearTimeout(timeout);
                    reject(new Error(`native process exited during launch with code ${code}`));
                }
            });
        });
        try {
            await launchDelay;
        } catch (error) {
            child.kill();
            throw error;
        }
        const id = this.createSession("native", ownerId, { process: child, processId: child.pid });
        await this.refreshNativeWindows(this.sessions.get(id)!);
        return { desktopSessionId: id, windows: await this.listWindows(id, ownerId) };
    }

    async connectCdp(params: DesktopConnectCdpParams): Promise<{ desktopSessionId: string; windows: DesktopWindowInfo[] }> {
        const ownerId = normalizeOwnerId(params.ownerId);
        const endpoint = params.endpoint ?? (params.port ? `http://127.0.0.1:${params.port}` : "");
        if (!endpoint) throw new Error("desktop_connect_cdp requires endpoint or port");
        const browser = await chromium.connectOverCDP(endpoint);
        const id = this.createSession("cdp", ownerId, { cdpBrowser: browser });
        await this.refreshCdpWindows(this.sessions.get(id)!);
        return { desktopSessionId: id, windows: await this.listWindows(id, ownerId) };
    }

    async listWindows(desktopSessionId: string, ownerId?: string): Promise<DesktopWindowInfo[]> {
        const session = this.getSession(desktopSessionId, ownerId);
        await this.refreshWindows(session);
        await Promise.all(Array.from(session.windows.values()).map(async window => {
            if (window.page) {
                window.title = await window.page.title().catch(() => window.title || window.url || window.windowId);
                window.url = window.page.url();
            }
        }));
        return Array.from(session.windows.values()).map(window => ({
            desktopSessionId: window.desktopSessionId,
            windowId: window.windowId,
            targetKind: window.targetKind,
            title: window.title,
            url: window.url,
            handle: window.handle,
            processId: window.processId,
            bounds: window.bounds,
            registeredSessionId: window.registeredSessionId,
        }));
    }

    async registerWindow(desktopSessionId: string, windowId: string, ownerId?: string): Promise<{ sessionId: string; window: DesktopWindowInfo }> {
        const session = this.getSession(desktopSessionId, ownerId);
        await this.refreshWindows(session);
        const window = this.getWindow(session, windowId);
        if (!window.page) {
            throw new Error(`window ${windowId} is ${window.targetKind}; only renderer/cdp pages can be registered as web sessions`);
        }
        if (!window.registeredSessionId) {
            window.registeredSessionId = sessionManager.registerPage(window.page, session.ownerId, {
                ownership: "borrowed",
                closePolicy: "noop",
                browserSource: session.kind === "cdp" ? "cdp-attach-live" : "external-page",
            });
        }
        return { sessionId: window.registeredSessionId, window };
    }

    async inspect(desktopSessionId: string, windowId: string, mode: string, ownerId?: string): Promise<DesktopInspectResult> {
        const session = this.getSession(desktopSessionId, ownerId);
        await this.refreshWindows(session);
        const window = this.getWindow(session, windowId);
        const result: DesktopInspectResult = {
            desktopSessionId,
            windowId,
            targetKind: window.targetKind,
            mode,
        };
        if (window.page) {
            if (mode === "structure" || mode === "all") {
                result.domStructure = await extractDomStructureFromPage(window.page);
            }
            if (mode === "accessibility" || mode === "all") {
                const cdp = await window.page.context().newCDPSession(window.page);
                result.accessibilityTree = await cdp.send("Accessibility.getFullAXTree").catch(error => ({ error: String(error) }));
                result.domSnapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
                    computedStyles: ["display", "visibility", "opacity", "z-index"],
                }).catch(error => ({ error: String(error) }));
                await cdp.detach().catch(() => undefined);
            }
            return result;
        }
        if (window.handle && (mode === "native" || mode === "structure" || mode === "all")) {
            result.nativeTree = await inspectNativeWindow(window.handle);
        }
        if (window.handle && (mode === "visual" || mode === "all")) {
            const shot = await this.screenshot(desktopSessionId, windowId, ownerId);
            result.visualTree = {
                source: "visual-window",
                screenshotPath: shot.path,
                confidence: "screenshot-only",
                note: "OCR and image matching are intentionally marked as fallback work; this result contains the raw window screenshot only.",
            };
        }
        return result;
    }

    async screenshot(desktopSessionId: string, windowId: string, ownerId?: string, fullPage = false): Promise<DesktopScreenshotResult> {
        const session = this.getSession(desktopSessionId, ownerId);
        await this.refreshWindows(session);
        const window = this.getWindow(session, windowId);
        ensureTempDirs();
        const path = `${TEMP_DIRS.screenshots}\\${generateCacheKey("desktop", desktopSessionId, windowId, Date.now())}${window.page ? ".jpg" : ".png"}`;
        if (window.page) {
            await window.page.screenshot({ path, type: "jpeg", quality: 85, fullPage });
            return { desktopSessionId, windowId, targetKind: window.targetKind, path, method: "playwright-page" };
        }
        if (window.handle) {
            const native = await screenshotNativeWindow(window.handle, path);
            return { desktopSessionId, windowId, targetKind: window.targetKind, path: native.path, method: native.method };
        }
        throw new Error(`window ${windowId} has no screenshot-capable target`);
    }

    async interact(params: {
        desktopSessionId: string;
        windowId: string;
        ownerId?: string;
        action: "click" | "type" | "press" | "scroll" | "wait" | "evaluate";
        selector?: string;
        value?: string;
        x?: number;
        y?: number;
        name?: string;
        automationId?: string;
        timeout?: number;
    }): Promise<unknown> {
        const session = this.getSession(params.desktopSessionId, params.ownerId);
        await this.refreshWindows(session);
        const window = this.getWindow(session, params.windowId);
        if (window.page) {
            return await this.interactPage(window.page, params);
        }
        if (!window.handle) throw new Error(`window ${params.windowId} has no native handle`);
        return await interactNativeWindow({
            handle: window.handle,
            action: params.action === "evaluate" || params.action === "scroll" || params.action === "wait" ? "press" : params.action,
            x: params.x,
            y: params.y,
            text: params.value,
            key: params.value,
            name: params.name,
            automationId: params.automationId,
        });
    }

    async close(desktopSessionId: string, ownerId?: string): Promise<boolean> {
        const session = this.sessions.get(desktopSessionId);
        if (!session || session.ownerId !== normalizeOwnerId(ownerId)) return false;
        for (const window of session.windows.values()) {
            if (window.registeredSessionId) {
                await sessionManager.close(window.registeredSessionId, session.ownerId).catch(() => false);
            }
        }
        if (session.app) await session.app.close().catch(() => undefined);
        if (session.cdpBrowser) await session.cdpBrowser.close().catch(() => undefined);
        if (session.process && !session.process.killed) session.process.kill();
        this.sessions.delete(desktopSessionId);
        return true;
    }

    async closeAll(): Promise<void> {
        for (const session of Array.from(this.sessions.values())) {
            await this.close(session.id, session.ownerId).catch(() => undefined);
        }
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    }

    private createSession(kind: DesktopSessionKind, ownerId: string, handles: Partial<DesktopSession>): string {
        const id = `desktop_${randomUUID()}`;
        this.sessions.set(id, {
            id,
            ownerId,
            kind,
            createdAt: Date.now(),
            lastAccess: Date.now(),
            windows: new Map(),
            ...handles,
        });
        return id;
    }

    private getSession(id: string, ownerId?: string): DesktopSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`desktop session "${id}" does not exist or has expired`);
        if (session.ownerId !== normalizeOwnerId(ownerId)) throw new Error(`desktop session "${id}" ownerId mismatch`);
        session.lastAccess = Date.now();
        return session;
    }

    private getWindow(session: DesktopSession, windowId: string): DesktopWindowRecord {
        const window = session.windows.get(windowId);
        if (!window) throw new Error(`window "${windowId}" not found in desktop session "${session.id}"`);
        return window;
    }

    private async refreshWindows(session: DesktopSession): Promise<void> {
        if (session.kind === "electron") {
            for (const page of session.app?.windows() ?? []) this.upsertPageWindow(session, page, "renderer-page");
        } else if (session.kind === "cdp") {
            await this.refreshCdpWindows(session);
        } else {
            await this.refreshNativeWindows(session);
        }
    }

    private async refreshCdpWindows(session: DesktopSession): Promise<void> {
        for (const context of session.cdpBrowser?.contexts() ?? []) {
            for (const page of context.pages()) this.upsertPageWindow(session, page, "cdp-target");
        }
    }

    private async refreshNativeWindows(session: DesktopSession): Promise<void> {
        const windows = await listNativeWindows(session.processId);
        for (const nativeWindow of windows) this.upsertNativeWindow(session, nativeWindow);
    }

    private upsertPageWindow(session: DesktopSession, page: Page, targetKind: "renderer-page" | "cdp-target"): void {
        const existing = Array.from(session.windows.values()).find(window => window.page === page);
        const id = existing?.windowId ?? `window_${randomUUID()}`;
        session.windows.set(id, {
            desktopSessionId: session.id,
            windowId: id,
            targetKind,
            title: "",
            url: page.url(),
            registeredSessionId: existing?.registeredSessionId,
            page,
        });
        page.title().then(title => {
            const record = session.windows.get(id);
            if (record) record.title = title || page.url() || id;
        }).catch(() => undefined);
    }

    private upsertNativeWindow(session: DesktopSession, nativeWindow: NativeWindowInfo): void {
        const existing = Array.from(session.windows.values()).find(window => window.handle === nativeWindow.handle);
        const id = existing?.windowId ?? `window_${randomUUID()}`;
        session.windows.set(id, {
            desktopSessionId: session.id,
            windowId: id,
            targetKind: "native-window",
            title: nativeWindow.title,
            handle: nativeWindow.handle,
            processId: nativeWindow.processId,
            bounds: nativeWindow.bounds,
        });
    }

    private async interactPage(page: Page, params: {
        action: "click" | "type" | "press" | "scroll" | "wait" | "evaluate";
        selector?: string;
        value?: string;
        x?: number;
        y?: number;
        timeout?: number;
    }): Promise<unknown> {
        const timeout = params.timeout ?? 30_000;
        switch (params.action) {
            case "click":
                if (params.selector) {
                    await page.click(params.selector, { timeout });
                    return { ok: true, action: "click", selector: params.selector };
                }
                if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
                    await page.mouse.click(params.x!, params.y!);
                    return { ok: true, action: "click", x: params.x, y: params.y };
                }
                throw new Error("desktop_interact click requires selector or x/y");
            case "type":
                if (!params.selector) throw new Error("desktop_interact type requires selector for renderer targets");
                await page.fill(params.selector, params.value ?? "", { timeout });
                return { ok: true, action: "type", selector: params.selector };
            case "press":
                await page.keyboard.press(params.value ?? "Enter");
                return { ok: true, action: "press", key: params.value ?? "Enter" };
            case "scroll":
                await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                return { ok: true, action: "scroll" };
            case "wait":
                if (params.selector) await page.waitForSelector(params.selector, { timeout });
                else await page.waitForTimeout(Math.min(timeout, 30_000));
                return { ok: true, action: "wait", selector: params.selector };
            case "evaluate":
                return {
                    ok: true,
                    action: "evaluate",
                    result: await page.evaluate(params.value ?? "() => undefined"),
                };
        }
    }

    private async cleanup(): Promise<void> {
        const now = Date.now();
        for (const session of Array.from(this.sessions.values())) {
            if (now - session.lastAccess > SESSION_TIMEOUT) {
                await this.close(session.id, session.ownerId).catch(() => undefined);
            }
        }
    }
}

export const desktopManager = new DesktopManager();
