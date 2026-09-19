import type { Page } from 'playwright';
import { performance } from 'node:perf_hooks';
import { remainingRequestMs, throwIfRequestExpired, withRequestStage } from './request-context.js';

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

export function getPageReadiness(page: Page): ReadinessResult | undefined {
    return latestResults.get(page);
}

async function pause(duration: number): Promise<void> {
    if (duration > 0) await new Promise<void>(resolve => setTimeout(resolve, duration));
    throwIfRequestExpired();
}

async function primeLazyImages(page: Page, deadline: number): Promise<boolean> {
    const original = await page.evaluate(() => ({ x: scrollX, y: scrollY, height: innerHeight }));
    let reachedBottom = false;
    try {
        for (let step = 0; step < 30 && performance.now() + 100 < deadline; step++) {
            const position = step * Math.max(200, original.height - 80);
            const result = await page.evaluate(top => {
                window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
                return { bottom: scrollY + innerHeight, height: document.documentElement.scrollHeight };
            }, position);
            await pause(80);
            if (result.bottom >= result.height - 2) {
                reachedBottom = true;
                break;
            }
        }
    } finally {
        if (!page.isClosed()) {
            await page.evaluate(position => window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' as ScrollBehavior }), original);
        }
    }
    return reachedBottom;
}

export async function waitForPageReadiness(page: Page, options: ReadinessOptions): Promise<ReadinessResult> {
    return withRequestStage(`readiness.${options.mode}`, async () => {
        throwIfRequestExpired();
        const started = performance.now();
        const budget = Math.max(0, Math.min(options.maxWait, remainingRequestMs(options.maxWait)));
        const deadline = started + budget;
        const minimumObserve = options.minimumObserveMs ?? (options.mode === 'visual' ? 1500 : 500);
        const quietMs = options.quietMs ?? (options.mode === 'visual' ? 500 : 350);
        const lazyComplete = options.mode !== 'visual' || !options.fullPage
            || await primeLazyImages(page, Math.min(deadline, started + Math.min(3000, budget / 3)));
        let lastSignature = '';
        let stableSince = performance.now();
        let final: ReadinessResult = {
            waited: 0, total: 0, ready: 0, pending: 0, failed: 0,
            complete: false, fontsReady: false, scanLimited: false,
        };
        while (performance.now() < deadline) {
            throwIfRequestExpired();
            const snapshot = await page.evaluate(({ visual, fullPage }) => {
                const probeKey = '__webFetcherVisualProbes_v1';
                const host = window as typeof window & { [probeKey]?: Map<string, HTMLImageElement> };
                const probes = host[probeKey] ??= new Map<string, HTMLImageElement>();
                const usedUrls = new Set<string>();
                let total = 0;
                let ready = 0;
                let failed = 0;
                let scanLimited = false;
                let visibleCount = 0;
                let uninspectedFrames = 0;
                let frameTextLength = 0;
                let fontsReady = !document.fonts || document.fonts.status === 'loaded';
                const layout: string[] = [];
                const inScope = (element: Element): boolean => {
                    const bounds = element.getBoundingClientRect();
                    const pendingIntrinsicImage = element.tagName === 'IMG' && !(element as HTMLImageElement).complete && element.getClientRects().length > 0;
                    if ((bounds.width <= 0 || bounds.height <= 0) && !pendingIntrinsicImage) return false;
                    const view = element.ownerDocument.defaultView ?? window;
                    if ((!fullPage || element.ownerDocument !== document) && (bounds.bottom < 0 || bounds.top > view.innerHeight || bounds.right < 0 || bounds.left > view.innerWidth)) return false;
                    const style = getComputedStyle(element);
                    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
                    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
                };
                const checkImage = (picture: HTMLImageElement): void => {
                    if (!picture.currentSrc && !picture.getAttribute('src') && !picture.getAttribute('srcset')) return;
                    total++;
                    if (picture.complete) {
                        if (picture.naturalWidth > 0) ready++;
                        else failed++;
                    }
                };
                const checkUrl = (url: string): void => {
                    if (!url || usedUrls.has(url)) return;
                    usedUrls.add(url);
                    let picture = probes.get(url);
                    if (!picture) {
                        if (probes.size >= 512) {
                            scanLimited = true;
                            return;
                        }
                        picture = new Image();
                        picture.src = url;
                        probes.set(url, picture);
                    }
                    checkImage(picture);
                };
                const nodes = document.body?.querySelectorAll('*') ?? [];
                const limit = 6000;
                scanLimited = nodes.length > limit;
                const frameNodes: Element[] = [];
                for (const frame of document.querySelectorAll('iframe')) {
                    if (!inScope(frame)) continue;
                    try {
                        const frameDocument = frame.contentDocument;
                        if (!frameDocument) { uninspectedFrames++; continue; }
                        total++;
                        const navigating = !!frame.getAttribute('src') && frame.src !== 'about:blank' && frameDocument.URL === 'about:blank';
                        if (!navigating && frameDocument.readyState !== 'loading') ready++;
                        if (frameDocument.body) {
                            frameTextLength += frameDocument.body.innerText.length;
                            for (const element of frameDocument.body.querySelectorAll('*')) {
                                if (nodes.length + frameNodes.length >= limit) { scanLimited = true; break; }
                                frameNodes.push(element);
                            }
                            uninspectedFrames += frameDocument.querySelectorAll('iframe').length;
                        }
                        fontsReady = fontsReady && (!frameDocument.fonts || frameDocument.fonts.status === 'loaded');
                    } catch { uninspectedFrames++; }
                }
                const inspectedNodes: Element[] = [];
                for (let index = 0; index < Math.min(nodes.length, limit); index++) inspectedNodes.push(nodes[index]);
                inspectedNodes.push(...frameNodes);
                for (let index = 0; index < inspectedNodes.length; index++) {
                    const element = inspectedNodes[index];
                    if (!inScope(element)) continue;
                    visibleCount++;
                    const bounds = element.getBoundingClientRect();
                    if (layout.length < 200 && /^(IMG|VIDEO|P|H[1-6]|BUTTON|INPUT|CANVAS|SVG|MAIN|ARTICLE)$/.test(element.tagName)) {
                        layout.push(`${element.tagName}:${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`);
                    }
                    if (!visual) continue;
                    if (element.tagName === 'IMG') checkImage(element as HTMLImageElement);
                    if (element.tagName === 'VIDEO') {
                        const video = element as HTMLVideoElement;
                        if (video.poster) checkUrl(video.poster);
                        else if (video.currentSrc || video.src || video.querySelector('source')) {
                            total++;
                            if (video.readyState >= 2) ready++;
                            else if (video.error) failed++;
                        }
                    }
                    const style = getComputedStyle(element);
                    const matches = style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g);
                    for (const match of matches) checkUrl(match[1]);
                }
                if (visual) {
                    for (const [url] of probes) {
                        if (!usedUrls.has(url)) probes.delete(url);
                    }
                }
                const text = (document.body?.innerText ?? '').trim();
                const root = document.querySelector('#root, #app, #__next');
                const busyRoots = document.querySelectorAll('body[aria-busy="true"], main[aria-busy="true"], [role="main"][aria-busy="true"], #root[aria-busy="true"], #app[aria-busy="true"], #__next[aria-busy="true"]');
                const primaryBusy = Array.from(busyRoots).some(element => inScope(element));
                const emptyRoot = !!root && root.children.length === 0 && !root.textContent?.trim();
                const meaningful = !primaryBusy && !emptyRoot && (text.length > 0 || frameTextLength > 0 || !!document.querySelector('img[src],video,canvas,svg,input,button')
                    || (!!root && root.children.length > 0 && visibleCount > 0));
                return {
                    total, ready, failed, pending: total - ready - failed,
                    fontsReady,
                    scanLimited, meaningful, uninspectedFrames, primaryBusy, emptyRoot,
                    signature: `${primaryBusy}|${emptyRoot}|${nodes.length + frameNodes.length}|${text.length + frameTextLength}|${text.slice(0, 300)}|${text.slice(-100)}|${total}|${ready}|${failed}|${layout.join(';')}`,
                };
            }, { visual: options.mode === 'visual', fullPage: !!options.fullPage });
            const now = performance.now();
            if (snapshot.signature !== lastSignature) {
                lastSignature = snapshot.signature;
                stableSince = now;
            }
            const settled = options.mode === 'visual'
                ? snapshot.pending === 0 && snapshot.fontsReady && !snapshot.primaryBusy && !snapshot.emptyRoot
                : snapshot.meaningful && snapshot.pending === 0;
            const stable = now - stableSince >= quietMs && now - started >= minimumObserve;
            final = {
                waited: Math.round(now - started), total: snapshot.total, ready: snapshot.ready,
                pending: snapshot.pending, failed: snapshot.failed, fontsReady: snapshot.fontsReady,
                scanLimited: snapshot.scanLimited,
                uninspectedFrames: snapshot.uninspectedFrames,
                complete: settled && stable && snapshot.failed === 0 && !snapshot.scanLimited && lazyComplete && snapshot.uninspectedFrames === 0,
            };
            if (settled && stable) break;
            await pause(Math.min(200, Math.max(0, deadline - performance.now())));
        }
        final.waited = Math.round(performance.now() - started);
        if (!final.complete) {
            const reasons = [
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
