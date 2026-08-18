import fs from "node:fs/promises";
import path from "node:path";
import { withRecordCommitArtifactLock } from "../../src/record-store.ts";

const hash = process.argv[2];
const mode = process.argv[3] || "crash";
if (!hash) throw new Error("缺少 Record commit artifact 锁测试 hash");

function currentProcessStartedAtMs() {
    return Math.round(Date.now() - process.uptime() * 1_000);
}

async function writeFixtureLock(ownerStartedAtMs) {
    const dataRoot = process.env.MEMORY_STORE_DATA_ROOT;
    if (!dataRoot) throw new Error("缺少 MEMORY_STORE_DATA_ROOT");
    const lockPath = path.join(dataRoot, "workspaces", hash, "records", "_record_commit_artifacts.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
        token: `fixture-${mode}-${process.pid}`,
        ownerPid: process.pid,
        createdAtMs: Date.now(),
        ownerStartedAtMs,
    }), "utf8");
}

if (mode === "crash") {
    await withRecordCommitArtifactLock(hash, async () => {
        process.stdout.write("locked\n");
        process.exit(73);
    });
} else if (mode === "reused-pid") {
    await writeFixtureLock(currentProcessStartedAtMs() - 60_000);
    await withRecordCommitArtifactLock(hash, async () => {
        process.stdout.write("taken\n");
    });
} else if (mode === "matching-owner") {
    await writeFixtureLock(currentProcessStartedAtMs());
    setTimeout(() => {
        process.stdout.write("blocked\n");
        process.exit(0);
    }, 1_000).unref();
    await withRecordCommitArtifactLock(hash, async () => {
        process.stdout.write("taken\n");
        process.exit(74);
    });
} else {
    throw new Error(`未知 Record commit lock fixture mode: ${mode}`);
}
