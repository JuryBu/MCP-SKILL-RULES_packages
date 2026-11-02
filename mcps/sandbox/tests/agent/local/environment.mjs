import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, statfs } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import * as zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

const supplied = process.argv.indexOf('--evidence-root');
if (supplied < 0 || !process.argv[supplied + 1]) throw new Error('--evidence-root is required');
const evidenceRoot = resolve(process.argv[supplied + 1]);
const trialId = `environment-${randomUUID()}`;
const trialRoot = join(evidenceRoot, trialId);
await mkdir(trialRoot, { recursive: true });
const report = { schemaVersion: 1, trialId, startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch, checks: [], artifacts: [], errors: [] };
const check = async (name, action) => {
    const start = performance.now();
    try {
        const details = await action();
        report.checks.push({ name, passed: true, elapsedMs: performance.now() - start, details });
    } catch (error) {
        report.checks.push({ name, passed: false, elapsedMs: performance.now() - start });
        report.errors.push({ name, message: error.message });
    }
};

await check('runtime', async () => {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
    return { uv: process.versions.uv, v8: process.versions.v8 };
});
await check('sqlite-real-transaction-reopen', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const databasePath = join(trialRoot, '正常会话.sqlite');
    let database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;');
    database.exec('CREATE TABLE normal_items(id TEXT PRIMARY KEY, body TEXT NOT NULL);');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO normal_items(id,body) VALUES (?,?)').run('first', '正常写入，关闭后继续');
    database.exec('COMMIT');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO normal_items(id,body) VALUES (?,?)').run('rollback', '未提交草稿');
    database.exec('ROLLBACK');
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    database.close();
    database = new DatabaseSync(databasePath);
    assert.equal(database.prepare('SELECT body FROM normal_items WHERE id=?').get('first').body, '正常写入，关闭后继续');
    assert.equal(database.prepare('SELECT count(*) AS total FROM normal_items').get().total, 1);
    database.exec('CREATE VIRTUAL TABLE search_items USING fts5(body);');
    database.prepare('INSERT INTO search_items(body) VALUES (?)').run('agent persistent conversation');
    assert.equal(database.prepare("SELECT count(*) AS total FROM search_items WHERE search_items MATCH 'persistent'").get().total, 1);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.close();
    report.artifacts.push({ kind: 'self-owned-database', path: databasePath });
    return { sqliteVersion, committedRows: 1, rollbackRows: 0, fts5: true, reopened: true };
});
await check('compression-real-bytes', async () => {
    const original = Buffer.from('自有会话材料与附件索引\n'.repeat(128));
    const compressed = await promisify(gzip)(original);
    assert.deepEqual(await promisify(gunzip)(compressed), original);
    return { rawBytes: original.length, gzipBytes: compressed.length,
        sourceHash: createHash('sha256').update(original).digest('hex'),
        zstdAvailable: typeof zlib.zstdCompress === 'function', brotliAvailable: typeof zlib.brotliCompress === 'function' };
});
await check('private-ipc-normal-unicode', async () => {
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\sandbox-agent-env-${randomUUID()}` : join(trialRoot, 'normal.sock');
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); socket.on('data', data => socket.write(data)); socket.on('close', () => sockets.delete(socket)); });
    try {
        await new Promise((done, fail) => { server.once('error', fail); server.listen(endpoint, done); });
        const source = Buffer.from('普通客户端：中文与猫 🐈\n');
        const returned = await new Promise((done, fail) => {
            const client = connect(endpoint, () => client.write(source));
            const chunks = [];
            client.setTimeout(3000, () => client.destroy(new Error('normal IPC timed out')));
            client.on('data', chunk => { chunks.push(chunk); if (Buffer.concat(chunks).length >= source.length) { client.end(); done(Buffer.concat(chunks)); } });
            client.on('error', fail);
        });
        assert.deepEqual(returned, source);
        return { normalRoundTrip: true, bytes: source.length };
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(done => server.close(done));
    }
});
await check('self-owned-two-write-roots', async () => {
    const roots = ['工作区一', '素材与输出二'].map(name => join(trialRoot, name));
    for (const root of roots) {
        await mkdir(root);
        const file = join(root, '正常材料.txt');
        await writeFile(file, '正常输入\n', { encoding: 'utf8', flag: 'wx' });
        assert.equal(await readFile(file, 'utf8'), '正常输入\n');
    }
    const disk = await statfs(trialRoot);
    return { roots, availableBytes: disk.bavail * disk.bsize };
});
report.finishedAt = new Date().toISOString();
await check('normal-owned-child-cancel', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let timeout;
    let closed = false;
    const closedResult = new Promise((done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => { closed = true; done({ code, signal }); });
    });
    try {
        await new Promise((done, fail) => {
            timeout = setTimeout(() => fail(new Error('owned child readiness timed out')), 5000);
            child.stdout.once('data', data => { if (data.toString('utf8').includes('ready')) done(); });
            child.once('error', fail);
        });
        clearTimeout(timeout);
        const pid = child.pid;
        assert.ok(pid);
        const requested = child.kill('SIGTERM');
        assert.equal(requested, true);
        const result = await Promise.race([closedResult, new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error('owned child cancellation timed out')), 5000); })]);
        clearTimeout(timeout);
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
        assert.equal(alive, false);
        return { pid, requested, closed, aliveAfterClose: alive, result };
    } finally {
        clearTimeout(timeout);
        if (!closed) { child.kill('SIGTERM'); await closedResult; }
    }
});
report.materialFiles = [];
for (const file of [join(trialRoot, '正常会话.sqlite'), join(trialRoot, '工作区一', '正常材料.txt'), join(trialRoot, '素材与输出二', '正常材料.txt')]) {
    const bytes = await readFile(file);
    report.materialFiles.push({ path: file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
report.finishedAt = new Date().toISOString();
report.peakRssKiB = process.resourceUsage().maxRSS;
report.passed = report.errors.length === 0;
await writeFile(join(trialRoot, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + '\n');
if (!report.passed) process.exitCode = 1;
