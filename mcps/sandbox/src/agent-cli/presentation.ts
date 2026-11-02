import { terminalSafeText } from './renderer.js';

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
