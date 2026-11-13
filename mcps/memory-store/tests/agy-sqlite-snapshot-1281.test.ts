import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AntigravityLocalCandidate } from "../src/antigravity-local-sources.js";
import { withAntigravitySqliteSnapshot } from "../src/antigravity-sqlite-snapshot.js";

async function candidate(filename: string): Promise<AntigravityLocalCandidate> {
    const files = [];
    for (const name of [filename, `${filename}-wal`]) {
        try {
            const stat = await fs.stat(name);
            files.push({ path: name, kind: "db" as const, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return { id: "sqlite-snapshot-fixture", files } as AntigravityLocalCandidate;
}

async function contents(directory: string): Promise<Array<[string, string]>> {
    const result: Array<[string, string]> = [];
    for (const name of (await fs.readdir(directory)).sort()) {
        const bytes = await fs.readFile(path.join(directory, name));
        result.push([name, createHash("sha256").update(bytes).digest("hex")]);
    }
    return result;
}

const temporaryBase = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(temporaryBase, "agy-sqlite-1281-test-"));
let writer: DatabaseSync | undefined;
try {
    const inactive = path.join(root, "inactive.db");
    const database = new DatabaseSync(inactive);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES(1)");
    database.close();
    const before = await contents(root);
    let ownedSnapshot = "";
    const indices = await withAntigravitySqliteSnapshot(await candidate(inactive), {}, snapshot => {
        ownedSnapshot = path.dirname(String(snapshot.prepare("PRAGMA database_list").get()?.file));
        return snapshot.prepare("SELECT idx FROM steps").all().map(row => row.idx);
    });
    assert.deepEqual(indices, [1]);
    assert.deepEqual(await contents(root), before);
    await assert.rejects(fs.stat(ownedSnapshot), { code: "ENOENT" });

    const active = path.join(root, "active.db");
    writer = new DatabaseSync(active);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(idx INTEGER PRIMARY KEY); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES(7)");
    const activeBefore = await contents(root);
    const activeIndices = await withAntigravitySqliteSnapshot(await candidate(active), {}, snapshot => snapshot.prepare("SELECT idx FROM steps").all().map(row => row.idx));
    assert.deepEqual(activeIndices, [7]);
    assert.deepEqual(await contents(root), activeBefore);

    await assert.rejects(withAntigravitySqliteSnapshot(await candidate(active), {}, snapshot => {
        ownedSnapshot = path.dirname(String(snapshot.prepare("PRAGMA database_list").get()?.file));
        writer!.exec("INSERT INTO steps VALUES(8)");
        return snapshot.prepare("SELECT idx FROM steps").all();
    }), /source set changed/);
    await assert.rejects(fs.stat(ownedSnapshot), { code: "ENOENT" });
    console.log("PASS inactive source unchanged; committed live WAL retained; genuine source change rejected; snapshots cleaned");
} finally {
    writer?.close();
    if (path.dirname(path.resolve(root)) !== temporaryBase || !path.basename(root).startsWith("agy-sqlite-1281-test-")) throw new Error("Unexpected test cleanup directory");
    await fs.rm(root, { recursive: true, force: true });
}
