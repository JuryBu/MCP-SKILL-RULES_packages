import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import http from "node:http";

const childMode = process.argv.includes("--child-reentrant");
const root = childMode ? process.env.MEMORY_STORE_DATA_ROOT! : fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-independent-review-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const store = await import("../src/store.ts");
const storage = await import("../src/auto-summary-storage.ts");
const snapshots = await import("../src/auto-summary-snapshot.ts");
const { indexCache } = await import("../src/cache.ts");
const workspace = "C:/synthetic-independent-summary-review";
const { hash } = store.ensureWorkspace(workspace);

if (childMode) {
    const keepAlive = setInterval(() => {}, 1000);
    try {
        await store.withMemoryLock(hash, "nested-memory", async () => {
            console.log("OUTER_ACQUIRED");
            await store.withMemoryLock(hash, "nested-memory", () => console.log("INNER_ACQUIRED"));
        });
        console.log("NESTED_COMPLETE");
    } finally { clearInterval(keepAlive); }
} else {
    const findings: Array<{ id: string; severity: string; detail: unknown }> = [];
    const report = (id: string, severity: string, detail: unknown) => { findings.push({ id, severity, detail }); console.log(JSON.stringify({ finding: id, severity, detail })); };
    const originalRename = fs.renameSync;
    async function seed(memoryId: string): Promise<string> {
        const content = store.buildMemoryFile({ id: memoryId, title: "Synthetic review", tags: ["fixture"], category: "general", created: "2026-01-01", updated: "2026-01-02", workspace, searchSummary: "handwritten search", autoSummary: "old summary" }, "original body\n")
            .replace("\n---\n", "\ncustomField: keep-exact\n---\n");
        store.writeMemoryFile(hash, memoryId, content);
        await store.mutateWorkspaceIndex(hash, index => { index.entries.push({ id: memoryId, title: "Synthetic review", tags: ["fixture"], category: "general", searchSummary: "handwritten search", autoSummary: "old summary", createdAt: "2026-01-01", updatedAt: "2026-01-02", lastAccessed: "2026-01-02", sizeBytes: Buffer.byteLength(content), lineCount: store.countLines(content) }); });
        return content;
    }
    function params(memoryId: string, content: string, summary: string) {
        const snapshot = snapshots.captureAutoSummaryFileSnapshot(content)!;
        return { hash, memoryId, summary, expectedSummary: snapshot.expectedSummary, expectedFingerprint: snapshot.fingerprint, expectedSourceFingerprint: snapshot.sourceFingerprint,
            fallbackTitle: snapshot.title, fallbackTags: snapshot.tags,
            provenance: { version: 1 as const, status: "generated" as const, provider: "fixture", model: "fixture", generatedAt: "2026-01-03", failures: [] } };
    }
    function failNextIndex() {
        let failed = false;
        fs.renameSync = (source, destination) => {
            if (!failed && path.resolve(String(destination)) === path.resolve(store.GLOBAL_INDEX_PATH)) {
                failed = true;
                throw Object.assign(new Error("independent-synthetic-index-failure"), { code: "EIO" });
            }
            return originalRename(source, destination);
        };
    }
    try {
        if (!process.argv.includes("--locks-only")) {
            const memoryId = "pending-then-new-body";
            const before = await seed(memoryId);
            failNextIndex();
            const pending = await storage.writeAutoSummaryIfUnchanged(params(memoryId, before, "first repaired summary"));
            fs.renameSync = originalRename;
            assert.equal(pending, "index-pending");
            const after = store.readMemoryFile(hash, memoryId)!;
            assert.match(after, /customField: keep-exact/u);
            const changed = after.replace("original body", "legitimate new body").replace("updated: 2026-01-02", "updated: 2026-01-04");
            store.writeMemoryFile(hash, memoryId, changed);
            await store.mutateWorkspaceIndex(hash, index => { const entry = index.entries.find(item => item.id === memoryId)!; entry.updatedAt = "2026-01-04"; entry.sizeBytes = Buffer.byteLength(changed); });
            const first = await storage.writeAutoSummaryIfUnchanged(params(memoryId, changed, "new-body summary"));
            const second = await storage.writeAutoSummaryIfUnchanged(params(memoryId, store.readMemoryFile(hash, memoryId)!, "new-body summary"));
            assert.equal(snapshots.autoSummarySourceFingerprint(store.readMemoryFile(hash, memoryId)!), snapshots.autoSummarySourceFingerprint(changed));
            if (first !== "written" || !["written", "existing"].includes(second)) report("pending-journal-blocks-current-cas", "P1", { initial: pending, freshFingerprintResults: [first, second], phase: storage.autoSummaryRecoveryInfo(hash, memoryId)?.phase, currentBodyPreserved: true });

            const casId = "metadata-cas";
            const original = await seed(casId);
            const stale = params(casId, original, "should-not-write");
            const concurrent = original.replace("customField: keep-exact", "customField: independently-changed");
            store.writeMemoryFile(hash, casId, concurrent);
            assert.equal(await storage.writeAutoSummaryIfUnchanged(stale), "stale");
            assert.equal(store.readMemoryFile(hash, casId), concurrent);
            console.log("PASS independent CAS preserves concurrent non-summary metadata");
            const cachedBefore = store.readWorkspaceIndex(hash);
            const cachedText = JSON.stringify(cachedBefore);
            await store.mutateWorkspaceIndex(hash, index => { index.entries.find(entry => entry.id === casId)!.searchSummary = "fresh-index-summary"; });
            assert.equal(JSON.stringify(cachedBefore), cachedText);
            assert.equal(store.readWorkspaceIndex(hash).entries.find(entry => entry.id === casId)?.searchSummary, "fresh-index-summary");
            console.log("PASS index mutation replaces cache snapshots without mutating an old reader reference");

            const recoveryId = "recovery-control";
            const recoverBefore = await seed(recoveryId);
            failNextIndex();
            assert.equal(await storage.writeAutoSummaryIfUnchanged(params(recoveryId, recoverBefore, "recoverable summary")), "index-pending");
            fs.renameSync = originalRename;
            assert.equal(await storage.recoverAutoSummaryWriteback(hash, recoveryId), "written");
            const operation = storage.autoSummaryRecoveryInfo(hash, recoveryId)!;
            assert.equal(await storage.restoreAutoSummaryWriteback(hash, recoveryId, operation.operationId), "written");
            assert.equal(store.readMemoryFile(hash, recoveryId), recoverBefore);
            console.log("PASS independent index-pending recovery and restore without concurrent edit");

            const notice = "Synthetic Model is no longer available. Please switch to another model.";
            const modelServer = http.createServer((request, response) => {
                request.resume();
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(request.url === "/v1/models" ? { data: [{ id: "fixture-model" }] } : { choices: [{ message: { content: notice }, finish_reason: "stop" }] }));
            });
            await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
            const address = modelServer.address();
            assert.ok(address && typeof address !== "string");
            process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address.port}`;
            process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "0";
            process.env.MEMORY_STORE_CODEX_COMMAND = path.join(root, "no-real-model-command");
            const bridge = await import("../src/model-bridge.ts");
            const validation = await import("../src/auto-summary-validation.ts");
            const transport = await import("../src/provider-transport-adapter.ts");
            await transport.configureProviderTransportAdapterForTest({ mode: "shadow" });
            try {
                const ordinary = await bridge.callModelResponse("fixture-model", "controlled ordinary request", "grok", 2000);
                assert.equal(ordinary.text, notice);
                assert.equal(ordinary.chainUsed, "grok");
                const summaryCandidate = await bridge.callModelResponse("fixture-model", "controlled summary request", "grok", 2000, { responseValidator: candidate => validation.validateAutoSummaryCandidate(candidate.text) });
                assert.equal(summaryCandidate.text, null);
                assert.equal(summaryCandidate.failureClass, "Quality");
                console.log("PASS ordinary model bridge preserves text; only the explicit summary validator rejects the synthetic notice");
            } finally {
                await transport.resetProviderTransportAdapterForTest();
                modelServer.closeAllConnections();
                await new Promise<void>(resolve => modelServer.close(() => resolve()));
            }
        }
        if (!process.argv.includes("--pending-only")) {
            const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child-reentrant"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            let output = "";
            let errors = "";
            child.stdout.on("data", chunk => { output += chunk; });
            child.stderr.on("data", chunk => { errors += chunk; });
            const ended = once(child, "exit");
            const readyDeadline = Date.now() + 5000;
            while (!output.includes("OUTER_ACQUIRED") && child.exitCode === null && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
            assert.match(output, /OUTER_ACQUIRED/u, errors);
            await new Promise(resolve => setTimeout(resolve, 250));
            const nestedCompleted = output.includes("NESTED_COMPLETE");
            if (child.exitCode === null) child.kill();
            await ended;
            if (!nestedCompleted) report("same-context-memory-lock-deadlock", "P2", { outerAcquired: true, innerAcquired: output.includes("INNER_ACQUIRED"), boundedProbeMs: 250, childTerminated: true });

            const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 2000, windowsHide: true });
            assert.equal(dead.status, 0, dead.stderr);
            const deadPid = Number(dead.stdout);
            assert.throws(() => process.kill(deadPid, 0));
            const lockId = "dead-reaper";
            store.writeMemoryFile(hash, lockId, "synthetic original");
            const digest = crypto.createHash("sha256").update(JSON.stringify([hash, lockId])).digest("hex");
            const lockPath = path.join(root, ".memory-locks", `${digest}.lock`);
            fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, nonce: "dead-fixture" }));
            fs.writeFileSync(`${lockPath}.reap`, JSON.stringify({ version: 1, kind: "store-reaper", pid: deadPid, nonce: "dead-reaper-fixture" }));
            const started = Date.now();
            let lockError = "";
            try { await store.withMemoryLock(hash, lockId, () => store.writeMemoryFile(hash, lockId, "recovered")); }
            catch (error) { lockError = (error as NodeJS.ErrnoException).code || String(error); }
            if (lockError) report("dead-reaper-prevents-lock-recovery", "P2", { error: lockError, elapsedMs: Date.now() - started, lockStillPresent: fs.existsSync(lockPath), reaperStillPresent: fs.existsSync(`${lockPath}.reap`), bodyPreserved: store.readMemoryFile(hash, lockId) === "synthetic original" });
        }
        console.log(JSON.stringify({ completed: true, findings, actualModelRequests: 0, temporaryRootOwned: true }));
        if (findings.length) process.exitCode = 1;
    } finally {
        fs.renameSync = originalRename;
        indexCache.clear();
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
