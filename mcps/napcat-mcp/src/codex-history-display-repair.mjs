import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HISTORY_DISPLAY_REPAIRS = Object.freeze([]);

const methods = new Set(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]);
const hash = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function createPinnedThreadOriginProjector(repairs) {
  assert.ok(Array.isArray(repairs) && repairs.length <= 16, "BOUNDED_ORIGINS_REQUIRED");
  const pinned = new Map();
  for (const repair of repairs) {
    assert.ok(repair && typeof repair.threadId === "string" && repair.threadId.length > 0
      && repair.threadId.length <= 512, "ORIGIN_IDENTITY_REQUIRED");
    assert.ok(Number.isSafeInteger(repair.expectedCreatedAt) && repair.expectedCreatedAt > 0
      && Number.isSafeInteger(repair.originalCreatedAt) && repair.originalCreatedAt > 0
      && repair.originalCreatedAt < repair.expectedCreatedAt, "ORIGIN_TIMESTAMPS_REQUIRED");
    assert.match(repair.originalMetadataSha256 ?? "", /^[a-f0-9]{64}$/u, "ORIGINAL_METADATA_SHA_REQUIRED");
    assert.equal(pinned.has(repair.threadId), false, "DUPLICATE_ORIGIN_IDENTITY");
    pinned.set(repair.threadId, { ...repair });
  }
  const matchesRequest = request => (request?.method === "thread/list" && pinned.size > 0)
    || (["thread/read", "thread/resume"].includes(request?.method) && pinned.has(request.params?.threadId));
  const projectThread = thread => {
    const repair = pinned.get(thread?.id);
    return repair && thread.createdAt === repair.expectedCreatedAt
      ? { ...thread, createdAt: repair.originalCreatedAt } : thread;
  };
  return Object.freeze({
    matchesRequest,
    project(request, response) {
      if (!matchesRequest(request) || !["string", "number"].includes(typeof request.id)
        || response?.id !== request.id || Object.hasOwn(response, "error")) return response;
      if (request.method === "thread/list") {
        if (!Array.isArray(response.result?.data)) return response;
        const data = response.result.data.map(projectThread);
        return data.every((thread, index) => thread === response.result.data[index]) ? response
          : { ...response, result: { ...response.result, data } };
      }
      const repair = pinned.get(request.params.threadId);
      const thread = response.result?.thread;
      if (thread?.id !== repair.threadId || thread.createdAt !== repair.expectedCreatedAt) return response;
      return { ...response, result: { ...response.result, thread: projectThread(thread) } };
    },
    snapshot() { return { pinnedOrigins: pinned.size }; },
  });
}

function configuredThreadOrigins() {
  let descriptor;
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const filename = path.join(home, "state", "desktop-thread-origin-repairs.json");
    descriptor = fs.openSync(filename, "r");
    const bytes = Buffer.alloc(16385);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 16384) return createPinnedThreadOriginProjector([]);
    const configuration = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (configuration.schemaVersion !== 1 || configuration.enabled !== true) return createPinnedThreadOriginProjector([]);
    return createPinnedThreadOriginProjector(configuration.repairs);
  } catch {
    return createPinnedThreadOriginProjector([]);
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
  }
}

export function createDesktopHistoryReadBudgetPolicy(configuration, { now = () => performance.now() } = {}) {
  const clients = new WeakMap();
  const active = configuration?.enabled === true;
  if (active) {
    assert.ok(Array.isArray(configuration.threadIds) && configuration.threadIds.length > 0
      && configuration.threadIds.length <= 16, "BOUNDED_HISTORY_BUDGET_THREADS_REQUIRED");
    assert.ok(configuration.threadIds.every(threadId => typeof threadId === "string"
      && threadId.length > 0 && threadId.length <= 512), "HISTORY_BUDGET_THREAD_REQUIRED");
    for (const [field, minimum, maximum] of [["maximumContinuationRequests", 1, 256],
      ["maximumTurnPages", 1, 32], ["maximumHistoryBytes", 1024, 64 * 1024 * 1024],
      ["quietResetMs", 1000, 60000]]) {
      assert.ok(Number.isSafeInteger(configuration[field]) && configuration[field] >= minimum
        && configuration[field] <= maximum, "HISTORY_BUDGET_BOUND_REQUIRED:" + field);
    }
  }
  const targets = new Set(active ? configuration.threadIds : []);
  const matches = request => targets.has(request?.params?.threadId)
    && ["thread/turns/list", "thread/items/list"].includes(request.method);
  const continuation = request => request?.params?.cursor != null
    || (request?.method === "thread/turns/list" && request.params?.sortDirection === "asc");
  const currentState = (client, threadId, timestamp) => {
    let threads = clients.get(client);
    if (!threads) clients.set(client, threads = new Map());
    let state = threads.get(threadId);
    if (!state || timestamp - state.lastActivity >= configuration.quietResetMs) {
      threads.set(threadId, state = { lastActivity: timestamp, continuations: 0, turnPages: 0, bytes: 0, denials: 0 });
    }
    state.lastActivity = timestamp;
    return state;
  };
  const errorResponse = (request, reason) => ({ id: request.id, error: { code: -32012,
    message: "已暂停本对话旧历史的连续加载，防止界面占用过多内存；稍后可手动重试，原历史仍完整保存在本机",
    data: { type: "desktop_history_read_budget", reason, retryable: true,
      retryAfterMs: configuration.quietResetMs } } });
  return Object.freeze({
    isContinuation: continuation,
    check(client, request) {
      if (!matches(request) || !["string", "number"].includes(typeof request.id)) return null;
      const state = currentState(client, request.params.threadId, now());
      if (!continuation(request)) return null;
      const reason = state.bytes >= configuration.maximumHistoryBytes ? "bytes"
        : state.continuations >= configuration.maximumContinuationRequests ? "requests"
          : request.method === "thread/turns/list" && state.turnPages >= configuration.maximumTurnPages ? "turn_pages" : null;
      if (reason) {
        state.denials += 1;
        return errorResponse(request, reason);
      }
      state.continuations += 1;
      if (request.method === "thread/turns/list") state.turnPages += 1;
      return null;
    },
    observe(client, request, response, bytes) {
      if (!matches(request) || !["string", "number"].includes(typeof request.id)) return null;
      if (response?.id !== request.id || Object.hasOwn(response ?? {}, "error")
        || !Number.isSafeInteger(bytes) || bytes < 0) return null;
      const state = clients.get(client)?.get(request.params.threadId)
        ?? currentState(client, request.params.threadId, now());
      state.lastActivity = now();
      state.bytes += bytes;
      if (continuation(request) && state.bytes > configuration.maximumHistoryBytes) {
        state.denials += 1;
        return errorResponse(request, "bytes");
      }
      return null;
    },
    snapshot(client, threadId) {
      const state = clients.get(client)?.get(threadId);
      return state ? { ...state } : null;
    },
    describe() {
      return active ? { enabled: true, targetThreads: targets.size,
        maximumContinuationRequests: configuration.maximumContinuationRequests,
        maximumTurnPages: configuration.maximumTurnPages,
        maximumHistoryBytes: configuration.maximumHistoryBytes,
        quietResetMs: configuration.quietResetMs } : { enabled: false };
    },
  });
}

function configuredHistoryReadBudget() {
  let descriptor;
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    descriptor = fs.openSync(path.join(home, "state", "desktop-history-read-budget.json"), "r");
    const bytes = Buffer.alloc(16385);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 16384) return createDesktopHistoryReadBudgetPolicy();
    const configuration = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    return createDesktopHistoryReadBudgetPolicy(configuration.schemaVersion === 1 ? configuration : undefined);
  } catch {
    return createDesktopHistoryReadBudgetPolicy();
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
  }
}

export const desktopHistoryReadBudget = configuredHistoryReadBudget();

function notificationBody(item) {
  const match = item.text.trim().match(/^<heartbeat>\s*(?:<automation_id>[^<>]*<\/automation_id>\s*)?<decision>\s*NOTIFY\s*<\/decision>\s*<message>\s*([\s\S]*?)\s*<\/message>\s*<\/heartbeat>$/iu);
  if (!match || (item.text.match(/<heartbeat>/giu)?.length ?? 0) !== 1) return item;
  const enclosed = match[1].trim();
  if ((enclosed.includes("<![CDATA[") || enclosed.includes("]]>")) && !/^<!\[CDATA\[[\s\S]*\]\]>$/u.test(enclosed)) return item;
  const message = (enclosed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/u)?.[1] ?? enclosed).trim();
  if (!message || /<\/?(?:heartbeat|decision|message|automation_id)>/iu.test(message)) return item;
  return { ...item, text: message };
}

export function createPinnedHistoryProjector(repairs) {
  assert.ok(Array.isArray(repairs) && repairs.length <= 16, "BOUNDED_REPAIRS_REQUIRED");
  const pinned = new Map();
  const threads = new Set();
  const identities = [];
  for (const repair of repairs) {
    assert.ok(repair && ["threadId", "turnId", "itemId"].every(key =>
      typeof repair[key] === "string" && repair[key].length > 0 && repair[key].length <= 512), "REPAIR_IDENTITY_REQUIRED");
    assert.match(repair.rawTextSha256 ?? "", /^[a-f0-9]{64}$/u, "REPAIR_TEXT_SHA_REQUIRED");
    const key = JSON.stringify([repair.threadId, repair.turnId, repair.itemId]);
    assert.equal(pinned.has(key), false, "DUPLICATE_REPAIR_IDENTITY");
    pinned.set(key, repair.rawTextSha256);
    threads.add(repair.threadId);
    identities.push({ threadId: repair.threadId, turnId: repair.turnId, itemId: repair.itemId,
      rawTextSha256: repair.rawTextSha256 });
  }
  const matchesRequest = request => methods.has(request?.method) && threads.has(request.params?.threadId);
  const matchesThread = request => threads.has(request?.params?.threadId);
  const revisions = new Map([...threads].map(threadId => [threadId, 0]));
  const projectItem = (threadId, turnId, item) => {
    if (item?.type !== "agentMessage" || item.phase !== "final_answer" || typeof item.text !== "string") return item;
    const expected = pinned.get(JSON.stringify([threadId, turnId, item.id]));
    return expected && hash(item.text) === expected ? notificationBody(item) : item;
  };
  const projectTurn = (threadId, turn) => {
    if (turn?.status !== "completed" || turn.error != null || !Array.isArray(turn.items)) return turn;
    const items = turn.items.map(item => projectItem(threadId, turn.id, item));
    return items.every((item, index) => item === turn.items[index]) ? turn : { ...turn, items };
  };
  const invalidates = (request, response) => {
    if (response?.id !== request.id || Object.hasOwn(response, "error") || !response.result) return false;
    if (request.method === "thread/rollback") return true;
    const threadId = request.params.threadId;
    const targets = identities.filter(repair => repair.threadId === threadId);
    const result = response.result;
    const turnList = ["thread/read", "thread/resume"].includes(request.method)
      && result.thread?.id === threadId && Array.isArray(result.thread.turns) ? result.thread.turns
      : request.method === "thread/turns/list" && Array.isArray(result.data) ? result.data : null;
    const authoritative = request.method === "thread/read" ? request.params.includeTurns === true
      : request.method === "thread/resume" ? request.params.excludeTurns !== true
        : request.method === "thread/turns/list" && request.params.cursor == null && result.nextCursor === null;
    if (turnList && authoritative && targets.some(repair => !turnList.some(turn => turn?.id === repair.turnId))) return true;
    for (const repair of targets) {
      const turn = turnList?.find(value => value?.id === repair.turnId);
      if (turn && (turn.status !== "completed" || turn.error != null)) return true;
      if (turn?.itemsView === "full" && Array.isArray(turn.items)
        && !turn.items.some(value => value?.id === repair.itemId)) return true;
      if (request.method === "thread/items/list" && request.params.turnId === repair.turnId
        && request.params.cursor == null && result.nextCursor === null && Array.isArray(result.data)
        && !result.data.some(value => value?.turnId === repair.turnId && value?.item?.id === repair.itemId)) return true;
      const item = (Array.isArray(turn?.items) ? turn.items.find(value => value?.id === repair.itemId) : null)
        ?? (request.method === "thread/items/list" && request.params.turnId === repair.turnId && Array.isArray(result.data)
          ? result.data?.find(value => value?.turnId === repair.turnId && value?.item?.id === repair.itemId)?.item : null);
      if (item && (item.type !== "agentMessage" || item.phase !== "final_answer"
        || typeof item.text !== "string" || hash(item.text) !== repair.rawTextSha256)) return true;
    }
    return false;
  };
  const projector = Object.freeze({
    matchesRequest,
    matchesThread,
    project(request, response) {
      const threadId = request?.params?.threadId;
      if (!matchesRequest(request) || !["string", "number"].includes(typeof request.id)
        || response?.id !== request.id || Object.hasOwn(response, "error") || !response.result) return response;
      const result = response.result;
      if (["thread/read", "thread/resume"].includes(request.method)) {
        if (result.thread?.id !== threadId || !Array.isArray(result.thread.turns)) return response;
        const turns = result.thread.turns.map(turn => projectTurn(threadId, turn));
        return turns.every((turn, index) => turn === result.thread.turns[index]) ? response
          : { ...response, result: { ...result, thread: { ...result.thread, turns } } };
      }
      if (!Array.isArray(result.data)) return response;
      if (request.method === "thread/turns/list") {
        const data = result.data.map(turn => projectTurn(threadId, turn));
        return data.every((turn, index) => turn === result.data[index]) ? response : { ...response, result: { ...result, data } };
      }
      const data = result.data.map(wrapper => {
        if (!wrapper || wrapper.turnId !== request.params.turnId || !wrapper.item
          || !Number.isFinite(wrapper.startedAtMs) || !Number.isFinite(wrapper.completedAtMs)
          || wrapper.completedAtMs < wrapper.startedAtMs || wrapper.completedAtMs <= 0) return wrapper;
        const item = projectItem(threadId, wrapper.turnId, wrapper.item);
        return item === wrapper.item ? wrapper : { ...wrapper, item };
      });
      return data.every((wrapper, index) => wrapper === result.data[index]) ? response : { ...response, result: { ...result, data } };
    },
    snapshot() { return { pinnedRepairs: pinned.size, requestCacheEntries: 0, turnCacheEntries: 0 }; },
    createView() {
      const owner = Object.freeze({});
      return Object.freeze({
        capture(request) {
          const revision = revisions.get(request?.params?.threadId);
          return revision === undefined ? undefined : Object.freeze({ owner, revision });
        },
        project(request, response, captured) {
          const threadId = request?.params?.threadId;
          const current = revisions.get(threadId);
          if (current === undefined || captured?.owner !== owner || captured.revision !== current) return response;
          if (invalidates(request, response)) {
            revisions.set(threadId, current + 1);
            return response;
          }
          return projector.project(request, response);
        },
      });
    },
  });
  return projector;
}

const localProjector = createPinnedHistoryProjector(HISTORY_DISPLAY_REPAIRS);
const threadOrigins = configuredThreadOrigins();
const localViews = new WeakSet();
export const matchesHistoryDisplayRepair = request => localProjector.matchesThread(request) || threadOrigins.matchesRequest(request);
export function createHistoryDisplayRepairView(previous) {
  if (localViews.has(previous)) return previous;
  const historyView = localProjector.createView();
  const view = Object.freeze({
    capture: request => historyView.capture(request),
    project(request, response, captured) {
      return threadOrigins.project(request, historyView.project(request, response, captured));
    },
  });
  localViews.add(view);
  return view;
}
export const projectHistoryDisplayRepair = (request, response) => threadOrigins.project(request, localProjector.project(request, response));
