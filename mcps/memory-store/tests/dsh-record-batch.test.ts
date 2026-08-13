import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { __recordConcurrencyTest } from "../src/tools/record.js";

const root = await mkdtemp(path.join(tmpdir(), "dsh-record-batch-"));
const previousRoot = process.env.MEMORY_STORE_DSH_SESSIONS_ROOT;
try {
    process.env.MEMORY_STORE_DSH_SESSIONS_ROOT = root;
    const sessionDirectory = path.join(root, "--workspace--", "session-directory");
    await mkdir(sessionDirectory, { recursive: true });
    const sourcePath = path.join(sessionDirectory, "session.jsonl");
    const header = {
        type: "session",
        version: 0,
        id: "dsh-batch-id",
        cwd: "C:\\workspace\\project",
        title: "DSH batch fixture",
    };
    await writeFile(sourcePath, JSON.stringify(header) + "\n", "utf8");

    const result = await __recordConcurrencyTest.collectBatchCandidates(
        "dsh",
        { workspace: "workspace\\project", limit: 10 },
        "unused-hash",
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].id, "dsh-batch-id");
    assert.equal(result.candidates[0].chain, "dsh");
    assert.equal(result.candidates[0].workspace, "C:\\workspace\\project");
} finally {
    if (previousRoot === undefined) delete process.env.MEMORY_STORE_DSH_SESSIONS_ROOT;
    else process.env.MEMORY_STORE_DSH_SESSIONS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
}

console.log("dsh-record-batch tests passed");
