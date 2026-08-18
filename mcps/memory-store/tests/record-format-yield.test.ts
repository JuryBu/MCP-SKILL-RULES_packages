import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const recordGeneratorUrl = pathToFileURL(path.join(process.cwd(), "src", "record-generator.ts")).href;

const childSource = `
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { formatRoundsForRecord, formatRoundsForRecordAsync } from '__RECORD_GENERATOR_URL__';

const scenario = process.env.RECORD_FORMAT_YIELD_SCENARIO;

function makeRounds(count) {
    return Array.from({ length: count }, (_, index) => ({
        roundIndex: index + 1,
        startStep: index * 2,
        endStep: index * 2 + 1,
        userMessage: 'user-' + (index + 1),
        mediaAttachments: [],
        aiResponses: [{
            stepIndex: index * 2 + 1,
            response: 'assistant-' + (index + 1),
            thinking: '',
            toolCalls: [],
        }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    }));
}

if (scenario === 'interval') {
    const originalSetImmediate = globalThis.setImmediate;
    let immediateCalls = 0;
    globalThis.setImmediate = (callback, ...args) => {
        immediateCalls += 1;
        return originalSetImmediate(callback, ...args);
    };
    try {
        const result = await formatRoundsForRecordAsync(makeRounds(6));
        assert.equal(result.length, 6);
    } finally {
        globalThis.setImmediate = originalSetImmediate;
    }
    console.log(JSON.stringify({ immediateCalls }));
} else if (scenario === 'yield') {
    const originalSetImmediate = globalThis.setImmediate;
    let immediateCalls = 0;
    let completed = false;
    let timerRanBeforeCompletion = false;
    let ioRanBeforeCompletion = false;
    globalThis.setImmediate = (callback, ...args) => {
        immediateCalls += 1;
        return originalSetImmediate(callback, ...args);
    };
    const server = net.createServer();
    let client;
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const connection = once(server, 'connection');
        client = net.createConnection({ port: server.address().port, host: '127.0.0.1' });
        await once(client, 'connect');
        const [socket] = await connection;
        const io = new Promise(resolve => {
            socket.once('data', () => {
                ioRanBeforeCompletion = !completed;
                resolve();
            });
        });
        client.write('probe');
        setTimeout(() => {
            timerRanBeforeCompletion = !completed;
        }, 0);
        const result = await formatRoundsForRecordAsync(makeRounds(50));
        completed = true;
        await io;
        assert.equal(result.length, 50);
        assert.equal(immediateCalls, 50);
        assert.equal(timerRanBeforeCompletion, true);
        assert.equal(ioRanBeforeCompletion, true);
    } finally {
        client?.destroy();
        if (server.listening) {
            const closed = once(server, 'close');
            server.close();
            await closed;
        }
        globalThis.setImmediate = originalSetImmediate;
    }
    console.log(JSON.stringify({ immediateCalls, timerRanBeforeCompletion, ioRanBeforeCompletion }));
} else if (scenario === 'cancel') {
    let cancelled = false;
    setImmediate(() => {
        cancelled = true;
    });
    await assert.rejects(
        () => formatRoundsForRecordAsync(makeRounds(100), "auto", { isCancelled: () => cancelled }),
        error => error instanceof Error
            && /Record 更新已取消/u.test(error.message)
            && /格式化轮次 1 让步后检查到任务已终止/u.test(error.message),
    );
    console.log(JSON.stringify({ cancelled }));
} else if (scenario === 'compatibility') {
    const rounds = makeRounds(6);
    assert.deepEqual(await formatRoundsForRecordAsync(rounds), formatRoundsForRecord(rounds));
    console.log(JSON.stringify({ compatible: true }));
} else {
    throw new Error('unknown scenario: ' + scenario);
}
`.replace("__RECORD_GENERATOR_URL__", recordGeneratorUrl);

function runScenario(scenario: "interval" | "yield" | "cancel" | "compatibility", interval?: string): Record<string, unknown> {
    const env = {
        ...process.env,
        RECORD_FORMAT_YIELD_SCENARIO: scenario,
    } as NodeJS.ProcessEnv;
    if (interval === undefined) {
        delete env.MEMORY_STORE_RECORD_FORMAT_YIELD_INTERVAL;
    } else {
        env.MEMORY_STORE_RECORD_FORMAT_YIELD_INTERVAL = interval;
    }

    const encodedSource = Buffer.from(childSource, "utf8").toString("base64");
    const result = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        `--eval=await import('data:text/javascript;base64,${encodedSource}')`,
    ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
        timeout: 20_000,
    });

    assert.equal(result.error, undefined, `${scenario} child process failed to start: ${result.error?.message || "unknown error"}`);
    assert.equal(result.status, 0, `${scenario} child process failed:\n${result.stderr}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
}

for (const [interval, expectedImmediateCalls] of [
    [undefined, 1],
    ["1", 6],
    ["0", 0],
    ["NaN", 1],
    ["-3", 1],
    ["1.5", 1],
    ["Infinity", 1],
] as const) {
    const result = runScenario("interval", interval);
    assert.equal(result.immediateCalls, expectedImmediateCalls, `unexpected yield count for ${interval ?? "default"}`);
}

assert.deepEqual(runScenario("yield", "1"), {
    immediateCalls: 50,
    timerRanBeforeCompletion: true,
    ioRanBeforeCompletion: true,
});

assert.deepEqual(runScenario("cancel", "1"), { cancelled: true });
assert.deepEqual(runScenario("compatibility"), { compatible: true });

console.log("record format yield tests passed");
