import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compressed-estimate-"));
const originalHome = os.homedir;
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
os.homedir = () => temporaryRoot;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporaryRoot, "data");
try {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const codexHome = path.join(temporaryRoot, ".codex");
    const sourcePath = path.join(codexHome, "sessions", `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(`${sourcePath}.zst`, "deferred-invalid-archive");
    execFileSync("python", ["-c", "import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\nconn.execute('create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer)')\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'estimate','vscode',None,None,None,None,1,1,0))\nconn.commit()\nconn.close()", path.join(codexHome, "state_5.sqlite"), conversationId, sourcePath, temporaryRoot]);
    const worker = await import("../src/conversation-fetch-worker-client.ts");
    const inheritedId = "22222222-2222-4222-8222-222222222222";
    const inheritedPath = path.join(path.dirname(sourcePath), `rollout-2026-01-01T00-00-00-${inheritedId}.jsonl`);
    fs.writeFileSync(inheritedPath, JSON.stringify({ type: "session_meta", payload: { id: inheritedId, history_base: { thread_id: conversationId, end_ordinal_exclusive: 1, end_byte_offset: 1 } } }) + "\n");
    execFileSync("python", ["-c", "import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'inherited','vscode',None,None,None,None,1,1,0))\nconn.commit()\nconn.close()", path.join(codexHome, "state_5.sqlite"), inheritedId, inheritedPath, temporaryRoot]);
    const originalStream = fs.createReadStream;
    fs.createReadStream = (() => { throw new Error("full archive stream must not run in estimate"); }) as typeof fs.createReadStream;
    try {
        const estimate = await worker.estimateCodexFetchWorkAsync(conversationId);
        assert.equal(estimate?.sourcePath, `${sourcePath}.zst`);
        assert.equal(estimate.shouldBackground, true);
        assert.equal(estimate.verificationDeferred, true);
        assert.equal(estimate.physicalArchiveEstimate, true);
        assert.equal(estimate.historySource, undefined);
        assert.equal(estimate.sourceSize, fs.statSync(`${sourcePath}.zst`).size);
        const payload = worker.createCodexFetchWorkerPayload({ conversationId, link: "reference", source: "local", modelChain: "codex", estimate });
        assert.equal(payload.version, 2);
        assert.equal(payload.verificationDeferred, true);
        const inherited = await worker.estimateCodexFetchWorkAsync(inheritedId);
        assert.equal(inherited?.sourcePath, inheritedPath);
        assert.equal(inherited.shouldBackground, true);
        assert.equal(inherited.verificationDeferred, true);
        assert.equal(inherited.historySource, undefined);
        const expandedPayload = worker.createCodexFetchWorkerPayload({ conversationId: inheritedId, link: "expand_children", source: "local", modelChain: "codex", estimate: inherited });
        assert.equal(expandedPayload.expansionLimitBytes, inherited.thresholdBytes);
    } finally { fs.createReadStream = originalStream; }
    const codex = await import("../src/codex-client.ts");
    await assert.rejects(codex.captureCodexSourceVersionAsync(sourcePath), /archive|zstd|magic|truncat/i);
    console.log("codex-compressed-fetch-estimate: PASS stale index/physical metadata only/inherited compressed base deferred/version2 background/small expansion budget/strict worker source capture retained");
} finally {
    os.homedir = originalHome;
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
