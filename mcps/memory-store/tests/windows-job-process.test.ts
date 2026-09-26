import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnWindowsJobProcess, ensureWindowsJobRunner, WindowsJobIncompleteError, type WindowsJobProcess } from "../src/windows-job-process.js";

if (process.platform !== "win32") {
    console.log("Windows Job process test skipped on non-Windows");
    process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-windows-job-test-"));
const fixture = path.resolve("tests/fixtures/windows-job-fake.mjs");
const active = new Set<WindowsJobProcess>();

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

async function waitForFile(filePath: string): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (fs.existsSync(filePath)) return Number(fs.readFileSync(filePath, "utf8"));
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`PID file absent: ${filePath}`);
}

async function waitForDeath(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (!alive(pid)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive(pid), false, `PID ${pid} survived cleanup`);
}

async function launch(mode: string, extraArgs: string[] = [], signal?: AbortSignal): Promise<WindowsJobProcess> {
    const job = await spawnWindowsJobProcess(process.execPath, [fixture, mode, ...extraArgs], {
        signal, deadlineAt: Date.now() + 10000,
    });
    active.add(job);
    void job.completion.finally(() => active.delete(job)).catch(() => {});
    return job;
}

async function main(): Promise<void> {
    try {
        const runner = await ensureWindowsJobRunner({ deadlineAt: Date.now() + 10000 });
        assert.ok(fs.existsSync(runner));
        await assert.rejects(ensureWindowsJobRunner({ deadlineAt: Date.now() - 1 }), /deadline/u);

        const normal = await launch("normal", ["空 格", "引\"号", "末尾\\", "emoji😀"]);
        let stdout = "";
        let stderr = "";
        normal.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        normal.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        normal.stdin.end("stdin-中文");
        const normalResult = await normal.completion;
        assert.deepEqual(normalResult, { exitCode: 7, cancelled: false, childPid: normal.childPid });
        assert.deepEqual(JSON.parse(stdout), { args: ["空 格", "引\"号", "末尾\\", "emoji😀"], input: "stdin-中文" });
        assert.equal(stderr, "stderr-ok");
        assert.equal(alive(normal.childPid), false);
        console.log("PASS normal stdio / exit code / Unicode quoting");

        const shellCommand = `${process.execPath} ${fixture} normal`;
        const shell = await spawnWindowsJobProcess("cmd.exe", ["/d", "/s", "/c", shellCommand], {
            deadlineAt: Date.now() + 10000,
        });
        let shellOut = "";
        let shellErr = "";
        shell.stdout.setEncoding("utf8").on("data", chunk => { shellOut += chunk; });
        shell.stderr.setEncoding("utf8").on("data", chunk => { shellErr += chunk; });
        shell.stdin.end("CC-prompt");
        assert.equal((await shell.completion).exitCode, 7, `stdout=${shellOut} stderr=${shellErr}`);
        assert.deepEqual(JSON.parse(shellOut), { args: [], input: "CC-prompt" });
        assert.equal(shellErr, "stderr-ok");
        console.log("PASS cmd.exe wrapper / CC-style stdin");

        const orphanPidFile = path.join(root, "orphan.pid");
        const orphan = await launch("orphan", [orphanPidFile]);
        const orphanChildPid = await waitForFile(orphanPidFile);
        await assert.rejects(orphan.completion, error => error instanceof WindowsJobIncompleteError && error.parentExitCode === 0 && error.cleanupVerified);
        assert.equal(alive(orphanChildPid), false);
        console.log("PASS parent exited first / incomplete output rejected / descendant dead before return");

        const cancelPidFile = path.join(root, "cancel.pid");
        const controller = new AbortController();
        const cancelled = await launch("cancel", [cancelPidFile], controller.signal);
        const cancelChildPid = await waitForFile(cancelPidFile);
        controller.abort();
        const cancelResult = await cancelled.completion;
        assert.equal(cancelResult.cancelled, true);
        assert.equal(alive(cancelChildPid), false);
        assert.equal(alive(cancelled.childPid), false);
        console.log("PASS cancellation / descendants dead before return");

        const stopPidFile = path.join(root, "stop.pid");
        const stopped = await launch("cancel", [stopPidFile]);
        const stopChildPid = await waitForFile(stopPidFile);
        const stopResult = await stopped.terminate();
        assert.equal(stopResult.cancelled, true);
        assert.equal(alive(stopChildPid), false);
        console.log("PASS terminate promise / descendants dead before return");

        const timeoutPidFile = path.join(root, "timeout.pid");
        const timed = await spawnWindowsJobProcess(process.execPath, [fixture, "cancel", timeoutPidFile], {
            deadlineAt: Date.now() + 350,
        });
        const timeoutChildPid = await waitForFile(timeoutPidFile);
        const timeoutResult = await timed.completion;
        assert.equal(timeoutResult.cancelled, true);
        assert.equal(alive(timeoutChildPid), false);
        console.log("PASS deadline / descendants dead before return");

        const ownerPidFile = path.join(root, "owner.pid");
        const ownerReceipt = path.join(root, "owner.json");
        const owner = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/windows-job-owner.mts", ownerPidFile, ownerReceipt], {
            cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
        });
        let ownerError = "";
        owner.stderr.setEncoding("utf8").on("data", chunk => { ownerError += chunk; });
        const ownerExit = await new Promise<number | null>(resolve => owner.once("close", resolve));
        assert.equal(ownerExit, 0, ownerError);
        const ownerPids = JSON.parse(fs.readFileSync(ownerReceipt, "utf8")) as { runnerPid: number; parentPid: number; descendantPid: number };
        await Promise.all([waitForDeath(ownerPids.runnerPid), waitForDeath(ownerPids.parentPid), waitForDeath(ownerPids.descendantPid)]);
        console.log("PASS calling Node parent exits / helper and descendants terminate");

        await assert.rejects(spawnWindowsJobProcess(path.join(root, "missing.exe"), [], {
            deadlineAt: Date.now() + 10000,
        }), /launch failed/u);
        console.log("PASS launch failure is fail-closed");

        const parallel = await Promise.all(Array.from({ length: 6 }, () => launch("normal", ["并行"] )));
        const results = await Promise.all(parallel.map(job => {
            job.stdout.resume();
            job.stderr.resume();
            job.stdin.end();
            return job.completion;
        }));
        assert.ok(results.every(result => result.exitCode === 7 && !alive(result.childPid)));
        console.log("PASS parallel launches / no surviving children");
    } finally {
        await Promise.allSettled([...active].map(job => job.terminate()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

await main();
