import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelBackgroundTask, formatBackgroundTask, listBackgroundTasks, startBackgroundTask, waitForBackgroundTask } from '../src/background-tasks.ts';
import { runWithRequestContext } from '../src/request-context.ts';

const delay = duration => new Promise(resolve => setTimeout(resolve, duration));

test('legacy zero-argument run and ownerless lookup remain compatible', async () => {
    const task = startBackgroundTask('legacy-fixture', async () => 'legacy-result', { maxRunMs: 1000 });
    await delay(10);
    const finished = await waitForBackgroundTask(task.id, 0);
    assert.equal(finished.status, 'done');
    assert.equal(formatBackgroundTask(finished), 'legacy-result');
    assert.equal(await waitForBackgroundTask(task.id, 0, 'unrelated-owner'), finished);
});

test('strict tasks bind to request owner and cannot be read or cancelled across owners', async () => {
    let finish;
    const task = await runWithRequestContext({ ownerId: 'owner-a' }, async () => startBackgroundTask('human-verification', () => new Promise(resolve => { finish = resolve; }), {
        strictOwner: true,
        maxRunMs: 1000,
        metadata: { stage: 'opening', count: 1 },
    }));
    await delay(10);
    assert.equal(task.ownerId, 'owner-a');
    assert.deepEqual(task.metadata, { stage: 'opening', count: 1 });
    assert.equal(await waitForBackgroundTask(task.id), null);
    assert.equal(await waitForBackgroundTask(task.id, 0, 'owner-b'), null);
    assert.equal(await cancelBackgroundTask(task.id, 'owner-b'), null);
    assert.equal((await waitForBackgroundTask(task.id, 0, 'owner-a')).status, 'running');
    assert.ok(listBackgroundTasks('human-verification', 'owner-a').some(candidate => candidate.id === task.id));
    assert.ok(!listBackgroundTasks('human-verification', 'owner-b').some(candidate => candidate.id === task.id));
    finish('owner-result');
    await delay(10);
    assert.equal((await waitForBackgroundTask(task.id, 0, 'owner-a')).status, 'done');
});

test('cancellation aborts, awaits cleanup, and blocks late result and metadata', async () => {
    let finish;
    let finishCleanup;
    let runContext;
    let cleanupCalls = 0;
    const task = startBackgroundTask('human-verification', async context => {
        runContext = context;
        context.updateMetadata({ stage: 'awaiting_user' });
        return new Promise(resolve => { finish = resolve; });
    }, {
        ownerId: 'owner-a', strictOwner: true, maxRunMs: 1000,
        onCancel: () => { cleanupCalls++; return new Promise(resolve => { finishCleanup = resolve; }); },
    });
    await delay(10);
    assert.equal(task.metadata.stage, 'awaiting_user');
    const cancelling = cancelBackgroundTask(task.id, 'owner-a');
    assert.equal(task.status, 'cancelling');
    assert.equal(task.cleanupStatus, 'pending');
    assert.equal(runContext.signal.aborted, true);
    assert.equal(await waitForBackgroundTask(task.id, 0, 'owner-a'), task);
    const duplicate = cancelBackgroundTask(task.id, 'owner-a');
    runContext.updateMetadata({ stage: 'late' });
    finish('late-result');
    await delay(10);
    assert.equal(task.metadata.stage, 'awaiting_user');
    assert.equal(task.status, 'cancelling');
    finishCleanup();
    assert.equal((await cancelling).status, 'cancelled');
    assert.equal((await duplicate).status, 'cancelled');
    assert.equal(task.cleanupStatus, 'done');
    assert.equal(task.result, undefined);
    assert.equal(cleanupCalls, 1);
});

test('cleanup failure is reported instead of a false cancelled success', async () => {
    const task = startBackgroundTask('human-verification', () => new Promise(() => {}), {
        ownerId: 'owner-a', strictOwner: true, maxRunMs: 1000,
        onCancel: async () => { throw new Error('window-close-failed'); },
    });
    await delay(10);
    const stopped = await cancelBackgroundTask(task.id, 'owner-a');
    assert.equal(stopped.status, 'error');
    assert.equal(stopped.cleanupStatus, 'failed');
    assert.match(stopped.cleanupError, /window-close-failed/);
    assert.match(stopped.error, /清理失败/);
    assert.equal((await cancelBackgroundTask(task.id, 'owner-a')).status, 'error');
});

test('failed cleanup can retry on the same task without restarting work', async () => {
    let attempts = 0;
    let runs = 0;
    const task = startBackgroundTask('cleanup-retry-fixture', async control => {
        runs++;
        await new Promise(resolve => control.signal.addEventListener('abort', resolve, { once: true }));
        return 'late-result';
    }, { ownerId: 'retry-owner', strictOwner: true, onCancel: async () => { if (++attempts === 1) throw new Error('first close failed'); } });
    await delay(10);
    assert.equal((await cancelBackgroundTask(task.id, 'retry-owner')).cleanupStatus, 'failed');
    assert.equal((await cancelBackgroundTask(task.id, 'retry-owner')).cleanupStatus, 'done');
    assert.equal(task.status, 'cancelled');
    assert.equal(runs, 1);
    assert.equal(attempts, 2);
});

test('ready deadline starts after opening and setup has its own bounded timeout', async () => {
    let readyContext;
    let cleanupCalls = 0;
    const ready = startBackgroundTask('human-verification', async context => {
        await delay(25);
        readyContext = context;
        context.startDeadline(130);
        context.updateMetadata({ phase: 'ready' });
        await delay(65);
        return 'verified';
    }, { maxRunMs: 130, deferDeadlineUntilReady: true, setupTimeoutMs: 60, onCancel: async () => { cleanupCalls++; } });
    await delay(10);
    assert.equal(ready.deadlineAt, undefined);
    assert.ok(ready.setupDeadlineAt);
    await delay(45);
    assert.ok(ready.deadlineAt);
    assert.equal(ready.setupDeadlineAt, undefined);
    assert.equal(ready.status, 'running');
    assert.equal((await waitForBackgroundTask(ready.id, 0.1)).metadata.phase, 'ready');
    await delay(65);
    assert.equal((await waitForBackgroundTask(ready.id)).status, 'running');
    assert.equal(ready.result, 'verified');
    await delay(70);
    assert.equal(ready.status, 'error');
    assert.equal(ready.timedOut, true);
    assert.equal(ready.metadata.phase, 'expired');
    assert.equal(ready.cleanupStatus, 'done');
    assert.equal(cleanupCalls, 1);
    assert.equal(readyContext.signal.aborted, true);

    let openingSignal;
    const opening = startBackgroundTask('human-verification', async context => {
        openingSignal = context.signal;
        await delay(70);
        context.updateMetadata({ stage: 'too-late' });
        return 'late-opening';
    }, { maxRunMs: 100, deferDeadlineUntilReady: true, setupTimeoutMs: 25 });
    await delay(45);
    assert.equal(opening.status, 'error');
    assert.equal(opening.timedOut, true);
    assert.equal(openingSignal.aborted, true);
    await delay(45);
    assert.equal(opening.status, 'error');
    assert.equal(opening.result, undefined);
    assert.equal(opening.metadata.phase, 'expired');
});
