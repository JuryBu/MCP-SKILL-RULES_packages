import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { binaryObjectPath } from './binary-files.js';
import type { BinaryPayloadRef, BinaryPayloadStore, PreparedBinaryPayload } from './types.js';
import type { TemporaryBudgetPort } from './temporary-budget.js';

export class MemoryBinaryPayloads implements BinaryPayloadStore {
    private readonly values = new Map<string, Buffer>();
    private bytes = 0;
    private closed = false;

    constructor(readonly maxBytes = 64 * 1024 * 1024, readonly maxPayloads = 256,
        private readonly allocation?: { conversationId: string; budget: TemporaryBudgetPort }) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxPayloads) || maxPayloads < 1) {
            throw new AgentFault('INVALID_PARAMS', '临时媒体内存上限无效');
        }
    }

    prepare(chunks: Iterable<Uint8Array>, expected: Omit<BinaryPayloadRef, 'path'>): PreparedBinaryPayload {
        if (this.closed) throw new AgentFault('MEDIA_OWNER_STALE', '临时媒体字节存储已关闭');
        if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0 || expected.byteLength > this.maxBytes) {
            throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '临时媒体原件超过当前内存上限');
        }
        const path = binaryObjectPath(expected.sha256);
        const previous = this.values.get(expected.sha256);
        if (!previous && (this.bytes + expected.byteLength > this.maxBytes || this.values.size >= this.maxPayloads)) {
            throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '临时媒体唯一原件达到当前内存上限');
        }
        if (!previous) this.allocation?.budget.reserve(this.allocation.conversationId, expected.byteLength);
        let payload: Buffer | undefined = previous;
        try {
            payload ??= Buffer.allocUnsafe(expected.byteLength);
            const checksum = createHash('sha256');
            let offset = 0;
            for (const chunk of chunks) {
                if (offset + chunk.byteLength > expected.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '临时媒体实际长度超过声明');
                checksum.update(chunk);
                if (!previous) payload.set(chunk, offset);
                offset += chunk.byteLength;
            }
            if (offset !== expected.byteLength || (previous && previous.byteLength !== expected.byteLength)) {
                throw new AgentFault('MEDIA_LENGTH_MISMATCH', '临时媒体实际长度与声明不一致');
            }
            if (checksum.digest('hex') !== expected.sha256) throw new AgentFault('MEDIA_HASH_MISMATCH', '临时媒体SHA256校验失败');
            if (!previous) { this.values.set(expected.sha256, payload); this.bytes += payload.byteLength; }
            return { ...expected, path, created: !previous };
        } catch (error) {
            if (!previous) {
                payload?.fill(0);
                this.allocation?.budget.release(this.allocation.conversationId, expected.byteLength);
            }
            throw error;
        }
    }

    *chunks(reference: BinaryPayloadRef, chunkBytes = 64 * 1024): Iterable<Buffer> {
        if (this.closed) throw new AgentFault('MEDIA_OWNER_STALE', '临时媒体字节存储已关闭');
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 3 || chunkBytes > 256 * 1024) throw new AgentFault('INVALID_PARAMS', '临时媒体分片大小无效');
        const payload = this.values.get(reference.sha256);
        if (!payload || payload.byteLength !== reference.byteLength || reference.path !== binaryObjectPath(reference.sha256)
            || createHash('sha256').update(payload).digest('hex') !== reference.sha256) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '临时媒体原件缺失或校验失败');
        }
        for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) yield Buffer.from(payload.subarray(offset, offset + chunkBytes));
    }

    usage(): { bytes: number; payloads: number; closed: boolean } { return { bytes: this.bytes, payloads: this.values.size, closed: this.closed }; }

    close(): void {
        if (this.closed) return;
        this.allocation?.budget.release(this.allocation.conversationId, this.bytes);
        for (const payload of this.values.values()) payload.fill(0);
        this.values.clear(); this.bytes = 0; this.closed = true;
    }
}
