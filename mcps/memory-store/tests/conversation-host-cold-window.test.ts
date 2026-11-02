import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, mkdir, open, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { constants, zstdCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const format = process.env.COLD_WINDOW_FORMAT;
if (!format) {
    for (const selected of ["claude", "dsh-raw", "dsh-zstd"]) {
        const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], { env: { ...process.env, COLD_WINDOW_FORMAT: selected }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
        process.stdout.write(child.stdout || "");
        process.stderr.write(child.stderr || "");
        assert.equal(child.status, 0, `${selected}: ${child.error || child.signal || "failed"}`);
    }
} else {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan61-cold-window-"));
    process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
    const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
    const { captureHostFile } = await import("../src/conversation-host-files.ts");
    const { mergeConsecutiveHumanRounds } = await import("../src/trajectory.ts");
    const line = (value: unknown) => JSON.stringify(value) + "\n";
    const dsh = format !== "claude";
    const compressed = format === "dsh-zstd";
    const id = `controlled-${format}`;
    const directory = path.join(root, "sessions", "controlled-project", id);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, compressed ? "session.jsonl.zstd" : "session.jsonl");
    const cacheRoot = path.join(root, "cache");
    const options = dsh ? { cacheRoot, dshOptions: { sessionsRoot: path.join(root, "sessions") } }
        : { cacheRoot, claudeThreads: () => [{ id, jsonlPath: filename, source: "claude-code" as const, title: "controlled long fixture", cwd: root }] };
    const source = dsh ? "dsh" as const : "claude-code" as const;
    const allRoles = { messageRoles: ["user", "assistant", "tool", "subagent"] as ("user" | "assistant" | "tool" | "subagent")[] };
    const encode = (text: string) => compressed ? Buffer.from(zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })) : Buffer.from(text);
    const header = line({ type: "session", version: 0, id, cwd: root, origin: "controlled-format-fixture-not-user-history" });
    const payload = "正文完整保留-" + "abcdefghijklmno".repeat(1093);
    const roundText = (round: number) => {
        const userMessage = { id: `user-${round}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `question-${round}` }, { type: "image", path: "fixture.png", mime_type: "image/png" }], annotations: [{ selectedText: "question", comment: `note-${round}` }] };
        if (!dsh) return line({ type: "user", message: userMessage })
            + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer-${round}-${payload}` }, { type: "tool_use", id: `call-${round}`, name: "read", input: { path: "fixture.txt" } }] } })
            + line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${round}`, content: `result-${round}` }] } });
        const seq = (round - 1) * 4;
        return line({ type: "user/message", seq, time: seq, data: { message: userMessage } })
            + line({ type: "assistant/message", seq: seq + 1, time: seq + 1, data: { turn: round, step: round, message: { role: "assistant", content: [{ type: "text", text: `answer-${round}-${payload}` }] } } })
            + line({ type: "tool/call", seq: seq + 2, time: seq + 2, data: { callId: `call-${round}`, name: "read", arguments: "fixture.txt" } })
            + line({ type: "tool/result", seq: seq + 3, time: seq + 3, data: { message: { source: { callId: `call-${round}` }, content: [{ type: "text", text: `result-${round}` }] } } });
    };
    const hash = async () => {
        const digest = createHash("sha256");
        for await (const bytes of createReadStream(filename)) digest.update(bytes);
        return digest.digest("hex");
    };
    const comparable = (rounds: any[]) => rounds.map(round => ({ user: round.userMessage, annotations: round.userMessages?.map((message: any) => message.annotations),
        attachments: round.userMessages?.map((message: any) => message.attachments?.map(({ stepIndex: _stepIndex, ...attachment }: any) => attachment)), answers: round.aiResponses.map((answer: any) => answer.response),
        tools: round.toolCalls.map((tool: any) => ({ name: tool.name, args: tool.argsFull, result: tool.resultFull })) }));
    try {
        const handle = await open(filename, "w");
        let decodedSourceBytes = dsh ? Buffer.byteLength(header) : 0;
        try {
            if (dsh) await handle.write(encode(header));
            for (let first = 1; first <= 4096; first += 32) {
                const text = Array.from({ length: 32 }, (_, index) => roundText(first + index)).join("");
                decodedSourceBytes += Buffer.byteLength(text);
                await handle.write(encode(text));
            }
        } finally { await handle.close(); }
        assert.ok(decodedSourceBytes >= 64 * 1024 * 1024);
        const beforeHash = await hash();
        const provider = createHostCorpusProvider(source, options);
        const conversation = (await provider.list({ conversationIds: [id] }, {}))[0];
        const phases = new Set<string>();
        const begin = performance.now();
        const cold = await provider.readFast(conversation, { lastRounds: 2 }, { ...allRoles, onProgress: progress => phases.add(progress.phase) });
        const firstWindowMs = performance.now() - begin;
        assert.equal(cold.roundNumbering, "relative");
        assert.equal(cold.totalRounds, undefined);
        assert.equal(cold.complete, false);
        assert.equal(cold.rounds?.length, 2);
        assert.ok(cold.timings!.parsedBytes <= 4 * 1024 * 1024);
        assert.ok(cold.timings!.parsedBytes < decodedSourceBytes / 8);
        assert.match(cold.rounds![1].userMessage, /question-4096/u);
        assert.equal(cold.rounds![1].userMessages?.[0].annotations?.[0].comment, "note-4096");
        assert.ok(cold.rounds![1].userMessages?.[0].attachments?.length);
        assert.match(cold.messages.find(message => message.role === "tool")!.text, /result-4095/u);
        assert.ok((await readdir(cacheRoot)).every(name => name.endsWith(".window.json")));
        const reopened = createHostCorpusProvider(source, options);
        const warm = await reopened.readFast(conversation, { lastRounds: 2 }, allRoles);
        assert.equal(warm.revision, cold.revision);
        assert.equal(warm.timings?.parsedBytes, 0);
        assert.equal(warm.timings?.cacheHit, 1);
        const oldest = await provider.readFast(conversation, { startRound: 1, endRound: 2 }, allRoles);
        assert.equal(oldest.roundNumbering, "absolute");
        assert.equal(oldest.totalRounds, undefined);
        assert.equal(oldest.requestedRangeComplete, true);
        assert.match(oldest.rounds![0].userMessage, /^question-1(?:\n|$)/u);
        const fullStart = performance.now();
        const full = await (async () => {
            let rounds;
            if (dsh) {
                const { listDshSessionSources, readDshSessionIncremental } = await import("../src/dsh-session-reader.ts");
                const { normalizeDshSessionEvents } = await import("../src/dsh-client.ts");
                const selected = (await listDshSessionSources(options.dshOptions!)).find(item => item.id === id)!;
                const result = await readDshSessionIncremental(selected, options.dshOptions);
                rounds = normalizeDshSessionEvents(result.events, result.header).rounds;
            } else {
                const { readClaudeCodeRoundTail } = await import("../src/claude-code-client.ts");
                rounds = mergeConsecutiveHumanRounds((await readClaudeCodeRoundTail(filename, { cwd: root })).rounds);
            }
            return { totalRounds: rounds.length, first: comparable(rounds.slice(0, 2)), last: comparable(rounds.slice(-2)) };
        })();
        const fullMs = performance.now() - fullStart;
        assert.equal(full.totalRounds, 4096);
        assert.deepEqual(comparable(cold.rounds!), full.last);
        assert.deepEqual(comparable(oldest.rounds!), full.first);
        assert.equal(await hash(), beforeHash);
        const badOffset = compressed ? encode(header).length + encode(Array.from({ length: 32 }, (_, index) => roundText(index + 1)).join("")).length - 1 : 1024 * 1024;
        const mutable = await open(filename, "r+");
        const original = Buffer.alloc(1);
        try {
            await mutable.read(original, 0, 1, badOffset);
            await mutable.write(Buffer.from([compressed ? original[0] ^ 1 : 255]), 0, 1, badOffset);
            await assert.rejects(provider.readFast(conversation, { lastRounds: 2 }, { ...allRoles, forceRefresh: true }), compressed ? /checksum/u : /encoded data|UTF-8/u);
            await mutable.write(original, 0, 1, badOffset);
        } finally { await mutable.close(); }
        assert.equal(await hash(), beforeHash);
        let cancelled = false;
        await assert.rejects(provider.readFast(conversation, { lastRounds: 3 }, { forceRefresh: true, isCancelled: () => cancelled,
            onProgress: progress => { if ((progress.bytes || 0) > 0) cancelled = true; } }), error => (error as Error).name === "AbortError");
        cancelled = false;
        await assert.rejects(provider.readFast(conversation, { lastRounds: 3 }, { forceRefresh: true, isCancelled: () => cancelled,
            onProgress: progress => { if (progress.phase.includes(compressed ? "frame-checksum" : dsh ? "record-parse" : "window-parse")) cancelled = true; } }), error => (error as Error).name === "AbortError");
        assert.equal(await hash(), beforeHash);
        await appendFile(filename, encode(roundText(4097)));
        const appended = await provider.readFast(conversation, { lastRounds: 2 }, allRoles);
        assert.notEqual(appended.revision, cold.revision);
        assert.match(appended.rounds!.at(-1)!.userMessage, /question-4097/u);
        await assert.rejects(provider.readRounds(conversation, { revision: cold.revision, startRound: 1, endRound: 1 }), /revision changed/u);
        if (!compressed) {
            const current = await stat(filename);
            const writable = await open(filename, "r+");
            try {
                const prefix = Buffer.alloc(8192);
                await writable.read(prefix, 0, prefix.length, 0);
                const position = prefix.indexOf(Buffer.from("question-1"));
                assert.ok(position >= 0);
                await writable.write(Buffer.from("changed!-1"), 0, 10, position);
            } finally { await writable.close(); }
            await utimes(filename, current.atime, current.mtime);
            const changed = await createHostCorpusProvider(source, options).readFast(conversation, { lastRounds: 2 }, allRoles);
            assert.notEqual(changed.revision, appended.revision);
        }
        if (compressed) {
            const pending = encode(roundText(4098));
            await appendFile(filename, pending.subarray(0, Math.floor(pending.length / 2)));
            const partial = await createHostCorpusProvider(source, { ...options, cacheRoot: path.join(root, "partial-cache") }).readFast(conversation, { lastRounds: 2 }, allRoles);
            assert.ok(partial.warnings.includes("dsh_incomplete_trailing_frame"));
            await appendFile(filename, pending.subarray(Math.floor(pending.length / 2)));
            const completed = await createHostCorpusProvider(source, { ...options, cacheRoot: path.join(root, "partial-cache") }).readFast(conversation, { lastRounds: 2 }, allRoles);
            assert.match(completed.rounds!.at(-1)!.userMessage, /question-4098/u);
            const split = Buffer.from(roundText(4099));
            const splitAt = split.indexOf(Buffer.from("正文完整")) + 1;
            assert.ok(splitAt > 1);
            await appendFile(filename, Buffer.concat([split.subarray(0, splitAt), split.subarray(splitAt)].map(bytes => Buffer.from(zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })))));
            const acrossFrames = await createHostCorpusProvider(source, { ...options, cacheRoot: path.join(root, "partial-cache") }).readFast(conversation, { lastRounds: 2 }, allRoles);
            assert.match(acrossFrames.rounds!.at(-1)!.userMessage, /question-4099/u);
        } else {
            await appendFile(filename, "{\"unfinished\":");
            const partial = await createHostCorpusProvider(source, { ...options, cacheRoot: path.join(root, "partial-cache") }).readFast(conversation, { lastRounds: 2 }, allRoles);
            assert.ok(partial.warnings.some(warning => warning.includes("incomplete_trailing_record")));
        }
        const verified = await captureHostFile(filename);
        console.log(JSON.stringify({ test: "host-cold-window", format, sourceBytes: cold.sourceBytes, decodedSourceBytes, firstWindowMs, fullMs,
            cold: cold.timings, warm: warm.timings, oldest: oldest.timings, appended: appended.timings, phases: [...phases], beforeHash,
            afterUnchangedHash: beforeHash, finalHash: verified.sha256, peakRssBytes: process.resourceUsage().maxRSS * 1024,
            checks: "window-full-content+roles+annotations+attachments+tools/reopen/append/old-ref/old-segment-edit(raw)/incomplete/cancel" }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
