import { terminalSafeText } from './renderer.js';
export { markdownDisplayLines, compatibleEmojiText, type TranscriptDisplayOptions } from './presentation.js';

export const MAX_TRANSCRIPT_CHARACTERS = 256 * 1024;
export const TRANSCRIPT_HISTORY_LIMITS = Object.freeze({ pages: 4, itemsPerPage: 100, pageBytes: 128 * 1024, artifactReads: 4, artifactBytes: 1024 * 1024, artifactItemBytes: 512 * 1024 });

export function appendTranscriptLines(previous: readonly string[], text: string, replace = false): string[] {
    const lines = [...(replace ? [] : previous), ...(!replace && previous.length ? [''] : []), ...terminalSafeText(text).split('\n')];
    let characters = 0;
    let start = lines.length;
    while (start > 0 && lines.length - start < 2000) {
        const length = lines[start - 1].length + 1;
        if (characters + length > MAX_TRANSCRIPT_CHARACTERS) break;
        characters += length;
        start -= 1;
    }
    return start === lines.length ? [lines.at(-1)!.slice(-MAX_TRANSCRIPT_CHARACTERS)] : lines.slice(start);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function historyMessage(item: Record<string, unknown>): string | undefined {
    const value = record(item.value);
    if (item.role === 'user') {
        const text = typeof value.text === 'string' ? value.text : '';
        const references = Array.isArray(value.references) ? value.references.length : 0;
        return text || references ? terminalSafeText('你：' + text + (references ? `\n[引用材料 ${references}份]` : '')) : undefined;
    }
    if (item.role !== 'assistant') return undefined;
    const text = modelHistoryText(value);
    return text ? terminalSafeText('助手：' + text) : undefined;
}

export function modelHistoryText(value: Record<string, unknown>): string | undefined {
    const response = record(value.response);
    const blocks = Array.isArray(response.blocks) ? response.blocks.map(record) : [];
    const text = blocks.filter(block => !block.thought && ['text', 'refusal'].includes(String(block.type)) && typeof block.text === 'string').map(block => block.text).join('');
    const media = blocks.filter(block => !block.thought && ['image', 'audio', 'video', 'file'].includes(String(block.type)));
    const sections = [text, ...media.map(block => `[${String(block.mime ?? block.type)} · 可从产物与原件入口读取]`)].filter(Boolean);
    if (!sections.length && typeof value.text === 'string') sections.push(value.text);
    if (!sections.length) return undefined;
    return terminalSafeText(sections.join('\n') + (response.complete === false ? '\n[该次供应商回复未完整]' : ''));
}
