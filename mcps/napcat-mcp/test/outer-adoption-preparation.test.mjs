import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const names = [...fs.readFileSync(script, 'utf8').split('$FileNames = @(')[1].split('\n)')[0].matchAll(/'([^']+)'/gu)].map(match => match[1]);

function write(rootPath, relative, value) {
  const target = path.join(rootPath, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function inventory(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const full = path.join(entry.parentPath, entry.name);
    return [path.relative(directory, full), digest(fs.readFileSync(full))];
  }).sort((left, right) => left[0].localeCompare(right[0]));
}

function fixture(context) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-adoption-preparation-'));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const installed = path.join(base, 'installed');
  const data = path.join(base, 'data');
  const output = path.join(base, 'output');
  for (const directory of [source, installed, data]) fs.mkdirSync(directory);
  for (const [index, name] of names.entries()) {
    write(source, name, `candidate ${name}\n`);
    if (index > 0) write(installed, name, index % 2 ? `old ${name}\n` : `candidate ${name}\n`);
  }
  for (const directory of [source, installed]) write(directory, 'node_modules/ws/package.json', '{"name":"ws","version":"fixture"}');
  write(installed, 'src/codex-model-stream-proxy.mjs', 'original inner untouched');
  write(data, 'state/codex-app-server-wake-journal.json', '{"privateFixture":true}');
  write(data, 'state/codex-app-server-proxy-token.txt', 'private fixture token');
  const invoke = (overrides = {}) => {
    const values = { SourceRoot: source, InstalledRoot: installed, DataRoot: data, PreparationRoot: output, OwnerId: 'preparation-test', ...overrides };
    return spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...Object.entries(values).flatMap(([key, value]) => [`-${key}`, value])], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
  };
  return { base, source, installed, data, output, invoke };
}

test('preparation captures exact outer files and original ACLs without changing installation or runtime state', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  const before = { installed: inventory(example.installed), data: inventory(example.data), source: inventory(example.source) };
  const result = example.invoke();
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  const manifest = JSON.parse(fs.readFileSync(response.path, 'utf8'));
  assert.equal(response.prepared, true);
  assert.equal(response.readyForProduction, false);
  assert.equal(response.productionChanged, false);
  assert.equal(response.sha256, digest(fs.readFileSync(response.path)));
  assert.equal(manifest.files.length, 19);
  assert.ok(manifest.files.some(entry => entry.name === 'src/codex-request-metadata.mjs'));
  assert.ok(manifest.files.some(entry => entry.operation === 'replace'));
  assert.ok(manifest.files.some(entry => entry.operation === 'add'));
  assert.ok(manifest.files.some(entry => entry.operation === 'unchanged'));
  for (const entry of manifest.files) {
    assert.equal(digest(fs.readFileSync(path.join(example.output, 'candidate', entry.name))), entry.candidate.sha256);
    if (entry.original.exists) {
      assert.equal(digest(fs.readFileSync(path.join(example.output, 'original', entry.name))), entry.original.sha256);
      assert.ok(entry.original.sddl.includes('D:'));
    }
  }
  assert.equal(manifest.recovery.executableEntryPrepared, false);
  assert.equal(manifest.dependency.copied, true);
  assert.equal(fs.readFileSync(path.join(example.output, 'original/node_modules/ws/package.json'), 'utf8'), '{"name":"ws","version":"fixture"}');
  assert.equal(manifest.startup.candidate.candidateRoot, path.join(example.data, 'state', 'codex-outer-runtime-candidates'));
  assert.deepEqual({ installed: inventory(example.installed), data: inventory(example.data), source: inventory(example.source) }, before);
  assert.equal(inventory(example.output).some(([name]) => /token|journal|model-stream-proxy/u.test(name)), false);
});

test('legacy inline data-root entry preserves a previously absent helper for independent recovery', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  fs.unlinkSync(path.join(example.installed, 'ops/resolve-napcat-data-root.ps1'));
  const result = example.invoke();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(example.output, 'preparation.json'), 'utf8'));
  const helper = manifest.files.find(entry => entry.name === 'ops/resolve-napcat-data-root.ps1');
  assert.equal(helper.operation, 'add');
  assert.equal(helper.original.exists, false);
});

test('missing request metadata dependency is refused before output creation', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  fs.unlinkSync(path.join(example.source, 'src/codex-request-metadata.mjs'));
  const result = example.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PREPARATION_REQUIRED_FILE_MISSING: src\/codex-request-metadata.mjs/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('preparation preserves original opt-in configuration in its independent backup', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  const original = '{"schemaVersion":1,"enabled":false}';
  write(example.data, 'state/codex-outer-runtime-startup.json', original);
  const result = example.invoke();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(example.output, 'preparation.json'), 'utf8'));
  assert.equal(manifest.startup.original.exists, true);
  assert.equal(fs.readFileSync(path.join(example.output, 'original-startup.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(example.data, 'state/codex-outer-runtime-startup.json'), 'utf8'), original);
});

test('missing candidate or unequal ws package is refused before output creation', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  write(example.installed, 'node_modules/ws/package.json', '{"version":"different"}');
  let result = example.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PREPARATION_WS_DEPENDENCY_DIFFERS/u);
  assert.equal(fs.existsSync(example.output), false);
  fs.unlinkSync(path.join(example.source, names[0]));
  result = example.invoke();
  assert.match(result.stderr, /PREPARATION_REQUIRED_FILE_MISSING/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('existing preparation is left intact and cannot be silently regenerated', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  assert.equal(example.invoke().status, 0);
  const before = inventory(example.output);
  const result = example.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PREPARATION_NEW_OUTPUT_REQUIRED/u);
  assert.deepEqual(inventory(example.output), before);
});

test('output must be separate from inputs and within the current temporary directory', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  const inSource = path.join(example.source, 'output');
  let result = example.invoke({ PreparationRoot: inSource });
  assert.match(result.stderr, /PREPARATION_OUTPUT_OVERLAPS_INPUT/u);
  assert.equal(fs.existsSync(inSource), false);
  result = example.invoke({ PreparationRoot: 'C:/outer-adoption-preparation-test-no-write' });
  assert.match(result.stderr, /PREPARATION_TEMP_OUTPUT_REQUIRED/u);
});

test('junction output and nested candidate paths cannot redirect preparation writes or reads', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  const junction = path.join(example.base, 'junction');
  fs.symlinkSync(example.source, junction, 'junction');
  const result = example.invoke({ PreparationRoot: path.join(junction, 'output') });
  assert.match(result.stderr, /PREPARATION_REPARSE_POINT_REJECTED/u);
  assert.equal(fs.existsSync(path.join(example.source, 'output')), false);
  fs.renameSync(path.join(example.source, 'src'), path.join(example.base, 'relocated-src'));
  fs.symlinkSync(path.join(example.base, 'relocated-src'), path.join(example.source, 'src'), 'junction');
  const readResult = example.invoke();
  assert.match(readResult.stderr, /PREPARATION_REPARSE_POINT_REJECTED/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('dependency implementation drift is refused even when package metadata is identical', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  write(example.source, 'node_modules/ws/lib/websocket.js', 'expected implementation');
  write(example.installed, 'node_modules/ws/lib/websocket.js', 'unexpected implementation');
  const result = example.invoke();
  assert.match(result.stderr, /PREPARATION_WS_DEPENDENCY_DIFFERS/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('dependency junction is rejected before following its directory', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  const redirected = path.join(example.base, 'redirected-ws');
  fs.mkdirSync(redirected);
  write(redirected, 'outside.js', 'not an accepted dependency');
  fs.symlinkSync(redirected, path.join(example.source, 'node_modules/ws/lib'), 'junction');
  const result = example.invoke();
  assert.match(result.stderr, /PREPARATION_REPARSE_POINT_REJECTED/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('the original normal entry is required before recovery material can be prepared', { skip: process.platform !== 'win32' }, context => {
  const example = fixture(context);
  fs.unlinkSync(path.join(example.installed, 'ops/start-codex-app-server-proxy.ps1'));
  const result = example.invoke();
  assert.match(result.stderr, /PREPARATION_REQUIRED_FILE_MISSING/u);
  assert.equal(fs.existsSync(example.output), false);
});

test('fixed preparation file set covers the current outer static module dependencies', () => {
  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return;
    assert.ok(names.includes(name), `Missing dependency: ${name}`);
    visited.add(name);
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(|import\s*)['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)));
      else assert.ok(specifier.startsWith('node:') || specifier === 'ws', `Unlisted external dependency: ${specifier}`);
    }
  };
  visit('src/codex-app-server-proxy-runner.mjs');
  visit('ops/codex-outer-runtime.mjs');
});
