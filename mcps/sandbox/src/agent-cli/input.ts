import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { AgentFault, MAX_FRAME_BYTES } from '../agent-server/protocol.js';
import { usage, type ParsedArguments } from './arguments.js';

export const MAX_DRAFT_BYTES = MAX_FRAME_BYTES;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export class DraftBuffer {
    readonly draftId = randomUUID();
    revision = 0;
    text = '';
    cursorGrapheme = 0;
    references: unknown[] = [];
    inputMode: 'queue' | 'steer' = 'queue';
    private undoStack: { text: string; cursor: number }[] = [];
    private redoStack: { text: string; cursor: number }[] = [];

    replace(text: string): void {
        if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_BYTES) throw usage('草稿超过1MiB，请改用附件；原草稿仍保留');
        this.undoStack.push({ text: this.text, cursor: this.cursorGrapheme });
        this.redoStack = [];
        while (this.undoStack.length > 32 || this.undoStack.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0) > 2 * MAX_DRAFT_BYTES) this.undoStack.shift();
        this.text = text;
        let count = 0;
        for (const segment of graphemes.segment(text)) {
            if (segment.segment.length > 0) count += 1;
        }
        this.cursorGrapheme = count;
        this.revision += 1;
    }

    append(text: string): void {
        this.replace(this.text + text);
    }

    insert(text: string): void {
        const parts = Array.from(graphemes.segment(this.text), part => part.segment);
        const prefix = parts.slice(0, this.cursorGrapheme).join('') + text;
        this.replace(prefix + parts.slice(this.cursorGrapheme).join(''));
        this.cursorGrapheme = Array.from(graphemes.segment(prefix)).length;
    }

    move(offset: number): void {
        this.cursorGrapheme = Math.max(0, Math.min(Array.from(graphemes.segment(this.text)).length, this.cursorGrapheme + offset));
    }

    home(): void {
        const parts = Array.from(graphemes.segment(this.text), part => part.segment);
        this.cursorGrapheme = parts.slice(0, this.cursorGrapheme).lastIndexOf('\n') + 1;
    }
    end(): void {
        const parts = Array.from(graphemes.segment(this.text), part => part.segment);
        const newline = parts.indexOf('\n', this.cursorGrapheme);
        this.cursorGrapheme = newline < 0 ? parts.length : newline;
    }
    clearLine(): void {
        const parts = Array.from(graphemes.segment(this.text), part => part.segment);
        const start = parts.slice(0, this.cursorGrapheme).lastIndexOf('\n') + 1;
        const newline = parts.indexOf('\n', this.cursorGrapheme);
        const end = newline < 0 ? parts.length : newline;
        this.replace([...parts.slice(0, start), ...parts.slice(end)].join(''));
        this.cursorGrapheme = start;
    }

    erase(backward: boolean): void {
        const parts = Array.from(graphemes.segment(this.text), part => part.segment);
        const cursor = this.cursorGrapheme;
        const index = backward ? cursor - 1 : cursor;
        if (index < 0 || index >= parts.length) return;
        parts.splice(index, 1);
        this.replace(parts.join(''));
        this.cursorGrapheme = backward ? cursor - 1 : cursor;
    }

    undo(): void {
        const previous = this.undoStack.pop();
        if (!previous) return;
        this.redoStack.push({ text: this.text, cursor: this.cursorGrapheme });
        this.text = previous.text; this.cursorGrapheme = previous.cursor; this.revision += 1;
    }

    redo(): void {
        const next = this.redoStack.pop();
        if (!next) return;
        this.undoStack.push({ text: this.text, cursor: this.cursorGrapheme });
        this.text = next.text; this.cursorGrapheme = next.cursor; this.revision += 1;
    }

    clearIfAcknowledged(revision: number): boolean {
        if (revision !== this.revision) return false;
        this.replace('');
        this.references = [];
        return true;
    }
}

async function readUtf8(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
            total += bytes.length;
            if (total > MAX_DRAFT_BYTES) throw usage('正文超过1MiB，请改用附件');
            chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, total);
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    } catch (error) {
        if (error instanceof AgentFault) throw error;
        throw new AgentFault('E_CLI_USAGE', '无法读取有效的UTF-8正文', {
            sourceError: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function readCommandInput(parsed: ParsedArguments, stdin: Readable): Promise<string | undefined> {
    const options = parsed.options;
    const selected = ['text', 'input-file', 'stdin'].filter(name => options[name] !== undefined && options[name] !== false);
    if (selected.length > 1) throw usage('--text、--input-file和--stdin只能选择一种');
    if (typeof options.text === 'string') {
        if (Buffer.byteLength(options.text, 'utf8') > MAX_DRAFT_BYTES) throw usage('正文超过1MiB，请改用附件');
        return options.text;
    }
    if (typeof options['input-file'] === 'string') return readUtf8(createReadStream(options['input-file']));
    if (options.stdin === true) return readUtf8(stdin);
    return undefined;
}
