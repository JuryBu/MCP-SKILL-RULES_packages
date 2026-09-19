import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test, { after } from "node:test";

const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, "browser-auth-review-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
const { BrowserAuthState, installOriginStorage } = await import("../src/browser-auth-state.ts");
const { cookieStorageKey, saveLocalStorageToBackup } = await import("../src/chrome-helper.ts");
const { COOKIES_BACKUP_FILE, BROWSER_USER_DATA_DIR } = await import("../src/constants.ts");
const { browserManager } = await import("../src/browser.ts");
const cookie = value => ({ name: "review_session", value, domain: "review.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
const context = initial => {
    const values = new Map(initial.map(item => [cookieStorageKey(item), item]));
    return {
        async cookies() { return structuredClone([...values.values()]); },
        async addCookies(items) { for (const item of items) values.set(cookieStorageKey(item), structuredClone(item)); },
        async clearCookies() { values.clear(); },
    };
};
after(() => {
    assert.equal(path.dirname(path.resolve(root)), tempBase);
    assert.ok(path.basename(root).startsWith("browser-auth-review-"));
    fs.rmSync(root, { recursive: true, force: true });
});

test("review: a second local cookie rotation must survive two consecutive saves", async () => {
    fs.writeFileSync(COOKIES_BACKUP_FILE, JSON.stringify([cookie("synthetic-base")]));
    const target = context([]);
    const auth = new BrowserAuthState();
    await auth.refresh(target);
    await target.addCookies([cookie("synthetic-first")]);
    await auth.save(target);
    await target.addCookies([cookie("synthetic-second")]);
    await auth.save(target);
    assert.equal(JSON.parse(fs.readFileSync(COOKIES_BACKUP_FILE, "utf8"))[0].value, "synthetic-second");
});

test("review: persistent init script must not roll back a freshly rotated localStorage token", async () => {
    saveLocalStorageToBackup("https://review.test", { auth_token: "synthetic-old" });
    let installed;
    await installOriginStorage({ async addInitScript(callback, argument) { installed = { callback, argument }; } }, "https://review.test/");
    const values = new Map();
    const runDocumentInit = () => vm.runInNewContext(`(${installed.callback.toString()})(argument)`, {
        argument: installed.argument,
        location: { origin: "https://review.test" },
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    });
    runDocumentInit();
    values.set("auth_token", "synthetic-refreshed-by-site");
    runDocumentInit();
    assert.equal(values.get("auth_token"), "synthetic-refreshed-by-site");
});

function challengePage() {
    return {
        closed: false,
        async evaluate() { return { title: "Just a moment", visibleText: "checking your browser", html: '<script src="/cdn-cgi/challenge-platform/test.js"></script>', scriptUrls: [], iframeUrls: [] }; },
        frames() { return []; },
        async close() { this.closed = true; },
    };
}

async function withUavRetry(retry, run) {
    const original = { getContext: browserManager.getContext, createManagedPage: browserManager.createManagedPage, userAssistedVerification: browserManager.userAssistedVerification, waitForContentReady: browserManager.waitForContentReady };
    browserManager.getContext = async () => ({ async newPage() { return retry; } });
    browserManager.createManagedPage = async () => retry;
    browserManager.userAssistedVerification = async () => true;
    browserManager.waitForContentReady = async () => undefined;
    browserManager.uavAttemptedDomains.clear();
    try { await run(); }
    finally { Object.assign(browserManager, original); browserManager.uavAttemptedDomains.clear(); }
}

test("review: HTTP 403 retry cannot be reported as verified access", async () => {
    const page = challengePage();
    const retry = {
        async addInitScript() {},
        async goto() { return { status() { return 403; }, ok() { return false; } }; },
        url() { return "https://review.test/"; },
        async evaluate() { return { title: "Forbidden", visibleText: "Forbidden", html: "<h1>Forbidden</h1>", scriptUrls: [], iframeUrls: [] }; },
        async waitForTimeout() {},
        async close() {},
    };
    await withUavRetry(retry, async () => {
        await assert.rejects(browserManager.checkAndHandleVerification(page, "https://review.test/"), /ERR_HUMAN_VERIFICATION_PENDING/);
    });
});

test("review: retry navigation failure cannot return the already closed original page", async () => {
    const page = challengePage();
    const retry = { async addInitScript() {}, async goto() { throw new Error("synthetic navigation timeout"); }, async close() {} };
    await withUavRetry(retry, async () => {
        await assert.rejects(browserManager.checkAndHandleVerification(page, "https://review.test/"));
    });
});

test("review: failed normal-browser persistence must preserve its only on-disk profile", async () => {
    fs.mkdirSync(BROWSER_USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(BROWSER_USER_DATA_DIR, "synthetic-recovery-marker"), "synthetic");
    const originalAuth = browserManager.authState;
    browserManager.context = { async close() {} };
    browserManager.authState = { async save() { throw new Error("synthetic disk error"); } };
    try {
        await browserManager.close();
        assert.equal(fs.existsSync(BROWSER_USER_DATA_DIR), true);
    } finally { browserManager.authState = originalAuth; browserManager.context = null; }
});
