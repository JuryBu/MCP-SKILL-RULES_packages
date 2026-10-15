import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const enabled = process.env.WEB_FETCHER_RECOVERY_TEST === "1";
const systemTemp = path.resolve(os.tmpdir());
const environmentNames = ["WEB_FETCHER_PROFILE_BASE_DIR", "TEMP", "TMP", "TMPDIR"];
const originalEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
let root;
let helper;
let backupRoot;
let StorageSnapshotTracker;
let createLoginSessionRunner;
let cleanedProfiles = 0;
let fallbackTerminatedProcesses = 0;
let fallbackRecoveryCopies = 0;
const retainedProfiles = new Set();
const retainedCrashArchives = [];
const executeFile = promisify(execFile);
const candidateFiles = ["chrome-helper.ts", "storage-snapshot.ts", "storage-snapshot-tracker.ts", "login-session.ts"];
let candidateHashes;

function ownedPath(candidate) {
    const relative = path.relative(root, path.resolve(candidate));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "fixture path must remain inside its own Temp root");
    return candidate;
}

before(async () => {
    if (!enabled) return;
    root = await fs.mkdtemp(path.join(systemTemp, "login-recovery-browser-"));
    assert.equal(path.dirname(root), systemTemp);
    backupRoot = ownedPath(path.join(root, "backups"));
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = backupRoot;
    for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = root;
    candidateHashes = await sourceHashes();
    console.log(`recovery candidate hashes: ${JSON.stringify(candidateHashes)}`);
    helper = await import("../src/chrome-helper.ts");
    ({ StorageSnapshotTracker } = await import("../src/storage-snapshot-tracker.ts"));
    ({ createLoginSessionRunner } = await import("../src/login-session.ts"));
});

after(async () => {
    try {
        if (root) {
            assert.equal(path.dirname(path.resolve(root)), systemTemp);
            const remainingProcesses = await ownedChromeProcesses(root);
            assert.equal(remainingProcesses.length, 0, "no fixture-owned Chrome processes may remain");
            assert.equal((await recoveryCopyPaths()).length, 0, "no recovery working copies may remain");
            if (retainedProfiles.size === 0) {
                await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
                assert.equal(await fs.access(root).then(() => true, () => false), false, "owned Temp root removed");
            }
            const latestHashes = await sourceHashes();
            const changedSources = candidateFiles.filter(filename => latestHashes[filename] !== candidateHashes[filename]);
            console.log(`recovery cleanup: chromeProcesses=0 profilesRemoved=${cleanedProfiles} recoveryCopies=0 tempRoots=${Number(retainedProfiles.size > 0)} fallbackTerminations=${fallbackTerminatedProcesses} fallbackRecoveryCopies=${fallbackRecoveryCopies} retainedCrashArchives=${retainedCrashArchives.length} retainedProfiles=${retainedProfiles.size} candidateSourceChanges=${changedSources.length}`);
            assert.equal(changedSources.length, 0, "candidate source changed during this run; rerun after the main task confirms stability");
        }
    } finally {
        for (const name of environmentNames) {
            if (originalEnvironment[name] === undefined) delete process.env[name];
            else process.env[name] = originalEnvironment[name];
        }
    }
});

async function sourceHashes() {
    return Object.fromEntries(await Promise.all(candidateFiles.map(async filename => [filename, createHash("sha256").update(await fs.readFile(new URL(`../src/${filename}`, import.meta.url))).digest("hex")])));
}

async function startSite() {
    const site = { requests: 0, workerRequests: 0, slowRequests: 0, mode: "normal", closed: false };
    const server = http.createServer((request, response) => {
        site.requests++;
        if (request.url.startsWith("/worker-")) site.workerRequests++;
        if (site.mode === "slow") {
            site.slowRequests++;
            return;
        }
        if (site.handle?.(request, response)) return;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end("<!doctype html><html><body>Synthetic storage recovery fixture</body></html>");
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    site.port = server.address().port;
    site.origin = `http://127.0.0.1:${site.port}`;
    site.localhostOrigin = `http://localhost:${site.port}`;
    site.close = async () => {
        if (site.closed) return;
        site.closed = true;
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    return site;
}

async function attach(chrome) {
    for (let attempt = 0; attempt < 30; attempt++) {
        try { return await helper.connectCDP(chrome.cdpPort, 1000); }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error("synthetic fixture CDP unavailable");
}

async function closeNormally(browser, chrome) {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close").catch(() => undefined);
    await helper.waitForChromeClose(chrome.process);
    assert.ok(chrome.process.exitCode !== null || chrome.process.signalCode !== null, "original owned Chrome exit confirmed before recovery");
    assert.equal(chrome.process.killed, false, "original Chrome closed normally through CDP");
}

async function bounded(promise, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function crashOwnedChrome(browser, chrome) {
    ownedPath(chrome.tempProfile);
    const session = await browser.newBrowserCDPSession();
    let unavailable = false;
    await bounded(session.send("Browser.crash").catch(error => {
        unavailable = /wasn't found|method not found|unknown method|not supported/i.test(String(error.message));
    }), 10000, "owned Browser.crash request");
    assert.equal(unavailable, false, "real Chrome must support Browser.crash");
    await bounded(helper.waitForChromeClose(chrome.process), 10000, "owned crashed Chrome exit");
    assert.ok(chrome.process.signalCode !== null || (chrome.process.exitCode !== null && chrome.process.exitCode !== 0), "Browser.crash must produce a confirmed abnormal process exit");
    assert.equal(chrome.process.killed, false, "crash probe must not substitute a normal close or manual process kill");
}

async function disposeChrome(chrome, browser) {
    if (!chrome) return;
    ownedPath(chrome.tempProfile);
    try {
        if (browser) await browser.close().catch(() => undefined);
    } finally {
        helper.terminateOwnedChrome(chrome);
        await helper.waitForChromeClose(chrome.process);
        const remainingProcesses = await ownedChromeProcesses(root);
        for (const processId of remainingProcesses) {
            fallbackTerminatedProcesses++;
            if (process.platform === "win32") await executeFile("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true, timeout: 10000 });
            else process.kill(processId, "SIGTERM");
        }
        for (let attempt = 0; attempt < 20; attempt++) {
            if ((await ownedChromeProcesses(root)).length === 0) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal((await ownedChromeProcesses(root)).length, 0, "owned original and recovery Chrome processes exited");
        for (const recoveryCopy of await recoveryCopyPaths()) {
            fallbackRecoveryCopies++;
            await fs.rm(ownedPath(recoveryCopy), { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
        }
        if (retainedProfiles.has(chrome.tempProfile)) return;
        helper.cleanupTempProfile(chrome.tempProfile);
        await fs.rm(chrome.tempProfile, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
        assert.equal(await fs.access(chrome.tempProfile).then(() => true, () => false), false, "owned Chrome profile removed");
        cleanedProfiles++;
    }
}

async function recoveryCopyPaths() {
    return (await fs.readdir(root, { withFileTypes: true }))
        .filter(entry => entry.name.startsWith("mcp-chrome-recovery-"))
        .map(entry => {
            assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "fixture recovery copy must be an owned directory");
            return ownedPath(path.join(root, entry.name));
        });
}

async function ownedChromeProcesses(profileRoot) {
    const marker = path.resolve(profileRoot).replaceAll("'", "''");
    if (process.platform === "win32") {
        const { stdout } = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000 });
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        return Array.isArray(parsed) ? parsed : [parsed];
    }
    const { stdout } = await executeFile("ps", ["-eo", "pid=,args="], { timeout: 10000 });
    return stdout.split("\n").filter(line => /chrome/i.test(line) && line.includes(path.resolve(profileRoot))).map(line => Number(line.trim().split(/\s+/, 1)[0]));
}

async function profileManifest(profile, ownershipRoot = root) {
    const relative = path.relative(ownershipRoot, path.resolve(profile));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "manifest path must remain inside its explicit owner root");
    const manifest = new Map();
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            assert.equal(entry.isSymbolicLink(), false, "synthetic profile must not contain links");
            if (entry.isDirectory()) await visit(filename);
            else if (entry.isFile()) manifest.set(path.relative(profile, filename), createHash("sha256").update(await fs.readFile(filename)).digest("hex"));
        }
    }
    await visit(profile);
    return manifest;
}

function changedFiles(beforeManifest, afterManifest) {
    return [...new Set([...beforeManifest.keys(), ...afterManifest.keys()])].filter(filename => beforeManifest.get(filename) !== afterManifest.get(filename));
}

async function stableProfileManifest(profile, context) {
    const deadline = Date.now() + 10000;
    let previous = await profileManifest(profile);
    let samples = 1;
    let stableComparisons = 0;
    const observedChanges = new Set();
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const current = await profileManifest(profile);
        const changed = changedFiles(previous, current);
        for (const filename of changed) observedChanges.add(filename);
        samples++;
        stableComparisons = changed.length === 0 ? stableComparisons + 1 : 0;
        previous = current;
        if (stableComparisons >= 2) {
            const evidence = { samples, stableComparisons, changedFilesBeforeBaseline: [...observedChanges] };
            context.diagnostic(`abnormal original profile stability: fingerprintSamples=${samples} stableComparisons=${stableComparisons} changedFilesBeforeBaseline=${observedChanges.size}`);
            if (observedChanges.size) context.diagnostic(`original profile changed paths before stable baseline: ${JSON.stringify([...observedChanges])}`);
            return { manifest: current, evidence };
        }
    }
    context.diagnostic(`original profile did not stabilize: fingerprintSamples=${samples} changedPaths=${JSON.stringify([...observedChanges])}`);
    throw new Error("abnormally exited original profile did not reach two stable read-only fingerprint comparisons");
}

async function preserveCrashEvidence(fixture, context, summary, probe = "crash") {
    const chrome = fixture.chrome;
    try {
        if (chrome.process.exitCode === null && chrome.process.signalCode === null) {
            helper.terminateOwnedChrome(chrome);
            await bounded(helper.waitForChromeClose(chrome.process), 10000, "crash evidence process exit");
        }
        const originalManifest = await profileManifest(chrome.tempProfile);
        const sourceBytes = (await Promise.all([...originalManifest.keys()].map(async filename => (await fs.stat(path.join(chrome.tempProfile, filename))).size))).reduce((total, size) => total + size, 0);
        const evidenceParent = path.resolve(process.env.WEB_FETCHER_RECOVERY_EVIDENCE_DIR || systemTemp);
        const parent = await fs.lstat(evidenceParent);
        assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), "crash evidence parent must be an explicit existing directory");
        const volume = await fs.statfs(evidenceParent);
        assert.ok(volume.bavail * volume.bsize >= sourceBytes + 64 * 1024 * 1024, "crash evidence needs enough free disk space");
        const directory = await fs.mkdtemp(path.join(evidenceParent, `${probe}-failure-`));
        const profileCopy = path.join(directory, "original-profile");
        await fs.cp(chrome.tempProfile, profileCopy, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
        assert.equal(changedFiles(originalManifest, await profileManifest(profileCopy, directory)).length, 0, "crash evidence copy must preserve every original file hash");
        assert.equal(changedFiles(originalManifest, await profileManifest(chrome.tempProfile)).length, 0, "evidence preservation must leave original profile bytes unchanged");
        let backupFiles = 0;
        if (await fs.access(backupRoot).then(() => true, () => false)) {
            const backupManifest = await profileManifest(backupRoot);
            const backupCopy = path.join(directory, "recovery-backups");
            await fs.cp(backupRoot, backupCopy, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
            assert.equal(changedFiles(backupManifest, await profileManifest(backupCopy, directory)).length, 0, "recovery backup evidence must retain original file hashes");
            backupFiles = backupManifest.size;
        }
        await fs.writeFile(path.join(directory, "provenance.json"), JSON.stringify({
            schemaVersion: 1,
            purpose: `Synthetic ${probe} failure evidence; profile is not launched from this archive`,
            createdAt: new Date().toISOString(),
            sourceProfile: chrome.tempProfile,
            sourceProfileBytes: sourceBytes,
            originalFileSha256: Object.fromEntries(originalManifest),
            profileFiles: originalManifest.size,
            backupFiles,
            summary,
            tokensPrinted: false,
        }, null, 2), "utf8");
        retainedCrashArchives.push(directory);
        context.diagnostic(`${probe} failure evidence: profileFiles=${originalManifest.size} backupFiles=${backupFiles} sha256Verified=1 location=${directory}`);
    } catch (error) {
        retainedProfiles.add(chrome.tempProfile);
        context.diagnostic(`${probe} failure evidence: copyFailed=1 originalRetained=1 location=${chrome.tempProfile}`);
        throw error;
    }
}

async function writeStorage(browserContext, page, origin, key, value) {
    const session = await browserContext.newCDPSession(page);
    try {
        await session.send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: origin, isLocalStorage: true }, key, value });
        const captured = await session.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } });
        assert.ok(captured.entries.some(entry => entry[0] === key && entry[1] === value), "CDP write is visible in original Chrome before it closes");
    } finally {
        await session.detach();
    }
}

function assertRecoveredOrigins(recovered, origins) {
    assert.equal(recovered.errors.length, 0, "recovery errors must be empty");
    assert.equal(recovered.issues?.length, 0, "recovery issues must be empty");
    assert.equal(recovered.recoveryComplete, true, "recovery completeness evidence required");
    assert.ok(["saved", "empty"].includes(recovered.cookieEvidence?.status), "Cookie capture must have positive or empty evidence");
    for (const origin of origins) {
        assert.ok(recovered.observedOrigins?.includes(origin), "requested origin must remain observable in recovery result");
        assert.ok(recovered.originEvidence?.some(entry => entry.origin === origin && ["saved", "empty"].includes(entry.status)), "every requested origin needs completed evidence");
    }
}

async function runFixture(context, run) {
    ownedPath(backupRoot);
    await fs.rm(backupRoot, { recursive: true, force: true });
    const sites = [];
    let chrome;
    let browser;
    let tracker;
    try {
        chrome = await helper.launchSystemChrome({ headless: true, startUrl: "about:blank", profilePrefix: "mcp-chrome-login" });
        ownedPath(chrome.tempProfile);
        browser = await attach(chrome);
        context.diagnostic(`synthetic browser: version=${browser.version()} headless=1`);
        const browserContext = browser.contexts()[0];
        const page = browserContext.pages()[0] ?? await browserContext.newPage();
        const fixture = {
            chrome, browser, browserContext, page,
            async site() {
                const site = await startSite();
                sites.push(site);
                return site;
            },
            async track() {
                tracker = new StorageSnapshotTracker(browserContext, { intervalMs: 60000 });
                await tracker.start();
            },
            async close() {
                await closeNormally(browser, chrome);
                return tracker ? tracker.stop() : undefined;
            },
            async crash() {
                await crashOwnedChrome(browser, chrome);
                return tracker ? tracker.stop() : undefined;
            },
            async recover(startUrl, options, fixtureOptions = {}) {
                assert.ok(chrome.process.exitCode !== null || chrome.process.signalCode !== null, "recovery starts only after original Chrome exit");
                assert.equal((await recoveryCopyPaths()).length, 0, "recovery starts without old working copies");
                const stabilized = fixtureOptions.waitForStableProfile ? await stableProfileManifest(chrome.tempProfile, context) : undefined;
                const beforeManifest = stabilized?.manifest ?? await profileManifest(chrome.tempProfile);
                const started = Date.now();
                const recovered = await helper.recoverClosedChromeStorage(chrome, startUrl, options);
                const afterManifest = await profileManifest(chrome.tempProfile);
                const changed = changedFiles(beforeManifest, afterManifest);
                fixture.lastRecoveryResult = recovered;
                fixture.lastRecoveryEvidence = {
                    changedOriginalFiles: changed,
                    originalProfileStability: stabilized?.evidence,
                    originalBeforeSha256: Object.fromEntries(beforeManifest),
                    originalAfterSha256: Object.fromEntries(afterManifest),
                };
                const remainingProcesses = await ownedChromeProcesses(root);
                const recoveryCopies = await recoveryCopyPaths();
                context.diagnostic(`recovery evidence: cookies=${recovered.cookies.length} origins=${recovered.originEvidence?.length ?? 0} issues=${recovered.issues?.length ?? 0} complete=${Number(recovered.recoveryComplete === true)} originalProfileByteChanges=${changed.length} chromeProcesses=${remainingProcesses.length} recoveryCopies=${recoveryCopies.length}`);
                if (changed.length) context.diagnostic(`original profile changed paths: ${JSON.stringify(changed)}`);
                assert.ok(Date.now() - started < 32000, "closed-profile recovery remains bounded");
                assert.equal(recovered.recoveryBrowserClosed, true, "recovery Chrome exit confirmed");
                assert.equal(remainingProcesses.length, 0, "recovery helper must close its own Chrome process tree before returning");
                assert.equal(recoveryCopies.length, 0, "recovery helper must remove its own isolated working copy before returning");
                assert.equal(recovered.recoveryWorkingCopy, undefined, "recovery result must not retain a working-copy path");
                assert.equal(changed.length, 0, "recovery must leave every original profile file byte-for-byte unchanged");
                return recovered;
            },
        };
        await run(fixture);
    } finally {
        try { if (tracker) await tracker.stop(); }
        finally {
            try { await disposeChrome(chrome, browser); }
            finally { await Promise.all(sites.map(site => site.close())); }
        }
    }
}

test("critical probe: immediate normal close preserves final storage and session-only Cookie", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const site = await fixture.site();
        const { browserContext, page } = fixture;
        await page.goto(site.origin, { waitUntil: "domcontentloaded" });
        const session = await browserContext.newCDPSession(page);
        const finalValue = randomUUID();
        await session.send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: site.origin, isLocalStorage: true }, key: "synthetic-final", value: finalValue });
        await session.send("Network.setCookies", { cookies: [
            { name: "synthetic-persistent", value: finalValue, url: site.origin, expires: Math.floor(Date.now() / 1000) + 3600 },
            { name: "synthetic-session-only", value: finalValue, url: site.origin },
        ] });
        const beforeClose = await session.send("Network.getCookies", { urls: [site.origin] });
        assert.ok(beforeClose.cookies.some(cookie => cookie.name === "synthetic-session-only" && cookie.session && cookie.value === finalValue), "session-only Cookie exists in real Chrome immediately before close");
        assert.ok(beforeClose.cookies.some(cookie => cookie.name === "synthetic-persistent" && !cookie.session && cookie.value === finalValue), "persistent Cookie exists in real Chrome immediately before close");
        await fixture.close();
        const recovered = await fixture.recover(site.origin, { origins: [site.origin], originTrackingComplete: true });
        const persistent = recovered.cookies.find(cookie => cookie.name === "synthetic-persistent");
        const sessionOnly = recovered.cookies.find(cookie => cookie.name === "synthetic-session-only");
        const storageMatches = helper.getLocalStorageForOrigin(site.origin)?.["synthetic-final"] === finalValue;
        context.diagnostic(`critical probe: persistent=${Number(persistent?.value === finalValue)} sessionOnly=${Number(sessionOnly?.value === finalValue)} localStorage=${Number(storageMatches)}`);
        assert.ok(persistent?.value === finalValue, "final persistent Cookie must survive recovery");
        assert.ok(storageMatches, "final localStorage must survive recovery");
        assert.ok(sessionOnly?.value === finalValue, "final session-only Cookie must survive recovery without reinjection");
        assertRecoveredOrigins(recovered, [site.origin]);
    });
});

test("multiple exact origins survive after their source pages are closed", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const first = await fixture.site();
        const second = await fixture.site();
        const origins = [first.localhostOrigin, second.localhostOrigin, first.origin];
        assert.equal(new Set(origins).size, 3);
        await fixture.track();
        const expected = new Map();
        for (const origin of origins) {
            const page = await fixture.browserContext.newPage();
            await page.goto(`${origin}/source`, { waitUntil: "domcontentloaded" });
            const value = randomUUID();
            expected.set(origin, value);
            await writeStorage(fixture.browserContext, page, origin, "synthetic-per-origin", value);
            await page.close();
        }
        const tracked = await fixture.close();
        assert.equal(tracked.originTrackingComplete, true, "real page-navigation tracking remains complete");
        assert.ok(origins.every(origin => tracked.observedOrigins.includes(origin)), "tracker remembers closed source-page origins");
        assert.ok(origins.every(origin => helper.getLocalStorageForOrigin(origin)?.["synthetic-per-origin"] === undefined), "final values have not been copied to backup before recovery");
        const requestsBefore = first.requests + second.requests;
        const recovered = await fixture.recover(`${first.localhostOrigin}/source`, { origins: tracked.observedOrigins, originTrackingComplete: tracked.originTrackingComplete });
        for (const [origin, value] of expected) assert.ok(helper.getLocalStorageForOrigin(origin)?.["synthetic-per-origin"] === value, "localStorage remains isolated by exact host and port");
        assert.equal(first.requests + second.requests - requestsBefore, 0, "recovery must not request source sites");
        assert.equal(recovered.cookieEvidence?.status, "empty", "Cookie-free profile has explicit empty evidence");
        assertRecoveredOrigins(recovered, origins);
        context.diagnostic("multiple origins: exactOrigins=3 closedSourcePages=3 networkReplay=0");
    });
});

test("login redirect followed by immediate normal close preserves both origins", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const source = await fixture.site();
        const target = await fixture.site();
        source.handle = (request, response) => {
            if (request.url !== "/login") return false;
            response.writeHead(302, { location: `${target.origin}/complete`, "cache-control": "no-store" });
            response.end();
            return true;
        };
        await fixture.track();
        await fixture.page.goto(`${source.localhostOrigin}/start`, { waitUntil: "domcontentloaded" });
        const sourceValue = randomUUID();
        const targetValue = randomUUID();
        await writeStorage(fixture.browserContext, fixture.page, source.localhostOrigin, "synthetic-before-redirect", sourceValue);
        await fixture.page.goto(`${source.localhostOrigin}/login`, { waitUntil: "domcontentloaded" });
        assert.equal(new URL(fixture.page.url()).origin, target.origin, "synthetic login performs a real cross-origin HTTP redirect");
        await writeStorage(fixture.browserContext, fixture.page, target.origin, "synthetic-after-redirect", targetValue);
        const tracked = await fixture.close();
        const origins = [source.localhostOrigin, target.origin];
        assert.ok(origins.every(origin => tracked.observedOrigins.includes(origin)), "tracker records source and final login origins");
        const requestsBefore = source.requests + target.requests;
        const recovered = await fixture.recover(`${source.localhostOrigin}/login`, { origins: tracked.observedOrigins, originTrackingComplete: tracked.originTrackingComplete });
        assert.ok(helper.getLocalStorageForOrigin(source.localhostOrigin)?.["synthetic-before-redirect"] === sourceValue, "pre-redirect origin survives");
        assert.ok(helper.getLocalStorageForOrigin(target.origin)?.["synthetic-after-redirect"] === targetValue, "immediate post-redirect final value survives");
        assert.equal(source.requests + target.requests - requestsBefore, 0, "recovery must not repeat the login redirect");
        assertRecoveredOrigins(recovered, origins);
        context.diagnostic("login redirect: origins=2 networkReplay=0");
    });
});

test("slow and offline sites recover storage without network access", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const slow = await fixture.site();
        const offline = await fixture.site();
        const expected = new Map();
        for (const site of [slow, offline]) {
            await fixture.page.goto(`${site.origin}/source`, { waitUntil: "domcontentloaded" });
            const value = randomUUID();
            expected.set(site.origin, value);
            await writeStorage(fixture.browserContext, fixture.page, site.origin, "synthetic-network-independent", value);
        }
        await fixture.close();
        slow.mode = "slow";
        await offline.close();
        const requestsBefore = slow.requests + offline.requests;
        const origins = [...expected.keys()];
        const recovered = await fixture.recover(`${slow.origin}/source`, { origins, originTrackingComplete: true });
        for (const [origin, value] of expected) assert.ok(helper.getLocalStorageForOrigin(origin)?.["synthetic-network-independent"] === value, "slow or offline origin storage survives");
        assert.equal(slow.requests + offline.requests - requestsBefore, 0, "recovery bypasses slow and offline HTTP servers");
        assert.equal(slow.slowRequests, 0, "recovery never reaches intentionally hanging response");
        assertRecoveredOrigins(recovered, origins);
        context.diagnostic("network independence: slowOrigins=1 offlineOrigins=1 networkReplay=0");
    });
});

test("ServiceWorker harmful navigation and worker network traffic are not replayed", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const site = await fixture.site();
        const poisonedValue = randomUUID();
        const finalValue = randomUUID();
        const harmfulHtml = `<!doctype html><script>localStorage.setItem('synthetic-worker-target',${JSON.stringify(poisonedValue)})</script>`;
        site.handle = (request, response) => {
            if (request.url === "/sw.js") {
                response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store", "service-worker-allowed": "/" });
                response.end(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
                    self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
                    self.addEventListener('fetch',event=>{if(event.request.mode==='navigate'){
                        event.waitUntil(fetch('/worker-network',{cache:'no-store'}));
                        event.respondWith(new Response(${JSON.stringify(harmfulHtml)},{headers:{'content-type':'text/html'}}));
                    }});`);
                return true;
            }
            return false;
        };
        await fixture.page.goto(`${site.origin}/setup`, { waitUntil: "domcontentloaded" });
        await fixture.page.evaluate(async () => {
            await navigator.serviceWorker.register("/sw.js");
            await navigator.serviceWorker.ready;
        });
        await fixture.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        await fixture.page.goto(`${site.origin}/armed`, { waitUntil: "domcontentloaded" });
        const poisoned = await fixture.page.evaluate(() => localStorage.getItem("synthetic-worker-target"));
        assert.ok(poisoned === poisonedValue, "negative control confirms worker can replace document and overwrite localStorage");
        for (let attempt = 0; attempt < 30 && site.workerRequests === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(site.workerRequests > 0, "negative control confirms real worker-originated network traffic");
        await writeStorage(fixture.browserContext, fixture.page, site.origin, "synthetic-worker-target", finalValue);
        await fixture.close();
        const workerRequestsBefore = site.workerRequests;
        const requestsBefore = site.requests;
        const recovered = await fixture.recover(`${site.origin}/armed`, { origins: [site.origin], originTrackingComplete: true });
        const recoveredValue = helper.getLocalStorageForOrigin(site.origin)?.["synthetic-worker-target"];
        const workerRequestDelta = site.workerRequests - workerRequestsBefore;
        const networkRequestDelta = site.requests - requestsBefore;
        context.diagnostic(`ServiceWorker: negativeControlRequests=${workerRequestsBefore} recoveryWorkerRequests=${workerRequestDelta} networkReplay=${networkRequestDelta} finalValueMatches=${Number(recoveredValue === finalValue)} poisonedValueMatches=${Number(recoveredValue === poisonedValue)}`);
        assert.ok(recoveredValue === finalValue, "recovery must not execute harmful worker navigation");
        assert.equal(workerRequestDelta, 0, "recovery must not replay worker network traffic");
        assert.equal(networkRequestDelta, 0, "recovery must not request worker script or source documents");
        assertRecoveredOrigins(recovered, [site.origin]);
    });
});

test("incomplete origin tracking remains explicit after a real recovery", { skip: !enabled, timeout: 60000 }, async context => {
    await runFixture(context, async fixture => {
        const site = await fixture.site();
        await fixture.page.goto(site.origin, { waitUntil: "domcontentloaded" });
        const value = randomUUID();
        await writeStorage(fixture.browserContext, fixture.page, site.origin, "synthetic-incomplete", value);
        await fixture.close();
        const recovered = await fixture.recover(site.origin, { origins: [site.origin], originTrackingComplete: false });
        assert.ok(helper.getLocalStorageForOrigin(site.origin)?.["synthetic-incomplete"] === value, "known origin still recovers under incomplete tracking");
        assert.equal(recovered.recoveryComplete, false, "unknown origin coverage must prevent complete recovery");
        assert.ok(recovered.issues?.some(issue => issue.area === "recovery" && issue.phase === "coverage" && issue.code === "origin-tracking-incomplete"), "incomplete coverage needs a structured issue");
        assert.ok(recovered.errors.length > 0, "incomplete coverage needs a visible error");
        context.diagnostic(`incomplete tracking: knownOrigins=1 coverageIssues=${recovered.issues.length} complete=0`);
    });
});

test("real abnormal Chrome exit reports incomplete recovery and retains its unsampled original", { skip: !enabled, timeout: 90000 }, async context => {
    await runFixture(context, async fixture => {
        let summary = { crashMethod: "Browser.crash", finalSnapshotSampled: false };
        let site;
        let finalValue;
        try {
            site = await fixture.site();
            await fixture.track();
            await fixture.page.goto(site.origin, { waitUntil: "domcontentloaded" });
            finalValue = randomUUID();
            const session = await fixture.browserContext.newCDPSession(fixture.page);
            await session.send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: site.origin, isLocalStorage: true }, key: "synthetic-crash-final", value: finalValue });
            await session.send("Network.setCookies", { cookies: [
                { name: "synthetic-crash-persistent", value: finalValue, url: site.origin, expires: Math.floor(Date.now() / 1000) + 3600 },
                { name: "synthetic-crash-session-only", value: finalValue, url: site.origin },
            ] });
            const cookiesBefore = await session.send("Network.getCookies", { urls: [site.origin] });
            const storageBefore = await session.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: site.origin, isLocalStorage: true } });
            assert.ok(cookiesBefore.cookies.some(cookie => cookie.name === "synthetic-crash-session-only" && cookie.session && cookie.value === finalValue), "final session-only Cookie exists immediately before crash");
            assert.ok(cookiesBefore.cookies.some(cookie => cookie.name === "synthetic-crash-persistent" && !cookie.session && cookie.value === finalValue), "final persistent Cookie exists immediately before crash");
            assert.ok(storageBefore.entries.some(entry => entry[0] === "synthetic-crash-final" && entry[1] === finalValue), "final localStorage exists immediately before crash");
            assert.equal(await fs.access(path.join(backupRoot, "cookies-backup.json")).then(() => true, () => false), false, "final Cookie values must not have been sampled to backup");
            assert.equal(await fs.access(path.join(backupRoot, "localstorage-backup.json")).then(() => true, () => false), false, "final localStorage must not have been sampled to backup");
            const tracked = await fixture.crash();
            summary = { ...summary, exitCode: fixture.chrome.process.exitCode, signalCode: fixture.chrome.process.signalCode, processKilled: fixture.chrome.process.killed };
            assert.equal(tracked.cookies.length, 0, "tracker has no final Cookie fallback after crash");
            assert.equal(tracked.localStorageDomains.length, 0, "tracker has no final localStorage fallback after crash");
            assert.equal(tracked.originTrackingComplete, true, "crashed origin coverage remains known");
            const requestsBefore = site.requests;
            const recovered = await fixture.recover(site.origin, { origins: tracked.observedOrigins, originTrackingComplete: tracked.originTrackingComplete }, { waitForStableProfile: true });
            const persistentMatches = recovered.cookies.some(cookie => cookie.name === "synthetic-crash-persistent" && cookie.value === finalValue);
            const sessionOnlyMatches = recovered.cookies.some(cookie => cookie.name === "synthetic-crash-session-only" && cookie.value === finalValue);
            const localStorageMatches = helper.getLocalStorageForOrigin(site.origin)?.["synthetic-crash-final"] === finalValue;
            const allFinalValuesMatch = persistentMatches && sessionOnlyMatches && localStorageMatches;
            const originalRetained = await fs.stat(fixture.chrome.tempProfile).then(stat => stat.isDirectory(), () => false);
            const abnormalExitReported = recovered.issues?.some(issue => issue.area === "recovery" && issue.phase === "capture" && issue.code === "original-browser-abnormal-exit") === true;
            summary = { ...summary, persistentMatches, sessionOnlyMatches, localStorageMatches, finalStateMissing: !allFinalValuesMatch, helperRecoveryComplete: recovered.recoveryComplete, abnormalExitReported, originalRetained, errors: recovered.errors.length, issues: recovered.issues?.length ?? 0, fixtureNetworkRequests: site.requests - requestsBefore, recoveryEvidence: fixture.lastRecoveryEvidence };
            context.diagnostic(`abnormal exit probe: abnormalExit=1 exitCode=${fixture.chrome.process.exitCode} signal=${fixture.chrome.process.signalCode ?? "none"} sampledFallback=0 persistent=${Number(persistentMatches)} sessionOnly=${Number(sessionOnlyMatches)} localStorage=${Number(localStorageMatches)} helperComplete=${Number(recovered.recoveryComplete === true)} finalStateMissing=${Number(!allFinalValuesMatch)} explicitAbnormalExit=${Number(abnormalExitReported)} originalRetained=${Number(originalRetained)} networkReplay=${site.requests - requestsBefore}`);
            assert.equal(recovered.recoveryComplete, false, "abnormal exit must explicitly remain incomplete even when the on-disk Cookie database looks empty");
            assert.ok(abnormalExitReported, "recovery must report recovery/capture/original-browser-abnormal-exit");
            assert.ok(recovered.errors.some(error => error.includes("original-browser-abnormal-exit")), "legacy error consumers receive explicit abnormal-exit evidence");
            assert.ok(originalRetained, "partial recovery retains the original profile before fixture-owned final cleanup");
            for (const cookie of recovered.cookies) {
                if (["synthetic-crash-persistent", "synthetic-crash-session-only"].includes(cookie.name)) assert.ok(cookie.value === finalValue, "any exported crash-state Cookie retains its actual final value");
            }
            const savedStorage = helper.getLocalStorageForOrigin(site.origin);
            if (savedStorage && Object.hasOwn(savedStorage, "synthetic-crash-final")) assert.ok(localStorageMatches, "any exported crash-state localStorage retains its actual final value");
            assert.equal(site.requests - requestsBefore, 0, "crash recovery must not replay fixture network requests");
            if (!allFinalValuesMatch) await preserveCrashEvidence(fixture, context, { ...summary, testOutcome: "expected-explicit-partial-recovery" }, "crash-partial");
        } catch (error) {
            const recovered = fixture.lastRecoveryResult;
            if (recovered && site && finalValue) {
                const persistentMatches = recovered.cookies.some(cookie => cookie.name === "synthetic-crash-persistent" && cookie.value === finalValue);
                const sessionOnlyMatches = recovered.cookies.some(cookie => cookie.name === "synthetic-crash-session-only" && cookie.value === finalValue);
                const localStorageMatches = helper.getLocalStorageForOrigin(site.origin)?.["synthetic-crash-final"] === finalValue;
                summary = { ...summary, persistentMatches, sessionOnlyMatches, localStorageMatches, helperRecoveryComplete: recovered.recoveryComplete, errors: recovered.errors.length, issues: recovered.issues?.length ?? 0, recoveryEvidence: fixture.lastRecoveryEvidence };
                context.diagnostic(`abnormal exit failure details: exitCode=${fixture.chrome.process.exitCode} persistent=${Number(persistentMatches)} sessionOnly=${Number(sessionOnlyMatches)} localStorage=${Number(localStorageMatches)} helperComplete=${Number(recovered.recoveryComplete === true)}`);
            }
            try { await preserveCrashEvidence(fixture, context, summary); }
            catch (preservationError) { throw new AggregateError([error, preservationError], "abnormal-exit regression failed and original Temp evidence was retained"); }
            throw error;
        }
    });
});

test("real runner CDP failure retains newer shared backups and the conflicting original profile", { skip: !enabled, timeout: 90000 }, async context => {
    await runFixture(context, async competingFixture => {
        const site = await competingFixture.site();
        const cookieName = "synthetic-runner-conflict";
        const storageKey = "synthetic-runner-token";
        const oldValue = randomUUID();
        const newerValue = randomUUID();
        const launchReady = Promise.withResolvers();
        const connectionFailed = Promise.withResolvers();
        let runnerChrome;
        let externalBrowser;
        let running;
        let runnerSettled = false;
        let connectAttempts = 0;
        let trackerCreations = 0;
        let launchedAt;
        let manuallyClosedAt;
        let summary = { probe: "runner-connect-failure", maxRunMs: 5000 };

        async function writeValues(browserContext, page, value) {
            await page.goto(site.origin, { waitUntil: "domcontentloaded", timeout: 2500 });
            const session = await browserContext.newCDPSession(page);
            try {
                await session.send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: site.origin, isLocalStorage: true }, key: storageKey, value });
                await session.send("Network.setCookies", { cookies: [{ name: cookieName, value, url: site.origin, expires: Math.floor(Date.now() / 1000) + 3600 }] });
                const cookies = await session.send("Network.getCookies", { urls: [site.origin] });
                const storage = await session.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: site.origin, isLocalStorage: true } });
                assert.ok(cookies.cookies.some(cookie => cookie.name === cookieName && cookie.value === value), "real fixture CDP Cookie write is visible before close");
                assert.ok(storage.entries.some(entry => entry[0] === storageKey && entry[1] === value), "real fixture CDP localStorage write is visible before close");
            } finally {
                await session.detach();
            }
        }

        async function backupsMatch(value) {
            const cookies = JSON.parse(await fs.readFile(path.join(backupRoot, "cookies-backup.json"), "utf8"));
            return {
                cookie: cookies.some(cookie => cookie.name === cookieName && cookie.value === value),
                localStorage: helper.getLocalStorageForOrigin(site.origin)?.[storageKey] === value,
            };
        }

        try {
            await writeValues(competingFixture.browserContext, competingFixture.page, oldValue);
            const initial = await helper.snapshotBrowserStorage(competingFixture.browserContext, { reason: "runner-conflict-baseline", totalTimeoutMs: 2000 });
            assert.equal(initial.errors.length, 0, "another real session establishes the shared backup baseline");
            const initialMatches = await backupsMatch(oldValue);
            assert.ok(initialMatches.cookie && initialMatches.localStorage, "shared backup contains the old baseline before runner creation");

            const runner = createLoginSessionRunner({
                launch: async options => {
                    try {
                        runnerChrome = await helper.launchSystemChrome({ ...options, headless: true });
                        ownedPath(runnerChrome.tempProfile);
                        launchedAt = Date.now();
                        launchReady.resolve(runnerChrome);
                        return runnerChrome;
                    } catch (error) {
                        launchReady.reject(error);
                        throw error;
                    }
                },
                connect: async () => {
                    connectAttempts++;
                    connectionFailed.resolve();
                    throw new Error("synthetic runner-only CDP attach failure");
                },
                createTracker: () => {
                    trackerCreations++;
                    throw new Error("failed runner connection must not reach tracker creation");
                },
            });
            running = runner(site.origin, { maxRunMs: 5000 }).then(
                result => { runnerSettled = true; return { result }; },
                error => { runnerSettled = true; return { error }; },
            );
            await bounded(launchReady.promise, 16000, "runner owned headless launch");
            await bounded(connectionFailed.promise, 2000, "runner failed connection branch");
            externalBrowser = await attach(runnerChrome);
            const originalContext = externalBrowser.contexts()[0];
            const originalPage = originalContext.pages()[0] ?? await originalContext.newPage();
            await writeValues(originalContext, originalPage, oldValue);

            await writeValues(competingFixture.browserContext, competingFixture.page, newerValue);
            const newer = await helper.snapshotBrowserStorage(competingFixture.browserContext, { reason: "runner-conflict-newer-session", totalTimeoutMs: 2000 });
            assert.equal(newer.errors.length, 0, "the other real session commits newer values while runner CDP is unavailable");
            const newerMatches = await backupsMatch(newerValue);
            assert.ok(newerMatches.cookie && newerMatches.localStorage, "newer Cookie and localStorage are committed before original close");
            const backupBefore = await profileManifest(backupRoot);
            await competingFixture.close();
            await new Promise(resolve => setTimeout(resolve, Math.max(180, 1000 - (Date.now() - launchedAt))));
            assert.ok(connectAttempts >= 2, "the runner repeatedly exercises its failing CDP branch");
            assert.equal(trackerCreations, 0, "runner never obtains a context or sampled fallback");
            assert.equal(runnerSettled, false, "CDP failure must leave the manual-operation window open");
            assert.equal(runnerChrome.process.exitCode, null, "original headless browser remains alive until the external fixture closes it");
            assert.equal(runnerChrome.process.signalCode, null, "original browser has no premature exit signal");
            manuallyClosedAt = Date.now();
            await closeNormally(externalBrowser, runnerChrome);
            const originalBefore = await profileManifest(runnerChrome.tempProfile);
            const outcome = await bounded(running, 35000, "runner closed-profile conflict recovery");
            if (outcome.error) throw outcome.error;
            const result = outcome.result;
            const originalAfter = await profileManifest(runnerChrome.tempProfile);
            const originalChanges = changedFiles(originalBefore, originalAfter);
            const finalMatches = await backupsMatch(newerValue);
            const backupChanges = changedFiles(backupBefore, await profileManifest(backupRoot));
            const conflicts = (result.snapshot.issues ?? []).filter(issue => issue.code === "backup-conflict");
            const processes = await ownedChromeProcesses(root);
            const recoveryCopies = await recoveryCopyPaths();
            summary = {
                ...summary, connectAttempts, trackerCreations, manualWindowMs: manuallyClosedAt - launchedAt,
                timedOut: result.timedOut, browserClosed: result.browserClosed, recoveryComplete: result.snapshot.recoveryComplete,
                newerCookiePreserved: finalMatches.cookie, newerLocalStoragePreserved: finalMatches.localStorage,
                backupConflicts: conflicts.length, backupChanges: backupChanges.length, originalProfileChanges: originalChanges,
                originalProfileRetained: result.recoveryProfile === runnerChrome.tempProfile,
                chromeProcesses: processes.length, recoveryCopies: recoveryCopies.length,
            };
            context.diagnostic(`runner CDP failure probe: failedConnects=${connectAttempts} sampledFallback=${trackerCreations} manualWindowMs=${manuallyClosedAt - launchedAt} timedOut=${Number(result.timedOut)} newerCookie=${Number(finalMatches.cookie)} newerLocalStorage=${Number(finalMatches.localStorage)} backupConflicts=${conflicts.length} backupByteChanges=${backupChanges.length} originalProfileByteChanges=${originalChanges.length} originalRetained=${Number(result.recoveryProfile === runnerChrome.tempProfile)} chromeProcesses=${processes.length} recoveryCopies=${recoveryCopies.length}`);
            assert.equal(result.timedOut, false, "external normal close, not expiry, ends the operation window");
            assert.equal(runnerChrome.process.killed, false, "the failed connection must not force-kill the usable original browser");
            assert.equal(result.browserClosed, true, "runner confirms original and recovery browser exit");
            assert.ok(finalMatches.cookie && finalMatches.localStorage, "old profile recovery must retain both newer shared backup values");
            assert.equal(backupChanges.length, 0, "conflicting recovery must preserve shared backup bytes");
            assert.ok(conflicts.some(issue => issue.area === "cookies" && issue.phase === "persist"), "runner must explicitly report the Cookie backup conflict");
            assert.ok(conflicts.some(issue => issue.area === "localStorage" && issue.origin === site.origin && issue.phase === "persist"), "runner must explicitly report the exact-origin localStorage backup conflict");
            assert.ok(result.snapshot.errors.some(error => error.includes("backup-conflict")), "legacy error consumers also receive explicit conflict evidence");
            assert.equal(result.snapshot.recoveryComplete, false, "conflicting profile recovery cannot claim complete persistence");
            assert.equal(result.recoveryProfile, runnerChrome.tempProfile, "runner returns its retained original recovery profile");
            assert.equal(originalChanges.length, 0, "runner recovery must leave every original profile byte unchanged");
            assert.equal(result.snapshot.recoveryBrowserClosed, true, "runner recovery Chrome exit is confirmed");
            assert.equal(result.snapshot.recoveryWorkingCopy, undefined, "runner retains no temporary recovery-copy path");
            assert.equal(recoveryCopies.length, 0, "runner removes its isolated recovery copy");
            assert.equal(processes.length, 0, "both real sessions and recovery Chrome trees have exited");
        } catch (error) {
            if (runnerChrome) {
                if (runnerChrome.process.exitCode === null && runnerChrome.process.signalCode === null) {
                    if (externalBrowser) await closeNormally(externalBrowser, runnerChrome).catch(() => undefined);
                    helper.terminateOwnedChrome(runnerChrome);
                    await bounded(helper.waitForChromeClose(runnerChrome.process), 10000, "failed runner fixture exit");
                }
                if (running) await bounded(running, 40000, "failed runner recovery settlement");
                await preserveCrashEvidence({ chrome: runnerChrome }, context, { ...summary, connectAttempts, trackerCreations }, "runner-conflict");
            }
            throw error;
        } finally {
            if (runnerChrome) {
                helper.terminateOwnedChrome(runnerChrome);
                await bounded(helper.waitForChromeClose(runnerChrome.process), 10000, "runner fixture final exit");
                if (running && !runnerSettled) await bounded(running, 40000, "runner final settlement");
                await disposeChrome(runnerChrome, externalBrowser);
            }
        }
    });
});
