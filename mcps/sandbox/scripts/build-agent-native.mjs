import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(packageRoot, 'dist', 'native');
mkdirSync(outputRoot, { recursive: true });
if (process.platform !== 'win32') {
    writeFileSync(join(outputRoot, 'agent-native-manifest.json'), JSON.stringify({ schemaVersion: 1, supported: false, platform: process.platform, artifacts: [] }, null, 2));
    process.exit(0);
}
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(compiler)) throw new Error('Agent native compiler is unavailable; existing artifacts were not replaced');
const pendingRoot = join(outputRoot, `.agent-build-${randomUUID()}`);
mkdirSync(pendingRoot);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const definitions = ['agent-secret-vault', 'windows-agent-runner', 'agent-file-commit', 'agent-graphics'];
const artifacts = [];
for (const name of definitions) {
    const source = join(packageRoot, 'native', `${name}.cs`);
    const pending = join(pendingRoot, `${name}.exe`);
    const sourceHash = hash(source);
    const graphics = name === 'agent-graphics';
    const flags = ['/nologo', '/optimize+', '/langversion:5', '/platform:x64', graphics ? '/target:winexe' : '/target:exe',
        ...(graphics ? ['/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll'] : ['/reference:System.Security.dll']),
        '/reference:System.Web.Extensions.dll', `/out:${pending}`, source];
    const result = spawnSync(compiler, flags, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Agent native build failed: ${name}, exit=${result.status}; pending evidence retained`);
    if (hash(source) !== sourceHash) throw new Error(`Source changed during native build: ${name}; artifacts were not published`);
    const sizeBytes = statSync(pending).size;
    if (sizeBytes < 4096) throw new Error(`Agent native output is unexpectedly small: ${name}`);
    artifacts.push({ source: `native/${name}.cs`, sourceSha256: sourceHash,
        path: `dist/native/${name}.exe`, sha256: hash(pending), sizeBytes,
        target: { platform: 'win32', arch: 'x64', framework: 'net48', languageVersion: '5' } });
}
const manifest = { schemaVersion: 1, supported: true, builtAt: new Date().toISOString(),
    compilerSha256: hash(compiler), compiler: '%WINDIR%/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    flags: ['/optimize+', '/langversion:5', '/platform:x64', '/target:exe'], artifacts };
for (const item of artifacts) renameSync(join(pendingRoot, item.path.split('/').at(-1)), join(packageRoot, item.path));
const pendingManifest = join(pendingRoot, 'manifest.json');
writeFileSync(pendingManifest, JSON.stringify(manifest, null, 2));
renameSync(pendingManifest, join(outputRoot, 'agent-native-manifest.json'));
process.stdout.write(JSON.stringify({ type: 'agent-native-built', manifest: relative(packageRoot, join(outputRoot, 'agent-native-manifest.json')), artifacts: artifacts.length }) + '\n');
