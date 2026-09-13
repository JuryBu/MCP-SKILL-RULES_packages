import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetcher-auth-state-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
const { BrowserAuthState, installOriginStorage } = await import("../src/browser-auth-state.ts");
const { COOKIES_BACKUP_FILE } = await import("../src/constants.ts");
const { saveCookiesToBackup, saveLocalStorageToBackup, cookieStorageKey } = await import("../src/chrome-helper.ts");
const cookie = (name, value) => ({ name, value, domain: "example.test", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" });
function context(initial = []) {
    const values = new Map(initial.map(item => [cookieStorageKey(item), structuredClone(item)]));
    return {
        async cookies() { return structuredClone([...values.values()]); },
        async addCookies(items) { for (const item of items) values.set(cookieStorageKey(item), structuredClone(item)); },
        async clearCookies(filter) {
            for (const [key, item] of values) if (item.name === filter.name && item.domain === filter.domain && item.path === filter.path) values.delete(key);
        },
    };
}
function backup() { return JSON.parse(fs.readFileSync(COOKIES_BACKUP_FILE, "utf8")); }
function reset(items = []) { fs.writeFileSync(COOKIES_BACKUP_FILE, JSON.stringify(items)); }
after(() => {
    assert.ok(path.basename(path.resolve(root)).startsWith("web-fetcher-auth-state-"));
    fs.rmSync(root, { recursive: true, force: true });
});

test("unchanged old context cannot overwrite a new login backup", async () => {
    reset([cookie("session", "old")]);
    const target = context();
    const sync = new BrowserAuthState();
    await sync.refresh(target);
    saveCookiesToBackup([cookie("session", "new")]);
    await sync.save(target);
    assert.equal(backup()[0].value, "new");
    await sync.refresh(target);
    assert.equal((await target.cookies())[0].value, "new");
});

test("three-way save protects newer auth while allowing unrelated local changes", async () => {
    reset([cookie("session", "old")]);
    const target = context();
    const sync = new BrowserAuthState();
    await sync.refresh(target);
    saveCookiesToBackup([cookie("session", "new")]);
    await target.addCookies([cookie("session", "stale-change"), cookie("preference", "blue")]);
    await sync.save(target);
    assert.equal(backup().find(item => item.name === "session").value, "new");
    assert.equal(backup().find(item => item.name === "preference").value, "blue");
    await sync.refresh(target);
    assert.equal((await target.cookies()).find(item => item.name === "session").value, "new");
});

test("refresh imports only changed shared keys and preserves unsaved local edits", async () => {
    reset([cookie("session", "old"), cookie("preference", "red")]);
    const target = context();
    const sync = new BrowserAuthState();
    await sync.refresh(target);
    await target.addCookies([cookie("preference", "blue")]);
    saveCookiesToBackup([cookie("session", "new")]);
    await sync.refresh(target);
    assert.equal((await target.cookies()).find(item => item.name === "preference").value, "blue");
    await sync.save(target);
    assert.equal(backup().find(item => item.name === "preference").value, "blue");
});

test("explicit shared cookie removal propagates without clearing unrelated cookies", async () => {
    reset([cookie("session", "old")]);
    const target = context([cookie("local", "keep")]);
    const sync = new BrowserAuthState();
    await sync.refresh(target);
    reset([]);
    await sync.refresh(target);
    assert.deepEqual((await target.cookies()).map(item => item.name), ["local"]);
});

test("malformed backup does not clear the existing authenticated context", async () => {
    reset([cookie("session", "old")]);
    const target = context();
    const sync = new BrowserAuthState();
    await sync.refresh(target);
    fs.writeFileSync(COOKIES_BACKUP_FILE, "not json");
    await assert.rejects(sync.refresh(target));
    assert.equal((await target.cookies())[0].value, "old");
    reset([cookie("session", "new")]);
    await sync.refresh(target);
    assert.equal((await target.cookies())[0].value, "new");
});

test("concurrent refreshes are serialized per context", async () => {
    reset([cookie("session", "old")]);
    const target = context();
    const original = target.addCookies;
    let active = 0;
    let peak = 0;
    target.addCookies = async items => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        await original(items);
        active -= 1;
    };
    const sync = new BrowserAuthState();
    await Promise.all([sync.refresh(target), sync.refresh(target), sync.save(target)]);
    assert.equal(peak, 1);
});

test("localStorage restore executes only in its exact origin, not redirects or iframes", async () => {
    saveLocalStorageToBackup("https://example.test", { "metis-unified-login-tid": "synthetic" });
    let script;
    await installOriginStorage({ async addInitScript(callback, argument) { script = { callback, argument }; } }, "https://example.test/#/home");
    assert.ok(script);
    for (const origin of ["https://example.test", "http://example.test", "https://example.test:8443", "https://other.test"]) {
        const entries = new Map();
        vm.runInNewContext(`(${script.callback.toString()})(argument)`, {
            argument: script.argument, location: { origin }, localStorage: { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) },
        });
        assert.equal(entries.get("metis-unified-login-tid"), origin === "https://example.test" ? "synthetic" : undefined);
    }
});

test("legacy hostname backup is not replayed to HTTP or another port", async () => {
    saveLocalStorageToBackup("legacy.test", { access_token: "synthetic-legacy" });
    for (const url of ["https://legacy.test/", "http://legacy.test/", "https://legacy.test:8443/", "file:///fixture.html"]) {
        let calls = 0;
        await installOriginStorage({ async addInitScript() { calls += 1; } }, url);
        assert.equal(calls, url === "https://legacy.test/" ? 1 : 0);
    }
});

test("localStorage rotation saves repeatedly but cannot overwrite a newer shared login", async () => {
    const { getLocalStorageForOrigin } = await import("../src/chrome-helper.ts");
    const origin = "https://storage-rotation.test";
    saveLocalStorageToBackup(origin, { auth_token: "base" });
    const values = { auth_token: "base" };
    const target = {
        async storageState() { return { origins: [{ origin, localStorage: Object.entries(values).map(([name, value]) => ({ name, value })) }] }; },
    };
    await installOriginStorage({ async addInitScript() {}, context() { return target; } }, origin);
    const auth = new BrowserAuthState();
    values.auth_token = "first";
    assert.equal(await auth.saveLocalStorage(target), true);
    values.auth_token = "second";
    assert.equal(await auth.saveLocalStorage(target), true);
    assert.equal(getLocalStorageForOrigin(origin).auth_token, "second");
    saveLocalStorageToBackup(origin, { auth_token: "new-shared-login" });
    assert.equal(await auth.saveLocalStorage(target), true);
    assert.equal(getLocalStorageForOrigin(origin).auth_token, "new-shared-login");
    values.auth_token = "stale-local-rotation";
    values.theme = "dark";
    assert.equal(await auth.saveLocalStorage(target), false);
    assert.equal(getLocalStorageForOrigin(origin).auth_token, "new-shared-login");
    assert.equal(getLocalStorageForOrigin(origin).theme, "dark");
});

test("changed shared localStorage revision applies once without reverting later site rotation", async () => {
    const origin = "https://storage-revision.test";
    const values = new Map();
    const install = async () => {
        let installed;
        await installOriginStorage({ async addInitScript(callback, argument) { installed = { callback, argument }; } }, origin);
        return () => vm.runInNewContext(`(${installed.callback.toString()})(argument)`, {
            argument: installed.argument, location: { origin },
            localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        });
    };
    saveLocalStorageToBackup(origin, { auth_token: "old" });
    const first = await install();
    first();
    values.set("auth_token", "site-rotated");
    first();
    assert.equal(values.get("auth_token"), "site-rotated");
    saveLocalStorageToBackup(origin, { auth_token: "new-shared" });
    const second = await install();
    second();
    assert.equal(values.get("auth_token"), "new-shared");
    values.set("auth_token", "site-rotated-again");
    second();
    assert.equal(values.get("auth_token"), "site-rotated-again");
});
