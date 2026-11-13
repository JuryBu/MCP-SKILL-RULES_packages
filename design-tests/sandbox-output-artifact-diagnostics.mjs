import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-artifact-diagnostics-'));
process.env.SANDBOX_DATA_ROOT = temporaryRoot;
process.env.SANDBOX_OUTPUT_ARTIFACT_TTL_MS = '7200000';

try {
    const { getOutputArtifactStats, cleanExpiredOutputArtifacts, OUTPUT_ARTIFACT_ROOT } = await import('../mcps/sandbox/src/output-artifact-store.ts');
    const missingDirectory = path.join(OUTPUT_ARTIFACT_ROOT, 'legacy-missing');
    const invalidDirectory = path.join(OUTPUT_ARTIFACT_ROOT, 'legacy-unreadable');
    fs.mkdirSync(missingDirectory, { recursive: true });
    fs.mkdirSync(invalidDirectory, { recursive: true });
    fs.writeFileSync(path.join(missingDirectory, 'stdout.bin'), 'old output');
    fs.writeFileSync(path.join(invalidDirectory, 'stderr.bin'), 'old error');
    fs.writeFileSync(path.join(invalidDirectory, 'manifest.json'), '{');

    const before = fs.readdirSync(OUTPUT_ARTIFACT_ROOT).sort();
    const stats = await getOutputArtifactStats();
    assert.equal(stats.retentionTtlMs, 7200000);
    assert.equal(stats.invalid, 2);
    assert.equal(stats.invalidPayloadBytes, Buffer.byteLength('old outputold error'));
    assert.deepEqual(stats.invalidArtifacts.map(item => [item.artifactId, item.reason]).sort(), [
        ['legacy-missing', 'manifest_missing'], ['legacy-unreadable', 'manifest_unreadable'],
    ]);
    assert.deepEqual(fs.readdirSync(OUTPUT_ARTIFACT_ROOT).sort(), before);
    const cleanup = await cleanExpiredOutputArtifacts(Date.now() + 86400000);
    assert.equal(cleanup.removed, 0);
    assert.equal(cleanup.invalid, 2);
    assert.equal(fs.readFileSync(path.join(missingDirectory, 'stdout.bin'), 'utf8'), 'old output');
    assert.equal(fs.readFileSync(path.join(invalidDirectory, 'stderr.bin'), 'utf8'), 'old error');
    console.log('PASS output artifact diagnostics: retention, missing/unreadable manifests, original payloads retained');
} finally {
    const resolvedRoot = path.resolve(temporaryRoot);
    assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedRoot).startsWith('sandbox-artifact-diagnostics-'));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
