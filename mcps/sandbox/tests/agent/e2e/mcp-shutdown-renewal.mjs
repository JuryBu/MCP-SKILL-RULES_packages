import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argument = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};
assert.ok(argument('--evidence-root'), '--evidence-root is required');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = resolve(argument('--runtime-root') ?? sourceRoot);
const root = resolve(argument('--evidence-root'), 'shutdown-renewal-' + randomUUID());
const dataDir = join(root, 'agent-state');
const temporary = join(root, 'temporary');
await mkdir(temporary, { recursive: true });
const { readServerDescriptor } = await import(pathToFileURL(join(runtime, 'dist/agent-server/discovery.js')).href);
const { AgentClient } = await import(pathToFileURL(join(runtime, 'dist/agent-client/client.js')).href);
const report = { startedAt: new Date().toISOString(), runtime, root, dataDir, passed: false, modelRequests: 0, calls: [], cycles: [], cleanup: {} };
const save = () => writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const transport = new StdioClientTransport({ command: process.execPath, args: [join(runtime, 'dist/index.js')], cwd: runtime, stderr: 'pipe', env: {
    SANDBOX_DATA_ROOT: join(root, 'sandbox-data'), SANDBOX_AGENT_HOME: dataDir,
    SANDBOX_LAUNCH_DIR: join(root, 'launches'), SANDBOX_BG_TASKS_DIR: join(root, 'background'),
    SANDBOX_COUNCIL_TASK_ROOT: join(root, 'council'), SANDBOX_COUNCIL_AUTO_GC: '0',
    SANDBOX_ENABLE_DUPLICATE_RETIREMENT: '0', TEMP: temporary, TMP: temporary,
} });
const client = new Client({ name: 'owned-shutdown-renewal-check', version: '1.0.0' });
const callerConversationId = randomUUID();
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
const call = async (action, params = {}) => {
    const entry = { action, params, startedAt: new Date().toISOString() };
    report.calls.push(entry);
    const raw = await client.callTool({ name: 'sandbox_agent', arguments: { action, params, callerHost: 'other', callerConversationId } });
    const result = raw.structuredContent ?? JSON.parse(raw.content.find(item => item.type === 'text').text);
    entry.result = result;
    entry.finishedAt = new Date().toISOString();
    await save();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
};
try {
    const source = await readFile(join(runtime, 'dist/agent-client/client.js'));
    report.clientSourceSha256 = createHash('sha256').update(source).digest('hex');
    await client.connect(transport);
    report.mcpPid = transport.pid;
    for (const label of ['first', 'explicit-cold-reopen']) {
        await call('server.info');
        const descriptor = await readServerDescriptor(dataDir);
        assert.ok(descriptor);
        const cycle = { label, pid: descriptor.pid, serverInstanceId: descriptor.serverInstanceId, samples: [] };
        report.cycles.push(cycle);
        if (report.cycles.length > 1) assert.notEqual(cycle.serverInstanceId, report.cycles[0].serverInstanceId);
        await call('server.shutdown', { clientCommandId: randomUUID(), mode: 'drain', graceMs: 1000 });
        const started = Date.now();
        while (Date.now() - started < 35000) {
            await delay(500);
            const current = await readServerDescriptor(dataDir);
            cycle.samples.push({ afterMs: Date.now() - started, oldPidAlive: alive(cycle.pid), descriptor: current ? { pid: current.pid, serverInstanceId: current.serverInstanceId } : null });
            await save();
        }
        cycle.observedMs = Date.now() - started;
        assert.equal(alive(cycle.pid), false, 'The original owned Core did not exit');
        assert.equal(await readServerDescriptor(dataDir), null, 'An idle renewal recreated a Core after explicit shutdown');
        assert.ok(cycle.samples.filter(sample => sample.afterMs >= 3000).every(sample => sample.descriptor === null));
        cycle.passed = true;
    }
    report.passed = true;
} catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
    await client.close().catch(error => { report.cleanup.clientCloseError = error.message; });
    const remaining = await readServerDescriptor(dataDir).catch(() => null);
    if (remaining) {
        const recovery = await AgentClient.connect({ dataDir, descriptor: remaining, clientId: 'owned-shutdown-recovery-' + randomUUID() });
        try { report.cleanup.ownedRecoveryShutdown = await recovery.request('server.shutdown', { clientCommandId: randomUUID(), mode: 'drain', graceMs: 1000 }); }
        finally { await recovery.close(); }
    }
    for (let attempt = 0; attempt < 80 && await readServerDescriptor(dataDir); attempt++) await delay(100);
    report.cleanup.descriptorGone = await readServerDescriptor(dataDir) === null;
    report.cleanup.mcpExited = !report.mcpPid || !alive(report.mcpPid);
    report.finishedAt = new Date().toISOString();
    if (!report.cleanup.descriptorGone || !report.cleanup.mcpExited) report.passed = false;
    await writeFile(join(root, 'mcp-stderr.txt'), stderr);
    await save();
}
console.log(JSON.stringify({ passed: report.passed, error: report.error, cycles: report.cycles.map(cycle => ({ label: cycle.label, pid: cycle.pid, observedMs: cycle.observedMs, passed: cycle.passed })), modelRequests: 0, cleanup: report.cleanup, result: join(root, 'result.json') }));
process.exitCode = report.passed ? 0 : 1;
