import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();
const evidenceDir = resolve(process.argv[2]);
const compilerHeapMB = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (compilerHeapMB !== null && (!Number.isSafeInteger(compilerHeapMB) || compilerHeapMB < 128 || compilerHeapMB > 2048)) {
    throw new Error('Compiler heap limit must be 128 to 2048 MiB');
}
await mkdir(evidenceDir, { recursive: true });
async function tree(directory) {
    const records = [];
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) records.push(...await tree(file));
        else if (entry.isFile()) {
            const bytes = await readFile(join(root, file));
            records.push({ file: file.replaceAll('\\', '/'), bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex') });
        }
    }
    return records.sort((left, right) => left.file.localeCompare(right.file));
}
async function inputs() {
    const records = [...await tree('src'), ...await tree('native')].filter(item => /\.(?:ts|tsx|js|mjs|cjs|json|sql|cs)$/i.test(item.file));
    if (await stat(join(root, 'assets', 'agent')).then(value => value.isDirectory(), () => false)) records.push(...await tree('assets/agent'));
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build-agent-assets.mjs',
        'scripts/build-agent-native.mjs', 'scripts/build-windows-job-runner.mjs', 'tests/agent/local/build-record.mjs', 'node_modules/typescript/package.json']) {
        const bytes = await readFile(join(root, file));
        records.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return records.sort((left, right) => left.file.localeCompare(right.file));
}
const fingerprint = records => createHash('sha256').update(JSON.stringify(records)).digest('hex');
const before = await inputs();
await writeFile(join(evidenceDir, 'inputs-before.json'), JSON.stringify(before));
const report = { schemaVersion: 1, root, node: process.version, platform: `${process.platform}-${process.arch}`,
    startedAt: new Date().toISOString(), inputFingerprint: fingerprint(before), inputFiles: before.length,
    builderSha256: createHash('sha256').update(await readFile(process.argv[1])).digest('hex'), commands: [] };
for (const args of [[...(compilerHeapMB === null ? [] : [`--max-old-space-size=${compilerHeapMB}`]), 'node_modules/typescript/bin/tsc'],
    ['scripts/build-agent-assets.mjs'], ['scripts/build-windows-job-runner.mjs'], ['scripts/build-agent-native.mjs']]) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    report.commands.push({ executable: process.execPath, args, startedAt, finishedAt: new Date().toISOString(),
        code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0) break;
}
const after = await inputs();
const outputs = await tree('dist');
await writeFile(join(evidenceDir, 'inputs-after.json'), JSON.stringify(after));
await writeFile(join(evidenceDir, 'outputs.json'), JSON.stringify(outputs));
report.sameInputs = fingerprint(before) === fingerprint(after);
report.finalInputFingerprint = fingerprint(after);
report.outputFingerprint = fingerprint(outputs);
report.outputFiles = outputs.length;
report.finishedAt = new Date().toISOString();
report.passed = report.commands.length === 4 && report.commands.every(command => command.code === 0) && report.sameInputs;
report.evidence = ['inputs-before.json', 'inputs-after.json', 'outputs.json'].map(file => join(evidenceDir, file));
await writeFile(join(evidenceDir, 'build-record.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
