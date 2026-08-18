import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-async-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const {
    renameWithRetryAsync,
    writeJsonAtomicAsync,
    writeTextAtomicAsync,
} = await import("../src/store.ts");
const {
    copyRecordToHash,
    deleteRecord,
    deleteRecordSidecar,
    ensureRecordsDirAsync,
    readRecordAsync,
    readRecordSidecarAsync,
    readRecordsIndexAsync,
    writeRecord,
    writeRecordSidecar,
} = await import("../src/record-store.ts");

try {
    const atomicDir = path.join(dataRoot, "atomic");
    await fs.promises.mkdir(atomicDir, { recursive: true });
    const textPath = path.join(atomicDir, "entry.txt");
    const jsonPath = path.join(atomicDir, "entry.json");
    await writeTextAtomicAsync(textPath, "first");
    await writeTextAtomicAsync(textPath, "second");
    await writeJsonAtomicAsync(jsonPath, { value: 42 });
    assert.equal(await fs.promises.readFile(textPath, "utf-8"), "second");
    assert.deepEqual(JSON.parse(await fs.promises.readFile(jsonPath, "utf-8")), { value: 42 });
    assert.equal((await fs.promises.readdir(atomicDir)).some((entry) => entry.includes(".tmp.")), false);

    const retrySourcePath = path.join(atomicDir, "retry.tmp");
    const retryTargetPath = path.join(atomicDir, "retry.txt");
    await fs.promises.writeFile(retrySourcePath, "retry", "utf-8");
    const renameDescriptor = Object.getOwnPropertyDescriptor(fs.promises, "rename");
    let renameAttempts = 0;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (sourcePath: string, targetPath: string) => {
            renameAttempts++;
            if (renameAttempts < 3) {
                const error = new Error("temporary rename failure") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }
            await renameDescriptor?.value.call(fs.promises, sourcePath, targetPath);
        },
    });
    try {
        await renameWithRetryAsync(retrySourcePath, retryTargetPath);
    } finally {
        if (renameDescriptor) Object.defineProperty(fs.promises, "rename", renameDescriptor);
        else Reflect.deleteProperty(fs.promises, "rename");
    }
    assert.equal(renameAttempts, 3);
    assert.equal(await fs.promises.readFile(retryTargetPath, "utf-8"), "retry");

    const sourceHash = "source-async";
    const targetHash = "target-async";
    await ensureRecordsDirAsync(sourceHash);
    assert.deepEqual(await readRecordsIndexAsync(sourceHash), { version: 1, records: {} });
    assert.equal(await readRecordAsync(sourceHash, "missing"), null);

    await Promise.all(Array.from({ length: 24 }, async (_, index) => {
        const conversationId = `concurrent-${index}`;
        await writeRecord(sourceHash, conversationId, `# ${conversationId}`, {
            title: conversationId,
            totalRounds: index + 1,
            totalSteps: index + 10,
            lastUpdatedRound: index + 1,
            phases: 1,
        });
    }));
    const sourceIndex = await readRecordsIndexAsync(sourceHash);
    assert.equal(Object.keys(sourceIndex.records).length, 24, "异步索引锁不能丢失并发写入的 Record");

    await writeRecordSidecar(sourceHash, "concurrent-0", "ownership.json", { state: "active" });
    assert.deepEqual(
        await readRecordSidecarAsync<{ state: string }>(sourceHash, "concurrent-0", "ownership.json"),
        { state: "active" },
    );
    assert.equal(await deleteRecordSidecar(sourceHash, "concurrent-0", "ownership.json"), true);
    assert.equal(await readRecordSidecarAsync(sourceHash, "concurrent-0", "ownership.json"), null);
    assert.equal(await deleteRecordSidecar(sourceHash, "concurrent-0", "ownership.json"), false);

    await writeRecordSidecar(sourceHash, "concurrent-1", "ownership.json", { state: "copied" });
    assert.equal(await copyRecordToHash(sourceHash, targetHash, "concurrent-1", {}, { backup: true }), true);
    assert.equal(await readRecordAsync(targetHash, "concurrent-1"), "# concurrent-1");
    assert.equal((await readRecordsIndexAsync(targetHash)).records["concurrent-1"]?.title, "concurrent-1");
    assert.ok((await fs.promises.readdir(path.join(dataRoot, "record-ownership-backups"))).length > 0);

    assert.equal(await deleteRecord(sourceHash, "concurrent-1"), true);
    assert.equal(await readRecordAsync(sourceHash, "concurrent-1"), null);
    assert.equal(await readRecordSidecarAsync(sourceHash, "concurrent-1", "ownership.json"), null);
    assert.equal((await readRecordsIndexAsync(sourceHash)).records["concurrent-1"], undefined);
    assert.equal(await deleteRecord(sourceHash, "concurrent-1"), false);

    console.log("✅ record-store-async 通过：异步原子写、索引锁、sidecar、copy、readdir/unlink/delete 热路径正常");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
