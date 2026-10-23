import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import { resolveCodexHistoryArchiveLimits, streamCodexHistoryArchive, type CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import { codexHistoryPhysicalIdentity, type CodexStreamingHistorySegment } from "./codex-history-source.js";
import { CodexHistorySourceMismatchError, throwIfCodexReadCancelled } from "./codex-history-integrity.js";

const FORMAT = "codex-adopted-prefix-proof/v2";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
interface Proof { physicalSha256: string; logicalBytes: number }
interface ProofResult extends Proof { cacheHit: boolean }
interface Flight { promise: Promise<ProofResult>; consumers: number; cancelled: boolean; settled: boolean; listeners: Set<(bytes: number) => void>; checks: Set<() => void> }
const flights = new Map<string, Flight>();

export interface AdoptedPrefixProofOptions {
    cacheRoot: string;
    segment: CodexStreamingHistorySegment;
    endByte: number;
    expectedSha256: string;
    archive?: CodexHistoryArchiveOptions;
    isCancelled?: () => boolean;
    onProgress?: (bytes: number) => void;
}

export async function proveCodexAdoptedPrefix(options: AdoptedPrefixProofOptions): Promise<Proof & { decodedBytes: number; cacheHit: boolean; sharedFlight: boolean }> {
    throwIfCodexReadCancelled(options.isCancelled);
    const { segment } = options;
    if (!/\.zst$/iu.test(segment.path) || segment.replicas.length || !Number.isSafeInteger(options.endByte) || options.endByte < 1 || !/^[a-f0-9]{64}$/u.test(options.expectedSha256)) throw new Error("Adopted prefix proof requires a compressed source, complete replica discovery and a valid boundary");
    const limits = resolveCodexHistoryArchiveLimits(options.archive);
    const archive = { ...options.archive, maxCompressedBytes: limits.compressed, maxDecompressedBytes: limits.logical, maxWindowBytes: limits.window, minFreeBytes: limits.reserve };
    const identity = {
        format: FORMAT, path: path.resolve(segment.path), physical: segment.physical, replicas: segment.replicas,
        headerSha256: segment.headerSha256, startOrdinal: segment.startOrdinal, endOrdinalExclusive: segment.endOrdinalExclusive,
        endByte: options.endByte, expectedSha256: options.expectedSha256,
        limits: { decoder: archive.decoder ?? "auto", ...limits },
    };
    const key = digest(identity);
    const filename = path.join(options.cacheRoot, `${key}.json`);
    const assertPhysical = async (isCancelled = options.isCancelled) => {
        throwIfCodexReadCancelled(isCancelled);
        if (!same(segment.physical, codexHistoryPhysicalIdentity(await fs.stat(segment.path)))) throw new CodexHistorySourceMismatchError("Codex compressed source changed before adopted prefix reuse");
    };
    await assertPhysical();
    const flightKey = `${path.resolve(options.cacheRoot)}:${key}`;
    let flight = flights.get(flightKey);
    if (flight?.cancelled) {
        await flight.promise.catch(() => {});
        throwIfCodexReadCancelled(options.isCancelled);
        return proveCodexAdoptedPrefix(options);
    }
    const sharedFlight = Boolean(flight);
    if (!flight) {
        flight = { promise: undefined as unknown as Promise<ProofResult>, consumers: 0, cancelled: false, settled: false, listeners: new Set(), checks: new Set() };
        const active = flight;
        active.promise = Promise.resolve().then(async () => {
            const isCancelled = () => {
                for (const check of [...active.checks]) check();
                return active.cancelled;
            };
            await assertPhysical(isCancelled);
            try {
                if ((await fs.stat(filename)).size <= 16384) {
                    const cached = JSON.parse(await fs.readFile(filename, "utf8"));
                    const proof = cached.proof as Proof;
                    if (same(cached.identity, identity) && cached.sha256 === digest({ identity, proof }) && /^[a-f0-9]{64}$/u.test(proof?.physicalSha256)
                        && Number.isSafeInteger(proof.logicalBytes) && proof.logicalBytes >= options.endByte) {
                        await assertPhysical(isCancelled);
                        throwIfCodexReadCancelled(isCancelled);
                        return { ...proof, cacheHit: true };
                    }
                }
            } catch (error) {
                throwIfCodexReadCancelled(isCancelled);
                if (error instanceof CodexHistorySourceMismatchError) throw error;
            }
            const hash = createHash("sha256");
            let logicalBytes = 0;
            let physicalSha256 = "";
            for await (const chunk of streamCodexHistoryArchive(segment.path, { ...archive, calculateLogicalSha256: false, isCancelled, onComplete: result => { physicalSha256 = result.sourceSha256; } })) {
                if (logicalBytes < options.endByte) hash.update(chunk.subarray(0, Math.min(chunk.length, options.endByte - logicalBytes)));
                logicalBytes += chunk.length;
                for (const listener of [...active.listeners]) listener(logicalBytes);
                throwIfCodexReadCancelled(isCancelled);
            }
            if (logicalBytes < options.endByte || hash.digest("hex") !== options.expectedSha256) throw new CodexHistorySourceMismatchError("Codex legacy adopted prefix differs after compression");
            if (!same(segment.physical, codexHistoryPhysicalIdentity(await fs.stat(segment.path)))) throw new CodexHistorySourceMismatchError("Codex compressed source changed during adopted prefix proof");
            throwIfCodexReadCancelled(isCancelled);
            const proof = { physicalSha256, logicalBytes };
            const temporary = `${filename}.${randomUUID()}.tmp`;
            await fs.mkdir(options.cacheRoot, { recursive: true });
            try {
                await fs.writeFile(temporary, JSON.stringify({ identity, proof, sha256: digest({ identity, proof }) }), { flag: "wx", mode: 0o600 });
                throwIfCodexReadCancelled(isCancelled);
                renameSync(temporary, filename);
            } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
            return { ...proof, cacheHit: false };
        });
        flights.set(flightKey, active);
        void active.promise.finally(() => { active.settled = true; if (flights.get(flightKey) === active) flights.delete(flightKey); }).catch(() => {});
    }
    const active = flight;
    active.consumers++;
    return new Promise((resolve, reject) => {
        let finished = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const finish = (error?: unknown, proof?: ProofResult) => {
            if (finished) return;
            finished = true;
            if (timer) clearInterval(timer);
            active.listeners.delete(progress);
            active.checks.delete(check);
            active.consumers--;
            const drain = !active.consumers && !active.settled;
            if (drain) active.cancelled = true;
            if (error) {
                if (drain) void active.promise.then(() => reject(error), () => reject(error));
                else reject(error);
            } else resolve({ ...proof!, decodedBytes: proof!.cacheHit ? 0 : proof!.logicalBytes, sharedFlight });
        };
        const check = () => { try { throwIfCodexReadCancelled(options.isCancelled); } catch (error) { finish(error); } };
        const progress = (bytes: number) => {
            check();
            if (!finished) { try { options.onProgress?.(bytes); check(); } catch (error) { finish(error); } }
        };
        active.listeners.add(progress);
        active.checks.add(check);
        timer = setInterval(check, 25);
        active.promise.then(proof => { check(); if (!finished) finish(undefined, proof); }, error => finish(error));
        check();
    });
}
