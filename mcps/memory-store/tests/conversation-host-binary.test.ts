import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "conversation-host-binary-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const key = Buffer.from("0123456789abcdef0123456789abcdef");
function varint(input: number): Buffer {
    let value = input;
    const bytes: number[] = [];
    do { const byte = value & 127; value >>>= 7; bytes.push(value ? byte | 128 : byte); } while (value);
    return Buffer.from(bytes);
}
function field(number: number, input: string | Buffer): Buffer {
    const bytes = typeof input === "string" ? Buffer.from(input) : input;
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function encrypted(count: number, id = "fixture", edit = ""): Buffer {
    const steps = Array.from({ length: count }, (_, index) => [field(2, field(19, field(1, `question-${index + 1}${index === 0 ? edit : ""}`))), field(2, field(20, field(1, `answer-${index + 1}`)))]).flat();
    const plaintext = Buffer.concat([field(1, id), ...steps]);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

try {
    for (const source of ["windsurf", "antigravity"] as const) {
        const filename = path.join(root, `${source}.pb`);
        await writeFile(filename, encrypted(200));
        const options = { pbCandidates: () => [{ kind: "active" as const, filePath: filename }], pbReaderOptions: { key } };
        const provider = createHostCorpusProvider(source, options);
        const conversation = { source, id: "file-identity", canonicalId: "file-identity", title: "fixture", workspace: root, rolloutPath: filename };
        const tail = await provider.readFast(conversation, { lastRounds: 2 });
        assert.equal(tail.roundNumbering, "relative");
        assert.equal(tail.totalRounds, undefined);
        assert.equal(tail.requestedRangeComplete, true);
        assert.equal(tail.complete, false);
        assert.match(tail.messages.map(message => message.text).join("\n"), /question-199/u);
        assert.equal(tail.timings?.decodedSteps, 64);
        const prefix = await provider.readFast(conversation, { startRound: 1, endRound: 2 });
        assert.equal(prefix.roundNumbering, "absolute");
        assert.equal(prefix.totalRounds, undefined);
        assert.equal(prefix.requestedRangeComplete, true);
        assert.equal(prefix.complete, false);
        assert.deepEqual(prefix.rounds?.map(round => round.roundIndex), [1, 2]);
        const full = await provider.read(conversation, {});
        assert.equal(full.revision, tail.revision);
        assert.equal(full.totalRounds, 200);
        assert.equal(full.complete, true);
        assert.equal(full.timings?.preparedReused, 1);
        assert.ok(full.timings!.reusedSteps >= 128);
        const repeated = await provider.readFast(conversation, { lastRounds: 2 });
        assert.equal(repeated.roundNumbering, "absolute");
        assert.deepEqual(repeated.rounds?.map(round => round.roundIndex), [199, 200]);
        assert.equal(repeated.timings?.decodedSteps, 0);
        await writeFile(filename, encrypted(201, "fixture", "-edited"));
        const changed = await provider.read(conversation, {});
        assert.equal(changed.totalRounds, 201);
        assert.notEqual(changed.revision, full.revision);
        const historical = await provider.readRounds(conversation, { revision: full.revision, startRound: 1, endRound: 1 });
        assert.equal(historical.revision, full.revision);
        assert.equal(historical.snapshotSourceRevision, full.revision);
        assert.equal(historical.sourceRevalidatedThisCall, false);
        assert.doesNotMatch(historical.messages.map(message => message.text).join("\n"), /edited/u);
        const uncached = createHostCorpusProvider(source, { ...options, cacheRoot: path.join(root, `${source}-uncached`) });
        await assert.rejects(uncached.readRounds(conversation, { revision: full.revision, startRound: 1, endRound: 1 }), /revision changed/u);
        await assert.rejects(provider.readFast(conversation, { lastRounds: 1 }, { isCancelled: () => true }), error => (error as Error).name === "AbortError");
        const invalid = path.join(root, `${source}-invalid.pb`);
        await writeFile(invalid, Buffer.alloc(64));
        const degraded = createHostCorpusProvider(source, { pbCandidates: () => [{ kind: "active", filePath: filename }, { kind: "implicit", filePath: invalid }], pbReaderOptions: { key } });
        const partial = await degraded.read(conversation, { onChunk: chunk => { assert.equal(chunk.verified, false); } });
        assert.equal(partial.complete, false);
        assert.ok(partial.warnings.some(warning => /AUTH_FAILED/u.test(warning)));
        const different = path.join(root, `${source}-different.pb`);
        await writeFile(different, encrypted(201, "other-trajectory"));
        const conflict = createHostCorpusProvider(source, { pbCandidates: () => [{ kind: "active", filePath: filename }, { kind: "implicit", filePath: different }], pbReaderOptions: { key } });
        await assert.rejects(conflict.read(conversation, {}), /identities conflict/u);
        console.log(JSON.stringify({ test: "conversation-host-binary", source, tail: tail.timings, prefix: prefix.timings, full: full.timings, repeated: repeated.timings }));
    }
} finally {
    await rm(root, { recursive: true, force: true });
}
