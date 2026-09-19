import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserManager } from '../src/browser.ts';
import { PageAdmissionController } from '../src/page-admission.ts';
import { runWithRequestContext } from '../src/request-context.ts';

function createManager(maxPages = 2, startupWindowMs = 5000) {
    const manager = new browserManager.constructor();
    let sequence = 0;
    manager.admission = new PageAdmissionController({
        maxPages, queueTimeoutMs: 500, startupWindowMs,
        memoryProvider: { snapshot: () => ({ valid: true, mode: 'windows', sourceId: 'fixture', sequence: ++sequence, sampledAt: performance.now(), lowMemory: false, physicalAvailableMB: 16000, commitAvailableMB: 24000 }) },
    });
    return manager;
}

class FakePage extends EventEmitter {
    closed = false;
    failClose = false;
    screenshot = async () => Buffer.from('fixture');
    isClosed() { return this.closed; }
    async close() {
        if (this.failClose) throw new Error('close not confirmed');
        this.closed = true; this.emit('close');
    }
}

test('browser admission reserves before awaiting page creation and wakes on confirmed close', async () => {
    const manager = createManager();
    let creating = 0;
    let peak = 0;
    const context = { newPage: async () => {
        creating++; peak = Math.max(peak, creating);
        await new Promise(resolve => setTimeout(resolve, 20));
        creating--; return new FakePage();
    } };
    try {
        const first = manager.createOwnedPage(context);
        const second = manager.createOwnedPage(context);
        const queued = manager.createOwnedPage(context);
        const pages = await Promise.all([first, second]);
        assert.equal(peak, 2);
        assert.equal(manager.getPoolStats().admission.used, 2);
        await pages[0].close();
        const third = await queued;
        assert.equal(manager.getPoolStats().admission.used, 2);
        await pages[1].close(); await third.close();
        assert.equal(manager.getPoolStats().admission.used, 0);
    } finally { manager.admission.dispose(); }
});

test('cancelled late page stays reserved until creation completes and the late page closes', async () => {
    const manager = createManager();
    const cancellation = new AbortController();
    let releaseCreation;
    const page = new FakePage();
    const pending = runWithRequestContext({ ownerId: 'late-owner', signal: cancellation.signal }, () => manager.createOwnedPage({ newPage: () => new Promise(resolve => { releaseCreation = () => resolve(page); }) }));
    await new Promise(resolve => setImmediate(resolve));
    cancellation.abort();
    assert.equal(manager.getPoolStats().admission.reserved, 1);
    releaseCreation();
    await assert.rejects(pending, /取消/);
    assert.equal(page.isClosed(), true);
    assert.equal(manager.getPoolStats().admission.used, 0);
    manager.admission.dispose();
});

test('failed close remains charged until its actual close event', async () => {
    const manager = createManager();
    const page = await manager.createOwnedPage({ newPage: async () => new FakePage() });
    page.failClose = true;
    await manager.closeFailedPage(page, 'fixture');
    assert.equal(manager.getPoolStats().admission.closing, 1);
    assert.equal(manager.getPoolStats().activePages, 1);
    page.failClose = false;
    await page.close();
    assert.equal(manager.getPoolStats().admission.used, 0);
    manager.admission.dispose();
});

test('already closed page and create rejection do not leak a slot', async () => {
    const manager = createManager();
    const page = new FakePage();
    await page.close();
    await assert.rejects(manager.createOwnedPage({ newPage: async () => page }), /已关闭/);
    await assert.rejects(manager.createOwnedPage({ newPage: async () => { throw new Error('create rejected'); } }), /create rejected/);
    assert.equal(manager.getPoolStats().admission.used, 0);
    manager.admission.dispose();
});

test('partial visual completion can retire startup debt without falsely marking the image complete', async () => {
    const manager = createManager(2, 1);
    const page = await manager.createOwnedPage({ newPage: async () => new FakePage() });
    assert.equal(manager.getPoolStats().admission.uncoveredMemoryMB, 256);
    const readiness = await manager.waitForVisualReady(page, 0);
    assert.equal(readiness.complete, false);
    assert.ok(readiness.note);
    await new Promise(resolve => setTimeout(resolve, 5));
    manager.admission.refresh();
    assert.equal(manager.getPoolStats().admission.uncoveredMemoryMB, 0);
    assert.equal(manager.getPoolStats().admission.used, 1);
    await page.close();
    manager.admission.dispose();
});
