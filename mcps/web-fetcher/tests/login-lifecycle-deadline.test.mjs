import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "login-lifecycle-deadline-"));
process.env.WEB_FETCHER_PROFILE_BASE_DIR = root;
const { createLoginSessionRunner } = await import("../src/login-session.ts");
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function fixture(mode, launchDelay = 0) {
    const processHandle = new EventEmitter();
    processHandle.exitCode = null;
    processHandle.signalCode = null;
    processHandle.killed = false;
    let closedAt = 0;
    let launchedAt = 0;
    processHandle.kill = () => {
        processHandle.killed = true;
        processHandle.exitCode = 0;
        closedAt = Date.now();
        processHandle.emit("exit");
    };
    const token = `synthetic-${mode}`;
    const lockFile = path.join(root, `${token}.json`);
    await fs.writeFile(lockFile, JSON.stringify({ ownerToken: token, cdpPort: 0 }));
    const chrome = { process: processHandle, ownerToken: token, cdpPort: 0, tempProfile: root, lockFile };
    const context = {
        cookies: async () => [],
        addCookies: async () => { if (mode === "cookie-error") throw new Error("synthetic injection failure"); },
        pages: () => [{ url: () => "about:blank", goto: async () => {} }],
    };
    const browser = {
        contexts: () => { if (mode === "context-error") throw new Error("synthetic context failure"); return [context]; },
        newBrowserCDPSession: async () => ({ send: async () => { processHandle.kill(); } }),
        close: async () => {},
    };
    const runner = createLoginSessionRunner({
        launch: async () => {
            await new Promise(resolve => setTimeout(resolve, launchDelay));
            launchedAt = Date.now();
            return chrome;
        },
        connect: async () => { if (mode === "connect-error") throw new Error("synthetic attach failure"); return browser; },
        ...(mode === "tracker-error" ? { createTracker: () => ({
            start: async () => { throw new Error("synthetic tracker failure"); },
            stop: async () => ({ reason: "test", cookies: [], cookieCount: 0, savedCookieCount: 0, localStorageDomains: [], errors: [] }),
        }) } : {}),
    });
    return { runner, processHandle, times: () => ({ closedAt, launchedAt }) };
}

test("launch latency does not consume any manual-operation budget", async () => {
    const probe = await fixture("delayed", 150);
    const started = Date.now();
    const result = await probe.runner("https://example.test", { maxRunMs: 180 });
    assert.equal(result.timedOut, true);
    assert.equal(result.browserClosed, true);
    assert.ok(probe.times().launchedAt - started >= 140);
    assert.ok(probe.times().closedAt - probe.times().launchedAt >= 170);
});

for (const mode of ["connect-error", "cookie-error", "context-error", "tracker-error"]) {
    test(`${mode} cannot prematurely close the manual-operation window`, async () => {
        const probe = await fixture(mode);
        const running = probe.runner("https://example.test", { maxRunMs: 180, initialCookies: [] });
        await new Promise(resolve => setTimeout(resolve, 70));
        assert.equal(probe.processHandle.exitCode, null);
        const result = await running;
        assert.equal(result.timedOut, true);
        assert.equal(result.browserClosed, true);
        assert.ok(probe.times().closedAt - probe.times().launchedAt >= 170);
        assert.ok(result.snapshot.errors.length);
        assert.equal(result.recoveryProfile, root);
    });
}
