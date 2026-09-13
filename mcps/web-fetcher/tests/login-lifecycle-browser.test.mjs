import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const enabled = process.env.WEB_FETCHER_LIVE_LOGIN_TEST === "1";
const tempParent = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempParent, "login-lifecycle-browser-"));
assert.ok(path.resolve(root).startsWith(tempParent + path.sep));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(root, "backups");
process.env.TEMP = root;
process.env.TMP = root;
process.env.TMPDIR = root;
const helper = await import("../src/chrome-helper.ts");
const { StorageSnapshotTracker } = await import("../src/storage-snapshot-tracker.ts");
const { runLoginBrowserSession } = await import("../src/login-session.ts");
const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(`<html><body>Local synthetic login fixture<script>
        if (!localStorage.getItem('synthetic-login')) localStorage.setItem('synthetic-login','fixture-initial');
        ${request.url === "/cookie" ? "if (!document.cookie.includes('fixture-session=')) document.cookie='fixture-session=initial;path=/;max-age=3600';" : ""}
        </script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function attach(chrome) {
    for (let attempt = 0; attempt < 15; attempt++) {
        try { return await helper.connectCDP(chrome.cdpPort, 1000); }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error("fixture CDP unavailable");
}

test("real Chrome immediate manual close recovers the final cookie and localStorage", { skip: !enabled, timeout: 60000 }, async () => {
    const chrome = await helper.launchSystemChrome({ startUrl: `${origin}/cookie`, profilePrefix: "mcp-chrome-login" });
    let browser;
    let tracker;
    try {
        browser = await attach(chrome);
        const context = browser.contexts()[0];
        const page = context.pages()[0];
        await page.waitForFunction(() => localStorage.getItem("synthetic-login"));
        tracker = new StorageSnapshotTracker(context, { intervalMs: 10000 });
        await tracker.start();
        await page.evaluate(() => {
            localStorage.setItem("synthetic-login", "fixture-final");
            document.cookie = "fixture-session=final;path=/;max-age=3600";
            document.cookie = "fixture-session-only=final;path=/";
        });
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close").catch(() => undefined);
        await helper.waitForChromeClose(chrome.process);
        const beforeRecovery = await tracker.stop();
        assert.equal(beforeRecovery.cookies.find(cookie => cookie.name === "fixture-session").value, "initial");
        const started = Date.now();
        const recovered = await helper.recoverClosedChromeStorage(chrome, `${origin}/cookie`);
        assert.ok(Date.now() - started < 32000);
        assert.deepEqual(recovered.errors, []);
        assert.equal(recovered.recoveryBrowserClosed, true);
        assert.equal(recovered.cookies.find(cookie => cookie.name === "fixture-session").value, "final");
        assert.equal(recovered.cookies.find(cookie => cookie.name === "fixture-session-only").value, "final");
        assert.equal(helper.getLocalStorageForOrigin(origin)["synthetic-login"], "fixture-final");
        assert.ok(recovered.savedAt);
    } finally {
        if (tracker) await tracker.stop();
        if (browser) await browser.close().catch(() => undefined);
        helper.terminateOwnedChrome(chrome);
        await helper.waitForChromeClose(chrome.process);
        helper.cleanupTempProfile(chrome.tempProfile);
    }
});

test("real shared session deadline saves before closing its browser", { skip: !enabled, timeout: 60000 }, async () => {
    const started = Date.now();
    const result = await runLoginBrowserSession(`${origin}/cookie`, { maxRunMs: 4000 });
    assert.ok(Date.now() - started >= 3900);
    assert.ok(Date.now() - started < 20000);
    assert.equal(result.timedOut, true);
    assert.equal(result.browserClosed, true);
    assert.ok(result.snapshot.savedCookieCount > 0);
    assert.ok(result.snapshot.localStorageDomains.some(entry => entry.domain === origin));
    assert.equal(result.recoveryProfile, undefined);
    assert.deepEqual(result.snapshot.errors, []);
});

test("real localStorage-only login is persisted at timeout without claiming cookies", { skip: !enabled, timeout: 60000 }, async () => {
    const result = await runLoginBrowserSession(`${origin}/storage`, { maxRunMs: 4000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.browserClosed, true);
    assert.equal(result.snapshot.savedCookieCount, 0);
    assert.equal(helper.getLocalStorageForOrigin(origin)["synthetic-login"], "fixture-initial");
    assert.ok(result.snapshot.savedAt);
    assert.deepEqual(result.snapshot.errors, []);
    assert.equal(result.recoveryProfile, undefined);
});
