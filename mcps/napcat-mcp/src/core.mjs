import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_ALLOWED_EVENTS = [
  "started",
  "heartbeat",
  "paused",
  "resumed",
  "stopped",
  "recovery",
  "completed",
  "test",
];
const STALE_LOCK_MINUTES = 15;

export class NapCatNotifierError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "NapCatNotifierError";
    this.code = code;
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.details = options.details ?? null;
  }
}

function expandEnvironmentVariables(value, env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
}

function resolveConfiguredPath(value, fallback, cwd, env) {
  const expanded = expandEnvironmentVariables(value || fallback, env);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function readJsonFile(filePath, missingCode) {
  if (!fs.existsSync(filePath)) {
    throw new NapCatNotifierError(missingCode, `配置文件不存在：${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new NapCatNotifierError("INVALID_JSON", `无法解析 JSON：${filePath}`, { cause: error });
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function boundedString(value, name, maximum, required = false) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  if (required && !normalized) {
    throw new NapCatNotifierError("INVALID_ARGUMENT", `${name} 不能为空`);
  }
  if (normalized.length > maximum) {
    throw new NapCatNotifierError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeBinding(raw) {
  if (raw.requireGroupIdentityCheckBeforeSend === false) {
    throw new NapCatNotifierError(
      "UNSAFE_BINDING",
      "固定绑定群的身份校验不能关闭",
    );
  }
  const allowedEvents = Array.isArray(raw.allowedEvents) && raw.allowedEvents.length
    ? raw.allowedEvents.map((event) => String(event))
    : DEFAULT_ALLOWED_EVENTS;
  const binding = {
    schemaVersion: Number(raw.schemaVersion ?? 1),
    bindingName: boundedString(raw.bindingName ?? "example-group-notify", "bindingName", 128, true),
    expectedSelfId: boundedString(raw.expectedSelfId, "expectedSelfId", 64),
    expectedNickname: boundedString(raw.expectedNickname, "expectedNickname", 128),
    groupId: boundedString(raw.groupId, "groupId", 64),
    groupName: boundedString(raw.groupName ?? "ExampleGroup", "groupName", 128, true),
    expectedMemberCount: positiveInteger(raw.expectedMemberCount, 4, 1, 1000000),
    allowedEvents,
    minimumHeartbeatMinutes: positiveInteger(raw.minimumHeartbeatMinutes, 5, 1, 1440),
    dedupeRetentionDays: positiveInteger(raw.dedupeRetentionDays, 30, 1, 3650),
    requireGroupIdentityCheckBeforeSend: true,
    requireMessageVerification: raw.requireMessageVerification !== false,
  };
  if (binding.schemaVersion !== 1) {
    throw new NapCatNotifierError("UNSUPPORTED_BINDING", `不支持 binding schemaVersion=${binding.schemaVersion}`);
  }
  return binding;
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, entries: {} };
  }
  const state = readJsonFile(filePath, "STATE_MISSING");
  if (state.schemaVersion !== 1 || !state.entries || typeof state.entries !== "object") {
    throw new NapCatNotifierError("INVALID_STATE", `去重状态格式无效：${filePath}`);
  }
  return state;
}

function pruneState(state, retentionDays, nowDate) {
  const oldest = nowDate.getTime() - retentionDays * 86400000;
  for (const [key, entry] of Object.entries(state.entries)) {
    const timestamp = Date.parse(entry.updatedAt || entry.createdAt || "");
    if (Number.isFinite(timestamp) && timestamp < oldest) {
      delete state.entries[key];
    }
  }
}

function dedupeLockPath(statePath, dedupeKey) {
  const digest = createHash("sha256").update(dedupeKey, "utf8").digest("hex");
  return path.join(path.dirname(statePath), ".locks", `${digest}.lock`);
}

function acquireDedupeLock(statePath, dedupeKey, nowDate) {
  const lockPath = dedupeLockPath(statePath, dedupeKey);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, dedupeKey, createdAt: nowDate.toISOString() })}\n`, "utf8");
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === "EEXIST") {
      let metadata = null;
      try {
        metadata = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        metadata = null;
      }
      let createdAtMs = Date.parse(metadata?.createdAt || "");
      if (!Number.isFinite(createdAtMs)) {
        try {
          createdAtMs = fs.statSync(lockPath).mtimeMs;
        } catch {
          createdAtMs = nowDate.getTime();
        }
      }
      const ageMinutes = Math.max(0, (nowDate.getTime() - createdAtMs) / 60000);
      return {
        release: null,
        existingLock: {
          lockPath,
          pid: metadata?.pid ?? null,
          createdAt: metadata?.createdAt ?? new Date(createdAtMs).toISOString(),
          ageMinutes,
          stale: ageMinutes >= STALE_LOCK_MINUTES,
        },
      };
    }
    throw error;
  }
  return {
    existingLock: null,
    release: () => {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd();
}

function oneBotMessageText(message) {
  if (typeof message?.raw_message === "string") {
    return message.raw_message;
  }
  if (typeof message?.message === "string") {
    return message.message;
  }
  if (Array.isArray(message?.message)) {
    return message.message.map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment?.type === "text") return String(segment?.data?.text ?? "");
      return "";
    }).join("");
  }
  return "";
}

function oneBotReadableText(message) {
  if (typeof message?.raw_message === "string" && message.raw_message) {
    return message.raw_message.slice(0, 2000);
  }
  if (typeof message?.message === "string") {
    return message.message.slice(0, 2000);
  }
  if (Array.isArray(message?.message)) {
    return message.message.map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment?.type === "text") return String(segment?.data?.text ?? "");
      return segment?.type ? `[${segment.type}]` : "[unknown]";
    }).join("").slice(0, 2000);
  }
  return "";
}

function decodeCqValue(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function summarizeFileAttachment(data = {}) {
  const fileId = String(data.file_id ?? data.fileId ?? "");
  const fileName = decodeCqValue(data.file_name ?? data.name ?? data.file ?? "");
  const rawSize = Number(data.file_size ?? data.size ?? 0);
  return {
    type: "file",
    fileId,
    fileName,
    fileBytes: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null,
    downloadable: Boolean(fileId),
  };
}

function oneBotFileAttachments(message) {
  const attachments = [];
  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (segment?.type === "file") attachments.push(summarizeFileAttachment(segment.data));
    }
  }
  const rawMessage = typeof message?.raw_message === "string" ? message.raw_message : "";
  for (const match of rawMessage.matchAll(/\[CQ:file,([^\]]+)\]/g)) {
    const attributes = {};
    for (const part of match[1].split(",")) {
      const separator = part.indexOf("=");
      if (separator > 0) attributes[part.slice(0, separator)] = part.slice(separator + 1);
    }
    attachments.push(summarizeFileAttachment(attributes));
  }
  const unique = new Map();
  for (const attachment of attachments) {
    const key = `${attachment.fileId}\n${attachment.fileName}\n${attachment.fileBytes ?? ""}`;
    if (!unique.has(key)) unique.set(key, attachment);
  }
  return [...unique.values()];
}

function structuredTaskId(text) {
  for (const line of normalizeComparableText(text).split("\n")) {
    const match = line.match(/^(?:任务|task_id)\s*[：:]\s*(.+)$/i);
    if (match) return match[1].trim().slice(0, 128);
  }
  return "";
}

function summarizeGroupMessage(message, expectedSelfId) {
  const timestamp = Number(message?.time ?? 0);
  const text = oneBotReadableText(message);
  return {
    messageId: String(message?.message_id ?? ""),
    messageSeq: String(message?.message_seq ?? message?.message_id ?? ""),
    time: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    senderId: String(message?.sender?.user_id ?? message?.user_id ?? ""),
    senderName: String(message?.sender?.card ?? message?.sender?.nickname ?? ""),
    isSelf: String(message?.sender?.user_id ?? message?.user_id ?? "") === expectedSelfId,
    text,
    taskId: structuredTaskId(text),
    attachments: oneBotFileAttachments(message),
  };
}

function publicError(error) {
  return {
    code: error instanceof NapCatNotifierError ? error.code : "UNEXPECTED_ERROR",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

function formatProgress(input) {
  const parts = [];
  const progress = boundedString(input.progress, "progress", 240);
  const checkpointAt = boundedString(input.checkpoint_at, "checkpoint_at", 80);
  const nextCheckAt = boundedString(input.next_check_at, "next_check_at", 80);
  if (progress) parts.push(`进度：${progress}`);
  if (checkpointAt) parts.push(`最近存档：${checkpointAt}`);
  if (nextCheckAt) parts.push(`下次检查：${nextCheckAt}`);
  return parts;
}

function normalizeEventInput(input, binding) {
  const event = boundedString(input.event, "event", 32, true).toLowerCase();
  if (!binding.allowedEvents.includes(event)) {
    throw new NapCatNotifierError("EVENT_NOT_ALLOWED", `binding 不允许事件：${event}`);
  }
  return {
    event,
    taskId: boundedString(input.task_id, "task_id", 128, true),
    runId: boundedString(input.run_id, "run_id", 128),
    dedupeKey: boundedString(input.dedupe_key, "dedupe_key", 200, true),
    summary: boundedString(input.summary, "summary", 500),
    progress: boundedString(input.progress, "progress", 240),
    checkpointAt: boundedString(input.checkpoint_at, "checkpoint_at", 80),
    nextCheckAt: boundedString(input.next_check_at, "next_check_at", 80),
  };
}

function buildTrainingMessage(normalizedInput, nowDate) {
  const lines = [
    `[训练机][${normalizedInput.event.toUpperCase()}]`,
    `任务：${normalizedInput.taskId}`,
  ];
  if (normalizedInput.runId) lines.push(`运行：${normalizedInput.runId}`);
  lines.push(...formatProgress({
    progress: normalizedInput.progress,
    checkpoint_at: normalizedInput.checkpointAt,
    next_check_at: normalizedInput.nextCheckAt,
  }));
  if (normalizedInput.summary) lines.push(`摘要：${normalizedInput.summary}`);
  lines.push(`时间：${nowDate.toISOString()}`);
  return lines.join("\n");
}

function normalizeTextInput(input) {
  const taskId = boundedString(input.task_id, "task_id", 128);
  return {
    event: "message",
    taskId: taskId || "fixed-group-text",
    runId: "",
    dedupeKey: boundedString(input.dedupe_key, "dedupe_key", 200, true),
    text: boundedString(input.text, "text", 1000, true),
    sourceMachine: boundedString(input.source_machine, "source_machine", 64),
    targetMachine: boundedString(input.target_machine, "target_machine", 64),
  };
}

function buildTextMessage(normalizedInput, nowDate) {
  if (normalizedInput.taskId !== "fixed-group-text") {
    const lines = ["[Codex][TASK_MESSAGE]", `任务：${normalizedInput.taskId}`];
    if (normalizedInput.sourceMachine) lines.push(`来源机器：${normalizedInput.sourceMachine}`);
    if (normalizedInput.targetMachine) lines.push(`目标机器：${normalizedInput.targetMachine}`);
    lines.push(`正文：${normalizedInput.text}`, `时间：${nowDate.toISOString()}`);
    return lines.join("\n");
  }
  return [
    "[Codex][MESSAGE]",
    normalizedInput.text,
    `时间：${nowDate.toISOString()}`,
  ].join("\n");
}

function normalizeFileInput(input, maximumFileBytes) {
  const requestedPath = boundedString(input.file_path, "file_path", 4096, true);
  if (!path.isAbsolute(requestedPath)) {
    throw new NapCatNotifierError("FILE_PATH_NOT_ABSOLUTE", "file_path 必须是本机绝对路径");
  }
  let filePath;
  let fileStat;
  try {
    filePath = fs.realpathSync(requestedPath);
    fileStat = fs.statSync(filePath);
  } catch (error) {
    throw new NapCatNotifierError("FILE_NOT_FOUND", `无法读取待发送文件：${requestedPath}`, { cause: error });
  }
  if (!fileStat.isFile()) {
    throw new NapCatNotifierError("FILE_NOT_REGULAR", "file_path 必须指向普通文件");
  }
  if (fileStat.size <= 0) {
    throw new NapCatNotifierError("FILE_EMPTY", "拒绝发送空文件");
  }
  if (fileStat.size > maximumFileBytes) {
    throw new NapCatNotifierError("FILE_TOO_LARGE", `文件超过 ${maximumFileBytes} 字节上限`);
  }
  const requestedName = boundedString(input.name || path.basename(filePath), "name", 255, true);
  if (requestedName !== path.basename(requestedName) || requestedName === "." || requestedName === "..") {
    throw new NapCatNotifierError("INVALID_FILE_NAME", "name 只能是文件名，不能包含目录");
  }
  return {
    event: "file",
    taskId: "fixed-group-file",
    runId: "",
    dedupeKey: boundedString(input.dedupe_key, "dedupe_key", 200, true),
    filePath,
    fileName: requestedName,
    fileBytes: fileStat.size,
  };
}

function normalizeDownloadInput(input) {
  const fileId = boundedString(input.file_id, "file_id", 2048, true);
  const destinationDirectory = boundedString(input.destination_dir, "destination_dir", 4096, true);
  if (!path.isAbsolute(destinationDirectory)) {
    throw new NapCatNotifierError("DOWNLOAD_DIRECTORY_NOT_ABSOLUTE", "destination_dir 必须是本机绝对路径");
  }
  const requestedName = boundedString(input.name, "name", 255);
  if (requestedName && (requestedName !== path.basename(requestedName) || requestedName === "." || requestedName === "..")) {
    throw new NapCatNotifierError("INVALID_FILE_NAME", "name 只能是文件名，不能包含目录");
  }
  return { fileId, destinationDirectory: path.resolve(destinationDirectory), requestedName };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

export function createNapCatNotifier(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const bindingPath = resolveConfiguredPath(
    env.NAPCAT_MCP_BINDING_PATH,
    "binding.json",
    cwd,
    env,
  );
  const statePath = resolveConfiguredPath(
    env.NAPCAT_MCP_STATE_PATH,
    path.join("state", "dedupe.json"),
    cwd,
    env,
  );
  const baseUrl = String(env.NAPCAT_HTTP_URL || "http://127.0.0.1:3010").replace(/\/+$/, "");
  const accessToken = String(env.NAPCAT_ACCESS_TOKEN || "");
  const allowEmptyToken = env.NAPCAT_ALLOW_EMPTY_TOKEN === "1";
  const timeoutMs = positiveInteger(env.NAPCAT_HTTP_TIMEOUT_MS, 10000, 1000, 120000);
  const fileUploadTimeoutMs = positiveInteger(env.NAPCAT_FILE_UPLOAD_TIMEOUT_MS, 600000, 10000, 1800000);
  const fileDownloadTimeoutMs = positiveInteger(env.NAPCAT_FILE_DOWNLOAD_TIMEOUT_MS, 600000, 10000, 1800000);
  const maximumFileBytes = positiveInteger(env.NAPCAT_MAX_FILE_BYTES, 2147483648, 1, 10737418240);
  const inFlight = new Set();

  if (typeof fetchImpl !== "function") {
    throw new NapCatNotifierError("FETCH_UNAVAILABLE", "当前 Node 运行时没有 fetch 支持");
  }

  function loadBinding() {
    return normalizeBinding(readJsonFile(bindingPath, "BINDING_MISSING"));
  }

  function requireConnectionConfiguration() {
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(baseUrl) && !/^https?:\/\/localhost(?::\d+)?$/i.test(baseUrl)) {
      throw new NapCatNotifierError("NON_LOOPBACK_URL", "NAPCAT_HTTP_URL 必须是本机回环地址");
    }
    if (!accessToken && !allowEmptyToken) {
      throw new NapCatNotifierError("TOKEN_MISSING", "未配置 NAPCAT_ACCESS_TOKEN");
    }
  }

  async function callOneBot(action, params = {}, requestTimeoutMs = timeoutMs) {
    requireConnectionConfiguration();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new NapCatNotifierError(
        aborted ? "ONEBOT_TIMEOUT" : "ONEBOT_NETWORK_ERROR",
        aborted ? `OneBot 请求 ${action} 超时` : `OneBot 请求 ${action} 失败`,
        { cause: error, outcomeUnknown: true },
      );
    } finally {
      clearTimeout(timeout);
    }

    let envelope;
    const responseText = await response.text();
    try {
      envelope = JSON.parse(responseText);
    } catch (error) {
      throw new NapCatNotifierError("ONEBOT_INVALID_JSON", `OneBot ${action} 返回了无效 JSON`, {
        cause: error,
        outcomeUnknown: response.ok,
      });
    }
    if (!response.ok) {
      throw new NapCatNotifierError("ONEBOT_HTTP_ERROR", `OneBot ${action} 返回 HTTP ${response.status}`, {
        outcomeUnknown: action === "send_group_msg" || action === "upload_group_file",
        details: { status: response.status, retcode: envelope?.retcode ?? null },
      });
    }
    if (envelope?.status !== "ok" || Number(envelope?.retcode ?? 0) !== 0) {
      throw new NapCatNotifierError("ONEBOT_ACTION_FAILED", `OneBot ${action} 执行失败`, {
        outcomeUnknown: action === "send_group_msg" || action === "upload_group_file",
        details: { retcode: envelope?.retcode ?? null, wording: envelope?.wording ?? "" },
      });
    }
    return envelope.data ?? null;
  }

  function verifyLogin(binding, loginInfo) {
    const actualSelfId = String(loginInfo?.user_id ?? loginInfo?.self_id ?? "");
    const actualNickname = String(loginInfo?.nickname ?? "");
    if (binding.expectedSelfId && actualSelfId !== binding.expectedSelfId) {
      throw new NapCatNotifierError("SELF_ID_MISMATCH", "当前 NapCat 登录账号与 binding 不一致", {
        details: { expectedSelfId: binding.expectedSelfId, actualSelfId },
      });
    }
    if (binding.expectedNickname && actualNickname && actualNickname !== binding.expectedNickname) {
      throw new NapCatNotifierError("NICKNAME_MISMATCH", "当前 NapCat 昵称与 binding 不一致", {
        details: { expectedNickname: binding.expectedNickname, actualNickname },
      });
    }
    return { actualSelfId, actualNickname };
  }

  function verifyGroup(binding, groupInfo) {
    const actualGroupId = String(groupInfo?.group_id ?? "");
    const actualGroupName = String(groupInfo?.group_name ?? "");
    const actualMemberCount = Number(groupInfo?.member_count ?? 0);
    if (actualGroupId !== binding.groupId) {
      throw new NapCatNotifierError("GROUP_ID_MISMATCH", "OneBot 返回的群号与 binding 不一致");
    }
    if (actualGroupName !== binding.groupName) {
      throw new NapCatNotifierError("GROUP_NAME_MISMATCH", "目标群名与 binding 不一致", {
        details: { expected: binding.groupName, actual: actualGroupName },
      });
    }
    if (actualMemberCount !== binding.expectedMemberCount) {
      throw new NapCatNotifierError("GROUP_MEMBER_COUNT_MISMATCH", "目标群成员数与 binding 不一致", {
        details: { expected: binding.expectedMemberCount, actual: actualMemberCount },
      });
    }
    return { actualGroupId, actualGroupName, actualMemberCount };
  }

  async function checkTarget(binding) {
    if (!binding.expectedSelfId || !binding.groupId) {
      throw new NapCatNotifierError("BINDING_INCOMPLETE", "binding.json 尚未填写 expectedSelfId 和 groupId");
    }
    const runtimeStatus = await callOneBot("get_status");
    if (runtimeStatus?.online === false || runtimeStatus?.good === false) {
      throw new NapCatNotifierError("NAPCAT_NOT_READY", "NapCat 当前不在线或状态异常");
    }
    const login = verifyLogin(binding, await callOneBot("get_login_info"));
    const group = binding.requireGroupIdentityCheckBeforeSend
      ? verifyGroup(binding, await callOneBot("get_group_info", { group_id: binding.groupId, no_cache: true }))
      : { actualGroupId: binding.groupId, actualGroupName: binding.groupName, actualMemberCount: null };
    return { runtimeStatus, login, group };
  }

  async function status(optionsInput = {}) {
    let binding;
    try {
      binding = loadBinding();
      requireConnectionConfiguration();
    } catch (error) {
      return {
        ready: false,
        reachable: false,
        bindingPath,
        statePath,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        error: publicError(error),
      };
    }
    try {
      const runtimeStatus = await callOneBot("get_status");
      const loginInfo = await callOneBot("get_login_info");
      let identity = null;
      let identityError = null;
      try {
        identity = verifyLogin(binding, loginInfo);
      } catch (error) {
        identityError = publicError(error);
      }
      let group = null;
      let groupError = null;
      if (optionsInput.include_group !== false && binding.groupId) {
        try {
          group = verifyGroup(binding, await callOneBot("get_group_info", {
            group_id: binding.groupId,
            no_cache: true,
          }));
        } catch (error) {
          groupError = publicError(error);
        }
      }
      return {
        ready: Boolean(identity && (!binding.groupId || group) && runtimeStatus?.online !== false && runtimeStatus?.good !== false),
        reachable: true,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        binding: {
          bindingName: binding.bindingName,
          expectedSelfId: binding.expectedSelfId,
          expectedNickname: binding.expectedNickname,
          groupId: binding.groupId,
          groupName: binding.groupName,
          expectedMemberCount: binding.expectedMemberCount,
        },
        runtimeStatus,
        identity,
        identityError,
        group,
        groupError,
      };
    } catch (error) {
      return {
        ready: false,
        reachable: false,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        binding: {
          bindingName: binding.bindingName,
          expectedSelfId: binding.expectedSelfId,
          groupId: binding.groupId,
          groupName: binding.groupName,
        },
        error: publicError(error),
      };
    }
  }

  async function discoverTarget() {
    const binding = loadBinding();
    const loginInfo = await callOneBot("get_login_info");
    const identity = verifyLogin(binding, loginInfo);
    const groups = await callOneBot("get_group_list", { no_cache: true });
    const candidates = (Array.isArray(groups) ? groups : [])
      .filter((group) => String(group.group_name ?? "") === binding.groupName)
      .filter((group) => Number(group.member_count ?? 0) === binding.expectedMemberCount)
      .map((group) => ({
        groupId: String(group.group_id ?? ""),
        groupName: String(group.group_name ?? ""),
        memberCount: Number(group.member_count ?? 0),
      }));
    return {
      bindingName: binding.bindingName,
      identity,
      expectedGroupName: binding.groupName,
      expectedMemberCount: binding.expectedMemberCount,
      candidates,
      uniqueMatch: candidates.length === 1 ? candidates[0] : null,
    };
  }

  async function readRecentMessages(input = {}) {
    const binding = loadBinding();
    const targetCheck = await checkTarget(binding);
    const count = positiveInteger(input.count, 20, 1, 50);
    const messageSeq = boundedString(input.message_seq, "message_seq", 64);
    const requestedTaskId = boundedString(input.task_id, "task_id", 128);
    const history = await callOneBot("get_group_msg_history", {
      group_id: binding.groupId,
      ...(messageSeq ? { message_seq: messageSeq } : {}),
      count,
      reverse_order: input.reverse_order === true,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    });
    const scannedMessages = (Array.isArray(history?.messages) ? history.messages : [])
      .map((message) => summarizeGroupMessage(message, binding.expectedSelfId));
    const messages = requestedTaskId
      ? scannedMessages.filter((message) => message.taskId === requestedTaskId)
      : scannedMessages;
    return {
      target: targetCheck.group,
      identity: targetCheck.login,
      requestedCount: count,
      requestedTaskId: requestedTaskId || null,
      scannedCount: scannedMessages.length,
      returnedCount: messages.length,
      messages,
    };
  }

  function previewTrainingEvent(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeEventInput(input, binding);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      event: normalizedInput.event,
      dedupeKey: normalizedInput.dedupeKey,
      message: buildTrainingMessage(normalizedInput, now()),
    };
  }

  function previewTextMessage(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeTextInput(input);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      dedupeKey: normalizedInput.dedupeKey,
      message: buildTextMessage(normalizedInput, now()),
    };
  }

  async function previewFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeFileInput(input, maximumFileBytes);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      dedupeKey: normalizedInput.dedupeKey,
      filePath: normalizedInput.filePath,
      fileName: normalizedInput.fileName,
      fileBytes: normalizedInput.fileBytes,
      sha256: await sha256File(normalizedInput.filePath),
    };
  }

  async function downloadFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeDownloadInput(input);
    const targetCheck = await checkTarget(binding);
    const urlData = await callOneBot("get_group_file_url", {
      group_id: binding.groupId,
      file_id: normalizedInput.fileId,
    });
    const downloadUrl = String(urlData?.url ?? "");
    let parsedUrl;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch (error) {
      throw new NapCatNotifierError("FILE_URL_INVALID", "NapCat 没有返回有效的群文件下载地址", { cause: error });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new NapCatNotifierError("FILE_URL_INVALID", "NapCat 返回的群文件下载地址不是 HTTP(S)");
    }

    const urlName = decodeURIComponent(path.posix.basename(parsedUrl.pathname || ""));
    const fallbackName = `napcat-file-${createHash("sha256").update(normalizedInput.fileId).digest("hex").slice(0, 12)}`;
    const fileName = normalizedInput.requestedName || urlName || fallbackName;
    if (fileName !== path.basename(fileName) || fileName === "." || fileName === "..") {
      throw new NapCatNotifierError("INVALID_FILE_NAME", "下载文件名包含目录或无效路径");
    }
    fs.mkdirSync(normalizedInput.destinationDirectory, { recursive: true });
    const destinationPath = path.join(normalizedInput.destinationDirectory, fileName);
    if (fs.existsSync(destinationPath)) {
      throw new NapCatNotifierError("DOWNLOAD_TARGET_EXISTS", `下载目标已存在，拒绝覆盖：${destinationPath}`);
    }
    const temporaryPath = `${destinationPath}.part-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fileDownloadTimeoutMs);
    let response;
    try {
      response = await fetchImpl(downloadUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new NapCatNotifierError("FILE_DOWNLOAD_HTTP_ERROR", `群文件下载返回 HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maximumFileBytes) {
        throw new NapCatNotifierError("FILE_TOO_LARGE", `下载文件超过 ${maximumFileBytes} 字节上限`);
      }
      if (!response.body) throw new NapCatNotifierError("FILE_DOWNLOAD_EMPTY_BODY", "群文件下载响应没有正文");

      let fileBytes = 0;
      const digest = createHash("sha256");
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          fileBytes += chunk.length;
          if (fileBytes > maximumFileBytes) {
            callback(new NapCatNotifierError("FILE_TOO_LARGE", `下载文件超过 ${maximumFileBytes} 字节上限`));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporaryPath, { flags: "wx" }));
      if (fileBytes <= 0) throw new NapCatNotifierError("FILE_EMPTY", "拒绝保留空的群文件下载结果");
      fs.renameSync(temporaryPath, destinationPath);
      return {
        downloaded: true,
        fileId: normalizedInput.fileId,
        fileName,
        filePath: destinationPath,
        fileBytes,
        sha256: digest.digest("hex"),
        target: targetCheck.group,
        identity: targetCheck.login,
      };
    } catch (error) {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
      }
      if (error instanceof NapCatNotifierError) throw error;
      const aborted = error?.name === "AbortError";
      throw new NapCatNotifierError(
        aborted ? "FILE_DOWNLOAD_TIMEOUT" : "FILE_DOWNLOAD_FAILED",
        aborted ? "群文件下载超时" : "群文件下载失败",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeFileInput(input, maximumFileBytes);
    const currentTime = now();
    const state = loadState(statePath);
    pruneState(state, binding.dedupeRetentionDays, currentTime);
    const existing = state.entries[normalizedInput.dedupeKey];
    if (existing && existing.status !== "failed_before_ack") {
      return {
        sent: false,
        duplicateSuppressed: true,
        reason: existing.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
        existing,
      };
    }
    if (inFlight.has(normalizedInput.dedupeKey)) {
      return { sent: false, duplicateSuppressed: true, reason: "in_flight" };
    }

    const fileSha256 = await sha256File(normalizedInput.filePath);
    inFlight.add(normalizedInput.dedupeKey);
    let releaseDedupeLock = null;
    try {
      const targetCheck = await checkTarget(binding);
      const lockResult = acquireDedupeLock(statePath, normalizedInput.dedupeKey, currentTime);
      releaseDedupeLock = lockResult.release;
      if (!releaseDedupeLock && lockResult.existingLock?.stale) {
        throw new NapCatNotifierError(
          "STALE_SEND_LOCK",
          "发现超过 15 分钟的文件发送锁，拒绝自动删除；请先确认旧上传进程已退出。",
          { details: lockResult.existingLock },
        );
      }
      if (!releaseDedupeLock) {
        return { sent: false, duplicateSuppressed: true, reason: "cross_process_in_flight" };
      }

      const claimedState = loadState(statePath);
      pruneState(claimedState, binding.dedupeRetentionDays, currentTime);
      const claimedExisting = claimedState.entries[normalizedInput.dedupeKey];
      if (claimedExisting && claimedExisting.status !== "failed_before_ack") {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: claimedExisting.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
          existing: claimedExisting,
        };
      }
      claimedState.entries[normalizedInput.dedupeKey] = {
        status: "pending_send",
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        createdAt: claimedExisting?.createdAt || currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
        attempts: Number(claimedExisting?.attempts ?? 0) + 1,
        fileName: normalizedInput.fileName,
        fileBytes: normalizedInput.fileBytes,
        sha256: fileSha256,
      };
      atomicWriteJson(statePath, claimedState);

      let uploadData;
      try {
        uploadData = await callOneBot("upload_group_file", {
          group_id: binding.groupId,
          file: normalizedInput.filePath,
          name: normalizedInput.fileName,
          upload_file: true,
        }, fileUploadTimeoutMs);
      } catch (error) {
        const failedState = loadState(statePath);
        failedState.entries[normalizedInput.dedupeKey] = {
          ...failedState.entries[normalizedInput.dedupeKey],
          status: error.outcomeUnknown ? "pending_send" : "failed_before_ack",
          updatedAt: now().toISOString(),
          error: publicError(error),
        };
        atomicWriteJson(statePath, failedState);
        throw error;
      }

      const fileId = String(uploadData?.file_id ?? "");
      if (!fileId) {
        const missingFileId = new NapCatNotifierError(
          "FILE_ID_MISSING",
          "NapCat 返回成功但没有 file_id，文件上传结果未知",
          { outcomeUnknown: true },
        );
        const unknownState = loadState(statePath);
        unknownState.entries[normalizedInput.dedupeKey] = {
          ...unknownState.entries[normalizedInput.dedupeKey],
          status: "pending_send",
          updatedAt: now().toISOString(),
          error: publicError(missingFileId),
        };
        atomicWriteJson(statePath, unknownState);
        throw missingFileId;
      }

      const sentState = loadState(statePath);
      sentState.entries[normalizedInput.dedupeKey] = {
        ...sentState.entries[normalizedInput.dedupeKey],
        status: "sent_unverified",
        fileId,
        updatedAt: now().toISOString(),
      };
      atomicWriteJson(statePath, sentState);

      let verified = false;
      let verificationError = null;
      let verifiedFile = null;
      try {
        const rootFiles = await callOneBot("get_group_root_files", {
          group_id: binding.groupId,
          file_count: 100,
        });
        const candidates = Array.isArray(rootFiles?.files) ? rootFiles.files : [];
        verifiedFile = candidates.find((file) =>
          String(file?.file_name ?? "") === normalizedInput.fileName
          && Number(file?.file_size ?? file?.size ?? -1) === normalizedInput.fileBytes
          && (!file?.uploader || String(file.uploader) === binding.expectedSelfId)
        ) ?? null;
        if (!verifiedFile) {
          throw new NapCatNotifierError("FILE_VERIFY_MISSING", "群文件列表中未找到刚上传的同名同大小文件");
        }
        verified = true;
      } catch (error) {
        verificationError = publicError(error);
      }

      const finalState = loadState(statePath);
      finalState.entries[normalizedInput.dedupeKey] = {
        ...finalState.entries[normalizedInput.dedupeKey],
        status: verified ? "sent_verified" : "sent_unverified",
        verified,
        verificationError,
        verifiedFileId: String(verifiedFile?.file_id ?? ""),
        updatedAt: now().toISOString(),
      };
      atomicWriteJson(statePath, finalState);

      return {
        sent: true,
        verified,
        fileId,
        verifiedFileId: String(verifiedFile?.file_id ?? ""),
        verificationError,
        fileName: normalizedInput.fileName,
        fileBytes: normalizedInput.fileBytes,
        sha256: fileSha256,
        target: targetCheck.group,
        identity: targetCheck.login,
        dedupeKey: normalizedInput.dedupeKey,
      };
    } finally {
      if (releaseDedupeLock) releaseDedupeLock();
      inFlight.delete(normalizedInput.dedupeKey);
    }
  }

  async function sendFixedMessage(binding, normalizedInput) {
    const currentTime = now();
    const preview = {
      bindingName: binding.bindingName,
      event: normalizedInput.event,
      taskId: normalizedInput.taskId,
      runId: normalizedInput.runId,
      dedupeKey: normalizedInput.dedupeKey,
      message: normalizedInput.message,
    };
    const state = loadState(statePath);
    pruneState(state, binding.dedupeRetentionDays, currentTime);
    const existing = state.entries[normalizedInput.dedupeKey];
    if (existing && existing.status !== "failed_before_ack") {
      return {
        sent: false,
        duplicateSuppressed: true,
        reason: existing.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
        existing,
      };
    }
    if (inFlight.has(normalizedInput.dedupeKey)) {
      return { sent: false, duplicateSuppressed: true, reason: "in_flight" };
    }

    if (normalizedInput.event === "heartbeat") {
      const minimumInterval = binding.minimumHeartbeatMinutes * 60000;
      const recentHeartbeat = Object.values(state.entries).find((entry) =>
        entry.event === "heartbeat"
        && entry.taskId === normalizedInput.taskId
        && String(entry.status || "").startsWith("sent_")
        && currentTime.getTime() - Date.parse(entry.updatedAt || entry.createdAt || "") < minimumInterval
      );
      if (recentHeartbeat) {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: "heartbeat_too_frequent",
          minimumHeartbeatMinutes: binding.minimumHeartbeatMinutes,
        };
      }
    }

    inFlight.add(normalizedInput.dedupeKey);
    let releaseDedupeLock = null;
    try {
      const targetCheck = await checkTarget(binding);
      const lockResult = acquireDedupeLock(statePath, normalizedInput.dedupeKey, currentTime);
      releaseDedupeLock = lockResult.release;
      if (!releaseDedupeLock && lockResult.existingLock?.stale) {
        throw new NapCatNotifierError(
          "STALE_SEND_LOCK",
          "发现超过 15 分钟的发送锁，拒绝自动删除；请先确认旧通知进程已退出，再按 README 人工处理。",
          { details: lockResult.existingLock },
        );
      }
      if (!releaseDedupeLock) {
        return { sent: false, duplicateSuppressed: true, reason: "cross_process_in_flight" };
      }

      const claimedState = loadState(statePath);
      pruneState(claimedState, binding.dedupeRetentionDays, currentTime);
      const claimedExisting = claimedState.entries[normalizedInput.dedupeKey];
      if (claimedExisting && claimedExisting.status !== "failed_before_ack") {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: claimedExisting.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
          existing: claimedExisting,
        };
      }
      const previousAttempts = Number(claimedExisting?.attempts ?? 0);
      claimedState.entries[normalizedInput.dedupeKey] = {
        status: "pending_send",
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        createdAt: claimedExisting?.createdAt || currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
        attempts: previousAttempts + 1,
      };
      atomicWriteJson(statePath, claimedState);

      let sendData;
      try {
        sendData = await callOneBot("send_group_msg", {
          group_id: binding.groupId,
          message: preview.message,
        });
      } catch (error) {
        const failedState = loadState(statePath);
        const entry = failedState.entries[normalizedInput.dedupeKey] || {};
        failedState.entries[normalizedInput.dedupeKey] = {
          ...entry,
          status: error.outcomeUnknown ? "pending_send" : "failed_before_ack",
          updatedAt: now().toISOString(),
          error: publicError(error),
        };
        atomicWriteJson(statePath, failedState);
        throw error;
      }

      const messageId = String(sendData?.message_id ?? "");
      if (!messageId) {
        const missingMessageId = new NapCatNotifierError(
          "MESSAGE_ID_MISSING",
          "NapCat 返回成功但没有 message_id，发送结果未知",
          { outcomeUnknown: true },
        );
        const unknownState = loadState(statePath);
        unknownState.entries[normalizedInput.dedupeKey] = {
          ...unknownState.entries[normalizedInput.dedupeKey],
          status: "pending_send",
          updatedAt: now().toISOString(),
          error: publicError(missingMessageId),
        };
        atomicWriteJson(statePath, unknownState);
        throw missingMessageId;
      }

      const sentState = loadState(statePath);
      sentState.entries[normalizedInput.dedupeKey] = {
        ...sentState.entries[normalizedInput.dedupeKey],
        status: "sent_unverified",
        messageId,
        updatedAt: now().toISOString(),
      };
      atomicWriteJson(statePath, sentState);

      let verified = !binding.requireMessageVerification;
      let verificationError = null;
      if (binding.requireMessageVerification) {
        try {
          const message = await callOneBot("get_msg", { message_id: messageId });
          const verifiedMessageId = String(message?.message_id ?? "");
          const verifiedGroupId = String(message?.group_id ?? "");
          const verifiedText = normalizeComparableText(oneBotMessageText(message));
          const expectedText = normalizeComparableText(preview.message);
          const verifiedSenderId = String(message?.sender?.user_id ?? message?.user_id ?? "");
          if (verifiedMessageId !== messageId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_ID_MISMATCH", "get_msg 返回的 message_id 不一致");
          }
          if (verifiedGroupId !== binding.groupId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_GROUP_MISMATCH", "get_msg 返回的群号不是已绑定群");
          }
          if (!verifiedText || verifiedText !== expectedText) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_TEXT_MISMATCH", "get_msg 返回的通知正文与发送内容不一致");
          }
          if (verifiedSenderId && verifiedSenderId !== binding.expectedSelfId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_SENDER_MISMATCH", "get_msg 返回的发送账号与 binding 不一致");
          }
          verified = true;
        } catch (error) {
          verificationError = publicError(error);
        }
      }

      const finalState = loadState(statePath);
      finalState.entries[normalizedInput.dedupeKey] = {
        ...finalState.entries[normalizedInput.dedupeKey],
        status: verified ? "sent_verified" : "sent_unverified",
        verified,
        verificationError,
        updatedAt: now().toISOString(),
      };
      atomicWriteJson(statePath, finalState);

      return {
        sent: true,
        verified,
        messageId,
        verificationError,
        target: targetCheck.group,
        identity: targetCheck.login,
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        dedupeKey: normalizedInput.dedupeKey,
      };
    } finally {
      if (releaseDedupeLock) releaseDedupeLock();
      inFlight.delete(normalizedInput.dedupeKey);
    }
  }

  async function sendTrainingEvent(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeEventInput(input, binding);
    return sendFixedMessage(binding, {
      ...normalizedInput,
      message: buildTrainingMessage(normalizedInput, now()),
    });
  }

  async function sendTextMessage(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeTextInput(input);
    return sendFixedMessage(binding, {
      ...normalizedInput,
      message: buildTextMessage(normalizedInput, now()),
    });
  }

  return {
    bindingPath,
    statePath,
    baseUrl,
    status,
    discoverTarget,
    readRecentMessages,
    previewTrainingEvent,
    previewTextMessage,
    previewFile,
    downloadFile,
    sendTrainingEvent,
    sendTextMessage,
    sendFile,
  };
}
