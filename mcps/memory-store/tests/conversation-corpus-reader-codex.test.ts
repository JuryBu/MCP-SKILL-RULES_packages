import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { publishCodexCorpusCache, readCodexCorpusCache } from "../src/conversation-corpus-reader-cache.ts";
import { buildCodexRoundsForTest } from "../src/codex-client.ts";
import { mergeConsecutiveHumanRounds } from "../src/trajectory.ts";
import { resolveCodexHistorySourceAsync, assertCodexHistorySourceAsync, readCodexStreamingSessionMeta } from "../src/codex-history-source.ts";
import { readOrBuildConversationSourceCache, setConversationSourceCacheDataRootForTests, resetConversationSourceCacheForTests } from "../src/conversation-source-cache.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-reader-codex-"));
const codexHome = path.join(temporary, "home");
const cacheRoot = path.join(temporary, "body-cache");
const sessions = path.join(codexHome, "sessions");
fs.mkdirSync(sessions, { recursive: true });
const thread = "10000000-0000-4000-8000-000000000001";
const baseId = "20000000-0000-4000-8000-000000000001";
const leafId = "20000000-0000-4000-8000-000000000002";
const timestamp = "2026-01-01T01:02:03.000Z";
const user = (text: string, messageId?: string) => ({ timestamp, type: "event_msg", payload: { type: "user_message", message: text, ...(messageId ? { message_id: messageId } : {}) } });
const assistant = (text: string) => ({ timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const meta = (id: string, base?: { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number }) => ({ timestamp, type: "session_meta", payload: { id, cwd: path.join(temporary, "workspace"), ...(base ? { history_base: base } : {}) } });
const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const name = (id: string, segment?: string) => path.join(sessions, `rollout-2026-01-01T00-00-00-${id}${segment ? `_${segment}` : ""}.jsonl`);
const provider = createCodexCorpusProvider({ codexHome, cacheRoot, listThreads: async () => [] });

try {
    const baseEvents = [
        meta(thread),
        { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>RULES_MUST_STAY_HIDDEN</INSTRUCTIONS>" }] } },
        user("[NAPCAT_TASK_WAKE]\ntask_id=synthetic\ngeneration=1\nwake_id=AUTOMATIC_MUST_STAY_HIDDEN\npending_message_seqs=[1]"),
        user("old-base 缓存 甲", "human-one"),
        user("连续的第二条主人消息 乙", "human-two"),
        { timestamp, type: "event_msg", payload: { type: "item_completed", item: { id: "output-one", type: "assistant_message", text: "镜像可见正文" } } },
        assistant("镜像可见正文"),
        { timestamp, type: "event_msg", payload: { type: "agent_message", message: "镜像可见正文" } },
    ];
    const prefix = encode(baseEvents);
    const basePath = name(thread, baseId);
    fs.writeFileSync(basePath, prefix + encode([user("BRANCH_ONLY_EXCLUDED"), assistant("excluded reply")]));
    const leafPath = name(thread, leafId);
    const leafEvents = [
        meta(thread, { thread_id: baseId, end_ordinal_exclusive: baseEvents.length, end_byte_offset: Buffer.byteLength(prefix) }),
        user("真实重复 缓存"),
        user("真实重复 缓存"),
        { timestamp, type: "response_item", payload: { type: "function_call", name: "test_tool", call_id: "call", arguments: "TOOL_ARGUMENT" } },
        { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "TOOL_RESULT" } },
        { timestamp, type: "response_item", payload: { type: "reasoning", summary: [{ text: "THINKING_MUST_STAY_HIDDEN" }] } },
        assistant("当前正文"),
    ];
    fs.writeFileSync(leafPath, encode(leafEvents));
    const conversation = { id: thread, title: "synthetic", workspace: path.join(temporary, "workspace"), rolloutPath: leafPath, source: "codex" as const };
    const fast = await provider.readFast(conversation, { startRound: 1, endRound: 1 }, { forceRefresh: true });
    assert.ok(fast.messages.every(message => message.round === 1));
    assert.equal(fast.messages.filter(message => message.role === "user").length, 2);
    assert.equal(fast.requestedRangeComplete, true);
    await assert.rejects(provider.readFast(conversation, { startRound: 1, endRound: 99 }, { forceRefresh: true }), /exceeds the available canonical rounds/u);
    assert.equal(fs.existsSync(cacheRoot), false);
    let appendedDuringFast = false;
    const growingFast = await provider.readFast(conversation, { startRound: 1, endRound: 1 }, { forceRefresh: true, onProgress: () => {
        if (!appendedDuringFast) { fs.appendFileSync(leafPath, encode([user("FAST_APPEND_OUTSIDE_REQUESTED_RANGE")])); appendedDuringFast = true; }
    } });
    assert.equal(growingFast.messages.filter(message => message.role === "user").length, 2);
    fs.writeFileSync(leafPath, encode(leafEvents));
    const recent = await provider.readFast(conversation, { lastRounds: 1 }, { forceRefresh: true });
    assert.ok(recent.messages.every(message => message.round === 2));
    assert.equal(recent.complete, true);
    const cold = await provider.read(conversation, {});
    assert.equal(cold.complete, true);
    assert.equal(cold.messages.filter(message => message.role === "user").length, 4);
    assert.deepEqual(cold.messages.filter(message => message.role === "user").map(message => message.round), [1, 1, 2, 2]);
    assert.equal(cold.messages.filter(message => message.text === "镜像可见正文").length, 1);
    assert.equal(new Set(cold.messages.map(message => message.id)).size, cold.messages.length);
    assert.ok(cold.messages.some(message => message.text.includes("old-base 缓存") && message.position.path === basePath));
    assert.ok(cold.messages.every(message => message.timestamp === timestamp));
    assert.doesNotMatch(JSON.stringify(cold), /BRANCH_ONLY_EXCLUDED|THINKING_MUST_STAY_HIDDEN|TOOL_ARGUMENT|TOOL_RESULT|RULES_MUST_STAY_HIDDEN|AUTOMATIC_MUST_STAY_HIDDEN/u);
    const normalized = mergeConsecutiveHumanRounds(buildCodexRoundsForTest([...baseEvents, ...leafEvents], "summary").rounds);
    assert.equal(Math.max(...cold.messages.map(message => message.round)), normalized.length);
    const hot = await provider.read(conversation, {});
    assert.equal(hot.revision, cold.revision);
    assert.equal(hot.timings?.cacheHit, 1);
    await assert.rejects(provider.readFast(conversation, { startRound: 1, endRound: 99 }), /exceeds the available canonical rounds/u);
    const expanded = await provider.readRounds(conversation, { revision: cold.revision, startRound: 1, endRound: 1 }, {});
    assert.deepEqual(expanded.messages, cold.messages.filter(message => message.round === 1));
    const tools = await provider.readRounds(conversation, { revision: cold.revision, lastRounds: 1, messageRoles: ["user", "assistant", "tool"] }, {});
    assert.ok(tools.messages.some(message => message.role === "tool" && message.text.includes("TOOL_RESULT")));
    assert.doesNotMatch(JSON.stringify(tools), /THINKING_MUST_STAY_HIDDEN/u);
    assert.deepEqual(tools.messages.filter(message => message.role === "user").map(message => message.id), cold.messages.filter(message => message.round === 2 && message.role === "user").map(message => message.id));
    await assert.rejects(provider.readRounds(conversation, { revision: "wrong", startRound: 1, endRound: 1 }), /revision changed/u);
    await assert.rejects(provider.readRounds(conversation, { revision: cold.revision, lastRounds: 0 }), /range is invalid/u);

    fs.appendFileSync(leafPath, encode([user("追加主人消息"), assistant("追加助手正文")]));
    const appended = await provider.read(conversation, {});
    assert.equal(appended.timings?.incrementalReplay, 1);
    assert.notEqual(appended.revision, cold.revision);
    assert.deepEqual(appended.messages.filter(message => message.role === "user").map(message => message.round), [1, 1, 2, 2, 3]);
    assert.deepEqual(appended.messages.filter(message => message.round < 3).map(message => message.id), cold.messages.map(message => message.id));
    await assert.rejects(provider.readRounds(conversation, { revision: cold.revision, startRound: 1, endRound: 1 }), /revision changed/u);

    fs.appendFileSync(leafPath, encode([user("取消中的新消息")]));
    let cancelled = false;
    await assert.rejects(provider.read(conversation, { forceRefresh: true, isCancelled: () => cancelled, onProgress: progress => { if (progress.phase === "codex_projection_publish") cancelled = true; } }), { name: "AbortError" });
    assert.equal((await readCodexCorpusCache(cacheRoot, thread, {}))?.projection.revision, appended.revision);
    const pendingNames = fs.readdirSync(path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]!));
    assert.equal(pendingNames.some(filename => filename.startsWith(".partial-")), false);
    fs.writeFileSync(leafPath, encode([leafEvents[0], user("截断后正文"), assistant("截断后回复")]));
    const truncated = await provider.read(conversation, {});
    assert.equal(truncated.messages.some(message => message.text === "追加主人消息"), false);

    const originalStats = fs.statSync(leafPath);
    fs.writeFileSync(leafPath, fs.readFileSync(leafPath, "utf8").replace("截断后正文", "同长新正文"));
    fs.utimesSync(leafPath, originalStats.atime, originalStats.mtime);
    const rewritten = await provider.read(conversation, {});
    assert.notEqual(rewritten.revision, truncated.revision);
    assert.ok(rewritten.messages.some(message => message.text === "同长新正文"));

    const compressedThread = "10000000-0000-4000-8000-000000000002";
    const compressedPath = `${name(compressedThread)}.zst`;
    const compressedBytes = Buffer.from(encode([meta(compressedThread), user("压缩 缓存"), assistant("压缩回复")]));
    fs.writeFileSync(compressedPath, zlib.zstdCompressSync(compressedBytes));
    const compressedConversation = { ...conversation, id: compressedThread, rolloutPath: compressedPath };
    const nativeProjection = await provider.read(compressedConversation, {});
    assert.ok(nativeProjection.messages.some(message => message.text === "压缩 缓存"));
    const fallback = createCodexCorpusProvider({ codexHome, cacheRoot: path.join(temporary, "fallback-cache"), listThreads: async () => [], archive: { decoder: "fzstd" } });
    const fallbackProjection = await fallback.read(compressedConversation, {});
    assert.deepEqual(fallbackProjection.messages, nativeProjection.messages);
    assert.equal(fallbackProjection.revision, nativeProjection.revision);
    assert.equal(fs.existsSync(path.join(temporary, "views")), false);
    const listed = await provider.list({ conversationIds: [compressedThread], workspaces: [temporary], workspaceMode: "under" }, {});
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, compressedThread);
    assert.ok(listed[0]!.workspace.includes("workspace"));
    fs.writeFileSync(compressedPath.slice(0, -4), compressedBytes);
    const replicaProjection = await provider.read(compressedConversation, { forceRefresh: true });
    assert.equal(replicaProjection.messages.length, nativeProjection.messages.length);
    fs.writeFileSync(compressedPath.slice(0, -4), compressedBytes.toString("utf8").replace("压缩回复", "冲突回复"));
    await assert.rejects(provider.read(compressedConversation, { forceRefresh: true }), /Conflicting plaintext\/compressed/u);

    const history = await resolveCodexHistorySourceAsync(leafPath, { roots: [sessions] });
    await assertCodexHistorySourceAsync(history);
    await assertCodexHistorySourceAsync(history);
    const preservedStats = fs.statSync(leafPath);
    fs.writeFileSync(leafPath, fs.readFileSync(leafPath, "utf8").replace("同长新正文", "中间改正文"));
    fs.utimesSync(leafPath, preservedStats.atime, preservedStats.mtime);
    await assert.rejects(assertCodexHistorySourceAsync(history), /(?:content|boundary) changed/u);

    const publishedThread = "10000000-0000-4000-8000-000000000003";
    const publishedPath = name(publishedThread);
    const publishedEvents = [meta(publishedThread), user("旧规范化缓存正文"), assistant("旧规范化缓存回复")];
    fs.writeFileSync(publishedPath, encode(publishedEvents));
    const publishedHistory = await resolveCodexHistorySourceAsync(publishedPath, { roots: [sessions] });
    const publishedRounds = mergeConsecutiveHumanRounds(buildCodexRoundsForTest(publishedEvents, "summary").rounds);
    setConversationSourceCacheDataRootForTests(path.join(temporary, "published-cache"));
    const published = await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: publishedThread }, fingerprint: { revision: publishedHistory.revision }, build: () => ({ snapshot: { codexData: { historySource: publishedHistory } }, rounds: publishedRounds }), projectRecordRound: projectConversationRoundForRecord });
    const reused = await provider.readFast({ ...conversation, id: publishedThread, rolloutPath: publishedPath }, { startRound: 1, endRound: 1 });
    assert.equal(reused.cacheGeneration, published.generation);
    assert.ok(reused.warnings.includes("published_cache_snapshot"));
    assert.equal(reused.messages.length, 2);
    const timedPublished = await provider.read({ ...conversation, id: publishedThread, rolloutPath: publishedPath }, {});
    assert.equal(timedPublished.cacheGeneration, undefined);
    assert.ok(timedPublished.messages.every(message => message.timestamp === timestamp));
    const successorPath = `${publishedPath}.zst`;
    const successorBytes = zlib.zstdCompressSync(Buffer.from(encode(publishedEvents)));
    fs.writeFileSync(successorPath, successorBytes);
    fs.unlinkSync(publishedPath);
    for (const decoder of ["native", "fzstd"] as const) {
        const successorProvider = createCodexCorpusProvider({ codexHome, cacheRoot: path.join(temporary, `successor-${decoder}`), listThreads: async () => [], archive: { decoder } });
        const successorConversation = { ...conversation, id: publishedThread, rolloutPath: publishedPath };
        const successorProjection = await successorProvider.read(successorConversation, {});
        assert.deepEqual(successorProjection.messages.map(message => message.text), ["旧规范化缓存正文", "旧规范化缓存回复"]);
        assert.equal(successorProjection.cacheGeneration, undefined);
        assert.equal((await readCodexStreamingSessionMeta(publishedPath, { decoder })).id, publishedThread);
        const successorRange = await successorProvider.readFast(successorConversation, { startRound: 1, endRound: 1 });
        assert.equal(successorRange.revision, successorProjection.revision);
        assert.equal(successorRange.complete, true);
        const corrupted = Buffer.from(successorBytes);
        corrupted[0] = 0;
        fs.writeFileSync(successorPath, corrupted);
        await assert.rejects(successorProvider.read(successorConversation, { forceRefresh: true }));
        fs.writeFileSync(successorPath, successorBytes);
    }
    const largeThread = "10000000-0000-4000-8000-000000000006";
    const largePath = name(largeThread);
    const largeEvents = [meta(largeThread), user("巨旧缓存仍读取真实来源"), assistant("只需要可见正文")];
    fs.writeFileSync(largePath, encode(largeEvents));
    const largeHistory = await resolveCodexHistorySourceAsync(largePath, { roots: [sessions] });
    const largeKey = { source: "codex:link=summary", conversationId: largeThread };
    const largePublished = await readOrBuildConversationSourceCache({ key: largeKey, fingerprint: { revision: largeHistory.revision }, build: () => ({ snapshot: { codexData: { historySource: largeHistory }, padding: "x".repeat(2 * 1024 * 1024) }, rounds: mergeConsecutiveHumanRounds(buildCodexRoundsForTest(largeEvents, "summary").rounds) }), projectRecordRound: projectConversationRoundForRecord });
    const largeDirectory = path.join(temporary, "published-cache", "conversation-cache", "v1", createHash("sha256").update(`${largeKey.source}\u0000${largeThread}`).digest("hex"));
    const largeManifest = JSON.parse(fs.readFileSync(path.join(largeDirectory, "manifest.json"), "utf8"));
    const largeSnapshotPath = path.join(largeDirectory, largeManifest.files.snapshot.file);
    assert.ok(largeManifest.files.snapshot.bytes > 1024 * 1024);
    const originalRead = fs.readFileSync;
    const originalOpen = fs.openSync;
    let largeSnapshotReads = 0;
    const guardSnapshot = (candidate: unknown): void => {
        if (typeof candidate === "string" && candidate === largeSnapshotPath) {
            largeSnapshotReads += 1;
            throw new Error("large legacy snapshot must not be opened");
        }
    };
    fs.readFileSync = ((...arguments_: unknown[]) => { guardSnapshot(arguments_[0]); return Reflect.apply(originalRead, fs, arguments_); }) as typeof originalRead;
    fs.openSync = ((...arguments_: unknown[]) => { guardSnapshot(arguments_[0]); return Reflect.apply(originalOpen, fs, arguments_); }) as typeof originalOpen;
    try {
        const largeProjection = await provider.read({ ...conversation, id: largeThread, rolloutPath: largePath }, {});
        assert.notEqual(largeProjection.cacheGeneration, largePublished.generation);
        assert.deepEqual(largeProjection.messages.map(message => message.text), ["巨旧缓存仍读取真实来源", "只需要可见正文"]);
        assert.equal(largeSnapshotReads, 0);
    } finally { fs.readFileSync = originalRead; fs.openSync = originalOpen; }
    const subagentThread = "10000000-0000-4000-8000-000000000004";
    const subagentPath = name(subagentThread);
    fs.writeFileSync(subagentPath, encode([meta(subagentThread), user("主人的真实问题"), assistant("真实助手正文"), user('<subagent_notification>{"agent_path":"synthetic-child","agent_nickname":"Synthetic","status":{"completed":"SUBAGENT_DETAIL"}}</subagent_notification>')]));
    const subagentConversation = { ...conversation, id: subagentThread, rolloutPath: subagentPath };
    const subagentDefault = await provider.read(subagentConversation, {});
    assert.equal(subagentDefault.messages.length, 2);
    assert.doesNotMatch(JSON.stringify(subagentDefault.messages), /SUBAGENT_DETAIL/u);
    const subagentExpanded = await provider.readRounds(subagentConversation, { revision: subagentDefault.revision, startRound: 1, endRound: 1, messageRoles: ["subagent"] });
    assert.ok(subagentExpanded.messages.some(message => message.role === "subagent" && message.text.includes("SUBAGENT_DETAIL")));
    const childThread = "10000000-0000-4000-8000-000000000007";
    const childPath = name(childThread);
    const childHeader = meta(childThread, { thread_id: baseId, end_ordinal_exclusive: baseEvents.length, end_byte_offset: Buffer.byteLength(prefix) });
    fs.writeFileSync(childPath, encode([{ ...childHeader, payload: { ...childHeader.payload, source: { subagent: { thread_spawn: { parent_thread_id: thread, agent_nickname: "Synthetic Child" } } } } }, user("CHILD_TASK_PROMPT"), assistant("CHILD_TASK_REPLY")]));
    const childConversation = (await provider.list({ conversationIds: [childThread] }, {}))[0]!;
    assert.equal(childConversation.isChildThread, true);
    assert.equal(childConversation.parentConversationId, thread);
    const childDefault = await provider.read(childConversation, {});
    assert.ok(childDefault.messages.some(message => message.sourceThreadId === thread && message.role === "user"));
    assert.doesNotMatch(JSON.stringify(childDefault.messages), /CHILD_TASK_PROMPT|CHILD_TASK_REPLY/u);
    const childDetailed = await provider.read(childConversation, { messageRoles: ["subagent"] });
    assert.equal(childDetailed.revision, childDefault.revision);
    assert.deepEqual(childDetailed.messages.map(message => message.text), ["CHILD_TASK_PROMPT", "CHILD_TASK_REPLY"]);
    assert.ok(childDetailed.messages.every(message => message.authorKind === "subagent" && message.sourceThreadId === childThread));
    const childExpanded = await provider.readRounds(childConversation, { revision: childDetailed.revision, messageRoles: ["subagent"], startRound: 2, endRound: 2 });
    assert.deepEqual(childExpanded.messages.map(message => message.id), childDetailed.messages.map(message => message.id));
    const forkThread = "10000000-0000-4000-8000-000000000009";
    const forkPath = name(forkThread);
    const forkHeader = meta(forkThread, { thread_id: baseId, end_ordinal_exclusive: baseEvents.length, end_byte_offset: Buffer.byteLength(prefix) });
    fs.writeFileSync(forkPath, encode([{ ...forkHeader, payload: { ...forkHeader.payload, source: "cli", parent_thread_id: thread } }, user("FORK_REAL_HUMAN"), assistant("FORK_REAL_ASSISTANT")]));
    const forkConversation = (await provider.list({ conversationIds: [forkThread] }, {}))[0]!;
    assert.equal(forkConversation.isChildThread, false);
    assert.equal(forkConversation.parentConversationId, thread);
    const forkBody = await provider.read(forkConversation, {});
    assert.ok(forkBody.messages.some(message => message.role === "user" && message.text === "FORK_REAL_HUMAN" && message.sourceThreadId === forkThread));
    assert.ok(forkBody.messages.some(message => message.role === "assistant" && message.text === "FORK_REAL_ASSISTANT"));
    assert.equal((await provider.read(forkConversation, { messageRoles: ["subagent"] })).messages.length, 0);
    const pureChildThread = "10000000-0000-4000-8000-000000000010";
    const pureChildPath = name(pureChildThread);
    fs.writeFileSync(pureChildPath, encode([{ ...meta(pureChildThread), payload: { id: pureChildThread, source: { subagent: { thread_spawn: { parent_thread_id: thread } } } } }, user("PURE_CHILD_TASK"), { type: "response_item", payload: { type: "function_call", call_id: "child-tool", name: "child_tool", arguments: "{}" } }, { type: "response_item", payload: { type: "function_call_output", call_id: "child-tool", output: "PURE_CHILD_TOOL" } }, assistant("PURE_CHILD_REPLY")]));
    const pureChildConversation = { ...conversation, id: pureChildThread, rolloutPath: pureChildPath };
    const excludedChild = await provider.read(pureChildConversation, {});
    assert.equal(excludedChild.messages.length, 0);
    assert.ok(excludedChild.revision.startsWith("role-excluded:"));
    assert.equal(await readCodexCorpusCache(cacheRoot, pureChildThread, {}), null);
    const pureSubagents = await provider.read(pureChildConversation, { messageRoles: ["subagent"] });
    assert.deepEqual(pureSubagents.messages.map(message => message.text), ["PURE_CHILD_TASK", "PURE_CHILD_REPLY"]);
    const pureTools = await provider.read(pureChildConversation, { messageRoles: ["tool"] });
    assert.ok(pureTools.messages.some(message => message.text.includes("PURE_CHILD_TOOL")));
    const legacySubagentHistory = await resolveCodexHistorySourceAsync(subagentPath, { roots: [sessions] });
    await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: subagentThread }, fingerprint: { revision: legacySubagentHistory.revision }, build: () => ({ snapshot: { codexData: { historySource: legacySubagentHistory } }, rounds: mergeConsecutiveHumanRounds(buildCodexRoundsForTest([meta(subagentThread), user("主人的真实问题"), assistant("真实助手正文"), user('<subagent_notification>{"agent_path":"synthetic-child","agent_nickname":"Synthetic","status":{"completed":"SUBAGENT_DETAIL"}}</subagent_notification>')], "summary").rounds) }), projectRecordRound: projectConversationRoundForRecord });
    const legacyProvider = createCodexCorpusProvider({ codexHome, cacheRoot: path.join(temporary, "legacy-subagent-body"), listThreads: async () => [] });
    assert.ok((await legacyProvider.readFast(subagentConversation, { startRound: 1, endRound: 1 })).cacheGeneration);
    const legacySubagents = await legacyProvider.read(subagentConversation, { messageRoles: ["subagent"] });
    assert.ok(legacySubagents.messages.some(message => message.text.includes("SUBAGENT_DETAIL")));
    const concurrentRoot = path.join(temporary, "concurrent-cache");
    const cachedEntry = await readCodexCorpusCache(cacheRoot, subagentThread, {});
    assert.ok(cachedEntry);
    const oldBodyRoot = path.join(temporary, "old-body-cache");
    for (const format of ["codex-corpus-body/v1", "codex-corpus-body/v2"]) {
        await publishCodexCorpusCache(oldBodyRoot, { ...cachedEntry!, format } as any, {});
        assert.equal(await readCodexCorpusCache(oldBodyRoot, subagentThread, {}), null);
    }
    await Promise.all([0, 1, 2, 3].map(index => publishCodexCorpusCache(concurrentRoot, { ...cachedEntry!, projection: { ...cachedEntry!.projection, revision: `synthetic-concurrent-${index}` } }, {})));
    const finalEntry = await readCodexCorpusCache(concurrentRoot, subagentThread, {});
    assert.ok(finalEntry?.projection.revision.startsWith("synthetic-concurrent-"));
    const concurrentDirectory = path.join(concurrentRoot, fs.readdirSync(concurrentRoot)[0]!);
    assert.equal(fs.readdirSync(concurrentDirectory).some(filename => filename.startsWith(".partial-") || filename === ".publish.lock"), false);
    assert.ok(fs.readdirSync(concurrentDirectory).filter(filename => /^[a-f0-9]{64}\.json$/u.test(filename)).length <= 2);

    const explicitThread = "10000000-0000-4000-8000-000000000005";
    const explicitBaseId = "20000000-0000-4000-8000-000000000005";
    const explicitLeafId = "20000000-0000-4000-8000-000000000006";
    const explicitBase = [{ ...meta(explicitThread), ordinal: 0 }, { ...user("显式旧段"), ordinal: 10 }, { ...assistant("显式旧回复"), ordinal: 15 }];
    const explicitBaseBytes = encode(explicitBase);
    fs.writeFileSync(name(explicitThread, explicitBaseId), explicitBaseBytes);
    const explicitPath = name(explicitThread, explicitLeafId);
    fs.writeFileSync(explicitPath, encode([{ ...meta(explicitThread, { thread_id: explicitBaseId, end_ordinal_exclusive: 16, end_byte_offset: Buffer.byteLength(explicitBaseBytes) }), ordinal: 16 }, { ...user("显式当前"), ordinal: 20 }, { ...assistant("显式当前回复"), ordinal: 21 }]));
    const explicitConversation = { ...conversation, id: explicitThread, rolloutPath: explicitPath };
    const explicitCold = await provider.read(explicitConversation, {});
    assert.deepEqual(explicitCold.messages.filter(message => message.role === "user").map(message => message.position.ordinal), [10, 20]);
    fs.appendFileSync(explicitPath, encode([{ ...user("显式新增"), ordinal: 30 }, { ...assistant("显式新增回复"), ordinal: 31 }]));
    const explicitAppend = await provider.read(explicitConversation, {});
    assert.equal(explicitAppend.timings?.incrementalReplay, 1);
    assert.deepEqual(explicitAppend.messages.filter(message => message.role === "user").map(message => message.round), [1, 2, 3]);
    console.log("conversation corpus Codex reader tests passed: canonical rounds, mirrors, historical prefixes, revisions, append/truncate/rewrite, cancellation, native/fallback, replicas, published cache");
} finally {
    resetConversationSourceCacheForTests();
    setConversationSourceCacheDataRootForTests(undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
}
