import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, 'ops/invoke-inner-first-adoption-owner.ps1');
const filesEntry = path.join(root, 'ops/invoke-inner-first-adoption-files.ps1');
const acceptedFilesSha = 'd5a60a21e90c36355d4f982d77caadbd337c561bc57b56e9fca17b28fc0b6af2';
const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const enabled = process.platform === 'win32';
const nativeInput = process.env.INNER_OWNER_NATIVE_CONFIG;
const nativeOnly = Boolean(nativeInput);
const normalSupportNames = ['owned-stop-marker.ps1', 'stop-codex-app-server-proxy.ps1', 'resolve-napcat-data-root.ps1'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = target => digest(fs.readFileSync(target));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const output = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'inner-first-adoption-owner-evidence-')) : null;
const evidence = { schemaVersion: 1, productionExecuted: false, officialNativeExecuted: false, paidModelCalls: 0,
  ownerEntrySha256: sha(entry), filesEntrySha256: sha(filesEntry), commands: [], cases: [], resources: [] };
const fixtureProcesses = [];
const upstreamServers = [];
let operatorSid;
let executionEnvironment = { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath };

async function run(args, timeout = 150000) {
  const startedAtUtc = new Date().toISOString();
  const child = spawn(shell, args, { windowsHide: true, env: executionEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { status: null, stdout: '', stderr: '', pid: child.pid };
  child.stdout.on('data', bytes => { result.stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { result.stderr += bytes.toString(); });
  await new Promise(resolve => {
    const timer = setTimeout(() => { result.error = new Error('WINDOWS_PARENT_EXIT_UNKNOWN_NO_REPLAY'); resolve(); }, timeout);
    child.once('error', error => { clearTimeout(timer); result.error = error; resolve(); });
    child.once('exit', (status, signal) => { clearTimeout(timer); result.status = status; result.signal = signal; setTimeout(resolve, 30); });
  });
  child.stdout.destroy(); child.stderr.destroy();
  evidence.commands.push({ command: [shell, ...args], startedAtUtc, finishedAtUtc: new Date().toISOString(),
    actualexit: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  return result;
}
async function command(body) {
  const result = await run(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ${body}`]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
async function invoke(context, action = 'Adopt', { script = entry, failProbe = false, deferRestore = false, requireIndependent = false, confirmation = true } = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Action', action, '-Mode', 'TempFixture',
    '-OwnerManifestPath', context.ownerPath, '-OwnerManifestSha256', sha(context.ownerPath)];
  if (confirmation) args.push('-OwnerConfirmation', `${context.ownerId}|${context.transactionId}|${action}|${sha(context.ownerPath)}`);
  if (failProbe) args.push('-FixtureFailProbe');
  if (deferRestore) args.push('-FixtureDeferRestore');
  if (requireIndependent) args.push('-FixtureRequireIndependentTerminal');
  const result = await run(args);
  assert.ok(!result.error, result.error?.message);
  return { ...result, response: JSON.parse(result.stdout.trim()) };
}
function write(base, name, bytes) {
  const target = path.join(base, name); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes)); return target;
}
async function port() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`TIMEOUT:${label}`);
}
function support(base, sourceRoot = path.join(root, 'ops')) {
  const supportRoot = path.join(base, 'owner-support');
  const files = normalSupportNames.map(name => {
    const target = write(base, `owner-support/${name}`, fs.readFileSync(path.join(sourceRoot, name)));
    return { name, sha256: sha(target) };
  });
  return { root: supportRoot, files };
}
const sourceModules = {
  'src/codex-app-server-proxy-runner.mjs': 'import "./inner-managed-session.mjs"; import "./inner-runtime-profile.mjs";',
  'src/inner-managed-session.mjs': 'import "./inner-proxy-coordinator.mjs"; import "./inner-native-turn-source.mjs"; import "./codex-app-server-proxy.mjs";',
  'src/codex-app-server-proxy.mjs': 'export const fixture = "route";',
  'src/inner-proxy-coordinator.mjs': 'import "./inner-runner-handoff-control.mjs"; import "./inner-handoff-compatibility.mjs";',
  'src/inner-native-turn-source.mjs': 'export const fixture = "native";',
  'src/inner-handoff-compatibility.mjs': 'export const fixture = "compatibility";',
  'src/inner-migration-plan.mjs': 'export const fixture = "migration";',
  'src/inner-runner-handoff-control.mjs': 'import "./inner-migration-plan.mjs";',
  'src/inner-runtime-profile.mjs': 'export const fixture = "profile";',
  'src/codex-model-stream-proxy-runner.mjs': 'import "./codex-model-stream-proxy.mjs";',
  'src/codex-model-stream-proxy.mjs': 'import "./thread-recovery-handoff.mjs";',
  'src/thread-recovery-handoff.mjs': 'export const fixture = "handoff";',
  'ops/resolve-codex-outer-runtime-startup.ps1': '$Fixture = "startup"',
};

async function fixture() {
  assert.equal(sha(filesEntry), acceptedFilesSha, 'main-pinned file transaction changed');
  operatorSid ??= await command('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress');
  const base = fs.mkdtempSync(path.join(output, 'owned-'));
  const candidateRoot = path.join(base, 'candidate'); const installedRoot = path.join(base, 'installed');
  const dataRoot = path.join(base, 'data'); const transactionRoot = path.join(base, 'transaction');
  const ownerId = 'fixture-owner'; const transactionId = crypto.randomUUID();
  const fixtureOwner = { schemaVersion: 1, scope: 'inner-first-adoption-files-v1', ownerId, transactionId, operatorSid };
  write(base, '.inner-first-adoption-fixture-owner.json', fixtureOwner);
  write(base, '.inner-first-adoption-owner-fixture.json', fixtureOwner);
  for (const directory of [candidateRoot, installedRoot, path.join(dataRoot, 'state'), path.join(dataRoot, 'outer-existing-candidate')]) fs.mkdirSync(directory, { recursive: true });
  const ports = {}; for (const name of ['control', 'downstream', 'upstream', 'probe', 'inner']) ports[name] = await port();
  const require = createRequire(path.join(root, 'package.json')); const wsPath = require.resolve('ws');
  const servicePath = write(base, 'fixture-service.mjs', `import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { createRequire } from 'node:module';
const require=createRequire(import.meta.url); const { WebSocketServer }=require(${JSON.stringify(wsPath)});
const [role,dataRoot,port,token,innerPort]=process.argv.slice(2); const state=path.join(dataRoot,'state'); const servers=[];
if(role!=='inner'){const server=new WebSocketServer({host:'127.0.0.1',port:Number(port)});servers.push(server);server.on('connection',socket=>socket.on('message',bytes=>{const request=JSON.parse(String(bytes)); fs.appendFileSync(path.join(state,'rpc.jsonl'),JSON.stringify(request)+'\\n'); if(request.id)socket.send(JSON.stringify({id:request.id,result:request.method==='initialize'?{userAgent:'codex-fixture'}:{data:[]}}));}));}
if(role==='inner'||role==='managed'){const server=net.createServer();server.listen(Number(role==='inner'?port:innerPort),'127.0.0.1');servers.push(server);}
const name=role==='inner'?'codex-model-stream-proxy':'codex-app-server-proxy';
fs.writeFileSync(path.join(state,name+'-runtime.json'),JSON.stringify({pid:process.pid,instanceToken:token,role}));
fs.appendFileSync(path.join(state,'service-order.jsonl'),JSON.stringify({role,pid:process.pid,token})+'\\n');
const watch=setInterval(()=>{if(!fs.existsSync(path.join(state,name+'.stop')))return;clearInterval(watch);for(const server of servers){if(server.clients)for(const socket of server.clients)socket.terminate();server.close();}setTimeout(()=>process.exit(0),80);},30);
`);
  const startBody = role => `param([string]$DataRoot,[int]$DownstreamPort,[int]$ControlPort,[int]$UpstreamPort,[int]$ProbePort,[int]$Port,[string]$UpstreamOrigin,[switch]$RequireNoStopMarker,[string]$ExpectedInstanceToken,[string]$LaunchReceiptPath,[string]$CodexExecutablePath)
$Role='${role}'; $Token=if($ExpectedInstanceToken){$ExpectedInstanceToken}else{'legacy'}
$PortValue=if($Role -eq 'inner'){$Port}else{$DownstreamPort}; $InnerPort=${ports.inner}
$Arguments=@(${quote(servicePath)},$Role,$DataRoot,[string]$PortValue,$Token,[string]$InnerPort) | ForEach-Object { '"'+$_+'"' }
$Executable=if($CodexExecutablePath){$CodexExecutablePath}else{${quote(process.execPath)}}
$Child=Start-Process -FilePath $Executable -ArgumentList ($Arguments -join ' ') -WindowStyle Hidden -PassThru
$RuntimePath=Join-Path $DataRoot $(if($Role -eq 'inner'){'state/codex-model-stream-proxy-runtime.json'}else{'state/codex-app-server-proxy-runtime.json'})
$Deadline=[DateTime]::UtcNow.AddSeconds(5);do{if(Test-Path -LiteralPath $RuntimePath){$Runtime=Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8|ConvertFrom-Json;if($Runtime.pid -eq $Child.Id){break}};Start-Sleep -Milliseconds 50}while([DateTime]::UtcNow -lt $Deadline)
if(-not $Runtime -or $Runtime.pid -ne $Child.Id){throw 'FIXTURE_START_FAILED'}
if($Role -eq 'inner'){@{running=$true;changed=$true;pid=$Child.Id;instanceToken=$Token}|ConvertTo-Json -Compress}else{@{started=$true;state='running';pid=$Child.Id}|ConvertTo-Json -Compress}
`;
  const stopBody = `param([string]$DataRoot,[int]$TimeoutSeconds,[int]$ChildTimeoutSeconds,[string]$StopMarkerProofPath,[string]$StopMarkerAttemptId,[string]$StopMarkerOperationId)
. (Join-Path $PSScriptRoot 'owned-stop-marker.ps1')
$null=Assert-OwnedStopMarkerProof -ProofJson ([IO.File]::ReadAllText($StopMarkerProofPath)) -Path (Join-Path $DataRoot 'state/codex-app-server-proxy.stop') -Component proxy -AttemptId $StopMarkerAttemptId -OperationId $StopMarkerOperationId
$Runtime=Get-Content -LiteralPath (Join-Path $DataRoot 'state/codex-app-server-proxy-runtime.json') -Raw -Encoding UTF8|ConvertFrom-Json
$Deadline=[DateTime]::UtcNow.AddSeconds(5);do{$Alive=Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue;if(-not $Alive){break};Start-Sleep -Milliseconds 50}while([DateTime]::UtcNow -lt $Deadline)
@{stopped=(-not $Alive);clean=(-not $Alive);pid=$Runtime.pid}|ConvertTo-Json -Compress
`;
  const normalToolSupport = support(base);
  write(installedRoot, 'ops/start-codex-app-server-proxy.ps1', startBody('legacy'));
  write(installedRoot, 'ops/start-codex-model-stream-proxy.ps1', startBody('inner'));
  const files = [];
  for (const [name, bytes] of Object.entries({ ...sourceModules, 'ops/start-codex-app-server-proxy.ps1': startBody('managed'),
    'ops/start-codex-model-stream-proxy.ps1': startBody('inner') })) {
    const target = write(candidateRoot, name, `${bytes}\n`); files.push({ name, sha256: sha(target) });
    if (name.startsWith('src/') && name !== 'src/inner-native-turn-source.mjs') write(installedRoot, name, `export const oldFixture=${JSON.stringify(name)};`);
    if (name === 'ops/resolve-codex-outer-runtime-startup.ps1') write(installedRoot, name, '$Fixture="original"');
  }
  const expectedHashes = Object.fromEntries(Object.entries({ runner: 'codex-model-stream-proxy-runner.mjs', core: 'codex-model-stream-proxy.mjs', helper: 'thread-recovery-handoff.mjs', control: 'inner-runner-handoff-control.mjs' }).map(([name, file]) => [name, sha(path.join(candidateRoot, 'src', file))]));
  const stateRoot = path.join(dataRoot, 'state/inner-managed');
  const profile = { schemaVersion: 1, mode: 'production', ownerId, nativeSourceId: 'fixture-native', installationRoot: installedRoot,
    stateRoot, checkpointRoot: path.join(stateRoot, 'checkpoints'), outerStateRoot: path.join(dataRoot, 'state'), ports,
    initial: { runnerPath: path.join(installedRoot, 'src/codex-model-stream-proxy-runner.mjs'), expectedHashes } };
  const profileName = 'state/inner-managed/inner-managed-profile.json'; const profilePath = write(candidateRoot, profileName, profile);
  files.push({ name: profileName, sha256: sha(profilePath) });
  for (const [name, kind] of [['state/inner-managed/.inner-runtime-owner.json', 'state'], ['state/inner-managed/checkpoints/.inner-runtime-owner.json', 'checkpoint']]) {
    const markerPath = write(candidateRoot, name, { schemaVersion: 1, ownerId, nativeSourceId: profile.nativeSourceId, kind }); files.push({ name, sha256: sha(markerPath) });
  }
  const startup = { schemaVersion: 1, enabled: true, candidateRoot: path.join(dataRoot, 'outer-existing-candidate'), innerManagedProfilePath: path.join(stateRoot, 'inner-managed-profile.json'), innerManagedProfileSha256: sha(profilePath) };
  const startupPath = write(candidateRoot, 'state/codex-outer-runtime-startup.json', startup); files.push({ name: 'state/codex-outer-runtime-startup.json', sha256: sha(startupPath) });
  write(dataRoot, 'state/codex-outer-runtime-startup.json', { schemaVersion: 1, candidateRoot: startup.candidateRoot, originalStartup: true });
  write(dataRoot, 'state/conversation-account-config.json', { preserved: 'original-conversation-account' });
  for (const [role, servicePort] of [['inner', ports.inner], ['legacy', ports.downstream]]) {
    const child = spawn(process.execPath, [servicePath, role, dataRoot, String(servicePort), 'legacy', String(ports.inner)], { windowsHide: true, stdio: 'ignore' });
    fixtureProcesses.push({ child, base });
    await until(() => fs.existsSync(path.join(dataRoot, 'state', `${role === 'inner' ? 'codex-model-stream-proxy' : 'codex-app-server-proxy'}-runtime.json`)), 'initial service ready');
  }
  const protectedProcesses = await command(`@(${fixtureProcesses.filter(item => item.base === base).map(({ child }) => `$Observed=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}';@{role=${quote(child === fixtureProcesses.find(item => item.base === base).child ? 'inner' : 'outer')};pid=[int]$Observed.ProcessId;creationTimeUtc=([DateTime]$Observed.CreationDate).ToUniversalTime().ToString('o');executablePath=$Observed.ExecutablePath}`).join(';')})|ConvertTo-Json -Depth 4 -Compress`);
  const freeze = { schemaVersion: 1, scope: 'inner-first-adoption-files-v1', mode: 'TempFixture', ownerId, transactionId, operatorSid, fixtureRoot: base,
    candidateRoot, installedRoot, dataRoot, files, readOnlyDependencies: [], protectedProcesses };
  const freezePath = write(base, 'freeze.json', freeze);
  const definitions = {};
  for (const [name, file] of Object.entries({ marker: 'owned-stop-marker.ps1', stopOuter: 'stop-codex-app-server-proxy.ps1', startOuter: 'start-codex-app-server-proxy.ps1', startInner: 'start-codex-model-stream-proxy.ps1' })) {
    const target = ['marker', 'stopOuter'].includes(name) ? path.join(normalToolSupport.root, file) : path.join(installedRoot, 'ops', file); const selected = files.find(item => item.name === `ops/${file}`);
    definitions[name] = { path: target, sha256: selected?.sha256 ?? sha(target), originalSha256: sha(target) };
  }
  const spec = { schemaVersion: 1, scope: 'inner-first-adoption-owner-v1', mode: 'TempFixture', ownerId, transactionId, operatorSid, fixtureRoot: base,
    transactionRoot, filesEntry: { path: filesEntry, sha256: acceptedFilesSha }, freezeManifest: { path: freezePath, sha256: sha(freezePath) }, tools: definitions, normalToolSupport,
    codexExecutable: { path: process.execPath, sha256: sha(process.execPath) }, desktopProcesses: [],
    oldOuterParameters: { ControlPort: ports.control, DownstreamPort: ports.downstream, UpstreamPort: ports.upstream, ProbePort: ports.probe },
    oldInnerParameters: { Port: ports.inner, UpstreamOrigin: 'http://127.0.0.1' } };
  const ownerPath = write(base, 'owner.json', spec);
  const before = Object.fromEntries(files.map(item => [item.name, fs.existsSync(path.join(item.name.startsWith('state/') ? dataRoot : installedRoot, item.name)) ? sha(path.join(item.name.startsWith('state/') ? dataRoot : installedRoot, item.name)) : null]));
  return { base, candidateRoot, installedRoot, dataRoot, transactionRoot, ownerId, transactionId, ownerPath, before, freeze, spec, ports };
}
function originalsMatch(context) {
  for (const [name, original] of Object.entries(context.before)) {
    const target = path.join(name.startsWith('state/') ? context.dataRoot : context.installedRoot, name);
    assert.equal(fs.existsSync(target), original !== null, name);
    if (original !== null) assert.equal(sha(target), original, name);
  }
  if (!context.native) assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/inner-managed')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(context.dataRoot, 'state/conversation-account-config.json'), 'utf8')).preserved, 'original-conversation-account');
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/codex-app-server-proxy.stop')), false);
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/codex-model-stream-proxy.stop')), false);
}

async function nativeFixture() {
  assert.equal(sha(nativeInput), process.env.INNER_OWNER_NATIVE_CONFIG_SHA, 'immutable owner input drift');
  const originalSpec = JSON.parse(fs.readFileSync(nativeInput, 'utf8'));
  assert.equal(sha(originalSpec.freezeManifest.path), originalSpec.freezeManifest.sha256);
  const originalFreeze = JSON.parse(fs.readFileSync(originalSpec.freezeManifest.path, 'utf8'));
  const preparationPath = path.join(path.dirname(nativeInput), 'preparation.json');
  assert.equal(sha(preparationPath), process.env.INNER_OWNER_NATIVE_PREPARATION_SHA);
  const preparation = JSON.parse(fs.readFileSync(preparationPath, 'utf8'));
  const officialResultPath = process.env.INNER_OWNER_NATIVE_OFFICIAL_RESULT;
  assert.equal(sha(officialResultPath), process.env.INNER_OWNER_NATIVE_OFFICIAL_RESULT_SHA);
  const official = JSON.parse(fs.readFileSync(officialResultPath, 'utf8'));
  const frozenSource = path.join(official.root, 'source-build');
  operatorSid ??= await command('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress');
  const base = fs.mkdtempSync(path.join(output, 'native-owned-'));
  const candidateRoot = path.join(base, 'candidate'); const installedRoot = path.join(base, 'installed');
  const dataRoot = path.join(base, 'data'); const transactionRoot = path.join(base, 'transaction');
  const fixtureHome = path.join(base, 'codex-home'); const ownerId = 'official-owner-fixture'; const transactionId = crypto.randomUUID();
  const fixtureOwner = { schemaVersion: 1, scope: 'inner-first-adoption-files-v1', ownerId, transactionId, operatorSid };
  write(base, '.inner-first-adoption-fixture-owner.json', fixtureOwner);
  write(base, '.inner-first-adoption-owner-fixture.json', fixtureOwner);
  for (const directory of [candidateRoot, installedRoot, path.join(dataRoot, 'state'), fixtureHome]) fs.mkdirSync(directory, { recursive: true });
  const copiedInputs = [];
  for (const item of preparation.sourceManifest) {
    const selected = path.join(frozenSource, item.name);
    assert.equal(sha(selected), item.sha256, `official frozen source:${item.name}`);
    write(candidateRoot, item.name, fs.readFileSync(selected));
    const old = path.join(originalFreeze.installedRoot, item.name);
    if (fs.existsSync(old)) {
      const bytes = fs.readFileSync(old); write(installedRoot, item.name, bytes);
      copiedInputs.push({ name: item.name, candidateSha256: item.sha256, originalSha256: digest(bytes) });
    } else copiedInputs.push({ name: item.name, candidateSha256: item.sha256, originalSha256: null });
  }
  const normalToolSupport = support(base, originalSpec.normalToolSupport.root);
  assert.deepEqual(normalToolSupport.files, originalSpec.normalToolSupport.files);
  const ports = {}; for (const name of ['control', 'downstream', 'upstream', 'probe', 'inner']) ports[name] = await port();
  const upstream = http.createServer((request, response) => { evidence.resources.push({ forbiddenModelRequest: request.url }); response.writeHead(503); response.end('NO_MODEL_CALLS_IN_OWNER_FIXTURE'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamServers.push(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const profile = JSON.parse(fs.readFileSync(path.join(originalFreeze.candidateRoot, 'state/inner-managed/inner-managed-profile.json'), 'utf8'));
  const outerStateRoot = path.join(dataRoot, 'state'); const stateRoot = path.join(outerStateRoot, 'inner-managed');
  const outerCandidateRoot = path.join(outerStateRoot, 'codex-outer-runtime-candidates'); fs.mkdirSync(outerCandidateRoot);
  Object.assign(profile, { ownerId, nativeSourceId: 'official-native-owner', installationRoot: installedRoot.replaceAll('\\', '/'), stateRoot, outerStateRoot,
    checkpointRoot: path.join(stateRoot, 'checkpoints'), managedStatePath: path.join(stateRoot, 'managed-runtime.json'), codexHome: fixtureHome,
    approvedUpstreamOrigin: upstreamOrigin, upstreamOrigin, ports, innerPort: ports.inner, approvedCandidates: [] });
  profile.initial.runnerPath = path.join(installedRoot, 'src/codex-model-stream-proxy-runner.mjs');
  for (const [name, target] of Object.entries(profile.outerPaths)) profile.outerPaths[name] = name === 'outerRuntimeRoot' ? outerCandidateRoot : path.join(outerStateRoot, path.basename(target));
  const token = crypto.randomBytes(32).toString('hex'); write(dataRoot, 'state/codex-app-server-proxy-token.txt', token);
  profile.controlTokenSha256 = digest(Buffer.from(token));
  for (const seed of profile.initialStateFiles) {
    assert.equal(sha(seed.sourcePath), seed.sha256);
    seed.sourcePath = write(base, `initial-state-files/${seed.name}`, fs.readFileSync(seed.sourcePath));
    write(dataRoot, `state/${seed.name}`, fs.readFileSync(seed.sourcePath));
  }
  const profilePath = write(candidateRoot, 'state/inner-managed/inner-managed-profile.json', profile);
  const startup = { schemaVersion: 1, enabled: true, candidateRoot: outerCandidateRoot, innerManagedProfilePath: profilePath.replace(candidateRoot, dataRoot), innerManagedProfileSha256: sha(profilePath) };
  write(candidateRoot, 'state/codex-outer-runtime-startup.json', startup);
  for (const [name, kind] of [['state/inner-managed/.inner-runtime-owner.json', 'state'], ['state/inner-managed/checkpoints/.inner-runtime-owner.json', 'checkpoint']]) write(candidateRoot, name, { schemaVersion: 1, ownerId, nativeSourceId: profile.nativeSourceId, kind });
  write(dataRoot, 'state/codex-outer-runtime-startup.json', { schemaVersion: 1, enabled: true, candidateRoot: outerCandidateRoot });
  write(dataRoot, 'state/conversation-account-config.json', { preserved: 'original-conversation-account' });
  const spec = { ...originalSpec, mode: 'TempFixture', ownerId, transactionId, fixtureRoot: base, fixtureHome, transactionRoot, normalToolSupport,
    desktopProcesses: [], filesEntry: { path: filesEntry, sha256: acceptedFilesSha },
    oldInnerParameters: { ...originalSpec.oldInnerParameters, Port: ports.inner, UpstreamOrigin: upstreamOrigin },
    oldOuterParameters: { ...originalSpec.oldOuterParameters, ControlPort: ports.control, DownstreamPort: ports.downstream, UpstreamPort: ports.upstream, ProbePort: ports.probe } };
  for (const [name, definition] of Object.entries(spec.tools)) {
    const file = path.basename(definition.path); const target = path.join(['marker', 'stopOuter'].includes(name) ? normalToolSupport.root : path.join(installedRoot, 'ops'), file);
    if (name.startsWith('start')) assert.equal(sha(target), definition.originalSha256, `frozen original normal entry:${name}`);
    spec.tools[name] = { ...definition, path: target };
  }
  assert.equal(sha(spec.filesEntry.path), spec.filesEntry.sha256);
  assert.equal(await command(`(Get-FileHash -LiteralPath ${quote(spec.codexExecutable.path)} -Algorithm SHA256).Hash.ToLowerInvariant()|ConvertTo-Json -Compress`), spec.codexExecutable.sha256);
  executionEnvironment = { ...process.env, CODEX_HOME: fixtureHome, CODEX_TOOLKIT_NODE_EXE: process.execPath, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  for (const name of Object.keys(executionEnvironment)) if (/^(OPENAI|ANTHROPIC|GEMINI|MODEL_OBSERVER|AZURE_OPENAI)_/u.test(name)) delete executionEnvironment[name];
  const runtimeIdentities = [];
  for (const [role, parameters] of [['inner', spec.oldInnerParameters], ['outer', spec.oldOuterParameters]]) {
    const name = role === 'inner' ? 'startInner' : 'startOuter';
    const assignments = Object.entries(parameters).map(([key, value]) => `${key}=${typeof value === 'boolean' ? (value ? '$true' : '$false') : quote(value)}`).join(';');
    const started = await command(`$Parameters=@{${assignments};DataRoot=${quote(dataRoot)}};${role === 'outer' ? `$Parameters.CodexExecutablePath=${quote(spec.codexExecutable.path)};` : ''}& ${quote(spec.tools[name].path)} @Parameters`);
    assert.equal(role === 'outer' ? started.started : started.running, true);
    const identity = await command(`$Observed=Get-CimInstance Win32_Process -Filter 'ProcessId=${started.pid}';@{role=${quote(role)};pid=[int]$Observed.ProcessId;creationTimeUtc=([DateTime]$Observed.CreationDate).ToUniversalTime().ToString('o');executablePath=$Observed.ExecutablePath}|ConvertTo-Json -Compress`);
    runtimeIdentities.push(identity);
  }
  const files = originalFreeze.files.map(item => ({ ...item, sha256: sha(path.join(candidateRoot, item.name)), bytes: fs.statSync(path.join(candidateRoot, item.name)).size }));
  for (const item of originalFreeze.readOnlyDependencies) assert.equal(sha(path.join(installedRoot, item.name)), item.sha256);
  const freeze = { ...originalFreeze, mode: 'TempFixture', ownerId, transactionId, operatorSid, fixtureRoot: base, candidateRoot, installedRoot: installedRoot.replaceAll('\\', '/'), dataRoot: dataRoot.replaceAll('\\', '/'), files, protectedProcesses: runtimeIdentities };
  const freezePath = write(base, 'freeze.json', freeze); spec.freezeManifest = { path: freezePath, sha256: sha(freezePath) };
  const ownerPath = write(base, 'owner.json', spec);
  const before = Object.fromEntries(files.map(item => { const target = path.join(item.name.startsWith('state/') ? dataRoot : installedRoot, item.name); return [item.name, fs.existsSync(target) ? sha(target) : null]; }));
  evidence.officialNativeExecuted = true;
  evidence.cases.push({ name: 'native-preflight', base, copiedInputs, normalToolSupport, runtimeIdentities, ports, sourceManifestCount: preparation.sourceManifest.length, fileCount: files.length, readOnlyCount: freeze.readOnlyDependencies.length });
  return { base, candidateRoot, installedRoot, dataRoot, transactionRoot, ownerId, transactionId, ownerPath, before, freeze, spec, ports, upstream, native: true };
}

test('official Windows PowerShell parent succeeds then failed candidate independently restores exact old official services', { skip: !enabled || !nativeOnly }, async () => {
  const context = await nativeFixture();
  try {
    const adopted = await invoke(context);
    assert.equal(adopted.status, 0, JSON.stringify(adopted)); assert.equal(adopted.response.status, 'READY_FOR_MANUAL_DESKTOP_OPEN');
    let receipt = JSON.parse(fs.readFileSync(path.join(context.transactionRoot, 'owner-receipt.json'), 'utf8'));
    assert.match(receipt.events.find(item => item.phase === 'INITIALIZE_THREAD_LIST_PASSED').evidence['1'].userAgent, /codex/iu);
    const saved = path.join(context.transactionRoot, 'owner-entry.ps1'); context.ownerPath = path.join(context.transactionRoot, 'owner-manifest.json');
    fs.renameSync(context.candidateRoot, `${context.candidateRoot}-moved`); fs.renameSync(context.spec.normalToolSupport.root, `${context.spec.normalToolSupport.root}-moved`);
    const restored = await invoke(context, 'Restore', { script: saved });
    assert.equal(restored.status, 0, JSON.stringify(restored)); assert.equal(restored.response.status, 'OLD_SERVICES_RESTORED'); originalsMatch(context);
    receipt = JSON.parse(fs.readFileSync(path.join(context.transactionRoot, 'owner-receipt.json'), 'utf8'));
    assert.ok(receipt.events.some(item => item.phase === 'OLD_INITIALIZE_THREAD_LIST_PASSED'));
    evidence.cases.push({ name: 'official-success-independent-restore', base: context.base, before: context.before, adopted: adopted.response, restored: restored.response, receipt });
  } finally { await new Promise(resolve => context.upstream.close(resolve)); }
  const failedContext = await nativeFixture();
  try {
    const failed = await invoke(failedContext, 'Adopt', { failProbe: true, deferRestore: true });
    assert.equal(failed.status, 1, JSON.stringify(failed)); assert.equal(failed.response.status, 'FAILED_CANDIDATE_INDEPENDENT_RESTORE_REQUIRED');
    failedContext.ownerPath = path.join(failedContext.transactionRoot, 'owner-manifest.json');
    fs.renameSync(failedContext.candidateRoot, `${failedContext.candidateRoot}-moved`); fs.renameSync(failedContext.spec.normalToolSupport.root, `${failedContext.spec.normalToolSupport.root}-moved`);
    const restored = await invoke(failedContext, 'Restore', { script: path.join(failedContext.transactionRoot, 'owner-entry.ps1') });
    assert.equal(restored.status, 0, JSON.stringify(restored)); assert.equal(restored.response.status, 'OLD_SERVICES_RESTORED'); originalsMatch(failedContext);
    const receipt = JSON.parse(fs.readFileSync(path.join(failedContext.transactionRoot, 'owner-receipt.json'), 'utf8'));
    assert.ok(receipt.events.some(item => item.phase === 'OLD_INITIALIZE_THREAD_LIST_PASSED'));
    evidence.cases.push({ name: 'official-failed-candidate-independent-restore', base: failedContext.base, before: failedContext.before, failed: failed.response, restored: restored.response, receipt });
  } finally { await new Promise(resolve => failedContext.upstream.close(resolve)); }
});

test('owned synthetic normal entry performs real initialize and thread-list then independent saved entry restores originals inner before outer', { skip: !enabled || nativeOnly }, async () => {
  const context = await fixture(); const adopted = await invoke(context);
  assert.equal(adopted.status, 0, JSON.stringify(adopted)); assert.equal(adopted.response.status, 'READY_FOR_MANUAL_DESKTOP_OPEN');
  const requests = fs.readFileSync(path.join(context.dataRoot, 'state/rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
  assert.deepEqual(requests, ['initialize', 'initialized', 'thread/list']);
  fs.renameSync(context.candidateRoot, `${context.candidateRoot}-moved`);
  context.ownerPath = path.join(context.transactionRoot, 'owner-manifest.json');
  const restored = await invoke(context, 'Restore', { script: path.join(context.transactionRoot, 'owner-entry.ps1') });
  assert.equal(restored.status, 0, JSON.stringify(restored)); assert.equal(restored.response.status, 'OLD_SERVICES_RESTORED'); originalsMatch(context);
  const roles = fs.readFileSync(path.join(context.dataRoot, 'state/service-order.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).role);
  assert.deepEqual(roles.slice(-2), ['inner', 'legacy']);
  evidence.cases.push({ name: 'synthetic-success-independent-restore', base: context.base, before: context.before, adopted: adopted.response, restored: restored.response, requests, roles });
});

test('owned synthetic candidate probe failure restores exact old originals and normal old inner then outer', { skip: !enabled || nativeOnly }, async () => {
  const context = await fixture(); const failed = await invoke(context, 'Adopt', { failProbe: true });
  assert.equal(failed.status, 1, JSON.stringify(failed)); assert.equal(failed.response.status, 'FAILED_CANDIDATE_OLD_SERVICES_RESTORED'); originalsMatch(context);
  evidence.cases.push({ name: 'synthetic-candidate-failure-restored', base: context.base, before: context.before, result: failed.response });
});

test('exact confirmation and production independent-parent refusal precede preparation and service actions', { skip: !enabled || nativeOnly }, async () => {
  const context = await fixture(); const refused = await invoke(context, 'Adopt', { confirmation: false });
  assert.equal(refused.status, 1); assert.equal(refused.response.error, 'EXACT_OWNER_CONFIRMATION_REQUIRED'); assert.equal(fs.existsSync(context.transactionRoot), false);
  const production = await invoke(context, 'Adopt', { requireIndependent: true });
  assert.equal(production.status, 1); assert.match(production.response.error, /ORDINARY_WINDOWS_POWERSHELL_REQUIRED|INDEPENDENT_OWNER_TERMINAL_REQUIRED/);
  assert.equal(fs.existsSync(context.transactionRoot), false);
  evidence.cases.push({ name: 'confirmation-and-model-parent-refused', base: context.base, refusal: refused.response, productionRefusal: production.response });
});

test('owner contains only fixed normal entries and two unpaid RPC methods with no forced stop or desktop relaunch', () => {
  const content = fs.readFileSync(entry, 'utf8');
  assert.doesNotMatch(content, /Stop-Process|taskkill|AllowVerifiedForceStop|Start-Service|Stop-Service|CloseMainWindow/iu);
  assert.doesNotMatch(content, /method\s*=\s*['"](?:turn\/start|thread\/start|account\/login)['"]/iu);
  assert.match(content, /MANUAL_NORMAL_CLOSE_CONFIRMATION_REQUIRED/); assert.match(content, /PID_REUSED_OR_IDENTITY_DRIFT/);
  assert.match(content, /FILE_TRANSACTION_UNKNOWN_NO_REPLAY/); assert.match(content, /originalSha256/);
});

after(async () => {
  if (!output) return;
  for (const directory of fs.readdirSync(output, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(output, item.name))) {
    const state = path.join(directory, 'data/state');
    for (const name of ['codex-app-server-proxy', 'codex-model-stream-proxy']) {
      const runtime = path.join(state, `${name}-runtime.json`); if (!fs.existsSync(runtime)) continue;
      const value = JSON.parse(fs.readFileSync(runtime, 'utf8'));
      const marker = path.join(state, `${name}.stop`);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'owned-fixture-cleanup', { flag: 'wx' });
      evidence.resources.push({ base: directory, role: name, pid: value.pid, cleanupSignal: true });
    }
  }
  for (const server of upstreamServers) if (server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 500));
  const directories = fs.readdirSync(output, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(output, item.name));
  const cleanup = await command(`$Roots=@(${directories.map(quote).join(',')});$Deadline=[DateTime]::UtcNow.AddSeconds(30);do{$Remaining=@(Get-CimInstance Win32_Process|Where-Object {$Observed=$_; $Observed.Name -in @('node.exe','codex.exe') -and @($Roots|Where-Object {$Observed.CommandLine -and $Observed.CommandLine.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count -gt 0});if(-not $Remaining.Count){break};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $Deadline);@{remaining=@($Remaining|Select-Object ProcessId,ParentProcessId,ExecutablePath);listeners=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()|ForEach-Object {$_.Port})}|ConvertTo-Json -Depth 5 -Compress`);
  const boundPorts = evidence.cases.filter(item => item.ports).flatMap(item => Object.values(item.ports));
  evidence.cleanup = { remaining: cleanup.remaining, boundListeners: cleanup.listeners.filter(value => boundPorts.includes(value)), allProcessesExited: cleanup.remaining.length === 0 };
  evidence.cleanup.allPortsReleased = evidence.cleanup.boundListeners.length === 0;
  const target = path.join(output, 'evidence.json'); fs.writeFileSync(target, JSON.stringify(evidence, null, 2));
  console.log(`INNER_OWNER_EVIDENCE=${JSON.stringify({ path: target, sha256: sha(target), ownerEntrySha256: evidence.ownerEntrySha256,
    filesEntrySha256: evidence.filesEntrySha256, productionExecuted: false, officialNativeExecuted: evidence.officialNativeExecuted, cleanup: evidence.cleanup, paidModelCalls: 0 })}`);
  assert.equal(evidence.cleanup.allProcessesExited, true, 'own fixture process cleanup');
  assert.equal(evidence.cleanup.allPortsReleased, true, 'own fixture port cleanup');
});
