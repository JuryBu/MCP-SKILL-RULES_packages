import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_JSONL_COMPACTION_RECORD_BYTES, CODEX_JSONL_DEFAULT_RECORD_BYTES, codexJsonlRecordByteLimit, codexJsonlRecordExceedsLimit } from "../src/codex-jsonl-record-limit.ts";

test("only an actual bounded compaction envelope gets the separate snapshot limit", () => {
    for (const prefix of [
        '{"timestamp":"2026-01-01T00:00:00Z","ordinal":1,"type":"compacted","payload":',
        '{"type":"compacted", "payload" :',
    ]) assert.equal(codexJsonlRecordByteLimit(Buffer.from(prefix)), CODEX_JSONL_COMPACTION_RECORD_BYTES);
    for (const prefix of [
        '{"type":"session_meta","payload":',
        '{"type":"response_item","payload":{"type":"compacted"}}',
        '{"type":"response_item","text":"compacted","payload":',
        '{"type":"compacted","unclosed":{"payload":',
        '{"type":"compacted","text":"escaped \",\\\"payload\\\": marker","payloadBad":',
        '{"type":"compacted"',
        '',
    ]) assert.equal(codexJsonlRecordByteLimit(prefix), CODEX_JSONL_DEFAULT_RECORD_BYTES);
});

test("ordinary records retain the default cap, snapshots remain bounded and UTF-8 bytes count", () => {
    const ordinary = Buffer.alloc(CODEX_JSONL_DEFAULT_RECORD_BYTES + 1, 32);
    ordinary.write('{"type":"response_item","payload":');
    assert.equal(codexJsonlRecordExceedsLimit(ordinary), true);
    ordinary.write('{"type":"compacted","payload":');
    assert.equal(codexJsonlRecordExceedsLimit(ordinary), false);
    assert.equal(codexJsonlRecordExceedsLimit(new Uint8Array(CODEX_JSONL_COMPACTION_RECORD_BYTES + 1)), true);
    const compaction = '{"type":"compacted","payload":"' + '界'.repeat(45 * 1024 * 1024) + '"}';
    assert.ok(compaction.length < CODEX_JSONL_DEFAULT_RECORD_BYTES);
    assert.equal(codexJsonlRecordExceedsLimit(compaction), true);
    assert.equal(codexJsonlRecordByteLimit('{"type":"compacted","padding":"' + 'x'.repeat(5000) + '","payload":'), CODEX_JSONL_DEFAULT_RECORD_BYTES);
});
