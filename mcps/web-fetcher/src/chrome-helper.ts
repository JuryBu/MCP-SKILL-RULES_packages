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

/** Chrome 启动配置 */
export interface ChromeLaunchOptions {
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
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        startUrl,
    ], {
        detached: false,
        stdio: "ignore",
        windowsHide: false,  // v6.1: 确保 Windows 上窗口可见
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

    return { process: chromeProcess, tempProfile, cdpPort, ownerToken, lockFile };
}

/**
 * 通过 CDP 连接到运行中的 Chrome
 * @param port CDP 远程调试端口
 * @returns Playwright Browser 实例（CDP 连接）
 */
export async function connectCDP(port: number): Promise<any> {
    const { chromium } = await import("playwright");
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

/**
 * Cookie 合并策略：按 domain+name+path 为 key，新的覆盖旧的
 * @param existing 现有 Cookie 列表
 * @param incoming 新 Cookie 列表
 * @returns 合并后的 Cookie 列表
 */
export function mergeCookies(existing: any[], incoming: any[]): any[] {
    const cookieKey = (c: any) => `${c.domain}|${c.name}|${c.path || "/"}`;
    const cookieMap = new Map<string, any>();

    for (const c of existing) {
        cookieMap.set(cookieKey(c), c);
    }
    for (const c of incoming) {
        cookieMap.set(cookieKey(c), c);
    }

    return Array.from(cookieMap.values());
}

function ensureBackupDir(filePath: string): void {
    const backupDir = path.dirname(filePath);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
}

function withFileLock<T>(filePath: string, fn: () => T): T {
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
            if (Date.now() - started > BACKUP_LOCK_STALE_MS) {
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
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
}

/**
 * 将 Cookie 列表持久化到备份文件（合并模式）
 * @param newCookies 要保存的新 Cookie
 * @returns 合并后的总 Cookie 数
 */
export function saveCookiesToBackup(newCookies: any[]): number {
    return withFileLock(COOKIES_BACKUP_FILE, () => {
        const existingCookies = readJsonFile<any[]>(COOKIES_BACKUP_FILE, []);
        const merged = mergeCookies(Array.isArray(existingCookies) ? existingCookies : [], newCookies);
        writeJsonAtomic(COOKIES_BACKUP_FILE, merged);
        return merged.length;
    });
}

/**
 * 清理临时 profile 目录
 */
export function cleanupTempProfile(tempProfile: string): void {
    try {
        fs.rmSync(tempProfile, { recursive: true, force: true });
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
        chromeProcess.on("close", () => resolve());
        chromeProcess.on("error", () => resolve());
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
export function saveLocalStorageToBackup(domain: string, data: Record<string, string>): void {
    withFileLock(LOCALSTORAGE_BACKUP_FILE, () => {
        const existing = readJsonFile<LocalStorageBackup>(LOCALSTORAGE_BACKUP_FILE, {});

        // 过滤掉纯遥测/分析的 key，只保留有价值的认证和配置数据
        const filtered: Record<string, string> = {};
        for (const [key, value] of Object.entries(data)) {
            // 跳过 BEACON/aegis 遥测、超长的 monaco 编辑器状态等
            if (key.startsWith('__BEACON_') || key.startsWith('dt_task_lock_')) continue;
            if (key === 'monaco-parts-splash') continue;
            filtered[key] = value;
        }

        existing[domain] = { ...(existing[domain] || {}), ...filtered };
        writeJsonAtomic(LOCALSTORAGE_BACKUP_FILE, existing);
        console.error(`[web-fetcher] localStorage 已备份: ${domain} (${Object.keys(filtered).length} 个 key)`);
    });
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
