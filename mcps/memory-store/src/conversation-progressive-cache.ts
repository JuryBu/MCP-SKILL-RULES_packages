import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compileCorpusSearch, CorpusSearchAccumulator, CORPUS_QUERY_SEMANTIC_VERSION } from "./conversation-corpus-search.js";
import type { CorpusMessage, CorpusSearchRequest } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";
import type {
    ProgressiveBlock, ProgressiveCache, ProgressiveCacheOptions, ProgressiveCoverage, ProgressiveLatestReadResult, ProgressiveLimits,
    ProgressivePublishInput, ProgressiveReadResult, ProgressiveRow, ProgressiveSearchResult,
    ProgressiveReadyRange, ProgressiveSelection, ProgressiveSource, ProgressiveStatus, ProgressiveWriter,
} from "./conversation-progressive-types.js";
export type * from "./conversation-progressive-types.js";

interface Manifest {
    format: "progressive-cache/v1";
    source: ProgressiveSource;
    sourceKey: string;
    version: number;
    state: ProgressiveStatus["state"];
    writer?: { token: string; pid: number };
    blocks: ProgressiveBlock[];
}

interface StoredRow { round: ConversationRound; messages: CorpusMessage[] }
interface LockOwner { token: string; pid: number }

export class ProgressiveCacheError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "ProgressiveCacheError"; }
}

const defaults: ProgressiveLimits = {
    maxBlockBytes: 64 * 1024 * 1024, maxRowBytes: 16 * 1024 * 1024,
    maxManifestBytes: 4 * 1024 * 1024, maxBlocks: 4096, maxRoundsPerBlock: 4096,
    maxResultBytes: 64 * 1024 * 1024, maxSearchMessages: 100_000, maxSearchRounds: 20_000,
};
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fail = (code: string, message: string): never => { throw new ProgressiveCacheError(code, message); };
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const jsonClone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const transactionTails = new Map<string, Promise<void>>();

async function retryFilesystem(action: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try { await action(); return; }
        catch (error) {
            if (attempt >= 39 || !["EBUSY", "EPERM", "EACCES"].includes(errorCode(error) || "")) throw error;
            await delay(15);
        }
    }
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return fail("invalid_input", "Snapshot and anchor must contain JSON values");
    return encoded;
}

function sourceIdentity(source: ProgressiveSource): string {
    return digest(canonical({ conversationId: source.conversationId, host: source.host, revision: source.revision }));
}

function validateSource(source: ProgressiveSource): void {
    if (!source || [source.conversationId, source.host, source.revision].some(value => typeof value !== "string" || !value.trim())
        || source.snapshot === undefined || (source.totalRounds !== undefined && (!Number.isSafeInteger(source.totalRounds) || source.totalRounds < 0))) {
        fail("invalid_source", "Source requires conversationId, host, whole-source revision and a frozen snapshot");
    }
    canonical(source);
}

function coverageValid(coverage: ProgressiveCoverage): boolean {
    return !!coverage && ["absolute", "relative"].includes(coverage.kind) && Number.isSafeInteger(coverage.startRound)
        && Number.isSafeInteger(coverage.endRound) && coverage.startRound > 0 && coverage.endRound >= coverage.startRound;
}

function alive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
}

async function rejectLinks(filename: string): Promise<void> {
    let current = path.resolve(filename);
    for (;;) {
        try { if ((await fs.lstat(current)).isSymbolicLink()) fail("unsafe_path", "Progressive cache paths must not contain symlinks"); }
        catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

async function readBounded(filename: string, maximum: number): Promise<Buffer> {
    await rejectLinks(filename);
    const handle = await fs.open(filename, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximum) fail("size_limit", "Cache file exceeds its bounded read budget");
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!read.bytesRead) fail("corrupt_cache", "Cache file was truncated during read");
            offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("changed_cache", "Cache file changed during read");
        return buffer;
    } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAtomic(filename: string, bytes: string): Promise<void> {
    await rejectLinks(filename);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx");
    try {
        try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await retryFilesystem(() => fs.rename(temporary, filename)); await syncDirectory(path.dirname(filename));
    }
    finally { await fs.unlink(temporary).catch(error => { if (errorCode(error) !== "ENOENT") throw error; }); }
}

class DiskProgressiveCache implements ProgressiveCache {
    readonly root: string;
    readonly sourceKey: string;
    private readonly source: ProgressiveSource;
    private readonly limits: ProgressiveLimits;

    constructor(options: ProgressiveCacheOptions) {
        validateSource(options.source);
        this.root = path.resolve(options.root);
        this.source = jsonClone(options.source);
        this.sourceKey = sourceIdentity(this.source);
        this.limits = { ...defaults, ...options.limits };
        for (const [name, value] of Object.entries(this.limits)) {
            if (!Number.isSafeInteger(value) || value < 1 || value > defaults[name as keyof ProgressiveLimits]) {
                fail("invalid_limit", `Limit ${name} must be positive and no larger than ${defaults[name as keyof ProgressiveLimits]}`);
            }
        }
    }

    private file(name: string): string { return path.join(this.root, name); }

    async initialize(): Promise<void> {
        await rejectLinks(this.root);
        try { await this.manifest(); return; }
        catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        await fs.mkdir(this.root, { recursive: true });
        await this.locked(async () => {
            try { await this.manifest(); }
            catch (error) {
                if (errorCode(error) !== "ENOENT") throw error;
                await this.save({ format: "progressive-cache/v1", source: this.source, sourceKey: this.sourceKey, version: 0, state: "idle", blocks: [] });
            }
        });
    }

    private async locked<Value>(action: () => Promise<Value>): Promise<Value> {
        const previous = transactionTails.get(this.root) ?? Promise.resolve();
        const run = previous.then(() => this.lockTransaction(action));
        const tail = run.then(() => {}, () => {});
        transactionTails.set(this.root, tail);
        try { return await run; }
        finally { if (transactionTails.get(this.root) === tail) transactionTails.delete(this.root); }
    }

    private async lockTransaction<Value>(action: () => Promise<Value>): Promise<Value> {
        const directory = this.file("transaction.lock");
        const ownerFile = path.join(directory, "owner.json");
        const owner: LockOwner = { token: randomUUID(), pid: process.pid };
        const candidate = this.file(`transaction-candidate-${process.pid}-${randomUUID()}`);
        await rejectLinks(candidate);
        await fs.mkdir(candidate);
        let acquired = false;
        try {
            await writeAtomic(path.join(candidate, "owner.json"), JSON.stringify(owner));
            for (let attempt = 0; attempt < 80; attempt++) {
                await rejectLinks(directory);
                try { await fs.rename(candidate, directory); acquired = true; }
                catch (error) {
                    if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(errorCode(error) || "")) throw error;
                    const existing = await fs.lstat(directory).catch(statError => { if (errorCode(statError) !== "ENOENT") throw statError; return undefined; });
                    if (!existing) { await delay(10); continue; }
                    if (!existing.isDirectory()) throw error;
                    let observed: LockOwner | undefined;
                    try { observed = JSON.parse((await readBounded(ownerFile, 4096)).toString("utf8")); }
                    catch (readError) { if (errorCode(readError) !== "ENOENT") throw readError; }
                    if (observed && !alive(observed.pid)) {
                        const reap = path.join(directory, "reap");
                        try { await fs.mkdir(reap); }
                        catch (reapError) { if (!["EEXIST", "ENOENT"].includes(errorCode(reapError) || "")) throw reapError; await delay(10); continue; }
                        const current = JSON.parse((await readBounded(ownerFile, 4096)).toString("utf8")) as LockOwner;
                        if (current.token === observed.token && !alive(current.pid)) {
                            const retired = this.file(`retired-lock-${randomUUID()}`);
                            await retryFilesystem(() => fs.rename(directory, retired));
                            await retryFilesystem(() => fs.unlink(path.join(retired, "owner.json")));
                            await fs.rmdir(path.join(retired, "reap"));
                            await fs.rmdir(retired);
                        } else await fs.rmdir(reap);
                        continue;
                    }
                    await delay(10);
                    continue;
                }
                try { return await action(); }
                finally {
                    const released = this.file(`released-lock-${randomUUID()}`);
                    await retryFilesystem(() => fs.rename(directory, released));
                    await retryFilesystem(() => fs.unlink(path.join(released, "owner.json")));
                    await fs.rmdir(released);
                }
            }
            return fail("writer_busy", "Cache transaction is busy or has an incomplete lock; no live lock was removed");
        } finally {
            if (!acquired) {
                await fs.unlink(path.join(candidate, "owner.json")).catch(error => { if (errorCode(error) !== "ENOENT") throw error; });
                await fs.rmdir(candidate);
            }
        }
    }

    private async manifest(): Promise<Manifest> {
        const manifest = JSON.parse((await readBounded(this.file("manifest.json"), this.limits.maxManifestBytes)).toString("utf8")) as Manifest;
        if (manifest.format !== "progressive-cache/v1" || manifest.sourceKey !== this.sourceKey
            || sourceIdentity(manifest.source) !== this.sourceKey) fail("source_mismatch", "Cache belongs to a different source generation");
        if (!Array.isArray(manifest.blocks) || manifest.blocks.length > this.limits.maxBlocks
            || !Number.isSafeInteger(manifest.version) || !["idle", "running", "cancelled", "complete"].includes(manifest.state)) fail("corrupt_cache", "Invalid progressive manifest");
        if (this.source.totalRounds !== undefined && manifest.source.totalRounds !== this.source.totalRounds) fail("source_mismatch", "Known totalRounds changed inside one source generation");
        for (const block of manifest.blocks) {
            if (!/^[a-f0-9]{64}$/.test(block.blockId) || !/^[a-f0-9]{64}$/.test(block.sha256) || !/^[a-f0-9]{64}$/.test(block.anchorId) || !coverageValid(block.coverage)
                || (block.order !== undefined && !Number.isSafeInteger(block.order))
                || !Number.isSafeInteger(block.bytes) || block.bytes < 1 || block.bytes > this.limits.maxBlockBytes
                || !Number.isSafeInteger(block.messageCount) || block.messageCount < 0
                || block.roundCount > this.limits.maxRoundsPerBlock || block.roundCount !== block.coverage.endRound - block.coverage.startRound + 1) fail("corrupt_cache", "Invalid progressive block descriptor");
        }
        if (new Set(manifest.blocks.map(block => block.blockId)).size !== manifest.blocks.length) fail("corrupt_cache", "Duplicate published block identity");
        if ((manifest.state === "running") !== Boolean(manifest.writer)) fail("corrupt_cache", "Writer/state mismatch");
        if (manifest.writer && (typeof manifest.writer.token !== "string" || !manifest.writer.token || !Number.isSafeInteger(manifest.writer.pid) || manifest.writer.pid < 1)) fail("corrupt_cache", "Invalid writer descriptor");
        const grouped = new Map<string, ProgressiveCoverage[]>();
        for (const block of manifest.blocks) {
            const key = block.coverage.kind === "absolute" ? "absolute" : block.anchorId;
            const ranges = grouped.get(key) ?? []; ranges.push(block.coverage); grouped.set(key, ranges);
        }
        for (const ranges of grouped.values()) {
            ranges.sort((left, right) => left.startRound - right.startRound);
            if (ranges.some((range, index) => index > 0 && range.startRound <= ranges[index - 1].endRound)) fail("corrupt_cache", "Overlapping published coverage");
        }
        if (manifest.state === "complete") {
            const status = this.statusOf(manifest); const total = manifest.source.totalRounds;
            if (total === undefined || status.relativeReadyRounds > 0 || status.coveredAbsoluteRounds !== total
                || total > 0 && (status.absoluteRanges.length !== 1 || status.absoluteRanges[0].startRound !== 1 || status.absoluteRanges[0].endRound !== total)) fail("corrupt_cache", "Complete manifest does not have complete source coverage");
        }
        return manifest;
    }

    private async save(manifest: Manifest): Promise<void> {
        const text = JSON.stringify(manifest);
        if (Buffer.byteLength(text) > this.limits.maxManifestBytes) fail("size_limit", "Manifest budget exceeded");
        await writeAtomic(this.file("manifest.json"), text);
    }

    private writerValid(manifest: Manifest, writer: ProgressiveWriter): void {
        if (writer.sourceKey !== this.sourceKey || manifest.state !== "running" || manifest.writer?.token !== writer.token) fail("stale_writer", "Writer is cancelled, replaced, foreign or complete");
    }

    async beginWrite(): Promise<ProgressiveWriter> {
        return this.locked(async () => {
            const manifest = await this.manifest();
            if (manifest.state === "complete") fail("already_complete", "Source generation is already complete");
            if (manifest.writer && alive(manifest.writer.pid)) fail("writer_busy", "A live writer owns this source generation");
            const writer = { token: randomUUID(), sourceKey: this.sourceKey };
            manifest.writer = { token: writer.token, pid: process.pid };
            manifest.state = "running"; manifest.version++;
            await this.save(manifest);
            return writer;
        });
    }

    async publish(writer: ProgressiveWriter, input: ProgressivePublishInput): Promise<ProgressiveBlock> {
        this.writerValid(await this.manifest(), writer);
        if (input.sourceRevision !== undefined && input.sourceRevision !== this.source.revision) fail("source_mismatch", "Published range revision differs from the whole-source generation");
        if (input.order !== undefined && !Number.isSafeInteger(input.order)) fail("invalid_range", "Block order must be a stable integer source-order hint");
        if (!coverageValid(input.coverage) || input.rounds.length !== input.coverage.endRound - input.coverage.startRound + 1
            || input.rounds.length > this.limits.maxRoundsPerBlock || input.messages.length > this.limits.maxSearchMessages) fail("invalid_range", "Block must contain every canonical round in its declared coverage");
        const coverage = jsonClone(input.coverage);
        const anchor = jsonClone(input.anchor);
        const sourceSnapshot = jsonClone(input.sourceSnapshot ?? this.source.snapshot);
        const anchorId = digest(canonical(anchor));
        const messagesByRound = new Map<number, CorpusMessage[]>();
        const messageIds = new Set<string>();
        for (const message of input.messages) {
            if (!Number.isSafeInteger(message.round) || message.round < coverage.startRound || message.round > coverage.endRound
                || !message.id || typeof message.text !== "string" || !["user", "assistant", "tool", "subagent"].includes(message.role)
                || messageIds.has(message.id)) fail("invalid_message", "Canonical message has invalid identity, role or round");
            messageIds.add(message.id);
            const group = messagesByRound.get(message.round) ?? [];
            group.push(message); messagesByRound.set(message.round, group);
        }
        const temporary = this.file(`pending-${process.pid}-${randomUUID()}.tmp`);
        await rejectLinks(temporary);
        const handle = await fs.open(temporary, "wx");
        const checksum = createHash("sha256");
        const identity = createHash("sha256").update(canonical({ sourceKey: this.sourceKey, coverage, anchorId }));
        let bytes = 0;
        let blockId = "";
        let sha256 = "";
        try {
            const append = async (value: unknown, row = false): Promise<void> => {
                const text = `${JSON.stringify(value)}\n`;
                const length = Buffer.byteLength(text);
                bytes += length;
                if (length > this.limits.maxRowBytes || bytes > this.limits.maxBlockBytes) fail("size_limit", "Block/row budget exceeded; split the canonical range into smaller blocks");
                if (row) identity.update(`\n${canonical(JSON.parse(text))}`);
                checksum.update(text); await handle.writeFile(text, "utf8");
            };
            await append({ format: "progressive-block/v1", sourceKey: this.sourceKey, coverage, anchorId, anchor, sourceSnapshot });
            for (const [offset, round] of input.rounds.entries()) {
                if (round.roundIndex !== coverage.startRound + offset || typeof round.userMessage !== "string" || !Array.isArray(round.aiResponses)) fail("invalid_range", "Canonical rounds must be consecutive and ordered");
                await append({ round, messages: messagesByRound.get(round.roundIndex) ?? [] }, true);
            }
            await handle.sync(); sha256 = checksum.digest("hex"); blockId = identity.digest("hex");
        } finally { await handle.close(); if (!blockId) await fs.unlink(temporary); }
        const block: ProgressiveBlock = { blockId, sha256, anchorId, coverage, anchor, sourceSnapshot, bytes, roundCount: input.rounds.length, messageCount: input.messages.length, ...(input.order === undefined ? {} : { order: input.order }) };
        try {
            return await this.locked(async () => {
                const manifest = await this.manifest(); this.writerValid(manifest, writer);
                const existing = manifest.blocks.find(item => item.blockId === blockId);
                if (existing) { await this.loadBlock(existing); return jsonClone(existing); }
                if (manifest.blocks.length >= this.limits.maxBlocks) fail("size_limit", "Published block budget exceeded");
                if (coverage.kind === "absolute" && manifest.source.totalRounds !== undefined && coverage.endRound > manifest.source.totalRounds) fail("invalid_range", "Absolute coverage exceeds totalRounds");
                if (manifest.blocks.some(item => item.coverage.kind === coverage.kind && (coverage.kind === "absolute" || item.anchorId === anchorId)
                    && item.coverage.startRound <= coverage.endRound && coverage.startRound <= item.coverage.endRound)) fail("overlapping_range", "Overlapping coverage must be split before publication");
                const finalPath = this.file(`block-${sha256}.jsonl`);
                await rejectLinks(finalPath);
                try { await fs.link(temporary, finalPath); }
                catch (error) {
                    if (errorCode(error) !== "EEXIST") throw error;
                    await this.loadBlock(block);
                }
                await syncDirectory(this.root);
                manifest.blocks.push(block); manifest.version++;
                await this.save(manifest);
                return jsonClone(block);
            });
        } finally { await fs.unlink(temporary); }
    }

    private statusOf(manifest: Manifest): ProgressiveStatus {
        const absoluteRanges: Array<{ startRound: number; endRound: number }> = [];
        for (const block of manifest.blocks.filter(block => block.coverage.kind === "absolute").sort((left, right) => left.coverage.startRound - right.coverage.startRound)) {
            const previous = absoluteRanges.at(-1);
            if (previous && block.coverage.startRound <= previous.endRound + 1) previous.endRound = Math.max(previous.endRound, block.coverage.endRound);
            else absoluteRanges.push({ startRound: block.coverage.startRound, endRound: block.coverage.endRound });
        }
        return jsonClone({ source: manifest.source, sourceKey: manifest.sourceKey, version: manifest.version, state: manifest.state,
            complete: manifest.state === "complete", completeRanges: manifest.blocks.map(block => ({ ...block.coverage, blockId: block.blockId, anchorId: block.anchorId })),
            absoluteRanges, coveredAbsoluteRounds: absoluteRanges.reduce((total, range) => total + range.endRound - range.startRound + 1, 0),
            relativeReadyRounds: manifest.blocks.filter(block => block.coverage.kind === "relative").reduce((total, block) => total + block.roundCount, 0), blocks: manifest.blocks });
    }

    async status(): Promise<ProgressiveStatus> { return this.statusOf(await this.manifest()); }

    async release(writer: ProgressiveWriter): Promise<ProgressiveStatus> {
        return this.locked(async () => {
            const manifest = await this.manifest(); this.writerValid(manifest, writer);
            delete manifest.writer; manifest.state = "idle"; manifest.version++;
            await this.save(manifest); return this.statusOf(manifest);
        });
    }

    async cancel(writer: ProgressiveWriter): Promise<ProgressiveStatus> {
        return this.locked(async () => {
            const manifest = await this.manifest(); this.writerValid(manifest, writer);
            delete manifest.writer; manifest.state = "cancelled"; manifest.version++;
            await this.save(manifest); return this.statusOf(manifest);
        });
    }

    async finish(writer: ProgressiveWriter): Promise<ProgressiveStatus> {
        return this.locked(async () => {
            const manifest = await this.manifest(); this.writerValid(manifest, writer);
            const status = this.statusOf(manifest);
            const total = manifest.source.totalRounds;
            if (total === undefined || status.relativeReadyRounds > 0 || status.coveredAbsoluteRounds !== total
                || (total > 0 && (status.absoluteRanges.length !== 1 || status.absoluteRanges[0].startRound !== 1 || status.absoluteRanges[0].endRound !== total))) fail("incomplete_coverage", "Finish requires exact absolute coverage of 1..totalRounds without relative blocks");
            for (const block of manifest.blocks) await this.loadBlock(block);
            delete manifest.writer; manifest.state = "complete"; manifest.version++;
            await this.save(manifest); return this.statusOf(manifest);
        });
    }

    private async loadBlock(block: ProgressiveBlock): Promise<StoredRow[]> {
        const buffer = await readBounded(this.file(`block-${block.sha256}.jsonl`), this.limits.maxBlockBytes);
        if (buffer.length !== block.bytes || digest(buffer) !== block.sha256) fail("corrupt_cache", "Immutable block checksum mismatch");
        const lines = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trimEnd().split("\n");
        const header = JSON.parse(lines.shift() || "null");
        if (header?.format !== "progressive-block/v1" || header.sourceKey !== this.sourceKey || header.anchorId !== block.anchorId
            || canonical(header.coverage) !== canonical(block.coverage) || canonical(header.sourceSnapshot) !== canonical(block.sourceSnapshot)
            || digest(canonical(header.anchor)) !== block.anchorId) fail("corrupt_cache", "Immutable block provenance mismatch");
        if (lines.length !== block.roundCount || lines.some(line => Buffer.byteLength(line) + 1 > this.limits.maxRowBytes)) fail("corrupt_cache", "Immutable block row count/size mismatch");
        const rows = lines.map(line => JSON.parse(line) as StoredRow);
        const identity = createHash("sha256").update(canonical({ sourceKey: this.sourceKey, coverage: block.coverage, anchorId: block.anchorId }));
        for (const row of rows) identity.update(`\n${canonical(row)}`);
        if (identity.digest("hex") !== block.blockId) fail("corrupt_cache", "Immutable block logical identity mismatch");
        if (rows.some((row, offset) => row.round.roundIndex !== block.coverage.startRound + offset || !Array.isArray(row.messages)
            || row.messages.some(message => message.round !== row.round.roundIndex)) || rows.reduce((total, row) => total + row.messages.length, 0) !== block.messageCount) fail("corrupt_cache", "Immutable block canonical coverage mismatch");
        return rows;
    }

    private selectionValid(selection: ProgressiveSelection): void {
        if ((selection.startRound !== undefined && (!Number.isSafeInteger(selection.startRound) || selection.startRound < 1))
            || (selection.endRound !== undefined && (!Number.isSafeInteger(selection.endRound) || selection.endRound < (selection.startRound ?? 1)))
            || (selection.kind !== undefined && !["absolute", "relative"].includes(selection.kind))
            || (selection.direction !== undefined && !["latest", "oldest"].includes(selection.direction))
            || (selection.blockOrder !== undefined && !["source", "publication"].includes(selection.blockOrder))) fail("invalid_range", "Invalid read selection");
        if (selection.blockIds !== undefined && (!Array.isArray(selection.blockIds) || selection.blockIds.length < 1
            || selection.blockIds.length > this.limits.maxBlocks || selection.blockIds.some(blockId => typeof blockId !== "string" || !/^[a-f0-9]{64}$/.test(blockId))
            || new Set(selection.blockIds).size !== selection.blockIds.length || selection.blockId !== undefined || selection.blockOrder !== undefined)) {
            fail("invalid_range", "blockIds requires distinct published IDs in explicit traversal order and excludes blockId/blockOrder");
        }
    }

    private reference(block: ProgressiveBlock, round: number): string {
        return `pcache:v1:${this.sourceKey}:${block.blockId}:${block.anchorId}:${block.coverage.kind}:${round}`;
    }

    private async *rows(manifest: Manifest, selection: ProgressiveSelection): AsyncGenerator<ProgressiveRow> {
        this.selectionValid(selection);
        let blocks: ProgressiveBlock[];
        if (selection.blockIds !== undefined) {
            const published = new Map(manifest.blocks.map(block => [block.blockId, block]));
            blocks = selection.blockIds.map(blockId => published.get(blockId) ?? fail("unpublished_ref", "blockIds contains an unpublished block"))
                .filter(block => !selection.kind || block.coverage.kind === selection.kind);
        } else {
            blocks = manifest.blocks.filter(block => (!selection.blockId || block.blockId === selection.blockId) && (!selection.kind || block.coverage.kind === selection.kind));
            if (selection.blockOrder !== "publication") {
                blocks.sort((left, right) => left.coverage.kind === "absolute" && right.coverage.kind === "absolute"
                    ? left.coverage.startRound - right.coverage.startRound : (left.order ?? 0) - (right.order ?? 0));
                if (blocks.length > 1 && blocks.some(block => block.coverage.kind === "relative")
                    && (blocks.some(block => block.order === undefined) || new Set(blocks.map(block => block.order)).size !== blocks.length)) {
                    fail("ambiguous_order", "Multiple relative blocks need stable order hints, blockIds or publication order");
                }
                if (selection.direction !== "oldest") blocks.reverse();
            }
        }
        for (const block of blocks) {
            if (selection.isCancelled?.()) fail("cancelled", "Progressive read was cancelled");
            if (block.coverage.endRound < (selection.startRound ?? 1) || block.coverage.startRound > (selection.endRound ?? Number.MAX_SAFE_INTEGER)) continue;
            const rows = await this.loadBlock(block);
            if (selection.direction !== "oldest") rows.reverse();
            for (const row of rows) {
                if (selection.isCancelled?.()) fail("cancelled", "Progressive read was cancelled");
                if (row.round.roundIndex < (selection.startRound ?? 1) || row.round.roundIndex > (selection.endRound ?? Number.MAX_SAFE_INTEGER)) continue;
                yield { ...row, ref: this.reference(block, row.round.roundIndex), blockId: block.blockId, anchorId: block.anchorId, kind: block.coverage.kind };
            }
        }
    }

    async *iterate(selection: ProgressiveSelection = {}): AsyncGenerator<ProgressiveRow> {
        yield* this.rows(await this.manifest(), selection);
    }

    private rangeComplete(status: ProgressiveStatus, selection: ProgressiveSelection): boolean {
        const requestedBlockIds = selection.blockIds ?? (selection.blockId ? [selection.blockId] : undefined);
        if (requestedBlockIds) return requestedBlockIds.every(blockId => status.blocks.some(block => block.blockId === blockId
            && (!selection.kind || block.coverage.kind === selection.kind)
            && block.coverage.startRound <= (selection.startRound ?? block.coverage.startRound)
            && block.coverage.endRound >= (selection.endRound ?? block.coverage.endRound)));
        const start = selection.startRound ?? 1;
        const end = selection.endRound ?? status.source.totalRounds;
        if (end === undefined) return false;
        if (end === 0) return status.complete;
        return selection.kind !== "relative" && status.absoluteRanges.some(range => range.startRound <= start && range.endRound >= end);
    }

    async read(selection: ProgressiveSelection = {}): Promise<ProgressiveReadResult> {
        const manifest = await this.manifest(); const status = this.statusOf(manifest);
        const rows: ProgressiveRow[] = []; let bytes = 0;
        for await (const row of this.rows(manifest, selection)) {
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (bytes > this.limits.maxResultBytes) fail("size_limit", "Read result budget exceeded; use iterate or a smaller selection");
            rows.push(row);
        }
        return { status, rows, rounds: rows.map(row => row.round), messages: rows.flatMap(row => row.messages), requestedRangeComplete: this.rangeComplete(status, selection) };
    }

    async readLatest(selection: ProgressiveSelection, lastRounds: number): Promise<ProgressiveLatestReadResult> {
        if (!Number.isSafeInteger(lastRounds) || lastRounds < 1 || lastRounds > 100_000
            || selection.startRound !== undefined || selection.endRound !== undefined
            || selection.direction !== undefined && selection.direction !== "latest") fail("invalid_range", "readLatest requires 1..100000 rounds without explicit round bounds or oldest direction");
        const manifest = await this.manifest(); const status = this.statusOf(manifest);
        const rows: ProgressiveRow[] = []; let bytes = 0;
        for await (const row of this.rows(manifest, { ...selection, direction: "latest" })) {
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (bytes > this.limits.maxResultBytes) fail("size_limit", "Latest read result budget exceeded; request fewer rounds");
            rows.push(row);
            if (rows.length === lastRounds) break;
        }
        return { status, rows, rounds: rows.map(row => row.round), messages: rows.flatMap(row => row.messages),
            requestedRangeComplete: rows.length === lastRounds, selectionScope: "published", requestedRounds: lastRounds, returnedRounds: rows.length };
    }

    async locate(ref: string): Promise<ProgressiveRow> {
        const parsed = /^pcache:v1:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}):(absolute|relative):([1-9][0-9]*)$/.exec(ref);
        if (!parsed || parsed[1] !== this.sourceKey) return fail("invalid_ref", "Reference belongs to another source generation or has invalid syntax");
        const manifest = await this.manifest();
        const block = manifest.blocks.find(block => block.blockId === parsed[2] && block.anchorId === parsed[3] && block.coverage.kind === parsed[4]);
        if (!block) return fail("unpublished_ref", "Reference does not name a published immutable block");
        for await (const row of this.rows(manifest, { blockId: block.blockId, startRound: Number(parsed[5]), endRound: Number(parsed[5]) })) return row;
        return fail("invalid_ref", "Reference round is outside published coverage");
    }

    async search(request: CorpusSearchRequest, selection: ProgressiveSelection = {}): Promise<ProgressiveSearchResult> {
        const manifest = await this.manifest(); const status = this.statusOf(manifest);
        const conversation = manifest.source.conversation ?? { id: manifest.source.conversationId, source: "codex" as const, title: "", workspace: "" };
        const accumulator = new CorpusSearchAccumulator(conversation, compileCorpusSearch(request), { revision: manifest.source.revision });
        const locators = new Map<number, { ref: string; round: number; blockId: string; kind: ProgressiveCoverage["kind"] }>();
        const searchedRanges: ProgressiveReadyRange[] = [];
        let scannedRounds = 0; let scannedMessages = 0;
        for await (const row of this.rows(manifest, selection)) {
            scannedRounds++; scannedMessages += row.messages.length;
            if (scannedRounds > this.limits.maxSearchRounds || scannedMessages > this.limits.maxSearchMessages) fail("size_limit", "Search accumulator budget exceeded; select a smaller published range");
            locators.set(scannedRounds, { ref: row.ref, round: row.round.roundIndex, blockId: row.blockId, kind: row.kind });
            const previous = searchedRanges.at(-1);
            if (previous?.blockId === row.blockId) {
                previous.startRound = Math.min(previous.startRound, row.round.roundIndex);
                previous.endRound = Math.max(previous.endRound, row.round.roundIndex);
            } else searchedRanges.push({ kind: row.kind, startRound: row.round.roundIndex, endRound: row.round.roundIndex, blockId: row.blockId, anchorId: row.anchorId });
            for (const message of row.messages) accumulator.append({ ...message, id: `${row.blockId}:${message.id}`, round: scannedRounds });
        }
        const match = accumulator.snapshot(status.complete);
        const hits = match?.rounds.map(round => locators.get(round)!) ?? [];
        if (match) {
            match.round = match.round === null ? null : locators.get(match.round)!.round;
            match.rounds = hits.map(hit => hit.round);
            match.snippets = match.snippets.map(snippet => ({ ...snippet, round: locators.get(snippet.round)!.round, messageId: snippet.messageId.slice(65) }));
        }
        return { semanticVersion: CORPUS_QUERY_SEMANTIC_VERSION, status, match, hits, scannedRounds,
            scannedMessages: accumulator.scannedMessages, searchedRanges, requestedRangeComplete: this.rangeComplete(status, selection), provisional: !status.complete };
    }
}

export async function openProgressiveCache(options: ProgressiveCacheOptions): Promise<ProgressiveCache> {
    const cache = new DiskProgressiveCache(options);
    await cache.initialize();
    return cache;
}
