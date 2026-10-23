import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DevinConversationSummary } from "../src/devin-types.js";

const childMode = process.argv[2] === "interrupt";
const root = childMode ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "devin-identity-migration-"));
if (!childMode) process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "cache-integration");
const identity = await import("../src/devin-identity.js");
if (childMode) {
    const options = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const rename = fs.renameSync;
    fs.renameSync = ((source, destination) => {
        rename(source, destination);
        if (String(destination).endsWith(".original")) process.exit(73);
    }) as typeof fs.renameSync;
    identity.migrateVerifiedDevinIdentity({ ...options, dryRun: false });
    throw new Error("interruption hook did not run");
}

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (filename: string) => hash(fs.readFileSync(filename));
let sequence = 0;
let passed = 0;
function fixture() {
    const directory = path.join(root, `fixture-${++sequence}`);
    const dataRoot = path.join(directory, "data");
    const mappingRoot = path.join(dataRoot, "conversation-cache", "devin-identities");
    fs.mkdirSync(mappingRoot, { recursive: true });
    const alias = "11111111-2222-4333-8444-555555555555";
    const canonical = "fixture-falcon";
    const aliasPath = path.join(mappingRoot, `${hash(alias)}.json`);
    const canonicalPath = path.join(mappingRoot, `${hash(canonical)}.json`);
    const original = JSON.stringify({ version: 1, alias, canonicalId: alias }, null, 4) + "\n";
    fs.writeFileSync(aliasPath, original);
    fs.writeFileSync(canonicalPath, JSON.stringify({ version: 1, alias: canonical, canonicalId: canonical }));
    const recordPath = path.join(directory, "retained-record.md");
    const cachePath = path.join(directory, "retained-cache-manifest.json");
    fs.writeFileSync(recordPath, `---\nconversationId: ${alias}\n---\nFixture record`);
    fs.writeFileSync(cachePath, JSON.stringify({ key: { source: "windsurf", conversationId: alias }, generation: "old-fixture" }));
    const reviewPath = path.join(directory, "ownership-review.json");
    const review = { version: 1, alias, canonicalId: canonical, recordsReviewed: true, cachesReviewed: true,
        retainedFiles: [recordPath, cachePath].map(filename => ({ path: filename, sha256: fileHash(filename) })) };
    fs.writeFileSync(reviewPath, JSON.stringify(review));
    const summary: DevinConversationSummary = { id: canonical, canonicalId: canonical, sessionId: canonical, uuid: alias,
        aliases: [canonical, alias], title: "Fixture", workspaceUris: [], sourcePath: "fixture.db", desktopPaths: [],
        sourceKind: "devin-cli", matchedMessageIds: 0, matchedToolCallIds: 3, identityEvidence: "tool-call-id", partial: false, warnings: [] };
    const options = { dataRoot, alias, summary, uniqueCanonicalIds: [canonical], expectedAliasSha256: fileHash(aliasPath),
        expectedCanonicalSha256: fileHash(canonicalPath), ownershipReview: { path: reviewPath, sha256: fileHash(reviewPath) },
        backupDirectory: path.join(directory, "backup") };
    return { directory, dataRoot, mappingRoot, alias, canonical, aliasPath, canonicalPath, original, recordPath, cachePath, reviewPath, review, options };
}
function test(name: string, execute: () => void) {
    execute();
    passed++;
    console.log(`PASS ${name}`);
}
try {
    test("dryRun defaults to true, including no lock, backup or mapping writes", () => {
        const sample = fixture();
        const before = fs.readdirSync(sample.mappingRoot);
        const result = identity.migrateVerifiedDevinIdentity(sample.options);
        assert.equal(result.dryRun, true);
        assert.equal(fs.existsSync(sample.options.backupDirectory), false);
        assert.deepEqual(fs.readdirSync(sample.mappingRoot), before);
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), sample.original);
        assert.throws(() => identity.rememberDevinIdentity(sample.options.summary, sample.dataRoot), /explicit migration/);
    });
    for (const [name, change] of [
        ["partial", (options: any) => { options.summary.partial = true; }],
        ["ambiguous", (options: any) => { options.uniqueCanonicalIds.push("other-falcon"); }],
        ["one tool ID", (options: any) => { options.summary.matchedToolCallIds = 1; }],
        ["missing strong ID", (options: any) => { delete options.summary.identityEvidence; }],
        ["title-only", (options: any) => { options.summary.identityEvidence = "title"; }],
        ["alias outside evidence", (options: any) => { options.summary.aliases = [options.summary.canonicalId]; }],
        ["source warning", (options: any) => { options.summary.warnings = ["identity incomplete"]; }],
    ] as const) test(`refuses ${name}`, () => {
        const sample = fixture();
        change(sample.options);
        assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false }), /strong-ID/);
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), sample.original);
        assert.equal(fs.existsSync(sample.options.backupDirectory), false);
    });
    test("unique client-message-ID evidence remains accepted", () => {
        const sample = fixture();
        sample.options.summary.identityEvidence = "client-message-id";
        sample.options.summary.matchedMessageIds = 1;
        assert.equal(identity.migrateVerifiedDevinIdentity(sample.options).dryRun, true);
    });
    test("a different existing canonical remains a hard conflict", () => {
        const sample = fixture();
        fs.writeFileSync(sample.aliasPath, JSON.stringify({ version: 1, alias: sample.alias, canonicalId: "other-falcon" }));
        sample.options.expectedAliasSha256 = fileHash(sample.aliasPath);
        assert.throws(() => identity.migrateVerifiedDevinIdentity(sample.options), /conflicting canonical/);
    });
    test("old mapping, canonical, review and retained files are hash-checked", () => {
        for (const field of ["aliasPath", "canonicalPath", "reviewPath", "recordPath", "cachePath"] as const) {
            const sample = fixture();
            fs.appendFileSync(sample[field], "drift");
            assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false }), /hash mismatch/);
            assert.equal(fs.existsSync(sample.options.backupDirectory), false);
        }
    });
    test("ownership review must cover both Record and cache", () => {
        const sample = fixture();
        sample.review.cachesReviewed = false;
        fs.writeFileSync(sample.reviewPath, JSON.stringify(sample.review));
        sample.options.ownershipReview.sha256 = fileHash(sample.reviewPath);
        assert.throws(() => identity.migrateVerifiedDevinIdentity(sample.options), /ownership review/);
    });
    test("backup is independent and paths refuse traversal through symlinks", () => {
        const sample = fixture();
        assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, backupDirectory: path.join(sample.dataRoot, "backup") }), /outside dataRoot/);
        const junction = path.join(sample.directory, "junction");
        fs.symlinkSync(sample.dataRoot, junction, process.platform === "win32" ? "junction" : "dir");
        assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dataRoot: junction }), /symlink/);
    });
    test("apply preserves original bytes, old Record/cache, and canonical mapping; guarded rollback", () => {
        const sample = fixture();
        const result = identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false });
        assert.equal(identity.resolveCachedDevinIdentity(sample.alias, sample.dataRoot), sample.canonical);
        identity.rememberDevinIdentity(sample.options.summary, sample.dataRoot);
        assert.deepEqual(identity.getDevinIdentityReadTargets(sample.canonical, sample.dataRoot), [sample.canonical, sample.alias]);
        assert.deepEqual(identity.getDevinIdentityReadTargets(`${sample.alias}--subagent-fixture`, sample.dataRoot), [`${sample.canonical}--subagent-fixture`, `${sample.alias}--subagent-fixture`]);
        assert.equal(fs.readFileSync(path.join(result.backupDirectory, "alias.original.json"), "utf8"), sample.original);
        assert.equal(fileHash(sample.canonicalPath), sample.options.expectedCanonicalSha256);
        for (const retained of sample.review.retainedFiles) assert.equal(fileHash(retained.path), retained.sha256);
        const rollback = { backupDirectory: result.backupDirectory, expectedManifestSha256: result.manifestSha256 };
        assert.equal(identity.rollbackDevinIdentityMigration(rollback).dryRun, true);
        assert.equal(identity.resolveCachedDevinIdentity(sample.alias, sample.dataRoot), sample.canonical);
        identity.rollbackDevinIdentityMigration({ ...rollback, dryRun: false });
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), sample.original);
        assert.equal(identity.rollbackDevinIdentityMigration({ ...rollback, dryRun: false }).state, "already-original");
        assert.throws(() => identity.rememberDevinIdentity(sample.options.summary, sample.dataRoot), /explicit migration/);
    });
    test("rollback refuses later writers and tampered recovery manifest", () => {
        const sample = fixture();
        const result = identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false });
        const rollback = { backupDirectory: result.backupDirectory, expectedManifestSha256: result.manifestSha256, dryRun: false };
        const later = JSON.stringify({ version: 1, alias: sample.alias, canonicalId: "later-falcon" });
        fs.writeFileSync(sample.aliasPath, later);
        assert.throws(() => identity.rollbackDevinIdentityMigration(rollback), /subsequent identity changes/);
        const standalone = spawnSync(process.execPath, [path.join(result.backupDirectory, "restore.cjs"), result.manifestSha256, "--apply"], { timeout: 10000, encoding: "utf8" });
        assert.notEqual(standalone.status, 0);
        assert.match(standalone.stderr, /later mapping change refused/);
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), later);
        fs.appendFileSync(result.manifestPath, " ");
        assert.throws(() => identity.rollbackDevinIdentityMigration(rollback), /hash mismatch/);
    });
    test("failed atomic publication restores the displaced file without overwrite", () => {
        const sample = fixture();
        const link = fs.linkSync;
        fs.linkSync = ((source, destination) => {
            if (String(source).endsWith(".stage")) throw new Error("injected publication failure");
            return link(source, destination);
        }) as typeof fs.linkSync;
        try { assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false }), /injected/); }
        finally { fs.linkSync = link; }
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), sample.original);
        assert.equal(fs.readFileSync(path.join(sample.options.backupDirectory, "alias.original.json"), "utf8"), sample.original);
    });
    test("last-instant drift is retained and never overwritten", () => {
        const sample = fixture();
        const rename = fs.renameSync;
        const later = JSON.stringify({ version: 1, alias: sample.alias, canonicalId: "concurrent-falcon" });
        fs.renameSync = ((source, destination) => {
            if (String(destination).endsWith(".original")) fs.writeFileSync(source, later);
            return rename(source, destination);
        }) as typeof fs.renameSync;
        try { assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false }), /hash mismatch/); }
        finally { fs.renameSync = rename; }
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), later);
    });
    test("a concurrent destination creator survives publication failure", () => {
        const sample = fixture();
        const link = fs.linkSync;
        const later = JSON.stringify({ version: 1, alias: sample.alias, canonicalId: "concurrent-falcon" });
        fs.linkSync = ((source, destination) => {
            if (String(source).endsWith(".stage")) fs.writeFileSync(destination, later);
            return link(source, destination);
        }) as typeof fs.linkSync;
        try { assert.throws(() => identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false }), /EEXIST/); }
        finally { fs.linkSync = link; }
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), later);
    });
    test("process interruption after displacement has an independent recovery entry", () => {
        const sample = fixture();
        const optionsPath = path.join(sample.directory, "options.json");
        fs.writeFileSync(optionsPath, JSON.stringify(sample.options));
        const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "interrupt", optionsPath], { cwd: process.cwd(), timeout: 15000, encoding: "utf8" });
        assert.equal(child.status, 73, child.stderr);
        assert.equal(fs.existsSync(sample.aliasPath), false);
        assert.throws(() => identity.resolveCachedDevinIdentity(sample.alias, sample.dataRoot), /in progress/);
        const manifestPath = path.join(sample.options.backupDirectory, "manifest.json");
        const rollback = { backupDirectory: sample.options.backupDirectory, expectedManifestSha256: fileHash(manifestPath), recoverInterrupted: true };
        assert.equal(identity.rollbackDevinIdentityMigration(rollback).state, "interrupted");
        const restorePath = path.join(sample.options.backupDirectory, "restore.cjs");
        const preview = spawnSync(process.execPath, [restorePath, rollback.expectedManifestSha256, "--recover-interrupted"], { timeout: 10000, encoding: "utf8" });
        assert.equal(preview.status, 0, preview.stderr);
        assert.match(preview.stdout, /"dryRun":true/);
        assert.equal(fs.existsSync(sample.aliasPath), false);
        const recovered = spawnSync(process.execPath, [restorePath, rollback.expectedManifestSha256, "--apply", "--recover-interrupted"], { timeout: 10000, encoding: "utf8" });
        assert.equal(recovered.status, 0, recovered.stderr);
        assert.match(recovered.stdout, /"restored":true/);
        assert.equal(fs.readFileSync(sample.aliasPath, "utf8"), sample.original);
        assert.equal(identity.resolveCachedDevinIdentity(sample.alias, sample.dataRoot), sample.alias);
    });
    {
        const sample = fixture();
        const cache = await import("../src/conversation-source-cache.js");
        cache.setConversationSourceCacheDataRootForTests(sample.dataRoot);
        try {
            const oldKey = { source: "windsurf", conversationId: sample.alias };
            const newKey = { source: "windsurf", conversationId: sample.canonical };
            const oldCache = await cache.readOrBuildConversationSourceCache({ key: oldKey, fingerprint: { revision: "old" }, build: () => ({ snapshot: { owner: sample.alias }, rounds: [{ round: 1, text: "old cached text" }] }) });
            const newCache = await cache.readOrBuildConversationSourceCache({ key: newKey, fingerprint: { revision: "new" }, build: () => ({ snapshot: { owner: sample.canonical }, rounds: [{ round: 1, text: "canonical text" }, { round: 2, text: "canonical continuation" }] }) });
            const records = await import("../src/record-store.js");
            const recordDirectory = path.join(process.env.MEMORY_STORE_DATA_ROOT!, "general", "records");
            fs.mkdirSync(recordDirectory, { recursive: true });
            const oldRecord = path.join(recordDirectory, `${sample.alias}.md`);
            fs.writeFileSync(oldRecord, "Fixture legacy Record");
            const retained = [oldRecord, ...[oldKey, newKey].map(key => path.join(cache.getConversationSourceCacheEntryDirectory(key), "manifest.json"))];
            sample.review.retainedFiles.push(...retained.map(filename => ({ path: filename, sha256: fileHash(filename) })));
            fs.writeFileSync(sample.reviewPath, JSON.stringify(sample.review));
            sample.options.ownershipReview.sha256 = fileHash(sample.reviewPath);
            identity.migrateVerifiedDevinIdentity({ ...sample.options, dryRun: false });
            assert.deepEqual(identity.getDevinIdentityReadTargets(sample.canonical, sample.dataRoot), [sample.canonical, sample.alias]);
            assert.equal(cache.readConversationSourceCacheMetadata({ key: oldKey, generation: oldCache.generation, maxMetadataBytes: 4096 })?.roundCount, 1);
            assert.equal(cache.readConversationSourceCacheMetadata({ key: newKey, generation: newCache.generation, maxMetadataBytes: 4096 })?.roundCount, 2);
            assert.equal(cache.readCachedConversationSourceCacheRounds<any>({ key: oldKey, generation: oldCache.generation })?.rounds[0].text, "old cached text");
            assert.equal(records.readRecord("general", sample.alias), "Fixture legacy Record");
            for (const entry of sample.review.retainedFiles) assert.equal(fileHash(entry.path), entry.sha256);
            passed++;
            console.log("PASS real cache metadata/range and Record read APIs retain old key, generation and body after migration (fixtures)");
        } finally {
            cache.setConversationSourceCacheDataRootForTests(undefined);
        }
    }
    console.log(`PASS devin-identity-migration: ${passed} groups; all identities, caches and Records are synthetic fixtures`);
} finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
