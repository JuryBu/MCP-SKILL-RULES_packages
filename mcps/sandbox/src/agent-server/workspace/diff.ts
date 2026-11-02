import { createHash } from 'node:crypto';
import type { ChangeAction } from './journal.js';
import type { FileOperationChange } from './file-operations.js';
import { fileHunks } from './text-restore.js';

export interface TextMetadata {
    encoding: 'utf8' | 'utf16le' | 'utf16be' | 'binary';
    bom: boolean;
    eol: 'lf' | 'crlf' | 'mixed' | 'none';
}

export function decodeFileText(bytes: Buffer): { text: string | null; metadata: TextMetadata } {
    let encoding: TextMetadata['encoding'] = 'utf8';
    let bom = false;
    let offset = 0;
    if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) { bom = true; offset = 3; }
    else if (bytes.subarray(0, 2).equals(Buffer.from([255, 254]))) { encoding = 'utf16le'; bom = true; offset = 2; }
    else if (bytes.subarray(0, 2).equals(Buffer.from([254, 255]))) { encoding = 'utf16be'; bom = true; offset = 2; }
    try {
        if (encoding === 'utf8' && bytes.includes(0)) throw new Error('binary');
        const text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes.subarray(offset));
        const crlf = (text.match(/\r\n/g) ?? []).length;
        const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
        return { text, metadata: { encoding, bom, eol: crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none' } };
    } catch { return { text: null, metadata: { encoding: 'binary', bom: false, eol: 'none' } }; }
}

export function describeChange(action: ChangeAction, maximumBytes = 65536): Record<string, unknown> {
    const before = action.before === null ? Buffer.alloc(0) : Buffer.from(action.before);
    const after = Buffer.from(action.after);
    const operation = (action as FileOperationChange).fileOperation;
    const removedCreation = action.toolId === 'local.restore_created_file' && Boolean(action.restoreCreatedFrom);
    const structural = operation && operation.kind !== 'patch';
    const removed = removedCreation || ['delete', 'remove_directory', 'remove_created_file', 'move'].includes(operation?.kind ?? '');
    const availableHunks = !structural && before.length + after.length <= maximumBytes ? fileHunks(before, after) : null;
    const common = { actionId: action.actionId, runId: action.runId, roundId: action.roundId, toolId: action.toolId,
        hunks: availableHunks?.map(hunk => ({ hunkId: hunk.hunkId, beforeStart: hunk.beforeStart,
            afterStart: hunk.afterStart, beforeLines: hunk.beforeLines, afterLines: hunk.afterLines })) ?? null,
        path: action.path, state: action.state, kind: operation?.kind === 'move' ? 'rename'
            : operation?.kind === 'mkdir' ? 'create_directory' : operation?.kind === 'remove_directory' ? 'delete_directory'
                : removed ? 'delete' : action.before === null ? 'create' : 'modify',
        ...(operation ? { fileOperation: structuredClone(operation) } : {}),
        workspaceRevisionBefore: action.workspaceRevisionBefore, workspaceRevisionAfter: action.workspaceRevisionAfter ?? null,
        beforeSha256: action.beforeVersion.sha256, afterSha256: removed || operation?.kind === 'mkdir' ? null : action.afterVersion?.sha256 ?? createHash('sha256').update(after).digest('hex'),
        beforeBytes: before.length, afterBytes: after.length };
    if (operation?.kind === 'move') return { ...common, diffKind: 'rename', diff: null, truncated: false,
        destinationPath: operation.destinationPath, beforeVersion: action.beforeVersion, afterVersion: action.afterVersion ?? null,
        destinationBeforeVersion: operation.destinationBeforeVersion, destinationAfterVersion: action.receipt?.destinationAfterVersion ?? null };
    if (operation?.kind === 'mkdir' || operation?.kind === 'remove_directory') return { ...common, diffKind: 'directory', diff: null, truncated: false,
        beforeVersion: action.beforeVersion, afterVersion: action.afterVersion ?? null };
    if (before.length > 1024 * 1024 || after.length > 1024 * 1024) return { ...common, diffKind: 'bytes', diff: null, truncated: true, reason: '正文差异超过预览预算，原字节保留在修改记录' };
    const oldText = decodeFileText(before);
    const newText = decodeFileText(after);
    if (oldText.text === null || newText.text === null) return { ...common, diffKind: 'binary', diff: null, truncated: false,
        beforeMetadata: oldText.metadata, afterMetadata: newText.metadata };
    const oldLines = oldText.text.split(/\r?\n/);
    const newLines = newText.text.split(/\r?\n/);
    let first = 0;
    while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++;
    let tail = 0;
    while (tail < oldLines.length - first && tail < newLines.length - first && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
    if (first === oldLines.length && first === newLines.length) return { ...common, diffKind: 'text', diff: '', truncated: false,
        beforeMetadata: oldText.metadata, afterMetadata: newText.metadata };
    const start = Math.max(0, first - 3);
    const oldEnd = Math.min(oldLines.length, oldLines.length - tail + 3);
    const newEnd = Math.min(newLines.length, newLines.length - tail + 3);
    const lines = [`--- ${action.path}`, `+++ ${action.path}`, `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
        ...oldLines.slice(start, first).map(line => ` ${line}`),
        ...oldLines.slice(first, oldLines.length - tail).map(line => `-${line}`),
        ...newLines.slice(first, newLines.length - tail).map(line => `+${line}`),
        ...newLines.slice(newLines.length - tail, newEnd).map(line => ` ${line}`)];
    const output: string[] = [];
    let length = 0;
    let truncated = false;
    for (const line of lines) {
        const bytes = Buffer.byteLength(line) + 1;
        if (length + bytes > maximumBytes || output.length >= 1000) { truncated = true; break; }
        output.push(line);
        length += bytes;
    }
    return { ...common, diffKind: 'text', diff: output.join('\n'), truncated,
        beforeMetadata: oldText.metadata, afterMetadata: newText.metadata };
}
