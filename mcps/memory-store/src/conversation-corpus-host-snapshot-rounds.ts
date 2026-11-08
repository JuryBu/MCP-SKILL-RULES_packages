import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CorpusReadControl } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";

export interface HostSnapshotRound {
    roundIndex: number;
    sha256: string;
    bytes: number;
    parts: Array<{ sha256: string; bytes: number }>;
}

const MAX_ROUND_PARTS = 32;
const IO_BYTES = 64 * 1024;
const STRING_CHARS = 16 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;

function check(control: CorpusReadControl): void {
    if (control.isCancelled?.()) throw Object.assign(new Error("Host snapshot read cancelled"), { name: "AbortError" });
    if (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
        throw Object.assign(new Error("Host snapshot deadline exceeded"), { name: "TimeoutError" });
    }
}

function* jsonStrings(value: string, control: CorpusReadControl): Generator<string> {
    yield '"';
    for (let start = 0; start < value.length;) {
        check(control);
        let end = Math.min(value.length, start + STRING_CHARS);
        const last = value.charCodeAt(end - 1);
        const next = value.charCodeAt(end);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        yield JSON.stringify(value.slice(start, end)).slice(1, -1);
        start = end;
    }
    yield '"';
}

function* jsonValues(value: unknown, control: CorpusReadControl, ancestors = new Set<object>()): Generator<string> {
    check(control);
    if (typeof value === "string") { yield* jsonStrings(value, control); return; }
    if (value === null || typeof value !== "object") { yield JSON.stringify(value) ?? "null"; return; }
    if (ancestors.has(value)) throw new TypeError("Circular host snapshot round");
    ancestors.add(value);
    if (Array.isArray(value)) {
        yield "[";
        for (let index = 0; index < value.length; index++) {
            if (index) yield ",";
            yield* jsonValues(value[index], control, ancestors);
        }
        yield "]";
    } else {
        yield "{";
        let emitted = false;
        for (const [name, item] of Object.entries(value)) {
            if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
            if (emitted) yield ",";
            emitted = true;
            yield* jsonStrings(name, control);
            yield ":";
            yield* jsonValues(item, control, ancestors);
        }
        yield "}";
    }
    ancestors.delete(value);
}

export async function writeHostSnapshotRound(folder: string, round: ConversationRound, maximum: number,
    control: CorpusReadControl): Promise<HostSnapshotRound | null> {
    check(control);
    const root = path.join(folder, "round-data");
    await fs.mkdir(root, { recursive: true });
    const temporary = path.join(root, `.pending-${randomUUID()}`);
    await fs.mkdir(temporary);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let partBytes = 0;
    let partHash = createHash("sha256");
    const fullHash = createHash("sha256");
    const parts: HostSnapshotRound["parts"] = [];
    let bytes = 0;
    const finishPart = async () => {
        if (!handle) return;
        await handle.close();
        handle = undefined;
        parts.push({ sha256: partHash.digest("hex"), bytes: partBytes });
        partBytes = 0;
        partHash = createHash("sha256");
    };
    const write = async (buffer: Buffer) => {
        for (let offset = 0; offset < buffer.length;) {
            check(control);
            if (!handle) {
                if (parts.length >= MAX_ROUND_PARTS) return false;
                handle = await fs.open(path.join(temporary, `${parts.length}.bin`), "wx");
            }
            const length = Math.min(maximum - partBytes, buffer.length - offset);
            const result = await handle.write(buffer, offset, length, partBytes);
            if (!result.bytesWritten) throw new Error("Host snapshot write made no progress");
            const written = buffer.subarray(offset, offset + result.bytesWritten);
            partHash.update(written);
            fullHash.update(written);
            offset += result.bytesWritten;
            partBytes += result.bytesWritten;
            bytes += result.bytesWritten;
            if (partBytes === maximum) await finishPart();
        }
        return true;
    };
    try {
        let pending: string[] = [];
        let pendingBytes = 0;
        for (const text of jsonValues(round, control)) {
            pending.push(text);
            pendingBytes += Buffer.byteLength(text);
            if (pendingBytes < IO_BYTES) continue;
            if (!await write(Buffer.from(pending.join("")))) return null;
            pending = [];
            pendingBytes = 0;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (pending.length && !await write(Buffer.from(pending.join("")))) return null;
        await finishPart();
        check(control);
        const sha256 = fullHash.digest("hex");
        const target = path.join(root, `${sha256}-${parts[0].bytes}`);
        try { await fs.rename(temporary, target); }
        catch (error) {
            if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
            const existing = await fs.stat(target).catch(() => undefined);
            if (!existing?.isDirectory()) throw error;
        }
        return { roundIndex: round.roundIndex, sha256, bytes, parts };
    } finally {
        if (handle) await handle.close();
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

export async function readHostSnapshotRound(folder: string, stored: HostSnapshotRound, maximum: number,
    control: CorpusReadControl): Promise<ConversationRound | null> {
    check(control);
    if (!DIGEST.test(stored.sha256) || !Number.isSafeInteger(stored.bytes) || stored.bytes <= 0
        || !Array.isArray(stored.parts) || !stored.parts.length || stored.parts.length > MAX_ROUND_PARTS
        || stored.parts.some(part => !DIGEST.test(part.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > maximum)
        || stored.parts.reduce((total, part) => total + part.bytes, 0) !== stored.bytes) return null;
    const fullHash = createHash("sha256");
    const buffers: Buffer[] = [];
    for (let index = 0; index < stored.parts.length; index++) {
        check(control);
        const part = stored.parts[index];
        const handle = await fs.open(path.join(folder, "round-data", `${stored.sha256}-${stored.parts[0].bytes}`, `${index}.bin`), "r");
        try {
            if ((await handle.stat()).size !== part.bytes) return null;
            const partHash = createHash("sha256");
            for (let position = 0; position < part.bytes;) {
                check(control);
                const buffer = Buffer.allocUnsafe(Math.min(IO_BYTES, part.bytes - position));
                const result = await handle.read(buffer, 0, buffer.length, position);
                if (!result.bytesRead) return null;
                const actual = buffer.subarray(0, result.bytesRead);
                partHash.update(actual);
                fullHash.update(actual);
                buffers.push(actual);
                position += result.bytesRead;
            }
            if (partHash.digest("hex") !== part.sha256) return null;
        } finally { await handle.close(); }
    }
    if (fullHash.digest("hex") !== stored.sha256) return null;
    check(control);
    const round = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers, stored.bytes))) as ConversationRound;
    check(control);
    return round.roundIndex === stored.roundIndex ? round : null;
}
