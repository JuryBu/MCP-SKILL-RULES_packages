import assert from "node:assert/strict";
import test from "node:test";
import { isPreviousBootZeroRecord } from "../mcps/sandbox/src/tools/launch-record-compat.ts";

const boot = 1_000_000;
const old = { mtimeMs: 100_000, birthtimeMs: 100_000 };
const zeros = Buffer.alloc(1024);

test("only nonempty all-zero records with both timestamps safely before boot are historical", () => {
    assert.equal(isPreviousBootZeroRecord(zeros, old, boot), true);
    assert.equal(isPreviousBootZeroRecord(Buffer.alloc(0), old, boot), false);
    assert.equal(isPreviousBootZeroRecord(Buffer.from("{broken"), old, boot), false);
    const nonzero = Buffer.from(zeros);
    nonzero[nonzero.length - 1] = 1;
    assert.equal(isPreviousBootZeroRecord(nonzero, old, boot), false);
});

test("current-boot corruption and restored old mtime do not bypass recovery", () => {
    assert.equal(isPreviousBootZeroRecord(zeros, { ...old, mtimeMs: boot + 1 }, boot), false);
    assert.equal(isPreviousBootZeroRecord(zeros, { ...old, birthtimeMs: boot + 1 }, boot), false);
    assert.equal(isPreviousBootZeroRecord(zeros, { ...old, mtimeMs: boot - 60_000 }, boot), false);
    assert.equal(isPreviousBootZeroRecord(zeros, { ...old, birthtimeMs: boot - 60_000 }, boot), false);
});

test("missing, nonfinite and invalid timestamp evidence fails closed", () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
        assert.equal(isPreviousBootZeroRecord(zeros, { ...old, mtimeMs: invalid }, boot), false);
        assert.equal(isPreviousBootZeroRecord(zeros, { ...old, birthtimeMs: invalid }, boot), false);
    }
    assert.equal(isPreviousBootZeroRecord(zeros, old, NaN), false);
    assert.equal(isPreviousBootZeroRecord(zeros, old, Infinity), false);
});
