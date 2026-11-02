import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import { pathIdentity } from '../security/policy.js';
import type { BoundToolContext } from '../tools/types.js';
import type { RetainPolicy } from '../protocol.js';
import type { FileCommitReceipt, FileVersion, RestoreCreatedFileProof } from './versions.js';

export interface ChangeAction {
    actionId: string;
    conversationId: string;
    runId: string;
    roundId: string;
    attemptId: string;
    policyRevision: number;
    runEpoch: number;
    retention: RetainPolicy;
    toolId: string;
    argsHash: string;
    path: string;
    state: 'prepared' | 'applied' | 'failed' | 'unknown';
    beforeVersion: FileVersion;
    afterVersion?: FileVersion;
    before: Buffer | null;
    after: Buffer;
    workspaceRevisionBefore: number;
    workspaceRevisionAfter?: number;
    receipt?: FileCommitReceipt;
    errorCode?: string;
    restoreCreatedFrom?: RestoreCreatedFileProof;
}

export interface WorkspaceJournalPort {
    readonly persistence: 'memory' | 'durable';
    readonly supportedRetentions: readonly RetainPolicy['mode'][];
    get(conversationId: string, actionId: string): Promise<ChangeAction | undefined>;
    list(conversationId: string): Promise<ChangeAction[]>;
    listPage?(conversationId: string, input?: { cursor?: string; limit?: number; maxBytes?: number }): Promise<{ actions: ChangeAction[]; nextCursor: string | null }>;
    revision(conversationId: string): Promise<number>;
    prepare(action: ChangeAction): Promise<void>;
    settle(conversationId: string, actionId: string, result: { receipt?: FileCommitReceipt; errorCode?: string; unknown?: boolean }): Promise<ChangeAction>;
}

function cloneAction(action: ChangeAction): ChangeAction {
    return { ...structuredClone(action), before: action.before === null ? null : Buffer.from(action.before), after: Buffer.from(action.after) };
}

export class MemoryWorkspaceJournal implements WorkspaceJournalPort {
    readonly persistence = 'memory' as const;
    readonly supportedRetentions = ['temporary'] as const;
    private readonly actions = new Map<string, ChangeAction>();
    private readonly revisions = new Map<string, number>();
    private bytes = 0;

    constructor(readonly maxBytes = 64 * 1024 * 1024) {}

    private key(conversationId: string, actionId: string): string { return JSON.stringify([conversationId, actionId]); }
    async get(conversationId: string, actionId: string): Promise<ChangeAction | undefined> {
        const action = this.actions.get(this.key(conversationId, actionId));
        return action ? cloneAction(action) : undefined;
    }
    async list(conversationId: string): Promise<ChangeAction[]> {
        return [...this.actions.values()].filter(action => action.conversationId === conversationId).map(cloneAction);
    }
    async listPage(conversationId: string, input: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<{ actions: ChangeAction[]; nextCursor: string | null }> {
        const offset = input.cursor ? Number(input.cursor) : 0;
        const limit = input.limit ?? 24;
        const maxBytes = input.maxBytes ?? 32 * 1024 * 1024;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
            || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024) throw new AgentFault('INVALID_PARAMS', '工作区分页参数无效');
        const all = [...this.actions.values()].filter(action => action.conversationId === conversationId);
        const actions: ChangeAction[] = [];
        let bytes = 0;
        for (const action of all.slice(offset, offset + limit)) {
            const size = Buffer.byteLength(canonicalJson({ ...action, before: undefined, after: undefined })) + Math.ceil(((action.before?.length ?? 0) + action.after.length) * 4 / 3);
            if (bytes + size > maxBytes) {
                if (!actions.length) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '该动作超过分页预算，请按actionId读取');
                break;
            }
            bytes += size;
            actions.push(cloneAction(action));
        }
        return { actions, nextCursor: offset + actions.length < all.length ? String(offset + actions.length) : null };
    }
    async revision(conversationId: string): Promise<number> { return this.revisions.get(conversationId) ?? 0; }

    restoreConversationLifecycle(input: { conversationId: string; revision: number; actions: ChangeAction[] }): void {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 || this.revisions.has(input.conversationId)
            || [...this.actions.values()].some(action => action.conversationId === input.conversationId)) {
            throw new AgentFault('WORKSPACE_CAS_CONFLICT', '工作区恢复目标已有状态或原版本无效');
        }
        const ids = new Set<string>();
        for (const action of input.actions) {
            if (action.conversationId !== input.conversationId || !action.actionId || ids.has(action.actionId)
                || !Number.isSafeInteger(action.workspaceRevisionBefore) || action.workspaceRevisionBefore < 0
                || (action.workspaceRevisionAfter !== undefined
                    && (!Number.isSafeInteger(action.workspaceRevisionAfter) || action.workspaceRevisionAfter < 0))) {
                throw new AgentFault('WORKSPACE_CAS_CONFLICT', '工作区原动作归属、ID或版本无效');
            }
            ids.add(action.actionId);
        }
        const bytes = input.actions.reduce((total, action) => total + (action.before?.length ?? 0) + action.after.length, 0);
        if (this.bytes + bytes > this.maxBytes) throw new AgentFault('CHANGE_PREPARE_FAILED', '完整工作区快照超过原工厂预算');
        const copied = input.actions.map(cloneAction);
        for (const action of copied) this.actions.set(this.key(input.conversationId, action.actionId), action);
        this.revisions.set(input.conversationId, input.revision);
        this.bytes += bytes;
    }

    async prepare(action: ChangeAction): Promise<void> {
        if (action.retention.mode !== 'temporary') throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '内存修改记录仅用于临时会话');
        const key = this.key(action.conversationId, action.actionId);
        if (this.actions.has(key)) throw new AgentFault('COMMAND_ID_REUSED', '该动作已有修改记录，请查询原回执');
        const bytes = (action.before?.length ?? 0) + action.after.length;
        if (this.bytes + bytes > this.maxBytes) throw new AgentFault('CHANGE_PREPARE_FAILED', '修改前后字节超过本次记录预算，文件保持原状');
        this.actions.set(key, cloneAction(action));
        this.bytes += bytes;
    }
    async settle(conversationId: string, actionId: string, result: { receipt?: FileCommitReceipt; errorCode?: string; unknown?: boolean }): Promise<ChangeAction> {
        const action = this.actions.get(this.key(conversationId, actionId));
        if (!action) throw new AgentFault('CHANGE_PREPARE_FAILED', '修改准备记录缺失', undefined, true);
        if (action.state === 'applied') return cloneAction(action);
        if (result.receipt) {
            const revision = (this.revisions.get(conversationId) ?? 0) + 1;
            this.revisions.set(conversationId, revision);
            action.workspaceRevisionBefore = revision - 1;
            action.state = 'applied';
            action.afterVersion = structuredClone(result.receipt.afterVersion);
            action.receipt = structuredClone(result.receipt);
            action.workspaceRevisionAfter = revision;
        } else {
            action.state = result.unknown ? 'unknown' : 'failed';
            action.errorCode = result.errorCode;
        }
        return cloneAction(action);
    }
    clear(conversationId: string): void {
        for (const [key, action] of this.actions) if (action.conversationId === conversationId) {
            action.before?.fill(0);
            action.after.fill(0);
            this.bytes -= (action.before?.length ?? 0) + action.after.length;
            this.actions.delete(key);
        }
        this.revisions.delete(conversationId);
    }
}

export class WorkspaceCoordinator {
    private readonly tails = new Map<string, Promise<void>>();

    async withPaths<Value>(paths: readonly string[], operation: () => Promise<Value>): Promise<Value> {
        const keys = [...new Set(paths.map(pathIdentity))].sort();
        const acquire = async (index: number): Promise<Value> => {
            if (index === keys.length) return operation();
            const key = keys[index];
            const previous = this.tails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const pending = new Promise<void>(resolve => { release = resolve; });
            const tail = previous.then(() => pending);
            this.tails.set(key, tail);
            await previous;
            try { return await acquire(index + 1); }
            finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
        };
        return acquire(0);
    }
}

export const sharedWorkspaceCoordinator = new WorkspaceCoordinator();

export function changeIdentity(context: BoundToolContext, path: string, argsHash: string, beforeVersion: FileVersion,
    before: Buffer | null, after: Buffer, revision: number, toolId = 'local.write_file'): ChangeAction {
    return { actionId: context.actionId, conversationId: context.conversationId, runId: context.runId, roundId: context.roundId,
        attemptId: context.attemptId, policyRevision: context.policyRevision, runEpoch: context.runEpoch, retention: context.retention, toolId, argsHash,
        path, state: 'prepared', beforeVersion, before, after, workspaceRevisionBefore: revision };
}

export function bytesHash(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
