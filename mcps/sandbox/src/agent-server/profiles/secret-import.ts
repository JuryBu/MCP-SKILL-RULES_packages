import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AgentFault } from '../protocol.js';

export interface SecretImportSource {
    sourcePath: string;
    format: 'plain' | 'env' | 'json';
    field?: string;
}

export function parseSecretImport(content: Uint8Array, format: SecretImportSource['format'], field?: string): Buffer {
    if (content.byteLength < 1 || content.byteLength > 65_536) throw new AgentFault('E_SECRET_SOURCE_LIMIT', '凭据来源必须为1至65536字节');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, ''); }
    catch { throw new AgentFault('E_SECRET_SOURCE_PARSE', '凭据来源需要有效UTF-8文本'); }
    let secret: unknown;
    if (format === 'plain') {
        if (field !== undefined) throw new AgentFault('E_SECRET_SOURCE_PARSE', 'plain格式不使用字段名');
        secret = text.trim();
    } else if (format === 'json') {
        if (!field) throw new AgentFault('E_SECRET_SOURCE_FIELD', 'json格式需要明确指定字段');
        try {
            const value = JSON.parse(text) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) throw new Error();
            secret = (value as Record<string, unknown>)[field];
        } catch { throw new AgentFault('E_SECRET_SOURCE_PARSE', 'json来源无法取得指定的凭据字段'); }
    } else if (format === 'env') {
        if (!field || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new AgentFault('E_SECRET_SOURCE_FIELD', 'env格式需要明确指定合法字段名');
        const matches: string[] = [];
        for (const line of text.split(/\r?\n/)) {
            const matched = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
            if (!matched || matched[1] !== field) continue;
            const value = matched[2].trim();
            if (value.startsWith('"') || value.startsWith("'")) {
                const quoted = value.match(/^("(?:[^"\\]|\\.)*"|'[^']*')(?:\s+#.*)?$/);
                if (!quoted) throw new AgentFault('E_SECRET_SOURCE_PARSE', 'env凭据字段的引号格式无效');
                try { matches.push(quoted[1].startsWith('"') ? JSON.parse(quoted[1]) as string : quoted[1].slice(1, -1)); }
                catch { throw new AgentFault('E_SECRET_SOURCE_PARSE', 'env凭据字段的编码无效'); }
            } else matches.push(value.replace(/\s+#.*$/, '').trim());
        }
        if (matches.length !== 1) throw new AgentFault('E_SECRET_SOURCE_FIELD', 'env来源需要唯一的指定凭据字段');
        secret = matches[0];
    } else throw new AgentFault('E_SECRET_SOURCE_PARSE', '凭据来源格式无效');
    if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret)) throw new AgentFault('E_SECRET_SOURCE_PARSE', '指定字段需要单行非空凭据文本');
    const bytes = Buffer.from(secret, 'utf8');
    if (bytes.length > 65_536) { bytes.fill(0); throw new AgentFault('E_SECRET_SOURCE_LIMIT', '凭据来源超过字节上限'); }
    return bytes;
}

export async function readSecretImport(source: SecretImportSource): Promise<Buffer> {
    if (!isAbsolute(source.sourcePath)) throw new AgentFault('E_SECRET_SOURCE_PATH', '凭据来源需要绝对文件路径');
    const bytes = Buffer.alloc(65_537);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let parsed: Buffer | undefined;
    try {
        const link = await lstat(source.sourcePath);
        if (!link.isFile() || link.isSymbolicLink()) throw new AgentFault('E_SECRET_SOURCE_PATH', '凭据来源需要普通文件');
        file = await open(source.sourcePath, 'r');
        const before = await file.stat();
        if (!before.isFile() || before.size < 1 || before.size > 65_536) throw new AgentFault('E_SECRET_SOURCE_LIMIT', '凭据来源必须为1至65536字节的普通文件');
        let length = 0;
        while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        const after = await file.stat();
        if (length > 65_536) throw new AgentFault('E_SECRET_SOURCE_LIMIT', '凭据来源超过字节上限');
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new AgentFault('E_SECRET_SOURCE_CHANGED', '凭据来源读取期间发生变化');
        parsed = parseSecretImport(bytes.subarray(0, length), source.format, source.field);
        return parsed;
    } catch (error) {
        if (error instanceof AgentFault) throw error;
        throw new AgentFault('E_SECRET_SOURCE_READ', '服务端未能读取指定的凭据来源');
    } finally {
        bytes.fill(0);
        try { await file?.close(); }
        catch { parsed?.fill(0); throw new AgentFault('E_SECRET_SOURCE_READ', '服务端凭据来源未正常关闭'); }
    }
}
