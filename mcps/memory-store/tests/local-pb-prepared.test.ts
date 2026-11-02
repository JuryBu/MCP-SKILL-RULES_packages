import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareLocalPbCandidate, prepareLocalPbFileCandidates, readLocalPbCandidate } from "../src/local-pb-reader.js";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
function varint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do { const octet = remaining % 128; remaining = Math.floor(remaining / 128); bytes.push(remaining ? octet | 128 : octet); } while (remaining);
    return Buffer.from(bytes);
}
function field(number: number, content: Buffer | string): Buffer {
    const bytes = Buffer.from(content);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function encrypt(bytes: Buffer): Buffer {
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12, 3));
    return Buffer.concat([Buffer.alloc(12, 3), cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}
function trajectory(marker: string): Buffer {
    return Buffer.concat([field(1, "synthetic-pb"), ...Array.from({ length: 128 }, (_, index) => field(2, Buffer.concat([
        field(19, field(1, `Synthetic question ${index}`)), field(20, field(1, `${marker}${"R".repeat(8192)}`)),
        ...(index === 127 ? [field(91, field(1, "unknown synthetic wire variant"))] : []),
    ])))]);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-pb-prepared-"));
try {
    for (const sourceFlavor of ["windsurf", "antigravity"] as const) {
        const candidate = { kind: "active" as const, encrypted: encrypt(trajectory("A")) };
        const options = { key, sourceFlavor };
        const prepared = prepareLocalPbCandidate(candidate, options);
        const tail = prepared.read({ tailSteps: 4 });
        assert.equal(tail.metrics?.decodedSteps, 4);
        assert.equal(tail.metrics?.reusedSteps, 0);
        assert.equal(tail.metrics?.authenticatedBytes, candidate.encrypted.length);
        assert.equal(tail.partial, true);
        assert.ok(tail.diagnostics.some(item => item.kind === "unknown_variant"));
        tail.trajectory.steps[0].user = "Caller mutation";
        const overlap = prepared.read({ startStep: 126 });
        assert.equal(overlap.metrics?.decodedSteps, 0);
        assert.equal(overlap.metrics?.reusedSteps, 2);
        assert.equal(overlap.metrics?.authenticatedBytes, 0);
        const pristine = prepared.read({ tailSteps: 4 });
        assert.notEqual(pristine.trajectory.steps[0].user, "Caller mutation");
        const full = prepared.read();
        assert.equal(full.metrics?.decodedSteps, 124);
        assert.equal(full.metrics?.reusedSteps, 4);
        assert.deepEqual(pristine.trajectory, { id: full.trajectory.id, steps: full.trajectory.steps.slice(-4) });
        assert.deepEqual(readLocalPbCandidate(candidate, options).trajectory, full.trajectory);
        assert.equal(full.sourceRevision, prepared.sourceRevision);
        assert.throws(() => prepared.read({ tailSteps: 2 }, { isCancelled: () => true }), /cancelled/u);
        console.log(`PASS ${sourceFlavor} prepared PB: one authentication, four initial decoded steps, overlap reuse, immutable outputs and unknown coverage`);
        console.log(`METRICS ${JSON.stringify({ sourceFlavor, encryptedBytes: candidate.encrypted.length, first: tail.metrics, full: full.metrics })}`);
    }
    const activePath = path.join(root, "active.pb");
    const implicitPath = path.join(root, "implicit.pb");
    fs.writeFileSync(activePath, encrypt(trajectory("A")));
    fs.writeFileSync(implicitPath, encrypt(field(1, trajectory("A"))));
    const candidates = [{ kind: "active" as const, filePath: activePath }, { kind: "implicit" as const, filePath: implicitPath }];
    const options = { key, sourceFlavor: "antigravity" as const };
    const first = prepareLocalPbFileCandidates(candidates, options);
    assert.equal(first.candidates.filter(item => item.reader).length, 2);
    assert.equal(first.partial, false);
    assert.equal(prepareLocalPbFileCandidates(candidates, options).sourceRevision, first.sourceRevision);
    const stat = fs.statSync(implicitPath);
    fs.writeFileSync(implicitPath, encrypt(field(1, trajectory("B"))));
    fs.utimesSync(implicitPath, stat.atime, stat.mtime);
    assert.equal(fs.statSync(implicitPath).size, stat.size);
    const rewritten = prepareLocalPbFileCandidates(candidates, options);
    assert.notEqual(rewritten.sourceRevision, first.sourceRevision);
    const damaged = fs.readFileSync(implicitPath);
    damaged[damaged.length - 1] ^= 1;
    fs.writeFileSync(implicitPath, damaged);
    const failed = prepareLocalPbFileCandidates(candidates, options);
    assert.equal(failed.candidates[1].error?.code, "AUTH_FAILED");
    assert.equal(failed.partial, true);
    damaged[damaged.length - 2] ^= 1;
    fs.writeFileSync(implicitPath, damaged);
    assert.notEqual(prepareLocalPbFileCandidates(candidates, options).sourceRevision, failed.sourceRevision);
    assert.notEqual(prepareLocalPbFileCandidates(candidates.slice(0, 1), options).sourceRevision, failed.sourceRevision);
    const unknown = prepareLocalPbFileCandidates(candidates, { ...options, maxPayloadBytes: 16 });
    assert.notEqual(prepareLocalPbFileCandidates(candidates, { ...options, maxPayloadBytes: 16 }).sourceRevision, unknown.sourceRevision);
    console.log("PASS aggregate revision covers all authenticated/failed candidates, same-size preserved-mtime edits, deletion and unverified budget outcomes");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
