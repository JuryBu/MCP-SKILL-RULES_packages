import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import ts from 'typescript';
import { getStealthScript } from '../src/stealth.ts';

test('real 800x520 CSS viewport, DOM structure and evidence screenshots agree under unmodified stealth', { timeout: 45000 }, async contextTest => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-stealth-rework-'));
    process.env.TEMP = root;
    process.env.TMP = root;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(root, 'storage');
    const { browserManager } = await import('../src/browser.ts');
    const { stopAllServers } = await import('../src/local-server.ts');
    let browser;
    const originalNavigate = browserManager.navigateTo;
    const originalReady = browserManager.waitForVisualReady;
    contextTest.after(async () => {
        browserManager.navigateTo = originalNavigate;
        browserManager.waitForVisualReady = originalReady;
        await browser?.close();
        await stopAllServers();
        await fs.rm(root, { recursive: true, force: true });
    });
    for (const name of ['dom-evidence', 'dom-inspector']) {
        const sourceURL = new URL(`../src/inspector/${name}.ts`, import.meta.url);
        const source = await fs.readFile(sourceURL, 'utf8');
        const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
        const linked = output.replace(/from ["'](\.[^"']+\.js)["']/gu, (statement, specifier) => {
            const url = specifier === './dom-evidence.js' ? pathToFileURL(path.join(root, 'dom-evidence.mjs')) : new URL(specifier.replace(/\.js$/u, '.ts'), sourceURL);
            return `from ${JSON.stringify(url.href)}`;
        });
        await fs.writeFile(path.join(root, `${name}.mjs`), linked);
    }
    const { extractVisibleDomElements } = await import(pathToFileURL(path.join(root, 'dom-evidence.mjs')).href);
    const { extractDomStructureFromPage, detectDomIssues } = await import(pathToFileURL(path.join(root, 'dom-inspector.mjs')).href);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 800, height: 520 }, deviceScaleFactor: 1 });
    const page = await browserContext.newPage();
    await browserContext.addInitScript(getStealthScript({ chromeVersion: '132', chromeFullVersion: '132.0.0.0', brands: [], fullVersionList: [], webglVendor: 'Fixture', webglRenderer: 'Fixture', level: 3 }));
    const markup = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;font:20px Arial}#caption{position:absolute;left:10px;top:480px}#cover{position:absolute;left:0;top:475px;width:800px;height:45px;background:#abc}</style><div id="caption">Visible text under cover</div><div id="cover"></div>';
    await page.goto('data:text/html,' + encodeURIComponent(markup));
    browserManager.navigateTo = async () => page;
    browserManager.waitForVisualReady = async () => ({ complete: true });
    const fingerprintBefore = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight }));
    assert.deepEqual(fingerprintBefore, { width: 1920, height: 969, outerWidth: 1920, outerHeight: 1080 });
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, coverWidth: document.querySelector('#cover').getBoundingClientRect().width }));
    assert.deepEqual(layout, { width: 800, height: 520, coverWidth: 800 });
    const raw = await page.evaluate(extractVisibleDomElements, { maxDepth: 20, minElementSize: 5 });
    assert.deepEqual(raw.dimensions, { width: 800, height: 520, viewportWidth: 800, viewportHeight: 520 });
    const structure = (await extractDomStructureFromPage(page))[0];
    assert.deepEqual(structure.dimensions, { width: 800, height: 520, unit: 'px' });
    assert.equal(structure.metadata.viewportWidth, 800);
    assert.equal(structure.metadata.viewportHeight, 520);
    const screenshotBuffer = await page.screenshot();
    const image = await sharp(screenshotBuffer).metadata();
    assert.equal(image.width, 800);
    assert.equal(image.height, 520);
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight })), fingerprintBefore);
    const clips = [];
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => { clips.push(options.clip); return screenshot(options); };
    const result = await detectDomIssues(page.url(), ['overlap'], true, 100, { viewport: { width: 800, height: 520 } });
    assert.ok(result.issues.some(issue => issue.screenshotPath));
    assert.ok(clips.length > 0);
    for (const clip of clips) {
        assert.equal(clip.width, 800);
        assert.equal(clip.height, 520);
        const issue = result.issues.find(candidate => candidate.screenshotPath);
        const evidence = await sharp(issue.screenshotPath).metadata();
        assert.equal(evidence.width, 800);
        assert.equal(evidence.height, 520);
    }
    contextTest.diagnostic(JSON.stringify({ fingerprintPreserved: fingerprintBefore, layout, structure: structure.dimensions, viewport: [structure.metadata.viewportWidth, structure.metadata.viewportHeight], screenshot: [image.width, image.height], evidenceClips: clips }));
    if (process.env.WEB_FETCHER_REWORK_EVIDENCE_DIR) {
        const evidenceRoot = path.resolve(process.env.WEB_FETCHER_REWORK_EVIDENCE_DIR);
        await fs.mkdir(evidenceRoot, { recursive: true });
        await fs.writeFile(path.join(evidenceRoot, 'stealth-800x520.png'), screenshotBuffer);
        await fs.copyFile(result.issues.find(issue => issue.screenshotPath).screenshotPath, path.join(evidenceRoot, 'dom-evidence-800x520.jpg'));
        await fs.writeFile(path.join(evidenceRoot, 'viewport-evidence.json'), JSON.stringify({ fingerprintBefore, layout, rawDimensions: raw.dimensions, dimensions: structure.dimensions, metadata: structure.metadata, clips }, null, 2));
    }
});
