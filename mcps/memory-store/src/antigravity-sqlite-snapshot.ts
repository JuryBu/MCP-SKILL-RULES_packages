import fs from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertAntigravityReadActive, type AntigravityLocalCandidate, type AntigravityLocalFile, type AntigravityLocalOptions } from "./antigravity-local-sources.js";

function sourceChanged(): Error {
    return new Error("Antigravity local source set changed while taking SQLite snapshot");
}

async function assertDatabaseFiles(metadata: Pick<AntigravityLocalCandidate, "files">, sourcePath: string, options: AntigravityLocalOptions): Promise<AntigravityLocalFile[]> {
    assertAntigravityReadActive(options);
    const files = metadata.files.filter(file => file.path === sourcePath || file.path === `${sourcePath}-wal`);
    for (const filename of [sourcePath, `${sourcePath}-wal`]) {
        const expected = files.find(file => file.path === filename);
        let actual;
        try { actual = await fs.stat(filename); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected) continue;
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sourceChanged();
            throw error;
        }
        if (!expected || !actual.isFile() || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs
            || (expected.ctimeMs !== undefined && actual.ctimeMs !== expected.ctimeMs)
            || (expected.ino !== undefined && actual.ino !== expected.ino)) throw sourceChanged();
    }
    return files;
}

async function digestFile(filename: string, options: AntigravityLocalOptions): Promise<string> {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filename)) {
        assertAntigravityReadActive(options);
        digest.update(chunk);
    }
    return digest.digest("hex");
}

export async function withAntigravitySqliteSnapshot<Result>(
    metadata: Pick<AntigravityLocalCandidate, "files">,
    options: AntigravityLocalOptions,
    read: (database: DatabaseSync) => Promise<Result> | Result,
): Promise<Result> {
    const source = metadata.files.find(file => file.kind === "db" && file.path.endsWith(".db"));
    if (!source) throw new Error("Antigravity SQLite snapshot requires a conversation database");
    const files = await assertDatabaseFiles(metadata, source.path, options);
    const temporaryBase = path.resolve(os.tmpdir());
    const space = await fs.statfs(temporaryBase);
    const requiredBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (Number(space.bavail) * Number(space.bsize) < requiredBytes + 16 * 1024 * 1024) {
        throw new Error("ANTIGRAVITY_SQLITE_SNAPSHOT_SPACE: insufficient temporary space for the database and WAL snapshot");
    }
    const directory = await fs.mkdtemp(path.join(temporaryBase, "memory-store-agy-sqlite-"));
    const snapshotPath = path.join(directory, "conversation.db");
    let database: DatabaseSync | undefined;
    try {
        for (const file of files) {
            assertAntigravityReadActive(options);
            const target = file.path.endsWith("-wal") ? `${snapshotPath}-wal` : snapshotPath;
            await fs.copyFile(file.path, target);
            const sourceDigest = await digestFile(file.path, options);
            const copiedDigest = await digestFile(target, options);
            if (sourceDigest !== copiedDigest) throw sourceChanged();
        }
        await assertDatabaseFiles(metadata, source.path, options);
        const sqlite = await import("node:sqlite");
        database = new sqlite.DatabaseSync(snapshotPath, { readOnly: true, allowExtension: false, timeout: 100 });
        database.exec("PRAGMA query_only=ON");
        const result = await read(database);
        await assertDatabaseFiles(metadata, source.path, options);
        return result;
    } finally {
        try { database?.close(); }
        finally {
            const resolved = path.resolve(directory);
            if (path.dirname(resolved) !== temporaryBase || !path.basename(resolved).startsWith("memory-store-agy-sqlite-")) {
                throw new Error("Antigravity SQLite snapshot cleanup target is outside its owned temporary directory");
            }
            await fs.rm(resolved, { recursive: true, force: true });
        }
    }
}
