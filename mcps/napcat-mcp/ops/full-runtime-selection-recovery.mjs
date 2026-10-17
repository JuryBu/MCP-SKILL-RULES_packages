import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertRecoveryExited } from './full-runtime-recovery-proof.mjs';

const fail = code => { throw new Error(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const inside = (root, filename) => { const relative = path.relative(root, filename); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
export function selectionFileHash(filename) {
  const descriptor = fs.openSync(filename, 'r');
  const result = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) result.update(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return result.digest('hex');
}
function plain(filename, directory = false) {
  if (!path.isAbsolute(filename)) fail('OFFLINE_ABSOLUTE_PATH_REQUIRED');
  let current = path.resolve(filename);
  const original = fs.lstatSync(current);
  if (!(directory ? original.isDirectory() : original.isFile())) fail('OFFLINE_PATH_KIND_CHANGED');
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('OFFLINE_LINK_FORBIDDEN');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function pin(filename, expected) {
  plain(filename);
  if (!/^[a-f0-9]{64}$/u.test(expected) || selectionFileHash(filename) !== expected) fail('OFFLINE_PIN_CHANGED:' + filename);
}
export function readSelectionRecovery(filename, expected) {
  pin(filename, expected);
  const config = read(filename);
  if (config.schemaVersion !== 1 || !['ManualProduction', 'TempFixture'].includes(config.mode)) fail('OFFLINE_CONFIGURATION_INVALID');
  const startupProtection = config.startupProtection ?? 'desktop-gate';
  if (!['desktop-gate', 'backend-stop'].includes(startupProtection)) fail('OFFLINE_STARTUP_PROTECTION_INVALID');
  if (!Array.isArray(config.pins) || config.pins.length > 1024) fail('OFFLINE_PINS_INVALID');
  for (const item of config.pins) pin(item.path, item.sha256);
  for (const required of [config.entryPath, config.ioPath, config.proofPath, config.nodePath, config.profilePath, config.sourceRegistryPath, config.targetRegistryPath, ...(config.fenceFiles ?? [])]) {
    if (!config.pins.some(item => same(item.path, required))) fail('OFFLINE_REQUIRED_PIN_MISSING');
  }
  if (!same(config.ioPath, fileURLToPath(import.meta.url)) || !same(config.proofPath, fileURLToPath(new URL('./full-runtime-recovery-proof.mjs', import.meta.url)))) fail('OFFLINE_HELPER_BINDING_CHANGED');
  const profile = read(config.profilePath);
  if (!same(config.registryPath, path.join(profile.stateRoot, 'inner-candidate-approvals.json'))
    || !same(config.stopPath, profile.outerPaths.stopFilePath) || !same(config.recoveryGuardPath, profile.outerPaths.lockPath + '.recovery')) fail('OFFLINE_PROFILE_PATH_CHANGED');
  plain(profile.stateRoot, true);
  plain(path.dirname(config.stopPath), true);
  plain(path.dirname(filename), true);
  if (startupProtection === 'desktop-gate') plain(config.startupGatePath);
  else {
    const backend = config.backendStartup;
    if (!backend || profile.schemaVersion !== 1 || profile.mode !== 'production'
      || typeof profile.installationRoot !== 'string' || typeof profile.outerStateRoot !== 'string'
      || typeof backend.entryPath !== 'string' || typeof backend.runnerPath !== 'string' || typeof backend.configurationPath !== 'string') fail('OFFLINE_BACKEND_BINDING_REQUIRED');
    const installationRoot = profile.installationRoot;
    const outerStateRoot = profile.outerStateRoot;
    if (!same(backend.entryPath, path.join(installationRoot, 'ops/start-codex-app-server-proxy.ps1'))
      || !same(outerStateRoot, path.join(path.dirname(outerStateRoot), 'state'))
      || !same(backend.runnerPath, path.join(installationRoot, 'src/codex-app-server-proxy-runner.mjs'))
      || !same(backend.configurationPath, path.join(outerStateRoot, 'codex-outer-runtime-startup.json'))
      || !same(config.stopPath, path.join(outerStateRoot, 'codex-app-server-proxy.stop'))
      || !same(profile.outerPaths.lockPath, path.join(outerStateRoot, 'codex-app-server-proxy.lock'))
      || !inside(outerStateRoot, config.profilePath) || !inside(outerStateRoot, profile.stateRoot)) fail('OFFLINE_BACKEND_BINDING_CHANGED');
    for (const required of [backend.entryPath, backend.runnerPath, backend.configurationPath,
      path.join(installationRoot, 'ops/resolve-codex-outer-runtime-startup.ps1'),
      path.join(installationRoot, 'ops/resolve-napcat-data-root.ps1'), path.join(installationRoot, 'src/inner-runtime-profile.mjs')]) {
      if (!config.pins.some(item => same(item.path, required))) fail('OFFLINE_BACKEND_PIN_MISSING');
    }
    const startup = read(backend.configurationPath);
    if (startup.schemaVersion !== 1 || startup.enabled !== true || typeof startup.innerManagedProfilePath !== 'string'
      || !same(startup.innerManagedProfilePath, config.profilePath)
      || startup.innerManagedProfileSha256 !== selectionFileHash(config.profilePath)
      || typeof startup.candidateRoot !== 'string' || !inside(path.dirname(outerStateRoot), startup.candidateRoot)) fail('OFFLINE_BACKEND_PROFILE_CHANGED');
    plain(startup.candidateRoot, true);
    const mutexPath = config.registryPath + '.offline-recovery.lock';
    if (fs.existsSync(mutexPath)) {
      plain(mutexPath);
      if (fs.statSync(mutexPath).nlink !== 1) fail('OFFLINE_MUTEX_HARDLINK');
    }
  }
  plain(config.registryPath);
  if (fs.existsSync(config.stopPath)) {
    plain(config.stopPath);
    if (fs.statSync(config.stopPath).nlink !== 1) fail('OFFLINE_STOP_HARDLINK');
  }
  const stateOwnerPath = path.join(profile.stateRoot, '.inner-runtime-owner.json');
  if (!config.pins.some(item => same(item.path, stateOwnerPath))) fail('OFFLINE_STATE_OWNER_PIN_MISSING');
  const owner = read(stateOwnerPath);
  if (owner.kind !== 'state' || owner.ownerId !== profile.ownerId || owner.nativeSourceId !== profile.nativeSourceId) fail('OFFLINE_STATE_OWNER_CHANGED');
  const original = read(config.sourceRegistryPath);
  const target = read(config.targetRegistryPath);
  const without = value => { const copy = structuredClone(value); delete copy.selection; return copy; };
  if (JSON.stringify(without(original)) !== JSON.stringify(without(target))) fail('OFFLINE_NON_SELECTION_CHANGE');
  if (!target.selection || !original.selection || target.selection.candidateId === original.selection.candidateId
    || !Array.isArray(target.candidates) || target.candidates.length > 4) fail('OFFLINE_SELECTION_INVALID');
  for (const selection of [original.selection, target.selection]) {
    const candidate = target.candidates.find(item => same(path.join(item.installationRoot, 'src/manifest.json'), selection.manifestPath));
    if (!candidate || candidate.id !== selection.candidateId || !inside(config.candidateRoot, candidate.installationRoot)) fail('OFFLINE_CANDIDATE_NOT_REGISTERED');
    const candidateOwnerPath = path.join(candidate.installationRoot, '.inner-runtime-owner.json');
    plain(candidateOwnerPath);
    const candidateOwner = read(candidateOwnerPath);
    if (candidateOwner.kind !== 'candidate' || candidateOwner.ownerId !== owner.ownerId || candidateOwner.nativeSourceId !== owner.nativeSourceId) fail('OFFLINE_CANDIDATE_OWNER_CHANGED');
    pin(selection.manifestPath, selection.manifestSha256);
    const manifest = read(selection.manifestPath);
    if (manifest.schemaVersion !== 1 || manifest.entry !== 'proxy.cjs' || manifest.format !== 'commonjs-bundle'
      || manifest.stateSchema !== 'proxy-live-state-v1' || !Array.isArray(manifest.files) || manifest.files.length !== 48
      || new Set(manifest.files.map(item => item.path)).size !== 48) fail('OFFLINE_MANIFEST_INVALID');
    for (const item of manifest.files) {
      if (!/^[A-Za-z0-9_.-]+$/u.test(item.path)) fail('OFFLINE_MANIFEST_PATH_INVALID');
      const file = path.join(path.dirname(selection.manifestPath), item.path);
      pin(file, item.sha256);
      if (fs.statSync(file).nlink !== 1) fail('OFFLINE_PACKAGE_HARDLINK');
    }
    if (!selection.compatibility || hash(JSON.stringify(selection.compatibility.manifest)) !== selection.compatibility.sha256) fail('OFFLINE_COMPATIBILITY_CHANGED');
    const names = { runner: 'codex-model-stream-proxy-runner.mjs', core: 'codex-model-stream-proxy.mjs', helper: 'thread-recovery-handoff.mjs', control: 'inner-runner-handoff-control.mjs' };
    for (const [name, filename] of Object.entries(names)) {
      if (manifest.files.find(item => item.path === filename)?.sha256 !== candidate.expectedHashes?.[name]) fail('OFFLINE_CANDIDATE_SOURCE_CHANGED');
    }
    const sourceHashes = profile.initial?.expectedHashes;
    if (!selection.compatibility.manifest.edges?.some(edge => edge.source?.core === sourceHashes?.core && edge.source?.helper === sourceHashes?.helper
      && edge.target?.core === candidate.expectedHashes.core && edge.target?.helper === candidate.expectedHashes.helper
      && edge.checkpointSchemaVersion === 1 && edge.stateSchemaVersion === 1 && edge.stateSemantics === 'state-v1')) fail('OFFLINE_COMPATIBILITY_EDGE_MISSING');
  }
  if (!Array.isArray(config.ports) || config.ports.length < 5 || new Set(config.ports).size !== config.ports.length
    || config.ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) fail('OFFLINE_PORTS_INVALID');
  if (!Array.isArray(config.capturedProcesses) || config.capturedProcesses.length < 2) fail('OFFLINE_CAPTURE_REQUIRED');
  if (!Array.isArray(config.fenceFiles) || config.fenceFiles.length < 3) fail('OFFLINE_FENCE_PINS_REQUIRED');
  if (config.mode === 'TempFixture') {
    plain(config.fixtureRoot, true);
    if (!inside(os.tmpdir(), config.fixtureRoot) || read(path.join(config.fixtureRoot, 'offline-owner.json')).ownerId !== 'offline-selection-test') fail('OFFLINE_FIXTURE_OWNER_REQUIRED');
    for (const file of [filename, config.registryPath, config.profilePath, config.sourceRegistryPath, config.targetRegistryPath,
      config.stopPath, config.recoveryGuardPath, config.candidateRoot,
      ...(startupProtection === 'desktop-gate' ? [config.startupGatePath] : [config.backendStartup.configurationPath])]) {
      if (!inside(config.fixtureRoot, file)) fail('OFFLINE_FIXTURE_ESCAPE');
    }
  } else if (config.faultAfterReplace || config.faultAfterStop) fail('OFFLINE_FIXTURE_FAULT_FORBIDDEN');
  const registrySha256 = selectionFileHash(config.registryPath);
  const sourceSha256 = selectionFileHash(config.sourceRegistryPath);
  const targetSha256 = selectionFileHash(config.targetRegistryPath);
  if (![sourceSha256, targetSha256].includes(registrySha256)) fail('OFFLINE_REGISTRY_DRIFT');
  return { config, profile, sourceSha256, targetSha256, registrySha256 };
}
export function assertOfflineSelectionStopped(context, snapshot) {
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.now() - Date.parse(snapshot.observedAt) > 10000 || Date.parse(snapshot.observedAt) > Date.now()) fail('OFFLINE_SNAPSHOT_STALE');
  for (const process of snapshot.processes ?? []) {
    const name = String(process.name ?? '').toLowerCase();
    if (/^(node|codex|chatgpt|powershell|pwsh|wscript|cscript)\.exe$/u.test(name)
      && (!process.commandLine || !process.executablePath || !process.creationDate)) fail('OFFLINE_PROCESS_IDENTITY_UNKNOWN');
    if (/codex-app-server-proxy-runner\.mjs|codex-model-stream-proxy-runner\.mjs|recover-inner-startup\.mjs|start-codex-app-server-proxy\.ps1|start-codex-model-stream-proxy\.ps1|[\\/]launch\.ps1/iu.test(process.commandLine ?? '')) fail('OFFLINE_STARTUP_PROCESS_PRESENT');
    if ((context.config.startupProtection ?? 'desktop-gate') === 'backend-stop'
      && [context.config.backendStartup.entryPath, context.config.backendStartup.runnerPath]
        .some(filename => String(process.commandLine ?? '').toLowerCase().includes(filename.toLowerCase()))) fail('OFFLINE_STARTUP_PROCESS_PRESENT');
  }
  return assertRecoveryExited({ capturedProcesses: context.config.capturedProcesses, ports: context.config.ports,
    processes: snapshot.processes, listeners: snapshot.listeners });
}
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const [, , filename, expected, action = 'Inspect'] = process.argv;
    const context = readSelectionRecovery(filename, expected);
    if (action === 'Check') assertOfflineSelectionStopped(context, JSON.parse(fs.readFileSync(0, 'utf8')));
    else if (action !== 'Inspect') fail('OFFLINE_ACTION_INVALID');
    console.log(JSON.stringify({ status: action === 'Check' ? 'OFFLINE_STOPPED_CONFIRMED' : 'OFFLINE_MATERIAL_PREPARED',
      sourceSha256: context.sourceSha256, targetSha256: context.targetSha256, registrySha256: context.registrySha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
