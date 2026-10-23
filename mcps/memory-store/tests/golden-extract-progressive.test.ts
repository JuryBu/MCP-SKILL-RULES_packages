import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConversationRound } from "../src/trajectory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "golden-progressive-fictional-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { registerGoldenExtract } = await import("../src/tools/golden-extract.ts");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.ts");
const { openProgressiveTaskCache } = await import("../src/conversation-progressive-task.ts");
const { waitForBackgroundTask, getBackgroundTask } = await import("../src/background-tasks.ts");
const ownerId = "fictional-caller-owner";
const source = { host: "codex", conversationId: "fictional-source-target", revision: "fictional-revision-1",
    snapshot: { files: ["fictional.jsonl"] }, totalRounds: 4 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function round(index: number): ConversationRound {
    const selected = index === 2;
    const user = selected ? "SELECTED_CANONICAL_USER fictional question with enough context for an extraction." : "UNSELECTED_PRIVATE_SENTINEL";
    return { roundIndex: index, startStep: index * 2, endStep: index * 2 + 1, createdAt: "2026-01-02T03:04:05Z",
        userMessage: user, userMessages: [{ text: user, stepIndex: index * 2, rawRole: "user", semanticRole: "user" }],
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
        semanticEvents: [{ stepIndex: index * 2 + 1, semanticRole: "model", rawRole: "assistant",
            kind: "response", text: selected ? "SELECTED_CANONICAL_ANSWER preserved only in semantic events." : "UNSELECTED_PRIVATE_SENTINEL" },
        { stepIndex: index * 2 + 1, semanticRole: "tool", rawRole: "tool", kind: "tool_result", name: "fictional-tool",
            text: selected ? "SELECTED_TOOL_RESULT" : "UNSELECTED_PRIVATE_SENTINEL" }] };
}

async function fixture(ready = true) {
    const taskId = `progressive-${randomUUID()}`;
    const taskRoot = path.join(root, "tasks");
    const directory = path.join(taskRoot, hash(ownerId), taskId);
    const generation = path.join(directory, "ranges", "fictional-generation");
    const cache = await openProgressiveCache({ root: generation, source });
    const writer = await cache.beginWrite();
    const rounds = [round(2), round(3)];
    const block = await cache.publish(writer, { coverage: { kind: "absolute", startRound: 2, endRound: 3 },
        anchor: { name: "fictional-anchor" }, rounds, messages: rounds.map(value => ({ id: `projection-${value.roundIndex}`,
            round: value.roundIndex, role: "user" as const, text: "LOSSY_PROJECTED_MESSAGE_ONLY", position: { ordinal: value.startStep } })) });
    const rows = (await cache.read({ blockId: block.blockId, direction: "oldest" })).rows;
    const payload = { version: 1, taskId, directory, request: { ownerId, conversationId: source.conversationId,
        direction: "latest", initialRounds: 3, buildFull: true, dataChain: "codex" } };
    await fs.writeFile(path.join(directory, "request.json"), JSON.stringify({ version: 1, payload, attempt: 1, backgroundTaskId: `${taskId}-1` }));
    const state = { version: 1, phase: ready ? "published" : "source", previous: [] as Array<{ directory: string; source: typeof source }>,
        current: ready ? { directory: generation, source } : undefined, requestedRangeComplete: false,
        warnings: [], updatedAt: "2026-01-02T03:04:05Z" };
    await fs.writeFile(path.join(directory, "ready.json"), JSON.stringify(state));
    return { taskId, taskRoot, directory, cache, rows, state };
}

function harness(taskRoot: string) {
    let callback!: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    let legacyCalls = 0;
    let openCalls = 0;
    const prompts: string[] = [];
    let modelText = "[发现] fictional selected evidence";
    const legacyRound = { ...round(1), userMessage: "LEGACY_FULL_ROUTE_SENTINEL fictional complete conversation with enough text.",
        semanticEvents: [], aiResponses: [{ stepIndex: 3, response: "Legacy complete reply preserved.", thinking: "", toolCalls: [] }] };
    registerGoldenExtract({ tool: (...values: unknown[]) => { callback = values.at(-1) as typeof callback; } } as unknown as McpServer, {
        openProgressiveCache: async (identity, ref) => {
            openCalls++;
            assert.equal(identity.root, undefined);
            return openProgressiveTaskCache({ ...identity, root: taskRoot }, ref);
        },
        loadConversation: async () => {
            legacyCalls++;
            return { conversationId: "fictional-legacy-target", chainUsed: "codex", rounds: [legacyRound], totalSteps: 4 } as
                NonNullable<Awaited<ReturnType<typeof import("../src/conversation-bridge.ts").loadConversationData>>>;
        },
        callModel: async (_model, prompt) => {
            prompts.push(prompt);
            return { text: modelText, chainUsed: "codex", modelUsed: "fictional-model" };
        },
    });
    return { run: (args: Record<string, unknown>) => callback({ background: false, autoCompare: false, ...args }),
        prompts, counts: () => ({ legacyCalls, openCalls }), setModelText: (value: string) => { modelText = value; } };
}

test("published refs use canonical rounds only and disclose partial source/range while task is still building", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    const ref = current.rows[0].ref;
    const result = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [ref, ref] });
    assert.deepEqual(fake.counts(), { legacyCalls: 0, openCalls: 1 });
    assert.equal(fake.prompts.length, 1);
    assert.match(fake.prompts[0], /SELECTED_CANONICAL_USER/u);
    assert.match(fake.prompts[0], /SELECTED_CANONICAL_ANSWER/u);
    assert.match(fake.prompts[0], /SELECTED_TOOL_RESULT/u);
    assert.doesNotMatch(fake.prompts[0], /UNSELECTED_PRIVATE_SENTINEL|LOSSY_PROJECTED_MESSAGE_ONLY|LEGACY_FULL_ROUTE_SENTINEL/u);
    for (const text of [fake.prompts[0], result.content[0].text]) {
        assert.match(text, /partial=true; source=codex:fictional-source-target/u);
        assert.match(text, /fullSourceComplete=false/u);
        assert.ok(text.includes(ref));
        assert.match(text, /"round":2/u);
    }
});

test("wrong owner is rejected before model or complete-cache fallback", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    const result = await fake.run({ conversationId: "fictional-other-owner", progressiveTaskId: current.taskId, rangeRefs: [current.rows[0].ref] });
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.counts().legacyCalls, 0);
    assert.match(result.content[0].text, /❌|ENOENT|失败/u);
});

test("invalid and unpublished references never reach the model", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    const parts = current.rows[0].ref.split(":");
    parts[3] = "f".repeat(64);
    for (const ref of ["invalid-ref", parts.join(":")]) {
        const result = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [ref] });
        assert.match(result.content[0].text, /❌|Reference|published|reference/u);
    }
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.counts().legacyCalls, 0);
});

test("a task with no ready generation cannot supply an unfinished range", async () => {
    const current = await fixture(false);
    const fake = harness(current.taskRoot);
    const result = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [current.rows[0].ref] });
    assert.match(result.content[0].text, /No range is ready/u);
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.counts().legacyCalls, 0);
});

test("explicit selection requires caller and task, and preserves the legacy route when nothing was selected", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    for (const args of [{ rangeRefs: [current.rows[0].ref] },
        { conversationId: ownerId, rangeRefs: [current.rows[0].ref] },
        { conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [current.rows[0].ref], stepStart: 0 }]) {
        const result = await fake.run(args);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /必须显式提供|请选择一种范围输入/u);
    }
    assert.equal(fake.prompts.length, 0);
    assert.deepEqual(fake.counts(), { legacyCalls: 0, openCalls: 0 });
    for (const args of [{ conversationId: "fictional-legacy-target" }, {}]) {
        const result = await fake.run(args);
        assert.match(result.content[0].text, /fictional selected evidence/u);
        assert.doesNotMatch(result.content[0].text, /partial=true/u);
    }
    assert.deepEqual(fake.counts(), { legacyCalls: 2, openCalls: 0 });
    assert.ok(fake.prompts.every(prompt => prompt.includes("LEGACY_FULL_ROUTE_SENTINEL")));
});

test("incomplete explicit range arguments reject before any source or model call", async () => {
    const selections = [
        { progressiveTaskId: "progressive-fictional-task" },
        { progressiveTaskId: "progressive-fictional-task", rangeRefs: [] },
        { rangeRefs: [] },
        { progressiveTaskId: "", rangeRefs: [] },
    ];
    for (const background of [false, true, undefined]) {
        for (const selection of selections) {
            const fake = harness(path.join(root, "unused-fictional-tasks"));
            const result = await fake.run({ conversationId: ownerId, ...selection, background });
            assert.deepEqual(fake.counts(), { legacyCalls: 0, openCalls: 0 });
            assert.equal(fake.prompts.length, 0);
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /rangeRefs|必须显式提供/u);
            assert.doesNotMatch(result.content[0].text, /🆔 taskId:/u);
        }
    }
});

test("empty model extraction retains the selected source/range disclosure", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    fake.setModelText("无");
    const result = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [current.rows[0].ref] });
    assert.match(result.content[0].text, /partial=true; source=codex:fictional-source-target/u);
    assert.match(result.content[0].text, /未发现需要提取/u);
});

test("refs from different source generations cannot be combined", async () => {
    const current = await fixture();
    const olderSource = { ...source, revision: "fictional-older-revision" };
    const olderDirectory = path.join(current.directory, "ranges", "fictional-older-generation");
    const older = await openProgressiveCache({ root: olderDirectory, source: olderSource });
    const writer = await older.beginWrite();
    await older.publish(writer, { coverage: { kind: "absolute", startRound: 2, endRound: 2 },
        anchor: { name: "fictional-older-anchor" }, rounds: [round(2)], messages: [] });
    const olderRef = (await older.read()).rows[0].ref;
    current.state.previous.push({ directory: olderDirectory, source: olderSource });
    await fs.writeFile(path.join(current.directory, "ready.json"), JSON.stringify(current.state));
    const fake = harness(current.taskRoot);
    const result = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId,
        rangeRefs: [current.rows[0].ref, olderRef] });
    assert.match(result.content[0].text, /同一来源版本/u);
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.counts().legacyCalls, 0);
});

test("background extraction freezes the owner and range refs without source-wide resolution", async () => {
    const current = await fixture();
    const fake = harness(current.taskRoot);
    const launched = await fake.run({ conversationId: ownerId, progressiveTaskId: current.taskId, rangeRefs: [current.rows[0].ref], background: true });
    const taskId = /🆔 taskId: ([^\s]+)/u.exec(launched.content[0].text)?.[1];
    assert.ok(taskId);
    const task = await waitForBackgroundTask(taskId, 5);
    assert.ok(task);
    assert.equal(task.status, "done");
    const payload = getBackgroundTask(taskId)?.resumePayload as { conversationId: string; progressiveTaskId: string; rangeRefs: string[] };
    assert.equal(payload.conversationId, ownerId);
    assert.equal(payload.progressiveTaskId, current.taskId);
    assert.deepEqual(payload.rangeRefs, [current.rows[0].ref]);
    assert.equal(fake.prompts.length, 1);
    assert.equal(fake.counts().legacyCalls, 0);
});

test("cleanup owned fictional fixtures", async () => { await fs.rm(root, { recursive: true, force: true }); });
