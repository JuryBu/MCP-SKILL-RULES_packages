export const THREAD_READ_BODY_BYTES = 8 * 1024;
export const THREAD_READ_RESULT_BYTES = 64 * 1024;
export const THREAD_READ_NATIVE_BYTES = 256 * 1024;
export const THREAD_READ_TIMEOUT_MS = 4000;
const ITEM_LIMIT = 20;
const TEXT_LIMIT_BYTES = 8 * 1024;
const THREAD_STATUS = new Set(["notLoaded", "idle", "active", "systemError"]);
const TURN_STATUS = new Set(["completed", "interrupted", "failed", "inProgress"]);

export class ThreadReadError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const isObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const validCursor = value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !value.includes("\0");
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const scoped = (value, threadId) => isObject(value) && (value.threadId === undefined || value.threadId === threadId);
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
const responseCoverage = reasons => ({ partial: reasons.size !== 0, reasons: [...reasons] });

function uniqueScopedItems(values, identity) {
  const seen = new Set();
  for (const value of values) {
    const id = identity(value);
    if (!validId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function numberOption(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ThreadReadError(400, "invalid_thread_read_request");
  return value;
}

function keysAllowed(value, keys) {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ThreadReadError(400, "invalid_thread_read_request");
}

function page(result, size) {
  if (!isObject(result) || !Array.isArray(result.data) || result.data.length > size
    || !(result.nextCursor === null || validCursor(result.nextCursor))) throw new ThreadReadError(502, "native_read_unsupported");
  return result;
}

function limitText(value, limit) {
  if (typeof value !== "string") return { text: null, clipped: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { text: value, clipped: false };
  let stop = limit;
  while ((bytes[stop] & 0xc0) === 0x80) stop -= 1;
  return { text: bytes.subarray(0, stop).toString("utf8"), clipped: true };
}

function messageContent(item) {
  if (item.type === "agentMessage") return typeof item.text === "string" ? item.text : "";
  return (Array.isArray(item.content) ? item.content : [])
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text).join("\n");
}

function safeReason(error) {
  if (error instanceof ThreadReadError) return error.code;
  if (error?.code === "APP_SERVER_RESPONSE_TOO_LARGE") return "native_reply_too_large";
  if (error?.code === "APP_SERVER_TIMEOUT") return "read_deadline";
  if (error?.code === "APP_SERVER_RPC_ERROR" && [-32600, -32601, -32602].includes(error?.details?.rpcError?.code)) {
    return "native_read_unsupported";
  }
  return "native_read_unavailable";
}

export function createCodexThreadReader({ selectConnection, isCurrent, readNative, projectItem,
  proveTurnCoverage = () => null, verifyCoveredItems, now = performance.now.bind(performance) }) {
  if ([selectConnection, isCurrent, readNative, projectItem, proveTurnCoverage, now].some(method => typeof method !== "function")) throw new TypeError("thread reader dependencies missing");
  let occupied = false;
  return async function readThread(kind, input, access, { deadline = now() + THREAD_READ_TIMEOUT_MS, signal, registerResponseCheck } = {}) {
    const list = kind === "list";
    if (!list && kind !== "snapshot") throw new ThreadReadError(404, "route_not_found");
    const scope = access?.threadIds;
    if (!(scope instanceof Set)) throw new ThreadReadError(403, "thread_read_not_allowed");
    keysAllowed(input, list ? ["limit", "cursor"] : ["thread_id", "last_rounds"]);
    const count = numberOption(list ? input.limit : input.last_rounds, list ? 20 : 3, list ? 50 : 5);
    if (list && input.cursor !== undefined && !validCursor(input.cursor)) throw new ThreadReadError(400, "invalid_thread_cursor");
    if (!list && !validId(input.thread_id)) throw new ThreadReadError(400, "invalid_thread_id");
    if (list ? access.list !== true : !scope.has(input.thread_id)) throw new ThreadReadError(403, "thread_read_not_allowed");
    if (occupied) throw new ThreadReadError(429, "thread_read_busy");
    occupied = true;
    const reasons = new Set();
    const result = list ? { threads: [], next_cursor: null } : { thread_id: input.thread_id, turns: [] };
    let checkSnapshot;
    function ensureCurrent(connection) {
      if (signal?.aborted) throw signal.reason instanceof ThreadReadError ? signal.reason : new ThreadReadError(499, "read_cancelled");
      if (!isCurrent(connection)) throw new ThreadReadError(503, "native_connection_changed");
    }
    function turnCoverage(connection, threadId, turn) {
      try {
        const proof = proveTurnCoverage(connection, threadId, turn);
        return isObject(proof) && Object.isFrozen(proof) ? proof : null;
      } catch { return null; }
    }
    async function read(connection, method, params, limit) {
      ensureCurrent(connection);
      const budget = Math.floor(deadline - now());
      if (budget < 250) throw new ThreadReadError(504, "read_deadline");
      const reply = await readNative(connection, method, params, { mutating: false, timeoutMs: budget, maxReplyBytes: THREAD_READ_NATIVE_BYTES, signal });
      ensureCurrent(connection);
      return page(reply, limit);
    }
    try {
      const connection = selectConnection();
      if (!connection) throw new ThreadReadError(503, "native_connection_unavailable");
      if (list) {
        const accountDirectory = access.listScope === "current_account";
        const native = await read(connection, "thread/list", { limit: count, currentAccountOnly: true, useStateDbOnly: true,
          archived: false, sortKey: "updated_at", sortDirection: "desc", ...(accountDirectory ? { modelProviders: [] } : {}),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, count);
        if (input.cursor !== undefined && native.nextCursor === input.cursor) throw new ThreadReadError(502, "native_cursor_repeated");
        result.next_cursor = native.nextCursor;
        const seen = new Set();
        for (const row of native.data) {
          if (!isObject(row) || !validId(row.id) || seen.has(row.id)) { reasons.add("native_read_unsupported"); continue; }
          seen.add(row.id);
          if (!accountDirectory && !scope.has(row.id)) continue;
          const title = limitText(row.name, 512);
          if (title.clipped) reasons.add("text_limited");
          result.threads.push({ thread_id: row.id, title: title.text, project_id: validId(row.projectId) ? row.projectId : null,
            updated_at: timestamp(row.updatedAt), status: THREAD_STATUS.has(row.status?.type) ? row.status.type : null });
        }
      } else {
        const threadId = input.thread_id;
        const turns = await read(connection, "thread/turns/list", { threadId, limit: count, sortDirection: "desc", itemsView: "notLoaded" }, count);
        if (!scoped(turns, threadId)) throw new ThreadReadError(502, "native_identity_mismatch");
        if (!turns.data.length) reasons.add("native_history_unconfirmed");
        if (!uniqueScopedItems(turns.data, turn => scoped(turn, threadId) && turn.itemsView === "notLoaded"
          && Array.isArray(turn.items) && !turn.items.length ? turn.id : null)) {
          throw new ThreadReadError(502, "native_turn_shape_unavailable");
        }
        let resultExhausted = false;
        const coverageAtRead = new Map();
        result.turns = turns.data.map(turn => ({
          turn_id: turn.id, started_at: timestamp(turn.startedAt), completed_at: timestamp(turn.completedAt),
          status: TURN_STATUS.has(turn.status) ? turn.status : null, body_visibility: "unavailable", messages: [],
        }));
        for (const [index, turn] of turns.data.entries()) {
          const shown = result.turns[index];
          const { status } = shown;
          if (!status || status === "inProgress") reasons.add(status ? "turn_in_progress" : "native_turn_status_unknown");
          if (!status || status === "inProgress" || resultExhausted) continue;
          const proof = turnCoverage(connection, threadId, turn);
          if (!proof) {
            reasons.add("visibility_unavailable");
            continue;
          }
          try {
            const items = await read(connection, "thread/items/list", { threadId, turnId: turn.id, limit: ITEM_LIMIT, sortDirection: "desc",
              deferOutput: { commandExecution: true, mcpToolCall: true } }, ITEM_LIMIT);
            if (turnCoverage(connection, threadId, turn) !== proof) {
              reasons.add("visibility_unavailable");
              continue;
            }
            if (!scoped(items, threadId) || !uniqueScopedItems(items.data,
              entry => scoped(entry, threadId) && entry.turnId === turn.id ? entry.item?.id : null)) {
              throw new ThreadReadError(502, "native_identity_mismatch");
            }
            if (items.nextCursor !== null) {
              reasons.add("item_page_limited");
              reasons.add("visibility_unavailable");
              continue;
            }
            if (verifyCoveredItems && !verifyCoveredItems(proof, items.data)) {
              reasons.add("visibility_unavailable");
              continue;
            }
            const verifiedItems = [];
            let visibilityUnavailable = false;
            for (const entry of items.data) {
              const item = entry.item;
              if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
              let projected;
              try { projected = projectItem(connection, threadId, turn.id, item, proof); } catch {}
              if (projected === null && !verifyCoveredItems) continue;
              if (projected?.id !== item.id || projected.type !== item.type) {
                reasons.add("visibility_unavailable");
                visibilityUnavailable = true;
                break;
              }
              verifiedItems.push({ entry, item, projected });
            }
            if (visibilityUnavailable) continue;
            for (const { entry, item, projected } of verifiedItems) {
              if (projected.type === "agentMessage" && /^msg_proxy_(?:root_)?[a-f0-9]{32}$/u.test(projected.id)) {
                reasons.add("local_notice_omitted");
                continue;
              }
              if (projected.type === "agentMessage" && projected.moderation?.moderated) {
                reasons.add("visibility_unavailable");
                continue;
              }
              if (projected.type === "agentMessage" && (item.phase !== "final_answer" || projected.phase !== "final_answer")) continue;
              const clipped = limitText(messageContent(projected), TEXT_LIMIT_BYTES);
              if (!clipped.text) continue;
              if (clipped.clipped) reasons.add("text_limited");
              shown.messages.push({ role: item.type === "userMessage" ? "user" : "assistant", text: clipped.text,
                started_at_ms: timestamp(entry.startedAtMs), completed_at_ms: timestamp(entry.completedAtMs), visibility: "visible" });
              if (jsonBytes({ ...result, coverage: responseCoverage(reasons) }) > THREAD_READ_RESULT_BYTES - 1024) {
                shown.messages.length = 0;
                reasons.add("result_limited");
                reasons.add("visibility_unavailable");
                resultExhausted = true;
                break;
              }
            }
            if (resultExhausted) continue;
            shown.messages.reverse();
            coverageAtRead.set(turn.id, { proof, turn });
          } catch (error) {
            const code = safeReason(error);
            if (["native_connection_changed", "read_cancelled"].includes(code)) throw error;
            reasons.add(code);
            if (code === "read_deadline") break;
          }
        }
        function checkCurrentTurnBodies() {
          ensureCurrent(connection);
          for (const shown of result.turns) {
            const evidence = coverageAtRead.get(shown.turn_id);
            if (!evidence) continue;
            if (turnCoverage(connection, threadId, evidence.turn) !== evidence.proof) {
              shown.messages.length = 0;
              shown.body_visibility = "unavailable";
              coverageAtRead.delete(shown.turn_id);
              reasons.add("visibility_unavailable");
            } else {
              shown.body_visibility = "verified";
            }
          }
        }
        checkCurrentTurnBodies();
        if (coverageAtRead.size) checkSnapshot = checkCurrentTurnBodies;
        result.turns.reverse();
      }
    } catch (error) {
      if (!list) result.turns.length = 0;
      reasons.clear();
      reasons.add(safeReason(error));
    } finally {
      occupied = false;
    }
    const body = { ...result, coverage: responseCoverage(reasons) };
    if (jsonBytes(body) > THREAD_READ_RESULT_BYTES) {
      return { ...(list ? { threads: [], next_cursor: null } : { thread_id: input.thread_id, turns: [] }),
        coverage: { partial: true, reasons: ["result_limited"] } };
    }
    if (checkSnapshot && typeof registerResponseCheck === "function") registerResponseCheck(() => {
      checkSnapshot();
      body.coverage = responseCoverage(reasons);
    });
    return body;
  };
}

export function createLiveCodexThreadReader(proxy, projectVisibleHistoryItem, observation) {
  if (typeof proxy?._liveReadyClients !== "function" || typeof proxy?._liveInjectRequest !== "function"
    || typeof projectVisibleHistoryItem !== "function") throw new TypeError("private thread read transport dependencies missing");
  return createCodexThreadReader({
    selectConnection() {
      if (proxy.closed) return null;
      const client = proxy._liveReadyClients()[0];
      return client?.upstream ? { client, upstream: client.upstream, generation: client.metadataUpstreamGeneration, epoch: proxy.writerEpoch } : null;
    },
    isCurrent({ client, upstream, generation, epoch }) {
      return !proxy.closed && proxy.writerEpoch === epoch && client.upstream === upstream
        && client.metadataUpstreamGeneration === generation && proxy._liveReadyClients().includes(client);
    },
    readNative(connection, method, params, options) {
      return proxy._liveInjectRequest(connection.client, method, params, options);
    },
    projectItem(connection, threadId, turnId, item, proof) {
      return projectVisibleHistoryItem({ client: connection.client, threadId, turnId, item,
        provenOrdinary: observation?.ownsInput(proof, item) === true });
    },
    proveTurnCoverage(connection, threadId, turn) {
      if (observation === null) return null;
      if (observation) return observation.coverage(connection.client, connection.epoch, threadId, turn);
      return proxy.readThreadVisibilityCoverage?.({ client: connection.client, threadId, turn });
    },
    ...(observation ? { verifyCoveredItems: observation.verifyItems } : {}),
  });
}
