import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson } from '../../../dist/agent-server/protocol.js';
import { BinaryObjectFiles } from '../../../dist/agent-server/media/binary-files.js';
import { canonicalJsonByteChunks, MediaPayloadCodec } from '../../../dist/agent-server/media/payload-codec.js';
import { MemoryBinaryPayloads } from '../../../dist/agent-server/media/memory-payloads.js';
import { ObjectFiles } from '../../../dist/agent-server/storage/objects.js';
import { loadMigrations, migrateDatabase } from '../../../dist/agent-server/storage/migrations.js';

const MiB = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function removeFixture(root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('sandbox-i9-'));
    await rm(root, { recursive: true, force: true });
}

function pngFixture() {
    const chunk = (type, bytes) => {
        const payload = Buffer.concat([Buffer.from(type), bytes]);
        let checksum = 0xffffffff;
        for (const value of payload) {
            checksum ^= value;
            for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
        }
        const result = Buffer.alloc(bytes.length + 12);
        result.writeUInt32BE(bytes.length);
        payload.copy(result, 4);
        result.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, bytes.length + 8);
        return result;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.from([0, 20, 100, 200, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

function openFixture(root, create = false) {
    const database = new DatabaseSync(join(root, 'catalog.sqlite'));
    database.exec('PRAGMA foreign_keys=ON');
    migrateDatabase(database, loadMigrations(), create);
    return { database, files: new ObjectFiles(root, 32 * MiB), binary: new BinaryObjectFiles(root) };
}

function providerFixture(byteLength = 9 * MiB + 1) {
    const bytes = Buffer.alloc(byteLength, 91);
    pngFixture().copy(bytes);
    const dataBase64 = bytes.toString('base64');
    const json = { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: dataBase64 } }] },
        finishReason: 'STOP' }], responseId: 'offline-i9-response' };
    const body = `data: ${JSON.stringify(json)}\r\n\r\ndata: [DONE]\r\n\r\n`;
    return { bytes, response: { blocks: [{ type: 'image', mime: 'image/png', dataBase64, byteLength, sha256: digest(bytes) }],
        raw: { body, json, httpStatus: 200, headers: { 'content-type': 'text/event-stream' } },
        complete: true, toolCalls: [], replayMessages: [], usage: {}, providerResponseId: 'offline-i9-response' } };
}

test('large Gemini SSE body/raw.json/blocks stores once and reads checked original JSON slices after reopen', async context => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-large-response-'));
    let fixture = openFixture(root, true);
    try {
        const { bytes, response } = providerFixture();
        const original = Buffer.from(canonicalJson(response));
        assert.ok(original.length > 32 * MiB);
        const prepared = fixture.files.prepare(response, 'provider_response');
        fixture.files.insert(fixture.database, prepared);
        const raw = fixture.files.prepare(response.raw, 'provider_raw');
        fixture.files.insert(fixture.database, raw);
        const native = response.raw.json.candidates[0].content.parts[0];
        const normalized = { ...response, blocks: [{ ...response.blocks[0], index: 0, candidateIndex: 0, native,
            nativeRef: 'candidates/0/content/parts/0' }], replayMessages: [{ role: 'model', parts: [native] }] };
        const expanded = fixture.files.prepare(normalized, 'provider_response_with_native_replay');
        fixture.files.insert(fixture.database, expanded);
        const checksum = createHash('sha256');
        let expandedBytes = 0;
        for (const chunk of canonicalJsonByteChunks(normalized, { maxBytes: 256 * MiB })) {
            checksum.update(chunk);
            expandedBytes += chunk.length;
        }
        assert.equal(expanded.hash, checksum.digest('hex'));
        assert.equal(expanded.bytes, expandedBytes);
        assert.ok(expanded.bytes > 32 * MiB);
        assert.equal(expanded.mediaRefs.length, 1);
        assert.ok(expanded.storedBytes < 16 * 1024);
        assert.equal(prepared.bytes, original.length);
        assert.equal(prepared.hash, digest(original));
        assert.equal(prepared.codec, 'agent-media-json-v1');
        assert.equal(prepared.mediaRefs.length, 1);
        assert.ok(prepared.storedBytes < 16 * 1024);
        assert.equal(raw.mediaRefs[0].sha256, prepared.mediaRefs[0].sha256);
        assert.deepEqual(await readFile(fixture.binary.absolutePath(prepared.mediaRefs[0])), bytes);
        assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM objects WHERE kind='media_payload'").get().total, 1);
        assert.equal(fixture.database.prepare('SELECT count(*) AS total FROM object_dependencies').get().total, 3);
        assert.deepEqual(await readdir(join(root, 'staging')), []);
        fixture.database.close();
        fixture = openFixture(root);
        for (const offset of [0, 32 * MiB - 7, original.length - 31, original.length]) {
            const page = fixture.files.readSlice(fixture.database, prepared.hash, offset, 8192);
            assert.deepEqual(Buffer.from(page.dataBase64, 'base64'), original.subarray(offset, offset + 8192));
            assert.equal(page.totalBytes, original.length);
            assert.equal(page.sha256, digest(original));
            assert.equal(page.nextOffset, offset + 8192 < original.length ? offset + 8192 : null);
            assert.equal(page.complete, offset + 8192 >= original.length);
        }
        const expandedTail = fixture.files.readSlice(fixture.database, expanded.hash, expanded.bytes - 1, 1);
        assert.equal(Buffer.from(expandedTail.dataBase64, 'base64').toString(), '}');
        assert.equal(expandedTail.sha256, expanded.hash);
        assert.equal(expandedTail.complete, true);
        assert.throws(() => fixture.files.read(fixture.database, prepared.hash), error => error.code === 'STORAGE_DECOMPRESS_LIMIT');
        assert.throws(() => fixture.files.readSlice(fixture.database, prepared.hash, original.length + 1, 1), error => error.code === 'INVALID_PARAMS');
        bytes[bytes.length - 1] ^= 1;
        await writeFile(fixture.binary.absolutePath(prepared.mediaRefs[0]), bytes);
        assert.throws(() => fixture.files.readSlice(fixture.database, prepared.hash, 0, 64), error => error.code === 'STORAGE_SEGMENT_CORRUPT');
        context.diagnostic(JSON.stringify({ fixture: 'offline-Gemini-three-copies', binaryBytes: bytes.length,
            sourceBytes: prepared.bytes, storedBytes: prepared.storedBytes, binaryObjects: 1, slices: 4,
            nativeReplaySourceBytes: expanded.bytes, nativeReplayStoredBytes: expanded.storedBytes,
            nativeReplaySlices: 1, corruptOutsidePageRejected: true }));
    } finally {
        fixture.database.close();
        await removeFixture(root);
    }
});

test('small v1 manifests and legacy identity objects retain full reads and exact JSON slices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-small-response-'));
    const fixture = openFixture(root, true);
    try {
        for (const value of [providerFixture(1024).response, { text: '原始 identity 文本', unknown: [true, null, 42] }]) {
            const prepared = fixture.files.prepare(value, 'compatibility');
            fixture.files.insert(fixture.database, prepared);
            assert.deepEqual(fixture.files.read(fixture.database, prepared.hash), value);
            const page = fixture.files.readSlice(fixture.database, prepared.hash);
            assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), canonicalJson(value));
        }
        assert.throws(() => fixture.files.prepare({ text: 'x'.repeat(32 * MiB) }, 'identity-limit'),
            error => error.code === 'STORAGE_CONTENT_LIMIT');
        const bounded = fixture.files.prepare(providerFixture(1024).response, 'paged-limit');
        fixture.database.prepare('UPDATE objects SET raw_bytes=? WHERE hash=?').run(256 * MiB + 1, bounded.hash);
        assert.throws(() => fixture.files.readSlice(fixture.database, bounded.hash), error => error.code === 'STORAGE_SEGMENT_CORRUPT');
    } finally {
        fixture.database.close();
        await removeFixture(root);
    }
});

test('metadata and paged source budgets reject before preparing any binary', () => {
    const dataBase64 = Buffer.alloc(64, 91).toString('base64');
    for (const [limits, value] of [
        [{ maxSourceBytes: 1024 }, { blocks: Array.from({ length: 16 }, () => ({ dataBase64 })) }],
        [{ maxSourceBytes: 8192, maxMetadataBytes: 1024 }, { dataBase64, text: 'x'.repeat(2048) }],
        [{ maxSourceBytes: 8192, maxMetadataBytes: 256 }, { dataBase64 }],
    ]) {
        const binary = new MemoryBinaryPayloads(4096);
        const codec = new MediaPayloadCodec(binary, limits);
        let prepared = 0;
        assert.throws(() => codec.encode(value, () => { prepared += 1; }), error => error.code === 'MEDIA_CODEC_LIMIT');
        assert.equal(prepared, 0);
        assert.deepEqual(binary.usage(), { bytes: 0, payloads: 0, closed: false });
        binary.close();
    }
});

test('whole decode rejects expansion before binary access while streaming slices remain usable', () => {
    const binary = new MemoryBinaryPayloads(4096);
    const codec = new MediaPayloadCodec(binary, { maxSourceBytes: 8192, maxDecodedBytes: 256 });
    const value = { blocks: Array.from({ length: 4 }, () => ({ dataBase64: Buffer.alloc(64, 91).toString('base64') })) };
    const encoded = codec.encode(value);
    assert.equal(encoded.payloads.length, 1);
    const chunks = binary.chunks.bind(binary);
    let reads = 0;
    binary.chunks = function* (...args) { reads += 1; yield* chunks(...args); };
    assert.throws(() => codec.decode(encoded), error => error.code === 'STORAGE_DECOMPRESS_LIMIT');
    assert.equal(reads, 0);
    assert.equal(Buffer.from(codec.readJsonSlice(encoded).dataBase64, 'base64').toString(), canonicalJson(value));
    assert.equal(reads, 4);
    assert.throws(() => codec.readJsonSlice(encoded, 0, 512 * 1024 + 1), error => error.code === 'INVALID_PARAMS');
    const wrongSource = structuredClone(encoded);
    wrongSource.sourceHash = '0'.repeat(64);
    assert.throws(() => codec.readJsonSlice(wrongSource, 0, 1), error => error.code === 'STORAGE_SEGMENT_CORRUPT');
    const wrongPayload = structuredClone(encoded);
    wrongPayload.strings[0].parts[0].payload = 9;
    assert.throws(() => codec.readJsonSlice(wrongPayload), error => error.code === 'STORAGE_SEGMENT_CORRUPT');
    const oversizedMetadata = structuredClone(encoded);
    oversizedMetadata.unused = 'x'.repeat(1024);
    assert.throws(() => new MediaPayloadCodec(binary, { maxMetadataBytes: 1024 }).readJsonSlice(oversizedMetadata),
        error => error.code === 'MEDIA_CODEC_LIMIT');
    binary.close();
});

test('a real single binary above 32MiB remains rejected without files or staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-binary-limit-'));
    try {
        const files = new ObjectFiles(root, 32 * MiB);
        const dataBase64 = Buffer.alloc(32 * MiB + 1, 91).toString('base64');
        assert.throws(() => files.prepare({ dataBase64 }, 'oversized-binary'), error => error.code === 'MEDIA_CONTENT_LIMIT'
            && error.details.maxBytes === 32 * MiB);
        assert.deepEqual(await readdir(root), []);
    } finally { await removeFixture(root); }
});

test('metadata accounting preserves the existing source depth boundary', () => {
    const binary = new MemoryBinaryPayloads(4096);
    const codec = new MediaPayloadCodec(binary, { maxDepth: 4 });
    const value = { nested: { nested: { dataBase64: Buffer.alloc(64, 91).toString('base64') } } };
    const encoded = codec.encode(value);
    assert.deepEqual(codec.decode(encoded), value);
    assert.throws(() => codec.encode({ nested: { nested: { nested: { nested: value } } } }), error => error.code === 'MEDIA_CODEC_LIMIT');
    binary.close();
});

test('unique binary aggregate is capped at 32MiB before any CAS write despite each binary fitting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-aggregate-limit-'));
    try {
        const files = new ObjectFiles(root, 32 * MiB);
        const blocks = [91, 92].map(value => ({ dataBase64: Buffer.alloc(16 * MiB + 1, value).toString('base64') }));
        let prepared = 0;
        assert.throws(() => files.prepare({ blocks }, 'aggregate-limit', () => { prepared += 1; }),
            error => error.code === 'MEDIA_CONTENT_LIMIT' && error.details.scope === 'unique_payloads'
                && error.details.maxBytes === 32 * MiB);
        assert.equal(prepared, 0);
        assert.deepEqual(await readdir(root), []);
    } finally { await removeFixture(root); }
});

test('aggregate read validation rejects a forged oversized manifest before reading binary', () => {
    const binary = new MemoryBinaryPayloads(4096);
    const codec = new MediaPayloadCodec(binary);
    const encoded = codec.encode({ blocks: [91, 92].map(value => ({ dataBase64: Buffer.alloc(64, value).toString('base64') })) });
    let reads = 0;
    binary.chunks = function* () { reads += 1; throw new Error('must reject before binary access'); };
    assert.throws(() => new MediaPayloadCodec(binary, { maxTotalPayloadBytes: 127 }).readJsonSlice(encoded),
        error => error.code === 'MEDIA_CONTENT_LIMIT' && error.details.scope === 'unique_payloads');
    assert.equal(reads, 0);
    binary.close();
});

test('provider response expansion explicitly restores a large cold response within the source budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-provider-expansion-'));
    let fixture = openFixture(root, true);
    try {
        const { response } = providerFixture();
        const prepared = fixture.files.prepare(response, 'provider_response');
        fixture.files.insert(fixture.database, prepared);
        assert.ok(prepared.bytes > 32 * MiB);
        fixture.database.close();
        fixture = openFixture(root);
        assert.throws(() => fixture.files.read(fixture.database, prepared.hash), error => error.code === 'STORAGE_DECOMPRESS_LIMIT');
        assert.deepEqual(fixture.files.readProviderResponse(fixture.database, prepared.hash), response);
        const envelope = JSON.parse(await readFile(join(root, prepared.path), 'utf8'));
        const codec = new MediaPayloadCodec(fixture.binary, { maxSourceBytes: 256 * MiB, maxMetadataBytes: 40 * MiB });
        assert.throws(() => codec.decode(envelope, { maxBytes: prepared.bytes - 1 }), error => error.code === 'STORAGE_DECOMPRESS_LIMIT');
        for (const maxBytes of [0, -1, NaN, Infinity, 256 * MiB + 1]) {
            assert.throws(() => codec.decode(envelope, { maxBytes }), error => error.code === 'INVALID_PARAMS');
        }
        const memory = new MemoryBinaryPayloads(4096);
        const limited = new MediaPayloadCodec(memory);
        const forged = limited.encode({ blocks: Array.from({ length: 4 }, () => ({ dataBase64: Buffer.alloc(64, 91).toString('base64') })) });
        forged.sourceBytes = 128;
        const chunks = memory.chunks.bind(memory);
        let reads = 0;
        memory.chunks = function* (...args) { reads += 1; yield* chunks(...args); };
        assert.throws(() => limited.decode(forged, { maxBytes: 128 }), error => error.code === 'STORAGE_DECOMPRESS_LIMIT');
        assert.equal(reads, 1);
        memory.close();
    } finally {
        fixture.database.close();
        await removeFixture(root);
    }
});

test('provider response expansion rejects wrong kinds and keeps identity and ordinary read limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-provider-kind-'));
    const fixture = openFixture(root, true);
    try {
        for (const kind of ['provider_raw_response', 'provider_snapshot', 'provider_attempt', 'model_step']) {
            const value = { kind, dataBase64: Buffer.alloc(64, 91).toString('base64') };
            const prepared = fixture.files.prepare(value, kind);
            fixture.files.insert(fixture.database, prepared);
            assert.throws(() => fixture.files.readProviderResponse(fixture.database, prepared.hash), error => error.code === 'INVALID_PARAMS');
            assert.deepEqual(fixture.files.read(fixture.database, prepared.hash), value);
        }
        const response = { complete: true, blocks: [{ type: 'text', text: 'bounded provider identity' }] };
        const identity = fixture.files.prepare(response, 'provider_response');
        fixture.files.insert(fixture.database, identity);
        assert.equal(identity.codec, 'identity');
        assert.deepEqual(fixture.files.readProviderResponse(fixture.database, identity.hash), response);
        fixture.database.prepare('UPDATE objects SET raw_bytes=?,stored_bytes=? WHERE hash=?').run(32 * MiB + 1, 32 * MiB + 1, identity.hash);
        assert.throws(() => fixture.files.readProviderResponse(fixture.database, identity.hash), error => error.code === 'STORAGE_SEGMENT_CORRUPT');
    } finally {
        fixture.database.close();
        await removeFixture(root);
    }
});
