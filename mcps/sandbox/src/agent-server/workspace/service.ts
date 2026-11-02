import { AgentFault } from '../protocol.js';
import type { BoundToolContext } from '../tools/types.js';
import { pathIdentity } from '../security/policy.js';
import type { RestorePlanStorePort } from '../storage/workspace-port.js';
import { describeChange } from './diff.js';
import type { ChangeAction, WorkspaceCoordinator, WorkspaceJournalPort } from './journal.js';
import { FileOperationsRestorer, fileOperationPaths } from './file-operations.js';
import type { FileOperationChange, FileOperationMetadata } from './file-operations.js';
import type { CoreRestorePort, RestorePreviewInput } from './restore.js';
import type { ControlledFiles } from './versions.js';
import { workspaceChangesListSchema as listSchema, workspaceChangesGetSchema as getSchema,
    workspaceChangesPreviewSchema as previewSchema, workspaceChangesCommitSchema as commitSchema } from './rpc-signatures.js';

export { listSchema as workspaceChangesListSchema, getSchema as workspaceChangesGetSchema,
    previewSchema as workspaceChangesPreviewSchema, commitSchema as workspaceChangesCommitSchema };

export interface WorkspaceReadContext {
    principalId: string;
    conversationId: string;
    signal: AbortSignal;
}
export interface ChangesListInput { cursor?: string; limit?: number }
export type ChangesGetInput = { actionId: string; maxDiffBytes?: number } | { restorePlanId: string };
export interface ChangesCommitInput { restorePlanId: string; clientCommandId: string }
export type ChangeSummary = Pick<ChangeAction, 'actionId' | 'runId' | 'roundId' | 'attemptId' | 'toolId' | 'path' | 'state'
    | 'workspaceRevisionBefore' | 'workspaceRevisionAfter'> & { beforeBytes: number; afterBytes: number; paths: string[]; fileOperation?: FileOperationMetadata };
export interface ChangesPage { changes: ChangeSummary[]; nextCursor: string | null; workspaceRevision: number }
export interface WorkspaceChangesOptions {
    journal: WorkspaceJournalPort;
    plans: RestorePlanStorePort;
    files?: ControlledFiles;
    coordinator?: WorkspaceCoordinator;
    core?: CoreRestorePort;
}

export class WorkspaceChangesService {
    readonly restorer: FileOperationsRestorer;
    constructor(readonly options: WorkspaceChangesOptions) {
        this.restorer = new FileOperationsRestorer(options.journal, options.files, options.core, options.coordinator, options.plans);
    }

    private readContext(context: WorkspaceReadContext): void {
        if (!context?.principalId || !context.conversationId || !context.signal) throw new AgentFault('TOOL_CONTEXT_REQUIRED', '修改记录需要核心核过会话归属的可信上下文');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '修改记录读取已取消');
    }

    private boundContext(context: WorkspaceReadContext, mutation: boolean): asserts context is BoundToolContext {
        this.readContext(context);
        const candidate = context as Partial<BoundToolContext>;
        if ([candidate.runId, candidate.rootRunId, candidate.roundId, candidate.actionId, candidate.attemptId].some(value => typeof value !== 'string' || !value)
            || !Number.isSafeInteger(candidate.runEpoch) || Number(candidate.runEpoch) < 1 || !Number.isSafeInteger(candidate.policyRevision)
            || !Array.isArray(candidate.roots) || !candidate.retention || !['temporary', 'ttl', 'archive'].includes(candidate.retention.mode)
            || (mutation && typeof candidate.assertCurrent !== 'function')) throw new AgentFault('TOOL_CONTEXT_REQUIRED', '撤回需要核心登记的run身份、写根、保存方式和当前权限核对函数');
        candidate.roots.forEach(pathIdentity);
    }

    async list(input: ChangesListInput, context: WorkspaceReadContext): Promise<ChangesPage> {
        this.readContext(context);
        const parsed = listSchema.safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '修改记录分页参数无效');
        const journal = this.options.journal;
        let page: { actions: ChangeAction[]; nextCursor: string | null };
        if (journal.listPage) page = await journal.listPage(context.conversationId, parsed.data);
        else {
            const all = await journal.list(context.conversationId);
            const offset = parsed.data.cursor ? Number(parsed.data.cursor) : 0;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentFault('INVALID_PARAMS', '修改记录cursor无效');
            page = { actions: all.slice(offset, offset + parsed.data.limit), nextCursor: offset + parsed.data.limit < all.length ? String(offset + parsed.data.limit) : null };
        }
        return { changes: page.actions.map(action => ({ actionId: action.actionId, runId: action.runId, roundId: action.roundId,
            attemptId: action.attemptId, toolId: action.toolId, path: action.path, state: action.state,
            workspaceRevisionBefore: action.workspaceRevisionBefore, workspaceRevisionAfter: action.workspaceRevisionAfter,
            beforeBytes: action.before?.length ?? 0, afterBytes: action.after.length, paths: fileOperationPaths(action),
            ...((action as FileOperationChange).fileOperation ? { fileOperation: structuredClone((action as FileOperationChange).fileOperation) } : {}) })), nextCursor: page.nextCursor,
            workspaceRevision: await journal.revision(context.conversationId) };
    }

    get(input: { actionId: string; maxDiffBytes?: number }, context: WorkspaceReadContext): Promise<Record<string, unknown>>;
    get(input: { restorePlanId: string }, context: BoundToolContext): Promise<Record<string, unknown>>;
    async get(input: ChangesGetInput, context: WorkspaceReadContext): Promise<Record<string, unknown>> {
        this.readContext(context);
        const parsed = getSchema.safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '修改记录查询需要一个actionId或restorePlanId');
        if ('restorePlanId' in parsed.data) {
            this.boundContext(context, false);
            return this.restorer.get(parsed.data.restorePlanId, context);
        }
        const action = await this.options.journal.get(context.conversationId, parsed.data.actionId);
        if (!action) throw new AgentFault('NOT_FOUND', '本会话没有该修改动作');
        return describeChange(action, parsed.data.maxDiffBytes);
    }

    preview(input: RestorePreviewInput, context: BoundToolContext, restorePlanId?: string): Promise<Record<string, unknown>> {
        this.boundContext(context, true);
        const parsed = previewSchema.safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '撤回预览参数无效');
        if (parsed.data.mode === 'round_restart' && (!parsed.data.roundId || parsed.data.actionIds || parsed.data.paths || parsed.data.hunks)) throw new AgentFault('INVALID_PARAMS', '重做一轮只按目标roundId选择该轮及后续修改');
        return this.restorer.preview(parsed.data, context, restorePlanId);
    }

    commit(input: ChangesCommitInput, context: BoundToolContext): Promise<Record<string, unknown>> {
        this.boundContext(context, true);
        const parsed = commitSchema.safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '撤回提交需要原restorePlanId和稳定clientCommandId');
        return this.restorer.commit(parsed.data.restorePlanId, parsed.data.clientCommandId, context);
    }

    recover(input: { restorePlanId: string }, context: BoundToolContext): Promise<Record<string, unknown>> {
        this.boundContext(context, true);
        const parsed = commitSchema.pick({ restorePlanId: true }).strict().safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '撤回恢复需要原restorePlanId');
        return this.restorer.recover(parsed.data.restorePlanId, context);
    }
}
