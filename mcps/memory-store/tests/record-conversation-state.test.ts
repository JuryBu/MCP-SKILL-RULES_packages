import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const state = await import("../src/record-conversation-state.ts");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-conversation-state-"));
const dataRoot = path.join(tempRoot, "data");
const repairRoot = path.join(tempRoot, "repair");
const missingRepairRoot = path.join(tempRoot, "missing-repair");
const corruptFirstInstallRoot = path.join(tempRoot, "corrupt-first-install");
const crossRoot = path.join(tempRoot, "cross-root");
const wrongAuthorityRoot = path.join(tempRoot, "wrong-authority-root");
const hashAuthorityRoot = path.join(tempRoot, "hash-authority-root");
const unknownSchemaRoot = path.join(tempRoot, "unknown-schema-root");
const unknownEntryRoot = path.join(tempRoot, "unknown-entry-root");
const pathReplacementRoot = path.join(tempRoot, "path-replacement-root");
const takeoverRoot = path.join(tempRoot, "takeover-root");
const junctionTargetRoot = path.join(tempRoot, "junction-target");
const junctionRoot = path.join(tempRoot, "junction-root");

function firstInstallAuthority(authorityId: string) {
    return {
        kind: "first-install" as const,
        authorityId,
        observedAt: "2026-07-14T00:00:00.000Z",
    };
}

function identity(conversationId: string, chain: "codex" | "antigravity" = "codex", workspaceHash = "workspace-a") {
    return { chain, workspaceHash, conversationId } as const;
}

function makeEvidence(conversationId: string, revision: string, observedAt = "2026-07-14T00:02:00.000Z") {
    return {
        identity: identity(conversationId),
        latestObservedRevision: revision,
        state: "Stale" as const,
        evidence: {
            source: "test-complete-evidence",
            complete: true,
            observedAt,
            evidenceHash: `evidence-${conversationId}-${revision}`,
            scanId: `scan-${conversationId}-${revision}`,
            details: { fixture: true },
        },
    };
}

function rootBindingFor(root: string) {
    const requestedDataRoot = path.resolve(root);
    fs.mkdirSync(requestedDataRoot, { recursive: true });
    const stat = fs.lstatSync(requestedDataRoot);
    return {
        requestedDataRoot,
        realDataRoot: fs.realpathSync(requestedDataRoot),
        rootIdentity: `${stat.dev}:${stat.ino}`,
    };
}

function authoritySnapshots(rootBinding: ReturnType<typeof rootBindingFor>, snapshotId = "authority-snapshot-1") {
    const authorityRef = path.join(rootBinding.requestedDataRoot, `record-conversation-state-authority-${snapshotId}.json`);
    const unsigned = {
        kind: "record-conversation-state-authority-snapshots" as const,
        snapshotId,
        capturedAt: "2026-07-14T00:03:00.000Z",
        rootBinding,
        authorityRevision: 7,
        authorityRef,
        recordIndex: [{
            identity: identity("repair-conversation"),
            workspace: "C:\\workspace\\repair",
            titleBestEffort: "Repair fixture",
            recordCoveredRevision: "revision-1",
            recordBodyHash: "body-hash-1",
        }],
        schedulerLedgers: [{
            identity: identity("repair-conversation"),
            taskId: "ledger-task",
            active: true,
            recordWorkKey: "work-from-ledger",
            pendingRefreshKey: "refresh-from-ledger",
        }],
        workRegistry: [{
            identity: identity("repair-conversation"),
            activeTaskIds: ["registry-task", "ledger-task"],
            recordWorkKey: "work-from-registry",
            pendingRefreshKey: "refresh-from-registry",
        }],
        recentCompleteEvidence: [makeEvidence("repair-conversation", "revision-2")],
    };
    const authority = { ...unsigned, authorityHash: state.calculateRecordConversationStateAuthorityHash(unsigned) };
    fs.writeFileSync(authorityRef, JSON.stringify(authority), "utf8");
    return authority;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function runChild(dataRootForChild: string, source: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const workerPath = path.join(dataRootForChild, `record-conversation-state-child-${Math.random().toString(16).slice(2)}.mts`);
    const moduleUrl = pathToFileURL(path.resolve("src/record-conversation-state.ts")).href;
    fs.mkdirSync(dataRootForChild, { recursive: true });
    fs.writeFileSync(workerPath, `import * as state from ${JSON.stringify(moduleUrl)};\n${source}`, "utf8");
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: dataRootForChild },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "close") as [number | null];
    return { code, stdout, stderr };
}

async function expectReject(action: () => Promise<unknown>, matcher: RegExp): Promise<void> {
    await assert.rejects(action, matcher);
}

try {
    const initialRead = await state.readRecordConversationStateStore({ dataRoot });
    assert.equal(initialRead.kind, "missing", "新 DATA_ROOT 必须和损坏文件区分为 missing");

    const initialized = await state.initializeRecordConversationStateStore({
        dataRoot,
        authority: firstInstallAuthority("fresh-install"),
        nowMs: Date.parse("2026-07-14T00:00:00.000Z"),
    });
    assert.equal(initialized.index.schemaVersion, 1);
    assert.equal(initialized.index.initialized, true);
    assert.equal(initialized.index.revision, 1);
    assert.equal(initialized.receipt.atomicReplace, true);
    assert.equal(initialized.receipt.targetFileSynced, true);

    const contradictoryPatches = [
        {
            latestObservedRevision: "fresh-a",
            recordCoveredRevision: "fresh-b",
            state: "Fresh" as const,
            pendingRefreshKey: null,
        },
        {
            latestObservedRevision: "fresh-a",
            recordCoveredRevision: "fresh-a",
            state: "Fresh" as const,
            pendingRefreshKey: "must-be-empty",
        },
        {
            latestObservedRevision: "stale-a",
            recordCoveredRevision: "stale-a",
            state: "Stale" as const,
            pendingRefreshKey: "refresh-stale",
        },
        {
            latestObservedRevision: "stale-a",
            recordCoveredRevision: "stale-b",
            state: "Stale" as const,
            pendingRefreshKey: null,
        },
    ];
    for (const [index, patch] of contradictoryPatches.entries()) {
        await expectReject(
            () => state.upsertRecordConversationState({ dataRoot, identity: identity(`contradiction-${index}`), expectedEntryRevision: null, patch }),
            /要求/u,
        );
    }
    await expectReject(
        () => state.upsertRecordConversationState({
            dataRoot,
            identity: identity("unknown-patch"),
            expectedEntryRevision: null,
            patch: {
                latestObservedRevision: "unknown-current",
                recordCoveredRevision: "unknown-current",
                state: "Fresh",
                pendingRefreshKey: null,
                unexpectedField: true,
            } as never,
        }),
        /未知字段/u,
    );

    const childManySource = `
const root = process.env.MEMORY_STORE_DATA_ROOT;
const prefix = process.argv[2];
for (let offset = 0; offset < 32; offset += 1) {
    const result = await state.upsertRecordConversationState({
        dataRoot: root,
        lockWaitMs: 30_000,
        identity: { chain: "codex", workspaceHash: "workspace-a", conversationId: prefix + "-" + offset },
        expectedEntryRevision: null,
        patch: {
            latestObservedRevision: "revision-" + offset,
            recordCoveredRevision: "covered-" + offset,
            state: "Stale",
            pendingRefreshKey: "refresh-" + prefix + "-" + offset,
            evidence: [{ source: "child", complete: true, observedAt: "2026-07-14T00:01:00.000Z", evidenceHash: prefix + "-" + offset }],
            activeTaskIds: [prefix + "-task-" + offset],
        },
    });
    if (result.kind !== "updated") throw new Error("child different-conversation update conflict: " + JSON.stringify(result));
}
process.stdout.write("MANY_OK");
`;
    const manyWorkers = await Promise.all([
        runChild(dataRoot, childManySource, ["a"]),
        runChild(dataRoot, childManySource, ["b"]),
    ]);
    for (const [index, worker] of manyWorkers.entries()) {
        assert.equal(worker.code, 0, `不同会话 child ${index} 失败: ${worker.stderr}`);
        assert.match(worker.stdout, /MANY_OK/u);
    }

    const afterMany = await state.readRecordConversationStateStore({ dataRoot });
    assert.equal(afterMany.kind, "current");
    if (afterMany.kind === "current") {
        assert.equal(Object.keys(afterMany.index.entries).length, 64, "两个 child process 写入 64 个不同会话不得丢条目");
    }

    const sharedCodex = identity("same-conversation", "codex", "workspace-a");
    const sharedAntigravity = identity("same-conversation", "antigravity", "workspace-b");
    for (const item of [sharedCodex, sharedAntigravity]) {
        const inserted = await state.upsertRecordConversationState({
            dataRoot,
            identity: item,
            expectedEntryRevision: null,
            patch: {
                latestObservedRevision: `latest-${item.chain}`,
                recordCoveredRevision: null,
                state: "Missing",
                pendingRefreshKey: `refresh-${item.chain}`,
                activeTaskIds: [],
            },
        });
        assert.equal(inserted.kind, "updated");
    }
    const secondary = await state.findRecordConversationStatesByConversationId("same-conversation", { dataRoot });
    assert.equal(secondary.kind, "current");
    if (secondary.kind === "current") {
        assert.equal(secondary.entries.length, 2, "conversationId 二级索引必须保留不同 chain/workspace 的两个 canonical entry");
        assert.deepEqual(secondary.entries.map(entry => entry.chain).sort(), ["antigravity", "codex"]);
    }

    const casIdentity = identity("cas-conversation");
    const casSeed = await state.upsertRecordConversationState({
        dataRoot,
        identity: casIdentity,
        expectedEntryRevision: null,
        patch: {
            latestObservedRevision: "cas-current",
            recordCoveredRevision: "cas-previous",
            state: "Stale",
            pendingRefreshKey: "cas-refresh",
            activeTaskIds: [],
        },
    });
    assert.equal(casSeed.kind, "updated");
    const childCasSource = `
const result = await state.upsertRecordConversationState({
    dataRoot: process.env.MEMORY_STORE_DATA_ROOT,
    lockWaitMs: 30_000,
    identity: { chain: "codex", workspaceHash: "workspace-a", conversationId: "cas-conversation" },
    expectedEntryRevision: 1,
    patch: { state: "Fresh", recordCoveredRevision: "cas-current", pendingRefreshKey: null, stateReason: process.argv[2], activeTaskIds: [] },
});
process.stdout.write(result.kind === "updated" ? "CAS_UPDATED" : "CAS_CONFLICT");
`;
    const casWorkers = await Promise.all([
        runChild(dataRoot, childCasSource, ["writer-a"]),
        runChild(dataRoot, childCasSource, ["writer-b"]),
    ]);
    assert.equal(casWorkers.filter(worker => worker.code === 0 && worker.stdout.includes("CAS_UPDATED")).length, 1, JSON.stringify(casWorkers));
    assert.equal(casWorkers.filter(worker => worker.code === 0 && worker.stdout.includes("CAS_CONFLICT")).length, 1, JSON.stringify(casWorkers));
    const casRead = await state.readRecordConversationStateStore({ dataRoot });
    assert.equal(casRead.kind, "current");
    if (casRead.kind === "current") {
        const entry = casRead.index.entries[state.canonicalConversationStateKey(casIdentity)];
        assert.equal(entry.entryRevision, 2, "同 key 的两个 stale expected revision 只能有一个胜者");
    }

    const repairBinding = rootBindingFor(repairRoot);
    const repairAuthority = authoritySnapshots(repairBinding);
    const repairAuthorityBefore = JSON.stringify(repairAuthority);
    const repairAuthorityFileBefore = fs.readFileSync(repairAuthority.authorityRef, "utf8");
    await state.initializeRecordConversationStateStore({ dataRoot: repairRoot, authority: firstInstallAuthority("repair-root") });
    fs.writeFileSync(state.recordConversationStatePath({ dataRoot: repairRoot }), "{broken-json", "utf8");
    const corruptRead = await state.readRecordConversationStateStore({ dataRoot: repairRoot });
    assert.equal(corruptRead.kind, "corrupt", "损坏 JSON 不能被误判为 missing");
    await expectReject(
        () => state.initializeRecordConversationStateStore({ dataRoot: repairRoot, authority: firstInstallAuthority("must-not-overwrite-corrupt") }),
        /首次初始化不得覆盖损坏文件/u,
    );
    const repaired = await state.repairRecordConversationStateStore({ dataRoot: repairRoot, authority: repairAuthority });
    const repairedEntry = repaired.index.entries[state.canonicalConversationStateKey(identity("repair-conversation"))];
    assert.equal(repairedEntry.latestObservedRevision, "revision-2");
    assert.equal(repairedEntry.recordCoveredRevision, "revision-1");
    assert.equal(repairedEntry.state, "Stale");
    assert.deepEqual(repairedEntry.activeTaskIds, ["ledger-task", "registry-task"]);
    assert.equal(JSON.stringify(repairAuthority), repairAuthorityBefore, "repair 只能读 authority snapshots，不得反写权威账本快照");
    assert.equal(fs.readFileSync(repairAuthority.authorityRef, "utf8"), repairAuthorityFileBefore, "repair 不得改写 authorityRef 文件");

    const missingRepairAuthority = authoritySnapshots(rootBindingFor(missingRepairRoot), "missing-authority");
    const repairedMissing = await state.repairRecordConversationStateStore({ dataRoot: missingRepairRoot, authority: missingRepairAuthority });
    assert.equal(repairedMissing.index.initialized, true, "missing 索引可由显式 authority snapshots repair");

    await expectReject(
        () => state.repairRecordConversationStateStore({ dataRoot: wrongAuthorityRoot, authority: repairAuthority }),
        /绑定到另一个 DATA_ROOT/u,
    );
    const tamperedAuthority = authoritySnapshots(rootBindingFor(hashAuthorityRoot), "tampered-authority");
    tamperedAuthority.recordIndex[0].recordBodyHash = "tampered-after-hash";
    await expectReject(
        () => state.repairRecordConversationStateStore({ dataRoot: hashAuthorityRoot, authority: tamperedAuthority }),
        /hash 校验失败/u,
    );

    fs.mkdirSync(corruptFirstInstallRoot, { recursive: true });
    fs.writeFileSync(state.recordConversationStatePath({ dataRoot: corruptFirstInstallRoot }), "{bad", "utf8");
    await expectReject(
        () => state.initializeRecordConversationStateStore({ dataRoot: corruptFirstInstallRoot, authority: firstInstallAuthority("corrupt-first") }),
        /首次初始化不得覆盖损坏文件/u,
    );

    await state.initializeRecordConversationStateStore({ dataRoot: crossRoot, authority: firstInstallAuthority("cross-root") });
    fs.copyFileSync(state.recordConversationStatePath({ dataRoot }), state.recordConversationStatePath({ dataRoot: crossRoot }));
    await expectReject(
        () => state.readRecordConversationStateStore({ dataRoot: crossRoot }),
        /绑定到另一个 DATA_ROOT/u,
    );

    const unknownSchemaInitialized = await state.initializeRecordConversationStateStore({
        dataRoot: unknownSchemaRoot,
        authority: firstInstallAuthority("unknown-schema"),
    });
    const unknownSchemaDocument = structuredClone(unknownSchemaInitialized.index) as typeof unknownSchemaInitialized.index & { unexpectedRootField?: boolean };
    unknownSchemaDocument.unexpectedRootField = true;
    unknownSchemaDocument.persistedHash = state.calculateRecordConversationStateHash(unknownSchemaDocument);
    fs.writeFileSync(state.recordConversationStatePath({ dataRoot: unknownSchemaRoot }), JSON.stringify(unknownSchemaDocument), "utf8");
    const unknownSchemaRead = await state.readRecordConversationStateStore({ dataRoot: unknownSchemaRoot });
    assert.equal(unknownSchemaRead.kind, "corrupt");
    if (unknownSchemaRead.kind === "corrupt") assert.match(unknownSchemaRead.detail, /未知字段/u);

    await state.initializeRecordConversationStateStore({ dataRoot: unknownEntryRoot, authority: firstInstallAuthority("unknown-entry") });
    const unknownEntryIdentity = identity("unknown-entry");
    await state.upsertRecordConversationState({
        dataRoot: unknownEntryRoot,
        identity: unknownEntryIdentity,
        expectedEntryRevision: null,
        patch: {
            latestObservedRevision: "entry-revision",
            recordCoveredRevision: "entry-revision",
            state: "Fresh",
            pendingRefreshKey: null,
        },
    });
    const unknownEntryPath = state.recordConversationStatePath({ dataRoot: unknownEntryRoot });
    const unknownEntryDocument = JSON.parse(fs.readFileSync(unknownEntryPath, "utf8")) as Record<string, any>;
    unknownEntryDocument.entries[state.canonicalConversationStateKey(unknownEntryIdentity)].unexpectedEntryField = true;
    unknownEntryDocument.persistedHash = state.calculateRecordConversationStateHash(unknownEntryDocument as never);
    fs.writeFileSync(unknownEntryPath, JSON.stringify(unknownEntryDocument), "utf8");
    const unknownEntryRead = await state.readRecordConversationStateStore({ dataRoot: unknownEntryRoot });
    assert.equal(unknownEntryRead.kind, "corrupt");
    if (unknownEntryRead.kind === "corrupt") assert.match(unknownEntryRead.detail, /未知字段/u);

    await state.initializeRecordConversationStateStore({ dataRoot: pathReplacementRoot, authority: firstInstallAuthority("path-replacement") });
    const replacementPath = state.recordConversationStatePath({ dataRoot: pathReplacementRoot });
    const replacementBackup = path.join(pathReplacementRoot, "record-conversation-state.before-replacement.json");
    let replacementInjected = false;
    state.setRecordConversationStatePathSafetyTestHookForTest(async context => {
        if (replacementInjected || context.filePath !== replacementPath || context.label !== "conversation-state 索引") return;
        replacementInjected = true;
        fs.renameSync(replacementPath, replacementBackup);
        fs.copyFileSync(replacementBackup, replacementPath);
    });
    try {
        await expectReject(
            () => state.readRecordConversationStateStore({ dataRoot: pathReplacementRoot }),
            /open 后被替换/u,
        );
    } finally {
        state.setRecordConversationStatePathSafetyTestHookForTest(undefined);
        fs.rmSync(replacementPath, { force: true });
        fs.renameSync(replacementBackup, replacementPath);
    }
    assert.equal(replacementInjected, true);
    assert.match(state.RECORD_CONVERSATION_STATE_NOFOLLOW_MODE, /nofollow|identity/u);

    fs.mkdirSync(junctionTargetRoot, { recursive: true });
    fs.symlinkSync(junctionTargetRoot, junctionRoot, process.platform === "win32" ? "junction" : "dir");
    await expectReject(
        () => state.readRecordConversationStateStore({ dataRoot: junctionRoot }),
        /安全真实目录|realpath/u,
    );

    await state.initializeRecordConversationStateStore({ dataRoot: takeoverRoot, authority: firstInstallAuthority("takeover") });
    const takeoverIdentity = identity("takeover-conversation");
    const takeoverSeed = await state.upsertRecordConversationState({
        dataRoot: takeoverRoot,
        identity: takeoverIdentity,
        expectedEntryRevision: null,
        patch: {
            latestObservedRevision: "takeover-revision",
            recordCoveredRevision: "takeover-revision",
            state: "Fresh",
            pendingRefreshKey: null,
            stateReason: "seed",
        },
    });
    assert.equal(takeoverSeed.kind, "updated");
    let takeoverRevision = 1;
    for (let round = 0; round < 20; round += 1) {
        let logicalNowMs = 2_000_000_000_000 + round * 100;
        let staleToken: string | null = null;
        const staleAtPublish = deferred();
        const resumeStaleOwner = deferred();
        state.setRecordConversationStateLockTestControlForTest({
            nowMs: () => logicalNowMs,
            onPhase: async context => {
                if (context.phase === "after-acquire" && staleToken === null) staleToken = context.token;
                if (context.phase === "before-publish-fence" && context.token === staleToken) {
                    staleAtPublish.resolve();
                    await resumeStaleOwner.promise;
                }
            },
        });
        const staleOwner = state.upsertRecordConversationState({
            dataRoot: takeoverRoot,
            lockLeaseMs: 10,
            lockHeartbeatMs: false,
            identity: takeoverIdentity,
            expectedEntryRevision: takeoverRevision,
            patch: { stateReason: `stale-owner-${round}` },
        });
        try {
            await staleAtPublish.promise;
            logicalNowMs += 11;
            const winner = await state.upsertRecordConversationState({
                dataRoot: takeoverRoot,
                lockLeaseMs: 10,
                lockHeartbeatMs: false,
                identity: takeoverIdentity,
                expectedEntryRevision: takeoverRevision,
                patch: { stateReason: `winner-${round}` },
            });
            assert.equal(winner.kind, "updated", `第 ${round} 轮接管者必须成功`);
            resumeStaleOwner.resolve();
            await assert.rejects(staleOwner, error => error instanceof state.ConversationStateLockFencedError && error.code === "LOCK_FENCED");
            takeoverRevision += 1;
            const afterTakeover = await state.readRecordConversationStateStore({ dataRoot: takeoverRoot });
            assert.equal(afterTakeover.kind, "current");
            if (afterTakeover.kind === "current") {
                const entry = afterTakeover.index.entries[state.canonicalConversationStateKey(takeoverIdentity)];
                assert.equal(entry.entryRevision, takeoverRevision);
                assert.equal(entry.stateReason, `winner-${round}`, "旧 owner 恢复后不得 replace 新 owner 结果");
            }
        } finally {
            resumeStaleOwner.resolve();
            await staleOwner.catch(() => undefined);
            state.setRecordConversationStateLockTestControlForTest(undefined);
        }
    }

    console.log("record conversation state tests passed");
} finally {
    state.setRecordConversationStateLockTestControlForTest(undefined);
    state.setRecordConversationStatePathSafetyTestHookForTest(undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
