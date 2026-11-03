import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';

const sourceUrl = new URL('../../../src/agent-server/discovery.ts', import.meta.url);
const protocolUrl = new URL('../../../src/agent-server/protocol.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const protocolSource = await readFile(protocolUrl, 'utf8');
const protocolTree = ts.createSourceFile('protocol.ts', protocolSource, ts.ScriptTarget.ES2022, true);
const protocolFixture = protocolTree.statements.filter(statement =>
    ts.isClassDeclaration(statement) && statement.name?.text === 'AgentFault'
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === 'PROTOCOL_VERSION'))
    .map(statement => statement.getText(protocolTree)).join('\n');
const transpile = (text, fileName) => ts.transpileModule(text, {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const discoveryCode = transpile(source, 'discovery.ts');
const protocolCode = transpile(protocolFixture, 'protocol.ts');

async function startupFixture() {
    const dataDir = resolve(dirname(fileURLToPath(sourceUrl)), 'ordinary-startup-fixture');
    const descriptorPath = join(dataDir, 'runtime', 'server.json');
    const serverEntry = join(dataDir, 'fixture-entry.mjs');
    const state = { descriptor: null, livePids: new Set(), endpointReady: false, childPid: 202,
        now: 1000, waits: 0, spawns: [], probes: [], reads: [], directories: [], unrefs: 0,
        entryMissing: false, spawnError: null, onWait: null, onSpawn: null, onProbe: null };
    const missing = () => Object.assign(new Error('ordinary fixture entry is absent'), { code: 'ENOENT' });
    const unused = () => { throw new Error('This startup fixture does not initialize a runtime'); };
    const fixtureFs = {
        async stat(path) {
            assert.equal(path, descriptorPath);
            if (!state.descriptor) throw missing();
            return { size: Buffer.byteLength(JSON.stringify(state.descriptor)) };
        },
        async readFile(path, encoding) {
            assert.equal(path, descriptorPath);
            assert.equal(encoding, 'utf8');
            state.reads.push(state.descriptor?.serverInstanceId ?? null);
            if (!state.descriptor) throw missing();
            return JSON.stringify(state.descriptor);
        },
        async access(path) {
            assert.equal(path, serverEntry);
            if (state.entryMissing) throw missing();
        },
        async mkdir(path) {
            assert.equal(path, join(dataDir, 'runtime'));
            state.directories.push(path);
        },
    };
    const processFixture = { platform: process.platform, env: {}, execPath: 'ordinary-fixture-node',
        kill(pid, signal) {
            assert.equal(signal, 0);
            if (!state.livePids.has(pid)) throw Object.assign(new Error('ordinary fixture process exited'), { code: 'ESRCH' });
        } };
    class FixtureDate extends Date {
        static now() { return state.now; }
    }
    const context = createContext({ Buffer, process: processFixture, Date: FixtureDate,
        setTimeout(callback, milliseconds) {
            assert.equal(milliseconds, 50);
            state.now += milliseconds;
            state.waits++;
            state.onWait?.(state);
            queueMicrotask(callback);
        } });
    const dependencies = new Map([
        ['node:crypto', { createHash, randomBytes: unused, randomUUID: unused }],
        ['node:fs', { promises: fixtureFs }],
        ['node:path', { join, resolve, dirname }],
        ['node:os', { homedir: unused, tmpdir: () => dataDir }],
        ['node:url', { fileURLToPath }],
        ['node:child_process', { execFileSync: unused, spawn(executable, args, options) {
            state.spawns.push({ executable, args, options });
            state.livePids.add(state.childPid);
            const child = new EventEmitter();
            child.pid = state.childPid;
            child.unref = () => { state.unrefs++; };
            state.onSpawn?.(state, child);
            if (state.spawnError) queueMicrotask(() => child.emit('error', state.spawnError));
            return child;
        } }],
        ['node:net', { connect(endpoint) {
            state.probes.push({ endpoint, serverInstanceId: state.descriptor?.serverInstanceId });
            const socket = new EventEmitter();
            socket.destroy = () => {};
            socket.setTimeout = milliseconds => { assert.equal(milliseconds, 250); };
            queueMicrotask(() => {
                state.onProbe?.(state);
                socket.emit(state.endpointReady ? 'connect' : 'error');
            });
            return socket;
        } }],
    ]);
    const module = new SourceTextModule(discoveryCode, { context, identifier: sourceUrl.href,
        initializeImportMeta(meta) { meta.url = sourceUrl.href; } });
    await module.link(specifier => {
        if (specifier === './protocol.js') return new SourceTextModule(protocolCode, { context });
        assert.ok(dependencies.has(specifier), `Unexpected startup dependency: ${specifier}`);
        const exports = dependencies.get(specifier);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    return { state,
        descriptor(pid, serverInstanceId) {
            return { schemaVersion: 1, protocolVersion: 1, serverVersion: 'ordinary-fixture', pid,
                serverInstanceId, endpoint: module.namespace.endpointFor(dataDir), dataDir,
                processStartedAt: '2026-01-01T00:00:00.000Z', principalId: 'ordinary-fixture',
                credentialRef: join(dataDir, 'runtime', 'fixture-key-reference') };
        },
        ensure(options = {}) {
            return module.namespace.ensureAgentServer({ dataDir, serverEntry, startupTimeoutMs: 200, ...options });
        } };
}

test('ordinary startup reuses the current published live process without spawning', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'already-running');
    fixture.state.livePids.add(101);
    fixture.state.endpointReady = true;
    const result = await fixture.ensure();
    assert.equal(result.serverInstanceId, 'already-running');
    assert.equal(fixture.state.spawns.length, 0);
});

test('ordinary restart waits when a new listener precedes descriptor publication on entry', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'previous-instance');
    fixture.state.endpointReady = true;
    fixture.state.onWait = state => { state.descriptor = fixture.descriptor(state.childPid, 'restarted-instance'); };
    const result = await fixture.ensure();
    assert.equal(result.serverInstanceId, 'restarted-instance');
    assert.equal(fixture.state.spawns.length, 1);
    assert.equal(fixture.state.waits, 1);
});

test('ordinary child listen before publish keeps polling the retained descriptor', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'previous-instance');
    fixture.state.onSpawn = state => { state.endpointReady = true; };
    fixture.state.onWait = state => {
        if (state.waits === 2) state.descriptor = fixture.descriptor(state.childPid, 'child-published');
    };
    const result = await fixture.ensure();
    assert.equal(result.serverInstanceId, 'child-published');
    assert.equal(fixture.state.waits, 2);
    assert.equal(fixture.state.unrefs, 1);
});

test('ordinary PID reuse still waits for the child to publish its new instance', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'previous-instance');
    fixture.state.childPid = 101;
    fixture.state.onSpawn = state => { state.endpointReady = true; };
    fixture.state.onWait = state => { state.descriptor = fixture.descriptor(state.childPid, 'child-published'); };
    const result = await fixture.ensure();
    assert.equal(result.serverInstanceId, 'child-published');
    assert.equal(fixture.state.waits, 1);
});

test('ordinary concurrent startup accepts the published winner even when its PID differs from the child', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'previous-instance');
    fixture.state.onSpawn = (state, child) => {
        state.livePids.delete(state.childPid);
        state.livePids.add(303);
        state.endpointReady = true;
        queueMicrotask(() => child.emit('exit', 1));
    };
    fixture.state.onWait = state => { state.descriptor = fixture.descriptor(303, 'concurrent-winner'); };
    const result = await fixture.ensure();
    assert.equal(result.serverInstanceId, 'concurrent-winner');
    assert.equal(result.pid, 303);
    assert.equal(fixture.state.spawns.length, 1);
});

test('ordinary first startup waits for a descriptor even after listen is ready', async () => {
    const fixture = await startupFixture();
    fixture.state.onSpawn = state => { state.endpointReady = true; };
    fixture.state.onWait = state => {
        if (state.waits === 2) state.descriptor = fixture.descriptor(state.childPid, 'first-instance');
    };
    assert.equal((await fixture.ensure()).serverInstanceId, 'first-instance');
    assert.equal(fixture.state.waits, 2);
});

test('ordinary quick restart skips a published process that already exited', async () => {
    const fixture = await startupFixture();
    fixture.state.onSpawn = state => {
        state.descriptor = fixture.descriptor(303, 'brief-instance');
        state.endpointReady = true;
    };
    fixture.state.onWait = state => { state.descriptor = fixture.descriptor(state.childPid, 'current-instance'); };
    assert.equal((await fixture.ensure()).serverInstanceId, 'current-instance');
    assert.equal(fixture.state.waits, 1);
});

test('ordinary process exit during the endpoint probe triggers fresh discovery', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'exiting-instance');
    fixture.state.livePids.add(101);
    fixture.state.endpointReady = true;
    fixture.state.onProbe = state => { state.livePids.delete(101); };
    fixture.state.onWait = state => { state.descriptor = fixture.descriptor(state.childPid, 'current-instance'); };
    assert.equal((await fixture.ensure()).serverInstanceId, 'current-instance');
    assert.equal(fixture.state.spawns.length, 1);
});

test('ordinary descriptor replacement during a probe waits for the current publication', async () => {
    const fixture = await startupFixture();
    fixture.state.onSpawn = state => {
        state.descriptor = fixture.descriptor(state.childPid, 'brief-publication');
        state.endpointReady = true;
    };
    fixture.state.onProbe = state => { state.descriptor = fixture.descriptor(state.childPid, 'current-publication'); };
    assert.equal((await fixture.ensure()).serverInstanceId, 'current-publication');
    assert.equal(fixture.state.waits, 1);
});

test('ordinary live process with an unavailable endpoint is preserved without a new child', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'existing-instance');
    fixture.state.livePids.add(101);
    await assert.rejects(fixture.ensure(), error => error.code === 'SERVER_UNAVAILABLE' && error.details.pid === 101);
    assert.equal(fixture.state.spawns.length, 0);
    assert.equal(fixture.state.directories.length, 0);
});

test('ordinary unpublished restart times out once and preserves its original descriptor', async () => {
    const fixture = await startupFixture();
    fixture.state.descriptor = fixture.descriptor(101, 'retained-instance');
    fixture.state.onSpawn = state => { state.endpointReady = true; };
    await assert.rejects(fixture.ensure({ startupTimeoutMs: 100 }), error => error.code === 'SERVER_START_TIMEOUT'
        && error.details.pid === fixture.state.childPid && error.mayHaveStarted && error.retryable);
    assert.equal(fixture.state.descriptor.serverInstanceId, 'retained-instance');
    assert.equal(fixture.state.spawns.length, 1);
    assert.equal(fixture.state.waits, 2);
});

test('ordinary spawn failure keeps the original start error without retrying', async () => {
    const fixture = await startupFixture();
    fixture.state.spawnError = new Error('ordinary child start failed');
    await assert.rejects(fixture.ensure(), error => error.code === 'SERVER_START_FAILED'
        && error.details.cause === 'ordinary child start failed');
    assert.equal(fixture.state.spawns.length, 1);
});

test('ordinary missing server entry retains the build-required result without spawning', async () => {
    const fixture = await startupFixture();
    fixture.state.entryMissing = true;
    await assert.rejects(fixture.ensure(), error => error.code === 'AGENT_BUILD_REQUIRED');
    assert.equal(fixture.state.spawns.length, 0);
});
