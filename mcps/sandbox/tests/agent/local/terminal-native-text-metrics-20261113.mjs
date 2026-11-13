import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeConsoleGraphics } from '../../../src/agent-cli/graphics/native-console.ts';
import { TerminalRenderer, visibleWidth } from '../../../src/agent-cli/renderer.ts';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';

test('a missing measurement receipt releases the renderer through bounded fallback', async () => {
    const events = [];
    const graphics = new NativeConsoleGraphics(event => events.push(event));
    graphics.child = { stdin: { destroyed: false, writableLength: 0, write: () => {} } };
    graphics.ready = true; graphics.textMetricsReady = true;
    let closed = false;
    graphics.close = () => { closed = true; };
    assert.equal(graphics.measureText('待测×'), false);
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(closed, true);
    assert.equal(events.at(-1)?.type, 'unavailable');
    assert.equal(graphics.measurementPending, false);
});

test('native bridge bounds and deduplicates measurement requests without starting a window', () => {
    const graphics = new NativeConsoleGraphics();
    const writes = [];
    graphics.child = { stdin: { destroyed: false, writableLength: 0, write: value => writes.push(value) } };
    graphics.ready = true;
    graphics.textMetricsReady = true;
    assert.equal(graphics.measureText('中文×÷…→éΩ'), false);
    assert.equal(graphics.measureText('中文×÷…→éΩ'), false);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0]), { type: 'measure-text', text: '中文×÷…→éΩ', requestId: 1 });
    graphics.measurementPending = false;
    assert.equal(graphics.measureText('中文×÷…→éΩ'), true);
    graphics.measureText('中'.repeat(20000));
    assert.equal(JSON.parse(writes[1]).text.length, 16384);
    graphics.textMetricsReady = false;
    assert.equal(graphics.measureText('新内容'), true);
});

test('the real UI measurement event invalidates wrap cache and passes metrics to transcript wrapping', () => {
    const ui = Object.create(InteractiveCli.prototype);
    const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: true });
    let emit;
    let renders = 0;
    Object.assign(ui, { renderer, disposed: false, nativeGraphicsAttempted: false,
        streams: { stdin: { isTTY: true }, stderr: { isTTY: true } }, initial: { options: { graphics: 'auto' } },
        terminal: { width: 100, height: 34, linear: false }, details: [], transcript: ['南区×'.repeat(20)],
        partialVisible: false, scheduleRender: () => { renders += 1; },
        createNativeGraphics: callback => { emit = callback; return { start: () => true }; } });
    try {
        ui.startNativeGraphics();
        const before = ui.detailLines();
        emit({ type: 'text-metrics', characterWidths: { '×': 2, '÷': 2, '…': 2, '→': 2, '─': 1 } });
        assert.equal(ui.detailCache, undefined);
        const after = ui.detailLines();
        assert.notDeepEqual(after, before);
        assert.equal(after.join(''), ui.transcript[0]);
        assert.ok(after.every(line => visibleWidth(line, renderer.textMetrics) <= 61));
        assert.equal(renders, 1);
        emit({ type: 'exit' });
        assert.equal(visibleWidth('×', renderer.textMetrics), 1);
    } finally { renderer.dispose(); }
});
