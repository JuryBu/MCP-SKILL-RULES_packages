import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CoreError, identityKey } from "../contracts.mjs";
import { createOwnerReplyReader } from "../owner-replies.mjs";

const SOURCE_HOST_NAMES = new Map([["codex", "Codex"], ["antigravity", "Antigravity"], ["windsurf", "Windsurf"]]);
const SOURCE_TITLE_TIMEOUT_MS = 2500;
const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CONFIGURED_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_PROGRESS_CACHE_ENTRIES = 256;
const SENSITIVE_DIR_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..+)?|mcp_config\.json|auth\.json|cookies?\.(?:json|sqlite|db)|.+\.private\.json|.+\.local\.md|.+\.(?:pem|key|p12|pfx|jks|sqlite|sqlite-wal|sqlite-shm|db))$/iu;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function receipt(input, outcome, reason, extra = {}) {
  return {
    delivery_id: input.delivery.delivery_id,
    target_key: identityKey(input.target),
    outcome,
    ...(reason ? { reason } : {}),
    evidence: { kind: "transport", observed_at: new Date().toISOString() },
    ...extra,
  };
}

function busy(input, reason) {
  const attempt = Number.isSafeInteger(input.delivery.attempt_count) ? input.delivery.attempt_count : 1;
  const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, attempt - 1))));
  const result = receipt(input, "busy", reason, { error: { code: "unavailable" } });
  result.evidence.retry_after_ms = retryAfterMs;
  return result;
}

function unsupported(input, reason) {
  return receipt(input, "failed_before_send", reason, { error: { code: "unsupported" } });
}

function hasMessageId(value) {
  return (typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value))
    || (Number.isSafeInteger(value) && value !== 0);
}

function validFileName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && Buffer.byteLength(value, "utf8") <= 255
    && value === path.basename(value)
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value)
    && value !== "." && value !== ".."
    && !RESERVED_WINDOWS_NAME.test(value);
}

function canonicalForCompare(targetPath) {
  const normalized = path.resolve(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(fileRealPath, rootRealPath) {
  const rel = path.relative(canonicalForCompare(rootRealPath), canonicalForCompare(fileRealPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isSensitivePath(realPath) {
  const parts = realPath.split(/[\\/]+/).filter(Boolean);
  for (const segment of parts.slice(0, -1)) {
    if (SENSITIVE_DIR_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  const base = path.basename(realPath);
  return SENSITIVE_FILE_PATTERN.test(base);
}

function isDisallowedRawAttachmentRef(raw) {
  if (!boundedText(raw, 1024) || raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) return true;
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return true;
  if (URI_SCHEME_PREFIX.test(raw) && !WINDOWS_DRIVE_PREFIX.test(raw)) return true;
  if (!path.isAbsolute(raw)) return true;
  return false;
}

function normalizeAllowedRoots(roots) {
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > 32) throw new TypeError("NapCat附件允许根目录配置无效");
  const out = [];
  for (const root of roots) {
    if (isDisallowedRawAttachmentRef(root)) throw new TypeError("NapCat附件允许根目录配置无效");
    out.push(path.resolve(root));
  }
  return Object.freeze(out);
}

function resolveAllowedAttachments(attachments, { allowedAttachmentRoots, maxAttachmentBytes, maxAttachmentsPerMessage }) {
  if (attachments.length === 0) return { ok: true, items: [] };
  if (!allowedAttachmentRoots.length) return { ok: false, reason: "attachments_unsupported" };
  if (attachments.length > maxAttachmentsPerMessage) return { ok: false, reason: "too_many_attachments" };
  const resolvedRoots = [];
  for (const root of allowedAttachmentRoots) {
    try {
      const realRoot = realpathSync(root);
      if (statSync(realRoot).isDirectory()) resolvedRoots.push(realRoot);
    } catch {}
  }
  if (!resolvedRoots.length) return { ok: false, reason: "attachment_roots_unavailable" };
  const items = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const raw = attachments[index];
    if (isDisallowedRawAttachmentRef(raw)) return { ok: false, reason: "attachment_path_not_allowed" };
    let realPath;
    let info;
    try {
      realPath = realpathSync(raw);
      info = statSync(realPath);
    } catch {
      return { ok: false, reason: "attachment_not_found" };
    }
    if (!info.isFile()) return { ok: false, reason: "attachment_not_regular_file" };
    if (info.size <= 0) return { ok: false, reason: "attachment_empty" };
    if (info.size > maxAttachmentBytes) return { ok: false, reason: "attachment_too_large" };
    if (!resolvedRoots.some(root => isWithinRoot(realPath, root))) {
      return { ok: false, reason: "attachment_path_not_allowed" };
    }
    if (isSensitivePath(realPath)) return { ok: false, reason: "attachment_sensitive_path_blocked" };
    const fileName = path.basename(realPath);
    if (!validFileName(fileName)) return { ok: false, reason: "attachment_name_invalid" };
    items.push({ index, filePath: realPath, fileName, fileBytes: info.size });
  }
  return { ok: true, items };
}

function attachmentDedupeKey(deliveryId, index) {
  const direct = `communication-core:${deliveryId}:att:${index}`;
  if (direct.length <= 200) return direct;
  const digest = createHash("sha256").update(deliveryId, "utf8").digest("hex").slice(0, 32);
  return `communication-core:att:${digest}:${index}`;
}

function effectiveReplyHint(replyHint, surface) {
  if (replyHint === undefined) return undefined;
  if (surface === "private" && /并?\s*[@＠]我/u.test(replyHint)) {
    const normalized = replyHint.replace(/并?\s*[@＠]我/gu, "").trim();
    return normalized || "有事引用这条回复即可～";
  }
  return replyHint;
}

function parseChatFileReceipt(result, expectedTargetKey, item) {
  if (!result || typeof result !== "object" || result.ok !== true) return null;
  if (result.target?.targetKey && result.target.targetKey !== expectedTargetKey) return null;
  if (result.sent === true) {
    const messageId = result.fileMessageId || result.messageId;
    if (result.verified !== true || result.chatFileStatePersisted === false || !hasMessageId(messageId)) return null;
    return {
      index: item.index,
      file_name: boundedText(result.fileName, 255) ? result.fileName : item.fileName,
      file_bytes: Number.isSafeInteger(result.fileBytes) && result.fileBytes > 0 ? result.fileBytes : item.fileBytes,
      ...(typeof result.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(result.sha256) ? { sha256: result.sha256.toLowerCase() } : {}),
      message_id: String(messageId),
      ...(boundedText(result.fileId, 512) ? { file_id: result.fileId } : {}),
      verified: true,
      deduped: false,
    };
  }
  if (result.duplicateSuppressed === true && result.reason === "already_sent" && result.existing && typeof result.existing === "object") {
    const existing = result.existing;
    const messageId = existing.fileMessageId || existing.messageId || result.fileMessageId || result.messageId;
    if (existing.verified !== true || !hasMessageId(messageId)) return null;
    return {
      index: item.index,
      file_name: boundedText(existing.fileName, 255) ? existing.fileName : item.fileName,
      file_bytes: Number.isSafeInteger(existing.fileBytes) && existing.fileBytes > 0 ? existing.fileBytes : item.fileBytes,
      ...(typeof existing.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(existing.sha256) ? { sha256: existing.sha256.toLowerCase() } : {}),
      message_id: String(messageId),
      ...(boundedText(existing.fileId, 512) ? { file_id: existing.fileId } : {}),
      verified: true,
      deduped: true,
    };
  }
  return null;
}

export function createOwnerSourceTitleReader({ localMachineId, principals, readers }) {
  const authorized = new Map(principals.map(principal => [principal.id, principal]));
  return async (message, { signal } = {}) => {
    const source = message?.envelope?.caller;
    const principal = authorized.get(message?.principal_id);
    if (!localMachineId || source?.machine_id !== localMachineId || !principal || message.relay_inbound ||
      !boundedText(source.conversation_id, 256) || source.conversation_id === "*" || signal?.aborted) return null;
    const sameScope = grant => ["machine_id", "host", "surface"].every(field => grant[field] === source[field]);
    const canList = principal.allowed_host_lists?.some(sameScope) === true;
    if (!canList &&
      !principal.allowed_host_snapshots?.some(grant => sameScope(grant) &&
        (grant.all_conversations === true || grant.conversation_id === source.conversation_id))) return null;
    return readers.get(source.host)?.(source, { signal, canList });
  };
}

async function optionalSourceTitle(reader, message, signal, timeoutMs) {
  if (!reader || signal?.aborted) return null;
  const timeout = new AbortController();
  const lookup = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let cancel;
  try {
    const aborted = new Promise(resolve => {
      cancel = () => resolve(null);
      lookup.addEventListener("abort", cancel, { once: true });
      if (lookup.aborted) cancel();
    });
    const value = await Promise.race([Promise.resolve().then(() => reader(message, { signal: lookup })), aborted]);
    if (lookup.aborted || !boundedText(value, 128) || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]|\[\s*CQ:/iu.test(value)) return null;
    const title = value.trim();
    return title === message.envelope.caller.conversation_id ? null : title;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    lookup.removeEventListener("abort", cancel);
  }
}

export class NapcatOwnerAdapter {
  #deliveryProgress = new Map();

  constructor({
    transport,
    routeKey,
    replyHint,
    replyEvents,
    conversationId,
    readSourceTitle,
    sourceTitleTimeoutMs = SOURCE_TITLE_TIMEOUT_MS,
    allowedAttachmentRoots,
    maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
    maxAttachmentsPerMessage = DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  } = {}) {
    if (typeof transport?.status !== "function" || typeof transport?.sendOwnerAlert !== "function"
      || !boundedText(routeKey, 256) || (replyHint !== undefined && !boundedText(replyHint, 80))
      || (readSourceTitle !== undefined && typeof readSourceTitle !== "function")
      || !Number.isSafeInteger(sourceTitleTimeoutMs) || sourceTitleTimeoutMs < 50 || sourceTitleTimeoutMs > 10000
      || !Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > MAX_CONFIGURED_ATTACHMENT_BYTES
      || !Number.isSafeInteger(maxAttachmentsPerMessage) || maxAttachmentsPerMessage < 1 || maxAttachmentsPerMessage > 32) {
      throw new TypeError("NapCat通知适配器配置无效");
    }
    this.transport = transport;
    this.submissionTracking = transport.submissionTracking === true;
    this.routeKey = routeKey;
    this.replyHint = replyHint;
    this.readSourceTitle = readSourceTitle;
    this.sourceTitleTimeoutMs = sourceTitleTimeoutMs;
    this.allowedAttachmentRoots = normalizeAllowedRoots(allowedAttachmentRoots);
    this.maxAttachmentBytes = maxAttachmentBytes;
    this.maxAttachmentsPerMessage = maxAttachmentsPerMessage;
    if (conversationId !== undefined && (!boundedText(conversationId, 256) || conversationId.trim() !== conversationId || /[\u0000-\u001f\u007f]/.test(conversationId))) throw new TypeError("QQ路由调用身份无效");
    this.conversationId = conversationId;
    this.replyEvents = null;
    if (replyEvents !== undefined) {
      if (!replyEvents || typeof replyEvents !== "object" || Array.isArray(replyEvents) || typeof replyEvents.enabled !== "boolean") throw new TypeError("QQ回信配置无效");
      if (replyEvents.enabled) {
        if (typeof transport.readOwnerEvents !== "function" || !boundedText(replyEvents.callerConversationId, 256) || conversationId !== replyEvents.callerConversationId
          || !boundedText(replyEvents.targetKey, 256) || !Number.isSafeInteger(replyEvents.routeGeneration) || replyEvents.routeGeneration < 1
          || !Array.isArray(replyEvents.ownerSenderAllowlist) || !replyEvents.ownerSenderAllowlist.length || replyEvents.ownerSenderAllowlist.length > 32
          || Array.from(replyEvents.ownerSenderAllowlist).some(sender => typeof sender !== "string" || !/^[1-9]\d{0,19}$/.test(sender))
          || new Set(replyEvents.ownerSenderAllowlist).size !== replyEvents.ownerSenderAllowlist.length) throw new TypeError("QQ回信配置无效");
        this.replyEvents = Object.freeze({ ...replyEvents, ownerSenderAllowlist: Object.freeze([...replyEvents.ownerSenderAllowlist]) });
      }
    }
    this.closed = false;
  }

  #getProgress(deliveryId) {
    return this.#deliveryProgress.get(deliveryId);
  }

  #setProgress(deliveryId, entry) {
    this.#deliveryProgress.delete(deliveryId);
    this.#deliveryProgress.set(deliveryId, entry);
    while (this.#deliveryProgress.size > MAX_PROGRESS_CACHE_ENTRIES) {
      this.#deliveryProgress.delete(this.#deliveryProgress.keys().next().value);
    }
  }

  async deliver(input) {
    const envelope = input.message?.envelope;
    if (envelope?.origin?.kind !== "agent_message") return unsupported(input, "agent_origin_required");
    const attachments = envelope.attachment_refs ?? [];
    if (!Array.isArray(attachments)) return unsupported(input, "attachments_unsupported");
    if (!boundedText(envelope.text, 4000) || [...envelope.text].length > 1000) return unsupported(input, "text_unsupported");
    if (input.target.host !== "qq" || !boundedText(input.target.conversation_id, 256)) return unsupported(input, "qq_target_required");
    const sourceHost = envelope.caller?.host;
    if (!boundedText(sourceHost, 64) || /[\r\n\u0000-\u001f\u007f]/.test(sourceHost)
      || !boundedText(input.delivery.delivery_id, 181)) return unsupported(input, "source_or_delivery_invalid");
    if (attachments.length > 0 && typeof this.transport.sendConfiguredChatFile !== "function") {
      return unsupported(input, "attachments_unsupported");
    }
    const attachmentPlan = resolveAllowedAttachments(attachments, {
      allowedAttachmentRoots: this.allowedAttachmentRoots,
      maxAttachmentBytes: this.maxAttachmentBytes,
      maxAttachmentsPerMessage: this.maxAttachmentsPerMessage,
    });
    if (!attachmentPlan.ok) return unsupported(input, attachmentPlan.reason);
    const format = label => `交流核心转送 / 来源${label}：\n${envelope.text}`;
    let summary = format((SOURCE_HOST_NAMES.get(sourceHost) ?? sourceHost) + "对话");
    if (summary.length > 800) return unsupported(input, "owner_alert_summary_too_long");
    if (this.closed || input.signal?.aborted) return busy(input, "aborted_before_send");
    let status;
    try {
      status = await this.transport.status({ signal: input.signal });
    } catch {
      return busy(input, "status_unavailable_before_send");
    }
    if (status?.ready !== true || status.ok === false) return busy(input, "napcat_not_ready");

    const deliveryId = input.delivery.delivery_id;
    const progress = this.#getProgress(deliveryId) ?? { textReceipt: null, attachments: new Map() };
    let textReceipt = progress.textReceipt;

    if (!textReceipt) {
      const title = await optionalSourceTitle(this.readSourceTitle, input.message, input.signal, this.sourceTitleTimeoutMs);
      if (title) {
        const named = format("「" + title + "」");
        if (named.length <= 800) summary = named;
      }
      if (this.closed || input.signal?.aborted) return busy(input, "aborted_before_send");
      const replyHint = effectiveReplyHint(this.replyHint, input.target.surface);
      let result;
      try {
        result = await this.transport.sendOwnerAlert({
          route_key: this.routeKey,
          dedupe_key: `communication-core:${deliveryId}`,
          summary,
          ...(replyHint === undefined ? {} : { reply_hint: replyHint }),
        }, { signal: input.signal, ...(typeof input.onRequestStarted === "function" ? { onRequestStarted: input.onRequestStarted } : {}) });
      } catch (error) {
        if (error instanceof CoreError && error.code === "napcat_mcp_unconfirmed" && error.details?.request_sent === false) {
          return busy(input, "transport_unavailable_before_send");
        }
        return receipt(input, "unknown", "owner_alert_submission_unconfirmed");
      }
      if (!result || result.ok !== true || (result.sent !== true && result.deduped !== true)
        || result.verified !== true || result.statePersisted !== true
        || result.target?.targetKey !== input.target.conversation_id || !hasMessageId(result.messageId)) {
        return receipt(input, "unknown", "owner_alert_receipt_unconfirmed");
      }
      textReceipt = {
        provider: "napcat_owner",
        message_id: String(result.messageId),
        verified: true,
        state_persisted: true,
      };
      const captured = result.replyRoute;
      if (this.conversationId && captured?.messageId === String(result.messageId) && captured.routeKey === this.routeKey
        && captured.conversationId === this.conversationId && captured.targetKey === input.target.conversation_id
        && Number.isSafeInteger(captured.ownerEventGeneration) && captured.ownerEventGeneration > 0) {
        textReceipt.reply_route = { route_key: this.routeKey, conversation_id: this.conversationId, target_key: input.target.conversation_id, generation: captured.ownerEventGeneration };
      }
      if (attachmentPlan.items.length > 0) {
        progress.textReceipt = textReceipt;
        this.#setProgress(deliveryId, progress);
        input.onPartialReceipt?.({
          kind: "receipt",
          partial_delivery: true,
          native_receipt: { ...textReceipt, attachments: [] },
        });
      }
    }

    if (attachmentPlan.items.length === 0) {
      const accepted = receipt(input, "accepted");
      accepted.evidence.kind = "receipt";
      accepted.evidence.native_receipt = textReceipt;
      return accepted;
    }

    const attachmentReceipts = [];
    for (const item of attachmentPlan.items) {
      const cached = progress.attachments.get(item.index);
      if (cached) {
        attachmentReceipts.push(cached);
        continue;
      }
      if (this.closed || input.signal?.aborted) {
        const partial = receipt(input, "unknown", "owner_attachment_submission_unconfirmed");
        partial.evidence.kind = "receipt";
        partial.evidence.partial_delivery = true;
        partial.evidence.native_receipt = { ...textReceipt, attachments: [...attachmentReceipts] };
        return partial;
      }
      let fileResult;
      try {
        fileResult = await this.transport.sendConfiguredChatFile({
          target_key: input.target.conversation_id,
          file_path: item.filePath,
          name: item.fileName,
          dedupe_key: attachmentDedupeKey(deliveryId, item.index),
        }, { signal: input.signal, ...(typeof input.onRequestStarted === "function" ? { onRequestStarted: input.onRequestStarted } : {}) });
      } catch {
        const partial = receipt(input, "unknown", "owner_attachment_submission_unconfirmed");
        partial.evidence.kind = "receipt";
        partial.evidence.partial_delivery = true;
        partial.evidence.native_receipt = { ...textReceipt, attachments: [...attachmentReceipts] };
        return partial;
      }
      const parsed = parseChatFileReceipt(fileResult, input.target.conversation_id, item);
      if (!parsed) {
        const partial = receipt(input, "unknown", "owner_attachment_receipt_unconfirmed");
        partial.evidence.kind = "receipt";
        partial.evidence.partial_delivery = true;
        partial.evidence.native_receipt = { ...textReceipt, attachments: [...attachmentReceipts] };
        return partial;
      }
      progress.attachments.set(item.index, parsed);
      this.#setProgress(deliveryId, progress);
      attachmentReceipts.push(parsed);
      if (attachmentReceipts.length < attachmentPlan.items.length) {
        input.onPartialReceipt?.({
          kind: "receipt",
          partial_delivery: true,
          native_receipt: { ...textReceipt, attachments: [...attachmentReceipts] },
        });
      }
    }

    this.#deliveryProgress.delete(deliveryId);
    const accepted = receipt(input, "accepted");
    accepted.evidence.kind = "receipt";
    accepted.evidence.native_receipt = { ...textReceipt, attachments: attachmentReceipts };
    return accepted;
  }

  async query(input) {
    return receipt(input, "unknown", "owner_alert_recovery_query_unsupported", { error: { code: "unsupported" } });
  }

  async observeReply(input) {
    if (this.closed || !this.replyEvents || input.signal?.aborted || input.target?.conversation_id !== this.replyEvents.targetKey) return null;
    const capturedRoute = input.delivery?.evidence?.evidence?.native_receipt?.reply_route;
    if (!capturedRoute
      || capturedRoute.route_key !== this.routeKey
      || capturedRoute.conversation_id !== this.replyEvents.callerConversationId
      || capturedRoute.target_key !== this.replyEvents.targetKey
      || capturedRoute.generation !== this.replyEvents.routeGeneration) {
      return null;
    }
    const reader = createOwnerReplyReader({
      enabled: true,
      callerConversationId: this.replyEvents.callerConversationId,
      ownerSenderAllowlist: this.replyEvents.ownerSenderAllowlist,
      binding: {
        message_id: input.message.message_id,
        delivery_id: input.delivery.delivery_id,
        route: { route_key: this.routeKey, conversation_id: this.replyEvents.callerConversationId, target_key: this.replyEvents.targetKey, generation: this.replyEvents.routeGeneration },
      },
      readPage: (parameters, context) => this.transport.readOwnerEvents(parameters, context),
    });
    const observed = await reader(input);
    return observed?.status === "unsupported" ? null : observed;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#deliveryProgress.clear();
    await this.transport.close?.();
  }
}
