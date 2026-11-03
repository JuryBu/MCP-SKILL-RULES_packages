import { createHash, randomUUID } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import type { FunctionTool } from '../providers/types.js';
import { assertModelArguments, evaluatePolicy, isWithin, requirePolicy } from '../security/policy.js';
import type { ToolEffects } from '../security/policy.js';
import { ApprovalLedger } from '../security/approvals.js';
import type { ApprovalTicket } from '../security/approvals.js';
import { ResourceRegistry } from '../resources/registry.js';
import { SqlitePendingToolStore, SqliteWorkspaceJournal } from '../storage/workspace-port.js';
import { MemoryPendingToolStore, PendingToolCoordinator } from './pending.js';
import { summarizePending, TERMINAL_PENDING_STATES } from './pending-types.js';
import type { PendingToolStorePort, PendingToolListOptions, PendingToolPage, PendingToolCompletion } from './pending-types.js';
import { assertReadablePath, captureFile, ControlledFiles, directoryStamp, readFilePage } from '../workspace/versions.js';
import { changeIdentity, MemoryWorkspaceJournal, sharedWorkspaceCoordinator } from '../workspace/journal.js';
import type { WorkspaceCoordinator, WorkspaceJournalPort } from '../workspace/journal.js';
import { WorkspaceFileOperations, FILE_OPERATION_EFFECT_KINDS } from '../workspace/file-operations.js';
import { RestrictedCommandRunner } from './command-runner.js';
import type { CommandCapability } from './command-runner.js';
import { MODEL_FUNCTION_SCHEMAS, localArgumentSchemas } from './schemas.js';
import type { SharedMcpCatalog } from './catalog.js';
import type { BoundToolContext, ModelFunctionSchema, ToolCatalogEntry, ToolCleanupResult, ToolExecutionContext, ToolExecutionResult } from './types.js';
import type { DelegationTools } from './delegation.js';
import { ModelToolDiscovery } from './discovery.js';
import { HistoryRecallTools, isHistoryRecallTool } from './history.js';
import type { HistoryRecallPort } from './history.js';

export interface ToolRouterOptions {
    files?: ControlledFiles;
    commands?: RestrictedCommandRunner;
    journal?: WorkspaceJournalPort;
    coordinator?: WorkspaceCoordinator;
    maxCaptureBytes?: number;
    approvals?: ApprovalLedger;
    onApprovalRequested?: (ticket: ApprovalTicket) => void | Promise<void>;
    resources?: ResourceRegistry;
    shared?: SharedMcpCatalog;
    protectedPaths?: readonly string[];
    pendingTools?: PendingToolStorePort;
    delegation?: DelegationTools;
    history?: HistoryRecallPort;
}

export class ToolRouter {
    readonly files: ControlledFiles;
    readonly commands: RestrictedCommandRunner;
    readonly journal: WorkspaceJournalPort;
    readonly coordinator: WorkspaceCoordinator;
    readonly maxCaptureBytes: number;
    readonly approvals: ApprovalLedger;
    readonly fileOperations: WorkspaceFileOperations;
    readonly resources: ResourceRegistry;
    readonly shared?: SharedMcpCatalog;
    readonly pendingTools: PendingToolCoordinator;
    private readonly onApprovalRequested?: ToolRouterOptions['onApprovalRequested'];
    private readonly protectedPaths: readonly string[];
    private readonly executions = new Map<string, { controller: AbortController; pending: Set<Promise<ToolExecutionResult>> }>();
    private readonly closedRuns = new Set<string>();
    private commandCapability?: CommandCapability;
    private delegation?: DelegationTools;
    private history?: HistoryRecallTools;
    private readonly discovery: ModelToolDiscovery;

    constructor(options: ToolRouterOptions = {}) {
        this.files = options.files ?? new ControlledFiles();
        this.commands = options.commands ?? new RestrictedCommandRunner();
        this.journal = options.journal ?? new MemoryWorkspaceJournal();
        this.coordinator = options.coordinator ?? sharedWorkspaceCoordinator;
        this.maxCaptureBytes = options.maxCaptureBytes ?? 8 * 1024 * 1024;
        this.approvals = options.approvals ?? new ApprovalLedger();
        this.fileOperations = new WorkspaceFileOperations({ journal: this.journal, files: this.files,
            coordinator: this.coordinator, approvals: this.approvals, maxCaptureBytes: this.maxCaptureBytes });
        this.resources = options.resources ?? new ResourceRegistry();
        this.commands.attachResources?.(this.resources);
        this.shared = options.shared;
        this.delegation = options.delegation;
        this.history = options.history ? new HistoryRecallTools(options.history) : undefined;
        this.onApprovalRequested = options.onApprovalRequested;
        this.protectedPaths = Object.freeze([...(options.protectedPaths ?? [])]);
        const pendingStore = options.pendingTools ?? (this.journal instanceof SqliteWorkspaceJournal ? new SqlitePendingToolStore(this.journal.store) : new MemoryPendingToolStore());
        this.pendingTools = new PendingToolCoordinator(pendingStore, this.approvals, this.journal, (name, args, context) => this.executeBound(name, args, context));
        this.discovery = new ModelToolDiscovery(this);
    }

    private historyAvailable(name: string): boolean { return !!this.history && (name !== 'mark_history_hit' || this.history.canMarkHit); }

    private localSchemas(): readonly ModelFunctionSchema[] { return MODEL_FUNCTION_SCHEMAS.filter(schema => !isHistoryRecallTool(schema.name) || this.historyAvailable(schema.name)); }

    get modelFunctionSchemas(): readonly ModelFunctionSchema[] { return [...structuredClone(this.localSchemas()),
        ...(this.delegation?.modelFunctionSchemas ?? []), ...(this.shared?.modelFunctionSchemas() ?? [])]; }

    modelFunctionSchemasFor(trustedContext: ToolExecutionContext): readonly ModelFunctionSchema[] {
        const context = this.bind(trustedContext);
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具定义读取已取消');
        return [...structuredClone(this.localSchemas()), ...(context.runId === context.rootRunId ? this.delegation?.modelFunctionSchemas ?? [] : []),
            ...(this.shared?.modelFunctionSchemas(context) ?? [])];
    }

    modelSchemaHashesFor(trustedContext: ToolExecutionContext): Readonly<Record<string, string>> {
        return this.shared?.modelSchemaHashes(this.bind(trustedContext)) ?? Object.freeze({});
    }

    setDelegation(delegation: DelegationTools | undefined): void {
        if ([...this.executions.values()].some(execution => execution.pending.size > 0)) throw new AgentFault('INVALID_STATE', '工具动作在途时不能替换内部派发适配器');
        this.delegation = delegation;
    }

    setHistory(history: HistoryRecallPort | undefined): void {
        if ([...this.executions.values()].some(execution => execution.pending.size > 0)) throw new AgentFault('INVALID_STATE', '工具动作在途时不能替换历史查回端口');
        this.history = history ? new HistoryRecallTools(history) : undefined;
    }

    get definitions(): FunctionTool[] {
        return this.modelFunctionSchemas.map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters as JsonObject }));
    }

    async checkCommandCapability(): Promise<CommandCapability> {
        this.commandCapability = await this.commands.capabilities();
        return structuredClone(this.commandCapability);
    }

    list(): ToolCatalogEntry[] {
        const local: ToolCatalogEntry[] = MODEL_FUNCTION_SCHEMAS.map(schema => ({ toolId: `local.${schema.name}`, serviceId: 'local', name: schema.name,
            summary: schema.description, effectKinds: this.fileOperations.handles(schema.name) ? FILE_OPERATION_EFFECT_KINDS[schema.name]
                : schema.name === 'write_file' || schema.name === 'mark_history_hit' ? ['write'] : schema.name === 'run_command' ? ['process', 'network'] : ['read'],
            modelEffect: 'none', resourceKind: schema.name === 'run_command' ? 'process' : null,
            schemaHash: createHash('sha256').update(canonicalJson(schema.parameters)).digest('hex'), adapterVersion: '1',
            availability: isHistoryRecallTool(schema.name) && !this.historyAvailable(schema.name) ? 'unavailable' : schema.name === 'run_command' && !(this.commandCapability?.available === true
                && this.commandCapability.commandCapability === 'cooperative_windows_job') ? 'unavailable' : 'available',
            reason: isHistoryRecallTool(schema.name) && !this.historyAvailable(schema.name)
                ? this.history ? '历史有用命中的持久反馈端口尚未接入' : 'Core历史查回端口尚未接入'
                : schema.name === 'run_command' ? this.commandCapability?.reason ?? '命令执行器尚待按需检查；正常命令遵守当前任务与工作区规则' : null }));
        return [...local, ...(this.delegation?.modelFunctionSchemas ?? []).map((schema): ToolCatalogEntry => ({
            toolId: `local.${schema.name}`, serviceId: 'local', name: schema.name, summary: schema.description,
            effectKinds: schema.name === 'child_wait' ? ['read'] : ['external'],
            modelEffect: schema.name === 'child_spawn' ? 'invokes_model' : 'none', resourceKind: 'internal_child',
            schemaHash: createHash('sha256').update(canonicalJson(schema.parameters)).digest('hex'), adapterVersion: '1',
            availability: 'available', reason: '仅在可信根任务明确开启内部派发时向该模型展示' }))];
    }

    describe(name: string): ModelFunctionSchema {
        const schema = [...MODEL_FUNCTION_SCHEMAS, ...(this.delegation?.modelFunctionSchemas ?? [])]
            .find(entry => entry.name === name || `local.${entry.name}` === name);
        if (!schema) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在模型工具目录中启用');
        return structuredClone(schema);
    }

    async execute(name: string, args: unknown, trustedContext: ToolExecutionContext): Promise<ToolExecutionResult> {
        let context: BoundToolContext;
        try { context = this.bind(trustedContext); }
        catch (error) { return this.errorResult(error, trustedContext); }
        const key = this.runKey(context);
        if (this.closedRuns.has(key)) return this.errorResult(new AgentFault('TOOL_CANCELLED', '所属执行已清理，停止新增工具动作'), context);
        let execution = this.executions.get(key);
        if (!execution) { execution = { controller: new AbortController(), pending: new Set() }; this.executions.set(key, execution); }
        const signal = AbortSignal.any([context.signal, execution.controller.signal]);
        const pending = this.executeBound(name, args, { ...context, signal });
        execution.pending.add(pending);
        try { return await pending; }
        finally { execution.pending.delete(pending); }
    }

    private runKey(context: BoundToolContext): string { return JSON.stringify([context.conversationId, context.runId, context.runEpoch]); }

    async confirmReleased(trustedContext: ToolExecutionContext): Promise<'released' | 'not_needed' | 'unconfirmed'> {
        let context: BoundToolContext;
        try { context = this.bind(trustedContext); }
        catch { return 'unconfirmed'; }
        const key = this.runKey(context);
        if (this.executions.get(key)?.pending.size) return 'unconfirmed';
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        try {
            for (;;) {
                const pending = await this.pendingTools.list(context, { limit: 100, ...(cursor ? { cursor } : {}) });
                if (pending.items.length) return 'unconfirmed';
                if (!pending.nextCursor) break;
                if (seenCursors.has(pending.nextCursor)) return 'unconfirmed';
                seenCursors.add(pending.nextCursor);
                cursor = pending.nextCursor;
            }
        } catch { return 'unconfirmed'; }
        const resources = (await this.resources.store.list(context.conversationId, context.rootRunId)).filter(resource => resource.runId === context.runId);
        if (resources.some(resource => resource.state !== 'released' || resource.cleanupState !== 'released'
            || resource.receipt?.released !== true || resource.receipt.terminalConfirmed !== true)) return 'unconfirmed';
        this.closedRuns.add(key);
        this.executions.delete(key);
        this.commands.releaseForRun(context.conversationId, context.runId);
        this.shared?.releaseLocalRun(context.conversationId, context.runId);
        this.shared?.releaseLoadedTools(context);
        return resources.length ? 'released' : 'not_needed';
    }

    async cleanup(trustedContext: ToolExecutionContext): Promise<ToolCleanupResult> {
        let context: BoundToolContext;
        try { context = this.bind(trustedContext); }
        catch (error) { return { cleanupState: 'unconfirmed', resources: [], unresolvedResourceIds: [], error: this.errorResult(error, trustedContext).error }; }
        const key = this.runKey(context);
        this.closedRuns.add(key);
        const execution = this.executions.get(key);
        execution?.controller.abort();
        if (execution) await Promise.allSettled([...execution.pending]);
        this.executions.delete(key);
        this.commands.releaseForRun(context.conversationId, context.runId);
        this.shared?.releaseLocalRun(context.conversationId, context.runId);
        this.shared?.releaseLoadedTools(context);
        let pendingError: ToolCleanupResult['error'];
        try {
            const pending = await this.pendingTools.cancelRun('cancelled', context);
            if (pending.some(item => !item.ready)) pendingError = this.errorResult(new AgentFault('PENDING_TOOL_RELEASE_UNCONFIRMED', '原工具动作仍待回执确认',
                { pendingToolIds: pending.filter(item => !item.ready).map(item => item.pending.pendingToolId) }, true), context).error;
        } catch (error) { pendingError = this.errorResult(error, context).error; }
        try { await this.shared?.releaseResourceLeases(context); }
        catch (error) { pendingError ??= this.errorResult(error, context).error; }
        try {
            const resources = await this.resources.closeRun(context);
            const unresolvedResourceIds = resources.filter(resource => resource.state !== 'released').map(resource => resource.resourceId);
            return { cleanupState: unresolvedResourceIds.length || pendingError ? 'unconfirmed' : 'released', resources, unresolvedResourceIds,
                ...(pendingError ? { error: pendingError } : {}) };
        } catch (error) {
            return { cleanupState: 'unconfirmed', resources: [], unresolvedResourceIds: [], error: this.errorResult(error, context).error };
        }
    }

    async release(context: ToolExecutionContext): Promise<'released' | 'not_needed' | 'unconfirmed'> {
        const result = await this.cleanup(context);
        if (result.cleanupState === 'unconfirmed') return 'unconfirmed';
        return result.resources.length ? 'released' : 'not_needed';
    }

    async suspendForApproval(trustedContext: ToolExecutionContext): Promise<'released' | 'not_needed' | 'unconfirmed'> {
        const context = this.bind(trustedContext);
        const key = this.runKey(context);
        const execution = this.executions.get(key);
        execution?.controller.abort();
        if (execution) await Promise.allSettled([...execution.pending]);
        this.executions.delete(key);
        this.shared?.releaseLocalRun(context.conversationId, context.runId);
        let leasesReleased = true;
        try { await this.shared?.releaseResourceLeases(context); } catch { leasesReleased = false; }
        const resources = await this.resources.releaseIdle(context);
        if (!leasesReleased || resources.some(resource => resource.state !== 'released')) return 'unconfirmed';
        return resources.length ? 'released' : 'not_needed';
    }

    listPending(context: ToolExecutionContext, page?: PendingToolListOptions): Promise<PendingToolPage> {
        return this.pendingTools.list(this.bind(context), page);
    }
    getPending(pendingToolId: string, context: ToolExecutionContext): Promise<PendingToolCompletion> { return this.pendingTools.get(pendingToolId, this.bind(context)); }
    resumePending(pendingToolId: string, context: ToolExecutionContext): Promise<PendingToolCompletion> {
        const bound = this.bind(context);
        if (this.closedRuns.has(this.runKey(bound))) throw new AgentFault('TOOL_CANCELLED', '所属执行已清理，停止恢复原工具动作');
        return this.pendingTools.resume(pendingToolId, bound);
    }
    cancelPending(pendingToolId: string, reason: 'cancelled' | 'timed_out', context: ToolExecutionContext): Promise<PendingToolCompletion> { return this.pendingTools.cancel(pendingToolId, reason, this.bind(context)); }
    cancelPendingForRun(reason: 'cancelled' | 'timed_out', context: ToolExecutionContext): Promise<PendingToolCompletion[]> { return this.pendingTools.cancelRun(reason, this.bind(context)); }

    private async executeBound(name: string, args: unknown, bound: BoundToolContext): Promise<ToolExecutionResult> {
        let context: BoundToolContext | undefined;
        try {
            context = bound;
            args = JSON.parse(canonicalJson(args));
            await this.current(context);
            const localName = name.startsWith('local.') ? name.slice(6) : name;
            if (this.delegation?.handles(localName)) {
                if (localName === 'child_spawn' && args && typeof args === 'object' && !Array.isArray(args)) {
                    const remaining = { ...args as Record<string, unknown> };
                    delete remaining.writeRoots;
                    assertModelArguments(remaining);
                } else assertModelArguments(args);
                const result = await this.delegation.execute(localName, args, context);
                await this.current(context);
                return { ...result, disposition: 'completed' };
            }
            assertModelArguments(args);
            const schema = localArgumentSchemas[localName as keyof typeof localArgumentSchemas];
            if (!schema) {
                if (this.shared) return { ok: true, data: await this.shared.execute(name, args, context) };
                throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在模型工具目录中启用');
            }
            const parsed = schema.safeParse(args);
            if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '工具参数不符合当前结构定义', { issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
            let data: unknown;
            if (isHistoryRecallTool(localName)) {
                if (!this.history) throw new AgentFault('TOOL_UNAVAILABLE', 'Core历史查回端口尚未接入');
                data = await this.history.execute(localName, parsed.data, context);
            }
            else if (this.discovery.handles(localName)) data = await this.discovery.execute(localName, parsed.data, context);
            else if (localName === 'read_file') data = await this.read(localArgumentSchemas.read_file.parse(args), context);
            else if (localName === 'write_file') data = await this.write(localArgumentSchemas.write_file.parse(args), context,
                createHash('sha256').update(canonicalJson({ name, args })).digest('hex'));
            else if (this.fileOperations.handles(localName)) data = await this.fileOperations.execute(localName, args, context,
                createHash('sha256').update(canonicalJson({ name, args })).digest('hex'));
            else if (localName === 'list_files') data = await this.listFiles(localArgumentSchemas.list_files.parse(args), context);
            else data = await this.commands.execute(localArgumentSchemas.run_command.parse(args), context, this.resources);
            return { ok: true, data, disposition: 'completed' };
        } catch (error) {
            const result = this.errorResult(error, context ?? bound);
            if (error instanceof AgentFault && error.code === 'APPROVAL_REQUIRED' && context) {
                if (context.pendingExecution) return this.errorResult(new AgentFault('APPROVAL_STALE', '已批准的原动作仍需改变授权条件，请交可信调用方核对'), context);
                try {
                    const captured = await this.pendingTools.capture(name, args as Record<string, unknown>, context,
                        { paths: Array.isArray(error.details?.paths) ? error.details.paths as string[] : [], effects: [name], reason: error.message });
                    if (TERMINAL_PENDING_STATES.includes(captured.record.state) && captured.record.result) return captured.record.result;
                    result.approval = captured.ticket;
                    result.pendingTool = summarizePending(captured.record);
                    result.disposition = 'awaiting_approval';
                    result.error!.details = { ...result.error!.details, approvalId: captured.ticket.approvalId, pendingToolId: captured.record.pendingToolId };
                    try { await this.onApprovalRequested?.(captured.ticket); }
                    catch { result.error!.details = { ...result.error!.details, deliveryState: 'unconfirmed' }; }
                } catch (captureError) { return this.errorResult(captureError, context); }
            }
            return result;
        }
    }

    private errorResult(error: unknown, context: ToolExecutionContext): ToolExecutionResult {
        const fault = error instanceof AgentFault ? error : new AgentFault('TOOL_IO_FAILED', '工具未能完成文件或进程操作', {
            systemCode: typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code : null,
        });
        return { ok: false, error: { ...fault.toJSON(), actionId: context?.actionId ?? '', attemptId: context?.attemptId ?? '' } };
    }

    private bind(context: ToolExecutionContext): BoundToolContext {
        const roots = context && ('writeRoots' in context ? context.writeRoots : context.roots);
        if (!context || typeof context.runId !== 'string' || !context.runId || typeof context.conversationId !== 'string' || !context.conversationId
            || !Array.isArray(roots) || !context.signal || typeof context.signal.aborted !== 'boolean') {
            throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工具执行需要可信核心绑定的会话、执行、写入根和取消信号');
        }
        return Object.freeze({ ...context, roots: Object.freeze([...roots]),
            protectedPaths: Object.freeze([...this.protectedPaths, ...(context.protectedPaths ?? []), ...(context.command ? [context.command.controlRoot] : [])]), principalId: context.principalId ?? context.conversationId,
            rootRunId: context.rootRunId ?? context.runId, roundId: context.roundId ?? context.runId,
            actionId: context.actionId ?? randomUUID(), attemptId: context.attemptId ?? randomUUID(),
            runEpoch: context.runEpoch ?? 1, policyRevision: context.policyRevision ?? 1,
            command: context.command ? Object.freeze({ ...context.command, approvedAclRoots: Object.freeze([...context.command.approvedAclRoots]) }) : undefined,
            retention: Object.freeze({ ...(context.retention ?? { mode: 'archive' as const }) }) });
    }

    private async current(context: BoundToolContext): Promise<void> {
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '动作开始前已取消');
        await context.assertCurrent?.();
    }

    private async read(args: { path: string; offset: number; limit: number; encoding: 'utf8' | 'base64' }, context: BoundToolContext) {
        requirePolicy({ kinds: ['read'], readPaths: [args.path] }, context);
        const page = await readFilePage(args.path, context, args.offset, args.limit, this.files, args.encoding);
        const bytes = page.bytes;
        const content = args.encoding === 'base64' ? bytes.toString('base64')
            : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return { path: path.resolve(args.path), exists: page.version.exists, content, encoding: args.encoding, offset: page.offset,
            bytesRead: bytes.length, totalBytes: page.version.byteLength,
            nextOffset: page.nextOffset,
            version: page.version, expectedVersion: page.version.versionToken };
    }

    private async authorize(effects: ToolEffects, context: BoundToolContext, argsHash: string): Promise<void> {
        const permission = evaluatePolicy(effects, context);
        const forced = context.approvalRequiredTools?.some(name => name === 'write_file' || name === 'local.write_file') === true;
        if (permission.decision === 'allow' && !forced) return;
        if (permission.decision === 'deny') throw new AgentFault(permission.code!, permission.reason!, permission.details);
        const within = (effects.writePaths ?? []).every(candidate => context.roots.some(root => isWithin(candidate, root)));
        if (context.approvalId && within) { await this.approvals.consume(context.approvalId, context, argsHash); return; }
        throw new AgentFault('APPROVAL_REQUIRED', permission.reason ?? '该文件动作按本次可信策略等待批准', { paths: permission.paths ?? [...(effects.writePaths ?? [])] });
    }

    private async write(args: { path: string; content: string; expectedVersion: string; encoding: 'utf8' | 'base64' }, context: BoundToolContext, approvalArgsHash: string) {
        const filePath = path.resolve(args.path);
        await this.authorize({ kinds: ['write'], writePaths: [filePath] }, context, approvalArgsHash);
        if (!this.journal.supportedRetentions.includes(context.retention.mode)
            || (context.retention.mode !== 'temporary' && this.journal.persistence !== 'durable')) {
            throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '该保存方式需要在文件改动前持久提交prepared及原字节，当前工作区记录端口尚未接入',
                { retention: context.retention.mode, journalPersistence: this.journal.persistence });
        }
        await assertReadablePath(filePath, context);
        if (args.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.content))) {
            throw new AgentFault('INVALID_PARAMS', 'base64内容格式无效');
        }
        const content = Buffer.from(args.content, args.encoding === 'base64' ? 'base64' : 'utf8');
        if (content.length > this.maxCaptureBytes) throw new AgentFault('CHANGE_PREPARE_FAILED', '文件内容超过本次修改记录预算');
        const argsHash = createHash('sha256').update(canonicalJson({ ...args, path: filePath })).digest('hex');
        return this.coordinator.withPaths([filePath], async () => {
            const existing = await this.journal.get(context.conversationId, context.actionId);
            if (existing) {
                if (existing.argsHash !== argsHash) throw new AgentFault('COMMAND_ID_REUSED', '同一动作标识对应的参数已变化');
                if (existing.state === 'applied') return { ...existing.receipt, workspaceRevision: existing.workspaceRevisionAfter, replayed: true };
                throw new AgentFault('RESTORE_PENDING', '该动作已有未完成或失败记录，请查询原动作后处理', { state: existing.state }, existing.state !== 'failed');
            }
            await this.current(context);
            const version = await this.files.inspect(filePath, context.roots);
            if (version.versionToken !== args.expectedVersion) throw new AgentFault('VERSION_CONFLICT', '文件版本已经变化，请重新读取', { currentVersion: version });
            const before = await captureFile(filePath, version, this.maxCaptureBytes);
            const revision = await this.journal.revision(context.conversationId);
            await this.journal.prepare(changeIdentity(context, filePath, argsHash, version, before, content, revision));
            let committed = false;
            try {
                await this.current(context);
                const receipt = await this.files.commit(filePath, content, version, context.roots);
                committed = true;
                const action = await this.journal.settle(context.conversationId, context.actionId, { receipt });
                return { ...receipt, workspaceRevision: action.workspaceRevisionAfter, replayed: false };
            } catch (error) {
                const fault = committed ? new AgentFault('CHANGE_COMMIT_UNKNOWN', '文件已写入，修改回执尚待核心确认', undefined, true)
                    : error instanceof AgentFault ? error : new AgentFault('CHANGE_COMMIT_UNKNOWN', '修改结果待核对', undefined, true);
                await this.journal.settle(context.conversationId, context.actionId, { errorCode: fault.code, unknown: fault.mayHaveStarted });
                throw fault;
            }
        });
    }

    private async listFiles(args: { path: string; limit: number; cursor?: string }, context: BoundToolContext) {
        requirePolicy({ kinds: ['read'], readPaths: [args.path] }, context);
        await assertReadablePath(args.path, context);
        const stamp = await directoryStamp(args.path);
        let offset = 0;
        if (args.cursor) {
            let cursor;
            try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); }
            catch { throw new AgentFault('INVALID_PARAMS', '目录分页cursor无效'); }
            if (cursor.stamp !== stamp) throw new AgentFault('DIRECTORY_CHANGED', '目录在分页期间变化，请从第一页重新列出');
            if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new AgentFault('INVALID_PARAMS', '目录分页cursor无效');
            offset = cursor.offset;
        }
        const directory = await opendir(args.path);
        const entries: { name: string; path: string; kind: string }[] = [];
        let seen = 0;
        let hasNext = false;
        try {
            for await (const entry of directory) {
                const entryPath = path.join(path.resolve(args.path), entry.name);
                if ((context.protectedPaths ?? []).some(root => isWithin(entryPath, root))) continue;
                if (seen++ < offset) continue;
                if (entries.length === args.limit) { hasNext = true; break; }
                entries.push({ name: entry.name, path: entryPath,
                    kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'other' });
            }
        } finally { await directory.close().catch(() => {}); }
        if (await directoryStamp(args.path) !== stamp) throw new AgentFault('DIRECTORY_CHANGED', '列出期间目录发生变化，请重新读取');
        return { path: path.resolve(args.path), entries, nextCursor: hasNext ? Buffer.from(JSON.stringify({ stamp, offset: offset + entries.length })).toString('base64url') : null };
    }
}

export function createToolRouter(options?: ToolRouterOptions): ToolRouter { return new ToolRouter(options); }
