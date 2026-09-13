import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

test("default login grants 600 real seconds and restores the final authenticated synthetic page", {
    skip: process.env.WEB_FETCHER_600S_TEST !== "1", timeout: 660000,
}, async () => {
    const parent = path.resolve(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, "web-fetcher-600s-"));
    assert.ok(root.startsWith(parent + path.sep));
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(root, "backups");
    process.env.TEMP = root;
    process.env.TMP = root;
    process.env.TMPDIR = root;
    const helper = await import("../src/chrome-helper.ts");
    const { createLoginSessionRunner } = await import("../src/login-session.ts");
    const runLoginBrowserSession = createLoginSessionRunner({ launch: async options => {
        const chrome = await helper.launchSystemChrome({ ...options, headless: true });
        console.log(JSON.stringify({ event: "owned-chrome-launched", pid: chrome.process.pid, at: new Date().toISOString() }));
        chrome.process.on("exit", (code, signal) => console.log(JSON.stringify({ event: "owned-chrome-exited", code, signal, at: new Date().toISOString() })));
        return chrome;
    } });
    const { BrowserAuthState, installOriginStorage } = await import("../src/browser-auth-state.ts");
    const { chromium } = await import("playwright");
    let firstRequestAt;
    const server = http.createServer((request, response) => {
        firstRequestAt ??= Date.now();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(`<html><body><h1 id="status">not authenticated</h1><script>
            if (document.cookie.includes('synthetic-auth=final') && localStorage.getItem('synthetic-token') === 'final') document.getElementById('status').textContent='authenticated synthetic account';
            </script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/login`;
    let connection;
    let verificationBrowser;
    let lastWrite;
    let writeFailure;
    const started = Date.now();
    const monotonicStarted = performance.now();
    const login = runLoginBrowserSession(url);
    try {
        for (let attempt = 0; attempt < 100 && !connection; attempt++) {
            const entries = await fs.readdir(root, { withFileTypes: true });
            const profile = entries.find(entry => entry.isDirectory() && entry.name.startsWith(`mcp-chrome-login-${process.pid}-`));
            if (profile) {
                const lock = JSON.parse(await fs.readFile(path.join(root, profile.name, ".mcp-web-fetcher-chrome.json"), "utf8"));
                assert.equal(lock.ownerPid, process.pid);
                try { connection = await helper.connectCDP(lock.cdpPort, 500); } catch { }
            }
            if (!connection) await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(connection, "must attach only to this fixture's owned browser");
        const page = connection.contexts()[0].pages()[0];
        await page.waitForURL(url);
        await page.evaluate(() => {
            document.cookie = "synthetic-auth=initial;path=/";
            localStorage.setItem("synthetic-token", "initial");
        });
        console.log(JSON.stringify({ event: "600s-window-ready", startedAt: new Date(started).toISOString(), finalWriteAfterMs: 595000 }));
        lastWrite = setTimeout(() => {
            void page.evaluate(() => {
                document.cookie = "synthetic-auth=final;path=/";
                localStorage.setItem("synthetic-token", "final");
            }).then(() => console.log("final synthetic credentials written near deadline"), error => { writeFailure = error; });
        }, Math.max(1, 595000 - (Date.now() - started)));
        const result = await login;
        const elapsedMs = Date.now() - started;
        console.log(JSON.stringify({ event: "login-result", elapsedMs, monotonicElapsedMs: performance.now() - monotonicStarted, timedOut: result.timedOut, browserClosed: result.browserClosed, savedAt: result.snapshot.savedAt, errors: result.snapshot.errors }));
        assert.ok(elapsedMs >= 600000, `elapsed ${elapsedMs}`);
        assert.ok(Date.now() - firstRequestAt >= 599000, "page must retain almost the full human window");
        assert.equal(writeFailure, undefined);
        assert.equal(result.timedOut, true);
        assert.equal(result.browserClosed, true);
        assert.equal(result.recoveryProfile, undefined);
        assert.deepEqual(result.snapshot.errors, []);
        assert.equal(result.snapshot.cookies.find(cookie => cookie.name === "synthetic-auth").value, "final");
        assert.equal(helper.getLocalStorageForOrigin(new URL(url).origin)["synthetic-token"], "final");
        verificationBrowser = await chromium.launch({ channel: "msedge", headless: true });
        const context = await verificationBrowser.newContext();
        await new BrowserAuthState().refresh(context);
        const restoredPage = await context.newPage();
        await installOriginStorage(restoredPage, url);
        await restoredPage.goto(url);
        assert.equal(await restoredPage.locator("#status").innerText(), "authenticated synthetic account");
        assert.ok((await restoredPage.screenshot()).length > 1000);
        console.log(JSON.stringify({ event: "600s-real-test-passed", elapsedMs, savedAt: result.snapshot.savedAt, browserClosed: result.browserClosed, restoredAuthenticatedPage: true }));
    } finally {
        clearTimeout(lastWrite);
        if (verificationBrowser) await verificationBrowser.close();
        if (connection) {
            if (connection.isConnected()) {
                const session = await connection.newBrowserCDPSession().catch(() => null);
                await session?.send("Browser.close").catch(() => undefined);
            }
            await connection.close().catch(() => undefined);
        }
        await login.catch(() => undefined);
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
