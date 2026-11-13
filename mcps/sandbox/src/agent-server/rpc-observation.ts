import { AgentFault, METHOD_SPECS, canonicalJson, failure, readBatchItemSchema, validateParams } from './protocol.js';
import type { AgentEvent, ClientIdentity, RpcResult } from './protocol.js';
import type { RunData } from './runtime.js';
import { isTerminal } from './state-machine.js';
import { failureArtifactReference } from './rpc-failure-artifact.js';

const batchReadMethods = new Set([
    'server.info', 'server.getReceipt', 'server.readCommandResult',
    'conversations.get', 'conversations.list', 'conversations.readHistory', 'conversations.readArtifact',
    'conversations.listArtifacts', 'conversations.context', 'conversations.export',
    'runs.get', 'runs.list', 'runs.observe', 'inputs.list', 'events.read',
    'profiles.list', 'profiles.get', 'models.list', 'models.get', 'budgets.get',
]);

function bytes(value: unknown): number { return Buffer.byteLength(canonicalJson(value)); }

export async function readBatch(params: Record<string, unknown>, client: ClientIdentity,
    dispatch: (method: string, params: Record<string, unknown>) => Promise<RpcResult>): Promise<RpcResult> {
    if (!client?.principalId || typeof client.principalId !== 'string' || !client.clientId || typeof client.clientId !== 'string') {
        throw new AgentFault('AUTH_FAILED', '缺少可信客户端身份');
    }
    params = validateParams('server.readBatch', params);
    const requests = params.requests as unknown[];
    const maxBytes = Number(params.maxBytes ?? 256 * 1024);
    const results: { index: number; method: string | null; result: RpcResult }[] = [];
    const data = { results, source: 'read_dispatch', observedAt: new Date().toISOString() };
    for (const [index, raw] of requests.entries()) {
        let method: string | null = null;
        let result: RpcResult;
        const available = maxBytes - bytes({ ok: true, data }) - (requests.length - index) * 1024;
        try {
            const parsed = readBatchItemSchema.safeParse(raw);
            if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '批量项目须包含method及可选params', { index });
            method = parsed.data.method;
            if (!batchReadMethods.has(method) || !Object.hasOwn(METHOD_SPECS, method) || METHOD_SPECS[method].writes) {
                throw new AgentFault('READ_BATCH_METHOD_NOT_ALLOWED', '批量查询仅接纳明确只读方法，写入、控制和递归批量须单独调用', { method });
            }
            const query = validateParams(method, parsed.data.params ?? {});
            if (method === 'events.read' && Number(query.waitMs ?? 0) !== 0) {
                throw new AgentFault('READ_BATCH_METHOD_NOT_ALLOWED', '批量事件读取不接受长等待');
            }
            if (available < 1) throw new AgentFault('READ_BATCH_BUDGET_EXHAUSTED', '本次批量返回预算已用尽，请单独读取该项目');
            if (['events.read', 'conversations.readHistory', 'conversations.readArtifact',
                'conversations.listArtifacts', 'runs.observe', 'conversations.export'].includes(method)) {
                if ((method === 'runs.observe' || method === 'conversations.export') && available < 4096) {
                    throw new AgentFault('READ_BATCH_BUDGET_EXHAUSTED', '剩余预算不足以读取该项目，请单独读取');
                }
                query.maxBytes = Math.min(Number(query.maxBytes ?? 64 * 1024), available);
            }
            canonicalJson(query);
            result = await dispatch(method, query);
            if (bytes({ index, method, result }) > available) throw new AgentFault('READ_BATCH_ITEM_TOO_LARGE',
                '该项目超过本次批量预算，请通过原方法分页读取', { method, requiredBytes: bytes(result) });
        } catch (error) { result = failure(error); }
        results.push({ index, method, result });
    }
    const result = { ok: true, data };
    if (bytes(result) > maxBytes) throw new AgentFault('FRAME_TOO_LARGE', '批量项目错误信息超过返回预算，请减少项目数');
    return result;
}

export interface RunObservation {
    run: RunData & { revision: number };
    visibleText: string;
    textMode: 'delta' | 'result';
    textSource: 'run.progress' | 'executor_result' | 'none';
    textThroughCursor: string;
    events: AgentEvent[];
    snapshotCursor: string;
    nextCursor: string;
    hasMore: boolean;
    partial: boolean;
    final: boolean;
    source: 'runtime_event_log';
    observedAt: string;
    updatedAt: string;
    resultRef: { method: 'conversations.readArtifact'; conversationId: string; artifactId: string } | null;
    failureArtifact: ReturnType<typeof failureArtifactReference> | null;
}

export function runObservation(input: {
    run: RunObservation['run']; events: AgentEvent[]; snapshotCursor: string; nextCursor: string;
    hasMore: boolean; observedAt: string; resultText?: string; resultPartial?: boolean;
}): RunObservation {
    const { run, events, snapshotCursor, nextCursor, hasMore, observedAt } = input;
    const final = isTerminal(run) && run.effectState !== 'unknown' && run.resultStatus !== 'unknown';
    const deltas = events.filter(event => event.runId === run.runId && event.type === 'run.progress')
        .map(event => event.payload.partial as { textDelta?: unknown } | undefined)
        .map(partial => typeof partial?.textDelta === 'string' ? partial.textDelta : '').join('');
    const resultVisible = input.resultText !== undefined;
    return { run, visibleText: resultVisible ? input.resultText! : deltas,
        textMode: resultVisible ? 'result' : 'delta', textSource: resultVisible ? 'executor_result' : deltas ? 'run.progress' : 'none',
        textThroughCursor: resultVisible ? snapshotCursor : nextCursor, events, snapshotCursor, nextCursor, hasMore,
        partial: !final || hasMore || Boolean(input.resultPartial), final, source: 'runtime_event_log', observedAt,
        updatedAt: run.updatedAt, resultRef: run.resultContentId ? { method: 'conversations.readArtifact',
            conversationId: run.conversationId, artifactId: run.resultContentId } : null,
        failureArtifact: run.failure?.attemptId ? failureArtifactReference(run.conversationId, run.failure.attemptId) : null };
}

export function observationBytes(value: unknown): number { return bytes(value); }

export interface FinalContextSnapshot {
    source: 'context_service';
    capturedAt: string;
    eventCursor: string;
    partial: boolean;
    status: Record<string, unknown>;
}

export function finalContextSnapshot(status: Record<string, unknown>, capturedAt: string, eventCursor: string): FinalContextSnapshot {
    if (bytes(status) <= 64 * 1024) return { source: 'context_service', capturedAt, eventCursor, partial: status.snapshotUnavailable === true, status };
    const history = status.history;
    return { source: 'context_service', capturedAt, eventCursor, partial: true,
        status: { conversationId: status.conversationId, history, estimateConfidence: status.estimateConfidence,
            execution: status.execution, cleanupExecution: status.cleanupExecution,
            unavailable: { code: 'FINAL_CONTEXT_TRUNCATED', message: '最终上下文状态超过保存预算，历史水位和原文读取入口继续保留' } } };
}
