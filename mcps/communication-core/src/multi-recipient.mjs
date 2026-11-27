import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  CoreError,
  digest,
  hasTargetPermission,
  identityKey,
  normalizeIdentity,
  requireText,
} from "./contracts.mjs";

export const DEFAULT_MAX_RECIPIENTS = 16;
export const HUMAN_CHANNEL_HOSTS = new Set(["qq", "wechat"]);

const MAX_RECIPIENT_LABEL_BYTES = 512;
const DEFAULT_MAX_LABEL_CHARS = 64;
const DEFAULT_MAX_SUMMARY_CHARS = 1024;
const DEFAULT_MAX_PREFIX_CHARS = 1200;
const DEFAULT_PREVIEW_MAX_CHARS = 200;
const RECEIPT_BYTE_BUDGET = 9216;
const MAX_CODEX_BODY_BYTES = 262144;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const RELAY_HEADER_RE = /^(?:\[COMMUNICATION_CORE(?: |\])|主人在QQ(?:中的引用回信|窗口中的来信)，由交流核心转送。|这条消息来自「[^\r\n]+」代理对话「[^\r\n]+」，由交流核心转送。)/u;
const RELAY_MARKER_RE = /\[COMMUNICATION_CORE message_id=[^\s\[\]]+ delivery_id=[^\s\[\]]+\]/u;
const NOTICE_PREFIX = "同批收件人：";

function isHumanHost(host) {
  return typeof host === "string" && HUMAN_CHANNEL_HOSTS.has(host.toLowerCase());
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalAddress(identity) {
  const normalized = normalizeIdentity(identity);
  return `${normalized.machine_id}/${normalized.host}/${normalized.surface}/${normalized.conversation_id}`;
}

function canonicalThreeSegmentAddress(identity) {
  const normalized = normalizeIdentity(identity);
  return `${normalized.machine_id}/${normalized.host}/${normalized.conversation_id}`;
}

function toIdentityKey(value) {
  if (typeof value === "string") {
    return requireText(value, "identityKey", 1024);
  }
  return identityKey(value);
}

function truncateCodePoints(text, maxChars, suffix = "…") {
  const chars = [...text];
  if (chars.length <= maxChars) return { text, truncated: false };
  const suffixChars = [...suffix];
  if (maxChars <= suffixChars.length) {
    return { text: chars.slice(0, maxChars).join(""), truncated: true };
  }
  return {
    text: chars.slice(0, maxChars - suffixChars.length).join("") + suffix,
    truncated: true,
  };
}

function truncateUtf8Bytes(text, maxBytes, suffix = "…") {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) return "";
  const chars = [...text];
  let acc = "";
  let used = 0;
  for (const ch of chars) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes + suffixBytes > maxBytes) break;
    acc += ch;
    used += chBytes;
  }
  return acc + suffix;
}

function sanitizeRecipientLabel(rawLabel, fallbackAddress, maxLabelChars, fallbackThreeSegment = null) {
  let candidate = "";
  let resolvedFromAlias = false;
  if (typeof rawLabel === "string") {
    const trimmed = rawLabel.trim();
    if (trimmed.length > 0 && !CONTROL_CHARS.test(trimmed)) {
      candidate = trimmed;
      const isCanonicalFallback = trimmed === fallbackAddress
        || (typeof fallbackThreeSegment === "string" && trimmed === fallbackThreeSegment);
      resolvedFromAlias = !isCanonicalFallback;
    }
  }
  if (!candidate) {
    candidate = fallbackAddress.replace(/[\u0000-\u001f\u007f]+/gu, "").trim();
    resolvedFromAlias = false;
  }
  const byChars = truncateCodePoints(candidate, maxLabelChars).text;
  const safe = truncateUtf8Bytes(byChars, MAX_RECIPIENT_LABEL_BYTES);
  if (!safe || CONTROL_CHARS.test(safe)) {
    throw new CoreError("invalid_input", "收件人显示名无法安全归一化");
  }
  return { label: safe, resolvedFromAlias };
}

function validateLabelArray(labels, maxPrefixChars) {
  if (!Array.isArray(labels) || labels.length > DEFAULT_MAX_RECIPIENTS - 1) {
    throw new CoreError("invalid_input", "收件人显示名列表超出限制或格式非法");
  }
  const safe = labels.map((label) => {
    const text = requireText(label, "收件人显示名", MAX_RECIPIENT_LABEL_BYTES);
    if (CONTROL_CHARS.test(text)) {
      throw new CoreError("invalid_input", "收件人显示名不能包含控制字符或换行");
    }
    return text;
  });
  if (safe.length === 0) return { labels: [], summaryLine: null };
  const summaryLine = `${NOTICE_PREFIX}${safe.join("、")}`;
  if ([...summaryLine].length > maxPrefixChars || Buffer.byteLength(summaryLine, "utf8") > 4096) {
    throw new CoreError("invalid_input", "同批收件人前缀超出长度上限");
  }
  return { labels: safe, summaryLine };
}

function evaluateDisclosePermission(allowDiscloseByMachine, machine) {
  if (typeof allowDiscloseByMachine === "function") {
    return allowDiscloseByMachine(machine) === true;
  }
  if (allowDiscloseByMachine instanceof Map) {
    return allowDiscloseByMachine.get(machine) === true;
  }
  if (isPlainObject(allowDiscloseByMachine)) {
    return allowDiscloseByMachine[machine] === true;
  }
  return false;
}

export function normalizeRecipientsInput({
  target,
  targets,
  origin_receipt_binding,
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
} = {}) {
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 64) {
    throw new CoreError("invalid_input", "maxRecipients 必须是 1..64 之间的整数");
  }
  const hasTarget = target !== undefined && target !== null;
  const hasTargets = targets !== undefined && targets !== null;

  if (hasTarget && hasTargets) {
    throw new CoreError("invalid_input", "target 与 targets 互斥，不能同时传入");
  }
  if (!hasTarget && !hasTargets) {
    throw new CoreError("invalid_input", "必须提供 target 或 targets");
  }

  if (hasTargets) {
    if (origin_receipt_binding !== undefined && origin_receipt_binding !== null) {
      throw new CoreError("invalid_input", "多收件人群发禁止携带 origin_receipt_binding");
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new CoreError("invalid_input", "targets 必须是非空数组");
    }
    if (targets.length > maxRecipients) {
      throw new CoreError("invalid_input", `targets 收件人数量不能超过 ${maxRecipients}`);
    }
    const rawTargets = targets.map((entry, idx) => {
      if (typeof entry === "string") {
        return requireText(entry, `targets[${idx}]`, 512);
      }
      if (!isPlainObject(entry)) {
        throw new CoreError("invalid_input", `targets[${idx}] 必须是目标对象或联系人标识`);
      }
      return entry;
    });
    return {
      mode: "batch",
      isBatch: true,
      rawTargets,
      count: rawTargets.length,
    };
  }

  if (typeof target === "string") {
    return {
      mode: "single",
      isBatch: false,
      rawTargets: [requireText(target, "target", 512)],
      count: 1,
    };
  }
  if (!isPlainObject(target)) {
    throw new CoreError("invalid_input", "target 必须是目标对象或联系人标识");
  }
  return {
    mode: "single",
    isBatch: false,
    rawTargets: [target],
    count: 1,
  };
}

export function validateAndDedupeRecipients(
  resolvedTargets,
  { principal, checkPermission, maxRecipients = DEFAULT_MAX_RECIPIENTS } = {},
) {
  if (!Array.isArray(resolvedTargets) || resolvedTargets.length === 0) {
    throw new CoreError("invalid_input", "解析后的收件人列表不能为空");
  }
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 64) {
    throw new CoreError("invalid_input", "maxRecipients 必须是 1..64 之间的整数");
  }
  if (resolvedTargets.length > maxRecipients) {
    throw new CoreError("invalid_input", `收件人数量超过上限 ${maxRecipients}`);
  }

  const seen = new Set();
  const targets = [];
  const targetKeys = [];
  let deduplicatedCount = 0;

  for (const item of resolvedTargets) {
    const identity = normalizeIdentity(item);
    if (Object.values(identity).some((part) => part === "*" || CONTROL_CHARS.test(part))) {
      throw new CoreError("invalid_input", "收件人地址不能包含通配符或控制字符");
    }
    const key = identityKey(identity);
    if (seen.has(key)) {
      deduplicatedCount += 1;
      continue;
    }
    seen.add(key);
    targets.push({ ...item, ...identity });
    targetKeys.push(key);
  }

  let humanCount = 0;
  let agentCount = 0;
  for (const target of targets) {
    if (isHumanHost(target.host)) humanCount += 1;
    else agentCount += 1;
  }

  if (humanCount > 0 && agentCount > 0) {
    throw new CoreError(
      "mixed_channel_recipients_not_allowed",
      "禁止将人类渠道窗口（qq/wechat）与模型对话混合群发",
    );
  }
  if (humanCount > 1) {
    throw new CoreError(
      "mixed_channel_recipients_not_allowed",
      "第一波禁止一次向多个真人渠道窗口群发",
    );
  }

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const key = targetKeys[i];
    let allowed = true;
    if (typeof checkPermission === "function") {
      allowed = checkPermission(target, principal) === true;
    } else if (principal !== undefined && principal !== null) {
      allowed = hasTargetPermission(principal, target) === true;
    }
    if (!allowed) {
      throw new CoreError("forbidden", "当前来源缺少部分收件人的发送授权，整批已原子拒收", {
        target_key: key,
      });
    }
  }

  return {
    targets,
    targetKeys,
    deduplicatedCount,
  };
}

export function computeBatchPayloadHash({
  canonicalTargets,
  text,
  deliveryPolicy = "next_model_boundary",
  replyToBatchId = null,
  replyToMessageId = null,
  attachmentRefs = [],
  replyRequired = false,
  messageVisibility = undefined,
} = {}) {
  if (!Array.isArray(canonicalTargets) || canonicalTargets.length === 0) {
    throw new CoreError("invalid_input", "canonicalTargets 必须是非空数组");
  }
  const normalizedText = requireText(text, "text");
  const normalizedPolicy = requireText(deliveryPolicy ?? "next_model_boundary", "deliveryPolicy", 64);
  if (!["next_model_boundary", "when_idle"].includes(normalizedPolicy)) {
    throw new CoreError("invalid_input", "不支持该投递策略");
  }
  if (!Array.isArray(attachmentRefs)) {
    throw new CoreError("invalid_input", "attachmentRefs 必须是数组");
  }
  const sortedRecipientKeys = [...new Set(canonicalTargets.map(toIdentityKey))].sort();
  return digest({
    recipient_keys: sortedRecipientKeys,
    text: normalizedText,
    delivery_policy: normalizedPolicy,
    reply_to_batch_id: replyToBatchId ? requireText(replyToBatchId, "replyToBatchId", 256) : null,
    reply_to_message_id: replyToMessageId ? requireText(replyToMessageId, "replyToMessageId", 256) : null,
    attachment_refs: attachmentRefs.map((ref, idx) => requireText(ref, `attachmentRefs[${idx}]`, 512)),
    reply_required: replyRequired === true,
    ...(messageVisibility === undefined ? {} : { message_visibility: messageVisibility }),
  });
}

export function deriveBatchDedupeKeys({
  parentDedupeKey,
  sourceKey,
  canonicalTargets,
  text,
  deliveryPolicy = "next_model_boundary",
  minuteBucket,
  replyToBatchId = null,
  replyToMessageId = null,
  attachmentRefs = [],
  replyRequired = false,
  messageVisibility = undefined,
} = {}) {
  if (!Array.isArray(canonicalTargets) || canonicalTargets.length === 0) {
    throw new CoreError("invalid_input", "canonicalTargets 必须是非空数组");
  }
  const resolvedSourceKey = toIdentityKey(sourceKey);

  const orderedUniqueKeys = [];
  const seen = new Set();
  for (const target of canonicalTargets) {
    const key = toIdentityKey(target);
    if (!seen.has(key)) {
      seen.add(key);
      orderedUniqueKeys.push(key);
    }
  }

  const batchPayloadHash = computeBatchPayloadHash({
    canonicalTargets: orderedUniqueKeys,
    text,
    deliveryPolicy,
    replyToBatchId,
    replyToMessageId,
    attachmentRefs,
    replyRequired,
    messageVisibility,
  });

  let resolvedParentDedupeKey;
  if (parentDedupeKey !== undefined && parentDedupeKey !== null && parentDedupeKey !== "") {
    resolvedParentDedupeKey = requireText(parentDedupeKey, "parentDedupeKey", 128);
  } else {
    const bucket = minuteBucket === undefined || minuteBucket === null
      ? Math.floor(Date.now() / 60000)
      : minuteBucket;
    const autoHash = digest({
      source_key: resolvedSourceKey,
      recipient_keys: [...orderedUniqueKeys].sort(),
      batch_payload_hash: batchPayloadHash,
      minute_bucket: bucket,
    });
    resolvedParentDedupeKey = `auto_batch:${autoHash.slice(0, 32)}`;
  }

  const batchId = `batch_${digest({
    source_key: resolvedSourceKey,
    parent_dedupe_key: resolvedParentDedupeKey,
  }).slice(0, 24)}`;

  const entries = orderedUniqueKeys.map((targetKey) => ({
    targetKey,
    subDedupeKey: `batch:${createHash("sha256")
      .update(`${resolvedParentDedupeKey}\0${targetKey}`, "utf8")
      .digest("hex")
      .slice(0, 28)}`,
  }));

  return {
    batchId,
    parentDedupeKey: resolvedParentDedupeKey,
    batchPayloadHash,
    entries,
  };
}

export function planReplyAllSubMessages({ originalMessage, callerIdentity, targets } = {}) {
  if (!isPlainObject(originalMessage) || typeof originalMessage.message_id !== "string" || !originalMessage.message_id.trim()) {
    throw new CoreError("reply_not_found", "引用的原消息不存在");
  }
  const recipientGroup = originalMessage.batch_meta?.recipient_group;
  if (!isPlainObject(recipientGroup) || !Array.isArray(recipientGroup.recipients) || recipientGroup.recipients.length === 0) {
    throw new CoreError("invalid_reply", "原消息缺少群发收件人分组信息，不支持群发回复全部");
  }

  const callerKey = toIdentityKey(callerIdentity);
  const originalTargetKey = toIdentityKey(originalMessage.target_key);
  const originalSourceKey = toIdentityKey(originalMessage.source_key);

  if (callerKey !== originalTargetKey) {
    throw new CoreError("invalid_reply", "回复全部的调用者必须对应原消息的接收者");
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new CoreError("invalid_input", "回复全部的 targets 不能为空");
  }

  const allowedKeys = new Set([originalSourceKey]);
  for (const member of recipientGroup.recipients) {
    allowedKeys.add(toIdentityKey(member));
  }

  const orderedTargetKeys = [];
  const seen = new Set();
  for (const target of targets) {
    const key = toIdentityKey(target);
    if (!allowedKeys.has(key)) {
      throw new CoreError("invalid_reply", "回复全部目标超出了原发件人及同批收件人范围", {
        target_key: key,
      });
    }
    if (!seen.has(key)) {
      seen.add(key);
      orderedTargetKeys.push(key);
    }
  }

  const replyToOriginalTargetKey = seen.has(originalSourceKey) ? originalSourceKey : null;
  const ccTargetKeys = orderedTargetKeys.filter((key) => key !== originalSourceKey);
  const replyToBatchId = originalMessage.batch_meta?.batch_id ?? recipientGroup.batch_id ?? null;
  const replyToMessageId = originalMessage.message_id;

  const subMessages = orderedTargetKeys.map((targetKey) => ({
    targetKey,
    envelopeInReplyTo: targetKey === originalSourceKey ? replyToMessageId : null,
    replyToBatchId,
    replyToMessageId,
  }));

  return {
    replyToOriginalTargetKey,
    ccTargetKeys,
    replyToBatchId,
    replyToMessageId,
    subMessages,
  };
}

export function projectVisibilityForRecipient(messageVisibility, target) {
  if (messageVisibility !== undefined && !["hidden", "visible"].includes(messageVisibility)) {
    throw new CoreError("invalid_input", "Codex显示方式只支持hidden或visible");
  }
  if (!target || typeof target !== "object") {
    throw new CoreError("invalid_input", "缺少收件目标对象");
  }
  if (target.host === "codex") {
    return messageVisibility ?? "hidden";
  }
  return undefined;
}

export function planMultiRecipientDispatch({
  batchId = null,
  localMachineId,
  sender = null,
  targets,
  allowDiscloseByMachine,
} = {}) {
  const localMachine = requireText(localMachineId, "localMachineId", 128);
  const normalizedBatchId = batchId === null || batchId === undefined
    ? null
    : requireText(batchId, "batchId", 256);
  const normalizedSender = sender ? normalizeIdentity(sender) : null;

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new CoreError("invalid_input", "targets 必须是非空数组");
  }

  const normalizedTargets = [];
  const seen = new Set();
  for (const item of targets) {
    const identity = normalizeIdentity(item);
    const key = identityKey(identity);
    if (!seen.has(key)) {
      seen.add(key);
      normalizedTargets.push({ ...item, ...identity });
    }
  }

  const allRecipientIdentities = normalizedTargets.map((item) => ({
    machine_id: item.machine_id,
    host: item.host,
    surface: item.surface,
    conversation_id: item.conversation_id,
  }));
  const allRecipients = allRecipientIdentities.map(canonicalAddress);

  const localTargets = [];
  const remoteMap = new Map();

  for (const target of normalizedTargets) {
    if (target.machine_id === localMachine) {
      localTargets.push(target);
      continue;
    }
    let group = remoteMap.get(target.machine_id);
    if (!group) {
      group = [];
      remoteMap.set(target.machine_id, group);
    }
    group.push(target);
  }

  const requiresDisclosureCheck = normalizedTargets.length > 1;
  const remoteGroups = [];

  for (const [targetMachine, groupTargets] of remoteMap.entries()) {
    if (requiresDisclosureCheck && !evaluateDisclosePermission(allowDiscloseByMachine, targetMachine)) {
      throw new CoreError(
        "relay_recipient_disclosure_blocked",
        `目标机器「${targetMachine}」未开启多收件人名单披露授权`,
        {
          target_machine: targetMachine,
          recipient_count: normalizedTargets.length,
        },
      );
    }
    remoteGroups.push({
      target_machine: targetMachine,
      recipients: groupTargets,
      recipient_endpoints: groupTargets.map((t) => `${t.host}/${t.surface}/${t.conversation_id}`),
      all_recipients: [...allRecipients],
      all_recipient_identities: allRecipientIdentities.map((id) => ({ ...id })),
    });
  }

  return {
    batchId: normalizedBatchId,
    localMachineId: localMachine,
    sender: normalizedSender,
    localTargets,
    remoteGroups,
  };
}

export function renderPeerRecipientsForReceiver({
  receiver,
  allRecipients,
  resolveDisplayName,
  lookupAlias,
  maxLabelChars = DEFAULT_MAX_LABEL_CHARS,
  maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
} = {}) {
  const receiverIdentity = normalizeIdentity(receiver);
  const receiverKey = identityKey(receiverIdentity);

  if (!Array.isArray(allRecipients)) {
    throw new CoreError("invalid_input", "allRecipients 必须是数组");
  }
  if (!Number.isSafeInteger(maxLabelChars) || maxLabelChars < 8 || maxLabelChars > 256) {
    throw new CoreError("invalid_input", "maxLabelChars 超出允许范围");
  }
  if (!Number.isSafeInteger(maxSummaryChars) || maxSummaryChars < 32 || maxSummaryChars > 4096) {
    throw new CoreError("invalid_input", "maxSummaryChars 超出允许范围");
  }

  const peerIdentities = [];
  const seen = new Set([receiverKey]);
  for (const entry of allRecipients) {
    const peerIdentity = normalizeIdentity(entry);
    const key = identityKey(peerIdentity);
    if (!seen.has(key)) {
      seen.add(key);
      peerIdentities.push(peerIdentity);
    }
  }

  if (peerIdentities.length === 0) {
    return {
      peers: [],
      recipient_labels: [],
      summaryLine: null,
    };
  }
  if (peerIdentities.length > DEFAULT_MAX_RECIPIENTS - 1) {
    throw new CoreError("invalid_input", `同批其他收件人数量超过上限 ${DEFAULT_MAX_RECIPIENTS - 1}`);
  }

  const resolver = typeof resolveDisplayName === "function"
    ? resolveDisplayName
    : typeof lookupAlias === "function"
      ? lookupAlias
      : null;

  const separatorBudget = (peerIdentities.length - 1) + [...NOTICE_PREFIX].length;
  const availableForLabels = maxSummaryChars - separatorBudget;
  const effectiveLabelCap = availableForLabels >= peerIdentities.length
    ? Math.max(1, Math.min(maxLabelChars, Math.floor(availableForLabels / peerIdentities.length)))
    : 1;

  const peers = [];
  const recipient_labels = [];

  for (const peerIdentity of peerIdentities) {
    const fallbackAddress = canonicalAddress(peerIdentity);
    const fallbackThreeSegment = canonicalThreeSegmentAddress(peerIdentity);
    const resolved = resolver ? resolver(receiverIdentity, peerIdentity) : null;
    const { label, resolvedFromAlias } = sanitizeRecipientLabel(
      resolved,
      fallbackAddress,
      effectiveLabelCap,
      fallbackThreeSegment,
    );
    peers.push({
      identity: peerIdentity,
      address: fallbackAddress,
      displayName: label,
      resolvedFromAlias,
    });
    recipient_labels.push(label);
  }

  let summaryLine = `${NOTICE_PREFIX}${recipient_labels.join("、")}`;
  if ([...summaryLine].length > maxSummaryChars) {
    summaryLine = truncateCodePoints(summaryLine, maxSummaryChars, "…").text;
  }
  return {
    peers,
    recipient_labels,
    summaryLine,
  };
}

export function formatRecipientGroupForHost({
  host,
  baseRenderedText,
  markerLine,
  summaryLine,
  recipient_labels,
  envelopeText,
  maxPrefixChars = DEFAULT_MAX_PREFIX_CHARS,
} = {}) {
  const normalizedHost = requireText(host, "host", 64);
  if (typeof baseRenderedText !== "string" || !baseRenderedText.length) {
    throw new CoreError("invalid_input", "baseRenderedText 必须是非空字符串");
  }
  if (!Number.isSafeInteger(maxPrefixChars) || maxPrefixChars < 32 || maxPrefixChars > 4096) {
    throw new CoreError("invalid_input", "maxPrefixChars 超出允许范围");
  }

  let normalizedLabels = [];
  let noticeLine = null;

  if (Array.isArray(recipient_labels)) {
    const checked = validateLabelArray(recipient_labels, maxPrefixChars);
    normalizedLabels = checked.labels;
    noticeLine = checked.summaryLine;
  }

  if (summaryLine !== undefined && summaryLine !== null && summaryLine !== "") {
    const rawLine = requireText(summaryLine, "summaryLine", 4096);
    if (CONTROL_CHARS.test(rawLine)) {
      throw new CoreError("invalid_input", "summaryLine 不能包含控制字符或换行");
    }
    if ([...rawLine].length > maxPrefixChars) {
      throw new CoreError("invalid_input", "summaryLine 超出单行前缀长度限制");
    }
    noticeLine = rawLine;
  }

  if (!noticeLine) {
    return {
      text: baseRenderedText,
      summaryLine: null,
      recipient_labels: [],
      inserted: false,
    };
  }

  if (normalizedHost === "antigravity" || normalizedHost === "windsurf") {
    if (!RELAY_HEADER_RE.test(baseRenderedText)) {
      throw new CoreError("invalid_input", `${normalizedHost} 基础消息缺少合法 RELAY_HEADER 首行`);
    }
    const markerIndex = typeof markerLine === "string" && markerLine.length > 0
      ? baseRenderedText.indexOf(markerLine)
      : baseRenderedText.search(RELAY_MARKER_RE);
    const firstNewlineIdx = baseRenderedText.indexOf("\n");

    if (firstNewlineIdx === -1 || markerIndex === -1 || markerIndex <= firstNewlineIdx) {
      throw new CoreError("invalid_input", `${normalizedHost} 基础消息缺少位于首行之后的 COMMUNICATION_CORE 标记行`);
    }

    const headerFirstLine = baseRenderedText.slice(0, firstNewlineIdx);
    const betweenHeaderAndMarker = baseRenderedText.slice(firstNewlineIdx + 1, markerIndex);
    const fromMarkerToEnd = baseRenderedText.slice(markerIndex);

    const existingLines = betweenHeaderAndMarker.split("\n");
    const renderedText = existingLines.includes(noticeLine)
      ? baseRenderedText
      : `${headerFirstLine}\n${noticeLine}\n${betweenHeaderAndMarker}${fromMarkerToEnd}`;

    if (typeof envelopeText === "string" && !renderedText.endsWith(`\n\n${envelopeText}`)) {
      throw new CoreError("invalid_input", "插入同批收件人说明后破坏了正文尾缀不变量");
    }

    return {
      text: renderedText,
      summaryLine: noticeLine,
      recipient_labels: normalizedLabels,
      inserted: true,
    };
  }

  if (normalizedHost === "codex") {
    const renderedText = baseRenderedText.startsWith(`${noticeLine}\n\n`)
      ? baseRenderedText
      : `${noticeLine}\n\n${baseRenderedText}`;
    if (Buffer.byteLength(renderedText, "utf8") > MAX_CODEX_BODY_BYTES) {
      throw new CoreError("invalid_input", "群发到 Codex 的正文含前缀超出大小上限");
    }
    return {
      text: renderedText,
      summaryLine: noticeLine,
      recipient_labels: normalizedLabels,
      inserted: true,
    };
  }

  throw new CoreError("invalid_input", `不支持为宿主「${normalizedHost}」渲染群发收件人说明`);
}

const LOWER_SNAKE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/u;

function normalizeErrorCode(rawCode) {
  if (typeof rawCode !== "string") return "delivery_failed";
  const trimmed = rawCode.trim();
  if (!trimmed) return "delivery_failed";
  if (LOWER_SNAKE_CODE_RE.test(trimmed)) return trimmed;
  const normalized = trimmed
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toLowerCase()
    .replace(/^_+|_+$/gu, "")
    .replace(/_+/gu, "_")
    .slice(0, 64)
    .replace(/_+$/u, "");
  return LOWER_SNAKE_CODE_RE.test(normalized) ? normalized : "delivery_failed";
}

function compactError(error, maxMessageChars) {
  if (typeof error === "string") {
    return {
      code: "delivery_failed",
      message: truncateCodePoints(error, maxMessageChars).text,
    };
  }
  if (!isPlainObject(error) && !(error instanceof Error)) {
    return { code: "delivery_failed", message: "发送失败" };
  }
  const code = normalizeErrorCode(error.code);
  const rawMessage = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "发送失败";
  return {
    code,
    message: truncateCodePoints(rawMessage, maxMessageChars).text,
  };
}

export function projectBatchSendReceipt({
  batchId,
  text,
  deduplicatedCount = 0,
  results = [],
  verboseReceipt = false,
  previewMaxChars = DEFAULT_PREVIEW_MAX_CHARS,
} = {}) {
  const normalizedBatchId = requireText(batchId, "batchId", 256);
  const rawText = typeof text === "string" ? text : "";
  if (!Number.isSafeInteger(deduplicatedCount) || deduplicatedCount < 0) {
    throw new CoreError("invalid_input", "deduplicatedCount 必须是非负整数");
  }
  if (!Array.isArray(results)) {
    throw new CoreError("invalid_input", "results 必须是数组");
  }

  const effectivePreviewCap = verboseReceipt
    ? Math.max(1, Math.min(previewMaxChars, 1000))
    : Math.max(1, Math.min(previewMaxChars, DEFAULT_PREVIEW_MAX_CHARS));
  const initialPreview = truncateCodePoints(rawText, effectivePreviewCap);
  const errorMsgCap = verboseReceipt ? 300 : 120;

  let succeededCount = 0;
  let failedCount = 0;

  const projectedResults = results.map((entry) => {
    const target = normalizeIdentity(entry.target);
    const hasError = entry.error !== undefined && entry.error !== null;
    const deliveryStatus = typeof entry.delivery_status === "string" && entry.delivery_status.trim()
      ? entry.delivery_status.trim()
      : hasError
        ? "failed"
        : "queued";
    const processing = typeof entry.processing === "string" && entry.processing.trim()
      ? entry.processing.trim()
      : hasError || deliveryStatus === "failed"
        ? "failed"
        : "pending";

    if (hasError || deliveryStatus === "failed") failedCount += 1;
    else succeededCount += 1;

    return {
      target,
      message_id: entry.message_id ?? null,
      delivery_id: entry.delivery_id ?? null,
      delivery_status: deliveryStatus,
      processing,
      ...(entry.duplicate === true ? { duplicate: true } : {}),
      ...(hasError ? { error: compactError(entry.error, errorMsgCap) } : {}),
    };
  });

  const receipt = {
    batch_id: normalizedBatchId,
    recipient_count: projectedResults.length,
    deduplicated_count: deduplicatedCount,
    succeeded_count: succeededCount,
    failed_count: failedCount,
    partial_failure: succeededCount > 0 && failedCount > 0,
    text_preview: initialPreview.text,
    text_truncated: initialPreview.truncated,
    results: projectedResults,
  };

  if (!verboseReceipt && Buffer.byteLength(JSON.stringify(receipt), "utf8") >= RECEIPT_BYTE_BUDGET) {
    const tightenedPreview = truncateCodePoints(rawText, 48);
    receipt.text_preview = tightenedPreview.text;
    receipt.text_truncated = tightenedPreview.truncated || initialPreview.truncated;
    receipt.receipt_compacted = true;
    for (const item of receipt.results) {
      if (item.error?.message) {
        item.error.message = truncateCodePoints(item.error.message, 40).text;
      }
    }
    if (Buffer.byteLength(JSON.stringify(receipt), "utf8") >= RECEIPT_BYTE_BUDGET) {
      receipt.text_preview = "";
      receipt.text_truncated = rawText.length > 0;
    }
    if (Buffer.byteLength(JSON.stringify(receipt), "utf8") >= RECEIPT_BYTE_BUDGET) {
      for (const item of receipt.results) {
        if (item.error?.message) {
          item.error.message = truncateCodePoints(item.error.message, 16).text;
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(receipt), "utf8") >= RECEIPT_BYTE_BUDGET) {
      for (const item of receipt.results) {
        if (item.error?.message) {
          item.error.message = "";
        }
      }
    }
    const finalBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
    if (finalBytes >= RECEIPT_BYTE_BUDGET) {
      throw new CoreError(
        "invalid_input",
        "收件地址总长超出 9 KiB 批量回执预算，请分批发送",
        { receipt_bytes: finalBytes, budget: RECEIPT_BYTE_BUDGET },
      );
    }
  }

  return receipt;
}
