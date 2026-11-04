import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentFault, METHOD_SPECS, PROTOCOL_VERSION, SERVER_VERSION, canonicalJson, failure, operationHash, validateParams } from './protocol.js';
import type { AgentError, AgentEvent, CleanupState, ClientIdentity, JsonValue, RetainPolicy, RpcResult, RunPhase, RunSnapshot } from './protocol.js';
import { claimControl, controlKey, CONTROL_LEASE_MS, requireControl } from './controller.js';
import type { ControlLease } from './controller.js';
import { EventListeners, eventCursor, makeEvent, parseEventCursor } from './event-log.js';
import { MemoryStore } from './storage/memory.js';
import type { ContentWrite, InteractionData, ReceiptKey, RetentionSweepResult, StoreKey, StorePort, StoreRecord, StoredReceipt, StoreTransition } from './storage/port.js';
import { ExecutionRegistry, SerialScheduler } from './scheduler.js';
import { isTerminal, requireRunEpoch, transitionRun, validateBudget } from './state-machine.js';
import { recoverRun } from './recovery.js';
import { isStoppedUnknownWait } from './cleanup-reconciliation.js';
import { ProviderFault } from './providers/types.js';
import type { Acceptance, NormalizedResponse, ProviderProtocol, ToolCall, ToolResult } from './providers/types.js';
import type { HistoryPage, HistoryQuery } from './storage/port.js';
import type { ApprovalLedger, ApprovalTicket } from './security/approvals.js';
import type { BoundToolContext } from './tools/types.js';
import { matchesToolActionId } from './tool-action-identity.js';
import type { PendingToolCoordinator } from './tools/pending.js';
import type { AccountingPort, BudgetView } from './accounting/budget-ledger.js';
import type { ContextFailure, ExecutionLease, FrozenCompressionConfig } from './context/contracts.js';
import { InternalChildren, childAllocation, childLinks, rememberChildChange } from './delegation/runtime-children.js';
import { permissionConfiguration } from './security/configuration-policy.js';
import { TemporaryCreateCommands, TEMPORARY_CLOSE_RECOVERY_MS, TEMPORARY_METADATA_SWEEP_MS } from './temporary-create-command.js';

export interface ConversationData extends Record<string, unknown> {
    conversationId: string;
    principalId: string;
    callerHost: string | null;
    callerConversationId: string | null;
    state: 'open' | 'closing' | 'closed';
    retention: RetainPolicy & { lastRunEnd: string | null; lastClose: string | null; expiresAt: string | null; activeRuns: number };
    options: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
    workspaceRevision: number;
    runEpoch: number;
    activeRunId: string | null;
    eventGeneration: string;
    eventSeq: string;
    policyRevision: number;
    configRevision: number;
    closeReceiptKeys?: ReceiptKey[];
    cleanupState: CleanupState;
    cleanupError: AgentError | null;
    closeCleanupCompleted: boolean;
    temporaryCreateCommandExpiresAt?: string;
    temporaryMetadataExpiresAt?: string;
}

export interface RunData extends RunSnapshot {
    rootRunId: string;
    parentRunId: string | null;
    createdAt: string;
    updatedAt: string;
    deadlineAt: string;
    queueRevision: number;
    inputOrder: number;
    activeInputId: string | null;
    stopTarget: 'paused' | 'cancelled' | null;
    executorAvailable: boolean;
    resultContentId: string | null;
    failure: ExecutorFailureDetails | null;
    initiator?: ClientIdentity;
    continuationInteractionId?: string | null;
    resumeRequired?: boolean;
    hasCommittedEffects?: boolean;
    lastSuccessfulActionId?: string | null;
    lastSuccessfulAttemptId?: string | null;
}

export type CleanupEvidence = 'no_resources_created' | 'resources_released' | 'unconfirmed';

export interface ExecutorFailureFacts {
    acceptance: Acceptance;
    cleanupEvidence: CleanupEvidence;
    actionId?: string | null;
    attemptId?: string | null;
}

export interface ExecutorFailureDetails {
    error: AgentError;
    acceptance: Acceptance | null;
    cleanupEvidence: CleanupEvidence;
    actionId: string | null;
    attemptId: string | null;
}

export class ExecutorFailure extends AgentFault {
    readonly originalError: AgentFault;
    readonly facts: ExecutorFailureFacts;

    constructor(error: AgentFault, facts: ExecutorFailureFacts) {
        super(error.code, error.message, error.details, error.mayHaveStarted, error.retryable);
        this.name = 'ExecutorFailure';
        this.originalError = error;
        this.facts = Object.freeze({ ...facts });
    }
}

export interface InputData extends Record<string, unknown> {
    conversationId: string;
    runId: string;
    inputId: string;
    mode: 'queue' | 'steer';
    state: 'queued' | 'claimed' | 'consumed' | 'withdrawn';
    contentId: string;
    order: number;
    roundId: string | null;
    targetRoundId: string | null;
    consumedAtStepId: string | null;
    draftId: string | null;
    draftRevision: number | null;
    createdAt: string;
    preview: { text: string; truncated: boolean };
}

export interface ExecutorOutcome {
    status: 'succeeded' | 'failed' | 'paused' | 'outcome_unknown';
    result?: JsonValue;
    stopReason?: string;
    effectState?: RunSnapshot['effectState'];
    cleanupState: 'released' | 'not_needed' | 'unconfirmed';
    failure?: ExecutorFailureDetails;
}

export interface ExecutorContext {
    snapshot: RunSnapshot;
    conversationOptions: Record<string, unknown>;
    content: JsonValue;
    signal: AbortSignal;
    checkpoint(phase: RunPhase, payload?: Record<string, unknown>): Promise<void>;
    assertCurrent?(): Promise<void>;
    takeSteering(): Promise<JsonValue[]>;
    readHistory(query?: ExecutorHistoryQuery): Promise<HistoryPage>;
    readContent(contentId: string): Promise<JsonValue>;
    recordStep(step: ExecutorStepWrite): Promise<ExecutorStepReceipt>;
    requestApproval(request: ExecutorApprovalRequest): Promise<InteractionData & { revision: number }>;
    continuation: ExecutorToolContinuation | null;
}

export type ApprovalToolIdentity = Omit<BoundToolContext, 'signal' | 'assertCurrent'>;

export interface ExecutorApprovalRequest {
    operationId: string;
    approval: ApprovalTicket;
    stepId: string;
    callId: string;
    toolContext: ApprovalToolIdentity;
    state: JsonValue;
}

export interface ExecutorToolContinuation {
    interaction: InteractionData & { revision: number };
    protocol: ProviderProtocol;
    response: NormalizedResponse;
    call: ToolCall;
    toolContext: ApprovalToolIdentity;
    state: JsonValue;
}

interface StoredToolContinuation {
    protocol: ProviderProtocol;
    toolContext: ApprovalToolIdentity;
    state: JsonValue;
}

export type ExecutorHistoryQuery = Pick<HistoryQuery, 'cursor' | 'limit' | 'maxBytes' | 'direction' | 'startRound' | 'endRound'>;

interface ExecutorStepIdentity {
    operationId: string;
    stepId: string;
    actionId: string;
}

export type ExecutorStepWrite = ExecutorStepIdentity & (
    { kind: 'model'; protocol: ProviderProtocol; response: NormalizedResponse }
    | { kind: 'tool'; protocol: ProviderProtocol; originStepId: string; result: ToolResult }
    | { kind: 'summary'; source: { historyEpoch: number; firstSeq: number; lastSeq: number }; value: JsonValue }
);

export interface ExecutorStepReceipt {
    contentId: string;
    stepId: string;
    appendSeq: number;
    eventCursor: string;
}

export interface AgentExecutor {
    capabilities?: { hardBudget: boolean; toolApprovalContinuation?: boolean };
    execute(context: ExecutorContext): Promise<ExecutorOutcome>;
}

export interface AgentRuntimeOptions {
    store?: StorePort;
    now?: () => number;
    executor?: AgentExecutor;
    cleanupGraceMs?: number;
    approvalLedger?: Pick<ApprovalLedger, 'respond'>;
    pendingTools?: Pick<PendingToolCoordinator, 'cancel'>;
    accountingPort?: Pick<AccountingPort, 'read'>;
    internalChildRetentionOwnership?: 'parent-cascade-v1';
    reconcileRunCleanup?: (input: { snapshot: RunSnapshot; conversationOptions: Record<string, unknown>; preserveUnknownOutcome?: boolean }) => Promise<CleanupEvidence>;
    onConversationClosed?: (conversation: { conversationId: string; retention: RetainPolicy }) => Promise<void>;
}

interface CommandContext { key: ReceiptKey; hash: string; client: ClientIdentity; params: Record<string, unknown>; method?: string; temporaryCreateCommandExpiresAt?: number }
interface EventSpec { type: string; payload: Record<string, unknown>; run?: RunData }
interface Subscription { conversationId: string; principalId: string; clientId: string; appliedSeq: string }

interface ExecutorBinding {
    conversationId: string;
    runId: string;
    runEpoch: number;
    roundId: string;
    historyEpoch: number;
    signal: AbortSignal;
    readableContentIds: Set<string>;
    resourceActivity: boolean;
    actionId: string | null;
    attemptId: string | null;
    continuation: ExecutorToolContinuation | null;
}

interface ScheduledExecution {
    runEpoch: number;
    enteredExecutor: boolean;
    preparationCleanupState: CleanupState;
}

interface StepData extends Record<string, unknown> {
    kind: ExecutorStepWrite['kind'];
    runId: string;
    runEpoch: number;
    roundId: string;
    stepId: string;
    actionId: string;
    attemptId: string | null;
    contentId: string;
    complete: boolean;
    canExecuteTools: boolean;
    toolCalls: { callId: string; name: string }[];
    resolvedCallIds: string[];
}

const conversationKey = (conversationId: string): StoreKey => ({ conversationId, kind: 'conversation', id: conversationId });
const runKey = (conversationId: string, runId: string): StoreKey => ({ conversationId, kind: 'run', id: runId });
const inputKey = (conversationId: string, inputId: string): StoreKey => ({ conversationId, kind: 'input', id: inputId });
const interactionKey = (conversationId: string, interactionId: string): StoreKey => ({ conversationId, kind: 'interaction', id: interactionId });
const timestamp = (now: number): string => new Date(now).toISOString();
const valueHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

async function retryStoredRevision<Value>(operation: () => Promise<Value>): Promise<Value> {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
            if (code !== 'REVISION_CONFLICT' || !details || typeof details !== 'object'
                || !('expectedRevision' in details) || !('currentRevision' in details) || attempt >= 15) throw error;
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, attempt * 2 + 1)));
        }
    }
}

function inputPreview(content: unknown): { text: string; truncated: boolean } {
    const value = content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, unknown> : {};
    const text = typeof value.text === 'string' ? value.text : '';
    let preview = '';
    let characters = 0;
    for (const character of text) {
        if (characters === 128) return { text: preview, truncated: true };
        preview += character;
        characters++;
    }
    return { text: preview, truncated: false };
}

export function createAgentRuntime(options: AgentRuntimeOptions = {}) {
    const store = options.store ?? new MemoryStore();
    const now = options.now ?? Date.now;
    const temporaryCreateCommands = new TemporaryCreateCommands();
    const serial = new SerialScheduler();
    const executions = new ExecutionRegistry();
    const listeners = new EventListeners();
    const subscriptions = new Map<string, Subscription>();
    const eventWaiters = new Map<() => void, { conversationId: string; release: () => void }>();
    const liveRuns = new Map<string, RunData>();
    const liveInteractions = new Map<string, InteractionData>();
    const monotonicDeadlines = new Map<string, number>();
    const scheduled = new Set<string>();
    const executionConversations = new Map<string, string>();
    const pendingRetentionSweeps = new Set<string>();
    const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const maintenanceLeases = new Map<string, { execution: ExecutionLease; cancel: (execution: ExecutionLease) => Promise<CleanupEvidence> }>();
    const maintenanceCleanups = new Set<string>();
    const workspaceStops = new Map<string, string>();
    const pendingConversationClosures = new Set<string>();
    const cleanupGraceMs = options.cleanupGraceMs ?? 30_000;
    let executor = options.executor;
    let approvalLedger = options.approvalLedger;
    let pendingTools = options.pendingTools;
    let accountingPort = options.accountingPort;
    let internalChildren: InternalChildren;
    let historyReader: Pick<StorePort, 'readHistory'> = store;
    let accepting = true;
    let shutdownPlan: { mode: 'drain' | 'cancel'; graceMs: number } | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let temporaryMetadataTimer: ReturnType<typeof setTimeout> | undefined;
    let temporaryMetadataContinuation = false;

    async function listAll<Value>(kind: StoreKey['kind'], conversationId?: string | null): Promise<StoreRecord<Value>[]> {
        const records: StoreRecord<Value>[] = [];
        let cursor: string | undefined;
        do {
            const page = await store.listRecords<Value>({ kind, ...(conversationId !== undefined ? { conversationId } : {}), limit: 200, cursor });
            records.push(...page.items);
            cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
        } while (cursor);
        return records;
    }

    async function getConversation(conversationId: string, client?: ClientIdentity, allowGone = false): Promise<StoreRecord<ConversationData>> {
        const record = await store.getRecord<ConversationData>(conversationKey(conversationId));
        if (!record || (client && record.value.principalId !== client.principalId)) throw new AgentFault('NOT_FOUND', '找不到当前主体可读取的会话');
        if (!allowGone && record.value.state === 'closed' && record.value.retention.mode === 'temporary') throw new AgentFault('TEMPORARY_GONE', '临时会话已关闭，内容已经清除');
        return record;
    }

    function checkExpiry(conversation: ConversationData): void {
        const expiresAt = conversation.retention.expiresAt;
        if (conversation.retention.mode === 'ttl' && expiresAt && Date.parse(expiresAt) <= now() && conversation.retention.activeRuns === 0) {
            throw new AgentFault('RETENTION_EXPIRED', '会话保存期限已到，请通过存储策略入口处理');
        }
    }

    async function getRun(conversationId: string, runId: string): Promise<StoreRecord<RunData>> {
        const record = await store.getRecord<RunData>(runKey(conversationId, runId));
        if (!record) throw new AgentFault('NOT_FOUND', '找不到该会话内的执行');
        return record;
    }

    async function displayedRun(run: RunData, reads = new Map<string, Promise<BudgetView>>()): Promise<RunData> {
        const rootBudgetId = run.rootRunId ?? run.runId;
        const budget = { ...run.budget, rootBudgetId, callCountScope: 'root', spentModelCalls: null as number | null,
            heldModelCalls: null as number | null, usageSource: 'unavailable', usageStatus: 'unavailable' };
        if (!accountingPort) return { ...run, budget };
        try {
            let request = reads.get(rootBudgetId);
            if (!request) { request = accountingPort.read(rootBudgetId); reads.set(rootBudgetId, request); }
            const view = await request;
            const actual = view.budget;
            if (actual.rootBudgetId !== rootBudgetId || !Number.isSafeInteger(actual.spentCalls) || actual.spentCalls < 0
                || !Number.isSafeInteger(actual.heldCalls) || actual.heldCalls < 0) {
                throw new AgentFault('BUDGET_ASSOCIATION_MISMATCH', '调用统计未关联当前根预算');
            }
            return { ...run, budget: { ...budget, spentModelCalls: actual.spentCalls, heldModelCalls: actual.heldCalls,
                spentCostMicros: actual.spentMicros, heldCostMicros: actual.heldMicros, maxModelCalls: actual.maxModelCalls,
                maxCostMicros: actual.maxCostMicros, currency: actual.currency, amountUnknown: actual.amountUnknown,
                quotaAmountMode: view.quotaLimit?.amountMode ?? 'hard', unsettledModelCalls: actual.unsettledCalls ?? 0,
                effectiveAmountMode: actual.mode === 'estimated' && view.quotaLimit?.amountMode === 'estimated' ? 'estimated' : 'hard',
                usageSource: 'accounting', usageStatus: 'available', usageRevision: actual.version } };
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'ACCOUNTING_UNAVAILABLE';
            return { ...run, budget: { ...budget, usageError: code } };
        }
    }

    async function inputsFor(run: RunData): Promise<StoreRecord<InputData>[]> {
        return (await listAll<InputData>('input', run.conversationId)).filter(record => record.value.runId === run.runId)
            .sort((left, right) => left.value.order - right.value.order);
    }

    async function interactionsFor(run: RunData): Promise<StoreRecord<InteractionData>[]> {
        return (await listAll<InteractionData>('interaction', run.conversationId)).filter(record => record.value.runId === run.runId);
    }

    async function loadContinuation(interaction: StoreRecord<InteractionData>): Promise<ExecutorToolContinuation> {
        const item = interaction.value;
        const stored = await store.readContent(item.conversationId, item.continuationContentId) as unknown as StoredToolContinuation | undefined;
        const model = await store.readContent(item.conversationId, item.modelContentId) as unknown as { response?: NormalizedResponse } | undefined;
        const call = model?.response?.toolCalls.find(candidate => candidate.callId === item.callId);
        if (!stored || !model?.response?.complete || !model.response.canExecuteTools || !call || call.name !== item.toolName
            || model.response.attemptId !== item.attemptId || valueHash({ name: call.name, args: call.arguments }) !== item.argsHash
            || stored.toolContext.principalId !== item.principalId || stored.toolContext.runId !== item.runId
            || stored.toolContext.runEpoch < item.sourceRunEpoch || stored.toolContext.runEpoch > item.runEpoch || stored.toolContext.actionId !== item.actionId) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '批准动作的原调用或继续位置缺失，保留原动作供核对');
        }
        return { interaction: { ...item, revision: interaction.revision }, protocol: stored.protocol, response: model.response,
            call, toolContext: { ...stored.toolContext, runEpoch: item.runEpoch, approvalId: item.approvalId }, state: stored.state };
    }

    async function expireInteraction(record: StoreRecord<InteractionData>): Promise<void> {
        if (!['pending', 'approved', 'denied'].includes(record.value.state) || Date.parse(record.value.expiresAt) > now()) return;
        const conversation = await getConversation(record.value.conversationId, undefined, true);
        const runRecord = await getRun(record.value.conversationId, record.value.runId);
        const run = { ...runRecord.value, pendingInteractionIds: runRecord.value.pendingInteractionIds.filter(id => id !== record.value.interactionId),
            stopReason: 'INTERACTION_EXPIRED', updatedAt: timestamp(now()) };
        if (run.state === 'waiting' || run.state === 'queued') run.state = 'paused';
        const expired: StoreRecord<InteractionData> = { ...record, revision: record.revision + 1,
            value: { ...record.value, state: 'expired', resolvedAt: timestamp(now()) } };
        await closePendingInteraction(record, 'timed_out');
        await commit(conversation, [{ ...runRecord, revision: runRecord.revision + 1, value: run }, expired],
            [{ type: 'interaction.expired', payload: { interactionId: record.value.interactionId }, run }], null);
    }

    async function closePendingInteraction(record: StoreRecord<InteractionData>, reason: 'cancelled' | 'timed_out'): Promise<void> {
        if (!pendingTools || !record.value.pendingToolId || !['pending', 'approved', 'denied'].includes(record.value.state)) return;
        const continuation = await loadContinuation(record);
        await pendingTools.cancel(record.value.pendingToolId, reason, { ...continuation.toolContext, signal: new AbortController().signal });
    }

    function retentionEnd(conversation: ConversationData, field: 'lastClose' | 'lastRunEnd'): void {
        conversation.retention[field] = timestamp(now());
        if (conversation.retention.mode === 'ttl') {
            const start = Math.max(Date.parse(conversation.retention.lastClose ?? '') || 0, Date.parse(conversation.retention.lastRunEnd ?? '') || 0);
            conversation.retention.expiresAt = start ? timestamp(start + Number(conversation.retention.ttlDurationMs)) : null;
        }
    }

    function newReceipt(command: CommandContext, result: RpcResult): StoredReceipt {
        const data = result.data as Record<string, unknown> | undefined;
        const temporaryCreate = command.method === 'conversations.create' && (command.params.retention as RetainPolicy)?.mode === 'temporary'
            && result.ok && typeof data?.conversationId === 'string' && typeof data.commandExpiresAt === 'string'
            ? { conversationId: data.conversationId, expiresAt: data.commandExpiresAt } : undefined;
        return { key: command.key, operationHash: command.hash, result, createdAt: timestamp(now()), ...(temporaryCreate ? { temporaryCreate } : {}) };
    }

    async function commit(conversation: StoreRecord<ConversationData>, records: StoreRecord[], specs: EventSpec[], data: unknown,
        command?: CommandContext, contents: ContentWrite[] = [], extras: Partial<StoreTransition> = {}): Promise<RpcResult> {
        const value = structuredClone(conversation.value);
        value.updatedAt = timestamp(now());
        const events = specs.map(spec => makeEvent(value, spec.type, spec.payload, now(), spec.run ?? null));
        const cursor = eventCursor(value);
        const updated: StoreRecord<ConversationData> = { key: conversation.key, revision: conversation.revision + 1, value };
        for (const record of records) if (record.key.kind === 'run') (record.value as RunData).eventCursor = cursor;
        const result: RpcResult = { ok: true, data, eventCursor: cursor, ...(command ? { receiptId: randomUUID() } : {}) };
        const expectedMap = new Map<string, StoreTransition['expected'][number]>();
        for (const expected of [{ key: conversation.key, revision: conversation.revision },
            ...records.map(record => ({ key: record.key, revision: record.revision > 1 ? record.revision - 1 : null })), ...(extras.expected ?? [])]) {
            expectedMap.set(canonicalJson(expected.key), expected);
        }
        const expected = [...expectedMap.values()];
        const outcome = await store.commitTransition({ ...extras, expected, records: [updated, ...records], events,
            contents, ...(command ? { receipt: newReceipt(command, result) } : {}) });
        if (outcome.replayed && outcome.receipt) return outcome.receipt.result;
        for (const record of records) if (record.key.kind === 'run') {
            const run = record.value as RunData;
            if (isTerminal(run) && (run.cleanupState === 'released' || run.cleanupState === 'not_needed')) {
                liveRuns.delete(run.runId);
                monotonicDeadlines.delete(run.runId);
            } else {
                liveRuns.set(run.runId, structuredClone(run));
                if (!monotonicDeadlines.has(run.runId)) monotonicDeadlines.set(run.runId,
                    performance.now() + Math.max(0, Date.parse(run.deadlineAt) - now()));
            }
        }
        for (const record of records) if (record.key.kind === 'interaction') {
            const interaction = record.value as InteractionData;
            if (['pending', 'approved', 'denied'].includes(interaction.state)) liveInteractions.set(interaction.interactionId, structuredClone(interaction));
            else liveInteractions.delete(interaction.interactionId);
        }
        listeners.publish(events);
        armTimer();
        return result;
    }

    async function standaloneCommit(records: StoreRecord[], expected: StoreTransition['expected'], data: unknown,
        command: CommandContext): Promise<RpcResult> {
        const result: RpcResult = { ok: true, data, receiptId: randomUUID() };
        const outcome = await store.commitTransition({ expected, records, receipt: newReceipt(command, result) });
        return outcome.receipt?.result ?? result;
    }

    async function requireConversationControl(conversation: StoreRecord<ConversationData>, command: CommandContext): Promise<void> {
        const lease = await store.getRecord<ControlLease>(controlKey(conversation.value.conversationId));
        requireControl(lease, command.params, command.client, now());
    }

    async function claim(method: string, command: CommandContext): Promise<RpcResult> {
        const params = command.params;
        const conversationId = params.scope === 'conversation' ? String(params.conversationId ?? '') : null;
        if (params.scope === 'conversation' && !conversationId) throw new AgentFault('INVALID_PARAMS', '会话控制租约需要conversationId');
        if (params.scope === 'server' && params.conversationId !== undefined) throw new AgentFault('INVALID_PARAMS', 'server租约不接受conversationId');
        const conversation = conversationId ? await getConversation(conversationId, command.client) : undefined;
        const key = controlKey(conversationId);
        const previous = await store.getRecord<ControlLease>(key);
        let lease: StoreRecord<ControlLease>;
        if (method === 'server.claimControl') lease = claimControl(previous, conversationId, command.client, params.takeover === true, now());
        else {
            const current = requireControl(previous, params, command.client, now());
            lease = { key, revision: previous!.revision + 1, value: { ...current,
                expiresAt: timestamp(method === 'server.renewControl' ? now() + CONTROL_LEASE_MS : now()),
                released: method === 'server.releaseControl' } };
        }
        const data = { ...lease.value, ...(lease.value.released ? { released: true } : {}) };
        const expected = [{ key, revision: previous?.revision ?? null }];
        return conversation ? commit(conversation, [lease], [{ type: 'control.changed', payload: { controlEpoch: lease.value.controlEpoch,
            expiresAt: lease.value.expiresAt, released: lease.value.released } }], data, command, [], { expected })
            : standaloneCommit([lease], expected, data, command);
    }

    async function createConversation(command: CommandContext): Promise<RpcResult> {
        if (!accepting) throw new AgentFault('INVALID_STATE', '核心正在关闭，拒绝创建会话');
        const retention = command.params.retention as RetainPolicy;
        if (!store.capabilities.retentionModes.includes(retention.mode) || (retention.mode !== 'temporary' && !store.capabilities.persistent)) {
            throw new AgentFault('PERSISTENCE_UNAVAILABLE', '当前存储未提供所选保存方式', { mode: retention.mode, capabilities: store.capabilities });
        }
        const temporaryCommandExpiresAt = command.temporaryCreateCommandExpiresAt;
        const conversationId = randomUUID();
        const time = timestamp(now());
        const value: ConversationData = { conversationId, principalId: command.client.principalId,
            callerHost: command.client.callerHost ?? null, callerConversationId: command.client.callerConversationId ?? null,
            state: 'open', retention: { ...retention, lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 0 },
            options: { allowSubagents: false, ...command.params.options as Record<string, unknown> ?? {} },
            createdAt: time, updatedAt: time, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
            runEpoch: 0, activeRunId: null, eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1, configRevision: 1,
            cleanupState: 'not_needed', cleanupError: null, closeCleanupCompleted: false,
            ...(temporaryCommandExpiresAt === undefined ? {} : { temporaryCreateCommandExpiresAt: timestamp(temporaryCommandExpiresAt) }) };
        canonicalJson(value);
        const event = makeEvent(value, 'conversation.created', { retention: value.retention }, now());
        const lease = claimControl(undefined, conversationId, command.client, false, now());
        const result: RpcResult = { ok: true, data: { conversationId, revision: 1, retention: value.retention,
            control: lease.value, controlLeaseId: lease.value.controlLeaseId, controlEpoch: lease.value.controlEpoch,
            expiresAt: lease.value.expiresAt, taskLimits: { wallMs: 3_600_000, maxModelCalls: 128 } },
            receiptId: randomUUID(), eventCursor: eventCursor(value) };
        if (temporaryCommandExpiresAt !== undefined) Object.assign(result.data as Record<string, unknown>, {
            clientCommandId: command.key.clientCommandId, commandExpiresAt: timestamp(temporaryCommandExpiresAt) });
        const outcome = await store.commitTransition({ expected: [{ key: conversationKey(conversationId), revision: null }, { key: lease.key, revision: null }],
            records: [{ key: conversationKey(conversationId), revision: 1, value }, lease], events: [event], receipt: newReceipt(command, result) });
        if (!outcome.replayed) listeners.publish([event]);
        return outcome.receipt?.result ?? result;
    }

    function createInput(conversationId: string, runId: string, mode: InputData['mode'], content: unknown,
        order: number, params: Record<string, unknown>): { record: StoreRecord<InputData>; content: ContentWrite } {
        const inputId = randomUUID();
        const contentId = randomUUID();
        const value: InputData = { conversationId, runId, inputId, mode, contentId, state: 'queued', order,
            roundId: null, targetRoundId: typeof params.targetRoundId === 'string' ? params.targetRoundId : null,
            consumedAtStepId: null, draftId: typeof params.draftId === 'string' ? params.draftId : null,
            draftRevision: typeof params.draftRevision === 'number' ? params.draftRevision : null, createdAt: timestamp(now()), preview: inputPreview(content) };
        return { record: { key: inputKey(conversationId, inputId), revision: 1, value },
            content: { conversationId, contentId, kind: 'input', value: content as JsonValue, indexHistory: false } };
    }

    async function startRun(conversation: StoreRecord<ConversationData>, command: CommandContext): Promise<RpcResult> {
        if (conversation.value.workspaceQuiesce) throw new AgentFault('WORKSPACE_BUSY', '会话正在安全恢复，输入仍保留在草稿');
        if (!accepting || conversation.value.state !== 'open') throw new AgentFault('INVALID_STATE', '会话当前无法启动执行');
        checkExpiry(conversation.value);
        if (conversation.value.activeRunId) throw new AgentFault('INVALID_STATE', '会话已有未结束的执行，请向原执行提交输入');
        const interactive = command.method === 'runs.startInteractive';
        const budget = validateBudget(interactive
            ? { costMode: 'metered', maxCostMicros: null }
            : command.params.budget as Record<string, unknown>, now(), interactive);
        if (executor && budget.costMode === 'hard' && !executor.capabilities?.hardBudget) throw new AgentFault('BUDGET_UNBOUNDED', '执行器尚未声明可靠的硬金额限制');
        const runId = randomUUID();
        const time = timestamp(now());
        const run: RunData = { conversationId: conversation.value.conversationId, runId, rootRunId: runId, parentRunId: null,
            kind: 'task', runEpoch: conversation.value.runEpoch + 1, state: 'queued', phase: 'admitting', resultStatus: null,
            stopReason: null, effectState: 'none', cleanupState: 'not_needed', activeRoundId: null, activeStepId: null,
            pendingInteractionIds: [], budget, nextCheckpointAt: timestamp(now() + 15 * 60_000), eventCursor: null,
            createdAt: time, updatedAt: time, deadlineAt: String(budget.deadlineAt), queueRevision: 1, inputOrder: 1,
            activeInputId: null, stopTarget: null, executorAvailable: Boolean(executor), resultContentId: null, failure: null,
            initiator: structuredClone(command.client), continuationInteractionId: null, resumeRequired: false };
        run.options = structuredClone(command.params.options ?? {});
        const input = createInput(run.conversationId, runId, 'queue', command.params.input, 1, command.params);
        conversation.value.activeRunId = runId;
        conversation.value.runEpoch = run.runEpoch;
        conversation.value.retention.activeRuns = 1;
        const result = await commit(conversation, [{ key: runKey(run.conversationId, runId), revision: 1, value: run }, input.record],
            [{ type: 'run.queued', payload: { runId, executorAvailable: Boolean(executor), capability: executor ? null : 'EXECUTOR_UNAVAILABLE' }, run }],
            { ...run, inputId: input.record.value.inputId, capability: { available: Boolean(executor), reason: executor ? null : 'EXECUTOR_UNAVAILABLE' } }, command, [input.content]);
        schedule(run);
        await internalChildren.syncRetention(conversation.value);
        return result;
    }

    async function modifyInput(method: string, conversation: StoreRecord<ConversationData>, command: CommandContext): Promise<RpcResult> {
        if (conversation.value.workspaceQuiesce) throw new AgentFault('WORKSPACE_BUSY', '恢复期间不消费或修改会话输入');
        if (!accepting && (method === 'inputs.submit' || method === 'inputs.update')) throw new AgentFault('INVALID_STATE', '核心正在关闭，草稿仍由客户端保留');
        const params = command.params;
        const runRecord = await getRun(conversation.value.conversationId, String(params.runId));
        const run = runRecord.value;
        requireRunEpoch(run, params.expectedRunEpoch);
        if (run.kind !== 'task' || isTerminal(run) || run.state === 'stopping' || run.state === 'outcome_unknown') throw new AgentFault('INVALID_STATE', '该执行当前不接受队列更改，草稿仍由客户端保留');
        const records: StoreRecord[] = [];
        const contents: ContentWrite[] = [];
        let inputData: InputData | undefined;
        if (method === 'inputs.submit') {
            if (params.expectedHistoryEpoch !== conversation.value.historyEpoch) throw new AgentFault('REVISION_CONFLICT', '输入依据的历史版本已经变化');
            if (params.mode === 'steer' && (!run.activeRoundId || params.targetRoundId !== run.activeRoundId || run.state !== 'running')) {
                throw new AgentFault('TARGET_ROUND_CLOSED', '目标轮已经结束或尚未开始，草稿仍由客户端保留');
            }
            const input = createInput(run.conversationId, run.runId, params.mode as InputData['mode'], params.content, ++run.inputOrder, params);
            records.push(input.record);
            contents.push(input.content);
            inputData = input.record.value;
        } else {
            if (params.expectedRevision !== run.queueRevision) throw new AgentFault('REVISION_CONFLICT', '队列版本已经变化', { currentRevision: run.queueRevision });
            const inputs = await inputsFor(run);
            if (method === 'inputs.reorder') {
                const queued = inputs.filter(record => record.value.state === 'queued');
                const inputIds = params.inputIds as string[];
                if (new Set(inputIds).size !== inputIds.length || inputIds.length !== queued.length || queued.some(record => !inputIds.includes(record.value.inputId))) {
                    throw new AgentFault('REVISION_CONFLICT', '重排必须包含完整且无重复的未认领输入列表');
                }
                for (const record of queued) records.push({ ...record, revision: record.revision + 1,
                    value: { ...record.value, order: inputIds.indexOf(record.value.inputId) + 1 } });
                run.inputOrder = Math.max(run.inputOrder, queued.length);
            } else {
                const record = inputs.find(input => input.value.inputId === params.inputId);
                if (!record) throw new AgentFault('NOT_FOUND', '找不到指定输入');
                if (record.value.state !== 'queued') throw new AgentFault('INPUT_FROZEN', '该输入已经被认领或撤回');
                inputData = { ...record.value };
                if (method === 'inputs.remove') {
                    inputData.state = 'withdrawn';
                    inputData.preview = { text: '', truncated: false };
                    contents.push({ conversationId: run.conversationId, contentId: inputData.contentId, kind: 'withdrawn_input', value: null, indexHistory: false });
                }
                else {
                    inputData.preview = inputPreview(params.content);
                    contents.push({ conversationId: run.conversationId, contentId: inputData.contentId, kind: 'input', value: params.content as JsonValue, indexHistory: false });
                }
                records.push({ ...record, revision: record.revision + 1, value: inputData });
            }
        }
        run.queueRevision++;
        run.updatedAt = timestamp(now());
        records.push({ ...runRecord, revision: runRecord.revision + 1, value: run });
        return commit(conversation, records, [{ type: method, payload: { inputId: inputData?.inputId ?? null, revision: run.queueRevision }, run }],
            { ...(inputData ?? {}), revision: run.queueRevision }, command, contents);
    }

    async function endUnknownWait(conversation: StoreRecord<ConversationData>, record: StoreRecord<RunData>, command: CommandContext): Promise<RpcResult> {
        const run = record.value;
        if (conversation.value.activeRunId !== run.runId) throw new AgentFault('INVALID_STATE', '当前会话已由另一项执行占用，请查询原执行');
        if (executions.has(run.runId) || scheduled.has(run.runId) || executionConversations.has(run.runId)
            || cleanupTimers.has(run.runId) || maintenanceLeases.has(run.runId) || maintenanceCleanups.has(run.runId)
            || workspaceStops.has(run.conversationId)) throw new AgentFault('RUN_BUSY', '原执行仍有实际本地工作，暂时保留等待');
        if (!await internalChildren.released(run)) throw new AgentFault('CLEANUP_UNCONFIRMED', '所属子任务仍未确认收尾，原状态继续保留');
        const interactions = await interactionsFor(run);
        if (interactions.some(item => ['executing', 'outcome_unknown'].includes(item.value.state))) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '原工具交互仍待实际结果，原身份继续保留');
        }
        let cleanup: CleanupEvidence = 'unconfirmed';
        try { cleanup = await options.reconcileRunCleanup?.({ snapshot: structuredClone(run),
            conversationOptions: structuredClone(conversation.value.options), preserveUnknownOutcome: true }) ?? 'unconfirmed'; }
        catch { cleanup = 'unconfirmed'; }
        if (!['no_resources_created', 'resources_released'].includes(cleanup)) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '原本地资源仍未确认释放，原结果及费用未知继续保留');
        }
        const next = transitionRun(run, 'cancelled', { runEpoch: run.runEpoch + 1, phase: null,
            resultStatus: 'unknown', effectState: 'unknown', cleanupState: 'released', internalOwnCleanupState: 'released',
            activeInputId: null, pendingInteractionIds: [], continuationInteractionId: null, stopTarget: null,
            stopReason: 'CALLER_ENDED_UNKNOWN_WAIT', resumeRequired: false, updatedAt: timestamp(now()),
            waitEnded: true, unknownWaitEnd: { at: timestamp(now()), principalId: command.client.principalId,
                clientId: command.client.clientId, originalRunEpoch: run.runEpoch, originalState: run.state } });
        const withdrawn = (await inputsFor(run)).filter(input => input.value.state === 'queued').map(input => ({ ...input,
            revision: input.revision + 1, value: { ...input.value, state: 'withdrawn' as const } }));
        if (withdrawn.length) next.queueRevision++;
        const invalidated: StoreRecord<InteractionData>[] = interactions.filter(item => ['pending', 'approved', 'denied'].includes(item.value.state))
            .map(item => ({ ...item, revision: item.revision + 1, value: { ...item.value, runEpoch: next.runEpoch,
                state: 'cancelled', resolvedAt: timestamp(now()) } }));
        conversation.value.runEpoch = Math.max(conversation.value.runEpoch, next.runEpoch);
        endRun(conversation.value, next);
        const result = await commit(conversation, [{ ...record, revision: record.revision + 1, value: next }, ...withdrawn, ...invalidated],
            [{ type: 'run.unknownWaitEnded', payload: { waitEnded: true, resultStatus: 'unknown', effectState: 'unknown',
                accountingUnchanged: true, cleanupState: 'released', actionId: run.failure?.actionId ?? null,
                attemptId: run.failure?.attemptId ?? null }, run: next }], { ...await displayedRun(next), accountingUnchanged: true }, command);
        await internalChildren.syncRetention(conversation.value);
        await reconcileInternalParent(next);
        if (conversation.value.state === 'closing') await finishClose(conversation.value.conversationId);
        return result;
    }

    async function stopRun(conversation: StoreRecord<ConversationData>, record: StoreRecord<RunData>, target: 'paused' | 'cancelled',
        reason: string, command?: CommandContext): Promise<RpcResult> {
        const run = record.value;
        if (target === 'cancelled' && command?.params.acknowledgeUnknown === true && isStoppedUnknownWait(run)) {
            return endUnknownWait(conversation, record, command);
        }
        if (isTerminal(run)) return command ? commit(conversation, [], [], { ...run }, command) : { ok: true, data: run };
        if (run.state === 'outcome_unknown') {
            if (target === 'cancelled' && command?.params.acknowledgeUnknown === true) return endUnknownWait(conversation, record, command);
            await internalChildren.stopOwnedChildren(run, reason);
            throw new AgentFault('OUTCOME_UNKNOWN', '原执行的副作用仍待核实，请保留原动作身份', undefined, true);
        }
        if (command?.params.acknowledgeUnknown === true) throw new AgentFault('INVALID_STATE', '显式结束未知等待只适用于原outcome_unknown执行');
        if (run.state === 'stopping' && (run.stopTarget === 'cancelled' || target === 'paused')) {
            return command ? commit(conversation, [], [], { ...run, targetState: run.stopTarget }, command) : { ok: true, data: run };
        }
        const next = transitionRun(run, 'stopping', { runEpoch: run.runEpoch + 1, phase: null, stopReason: reason,
            cleanupState: 'pending', stopTarget: target, updatedAt: timestamp(now()) });
        conversation.value.runEpoch = Math.max(conversation.value.runEpoch, next.runEpoch);
        const inputs = target === 'cancelled' ? await inputsFor(run) : [];
        const withdrawn = inputs.filter(input => input.value.state === 'queued').map(input => ({ ...input, revision: input.revision + 1,
            value: { ...input.value, state: 'withdrawn' as const } }));
        const interactions = (await interactionsFor(run)).filter(item => ['pending', 'approved', 'denied', 'executing'].includes(item.value.state));
        const invalidated: StoreRecord<InteractionData>[] = interactions.map(item => ({ ...item, revision: item.revision + 1,
            value: { ...item.value, runEpoch: next.runEpoch, state: item.value.state === 'executing' ? 'outcome_unknown' : 'cancelled', resolvedAt: timestamp(now()) } }));
        next.pendingInteractionIds = [];
        const result = await commit(conversation, [{ ...record, revision: record.revision + 1, value: next }, ...withdrawn, ...invalidated],
            [{ type: 'run.stopping', payload: { targetState: target, reason, cleanupState: 'pending' }, run: next }],
            { ...next, targetState: target }, command);
        executions.cancel(run.runId, reason);
        await internalChildren.stopOwnedChildren(run, reason);
        const maintenance = maintenanceLeases.get(run.runId);
        if (maintenance) {
            maintenanceCleanups.add(run.runId);
            queueMicrotask(() => {
                void Promise.resolve().then(() => maintenance.cancel(maintenance.execution)).then(evidence => finishMaintenanceRun({ execution: maintenance.execution,
                    result: evidence === 'unconfirmed' ? 'unknown' : 'cancelled' })).catch(() => undefined)
                    .finally(() => { maintenanceCleanups.delete(run.runId); });
            });
        }
        for (const interaction of interactions) {
            try { await closePendingInteraction(interaction, 'cancelled'); }
            catch (error) {
                const current = await getConversation(run.conversationId, undefined, true);
                await commit(current, [], [{ type: 'interaction.cleanupUnconfirmed', payload: { interactionId: interaction.value.interactionId,
                    code: error instanceof AgentFault ? error.code : 'PENDING_TOOL_CLEANUP_FAILED' }, run: next }], null);
            }
        }
        if (!executions.has(run.runId) && !maintenance) queueMicrotask(() => { void serial.run(() => finalizeStop(next.conversationId, next.runId, 'released')).catch(() => undefined); });
        else {
            const existing = cleanupTimers.get(run.runId);
            if (existing) clearTimeout(existing);
            const cleanupTimer = setTimeout(() => {
                cleanupTimers.delete(run.runId);
                void serial.run(() => finalizeStop(next.conversationId, next.runId, 'unconfirmed')).catch(() => undefined);
            }, cleanupGraceMs);
            cleanupTimer.unref();
            cleanupTimers.set(run.runId, cleanupTimer);
        }
        return result;
    }

    async function finalizeStop(conversationId: string, runId: string, cleanupState: 'released' | 'unconfirmed'): Promise<void> {
        if (closed) return;
        const record = await getRun(conversationId, runId);
        if (record.value.state !== 'stopping') return;
        const cleanupTimer = cleanupTimers.get(runId);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimers.delete(runId);
        const conversation = await getConversation(conversationId, undefined, true);
        const target = record.value.stopTarget ?? 'cancelled';
        const ownCleanupState = cleanupState;
        if (cleanupState === 'released' && !await internalChildren.released(record.value)) cleanupState = 'unconfirmed';
        const run = transitionRun(record.value, target, { cleanupState, internalOwnCleanupState: ownCleanupState,
            resultStatus: record.value.effectState === 'unknown' || record.value.resultStatus === 'unknown' ? 'unknown'
                : target === 'cancelled' ? 'cancelled' : record.value.resultStatus, phase: null, updatedAt: timestamp(now()) });
        if (target === 'cancelled') endRun(conversation.value, run);
        await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }],
            [{ type: `run.${target}`, payload: { cleanupState }, run }], { ...run });
        await internalChildren.syncRetention(conversation.value);
        await reconcileInternalParent(run);
        if (conversation.value.state === 'closing' && target === 'cancelled' && cleanupState === 'released') await finishClose(conversationId);
    }

    async function reconcileInternalParent(child: RunData): Promise<void> {
        const allocation = childAllocation(child);
        if (!allocation) return;
        const parent = await getRun(allocation.parentConversationId, allocation.parentRunId);
        const release = isTerminal(parent.value) && parent.value.cleanupState === 'unconfirmed'
            && parent.value.internalOwnCleanupState === 'released' && await internalChildren.released(parent.value);
        const unknownEffect = child.effectState === 'unknown' && parent.value.effectState !== 'unknown';
        if (!release && !unknownEffect) return;
        const conversation = await getConversation(parent.value.conversationId, undefined, true);
        const run = { ...parent.value, ...(release ? { cleanupState: 'released' as const } : {}),
            ...(unknownEffect ? { effectState: 'unknown' as const } : {}) };
        if (release) endRun(conversation.value, run);
        await commit(conversation, [{ ...parent, revision: parent.revision + 1, value: run }],
            [{ type: 'run.childFacts', payload: { cleanupState: run.cleanupState, effectState: run.effectState,
                childRunId: child.runId }, run }], null);
        await internalChildren.syncRetention(conversation.value);
        if (conversation.value.state === 'closing') await finishClose(conversation.value.conversationId);
    }

    function endRun(conversation: ConversationData, run: RunData): void {
        const settled = run.cleanupState === 'released' || run.cleanupState === 'not_needed';
        if (settled) {
            if (conversation.activeRunId === run.runId) conversation.activeRunId = null;
            conversation.retention.activeRuns = 0;
            if (run.kind === 'task') retentionEnd(conversation, 'lastRunEnd');
            if (childAllocation(run) && conversation.retention.mode === 'ttl') {
                conversation.retention.activeRuns = 1;
                conversation.retention.expiresAt = null;
            }
        }
        run.nextCheckpointAt = null;
        run.activeRoundId = null;
        run.activeStepId = null;
    }

    async function recordCleanupFailure(conversationId: string, stage: 'resources' | 'artifacts' | 'contents', error: unknown): Promise<void> {
        const conversation = await getConversation(conversationId, undefined, true);
        if (conversation.value.state === 'closed') return;
        const source = error instanceof AgentFault ? error.toJSON() : { code: 'CONVERSATION_CLEANUP_FAILED',
            message: error instanceof Error ? error.message : '会话清理结果未确认', retryable: false, mayHaveStarted: true };
        conversation.value.state = 'closing';
        conversation.value.cleanupState = 'unconfirmed';
        conversation.value.cleanupError = { code: 'CLEANUP_UNCONFIRMED', message: '会话关闭清理尚未确认，原文仍保留',
            retryable: false, mayHaveStarted: true, details: { stage, sourceError: source } };
        pendingConversationClosures.add(conversationId);
        await commit(conversation, [], [{ type: 'conversation.cleanupUnconfirmed', payload: { stage, error: conversation.value.cleanupError } }], null);
    }

    async function finishClose(conversationId: string): Promise<boolean> {
        let conversation = await getConversation(conversationId, undefined, true);
        if (conversation.value.state === 'closed') { pendingConversationClosures.delete(conversationId); return true; }
        pendingConversationClosures.add(conversationId);
        let runs = await listAll<RunData>('run', conversationId);
        for (const parent of runs) for (const link of childLinks(parent.value)) {
            const child = await getConversation(link.childConversationId, undefined, true);
            if (child.value.state === 'closed') continue;
            const run = await getRun(link.childConversationId, link.childRunId);
            if (!isTerminal(run.value) && run.value.state !== 'outcome_unknown') await stopRun(child, run, 'cancelled', 'PARENT_CLOSED');
            const current = await getConversation(link.childConversationId, undefined, true);
            if (current.value.state === 'open') {
                current.value.state = 'closing';
                await commit(current, [], [{ type: 'conversation.closing', payload: { reason: 'PARENT_CLOSED' } }], null);
            }
            if (!await finishClose(link.childConversationId)) return false;
        }
        if (options.reconcileRunCleanup) {
            for (const record of runs) {
                const run = record.value;
                if (!isTerminal(run) || run.cleanupState !== 'unconfirmed' || run.effectState === 'unknown'
                    || executions.has(run.runId) || scheduled.has(run.runId)) continue;
                const interactions = await interactionsFor(run);
                if (interactions.some(item => ['pending', 'approved', 'executing', 'outcome_unknown'].includes(item.value.state))) continue;
                let evidence: CleanupEvidence = 'unconfirmed';
                try {
                    evidence = await options.reconcileRunCleanup({ snapshot: structuredClone(run),
                        conversationOptions: structuredClone(conversation.value.options) });
                } catch {
                    continue;
                }
                if (!['no_resources_created', 'resources_released'].includes(evidence)) continue;
                const current = await getRun(conversationId, run.runId);
                if (current.value.runEpoch !== run.runEpoch || current.value.cleanupState !== 'unconfirmed' || !isTerminal(current.value)) continue;
                const reconciled = { ...current.value, cleanupState: 'released' as const,
                    internalOwnCleanupState: 'released' as const, updatedAt: timestamp(now()) };
                endRun(conversation.value, reconciled);
                await commit(conversation, [{ ...current, revision: current.revision + 1, value: reconciled }],
                    [{ type: 'run.cleanup', payload: { cleanupState: 'released', evidence, source: 'close_retry' }, run: reconciled }], null);
                conversation = await getConversation(conversationId, undefined, true);
            }
            runs = await listAll<RunData>('run', conversationId);
        }
        const unsettled = runs.filter(record => !isTerminal(record.value) || !['released', 'not_needed'].includes(record.value.cleanupState));
        if (conversation.value.activeRunId || unsettled.length) {
            if (unsettled.some(record => record.value.state === 'outcome_unknown' || record.value.cleanupState === 'unconfirmed')) {
                await recordCleanupFailure(conversationId, 'resources', new AgentFault('CLEANUP_UNCONFIRMED', '原执行资源或受理事实仍待核实',
                    { runIds: unsettled.map(record => record.value.runId) }, true));
            }
            return false;
        }
        if (conversation.value.retention.mode === 'temporary') {
            if (!conversation.value.closeCleanupCompleted) {
                conversation.value.cleanupState = 'running';
                conversation.value.cleanupError = null;
                await commit(conversation, [], [{ type: 'conversation.cleanupStarted', payload: { stage: 'artifacts' } }], null);
                try { await options.onConversationClosed?.({ conversationId, retention: { mode: 'temporary' } }); }
                catch (error) { await recordCleanupFailure(conversationId, 'artifacts', error); return false; }
                conversation = await getConversation(conversationId, undefined, true);
                conversation.value.closeCleanupCompleted = true;
                await commit(conversation, [], [{ type: 'conversation.cleanupCompleted', payload: { stage: 'artifacts' } }], null);
                conversation = await getConversation(conversationId, undefined, true);
            }
            conversation.value.state = 'closed';
            conversation.value.cleanupState = 'released';
            conversation.value.cleanupError = null;
            conversation.value.options = {};
            const createExpiry = Date.parse(conversation.value.temporaryCreateCommandExpiresAt ?? '');
            conversation.value.temporaryMetadataExpiresAt = timestamp(Math.max(temporaryCreateCommands.observeTime(now()) + TEMPORARY_CLOSE_RECOVERY_MS,
                Number.isFinite(createExpiry) ? createExpiry : 0));
            const tombstone = { ...conversation, revision: conversation.revision + 1, value: conversation.value };
            try {
                await store.commitTransition({ expected: [{ key: conversation.key, revision: conversation.revision }], purgeConversationId: conversationId,
                    retainReceiptKeys: conversation.value.closeReceiptKeys ?? [], records: [tombstone] });
            } catch (error) { await recordCleanupFailure(conversationId, 'contents', error); return false; }
            for (const [subscriptionId, subscription] of subscriptions) if (subscription.conversationId === conversationId) subscriptions.delete(subscriptionId);
        } else {
            conversation.value.state = 'closed';
            conversation.value.cleanupState = 'released';
            conversation.value.cleanupError = null;
            await commit(conversation, [], [{ type: 'conversation.closed', payload: {} }], { closed: true });
        }
        pendingConversationClosures.delete(conversationId);
        return true;
    }

    function schedule(run: RunData): void {
        if (run.kind === 'maintenance' || workspaceStops.has(run.conversationId)) return;
        if (!executor || closed || run.state !== 'queued' || scheduled.has(run.runId) || executions.has(run.runId)) return;
        if (run.continuationInteractionId && !executor.capabilities?.toolApprovalContinuation) return;
        scheduled.add(run.runId);
        executionConversations.set(run.runId, run.conversationId);
        queueMicrotask(() => {
            scheduled.delete(run.runId);
            if (closed) { executionConversations.delete(run.runId); return; }
            const execution: ScheduledExecution = { runEpoch: run.runEpoch, enteredExecutor: false, preparationCleanupState: run.cleanupState };
            let mayRequeue = true;
            executions.start(run.runId, async signal => {
                try { await executeRun(run.conversationId, run.runId, signal, execution); }
                catch (error) {
                    mayRequeue = false;
                    await retryStoredRevision(() => serial.run(async () => {
                        if (closed) return;
                        const record = await getRun(run.conversationId, run.runId);
                        if (record.value.runEpoch !== execution.runEpoch) return;
                        if (!execution.enteredExecutor && (record.value.state === 'queued' || record.value.state === 'running')) {
                            const errorData: AgentError = error instanceof AgentFault ? error.toJSON()
                                : { code: 'PREPARATION_ERROR', message: error instanceof Error ? error.message : String(error),
                                    retryable: false, mayHaveStarted: false };
                            const unstarted = record.value.state === 'queued' && record.value.activeInputId === null
                                && record.value.activeRoundId === null && record.value.resultContentId === null
                                && !record.value.hasCommittedEffects && record.value.effectState === 'none'
                                && record.value.cleanupState === 'not_needed';
                            const released = record.value.cleanupState === 'released' || record.value.cleanupState === 'not_needed';
                            const conversation = await getConversation(run.conversationId, undefined, true);
                            const paused = transitionRun(record.value, 'paused', { phase: null, stopReason: errorData.code,
                                resumeRequired: true, updatedAt: timestamp(now()),
                                cleanupState: released ? record.value.cleanupState : 'unconfirmed',
                                failure: { error: errorData, acceptance: unstarted ? 'not_sent' : null,
                                    cleanupEvidence: unstarted ? 'no_resources_created' : released ? 'resources_released' : 'unconfirmed',
                                    actionId: null, attemptId: null } });
                            await commit(conversation, [{ ...record, revision: record.revision + 1, value: paused }],
                                [{ type: 'run.paused', payload: { reason: paused.stopReason, source: 'preparation', failure: paused.failure }, run: paused }], null);
                            return;
                        }
                        if (record.value.state !== 'running') return;
                        const conversation = await getConversation(run.conversationId, undefined, true);
                        const unknown = transitionRun(record.value, 'outcome_unknown', { phase: null, resultStatus: 'unknown',
                            effectState: 'unknown', cleanupState: 'unconfirmed', stopReason: 'EXECUTOR_RESULT_UNCOMMITTED' });
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: unknown }],
                            [{ type: 'run.outcome_unknown', payload: { reason: unknown.stopReason }, run: unknown }], null);
                    }));
                } finally {
                    await serial.run(async () => {
                        if (closed) return;
                        const record = await getRun(run.conversationId, run.runId);
                        if (record.value.state === 'stopping') await finalizeStop(run.conversationId, run.runId,
                            !execution.enteredExecutor && ['released', 'not_needed'].includes(execution.preparationCleanupState)
                                || childAllocation(record.value) && record.value.activeRoundId === null ? 'released' : 'unconfirmed');
                    });
                }
            }, () => {
                void serial.run(async () => {
                    executionConversations.delete(run.runId);
                    if (closed) return;
                    const latest = await getRun(run.conversationId, run.runId);
                    if (latest.value.state === 'queued' && (mayRequeue || latest.value.runEpoch !== execution.runEpoch)) schedule(latest.value);
                }).catch(() => undefined);
            });
        });
    }

    async function executorState(binding: ExecutorBinding): Promise<{ conversation: StoreRecord<ConversationData>; run: StoreRecord<RunData> }> {
        const run = await getRun(binding.conversationId, binding.runId);
        requireRunEpoch(run.value, binding.runEpoch);
        if (binding.signal.aborted || run.value.state !== 'running' || run.value.activeRoundId !== binding.roundId) {
            throw new AgentFault('INVALID_STATE', '该执行已停止或当前轮已变化，不能读取新发送视图或追加有效步骤');
        }
        const conversation = await getConversation(binding.conversationId);
        if (conversation.value.workspaceQuiesce) throw new AgentFault('WORKSPACE_BUSY', '恢复已冻结原执行的读取和写入');
        if (conversation.value.historyEpoch !== binding.historyEpoch) throw new AgentFault('CONTEXT_HISTORY_STALE', '执行依据的历史版本已经变化');
        return { conversation, run };
    }

    async function requestExecutorApproval(binding: ExecutorBinding, request: ExecutorApprovalRequest): Promise<InteractionData & { revision: number }> {
        if (!request.operationId || !request.stepId || !request.callId || !request.approval || !request.toolContext) {
            throw new AgentFault('INVALID_PARAMS', '批准待办需要原模型步骤、call及可信工具身份');
        }
        const operationId = valueHash(['approval', binding.runId, binding.runEpoch, request.operationId]);
        const hash = operationHash('executor.requestApproval', request as unknown as Record<string, unknown>);
        return serial.run(async () => {
            const key: ReceiptKey = { principalId: 'sandbox-agent-runtime', clientId: 'executor', conversationId: binding.conversationId, clientCommandId: operationId };
            const previousReceipt = await store.getReceipt(key);
            if (previousReceipt) {
                if (previousReceipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '批准保存操作ID已用于其他原调用');
                return previousReceipt.result.data as InteractionData & { revision: number };
            }
            if (!approvalLedger || !pendingTools) throw new AgentFault('CAPABILITY_REQUIRED', '须接入同一权威ApprovalLedger及原动作协调器，才能建立可答复批准待办');
            const { conversation, run: runRecord } = await executorState(binding);
            if (runRecord.value.continuationInteractionId) {
                const pending = await store.getRecord<InteractionData>(interactionKey(binding.conversationId, runRecord.value.continuationInteractionId));
                if (pending && pending.value.state !== 'completed') throw new AgentFault('INVALID_STATE', '先保存或完成当前原调用，再建立下一项批准');
            }
            const origin = await store.getRecord<StepData>({ conversationId: binding.conversationId, kind: 'step', id: request.stepId });
            const model = origin ? await store.readContent(binding.conversationId, origin.value.contentId) as unknown as
                { response?: NormalizedResponse; protocol?: ProviderProtocol } | undefined : undefined;
            const call = model?.response?.toolCalls.find(candidate => candidate.callId === request.callId);
            const ticket = request.approval;
            const context = request.toolContext;
            const argsHash = call ? valueHash({ name: call.name, args: call.arguments }) : '';
            const actionIndex = ticket.actionIds.indexOf(context.actionId);
            const sourceRunEpoch = binding.continuation?.interaction.stepId === request.stepId ? binding.continuation.interaction.sourceRunEpoch : binding.runEpoch;
            if (!origin || origin.value.runId !== binding.runId || origin.value.runEpoch !== sourceRunEpoch
                || origin.value.roundId !== binding.roundId || !origin.value.complete || !origin.value.canExecuteTools
                || origin.value.resolvedCallIds.includes(request.callId) || !call || !model?.response || !model.protocol
                || ticket.principalId !== conversation.value.principalId || ticket.conversationId !== binding.conversationId
                || ticket.runId !== binding.runId || ticket.runEpoch !== binding.runEpoch || ticket.policyRevision !== conversation.value.policyRevision
                || ticket.decision !== 'pending' || !Number.isFinite(Date.parse(ticket.expiresAt)) || actionIndex < 0 || ticket.argsHashes[actionIndex] !== argsHash
                || context.principalId !== ticket.principalId || context.conversationId !== binding.conversationId || context.runId !== binding.runId
                || context.rootRunId !== runRecord.value.rootRunId || context.runEpoch !== binding.runEpoch || context.roundId !== binding.roundId
                || context.stepId !== request.stepId || !matchesToolActionId(context.actionId, { runId: binding.runId, stepId: request.stepId,
                    attemptId: model.response.attemptId, callId: call.callId }) || context.callId !== undefined && context.callId !== call.callId
                || context.attemptId !== model.response.attemptId
                || context.policyRevision !== ticket.policyRevision) {
                throw new AgentFault('INTERACTION_STALE', '批准待办与原模型调用、参数或可信执行身份不一致');
            }
            if (!ticket.pendingToolId) throw new AgentFault('CAPABILITY_REQUIRED', '批准票据须先绑定Hooke保存的原工具动作');
            const interactionId = randomUUID();
            const contentId = randomUUID();
            const interaction: InteractionData = { interactionId, kind: 'approval', conversationId: binding.conversationId,
                principalId: conversation.value.principalId, targetClientId: runRecord.value.initiator?.clientId ?? '',
                runId: binding.runId, runEpoch: binding.runEpoch, sourceRunEpoch, historyEpoch: binding.historyEpoch,
                policyRevision: ticket.policyRevision, approvalId: ticket.approvalId, pendingToolId: ticket.pendingToolId,
                actionId: context.actionId, attemptId: context.attemptId,
                stepId: request.stepId, callId: call.callId, toolName: call.name, argsHash,
                actionHash: valueHash({ actionId: context.actionId, attemptId: context.attemptId, toolName: call.name, argsHash }),
                scopeHash: valueHash(ticket.scope), scope: structuredClone(ticket.scope), state: 'pending', modelContentId: origin.value.contentId,
                continuationContentId: contentId, createdAt: timestamp(now()), expiresAt: timestamp(Math.min(Date.parse(ticket.expiresAt),
                    Date.parse(runRecord.value.deadlineAt), now() + 15 * 60_000)), resolvedAt: null };
            const run: RunData = { ...runRecord.value, pendingInteractionIds: [...runRecord.value.pendingInteractionIds, interactionId],
                continuationInteractionId: interactionId, updatedAt: timestamp(now()) };
            const state: StoredToolContinuation = { protocol: model.protocol, toolContext: context, state: request.state };
            const command: CommandContext = { key, hash, client: { principalId: key.principalId, clientId: key.clientId }, params: {} };
            await commit(conversation, [{ ...runRecord, revision: runRecord.revision + 1, value: run },
                { key: interactionKey(binding.conversationId, interactionId), revision: 1, value: interaction }],
                [{ type: 'interaction.requested', payload: { interactionId, approvalId: ticket.approvalId, toolName: call.name,
                    expiresAt: interaction.expiresAt, scopeHash: interaction.scopeHash, actionHash: interaction.actionHash }, run }],
                { ...interaction, revision: 1 }, command, [{ conversationId: binding.conversationId, contentId,
                    kind: 'tool_approval_continuation', value: JSON.parse(canonicalJson(state)) as JsonValue, indexHistory: false }]);
            return { ...interaction, revision: 1 };
        });
    }

    async function respondInteraction(conversation: StoreRecord<ConversationData>, command: CommandContext): Promise<RpcResult> {
        const params = command.params;
        const record = await store.getRecord<InteractionData>(interactionKey(conversation.value.conversationId, String(params.interactionId)));
        if (!record || record.value.principalId !== command.client.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体的交互待办');
        const item = record.value;
        const runRecord = await getRun(item.conversationId, item.runId);
        if (params.expectedRunEpoch !== runRecord.value.runEpoch) throw new AgentFault('INTERACTION_STALE', '交互所属执行代次已经变化');
        if (Date.parse(item.expiresAt) <= now()) {
            await expireInteraction(record);
            throw new AgentFault('INTERACTION_STALE', '该批准待办已过期，原调用仍保留且未派发');
        }
        if (conversation.value.state !== 'open' || item.state !== 'pending' || params.expectedRevision !== record.revision
            || item.runEpoch !== runRecord.value.runEpoch || params.scopeHash !== item.scopeHash || params.actionHash !== item.actionHash
            || params.policyRevision !== item.policyRevision || conversation.value.policyRevision !== item.policyRevision
            || conversation.value.historyEpoch !== item.historyEpoch || (params.runId !== undefined && params.runId !== item.runId)
            || isTerminal(runRecord.value) || ['outcome_unknown', 'stopping'].includes(runRecord.value.state)) {
            throw new AgentFault('INTERACTION_STALE', '待办、原动作、执行代次或授权版本已经变化');
        }
        if (params.decision !== 'approve' && params.decision !== 'deny') throw new AgentFault('CAPABILITY_REQUIRED', '当前待办仅支持批准或拒绝原工具调用');
        if (!approvalLedger) throw new AgentFault('CAPABILITY_REQUIRED', '尚未接入权威ApprovalLedger，待办继续保留');
        await loadContinuation(record);
        try {
            await approvalLedger.respond({ approvalId: item.approvalId, principalId: command.client.principalId,
                conversationId: item.conversationId, runId: item.runId, policyRevision: item.policyRevision,
                decision: params.decision, clientId: command.client.clientId, clientCommandId: String(params.clientCommandId) });
        } catch (error) {
            if (error instanceof AgentFault && error.code === 'APPROVAL_STALE') throw new AgentFault('INTERACTION_STALE', error.message, { sourceError: error.toJSON() });
            throw error;
        }
        const approved = params.decision === 'approve';
        const resolved: StoreRecord<InteractionData> = { ...record, revision: record.revision + 1,
            value: { ...item, state: approved ? 'approved' : 'denied', decision: approved ? 'approve' : 'deny', resolvedAt: timestamp(now()) } };
        let run: RunData = { ...runRecord.value, updatedAt: timestamp(now()) };
        if (run.state === 'waiting' && !run.resumeRequired && ['released', 'not_needed'].includes(run.cleanupState)) {
            run = transitionRun(run, 'queued', { phase: 'admitting', stopReason: null, runEpoch: run.runEpoch + 1 });
            run.executorAvailable = Boolean(executor?.capabilities?.toolApprovalContinuation);
            if (!run.executorAvailable) run.stopReason = 'EXECUTOR_CONTINUATION_UNAVAILABLE';
            resolved.value.runEpoch = run.runEpoch;
            conversation.value.runEpoch = Math.max(conversation.value.runEpoch, run.runEpoch);
        }
        const result = await commit(conversation, [{ ...runRecord, revision: runRecord.revision + 1, value: run }, resolved],
            [{ type: 'interaction.responded', payload: { interactionId: item.interactionId, decision: params.decision, resumeRequired: Boolean(run.resumeRequired) }, run }],
            { interaction: { ...resolved.value, revision: resolved.revision }, runId: run.runId, runEpoch: run.runEpoch, state: run.state,
                resumeRequired: Boolean(run.resumeRequired), capability: { available: Boolean(executor?.capabilities?.toolApprovalContinuation),
                    reason: executor?.capabilities?.toolApprovalContinuation ? null : 'EXECUTOR_CONTINUATION_UNAVAILABLE' } }, command);
        if (run.state === 'queued') schedule(run);
        return result;
    }

    async function readExecutorHistory(binding: ExecutorBinding, query: ExecutorHistoryQuery = {}): Promise<HistoryPage> {
        return serial.run(async () => {
            const { conversation } = await executorState(binding);
            const page = await historyReader.readHistory({ ...query, conversationId: binding.conversationId, view: 'raw', effectiveOnly: true,
                expectedHistoryEpoch: binding.historyEpoch, ...(query.cursor ? {} : { throughSeq: conversation.value.appendSeq }) });
            for (const item of page.items) binding.readableContentIds.add(item.contentId);
            return page;
        });
    }

    function staleStepError(data: Record<string, unknown>): AgentFault {
        const source = data.staleError as AgentError | undefined;
        return new AgentFault(source?.code ?? 'INVALID_STATE', source?.message ?? '原执行已失效，迟到原件已保存且停止后续工具',
            { ...source?.details, disposition: 'late', contentId: data.contentId, stepId: data.stepId }, source?.mayHaveStarted ?? false);
    }

    async function preserveLateStep(binding: ExecutorBinding, step: ExecutorStepWrite, contentId: string,
        key: ReceiptKey, hash: string, stale: AgentFault): Promise<never> {
        const conversation = await getConversation(binding.conversationId, undefined, true);
        if (conversation.value.retention.mode === 'temporary' && conversation.value.state === 'closed') throw stale;
        const lateKey: StoreKey = { conversationId: binding.conversationId, kind: 'step', id: `late:${key.clientCommandId}` };
        const previous = await store.getRecord(lateKey);
        if (previous) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '迟到步骤已有原件索引但缺少对应操作回执');
        const sourceEpoch = step.kind === 'tool' && binding.continuation?.interaction.stepId === step.stepId
            ? binding.continuation.interaction.sourceRunEpoch : binding.runEpoch;
        const data = { contentId, stepId: step.stepId, appendSeq: conversation.value.appendSeq,
            disposition: 'late', staleError: stale.toJSON() };
        const value = JSON.parse(canonicalJson({ schemaVersion: 1, conversationId: binding.conversationId, runId: binding.runId,
            runEpoch: sourceEpoch, historyEpoch: binding.historyEpoch, roundId: binding.roundId, ...step })) as JsonValue;
        const record: StoreRecord = { key: lateKey, revision: 1, value: { kind: step.kind, runId: binding.runId,
            runEpoch: sourceEpoch, roundId: binding.roundId, stepId: step.stepId, actionId: step.actionId,
            attemptId: step.kind === 'model' ? step.response.attemptId : binding.attemptId, contentId,
            complete: step.kind !== 'model' || step.response.complete, canExecuteTools: false, effective: false,
            disposition: 'late', reason: stale.code, toolCalls: [], resolvedCallIds: [] } };
        const command: CommandContext = { key, hash, client: { principalId: key.principalId, clientId: key.clientId }, params: {} };
        const saved = await commit(conversation, [record], [{ type: 'executor.lateStepRecorded', payload: { contentId, stepId: step.stepId,
            sourceRunId: binding.runId, sourceRunEpoch: binding.runEpoch, sourceHistoryEpoch: binding.historyEpoch, reason: stale.code } }],
            data, command, [{ conversationId: binding.conversationId, contentId, kind: `late_${step.kind}_step`, value, indexHistory: false }]);
        throw staleStepError({ ...saved.data as Record<string, unknown>, staleError: stale.toJSON() });
    }

    async function recordExecutorStep(binding: ExecutorBinding, step: ExecutorStepWrite): Promise<ExecutorStepReceipt> {
        for (const identifier of [step.operationId, step.stepId, step.actionId]) {
            if (typeof identifier !== 'string' || identifier.length < 1 || identifier.length > 256) throw new AgentFault('INVALID_PARAMS', '步骤身份须为1至256字符');
        }
        if (!['model', 'tool', 'summary'].includes(step.kind)) throw new AgentFault('INVALID_PARAMS', '步骤类型无效');
        if (step.kind === 'model' && (!step.response?.raw || typeof step.response.raw.body !== 'string'
            || !Array.isArray(step.response.blocks) || !Array.isArray(step.response.toolCalls) || typeof step.response.complete !== 'boolean'
            || (step.response.canExecuteTools && !step.response.complete))) throw new AgentFault('INVALID_PARAMS', '模型步骤需要完整原生响应结构，部分响应不能执行工具');
        const operationId = createHash('sha256').update(canonicalJson([binding.runId, binding.runEpoch, step.operationId])).digest('hex');
        const hash = operationHash('executor.recordStep', step as unknown as Record<string, unknown>);
        step = structuredClone(step);
        const contentId = randomUUID();
        return retryStoredRevision(() => serial.run(async () => {
            const key: ReceiptKey = { principalId: 'sandbox-agent-runtime', clientId: 'executor', conversationId: binding.conversationId, clientCommandId: operationId };
            const existing = await store.getReceipt(key);
            if (existing) {
                if (existing.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '同一步骤操作ID已用于不同原生内容');
                if ((existing.result.data as Record<string, unknown>)?.disposition === 'late') throw staleStepError(existing.result.data as Record<string, unknown>);
                try { await executorState(binding); }
                catch (error) {
                    if (error instanceof AgentFault) throw staleStepError({ ...existing.result.data as Record<string, unknown>, staleError: error.toJSON() });
                    throw error;
                }
                return { ...existing.result.data as Omit<ExecutorStepReceipt, 'eventCursor'>, eventCursor: existing.result.eventCursor! };
            }
            let current: Awaited<ReturnType<typeof executorState>>;
            try { current = await executorState(binding); }
            catch (error) {
                if (error instanceof AgentFault && ['STALE_RUN_EPOCH', 'INVALID_STATE', 'CONTEXT_HISTORY_STALE', 'NOT_FOUND'].includes(error.code)) {
                    return preserveLateStep(binding, step, contentId, key, hash, error);
                }
                throw error;
            }
            const { conversation, run: runRecord } = current;
            if (step.kind === 'model' && runRecord.value.continuationInteractionId) {
                throw new AgentFault('CONTINUATION_REQUIRED', '先保存已批准原call的实际结果，再派发下一模型步骤');
            }
            binding.actionId = step.actionId;
            if (step.kind === 'model') binding.attemptId = step.response.attemptId;
            if (step.kind === 'tool') binding.resourceActivity = true;
            const records: StoreRecord[] = [];
            const stepKey: StoreKey = { conversationId: binding.conversationId, kind: 'step', id: step.stepId };
            const previous = await store.getRecord<StepData>(stepKey);
            let attemptId: string | null = null;
            let effective = false;
            let pairedResponse: StepData | undefined;
            if (step.kind === 'model') {
                if (previous && (previous.value.runId !== binding.runId || previous.value.runEpoch !== binding.runEpoch || previous.value.complete)) {
                    throw new AgentFault('REVISION_CONFLICT', '模型步骤已完成或属于其他执行');
                }
                attemptId = step.response.attemptId;
                effective = step.response.complete;
                records.push({ key: stepKey, revision: (previous?.revision ?? 0) + 1, value: { kind: 'model', runId: binding.runId,
                    runEpoch: binding.runEpoch, roundId: binding.roundId, stepId: step.stepId, actionId: step.actionId, attemptId,
                    contentId, complete: step.response.complete, canExecuteTools: step.response.canExecuteTools,
                    toolCalls: step.response.toolCalls.map(call => ({ callId: call.callId, name: call.name })), resolvedCallIds: [] } });
            } else if (step.kind === 'tool') {
                if (step.stepId !== step.originStepId) throw new AgentFault('CONTEXT_NATIVE_PAIRING', '工具结果沿用原模型stepId');
                const origin = previous?.value;
                const resumed = binding.continuation?.interaction;
                const originalEpoch = resumed?.stepId === step.stepId ? resumed.sourceRunEpoch : binding.runEpoch;
                if (!origin || origin.kind !== 'model' || origin.runId !== binding.runId || origin.runEpoch !== originalEpoch
                    || origin.roundId !== binding.roundId || !origin.complete || !origin.canExecuteTools
                    || !origin.toolCalls.some(call => call.callId === step.result.callId && call.name === step.result.name)) {
                    throw new AgentFault('CONTEXT_NATIVE_PAIRING', '工具结果缺少已完整提交的原调用');
                }
                if (origin.resolvedCallIds.includes(step.result.callId)) throw new AgentFault('COMMAND_CONFLICT', '该工具调用已经保存结果');
                attemptId = origin.attemptId;
                effective = true;
                pairedResponse = { ...origin, resolvedCallIds: [...origin.resolvedCallIds, step.result.callId] };
                records.push({ ...previous!, revision: previous!.revision + 1, value: pairedResponse });
            } else {
                if (step.source.historyEpoch !== binding.historyEpoch || !Number.isSafeInteger(step.source.firstSeq) || step.source.firstSeq < 1
                    || !Number.isSafeInteger(step.source.lastSeq) || step.source.lastSeq < step.source.firstSeq
                    || step.source.lastSeq > conversation.value.appendSeq) throw new AgentFault('CONTEXT_SOURCE_GAP', '摘要来源范围无效');
                if (previous) throw new AgentFault('REVISION_CONFLICT', '摘要步骤已经存在');
                records.push({ key: stepKey, revision: 1, value: { kind: 'summary', runId: binding.runId, runEpoch: binding.runEpoch,
                    roundId: binding.roundId, stepId: step.stepId, actionId: step.actionId, attemptId: null, contentId,
                    complete: true, canExecuteTools: false, toolCalls: [], resolvedCallIds: [] } });
            }
            conversation.value.appendSeq++;
            const run: RunData = { ...runRecord.value, ...(step.kind !== 'summary' ? { activeStepId: step.stepId,
                hasCommittedEffects: true, effectState: runRecord.value.effectState === 'unknown' ? 'unknown' : 'confirmed',
                ...(effective ? { lastSuccessfulActionId: step.actionId, lastSuccessfulAttemptId: attemptId } : {}) } : {}), updatedAt: timestamp(now()) };
            rememberChildChange(run, step);
            if (step.kind === 'tool' && binding.continuation?.interaction.stepId === step.stepId) {
                const interaction = await store.getRecord<InteractionData>(interactionKey(binding.conversationId, binding.continuation.interaction.interactionId));
                if (!interaction || !['executing', 'completed'].includes(interaction.value.state) || interaction.value.runEpoch !== binding.runEpoch
                    || (interaction.value.callId === step.result.callId && step.actionId !== interaction.value.actionId)) {
                    throw new AgentFault('INTERACTION_STALE', '原批准调用的执行身份已变化');
                }
                if (interaction.value.callId === step.result.callId && interaction.value.state === 'executing') {
                    records.push({ ...interaction, revision: interaction.revision + 1, value: { ...interaction.value, state: 'completed', resolvedAt: timestamp(now()) } });
                    run.pendingInteractionIds = run.pendingInteractionIds.filter(id => id !== interaction.value.interactionId);
                }
                if (pairedResponse?.toolCalls.every(call => pairedResponse!.resolvedCallIds.includes(call.callId))) run.continuationInteractionId = null;
            }
            records.push({ ...runRecord, revision: runRecord.revision + 1, value: run });
            const historyRunEpoch = step.kind === 'tool' && binding.continuation?.interaction.stepId === step.stepId
                ? binding.continuation.interaction.sourceRunEpoch : binding.runEpoch;
            const value = JSON.parse(canonicalJson({ schemaVersion: 1, conversationId: binding.conversationId, runId: binding.runId,
                runEpoch: historyRunEpoch, roundId: binding.roundId, ...step })) as JsonValue;
            const content: ContentWrite = { conversationId: binding.conversationId, contentId, kind: step.kind === 'summary' ? 'summary' : `${step.kind}_step`, value,
                indexHistory: true, history: { view: step.kind === 'summary' ? 'summary' : 'raw', effective,
                    role: step.kind === 'model' ? 'assistant' : step.kind === 'tool' ? 'tool' : 'system', roundId: binding.roundId,
                    stepId: step.stepId, runId: binding.runId, runEpoch: historyRunEpoch, actionId: step.actionId, attemptId,
                    ...(step.kind !== 'summary' ? { providerProtocol: step.protocol } : {}), ...(step.kind === 'tool' ? { callId: step.result.callId } : {}) } };
            const command: CommandContext = { key, hash, client: { principalId: key.principalId, clientId: key.clientId }, params: {} };
            const result = await commit(conversation, records, [{ type: 'executor.stepRecorded', payload: { kind: step.kind, contentId, stepId: step.stepId, effective }, run }],
                { contentId, stepId: step.stepId, appendSeq: conversation.value.appendSeq }, command, [content]);
            return { ...result.data as Omit<ExecutorStepReceipt, 'eventCursor'>, eventCursor: result.eventCursor! };
        }));
    }

    async function executeRun(conversationId: string, runId: string, signal: AbortSignal, execution: ScheduledExecution): Promise<void> {
        while (!signal.aborted && !closed) {
            execution.enteredExecutor = false;
            const prepared = await retryStoredRevision(() => serial.run(async () => {
                const record = await getRun(conversationId, runId);
                if (record.value.runEpoch !== execution.runEpoch) return null;
                if (record.value.state !== 'queued' && record.value.state !== 'running') return null;
                execution.preparationCleanupState = record.value.cleanupState;
                const conversation = await getConversation(conversationId);
                if (conversation.value.state !== 'open' || conversation.value.workspaceQuiesce) return null;
                if (deadlineReached(record.value)) {
                    await stopRun(conversation, record, 'cancelled', 'BUDGET_EXCEEDED');
                    return null;
                }
                if (!executor || (record.value.budget.costMode === 'hard' && !executor.capabilities?.hardBudget)) return null;
                let continuation: ExecutorToolContinuation | null = null;
                let continuationRecord: StoreRecord<InteractionData> | undefined;
                if (record.value.continuationInteractionId) {
                    const interaction = await store.getRecord<InteractionData>(interactionKey(conversationId, record.value.continuationInteractionId));
                    if (!interaction) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原批准继续位置缺失');
                    if (['pending', 'approved', 'denied'].includes(interaction.value.state) && Date.parse(interaction.value.expiresAt) <= now()) {
                        await expireInteraction(interaction);
                        return null;
                    }
                    if (!['approved', 'denied'].includes(interaction.value.state) || !executor.capabilities?.toolApprovalContinuation) return null;
                    if (interaction.value.historyEpoch !== conversation.value.historyEpoch || interaction.value.policyRevision !== conversation.value.policyRevision) {
                        throw new AgentFault('INTERACTION_STALE', '原批准依据的历史或授权版本已变化');
                    }
                    continuationRecord = { ...interaction, revision: interaction.revision + 1,
                        value: { ...interaction.value, state: 'executing', runEpoch: record.value.runEpoch } };
                    continuation = await loadContinuation(continuationRecord);
                }
                const inputs = await inputsFor(record.value);
                const active = record.value.activeInputId ? inputs.find(input => input.value.inputId === record.value.activeInputId) : undefined;
                const selected = active ?? inputs.find(input => input.value.mode === 'queue' && input.value.state === 'queued');
                if (!selected) return null;
                const run = transitionRun(record.value, 'running', { phase: 'preparing', executorAvailable: true,
                    activeInputId: selected.value.inputId, activeRoundId: continuation?.toolContext.roundId ?? record.value.activeRoundId ?? randomUUID(),
                    activeStepId: continuation?.interaction.stepId ?? randomUUID(), cleanupState: 'pending', resumeRequired: false, updatedAt: timestamp(now()) });
                const content = await store.readContent(conversationId, selected.value.contentId);
                if (content === undefined) throw new AgentFault('STORAGE_UNAVAILABLE', '输入正文对象缺失');
                const firstConsumption = selected.value.state !== 'consumed';
                const consumed = firstConsumption ? [{ ...selected, revision: selected.revision + 1,
                    value: { ...selected.value, state: 'consumed' as const, roundId: run.activeRoundId, consumedAtStepId: run.activeStepId } }] : [];
                const contents: ContentWrite[] = firstConsumption ? [{ conversationId, contentId: selected.value.contentId, kind: 'user_input', value: content,
                    indexHistory: true, history: { view: 'raw', effective: true, role: 'user', roundId: run.activeRoundId,
                        stepId: run.activeStepId, runId, runEpoch: run.runEpoch } }] : [];
                if (firstConsumption) { run.queueRevision++; conversation.value.appendSeq++; }
                await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }, ...consumed,
                    ...(continuationRecord ? [continuationRecord] : [])],
                    [{ type: 'run.running', payload: { inputId: selected.value.inputId, roundId: run.activeRoundId }, run }], { ...run }, undefined, contents);
                return { run: structuredClone(run), content, historyEpoch: conversation.value.historyEpoch,
                    options: structuredClone({ ...conversation.value.options, ...(run.options as Record<string, unknown> ?? {}) }), executor, continuation };
            }));
            if (!prepared) break;
            const binding: ExecutorBinding = { conversationId, runId, runEpoch: prepared.run.runEpoch, roundId: prepared.run.activeRoundId!,
                historyEpoch: prepared.historyEpoch, signal, readableContentIds: new Set(), resourceActivity: false,
                actionId: prepared.continuation?.interaction.actionId ?? null, attemptId: prepared.continuation?.interaction.attemptId ?? null,
                continuation: prepared.continuation };
            let outcome: ExecutorOutcome;
            try {
                execution.enteredExecutor = true;
                outcome = await prepared.executor.execute({ snapshot: prepared.run, content: prepared.content,
                    conversationOptions: prepared.options, signal, continuation: prepared.continuation,
                    requestApproval: request => requestExecutorApproval(binding, request),
                    readHistory: query => readExecutorHistory(binding, query),
                    readContent: contentId => serial.run(async () => {
                        await executorState(binding);
                        if (!binding.readableContentIds.has(contentId)) throw new AgentFault('NOT_FOUND', '只能展开本执行已读取的有效历史项');
                        const value = await store.readContent(conversationId, contentId);
                        if (value === undefined) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '历史正文对象缺失');
                        return value;
                    }),
                    recordStep: step => recordExecutorStep(binding, step),
                    assertCurrent: () => serial.run(async () => { await executorState(binding); }),
                    checkpoint: (phase, payload = {}) => retryStoredRevision(() => serial.run(async () => {
                        const record = await getRun(conversationId, runId);
                        requireRunEpoch(record.value, prepared.run.runEpoch);
                        if (record.value.state !== 'running' || signal.aborted) throw new AgentFault('INVALID_STATE', '执行已经停止');
                        if (record.value.continuationInteractionId && (phase === 'awaiting_response' || phase === 'uploading')) {
                            throw new AgentFault('CONTINUATION_REQUIRED', '先完成原工具调用，再准备下一次模型发送');
                        }
                        const phases: RunPhase[] = [null, 'admitting', 'preparing', 'uploading', 'awaiting_response', 'streaming', 'executing_tools', 'retry_backoff'];
                        if (!phases.includes(phase)) throw new AgentFault('INVALID_PARAMS', '执行阶段无效');
                        if (phase === 'uploading' || phase === 'executing_tools') binding.resourceActivity = true;
                        if (Object.hasOwn(payload, 'actionId')) binding.actionId = typeof payload.actionId === 'string' && payload.actionId ? payload.actionId : null;
                        if (Object.hasOwn(payload, 'attemptId')) binding.attemptId = typeof payload.attemptId === 'string' && payload.attemptId ? payload.attemptId : null;
                        const conversation = await getConversation(conversationId);
                        const run = { ...record.value, phase, updatedAt: timestamp(now()) };
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }],
                            [{ type: 'run.progress', payload: { ...payload, phase }, run }], null);
                    })),
                    takeSteering: () => retryStoredRevision(() => serial.run(async () => {
                        const record = await getRun(conversationId, runId);
                        requireRunEpoch(record.value, prepared.run.runEpoch);
                        if (record.value.state !== 'running' || signal.aborted) throw new AgentFault('INVALID_STATE', '执行已经停止');
                        const inputs = (await inputsFor(record.value)).filter(input => input.value.mode === 'steer' && input.value.state === 'queued'
                            && input.value.targetRoundId === record.value.activeRoundId);
                        const content: JsonValue[] = [];
                        for (const input of inputs) {
                            const value = await store.readContent(conversationId, input.value.contentId);
                            if (value === undefined) throw new AgentFault('STORAGE_UNAVAILABLE', '补充输入正文缺失');
                            content.push(value);
                        }
                        if (!inputs.length) return content;
                        const conversation = await getConversation(conversationId);
                        const run = { ...record.value, queueRevision: record.value.queueRevision + 1 };
                        const consumed: StoreRecord<InputData>[] = [];
                        const contents: ContentWrite[] = [];
                        for (let index = 0; index < inputs.length; index++) {
                            const input = inputs[index];
                            const stepId = randomUUID();
                            consumed.push({ ...input, revision: input.revision + 1, value: { ...input.value, state: 'consumed',
                                roundId: run.activeRoundId, consumedAtStepId: stepId } });
                            contents.push({ conversationId, contentId: input.value.contentId, kind: 'user_input', value: content[index],
                                indexHistory: true, history: { view: 'raw', effective: true, role: 'user', roundId: run.activeRoundId,
                                    stepId, runId, runEpoch: run.runEpoch } });
                            run.activeStepId = stepId;
                            conversation.value.appendSeq++;
                        }
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }, ...consumed],
                            [{ type: 'inputs.consumed', payload: { inputIds: inputs.map(input => input.value.inputId) }, run }], null, undefined, contents);
                        return content;
                    })) });
            } catch (error) {
                const wrapped = error instanceof ExecutorFailure ? error : undefined;
                const original = wrapped?.originalError ?? error;
                const providerAcceptance = original instanceof ProviderFault ? original.acceptance : null;
                const reportedAcceptance = wrapped?.facts.acceptance ?? null;
                const acceptance: Acceptance | null = providerAcceptance === 'unknown' || reportedAcceptance === 'unknown' ? 'unknown'
                    : providerAcceptance === 'accepted' || reportedAcceptance === 'accepted' ? 'accepted' : providerAcceptance ?? reportedAcceptance;
                const cleanupEvidence: CleanupEvidence = wrapped?.facts.cleanupEvidence
                    ?? (original instanceof ProviderFault && acceptance !== null && ['not_sent', 'rejected'].includes(acceptance)
                        && !binding.resourceActivity ? 'no_resources_created' : 'unconfirmed');
                const definitelyUnsent = original instanceof AgentFault && !original.mayHaveStarted
                    && (acceptance === 'not_sent' || acceptance === 'rejected');
                const cleaned = cleanupEvidence === 'no_resources_created' || cleanupEvidence === 'resources_released';
                const errorData: AgentError = original instanceof AgentFault ? original.toJSON()
                    : { code: 'EXECUTOR_ERROR', message: original instanceof Error ? original.message : '执行器出现未分类错误',
                        retryable: false, mayHaveStarted: true };
                const actionId = wrapped && Object.hasOwn(wrapped.facts, 'actionId') ? wrapped.facts.actionId ?? null
                    : (typeof errorData.actionId === 'string' ? errorData.actionId : null)
                        ?? (typeof errorData.details?.actionId === 'string' ? errorData.details.actionId : null) ?? (wrapped || definitelyUnsent ? null : binding.actionId);
                const attemptId = wrapped && Object.hasOwn(wrapped.facts, 'attemptId') ? wrapped.facts.attemptId ?? null
                    : (typeof errorData.attemptId === 'string' ? errorData.attemptId : null)
                        ?? (typeof errorData.details?.attemptId === 'string' ? errorData.details.attemptId : null) ?? (wrapped || definitelyUnsent ? null : binding.attemptId);
                const detail: ExecutorFailureDetails = { error: { ...errorData, actionId: actionId ?? undefined, attemptId: attemptId ?? undefined },
                    acceptance, cleanupEvidence, actionId, attemptId };
                outcome = { status: definitelyUnsent && cleaned ? 'failed' : signal.aborted ? 'paused' : 'outcome_unknown', stopReason: errorData.code,
                    ...(definitelyUnsent ? {} : { effectState: 'unknown' as const }),
                    cleanupState: cleaned ? (cleanupEvidence === 'no_resources_created' ? 'not_needed' : 'released') : 'unconfirmed', failure: detail };
            }
            const reportedOutcome = outcome;
            const resultContentId = randomUUID();
            const again = await retryStoredRevision(() => serial.run(async () => {
                let outcome = structuredClone(reportedOutcome);
                if (closed) return false;
                let record = await getRun(conversationId, runId);
                if (record.value.runEpoch !== prepared.run.runEpoch || record.value.state === 'stopping') {
                    const stoppedEpoch = record.value.runEpoch === prepared.run.runEpoch + 1
                        && ['stopping', 'cancelled', 'paused'].includes(record.value.state)
                        && ['cancelled', 'paused'].includes(String(record.value.stopTarget));
                    if ((childAllocation(record.value) || stoppedEpoch) && (outcome.effectState === 'unknown' || outcome.status === 'outcome_unknown')
                        && (record.value.effectState !== 'unknown' || record.value.resultStatus !== 'unknown' || outcome.failure && !record.value.failure)) {
                        const conversation = await getConversation(conversationId, undefined, true);
                        const facts = { ...record.value, effectState: 'unknown' as const, resultStatus: 'unknown' as const,
                            failure: outcome.failure ?? record.value.failure };
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: facts }],
                            [{ type: childAllocation(record.value) ? 'run.childLateFacts' : 'run.lateFacts', payload: { sourceRunEpoch: prepared.run.runEpoch,
                                effectState: 'unknown' }, run: facts }], null);
                        await reconcileInternalParent(facts);
                        record = await getRun(conversationId, runId);
                    }
                    if (stoppedEpoch && record.value.state === 'stopping') await finalizeStop(conversationId, runId, outcome.cleanupState === 'released' || outcome.cleanupState === 'not_needed' ? 'released' : 'unconfirmed');
                    else if (stoppedEpoch && record.value.cleanupState === 'unconfirmed' && (outcome.cleanupState === 'released' || outcome.cleanupState === 'not_needed')) {
                        const conversation = await getConversation(conversationId, undefined, true);
                        const reconciled = { ...record.value, cleanupState: 'released' as const };
                        if (isTerminal(reconciled)) endRun(conversation.value, reconciled);
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: reconciled }],
                            [{ type: 'run.cleanup', payload: { cleanupState: 'released', sourceRunEpoch: prepared.run.runEpoch }, run: reconciled }], null);
                        if (conversation.value.state === 'closing' && !conversation.value.activeRunId) await finishClose(conversationId);
                    }
                    return false;
                }
                if (record.value.state !== 'running') return false;
                if (!['succeeded', 'failed', 'paused', 'outcome_unknown'].includes(outcome.status)) throw new AgentFault('INVALID_STATE', '执行器返回了未知终态');
                const conversation = await getConversation(conversationId);
                const inputs = await inputsFor(record.value);
                const pending = inputs.some(input => input.value.mode === 'queue' && input.value.state === 'queued');
                const ownCleanupState = outcome.cleanupState === 'released' || outcome.cleanupState === 'not_needed' ? 'released' : 'unconfirmed';
                if (!pending && childLinks(record.value).length && outcome.status !== 'paused') {
                    await internalChildren.stopOwnedChildren(record.value, 'PARENT_FINISHED');
                    if (!await internalChildren.released(record.value)) outcome.cleanupState = 'unconfirmed';
                }
                const interaction = record.value.continuationInteractionId ? await store.getRecord<InteractionData>(
                    interactionKey(conversationId, record.value.continuationInteractionId)) : undefined;
                const interactionRecords: StoreRecord<InteractionData>[] = [];
                let interactionState: RunData['state'] | undefined;
                if (interaction) {
                    const state = interaction.value.state;
                    if (state === 'executing' || state === 'completed') {
                        outcome = { ...outcome, status: 'outcome_unknown', stopReason: state === 'executing' ? 'APPROVED_ACTION_RESULT_UNCONFIRMED'
                            : 'ORIGINAL_TOOL_BATCH_UNCONFIRMED', effectState: 'unknown' };
                        interactionRecords.push({ ...interaction, revision: interaction.revision + 1,
                            value: { ...interaction.value, state: 'outcome_unknown', resolvedAt: timestamp(now()) } });
                    } else if (['pending', 'approved', 'denied'].includes(state)) {
                        if (!['released', 'not_needed'].includes(outcome.cleanupState)) {
                            outcome = { ...outcome, status: 'outcome_unknown', stopReason: 'APPROVAL_CLEANUP_UNCONFIRMED', effectState: 'unknown' };
                        } else {
                            outcome = { ...outcome, status: 'paused', stopReason: state === 'pending' ? 'APPROVAL_REQUIRED'
                                : record.value.resumeRequired ? 'RESTART_RESUME_REQUIRED' : executor?.capabilities?.toolApprovalContinuation
                                    ? undefined : 'EXECUTOR_CONTINUATION_UNAVAILABLE' };
                            interactionState = state === 'pending' ? 'waiting' : record.value.resumeRequired || !executor?.capabilities?.toolApprovalContinuation ? 'paused' : 'queued';
                        }
                    } else if (['expired', 'cancelled'].includes(state)) {
                        outcome = { ...outcome, status: 'paused', stopReason: state === 'expired' ? 'INTERACTION_EXPIRED' : 'INTERACTION_CANCELLED' };
                    }
                }
                const nextState = interactionState ?? (outcome.status === 'succeeded' && pending ? 'running' : outcome.status);
                const run = transitionRun(record.value, nextState, { phase: nextState === 'running' ? 'preparing' : nextState === 'queued' ? 'admitting' : null,
                    internalOwnCleanupState: ownCleanupState,
                    resultStatus: outcome.status === 'succeeded' ? (pending ? null : 'success') : outcome.status === 'failed' ? 'failed'
                        : outcome.status === 'outcome_unknown' ? 'unknown' : null,
                    stopReason: outcome.stopReason ?? null, effectState: record.value.effectState === 'unknown' || outcome.effectState === 'unknown' ? 'unknown'
                        : record.value.effectState === 'confirmed' || outcome.effectState === 'confirmed' ? 'confirmed' : 'none',
                    cleanupState: outcome.cleanupState ?? 'unconfirmed', activeInputId: outcome.status === 'succeeded' ? null : record.value.activeInputId,
                    failure: outcome.failure ?? record.value.failure,
                    activeRoundId: outcome.status === 'succeeded' ? null : record.value.activeRoundId,
                    updatedAt: timestamp(now()) });
                if (interactionState === 'queued' && interaction) {
                    run.runEpoch++;
                    conversation.value.runEpoch = Math.max(conversation.value.runEpoch, run.runEpoch);
                    interactionRecords.push({ ...interaction, revision: interaction.revision + 1,
                        value: { ...interaction.value, runEpoch: run.runEpoch } });
                }
                const contents: ContentWrite[] = [];
                if (outcome.result !== undefined) {
                    run.resultContentId = resultContentId;
                    contents.push({ conversationId, contentId: run.resultContentId, kind: 'executor_result', value: outcome.result, indexHistory: false });
                }
                if (isTerminal(run)) endRun(conversation.value, run);
                const staleSteering = interaction && !isTerminal(run) ? [] : inputs.filter(input => input.value.mode === 'steer' && input.value.state === 'queued');
                await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }, ...interactionRecords, ...staleSteering.map(input => ({ ...input,
                    revision: input.revision + 1, value: { ...input.value, state: 'withdrawn' as const } }))],
                    [{ type: pending && outcome.status === 'succeeded' ? 'round.completed' : `run.${run.state}`,
                        payload: { resultContentId: run.resultContentId, cleanupState: run.cleanupState, failure: run.failure,
                            unconsumedSteeringIds: staleSteering.map(input => input.value.inputId) }, run }], { ...run }, undefined, contents);
                await reconcileInternalParent(run);
                await internalChildren.syncRetention(conversation.value);
                execution.preparationCleanupState = run.cleanupState;
                return nextState === 'running';
            }));
            if (!again) break;
        }
    }

    async function clearPurgedConversationCaches(conversationId: string): Promise<boolean> {
        const runIds = new Set([...liveRuns.values()].filter(run => run.conversationId === conversationId).map(run => run.runId));
        for (const [runId, owner] of executionConversations) if (owner === conversationId) runIds.add(runId);
        for (const [runId, lease] of maintenanceLeases) if (lease.execution.conversationId === conversationId) runIds.add(runId);
        const hasResources = () => workspaceStops.has(conversationId) || [...runIds].some(runId => executions.has(runId)
            || scheduled.has(runId) || executionConversations.has(runId) || cleanupTimers.has(runId)
            || maintenanceLeases.has(runId) || maintenanceCleanups.has(runId));
        if (hasResources()) return false;
        if (await store.getRecord(conversationKey(conversationId))) {
            pendingRetentionSweeps.delete(conversationId);
            return false;
        }
        if (hasResources()) return false;
        for (const runId of runIds) {
            liveRuns.delete(runId);
            monotonicDeadlines.delete(runId);
        }
        for (const [interactionId, interaction] of liveInteractions) if (interaction.conversationId === conversationId) liveInteractions.delete(interactionId);
        for (const [subscriptionId, subscription] of subscriptions) if (subscription.conversationId === conversationId) subscriptions.delete(subscriptionId);
        for (const [wake, waiter] of eventWaiters) if (waiter.conversationId === conversationId) {
            wake();
            waiter.release();
            eventWaiters.delete(wake);
        }
        pendingConversationClosures.delete(conversationId);
        pendingRetentionSweeps.delete(conversationId);
        armTimer();
        return true;
    }

    async function applyRetentionSweep(result: Pick<RetentionSweepResult, 'conversations'>): Promise<{
        clearedConversationIds: string[]; deferredConversationIds: string[];
    }> {
        await ready;
        return serial.run(async () => {
            const candidates = new Set(pendingRetentionSweeps);
            for (const conversation of result.conversations) {
                if (!(conversation.state === 'deleted' || conversation.state === 'deferred' && conversation.reason === 'family_page_pending') || !conversation.expiresAt
                    || !Number.isFinite(Date.parse(conversation.expiresAt)) || Date.parse(conversation.expiresAt) > now()) continue;
                for (const conversationId of conversation.conversationIds) candidates.add(conversationId);
            }
            const clearedConversationIds: string[] = [];
            const deferredConversationIds: string[] = [];
            if (closed) return { clearedConversationIds, deferredConversationIds: [...candidates] };
            for (const conversationId of candidates) {
                pendingRetentionSweeps.add(conversationId);
                if (await clearPurgedConversationCaches(conversationId)) clearedConversationIds.push(conversationId);
                else deferredConversationIds.push(conversationId);
            }
            return { clearedConversationIds, deferredConversationIds };
        });
    }

    async function collectTemporaryMetadata(): Promise<void> {
        if (!store.collectTemporaryMetadata || closed) return;
        const result = await store.collectTemporaryMetadata({ now: temporaryCreateCommands.observeTime(now()), canCollect: async conversationId => {
            if (workspaceStops.has(conversationId) || pendingConversationClosures.has(conversationId)) return false;
            if ([...liveRuns.values()].some(run => run.conversationId === conversationId)) return false;
            if ([...liveInteractions.values()].some(interaction => interaction.conversationId === conversationId
                && (interaction.state === 'outcome_unknown' || interaction.state === 'executing'
                    || Date.parse(interaction.expiresAt) > now()))) return false;
            if ([...executionConversations.values()].includes(conversationId)
                || [...maintenanceLeases.values()].some(lease => lease.execution.conversationId === conversationId)) return false;
            return true;
        } });
        temporaryMetadataContinuation = result.hasMore;
        for (const conversationId of result.collectedConversationIds) await clearPurgedConversationCaches(conversationId);
        if (result.hasMore && temporaryMetadataTimer) armTemporaryMetadataTimer();
    }

    function armTemporaryMetadataTimer(): void {
        if (temporaryMetadataTimer) clearTimeout(temporaryMetadataTimer);
        temporaryMetadataTimer = undefined;
        if (closed || !store.collectTemporaryMetadata) return;
        temporaryMetadataTimer = setTimeout(() => {
            temporaryMetadataTimer = undefined;
            void serial.run(collectTemporaryMetadata).catch(() => { temporaryMetadataContinuation = false; }).finally(armTemporaryMetadataTimer);
        }, temporaryMetadataContinuation ? 1 : TEMPORARY_METADATA_SWEEP_MS);
        temporaryMetadataTimer.unref();
    }

    function armTimer(): void {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (closed || (!liveRuns.size && !liveInteractions.size)) return;
        const deadlines = [...liveRuns.values()].filter(run => !isTerminal(run) && run.state !== 'outcome_unknown' && run.state !== 'stopping')
            .flatMap(run => [Date.parse(run.deadlineAt), now() + Math.max(0, (monotonicDeadlines.get(run.runId) ?? Infinity) - performance.now()),
                ...(run.nextCheckpointAt ? [Date.parse(run.nextCheckpointAt)] : [])]);
        deadlines.push(...[...liveInteractions.values()].map(interaction => Date.parse(interaction.expiresAt)));
        if (!deadlines.length) return;
        const delay = Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - now()));
        timer = setTimeout(() => { timer = undefined; void serial.run(tick).catch(() => undefined); }, delay);
        timer.unref();
    }

    function deadlineReached(run: RunData): boolean {
        return Date.parse(run.deadlineAt) <= now() || (monotonicDeadlines.get(run.runId) ?? Infinity) <= performance.now();
    }

    async function tick(): Promise<void> {
        for (const conversationId of pendingRetentionSweeps) await clearPurgedConversationCaches(conversationId);
        for (const interaction of [...liveInteractions.values()]) if (Date.parse(interaction.expiresAt) <= now()) {
            const record = await store.getRecord<InteractionData>(interactionKey(interaction.conversationId, interaction.interactionId));
            if (record) await expireInteraction(record);
        }
        for (const stale of [...liveRuns.values()]) {
            if (isTerminal(stale) || stale.state === 'outcome_unknown' || stale.state === 'stopping') continue;
            const record = await getRun(stale.conversationId, stale.runId);
            const conversation = await getConversation(stale.conversationId, undefined, true);
            if (deadlineReached(record.value)) await stopRun(conversation, record, 'cancelled', 'BUDGET_EXCEEDED');
            else if (record.value.nextCheckpointAt && Date.parse(record.value.nextCheckpointAt) <= now()) {
                const run = { ...record.value, nextCheckpointAt: timestamp(now() + 15 * 60_000) };
                await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }],
                    [{ type: 'checkpoint.due', payload: { nextCheckpointAt: run.nextCheckpointAt }, run }], null);
            }
        }
        armTimer();
    }

    const ready = serial.run(async () => {
        const interactions = await listAll<InteractionData>('interaction');
        for (const record of interactions) if (['pending', 'approved', 'denied'].includes(record.value.state)) {
            liveInteractions.set(record.value.interactionId, record.value);
        }
        const records = await listAll<RunData>('run');
        for (const record of records) {
            let run = recoverRun(record.value);
            const related = interactions.filter(item => item.value.conversationId === run.conversationId && item.value.runId === run.runId);
            const updatedInteractions: StoreRecord<InteractionData>[] = [];
            for (const item of related) {
                if (item.value.state === 'executing') {
                    run = { ...run, state: 'outcome_unknown', effectState: 'unknown', resultStatus: 'unknown', cleanupState: 'unconfirmed',
                        stopReason: 'APPROVED_ACTION_RECONCILIATION_REQUIRED', resumeRequired: true };
                    updatedInteractions.push({ ...item, revision: item.revision + 1,
                        value: { ...item.value, runEpoch: run.runEpoch, state: 'outcome_unknown', resolvedAt: timestamp(now()) } });
                } else if (['pending', 'approved', 'denied'].includes(item.value.state) && item.value.runEpoch !== run.runEpoch) {
                    updatedInteractions.push({ ...item, revision: item.revision + 1, value: { ...item.value, runEpoch: run.runEpoch } });
                }
            }
            if (run.continuationInteractionId && run.state === 'paused') run = { ...run, resumeRequired: true, stopReason: 'RESTART_RESUME_REQUIRED' };
            if (run === record.value && !updatedInteractions.length) {
                if (!isTerminal(run) || run.cleanupState === 'unconfirmed') {
                    liveRuns.set(run.runId, run);
                    monotonicDeadlines.set(run.runId, performance.now() + Math.max(0, Date.parse(run.deadlineAt) - now()));
                }
                continue;
            }
            const conversation = await getConversation(run.conversationId, undefined, true);
            conversation.value.runEpoch = Math.max(conversation.value.runEpoch, run.runEpoch);
            await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }, ...updatedInteractions],
                [{ type: 'run.recovered', payload: { state: run.state, autoResumeAfterRestart: false }, run }], null);
        }
        for (const record of records) {
            const allocation = childAllocation(record.value);
            if (allocation) {
                const parent = await getRun(allocation.parentConversationId, allocation.parentRunId);
                const child = await getRun(record.value.conversationId, record.value.runId);
                if ((isTerminal(parent.value) || parent.value.state === 'stopping') && !isTerminal(child.value)
                    && child.value.state !== 'outcome_unknown') {
                    await stopRun(await getConversation(child.value.conversationId, undefined, true), child, 'cancelled', 'PARENT_RECOVERED_STOPPED');
                }
                await reconcileInternalParent((await getRun(record.value.conversationId, record.value.runId)).value);
            } else if (childLinks(record.value).length) {
                await internalChildren.syncRetention((await getConversation(record.value.conversationId, undefined, true)).value);
            }
        }
        await tick();
        armTemporaryMetadataTimer();
    });

    async function read(method: string, params: Record<string, unknown>, client: ClientIdentity): Promise<RpcResult> {
        if (method === 'conversations.prepareTemporaryCreate') return { ok: true, data: temporaryCreateCommands.issue(client, now()) };
        if (method === 'server.info') return { ok: true, data: { protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION,
            capabilities: { ...store.capabilities, executor: Boolean(executor), automaticModelExecution: false }, accepting,
            activeRunCount: liveRuns.size, methods: Object.keys(METHOD_SPECS), controlLeaseMs: CONTROL_LEASE_MS,
            temporaryClosedMetadata: store.temporaryMetadataUsage?.() ?? null } };
        if (method === 'conversations.list') {
            const page = await store.listRecords<ConversationData>({ kind: 'conversation', limit: Number(params.limit ?? 50), cursor: params.cursor as string | undefined });
            const items = page.items.filter(record => record.value.principalId === client.principalId
                && !(record.value.state === 'closed' && record.value.retention.mode === 'temporary')
                && (!params.state || record.value.state === params.state) && (!params.mode || record.value.retention.mode === params.mode))
                .map(record => ({ conversationId: record.value.conversationId, revision: record.value.configRevision ?? 1, state: record.value.state,
                    retention: record.value.retention, activeRunId: record.value.activeRunId, createdAt: record.value.createdAt, updatedAt: record.value.updatedAt }));
            return { ok: true, data: { ...page, items } };
        }
        if (method === 'events.unsubscribe') {
            const subscription = subscriptions.get(String(params.subscriptionId));
            if (!subscription || subscription.principalId !== client.principalId || subscription.clientId !== client.clientId) throw new AgentFault('NOT_FOUND', '找不到当前客户端的事件订阅');
            subscriptions.delete(String(params.subscriptionId));
            return { ok: true, data: { unsubscribed: true } };
        }
        if (method === 'server.getReceipt') {
            if (params.conversationId) await getConversation(String(params.conversationId), client, true);
            const key: ReceiptKey = { principalId: client.principalId, clientId: client.clientId,
                ...(params.conversationId ? { conversationId: String(params.conversationId) } : { serverScope: 'server' }),
                clientCommandId: String(params.targetClientCommandId) };
            const receipt = await store.getReceipt(key);
            return { ok: true, data: receipt ? { found: true, result: receipt.result } : { found: false, missing: true } };
        }
        const conversation = await getConversation(String(params.conversationId), client);
        const value = conversation.value;
        checkExpiry(value);
        if (method === 'conversations.get') {
            const activeRun = value.activeRunId ? await getRun(value.conversationId, value.activeRunId) : undefined;
            const control = await store.getRecord<ControlLease>(controlKey(value.conversationId));
            return { ok: true, data: { ...value, revision: value.configRevision ?? 1, run: activeRun ? { ...await displayedRun(activeRun.value), revision: activeRun.revision } : null,
                control: control?.value ?? null }, eventCursor: eventCursor(value) };
        }
        if (method === 'runs.get') {
            const run = await getRun(value.conversationId, String(params.runId));
            return { ok: true, data: { ...await displayedRun(run.value), revision: run.revision }, eventCursor: eventCursor(value) };
        }
        if (method === 'runs.list' || method === 'inputs.list') {
            const page = await store.listRecords({ kind: method === 'runs.list' ? 'run' : 'input', conversationId: value.conversationId,
                cursor: params.cursor as string | undefined, limit: Number(params.limit ?? 50) });
            const budgetReads = new Map<string, Promise<BudgetView>>();
            const items = await Promise.all(page.items.filter(record => method !== 'inputs.list' || !params.runId || record.value.runId === params.runId)
                .map(async record => ({ ...(method === 'runs.list' ? await displayedRun(record.value as RunData, budgetReads) : record.value), revision: record.revision })));
            const queueRunId = method === 'inputs.list' ? String(params.runId ?? value.activeRunId ?? '') : '';
            const queueRun = queueRunId ? await getRun(value.conversationId, queueRunId) : undefined;
            return { ok: true, data: { ...page, items, ...(method === 'inputs.list' ? { revision: queueRun?.value.queueRevision ?? null,
                queueRevision: queueRun?.value.queueRevision ?? null } : {}) }, eventCursor: eventCursor(value) };
        }
        if (method === 'conversations.readHistory') {
            const page = await historyReader.readHistory({ conversationId: value.conversationId, cursor: params.cursor as string | undefined,
                limit: Number(params.limit ?? 50), maxBytes: Number(params.maxBytes ?? 256 * 1024),
                ...(params.startRound !== undefined ? { startRound: Number(params.startRound) } : {}),
                ...(params.endRound !== undefined ? { endRound: Number(params.endRound) } : {}), view: 'raw', effectiveOnly: false });
            return { ok: true, data: page, eventCursor: eventCursor(value) };
        }
        if (method === 'conversations.readArtifact') {
            const chunk = await store.readArtifact({ conversationId: value.conversationId, artifactId: String(params.artifactId),
                offset: Number(params.offset ?? 0), maxBytes: Number(params.maxBytes ?? 256 * 1024) });
            return { ok: true, data: chunk, eventCursor: eventCursor(value) };
        }
        if (method === 'interactions.list') {
            for (const interaction of [...liveInteractions.values()]) if (interaction.conversationId === value.conversationId && Date.parse(interaction.expiresAt) <= now()) {
                const record = await store.getRecord<InteractionData>(interactionKey(value.conversationId, interaction.interactionId));
                if (record) await expireInteraction(record);
            }
            const items: (InteractionData & { revision: number })[] = [];
            const limit = Math.max(1, Math.min(200, Number(params.limit ?? 50)));
            const maxBytes = Math.max(1, Math.min(512 * 1024, Number(params.maxBytes ?? 256 * 1024)));
            let cursor = params.cursor as string | undefined;
            let hasMore = false;
            let bytes = 0;
            for (let scanned = 0; scanned < 200; scanned++) {
                const page = await store.listRecords<InteractionData>({ kind: 'interaction', conversationId: value.conversationId, cursor, limit: 1 });
                const record = page.items[0];
                if (!record) { hasMore = false; break; }
                const item = { ...record.value, revision: record.revision };
                const included = params.runId === undefined || params.runId === item.runId;
                const size = included ? Buffer.byteLength(canonicalJson(item)) : 0;
                if (included && size + bytes > maxBytes) {
                    if (!items.length) throw new AgentFault('FRAME_TOO_LARGE', '交互待办元数据超过本次分页上限');
                    hasMore = true;
                    break;
                }
                if (included) { items.push(item); bytes += size; }
                cursor = page.nextCursor ?? undefined;
                hasMore = page.hasMore;
                if (!hasMore || items.length === limit) break;
            }
            const current = await getConversation(value.conversationId, client);
            return { ok: true, data: { items, nextCursor: hasMore ? cursor ?? null : null, hasMore }, eventCursor: eventCursor(current.value) };
        }
        if (method === 'events.read') {
            const afterSeq = parseEventCursor(params.afterCursor as string | undefined, value);
            const page = await store.readEvents({ conversationId: value.conversationId, afterSeq,
                limit: Number(params.limit ?? 100), maxBytes: Number(params.maxBytes ?? 256 * 1024) });
            const nextCursor = eventCursor(value, page.nextCursor ?? afterSeq);
            return { ok: true, data: { events: page.items, nextCursor, hasMore: page.hasMore }, eventCursor: nextCursor };
        }
        if (method === 'events.subscribe') {
            const appliedSeq = parseEventCursor(params.afterCursor as string | undefined, value);
            const subscriptionId = randomUUID();
            subscriptions.set(subscriptionId, { conversationId: value.conversationId, principalId: client.principalId, clientId: client.clientId, appliedSeq });
            return { ok: true, data: { subscriptionId, snapshotCursor: eventCursor(value), afterCursor: eventCursor(value, appliedSeq) }, eventCursor: eventCursor(value) };
        }
        if (method === 'events.ack') {
            if (params.clientId && params.clientId !== client.clientId) throw new AgentFault('AUTH_FAILED', '不能确认其他客户端的事件');
            const appliedSeq = parseEventCursor(String(params.appliedCursor), value);
            if (params.subscriptionId) {
                const subscription = subscriptions.get(String(params.subscriptionId));
                if (!subscription || subscription.conversationId !== value.conversationId || subscription.principalId !== client.principalId
                    || subscription.clientId !== client.clientId) throw new AgentFault('NOT_FOUND', '找不到当前客户端的事件订阅');
                if (BigInt(appliedSeq) < BigInt(subscription.appliedSeq)) throw new AgentFault('REVISION_CONFLICT', '事件确认游标不能后退');
                subscription.appliedSeq = appliedSeq;
            }
            return { ok: true, data: { appliedCursor: eventCursor(value, appliedSeq) } };
        }
        throw new AgentFault('METHOD_NOT_AVAILABLE', '当前核心尚未提供该方法', { method });
    }

    async function requireIdleResources(conversation: ConversationData, options: { allowClosed?: boolean; errorCode?: string; allowEndedUnknownWait?: boolean } = {}): Promise<void> {
        const busy = (): never => { throw new AgentFault(options.errorCode ?? 'POLICY_UPDATE_BUSY', '当前任务及派生资源尚未全部收尾，请先正常取消并等待清理',
            { conversationId: conversation.conversationId, policyRevision: conversation.policyRevision }); };
        const hasUnresolvedEffect = (run: RunData): boolean => {
            if (run.effectState !== 'unknown') return false;
            const ended = run.unknownWaitEnd as Record<string, unknown> | null | undefined;
            return !(options.allowEndedUnknownWait && run.state === 'cancelled' && run.waitEnded === true
                && run.stopReason === 'CALLER_ENDED_UNKNOWN_WAIT' && run.cleanupState === 'released'
                && ['outcome_unknown', 'cancelled'].includes(String(ended?.originalState)) && Number.isSafeInteger(ended?.originalRunEpoch)
                && Number(ended?.originalRunEpoch) + 1 === run.runEpoch);
        };
        const hasResources = (conversationId: string): boolean => {
            if (workspaceStops.has(conversationId) || pendingConversationClosures.has(conversationId)) return true;
            for (const [runId, owner] of executionConversations) if (owner === conversationId) return true;
            for (const run of liveRuns.values()) if (run.conversationId === conversationId && (!isTerminal(run)
                || hasUnresolvedEffect(run) || !['released', 'not_needed'].includes(run.cleanupState)
                || executions.has(run.runId) || scheduled.has(run.runId) || cleanupTimers.has(run.runId)
                || maintenanceCleanups.has(run.runId))) return true;
            for (const lease of maintenanceLeases.values()) if (lease.execution.conversationId === conversationId) return true;
            return false;
        };
        if (!(conversation.state === 'open' || options.allowClosed && conversation.state === 'closed') || conversation.activeRunId || conversation.retention.activeRuns > 0
            || !['released', 'not_needed'].includes(conversation.cleanupState) || hasResources(conversation.conversationId)) busy();
        let cursor: string | undefined;
        do {
            const page = await store.listRecords<RunData>({ kind: 'run', conversationId: conversation.conversationId, cursor, limit: 50 });
            for (const record of page.items) {
                const run = record.value;
                if (!isTerminal(run) || hasUnresolvedEffect(run) || !['released', 'not_needed'].includes(run.cleanupState)) busy();
                if (!await internalChildren.released(run)) busy();
                for (const child of childLinks(run)) if (hasResources(child.childConversationId)) busy();
            }
            cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
        } while (cursor);
    }

    async function write(method: string, command: CommandContext): Promise<RpcResult> {
        if (method === 'conversations.create') return createConversation(command);
        if (['server.claimControl', 'server.renewControl', 'server.releaseControl'].includes(method)) return claim(method, command);
        if (method === 'server.shutdown') {
            const control = await store.getRecord<ControlLease>(controlKey(null));
            requireControl(control, command.params, command.client, now());
            accepting = false;
            shutdownPlan = { mode: command.params.mode as 'drain' | 'cancel', graceMs: Number(command.params.graceMs ?? 30_000) };
            if (command.params.mode === 'cancel') for (const run of [...liveRuns.values()]) {
                if (!isTerminal(run) && run.state !== 'outcome_unknown') await stopRun(await getConversation(run.conversationId, undefined, true),
                    await getRun(run.conversationId, run.runId), 'cancelled', 'SERVER_SHUTDOWN');
            }
            return standaloneCommit([], [], { shutdown: true, mode: command.params.mode, graceMs: command.params.graceMs ?? 30_000,
                activeRuns: liveRuns.size }, command);
        }
        const conversation = await getConversation(String(command.params.conversationId), command.client);
        await requireConversationControl(conversation, command);
        if (conversation.value.workspaceQuiesce && (method === 'runs.resume' || method === 'conversations.update')) {
            throw new AgentFault('WORKSPACE_BUSY', '恢复停止点尚未释放，原输入和配置保持冻结');
        }
        if (method === 'conversations.update') {
            const revision = conversation.value.configRevision ?? 1;
            if (command.params.expectedRevision !== revision) throw new AgentFault('REVISION_CONFLICT', '会话配置版本已变化', { currentRevision: revision });
            const updates = command.params.options as Record<string, unknown>;
            if ('retention' in updates || 'mode' in updates || 'ttlDurationMs' in updates) throw new AgentFault('INVALID_PARAMS', '保存方式转换须通过conversations.setRetention预览');
            const nextOptions = { ...conversation.value.options, ...updates };
            const policyChanged = permissionConfiguration(conversation.value.options) !== permissionConfiguration(nextOptions);
            if (policyChanged) await requireIdleResources(conversation.value, { allowEndedUnknownWait: true });
            conversation.value.options = nextOptions;
            if (policyChanged) conversation.value.policyRevision++;
            conversation.value.configRevision = revision + 1;
            return commit(conversation, [], [{ type: 'conversation.updated', payload: { effectiveFrom: 'next_request',
                policyRevision: conversation.value.policyRevision, policyChanged } }],
                { revision: conversation.value.configRevision, policyRevision: conversation.value.policyRevision,
                    options: conversation.value.options, effectiveFrom: 'next_request' }, command);
        }
        if (method === 'conversations.close') {
            conversation.value.state = 'closing';
            conversation.value.cleanupState = 'pending';
            conversation.value.cleanupError = null;
            conversation.value.closeReceiptKeys = [...(conversation.value.closeReceiptKeys ?? []), command.key];
            retentionEnd(conversation.value, 'lastClose');
            const result = await commit(conversation, [], [{ type: 'conversation.closing', payload: { reason: command.params.reason ?? null } }],
                { conversationId: conversation.value.conversationId, state: 'closing', cleanupState: 'pending' }, command);
            pendingConversationClosures.add(conversation.value.conversationId);
            if (conversation.value.activeRunId) {
                const run = await getRun(conversation.value.conversationId, conversation.value.activeRunId);
                if (run.value.state !== 'outcome_unknown') await stopRun(await getConversation(conversation.value.conversationId, undefined, true), run, 'cancelled', 'CONVERSATION_CLOSED');
            }
            await finishClose(conversation.value.conversationId);
            return result;
        }
        if (method === 'conversations.reopen') {
            if (conversation.value.retention.mode === 'temporary') throw new AgentFault('TEMPORARY_GONE', '临时会话无法重开');
            checkExpiry(conversation.value);
            if (conversation.value.state !== 'closed' || conversation.value.activeRunId) throw new AgentFault('INVALID_STATE', '会话未完成关闭和清理');
            conversation.value.state = 'open';
            return commit(conversation, [], [{ type: 'conversation.reopened', payload: {} }], { ...conversation.value, revision: conversation.revision + 1 }, command);
        }
        if (method === 'runs.start' || method === 'runs.startInteractive') return startRun(conversation, command);
        if (method.startsWith('inputs.')) return modifyInput(method, conversation, command);
        if (method === 'interactions.respond') return respondInteraction(conversation, command);
        const record = await getRun(conversation.value.conversationId, String(command.params.runId));
        requireRunEpoch(record.value, command.params.expectedRunEpoch);
        if (method === 'runs.cancel' || method === 'runs.interrupt') return stopRun(conversation, record, method === 'runs.cancel' ? 'cancelled' : 'paused', String(command.params.reason ?? method), command);
        if (method === 'runs.resume') {
            if (record.value.state !== 'paused' || record.value.cleanupState === 'unconfirmed') throw new AgentFault('INVALID_STATE', '执行须处于已完成清理的暂停状态');
            if (command.params.expectedHistoryEpoch !== conversation.value.historyEpoch) throw new AgentFault('REVISION_CONFLICT', '历史版本已经变化');
            if (deadlineReached(record.value)) throw new AgentFault('BUDGET_EXCEEDED', '原执行预算期限已经到达');
            if (command.params.budget) throw new AgentFault('CAPABILITY_REQUIRED', '预算增量须由费用模块原子核验，当前入口未提供');
            const interaction = record.value.continuationInteractionId ? await store.getRecord<InteractionData>(
                interactionKey(conversation.value.conversationId, record.value.continuationInteractionId)) : undefined;
            if (interaction && (!['approved', 'denied'].includes(interaction.value.state) || Date.parse(interaction.value.expiresAt) <= now())) {
                throw new AgentFault('INTERACTION_STALE', '原调用仍待批准或已失效，不能由resume重新派发');
            }
            const run = transitionRun(record.value, 'queued', { runEpoch: record.value.runEpoch + 1, stopTarget: null,
                stopReason: interaction && !executor?.capabilities?.toolApprovalContinuation ? 'EXECUTOR_CONTINUATION_UNAVAILABLE' : null,
                phase: 'admitting', resumeRequired: false,
                executorAvailable: Boolean(executor && (!interaction || executor.capabilities?.toolApprovalContinuation)), updatedAt: timestamp(now()) });
            conversation.value.runEpoch = Math.max(conversation.value.runEpoch, run.runEpoch);
            const updatedInteraction: StoreRecord<InteractionData>[] = interaction ? [{ ...interaction, revision: interaction.revision + 1,
                value: { ...interaction.value, runEpoch: run.runEpoch } }] : [];
            const result = await commit(conversation, [{ ...record, revision: record.revision + 1, value: run }, ...updatedInteraction],
                [{ type: 'run.queued', payload: { resumed: true, executorAvailable: Boolean(executor) }, run }], { ...run }, command);
            schedule(run);
            return result;
        }
        throw new AgentFault('METHOD_NOT_AVAILABLE', '当前核心尚未提供该写方法', { method });
    }

    async function dispatch(method: string, rawParams: Record<string, unknown>, client: ClientIdentity): Promise<RpcResult> {
        try {
            await ready;
            if (closed) throw new AgentFault('IPC_UNAVAILABLE', '核心已关闭');
            if (!client || typeof client.principalId !== 'string' || !client.principalId || typeof client.clientId !== 'string' || !client.clientId) {
                throw new AgentFault('AUTH_FAILED', '缺少可信客户端身份');
            }
            const params = validateParams(method, rawParams);
            canonicalJson(params);
            if (method === 'events.read' && Number(params.waitMs ?? 0) > 0) {
                let wake: () => void = () => undefined;
                const notification = new Promise<void>(resolve => { wake = resolve; });
                const unsubscribe = listeners.subscribe(event => { if (event.conversationId === params.conversationId) wake(); });
                let waitTimer: ReturnType<typeof setTimeout> | undefined;
                eventWaiters.set(wake, { conversationId: String(params.conversationId), release: () => {
                    if (waitTimer) clearTimeout(waitTimer);
                    unsubscribe();
                } });
                try {
                    const first = await serial.run(async () => { await collectTemporaryMetadata(); return read(method, params, client); });
                    if ((first.data as { events: AgentEvent[] }).events.length) return first;
                    await Promise.race([notification, new Promise<void>(resolve => {
                        waitTimer = setTimeout(resolve, Number(params.waitMs));
                    })]);
                    if (closed) throw new AgentFault('IPC_UNAVAILABLE', '事件等待期间核心已关闭');
                    return await serial.run(() => read(method, params, client));
                } finally {
                    if (waitTimer) clearTimeout(waitTimer);
                    eventWaiters.delete(wake);
                    unsubscribe();
                }
            }
            return await serial.run(async () => {
                await collectTemporaryMetadata();
                if (!METHOD_SPECS[method].writes) return read(method, params, client);
                const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
                if (conversationId) await getConversation(conversationId, client, true);
                const key: ReceiptKey = { principalId: client.principalId, clientId: client.clientId,
                    ...(conversationId ? { conversationId } : { serverScope: 'server' }), clientCommandId: String(params.clientCommandId) };
                const hash = operationHash(method, params);
                const receipt = await store.getReceipt(key);
                if (receipt) {
                    if (receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '相同命令ID已经用于不同方法或参数');
                    return receipt.result;
                }
                const temporaryCreateCommandExpiresAt = method === 'conversations.create' && (params.retention as RetainPolicy).mode === 'temporary'
                    ? temporaryCreateCommands.require(String(params.clientCommandId), client, now()) : undefined;
                const command = { key, hash, client, params, method, temporaryCreateCommandExpiresAt };
                try { return await write(method, command); }
                catch (error) {
                    if (error instanceof AgentFault && !error.mayHaveStarted && !error.code.startsWith('STORAGE_')) {
                        const result = { ...failure(error), receiptId: randomUUID() };
                        const outcome = await store.commitTransition({ expected: [], receipt: newReceipt(command, result) });
                        return outcome.receipt?.result ?? result;
                    }
                    throw error;
                }
            });
        } catch (error) { return failure(error); }
    }

    async function close(): Promise<void> {
        if (closing) return closing;
        closing = (async () => {
            await ready;
            accepting = false;
            const closeStartedAt = performance.now();
            const graceMs = shutdownPlan?.graceMs ?? cleanupGraceMs;
            if (shutdownPlan?.mode === 'drain') await executions.wait(graceMs);
            await serial.run(async () => {
                const temporaries = (await listAll<ConversationData>('conversation')).filter(record => record.value.retention.mode === 'temporary'
                    && record.value.state !== 'closed');
                for (const conversation of temporaries) {
                    pendingConversationClosures.add(conversation.value.conversationId);
                    if (conversation.value.state !== 'closing') {
                        conversation.value.state = 'closing';
                        conversation.value.cleanupState = 'pending';
                        conversation.value.cleanupError = null;
                        retentionEnd(conversation.value, 'lastClose');
                        await commit(conversation, [], [{ type: 'conversation.closing', payload: { reason: 'SERVER_CLOSED' } }], null);
                    }
                }
                for (const run of [...liveRuns.values()]) if (!isTerminal(run) && run.state !== 'outcome_unknown') {
                    const conversation = await getConversation(run.conversationId, undefined, true);
                    if (shutdownPlan?.mode !== 'cancel' && conversation.value.retention.mode !== 'temporary' && run.continuationInteractionId
                        && ['waiting', 'paused', 'queued'].includes(run.state) && ['released', 'not_needed'].includes(run.cleanupState)
                        && !executions.has(run.runId)) {
                        const record = await getRun(run.conversationId, run.runId);
                        const saved = transitionRun(record.value, 'paused', { resumeRequired: true, phase: null,
                            stopReason: 'RESTART_RESUME_REQUIRED', updatedAt: timestamp(now()) });
                        await commit(conversation, [{ ...record, revision: record.revision + 1, value: saved }],
                            [{ type: 'run.paused', payload: { reason: 'SERVER_CLOSED', resumeRequired: true }, run: saved }], null);
                        continue;
                    }
                    await stopRun(await getConversation(run.conversationId, undefined, true), await getRun(run.conversationId, run.runId), 'cancelled', 'SERVER_CLOSED');
                }
            });
            await executions.wait(Math.max(0, graceMs - (performance.now() - closeStartedAt)));
            await serial.run(async () => {
                for (const run of [...liveRuns.values()]) {
                    const record = await getRun(run.conversationId, run.runId);
                    if (record.value.state === 'stopping') await finalizeStop(run.conversationId, run.runId, 'unconfirmed');
                }
                const temporaries = (await listAll<ConversationData>('conversation')).filter(record => record.value.retention.mode === 'temporary'
                    && record.value.state !== 'closed');
                const incomplete: string[] = [];
                for (const conversation of temporaries) if (!await finishClose(conversation.value.conversationId)) incomplete.push(conversation.value.conversationId);
                if (incomplete.length) throw new AgentFault('CLEANUP_UNCONFIRMED', '临时会话尚未完成关闭清理，核心与原文保留供核对或重试',
                    { conversationIds: incomplete }, true);
            });
            await serial.idle();
            closed = true;
            for (const [wake, waiter] of eventWaiters) { wake(); waiter.release(); }
            eventWaiters.clear();
            if (timer) clearTimeout(timer);
            if (temporaryMetadataTimer) clearTimeout(temporaryMetadataTimer);
            for (const cleanupTimer of cleanupTimers.values()) clearTimeout(cleanupTimer);
            cleanupTimers.clear();
            subscriptions.clear();
            listeners.close();
            await store.close();
        })().catch(error => { closing = undefined; throw error; });
        return closing;
    }

    async function authorizeGlobalWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<void> {
        await ready;
        if (!client?.principalId || !client.clientId) throw new AgentFault('AUTH_FAILED', '缺少可信客户端身份');
        await serial.run(async () => {
            if (closed || !accepting) throw new AgentFault('INVALID_STATE', '核心关闭期间拒绝新的全局写入');
            const control = await store.getRecord<ControlLease>(controlKey(null));
            requireControl(control, params, client, now());
        });
    }

    async function authorizeConversationWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<ConversationData> {
        await ready;
        return serial.run(async () => {
            if (closed || !accepting || !client?.principalId || !client.clientId || typeof params.conversationId !== 'string') {
                throw new AgentFault('AUTH_FAILED', '会话写入需要可信客户端、会话与有效控制租约');
            }
            const conversation = await getConversation(params.conversationId, client);
            if (conversation.value.state !== 'open') throw new AgentFault('INVALID_STATE', '会话当前不可写');
            checkExpiry(conversation.value);
            await requireConversationControl(conversation, { client, params } as CommandContext);
            return structuredClone(conversation.value);
        });
    }

    async function createMaintenanceRun(input: { conversationId: string; operationId?: string; config?: FrozenCompressionConfig; budget?: Record<string, unknown>; purpose?: 'compression' | 'workspace_restore' },
        authorization: { client: ClientIdentity; params: Record<string, unknown> }, cancel: (execution: ExecutionLease) => Promise<CleanupEvidence>): Promise<ExecutionLease> {
        await ready;
        return serial.run(async () => {
            const conversation = await getConversation(input.conversationId, authorization.client);
            await requireConversationControl(conversation, { client: authorization.client, params: authorization.params } as CommandContext);
            const restoring = input.purpose === 'workspace_restore';
            const suppliedBudget: Record<string, unknown> | undefined = restoring ? { costMode: 'estimated', currency: 'USD', maxCostMicros: 0, maxModelCalls: 0,
                maxOutputTokens: 0, wallMs: 600000, modelRequestsAllowed: false } : input.budget;
            if (!accepting || conversation.value.state !== 'open' || conversation.value.workspaceQuiesce || !input.operationId
                || (!restoring && !input.config) || !suppliedBudget) {
                throw new AgentFault('INVALID_STATE', '维护压缩需要可写会话、原操作ID、冻结配置及明确预算');
            }
            checkExpiry(conversation.value);
            const stableBudget = { ...suppliedBudget };
            if (Number.isSafeInteger(stableBudget.wallMs)) delete stableBudget.deadlineAt;
            const hash = valueHash([input.purpose ?? 'compression', input.config?.configFingerprint ?? 'workspace_restore/no-model', stableBudget]);
            const markerKey: StoreKey = { conversationId: input.conversationId, kind: 'step',
                id: `maintenance:${valueHash([authorization.client.principalId, authorization.client.clientId, input.operationId])}` };
            const previous = await store.getRecord(markerKey);
            if (previous) {
                if (previous.value.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '维护操作ID已经使用另一份配置或预算');
                return structuredClone(previous.value.execution) as ExecutionLease;
            }
            if (conversation.value.activeRunId) throw new AgentFault('INVALID_STATE', '原会话执行尚未结束，维护压缩不能另建根任务');
            const budget: Record<string, unknown> = restoring ? { ...suppliedBudget, deadlineAt: timestamp(now() + 600000) } : validateBudget(suppliedBudget, now(), true);
            const deadlineAt = String(suppliedBudget.deadlineAt ?? budget.deadlineAt);
            if (!Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= now()) throw new AgentFault('BUDGET_REQUIRED', '维护期限须有效且尚未到期');
            budget.deadlineAt = deadlineAt;
            const runId = randomUUID();
            const time = timestamp(now());
            const run: RunData = { conversationId: input.conversationId, runId, rootRunId: runId, parentRunId: null, kind: 'maintenance',
                runEpoch: conversation.value.runEpoch + 1, state: 'running', phase: 'preparing', resultStatus: null, stopReason: null,
                effectState: 'none', cleanupState: 'not_needed', activeRoundId: null, activeStepId: randomUUID(), pendingInteractionIds: [],
                budget, nextCheckpointAt: null, eventCursor: null, createdAt: time, updatedAt: time, deadlineAt, queueRevision: 0,
                inputOrder: 0, activeInputId: null, stopTarget: null, executorAvailable: true, resultContentId: null, failure: null,
                initiator: structuredClone(authorization.client), options: structuredClone(conversation.value.options),
                maintenanceEpoch: conversation.value.runEpoch + 1, maintenancePurpose: input.purpose ?? 'compression' };
            const execution: ExecutionLease = { kind: 'maintenance', conversationId: input.conversationId, runId, runEpoch: run.runEpoch,
                rootBudgetId: runId, roundId: null, stepId: run.activeStepId!, deadlineAt };
            conversation.value.activeRunId = runId;
            conversation.value.runEpoch = run.runEpoch;
            await commit(conversation, [{ key: runKey(input.conversationId, runId), revision: 1, value: run },
                { key: markerKey, revision: 1, value: { kind: 'maintenance_operation', operationHash: hash, execution } }],
                [{ type: 'run.maintenanceStarted', payload: { operationId: input.operationId, rootBudgetId: runId }, run }], execution);
            maintenanceLeases.set(runId, { execution, cancel });
            return execution;
        });
    }

    async function resumeMaintenanceRun(input: { execution: ExecutionLease; recoveredAttemptId?: string },
        authorization: { client: ClientIdentity; params: Record<string, unknown> }, cancel: (execution: ExecutionLease) => Promise<CleanupEvidence>): Promise<void> {
        await ready;
        await serial.run(async () => {
            const lease = input.execution;
            const conversation = await getConversation(lease.conversationId, authorization.client);
            await requireConversationControl(conversation, { client: authorization.client, params: authorization.params } as CommandContext);
            const record = await getRun(lease.conversationId, lease.runId);
            const run = record.value;
            if (!accepting || conversation.value.state !== 'open' || conversation.value.workspaceQuiesce
                || conversation.value.activeRunId !== lease.runId || run.kind !== 'maintenance' || run.maintenancePurpose !== 'compression'
                || run.rootRunId !== lease.rootBudgetId || run.runEpoch !== lease.runEpoch || run.maintenanceEpoch !== lease.runEpoch
                || run.deadlineAt !== lease.deadlineAt || Date.parse(lease.deadlineAt) <= now()) {
                throw new AgentFault('STALE_RUN_EPOCH', '维护恢复需要仍有效的原执行、代次、根预算和期限');
            }
            if (run.state === 'running') return;
            if (run.state !== 'outcome_unknown' || !input.recoveredAttemptId || run.stopTarget
                || executions.has(run.runId) || scheduled.has(run.runId) || maintenanceLeases.has(run.runId)) {
                throw new AgentFault('OUTCOME_UNKNOWN', '原维护结果须查回且原执行已停止后，才能继续尚未发送的块', undefined, true);
            }
            const updated = transitionRun(transitionRun(transitionRun(run, 'paused'), 'queued'), 'running',
                { phase: 'preparing', cleanupState: 'not_needed', resultStatus: null, stopReason: null,
                    updatedAt: timestamp(now()), maintenanceFailure: null });
            await commit(conversation, [{ ...record, revision: record.revision + 1, value: updated }],
                [{ type: 'run.maintenanceResumed', payload: { recoveredAttemptId: input.recoveredAttemptId, rootBudgetId: lease.rootBudgetId }, run: updated }], null);
            maintenanceLeases.set(run.runId, { execution: structuredClone(lease), cancel });
        });
    }

    async function finishMaintenanceRun(input: { execution: ExecutionLease; result: 'published' | 'cancelled' | 'failed' | 'unknown'; failure?: ContextFailure }): Promise<void> {
        await ready;
        await serial.run(async () => {
            const lease = input.execution;
            const record = await getRun(lease.conversationId, lease.runId);
            const run = record.value;
            const owned = maintenanceLeases.get(lease.runId);
            const stoppingOriginal = run.state === 'stopping' && owned?.execution.runEpoch === lease.runEpoch && run.runEpoch === lease.runEpoch + 1;
            const finishedOriginalStop = run.state === 'cancelled' && run.stopTarget === 'cancelled'
                && run.maintenanceEpoch === lease.runEpoch && run.runEpoch === lease.runEpoch + 1;
            if (run.kind === 'maintenance' && run.rootRunId === lease.rootBudgetId && finishedOriginalStop) {
                if (owned?.execution.runEpoch === lease.runEpoch) maintenanceLeases.delete(lease.runId);
                return;
            }
            if (run.kind !== 'maintenance' || run.rootRunId !== lease.rootBudgetId || (run.runEpoch !== lease.runEpoch && !stoppingOriginal)) {
                throw new AgentFault('STALE_RUN_EPOCH', '维护结束必须属于原运行、根预算及代次');
            }
            if (isTerminal(run)) return;
            const conversation = await getConversation(lease.conversationId, undefined, true);
            const unknown = input.result === 'unknown';
            let updated: RunData;
            if (run.state === 'stopping') {
                updated = transitionRun(run, unknown ? 'outcome_unknown' : run.stopTarget ?? 'cancelled');
            } else if (input.result === 'cancelled') {
                updated = transitionRun(transitionRun(run, 'stopping', { stopTarget: 'cancelled', runEpoch: run.runEpoch + 1 }), 'cancelled');
                conversation.value.runEpoch = Math.max(conversation.value.runEpoch, updated.runEpoch);
            } else updated = transitionRun(run, unknown ? 'outcome_unknown' : input.result === 'published' ? 'succeeded' : 'failed');
            updated.phase = null;
            updated.cleanupState = unknown ? 'unconfirmed' : 'released';
            updated.resultStatus = unknown ? 'unknown' : updated.state === 'cancelled' ? 'cancelled' : input.result === 'published' ? 'success' : 'failed';
            if (run.maintenancePurpose === 'workspace_restore' && (unknown || input.result === 'published')) updated.effectState = unknown ? 'unknown' : 'confirmed';
            updated.updatedAt = timestamp(now());
            if (input.failure) updated.maintenanceFailure = structuredClone(input.failure);
            if (isTerminal(updated)) endRun(conversation.value, updated);
            await commit(conversation, [{ ...record, revision: record.revision + 1, value: updated }],
                [{ type: 'run.maintenanceFinished', payload: { result: input.result, cleanupState: updated.cleanupState }, run: updated }], null);
            const cleanupTimer = cleanupTimers.get(lease.runId);
            if (cleanupTimer) clearTimeout(cleanupTimer);
            cleanupTimers.delete(lease.runId);
            maintenanceLeases.delete(lease.runId);
            if (conversation.value.state === 'closing' && isTerminal(updated) && updated.cleanupState === 'released') await finishClose(lease.conversationId);
        });
    }

    async function quiesceWorkspace(input: { restorePlanId: string; mode: 'files_only' | 'round_restart'; expectedHistoryEpoch: number; expectedWorkspaceRevision: number;
        targetRoundId?: string | null; childConversationIds?: string[] },
        context: BoundToolContext, authorization: { client: ClientIdentity; params: Record<string, unknown> }, settle: () => Promise<boolean>): Promise<{ release(): Promise<void> }> {
        await authorizeConversationWrite(authorization.client, authorization.params);
        let token: string = randomUUID();
        const childTargets = new Map<string, string[]>();
        await serial.run(async () => {
            const conversation = await getConversation(context.conversationId, authorization.client);
            const previous = conversation.value.workspaceQuiesce as { restorePlanId?: string; token?: string } | undefined;
            if (conversation.value.historyEpoch !== input.expectedHistoryEpoch || conversation.value.workspaceRevision !== input.expectedWorkspaceRevision
                || previous && previous.restorePlanId !== input.restorePlanId) throw new AgentFault('WORKSPACE_BUSY', '恢复版本已变化或已有安全停止点');
            const run = await getRun(context.conversationId, context.runId);
            if (run.value.runEpoch !== context.runEpoch || run.value.effectState === 'unknown' || run.value.state === 'outcome_unknown') {
                throw new AgentFault('OUTCOME_UNKNOWN', '恢复前须确认原执行代次和全部在途动作');
            }
            for (const childId of new Set(input.childConversationIds ?? [])) {
                const child = await getConversation(childId, undefined, true);
                if (childId === context.conversationId || child.value.principalId !== conversation.value.principalId
                    || child.value.options.parentConversationId !== context.conversationId) {
                    throw new AgentFault('CONTROL_REQUIRED', '恢复停止点只接纳预览所属父会话的子任务');
                }
                const marker = child.value.workspaceQuiesce as { restorePlanId?: string; token?: string } | undefined;
                if (marker && marker.restorePlanId !== input.restorePlanId) throw new AgentFault('WORKSPACE_BUSY', '子任务已有另一恢复停止点');
                const runs = await listAll<RunData>('run', childId);
                if (runs.some(record => record.value.effectState === 'unknown' || record.value.state === 'outcome_unknown')) {
                    throw new AgentFault('OUTCOME_UNKNOWN', '所属子任务仍有未核清副作用，恢复预览保留');
                }
                childTargets.set(childId, runs.map(record => record.value.runId));
            }
            if (previous?.token) token = previous.token;
            conversation.value.workspaceQuiesce = { restorePlanId: input.restorePlanId, token };
            workspaceStops.set(context.conversationId, token);
            await commit(conversation, [], [{ type: 'workspace.quiescing', payload: { restorePlanId: input.restorePlanId } }], null);
            for (const [childId, runIds] of childTargets) {
                const child = await getConversation(childId, undefined, true);
                child.value.workspaceQuiesce = { restorePlanId: input.restorePlanId, token, parentConversationId: context.conversationId };
                workspaceStops.set(childId, token);
                await commit(child, [], [{ type: 'workspace.quiescing', payload: { restorePlanId: input.restorePlanId,
                    parentConversationId: context.conversationId } }], null);
                for (const childRunId of runIds) {
                    const childRun = await getRun(childId, childRunId);
                    if (!isTerminal(childRun.value) && childRun.value.state !== 'paused') {
                        await stopRun(await getConversation(childId, undefined, true), childRun, 'paused', 'WORKSPACE_RESTORE');
                    }
                }
            }
            if (!isTerminal(run.value) && run.value.state !== 'paused' && run.value.maintenancePurpose !== 'workspace_restore') {
                await stopRun(await getConversation(context.conversationId), run, 'paused', 'WORKSPACE_RESTORE');
            }
        });
        const deadline = performance.now() + cleanupGraceMs;
        while (true) {
            const run = await getRun(context.conversationId, context.runId);
            let childrenReleased = true;
            for (const [childId, runIds] of childTargets) for (const childRunId of runIds) {
                const child = await getRun(childId, childRunId);
                if (child.value.effectState === 'unknown' || child.value.state === 'outcome_unknown' || child.value.cleanupState === 'unconfirmed') {
                    throw new AgentFault('CLEANUP_UNCONFIRMED', '所属子任务的执行或资源尚未核清，恢复停止点继续保留');
                }
                if (executions.has(childRunId) || scheduled.has(childRunId)
                    || !(isTerminal(child.value) || child.value.state === 'paused')
                    || !['released', 'not_needed'].includes(child.value.cleanupState)) childrenReleased = false;
            }
            if (!executions.has(context.runId) && !scheduled.has(context.runId) && (isTerminal(run.value) || run.value.state === 'paused'
                || run.value.kind === 'maintenance' && run.value.maintenancePurpose === 'workspace_restore' && run.value.state === 'running')
                && ['released', 'not_needed'].includes(run.value.cleanupState) && childrenReleased) {
                context.runEpoch = run.value.runEpoch;
                break;
            }
            if (performance.now() >= deadline || run.value.cleanupState === 'unconfirmed' || run.value.effectState === 'unknown') {
                throw new AgentFault('CLEANUP_UNCONFIRMED', '恢复安全停止点尚未确认，原输入保持冻结');
            }
            await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        if (!await settle()) throw new AgentFault('CLEANUP_UNCONFIRMED', '恢复前原工具或压缩动作尚未结清');
        return { release: async () => {
            await serial.run(async () => {
                for (const conversationId of [context.conversationId, ...childTargets.keys()]) {
                    const conversation = await getConversation(conversationId, undefined, true);
                    const marker = conversation.value.workspaceQuiesce as { token?: string } | undefined;
                    if (!marker) { workspaceStops.delete(conversationId); continue; }
                    if (marker.token !== token) throw new AgentFault('WORKSPACE_BUSY', '恢复安全停止点已被替换');
                    delete conversation.value.workspaceQuiesce;
                    await commit(conversation, [], [{ type: 'workspace.quiesceReleased', payload: { restorePlanId: input.restorePlanId } }], null);
                    workspaceStops.delete(conversationId);
                }
            });
        } };
    }

    internalChildren = new InternalChildren({ ready: () => ready, serial: operation => serial.run(operation), now,
        accepting: () => accepting && !closed, executorAvailable: () => Boolean(executor),
        retentionOwnershipAvailable: () => options.internalChildRetentionOwnership === 'parent-cascade-v1',
        readBudget: rootBudgetId => {
            if (!accountingPort) throw new AgentFault('CHILD_BUDGET_REQUIRED', '内部派发须接入原根费用账本');
            return accountingPort.read(rootBudgetId);
        },
        getConversation: conversationId => getConversation(conversationId, undefined, true), getRun,
        listRuns: conversationId => listAll<RunData>('run', conversationId),
        readContent: (conversationId, contentId) => store.readContent(conversationId, contentId),
        commit: (conversation, records, events, data, contents) => commit(conversation, records, events, data, undefined, contents),
        createInput: (conversationId, runId, content) => createInput(conversationId, runId, 'queue', content, 1, {}),
        schedule, stop: (conversation, run, reason) => retryStoredRevision(async () => stopRun(
            await getConversation(conversation.value.conversationId, undefined, true),
            await getRun(run.value.conversationId, run.value.runId), 'cancelled', reason)),
        cancelExecution: (runId, reason) => executions.cancel(runId, reason),
        subscribe: listener => listeners.subscribe(listener) });

    return { dispatch, close, authorizeGlobalWrite, authorizeConversationWrite, createMaintenanceRun, resumeMaintenanceRun, finishMaintenanceRun, quiesceWorkspace, internalChildren,
        assertConversationIdle: async (conversationId: string, client: ClientIdentity, allowClosed = false): Promise<ConversationData> => {
            await ready;
            return serial.run(async () => {
                const record = await getConversation(conversationId, client, true);
                await requireIdleResources(record.value, { allowClosed, errorCode: 'CONVERSATION_BUSY' });
                return structuredClone(record.value);
            });
        },
        setHistoryReader: async (reader: Pick<StorePort, 'readHistory'>): Promise<void> => {
            await ready;
            await serial.run(async () => {
                if (closed || !accepting) throw new AgentFault('INVALID_STATE', '核心关闭期间无法更换历史读取端口');
                historyReader = reader;
            });
        },
        subscribe: (listener: (event: AgentEvent) => void) => listeners.subscribe(listener),
        setAccountingPort: async (next: Pick<AccountingPort, 'read'> | undefined): Promise<void> => {
            await ready;
            await serial.run(async () => {
                if (closed || !accepting) throw new AgentFault('INVALID_STATE', '核心关闭期间无法更换账本读取端口');
                accountingPort = next;
            });
        },
        applyRetentionSweep,
        hasActiveWork: async (): Promise<boolean> => {
            await ready;
            return serial.run(async () => {
                if (closed) return false;
                for (const conversationId of pendingRetentionSweeps) await clearPurgedConversationCaches(conversationId);
                if (executions.has() || scheduled.size > 0 || executionConversations.size > 0 || cleanupTimers.size > 0
                    || maintenanceLeases.size > 0 || maintenanceCleanups.size > 0) return true;
                const cachedConversations = new Set([...pendingConversationClosures,
                    ...[...liveRuns.values()].map(run => run.conversationId), ...[...liveInteractions.values()].map(interaction => interaction.conversationId)]);
                for (const conversationId of cachedConversations) await clearPurgedConversationCaches(conversationId);
                if (liveInteractions.size > 0) return true;
                const retainedConversations = new Set(pendingConversationClosures);
                for (const run of liveRuns.values()) {
                    if (isTerminal(run) || run.state === 'outcome_unknown') {
                        retainedConversations.add(run.conversationId);
                    } else if (!(run.continuationInteractionId && run.state === 'paused'
                        && ['released', 'not_needed'].includes(run.cleanupState))) return true;
                }
                for (const conversationId of retainedConversations) {
                    const conversation = await store.getRecord<ConversationData>(conversationKey(conversationId));
                    if (conversation?.value.retention.mode === 'temporary') return true;
                }
                return false;
            });
        },
        setApprovalLedger: async (next: Pick<ApprovalLedger, 'respond'> | undefined, tools?: Pick<PendingToolCoordinator, 'cancel'>): Promise<void> => {
            await ready;
            await serial.run(async () => {
                if (closed || !accepting) throw new AgentFault('INVALID_STATE', '核心关闭期间无法更换批准账本');
                approvalLedger = next;
                pendingTools = tools;
            });
        },
        setExecutor: async (next: AgentExecutor | undefined): Promise<void> => {
            await ready;
            await serial.run(async () => {
                if (closed || !accepting) throw new AgentFault('INVALID_STATE', '核心关闭期间无法更换执行器');
                if (executions.has()) throw new AgentFault('INVALID_STATE', '须等待当前执行器结束后再替换');
                executor = next;
                for (const run of liveRuns.values()) schedule(run);
            });
        } };
}
