import { AgentFault } from '../protocol.js';
import type { AgentError } from '../protocol.js';
import type { UpperBound } from '../accounting/budget-ledger.js';
import type { NormalizedUsage } from '../accounting/usage.js';
import { freezeOwned, prepareAttempt } from './assemble.js';
import { attemptTimeout, safeTransportCause } from './http.js';
import { ProviderFault } from './types.js';
import { sharedQuotaScheduler } from './quota.js';
import { failureHasExecutionEvidence } from './failure-accounting.js';
import type { QuotaScheduler } from './quota.js';
import type { Acceptance, HttpTransport, LookupResult, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderPartial, RawProviderResponse, RequestSnapshot } from './types.js';

export interface RecordedFailure {
    error: AgentError;
    acceptance: Acceptance;
    rawResponse?: RawProviderResponse;
    partialResponse?: NormalizedResponse;
    usage?: NormalizedUsage;
}

export type PreparedDispatch = { status: 'send' } | { status: 'committed'; response: NormalizedResponse }
    | { status: 'unknown' | 'already_dispatching' | 'rejected' };

export interface DispatchJournalPort {
    prepareAttempt(attempt: ProviderAttempt, upperBound: UpperBound): Promise<PreparedDispatch>;
    commitResponse(attempt: ProviderAttempt, response: NormalizedResponse): Promise<{ canExecuteTools: boolean }>;
    recordFailure(attempt: ProviderAttempt, failure: RecordedFailure): Promise<void>;
    recordPartial?(attempt: ProviderAttempt, partial: ProviderPartial): Promise<void>;
}

export interface CredentialAccess {
    withCredential<Value>(credentialRef: string, generation: number, use: (credential: string) => Promise<Value>): Promise<Value>;
}

export interface DispatchOptions {
    journal: DispatchJournalPort;
    transport: HttpTransport;
    credentials?: CredentialAccess;
    maxAttempts?: number;
    random?: () => number;
    now?: () => number;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    quotaScheduler?: QuotaScheduler;
    onPartial?: (attempt: ProviderAttempt, partial: ProviderPartial) => void | Promise<void>;
}

export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ProviderFault('E_CANCELLED', '等待期间已取消', { acceptance: 'not_sent' }));
    return new Promise((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
            reject(new ProviderFault('E_CANCELLED', '等待期间已取消', { acceptance: 'not_sent' })); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function asProviderFault(error: unknown): ProviderFault {
    if (error instanceof ProviderFault) return error;
    return new ProviderFault('E_RESULT_UNKNOWN', '本次请求未取得可确认的完整结果，保留原尝试及费用预留',
        { acceptance: 'unknown', phase: 'dispatching', transportCause: safeTransportCause(error) });
}

function routeChecked(snapshot: RequestSnapshot, response: NormalizedResponse): NormalizedResponse {
    const policy = snapshot.profile.routePolicy;
    const wrongModel = response.modelId !== null && !policy.allowedModels.includes(response.modelId);
    const wrongRoute = response.routeId !== null && policy.allowedRoutes.length > 0 && !policy.allowedRoutes.includes(response.routeId);
    const unverifiedAggregator = policy.kind === 'pinned_aggregator' && response.routeId === null;
    if (!wrongModel && !wrongRoute && !unverifiedAggregator) return response;
    return freezeOwned({ ...response, canExecuteTools: false, stop: { ...response.stop, kind: 'unknown' },
        problems: [...response.problems, 'E_ROUTE_MISMATCH'] });
}

export class ProviderDispatcher {
    private readonly now: () => number;
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    private readonly maxAttempts: number;

    constructor(private readonly options: DispatchOptions) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? abortableSleep;
        this.maxAttempts = options.maxAttempts ?? 3;
        if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 3) {
            throw new AgentFault('E_ATTEMPT_LIMIT', '同一动作提交上限必须为一至三次');
        }
    }

    async execute(adapter: ProviderAdapter, snapshot: RequestSnapshot, rootBudgetId: string, upperBound: UpperBound,
        options: { signal?: AbortSignal; attemptId?: string;
            onPartial?: (attempt: ProviderAttempt, partial: ProviderPartial) => void | Promise<void> } = {}): Promise<NormalizedResponse> {
        adapter.validate(snapshot);
        return (this.options.quotaScheduler ?? sharedQuotaScheduler).run(snapshot.profile.quotaScopeId,
            () => this.executeWithinQuota(adapter, snapshot, rootBudgetId, upperBound, options),
            { signal: options.signal, deadlineAt: snapshot.deadlineAt });
    }

    private async executeWithinQuota(adapter: ProviderAdapter, snapshot: RequestSnapshot, rootBudgetId: string, upperBound: UpperBound,
        options: { signal?: AbortSignal; attemptId?: string;
            onPartial?: (attempt: ProviderAttempt, partial: ProviderPartial) => void | Promise<void> }): Promise<NormalizedResponse> {
        adapter.validate(snapshot);
        for (let index = 0; index < this.maxAttempts; index++) {
            const attempt = prepareAttempt(snapshot, rootBudgetId, index === 0 ? options.attemptId : undefined);
            if (options.signal?.aborted) throw new ProviderFault('E_CANCELLED', '请求发送前已取消', { acceptance: 'not_sent' });
            attemptTimeout(attempt, this.now());
            const prepared = await this.options.journal.prepareAttempt(attempt, upperBound);
            if (prepared.status === 'committed') return freezeOwned({ ...prepared.response, canExecuteTools: false });
            if (prepared.status !== 'send') {
                throw new ProviderFault('E_RESULT_UNKNOWN', '该尝试已有执行记录，先查询原结果', { acceptance: 'unknown' });
            }
            let response: NormalizedResponse;
            let adapterEntered = false;
            let transportEntered = false;
            const trackedTransport: HttpTransport = { request: (request, signal) => {
                transportEntered = true;
                return this.options.transport.request(request, signal);
            } };
            try {
                const send = async (credential?: string): Promise<NormalizedResponse> => {
                    if (options.signal?.aborted) throw new ProviderFault('E_CANCELLED', '请求发送前已取消', { acceptance: 'not_sent' });
                    attemptTimeout(attempt, this.now());
                    const expiry = upperBound.expiresAt ?? snapshot.pricingSnapshot?.expiresAt ?? snapshot.price?.expiresAt;
                    if (expiry && Date.parse(expiry) <= this.now()) throw new ProviderFault('E_PRICE_UNKNOWN', '实际发送前费用上界已过期', { acceptance: 'not_sent' });
                    adapterEntered = true;
                    return adapter.send(attempt, { transport: trackedTransport, credential, onPartial: async partial => {
                        await this.options.journal.recordPartial?.(attempt, partial);
                        await options.onPartial?.(attempt, partial);
                        await this.options.onPartial?.(attempt, partial);
                    } }, options.signal);
                };
                const profile = snapshot.profile;
                if (profile.credentialRef) {
                    if (!this.options.credentials) throw new ProviderFault('E_SECRET_BACKEND', '未提供受保护的凭据读取端口', { acceptance: 'not_sent' });
                    response = await this.options.credentials.withCredential(profile.credentialRef, snapshot.credentialGeneration, send);
                } else response = await send();
            } catch (error) {
                const fault = error instanceof ProviderFault ? error : !transportEntered
                    ? new ProviderFault(error instanceof AgentFault ? error.code : adapterEntered ? 'E_TRANSPORT_UNSENT' : 'E_SECRET_BACKEND', '请求发送前的准备未完成',
                        { acceptance: 'not_sent', phase: 'prepared', transportPhase: 'preflight', transportCause: safeTransportCause(error) })
                    : asProviderFault(error);
                await this.options.journal.recordFailure(attempt, { error: { ...fault.toJSON(), actionId: snapshot.actionId, attemptId: attempt.attemptId },
                    acceptance: fault.acceptance, ...(fault.rawResponse ? { rawResponse: fault.rawResponse } : {}),
                    ...(fault.partialResponse ? { partialResponse: fault.partialResponse } : {}), ...(fault.usage ? { usage: fault.usage } : {}) });
                const retryable = ['not_sent', 'rejected'].includes(fault.acceptance) && fault.retryable && !failureHasExecutionEvidence(fault)
                    && ['E_RATE_LIMIT', 'E_PROVIDER_TEMPORARY', 'E_TRANSPORT_UNSENT'].includes(fault.code) && index + 1 < this.maxAttempts;
                if (!retryable) throw fault;
                const random = this.options.random?.() ?? Math.random();
                const jitter = Math.floor(Math.max(0, Math.min(1, random)) * Math.min(30_000, 1000 * 2 ** index));
                const wait = Math.max(jitter, fault.retryAfterMs ?? 0);
                if (this.now() + wait >= Date.parse(snapshot.deadlineAt)) {
                    throw new ProviderFault('E_RETRY_DEADLINE', '退避等待超过原请求期限，停止新增尝试', { acceptance: 'not_sent' });
                }
                await this.sleep(wait, options.signal);
                continue;
            }
            response = routeChecked(snapshot, response);
            try {
                const committed = await this.options.journal.commitResponse(attempt, response);
                return freezeOwned({ ...response, canExecuteTools: response.canExecuteTools && committed.canExecuteTools
                    && !options.signal?.aborted });
            } catch {
                const fault = new ProviderFault('E_COMMIT_UNKNOWN', '远端结果已收到，本地提交尚未确认，保留原尝试并停止工具执行', { acceptance: 'accepted' });
                await this.options.journal.recordFailure(attempt, { error: { ...fault.toJSON(), attemptId: attempt.attemptId, actionId: snapshot.actionId }, acceptance: 'accepted', rawResponse: response.raw });
                throw fault;
            }
        }
        throw new AgentFault('E_ATTEMPT_LIMIT', '本动作已达到提交上限');
    }

    async lookup(adapter: ProviderAdapter, attempt: ProviderAttempt, signal?: AbortSignal,
        options: { providerResponseId?: string } = {}): Promise<LookupResult> {
        const waits = [2000, 5000, 15_000];
        const query = async (): Promise<LookupResult> => {
            const lookup = async (credential?: string): Promise<LookupResult> => adapter.lookup({ attemptId: attempt.attemptId,
                ...(options.providerResponseId ? { providerResponseId: options.providerResponseId } : {}), snapshot: attempt.snapshot },
            { transport: this.options.transport, credential }, signal);
            if (!attempt.snapshot.profile.credentialRef) return lookup();
            if (!this.options.credentials) throw new ProviderFault('E_SECRET_BACKEND', '原结果查询缺少受保护凭据端口', { acceptance: 'not_sent' });
            return this.options.credentials.withCredential(attempt.snapshot.profile.credentialRef, attempt.snapshot.credentialGeneration, lookup);
        };
        let result = await query();
        for (const wait of waits) {
            if (result.status !== 'pending') return result.status === 'found'
                ? { status: 'found', response: routeChecked(attempt.snapshot, result.response) } : result;
            if (this.now() + wait >= Date.parse(attempt.snapshot.deadlineAt)) break;
            await this.sleep(wait, signal);
            result = await query();
        }
        return result.status === 'found' ? { status: 'found', response: routeChecked(attempt.snapshot, result.response) } : result;
    }
}
