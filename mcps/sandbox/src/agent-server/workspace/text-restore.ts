import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { decodeFileText } from './diff.js';

export interface RestoreHunk {
    hunkId: string;
    beforeStart: number;
    afterStart: number;
    beforeLines: string[];
    afterLines: string[];
}

function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }

export function fileHunks(before: Buffer, after: Buffer): RestoreHunk[] | null {
    const previous = decodeFileText(before); const next = decodeFileText(after);
    if (previous.text === null || next.text === null || previous.metadata.encoding !== next.metadata.encoding
        || previous.metadata.bom !== next.metadata.bom) return null;
    const oldLines = lines(previous.text); const newLines = lines(next.text);
    let prefix = 0; let suffix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
    const oldEnd = oldLines.length - suffix; const newEnd = newLines.length - suffix;
    const result: RestoreHunk[] = [];
    const add = (oldStart: number, oldStop: number, newStart: number, newStop: number) => {
        if (oldStart === oldStop && newStart === newStop) return;
        const content = { beforeStart: oldStart, afterStart: newStart,
            beforeLines: oldLines.slice(oldStart, oldStop), afterLines: newLines.slice(newStart, newStop) };
        result.push({ ...content, hunkId: createHash('sha256').update(JSON.stringify(content)).digest('hex') });
    };
    const oldCount = oldEnd - prefix; const newCount = newEnd - prefix;
    if ((oldCount + 1) * (newCount + 1) > 1_000_000) {
        add(prefix, oldEnd, prefix, newEnd);
        return result;
    }
    const width = newCount + 1;
    const table = new Uint32Array((oldCount + 1) * width);
    for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex--) for (let newIndex = newCount - 1; newIndex >= 0; newIndex--) {
        table[oldIndex * width + newIndex] = oldLines[prefix + oldIndex] === newLines[prefix + newIndex]
            ? table[(oldIndex + 1) * width + newIndex + 1] + 1
            : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
    let oldIndex = 0; let newIndex = 0; let oldStart = 0; let newStart = 0;
    while (oldIndex < oldCount || newIndex < newCount) {
        if (oldIndex < oldCount && newIndex < newCount && oldLines[prefix + oldIndex] === newLines[prefix + newIndex]) {
            add(prefix + oldStart, prefix + oldIndex, prefix + newStart, prefix + newIndex);
            oldIndex++; newIndex++; oldStart = oldIndex; newStart = newIndex;
        } else if (newIndex < newCount && (oldIndex === oldCount || table[oldIndex * width + newIndex + 1] >= table[(oldIndex + 1) * width + newIndex])) newIndex++;
        else oldIndex++;
    }
    add(prefix + oldStart, oldEnd, prefix + newStart, newEnd);
    return result;
}

function encode(text: string, original: Buffer): Buffer {
    const metadata = decodeFileText(original).metadata;
    if (metadata.encoding === 'utf8') return Buffer.concat([metadata.bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0), Buffer.from(text)]);
    const bytes = Buffer.from(text, 'utf16le');
    if (metadata.encoding === 'utf16be') bytes.swap16();
    return Buffer.concat([metadata.bom ? Buffer.from(metadata.encoding === 'utf16be' ? [254, 255] : [255, 254]) : Buffer.alloc(0), bytes]);
}

export function reverseTextChange(before: Buffer, after: Buffer, current: Buffer, selected?: readonly string[]): {
    bytes: Buffer; restoredHunks: string[]; conflictedHunks: string[];
} {
    const hunks = fileHunks(before, after);
    if (!hunks) return { bytes: current, restoredHunks: [], conflictedHunks: ['binary-or-encoding-change'] };
    if (selected?.some(id => !hunks.some(hunk => hunk.hunkId === id))) throw new AgentFault('INVALID_PARAMS', '所选文本片段不属于该动作的当前差异');
    const source = decodeFileText(after); const observed = decodeFileText(current);
    const requested = hunks.filter(hunk => !selected || selected.includes(hunk.hunkId));
    if (observed.text === null || source.metadata.encoding !== observed.metadata.encoding || source.metadata.bom !== observed.metadata.bom) {
        return { bytes: current, restoredHunks: [], conflictedHunks: requested.map(hunk => hunk.hunkId) };
    }
    const expected = lines(source.text!); const output = lines(observed.text);
    const restoredHunks: string[] = []; const conflictedHunks: string[] = [];
    const replacements: { position: number; hunk: RestoreHunk }[] = [];
    for (const hunk of [...requested].reverse()) {
        const prefix = expected.slice(Math.max(0, hunk.afterStart - 3), hunk.afterStart);
        const suffix = expected.slice(hunk.afterStart + hunk.afterLines.length, hunk.afterStart + hunk.afterLines.length + 3);
        const needle = [...prefix, ...hunk.afterLines, ...suffix];
        const matches: number[] = [];
        for (let position = 0; position + needle.length <= output.length; position++) {
            if (needle.every((line, index) => output[position + index] === line)) matches.push(position + prefix.length);
            if (matches.length > 1) break;
        }
        if (matches.length !== 1 || (!needle.length && output.length)) { conflictedHunks.push(hunk.hunkId); continue; }
        replacements.push({ position: matches[0], hunk });
        restoredHunks.push(hunk.hunkId);
    }
    for (const replacement of replacements.sort((left, right) => right.position - left.position)) {
        output.splice(replacement.position, replacement.hunk.afterLines.length, ...replacement.hunk.beforeLines);
    }
    return { bytes: encode(output.join(''), current), restoredHunks, conflictedHunks };
}
