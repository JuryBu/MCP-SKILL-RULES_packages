import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackgroundTask, waitForBackgroundTask } from '../src/background-tasks.ts';
import { getRequestContext, runWithRequestContext, throwIfRequestExpired } from '../src/request-context.ts';

const delay = duration => new Promise(resolve => setTimeout(resolve, duration));

test('background work owns a fresh deadline and ignores the completed callers signal', async () => {
    const caller = new AbortController();
    let backgroundContext;
    const task = await runWithRequestContext({ ownerId: 'owner-fixture', signal: caller.signal, timeoutMs: 5, viewport: { width: 390, height: 844 } }, async () => startBackgroundTask('inspect-fixture', async () => {
        await delay(35);
        throwIfRequestExpired();
        backgroundContext = getRequestContext();
        return 'independent';
    }, { maxRunMs: 2000 }));
    caller.abort();
    await delay(75);
    const result = await waitForBackgroundTask(task.id);
    assert.equal(result.status, 'done');
    assert.equal(result.result, 'independent');
    assert.equal(backgroundContext.ownerId, 'owner-fixture');
    assert.deepEqual(backgroundContext.viewport, { width: 390, height: 844 });
    assert.equal(backgroundContext.signal, undefined);
});

test('timed out background work holds its permit until actual completion and cannot overwrite status', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, (_, index) => startBackgroundTask('bounded-fixture', async () => {
        active++; peak = Math.max(peak, active);
        try { await delay(50); return `result-${index}`; }
        finally { active--; }
    }, { maxRunMs: index < 2 ? 10 : 2000 }));
    await delay(220);
    assert.equal(peak, 2);
    assert.equal(active, 0);
    assert.equal((await waitForBackgroundTask(tasks[0].id)).status, 'error');
    assert.equal((await waitForBackgroundTask(tasks[0].id)).result, undefined);
    for (const task of tasks.slice(2)) assert.equal((await waitForBackgroundTask(task.id)).status, 'done');
});

test('manual login is not queued behind slow model background work', async () => {
    let finishFirst;
    let finishSecond;
    const first = startBackgroundTask('web-fetch-ai-summary', () => new Promise(resolve => { finishFirst = resolve; }), { maxRunMs: 2000 });
    const second = startBackgroundTask('web-fetch-ai-summary', () => new Promise(resolve => { finishSecond = resolve; }), { maxRunMs: 2000 });
    let loginStarted = false;
    const login = startBackgroundTask('web-login', async () => { loginStarted = true; return 'login-fixture'; }, { maxRunMs: 2000 });
    try {
        await delay(30);
        assert.equal(loginStarted, true);
        assert.equal((await waitForBackgroundTask(login.id)).status, 'done');
    } finally {
        finishFirst('model-one'); finishSecond('model-two');
        await delay(10);
    }
    assert.equal((await waitForBackgroundTask(first.id)).status, 'done');
    assert.equal((await waitForBackgroundTask(second.id)).status, 'done');
});

test('queued manual login gets its full run/save budget only after admission', async () => {
    const tasks = Array.from({ length: 3 }, () => startBackgroundTask('web-login', async () => {
        await delay(70);
        return 'state-saved';
    }, { maxRunMs: 110 }));
    await delay(5);
    assert.equal((await waitForBackgroundTask(tasks[2].id)).phase, 'queued');
    assert.equal((await waitForBackgroundTask(tasks[2].id)).deadlineAt, undefined);
    await delay(160);
    for (const task of tasks) {
        const result = await waitForBackgroundTask(task.id);
        assert.equal(result.status, 'done');
        assert.equal(result.result, 'state-saved');
        assert.ok(result.executionStartedAt);
    }
});
