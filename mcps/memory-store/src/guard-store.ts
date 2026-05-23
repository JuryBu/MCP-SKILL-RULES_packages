import fs from "fs";
import path from "path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";
import type { Chain } from "./chain.js";

/**
 * Stage Guard 状态持久化
 * 
 * 按 conversationId 隔离：guards/{conversationId}.json
 * 每个对话独立 Guard，互不干扰。
 */

const GUARDS_DIR = path.join(DATA_ROOT, "guards");

/** 获取某对话的 guard 状态文件路径 */
function guardFilePath(conversationId: string): string {
    if (!fs.existsSync(GUARDS_DIR)) fs.mkdirSync(GUARDS_DIR, { recursive: true });
    return path.join(GUARDS_DIR, `${conversationId}.json`);
}

// ============= 类型定义 =============

export interface GuardCheckHistoryItem {
    checkNumber: number;
    result: "pass" | "fail";
    missingItems: string[];
    summary: string;
    checkedAt: string;
}

export interface GuardState {
    active: boolean;
    conversationId: string;
    /** Data chain used to read the guarded conversation. */
    chain?: Chain;
    /** Model chain used to run Guard checks. Falls back to chain for old states. */
    modelChain?: Chain;
    stageId: string;
    taskFiles: string[];
    planFiles: string[];
    startRound: number;
    startedAt: string;
    checkHistory: GuardCheckHistoryItem[];
}

// ============= 状态读写 =============

/** 读取 guard 状态。不存在时返回 null */
export function readGuardState(conversationId: string): GuardState | null {
    try {
        const fp = guardFilePath(conversationId);
        if (!fs.existsSync(fp)) return null;
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (!data || !data.active) return null;
        return data as GuardState;
    } catch {
        return null;
    }
}

/** 写入 guard 状态（原子写入） */
export function writeGuardState(state: GuardState): void {
    writeJsonAtomic(guardFilePath(state.conversationId), state);
}

/** 快速判定某对话的 guard 是否激活 */
export function isGuardActive(conversationId: string): boolean {
    return readGuardState(conversationId) !== null;
}

/** 追加检查历史记录 */
export function addCheckResult(
    conversationId: string,
    result: "pass" | "fail",
    summary: string,
    missingItems: string[] = []
): GuardState | null {
    const state = readGuardState(conversationId);
    if (!state) return null;

    const checkNumber = state.checkHistory.length + 1;
    state.checkHistory.push({
        checkNumber,
        result,
        missingItems,
        summary,
        checkedAt: new Date().toISOString(),
    });
    writeGuardState(state);
    return state;
}

/** 清理 guard 状态（删除文件） */
export function clearGuardState(conversationId: string): void {
    try {
        const fp = guardFilePath(conversationId);
        if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
        }
    } catch { /* 静默 */ }
}

// ============= Task.md 🔒 标记管理 =============

const LOCK_MARK = `<!-- 🔒 STAGE GUARD ACTIVE — 请勿手动移除此标记 -->`;
const LOCK_BEGIN_PREFIX = "<!-- STAGE_GUARD_LOCK_BEGIN ";
const LOCK_END = "<!-- STAGE_GUARD_LOCK_END -->";
const LOCK_BLOCK_PATTERN = /<!-- STAGE_GUARD_LOCK_BEGIN ([^\n]*?) -->\r?\n[\s\S]*?<!-- STAGE_GUARD_LOCK_END -->\r?\n?/g;

export interface GuardFileLock {
    conversationId: string;
    stageId: string;
    startedAt: string;
    taskFile: string;
}

export interface GuardLockOperationResult {
    ok: boolean;
    inserted?: boolean;
    removed?: boolean;
    legacyLockPresent: boolean;
    legacyLockRemoved: boolean;
    lockCount: number;
    otherLockCount: number;
    error?: string;
}

function safeLockJson(state: GuardState, taskFile: string): string {
    return JSON.stringify({
        conversationId: state.conversationId,
        stageId: state.stageId || "",
        startedAt: state.startedAt,
        taskFile,
    });
}

function buildLockBlock(state: GuardState, taskFile: string): string {
    const label = [
        "🔒 STAGE GUARD ACTIVE",
        `conversationId=${state.conversationId}`,
        state.stageId ? `stageId=${state.stageId}` : "",
        `startedAt=${state.startedAt}`,
    ].filter(Boolean).join(" ");
    return `${LOCK_BEGIN_PREFIX}${safeLockJson(state, taskFile)} -->\n<!-- ${label} -->\n${LOCK_END}`;
}

function parseGuardLocks(content: string): GuardFileLock[] {
    const locks: GuardFileLock[] = [];
    LOCK_BLOCK_PATTERN.lastIndex = 0;
    for (const match of content.matchAll(LOCK_BLOCK_PATTERN)) {
        try {
            const parsed = JSON.parse(match[1]) as Partial<GuardFileLock>;
            if (parsed.conversationId) {
                locks.push({
                    conversationId: String(parsed.conversationId),
                    stageId: String(parsed.stageId || ""),
                    startedAt: String(parsed.startedAt || ""),
                    taskFile: String(parsed.taskFile || ""),
                });
            }
        } catch {
            // Ignore malformed lock blocks; removal must not destroy unknown locks.
        }
    }
    return locks;
}

function hasLegacyLock(content: string): boolean {
    return content
        .split(/\r?\n/)
        .some(line => line.includes("STAGE GUARD ACTIVE")
            && !line.includes("conversationId=")
            && !line.includes("STAGE_GUARD_LOCK_BEGIN"));
}

function removeLegacyLocks(content: string): { content: string; removed: boolean } {
    let removed = false;
    const lines = content.split(/\r?\n/);
    const kept: string[] = [];
    for (const line of lines) {
        const isLegacy = line.includes("STAGE GUARD ACTIVE")
            && !line.includes("conversationId=")
            && !line.includes("STAGE_GUARD_LOCK_BEGIN");
        if (isLegacy) {
            removed = true;
            continue;
        }
        kept.push(line);
    }
    return { content: kept.join("\n").replace(/^\s*\n/, ""), removed };
}

/** 读取 Task 文件里的新版 Guard 锁块。 */
export function getGuardLocks(taskFile: string): GuardFileLock[] {
    try {
        if (!fs.existsSync(taskFile)) return [];
        return parseGuardLocks(fs.readFileSync(taskFile, "utf-8"));
    } catch {
        return [];
    }
}

/** 在 Task 文件头部插入当前对话专属 🔒 标记 */
export function insertLockMark(taskFile: string, state: GuardState): GuardLockOperationResult {
    try {
        if (!fs.existsSync(taskFile)) {
            return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "file not found" };
        }
        const content = fs.readFileSync(taskFile, "utf-8");
        const locks = parseGuardLocks(content);
        const legacyLockPresent = hasLegacyLock(content);
        const alreadyLocked = locks.some(lock => lock.conversationId === state.conversationId);
        if (alreadyLocked) {
            return {
                ok: true,
                inserted: false,
                legacyLockPresent,
                legacyLockRemoved: false,
                lockCount: locks.length,
                otherLockCount: locks.filter(lock => lock.conversationId !== state.conversationId).length,
            };
        }
        const newContent = `${buildLockBlock(state, taskFile)}\n\n${content}`;
        fs.writeFileSync(taskFile, newContent, "utf-8");
        return {
            ok: true,
            inserted: true,
            legacyLockPresent,
            legacyLockRemoved: false,
            lockCount: locks.length + 1,
            otherLockCount: locks.length,
        };
    } catch {
        return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "write failed" };
    }
}

/** 移除当前 conversationId 对应的 Task 文件锁，保留其它 Guard 锁。 */
export function removeLockMark(taskFile: string, conversationId: string): GuardLockOperationResult {
    try {
        if (!fs.existsSync(taskFile)) {
            return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "file not found" };
        }
        const content = fs.readFileSync(taskFile, "utf-8");
        const locks = parseGuardLocks(content);
        const legacyLockPresent = hasLegacyLock(content);
        let removed = false;
        let newContent = content.replace(LOCK_BLOCK_PATTERN, (block, rawJson) => {
            try {
                const parsed = JSON.parse(rawJson) as Partial<GuardFileLock>;
                if (parsed.conversationId === conversationId) {
                    removed = true;
                    return "";
                }
            } catch {
                // Keep malformed blocks.
            }
            return block;
        });

        const remainingLocks = parseGuardLocks(newContent);
        let legacyLockRemoved = false;
        if (legacyLockPresent && locks.length === 0 && remainingLocks.length === 0) {
            // Old single-line lock predates per-conversation locks; remove it only when
            // no modern lock blocks remain, otherwise it may represent another active guard.
            const legacyRemoval = removeLegacyLocks(newContent);
            newContent = legacyRemoval.content;
            legacyLockRemoved = legacyRemoval.removed;
            removed = removed || legacyRemoval.removed;
        }

        if (newContent !== content) fs.writeFileSync(taskFile, newContent, "utf-8");
        return {
            ok: true,
            removed,
            legacyLockPresent,
            legacyLockRemoved,
            lockCount: remainingLocks.length,
            otherLockCount: remainingLocks.filter(lock => lock.conversationId !== conversationId).length,
        };
    } catch {
        return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "write failed" };
    }
}

/** 获取指定对话的 guard 提醒文字。只允许在已明确 conversationId 的场景使用。 */
export function getGuardReminder(conversationId: string): string | null {
    const state = readGuardState(conversationId);
    if (!state) return null;
    const label = state.stageId || "活跃";
    return `\n⚠️ Stage Guard 活跃: ${label}，完成前请调 stage_guard(action="check")`;
}
