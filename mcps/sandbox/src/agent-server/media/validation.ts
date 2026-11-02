import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';

const BASE64_CHUNK_CHARACTERS = 64 * 1024;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+:/-]+|"[^"\r\n]*"))*$/i;

export interface Base64Info {
    byteLength: number;
    sha256: string;
    padded: boolean;
    prefix: Buffer;
    utf8Valid: boolean;
    containsNul: boolean;
}

export function normalizeMime(value: unknown): string {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || !MIME_PATTERN.test(value)) {
        throw new AgentFault('MEDIA_MIME_INVALID', '媒体MIME缺失或格式无效');
    }
    const separator = value.indexOf(';');
    return separator < 0 ? value.toLowerCase() : value.slice(0, separator).trim().toLowerCase() + value.slice(separator);
}

export function* base64Chunks(value: string): Iterable<Buffer> {
    for (let offset = 0; offset < value.length; offset += BASE64_CHUNK_CHARACTERS) {
        yield Buffer.from(value.slice(offset, offset + BASE64_CHUNK_CHARACTERS), 'base64');
    }
}

export function inspectBase64(value: string, maxBytes: number): Base64Info {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new AgentFault('INVALID_PARAMS', '媒体字节上限无效');
    if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
        throw new AgentFault('MEDIA_CONTENT_LIMIT', '媒体超过单块字节上限', { maxBytes });
    }
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const unpaddedLength = value.length - padding;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || unpaddedLength % 4 === 1
        || (padding > 0 && value.length % 4 !== 0)) {
        throw new AgentFault('MEDIA_BASE64_INVALID', '媒体Base64格式无效');
    }
    const byteLength = Math.floor(unpaddedLength * 3 / 4);
    if (byteLength > maxBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '媒体超过单块字节上限', { maxBytes });
    if (unpaddedLength % 4 === 2 || unpaddedLength % 4 === 3) {
        const tail = value.slice(Math.max(0, unpaddedLength - (unpaddedLength % 4)), unpaddedLength);
        if (Buffer.from(tail, 'base64').toString('base64').replace(/=+$/, '') !== tail) {
            throw new AgentFault('MEDIA_BASE64_INVALID', '媒体Base64尾部包含非规范位');
        }
    }
    if (padding !== 0 && padding !== (4 - unpaddedLength % 4) % 4) {
        throw new AgentFault('MEDIA_BASE64_INVALID', '媒体Base64填充无效');
    }
    const checksum = createHash('sha256');
    let actualBytes = 0;
    let prefix = Buffer.alloc(0);
    let utf8Valid = true;
    let containsNul = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const chunk of base64Chunks(value)) {
        checksum.update(chunk);
        actualBytes += chunk.length;
        if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
        if (chunk.includes(0)) containsNul = true;
        if (utf8Valid) { try { decoder.decode(chunk, { stream: true }); } catch { utf8Valid = false; } }
    }
    if (utf8Valid) { try { decoder.decode(); } catch { utf8Valid = false; } }
    if (actualBytes !== byteLength) throw new AgentFault('MEDIA_BASE64_INVALID', '媒体Base64长度校验失败');
    return { byteLength, sha256: checksum.digest('hex'), padded: padding > 0, prefix, utf8Valid, containsNul };
}

export function validateMediaBytes(type: 'image' | 'audio' | 'video' | 'file', mime: string, info: Base64Info): 'signature' | 'declared' {
    const essence = mime.split(';', 1)[0];
    if (type !== 'file' && !essence.startsWith(`${type}/`)) throw new AgentFault('MEDIA_MIME_MISMATCH', '媒体块类型与MIME不一致');
    const bytes = info.prefix;
    const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
    const ascii = (value: string, offset = 0) => bytes.subarray(offset, offset + value.length).equals(Buffer.from(value, 'ascii'));
    let valid: boolean | undefined;
    switch (essence) {
        case 'image/png': valid = starts(137, 80, 78, 71, 13, 10, 26, 10) && ascii('IHDR', 12)
            && bytes.length >= 33 && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0; break;
        case 'image/jpeg': case 'image/jpg': valid = starts(255, 216, 255); break;
        case 'image/gif': valid = (ascii('GIF87a') || ascii('GIF89a')) && bytes.length >= 10
            && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0; break;
        case 'image/webp': valid = ascii('RIFF') && ascii('WEBP', 8); break;
        case 'image/avif': valid = ascii('ftyp', 4) && (ascii('avif', 8) || ascii('avis', 8)); break;
        case 'audio/wav': case 'audio/wave': case 'audio/x-wav': valid = ascii('RIFF') && ascii('WAVE', 8); break;
        case 'audio/mpeg': case 'audio/mp3': valid = ascii('ID3') || (bytes.length > 1 && bytes[0] === 255 && (bytes[1] & 224) === 224); break;
        case 'audio/ogg': case 'video/ogg': valid = ascii('OggS'); break;
        case 'audio/flac': case 'audio/x-flac': valid = ascii('fLaC'); break;
        case 'audio/aac': valid = bytes.length > 1 && bytes[0] === 255 && (bytes[1] & 246) === 240; break;
        case 'audio/mp4': case 'video/mp4': valid = ascii('ftyp', 4); break;
        case 'video/webm': case 'audio/webm': valid = starts(26, 69, 223, 163); break;
        case 'audio/pcm': case 'audio/l16': valid = info.byteLength > 0 && info.byteLength % 2 === 0; break;
        case 'application/pdf': valid = ascii('%PDF-'); break;
        case 'application/zip': valid = starts(80, 75, 3, 4) || starts(80, 75, 5, 6) || starts(80, 75, 7, 8); break;
        case 'application/octet-stream': valid = true; break;
        default:
            if (type !== 'file') throw new AgentFault('MEDIA_MIME_UNSUPPORTED', '当前媒体类型尚无字节校验器', { mime });
            if ((essence.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(essence))
                && (!info.utf8Valid || info.containsNul)) throw new AgentFault('MEDIA_MIME_MISMATCH', '文本文件的原字节不是有效UTF-8文本', { mime });
    }
    if (valid === false) throw new AgentFault('MEDIA_MIME_MISMATCH', '媒体原字节与声明MIME不一致', { mime });
    return valid === true && !['application/octet-stream', 'audio/pcm', 'audio/l16'].includes(essence) ? 'signature' : 'declared';
}

export function validateRemoteUri(uri: string): void {
    if (uri.length < 1 || uri.length > 8192 || /[\u0000-\u001f\u007f]/.test(uri)
        || !/^[a-z][a-z0-9+.-]*:/i.test(uri) || /^data:/i.test(uri)) {
        throw new AgentFault('MEDIA_URI_INVALID', '远端媒体URI无效');
    }
}

export function requireMediaSlice(offset = 0, maxBytes = 256 * 1024): { offset: number; maxBytes: number } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024) {
        throw new AgentFault('INVALID_PARAMS', '媒体分片参数无效', { maxBytes: 512 * 1024 });
    }
    return { offset, maxBytes };
}
