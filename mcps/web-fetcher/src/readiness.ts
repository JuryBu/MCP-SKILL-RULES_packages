import type { Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { remainingRequestMs, throwIfRequestExpired, withRequestStage } from './request-context.js';
import { isNavigationReadError, NavigationReadError, readDuringNavigation } from './navigation-read.js';
import { releaseReadinessProbeRun, sampleReadinessDocument } from './readiness-sample.js';

export interface ReadinessResult {
    waited: number;
    total: number;
    ready: number;
    pending: number;
    failed: number;
    complete: boolean;
    fontsReady: boolean;
    scanLimited: boolean;
    uninspectedFrames?: number;
    documentReady?: boolean;
    note?: string;
}

export interface ReadinessOptions {
    mode: 'content' | 'visual';
    maxWait: number;
    fullPage?: boolean;
    minimumObserveMs?: number;
    quietMs?: number;
}

const latestResults = new WeakMap<Page, ReadinessResult>();
const contentTarget = new AsyncLocalStorage<string>();

export function withContentReadinessTarget<Result>(selector: string | undefined, run: () => Result): Result {
    return selector ? contentTarget.run(selector, run) : run();
}

export function getPageReadiness(page: Page): ReadinessResult | undefined {
    return latestResults.get(page);
}

async function pause(duration: number): Promise<void> {
    if (duration > 0) await new Promise<void>(resolve => setTimeout(resolve, duration));
    throwIfRequestExpired();
}

async function primeLazyImages(page: Page, deadline: number): Promise<{ complete: boolean; documentVersion: number }> {
    const remaining = Math.max(0, deadline - performance.now());
    const workDeadline = deadline - Math.min(250, remaining / 4);
    const original = await readDuringNavigation(page, () => page.evaluate(() => ({ x: scrollX, y: scrollY, height: innerHeight, documentVersion: performance.timeOrigin })), { phase: 'readiness.visual.scroll-state', timeoutMs: Math.max(0, workDeadline - performance.now()) });
    let reachedBottom = false;
    let moved = false;
    let restored = false;
    try {
        for (let step = 0; step < 30 && performance.now() + 100 < workDeadline; step++) {
            const position = step * Math.max(200, original.height - 80);
            moved = true;
            const result = await readDuringNavigation(page, () => page.evaluate(top => {
                window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
                return { bottom: scrollY + innerHeight, height: document.documentElement.scrollHeight, documentVersion: performance.timeOrigin };
            }, position), { phase: 'readiness.visual.lazy-scroll', maxRetries: 0, timeoutMs: Math.max(0, workDeadline - performance.now()) });
            if (result.documentVersion !== original.documentVersion) break;
            await pause(80);
            if (result.bottom >= result.height - 2) {
                reachedBottom = true;
                break;
            }
        }
    } finally {
        throwIfRequestExpired();
        if (moved && !page.isClosed() && performance.now() < deadline) {
            await readDuringNavigation(page, () => page.evaluate(position => {
                if (performance.timeOrigin === position.documentVersion) window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' as ScrollBehavior });
            }, original), { phase: 'readiness.visual.restore-scroll', maxRetries: 0, timeoutMs: Math.max(0, deadline - performance.now()) }).then(() => { restored = true; }).catch(error => {
                if (!isNavigationReadError(error) && !(error instanceof NavigationReadError && error.diagnostics.code === 'page_read_timeout')) throw error;
            });
        }
    }
    return { complete: reachedBottom && (!moved || restored), documentVersion: original.documentVersion };
}

export async function waitForPageReadiness(page: Page, options: ReadinessOptions): Promise<ReadinessResult> {
    return withRequestStage(`readiness.${options.mode}`, async () => {
        throwIfRequestExpired();
        const started = performance.now();
        const budget = Math.max(0, Math.min(options.maxWait, remainingRequestMs(options.maxWait)));
        const deadline = started + budget;
        const minimumObserve = options.minimumObserveMs ?? (options.mode === 'visual' ? 1500 : 500);
        const quietMs = options.quietMs ?? (options.mode === 'visual' ? 500 : 350);
        const requestedSelector = options.mode === 'content' ? contentTarget.getStore() : undefined;
        const probeRunId = options.mode === 'visual' ? randomUUID() : undefined;
        let lazyComplete = options.mode !== 'visual' || !options.fullPage;
        let lazyDocumentVersion: number | undefined;
        if (!lazyComplete) {
            try {
                const primed = await primeLazyImages(page, Math.min(deadline, started + Math.min(3000, budget / 3)));
                lazyComplete = primed.complete;
                lazyDocumentVersion = primed.documentVersion;
            }
            catch (error) {
                if (!isNavigationReadError(error) && !(error instanceof NavigationReadError && error.diagnostics.code === 'page_read_timeout')) throw error;
            }
        }
        let lastSignature = '';
        let stableSince = performance.now();
        let final: ReadinessResult = {
            waited: 0, total: 0, ready: 0, pending: 0, failed: 0,
            complete: false, fontsReady: false, scanLimited: false,
        };
        try {
            while (performance.now() < deadline) {
                throwIfRequestExpired();
                const sampling = readDuringNavigation(page, () => page.evaluate(sampleReadinessDocument, {
                    visual: options.mode === 'visual',
                    fullPage: !!options.fullPage,
                    probeRunId,
                    requestedSelector,
                    probeLifetimeMs: Math.round(Math.max(1, deadline - performance.now()) + 150),
                }), { phase: `readiness.${options.mode}.sample`, timeoutMs: Math.max(0, deadline - performance.now()) });
                let snapshot: Awaited<typeof sampling>;
                try { snapshot = await sampling; }
                catch (error) {
                    if (error instanceof NavigationReadError && error.diagnostics.code === 'page_read_timeout' && performance.now() >= deadline) break;
                    if ((isNavigationReadError(error) || (error instanceof NavigationReadError && error.diagnostics.code === 'navigation_read_interrupted')) && performance.now() < deadline) {
                        lastSignature = '';
                        stableSince = performance.now();
                        final.complete = false;
                        final.documentReady = false;
                        await pause(Math.min(200, Math.max(0, deadline - performance.now())));
                        continue;
                    }
                    throw error;
                }
                if (options.mode === 'visual' && options.fullPage && lazyDocumentVersion !== snapshot.documentVersion) {
                    lazyComplete = false;
                    if (performance.now() + 300 < deadline) {
                        try {
                            const primed = await primeLazyImages(page, Math.min(deadline, performance.now() + 3000));
                            lazyComplete = primed.complete;
                            lazyDocumentVersion = primed.documentVersion;
                        } catch (error) {
                            if (!isNavigationReadError(error) && !(error instanceof NavigationReadError && error.diagnostics.code === 'page_read_timeout')) throw error;
                        }
                        lastSignature = '';
                        stableSince = performance.now();
                        continue;
                    }
                }
                const now = performance.now();
                if (snapshot.signature !== lastSignature) {
                    lastSignature = snapshot.signature;
                    stableSince = now;
                }
                const settled = snapshot.documentReady !== false && (options.mode === 'visual'
                    ? snapshot.pending === 0 && snapshot.fontsReady && !snapshot.primaryBusy && !snapshot.emptyRoot
                    : snapshot.meaningful && snapshot.pending === 0);
                const fastText = snapshot.staticText && minimumObserve <= 500 && options.quietMs === undefined;
                const observeMs = fastText ? Math.min(minimumObserve, 120) : minimumObserve;
                const settleMs = fastText ? Math.min(quietMs, 100) : quietMs;
                const stable = snapshot.targetReady
                    || (now - stableSince >= settleMs && now - started >= observeMs && snapshot.documentAgeMs >= observeMs);
                final = {
                    waited: Math.round(now - started), total: snapshot.total, ready: snapshot.ready,
                    pending: snapshot.pending, failed: snapshot.failed, fontsReady: snapshot.fontsReady,
                    scanLimited: snapshot.scanLimited,
                    documentReady: snapshot.documentReady,
                    uninspectedFrames: snapshot.uninspectedFrames,
                    complete: settled && stable && snapshot.failed === 0 && !snapshot.scanLimited && lazyComplete && snapshot.uninspectedFrames === 0,
                };
                if (settled && stable) break;
                await pause(Math.min(fastText ? 60 : 200, Math.max(0, deadline - performance.now())));
            }
        } finally {
            if (probeRunId && !page.isClosed()) {
                const cleanupBudget = remainingRequestMs(100);
                if (cleanupBudget > 0) {
                    await readDuringNavigation(page, () => page.evaluate(releaseReadinessProbeRun, probeRunId), {
                        phase: 'readiness.visual.cleanup', maxRetries: 0, timeoutMs: cleanupBudget,
                    }).catch(() => undefined);
                }
            }
        }
        final.waited = Math.round(performance.now() - started);
        if (!final.complete) {
            const reasons = [
                final.documentReady === false ? '当前文档仍在解析' : '',
                final.pending ? `${final.pending} 个可见资源仍在加载` : '',
                final.failed ? `${final.failed} 个资源加载失败` : '',
                !final.fontsReady ? '字体尚未就绪' : '',
                final.scanLimited ? '页面结构超过本次检查上限' : '',
                !lazyComplete ? '长页面懒加载遍历未完成' : '',
                final.uninspectedFrames ? `${final.uninspectedFrames} 个跨域或深层嵌入页面未检查` : '',
            ].filter(Boolean);
            final.note = `就绪检查未完整通过：${reasons.join('；') || '内容或布局尚未稳定'}，已返回当前状态`;
        }
        latestResults.set(page, final);
        return final;
    });
}
