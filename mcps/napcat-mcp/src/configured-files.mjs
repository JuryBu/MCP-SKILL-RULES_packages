import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const CONFIGURED_OPERATION_MAX_MS = 40000;

export function createConfiguredFileAccess(options) {
  const {
    loadBinding, checkConfiguredTarget, callOneBot, summarizeMessage,
    fetchImpl, maximumFileBytes, fileDownloadTimeoutMs, ErrorClass,
  } = options;
  const fail = (code, message, extra) => { throw new ErrorClass(code, message, extra); };
  const operationTimeoutMs = Math.min(CONFIGURED_OPERATION_MAX_MS,
    Number.isFinite(fileDownloadTimeoutMs) && fileDownloadTimeoutMs > 0 ? fileDownloadTimeoutMs : CONFIGURED_OPERATION_MAX_MS,
    Number.isFinite(options.operationTimeoutMs) && options.operationTimeoutMs > 0 ? options.operationTimeoutMs : CONFIGURED_OPERATION_MAX_MS);

  function createOperation(context = {}) {
    const controller = new AbortController();
    const deadline = performance.now() + operationTimeoutMs;
    const abort = (code) => {
      if (!controller.signal.aborted) controller.abort(new ErrorClass(code,
        code === "CONFIGURED_OPERATION_TIMEOUT" ? "本次操作超过内部总期限" : "本次操作已取消"));
    };
    const onCallerAbort = () => abort("CONFIGURED_OPERATION_CANCELLED");
    context.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (context.signal?.aborted) onCallerAbort();
    const timeout = setTimeout(() => abort("CONFIGURED_OPERATION_TIMEOUT"), operationTimeoutMs);
    function check() {
      if (performance.now() >= deadline) abort("CONFIGURED_OPERATION_TIMEOUT");
      if (controller.signal.aborted) throw controller.signal.reason;
    }
    function wait(start, lateResult) {
      check();
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => { settled = true; reject(controller.signal.reason); };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => { check(); return start(); }).then((value) => {
          controller.signal.removeEventListener("abort", onAbort);
          if (settled) { Promise.resolve().then(() => lateResult?.(value)).catch(() => {}); return; }
          try { check(); } catch (error) {
            settled = true;
            Promise.resolve().then(() => lateResult?.(value)).catch(() => {});
            reject(error);
            return;
          }
          settled = true;
          resolve(value);
        }, (error) => {
          controller.signal.removeEventListener("abort", onAbort);
          if (!settled) { settled = true; reject(controller.signal.aborted ? controller.signal.reason : error); }
        });
      });
    }
    return {
      signal: controller.signal,
      check,
      wait,
      dispose() { clearTimeout(timeout); context.signal?.removeEventListener("abort", onCallerAbort); },
    };
  }
  const pagination = {
    status: "unknown",
    beforeMessageIdSupported: false,
    nextBeforeMessageId: null,
    hasMore: null,
    reason: "before_message_id_cursor_not_verified",
  };

  function validateInput(input, allowed) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !allowed.includes(key))) {
      fail("INVALID_ARGUMENT", "参数只接受此工具声明的字段");
    }
    return requiredString(input.target_key, "target_key", 64);
  }

  function requiredString(value, name, maximum) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      fail("INVALID_ARGUMENT", `${name} 必须是长度有效的非空字符串`);
    }
    return value.trim();
  }

  function validFileName(value) {
    return value.length > 0 && value.length <= 255 && value === path.basename(value)
      && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value)
      && value !== "." && value !== ".."
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
  }

  function attachmentRef(target, messageId, attachment) {
    const identity = ["ncf1", target.targetKey, target.type, target.id,
      messageId, attachment.type, attachment.fileId];
    return `ncf1:${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
  }

  function authorizedBinding(targetKey) {
    const binding = loadBinding();
    if (typeof binding.expectedSelfId !== "string" || !binding.expectedSelfId.trim()) {
      fail("BINDING_INCOMPLETE", "新入口需要配置明确的 expectedSelfId");
    }
    if (!Object.hasOwn(binding.controlPlane.targets, targetKey)) {
      fail("CONTROL_TARGET_NOT_FOUND", "binding 未定义此目标");
    }
    return binding;
  }

  function fullText(message) {
    if (typeof message?.raw_message === "string" && message.raw_message) return message.raw_message;
    if (typeof message?.message === "string") return message.message;
    if (!Array.isArray(message?.message)) return "";
    return message.message.map((segment) => typeof segment === "string" ? segment
      : segment?.type === "text" ? String(segment.data?.text ?? "")
        : segment?.type ? `[${segment.type}]` : "[unknown]").join("");
  }

  function summarize(message, target, selfId, includeOwnerContent) {
    const result = summarizeMessage(message, selfId, includeOwnerContent);
    const attachments = Array.isArray(message?.message)
      ? summarizeMessage({ ...message, raw_message: "" }, selfId, false).attachments
      : result.attachments;
    return {
      ...result,
      text: fullText(message),
      sender: message?.sender ?? { user_id: result.senderId },
      attachments: attachments.map((attachment) => {
        const downloadable = attachment.type === "file" && Boolean(attachment.fileId) && Boolean(result.messageId);
        return {
          ...attachment,
          downloadable,
          ...(downloadable ? { attachment_ref: attachmentRef(target, result.messageId, attachment) } : {}),
        };
      }),
    };
  }

  async function history(target, count, operation) {
    const response = await operation.wait(() => callOneBot(target.type === "private"
      ? "get_friend_msg_history" : "get_group_msg_history", {
      ...(target.type === "private" ? { user_id: target.id } : { group_id: target.id }),
      count,
      reverse_order: false,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    }, undefined, { signal: operation.signal }));
    if (!Array.isArray(response?.messages)) fail("HISTORY_RESPONSE_INVALID", "历史接口未返回消息列表");
    return response.messages.slice(-count);
  }

  function verifyMessageScope(message, target, selfId, fromTargetHistory = false) {
    if (target.type === "group") {
      if (String(message?.group_id ?? "") !== target.id || message?.message_type !== "group") {
        fail("MESSAGE_TARGET_MISMATCH", "原消息与获准群聊不匹配");
      }
      return;
    }
    if (message?.message_type !== "private" || (message.group_id && String(message.group_id) !== "0")) {
      fail("MESSAGE_TARGET_MISMATCH", "原消息与获准私聊不匹配");
    }
    const senderId = String(message?.sender?.user_id ?? message?.user_id ?? "");
    if (senderId === target.id) return;
    if (senderId === selfId && fromTargetHistory) return;
    fail("MESSAGE_TARGET_UNVERIFIED", "私聊消息缺少可核对的对端身份");
  }

  async function readConfiguredRecentInternal(input, operation) {
    const targetKey = validateInput(input, ["target_key", "count", "before_message_id", "include_owner_event_content"]);
    const count = input.count === undefined ? 20 : input.count;
    if (!Number.isInteger(count) || count < 1 || count > 50) fail("INVALID_ARGUMENT", "count 必须是 1 到 50 的整数");
    if (input.include_owner_event_content !== undefined && typeof input.include_owner_event_content !== "boolean") {
      fail("INVALID_ARGUMENT", "include_owner_event_content 必须是布尔值");
    }
    if (input.before_message_id !== undefined) {
      requiredString(input.before_message_id, "before_message_id", 128);
      fail("HISTORY_CURSOR_UNVERIFIED", "当前入口尚未验证 before_message_id 游标，请省略该参数读取近期消息", {
        details: { pagination },
      });
    }
    const binding = authorizedBinding(targetKey);
    const checked = await operation.wait(() => checkConfiguredTarget(binding, targetKey, {
      signal: operation.signal, strictGroupIdentity: true,
    }));
    const rawMessages = await history(checked.target, count, operation);
    for (const message of rawMessages) verifyMessageScope(message, checked.target, binding.expectedSelfId, true);
    const messages = rawMessages.map((message) => summarize(message, checked.target,
      binding.expectedSelfId, input.include_owner_event_content !== false));
    operation.check();
    return {
      target: checked.target,
      identity: checked.login,
      requestedCount: count,
      returnedCount: messages.length,
      messages,
      pagination: { ...pagination },
    };
  }

  async function downloadConfiguredFileInternal(input, operation) {
    const targetKey = validateInput(input, ["target_key", "message_id", "attachment_ref", "destination_dir", "name"]);
    const messageId = requiredString(input.message_id, "message_id", 128);
    const reference = requiredString(input.attachment_ref, "attachment_ref", 80);
    if (!/^ncf1:[a-f0-9]{64}$/.test(reference)) fail("INVALID_ATTACHMENT_REF", "attachment_ref 格式无效");
    const destinationDirectory = requiredString(input.destination_dir, "destination_dir", 4096);
    if (!path.isAbsolute(destinationDirectory)) fail("DOWNLOAD_DIRECTORY_NOT_ABSOLUTE", "destination_dir 必须是本机绝对路径");
    if (input.name !== undefined && (typeof input.name !== "string" || !validFileName(input.name))) {
      fail("INVALID_FILE_NAME", "name 必须是有效的单个文件名");
    }
    const binding = authorizedBinding(targetKey);
    const checked = await operation.wait(() => checkConfiguredTarget(binding, targetKey, {
      signal: operation.signal, strictGroupIdentity: true,
    }));
    const message = await operation.wait(() => callOneBot("get_msg", { message_id: messageId }, undefined, { signal: operation.signal }));
    if (String(message?.message_id ?? "") !== messageId) fail("MESSAGE_ID_MISMATCH", "接口返回的原消息编号不匹配");
    const senderId = String(message?.sender?.user_id ?? message?.user_id ?? "");
    let fromTargetHistory = false;
    if (checked.target.type === "private" && senderId === binding.expectedSelfId) {
      const recent = await history(checked.target, 50, operation);
      fromTargetHistory = recent.some((item) => String(item?.message_id ?? "") === messageId);
    }
    verifyMessageScope(message, checked.target, binding.expectedSelfId, fromTargetHistory);
    const source = summarize(message, checked.target, binding.expectedSelfId, false);
    const attachment = source.attachments.find((item) => item.attachment_ref === reference && item.downloadable);
    if (!attachment) fail("ATTACHMENT_REF_MISMATCH", "附件引用与原消息的可下载附件不匹配");
    if (attachment.fileBytes > maximumFileBytes) fail("FILE_TOO_LARGE", "附件大小超过下载上限");
    const urlData = await operation.wait(() => callOneBot(checked.target.type === "private" ? "get_private_file_url" : "get_group_file_url", {
      ...(checked.target.type === "group" ? { group_id: checked.target.id } : {}),
      file_id: attachment.fileId,
      ...(checked.target.type === "group" && attachment.busId !== null ? { busid: attachment.busId } : {}),
    }, undefined, { signal: operation.signal }));
    let downloadUrl;
    try { downloadUrl = new URL(String(urlData?.url ?? "")); } catch { fail("FILE_URL_INVALID", "文件接口未返回有效下载地址"); }
    if (!["http:", "https:"].includes(downloadUrl.protocol) || downloadUrl.username || downloadUrl.password) {
      fail("FILE_URL_INVALID", "文件接口返回的下载地址无效");
    }
    const fallbackName = `napcat-file-${reference.slice(5, 17)}`;
    const fileName = input.name ?? (validFileName(attachment.fileName) ? attachment.fileName : fallbackName);
    const destinationPath = path.join(path.resolve(destinationDirectory), fileName);
    const temporaryPath = `${destinationPath}.part-${randomUUID()}`;
    let response;
    let fileDescriptor = null;
    let temporaryCreated = false;
    let published = false;
    let publicationPending = false;
    let publication = null;
    let cleanupPending = false;
    let failure = null;
    let fileBytes = 0;
    const digest = createHash("sha256");
    let sha256 = null;
    const resultFields = () => ({
      target: checked.target,
      identity: checked.login,
      messageId,
      sourceMessageId: messageId,
      messageSeq: source.messageSeq,
      attachment_ref: reference,
      resolvedBusId: checked.target.type === "group" ? attachment.busId : null,
      fileName,
      filePath: destinationPath,
      fileBytes,
      sha256,
    });
    const removeTemporary = () => {
      try { fs.unlinkSync(temporaryPath); } catch (error) { cleanupPending = error?.code !== "ENOENT"; }
    };
    try {
      operation.check();
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      operation.check();
      fileDescriptor = fs.openSync(temporaryPath, "wx");
      temporaryCreated = true;
      operation.check();
      response = await operation.wait(() => fetchImpl(downloadUrl.href, { signal: operation.signal }),
        (lateResponse) => lateResponse?.body?.cancel());
      if (!response.ok) fail("FILE_DOWNLOAD_HTTP_ERROR", "文件下载服务暂未返回文件");
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maximumFileBytes) fail("FILE_TOO_LARGE", "下载文件超过大小上限");
      if (!response.body) fail("FILE_DOWNLOAD_EMPTY_BODY", "文件下载响应没有正文");
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          fileBytes += chunk.length;
          if (fileBytes > maximumFileBytes) {
            callback(new ErrorClass("FILE_TOO_LARGE", "下载文件超过大小上限"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      operation.check();
      const output = fs.createWriteStream(temporaryPath, { fd: fileDescriptor, autoClose: true });
      fileDescriptor = null;
      await pipeline(Readable.fromWeb(response.body), meter, output, { signal: operation.signal });
      if (!fileBytes) fail("FILE_EMPTY", "下载结果为空");
      if (attachment.fileBytes !== null && fileBytes !== attachment.fileBytes) fail("FILE_SIZE_MISMATCH", "下载字节数与原附件大小不一致");
      sha256 = digest.digest("hex");
      operation.check();
      publication = fs.promises.link(temporaryPath, destinationPath);
      publicationPending = true;
      publication = publication.then(() => { published = true; publicationPending = false; },
        (error) => { publicationPending = false; throw error; });
      await operation.wait(() => publication);
    } catch (error) {
      failure = published ? null
        : publicationPending ? new ErrorClass("FILE_PUBLICATION_UNKNOWN", "文件发布已开始，最终结果待核对", {
          outcomeUnknown: true,
          details: { operationResult: resultFields(), published: null, publicationState: "pending" },
        })
          : operation.signal.aborted ? operation.signal.reason
            : error instanceof ErrorClass ? error
        : error?.code === "EEXIST" ? new ErrorClass("DOWNLOAD_TARGET_EXISTS", "目标文件已存在，拒绝覆盖")
          : new ErrorClass("FILE_DOWNLOAD_FAILED", "文件下载未完成", { cause: error });
    } finally {
      if (fileDescriptor !== null) { try { fs.closeSync(fileDescriptor); } catch {} }
      if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
      if (temporaryCreated) {
        if (publicationPending) {
          cleanupPending = true;
          publication.then(removeTemporary, removeTemporary);
        } else removeTemporary();
      }
    }
    if (failure) {
      failure.details = {
        ...failure.details,
        operationResult: resultFields(),
        published: publicationPending ? null : false,
        publicationState: publicationPending ? "pending" : "not_published",
        ...(cleanupPending ? { cleanupPending: true, temporaryPath } : {}),
      };
      throw failure;
    }
    return {
      downloaded: true,
      ...resultFields(),
      published: true,
      outcomeUnknown: false,
      ...(operation.signal.aborted ? { cancelledAfterPublication: true } : {}),
      cleanupPending,
      ...(cleanupPending ? { temporaryPath } : {}),
      retryRecommended: false,
    };
  }

  async function readConfiguredRecent(input = {}, context = {}) {
    const operation = createOperation(context);
    try { operation.check(); return await readConfiguredRecentInternal(input, operation); }
    finally { operation.dispose(); }
  }

  async function downloadConfiguredFile(input = {}, context = {}) {
    const operation = createOperation(context);
    try { operation.check(); return await downloadConfiguredFileInternal(input, operation); }
    finally { operation.dispose(); }
  }

  return { readConfiguredRecent, downloadConfiguredFile };
}
