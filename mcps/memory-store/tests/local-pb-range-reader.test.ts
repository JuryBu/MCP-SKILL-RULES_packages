import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { LocalPbReaderError, readLocalPbCandidate, type LocalPbStepRangeRequest } from "../src/local-pb-reader.ts";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do {
        const octet = remaining & 127;
        remaining = Math.floor(remaining / 128);
        bytes.push(remaining ? octet | 128 : octet);
    } while (remaining);
    return Buffer.from(bytes);
}
function bytesField(fieldNumber: number, content: Buffer | string): Buffer {
    const bytes = Buffer.from(content);
    return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(bytes.length), bytes]);
}
function encrypt(plaintext: Buffer): Buffer {
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
const steps = Array.from({ length: 6 }, (_, index) => Buffer.concat([
    bytesField(19, bytesField(1, `虚构提问${index}`)),
    bytesField(20, bytesField(1, `虚构答复${index}\r\n猫`)),
]));
const plaintext = Buffer.concat([bytesField(1, "fictional-trajectory"), ...steps.map(item => bytesField(2, item))]);
let passed = 0;
for (const sourceFlavor of ["windsurf", "antigravity"] as const) {
    for (const kind of ["active", "implicit"] as const) {
        const candidate = { kind, encrypted: encrypt(kind === "implicit" ? bytesField(1, plaintext) : plaintext) };
        const options = { key, sourceFlavor };
        const full = readLocalPbCandidate(candidate, options);
        assert.equal(full.coverage, undefined);
        assert.equal(full.partial, false);
        for (const stepRange of [{ startStep: 2, endStepExclusive: 4 }, { tailSteps: 2 }] satisfies LocalPbStepRangeRequest[]) {
            const selected = readLocalPbCandidate(candidate, { ...options, stepRange });
            const startStep = "tailSteps" in stepRange ? 4 : 2;
            assert.deepEqual(selected.trajectory.steps, full.trajectory.steps.slice(startStep, startStep + 2));
            assert.deepEqual(selected.coverage, { unit: "step", startStep, endStepExclusive: startStep + 2,
                totalSteps: 6, complete: false, encryptedEnvelopeVerified: true });
            assert.equal(selected.partial, true);
        }
        const complete = readLocalPbCandidate(candidate, { ...options, stepRange: { startStep: 0, endStepExclusive: 100 } });
        assert.deepEqual(complete.trajectory, full.trajectory);
        assert.equal(complete.coverage?.complete, true);
        assert.equal(complete.partial, false);
        const empty = readLocalPbCandidate(candidate, { ...options, stepRange: { startStep: 100 } });
        assert.equal(empty.trajectory.steps.length, 0);
        assert.equal(empty.coverage?.startStep, 6);
        assert.equal(empty.partial, true);
        passed++;
    }
}
const candidate = { kind: "active" as const, encrypted: encrypt(plaintext) };
const options = { key, sourceFlavor: "windsurf" as const };
for (const stepRange of [{ startStep: -1 }, { tailSteps: 0 }, { tailSteps: 1.5 }, { startStep: 4, endStepExclusive: 2 },
    { startStep: Number.NaN }, { startStep: 0, endStepExclusive: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => readLocalPbCandidate(candidate, { ...options, stepRange }),
        (error: unknown) => error instanceof LocalPbReaderError && error.code === "INVALID_RANGE");
}
const controller = new AbortController();
controller.abort();
assert.throws(() => readLocalPbCandidate(candidate, { ...options, signal: controller.signal }),
    (error: unknown) => error instanceof LocalPbReaderError && error.code === "CANCELLED");
assert.throws(() => readLocalPbCandidate(candidate, { ...options, deadlineMs: 0 }),
    (error: unknown) => error instanceof LocalPbReaderError && error.code === "DEADLINE_EXCEEDED");
let checks = 0;
assert.throws(() => readLocalPbCandidate(candidate, { ...options, isCancelled: () => ++checks >= 4 }),
    (error: unknown) => error instanceof LocalPbReaderError && error.code === "CANCELLED");
const malformedFirstStep = Buffer.concat([bytesField(1, "fictional-trajectory"), bytesField(2, Buffer.from([0])), bytesField(2, steps[1])]);
const malformedCandidate = { kind: "active" as const, encrypted: encrypt(malformedFirstStep) };
const lastStep = readLocalPbCandidate(malformedCandidate, { ...options, stepRange: { tailSteps: 1 } });
assert.equal(lastStep.trajectory.steps[0].index, 1);
assert.equal(lastStep.partial, true);
assert.throws(() => readLocalPbCandidate(malformedCandidate, options), LocalPbReaderError);
const corrupted = Buffer.from(candidate.encrypted);
corrupted[corrupted.length - 1] ^= 1;
assert.throws(() => readLocalPbCandidate({ ...candidate, encrypted: corrupted }, { ...options, stepRange: { tailSteps: 1 } }),
    (error: unknown) => error instanceof LocalPbReaderError && error.code === "AUTH_FAILED");
console.log(`PASS local PB range reader: ${passed} host/container matrices; bounds, cancellation, omitted malformed step, authentication`);
