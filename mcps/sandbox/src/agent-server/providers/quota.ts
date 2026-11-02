import { ProviderFault } from './types.js';

export interface QuotaScheduler {
    run<Value>(quotaScopeId: string, execute: () => Promise<Value>, options: { signal?: AbortSignal; deadlineAt: string }): Promise<Value>;
}

interface Waiter {
    resume(): void;
    cancel(): void;
}

interface QuotaGroup { active: number; queue: Waiter[] }

export class QuotaScopeScheduler implements QuotaScheduler {
    private readonly groups = new Map<string, QuotaGroup>();
    constructor(readonly concurrency = 2) {
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('quota concurrency must be a positive integer');
    }

    async run<Value>(quotaScopeId: string, execute: () => Promise<Value>, options: { signal?: AbortSignal; deadlineAt: string }): Promise<Value> {
        if (!quotaScopeId) throw new ProviderFault('E_QUOTA_SCOPE', '模型调用缺少真实配额分组身份', { acceptance: 'not_sent' });
        const remaining = Date.parse(options.deadlineAt) - Date.now();
        if (options.signal?.aborted || !Number.isFinite(remaining) || remaining <= 0) {
            throw new ProviderFault(options.signal?.aborted ? 'E_CANCELLED' : 'E_DEADLINE', '请求在配额排队前已取消或到期', { acceptance: 'not_sent' });
        }
        const group = this.groups.get(quotaScopeId) ?? { active: 0, queue: [] };
        this.groups.set(quotaScopeId, group);
        if (group.active >= this.concurrency || group.queue.length) {
            await new Promise<void>((resolve, reject) => {
                let waiting = true;
                const clean = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', waiter.cancel); };
                const waiter: Waiter = {
                    resume: () => {
                        if (!waiting) return;
                        waiting = false;
                        clean();
                        resolve();
                    },
                    cancel: () => {
                        if (!waiting) return;
                        waiting = false;
                        clean();
                        const index = group.queue.indexOf(waiter);
                        if (index >= 0) group.queue.splice(index, 1);
                        if (!group.active && !group.queue.length) this.groups.delete(quotaScopeId);
                        reject(new ProviderFault(options.signal?.aborted ? 'E_CANCELLED' : 'E_DEADLINE', '配额等待期间已取消或到期', { acceptance: 'not_sent' }));
                    },
                };
                const timer = setTimeout(waiter.cancel, Math.min(remaining, 2_147_483_647));
                options.signal?.addEventListener('abort', waiter.cancel, { once: true });
                group.queue.push(waiter);
            });
        } else group.active++;
        try {
            if (options.signal?.aborted || Date.parse(options.deadlineAt) <= Date.now()) {
                throw new ProviderFault(options.signal?.aborted ? 'E_CANCELLED' : 'E_DEADLINE', '请求在配额等待结束时已取消或到期', { acceptance: 'not_sent' });
            }
            return await execute();
        }
        finally {
            group.active--;
            const next = group.queue.shift();
            if (next) { group.active++; next.resume(); }
            else if (!group.active) this.groups.delete(quotaScopeId);
        }
    }
}

export const sharedQuotaScheduler = new QuotaScopeScheduler();
