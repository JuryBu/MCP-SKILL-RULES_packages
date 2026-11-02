import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-repair-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const store = await import("../src/store.ts");
const summary = await import("../src/auto-summary.ts");
const repair = await import("../src/auto-summary-repair.ts");
const { registerStats } = await import("../src/tools/stats.ts");
const { indexCache } = await import("../src/cache.ts");
const workspace = "C:/synthetic-summary-repair";
const { hash } = store.ensureWorkspace(workspace);
const oldSummary = "Synthetic Model is no longer available. Please switch to another model.";
const originalRename = fs.renameSync;
let generations = 0;

async function seed(memoryId: string, autoSummary = oldSummary): Promise<string> {
    const frontmatter = { id: memoryId, title: "合成摘要测试", tags: ["synthetic"], category: "general", created: "2026-01-01", updated: "2026-01-02", workspace, searchSummary: "保留手写搜索摘要", autoSummary, pinned: true };
    const content = store.buildMemoryFile(frontmatter, "\n合成正文原样保留。\n\n---\n正文中的分隔线也保留。\n").replace("\n---\n", "\ncustomOwner: synthetic\ncustomBlock: |\n  alpha\n  beta\n---\n");
    store.writeMemoryFile(hash, memoryId, content);
    await store.mutateWorkspaceIndex(hash, index => {
        index.entries.push({ id: memoryId, title: frontmatter.title, tags: frontmatter.tags, category: frontmatter.category, searchSummary: frontmatter.searchSummary, autoSummary, createdAt: frontmatter.created, updatedAt: frontmatter.updated, lastAccessed: frontmatter.updated, sizeBytes: Buffer.byteLength(content), lineCount: store.countLines(content), pinned: true });
    });
    await store.syncGlobalIndexForWorkspace(hash);
    return content;
}

function confirmed(memoryId: string) {
    const target = repair.inspectAutoSummaryRepairTarget(hash, memoryId);
    assert.ok(target);
    return { ...target, confirmed: true as const, reason: "Manually confirmed synthetic service notice" };
}

async function generate() {
    generations++;
    return { summary: "合成正文及手写检索说明保持原样，保存经确认的新摘要。", provenance: { version: 1 as const, status: "generated" as const, provider: "fixture-provider", model: "fixture-model", generatedAt: "2026-01-03T00:00:00.000Z", failures: [] } };
}

function assertIndexes(memoryId: string, expectedSummary: string): void {
    indexCache.clear();
    const index = store.readWorkspaceIndex(hash);
    const content = store.readMemoryFile(hash, memoryId)!;
    const entry = index.entries.find(candidate => candidate.id === memoryId)!;
    assert.equal(entry.autoSummary, expectedSummary);
    assert.equal(entry.sizeBytes, Buffer.byteLength(content));
    assert.equal(entry.lineCount, store.countLines(content));
    assert.equal(store.readGlobalIndex().workspaces[hash].totalSizeBytes, index.entries.reduce((total, candidate) => total + candidate.sizeBytes, 0));
}

function failNextAtomicWrite(target: string): void {
    let failed = false;
    fs.renameSync = (source, destination) => {
        if (!failed && path.resolve(String(destination)) === path.resolve(target)) {
            failed = true;
            throw Object.assign(new Error("synthetic-index-write-failure"), { code: "EIO" });
        }
        return originalRename(source, destination);
    };
}

try {
    const original = await seed("confirmed-repair");
    const target = confirmed("confirmed-repair");
    const denied = await repair.repairConfirmedAutoSummaries([{ ...target, confirmed: false } as never], { generate });
    assert.equal(denied[0].status, "unconfirmed");
    assert.equal(generations, 0);
    const normal = summary.captureAutoSummaryFileSnapshot(original)!;
    assert.equal(await summary.writeAutoSummaryIfUnchanged({ hash, memoryId: target.memoryId, summary: "普通补缺应保留旧摘要", expectedFingerprint: normal.fingerprint, fallbackTitle: normal.title, fallbackTags: normal.tags }), "existing");
    assert.equal(await summary.writeAutoSummaryIfUnchanged({ hash, memoryId: target.memoryId, summary: "HTTP 503: Service unavailable", expectedFingerprint: normal.fingerprint, fallbackTitle: normal.title, fallbackTags: normal.tags }), "invalid");
    assert.equal(store.readMemoryFile(hash, target.memoryId), original);
    const replaced = await repair.repairConfirmedAutoSummaries([target], { generate, chain: "grok" });
    assert.equal(replaced[0].status, "written");
    assert.equal(generations, 1);
    const after = store.readMemoryFile(hash, target.memoryId)!;
    assert.equal(summary.autoSummarySourceFingerprint(after), summary.autoSummarySourceFingerprint(original));
    assert.equal(store.parseMemoryFile(after)?.body, store.parseMemoryFile(original)?.body);
    assert.match(after, /customBlock: \|\n  alpha\n  beta/);
    const provenance = JSON.parse(String(store.parseMemoryFile(after)?.frontmatter.autoSummaryProvenance));
    assert.equal(provenance.model, "fixture-model");
    assert.equal(provenance.provider, "fixture-provider");
    assert.equal(provenance.generatedAt, "2026-01-03T00:00:00.000Z");
    assertIndexes(target.memoryId, (await generate()).summary!);
    const generationCount = generations;
    assert.equal((await repair.repairConfirmedAutoSummaries([target], { generate }))[0].status, "stale");
    assert.equal(generations, generationCount);
    const recovery = summary.autoSummaryRecoveryInfo(hash, target.memoryId)!;
    const backup = JSON.parse(fs.readFileSync(recovery.backupPath, "utf-8"));
    assert.equal(backup.before, original);
    assert.equal(await summary.restoreAutoSummaryWriteback(hash, target.memoryId, recovery.operationId), "written");
    assert.equal(store.readMemoryFile(hash, target.memoryId), original);
    assertIndexes(target.memoryId, oldSummary);
    assert.equal(await summary.restoreAutoSummaryWriteback(hash, target.memoryId, recovery.operationId), "written");

    for (const change of ["body", "metadata", "summary", "summary-whitespace"]) {
        const memoryId = `stale-${change}`;
        const before = await seed(memoryId);
        const staleTarget = confirmed(memoryId);
        const changed = change === "body" ? before + "并发追加\n"
            : change === "metadata" ? before.replace("customOwner: synthetic", "customOwner: changed")
                : before.replace(oldSummary, change === "summary" ? "并发的新摘要" : oldSummary + " ");
        const result = await repair.repairConfirmedAutoSummaries([staleTarget], {
            generate: async () => {
                store.writeMemoryFile(hash, memoryId, changed);
                return generate();
            },
        });
        assert.equal(result[0].status, "stale", change);
        assert.equal(store.readMemoryFile(hash, memoryId), changed, change);
    }

    const indexPath = path.join(store.WORKSPACES_DIR, hash, "_index.json");
    for (const scope of ["workspace", "global"]) {
        const memoryId = `partial-${scope}`;
        const before = await seed(memoryId);
        const partialTarget = confirmed(memoryId);
        failNextAtomicWrite(scope === "workspace" ? indexPath : store.GLOBAL_INDEX_PATH);
        const result = await repair.repairConfirmedAutoSummaries([partialTarget], { generate });
        fs.renameSync = originalRename;
        assert.equal(result[0].status, "index-pending", scope);
        assert.match(summary.autoSummaryRecoveryInfo(hash, memoryId)?.error || "", /synthetic-index-write-failure/);
        assert.notEqual(store.readMemoryFile(hash, memoryId), before);
        indexCache.clear();
        if (scope === "global") {
            const restartManifestPath = path.join(root, "restart-recovery.json");
            const restartManifest = JSON.stringify({ version: 1, targets: [partialTarget] });
            fs.writeFileSync(restartManifestPath, restartManifest);
            const restart = spawnSync(process.execPath, ["--import", "tsx", "scripts/repair-auto-summaries.mjs", "--data-root", root, "--manifest", restartManifestPath, "--recover", "--confirm-sha256", crypto.createHash("sha256").update(restartManifest).digest("hex")], { encoding: "utf-8", timeout: 15_000 });
            assert.equal(restart.status, 0, restart.stderr);
            const recovered = JSON.parse(restart.stdout);
            assert.equal(recovered.modelRequests, 0);
            assert.equal(recovered.outcomes[0].status, "written");
        } else {
            process.env.MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:1";
            let statsCallback: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
            registerStats({ tool: (_name: string, _description: string, _schema: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) => { statsCallback = callback; } } as never);
            assert.ok(statsCallback);
            const enhanced = await statsCallback({ action: "enhance", workspace, modelChain: "grok" });
            assert.match(JSON.stringify(enhanced), /无需增强/);
            assert.equal(summary.autoSummaryRecoveryInfo(hash, memoryId)?.phase, "complete");
        }
        assertIndexes(memoryId, "合成正文及手写检索说明保持原样，保存经确认的新摘要。");
        assert.equal(await summary.recoverAutoSummaryWriteback(hash, memoryId), "existing");
        const info = summary.autoSummaryRecoveryInfo(hash, memoryId)!;
        failNextAtomicWrite(store.GLOBAL_INDEX_PATH);
        assert.equal(await summary.restoreAutoSummaryWriteback(hash, memoryId, info.operationId), "index-pending");
        fs.renameSync = originalRename;
        assert.equal(await summary.recoverAutoSummaryWriteback(hash, memoryId), "written");
        assert.equal(store.readMemoryFile(hash, memoryId), before);
        assertIndexes(memoryId, oldSummary);
    }

    const failedId = "failed-generation";
    const failedBefore = await seed(failedId);
    const failures = await repair.repairConfirmedAutoSummaries([confirmed(failedId)], {
        generate: async () => ({ summary: null, provenance: { version: 1, status: "failed", provider: "grok", model: "fixture-model", generatedAt: "2026-01-04", failures: [{ provider: "grok", model: "fixture-model", reason: "synthetic-service-error", occurredAt: "2026-01-04", kind: "provider" }] } }),
    });
    assert.equal(failures[0].status, "generation-failed");
    const failedAfter = store.readMemoryFile(hash, failedId)!;
    assert.equal(summary.autoSummarySourceFingerprint(failedAfter), summary.autoSummarySourceFingerprint(failedBefore));
    assert.equal(store.parseMemoryFile(failedAfter)?.frontmatter.autoSummary, oldSummary);
    assert.match(String(store.parseMemoryFile(failedAfter)?.frontmatter.autoSummaryProvenance), /synthetic-service-error/);
    for (const terminal of [{ cancelled: true }, { safetyStopped: true }, { failureClass: "UnknownOutcome" }]) {
        const firstId = `stop-first-${Object.keys(terminal)[0]}`;
        const secondId = `stop-second-${Object.keys(terminal)[0]}`;
        await seed(firstId);
        await seed(secondId);
        let calls = 0;
        const stopped = await repair.repairConfirmedAutoSummaries([confirmed(firstId), confirmed(secondId)], {
            generate: async () => { calls++; return { summary: null, provenance: { version: 1, status: "failed", provider: "codex", model: "fixture-model", generatedAt: "2026-01-04", failures: [], ...terminal } }; },
        });
        assert.equal(calls, 1);
        assert.equal(stopped[1].status, "not-started");
    }
    const conflictId = "pending-recovery-conflict";
    await seed(conflictId);
    const conflictTarget = confirmed(conflictId);
    failNextAtomicWrite(store.GLOBAL_INDEX_PATH);
    assert.equal((await repair.repairConfirmedAutoSummaries([conflictTarget], { generate }))[0].status, "index-pending");
    fs.renameSync = originalRename;
    const conflictInfo = summary.autoSummaryRecoveryInfo(hash, conflictId)!;
    const modified = store.readMemoryFile(hash, conflictId)! + "恢复前另一次正文更新\n";
    store.writeMemoryFile(hash, conflictId, modified);
    assert.equal(await summary.recoverAutoSummaryWriteback(hash, conflictId), "stale");
    assert.equal(await summary.restoreAutoSummaryWriteback(hash, conflictId, conflictInfo.operationId), "stale");
    assert.equal(store.readMemoryFile(hash, conflictId), modified);

    const manifestPath = path.join(root, "confirmed-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, targets: [confirmed("confirmed-repair")] }));
    const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/repair-auto-summaries.mjs", "--data-root", root, "--manifest", manifestPath], { encoding: "utf-8", timeout: 15_000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).modelRequests, 0);
    const rejectedApply = spawnSync(process.execPath, ["--import", "tsx", "scripts/repair-auto-summaries.mjs", "--data-root", root, "--manifest", manifestPath, "--apply"], { encoding: "utf-8", timeout: 15_000 });
    assert.notEqual(rejectedApply.status, 0);
    assert.match(rejectedApply.stderr, /confirm-sha256/);
    console.log("auto-summary-repair: confirmation gate, exact CAS, body/metadata preservation, durable provenance, backup/restore, workspace/global partial recovery, stops, idempotence and read-only CLI passed");
} finally {
    fs.renameSync = originalRename;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
