import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync,
    statSync, unlinkSync, writeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { SqlDatabase, SqlRow } from './internal.js';
import { DEFAULT_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES } from './port.js';
import { BinaryObjectFiles } from '../media/binary-files.js';
import { MediaPayloadCodec, MEDIA_PAYLOAD_CODEC } from '../media/payload-codec.js';
import type { EncodedMediaPayload } from '../media/payload-codec.js';
import type { BinaryPayloadRef, PreparedBinaryPayload } from '../media/types.js';
import { insertBinaryObject } from './media-transactions.js';

export interface PreparedObject {
    hash: string;
    kind: string;
    bytes: number;
    path: string;
    created: boolean;
    codec?: 'identity' | typeof MEDIA_PAYLOAD_CODEC;
    storedHash?: string;
    storedBytes?: number;
    mediaRefs?: BinaryPayloadRef[];
}

export function storagePath(root: string, storedPath: string): string {
    const fullPath = resolve(root, storedPath);
    const inside = relative(root, fullPath);
    if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || resolve(storedPath) === storedPath) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '存储索引中的文件位置无效');
    }
    return fullPath;
}

export function sha256(bytes: Uint8Array | string): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export class ObjectFiles {
    private readonly payloadCodec: MediaPayloadCodec;
    private readonly representationLimit: number;

    constructor(private readonly root: string, private readonly maxBytes: number) {
        const maxPayloadBytes = Math.min(maxBytes, 32 * 1024 * 1024);
        this.payloadCodec = new MediaPayloadCodec(new BinaryObjectFiles(root, maxPayloadBytes),
            { maxSourceBytes: maxBytes, maxPayloadBytes });
        this.representationLimit = maxBytes + Math.min(maxBytes, 8 * 1024 * 1024);
    }

    prepare(value: unknown, kind: string, onPreparedBinary?: (payload: PreparedBinaryPayload) => void): PreparedObject {
        const encoded = this.payloadCodec.encode(value, onPreparedBinary);
        const bytes = Buffer.from(canonicalJson(encoded ?? value));
        const rawBytes = encoded?.sourceBytes ?? bytes.length;
        const hash = encoded?.sourceHash ?? sha256(bytes);
        const codec = encoded ? MEDIA_PAYLOAD_CODEC : 'identity';
        const storedHash = sha256(bytes);
        if (rawBytes > this.maxBytes || bytes.length > this.representationLimit) {
            throw new AgentFault('STORAGE_CONTENT_LIMIT', '单个持久对象超过当前读取上限',
                { bytes: rawBytes, maxBytes: this.maxBytes });
        }
        const identityPath = join('objects', hash.slice(0, 2), hash);
        if (encoded && existsSync(storagePath(this.root, identityPath))) {
            this.readBytes(identityPath, hash, rawBytes);
            return { hash, kind, bytes: rawBytes, path: identityPath, created: false,
                codec: 'identity', storedHash: hash, storedBytes: rawBytes, mediaRefs: [] };
        }
        const storedPath = encoded ? join('objects', storedHash.slice(0, 2), `${storedHash}.media-json`) : identityPath;
        const finalPath = storagePath(this.root, storedPath);
        const prepared: Omit<PreparedObject, 'created'> = { hash, kind, bytes: rawBytes, path: storedPath, codec, storedHash, storedBytes: bytes.length,
            mediaRefs: encoded ? this.payloadCodec.references(encoded) : [] };
        if (existsSync(finalPath)) {
            this.readBytes(storedPath, storedHash, bytes.length, this.representationLimit);
            return { ...prepared, created: false };
        }
        const stagingPath = join(this.root, 'staging', `${randomUUID()}.object`);
        mkdirSync(join(this.root, 'staging'), { recursive: true });
        mkdirSync(join(this.root, 'objects', storedHash.slice(0, 2)), { recursive: true });
        let descriptor: number | undefined;
        try {
            descriptor = openSync(stagingPath, 'wx', 0o600);
            let offset = 0;
            while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, Math.min(64 * 1024, bytes.length - offset));
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(stagingPath, finalPath);
            return { ...prepared, created: true };
        } catch {
            throw new AgentFault('STORAGE_DURABILITY_FAILED', '对象字节未能可靠保存，事务未提交');
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            if (existsSync(stagingPath)) unlinkSync(stagingPath);
        }
    }

    insert(database: SqlDatabase, object: PreparedObject): void {
        database.prepare('INSERT INTO objects (hash, kind, mime, raw_bytes, stored_bytes, codec, stored_hash, path, state, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING')
            .run(object.hash, object.kind, 'application/json', object.bytes, object.storedBytes ?? object.bytes,
                object.codec ?? 'identity', object.storedHash ?? object.hash, object.path, 'ready', 1);
        const actual = this.objectRow(database, object.hash);
        if (Number(actual.raw_bytes) !== object.bytes) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '对象原字节索引与已准备内容不一致');
        if (actual.codec === MEDIA_PAYLOAD_CODEC) {
            const references = actual.stored_hash === object.storedHash && object.mediaRefs
                ? object.mediaRefs : this.payloadCodec.references(this.envelope(actual, object.hash));
            for (const reference of references) {
                insertBinaryObject(database, reference);
                database.prepare('INSERT OR IGNORE INTO object_dependencies (source_hash,payload_hash) VALUES (?,?)')
                    .run(object.hash, reference.sha256);
            }
        }
    }

    read(database: SqlDatabase, hash: string): unknown {
        const row = this.objectRow(database, hash);
        if (row.codec === MEDIA_PAYLOAD_CODEC) return this.payloadCodec.decode(this.envelope(row, hash));
        const bytes = this.readBytes(String(row.path), hash, Number(row.raw_bytes));
        try {
            return JSON.parse(bytes.toString('utf8')) as unknown;
        } catch {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '内容对象JSON校验失败', { hash });
        }
    }

    readSlice(database: SqlDatabase, hash: string, offset = 0, maxBytes = DEFAULT_ARTIFACT_BYTES) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes)
            || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
            throw new AgentFault('INVALID_PARAMS', '原件分片参数无效', { maxBytes: MAX_ARTIFACT_BYTES });
        }
        const row = this.objectRow(database, hash);
        if (row.codec === MEDIA_PAYLOAD_CODEC) return this.payloadCodec.readJsonSlice(this.envelope(row, hash), offset, maxBytes);
        const totalBytes = Number(row.raw_bytes);
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > this.maxBytes
            || Number(row.stored_bytes) !== totalBytes) {
            throw new AgentFault('STORAGE_DECOMPRESS_LIMIT', '原件声明大小超过当前读取上限', { maxBytes: this.maxBytes });
        }
        if (offset > totalBytes) throw new AgentFault('INVALID_PARAMS', '原件偏移超过总字节数', { totalBytes });
        const page = Buffer.alloc(Math.min(maxBytes, totalBytes - offset));
        const endOffset = offset + page.length;
        let descriptor: number | undefined;
        try {
            descriptor = openSync(storagePath(this.root, String(row.path)), 'r');
            const before = fstatSync(descriptor);
            if (!before.isFile() || before.size !== totalBytes) throw new Error('size');
            const checksum = createHash('sha256');
            const chunk = Buffer.allocUnsafe(64 * 1024);
            let position = 0;
            while (position < totalBytes) {
                const length = readSync(descriptor, chunk, 0, Math.min(chunk.length, totalBytes - position), position);
                if (length === 0) throw new Error('short-read');
                checksum.update(chunk.subarray(0, length));
                const copyStart = Math.max(offset, position);
                const copyEnd = Math.min(endOffset, position + length);
                if (copyStart < copyEnd) chunk.copy(page, copyStart - offset, copyStart - position, copyEnd - position);
                position += length;
            }
            const after = fstatSync(descriptor);
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
                || checksum.digest('hex') !== hash) throw new Error('hash');
            return { mime: 'application/json' as const, totalBytes, sha256: hash, offset,
                dataBase64: page.toString('base64'), nextOffset: endOffset < totalBytes ? endOffset : null,
                complete: endOffset === totalBytes };
        } catch (error) {
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原件字节的大小或哈希校验失败', { hash });
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }
    }

    discardUncommitted(database: SqlDatabase, objects: PreparedObject[]): void {
        for (const object of objects) {
            if (object.created && !database.prepare('SELECT hash FROM objects WHERE hash = ? OR path = ?').get(object.hash, object.path)) {
                const fullPath = storagePath(this.root, object.path);
                if (existsSync(fullPath)) unlinkSync(fullPath);
            }
        }
    }

    private objectRow(database: SqlDatabase, hash: string): SqlRow {
        const row = database.prepare('SELECT path,raw_bytes,stored_bytes,stored_hash,codec,state FROM objects WHERE hash = ?').get(hash);
        if (!row || row.state !== 'ready' || !/^[a-f0-9]{64}$/.test(hash)
            || !['identity', MEDIA_PAYLOAD_CODEC].includes(String(row.codec))
            || !Number.isSafeInteger(Number(row.raw_bytes)) || Number(row.raw_bytes) < 0 || Number(row.raw_bytes) > this.maxBytes
            || !/^[a-f0-9]{64}$/.test(String(row.stored_hash))
            || (row.codec === 'identity' && (row.stored_hash !== hash || Number(row.stored_bytes) !== Number(row.raw_bytes)))) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '内容对象索引缺失或表示不可读', { hash });
        }
        return row;
    }

    private envelope(row: SqlRow, hash: string): EncodedMediaPayload {
        const bytes = this.readBytes(String(row.path), String(row.stored_hash), Number(row.stored_bytes), this.representationLimit);
        let encoded: EncodedMediaPayload;
        try { encoded = JSON.parse(bytes.toString('utf8')) as EncodedMediaPayload; }
        catch { throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体表示清单JSON损坏', { hash }); }
        if (!encoded || typeof encoded !== 'object' || encoded.codec !== MEDIA_PAYLOAD_CODEC
            || encoded.sourceHash !== hash || encoded.sourceBytes !== Number(row.raw_bytes)) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体表示清单与原件索引不一致', { hash });
        }
        this.payloadCodec.references(encoded);
        return encoded;
    }

    private readBytes(storedPath: string, hash: string, expectedBytes: number, limitBytes = this.maxBytes): Buffer {
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > limitBytes) {
            throw new AgentFault('STORAGE_DECOMPRESS_LIMIT', '对象声明大小超过当前读取上限', { maxBytes: limitBytes });
        }
        try {
            const fullPath = storagePath(this.root, storedPath);
            if (statSync(fullPath).size !== expectedBytes) throw new Error('size');
            const bytes = readFileSync(fullPath);
            if (bytes.length !== expectedBytes || sha256(bytes) !== hash) throw new Error('hash');
            return bytes;
        } catch (error) {
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '内容对象的大小或哈希校验失败', { hash });
        }
    }
}
