export type CommandOutputEncoding = 'auto' | 'utf8' | 'gb18030' | 'utf16le';

export function decodeCommandOutput(base64: string, requested: CommandOutputEncoding = 'auto', platform = process.platform) {
    const bytes = Buffer.from(base64, 'base64');
    const decode = (encoding: Exclude<CommandOutputEncoding, 'auto'>) => new TextDecoder(
        encoding === 'utf16le' ? 'utf-16le' : encoding, { fatal: true }).decode(bytes);
    if (requested !== 'auto') {
        try { return { text: decode(requested), encoding: requested, status: 'valid', source: 'explicit' }; }
        catch { return { text: '[原始输出已保存在Base64字段中，指定编码解码失败，请核对程序输出编码后重解原字节]',
            encoding: requested, status: 'unresolved', source: 'explicit' }; }
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        try { return { text: decode('utf16le'), encoding: 'utf16le', status: 'valid', source: 'bom' }; } catch {}
    }
    try { return { text: decode('utf8'), encoding: 'utf8', status: 'valid', source: 'strict_utf8' }; } catch {}
    if (platform === 'win32') {
        try { return { text: decode('gb18030'), encoding: 'gb18030', status: 'candidate', source: 'windows_legacy_candidate' }; } catch {}
    }
    return { text: '[原始输出已保存在Base64字段中，自动解码未确定编码，请核对程序编码后重解原字节]',
        encoding: null, status: 'unresolved', source: 'raw_bytes' };
}
