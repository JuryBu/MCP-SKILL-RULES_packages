import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assertCodexHistorySource,
    parseCodexRolloutFilename,
    resolveCodexHistorySource,
    resolveCodexHistorySourceAsync,
} from "../src/codex-history-source.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const MID_LOGICAL = "22222222-2222-4222-8222-222222222222";
const MID_PHYSICAL = "33333333-3333-4333-8333-333333333333";
const LEAF = "44444444-4444-4444-8444-444444444444";
const LEAF_PHYSICAL = "55555555-5555-4555-8555-555555555555";
const FORK_LOGICAL = "66666666-6666-4666-8666-666666666666";
const FORK_PHYSICAL = "77777777-7777-4777-8777-777777777777";
const MISSING = "88888888-8888-4888-8888-888888888888";

function filename(threadId: string, rolloutId = threadId): string {
    const suffix = threadId === rolloutId ? threadId : `${threadId}_${rolloutId}`;
    return `rollout-2026-09-12T00-00-00-${suffix}.jsonl`;
}

function writeRollout(directory: string, threadId: string, rolloutId = threadId, historyBase?: Record<string, unknown>, entries = ["{\"type\":\"event\",\"value\":\"a\"}"]): { file: string; text: string; headerEnd: number } {
    const payload: Record<string, unknown> = { id: threadId, session_id: ROOT };
    if (historyBase !== undefined) payload.history_base = historyBase;
    const text = `${JSON.stringify({ type: "session_meta", payload })}\n${entries.join("\n")}\n`;
    const file = path.join(directory, filename(threadId, rolloutId));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, text);
    return { file, text, headerEnd: Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1)) };
}

function base(rolloutId: string, ordinal: number, endByte: number): Record<string, unknown> {
    return { thread_id: rolloutId, end_ordinal_exclusive: ordinal, end_byte_offset: endByte };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-source-test-"));
try {
    const parsedLegacy = parseCodexRolloutFilename(filename(ROOT));
    assert.deepEqual(parsedLegacy, { threadId: ROOT, rolloutId: ROOT });
    assert.deepEqual(parseCodexRolloutFilename(filename(MID_LOGICAL, MID_PHYSICAL)), { threadId: MID_LOGICAL, rolloutId: MID_PHYSICAL });
    assert.equal(parseCodexRolloutFilename("not-a-rollout.jsonl"), null);

    const noNewline = writeRollout(path.join(temp, "no-newline"), ROOT);
    fs.writeFileSync(noNewline.file, noNewline.text.trimEnd());
    const noNewlineSource = resolveCodexHistorySource(noNewline.file, { roots: [] });
    assert.equal(noNewlineSource.segments[0]!.endByte, Buffer.byteLength(noNewline.text.trimEnd()));
    assert.equal(noNewlineSource.segments[0]!.unterminatedLeaf, true);
    assertCodexHistorySource(noNewlineSource);
    assert.equal((await resolveCodexHistorySourceAsync(noNewline.file, { roots: [] })).revision, noNewlineSource.revision);
    if (process.platform === "win32") {
        const namespaced = resolveCodexHistorySource(path.toNamespacedPath(noNewline.file), { roots: [temp, path.toNamespacedPath(temp)] });
        assert.equal(namespaced.revision, noNewlineSource.revision);
    }

    const root = writeRollout(path.join(temp, "chain"), ROOT, ROOT, undefined, ["{\"type\":\"event\",\"value\":\"one\"}", "{\"type\":\"event\",\"value\":\"two\"}"]);
    const rootCut = Buffer.byteLength(root.text.slice(0, root.text.indexOf("\n", root.headerEnd) + 1));
    const middle = writeRollout(path.join(temp, "chain"), MID_LOGICAL, MID_PHYSICAL, base(ROOT, 2, rootCut), ["{\"type\":\"event\",\"value\":\"mid\"}", "{\"type\":\"event\",\"value\":\"old-tail\"}"]);
    const middleCut = Buffer.byteLength(middle.text.slice(0, middle.text.indexOf("\n", middle.headerEnd) + 1));
    const leaf = writeRollout(path.join(temp, "chain"), LEAF, LEAF_PHYSICAL, base(MID_PHYSICAL, 3, middleCut));
    const source = resolveCodexHistorySource(leaf.file, { roots: [path.join(temp, "chain")] });
    assert.deepEqual(source.segments.map(segment => [segment.rolloutId, segment.threadId, segment.startOrdinal, segment.endOrdinalExclusive, segment.endByte]), [
        [ROOT, ROOT, 0, 2, rootCut],
        [MID_PHYSICAL, MID_LOGICAL, 2, 3, middleCut],
        [LEAF_PHYSICAL, LEAF, 3, undefined, Buffer.byteLength(leaf.text)],
    ]);
    assert.equal(source.totalBytes, rootCut + middleCut + Buffer.byteLength(leaf.text));
    assertCodexHistorySource(source);
    const asyncSource = await resolveCodexHistorySourceAsync(leaf.file, { roots: [path.join(temp, "chain")] });
    assert.equal(asyncSource.revision, source.revision);
    if (process.platform === "win32") {
        const directory = path.join(temp, "chain");
        const namespaced = resolveCodexHistorySource(path.toNamespacedPath(leaf.file), { roots: [directory, path.toNamespacedPath(directory)] });
        assert.equal(namespaced.revision, source.revision);
    }

    const fork = writeRollout(path.join(temp, "fork"), FORK_LOGICAL, FORK_PHYSICAL, base(ROOT, 1, rootCut));
    const forkSource = resolveCodexHistorySource(fork.file, { roots: [path.join(temp, "chain")] });
    assert.equal(forkSource.segments[0]!.threadId, ROOT);
    assert.equal(forkSource.segments[1]!.threadId, FORK_LOGICAL);
    assert.equal(forkSource.segments[0]!.rolloutId, ROOT);

    const ancestorRevision = source.revision;
    fs.appendFileSync(root.file, "{\"type\":\"event\",\"value\":\"ignored-append\"}\n");
    assert.equal(resolveCodexHistorySource(leaf.file, { roots: [path.join(temp, "chain")] }).revision, ancestorRevision, "append after selected ancestor prefix must not change revision");
    assertCodexHistorySource(source);

    const fixed = writeRollout(path.join(temp, "fixed"), ROOT, ROOT, undefined, ["{\"type\":\"event\",\"value\":\"fixed\"}", "{\"type\":\"event\",\"value\":\"tail\"}"]);
    const fixedEnd = Buffer.byteLength(fixed.text.slice(0, fixed.text.indexOf("\n", fixed.headerEnd) + 1));
    const fixedSource = resolveCodexHistorySource(fixed.file, { roots: [path.join(temp, "fixed")], endByte: fixedEnd });
    fs.appendFileSync(fixed.file, "{\"type\":\"event\",\"value\":\"later\"}\n");
    assertCodexHistorySource(fixedSource);

    const partialLeaf = writeRollout(path.join(temp, "partial-leaf"), ROOT, ROOT);
    fs.appendFileSync(partialLeaf.file, "{\"type\":\"event\",\"value\":\"still-writing\"");
    const partialSource = resolveCodexHistorySource(partialLeaf.file, { roots: [path.join(temp, "partial-leaf")] });
    assert.equal(partialSource.segments[0]!.endByte, Buffer.byteLength(partialLeaf.text), "default leaf source must omit an unfinished final JSONL line");
    assert.ok(partialSource.segments[0]!.size > partialSource.segments[0]!.endByte, "leaf stat must retain the writer's actual size");
    assertCodexHistorySource(partialSource);

    const empty = writeRollout(path.join(temp, "empty"), LEAF, LEAF_PHYSICAL, base(MISSING, 0, 0));
    assert.equal(resolveCodexHistorySource(empty.file, { roots: [path.join(temp, "empty")] }).segments.length, 1);
    const invalidEmpty = writeRollout(path.join(temp, "invalid-empty"), LEAF, LEAF_PHYSICAL, base(MISSING, 1, 0));
    assert.throws(() => resolveCodexHistorySource(invalidEmpty.file, { roots: [path.join(temp, "invalid-empty")] }), /Zero-length/);

    const missing = writeRollout(path.join(temp, "missing"), LEAF, LEAF_PHYSICAL, base(MISSING, 1, 1));
    assert.throws(() => resolveCodexHistorySource(missing.file, { roots: [path.join(temp, "missing")] }), /Missing/);
    const duplicateRootA = writeRollout(path.join(temp, "duplicate-a"), ROOT);
    writeRollout(path.join(temp, "duplicate-b"), ROOT);
    const duplicateLeaf = writeRollout(path.join(temp, "duplicate-leaf"), LEAF, LEAF_PHYSICAL, base(ROOT, 1, duplicateRootA.headerEnd));
    assert.throws(() => resolveCodexHistorySource(duplicateLeaf.file, { roots: [path.join(temp, "duplicate-a"), path.join(temp, "duplicate-b")] }), /Ambiguous/);

    const cycleDirectory = path.join(temp, "cycle");
    const headerLength = (threadId: string, rolloutId: string, historyBase: Record<string, unknown>) => Buffer.byteLength(`${JSON.stringify({ type: "session_meta", payload: { id: threadId, session_id: ROOT, history_base: historyBase } })}\n`);
    let cycleAEnd = 100;
    let cycleBEnd = 100;
    for (let index = 0; index < 4; index += 1) {
        cycleAEnd = headerLength(ROOT, ROOT, base(MID_PHYSICAL, 1, cycleBEnd));
        cycleBEnd = headerLength(MID_LOGICAL, MID_PHYSICAL, base(ROOT, 1, cycleAEnd));
    }
    const cycleA = writeRollout(cycleDirectory, ROOT, ROOT, base(MID_PHYSICAL, 1, cycleBEnd));
    const cycleB = writeRollout(cycleDirectory, MID_LOGICAL, MID_PHYSICAL, base(ROOT, 1, cycleAEnd));
    assert.equal(cycleA.headerEnd, cycleAEnd);
    assert.equal(cycleB.headerEnd, cycleBEnd);
    assert.throws(() => resolveCodexHistorySource(cycleA.file, { roots: [path.dirname(cycleA.file)] }), /Circular/);
    assert.ok(cycleB.file);

    const invalidBoundaryRoot = writeRollout(path.join(temp, "boundary"), ROOT);
    const nonLineBoundary = invalidBoundaryRoot.headerEnd + 1;
    const invalidBoundaryLeaf = writeRollout(path.join(temp, "boundary"), LEAF, LEAF_PHYSICAL, base(ROOT, 1, nonLineBoundary));
    assert.throws(() => resolveCodexHistorySource(invalidBoundaryLeaf.file, { roots: [path.dirname(invalidBoundaryLeaf.file)] }), /complete JSONL line/);
    const overflowLeaf = writeRollout(path.join(temp, "overflow"), LEAF, LEAF_PHYSICAL, base(ROOT, 1, 999999));
    fs.copyFileSync(invalidBoundaryRoot.file, path.join(path.dirname(overflowLeaf.file), filename(ROOT)));
    assert.throws(() => resolveCodexHistorySource(overflowLeaf.file, { roots: [path.dirname(overflowLeaf.file)] }), /exceeds source size/);

    const oversizedPayload = { id: ROOT, session_id: ROOT, dynamic_tools: "x".repeat(70 * 1024) };
    const oversizedFile = path.join(temp, "oversized", filename(ROOT));
    fs.mkdirSync(path.dirname(oversizedFile), { recursive: true });
    fs.writeFileSync(oversizedFile, `${JSON.stringify({ type: "session_meta", payload: oversizedPayload })}\n{\"type\":\"event\"}\n`);
    assert.equal(resolveCodexHistorySource(oversizedFile, { roots: [path.dirname(oversizedFile)] }).segments[0]!.headerSha256.length, 64);

    const mutable = writeRollout(path.join(temp, "mutable"), ROOT, ROOT, undefined, ["{\"type\":\"event\",\"value\":\"alpha\"}"]);
    const mutableSource = resolveCodexHistorySource(mutable.file, { roots: [path.dirname(mutable.file)] });
    fs.writeFileSync(mutable.file, mutable.text.replace("alpha", "omega"));
    assert.throws(() => assertCodexHistorySource(mutableSource), /boundary changed/);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}

console.log("codex-history-source tests passed");
