import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extractContent } from '../dist/extractor.js';

test('each extraction closes its parsing window without changing the returned text', () => {
    const descriptor = Object.getOwnPropertyDescriptor(JSDOM.prototype, 'window');
    const observed = new WeakSet();
    let windows = 0;
    let closes = 0;
    let failNext = false;
    Object.defineProperty(JSDOM.prototype, 'window', { ...descriptor, get() {
        const window = descriptor.get.call(this);
        if (!observed.has(window)) {
            observed.add(window);
            windows++;
            const close = window.close.bind(window);
            window.close = () => { closes++; close(); };
            if (failNext) {
                Object.defineProperty(window.document, 'title', { get() { throw new Error('fixture parse interrupted'); } });
                failNext = false;
            }
        }
        return window;
    } });
    try {
        const html = '<!doctype html><title>Test newsroom</title><article><h1>Morning report</h1>'
            + '<p>The library will host a meeting for all members of the community, and ticket information is available at the end of this report.</p>'.repeat(3)
            + '<p><a href="/visit">Visit details</a></p></article>';
        const article = extractContent(html, 'https://example.com/report');
        assert.match(article.content, /library will host/);
        assert.match(article.content, /Visit details/);
        const short = extractContent('<title>Quick note</title><body>Open at 9</body>', 'https://example.com/note');
        assert.match(short.content, /Open at 9/);
        failNext = true;
        assert.throws(() => extractContent(html, 'https://example.com/interrupted'), /fixture parse interrupted/);
        assert.equal(windows, 3);
        assert.equal(closes, windows);
    } finally {
        Object.defineProperty(JSDOM.prototype, 'window', descriptor);
    }
});
