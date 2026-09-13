import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, "browser-close-storage-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
const { browserManager } = await import("../src/browser.ts");
const { BROWSER_USER_DATA_DIR, LOCALSTORAGE_BACKUP_FILE } = await import("../src/constants.ts");
const markerName = ".web-fetcher-recovery.json";
const originalAuth = browserManager.authState;
const restore = () => { browserManager.context = null; browserManager.bareContext = null; browserManager.authState = originalAuth; };
const resetProfile = () => {
    assert.equal(path.dirname(BROWSER_USER_DATA_DIR), root);
    fs.rmSync(BROWSER_USER_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(BROWSER_USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(BROWSER_USER_DATA_DIR, "synthetic-profile-data"), "test-only");
};
after(async () => {
    restore();
    assert.equal(path.dirname(root), tempBase);
    assert.ok(path.basename(root).startsWith("browser-close-storage-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("failed cookie persistence still closes context and survives repeated cleanup", async () => {
    resetProfile();
    let closes = 0;
    browserManager.context = { async storageState() { return { cookies: [], origins: [] }; }, async close() { closes++; } };
    browserManager.authState = { async save() { throw new Error("synthetic write failure"); }, async saveLocalStorage() { return true; } };
    await browserManager.close();
    assert.equal(closes, 1);
    assert.ok(fs.existsSync(path.join(BROWSER_USER_DATA_DIR, markerName)));
    await browserManager.closeBrowser();
    assert.ok(fs.existsSync(path.join(BROWSER_USER_DATA_DIR, "synthetic-profile-data")));
    restore();
});

test("successful later shutdown does not erase an earlier retained recovery profile", async () => {
    let closes = 0;
    browserManager.context = { async storageState() { return { cookies: [], origins: [] }; }, async close() { closes++; } };
    browserManager.authState = { async save() {}, async saveLocalStorage() { return true; } };
    await browserManager.closeBrowser();
    assert.equal(closes, 1);
    assert.ok(fs.existsSync(path.join(BROWSER_USER_DATA_DIR, markerName)));
    restore();
});

test("localStorage persistence failure retains profile even when cookies were saved", async () => {
    resetProfile();
    let closes = 0;
    browserManager.context = { async storageState() { throw new Error("synthetic storage state unavailable"); }, async close() { closes++; } };
    browserManager.authState = { async save() {}, async saveLocalStorage() { return false; } };
    await browserManager.close();
    assert.equal(closes, 1);
    assert.ok(fs.existsSync(path.join(BROWSER_USER_DATA_DIR, markerName)));
    restore();
});

test("successful storage save and close permit cleanup without full-cookie replay", async () => {
    resetProfile();
    let cookieSaves = 0;
    let closes = 0;
    browserManager.context = {
        async storageState() { return { cookies: [{ name: "do-not-replay", value: "synthetic-old" }], origins: [{ origin: "https://close.test", localStorage: [{ name: "auth", value: "synthetic-ls" }] }] }; },
        async close() { closes++; },
    };
    browserManager.authState = { async save() { cookieSaves++; }, saveLocalStorage: context => originalAuth.saveLocalStorage(context) };
    await Promise.all([browserManager.close(), browserManager.closeBrowser()]);
    assert.equal(cookieSaves, 1);
    assert.equal(closes, 1);
    assert.equal(fs.existsSync(BROWSER_USER_DATA_DIR), false);
    assert.equal(JSON.parse(fs.readFileSync(LOCALSTORAGE_BACKUP_FILE, "utf8"))["https://close.test"].auth, "synthetic-ls");
    assert.equal(fs.existsSync(path.join(root, "cookies-backup.json")), false);
    restore();
});

test("a fresh process skips a marked orphan but cleans an unmarked dead profile", () => {
    const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
    assert.equal(probe.status, 0);
    const deadPid = Number(probe.stdout);
    assert.throws(() => process.kill(deadPid, 0));
    const orphan = path.join(root, `profile-${deadPid}`);
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, markerName), JSON.stringify({ version: 1, reason: "synthetic-failure" }));
    const code = "const {browserManager}=await import('./src/browser.ts'); browserManager.cleanStaleProfiles();";
    const marked = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true, env: process.env });
    assert.equal(marked.status, 0, marked.stderr);
    assert.ok(fs.existsSync(orphan));
    fs.unlinkSync(path.join(orphan, markerName));
    const clean = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true, env: process.env });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(fs.existsSync(orphan), false);
});

test("real Edge exports localStorage after the source page is already closed", { skip: process.env.WEB_FETCHER_LIVE_LOGIN_TEST !== "1", timeout: 45_000 }, async () => {
    resetProfile();
    const { chromium } = await import("playwright");
    const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<title>Synthetic closed-page fixture</title><main>isolated</main>"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let context;
    try {
        context = await chromium.launchPersistentContext(BROWSER_USER_DATA_DIR, { channel: "msedge", headless: true });
        const page = context.pages()[0];
        await page.goto(origin);
        await page.evaluate(() => localStorage.setItem("closed_page_auth", "synthetic-final"));
        await page.close();
        browserManager.context = context;
        await browserManager.close();
        assert.equal(JSON.parse(fs.readFileSync(LOCALSTORAGE_BACKUP_FILE, "utf8"))[origin].closed_page_auth, "synthetic-final");
        assert.equal(fs.existsSync(BROWSER_USER_DATA_DIR), false);
    } finally {
        if (context) await context.close().catch(() => undefined);
        restore();
        await new Promise(resolve => server.close(resolve));
    }
});
