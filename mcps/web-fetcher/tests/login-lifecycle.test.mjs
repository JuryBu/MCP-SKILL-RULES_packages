import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "login-lifecycle-unit-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
const helper = await import("../src/chrome-helper.ts");
const { StorageSnapshotTracker } = await import("../src/storage-snapshot-tracker.ts");
const { COOKIES_BACKUP_FILE, LOCALSTORAGE_BACKUP_FILE } = await import("../src/constants.ts");
assert.equal(path.dirname(COOKIES_BACKUP_FILE), root);
const cookie = value => ({ domain: "login.example.test", name: "synthetic-session", path: "/", value });
const context = (cookies, data = {}) => ({
    cookies: async () => cookies,
    pages: () => [{ url: () => "https://login.example.test/path?secret=synthetic", isClosed: () => false, evaluate: async () => ({ origin: "https://login.example.test", data }) }],
});
beforeEach(async () => {
    for (const file of [COOKIES_BACKUP_FILE, LOCALSTORAGE_BACKUP_FILE]) await fs.rm(file, { recursive: true, force: true });
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("capture and persistence evidence are separate", async () => {
    const result = await helper.snapshotBrowserStorage(context([cookie("fresh")], { login: "synthetic" }));
    assert.equal(result.cookieCount, 1);
    assert.equal(result.savedCookieCount, 1);
    assert.ok(result.savedAt && result.capturedAt);
    assert.deepEqual(result.localStorageDomains, [{ domain: "https://login.example.test", keyCount: 1 }]);
});

test("write failure does not claim saved cookies or expose error contents", async () => {
    await fs.mkdir(COOKIES_BACKUP_FILE);
    const result = await helper.snapshotBrowserStorage(context([cookie("secret-value")]), { totalTimeoutMs: 100 });
    assert.equal(result.cookieCount, 1);
    assert.equal(result.savedCookieCount, 0);
    assert.equal(result.savedAt, undefined);
    assert.ok(result.errors.length);
    assert.ok(!JSON.stringify(result.errors).includes("secret-value"));
});

test("localStorage-only and telemetry-only reports remain distinct", async () => {
    const saved = await helper.snapshotBrowserStorage(context([], { metis: "synthetic" }));
    assert.equal(saved.savedCookieCount, 0);
    assert.equal(saved.localStorageDomains.length, 1);
    const telemetry = await helper.snapshotBrowserStorage(context([], { __BEACON_test: "unused" }));
    assert.equal(telemetry.localStorageDomains.length, 0);
    assert.equal(telemetry.savedAt, undefined);
});

test("origin isolation and HTTPS-only legacy fallback", () => {
    helper.saveLocalStorageToBackup("login.example.test", { legacy: "synthetic" });
    assert.deepEqual(helper.getLocalStorageForOrigin("https://login.example.test"), { legacy: "synthetic" });
    assert.equal(helper.getLocalStorageForOrigin("http://login.example.test"), null);
    assert.equal(helper.getLocalStorageForOrigin("https://login.example.test:8443"), null);
    helper.saveLocalStorageToBackup("http://login.example.test:8080", { exact: "synthetic" });
    assert.deepEqual(helper.getLocalStorageForOrigin("http://login.example.test:8080"), { exact: "synthetic" });
    assert.equal(helper.getLocalStorageForOrigin("file:///tmp/example"), null);
});

test("internal restore revision is neither persisted nor counted", async () => {
    const marker = "__mcp_web_fetcher_restore_revision__";
    await fs.writeFile(LOCALSTORAGE_BACKUP_FILE, JSON.stringify({ "https://login.example.test": { [marker]: "previously-exported" } }));
    const markerOnly = await helper.snapshotBrowserStorage(context([], { [marker]: "synthetic-revision" }));
    assert.equal(markerOnly.savedAt, undefined);
    assert.deepEqual(markerOnly.localStorageDomains, []);
    assert.equal(helper.getLocalStorageForOrigin("https://login.example.test")[marker], undefined);
    const mixed = await helper.snapshotBrowserStorage(context([], {
        [marker]: "synthetic-revision", token: "synthetic-token",
        __mcp_web_fetcher_restore_revision__custom: "site-owned",
    }));
    assert.deepEqual(mixed.localStorageDomains, [{ domain: "https://login.example.test", keyCount: 2 }]);
    const saved = helper.getLocalStorageForOrigin("https://login.example.test");
    assert.equal(saved[marker], undefined);
    assert.equal(saved.token, "synthetic-token");
    assert.equal(saved.__mcp_web_fetcher_restore_revision__custom, "site-owned");
});

test("navigation between URL lookup and capture cannot write into the wrong origin", async () => {
    const facade = context([]);
    facade.pages = () => [{ url: () => "https://login.example.test", evaluate: async () => ({ origin: "https://other.example.test", data: { token: "synthetic" } }) }];
    const result = await helper.snapshotBrowserStorage(facade);
    assert.equal(result.savedAt, undefined);
    assert.equal(result.localStorageDomains.length, 0);
    assert.deepEqual(result.errors, ["localStorage: origin changed during capture"]);
    assert.equal(helper.getLocalStorageForOrigin("https://login.example.test"), null);
});

test("three-way cookie merge protects a newer writer", async () => {
    const baseline = [cookie("old")];
    helper.saveCookiesToBackup(baseline);
    helper.saveCookiesToBackup([cookie("new-login")]);
    helper.saveCookiesToBackup([cookie("stale-refresh"), { ...cookie("additional"), name: "new-key" }], baseline);
    const saved = JSON.parse(await fs.readFile(COOKIES_BACKUP_FILE, "utf8"));
    assert.equal(saved.find(entry => entry.name === "synthetic-session").value, "new-login");
    assert.equal(saved.find(entry => entry.name === "new-key").value, "additional");
    helper.saveCookiesToBackup([cookie("explicit")]);
    assert.equal(JSON.parse(await fs.readFile(COOKIES_BACKUP_FILE, "utf8"))[0].value, "explicit");
});

test("accepted-cookie evidence advances local baseline across consecutive rotations", async () => {
    let baseline = [cookie("old")];
    helper.saveCookiesToBackup(baseline);
    const first = helper.saveCookieChangesToBackup([cookie("new1")], baseline);
    assert.equal(first.total, 1);
    assert.deepEqual(first.acceptedCookies, [cookie("new1")]);
    baseline = helper.mergeCookies(baseline, first.acceptedCookies);
    const second = helper.saveCookieChangesToBackup([cookie("new2")], baseline);
    assert.deepEqual(second.acceptedCookies, [cookie("new2")]);
    assert.equal(JSON.parse(await fs.readFile(COOKIES_BACKUP_FILE, "utf8"))[0].value, "new2");
    baseline = helper.mergeCookies(baseline, second.acceptedCookies);
    helper.saveCookiesToBackup([cookie("external-login")]);
    const rejected = helper.saveCookieChangesToBackup([cookie("new3")], baseline);
    assert.deepEqual(rejected.acceptedCookies, []);
    assert.equal(rejected.total, 1);
    assert.equal(baseline[0].value, "new2");
    assert.equal(JSON.parse(await fs.readFile(COOKIES_BACKUP_FILE, "utf8"))[0].value, "external-login");
});

test("accepted-cookie result excludes rejected keys and does not alias input", () => {
    const baseline = [cookie("old")];
    helper.saveCookiesToBackup([cookie("external")]);
    const additional = { ...cookie("additional"), name: "second-key" };
    const result = helper.saveCookieChangesToBackup([cookie("stale"), additional], baseline);
    assert.equal(result.total, 2);
    assert.deepEqual(result.acceptedCookies, [additional]);
    result.acceptedCookies[0].value = "mutated-result";
    assert.equal(additional.value, "additional");
});

test("two synthetic contexts cannot roll back a newer localStorage login", async () => {
    const origin = "https://login.example.test";
    const baseline = { token: "initial", unchanged: "site-config" };
    helper.saveLocalStorageToBackup(origin, baseline);
    const [newLogin, oldContextClose] = await Promise.all([
        Promise.resolve().then(() => helper.saveLocalStorageChangesToBackup(origin, { token: "new-login" }, baseline)),
        Promise.resolve().then(() => helper.saveLocalStorageChangesToBackup(origin, { token: "old-context-refresh", localPreference: "dark", unchanged: "site-config" }, baseline)),
    ]);
    assert.deepEqual(newLogin, { acceptedValues: { token: "new-login" }, rejectedKeys: [] });
    assert.deepEqual(oldContextClose, { acceptedValues: { localPreference: "dark" }, rejectedKeys: ["token"] });
    assert.deepEqual(helper.getLocalStorageForOrigin(origin), { token: "new-login", unchanged: "site-config", localPreference: "dark" });
});

test("accepted localStorage changes advance baseline without accepting unrelated external state", () => {
    const origin = "http://login.example.test:8080";
    let baseline = { token: "initial" };
    helper.saveLocalStorageToBackup(origin, baseline);
    for (const token of ["new1", "new2"]) {
        const result = helper.saveLocalStorageChangesToBackup(origin, { token }, baseline);
        assert.deepEqual(result, { acceptedValues: { token }, rejectedKeys: [] });
        baseline = { ...baseline, ...result.acceptedValues };
    }
    helper.saveLocalStorageToBackup(origin, { token: "external-login" });
    assert.deepEqual(helper.saveLocalStorageChangesToBackup(origin, { token: "new3" }, baseline), { acceptedValues: {}, rejectedKeys: ["token"] });
    assert.equal(baseline.token, "new2");
    assert.equal(helper.getLocalStorageForOrigin(origin).token, "external-login");
});

test("localStorage CAS supports secure legacy baseline and exact marker filtering", () => {
    const baseline = { token: "legacy", stable: "preserved" };
    helper.saveLocalStorageToBackup("login.example.test", baseline);
    const result = helper.saveLocalStorageChangesToBackup("https://login.example.test", {
        token: "new", stable: "preserved", __mcp_web_fetcher_restore_revision__: "internal", __BEACON_test: "telemetry",
    }, baseline);
    assert.deepEqual(result, { acceptedValues: { token: "new" }, rejectedKeys: [] });
    assert.deepEqual(helper.getLocalStorageForOrigin("https://login.example.test"), { token: "new", stable: "preserved" });
    assert.equal(helper.getLocalStorageForOrigin("http://login.example.test"), null);
    assert.throws(() => helper.saveLocalStorageChangesToBackup("https://login.example.test/path", {}, {}));
});

test("final closed-context failure cannot replace last saved values", async () => {
    let closed = false;
    const facade = context([cookie("fresh")]);
    facade.cookies = async () => { if (closed) throw new Error("secret query"); return [cookie("fresh")]; };
    const tracker = new StorageSnapshotTracker(facade, { intervalMs: 10000 });
    await tracker.start();
    closed = true;
    const saved = await tracker.stop("manual-close");
    assert.equal(saved.savedCookieCount, 1);
    assert.equal(saved.cookies[0].value, "fresh");
    assert.ok(saved.savedAt);
    assert.deepEqual(saved.errors, ["cookies: capture or persistence failed"]);
});

test("slow periodic and explicit snapshots are serialized and drained", async () => {
    let active = 0;
    let peak = 0;
    let count = 0;
    const facade = context([]);
    facade.cookies = async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--; count++;
        return [cookie(String(count))];
    };
    const tracker = new StorageSnapshotTracker(facade, { intervalMs: 10 });
    await tracker.start();
    await new Promise(resolve => setTimeout(resolve, 15));
    const captures = [tracker.capture("extra-one"), tracker.capture("extra-two")];
    const result = await tracker.stop("final");
    await Promise.all(captures);
    assert.equal(peak, 1);
    assert.equal(active, 0);
    assert.equal(result.cookies[0].value, String(count));
    const stoppedCount = count;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(count, stoppedCount);
});

test("total snapshot budget bounds slow multi-page contexts", async () => {
    const slow = { cookies: () => new Promise(() => {}), pages: () => Array.from({ length: 10 }, () => ({ url: () => "https://login.example.test", evaluate: () => new Promise(() => {}) })) };
    const started = Date.now();
    const result = await helper.snapshotBrowserStorage(slow, { totalTimeoutMs: 40 });
    assert.ok(Date.now() - started < 500);
    assert.equal(result.savedCookieCount, 0);
    assert.ok(result.errors.length);
});

test("recovery rejects unknown or live profiles without reading data", async () => {
    const result = await helper.recoverClosedChromeStorage({ ownerToken: "not-owned", process: { exitCode: null, signalCode: null }, tempProfile: root, lockFile: path.join(root, "private"), cdpPort: 0 }, "https://example.test");
    assert.equal(result.savedCookieCount, 0);
    assert.equal(result.savedAt, undefined);
    assert.ok(result.errors.length);
    assert.ok(await fs.stat(root));
});
