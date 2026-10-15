import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureBrowserStorage, mergeStorageSnapshots, storageOrigin } from "../src/storage-snapshot.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-evidence-unit-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

const origin = "https://login.example.test";
const page = (url, evaluate) => ({ url: () => url, isClosed: () => false, evaluate });
const writers = { saveCookies: cookies => cookies.length, saveLocalStorage: (_origin, values) => Object.keys(values).length };
const context = pages => ({ cookies: async () => [], pages: () => pages });

test("empty storage is a successful read with no invented saved timestamp", async () => {
    const result = await captureBrowserStorage(context([page(origin, async () => ({ origin, data: {} }))]), writers);
    assert.equal(result.cookieEvidence.status, "empty");
    assert.equal(result.originEvidence[0].status, "empty");
    assert.equal(result.savedAt, undefined);
    assert.deepEqual(result.errors, []);
});

test("same-origin alternative page succeeds after a destroyed page", async () => {
    const result = await captureBrowserStorage(context([
        page(origin, async () => { throw new Error("execution context destroyed private-token"); }),
        page(origin, async () => ({ origin, data: { session: "synthetic" } })),
    ]), writers);
    assert.equal(result.originEvidence[0].status, "saved");
    assert.deepEqual(result.errors, []);
});

test("one failed origin cannot hide another successful origin", async () => {
    const second = "https://other.example.test";
    const result = await captureBrowserStorage(context([
        page(origin, async () => { throw new Error("private-token ?secret=123"); }),
        page(second, async () => ({ origin: second, data: { ok: "synthetic" } })),
    ]), writers);
    assert.deepEqual(result.originEvidence.map(entry => entry.status), ["capture-failed", "saved"]);
    assert.equal(result.issues[0].origin, origin);
    assert.ok(!JSON.stringify(result.issues).includes("private-token"));
    assert.ok(!JSON.stringify(result.errors).includes("secret=123"));
});

test("write error is distinguished from browser read error", async () => {
    const result = await captureBrowserStorage(context([page(origin, async () => ({ origin, data: { session: "secret-value" } }))]), {
        ...writers, saveLocalStorage: () => { throw Object.assign(new Error("private path secret-value"), { code: "ENOSPC" }); },
    });
    assert.equal(result.originEvidence[0].status, "persist-failed");
    assert.deepEqual(result.issues, [{ area: "localStorage", phase: "persist", code: "ENOSPC", origin }]);
    assert.equal(result.savedAt, undefined);
    assert.ok(!JSON.stringify(result.errors).includes("secret-value"));
});

test("late read after capture timeout cannot persist values", async () => {
    let writes = 0;
    const result = await captureBrowserStorage(context([page(origin, async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return { origin, data: { late: "synthetic" } };
    })]), { ...writers, saveLocalStorage: () => ++writes }, { totalTimeoutMs: 20 });
    assert.equal(result.originEvidence[0].status, "capture-failed");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(writes, 0);
});

test("later partial read preserves unresolved failures and previous saved evidence", async () => {
    const second = "https://other.example.test";
    const previous = await captureBrowserStorage(context([
        page(origin, async () => ({ origin, data: { saved: "synthetic" } })),
        page(second, async () => { throw new Error("read unavailable"); }),
    ]), writers);
    const next = await captureBrowserStorage(context([page(origin, async () => ({ origin, data: {} }))]), writers);
    const merged = mergeStorageSnapshots(previous, next);
    assert.equal(merged.originEvidence.find(entry => entry.origin === second).status, "capture-failed");
    assert.equal(merged.issues.length, 1);
    assert.equal(merged.issues[0].origin, second);
    assert.equal(merged.savedAt, previous.savedAt);
});

test("one origin cannot spend another origin's persistence budget", async () => {
    const second = "https://second.example.test";
    const budgets = [];
    const result = await captureBrowserStorage(context([
        page(origin, async () => ({ origin, data: { token: "synthetic" } })),
        page(second, async () => ({ origin: second, data: { token: "synthetic" } })),
    ]), { ...writers, saveLocalStorage: (source, _values, budget) => {
        budgets.push(budget);
        if (source === origin) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, budget);
            throw new Error("synthetic lock timeout");
        }
        return 1;
    } }, { totalTimeoutMs: 200 });
    assert.ok(budgets[0] <= 100);
    assert.equal(result.originEvidence[0].status, "persist-failed");
    assert.equal(result.originEvidence[1].status, "saved");
});

test("unknown historical snapshot failure remains visible after partial success", async () => {
    const next = await captureBrowserStorage(context([page(origin, async () => ({ origin, data: { token: "synthetic" } }))]), writers);
    const merged = mergeStorageSnapshots({ ...next, issues: [], errors: ["snapshot: unavailable"] }, next);
    assert.deepEqual(merged.errors, ["snapshot: unavailable"]);
});

test("origin representation excludes userinfo, query, and path", () => {
    assert.equal(storageOrigin("https://user:password@login.example.test/private?token=secret"), origin);
    assert.equal(storageOrigin("file:///private"), undefined);
});

test("navigation and popup origins remain tracked after their pages close", async () => {
    const { StorageSnapshotTracker } = await import("../src/storage-snapshot-tracker.ts");
    const browserContext = new EventEmitter();
    let url = origin;
    const first = new EventEmitter();
    first.url = () => url;
    first.mainFrame = () => frame;
    first.isClosed = () => false;
    first.evaluate = async () => ({ origin: new URL(url).origin, data: {} });
    const frame = { url: () => url };
    browserContext.cookies = async () => [];
    browserContext.pages = () => [first];
    const tracker = new StorageSnapshotTracker(browserContext, { intervalMs: 10000 });
    await tracker.start();
    url = "https://redirect.example.test/path?private=1";
    first.emit("framenavigated", frame);
    const popup = new EventEmitter();
    popup.url = () => "https://popup.example.test/callback";
    browserContext.emit("page", popup);
    popup.emit("close");
    const result = await tracker.stop();
    assert.deepEqual(result.observedOrigins, [origin, "https://redirect.example.test", "https://popup.example.test"]);
    assert.equal(browserContext.listenerCount("page"), 0);
    assert.equal(first.listenerCount("framenavigated"), 0);
    assert.equal(popup.listenerCount("framenavigated"), 0);
});
