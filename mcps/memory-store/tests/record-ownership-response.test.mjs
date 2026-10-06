import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const sourceRootArgument = process.argv.indexOf('--sourceRoot');
assert.ok(sourceRootArgument < 0 || process.argv[sourceRootArgument + 1], '--sourceRoot requires a path');
const sourceRoot = path.resolve(sourceRootArgument < 0 ? path.join(path.dirname(scriptPath), '..') : process.argv[sourceRootArgument + 1]);
const sdkRoot = path.join(sourceRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
const signalPrefix = 'OWNERSHIP_TEST ';
const requestTimeoutMs = 15000;
const concurrentTimeoutMs = 1000;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertInside(root, target) {
    const relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `outside fixture: ${target}`);
}

function workspaceHash(workspace) {
    const normalized = path.win32.normalize(workspace.replace(/\//g, '\\').replace(/^\\\\\?\\/u, '')).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
    return sha256(normalized).slice(0, 8);
}

function writeJson(target, value) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}

function isolatedEnvironment(fixture) {
    const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return {
        ...environment,
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        HOMEDRIVE: path.parse(fixture.home).root.replace(/[\\/]$/u, ''),
        HOMEPATH: fixture.home.slice(path.parse(fixture.home).root.length - 1),
        APPDATA: fixture.appData,
        LOCALAPPDATA: fixture.localAppData,
        TEMP: fixture.runtimeTemp,
        TMP: fixture.runtimeTemp,
        TMPDIR: fixture.runtimeTemp,
        XDG_CONFIG_HOME: path.join(fixture.home, '.config'),
        XDG_DATA_HOME: path.join(fixture.home, '.local', 'share'),
        XDG_CACHE_HOME: path.join(fixture.home, '.cache'),
        CODEX_HOME: fixture.codexHome,
        CLAUDE_HOME: fixture.claudeHome,
        CLAUDE_CONFIG_DIR: fixture.claudeHome,
        MEMORY_STORE_CLAUDE_HOME: fixture.claudeHome,
        MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS: fixture.desktopRoot,
        MEMORY_STORE_DATA_ROOT: fixture.dataRoot,
        MEMORY_STORE_AGY_AUTO_ENABLED: '0',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        NO_COLOR: '1',
        USERNAME: 'synthetic',
        USER: 'synthetic',
        LOGNAME: 'synthetic',
    };
}

async function serve() {
    const manifestArgument = process.argv.indexOf('--fixture');
    assert.ok(manifestArgument >= 0 && process.argv[manifestArgument + 1]);
    const fixture = JSON.parse(fs.readFileSync(process.argv[manifestArgument + 1], 'utf8'));
    assertInside(fixture.tempBase, fixture.root);
    assert.equal(path.dirname(fixture.root), fixture.tempBase);
    assert.ok(path.basename(fixture.root).startsWith('memory-store-ownership-response-'));
    for (const target of [fixture.home, fixture.dataRoot, fixture.codexHome, fixture.claudeHome, fixture.desktopRoot, fixture.appData, fixture.localAppData, fixture.runtimeTemp]) assertInside(fixture.root, target);
    Object.assign(process.env, isolatedEnvironment(fixture));
    assert.equal(os.homedir(), fixture.home);
    const { McpServer } = await import(pathToFileURL(path.join(sdkRoot, 'server', 'mcp.js')).href);
    const { StdioServerTransport } = await import(pathToFileURL(path.join(sdkRoot, 'server', 'stdio.js')).href);
    const { registerRecord } = await import(pathToFileURL(path.join(sourceRoot, 'dist', 'tools', 'record.js')).href);
    const { registerQuery } = await import(pathToFileURL(path.join(sourceRoot, 'dist', 'tools', 'query.js')).href);
    const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    const server = new McpServer({ name: 'record-ownership-response-fixture', version });
    const originalTool = server.tool.bind(server);
    let sequence = 0;
    server.tool = (...parameters) => {
        if (parameters[0] === 'record_manage') {
            const handler = parameters.at(-1);
            parameters[parameters.length - 1] = async (...handlerArguments) => {
                if (handlerArguments[0]?.action !== 'audit_ownership') return handler(...handlerArguments);
                const currentSequence = ++sequence;
                let synchronousMetadataReads = 0;
                const originalRead = fs.readFileSync;
                fs.readFileSync = function (filename, ...readArguments) {
                    if (String(filename).endsWith('_meta.json')) synchronousMetadataReads += 1;
                    return originalRead.call(fs, filename, ...readArguments);
                };
                process.stderr.write(signalPrefix + JSON.stringify({ event: 'audit_begin', sequence: currentSequence }) + '\n');
                try {
                    return await handler(...handlerArguments);
                } finally {
                    fs.readFileSync = originalRead;
                    process.stderr.write(signalPrefix + JSON.stringify({ event: 'audit_end', sequence: currentSequence, synchronousMetadataReads }) + '\n');
                }
            };
        }
        return originalTool(...parameters);
    };
    registerRecord(server);
    registerQuery(server);
    process.stdin.once('end', () => {
        void server.close().then(() => process.exit(0), error => {
            process.stderr.write(String(error) + '\n');
            process.exit(1);
        });
    });
    await server.connect(new StdioServerTransport());
}

function prepareFixture(root) {
    const fixture = {
        root,
        tempBase: os.tmpdir(),
        home: path.join(root, 'home'),
        dataRoot: path.join(root, 'data'),
        appData: path.join(root, 'home', 'AppData', 'Roaming'),
        localAppData: path.join(root, 'home', 'AppData', 'Local'),
        runtimeTemp: path.join(root, 'runtime-temp'),
        codexHome: path.join(root, 'home', '.codex'),
        claudeHome: path.join(root, 'home', '.claude'),
        desktopRoot: path.join(root, 'home', 'AppData', 'Roaming', 'Claude', 'claude-code-sessions'),
        workspace: path.join(root, 'workspace-a'),
        foreignWorkspace: path.join(root, 'workspace-b'),
        ids: Array.from({ length: 205 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        callerId: 'ffffffff-ffff-4fff-8fff-fffffffffff0',
        missingId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    };
    fixture.hash = workspaceHash(fixture.workspace);
    fixture.foreignHash = workspaceHash(fixture.foreignWorkspace);
    const aliasPath = `\\\\?\\${fixture.workspace}`;
    fixture.aliasHash = sha256(aliasPath.toLowerCase().replace(/\\/g, '/').replace(/\/+$/u, '')).slice(0, 8);
    assert.notEqual(fixture.aliasHash, fixture.hash);
    const stamp = '2026-01-01T00:00:00.000Z';
    const metadata = (hash, originalPath, canonicalPath = originalPath) => ({ hash, originalPath, canonicalPath, name: 'Synthetic workspace', createdAt: stamp, lastAccessed: stamp, isArchived: false, memoryCount: 0, totalSizeBytes: 0, topTags: [] });
    const buckets = [
        { hash: fixture.hash, meta: metadata(fixture.hash, fixture.workspace), ids: fixture.ids.slice(0, 201), rounds: 5 },
        { hash: fixture.aliasHash, meta: metadata(fixture.aliasHash, aliasPath, fixture.workspace), ids: [fixture.ids[0]], rounds: 1 },
        { hash: fixture.foreignHash, meta: metadata(fixture.foreignHash, fixture.foreignWorkspace), ids: fixture.ids.slice(203), rounds: 5 },
        { hash: 'general', ids: [fixture.ids[0], ...fixture.ids.slice(201, 203)], rounds: 1 },
    ];
    fixture.locations = [];
    for (const bucket of buckets) {
        const bucketRoot = bucket.hash === 'general' ? path.join(fixture.dataRoot, 'general') : path.join(fixture.dataRoot, 'workspaces', bucket.hash);
        const records = {};
        fs.mkdirSync(path.join(bucketRoot, 'records'), { recursive: true });
        writeJson(path.join(bucketRoot, '_index.json'), { version: 1, entries: [] });
        if (bucket.meta) writeJson(path.join(bucketRoot, '_meta.json'), bucket.meta);
        for (const conversationId of bucket.ids) {
            const body = `# Synthetic Record ${conversationId}\n\nRead-only ownership fixture.\n`;
            fs.writeFileSync(path.join(bucketRoot, 'records', `${conversationId}.md`), body, 'utf8');
            records[conversationId] = { conversationId, title: `Synthetic ${conversationId}`, totalRounds: bucket.rounds, totalSteps: bucket.rounds, lastUpdatedRound: bucket.rounds, lastUpdatedAt: stamp, sizeBytes: Buffer.byteLength(body), chain: 'codex' };
            fixture.locations.push({ conversationId, currentHash: bucket.hash });
        }
        writeJson(path.join(bucketRoot, 'records', '_records_index.json'), { version: 1, records });
    }
    writeJson(path.join(fixture.dataRoot, '_global_index.json'), { version: 1, lastUpdated: stamp, generalCount: 0, workspaces: Object.fromEntries(buckets.filter(bucket => bucket.meta).map(bucket => [bucket.hash, bucket.meta])) });
    for (const directory of [fixture.workspace, fixture.foreignWorkspace, fixture.appData, fixture.localAppData, fixture.runtimeTemp, fixture.desktopRoot, path.join(fixture.codexHome, 'sessions'), path.join(fixture.codexHome, 'archived_sessions'), path.join(fixture.claudeHome, 'projects', 'synthetic-a')]) fs.mkdirSync(directory, { recursive: true });
    const rollout = (index, directory, payloadId = fixture.ids[index]) => {
        const filename = path.join(fixture.codexHome, directory, `rollout-2026-01-01T00-00-00-${fixture.ids[index]}.jsonl`);
        fs.writeFileSync(filename, JSON.stringify({ type: 'session_meta', payload: { id: payloadId, cwd: fixture.workspace, timestamp: stamp, source: 'cli' } }) + '\n', 'utf8');
    };
    rollout(120, 'sessions');
    rollout(151, 'sessions');
    rollout(180, 'archived_sessions');
    rollout(181, 'sessions', fixture.ids[182]);
    const claudeLine = (index, cwd) => JSON.stringify({ type: 'user', sessionId: fixture.ids[index], ...(cwd ? { cwd } : {}), message: { role: 'user', content: 'Synthetic local conversation' } }) + '\n';
    fs.writeFileSync(path.join(fixture.claudeHome, 'projects', 'synthetic-a', `${fixture.ids[125]}.jsonl`), claudeLine(125, fixture.workspace), 'utf8');
    fs.mkdirSync(path.join(fixture.claudeHome, 'projects', 'synthetic-b'), { recursive: true });
    fs.writeFileSync(path.join(fixture.claudeHome, 'projects', 'synthetic-b', `${fixture.ids[125]}.jsonl`), claudeLine(125, fixture.workspace), 'utf8');
    fs.writeFileSync(path.join(fixture.claudeHome, 'projects', 'synthetic-a', `${fixture.ids[126]}.jsonl`), claudeLine(126, fixture.workspace), 'utf8');
    fs.writeFileSync(path.join(fixture.claudeHome, 'projects', 'synthetic-a', `${fixture.ids[163]}.jsonl`), claudeLine(163), 'utf8');
    writeJson(path.join(fixture.desktopRoot, 'synthetic-account', 'synthetic-org', `local_${fixture.ids[163]}.json`), { cliSessionId: fixture.ids[163], title: 'Synthetic Desktop', cwd: fixture.workspace, lastActivityAt: stamp, isArchived: false });
    fixture.database = path.join(fixture.codexHome, 'state_5.sqlite');
    fixture.manifest = path.join(root, 'fixture.json');
    fixture.primaryIndex = path.join(fixture.dataRoot, 'workspaces', fixture.hash, 'records', '_records_index.json');
    for (let index = 0; index < 300; index += 1) {
        const workspace = path.join(root, `unrelated-workspace-${index}`);
        const hash = workspaceHash(workspace);
        writeJson(path.join(fixture.dataRoot, 'workspaces', hash, '_meta.json'), metadata(hash, workspace));
    }
    writeJson(fixture.manifest, fixture);
    const setupPython = [
        'import json,sqlite3,sys',
        'from pathlib import Path',
        'fixture=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))',
        'connection=sqlite3.connect(fixture["database"])',
        'connection.execute("PRAGMA journal_mode=DELETE")',
        'connection.execute("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,model TEXT,reasoning_effort TEXT,agent_nickname TEXT,agent_role TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,created_at INTEGER,created_at_ms INTEGER)")',
        'connection.execute("CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT,status TEXT)")',
        'for index,identifier in enumerate(fixture["ids"][:102]):',
        ' cwd=fixture["foreignWorkspace"] if index==100 else str(Path(fixture["root"])/("new-workspace-"+str(index))) if 1<=index<=50 else fixture["workspace"]',
        ' rollout=str(Path(fixture["codexHome"])/"sessions"/(identifier+".jsonl"))',
        ' connection.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,rollout,cwd,"Synthetic","cli","synthetic","high",None,None,1,1,int(index==101),1,1))',
        'child=fixture["ids"][150]',
        'connection.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(child,"",None,"Synthetic child","cli","synthetic","high","fixture","worker",1,1,0,1,1))',
        'connection.execute("INSERT INTO thread_spawn_edges VALUES(?,?,?)",(child,fixture["ids"][50],"completed"))',
        'connection.execute("INSERT INTO thread_spawn_edges VALUES(?,?,?)",(fixture["ids"][151],fixture["ids"][100],"completed"))',
        'connection.commit()',
        'connection.close()',
    ].join('\n');
    execFileSync('python', ['-S', '-c', setupPython, fixture.manifest], { env: isolatedEnvironment(fixture), windowsHide: true, timeout: 10000, encoding: 'utf8' });
    return fixture;
}

function snapshot(root) {
    const files = {};
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) files[path.relative(root, full).replace(/\\/g, '/')] = sha256(fs.readFileSync(full));
            else assert.fail(`unexpected fixture entry: ${full}`);
        }
    };
    walk(root);
    return { files, hash: sha256(JSON.stringify(files)), count: Object.keys(files).length };
}

function sourceSnapshot(fixture) {
    return { codex: snapshot(fixture.codexHome), claudeCode: snapshot(fixture.claudeHome), desktop: snapshot(fixture.desktopRoot) };
}

async function measure(operation) {
    const started = performance.now();
    try {
        return { success: true, result: await operation(), elapsedMs: performance.now() - started };
    } catch (error) {
        return { success: false, elapsedMs: performance.now() - started, error: error.message, code: error.code };
    }
}

async function waitFor(predicate, label, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        assert.ok(performance.now() < deadline, `timed out: ${label}`);
        await sleep(5);
    }
}

async function holdDatabase(fixture) {
    assertInside(fixture.root, fixture.database);
    const lockPython = [
        'import sqlite3,sys',
        'connection=sqlite3.connect(sys.argv[1],timeout=10)',
        'try:',
        ' connection.execute("BEGIN EXCLUSIVE")',
        ' print("LOCK_READY",flush=True)',
        ' sys.stdin.readline()',
        'finally:',
        ' connection.rollback()',
        ' connection.close()',
        ' print("LOCK_RELEASED",flush=True)',
    ].join('\n');
    const locker = spawn('python', ['-S', '-u', '-c', lockPython, fixture.database], { env: isolatedEnvironment(fixture), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let spawnError;
    const closed = new Promise(resolve => {
        locker.once('error', error => { spawnError = error; resolve(); });
        locker.once('close', resolve);
    });
    locker.stdout.on('data', chunk => { stdout += chunk.toString(); });
    locker.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        locker.stdin.end('release\n');
        const exited = await Promise.race([closed.then(() => true), sleep(3000).then(() => false)]);
        if (!exited) {
            locker.kill();
            await closed;
        }
        assert.ifError(spawnError);
        assert.equal(locker.exitCode, 0, stderr);
        assert.match(stdout, /LOCK_RELEASED/u);
    };
    try {
        await waitFor(() => {
            assert.ifError(spawnError);
            assert.ok(locker.exitCode === null, stderr || 'lock process exited early');
            return stdout.includes('LOCK_READY');
        }, 'SQLite BEGIN EXCLUSIVE');
        return { release, evidence: () => ({ stdout: stdout.trim(), stderr: stderr.trim(), database: fixture.database, pid: locker.pid }) };
    } catch (error) {
        await release().catch(() => {});
        throw error;
    }
}

function resultJson(response) {
    assert.ok(!response.isError, JSON.stringify(response));
    const blocks = response.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1, 'JSON content must be one pure JSON block');
    const value = JSON.parse(blocks[0].text);
    assert.deepEqual(response.structuredContent, value, 'structuredContent must equal the JSON content');
    for (const field of ['action', 'readOnly', 'scope', 'includeGeneral', 'dataChain', 'selection', 'coverage', 'lookupDiagnostics', 'sourceTimings', 'items', 'elapsedMs']) assert.ok(Object.hasOwn(value, field), `missing ${field}`);
    assert.equal(value.action, 'audit_ownership');
    assert.equal(value.readOnly, true);
    assert.ok(['conversationId', 'recordIds', 'all'].includes(value.selection.mode));
    if (value.selection.mode === 'all') assert.ok(value.selection.requestedIds === undefined || (Array.isArray(value.selection.requestedIds) && value.selection.requestedIds.length === 0));
    else assert.ok(Array.isArray(value.selection.requestedIds));
    assert.ok(Array.isArray(value.selection.unmatchedIds));
    assert.ok(value.lookupDiagnostics && typeof value.lookupDiagnostics === 'object');
    assert.ok(Array.isArray(value.sourceTimings));
    assert.ok(Array.isArray(value.items));
    assert.ok(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0);
    for (const field of ['matchedConversations', 'matchedLocations', 'offset', 'processedConversations', 'processedLocations']) assert.ok(Number.isSafeInteger(value.coverage[field]) && value.coverage[field] >= 0, `invalid coverage.${field}`);
    for (const field of ['complete', 'partial', 'hasMore']) assert.equal(typeof value.coverage[field], 'boolean');
    for (const item of value.items) {
        assert.ok(['ok', 'duplicate', 'migratable', 'conflict', 'unknown'].includes(item.status));
        assert.ok(typeof item.reason === 'string' && item.reason.length > 0);
        assert.ok(typeof item.suggestedAction === 'string' && item.suggestedAction.length > 0);
    }
    return value;
}

function keys(items) {
    return items.map(item => `${item.conversationId}:${item.currentHash}`).sort();
}

function scopedLocations(fixture, scope, includeGeneral = false) {
    if (scope === 'global') return fixture.locations;
    const hashes = scope === 'general' ? ['general'] : [fixture.hash, fixture.aliasHash, ...(includeGeneral ? ['general'] : [])];
    return fixture.locations.filter(item => hashes.includes(item.currentHash));
}

function checkCoverage(value, locations, offset = 0) {
    const total = new Set(locations.map(item => item.conversationId)).size;
    const processed = new Set(value.items.map(item => item.conversationId)).size;
    assert.equal(value.coverage.matchedConversations, total);
    assert.equal(value.coverage.matchedLocations, locations.length);
    assert.equal(value.coverage.offset, offset);
    assert.equal(value.coverage.processedConversations, processed);
    assert.equal(value.coverage.processedLocations, value.items.length);
    assert.equal(value.coverage.complete, offset === 0 && processed === total);
    assert.equal(value.coverage.partial, !(offset === 0 && processed === total));
    assert.equal(value.coverage.hasMore, offset + processed < total);
    if (value.coverage.hasMore) assert.ok(typeof value.nextAuditCursor === 'string' && value.nextAuditCursor.length > 0);
    else assert.ok(value.nextAuditCursor === undefined || value.nextAuditCursor === null);
}

function checkCodexClassification(fixture, item, locations = fixture.locations) {
    const index = fixture.ids.indexOf(item.conversationId);
    assert.ok(index >= 0, `unexpected ID ${item.conversationId}`);
    if (index < 102 || [120, 150, 151, 180].includes(index)) {
        const expectedWorkspace = index === 100 ? fixture.foreignWorkspace : index === 150 ? path.join(fixture.root, 'new-workspace-50') : index >= 1 && index <= 50 ? path.join(fixture.root, `new-workspace-${index}`) : fixture.workspace;
        const expectedHash = workspaceHash(expectedWorkspace);
        assert.equal(item.expectedHash, expectedHash);
        assert.equal(item.sourceType, index === 150 ? 'child_parent' : 'codex_cwd');
        const hasTarget = locations.some(location => location.conversationId === item.conversationId && location.currentHash === expectedHash);
        const expectedStatus = item.currentHash === expectedHash ? 'ok' : item.currentHash === 'general' || item.currentHash === fixture.aliasHash ? hasTarget ? 'duplicate' : 'migratable' : 'conflict';
        assert.equal(item.status, expectedStatus, JSON.stringify(item));
        assert.equal(item.suggestedAction, expectedStatus === 'ok' ? 'keep' : expectedStatus === 'duplicate' ? 'archiveDuplicate' : expectedStatus === 'migratable' ? 'move' : 'manualReview');
    } else {
        assert.equal(item.status, 'unknown', JSON.stringify(item));
        assert.equal(item.sourceType, 'unknown');
        assert.equal(item.suggestedAction, 'keep');
    }
}

async function run() {
    const startedAt = new Date().toISOString();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-ownership-response-'));
    assertInside(os.tmpdir(), root);
    let fixture;
    let client;
    let transport;
    let currentLock;
    let stderrText = '';
    let stderrRemainder = '';
    const signals = [];
    const summary = { test: 'record-ownership-response', startedAt, nodeVersion: process.version, sourceRoot, fixtureRoot: root, syntheticConversations: 205, sqliteKnownCwd: 102, repetitions: [], pagination: [], checks: [], success: false };
    try {
        fixture = prepareFixture(root);
        const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
        const distPaths = ['tools/record.js', 'tools/query.js', 'codex-client.js', 'claude-code-client.js', 'store.js'];
        const distHashes = Object.fromEntries(distPaths.map(relative => [relative, sha256(fs.readFileSync(path.join(sourceRoot, 'dist', relative)))]));
        Object.assign(summary, { version, sdkVersion: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')).version, distHashes, syntheticLocations: fixture.locations.length });
        const dataBefore = snapshot(fixture.dataRoot);
        const sourceBefore = sourceSnapshot(fixture);
        const environmentBefore = snapshot(fixture.home);
        const databaseBefore = sha256(fs.readFileSync(fixture.database));
        const { Client } = await import(pathToFileURL(path.join(sdkRoot, 'client', 'index.js')).href);
        const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'client', 'stdio.js')).href);
        client = new Client({ name: 'record-ownership-response-test', version: '1.0.0' });
        transport = new StdioClientTransport({ command: process.execPath, args: [scriptPath, '--serve', '--sourceRoot', sourceRoot, '--fixture', fixture.manifest], env: isolatedEnvironment(fixture), cwd: root, stderr: 'pipe' });
        transport.stderr.on('data', chunk => {
            const text = chunk.toString();
            stderrText += text;
            stderrRemainder += text;
            const lines = stderrRemainder.split(/\r?\n/u);
            stderrRemainder = lines.pop();
            for (const line of lines) if (line.startsWith(signalPrefix)) signals.push({ ...JSON.parse(line.slice(signalPrefix.length)), receivedMs: performance.now() });
        });
        await client.connect(transport);
        summary.childPid = transport.pid;
        const call = argumentsValue => client.callTool({ name: 'record_manage', arguments: { action: 'audit_ownership', dataChain: 'codex', modelChain: 'codex', format: 'json', ...argumentsValue } }, undefined, { timeout: requestTimeoutMs });
        const query = () => client.callTool({ name: 'memory_query', arguments: { workspace: fixture.workspace, query: 'synthetic-unmatched-term', mode: 'exact', limit: 1 } }, undefined, { timeout: concurrentTimeoutMs });
        const list = () => client.listTools({}, { timeout: concurrentTimeoutMs });
        const baseline = await Promise.all([measure(query), measure(list)]);
        assert.ok(baseline.every(result => result.success && !result.result.isError), JSON.stringify(baseline));
        assert.ok(baseline[1].result.tools.some(tool => tool.name === 'record_manage'));
        assert.ok(baseline[1].result.tools.some(tool => tool.name === 'memory_query'));
        summary.baseline = { queryMs: baseline[0].elapsedMs, listMs: baseline[1].elapsedMs };
        for (const repetition of [1, 2]) {
            currentLock = await holdDatabase(fixture);
            const beginCount = signals.filter(signal => signal.event === 'audit_begin').length;
            let auditDone = false;
            const auditArguments = repetition === 1 ? { workspace: fixture.workspace, conversationId: fixture.ids[0], limit: 1 } : { workspace: fixture.workspace, scope: 'global', auditAll: true, limit: 200 };
            const audit = measure(() => call(auditArguments)).then(result => { auditDone = true; return result; });
            let entry;
            let auditResult;
            try {
                await waitFor(() => signals.filter(signal => signal.event === 'audit_begin').length > beginCount, 'actual audit handler start');
                const begin = signals.filter(signal => signal.event === 'audit_begin').at(-1);
                await sleep(100);
                assert.equal(auditDone, false, 'audit completed despite the held SQLite lock');
                const probe = async operation => {
                    const measured = await measure(operation);
                    return { ...measured, auditDoneAtReturn: auditDone, auditEndObservedAtReturn: signals.some(signal => signal.event === 'audit_end' && signal.sequence === begin.sequence) };
                };
                const [queryResult, listResult] = await Promise.all([probe(query), probe(list)]);
                entry = { repetition, sequence: begin.sequence, requestedLimit: auditArguments.limit, queryMs: queryResult.elapsedMs, listMs: listResult.elapsedMs, querySuccess: queryResult.success && !queryResult.result?.isError, listSuccess: listResult.success, queryAuditDone: queryResult.auditDoneAtReturn, listAuditDone: listResult.auditDoneAtReturn, queryAuditEndObserved: queryResult.auditEndObservedAtReturn, listAuditEndObserved: listResult.auditEndObservedAtReturn, queryError: queryResult.error, listError: listResult.error };
                summary.repetitions.push(entry);
            } finally {
                try {
                    await currentLock.release();
                    if (entry) entry.lock = currentLock.evidence();
                    currentLock = undefined;
                } finally {
                    auditResult = await audit;
                }
            }
            assert.ok(auditResult.success, JSON.stringify(auditResult));
            const value = resultJson(auditResult.result);
            const locations = repetition === 1 ? scopedLocations(fixture, 'workspace').filter(item => item.conversationId === fixture.ids[0]) : scopedLocations(fixture, 'global');
            checkCoverage(value, locations);
            value.items.forEach(item => checkCodexClassification(fixture, item, locations));
            Object.assign(entry, { auditMs: auditResult.elapsedMs, processedConversations: value.coverage.processedConversations, processedLocations: value.coverage.processedLocations, lookupDiagnostics: value.lookupDiagnostics, sourceTimings: { entries: value.sourceTimings.length, totalMs: value.sourceTimings.reduce((total, timing) => total + timing.elapsedMs, 0), maxMs: Math.max(0, ...value.sourceTimings.map(timing => timing.elapsedMs)) } });
            assert.equal(entry.querySuccess, true, JSON.stringify(entry));
            assert.equal(entry.listSuccess, true, JSON.stringify(entry));
            assert.ok(entry.queryMs < concurrentTimeoutMs && entry.listMs < concurrentTimeoutMs, JSON.stringify(entry));
            assert.equal(entry.queryAuditDone, false);
            assert.equal(entry.listAuditDone, false);
            assert.equal(entry.queryAuditEndObserved, false);
            assert.equal(entry.listAuditEndObserved, false);
            await waitFor(() => signals.some(signal => signal.event === 'audit_end' && signal.sequence === entry.sequence), 'audit natural completion');
            assert.equal(sha256(fs.readFileSync(fixture.database)), databaseBefore, 'exclusive lock/audit changed SQLite bytes');
        }
        summary.checks.push('two real SQLite-lock concurrency rounds');
        const single = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.ids[0], limit: 1 }));
        assert.deepEqual(single.selection.requestedIds, [fixture.ids[0]]);
        assert.deepEqual(single.selection.unmatchedIds, []);
        const siblings = scopedLocations(fixture, 'workspace').filter(item => item.conversationId === fixture.ids[0]);
        assert.deepEqual(keys(single.items), keys(siblings));
        checkCoverage(single, siblings);
        const triple = resultJson(await call({ workspace: fixture.workspace, scope: 'global', conversationId: fixture.ids[0], limit: 1 }));
        const tripleLocations = fixture.locations.filter(item => item.conversationId === fixture.ids[0]);
        assert.deepEqual(keys(triple.items), keys(tripleLocations));
        checkCoverage(triple, tripleLocations);
        triple.items.forEach(item => checkCodexClassification(fixture, item));
        summary.checks.push('single CID limit1 retains alias/general siblings');
        const requestedIds = [fixture.ids[120], fixture.ids[150], fixture.missingId];
        const multi = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.callerId, recordIds: requestedIds, limit: 50 }));
        assert.deepEqual([...multi.selection.requestedIds].sort(), [...requestedIds].sort());
        assert.deepEqual(multi.selection.unmatchedIds, [fixture.missingId]);
        assert.notEqual(multi.selection.mode, single.selection.mode);
        const multiLocations = scopedLocations(fixture, 'workspace').filter(item => requestedIds.includes(item.conversationId));
        assert.deepEqual(keys(multi.items), keys(multiLocations));
        checkCoverage(multi, multiLocations);
        multi.items.forEach(item => checkCodexClassification(fixture, item));
        const missing = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.missingId, limit: 1 }));
        assert.deepEqual(missing.items, []);
        assert.deepEqual(missing.selection.unmatchedIds, [fixture.missingId]);
        checkCoverage(missing, []);
        summary.checks.push('explicit recordIds override caller CID; missing matches zero');
        for (const argumentsValue of [{ workspace: fixture.workspace }, { workspace: fixture.workspace, recordIds: [] }, { workspace: fixture.workspace, conversationId: fixture.callerId, auditAll: true, recordIds: [fixture.ids[0]] }, { workspace: fixture.workspace, auditAll: true, auditCursor: 'not-a-valid-cursor' }, { workspace: fixture.workspace, auditAll: true, limit: 0 }, { workspace: fixture.workspace, auditAll: true, limit: 201 }]) {
            const response = await call(argumentsValue);
            assert.equal(response.isError, true, JSON.stringify({ argumentsValue, response }));
        }
        summary.checks.push('invalid selection/cursor/limit returns isError');
        for (const limit of [50, 200]) {
            const locations = scopedLocations(fixture, 'global');
            const seenIds = new Set();
            const seenKeys = new Set();
            const cursors = new Set();
            let cursor;
            let offset = 0;
            let pages = 0;
            do {
                const value = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.callerId, scope: 'global', auditAll: true, limit, ...(cursor ? { auditCursor: cursor } : {}) }));
                assert.equal(value.scope, 'global');
                assert.equal(value.dataChain, 'codex');
                assert.notEqual(value.selection.mode, single.selection.mode);
                assert.notEqual(value.selection.mode, multi.selection.mode);
                checkCoverage(value, locations, offset);
                const pageIds = new Set(value.items.map(item => item.conversationId));
                assert.equal(pageIds.size, Math.min(limit, 205 - offset));
                for (const identifier of pageIds) {
                    assert.ok(!seenIds.has(identifier), `duplicate conversation across pages ${identifier}`);
                    seenIds.add(identifier);
                    assert.deepEqual(keys(value.items.filter(item => item.conversationId === identifier)), keys(locations.filter(item => item.conversationId === identifier)), 'page split a sibling group');
                }
                for (const item of value.items) {
                    const key = `${item.conversationId}:${item.currentHash}`;
                    assert.ok(!seenKeys.has(key), `duplicate location ${key}`);
                    seenKeys.add(key);
                    checkCodexClassification(fixture, item);
                }
                summary.pagination.push({ limit, page: ++pages, offset, processedConversations: pageIds.size, processedLocations: value.items.length, complete: value.coverage.complete, partial: value.coverage.partial, hasMore: value.coverage.hasMore });
                offset += pageIds.size;
                cursor = value.nextAuditCursor;
                if (cursor) {
                    assert.ok(!cursors.has(cursor), 'cursor repeated');
                    cursors.add(cursor);
                }
                assert.ok(pages <= 6, 'pagination did not terminate');
            } while (cursor);
            assert.deepEqual([...seenIds].sort(), [...fixture.ids].sort());
            assert.deepEqual([...seenKeys].sort(), keys(locations));
            assert.equal(offset, 205);
        }
        summary.checks.push('limit50/200 traverse all 205 IDs and 207 locations without repeats');
        for (const scopeCase of [{ scope: undefined, includeGeneral: false }, { scope: 'workspace', includeGeneral: false }, { scope: 'workspace', includeGeneral: true }, { scope: 'general', includeGeneral: false }]) {
            const effectiveScope = scopeCase.scope || 'workspace';
            const locations = scopedLocations(fixture, effectiveScope, scopeCase.includeGeneral);
            const value = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.callerId, auditAll: true, limit: 200, ...(scopeCase.scope ? { scope: scopeCase.scope } : {}), ...(scopeCase.includeGeneral ? { includeGeneral: true } : {}) }));
            assert.equal(value.scope, effectiveScope);
            assert.equal(value.includeGeneral, scopeCase.includeGeneral);
            checkCoverage(value, locations);
            const firstIds = new Set(value.items.map(item => item.conversationId));
            assert.equal(firstIds.size, Math.min(200, new Set(locations.map(item => item.conversationId)).size));
            assert.deepEqual(keys(value.items), keys(locations.filter(item => firstIds.has(item.conversationId))));
            value.items.forEach(item => checkCodexClassification(fixture, item, locations));
            if (value.nextAuditCursor) {
                const next = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.callerId, auditAll: true, limit: 200, ...(scopeCase.scope ? { scope: scopeCase.scope } : {}), ...(scopeCase.includeGeneral ? { includeGeneral: true } : {}), auditCursor: value.nextAuditCursor }));
                checkCoverage(next, locations, firstIds.size);
                assert.deepEqual(keys([...value.items, ...next.items]), keys(locations));
            }
        }
        const defaultPage = resultJson(await call({ workspace: fixture.workspace, auditAll: true }));
        assert.equal(defaultPage.coverage.processedConversations, 50);
        const generalDefault = resultJson(await call({ conversationId: fixture.ids[201], limit: 1 }));
        assert.deepEqual(keys(generalDefault.items), keys(fixture.locations.filter(item => item.conversationId === fixture.ids[201])));
        summary.checks.push('workspace default/general/includeGeneral/global bucket boundaries');
        for (const index of [126, 163]) {
            const value = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.ids[index], dataChain: 'claude-code', limit: 1 }));
            checkCoverage(value, scopedLocations(fixture, 'workspace').filter(item => item.conversationId === fixture.ids[index]));
            assert.equal(value.items[0].sourceType, 'claude_code_cwd');
            assert.equal(value.items[0].expectedHash, fixture.hash);
            assert.equal(value.items[0].status, 'ok');
        }
        const claudeAmbiguous = resultJson(await call({ workspace: fixture.workspace, conversationId: fixture.ids[125], dataChain: 'claude-code', limit: 1 }));
        assert.equal(claudeAmbiguous.items.length, 1);
        assert.equal(claudeAmbiguous.items[0].sourceType, 'unknown');
        assert.equal(claudeAmbiguous.items[0].status, 'conflict');
        assert.equal(claudeAmbiguous.items[0].suggestedAction, 'manualReview');
        summary.checks.push('Claude same-name ambiguity, exact cwd and Desktop cwd use isolated roots');
        const firstPage = resultJson(await call({ workspace: fixture.workspace, scope: 'global', auditAll: true, limit: 50 }));
        const indexBytes = fs.readFileSync(fixture.primaryIndex);
        assert.deepEqual(snapshot(fixture.dataRoot), dataBefore);
        try {
            const index = JSON.parse(indexBytes.toString('utf8'));
            index.records[fixture.ids[110]].title = 'Synthetic deliberate fingerprint change';
            writeJson(fixture.primaryIndex, index);
            const changedBefore = snapshot(fixture.dataRoot);
            assert.notEqual(changedBefore.hash, dataBefore.hash);
            const response = await call({ workspace: fixture.workspace, scope: 'global', auditAll: true, limit: 50, auditCursor: firstPage.nextAuditCursor });
            assert.equal(response.isError, true, JSON.stringify(response));
            assert.deepEqual(snapshot(fixture.dataRoot), changedBefore, 'stale-cursor audit changed fixture data');
        } finally {
            fs.writeFileSync(fixture.primaryIndex, indexBytes);
        }
        summary.checks.push('changed index fingerprint rejects second page; test mutation restored');
        await client.close();
        client = undefined;
        const dataAfter = snapshot(fixture.dataRoot);
        const sourceAfter = sourceSnapshot(fixture);
        const environmentAfter = snapshot(fixture.home);
        assert.deepEqual(dataAfter, dataBefore, 'Record bodies/indexes/metadata changed');
        assert.deepEqual(sourceAfter, sourceBefore, 'source SQLite/rollouts/Claude files changed');
        const environmentChanges = [...new Set([...Object.keys(environmentBefore.files), ...Object.keys(environmentAfter.files)])].filter(relative => environmentBefore.files[relative] !== environmentAfter.files[relative]);
        assert.ok(environmentChanges.every(relative => relative === 'AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive'), 'unexpected environment state change');
        assert.equal(sha256(fs.readFileSync(fixture.database)), databaseBefore);
        const distHashesAfter = Object.fromEntries(distPaths.map(relative => [relative, sha256(fs.readFileSync(path.join(sourceRoot, 'dist', relative)))]));
        assert.deepEqual(distHashesAfter, distHashes, 'dist changed during the test');
        summary.readOnly = { dataFiles: dataBefore.count, sourceFiles: Object.values(sourceBefore).reduce((total, value) => total + value.count, 0), dataBefore: dataBefore.hash, dataAfter: dataAfter.hash, sourceBefore: sha256(JSON.stringify(sourceBefore)), sourceAfter: sha256(JSON.stringify(sourceAfter)), sqliteBefore: databaseBefore, sqliteAfter: sha256(fs.readFileSync(fixture.database)), environmentChanges };
        summary.stderr = { auditBegins: signals.filter(signal => signal.event === 'audit_begin').length, auditEnds: signals.filter(signal => signal.event === 'audit_end').length, signals: signals.filter(signal => [1, 2].includes(signal.sequence)).map(({ event, sequence }) => ({ event, sequence })), otherText: stderrText.split(/\r?\n/u).filter(line => line && !line.startsWith(signalPrefix)).join('\n').slice(-3000) };
        assert.equal(summary.stderr.auditBegins, summary.stderr.auditEnds);
        assert.ok(signals.filter(signal => signal.event === 'audit_end').every(signal => signal.synchronousMetadataReads === 0), 'audit performed synchronous workspace metadata reads');
        summary.synchronousMetadataReads = signals.filter(signal => signal.event === 'audit_end').reduce((total, signal) => total + signal.synchronousMetadataReads, 0);
        summary.checks.push('300 unrelated workspace buckets and 50 new cwd identities use zero synchronous metadata reads');
        summary.success = true;
    } catch (error) {
        summary.error = { message: error.message, stack: error.stack };
        summary.stderrTail = stderrText.slice(-6000);
        process.exitCode = 1;
    } finally {
        const cleanupFailed = error => { summary.cleanupError = error.message; summary.success = false; process.exitCode = 1; };
        if (currentLock) await currentLock.release().catch(cleanupFailed);
        if (client) await client.close().catch(cleanupFailed);
        else if (transport) await transport.close().catch(cleanupFailed);
        summary.finishedAt = new Date().toISOString();
        summary.fixturePreserved = !summary.success;
        if (summary.success) {
            assertInside(os.tmpdir(), root);
            try {
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            } catch (error) {
                cleanupFailed(error);
                summary.fixturePreserved = true;
            }
        }
        process.stdout.write(JSON.stringify(summary) + '\n');
    }
}

if (process.argv.includes('--serve')) await serve();
else await run();
