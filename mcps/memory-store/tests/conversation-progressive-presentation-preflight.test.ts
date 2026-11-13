import assert from "node:assert/strict";
import test from "node:test";
import { progressiveCompletedProgress, progressiveWarningView, progressiveWorkerProgress, reconcileProgressiveWarnings } from "../src/conversation-progressive-presentation.js";
import { corpusSearchContinuation } from "../src/conversation-corpus-search-next.js";

test("byte source progress retains bytes and total while published counts use rounds", () => {
    assert.deepEqual(progressiveWorkerProgress({ stage: "source:claude-source-verification", current: 262144, total: 2626775 }),
        { stage: "source:claude-source-verification", detail: undefined, current: 262144, total: 2626775, unit: "字节" });
    assert.equal(progressiveWorkerProgress({ stage: "publishing-full-ranges", current: 13 }).unit, "轮");
});

test("only obsolete partial hints move to history after verified complete coverage", () => {
    const warnings = ["host_source_partial", "host_cold_tail_relative_rounds", "RELATIVE_TAIL_WINDOW: initial", "DEVIN_SUBAGENT_MISSING"];
    assert.deepEqual(reconcileProgressiveWarnings(warnings, false), { warnings, historicalWarnings: [] });
    assert.deepEqual(reconcileProgressiveWarnings(warnings, true), { warnings: ["DEVIN_SUBAGENT_MISSING"], historicalWarnings: warnings.slice(0, 3) });
    assert.equal(warnings.length, 4);
});

test("search continuation retains caller target source task and consumed revision", () => {
    const state = { ownerId: "caller", taskId: "original-task", status: "running", revision: 9, nextAfterRevision: 3,
        request: { dataChains: ["claude-code"], conversationIds: ["target"] } };
    const waiting = corpusSearchContinuation(state);
    assert.deepEqual(waiting.next, { action: "search_all_status", conversationId: "caller", conversationIds: ["target"],
        taskId: "original-task", dataChain: "claude-code", afterRevision: 3, waitSeconds: 30 });
    assert.equal(corpusSearchContinuation({ ...state, status: "partial" }).next?.action, "search_all_resume");
    assert.equal(corpusSearchContinuation({ ...state, status: "completed" }).next, undefined);
    assert.equal(corpusSearchContinuation({ ...state, status: "error" }).next, undefined);
    assert.equal(corpusSearchContinuation({ ...state, status: "cancelled" }).nextKind, "resume");
    assert.equal(corpusSearchContinuation({ ...state, status: "unknown" }).nextKind, "unknown");
    const page = corpusSearchContinuation({ ...state, status: "completed", changes: { throughRevision: 2, hasMore: true } });
    assert.equal(page.nextKind, "page");
    assert.deepEqual(corpusSearchContinuation({ ...state, request: { dataChains: ["dsh", "windsurf"] } }).next?.dataChains, ["dsh", "windsurf"]);
});

test("current completion view preserves historical evidence and real partial diagnostics", () => {
    const original = { warnings: ["host_source_partial", "DEVIN_SUBAGENT_MISSING"], historicalWarnings: ["older"] };
    const view = progressiveWarningView(original, true);
    assert.deepEqual(view.warnings, ["DEVIN_SUBAGENT_MISSING"]);
    assert.deepEqual(view.historicalWarnings, ["older", "host_source_partial"]);
    assert.deepEqual(original.warnings, ["host_source_partial", "DEVIN_SUBAGENT_MISSING"]);
    assert.deepEqual(progressiveWarningView(original, false).warnings, original.warnings);
});

test("published fetch completion replaces in-flight wording only after completion", () => {
    const progress = { stage: "full-fetch-cache", detail: "正在发布完整fetch缓存" };
    assert.equal(progressiveCompletedProgress(progress, false), progress);
    assert.equal(progressiveCompletedProgress(progress, true, 280)?.detail, "完整fetch缓存已发布，已就绪范围可以继续读取");
    assert.equal(progress.detail, "正在发布完整fetch缓存");
});

test("snapshot cursor is consumed before waiting or advancing the latest revision", () => {
    const state = { ownerId: "caller", taskId: "original-task", status: "running", revision: 19, nextAfterRevision: 3,
        nextCursor: "snapshot-page-2", hasMore: true, request: { dataChains: ["claude-code"], conversationIds: ["target"] } };
    const page = corpusSearchContinuation(state);
    assert.equal(page.nextKind, "page");
    assert.equal(page.next?.continuationCursor, "snapshot-page-2");
    assert.equal(page.next?.afterRevision, 3);
    assert.equal(page.next?.waitSeconds, 0);
    assert.equal(corpusSearchContinuation({ ...state, status: "completed" }).nextKind, "page");
    assert.equal(corpusSearchContinuation({ ...state, nextAfterRevision: undefined }).next?.afterRevision, 0);
    assert.equal(corpusSearchContinuation({ ...state, nextCursor: undefined, continuationCursor: "unchanged" }).next?.continuationCursor, "unchanged");
    assert.equal(corpusSearchContinuation({ ...state, nextCursor: undefined, cursor: "raw-cursor" }).next?.continuationCursor, "raw-cursor");
});
