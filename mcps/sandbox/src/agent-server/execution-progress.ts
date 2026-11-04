import { AgentFault } from './protocol.js';
import type { ExecutorContext } from './runtime.js';
import type { ProviderAttempt, ProviderPartial } from './providers/types.js';

export function createExecutionProgress(context: Pick<ExecutorContext, 'checkpoint' | 'assertCurrent' | 'signal'>,
    identity: { stepId: string; actionId: string }) {
    let attemptId: string | undefined;
    let sequence = -1;
    let pending: { seq: number; textDelta: string; receivedAt: string } | undefined;
    let writtenAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue: Promise<void> = Promise.resolve();
    let stateFailure: unknown;
    let disabled = false;
    let closed = false;
    const seenAttempts = new Set<string>();
    const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    const serial = (operation: () => Promise<void>): Promise<void> => {
        const result = queue.then(async () => {
            if (stateFailure) throw stateFailure;
            await operation();
        });
        queue = result.catch(error => { stateFailure = error; });
        return result;
    };
    const remaining = (): number => Math.max(0, writtenAt + (pending?.textDelta ? 100 : 1000) - performance.now());
    const flushPending = async (): Promise<void> => {
        clearTimer();
        if (!pending || disabled || closed) return;
        const delay = remaining();
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.ceil(delay)));
        if (context.signal.aborted) throw new AgentFault('INVALID_STATE', '流式进度所属执行已经停止');
        const partial = pending;
        pending = undefined;
        writtenAt = performance.now();
        try {
            await context.checkpoint('streaming', { ...identity, attemptId, partial });
        } catch (error) {
            if (context.signal.aborted) throw new AgentFault('INVALID_STATE', '流式进度所属执行已经停止');
            const stale = (failure: unknown): boolean => failure instanceof AgentFault
                && ['STALE_RUN_EPOCH', 'INVALID_STATE', 'CONTEXT_HISTORY_STALE', 'NOT_FOUND'].includes(failure.code);
            if (stale(error)) throw error;
            try { await context.assertCurrent?.(); }
            catch (currentError) { if (stale(currentError)) throw currentError; }
            if (context.signal.aborted) throw new AgentFault('INVALID_STATE', '流式进度所属执行已经停止');
            disabled = true;
        }
    };
    const flushText = async (): Promise<void> => {
        clearTimer();
        if (pending && !pending.textDelta) pending = undefined;
        await flushPending();
    };
    const schedule = (): void => {
        clearTimer();
        timer = setTimeout(() => {
            timer = undefined;
            void serial(flushPending).catch(() => undefined);
        }, Math.ceil(remaining()));
        timer.unref?.();
    };
    const onAbort = (): void => { clearTimer(); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    return {
        get attemptId(): string | undefined { return attemptId; },
        onPartial(attempt: ProviderAttempt, partial: ProviderPartial): Promise<void> {
            return serial(async () => {
                if (closed || partial.attemptId !== attempt.attemptId || attempt.snapshot.actionId !== identity.actionId
                    || !Number.isSafeInteger(partial.seq) || partial.seq < 0 || !Number.isFinite(Date.parse(partial.receivedAt))) return;
                if (attempt.attemptId !== attemptId) {
                    if (seenAttempts.has(attempt.attemptId)) return;
                    await flushText();
                    attemptId = attempt.attemptId;
                    seenAttempts.add(attemptId);
                    sequence = -1;
                    writtenAt = -Infinity;
                }
                if (partial.seq <= sequence) return;
                sequence = partial.seq;
                if (disabled) return;
                pending = { seq: sequence, receivedAt: partial.receivedAt,
                    textDelta: (pending?.textDelta ?? '') + (typeof partial.textDelta === 'string' ? partial.textDelta : '') };
                if (remaining() === 0) await flushPending();
                else schedule();
            });
        },
        flush(): Promise<void> { return serial(flushText); },
        close(): void {
            closed = true;
            clearTimer();
            pending = undefined;
            context.signal.removeEventListener('abort', onAbort);
        },
    };
}
