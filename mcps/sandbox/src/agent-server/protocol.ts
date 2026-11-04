import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROVIDER_RPC_SIGNATURES } from './profiles/rpc-signatures.js';
import { WORKSPACE_RPC_METHOD_SPECS } from './workspace/rpc-signatures.js';
import { INPUT_ATTACHMENT_RPC_METHOD_SPECS } from './media/input-rpc.js';
import { MODULE_RPC_SPECS as CONFIGURATION_RPC_SPECS } from './configuration/rpc-specs.js';
import { CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS } from './conversation-lifecycle/rpc-signatures.js';

export const PROTOCOL_VERSION = 1;
export const SERVER_VERSION = '0.1.0';
export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ClientIdentity {
    principalId: string;
    clientId: string;
    callerHost?: string;
    callerConversationId?: string | null;
}

export interface AgentError {
    code: string;
    message: string;
    retryable: boolean;
    mayHaveStarted: boolean;
    actionId?: string;
    attemptId?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
}

export interface RpcResult<Data = unknown> {
    ok: boolean;
    data?: Data;
    error?: AgentError;
    receiptId?: string;
    eventCursor?: string;
}

export interface AgentEvent {
    schemaVersion: 1;
    eventId: string;
    eventSeq: string;
    conversationId: string;
    runId: string | null;
    runEpoch: number | null;
    occurredAt: string;
    type: string;
    payload: Record<string, unknown>;
}

export type RetainPolicy = {
    mode: 'temporary' | 'ttl' | 'archive';
    ttlDurationMs?: number;
};
export type RetentionPolicy = RetainPolicy;

export type RunState = 'accepted' | 'queued' | 'running' | 'waiting' | 'stopping' | 'paused'
    | 'recovering' | 'outcome_unknown' | 'succeeded' | 'failed' | 'cancelled';
export type RunPhase = 'admitting' | 'preparing' | 'uploading' | 'awaiting_response' | 'streaming'
    | 'executing_tools' | 'retry_backoff' | null;
export type CleanupState = 'not_needed' | 'pending' | 'running' | 'released' | 'unconfirmed';
export type ResultStatus = 'success' | 'partial' | 'failed' | 'cancelled' | 'unknown' | null;

export interface RunSnapshot {
    conversationId: string;
    runId: string;
    kind: 'task' | 'maintenance';
    runEpoch: number;
    state: RunState;
    phase: RunPhase;
    resultStatus: ResultStatus;
    stopReason: string | null;
    effectState: 'none' | 'confirmed' | 'unknown';
    cleanupState: CleanupState;
    activeRoundId: string | null;
    activeStepId: string | null;
    pendingInteractionIds: string[];
    budget: Record<string, unknown>;
    nextCheckpointAt: string | null;
    eventCursor: string | null;
    [key: string]: unknown;
}

export interface ServerDescriptor {
    schemaVersion: 1;
    serverInstanceId: string;
    pid: number;
    processStartedAt: string;
    endpoint: string;
    protocolVersion: 1;
    serverVersion: string;
    credentialRef: string;
    principalId: string;
    dataDir: string;
}

export interface RpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

export class AgentFault extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly mayHaveStarted: boolean;
    readonly retryable: boolean;

    constructor(code: string, message: string, details?: Record<string, unknown>, mayHaveStarted = false, retryable = false) {
        super(message);
        this.name = 'AgentFault';
        this.code = code;
        this.details = details;
        this.mayHaveStarted = mayHaveStarted;
        this.retryable = retryable;
    }

    toJSON(): AgentError {
        return { code: this.code, message: this.message, retryable: this.retryable,
            mayHaveStarted: this.mayHaveStarted, ...(this.details ? { details: this.details } : {}) };
    }
}

export function failure(error: unknown): RpcResult {
    if (error instanceof AgentFault) return { ok: false, error: error.toJSON() };
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Agent Server内部操作失败',
        retryable: false, mayHaveStarted: true } };
}

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new AgentFault('INVALID_PARAMS', '数值必须有限');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    throw new AgentFault('INVALID_PARAMS', '参数须为JSON兼容值');
}

export function operationHash(method: string, params: Record<string, unknown>): string {
    const { controlLeaseId: _lease, controlEpoch: _controlEpoch, ...operation } = params;
    if (method === 'conversations.branch') delete operation.previewToken;
    return createHash('sha256').update(canonicalJson({ method, params: operation })).digest('hex');
}

export function handshakePayload(clientNonce: string, serverNonce: string, clientId: string): string {
    return canonicalJson({ clientNonce, serverNonce, clientId, protocolVersion: PROTOCOL_VERSION });
}

const identifier = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const commandFields = { clientCommandId: identifier };
const controlFields = { controlLeaseId: identifier.optional(), controlEpoch: revision.optional() };
const conversationFields = { conversationId: identifier };
const runFields = { ...conversationFields, runId: identifier, expectedRunEpoch: revision.optional() };
const pageFields = { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional() };
const content = z.object({ text: z.string().max(MAX_FRAME_BYTES).default(''), references: z.array(z.unknown()).max(100).optional() }).strict();
export const retainPolicySchema = z.object({ mode: z.enum(['temporary', 'ttl', 'archive']),
    ttlDurationMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional() }).strict()
    .superRefine((policy, context) => {
        if (policy.mode === 'ttl' && policy.ttlDurationMs === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'ttl必须显式提供ttlDurationMs' });
        if (policy.mode !== 'ttl' && policy.ttlDurationMs !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: '仅ttl接受ttlDurationMs' });
    });

export interface MethodSpec {
    schema: z.ZodTypeAny;
    writes: boolean;
    scope: 'none' | 'server' | 'conversation';
    description: string;
}

function spec(shape: z.ZodRawShape, writes: boolean, scope: MethodSpec['scope'], description: string): MethodSpec {
    return { schema: z.object(shape).strict(), writes, scope, description };
}

export const METHOD_SPECS: Record<string, MethodSpec> = {
    'server.info': spec({}, false, 'none', '查看核心版本、能力及运行情况'),
    'server.claimControl': spec({ ...commandFields, scope: z.enum(['server', 'conversation']), conversationId: identifier.optional(), takeover: z.boolean().optional() }, true, 'none', '取得或明确接管控制租约'),
    'server.renewControl': spec({ ...commandFields, ...controlFields, scope: z.enum(['server', 'conversation']), conversationId: identifier.optional() }, true, 'none', '续原控制租约'),
    'server.releaseControl': spec({ ...commandFields, ...controlFields, scope: z.enum(['server', 'conversation']), conversationId: identifier.optional() }, true, 'none', '释放原控制租约'),
    'server.getReceipt': spec({ conversationId: identifier.optional(), targetClientCommandId: identifier }, false, 'none', '按原命令ID查询回执'),
    'server.readCommandResult': spec({ targetClientCommandId: identifier, offset: z.number().int().min(0).optional(), maxBytes: z.number().int().min(1).max(32768).optional() }, false, 'none', '按原命令ID分片读取完整大结果'),
    'server.tools.list': spec({ cursor: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).optional() }, false, 'none', '分页查看基础工具与本机五个MCP白名单摘要'),
    'server.tools.describe': spec({ toolId: identifier }, false, 'none', '按需加载一个工具的完整参数定义'),
    'server.shutdown': spec({ ...commandFields, ...controlFields, mode: z.enum(['drain', 'cancel']).default('drain'), graceMs: z.number().int().min(0).max(30_000).optional() }, true, 'server', '停止本核心并核资源清理'),
    'conversations.prepareTemporaryCreate': spec({}, false, 'none', '为一次明确的临时新建签发五分钟有效的原命令号；未知结果只查原号'),
    'conversations.create': spec({ ...commandFields, retention: retainPolicySchema, options: z.record(z.unknown()).optional(), callerHost: identifier.optional(), callerConversationId: identifier.nullable().optional() }, true, 'none', '创建临时、限时或归档会话；temporary须使用服务端签发的原命令号'),
    'conversations.list': spec({ ...pageFields, state: identifier.optional(), mode: z.enum(['temporary', 'ttl', 'archive']).optional() }, false, 'none', '分页查看会话摘要'),
    'conversations.get': spec(conversationFields, false, 'conversation', '查看会话及当前执行'),
    'conversations.update': spec({ ...conversationFields, ...commandFields, ...controlFields, expectedRevision: revision, options: z.record(z.unknown()) }, true, 'conversation', '更新下一请求使用的配置'),
    'conversations.close': spec({ ...conversationFields, ...commandFields, ...controlFields, reason: z.string().max(2048).optional() }, true, 'conversation', '关闭会话并回收派生资源'),
    'conversations.reopen': spec({ ...conversationFields, ...commandFields, ...controlFields }, true, 'conversation', '重开未过期持久会话'),
    'conversations.readHistory': spec({ ...conversationFields, ...pageFields, startRound: revision.optional(), endRound: revision.optional(), maxBytes: z.number().int().min(1).max(512 * 1024).optional() }, false, 'conversation', '有界读取原始历史'),
    'conversations.context': spec({ ...conversationFields, candidateId: identifier.optional() }, false, 'conversation', '查看上下文水位、压缩状态，或按原candidateId查看候选'),
    'conversations.compact': spec({ ...conversationFields, ...commandFields, ...controlFields,
        mode: z.enum(['preview', 'manual']).default('manual'), budget: z.record(z.unknown()).optional() },
    true, 'conversation', '预览压缩范围，或以独立维护执行和共享费用上限压缩当前对话'),
    'conversations.cancelCompaction': spec({ ...conversationFields, ...commandFields, ...controlFields,
        candidateId: identifier.optional(), expectedHistoryEpoch: revision.optional(), expectedRunEpoch: revision.optional() },
    true, 'conversation', '仅取消当前会话压缩并进入冷却，保留正常任务与未知原attempt'),
    'conversations.restartCompaction': spec({ ...conversationFields, ...commandFields, ...controlFields,
        candidateId: identifier.optional(), expectedHistoryEpoch: revision.optional(), expectedRunEpoch: revision.optional() },
    true, 'conversation', '查明原attempt后解除压缩冷却或熔断，不新发压缩请求'),
    'conversations.recoverCompaction': spec({ ...conversationFields, ...commandFields, ...controlFields,
        candidateId: identifier, expectedHistoryEpoch: revision.optional(), expectedRunEpoch: revision.optional() },
    true, 'conversation', '按原candidateId、冻结配置和原请求记录恢复，未知结果保持原状态'),
    'conversations.readArtifact': spec({ ...conversationFields, artifactId: identifier, offset: revision.default(0),
        maxBytes: z.number().int().min(1).max(512 * 1024).default(256 * 1024) }, false, 'conversation', '按原内容引用有界读取JSON或媒体分片及校验信息'),
    'conversations.listArtifacts': spec({ ...conversationFields, ...pageFields,
        maxBytes: z.number().int().min(1).max(256 * 1024).optional() }, false, 'conversation', '分页查看所属会话的媒体原件和待获取状态'),
    'runs.start': spec({ ...conversationFields, ...commandFields, ...controlFields, input: content, budget: z.record(z.unknown()), options: z.record(z.unknown()).optional() }, true, 'conversation', '启动一个有独立预算的执行'),
    'runs.startInteractive': spec({ ...conversationFields, ...commandFields, ...controlFields, input: content, options: z.record(z.unknown()).optional() }, true, 'conversation', '人工CLI开始对话，记录用量和费用，无强制金额上限'),
    'usage.overview': spec({ conversationId: identifier.optional(), profileId: identifier.optional() }, false, 'none', '查询当前对话实际用量与供应商可取得的余额'),
    'runs.get': spec({ ...conversationFields, runId: identifier }, false, 'conversation', '查询原执行状态'),
    'runs.list': spec({ ...conversationFields, ...pageFields }, false, 'conversation', '分页查询执行记录'),
    'runs.cancel': spec({ ...runFields, ...commandFields, ...controlFields, reason: z.string().max(2048).optional(), acknowledgeUnknown: z.literal(true).optional() }, true, 'conversation', '取消原执行；显式acknowledgeUnknown只结束已清理的本地等待，原结果及费用未知继续保留'),
    'runs.interrupt': spec({ ...runFields, ...commandFields, ...controlFields, reason: z.string().max(2048).optional() }, true, 'conversation', '中断至可恢复安全位置'),
    'runs.resume': spec({ ...runFields, ...commandFields, ...controlFields, expectedHistoryEpoch: revision, budget: z.record(z.unknown()).optional() }, true, 'conversation', '核原状态后继续执行'),
    'inputs.submit': spec({ ...runFields, ...commandFields, ...controlFields, mode: z.enum(['queue', 'steer']), content, draftId: identifier.optional(), draftRevision: revision.optional(), targetRoundId: identifier.optional(), expectedHistoryEpoch: revision }, true, 'conversation', '排下一轮或补充当前轮'),
    'inputs.list': spec({ ...conversationFields, runId: identifier.optional(), ...pageFields }, false, 'conversation', '查询待消费输入'),
    'inputs.update': spec({ ...runFields, ...commandFields, ...controlFields, inputId: identifier, content, expectedRevision: revision }, true, 'conversation', '修改未认领输入'),
    'inputs.remove': spec({ ...runFields, ...commandFields, ...controlFields, inputId: identifier, expectedRevision: revision }, true, 'conversation', '撤回未认领输入'),
    'inputs.reorder': spec({ ...runFields, ...commandFields, ...controlFields, inputIds: z.array(identifier).max(200), expectedRevision: revision }, true, 'conversation', '重排完整未认领队列'),
    'interactions.list': spec({ ...conversationFields, ...pageFields, runId: identifier.optional(), state: identifier.optional(),
        maxBytes: z.number().int().min(1).max(512 * 1024).optional() }, false, 'conversation', '分页查询所属任务等待批准的原动作'),
    'interactions.respond': spec({ ...conversationFields, ...commandFields, ...controlFields, interactionId: identifier,
        runId: identifier.optional(), expectedRunEpoch: revision, expectedRevision: revision,
        scopeHash: z.string().min(1).max(256), actionHash: z.string().min(1).max(256), policyRevision: revision,
        decision: z.enum(['approve', 'deny']) }, true, 'conversation', '主调用方核对原动作及范围后批准或拒绝'),
    'events.read': spec({ ...conversationFields, afterCursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).optional(), maxBytes: z.number().int().min(1).max(512 * 1024).optional(), waitMs: z.number().int().min(0).max(45_000).optional() }, false, 'conversation', '按游标补读事件'),
    'events.ack': spec({ ...conversationFields, appliedCursor: z.string().max(2048), subscriptionId: identifier.optional(), clientId: identifier.optional() }, false, 'conversation', '确认客户端已应用的游标'),
    'events.subscribe': spec({ ...conversationFields, afterCursor: z.string().max(2048).optional() }, false, 'conversation', '订阅当前会话事件'),
    'events.unsubscribe': spec({ subscriptionId: identifier }, false, 'none', '取消本客户端订阅'),
    'budgets.configureLimit': spec({ ...commandFields, ...controlFields, definition: z.object({
        amountMode: z.enum(['hard', 'estimated']).optional().describe('默认hard；estimated需根任务同时明确选择，单次实际收费可能超出估计金额'),
        quotaLimitId: identifier, currency: z.string().regex(/^[A-Z]{3}$/), maxCostMicros: z.number().int().safe().nonnegative(),
        quotaScopeIds: z.array(z.string().min(1).max(512)).min(1).max(128), sourceRef: z.string().min(1).max(8192),
    }).strict() }, true, 'server', '配置跨全部根任务共享且不可静默提高的供应商费用上限'),
    'budgets.get': spec({ rootBudgetId: identifier }, false, 'none', '读取原根预算、费用预留及关联总上限'),
    'budgets.reconcileResponses': spec({ ...commandFields, ...controlFields, attemptIds: z.array(identifier).min(1).max(32) }, true, 'server', '按原完整响应和冻结价格复核未知预留，不重发模型或工具'),
};

const providerReadMethods = new Set(['profiles.list', 'profiles.get', 'profiles.validate', 'models.list', 'models.get']);
Object.assign(METHOD_SPECS, WORKSPACE_RPC_METHOD_SPECS);
Object.assign(METHOD_SPECS, INPUT_ATTACHMENT_RPC_METHOD_SPECS);
for (const [method, schema] of Object.entries(PROVIDER_RPC_SIGNATURES)) {
    const writes = !providerReadMethods.has(method);
    METHOD_SPECS[method] = { schema: writes ? schema.extend(controlFields) : schema,
        writes, scope: writes ? 'server' : 'none', description: method.startsWith('profiles.') ? '管理脱敏API配置和受保护凭据引用' : '查询或刷新服务商模型目录' };
}
Object.assign(METHOD_SPECS, CONFIGURATION_RPC_SPECS);
Object.assign(METHOD_SPECS, CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS);

export const rpcRequestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]),
    method: identifier, params: z.record(z.unknown()).optional() }).strict();

export function validateParams(method: string, params: unknown): Record<string, unknown> {
    const methodSpec = METHOD_SPECS[method];
    if (!methodSpec) throw new AgentFault('METHOD_NOT_AVAILABLE', '该方法尚未安装或不可用', { method });
    const parsed = methodSpec.schema.safeParse(params ?? {});
    if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '请求参数不符合方法定义', {
        method, fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    return parsed.data as Record<string, unknown>;
}
