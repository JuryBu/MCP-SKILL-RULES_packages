import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-locks-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const store = await import("../src/store.ts");
const { indexCache } = await import("../src/cache.ts");
const { hash } = store.ensureWorkspace("C:/synthetic-summary-locks");
const storeUrl = pathToFileURL(path.resolve("src/store.ts")).href;
const children: Promise<unknown>[] = [];

function child(code: string) {
    const processHandle = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    processHandle.stdout.on("data", chunk => { stdout += chunk.toString(); });
    processHandle.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const done = once(processHandle, "exit").then(([code]) => { assert.equal(code, 0, stderr); return stdout; });
    children.push(done);
    return {
        done,
        async ready(marker: string) {
            while (!stdout.includes(marker)) {
                if (processHandle.exitCode !== null) throw new Error(`Child exited before ${marker}: ${stderr}`);
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        },
    };
}

try {
    store.writeMemoryFile(hash, "same-memory", "original");
    const locked = child(`import {withMemoryLock} from ${JSON.stringify(storeUrl)}; await withMemoryLock(${JSON.stringify(hash)}, "same-memory", async () => { console.log("MEMORY_LOCKED"); await new Promise(resolve => setTimeout(resolve, 120)); });`);
    await locked.ready("MEMORY_LOCKED");
    assert.throws(() => store.writeMemoryFile(hash, "same-memory", "unsafe concurrent write"), /EEXIST/);
    assert.throws(() => store.deleteMemoryFile(hash, "same-memory"), /EEXIST/);
    await locked.done;
    await store.withMemoryLock(hash, "same-memory", () => store.writeMemoryFile(hash, "same-memory", "serialized"));
    assert.equal(store.readMemoryFile(hash, "same-memory"), "serialized");
    let unlock: () => void = () => {};
    let ready: () => void = () => {};
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const held = store.withMemoryLock(hash, "same-memory", async () => { ready(); await new Promise<void>(resolve => { unlock = resolve; }); });
    await readyPromise;
    assert.throws(() => store.writeMemoryFile(hash, "same-memory", "unrelated async context"), /EEXIST/);
    unlock();
    await held;

    const crashed = child(`import {withMemoryLock} from ${JSON.stringify(storeUrl)}; await withMemoryLock(${JSON.stringify(hash)}, "same-memory", async () => { console.log("ABANDONED_LOCK"); process.exit(0); });`);
    await crashed.done;
    await store.withMemoryLock(hash, "same-memory", () => store.writeMemoryFile(hash, "same-memory", "recovered dead owner"));
    assert.equal(store.readMemoryFile(hash, "same-memory"), "recovered dead owner");

    const first = child(`import {mutateWorkspaceIndex} from ${JSON.stringify(storeUrl)}; await mutateWorkspaceIndex(${JSON.stringify(hash)}, async index => { console.log("INDEX_LOCKED"); await new Promise(resolve => setTimeout(resolve, 100)); index.entries.push({id:"first-process",tags:[],sizeBytes:1}); });`);
    await first.ready("INDEX_LOCKED");
    const second = child(`import {mutateWorkspaceIndex} from ${JSON.stringify(storeUrl)}; await mutateWorkspaceIndex(${JSON.stringify(hash)}, index => { index.entries.push({id:"second-process",tags:[],sizeBytes:2}); });`);
    await Promise.all([first.done, second.done]);
    indexCache.clear();
    assert.deepEqual(store.readWorkspaceIndex(hash).entries.map(entry => entry.id).sort(), ["first-process", "second-process"]);
    await store.syncGlobalIndexForWorkspace(hash);
    assert.equal(store.readGlobalIndex().workspaces[hash].totalSizeBytes, 3);
    assert.equal(fs.readdirSync(path.join(root, ".memory-locks")).filter(name => name.endsWith(".lock") || name.endsWith(".reap")).length, 0);
    console.log("auto-summary-locks: cross-process memory/index serialization, unrelated-context exclusion, dead-owner recovery and lock cleanup passed");
} finally {
    await Promise.allSettled(children);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
