import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient } from '../../../dist/agent-client/client.js';
import { RpcConnection } from '../../../dist/agent-client/connection.js';
import { readServerDescriptor } from '../../../dist/agent-server/discovery.js';
import { handshakePayload } from '../../../dist/agent-server/protocol.js';
import { captureCliBuild } from './cli-build.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliEntry = join(sourceRoot, 'dist', 'agent-cli', 'main.js');

function selectedEvidenceRoot() {
    let selected = process.env.SANDBOX_AGENT_CLI_EVIDENCE_ROOT;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--evidence-root' || argument === '--evidenceRoot') {
            const value = args[++index];
            if (!value || value.startsWith('--')) throw new Error('evidenceRoot参数需要目录');
            selected = value;
        } else if (argument.startsWith('--evidence-root=') || argument.startsWith('--evidenceRoot=')) {
            selected = argument.slice(argument.indexOf('=') + 1);
            if (!selected) throw new Error('evidenceRoot参数需要目录');
        } else throw new Error(`未知CLI验收脚本参数：${argument}`);
    }
    return selected ? resolve(selected) : undefined;
}

async function captureBuild() {
    const build = await captureCliBuild(sourceRoot);
    const testBytes = await fs.readFile(fileURLToPath(import.meta.url));
    return { ...build, testSha256: createHash('sha256').update(testBytes).digest('hex') };
}

async function writeEvidence(root, report) {
    const directory = join(root, `cli-control-${report.startedAt.replace(/[:.]/g, '-')}-${report.fixtureId}`);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(directory);
    const path = join(directory, 'report.json');
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n', 'utf8');
    await fs.writeFile(path, bytes, { flag: 'wx' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(join(directory, 'report.sha256'), `${sha256}  report.json\n`, { flag: 'wx' });
    return { path, sha256, bytes: bytes.length };
}

function errorEvidence(error) {
    return error ? { name: error.name, code: error.code, message: error.message, stack: error.stack,
        actual: error.actual, expected: error.expected, operator: error.operator } : undefined;
}

test('正式CLI在自有dataDir完成真实IPC、控制、输入队列、取消和收尾', { timeout: 120_000 }, async context => {
    const startedAt = new Date().toISOString();
    const evidenceRoot = selectedEvidenceRoot();
    const initialBuild = evidenceRoot ? await captureBuild() : undefined;
    const fixtureId = randomUUID();
    const fixture = await fs.mkdtemp(join(tmpdir(), 'sandbox-agent-cli-I1-'));
    const dataDir = join(fixture, '中文 数据目录');
    const project = join(fixture, '获准 样例项目');
    const marker = join(fixture, '.cli-fixture-owner');
    await fs.writeFile(marker, fixtureId, 'utf8');
    await fs.mkdir(project);
    await fs.writeFile(join(project, '资料.txt'), '\uFEFF这份材料只属于本次CLI fixture。\n保留中文与换行。', 'utf8');
    const deadlineAt = new Date(Date.now() + 115_000).toISOString();
    const clientIds = new Set();
    const transcript = [];
    const rawCommands = [];
    let shutdown = false;
    let completed = false;
    let terminalState;
    let cleanupState;
    let testError;

    async function cli(args, expectedCode = 0, selectedDataDir = dataDir) {
        const started = performance.now();
        const raw = { argv: ['--data-dir', selectedDataDir, '--deadline-at', deadlineAt, ...args, '--json'], startedAt: new Date().toISOString() };
        rawCommands.push(raw);
        const outcome = await new Promise((resolveChild, rejectChild) => {
            const child = spawn(process.execPath, [cliEntry, '--data-dir', selectedDataDir, '--deadline-at', deadlineAt, ...args, '--json'], {
                cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20_000);
            child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
            child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
            child.once('error', error => {
                clearTimeout(timer);
                Object.assign(raw, { stdout, stderr, elapsedMs: performance.now() - started, error: errorEvidence(error) });
                rejectChild(error);
            });
            child.once('close', (code, signal) => { clearTimeout(timer); resolveChild({ code, signal, stdout, stderr, timedOut }); });
            child.stdin.end();
        });
        Object.assign(raw, { elapsedMs: performance.now() - started, ...outcome });
        assert.equal(outcome.timedOut, false, '本任务CLI进程等待超时');
        assert.equal(outcome.signal, null, outcome.stderr);
        assert.equal(outcome.code, expectedCode, `${args.slice(0, 2).join(' ')}: ${outcome.stdout} ${outcome.stderr}`);
        assert.equal(outcome.stdout.trim().split('\n').length, 1, outcome.stdout);
        assert.equal(outcome.stdout.includes('\u001b'), false);
        const result = JSON.parse(outcome.stdout);
        assert.equal(result.exitCode, outcome.code);
        if (result.clientId && !args.includes('--client-id')) clientIds.add(result.clientId);
        transcript.push({ command: args.slice(0, 2).join(' '), code: outcome.code, ok: result.ok, errorCode: result.error?.code,
            elapsedMs: Math.round(performance.now() - started), receipt: Boolean(result.receiptId) });
        return result;
    }

    try {
        const help = await cli(['--help']);
        assert.equal(help.ok, true);
        await assert.rejects(fs.stat(join(dataDir, 'runtime')), { code: 'ENOENT' });
        await cli([], 2);
        const info = await cli(['info']);
        assert.equal(info.ok, true);
        const descriptor = await readServerDescriptor(dataDir);
        assert.equal(resolve(descriptor.dataDir), resolve(dataDir));
        if (process.platform === 'win32') assert.equal((await cli(['info'], 0, dataDir.toUpperCase())).ok, true);

        const createCommandId = randomUUID();
        const createArgs = ['conversation', 'create', '--mode', 'temporary', '--title', 'CLI中文会话', '--write-root', project, '--command-id', createCommandId];
        const created = await cli(createArgs);
        const conversationId = created.data.conversationId;
        assert.equal(typeof conversationId, 'string');
        assert.equal(created.data.retention.mode, 'temporary');
        const duplicated = await cli(createArgs);
        assert.equal(duplicated.data.conversationId, conversationId);
        assert.equal(duplicated.receiptId, created.receiptId);
        const conflictingArgs = [...createArgs];
        conflictingArgs[conflictingArgs.indexOf('CLI中文会话')] = '不同参数';
        assert.equal((await cli(conflictingArgs, 8)).error.code, 'COMMAND_CONFLICT');
        const receipt = await cli(['receipt', createCommandId]);
        assert.equal(receipt.data.found, true);
        assert.equal(receipt.data.result.receiptId, created.receiptId);

        const listed = await cli(['conversation', 'list']);
        assert.ok(listed.data.items.some(item => item.conversationId === conversationId));
        const metadata = await cli(['conversation', 'get', conversationId]);
        assert.equal(metadata.data.state, 'open');
        assert.deepEqual(metadata.data.options.writableRoots, [project]);
        assert.equal(metadata.data.options.allowSubagents, false);
        const eventPage = await cli(['events', 'read', conversationId]);
        assert.ok(eventPage.data.events.some(event => event.type === 'conversation.created'));
        assert.ok(eventPage.data.events.every(event => typeof event.eventSeq === 'string'));
        await cli(['events', 'ack', conversationId, '--applied-cursor', eventPage.data.nextCursor]);
        const noNewEvents = await cli(['events', 'read', conversationId, '--after', eventPage.data.nextCursor]);
        assert.equal(noNewEvents.data.events.length, 0);

        const budget = JSON.stringify({ wallMs: 60_000, maxModelCalls: 1, maxCostMicros: 0, currency: 'USD', costMode: 'hard' });
        const startedRun = await cli(['runs', 'start', conversationId, '--input-file', join(project, '资料.txt'), '--budget', budget]);
        const runId = startedRun.data.runId;
        const runEpoch = startedRun.data.runEpoch;
        assert.equal(startedRun.data.executorAvailable, false);
        assert.equal(startedRun.data.capability.available, false);
        assert.equal(startedRun.data.capability.reason, 'EXECUTOR_UNAVAILABLE');
        const submitted = await cli(['input', 'submit', conversationId, '--run-id', runId, '--run-epoch', String(runEpoch), '--history-epoch', String(metadata.data.historyEpoch), '--text', '下一轮的中文补充']);
        const inputs = await cli(['input', 'list', conversationId, '--run-id', runId]);
        assert.equal(inputs.data.items.filter(item => item.state === 'queued').length, 2);
        const runBeforeEdit = await cli(['runs', 'get', runId, '--conversation', conversationId]);
        const inputId = submitted.data.inputId;
        await cli(['input', 'update', inputId, '--conversation', conversationId, '--run-id', runId, '--run-epoch', String(runEpoch), '--revision', String(runBeforeEdit.data.queueRevision), '--text', '已经修改的队列正文']);
        const runBeforeRemove = await cli(['runs', 'get', runId, '--conversation', conversationId]);
        await cli(['input', 'remove', inputId, '--conversation', conversationId, '--run-id', runId, '--run-epoch', String(runEpoch), '--revision', String(runBeforeRemove.data.queueRevision)]);
        const remaining = await cli(['input', 'list', conversationId, '--run-id', runId]);
        const runBeforeReorder = await cli(['runs', 'get', runId, '--conversation', conversationId]);
        await cli(['input', 'reorder', conversationId, '--run-id', runId, '--run-epoch', String(runEpoch), '--revision', String(runBeforeReorder.data.queueRevision), '--input-ids', JSON.stringify(remaining.data.items.filter(item => item.state === 'queued').map(item => item.inputId))]);

        const observerId = `fixture-observer-${randomUUID()}`;
        await cli(['conversation', 'get', conversationId, '--client-id', observerId, '--observe']);
        const conflict = await cli(['control', 'claim', '--conversation', conversationId, '--client-id', observerId], 8);
        assert.equal(conflict.error.code, 'CONTROL_CONFLICT');
        const takeover = await cli(['control', 'claim', '--conversation', conversationId, '--client-id', observerId, '--takeover']);
        assert.ok(takeover.data.controlEpoch > created.data.controlEpoch);
        await cli(['control', 'claim', '--conversation', conversationId, '--takeover']);
        await cli(['control', 'renew', '--conversation', conversationId]);

        const library = await AgentClient.connect({ dataDir, clientId: created.clientId, descriptor });
        try {
            const firstInfo = await library.request('server.info');
            assert.equal(firstInfo.ok, true);
            const beforeClaim = await library.readEvents(conversationId);
            const commandId = randomUUID();
            const claimParams = { scope: 'conversation', conversationId, takeover: false };
            const [firstClaim, duplicateClaim] = await Promise.all([
                library.request('server.claimControl', claimParams, { clientCommandId: commandId }),
                library.request('server.claimControl', claimParams, { clientCommandId: commandId }),
            ]);
            assert.equal(firstClaim.ok, true);
            assert.equal(firstClaim.receiptId, duplicateClaim.receiptId);
            const afterClaim = await library.readEvents(conversationId, { afterCursor: beforeClaim.data.nextCursor });
            assert.equal(afterClaim.data.events.filter(event => event.type === 'control.changed').length, 1);
            await library.reconnect();
            assert.equal((await library.request('server.claimControl', claimParams, { clientCommandId: commandId })).receiptId, firstClaim.receiptId);
            assert.equal((await library.readEvents(conversationId, { afterCursor: afterClaim.data.nextCursor })).data.events.length, 0);
            const recovered = await library.getReceipt(createCommandId);
            assert.equal(recovered.data.result.receiptId, created.receiptId);
            const page = await library.readEvents(conversationId);
            const applied = [];
            const cursor = await library.eventCursor.apply(conversationId, page.data, event => { applied.push(event.eventId); });
            assert.equal((await library.ackEvents(conversationId, cursor)).ok, true);
            const subscribed = await library.subscribeEvents(conversationId, cursor);
            assert.equal(subscribed.ok, true);
            assert.equal((await library.ackEvents(conversationId, cursor, subscribed.data.subscriptionId)).ok, true);
            assert.equal((await library.unsubscribeEvents(subscribed.data.subscriptionId)).ok, true);
        } finally { await library.close(); }

        const closingClient = new AgentClient({ dataDir, clientId: `fixture-closing-${randomUUID()}`, descriptor });
        const connecting = closingClient.connect();
        await closingClient.close();
        await assert.rejects(connecting, error => error.code === 'IPC_UNAVAILABLE');

        const connection = new RpcConnection(descriptor.endpoint);
        try {
            await connection.open();
            const clientNonce = randomBytes(32).toString('base64');
            const clientId = `fixture-numeric-${randomUUID()}`;
            const hello = await connection.request('server.hello', { protocolVersion: 1, clientId, clientVersion: 'fixture-I1', capabilities: [], channel: 'control', credentialRef: descriptor.credentialRef, clientNonce }, { id: 1 });
            const secret = Buffer.from((await fs.readFile(join(dataDir, 'runtime', 'control.key'), 'utf8')).trim(), 'base64');
            const authProof = createHmac('sha256', secret).update(handshakePayload(clientNonce, hello.data.serverNonce, clientId)).digest('base64');
            secret.fill(0);
            assert.equal((await connection.request('server.authenticate', { clientId, authProof }, { id: 'auth' })).ok, true);
            assert.equal((await connection.request('server.info', {}, { id: 2 })).ok, true);
        } finally { connection.close(); }

        const cancelled = await cli(['cancel', runId, '--conversation', conversationId, '--run-epoch', String(runEpoch)]);
        assert.ok(cancelled.receiptId);
        let finalRun;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            finalRun = await cli(['runs', 'get', runId, '--conversation', conversationId]);
            if (finalRun.data.state === 'cancelled' && ['released', 'not_needed'].includes(finalRun.data.cleanupState)) break;
            await delay(25);
        }
        assert.equal(finalRun.data.state, 'cancelled');
        assert.ok(['released', 'not_needed'].includes(finalRun.data.cleanupState));
        terminalState = finalRun.data.state;
        cleanupState = finalRun.data.cleanupState;
        const closeCommandId = randomUUID();
        await cli(['conversation', 'close', conversationId, '--command-id', closeCommandId]);
        const closeReceipt = await cli(['receipt', closeCommandId, '--conversation', conversationId]);
        assert.equal(closeReceipt.data.found, true);
        assert.equal((await cli(['conversation', 'get', conversationId], 6)).error.code, 'TEMPORARY_GONE');
        assert.equal(clientIds.size, 1, '短CLI进程必须使用稳定clientId');
        await cli(['shutdown', '--mode', 'cancel', '--grace-ms', '1000']);
        shutdown = true;
        for (let attempt = 0; attempt < 30 && await readServerDescriptor(dataDir); attempt += 1) await delay(50);
        assert.equal(await readServerDescriptor(dataDir), null);
        completed = true;
    } catch (error) {
        testError = error;
        throw error;
    } finally {
        let cleanupError;
        let evidenceError;
        let fixtureRemoved = false;
        let serverClosed = false;
        try {
            const descriptor = await readServerDescriptor(dataDir).catch(() => null);
            if (!shutdown && descriptor && resolve(descriptor.dataDir) === resolve(dataDir)) {
                const client = await AgentClient.connect({ dataDir, descriptor, clientId: `fixture-cleanup-${fixtureId}` }).catch(() => null);
                if (client) {
                    try {
                        await client.claimControl('server', undefined, true);
                        await client.request('server.shutdown', { mode: 'cancel', graceMs: 0 });
                    } finally { await client.close(); }
                }
                for (let attempt = 0; attempt < 30 && await readServerDescriptor(dataDir).catch(() => null); attempt += 1) await delay(50);
            }
            const remainingDescriptor = await readServerDescriptor(dataDir).catch(() => null);
            serverClosed = remainingDescriptor === null;
            if (remainingDescriptor) throw new Error(`本任务核心未确认关闭，保留fixture：${fixture}`);
            assert.equal(await fs.readFile(marker, 'utf8'), fixtureId);
            assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
            assert.ok(fixture.startsWith(join(tmpdir(), 'sandbox-agent-cli-I1-')));
            await fs.rm(fixture, { recursive: true, force: true });
            fixtureRemoved = true;
        } catch (error) { cleanupError = error; }
        const summary = { completed, realCliCommands: rawCommands.length, stableClientIds: clientIds.size,
            actualProviderRequests: 0, fixtureScopeOnly: true, runState: terminalState, cleanupState, serverClosed, fixtureRemoved };
        context.diagnostic(JSON.stringify({ ...summary, transcript, cleanupError: errorEvidence(cleanupError) }));
        if (evidenceRoot) {
            try {
                const finalBuild = await captureBuild();
                const sameBuild = initialBuild.fingerprint === finalBuild.fingerprint && initialBuild.testSha256 === finalBuild.testSha256;
                const evidence = await writeEvidence(evidenceRoot, {
                    schemaVersion: 1, type: 'sandbox-agent-cli-e2e', fixtureId, startedAt, finishedAt: new Date().toISOString(),
                    environment: { node: process.version, platform: process.platform, arch: process.arch },
                    fixture: { path: fixture, dataDir, project }, summary, commands: rawCommands,
                    build: { sameBuild, initial: initialBuild, final: finalBuild },
                    verdict: { passed: completed && !testError && !cleanupError && sameBuild },
                    error: errorEvidence(testError), cleanupError: errorEvidence(cleanupError),
                });
                context.diagnostic(JSON.stringify({ type: 'cli.evidence', ...evidence }));
                if (!sameBuild) throw new Error('验收期间构建或测试脚本发生变化，原始记录已保留，请用固定版本验收');
            } catch (error) {
                evidenceError = error;
                context.diagnostic(JSON.stringify({ type: 'cli.evidence.error', error: errorEvidence(error) }));
            }
        }
        if (!testError && (cleanupError || evidenceError)) throw cleanupError ?? evidenceError;
    }
});
