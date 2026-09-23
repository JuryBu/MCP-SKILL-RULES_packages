import test from 'node:test';
import assert from 'node:assert/strict';
import { startHumanVerification } from '../src/assisted-verification.ts';
import { waitForBackgroundTask, cancelBackgroundTask } from '../src/background-tasks.ts';
import { humanBrowserManager } from '../src/human-browser/manager.ts';
import { sessionManager } from '../src/session.ts';
import { isAssistedPage } from '../src/page-access.ts';

test('failed opening retains a retryable cleanup of the original resource without reopening', async () => {
    const originalOpen = humanBrowserManager.open;
    const ownerId = 'opening-cleanup-regression';
    let openCalls = 0;
    let cleanupCalls = 0;
    let canClean = false;
    humanBrowserManager.open = async () => {
        openCalls++;
        throw Object.assign(new Error('startup failed and original process exit is unconfirmed'), {
            cleanupFailed: true,
            retryCleanup: async () => { cleanupCalls++; if (!canClean) throw new Error('cleanup still unavailable'); },
        });
    };
    let task;
    try {
        task = startHumanVerification({ url: 'https://fixture.invalid/open-failure', ownerId });
        const failed = await waitForBackgroundTask(task.id, 2, ownerId);
        assert.equal(failed.cleanupStatus, 'failed');
        const beforeRetry = cleanupCalls;
        canClean = true;
        const finished = await cancelBackgroundTask(task.id, ownerId);
        assert.equal(finished.cleanupStatus, 'done');
        assert.equal(openCalls, 1);
        assert.ok(cleanupCalls > beforeRetry, 'retry must reach the captured resource cleanup');
    } finally {
        canClean = true;
        if (task) await cancelBackgroundTask(task.id, ownerId);
        humanBrowserManager.open = originalOpen;
    }
});

test('cancellation during opening cleans the late owned session without making it ready', async () => {
    const original = { open: humanBrowserManager.open, close: humanBrowserManager.close };
    const ownerId = 'opening-cancel-regression';
    let finishOpening;
    let openCalls = 0;
    const closed = new Set();
    humanBrowserManager.open = async () => { openCalls++; return new Promise(resolve => { finishOpening = resolve; }); };
    humanBrowserManager.close = async id => { closed.add(id); return true; };
    let task;
    try {
        task = startHumanVerification({ url: 'https://fixture.invalid/late-open', ownerId });
        for (let attempt = 0; attempt < 30 && !finishOpening; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(typeof finishOpening, 'function');
        const cancelling = cancelBackgroundTask(task.id, ownerId);
        finishOpening({ humanSessionId: 'late-owned-session', pages: [{ pageId: 'late-page', url: 'https://fixture.invalid/late-open' }] });
        const result = await cancelling;
        assert.equal(result.status, 'cancelled');
        assert.equal(result.cleanupStatus, 'done');
        assert.equal(result.metadata.contentVerified, false);
        assert.equal(result.metadata.sessionId, undefined);
        assert.ok(closed.has('late-owned-session'));
        assert.equal(openCalls, 1);
    } finally {
        if (task) await cancelBackgroundTask(task.id, ownerId);
        Object.assign(humanBrowserManager, original);
    }
});

test('borrowed human session keeps original aliases and rejects conflicting verification conditions', async () => {
    const target = 'https://fixture.invalid/article';
    const ownerId = 'borrowed-regression';
    const page = { url: () => target, isClosed: () => false, evaluate: async () => ({ title: 'Article', visibleText: 'Verified fixture article.', readyState: 'complete', waitForMatched: true }) };
    const originalAlias = sessionManager.registerPage(page, ownerId, { ownership: 'borrowed', closePolicy: 'noop', browserSource: 'external-page' });
    const original = { describe: humanBrowserManager.describe, getPage: humanBrowserManager.getPage, peekStorage: humanBrowserManager.peekStorage, close: humanBrowserManager.close };
    let closeCalls = 0;
    humanBrowserManager.describe = async id => ({ humanSessionId: id, source: 'managed-chrome', pages: [{ pageId: 'original-page', url: target, alive: true }] });
    humanBrowserManager.getPage = () => page;
    humanBrowserManager.peekStorage = () => ({ savedAt: undefined, errors: [] });
    humanBrowserManager.close = async () => { closeCalls++; return true; };
    let task;
    try {
        task = startHumanVerification({ url: target, ownerId, humanSessionId: 'pre-existing-managed-window', pageId: 'original-page', waitFor: '#article' });
        const ready = await waitForBackgroundTask(task.id, 2, ownerId);
        assert.equal(ready.metadata.phase, 'ready');
        const taskAlias = ready.metadata.sessionId;
        assert.notEqual(taskAlias, originalAlias);
        assert.equal(startHumanVerification({ url: target, ownerId, humanSessionId: 'pre-existing-managed-window', pageId: 'original-page', waitFor: '#article' }).id, task.id);
        assert.throws(() => startHumanVerification({ url: target, ownerId, humanSessionId: 'pre-existing-managed-window', pageId: 'original-page', waitFor: '#missing' }), /条件不同/);
        await cancelBackgroundTask(task.id, ownerId);
        assert.equal(closeCalls, 0, 'borrowed managed Chrome must not be terminated by this task');
        assert.equal(sessionManager.get(originalAlias, ownerId), page);
        assert.equal(sessionManager.get(taskAlias, ownerId), null);
        assert.equal(isAssistedPage(page), false);
    } finally {
        if (task) await cancelBackgroundTask(task.id, ownerId);
        Object.assign(humanBrowserManager, original);
        await sessionManager.close(originalAlias, ownerId);
    }
});
