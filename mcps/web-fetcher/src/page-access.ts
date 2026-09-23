import { detectHumanVerificationSignals, type HumanVerificationDetectionInput } from './human-verification.js';
import { getRequestContext, remainingRequestMs } from './request-context.js';

export type PageAccessStatus = 'content_ready' | 'challenge_required' | 'login_required' | 'loading' | 'access_denied' | 'unknown';

export interface PageAccessAssessment {
    status: PageAccessStatus;
    blocked: boolean;
    url: string;
    reasonCodes: string[];
    targetMatched: boolean;
    contentConfirmed: boolean;
    provisional?: boolean;
}

export interface PageAccessIssue extends PageAccessAssessment {
    taskId?: string;
    ownerId?: string;
    nextAction: string;
}

export class PageAccessError extends Error {
    constructor(public readonly assessment: PageAccessIssue) {
        super(`ERR_PAGE_ACCESS_BLOCKED: ${JSON.stringify(assessment)}`);
        this.name = 'PageAccessError';
    }
}

const assistedPages = new WeakMap<object, string>();

export function registerAssistedPage(page: object, targetUrl: string): void {
    assistedPages.set(page, targetUrl);
}

export function isAssistedPage(page: object): boolean {
    return assistedPages.has(page);
}

export function unregisterAssistedPage(page: object): void {
    assistedPages.delete(page);
}

interface AccessSnapshot extends HumanVerificationDetectionInput {
    readyState?: string;
    hasPasswordInput?: boolean;
    hasBusinessForm?: boolean;
    hasVisualContent?: boolean;
    targetMatched?: boolean;
}

export function assessPageAccess(snapshot: AccessSnapshot): PageAccessAssessment {
    const detected = detectHumanVerificationSignals(snapshot);
    const text = (snapshot.visibleText ?? '').trim();
    const title = (snapshot.title ?? '').trim();
    const shortText = text.length < 2000;
    const base = { url: snapshot.url, reasonCodes: detected.reasonCodes, targetMatched: snapshot.targetMatched ?? true, contentConfirmed: false };
    const verificationPrompt = /请稍候|just a moment|checking (?:your browser|if the site)|security (?:verification|check)|verify (?:that )?you (?:are|['’]re) (?:a )?human|complete (?:the )?(?:captcha|verification)|请完成验证|人机验证|验证(您|你)是(人|真人)/i.test(`${title} ${text}`);
    const structuralSignal = detected.reasonCodes.some(code => !['challenge-waiting-text', 'human-verification-keyword'].includes(code));
    const explicitHumanPrompt = /verify (?:that )?you (?:are|['’]re) (?:a )?human|complete (?:the )?captcha|人机验证|验证(您|你)是(人|真人)/i.test(`${title} ${text}`);
    const interstitial = (verificationPrompt && structuralSignal)
        || detected.reasonCodes.includes('cloudflare-challenge-platform') || detected.reasonCodes.includes('cloudflare-challenge-token');
    const embeddedWidget = snapshot.hasBusinessForm && !interstitial;
    if (detected.shouldOfferUav && detected.confidence === 'strong' && !embeddedWidget && (structuralSignal || explicitHumanPrompt)) {
        return { ...base, status: 'challenge_required', blocked: true, provisional: !interstitial };
    }
    if (explicitHumanPrompt && shortText && !detected.hasUsableContent) {
        return { ...base, status: 'challenge_required', blocked: true, reasonCodes: [...base.reasonCodes, 'explicit-human-verification-prompt'] };
    }
    if (shortText && /^(?:access denied|(?:403\s+)?forbidden\b|permission denied|无权访问|访问被拒绝|没有权限)/i.test(`${title} ${text}`.trim())) {
        return { ...base, status: 'access_denied', blocked: true, reasonCodes: ['explicit-access-denied'] };
    }
    if (detected.shouldOfferUav && !structuralSignal && !explicitHumanPrompt) return { ...base, status: 'loading', blocked: false };
    if (shortText && (snapshot.hasPasswordInput || /^(?:请先登录|需要登录|sign in to continue|log in to continue)/i.test(text))) {
        return { ...base, status: 'login_required', blocked: snapshot.targetMatched === false, reasonCodes: ['login-form-or-message'] };
    }
    if (snapshot.readyState === 'loading' || snapshot.waitForMatched === false) {
        return { ...base, status: 'loading', blocked: false };
    }
    const contentConfirmed = Boolean(text || snapshot.hasVisualContent) && (!detected.shouldOfferUav || Boolean(embeddedWidget));
    return { ...base, status: contentConfirmed ? 'content_ready' : 'unknown', blocked: false, contentConfirmed };
}

export function samePageTarget(actual: string, requested: string): boolean {
    try {
        const current = new URL(actual);
        const target = new URL(requested);
        return current.origin === target.origin && current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')
            && current.search === target.search && (!target.hash || current.hash === target.hash);
    } catch { return actual === requested; }
}

export async function readPageAccess(page: any, options: { url?: string; waitFor?: string } = {}): Promise<PageAccessAssessment> {
    const url = typeof page.url === 'function' ? page.url() : options.url ?? '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const snapshot = await Promise.race([
            page.evaluate((selector?: string) => {
                const isVisible = (element: Element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                let waitForMatched: boolean | undefined;
                if (selector) {
                    try { waitForMatched = [...document.querySelectorAll(selector)].some(isVisible); }
                    catch { waitForMatched = false; }
                }
                return {
                    title: document.title,
                    visibleText: (document.body?.innerText ?? '').slice(0, 60_000),
                    html: document.documentElement?.outerHTML.slice(0, 120_000) ?? '',
                    scriptUrls: [...document.scripts].slice(0, 80).map(script => script.src).filter(Boolean),
                    iframeUrls: [...document.querySelectorAll('iframe')].slice(0, 40).map(frame => frame.src).filter(Boolean),
                    readyState: document.readyState,
                    hasPasswordInput: [...document.querySelectorAll('input[type=password]')].some(isVisible),
                    hasBusinessForm: [...document.querySelectorAll('form input[type=email], form input[type=password], form input[autocomplete=name], form input[autocomplete=username], form textarea')].some(isVisible),
                    hasVisualContent: [...document.querySelectorAll('img,canvas,video,svg')].slice(0, 80).some(isVisible),
                    waitForMatched,
                };
            }, options.waitFor),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Page access probe timed out')), Math.max(1, Math.min(2500, remainingRequestMs(2500))));
                timer.unref?.();
            }),
        ]);
        return assessPageAccess({ ...snapshot, url, targetMatched: !options.url || samePageTarget(url, options.url) });
    } catch {
        return { url, status: 'unknown', blocked: false, reasonCodes: ['access-probe-unavailable'], targetMatched: false, contentConfirmed: false };
    } finally { if (timer) clearTimeout(timer); }
}

export function pageAccessResult(issue: PageAccessIssue) {
    return {
        isError: true,
        content: [{ type: 'text' as const, text: `页面内容尚不可用；没有将验证页当作正文成功。\n${JSON.stringify(issue, null, 2)}` }],
        structuredContent: { pageAccess: issue },
    };
}

export async function assertPageAccessible(page: any, options: { url?: string; waitFor?: string; early?: boolean } = {}): Promise<PageAccessAssessment> {
    const assistedTarget = assistedPages.get(page);
    let assessment = await readPageAccess(page, { ...options, url: assistedTarget ?? options.url });
    if (options.early && assessment.provisional && !assistedTarget) return assessment;
    if (assessment.provisional && !options.early && !assistedTarget) {
        const deadline = Date.now() + Math.min(1500, Math.max(0, remainingRequestMs() - 500));
        while (assessment.provisional && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
            const nextAssessment = await readPageAccess(page, options);
            if (nextAssessment.reasonCodes.includes('access-probe-unavailable')) {
                assessment = { ...nextAssessment, blocked: true, reasonCodes: [...assessment.reasonCodes, ...nextAssessment.reasonCodes] };
                break;
            }
            assessment = nextAssessment;
        }
    }
    if (assistedTarget && (!assessment.contentConfirmed || !assessment.targetMatched || assessment.status !== 'content_ready')) assessment.blocked = true;
    if (!assessment.blocked) return assessment;
    const context = getRequestContext();
    const issue: PageAccessIssue = { ...assessment, nextAction: '页面受阻；不要重复抓取或自动重放写操作。' };
    if (assessment.status === 'login_required') issue.nextAction = '目标跳转到登录页；可用明确ownerId调用web_human_verification(action="start", url=原目标)完成登录后同页续接，不把登录页当正文。';
    if (assistedTarget) issue.nextAction = '原人工验证页面尚未恢复目标内容，请在已有窗口完成并返回原目标后重查；未另开窗口，不自动重放动作。';
    if (assessment.status === 'challenge_required') {
        if (!assistedTarget && !assessment.provisional && !assessment.reasonCodes.includes('explicit-human-verification-prompt') && context?.humanAssistance !== 'never' && context?.ownerId && context.ownerId !== 'global') {
            const { startHumanVerification } = await import('./assisted-verification.js');
            const task = startHumanVerification({ url: options.url ?? assessment.url, ownerId: context.ownerId, waitFor: options.waitFor, automatic: true });
            issue.taskId = task.id;
            issue.ownerId = context.ownerId;
            issue.nextAction = '调用 web_human_verification(action="status", taskId, ownerId, waitSeconds=30)；用户完成后保留窗口，ready 时用返回的 sessionId 继续原只读工具，结束后 action="close"。不要自动重放点击或提交。';
        } else if (!assistedTarget) {
            issue.nextAction = assessment.provisional
                ? '只检测到安全脚本，尚未确认正文就绪或是否受挑战，未自动开窗；可设置waitFor等待明确业务内容，或确认后显式发起人工验证。'
                : assessment.reasonCodes.includes('explicit-human-verification-prompt')
                ? '检测到明确验证提示，但缺少结构证据，未自动开窗；请确认后显式调用web_human_verification(action="start", url, ownerId)。'
                : context?.humanAssistance === 'never'
                ? 'humanAssistance=never，未创建任务或打开窗口；可显式调用 web_human_verification(action="start", url, ownerId)。'
                : '未提供明确 ownerId，未打开共享窗口；请使用稳定 ownerId 调用 web_human_verification(action="start", url, ownerId)。';
        }
    }
    if (context) context.pageAccessIssue = issue;
    throw new PageAccessError(issue);
}
