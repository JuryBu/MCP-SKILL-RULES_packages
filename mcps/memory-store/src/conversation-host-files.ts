import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

export interface HostFileRevision {
    path: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    dev: number;
    ino: number;
    sha256: string;
    prefixSha256?: string;
}

export function assertHostFileActive(isCancelled?: () => boolean): void {
    if (!isCancelled?.()) return;
    const error = new Error("Host source read cancelled");
    error.name = "AbortError";
    throw error;
}

export async function captureHostFile(filePath: string, options: { prefixSize?: number; verifyUtf8?: boolean; isCancelled?: () => boolean; onProgress?: (bytes: number, total: number) => void } = {}): Promise<HostFileRevision> {
    assertHostFileActive(options.isCancelled);
    const resolved = await fs.realpath(filePath);
    const handle = await fs.open(resolved, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("Host source is not a regular file");
        const hash = createHash("sha256");
        const decoder = options.verifyUtf8 ? new TextDecoder("utf-8", { fatal: true }) : undefined;
        const prefix = options.prefixSize === undefined ? undefined : createHash("sha256");
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        while (position < before.size) {
            assertHostFileActive(options.isCancelled);
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
            if (!bytesRead) throw new Error("Host source was truncated during verification");
            hash.update(buffer.subarray(0, bytesRead));
            decoder?.decode(buffer.subarray(0, bytesRead), { stream: true });
            if (prefix && position < options.prefixSize!) prefix.update(buffer.subarray(0, Math.min(bytesRead, options.prefixSize! - position)));
            position += bytesRead;
            options.onProgress?.(position, before.size);
        }
        decoder?.decode();
        const after = await handle.stat();
        const current = await fs.stat(resolved);
        if (![after, current].every(value => value.dev === before.dev && value.ino === before.ino && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs)) throw new Error("Host source changed during verification");
        assertHostFileActive(options.isCancelled);
        return { path: resolved, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, dev: before.dev, ino: before.ino, sha256: hash.digest("hex"), prefixSha256: prefix?.digest("hex") };
    } finally {
        await handle.close();
    }
}

export async function readHostTextWindow(revision: HostFileRevision, direction: "head" | "tail", maxBytes: number, isCancelled?: () => boolean): Promise<{ text: string; startByte: number; endByte: number; readBytes: number; prefixOmitted: boolean; suffixOmitted: boolean; incompleteTrailingRecord: boolean }> {
    assertHostFileActive(isCancelled);
    const start = direction === "tail" ? Math.max(0, revision.size - maxBytes) : 0;
    const end = direction === "head" ? Math.min(revision.size, maxBytes) : revision.size;
    const handle = await fs.open(revision.path, "r");
    try {
        const bytes = Buffer.allocUnsafe(end - start);
        let position = 0;
        while (position < bytes.length) {
            assertHostFileActive(isCancelled);
            const read = await handle.read(bytes, position, Math.min(256 * 1024, bytes.length - position), start + position);
            if (!read.bytesRead) throw new Error("Host source truncated during window read");
            position += read.bytesRead;
        }
        const first = start > 0 ? bytes.indexOf(10) + 1 : 0;
        const last = bytes.lastIndexOf(10) + 1;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(first, Math.max(first, last)));
        await assertHostFileUnchanged(revision, isCancelled);
        return { text, startByte: start + first, endByte: start + last, readBytes: bytes.length, prefixOmitted: start > 0, suffixOmitted: end < revision.size,
            incompleteTrailingRecord: end === revision.size && last < bytes.length };
    } finally { await handle.close(); }
}

export async function assertHostFileUnchanged(revision: HostFileRevision, isCancelled?: () => boolean): Promise<void> {
    assertHostFileActive(isCancelled);
    const current = await fs.stat(revision.path);
    if (current.dev !== revision.dev || current.ino !== revision.ino || current.size !== revision.size || current.mtimeMs !== revision.mtimeMs || current.ctimeMs !== revision.ctimeMs) throw new Error("Host source changed during projection; retry with a fresh source revision");
}

const HOST_JSON_CHUNK_CHARS = 16 * 1024;
const HOST_JSON_BUFFER_BYTES = 64 * 1024;

type HostJsonFrame = { kind: "value"; value: unknown }
    | { kind: "array"; value: unknown[]; index: number; length: number }
    | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number; emitted: boolean };

function prepareHostJsonValue(value: unknown, key: string): unknown {
    if (value !== null && (typeof value === "object" || typeof value === "function" || typeof value === "bigint")) {
        const toJSON = (value as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") value = toJSON.call(value, key);
    }
    if (types.isNumberObject(value)) return +(value as number);
    if (types.isStringObject(value)) return String(value);
    if (types.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
    if (types.isBigIntObject(value)) return BigInt.prototype.valueOf.call(value);
    return value;
}

function hostJsonOmitted(value: unknown): boolean {
    return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function* hostJsonString(value: string, isCancelled?: () => boolean): Generator<string> {
    yield '"';
    for (let position = 0; position < value.length;) {
        assertHostFileActive(isCancelled);
        let end = Math.min(value.length, position + HOST_JSON_CHUNK_CHARS);
        const last = value.charCodeAt(end - 1);
        const next = value.charCodeAt(end);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        yield JSON.stringify(value.slice(position, end)).slice(1, -1);
        position = end;
    }
    yield '"';
}

function* hostJsonChunks(value: unknown, isCancelled?: () => boolean, rootKey = ""): Generator<string> {
    const ancestors = new Set<object>();
    const frames: HostJsonFrame[] = [{ kind: "value", value: prepareHostJsonValue(value, rootKey) }];
    while (frames.length) {
        assertHostFileActive(isCancelled);
        const frame = frames.pop()!;
        if (frame.kind === "array") {
            if (frame.index >= frame.length) { ancestors.delete(frame.value); yield "]"; continue; }
            const index = frame.index++;
            frames.push(frame);
            if (index) yield ",";
            const child = prepareHostJsonValue(frame.value[index], String(index));
            frames.push({ kind: "value", value: hostJsonOmitted(child) ? null : child });
            continue;
        }
        if (frame.kind === "object") {
            let selected: { key: string; value: unknown } | undefined;
            while (frame.index < frame.keys.length) {
                assertHostFileActive(isCancelled);
                const key = frame.keys[frame.index++];
                const child = prepareHostJsonValue(frame.value[key], key);
                if (!hostJsonOmitted(child)) { selected = { key, value: child }; break; }
            }
            if (!selected) { ancestors.delete(frame.value); yield "}"; continue; }
            if (frame.emitted) yield ",";
            frame.emitted = true;
            frames.push(frame);
            yield* hostJsonString(selected.key, isCancelled);
            yield ":";
            frames.push({ kind: "value", value: selected.value });
            continue;
        }
        const item = frame.value;
        if (typeof item === "string") { yield* hostJsonString(item, isCancelled); continue; }
        if (typeof item === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
        if (hostJsonOmitted(item)) throw new TypeError("Host cache payload is not JSON-serializable");
        if (item === null || typeof item !== "object") { yield JSON.stringify(item); continue; }
        const extensions = JSON as typeof JSON & { isRawJSON?: (candidate: unknown) => boolean };
        if (extensions.isRawJSON?.(item)) {
            const raw = (item as { rawJSON: string }).rawJSON;
            for (let position = 0; position < raw.length;) {
                assertHostFileActive(isCancelled);
                let end = Math.min(raw.length, position + HOST_JSON_CHUNK_CHARS);
                const last = raw.charCodeAt(end - 1);
                const next = raw.charCodeAt(end);
                if (end < raw.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
                yield raw.slice(position, end);
                position = end;
            }
            continue;
        }
        if (ancestors.has(item)) throw new TypeError("Converting circular structure to JSON");
        ancestors.add(item);
        if (Array.isArray(item)) {
            const length = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(+item.length) || 0));
            yield "[";
            frames.push({ kind: "array", value: item, index: 0, length });
        } else {
            yield "{";
            frames.push({ kind: "object", value: item as Record<string, unknown>, keys: Object.keys(item), index: 0, emitted: false });
        }
    }
}

async function digestHostJson(value: unknown, maxBytes: number, isCancelled?: () => boolean, onChunk?: (bytes: Buffer) => Promise<void>, rootKey = ""): Promise<{ sha256: string; bytes: number } | null> {
    const hash = createHash("sha256");
    let totalBytes = 0;
    let pendingBytes = 0;
    let pending: string[] = [];
    const flush = async () => {
        if (!pendingBytes) return;
        assertHostFileActive(isCancelled);
        const bytes = Buffer.from(pending.join(""));
        pending = [];
        pendingBytes = 0;
        hash.update(bytes);
        if (onChunk) await onChunk(bytes);
        else await new Promise<void>(resolve => setImmediate(resolve));
        assertHostFileActive(isCancelled);
    };
    for (const text of hostJsonChunks(value, isCancelled, rootKey)) {
        const length = Buffer.byteLength(text);
        if (totalBytes + length > maxBytes) return null;
        totalBytes += length;
        pendingBytes += length;
        pending.push(text);
        if (pendingBytes >= HOST_JSON_BUFFER_BYTES) await flush();
    }
    await flush();
    assertHostFileActive(isCancelled);
    return { sha256: hash.digest("hex"), bytes: totalBytes };
}

async function parseHostCacheEnvelope<T>(filename: string, maxBytes: number): Promise<{ format?: string; sha256?: string; payload?: T } | null> {
    const bytes = await fs.readFile(filename);
    if (bytes.length > maxBytes) return null;
    const text = bytes.toString("utf8");
    if (Buffer.byteLength(text) > maxBytes) return null;
    return JSON.parse(text) as { format?: string; sha256?: string; payload?: T };
}

export async function readHostCache<T>(filename: string, maxBytes: number): Promise<T | null> {
    try {
        const info = await fs.stat(filename);
        if (info.size > maxBytes) return null;
        const envelope = await parseHostCacheEnvelope<T>(filename, maxBytes);
        if (!envelope || typeof envelope !== "object" || envelope.format !== "host-file-cache/v1" || !envelope.sha256 || envelope.payload === undefined) return null;
        const digest = await digestHostJson(envelope.payload, maxBytes);
        if (!digest || digest.sha256 !== envelope.sha256) return null;
        return envelope.payload;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
    }
}

export async function writeHostCache(filename: string, value: unknown, maxBytes: number, isCancelled?: () => boolean): Promise<boolean> {
    assertHostFileActive(isCancelled);
    const prefix = '{"format":"host-file-cache/v1","sha256":"';
    const header = Buffer.from(`${prefix}${"0".repeat(64)}","payload":`);
    if (header.length + 1 > maxBytes) return false;
    const checksum = await digestHostJson(value, maxBytes - header.length - 1, isCancelled);
    if (!checksum) return false;
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
        handle = await fs.open(temporary, "wx");
        const write = async (bytes: Buffer, position: number) => {
            let offset = 0;
            while (offset < bytes.length) {
                assertHostFileActive(isCancelled);
                const result = await handle!.write(bytes, offset, bytes.length - offset, position + offset);
                if (!result.bytesWritten) throw new Error("Host cache write made no progress");
                offset += result.bytesWritten;
            }
        };
        await write(header, 0);
        let position = header.length;
        const digest = await digestHostJson(value, maxBytes - header.length - 1, isCancelled, async bytes => {
            await write(bytes, position);
            position += bytes.length;
        }, "payload");
        if (!digest) return false;
        await write(Buffer.from("}"), position);
        await write(Buffer.from(checksum.sha256), Buffer.byteLength(prefix));
        await handle.close();
        handle = undefined;
        assertHostFileActive(isCancelled);
        await fs.rename(temporary, filename);
        return true;
    } finally {
        try { if (handle) await handle.close(); }
        finally { await fs.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    }
}
