import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import { pathIdentity, requirePolicy } from '../security/policy.js';
import type { BoundToolContext } from '../tools/types.js';
import { changeIdentity, sharedWorkspaceCoordinator } from './journal.js';
import type { ChangeAction, WorkspaceCoordinator, WorkspaceJournalPort } from './journal.js';
import { captureFile, ControlledFiles } from './versions.js';
import type { FileVersion, RestoreCreatedFileProof } from './versions.js';
import type { RestorePlanStorePort, StoredRestorePlan } from '../storage/workspace-port.js';
import { fileHunks, reverseTextChange } from './text-restore.js';
import { assertChildWorkspaceRevisions, mergeRestoreActions, readJournalActions } from './round-children.js';
import type { RestoreSelection } from './round-children.js';

export type RestoreMode = 'files_only' | 'round_restart';

export interface RestorePreviewInput {
    mode: RestoreMode;
    expectedHistoryEpoch: number;
    expectedWorkspaceRevision: number;
    actionIds?: string[];
    roundId?: string;
    paths?: string[];
    hunks?: { actionId: string; hunkIds: string[] }[];
}

export interface RestorePathResult {
    path: string;
    status: 'restored' | 'skipped_conflict' | 'failed' | 'unknown';
    actionId?: string;
    code?: string;
    receiptId?: string;
    restoredHunks?: string[];
    conflictedHunks?: string[];
    operation?: 'restore_file' | 'remove_created_file';
}

export interface CoreRestorePort {
    validatePreview?(input: RestorePreviewInput, context: BoundToolContext): Promise<RestoreSelection>;
    quiesce(input: { restorePlanId: string; mode: RestoreMode; expectedHistoryEpoch: number; expectedWorkspaceRevision: number;
        targetRoundId?: string | null; childConversationIds?: string[] }, context: BoundToolContext): Promise<{ release(): Promise<void> }>;
    commitHistory(input: { restorePlanId: string; mode: RestoreMode; expectedHistoryEpoch: number; workspaceRevision: number;
        targetRoundId: string | null; actionIds: string[]; files: RestorePathResult[] }, context: BoundToolContext): Promise<Record<string, unknown>>;
}

interface RestoreOperation {
    path: string;
    actionId: string;
    target: Buffer | null;
    expected: FileVersion;
    current: FileVersion;
    code?: string;
    restoredHunks?: string[];
    conflictedHunks?: string[];
    removeCreated?: RestoreCreatedFileProof;
}

interface RestorePlan {
    restorePlanId: string;
    input: RestorePreviewInput;
    principalId: string;
    conversationId: string;
    policyRevision: number;
    rootsHash: string;
    actionIds: string[];
    childRevisions?: Record<string, number>;
    operations: RestoreOperation[];
    state: 'preview' | 'committing' | 'complete' | 'pending';
    results: RestorePathResult[];
    historyReceipt?: Record<string, unknown>;
    commandId?: string;
    revision: number;
}

export class MemoryRestorePlanStore implements RestorePlanStorePort {
    readonly persistence = 'memory' as const;
    private readonly records = new Map<string, StoredRestorePlan>();
    async get(restorePlanId: string): Promise<StoredRestorePlan | undefined> { return structuredClone(this.records.get(restorePlanId)); }
    async put(plan: StoredRestorePlan, expectedRevision: number | null): Promise<StoredRestorePlan> {
        const previous = this.records.get(plan.restorePlanId);
        if ((previous?.revision ?? null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '撤回计划版本已经变化');
        const saved = { ...structuredClone(plan), revision: (expectedRevision ?? 0) + 1 };
        this.records.set(plan.restorePlanId, saved);
        return structuredClone(saved);
    }
    clear(conversationId: string): void {
        for (const [planId, plan] of this.records) if (plan.conversationId === conversationId) this.records.delete(planId);
    }
}

export class WorkspaceRestorer {
    constructor(readonly journal: WorkspaceJournalPort, readonly files = new ControlledFiles(), readonly core?: CoreRestorePort,
        readonly coordinator: WorkspaceCoordinator = sharedWorkspaceCoordinator, readonly planStore: RestorePlanStorePort = new MemoryRestorePlanStore()) {}

    async preview(input: RestorePreviewInput, context: BoundToolContext, restorePlanId?: string): Promise<Record<string, unknown>> {
        if (!this.journal.supportedRetentions.includes(context.retention.mode)
            || (context.retention.mode !== 'temporary' && this.journal.persistence !== 'durable')) throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '当前保存方式的工作区修改记录尚未接入');
        if (context.retention.mode !== 'temporary' && this.planStore.persistence !== 'durable') throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '持久会话的撤回预览需要持久计划端口');
        if (!['files_only', 'round_restart'].includes(input.mode) || !Number.isSafeInteger(input.expectedHistoryEpoch)
            || !Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedHistoryEpoch < 0 || input.expectedWorkspaceRevision < 0) {
            throw new AgentFault('INVALID_PARAMS', '撤回模式或版本无效');
        }
        await context.assertCurrent?.();
        const replay = async (): Promise<Record<string, unknown> | undefined> => {
            if (!restorePlanId || !await this.planStore.get(restorePlanId)) return undefined;
            const previous = await this.ownedForExecution(restorePlanId, context);
            if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentFault('COMMAND_ID_REUSED', '原恢复预览命令已绑定不同选择或版本');
            return this.describe(previous);
        };
        const previous = await replay();
        if (previous) return previous;
        if (await this.journal.revision(context.conversationId) !== input.expectedWorkspaceRevision) throw new AgentFault('VERSION_CONFLICT', '工作区版本已变化，请重新预览');
        const selection = await this.core?.validatePreview?.(input, context);
        const all = mergeRestoreActions(await readJournalActions(this.journal, context.conversationId,
            input.mode === 'round_restart' && !selection?.roundIds ? undefined : action => this.select([action], input, selection?.roundIds).length > 0), selection);
        const selected = this.select(all, input, selection?.roundIds);
        if (!selected.length && input.mode !== 'round_restart') throw new AgentFault('INVALID_PARAMS', '没有符合条件的已记录修改');
        if (input.hunks?.some(selection => !selected.some(action => action.actionId === selection.actionId))) throw new AgentFault('INVALID_PARAMS', '所选片段的动作不在本次恢复范围');
        const groups = new Map<string, ChangeAction[]>();
        for (const action of selected) {
            const identity = pathIdentity(action.path);
            const group = groups.get(identity) ?? [];
            group.push(action);
            groups.set(identity, group);
        }
        const operations: RestoreOperation[] = [];
        for (const actions of [...groups.values()].reverse()) {
            const filePath = actions[actions.length - 1].path;
            requirePolicy({ kinds: ['write'], writePaths: [filePath] }, context);
            const last = actions[actions.length - 1];
            const first = actions[0];
            const current = await this.files.inspect(filePath, context.roots);
            const observed = await captureFile(filePath, current, 8 * 1024 * 1024);
            const operation: RestoreOperation = { path: filePath, actionId: randomUUID(), target: observed,
                expected: last.afterVersion ?? last.beforeVersion, current };
            operation.restoredHunks = []; operation.conflictedHunks = [];
            if (actions.some(action => action.state === 'prepared' || action.state === 'unknown')) operation.code = 'RESTORE_PENDING';
            else if (operation.target === null) operation.code = 'RESTORE_CONFLICT';
            else if (first.before === null) {
                if (input.hunks?.some(selection => actions.some(action => action.actionId === selection.actionId))) throw new AgentFault('INVALID_PARAMS', '新建文件撤回需要选择完整文件，不能只移除片段');
                const contiguous = actions.every((action, index) => index === 0 || action.beforeVersion.versionToken === actions[index - 1].afterVersion?.versionToken);
                if (!contiguous || first.beforeVersion.exists || !last.afterVersion?.sha256
                    || current.versionToken !== last.afterVersion.versionToken || current.sha256 !== last.afterVersion.sha256) operation.code = 'RESTORE_CONFLICT';
                else {
                    operation.target = null;
                    operation.removeCreated = { creationActionId: first.actionId, lastActionId: last.actionId, expectedSha256: last.afterVersion.sha256 };
                }
            }
            else if (operation.expected.versionToken !== current.versionToken
                && actions.some(action => action.before !== null && fileHunks(Buffer.from(action.before), Buffer.from(action.after)) === null)) operation.code = 'RESTORE_CONFLICT';
            else for (const action of [...actions].reverse()) {
                const hunkIds = input.hunks?.find(selection => selection.actionId === action.actionId)?.hunkIds;
                if (action.before === null) { operation.code = 'RESTORE_CONFLICT'; break; }
                if (operation.target.equals(action.after) && !hunkIds) operation.target = Buffer.from(action.before);
                else {
                    const reversed = reverseTextChange(Buffer.from(action.before), Buffer.from(action.after), operation.target, hunkIds);
                    operation.target = reversed.bytes;
                    operation.restoredHunks.push(...reversed.restoredHunks.map(id => `${action.actionId}:${id}`));
                    operation.conflictedHunks.push(...reversed.conflictedHunks.map(id => `${action.actionId}:${id}`));
                }
            }
            if (!operation.code && operation.conflictedHunks.length && !operation.restoredHunks.length
                && operation.target?.equals(observed ?? Buffer.alloc(0))) operation.code = 'RESTORE_CONFLICT';
            operations.push(operation);
        }
        const plan: RestorePlan = { restorePlanId: restorePlanId ?? randomUUID(), input: structuredClone(input), principalId: context.principalId,
            conversationId: context.conversationId, policyRevision: context.policyRevision, rootsHash: this.rootsHash(context),
            actionIds: selected.map(action => action.actionId), childRevisions: selection?.childRevisions,
            operations, state: 'preview', results: [], revision: 0 };
        try { await this.save(plan, null); }
        catch (error) {
            if (error instanceof AgentFault && error.code === 'WORKSPACE_CAS_CONFLICT') {
                const concurrent = await replay();
                if (concurrent) return concurrent;
            }
            throw error;
        }
        return this.describe(plan);
    }

    private select(all: ChangeAction[], input: RestorePreviewInput, roundIds?: string[]): ChangeAction[] {
        if (input.mode === 'round_restart') {
            if (!input.roundId) throw new AgentFault('INVALID_PARAMS', '重做一轮需要明确目标roundId');
            if (roundIds) return all.filter(action => action.state !== 'failed' && roundIds.includes(action.roundId));
            const first = all.findIndex(action => action.roundId === input.roundId);
            if (first < 0) return [];
            return all.slice(first).filter(action => action.state !== 'failed');
        }
        if (!input.actionIds?.length && !input.paths?.length && !input.roundId && !input.hunks?.length) throw new AgentFault('INVALID_PARAMS', '文件撤回需要选择动作、路径、片段或轮次');
        return all.filter(action => action.state !== 'failed' && (!input.actionIds || input.actionIds.includes(action.actionId))
            && (!input.hunks || input.hunks.some(selection => selection.actionId === action.actionId))
            && (!input.paths || input.paths.map(pathIdentity).includes(pathIdentity(action.path))) && (!input.roundId || action.roundId === input.roundId));
    }

    private rootsHash(context: BoundToolContext): string { return createHash('sha256').update(canonicalJson([...context.roots])).digest('hex'); }

    private async owned(planId: string, context: BoundToolContext): Promise<RestorePlan> {
        let plan: RestorePlan | undefined;
        {
            const stored = await this.planStore.get(planId);
            if (stored) {
                const data = stored.data as unknown as Omit<RestorePlan, 'operations'> & { operations: (Omit<RestoreOperation, 'target'> & { targetBase64: string | null })[] };
                if (data.restorePlanId !== stored.restorePlanId || data.conversationId !== stored.conversationId || !Array.isArray(data.operations)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '撤回计划正文与索引不一致');
                plan = { ...data, revision: stored.revision, operations: data.operations.map(({ targetBase64, ...operation }) => ({ ...operation,
                    target: targetBase64 === null ? null : Buffer.from(targetBase64, 'base64') })) };
            }
        }
        if (!plan || plan.principalId !== context.principalId || plan.conversationId !== context.conversationId) throw new AgentFault('TOOL_NOT_ALLOWED', '撤回预览未绑定当前可信主体');
        return plan;
    }

    private async ownedForExecution(planId: string, context: BoundToolContext): Promise<RestorePlan> {
        const plan = await this.owned(planId, context);
        if (plan.policyRevision !== context.policyRevision || plan.rootsHash !== this.rootsHash(context)) throw new AgentFault('POLICY_CHANGED', '撤回预览后的权限已经变化，请重新预览');
        return plan;
    }

    async get(planId: string, context: BoundToolContext): Promise<Record<string, unknown>> { return this.describe(await this.owned(planId, context)); }

    private async save(plan: RestorePlan, expectedRevision: number | null = plan.revision): Promise<void> {
        const data = { ...plan, operations: plan.operations.map(({ target, ...operation }) => ({ ...operation, targetBase64: target === null ? null : target.toString('base64') })) };
        const stored = await this.planStore.put({ restorePlanId: plan.restorePlanId, conversationId: plan.conversationId,
            principalId: plan.principalId, mode: plan.input.mode, historyEpoch: plan.input.expectedHistoryEpoch,
            workspaceRevision: plan.input.expectedWorkspaceRevision, policyRevision: plan.policyRevision,
            state: plan.state, actionIds: [...plan.actionIds], data, revision: plan.revision }, expectedRevision);
        plan.revision = stored.revision;
    }

    private describe(plan: RestorePlan): Record<string, unknown> {
        return { restorePlanId: plan.restorePlanId, mode: plan.input.mode, state: plan.state, revision: plan.revision,
            policyRevision: plan.policyRevision, rootsHash: plan.rootsHash,
            expectedHistoryEpoch: plan.input.expectedHistoryEpoch, expectedWorkspaceRevision: plan.input.expectedWorkspaceRevision,
            actionIds: plan.actionIds, childConversationIds: Object.keys(plan.childRevisions ?? {}), operations: plan.operations.map(operation => ({ path: operation.path,
                targetSha256: operation.target === null ? null : createHash('sha256').update(operation.target).digest('hex'),
                currentVersion: operation.current, conflict: operation.code ?? null,
                operation: operation.removeCreated ? 'remove_created_file' : 'restore_file' })), results: structuredClone(plan.results),
            hunks: plan.operations.map(operation => ({ path: operation.path, restored: operation.restoredHunks ?? [], conflicts: operation.conflictedHunks ?? [] })),
            historyReceipt: plan.historyReceipt ?? null, coverage: { restoreSupport: 'file-bytes-text-hunks-and-created-file-removal',
                unavailable: ['rename与原有文件删除恢复', '未记录的命令、MCP及远端效果'],
                historyCommit: this.core ? 'core-port-required-and-bound' : 'not-bound' } };
    }

    async commit(planId: string, clientCommandId: string, context: BoundToolContext): Promise<Record<string, unknown>> {
        const plan = await this.ownedForExecution(planId, context);
        if (!clientCommandId) throw new AgentFault('INVALID_PARAMS', '撤回提交需要稳定客户端命令标识');
        if (plan.commandId && plan.commandId !== clientCommandId) throw new AgentFault('COMMAND_ID_REUSED', '该预览已由另一个提交命令使用');
        if (plan.state === 'complete' || plan.state === 'pending') return this.describe(plan);
        if (plan.state === 'committing') throw new AgentFault('RESTORE_PENDING', '原撤回仍在提交，请查询原预览');
        if (!this.core) throw new AgentFault('RESTORE_PENDING', '撤回文件前需要核心绑定安全停止点和历史事务端口', { restorePlanId: planId });
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '撤回开始前已取消');
        const guard = await this.core.quiesce({ restorePlanId: planId, mode: plan.input.mode,
            expectedHistoryEpoch: plan.input.expectedHistoryEpoch, expectedWorkspaceRevision: plan.input.expectedWorkspaceRevision,
            targetRoundId: plan.input.roundId ?? null, childConversationIds: Object.keys(plan.childRevisions ?? {}) }, context);
        try {
            return await this.coordinator.withPaths(plan.operations.map(operation => operation.path), async () => {
                if (await this.journal.revision(context.conversationId) !== plan.input.expectedWorkspaceRevision) throw new AgentFault('VERSION_CONFLICT', '预览后的工作区版本变化，请重新预览');
                await assertChildWorkspaceRevisions(this.journal, plan.childRevisions);
                plan.commandId = clientCommandId;
                plan.state = 'committing';
                await this.save(plan);
                for (const operation of plan.operations) {
                    if (operation.code) {
                        plan.results.push({ path: operation.path, status: operation.code === 'RESTORE_CONFLICT' ? 'skipped_conflict' : 'failed', code: operation.code });
                        await this.save(plan);
                        continue;
                    }
                    let actionPrepared = false;
                    let fileCommitted = false;
                    let result: RestorePathResult;
                    try {
                        requirePolicy({ kinds: ['write'], writePaths: [operation.path] }, context);
                        await context.assertCurrent?.();
                        const current = await this.files.inspect(operation.path, context.roots);
                        if (current.versionToken !== operation.current.versionToken) {
                            result = { path: operation.path, status: 'skipped_conflict', code: 'RESTORE_CONFLICT' };
                        } else {
                            const before = await captureFile(operation.path, current, 8 * 1024 * 1024);
                            const restoreContext = { ...context, actionId: operation.actionId };
                            const hash = createHash('sha256').update(canonicalJson({ planId, path: operation.path, removeCreated: operation.removeCreated ?? null })).digest('hex');
                            const change = changeIdentity(restoreContext, operation.path, hash, current, before, operation.target ?? Buffer.alloc(0),
                                await this.journal.revision(context.conversationId), operation.removeCreated ? 'local.restore_created_file' : 'local.restore_file');
                            if (operation.removeCreated) change.restoreCreatedFrom = structuredClone(operation.removeCreated);
                            await this.journal.prepare(change);
                            actionPrepared = true;
                            if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '撤回文件提交前已取消');
                            await context.assertCurrent?.();
                            const receipt = operation.removeCreated
                                ? await this.files.restoreCreated(operation.path, current, context.roots, operation.removeCreated)
                                : await this.files.commit(operation.path, operation.target!, current, context.roots);
                            fileCommitted = true;
                            await this.journal.settle(context.conversationId, operation.actionId, { receipt });
                            result = { path: operation.path, status: 'restored', actionId: operation.actionId, receiptId: receipt.receiptId,
                                restoredHunks: operation.restoredHunks, conflictedHunks: operation.conflictedHunks,
                                operation: operation.removeCreated ? 'remove_created_file' : 'restore_file' };
                        }
                    } catch (error) {
                        const unknown = fileCommitted || !(error instanceof AgentFault) || error.mayHaveStarted;
                        const code = error instanceof AgentFault ? error.code : 'RESTORE_PENDING';
                        if (actionPrepared) await this.journal.settle(context.conversationId, operation.actionId, { errorCode: code, unknown });
                        result = { path: operation.path, status: unknown ? 'unknown' : code === 'VERSION_CONFLICT' ? 'skipped_conflict' : 'failed', code };
                    }
                    plan.results.push(result);
                    if (result.status === 'unknown') plan.state = 'pending';
                    await this.save(plan);
                    if (result.status === 'unknown') return this.describe(plan);
                }
                if (plan.results.some(result => result.status === 'failed' || result.status === 'unknown')) {
                    plan.state = 'pending';
                    await this.save(plan);
                    return this.describe(plan);
                }
                try {
                    plan.historyReceipt = await this.core!.commitHistory({ restorePlanId: planId, mode: plan.input.mode,
                        expectedHistoryEpoch: plan.input.expectedHistoryEpoch, workspaceRevision: await this.journal.revision(context.conversationId),
                        targetRoundId: plan.input.roundId ?? null, actionIds: plan.actionIds, files: structuredClone(plan.results) }, context);
                    plan.state = 'complete';
                } catch { plan.state = 'pending'; }
                await this.save(plan);
                return this.describe(plan);
            });
        } finally { await guard.release(); }
    }

    async recover(planId: string, context: BoundToolContext): Promise<Record<string, unknown>> {
        const plan = await this.ownedForExecution(planId, context);
        if (plan.state === 'preview' || plan.state === 'complete') return this.describe(plan);
        if (!this.core || !plan.commandId) throw new AgentFault('RESTORE_PENDING', '撤回恢复需要核心安全停止点及原提交标识');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '撤回恢复已取消');
        const currentRevision = await this.journal.revision(context.conversationId);
        const guard = await this.core.quiesce({ restorePlanId: planId, mode: plan.input.mode,
            expectedHistoryEpoch: plan.input.expectedHistoryEpoch, expectedWorkspaceRevision: currentRevision,
            targetRoundId: plan.input.roundId ?? null, childConversationIds: Object.keys(plan.childRevisions ?? {}) }, context);
        try {
            return await this.coordinator.withPaths(plan.operations.map(operation => operation.path), async () => {
                if (await this.journal.revision(context.conversationId) !== currentRevision) throw new AgentFault('VERSION_CONFLICT', '撤回恢复期间工作区版本变化');
                await assertChildWorkspaceRevisions(this.journal, plan.childRevisions);
                const ownActions = new Set(plan.operations.map(operation => operation.actionId));
                const later = (await this.journal.list(context.conversationId)).filter(action => (action.workspaceRevisionAfter ?? -1) > plan.input.expectedWorkspaceRevision
                    || action.state === 'prepared' || action.state === 'unknown');
                if (later.some(action => !ownActions.has(action.actionId))) throw new AgentFault('VERSION_CONFLICT', '原撤回之后已有其他修改，保留文件与待核对计划');
                const results: RestorePathResult[] = [];
                for (const operation of plan.operations) {
                    const action = await this.journal.get(context.conversationId, operation.actionId);
                    const saved = plan.results.find(result => result.path === operation.path);
                    if (action?.state === 'applied' && action.receipt) results.push({ path: operation.path, status: 'restored', actionId: operation.actionId, receiptId: action.receipt.receiptId,
                        operation: operation.removeCreated ? 'remove_created_file' : 'restore_file' });
                    else if (saved && saved.status !== 'unknown') results.push(saved);
                    else results.push({ path: operation.path, status: 'unknown', code: 'RESTORE_PENDING', actionId: operation.actionId });
                }
                plan.results = results;
                plan.state = 'pending';
                if (!results.some(result => result.status === 'failed' || result.status === 'unknown')) {
                    try {
                        plan.historyReceipt = await this.core!.commitHistory({ restorePlanId: planId, mode: plan.input.mode,
                            expectedHistoryEpoch: plan.input.expectedHistoryEpoch, workspaceRevision: currentRevision,
                            targetRoundId: plan.input.roundId ?? null, actionIds: plan.actionIds, files: structuredClone(results) }, context);
                        plan.state = 'complete';
                    } catch { plan.state = 'pending'; }
                }
                await this.save(plan);
                return this.describe(plan);
            });
        } finally { await guard.release(); }
    }
}
