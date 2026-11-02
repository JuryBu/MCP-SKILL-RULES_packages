import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentFault } from '../protocol.js';
import type { BinaryPayloadRef, BinaryPayloadStore, PreparedBinaryPayload } from './types.js';

export function binaryObjectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new AgentFault('MEDIA_HASH_INVALID', '媒体SHA256格式无效');
    return join('objects', hash.slice(0, 2), hash);
}

function validateReference(reference: BinaryPayloadRef, maxBytes: number): void {
    if (reference.path !== binaryObjectPath(reference.sha256) || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0 || reference.byteLength > maxBytes) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体对象引用的路径或长度无效');
    }
}

export class BinaryObjectFiles implements BinaryPayloadStore {
    readonly root: string;

    constructor(root: string, readonly maxBytes = 32 * 1024 * 1024) {
        this.root = resolve(root);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new AgentFault('INVALID_PARAMS', '媒体对象上限无效');
    }

    prepare(chunks: Iterable<Uint8Array>, expected: Omit<BinaryPayloadRef, 'path'>): PreparedBinaryPayload {
        const reference = { ...expected, path: binaryObjectPath(expected.sha256) };
        validateReference(reference, this.maxBytes);
        const stagingDirectory = join(this.root, 'staging');
        const stagingPath = join(stagingDirectory, `${randomUUID()}.media`);
        const finalPath = this.absolutePath(reference);
        let descriptor: number | undefined;
        let created = false;
        try {
            if (existsSync(finalPath)) {
                const checksum = createHash('sha256');
                let bytes = 0;
                for (const chunk of chunks) {
                    bytes += chunk.byteLength;
                    if (bytes > expected.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体实际字节超过声明长度');
                    checksum.update(chunk);
                }
                if (bytes !== expected.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体实际字节与声明长度不一致');
                if (checksum.digest('hex') !== expected.sha256) throw new AgentFault('MEDIA_HASH_MISMATCH', '媒体实际SHA256与声明不一致');
                for (const _chunk of this.chunks(reference)) { }
                return { ...reference, created: false };
            }
            mkdirSync(stagingDirectory, { recursive: true });
            mkdirSync(join(this.root, 'objects', expected.sha256.slice(0, 2)), { recursive: true });
            descriptor = openSync(stagingPath, 'wx', 0o600);
            const checksum = createHash('sha256');
            let bytes = 0;
            for (const chunk of chunks) {
                bytes += chunk.byteLength;
                if (bytes > expected.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体实际字节超过声明长度');
                checksum.update(chunk);
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const written = writeSync(descriptor, chunk, offset, Math.min(64 * 1024, chunk.byteLength - offset));
                    if (written === 0) throw new Error('short-write');
                    offset += written;
                }
            }
            if (bytes !== expected.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体实际字节与声明长度不一致');
            if (checksum.digest('hex') !== expected.sha256) throw new AgentFault('MEDIA_HASH_MISMATCH', '媒体实际SHA256与声明不一致');
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            try {
                linkSync(stagingPath, finalPath);
                created = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                for (const _chunk of this.chunks(reference)) { }
            }
            return { ...reference, created };
        } catch (error) {
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('STORAGE_DURABILITY_FAILED', '媒体原件未能可靠保存，发布事务尚未提交');
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            if (existsSync(stagingPath)) unlinkSync(stagingPath);
        }
    }

    *chunks(reference: BinaryPayloadRef, chunkBytes = 64 * 1024): Iterable<Buffer> {
        validateReference(reference, this.maxBytes);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 3 || chunkBytes > 256 * 1024) {
            throw new AgentFault('INVALID_PARAMS', '媒体读取缓冲大小无效');
        }
        let descriptor: number | undefined;
        try {
            descriptor = openSync(this.absolutePath(reference), 'r');
            const before = fstatSync(descriptor);
            if (!before.isFile() || before.size !== reference.byteLength) throw new Error('size');
            const buffer = Buffer.allocUnsafe(chunkBytes);
            const checksum = createHash('sha256');
            let position = 0;
            while (position < reference.byteLength) {
                const bytes = readSync(descriptor, buffer, 0, Math.min(chunkBytes, reference.byteLength - position), position);
                if (bytes === 0) throw new Error('short-read');
                const chunk = Buffer.from(buffer.subarray(0, bytes));
                checksum.update(chunk);
                position += bytes;
                yield chunk;
            }
            const after = fstatSync(descriptor);
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
                || checksum.digest('hex') !== reference.sha256) throw new Error('hash');
        } catch (error) {
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体原字节的大小或SHA256校验失败', { hash: reference.sha256 });
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }
    }

    absolutePath(reference: BinaryPayloadRef): string {
        validateReference(reference, this.maxBytes);
        return join(this.root, binaryObjectPath(reference.sha256));
    }
}
