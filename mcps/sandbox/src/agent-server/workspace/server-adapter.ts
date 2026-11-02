import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ClientIdentity } from '../protocol.js';
import { pathIdentity } from '../security/policy.js';
import type { AgentStore } from '../storage/index.js';
import { createAgentWorkspacePorts } from '../storage/temporary-workspace.js';
import type { StorePort, StoreRecord } from '../storage/port.js';
import type { BoundToolContext } from '../tools/types.js';
import { createAgentWorkspaceRestoreCore } from './history.js';
import type { CoreRestorePort, RestorePreviewInput } from './restore.js';
import { WorkspaceChangesService } from './service.js';
import type { WorkspaceReadContext, WorkspaceChangesOptions } from './service.js';
import { withWorkspaceHistory } from './temporary-history.js';
import { WORKSPACE_RPC_SIGNATURES, WORKSPACE_RPC_METHOD_SPECS } from './rpc-signatures.js';
import type { WorkspaceRpcMethod, WorkspaceRpcParams } from './rpc-signatures.js';

export { WORKSPACE_RPC_SIGNATURES, WORKSPACE_RPC_METHOD_SPECS } from './rpc-signatures.js';
export type { WorkspaceRpcMethod, WorkspaceRpcParams } from './rpc-signatures.js';

export interface WorkspaceContextRequest {
    method: WorkspaceRpcMethod;
    conversationId: string;
    client: ClientIdentity;
    signal: AbortSignal;
    params: Readonly<WorkspaceRpcParams[WorkspaceRpcMethod]>;
}

export interface WorkspaceBoundContextRequest extends WorkspaceContextRequest {
    access: 'read' | 'write';
    purpose: 'inspect_plan' | 'preview' | 'commit';
    restorePlanId?: string;
}

export interface WorkspaceServerAdapterOptions {
    store: AgentStore;
    ports?: Pick<ReturnType<typeof createAgentWorkspacePorts>, 'journal' | 'restorePlans'>;
    files?: WorkspaceChangesOptions['files'];
    coordinator?: WorkspaceChangesOptions['coordinator'];
    resolveReadContext(input: WorkspaceContextRequest): Promise<WorkspaceReadContext>;
    resolveBoundContext(input: WorkspaceBoundContextRequest): Promise<BoundToolContext>;
    authorizeConversationWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<unknown>;
    quiesce: CoreRestorePort['quiesce'];
    signal?: AbortSignal;
}

export interface WorkspaceServerAdapter {
    readonly service: WorkspaceChangesService;
    readonly historyStore: StorePort;
    readonly methodSpecs: typeof WORKSPACE_RPC_METHOD_SPECS;
    handle(method: string, supplied: unknown, context: { client: ClientIdentity; signal?: AbortSignal }): Promise<unknown>;
    readRestoreFact(context: WorkspaceReadContext): Promise<Record<string, unknown> | null>;
    close(): void;
}

export function createWorkspaceServerAdapter(options: WorkspaceServerAdapterOptions): WorkspaceServerAdapter {
    const ports = options.ports ?? createAgentWorkspacePorts(options.store);
    const lifetime = new AbortController();
    const core = createAgentWorkspaceRestoreCore({ store: options.store, journal: ports.journal, plans: ports.restorePlans, quiesce: options.quiesce });
    const service = new WorkspaceChangesService({ journal: ports.journal, plans: ports.restorePlans, files: options.files,
        coordinator: options.coordinator, core });
    const historyStore = withWorkspaceHistory(options.store);
    const commandIdentity = (request: WorkspaceContextRequest): string => createHash('sha256').update(canonicalJson([
        request.client.principalId, request.client.clientId, request.conversationId,
        (request.params as { clientCommandId: string }).clientCommandId,
    ])).digest('hex');

    const owner = async (conversationId: string, principalId: string, signal: AbortSignal): Promise<StoreRecord> => {
        if (signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工作区控制请求已取消');
        if (!principalId || !conversationId) throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工作区请求需要已认证主体与明确会话');
        const conversation = await options.store.getRecord({ conversationId, kind: 'conversation', id: conversationId });
        if (!conversation) throw new AgentFault('CONVERSATION_NOT_FOUND', '工作区所属会话不存在或已经关闭');
        if (conversation.value.principalId !== principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '工作区请求主体与原会话不同');
        return conversation;
    };

    const checkBound = async (request: WorkspaceBoundContextRequest, context: BoundToolContext): Promise<void> => {
        if (context.conversationId !== request.conversationId || context.principalId !== request.client.principalId) {
            throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工作区resolver返回了不同的可信主体或会话');
        }
        const conversation = await owner(request.conversationId, context.principalId, request.signal);
        const retention = conversation.value.retention as { mode?: string } | undefined;
        if (context.policyRevision !== conversation.value.policyRevision || context.retention?.mode !== retention?.mode) {
            throw new AgentFault('POLICY_CHANGED', '工作区resolver返回的权限版本或保存方式已经变化');
        }
        const run = await options.store.getRecord({ conversationId: request.conversationId, kind: 'run', id: context.runId });
        if (!run || run.value.conversationId !== request.conversationId || run.value.runId !== context.runId
            || run.value.rootRunId !== context.rootRunId || run.value.runEpoch !== context.runEpoch) {
            throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工作区resolver必须绑定存储中实际登记的run及执行代际');
        }
        if (request.access === 'write') {
            if (conversation.value.state !== 'open' || (request.purpose === 'commit'
                && !['running', 'waiting', 'paused', 'recovering'].includes(String(run.value.state)))) {
                throw new AgentFault('INVALID_STATE', '恢复写入需要核心登记的有效执行和安全停止点');
            }
            const configured = conversation.value.options as Record<string, unknown> | undefined;
            const policy = configured?.policy as Record<string, unknown> | undefined;
            const roots = configured?.writeRoots ?? configured?.workspaceRoots ?? policy?.writeRoots ?? [];
            if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string') || !Array.isArray(context.roots)
                || canonicalJson([...new Set((roots as string[]).map(pathIdentity))].sort())
                    !== canonicalJson([...new Set(context.roots.map(pathIdentity))].sort())) {
                throw new AgentFault('POLICY_CHANGED', '工作区resolver的写根与会话当前获准写根不同');
            }
        }
    };

    const claimCommand = async (request: WorkspaceBoundContextRequest): Promise<string> => {
        const params = request.params as WorkspaceRpcParams['changes.preview'] | WorkspaceRpcParams['changes.commit'];
        const commandKey = commandIdentity(request);
        const { controlLeaseId: _lease, controlEpoch: _epoch, ...business } = params;
        const operationHash = createHash('sha256').update(canonicalJson({ method: request.method, params: business })).digest('hex');
        const key = { conversationId: request.conversationId, kind: 'step' as const, id: `workspace:rpc-command:${commandKey}` };
        const check = (previous: StoreRecord) => {
            if (previous.value.kind !== 'workspace_rpc_intent' || previous.value.operationHash !== operationHash) {
                throw new AgentFault('COMMAND_ID_REUSED', '该工作区RPC命令标识已经绑定不同方法或参数');
            }
        };
        const previous = await options.store.getRecord(key);
        if (previous) { check(previous); return commandKey; }
        try {
            await options.store.commitTransition({ expected: [{ key, revision: null }], records: [{ key, revision: 1,
                value: { kind: 'workspace_rpc_intent', operationHash, method: request.method } }] });
        } catch (error) {
            const observed = await options.store.getRecord(key);
            if (!observed) throw error;
            check(observed);
        }
        return commandKey;
    };

    return {
        service, historyStore, methodSpecs: WORKSPACE_RPC_METHOD_SPECS,
        async handle(method, supplied, caller) {
            if (!caller?.client?.principalId || !caller.client.clientId) throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工作区RPC需要已认证的principalId与clientId');
            if (!Object.hasOwn(WORKSPACE_RPC_SIGNATURES, method)) throw new AgentFault('METHOD_NOT_AVAILABLE', '工作区适配器没有该RPC方法');
            const name = method as WorkspaceRpcMethod;
            const parsed = WORKSPACE_RPC_SIGNATURES[name].safeParse(supplied);
            if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '工作区RPC参数不符合方法定义', {
                method, fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
            const params = parsed.data;
            const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []), ...(caller.signal ? [caller.signal] : [])]);
            const request: WorkspaceContextRequest = { method: name, conversationId: params.conversationId, client: caller.client, signal, params };
            await owner(request.conversationId, request.client.principalId, signal);
            if (name === 'changes.list' || (name === 'changes.get' && 'actionId' in params)) {
                const context = await options.resolveReadContext(request);
                if (context.principalId !== request.client.principalId || context.conversationId !== request.conversationId) {
                    throw new AgentFault('TOOL_CONTEXT_REQUIRED', '工作区只读resolver返回了不同主体或会话');
                }
                const bound = { ...context, signal: AbortSignal.any([signal, context.signal]) };
                await owner(request.conversationId, context.principalId, bound.signal);
                if (name === 'changes.list') {
                    const input = params as WorkspaceRpcParams['changes.list'];
                    return service.list({ cursor: input.cursor, limit: input.limit }, bound);
                }
                const input = params as Extract<WorkspaceRpcParams['changes.get'], { actionId: string }>;
                return service.get({ actionId: input.actionId, maxDiffBytes: input.maxDiffBytes }, bound);
            }
            const mutation = name !== 'changes.get';
            if (mutation) await options.authorizeConversationWrite(caller.client, params);
            const plannedId = name === 'changes.preview' ? `rpc-preview-${commandIdentity(request)}`
                : (params as { restorePlanId: string }).restorePlanId;
            const previous = mutation ? await ports.restorePlans.get(plannedId) : undefined;
            const replay = name === 'changes.preview' ? Boolean(previous)
                : name === 'changes.commit' && Boolean(previous && ['complete', 'pending'].includes(previous.state));
            if (name === 'changes.commit' && replay && previous?.data.commandId !== (params as { clientCommandId: string }).clientCommandId) {
                throw new AgentFault('COMMAND_ID_REUSED', '原恢复计划由不同提交命令使用');
            }
            const access = name === 'changes.get' || replay ? 'read' : 'write';
            const boundRequest: WorkspaceBoundContextRequest = { ...request, access,
                purpose: name === 'changes.get' || replay ? 'inspect_plan' : name === 'changes.preview' ? 'preview' : 'commit',
                ...(plannedId ? { restorePlanId: plannedId } : {}) };
            const resolved = await options.resolveBoundContext(boundRequest);
            await checkBound(boundRequest, resolved);
            if (access === 'write' && typeof resolved.assertCurrent !== 'function') throw new AgentFault('TOOL_CONTEXT_REQUIRED', '恢复resolver必须提供核心当前代际核对函数');
            const context: BoundToolContext = { ...resolved, signal: AbortSignal.any([signal, resolved.signal]),
                ...(access === 'write' ? { assertCurrent: async () => {
                    await options.authorizeConversationWrite(caller.client, params);
                    await resolved.assertCurrent!();
                    await checkBound(boundRequest, resolved);
                } } : {}) };
            if (name === 'changes.get') return service.get({ restorePlanId: (params as { restorePlanId: string }).restorePlanId }, context);
            if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工作区写入请求已取消');
            const commandKey = await claimCommand(boundRequest);
            if (replay) return service.get({ restorePlanId: plannedId }, context);
            await context.assertCurrent!();
            if (name === 'changes.preview') {
                const { conversationId: _conversation, clientCommandId: _command, controlLeaseId: _lease, controlEpoch: _epoch, ...input } = params as WorkspaceRpcParams['changes.preview'];
                return service.preview(input as RestorePreviewInput, context, `rpc-preview-${commandKey}`);
            }
            const input = params as WorkspaceRpcParams['changes.commit'];
            return service.commit({ restorePlanId: input.restorePlanId, clientCommandId: input.clientCommandId }, context);
        },
        async readRestoreFact(context) {
            const conversation = await owner(context.conversationId, context.principalId, context.signal);
            const fact = conversation.value.lastWorkspaceRestore;
            return fact && typeof fact === 'object' && !Array.isArray(fact) ? structuredClone(fact as Record<string, unknown>) : null;
        },
        close() { lifetime.abort(); },
    };
}
