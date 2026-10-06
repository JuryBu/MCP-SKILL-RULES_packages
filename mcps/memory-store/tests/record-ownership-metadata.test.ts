import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";

const temporaryBase = fs.realpathSync(os.tmpdir());
const fixtureRoot = fs.mkdtempSync(path.join(temporaryBase, "memory-store-ownership-metadata-"));
const fixtureHome = path.join(fixtureRoot, "home");
const workspace = path.join(fixtureRoot, "workspace");
const parentWorkspace = path.join(fixtureRoot, "parent-workspace");
const desktopRoot = path.join(fixtureRoot, "desktop");
process.env.USERPROFILE = fixtureHome;
process.env.HOME = fixtureHome;
process.env.MEMORY_STORE_DATA_ROOT = path.join(fixtureRoot, "data");
process.env.APPDATA = path.join(fixtureHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(fixtureHome, "AppData", "Local");
process.env.MEMORY_STORE_CLAUDE_HOME = path.join(fixtureHome, ".claude");
process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS = desktopRoot;
assert.equal(os.homedir(), fixtureHome);

const identifiers = {
    known: crypto.randomUUID(),
    child: crypto.randomUUID(),
    orphanChild: crypto.randomUUID(),
    parent: crypto.randomUUID(),
    archived: crypto.randomUUID(),
    rollout: crypto.randomUUID(),
    mismatch: crypto.randomUUID(),
    ambiguous: crypto.randomUUID(),
    missing: crypto.randomUUID(),
    claude: crypto.randomUUID(),
    claudeDesktop: crypto.randomUUID(),
    claudeAmbiguous: crypto.randomUUID(),
};
const sessionsRoot = path.join(fixtureHome, ".codex", "sessions");
const archivedRoot = path.join(fixtureHome, ".codex", "archived_sessions");
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.mkdirSync(archivedRoot, { recursive: true });
fs.mkdirSync(desktopRoot, { recursive: true });
const stateDatabase = path.join(fixtureHome, ".codex", "state_5.sqlite");
const setup = `
import json, sqlite3, sys
identifiers = json.loads(sys.argv[2])
connection = sqlite3.connect(sys.argv[1])
connection.execute("create table threads(id text primary key, cwd text, updated_at_ms integer, archived integer)")
connection.execute("create table thread_spawn_edges(child_thread_id text, parent_thread_id text)")
for key, cwd in [("known", sys.argv[3]), ("child", ""), ("parent", sys.argv[4]), ("archived", sys.argv[3]), ("claudeAmbiguous", sys.argv[3])]:
    connection.execute("insert into threads values(?,?,?,?)", (identifiers[key], cwd, 1, int(key == "archived")))
connection.execute("insert into thread_spawn_edges values(?,?)", (identifiers["child"], identifiers["parent"]))
connection.execute("insert into thread_spawn_edges values(?,?)", (identifiers["orphanChild"], identifiers["parent"]))
connection.commit()
connection.close()
`;
execFileSync("python", ["-c", setup, stateDatabase, JSON.stringify(identifiers), workspace, parentWorkspace], { windowsHide: true, timeout: 10_000 });

function writeRollout(root: string, identifier: string, payloadId = identifier, suffix = "") {
    const filePath = path.join(root, `rollout-2026-01-01T01-01-01-${identifier}${suffix}.jsonl`);
    fs.writeFileSync(filePath, JSON.stringify({ type: "session_meta", payload: { id: payloadId, cwd: workspace } }) + "\n", "utf8");
    return filePath;
}

const rolloutPath = writeRollout(sessionsRoot, identifiers.rollout);
writeRollout(sessionsRoot, identifiers.orphanChild);
fs.appendFileSync(rolloutPath, Buffer.alloc(20 * 1024 * 1024, 32));
writeRollout(sessionsRoot, identifiers.mismatch, crypto.randomUUID());
writeRollout(sessionsRoot, identifiers.ambiguous);
writeRollout(archivedRoot, identifiers.ambiguous);
for (let index = 0; index < 256; index += 1) writeRollout(sessionsRoot, crypto.randomUUID());

const claudeProjectsRoot = path.join(fixtureHome, ".claude", "projects");
function writeClaude(project: string, identifier: string, content: object) {
    const directory = path.join(claudeProjectsRoot, project);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${identifier}.jsonl`);
    fs.writeFileSync(filePath, JSON.stringify(content) + "\n", "utf8");
    return filePath;
}

const claudePath = writeClaude("first", identifiers.claude, { cwd: workspace, type: "user" });
writeClaude("first", identifiers.claudeDesktop, { type: "user" });
writeClaude("first", identifiers.claudeAmbiguous, { cwd: workspace, type: "user" });
writeClaude("second", identifiers.claudeAmbiguous, { cwd: parentWorkspace, type: "user" });
writeClaude("first", identifiers.ambiguous, { cwd: workspace, type: "user" });
const desktopPath = path.join(desktopRoot, "local_fixture.json");
fs.writeFileSync(desktopPath, JSON.stringify({ cliSessionId: identifiers.claudeDesktop, cwd: parentWorkspace, updatedAt: "2026-01-01T00:00:00Z" }), "utf8");

function hashFile(filePath: string) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const before = [stateDatabase, rolloutPath, claudePath, desktopPath].map(hashFile);
let passed = false;
try {
    const { getCodexOwnershipMetadataAsync } = await import("../src/codex-client.ts");
    const { getClaudeCodeOwnershipMetadataAsync } = await import("../src/claude-code-client.ts");
    const codex = await getCodexOwnershipMetadataAsync([
        identifiers.known,
        identifiers.known.toUpperCase(),
        identifiers.child,
        identifiers.orphanChild,
        identifiers.archived,
        identifiers.rollout,
        identifiers.mismatch,
        identifiers.ambiguous,
        identifiers.missing,
    ]);
    assert.equal(codex.entries.size, 8);
    assert.equal(codex.entries.get(identifiers.known)?.cwd, workspace);
    assert.equal(codex.entries.get(identifiers.child)?.parentCwd, parentWorkspace);
    assert.equal(codex.entries.get(identifiers.child)?.cwd, "");
    assert.equal(codex.entries.get(identifiers.orphanChild)?.cwd, workspace);
    assert.equal(codex.entries.get(identifiers.orphanChild)?.parentCwd, parentWorkspace);
    assert.equal(codex.entries.get(identifiers.archived)?.cwd, workspace);
    assert.equal(codex.entries.get(identifiers.rollout)?.cwd, workspace);
    assert.equal(codex.entries.get(identifiers.mismatch)?.cwd, undefined);
    assert.equal(codex.entries.get(identifiers.mismatch)?.issue, "rollout_metadata_unresolved");
    assert.equal(codex.entries.get(identifiers.ambiguous)?.issue, "rollout_id_ambiguous");
    assert.equal(codex.entries.get(identifiers.missing)?.issue, "exact_source_unresolved");
    assert.equal(codex.diagnostics.sqliteProcesses, 1);
    assert.equal(codex.diagnostics.sqliteQueries, 2);
    assert.equal(codex.diagnostics.rolloutDirectoriesRead, 2);
    assert.equal(codex.diagnostics.rolloutFilesRead, 3);
    assert.deepEqual(codex.diagnostics.failures, []);
    const prefix = await getCodexOwnershipMetadataAsync([identifiers.known.slice(0, 8)]);
    assert.equal(prefix.entries.get(identifiers.known.slice(0, 8))?.cwd, undefined);
    assert.equal(prefix.diagnostics.rolloutDirectoriesRead, 0);

    const claude = await getClaudeCodeOwnershipMetadataAsync([
        identifiers.claude,
        identifiers.claudeDesktop,
        identifiers.claudeAmbiguous,
        identifiers.missing,
    ]);
    assert.equal(claude.entries.get(identifiers.claude)?.cwd, workspace);
    assert.equal(claude.entries.get(identifiers.claudeDesktop)?.cwd, parentWorkspace);
    assert.equal(claude.entries.get(identifiers.claudeAmbiguous)?.cwd, undefined);
    assert.equal(claude.entries.get(identifiers.claudeAmbiguous)?.issue, "transcript_id_ambiguous");
    assert.equal(claude.entries.get(identifiers.missing)?.cwd, undefined);
    assert.equal(claude.diagnostics.transcriptFilesRead, 2);
    assert.equal(claude.diagnostics.desktopFilesRead, 1);
    assert.deepEqual(claude.diagnostics.failures, []);
    const missingClaude = await getClaudeCodeOwnershipMetadataAsync([identifiers.missing]);
    assert.equal(missingClaude.diagnostics.transcriptFilesRead, 0);
    assert.equal(missingClaude.diagnostics.desktopFilesRead, 0);
    const store = await import("../src/store.ts");
    const recordSource = fs.readFileSync(new URL("../src/tools/record.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("record.ts", recordSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = ["detectOwnershipSource", "betterRecordLocation", "auditRecordOwnership", "createOwnershipAuditSourceResolver", "auditRecordLocations", "planOwnershipRepair"];
    const selected = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)).map(statement => statement.getText(parsed)).join("\n");
    const locations = [identifiers.orphanChild, identifiers.claudeAmbiguous, identifiers.ambiguous].map(conversationId => ({ hash: "general", conversationId, title: "Synthetic", totalRounds: 1, lastUpdatedRound: 1, lastUpdatedAt: "2026-01-01", sizeBytes: 10 }));
    const context = {
        exports: {} as { planOwnershipRepair?: (...argumentsValue: unknown[]) => Promise<{ items: Array<{ conversationId: string; status: string; expectedWorkspace?: string }>; moves: Array<{ conversationId: string }> }> },
        Date, Map, Set, Promise, setImmediate, getCodexOwnershipMetadataAsync, getClaudeCodeOwnershipMetadataAsync,
        createWorkspaceHashResolverAsync: store.createWorkspaceHashResolverAsync,
        collectRecordLocations: async () => locations,
        workspaceHash: store.workspaceHash,
        fetchFirstPageSteps: async () => null,
        detectWorkspaceFromSteps: () => null,
    };
    vm.runInNewContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    const plan = await context.exports.planOwnershipRepair!("general", "general", "auto");
    assert.equal(plan.items.find(item => item.conversationId === identifiers.orphanChild)?.expectedWorkspace, workspace);
    for (const identifier of [identifiers.claudeAmbiguous, identifiers.ambiguous]) {
        assert.equal(plan.items.find(item => item.conversationId === identifier)?.status, "conflict");
        assert.ok(!plan.moves.some(item => item.conversationId === identifier));
    }
    assert.deepEqual([stateDatabase, rolloutPath, claudePath, desktopPath].map(hashFile), before);
    process.stdout.write(JSON.stringify({ result: "OWNERSHIP_METADATA_PASS", codex: codex.diagnostics, claude: claude.diagnostics, sourceBytesUnchanged: true }) + "\n");
    passed = true;
} finally {
    const resolvedFixture = fs.realpathSync(fixtureRoot);
    assert.equal(path.dirname(resolvedFixture), temporaryBase);
    assert.ok(path.basename(resolvedFixture).startsWith("memory-store-ownership-metadata-"));
    if (passed) fs.rmSync(resolvedFixture, { recursive: true });
    else process.stderr.write(`Fixture retained: ${resolvedFixture}\n`);
}
