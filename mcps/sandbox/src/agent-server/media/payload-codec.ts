import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { binaryObjectPath } from './binary-files.js';
import { base64Chunks, inspectBase64, normalizeMime, requireMediaSlice } from './validation.js';
import type { BinaryPayloadRef, BinaryPayloadStore, PreparedBinaryPayload } from './types.js';

export const MEDIA_PAYLOAD_CODEC = 'agent-media-json-v1' as const;
type JsonPath = (string | number)[];
interface Whitespace { offset: number; text: string }
interface LexicalEscape { offset: number; raw: string }

export interface PayloadSpelling {
    payload: number;
    prefix: string;
    padded: boolean;
    alphabet: 'standard' | 'url';
    whitespace: Whitespace[];
    jsonEscapes?: LexicalEscape[];
}

export type MediaStringPart = { literal: string } | PayloadSpelling;
export interface MediaStringRecipe {
    path: JsonPath;
    sourceHash: string;
    sourceBytes: number;
    parts: MediaStringPart[];
}

export interface EncodedMediaPayload {
    codec: typeof MEDIA_PAYLOAD_CODEC;
    version: 1;
    sourceHash: string;
    sourceBytes: number;
    value: JsonValue;
    payloads: BinaryPayloadRef[];
    strings: MediaStringRecipe[];
}

export interface MediaCodecLimits {
    maxSourceBytes: number;
    maxMetadataBytes: number;
    maxDecodedBytes: number;
    maxPayloadBytes: number;
    maxTotalPayloadBytes: number;
    maxPayloads: number;
    maxStrings: number;
    maxNodes: number;
    maxDepth: number;
    maxAdjustments: number;
    minPayloadBytes: number;
}

const DEFAULT_LIMITS: Readonly<MediaCodecLimits> = Object.freeze({ maxSourceBytes: 32 * 1024 * 1024,
    maxMetadataBytes: 32 * 1024 * 1024, maxDecodedBytes: 32 * 1024 * 1024,
    maxPayloadBytes: 32 * 1024 * 1024, maxTotalPayloadBytes: 32 * 1024 * 1024,
    maxPayloads: 256, maxStrings: 8192, maxNodes: 200_000,
    maxDepth: 96, maxAdjustments: 16_384, minPayloadBytes: 32 });
const PAYLOAD_KEYS = new Set(['dataBase64', 'b64_json', 'data', 'image_base64', 'audio_data', 'bytes', 'result', 'thoughtSignature']);
const TEXT_CHUNK = 16 * 1024;

function hashText(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function objectValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }

function* quotedParts(parts: Iterable<string>): Iterable<string> {
    yield '"';
    let carried = '';
    for (const part of parts) {
        let text = carried + part;
        carried = '';
        if (text.length && isHighSurrogate(text.charCodeAt(text.length - 1))) { carried = text.slice(-1); text = text.slice(0, -1); }
        for (let offset = 0; offset < text.length;) {
            let end = Math.min(text.length, offset + TEXT_CHUNK);
            if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end += 1;
            yield JSON.stringify(text.slice(offset, end)).slice(1, -1);
            offset = end;
        }
    }
    if (carried) yield JSON.stringify(carried).slice(1, -1);
    yield '"';
}

function* canonicalParts(value: unknown, limits: Readonly<MediaCodecLimits>, budget = { nodes: 0 }, depth = 0): Iterable<string> {
    budget.nodes += 1;
    if (budget.nodes > limits.maxNodes || depth > limits.maxDepth) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体对象结构超过编码上限');
    if (value === null || typeof value === 'boolean') { yield JSON.stringify(value); return; }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new AgentFault('INVALID_PARAMS', '数值必须有限');
        yield JSON.stringify(value); return;
    }
    if (typeof value === 'string') { yield* quotedParts([value]); return; }
    if (Array.isArray(value)) {
        yield '[';
        for (let index = 0; index < value.length; index += 1) {
            if (index) yield ',';
            yield* canonicalParts(value[index], limits, budget, depth + 1);
        }
        yield ']'; return;
    }
    const object = objectValue(value);
    if (object) {
        yield '{';
        let first = true;
        for (const key of Object.keys(object).filter(key => object[key] !== undefined).sort()) {
            if (!first) yield ',';
            first = false;
            yield* quotedParts([key]); yield ':';
            yield* canonicalParts(object[key], limits, budget, depth + 1);
        }
        yield '}'; return;
    }
    throw new AgentFault('INVALID_PARAMS', '媒体对象须为JSON兼容值');
}

function digestParts(parts: Iterable<string>, maxBytes: number): { hash: string; bytes: number } {
    const checksum = createHash('sha256');
    let bytes = 0;
    for (const part of parts) {
        bytes += Buffer.byteLength(part);
        if (bytes > maxBytes) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体对象超过有界编码字节上限', { maxBytes });
        checksum.update(part);
    }
    return { hash: checksum.digest('hex'), bytes };
}

interface JsonStringToken { start: number; end: number; value: string; key: string | null; isKey: boolean }
function* stringTokens(body: string): Iterable<JsonStringToken> {
    let key: string | null = null;
    for (let position = 0; position < body.length; position += 1) {
        if (body[position] !== '"') continue;
        const start = position;
        position += 1;
        for (; position < body.length; position += 1) {
            if (body[position] === '\\') { position += 1; continue; }
            if (body[position] === '"') break;
        }
        if (position >= body.length) return;
        const end = position + 1;
        let value: string;
        try { value = JSON.parse(body.slice(start, end)) as string; } catch { continue; }
        let next = end;
        while (next < body.length && /\s/.test(body[next])) next += 1;
        const isKey = body[next] === ':';
        yield { start, end, value, key, isKey };
        if (isKey) key = value;
    }
}

function lexicalEscapes(token: string, maxAdjustments: number): LexicalEscape[] {
    const result: LexicalEscape[] = [];
    let offset = 0;
    for (let position = 1; position < token.length - 1; position += 1) {
        if (token[position] === '\\') {
            const size = token[position + 1] === 'u' ? 6 : 2;
            result.push({ offset, raw: token.slice(position, position + size) });
            if (result.length > maxAdjustments) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体原始JSON转义数量超过上限');
            position += size - 1;
        }
        offset += 1;
    }
    return result;
}

function mimeOf(parent: Record<string, unknown> | undefined): string {
    for (const name of ['mime', 'mimeType', 'mime_type', 'media_type']) {
        if (typeof parent?.[name] === 'string') {
            try { return normalizeMime(parent[name]); } catch { }
        }
    }
    return 'application/octet-stream';
}

function payloadField(key: string | number | null, parent: Record<string, unknown> | undefined): boolean {
    if (typeof key !== 'string' || !PAYLOAD_KEYS.has(key)) return false;
    if (key === 'result') return parent?.type === 'image_generation_call';
    if (key !== 'data' && key !== 'bytes') return true;
    return ['mime', 'mimeType', 'mime_type', 'media_type'].some(name => typeof parent?.[name] === 'string')
        || (typeof parent?.type === 'string' && /^(?:base64|input_audio|output_audio|audio|image)$/.test(parent.type))
        || (typeof parent?.format === 'string' && /^(?:wav|mp3|ogg|flac|aac|pcm16)$/.test(parent.format));
}

function bodyPayloadField(key: string | null, bodyHasMedia: boolean): boolean {
    return key !== null && PAYLOAD_KEYS.has(key) && (!['data', 'bytes', 'result'].includes(key) || bodyHasMedia);
}

interface Candidate { spelling: PayloadSpelling; clean: string; reference: Omit<BinaryPayloadRef, 'path'> }

export function* canonicalJsonByteChunks(value: unknown, options: { maxBytes?: number; maxNodes?: number; maxDepth?: number } = {}): Iterable<Buffer> {
    const limits = { ...DEFAULT_LIMITS, ...options };
    const maxBytes = options.maxBytes ?? DEFAULT_LIMITS.maxSourceBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new AgentFault('INVALID_PARAMS', 'JSON编码字节上限无效');
    let bytes = 0;
    for (const part of canonicalParts(value, limits)) {
        bytes += Buffer.byteLength(part);
        if (bytes > maxBytes) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', 'JSON编码超过实际分配预算');
        yield Buffer.from(part);
    }
}

export class MediaPayloadCodec {
    readonly limits: Readonly<MediaCodecLimits>;

    constructor(private readonly binary: BinaryPayloadStore, limits: Partial<MediaCodecLimits> = {}) {
        this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
        for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) {
            throw new AgentFault('INVALID_PARAMS', '媒体编码上限须为正整数');
        }
    }

    encode(value: unknown, onPreparedBinary?: (payload: PreparedBinaryPayload) => void): EncodedMediaPayload | undefined {
        const candidates = new Map<string, Candidate>();
        const unique = new Map<string, Candidate>();
        let totalPayloadBytes = 0;
        let adjustments = 0;
        const register = (text: string, mime: string, eligible: boolean): Candidate | undefined => {
            const known = candidates.get(text);
            if (known) return known;
            const dataUri = /^data:([^,]+);base64,/i.exec(text);
            if (!eligible && !dataUri) return undefined;
            const prefix = dataUri?.[0] ?? '';
            const payload = text.slice(prefix.length);
            if (payload.length < Math.ceil(this.limits.minPayloadBytes / 3) * 4 - 2) return undefined;
            const whitespace: Whitespace[] = [];
            let clean = '';
            let last = 0;
            for (const match of payload.matchAll(/[\t\n\r ]+/g)) {
                clean += payload.slice(last, match.index);
                whitespace.push({ offset: clean.length, text: match[0] });
                last = match.index! + match[0].length;
                if (whitespace.length + adjustments > this.limits.maxAdjustments) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体Base64排版数量超过上限');
            }
            clean += payload.slice(last);
            const alphabet = /[-_]/.test(clean) ? 'url' : 'standard';
            if (alphabet === 'url' && /[+/]/.test(clean)) return undefined;
            if (alphabet === 'url') clean = clean.replace(/-/g, '+').replace(/_/g, '/');
            let info;
            try { info = inspectBase64(clean, this.limits.maxPayloadBytes); }
            catch (error) {
                if (error instanceof AgentFault && error.code === 'MEDIA_BASE64_INVALID') return undefined;
                throw error;
            }
            if (info.byteLength < this.limits.minPayloadBytes) return undefined;
            if (dataUri) { try { mime = normalizeMime(dataUri[1]); } catch { return undefined; } }
            const previous = unique.get(info.sha256);
            const index = previous?.spelling.payload ?? unique.size;
            if (!previous && unique.size >= this.limits.maxPayloads) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体唯一原件数量超过编码上限');
            if (!previous && totalPayloadBytes + info.byteLength > this.limits.maxTotalPayloadBytes) {
                throw new AgentFault('MEDIA_CONTENT_LIMIT', '媒体唯一原件累计字节超过上限',
                    { bytes: totalPayloadBytes + info.byteLength, maxBytes: this.limits.maxTotalPayloadBytes, scope: 'unique_payloads' });
            }
            const candidate: Candidate = { clean, spelling: { payload: index, prefix, padded: info.padded, alphabet, whitespace },
                reference: { sha256: info.sha256, byteLength: info.byteLength, mime } };
            candidates.set(text, candidate);
            if (!previous) { unique.set(info.sha256, candidate); totalPayloadBytes += info.byteLength; }
            adjustments += whitespace.length;
            return candidate;
        };
        let nodes = 0;
        const discover = (entry: unknown, key: string | number | null, parent: Record<string, unknown> | undefined, depth: number): void => {
            nodes += 1;
            if (nodes > this.limits.maxNodes || depth > this.limits.maxDepth) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体对象结构超过编码上限');
            if (typeof entry === 'string') {
                register(entry, key === 'thoughtSignature' ? 'application/octet-stream' : mimeOf(parent), payloadField(key, parent));
                if (key === 'body') {
                    const bodyHasMedia = /"(?:mimeType|mime_type|media_type|mime|inlineData|inline_data)"\s*:|"type"\s*:\s*"(?:base64|input_audio|output_audio|image_generation_call)"|"format"\s*:\s*"(?:wav|mp3|ogg|flac|aac|pcm16)"/.test(entry);
                    for (const token of stringTokens(entry)) if (!token.isKey) {
                        register(token.value, 'application/octet-stream', bodyPayloadField(token.key, bodyHasMedia));
                    }
                }
            } else if (Array.isArray(entry)) entry.forEach((child, index) => discover(child, index, undefined, depth + 1));
            else {
                const object = objectValue(entry);
                if (object) for (const name of Object.keys(object)) if (object[name] !== undefined) discover(object[name], name, object, depth + 1);
            }
        };
        discover(value, null, undefined, 0);
        if (!unique.size) return undefined;
        const source = digestParts(canonicalParts(value, this.limits), this.limits.maxSourceBytes);
        const strings: MediaStringRecipe[] = [];
        let recipeAdjustments = 0;
        const recipe = (text: string, path: JsonPath): MediaStringRecipe | undefined => {
            const candidate = candidates.get(text);
            let parts: MediaStringPart[] | undefined;
            if (candidate) parts = [candidate.spelling];
            else if (path.at(-1) === 'body') {
                const bodyParts: MediaStringPart[] = [];
                let position = 0;
                for (const token of stringTokens(text)) {
                    if (token.isKey) continue;
                    const match = candidates.get(token.value);
                    if (!match) continue;
                    bodyParts.push({ literal: text.slice(position, token.start) });
                    const escapes = lexicalEscapes(text.slice(token.start, token.end), this.limits.maxAdjustments - adjustments);
                    adjustments += escapes.length;
                    bodyParts.push({ ...match.spelling, jsonEscapes: escapes });
                    position = token.end;
                }
                if (position) { bodyParts.push({ literal: text.slice(position) }); parts = bodyParts; }
            }
            if (!parts) return undefined;
            if (strings.length >= this.limits.maxStrings) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体字符串引用数量超过编码上限');
            for (const part of parts) if (!('literal' in part)) recipeAdjustments += part.whitespace.length + (part.jsonEscapes?.length ?? 0);
            if (recipeAdjustments > this.limits.maxAdjustments) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体字符串排版恢复信息超过上限');
            const result = { path, sourceHash: hashText(text), sourceBytes: Buffer.byteLength(text), parts };
            strings.push(result);
            return result;
        };
        const clone = (entry: unknown, path: JsonPath): JsonValue => {
            if (typeof entry === 'string') return recipe(entry, path) ? null : entry;
            if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
            if (Array.isArray(entry)) return entry.map((child, index) => clone(child, [...path, index]));
            const result: Record<string, JsonValue> = {};
            const object = objectValue(entry)!;
            for (const key of Object.keys(object)) if (object[key] !== undefined) Object.defineProperty(result, key,
                { value: clone(object[key], [...path, key]), enumerable: true, configurable: true, writable: true });
            return result;
        };
        const skeleton = clone(value, []);
        const payloads: BinaryPayloadRef[] = [...unique.values()].map(candidate => ({ ...candidate.reference,
            path: binaryObjectPath(candidate.reference.sha256) }));
        const encoded: EncodedMediaPayload = { codec: MEDIA_PAYLOAD_CODEC, version: 1, sourceHash: source.hash, sourceBytes: source.bytes,
            value: skeleton, payloads, strings };
        this.validateEnvelope(encoded);
        let payloadIndex = 0;
        for (const candidate of unique.values()) {
            const prepared = this.binary.prepare(base64Chunks(candidate.clean), candidate.reference);
            onPreparedBinary?.(prepared);
            payloads[payloadIndex] = { sha256: prepared.sha256, byteLength: prepared.byteLength, mime: prepared.mime, path: prepared.path };
            payloadIndex += 1;
        }
        this.validateEnvelope(encoded);
        return encoded;
    }

    references(encoded: EncodedMediaPayload): BinaryPayloadRef[] {
        this.recipeMap(encoded);
        return encoded.payloads.map(reference => ({ ...reference }));
    }

    decode(encoded: EncodedMediaPayload, options: { maxBytes?: number } = {}): JsonValue {
        const maxBytes = options.maxBytes ?? Math.min(this.limits.maxDecodedBytes, this.limits.maxSourceBytes);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxSourceBytes) {
            throw new AgentFault('INVALID_PARAMS', '媒体整份读取预算无效', { maxBytes: this.limits.maxSourceBytes });
        }
        const recipes = this.recipeMap(encoded);
        if (encoded.sourceBytes > maxBytes) {
            throw new AgentFault('STORAGE_DECOMPRESS_LIMIT', '媒体原始JSON超过整份读取上限，请使用原件分片读取',
                { bytes: encoded.sourceBytes, maxBytes });
        }
        let nodes = 0;
        let restored = 0;
        let restoredBytes = 0;
        const restore = (entry: JsonValue, path: JsonPath, depth: number): JsonValue => {
            nodes += 1;
            if (nodes > this.limits.maxNodes || depth > this.limits.maxDepth) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体对象结构超过解码上限');
            const replacement = recipes.get(JSON.stringify(path));
            if (replacement) {
                if (entry !== null) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体字符串占位无效');
                restoredBytes += replacement.sourceBytes;
                if (restoredBytes > maxBytes) throw new AgentFault('STORAGE_DECOMPRESS_LIMIT', '媒体字符串累计恢复字节超过整份读取预算', { maxBytes });
                restored += 1;
                return [...this.stringParts(encoded, replacement)].join('');
            }
            if (Array.isArray(entry)) return entry.map((child, index) => restore(child, [...path, index], depth + 1));
            const object = objectValue(entry);
            if (object) {
                const result: Record<string, JsonValue> = {};
                for (const key of Object.keys(object)) Object.defineProperty(result, key,
                    { value: restore(object[key] as JsonValue, [...path, key], depth + 1), enumerable: true, configurable: true, writable: true });
                return result;
            }
            return entry;
        };
        const result = restore(encoded.value, [], 0);
        if (restored !== recipes.size) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复清单包含无效路径');
        const actual = digestParts(canonicalParts(result, this.limits), maxBytes);
        this.checkSource(encoded, actual);
        return result;
    }

    *decodedJsonChunks(encoded: EncodedMediaPayload): Iterable<Buffer> {
        const recipes = this.recipeMap(encoded);
        let nodes = 0;
        let restored = 0;
        const emit = function* (this: MediaPayloadCodec, entry: JsonValue, path: JsonPath, depth: number): Iterable<string> {
            nodes += 1;
            if (nodes > this.limits.maxNodes || depth > this.limits.maxDepth) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体对象结构超过解码上限');
            const replacement = recipes.get(JSON.stringify(path));
            if (replacement) {
                if (entry !== null) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体字符串占位无效');
                restored += 1;
                yield* quotedParts(this.stringParts(encoded, replacement)); return;
            }
            if (Array.isArray(entry)) {
                yield '[';
                for (let index = 0; index < entry.length; index += 1) {
                    if (index) yield ',';
                    yield* emit.call(this, entry[index], [...path, index], depth + 1);
                }
                yield ']'; return;
            }
            const object = objectValue(entry);
            if (object) {
                yield '{';
                let first = true;
                for (const key of Object.keys(object).sort()) {
                    if (!first) yield ',';
                    first = false;
                    yield* quotedParts([key]); yield ':';
                    yield* emit.call(this, object[key] as JsonValue, [...path, key], depth + 1);
                }
                yield '}'; return;
            }
            yield* canonicalParts(entry, this.limits);
        };
        const checksum = createHash('sha256');
        let bytes = 0;
        for (const part of emit.call(this, encoded.value, [], 0)) {
            const chunk = Buffer.from(part);
            bytes += chunk.length;
            if (bytes > encoded.sourceBytes || bytes > this.limits.maxSourceBytes) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体还原字节超过声明上限');
            checksum.update(chunk);
            yield chunk;
        }
        if (restored !== recipes.size) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复清单包含无效路径');
        this.checkSource(encoded, { bytes, hash: checksum.digest('hex') });
    }

    readJsonSlice(encoded: EncodedMediaPayload, offset = 0, maxBytes = 256 * 1024): {
        mime: 'application/json'; offset: number; totalBytes: number; sha256: string; dataBase64: string; nextOffset: number | null; complete: boolean;
    } {
        requireMediaSlice(offset, maxBytes);
        this.validateEnvelope(encoded);
        if (offset > encoded.sourceBytes) throw new AgentFault('INVALID_PARAMS', '原件偏移超过总字节数');
        const end = Math.min(encoded.sourceBytes, offset + maxBytes);
        const page = Buffer.alloc(end - offset);
        let position = 0;
        for (const chunk of this.decodedJsonChunks(encoded)) {
            const start = Math.max(offset, position);
            const stop = Math.min(end, position + chunk.length);
            if (start < stop) chunk.copy(page, start - offset, start - position, stop - position);
            position += chunk.length;
        }
        return { mime: 'application/json', offset, totalBytes: encoded.sourceBytes, sha256: encoded.sourceHash,
            dataBase64: page.toString('base64'), nextOffset: end < encoded.sourceBytes ? end : null, complete: end === encoded.sourceBytes };
    }

    private validateEnvelope(encoded: EncodedMediaPayload): void {
        if (!objectValue(encoded) || encoded.codec !== MEDIA_PAYLOAD_CODEC || encoded.version !== 1 || !/^[a-f0-9]{64}$/.test(encoded.sourceHash)
            || !Number.isSafeInteger(encoded.sourceBytes) || encoded.sourceBytes < 0 || encoded.sourceBytes > this.limits.maxSourceBytes
            || !Array.isArray(encoded.payloads) || encoded.payloads.length < 1 || encoded.payloads.length > this.limits.maxPayloads
            || !Array.isArray(encoded.strings) || encoded.strings.length < 1 || encoded.strings.length > this.limits.maxStrings) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体对象编码头无效或超过声明上限');
        }
        let totalPayloadBytes = 0;
        const payloadHashes = new Set<string>();
        for (const reference of encoded.payloads) {
            if (!objectValue(reference) || !/^[a-f0-9]{64}$/.test(reference.sha256)
                || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || reference.byteLength > this.limits.maxPayloadBytes
                || payloadHashes.has(reference.sha256)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体原字节引用无效或重复');
            payloadHashes.add(reference.sha256);
            totalPayloadBytes += reference.byteLength;
            if (totalPayloadBytes > this.limits.maxTotalPayloadBytes) {
                throw new AgentFault('MEDIA_CONTENT_LIMIT', '媒体唯一原件累计字节超过上限',
                    { bytes: totalPayloadBytes, maxBytes: this.limits.maxTotalPayloadBytes, scope: 'unique_payloads' });
            }
        }
        const metadataLimits = { ...this.limits, maxDepth: this.limits.maxDepth + 8,
            maxNodes: this.limits.maxNodes + this.limits.maxStrings * (this.limits.maxDepth + 16)
                + this.limits.maxAdjustments * 4 + this.limits.maxPayloads * 8 };
        digestParts(canonicalParts(encoded, metadataLimits), this.limits.maxMetadataBytes);
    }

    private recipeMap(encoded: EncodedMediaPayload): Map<string, MediaStringRecipe> {
        this.validateEnvelope(encoded);
        const result = new Map<string, MediaStringRecipe>();
        let totalParts = 0;
        let adjustments = 0;
        const usedPayloads = new Set<number>();
        for (const recipe of encoded.strings) {
            if (!objectValue(recipe) || !Array.isArray(recipe.path) || recipe.path.length > this.limits.maxDepth || recipe.path.some(part => typeof part !== 'string'
                && (!Number.isSafeInteger(part) || part < 0)) || !/^[a-f0-9]{64}$/.test(recipe.sourceHash)
                || !Number.isSafeInteger(recipe.sourceBytes) || recipe.sourceBytes < 0 || recipe.sourceBytes > encoded.sourceBytes
                || !Array.isArray(recipe.parts)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体字符串恢复清单无效');
            totalParts += recipe.parts.length;
            if (totalParts > this.limits.maxStrings * 4) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体字符串恢复分片过多');
            for (const part of recipe.parts) {
                if (!objectValue(part)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复片段格式无效');
                if ('literal' in part) { if (typeof part.literal !== 'string') throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复字面片段无效'); continue; }
                if (!Number.isSafeInteger(part.payload) || part.payload < 0 || part.payload >= encoded.payloads.length
                    || typeof part.prefix !== 'string' || typeof part.padded !== 'boolean' || !['standard', 'url'].includes(part.alphabet)
                    || !Array.isArray(part.whitespace) || (part.jsonEscapes !== undefined && !Array.isArray(part.jsonEscapes))) {
                    throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复字节引用无效');
                }
                adjustments += part.whitespace.length + (part.jsonEscapes?.length ?? 0);
                usedPayloads.add(part.payload);
                if (adjustments > this.limits.maxAdjustments) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体恢复排版数量超过上限');
            }
            const key = JSON.stringify(recipe.path);
            if (result.has(key)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复清单存在重复路径');
            result.set(key, recipe);
        }
        if (usedPayloads.size !== encoded.payloads.length) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体恢复清单包含未使用的原件引用');
        return result;
    }

    private *base64Parts(encoded: EncodedMediaPayload, spelling: PayloadSpelling): Iterable<string> {
        let carry = Buffer.alloc(0);
        yield spelling.prefix;
        for (const bytes of this.binary.chunks(encoded.payloads[spelling.payload], 48 * 1024)) {
            const chunk = carry.length ? Buffer.concat([carry, bytes]) : Buffer.from(bytes);
            const length = chunk.length - chunk.length % 3;
            if (length) yield spelling.alphabet === 'url' ? chunk.subarray(0, length).toString('base64').replace(/\+/g, '-').replace(/\//g, '_') : chunk.subarray(0, length).toString('base64');
            carry = Buffer.from(chunk.subarray(length));
        }
        if (carry.length) {
            let tail = carry.toString('base64');
            if (!spelling.padded) tail = tail.replace(/=+$/, '');
            if (spelling.alphabet === 'url') tail = tail.replace(/\+/g, '-').replace(/\//g, '_');
            yield tail;
        }
    }

    private *spelledParts(encoded: EncodedMediaPayload, spelling: PayloadSpelling): Iterable<string> {
        let offset = -spelling.prefix.length;
        let index = 0;
        let previous = -1;
        for (const part of this.base64Parts(encoded, spelling)) {
            let start = 0;
            while (index < spelling.whitespace.length && spelling.whitespace[index].offset <= offset + part.length) {
                const adjustment = spelling.whitespace[index];
                if (!Number.isSafeInteger(adjustment.offset) || adjustment.offset < 0 || adjustment.offset < previous
                    || typeof adjustment.text !== 'string' || !/^[\t\n\r ]+$/.test(adjustment.text)) {
                    throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体Base64排版恢复信息无效');
                }
                const stop = adjustment.offset - offset;
                if (stop < start) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体Base64排版位置无效');
                yield part.slice(start, stop); yield adjustment.text;
                previous = adjustment.offset; start = stop; index += 1;
            }
            yield part.slice(start);
            offset += part.length;
        }
        if (index !== spelling.whitespace.length) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体Base64排版超出原件范围');
    }

    private *lexicalParts(encoded: EncodedMediaPayload, spelling: PayloadSpelling): Iterable<string> {
        if (spelling.jsonEscapes === undefined) { yield* this.spelledParts(encoded, spelling); return; }
        yield '"';
        let offset = 0;
        let index = 0;
        let previous = -1;
        for (const part of this.spelledParts(encoded, spelling)) {
            let start = 0;
            while (index < spelling.jsonEscapes.length && spelling.jsonEscapes[index].offset < offset + part.length) {
                const escape: LexicalEscape = spelling.jsonEscapes[index];
                if (!Number.isSafeInteger(escape.offset) || escape.offset <= previous || escape.offset < offset + start
                    || typeof escape.raw !== 'string' || !/^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})$/.test(escape.raw)) {
                    throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体JSON转义恢复信息无效');
                }
                const stop = escape.offset - offset;
                if (JSON.parse(`"${escape.raw}"`) !== part[stop]) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体JSON转义与原字节不一致');
                yield part.slice(start, stop); yield escape.raw;
                start = stop + 1; previous = escape.offset; index += 1;
            }
            yield part.slice(start); offset += part.length;
        }
        if (index !== spelling.jsonEscapes.length) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体JSON转义超出原件范围');
        yield '"';
    }

    private *stringParts(encoded: EncodedMediaPayload, recipe: MediaStringRecipe): Iterable<string> {
        const checksum = createHash('sha256');
        let bytes = 0;
        for (const part of recipe.parts) {
            const pieces = 'literal' in part ? [part.literal] : this.lexicalParts(encoded, part);
            for (const text of pieces) {
                bytes += Buffer.byteLength(text);
                if (bytes > recipe.sourceBytes) throw new AgentFault('MEDIA_CODEC_LIMIT', '媒体字符串恢复超过声明长度');
                checksum.update(text); yield text;
            }
        }
        if (bytes !== recipe.sourceBytes || checksum.digest('hex') !== recipe.sourceHash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体字符串原始字节校验失败');
    }

    private checkSource(encoded: EncodedMediaPayload, actual: { bytes: number; hash: string }): void {
        if (actual.bytes !== encoded.sourceBytes || actual.hash !== encoded.sourceHash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体对象还原后的原始JSON校验失败');
    }
}
