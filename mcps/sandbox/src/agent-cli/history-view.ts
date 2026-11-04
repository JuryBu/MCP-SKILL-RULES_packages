import { terminalSafeText } from './renderer.js';

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
