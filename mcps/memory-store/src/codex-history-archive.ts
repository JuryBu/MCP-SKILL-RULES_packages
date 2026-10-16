import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { Decompress } from "fzstd";
import { CodexHistorySourceMismatchError, throwIfCodexReadCancelled } from "./codex-history-integrity.js";

const CHUNK_BYTES = 64 * 1024;
const FORMAT = "memory-store-codex-history-view-v1";
const POINTER_FORMAT = "memory-store-codex-history-view-pointer-v1";
const MASK64 = (1n << 64n) - 1n;
const PRIMES = [11400714785074694791n, 14029467366897019727n, 1609587929392839161n, 9650029242287828579n, 2870177450012600261n];
const rotate64 = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & MASK64;
const round64 = (accumulator: bigint, value: bigint): bigint => rotate64((accumulator + value * PRIMES[1]!) & MASK64, 31n) * PRIMES[0]! & MASK64;

class Checksum64 {
    private lanes = [(PRIMES[0]! + PRIMES[1]!) & MASK64, PRIMES[1]!, 0n, (-PRIMES[0]!) & MASK64];
    private tail = Buffer.alloc(0);
    private length = 0;

    update(value: Buffer): void {
        this.length += value.length;
        const input = this.tail.length ? Buffer.concat([this.tail, value]) : value;
        let position = 0;
        for (; position + 32 <= input.length; position += 32) {
            for (let lane = 0; lane < 4; lane += 1) this.lanes[lane] = round64(this.lanes[lane]!, input.readBigUInt64LE(position + lane * 8));
        }
        this.tail = Buffer.from(input.subarray(position));
    }

    digest(): number {
        let result = this.length >= 32
            ? this.lanes.reduce((sum, lane, index) => sum + rotate64(lane, [1n, 7n, 12n, 18n][index]!), 0n) & MASK64
            : PRIMES[4]!;
        if (this.length >= 32) for (const lane of this.lanes) result = ((result ^ round64(0n, lane)) * PRIMES[0]! + PRIMES[3]!) & MASK64;
        result = (result + BigInt(this.length)) & MASK64;
        let position = 0;
        for (; position + 8 <= this.tail.length; position += 8) result = (rotate64(result ^ round64(0n, this.tail.readBigUInt64LE(position)), 27n) * PRIMES[0]! + PRIMES[3]!) & MASK64;
        if (position + 4 <= this.tail.length) {
            result = (rotate64(result ^ (BigInt(this.tail.readUInt32LE(position)) * PRIMES[0]! & MASK64), 23n) * PRIMES[1]! + PRIMES[2]!) & MASK64;
            position += 4;
        }
        for (; position < this.tail.length; position += 1) result = rotate64(result ^ (BigInt(this.tail[position]!) * PRIMES[4]! & MASK64), 11n) * PRIMES[0]! & MASK64;
        result ^= result >> 33n;
        result = result * PRIMES[1]! & MASK64;
        result ^= result >> 29n;
        result = result * PRIMES[2]! & MASK64;
        return Number((result ^ (result >> 32n)) & 0xffffffffn);
    }
}

export interface CodexHistoryArchiveOptions {
    cacheRoot?: string;
    ownerId?: string;
    maxCompressedBytes?: number;
    maxDecompressedBytes?: number;
    maxWindowBytes?: number;
    minFreeBytes?: number;
    isCancelled?: () => boolean;
    decoder?: "auto" | "fzstd";
}

export interface CodexHistoryArchiveView {
    format: typeof FORMAT;
    ownerId: string;
    sourcePath: string;
    sourceSize: number;
    sourceMtimeMs: number;
    sourceSha256: string;
    viewPath: string;
    logicalSize: number;
    logicalSha256: string;
    rebuildable: true;
    cleanupCondition: string;
}

interface Limits {
    compressed: number;
    logical: number;
    window: number;
    reserve: number;
}

interface Frame {
    start: number;
    end: number;
    contentSize?: number;
    checksum?: number;
    skippable?: boolean;
}

function fail(message: string): never {
    throw new CodexHistorySourceMismatchError(`Codex history archive ${message}`);
}

function limitsFor(options: CodexHistoryArchiveOptions): Limits {
    const values = { compressed: options.maxCompressedBytes ?? 256 * 1024 * 1024, logical: options.maxDecompressedBytes ?? 512 * 1024 * 1024, window: options.maxWindowBytes ?? 128 * 1024 * 1024, reserve: options.minFreeBytes ?? 64 * 1024 * 1024 };
    for (const [name, value] of Object.entries(values)) if (!Number.isSafeInteger(value) || value < (name === "reserve" ? 0 : 1)) fail(`has invalid ${name} limit`);
    if (!Number.isSafeInteger(values.logical + values.reserve)) fail("has an unsafe disk-space reservation");
    return values;
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function sameStat(before: fs.Stats, after: fs.Stats): boolean {
    return before.isFile() && after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev;
}

function regularFile(filePath: string): fs.Stats {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) fail("requires a regular, non-linked file");
    return stats;
}

function fileHash(filePath: string, isCancelled?: () => boolean): string {
    const descriptor = fs.openSync(filePath, "r");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    try {
        for (;;) {
            throwIfCodexReadCancelled(isCancelled);
            const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
        }
        return hash.digest("hex");
    } finally { fs.closeSync(descriptor); }
}

async function fileHashAsync(filePath: string, isCancelled?: () => boolean): Promise<string> {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: CHUNK_BYTES })) {
        throwIfCodexReadCancelled(isCancelled);
        hash.update(chunk as Buffer);
    }
    throwIfCodexReadCancelled(isCancelled);
    return hash.digest("hex");
}

function readBytes(descriptor: number, position: number, count: number, size: number): Buffer {
    if (position + count > size) fail("has an incomplete zstd frame");
    const value = Buffer.alloc(count);
    if (fs.readSync(descriptor, value, 0, count, position) !== count) fail("changed during frame inspection");
    return value;
}

function* frames(descriptor: number, size: number, limits: Limits, isCancelled?: () => boolean): Generator<Frame> {
    let position = 0;
    let frameCount = 0;
    while (position < size) {
        throwIfCodexReadCancelled(isCancelled);
        if (++frameCount > 100000) fail("exceeds the frame count limit");
        const start = position;
        const magic = readBytes(descriptor, position, 4, size).readUInt32LE();
        position += 4;
        if ((magic & 0xfffffff0) === 0x184d2a50) {
            const skipped = readBytes(descriptor, position, 4, size).readUInt32LE();
            position += 4 + skipped;
            if (position > size) fail("has an incomplete skippable frame");
            yield { start, end: position, skippable: true };
            continue;
        }
        if (magic !== 0xfd2fb528) fail("has invalid zstd magic or trailing data");
        const flags = readBytes(descriptor, position++, 1, size)[0]!;
        if (flags & 0x18) fail("has unsupported reserved zstd flags");
        const single = Boolean(flags & 0x20);
        let window = 0;
        if (!single) {
            const descriptorByte = readBytes(descriptor, position++, 1, size)[0]!;
            const windowBase = 2 ** (10 + (descriptorByte >> 3));
            window = windowBase + windowBase / 8 * (descriptorByte & 7);
        }
        const dictionaryBytes = [0, 1, 2, 4][flags & 3]!;
        if (dictionaryBytes && readBytes(descriptor, position, dictionaryBytes, size).some(value => value !== 0)) fail("requires an unsupported zstd dictionary");
        position += dictionaryBytes;
        const contentBytes = (flags >> 6) === 0 ? (single ? 1 : 0) : 2 ** (flags >> 6);
        let contentSize: number | undefined;
        if (contentBytes) {
            const value = readBytes(descriptor, position, contentBytes, size);
            const declared = contentBytes === 8 ? value.readBigUInt64LE() : BigInt(value.readUIntLE(0, contentBytes));
            if (declared > BigInt(limits.logical)) fail("exceeds the decompressed size limit");
            contentSize = Number(declared) + (contentBytes === 2 ? 256 : 0);
            position += contentBytes;
        }
        if (single) window = contentSize!;
        if (window > limits.window) fail("exceeds the zstd window limit");
        if (contentSize !== undefined && contentSize > limits.logical) fail("exceeds the decompressed size limit");
        for (;;) {
            throwIfCodexReadCancelled(isCancelled);
            const block = readBytes(descriptor, position, 3, size).readUIntLE(0, 3);
            position += 3;
            const type = (block >> 1) & 3;
            const blockSize = block >> 3;
            if (type === 3 || blockSize > Math.min(window, 128 * 1024)) fail("has an invalid zstd block");
            position += type === 1 ? 1 : blockSize;
            if (position > size) fail("has an incomplete zstd block");
            if (block & 1) break;
        }
        const checksum = flags & 4 ? readBytes(descriptor, position, 4, size).readUInt32LE() : undefined;
        if (checksum !== undefined) position += 4;
        yield { start, end: position, contentSize, checksum };
    }
    if (frameCount === 0) fail("is empty");
}

function freeSpace(directory: string, required: number): void {
    const statfs = (fs as { statfsSync?: typeof fs.statfsSync }).statfsSync;
    let available: bigint;
    if (statfs) {
        const stats = statfs(directory, { bigint: true });
        available = stats.bavail * stats.bsize;
    } else {
        try {
            if (process.platform === "win32") {
                if (!process.env.SystemRoot) fail("cannot locate the read-only disk-space helper");
                const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
                const result = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:MEMORY_STORE_CODEX_ARCHIVE_DISK_PATH))).AvailableFreeSpace"], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096, env: { ...process.env, MEMORY_STORE_CODEX_ARCHIVE_DISK_PATH: directory } }).trim();
                if (!/^\d+$/.test(result)) fail("received an invalid disk-space sample");
                available = BigInt(result);
            } else {
                const result = execFileSync("df", ["-Pk", directory], { encoding: "utf8", timeout: 10000, maxBuffer: 16384, env: { ...process.env, LC_ALL: "C" } });
                const columns = result.trim().split(/\r?\n/).at(-1)!.trim().split(/\s+/);
                if (columns.length < 6 || !/^\d+$/.test(columns[3]!)) fail("received an invalid disk-space sample");
                available = BigInt(columns[3]!) * 1024n;
            }
        } catch { fail("cannot verify free disk space on this runtime"); }
    }
    if (available < BigInt(required)) fail("has insufficient free disk space");
}

function ownerRoot(options: CodexHistoryArchiveOptions): { root: string; ownerId: string } {
    const ownerId = options.ownerId ?? "memory-store-codex-history";
    if (!ownerId.trim() || Buffer.byteLength(ownerId) > 1024) fail("requires a bounded ownerId");
    const dataRoot = process.env.MEMORY_STORE_DATA_ROOT;
    const cacheRoot = path.resolve(options.cacheRoot ?? (dataRoot ? path.join(dataRoot, "codex-history-views") : path.join(os.tmpdir(), "memory-store-codex-history-views-v1")));
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(cacheRoot).isSymbolicLink()) fail("cache root must not be a link");
    const root = path.join(fs.realpathSync(cacheRoot), digest(ownerId));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) fail("owner directory must not be a link");
    const marker = path.join(root, "owner.json");
    const expected = JSON.stringify({ format: FORMAT, ownerId });
    try { fs.writeFileSync(marker, expected, { flag: "wx", mode: 0o600 }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    regularFile(marker);
    if (fs.readFileSync(marker, "utf8") !== expected) fail("cache ownership mismatch");
    return { root, ownerId };
}

function cachedView(directory: string, sourcePath: string, source: fs.Stats, sourceSha256: string, ownerId: string, limits: Limits): CodexHistoryArchiveView | undefined {
    try {
        if (fs.lstatSync(directory).isSymbolicLink()) fail("view directory must not be a link");
        const manifestPath = path.join(directory, "manifest.json");
        if (regularFile(manifestPath).size > 16384) fail("view manifest exceeds its limit");
        const view = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as CodexHistoryArchiveView;
        const viewPath = path.join(directory, "content.jsonl");
        if (view.format !== FORMAT || view.sourcePath !== sourcePath || view.sourceSha256 !== sourceSha256 || view.sourceSize !== source.size || view.ownerId !== ownerId || view.viewPath !== viewPath || !Number.isSafeInteger(view.logicalSize) || view.logicalSize < 0 || view.logicalSize > limits.logical || !/^[a-f0-9]{64}$/.test(view.logicalSha256)) fail("view manifest mismatch");
        if (regularFile(viewPath).size !== view.logicalSize) fail("view size changed");
        return { ...view, sourceMtimeMs: source.mtimeMs };
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function prepare(sourcePath: string, options: CodexHistoryArchiveOptions, sourceSha256: string, source: fs.Stats, limits: Limits) {
    if (!sameStat(source, regularFile(sourcePath))) fail("changed before decompression");
    const { root, ownerId } = ownerRoot(options);
    const key = digest(`${sourcePath}\0${sourceSha256}`);
    const pointerPath = path.join(root, `${key}.pointer.json`);
    let cachedDirectory = path.join(root, key);
    let cached: CodexHistoryArchiveView | undefined;
    try {
        if (fs.existsSync(pointerPath)) {
            if (regularFile(pointerPath).size > 4096) fail("view pointer exceeds its limit");
            const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as { format?: string; directory?: string };
            if (pointer.format !== POINTER_FORMAT || typeof pointer.directory !== "string"
                || !new RegExp(`^${key}\\.[a-f0-9-]{36}$`).test(pointer.directory)) fail("view pointer mismatch");
            cachedDirectory = path.join(root, pointer.directory);
        }
        cached = cachedView(cachedDirectory, sourcePath, source, sourceSha256, ownerId, limits);
    }
    catch (error: unknown) {
        if (!(error instanceof CodexHistorySourceMismatchError) && !(error instanceof SyntaxError)) throw error;
    }
    const directory = path.join(root, `${key}.${crypto.randomUUID()}`);
    return { root, ownerId, directory, pointerPath, cached };
}

function startOutput(root: string, limits: Limits) {
    freeSpace(root, limits.logical + limits.reserve);
    const staging = fs.mkdtempSync(path.join(root, ".partial-"));
    let descriptor: number;
    try { descriptor = fs.openSync(path.join(staging, "content.jsonl"), "wx", 0o600); }
    catch (error: unknown) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
    const hash = crypto.createHash("sha256");
    let size = 0;
    let nextSpaceCheck = 8 * 1024 * 1024;
    const write = (value: Buffer, isCancelled?: () => boolean) => {
        throwIfCodexReadCancelled(isCancelled);
        if (size + value.length > limits.logical) fail("exceeds the decompressed size limit");
        if (size + value.length >= nextSpaceCheck) {
            freeSpace(root, limits.reserve + value.length);
            nextSpaceCheck = size + value.length + 8 * 1024 * 1024;
        }
        for (let position = 0; position < value.length;) {
            const written = fs.writeSync(descriptor, value, position, value.length - position);
            if (!written) fail("could not write the complete view");
            position += written;
        }
        hash.update(value);
        size += value.length;
    };
    return { staging, descriptor, write, finish: () => ({ logicalSize: size, logicalSha256: hash.digest("hex") }) };
}

function publish(prepared: ReturnType<typeof prepare>, output: ReturnType<typeof startOutput>, sourcePath: string, source: fs.Stats, sourceSha256: string): CodexHistoryArchiveView {
    const view: CodexHistoryArchiveView = { format: FORMAT, ownerId: prepared.ownerId, sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs, sourceSha256, viewPath: path.join(prepared.directory, "content.jsonl"), ...output.finish(), rebuildable: true, cleanupCondition: "Rebuild from source; remove only after all active readers and persisted history manifests release this view." };
    fs.writeFileSync(path.join(output.staging, "manifest.json"), JSON.stringify(view), { flag: "wx", mode: 0o600 });
    fs.renameSync(output.staging, prepared.directory);
    const temporaryPointer = `${prepared.pointerPath}.partial-${crypto.randomUUID()}`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporaryPointer, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ format: POINTER_FORMAT, directory: path.basename(prepared.directory) }));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPointer, prepared.pointerPath);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        fs.rmSync(temporaryPointer, { force: true });
    }
    return view;
}

function checkedSource(sourcePath: string, limits: Limits): fs.Stats {
    if (!/\.jsonl\.zst$/i.test(sourcePath)) fail("requires a .jsonl.zst source");
    const source = regularFile(sourcePath);
    if (source.size > limits.compressed) fail("exceeds the compressed size limit");
    return source;
}

export function materializeCodexHistoryArchiveSync(filePath: string, options: CodexHistoryArchiveOptions = {}): CodexHistoryArchiveView {
    throwIfCodexReadCancelled(options.isCancelled);
    const sourcePath = path.resolve(filePath);
    const limits = limitsFor(options);
    const source = checkedSource(sourcePath, limits);
    const sourceSha256 = fileHash(sourcePath, options.isCancelled);
    const prepared = prepare(sourcePath, options, sourceSha256, source, limits);
    if (prepared.cached) {
        if (fileHash(prepared.cached.viewPath, options.isCancelled) !== prepared.cached.logicalSha256) {
            prepared.cached = undefined;
        }
        if (!sameStat(source, regularFile(sourcePath))) fail("changed while validating the cached view");
        if (prepared.cached) return prepared.cached;
    }
    const input = fs.openSync(sourcePath, "r");
    let output: ReturnType<typeof startOutput> | undefined;
    let outputClosed = false;
    try {
        output = startOutput(prepared.root, limits);
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        for (const frame of frames(input, source.size, limits, options.isCancelled)) {
            if (frame.skippable) continue;
            const checksum = frame.checksum === undefined ? undefined : new Checksum64();
            let frameSize = 0;
            const decoder = new Decompress(chunk => {
                const value = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                output!.write(value, options.isCancelled);
                checksum?.update(value);
                frameSize += value.length;
            });
            for (let position = frame.start; position < frame.end;) {
                throwIfCodexReadCancelled(options.isCancelled);
                const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, frame.end - position), position);
                if (!count) fail("shortened during decompression");
                position += count;
                decoder.push(Buffer.from(buffer.subarray(0, count)), position === frame.end);
            }
            if (frame.contentSize !== undefined && frameSize !== frame.contentSize) fail("declared content size disagrees with decoded bytes");
            if (checksum && checksum.digest() !== frame.checksum) fail("zstd content checksum mismatch");
        }
        if (!sameStat(source, regularFile(sourcePath)) || fileHash(sourcePath, options.isCancelled) !== sourceSha256) fail("changed during decompression");
        throwIfCodexReadCancelled(options.isCancelled);
        fs.fsyncSync(output.descriptor);
        fs.closeSync(output.descriptor);
        outputClosed = true;
        return publish(prepared, output, sourcePath, source, sourceSha256);
    } finally {
        fs.closeSync(input);
        if (output) {
            if (!outputClosed) fs.closeSync(output.descriptor);
            fs.rmSync(output.staging, { recursive: true, force: true });
        }
    }
}

export async function materializeCodexHistoryArchive(filePath: string, options: CodexHistoryArchiveOptions = {}): Promise<CodexHistoryArchiveView> {
    throwIfCodexReadCancelled(options.isCancelled);
    const sourcePath = path.resolve(filePath);
    const limits = limitsFor(options);
    const source = checkedSource(sourcePath, limits);
    const sourceSha256 = await fileHashAsync(sourcePath, options.isCancelled);
    const prepared = prepare(sourcePath, options, sourceSha256, source, limits);
    if (prepared.cached) {
        if (await fileHashAsync(prepared.cached.viewPath, options.isCancelled) !== prepared.cached.logicalSha256) {
            prepared.cached = undefined;
        }
        if (!sameStat(source, regularFile(sourcePath))) fail("changed while validating the cached view");
        if (prepared.cached) return prepared.cached;
    }
    const input = fs.openSync(sourcePath, "r");
    let output: ReturnType<typeof startOutput> | undefined;
    let outputClosed = false;
    try {
        output = startOutput(prepared.root, limits);
        const native = options.decoder !== "fzstd" && typeof zlib.createZstdDecompress === "function";
        for (const frame of frames(input, source.size, limits, options.isCancelled)) {
            if (frame.skippable) continue;
            let frameSize = 0;
            if (native) {
                const raw = fs.createReadStream(sourcePath, { start: frame.start, end: frame.end - 1, highWaterMark: CHUNK_BYTES });
                const decoder = zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES });
                raw.on("error", error => decoder.destroy(error));
                raw.pipe(decoder);
                try {
                    for await (const chunk of decoder) {
                        const value = chunk as Buffer;
                        output.write(value, options.isCancelled);
                        frameSize += value.length;
                    }
                } finally { raw.destroy(); decoder.destroy(); }
            } else {
                const checksum = frame.checksum === undefined ? undefined : new Checksum64();
                const decoder = new Decompress(chunk => {
                    const value = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                    output!.write(value, options.isCancelled);
                    checksum?.update(value);
                    frameSize += value.length;
                });
                const buffer = Buffer.allocUnsafe(512);
                for (let position = frame.start; position < frame.end;) {
                    throwIfCodexReadCancelled(options.isCancelled);
                    const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, frame.end - position), position);
                    if (!count) fail("shortened during decompression");
                    position += count;
                    decoder.push(Buffer.from(buffer.subarray(0, count)), position === frame.end);
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                if (checksum && checksum.digest() !== frame.checksum) fail("zstd content checksum mismatch");
            }
            if (frame.contentSize !== undefined && frameSize !== frame.contentSize) fail("declared content size disagrees with decoded bytes");
        }
        if (!sameStat(source, regularFile(sourcePath)) || await fileHashAsync(sourcePath, options.isCancelled) !== sourceSha256) fail("changed during decompression");
        throwIfCodexReadCancelled(options.isCancelled);
        fs.fsyncSync(output.descriptor);
        fs.closeSync(output.descriptor);
        outputClosed = true;
        return publish(prepared, output, sourcePath, source, sourceSha256);
    } finally {
        fs.closeSync(input);
        if (output) {
            if (!outputClosed) fs.closeSync(output.descriptor);
            fs.rmSync(output.staging, { recursive: true, force: true });
        }
    }
}
