import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const root = mode ? process.env.MEMORY_STORE_DATA_ROOT! : fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-root-fixes-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const store = await import("../src/store.ts");
const storage = await import("../src/auto-summary-storage.ts");
const snapshots = await import("../src/auto-summary-snapshot.ts");
const { indexCache } = await import("../src/cache.ts");
const workspace = "C:/synthetic-summary-root-fixes";
const { hash } = store.ensureWorkspace(workspace);
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const lockPathFor = (memoryId: string) => path.join(root, ".memory-locks", `${crypto.createHash("sha256").update(JSON.stringify([hash, memoryId])).digest("hex")}.lock`);
const filename = fileURLToPath(import.meta.url);

if (mode === "--crash-reaper") {
    const lockPath = lockPathFor("reaper-race");
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = target => {
        if (path.resolve(String(target)) === path.resolve(lockPath) && fs.existsSync(`${lockPath}.reap`)) process.exit(23);
        return originalUnlink(target);
    };
    await store.withMemoryLock(hash, "reaper-race", () => {});
    process.exitCode = 24;
} else if (mode === "--increment") {
    console.log("READY");
    while (!fs.existsSync(path.join(root, "start-workers"))) await delay(5);
    await store.withMemoryLock(hash, "reaper-race", async () => {
        const value = Number(store.readMemoryFile(hash, "reaper-race"));
        await delay(40);
        store.writeMemoryFile(hash, "reaper-race", String(value + 1));
    });
    console.log("INCREMENTED");
} else if (mode === "--repair-current") {
    const memoryId = process.argv[3];
    const repair = await import("../src/auto-summary-repair.ts");
    const target = repair.inspectAutoSummaryRepairTarget(hash, memoryId)!;
    assert.ok(target);
    const [outcome] = await repair.repairConfirmedAutoSummaries([{ ...target, confirmed: true, reason: "Controlled current-version repair" }], {
        generate: async () => ({ summary: "current body summary", provenance: { version: 1, status: "generated", provider: "fixture", model: "fixture", generatedAt: "2026-01-05", failures: [] } }),
    });
    console.log(JSON.stringify({ result: outcome.status }));
    assert.equal(outcome.status, "written");
} else if (mode === "--resume-summary") {
    const memoryId = process.argv[3];
    const snapshot = snapshots.captureAutoSummaryFileSnapshot(store.readMemoryFile(hash, memoryId)!)!;
    const result = await storage.writeAutoSummaryIfUnchanged({ hash, memoryId, summary: "current body summary", expectedFingerprint: snapshot.fingerprint,
        expectedSummary: snapshot.expectedSummary, expectedSourceFingerprint: snapshot.sourceFingerprint, fallbackTitle: snapshot.title, fallbackTags: snapshot.tags });
    console.log(JSON.stringify({ result }));
    assert.equal(result, "written");
} else {
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    const children: Array<ReturnType<typeof spawn>> = [];
    async function seed(memoryId: string) {
        const content = store.buildMemoryFile({ id: memoryId, title: "Synthetic root fix", tags: ["fixture"], category: "general", created: "2026-01-01", updated: "2026-01-02", workspace, searchSummary: "handwritten", autoSummary: "old summary" }, "original body\n")
            .replace("\n---\n", "\ncustomOwner: keep-exact\n---\n");
        store.writeMemoryFile(hash, memoryId, content);
        await store.mutateWorkspaceIndex(hash, index => { index.entries.push({ id: memoryId, title: "Synthetic root fix", tags: ["fixture"], category: "general", searchSummary: "handwritten", autoSummary: "old summary", createdAt: "2026-01-01", updatedAt: "2026-01-02", lastAccessed: "2026-01-02", sizeBytes: Buffer.byteLength(content), lineCount: store.countLines(content) }); });
        return content;
    }
    function params(memoryId: string, content: string) {
        const snapshot = snapshots.captureAutoSummaryFileSnapshot(content)!;
        return { hash, memoryId, summary: "current body summary", expectedFingerprint: snapshot.fingerprint, expectedSummary: snapshot.expectedSummary,
            expectedSourceFingerprint: snapshot.sourceFingerprint, fallbackTitle: snapshot.title, fallbackTags: snapshot.tags };
    }
    function failGlobalIndexOnce() {
        let failed = false;
        fs.renameSync = (source, destination) => {
            if (!failed && path.resolve(String(destination)) === path.resolve(store.GLOBAL_INDEX_PATH)) {
                failed = true;
                throw Object.assign(new Error("synthetic-global-index-failure"), { code: "EIO" });
            }
            return originalRename(source, destination);
        };
    }
    try {
        for (const interruptedSupersession of [false, true]) {
            const memoryId = `pending-${interruptedSupersession}`;
            const before = await seed(memoryId);
            failGlobalIndexOnce();
            assert.equal(await storage.writeAutoSummaryIfUnchanged(params(memoryId, before)), "index-pending");
            fs.renameSync = originalRename;
            const old = storage.autoSummaryRecoveryInfo(hash, memoryId)!;
            const saved = JSON.parse(fs.readFileSync(old.backupPath, "utf8"));
            const changed = store.readMemoryFile(hash, memoryId)!.replace("original body", "current legitimate body").replace("customOwner: keep-exact", "customOwner: current-owner");
            store.writeMemoryFile(hash, memoryId, changed);
            assert.equal(await storage.writeAutoSummaryIfUnchanged(params(memoryId, before)), "stale");
            assert.equal(JSON.parse(fs.readFileSync(old.backupPath, "utf8")).phase, "file-written");
            if (interruptedSupersession) {
                const activePath = path.join(path.dirname(old.backupPath), "active.json");
                fs.unlinkSync = target => {
                    if (path.resolve(String(target)) === path.resolve(activePath)) throw Object.assign(new Error("synthetic-supersession-interruption"), { code: "EIO" });
                    return originalUnlink(target);
                };
                await assert.rejects(storage.writeAutoSummaryIfUnchanged(params(memoryId, changed)), /synthetic-supersession-interruption/u);
                fs.unlinkSync = originalUnlink;
                assert.equal(storage.autoSummaryRecoveryInfo(hash, memoryId), null);
            }
            const resume = spawnSync(process.execPath, ["--import", "tsx", filename, interruptedSupersession ? "--resume-summary" : "--repair-current", memoryId], { encoding: "utf8", timeout: 5000, windowsHide: true });
            assert.equal(resume.status, 0, resume.stderr);
            const archived = JSON.parse(fs.readFileSync(old.backupPath, "utf8"));
            assert.equal(archived.phase, "superseded");
            for (const field of ["before", "after", "beforeSha256", "afterSha256"]) assert.equal(archived[field], saved[field]);
            const current = store.readMemoryFile(hash, memoryId)!;
            assert.equal(snapshots.autoSummarySourceFingerprint(current), snapshots.autoSummarySourceFingerprint(changed));
            assert.match(current, /customOwner: current-owner/u);
            assert.equal(await storage.restoreAutoSummaryWriteback(hash, memoryId, old.operationId), "stale");
            assert.equal(store.readMemoryFile(hash, memoryId), current);
            indexCache.clear();
            assert.equal(store.readWorkspaceIndex(hash).entries.find(entry => entry.id === memoryId)?.autoSummary, "current body summary");
        }
        console.log("PASS stale pending backup retained, stale CAS rejected, fresh CAS commits after process restart and interrupted supersession");

        let releaseNested: () => void = () => {};
        let nestedEntered: () => void = () => {};
        const entered = new Promise<void>(resolve => { nestedEntered = resolve; });
        const gate = new Promise<void>(resolve => { releaseNested = resolve; });
        let nested: Promise<void> | undefined;
        let outerFinished = false;
        const outer = store.withMemoryLock(hash, "nested-lease", () => {
            nested = store.withMemoryLock(hash, "nested-lease", async () => { nestedEntered(); await gate; store.writeMemoryFile(hash, "nested-lease", "nested"); });
        }).then(() => { outerFinished = true; });
        await entered;
        let competitorRan = false;
        const competitor = store.withMemoryLock(hash, "nested-lease", () => { competitorRan = true; store.writeMemoryFile(hash, "nested-lease", "competitor"); });
        await delay(40);
        assert.equal(outerFinished, false);
        assert.equal(competitorRan, false);
        releaseNested();
        await Promise.all([outer, nested!, competitor]);
        assert.equal(store.readMemoryFile(hash, "nested-lease"), "competitor");
        console.log("PASS reentrant async lease remains exclusive until nested work settles");

        const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
        assert.equal(dead.status, 0);
        const deadPid = Number(dead.stdout);
        assert.throws(() => process.kill(deadPid, 0));
        store.writeMemoryFile(hash, "reaper-race", "0");
        const racedLock = lockPathFor("reaper-race");
        fs.writeFileSync(racedLock, JSON.stringify({ pid: deadPid, nonce: "dead-primary" }));
        const crash = spawnSync(process.execPath, ["--import", "tsx", filename, "--crash-reaper"], { encoding: "utf8", timeout: 5000, windowsHide: true });
        assert.equal(crash.status, 23, crash.stderr);
        const reaper = JSON.parse(fs.readFileSync(`${racedLock}.reap`, "utf8"));
        assert.equal(reaper.kind, "store-reaper");
        assert.throws(() => process.kill(reaper.pid, 0));
        const completions: Promise<unknown>[] = [];
        for (let count = 0; count < 2; count++) {
            const child = spawn(process.execPath, ["--max-old-space-size=128", "--import", "tsx", filename, "--increment"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            children.push(child);
            let stdout = "";
            let stderr = "";
            child.stdout!.on("data", chunk => { stdout += chunk; });
            child.stderr!.on("data", chunk => { stderr += chunk; });
            const completed = once(child, "exit").then(([code]) => assert.equal(code, 0, stderr));
            completions.push(completed);
            const deadline = Date.now() + 5000;
            while (!stdout.includes("READY") && child.exitCode === null && Date.now() < deadline) await delay(5);
            assert.match(stdout, /READY/u, stderr);
        }
        fs.writeFileSync(path.join(root, "start-workers"), "start");
        await Promise.all(completions);
        assert.equal(store.readMemoryFile(hash, "reaper-race"), "2");
        assert.equal(fs.readdirSync(path.join(root, ".memory-locks")).filter(name => name.startsWith(path.basename(racedLock))).length, 0);
        console.log("PASS actual reaper crash recovers, concurrent processes preserve exclusion, owned recovery files cleaned");

        for (const kind of ["active-reaper", "unknown-reaper", "unknown-primary"]) {
            const lockPath = lockPathFor(kind);
            const primary = kind === "unknown-primary" ? "unknown primary owner" : JSON.stringify({ pid: deadPid, nonce: kind });
            const reaper = kind === "active-reaper" ? JSON.stringify({ version: 1, kind: "store-reaper", pid: process.pid, nonce: kind }) : "";
            fs.writeFileSync(lockPath, primary);
            if (kind !== "unknown-primary") fs.writeFileSync(`${lockPath}.reap`, reaper);
            await assert.rejects(store.withMemoryLock(hash, kind, () => { throw new Error("unsafe lock entry"); }), error => (error as NodeJS.ErrnoException).code === "EEXIST");
            assert.equal(fs.readFileSync(lockPath, "utf8"), primary);
            if (kind !== "unknown-primary") assert.equal(fs.readFileSync(`${lockPath}.reap`, "utf8"), reaper);
            assert.equal(fs.readdirSync(path.join(root, ".memory-locks")).filter(name => name.startsWith(`${path.basename(lockPath)}.reap.claim-`)).length, 0);
        }
        console.log("PASS active reaper, legacy empty reaper and unknown primary are preserved on timeout");
    } finally {
        fs.renameSync = originalRename;
        fs.unlinkSync = originalUnlink;
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, "exit")));
        indexCache.clear();
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
