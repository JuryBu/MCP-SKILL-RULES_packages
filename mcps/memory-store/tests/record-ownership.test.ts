import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-ownership-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { DATA_ROOT, WORKSPACES_DIR, canonicalWorkspacePath, ensureWorkspace, workspaceHash: computeWorkspaceHash } = await import("../src/store.ts");
const { copyRecordToHash, readRecordSidecar, readRecordsIndex, resolveWorkspaceHashForRecord, writeRecord, writeRecordSidecar } = await import("../src/record-store.ts");
const {
    auditRecordOwnership,
    __recordConcurrencyTest,
    buildRecordSearchBlocksForScope,
    listRecordsForScope,
    planOwnershipRepair,
    recordHashesForScope,
} = await import("../src/tools/record.ts");
const {
    __resetWindsurfConversationCacheForTest,
    __resetWindsurfEndpointCacheForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
} = await import("../src/windsurf-client.ts");

const workspace = path.join(dataRoot, "workspace-a");
ensureWorkspace(workspace);
const workspaceHash = resolveWorkspaceHashForRecord(workspace);
const longWorkspace = `\\\\?\\${workspace}`;
assert.equal(
    canonicalWorkspacePath(longWorkspace),
    canonicalWorkspacePath(workspace),
    "Windows long-path prefix should normalize to the same workspace identity",
);
assert.equal(
    computeWorkspaceHash(longWorkspace),
    computeWorkspaceHash(workspace),
    "workspaceHash must not split C:\\ and \\\\?\\C:\\ aliases",
);
assert.equal(resolveWorkspaceHashForRecord(longWorkspace), workspaceHash);

function oldRawWorkspaceHash(workspacePath: string): string {
    const normalized = workspacePath.toLowerCase().replace(/\\/g, "/").replace(/\/+$/u, "");
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

const legacyAliasHash = oldRawWorkspaceHash(longWorkspace);
fs.mkdirSync(path.join(WORKSPACES_DIR, legacyAliasHash, "records"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACES_DIR, legacyAliasHash, "_meta.json"), JSON.stringify({
    hash: legacyAliasHash,
    originalPath: longWorkspace,
    name: path.basename(workspace),
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    isArchived: false,
}, null, 2), "utf-8");

await writeRecord(workspaceHash, "workspace-only", "# workspace only", {
    title: "Workspace Only",
    totalRounds: 3,
    totalSteps: 30,
    lastUpdatedRound: 3,
    phases: 1,
});
await writeRecord("general", "general-only", "# general only", {
    title: "General Only",
    totalRounds: 2,
    totalSteps: 20,
    lastUpdatedRound: 2,
    phases: 1,
});
await writeRecord("general", "antigravity-move", "# antigravity move", {
    title: "Antigravity Move",
    totalRounds: 2,
    totalSteps: 20,
    lastUpdatedRound: 2,
    phases: 1,
});
await writeRecord("general", "codex-move", "# codex move", {
    title: "Codex Move",
    totalRounds: 2,
    totalSteps: 20,
    lastUpdatedRound: 2,
    phases: 1,
    chain: "codex",
});
await writeRecord("general", "duplicate-demo", "# duplicate old", {
    title: "Duplicate Demo",
    totalRounds: 1,
    totalSteps: 10,
    lastUpdatedRound: 1,
    phases: 1,
});
await writeRecord(workspaceHash, "duplicate-demo", "# duplicate new and complete", {
    title: "Duplicate Demo",
    totalRounds: 5,
    totalSteps: 50,
    lastUpdatedRound: 5,
    phases: 2,
});
await writeRecord(workspaceHash, "path-alias-demo", "# canonical old", {
    title: "Path Alias Demo",
    totalRounds: 3,
    totalSteps: 30,
    lastUpdatedRound: 3,
    phases: 1,
});
await writeRecord(legacyAliasHash, "path-alias-demo", "# alias newer and complete", {
    title: "Path Alias Demo",
    totalRounds: 6,
    totalSteps: 60,
    lastUpdatedRound: 6,
    phases: 2,
});
await writeRecord("general", "alias-best-demo", "# general old", {
    title: "Alias Best Demo",
    totalRounds: 2,
    totalSteps: 20,
    lastUpdatedRound: 2,
    phases: 1,
});
await writeRecord(workspaceHash, "alias-best-demo", "# canonical middle", {
    title: "Alias Best Demo",
    totalRounds: 4,
    totalSteps: 40,
    lastUpdatedRound: 4,
    phases: 1,
});
await writeRecord(legacyAliasHash, "alias-best-demo", "# alias best", {
    title: "Alias Best Demo",
    totalRounds: 7,
    totalSteps: 70,
    lastUpdatedRound: 7,
    phases: 3,
});

assert.deepEqual(recordHashesForScope(workspaceHash, "workspace", false).sort(), [legacyAliasHash, workspaceHash].sort());
assert.deepEqual(recordHashesForScope(workspaceHash, "workspace", true).sort(), [legacyAliasHash, workspaceHash, "general"].sort());
assert.ok(recordHashesForScope(workspaceHash, "global", false).includes("general"));
assert.ok(recordHashesForScope(workspaceHash, "global", false).includes(workspaceHash));

const strictWorkspaceRecords = listRecordsForScope(workspaceHash, "workspace", false);
assert.deepEqual(
    strictWorkspaceRecords.map(record => record.conversationId).sort(),
    ["alias-best-demo", "duplicate-demo", "path-alias-demo", "workspace-only"],
    "workspace scope must not include general records by default",
);

const compatWorkspaceRecords = listRecordsForScope(workspaceHash, "workspace", true);
assert.ok(
    compatWorkspaceRecords.some(record => record.conversationId === "general-only"),
    "includeGeneral=true should explicitly restore workspace + general view",
);

const strictSearchBlocks = buildRecordSearchBlocksForScope(workspaceHash, "workspace", false);
assert.deepEqual(
    strictSearchBlocks.map(block => block.id).sort(),
    ["alias-best-demo", "duplicate-demo", "path-alias-demo", "workspace-only"],
    "workspace search candidates must not include general records by default",
);

const compatSearchBlocks = buildRecordSearchBlocksForScope(workspaceHash, "workspace", true);
assert.ok(
    compatSearchBlocks.some(block => block.id === "general-only"),
    "includeGeneral=true should explicitly include general search candidates",
);

const audit = await auditRecordOwnership(workspaceHash, "global", "codex");
const duplicate = audit.find(item => item.conversationId === "duplicate-demo" && item.currentHash === "general");
assert.equal(duplicate?.status, "duplicate");
assert.equal(duplicate?.sourceType, "duplicate");
assert.equal(duplicate?.suggestedAction, "archiveDuplicate");

const unknown = audit.find(item => item.conversationId === "general-only" && item.currentHash === "general");
assert.equal(unknown?.status, "unknown");
assert.equal(unknown?.suggestedAction, "keep");

const fakeSourceAudit = await auditRecordOwnership(workspaceHash, "global", "auto", async (conversationId: string) => {
    if (conversationId === "antigravity-move") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "antigravity_workspace_uri",
        };
    }
    if (conversationId === "codex-move") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    if (conversationId === "path-alias-demo") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    if (conversationId === "alias-best-demo") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    return { sourceType: "unknown" };
});
const antigravityMove = fakeSourceAudit.find(item => item.conversationId === "antigravity-move");
assert.equal(antigravityMove?.status, "migratable");
assert.equal(antigravityMove?.sourceType, "antigravity_workspace_uri");
assert.equal(antigravityMove?.suggestedAction, "move");

const codexMove = fakeSourceAudit.find(item => item.conversationId === "codex-move");
assert.equal(codexMove?.status, "migratable");
assert.equal(codexMove?.sourceType, "codex_cwd");
assert.equal(codexMove?.suggestedAction, "move");

const aliasMove = fakeSourceAudit.find(item => item.conversationId === "path-alias-demo" && item.currentHash === legacyAliasHash);
assert.equal(aliasMove?.status, "migratable");
assert.equal(aliasMove?.suggestedAction, "move");
assert.match(aliasMove?.reason || "", /路径别名/);
const generalAliasBest = fakeSourceAudit.find(item => item.conversationId === "alias-best-demo" && item.currentHash === "general");
assert.equal(generalAliasBest?.status, "duplicate");
assert.equal(generalAliasBest?.suggestedAction, "archiveDuplicate");
const aliasBestMove = fakeSourceAudit.find(item => item.conversationId === "alias-best-demo" && item.currentHash === legacyAliasHash);
assert.equal(aliasBestMove?.status, "migratable");
assert.equal(aliasBestMove?.suggestedAction, "move");

const copyTargetWorkspace = path.join(dataRoot, "workspace-b");
ensureWorkspace(copyTargetWorkspace);
const copyTargetHash = resolveWorkspaceHashForRecord(copyTargetWorkspace);

const repairPlan = await planOwnershipRepair(workspaceHash, "global", "auto", async (conversationId: string) => {
    if (conversationId === "codex-move") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    if (conversationId === "path-alias-demo") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    if (conversationId === "alias-best-demo") {
        return {
            expectedHash: workspaceHash,
            expectedWorkspace: workspace,
            sourceType: "codex_cwd",
        };
    }
    return { sourceType: "unknown" };
});
assert.deepEqual(repairPlan.moves.map(item => `${item.conversationId}:${item.currentHash}`).sort(), [
    `alias-best-demo:${legacyAliasHash}`,
    "codex-move:general",
    `path-alias-demo:${legacyAliasHash}`,
]);
assert.equal(
    listRecordsForScope(copyTargetHash, "workspace", false).some(record => record.conversationId === "codex-move"),
    false,
    "dry-run repair planning must not write target workspace records",
);

const copied = await copyRecordToHash("general", copyTargetHash, "codex-move", {}, { backup: true });
assert.equal(copied, true);
assert.equal(readRecordsIndex(copyTargetHash).records["codex-move"]?.chain, "codex");
const backupRoot = path.join(DATA_ROOT, "record-ownership-backups");
assert.ok(fs.existsSync(backupRoot), "repair copy should create a backup directory when backup=true");

await copyRecordToHash(legacyAliasHash, workspaceHash, "path-alias-demo", { lastUpdatedAt: new Date().toISOString() }, { backup: true });
await writeRecordSidecar(legacyAliasHash, "path-alias-demo", "ownership.json", {
    status: "superseded",
    supersededBy: workspaceHash,
});
const superseded = readRecordSidecar<{ status: string; supersededBy: string }>(legacyAliasHash, "path-alias-demo", "ownership.json");
assert.equal(superseded?.status, "superseded");
assert.equal(superseded?.supersededBy, workspaceHash);
assert.equal(
    listRecordsForScope(workspaceHash, "workspace", false).filter(record => record.conversationId === "path-alias-demo").length,
    1,
    "superseded alias copy should not appear as a second default workspace record",
);
assert.equal(
    buildRecordSearchBlocksForScope(workspaceHash, "workspace", false).filter(block => block.id === "path-alias-demo").length,
    1,
    "superseded alias copy should not appear as a second default search candidate",
);

const cycleAHash = workspaceHash;
const cycleBHash = legacyAliasHash;
await writeRecord(cycleAHash, "superseded-cycle-demo", "# cycle canonical", {
    title: "Superseded Cycle Demo",
    totalRounds: 8,
    totalSteps: 80,
    lastUpdatedRound: 8,
    phases: 2,
});
await writeRecord(cycleBHash, "superseded-cycle-demo", "# cycle alias", {
    title: "Superseded Cycle Demo",
    totalRounds: 7,
    totalSteps: 70,
    lastUpdatedRound: 7,
    phases: 2,
});
await writeRecordSidecar(cycleAHash, "superseded-cycle-demo", "ownership.json", {
    status: "superseded",
    supersededBy: cycleBHash,
});
await writeRecordSidecar(cycleBHash, "superseded-cycle-demo", "ownership.json", {
    status: "superseded",
    supersededBy: cycleAHash,
});
assert.equal(
    listRecordsForScope(workspaceHash, "workspace", false).filter(record => record.conversationId === "superseded-cycle-demo").length,
    1,
    "superseded sidecar cycles should not hide every copy from workspace list",
);
assert.equal(
    buildRecordSearchBlocksForScope(workspaceHash, "workspace", false).filter(block => block.id === "superseded-cycle-demo").length,
    1,
    "superseded sidecar cycles should not hide every copy from workspace search",
);

const ownershipProbeRequestClasses: Array<string | undefined> = [];
const ownershipProbeEndpoint = { pid: 710, port: 14710, csrfToken: "ownership-probe" };
__resetWindsurfConversationCacheForTest();
__resetWindsurfEndpointCacheForTest();
__setWindsurfEndpointResolverForTest(async () => [ownershipProbeEndpoint]);
__setWindsurfTransportFactoryForTest(() => async (method, _payload = {}, options = {}) => {
    ownershipProbeRequestClasses.push(options.requestClass);
    if (method === "GetAllCascadeTrajectories") {
        return {
            trajectorySummaries: {
                "wsf-ownership-probe": {
                    summary: "WSF ownership probe",
                    stepCount: 0,
                },
            },
        };
    }
    if (method === "GetCascadeTrajectorySteps") return { steps: [] };
    if (method === "Heartbeat") return { ok: true };
    throw new Error(`unexpected WSF ownership probe method ${method}`);
});

try {
    const schedulerPayload = await __recordConcurrencyTest.buildUpdateResumePayload({
        workspaceHash: "general",
        conversationId: "wsf-ownership-probe",
        dataChain: "windsurf",
        modelChain: "grok",
    });
    assert.equal(schedulerPayload?.workspaceHash, "general");
    assert.ok(ownershipProbeRequestClasses.length > 0, "scheduler ownership probe should reach the WSF transport");
    assert.ok(
        ownershipProbeRequestClasses.every(requestClass => requestClass === "background"),
        `scheduler ownership probe must use background requestClass: ${JSON.stringify(ownershipProbeRequestClasses)}`,
    );

    await writeRecord("general", "wsf-ownership-probe", "# WSF ownership probe", {
        title: "WSF Ownership Probe",
        totalRounds: 1,
        totalSteps: 1,
        lastUpdatedRound: 1,
        phases: 1,
    });
    ownershipProbeRequestClasses.length = 0;
    __resetWindsurfConversationCacheForTest();
    __resetWindsurfEndpointCacheForTest();

    await auditRecordOwnership("general", "general", "windsurf");
    assert.ok(ownershipProbeRequestClasses.length > 0, "public ownership audit should reach the WSF transport");
    assert.ok(
        ownershipProbeRequestClasses.every(requestClass => requestClass === "foreground"),
        `public ownership audit must retain default foreground requestClass: ${JSON.stringify(ownershipProbeRequestClasses)}`,
    );
} finally {
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfConversationCacheForTest();
    __resetWindsurfEndpointCacheForTest();
}
