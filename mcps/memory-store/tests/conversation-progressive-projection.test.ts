import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { after, afterEach, test } from "node:test";
import type { ConversationRound } from "../src/trajectory.js";
import type { CorpusMessage } from "../src/conversation-corpus-types.js";
import type { ProgressiveRequest, ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";
import type { ProgressivePublishInput, ProgressiveSource } from "../src/conversation-progressive-types.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-projection-fictional-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(directory, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { normalizeProgressiveProjection, isProgressiveRequest, isProgressiveTaskPayload, PROGRESSIVE_MESSAGE_ROLES } = await import("../src/conversation-progressive-task-types.js");
const { projectProgressiveInput, projectProgressiveRound, projectProgressiveSource, availableProgressiveRoles, publishProgressiveBlocks } = await import("../src/conversation-progressive-projection.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
const { readCodexHistoryWindow } = await import("../src/codex-history-window.js");
const { codexHistoryPhysicalIdentity } = await import("../src/codex-history-source.js");
const { projectCodexCorpusRound } = await import("../src/conversation-corpus-reader-projection.js");
const tasks = await import("../src/conversation-progressive-task.js");
const background = await import("../src/background-tasks.js");
const { runProgressiveAction } = await import("../src/tools/conversation-progressive-tool.js");
const timestamp = "2026-01-01T00:00:00Z";
const request: ProgressiveRequest = { ownerId: "fictional-owner", conversationId: "fictional-target", dataChain: "codex", direction: "latest", initialRounds: 3, buildFull: false };
const source: ProgressiveSource = { conversationId: request.conversationId, host: "codex", revision: "fictional-source-revision", snapshot: { fixture: true } };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fork = childProcess.fork;

function input(roundIndex = 1, body = "fictional body", output = "tool output"): ProgressivePublishInput {
    const attachment = { kind: "file" as const, source: "codex-local-file", originalPath: "C:/fixture/input.txt", name: "input.txt" };
    const round: ConversationRound = { roundIndex, startStep: roundIndex * 4, endStep: roundIndex * 4 + 3, createdAt: timestamp,
        userMessage: body, mediaAttachments: [], attachments: [attachment],
        userMessages: [{ text: body, stepIndex: roundIndex * 4, createdAt: timestamp, attachments: [attachment], annotations: [{ selectedText: "body", comment: "annotation" }] }],
        aiResponses: [{ stepIndex: roundIndex * 4 + 3, response: "reply", thinking: output, toolCalls: [{ name: "fixture_tool", args: output }] }],
        toolCalls: [{ stepIndex: roundIndex * 4 + 1, name: "fixture_tool", argsSummary: "args", resultSummary: "summary", argsFull: "args", resultFull: output }],
        taskBoundaries: [], codeActions: [], subagentSummaries: [],
        semanticEvents: [{ semanticRole: "tool", stepIndex: roundIndex * 4 + 1, resultFull: output },
            { semanticRole: "model", stepIndex: roundIndex * 4 + 3, createdAt: timestamp, attachments: [{ ...attachment, originalPath: "C:/fixture/output.txt" }] }] };
    const messages: CorpusMessage[] = [
        { id: "user-" + roundIndex, round: roundIndex, role: "user", text: body, timestamp, position: { messageId: "original-user-" + roundIndex, ordinal: round.startStep }, attachments: [attachment], annotations: round.userMessages![0].annotations },
        { id: "assistant-" + roundIndex, round: roundIndex, role: "assistant", text: "reply", timestamp, position: { messageId: "original-assistant-" + roundIndex, ordinal: round.endStep } },
        { id: "tool-" + roundIndex, round: roundIndex, role: "tool", text: output, position: { ordinal: round.startStep + 1 } },
    ];
    return { coverage: { kind: "absolute", startRound: roundIndex, endRound: roundIndex }, anchor: { fixture: roundIndex }, rounds: [round], messages };
}

afterEach(() => { global.gc?.(); });
after(async () => {
    childProcess.fork = fork;
    syncBuiltinESMExports();
    background.__testResetBackgroundTasksForTest();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("progressive-projection-fictional-"));
    await fs.rm(directory, { recursive: true });
});

test("role/depth validation accepts legacy undefined and normalizes aliases/order for persistent dedupe", () => {
    assert.equal(isProgressiveRequest(request), true);
    assert.equal(isProgressiveTaskPayload({ version: 1, taskId: "progressive-10000000-0000-4000-8000-000000000059", directory, request }), true);
    assert.deepEqual(normalizeProgressiveProjection(), { messageRoles: ["user", "assistant"], depth: "normal" });
    const normalized = normalizeProgressiveProjection(["model", "user", "assistant", "user"]);
    assert.deepEqual(normalized, normalizeProgressiveProjection(["user", "assistant"]));
    assert.equal(JSON.stringify({ ...request, ...normalized }), JSON.stringify({ ...request, ...normalizeProgressiveProjection() }));
    assert.deepEqual(normalizeProgressiveProjection(undefined, "full").messageRoles, PROGRESSIVE_MESSAGE_ROLES);
    for (const invalid of [{ messageRoles: [] }, { messageRoles: ["system"] }, { messageRoles: ["model"] }, { messageRoles: ["tool", "tool"] }, { messageRoles: "tool" }, { messageRoles: null }, { depth: "text" }, { depth: null }]) {
        assert.equal(isProgressiveRequest({ ...request, ...invalid }), false);
        assert.equal(isProgressiveTaskPayload({ version: 1, taskId: "progressive-10000000-0000-4000-8000-000000000059", directory, request: { ...request, ...invalid } }), false);
    }
    assert.throws(() => normalizeProgressiveProjection(["system"]), /legacy full-cache read/);
    assert.throws(() => normalizeProgressiveProjection([]), /messageRoles/);
    assert.throws(() => normalizeProgressiveProjection(undefined, "text"), /depth/);
});

test("default canonical body excludes a greater-than-16MiB tool payload without losing message metadata", async () => {
    const original = input(1, "faithful body", "x".repeat(17 * 1024 * 1024));
    const projected = projectProgressiveInput(original, request);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 16000);
    assert.deepEqual(projected.rounds[0].toolCalls, []);
    assert.equal(projected.rounds[0].aiResponses[0].thinking, "");
    assert.equal(original.rounds[0].toolCalls[0].resultFull!.length, 17 * 1024 * 1024);
    assert.deepEqual(projected.messages, original.messages.slice(0, 2));
    assert.equal(projected.messages[0].position.messageId, "original-user-1");
    assert.equal(projected.messages[0].timestamp, timestamp);
    assert.deepEqual(projected.messages[0].annotations, original.messages[0].annotations);
    assert.deepEqual(JSON.parse(JSON.stringify(projected.rounds[0].userMessages)), original.rounds[0].userMessages);
    assert.equal(projected.rounds[0].createdAt, timestamp);
    const cache = await openProgressiveCache({ root: path.join(directory, "large-default"), source: projectProgressiveSource(source, request) });
    const writer = await cache.beginWrite();
    const [block] = await publishProgressiveBlocks(cache, writer, projected);
    assert.ok(block.bytes < 16000);
    assert.deepEqual((await cache.read()).messages, original.messages.slice(0, 2));
    await cache.release(writer);
});

test("full normalized publication uses faithful body projection and keeps assistant attachments and user annotations", () => {
    const original = input();
    const round = projectProgressiveRound(original.rounds[0], normalizeProgressiveProjection());
    const messages = projectCodexCorpusRound(request.conversationId, round, new Map([
        [round.startStep, { position: { ordinal: round.startStep, messageId: "full-user-id" }, timestamp }],
        [round.endStep, { position: { ordinal: round.endStep, messageId: "full-assistant-id" }, timestamp }],
    ]), ["user", "assistant"], "fictional.jsonl");
    assert.equal(messages[0].position.messageId, "full-user-id");
    assert.equal(messages[1].position.messageId, "full-assistant-id");
    assert.ok(messages.every(message => message.timestamp === timestamp));
    assert.deepEqual(messages[0].annotations, original.messages[0].annotations);
    assert.equal(messages[1].attachments?.[0].originalPath, "C:/fixture/output.txt");
    assert.deepEqual(round.semanticEvents?.map(event => event.semanticRole), ["model"]);
    assert.equal(original.rounds[0].semanticEvents?.[0].resultFull, "tool output");
});

test("explicit full/all roles retain the original canonical raw detail and explicit tool is published intact", async () => {
    const original = input();
    const full = { ...request, ...normalizeProgressiveProjection(undefined, "full") };
    const projected = projectProgressiveInput(original, full);
    assert.equal(projected.rounds[0], original.rounds[0]);
    assert.deepEqual(projected.messages, original.messages);
    const toolsOnly = { ...request, ...normalizeProgressiveProjection(["tool"]) };
    const cache = await openProgressiveCache({ root: path.join(directory, "requested-tools"), source: projectProgressiveSource(source, toolsOnly) });
    const writer = await cache.beginWrite();
    await publishProgressiveBlocks(cache, writer, projectProgressiveInput(original, toolsOnly));
    assert.deepEqual((await cache.read()).messages, [original.messages[2]]);
    assert.equal((await cache.read()).rounds[0].toolCalls[0].resultFull, "tool output");
    await cache.release(writer);
});

test("one oversized requested tool or body fails closed with exact row bytes and leaves no published block", async () => {
    for (const role of ["tool", "user"] as const) {
        const content = "z".repeat(8192);
        const original = role === "tool" ? input(1, "body", content) : input(1, content, "small tool");
        const selected = { ...request, ...normalizeProgressiveProjection([role]) };
        const projected = projectProgressiveInput(original, selected);
        const expectedBytes = Buffer.byteLength(JSON.stringify({ round: projected.rounds[0], messages: projected.messages })) + 1;
        const root = path.join(directory, "too-large-" + role);
        const cache = await openProgressiveCache({ root, source: projectProgressiveSource(source, selected), limits: { maxBlockBytes: 16000, maxRowBytes: 4000 } });
        const writer = await cache.beginWrite();
        await assert.rejects(publishProgressiveBlocks(cache, writer, projected), error => {
            assert.equal((error as { code: string }).code, "size_limit");
            assert.match((error as Error).message, new RegExp("serialized row=" + expectedBytes + " UTF-8 bytes"));
            assert.match((error as Error).message, /progressive=false/);
            return true;
        });
        assert.equal((await cache.status()).blocks.length, 0);
        assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("pending-")), []);
        await cache.cancel(writer);
        global.gc?.();
    }
});

test("block budget splits across rounds, preserves order/coverage/refs and publishes verified hashes", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => projectProgressiveInput(input(index + 1, "b".repeat(160)), request));
    const combined = { ...rows[0], coverage: { kind: "relative" as const, startRound: 1, endRound: 8 }, order: 100,
        rounds: rows.flatMap(row => row.rounds), messages: rows.flatMap(row => row.messages) };
    const root = path.join(directory, "split-blocks");
    const cache = await openProgressiveCache({ root, source: projectProgressiveSource(source, request), limits: { maxBlockBytes: 7000, maxRowBytes: 6000 } });
    const writer = await cache.beginWrite();
    const blocks = await publishProgressiveBlocks(cache, writer, combined);
    assert.ok(blocks.length > 1);
    assert.ok(blocks.every(block => block.bytes <= 7000));
    const read = await cache.read({ direction: "oldest" });
    assert.deepEqual(read.rounds.map(round => round.roundIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(read.messages, combined.messages);
    for (const block of blocks) assert.equal(digest(await fs.readFile(path.join(root, "block-" + block.sha256 + ".jsonl"))), block.sha256);
    for (const row of read.rows) assert.deepEqual((await cache.locate(row.ref)).messages, row.messages);
    await cache.release(writer);
});

test("projection roles and depth separate generations, refs and hashes while normalized aliases stay stable", async () => {
    const body = projectProgressiveSource(source, request);
    const aliases = projectProgressiveSource(source, normalizeProgressiveProjection(["model", "user"]));
    const full = projectProgressiveSource(source, normalizeProgressiveProjection(undefined, "full"));
    const brief = projectProgressiveSource(source, normalizeProgressiveProjection(undefined, "brief"));
    assert.equal(body.revision, aliases.revision);
    assert.equal(new Set([source.revision, body.revision, full.revision, brief.revision]).size, 4);
    assert.deepEqual(availableProgressiveRoles(body), ["user", "assistant"]);
    assert.deepEqual(availableProgressiveRoles(source), PROGRESSIVE_MESSAGE_ROLES);
    const bodyCache = await openProgressiveCache({ root: path.join(directory, "generation-body"), source: body });
    const fullCache = await openProgressiveCache({ root: path.join(directory, "generation-full"), source: full });
    const bodyWriter = await bodyCache.beginWrite();
    const fullWriter = await fullCache.beginWrite();
    const [bodyBlock] = await publishProgressiveBlocks(bodyCache, bodyWriter, projectProgressiveInput(input(), request));
    const [fullBlock] = await publishProgressiveBlocks(fullCache, fullWriter, projectProgressiveInput(input(), normalizeProgressiveProjection(undefined, "full")));
    assert.notEqual(bodyCache.sourceKey, fullCache.sourceKey);
    assert.notEqual(bodyBlock.sha256, fullBlock.sha256);
    await assert.rejects(fullCache.locate((await bodyCache.read()).rows[0].ref), { code: "invalid_ref" });
    await bodyCache.release(bodyWriter);
    await fullCache.release(fullWriter);
});

test("raw default role projection slims a greater-than-16MiB tool result before canonical publication", async () => {
    const target = "10000000-0000-4000-8000-000000000059";
    const filename = path.join(directory, "fictional-large.jsonl");
    const header = JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: target } });
    const records = [header,
        JSON.stringify({ ordinal: 1, timestamp, type: "response_item", payload: { type: "message", role: "user", message_id: "raw-user-id", content: [{ type: "input_text", text: "raw body" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] } }),
        JSON.stringify({ ordinal: 2, timestamp, type: "response_item", payload: { type: "function_call", name: "fixture_tool", call_id: "fictional-call", arguments: "{}" } }),
        JSON.stringify({ ordinal: 3, timestamp, type: "response_item", payload: { type: "function_call_output", call_id: "fictional-call", output: "t".repeat(17 * 1024 * 1024) } }),
        JSON.stringify({ ordinal: 4, timestamp, type: "response_item", payload: { type: "message", role: "assistant", message_id: "raw-assistant-id", content: [{ type: "output_text", text: "raw reply" }] } }),
    ];
    await fs.writeFile(filename, records.join("\n") + "\n");
    records.length = 0;
    global.gc?.();
    const originalHash = digest(await fs.readFile(filename));
    const result = await readCodexHistoryWindow({ conversationId: target, maxRounds: 1, messageRoles: normalizeProgressiveProjection().messageRoles,
        source: { leafPath: filename, segments: [{ path: filename, replicas: [], threadId: target, rolloutId: target, startOrdinal: 0, ordinalMode: "explicit",
            physical: codexHistoryPhysicalIdentity(syncFs.statSync(filename)), headerSha256: digest(header) }] } });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].position.messageId, "raw-user-id");
    assert.equal(result.messages[1].position.messageId, "raw-assistant-id");
    assert.ok(result.messages.every(message => message.timestamp === timestamp));
    assert.ok(result.messages[0].attachments?.[0].sha256);
    assert.ok(Buffer.byteLength(JSON.stringify(result.rounds)) < 16000);
    const cache = await openProgressiveCache({ root: path.join(directory, "raw-publication"), source: projectProgressiveSource(result.source, request) });
    const writer = await cache.beginWrite();
    await publishProgressiveBlocks(cache, writer, projectProgressiveInput({ coverage: { kind: "relative", startRound: 1, endRound: 1 }, anchor: result.anchor, rounds: result.rounds, messages: result.messages }, request));
    assert.deepEqual((await cache.read()).messages, result.messages);
    await cache.release(writer);
    assert.equal(digest(await fs.readFile(filename)), originalHash);
});

class FixtureChild extends EventEmitter {
    pid = 2147483647;
    connected = true;
    stderr = new PassThrough();
    payload?: ProgressiveTaskPayload;
    send(message: { type: string; payload?: ProgressiveTaskPayload }, callback?: (error: Error | null) => void) { if (message.type === "run") this.payload = message.payload; callback?.(null); return true; }
    kill() { return true; }
    complete() { this.emit("message", { type: "result", result: "fictional result" }); this.connected = false; this.emit("exit", 0, null); this.emit("close", 0, null); }
}

test("tool entry persists normalized roles for dedupe and refuses unbuilt roles with a usable next call", async () => {
    const children: FixtureChild[] = [];
    childProcess.fork = (() => { const child = new FixtureChild(); children.push(child); return child; }) as typeof childProcess.fork;
    syncBuiltinESMExports();
    try {
        const params = { action: "prepare", conversationId: request.ownerId, conversationIds: [request.conversationId], lastRounds: 1, prepareCache: false, waitSeconds: 0 };
        const started = await runProgressiveAction(params) as any;
        for (let attempts = 0; !children[0]?.payload && attempts < 300; attempts++) await sleep(10);
        const payload = children[0]?.payload;
        assert.ok(payload);
        assert.deepEqual(payload.request.messageRoles, ["user", "assistant"]);
        assert.equal(payload.request.depth, "normal");
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(payload.directory, "request.json"), "utf8")).payload.request, payload.request);
        assert.equal((await runProgressiveAction({ ...params, messageRoles: ["model", "user", "user"] }) as any).taskId, started.taskId);
        assert.notEqual((await runProgressiveAction({ ...params, messageRoles: ["tool"] }) as any).taskId, started.taskId);
        const projectedSource = projectProgressiveSource(source, payload.request);
        const root = path.join(payload.directory, "ranges", "fictional-body");
        const cache = await openProgressiveCache({ root, source: projectedSource });
        const writer = await cache.beginWrite();
        await publishProgressiveBlocks(cache, writer, projectProgressiveInput(input(), payload.request));
        const ref = (await cache.read()).rows[0].ref;
        await cache.release(writer);
        await tasks.writeProgressiveState(path.join(payload.directory, "ready.json"), { version: 1, phase: "requested-range-ready", previous: [], current: { directory: root, source: projectedSource }, requestedRangeComplete: true, warnings: [], updatedAt: new Date().toISOString() });
        const status = await runProgressiveAction({ action: "prepare_status", conversationId: request.ownerId, taskId: started.taskId }) as any;
        assert.deepEqual(status.availableMessageRoles, ["user", "assistant"]);
        for (const action of ["read_ready", "search_ready", "locate_ready", "extract_ready"]) {
            await assert.rejects(runProgressiveAction({ action, conversationId: request.ownerId, taskId: started.taskId, rangeRef: ref, messageRoles: ["tool"], query: "word" }), error => {
                const text = (error as Error).message;
                assert.match(text, /were not prepared: tool/);
                const next = JSON.parse(text.split("Next call: ")[1]);
                assert.equal(next.action, "prepare");
                assert.deepEqual(next.conversationIds, [request.conversationId]);
                assert.deepEqual(next.messageRoles, ["tool"]);
                assert.equal(next.prepareCache, false);
                return true;
            });
        }
        const read = await runProgressiveAction({ action: "read_ready", conversationId: request.ownerId, taskId: started.taskId }) as any;
        assert.equal(read.messages.length, 2);
        assert.deepEqual(read.availableMessageRoles, ["user", "assistant"]);
        const legacyRoot = path.join(payload.directory, "ranges", "fictional-legacy-all");
        const legacySource = { ...source, revision: "legacy-all-role-revision" };
        const legacyCache = await openProgressiveCache({ root: legacyRoot, source: legacySource });
        const legacyWriter = await legacyCache.beginWrite();
        await legacyCache.publish(legacyWriter, input());
        await legacyCache.release(legacyWriter);
        await tasks.writeProgressiveState(path.join(payload.directory, "ready.json"), { version: 1, phase: "requested-range-ready",
            previous: [{ directory: root, source: projectedSource }], current: { directory: legacyRoot, source: legacySource },
            requestedRangeComplete: true, warnings: [], updatedAt: new Date().toISOString() });
        const legacyRead = await runProgressiveAction({ action: "read_ready", conversationId: request.ownerId, taskId: started.taskId, messageRoles: ["tool"] }) as any;
        assert.deepEqual(legacyRead.availableMessageRoles, PROGRESSIVE_MESSAGE_ROLES);
        assert.deepEqual(legacyRead.messages.map((message: CorpusMessage) => message.text), ["tool output"]);
        const oldBody = await runProgressiveAction({ action: "locate_ready", conversationId: request.ownerId, taskId: started.taskId, rangeRef: ref }) as any;
        assert.deepEqual(oldBody.availableMessageRoles, ["user", "assistant"]);
        assert.equal(oldBody.messages.length, 2);
        await assert.rejects(runProgressiveAction({ action: "locate_ready", conversationId: request.ownerId, taskId: started.taskId, rangeRef: ref, messageRoles: ["tool"] }), /were not prepared: tool/);
    } finally {
        for (const child of children) child.complete();
        await sleep(30);
        childProcess.fork = fork;
        syncBuiltinESMExports();
    }
});
