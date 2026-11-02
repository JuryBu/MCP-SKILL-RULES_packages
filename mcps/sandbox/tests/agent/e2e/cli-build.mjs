import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

export async function captureCliBuild(root) {
    const files = [];
    async function hashFile(path) {
        const digest = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(path)) { bytes += chunk.length; digest.update(chunk); }
        files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes, sha256: digest.digest('hex') });
    }
    async function visit(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name.startsWith('.')) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile() && /\.(?:js|sql|json|sixel|exe|node|dll|md)$/.test(entry.name)) await hashFile(path);
        }
    }
    for (const directory of ['dist/agent-cli', 'dist/agent-client', 'dist/agent-server']) await visit(join(root, directory));
    for (const directory of ['dist/native']) if (await fs.stat(join(root, directory)).catch(() => null)) await visit(join(root, directory));
    let assetDirectory = null;
    for (const directory of ['dist/assets/agent', 'assets/agent']) {
        if ((await fs.stat(join(root, directory, 'manifest.json')).catch(() => null))?.isFile()) { assetDirectory = directory; break; }
    }
    if (assetDirectory) await visit(join(root, assetDirectory));
    for (const path of ['package.json', 'dist/agent-assets-manifest.json']) if (await fs.stat(join(root, path)).catch(() => null)) await hashFile(join(root, path));
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { files, fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
        environment: { node: process.version, platform: process.platform, architecture: process.arch }, assetDirectory };
}
