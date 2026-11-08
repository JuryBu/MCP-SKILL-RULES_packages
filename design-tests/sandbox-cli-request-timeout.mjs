import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { AgentClient } from "../mcps/sandbox/dist/agent-client/client.js";
import { main } from "../mcps/sandbox/dist/agent-cli/main.js";

async function invokeCli(argumentsList) {
    let output = "";
    const sink = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
    const exitCode = await main(["info", "--json", ...argumentsList], {
        stdin: Readable.from([]), stdout: sink, stderr: sink,
    });
    return { exitCode, result: JSON.parse(output) };
}

for (const duration of [120_001, 125_000]) {
    test(`CLI forwards explicit ${duration}ms request allowance`, async context => {
        let requestCount = 0;
        context.mock.method(AgentClient.prototype, "request", async function (method) {
            requestCount += 1;
            assert.equal(method, "server.info");
            return { ok: true, data: { requestTimeoutMs: this.options.requestTimeoutMs } };
        });
        const { exitCode, result } = await invokeCli(["--timeout-ms", String(duration)]);
        assert.equal(exitCode, 0);
        assert.equal(result.data.requestTimeoutMs, duration);
        assert.equal(requestCount, 1);
    });
}

for (const duration of [0, 125_001]) {
    test(`CLI rejects request allowance ${duration}ms before contacting Core`, async context => {
        const request = context.mock.method(AgentClient.prototype, "request", async () => { throw new Error("unexpected Core request"); });
        const { exitCode, result } = await invokeCli(["--timeout-ms", String(duration)]);
        assert.equal(exitCode, 2);
        assert.equal(result.error.code, "E_CLI_USAGE");
        assert.match(result.error.message, /125000/);
        assert.equal(request.mock.callCount(), 0);
    });
}

test("CLI startup allowance retains its separate 120000ms maximum", async context => {
    const request = context.mock.method(AgentClient.prototype, "request", async function () {
        return { ok: true, data: { startupTimeoutMs: this.options.startupTimeoutMs } };
    });
    const accepted = await invokeCli(["--startup-timeout-ms", "120000"]);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.result.data.startupTimeoutMs, 120_000);
    const rejected = await invokeCli(["--startup-timeout-ms", "120001"]);
    assert.equal(rejected.exitCode, 2);
    assert.match(rejected.result.error.message, /120000/);
    assert.equal(request.mock.callCount(), 1);
});
