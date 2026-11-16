import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { types } from "node:util";
import { CoreError, digest, identityKey, requireInteger, requireText } from "./contracts.mjs";

const IDENTITY_FIELDS = ["machine_id", "host", "surface", "conversation_id"];
const READ_FIELDS = ["caller", "channel", "window_type", "window_id", "count", "cursor"];
const DOWNLOAD_FIELDS = ["caller", "channel", "window_type", "window_id", "attachment_ref", "destination_dir", "name", "retry_failed", "expected_operation_id"];
const MESSAGE_FIELDS = ["messageId", "messageSeq", "time", "senderId", "senderName", "isSelf", "text", "ownerEventContent",
  "mentionedUserIds", "replyMessageId", "contentTypes", "hasExplicitText"];
const ATTACHMENT_TEXT_LIMITS = { type: 32, fileId: 4096, fileName: 1024, mime: 128, mimeType: 128 };
const ATTACHMENT_NUMBER_FIELDS = ["fileBytes", "busId", "width", "height"];
const REFERENCE_TTL_MS = 30 * 60 * 1000;
const MAX_REFERENCES = 1024;
const MAX_CURSORS = 256;
const MAX_DOWNLOAD_MS = 45000;

function dataBudget({ maxBytes = 4 * 1024 * 1024, maxNodes = 65536, maxKeys = 32768 } = {}) {
  return { bytes: 0, nodes: 0, keys: 0, maxBytes, maxNodes, maxKeys };
}

function consumeBudget(budget, bytes = 0, nodes = 0, keys = 0) {
  budget.bytes += bytes;
  budget.nodes += nodes;
  budget.keys += keys;
  const limit = budget.bytes > budget.maxBytes ? "bytes" : budget.nodes > budget.maxNodes ? "nodes" : budget.keys > budget.maxKeys ? "keys" : null;
  if (limit) throw new CoreError("channel_content_invalid", "QQ内容超出大小、节点或字段预算", { budget: limit });
}

function dataObject(value, name, allowed, budget) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CoreError("invalid_input", `${name}必须是普通对象`);
  }
  const copied = {};
  const keys = Reflect.ownKeys(value);
  if (budget) consumeBudget(budget, keys.length * 16, 0, keys.length);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
      || (allowed && !allowed.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new CoreError("invalid_input", `${name}包含不支持或不安全的字段`);
    }
    if (budget) consumeBudget(budget, Buffer.byteLength(key, "utf8"));
    copied[key] = descriptor.value;
  }
  return copied;
}

function dataArray(value, name, maximum) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new CoreError("invalid_input", `${name}必须是数量受限的普通数组`);
  }
  const copied = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new CoreError("invalid_input", `${name}包含空项或访问器`);
    copied.push(descriptor.value);
  }
  return copied;
}

function identifier(value, name, maximum = 256) {
  requireText(value, name, maximum);
  if (value.trim() !== value || value === "*" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CoreError("invalid_input", `${name}必须是明确且不含控制字符的标识`);
  }
  return value;
}

function abortSignal(value) {
  if (value !== undefined && (types.isProxy(value) || !(value instanceof AbortSignal))) throw new CoreError("invalid_input", "signal必须是有效的AbortSignal");
  return value;
}

function callerIdentity(value) {
  const caller = dataObject(value, "调用者", IDENTITY_FIELDS);
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, identifier(caller[field], field, field === "conversation_id" ? 256 : 128)]));
}

function messageId(value) {
  if (Number.isSafeInteger(value) && value !== 0) value = String(value);
  if (typeof value !== "string" || !/^-?[1-9]\d{0,19}$/.test(value)) throw new CoreError("channel_content_invalid", "QQ消息缺少可核对的原消息ID");
  return value;
}

function copyData(value, budget = dataBudget(), depth = 0) {
  if (depth > 12) throw new CoreError("channel_content_invalid", "QQ内容嵌套超出范围");
  consumeBudget(budget, 16, 1);
  if (typeof value === "string") {
    consumeBudget(budget, Buffer.byteLength(value, "utf8"));
    return value;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    const entries = dataArray(value, "QQ内容数组", 512);
    consumeBudget(budget, entries.length * 8);
    return entries.map(entry => copyData(entry, budget, depth + 1));
  }
  const record = dataObject(value, "QQ内容", undefined, budget);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, copyData(entry, budget, depth + 1)]));
}

function selectData(value, fields, budget = dataBudget()) {
  const record = dataObject(value, "QQ内容", undefined, budget);
  return Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, copyData(record[field], budget)]));
}

function attachmentMetadata(value, pageBudget) {
  const budget = dataBudget({ maxBytes: 16 * 1024, maxNodes: 64, maxKeys: 32 });
  const attachment = dataObject(value, "QQ附件", undefined, budget);
  const metadata = {};
  for (const [field, maximum] of Object.entries(ATTACHMENT_TEXT_LIMITS)) {
    const entry = attachment[field];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > maximum || /[\u0000-\u001f\u007f]/.test(entry)
      || (field === "type" && !entry.trim())) throw new CoreError("channel_content_invalid", `QQ附件${field}的类型或长度无效`);
    metadata[field] = entry;
  }
  for (const field of ATTACHMENT_NUMBER_FIELDS) {
    const entry = attachment[field];
    if (entry === undefined) continue;
    if (entry !== null && (!Number.isSafeInteger(entry) || entry < 0)) throw new CoreError("channel_content_invalid", `QQ附件${field}必须是非负安全整数或null`);
    metadata[field] = entry;
  }
  if (attachment.sha256 !== undefined) {
    if (attachment.sha256 !== null && (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(attachment.sha256))) {
      throw new CoreError("channel_content_invalid", "QQ附件sha256无效");
    }
    metadata.sha256 = attachment.sha256;
  }
  if (attachment.downloadable !== undefined && typeof attachment.downloadable !== "boolean") throw new CoreError("channel_content_invalid", "QQ附件downloadable必须是布尔值");
  copyData(metadata, budget);
  return { attachment, metadata: copyData(metadata, pageBudget) };
}

function directory(value) {
  identifier(value, "destination_dir", 4096);
  if (!isAbsolute(value) || (process.platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value))) {
    throw new CoreError("invalid_input", "destination_dir必须是完整绝对目录路径");
  }
  return resolve(value);
}

function fileName(value) {
  identifier(value, "name", 255);
  if (value === "." || value === ".." || posix.basename(value) !== value || win32.basename(value) !== value
    || /[<>:"|?*]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new CoreError("invalid_input", "name必须是单个有效文件名");
  }
  return value;
}

function assertTarget(value, scope) {
  const target = dataObject(value, "QQ提供方目标");
  const targetId = typeof target.id === "string" ? target.id : Number.isSafeInteger(target.id) ? String(target.id) : null;
  if (target.type !== scope.window.window_type || targetId !== scope.window.window_id
    || (target.target_key !== undefined && target.target_key !== scope.target_key)
    || (target.targetKey !== undefined && target.targetKey !== scope.target_key)) {
    throw new CoreError("channel_content_scope_mismatch", "QQ提供方返回的窗口与配置不匹配");
  }
  if (target.name !== undefined && (typeof target.name !== "string" || Buffer.byteLength(target.name, "utf8") > 1024)) throw new CoreError("channel_content_invalid", "QQ提供方窗口名称过长或类型无效");
  return selectData({ ...target, id: targetId }, ["type", "id", "name"]);
}

export class ChannelContentReader {
  #sources;
  #adapters;
  #now;
  #closed = false;
  #shutdown = new AbortController();
  #references = new Map();
  #referencesByContent = new Map();
  #cursors = new Map();
  #temporaryRoot = join(tmpdir(), "communication-core-channel-content", randomUUID());
  #downloadLedger;
  #operations = new Map();
  #operationHeads = new Map();
  #successors = new Map();
  #preparations = new Map();
  #writes = new Set();
  #closePromise;

  constructor({ sources = [], adapters, now = () => Date.now(), downloadLedger } = {}) {
    dataArray(sources, "QQ窗口来源", 1000);
    if (!(adapters instanceof Map) || typeof now !== "function") throw new CoreError("invalid_config", "QQ内容读取配置无效");
    this.#sources = sources;
    this.#adapters = adapters;
    this.#now = now;
    if (downloadLedger !== undefined && (!downloadLedger || ["read", "begin", "update", "close"].some(method => typeof downloadLedger[method] !== "function"))) {
      throw new CoreError("invalid_config", "下载持久记录接口无效");
    }
    this.#downloadLedger = downloadLedger;
  }

  #scope(principal, input, permission) {
    if (this.#closed) throw new CoreError("service_closing", "QQ内容读取模块已关闭");
    const caller = callerIdentity(input.caller);
    if (identityKey(caller) !== identityKey(callerIdentity(principal?.identity))) throw new CoreError("caller_mismatch", "来源对话超出当前连接授权");
    if (input.channel !== "qq") throw new CoreError("channel_not_enabled", "最近内容读取仅支持已配置的QQ窗口");
    if (!["private", "group"].includes(input.window_type)) throw new CoreError("invalid_input", "QQ窗口类型无效");
    const windowId = identifier(input.window_id, "window_id");
    if (!/^[1-9]\d{0,19}$/.test(windowId)) throw new CoreError("invalid_input", "QQ窗口ID必须是准确的账号或群号");
    const candidates = dataArray(this.#sources, "QQ窗口来源", 1000).map(source => dataObject(source, "QQ窗口来源"))
      .filter(source => source.channel === input.channel && source.window_type === input.window_type && source.window_id === windowId);
    if (!candidates.length) throw new CoreError("channel_not_enabled", "该QQ窗口没有已启用的授权配置");
    if (candidates.length !== 1) throw new CoreError("channel_window_ambiguous", "该QQ窗口配置存在歧义");
    const source = candidates[0];
    const target = dataObject(source.source_target, "QQ来源目标");
    const bindingId = identifier(source.channel_binding_id, "channel_binding_id", 128);
    const allowed = dataArray(principal[permission] ?? [], permission, 1000);
    if (allowed.some(binding => typeof binding !== "string") || !allowed.includes(bindingId)) throw new CoreError("forbidden", "当前调用者没有该QQ窗口的对应内容权限");
    const targetKey = identifier(source.target_key, "target_key");
    if (target.host !== "qq" || target.surface !== input.window_type || target.conversation_id !== targetKey
      || target.binding_id !== bindingId) throw new CoreError("channel_content_scope_mismatch", "QQ来源目标与窗口配置不匹配");
    const adapterId = identifier(target.adapter_id, "adapter_id", 128);
    const adapter = this.#adapters.get(adapterId);
    const sourceConversationId = identifier(source.conversation_id, "source_conversation_id");
    if (!adapter || adapter.closed || !adapter.transport || (adapter.conversationId !== undefined && adapter.conversationId !== sourceConversationId)) {
      throw new CoreError("channel_content_unavailable", "当前QQ内容提供方不可用", { request_sent: false });
    }
    const window = { channel: "qq", window_type: input.window_type, window_id: windowId,
      window_key: identifier(source.window_key, "window_key"), channel_binding_id: bindingId };
    const component = identifier(source.component, "component", 64);
    const sourceIdentity = callerIdentity(Object.fromEntries(IDENTITY_FIELDS.map(field => [field, target[field]])));
    const scope = { caller_key: identityKey(caller), principal_id: principal.id ?? null, window, component,
      target_key: targetKey, source_conversation_id: sourceConversationId, transport: adapter.transport };
    scope.fingerprint = digest([scope.caller_key, scope.principal_id, window, component, sourceIdentity,
      requireInteger(target.binding_generation, "binding_generation", 1), adapterId, targetKey, sourceConversationId]);
    return scope;
  }

  #assertSameScope(principal, input, permission, scope) {
    const current = this.#scope(principal, input, permission);
    if (current.fingerprint !== scope.fingerprint || current.transport !== scope.transport) {
      throw new CoreError("channel_content_scope_changed", "QQ内容来源已变化，请核对原请求状态", { request_sent: true });
    }
  }

  #context(scope) {
    return { window: { ...scope.window }, observed_at: new Date(this.#now()).toISOString(),
      source: { kind: "external_channel_history", provider: "napcat", component: scope.component,
        target_key: scope.target_key, consumes_events: false } };
  }

  #prune() {
    const now = this.#now();
    for (const [reference, entry] of this.#references) {
      if ((this.#downloadLedger || entry.status === "idle") && entry.expires_at <= now) {
        this.#references.delete(reference);
        this.#referencesByContent.delete(entry.content_key);
      }
    }
    for (const [cursor, entry] of this.#cursors) if (entry.expires_at <= now) this.#cursors.delete(cursor);
  }

  #attachment(scope, originalMessageId, value, budget, attachmentIndex, staged) {
    const { attachment, metadata } = attachmentMetadata(value, budget);
    if (attachment.downloadable === false || attachment.attachment_ref === undefined || attachment.attachment_ref === null) {
      return { ...metadata, downloadable: false };
    }
    const providerReference = identifier(attachment.attachment_ref, "provider_attachment_ref", 4096);
    const stableId = attachment.fileId ? identifier(attachment.fileId, "fileId", 4096) : `attachment-position:${attachmentIndex}`;
    const contentKey = digest([scope.caller_key, scope.window.channel, scope.window.window_type, scope.window.window_id,
      originalMessageId, metadata.type ?? "file", stableId]);
    let entry = staged.get(contentKey) ?? this.#referencesByContent.get(contentKey);
    if (entry?.status === "idle" && (entry.scope.fingerprint !== scope.fingerprint || entry.scope.transport !== scope.transport)) {
      entry = null;
    }
    const retainedMetadata = Object.fromEntries(["fileId", "fileBytes", "sha256"]
      .filter(field => metadata[field] !== undefined && metadata[field] !== null && metadata[field] !== "").map(field => [field, metadata[field]]));
    if (!entry) {
      entry = { reference: `cc_attachment_${randomBytes(24).toString("base64url")}`, content_key: contentKey, scope,
        source_message_id: originalMessageId, provider_reference: providerReference, metadata: retainedMetadata, status: "idle",
        file_identity: stableId, file_type: metadata.type ?? "file",
        expires_at: this.#now() + REFERENCE_TTL_MS };
    } else if (entry.status === "idle") {
      entry = { ...entry, provider_reference: providerReference, expires_at: this.#now() + REFERENCE_TTL_MS, metadata: retainedMetadata };
    }
    if (entry.status === "idle") staged.set(contentKey, entry);
    return { ...metadata, downloadable: true, attachment_ref: entry.reference,
      attachment_ref_expires_at: new Date(entry.expires_at).toISOString(),
      download_status: this.#operations.get(this.#operationHeads.get(contentKey))?.status ?? entry.status };
  }

  #commitAttachments(staged) {
    const additions = [...staged.keys()].filter(contentKey => !this.#referencesByContent.has(contentKey)).length;
    if (this.#references.size + additions > MAX_REFERENCES) throw new CoreError("channel_content_capacity", "QQ附件引用已达到内存上限，请先核对原下载结果");
    for (const [contentKey, entry] of staged) {
      const previous = this.#referencesByContent.get(contentKey);
      if (previous && previous.reference !== entry.reference) this.#references.delete(previous.reference);
      this.#references.set(entry.reference, entry);
      this.#referencesByContent.set(contentKey, entry);
    }
  }

  async read(principal, value, { signal } = {}) {
    abortSignal(signal);
    const input = dataObject(value, "QQ内容读取", READ_FIELDS);
    const scope = this.#scope(principal, input, "allowed_channel_reads");
    const count = requireInteger(input.count === undefined ? 20 : input.count, "count", 1, 50);
    this.#prune();
    let providerCursor;
    if (input.cursor !== undefined) {
      const cursor = identifier(input.cursor, "cursor", 4096);
      const stored = this.#cursors.get(cursor);
      if (!stored || stored.fingerprint !== scope.fingerprint || stored.transport !== scope.transport) {
        throw new CoreError("invalid_cursor", "游标无效、已到期或属于其它调用者及窗口，请重读最近记录");
      }
      providerCursor = stored.provider_cursor;
    }
    if (typeof scope.transport.readConfiguredRecent !== "function") throw new CoreError("channel_content_unavailable", "QQ提供方尚未支持配置窗口最近内容读取", { request_sent: false });
    const combinedSignal = AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]);
    combinedSignal.throwIfAborted();
    const response = dataObject(await scope.transport.readConfiguredRecent({ target_key: scope.target_key, count,
      ...(providerCursor === undefined ? {} : { before_message_id: providerCursor }), include_owner_event_content: true }, { signal: combinedSignal }), "QQ最近内容响应");
    this.#assertSameScope(principal, input, "allowed_channel_reads", scope);
    combinedSignal.throwIfAborted();
    const target = assertTarget(response.target, scope);
    const rawMessages = dataArray(response.messages, "QQ最近消息", 50);
    if ((response.ok !== undefined && response.ok !== true) || response.requestedCount !== count
      || response.returnedCount !== rawMessages.length || rawMessages.length > count) {
      throw new CoreError("channel_content_invalid", "QQ最近消息数量或提供方状态无法核对");
    }
    const budget = dataBudget();
    const staged = new Map();
    const messages = rawMessages.map(rawMessage => {
      const message = dataObject(rawMessage, "QQ消息");
      const originalMessageId = messageId(message.messageId);
      if (typeof message.text !== "string") throw new CoreError("channel_content_invalid", "QQ消息缺少原正文");
      return { ...selectData(message, MESSAGE_FIELDS, budget), messageId: originalMessageId,
        attachments: dataArray(message.attachments ?? [], "QQ消息附件", 64).map((attachment, attachmentIndex) => this.#attachment(scope, originalMessageId, attachment, budget, attachmentIndex, staged)) };
    });
    const output = { ...this.#context(scope), target, ...(response.identity === undefined ? {} : { identity: copyData(response.identity, budget) }),
      requestedCount: count, returnedCount: messages.length, messages,
      pagination: { status: response.next_cursor === undefined || response.next_cursor === null ? "unknown" : "provider_cursor",
        verified: response.next_cursor !== undefined && response.next_cursor !== null,
        ...(response.next_cursor === undefined || response.next_cursor === null ? { reason: "provider_pagination_not_verified" } : {}) },
      attachment_reference_policy: { scope: "caller_and_window", memory_only: true, ttl_ms: REFERENCE_TTL_MS, attempted_downloads_retained_until_close: !this.#downloadLedger,
        download_operations_persistent: Boolean(this.#downloadLedger),
        recovery: "引用到期或服务重启后需重读最近记录；已有下载结果未知时先核对原请求，勿另行重发" } };
    let pendingCursor;
    if (response.next_cursor !== undefined && response.next_cursor !== null) {
      const nativeCursor = identifier(response.next_cursor, "provider_cursor", 4096);
      const cursor = `cc_cursor_${randomBytes(24).toString("base64url")}`;
      const expiresAt = this.#now() + REFERENCE_TTL_MS;
      pendingCursor = { cursor, value: { fingerprint: scope.fingerprint, transport: scope.transport, provider_cursor: nativeCursor, expires_at: expiresAt } };
      output.next_cursor = cursor;
      output.cursor_expires_at = new Date(expiresAt).toISOString();
    }
    if (this.#downloadLedger) {
      const entries = new Map([...this.#references.values(), ...staged.values()].map(entry => [entry.reference, entry]));
      const descriptions = new Map();
      let unavailable = false;
      for (const message of messages) {
        for (const attachment of message.attachments) {
          const entry = entries.get(attachment.attachment_ref);
          if (!entry) continue;
          try {
            if (unavailable) throw new CoreError("download_ledger_unavailable", "下载状态暂不可用");
            if (!descriptions.has(entry.content_key)) descriptions.set(entry.content_key, await this.#downloadLedger.read(entry.content_key));
            const record = descriptions.get(entry.content_key);
            if (!record) continue;
            if (digest(record.source) !== digest(this.#ledgerSource(entry))) throw new CoreError("channel_content_scope_changed", "原下载来源需要重新核对");
            const active = this.#operations.get(record.operation_id);
            const result = active?.result ?? record.result;
            attachment.download_status = active?.status ?? record.status;
            attachment.download_operation = copyData({ operation_id: record.operation_id, status: attachment.download_status,
              destination_dir: record.parameters.destination_dir, ...(record.parameters.name === undefined ? {} : { name: record.parameters.name }),
              ...(result?.cleanup_pending === true ? { cleanup_pending: true } : {}) }, budget);
          } catch (error) {
            if (error instanceof CoreError && error.code === "channel_content_invalid") throw error;
            unavailable = true;
            attachment.downloadable = false;
            attachment.download_status = "unavailable";
            attachment.download_state_error = "download_ledger_unavailable";
            delete attachment.attachment_ref;
            delete attachment.attachment_ref_expires_at;
            delete attachment.download_operation;
          }
        }
      }
      output.attachment_reference_policy.download_state_available = !unavailable;
      this.#assertSameScope(principal, input, "allowed_channel_reads", scope);
      combinedSignal.throwIfAborted();
    }
    this.#commitAttachments(staged);
    if (pendingCursor) {
      while (this.#cursors.size >= MAX_CURSORS) this.#cursors.delete(this.#cursors.keys().next().value);
      this.#cursors.set(pendingCursor.cursor, pendingCursor.value);
    }
    return output;
  }

  #downloadOutcome(entry, status = "unknown", providerCode) {
    return { ...this.#context(entry.scope), downloaded: false, status, attachment_ref: entry.reference,
      sourceMessageId: entry.source_message_id, operation_id: entry.operation_id,
      destination_dir: entry.parameters.destination_dir, ...(entry.parameters.name === undefined ? {} : { name: entry.parameters.name }),
      request_sent: status !== "failed_before_send", outcome_unknown: status === "unknown", retry_allowed: false,
      explicit_retry_allowed: ["failed", "failed_before_send"].includes(status), retry_requires_expected_operation_id: true,
      requires_original_result_check: status === "unknown", status_query_supported: Boolean(this.#downloadLedger), provider_status_query_supported: false,
      ...(providerCode ? { provider_code: providerCode } : {}),
      recovery: status === "unknown" ? "请按原消息、附件及目标目录核对提供方原请求；本模块不会换引用或自动重新下载"
        : "提供方已明确确认本次下载失败，保留原参数与结果，未自动重发" };
  }

  #ledgerSource(entry) {
    return { caller_key: entry.scope.caller_key, channel: entry.scope.window.channel, window_type: entry.scope.window.window_type,
      window_id: entry.scope.window.window_id, window_key: entry.scope.window.window_key, source_message_id: entry.source_message_id,
      file_type: entry.file_type, file_identity: entry.file_identity, scope_fingerprint: entry.scope.fingerprint, target_key: entry.scope.target_key };
  }

  #temporaryPath(value, entry, expectedName) {
    const path = directory(value);
    const name = basename(path);
    if (dirname(path) !== entry.parameters.destination_dir || !/\.part-[a-f0-9-]{36}$/.test(name)
      || (expectedName !== undefined && !name.startsWith(`${expectedName}.part-`))) {
      throw new CoreError("channel_content_invalid", "下载临时文件超出原目标目录");
    }
    return path;
  }

  #commitOutcome(entry, status, result) {
    const persist = async () => {
      if (["downloaded", "failed", "failed_before_send"].includes(entry.status)) return entry.result;
      entry.status = status;
      entry.result = result;
      if (this.#downloadLedger) {
        try {
          const recorded = await this.#downloadLedger.update(entry.operation_id, { status, result });
          entry.status = recorded.status;
          entry.result = recorded.result ?? result;
        } catch {
          entry.persistence_failed = true;
          entry.result = { ...entry.result, ledger_persisted: false, persistence_error: "download_ledger_write_failed", retry_allowed: false,
            explicit_retry_allowed: false,
            recovery: "下载持久记录写入失败，保留原操作和目录核对，禁止重新提交" };
        }
      }
      return entry.result;
    };
    const task = (entry.write_tail ?? Promise.resolve()).then(persist);
    entry.write_tail = task.catch(() => {});
    this.#writes.add(task);
    void task.then(() => this.#writes.delete(task), () => this.#writes.delete(task));
    return task;
  }

  async #performDownload(entry, signal) {
    let status;
    let outcome;
    let reportedCleanup = false;
    try {
      if (signal.aborted || this.#closed) throw new CoreError("request_aborted", "下载尚未提交", { request_sent: false });
      const result = dataObject(await entry.scope.transport.downloadConfiguredFile({ target_key: entry.scope.target_key,
        message_id: entry.source_message_id, attachment_ref: entry.provider_reference, ...entry.parameters }, { signal }), "QQ附件下载结果");
      reportedCleanup = result.cleanupPending === true;
      const target = assertTarget(result.target, entry.scope);
      if (result.downloaded !== true || messageId(result.sourceMessageId) !== entry.source_message_id
        || result.attachment_ref !== entry.provider_reference || !isAbsolute(result.filePath ?? "")
        || dirname(resolve(result.filePath)) !== entry.parameters.destination_dir || basename(result.filePath) !== result.fileName
        || (entry.parameters.name !== undefined && result.fileName !== entry.parameters.name)
        || (entry.metadata.fileId !== undefined && result.fileId !== undefined && result.fileId !== entry.metadata.fileId)
        || (Number.isSafeInteger(entry.metadata.fileBytes) && entry.metadata.fileBytes > 0 && result.fileBytes !== entry.metadata.fileBytes)
        || !Number.isSafeInteger(result.fileBytes) || result.fileBytes < 1 || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(result.sha256)
        || (entry.metadata.sha256 !== undefined && String(entry.metadata.sha256).toLowerCase() !== result.sha256.toLowerCase())) {
        throw new CoreError("channel_content_invalid", "QQ附件下载结果与原消息或目标路径不匹配");
      }
      fileName(result.fileName);
      if (result.fileId !== undefined) identifier(result.fileId, "fileId", 4096);
      if (result.resolvedFileId !== undefined) identifier(result.resolvedFileId, "resolvedFileId", 4096);
      if (result.resolvedBusId !== undefined && result.resolvedBusId !== null) requireInteger(result.resolvedBusId, "resolvedBusId");
      if (result.cleanupPending !== undefined && typeof result.cleanupPending !== "boolean") throw new CoreError("channel_content_invalid", "下载清理状态无效");
      const fields = ["fileId", "resolvedFileId", "resolvedBusId", "fileName", "filePath", "fileBytes", "sha256", "identity"];
      const selected = Object.fromEntries(fields.filter(field => result[field] !== undefined).map(field => [field, result[field]]));
      if (result.cleanupPending !== undefined) selected.cleanup_pending = result.cleanupPending;
      if (result.cleanupPending === true) selected.temporary_path = this.#temporaryPath(result.temporaryPath, entry, result.fileName);
      outcome = copyData({ ...this.#context(entry.scope), ...selected,
        downloaded: true, status: "downloaded", target, sourceMessageId: entry.source_message_id,
        attachment_ref: entry.reference, operation_id: entry.operation_id, destination_dir: entry.parameters.destination_dir },
      dataBudget({ maxBytes: 32 * 1024, maxNodes: 512, maxKeys: 128 }));
      status = "downloaded";
    } catch (error) {
      const details = error instanceof CoreError && error.details && typeof error.details === "object" ? error.details : {};
      status = details.request_sent === false ? "failed_before_send" : details.outcome_unknown === false ? "failed" : "unknown";
      const providerCode = status !== "unknown" && typeof details.provider_code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(details.provider_code)
        ? details.provider_code : undefined;
      outcome = this.#downloadOutcome(entry, status, providerCode);
      if (reportedCleanup) outcome.cleanup_pending = true;
      if (details.cleanup_pending === true) {
        outcome.cleanup_pending = true;
        outcome.explicit_retry_allowed = false;
        if (details.temporary_path !== undefined) {
          try { outcome.temporary_path = this.#temporaryPath(details.temporary_path, entry, entry.parameters.name); } catch {
            status = "unknown";
            outcome = { ...this.#downloadOutcome(entry), cleanup_pending: true };
          }
        }
      }
    }
    return this.#commitOutcome(entry, status, outcome);
  }

  async #waitForDownload(entry, signal) {
    if (signal.aborted) {
      return this.#commitOutcome(entry, "unknown", this.#downloadOutcome(entry));
    }
    return new Promise(resolveResult => {
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        void this.#commitOutcome(entry, "unknown", this.#downloadOutcome(entry)).then(resolveResult);
      };
      signal.addEventListener("abort", aborted, { once: true });
      void entry.promise.then(result => {
        signal.removeEventListener("abort", aborted);
        resolveResult(result);
      });
    });
  }

  #startOperation(entry, operationId, parameters, signal) {
    if (this.#operations.size >= MAX_REFERENCES) throw new CoreError("channel_content_capacity", "下载尝试数量已达上限，保留原记录");
    entry.parameters = parameters;
    entry.parameter_key = digest(parameters);
    entry.operation_id = operationId;
    entry.status = "pending";
    this.#operations.set(operationId, entry);
    this.#operationHeads.set(entry.content_key, operationId);
    entry.signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(MAX_DOWNLOAD_MS), ...(signal ? [signal] : [])]);
    entry.promise = this.#performDownload(entry, entry.signal);
    return entry;
  }

  #requestedParameters(entry, input, stored) {
    return { destination_dir: input.destination_dir === undefined ? stored?.destination_dir ?? join(this.#temporaryRoot, entry.content_key) : directory(input.destination_dir),
      ...(input.name === undefined ? (stored?.name === undefined ? {} : { name: stored.name }) : { name: fileName(input.name) }) };
  }

  #prepareMemory(entry, input, signal) {
    const current = this.#operations.get(this.#operationHeads.get(entry.content_key)) ?? entry;
    const parameters = this.#requestedParameters(entry, input, input.retry_failed === true ? current.parameters : undefined);
    if (input.retry_failed === true) {
      const child = this.#operations.get(this.#successors.get(input.expected_operation_id));
      if (child) {
        if (child.content_key !== entry.content_key || child.parameter_key !== digest(parameters)) throw new CoreError("operation_changed", "该重试已有其它参数的后继操作");
        return child;
      }
      if (current.operation_id !== input.expected_operation_id || !["failed", "failed_before_send"].includes(current.status)
        || current.result?.cleanup_pending === true || current.persistence_failed) throw new CoreError("retry_forbidden", "原操作未明确失败或清理尚未完成");
      const retry = { ...entry, status: "idle", result: undefined, write_tail: undefined, promise: undefined };
      const started = this.#startOperation(retry, randomUUID(), parameters, signal);
      this.#successors.set(current.operation_id, started.operation_id);
      return started;
    }
    if (current.parameter_key !== undefined && current.parameter_key !== digest(parameters)) throw new CoreError("download_parameters_changed", "该附件已有请求，请沿原参数核对结果");
    if (current.status !== "idle") return current;
    return this.#startOperation(current, randomUUID(), parameters, signal);
  }

  async #preparePersistent(entry, input, signal) {
    const stored = await this.#downloadLedger.read(entry.content_key);
    const parameters = this.#requestedParameters(entry, input, stored?.parameters);
    if (input.retry_failed !== true && stored && digest(parameters) !== digest(stored.parameters)) {
      throw new CoreError("download_parameters_changed", "该附件已有持久请求，请沿原目录和文件名核对");
    }
    if (this.#closed || signal?.aborted) throw new CoreError("request_aborted", "下载在持久提交前已取消", { request_sent: false });
    const prepared = await this.#downloadLedger.begin({ contentKey: entry.content_key, source: this.#ledgerSource(entry), parameters,
      retryFailed: input.retry_failed === true, ...(input.expected_operation_id === undefined ? {} : { expectedOperationId: input.expected_operation_id }) });
    const operation = prepared.operation;
    if (prepared.created) return this.#startOperation({ ...entry }, operation.operation_id, operation.parameters, signal);
    if (input.retry_failed !== true || operation.operation_id === stored?.operation_id) this.#operationHeads.set(entry.content_key, operation.operation_id);
    const active = this.#operations.get(operation.operation_id);
    if (active) return active;
    const restored = { ...entry, operation_id: operation.operation_id, parameters: operation.parameters, parameter_key: digest(operation.parameters), status: operation.status };
    restored.result = operation.result ?? this.#downloadOutcome(restored, operation.status);
    this.#operations.set(restored.operation_id, restored);
    if (!this.#operationHeads.has(entry.content_key)) this.#operationHeads.set(entry.content_key, restored.operation_id);
    return restored;
  }

  #prepareLocked(entry, input, signal) {
    const previous = this.#preparations.get(entry.content_key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.#preparePersistent(entry, input, signal));
    this.#preparations.set(entry.content_key, task);
    void task.then(() => { if (this.#preparations.get(entry.content_key) === task) this.#preparations.delete(entry.content_key); },
      () => { if (this.#preparations.get(entry.content_key) === task) this.#preparations.delete(entry.content_key); });
    return task;
  }

  async download(principal, value, { signal } = {}) {
    abortSignal(signal);
    const input = dataObject(value, "QQ附件下载", DOWNLOAD_FIELDS);
    if ((input.retry_failed !== undefined && typeof input.retry_failed !== "boolean")
      || (input.retry_failed === true ? typeof input.expected_operation_id !== "string" : input.expected_operation_id !== undefined)) {
      throw new CoreError("invalid_input", "显式重试需要准确的原失败operation_id");
    }
    if (input.expected_operation_id !== undefined) identifier(input.expected_operation_id, "expected_operation_id", 128);
    const scope = this.#scope(principal, input, "allowed_channel_downloads");
    const reference = identifier(input.attachment_ref, "attachment_ref", 512);
    this.#prune();
    const entry = this.#references.get(reference);
    if (!entry || entry.scope.caller_key !== scope.caller_key || entry.scope.window.window_key !== scope.window.window_key) {
      throw new CoreError("invalid_attachment_ref", "附件引用无效、已到期或属于其它调用者及窗口，请重读最近记录");
    }
    if (entry.scope.fingerprint !== scope.fingerprint || entry.scope.transport !== scope.transport) {
      throw new CoreError("channel_content_scope_changed", "附件来源已变化，请先核对原下载状态", { download_status: entry.status });
    }
    if (signal?.aborted) {
      if (entry.status !== "idle") return copyData(entry.result ?? this.#downloadOutcome(entry));
      throw new CoreError("request_aborted", "下载请求在提交前已取消", { request_sent: false });
    }
    if (typeof scope.transport.downloadConfiguredFile !== "function") throw new CoreError("channel_content_unavailable", "QQ提供方尚未支持配置窗口附件下载", { request_sent: false });
    const active = this.#downloadLedger ? await this.#prepareLocked(entry, input, signal) : this.#prepareMemory(entry, input, signal);
    const result = active.status === "pending"
      ? await this.#waitForDownload(active, signal ? AbortSignal.any([active.signal, signal]) : active.signal)
      : await (active.write_tail ?? Promise.resolve()).then(() => active.result);
    this.#assertSameScope(principal, input, "allowed_channel_downloads", scope);
    return copyData({ ...result, attachment_ref: reference });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return { closed: true, pending_downloads: [] };
    this.#closed = true;
    const pendingDownloads = [...this.#references.values()].filter(entry => ["pending", "unknown"].includes(entry.status))
      .map(entry => ({ operation_id: entry.operation_id, destination_dir: entry.parameters.destination_dir, sourceMessageId: entry.source_message_id, status: "unknown" }));
    this.#shutdown.abort();
    if (this.#downloadLedger) {
      this.#closePromise = (async () => {
        await Promise.allSettled([...this.#preparations.values()]);
        await Promise.all([...this.#operations.values()].filter(entry => ["pending", "unknown"].includes(entry.status))
          .map(entry => this.#commitOutcome(entry, "unknown", this.#downloadOutcome(entry))));
        await Promise.all([...this.#writes]);
        const closed = await this.#downloadLedger.close();
        this.#references.clear();
        this.#referencesByContent.clear();
        this.#cursors.clear();
        this.#operations.clear();
        this.#operationHeads.clear();
        this.#successors.clear();
        return { closed: true, pending_downloads: closed.pending_downloads.map(record => ({ operation_id: record.operation_id,
          destination_dir: record.parameters.destination_dir, sourceMessageId: record.source.source_message_id, status: "unknown" })) };
      })();
      return this.#closePromise;
    }
    this.#references.clear();
    this.#referencesByContent.clear();
    this.#cursors.clear();
    this.#operations.clear();
    this.#operationHeads.clear();
    this.#successors.clear();
    return { closed: true, pending_downloads: pendingDownloads };
  }
}
