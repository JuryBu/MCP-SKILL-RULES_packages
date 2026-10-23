import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CodexOrdinalMode = "explicit" | "legacy";

export class CodexHistorySourceMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CodexHistorySourceMismatchError";
    }
}

export interface CodexPrefixIdentity {
    headerSha256: string;
    anchorStartByte: number;
    anchorSha256: string;
    unterminatedLeaf?: boolean;
}

export class CodexPrefixIdentityVerifier {
    private readonly headerHash = crypto.createHash("sha256");
    private readonly anchorHash = crypto.createHash("sha256");
    private headerComplete = false;
    private position = 0;
    private lastByte: number | undefined;

    constructor(private readonly endByte: number, private readonly expected: CodexPrefixIdentity) {
        if (!Number.isSafeInteger(expected.anchorStartByte) || expected.anchorStartByte < 0 || expected.anchorStartByte > endByte) {
            throw new CodexHistorySourceMismatchError("Invalid Codex history anchor boundary");
        }
    }

    update(raw: Buffer): void {
        if (!this.headerComplete) {
            const newline = raw.indexOf(0x0a);
            this.headerHash.update(newline < 0 ? raw : raw.subarray(0, newline));
            this.headerComplete = newline >= 0;
        }
        if (this.position + raw.length > this.expected.anchorStartByte) {
            this.anchorHash.update(raw.subarray(Math.max(0, this.expected.anchorStartByte - this.position)));
        }
        this.position += raw.length;
        this.lastByte = raw.at(-1);
    }

    finish(): void {
        if (this.position !== this.endByte) throw new CodexHistorySourceMismatchError("Codex history prefix length changed");
        if (this.endByte > 0 && this.headerHash.digest("hex") !== this.expected.headerSha256) {
            throw new CodexHistorySourceMismatchError("Codex history source header changed during content verification");
        }
        if (this.anchorHash.digest("hex") !== this.expected.anchorSha256 || (this.endByte > 0 && !this.expected.unterminatedLeaf && this.lastByte !== 0x0a)) {
            throw new CodexHistorySourceMismatchError("Codex history source boundary changed during content verification");
        }
    }
}

export function throwIfCodexReadCancelled(isCancelled?: () => boolean): void {
    if (!isCancelled?.()) return;
    const error = new Error("Codex conversation read cancelled");
    error.name = "AbortError";
    throw error;
}

interface VerifiedCodexPrefixDigest {
    physicalIdentity: string;
    sha256: string;
    headerSha256: string;
    anchorStartByte: number;
    anchorSha256: string;
    lastByte?: number;
    explicitIdentity?: string;
}

const verifiedPrefixDigests = new Map<string, VerifiedCodexPrefixDigest>();
const MAX_VERIFIED_PREFIX_DIGESTS = 256;
const PREFIX_DIGEST_ANCHOR_BYTES = 8192;

function prefixDigestKey(filePath: string, endByte: number): string {
    const resolved = path.resolve(filePath);
    return `${process.platform === "win32" ? resolved.toLowerCase() : resolved}\0${endByte}`;
}

function prefixPhysicalIdentity(stats: fs.BigIntStats): string {
    return [stats.isFile(), stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.birthtimeNs].join(":");
}

function cachedPrefixDigest(key: string, physicalIdentity: string, endByte: number, identity?: CodexPrefixIdentity): VerifiedCodexPrefixDigest | undefined {
    const cached = verifiedPrefixDigests.get(key);
    if (!cached || cached.physicalIdentity !== physicalIdentity) return undefined;
    if (identity) {
        if (!Number.isSafeInteger(identity.anchorStartByte) || identity.anchorStartByte < 0 || identity.anchorStartByte > endByte) throw new CodexHistorySourceMismatchError("Invalid Codex history anchor boundary");
        if (endByte > 0 && cached.headerSha256 !== identity.headerSha256) throw new CodexHistorySourceMismatchError("Codex history source header changed during content verification");
        const anchor = identity.anchorStartByte === cached.anchorStartByte ? cached.anchorSha256 : identity.anchorStartByte === 0 ? cached.sha256 : undefined;
        if (!anchor && cached.explicitIdentity !== JSON.stringify(identity)) return undefined;
        if ((anchor && anchor !== identity.anchorSha256) || (endByte > 0 && !identity.unterminatedLeaf && cached.lastByte !== 0x0a)) throw new CodexHistorySourceMismatchError("Codex history source boundary changed during content verification");
    }
    verifiedPrefixDigests.delete(key);
    verifiedPrefixDigests.set(key, cached);
    return cached;
}

function prefixDigestCollector(endByte: number) {
    const hash = crypto.createHash("sha256");
    const headerHash = crypto.createHash("sha256");
    let headerComplete = false;
    let tail = Buffer.alloc(0);
    let lastByte: number | undefined;
    return {
        update(value: Buffer): void {
            hash.update(value);
            if (!headerComplete) {
                const newline = value.indexOf(0x0a);
                headerHash.update(newline < 0 ? value : value.subarray(0, newline));
                headerComplete = newline >= 0;
            }
            tail = value.length >= PREFIX_DIGEST_ANCHOR_BYTES ? Buffer.from(value.subarray(-PREFIX_DIGEST_ANCHOR_BYTES)) : Buffer.concat([tail, value]).subarray(-PREFIX_DIGEST_ANCHOR_BYTES);
            lastByte = value.at(-1);
        },
        finish(physicalIdentity: string, identity?: CodexPrefixIdentity): VerifiedCodexPrefixDigest {
            return { physicalIdentity, sha256: hash.digest("hex"), headerSha256: headerHash.digest("hex"), anchorStartByte: Math.max(0, endByte - PREFIX_DIGEST_ANCHOR_BYTES), anchorSha256: crypto.createHash("sha256").update(tail).digest("hex"), lastByte, explicitIdentity: identity ? JSON.stringify(identity) : undefined };
        },
    };
}

function rememberPrefixDigest(key: string, digest: VerifiedCodexPrefixDigest): void {
    verifiedPrefixDigests.delete(key);
    verifiedPrefixDigests.set(key, digest);
    while (verifiedPrefixDigests.size > MAX_VERIFIED_PREFIX_DIGESTS) verifiedPrefixDigests.delete(verifiedPrefixDigests.keys().next().value!);
}

export function hashCodexPrefixSync(filePath: string, endByte: number, identity?: CodexPrefixIdentity, isCancelled?: () => boolean): string {
    if (!Number.isSafeInteger(endByte) || endByte < 0) throw new Error("Invalid Codex prefix byte boundary");
    throwIfCodexReadCancelled(isCancelled);
    const physicalIdentity = prefixPhysicalIdentity(fs.statSync(filePath, { bigint: true }));
    const key = prefixDigestKey(filePath, endByte);
    const cached = cachedPrefixDigest(key, physicalIdentity, endByte, identity);
    if (cached && prefixPhysicalIdentity(fs.statSync(filePath, { bigint: true })) === physicalIdentity) {
        throwIfCodexReadCancelled(isCancelled);
        return cached.sha256;
    }
    const verifier = identity ? new CodexPrefixIdentityVerifier(endByte, identity) : undefined;
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const hash = prefixDigestCollector(endByte);
    try {
        for (let position = 0; position < endByte;) {
            throwIfCodexReadCancelled(isCancelled);
            const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, endByte - position), position);
            if (!count) throw new Error("Codex history source shortened during content verification");
            hash.update(buffer.subarray(0, count));
            verifier?.update(buffer.subarray(0, count));
            position += count;
        }
        verifier?.finish();
        const digest = hash.finish(physicalIdentity, identity);
        if (prefixPhysicalIdentity(fs.statSync(filePath, { bigint: true })) === physicalIdentity) rememberPrefixDigest(key, digest);
        throwIfCodexReadCancelled(isCancelled);
        return digest.sha256;
    } finally {
        fs.closeSync(descriptor);
    }
}

export async function hashCodexPrefix(filePath: string, endByte: number, isCancelled?: () => boolean, identity?: CodexPrefixIdentity, readMode: "buffered" | "stream" = "buffered"): Promise<string> {
    if (!Number.isSafeInteger(endByte) || endByte < 0) throw new Error("Invalid Codex prefix byte boundary");
    throwIfCodexReadCancelled(isCancelled);
    const physicalIdentity = prefixPhysicalIdentity(await fs.promises.stat(filePath, { bigint: true }));
    throwIfCodexReadCancelled(isCancelled);
    const key = prefixDigestKey(filePath, endByte);
    const cached = cachedPrefixDigest(key, physicalIdentity, endByte, identity);
    if (cached && prefixPhysicalIdentity(await fs.promises.stat(filePath, { bigint: true })) === physicalIdentity) {
        throwIfCodexReadCancelled(isCancelled);
        return cached.sha256;
    }
    const verifier = identity ? new CodexPrefixIdentityVerifier(endByte, identity) : undefined;
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    const hash = prefixDigestCollector(endByte);
    try {
        if (readMode === "stream" && endByte > 0) {
            let position = 0;
            for await (const chunk of fs.createReadStream(filePath, { start: 0, end: endByte - 1, highWaterMark: 64 * 1024 })) {
                throwIfCodexReadCancelled(isCancelled);
                const value = chunk as Buffer;
                hash.update(value);
                verifier?.update(value);
                position += value.length;
            }
            throwIfCodexReadCancelled(isCancelled);
            if (position !== endByte) throw new Error("Codex history source shortened during content verification");
        } else if (endByte > 0) {
            handle = await fs.promises.open(filePath, "r");
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            for (let position = 0; position < endByte;) {
                throwIfCodexReadCancelled(isCancelled);
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, endByte - position), position);
                throwIfCodexReadCancelled(isCancelled);
                if (!bytesRead) throw new Error("Codex history source shortened during content verification");
                hash.update(buffer.subarray(0, bytesRead));
                verifier?.update(buffer.subarray(0, bytesRead));
                position += bytesRead;
            }
        }
        verifier?.finish();
        const digest = hash.finish(physicalIdentity, identity);
        if (prefixPhysicalIdentity(await fs.promises.stat(filePath, { bigint: true })) === physicalIdentity) rememberPrefixDigest(key, digest);
        throwIfCodexReadCancelled(isCancelled);
        return digest.sha256;
    } finally {
        await handle?.close();
    }
}

export class CodexOrdinalValidator {
    private modeValue: CodexOrdinalMode | undefined;
    private nextValue: number;
    private count = 0;

    constructor(private readonly startOrdinal: number, private readonly expectedMode?: CodexOrdinalMode, private readonly previousMode?: CodexOrdinalMode) {
        if (!Number.isSafeInteger(startOrdinal) || startOrdinal < 0) throw new Error("Invalid Codex history start ordinal");
        this.nextValue = startOrdinal;
    }

    get mode(): CodexOrdinalMode | undefined { return this.modeValue; }
    get nextOrdinal(): number { return this.nextValue; }

    add(event: unknown): void {
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Codex history record must be an object");
        const ordinal = (event as { ordinal?: unknown }).ordinal;
        const mode = Object.hasOwn(event, "ordinal") ? "explicit" : "legacy";
        if (this.modeValue === undefined) {
            if ((this.expectedMode && mode !== this.expectedMode) || (this.previousMode === "explicit" && mode === "legacy")) {
                throw new Error("Codex history ordinal mode mismatch");
            }
            this.modeValue = mode;
        } else if (this.modeValue !== mode) {
            throw new Error("Codex history mixes explicit and legacy ordinals");
        }
        if (mode === "explicit") {
            if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal === Number.MAX_SAFE_INTEGER) {
                throw new Error("Codex history ordinal must be a non-negative safe integer with a safe successor");
            }
            if ((this.count === 0 && ordinal !== this.startOrdinal) || ordinal < this.nextValue) {
                throw new Error("Codex history ordinal is not strictly increasing or has an invalid start");
            }
            this.nextValue = ordinal + 1;
        } else {
            if (!Number.isSafeInteger(this.nextValue + 1)) throw new Error("Codex history ordinal overflow");
            this.nextValue += 1;
        }
        this.count += 1;
    }

    finish(endOrdinalExclusive?: number): void {
        if (endOrdinalExclusive !== undefined && this.nextValue !== endOrdinalExclusive) {
            throw new Error("Codex history prefix byte and ordinal boundaries disagree");
        }
    }
}
