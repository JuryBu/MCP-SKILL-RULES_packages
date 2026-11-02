import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

const root = await mkdtemp(path.join(os.tmpdir(), "dsh-incremental-reader-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { listDshSessionSources, readDshSessionIncremental, readDshSession } = await import("../src/dsh-session-reader.ts");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const header = (id: string) => line({ type: "session", version: 0, id, cwd: root, origin: "controlled-fixture" });
const human = (seq: number, text: string) => line({ type: "user/message", seq, time: seq + 1000, data: { message: { id: `user-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } } });
const assistant = (seq: number, text: string) => line({ type: "assistant/message", seq, time: seq + 1000, data: { turn: seq, step: seq, message: { role: "assistant", content: [{ type: "text", text }] } } });
const compress = (text: string) => Buffer.from(zstdCompressSync(Buffer.from(text)));

try {
    const sessionsRoot = path.join(root, "sessions");
    for (const format of ["jsonl", "jsonl.zstd"] as const) {
        const id = `fixture-${format}`;
        const directory = path.join(sessionsRoot, "project", id);
        await mkdir(directory, { recursive: true });
        const filename = path.join(directory, `session.${format}`);
        const rows = [header(id), ...Array.from({ length: 100 }, (_, index) => [human(index * 2, `user-${index + 1}`), assistant(index * 2 + 1, `answer-${index + 1}`)]).flat()];
        const encode = (text: string) => format === "jsonl" ? Buffer.from(text) : compress(text);
        await writeFile(filename, Buffer.concat(rows.map(encode)));
        const options = { sessionsRoot };
        let selected = (await listDshSessionSources(options)).find(source => source.id === id)!;
        const initial = await readDshSessionIncremental(selected, options);
        assert.equal(initial.events.length, 200);
        await appendFile(filename, encode(assistant(200, "last-round-continued")));
        selected = (await listDshSessionSources(options)).find(source => source.id === id)!;
        const tail = await readDshSessionIncremental(selected, { ...options, checkpoint: initial.checkpoint });
        assert.equal(tail.replaceFromEvent, 200);
        assert.equal(tail.events.length, 1);
        assert.ok(tail.readBytes < initial.readBytes / 10);
        const cacheRoot = path.join(root, `cache-${format}`);
        const providerOptions = { cacheRoot, dshOptions: options };
        const provider = createHostCorpusProvider("dsh", providerOptions);
        const conversation = (await provider.list({ conversationIds: [id] }, {}))[0];
        const cold = await provider.readFast(conversation, { lastRounds: 2 });
        assert.equal(cold.totalRounds, 100);
        assert.deepEqual(cold.rounds?.map(round => round.roundIndex), [99, 100]);
        assert.match(cold.messages.map(message => message.text).join("\n"), /last-round-continued/u);
        const reopened = createHostCorpusProvider("dsh", providerOptions);
        const warm = await reopened.readFast(conversation, { lastRounds: 1 });
        assert.equal(warm.timings?.cacheHit, 1);
        assert.equal(warm.timings?.parsedBytes, 0);
        await appendFile(filename, Buffer.concat([encode(human(201, "new-user")), encode(assistant(202, "new-answer"))]));
        const appended = await reopened.readFast(conversation, { lastRounds: 1 });
        assert.equal(appended.totalRounds, 101);
        assert.equal(appended.timings?.append, 1);
        assert.ok(appended.timings!.parsedBytes < appended.sourceBytes! / 10);
        if (format === "jsonl") {
            const before = await stat(filename);
            await writeFile(filename, (await readFile(filename, "utf8")).replace("user-1", "edit-1"));
            await utimes(filename, before.atime, before.mtime);
        } else {
            rows[1] = human(0, "edited-old-user");
            await writeFile(filename, Buffer.concat([...rows.map(encode), encode(assistant(200, "last-round-continued")), encode(human(201, "new-user")), encode(assistant(202, "new-answer"))]));
        }
        const rewritten = await reopened.read(conversation, {});
        assert.notEqual(rewritten.revision, appended.revision);
        assert.equal(rewritten.timings?.append, 0);
        await assert.rejects(reopened.readRounds(conversation, { revision: appended.revision, startRound: 1, endRound: 1 }), /revision changed/u);
        let cancelled = false;
        selected = (await listDshSessionSources(options)).find(source => source.id === id)!;
        await assert.rejects(readDshSessionIncremental(selected, { ...options, isCancelled: () => cancelled, onProgress: progress => { if (progress.phase === "decode") cancelled = true; } }), error => (error as Error).name === "AbortError");
        if (format === "jsonl.zstd") {
            const complete = encode(assistant(203, "completed-later"));
            await appendFile(filename, complete.subarray(0, Math.floor(complete.length / 2)));
            const partial = await reopened.read(conversation, {});
            assert.equal(partial.complete, false);
            assert.ok(partial.warnings.includes("dsh_incomplete_trailing_frame"));
            await appendFile(filename, complete.subarray(Math.floor(complete.length / 2)));
            const completed = await reopened.read(conversation, {});
            assert.equal(completed.complete, true);
            assert.match(completed.messages.map(message => message.text).join("\n"), /completed-later/u);
        }
        console.log(JSON.stringify({ test: "dsh-incremental", format, sourceBytes: cold.sourceBytes, cold: cold.timings, warm: warm.timings, appended: appended.timings, rewritten: rewritten.timings }));
    }
    const bad = path.join(sessionsRoot, "other-project", "unrelated");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "session.jsonl"), header("unrelated") + "malformed-body\n");
    const selectedOnly = await readDshSession("fixture-jsonl", { sessionsRoot });
    assert.equal(selectedOnly.events.length, 203);
    const richDirectory = path.join(sessionsRoot, "project", "rich");
    await mkdir(richDirectory, { recursive: true });
    const richImage = { type: "image", path: "fixture.png", mime_type: "image/png", data: "YWJj" };
    await writeFile(path.join(richDirectory, "session.jsonl"), header("rich") + [
        { type: "user/message", seq: 0, time: 1000, data: { message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "annotated-user" }, richImage], annotations: [{ selectedText: "annotated", comment: "keep-dsh-comment" }] } } },
        { type: "assistant/message", seq: 1, time: 1001, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "visible-answer" }, richImage] } } },
        { type: "tool/call", seq: 2, time: 1002, data: { callId: "rich-call", name: "read", arguments: "fixture.txt" } },
        { type: "tool/result", seq: 3, time: 1003, data: { message: { source: { callId: "rich-call" }, content: [{ type: "text", text: "full-dsh-result" }] } } },
    ].map(line).join(""));
    const richProvider = createHostCorpusProvider("dsh", { cacheRoot: path.join(root, "rich-cache"), dshOptions: { sessionsRoot } });
    const richConversation = (await richProvider.list({ conversationIds: ["rich"] }, {}))[0];
    const rich = await richProvider.read(richConversation, { messageRoles: ["user", "assistant", "tool", "subagent"] });
    assert.equal(rich.messages.find(message => message.role === "user")?.annotations?.[0].comment, "keep-dsh-comment");
    assert.ok(rich.messages.find(message => message.role === "assistant")?.attachments?.length);
    assert.match(rich.messages.find(message => message.role === "tool")!.text, /full-dsh-result/u);
    assert.doesNotMatch(JSON.stringify(rich), /YWJj/u);
    console.log("DSH target-only read does not parse an unrelated invalid body");
} finally {
    await rm(root, { recursive: true, force: true });
}
