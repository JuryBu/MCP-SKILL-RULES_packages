import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault } from '../protocol.js';
import { assertNotProtected, isWithin } from '../security/policy.js';
import { AgentNativeClient } from '../tools/native.js';
import type { TrustedToolContext } from '../tools/types.js';

export interface FileVersion {
    canonicalPath: string;
    volumeId: string;
    parentFileId?: string;
    fileId: string | null;
    exists: boolean;
    kind: 'file' | 'missing' | 'directory';
    sha256: string | null;
    byteLength: number;
    mtime: string | null;
    attributes: number;
    versionToken: string | null;
    source?: 'native' | 'observed';
    entryNames?: string[];
}

export interface FileCommitReceipt {
    receiptId: string;
    path: string;
    beforeVersion: FileVersion;
    afterVersion: FileVersion;
    atomic: boolean;
    commitMode: string;
    bytesWritten: number;
    effectState: 'applied';
    cleanupState: 'released';
    committedAt: string;
    restoredCreationActionId?: string;
    deletionActionId?: string;
    destinationPath?: string;
    destinationBeforeVersion?: FileVersion;
    destinationAfterVersion?: FileVersion;
}

export interface RestoreCreatedFileProof { creationActionId: string; lastActionId: string; expectedSha256: string }

export class ControlledFiles {
    constructor(readonly native = new AgentNativeClient()) {}

    async inspect(filePath: string, roots: readonly string[]): Promise<FileVersion> {
        const result = await this.native.require<{ version: FileVersion }>('agent-file-commit', {
            protocolVersion: 1, operation: 'inspect', writeRoots: [...roots], path: path.resolve(filePath),
        }, { maxOutputBytes: 12 * 1024 * 1024 });
        return { ...result.version, source: 'native' };
    }

    async commit(filePath: string, content: Buffer, expected: FileVersion, roots: readonly string[], contentEncoding?: 'utf8'): Promise<FileCommitReceipt> {
        return this.native.require<FileCommitReceipt>('agent-file-commit', {
            protocolVersion: 1, operation: 'commit', writeRoots: [...roots], path: path.resolve(filePath),
            expectedVersion: { exists: expected.exists, versionToken: expected.versionToken },
            contentBase64: content.toString('base64'), allowInPlace: true, ...(contentEncoding ? { contentEncoding } : {}),
        });
    }

    async restoreCreated(filePath: string, expected: FileVersion, roots: readonly string[], proof: RestoreCreatedFileProof): Promise<FileCommitReceipt> {
        if (!expected.exists || expected.sha256 !== proof.expectedSha256 || !proof.creationActionId || !proof.lastActionId) {
            throw new AgentFault('VERSION_CONFLICT', '新建文件撤回需要原动作写后的准确版本和哈希');
        }
        return this.native.require<FileCommitReceipt>('agent-file-commit', { protocolVersion: 1, operation: 'restore_created_file',
            writeRoots: [...roots], path: path.resolve(filePath), expectedVersion: { exists: true, versionToken: expected.versionToken },
            createdFromAbsent: true, expectedSha256: proof.expectedSha256, sourceActionId: proof.creationActionId });
    }

    async move(filePath: string, destinationPath: string, expected: FileVersion, expectedDestination: FileVersion,
        roots: readonly string[], actionId: string): Promise<FileCommitReceipt> {
        return this.native.require<FileCommitReceipt>('agent-file-commit', { protocolVersion: 1, operation: 'move',
            writeRoots: [...roots], path: path.resolve(filePath), destinationPath: path.resolve(destinationPath),
            expectedVersion: { exists: expected.exists, versionToken: expected.versionToken },
            expectedDestinationVersion: { exists: expectedDestination.exists, versionToken: expectedDestination.versionToken }, sourceActionId: actionId });
    }

    async delete(filePath: string, expected: FileVersion, roots: readonly string[], actionId: string): Promise<FileCommitReceipt> {
        return this.native.require<FileCommitReceipt>('agent-file-commit', { protocolVersion: 1, operation: 'delete',
            writeRoots: [...roots], path: path.resolve(filePath), expectedVersion: { exists: expected.exists, versionToken: expected.versionToken },
            deletionApproved: true, sourceActionId: actionId });
    }

    async mkdir(filePath: string, expected: FileVersion, roots: readonly string[], actionId: string): Promise<FileCommitReceipt> {
        return this.native.require<FileCommitReceipt>('agent-file-commit', { protocolVersion: 1, operation: 'mkdir',
            writeRoots: [...roots], path: path.resolve(filePath), expectedVersion: { exists: expected.exists, versionToken: expected.versionToken }, sourceActionId: actionId });
    }

    async restoreCreatedDirectory(filePath: string, expected: FileVersion, roots: readonly string[], creationActionId: string): Promise<FileCommitReceipt> {
        if (expected.kind !== 'directory' || !expected.exists || !creationActionId) throw new AgentFault('VERSION_CONFLICT', '撤回新目录需要准确目录版本及创建动作');
        return this.native.require<FileCommitReceipt>('agent-file-commit', { protocolVersion: 1, operation: 'restore_created_directory',
            writeRoots: [...roots], path: path.resolve(filePath), expectedVersion: { exists: true, versionToken: expected.versionToken },
            createdFromAbsent: true, sourceActionId: creationActionId });
    }
}

export async function assertReadablePath(filePath: string, context: TrustedToolContext): Promise<void> {
    assertNotProtected(filePath, context);
    try { assertNotProtected(await realpath(filePath), context); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function readFilePage(filePath: string, context: TrustedToolContext, offset: number, maximum: number,
    files: ControlledFiles, encoding: 'utf8' | 'base64' = 'base64'): Promise<{ bytes: Buffer; version: FileVersion; offset: number; nextOffset: number | null }> {
    await assertReadablePath(filePath, context);
    const canonicalPath = path.resolve(filePath);
    let handle;
    try { handle = await open(canonicalPath, 'r'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        let version: FileVersion = { canonicalPath, volumeId: '', fileId: null, exists: false, kind: 'missing', sha256: null, byteLength: 0, mtime: null, attributes: 0, versionToken: null, source: 'observed' };
        if (context.roots.some(root => isWithin(canonicalPath, root))) {
            try { version = await files.inspect(canonicalPath, context.roots); }
            catch (failure) { if (!(failure instanceof AgentFault) || failure.mayHaveStarted) throw failure; }
        }
        return { bytes: Buffer.alloc(0), version, offset, nextOffset: null };
    }
    try {
        const before = await handle.stat();
        if (!before.isFile()) throw new AgentFault('FILE_TYPE_UNSUPPORTED', '该路径不是普通文件');
        const readStart = encoding === 'utf8' ? Math.max(0, offset - 3) : offset;
        const bytes = Buffer.alloc(Math.min(maximum + (encoding === 'utf8' ? 6 : 0), Math.max(0, before.size - readStart)));
        const read = await handle.read(bytes, 0, bytes.length, readStart);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new AgentFault('VERSION_UNSTABLE', '读取期间文件变化，请重新读取');
        let version: FileVersion = { canonicalPath, volumeId: String(after.dev), fileId: String(after.ino), exists: true,
            kind: 'file', sha256: null, byteLength: after.size, mtime: after.mtime.toISOString(), attributes: after.mode,
            versionToken: null, source: 'observed' };
        if (context.roots.some(root => isWithin(canonicalPath, root)) && after.size <= 64 * 1024 * 1024) {
            try {
                const native = await files.inspect(canonicalPath, context.roots);
                const final = await handle.stat();
                if (native.byteLength !== after.size || final.mtimeMs !== after.mtimeMs || final.size !== after.size) throw new AgentFault('VERSION_UNSTABLE', '读取期间文件变化，请重新读取');
                version = native;
            } catch (error) {
                if (!(error instanceof AgentFault) || error.mayHaveStarted || ['VERSION_UNSTABLE', 'VERSION_CONFLICT'].includes(error.code)) throw error;
            }
        }
        let selected = bytes.subarray(0, read.bytesRead);
        let actualOffset = offset;
        if (encoding === 'utf8' && offset < after.size) {
            let start = offset - readStart;
            while (start > 0 && (selected[start] & 0xc0) === 0x80) start--;
            let end = Math.min(start + maximum, selected.length);
            const extensionLimit = Math.min(end + 3, selected.length);
            while (end < extensionLimit && (selected[end] & 0xc0) === 0x80) end++;
            actualOffset = readStart + start;
            selected = selected.subarray(start, end);
            try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected); }
            catch { throw new AgentFault('FILE_ENCODING_UNSUPPORTED', '请求页附近含非法UTF-8字节，请用base64读取原字节并从修改记录恢复；文本编辑使用oldText/newText或appendText', { requestedOffset: offset, actualOffset }); }
        } else if (encoding === 'utf8') selected = Buffer.alloc(0);
        return { bytes: selected, version, offset: actualOffset, nextOffset: actualOffset + selected.length < after.size ? actualOffset + selected.length : null };
    } finally { await handle.close(); }
}

export async function captureFile(filePath: string, expected: FileVersion, maximum: number): Promise<Buffer | null> {
    if (!expected.exists) return null;
    if (expected.kind !== 'file') throw new AgentFault('FILE_TYPE_UNSUPPORTED', '原字节采集仅用于普通文件');
    if (expected.byteLength > maximum) throw new AgentFault('CHANGE_PREPARE_FAILED', '文件原件超过本次修改记录预算，需缩小范围或由可信调用方增加预算');
    const handle = await open(filePath, 'r');
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== expected.byteLength) throw new AgentFault('VERSION_CONFLICT', '文件版本已经变化');
        const bytes = Buffer.alloc(expected.byteLength);
        let position = 0;
        while (position < bytes.length) {
            const result = await handle.read(bytes, position, bytes.length - position, position);
            if (!result.bytesRead) break;
            position += result.bytesRead;
        }
        const after = await handle.stat();
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (position !== bytes.length || before.mtimeMs !== after.mtimeMs || before.size !== after.size || hash !== expected.sha256) {
            throw new AgentFault('VERSION_CONFLICT', '保存修改前原件时文件版本变化');
        }
        return bytes;
    } finally { await handle.close(); }
}

export async function directoryStamp(directory: string): Promise<string> {
    const information = await stat(directory);
    if (!information.isDirectory()) throw new AgentFault('FILE_TYPE_UNSUPPORTED', '该路径不是目录');
    return createHash('sha256').update(`${path.resolve(directory)}\n${information.dev}\n${information.ino}\n${information.mtimeMs}`).digest('hex');
}
