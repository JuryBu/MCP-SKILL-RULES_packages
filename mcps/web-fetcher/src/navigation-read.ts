import { performance } from 'node:perf_hooks';
import type { Frame, Page } from 'playwright';
import { getRequestContext, remainingRequestMs, RequestAdmissionError, throwIfRequestExpired, withRequestStage } from './request-context.js';

type ReadTarget = Page | Frame;

export interface NavigationReadOptions {
    phase: string;
    maxRetries?: number;
    timeoutMs?: number;
    requireDocumentReady?: boolean;
}

export interface PageReadFailure {
    code: string;
    phase: string;
    requestedUrl: string;
    finalUrl: string;
    retries: number;
    cause: string;
}

export class NavigationReadError extends Error {
    constructor(readonly diagnostics: PageReadFailure) {
        super(diagnostics.cause);
        this.name = 'NavigationReadError';
    }
}

export class DocumentChangedError extends Error {
    constructor() { super('读取期间页面已切换文档'); }
}

class ReadBudgetError extends Error {
    constructor() { super('页面读取期限已到'); }
}

export function isNavigationReadError(error: unknown): boolean {
    const cause = error instanceof NavigationReadError ? error.diagnostics.cause : error instanceof Error ? error.message : String(error);
    return error instanceof DocumentChangedError || /Execution context was destroyed|Cannot find context with specified id|Cannot find execution context|Unable to retrieve content because the page is navigating and changing the content/i.test(cause);
}

function targetUrl(target: ReadTarget): string {
    try { return target.url(); } catch { return ''; }
}

function owningPage(target: ReadTarget): Page {
    return typeof (target as Frame).page === 'function' ? (target as Frame).page() : target as Page;
}

function assertTargetOpen(target: ReadTarget): void {
    throwIfRequestExpired();
    if (owningPage(target).isClosed?.()) throw new Error('读取目标页面已关闭');
    if (typeof (target as Frame).isDetached === 'function' && (target as Frame).isDetached()) throw new Error('读取目标 frame 已脱离页面');
}

async function boundedRead<Result>(handler: () => Promise<Result>, deadline: number, mustSettle = false): Promise<Result> {
    throwIfRequestExpired();
    if (performance.now() >= deadline) throw new ReadBudgetError();
    const signal = getRequestContext()?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const operation = Promise.resolve().then(() => {
        throwIfRequestExpired();
        if (performance.now() >= deadline) throw new ReadBudgetError();
        return handler();
    });
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                const expire = () => {
                    try { throwIfRequestExpired(); }
                    catch (error) { reject(error); return; }
                    reject(new ReadBudgetError());
                };
                timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - performance.now())));
                abort = () => reject(new RequestAdmissionError('request_cancelled', '请求已取消，停止页面读取'));
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            }),
        ]);
    } catch (error) {
        if (mustSettle) {
            if (timer) clearTimeout(timer);
            if (abort) signal?.removeEventListener('abort', abort);
            await operation.then(() => undefined, () => undefined);
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
    }
}

export async function readDuringNavigation<Result>(target: ReadTarget, read: () => Promise<Result>, options: NavigationReadOptions): Promise<Result> {
    const requestedUrl = targetUrl(target);
    const deadline = performance.now() + Math.max(0, Math.min(options.timeoutMs ?? remainingRequestMs(), remainingRequestMs()));
    const maxRetries = Math.max(0, Math.min(5, Math.floor(options.maxRetries ?? 2)));
    const page = owningPage(target);
    const mustSettle = getRequestContext()?.leasedPages.has(page) === true;
    const frame = typeof (target as Page).mainFrame === 'function' ? (target as Page).mainFrame() : target;
    let documentVersion = 0;
    let retries = 0;
    const onNavigation = (changedFrame: Frame) => { if (changedFrame === frame) documentVersion++; };
    page.on?.('framenavigated', onNavigation);
    try {
        return await withRequestStage(options.phase, async () => {
            while (true) {
                assertTargetOpen(target);
                const version = documentVersion;
                try {
                    if (options.requireDocumentReady) await boundedRead(async () => {
                        const ready = await target.waitForFunction(() => document.readyState !== 'loading' && !!document.documentElement, undefined,
                            { timeout: Math.max(1, deadline - performance.now()) });
                        await ready.dispose();
                    }, deadline, mustSettle);
                    const result = await boundedRead(read, deadline, mustSettle);
                    if (options.requireDocumentReady && !await boundedRead(() => target.evaluate(() => document.readyState !== 'loading'), deadline, mustSettle)) throw new DocumentChangedError();
                    assertTargetOpen(target);
                    if (version !== documentVersion) throw new DocumentChangedError();
                    return result;
                } catch (error) {
                    assertTargetOpen(target);
                    if (!isNavigationReadError(error) || retries >= maxRetries || performance.now() >= deadline) throw error;
                    retries++;
                    await boundedRead(async () => {
                        try {
                            await target.waitForLoadState('domcontentloaded', { timeout: Math.max(1, Math.min(1000, deadline - performance.now())) });
                        } catch (waitError) {
                            if (!(waitError instanceof Error) || waitError.name !== 'TimeoutError') throw waitError;
                        }
                        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(25, deadline - performance.now()))));
                    }, deadline, mustSettle);
                }
            }
        });
    } catch (error) {
        if (error instanceof RequestAdmissionError) throw error;
        throw new NavigationReadError({ code: error instanceof ReadBudgetError ? 'page_read_timeout' : isNavigationReadError(error) ? 'navigation_read_interrupted' : 'page_read_failed', phase: options.phase, requestedUrl, finalUrl: targetUrl(target), retries, cause: error instanceof Error ? error.message : String(error) });
    } finally {
        page.off?.('framenavigated', onNavigation);
    }
}

export function pageReadFailure(error: unknown, phase: string, requestedUrl: string, finalUrl?: string): PageReadFailure {
    const known = error instanceof NavigationReadError ? error.diagnostics : undefined;
    const context = getRequestContext();
    const failedStage = context ? [...context.timings].reverse().find(timing => timing.failed)?.stage : undefined;
    return {
        code: known?.code ?? (error instanceof RequestAdmissionError ? error.code : isNavigationReadError(error) ? 'navigation_read_interrupted' : 'page_read_failed'),
        phase: known?.phase ?? failedStage ?? phase,
        requestedUrl,
        finalUrl: finalUrl ?? known?.finalUrl ?? requestedUrl,
        retries: known?.retries ?? 0,
        cause: known?.cause ?? (error instanceof Error ? error.message : String(error)),
    };
}

export function formatPageReadFailure(failure: PageReadFailure): string {
    return `${failure.cause}\n阶段: ${failure.phase}\n原地址: ${failure.requestedUrl}\n最终地址: ${failure.finalUrl}\n导航读取恢复: ${failure.retries} 次`;
}
