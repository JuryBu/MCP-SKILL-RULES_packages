import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPageAccess, assertPageAccessible, readPageAccess, samePageTarget, PageAccessError } from '../src/page-access.ts';
import { runWithRequestContext, getRequestContext } from '../src/request-context.ts';
import { ToolConcurrency } from '../src/tool-concurrency.ts';

const url = 'https://fixture.example/topic/42';
const challenge = { url, title: '请稍候…', visibleText: '', scriptUrls: ['https://fixture.example/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1'], readyState: 'complete' };
const fakePage = snapshot => ({ url: () => url, isClosed: () => false, evaluate: async () => snapshot });

test('strong challenge remains blocked with cookies and requested selector', () => {
    for (const hasCookieForDomain of [false, true]) {
        const result = assessPageAccess({ ...challenge, hasCookieForDomain, waitForMatched: false });
        assert.equal(result.status, 'challenge_required');
        assert.equal(result.blocked, true);
        assert.equal(result.contentConfirmed, false);
    }
});

test('short normal page, blank page and business page with security script do not open assistance', () => {
    for (const snapshot of [{ url, visibleText: 'OK' }, { url, visibleText: '' }, { url, title: '请稍候', visibleText: 'Loading your dashboard' }, { ...challenge, title: 'Documentation', visibleText: 'A normal business document and its navigation. '.repeat(40) }]) {
        assert.equal(assessPageAccess(snapshot).blocked, false);
    }
});

test('target selector and page identity must match before continuation is ready', async () => {
    assert.equal(assessPageAccess({ url, visibleText: 'Home', waitForMatched: false }).status, 'loading');
    const result = await readPageAccess(fakePage({ visibleText: 'Done' }), { url: 'https://fixture.example/another' });
    assert.equal(result.targetMatched, false);
    assert.equal(samePageTarget(url, `${url}/`), true);
    assert.equal(samePageTarget(url, `${url}?different=1`), false);
});

test('explicit access denial takes precedence over weak waiting heuristics', () => {
    for (const title of ['Forbidden', '403 Forbidden', 'Access denied', '无权访问']) {
        const result = assessPageAccess({ url, title, visibleText: title });
        assert.equal(result.status, 'access_denied');
        assert.equal(result.blocked, true);
    }
});

test('short contact form with an embedded captcha is not an interstitial challenge', () => {
    const form = { url, title: 'Contact us', visibleText: 'Name Email Send', hasBusinessForm: true, scriptUrls: ['https://www.google.com/recaptcha/api.js'] };
    assert.equal(assessPageAccess(form).blocked, false);
    assert.equal(assessPageAccess({ ...form, title: 'Just a moment', scriptUrls: challenge.scriptUrls }).blocked, true);
    for (const visibleText of ['Verify you are human', '请完成验证']) {
        assert.equal(assessPageAccess({ ...form, title: 'Security check', visibleText }).blocked, true);
    }
});

test('script-only early snapshot allows normal readiness before final challenge decision', async () => {
    const page = fakePage({ title: 'App', visibleText: '', scriptUrls: ['https://www.google.com/recaptcha/api.js'] });
    await runWithRequestContext({ ownerId: 'early-test', humanAssistance: 'never' }, async () => {
        const early = await assertPageAccessible(page, { url, early: true });
        assert.equal(early.provisional, true);
        assert.equal(getRequestContext().pageAccessIssue, undefined);
        await assert.rejects(assertPageAccessible(page, { url }), PageAccessError);
    });
});

test('explicit human verification wording blocks success without blindly opening a window', async () => {
    await runWithRequestContext({ ownerId: 'weak-test' }, async () => {
        await assert.rejects(assertPageAccessible(fakePage({ title: 'Security check', visibleText: 'Verify you are human' }), { url }), PageAccessError);
        assert.equal(getRequestContext().pageAccessIssue.status, 'challenge_required');
        assert.equal(getRequestContext().pageAccessIssue.taskId, undefined);
    });
});

test('final script-only probe gives asynchronously rendered business content a bounded chance', async () => {
    let attempts = 0;
    const page = { url: () => url, evaluate: async () => ({ title: 'Catalogue', scriptUrls: ['https://www.google.com/recaptcha/api.js'], visibleText: ++attempts < 3 ? 'Loading catalogue' : 'Normal catalogue item details and delivery information. '.repeat(15) }) };
    await runWithRequestContext({ ownerId: 'late-content' }, async () => {
        const result = await assertPageAccessible(page, { url });
        assert.equal(result.status, 'content_ready');
        assert.equal(getRequestContext().pageAccessIssue, undefined);
    });
});

test('failed final re-probe cannot erase previously observed blocking evidence', async () => {
    let probes = 0;
    const page = { url: () => url, evaluate: async () => {
        if (++probes > 1) throw new Error('navigation interrupted the snapshot');
        return { title: 'App', visibleText: '', scriptUrls: ['https://www.google.com/recaptcha/api.js'] };
    } };
    await runWithRequestContext({ ownerId: 'failed-reprobe', humanAssistance: 'never' }, async () => {
        await assert.rejects(assertPageAccessible(page, { url }), PageAccessError);
        assert.equal(getRequestContext().pageAccessIssue.status, 'unknown');
        assert.equal(getRequestContext().pageAccessIssue.blocked, true);
        assert.ok(getRequestContext().pageAccessIssue.reasonCodes.includes('access-probe-unavailable'));
    });
});

test('never policy and legacy global calls report challenge without a visible browser', async () => {
    for (const options of [{ ownerId: 'test-owner', humanAssistance: 'never' }, {}]) {
        await runWithRequestContext(options, async () => {
            await assert.rejects(assertPageAccessible(fakePage(challenge), { url }), PageAccessError);
            assert.equal(getRequestContext().pageAccessIssue.status, 'challenge_required');
            assert.equal(getRequestContext().pageAccessIssue.taskId, undefined);
        });
    }
});

test('middleware preserves blocked result even if legacy handler catches navigation error', async () => {
    const controller = new ToolConcurrency();
    const result = await controller.run('web_fetch_rich', { ownerId: 'test-owner', humanAssistance: 'never' }, async () => {
        try { await assertPageAccessible(fakePage(challenge), { url }); }
        catch { return { content: [{ type: 'text', text: 'legacy generic error' }] }; }
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.pageAccess.status, 'challenge_required');
    assert.equal(result.content.some(part => part.type === 'image'), false);
});

test('probe failure is unknown and never falsely certifies content', async () => {
    const result = await readPageAccess({ url: () => url, evaluate: async () => { throw new Error('detached frame'); } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.contentConfirmed, false);
});
