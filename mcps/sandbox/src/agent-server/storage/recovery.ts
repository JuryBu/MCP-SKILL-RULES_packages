import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync,
    readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFault } from '../protocol.js';
import type { SqlDatabase } from './internal.js';
import { sha256, storagePath } from './objects.js';
import { verifyTail } from './segments.js';

export function acquireStorageLock(root: string, token: string): () => void {
    const lockPath = join(root, 'storage.lock');
    if (existsSync(lockPath)) {
        let previous: { pid: number; token: string };
        try {
            if (statSync(lockPath).size > 4096) throw new Error('size');
            previous = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof previous;
            if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw new Error('format');
        } catch {
            throw new AgentFault('STORAGE_RECOVERY_REQUIRED', '存储所有权锁无法核验，保留原文件等待恢复');
        }
        let live = true;
        try { process.kill(previous.pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false;
        }
        if (live) throw new AgentFault('STORAGE_BUSY', '存储目录已经由另一执行单元持有', { retryAfterMs: 2500 }, false, true);
        mkdirSync(join(root, 'quarantine'), { recursive: true });
        renameSync(lockPath, join(root, 'quarantine', `stale-lock-${randomUUID()}.json`));
    }
    let descriptor: number;
    try { descriptor = openSync(lockPath, 'wx', 0o600); } catch {
        throw new AgentFault('STORAGE_BUSY', '存储目录正在被另一执行单元打开', { retryAfterMs: 2500 }, false, true);
    }
    try {
        writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() }));
        fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    return () => releaseOwnedStorageLock(root, token);
}

export function releaseOwnedStorageLock(root: string, token: string): void {
    const lockPath = join(root, 'storage.lock');
    try {
        if (statSync(lockPath).size > 4096) return;
        const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string; pid?: number };
        if (current.token === token && current.pid === process.pid) unlinkSync(lockPath);
    } catch { return; }
}

export function recoverSegments(database: SqlDatabase, root: string): { repaired: number; corrupt: number } {
    let cursor = '';
    let repaired = 0;
    let corrupt = 0;
    for (;;) {
        const rows = database.prepare("SELECT segment_id,path,committed_offset FROM segments WHERE segment_id > ? AND codec = 'identity' ORDER BY segment_id LIMIT 50").all(cursor);
        if (!rows.length) break;
        for (const row of rows) {
            cursor = String(row.segment_id);
            try {
                const storedPath = String(row.path);
                const fullPath = storagePath(root, storedPath);
                const committedOffset = Number(row.committed_offset);
                const size = statSync(fullPath).size;
                if (size > committedOffset) {
                    quarantineSuffix(root, fullPath, cursor, committedOffset, size);
                    repaired += 1;
                }
                verifyTail(root, { path: storedPath, committedOffset });
            } catch {
                database.prepare('UPDATE segments SET state = ? WHERE segment_id = ?').run('corrupt', cursor);
                corrupt += 1;
            }
        }
    }
    return { repaired, corrupt };
}

function quarantineSuffix(root: string, fullPath: string, segmentId: string, committedOffset: number, size: number): void {
    if (!Number.isSafeInteger(committedOffset) || committedOffset < 8 || size - committedOffset > 32 * 1024 * 1024) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '未提交历史后缀大小无效');
    }
    const quarantineId = randomUUID();
    const quarantineDir = join(root, 'quarantine');
    mkdirSync(quarantineDir, { recursive: true });
    const suffixPath = join(quarantineDir, `${quarantineId}.suffix`);
    const source = openSync(fullPath, 'r+');
    const destination = openSync(suffixPath, 'wx', 0o600);
    const bytes = Buffer.alloc(64 * 1024);
    const hashes: string[] = [];
    const digest = createHash('sha256');
    try {
        let offset = committedOffset;
        while (offset < size) {
            const count = readSync(source, bytes, 0, Math.min(bytes.length, size - offset), offset);
            if (!count) throw new Error('short read');
            let written = 0;
            while (written < count) written += writeSync(destination, bytes, written, count - written);
            hashes.push(sha256(bytes.subarray(0, count)));
            digest.update(bytes.subarray(0, count));
            offset += count;
        }
        fsyncSync(destination);
        const manifest = openSync(join(quarantineDir, `${quarantineId}.json`), 'wx', 0o600);
        try {
            writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, segmentId, committedOffset,
                bytes: size - committedOffset, sha256: digest.digest('hex'), chunkSha256: hashes, createdAt: new Date().toISOString() }));
            fsyncSync(manifest);
        } finally { closeSync(manifest); }
        ftruncateSync(source, committedOffset);
        fsyncSync(source);
    } finally { closeSync(destination); closeSync(source); }
}
