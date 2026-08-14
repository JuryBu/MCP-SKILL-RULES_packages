import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxRoot = path.join(repositoryRoot, "mcps", "sandbox");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-memory-limit-config-"));
process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_PROCESS_TREE_MAX_MEMORY_MB = "4096";

const {
    PROCESS_TREE_MAX_MEMORY_MB,
    CODEX_DEFAULT_MAX_MEMORY_MB,
    CODEX_DEFAULT_MEMORY_REQUEST_MB,
} = await import("../mcps/sandbox/dist/memory-limits.js");
const { execute } = await import("../mcps/sandbox/dist/executor.js");
const { registerExec } = await import("../mcps/sandbox/dist/tools/exec.js");
const { registerBatch } = await import("../mcps/sandbox/dist/tools/batch.js");
const { registerSession } = await import("../mcps/sandbox/dist/tools/session.js");
const { registerLaunch } = await import("../mcps/sandbox/dist/tools/launch.js");
const { registerCodex } = await import("../mcps/sandbox/dist/tools/codex.js");
const { registerStatus } = await import("../mcps/sandbox/dist/tools/status.js");

function captureTool(register, expectedName) {
    let captured;
    const server = {
        tool(name, description, shape, handler) {
            assert.equal(name, expectedName);
            captured = { description, shape, handler };
        },
        registerTool(name, config, handler) {
            assert.equal(name, expectedName);
            captured = { description: config.description, shape: config.inputSchema.shape, handler };
        },
    };
    register(server);
    assert.ok(captured, `${expectedName} was not registered`);
    return captured;
}

assert.equal(PROCESS_TREE_MAX_MEMORY_MB, 4096);
assert.equal(CODEX_DEFAULT_MAX_MEMORY_MB, 1536);
assert.equal(CODEX_DEFAULT_MEMORY_REQUEST_MB, 384);

const execTool = captureTool(registerExec, "sandbox_exec");
const batchTool = captureTool(registerBatch, "sandbox_batch");
const sessionTool = captureTool(registerSession, "sandbox_session");
const launchTool = captureTool(registerLaunch, "sandbox_launch");
const codexTool = captureTool(registerCodex, "sandbox_codex");
const statusTool = captureTool(registerStatus, "sandbox_status");

for (const [name, maxSchema, requestSchema] of [
    ["exec", execTool.shape.maxMemoryMB, execTool.shape.memoryRequestMB],
    ["session", sessionTool.shape.maxMemoryMB, sessionTool.shape.memoryRequestMB],
    ["launch", launchTool.shape.maxMemoryMB, launchTool.shape.memoryRequestMB],
    ["codex", codexTool.shape.maxMemoryMB, codexTool.shape.memoryRequestMB],
]) {
    assert.equal(maxSchema.safeParse(2048).success, true, `${name} rejects maxMemoryMB=2048 under a 4096MB server cap`);
    assert.equal(maxSchema.safeParse(4097).success, false, `${name} accepts maxMemoryMB above the server cap`);
    assert.equal(requestSchema.safeParse(2048).success, true, `${name} rejects memoryRequestMB=2048 under a 4096MB server cap`);
    assert.equal(requestSchema.safeParse(4097).success, false, `${name} accepts memoryRequestMB above the server cap`);
}
assert.equal(batchTool.shape.tasks.safeParse([{
    command: "echo ok",
    maxMemoryMB: 2048,
    memoryRequestMB: 64,
}]).success, true);
assert.equal(batchTool.shape.tasks.safeParse([{
    command: "echo no",
    maxMemoryMB: 4097,
    memoryRequestMB: 64,
}]).success, false);

const execResult = await execute({
    command: "echo memory-config-ok",
    language: "cmd",
    maxMemoryMB: 2048,
    memoryRequestMB: 64,
    timeout: 5000,
});
assert.equal(execResult.exitCode, 0);
assert.match(execResult.stdout, /memory-config-ok/);

const batchTooSmall = await batchTool.handler({
    tasks: [{ command: "echo should-not-run", language: "cmd", maxMemoryMB: 2048, memoryRequestMB: 128 }],
    maxTotalMemoryMB: 64,
});
assert.match(batchTooSmall.content[0].text, /memoryRequestMB 128MB 超过 batch maxTotalMemoryMB 64MB/);

const launchAboveServiceCap = await launchTool.handler({
    command: "echo should-not-run",
    maxMemoryMB: 4097,
    memoryRequestMB: 64,
});
assert.match(launchAboveServiceCap.content[0].text, /maxMemoryMB 必须在 16～4096 之间/);

const status = await statusTool.handler({ action: "overview" });
assert.match(status.content[0].text, /单进程树允许上限: 4096 MB/);
assert.match(status.content[0].text, /Codex 默认: 请求 384 MB \/ 硬上限 1536 MB/);

const childProbe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `process.env.SANDBOX_PROCESS_TREE_MAX_MEMORY_MB="2048";
     const limits=await import("./dist/memory-limits.js");
     const tool=await import("./dist/tools/exec.js");
     let shape;
     tool.registerExec({tool(_name,_description,value){shape=value;}});
     console.log(JSON.stringify({cap:limits.PROCESS_TREE_MAX_MEMORY_MB,ok2048:shape.maxMemoryMB.safeParse(2048).success,ok2049:shape.maxMemoryMB.safeParse(2049).success}));`,
], { cwd: sandboxRoot, encoding: "utf8" });
assert.equal(childProbe.status, 0, childProbe.stderr);
assert.deepEqual(JSON.parse(childProbe.stdout.trim()), { cap: 2048, ok2048: true, ok2049: false });

console.log("6/6 sandbox memory-limit configuration checks passed");
