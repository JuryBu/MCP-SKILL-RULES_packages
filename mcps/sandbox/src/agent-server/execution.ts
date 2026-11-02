import { randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from './protocol.js';
import type { JsonObject, JsonValue } from './protocol.js';
import type { AgentExecutor, ApprovalToolIdentity, ExecutorContext, ExecutorOutcome } from './runtime.js';
import { ExecutorFailure } from './runtime.js';
import type { HistoryItem, HistoryPage } from './storage/port.js';
import { objectValue, sha256 } from './providers/assemble.js';
import { ProviderFault } from './providers/types.js';
import type { Acceptance, FunctionTool, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderProfile, ProviderProtocol, RequestSnapshot, RequestVersions, ToolCall, ToolResult } from './providers/types.js';
import type { ProviderDispatcher } from './providers/dispatch.js';
import type { UpperBound } from './accounting/budget-ledger.js';
import type { ToolRouter } from './tools/router.js';
import type { BoundToolContext, ToolExecutionResult, TrustedToolContext } from './tools/types.js';
import { assertChildExecutionBounds, canUseInternalDelegation } from './delegation/execution-plan.js';
import { DELEGATION_FUNCTION_SCHEMAS } from './tools/delegation.js';
import { hasMcpToolImageReferences } from './media/tool-results.js';
import { appendNativeHistoryView } from './context/native-view-build.js';
import { scopedToolActionId } from './tool-action-identity.js';

export interface ExecutionPlan {
    profile: ProviderProfile;
    adapter: ProviderAdapter;
    modelId: string;
    rootBudgetId: string;
    deadlineAt: string;
    parameters: JsonObject;
    catalogVersion: string;
    capabilityVersion: string;
    priceVersion: string | null;
    maxModelCalls: number;
    maxOutputTokens: number;
    toolNames: readonly string[] | null;
}

export interface PreparedExecutionView {
    view: NativeSendView;
    history: Pick<HistoryPage, 'historyEpoch' | 'appendSeq' | 'viewRevision'>;
    attachmentManifestHash: string;
    skillVersions?: Record<string, string>;
    ruleVersions?: Record<string, string>;
    instructionPrefixHash?: string;
}

export interface ExecutionServices {
    plan(context: ExecutorContext): Promise<ExecutionPlan>;
    prepareRequest(context: ExecutorContext, plan: ExecutionPlan, input: {
        view: NativeSendView; versions: Omit<RequestVersions, 'catalogVersion' | 'capabilityVersion' | 'priceVersion'>;
    }): Promise<{ adapter: ProviderAdapter; snapshot: RequestSnapshot; upperBound: UpperBound }>;
    dispatcher: ProviderDispatcher;
    tools: ToolRouter;
    toolContext(context: ExecutorContext, identity: { stepId: string; actionId: string; attemptId: string }): Promise<TrustedToolContext>;
    publish(context: ExecutorContext, response: NormalizedResponse): Promise<JsonValue[]>;
    transformToolResult?(context: ExecutorContext, plan: ExecutionPlan, result: ToolResult, identity: {
        stepId: string; actionId: string; attemptId: string; toolContext: TrustedToolContext;
    }): Promise<ToolResult>;
    renderToolResults?(context: ExecutorContext, plan: ExecutionPlan, view: NativeSendView, results: ToolResult[]): Promise<ToolResult[]>;
    prepareView?(context: ExecutorContext, plan: ExecutionPlan, input: { tools: FunctionTool[] }): Promise<PreparedExecutionView>;
    postStep?(context: ExecutorContext, plan: ExecutionPlan, input: { tools: FunctionTool[] }): Promise<unknown>;
    release(context: ExecutorContext): Promise<'released' | 'not_needed' | 'unconfirmed'>;
}

async function transformToolResult(services: ExecutionServices, context: ExecutorContext, plan: ExecutionPlan, result: ToolResult,
    identity: { stepId: string; actionId: string; attemptId: string; toolContext: TrustedToolContext }): Promise<ToolResult> {
    if (services.transformToolResult) return services.transformToolResult(context, plan, result, identity);
    const value = objectValue(result.result);
    const payload = objectValue(value?.data) ?? value;
    if (Array.isArray(payload?.content) && payload.content.some(part => objectValue(part)?.type === 'image')) {
        throw new ProviderFault('E_TOOL_IMAGE_PIPELINE_REQUIRED', '工具图片尚未接入原件与原生续接，停止长文本转发', {
            acceptance: 'accepted', nativeCode: 'transformToolResult', nativeReason: `工具 ${result.name} 原调用 ${result.callId} 缺少图片转换hook`,
        });
    }
    return result;
}

async function renderToolResults(services: ExecutionServices, context: ExecutorContext, plan: ExecutionPlan,
    view: NativeSendView, results: ToolResult[]): Promise<ToolResult[]> {
    if (services.renderToolResults) return services.renderToolResults(context, plan, view, results);
    if (results.some(hasMcpToolImageReferences)) throw new ProviderFault('E_TOOL_IMAGE_PIPELINE_REQUIRED', '工具图片引用尚未接入发送时原生渲染', {
        acceptance: 'not_sent', nativeCode: 'renderToolResults', nativeReason: '图片原件已保存，当前模型请求缺少renderToolResults hook',
    });
    return results;
}

function appendUser(view: NativeSendView, text: string): NativeSendView {
    if (view.protocol === 'gemini') return { ...view, contents: [...(view.contents ?? []), { role: 'user', parts: [{ text }] }] };
    if (view.protocol === 'openai_responses') return { ...view, input: [...(view.input ?? []), { role: 'user', content: text }] };
    return { ...view, messages: [...(view.messages ?? []), { role: 'user', content: text }] };
}

function appendNative(view: NativeSendView, response: NormalizedResponse): NativeSendView {
    if (view.protocol === 'gemini') return { ...view, contents: [...(view.contents ?? []), ...response.replayMessages] };
    if (view.protocol === 'openai_responses') return { ...view, input: [...(view.input ?? []), ...response.replayMessages] };
    return { ...view, messages: [...(view.messages ?? []), ...response.replayMessages] };
}

function inputText(value: JsonValue): string {
    const object = objectValue(value);
    if (!object || typeof object.text !== 'string') throw new ProviderFault('E_CONTEXT_INPUT', '已消费输入缺少有效文本', { acceptance: 'not_sent' });
    if (Array.isArray(object.references) && object.references.length) {
        throw new ProviderFault('E_ATTACHMENT_VIEW_REQUIRED', '附件须经已校验的原生附件视图准备后发送', { acceptance: 'not_sent' });
    }
    return object.text;
}

export async function prepareNativeHistory(context: ExecutorContext, plan: ExecutionPlan, options: {
    maxItems?: number; maxMaterialBytes?: number;
    renderToolResults?: (view: NativeSendView, results: ToolResult[]) => Promise<ToolResult[]>;
} = {}): Promise<PreparedExecutionView> {
    const maxItems = options.maxItems ?? 2048;
    const maxMaterialBytes = options.maxMaterialBytes ?? 32 * 1024 * 1024;
    const items: HistoryItem[] = [];
    let cursor: string | undefined;
    let history: PreparedExecutionView['history'] | undefined;
    let declaredMaterialBytes = 0;
    do {
        const page = await context.readHistory({ cursor, limit: 100, maxBytes: 256 * 1024 });
        if (history && page.historyEpoch !== history.historyEpoch) throw new ProviderFault('E_CONTEXT_VERSION', '准备发送期间原文版本已变化', { acceptance: 'not_sent' });
        history = { historyEpoch: page.historyEpoch, appendSeq: page.appendSeq, viewRevision: page.viewRevision };
        for (const item of page.items) if (item.effective && item.view === 'raw') {
            declaredMaterialBytes += item.objectRef.rawBytes;
            if (declaredMaterialBytes > maxMaterialBytes) throw new ProviderFault('E_CONTEXT_MATERIAL_LIMIT', '当前原生尾部达到有界读取上限，请先压缩或减少附件', { acceptance: 'not_sent' });
            items.push(item);
        }
        if (items.length > maxItems) throw new ProviderFault('E_CONTEXT_COMPACTION_REQUIRED', '当前原生尾部需要先完成有界压缩', { acceptance: 'not_sent' });
        cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
        if (page.hasMore && !cursor) throw new ProviderFault('E_CONTEXT_CURSOR', '历史页缺少有效继续游标', { acceptance: 'not_sent' });
    } while (cursor);
    let view: NativeSendView = { protocol: plan.adapter.protocol };
    const instruction = typeof context.conversationOptions.instructions === 'string' ? context.conversationOptions.instructions : '';
    if (instruction) {
        if (view.protocol === 'gemini') view.systemInstruction = { parts: [{ text: instruction }] };
        else if (view.protocol === 'anthropic') view.system = instruction;
        else if (view.protocol === 'openai_responses') view.input = [{ role: 'developer', content: instruction }];
        else view.messages = [{ role: 'system', content: instruction }];
    }
    let materialBytes = 0;
    const read = async (item: HistoryItem): Promise<JsonObject> => {
        materialBytes += item.objectRef.rawBytes;
        if (materialBytes > maxMaterialBytes) throw new ProviderFault('E_CONTEXT_MATERIAL_LIMIT', '当前原生尾部达到有界读取上限，请先压缩或减少附件', { acceptance: 'not_sent' });
        const value = objectValue(item.value ?? await context.readContent(item.contentId));
        if (!value) throw new ProviderFault('E_CONTEXT_SOURCE', '原生历史正文结构无效', { acceptance: 'not_sent' });
        return value;
    };
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const value = await read(item);
        if (item.role === 'user') { view = appendUser(view, inputText(value)); continue; }
        if (item.role !== 'assistant' || !objectValue(value.response)) {
            throw new ProviderFault('E_CONTEXT_NATIVE_PAIRING', '历史含尚未配对的原生结果', { acceptance: 'not_sent' });
        }
        const response = value.response as unknown as NormalizedResponse;
        if (item.providerProtocol !== plan.adapter.protocol || !response.complete || !Array.isArray(response.replayMessages)) {
            throw new ProviderFault('E_CONTEXT_PROTOCOL', '原生历史需要兼容协议或明确的语义分支', { acceptance: 'not_sent' });
        }
        if (response.blocks.some(block => block.thoughtSignature) && response.modelId !== plan.modelId) {
            throw new ProviderFault('E_CONTEXT_PROTOCOL', '带签名的原生历史需要原模型或明确的语义分支', { acceptance: 'not_sent' });
        }
        if (!response.toolCalls.length) { view = appendNative(view, response); continue; }
        const results: ToolResult[] = [];
        for (let count = 0; count < response.toolCalls.length; count++) {
            const resultItem = items[++index];
            if (!resultItem || resultItem.role !== 'tool' || resultItem.stepId !== item.stepId || resultItem.roundId !== item.roundId) {
                throw new ProviderFault('E_CONTEXT_NATIVE_PAIRING', '已记录的模型调用尚缺原工具结果，请先核原动作', { acceptance: 'not_sent' });
            }
            const result = (await read(resultItem)).result;
            if (!objectValue(result)) throw new ProviderFault('E_CONTEXT_NATIVE_PAIRING', '原工具结果结构无效', { acceptance: 'not_sent' });
            results.push(result as unknown as ToolResult);
        }
        if (!options.renderToolResults && results.some(hasMcpToolImageReferences)) throw new ProviderFault('E_TOOL_IMAGE_PIPELINE_REQUIRED', '工具图片引用尚未接入发送时原生渲染', {
            acceptance: 'not_sent', nativeCode: 'renderToolResults', nativeReason: '原生历史准备缺少renderToolResults hook',
        });
        const renderedResults = options.renderToolResults ? await options.renderToolResults(view, results) : results;
        view = plan.adapter.continueView(view, response, renderedResults);
    }
    if (!history) throw new ProviderFault('E_CONTEXT_SOURCE', '尚未取得已消费的原文', { acceptance: 'not_sent' });
    return { view, history, attachmentManifestHash: sha256('[]') };
}

export interface ProviderApprovalContinuationState {
    schemaVersion: 1;
    kind: 'provider_tool_approval';
    protocol: ProviderProtocol;
    profileId: string;
    profileRevision: number;
    modelId: string;
    rootBudgetId: string;
    modelCallsUsed: number;
    stepId: string;
    modelActionId: string;
    modelOperationId: string;
    modelContentId: string;
    response: NormalizedResponse;
    view: NativeSendView;
    results: ToolResult[];
    nextToolCallIndex: number;
    toolOperationIds: string[];
    toolActionIds?: string[];
    toolSchemaHashes: Record<string, string>;
    pendingToolId: string;
    published: JsonValue[];
    confirmedToolEffects?: ConfirmedToolEffect[];
}

export interface ConfirmedToolEffect {
    actionId: string;
    attemptId: string;
    stepId: string;
    toolName: string;
    receiptId: string;
    workspaceRevision: number;
    cleanupState: string | null;
}

function jsonCopy<Value>(value: Value): Value { return JSON.parse(canonicalJson(value)) as Value; }

function localPolicyError(result: ToolResult): JsonObject | undefined {
    const reply = objectValue(result.result);
    const error = objectValue(reply?.error);
    if (!error) return undefined;
    const details = objectValue(error?.details);
    return reply?.ok === false && error?.code !== 'APPROVAL_REQUIRED'
        && details?.localPolicyViolation === true && details.source === 'local' ? error : undefined;
}

function localPolicyFailure(error: unknown, context: BoundToolContext): ToolExecutionResult {
    if (!(error instanceof AgentFault) || error.code === 'APPROVAL_REQUIRED'
        || error.details?.localPolicyViolation !== true || error.details.source !== 'local') throw error;
    return { ok: false, error: { ...error.toJSON(), actionId: context.actionId, attemptId: context.attemptId } };
}

function continuationState(context: ExecutorContext): ProviderApprovalContinuationState | null {
    const continuation = context.continuation;
    if (!continuation) return null;
    const value = objectValue(continuation.state) as unknown as ProviderApprovalContinuationState | undefined;
    if (!value || value.schemaVersion !== 1 || value.kind !== 'provider_tool_approval'
        || value.stepId !== continuation.interaction.stepId || value.modelContentId !== continuation.interaction.modelContentId
        || value.protocol !== continuation.protocol || value.view?.protocol !== continuation.protocol
        || canonicalJson(value.response) !== canonicalJson(continuation.response)
        || !Number.isSafeInteger(value.modelCallsUsed) || value.modelCallsUsed < 1
        || !Array.isArray(value.results) || !Array.isArray(value.toolOperationIds) || !value.toolSchemaHashes
        || !Number.isSafeInteger(value.nextToolCallIndex) || value.nextToolCallIndex < 0
        || value.nextToolCallIndex >= continuation.response.toolCalls.length || value.results.length !== value.nextToolCallIndex
        || value.toolOperationIds.length !== continuation.response.toolCalls.length
        || value.toolOperationIds.some(operationId => typeof operationId !== 'string' || !operationId)
        || value.toolActionIds !== undefined && (!Array.isArray(value.toolActionIds)
            || value.toolActionIds.length !== continuation.response.toolCalls.length
            || value.toolActionIds.some(actionId => typeof actionId !== 'string' || !actionId)
            || value.toolActionIds[value.nextToolCallIndex] !== continuation.toolContext.actionId)
        || continuation.response.toolCalls[value.nextToolCallIndex]?.callId !== continuation.call.callId
        || value.pendingToolId !== continuation.interaction.pendingToolId
        || value.results.some((result, index) => result.callId !== continuation.response.toolCalls[index].callId || result.name !== continuation.response.toolCalls[index].name)
        || !Array.isArray(value.published)) throw new ProviderFault('E_APPROVAL_CONTINUATION_INVALID', '原批准调用的完整响应、发送视图或继续位置缺失，保留原动作供核对', { acceptance: 'accepted' });
    const restored = jsonCopy(value);
    restored.toolActionIds ??= restored.response.toolCalls.map((call, index) => index < restored.nextToolCallIndex ? call.callId
        : index === restored.nextToolCallIndex ? continuation.toolContext.actionId
        : scopedToolActionId({ runId: context.snapshot.runId, stepId: restored.stepId, attemptId: restored.response.attemptId, callId: call.callId }));
    return restored;
}

function assertFrozenToolCalls(state: ProviderApprovalContinuationState): void {
    const names = new Set((state.view.tools ?? []).map(tool => tool.name));
    for (const call of state.response.toolCalls) if (!names.has(call.name)) {
        throw new AgentFault('TOOL_NOT_ALLOWED', '工具调用名称未出现在本次冻结的模型请求工具表中', { name: call.name, stepId: state.stepId });
    }
}

export function createProviderExecutor(services: ExecutionServices): AgentExecutor {
    return { capabilities: { hardBudget: true, toolApprovalContinuation: true }, execute: async (context): Promise<ExecutorOutcome> => {
        let cleanupState: ExecutorOutcome['cleanupState'] = 'not_needed';
        let acceptance: Acceptance = 'not_sent';
        let currentActionId: string | undefined;
        let confirmedAttemptId: string | undefined;
        const published: JsonValue[] = [];
        const confirmedToolEffects: ConfirmedToolEffect[] = [];
        const rememberEffect = (result: ToolResult, stepId: string, attemptId: string, actionId: string): void => {
            const reply = objectValue(result.result);
            const data = objectValue(reply?.data);
            if (reply?.ok !== true || typeof data?.receiptId !== 'string' || !Number.isSafeInteger(data.workspaceRevision)) return;
            if (!confirmedToolEffects.some(effect => effect.actionId === actionId)) confirmedToolEffects.push({ actionId,
                attemptId, stepId, toolName: result.name, receiptId: data.receiptId, workspaceRevision: Number(data.workspaceRevision),
                cleanupState: typeof data.cleanupState === 'string' ? data.cleanupState : null });
        };
        let originalTurnOpen = Boolean(context.continuation);
        let activeToolContext: BoundToolContext | undefined;
        try {
            await context.checkpoint('preparing');
            const plan = await services.plan(context);
            assertChildExecutionBounds(context, plan);
            const trustedTools = async (identity: { stepId: string; actionId: string; attemptId: string }): Promise<BoundToolContext> => {
                const trusted = await services.toolContext(context, identity);
                if (trusted.conversationId !== context.snapshot.conversationId || trusted.runId !== context.snapshot.runId
                    || !trusted.principalId || !Number.isSafeInteger(trusted.policyRevision) || !trusted.retention) {
                    throw new ProviderFault('E_APPROVAL_CONTEXT_REQUIRED', '模型工具表需要核心绑定的主体、授权版本和保存方式', { acceptance: 'not_sent' });
                }
                const bound: BoundToolContext = { ...trusted, principalId: trusted.principalId,
                    rootRunId: trusted.rootRunId ?? String(context.snapshot.rootRunId ?? context.snapshot.runId),
                    roundId: trusted.roundId ?? context.snapshot.activeRoundId ?? context.snapshot.runId,
                    runEpoch: context.snapshot.runEpoch, policyRevision: trusted.policyRevision!, retention: trusted.retention,
                    ...identity, signal: AbortSignal.any([context.signal, trusted.signal]) };
                await bound.assertCurrent?.();
                if (bound.signal.aborted) throw new ProviderFault('E_CANCELLED', '模型工具表发布前已取消', { acceptance: 'not_sent' });
                return bound;
            };
            const currentTools = (trusted: BoundToolContext): { tools: FunctionTool[]; schemaHashes: Record<string, string> } => {
                const definitions = services.tools.modelFunctionSchemasFor(trusted)
                    .filter(schema => !DELEGATION_FUNCTION_SCHEMAS.some(delegated => delegated.name === schema.name) || canUseInternalDelegation(context))
                    .filter(schema => plan.toolNames === null || plan.toolNames.includes(schema.name))
                    .map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters as JsonObject }));
                const hashes = services.tools.modelSchemaHashesFor(trusted);
                return { tools: definitions, schemaHashes: Object.fromEntries(definitions.filter(tool => typeof hashes[tool.name] === 'string')
                    .map(tool => [tool.name, hashes[tool.name]])) };
            };
            let tools: FunctionTool[] = [];
            let toolSchemaHash = sha256(canonicalJson(tools));
            let toolSchemaHashes: Record<string, string> = {};
            let modelCallsUsed = 0;
            const bindTool = async (state: ProviderApprovalContinuationState, call: ToolCall): Promise<BoundToolContext> => {
                const actionId = state.toolActionIds?.[state.nextToolCallIndex];
                if (!actionId) throw new ProviderFault('E_TOOL_ACTION_IDENTITY_REQUIRED', '工具动作缺少已固定的内部身份', { acceptance: 'accepted' });
                const trusted = await services.toolContext(context, { stepId: state.stepId, actionId, attemptId: state.response.attemptId });
                if (trusted.conversationId !== context.snapshot.conversationId || trusted.runId !== context.snapshot.runId
                    || !trusted.principalId || !Number.isSafeInteger(trusted.policyRevision) || !trusted.retention) {
                    throw new ProviderFault('E_APPROVAL_CONTEXT_REQUIRED', '原工具调用需要核心绑定的主体、授权版本和保存方式', { acceptance: 'accepted' });
                }
                return { ...trusted, approvalId: undefined, pendingExecution: undefined,
                    principalId: trusted.principalId, rootRunId: trusted.rootRunId ?? String(context.snapshot.rootRunId ?? context.snapshot.runId),
                    roundId: trusted.roundId ?? context.snapshot.activeRoundId ?? context.snapshot.runId,
                    runEpoch: context.snapshot.runEpoch, policyRevision: trusted.policyRevision!, retention: trusted.retention,
                    stepId: state.stepId, actionId, attemptId: state.response.attemptId, callId: call.callId,
                    providerCallId: call.providerCallId, providerProtocol: state.protocol, modelContentId: state.modelContentId,
                    rootBudgetId: state.rootBudgetId, deadlineAt: trusted.deadlineAt ?? plan.deadlineAt,
                    toolSchemaHash: state.toolSchemaHashes[call.name], signal: AbortSignal.any([context.signal, trusted.signal]) };
            };
            const suspend = async (): Promise<'released' | 'not_needed' | 'unconfirmed'> => {
                const trusted = activeToolContext ?? await services.toolContext(context, { stepId: context.snapshot.activeStepId ?? context.snapshot.runId,
                    actionId: context.snapshot.runId, attemptId: confirmedAttemptId ?? context.snapshot.runId });
                return services.tools.suspendForApproval(trusted);
            };
            const pauseForLocalPolicy = async (state: ProviderApprovalContinuationState, refused: ToolResult): Promise<ExecutorOutcome> => {
                const error = localPolicyError(refused)!;
                const actionId = state.toolActionIds![state.nextToolCallIndex];
                const skippedToolCalls: string[] = [];
                for (let index = state.nextToolCallIndex + 1; index < state.response.toolCalls.length; index++) {
                    const call = state.response.toolCalls[index];
                    const skipped: ToolResult = { callId: call.callId, name: call.name, isError: true,
                        result: { ok: false, disposition: 'not_executed', error: { code: 'TOOL_NOT_EXECUTED',
                            message: '本机策略拒绝已暂停当前执行，该工具尚未执行', retryable: false, mayHaveStarted: false,
                            actionId: state.toolActionIds![index], attemptId: state.response.attemptId,
                            details: { source: 'local', blockedByCallId: refused.callId, stopReason: 'LOCAL_POLICY_REVIEW_REQUIRED' } } } };
                    await context.recordStep({ kind: 'tool', operationId: state.toolOperationIds[index], stepId: state.stepId,
                        originStepId: state.stepId, actionId: state.toolActionIds![index], protocol: state.protocol, result: skipped });
                    state.results.push(skipped);
                    skippedToolCalls.push(call.callId);
                }
                try { cleanupState = await suspend(); } catch { cleanupState = 'unconfirmed'; }
                originalTurnOpen = false;
                return { status: 'paused', stopReason: 'LOCAL_POLICY_REVIEW_REQUIRED',
                    effectState: error.mayHaveStarted === true ? 'unknown' : 'confirmed', cleanupState,
                    result: { source: 'local', localPolicyViolation: true, automaticRetry: false,
                        reason: typeof error.message === 'string' ? error.message : '本机策略禁止该动作，请交主调用方核对',
                        action: { toolName: refused.name, callId: refused.callId, actionId, stepId: state.stepId, attemptId: state.response.attemptId },
                        error: jsonCopy(error), toolResult: jsonCopy(refused) as unknown as JsonValue, skippedToolCalls,
                        confirmedToolEffects: jsonCopy(confirmedToolEffects) as unknown as JsonValue, artifacts: [...published] } };
            };
            const finishTurn = async (state: ProviderApprovalContinuationState, resumed: boolean): Promise<ExecutorOutcome | null> => {
                assertFrozenToolCalls(state);
                if ((context.conversationOptions.discussionOnly === true || context.conversationOptions.toolsEnabled === false)
                    && state.response.toolCalls.length) return { status: 'paused',
                    stopReason: context.conversationOptions.discussionOnly === true ? 'E_COUNCIL_TOOL_PENDING' : 'TOOLS_DISABLED',
                    effectState: 'confirmed', cleanupState: await services.release(context),
                    result: { attemptId: state.response.attemptId, artifacts: [...published] } };
                originalTurnOpen = true;
                currentActionId = state.modelActionId;
                confirmedAttemptId = state.response.attemptId;
                acceptance = 'accepted';
                await context.checkpoint('executing_tools', { stepId: state.stepId, actionId: state.modelActionId, attemptId: state.response.attemptId });
                if (resumed) {
                    const call = state.response.toolCalls[state.nextToolCallIndex];
                    activeToolContext = await bindTool(state, call);
                    currentActionId = activeToolContext.actionId;
                    let originalResult: ToolResult;
                    try {
                        const completion = await services.tools.resumePending(state.pendingToolId, activeToolContext);
                        if (!completion.ready || !completion.toolResult) return { status: 'outcome_unknown', stopReason: 'APPROVED_ACTION_RESULT_UNCONFIRMED',
                            effectState: 'unknown', cleanupState: await suspend() };
                        if (completion.origin.callId !== call.callId || completion.origin.stepId !== state.stepId
                            || completion.origin.actionId !== activeToolContext.actionId || completion.origin.attemptId !== state.response.attemptId
                            || completion.operationId !== state.toolOperationIds[state.nextToolCallIndex]) {
                            throw new ProviderFault('E_APPROVAL_CONTINUATION_INVALID', '原工具完成回执与冻结的配对身份不一致', { acceptance: 'accepted' });
                        }
                        originalResult = completion.toolResult;
                    } catch (error) {
                        originalResult = { callId: call.callId, name: call.name, isError: true,
                            result: jsonCopy(localPolicyFailure(error, activeToolContext)) as unknown as JsonValue };
                    }
                    const resumedResult = localPolicyError(originalResult) ? originalResult : await transformToolResult(services, context, plan, originalResult, {
                        stepId: state.stepId, actionId: activeToolContext.actionId, attemptId: state.response.attemptId, toolContext: activeToolContext,
                    });
                    rememberEffect(resumedResult, state.stepId, state.response.attemptId, activeToolContext.actionId);
                    await context.recordStep({ kind: 'tool', operationId: state.toolOperationIds[state.nextToolCallIndex], stepId: state.stepId,
                        originStepId: state.stepId, actionId: activeToolContext.actionId, protocol: state.protocol, result: resumedResult });
                    state.results.push(resumedResult);
                    if (localPolicyError(resumedResult)) return pauseForLocalPolicy(state, resumedResult);
                    state.nextToolCallIndex++;
                }
                for (; state.nextToolCallIndex < state.response.toolCalls.length; state.nextToolCallIndex++) {
                    if (context.signal.aborted) throw new ProviderFault('E_CANCELLED', '工具执行前已取消', { acceptance: 'not_sent' });
                    const call = state.response.toolCalls[state.nextToolCallIndex];
                    activeToolContext = await bindTool(state, call);
                    currentActionId = activeToolContext.actionId;
                    const internal = DELEGATION_FUNCTION_SCHEMAS.some(schema => schema.name === call.name || `local.${schema.name}` === call.name);
                    const allowedInternal = canUseInternalDelegation(context) && state.view.tools?.some(schema => schema.name === call.name);
                    let result: ToolExecutionResult;
                    try {
                        result = internal && !allowedInternal
                            ? { ok: false, error: { ...new AgentFault('CHILD_AGENTS_DISABLED', '该请求未向模型开放内部派发工具').toJSON(),
                                actionId: activeToolContext.actionId, attemptId: state.response.attemptId } }
                            : await services.tools.execute(call.name, call.arguments, activeToolContext);
                    } catch (error) { result = localPolicyFailure(error, activeToolContext); }
                    if (result.disposition === 'awaiting_approval' || result.error?.code === 'APPROVAL_REQUIRED') {
                        if (!result.approval?.pendingToolId || !result.pendingTool) throw new ProviderFault('E_APPROVAL_CONTINUATION_REQUIRED', '批准待办缺少已冻结的原工具动作', { acceptance: 'accepted' });
                        state.pendingToolId = result.pendingTool.pendingToolId;
                        state.toolOperationIds[state.nextToolCallIndex] = `pending-tool-completion:${state.pendingToolId}`;
                        state.published = [...published];
                        state.confirmedToolEffects = jsonCopy(confirmedToolEffects);
                        const { signal: discardedSignal, assertCurrent: discardedCurrent, ...identity } = activeToolContext;
                        const interaction = await context.requestApproval({ operationId: `approval:${state.pendingToolId}`, approval: result.approval,
                            stepId: state.stepId, callId: call.callId, toolContext: jsonCopy(identity) as ApprovalToolIdentity,
                            state: jsonCopy(state) as unknown as JsonValue });
                        return { status: 'paused', stopReason: 'APPROVAL_REQUIRED', effectState: 'confirmed', cleanupState: await suspend(),
                            result: { interactionId: interaction.interactionId, pendingToolId: state.pendingToolId,
                                pendingApprovals: [jsonCopy(result.approval) as unknown as JsonValue] } };
                    }
                    const originalResult: ToolResult = {
                        callId: call.callId, name: call.name, result: jsonCopy(result) as unknown as JsonValue, isError: !result.ok,
                    };
                    const normalized = localPolicyError(originalResult) ? originalResult : await transformToolResult(services, context, plan, originalResult,
                        { stepId: state.stepId, actionId: activeToolContext.actionId, attemptId: state.response.attemptId, toolContext: activeToolContext });
                    rememberEffect(normalized, state.stepId, state.response.attemptId, activeToolContext.actionId);
                    await context.recordStep({ kind: 'tool', operationId: state.toolOperationIds[state.nextToolCallIndex], stepId: state.stepId,
                        originStepId: state.stepId, actionId: activeToolContext.actionId, protocol: state.protocol, result: normalized });
                    state.results.push(normalized);
                    if (localPolicyError(normalized)) return pauseForLocalPolicy(state, normalized);
                    if (result.error?.mayHaveStarted) return { status: 'outcome_unknown', stopReason: result.error.code,
                        effectState: 'unknown', cleanupState: await suspend() };
                }
                originalTurnOpen = false;
                if (state.protocol !== plan.adapter.protocol || state.modelId !== plan.modelId || state.profileId !== plan.profile.profileId
                    || state.profileRevision !== plan.profile.revision || state.rootBudgetId !== plan.rootBudgetId) {
                    return { status: 'paused', stopReason: 'CONTINUATION_PLAN_CHANGED', effectState: 'confirmed', cleanupState: await services.release(context) };
                }
                appendNativeHistoryView(plan.adapter, state.view, state.response,
                    await renderToolResults(services, context, plan, state.view, state.results));
                currentActionId = undefined;
                confirmedAttemptId = undefined;
                acceptance = 'not_sent';
                await context.checkpoint('preparing', { actionId: null, attemptId: null });
                await services.postStep?.(context, plan, { tools });
                return null;
            };
            const restored = continuationState(context);
            if (restored) {
                tools = jsonCopy(restored.view.tools ?? []);
                confirmedToolEffects.push(...jsonCopy(restored.confirmedToolEffects ?? []));
                restored.results.forEach((result, index) => rememberEffect(result, restored.stepId, restored.response.attemptId, restored.toolActionIds![index]));
                published.push(...restored.published);
                modelCallsUsed = restored.modelCallsUsed;
                const waiting = await finishTurn(restored, true);
                if (waiting) return waiting;
            }
            for (; modelCallsUsed < plan.maxModelCalls;) {
                acceptance = 'not_sent';
                currentActionId = undefined;
                confirmedAttemptId = undefined;
                await context.checkpoint('preparing', { actionId: null, attemptId: null });
                if (context.signal.aborted) throw new ProviderFault('E_CANCELLED', '执行已取消', { acceptance: 'not_sent' });
                await context.takeSteering();
                const stepId = randomUUID();
                const actionId = randomUUID();
                const toolsDisabled = context.conversationOptions.discussionOnly === true || context.conversationOptions.toolsEnabled === false
                    || plan.toolNames?.length === 0;
                const selectedTools = toolsDisabled ? { tools: [], schemaHashes: {} }
                    : currentTools(await trustedTools({ stepId, actionId, attemptId: actionId }));
                tools = selectedTools.tools;
                toolSchemaHash = sha256(canonicalJson(tools));
                toolSchemaHashes = selectedTools.schemaHashes;
                const prepared = services.prepareView ? await services.prepareView(context, plan, { tools }) : await prepareNativeHistory(context, plan, {
                    renderToolResults: (view, results) => renderToolResults(services, context, plan, view, results),
                });
                const view: NativeSendView = { ...prepared.view, tools };
                const head = prepared.history;
                currentActionId = actionId;
                await context.checkpoint('preparing', { stepId, actionId, attemptId: null });
                const preparedRequest = await services.prepareRequest(context, plan, { view,
                    versions: { conversationId: context.snapshot.conversationId, runId: context.snapshot.runId,
                        roundId: context.snapshot.activeRoundId, stepId, actionId, runEpoch: context.snapshot.runEpoch,
                        historyEpoch: head.historyEpoch, appendSeq: head.appendSeq, viewRevision: head.viewRevision,
                        workspaceRevision: Number(context.snapshot.workspaceRevision ?? 0), toolSchemaHash,
                        skillVersions: prepared.skillVersions ?? {},
                        ...(prepared.ruleVersions === undefined ? {} : { ruleVersions: prepared.ruleVersions }),
                        ...(prepared.instructionPrefixHash === undefined ? {} : { instructionPrefixHash: prepared.instructionPrefixHash }),
                        attachmentManifestHash: prepared.attachmentManifestHash,
                        nativeReplayHash: sha256(canonicalJson(view)) } });
                await context.checkpoint('awaiting_response', { stepId, actionId, modelId: plan.modelId, profileId: plan.profile.profileId });
                const response = await services.dispatcher.execute(preparedRequest.adapter, preparedRequest.snapshot, plan.rootBudgetId,
                    preparedRequest.upperBound, { signal: context.signal });
                modelCallsUsed++;
                acceptance = 'accepted';
                confirmedAttemptId = response.attemptId;
                const modelReceipt = await context.recordStep({ kind: 'model', operationId: `model:${response.attemptId}`, stepId, actionId,
                    protocol: plan.adapter.protocol, response });
                published.push(...await services.publish(context, response));
                if (!response.complete) return { status: 'outcome_unknown', stopReason: 'PROVIDER_PARTIAL_RESPONSE',
                    effectState: 'unknown', cleanupState: await services.release(context) };
                if (!response.toolCalls.length) {
                    const text = response.blocks.filter(block => block.type === 'text' && !block.thought).map(block => block.text ?? '').join('\n');
                    const succeeded = response.stop.kind === 'completed';
                    return { status: succeeded ? 'succeeded' : 'paused', stopReason: succeeded ? undefined : `PROVIDER_${response.stop.kind.toUpperCase()}`,
                        effectState: 'confirmed', cleanupState: await services.release(context),
                        result: { text, artifacts: published, attemptId: response.attemptId, modelId: response.modelId, stop: response.stop.kind } };
                }
                if (!response.canExecuteTools) return { status: 'paused', stopReason: 'MODEL_TOOL_COMMIT_NOT_CONFIRMED',
                    effectState: 'confirmed', cleanupState: await services.release(context) };
                const waiting = await finishTurn({ schemaVersion: 1, kind: 'provider_tool_approval', protocol: plan.adapter.protocol,
                    profileId: plan.profile.profileId, profileRevision: plan.profile.revision, modelId: plan.modelId, rootBudgetId: plan.rootBudgetId,
                    modelCallsUsed, stepId, modelActionId: actionId, modelOperationId: `model:${response.attemptId}`, modelContentId: modelReceipt.contentId,
                    response: jsonCopy(response), view: jsonCopy(view), results: [], nextToolCallIndex: 0,
                    toolOperationIds: response.toolCalls.map(call => `tool:${response.attemptId}:${call.callId}`), toolSchemaHashes: { ...toolSchemaHashes },
                    toolActionIds: response.toolCalls.map(call => scopedToolActionId({ runId: context.snapshot.runId, stepId, attemptId: response.attemptId, callId: call.callId })),
                    pendingToolId: '', published: [...published] }, false);
                if (waiting) return waiting;
            }
            return { status: 'paused', stopReason: 'MODEL_CALL_LIMIT', effectState: 'confirmed', cleanupState: await services.release(context) };
        } catch (error) {
            try {
                if (originalTurnOpen) {
                    const trusted = activeToolContext ?? await services.toolContext(context, { stepId: context.snapshot.activeStepId ?? context.snapshot.runId,
                        actionId: context.snapshot.runId, attemptId: confirmedAttemptId ?? context.snapshot.runId });
                    cleanupState = await services.tools.suspendForApproval(trusted);
                } else cleanupState = await services.release(context);
            } catch { cleanupState = 'unconfirmed'; }
            if (cleanupState === 'unconfirmed') return { status: 'outcome_unknown', stopReason: error instanceof AgentFault ? error.code : 'EXECUTION_ERROR',
                effectState: 'unknown', cleanupState };
            if (error instanceof AgentFault) {
                const currentAcceptance = error instanceof ProviderFault ? error.acceptance : error.mayHaveStarted ? 'unknown' : acceptance;
                const releasedEffects = confirmedToolEffects.some(effect => effect.cleanupState === 'released');
                const facts = { acceptance: currentAcceptance, cleanupEvidence: cleanupState === 'released' || releasedEffects ? 'resources_released' as const : 'no_resources_created' as const,
                    actionId: currentActionId ?? null, attemptId: confirmedAttemptId ?? null };
                if (confirmedToolEffects.length && ['not_sent', 'rejected'].includes(currentAcceptance)) {
                    const detail = { ...error.toJSON(), ...(currentActionId ? { actionId: currentActionId } : {}),
                        ...(confirmedAttemptId ? { attemptId: confirmedAttemptId } : {}),
                        details: { ...error.details, executionProgress: { schemaVersion: 1, confirmedToolEffects: jsonCopy(confirmedToolEffects),
                            currentOperation: { actionId: facts.actionId, attemptId: facts.attemptId, acceptance: currentAcceptance } } } };
                    return { status: context.signal.aborted ? 'paused' : 'failed', stopReason: error.code, effectState: 'confirmed',
                        cleanupState: releasedEffects ? 'released' : cleanupState, failure: { ...facts, error: detail } };
                }
                throw new ExecutorFailure(error, facts);
            }
            throw error;
        }
    } };
}
