import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-corpus-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const { readClaudeCodeRoundTail } = await import("../src/claude-code-client.ts");
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string) => line({ type: "assistant", message: { role: "assistant", content: text } });

try {
    const filename = path.join(root, "session.jsonl");
    await writeFile(filename, Array.from({ length: 180 }, (_, index) => user(`user-${index + 1}-${"u".repeat(700)}`) + assistant(`answer-${index + 1}-${"a".repeat(700)}`)).join(""));
    const thread = { id: "fixture-cc", jsonlPath: filename, source: "claude-code" as const, title: "fixture", cwd: root };
    const cacheRoot = path.join(root, "cache");
    const options = { cacheRoot, claudeThreads: () => [thread] };
    const provider = createHostCorpusProvider("claude-code", options);
    const conversation = (await provider.list({}, {}))[0];
    const cold = await provider.readFast(conversation, { lastRounds: 2 });
    assert.deepEqual(cold.rounds?.map(round => round.roundIndex), [179, 180]);
    assert.equal(cold.totalRounds, 180);
    assert.equal(cold.roundNumbering, "absolute");
    assert.equal(cold.requestedRangeComplete, true);
    const reopened = createHostCorpusProvider("claude-code", options);
    const warm = await reopened.readFast(conversation, { lastRounds: 1 });
    assert.equal(warm.revision, cold.revision);
    assert.equal(warm.timings?.cacheHit, 1);
    assert.equal(warm.timings?.parsedBytes, 0);
    await appendFile(filename, assistant("same-last-round-continuation"));
    const continued = await reopened.readFast(conversation, { lastRounds: 1 });
    assert.equal(continued.totalRounds, 180);
    assert.match(continued.messages.map(message => message.text).join("\n"), /same-last-round-continuation/u);
    assert.equal(continued.timings?.append, 1);
    assert.ok(continued.timings!.parsedBytes < continued.sourceBytes! / 20);
    await appendFile(filename, user("new-round") + assistant("new-answer"));
    const appended = await reopened.readFast(conversation, { lastRounds: 1 });
    assert.equal(appended.totalRounds, 181);
    assert.equal(appended.rounds?.[0].roundIndex, 181);
    assert.equal(appended.timings?.append, 1);
    const before = await stat(filename);
    const text = await readFile(filename, "utf8");
    await writeFile(filename, text.replace("user-1-", "edit-1-"));
    await utimes(filename, before.atime, before.mtime);
    const rewritten = await reopened.read(conversation, {});
    assert.notEqual(rewritten.revision, appended.revision);
    assert.match(rewritten.messages[0].text, /^edit-1-/u);
    assert.equal(rewritten.timings?.append, 0);
    assert.ok(rewritten.timings!.parsedBytes > rewritten.sourceBytes! / 2);
    await assert.rejects(reopened.readRounds(conversation, { revision: appended.revision, startRound: 1, endRound: 1 }), /revision changed/u);
    let checks = 0;
    await assert.rejects(readClaudeCodeRoundTail(filename, { isCancelled: () => ++checks > 40 }), error => (error as Error).name === "AbortError");
    const cacheFiles = await readdir(cacheRoot);
    assert.equal(cacheFiles.filter(file => file.endsWith(".tmp")).length, 0);
    const cachePath = path.join(cacheRoot, cacheFiles[0]);
    const preserved = await readFile(cachePath, "utf8");
    await assert.rejects(reopened.read(conversation, { forceRefresh: true, isCancelled: () => true }), error => (error as Error).name === "AbortError");
    assert.equal(await readFile(cachePath, "utf8"), preserved);
    const envelope = JSON.parse(preserved);
    envelope.payload.rounds[0].userMessage = "corrupted-cache";
    await writeFile(cachePath, JSON.stringify(envelope));
    const recovered = await reopened.read(conversation, {});
    assert.match(recovered.messages[0].text, /^edit-1-/u);
    assert.ok(recovered.timings!.parsedBytes > 0);
    const richFilename = path.join(root, "rich.jsonl");
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } };
    await writeFile(richFilename, [
        line({ type: "user", message: { role: "user", content: [{ type: "text", text: "annotated-user" }, image], annotations: [{ selectedText: "annotated", comment: "keep-this-comment" }] } }),
        line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "visible-answer" }, image, { type: "tool_use", id: "rich-call", name: "Read", input: { path: "fixture.txt" } }] } }),
        line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "rich-call", content: "full-tool-result" }] } }),
    ].join(""));
    const richProvider = createHostCorpusProvider("claude-code", { cacheRoot: path.join(root, "rich-cache"), claudeThreads: () => [{ ...thread, id: "rich", jsonlPath: richFilename }] });
    const richConversation = (await richProvider.list({}, {}))[0];
    const rich = await richProvider.read(richConversation, { messageRoles: ["user", "assistant", "tool", "subagent"] });
    assert.equal(rich.messages.find(message => message.role === "user")?.annotations?.[0].comment, "keep-this-comment");
    assert.ok(rich.messages.find(message => message.role === "assistant")?.attachments?.length);
    assert.match(rich.messages.find(message => message.role === "tool")!.text, /full-tool-result/u);
    assert.doesNotMatch(JSON.stringify(rich), /data:image\/png;base64/u);
    await assert.rejects(createHostCorpusProvider("claude-code", { ...options, maxSourceBytes: 1 }).read(conversation, {}), /maxSourceBytes/u);
    const lateFilename = path.join(root, "late-tool.jsonl");
    await writeFile(lateFilename, user("first") + line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "late-call", name: "Read", input: { path: "fixture.txt" } }] } }) + user("second") + assistant("second-answer"));
    const lateProvider = createHostCorpusProvider("claude-code", { cacheRoot: path.join(root, "late-cache"), claudeThreads: () => [{ ...thread, id: "late", jsonlPath: lateFilename }] });
    const lateConversation = (await lateProvider.list({}, {}))[0];
    await lateProvider.read(lateConversation, {});
    await appendFile(lateFilename, line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "late-call", content: "late-first-round-result" }] } }));
    const late = await lateProvider.read(lateConversation, { messageRoles: ["user", "assistant", "tool"] });
    assert.match(late.rounds![0].toolCalls[0].resultFull || "", /late-first-round-result/u);
    assert.equal(late.rounds![1].toolCalls.length, 0);
    assert.equal(late.timings?.append, 0);
    console.log(JSON.stringify({ test: "claude-code-corpus", totalRounds: recovered.totalRounds, sourceBytes: recovered.sourceBytes, cold: cold.timings, warm: warm.timings, continued: continued.timings, appended: appended.timings, rewritten: rewritten.timings }));
} finally {
    await rm(root, { recursive: true, force: true });
}
