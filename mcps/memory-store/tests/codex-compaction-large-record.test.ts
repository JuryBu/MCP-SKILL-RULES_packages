import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { zstdCompressSync } from "node:zlib";
import { buildCodexRoundsFromHistoryAsync, buildCodexRoundsFromRolloutForTest, readRolloutEvents } from "../src/codex-client.ts";
import { resolveCodexHistorySourceAsync, resolveCodexStreamingHistorySource, scanCodexStreamingHistory } from "../src/codex-history-source.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-large-compaction-"));
const id = "10000000-0000-4000-8000-000000000099";
const rollout = path.join(temporary, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
const mebibyte = 1024 * 1024;
const payloadBytes = 65 * mebibyte;
const header = JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id, source: "cli" } }) + "\n";
const tail = [
    { ordinal: 2, type: "event_msg", payload: { type: "user_message", message: "visible human after compaction" } },
    { ordinal: 3, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer after compaction" }] } },
].map(event => JSON.stringify(event)).join("\n") + "\n";

function writeFixture(options: { type?: string; bytes?: number; invalidJson?: boolean; invalidUtf8?: boolean; headerType?: string; utf8?: boolean; finalType?: string } = {}): void {
    const descriptor = fs.openSync(rollout, "w");
    const prefix = JSON.stringify({ ordinal: 1, type: options.type ?? "compacted" }).slice(0, -1) + ',"payload":{"replacement_history":[{"role":"assistant","content":[{"type":"output_text","text":"';
    try {
        if (!options.headerType) fs.writeSync(descriptor, header);
        fs.writeSync(descriptor, options.headerType ? prefix.replace('"compacted"', JSON.stringify(options.headerType)) : prefix);
        let remaining = options.bytes ?? payloadBytes;
        const chunk = options.utf8 ? Buffer.from("界".repeat(Math.floor(mebibyte / 3))) : Buffer.alloc(mebibyte, "x");
        while (remaining > 0) {
            const length = Math.min(chunk.length, remaining);
            fs.writeSync(descriptor, chunk.subarray(0, length));
            remaining -= length;
        }
        if (options.invalidUtf8) fs.writeSync(descriptor, Buffer.from([0xff]));
        fs.writeSync(descriptor, options.invalidJson ? '"}]}]}\n' : '"}]}]}' + (options.finalType ? ',"type":' + JSON.stringify(options.finalType) : "") + '}\n');
        if (!options.headerType) fs.writeSync(descriptor, tail);
    } finally {
        fs.closeSync(descriptor);
    }
}

function sha256(file: string): string {
    const descriptor = fs.openSync(file, "r");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(mebibyte);
    try {
        for (let length = fs.readSync(descriptor, chunk); length > 0; length = fs.readSync(descriptor, chunk)) hash.update(chunk.subarray(0, length));
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest("hex");
}

async function verifyStreaming(file = rollout, decoder: "auto" | "fzstd" = "auto"): Promise<void> {
    const source = await resolveCodexStreamingHistorySource(file, { roots: [temporary], archive: { decoder } });
    const ordinals: number[] = [];
    let parsedPayload = false;
    const started = performance.now();
    const verified = await scanCodexStreamingHistory(source, (event, position) => {
        ordinals.push(position.ordinal);
        if (event.type === "compacted") {
            const text = event.payload.replacement_history[0].content[0].text;
            assert.equal(text.length, payloadBytes);
            assert.equal(text.at(-1), "x");
            parsedPayload = true;
        }
    }, { archive: { decoder } });
    assert.equal(parsedPayload, true);
    assert.deepEqual(ordinals, [0, 1, 2, 3]);
    assert.equal(verified.segments[0].nextOrdinal, 4);
    if (file === rollout) assert.equal(verified.segments[0].prefixSha256, sha256(rollout));
    console.log(JSON.stringify({ phase: `stream-${decoder}-${file.endsWith(".zst") ? "compressed" : "plain"}`, ms: performance.now() - started, sourceBytes: verified.sourceBytes, maxRssKB: process.resourceUsage().maxRSS }));
}

try {
    writeFixture();
    assert.ok(fs.statSync(rollout).size > 64 * mebibyte);
    await verifyStreaming();
    let syncPayload = false;
    readRolloutEvents(rollout, { strict: true, expectedPrefixSha256: sha256(rollout), onEvent: event => {
        if (event.type === "compacted") {
            assert.equal(event.payload.replacement_history[0].content[0].text.length, payloadBytes);
            syncPayload = true;
        }
    } });
    assert.equal(syncPayload, true);
    const history = await resolveCodexHistorySourceAsync(rollout, { roots: [temporary] });
    const built = await buildCodexRoundsFromHistoryAsync(history, "summary");
    assert.equal(built.totalSteps, 4);
    assert.equal(built.rounds[0].userMessage, "visible human after compaction");
    console.log(JSON.stringify({ phase: "strict-client-sync-async-full-parse", bytes: fs.statSync(rollout).size, maxRssKB: process.resourceUsage().maxRSS }));

    fs.writeFileSync(`${rollout}.zst`, zstdCompressSync(fs.readFileSync(rollout)));
    await verifyStreaming(`${rollout}.zst`);
    await verifyStreaming(`${rollout}.zst`, "fzstd");
    fs.unlinkSync(`${rollout}.zst`);

    for (const options of [{ type: "response_item" }, { type: "unknown" }, { bytes: 129 * mebibyte }, { invalidJson: true }, { invalidUtf8: true }, { utf8: true, type: "response_item", bytes: 66 * mebibyte }, { finalType: "response_item" }]) {
        writeFixture(options);
        const source = await resolveCodexStreamingHistorySource(rollout, { roots: [temporary] });
        await assert.rejects(() => scanCodexStreamingHistory(source, () => {}), /safe read limit|Invalid Codex history JSON/u);
        if (options.bytes !== 129 * mebibyte) {
            assert.throws(() => readRolloutEvents(rollout, { strict: true }), /safe read limit|invalid JSON|encoded data/u);
            const history = await resolveCodexHistorySourceAsync(rollout, { roots: [temporary] });
            await assert.rejects(() => buildCodexRoundsFromHistoryAsync(history, "summary"), /safe read limit|invalid JSON|encoded data/u);
        }
    }

    writeFixture({ headerType: "session_meta" });
    await assert.rejects(() => resolveCodexStreamingHistorySource(rollout, { roots: [temporary] }), /header exceeds/u);
    assert.throws(() => readRolloutEvents(rollout, { strict: true }), /safe read limit/u);

    writeFixture({ bytes: 6000 });
    await assert.rejects(() => buildCodexRoundsFromRolloutForTest(rollout, "summary", { strict: true, maxLineChars: 4096 }), /safe read limit/u);
    const clientUrl = new URL("../src/codex-client.ts", import.meta.url).href;
    const sourceUrl = new URL("../src/codex-history-source.ts", import.meta.url).href;
    const customProbe = `import assert from 'node:assert/strict'; const client=await import(${JSON.stringify(clientUrl)}); const source=await import(${JSON.stringify(sourceUrl)}); const file=process.argv[1]; assert.throws(()=>client.readRolloutEvents(file,{strict:true}),/safe read limit/); const history=await source.resolveCodexHistorySourceAsync(file,{roots:[${JSON.stringify(temporary)}]}); await assert.rejects(()=>client.buildCodexRoundsFromHistoryAsync(history,'summary'),/safe read limit/); console.log('custom maxLineChars 4096 retained: PASS');`;
    console.log(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", customProbe, rollout], { encoding: "utf8", env: { ...process.env, MEMORY_STORE_CODEX_JSONL_MAX_LINE_CHARS: "4096" } }).trim());
    console.log(JSON.stringify({ phase: "large-compaction-all-checks-pass", maxRssKB: process.resourceUsage().maxRSS }));
} finally {
    fs.rmSync(temporary, { recursive: true });
    assert.equal(fs.existsSync(temporary), false);
}
