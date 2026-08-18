import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-agy-client-"));
const logPath = path.join(temporaryRoot, "fake-agy.jsonl");
const fixturePath = path.resolve("tests/fixtures/fake-agy-cli.mjs");

interface FakeAgyEvent {
    args: string[];
    model: string;
    prompt: string;
    startedAt: number;
}

function fakeOptions(mode: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return {
        command: process.execPath,
        commandArgs: [fixturePath],
        env: {
            ...process.env,
            ...extraEnv,
            FAKE_AGY_LOG: logPath,
            FAKE_AGY_MODE: mode,
        },
    };
}

function readEvents(): FakeAgyEvent[] {
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as FakeAgyEvent);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return !isProcessAlive(pid);
}

async function main(): Promise<void> {
    const {
        AGY_MODEL_SEQUENCE,
        AGY_MAX_PROMPT_UTF16_CODE_UNITS,
        AGY_PROBE_PROMPT,
        AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS,
        callAgyModel,
        callAgyWithFallback,
        getAgyTerminationPolicy,
        measureAgyWindowsCommandLineUtf16CodeUnits,
        probeAgy,
    } = await import("../src/agy-client.ts");
    const {
        configureProviderTransportAdapterForTest,
        resetProviderTransportAdapterForTest,
    } = await import("../src/provider-transport-adapter.ts");
    await configureProviderTransportAdapterForTest({ mode: "shadow" });

    let eventOffset = 0;
    const newEvents = () => {
        const events = readEvents().slice(eventOffset);
        eventOffset += events.length;
        return events;
    };

    try {
        const chineseLongPrompt = "中文提示🐱，这一段只作为一个 shell:false argv 元素传入。\n".repeat(500);
        const success = await callAgyModel(chineseLongPrompt, AGY_MODEL_SEQUENCE[0], fakeOptions("success"));
        assert.equal(success.text, `ok:${AGY_MODEL_SEQUENCE[0]}:${Buffer.byteLength(chineseLongPrompt, "utf8")}`);
        assert.equal(success.exitCode, 0);
        assert.equal(success.failureClass, undefined);
        const [successEvent] = newEvents();
        assert.equal(successEvent.prompt, chineseLongPrompt);
        assert.deepEqual(successEvent.args, ["-p", chineseLongPrompt, "--sandbox", "--model", AGY_MODEL_SEQUENCE[0]]);
        assert.equal(successEvent.args.includes("--dangerously-skip-permissions"), false);

        const quotedPrompt = "中文 \"引号\" & echo should-not-run 🐱";
        const quoted = await callAgyModel(quotedPrompt, AGY_MODEL_SEQUENCE[0], fakeOptions("success"));
        assert.equal(quoted.text, `ok:${AGY_MODEL_SEQUENCE[0]}:${Buffer.byteLength(quotedPrompt, "utf8")}`);
        assert.equal(newEvents()[0].prompt, quotedPrompt);

        for (const rejectedArgument of [
            "--dangerously-skip-permissions",
            "--dangerously-skip-permissions=true",
            "-p",
            "--print=override",
            "--prompt",
            "--model=override",
            "--sandbox=false",
            "--help",
        ]) {
            const rejected = await callAgyModel("must not spawn", AGY_MODEL_SEQUENCE[0], {
                ...fakeOptions("success"),
                commandArgs: [fixturePath, rejectedArgument],
            });
            assert.equal(rejected.text, null, rejectedArgument);
            assert.equal(rejected.launched, false, rejectedArgument);
            assert.equal(rejected.failureClass, "DeterministicInput", rejectedArgument);
            assert.match(rejected.error || "", /commandArgs/u, rejectedArgument);
            assert.equal(newEvents().length, 0, rejectedArgument);
        }

        const overlong = await callAgyModel("🐱".repeat(Math.ceil((AGY_MAX_PROMPT_UTF16_CODE_UNITS + 2) / 2)), AGY_MODEL_SEQUENCE[0], fakeOptions("success"));
        assert.equal(overlong.text, null);
        assert.equal(overlong.launched, false);
        assert.equal(overlong.failureClass, "DeterministicInput");
        assert.match(overlong.error || "", /UTF-16/u);
        assert.equal(newEvents().length, 0);

        const trailingBackslashArgument = "C:\\fixture path\\";
        assert.equal(
            measureAgyWindowsCommandLineUtf16CodeUnits("agy.exe", [trailingBackslashArgument]),
            "agy.exe".length + trailingBackslashArgument.length + 5,
        );

        const boundaryPrompt = "budget boundary";
        const boundaryBaseArgs = [
            fixturePath,
            "",
            "-p", boundaryPrompt,
            "--sandbox",
            "--model", AGY_MODEL_SEQUENCE[0],
        ];
        const boundaryFillerLength = AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS
            - measureAgyWindowsCommandLineUtf16CodeUnits(process.execPath, boundaryBaseArgs)
            + 2;
        assert.ok(boundaryFillerLength > 0);
        const boundaryFiller = "x".repeat(boundaryFillerLength);
        const boundaryArgs = [
            fixturePath,
            boundaryFiller,
            "-p", boundaryPrompt,
            "--sandbox",
            "--model", AGY_MODEL_SEQUENCE[0],
        ];
        assert.equal(
            measureAgyWindowsCommandLineUtf16CodeUnits(process.execPath, boundaryArgs),
            AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS,
        );
        if (process.platform === "win32") {
            const atBoundary = await callAgyModel(boundaryPrompt, AGY_MODEL_SEQUENCE[0], {
                ...fakeOptions("success"),
                commandArgs: [fixturePath, boundaryFiller],
                timeoutMs: 3_000,
            });
            assert.notEqual(atBoundary.text, null);
            newEvents();
            const overBoundary = await callAgyModel(boundaryPrompt, AGY_MODEL_SEQUENCE[0], {
                ...fakeOptions("success"),
                commandArgs: [fixturePath, `${boundaryFiller}x`],
                timeoutMs: 3_000,
            });
            assert.equal(overBoundary.text, null);
            assert.equal(overBoundary.launched, false);
            assert.equal(overBoundary.failureClass, "DeterministicInput");
            assert.match(overBoundary.error || "", /Windows 命令行/u);
            assert.equal(newEvents().length, 0);
        }

        const fallback = await callAgyWithFallback("fallback prompt", fakeOptions("fallback"));
        assert.equal(fallback.text, `ok:${AGY_MODEL_SEQUENCE[1]}:${Buffer.byteLength("fallback prompt", "utf8")}`);
        assert.equal(fallback.model, AGY_MODEL_SEQUENCE[1]);
        assert.deepEqual(fallback.attempts.map(attempt => attempt.model), AGY_MODEL_SEQUENCE.slice(0, 2));
        assert.deepEqual(newEvents().map(event => event.model), AGY_MODEL_SEQUENCE.slice(0, 2));

        const exhausted = await callAgyWithFallback("all models fail", fakeOptions("fail-all"));
        assert.equal(exhausted.text, null);
        assert.equal(exhausted.model, AGY_MODEL_SEQUENCE[2]);
        assert.equal(exhausted.failureClass, "DeterministicInput");
        assert.deepEqual(exhausted.attempts.map(attempt => attempt.model), AGY_MODEL_SEQUENCE);
        assert.deepEqual(newEvents().map(event => event.model), AGY_MODEL_SEQUENCE);

        const partial = await callAgyModel("partial", AGY_MODEL_SEQUENCE[0], fakeOptions("partial-failure"));
        assert.equal(partial.text, null);
        assert.equal(partial.exitCode, 17);
        assert.equal(partial.stdout, "partial response");
        assert.match(partial.stderr, /rate limit/u);
        assert.equal(partial.failureClass, "Congestion");
        newEvents();

        const empty = await callAgyModel("empty", AGY_MODEL_SEQUENCE[0], fakeOptions("empty"));
        assert.equal(empty.text, null);
        assert.equal(empty.failureClass, "Quality");
        assert.match(empty.error || "", /输出为空/u);
        newEvents();

        const overflow = await callAgyModel("overflow", AGY_MODEL_SEQUENCE[0], {
            ...fakeOptions("overflow", { FAKE_AGY_DELAY_MS: "1000" }),
            maxOutputBytes: 64,
            timeoutMs: 2_000,
        });
        assert.equal(overflow.text, null);
        assert.equal(overflow.truncated, true);
        assert.equal(overflow.failureClass, "Complexity");
        assert.ok(Buffer.byteLength(overflow.stdout, "utf8") <= 64);
        newEvents();

        const dualOverflow = await callAgyModel("dual overflow", AGY_MODEL_SEQUENCE[0], {
            ...fakeOptions("dual-overflow", { FAKE_AGY_DELAY_MS: "1000" }),
            maxOutputBytes: 64,
            timeoutMs: 2_000,
        });
        assert.equal(dualOverflow.text, null);
        assert.equal(dualOverflow.truncated, true);
        assert.equal(dualOverflow.failureClass, "Complexity");
        assert.ok(Buffer.byteLength(dualOverflow.stdout, "utf8") > 0);
        assert.ok(Buffer.byteLength(dualOverflow.stderr, "utf8") > 0);
        assert.ok(Buffer.byteLength(dualOverflow.stdout, "utf8") + Buffer.byteLength(dualOverflow.stderr, "utf8") <= 64);
        newEvents();

        const timeout = await callAgyModel("timeout", AGY_MODEL_SEQUENCE[0], {
            ...fakeOptions("delay", { FAKE_AGY_DELAY_MS: "5000" }),
            timeoutMs: 40,
        });
        assert.equal(timeout.text, null);
        assert.equal(timeout.timedOut, true);
        assert.equal(timeout.failureClass, "UnknownOutcome");
        newEvents();

        const controller = new AbortController();
        const abortedPromise = callAgyModel("abort", AGY_MODEL_SEQUENCE[0], {
            ...fakeOptions("delay", { FAKE_AGY_DELAY_MS: "5000" }),
            timeoutMs: 2_000,
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 40).unref?.();
        const aborted = await abortedPromise;
        assert.equal(aborted.text, null);
        assert.equal(aborted.cancelled, true);
        assert.equal(aborted.failureClass, "UnknownOutcome");
        newEvents();

        const posixPolicy = getAgyTerminationPolicy("linux");
        assert.equal(posixPolicy.strategy, "posix_process_group");
        if (posixPolicy.strategy === "posix_process_group") {
            assert.equal(posixPolicy.termSignal, "SIGTERM");
            assert.equal(posixPolicy.killSignal, "SIGKILL");
            assert.ok(posixPolicy.graceMs > 0 && Number.isFinite(posixPolicy.graceMs));
        }
        if (process.platform !== "win32") {
            const descendantPidPath = path.join(temporaryRoot, "ignore-term-descendant.pid");
            const previousGrace = process.env.MEMORY_STORE_AGY_TERM_GRACE_MS;
            process.env.MEMORY_STORE_AGY_TERM_GRACE_MS = "100";
            try {
                const ignoredTerm = await callAgyModel("ignore term", AGY_MODEL_SEQUENCE[0], {
                    ...fakeOptions("ignore-term-tree", { FAKE_AGY_DESCENDANT_PID: descendantPidPath }),
                    timeoutMs: 200,
                });
                assert.equal(ignoredTerm.timedOut, true);
                assert.equal(fs.existsSync(descendantPidPath), true);
                const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
                assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
                assert.equal(await waitForProcessExit(descendantPid, 2_000), true);
                newEvents();
            } finally {
                if (previousGrace === undefined) delete process.env.MEMORY_STORE_AGY_TERM_GRACE_MS;
                else process.env.MEMORY_STORE_AGY_TERM_GRACE_MS = previousGrace;
            }
        }

        const missing = await callAgyModel("missing", AGY_MODEL_SEQUENCE[0], {
            command: path.join(temporaryRoot, "not-installed-agy.exe"),
            timeoutMs: 500,
        });
        assert.equal(missing.text, null);
        assert.equal(missing.launched, false);
        assert.equal(missing.failureClass, "Availability");

        const probe = await probeAgy(fakeOptions("success"));
        assert.equal(probe.available, true);
        assert.equal(probe.result.model, AGY_MODEL_SEQUENCE[0]);
        const [probeEvent] = newEvents();
        assert.equal(probeEvent.prompt, AGY_PROBE_PROMPT);
        assert.equal(probeEvent.model, AGY_MODEL_SEQUENCE[0]);

        const startedAt = Date.now();
        const concurrent = await Promise.all(Array.from({ length: 3 }, () => callAgyModel("parallel", AGY_MODEL_SEQUENCE[0], {
            ...fakeOptions("delay", { FAKE_AGY_DELAY_MS: "250" }),
            timeoutMs: 2_000,
        })));
        assert.ok(concurrent.every(result => result.text !== null));
        assert.ok(Date.now() - startedAt < 700, "agy client must not serialize independent calls");
        assert.equal(newEvents().length, 3);
    } finally {
        await resetProviderTransportAdapterForTest();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

await main();
console.log("agy client tests passed");
