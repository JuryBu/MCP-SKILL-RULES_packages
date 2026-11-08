import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { DATA_ROOT } from "./store.js";
import type { ConversationAttachment } from "./conversation-attachments.js";

export interface ClaudeCodeInlineImageSource {
    version: 1;
    jsonlPath: string;
    byteOffset: number;
    byteLength: number;
    contentIndex: number;
    encodedSha256: string;
    messageUuid?: string;
}

export interface ClaudeCodeInlineImageMaterializeOptions {
    maxBytes: number;
    sourceBudget: { remainingBytes: number };
    deadlineAt?: number;
    shouldAbort?: () => boolean;
}

const MAX_SOURCE_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_RECORD_BYTES = 16 * 1024;
const MAX_CACHE_FILES = 2048;
const IO_CHUNK_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
let cacheWriteQueue: Promise<void> = Promise.resolve();

class InlineImageUnavailable extends Error {}

function boundedLimit(name: string, fallback: number, ceiling = Number.MAX_SAFE_INTEGER): number {
    const configured = process.env[name];
    const value = configured === undefined ? fallback : Number(configured);
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : fallback;
}

function assertActive(options: ClaudeCodeInlineImageMaterializeOptions): void {
    if (options.shouldAbort?.()) {
        const error = new Error("Claude Code attachment materialization cancelled");
        error.name = "AbortError";
        throw error;
    }
    if (Number.isFinite(options.deadlineAt) && Date.now() >= Number(options.deadlineAt)) {
        throw new InlineImageUnavailable("达到附件物化时间预算，原图尚未还原");
    }
}

async function yieldActive(options: ClaudeCodeInlineImageMaterializeOptions): Promise<void> {
    assertActive(options);
    await new Promise<void>(resolve => setImmediate(resolve));
    assertActive(options);
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateSource(source: ClaudeCodeInlineImageSource): string {
    const root = path.resolve(process.env.MEMORY_STORE_CLAUDE_HOME || path.join(os.homedir(), ".claude"), "projects");
    if (source.version !== 1 || typeof source.jsonlPath !== "string" || source.jsonlPath.length > 4096
        || !path.isAbsolute(source.jsonlPath) || !isWithin(root, path.resolve(source.jsonlPath))
        || !/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|agent-[a-f0-9-]+)\.jsonl$/iu.test(path.basename(source.jsonlPath))
        || !Number.isSafeInteger(source.byteOffset) || source.byteOffset < 0
        || !Number.isSafeInteger(source.byteLength) || source.byteLength <= 0 || source.byteLength > MAX_SOURCE_LINE_BYTES
        || !Number.isSafeInteger(source.byteOffset + source.byteLength)
        || !Number.isSafeInteger(source.contentIndex) || source.contentIndex < 0 || source.contentIndex > 100_000
        || typeof source.encodedSha256 !== "string" || !SHA256_PATTERN.test(source.encodedSha256)
        || (source.messageUuid !== undefined && (typeof source.messageUuid !== "string" || source.messageUuid.length > 200))) {
        throw new InlineImageUnavailable("内联图片的原日志定位无效或超出受支持的 Claude projects 范围");
    }
    return root;
}

async function readExact(
    handle: fs.promises.FileHandle,
    byteLength: number,
    byteOffset: number,
    options: ClaudeCodeInlineImageMaterializeOptions,
): Promise<Buffer> {
    const bytes = Buffer.alloc(byteLength);
    let position = 0;
    while (position < bytes.length) {
        assertActive(options);
        const result = await handle.read(bytes, position, Math.min(IO_CHUNK_BYTES, bytes.length - position), byteOffset + position);
        if (!result.bytesRead) throw new InlineImageUnavailable("原始附件记录已截断，无法还原原图");
        position += result.bytesRead;
    }
    assertActive(options);
    return bytes;
}

async function readBoundedFile(filePath: string, maxBytes: number, options: ClaudeCodeInlineImageMaterializeOptions): Promise<Buffer> {
    assertActive(options);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new InlineImageUnavailable("附件缓存文件无效或超出大小预算");
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== stat.size) throw new InlineImageUnavailable("附件缓存文件在读取前发生变化");
        return await readExact(handle, opened.size, 0, options);
    } finally {
        await handle.close();
    }
}

function rasterExtension(mimeType: string, bytes: Buffer): string {
    if (mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ".png";
    if (["image/jpeg", "image/jpg"].includes(mimeType) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
    if (mimeType === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
    if (mimeType === "image/gif" && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return ".gif";
    if (mimeType === "image/bmp" && bytes.toString("ascii", 0, 2) === "BM") return ".bmp";
    throw new InlineImageUnavailable("原图格式与 MIME 不符，或原图格式尚未支持；未转换或重编码");
}

async function cacheDirectory(options: ClaudeCodeInlineImageMaterializeOptions): Promise<string> {
    assertActive(options);
    await fs.promises.mkdir(DATA_ROOT, { recursive: true });
    const root = await fs.promises.realpath(DATA_ROOT);
    let resolved = root;
    for (const name of ["attachments", "claude-code-inline"]) {
        assertActive(options);
        const candidate = path.join(resolved, name);
        try { await fs.promises.mkdir(candidate); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const stat = await fs.promises.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InlineImageUnavailable("附件缓存目录包含非目录或符号链接");
        resolved = await fs.promises.realpath(candidate);
        if (!isWithin(root, resolved)) throw new InlineImageUnavailable("附件缓存目录越出 DATA_ROOT");
    }
    assertActive(options);
    return resolved;
}

function resolvedAttachment(attachment: ConversationAttachment, originalPath: string, bytes: Buffer, mimeType: string): ConversationAttachment {
    return {
        ...attachment,
        name: attachment.name || path.basename(originalPath),
        originalPath,
        mimeType,
        sizeBytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        exists: true,
        warning: undefined,
    };
}

async function readCached(
    directory: string,
    sourceKey: string,
    source: ClaudeCodeInlineImageSource,
    attachment: ConversationAttachment,
    options: ClaudeCodeInlineImageMaterializeOptions,
): Promise<ConversationAttachment | undefined> {
    let metadata: any;
    try {
        metadata = JSON.parse((await readBoundedFile(path.join(directory, `source-${sourceKey}.json`), MAX_SOURCE_RECORD_BYTES, options)).toString("utf8"));
    } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        assertActive(options);
        return undefined;
    }
    if (metadata?.version !== 1 || metadata.sourceKey !== sourceKey || JSON.stringify(metadata.source) !== JSON.stringify(source)
        || typeof metadata.sha256 !== "string" || !SHA256_PATTERN.test(metadata.sha256)
        || typeof metadata.mimeType !== "string" || !Number.isSafeInteger(metadata.sizeBytes)
        || metadata.sizeBytes !== attachment.sizeBytes || metadata.sizeBytes > options.maxBytes
        || ![".png", ".jpg", ".webp", ".gif", ".bmp"].includes(metadata.extension)) return undefined;
    const originalPath = path.join(directory, `sha256-${metadata.sha256}${metadata.extension}`);
    try {
        const bytes = await readBoundedFile(originalPath, options.maxBytes, options);
        if (bytes.length !== metadata.sizeBytes || crypto.createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
            || rasterExtension(metadata.mimeType, bytes) !== metadata.extension) return undefined;
        return resolvedAttachment(attachment, originalPath, bytes, metadata.mimeType);
    } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        assertActive(options);
        return undefined;
    }
}

async function readOriginal(
    source: ClaudeCodeInlineImageSource,
    root: string,
    attachment: ConversationAttachment,
    options: ClaudeCodeInlineImageMaterializeOptions,
): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
    assertActive(options);
    if (source.byteLength + 2 > options.sourceBudget.remainingBytes) throw new InlineImageUnavailable("超过本次附件原日志读取总字节预算，原图尚未还原");
    options.sourceBudget.remainingBytes -= source.byteLength + 2;
    const rootReal = await fs.promises.realpath(root);
    const sourceReal = await fs.promises.realpath(source.jsonlPath);
    if (!isWithin(rootReal, sourceReal)) throw new InlineImageUnavailable("原日志真实路径越出 Claude projects 范围");
    const handle = await fs.promises.open(sourceReal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let line: Buffer;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || source.byteOffset + source.byteLength > stat.size) throw new InlineImageUnavailable("原始附件记录已不存在或被截断");
        if (source.byteOffset > 0 && (await readExact(handle, 1, source.byteOffset - 1, options))[0] !== 10) {
            throw new InlineImageUnavailable("原始附件记录的行边界发生变化");
        }
        line = await readExact(handle, source.byteLength, source.byteOffset, options);
        if (source.byteOffset + source.byteLength < stat.size) {
            const delimiter = (await readExact(handle, 1, source.byteOffset + source.byteLength, options))[0];
            if (delimiter !== 10 && delimiter !== 13) throw new InlineImageUnavailable("原始附件记录的行长度发生变化");
        }
    } finally {
        await handle.close();
    }
    let event: any;
    try { event = JSON.parse(line.toString("utf8")); }
    catch { throw new InlineImageUnavailable("原始附件记录无法解析，未还原原图"); }
    const item = event.message?.content?.[source.contentIndex];
    if (!Array.isArray(event.message?.content) || (source.messageUuid !== undefined && event.uuid !== source.messageUuid)
        || item?.type !== "image" || item.source?.type !== "base64" || typeof item.source.data !== "string") {
        throw new InlineImageUnavailable("原始图片内容或消息身份发生变化");
    }
    const encoded: string = item.source.data;
    const encodedHash = crypto.createHash("sha256");
    for (let offset = 0; offset < encoded.length; offset += IO_CHUNK_BYTES) {
        encodedHash.update(encoded.slice(offset, offset + IO_CHUNK_BYTES));
        await yieldActive(options);
    }
    if (encodedHash.digest("hex") !== source.encodedSha256) throw new InlineImageUnavailable("原图 base64 哈希与固定来源定位不符");
    const compact = encoded.replace(/[\t\n\f\r ]/gu, "");
    if (!compact.length || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
        throw new InlineImageUnavailable("原始图片 base64 无效，未还原原图");
    }
    const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
    const sizeBytes = compact.length / 4 * 3 - padding;
    if (sizeBytes !== attachment.sizeBytes || sizeBytes > options.maxBytes) throw new InlineImageUnavailable("原始图片大小与来源记录不符或超出单图预算");
    await yieldActive(options);
    const bytes = Buffer.from(compact, "base64");
    if (bytes.length !== sizeBytes || bytes.toString("base64") !== compact) throw new InlineImageUnavailable("原始图片 base64 未通过完整性校验");
    const mimeType = String(item.source.media_type || item.source.mimeType || "image/png").toLowerCase();
    const extension = rasterExtension(mimeType, bytes);
    assertActive(options);
    return { bytes, mimeType, extension };
}

async function acquireCacheLock(lockPath: string, options: ClaudeCodeInlineImageMaterializeOptions): Promise<fs.promises.FileHandle> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        assertActive(options);
        try { return await fs.promises.open(lockPath, "wx", 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        try {
            const previous = await readBoundedFile(lockPath, 1024, options);
            const owner = JSON.parse(previous.toString("utf8"));
            if (owner.format === "claude-code-attachment-lock/v1" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string") {
                let alive = true;
                try { process.kill(owner.pid, 0); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
                if (!alive && (await readBoundedFile(lockPath, 1024, options)).equals(previous)) {
                    await fs.promises.unlink(lockPath);
                    continue;
                }
            }
        } catch (error) {
            if ((error as Error).name === "AbortError") throw error;
            assertActive(options);
        }
        break;
    }
    throw new InlineImageUnavailable("附件缓存正被其它进程写入，或旧写入锁尚未能确认释放；原日志和固定来源定位保持可用");
}

async function publishCache(
    directory: string,
    sourceKey: string,
    source: ClaudeCodeInlineImageSource,
    attachment: ConversationAttachment,
    original: { bytes: Buffer; mimeType: string; extension: string },
    options: ClaudeCodeInlineImageMaterializeOptions,
): Promise<ConversationAttachment> {
    const previous = cacheWriteQueue;
    let release!: () => void;
    cacheWriteQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const lockPath = path.join(directory, ".writer.lock");
    const token = crypto.randomUUID();
    let lock: fs.promises.FileHandle | undefined;
    const temporaryPaths: string[] = [];
    try {
        assertActive(options);
        lock = await acquireCacheLock(lockPath, options);
        await lock.writeFile(JSON.stringify({ format: "claude-code-attachment-lock/v1", token, pid: process.pid, createdAt: new Date().toISOString() }));
        const existing = await readCached(directory, sourceKey, source, attachment, options);
        if (existing) return existing;
        const sha256 = crypto.createHash("sha256").update(original.bytes).digest("hex");
        const blobPath = path.join(directory, `sha256-${sha256}${original.extension}`);
        const metadataPath = path.join(directory, `source-${sourceKey}.json`);
        const metadata = Buffer.from(JSON.stringify({ version: 1, sourceKey, source, sha256, sizeBytes: original.bytes.length,
            mimeType: original.mimeType, extension: original.extension, storedAt: new Date().toISOString() }), "utf8");
        if (metadata.length > MAX_SOURCE_RECORD_BYTES) throw new InlineImageUnavailable("附件来源记录超过大小预算");
        let blobExists = false;
        try {
            const bytes = await readBoundedFile(blobPath, options.maxBytes, options);
            blobExists = bytes.equals(original.bytes);
            if (!blobExists) throw new InlineImageUnavailable("内容寻址附件缓存校验失败，原缓存未覆盖");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const maxCacheBytes = boundedLimit("MEMORY_STORE_CC_ATTACHMENT_CACHE_MAX_BYTES", 256 * 1024 * 1024, 1024 * 1024 * 1024);
        let cachedBytes = 0;
        let cachedFiles = 0;
        const entries = await fs.promises.opendir(directory);
        for await (const entry of entries) {
            assertActive(options);
            if (entry.name === ".writer.lock") continue;
            cachedFiles += 1;
            if (cachedFiles > MAX_CACHE_FILES || !entry.isFile() || entry.isSymbolicLink()) throw new InlineImageUnavailable("附件缓存文件数量超出预算或包含非普通文件");
            cachedBytes += (await fs.promises.lstat(path.join(directory, entry.name))).size;
            if (cachedBytes > maxCacheBytes) throw new InlineImageUnavailable("附件缓存总大小已达到预算，原缓存和来源定位均保留");
        }
        const addedBytes = metadata.length + (blobExists ? 0 : original.bytes.length);
        if (cachedBytes + addedBytes > maxCacheBytes || cachedFiles + (blobExists ? 1 : 2) > MAX_CACHE_FILES) {
            throw new InlineImageUnavailable("附件缓存总大小或文件数量预算不足，原图未写入缓存");
        }
        const writes = [...(blobExists ? [] : [{ destination: blobPath, bytes: original.bytes }]), { destination: metadataPath, bytes: metadata }];
        for (const write of writes) {
            assertActive(options);
            const temporary = path.join(directory, `.pending-${process.pid}-${crypto.randomUUID()}`);
            temporaryPaths.push(temporary);
            await fs.promises.writeFile(temporary, write.bytes, { flag: "wx", mode: 0o600 });
            assertActive(options);
            await fs.promises.rename(temporary, write.destination);
            assertActive(options);
        }
        return resolvedAttachment(attachment, blobPath, original.bytes, original.mimeType);
    } finally {
        for (const temporary of temporaryPaths) await fs.promises.unlink(temporary).catch(() => undefined);
        if (lock) {
            await lock.close().catch(() => undefined);
            try {
                const owner = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
                if (owner.token === token) await fs.promises.unlink(lockPath);
            } catch {}
        }
        release();
    }
}

export async function materializeClaudeCodeInlineImage(
    attachment: ConversationAttachment,
    options: ClaudeCodeInlineImageMaterializeOptions,
): Promise<ConversationAttachment> {
    try {
        assertActive(options);
        const source = attachment.claudeCodeInlineImage;
        if (!source || attachment.source !== "claude-code-data-url" || attachment.kind !== "image") return attachment;
        const root = validateSource(source);
        const maxBytes = Math.min(options.maxBytes, boundedLimit("MEMORY_STORE_CC_ATTACHMENT_MAX_BYTES", 4 * 1024 * 1024));
        if (!Number.isSafeInteger(attachment.sizeBytes) || Number(attachment.sizeBytes) <= 0 || Number(attachment.sizeBytes) > maxBytes) {
            throw new InlineImageUnavailable(`Claude Code 原图超过单图大小预算 ${maxBytes} bytes，未还原`);
        }
        const boundedOptions = { ...options, maxBytes };
        const sourceKey = crypto.createHash("sha256").update(JSON.stringify(source)).digest("hex");
        const directory = await cacheDirectory(boundedOptions);
        const cached = await readCached(directory, sourceKey, source, attachment, boundedOptions);
        if (cached) return cached;
        const original = await readOriginal(source, root, attachment, boundedOptions);
        return await publishCache(directory, sourceKey, source, attachment, original, boundedOptions);
    } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        const warning = error instanceof InlineImageUnavailable ? error.message
            : ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))
                ? "原始附件日志或原图缓存已不存在，无法还原原图"
                : "原始附件读取或内容寻址缓存写入失败，原日志保持不变";
        return { ...attachment, warning };
    }
}
