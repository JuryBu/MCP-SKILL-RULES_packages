import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CoreError, assertExactKeys, digest, identityKey, normalizeIdentity, requireInteger, requireText } from "./contracts.mjs";
import { renderRecentSnapshot } from "./recent-snapshot-render.mjs";

const HOSTS = new Set(["codex", "antigravity", "windsurf"]);
const PAGE_LIMIT = 50;
const CURSOR_LIMIT = 1024;
const PROVIDER_CURSOR_LIMIT = 512;
const STATES = new Set(["running", "idle", "unknown", "offline"]);
const DISPLAY_STATE = { running: "正在运行", idle: "空闲", unknown: "未知", offline: "离线" };
const VIEW_LIMIT = 8192;
const MARKDOWN_LIMIT = 6000;
const BODY_ROLES = new Set(["user", "assistant", "activity", "external"]);
const HOST_READ_TIMEOUT_MS = 8000;

function hostScope(input, fallback) {
  const host = requireText(input.host, "host", 64);
  if (!HOSTS.has(host)) throw new CoreError("invalid_input", "仅支持本机 Codex、反重力或 WSF 的宿主内容");
  const identity = normalizeIdentity({
    machine_id: input.machine_id ?? fallback.machine_id,
    host,
    surface: input.surface ?? "desktop",
    conversation_id: "scope",
  });
  const { conversation_id, ...scope } = identity;
  return scope;
}

function sameScope(left, right) {
  return left?.machine_id === right.machine_id && left?.host === right.host && left?.surface === right.surface;
}

export function normalizeHostContentGrants(value, snapshot = false) {
  if (!Array.isArray(value) || value.length > 64) throw new CoreError("invalid_config", "宿主内容授权数量超限");
  const unique = new Set();
  return value.map(grant => {
    assertExactKeys(grant, ["machine_id", "host", "surface", ...(snapshot ? ["conversation_id", "all_conversations"] : [])], "宿主内容授权");
    const scope = hostScope({
      machine_id: requireText(grant.machine_id, "machine_id", 128),
      host: grant.host,
      surface: requireText(grant.surface, "surface", 64),
    }, {});
    let target = scope;
    if (snapshot) {
      if (grant.all_conversations === true && grant.conversation_id === undefined) target = { ...scope, all_conversations: true };
      else if (grant.all_conversations === undefined) target = normalizeIdentity({ ...scope, conversation_id: grant.conversation_id });
      else throw new CoreError("invalid_config", "近期正文授权必须明确为一条对话或整端");
    }
    if (target.conversation_id === "*" || unique.has(digest(target))) throw new CoreError("invalid_config", "需要不重复的明确宿主内容授权");
    unique.add(digest(target));
    return target;
  });
}

function querySignal(signal) {
  const timeout = AbortSignal.timeout(HOST_READ_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function assertAvailable(signal) {
  if (signal.aborted) throw new CoreError("host_content_unavailable", "宿主内容查询已超过期限或取消");
}

function shortText(value, maximum) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum && value.trim() ? value : undefined;
}

function timestamp(value) {
  const supplied = shortText(value, 64);
  return supplied && Number.isFinite(Date.parse(supplied)) ? supplied : undefined;
}

function displayFields(value) {
  return {
    title: shortText(value?.title, 512),
    workspace: shortText(value?.workspace, 512),
    project_id: shortText(value?.project_id, 256),
    status: STATES.has(value?.status) ? value.status : "unknown",
    updated_at: timestamp(value?.updated_at),
  };
}

function knownRoundSummary(metadata) {
  const status = new Map([["completed", "已结束"], ["inProgress", "进行中"], ["failed", "失败"], ["interrupted", "已中断"]]).get(metadata?.status);
  const startedAt = timestamp(metadata?.started_at);
  const completedAt = timestamp(metadata?.completed_at);
  const fields = [status, startedAt && `开始 ${startedAt}`, completedAt && `结束 ${completedAt}`].filter(Boolean);
  return fields.length ? `正文暂未提供 · ${fields.join(" · ")}` : null;
}

function compactRounds(value, limit, includeRoundMetadata) {
  if (!Array.isArray(value) || value.length > 5) throw new CoreError("host_content_unverified", "宿主未返回有界的最近轮次");
  let partial = value.length > limit;
  const rounds = value.slice(-limit).map(round => {
    if (!Array.isArray(round?.messages) || round.messages.length > 32) {
      throw new CoreError("host_content_unverified", "宿主未返回有界的发言记录");
    }
    const messages = [];
    for (const entry of round.messages) {
      if (!BODY_ROLES.has(entry?.role) || entry.visibility === "hidden") continue;
      const text = shortText(entry.text, entry.role === "activity" ? 160 : 8192);
      if (!text) {
        partial ||= typeof entry.text === "string" && Boolean(entry.text.trim());
        continue;
      }
      messages.push({
        role: entry.role,
        text,
        at: timestamp(entry.at),
        ...(entry.role === "external" ? { from_host: shortText(entry.from_host, 64) } : {}),
      });
    }
    if (includeRoundMetadata && !messages.length) {
      const text = knownRoundSummary(round.turn_metadata);
      if (text) messages.push({ role: "activity", text });
    }
    return { messages };
  });
  return { rounds, partial };
}

function coverageReasons(raw) {
  const recognized = ["native_history_unconfirmed", "visibility_unavailable", "item_page_limited", "native_connection_changed", "native_reply_too_large", "turn_in_progress", "native_index_limited", "result_limited", "text_limited", "native_turn_status_unknown"];
  if (raw.partial !== true || !Array.isArray(raw.coverage_reasons)) return {};
  const coverage_reasons = recognized.filter(reason => raw.coverage_reasons.includes(reason));
  return coverage_reasons.length ? { coverage_reasons } : {};
}

export function formatRecentSnapshotMcp(result) {
  const { markdown, ...metadata } = result;
  const output = { content: [{ type: "text", text: markdown }], structuredContent: metadata };
  if (typeof markdown !== "string" || Buffer.byteLength(JSON.stringify(output), "utf8") > VIEW_LIMIT) {
    throw new CoreError("host_content_unverified", "近期内容超过响应字节预算");
  }
  return output;
}

export class HostConversationContent {
  constructor({ providers = {} } = {}) {
    this.providers = providers;
    this.cursorKey = randomBytes(32);
  }

  cursor(value, scope, principal) {
    const key = digest({ scope, principal_id: principal.id, caller: identityKey(principal.identity) });
    const signature = encoded => createHmac("sha256", this.cursorKey).update(key).update(".").update(encoded).digest();
    return {
      encode: token => {
        if (token === null || token === undefined) return null;
        requireText(token, "provider cursor", PROVIDER_CURSOR_LIMIT);
        const encoded = Buffer.from(token, "utf8").toString("base64url");
        return `${encoded}.${signature(encoded).toString("base64url")}`;
      },
      decode: () => {
        if (value === null || value === undefined) return null;
        try {
          requireText(value, "cursor", CURSOR_LIMIT);
          const [encoded, mac, rest] = value.split(".");
          if (rest !== undefined || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(mac ?? "")) throw new Error();
          const supplied = Buffer.from(mac, "base64url");
          if (!timingSafeEqual(supplied, signature(encoded)) || supplied.toString("base64url") !== mac) throw new Error();
          const bytes = Buffer.from(encoded, "base64url");
          if (bytes.toString("base64url") !== encoded) throw new Error();
          return requireText(bytes.toString("utf8"), "cursor", PROVIDER_CURSOR_LIMIT);
        } catch {
          throw new CoreError("invalid_cursor", "请使用当前宿主和调用者的列表游标");
        }
      },
    };
  }

  async list(principal, input, { signal } = {}) {
    assertExactKeys(input, ["caller", "host", "limit", "cursor", "scope"], "宿主列表");
    const scope = hostScope(input, principal.identity);
    if (!(principal.allowed_host_lists ?? []).some(grant => sameScope(grant, scope))) {
      throw new CoreError("forbidden", "当前连接没有该宿主列表权限");
    }
    const provider = this.providers[scope.host];
    if (typeof provider?.list !== "function") throw new CoreError("host_content_unavailable", "宿主列表入口未就绪");
    const limit = requireInteger(input.limit ?? 20, "limit", 1, PAGE_LIMIT);
    const cursor = this.cursor(input.cursor, scope, principal);
    const upstreamCursor = cursor.decode();
    const combined = querySignal(signal);
    assertAvailable(combined);
    const raw = await provider.list(scope, { cursor: upstreamCursor, limit, signal: combined });
    assertAvailable(combined);
    if (!raw || !Array.isArray(raw.conversations) || raw.conversations.length > limit
      || raw.next_cursor != null && raw.next_cursor === upstreamCursor) {
      throw new CoreError("host_content_unverified", "宿主列表未返回可核对的分页");
    }
    const seen = new Set();
    const conversations = raw.conversations.map(entry => {
      const conversationId = requireText(entry?.conversation_id, "conversation_id", 256);
      if (seen.has(conversationId) || conversationId === "*"
        || ["machine_id", "host", "surface"].some(field => entry[field] !== undefined && entry[field] !== scope[field])) {
        throw new CoreError("host_content_unverified", "宿主列表包含重复或范围外记录");
      }
      seen.add(conversationId);
      return { ...scope, conversation_id: conversationId, ...displayFields(entry) };
    });
    const next = cursor.encode(raw.next_cursor);
    return { scope: "host", ...scope, conversations, next_cursor: next, has_more: next !== null, partial: raw.partial === true,
      ...(["desktop_catalog", "resident_index"].includes(raw.coverage_source) ? { coverage_source: raw.coverage_source } : {}),
      ...coverageReasons(raw) };
  }

  async snapshot(principal, input, { signal } = {}) {
    assertExactKeys(input, ["caller", "target", "last_rounds"], "近期内容");
    assertExactKeys(input.target, ["machine_id", "host", "surface", "conversation_id"], "近期内容目标");
    const scope = hostScope(input.target, principal.identity);
    const target = normalizeIdentity({ ...scope, conversation_id: input.target.conversation_id });
    if (target.conversation_id === "*") throw new CoreError("invalid_input", "请选择一个真实对话");
    if (!(principal.allowed_host_snapshots ?? []).some(grant => sameScope(grant, scope)
      && (grant.all_conversations === true || grant.conversation_id === target.conversation_id))) {
      throw new CoreError("forbidden", "当前连接没有该对话正文权限");
    }
    const provider = this.providers[scope.host];
    if (typeof provider?.readRecent !== "function") throw new CoreError("host_content_unavailable", "宿主近期内容入口未就绪");
    const requestedRounds = requireInteger(input.last_rounds ?? 3, "last_rounds", 1, 5);
    const combined = querySignal(signal);
    assertAvailable(combined);
    const raw = await provider.readRecent(target, { lastRounds: requestedRounds, signal: combined });
    assertAvailable(combined);
    if (!raw || typeof raw !== "object" || raw.conversation_id !== target.conversation_id
      || ["machine_id", "host", "surface"].some(field => raw[field] !== undefined && raw[field] !== target[field])) {
      throw new CoreError("host_content_unverified", "近期内容未对应原对话");
    }
    const { rounds, partial } = compactRounds(raw.rounds, requestedRounds, raw.partial === true);
    const observed = timestamp(raw.observed_at);
    const rendered = renderRecentSnapshot({
      ...displayFields(raw),
      status: STATES.has(raw.status) ? DISPLAY_STATE[raw.status] : "未知",
      host: target.host,
      conversation_id: target.conversation_id,
      observed_at: observed,
      current_selection: shortText(raw.current_selection, 192) ?? "未知",
      current_selection_at: timestamp(raw.current_selection_at),
      last_invocation: shortText(raw.last_invocation, 192) ?? "未知",
      last_invocation_at: timestamp(raw.last_invocation_at),
      rounds,
      partial: partial || raw.partial === true,
    }, { byteLimit: MARKDOWN_LIMIT });
    const result = { target, observed_at: observed ?? null, requested_rounds: requestedRounds, ...rendered, ...coverageReasons(raw) };
    formatRecentSnapshotMcp(result);
    return result;
  }
}
