import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { extractContent } from "../dist/extractor.js";
import { waitForPageReadiness } from "../dist/readiness.js";

const runFile = promisify(execFile);
const story = "<p>Actual article: the exhibition opens on 17 April at Lake Hall. Every section must be available before the caller extracts this page.</p>".repeat(3)
    + '<p>Final paragraph and <a href="/details">the original event details</a>.</p>';
const shell = body => `<!doctype html><meta charset="utf-8"><title>Readiness test</title><main><h1>Readiness test</h1>${body}</main>`;
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140"><rect width="320" height="140" fill="#009971"/></svg>';
const tiles = Array.from({ length: 64 }, (_, index) => `<span style="display:inline-block;width:24px;height:24px;background-image:url('/pixels?id=${index}')"></span>`).join("");
const fragments = "<span></span>".repeat(12500);
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const freeze = value => createHash("sha256").update(value).digest("hex");
const timing = () => performance.now();

async function browserMemory(browserSession) {
    if (process.platform !== "win32") return null;
    const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
    const ids = processInfo.map(item => Number(item.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return null;
    const { stdout } = await runFile("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$rows=Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue; [PSCustomObject]@{pids=@($rows).Count; workingSet=($rows|Measure-Object WorkingSet64 -Sum).Sum; privateBytes=($rows|Measure-Object PrivateMemorySize64 -Sum).Sum}|ConvertTo-Json -Compress`,
    ], { windowsHide: true, timeout: 5000 });
    return JSON.parse(stdout);
}

async function inspectProbes(page) {
    return page.evaluate(() => {
        const original = window.__webFetcherVisualProbes_v1;
        const current = window.__webFetcherReadinessProbes;
        return {
            retainedImages: (original?.size ?? 0) + [...(current?.values() ?? [])].reduce((sum, run) => sum + run.active, 0),
            activeRuns: current?.size ?? 0,
            fullElementLists: window.studyFullLists ?? 0,
        };
    });
}

async function captureContent(browserContext, root, readiness, key) {
    const page = await browserContext.newPage();
    try {
        const url = `${root}${key}`;
        const start = timing();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const result = await readiness(page, { mode: "content", maxWait: 3200, minimumObserveMs: 500 });
        const extracted = extractContent(await page.content(), url).content;
        return { elapsed: Math.round(timing() - start), waitMs: result.waited, complete: result.complete, hash: freeze(extracted), full: extracted.includes("Final paragraph") && extracted.includes("original event details") };
    } finally {
        await page.close();
    }
}

async function experiment(origin, readiness, compareMemory) {
    const launchStarted = timing();
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 880, height: 720 } });
    const setupMs = Math.round(timing() - launchStarted);
    const browserSession = await browser.newBrowserCDPSession();
    const memory = async () => compareMemory ? await browserMemory(browserSession) : null;
    try {
        const beforeBrowser = await memory();
        const firstPage = await captureContent(context, origin, readiness, "/static?cold=1");
        const staticResults = [];
        for (let sample = 0; sample < 5; sample++) staticResults.push(await captureContent(context, origin, readiness, `/static?sample=${sample}`));
        const late = await captureContent(context, origin, readiness, "/late");
        const cover = await context.newPage();
        await cover.goto(origin + "/cover", { waitUntil: "domcontentloaded" });
        const visibleCover = await readiness(cover, { mode: "visual", maxWait: 4000 });
        const width = await cover.evaluate(() => document.querySelector("img")?.naturalWidth ?? 0);
        await cover.close();

        const [borrowed, heavy] = await Promise.all([context.newPage(), context.newPage()]);
        await heavy.addInitScript(() => {
            window.studyFullLists = 0;
            const originalQuery = Element.prototype.querySelectorAll;
            Element.prototype.querySelectorAll = function (selector) {
                const result = originalQuery.call(this, selector);
                if (selector === "*") window.studyFullLists += result.length;
                return result;
            };
        });
        await Promise.all([borrowed.goto(origin + "/tiles"), heavy.goto(origin + "/heavy")]);
        const renderer = await context.newCDPSession(borrowed);
        await renderer.send("Performance.enable");
        const memoryRounds = [];
        const rounds = [];
        for (let round = 0; round < 3; round++) {
            const [tileResult, heavyResult] = await Promise.all([
                readiness(borrowed, { mode: "visual", maxWait: 4800 }),
                readiness(heavy, { mode: "visual", maxWait: 4800, minimumObserveMs: 500 }),
            ]);
            const tilesAfter = await inspectProbes(borrowed);
            const heavyAfter = await inspectProbes(heavy);
            await renderer.send("HeapProfiler.collectGarbage");
            const metrics = (await renderer.send("Performance.getMetrics")).metrics;
            const heap = metrics.find(metric => metric.name === "JSHeapUsedSize")?.value;
            rounds.push({ tilesAfter, heavyAfter, tileResult, heavyResult, heap });
            const browserSample = await memory();
            if (browserSample) memoryRounds.push(browserSample);
        }
        await renderer.detach();
        await Promise.all([borrowed.close(), heavy.close()]);
        await new Promise(resolve => setTimeout(resolve, 180));
        const afterBrowser = await memory();

        const pending = await context.newPage();
        await pending.goto(origin + "/slow-probe", { waitUntil: "domcontentloaded" });
        const timeoutResult = await readiness(pending, { mode: "visual", maxWait: 440 });
        const afterTimeout = await inspectProbes(pending);
        await pending.close();
        return {
            statics: staticResults, firstPage, setupMs,
            late, width, cover: visibleCover, rounds, timeoutResult, afterTimeout,
            pagesAfter: context.pages().length, beforeBrowser, memoryRounds, afterBrowser,
        };
    } finally {
        await browserSession.detach().catch(() => undefined);
        await context.close();
        await browser.close();
    }
}

test("ready text, late content and visual probes under the same headless Edge workload", { timeout: 155000 }, async () => {
    const timers = new Set();
    const server = http.createServer((request, response) => {
        const route = new URL(request.url, "http://127.0.0.1").pathname;
        const send = (body, contentType = "text/html", delay = 0) => {
            const finish = () => {
                response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
                response.end(body);
            };
            if (!delay) finish();
            else {
                const timer = setTimeout(() => { timers.delete(timer); finish(); }, delay);
                timers.add(timer);
            }
        };
        if (route === "/pixels") return send(picture, "image/svg+xml", 140);
        if (route === "/slow-pixels") return send(picture, "image/svg+xml", 1500);
        if (route === "/static") return send(shell("<article>" + story + "</article>"));
        if (route === "/late") return send(shell('<article aria-busy="true"></article><script>setTimeout(() => { const box = document.querySelector("article"); box.innerHTML = ' + JSON.stringify(story) + '; box.removeAttribute("aria-busy"); }, 1200);</script>'));
        if (route === "/cover") return send(shell('<div id="cover"></div><script>setTimeout(() => { document.getElementById("cover").innerHTML = "<img width=320 height=140 src=/pixels?id=cover>"; }, 900);</script>'));
        if (route === "/tiles") return send(shell(tiles));
        if (route === "/heavy") return send(shell("<article>" + story + "</article>" + fragments));
        if (route === "/slow-probe") return send(shell('<style>.block{width:120px;height:40px}</style><div class="block"></div><script>setTimeout(() => document.querySelector(".block").style.backgroundImage = "url(/slow-pixels)", 65);</script>'));
        response.writeHead(204); response.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const baselineDir = process.env.WEB_FETCHER_READINESS_BASELINE;
    try {
        const runBaseline = async () => {
            if (!baselineDir) return undefined;
            const legacy = await import(pathToFileURL(path.join(baselineDir, "readiness.js")).href);
            return experiment(origin, legacy.waitForPageReadiness, true);
        };
        const runCandidate = () => experiment(origin, waitForPageReadiness, Boolean(baselineDir));
        const reverse = process.env.WEB_FETCHER_TEST_CANDIDATE_FIRST === "1";
        const first = await (reverse ? runCandidate() : runBaseline());
        const second = await (reverse ? runBaseline() : runCandidate());
        const [baseline, candidate] = reverse ? [second, first] : [first, second];
        assert.equal(candidate.pagesAfter, 0);
        assert.equal(candidate.late.full, true);
        assert.equal(candidate.width, 320);
        assert.equal(candidate.cover.complete, true);
        assert.ok(candidate.firstPage.complete && candidate.firstPage.full);
        assert.ok(candidate.statics.every(row => row.complete && row.full));
        for (const round of candidate.rounds) {
            assert.equal(round.tilesAfter.retainedImages, 0);
            assert.equal(round.tilesAfter.activeRuns, 0);
            assert.equal(round.tileResult.ready, 64);
            assert.equal(round.tileResult.complete, true);
            assert.equal(round.heavyAfter.fullElementLists, 0);
            assert.equal(round.heavyResult.scanLimited, true);
            assert.equal(round.heavyResult.complete, false);
        }
        assert.equal(candidate.timeoutResult.complete, false);
        assert.equal(candidate.afterTimeout.retainedImages, 0);
        assert.equal(candidate.afterTimeout.activeRuns, 0);
        const summarize = data => ({
            coldBrowserAndFirstArticleMs: data.setupMs + data.firstPage.elapsed,
            coldBrowserAndContextMs: data.setupMs,
            coldArticle: data.firstPage,
            staticMedianMs: median(data.statics.map(row => row.elapsed)),
            staticWaitMedianMs: median(data.statics.map(row => row.waitMs)),
            markdownHash: data.statics[0].hash,
            late: data.late, coverReady: data.cover.complete,
            rounds: data.rounds.map(round => ({ retainedImages: round.tilesAfter.retainedImages, hFullElementLists: round.heavyAfter.fullElementLists, heapBytes: round.heap })),
            beforeBrowser: data.beforeBrowser, memoryRounds: data.memoryRounds, afterBrowser: data.afterBrowser, pagesAfter: data.pagesAfter,
        });
        console.log(JSON.stringify({ baseline: baseline && summarize(baseline), candidate: summarize(candidate) }));
        if (baseline) {
            assert.equal(candidate.firstPage.hash, baseline.firstPage.hash);
            assert.deepEqual(candidate.statics.map(row => row.hash), baseline.statics.map(row => row.hash));
            assert.ok(baseline.rounds.every(round => round.tilesAfter.retainedImages > 0));
            assert.ok(baseline.rounds.every(round => round.heavyAfter.fullElementLists > 0));
        }
    } finally {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
