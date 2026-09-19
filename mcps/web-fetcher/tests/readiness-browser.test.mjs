import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { waitForPageReadiness } from '../dist/readiness.js';

const enabled = process.env.WEB_FETCHER_BROWSER_TESTS === '1';
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="green"/></svg>';

test('real browser readiness keeps pixels ready without networkidle or minimum text length', { skip: !enabled, timeout: 60000 }, async suite => {
    const timers = new Set();
    const fontPath = path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', 'arial.ttf');
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const finish = () => {
            if (response.destroyed) return;
            if (url.pathname === '/font') {
                response.writeHead(200, { 'Content-Type': 'font/ttf' });
                response.end(fs.readFileSync(fontPath));
            } else if (url.pathname === '/broken') {
                response.writeHead(404); response.end('missing');
            } else {
                response.writeHead(200, { 'Content-Type': url.pathname === '/image' ? 'image/svg+xml' : 'text/html', 'Cache-Control': 'no-store' });
                response.end(url.pathname === '/image' ? picture : url.pathname === '/frame'
                    ? '<html><body style="margin:0"><img width="400" height="240" src="/image?delay=2200"></body></html>'
                    : '<html><body>Fixture</body></html>');
            }
        };
        const delay = Number(url.searchParams.get('delay')) || 0;
        if (delay) {
            const timer = setTimeout(() => { timers.delete(timer); finish(); }, delay);
            timers.add(timer);
        } else finish();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const run = async (html, options, verify) => {
            const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
            try {
                await page.goto(origin, { waitUntil: 'domcontentloaded' });
                await page.setContent(html, { waitUntil: 'domcontentloaded' });
                const result = await waitForPageReadiness(page, options);
                await verify(result, page);
            } finally { await page.close(); }
        };
        await suite.test('short text does not require 100 characters', async () => {
            await run('<h1>Ready</h1><button>OK</button>', { mode: 'content', maxWait: 4000 }, result => {
                assert.equal(result.complete, true); assert.ok(result.waited < 2500);
            });
        });
        await suite.test('late inserted cover must finish, not just stop changing', async () => {
            await run(`<h1>Article</h1><script>setTimeout(()=>{const picture=new Image();picture.src='${origin}/image?delay=1800';document.body.append(picture)},1200)</script>`, { mode: 'visual', maxWait: 6000 }, async (result, page) => {
                assert.equal(result.complete, true); assert.equal(result.ready, 1);
                assert.equal(await page.locator('img').evaluate(image => image.naturalWidth), 400);
                assert.ok(result.waited >= 2800);
            });
        });
        await suite.test('explicitly busy short SPA content is not mistaken for a ready short page', async () => {
            await run('<main id="root" aria-busy="true">Loading...</main><script>setTimeout(()=>{root.textContent="Actual short article";root.setAttribute("aria-busy","false")},1800)</script>', { mode: 'content', maxWait: 5000 }, async (result, page) => {
                assert.equal(result.complete, true);
                assert.equal(await page.locator('main').innerText(), 'Actual short article');
                assert.ok(result.waited >= 1800);
            });
        });
        await suite.test('pending resource does not become ready after two equal samples', async () => {
            await run(`<img src="${origin}/image?delay=6000" width="400" height="240">`, { mode: 'visual', maxWait: 1600 }, result => {
                assert.equal(result.complete, false); assert.equal(result.pending, 1); assert.match(result.note, /加载/);
            });
        });
        await suite.test('failed image is reported separately from decoded pixels', async () => {
            await run(`<img src="${origin}/broken" width="400" height="240">`, { mode: 'visual', maxWait: 2500 }, result => {
                assert.equal(result.complete, false); assert.equal(result.failed, 1); assert.equal(result.ready, 0);
            });
        });
        await suite.test('CSS background and video poster loading', async () => {
            await run(`<div style="width:400px;height:240px;background-image:url('${origin}/image?delay=1800')"></div><video width="400" height="240" poster="${origin}/image?delay=2000"></video>`, { mode: 'visual', maxWait: 5000 }, result => {
                assert.equal(result.complete, true); assert.equal(result.ready, 2);
            });
        });
        await suite.test('font load participates in visual readiness', { skip: !fs.existsSync(fontPath) }, async () => {
            await run(`<style>@font-face{font-family:FixtureFont;src:url('${origin}/font?delay=2000')}h1{font-family:FixtureFont}</style><h1>Font must load</h1>`, { mode: 'visual', maxWait: 5000 }, result => {
                assert.equal(result.complete, true); assert.equal(result.fontsReady, true); assert.ok(result.waited >= 1800);
            });
        });
        await suite.test('full page primes far lazy images and restores scroll', async () => {
            await run(`<h1>Top</h1><div style="height:6000px"></div><img loading="lazy" src="${origin}/image?delay=900" width="400" height="240">`, { mode: 'visual', maxWait: 6000, fullPage: true }, async (result, page) => {
                assert.equal(result.complete, true); assert.equal(result.ready, 1); assert.equal(await page.evaluate(() => scrollY), 0);
            });
        });
        await suite.test('irrelevant perpetual polling does not block useful pixels', async () => {
            await run(`<h1>Dashboard</h1><script>setInterval(()=>fetch('${origin}/poll'),100)</script>`, { mode: 'visual', maxWait: 4000 }, result => {
                assert.equal(result.complete, true); assert.ok(result.waited < 3000);
            });
        });
        await suite.test('same-origin embedded cover is included without a blind iframe sleep', async () => {
            await run(`<iframe style="width:420px;height:260px" src="${origin}/frame"></iframe>`, { mode: 'visual', maxWait: 5000 }, result => {
                assert.equal(result.complete, true); assert.equal(result.ready, 2); assert.ok(result.waited >= 2000);
            });
        });
        await suite.test('invisible ancestor images do not delay a visible screenshot', async () => {
            await run(`<h1>Visible content</h1><div style="opacity:0"><img width="400" height="240" src="${origin}/image?delay=6000"></div>`, { mode: 'visual', maxWait: 3000 }, result => {
                assert.equal(result.complete, true); assert.equal(result.total, 0); assert.ok(result.waited < 2500);
            });
        });
        await suite.test('oversized DOM reports bounded inspection instead of claiming full coverage', async () => {
            await run('<h1>Heavy DOM</h1>' + '<span style="display:inline-block;width:1px;height:1px">.</span>'.repeat(6200), { mode: 'visual', maxWait: 4000 }, result => {
                assert.equal(result.complete, false); assert.equal(result.scanLimited, true); assert.match(result.note, /上限/);
            });
        });
    } finally {
        await browser?.close();
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
