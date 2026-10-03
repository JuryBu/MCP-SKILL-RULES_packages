import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-entry-'));
const entry = fileURLToPath(new URL('../scripts/maintenance-entry.mjs', import.meta.url));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
try {
    const payload = Buffer.from('verified candidate');
    fs.mkdirSync(path.join(root, 'component'));
    fs.writeFileSync(path.join(root, 'component/payload.txt'), payload);
    const manifest = { taskId: 'fixture-task', version: 'fixture-version', commit: 'fixture-commit',
        files: [{ path: 'component/payload.txt', bytes: payload.length, sha256: digest(payload) }] };
    const adapterFile = path.join(root, 'adapter.mjs');
    fs.writeFileSync(adapterFile, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "completed");');
    const resultFile = path.join(root, 'adapter-result.txt');
    const configuration = { releaseRoot: root, expectedVersion: manifest.version, expectedCommit: manifest.commit,
        taskId: manifest.taskId, expectedPreviousVersion: 'prior-version', actions: {
            activate: { interpreter: process.execPath, file: adapterFile, sha256: digest(fs.readFileSync(adapterFile)), arguments: [resultFile] },
            restore: { interpreter: process.execPath, file: adapterFile, sha256: digest(fs.readFileSync(adapterFile)), arguments: [resultFile] },
        } };
    const manifestFile = path.join(root, 'release-manifest.json');
    const configFile = path.join(root, 'machine.private.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(configFile, JSON.stringify(configuration));
    const run = action => spawnSync(process.execPath, [entry, configFile, action], { encoding: 'utf8' });
    assert.equal(run('verify').status, 0);
    assert.equal(fs.existsSync(resultFile), false);
    assert.equal(run('activate').status, 0);
    assert.equal(fs.readFileSync(resultFile, 'utf8'), 'completed');
    delete configuration.taskId;
    delete manifest.taskId;
    fs.writeFileSync(configFile, JSON.stringify(configuration));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.notEqual(run('verify').status, 0);
    configuration.taskId = 'fixture-task';
    manifest.taskId = 'fixture-task';
    configuration.expectedCommit = 'different-commit';
    fs.writeFileSync(configFile, JSON.stringify(configuration));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.notEqual(run('verify').status, 0);
    configuration.expectedCommit = manifest.commit;
    fs.writeFileSync(configFile, JSON.stringify(configuration));
    fs.writeFileSync(adapterFile, 'process.exit(0)');
    assert.notEqual(run('activate').status, 0);
    assert.notEqual(run('restore').status, 0);
    assert.equal(fs.readFileSync(resultFile, 'utf8'), 'completed');
    fs.writeFileSync(adapterFile, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "completed");');
    fs.writeFileSync(path.join(root, 'component/payload.txt'), 'corrupt payload');
    assert.notEqual(run('verify').status, 0);
    assert.equal(run('restore').status, 0);
    assert.equal(fs.readFileSync(resultFile, 'utf8'), 'completed');
    manifest.files[0].path = '../outside.txt';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.notEqual(run('verify').status, 0);
    fs.unlinkSync(manifestFile);
    assert.equal(run('restore').status, 0);
    console.log('maintenance entry: payload, identity, adapter drift, activation and traversal checks passed');
} finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('memory-maintenance-entry-'));
    fs.rmSync(root, { recursive: true, force: true });
}
