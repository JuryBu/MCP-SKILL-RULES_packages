import { graphemes, terminalSafeText } from './renderer.js';

export interface TranscriptDisplayOptions { emojiFallback?: boolean }

export function compatibleEmojiText(text: string): string {
    const names: Record<string, string> = { '👋': '挥手', '🙂': '微笑', '😊': '微笑', '😀': '笑脸', '😄': '笑脸', '✅': '完成', '✔': '完成', '❌': '失败', '⚠': '注意', '❗': '注意', '❓': '问题', '💡': '提示', '🔍': '查找', '📁': '目录', '📂': '目录', '📄': '文件', '📋': '清单', '🚀': '开始', '✨': '闪光', '❤': '爱心', '👍': '赞', '🎉': '庆祝' };
    return graphemes(text).map(part => {
        const base = part.replace(/[\ufe0e\ufe0f]|\p{Emoji_Modifier}/gu, '');
        if (!/\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(part) && !names[base]) return part;
        return `[${names[base] ?? (/\u20e3/u.test(base) ? base.replace(/\u20e3/g, '') : '表情')}]`;
    }).join('');
}

function readableInlineMarkdown(text: string): string {
    return text.split(/(`+[^`]+?`+)/g).map((part, index) => {
        if (index % 2) return part.replace(/^`+|`+$/g, '');
        return part.replace(/(!?)\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_match, image: string, label: string, target: string) => image ? `[图片：${label}]${target ? ' ' + target : ''}` : target && target !== label ? `${label} (${target})` : label)
            .replace(/(\*\*|__)(?=\S)(.+?\S|\S)\1/g, '$2')
            .replace(/(?<![\p{L}\p{N}])(\*|_)(?=\S)([^*_]+?\S|\S)\1(?![\p{L}\p{N}])/gu, '$2')
            .replace(/~~(?=\S)(.+?\S|\S)~~/g, '$1');
    }).join('');
}

export function markdownDisplayLines(source: readonly string[] | string, options: TranscriptDisplayOptions = {}): string[] {
    const lines = terminalSafeText(typeof source === 'string' ? source : source.join('\n')).split('\n');
    let fence: { marker: string; length: number } | undefined;
    return lines.map(line => {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (delimiter && (!fence || delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim())) {
            if (fence) { fence = undefined; return '[代码结束]'; }
            fence = { marker: delimiter[1][0], length: delimiter[1].length };
            return `[代码${delimiter[2].trim() ? ' ' + delimiter[2].trim() : ''}]`;
        }
        let text = fence ? line.replace(/\t/g, '    ') : readableInlineMarkdown(line.replace(/^( {0,3}(?:助手：|你：)?)#{1,6}\s+(.*?)(?:\s+#+\s*)?$/, '$1$2'));
        if (!fence && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text)) text = '';
        return options.emojiFallback ? compatibleEmojiText(text) : text;
    });
}

function valueObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function isJsonMime(mime: string): boolean { return /(?:application\/json|\+json)(?:;|$)/i.test(mime); }

export function artifactMetadata(source: unknown, conversationId: string, dataDir?: string): Record<string, unknown> {
    const artifact = valueObject(source);
    const artifactId = typeof artifact.artifactId === 'string' ? artifact.artifactId : undefined;
    const args = [...(dataDir ? ['--data-dir', dataDir] : []), '--conversation', conversationId, 'artifact', 'save', artifactId ?? '<artifactId>', '<目标文件>'];
    const quote = (value: string) => process.platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
    return { artifactId: artifactId ?? null, type: artifact.type ?? null, mime: artifact.mime ?? null,
        state: artifact.state ?? null, totalBytes: artifact.totalBytes ?? artifact.byteLength ?? null, sha256: artifact.sha256 ?? null,
        saveArgs: args, saveCommand: 'sandbox_agent ' + args.map(quote).join(' ') };
}

export function formatExecutionText(source: unknown, conversationId: string, dataDir?: string): string | undefined {
    const result = valueObject(source);
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    if (typeof result.text !== 'string' && !artifacts.length) return undefined;
    const sections = typeof result.text === 'string' && result.text ? [terminalSafeText(result.text)] : [];
    for (const entry of artifacts) {
        const artifact = artifactMetadata(entry, conversationId, dataDir);
        sections.push(`产物 ${artifact.artifactId ?? '身份待确认'}\n类型 ${artifact.mime ?? artifact.type ?? '未知'} · 字节 ${artifact.totalBytes ?? '未知'} · 状态 ${artifact.state ?? '未知'}\nSHA256 ${artifact.sha256 ?? '未知'}\n保存：${artifact.saveCommand}`);
    }
    return terminalSafeText(sections.join('\n\n'));
}

export function humanJson(value: unknown): string {
    return JSON.stringify(value, function (key, entry: unknown) {
        if (typeof entry !== 'string') return entry;
        const parent = this as Record<string, unknown>;
        const binary = /^(?:dataBase64|base64)$/i.test(key) || /^data:[^,]+;base64,/i.test(entry)
            || key === 'data' && ['mime', 'mimeType', 'mime_type', 'media_type'].some(name => typeof parent[name] === 'string');
        return binary ? `[原始媒体编码：${entry.length}字符；完整原字节请按contentId或media:引用保存]` : entry;
    }, 2) ?? 'null';
}
