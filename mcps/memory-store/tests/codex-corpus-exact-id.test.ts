import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-corpus-exact-id-")));
const originalHome = os.homedir;
const originalSync = childProcess.execFileSync;
const originalExecFile = childProcess.execFile;
const customDescriptor = Object.getOwnPropertyDescriptor(childProcess.execFile, promisify.custom)!;
const originalAsync = customDescriptor.value;
const queries: string[] = [];
const sessions = path.join(temporary, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const storedId = "10000000-0000-4000-8000-000000000001";
const orphanId = "10000000-0000-4000-8000-000000000002";
const absentId = "10000000-0000-4000-8000-000000000003";
const rolloutPath = (identifier: string) => path.join(sessions, `rollout-2026-01-01T00-00-00-${identifier}.jsonl`);
fs.writeFileSync(rolloutPath(orphanId), `${JSON.stringify({ type: "session_meta", payload: { id: orphanId, cwd: temporary, title: "synthetic orphan" } })}\n`);
const database = new DatabaseSync(path.join(temporary, ".codex", "state_5.sqlite"));
database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer)");
database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?)").run(storedId, rolloutPath(storedId), temporary, "synthetic stored", "synthetic", null, null, null, null, 1);
database.close();
os.homedir = () => temporary;
const capture = (arguments_: unknown[]): void => {
    const argumentsList = arguments_[1];
    if (!Array.isArray(argumentsList)) return;
    const script = argumentsList.find(value => typeof value === "string" && value.includes("sqlite3"));
    if (script) queries.push(script);
};
childProcess.execFileSync = ((...arguments_: unknown[]) => {
    capture(arguments_);
    return Reflect.apply(originalSync, childProcess, arguments_);
}) as typeof originalSync;
const instrumentedExecFile = ((...arguments_: unknown[]) => {
    capture(arguments_);
    return Reflect.apply(originalExecFile, childProcess, arguments_);
}) as typeof originalExecFile;
Object.defineProperty(instrumentedExecFile, promisify.custom, { ...customDescriptor, value: (...arguments_: unknown[]) => {
    capture(arguments_);
    return Reflect.apply(originalAsync, childProcess, arguments_);
} });
childProcess.execFile = instrumentedExecFile;
syncBuiltinESMExports();

try {
    const client = await import("../src/codex-client.ts");
    for (const identifier of [storedId, orphanId, absentId]) {
        for (const operation of [
            () => client.getCodexThread(identifier)?.id ?? null,
            async () => (await client.getCodexThreadAsync(identifier))?.id ?? null,
            () => client.resolveCodexThreadId(identifier),
            () => client.resolveCodexThreadIdAsync(identifier),
        ]) {
            queries.length = 0;
            assert.equal(await operation(), identifier === absentId ? null : identifier);
            assert.equal(queries.length, 1, "a complete ID uses one exact database lookup before optional filename fallback");
            assert.match(queries[0]!, /where id = \? limit 1/u);
            assert.doesNotMatch(queries[0]!, /fetchall|thread_spawn_edges|order by/u);
        }
    }
    console.log("Codex corpus complete ID: stored/orphan/absent sync+async get+resolve each use one exact query and no metadata enumeration");
} finally {
    os.homedir = originalHome;
    childProcess.execFileSync = originalSync;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    fs.rmSync(temporary, { recursive: true, force: true });
}
