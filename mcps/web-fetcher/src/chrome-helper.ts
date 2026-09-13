/**
 * Chrome/CDP 公共方法
 * 
 * 提供系统 Chrome 启动、CDP 连接、Cookie 双向同步等复用基础设施。
 * 供 login-browser.ts（用户登录）和 browser.ts（UAV 用户辅助验证）共用。
 * 
 * @since v6.0
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { randomUUID } from "crypto";
import { COOKIES_BACKUP_FILE, LOCALSTORAGE_BACKUP_FILE } from "./constants.js";

const PROFILE_LOCK_FILE = ".mcp-web-fetcher-chrome.json";
const BACKUP_LOCK_STALE_MS = 30_000;
const ownedChromeLaunches = new Map<string, { profile: string; chromePath: string; executableIdentity: string; chromeProcess?: ChildProcess }>();

/** Chrome 启动配置 */
export interface ChromeLaunchOptions {
    headless?: boolean;
    /** 起始 URL */
    startUrl?: string;
    /** CDP 远程调试端口，默认 19222 */
    cdpPort?: number;
    /** 临时 profile 目录前缀 */
    profilePrefix?: string;
}

/** Chrome 启动结果 */
export interface ChromeLaunchResult {
    /** Chrome 子进程 */
    process: ChildProcess;
    /** 临时 profile 路径 */
    tempProfile: string;
    /** 实际使用的 CDP 端口 */
    cdpPort: number;
    /** 本次启动的所有权标识，用于安全终止自有 Chrome */
    ownerToken: string;
    /** 临时 profile 下的所有权锁文件 */
    lockFile: string;
}

/**
 * 查找系统 Chrome 路径
 */
export function findChromePath(): string | null {
    const possiblePaths = [
        process.env["PROGRAMFILES"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["LOCALAPPDATA"] + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("无法分配动态 CDP 端口")));
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

/**
 * 启动系统 Chrome（带 CDP 远程调试端口）
 * v6.1: 增加端口冲突检测、启动验证、窗口可见性保障
 * @throws 如果未找到系统 Chrome
 */
export async function launchSystemChrome(options?: ChromeLaunchOptions): Promise<ChromeLaunchResult> {
    const chromePath = findChromePath();
    if (!chromePath) {
        throw new Error("未找到系统 Chrome 浏览器。请确保已安装 Google Chrome。");
    }

    const cdpPort = options?.cdpPort ?? await getFreePort();
    const prefix = options?.profilePrefix ?? 'mcp-chrome';
    const startUrl = options?.startUrl ?? 'about:blank';
    const ownerToken = randomUUID();
    const tempProfile = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${ownerToken.slice(0, 8)}`);
    const lockFile = path.join(tempProfile, PROFILE_LOCK_FILE);

    fs.mkdirSync(tempProfile, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid,
        ownerPid: process.pid,
        ownerToken,
        cdpPort,
        createdAt: new Date().toISOString(),
        chromePath,
    }, null, 2), "utf-8");

    console.error(`[web-fetcher] Chrome 启动: ${chromePath}`);
    console.error(`[web-fetcher] 临时 Profile: ${tempProfile}`);
    console.error(`[web-fetcher] CDP 端口: ${cdpPort}`);

    const chromeProcess = spawn(chromePath, [
        `--user-data-dir=${tempProfile}`,
        `--remote-debugging-port=${cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        ...(options?.headless === true ? ["--headless=new"] : []),
        startUrl,
    ], {
        detached: false,
        stdio: "ignore",
        windowsHide: options?.headless === true,
    });

    // v6.1: 启动验证
    if (!chromeProcess.pid) {
        console.error(`[web-fetcher] ⚠️ Chrome 启动异常：未获得 PID`);
    } else {
        console.error(`[web-fetcher] Chrome 已启动 (PID: ${chromeProcess.pid})`);
    }

    // 监听启动失败事件
    chromeProcess.on('error', (err) => {
        console.error(`[web-fetcher] Chrome 进程错误: ${err.message}`);
    });

    const executableStat = fs.statSync(chromePath);
    ownedChromeLaunches.set(ownerToken, {
        profile: fs.realpathSync(tempProfile), chromePath, chromeProcess,
        executableIdentity: `${executableStat.size}:${executableStat.mtimeMs}`,
    });
    return { process: chromeProcess, tempProfile, cdpPort, ownerToken, lockFile };
}

/**
 * 通过 CDP 连接到运行中的 Chrome
 * @param port CDP 远程调试端口
 * @returns Playwright Browser 实例（CDP 连接）
 */
export async function connectCDP(port: number, timeoutMs = 10_000): Promise<any> {
    const { chromium } = await import("playwright");
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
}

/**
 * Cookie 合并策略：按 domain+name+path 为 key，新的覆盖旧的
 * @param existing 现有 Cookie 列表
 * @param incoming 新 Cookie 列表
 * @returns 合并后的 Cookie 列表
 */
export function cookieStorageKey(cookie: any): string {
    return `${cookie.domain}|${cookie.name}|${cookie.path || "/"}`;
}

function cookieState(cookie: any): string {
    if (cookie === undefined) return "absent";
    return JSON.stringify(Object.keys(cookie).sort().map(key => [key, cookie[key]]));
}

export function mergeCookies(existing: any[], incoming: any[]): any[] {
    const cookieMap = new Map<string, any>();

    for (const c of existing) {
        cookieMap.set(cookieStorageKey(c), c);
    }
    for (const c of incoming) {
        cookieMap.set(cookieStorageKey(c), c);
    }

    return Array.from(cookieMap.values());
}

function ensureBackupDir(filePath: string): void {
    const backupDir = path.dirname(filePath);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
}

function withFileLock<T>(filePath: string, fn: () => T, waitBudgetMs = BACKUP_LOCK_STALE_MS): T {
    ensureBackupDir(filePath);
    const lockPath = `${filePath}.lock`;
    const started = Date.now();
    let fd: number | null = null;
    while (fd === null) {
        try {
            fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        } catch (error: any) {
            if (error?.code !== "EEXIST") throw error;
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > BACKUP_LOCK_STALE_MS) {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() - started >= waitBudgetMs) {
                throw new Error(`等待备份文件锁超时: ${lockPath}`);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }

    try {
        return fn();
    } finally {
        if (fd !== null) fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
    }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
    ensureBackupDir(filePath);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
        fs.renameSync(tmpPath, filePath);
    } finally {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    }
}

/**
 * 将 Cookie 列表持久化到备份文件（合并模式）
 * @param newCookies 要保存的新 Cookie
 * @returns 合并后的总 Cookie 数
 */
export function saveCookiesToBackup(newCookies: any[], expectedBase?: any[], waitBudgetMs?: number): number {
    return saveCookieChangesToBackup(newCookies, expectedBase, waitBudgetMs).total;
}

export function saveCookieChangesToBackup(newCookies: any[], expectedBase?: any[], waitBudgetMs?: number): { total: number; acceptedCookies: any[] } {
    return withFileLock(COOKIES_BACKUP_FILE, () => {
        const existingCookies = readJsonFile<any[]>(COOKIES_BACKUP_FILE, []);
        const existing = Array.isArray(existingCookies) ? existingCookies : [];
        const currentByKey = new Map(existing.map(cookie => [cookieStorageKey(cookie), cookie]));
        const baseByKey = new Map(expectedBase?.map(cookie => [cookieStorageKey(cookie), cookie]));
        const accepted = expectedBase === undefined ? newCookies : newCookies.filter(cookie =>
            cookieState(currentByKey.get(cookieStorageKey(cookie))) === cookieState(baseByKey.get(cookieStorageKey(cookie)))
        );
        const merged = mergeCookies(existing, accepted);
        writeJsonAtomic(COOKIES_BACKUP_FILE, merged);
        return { total: merged.length, acceptedCookies: accepted.map(cookie => ({ ...cookie })) };
    }, waitBudgetMs);
}

/**
 * 清理临时 profile 目录
 */
export function cleanupTempProfile(tempProfile: string): void {
    try {
        fs.rmSync(tempProfile, { recursive: true, force: true });
        for (const [token, owned] of ownedChromeLaunches) {
            if (path.resolve(tempProfile) === owned.profile) ownedChromeLaunches.delete(token);
        }
        console.error("[web-fetcher] 临时 profile 已清理");
    } catch { /* 忽略 */ }
}

/**
 * 仅终止当前工具自己创建、且 lockfile 匹配的 Chrome 进程。
 */
export function terminateOwnedChrome(chrome: ChromeLaunchResult): void {
    try {
        if (!fs.existsSync(chrome.lockFile)) return;
        const lock = JSON.parse(fs.readFileSync(chrome.lockFile, "utf-8"));
        if (lock.ownerToken !== chrome.ownerToken || lock.cdpPort !== chrome.cdpPort) {
            console.error("[web-fetcher] Chrome lockfile 不匹配，跳过终止");
            return;
        }
        if (!chrome.process.killed) {
            chrome.process.kill();
        }
    } catch (error) {
        console.error("[web-fetcher] 自有 Chrome 终止失败:", error);
    }
}

/**
 * 等待 Chrome 进程退出
 */
export function waitForChromeClose(chromeProcess: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
        if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
            resolve();
            return;
        }
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            chromeProcess.removeListener("close", finish);
            chromeProcess.removeListener("exit", finish);
            chromeProcess.removeListener("error", finish);
            resolve();
        };
        chromeProcess.once("close", finish);
        chromeProcess.once("exit", finish);
        chromeProcess.once("error", finish);
    });
}

// ========== v6.4: localStorage 持久化 ==========

/** localStorage 备份格式：按域名存储 */
interface LocalStorageBackup {
    [domain: string]: { [key: string]: string };
}

/**
 * 保存某域名的 localStorage 到备份文件（merge 模式）
 */
function filterLocalStorageValues(data: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(data).filter(([key]) =>
        key !== '__mcp_web_fetcher_restore_revision__' &&
        !key.startsWith('__BEACON_') && !key.startsWith('dt_task_lock_') &&
        key !== 'monaco-parts-splash'
    ));
}

export function saveLocalStorageToBackup(domain: string, data: Record<string, string>, waitBudgetMs?: number): number {
    return withFileLock(LOCALSTORAGE_BACKUP_FILE, () => {
        const existing = readJsonFile<LocalStorageBackup>(LOCALSTORAGE_BACKUP_FILE, {});
        const filtered = filterLocalStorageValues(data);

        existing[domain] = { ...(existing[domain] || {}), ...filtered };
        delete existing[domain]['__mcp_web_fetcher_restore_revision__'];
        writeJsonAtomic(LOCALSTORAGE_BACKUP_FILE, existing);
        console.error(`[web-fetcher] localStorage 已备份: ${domain} (${Object.keys(filtered).length} 个 key)`);
        return Object.keys(filtered).length;
    }, waitBudgetMs);
}

/**
 * 加载某域名的 localStorage 备份
 */
export function loadLocalStorageBackup(domain: string): Record<string, string> | null {
    if (!fs.existsSync(LOCALSTORAGE_BACKUP_FILE)) return null;
    try {
        const data: LocalStorageBackup = JSON.parse(fs.readFileSync(LOCALSTORAGE_BACKUP_FILE, "utf-8"));
        return data[domain] || null;
    } catch {
        return null;
    }
}

export function saveLocalStorageChangesToBackup(origin: string, newValues: Record<string, string>, expectedBase: Record<string, string>): {
    acceptedValues: Record<string, string>; rejectedKeys: string[];
} {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
        throw new Error("localStorage changes require an exact HTTP(S) origin");
    }
    return withFileLock(LOCALSTORAGE_BACKUP_FILE, () => {
        const existing = readJsonFile<LocalStorageBackup>(LOCALSTORAGE_BACKUP_FILE, {});
        const current = existing[origin] ?? (parsed.protocol === "https:" && !parsed.port ? existing[parsed.hostname] : undefined) ?? {};
        const acceptedValues: Record<string, string> = {};
        const rejectedKeys: string[] = [];
        for (const [key, value] of Object.entries(filterLocalStorageValues(newValues))) {
            if (Object.hasOwn(expectedBase, key) && value === expectedBase[key]) continue;
            const matchesBase = Object.hasOwn(current, key) === Object.hasOwn(expectedBase, key)
                && (!Object.hasOwn(current, key) || current[key] === expectedBase[key]);
            if (matchesBase) Object.defineProperty(acceptedValues, key, { value, enumerable: true, configurable: true, writable: true });
            else rejectedKeys.push(key);
        }
        if (Object.keys(acceptedValues).length > 0) {
            existing[origin] = filterLocalStorageValues({ ...current, ...acceptedValues });
            writeJsonAtomic(LOCALSTORAGE_BACKUP_FILE, existing);
        }
        return { acceptedValues, rejectedKeys };
    });
}

export function getLocalStorageForOrigin(origin: string): Record<string, string> | null {
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
        const exact = loadLocalStorageBackup(parsed.origin);
        if (exact) return exact;
        if (parsed.protocol === "https:" && !parsed.port) {
            return loadLocalStorageBackup(parsed.hostname);
        }
        return null;
    } catch {
        return null;
    }
}

export interface BrowserStorageSnapshotResult {
    reason: string;
    cookieCount: number;
    mergedCookieCount?: number;
    localStorageDomains: Array<{ domain: string; keyCount: number }>;
    errors: string[];
    cookies: any[];
    savedCookieCount: number;
    savedAt?: string;
    capturedAt?: string;
    recoveryBrowserClosed?: boolean;
}

export async function recoverClosedChromeStorage(chrome: ChromeLaunchResult, startUrl: string): Promise<BrowserStorageSnapshotResult> {
    let result: BrowserStorageSnapshotResult = {
        reason: "closed-profile-recovery", cookieCount: 0, savedCookieCount: 0,
        cookies: [], localStorageDomains: [], errors: [], capturedAt: new Date().toISOString(),
    };
    const deadline = Date.now() + 30_000;
    let recoveryProcess: ChildProcess | undefined;
    let browser: any;
    let verifiedEndpoint = false;
    let navigationFailed = false;
    const remaining = (reserve = 0) => Math.max(1, deadline - Date.now() - reserve);
    try {
        const owned = ownedChromeLaunches.get(chrome.ownerToken);
        if (!owned || owned.chromeProcess !== chrome.process ||
            (chrome.process.exitCode === null && chrome.process.signalCode === null)) {
            throw new Error("recovery requires an exited owned process");
        }
        const realProfile = fs.realpathSync(chrome.tempProfile);
        const tempRoot = fs.realpathSync(os.tmpdir());
        const lock = JSON.parse(fs.readFileSync(chrome.lockFile, "utf8"));
        if (owned.profile !== realProfile || path.dirname(realProfile) !== tempRoot ||
            !/^mcp-chrome-(?:login|uav|human)-/.test(path.basename(realProfile)) ||
            fs.realpathSync(chrome.lockFile) !== path.join(realProfile, PROFILE_LOCK_FILE) ||
            lock.ownerToken !== chrome.ownerToken || (lock.ownerPid ?? lock.pid) !== process.pid ||
            lock.cdpPort !== chrome.cdpPort || lock.chromePath !== owned.chromePath) {
            throw new Error("recovery ownership validation failed");
        }
        const executableStat = fs.statSync(owned.chromePath);
        if (`${executableStat.size}:${executableStat.mtimeMs}` !== owned.executableIdentity) {
            throw new Error("recovery Chrome version changed");
        }
        const port = await getFreePort();
        recoveryProcess = spawn(owned.chromePath, [
            `--user-data-dir=${realProfile}`, `--remote-debugging-port=${port}`,
            "--remote-debugging-address=127.0.0.1", "--headless=new", "--enable-automation",
            "--no-first-run", "--no-default-browser-check", "--restore-last-session", "about:blank",
        ], { stdio: "ignore", windowsHide: true });
        let spawnFailed = false;
        recoveryProcess.on("error", () => { spawnFailed = true; });
        while (Date.now() < deadline - 20_000) {
            if (spawnFailed || recoveryProcess.exitCode !== null || recoveryProcess.signalCode !== null) break;
            try {
                browser = await connectCDP(port, Math.min(1000, remaining(20_000)));
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }
        if (!browser) throw new Error("recovery CDP unavailable");
        const session = await withTimeout<any>(browser.newBrowserCDPSession(), Math.min(1500, remaining(18_000)), "recovery identity session");
        const command = await withTimeout<any>(session.send("Browser.getBrowserCommandLine"), Math.min(1500, remaining(18_000)), "recovery identity");
        await withTimeout(session.detach(), Math.min(500, remaining(18_000)), "recovery identity detach");
        if (!command.arguments?.includes(`--user-data-dir=${realProfile}`)) throw new Error("recovery endpoint ownership mismatch");
        verifiedEndpoint = true;
        const context = browser.contexts()[0];
        if (!context) throw new Error("recovery context unavailable");
        if (startUrl !== "about:blank") {
            const parsed = new URL(startUrl);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") {
                const page = await withTimeout<any>(context.newPage(), Math.min(1000, remaining(16_000)), "recovery page");
                await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: Math.min(5000, remaining(16_000)) }).catch(() => { navigationFailed = true; });
            }
        }
        result = await snapshotBrowserStorage(context, {
            reason: "closed-profile-recovery", totalTimeoutMs: Math.min(15_000, remaining(4000)),
        });
        if (navigationFailed) result.errors.push("closed-profile-recovery: final origin navigation incomplete");
    } catch {
        result.errors.push("closed-profile-recovery: unavailable; original profile retained");
    } finally {
        if (browser && verifiedEndpoint) {
            try {
                const session = await withTimeout<any>(browser.newBrowserCDPSession(), Math.min(500, remaining()), "recovery close session");
                await withTimeout(session.send("Browser.close"), Math.min(1500, remaining()), "recovery close");
            } catch { }
        }
        if (browser) await withTimeout(Promise.resolve(browser.close()), Math.min(500, remaining()), "recovery disconnect").catch(() => undefined);
        if (recoveryProcess) {
            if (recoveryProcess.exitCode === null && recoveryProcess.signalCode === null) recoveryProcess.kill();
            await withTimeout(waitForChromeClose(recoveryProcess), Math.min(1500, remaining()), "recovery process exit").catch(() => undefined);
            result.recoveryBrowserClosed = recoveryProcess.exitCode !== null || recoveryProcess.signalCode !== null;
            if (!result.recoveryBrowserClosed) result.errors.push("closed-profile-recovery: process cleanup incomplete; profile retained");
        }
    }
    return result;
}

export interface BrowserStorageSnapshotOptions {
    reason?: string;
    saveCookies?: boolean;
    saveLocalStorage?: boolean;
    cookieTimeoutMs?: number;
    localStorageTimeoutMs?: number;
    totalTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
        promise
            .then(value => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch(error => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

function safePageUrl(page: any): string {
    try {
        return typeof page?.url === "function" ? page.url() : "";
    } catch {
        return "";
    }
}

function isUsableLocalStorageUrl(url: string): boolean {
    if (!url || url === "about:blank") return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function localStorageDomainForUrl(url: string): string {
    const parsed = new URL(url);
    return parsed.origin;
}

/**
 * 从 CDP/Playwright BrowserContext 周期性快照 Cookie 与 localStorage，并立即写入共享备份。
 *
 * 这用于有头登录、UAV、人机验证和 Human Browser live session，避免用户主动关闭或超时关闭
 * 之后再导出时 CDP 页面已经不可用，造成同一登录态下 Cookie/localStorage 导出结果不一致。
 */
export async function snapshotBrowserStorage(context: any, options?: BrowserStorageSnapshotOptions): Promise<BrowserStorageSnapshotResult> {
    const reason = options?.reason ?? "manual";
    const saveCookies = options?.saveCookies !== false;
    const saveLocalStorage = options?.saveLocalStorage !== false;
    const cookieTimeoutMs = options?.cookieTimeoutMs ?? 5000;
    const localStorageTimeoutMs = options?.localStorageTimeoutMs ?? 5000;
    const deadline = Date.now() + (options?.totalTimeoutMs ?? 15_000);
    const remaining = () => Math.max(1, deadline - Date.now());
    const result: BrowserStorageSnapshotResult = {
        reason,
        cookieCount: 0,
        localStorageDomains: [],
        errors: [],
        cookies: [],
        savedCookieCount: 0,
        capturedAt: new Date().toISOString(),
    };

    if (saveCookies) {
        try {
            const cookies = await withTimeout(context.cookies(), Math.min(cookieTimeoutMs, remaining()), "cookie snapshot");
            result.cookies = Array.isArray(cookies) ? cookies : [];
            result.cookieCount = result.cookies.length;
            if (result.cookies.length > 0) {
                result.mergedCookieCount = saveCookiesToBackup(result.cookies, undefined, remaining());
                result.savedCookieCount = result.cookieCount;
                result.savedAt = new Date().toISOString();
            }
        } catch (error) {
            result.errors.push("cookies: capture or persistence failed");
        }
    }

    if (saveLocalStorage) {
        let pages: any[] = [];
        try {
            pages = typeof context.pages === "function" ? context.pages() : [];
        } catch (error) {
            result.errors.push("pages: unavailable");
        }

        for (const page of pages) {
            if (Date.now() >= deadline) {
                result.errors.push("localStorage: total snapshot budget exhausted");
                break;
            }
            try {
                if (typeof page?.isClosed === "function" && page.isClosed()) continue;
                const url = safePageUrl(page);
                if (!isUsableLocalStorageUrl(url)) continue;
                const domain = localStorageDomainForUrl(url);
                const evaluated = await withTimeout<{ origin: string; data: Record<string, string> }>(page.evaluate(() => {
                    const data: Record<string, string> = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key) data[key] = localStorage.getItem(key) || "";
                    }
                    return { origin: location.origin, data };
                }), Math.min(localStorageTimeoutMs, remaining()), "localStorage snapshot");
                if (evaluated.origin !== domain) {
                    result.errors.push("localStorage: origin changed during capture");
                    continue;
                }
                const lsData = evaluated.data;
                const keyCount = Object.keys(lsData || {}).length;
                if (keyCount > 0) {
                    const savedKeys = saveLocalStorageToBackup(domain, lsData, remaining());
                    if (savedKeys > 0) {
                        const previous = result.localStorageDomains.find(entry => entry.domain === domain);
                        if (previous) previous.keyCount = savedKeys;
                        else result.localStorageDomains.push({ domain, keyCount: savedKeys });
                        result.savedAt = new Date().toISOString();
                    }
                }
            } catch (error) {
                result.errors.push("localStorage: capture or persistence failed");
            }
        }
    }

    console.error(
        `[web-fetcher] 存储快照(${reason}): Cookie ${result.cookieCount}`
        + (result.mergedCookieCount !== undefined ? ` -> 总 ${result.mergedCookieCount}` : "")
        + `, localStorage ${result.localStorageDomains.length} 个域名`
        + (result.errors.length ? `, errors=${result.errors.length}` : "")
    );
    return result;
}
