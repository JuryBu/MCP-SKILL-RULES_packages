import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { deepLocateClaudeCodeConversations, matchClaudeCodeContextProbeInJsonl, matchClaudeCodeContextProbeInJsonlAsync } from "../src/claude-code-client.ts";

const marker = "synthetic context probe marker plan63";
const event = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

function fixture(context: TestContext, text: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan63-log-probe-"));
    const filename = path.join(root, "synthetic.jsonl");
    fs.writeFileSync(filename, text);
    context.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
    return filename;
}

test("Claude Code asynchronous probe preserves the synchronous API and marks tail-relative rounds", async context => {
    const filename = fixture(context, event("padding ".repeat(100)) + event(marker));
    assert.equal(matchClaudeCodeContextProbeInJsonl(filename, marker).length, 1);
    const result = await matchClaudeCodeContextProbeInJsonlAsync(filename, marker, { maxBytes: 256 });
    assert.equal(result.hits.length, 1);
    assert.ok(result.scannedBytes <= 256);
    assert.equal(result.partial, true);
    assert.equal(result.roundNumbering, "relative");
});

test("Claude Code probe deadline retains already confirmed hits and reports actual reads", async context => {
    const filename = fixture(context, event(marker) + event("padding ".repeat(100)).repeat(1800));
    const original = Date.now;
    let expired = false;
    Date.now = () => expired ? 1001 : 0;
    try {
        const result = await matchClaudeCodeContextProbeInJsonlAsync(filename, marker, { deadlineAt: 1000, deadlineMs: 1000, maxBytes: 4 * 1024 * 1024,
            onProgress: bytes => { if (bytes > 1024 * 1024) expired = true; } });
        assert.equal(result.hits.length, 1);
        assert.equal(result.partial, true);
        assert.ok(result.scannedBytes > 1024 * 1024);
        assert.ok(result.warnings.some(warning => warning.includes("deadline")));
    } finally { Date.now = original; }
});

test("Claude Code explicit cancellation closes the probe and later requests work", async context => {
    const filename = fixture(context, event(marker));
    let cancelled = false;
    await assert.rejects(matchClaudeCodeContextProbeInJsonlAsync(filename, marker, { isCancelled: () => cancelled, onProgress: () => { cancelled = true; } }), error => (error as Error).name === "AbortError");
    assert.equal((await matchClaudeCodeContextProbeInJsonlAsync(filename, marker)).hits.length, 1);
    const expired = await matchClaudeCodeContextProbeInJsonlAsync(filename, marker, { deadlineMs: 0 });
    assert.equal(expired.partial, true);
    assert.equal(expired.scannedBytes, 0);
});

test("Claude Code probe discards hits if its source changes during reading", async context => {
    const filename = fixture(context, event(marker));
    let rewritten = false;
    const result = await matchClaudeCodeContextProbeInJsonlAsync(filename, marker, { onProgress: () => {
        if (!rewritten) { rewritten = true; fs.appendFileSync(filename, " "); }
    } });
    assert.equal(result.hits.length, 0);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.includes("claude_probe_source_changed"));
});

test("Claude Code context probes share punctuation-insensitive matching while deep exact stays literal", async context => {
    const original = "Alpha ＢＥＴＡ，主人确认顺序。\n再检查取消与恢复";
    const reformatted = "alpha beta。主人确认顺序，再检查取消与恢复";
    const filename = fixture(context, event(original));
    const synchronous = matchClaudeCodeContextProbeInJsonl(filename, reformatted);
    const asynchronous = await matchClaudeCodeContextProbeInJsonlAsync(filename, reformatted);
    assert.equal(synchronous.length, 1);
    assert.equal(asynchronous.hits.length, 1);
    assert.equal(synchronous[0]!.snippet, original);
    assert.equal(asynchronous.hits[0]!.snippet, original);
    for (const changed of ["alpha beta。主人确认额外顺序，再检查取消与恢复", "alpha beta。主人确认，再检查取消与恢复"]) {
        assert.equal(matchClaudeCodeContextProbeInJsonl(filename, changed).length, 0);
        assert.equal((await matchClaudeCodeContextProbeInJsonlAsync(filename, changed)).hits.length, 0);
    }
    const deep = deepLocateClaudeCodeConversations(reformatted, [{ id: "synthetic-deep-exact", jsonlPath: filename, cwd: path.dirname(filename),
        source: "claude-code", title: "Synthetic exact fixture" }], { mode: "exact", maxFiles: 1, maxBytes: 64 * 1024 });
    assert.equal(deep.hits.length, 0);
});
