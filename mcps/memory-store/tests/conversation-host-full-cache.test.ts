import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const large = process.argv[2] === "large";
const nativeParse = JSON.parse;
JSON.parse = ((value: string, ...args: unknown[]) => {
    const tracked = typeof value === "string" && value.length > 1024 * 1024 && value.startsWith('{"format":"host-file-cache/v1"');
    if (tracked) console.log(JSON.stringify({ stage: "cache-json-parse-start", chars: value.length, memory: process.memoryUsage() }));
    const result = Reflect.apply(nativeParse, JSON, [value, ...args]);
    if (tracked) console.log(JSON.stringify({ stage: "cache-json-parse-done", memory: process.memoryUsage() }));
    return result;
}) as typeof JSON.parse;
const root = await mkdtemp(path.join(os.tmpdir(), "plan61-cold-window-full-cache-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const filename = path.join(root, "session.jsonl");
const cacheRoot = path.join(root, "cache");
const id = "controlled-claude";
const options = { cacheRoot, ...(large ? { cacheMaxBytes: 256 * 1024 * 1024 } : {}),
    claudeThreads: () => [{ id, jsonlPath: filename, source: "claude-code" as const, title: "controlled long fixture", cwd: root }] };
const control = { messageRoles: ["user", "assistant", "tool", "subagent"] as ("user" | "assistant" | "tool" | "subagent")[] };
const payload = "正文完整保留-" + "abcdefghijklmno".repeat(1093);
const line = (value: unknown) => JSON.stringify(value) + "\n";
const roundText = (round: number) => line({ type: "user", message: { id: `user-${round}`, role: "user", source: { kind: "user" },
    content: [{ type: "text", text: `question-${round}` }, { type: "image", path: "fixture.png", mime_type: "image/png" }], annotations: [{ selectedText: "question", comment: `note-${round}` }] } })
    + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer-${round}-${payload}` }, { type: "tool_use", id: `call-${round}`, name: "read", input: { path: "fixture.txt" } }] } })
    + line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${round}`, content: `result-${round}` }] } });
const hashFile = async (source: string) => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(source)) hash.update(bytes);
    return hash.digest("hex");
};
const contentHash = (rounds: any[]) => {
    const hash = createHash("sha256");
    for (const round of rounds) hash.update(JSON.stringify({ user: round.userMessage,
        users: round.userMessages?.map(({ stepIndex: _stepIndex, ...message }: any) => ({ ...message, attachments: message.attachments?.map(({ stepIndex: _attachmentStep, ...attachment }: any) => attachment) })),
        answers: round.aiResponses.map((answer: any) => answer.response), tools: round.toolCalls.map((tool: any) => ({ name: tool.name, args: tool.argsFull, result: tool.resultFull })) }));
    return hash.digest("hex");
};
const snapshot = (projection: any) => ({ revision: projection.revision, complete: projection.complete, totalRounds: projection.totalRounds,
    roundsHash: contentHash(projection.rounds), prefixHash: contentHash(projection.rounds.slice(0, 4096)),
    firstHash: contentHash(projection.rounds.slice(0, 2)), lastHash: contentHash(projection.rounds.slice(-2)),
    messages: projection.messages.length, warnings: projection.warnings, timings: projection.timings });

try {
    const handle = await open(filename, "w");
    try {
        for (let first = 1; first <= 4096; first += 32) await handle.write(Array.from({ length: 32 }, (_, index) => roundText(first + index)).join(""));
    } finally { await handle.close(); }
    const sourceBytes = (await stat(filename)).size;
    assert.equal(sourceBytes, 69575099);
    const beforeHash = await hashFile(filename);
    const provider = createHostCorpusProvider("claude-code", options);
    const conversation = (await provider.list({ conversationIds: [id] }, {}))[0];
    const cold = await provider.readFast(conversation, { lastRounds: 2 }, control);
    const windowHash = contentHash(cold.rounds!);
    const warmWindow = await createHostCorpusProvider("claude-code", options).readFast(conversation, { lastRounds: 2 }, control);
    assert.equal(warmWindow.timings?.cacheHit, 1);
    const oldest = await provider.readFast(conversation, { startRound: 1, endRound: 2 }, control);
    const oldestHash = contentHash(oldest.rounds!);
    const stages: string[] = [];
    const started = performance.now();
    const full = await (async () => snapshot(await provider.read(conversation, { ...control, onProgress: progress => {
        if (!stages.includes(progress.phase)) { stages.push(progress.phase); console.log(JSON.stringify({ stage: progress.phase, mode: large ? "large" : "default", memory: process.memoryUsage() })); }
    } })))();
    const fullMs = performance.now() - started;
    console.log(JSON.stringify({ stage: "full-provider-returned", fullMs, memory: process.memoryUsage() }));
    assert.equal(full.complete, true);
    assert.equal(full.totalRounds, 4096);
    assert.equal(full.revision, cold.revision);
    assert.equal(full.firstHash, oldestHash);
    assert.equal(full.lastHash, windowHash);
    assert.ok(full.messages >= 4096 * 3);
    assert.equal(await hashFile(filename), beforeHash);
    const files = await readdir(cacheRoot);
    const completeFiles = files.filter(name => name.endsWith(".json") && !name.endsWith(".window.json"));
    let cacheBytes = 0;
    let cacheSha256: string | undefined;
    let reopenedSummary: ReturnType<typeof snapshot> | undefined;
    let appendSummary: ReturnType<typeof snapshot> | undefined;
    if (large) {
        assert.equal(completeFiles.length, 1);
        const cachePath = path.join(cacheRoot, completeFiles[0]);
        cacheBytes = (await stat(cachePath)).size;
        assert.ok(cacheBytes > 64 * 1024 * 1024 && cacheBytes <= 256 * 1024 * 1024);
        cacheSha256 = await hashFile(cachePath);
        console.log(JSON.stringify({ stage: "full-cache-persisted", cacheBytes, cacheSha256, memory: process.memoryUsage() }));
        const reopened = createHostCorpusProvider("claude-code", options);
        reopenedSummary = await (async () => snapshot(await reopened.read(conversation, control)))();
        console.log(JSON.stringify({ stage: "full-cache-reopened", memory: process.memoryUsage() }));
        assert.equal(reopenedSummary.complete, true);
        assert.equal(reopenedSummary.roundsHash, full.roundsHash);
        assert.equal(reopenedSummary.revision, full.revision);
        assert.equal(reopenedSummary.timings.cacheHit, 1);
        assert.equal(reopenedSummary.timings.parsedBytes, 0);
        await appendFile(filename, roundText(4097));
        appendSummary = await (async () => snapshot(await reopened.read(conversation, control)))();
        console.log(JSON.stringify({ stage: "full-cache-appended", memory: process.memoryUsage() }));
        assert.equal(appendSummary.complete, true);
        assert.equal(appendSummary.totalRounds, 4097);
        assert.equal(appendSummary.prefixHash, full.roundsHash);
        assert.notEqual(appendSummary.revision, full.revision);
        assert.equal(appendSummary.timings.append, 1);
        assert.ok(appendSummary.timings.parsedBytes < sourceBytes / 100);
    } else {
        assert.equal(completeFiles.length, 0);
        assert.ok(full.warnings.includes("host_persistent_cache_budget_exceeded"));
    }
    assert.deepEqual((await readdir(cacheRoot)).filter(name => name.endsWith(".tmp")), []);
    console.log(JSON.stringify({ test: "host-full-provider-cache", mode: large ? "large" : "default", sourceBytes, beforeHash,
        afterUnchangedHash: beforeHash, fullMs, cacheBytes, cacheSha256, full, reopened: reopenedSummary, appended: appendSummary,
        peakRssBytes: process.resourceUsage().maxRSS * 1024, heapLimit: (await import("node:v8")).getHeapStatistics().heap_size_limit }));
} finally {
    JSON.parse = nativeParse;
    await rm(root, { recursive: true, force: true });
}
