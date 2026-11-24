import { CoreError, requireText } from "./contracts.mjs";

const ACTIVE = new Set(["active", "inProgress", "running"]);
const IDLE = new Set(["idle", "notLoaded", "completed", "failed", "interrupted"]);
const TERMINAL_TURNS = new Set(["completed", "failed", "interrupted"]);
const VISIBLE_ROLES = new Set(["user", "assistant"]);

function failure() {
  return new CoreError("host_content_unverified", "Codex 没有返回可信的有界会话投影");
}

function status(value) {
  const candidate = typeof value === "object" ? value?.type : value;
  return ACTIVE.has(candidate) ? "running" : IDLE.has(candidate) ? "idle" : "unknown";
}

function iso(value) {
  const epoch = typeof value === "string" && value.length <= 64 ? Date.parse(value) : Number.isSafeInteger(value) ? value * 1000 : NaN;
  return Number.isFinite(epoch) && Math.abs(epoch) <= 8640000000000000 ? new Date(epoch).toISOString() : undefined;
}

function coverage(value) {
  if (!value || typeof value.partial !== "boolean") throw failure();
  return { partial: value.partial, coverage_reasons: value.partial && Array.isArray(value.reasons) ? value.reasons : [] };
}

function itemTime(entry) {
  for (const value of [entry.started_at_ms, entry.completed_at_ms]) {
    if (Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000) return new Date(value).toISOString();
  }
  return iso(entry.at);
}

async function optionalMetadata(inspectThread, target, signal, now) {
  if (typeof inspectThread !== "function") return null;
  try {
    const timeLimit = AbortSignal.timeout(1800);
    const lookupSignal = signal ? AbortSignal.any([signal, timeLimit]) : timeLimit;
    const result = await inspectThread(target, { signal: lookupSignal });
    if (lookupSignal.aborted || result?.threadId !== target || result.found !== true || result.thread?.id !== target) return null;
    return { thread: result.thread, observed_at: new Date(now()).toISOString() };
  } catch {
    return null;
  }
}

export function createCodexConversationContent(transport, { inspectThread, now = () => Date.now() } = {}) {
  if (typeof transport?.readHostContent !== "function") throw new TypeError("Codex 内容提供方需要只读入口");
  return {
    async list(scope, { limit, cursor, signal }) {
      const data = await transport.readHostContent("list", { limit, ...(cursor === null ? {} : { cursor }) }, { signal });
      if (!Array.isArray(data?.threads) || data.threads.length > limit) throw failure();
      return {
        conversations: data.threads.map(thread => ({
          ...scope,
          conversation_id: requireText(thread?.thread_id, "thread_id", 256),
          title: thread.title,
          workspace: thread.workspace,
          project_id: thread.project_id,
          status: status(thread.status),
          updated_at: iso(thread.updated_at),
        })),
        next_cursor: data.next_cursor ?? null,
        ...coverage(data.coverage),
      };
    },
    async readRecent(target, { lastRounds, signal }) {
      const [data, metadata] = await Promise.all([
        transport.readHostContent("snapshot", { thread_id: target.conversation_id, last_rounds: lastRounds }, { signal }),
        optionalMetadata(inspectThread, target.conversation_id, signal, now),
      ]);
      const thread = metadata?.thread;
      if (data?.thread_id !== target.conversation_id || !Array.isArray(data.turns) || data.turns.length > lastRounds) throw failure();
      const coverageInfo = coverage(data.coverage);
      const reasons = new Set(coverageInfo.coverage_reasons);
      const seen = new Set();
      const rounds = data.turns.map(turn => {
        if (!turn || typeof turn.turn_id !== "string" || !turn.turn_id || seen.has(turn.turn_id)
          || !Array.isArray(turn.messages) || turn.messages.length > 20) throw failure();
        seen.add(turn.turn_id);
        const body = turn.messages.filter(entry => VISIBLE_ROLES.has(entry?.role));
        const verified = turn.body_visibility === "verified" && TERMINAL_TURNS.has(turn.status)
          && body.every(entry => entry.visibility === "hidden" || (entry.visibility === "visible" && typeof entry.text === "string"));
        if (!verified) reasons.add(turn.status === "inProgress" ? "turn_in_progress" : "visibility_unavailable");
        return {
          turn_metadata: { status: turn.status, started_at: iso(turn.started_at), completed_at: iso(turn.completed_at) },
          messages: verified ? body.filter(entry => entry.visibility === "visible")
            .map(entry => ({ role: entry.role, text: entry.text, at: itemTime(entry) })) : [],
        };
      });
      return {
        ...target,
        title: data.title ?? thread?.name ?? thread?.title,
        workspace: data.workspace ?? thread?.workspace,
        project_id: data.project_id ?? thread?.projectId,
        status: status(thread?.status),
        observed_at: new Date(now()).toISOString(),
        current_selection: thread?.model,
        current_selection_at: thread?.model && thread.model !== "unknown" ? metadata?.observed_at : undefined,
        last_invocation: undefined,
        rounds,
        partial: coverageInfo.partial || reasons.size !== 0,
        coverage_reasons: [...reasons],
      };
    },
  };
}
