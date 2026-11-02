import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'agent-server', 'storage', 'schema');
const output = join(root, 'dist', 'agent-server', 'storage', 'schema');
mkdirSync(output, { recursive: true });
const artifacts = [];
for (const file of readdirSync(source).filter(name => /^[0-9]{3}(?:-[a-z-]+)?\.sql$/.test(name)).sort()) {
    const bytes = readFileSync(join(source, file));
    copyFileSync(join(source, file), join(output, file));
    artifacts.push({ path: `agent-server/storage/schema/${file}`, sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (!artifacts.some(item => item.path.endsWith('/001.sql'))) throw new Error('Agent storage schema 001.sql is missing');
writeFileSync(join(root, 'dist', 'agent-assets-manifest.json'), JSON.stringify({ schemaVersion: 1, artifacts }, null, 2));
process.stdout.write(JSON.stringify({ type: 'agent-assets-built', artifacts: artifacts.length }) + '\n');
