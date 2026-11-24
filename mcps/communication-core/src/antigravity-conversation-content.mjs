import { CoreError, identityKey } from "./contracts.mjs";

const USER_INPUT = new Set(["user_input", "CORTEX_STEP_TYPE_USER_INPUT"]);
const PLANNER_RESPONSE = new Set(["planner_response", "CORTEX_STEP_TYPE_PLANNER_RESPONSE"]);
const DONE = new Set(["DONE", "CORTEX_STEP_STATUS_DONE"]);
const ACTIVITY = /(?:^|_)(?:GENERIC|MCP_TOOL|VIEW_FILE|CODE_ACTION|INVOKE_SUBAGENT)$/u;
const RUNNING = new Set(["RUNNING", "CASCADE_RUN_STATUS_RUNNING"]);
const IDLE = new Set(["IDLE", "CASCADE_RUN_STATUS_IDLE", "CASCADE_RUN_STATUS_NOT_LOADED"]);
const TARGET_SIZE = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RELAY_HEADER = /^(?:\[COMMUNICATION_CORE(?: |\])|主人在QQ(?:中的引用回信|窗口中的来信)，由交流核心转送。|这条消息来自「[^\r\n]+」代理对话「[^\r\n]+」，由交流核心转送。)/u;
const CATALOG = "catalog:";
const RESIDENT = "resident:";

function status(value) {
  return RUNNING.has(value) ? "running" : IDLE.has(value) ? "idle" : "unknown";
}

function at(step) {
  return typeof step.timestamp === "string" && Number.isFinite(Date.parse(step.timestamp)) ? step.timestamp : undefined;
}

function originalSender(step, target, getMessageForDelivery) {
  const text = step.user_input?.text;
  const id = step.user_input?.client_message_id;
  const hasRelayHeader = typeof text === "string" && RELAY_HEADER.test(text);
  const unverified = { omitted: true, partial: true };
  if (typeof getMessageForDelivery !== "function" || typeof id !== "string" || !UUID.test(id)) return hasRelayHeader ? unverified : null;
  const original = getMessageForDelivery(id);
  if (!original) return hasRelayHeader ? unverified : null;
  const envelope = original?.envelope;
  if (original.target_key !== identityKey(target)) return unverified;
  if (envelope?.message_visibility === "hidden") return { omitted: true };
  if (!hasRelayHeader || !envelope || (envelope.message_visibility !== undefined && envelope.message_visibility !== "visible") || !UUID.test(original.message_id ?? "")
    || typeof envelope.text !== "string" || !text.includes(`[COMMUNICATION_CORE message_id=${original.message_id} delivery_id=${id}]`)
    || !text.endsWith(`\n\n${envelope.text}`)) return unverified;
  return { role: "external", text: envelope.text, from_host: envelope.caller?.host, visibility: "visible", at: at(step) };
}

export function projectAntigravityTail(tail, target, lastRounds, getMessageForDelivery) {
  if (tail?.description?.cascade_id !== target.conversation_id || !Array.isArray(tail.steps) || tail.steps.length > 128) {
    throw new CoreError("host_content_unverified", "反重力尾步不属于原对话或超出限制");
  }
  const rounds = [];
  let current;
  let prefixUnknown = false;
  let activityCount = 0;
  let partial = tail.partial === true;
  function round(started) {
    if (activityCount && current?.messages.length) current.messages.push({ role: "activity", text: `该轮还有 ${activityCount} 条工具或活动记录` });
    activityCount = 0;
    current = { messages: [], started };
    rounds.push(current);
  }
  function append(entry) {
    if (typeof entry?.text !== "string" || !entry.text.trim() || entry.visibility === "hidden") return;
    if (Buffer.byteLength(entry.text, "utf8") > TARGET_SIZE || current.messages.length >= 31) {
      partial = true;
      return;
    }
    current.messages.push(entry);
  }
  for (const step of tail.steps) {
    if (USER_INPUT.has(step?.type) && typeof step.user_input?.text === "string") {
      const message = originalSender(step, target, getMessageForDelivery) ?? { role: "user", text: step.user_input.text, at: at(step) };
      if (message.omitted) {
        partial ||= message.partial === true;
        continue;
      }
      const humanAfterActivity = message.role === "user" && (activityCount > 0 || current?.messages.some(entry => entry.role === "assistant"));
      if (!current || step.interrupting === true || !step.execution_id || step.execution_id !== current.started || humanAfterActivity) round(step.execution_id);
      append(message);
    } else if (PLANNER_RESPONSE.has(step?.type) && DONE.has(step.status)
      && step.assistant_response?.final === true && step.assistant_response.has_tool_calls !== true) {
      if (!current) {
        prefixUnknown = true;
        round(step.execution_id);
      }
      append({ role: "assistant", text: step.assistant_response.text, at: at(step) });
    } else if (current && ACTIVITY.test(step?.type ?? "")) {
      activityCount += 1;
    }
  }
  if (activityCount && current?.messages.length) current.messages.push({ role: "activity", text: `该轮还有 ${activityCount} 条工具或活动记录` });
  const visible = rounds.filter(entry => entry.messages.length > 0).map(entry => ({ messages: entry.messages }));
  partial ||= (tail.omitted_earlier === true || prefixUnknown) && visible.length <= lastRounds;
  return { rounds: visible.slice(-lastRounds), partial };
}

export function createAntigravityConversationContent(transport, { getMessageForDelivery, summaryIndex, now = () => Date.now() } = {}) {
  if (typeof transport?.listContentIndex !== "function" || typeof transport?.readContentTail !== "function") {
    throw new TypeError("反重力内容提供方需要有界原生索引与尾步入口");
  }
  return {
    async list(scope, { limit, cursor, signal }) {
      const catalogCursor = typeof cursor === "string" ? /^catalog:([a-f0-9]{24}):([a-zA-Z0-9_-]{1,128})$/u.exec(cursor) : null;
      const residentCursor = typeof cursor === "string" && /^resident:[^:]+$/u.test(cursor);
      if (cursor !== null && !catalogCursor && !residentCursor) {
        throw new CoreError("invalid_cursor", "请选择同一反重力目录分页");
      }
      if (catalogCursor && !summaryIndex) throw new CoreError("host_content_unavailable", "原分页目录已停止");
      if (summaryIndex && !residentCursor) {
        let page;
        try {
          page = await summaryIndex.page({ limit, after: catalogCursor?.[2] ?? "", signal });
        } catch (error) {
          if (cursor !== null || error?.code !== "host_content_unavailable") throw error;
        }
        if (page) {
          if (typeof page.generation !== "string" || !/^[a-f0-9]{24}$/u.test(page.generation)) {
            throw new CoreError("host_content_unverified", "反重力目录未返回可核对的来源版本");
          }
          if (catalogCursor && catalogCursor[1] !== page.generation) throw new CoreError("invalid_cursor", "反重力目录已更换，请从第一页查询");
          const started = AbortSignal.timeout(1900);
          const overlaySignal = signal ? AbortSignal.any([signal, started]) : started;
          const live = await transport.listContentIndex({ signal: overlaySignal }).catch(() => null);
          const active = new Map((live?.conversations ?? []).map(record => [record.cascade_id, status(record.status)]));
          return {
            conversations: page.conversations.map(record => ({
              ...scope, conversation_id: record.cascade_id, title: record.title,
              workspace: record.workspace, updated_at: record.updated_at, status: active.get(record.cascade_id) ?? "unknown",
            })),
            next_cursor: page.has_more ? CATALOG + page.generation + ":" + page.conversations.at(-1).cascade_id : null,
            partial: false,
            coverage_source: "desktop_catalog",
          };
        }
      }
      const value = await transport.listContentIndex({ signal });
      const ordered = value.conversations.sort((left, right) => left.cascade_id < right.cascade_id ? -1 : left.cascade_id > right.cascade_id ? 1 : 0);
      const filtered = cursor === null ? ordered : ordered.filter(record => record.cascade_id > cursor.slice(RESIDENT.length));
      const selected = filtered.slice(0, limit);
      return {
        conversations: selected.map(record => ({
          ...scope, conversation_id: record.cascade_id, title: record.title, status: status(record.status),
          workspace: record.workspace, updated_at: record.updated_at,
        })),
        next_cursor: filtered.length > limit ? RESIDENT + selected.at(-1).cascade_id : null,
        partial: true,
        coverage_source: "resident_index",
        coverage_reasons: ["native_index_limited"],
      };
    },
    async readRecent(target, { lastRounds, signal }) {
      const verifyColdTarget = typeof summaryIndex?.find === "function"
        ? async checkSignal => (await summaryIndex.find({ conversationId: target.conversation_id, signal: checkSignal }))?.cascade_id === target.conversation_id
        : undefined;
      const value = await transport.readContentTail(target, { signal, verifyColdTarget });
      return {
        ...target,
        title: value.description.title,
        workspace: value.description.workspace,
        status: status(value.description.status),
        observed_at: new Date(now()).toISOString(),
        current_selection: value.current_selection,
        current_selection_at: value.current_selection_at,
        last_invocation: value.last_invocation,
        last_invocation_at: value.last_invocation_at,
        ...projectAntigravityTail(value, target, lastRounds, getMessageForDelivery),
      };
    },
  };
}
