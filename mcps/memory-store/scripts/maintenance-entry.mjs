import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const configPath = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'provide the local machine configuration path');
const action = process.argv[3] || 'verify';
assert.ok(['verify', 'activate', 'restore'].includes(action), 'unsupported maintenance action');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function scopedPath(root, relative) {
    assert.equal(typeof relative, 'string');
    assert.ok(relative && !path.isAbsolute(relative));
    const resolved = path.resolve(root, relative);
    const within = path.relative(path.resolve(root), resolved);
    assert.ok(within && !within.startsWith('..' + path.sep) && within !== '..' && !path.isAbsolute(within));
    let current = resolved;
    while (current !== path.resolve(root)) {
        assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'release payload must not contain links');
        current = path.dirname(current);
    }
    return resolved;
}

function identity(value, label) {
    assert.ok(typeof value === 'string' && value.trim(), `${label} must be a nonempty string`);
}

function executeAdapter(selectedAction) {
    const adapter = config.actions?.[selectedAction];
    assert.ok(adapter && path.isAbsolute(adapter.interpreter) && path.isAbsolute(adapter.file));
    assert.equal(digest(fs.readFileSync(adapter.file)), adapter.sha256, 'machine adapter changed since verification');
    assert.ok(Array.isArray(adapter.arguments) && adapter.arguments.every(argument => typeof argument === 'string'));
    const prefix = adapter.interpreterArguments || [];
    assert.ok(Array.isArray(prefix) && prefix.every(argument => typeof argument === 'string'));
    const child = spawnSync(adapter.interpreter, [...prefix, adapter.file, ...adapter.arguments], {
        cwd: path.dirname(adapter.file), env: process.env, stdio: 'inherit', shell: false,
    });
    if (child.error) throw child.error;
    assert.equal(child.signal, null, 'machine adapter ended by signal');
    assert.equal(child.status, 0, 'machine adapter reported an incomplete maintenance action');
}

identity(config.taskId, 'configuration taskId');
if (action === 'restore') {
    identity(config.expectedPreviousVersion, 'recovery previous version');
    executeAdapter('restore');
    console.log(JSON.stringify({ action, completed: true, requestedPreviousVersion: config.expectedPreviousVersion }));
} else {
    assert.ok(path.isAbsolute(config.releaseRoot));
    const manifest = JSON.parse(fs.readFileSync(path.join(config.releaseRoot, 'release-manifest.json'), 'utf8'));
    for (const field of ['version', 'commit', 'taskId']) identity(manifest[field], `manifest ${field}`);
    identity(config.expectedVersion, 'configuration version');
    identity(config.expectedCommit, 'configuration commit');
    assert.equal(manifest.version, config.expectedVersion);
    assert.equal(manifest.commit, config.expectedCommit);
    assert.equal(manifest.taskId, config.taskId);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
    const paths = new Set();
    for (const entry of manifest.files) {
        assert.ok(!paths.has(entry.path), 'duplicate release manifest path');
        paths.add(entry.path);
        const target = scopedPath(config.releaseRoot, entry.path);
        const buffer = fs.readFileSync(target);
        assert.equal(buffer.length, entry.bytes, 'release payload size mismatch');
        assert.equal(digest(buffer), entry.sha256, 'release payload checksum mismatch');
    }
    if (action === 'activate') executeAdapter('activate');
    console.log(JSON.stringify({ action, completed: true, releaseVersion: manifest.version, commit: manifest.commit, files: paths.size }));
}
