import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ConversationSourceAdapters, ListConversationCandidatesOptions, ListConversationCandidatesResult, UnifiedConversationCandidate } from "../src/conversation-filter.js";
import type { ConversationContextHit, ConversationContextLocateAdapters } from "../src/conversation-context-locate.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-plan63-multisource-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_RECORD_AUTO_UPDATE = "false";
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { listConversationCandidates } = await import("../src/conversation-filter.js");
const workspace = path.join(temporary, "synthetic-workspace");
const marker = "a unique synthetic statement for independent source verification";
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const never = (): Promise<never> => new Promise(() => undefined);
const row = (id: string, extra: Record<string, unknown> = {}): any => ({ id, cwd: workspace, title: id, updatedAtMs: 1, ...extra });
const adapters = (codex: ConversationSourceAdapters["codex"]["list"], claude: ConversationSourceAdapters["claude-code"]["list"]): ConversationSourceAdapters => ({
    codex: { list: codex, get: () => null },
    "claude-code": { list: claude, get: () => null },
    antigravity: { list: () => [] }, windsurf: { list: () => [], resolve: () => null },
    dsh: { list: () => [], get: () => null },
});
const hit = (candidate: UnifiedConversationCandidate): ConversationContextHit => ({
    dataChain: candidate.dataChain, conversationId: candidate.id, source: "message_body_hit", mode: "exact", role: "user",
    roundIndex: 1, snippet: marker, sourcePosition: { kind: "round", roundIndex: 1 }, freshness: "fresh",
});
const readers = (matches: (candidate: UnifiedConversationCandidate) => boolean = () => true, pause = 0): ConversationContextLocateAdapters => ({
    readRounds: async () => { throw new Error("Unexpected synthetic fallback"); },
    scanStream: async candidate => {
        if (pause) await delay(pause);
        return { hits: matches(candidate) ? [hit(candidate)] : [], scannedBytes: 10 };
    },
});
const defaults = (overrides: ListConversationCandidatesOptions): ListConversationCandidatesOptions => ({
    dataChains: ["codex", "claude-code"], contextProbe: marker, deadlineMs: 1000,
    adapters: adapters(() => [row("synthetic-codex")], () => [row("synthetic-claude")]), contextAdapters: readers(), ...overrides,
});
after(() => {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
});

test("one readable candidate receives the full byte budget even when metadata returns more candidates", async () => {
    const reserved: number[] = [];
    const result = await listConversationCandidates(defaults({
        dataChains: ["codex"], candidateLimit: 1, maxBytes: 100,
        adapters: adapters(() => Array.from({ length: 10 }, (_, index) => row("synthetic-" + index)), () => []),
        contextAdapters: {
            readRounds: async () => { throw new Error("Unexpected fallback"); },
            scanStream: async (candidate, _query, budget) => {
                reserved.push(budget.maxBytes);
                return { hits: [hit(candidate)], scannedBytes: budget.maxBytes };
            },
        },
    }));
    assert.deepEqual(reserved, [100]);
    assert.equal(result.contextLocate?.scannedBytes, 100);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.partial, true);
});

test("a fast source publishes verified text while another metadata source never returns", async () => {
    const checkpoints: ListConversationCandidatesResult[] = [];
    const started = performance.now();
    let verifiedAt = Infinity;
    const result = await listConversationCandidates(defaults({
        deadlineMs: 150, adapters: adapters(() => [row("synthetic-fast")], never),
        onCheckpoint: value => { checkpoints.push(structuredClone(value)); if (value.candidates.length) verifiedAt = Math.min(verifiedAt, performance.now()); },
    }));
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ["synthetic-fast"]);
    assert.ok(verifiedAt - started < 150, `first verified evidence took ${verifiedAt - started}ms`);
    assert.equal(result.contextLocate?.status, "partial_found_scanning");
    assert.equal(result.contextLocate?.scannedFiles, 1);
    assert.equal(result.partial, true);
    assert.ok(checkpoints.some(value => value.candidates.length === 1 && value.partial));
    assert.ok(result.statuses.some(status => status.dataChain === "claude-code" && status.status === "failed"));
    console.log(JSON.stringify({ scenario: "fast-source-before-pending-source-deadline", firstVerifiedMs: Math.round(verifiedAt - started), totalMs: Math.round(performance.now() - started) }));
});

test("zero matches at deadline remain unverified rather than a full-scan absence", async () => {
    const result = await listConversationCandidates(defaults({
        deadlineMs: 80, adapters: adapters(() => [row("synthetic-no-hit")], never), contextAdapters: readers(() => false),
    }));
    assert.deepEqual(result.candidates, []);
    assert.equal(result.contextLocate?.status, "budget_exhausted");
    assert.equal(result.contextLocate?.resolution, "unverified");
    assert.equal(result.contextLocate?.scannedFiles, 1);
    assert.equal(result.partial, true);
});

test("a source error is checkpointed immediately and survives another source timing out", async () => {
    let observedErrorAt = Infinity;
    const started = performance.now();
    const result = await listConversationCandidates(defaults({
        deadlineMs: 120, adapters: adapters(() => { throw new Error("SYNTHETIC_SOURCE_DENIED"); }, never),
        onCheckpoint: value => { if (value.statuses.some(status => status.error === "SYNTHETIC_SOURCE_DENIED")) observedErrorAt = Math.min(observedErrorAt, performance.now()); },
    }));
    assert.ok(observedErrorAt - started < 120);
    assert.equal(result.statuses.find(status => status.dataChain === "codex")?.error, "SYNTHETIC_SOURCE_DENIED");
    assert.equal(result.contextLocate?.status, "budget_exhausted");
});

test("concurrent source checkpoints retain earlier hits and never rescan completed candidates", async () => {
    const calls: string[] = [];
    const checkpoints: string[][] = [];
    const contextAdapters = readers();
    const original = contextAdapters.scanStream!;
    contextAdapters.scanStream = async (candidate, query, budget) => {
        calls.push(candidate.id);
        if (candidate.dataChain === "claude-code") await delay(20);
        return original(candidate, query, budget);
    };
    const result = await listConversationCandidates(defaults({
        contextAdapters, onCheckpoint: value => { checkpoints.push(value.candidates.map(candidate => candidate.id)); },
    }));
    assert.deepEqual(new Set(result.candidates.map(candidate => candidate.id)), new Set(["synthetic-codex", "synthetic-claude"]));
    assert.equal(calls.length, 2);
    assert.equal(result.contextLocate?.scannedFiles, 2);
    assert.equal(result.partial, false);
    assert.equal(result.contextLocate?.resolution, "ambiguous");
    let previous = new Set<string>();
    for (const checkpoint of checkpoints) {
        const current = new Set(checkpoint);
        for (const identity of previous) assert.ok(current.has(identity), `checkpoint lost ${identity}`);
        previous = current;
    }
});

test("metadata does not become a body match before verification finishes", async () => {
    const result = await listConversationCandidates(defaults({
        deadlineMs: 80, adapters: adapters(() => [row("synthetic-metadata-only")], () => []),
        contextAdapters: { readRounds: never, scanStream: never },
        onCheckpoint: value => { assert.deepEqual(value.candidates, []); },
    }));
    assert.equal(result.contextLocate?.status, "budget_exhausted");
    assert.deepEqual(result.candidates, []);
});

test("warnings alone never become verified conversation hits", async () => {
    const contextAdapters = readers(() => false);
    contextAdapters.scanStream = async () => ({ hits: [], scannedBytes: 10, partial: true,
        warnings: [`synthetic-warning-target:R1-R5/5:${marker}`] });
    const result = await listConversationCandidates(defaults({
        adapters: adapters(() => [row("synthetic-warning-target")], () => []), contextAdapters,
        onCheckpoint: value => { assert.deepEqual(value.candidates, []); },
    }));
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.contextLocate?.hits, []);
    assert.equal(result.contextLocate?.matchedConversationCount, 0);
    assert.equal(result.contextLocate?.status, "budget_exhausted");
    assert.ok(result.contextLocate?.warnings.some(warning => warning.includes("synthetic-warning-target")));
});

test("cancel after a verified source still aborts a request whose other source is pending", async () => {
    const controller = new AbortController();
    await assert.rejects(listConversationCandidates(defaults({
        signal: controller.signal, adapters: adapters(() => [row("synthetic-before-cancel")], never),
        onCheckpoint: value => { if (value.candidates.length) controller.abort(); },
    })), (error: NodeJS.ErrnoException) => error.code === "SOURCE_WORKER_CANCELLED");
});

test("strict failure mode keeps the failed-source evidence consumed by the formal tool", async () => {
    const result = await listConversationCandidates(defaults({
        sourceFailureMode: "fail", adapters: adapters(() => [row("synthetic-healthy")], () => { throw new Error("SYNTHETIC_CORRUPT_SOURCE"); }),
    }));
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ["synthetic-healthy"]);
    assert.equal(result.statuses.filter(status => status.status === "failed").length, 1);
    assert.equal(result.statuses.find(status => status.dataChain === "claude-code")?.error, "SYNTHETIC_CORRUPT_SOURCE");
    assert.equal(result.partial, true);
});

test("checkpoint delivery failures remain fatal rather than becoming source failures", async () => {
    const failure = new Error("SYNTHETIC_CHECKPOINT_DELIVERY_FAILURE");
    await assert.rejects(listConversationCandidates(defaults({
        onCheckpoint: value => { if (value.statuses.length) throw failure; },
    })), error => error === failure);
});

test("full-scan absence is returned only after both sources have completed", async () => {
    const result = await listConversationCandidates(defaults({ contextAdapters: readers(() => false, 5) }));
    assert.equal(result.contextLocate?.status, "no_hit_after_full_scan");
    assert.equal(result.contextLocate?.resolution, "no_match");
    assert.equal(result.contextLocate?.scannedFiles, 2);
    assert.equal(result.partial, false);
});

test("parallel readers share one file budget and reuse unused hit reservations", async () => {
    let calls = 0;
    const contextAdapters = readers();
    contextAdapters.scanStream = async candidate => { calls++; return { hits: [hit(candidate)], scannedBytes: 10 }; };
    const bounded = await listConversationCandidates(defaults({ candidateLimit: 1, maxBytes: 100, maxHits: 1, contextAdapters }));
    assert.equal(calls, 1);
    assert.equal(bounded.contextLocate?.scannedFiles, 1);
    assert.equal(bounded.contextLocate?.hits.length, 1);
    assert.equal(bounded.partial, true);
    const reused = await listConversationCandidates(defaults({ maxHits: 1, maxBytes: 100,
        contextAdapters: readers(candidate => candidate.dataChain === "claude-code", 10),
    }));
    assert.deepEqual(reused.candidates.map(candidate => candidate.id), ["synthetic-claude"]);
    assert.equal(reused.contextLocate?.scannedFiles, 2);
    assert.ok(reused.contextLocate!.scannedBytes <= 100);
});

test("workspace, parent promotion, child mode and aliases remain source-local", async () => {
    const parent: UnifiedConversationCandidate = {
        id: "synthetic-parent", aliases: ["synthetic-parent-alias"], dataChain: "windsurf", title: "Parent", workspace, updatedAt: "", detail: "synthetic",
    };
    const child = { ...parent, id: "synthetic-child", aliases: [], isChildThread: true, parentConversationId: parent.id };
    const outside = { ...child, id: "synthetic-outside", workspace: path.join(temporary, "different-workspace") };
    const sourceAdapters = adapters(() => [], () => []);
    sourceAdapters.localList = async () => [parent, child, outside];
    for (const threadMode of ["main", "children", "all"] as const) {
        const result = await listConversationCandidates(defaults({
            dataChains: ["windsurf", "claude-code"], source: "local", adapters: sourceAdapters, workspaces: [workspace], workspaceMode: "exact",
            threadMode, parentConversationId: threadMode === "children" ? "synthetic-parent-alias" : undefined,
            contextAdapters: readers(candidate => candidate.id !== parent.id),
        }));
        assert.deepEqual(result.candidates.map(candidate => candidate.id), [threadMode === "main" ? parent.id : child.id]);
        if (threadMode === "main") assert.equal(result.candidates[0].matchedChildConversationId, child.id);
        assert.equal(result.contextLocate?.scannedFiles, 2);
    }
});

test("concurrent sources reserve one global byte budget", async () => {
    const allocations: number[] = [];
    const contextAdapters = readers(() => false);
    contextAdapters.scanStream = async (_candidate, _query, budget) => {
        allocations.push(budget.maxBytes);
        await delay(10);
        return { hits: [], scannedBytes: budget.maxBytes };
    };
    const result = await listConversationCandidates(defaults({ maxBytes: 100, contextAdapters }));
    assert.equal(allocations.length, 2);
    assert.ok(allocations.reduce((total, bytes) => total + bytes, 0) <= 100);
    assert.equal(result.contextLocate?.scannedBytes, 100);
});

test("late metadata resolution cannot publish or rescan after the request deadline", async () => {
    let release!: (value: any[]) => void;
    const delayed = new Promise<any[]>(resolve => { release = resolve; });
    let checkpoints = 0;
    let calls = 0;
    const contextAdapters = readers();
    contextAdapters.scanStream = async candidate => { calls++; return { hits: [hit(candidate)], scannedBytes: 10 }; };
    const result = await listConversationCandidates(defaults({ deadlineMs: 80,
        adapters: adapters(() => [row("synthetic-early")], () => delayed), contextAdapters,
        onCheckpoint: () => { checkpoints++; },
    }));
    const checkpointCount = checkpoints;
    release([row("synthetic-late")]);
    await delay(20);
    assert.equal(checkpoints, checkpointCount);
    assert.equal(calls, 1);
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ["synthetic-early"]);
});

test("actual Codex and Claude JSONL body readers connect to incremental multisource verification", async () => {
    const codexId = "11111111-1111-4111-8111-111111111111";
    const claudeId = "22222222-2222-4222-8222-222222222222";
    const codexFile = path.join(temporary, "synthetic-codex.jsonl");
    const claudeFile = path.join(temporary, "synthetic-claude.jsonl");
    fs.writeFileSync(codexFile, [
        { type: "session_meta", payload: { id: codexId, cwd: workspace } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n", "utf8");
    fs.writeFileSync(claudeFile, JSON.stringify({ type: "user", uuid: "synthetic-message", sessionId: claudeId, cwd: workspace,
        message: { role: "user", content: marker }, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n", "utf8");
    const sourceAdapters = adapters(() => [row(codexId, { rolloutPath: codexFile })], () => [row(claudeId, { jsonlPath: claudeFile })]);
    const result = await listConversationCandidates({ dataChains: ["codex", "claude-code"], contextProbe: marker, adapters: sourceAdapters, deadlineMs: 4000 });
    assert.deepEqual(new Set(result.candidates.map(candidate => candidate.id)), new Set([codexId, claudeId]));
    assert.deepEqual(new Set(result.contextLocate?.hits.map(value => value.filePath)), new Set([codexFile, claudeFile]));
    assert.equal(result.contextLocate?.scannedFiles, 2);
    const started = performance.now();
    let verifiedAt = Infinity;
    const timed = await listConversationCandidates({ dataChains: ["codex", "claude-code"], contextProbe: marker,
        adapters: adapters(sourceAdapters.codex.list, never), deadlineMs: 1500,
        onCheckpoint: value => { if (value.candidates.some(candidate => candidate.id === codexId)) verifiedAt = Math.min(verifiedAt, performance.now()); },
    });
    assert.deepEqual(timed.candidates.map(candidate => candidate.id), [codexId]);
    assert.ok(verifiedAt - started < 1000, `real JSONL hit was not checkpointed before the deadline: ${verifiedAt - started}`);
    assert.equal(timed.partial, true);
    console.log(JSON.stringify({ scenario: "real-jsonl-before-pending-source-deadline", firstVerifiedMs: Math.round(verifiedAt - started), totalMs: Math.round(performance.now() - started) }));
});
