import assert from "node:assert/strict";
import test from "node:test";
import { HostConversationContent, formatRecentSnapshotMcp, normalizeHostContentGrants } from "../src/host-conversation-content.mjs";
import { createCodexConversationContent } from "../src/codex-conversation-content.mjs";

const scope = { machine_id: "synthetic-machine", host: "codex", surface: "desktop" };
const caller = { ...scope, conversation_id: "caller" };
const target = { ...scope, conversation_id: "test-thread" };
const principal = { id: "test-grant", identity: caller, allowed_host_lists: [scope], allowed_host_snapshots: [target] };

test("list is an independent grant, signs scoped upstream cursors and projects only useful metadata", async () => {
  const calls = [];
  const view = new HostConversationContent({ providers: { codex: {
    list: async (observedScope, { cursor, limit }) => {
      calls.push({ observedScope, cursor, limit });
      return { conversations: [{ conversation_id: "not-bound", title: "最近工作", private_field: "do not expose" }],
          next_cursor: cursor ? null : "opaque-next", partial: true,
          coverage_reasons: ["item_page_limited", "untrusted upstream text", "item_page_limited"] };
    },
  } } });
  const request = { caller, host: "codex", scope: "host", limit: 5 };
  const result = await view.list(principal, request);
  assert.equal(result.conversations[0].conversation_id, "not-bound");
  assert.equal(result.conversations[0].private_field, undefined);
  assert.notEqual(result.next_cursor, "opaque-next");
  assert.equal(result.has_more, true);
  assert.deepEqual(result.coverage_reasons, ["item_page_limited"]);
  const next = await view.list(principal, { ...request, cursor: result.next_cursor });
  assert.equal(next.has_more, false);
  assert.deepEqual(calls.map(item => item.cursor), [null, "opaque-next"]);
  await assert.rejects(view.list({ ...principal, id: "other" }, { ...request, cursor: result.next_cursor }), { code: "invalid_cursor" });
  await assert.rejects(view.list({ ...principal, allowed_host_lists: [] }, request), { code: "forbidden" });
  await assert.rejects(view.list(principal, { ...request, cursor: result.next_cursor + "A" }), { code: "invalid_cursor" });
  assert.equal(calls.length, 2);
});

test("remote content needs an exact machine and host provider, an independent grant, and a matching cursor", async () => {
  const remoteScope = { ...scope, machine_id: "test-remote-machine" };
  const remoteTarget = { ...target, ...remoteScope };
  const both = { ...principal, allowed_host_lists: [scope, remoteScope], allowed_host_snapshots: [target, remoteTarget] };
  const calls = [];
  const make = label => ({
    async list(address, { cursor }) {
      calls.push({ label, address, cursor });
      return { conversations: [{ conversation_id: "test-thread", title: label }], next_cursor: cursor ? null : label + "-page" };
    },
    async readRecent(address) {
      calls.push({ label, address });
      return { ...address, title: label, rounds: [] };
    },
  });
  const routes = new Map();
  const view = new HostConversationContent({ localMachineId: scope.machine_id, providers: { codex: make("local") }, machineProviders: routes });
  const remoteRequest = { caller, ...remoteScope, scope: "host" };
  await assert.rejects(view.list(both, remoteRequest), { code: "host_content_unavailable" });
  await assert.rejects(view.snapshot(both, { caller, target: remoteTarget }), { code: "host_content_unavailable" });
  assert.equal(calls.length, 0);
  routes.set(remoteScope.machine_id, new Map([["codex", make("remote")]]));
  await assert.rejects(view.list(principal, remoteRequest), { code: "forbidden" });
  await assert.rejects(view.list(both, { ...remoteRequest, surface: "cli" }), { code: "forbidden" });
  const localResult = await view.list(both, { caller, host: "codex", scope: "host" });
  await assert.rejects(view.list(both, { ...remoteRequest, cursor: localResult.next_cursor }), { code: "invalid_cursor" });
  const remoteResult = await view.list(both, remoteRequest);
  assert.equal(remoteResult.conversations[0].title, "remote");
  assert.equal(remoteResult.conversations[0].machine_id, remoteScope.machine_id);
  assert.equal((await view.list(both, { ...remoteRequest, cursor: remoteResult.next_cursor })).has_more, false);
  const recent = await view.snapshot(both, { caller, target: remoteTarget });
  assert.equal(recent.target.machine_id, remoteScope.machine_id);
  assert.deepEqual(calls.map(entry => entry.label), ["local", "remote", "remote", "remote"]);
  routes.get(remoteScope.machine_id).get("codex").cursorGeneration = 2;
  await assert.rejects(view.list(both, { ...remoteRequest, cursor: remoteResult.next_cursor }), { code: "invalid_cursor" });
  const refreshed = await view.list(both, remoteRequest);
  routes.set(remoteScope.machine_id, new Map([["codex", make("new-remote")]]));
  await assert.rejects(view.list(both, { ...remoteRequest, cursor: refreshed.next_cursor }), { code: "invalid_cursor" });
  assert.equal(calls.at(-1).label, "remote");
});

test("two authorized cores preserve a maximum-length native directory cursor through both signatures", async () => {
  const remoteScope = { ...scope, machine_id: "fixture-second-directory-machine" };
  const peer = { id: "fixture-directory-peer", identity: { ...remoteScope, conversation_id: "fixture-peer" }, allowed_host_lists: [remoteScope] };
  const operator = { ...principal, allowed_host_lists: [remoteScope] };
  const nativeCursor = "x".repeat(512);
  const observed = [];
  const destination = new HostConversationContent({ localMachineId: remoteScope.machine_id, providers: { codex: {
    async list(address, { cursor }) {
      observed.push(cursor);
      return { conversations: [{ conversation_id: cursor ? "fixture-page-two" : "fixture-page-one" }], next_cursor: cursor ? null : nativeCursor };
    },
  } } });
  const relayed = { list: (address, { cursor, limit, signal }) => destination.list(peer, { ...address, caller: peer.identity, scope: "host", cursor, limit }, { signal }) };
  const source = new HostConversationContent({
    localMachineId: scope.machine_id, machineProviders: new Map([[remoteScope.machine_id, new Map([[remoteScope.host, relayed]])]]),
  });
  const input = { ...remoteScope, caller, scope: "host", limit: 1 };
  const first = await source.list(operator, input);
  assert.equal(first.conversations[0].conversation_id, "fixture-page-one");
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor.length > 727 && first.next_cursor.length <= 1024);
  await assert.rejects(source.list({ ...operator, id: "another-directory-principal" }, { ...input, cursor: first.next_cursor }), { code: "invalid_cursor" });
  const second = await source.list(operator, { ...input, cursor: first.next_cursor });
  assert.equal(second.conversations[0].conversation_id, "fixture-page-two");
  assert.equal(second.has_more, false);
  assert.deepEqual(observed, [null, nativeCursor]);
});

test("snapshot checks the exact target before reading and emits single-copy Markdown without hidden content", async () => {
  let count = 0;
  const view = new HostConversationContent({ providers: { codex: {
    readRecent: async (address, { lastRounds }) => {
      count += 1;
      assert.equal(lastRounds, 3);
      return { ...address, title: "测试回信", status: "running", partial: true,
        rounds: [{ messages: [
          { role: "user", text: "看一下最近进度" },
          { role: "assistant", text: "已经完成一项" },
          { role: "assistant", text: "DO-NOT-SHOW", visibility: "hidden" },
          { role: "tool", text: "DO-NOT-SHOW-RESULT" },
        ] }] };
    },
  } } });
  await assert.rejects(view.snapshot(principal, { caller, target: { ...target, conversation_id: "not-granted" } }), { code: "forbidden" });
  assert.equal(count, 0);
  const result = await view.snapshot(principal, { caller, target });
  const mcp = formatRecentSnapshotMcp(result);
  assert.match(mcp.content[0].text, /看一下最近进度/u);
  assert.doesNotMatch(JSON.stringify(mcp), /DO-NOT-SHOW/u);
  assert.equal(Object.hasOwn(mcp.structuredContent, "markdown"), false);
  assert.equal(mcp.structuredContent.partial, true);
  assert.ok(Buffer.byteLength(JSON.stringify(mcp)) <= 8192);
  assert.equal(count, 1);
});

test("invalid grants and provider target or page ambiguity fail before disclosure", async () => {
  assert.throws(() => normalizeHostContentGrants([{ ...target, conversation_id: "*" }], true));
  assert.throws(() => normalizeHostContentGrants([{ ...target, all_conversations: true }], true));
  assert.deepEqual(normalizeHostContentGrants([{ ...scope, all_conversations: true }], true), [{ ...scope, all_conversations: true }]);
  const view = new HostConversationContent({ providers: { codex: {
    list: async () => ({ conversations: [{ conversation_id: "other", machine_id: "alien" }] }),
    readRecent: async () => ({ ...target, conversation_id: "not-requested", rounds: [] }),
  } } });
  await assert.rejects(view.list(principal, { caller, host: "codex", scope: "host" }), { code: "host_content_unverified" });
  await assert.rejects(view.snapshot(principal, { caller, target }), { code: "host_content_unverified" });
});

test("Codex content only uses two bounded read routes and rejects other response identities", async () => {
  const calls = [];
  const provider = createCodexConversationContent({ readHostContent: async (operation, input) => {
    calls.push({ operation, input });
    return operation === "list"
      ? { threads: [{ thread_id: "test-thread", title: "合成对话", updated_at: 1700000000, status: "active" }], next_cursor: null, coverage: { partial: false } }
      : { thread_id: input.thread_id, coverage: { partial: false }, turns: [
        { status: "completed", turn_id: "turn1", body_visibility: "verified", messages: [
          { role: "user", text: "保留", visibility: "visible", started_at_ms: 1700000000123 }, { role: "user", text: "隐藏", visibility: "hidden" }, { role: "reasoning", text: "不可读" },
        ] },
      ] };
  } }, { inspectThread: async id => ({ found: true, threadId: id, thread: { id, model: "synthetic-model", status: { type: "active" } } }) });
  const listed = await provider.list(scope, { cursor: null, limit: 7 });
  assert.equal(listed.conversations[0].updated_at, "2023-11-14T22:13:20.000Z");
  const snapshot = await provider.readRecent(target, { lastRounds: 3 });
  assert.equal(snapshot.current_selection, "synthetic-model");
  assert.ok(Number.isFinite(Date.parse(snapshot.current_selection_at)));
  assert.deepEqual(snapshot.rounds[0].messages.map(entry => entry.text), ["保留"]);
  assert.equal(snapshot.rounds[0].messages[0].at, "2023-11-14T22:13:20.123Z");
  assert.deepEqual(calls, [
    { operation: "list", input: { limit: 7 } },
    { operation: "snapshot", input: { thread_id: target.conversation_id, last_rounds: 3 } },
  ]);
});

test("an upstream metadata-only Codex turn shows its verified times and status without supplying body text", async () => {
  const provider = createCodexConversationContent({ readHostContent: async () => ({
    thread_id: target.conversation_id, coverage: { partial: true, reasons: ["visibility_unavailable", "turn_in_progress"] },
    turns: [
      { turn_id: "done", started_at: 1700000000, completed_at: 1700000001, status: "completed", messages: [] },
      { turn_id: "running", started_at: 1700000002, status: "inProgress", messages: [{ role: "user", text: "PRIVATE_HIDDEN", visibility: "hidden" }] },
    ],
  }) });
  const view = new HostConversationContent({ providers: { codex: provider } });
  const snapshot = await view.snapshot(principal, { caller, target, last_rounds: 2 });
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.coverage_reasons, ["visibility_unavailable", "turn_in_progress"]);
  assert.equal(snapshot.returned_rounds, 2);
  assert.match(snapshot.markdown, /正文暂未提供.*已结束.*22:13:20\.000Z/u);
  assert.match(snapshot.markdown, /正文暂未提供.*进行中.*22:13:22\.000Z/u);
  assert.doesNotMatch(snapshot.markdown, /PRIVATE_HIDDEN/u);
});

test("only terminal Codex turns with positive individual and whole-turn proofs survive partial transport output", async () => {
  const provider = createCodexConversationContent({ readHostContent: async () => ({
    thread_id: target.conversation_id, coverage: { partial: true, reasons: ["item_page_limited", "result_limited"] },
    turns: [
      { turn_id: "stale-source", status: "completed", started_at: 1700000000, messages: [
        { role: "assistant", text: "DO_NOT_SHOW_MISSING_TURN_PROOF", visibility: "visible" },
      ] },
      { turn_id: "cutoff", status: "completed", started_at: 1700000001, body_visibility: "verified", messages: [
        { role: "assistant", text: "DO_NOT_SHOW_PARTIAL_ROUND", visibility: "visible" },
        { role: "user", text: "DO_NOT_SHOW_MISSING_ITEM_PROOF" },
      ] },
      { turn_id: "verified", status: "completed", started_at: 1700000002, body_visibility: "verified", messages: [
        { role: "user", text: "实际核准正文", visibility: "visible" },
        { role: "assistant", text: "DO_NOT_SHOW_HIDDEN", visibility: "hidden" },
      ] },
      { turn_id: "busy", status: "inProgress", started_at: 1700000003, body_visibility: "verified", messages: [
        { role: "assistant", text: "DO_NOT_SHOW_ACTIVE_TURN", visibility: "visible" },
      ] },
    ],
  }) });
  const view = new HostConversationContent({ providers: { codex: provider } });
  const snapshot = await view.snapshot(principal, { caller, target, last_rounds: 4 });
  assert.equal(snapshot.returned_rounds, 4);
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.coverage_reasons, ["visibility_unavailable", "item_page_limited", "turn_in_progress", "result_limited"]);
  assert.match(snapshot.markdown, /实际核准正文/u);
  assert.match(snapshot.markdown, /正文暂未提供.*已结束.*22:13:20.000Z/u);
  assert.doesNotMatch(snapshot.markdown, /DO_NOT_SHOW/u);
});
