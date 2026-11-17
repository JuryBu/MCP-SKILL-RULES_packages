export interface ReadinessSampleOptions {
    visual: boolean;
    fullPage: boolean;
    probeRunId?: string;
    probeLifetimeMs: number;
    requestedSelector?: string;
}

type ProbeEntry = {
    status: 'pending' | 'ready' | 'failed';
    image?: HTMLImageElement;
};
type ProbeRun = {
    entries: Map<string, ProbeEntry>;
    active: number;
    release: () => void;
};

export function releaseReadinessProbeRun(runId: string): void {
    const host = window as typeof window & { __webFetcherReadinessProbes?: Map<string, ProbeRun> };
    host.__webFetcherReadinessProbes?.get(runId)?.release();
}

export function sampleReadinessDocument({ visual, fullPage, probeRunId, probeLifetimeMs, requestedSelector }: ReadinessSampleOptions) {
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const documentRoot = document.documentElement;
    const standaloneSvg = !!documentRoot && document.contentType === 'image/svg+xml'
        && documentRoot.namespaceURI === svgNamespace && documentRoot.localName === 'svg';
    const documentReady = standaloneSvg
        ? document.readyState === 'complete'
        : !!document.body && document.readyState !== 'loading';
    let total = 0;
    let ready = 0;
    let failed = 0;
    let scanLimited = false;
    let uninspectedFrames = 0;
    let frameTextLength = 0;
    let fontsReady = !document.fonts || document.fonts.status === 'loaded';
    let scanned = 0;
    let visibleCount = 0;
    const nodeLimit = 6000;
    const frameLimit = 64;
    const layout: string[] = [];

    const visibleBounds = (element: Element, allowEmpty = false): { bounds: DOMRect; style: CSSStyleDeclaration } | undefined => {
        const bounds = element.getBoundingClientRect();
        const pendingImage = element.tagName === 'IMG' && !(element as HTMLImageElement).complete;
        if ((bounds.width <= 0 || bounds.height <= 0) && !((allowEmpty || pendingImage) && element.getClientRects().length)) return;
        const view = element.ownerDocument.defaultView ?? window;
        if ((!fullPage || element.ownerDocument !== document)
            && (bounds.bottom < 0 || bounds.top > view.innerHeight || bounds.right < 0 || bounds.left > view.innerWidth)) return;
        const style = view.getComputedStyle(element);
        if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return;
        return { bounds, style };
    };
    const root = document.querySelector('#root, #app, #__next');
    const busySelector = 'body[aria-busy="true"], main[aria-busy="true"], article[aria-busy="true"], [role="main"][aria-busy="true"], [role="article"][aria-busy="true"], #root[aria-busy="true"], #app[aria-busy="true"], #__next[aria-busy="true"]';
    const primaryBusy = Array.from(document.querySelectorAll(busySelector)).some(element => !!visibleBounds(element, true));
    const emptyRoot = (!!root && root.children.length === 0 && !root.textContent?.trim())
        || (standaloneSvg && !visibleBounds(documentRoot));
    const hasFrames = !!document.querySelector('iframe');
    const mainArticle = !visual && !hasFrames ? document.querySelector<HTMLElement>('main article, article, [role="article"]') : null;
    const textBody = mainArticle?.innerText?.trim() || document.body?.innerText?.trim() || '';
    const staticText = !visual && !hasFrames && textBody.length > 0 && document.readyState === 'complete'
        && document.contentType === 'text/html' && !document.scripts.length && !primaryBusy && !emptyRoot;

    let probeRun: ProbeRun | undefined;
    const usedUrls = visual ? new Set<string>() : undefined;
    const detachProbe = (entry: ProbeEntry, cancel: boolean): void => {
        if (!entry.image) return;
        entry.image.onload = null;
        entry.image.onerror = null;
        if (cancel) entry.image.removeAttribute('src');
        entry.image = undefined;
    };
    if (visual && probeRunId) {
        const host = window as typeof window & { __webFetcherReadinessProbes?: Map<string, ProbeRun> };
        const runs = host.__webFetcherReadinessProbes ??= new Map<string, ProbeRun>();
        probeRun = runs.get(probeRunId);
        if (!probeRun) {
            const entries = new Map<string, ProbeEntry>();
            const release = () => {
                window.clearTimeout(expiry);
                for (const entry of entries.values()) detachProbe(entry, true);
                runs.delete(probeRunId);
                if (!runs.size && host.__webFetcherReadinessProbes === runs) delete host.__webFetcherReadinessProbes;
            };
            const expiry = window.setTimeout(release, Math.max(1, probeLifetimeMs));
            probeRun = { entries, active: 0, release };
            runs.set(probeRunId, probeRun);
        }
    }

    const checkImage = (picture: HTMLImageElement): void => {
        if (!picture.currentSrc && !picture.getAttribute('src') && !picture.getAttribute('srcset')) return;
        total++;
        if (picture.complete) {
            if (picture.naturalWidth > 0) ready++;
            else failed++;
        }
    };
    const checkUrl = (url: string): void => {
        if (!url || !usedUrls || !probeRun || usedUrls.has(url)) return;
        if (usedUrls.size >= 512) { scanLimited = true; return; }
        usedUrls.add(url);
        let entry = probeRun.entries.get(url);
        total++;
        if (!entry) {
            if (probeRun.entries.size >= 512) { scanLimited = true; return; }
            if (probeRun.active >= 32) return;
            const currentRun = probeRun;
            const picture = new Image();
            const item: ProbeEntry = { status: 'pending', image: picture };
            const settle = (status: ProbeEntry['status']) => {
                if (item.status !== 'pending' || currentRun.entries.get(url) !== item) return;
                item.status = status;
                currentRun.active--;
                detachProbe(item, false);
            };
            entry = item;
            currentRun.entries.set(url, entry);
            currentRun.active++;
            picture.onload = () => settle(picture.naturalWidth > 0 ? 'ready' : 'failed');
            picture.onerror = () => settle('failed');
            picture.src = url;
            if (picture.complete && picture.naturalWidth > 0) settle('ready');
        }
        if (entry.status === 'ready') ready++;
        if (entry.status === 'failed') failed++;
    };

    const frames: HTMLIFrameElement[] = [];
    const visit = (element: Element, nested: boolean): void => {
        const geometry = visibleBounds(element);
        if (!geometry) return;
        const { bounds, style } = geometry;
        visibleCount++;
        if (element.tagName === 'IFRAME') {
            if (nested || frames.length >= frameLimit) uninspectedFrames++;
            else frames.push(element as HTMLIFrameElement);
        }
        if (!visual) return;
        if (layout.length < 200 && /^(IMG|VIDEO|P|H[1-6]|BUTTON|INPUT|CANVAS|SVG|MAIN|ARTICLE)$/i.test(element.tagName)) {
            layout.push(`${element.tagName}:${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`);
        }
        if (element.tagName === 'IMG') checkImage(element as HTMLImageElement);
        if (standaloneSvg && element.localName === 'image') {
            const resource = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (resource && !resource.startsWith('#')) checkUrl(resource);
        }
        if (element.tagName === 'VIDEO') {
            const video = element as HTMLVideoElement;
            if (video.poster) checkUrl(video.poster);
            else if (video.currentSrc || video.src || video.querySelector('source')) {
                total++;
                if (video.readyState >= 2) ready++;
                else if (video.error) failed++;
            }
        }
        for (const match of style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) checkUrl(match[1]);
    };

    const walk = (treeRoot: Element, nested: boolean): void => {
        const walker = treeRoot.ownerDocument.createTreeWalker(treeRoot, NodeFilter.SHOW_ELEMENT);
        for (let element = walker.nextNode() as Element | null; element; element = walker.nextNode() as Element | null) {
            if (scanned >= nodeLimit) { scanLimited = true; break; }
            scanned++;
            visit(element, nested);
        }
    };
    if (visual || hasFrames) {
        const treeRoot = document.body ?? (standaloneSvg ? documentRoot : undefined);
        if (treeRoot) walk(treeRoot, false);
        for (const frame of frames) {
            try {
                const frameDocument = frame.contentDocument;
                if (!frameDocument) { uninspectedFrames++; continue; }
                total++;
                const navigating = !!frame.getAttribute('src') && frame.src !== 'about:blank' && frameDocument.URL === 'about:blank';
                if (!navigating && frameDocument.readyState !== 'loading') ready++;
                if (frameDocument.body) {
                    frameTextLength += frameDocument.body.innerText.length;
                    walk(frameDocument.body, true);
                }
                fontsReady = fontsReady && (!frameDocument.fonts || frameDocument.fonts.status === 'loaded');
            } catch { uninspectedFrames++; }
        }
    }
    if (probeRun && usedUrls) {
        for (const [url, entry] of probeRun.entries) {
            if (!usedUrls.has(url)) {
                if (entry.status === 'pending') probeRun.active--;
                detachProbe(entry, true);
                probeRun.entries.delete(url);
            }
        }
    }
    const meaningful = !primaryBusy && !emptyRoot && (textBody.length > 0 || frameTextLength > 0
        || !!document.querySelector('img[src],video,canvas,svg,input,button')
        || (!!root && root.children.length > 0 && (visibleCount > 0 || !!visibleBounds(root))));
    let targetReady = false;
    if (!visual && requestedSelector && documentReady && meaningful) {
        try {
            const target = document.querySelector(requestedSelector);
            if (target) targetReady = !!visibleBounds(target);
        } catch { }
    }
    const structureCount = (visual || hasFrames) ? scanned : (mainArticle ?? document.body)?.childElementCount ?? 0;
    return {
        total, ready, failed, pending: total - ready - failed,
        fontsReady, scanLimited, meaningful, uninspectedFrames, primaryBusy, emptyRoot,
        documentReady, staticText, targetReady,
        documentVersion: performance.timeOrigin, documentAgeMs: performance.now(),
        signature: `${performance.timeOrigin}|${location.href}|${documentReady}|${primaryBusy}|${emptyRoot}|${structureCount}|${textBody.length + frameTextLength}|${textBody.slice(0, 300)}|${textBody.slice(-100)}|${total}|${ready}|${failed}|${layout.join(';')}`,
    };
}
