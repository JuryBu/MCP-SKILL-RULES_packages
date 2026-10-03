import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureCodexSourceVersionAsync, inspectCodexSourceVersionAsync } from "../src/codex-client.ts";
import { assertCodexHistoryManifest } from "../src/codex-history-source.ts";
import { createCodexFetchWorkerPayload } from "../src/conversation-fetch-worker-client.ts";
import { isCodexFetchWorkerPayload } from "../src/conversation-fetch-worker-types.ts";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-inspection-"));
const conversationId = "11111111-1111-4111-8111-111111111111";
const sourcePath = path.join(temporaryRoot, `rollout-2026-10-04T00-00-00-${conversationId}.jsonl`);
const originalOpen = fs.promises.open;
let inspectedBytes = 0;
try {
    fs.writeFileSync(sourcePath, [
        JSON.stringify({ type: "session_meta", payload: { id: conversationId } }),
        JSON.stringify({ type: "event", value: "body".repeat(2 * 1024 * 1024) }),
        JSON.stringify({ type: "event", value: "tail" }),
        "",
    ].join("\n"));
    fs.promises.open = (async (...argumentsList: Parameters<typeof originalOpen>) => {
        const handle = await originalOpen(...argumentsList);
        const originalRead = handle.read.bind(handle);
        handle.read = (async (...readArguments: unknown[]) => {
            const result = await (originalRead as (...values: unknown[]) => Promise<{ bytesRead: number }>)(...readArguments);
            inspectedBytes += result.bytesRead;
            return result;
        }) as typeof handle.read;
        return handle;
    }) as typeof originalOpen;
    const inspected = await inspectCodexSourceVersionAsync(sourcePath);
    fs.promises.open = originalOpen;
    assert.ok(inspected.historySource);
    assert.equal(inspected.historySource.segments.length, 1);
    assert.equal(inspected.historySource.totalBytes, fs.statSync(sourcePath).size);
    assert.ok(inspectedBytes < 256 * 1024, `lightweight inspection read ${inspectedBytes} bytes`);
    assert.equal(inspected.historySource.segments[0]?.prefixSha256, undefined);
    assert.throws(() => assertCodexHistoryManifest(inspected.historySource!), /content-verified cache rebuild/);
    const verified = await captureCodexSourceVersionAsync(sourcePath);
    assertCodexHistoryManifest(verified.historySource!);
    assert.match(verified.historySource!.segments[0]!.prefixSha256!, /^[a-f0-9]{64}$/u);
    const payload = createCodexFetchWorkerPayload({
        conversationId, link: "summary", source: "auto", modelChain: "grok",
        estimate: { ...inspected, verificationDeferred: true, thresholdBytes: 1, shouldBackground: true },
    });
    assert.equal(payload.version, 2);
    assert.equal(payload.verificationDeferred, true);
    assert.equal(isCodexFetchWorkerPayload(payload), true);
    assert.equal(isCodexFetchWorkerPayload({ ...payload, verificationDeferred: false }), false);
    assert.equal(createCodexFetchWorkerPayload({
        conversationId, link: "summary", source: "auto", modelChain: "grok",
        estimate: { ...verified, thresholdBytes: 1, shouldBackground: true },
    }).version, 1);
    console.log(`PASS codex-source-inspection: ${inspectedBytes} metadata bytes; strict SHA and v1/v2 payload boundaries`);
} finally {
    fs.promises.open = originalOpen;
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
