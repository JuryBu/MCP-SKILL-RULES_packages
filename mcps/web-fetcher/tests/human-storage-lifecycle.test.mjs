import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const tempBase = path.resolve(os.tmpdir());
const testRoot = await fs.mkdtemp(path.join(tempBase, "human-storage-lifecycle-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(testRoot, "backup");
process.env.TEMP = testRoot;
process.env.TMP = testRoot;
process.env.TMPDIR = testRoot;
const { humanBrowserManager } = await import("../src/human-browser/manager.ts");
const { desktopManager } = await import("../src/desktop/manager.ts");
const { sessionManager } = await import("../src/session.ts");
const { COOKIES_BACKUP_FILE, LOCALSTORAGE_BACKUP_FILE } = await import("../src/constants.ts");
const ownerId = "synthetic-human-storage-test";
const liveTest = (name, options, run) => test(name, {
    ...options, skip: process.env.WEB_FETCHER_LIVE_LOGIN_TEST !== "1",
}, run);
const contexts = new Set();
const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Synthetic storage fixture</title><main>Local isolated test, no automatic login</main>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function eventually(check, timeout = 35_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(100);
    }
    assert.fail("condition did not become true within the test deadline");
}

async function freePort() {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
}

async function syntheticLogin(page, token, storage = "both") {
    await page.evaluate(({ token, storage }) => {
        if (storage !== "localStorage") document.cookie = `fixture_auth=${token}; Path=/; Max-Age=3600; SameSite=Lax`;
        if (storage !== "cookie") localStorage.setItem("fixture_auth", token);
    }, { token, storage });
}

async function readSaved() {
    const cookies = JSON.parse(await fs.readFile(COOKIES_BACKUP_FILE, "utf8").catch(() => "[]"));
    const localStorage = JSON.parse(await fs.readFile(LOCALSTORAGE_BACKUP_FILE, "utf8").catch(() => "{}"));
    return { cookies, localStorage };
}

async function openOwned() {
    const info = await humanBrowserManager.open({ startUrl: origin, ownerId, waitMs: 8000 });
    const session = humanBrowserManager.sessions.get(info.humanSessionId);
    let page;
    await eventually(() => {
        page = session.cdpBrowser.contexts()[0].pages().find(candidate => candidate.url().startsWith(origin));
        return Boolean(page);
    }, 8000);
    assert.ok(page);
    assert.ok(session.chrome.tempProfile.startsWith(testRoot + path.sep));
    return { session, page, info };
}

after(async () => {
    await humanBrowserManager.closeAll();
    await desktopManager.closeAll();
    for (const context of contexts) await context.close().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(testRoot)), tempBase);
    assert.ok(path.basename(testRoot).startsWith("human-storage-lifecycle-"));
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

liveTest("borrowed Edge CDP uses ongoing serial persistence and close only detaches", { timeout: 40_000 }, async () => {
    const port = await freePort();
    const profile = path.join(testRoot, "borrowed-edge");
    const context = await chromium.launchPersistentContext(profile, {
        channel: "msedge", headless: true, args: [`--remote-debugging-port=${port}`],
    });
    contexts.add(context);
    const page = context.pages()[0];
    await page.goto(origin);
    const info = await humanBrowserManager.attach({ port, ownerId });
    const session = humanBrowserManager.sessions.get(info.humanSessionId);
    const observedContext = session.cdpBrowser.contexts()[0];
    const originalCookies = observedContext.cookies.bind(observedContext);
    let active = 0;
    let maximum = 0;
    observedContext.cookies = async (...args) => {
        active++;
        maximum = Math.max(maximum, active);
        try { await delay(150); return await originalCookies(...args); }
        finally { active--; }
    };
    await syntheticLogin(page, "synthetic-periodic");
    await eventually(async () => (await readSaved()).cookies.some(cookie => cookie.value === "synthetic-periodic"), 10_000);
    await Promise.all([
        humanBrowserManager.describe(info.humanSessionId, ownerId),
        humanBrowserManager.describe(info.humanSessionId, ownerId),
    ]);
    assert.equal(maximum, 1);
    const status = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    assert.ok(status.storageSnapshot.savedAt);
    assert.ok(status.storageSnapshot.savedCookieCount > 0);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-periodic/);
    assert.equal(await humanBrowserManager.close(info.humanSessionId, "wrong-owner"), false);
    assert.equal(await humanBrowserManager.close(info.humanSessionId, ownerId), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("fixture_auth")), "synthetic-periodic");
    assert.ok(await fs.stat(profile));
    assert.equal(session.tracker.stopped, true);
    const borrowedAgain = await humanBrowserManager.attach({ port, ownerId });
    const secondSession = humanBrowserManager.sessions.get(borrowedAgain.humanSessionId);
    await context.close();
    contexts.delete(context);
    const ended = await humanBrowserManager.describe(borrowedAgain.humanSessionId, ownerId);
    assert.equal(ended.alive, false);
    assert.ok(ended.storageSnapshot.savedAt);
    assert.ok(ended.storageSnapshot.savedCookieCount > 0);
    assert.equal(secondSession.recovery, undefined);
    await humanBrowserManager.close(borrowedAgain.humanSessionId, ownerId);
    assert.ok(await fs.stat(profile));
});

liveTest("owned tool close awaits fresh save before browser shutdown", { timeout: 30_000 }, async () => {
    const { session, page, info } = await openOwned();
    await syntheticLogin(page, "synthetic-tool-close");
    assert.equal(await humanBrowserManager.close(info.humanSessionId, ownerId), true);
    const saved = await readSaved();
    assert.ok(saved.cookies.some(cookie => cookie.value === "synthetic-tool-close"));
    assert.equal(saved.localStorage[origin].fixture_auth, "synthetic-tool-close");
    assert.ok(session.chrome.process.exitCode !== null || session.chrome.process.signalCode !== null);
    assert.equal(session.tracker.stopped, true);
    assert.equal(session.chrome.process.listenerCount("exit"), 0);
});

liveTest("manual owned shutdown recovers final unsampled state and retains evidence on later status", { timeout: 55_000 }, async () => {
    const { session, page, info } = await openOwned();
    const registered = await humanBrowserManager.registerPage(info.humanSessionId, undefined, ownerId);
    assert.ok(sessionManager.sessions.has(registered.sessionId));
    await session.tracker.stop();
    await syntheticLogin(page, "synthetic-manual-close");
    const control = await session.cdpBrowser.newBrowserCDPSession();
    await control.send("Browser.close").catch(() => undefined);
    await eventually(() => session.chrome.process.exitCode !== null || session.chrome.process.signalCode !== null, 10_000);
    await humanBrowserManager.describe(info.humanSessionId, ownerId);
    if (session.recovery) await session.recovery;
    const status = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    const saved = await readSaved();
    assert.equal(status.alive, false);
    assert.equal(sessionManager.sessions.has(registered.sessionId), false);
    assert.ok(status.storageSnapshot.savedAt);
    assert.ok(status.storageSnapshot.savedCookieCount > 0);
    assert.equal(status.storageSnapshot.recoveryPending, false);
    assert.ok(saved.cookies.some(cookie => cookie.value === "synthetic-manual-close"));
    assert.equal(saved.localStorage[origin].fixture_auth, "synthetic-manual-close");
    assert.doesNotMatch(JSON.stringify(status), /synthetic-manual-close/);
    const again = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    assert.equal(again.storageSnapshot.savedAt, status.storageSnapshot.savedAt);
    await humanBrowserManager.close(info.humanSessionId, ownerId);
});

liveTest("localStorage-only manual shutdown exports state without inventing cookies", { timeout: 55_000 }, async () => {
    const { session, page, info } = await openOwned();
    await session.tracker.stop();
    await syntheticLogin(page, "synthetic-ls-only", "localStorage");
    const control = await session.cdpBrowser.newBrowserCDPSession();
    await control.send("Browser.close").catch(() => undefined);
    await eventually(() => session.chrome.process.exitCode !== null || session.chrome.process.signalCode !== null, 10_000);
    await humanBrowserManager.describe(info.humanSessionId, ownerId);
    if (session.recovery) await session.recovery;
    const status = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    assert.equal(status.storageSnapshot.savedCookieCount, 0);
    assert.ok(status.storageSnapshot.localStorageDomains.some(entry => entry.domain === origin));
    assert.ok(status.storageSnapshot.savedAt);
    assert.equal((await readSaved()).localStorage[origin].fixture_auth, "synthetic-ls-only");
    await humanBrowserManager.close(info.humanSessionId, ownerId);
});

liveTest("failed final capture preserves owned profile and prior persisted evidence", { timeout: 35_000 }, async () => {
    const { session, page, info } = await openOwned();
    await syntheticLogin(page, "synthetic-preserve");
    const before = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    const context = session.cdpBrowser.contexts()[0];
    context.cookies = async () => { throw new Error("synthetic unavailable cookies"); };
    page.evaluate = async () => { throw new Error("synthetic unavailable page"); };
    const failed = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    assert.equal(failed.storageSnapshot.savedAt, before.storageSnapshot.savedAt);
    assert.ok(failed.storageSnapshot.errors.length > 0);
    assert.ok(failed.storageSnapshot.savedCookieCount > 0);
    await humanBrowserManager.close(info.humanSessionId, ownerId);
    assert.ok(await fs.stat(session.chrome.tempProfile));
    assert.ok((await readSaved()).cookies.some(cookie => cookie.value === "synthetic-preserve"));
});

liveTest("CDP disconnection alone never recovers or terminates an owned running process", { timeout: 30_000 }, async () => {
    const { session, page, info } = await openOwned();
    await syntheticLogin(page, "synthetic-disconnect");
    const before = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    await session.cdpBrowser.close();
    await delay(200);
    assert.equal(session.chrome.process.exitCode, null);
    assert.equal(session.chrome.process.signalCode, null);
    assert.equal(session.recovery, undefined);
    const status = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    assert.equal(status.storageSnapshot.savedAt, before.storageSnapshot.savedAt);
    assert.equal(session.tracker.stopped, true);
    await humanBrowserManager.close(info.humanSessionId, ownerId);
    assert.ok(await fs.stat(session.chrome.tempProfile));
});

liveTest("managed detach leaves original Chrome alive and keeps its private profile", { timeout: 30_000 }, async () => {
    const { session, page, info } = await openOwned();
    await syntheticLogin(page, "synthetic-detach", "cookie");
    const endpoint = session.endpoint;
    await humanBrowserManager.detach(info.humanSessionId, ownerId);
    assert.equal(session.chrome.process.exitCode, null);
    assert.ok(await fs.stat(session.chrome.tempProfile));
    assert.equal(session.tracker.stopped, true);
    assert.equal(session.chrome.process.listenerCount("exit"), 0);
    const connection = await chromium.connectOverCDP(endpoint);
    assert.ok((await connection.contexts()[0].cookies()).some(cookie => cookie.value === "synthetic-detach"));
    const control = await connection.newBrowserCDPSession();
    await control.send("Browser.close").catch(() => undefined);
    await connection.close();
    await eventually(() => session.chrome.process.exitCode !== null || session.chrome.process.signalCode !== null, 10_000);
});

liveTest("real backup write failures do not erase saved evidence or delete recovery profile", { timeout: 35_000 }, async () => {
    const { session, page, info } = await openOwned();
    await syntheticLogin(page, "synthetic-write-failure");
    const saved = await humanBrowserManager.describe(info.humanSessionId, ownerId);
    await session.tracker.stop();
    const files = [COOKIES_BACKUP_FILE, LOCALSTORAGE_BACKUP_FILE];
    for (const file of files) {
        assert.equal(path.dirname(file), path.join(testRoot, "backup"));
        await fs.rename(file, `${file}.held`);
        await fs.mkdir(file);
    }
    try {
        const failed = await humanBrowserManager.describe(info.humanSessionId, ownerId);
        assert.equal(failed.storageSnapshot.savedAt, saved.storageSnapshot.savedAt);
        assert.ok(failed.storageSnapshot.errors.length >= 2);
        assert.ok(failed.storageSnapshot.savedCookieCount > 0);
        await humanBrowserManager.close(info.humanSessionId, ownerId);
        assert.ok(await fs.stat(session.chrome.tempProfile));
    } finally {
        for (const file of files) {
            await fs.rmdir(file);
            await fs.rename(`${file}.held`, file);
        }
    }
});
