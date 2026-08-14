import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-exec-batch-integration-"));
const sandboxRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcps", "sandbox");
process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB = "0";

const { execute } = await import("../mcps/sandbox/dist/executor.js");
const { HARD_RESPONSE_BYTE_LIMIT } = await import("../mcps/sandbox/dist/output-delivery.js");
const { registerBatch } = await import("../mcps/sandbox/dist/tools/batch.js");
const { registerExec } = await import("../mcps/sandbox/dist/tools/exec.js");

const tests = [];
const test = (name, run) => tests.push({ name, run });

function readArtifact(result, channel) {
    return fs.readFileSync(result.artifact[`${channel}Path`]);
}

function nodeCode(source) {
    return { code: source, language: "node" };
}

function createBatchHandler() {
    let handler;
    const server = {
        tool(name, description, schema, registeredHandler) {
            assert.equal(name, "sandbox_batch");
            assert.equal(typeof description, "string");
            assert.ok(schema);
            handler = registeredHandler;
        },
    };
    registerBatch(server);
    assert.equal(typeof handler, "function");
    return handler;
}

function createExecHandler() {
    let handler;
    const server = {
        tool(name, description, schema, registeredHandler) {
            assert.equal(name, "sandbox_exec");
            assert.equal(typeof description, "string");
            assert.ok(schema);
            handler = registeredHandler;
        },
    };
    registerExec(server);
    assert.equal(typeof handler, "function");
    return handler;
}

test("small process output preserves Unicode, emoji, and CRLF inline without an artifact", async () => {
    const stdout = "第一行\\r\\n🙂 第二行\\r\\n末行\\n";
    const stderr = "警告🙂\\r\\n";
    const result = await execute({
        ...nodeCode(`
            const stdout = ${JSON.stringify(stdout)};
            const stderr = ${JSON.stringify(stderr)};
            process.stdout.write(Buffer.from(stdout, "utf8"));
            process.stderr.write(Buffer.from(stderr, "utf8"));
        `),
        deliveryMode: "inline",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.outputStatus, "done");
    assert.equal(result.outputComplete, true);
    assert.equal(result.deliveryMode, "inline");
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, stderr);
    assert.equal(result.artifact, null);
    assert.equal(result.tempFile, null);
});

test("Windows Job Object reports a real peak for a sub-two-second command", async () => {
    if (process.platform !== "win32") return;
    const result = await execute({
        ...nodeCode(`setTimeout(() => process.stdout.write("short-memory-ok"), 200);`),
        memoryRequestMB: 64,
        maxMemoryMB: 256,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.killed, false);
    assert.equal(typeof result.peakMemoryMB, "number");
    assert.ok(result.peakMemoryMB > 0, `expected a measured peak, received ${result.peakMemoryMB}`);
});

test("Windows Job Object enforces the hard limit before a short command escapes sampling", async () => {
    if (process.platform !== "win32") return;
    const result = await execute({
        ...nodeCode(`setTimeout(() => process.stdout.write("should-not-complete"), 200);`),
        memoryRequestMB: 16,
        maxMemoryMB: 16,
    });

    assert.equal(result.exitCode, 137);
    assert.equal(result.killed, true);
    assert.equal(result.killReason, "memory");
    assert.equal(typeof result.peakMemoryMB, "number");
    assert.ok(result.peakMemoryMB >= 16, `expected a limit-sized peak, received ${result.peakMemoryMB}`);
});

test("sandbox_exec omits artifact metadata for a small inline result", async () => {
    const handler = createExecHandler();
    const response = await handler(nodeCode(`process.stdout.write("direct-output");`), {});
    assert.match(response.content[0].text, /direct-output/u);
    assert.doesNotMatch(response.content[0].text, /输出交付|artifactId|manifest:/u);
    assert.equal(response.structuredContent, undefined);
});

test("a 6.8K result stays inline with maxOutput 20K", async () => {
    const result = await execute({
        ...nodeCode(`process.stdout.write("x".repeat(6784));`),
        maxOutput: 20_000,
    });
    assert.equal(result.deliveryMode, "inline");
    assert.equal(result.stdout.length, 6_784);
    assert.equal(result.artifact, null);
});

test("2001 process-output lines are delivered through a complete artifact", async () => {
    const stdout = "line\n".repeat(2001);
    const result = await execute({
        ...nodeCode(`process.stdout.write("line\\n".repeat(2001));`),
        maxLines: 2000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.deliveryMode, "file");
    assert.equal(result.outputComplete, true);
    assert.equal(result.outputStatus, "done");
    assert.ok(result.outputReasons.includes("combined_line_limit_exceeded"));
    assert.equal(result.outputStats.combined.lines, 2001);
    assert.deepEqual(readArtifact(result, "stdout"), Buffer.from(stdout, "utf8"));
});

test("a roughly 2 MiB single process-output line is delivered through an artifact", async () => {
    const stdout = "x".repeat(2 * 1024 * 1024);
    const result = await execute({
        ...nodeCode(`process.stdout.write("x".repeat(2 * 1024 * 1024));`),
        maxOutput: 1024 * 1024,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.deliveryMode, "file");
    assert.equal(result.outputComplete, true);
    assert.equal(result.outputStatus, "done");
    assert.ok(result.outputReasons.length > 0);
    assert.equal(result.outputStats.stdout.rawBytes, Buffer.byteLength(stdout, "utf8"));
    assert.deepEqual(readArtifact(result, "stdout"), Buffer.from(stdout, "utf8"));
});

test("explicit display budgets keep complete artifacts without returning oversized text", async () => {
    const byteLimited = await execute({
        ...nodeCode(`process.stdout.write("x".repeat(2000));`),
        maxOutput: 100,
    });
    assert.equal(byteLimited.truncated, true);
    assert.ok(byteLimited.stdout.length < 300);
    assert.equal(readArtifact(byteLimited, "stdout").length, 2000);

    const lineLimited = await execute({
        ...nodeCode(`process.stdout.write(Array.from({ length: 20 }, (_, index) => "line-" + index).join("\\n"));`),
        maxLines: 5,
    });
    assert.equal(lineLimited.truncated, true);
    assert.ok(lineLimited.stdout.split("\n").length <= 7);
    assert.equal(lineLimited.outputStats.stdout.lines, 20);
});

test("a timeout keeps already-emitted output in a complete interrupted artifact", async () => {
    const stdout = "before-timeout Ω🙂\\r\\n";
    const result = await execute({
        ...nodeCode(`
            process.stdout.write(${JSON.stringify(stdout)});
            setInterval(() => {}, 1_000);
        `),
        timeout: 350,
        deliveryMode: "file",
    });

    assert.equal(result.killed, true);
    assert.equal(result.killReason, "timeout");
    assert.equal(result.outputStatus, "interrupted");
    assert.equal(result.outputComplete, true);
    assert.equal(result.deliveryMode, "file");
    assert.deepEqual(readArtifact(result, "stdout"), Buffer.from(stdout, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(result.artifact.manifestPath, "utf8"));
    assert.equal(manifest.status, "interrupted");
    assert.equal(manifest.complete, true);
});

test("sandbox_exec classifies a started command timeout separately", async () => {
    const handler = createExecHandler();
    const response = await handler({
        ...nodeCode(`process.stdout.write("started\\n"); setInterval(() => {}, 1_000);`),
        timeout: 250,
        deliveryMode: "file",
    }, {});

    assert.equal(response.structuredContent.errorType, "execution_timeout");
    assert.equal(response.structuredContent.commandStarted, true);
    assert.equal(response.structuredContent.killReason, "timeout");
    assert.ok(response.structuredContent.totalMs >= 200);
    assert.match(response.structuredContent.text, /execution_timeout/u);
    assert.match(response.structuredContent.text, /started/u);
    assert.match(response.content[0].text, /execution_timeout/u);
});

test("an already-aborted signal rejects before its command can create a file", async () => {
    const markerPath = path.join(dataRoot, "pre-aborted-command-started.txt");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        execute({
            ...nodeCode(`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");`),
            signal: controller.signal,
        }),
        (error) => error?.code === "admission_aborted",
    );
    assert.equal(fs.existsSync(markerPath), false);
});

test("batch maxTotalMemoryMB locally serializes three 64 MB reservations", async () => {
    const timelinePath = path.join(dataRoot, "batch-memory-timeline.txt");
    const handler = createBatchHandler();
    const taskCode = `
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(timelinePath)}, ` + "`start:${Date.now()}\\n`" + `);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220);
        console.log("finished");
    `;
    const response = await handler({
        tasks: Array.from({ length: 3 }, () => ({
            ...nodeCode(taskCode),
            maxMemoryMB: 64,
        })),
        maxParallel: 3,
        maxTotalMemoryMB: 64,
    }, {});
    const starts = fs.readFileSync(timelinePath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => Number(line.slice("start:".length)))
        .sort((left, right) => left - right);

    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 120, `first gap was ${starts[1] - starts[0]}ms`);
    assert.ok(starts[2] - starts[1] >= 120, `second gap was ${starts[2] - starts[1]}ms`);
    assert.match(response.content[0].text, /3 个任务/u);
    assert.doesNotMatch(response.content[0].text, /artifact=/u);
    assert.equal(response.structuredContent, undefined);
});

test("batch shares one response budget across otherwise-inline tasks", async () => {
    const handler = createBatchHandler();
    const response = await handler({
        tasks: Array.from({ length: 4 }, () => nodeCode(`process.stdout.write("x".repeat(300000));`)),
        maxParallel: 4,
    }, {});
    assert.match(response.content[0].text, /artifact=/u);
    assert.ok(Buffer.byteLength(response.content[0].text, "utf8") < 512 * 1024);
    assert.ok(response.structuredContent.tasks.every((task) => task.artifact));
    assert.match(response.structuredContent.text, /artifact=/u);
});

test("batch final response stays under the hard line for multibyte output", async () => {
    const handler = createBatchHandler();
    const response = await handler({
        tasks: Array.from({ length: 10 }, () => nodeCode(`process.stdout.write("甲".repeat(30000));`)),
        maxParallel: 10,
    }, {});
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= HARD_RESPONSE_BYTE_LIMIT);
    assert.match(response.content[0].text, /artifact=/u);
    assert.ok(response.structuredContent.tasks.every((task) => task.artifact));
});

test("batch final response stays under the hard line for JSON-heavy output", async () => {
    const handler = createBatchHandler();
    const response = await handler({
        tasks: Array.from({ length: 10 }, () => nodeCode(`process.stdout.write("\\0".repeat(15000));`)),
        maxParallel: 10,
    }, {});
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= HARD_RESPONSE_BYTE_LIMIT);
    assert.match(response.content[0].text, /artifact=/u);
});

test("runMs measures execution after admission waiting without subtracting the queue twice", async () => {
    const probe = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `process.env.SANDBOX_DATA_ROOT=${JSON.stringify(path.join(dataRoot, "run-ms-probe"))};
         process.env.SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB="0";
         process.env.SANDBOX_ADMISSION_LIMIT_MB="64";
         const { acquireResourceLease } = await import("./dist/resource-admission-runtime.js");
         const { execute } = await import("./dist/executor.js");
         const held = await acquireResourceLease({ ownerId: "holder", reservationMB: 64 });
         setTimeout(() => held.release(), 300);
         const result = await execute({
             code: "setTimeout(() => console.log('done'), 200)",
             language: "node",
             maxMemoryMB: 256,
             memoryRequestMB: 64,
             admissionBudgetMs: 2000,
             timeout: 5000,
         });
         process.stdout.write(JSON.stringify({ queueWaitMs: result.queueWaitMs, runMs: result.runMs, commandStarted: result.commandStarted }));
         process.exit(0);`,
    ], {
        cwd: sandboxRoot,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env },
    });
    assert.equal(probe.status, 0, JSON.stringify({
        error: probe.error?.message,
        signal: probe.signal,
        stdout: probe.stdout,
        stderr: probe.stderr,
    }));
    const metrics = JSON.parse(probe.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(metrics.commandStarted, true);
    assert.ok(metrics.queueWaitMs >= 200, `queue wait was only ${metrics.queueWaitMs}ms`);
    assert.ok(metrics.runMs >= 150, `runMs lost execution time and was only ${metrics.runMs}ms`);
});

test("missing working directory is classified before a command starts", async () => {
    const missingCwd = path.join(dataRoot, "missing-cwd");
    const result = await execute({
        command: "echo should-not-run",
        language: "cmd",
        cwd: missingCwd,
        maxMemoryMB: 256,
    });
    assert.equal(result.commandStarted, false);
    assert.equal(result.mayHaveStarted, false);
    assert.equal(result.errorType, "working_directory_missing");
    assert.equal(result.runMs, 0);
    assert.equal(result.exitCode, 1);
});

test("missing Windows Job runner fails closed and the next command remains usable", async () => {
    if (process.platform !== "win32") return;
    const originalRunner = process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH;
    const markerPath = path.join(dataRoot, "runner-missing-marker.txt");
    process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH = path.join(dataRoot, "missing-runner.exe");
    try {
        const failed = await execute({
            ...nodeCode(`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "unsafe");`),
            maxMemoryMB: 256,
        });
        assert.equal(failed.commandStarted, false);
        assert.equal(failed.mayHaveStarted, false);
        assert.equal(failed.errorType, "windows_job_runner_missing");
        assert.equal(failed.runMs, 0);
        assert.equal(fs.existsSync(markerPath), false);
    } finally {
        if (originalRunner === undefined) delete process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH;
        else process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH = originalRunner;
    }

    const recovered = await execute({ ...nodeCode(`console.log("followup-ok")`), maxMemoryMB: 256 });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.commandStarted, true);
    assert.equal(recovered.mayHaveStarted, true);
    assert.match(recovered.stdout, /followup-ok/u);
});

test("batch preserves startup classification for a missing cwd", async () => {
    const handler = createBatchHandler();
    const response = await handler({
        tasks: [{ command: "echo should-not-run", language: "cmd", cwd: path.join(dataRoot, "batch-missing-cwd") }],
    }, {});
    assert.equal(response.structuredContent.tasks[0].errorType, "working_directory_missing");
    assert.equal(response.structuredContent.tasks[0].commandStarted, false);
    assert.equal(response.structuredContent.tasks[0].mayHaveStarted, false);
    assert.equal(response.structuredContent.tasks[0].runMs, 0);
});

let passed = 0;
try {
    for (const { name, run } of tests) {
        await run();
        passed += 1;
        console.log(`ok ${passed} - ${name}`);
    }
    console.log(`\n${passed}/${tests.length} sandbox exec/batch integration tests passed`);
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
