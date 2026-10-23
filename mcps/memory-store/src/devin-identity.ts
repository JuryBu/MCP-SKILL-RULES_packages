import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";
import type { DevinConversationSummary } from "./devin-types.js";

function identityPath(alias: string, dataRoot = DATA_ROOT): string {
    const digest = createHash("sha256").update(alias.trim().toLowerCase()).digest("hex");
    return path.join(dataRoot, "conversation-cache", "devin-identities", `${digest}.json`);
}

export function resolveCachedDevinIdentity(id: string, dataRoot = DATA_ROOT): string {
    if (fs.existsSync(lockPath(dataRoot))) throw new Error("Devin identity migration/write is in progress; retry after its recovery or completion");
    const child = /^(.*)--subagent-([a-zA-Z0-9_-]+)$/u.exec(id);
    if (child) return `${resolveCachedDevinIdentity(child[1], dataRoot)}--subagent-${child[2]}`;
    const filename = identityPath(id, dataRoot);
    if (!fs.existsSync(filename)) return id;
    const entry = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (entry.version !== 1 || entry.alias !== id.trim().toLowerCase() || typeof entry.canonicalId !== "string") {
        throw new Error("Devin cached identity is invalid; rebuild the verified identity mapping before reading this alias");
    }
    return entry.canonicalId;
}

export function rememberDevinIdentity(summary: DevinConversationSummary, dataRoot = DATA_ROOT): void {
    const release = acquireIdentityLock(dataRoot);
    try {
        const aliases = [...new Set([summary.canonicalId, ...summary.aliases].map(alias => alias.trim().toLowerCase()))];
        for (const alias of aliases) {
            const filename = identityPath(alias, dataRoot);
            const existing = fs.existsSync(filename) ? readIdentity(filename, alias).canonicalId : alias;
            if (fs.existsSync(filename) && existing !== summary.canonicalId) {
                throw new Error(`Devin identity changed for ${alias}; existing cache/Record ownership requires explicit migration`);
            }
        }
        for (const alias of aliases) {
            const filename = identityPath(alias, dataRoot);
            if (fs.existsSync(filename)) continue;
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            writeJsonAtomic(filename, { version: 1, alias, canonicalId: summary.canonicalId });
        }
    } finally {
        release();
    }
}

export interface DevinIdentityMigrationOptions {
    dataRoot?: string;
    alias: string;
    summary: DevinConversationSummary;
    uniqueCanonicalIds: string[];
    expectedAliasSha256: string;
    expectedCanonicalSha256: string;
    ownershipReview: { path: string; sha256: string };
    backupDirectory: string;
    dryRun?: boolean;
}

interface IdentityMigrationManifest {
    version: 1;
    migrationId: string;
    dataRoot: string;
    alias: string;
    canonicalId: string;
    aliasPath: string;
    canonicalPath: string;
    displacedPath: string;
    stagePath: string;
    aliasSha256: string;
    canonicalSha256: string;
    newSha256: string;
    ownershipReview: { path: string; sha256: string };
    retainedFiles: Array<{ path: string; sha256: string }>;
    legacyReadIds: string[];
}

const standaloneRecovery = String.raw`const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const checkPath = filename => {
    if (!path.isAbsolute(filename)) throw Error("absolute path required");
    for (let current = path.resolve(filename); ; current = path.dirname(current)) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error("symlink refused");
        if (path.dirname(current) === current) break;
    }
};
const read = filename => { checkPath(filename); if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > 1048576) throw Error("invalid recovery file"); return fs.readFileSync(filename); };
const verify = (filename, expected) => { if (!/^[a-f0-9]{64}$/.test(expected) || digest(read(filename)) !== expected) throw Error("recovery hash mismatch: " + filename); };
const directory = __dirname;
verify(path.join(directory, "manifest.json"), process.argv[2]);
const manifest = JSON.parse(read(path.join(directory, "manifest.json")));
const mapping = alias => path.join(manifest.dataRoot, "conversation-cache", "devin-identities", digest(alias.trim().toLowerCase()) + ".json");
if (manifest.version !== 1 || manifest.aliasPath !== mapping(manifest.alias) || manifest.canonicalPath !== mapping(manifest.canonicalId)) throw Error("invalid recovery targets");
const original = path.join(directory, "alias.original.json");
verify(original, manifest.aliasSha256);
verify(path.join(directory, "canonical.original.json"), manifest.canonicalSha256);
verify(path.join(directory, "alias.new.json"), manifest.newSha256);
checkPath(manifest.aliasPath);
const current = fs.existsSync(manifest.aliasPath) ? digest(read(manifest.aliasPath)) : null;
const interrupted = process.argv.includes("--recover-interrupted");
if (current !== manifest.aliasSha256 && current !== manifest.newSha256 && !(current === null && interrupted)) throw Error("later mapping change refused");
if (!process.argv.includes("--apply")) { console.log(JSON.stringify({ dryRun: true, current, target: manifest.aliasSha256 })); process.exit(0); }
const lock = path.join(path.dirname(manifest.aliasPath), ".identity-write.lock");
const recoveryLock = lock + ".recovery";
checkPath(lock); checkPath(recoveryLock);
const create = (filename, bytes) => { checkPath(filename); const descriptor = fs.openSync(filename, "wx", 384); try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } };
create(recoveryLock, manifest.migrationId);
const token = JSON.stringify({ version: 1, migrationId: randomUUID(), pid: process.pid });
let acquired = false;
try {
    if (fs.existsSync(lock)) {
        const stale = JSON.parse(read(lock));
        if (!interrupted || stale.migrationId !== manifest.migrationId || !Number.isInteger(stale.pid) || stale.pid <= 0) throw Error("unowned writer lock refused");
        try { process.kill(stale.pid, 0); throw Error("writer still alive"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        fs.unlinkSync(lock);
    }
    create(lock, token); acquired = true;
    const latest = fs.existsSync(manifest.aliasPath) ? digest(read(manifest.aliasPath)) : null;
    if (latest !== current) throw Error("mapping drift during recovery");
    if (latest !== manifest.aliasSha256) {
        verify(original, manifest.aliasSha256);
        const staged = manifest.aliasPath + "." + randomUUID() + ".restore-stage";
        const displaced = staged + ".displaced";
        create(staged, read(original));
        if (latest !== null) {
            fs.renameSync(manifest.aliasPath, displaced);
            try { verify(displaced, manifest.newSha256); fs.linkSync(staged, manifest.aliasPath); }
            catch (error) { if (!fs.existsSync(manifest.aliasPath)) fs.linkSync(displaced, manifest.aliasPath); throw error; }
        } else fs.linkSync(staged, manifest.aliasPath);
        verify(manifest.aliasPath, manifest.aliasSha256);
        fs.unlinkSync(staged);
    }
    console.log(JSON.stringify({ restored: true, aliasPath: manifest.aliasPath }));
} finally {
    if (acquired && fs.existsSync(lock) && digest(read(lock)) === digest(token)) fs.unlinkSync(lock);
    if (fs.existsSync(recoveryLock) && digest(read(recoveryLock)) === digest(manifest.migrationId)) fs.unlinkSync(recoveryLock);
}
`;

function sha256(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function checkedPath(filename: string): string {
    if (!path.isAbsolute(filename)) throw new Error("Identity migration paths must be absolute");
    const absolute = path.resolve(filename);
    let current = absolute;
    while (true) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Identity migration refuses symlink/reparse path: ${current}`);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return absolute;
}

function fileHash(filename: string): string {
    checkedPath(filename);
    if (!fs.statSync(filename).isFile()) throw new Error(`Expected regular file: ${filename}`);
    const descriptor = fs.openSync(filename, "r");
    try {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(65536);
        let count: number;
        while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
        return hash.digest("hex");
    } finally {
        fs.closeSync(descriptor);
    }
}

function assertHash(filename: string, expected: string): void {
    if (!/^[a-f0-9]{64}$/u.test(expected) || fileHash(filename) !== expected) throw new Error(`Identity migration content drift/hash mismatch: ${filename}`);
}

function readIdentity(filename: string, alias: string): { version: 1; alias: string; canonicalId: string; legacyReadIds?: string[] } {
    checkedPath(filename);
    if (fs.statSync(filename).size > 65536) throw new Error("Devin identity mapping exceeds size limit");
    const entry = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (entry.version !== 1 || entry.alias !== alias || typeof entry.canonicalId !== "string") throw new Error("Devin identity mapping is invalid");
    return entry;
}

function durableCreate(filename: string, bytes: Buffer | string): void {
    checkedPath(filename);
    const descriptor = fs.openSync(filename, "wx", 0o600);
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function lockPath(dataRoot: string): string {
    return path.join(dataRoot, "conversation-cache", "devin-identities", ".identity-write.lock");
}

function acquireIdentityLock(dataRoot: string, migrationId = randomUUID()): () => void {
    const filename = checkedPath(lockPath(dataRoot));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const bytes = JSON.stringify({ version: 1, migrationId, pid: process.pid });
    durableCreate(filename, bytes);
    return () => {
        if (fs.existsSync(filename) && fileHash(filename) === sha256(bytes)) fs.unlinkSync(filename);
    };
}

function validateReview(manifest: Pick<IdentityMigrationManifest, "ownershipReview" | "retainedFiles">): void {
    assertHash(manifest.ownershipReview.path, manifest.ownershipReview.sha256);
    for (const retained of manifest.retainedFiles) assertHash(retained.path, retained.sha256);
}

function publishWithoutOverwrite(filename: string, displaced: string, staged: string, expected: string): void {
    assertHash(filename, expected);
    if (fs.existsSync(displaced)) throw new Error("Identity migration displaced path already exists");
    fs.renameSync(filename, displaced);
    try {
        assertHash(displaced, expected);
        fs.linkSync(staged, filename);
    } catch (error) {
        if (!fs.existsSync(filename)) fs.linkSync(displaced, filename);
        throw error;
    }
}

export function migrateVerifiedDevinIdentity(options: DevinIdentityMigrationOptions) {
    const dataRoot = checkedPath(options.dataRoot ?? DATA_ROOT);
    const alias = options.alias.trim().toLowerCase();
    const summary = options.summary;
    const canonicalId = summary.canonicalId;
    const candidates = options.uniqueCanonicalIds;
    if (!alias || canonicalId !== canonicalId.trim().toLowerCase() || alias === canonicalId
        || summary.sourceKind !== "devin-cli" || summary.sessionId !== canonicalId || summary.isChildThread
        || summary.partial !== false || summary.warnings.length > 0
        || !summary.aliases.includes(alias) || candidates.length !== 1 || candidates[0] !== canonicalId
        || !(summary.identityEvidence === "client-message-id" && Number.isInteger(summary.matchedMessageIds) && summary.matchedMessageIds >= 1
            || summary.identityEvidence === "tool-call-id" && Number.isInteger(summary.matchedToolCallIds) && summary.matchedToolCallIds! >= 2)) {
        throw new Error("Explicit Devin migration requires complete, unique strong-ID evidence for this alias/canonical pair");
    }
    const aliasPath = checkedPath(identityPath(alias, dataRoot));
    const canonicalPath = checkedPath(identityPath(canonicalId, dataRoot));
    assertHash(aliasPath, options.expectedAliasSha256);
    assertHash(canonicalPath, options.expectedCanonicalSha256);
    if (readIdentity(aliasPath, alias).canonicalId !== alias || readIdentity(canonicalPath, canonicalId).canonicalId !== canonicalId) {
        throw new Error("Explicit Devin migration only upgrades an old self-alias to an existing canonical self-mapping; conflicting canonical ownership is refused");
    }
    const ownershipReview = { path: checkedPath(options.ownershipReview.path), sha256: options.ownershipReview.sha256 };
    assertHash(ownershipReview.path, ownershipReview.sha256);
    if (fs.statSync(ownershipReview.path).size > 1048576) throw new Error("Ownership review exceeds size limit");
    const review = JSON.parse(fs.readFileSync(ownershipReview.path, "utf8"));
    if (review.version !== 1 || review.alias !== alias || review.canonicalId !== canonicalId
        || review.recordsReviewed !== true || review.cachesReviewed !== true || !Array.isArray(review.retainedFiles)) {
        throw new Error("A pair-bound, completed Record/cache ownership review is required");
    }
    const retainedFiles = review.retainedFiles.map((entry: { path: string; sha256: string }) => ({ path: checkedPath(entry.path), sha256: entry.sha256 }));
    validateReview({ ownershipReview, retainedFiles });
    const backupDirectory = checkedPath(options.backupDirectory);
    const relative = path.relative(dataRoot, backupDirectory);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Independent backup directory must be outside dataRoot");
    if (fs.existsSync(backupDirectory) || !fs.statSync(path.dirname(backupDirectory)).isDirectory()) throw new Error("Backup directory must be new, with an existing parent");
    const migrationId = randomUUID();
    const newBytes = JSON.stringify({ version: 1, alias, canonicalId, migrationId, legacyReadIds: [alias] }, null, 2);
    const manifest: IdentityMigrationManifest = {
        version: 1, migrationId, dataRoot, alias, canonicalId, aliasPath, canonicalPath,
        displacedPath: `${aliasPath}.${migrationId}.original`, stagePath: `${aliasPath}.${migrationId}.stage`,
        aliasSha256: options.expectedAliasSha256, canonicalSha256: options.expectedCanonicalSha256,
        newSha256: sha256(newBytes), ownershipReview, retainedFiles, legacyReadIds: [alias],
    };
    const manifestBytes = JSON.stringify(manifest, null, 2);
    const result = { dryRun: options.dryRun !== false, manifest, manifestSha256: sha256(manifestBytes), backupDirectory,
        manifestPath: path.join(backupDirectory, "manifest.json"), readTargets: [canonicalId, alias] };
    if (options.dryRun !== false) return result;
    const release = acquireIdentityLock(dataRoot, migrationId);
    try {
        assertHash(aliasPath, manifest.aliasSha256);
        assertHash(canonicalPath, manifest.canonicalSha256);
        validateReview(manifest);
        fs.mkdirSync(backupDirectory);
        durableCreate(path.join(backupDirectory, "alias.original.json"), fs.readFileSync(aliasPath));
        durableCreate(path.join(backupDirectory, "canonical.original.json"), fs.readFileSync(canonicalPath));
        durableCreate(path.join(backupDirectory, "alias.new.json"), newBytes);
        durableCreate(path.join(backupDirectory, "restore.cjs"), standaloneRecovery);
        durableCreate(result.manifestPath, manifestBytes);
        assertHash(path.join(backupDirectory, "alias.original.json"), manifest.aliasSha256);
        assertHash(path.join(backupDirectory, "canonical.original.json"), manifest.canonicalSha256);
        durableCreate(manifest.stagePath, newBytes);
        assertHash(canonicalPath, manifest.canonicalSha256);
        validateReview(manifest);
        publishWithoutOverwrite(aliasPath, manifest.displacedPath, manifest.stagePath, manifest.aliasSha256);
        assertHash(aliasPath, manifest.newSha256);
        fs.unlinkSync(manifest.stagePath);
        return result;
    } finally {
        release();
    }
}

export function rollbackDevinIdentityMigration(options: {
    backupDirectory: string; expectedManifestSha256: string; dryRun?: boolean; recoverInterrupted?: boolean;
}) {
    const backupDirectory = checkedPath(options.backupDirectory);
    const manifestPath = path.join(backupDirectory, "manifest.json");
    assertHash(manifestPath, options.expectedManifestSha256);
    const manifest: IdentityMigrationManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== 1 || manifest.aliasPath !== identityPath(manifest.alias, manifest.dataRoot)
        || manifest.canonicalPath !== identityPath(manifest.canonicalId, manifest.dataRoot)
        || manifest.stagePath !== `${manifest.aliasPath}.${manifest.migrationId}.stage`
        || manifest.displacedPath !== `${manifest.aliasPath}.${manifest.migrationId}.original`) throw new Error("Invalid migration recovery manifest paths");
    const original = path.join(backupDirectory, "alias.original.json");
    assertHash(original, manifest.aliasSha256);
    assertHash(path.join(backupDirectory, "canonical.original.json"), manifest.canonicalSha256);
    assertHash(path.join(backupDirectory, "alias.new.json"), manifest.newSha256);
    const current = fs.existsSync(manifest.aliasPath) ? fileHash(manifest.aliasPath) : null;
    if (current !== manifest.newSha256 && current !== manifest.aliasSha256 && !(current === null && options.recoverInterrupted === true)) {
        throw new Error("Rollback refuses subsequent identity changes; current mapping no longer matches this migration");
    }
    const result = { dryRun: options.dryRun !== false, state: current === manifest.aliasSha256 ? "already-original" : current === null ? "interrupted" : "applied", manifest };
    if (options.dryRun !== false) return result;
    const recoveryLock = checkedPath(`${lockPath(manifest.dataRoot)}.recovery`);
    durableCreate(recoveryLock, manifest.migrationId);
    let release: (() => void) | undefined;
    try {
        const stalePath = lockPath(manifest.dataRoot);
        if (fs.existsSync(stalePath)) {
            const stale = JSON.parse(fs.readFileSync(stalePath, "utf8"));
            if (!options.recoverInterrupted || stale.migrationId !== manifest.migrationId || !Number.isInteger(stale.pid) || stale.pid <= 0) throw new Error("Identity write lock requires explicit interrupted-migration recovery");
            try { process.kill(stale.pid, 0); throw new Error("Migration writer is still alive; recovery refused"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            fs.unlinkSync(stalePath);
        }
        release = acquireIdentityLock(manifest.dataRoot);
        const latest = fs.existsSync(manifest.aliasPath) ? fileHash(manifest.aliasPath) : null;
        if (latest !== current) throw new Error("Identity changed during rollback");
        assertHash(original, manifest.aliasSha256);
        if (latest === manifest.aliasSha256) return result;
        const staged = `${manifest.aliasPath}.${randomUUID()}.rollback-stage`;
        durableCreate(staged, fs.readFileSync(original));
        if (latest === null) fs.linkSync(staged, manifest.aliasPath);
        else publishWithoutOverwrite(manifest.aliasPath, `${staged}.displaced`, staged, manifest.newSha256);
        assertHash(manifest.aliasPath, manifest.aliasSha256);
        fs.unlinkSync(staged);
        return result;
    } finally {
        release?.();
        if (fs.existsSync(recoveryLock) && fileHash(recoveryLock) === sha256(manifest.migrationId)) fs.unlinkSync(recoveryLock);
    }
}

export function getDevinIdentityReadTargets(id: string, dataRoot = DATA_ROOT): string[] {
    const child = /^(.*)--subagent-([a-zA-Z0-9_-]+)$/u.exec(id);
    const parent = child?.[1] ?? id;
    const canonical = resolveCachedDevinIdentity(parent, dataRoot);
    const targets = new Set([canonical, parent]);
    const directory = path.dirname(identityPath(parent, dataRoot));
    if (fs.existsSync(directory)) for (const filename of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/u.test(filename)) continue;
        const absolute = checkedPath(path.join(directory, filename));
        if (fs.statSync(absolute).size > 65536) throw new Error("Devin identity mapping exceeds size limit");
        const entry = JSON.parse(fs.readFileSync(absolute, "utf8"));
        if (entry.version === 1 && entry.canonicalId === canonical && entry.alias !== canonical
            && absolute === identityPath(entry.alias, dataRoot) && entry.legacyReadIds?.length === 1 && entry.legacyReadIds[0] === entry.alias) targets.add(entry.alias);
    }
    return [...targets].map(target => child ? `${target}--subagent-${child[2]}` : target);
}
