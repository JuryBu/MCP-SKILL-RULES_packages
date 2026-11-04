import { open, opendir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function directoryPage(directory: string, offset = 0, limit = 20): Promise<{ path: string; entries: { name: string; path: string; directory: boolean }[]; nextOffset?: number }> {
    const path = resolve(directory);
    const entries: { name: string; path: string; directory: boolean }[] = [];
    let index = 0;
    for await (const entry of await opendir(path)) {
        if (index++ < offset) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        if (entries.length === limit) return { path, entries, nextOffset: index - 1 };
        entries.push({ name: entry.name, path: resolve(path, entry.name), directory: entry.isDirectory() });
    }
    return { path, entries };
}

export async function filePreview(path: string, range?: string): Promise<{ lines: string[]; scope: string }> {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('请选择普通文件，目录需先展开再选择文件');
    const match = range ? /^#?L?(\d+)(?:-L?(\d+))?$/.exec(range) : undefined;
    if (range && !match) throw new Error('行范围请填写L12-L30');
    const start = match ? Number(match[1]) : 1;
    const end = match ? Number(match[2] ?? match[1]) : undefined;
    if (start < 1 || end !== undefined && end < start) throw new Error('行范围需从1开始且结束行不小于开始行');
    const handle = await open(path, 'r');
    try {
        const bytes = Buffer.alloc(Math.min(metadata.size, 32 * 1024));
        const read = await handle.read(bytes, 0, bytes.length, 0);
        const text = bytes.subarray(0, read.bytesRead).toString('utf8');
        const scope = range ? `发送 ${range.replace(/^#/, '')} · 文件 ${metadata.size} 字节` : `发送整个文件 · ${metadata.size} 字节`;
        if (text.includes('\0')) return { lines: ['二进制或媒体文件，按原字节作为附件发送'], scope };
        const lines = text.split(/\r?\n/);
        return { lines: lines.slice(start - 1, Math.min(end ?? lines.length, start + 5)).map((line, index) => `${start + index}: ${line}`)
            .concat(metadata.size > read.bytesRead ? ['预览仅读取前32KiB，发送范围见上方'] : []), scope };
    } finally { await handle.close(); }
}
