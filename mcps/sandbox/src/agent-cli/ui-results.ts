import type { CommandExecution } from './commands.js';
import { humanJson } from './presentation.js';

export function graphicsSummary(graphics: 'none' | 'blocks' | 'sixel', color: boolean): string {
    if (graphics === 'none' || !color) return '纯文字';
    return graphics === 'sixel' ? '高清动画（Sixel）' : '字符兼容（低清）';
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function conversationSummary(source: unknown, titleHint?: string): string[] | undefined {
    const value = record(source);
    if (typeof value.conversationId !== 'string') return undefined;
    const options = record(value.options), retention = record(value.retention);
    const names: Record<string, string> = { archive: '长期保存', temporary: '临时，关闭后清除', ttl: '限时保存' };
    const states: Record<string, string> = { open: '已打开', closed: '已关闭', closing: '正在收尾', deleted: '已清理' };
    const title = typeof options.title === 'string' && options.title ? options.title : titleHint;
    const lines = [title ? `会话：${title}` : '会话已就绪', `会话ID：${value.conversationId}`];
    if (typeof retention.mode === 'string') lines.push(`保存方式：${names[retention.mode] ?? retention.mode}`);
    if (typeof value.state === 'string') lines.push(`状态：${states[value.state] ?? value.state}`);
    if (typeof value.revision === 'number') lines.push(`版本：${value.revision}`);
    if (typeof options.model === 'string') lines.push(`模型：${options.model}`);
    if (Array.isArray(options.writeRoots)) {
        for (const directory of options.writeRoots) if (typeof directory === 'string') lines.push(`可写目录：${directory}`);
    }
    return lines;
}

export function interactiveResultLines(execution: CommandExecution, options: { raw?: boolean; titleHint?: string } = {}): string[] {
    const readable = new Set(['conversations.create', 'conversations.get', 'conversations.close', 'conversations.reopen']);
    if (!options.raw && readable.has(execution.method ?? '')) {
        const summary = conversationSummary(execution.result.data, options.titleHint);
        if (summary) return summary;
    }
    return humanJson(execution.result.data ?? {}).split('\n');
}
