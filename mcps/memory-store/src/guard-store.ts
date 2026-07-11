import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";
import type { Chain, DataChain } from "./chain.js";

/** Stage Guard 状态持久化。每个逻辑 GuardKey 都有独立的状态文件。 */

const GUARDS_DIR = path.join(DATA_ROOT, "guards");
const MAIN_SCOPE_ID = "main";

export interface GuardKey {
    conversationId: string;
    stageId: string;
    childScopeId: string;
}

export function normalizeChildScopeId(childScopeId?: string): string {
    return childScopeId?.trim() || MAIN_SCOPE_ID;
}

export function createGuardKey(conversationId: string, stageId?: string, childScopeId?: string): GuardKey {
    return {
        conversationId,
        stageId: stageId?.trim() || "",
        childScopeId: normalizeChildScopeId(childScopeId),
    };
}

export function guardKeyForState(state: Pick<GuardState, "conversationId" | "stageId" | "childScopeId">): GuardKey {
    return createGuardKey(state.conversationId, state.stageId, state.childScopeId);
}

export function createGuardId(): string {
    return randomUUID();
}

function stableHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ensureDirectory(directory: string): void {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function guardFilePath(key: GuardKey): string {
    const conversationHash = stableHash({ conversationId: key.conversationId });
    const guardKeyHash = stableHash(key);
    const directory = path.join(GUARDS_DIR, conversationHash);
    ensureDirectory(directory);
    return path.join(directory, `${guardKeyHash}.json`);
}

function legacyGuardFilePath(conversationId: string): string {
    ensureDirectory(GUARDS_DIR);
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
    /** Immutable instance identity. A forced replacement always receives a new value. */
    guardId: string;
    conversationId: string;
    /** Data chain used to read the guarded conversation. */
    chain?: DataChain;
    /** Model chain used to run Guard checks. Falls back to chain for old states. */
    modelChain?: Chain;
    stageId: string;
    /** "main" for a primary Guard, otherwise a stable child job/scope identity. */
    childScopeId: string;
    /** Stable Task anchors to audit for a child scope. */
    scopeSelectors: string[];
    taskFiles: string[];
    planFiles: string[];
    startRound: number;
    startedAt: string;
    checkHistory: GuardCheckHistoryItem[];
}

type LegacyGuardState = Partial<GuardState> & Pick<GuardState, "active" | "conversationId" | "stageId" | "taskFiles" | "planFiles" | "startRound" | "startedAt" | "checkHistory">;

function normalizeScopeSelectors(scopeSelectors: unknown): string[] {
    if (!Array.isArray(scopeSelectors)) return [];
    return [...new Set(scopeSelectors
        .filter((value): value is string => typeof value === "string")
        .map(value => value.trim())
        .filter(Boolean))];
}

function legacyGuardId(state: Pick<GuardState, "conversationId" | "stageId" | "startedAt">): string {
    return `legacy:${stableHash({
        conversationId: state.conversationId,
        stageId: state.stageId || "",
        childScopeId: MAIN_SCOPE_ID,
        startedAt: state.startedAt,
    })}`;
}

function normalizeGuardState(value: LegacyGuardState): GuardState | null {
    if (!value || !value.active || !value.conversationId || !Array.isArray(value.taskFiles) || !Array.isArray(value.planFiles)
        || !Array.isArray(value.checkHistory) || typeof value.startedAt !== "string") {
        return null;
    }
    const childScopeId = normalizeChildScopeId(value.childScopeId);
    const base = {
        ...value,
        stageId: value.stageId || "",
        childScopeId,
        scopeSelectors: normalizeScopeSelectors(value.scopeSelectors),
    } as Omit<GuardState, "guardId">;
    return {
        ...base,
        guardId: typeof value.guardId === "string" && value.guardId.trim()
            ? value.guardId
            : legacyGuardId(base),
    };
}

function readStateFile(filePath: string): GuardState | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        return normalizeGuardState(JSON.parse(fs.readFileSync(filePath, "utf-8")) as LegacyGuardState);
    } catch {
        return null;
    }
}

function isSameGuardKey(left: GuardState, right: GuardKey): boolean {
    const key = guardKeyForState(left);
    return key.conversationId === right.conversationId
        && key.stageId === right.stageId
        && key.childScopeId === right.childScopeId;
}

function migrateLegacyState(legacyPath: string, state: GuardState): GuardState {
    const destination = guardFilePath(guardKeyForState(state));
    writeJsonAtomic(destination, state);
    try {
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {
        // The new state has already been durably written. A later clear removes this fallback too.
    }
    return state;
}

/**
 * Read one exact GuardKey. With no stage/scope selector, compatibility mode returns a state only
 * when the conversation has exactly one active Guard; callers handling user input should list and
 * report ambiguity instead of relying on this convenience path.
 */
export function readGuardState(conversationId: string, stageId?: string, childScopeId?: string): GuardState | null {
    const exactSelector = stageId !== undefined || childScopeId !== undefined;
    if (!exactSelector) {
        const states = listGuardStates(conversationId);
        return states.length === 1 ? states[0] : null;
    }

    const key = createGuardKey(conversationId, stageId, childScopeId);
    const stored = readStateFile(guardFilePath(key));
    if (stored) return stored;
    if (key.childScopeId !== MAIN_SCOPE_ID) return null;

    const legacyPath = legacyGuardFilePath(conversationId);
    const legacy = readStateFile(legacyPath);
    if (!legacy || !isSameGuardKey(legacy, key)) return null;
    return migrateLegacyState(legacyPath, legacy);
}

/** Enumerate active guards without loading any conversation data. */
export function listGuardStates(conversationId?: string): GuardState[] {
    if (!fs.existsSync(GUARDS_DIR)) return [];
    const states: GuardState[] = [];
    const seen = new Set<string>();
    const add = (state: GuardState | null) => {
        if (!state) return;
        if (conversationId && state.conversationId !== conversationId) return;
        const identity = `${state.guardId}:${stableHash(guardKeyForState(state))}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        states.push(state);
    };

    const collectDirectory = (directory: string) => {
        try {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith(".json")) add(readStateFile(path.join(directory, entry.name)));
            }
        } catch {
            // A concurrent cleanup may remove a directory after enumeration starts.
        }
    };

    if (conversationId) {
        const directory = path.join(GUARDS_DIR, stableHash({ conversationId }));
        if (fs.existsSync(directory)) collectDirectory(directory);
        add(readStateFile(legacyGuardFilePath(conversationId)));
    } else {
        try {
            for (const entry of fs.readdirSync(GUARDS_DIR, { withFileTypes: true })) {
                const entryPath = path.join(GUARDS_DIR, entry.name);
                if (entry.isDirectory()) collectDirectory(entryPath);
                else if (entry.isFile() && entry.name.endsWith(".json")) add(readStateFile(entryPath));
            }
        } catch {
            return states;
        }
    }

    return states.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** Write a GuardKey-scoped state with an atomic file replacement. */
export function writeGuardState(state: GuardState): void {
    const normalized = normalizeGuardState(state);
    if (!normalized) throw new Error("invalid GuardState");
    writeJsonAtomic(guardFilePath(guardKeyForState(normalized)), normalized);
}

/** Compare the current state by GuardKey and immutable guardId before any side effect. */
export function isCurrentGuard(state: GuardState): boolean {
    const current = readGuardState(state.conversationId, state.stageId, state.childScopeId);
    return Boolean(current && current.guardId === state.guardId);
}

/** Fast compatibility helper. It only returns true when one Guard is unambiguous. */
export function isGuardActive(conversationId: string): boolean {
    return readGuardState(conversationId) !== null;
}

/** Append history only when the immutable Guard instance is still current. */
export function addCheckResult(
    stateOrConversationId: GuardState | string,
    result: "pass" | "fail",
    summary: string,
    missingItems: string[] = [],
): GuardState | null {
    const state = typeof stateOrConversationId === "string"
        ? readGuardState(stateOrConversationId)
        : stateOrConversationId;
    if (!state || !isCurrentGuard(state)) return null;

    const current = readGuardState(state.conversationId, state.stageId, state.childScopeId);
    if (!current || current.guardId !== state.guardId) return null;
    current.checkHistory.push({
        checkNumber: current.checkHistory.length + 1,
        result,
        missingItems,
        summary,
        checkedAt: new Date().toISOString(),
    });
    writeGuardState(current);
    return current;
}

function clearMatchingLegacyFallback(state: GuardState): void {
    if (normalizeChildScopeId(state.childScopeId) !== MAIN_SCOPE_ID) return;
    const legacyPath = legacyGuardFilePath(state.conversationId);
    const legacy = readStateFile(legacyPath);
    if (!legacy || legacy.stageId !== state.stageId || legacy.startedAt !== state.startedAt) return;
    try {
        fs.unlinkSync(legacyPath);
    } catch {
        // The keyed state was already cleared. Leaving a failed cleanup for a later retry is safer.
    }
}

/** Clear one exact GuardKey. A stale instance never removes a replacement. */
export function clearGuardState(stateOrConversationId: GuardState | string, stageId?: string, childScopeId?: string): boolean {
    const state = typeof stateOrConversationId === "string"
        ? readGuardState(stateOrConversationId, stageId, childScopeId)
        : stateOrConversationId;
    if (!state || !isCurrentGuard(state)) return false;
    const filePath = guardFilePath(guardKeyForState(state));
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        clearMatchingLegacyFallback(state);
        return true;
    } catch {
        return false;
    }
}

// ============= Task.md 🔒 标记管理 =============

const LOCK_BEGIN_PREFIX = "<!-- STAGE_GUARD_LOCK_BEGIN ";
const LOCK_END = "<!-- STAGE_GUARD_LOCK_END -->";
const LOCK_BLOCK_PATTERN = /<!-- STAGE_GUARD_LOCK_BEGIN ([^\n]*?) -->\r?\n[\s\S]*?<!-- STAGE_GUARD_LOCK_END -->\r?\n?/g;

export interface GuardFileLock {
    guardId?: string;
    conversationId: string;
    stageId: string;
    childScopeId: string;
    scopeSelectors: string[];
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
        guardId: state.guardId,
        conversationId: state.conversationId,
        stageId: state.stageId || "",
        childScopeId: normalizeChildScopeId(state.childScopeId),
        scopeSelectors: normalizeScopeSelectors(state.scopeSelectors),
        startedAt: state.startedAt,
        taskFile,
    });
}

function buildLockBlock(state: GuardState, taskFile: string): string {
    const label = [
        "🔒 STAGE GUARD ACTIVE",
        `guardId=${state.guardId}`,
        `conversationId=${state.conversationId}`,
        state.stageId ? `stageId=${state.stageId}` : "",
        `childScopeId=${normalizeChildScopeId(state.childScopeId)}`,
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
            if (!parsed.conversationId) continue;
            locks.push({
                guardId: typeof parsed.guardId === "string" && parsed.guardId.trim() ? parsed.guardId : undefined,
                conversationId: String(parsed.conversationId),
                stageId: String(parsed.stageId || ""),
                childScopeId: normalizeChildScopeId(parsed.childScopeId),
                scopeSelectors: normalizeScopeSelectors(parsed.scopeSelectors),
                startedAt: String(parsed.startedAt || ""),
                taskFile: String(parsed.taskFile || ""),
            });
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

function isLegacyLockForState(lock: GuardFileLock, state: GuardState): boolean {
    return !lock.guardId
        && normalizeChildScopeId(state.childScopeId) === MAIN_SCOPE_ID
        && lock.childScopeId === MAIN_SCOPE_ID
        && lock.conversationId === state.conversationId
        && lock.stageId === state.stageId
        && lock.startedAt === state.startedAt;
}

function isSameLock(lock: GuardFileLock, state: GuardState): boolean {
    return Boolean(lock.guardId && state.guardId && lock.guardId === state.guardId)
        || isLegacyLockForState(lock, state);
}

/** Read Task file Guard locks. Legacy lock blocks map only to the main scope. */
export function getGuardLocks(taskFile: string): GuardFileLock[] {
    try {
        if (!fs.existsSync(taskFile)) return [];
        return parseGuardLocks(fs.readFileSync(taskFile, "utf-8"));
    } catch {
        return [];
    }
}

/** Insert this exact Guard instance at the Task file head. */
export function insertLockMark(taskFile: string, state: GuardState): GuardLockOperationResult {
    try {
        if (!fs.existsSync(taskFile)) {
            return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "file not found" };
        }
        const content = fs.readFileSync(taskFile, "utf-8");
        const locks = parseGuardLocks(content);
        const legacyLockPresent = hasLegacyLock(content);
        if (locks.some(lock => isSameLock(lock, state))) {
            return {
                ok: true,
                inserted: false,
                legacyLockPresent,
                legacyLockRemoved: false,
                lockCount: locks.length,
                otherLockCount: locks.filter(lock => !isSameLock(lock, state)).length,
            };
        }
        fs.writeFileSync(taskFile, `${buildLockBlock(state, taskFile)}\n\n${content}`, "utf-8");
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

/**
 * Remove one exact Guard instance. The string overload is legacy-only and cannot remove v2 locks.
 * This protects new multi-scope locks from old conversationId-only callers.
 */
export function removeLockMark(taskFile: string, stateOrConversationId: GuardState | string): GuardLockOperationResult {
    try {
        if (!fs.existsSync(taskFile)) {
            return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "file not found" };
        }
        const content = fs.readFileSync(taskFile, "utf-8");
        const locks = parseGuardLocks(content);
        const legacyLockPresent = hasLegacyLock(content);
        const isStateTarget = typeof stateOrConversationId !== "string";
        const matches = (lock: GuardFileLock) => isStateTarget
            ? isSameLock(lock, stateOrConversationId as GuardState)
            : !lock.guardId && lock.conversationId === stateOrConversationId;
        let removed = false;
        let newContent = content.replace(LOCK_BLOCK_PATTERN, (block, rawJson) => {
            try {
                const parsed = JSON.parse(rawJson) as Partial<GuardFileLock>;
                const lock: GuardFileLock = {
                    guardId: typeof parsed.guardId === "string" && parsed.guardId.trim() ? parsed.guardId : undefined,
                    conversationId: String(parsed.conversationId || ""),
                    stageId: String(parsed.stageId || ""),
                    childScopeId: normalizeChildScopeId(parsed.childScopeId),
                    scopeSelectors: normalizeScopeSelectors(parsed.scopeSelectors),
                    startedAt: String(parsed.startedAt || ""),
                    taskFile: String(parsed.taskFile || ""),
                };
                if (matches(lock)) {
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
        const removesMainScope = !isStateTarget || normalizeChildScopeId((stateOrConversationId as GuardState).childScopeId) === MAIN_SCOPE_ID;
        if (legacyLockPresent && locks.length === 0 && remainingLocks.length === 0 && removesMainScope) {
            const legacyRemoval = removeLegacyLocks(newContent);
            newContent = legacyRemoval.content;
            legacyLockRemoved = legacyRemoval.removed;
            removed = removed || legacyRemoval.removed;
        }

        if (removed) newContent = newContent.replace(/^\s*\n/, "");
        if (newContent !== content) fs.writeFileSync(taskFile, newContent, "utf-8");
        return {
            ok: true,
            removed,
            legacyLockPresent,
            legacyLockRemoved,
            lockCount: remainingLocks.length,
            otherLockCount: remainingLocks.filter(lock => !matches(lock)).length,
        };
    } catch {
        return { ok: false, legacyLockPresent: false, legacyLockRemoved: false, lockCount: 0, otherLockCount: 0, error: "write failed" };
    }
}

/** Get one unambiguous Guard reminder for legacy callers. */
export function getGuardReminder(conversationId: string): string | null {
    const state = readGuardState(conversationId);
    if (!state) return null;
    const label = state.stageId || "活跃";
    return `\n⚠️ Stage Guard 活跃: ${label}，完成前请调 stage_guard(action="check")`;
}
