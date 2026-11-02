import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const childMode = process.argv[2] === "--crash-child";
const root = childMode ? process.env.MEMORY_STORE_DATA_ROOT! : fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-lock-publication-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const store = await import("../src/store.ts");
const { hash } = store.ensureWorkspace("C:/synthetic-store-lock-publication");
const lockPathFor = (memoryId: string) => path.join(root, ".memory-locks", `${crypto.createHash("sha256").update(JSON.stringify([hash, memoryId])).digest("hex")}.lock`);

if (childMode) {
    const flavor = process.argv[3];
    const boundary = process.argv[4];
    const memoryId = process.argv[5];
    const lockPath = lockPathFor(memoryId);
    const originalLink = fs.linkSync;
    fs.linkSync = (source, target) => {
        if (path.resolve(String(target)) !== path.resolve(lockPath)) return originalLink(source, target);
        const prepared = JSON.parse(fs.readFileSync(source, "utf8"));
        assert.equal(prepared.pid, process.pid);
        assert.ok(prepared.nonce);
        if (boundary === "before-link") process.exit(31);
        originalLink(source, target);
        process.exit(32);
    };
    if (flavor === "async") await store.withMemoryLock(hash, memoryId, () => store.writeMemoryFile(hash, memoryId, "unexpected child write"));
    else store.writeMemoryFile(hash, memoryId, "unexpected child write");
    process.exitCode = 99;
} else {
    try {
        for (const flavor of ["async", "sync"]) for (const boundary of ["before-link", "after-link"]) {
            const memoryId = `${flavor}-${boundary}`;
            const lockPath = lockPathFor(memoryId);
            store.writeMemoryFile(hash, memoryId, "original body");
            const crashed = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--crash-child", flavor, boundary, memoryId], { encoding: "utf8", timeout: 5000, windowsHide: true });
            assert.equal(crashed.status, boundary === "before-link" ? 31 : 32, crashed.stderr);
            assert.equal(store.readMemoryFile(hash, memoryId), "original body");
            if (boundary === "before-link") assert.equal(fs.existsSync(lockPath), false);
            else {
                const formal = JSON.parse(fs.readFileSync(lockPath, "utf8"));
                assert.equal(formal.pid, crashed.pid);
                assert.ok(formal.nonce);
                assert.throws(() => process.kill(formal.pid, 0));
            }
            await store.withMemoryLock(hash, memoryId, () => store.writeMemoryFile(hash, memoryId, "recovered body"));
            assert.equal(store.readMemoryFile(hash, memoryId), "recovered body");
            assert.equal(fs.existsSync(lockPath), false);
            console.log(JSON.stringify({ flavor, boundary, formalLock: boundary === "before-link" ? "absent" : "complete-dead-owner-token", recovery: "passed" }));
        }
        for (const kind of ["unknown", "active"]) {
            const memoryId = `${kind}-owner`;
            store.writeMemoryFile(hash, memoryId, "protected body");
            const lockPath = lockPathFor(memoryId);
            const original = kind === "unknown" ? "" : JSON.stringify({ pid: process.pid, nonce: "active-owner" });
            fs.writeFileSync(lockPath, original);
            assert.throws(() => store.writeMemoryFile(hash, memoryId, "unsafe write"), error => (error as NodeJS.ErrnoException).code === "EEXIST");
            assert.equal(fs.readFileSync(lockPath, "utf8"), original);
            assert.equal(store.readMemoryFile(hash, memoryId), "protected body");
        }
        for (const flavor of ["async", "sync"]) {
            const memoryId = `${flavor}-initializer-cleanup`;
            const lockPath = lockPathFor(memoryId);
            const originalUnlink = fs.unlinkSync;
            let deferred: string | undefined;
            fs.unlinkSync = target => {
                if (!deferred && path.resolve(String(target)).startsWith(`${path.resolve(lockPath)}.owner-`)) {
                    deferred = String(target);
                    throw Object.assign(new Error("synthetic-initializer-cleanup-failure"), { code: "EIO" });
                }
                return originalUnlink(target);
            };
            try {
                if (flavor === "async") await store.withMemoryLock(hash, memoryId, () => store.writeMemoryFile(hash, memoryId, "committed body"));
                else store.writeMemoryFile(hash, memoryId, "committed body");
            } finally { fs.unlinkSync = originalUnlink; }
            assert.ok(deferred);
            assert.equal(fs.existsSync(deferred), true);
            assert.equal(fs.existsSync(lockPath), false);
            assert.equal(store.readMemoryFile(hash, memoryId), "committed body");
        }
        console.log("PASS primary async/sync lock publication has no empty-token process-exit window; unknown/live owners preserved");
        console.log("PASS published ownership survives initializer cleanup failure and the formal lock is released");
    } finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
