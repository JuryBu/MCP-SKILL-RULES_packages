import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { UnifiedConversationCandidate } from "../src/conversation-filter.js";
import type { DevinConversationOptions } from "../src/devin-conversation.js";
import type { DevinRawConversation } from "../src/devin-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan62-wsf-probe-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_RECORD_AUTO_UPDATE = "false";
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(temporary, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(temporary, "absent-desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(temporary, "absent-jobs.json");
process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(temporary, "absent-pb");
process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(temporary, "absent-implicit");
const { createContextLocateAdapters } = await import("../src/conversation-context-locate-adapters.js");
const { locateConversationContext } = await import("../src/conversation-context-locate.js");
const { listConversationCandidates } = await import("../src/conversation-filter.js");
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const marker = "Plan62 recent visible message marker";
const candidate: UnifiedConversationCandidate = { id: "probe-fixture", dataChain: "windsurf", sourceKind: "devin-cli",
    title: "Probe fixture", workspace: temporary, updatedAt: "2026-11-03T01:00:00Z", detail: "devin-cli", sourceBytes: 1024 * 1024 * 1024 };

function round(roundIndex: number, text: string): ConversationRound {
    return { roundIndex, startStep: roundIndex, endStep: roundIndex, userMessage: text,
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

function fixture(totalRounds: number, matchingRound: number, physicalBytes = 4096) {
    const calls: DevinConversationOptions[] = [];
    const read = async (_id: string, options: DevinConversationOptions = {}) => {
        calls.push(options);
        const range = options.roundRange;
        const startRound = range ? "tailRounds" in range ? Math.max(1, totalRounds - range.tailRounds + 1) : range.startRound : 1;
        const endRound = range && "endRound" in range ? range.endRound || totalRounds : totalRounds;
        const raw: DevinRawConversation = { summary: { id: candidate.id, canonicalId: candidate.id, aliases: [candidate.id],
            title: candidate.title, cwd: temporary, workspaceUris: [temporary], sourcePath: "synthetic.db", desktopPaths: [],
            sourceKind: "devin-cli", matchedMessageIds: 1, partial: false, warnings: [] }, nodes: [], desktopMessages: [], compactions: [],
            partial: false, warnings: [], fingerprint: { revision: "fixture" },
            ...(range ? { coverage: { unit: "round" as const, startRound, endRound, totalRounds, startStep: startRound,
                endStepExclusive: endRound + 1, totalSteps: totalRounds, complete: startRound === 1 && endRound === totalRounds } } : {}),
            readMetrics: { identityMs: 0, bodyReadMs: 0, totalMs: 0, bytesRead: physicalBytes, recordsRead: endRound - startRound + 1, identityCacheHit: false },
        };
        return { raw, rounds: Array.from({ length: endRound - startRound + 1 }, (_, index) => {
            const roundIndex = startRound + index;
            return round(roundIndex, roundIndex === matchingRound ? marker : "other");
        }) };
    };
    return { calls, read, adapters: createContextLocateAdapters(read) };
}

test("probe checks tail 12 and stops on a recent hit, with separate physical and visible-text budgets", async () => {
    const source = fixture(103, 101, 32 * 1024 * 1024);
    const result = await locateConversationContext([candidate], marker, { probe: true, maxBytes: 1024, adapters: source.adapters });
    assert.equal(result.hits[0]?.roundIndex, 101);
    assert.equal(source.calls.length, 1);
    assert.deepEqual(source.calls[0]?.roundRange, { tailRounds: 12 });
    assert.equal(source.calls[0]?.materializeAttachments, false);
    assert.equal(source.calls[0]?.maxBytes, 128 * 1024 * 1024);
    assert.ok(result.scannedBytes < 1024);
    assert.equal(result.resolution, "single_match_in_partial_scan");
    assert.ok(result.warnings.some(warning => warning.includes("R92-R103/103")));
});

test("recent misses search older non-overlapping windows and stop on an older hit", async () => {
    const source = fixture(40, 5);
    const result = await locateConversationContext([candidate], marker, { probe: true, maxBytes: 4096, adapters: source.adapters });
    assert.equal(result.hits[0]?.roundIndex, 5);
    assert.deepEqual(source.calls.map(call => call.roundRange), [
        { tailRounds: 12 }, { startRound: 17, endRound: 28 }, { startRound: 5, endRound: 16 },
    ]);
    assert.deepEqual(source.calls.map(call => call.maxBytes), [128 * 1024 * 1024, 128 * 1024 * 1024 - 4096, 128 * 1024 * 1024 - 8192]);
    assert.equal(result.truncated, true);
    assert.ok(result.warnings.some(warning => warning.includes("older content")));
});

test("probe rejects its own historical query-argument echo while explicit locate keeps tool evidence", async () => {
    const source = fixture(25, 0);
    const args = JSON.stringify({ action: "list", dataChain: "windsurf", contextProbe: marker });
    const adapters = createContextLocateAdapters(async (id, options) => {
        const loaded = await source.read(id, options);
        const last = loaded.rounds.at(-1)!;
        last.toolCalls = [{ stepIndex: last.endStep, toolName: "conversation_read_original", argsFull: args,
            argsSummary: args, resultFull: JSON.stringify({ echoedArguments: args }), resultSummary: "query response" }] as any;
        last.semanticEvents = [{ semanticRole: "tool", rawRole: "tool", text: args, argsFull: args }];
        return loaded;
    });
    const target = { ...candidate, sourceBytes: undefined };
    const probe = await locateConversationContext([target], marker, { probe: true, maxRounds: 12, adapters });
    assert.deepEqual(probe.hits, [], "a contextProbe string present only in the earlier query arguments cannot identify this conversation");
    assert.equal(probe.resolution, "unverified");
    const explicit = await locateConversationContext([target], marker, { adapters });
    assert.ok(explicit.hits.some(hit => hit.role === "tool_args"));
    assert.ok(explicit.hits.some(hit => hit.role === "tool_result"));
});

test("probe selects visible assistant text and excludes the same text in tool arguments and thinking", async () => {
    const source = fixture(103, 0);
    const adapters = createContextLocateAdapters(async (id, options) => {
        const loaded = await source.read(id, options);
        const last = loaded.rounds.at(-1)!;
        last.aiResponses = [{ stepIndex: last.endStep, response: marker, thinking: marker, toolCalls: [] }];
        last.toolCalls = [{ stepIndex: last.endStep, toolName: "conversation_read_original", argsFull: JSON.stringify({ contextProbe: marker }), argsSummary: "probe" }] as any;
        return loaded;
    });
    const result = await locateConversationContext([candidate], marker, { probe: true, adapters });
    assert.deepEqual(result.hits.map(hit => hit.role), ["assistant"]);
    assert.equal(source.calls.length, 1);
});

test("a bounded no-hit probe remains unverified, while an exhausted complete main transcript can report no match", async () => {
    const bounded = fixture(40, 0);
    const partial = await locateConversationContext([candidate], marker, { probe: true, maxRounds: 12, adapters: bounded.adapters });
    assert.equal(partial.status, "budget_exhausted");
    assert.equal(partial.resolution, "unverified");
    assert.equal(bounded.calls.length, 1);
    const complete = fixture(20, 0);
    const full = await locateConversationContext([candidate], marker, { probe: true, adapters: complete.adapters });
    assert.equal(full.status, "no_hit_after_full_scan");
    assert.deepEqual(complete.calls.map(call => call.roundRange), [{ tailRounds: 12 }, { startRound: 1, endRound: 8 }]);
});

test("physical-source exhaustion is explicit and does not start a full-parent child retry", async () => {
    let reads = 0;
    let children = 0;
    const contextAdapters = createContextLocateAdapters(async () => {
        reads++;
        throw Object.assign(new Error("Devin SQLite reading exceeded maxBytes; no complete result was returned."), { code: "DEVIN_BYTE_BUDGET" });
    });
    const result = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", contextProbe: marker,
        adapters: { localList: async () => [candidate], windsurf: { list: () => [], resolve: () => null,
            discoverChildren: async () => { children++; return { candidates: [], verifiedParents: [], warnings: [] }; },
        } } as any, contextAdapters });
    assert.equal(reads, 1);
    assert.equal(children, 0);
    assert.equal(result.partial, true);
    assert.equal(result.contextLocate?.resolution, "unverified");
    assert.ok(result.contextLocate?.warnings.some(warning => warning.includes("DEVIN_BYTE_BUDGET")));
});

test("child transcripts remain readable without requesting unsupported child round ranges", async () => {
    const source = fixture(2, 2);
    const child = { ...candidate, id: "probe-fixture--subagent-worker", isChildThread: true, parentConversationId: candidate.id };
    const result = await locateConversationContext([child], marker, { probe: true, adapters: source.adapters });
    assert.equal(result.hits.length, 1);
    assert.equal(source.calls[0]?.roundRange, undefined);
    assert.equal(source.calls[0]?.materializeAttachments, false);
});

test("Desktop-only probing preserves physical identity and does not request unsupported main-chain ranges", async () => {
    const source = fixture(2, 2);
    const desktop = { ...candidate, id: "11111111-2222-3333-4444-555555555555", sourceKind: "devin-desktop" };
    const result = await locateConversationContext([desktop], marker, { probe: true, adapters: source.adapters });
    assert.equal(result.hits.length, 1);
    assert.equal(source.calls[0]?.roundRange, undefined);
    assert.equal(source.calls[0]?.identityMode, "physical");
    assert.equal(source.calls[0]?.physicalSourceKind, "devin-desktop");
});

test("an expired probe deadline starts no source reads", async () => {
    const source = fixture(40, 5);
    const result = await source.adapters.scanStream!(candidate, marker, { source: "local", mode: "exact", probe: true,
        maxBytes: 1024, maxHits: 20, maxRounds: 100, deadlineAt: Date.now() - 1, isCancelled: () => false });
    assert.equal(source.calls.length, 0);
    assert.equal(result?.partial, true);
    assert.deepEqual(result?.hits, []);
});

test("cancellation after a recent read stops body scanning and older reads", async () => {
    let cancelled = false;
    const adapters = createContextLocateAdapters(async id => {
        cancelled = true;
        return { raw: { summary: { id, canonicalId: id, aliases: [id], sourceKind: "devin-cli", title: id, workspaceUris: [],
            sourcePath: "synthetic.db", desktopPaths: [], matchedMessageIds: 0, partial: false, warnings: [] }, nodes: [], desktopMessages: [],
            compactions: [], partial: false, warnings: [], fingerprint: { revision: "fixture" },
            coverage: { unit: "round", startRound: 29, endRound: 40, totalRounds: 40, startStep: 1, endStepExclusive: 13, totalSteps: 40, complete: false } },
            rounds: [round(40, marker)] };
    });
    const result = await locateConversationContext([candidate], marker, { probe: true, adapters, isCancelled: () => cancelled });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.hits, []);
});

test("native isolated list locates recent text despite much larger physical JSON metadata", async () => {
    const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH!);
    database.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,working_directory TEXT,title TEXT); CREATE TABLE message_nodes(node_id INTEGER PRIMARY KEY,parent_node_id INTEGER,session_id TEXT,chat_message TEXT,metadata TEXT,created_at INTEGER)");
    database.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(candidate.id, 25, temporary, candidate.title);
    const insert = database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
    const padding = "x".repeat(64 * 1024);
    for (let roundIndex = 1; roundIndex <= 25; roundIndex++) insert.run(roundIndex, roundIndex === 1 ? null : roundIndex - 1, candidate.id,
        JSON.stringify({ role: "user", content: roundIndex === 24 ? marker : "other", metadata: { is_user_input: true, padding } }), "{}", 1700000000 + roundIndex);
    database.close();
    const before = fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH!);
    const result = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", conversationIds: [candidate.id],
        workspaces: [temporary], workspaceMode: "exact", contextProbe: marker, maxBytes: 64 * 1024, deadlineMs: 12000 });
    assert.deepEqual(result.candidates.map(item => item.id), [candidate.id], JSON.stringify(result));
    assert.equal(result.contextLocate?.hits[0]?.roundIndex, 24);
    assert.equal(result.contextLocate?.candidateFailures?.length, 0);
    assert.ok((result.contextLocate?.scannedBytes || 0) < 64 * 1024);
    assert.equal(result.contextLocate?.resolution, "single_match_in_partial_scan");
    assert.deepEqual(fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH!), before);
});
