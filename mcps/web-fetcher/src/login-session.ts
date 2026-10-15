import { touchActivity } from "./lifecycle.js";
import {
    launchSystemChrome, connectCDP, waitForChromeClose, terminateOwnedChrome, cleanupTempProfile,
    recoverClosedChromeStorage, StorageWriteState, type BrowserStorageSnapshotResult,
    type ChromeLaunchResult,
} from "./chrome-helper.js";
import { StorageSnapshotTracker } from "./storage-snapshot-tracker.js";
import { mergeStorageSnapshots } from "./storage-snapshot.js";

export interface LoginSessionResult {
    snapshot: BrowserStorageSnapshotResult;
    timedOut: boolean;
    recoveryProfile?: string;
    browserClosed: boolean;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("login operation deadline")), Math.max(1, timeoutMs));
        })]);
    } finally {
        clearTimeout(timer!);
    }
}

interface LoginSessionOptions {
    initialCookies?: any[]; profilePrefix?: string; maxRunMs?: number;
}

interface LoginSessionDependencies {
    launch?: typeof launchSystemChrome;
    connect?: typeof connectCDP;
    createTracker?: (context: any) => StorageSnapshotTracker;
}

async function runSession(startUrl: string, options: LoginSessionOptions | undefined, dependencies: LoginSessionDependencies): Promise<LoginSessionResult> {
    const maxRunMs = Math.max(1, Math.min(600_000, options?.maxRunMs ?? 600_000));
    const prefix = options?.profilePrefix === "mcp-chrome-uav" ? "mcp-chrome-uav" : "mcp-chrome-login";
    const writeState = new StorageWriteState();
    const launching = (dependencies.launch ?? launchSystemChrome)({ startUrl: "about:blank", profilePrefix: prefix, storageWriteState: writeState });
    let chrome: ChromeLaunchResult;
    try {
        chrome = await bounded(launching, 15_000);
    } catch (error) {
        void launching.then(lateChrome => terminateOwnedChrome(lateChrome)).catch(() => undefined);
        throw error;
    }
    const deadline = Date.now() + maxRunMs;
    const closed = waitForChromeClose(chrome.process);
    let timeoutTimer: ReturnType<typeof setTimeout>;
    const expired = new Promise<"timeout">(resolve => { timeoutTimer = setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())); });
    const heartbeat = setInterval(touchActivity, 20_000);
    heartbeat.unref();
    let browser: any;
    let tracker: StorageSnapshotTracker | undefined;
    let timedOut = false;
    let snapshot: BrowserStorageSnapshotResult = { reason: "login", cookieCount: 0, savedCookieCount: 0, cookies: [], localStorageDomains: [], errors: [] };
    const warnings: string[] = [];
    let finalStateSaved = false;
    let recoveryClosed = true;
    try {
      try {
        const attachDeadline = Math.min(deadline, Date.now() + 10_000);
        while (Date.now() < attachDeadline && chrome.process.exitCode === null && chrome.process.signalCode === null) {
            try {
                browser = await (dependencies.connect ?? connectCDP)(chrome.cdpPort, Math.min(1000, attachDeadline - Date.now()));
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        if (browser?.contexts()[0]) {
            const context = browser.contexts()[0];
            tracker = dependencies.createTracker?.(context) ?? new StorageSnapshotTracker(context, { reasonPrefix: prefix, intervalMs: 2000, writeState });
            await tracker.start();
            if (options?.initialCookies) {
                await bounded(context.addCookies(options.initialCookies), 3000).catch(() => {
                    warnings.push("初始 Cookie 导入失败，人工窗口继续保留，可直接完成登录");
                });
            }
            if (startUrl !== "about:blank") {
                const page = context.pages()[0] ?? await bounded<any>(context.newPage(), 1000);
                await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(5000, deadline - Date.now())) }).catch(() => undefined);
            }
        } else {
            warnings.push("CDP 未连接，关闭后将尝试从本次专用 profile 恢复；尚未确认保存");
        }
      } catch {
          warnings.push("登录采样准备失败，人工窗口继续保留；关闭后尝试恢复本次专用 profile");
      }
        const outcome = await Promise.race([closed.then(() => "closed" as const), expired]);
        timedOut = outcome === "timeout";
        if (tracker) {
            try {
                snapshot = await tracker.stop(timedOut ? "login-timeout-before-close" : undefined);
                finalStateSaved = timedOut && snapshot.errors.length === 0 && Boolean(snapshot.savedAt);
            } catch {
                warnings.push("最终采样失败，将保留未确认的恢复来源");
            }
        }
    } finally {
        clearTimeout(timeoutTimer!);
        clearInterval(heartbeat);
        if (chrome.process.exitCode === null && chrome.process.signalCode === null) {
            if (browser) {
                try {
                    const session = await bounded<any>(browser.newBrowserCDPSession(), 1000);
                    await bounded(session.send("Browser.close"), 2000);
                } catch { }
            }
            await bounded(closed, 7500).catch(() => undefined);
            if (chrome.process.exitCode === null && chrome.process.signalCode === null) terminateOwnedChrome(chrome);
            await bounded(closed, 3000).catch(() => undefined);
        }
        if (browser) await bounded(Promise.resolve(browser.close()), 1000).catch(() => undefined);
    }
    const originalClosed = chrome.process.exitCode !== null || chrome.process.signalCode !== null;
    if (originalClosed) {
        const recovered = await recoverClosedChromeStorage(chrome, startUrl, {
            origins: snapshot.observedOrigins,
            originTrackingComplete: snapshot.originTrackingComplete ?? false,
            writeState,
        });
        snapshot = mergeStorageSnapshots(snapshot, recovered);
        recoveryClosed = recovered.recoveryBrowserClosed !== false;
        finalStateSaved = recovered.recoveryComplete === true && snapshot.errors.length === 0 && Boolean(recovered.savedAt) && recoveryClosed;
    }
    snapshot.errors.push(...warnings);
    const browserClosed = originalClosed && recoveryClosed;
    let profileRemoved = false;
    if (browserClosed && finalStateSaved && snapshot.errors.length === 0) {
        profileRemoved = cleanupTempProfile(chrome.tempProfile);
        if (!profileRemoved) snapshot.errors.push("recovery: cleanup failed (original-profile-retained)");
    }
    return {
        snapshot, timedOut, browserClosed,
        recoveryProfile: profileRemoved ? undefined : chrome.tempProfile,
    };
}

export function createLoginSessionRunner(dependencies: LoginSessionDependencies = {}) {
    return (startUrl: string, options?: LoginSessionOptions) => runSession(startUrl, options, dependencies);
}

export const runLoginBrowserSession = createLoginSessionRunner();
