import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import type { InstructionSource } from './contracts.js';

export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_INSTRUCTION_BYTES = 64 * 1024;

export class ConfigurationSourceReader {
    constructor(private readonly roots: readonly string[]) {
        if (roots.some(root => !isAbsolute(root))) throw new TypeError('Configuration source roots must be explicit absolute product material directories');
    }

    async validatePath(path: string): Promise<string> {
        if (!isAbsolute(path) || !['.md', '.txt'].includes(extname(path).toLowerCase())) {
            throw new AgentFault('CONFIGURATION_SOURCE_INVALID', '规则和技能须为明确的UTF-8 Markdown或文本文件');
        }
        const actual = await realpath(path);
        const roots = await Promise.all(this.roots.map(root => realpath(root)));
        if (!roots.some(root => {
            const child = relative(root, actual);
            return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
        })) throw new AgentFault('CONFIGURATION_SOURCE_ROOT', '来源须位于本产品明确配置的材料目录内');
        return resolve(actual);
    }

    async read(source: InstructionSource): Promise<{ text: string; sha256: string; version: string; bytes: number; path: string }> {
        const path = await this.validatePath(source.path);
        const file = await open(path, 'r');
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new AgentFault('CONFIGURATION_SOURCE_LIMIT', '每份规则或技能正文最多32KiB');
            const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const part = await file.read(bytes, offset, bytes.length - offset, null);
                if (!part.bytesRead) break;
                offset += part.bytesRead;
            }
            if (offset > MAX_SOURCE_BYTES) throw new AgentFault('CONFIGURATION_SOURCE_LIMIT', '来源在读取期间超过32KiB');
            const original = bytes.subarray(0, offset);
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); }
            catch { throw new AgentFault('CONFIGURATION_SOURCE_ENCODING', '规则和技能来源必须使用有效UTF-8'); }
            const hash = createHash('sha256').update(original).digest('hex');
            return { text, sha256: hash, version: `sha256:${hash}`, bytes: offset, path };
        } finally { await file.close(); }
    }
}
